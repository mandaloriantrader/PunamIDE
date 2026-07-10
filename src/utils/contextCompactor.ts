/**
 * Context Compactor — Auto-compact conversation and agent context
 * when approaching token budget limits.
 *
 * Inspired by Cline's Auto-Compact feature:
 *   - Monitors token usage per iteration
 *   - When > threshold% of budget consumed, summarizes older context
 *   - Preserves: decisions, file changes, errors, and recent 3 exchanges
 *   - Discards: verbose tool outputs, old file content dumps, repetitive logs
 *
 * Two modes:
 *   1. Chat compaction — for long chat sessions (used by AiChat)
 *   2. Agent compaction — for background agent multi-attempt sessions
 */

import type { ChatMessage } from "../types";
import { estimateTokens } from "./providers";

// ── Configuration ──────────────────────────────────────────────────────────────

/** Default token budget (conservative — works for most models) */
const DEFAULT_TOKEN_BUDGET = 120_000;

/** Compact when estimated context exceeds this fraction of budget */
const COMPACTION_THRESHOLD = 0.75;

/** Number of recent messages to preserve in full detail */
const PRESERVE_RECENT_COUNT = 3;

/** Max chars for a compacted summary */
const MAX_SUMMARY_CHARS = 2000;

// ── Types ──────────────────────────────────────────────────────────────────────

export interface CompactionResult {
  /** Whether compaction was performed */
  compacted: boolean;
  /** The compacted context string (replaces old history) */
  summary: string;
  /** Estimated tokens saved */
  tokensSaved: number;
  /** Current estimated tokens after compaction */
  tokensAfter: number;
}

export interface AgentAttemptContext {
  attempt: number;
  task: string;
  filesWritten: string[];
  commandsRun: Array<{ command: string; success: boolean }>;
  errors: string[];
  outcome: "success" | "failed" | "partial";
}

// ── Chat Context Compaction ───────────────────────────────────────────────────

/**
 * Check if chat context needs compaction and perform it if so.
 *
 * Call this before building the LLM payload. If the message history
 * is approaching token limits, this produces a compressed summary
 * of older messages while preserving the most recent exchanges.
 *
 * @param messages - Full chat message history
 * @param systemPromptTokens - Estimated tokens in the system prompt
 * @param tokenBudget - Model's context window (default 120k)
 * @returns CompactionResult with summary if compaction happened
 */
export function compactChatContext(
  messages: ChatMessage[],
  systemPromptTokens: number = 0,
  tokenBudget: number = DEFAULT_TOKEN_BUDGET,
): CompactionResult {
  // Estimate total tokens in current history
  const historyText = messages.map(m => m.content).join("\n");
  const historyTokens = estimateTokens(historyText);
  const totalTokens = systemPromptTokens + historyTokens;

  // Check if we need compaction
  if (totalTokens < tokenBudget * COMPACTION_THRESHOLD || messages.length <= PRESERVE_RECENT_COUNT + 1) {
    return { compacted: false, summary: "", tokensSaved: 0, tokensAfter: totalTokens };
  }

  // Split: old messages to compress, recent messages to keep
  const oldMessages = messages.slice(0, -PRESERVE_RECENT_COUNT);
  const recentMessages = messages.slice(-PRESERVE_RECENT_COUNT);

  // Build summary of old messages
  const summary = summarizeChatMessages(oldMessages);
  const summaryTokens = estimateTokens(summary);
  const recentTokens = estimateTokens(recentMessages.map(m => m.content).join("\n"));
  const tokensAfter = systemPromptTokens + summaryTokens + recentTokens;
  const tokensSaved = totalTokens - tokensAfter;

  return {
    compacted: true,
    summary,
    tokensSaved: Math.max(0, tokensSaved),
    tokensAfter,
  };
}

/**
 * Summarize a list of chat messages into a compact context string.
 * Preserves: user intents, file changes, commands run, key decisions.
 * Discards: verbose explanations, full file contents, tool output details.
 */
function summarizeChatMessages(messages: ChatMessage[]): string {
  const parts: string[] = [];
  parts.push("=== CONVERSATION HISTORY (compacted) ===");

  let fileChanges: string[] = [];
  let commandsRun: string[] = [];
  let userRequests: string[] = [];
  let decisions: string[] = [];

  for (const msg of messages) {
    if (msg.role === "user") {
      // Keep a short version of user requests
      const short = msg.content.slice(0, 120).replace(/\n/g, " ");
      userRequests.push(short);
    } else {
      // Extract file changes
      if (msg.parsed?.fileChanges) {
        for (const fc of msg.parsed.fileChanges) {
          fileChanges.push(`${fc.isNew ? "created" : "edited"} ${fc.path}`);
        }
      }
      // Extract commands
      if (msg.parsed?.commands) {
        commandsRun.push(...msg.parsed.commands.map(c => c.slice(0, 60)));
      }
      // Extract key decisions from thinking
      if (msg.thinking) {
        const decisionMatch = msg.thinking.match(/(?:decided|approach|strategy|plan)[:.]?\s*(.{20,100})/i);
        if (decisionMatch) decisions.push(decisionMatch[1].trim());
      }
    }
  }

  if (userRequests.length > 0) {
    parts.push(`\nUser requests (${userRequests.length}):`);
    // Keep last 5 requests in detail, summarize the rest
    const shown = userRequests.slice(-5);
    if (userRequests.length > 5) {
      parts.push(`  ... ${userRequests.length - 5} earlier requests omitted`);
    }
    for (const req of shown) {
      parts.push(`  - ${req}`);
    }
  }

  if (fileChanges.length > 0) {
    const unique = [...new Set(fileChanges)];
    parts.push(`\nFiles modified (${unique.length}):`);
    for (const fc of unique.slice(0, 15)) {
      parts.push(`  - ${fc}`);
    }
    if (unique.length > 15) parts.push(`  ... and ${unique.length - 15} more`);
  }

  if (commandsRun.length > 0) {
    const unique = [...new Set(commandsRun)];
    parts.push(`\nCommands executed (${unique.length}):`);
    for (const cmd of unique.slice(0, 8)) {
      parts.push(`  - ${cmd}`);
    }
  }

  if (decisions.length > 0) {
    parts.push(`\nKey decisions:`);
    for (const d of decisions.slice(0, 5)) {
      parts.push(`  - ${d}`);
    }
  }

  parts.push("\n=== END COMPACTED HISTORY ===");

  const result = parts.join("\n");
  return result.slice(0, MAX_SUMMARY_CHARS);
}

// ── Agent Session Compaction ──────────────────────────────────────────────────

/**
 * Compact context for a multi-attempt background agent session.
 *
 * Instead of feeding the full history of all previous attempts to the model,
 * this produces a compressed summary: what worked, what failed, what files
 * were already modified.
 *
 * Call this before building the prompt for attempt N > 2.
 */
export function compactAgentAttempts(
  attempts: AgentAttemptContext[],
): string {
  if (attempts.length === 0) return "";
  if (attempts.length === 1) {
    // Single attempt — just report what happened
    const a = attempts[0];
    if (a.outcome === "success") return "";
    return `Previous attempt failed: ${a.errors.slice(0, 2).join("; ")}`;
  }

  // Multiple attempts — produce compressed summary
  const parts: string[] = [];
  parts.push("=== PREVIOUS ATTEMPTS (compacted) ===");

  const totalAttempts = attempts.length;
  const successfulFiles = new Set<string>();
  const failedCommands: string[] = [];
  const persistentErrors: string[] = [];

  for (const attempt of attempts) {
    for (const file of attempt.filesWritten) {
      successfulFiles.add(file);
    }
    for (const cmd of attempt.commandsRun) {
      if (!cmd.success) failedCommands.push(cmd.command);
    }
    for (const err of attempt.errors) {
      if (!persistentErrors.includes(err)) persistentErrors.push(err);
    }
  }

  parts.push(`Attempts so far: ${totalAttempts}`);

  if (successfulFiles.size > 0) {
    parts.push(`Files already written: ${[...successfulFiles].join(", ")}`);
  }

  if (failedCommands.length > 0) {
    const unique = [...new Set(failedCommands)];
    parts.push(`Commands that failed: ${unique.slice(0, 5).join("; ")}`);
  }

  if (persistentErrors.length > 0) {
    parts.push(`Errors encountered:`);
    for (const err of persistentErrors.slice(0, 3)) {
      parts.push(`  - ${err.slice(0, 150)}`);
    }
  }

  // Include the last attempt's outcome in detail
  const last = attempts[attempts.length - 1];
  if (last.outcome === "failed" && last.errors.length > 0) {
    parts.push(`\nMost recent failure: ${last.errors[0].slice(0, 200)}`);
  }

  parts.push("=== END PREVIOUS ATTEMPTS ===");
  parts.push("\nIMPORTANT: Do NOT repeat the same approach. Try something different.");

  return parts.join("\n");
}

/**
 * Estimate whether the current context payload will exceed the model's budget.
 * Returns the fraction of budget used (0.0 to 1.0+).
 */
export function estimateBudgetUsage(
  systemPrompt: string,
  contextBlock: string,
  recentMessages: string[],
  tokenBudget: number = DEFAULT_TOKEN_BUDGET,
): number {
  const totalChars = systemPrompt.length + contextBlock.length + recentMessages.join("").length;
  const estimatedTokens = estimateTokens(totalChars.toString()) || Math.ceil(totalChars / 4);
  return estimatedTokens / tokenBudget;
}

// ── Exports ───────────────────────────────────────────────────────────────────

export { DEFAULT_TOKEN_BUDGET, COMPACTION_THRESHOLD, PRESERVE_RECENT_COUNT };
