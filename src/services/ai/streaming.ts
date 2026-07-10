/**
 * AI Streaming Service — Consolidated streaming through Rust backend with browser-fetch fallback.
 *
 * The primary path routes all providers through Tauri Rust commands (IPC streaming).
 * A per-provider `useBrowserFallback` flag gates rollback to the legacy browser-fetch path
 * during the transition period.
 *
 * Rust commands:
 *   - call_gemini_stream → Gemini
 *   - call_anthropic_stream → Anthropic
 *   - call_openai_compatible_stream → DeepSeek, OpenAI, Groq, Mistral, Ollama, OpenRouter
 */

import { invoke } from "@tauri-apps/api/core";
import type { TokenUsage } from "../../store/aiStore";

export type AIProvider = "openai" | "anthropic" | "gemini" | "openrouter" | "ollama" | "groq" | "mistral" | "deepseek";

export interface LlmRequest {
  provider: string;
  api_key: string;
  model: string;
  system_prompt: string;
  user_prompt: string;
  images?: string[];
  temperature?: number;
  max_tokens?: number;
}

export interface StreamCallbacks {
  onToken: (token: string) => void;
  onComplete: (fullText: string, usage?: TokenUsage) => void;
  onError: (error: string) => void;
}

// ─── Streaming Configuration ─────────────────────────────────────────────────

/**
 * Per-provider browser-fetch fallback flag.
 * Set a provider to `true` to fall back to the legacy browser-fetch path
 * (useful during Rust backend validation or if a provider has issues).
 * Default: all providers use the Rust streaming path.
 */
const streamingFallbackConfig: Record<string, boolean> = {
  openai: false,
  anthropic: false,
  gemini: false,
  deepseek: false,
  groq: false,
  mistral: false,
  ollama: false,
  openrouter: false,
};

/**
 * Check whether a provider should use the browser-fetch fallback path.
 * Returns true if the fallback flag is explicitly enabled for the provider.
 */
export function useBrowserFallback(provider: string): boolean {
  return streamingFallbackConfig[provider] === true;
}

/**
 * Update the fallback flag for a specific provider at runtime.
 * Useful for enabling rollback without a code change during validation.
 */
export function setProviderFallback(provider: string, enabled: boolean): void {
  streamingFallbackConfig[provider] = enabled;
}

// ─── Rust Backend Streaming Router ───────────────────────────────────────────

/**
 * Start a streaming LLM request, routing to the correct Rust backend command.
 * If the browser-fetch fallback flag is enabled for the provider, falls back
 * to the legacy browser-fetch streaming path instead.
 *
 * @param request - The LLM request parameters
 * @param streamId - Unique identifier for this streaming session
 * @returns Promise that resolves when the Rust command completes (tokens are emitted via IPC events)
 */
export async function startStream(request: LlmRequest, streamId: string): Promise<void> {
  // Check fallback flag — if enabled, use legacy browser-fetch path
  if (useBrowserFallback(request.provider)) {
    return startBrowserStream(request, streamId);
  }

  // Route to appropriate Rust streaming command
  switch (request.provider) {
    case "gemini":
      await invoke("call_gemini_stream", {
        apiKey: request.api_key,
        model: request.model,
        systemPrompt: request.system_prompt,
        userPrompt: request.user_prompt,
        images: request.images?.map((img) => ({ base64: img, mime_type: "image/png" })) || null,
        streamId,
      });
      break;

    case "anthropic":
      await invoke("call_anthropic_stream", {
        apiKey: request.api_key,
        model: request.model,
        systemPrompt: request.system_prompt,
        userPrompt: request.user_prompt,
        images: request.images?.map((img) => ({ base64: img, mime_type: "image/png" })) || null,
        maxTokens: request.max_tokens ?? 8192,
        temperature: request.temperature ?? 0.3,
        streamId,
      });
      break;

    default:
      // OpenAI, DeepSeek, Groq, Mistral, Ollama, OpenRouter — all OpenAI-compatible
      await invoke("call_openai_compatible_stream", {
        apiKey: request.api_key,
        baseUrl: getBaseUrl(request.provider),
        model: request.model,
        systemPrompt: request.system_prompt,
        userPrompt: request.user_prompt,
        images: request.images?.map((img) => ({ base64: img, mime_type: "image/png" })) || null,
        isOpenRouter: request.provider === "openrouter",
        streamId,
      });
      break;
  }
}

// ─── Browser Fetch Fallback Path ─────────────────────────────────────────────

/**
 * Legacy browser-fetch streaming path, retained as a flag-gated fallback.
 * This function wires the existing browser-based SSE fetch into the IPC event
 * pattern by emitting window events that match the Rust backend format.
 */
async function startBrowserStream(request: LlmRequest, streamId: string): Promise<void> {
  const callbacks: StreamCallbacks = {
    onToken: (token: string) => {
      // Emit a synthetic event matching the Rust IPC format
      window.dispatchEvent(
        new CustomEvent("llm-stream-browser-fallback", {
          detail: { stream_id: streamId, token, done: false },
        })
      );
    },
    onComplete: (fullText: string, usage?: TokenUsage) => {
      window.dispatchEvent(
        new CustomEvent("llm-stream-browser-fallback", {
          detail: { stream_id: streamId, token: "", done: true, full_text: fullText, usage },
        })
      );
    },
    onError: (error: string) => {
      window.dispatchEvent(
        new CustomEvent("llm-stream-browser-fallback", {
          detail: { stream_id: streamId, token: "", done: true, error },
        })
      );
    },
  };

  await streamCompletion(request, callbacks);
}

export async function streamCompletion(
  request: LlmRequest,
  callbacks: StreamCallbacks,
  abortSignal?: AbortSignal
): Promise<void> {
  const provider = request.provider;

  try {
    if (provider === "gemini") {
      await streamGemini(request, callbacks, abortSignal);
    } else if (provider === "anthropic") {
      await streamAnthropic(request, callbacks, abortSignal);
    } else {
      await streamOpenAICompatible(request, callbacks, abortSignal);
    }
  } catch (err) {
    if (abortSignal?.aborted) return;
    callbacks.onError(err instanceof Error ? err.message : String(err));
  }
}

// ─── Provider Base URLs ──────────────────────────────────────────────────────

function getBaseUrl(provider: string): string {
  const urls: Record<string, string> = {
    openai: "https://api.openai.com/v1",
    deepseek: "https://api.deepseek.com/v1",
    groq: "https://api.groq.com/openai/v1",
    openrouter: "https://openrouter.ai/api/v1",
    mistral: "https://api.mistral.ai/v1",
    ollama: "http://localhost:11434/v1",
  };
  return urls[provider] ?? "https://api.openai.com/v1";
}

// ─── Legacy Browser-Fetch Streaming Functions ────────────────────────────────
// These remain for the browser-fetch fallback path. They are NOT called
// from the normal streaming path (which uses Rust commands via startStream).

async function streamOpenAICompatible(
  request: LlmRequest,
  callbacks: StreamCallbacks,
  abortSignal?: AbortSignal
): Promise<void> {
  const baseUrl = getBaseUrl(request.provider);
  const messages: Array<{ role: string; content: string }> = [
    { role: "system", content: request.system_prompt },
    { role: "user", content: request.user_prompt },
  ];

  const body = {
    model: request.model,
    messages,
    temperature: request.temperature ?? 0.3,
    max_tokens: request.max_tokens ?? 8192,
    stream: true,
  };

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };

  if (request.api_key) {
    headers["Authorization"] = `Bearer ${request.api_key}`;
  }

  if (request.provider === "openrouter") {
    headers["HTTP-Referer"] = "https://punam-ide.app";
    headers["X-Title"] = "Punam IDE";
  }

  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal: abortSignal,
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`API error ${response.status}: ${errorText}`);
  }

  const reader = response.body?.getReader();
  if (!reader) throw new Error("No response body");

  const decoder = new TextDecoder();
  let fullText = "";
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed === "data: [DONE]") continue;
      if (!trimmed.startsWith("data: ")) continue;

      try {
        const json = JSON.parse(trimmed.slice(6));
        const delta = json.choices?.[0]?.delta?.content;
        if (delta) {
          fullText += delta;
          callbacks.onToken(delta);
        }
      } catch {
        // skip malformed SSE
      }
    }
  }

  callbacks.onComplete(fullText);
}

async function streamGemini(
  request: LlmRequest,
  callbacks: StreamCallbacks,
  abortSignal?: AbortSignal
): Promise<void> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${request.model}:streamGenerateContent?alt=sse&key=${request.api_key}`;

  const parts: Array<{ text?: string }> = [{ text: request.user_prompt }];

  const body = {
    system_instruction: { parts: [{ text: request.system_prompt }] },
    contents: [{ role: "user", parts }],
    generationConfig: {
      temperature: request.temperature ?? 0.3,
      maxOutputTokens: request.max_tokens ?? 8192,
    },
  };

  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: abortSignal,
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Gemini API error ${response.status}: ${errorText}`);
  }

  const reader = response.body?.getReader();
  if (!reader) throw new Error("No response body");

  const decoder = new TextDecoder();
  let fullText = "";
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data: ")) continue;

      try {
        const json = JSON.parse(trimmed.slice(6));
        const text = json.candidates?.[0]?.content?.parts?.[0]?.text;
        if (text) {
          fullText += text;
          callbacks.onToken(text);
        }
      } catch {
        // skip
      }
    }
  }

  callbacks.onComplete(fullText);
}

async function streamAnthropic(
  request: LlmRequest,
  callbacks: StreamCallbacks,
  abortSignal?: AbortSignal
): Promise<void> {
  const content: Array<{ type: string; text?: string }> = [
    { type: "text", text: request.user_prompt },
  ];

  const body = {
    model: request.model,
    system: request.system_prompt,
    messages: [{ role: "user", content }],
    max_tokens: request.max_tokens ?? 8192,
    temperature: request.temperature ?? 0.3,
    stream: true,
  };

  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": request.api_key,
      "anthropic-version": "2023-06-01",
      "anthropic-dangerous-direct-browser-access": "true",
    },
    body: JSON.stringify(body),
    signal: abortSignal,
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Anthropic API error ${response.status}: ${errorText}`);
  }

  const reader = response.body?.getReader();
  if (!reader) throw new Error("No response body");

  const decoder = new TextDecoder();
  let fullText = "";
  let buffer = "";
  let usage: TokenUsage | undefined;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data: ")) continue;

      try {
        const json = JSON.parse(trimmed.slice(6));
        if (json.type === "content_block_delta") {
          const delta = json.delta?.text;
          if (delta) {
            fullText += delta;
            callbacks.onToken(delta);
          }
        }
        if (json.type === "message_delta" && json.usage) {
          usage = {
            prompt_tokens: 0,
            completion_tokens: json.usage.output_tokens || 0,
            total_tokens: json.usage.output_tokens || 0,
          };
        }
        if (json.type === "message_start" && json.message?.usage) {
          const u = json.message.usage;
          usage = {
            prompt_tokens: u.input_tokens || 0,
            completion_tokens: 0,
            total_tokens: u.input_tokens || 0,
          };
        }
      } catch {
        // skip
      }
    }
  }

  callbacks.onComplete(fullText, usage);
}
