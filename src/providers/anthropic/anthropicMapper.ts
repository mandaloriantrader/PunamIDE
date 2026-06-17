/**
 * anthropicMapper.ts — Bidirectional mapping between PunamIDE format and Anthropic Messages API.
 *
 * PunamIDE AIRequest → Anthropic request body
 * Anthropic response → PunamIDE AIResponse
 */

import type { AIRequest, AIResponse, ResponseMetrics } from "../../utils/providers";
import type {
  AnthropicMessagesRequest,
  AnthropicMessagesResponse,
  AnthropicContentBlock,
  AnthropicUsage,
} from "./anthropicTypes";

// ── Request Mapping ───────────────────────────────────────────────────────────

/**
 * Convert PunamIDE's AIRequest into the Anthropic Messages API request body.
 */
export function mapRequestToAnthropic(
  request: AIRequest,
  model: string,
  stream: boolean,
): AnthropicMessagesRequest {
  // Build user content blocks
  const userContent: AnthropicContentBlock[] = [
    { type: "text", text: request.userPrompt },
  ];

  // Append images if present (Anthropic vision format)
  if (request.images && request.images.length > 0) {
    for (const img of request.images) {
      userContent.push({
        type: "image",
        source: {
          type: "base64",
          media_type: img.mimeType,
          data: img.base64,
        },
      });
    }
  }

  return {
    model,
    max_tokens: request.maxTokens || 16384,
    system: request.systemPrompt || undefined,
    messages: [{ role: "user", content: userContent }],
    temperature: request.temperature ?? 0.3,
    stream,
  };
}

// ── Response Mapping ──────────────────────────────────────────────────────────

/**
 * Convert a non-streaming Anthropic response into PunamIDE's AIResponse.
 */
export function mapAnthropicResponse(
  response: AnthropicMessagesResponse,
  providerName: string,
  model: string,
  durationMs: number,
): AIResponse {
  // Extract all text blocks and concatenate
  const textContent = response.content
    .filter((block): block is { type: "text"; text: string } => block.type === "text")
    .map((block) => block.text)
    .join("");

  return {
    text: textContent,
    success: true,
    metrics: buildAnthropicMetrics(
      providerName,
      model,
      response.usage,
      durationMs,
      "success",
    ),
  };
}

/**
 * Build ResponseMetrics from Anthropic usage data (exact tokens, not estimated).
 */
export function buildAnthropicMetrics(
  providerName: string,
  model: string,
  usage: AnthropicUsage | null,
  durationMs: number,
  status: ResponseMetrics["status"],
): ResponseMetrics {
  const promptTokens = usage?.input_tokens ?? 0;
  const responseTokens = usage?.output_tokens ?? 0;
  const totalTokens = promptTokens + responseTokens;

  const pricing = getClaudePricing(model);
  const estimatedCostUsd = pricing
    ? (promptTokens / 1_000_000) * pricing.inputPerMillion +
      (responseTokens / 1_000_000) * pricing.outputPerMillion
    : undefined;

  return {
    provider: providerName,
    model,
    promptTokens,
    responseTokens,
    totalTokens,
    estimatedCostUsd,
    estimatedCostInr: estimatedCostUsd ? estimatedCostUsd * 83 : undefined,
    durationMs,
    status,
  };
}

// ── Claude Model Pricing ──────────────────────────────────────────────────────

interface ClaudePricing {
  inputPerMillion: number;
  outputPerMillion: number;
}

const CLAUDE_PRICING: Array<{ match: RegExp; pricing: ClaudePricing }> = [
  { match: /claude-opus-4/i, pricing: { inputPerMillion: 15.00, outputPerMillion: 75.00 } },
  { match: /claude-sonnet-4/i, pricing: { inputPerMillion: 3.00, outputPerMillion: 15.00 } },
  { match: /claude-3[._-]5-sonnet/i, pricing: { inputPerMillion: 3.00, outputPerMillion: 15.00 } },
  { match: /claude-3[._-]5-haiku/i, pricing: { inputPerMillion: 0.80, outputPerMillion: 4.00 } },
  { match: /claude-3-opus/i, pricing: { inputPerMillion: 15.00, outputPerMillion: 75.00 } },
  { match: /claude-3-sonnet/i, pricing: { inputPerMillion: 3.00, outputPerMillion: 15.00 } },
  { match: /claude-3-haiku/i, pricing: { inputPerMillion: 0.25, outputPerMillion: 1.25 } },
];

function getClaudePricing(model: string): ClaudePricing | null {
  return CLAUDE_PRICING.find((entry) => entry.match.test(model))?.pricing ?? null;
}
