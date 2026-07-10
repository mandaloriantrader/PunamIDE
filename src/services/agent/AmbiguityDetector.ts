/**
 * AmbiguityDetector.ts — Pre-flight ambiguity detection for user tasks.
 *
 * Analyzes a task string for genuine ambiguity before the agent loop starts.
 * Uses a heuristic fast path (regex + complexity scoring) to avoid unnecessary
 * LLM calls, then optionally invokes a cheap model for deeper analysis.
 *
 * Design principles:
 *   - One question maximum (most impactful ambiguity only)
 *   - Fail-open: any error returns isAmbiguous: false
 *   - FastPath regex skips LLM for obviously clear tasks
 *   - Complexity < 2 skips LLM call
 */

import { sendToProvider } from "../../utils/providers";
import type { AIProviderConfig } from "../../utils/providers";

// ── Types ──────────────────────────────────────────────────────────────────────

export type AmbiguityKind =
  | "scope"
  | "approach"
  | "target"
  | "constraint"
  | "definition"
  | "dependency";

export interface AmbiguityReport {
  isAmbiguous: boolean;
  confidence: number; // 0-1
  primaryAmbiguity: {
    kind: AmbiguityKind;
    description: string;
    options?: string[];
  } | null;
  suggestedQuestion: string | null;
  suggestedOptions: string[]; // A/B/C choices if applicable
  fastPath: boolean; // true if detection was skipped via heuristic
}

// ── FastPath Detection ─────────────────────────────────────────────────────────

/** Regex patterns for tasks that are obviously unambiguous and need no LLM check. */
const FAST_PATH_PATTERNS: RegExp[] = [
  // Fix/resolve bug at specific file:line
  /\b(?:fix|resolve|patch)\b.+\b(?:bug|error|issue)\b.+[\w./\\]+:\d+/i,
  // Run/execute tests/build/lint
  /^\s*(?:run|execute|start)\s+(?:tests?|build|lint|format|typecheck)/i,
  // Add X to/in Y (specific file)
  /^\s*add\s+.+\s+(?:to|in)\s+[\w./\\]+\.\w+/i,
  // Show/explain/describe (read-only requests)
  /^\s*(?:show|explain|describe|list|display|print|what is|what are)\b/i,
  // Delete/remove specific file
  /^\s*(?:delete|remove)\s+(?:the\s+)?(?:file\s+)?[\w./\\]+\.\w+/i,
  // Rename specific thing
  /^\s*rename\s+[\w./\\]+\s+to\s+\w+/i,
  // Create a specific file
  /^\s*create\s+(?:a\s+)?(?:file\s+)?[\w./\\]+\.\w+/i,
];

/**
 * Returns true if the task matches known unambiguous patterns.
 * These tasks are clear enough to skip LLM-based detection entirely.
 */
export function isObviouslyUnambiguous(task: string): boolean {
  return FAST_PATH_PATTERNS.some((pattern) => pattern.test(task));
}

// ── Complexity Scoring ─────────────────────────────────────────────────────────

/** Vague verbs that suggest broad, unclear intent */
const VAGUE_VERBS = /\b(?:refactor|restructure|migrate|redesign|rework|overhaul|improve|optimize|clean\s*up)\b/i;

/** Broad scope words that imply large-scale changes */
const BROAD_SCOPE = /\b(?:module|system|architecture|all|entire|everything|whole|codebase|project)\b/i;

/** Hedging words that indicate uncertainty */
const HEDGING = /\b(?:maybe|might|could|possibly|perhaps|somehow|not sure|i think|probably)\b/i;

/** Vague quality words */
const VAGUE_QUALITY = /\b(?:better|cleaner|nicer|more readable|more maintainable|simpler|elegant)\b/i;

/**
 * Scores task complexity from 0-10. Higher scores indicate more likely ambiguity.
 *
 * Scoring factors:
 *   - Task length > 100 chars: +1
 *   - Contains vague refactor/restructure verbs: +2
 *   - Contains broad scope words: +2
 *   - Contains hedging language: +2
 *   - Contains vague quality words: +1
 *   - Multiple sentences (3+): +1
 *   - Contains "or" suggesting alternatives: +1
 */
export function scoreComplexity(task: string): number {
  let score = 0;

  // Length factor
  if (task.length > 100) score += 1;

  // Vague verbs (refactor/restructure/migrate/redesign)
  if (VAGUE_VERBS.test(task)) score += 2;

  // Broad scope words (module/system/architecture/all/entire)
  if (BROAD_SCOPE.test(task)) score += 2;

  // Hedging language (maybe/might/could/possibly)
  if (HEDGING.test(task)) score += 2;

  // Vague quality words (better/cleaner/nicer)
  if (VAGUE_QUALITY.test(task)) score += 1;

  // Multiple sentences suggest complex intent
  const sentences = task.split(/[.!?]+/).filter((s) => s.trim().length > 0);
  if (sentences.length >= 3) score += 1;

  // "or" alternatives suggest unresolved decision
  if (/\bor\b/i.test(task)) score += 1;

  return Math.min(score, 10);
}

// ── LLM Detection ──────────────────────────────────────────────────────────────

const DETECTION_SYSTEM_PROMPT = `You are an ambiguity detector for a code assistant. Analyze the user's task and determine if it contains genuine ambiguity that would cause materially different outcomes if misinterpreted.

Respond ONLY with valid JSON in this exact format (no markdown, no explanation):
{
  "isAmbiguous": true/false,
  "confidence": 0.0-1.0,
  "primaryAmbiguity": {
    "kind": "scope"|"approach"|"target"|"constraint"|"definition"|"dependency",
    "description": "brief description of the ambiguity",
    "options": ["option A", "option B", "option C"]
  },
  "suggestedQuestion": "one focused question to resolve the ambiguity",
  "suggestedOptions": ["option A", "option B", "option C"]
}

If the task is NOT ambiguous, respond:
{
  "isAmbiguous": false,
  "confidence": 0.0,
  "primaryAmbiguity": null,
  "suggestedQuestion": null,
  "suggestedOptions": []
}

Rules:
- Only flag GENUINE ambiguity that would lead to materially different implementations
- Pick the SINGLE most impactful ambiguity (never list multiple)
- The question should be answerable in one sentence
- Provide 2-3 concrete options when possible
- Ambiguity kinds: scope (how much to change), approach (which method), target (which file/component), constraint (requirements unclear), definition (term unclear), dependency (order/blocking unclear)`;

const REFINEMENT_SYSTEM_PROMPT = `You are a task refinement assistant. Given an original task and a clarification answer from the user, produce a single refined task description that incorporates both.

Rules:
- Return ONLY the refined task string (no markdown, no quotes, no explanation)
- Keep it concise but complete
- Preserve the original intent while incorporating the clarification
- The result should be a clear, unambiguous instruction`;

/**
 * Builds a minimal AIProviderConfig from the individual parameters.
 * This allows the detector to work without requiring the full app config.
 */
function buildProviderConfig(
  provider: AIProviderConfig["type"],
  apiKey: string,
  baseUrl?: string
): AIProviderConfig {
  return {
    id: `ambiguity-detector-${provider}`,
    type: provider,
    name: provider,
    apiKey,
    baseUrl,
    models: [],
  };
}

/**
 * Safely parse JSON from LLM response text.
 * Handles common issues like markdown code fences, trailing commas, etc.
 */
function safeParseJson(text: string): unknown | null {
  // Strip markdown code fences if present
  let cleaned = text.trim();
  if (cleaned.startsWith("```")) {
    cleaned = cleaned.replace(/^```(?:json)?\s*\n?/, "").replace(/\n?```\s*$/, "");
  }
  // Remove any leading/trailing whitespace after stripping
  cleaned = cleaned.trim();

  try {
    return JSON.parse(cleaned);
  } catch {
    // Try to extract JSON object from the text
    const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      try {
        return JSON.parse(jsonMatch[0]);
      } catch {
        return null;
      }
    }
    return null;
  }
}

/** Safe default report — used when detection is skipped or fails */
function safeDefaultReport(fastPath: boolean): AmbiguityReport {
  return {
    isAmbiguous: false,
    confidence: 0,
    primaryAmbiguity: null,
    suggestedQuestion: null,
    suggestedOptions: [],
    fastPath,
  };
}

/**
 * Validates and normalizes the parsed LLM response into an AmbiguityReport.
 */
function validateDetectionResponse(parsed: unknown): AmbiguityReport | null {
  if (!parsed || typeof parsed !== "object") return null;

  const obj = parsed as Record<string, unknown>;

  if (typeof obj.isAmbiguous !== "boolean") return null;
  if (typeof obj.confidence !== "number" || obj.confidence < 0 || obj.confidence > 1) return null;

  const validKinds: AmbiguityKind[] = [
    "scope",
    "approach",
    "target",
    "constraint",
    "definition",
    "dependency",
  ];

  let primaryAmbiguity: AmbiguityReport["primaryAmbiguity"] = null;
  if (obj.primaryAmbiguity && typeof obj.primaryAmbiguity === "object") {
    const pa = obj.primaryAmbiguity as Record<string, unknown>;
    if (
      typeof pa.kind === "string" &&
      validKinds.includes(pa.kind as AmbiguityKind) &&
      typeof pa.description === "string"
    ) {
      primaryAmbiguity = {
        kind: pa.kind as AmbiguityKind,
        description: pa.description,
        options: Array.isArray(pa.options)
          ? pa.options.filter((o): o is string => typeof o === "string")
          : undefined,
      };
    }
  }

  const suggestedOptions = Array.isArray(obj.suggestedOptions)
    ? obj.suggestedOptions.filter((o): o is string => typeof o === "string")
    : [];

  return {
    isAmbiguous: obj.isAmbiguous,
    confidence: obj.confidence,
    primaryAmbiguity,
    suggestedQuestion:
      typeof obj.suggestedQuestion === "string" ? obj.suggestedQuestion : null,
    suggestedOptions,
    fastPath: false,
  };
}

/**
 * Main entry point: detects ambiguity in a user task.
 *
 * Flow: FastPath check → complexity score check → LLM JSON call → parse response.
 * Returns safe defaults on any error (fail-open).
 *
 * @param task - The user's task string
 * @param projectContext - Brief project context (memory summary, active file, etc.)
 * @param provider - AI provider type ("gemini" | "openai-compatible" | "anthropic")
 * @param apiKey - API key for the provider
 * @param model - Model ID to use for the detection call
 * @param baseUrl - Optional base URL for openai-compatible providers
 */
export async function detectAmbiguity(
  task: string,
  projectContext: string | undefined,
  provider: AIProviderConfig["type"],
  apiKey: string,
  model: string,
  baseUrl?: string
): Promise<AmbiguityReport> {
  try {
    // Step 1: FastPath — skip if obviously unambiguous
    if (isObviouslyUnambiguous(task)) {
      return safeDefaultReport(true);
    }

    // Step 2: Complexity score — skip LLM if below threshold
    const complexity = scoreComplexity(task);
    if (complexity < 2) {
      return safeDefaultReport(true);
    }

    // Step 3: LLM call for deeper analysis
    const config = buildProviderConfig(provider, apiKey, baseUrl);
    const userPrompt = projectContext
      ? `Project context: ${projectContext}\n\nTask: ${task}`
      : `Task: ${task}`;

    const response = await sendToProvider(config, model, {
      systemPrompt: DETECTION_SYSTEM_PROMPT,
      userPrompt,
      temperature: 0.1,
      maxTokens: 500,
    });

    if (!response.success || !response.text) {
      return safeDefaultReport(false);
    }

    // Step 4: Parse and validate response
    const parsed = safeParseJson(response.text);
    const report = validateDetectionResponse(parsed);

    if (!report) {
      return safeDefaultReport(false);
    }

    // Only flag ambiguity if confidence exceeds threshold
    if (report.isAmbiguous && report.confidence <= 0.7) {
      return {
        ...report,
        isAmbiguous: false,
        fastPath: false,
      };
    }

    return report;
  } catch {
    // Fail-open: any error means proceed without blocking
    return safeDefaultReport(false);
  }
}

// ── Task Refinement ────────────────────────────────────────────────────────────

/**
 * Merges the original task with the user's clarification answer into a single
 * refined task string via LLM. Falls back to simple concatenation on error.
 *
 * @param originalTask - The original user task
 * @param clarification - The user's answer to the clarification question
 * @param provider - AI provider type
 * @param apiKey - API key for the provider
 * @param model - Model ID to use
 * @param baseUrl - Optional base URL for openai-compatible providers
 */
export async function refineTaskWithClarification(
  originalTask: string,
  clarification: string,
  provider: AIProviderConfig["type"],
  apiKey: string,
  model: string,
  baseUrl?: string
): Promise<string> {
  // If clarification is empty, return original unchanged
  if (!clarification.trim()) {
    return originalTask;
  }

  try {
    const config = buildProviderConfig(provider, apiKey, baseUrl);
    const userPrompt = `Original task: ${originalTask}\n\nUser's clarification: ${clarification}\n\nProduce the refined task:`;

    const response = await sendToProvider(config, model, {
      systemPrompt: REFINEMENT_SYSTEM_PROMPT,
      userPrompt,
      temperature: 0.2,
      maxTokens: 300,
    });

    if (!response.success || !response.text.trim()) {
      // Fallback: simple concatenation
      return `${originalTask}\n\nAdditional context: ${clarification}`;
    }

    // Clean up response — remove quotes if the model wrapped it
    let refined = response.text.trim();
    if (
      (refined.startsWith('"') && refined.endsWith('"')) ||
      (refined.startsWith("'") && refined.endsWith("'"))
    ) {
      refined = refined.slice(1, -1);
    }

    return refined || `${originalTask}\n\nAdditional context: ${clarification}`;
  } catch {
    // Fallback: simple concatenation on any error
    return `${originalTask}\n\nAdditional context: ${clarification}`;
  }
}
