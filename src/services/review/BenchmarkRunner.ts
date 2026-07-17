/**
 * @phase P8
 * @purpose Accuracy benchmarking — required before any "standalone
 *          product" claim. Runs the full pipeline against benchmark
 *          datasets and tracks recall, false-positive rate, and
 *          findings-to-fix conversion.
 *
 * 119/119 passing unit tests proves the code behaves as designed —
 * it does NOT prove the analysis catches real bugs at acceptable
 * noise levels. These are different claims.
 */

import { type Finding, type UnifiedAnalysisConfig } from './types';
import { type UnifiedAnalysisEngine } from './UnifiedAnalysisEngine';
import { type BenchmarkDataset, type BenchmarkPR, type KnownBug } from './BenchmarkDataset';

/** Per-layer metrics. */
export interface PerLayerResult {
  layer: string;
  findings: number;
  truePositives: number;
  falsePositives: number;
  recall: number;
  precision: number;
  f1Score: number;
}

/** Complete benchmark result for a dataset run. */
export interface BenchmarkResult {
  datasetId: string;
  totalKnownBugs: number;
  bugsCaught: number;
  recall: number;
  totalFindings: number;
  falsePositives: number;
  falsePositiveRate: number;
  findingsActedOn: number;
  fixConversionRate: number;
  perLayerResults: PerLayerResult[];
  runDate: string;
  pipelineVersion: string;
}

/** Matching context for a single PR. */
interface PRMatchResult {
  prId: string;
  findings: Finding[];
  knownBugs: KnownBug[];
  truePositives: Finding[];
  falsePositives: Finding[];
  missedBugs: KnownBug[];
}

/**
 * Runs accuracy benchmarks against datasets.
 *
 * Must be reproducible: same dataset + same pipeline version = same results.
 * Re-run after every major pipeline change as a regression gate.
 */
export class BenchmarkRunner {
  private pipelineVersion: string;

  constructor(pipelineVersion: string = '0.1.0') {
    this.pipelineVersion = pipelineVersion;
  }

  /**
   * Runs the full benchmark against a dataset.
   *
   * @param dataset - The benchmark dataset
   * @param engine - The Unified Analysis Engine (configured with all layers)
   * @param config - Engine configuration
   * @returns Benchmark result with recall, FP rate, and per-layer metrics
   */
  async runBenchmark(
    dataset: BenchmarkDataset,
    engine: UnifiedAnalysisEngine,
    config: UnifiedAnalysisConfig,
  ): Promise<BenchmarkResult> {
    const prResults: PRMatchResult[] = [];

    // Run the pipeline against each PR in the dataset
    for (const pr of dataset.prs) {
      const result = await this.evaluatePR(pr, engine, config);
      prResults.push(result);
    }

    // Aggregate results
    return this.aggregateResults(dataset, prResults);
  }

  /**
   * Evaluates a single PR against the pipeline.
   */
  private async evaluatePR(
    pr: BenchmarkPR,
    engine: UnifiedAnalysisEngine,
    config: UnifiedAnalysisConfig,
  ): Promise<PRMatchResult> {
    // Parse the diff to get changed files
    const changedFiles = this.extractChangedFiles(pr.diff);

    // Run the analysis pipeline on the changed files
    const profiles = await engine.analyzeDiff(changedFiles, config);

    // Collect all findings
    const allFindings: Finding[] = [];
    for (const [, profile] of profiles) {
      allFindings.push(...profile.findings);
    }

    // Match findings against known bugs
    const truePositives: Finding[] = [];
    const falsePositives: Finding[] = [];
    const matchedBugIds = new Set<string>();

    for (const finding of allFindings) {
      const matchedBug = this.matchFindingToBug(finding, pr.knownBugs);
      if (matchedBug) {
        truePositives.push(finding);
        matchedBugIds.add(matchedBug.id);
      } else {
        falsePositives.push(finding);
      }
    }

    const missedBugs = pr.knownBugs.filter(bug => !matchedBugIds.has(bug.id));

    return {
      prId: pr.id,
      findings: allFindings,
      knownBugs: pr.knownBugs,
      truePositives,
      falsePositives,
      missedBugs,
    };
  }

  /**
   * Matches a finding to a known bug.
   *
   * Matching criteria: same file + within 5 lines of the known bug
   * location + same category (security/type/logic).
   */
  private matchFindingToBug(finding: Finding, knownBugs: KnownBug[]): KnownBug | null {
    for (const bug of knownBugs) {
      // Same file
      if (finding.file !== bug.file && !finding.file.endsWith(bug.file)) continue;

      // Within 5 lines
      if (finding.line) {
        if (Math.abs(finding.line - bug.line) > 5) continue;
      }

      // Same category (map finding sources to bug categories)
      const categoryMatch = this.isCategoryMatch(finding.source, bug.category);
      if (!categoryMatch) continue;

      return bug;
    }

    return null;
  }

  /**
   * Maps finding sources to bug categories.
   */
  private isCategoryMatch(source: Finding['source'], category: KnownBug['category']): boolean {
    const mapping: Record<string, string[]> = {
      'security': ['security'],
      'type': ['type', 'null-safety'],
      'debt': ['performance', 'architecture'],
      'architecture': ['architecture'],
      'review-agent': ['logic', 'security', 'type', 'null-safety', 'performance'],
    };

    const validCategories = mapping[source] ?? [];
    return validCategories.includes(category);
  }

  /**
   * Extracts changed file paths from a diff.
   */
  private extractChangedFiles(diff: string): string[] {
    const files: string[] = [];
    const lines = diff.split('\n');

    for (const line of lines) {
      const match = line.match(/^diff --git a\/(.+?) b\/(.+)$/);
      if (match) {
        files.push(match[2]);
      }
    }

    return files;
  }

  /**
   * Aggregates PR-level results into a complete BenchmarkResult.
   */
  private aggregateResults(dataset: BenchmarkDataset, prResults: PRMatchResult[]): BenchmarkResult {
    let totalKnownBugs = 0;
    let bugsCaught = 0;
    let totalFindings = 0;
    let falsePositives = 0;
    let findingsActedOn = 0;

    // Per-layer aggregation
    const layerStats = new Map<string, { tp: number; fp: number; total: number }>();

    for (const prResult of prResults) {
      totalKnownBugs += prResult.knownBugs.length;
      bugsCaught += prResult.truePositives.length;
      totalFindings += prResult.findings.length;
      falsePositives += prResult.falsePositives.length;

      // Track per-layer
      for (const finding of prResult.findings) {
        const layer = finding.source;
        if (!layerStats.has(layer)) {
          layerStats.set(layer, { tp: 0, fp: 0, total: 0 });
        }
        const stats = layerStats.get(layer)!;
        stats.total++;
        if (prResult.truePositives.includes(finding)) {
          stats.tp++;
          findingsActedOn++;
        } else {
          stats.fp++;
        }
      }
    }

    // Compute per-layer results
    const perLayerResults: PerLayerResult[] = [];
    for (const [layer, stats] of layerStats) {
      const recall = stats.tp > 0 ? stats.tp / totalKnownBugs : 0;
      const precision = stats.total > 0 ? stats.tp / stats.total : 0;
      const f1Score = (recall + precision) > 0
        ? 2 * (recall * precision) / (recall + precision)
        : 0;

      perLayerResults.push({
        layer,
        findings: stats.total,
        truePositives: stats.tp,
        falsePositives: stats.fp,
        recall,
        precision,
        f1Score,
      });
    }

    const recall = totalKnownBugs > 0 ? bugsCaught / totalKnownBugs : 0;
    const falsePositiveRate = totalFindings > 0 ? falsePositives / totalFindings : 0;
    const fixConversionRate = totalFindings > 0 ? findingsActedOn / totalFindings : 0;

    return {
      datasetId: dataset.id,
      totalKnownBugs,
      bugsCaught,
      recall,
      totalFindings,
      falsePositives,
      falsePositiveRate,
      findingsActedOn,
      fixConversionRate,
      perLayerResults,
      runDate: new Date().toISOString(),
      pipelineVersion: this.pipelineVersion,
    };
  }
}

/**
 * Tracks benchmark results over time for regression detection.
 * Re-run after every major pipeline change — this is your CI quality
 * gate for the review engine itself.
 */
export class BenchmarkHistory {
  private results: BenchmarkResult[] = [];

  /** Records a benchmark result. */
  record(result: BenchmarkResult): void {
    this.results.push(result);
  }

  /** Gets all recorded results. */
  getAll(): BenchmarkResult[] {
    return [...this.results];
  }

  /** Gets the most recent result. */
  getLatest(): BenchmarkResult | null {
    return this.results[this.results.length - 1] ?? null;
  }

  /** Gets results for a specific dataset. */
  getByDataset(datasetId: string): BenchmarkResult[] {
    return this.results.filter(r => r.datasetId === datasetId);
  }

  /**
   * Compares the two most recent results for regression detection.
   * @returns Comparison showing improvement or regression
   */
  compareLatest(): {
    recallDelta: number;
    falsePositiveRateDelta: number;
    isRegression: boolean;
    isImprovement: boolean;
  } | null {
    if (this.results.length < 2) return null;

    const latest = this.results[this.results.length - 1];
    const previous = this.results[this.results.length - 2];

    const recallDelta = latest.recall - previous.recall;
    const falsePositiveRateDelta = latest.falsePositiveRate - previous.falsePositiveRate;

    return {
      recallDelta,
      falsePositiveRateDelta,
      isRegression: recallDelta < -0.05 || falsePositiveRateDelta > 0.05,
      isImprovement: recallDelta > 0.05 || falsePositiveRateDelta < -0.05,
    };
  }

  /** Clears all history. */
  clear(): void {
    this.results = [];
  }
}

// ── Singleton pattern (follows existing codebase convention) ───────
let instance: BenchmarkRunner | null = null;

/**
 * Gets the singleton BenchmarkRunner instance.
 * Every service uses this pattern: `let instance: T | null = null`
 * with an exported `getXxx(): T` getter.
 */
export function getBenchmarkRunner(): BenchmarkRunner {
  if (!instance) instance = new BenchmarkRunner();
  return instance;
}
