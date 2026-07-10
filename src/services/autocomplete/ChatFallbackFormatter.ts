import type { ChatMessage } from "./types";

export interface ChatFallbackOptions {
  isAfterBlockOpen?: boolean;
}

/**
 * Builds a constrained chat prompt for models that don't support FIM.
 * Returns a system message (code-only constraints) and a user message (context).
 */
export function formatMessages(
  prefix: string,
  suffix: string,
  language: string,
  options?: ChatFallbackOptions
): ChatMessage[] {
  const maxLines = options?.isAfterBlockOpen ? "3-6" : "1-3";

  const systemContent = `You are a code completion engine. Output ONLY the completion text that goes at the cursor position. Rules:
- No explanations, no markdown fences, no backticks
- Complete ${maxLines} logical lines
- Match existing indentation and coding style exactly
- If inside a function/block, complete the logic naturally
- Stop at a natural boundary (end of statement, end of block)`;

  const userContent = `[Language: ${language}]
[File context — code BEFORE cursor:]
${prefix}
[Code AFTER cursor:]
${suffix}
[Complete from cursor:]`;

  return [
    { role: "system", content: systemContent },
    { role: "user", content: userContent },
  ];
}
