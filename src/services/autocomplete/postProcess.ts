/**
 * Post-Processing — Cleans and validates raw completion text.
 *
 * Strips markdown fences, leading newlines, meta-text patterns,
 * FIM stop tokens, and enforces a max character limit.
 * Returns null for invalid/empty results.
 */

const MAX_LENGTH = 800;

/** Patterns that indicate the model returned explanatory text rather than code */
const META_TEXT_PATTERN = /^(Here|This|The |I |Note|Sure|```)/i;

/** Same patterns but prefixed with comment markers */
const COMMENT_META_PATTERN = /^(\/\/|#|--)\s*(Here|This|The |I |Note|Sure)/i;

/**
 * Post-process a raw completion string into clean code or null.
 *
 * @param raw - The raw completion text from the provider
 * @param _prefix - Reserved for future prefix-aware processing
 * @returns Cleaned completion string, or null if invalid
 */
export function postProcess(raw: string, _prefix?: string): string | null {
  if (!raw) return null;

  let text = raw;

  // Strip opening markdown fence: ```[lang]\n
  text = text.replace(/^```[^\n]*\n/, "");

  // Strip closing markdown fence: \n```
  text = text.replace(/\n```\s*$/, "");

  // Strip leading newlines
  text = text.replace(/^\n+/, "");

  // Reject meta-text patterns
  if (META_TEXT_PATTERN.test(text)) return null;

  // Reject comment-prefixed meta-text
  if (COMMENT_META_PATTERN.test(text)) return null;

  // Truncate at FIM stop tokens
  const stopIdx = findFirstStopToken(text);
  if (stopIdx !== -1) {
    text = text.slice(0, stopIdx);
  }

  // Enforce max length
  if (text.length > MAX_LENGTH) {
    text = text.slice(0, MAX_LENGTH);
  }

  // Reject empty/whitespace-only results
  if (!text.trim()) return null;

  return text;
}

/**
 * Find the index of the first FIM stop token in the text.
 * Looks for `<|` and `</s>` occurrences.
 */
function findFirstStopToken(text: string): number {
  const pipeIdx = text.indexOf("<|");
  const endIdx = text.indexOf("</s>");

  if (pipeIdx === -1 && endIdx === -1) return -1;
  if (pipeIdx === -1) return endIdx;
  if (endIdx === -1) return pipeIdx;
  return Math.min(pipeIdx, endIdx);
}
