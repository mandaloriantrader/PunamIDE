/**
 * Smart context extraction for PunamIDE agent.
 * Instead of dumping entire files, extracts only relevant sections.
 * Saves 80-90% tokens on line-specific and function-specific queries.
 */

// ── Types ─────────────────────────────────────────────────────────────────────

export interface ExtractedContext {
  content: string;
  fromLine: number;
  toLine: number;
  totalLines: number;
  strategy: "line_query" | "function_query" | "error_query" | "full_head" | "full_file";
  tokenEstimate: number;
}

// ── Constants ─────────────────────────────────────────────────────────────────

const CONTEXT_PADDING = 15;        // lines above/below target line
const FUNCTION_CONTEXT_LINES = 60; // max lines for a function block
const HEAD_LINES = 80;             // lines to send for general queries
const MAX_FULL_FILE_CHARS = 60000; // absolute cap

// ── Main Export ───────────────────────────────────────────────────────────────

/**
 * Extract only the relevant portion of a file based on the user's question.
 * 
 * Strategy:
 *   "what's on line 428?"        → lines 413-443 only (~400 chars)
 *   "fix the handleSubmit fn"    → find function, send its body (~800 chars)
 *   "there's an error on line X" → lines around X (~400 chars)
 *   "explain this file"          → first 80 lines (~2000 chars)
 *   fallback                     → first 80 lines
 */
export function extractRelevantContext(
  filePath: string,
  content: string,
  userMessage: string
): ExtractedContext {
  const lines = content.split("\n");
  const totalLines = lines.length;

  // ── Strategy 1: Line number query ─────────────────────────────────────────
  const lineMatch = userMessage.match(/\bline[s]?\s+(\d+)(?:\s*[-–to]+\s*(\d+))?/i);
  if (lineMatch) {
    const targetLine = parseInt(lineMatch[1]);
    const endLine = lineMatch[2] ? parseInt(lineMatch[2]) : targetLine;
    const from = Math.max(0, targetLine - CONTEXT_PADDING - 1);
    const to = Math.min(totalLines, endLine + CONTEXT_PADDING);
    return buildResult(lines, from, to, totalLines, "line_query");
  }

  // ── Strategy 2: Function/class name query ──────────────────────────────────
  const funcMatch = userMessage.match(
    /\b(?:function|def|class|method|fn|func|const|let|var)\s+(\w+)|\b(\w+)\s*(?:function|method|class)/i
  );
  if (!funcMatch) {
    // also try "the X function" or "X method"
  }
  const nameMatch = userMessage.match(
    /\bthe\s+(\w+)\s+(?:function|method|class|component|hook)/i
  ) || userMessage.match(/\b(\w+(?:Handler|Service|Helper|Utils|Manager|Controller))\b/);
  
  const fnName = funcMatch?.[1] || funcMatch?.[2] || nameMatch?.[1];
  if (fnName && fnName.length > 2) {
    const fnLine = lines.findIndex(
      (l) => l.includes(`function ${fnName}`) ||
             l.includes(`${fnName}(`) ||
             l.includes(`${fnName} =`) ||
             l.includes(`def ${fnName}`) ||
             l.includes(`class ${fnName}`)
    );
    if (fnLine !== -1) {
      const from = Math.max(0, fnLine - 2);
      const to = Math.min(totalLines, fnLine + FUNCTION_CONTEXT_LINES);
      return buildResult(lines, from, to, totalLines, "function_query");
    }
  }

  // ── Strategy 3: Error line query ───────────────────────────────────────────
  const errorLineMatch = userMessage.match(/error.*line\s+(\d+)|line\s+(\d+).*error/i);
  if (errorLineMatch) {
    const errLine = parseInt(errorLineMatch[1] || errorLineMatch[2]);
    const from = Math.max(0, errLine - CONTEXT_PADDING - 1);
    const to = Math.min(totalLines, errLine + CONTEXT_PADDING);
    return buildResult(lines, from, to, totalLines, "error_query");
  }

  // ── Strategy 4: Full file requested ───────────────────────────────────────
  const fullFilePatterns = /\b(entire|whole|full|all|complete|everything)\b/i;
  if (fullFilePatterns.test(userMessage)) {
    const clipped = content.slice(0, MAX_FULL_FILE_CHARS);
    const clippedLines = clipped.split("\n");
    return buildResult(lines, 0, clippedLines.length, totalLines, "full_file");
  }

  // ── Strategy 5: Fallback — send first N lines ──────────────────────────────
  const to = Math.min(totalLines, HEAD_LINES);
  return buildResult(lines, 0, to, totalLines, "full_head");
}

// ── Helper ────────────────────────────────────────────────────────────────────

function buildResult(
  lines: string[],
  from: number,
  to: number,
  totalLines: number,
  strategy: ExtractedContext["strategy"]
): ExtractedContext {
  const slice = lines.slice(from, to);
  const numbered = slice
    .map((line, i) => `${String(from + i + 1).padStart(4, " ")} | ${line}`)
    .join("\n");

  // Add truncation notice if we didn't send the whole file
  const suffix =
    to < totalLines
      ? `\n\n/* ... file continues to line ${totalLines} — ask about specific lines/functions to see more ... */`
      : "";

  const content = numbered + suffix;

  return {
    content,
    fromLine: from + 1,
    toLine: to,
    totalLines,
    strategy,
    tokenEstimate: Math.ceil(content.length / 4),
  };
}

// ── Token savings reporter ────────────────────────────────────────────────────

export function logContextSavings(
  filePath: string,
  fullContent: string,
  extracted: ExtractedContext
): void {
  const fullTokens = Math.ceil(fullContent.length / 4);
  const savedTokens = fullTokens - extracted.tokenEstimate;
  const savedPct = Math.round((savedTokens / fullTokens) * 100);
  const fileName = filePath.split(/[\\/]/).pop();
  console.log(
    `[CONTEXT] ${fileName} — strategy: ${extracted.strategy} | ` +
    `lines ${extracted.fromLine}-${extracted.toLine}/${extracted.totalLines} | ` +
    `~${extracted.tokenEstimate} tokens (saved ${savedPct}% vs full file)`
  );
}
