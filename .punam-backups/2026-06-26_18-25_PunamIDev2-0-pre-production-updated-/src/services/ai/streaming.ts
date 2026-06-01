/**
 * AI Streaming Service — Direct streaming from OpenAI, Anthropic, Gemini, OpenRouter.
 * No Rust proxy needed — uses browser fetch with SSE parsing.
 * Ported from Zenith IDE for Punam IDE.
 */

import type { TokenUsage } from "../../store/aiStore";

export type AIProvider = "openai" | "anthropic" | "gemini" | "openrouter" | "ollama" | "groq" | "mistral";

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

export async function streamCompletion(
  request: LlmRequest,
  callbacks: StreamCallbacks,
  abortSignal?: AbortSignal
): Promise<void> {
  const provider = request.provider as AIProvider;

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

function getBaseUrl(provider: AIProvider): string {
  switch (provider) {
    case "openai": return "https://api.openai.com/v1";
    case "openrouter": return "https://openrouter.ai/api/v1";
    case "groq": return "https://api.groq.com/openai/v1";
    case "mistral": return "https://api.mistral.ai/v1";
    case "ollama": return "http://localhost:11434/v1";
    default: return "https://api.openai.com/v1";
  }
}

async function streamOpenAICompatible(
  request: LlmRequest,
  callbacks: StreamCallbacks,
  abortSignal?: AbortSignal
): Promise<void> {
  const baseUrl = getBaseUrl(request.provider as AIProvider);
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
