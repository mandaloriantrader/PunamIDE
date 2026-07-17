/**
 * @purpose Bridges PunamIDE's existing AI provider system to the
 *          FixLlmProvider interface expected by AiFixHandler / "Fix with AI".
 *          Reuses the same sendToProvider() that chat uses — no new API keys.
 */

import type { FixLlmProvider } from "./AiFixHandler";
import { loadAIProviders } from "../../utils/tauri";
import { sendToProvider, sendToProviderStreaming } from "../../utils/providers";

/**
 * Creates a FixLlmProvider backed by PunamIDE's configured LLM.
 * Returns null if no provider is configured or no models are enabled.
 */
export async function createFixLlmProvider(): Promise<FixLlmProvider | null> {
  const providers = await loadAIProviders();
  const usable = providers.find((p) => p.models.some((m) => m.enabled && m.id));
  if (!usable) return null;

  const model = usable.models.find((m) => m.enabled && m.id);
  if (!model) return null;

  return {
    async completeFix(prompt: string): Promise<string> {
      const response = await sendToProvider(usable, model.id, {
        systemPrompt:
          "You are a code refactoring expert. Output ONLY the replacement code block — no explanation, no markdown fences, no backticks.",
        userPrompt: prompt,
        temperature: 0.3,
        maxTokens: 4096,
      });
      return response.text;
    },
    async completeFixStreaming(prompt: string, onChunk: (chunk: string) => void): Promise<string> {
      // Listen for llm-stream events (Tauri IPC) and forward to callback
      const streamId = `fix-ai-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const { listen } = await import("@tauri-apps/api/event");

      const unlisten = await listen<{ stream_id: string; token: string; done: boolean }>(
        "llm-stream",
        (event) => {
          if (event.payload.stream_id === streamId && !event.payload.done) {
            onChunk(event.payload.token);
          }
        },
      );

      const response = await sendToProviderStreaming(usable, model.id, {
        systemPrompt:
          "You are a code refactoring expert. Output ONLY the replacement code block — no explanation, no markdown fences, no backticks.",
        userPrompt: prompt,
        temperature: 0.3,
        maxTokens: 4096,
        streamId,
      });

      unlisten();
      return response.text;
    },
  };
}
