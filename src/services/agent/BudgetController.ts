/**
 * BudgetController.ts — Per-Task Budget Enforcement
 *
 * Tracks token consumption and estimated cost per agent round,
 * checks limits before each round, and triggers configurable responses
 * (stop, warn, downgrade) when approaching thresholds.
 *
 * Usage:
 *   const controller = new BudgetController(budget, 'claude-sonnet-4');
 *   controller.recordRound({ inputTokens: 1200, outputTokens: 800, model: 'claude-sonnet-4' });
 *   const status = controller.checkBudget(); // 'ok' | 'warning' | 'critical' | 'exceeded'
 */

import { estimateCostUsd, formatCostInr } from "./ModelCostRegistry";

// ── Types ──────────────────────────────────────────────────────────────────────

/** Strategy to apply when budget thresholds are reached. */
export type BudgetStrategy = "stop" | "warn_continue" | "summarize" | "downgrade";

/** Current budget status relative to configured thresholds. */
export type BudgetStatus = "ok" | "warning" | "critical" | "exceeded";

/** Configuration for per-task budget limits. */
export interface TokenBudget {
  /** Maximum total tokens (input + output) allowed. */
  maxTokens?: number;
  /** Maximum estimated cost in USD allowed. */
  maxCostUsd?: number;
  /** Percentage at which to trigger a warning (default 0.80). */
  warningThresholdPct: number;
  /** Percentage at which to hard-stop (default 0.95). */
  hardLimitPct: number;
  /** Strategy to apply when limits are approached. */
  strategy: BudgetStrategy;
  /** Model to downgrade to when strategy is 'downgrade'. */
  downgradeModel?: string;
}

/** Cumulative consumption tracked by BudgetController. */
export interface BudgetConsumed {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  estimatedCostUsd: number;
  rounds: number;
}

/** Remaining budget capacity. */
export interface BudgetRemaining {
  tokensRemaining: number | undefined;
  costRemainingUsd: number | undefined;
  percentageUsed: number;
}

/** Token metrics for a single agent round. */
export interface RoundMetrics {
  inputTokens: number;
  outputTokens: number;
  model: string;
}

// ── BudgetController ───────────────────────────────────────────────────────────

/**
 * Per-task budget controller. Tracks consumption across rounds,
 * evaluates status against thresholds, and signals when action is needed.
 */
export class BudgetController {
  private budget: TokenBudget;
  private model: string;
  private warningFired = false;

  private consumed: BudgetConsumed = {
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    estimatedCostUsd: 0,
    rounds: 0,
  };

  constructor(budget: TokenBudget, model: string) {
    this.budget = budget;
    this.model = model;
  }

  /**
   * Record token consumption from a completed round.
   * Updates cumulative totals and increments round count.
   */
  recordRound(metrics: RoundMetrics): void {
    this.consumed.inputTokens += metrics.inputTokens;
    this.consumed.outputTokens += metrics.outputTokens;
    this.consumed.totalTokens += metrics.inputTokens + metrics.outputTokens;
    this.consumed.estimatedCostUsd += estimateCostUsd(
      metrics.inputTokens,
      metrics.outputTokens,
      metrics.model,
    );
    this.consumed.rounds += 1;
  }

  /**
   * Evaluate current budget status against configured thresholds.
   * Checks both token and cost limits independently, using the higher percentage.
   *
   * Returns:
   *  - 'exceeded' if >= hardLimitPct (0.95)
   *  - 'critical' if >= warningThresholdPct (0.80) and warning already fired
   *  - 'warning' if >= warningThresholdPct (0.80) and warning not yet fired
   *  - 'ok' otherwise
   */
  checkBudget(): BudgetStatus {
    const percentageUsed = this.calculatePercentageUsed();

    if (percentageUsed >= this.budget.hardLimitPct) {
      return "exceeded";
    }

    if (percentageUsed >= this.budget.warningThresholdPct) {
      if (this.warningFired) {
        return "critical";
      }
      return "warning";
    }

    return "ok";
  }

  /**
   * Mark that a warning has been fired so subsequent checks return 'critical'
   * instead of repeated 'warning' statuses.
   */
  markWarningFired(): void {
    this.warningFired = true;
  }

  /** Get cumulative consumption data. */
  getConsumed(): BudgetConsumed {
    return { ...this.consumed };
  }

  /** Get remaining budget capacity. */
  getRemaining(): BudgetRemaining {
    const percentageUsed = this.calculatePercentageUsed();

    const tokensRemaining =
      this.budget.maxTokens !== undefined
        ? Math.max(0, this.budget.maxTokens - this.consumed.totalTokens)
        : undefined;

    const costRemainingUsd =
      this.budget.maxCostUsd !== undefined
        ? Math.max(0, this.budget.maxCostUsd - this.consumed.estimatedCostUsd)
        : undefined;

    return {
      tokensRemaining,
      costRemainingUsd,
      percentageUsed,
    };
  }

  /**
   * Human-readable summary of task consumption.
   * Format: "Completed X rounds, used Y tokens (₹Z.ZZ)"
   */
  getSummary(): string {
    const costDisplay = formatCostInr(this.consumed.estimatedCostUsd);
    return `Completed ${this.consumed.rounds} rounds, used ${this.consumed.totalTokens} tokens (${costDisplay})`;
  }

  /**
   * Whether the controller recommends a model downgrade.
   * True only when strategy is 'downgrade', a downgradeModel is configured,
   * and current status is at warning level.
   */
  shouldDowngrade(): boolean {
    if (this.budget.strategy !== "downgrade") return false;
    if (!this.budget.downgradeModel) return false;

    const status = this.checkBudget();
    return status === "warning" || status === "critical";
  }

  // ── Private Helpers ────────────────────────────────────────────────────────

  /**
   * Calculate the higher of token percentage or cost percentage used.
   * If neither limit is set, returns 0 (no budget enforcement).
   */
  private calculatePercentageUsed(): number {
    let tokenPct = 0;
    let costPct = 0;

    if (this.budget.maxTokens !== undefined && this.budget.maxTokens > 0) {
      tokenPct = this.consumed.totalTokens / this.budget.maxTokens;
    }

    if (this.budget.maxCostUsd !== undefined && this.budget.maxCostUsd > 0) {
      costPct = this.consumed.estimatedCostUsd / this.budget.maxCostUsd;
    }

    return Math.max(tokenPct, costPct);
  }
}
