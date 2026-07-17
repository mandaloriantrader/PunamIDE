/**
 * @phase P6
 * @purpose Tracks dismissed/accepted findings to tune noise over time.
 *          Logs per-team feedback: which findings were accepted, dismissed,
 *          or acted upon. Computes noise metrics and suggests rule tuning.
 *          Track from day one even if the auto-tuning logic comes later.
 */

import { type FindingSource, type Severity } from './types';

/** A single feedback entry for a finding. */
export interface FeedbackEntry {
  findingId: string;
  action: 'accepted' | 'dismissed' | 'acted_on';
  userId: string;
  timestamp: string;
  reason?: string;
  /** Metadata about the finding for analysis without re-fetching. */
  findingSource?: FindingSource;
  findingSeverity?: Severity;
  findingRuleId?: string;
}

/** Noise metrics for a specific source/rule/severity. */
export interface NoiseMetrics {
  total: number;
  accepted: number;
  dismissed: number;
  actedOn: number;
  dismissalRate: number;
}

/** Report on which rules/sources produce the most noise. */
export interface NoiseReport {
  perSource: Record<string, NoiseMetrics>;
  perSeverity: Record<string, NoiseMetrics>;
  perRule: Record<string, NoiseMetrics>;
  overallDismissalRate: number;
  generatedAt: string;
}

/** Suggestion to tune a rule based on dismissal patterns. */
export interface RuleTuningSuggestion {
  ruleId: string;
  source: FindingSource;
  currentDismissalRate: number;
  recommendation: 'disable' | 'reduce_severity' | 'rescope' | 'keep';
  reason: string;
}

/** Storage interface for feedback (inject for testability). */
export interface FeedbackStorageInterface {
  save(entry: FeedbackEntry): Promise<void>;
  getAll(): Promise<FeedbackEntry[]>;
  getByFinding(findingId: string): Promise<FeedbackEntry[]>;
  getBySource(source: FindingSource): Promise<FeedbackEntry[]>;
}

/**
 * Tracks dismissed/accepted findings to tune noise over time.
 * This is the mechanism competitive tools use to reduce false-positive
 * fatigue over time — track it from day one even if the tuning logic
 * comes later.
 */
export class ReviewFeedbackLoop {
  private storage: FeedbackStorageInterface;
  constructor(storage: FeedbackStorageInterface) {
    this.storage = storage;
  }

  /**
   * Records feedback for a finding.
   */
  async recordFeedback(entry: FeedbackEntry): Promise<void> {
    await this.storage.save(entry);
  }

  /**
   * Computes noise metrics from all recorded feedback.
   */
  async getNoiseReport(): Promise<NoiseReport> {
    const allFeedback = await this.storage.getAll();

    const perSource: Record<string, NoiseMetrics> = {};
    const perSeverity: Record<string, NoiseMetrics> = {};
    const perRule: Record<string, NoiseMetrics> = {};

    let totalDismissed = 0;
    let totalEntries = 0;

    for (const entry of allFeedback) {
      totalEntries++;

      // Track by source
      if (entry.findingSource) {
        const sourceKey = entry.findingSource;
        if (!perSource[sourceKey]) {
          perSource[sourceKey] = { total: 0, accepted: 0, dismissed: 0, actedOn: 0, dismissalRate: 0 };
        }
        perSource[sourceKey].total++;
        if (entry.action === 'accepted') perSource[sourceKey].accepted++;
        if (entry.action === 'dismissed') { perSource[sourceKey].dismissed++; totalDismissed++; }
        if (entry.action === 'acted_on') perSource[sourceKey].actedOn++;
      }

      // Track by severity
      if (entry.findingSeverity) {
        const sevKey = entry.findingSeverity;
        if (!perSeverity[sevKey]) {
          perSeverity[sevKey] = { total: 0, accepted: 0, dismissed: 0, actedOn: 0, dismissalRate: 0 };
        }
        perSeverity[sevKey].total++;
        if (entry.action === 'accepted') perSeverity[sevKey].accepted++;
        if (entry.action === 'dismissed') perSeverity[sevKey].dismissed++;
        if (entry.action === 'acted_on') perSeverity[sevKey].actedOn++;
      }

      // Track by rule
      if (entry.findingRuleId) {
        const ruleKey = entry.findingRuleId;
        if (!perRule[ruleKey]) {
          perRule[ruleKey] = { total: 0, accepted: 0, dismissed: 0, actedOn: 0, dismissalRate: 0 };
        }
        perRule[ruleKey].total++;
        if (entry.action === 'accepted') perRule[ruleKey].accepted++;
        if (entry.action === 'dismissed') perRule[ruleKey].dismissed++;
        if (entry.action === 'acted_on') perRule[ruleKey].actedOn++;
      }
    }

    // Compute dismissal rates
    for (const metrics of Object.values(perSource)) {
      metrics.dismissalRate = metrics.total > 0 ? metrics.dismissed / metrics.total : 0;
    }
    for (const metrics of Object.values(perSeverity)) {
      metrics.dismissalRate = metrics.total > 0 ? metrics.dismissed / metrics.total : 0;
    }
    for (const metrics of Object.values(perRule)) {
      metrics.dismissalRate = metrics.total > 0 ? metrics.dismissed / metrics.total : 0;
    }

    return {
      perSource,
      perSeverity,
      perRule,
      overallDismissalRate: totalEntries > 0 ? totalDismissed / totalEntries : 0,
      generatedAt: new Date().toISOString(),
    };
  }

  /**
   * Suggests which rules to disable or re-scope based on dismissal patterns.
   */
  async getRuleTuningSuggestions(): Promise<RuleTuningSuggestion[]> {
    const report = await this.getNoiseReport();
    const suggestions: RuleTuningSuggestion[] = [];

    for (const [ruleId, metrics] of Object.entries(report.perRule)) {
      // Need at least 5 data points to make a recommendation
      if (metrics.total < 5) continue;

      let recommendation: RuleTuningSuggestion['recommendation'] = 'keep';
      let reason = 'Dismissal rate is within acceptable range.';

      if (metrics.dismissalRate > 0.8) {
        recommendation = 'disable';
        reason = `${Math.round(metrics.dismissalRate * 100)}% dismissal rate — this rule produces mostly noise.`;
      } else if (metrics.dismissalRate > 0.6) {
        recommendation = 'reduce_severity';
        reason = `${Math.round(metrics.dismissalRate * 100)}% dismissal rate — consider reducing severity to reduce alert fatigue.`;
      } else if (metrics.dismissalRate > 0.4) {
        recommendation = 'rescope';
        reason = `${Math.round(metrics.dismissalRate * 100)}% dismissal rate — consider narrowing the rule scope.`;
      }

      suggestions.push({
        ruleId,
        source: 'review-agent', // Would be determined from the actual finding
        currentDismissalRate: metrics.dismissalRate,
        recommendation,
        reason,
      });
    }

    return suggestions;
  }
}

// ── Singleton pattern (follows existing codebase convention) ───────
let instance: ReviewFeedbackLoop | null = null;

export function getReviewFeedbackLoop(): ReviewFeedbackLoop {
  if (!instance) throw new Error('ReviewFeedbackLoop not initialized. Call initReviewFeedbackLoop() first.');
  return instance;
}

export function initReviewFeedbackLoop(storage: FeedbackStorageInterface): ReviewFeedbackLoop {
  instance = new ReviewFeedbackLoop(storage);
  return instance;
}
