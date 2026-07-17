/**
 * @phase P8
 * @purpose Produces human-readable benchmark reports. Given a
 *          BenchmarkResult, produces a markdown report suitable for
 *          internal publishing before any external "standalone product"
 *          claim.
 */

import type { BenchmarkResult, PerLayerResult, BenchmarkHistory } from './BenchmarkRunner';

/**
 * Generates benchmark reports in markdown format.
 */
export class BenchmarkReporter {
  /**
   * Generates a full markdown report from a benchmark result.
   *
   * @param result - The benchmark result
   * @param history - Optional history for trend analysis
   * @returns Markdown report string
   */
  generateReport(result: BenchmarkResult, history?: BenchmarkHistory): string {
    const sections: string[] = [];

    // ── Executive Summary ──────────────────────────────────────
    sections.push('# Benchmark Report');
    sections.push('');
    sections.push('## Executive Summary');
    sections.push('');
    sections.push(`| Metric | Value |`);
    sections.push(`|--------|-------|`);
    sections.push(`| Dataset | ${result.datasetId} |`);
    sections.push(`| Pipeline Version | ${result.pipelineVersion} |`);
    sections.push(`| Run Date | ${result.runDate} |`);
    sections.push(`| **Recall** | **${(result.recall * 100).toFixed(1)}%** |`);
    sections.push(`| **False Positive Rate** | **${(result.falsePositiveRate * 100).toFixed(1)}%** |`);
    sections.push(`| Total Known Bugs | ${result.totalKnownBugs} |`);
    sections.push(`| Bugs Caught | ${result.bugsCaught} |`);
    sections.push(`| Total Findings | ${result.totalFindings} |`);
    sections.push(`| False Positives | ${result.falsePositives} |`);
    sections.push(`| Fix Conversion Rate | ${(result.fixConversionRate * 100).toFixed(1)}% |`);
    sections.push('');

    // ── Per-Layer Breakdown ────────────────────────────────────
    sections.push('## Per-Layer Breakdown');
    sections.push('');
    sections.push('| Layer | Findings | True Positives | False Positives | Recall | Precision | F1 Score |');
    sections.push('|-------|----------|----------------|-----------------|--------|-----------|----------|');

    for (const layer of result.perLayerResults) {
      sections.push(
        `| ${layer.layer} | ${layer.findings} | ${layer.truePositives} | ${layer.falsePositives} | ` +
        `${(layer.recall * 100).toFixed(1)}% | ${(layer.precision * 100).toFixed(1)}% | ` +
        `${(layer.f1Score * 100).toFixed(1)}% |`
      );
    }
    sections.push('');

    // ── Trends ─────────────────────────────────────────────────
    if (history) {
      const comparison = history.compareLatest();
      if (comparison) {
        sections.push('## Trends');
        sections.push('');
        sections.push('| Metric | Delta | Status |');
        sections.push('|--------|-------|--------|');

        const recallStatus = comparison.recallDelta > 0 ? '✅ Improving' :
          comparison.recallDelta < 0 ? '⚠️ Regressing' : '➖ Stable';
        const fpStatus = comparison.falsePositiveRateDelta < 0 ? '✅ Improving' :
          comparison.falsePositiveRateDelta > 0 ? '⚠️ Regressing' : '➖ Stable';

        sections.push(`| Recall | ${(comparison.recallDelta * 100).toFixed(1)}% | ${recallStatus} |`);
        sections.push(`| False Positive Rate | ${(comparison.falsePositiveRateDelta * 100).toFixed(1)}% | ${fpStatus} |`);
        sections.push('');

        if (comparison.isRegression) {
          sections.push('> ⚠️ **REGRESSION DETECTED** — Recall dropped or FP rate increased significantly.');
          sections.push('> This pipeline change should be reviewed before merging.');
          sections.push('');
        }
      }
    }

    // ── Recommendations ────────────────────────────────────────
    sections.push('## Recommendations');
    sections.push('');
    const recommendations = this.generateRecommendations(result);
    for (const rec of recommendations) {
      sections.push(`- ${rec}`);
    }
    sections.push('');

    // ── Quality Gate ───────────────────────────────────────────
    sections.push('## Quality Gate');
    sections.push('');
    const minRecall = 0.60;
    const maxFP = 0.30;
    const passesRecall = result.recall >= minRecall;
    const passesFP = result.falsePositiveRate <= maxFP;

    sections.push(`| Gate | Threshold | Actual | Pass |`);
    sections.push(`|------|-----------|--------|------|`);
    sections.push(`| Recall ≥ ${(minRecall * 100)}% | ${(minRecall * 100)}% | ${(result.recall * 100).toFixed(1)}% | ${passesRecall ? '✅' : '❌'} |`);
    sections.push(`| FP Rate ≤ ${(maxFP * 100)}% | ${(maxFP * 100)}% | ${(result.falsePositiveRate * 100).toFixed(1)}% | ${passesFP ? '✅' : '❌'} |`);
    sections.push('');

    if (passesRecall && passesFP) {
      sections.push('> ✅ **Quality gate PASSED** — Pipeline meets minimum accuracy requirements.');
    } else {
      sections.push('> ❌ **Quality gate FAILED** — Pipeline does not meet minimum accuracy requirements.');
      sections.push('> Do not claim "standalone product" status until both gates pass.');
    }

    return sections.join('\n');
  }

  /**
   * Generates recommendations based on the benchmark result.
   */
  private generateRecommendations(result: BenchmarkResult): string[] {
    const recs: string[] = [];

    // Check recall
    if (result.recall < 0.5) {
      recs.push('⚠️ Recall is below 50% — the pipeline is missing more bugs than it catches. Consider adding new rules or tuning existing ones.');
    } else if (result.recall < 0.7) {
      recs.push('Recall is moderate (50-70%) — there is room for improvement. Focus on the layers with lowest recall.');
    }

    // Check FP rate
    if (result.falsePositiveRate > 0.5) {
      recs.push('⚠️ False positive rate is above 50% — the pipeline is too noisy. Consider tightening rule thresholds or disabling noisy rules.');
    } else if (result.falsePositiveRate > 0.3) {
      recs.push('False positive rate is moderate (30-50%) — consider tuning to reduce noise.');
    }

    // Per-layer recommendations
    for (const layer of result.perLayerResults) {
      if (layer.recall < 0.3 && layer.findings > 0) {
        recs.push(`Layer "${layer.layer}" has low recall (${(layer.recall * 100).toFixed(1)}%) — consider adding more rules or expanding coverage.`);
      }
      if (layer.falsePositives > layer.truePositives * 2 && layer.findings > 5) {
        recs.push(`Layer "${layer.layer}" produces too many false positives (${layer.falsePositives} FP vs ${layer.truePositives} TP) — consider tightening thresholds.`);
      }
    }

    if (recs.length === 0) {
      recs.push('✅ All metrics are within acceptable ranges. No immediate action needed.');
    }

    return recs;
  }
}

// ── Singleton pattern (follows existing codebase convention) ───────
let instance: BenchmarkReporter | null = null;

/**
 * Gets the singleton BenchmarkReporter instance.
 * Every service uses this pattern: `let instance: T | null = null`
 * with an exported `getXxx(): T` getter.
 */
export function getBenchmarkReporter(): BenchmarkReporter {
  if (!instance) instance = new BenchmarkReporter();
  return instance;
}
