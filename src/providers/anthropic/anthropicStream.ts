/**
 * anthropicStream.ts — Claude 4 compatible SSE streaming parser.
 *
 * Handles ALL Anthropic streaming events:
 *   - message_start       → extract model, input token usage
 *   - content_block_start → initialize text or tool_use block
 *   - content_block_delta → accumulate text or partial JSON
 *   - content_block_stop  → finalize block
 *   - message_delta       → stop_reason + output token usage
 *   - message_stop        → clean stream completion
 *   - ping                → keepalive (ignored)
 *   - error               → stream-level error
 *
 * Supports future tool-use streaming:
 *   - tool_use blocks accumulated via input_json_delta
 *   - Partial JSON collected and parsed on block stop
 */

import type {
  AnthropicStreamEvent,
  AnthropicUsage,
} from "./anthropicTypes";

// ── Stream State ──────────────────────────────────────────────────────────────

export interface StreamAccumulator {
  /** Full text response accumulated from text deltas. */
  text: string;
  /** Token usage (filled progressively from message_start + message_delta). */
  usage: AnthropicUsage;
  /** Stop reason from message_delta. */
  stopReason: string | null;
  /** Tool use blocks (for future tool streaming support). */
  toolUseBlocks: Array<{ id: string; name: string; inputJson: string }>;
  /** Whether the stream completed normally (message_stop received). */
  completed: boolean;
  /** Error if the stream errored. */
  error: string | null;
}

/** Internal tracking of the current content block being streamed. */
interface ActiveBlock {
  index: number;
  type: "text" | "tool_use";
  // For tool_use blocks
  toolId?: string;
  toolName?: string;
  partialJson?: string;
}

// ── Streaming Callbacks ───────────────────────────────────────────────────────

export interface AnthropicStreamCallbacks {
  /** Called for each text token as it arrives. */
  onToken: (token: string) => void;
  /** Called when the stream completes normally. */
  onComplete: (accumulator: StreamAccumulator) => void;
  /** Called on stream error (Anthropic error event or network failure). */
  onError: (error: string) => void;
}

// ── Main Stream Processor ─────────────────────────────────────────────────────

/**
 * Execute a streaming request to the Anthropic Messages API and process SSE events.
 *
 * Uses browser fetch (no Rust dependency). Tauri desktop apps have no CORS restrictions
 * on fetch, so direct API calls work without a proxy.
 */
export async function executeAnthropicStream(
  url: string,
  headers: Record<string, string>,
  body: string,
  callbacks: AnthropicStreamCallbacks,
  abortSignal?: AbortSignal,
): Promise<StreamAccumulator> {
  const accumulator: StreamAccumulator = {
    text: "",
    usage: { input_tokens: 0, output_tokens: 0 },
    stopReason: null,
    toolUseBlocks: [],
    completed: false,
    error: null,
  };

  let activeBlock: ActiveBlock | null = null;

  try {
    const response = await fetch(url, {
      method: "POST",
      headers,
      body,
      signal: abortSignal,
    });

    if (!response.ok) {
      const errorText = await response.text();
      const errorMsg = parseHttpError(response.status, errorText);
      accumulator.error = errorMsg;
      callbacks.onError(errorMsg);
      return accumulator;
    }

    const reader = response.body?.getReader();
    if (!reader) {
      const msg = "No response body from Anthropic API";
      accumulator.error = msg;
      callbacks.onError(msg);
      return accumulator;
    }

    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      if (abortSignal?.aborted) {
        reader.cancel();
        break;
      }

      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      // Parse SSE lines
      const lines = buffer.split("\n");
      buffer = lines.pop() || ""; // Keep incomplete line in buffer

      let eventType = "";
      for (const line of lines) {
        const trimmed = line.trim();

        if (trimmed === "") {
          // Empty line = end of SSE event (reset event type)
          eventType = "";
          continue;
        }

        if (trimmed.startsWith("event: ")) {
          eventType = trimmed.slice(7);
          continue;
        }

        if (trimmed.startsWith("data: ")) {
          const data = trimmed.slice(6);
          try {
            const event = JSON.parse(data) as AnthropicStreamEvent;
            processEvent(event, accumulator, activeBlock, callbacks, (block) => { activeBlock = block; });
          } catch {
            // Malformed JSON — skip (ping events sometimes don't have data)
          }
        }
      }
    }

    // If stream ended without message_stop, mark as completed anyway
    if (!accumulator.completed && !accumulator.error) {
      accumulator.completed = true;
      callbacks.onComplete(accumulator);
    }
  } catch (err) {
    if (abortSignal?.aborted) {
      // Cancelled by user — not an error
      accumulator.completed = true;
      callbacks.onComplete(accumulator);
    } else {
      const msg = err instanceof Error ? err.message : String(err);
      accumulator.error = msg;
      callbacks.onError(msg);
    }
  }

  return accumulator;
}

// ── Event Processing ──────────────────────────────────────────────────────────

function processEvent(
  event: AnthropicStreamEvent,
  acc: StreamAccumulator,
  activeBlock: ActiveBlock | null,
  callbacks: AnthropicStreamCallbacks,
  setActiveBlock: (block: ActiveBlock | null) => void,
): void {
  switch (event.type) {
    case "message_start": {
      // Extract initial usage (input tokens)
      if (event.message?.usage) {
        acc.usage.input_tokens = event.message.usage.input_tokens;
        acc.usage.output_tokens = event.message.usage.output_tokens;
      }
      break;
    }

    case "content_block_start": {
      const block = event.content_block;
      if (block.type === "text") {
        setActiveBlock({ index: event.index, type: "text" });
        // Initial text (usually empty string)
        if (block.text) {
          acc.text += block.text;
          callbacks.onToken(block.text);
        }
      } else if (block.type === "tool_use") {
        setActiveBlock({
          index: event.index,
          type: "tool_use",
          toolId: block.id,
          toolName: block.name,
          partialJson: "",
        });
      }
      break;
    }

    case "content_block_delta": {
      const delta = event.delta;
      if (delta.type === "text_delta") {
        acc.text += delta.text;
        callbacks.onToken(delta.text);
      } else if (delta.type === "input_json_delta" && activeBlock?.type === "tool_use") {
        // Accumulate partial JSON for tool use blocks
        activeBlock.partialJson = (activeBlock.partialJson || "") + delta.partial_json;
      }
      break;
    }

    case "content_block_stop": {
      if (activeBlock?.type === "tool_use") {
        // Finalize tool use block — parse accumulated JSON
        acc.toolUseBlocks.push({
          id: activeBlock.toolId || "",
          name: activeBlock.toolName || "",
          inputJson: activeBlock.partialJson || "{}",
        });
      }
      setActiveBlock(null);
      break;
    }

    case "message_delta": {
      acc.stopReason = event.delta.stop_reason;
      if (event.usage) {
        acc.usage.output_tokens = event.usage.output_tokens;
      }
      break;
    }

    case "message_stop": {
      acc.completed = true;
      callbacks.onComplete(acc);
      break;
    }

    case "ping": {
      // Keepalive — ignore
      break;
    }

    case "error": {
      const msg = `Anthropic stream error: ${event.error.type} — ${event.error.message}`;
      acc.error = msg;
      callbacks.onError(msg);
      break;
    }
  }
}

// ── Error Parsing ─────────────────────────────────────────────────────────────

function parseHttpError(status: number, body: string): string {
  if (status === 401) return "Invalid Anthropic API key. Check your key in Settings.";
  if (status === 403) return "Anthropic API access denied. Your key may lack permissions for this model.";
  if (status === 404) return "Model not found. Check the model ID in Settings.";
  if (status === 429) return "Rate limited by Anthropic. Wait a moment and try again.";
  if (status === 529) return "Anthropic API is overloaded. Retry in a moment.";
  if (status >= 500) return `Anthropic server error (${status}). Try again in a few seconds.`;

  try {
    const parsed = JSON.parse(body);
    const msg = parsed?.error?.message;
    if (msg) return `Anthropic: ${msg}`;
  } catch { /* ignore */ }

  return `Anthropic API error (${status}): ${body.slice(0, 200)}`;
}
