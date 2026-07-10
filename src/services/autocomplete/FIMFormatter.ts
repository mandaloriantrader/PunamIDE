import type { FIMTokenFormat } from "./types";

export type FIMFamily = "deepseek" | "codestral" | "starcoder" | "codellama" | "qwen";

export type { FIMTokenFormat };

interface FIMRegistryEntry {
  match: RegExp;
  tokens: FIMTokenFormat;
}

const FIM_REGISTRY: FIMRegistryEntry[] = [
  {
    match: /deepseek[-_]?coder|deepseek[-_]?v2/i,
    tokens: { prefix: "<｜fim▁begin｜>", suffix: "<｜fim▁hole｜>", middle: "<｜fim▁end｜>" },
  },
  {
    match: /codestral|mistral.*code/i,
    tokens: { prefix: "[PREFIX]", suffix: "[SUFFIX]", middle: "[MIDDLE]" },
  },
  {
    match: /starcoder|bigcode/i,
    tokens: { prefix: "<fim_prefix>", suffix: "<fim_suffix>", middle: "<fim_middle>" },
  },
  {
    match: /code[-_]?llama/i,
    tokens: { prefix: "<PRE> ", suffix: " <SUF>", middle: " <MID>" },
  },
  {
    match: /qwen.*coder/i,
    tokens: { prefix: "<fim_prefix>", suffix: "<fim_suffix>", middle: "<fim_middle>" },
  },
];

/**
 * Returns true if the model matches any known FIM token format.
 */
export function supportsFIM(modelId: string): boolean {
  return FIM_REGISTRY.some((entry) => entry.match.test(modelId));
}

/**
 * Returns the FIM token format for the given model, or null if unsupported.
 */
export function getFIMFormat(modelId: string): FIMTokenFormat | null {
  for (const entry of FIM_REGISTRY) {
    if (entry.match.test(modelId)) {
      return entry.tokens;
    }
  }
  return null;
}

/**
 * Builds a complete FIM prompt string for the given model, or returns null if unsupported.
 */
export function formatPrompt(prefix: string, suffix: string, modelId: string): string | null {
  const fmt = getFIMFormat(modelId);
  if (!fmt) return null;
  return `${fmt.prefix}${prefix}${fmt.suffix}${suffix}${fmt.middle}`;
}
