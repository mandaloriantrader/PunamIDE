import type { CompletionContext } from "./types";
import type * as Monaco from "monaco-editor";

function hashKey(segment: string): string {
  let hash = 0;
  for (let i = 0; i < segment.length; i++) {
    hash = ((hash << 5) - hash + segment.charCodeAt(i)) | 0;
  }
  return hash.toString(36);
}

export function extractContext(
  model: Monaco.editor.ITextModel,
  position: Monaco.Position,
  previousLineCount: number
): CompletionContext {
  const fullText = model.getValue();
  const offset = model.getOffsetAt(position);

  const prefix = fullText.slice(Math.max(0, offset - 2000), offset);
  const suffix = fullText.slice(offset, offset + 800);
  const language = model.getLanguageId();
  const currentLine = model.getLineContent(position.lineNumber);
  const beforeCursor = currentLine.slice(0, position.column - 1);

  const trimmedPrefix = prefix.trimEnd();
  const lastChar = trimmedPrefix[trimmedPrefix.length - 1];
  const isAfterBlockOpen =
    lastChar === "{" ||
    lastChar === "(" ||
    lastChar === ":" ||
    lastChar === ">" ||
    lastChar === ",";

  const triggeredByNewline = model.getLineCount() > previousLineCount;

  const cacheKey = hashKey(`${language}:${prefix.slice(-200)}|${suffix.slice(0, 100)}`);

  return {
    prefix,
    suffix,
    language,
    cacheKey,
    currentLine,
    beforeCursor,
    isAfterBlockOpen,
    triggeredByNewline,
  };
}
