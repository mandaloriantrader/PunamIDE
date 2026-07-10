// src/components/chat/services/responseFinalization.ts
//
// Response finalization logic — the repeated pattern of parsing a completed
// response text into stream blocks and assembling the final message shape.
// Used by requestPunam (adaptive, single, agent) and agentProposeFix.

import type { ParsedResponse } from "../../../utils/prompts";
import type { ResponseMetrics } from "../../../utils/providers";
import { parseStreamBlocks, resetParseState } from "../../../utils/streamBlocks";
import type { ChatMessage } from "../../../types";

/**
 * The shape returned by finalization — everything needed to update a message in-place.
 */
export interface FinalizedMessage {
  content: string;
  blocks: ReturnType<typeof parseStreamBlocks>["completed"];
  isComplete: true;
  parsed?: ParsedResponse;
  applied: false;
  metrics?: ResponseMetrics;
}

/**
 * Parse the final response text into stream blocks and produce a finalized message payload.
 * This is the pure data-transformation step — no state mutations.
 */
export function finalizeResponseBlocks(
  text: string,
  opts: {
    parsed?: ParsedResponse | null;
    metrics?: ResponseMetrics;
    existingBlocks?: unknown[];
  } = {}
): FinalizedMessage {
  resetParseState();
  const finalBlocks = parseStreamBlocks(text).completed;
  const blocks = finalBlocks.length > 0 ? finalBlocks : (opts.existingBlocks as FinalizedMessage["blocks"] || []);
  const hasActions = opts.parsed
    ? (opts.parsed.fileChanges.length > 0 || opts.parsed.deletions.length > 0 || opts.parsed.commands.length > 0 || opts.parsed.editOperations.length > 0)
    : false;

  return {
    content: text,
    blocks,
    isComplete: true,
    parsed: hasActions ? opts.parsed! : undefined,
    applied: false,
    metrics: opts.metrics,
  };
}

/**
 * Apply finalization to a streamed message identified by streamId.
 * Returns a new messages array with the target message updated in-place.
 * Pure function — no side effects.
 */
export function applyFinalizationToMessages(
  messages: ChatMessage[],
  streamId: string,
  finalized: FinalizedMessage
): ChatMessage[] {
  return messages.map((m) => {
    if ((m as any).streamId !== streamId) return m;
    const { streamId: _sid, streamProgress: _sp, ...rest } = m as any;
    return {
      ...rest,
      ...finalized,
    };
  });
}

/**
 * Generate a unique stream ID for tracking streaming messages.
 */
export function generateStreamId(): string {
  return `stream-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

// ── Tool trace formatting (used by agentProposeFix tool loop) ────────────────

export interface ToolTraceEntry {
  tool: string;
  input?: Record<string, unknown>;
}

export function formatTraceInput(input?: Record<string, unknown>): string {
  const entries = Object.entries(input || {}).filter(([, value]) => value !== undefined && value !== null && value !== "");
  if (entries.length === 0) return "";
  return `: ${entries.map(([key, value]) => `${key}=${JSON.stringify(value)}`).join(", ")}`;
}

export function formatToolTrace(
  toolTrace: ToolTraceEntry[],
  agentKind: string,
  agentReason: string,
  status = "Running..."
): string {
  return [
    "Agent route",
    `Type: ${agentKind}`,
    `Reason: ${agentReason}`,
    "",
    "Tools used",
    ...(toolTrace.length > 0
      ? toolTrace.map((entry) => `- ${entry.tool}${formatTraceInput(entry.input)}`)
      : ["- Waiting for first tool..."]),
    "",
    `Status: ${status}`,
  ].join("\n");
}
