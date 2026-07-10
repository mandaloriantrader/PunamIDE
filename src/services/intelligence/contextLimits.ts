/**
 * Model Context Limit Registry
 *
 * Maps model identifiers to their maximum context window size (in tokens)
 * and provides utility constants for budget calculation.
 */

/** Context window sizes (tokens) for supported models. */
export const MODEL_CONTEXT_LIMITS: Record<string, number> = {
  // Anthropic
  "claude-opus-4": 200_000,
  "claude-sonnet-4": 200_000,
  "claude-3.5-sonnet": 200_000,
  "claude-haiku": 200_000,
  "claude-3-haiku": 200_000,

  // OpenAI
  "gpt-4o": 128_000,
  "gpt-4o-mini": 128_000,

  // Google
  "gemini-2.5-pro": 1_000_000,
  "gemini-2.5-flash": 1_000_000,
  "gemini-2.0-flash": 1_000_000,

  // DeepSeek
  "deepseek-v4-pro": 1_000_000,
  "deepseek-v4-flash": 1_000_000,
  "deepseek-v3": 131_072,
  "deepseek-r1": 65_536,
  "deepseek-coder-v2": 128_000,
  "deepseek-chat": 64_000,
  "deepseek-reasoner": 64_000,

  // Groq
  "llama-3.3-70b-versatile": 128_000,
  "mixtral-8x7b-32768": 32_000,
};

/** Default context limit used when a model is not found in the registry. */
export const DEFAULT_CONTEXT_LIMIT = 32_000;

/** Fraction of the model's context window to fill with context (75%). */
export const CONTEXT_FILL_PCT = 0.75;

/** Fraction of the fillable budget reserved for model response (20%). */
export const RESPONSE_RESERVE_PCT = 0.20;

/**
 * Returns the context window size (in tokens) for the given model.
 *
 * Resolution order:
 * 1. Exact match against MODEL_CONTEXT_LIMITS keys
 * 2. Prefix match — checks if the model string starts with any registry key
 *    (handles versioned names like "claude-sonnet-4-20250601")
 * 3. Falls back to DEFAULT_CONTEXT_LIMIT (32,000)
 */
export function getModelContextLimit(model: string): number {
  // 1. Exact match (use hasOwn to avoid prototype pollution)
  if (Object.hasOwn(MODEL_CONTEXT_LIMITS, model)) {
    return MODEL_CONTEXT_LIMITS[model];
  }

  // 2. Prefix match — find registry keys that are a prefix of the given model
  //    Sort by key length descending so the longest (most specific) prefix wins.
  const entries = Object.entries(MODEL_CONTEXT_LIMITS).sort(
    (a, b) => b[0].length - a[0].length
  );

  for (const [key, limit] of entries) {
    if (model.startsWith(key)) {
      return limit;
    }
  }

  // 3. Default
  return DEFAULT_CONTEXT_LIMIT;
}
