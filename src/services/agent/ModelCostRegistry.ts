/**
 * ModelCostRegistry.ts — Model Cost Estimation & INR Formatting
 *
 * Central registry of per-1M-token costs (USD) for all supported models.
 * Provides:
 *   - MODEL_COSTS: constant mapping model IDs to { input, output } prices
 *   - estimateCostUsd(): calculates cost given token counts and model
 *   - USD_TO_INR: conversion constant
 *   - formatCostInr(): formats USD amount as ₹X.XX or paise for sub-rupee
 *
 * Usage:
 *   const cost = estimateCostUsd(1200, 800, 'claude-sonnet-4');
 *   const display = formatCostInr(cost); // "₹0.38"
 */

// ── Types ──────────────────────────────────────────────────────────────────────

export interface ModelCost {
  /** Cost per 1M input tokens in USD */
  input: number;
  /** Cost per 1M output tokens in USD */
  output: number;
}

// ── Model Cost Registry ────────────────────────────────────────────────────────

/**
 * Per-1M-token pricing in USD for all supported models.
 * Update this single constant when provider prices change.
 */
export const MODEL_COSTS: Record<string, ModelCost> = {
  // Anthropic
  "claude-opus-4": { input: 15.0, output: 75.0 },
  "claude-sonnet-4": { input: 3.0, output: 15.0 },
  "claude-3.5-sonnet": { input: 3.0, output: 15.0 }, // alias
  "claude-haiku": { input: 0.8, output: 4.0 },
  "claude-3-haiku": { input: 0.8, output: 4.0 }, // alias

  // OpenAI
  "gpt-4o": { input: 2.5, output: 10.0 },
  "gpt-4o-mini": { input: 0.15, output: 0.6 },

  // Google
  "gemini-2.5-pro": { input: 1.25, output: 10.0 },
  "gemini-2.5-flash": { input: 0.075, output: 0.3 },
  "gemini-2.0-flash": { input: 0.075, output: 0.3 },

  // DeepSeek
  "deepseek-chat": { input: 0.27, output: 1.1 },
  "deepseek-reasoner": { input: 0.55, output: 2.19 },

  // Groq
  "llama-3.3-70b-versatile": { input: 0.59, output: 0.79 },
  "mixtral-8x7b-32768": { input: 0.24, output: 0.24 },
};

// ── Cost Estimation ────────────────────────────────────────────────────────────

/**
 * Estimate cost in USD for a given token count and model.
 * Returns 0 for unknown models (fail-safe — don't block on missing prices).
 */
export function estimateCostUsd(
  inputTokens: number,
  outputTokens: number,
  model: string,
): number {
  const cost = MODEL_COSTS[model];
  if (!cost) return 0;

  const inputCost = (inputTokens / 1_000_000) * cost.input;
  const outputCost = (outputTokens / 1_000_000) * cost.output;

  return inputCost + outputCost;
}

// ── Currency Conversion ────────────────────────────────────────────────────────

/** USD to INR conversion rate (update periodically). */
export const USD_TO_INR = 83.5;

/**
 * Format a USD amount as INR for display.
 * - ₹1.00 and above: "₹X.XX"
 * - Below ₹1: "₹X.Xp" (paise notation for clarity on tiny amounts)
 */
export function formatCostInr(usd: number): string {
  const inr = usd * USD_TO_INR;

  if (inr >= 1) {
    return `₹${inr.toFixed(2)}`;
  }

  // Sub-rupee: show as paise (1 rupee = 100 paise)
  const paise = inr * 100;
  return `₹${paise.toFixed(1)}p`;
}
