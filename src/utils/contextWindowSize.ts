/**
 * contextWindowSize.ts
 *
 * Resolves the context window size (max tokens) for the active model.
 *
 * Priority:
 *  1. API response (fetched from provider's model listing endpoint)
 *  2. Built-in defaults (static lookup table, updated with each release)
 *  3. Fallback (unknown model → returns null, UI shows "?" gracefully)
 *
 * The API fetch is cached per model ID for the session — avoids repeated
 * network calls on every render.
 */

// ── Built-in defaults ──────────────────────────────────────────────────────────

const KNOWN_CONTEXT_SIZES: Record<string, number> = {
  // OpenAI
  'gpt-4o': 128_000,
  'gpt-4o-mini': 128_000,
  'gpt-4-turbo': 128_000,
  'gpt-4': 8_192,
  'gpt-3.5-turbo': 16_385,
  'o1': 200_000,
  'o1-mini': 128_000,
  'o1-pro': 200_000,
  'o3': 200_000,
  'o3-mini': 200_000,
  'o4-mini': 200_000,

  // Anthropic
  'claude-sonnet-4-20250514': 200_000,
  'claude-opus-4-20250514': 200_000,
  'claude-3-5-sonnet-20241022': 200_000,
  'claude-3-5-haiku-20241022': 200_000,
  'claude-3-opus-20240229': 200_000,
  'claude-3-haiku-20240307': 200_000,

  // DeepSeek
  'deepseek-chat': 64_000,
  'deepseek-coder': 64_000,
  'deepseek-reasoner': 64_000,
  'deepseek-v3': 64_000,
  'deepseek-v4': 1_000_000,
  'deepseek-v4-pro': 1_000_000,
  'deepseek-r1': 128_000,

  // Google Gemini
  'gemini-2.5-pro': 1_000_000,
  'gemini-2.5-flash': 1_000_000,
  'gemini-2.0-flash': 1_000_000,
  'gemini-1.5-pro': 1_000_000,
  'gemini-1.5-flash': 1_000_000,

  // Meta Llama
  'llama-3.1-8b': 128_000,
  'llama-3.1-70b': 128_000,
  'llama-3.1-405b': 128_000,
  'llama-3.3-70b': 128_000,

  // Mistral
  'mistral-large-latest': 128_000,
  'mistral-medium-latest': 32_000,
  'codestral-latest': 32_000,
  'open-mistral-nemo': 128_000,

  // Groq-hosted
  'llama-3.3-70b-versatile': 128_000,
  'llama-3.1-8b-instant': 128_000,
  'mixtral-8x7b-32768': 32_768,

  // Qwen
  'qwen-2.5-coder-32b': 32_768,
  'qwen-2.5-72b': 128_000,

  // Local defaults (Ollama common models)
  'codellama': 16_384,
  'deepseek-coder-v2': 128_000,
  'qwen2.5-coder': 32_768,
}

// ── Session cache for API-fetched sizes ────────────────────────────────────────

const apiCache = new Map<string, number>()

// ── Public API ─────────────────────────────────────────────────────────────────

/**
 * Get the context window size for a model.
 * Returns the token limit or null if unknown.
 *
 * Checks: API cache → built-in table → fuzzy match → null
 */
export function getContextWindowSize(modelId: string): number | null {
  // Check API cache first (most accurate, fetched from provider)
  if (apiCache.has(modelId)) return apiCache.get(modelId)!

  // Check exact match in built-in table
  const normalized = modelId.toLowerCase().trim()
  if (KNOWN_CONTEXT_SIZES[normalized]) return KNOWN_CONTEXT_SIZES[normalized]

  // Fuzzy match: try prefix matching (e.g. "gpt-4o-2024-08-06" → "gpt-4o")
  for (const [key, size] of Object.entries(KNOWN_CONTEXT_SIZES)) {
    if (normalized.startsWith(key) || key.startsWith(normalized)) {
      return size
    }
  }

  return null
}

/**
 * Update the context window size from an API response.
 * Called when provider returns model info with context_length.
 */
export function setContextWindowFromAPI(modelId: string, contextLength: number): void {
  apiCache.set(modelId, contextLength)
}

/**
 * Format a token count for display.
 * 1000 → "1.0K", 128000 → "128K", 1000000 → "1.0M"
 */
export function formatTokens(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(tokens >= 100_000 ? 0 : 1)}K`
  return String(tokens)
}
