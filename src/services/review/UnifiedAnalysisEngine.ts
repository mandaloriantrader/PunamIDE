/**
 * @phase P1 (core), P2-P8 (layers added incrementally)
 * @purpose The main orchestrator for the Unified Analysis Engine.
 *          Accepts files or a diff range, runs all analysis layers,
 *          merges findings into FileRiskProfile per file, and computes
 *          composite risk scores.
 *
 * Design principles:
 * - Layers are registered as plugins implementing AnalysisLayer
 * - Degrades gracefully: if a layer fails, log and continue
 * - Supports both full-repo mode and diff-review mode
 * - Every layer's output merges into one panel, not five tabs
 */

import {
  type Finding,
  type FileRiskProfile,
  type AnalysisResult,
  type AnalysisLayer,
  type AnalysisContext,
  type UnifiedAnalysisConfig,
  type ChurnData,
  type CouplingData,
} from './types';
import type { DependencyGraph } from './types';
import type { FileDebtMetrics } from './types';
import { mergeFindings, groupByFile } from './FindingMerger';
import { calculateCompositeRiskScore } from './RiskScoreCalculator';
import { getDebtAnalyzer, getDebtScorer, getCouplingAnalyzer, getCircularDepDetector, getIncrementalGraphEngine } from '../technicalDebt';
import { adaptDebtMetrics } from './adapters/DebtFindingAdapter';
import type { ProjectDebtAnalysis, GraphBundle } from '../technicalDebt/DebtAnalyzer';

// ── Layer imports (P2/P5/P7/P8) ─────────────────────────────────────
import { getTaintLayer, TaintLayer } from './TaintLayer';
import { getGitSignalsLayer, GitSignalsLayer } from './GitSignalsLayer';
import type { GitCommandInterface } from './GitSignalsAnalyzer';
import type { GitHubStatusProvider } from './GitConsistencyChecker';
import { getMultiLanguageLayer, MultiLanguageLayer } from './MultiLanguageLayer';
import { BenchmarkRunner } from './BenchmarkRunner';
import { BenchmarkReporter } from './BenchmarkReporter';
import type { BenchmarkResult } from './BenchmarkRunner';
import type { BenchmarkDataset } from './BenchmarkDataset';

/** Logger interface for testability (inject your own logger). */
export interface Logger {
  warn(message: string, ...args: unknown[]): void;
  error(message: string, ...args: unknown[]): void;
  info(message: string, ...args: unknown[]): void;
}

/** Default no-op logger. */
const noopLogger: Logger = {
  warn: () => {},
  error: () => {},
  info: () => {},
};

// ── LRU + TTL Cache (follows existing DebtAnalyzer pattern) ────────

interface CacheEntry<T> {
  value: T;
  createdAt: number;
  hash: string;
}

class LRUTTLCache<T> {
  private cache = new Map<string, CacheEntry<T>>();
  private maxEntries: number;
  private ttlMs: number;

  constructor(maxEntries: number = 2000, ttlDays: number = 7) {
    this.maxEntries = maxEntries;
    this.ttlMs = ttlDays * 24 * 60 * 60 * 1000;
  }

  get(key: string): T | null {
    const entry = this.cache.get(key);
    if (!entry) return null;
    if (Date.now() - entry.createdAt > this.ttlMs) {
      this.cache.delete(key);
      return null;
    }
    this.cache.delete(key);
    this.cache.set(key, entry);
    return entry.value;
  }

  set(key: string, value: T, hash: string): void {
    if (this.cache.size >= this.maxEntries) {
      const evictCount = Math.ceil(this.maxEntries * 0.2);
      const keys = Array.from(this.cache.keys());
      for (let i = 0; i < evictCount && i < keys.length; i++) {
        this.cache.delete(keys[i]);
      }
    }
    this.cache.set(key, { value, createdAt: Date.now(), hash });
  }

  has(key: string): boolean { return this.get(key) !== null; }
  clear(): void { this.cache.clear(); }
  size(): number { return this.cache.size; }
}

async function computeHash(content: string): Promise<string> {
  try {
    if (typeof crypto !== 'undefined' && crypto.subtle) {
      const data = new TextEncoder().encode(content);
      const hashBuffer = await crypto.subtle.digest('SHA-256', data);
      return Array.from(new Uint8Array(hashBuffer))
        .map(b => b.toString(16).padStart(2, '0'))
        .join('');
    }
  } catch { /* fall through */ }

  let hash = 0;
  for (let i = 0; i < content.length; i++) {
    const char = content.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash |= 0;
  }
  return Math.abs(hash).toString(16);
}

/**
 * The Unified Analysis Engine. Registers analysis layers as plugins,
 * runs them in order, and assembles a unified FileRiskProfile per file.
 */
export class UnifiedAnalysisEngine {
  private layers: AnalysisLayer[] = [];
  private logger: Logger;
  private resultCache: LRUTTLCache<AnalysisResult> = new LRUTTLCache(2000, 7);
  private phase1Results: AnalysisResult | null = null;
  private phase2Results: AnalysisResult | null = null;
  private layersAutoRegistered = false;
  private benchmarkReporter = new BenchmarkReporter();

  private debtMetricsProvider?: (files: string[]) => Promise<Map<string, FileDebtMetrics>>;
  private churnProvider?: (files: string[]) => Promise<Map<string, ChurnData>>;
  private couplingProvider?: (files: string[]) => Promise<Map<string, CouplingData>>;
  private architectureLayerProvider?: (files: string[]) => Promise<Map<string, string | null>>;
  private fileContentProvider?: (files: string[]) => Promise<Map<string, string>>;
  private graphProvider?: () => Promise<DependencyGraph | undefined>;

  constructor(logger: Logger = noopLogger) {
    this.logger = logger;
    this.autoRegisterLayers();
  }

  /**
   * Auto-registers layers that don't require external dependencies.
   * P5 (taint) — always registered, gated by config.enabledLayers including 'taint'.
   * P2 (git-signals) and P7 (multi-language) — registered externally when deps are ready.
   */
  private autoRegisterLayers(): void {
    if (this.layersAutoRegistered) return;
    this.layersAutoRegistered = true;

    // P5 — Taint tracking (experimental, gated by config.enabledLayers including 'taint')
    try {
      this.registerLayer(getTaintLayer());
    } catch { /* TaintLayer optional */ }

    // P7 — Multi-language detection (gated by config.enabledLayers including 'multi-language')
    try {
      this.registerLayer(getMultiLanguageLayer());
    } catch { /* MultiLanguageLayer optional */ }
  }

  /**
   * Registers the P2 git-signals layer after a GitCommandInterface
   * is available (typically after Tauri init).
   */
  registerGitSignals(git: GitCommandInterface, githubStatus?: GitHubStatusProvider): void {
    try {
      const layer = getGitSignalsLayer(git, githubStatus);
      if (!this.layers.find(l => l.name === layer.name)) {
        this.registerLayer(layer);
      }
    } catch { /* git optional */ }
  }

  /** P8 — Runs a benchmark against the given dataset. */
  async runBenchmark(dataset: BenchmarkDataset, config: UnifiedAnalysisConfig): Promise<BenchmarkResult> {
    const runner = new BenchmarkRunner('0.2.0');
    const result = await runner.runBenchmark(dataset, this, config);
    this.logger.info(
      `Benchmark complete: recall=${(result.recall * 100).toFixed(1)}% ` +
      `fpr=${(result.falsePositiveRate * 100).toFixed(1)}%`
    );
    return result;
  }

  /** P8 — Generates a markdown benchmark report from a result. */
  generateBenchmarkReport(result: BenchmarkResult): string {
    return this.benchmarkReporter.generateReport(result);
  }

  getRegisteredLayers(): string[] { return this.getLayerNames(); }

  registerLayer(layer: AnalysisLayer): void {
    this.layers.push(layer);
    this.logger.info(`Registered analysis layer: ${layer.name}`);
  }

  unregisterLayer(name: string): void {
    this.layers = this.layers.filter(l => l.name !== name);
  }

  getLayerNames(): string[] { return this.layers.map(l => l.name); }

  setDebtMetricsProvider(fn: (files: string[]) => Promise<Map<string, FileDebtMetrics>>): void {
    this.debtMetricsProvider = fn;
  }
  setChurnProvider(fn: (files: string[]) => Promise<Map<string, ChurnData>>): void {
    this.churnProvider = fn;
  }
  setCouplingProvider(fn: (files: string[]) => Promise<Map<string, CouplingData>>): void {
    this.couplingProvider = fn;
  }
  setArchitectureLayerProvider(fn: (files: string[]) => Promise<Map<string, string | null>>): void {
    this.architectureLayerProvider = fn;
  }
  setFileContentProvider(fn: (files: string[]) => Promise<Map<string, string>>): void {
    this.fileContentProvider = fn;
  }
  setGraphProvider(fn: () => Promise<DependencyGraph | undefined>): void {
    this.graphProvider = fn;
  }

  async analyze(files: string[], config: UnifiedAnalysisConfig): Promise<AnalysisResult> {
    const tdaFindings: Finding[] = [];
    const debtScores = new Map<string, number>();
    const couplingData = new Map<string, CouplingData>();
    const churnData = new Map<string, ChurnData>();
    const archLayers = new Map<string, string | null>();

    try {
      const analyzer = getDebtAnalyzer();
      const tdaAnalysis = await analyzer.analyzeProject(files, { maxFiles: 2000 });

      for (const m of tdaAnalysis.files) {
        tdaFindings.push(...adaptDebtMetrics(m));
        debtScores.set(m.filePath, m.fileScore);
      }

      if (tdaAnalysis.graph) {
        const coupling = tdaAnalysis.graph.couplingAnalysis;
        for (const cm of coupling.files) {
          couplingData.set(cm.filePath, {
            fanIn: cm.fanIn,
            fanOut: cm.fanOut,
            instability: cm.instability,
          });
        }
      }
    } catch { /* degrade gracefully */ }

    const cacheKey = files.join('|') + '|' + JSON.stringify(config);
    const cached = this.resultCache.get(cacheKey);
    if (cached) {
      this.logger.info('Analysis cache hit');
      return cached;
    }

    const [
      debtMetrics,
      fileContents,
    ] = await Promise.all([
      this.debtMetricsProvider ? this.debtMetricsProvider(files) : Promise.resolve(new Map<string, FileDebtMetrics>()),
      this.fileContentProvider ? this.fileContentProvider(files) : Promise.resolve(new Map<string, string>()),
    ]);

    const [
      churnData2,
      couplingData2,
      archLayers2,
      graph,
    ] = await Promise.all([
      this.churnProvider ? this.churnProvider(files) : Promise.resolve(new Map<string, ChurnData>()),
      this.couplingProvider ? this.couplingProvider(files) : Promise.resolve(new Map<string, CouplingData>()),
      this.architectureLayerProvider ? this.architectureLayerProvider(files) : Promise.resolve(new Map<string, string | null>()),
      this.graphProvider ? this.graphProvider() : Promise.resolve(undefined),
    ]);

    for (const [k, v] of couplingData) {
      if (!couplingData2.has(k)) couplingData2.set(k, v);
    }

    const context: AnalysisContext = {
      files,
      fileContents,
      graph,
      config,
    };

    const findingsBySource = new Map<string, Finding[]>();
    findingsBySource.set('debt', tdaFindings);

    for (const layer of this.layers) {
      if (!layer.isEnabled(config)) {
        this.logger.info(`Skipping disabled layer: ${layer.name}`);
        continue;
      }
      try {
        const layerFindings = await layer.analyze(files, context);
        findingsBySource.set(layer.name, layerFindings);
        this.logger.info(`Layer ${layer.name} produced ${layerFindings.length} findings`);
      } catch (err) {
        this.logger.error(`Layer ${layer.name} failed:`, err);
        findingsBySource.set(layer.name, []);
      }
    }

    const { findings: mergedFindings } = mergeFindings(
      findingsBySource,
      config.maxFindingsPerFile,
    );
    const findingsByFile = groupByFile(mergedFindings);

    const result = new Map<string, FileRiskProfile>();

    for (const file of files) {
      const debt = debtMetrics.get(file);
      const churn = churnData2.get(file) ?? { commitsLast30d: 0, lastModified: '' };
      const coupling = couplingData2.get(file) ?? { fanIn: 0, fanOut: 0, instability: 0 };
      const archLayer = archLayers2.get(file) ?? null;
      const fileFindings = findingsByFile.get(file) ?? [];

      const debtScore = debtScores.get(file) ?? debt?.fileScore ?? 100;
      const compositeRiskScore = calculateCompositeRiskScore(
        debtScore,
        fileFindings,
        churn,
        coupling,
      );

      result.set(file, {
        file,
        debtScore,
        findings: fileFindings,
        churn,
        coupling,
        architectureLayer: archLayer,
        compositeRiskScore,
      });
    }

    const hash = await computeHash(cacheKey);
    this.resultCache.set(cacheKey, result, hash);
    this.phase2Results = result;

    return result;
  }

  getPhase1Results(): AnalysisResult | null { return this.phase1Results; }
  getPhase2Results(): AnalysisResult | null { return this.phase2Results; }
  clearCache(): void { this.resultCache.clear(); this.phase1Results = null; this.phase2Results = null; }
  getCacheSize(): number { return this.resultCache.size(); }

  async analyzeDiff(
    changedFiles: string[],
    config: UnifiedAnalysisConfig,
  ): Promise<AnalysisResult> {
    return this.analyze(changedFiles, { ...config, diffMode: true });
  }
}

// ── Singleton pattern ───────
let instance: UnifiedAnalysisEngine | null = null;

export function getUnifiedAnalysisEngine(): UnifiedAnalysisEngine {
  if (!instance) instance = new UnifiedAnalysisEngine();
  return instance;
}