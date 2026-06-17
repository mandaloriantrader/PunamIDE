/**
 * AnthropicProvider.ts — First-class Anthropic Claude provider for PunamIDE.
 *
 * Implements both non-streaming and streaming chat completions using the
 * Anthropic Messages API (Claude 4 compatible). Uses browser fetch directly
 * (no Rust proxy needed — Tauri desktop apps have no CORS restrictions).
 *
 * Responsibilities:
 *   - Construct Anthropic API requests from PunamIDE's AIRequest format
 *   - Execute HTTP calls with proper auth headers
 *   - Parse responses into PunamIDE's normalized AIResponse format
 *   - Handle streaming with full SSE event support
 *   - Support abort/cancellation
 *   - Error handling with user-friendly messages
 */

import type { AIProviderConfig, AIRequest, AIResponse } from "../../utils/providers";
import { mapRequestToAnthropic, mapAnthropicResponse, buildAnthropicMetrics } from "./anthropicMapper";
import { executeAnthropicStream } from "./anthropicStream";
import type { AnthropicMessagesResponse } from "./anthropicTypes";

// ── Constants ─────────────────────────────────────────────────────────────────

const DEFAULT_BASE_URL = "https://api.anthropic.com/v1";
const API_VERSION = "2023-06-01";

// ── Non-Streaming ─────────────────────────────────────────────────────────────

/**
 * Send a non-streaming request to the Anthropic Messages API.
 * Returns the complete response as a PunamIDE AIResponse.
 */
export async function sendToAnthropic(
  config: AIProviderConfig,
  model: string,
  request: AIRequest,
): Promise<AIResponse> {
  const startTime = performance.now();
  const baseUrl = (config.baseUrl?.replace(/\/+$/, "") || DEFAULT_BASE_URL);
  const url = `${baseUrl}/messages`;

  const body = mapRequestToAnthropic(request, model, false);

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: buildHeaders(config.apiKey),
      body: JSON.stringify(body),
      signal: request.signal,
    });

    const durationMs = performance.now() - startTime;

    if (!response.ok) {
      const errorText = await response.text();
      return {
        text: "",
        success: false,
        error: parseAnthropicError(response.status, errorText),
        metrics: buildAnthropicMetrics(config.name, model, null, durationMs, response.status === 429 ? "rate_limited" : "error"),
      };
    }

    const data: AnthropicMessagesResponse = await response.json();
    return mapAnthropicResponse(data, config.name, model, durationMs);
  } catch (err) {
    const durationMs = performance.now() - startTime;
    if (request.signal?.aborted) {
      return {
        text: "",
        success: false,
        error: "Request cancelled",
        metrics: buildAnthropicMetrics(config.name, model, null, durationMs, "error"),
      };
    }
    return {
      text: "",
      success: false,
      error: `Network error — cannot reach Anthropic: ${err instanceof Error ? err.message : String(err)}`,
      metrics: buildAnthropicMetrics(config.name, model, null, durationMs, "error"),
    };
  }
}

// ── Streaming ─────────────────────────────────────────────────────────────────

/**
 * Send a streaming request to the Anthropic Messages API.
 *
 * Tokens are emitted via the Tauri event system (same 'llm-stream' event as other providers)
 * so the existing UI streaming infrastructure works without any changes.
 *
 * Returns the full accumulated text + metrics when the stream completes.
 */
export async function sendToAnthropicStreaming(
  config: AIProviderConfig,
  model: string,
  request: AIRequest,
): Promise<AIResponse> {
  const startTime = performance.now();
  const baseUrl = (config.baseUrl?.replace(/\/+$/, "") || DEFAULT_BASE_URL);
  const url = `${baseUrl}/messages`;
  const streamId = request.streamId ?? `anthropic-${Date.now()}`;

  const body = mapRequestToAnthropic(request, model, true);

  // Dynamically import Tauri event emitter to send tokens to the UI
  // (same mechanism as Rust-based streaming — UI listens on 'llm-stream')
  const { emit } = await import("@tauri-apps/api/event");

  const accumulator = await executeAnthropicStream(
    url,
    buildHeaders(config.apiKey),
    JSON.stringify(body),
    {
      onToken: (token) => {
        emit("llm-stream", { stream_id: streamId, token, done: false }).catch(() => {});
      },
      onComplete: () => {
        emit("llm-stream", { stream_id: streamId, token: "", done: true }).catch(() => {});
      },
      onError: (error) => {
        emit("llm-stream", { stream_id: streamId, token: "", done: true }).catch(() => {});
        console.warn("[AnthropicProvider] Stream error:", error);
      },
    },
    request.signal,
  );

  const durationMs = performance.now() - startTime;

  if (accumulator.error) {
    return {
      text: accumulator.text,
      success: false,
      error: accumulator.error,
      metrics: buildAnthropicMetrics(config.name, model, accumulator.usage, durationMs, "error"),
    };
  }

  return {
    text: accumulator.text,
    success: true,
    metrics: buildAnthropicMetrics(config.name, model, accumulator.usage, durationMs, "success"),
  };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function buildHeaders(apiKey: string): Record<string, string> {
  return {
    "Content-Type": "application/json",
    "x-api-key": apiKey,
    "anthropic-version": API_VERSION,
  };
}

function parseAnthropicError(status: number, body: string): string {
  if (status === 401) return "Invalid Anthropic API key. Check your key in Settings.";
  if (status === 403) return "Anthropic API access denied. Your key may lack permissions for this model.";
  if (status === 404) return "Model not found on Anthropic. Check the model ID in Settings.";
  if (status === 429) return "Rate limited by Anthropic. Wait a moment and try again.";
  if (status === 529) return "Anthropic API is overloaded. Retry in a moment.";
  if (status >= 500) return `Anthropic server error (${status}). Try again in a few seconds.`;

  try {
    const parsed = JSON.parse(body);
    if (parsed?.error?.message) return `Anthropic: ${parsed.error.message}`;
  } catch { /* ignore */ }

  return `Anthropic error (${status}): ${body.slice(0, 200)}`;
}
