/**
 * AI Provider abstraction for PunamIDE.
 * Supports Gemini (native) and OpenAI-compatible (OpenAI, OpenRouter, Ollama).
 */

// --- Types ---

export interface AIProviderConfig {
  id: string;
  type: "gemini" | "openai-compatible" | "anthropic";
  name: string;
  apiKey: string;
  baseUrl?: string; // Optional for OpenAI-compatible
  models: ModelConfig[];
}

export interface ModelConfig {
  id: string;
  name: string;
  enabled: boolean; // checked in model selector
}

export interface AIRequest {
  systemPrompt: string;
  userPrompt: string;
  temperature?: number;
  maxTokens?: number;
  images?: Array<{ base64: string; mimeType: string }>; // For vision API support
  streamId?: string;
  signal?: AbortSignal;
}

export interface AIResponse {
  text: string;
  success: boolean;
  error?: string;
  metrics: ResponseMetrics;
}

export interface ResponseMetrics {
  provider: string;
  model: string;
  promptTokens?: number;
  responseTokens?: number;
  totalTokens?: number;
  estimatedCostUsd?: number;
  estimatedCostInr?: number;
  durationMs: number;
  status: "success" | "error" | "rate_limited";
}

// --- Token Estimation ---

/** Approximate token count using char_count / 4 heuristic (~85% accurate for English/code) */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

interface ModelPricing {
  inputPerMillionUsd: number;
  outputPerMillionUsd: number;
}

const USD_TO_INR_ESTIMATE = 83;

const MODEL_PRICING: Array<{ match: RegExp; pricing: ModelPricing }> = [
  { match: /gemini-2\.5-flash-lite/i, pricing: { inputPerMillionUsd: 0.10, outputPerMillionUsd: 0.40 } },
  { match: /gemini-2\.5-flash/i, pricing: { inputPerMillionUsd: 0.30, outputPerMillionUsd: 2.50 } },
  { match: /gemini-2\.5-pro/i, pricing: { inputPerMillionUsd: 1.25, outputPerMillionUsd: 10.00 } },
  { match: /gemini-2\.0-flash-lite/i, pricing: { inputPerMillionUsd: 0.075, outputPerMillionUsd: 0.30 } },
  { match: /gemini-2\.0-flash/i, pricing: { inputPerMillionUsd: 0.10, outputPerMillionUsd: 0.40 } },
];

function getPricing(model: string): ModelPricing | null {
  return MODEL_PRICING.find((item) => item.match.test(model))?.pricing ?? null;
}

function buildMetrics(
  provider: string,
  model: string,
  request: AIRequest,
  responseText: string,
  durationMs: number,
  status: ResponseMetrics["status"]
): ResponseMetrics {
  const promptTokens = estimateTokens(`${request.systemPrompt}\n${request.userPrompt}`);
  const responseTokens = responseText ? estimateTokens(responseText) : 0;
  const totalTokens = promptTokens + responseTokens;
  const pricing = getPricing(model);

  if (!pricing) {
    return { provider, model, promptTokens, responseTokens, totalTokens, durationMs, status };
  }

  const estimatedCostUsd =
    (promptTokens / 1_000_000) * pricing.inputPerMillionUsd +
    (responseTokens / 1_000_000) * pricing.outputPerMillionUsd;

  return {
    provider,
    model,
    promptTokens,
    responseTokens,
    totalTokens,
    estimatedCostUsd,
    estimatedCostInr: estimatedCostUsd * USD_TO_INR_ESTIMATE,
    durationMs,
    status,
  };
}

// --- Error Parsing ---

function parseFriendlyError(status: number, body: string, provider: string): string {
  if (status === 429) {
    return `Rate limited by ${provider}. Too many requests — wait a moment and try again.`;
  }
  if (status === 401 || status === 403) {
    return `Invalid API key for ${provider}. Check your key in Settings.`;
  }
  if (status === 404) {
    return `Model not found on ${provider}. Check the model name in Settings.`;
  }
  if (status === 500 || status === 502 || status === 503) {
    return `${provider} server error (${status}). Try again in a few seconds.`;
  }
  if (status === 0) {
    return `Network error — cannot reach ${provider}. Check your internet connection.`;
  }
  // Try to extract message from body
  try {
    const parsed = JSON.parse(body);
    const msg = parsed?.error?.message || parsed?.error?.status || parsed?.message;
    if (msg) return `${provider}: ${msg}`;
  } catch { /* ignore */ }
  return `${provider} error (${status}): ${body.slice(0, 200)}`;
}

// --- Gemini Provider ---

async function callGemini(
  config: AIProviderConfig,
  model: string,
  request: AIRequest
): Promise<AIResponse> {
  const startTime = performance.now();

  try {
    // Route through Rust backend to avoid CORS
    const { invoke } = await import("@tauri-apps/api/core");
    const result = await invoke<{ text: string; success: boolean; error?: string }>("call_llm", {
      request: {
        provider: "gemini",
        api_key: config.apiKey,
        model,
        system_prompt: request.systemPrompt,
        user_prompt: request.userPrompt,
        images: request.images?.map((img) => ({ base64: img.base64, mime_type: img.mimeType })) || null,
      },
    });

    const durationMs = performance.now() - startTime;

    if (!result.success) {
      const isTooMany = result.error?.includes("429");
      const isUnavailable =
        result.error?.includes("503") ||
        result.error?.includes("UNAVAILABLE") ||
        result.error?.toLowerCase().includes("high demand");
      return {
        text: "",
        success: false,
        error: isTooMany
          ? `Rate limited by ${config.name}. Too many requests — wait a moment and try again.`
          : isUnavailable
            ? `${config.name} is temporarily busy. This is a provider-side high-demand spike; retry in a minute or switch to another model.`
            : result.error || "Unknown error",
        metrics: buildMetrics(config.name, model, request, "", durationMs, isTooMany ? "rate_limited" : "error"),
      };
    }

    return {
      text: result.text,
      success: true,
      metrics: buildMetrics(config.name, model, request, result.text, durationMs, "success"),
    };
  } catch (err) {
    const durationMs = performance.now() - startTime;
    return {
      text: "",
      success: false,
      error: parseFriendlyError(0, String(err), config.name),
      metrics: buildMetrics(config.name, model, request, "", durationMs, "error"),
    };
  }
}

// --- OpenAI-Compatible Provider ---

async function callOpenAICompatible(
  config: AIProviderConfig,
  model: string,
  request: AIRequest
): Promise<AIResponse> {
  const startTime = performance.now();
  const baseUrl = config.baseUrl?.replace(/\/+$/, "") || "https://api.openai.com/v1";

  try {
    // Route through Rust backend to avoid CORS
    // We use the openai-compatible path in the Rust backend
    const { invoke } = await import("@tauri-apps/api/core");
    const result = await invoke<{ text: string; success: boolean; error?: string }>("call_openai_compatible_cmd", {
      apiKey: config.apiKey,
      baseUrl,
      model,
      systemPrompt: request.systemPrompt,
      userPrompt: request.userPrompt,
      images: request.images?.map((img) => ({ base64: img.base64, mime_type: img.mimeType })) || null,
      isOpenRouter: baseUrl.includes("openrouter.ai"),
    });

    const durationMs = performance.now() - startTime;

    if (!result.success) {
      const isTooMany = result.error?.includes("429");
      const isNotFound = result.error?.includes("404") || result.error?.includes("not found");
      return {
        text: "",
        success: false,
        error: isTooMany
          ? `Rate limited by ${config.name}. Too many requests — wait a moment and try again.`
          : isNotFound
            ? `Model not found on ${config.name}. Check the model name in Settings.`
            : result.error || "Unknown error",
        metrics: buildMetrics(config.name, model, request, "", durationMs, isTooMany ? "rate_limited" : "error"),
      };
    }

    return {
      text: result.text,
      success: true,
      metrics: buildMetrics(config.name, model, request, result.text, durationMs, "success"),
    };
  } catch (err) {
    const durationMs = performance.now() - startTime;
    return {
      text: "",
      success: false,
      error: parseFriendlyError(0, String(err), config.name),
      metrics: buildMetrics(config.name, model, request, "", durationMs, "error"),
    };
  }
}

// --- Unified Dispatch ---

export async function sendToProvider(
  config: AIProviderConfig,
  model: string,
  request: AIRequest
): Promise<AIResponse> {
  switch (config.type) {
    case "gemini":
      return callGemini(config, model, request);
    case "openai-compatible":
      return callOpenAICompatible(config, model, request);
    default:
      return {
        text: "",
        success: false,
        error: `Unknown provider type: ${config.type}`,
        metrics: buildMetrics(config.name, model, request, "", 0, "error"),
      };
  }
}

/** Run up to `limit` async tasks concurrently */
async function concurrentLimit<T>(tasks: Array<() => Promise<T>>, limit: number): Promise<T[]> {
  const results: T[] = new Array(tasks.length);
  let nextIndex = 0;

  async function worker(): Promise<void> {
    while (nextIndex < tasks.length) {
      const idx = nextIndex++;
      results[idx] = await tasks[idx]();
    }
  }

  const workers = Array.from({ length: Math.min(limit, tasks.length) }, () => worker());
  await Promise.all(workers);
  return results;
}

/** Send to multiple models with at most 3 concurrent requests */
export async function sendToMultipleModels(
  providers: AIProviderConfig[],
  selectedModels: Array<{ providerId: string; model: string }>,
  request: AIRequest
): Promise<AIResponse[]> {
  const tasks = selectedModels.map(({ providerId, model }) => {
    const provider = providers.find((p) => p.id === providerId);
    if (!provider) {
      return () => Promise.resolve<AIResponse>({
        text: "",
        success: false,
        error: `Provider ${providerId} not found`,
        metrics: {
          provider: providerId,
          model,
          promptTokens: estimateTokens(`${request.systemPrompt}\n${request.userPrompt}`),
          responseTokens: 0,
          totalTokens: estimateTokens(`${request.systemPrompt}\n${request.userPrompt}`),
          durationMs: 0,
          status: "error",
        },
      });
    }
    return () => sendToProvider(provider, model, request);
  });

  return concurrentLimit(tasks, 3);
}

/** Send with streaming — emits tokens via 'llm-stream' event, returns full text at end */
export async function sendToProviderStreaming(
  config: AIProviderConfig,
  model: string,
  request: AIRequest
): Promise<AIResponse> {
  const streamId = request.streamId ?? `llm-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  const { invoke } = await import("@tauri-apps/api/core");
  const cancelNativeStream = () => {
    void invoke("cancel_llm_stream", { streamId }).catch(() => {});
  };
  if (request.signal?.aborted) {
    cancelNativeStream();
    return {
      text: "",
      success: false,
      error: "Request cancelled",
      metrics: buildMetrics(config.name, model, request, "", 0, "error"),
    };
  }
  request.signal?.addEventListener("abort", cancelNativeStream, { once: true });

  try {
  if (config.type === "gemini") {
    // Gemini: use native SSE streaming via Rust backend
    const startTime = performance.now();
    try {
      const result = await invoke<{ text: string; success: boolean; error?: string }>("call_gemini_stream", {
        apiKey: config.apiKey,
        model,
        systemPrompt: request.systemPrompt,
        userPrompt: request.userPrompt,
        images: request.images?.map((img) => ({ base64: img.base64, mime_type: img.mimeType })) || null,
        streamId,
      });

      const durationMs = performance.now() - startTime;

      if (!result.success) {
        return {
          text: "",
          success: false,
          error: result.error || "Unknown error",
          metrics: buildMetrics(config.name, model, request, "", durationMs, "error"),
        };
      }

      return {
        text: result.text,
        success: true,
        metrics: buildMetrics(config.name, model, request, result.text, durationMs, "success"),
      };
    } catch (err) {
      const durationMs = performance.now() - startTime;
      return {
        text: "",
        success: false,
        error: parseFriendlyError(0, String(err), config.name),
        metrics: buildMetrics(config.name, model, request, "", durationMs, "error"),
      };
    }
  }

  const startTime = performance.now();
  const baseUrl = config.baseUrl?.replace(/\/+$/, "") || "https://api.openai.com/v1";

  try {
    const result = await invoke<{ text: string; success: boolean; error?: string }>("call_openai_compatible_stream", {
      apiKey: config.apiKey,
      baseUrl,
      model,
      systemPrompt: request.systemPrompt,
      userPrompt: request.userPrompt,
      images: request.images?.map((img) => ({ base64: img.base64, mime_type: img.mimeType })) || null,
      isOpenRouter: baseUrl.includes("openrouter.ai"),
      streamId,
    });

    const durationMs = performance.now() - startTime;

    if (!result.success) {
      return {
        text: "",
        success: false,
        error: result.error || "Unknown error",
        metrics: buildMetrics(config.name, model, request, "", durationMs, "error"),
      };
    }

    return {
      text: result.text,
      success: true,
      metrics: buildMetrics(config.name, model, request, result.text, durationMs, "success"),
    };
  } catch (err) {
    const durationMs = performance.now() - startTime;
    return {
      text: "",
      success: false,
      error: String(err),
      metrics: buildMetrics(config.name, model, request, "", durationMs, "error"),
    };
  }
  } finally {
    request.signal?.removeEventListener("abort", cancelNativeStream);
  }
}

/** Test a provider connection with a minimal request */
export async function testConnection(config: AIProviderConfig, model: string): Promise<{ success: boolean; error?: string }> {
  const response = await sendToProvider(config, model, {
    systemPrompt: "You are a helpful assistant.",
    userPrompt: "Say hello in one word.",
    maxTokens: 10,
  });
  return { success: response.success, error: response.error };
}

// --- Default Provider Presets ---

export const PROVIDER_PRESETS: Array<{ type: AIProviderConfig["type"]; name: string; baseUrl?: string; defaultModel: string; keyLabel: string; getKeyUrl: string }> = [
  {
    type: "gemini",
    name: "Google Gemini",
    defaultModel: "gemini-2.5-flash",
    keyLabel: "Gemini API Key",
    getKeyUrl: "https://aistudio.google.com/apikey",
  },
  {
    type: "openai-compatible",
    name: "OpenAI",
    baseUrl: "https://api.openai.com/v1",
    defaultModel: "gpt-4o-mini",
    keyLabel: "OpenAI API Key",
    getKeyUrl: "https://platform.openai.com/api-keys",
  },
  {
    type: "openai-compatible",
    name: "OpenRouter",
    baseUrl: "https://openrouter.ai/api/v1",
    defaultModel: "anthropic/claude-sonnet-4",
    keyLabel: "OpenRouter API Key",
    getKeyUrl: "https://openrouter.ai/keys",
  },
  {
    type: "openai-compatible",
    name: "DeepSeek",
    baseUrl: "https://api.deepseek.com",
    defaultModel: "deepseek-v4-flash",
    keyLabel: "DeepSeek API Key",
    getKeyUrl: "https://platform.deepseek.com/api_keys",
  },
  {
    type: "openai-compatible",
    name: "Groq",
    baseUrl: "https://api.groq.com/openai/v1",
    defaultModel: "llama-3.3-70b-versatile",
    keyLabel: "Groq API Key",
    getKeyUrl: "https://console.groq.com/keys",
  },
  {
    type: "openai-compatible",
    name: "Mistral AI",
    baseUrl: "https://api.mistral.ai/v1",
    defaultModel: "mistral-small-latest",
    keyLabel: "Mistral API Key",
    getKeyUrl: "https://console.mistral.ai/api-keys",
  },
  {
    type: "openai-compatible",
    name: "Ollama (Local)",
    baseUrl: "http://localhost:11434/v1",
    defaultModel: "qwen2.5:7b",
    keyLabel: "No key needed",
    getKeyUrl: "",
  },
];
