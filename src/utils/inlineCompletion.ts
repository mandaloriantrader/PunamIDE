/**
 * Inline Completion Provider — Copilot-style ghost text
 * Registers with Monaco to show AI-generated inline suggestions as you type.
 *
 * Triggers on:
 * - 800ms idle after last keystroke (via internal cooldown)
 *
 * The provider sends the current file prefix (up to cursor) plus surrounding context
 * to the configured AI provider and renders the response as ghost text.
 */

import type { IDisposable, languages, editor } from "monaco-editor";
import { sendToProviderStreaming } from "./providers";
import type { AIProviderConfig } from "./providers";

export interface InlineCompletionRequest {
  fileContent: string;
  language: string;
  cursorLine: number;
  cursorColumn: number;
  provider: AIProviderConfig;
  modelId: string;
}

interface InlineCompletionState {
  disposables: IDisposable[];
  cooldown: boolean;
}

const state: InlineCompletionState = {
  disposables: [],
  cooldown: false,
};

const COOLDOWN_MS = 800;

/**
 * Register the inline completion provider for given language IDs.
 * Returns disposables to clean up.
 */
export function registerInlineCompletionProvider(
  monaco: typeof import("monaco-editor"),
  languageIds: string[],
  getRequest: () => InlineCompletionRequest | null,
): IDisposable[] {
  unregisterInlineCompletion();

  for (const langId of languageIds) {
    const provider = monaco.languages.registerInlineCompletionsProvider(langId, {
      provideInlineCompletions: async (
        model,
        position,
        _context,
        _token,
      ) => {
        if (state.cooldown) return { items: [] };

        const request = getRequest();
        if (!request) return { items: [] };

        state.cooldown = true;
        setTimeout(() => { state.cooldown = false; }, COOLDOWN_MS);

        try {
          const completion = await fetchInlineCompletion(request);
          if (!completion) return { items: [] };

          return {
            items: [
              {
                insertText: completion,
                range: {
                  startLineNumber: position.lineNumber,
                  startColumn: position.column,
                  endLineNumber: position.lineNumber,
                  endColumn: position.column,
                },
              },
            ],
          };
        } catch {
          return { items: [] };
        }
      },
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      disposeInlineCompletions: (_completions: any) => {
        // No cleanup needed for simple completions
      },
    });

    state.disposables.push(provider);
  }

  return state.disposables;
}

/** Clean up all registered inline completion providers */
export function unregisterInlineCompletion(): void {
  for (const d of state.disposables) {
    d.dispose();
  }
  state.disposables = [];
}

/**
 * Fetch a completion suggestion from the AI provider.
 */
async function fetchInlineCompletion(
  request: InlineCompletionRequest,
): Promise<string | null> {
  const { fileContent, language, provider, modelId } = request;

  const lines = fileContent.split("\n");
  const cursorLineIdx = request.cursorLine - 1;
  const prefix = lines.slice(0, cursorLineIdx).join("\n")
    + "\n"
    + (lines[cursorLineIdx] ? lines[cursorLineIdx].slice(0, request.cursorColumn - 1) : "");

  const suffix = lines.slice(cursorLineIdx + 1, cursorLineIdx + 6).join("\n");

  const systemPrompt = `You are an inline code completion engine. Output ONLY the completion — no explanations, no markdown fences, no backticks.
Rules:
- Complete the code at the cursor position naturally
- Match the existing indentation, style, naming conventions
- Output 1-20 lines maximum
- If the line is already complete or a comment, output nothing
- For function calls: suggest arguments based on context
- For method chains: complete the chain logically
- Never output just whitespace`;

  const userPrompt = `Language: ${language}\n\nPREFIX (up to cursor):\n\`\`\`\n${prefix.slice(-3000)}\n\`\`\`\n\nSUFFIX (after cursor, for context):\n\`\`\`\n${suffix}\n\`\`\`\n\nCOMPLETE the code at the cursor. Output ONLY the characters that should be inserted:`;

  try {
    const resp = await sendToProviderStreaming(provider, modelId, {
      systemPrompt,
      userPrompt,
    });

    if (!resp.success) return null;

    let completion = resp.text.trim();
    completion = completion.replace(/^```[\s\S]*?\n/, "").replace(/\n```$/, "");
    completion = completion.replace(/^(Here|This|The|Suggested|Output).*:?\s*/i, "");
    if (completion.length < 2 || /^[\s\n]+$/.test(completion)) return null;

    return completion;
  } catch {
    return null;
  }
}