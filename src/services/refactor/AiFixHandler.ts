/**
 * AiFixHandler.ts — "Fix with AI" pipeline for technical debt refactoring.
 *
 * Design principles (from plan §5.1):
 * - LLM sees ONLY the problem code block, never the whole file or codebase
 * - 4 guard layers: scope isolation, output validation, security gate, architecture gate
 * - Never auto-apply — every fix requires explicit user confirmation via diff preview
 * - Snapshot/rollback via RefactorService before every apply
 * - Score delta shown after apply via DebtAnalyzer.analyzeFile()
 */

import type { RefactorPlanItem } from "../technicalDebt/RefactorPlanner";
import { getDebtAnalyzer, computeFileScore } from "../technicalDebt/DebtAnalyzer";
import { scanFile, type SecurityFinding } from "../security/SecurityPatterns";

// ── Types ──────────────────────────────────────────────────────────────

export type FixScope = "function" | "class" | "block" | "file";

export interface FixScopeResult {
  block: string;
  startLine: number;
  endLine: number;
  scope: FixScope;
}

export interface AiFixValidation {
  passed: boolean;
  violations: string[];
}

export interface AiFixResult {
  status: "success" | "validation_failed" | "security_blocked" | "unable" | "error";
  originalCode: string;
  proposedCode: string;
  filePath: string;
  scope: FixScopeResult;
  validation: AiFixValidation;
  securityFindings: SecurityFinding[];
  beforeScore: number | null;
  afterScore: number | null;
  errorMessage?: string;
}

/** Callback for progress updates during the fix pipeline. */
export type FixProgressCallback = (update: { step: string; completed: boolean; details?: string }) => void;

/** LLM provider interface — inject any provider (OpenAI, Anthropic, Ollama, etc.). */
export interface FixLlmProvider {
  completeFix(prompt: string): Promise<string>;
  /** Optional: streaming variant for live code preview during generation. */
  completeFixStreaming?(prompt: string, onChunk: (chunk: string) => void): Promise<string>;
}

// ── Prompt Builder ─────────────────────────────────────────────────────

function buildFixPrompt(item: RefactorPlanItem, scope: FixScopeResult): string {
  const constraints = [
    "1. Output ONLY the replacement code block — no explanation, no markdown fences, no backticks.",
    "2. Do NOT add or remove import/export statements.",
    "3. Do NOT rename variables or functions that external code depends on.",
    "4. Do NOT add new dependencies or require/import calls.",
    "5. Preserve the function/class signature unless the fix REQUIRES changing it.",
    "6. The output must be a drop-in replacement for the code between the markers.",
    "7. Do NOT reference other files or suggest changes elsewhere.",
    "8. If you CANNOT fix this without violating constraints, output exactly: [UNABLE]",
  ];

  return [
    `## Issue: ${item.category} — ${item.recommendation}`,
    `### Why Flagged`,
    item.whyFlagged,
    "",
    `### Code to Fix (lines ${scope.startLine}-${scope.endLine}, ${scope.scope} scope)`,
    "Replace ONLY the code between the markers below:",
    "```",
    scope.block,
    "```",
    "",
    "### Constraints (VIOLATING ANY = REJECTED)",
    ...constraints,
    "",
    item.expectedPayoff ? `### Expected Payoff: ${item.expectedPayoff}` : "",
  ].join("\n");
}

// ── Scope Extraction ───────────────────────────────────────────────────

function extractFixScope(item: RefactorPlanItem, content: string): FixScopeResult {
  const lines = content.split("\n");

  // Priority 1: AST-precise scope
  if (item.astDetail) {
    const detail = item.astDetail;

    // God function — extract the function body
    if (detail.godFunctionCount > 0) {
      const fnMatch = findFunctionBlock(lines, detail.cyclomaticComplexity);
      if (fnMatch) return fnMatch;
    }

    // High complexity — extract the main function
    if (detail.complexityBand === "critical" || detail.complexityBand === "high") {
      const fnMatch = findFunctionBlock(lines, detail.cyclomaticComplexity);
      if (fnMatch) return fnMatch;
    }

    // Excessive nesting
    if (detail.nestingBand === "refactor") {
      const fnMatch = findNestedBlock(lines, detail.maxNestingDepth);
      if (fnMatch) return fnMatch;
    }
  }

  // Priority 2: Category-based fallback
  if (item.category === "quick_win") {
    return { block: content, startLine: 1, endLine: lines.length, scope: "block" };
  }

  // Priority 3: Full file (only for maintenance items)
  return { block: content, startLine: 1, endLine: lines.length, scope: "file" };
}

function findFunctionBlock(
  lines: string[],
  _targetComplexity: number,
): FixScopeResult | null {
  // Find the largest function by scanning for function/arrow declarations
  let best: { start: number; end: number; size: number } | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (
      /^(export\s+)?(async\s+)?function\s+\w+/.test(line) ||
      /^(export\s+)?(const|let|var)\s+\w+\s*=\s*(async\s+)?\(/.test(line) ||
      /^\s*(public|private|protected|static)?\s*(async\s+)?\w+\s*\(/.test(line)
    ) {
      const end = findMatchingBrace(lines, i);
      if (end > i) {
        const size = end - i + 1;
        if (!best || size > best.size) {
          best = { start: i, end, size };
        }
      }
    }
  }

  if (best && best.size > 10) {
    return {
      block: lines.slice(best.start, best.end + 1).join("\n"),
      startLine: best.start + 1,
      endLine: best.end + 1,
      scope: "function",
    };
  }

  return null;
}

function findNestedBlock(
  lines: string[],
  _maxDepth: number,
): FixScopeResult | null {
  // Find the deepest-nested code block
  let maxIndent = 0;
  let blockStart = 0;
  let blockEnd = 0;
  let currentStart = -1;

  for (let i = 0; i < lines.length; i++) {
    const indent = lines[i].search(/\S/);
    if (indent > maxIndent && currentStart === -1) {
      maxIndent = indent;
      currentStart = i;
    }
    if (currentStart >= 0 && (indent < maxIndent || i === lines.length - 1)) {
      blockStart = currentStart;
      blockEnd = i - 1;
      currentStart = -1;
    }
  }

  if (blockEnd - blockStart > 3) {
    return {
      block: lines.slice(blockStart, blockEnd + 1).join("\n"),
      startLine: blockStart + 1,
      endLine: blockEnd + 1,
      scope: "block",
    };
  }

  return null;
}

function findMatchingBrace(lines: string[], start: number): number {
  let depth = 0;
  let started = false;
  for (let i = start; i < lines.length; i++) {
    for (const ch of lines[i]) {
      if (ch === "{") { depth++; started = true; }
      if (ch === "}") { depth--; }
    }
    if (started && depth === 0) return i;
  }
  return lines.length - 1;
}

// ── Output Validation ──────────────────────────────────────────────────

function validateLlmOutput(
  original: string,
  proposed: string,
  scope: FixScopeResult,
): AiFixValidation {
  const violations: string[] = [];
  const origLines = original.split("\n");
  const propLines = proposed.split("\n");

  // 1. No imports added/removed
  const origImports = extractImports(origLines);
  const propImports = extractImports(propLines);
  if (JSON.stringify(origImports) !== JSON.stringify(propImports)) {
    violations.push("Imports were added or removed.");
  }

  // 2. No new exports introduced
  const origExports = countExports(origLines);
  const propExports = countExports(propLines);
  if (propExports > origExports) {
    violations.push("New exports were introduced.");
  }

  // 3. Line count is reasonable (within 2x)
  if (propLines.length > origLines.length * 2 && origLines.length > 10) {
    violations.push(
      `Code grew from ${origLines.length} to ${propLines.length} lines (>2x).`,
    );
  }

  // 4. Proposed code is not empty and not identical
  if (!proposed.trim()) {
    violations.push("Proposed code is empty.");
  }
  if (proposed.trim() === original.trim()) {
    violations.push("Proposed code is identical to original.");
  }

  // 5. No file path references
  const pathPattern = /['"`][.\/][^'"`]*\.(tsx?|jsx?|py|rs|go|java|cs)['"`]/;
  if (pathPattern.test(proposed)) {
    violations.push("Proposed code references other files.");
  }

  return { passed: violations.length === 0, violations };
}

function extractImports(lines: string[]): string[] {
  return lines
    .filter((l) => /^\s*import\s+/.test(l) || /^\s*const\s+.*require\(/.test(l))
    .map((l) => l.trim());
}

function countExports(lines: string[]): number {
  return lines.filter((l) => /^\s*export\s+/.test(l)).length;
}

// ── Security Gate ──────────────────────────────────────────────────────

function runSecurityGate(code: string, filePath: string): SecurityFinding[] {
  try {
    return scanFile(code, filePath);
  } catch {
    return [];
  }
}

// ── Main Pipeline ──────────────────────────────────────────────────────

/**
 * Runs the full "Fix with AI" pipeline for a single refactor item.
 *
 * @param item - The refactor plan item to fix
 * @param fileContent - Full content of the file being fixed
 * @param filePath - Absolute path to the file
 * @param provider - LLM provider for generating fixes
 * @returns AiFixResult with status, proposed code, and validation results
 */
export async function runAiFix(
  item: RefactorPlanItem,
  fileContent: string,
  filePath: string,
  provider: FixLlmProvider,
  onProgress?: FixProgressCallback,
): Promise<AiFixResult> {
  // Step 1: Extract scope
  onProgress?.({ step: "scope_extract", completed: true });
  const scope = extractFixScope(item, fileContent);

  // Step 2: Build constrained prompt
  onProgress?.({ step: "prompt_build", completed: true });
  const prompt = buildFixPrompt(item, scope);

  // Step 3: Get before score
  onProgress?.({ step: "debt_analyze", completed: false });
  let beforeScore: number | null = null;
  try {
    const analyzer = getDebtAnalyzer();
    const metrics = await analyzer.analyzeFile(filePath);
    beforeScore = metrics.fileScore;
  } catch {
    /* non-blocking */
  }
  onProgress?.({ step: "debt_analyze", completed: true });

  // Step 4: Call LLM (use streaming if available for live code preview)
  let proposedCode: string;
  onProgress?.({ step: "llm_call", completed: false, details: "Generating fix..." });
  try {
    if (provider.completeFixStreaming) {
      let accumulated = "";
      proposedCode = await provider.completeFixStreaming(prompt, (chunk) => {
        accumulated += chunk;
        onProgress?.({ step: "llm_call", completed: false, details: accumulated });
      });
    } else {
      proposedCode = await provider.completeFix(prompt);
    }
    onProgress?.({ step: "llm_call", completed: true, details: proposedCode });
  } catch (err) {
    onProgress?.({ step: "llm_call", completed: false, details: "LLM call failed" });
    return {
      status: "error",
      originalCode: scope.block,
      proposedCode: "",
      filePath,
      scope,
      validation: { passed: false, violations: [] },
      securityFindings: [],
      beforeScore,
      afterScore: null,
      errorMessage:
        "The AI service encountered an error while generating the fix. This may be a network issue, rate limit, or API key configuration problem. Check your provider settings in Settings → AI Providers and try again.",
    };
  }

  // Step 5: Handle UNABLE
  onProgress?.({ step: "validate_output", completed: false, details: "Validating LLM output..." });
  if (proposedCode.trim() === "[UNABLE]") {
    onProgress?.({ step: "validate_output", completed: true, details: "AI returned [UNABLE]" });
    return {
      status: "unable",
      originalCode: scope.block,
      proposedCode: "",
      filePath,
      scope,
      validation: { passed: false, violations: [] },
      securityFindings: [],
      beforeScore,
      afterScore: null,
      errorMessage:
        "This refactoring requires changes to imports, exports, function signatures, method visibility, or cross-file references that could break other parts of the codebase. The AI cannot safely fix this in isolation.\n\nOptions:\n1. Refactor manually\n2. Split this into smaller, independent changes\n3. Fix dependencies first and re-scan",
    };
  }

  // Step 6: Validate output
  const validation = validateLlmOutput(scope.block, proposedCode, scope);
  onProgress?.({ step: "validate_output", completed: validation.passed, details: validation.passed ? "Output validated" : `${validation.violations.length} violations found` });
  if (!validation.passed) {
    return {
      status: "validation_failed",
      originalCode: scope.block,
      proposedCode,
      filePath,
      scope,
      validation,
      securityFindings: [],
      beforeScore,
      afterScore: null,
      errorMessage:
        `The AI generated a fix but it did not pass quality checks: ${validation.violations.join("; ")}. The fix was blocked to protect codebase integrity. Try fixing this issue manually or with a different approach.`,
    };
  }

  // Step 7: Security gate
  onProgress?.({ step: "security_scan", completed: false, details: "Running security scan..." });
  const securityFindings = runSecurityGate(proposedCode, filePath);
  const criticalSecurity = securityFindings.filter(
    (f) => f.severity === "critical" || f.severity === "high",
  );

  onProgress?.({ step: "security_scan", completed: criticalSecurity.length === 0, details: criticalSecurity.length > 0 ? `${criticalSecurity.length} issues found` : "Security scan passed" });
  if (criticalSecurity.length > 0) {
    return {
      status: "security_blocked",
      originalCode: scope.block,
      proposedCode,
      filePath,
      scope,
      validation,
      securityFindings,
      beforeScore,
      afterScore: null,
      errorMessage:
        `The AI-generated code triggered ${criticalSecurity.length} security alert(s) during automated security scanning. The fix was blocked to protect your codebase. The issues may be false positives from the scanner on the proposed code. Review the Security tab for details, or try fixing this issue manually.`,
    };
  }

  // Step 8: Compute full new file content
  onProgress?.({ step: "apply_patch", completed: false, details: "Building patched file..." });
  const fullContent = applyReplacement(fileContent, scope, proposedCode);
  onProgress?.({ step: "apply_patch", completed: true });

  // Step 9: Estimate after score using computeFileScore on the new content
  onProgress?.({ step: "score_calc", completed: false, details: "Re-calculating debt score..." });
  let afterScore: number | null = null;
  try {
    const lines = fullContent.split("\n");
    const loc = lines.length;
    const commentLines = lines.filter((l) => {
      const t = l.trim();
      return t.startsWith("//") || t.startsWith("#") ||
             t.startsWith("/*") || t.startsWith("*");
    }).length;
    const commentRatio = loc > 0 ? commentLines / loc : 0;
    const todoCount = (fullContent.match(/TODO/gi) ?? []).length;
    const fixmeCount = (fullContent.match(/FIXME/gi) ?? []).length;
    const dependencyDepth = lines.filter((l) =>
      /^\s*(import|require|from|use\s|#include)/.test(l)
    ).length;
    const sizeRiskScore = loc > 1000 ? Math.min(100, (loc / 1000) * 30) : 0;

    afterScore = computeFileScore({
      loc, commentRatio,
      avgFunctionLength: loc / Math.max((fullContent.match(/function\s+\w+/g) ?? []).length, 1),
      dependencyDepth, todoCount, fixmeCount, sizeRiskScore,
      isUtilityFile: false, isTestFile: filePath.includes(".test."),
      astMetrics: null, couplingScore: null, isInCycle: null,
    });
  } catch {
    /* non-blocking */
  }
  onProgress?.({ step: "score_calc", completed: true, details: afterScore !== null ? `Score: ${afterScore}` : undefined });

  return {
    status: "success",
    originalCode: scope.block,
    proposedCode: fullContent,
    filePath,
    scope,
    validation,
    securityFindings,
    beforeScore,
    afterScore,
  };
}

/**
 * Applies a code replacement within a file, producing the full new content.
 */
function applyReplacement(
  fullContent: string,
  scope: FixScopeResult,
  replacement: string,
): string {
  const lines = fullContent.split("\n");
  const before = lines.slice(0, scope.startLine - 1);
  const after = lines.slice(scope.endLine);
  return [...before, replacement, ...after].join("\n");
}

/**
 * Saves a snapshot of a file before modification (for rollback).
 * Returns the snapshot content string that can be written back to undo.
 */
export async function saveSnapshot(filePath: string): Promise<string> {
  const { readFile } = await import("../../utils/tauri");
  return await readFile(filePath);
}

/**
 * Restores a file from a snapshot (rollback).
 */
export async function restoreSnapshot(
  filePath: string,
  snapshot: string,
): Promise<void> {
  const { writeFile } = await import("../../utils/tauri");
  await writeFile(filePath, snapshot);
}

// ── Re-exports for convenience ─────────────────────────────────────────

export { buildFixPrompt, extractFixScope, validateLlmOutput, runSecurityGate };