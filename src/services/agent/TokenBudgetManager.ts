/**
 * Token Budget Manager
 *
 * Manages token budget allocation across system prompt, user message,
 * code context, and response reserve categories. Provides validation,
 * progressive trimming, and history summarization to keep context
 * within model limits.
 */

import { getModelContextLimit } from "../intelligence/contextLimits";
import type { ContextSlot } from "../intelligence/contextTypes";

// ---------------------------------------------------------------------------
// Interfaces
// ---------------------------------------------------------------------------

export interface BudgetAllocation {
  /** 15% of model context */
  systemPrompt: number;
  /** 10% of model context */
  userMessage: number;
  /** 50% of model context */
  codeContext: number;
  /** 25% of model context */
  responseReserve: number;
  /** Model context limit */
  totalAvailable: number;
}

export interface BudgetStatus {
  allocation: BudgetAllocation;
  used: {
    systemPrompt: number;
    userMessage: number;
    codeContext: number;
    conversationHistory: number;
  };
  remaining: {
    codeContext: number;
    total: number;
  };
  percentUsed: number;
  overBudget: boolean;
}

export interface TrimAction {
  slotId: string;
  action: "remove" | "truncate" | "summarize";
  tokensSaved: number;
}

export interface ChatMessage {
  role: "user" | "assistant" | "system";
  content: string;
}

// ---------------------------------------------------------------------------
// TokenBudgetManager
// ---------------------------------------------------------------------------

export class TokenBudgetManager {
  private model: string;
  private allocation: BudgetAllocation;

  constructor(model: string) {
    const limit = getModelContextLimit(model);
    this.model = model;
    this.allocation = {
      systemPrompt: Math.floor(limit * 0.15),
      userMessage: Math.floor(limit * 0.10),
      codeContext: Math.floor(limit * 0.50),
      responseReserve: Math.floor(limit * 0.25),
      totalAvailable: limit,
    };
  }

  /** Returns the current budget allocation. */
  getAllocation(): BudgetAllocation {
    return { ...this.allocation };
  }

  /**
   * Estimates the number of tokens in a text string.
   *
   * Uses word count / 0.75 heuristic (rounded up).
   * Returns 0 for empty or whitespace-only text.
   */
  estimateTokens(text: string): number {
    if (!text || text.trim().length === 0) return 0;
    const words = text.split(/\s+/).filter((w) => w.length > 0);
    return Math.ceil(words.length / 0.75);
  }

  /**
   * Validates token usage against budget and trims context slots if needed.
   *
   * If code context exceeds its allocation, progressiveTrim is called
   * to remove lowest-relevance slots until the budget is satisfied.
   */
  validateAndTrim(params: {
    systemPrompt: string;
    userMessage: string;
    contextSlots: ContextSlot[];
    conversationHistory: ChatMessage[];
  }): { slots: ContextSlot[]; trimActions: TrimAction[]; status: BudgetStatus } {
    const systemTokens = this.estimateTokens(params.systemPrompt);
    const userTokens = this.estimateTokens(params.userMessage);
    const historyTokens = params.conversationHistory.reduce(
      (sum, msg) => sum + this.estimateTokens(msg.content),
      0
    );

    let slots = [...params.contextSlots];
    let trimActions: TrimAction[] = [];

    // Calculate total context tokens
    const contextTokens = slots.reduce((sum, slot) => sum + slot.tokenCount, 0);

    // If code context exceeds budget, progressively trim
    if (contextTokens > this.allocation.codeContext) {
      const result = this.progressiveTrim(slots, this.allocation.codeContext);
      slots = result.trimmed;
      trimActions = result.actions;
    }

    const finalContextTokens = slots.reduce((sum, slot) => sum + slot.tokenCount, 0);

    const status = this.getStatus({
      systemPrompt: params.systemPrompt,
      userMessage: params.userMessage,
      contextTokens: finalContextTokens,
      historyTokens,
    });

    return { slots, trimActions, status };
  }

  /**
   * Computes the current budget status given token usage for each category.
   */
  getStatus(params: {
    systemPrompt: string;
    userMessage: string;
    contextTokens: number;
    historyTokens: number;
  }): BudgetStatus {
    const systemTokens = this.estimateTokens(params.systemPrompt);
    const userTokens = this.estimateTokens(params.userMessage);

    const totalUsed =
      systemTokens + userTokens + params.contextTokens + params.historyTokens;
    const totalBudget =
      this.allocation.totalAvailable - this.allocation.responseReserve;

    const remainingContext = Math.max(
      0,
      this.allocation.codeContext - params.contextTokens
    );
    const remainingTotal = Math.max(0, totalBudget - totalUsed);

    const percentUsed =
      totalBudget > 0 ? Math.round((totalUsed / totalBudget) * 100) : 0;

    return {
      allocation: { ...this.allocation },
      used: {
        systemPrompt: systemTokens,
        userMessage: userTokens,
        codeContext: params.contextTokens,
        conversationHistory: params.historyTokens,
      },
      remaining: {
        codeContext: remainingContext,
        total: remainingTotal,
      },
      percentUsed,
      overBudget: totalUsed > totalBudget,
    };
  }

  /**
   * Progressively trims context slots by removing the least relevant
   * slots until the total token count fits within maxTokens.
   *
   * 1. Sort slots by relevanceScore ascending (least relevant first)
   * 2. Calculate total tokens
   * 3. Remove lowest-relevance slots until within budget
   */
  private progressiveTrim(
    slots: ContextSlot[],
    maxTokens: number
  ): { trimmed: ContextSlot[]; actions: TrimAction[] } {
    const actions: TrimAction[] = [];

    // Sort by relevance ascending (least relevant first for removal)
    const sorted = [...slots].sort(
      (a, b) => a.relevanceScore - b.relevanceScore
    );

    let totalTokens = sorted.reduce((sum, slot) => sum + slot.tokenCount, 0);

    const removed = new Set<string>();

    for (const slot of sorted) {
      if (totalTokens <= maxTokens) break;

      // Only remove evictable slots
      if (!slot.evictable) continue;

      totalTokens -= slot.tokenCount;
      removed.add(slot.id);
      actions.push({
        slotId: slot.id,
        action: "remove",
        tokensSaved: slot.tokenCount,
      });
    }

    const trimmed = slots.filter((slot) => !removed.has(slot.id));
    return { trimmed, actions };
  }

  /**
   * Summarizes conversation history to fit within a token budget.
   *
   * Strategy:
   * - Keep the last 3 messages verbatim
   * - Concatenate older messages and truncate to fit remaining budget
   *
   * Note: Uses simple concatenation/truncation as a fallback.
   * AI-powered summarization can be added later.
   */
  async summarizeHistory(
    messages: ChatMessage[],
    maxTokens: number
  ): Promise<{ summarized: string; tokenCount: number }> {
    if (messages.length === 0) {
      return { summarized: "", tokenCount: 0 };
    }

    // Keep last 3 messages verbatim
    const keepCount = Math.min(3, messages.length);
    const recentMessages = messages.slice(-keepCount);
    const olderMessages = messages.slice(0, -keepCount);

    // Calculate tokens for recent messages
    const recentText = recentMessages
      .map((m) => `[${m.role}]: ${m.content}`)
      .join("\n");
    const recentTokens = this.estimateTokens(recentText);

    // If no older messages, just return recent
    if (olderMessages.length === 0) {
      return { summarized: recentText, tokenCount: recentTokens };
    }

    // Budget remaining for older message summary
    const remainingBudget = Math.max(0, maxTokens - recentTokens);

    if (remainingBudget === 0) {
      return { summarized: recentText, tokenCount: recentTokens };
    }

    // Concatenate older messages
    const olderText = olderMessages
      .map((m) => `[${m.role}]: ${m.content}`)
      .join("\n");

    // Truncate older text to fit within remaining budget
    const words = olderText.split(/\s+/).filter((w) => w.length > 0);
    const maxWords = Math.floor(remainingBudget * 0.75); // inverse of token estimation
    const truncatedWords = words.slice(0, maxWords);
    const truncatedOlderText = truncatedWords.join(" ");

    const finalText = truncatedOlderText
      ? `${truncatedOlderText}\n---\n${recentText}`
      : recentText;

    const finalTokenCount = this.estimateTokens(finalText);

    return { summarized: finalText, tokenCount: finalTokenCount };
  }
}
