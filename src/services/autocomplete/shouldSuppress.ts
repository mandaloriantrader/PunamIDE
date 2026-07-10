import type { CompletionContext } from "./types";

export function shouldSuppress(context: CompletionContext): boolean {
  const { beforeCursor, prefix, triggeredByNewline } = context;

  // 1. Empty line without structural context
  if (!beforeCursor.trim() && !triggeredByNewline) {
    const trimmedPrefix = prefix.trimEnd();
    const lastChar = trimmedPrefix[trimmedPrefix.length - 1];
    if (
      lastChar !== "{" &&
      lastChar !== "(" &&
      lastChar !== ":" &&
      lastChar !== ">" &&
      lastChar !== ","
    ) {
      return true;
    }
  }

  // 2. Line comment
  const lineBeforeCursor = beforeCursor.trimStart();
  if (
    lineBeforeCursor.startsWith("//") ||
    lineBeforeCursor.startsWith("#") ||
    lineBeforeCursor.startsWith("--")
  ) {
    return true;
  }

  // 3. Block comment (unmatched /*)
  if (prefix.lastIndexOf("/*") > prefix.lastIndexOf("*/")) {
    return true;
  }

  // 4. String literal (odd number of unescaped quotes before cursor)
  const unescapedSingleQuotes = (beforeCursor.match(/(?<!\\)'/g) || []).length;
  if (unescapedSingleQuotes % 2 !== 0) return true;

  const unescapedDoubleQuotes = (beforeCursor.match(/(?<!\\)"/g) || []).length;
  if (unescapedDoubleQuotes % 2 !== 0) return true;

  const unescapedBackticks = (beforeCursor.match(/(?<!\\)`/g) || []).length;
  if (unescapedBackticks % 2 !== 0) return true;

  return false;
}
