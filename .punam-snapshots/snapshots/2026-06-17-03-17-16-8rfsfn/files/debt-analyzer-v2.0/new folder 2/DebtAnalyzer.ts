/**
 * DebtAnalyzer.ts — Phase 4
 *
 * Phase 4 changes over Phase 3:
 *  - ProjectDebtAnalysis gains optional `dependencyGraph` field
 *    (DependencyGraph + CouplingAnalysis bundled as GraphBundle)
 *  - buildResult() accepts optional GraphBundle — when present, coupling
 *    scores inflate individual fileScores for architecturally risky files
 *  - analyzeProject() accepts optional pre-built GraphBundle so the
 *    dashboard can pass graph data in after the worker finishes
 *  - FileDebtMetrics gains optional `couplingScore` and `dependencyRisk`
 *    fields — populated from graph when available, null otherwise
 *  - detectPrimaryIssue() gains architectural issue types:
 *    hub_file, circular_dependency (when graph data present on the metric)
 *  - sizeRiskScore field name preserved (your live field name)
 *
 * Architecture note:
 *  Graph building happens AFTER file analysis (it needs all files first).
 *  Flow:
 *    1. analyzeProject()         → FileDebtMetrics[] (per-file, no graph)
 *    2. Worker returns metrics   → DebtAnalyzer.buildResult()
 *    3. Dashboard calls          → DependencyGraphEngine.build()
 *    4. Dashboard calls          → DebtAnalyzer.applyGraphData()
 *    5. applyGraphData() returns → updated ProjectDebtAnalysis with graph
 *  This keeps the graph building off the hot analysis path and lets the
 *  dashboard show initial results fast, then enrich with graph data.
 */

import { readFile } from "../../utils/tauri";
import { load } from "@tauri-apps/plugin-store";
import type { DependencyGraph } from "./DependencyGraphEngine";
import type { CouplingAnalysis } from "./CouplingAnalyzer";

// ── AST Metrics ────────────────────────────────────────────────────────────────

export interface ASTMetrics {
  cyclomaticComplexity: number;
  maxNestingDepth: number;
  avgNestingDepth: number;
  functionCount: number;
  longFunctionCount: number;
  godFunctionCount: number;
  maxParameterCount: number;
  avgParameterCount: number;
  classCount: number;
  godClassCount: number;
  returnCount: number;
}

// ── Complexity / nesting bands ─────────────────────────────────────────────────

export type ComplexityBand = "good" | "moderate" | "high" | "critical";
export type NestingBand    = "good" | "warning"  | "refactor";

export function classifyComplexity(cc: number): ComplexityBand {
  if (cc <= 10) return "good";
  if (cc <= 20) return "moderate";
  if (cc <= 30) return "high";
  return "critical";
}

export function classifyNesting(depth: number): NestingBand {
  if (depth <= 3) return "good";
  if (depth <= 5) return "warning";
  return "refactor";
}

// ── Core types ─────────────────────────────────────────────────────────────────

export interface FileDebtMetrics {
  filePath: string;
  linesOfCode: number;
  commentLines: number;
  commentRatio: number;
  functionCount: number;
  avgFunctionLength: number;
  maxFunctionLength: number;
  todoCount: number;
  fixmeCount: number;
  hackCount: number;
  sizeRiskScore: number;          // your live field name — kept as-is
  dependencyDepth: number;
  fileScore: number;
  isUtilityFile: boolean;
  isTestFile: boolean;
  astMetrics: ASTMetrics | null;

  // Phase 4: populated by applyGraphData(), null before graph is built
  couplingScore:     number | null;
  dependencyRisk:    number | null;
  isHubFile:         boolean | null;
  isInCycle:         boolean | null;
}

export interface HotspotASTDetail {
  complexityBand: ComplexityBand;
  nestingBand: NestingBand;
  cyclomaticComplexity: number;
  maxNestingDepth: number;
  longFunctionCount: number;
  godFunctionCount: number;
  godClassCount: number;
  maxParameterCount: number;
}

export interface DebtHotspot {
  filePath: string;
  score: number;
  primaryIssue: string;
  recommendation: string;
  astDetail: HotspotASTDetail | null;
}

export interface DiscoveryMetrics {
  discovered: number;
  analyzed: number;
  skipped: number;
  failed: number;
  fromCache: number;
}

/**
 * Phase 4: graph data bundled into ProjectDebtAnalysis.
 * Both fields are null until applyGraphData() is called.
 */
export interface GraphBundle {
  dependencyGraph: DependencyGraph;
  couplingAnalysis: CouplingAnalysis;
}

export interface ProjectDebtAnalysis {
  files: FileDebtMetrics[];
  hotspots: DebtHotspot[];
  overallScore: number;
  totalFilesAnalyzed: number;
  totalLinesOfCode: number;
  discovery: DiscoveryMetrics;
  graph: GraphBundle | null;      // Phase 4: null until graph is built
}

// ── Analysis config ────────────────────────────────────────────────────────────

export interface AnalysisConfig {
  maxFiles?: number;
  maxDepth?: number;
  includeTests?: boolean;
}

const DEFAULT_CONFIG: Required<AnalysisConfig> = {
  maxFiles: 2000,
  maxDepth: 0,
  includeTests: false,
};

// ── Thresholds ─────────────────────────────────────────────────────────────────

export const THRESHOLDS = {
  LARGE_FILE_LOC:     500,
  SMALL_FILE_LOC:     50,
  REDUCED_WEIGHT_LOC: 100,
  LOW_COMMENT_RATIO:  0.05,
  LONG_FUNCTION_LOC:  50,
  GOD_FUNCTION_LOC:   150,
  EXCESSIVE_PARAMS:   5,
  HIGH_DEP_DEPTH:     5,
  MANY_TODOS:         5,
  CC_MODERATE:        11,
  CC_HIGH:            21,
  CC_CRITICAL:        31,
  NESTING_WARNING:    4,
  NESTING_REFACTOR:   6,
  GOD_CLASS_METHODS:  20,
  UTILITY_SCORE_FLOOR:    55,
  SMALL_FILE_SCORE_FLOOR: 45,
  // Phase 4 coupling thresholds
  HIGH_COUPLING_SCORE:    70,   // coupling score above this = penalty
  HIGH_DEP_RISK:          60,   // dep risk above this = hotspot candidate
} as const;

// ── Cache ──────────────────────────────────────────────────────────────────────

interface CachedFileScore {
  filePath: string;
  metrics: FileDebtMetrics;
  sha256: string;
  timestamp: number;
}

const memCache = new Map<string, CachedFileScore>();
let storePromise: Promise<Awaited<ReturnType<typeof load>>> | null = null;

function getStore() {
  if (!storePromise) storePromise = load("punamide-debt-cache.json", { autoSave: true });
  return storePromise;
}

export async function sha256(content: string): Promise<string> {
  const data = new TextEncoder().encode(content);
  const buf  = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function getCached(filePath: string, hash: string): Promise<FileDebtMetrics | null> {
  const mem = memCache.get(filePath);
  if (mem && mem.sha256 === hash) return mem.metrics;
  try {
    const store = await getStore();
    const entry = await store.get<CachedFileScore>(`file:${filePath}`);
    if (entry && entry.sha256 === hash) {
      memCache.set(filePath, entry);
      return entry.metrics;
    }
  } catch { /* degrade */ }
  return null;
}

async function setCached(filePath: string, hash: string, metrics: FileDebtMetrics): Promise<void> {
  const entry: CachedFileScore = { filePath, metrics, sha256: hash, timestamp: Date.now() };
  memCache.set(filePath, entry);
  try {
    const store = await getStore();
    await store.set(`file:${filePath}`, entry);
  } catch { /* non-fatal */ }
}

// ── File classification ────────────────────────────────────────────────────────

const UTILITY_PATTERNS = [
  /\butils?\b/i, /\bhelpers?\b/i, /\bconstants?\b/i,
  /\bconfig\b/i, /\btypes?\b/i,   /\binterfaces?\b/i,
  /\bindex\b/i,  /\bshared\b/i,   /\bcommon\b/i,
];

const TEST_PATTERNS = [
  /\.test\.[jt]sx?$/, /\.spec\.[jt]sx?$/, /__tests__/,
  /\.test\.py$/, /test_.*\.py$/, /.*_test\.py$/,
  /\.test\.rs$/, /tests\//,
];

export function classifyFile(filePath: string): { isUtilityFile: boolean; isTestFile: boolean } {
  const normalized = filePath.replace(/\\/g, "/").toLowerCase();
  const basename   = normalized.split("/").pop() ?? normalized;
  const isTestFile    = TEST_PATTERNS.some((p) => p.test(normalized));
  const isUtilityFile = !isTestFile && UTILITY_PATTERNS.some((p) => p.test(basename));
  return { isUtilityFile, isTestFile };
}

// ── Source file detection ──────────────────────────────────────────────────────

const SOURCE_EXTENSIONS = new Set([
  "ts", "tsx", "js", "jsx", "py", "rs", "go", "java", "cs",
]);

export function isSourceFile(filePath: string): boolean {
  return SOURCE_EXTENSIONS.has(filePath.split(".").pop()?.toLowerCase() ?? "");
}

// ── Scoring ────────────────────────────────────────────────────────────────────

export function computeFileScore(params: {
  loc: number;
  commentRatio: number;
  avgFunctionLength: number;
  dependencyDepth: number;
  todoCount: number;
  fixmeCount: number;
  sizeRiskScore: number;
  isUtilityFile: boolean;
  isTestFile: boolean;
  astMetrics?: ASTMetrics | null;
  // Phase 4: optional coupling penalty applied at graph-enrichment time
  couplingScore?: number | null;
  isInCycle?: boolean | null;
}): number {
  const {
    loc, commentRatio, avgFunctionLength, dependencyDepth,
    todoCount, fixmeCount, sizeRiskScore, isUtilityFile,
    astMetrics, couplingScore, isInCycle,
  } = params;

  const weightFactor =
    loc < THRESHOLDS.SMALL_FILE_LOC     ? 0   :
    loc < THRESHOLDS.REDUCED_WEIGHT_LOC ? 0.5 :
    1;

  let score = 100;

  // Layer 1: heuristic penalties
  if (loc > THRESHOLDS.LARGE_FILE_LOC)
    score -= 20 * weightFactor;
  if (commentRatio < THRESHOLDS.LOW_COMMENT_RATIO)
    score -= 15 * weightFactor;
  if (avgFunctionLength > THRESHOLDS.LONG_FUNCTION_LOC)
    score -= 15 * weightFactor;
  if (dependencyDepth > THRESHOLDS.HIGH_DEP_DEPTH)
    score -= (isUtilityFile ? 5 : 10) * weightFactor;
  if (todoCount + fixmeCount > THRESHOLDS.MANY_TODOS)
    score -= 15 * weightFactor;
  if (sizeRiskScore > 50)
    score -= 10 * weightFactor;

  // Layer 2: AST penalties (Phase 3)
  if (astMetrics && weightFactor > 0) {
    const cc    = astMetrics.cyclomaticComplexity;
    const depth = astMetrics.maxNestingDepth;
    if      (cc >= THRESHOLDS.CC_CRITICAL) score -= 25;
    else if (cc >= THRESHOLDS.CC_HIGH)     score -= 15;
    else if (cc >= THRESHOLDS.CC_MODERATE) score -= 7;
    if      (depth >= THRESHOLDS.NESTING_REFACTOR) score -= 15;
    else if (depth >= THRESHOLDS.NESTING_WARNING)  score -= 7;
    if (astMetrics.godFunctionCount > 0)
      score -= Math.min(20, astMetrics.godFunctionCount * 8);
    if (astMetrics.godClassCount > 0)
      score -= Math.min(15, astMetrics.godClassCount * 10);
    if (astMetrics.maxParameterCount > THRESHOLDS.EXCESSIVE_PARAMS)
      score -= 5;
    if (cc <= 5 && depth <= 2 && astMetrics.godFunctionCount === 0)
      score += 5;
  }

  // Layer 3: coupling penalties (Phase 4)
  if (weightFactor > 0) {
    if (isInCycle) score -= 15;
    if (couplingScore != null && couplingScore > THRESHOLDS.HIGH_COUPLING_SCORE)
      score -= Math.min(15, Math.round((couplingScore - THRESHOLDS.HIGH_COUPLING_SCORE) / 5));
  }

  score = Math.max(0, Math.round(score));

  // Score floors
  if (isUtilityFile)
    score = Math.max(score, THRESHOLDS.UTILITY_SCORE_FLOOR);
  if (loc < THRESHOLDS.SMALL_FILE_LOC)
    score = Math.max(score, THRESHOLDS.SMALL_FILE_SCORE_FLOOR);

  return Math.min(100, score);
}

// ── Issue detection ────────────────────────────────────────────────────────────

export function detectPrimaryIssue(m: FileDebtMetrics): string {
  // Phase 4: architectural issues take top priority — cycle membership and
  // hub status are systemic problems that amplify all other debt
  if (m.isInCycle)   return "circular_dependency";
  if (m.isHubFile)   return "hub_file";

  const ast = m.astMetrics;
  if (ast) {
    if (ast.cyclomaticComplexity >= THRESHOLDS.CC_HIGH)          return "high_complexity";
    if (ast.maxNestingDepth      >= THRESHOLDS.NESTING_REFACTOR) return "excessive_nesting";
    if (ast.godFunctionCount     > 0)                            return "god_function";
    if (ast.godClassCount        > 0)                            return "god_class";
    if (ast.maxParameterCount    > THRESHOLDS.EXCESSIVE_PARAMS)  return "excessive_params";
    if (ast.cyclomaticComplexity >= THRESHOLDS.CC_MODERATE)      return "high_complexity";
  }

  if (m.linesOfCode       > THRESHOLDS.LARGE_FILE_LOC)           return "file_too_large";
  if (m.sizeRiskScore     > 50)                                   return "high_duplication";
  if (m.avgFunctionLength > THRESHOLDS.LONG_FUNCTION_LOC)        return "long_functions";
  if (m.dependencyDepth   > THRESHOLDS.HIGH_DEP_DEPTH)           return "deep_deps";
  if (m.todoCount + m.fixmeCount > THRESHOLDS.MANY_TODOS)        return "many_todos";
  if (m.commentRatio      < THRESHOLDS.LOW_COMMENT_RATIO)        return "low_comments";
  return "minor_issues";
}

export function generateRecommendation(m: FileDebtMetrics): string {
  const issues: string[] = [];
  const ast = m.astMetrics;

  // Phase 4: architectural issues first
  if (m.isInCycle)  issues.push("Break circular import cycle");
  if (m.isHubFile)  issues.push("Decompose hub file — too many dependents");

  if (ast) {
    const ccBand = classifyComplexity(ast.cyclomaticComplexity);
    if (ccBand !== "good")
      issues.push(`Reduce complexity (CC=${ast.cyclomaticComplexity}, ${ccBand})`);
    if (ast.maxNestingDepth >= THRESHOLDS.NESTING_REFACTOR)
      issues.push(`Flatten nesting (max depth ${ast.maxNestingDepth})`);
    if (ast.godFunctionCount > 0)
      issues.push(`Extract ${ast.godFunctionCount} god function${ast.godFunctionCount > 1 ? "s" : ""} (>${THRESHOLDS.GOD_FUNCTION_LOC} lines)`);
    if (ast.godClassCount > 0)
      issues.push(`Split ${ast.godClassCount} god class${ast.godClassCount > 1 ? "es" : ""} (>${THRESHOLDS.GOD_CLASS_METHODS} methods)`);
    if (ast.longFunctionCount > 0 && ast.godFunctionCount === 0)
      issues.push(`Shorten ${ast.longFunctionCount} long function${ast.longFunctionCount > 1 ? "s" : ""}`);
    if (ast.maxParameterCount > THRESHOLDS.EXCESSIVE_PARAMS)
      issues.push(`Reduce parameter count (max ${ast.maxParameterCount})`);
  }

  if (m.linesOfCode > THRESHOLDS.LARGE_FILE_LOC)
    issues.push(`Split file (${m.linesOfCode} lines)`);
  if (!ast && m.avgFunctionLength > THRESHOLDS.LONG_FUNCTION_LOC)
    issues.push("Extract long functions");
  if (m.dependencyDepth > THRESHOLDS.HIGH_DEP_DEPTH && !m.isUtilityFile)
    issues.push(`Reduce import coupling (${m.dependencyDepth} imports)`);
  if (m.todoCount + m.fixmeCount > THRESHOLDS.MANY_TODOS)
    issues.push(`Resolve ${m.todoCount + m.fixmeCount} TODO/FIXME markers`);
  if (m.commentRatio < THRESHOLDS.LOW_COMMENT_RATIO)
    issues.push("Add documentation comments");

  return issues.join("; ") || "Minor cleanup";
}

function buildHotspotASTDetail(m: FileDebtMetrics): HotspotASTDetail | null {
  const ast = m.astMetrics;
  if (!ast) return null;
  return {
    complexityBand:       classifyComplexity(ast.cyclomaticComplexity),
    nestingBand:          classifyNesting(ast.maxNestingDepth),
    cyclomaticComplexity: ast.cyclomaticComplexity,
    maxNestingDepth:      ast.maxNestingDepth,
    longFunctionCount:    ast.longFunctionCount,
    godFunctionCount:     ast.godFunctionCount,
    godClassCount:        ast.godClassCount,
    maxParameterCount:    ast.maxParameterCount,
  };
}

// ── DebtAnalyzer ───────────────────────────────────────────────────────────────

export class DebtAnalyzer {

  async analyzeFile(filePath: string): Promise<FileDebtMetrics> {
    const content = await readFile(filePath).catch(() => "");
    if (!content.trim()) return this.emptyMetrics(filePath);

    const hash   = await sha256(content);
    const cached = await getCached(filePath, hash);
    if (cached) return cached;

    const lines = content.split("\n");
    const loc   = lines.length;
    const { isUtilityFile, isTestFile } = classifyFile(filePath);

    const commentLines = lines.filter((l) => {
      const t = l.trim();
      return t.startsWith("//") || t.startsWith("#") ||
             t.startsWith("/*") || t.startsWith("*") || t.startsWith("<!--");
    }).length;
    const commentRatio = loc > 0 ? commentLines / loc : 0;

    const functionPattern =
      /(?:function\s+\w+|const\s+\w+\s*=\s*(?:\([^)]*\)\s*=>|function)|(?:async\s+)?\w+\s*\([^)]*\)\s*\{|def\s+\w+|fn\s+\w+|func\s+\w+)/g;
    const functionMatches   = content.match(functionPattern) ?? [];
    const functionCount     = functionMatches.length;
    const avgFunctionLength = functionCount > 0 ? Math.round(loc / functionCount) : loc;

    let maxFunctionLength = loc;
    if (functionMatches.length > 1) {
      let from = 0;
      const positions: number[] = [];
      for (const match of functionMatches) {
        const idx = content.indexOf(match, from);
        if (idx !== -1) { positions.push(idx); from = idx + 1; }
      }
      let maxGap = 0;
      for (let i = 1; i < positions.length; i++) {
        const gap = Math.round(((positions[i] - positions[i - 1]) / content.length) * loc);
        if (gap > maxGap) maxGap = gap;
      }
      maxFunctionLength = maxGap || loc;
    }

    const todoCount       = (content.match(/TODO/gi)     ?? []).length;
    const fixmeCount      = (content.match(/FIXME/gi)    ?? []).length;
    const hackCount       = (content.match(/\bHACK\b/gi) ?? []).length;
    const dependencyDepth = lines.filter((l) =>
      /^\s*(import|require|from|use\s|#include)/.test(l)
    ).length;
    const sizeRiskScore =
      loc > THRESHOLDS.LARGE_FILE_LOC
        ? Math.min(100, (loc / THRESHOLDS.LARGE_FILE_LOC) * 30)
        : 0;

    const fileScore = computeFileScore({
      loc, commentRatio, avgFunctionLength, dependencyDepth,
      todoCount, fixmeCount, sizeRiskScore,
      isUtilityFile, isTestFile,
      astMetrics: null,
    });

    const metrics: FileDebtMetrics = {
      filePath, linesOfCode: loc, commentLines,
      commentRatio: Math.round(commentRatio * 100) / 100,
      functionCount, avgFunctionLength, maxFunctionLength,
      todoCount, fixmeCount, hackCount,
      sizeRiskScore, dependencyDepth, fileScore,
      isUtilityFile, isTestFile,
      astMetrics: null,
      // Phase 4 fields — null until graph is built
      couplingScore: null, dependencyRisk: null,
      isHubFile: null, isInCycle: null,
    };

    await setCached(filePath, hash, metrics);
    return metrics;
  }

  async analyzeProject(
    filePaths: string[],
    config: AnalysisConfig = {},
  ): Promise<ProjectDebtAnalysis> {
    const cfg     = { ...DEFAULT_CONFIG, ...config };
    const limited = cfg.maxFiles > 0 ? filePaths.slice(0, cfg.maxFiles) : filePaths;
    if (limited.length >= 50) return this.analyzeInWorker(limited, cfg);
    return this.analyzeMainThread(limited, cfg);
  }

  /**
   * Phase 4: Enrich an existing ProjectDebtAnalysis with graph data.
   *
   * Call this AFTER analyzeProject() returns and AFTER the dependency
   * graph has been built (DependencyGraphEngine + CouplingAnalyzer).
   *
   * This is a separate step because:
   *  1. Graph building requires all files to be known first
   *  2. It lets the UI show initial results immediately, then enrich
   *  3. The worker doesn't have access to graph data during analysis
   *
   * Returns a new ProjectDebtAnalysis with:
   *  - Graph data attached to each FileDebtMetrics
   *  - fileScores recomputed with coupling penalties
   *  - Hotspots re-ranked (hub files and cycle members promoted)
   *  - graph bundle attached to the analysis
   */
  applyGraphData(
    analysis: ProjectDebtAnalysis,
    bundle: GraphBundle,
  ): ProjectDebtAnalysis {
    const { couplingAnalysis } = bundle;

    // Enrich each file metric with coupling data and recompute score
    const enrichedFiles = analysis.files.map((m) => {
      const coupling = couplingAnalysis.files.find((c) => c.filePath === m.filePath);
      if (!coupling) return m;

      const enriched: FileDebtMetrics = {
        ...m,
        couplingScore:  coupling.couplingScore,
        dependencyRisk: coupling.dependencyRiskScore,
        isHubFile:      coupling.isHubFile,
        isInCycle:      coupling.isInCycle,
      };

      // Recompute fileScore with coupling penalties baked in
      enriched.fileScore = computeFileScore({
        loc:              m.linesOfCode,
        commentRatio:     m.commentRatio,
        avgFunctionLength: m.avgFunctionLength,
        dependencyDepth:  m.dependencyDepth,
        todoCount:        m.todoCount,
        fixmeCount:       m.fixmeCount,
        sizeRiskScore:    m.sizeRiskScore,
        isUtilityFile:    m.isUtilityFile,
        isTestFile:       m.isTestFile,
        astMetrics:       m.astMetrics,
        couplingScore:    coupling.couplingScore,
        isInCycle:        coupling.isInCycle,
      });

      return enriched;
    });

    // Re-sort and rebuild hotspots with architectural issues prioritised
    const sorted = [...enrichedFiles].sort((a, b) => a.fileScore - b.fileScore);

    const candidates = sorted.filter(
      (m) => !m.isUtilityFile && m.linesOfCode >= THRESHOLDS.SMALL_FILE_LOC
    );

    // Architectural hotspots: hub files and cycle members always surface
    const archFiles = enrichedFiles.filter(
      (m) => (m.isHubFile || m.isInCycle) &&
              m.linesOfCode >= THRESHOLDS.SMALL_FILE_LOC
    );

    // Merge: arch files first, then regular candidates, deduped
    const seen = new Set<string>();
    const hotspotFiles: FileDebtMetrics[] = [];
    for (const m of [...archFiles, ...candidates]) {
      if (!seen.has(m.filePath)) {
        seen.add(m.filePath);
        hotspotFiles.push(m);
      }
      if (hotspotFiles.length >= 10) break;
    }

    const hotspots: DebtHotspot[] = hotspotFiles.map((m) => ({
      filePath:       m.filePath,
      score:          m.fileScore,
      primaryIssue:   detectPrimaryIssue(m),
      recommendation: generateRecommendation(m),
      astDetail:      buildHotspotASTDetail(m),
    }));

    const overallScore = enrichedFiles.length > 0
      ? Math.round(enrichedFiles.reduce((s, m) => s + m.fileScore, 0) / enrichedFiles.length)
      : 100;

    return {
      ...analysis,
      files: sorted,
      hotspots,
      overallScore,
      graph: bundle,
    };
  }

  // ── Worker path ──────────────────────────────────────────────────────────────

  private analyzeInWorker(
    filePaths: string[],
    cfg: Required<AnalysisConfig>,
  ): Promise<ProjectDebtAnalysis> {
    return new Promise(async (resolve) => {
      const discovery: DiscoveryMetrics = {
        discovered: filePaths.length,
        analyzed: 0, skipped: 0, failed: 0, fromCache: 0,
      };

      const files: Record<string, string> = {};
      for (const fp of filePaths) {
        if (!isSourceFile(fp))                                { discovery.skipped++; continue; }
        if (!cfg.includeTests && classifyFile(fp).isTestFile) { discovery.skipped++; continue; }
        const content = await readFile(fp).catch(() => "");
        if (content.trim()) { files[fp] = content; discovery.analyzed++; }
        else                  discovery.failed++;
      }

      try {
        const worker = new Worker(
          new URL("../../workers/debt-analyzer.worker.ts", import.meta.url),
          { type: "module" },
        );
        worker.onmessage = (event: MessageEvent) => {
          worker.terminate();
          const workerMetrics: FileDebtMetrics[]           = event.data.fileMetrics ?? [];
          const importMaps: import('./ImportExtractor').FileImportExportMap[]
                                                           = event.data.importMaps  ?? [];
          discovery.fromCache = event.data.fromCache ?? 0;
          resolve(this.buildResult(workerMetrics, discovery, importMaps));
        };
        worker.onerror = () => {
          worker.terminate();
          this.analyzeFromContents(files, cfg, discovery).then(resolve);
        };
        worker.postMessage({ type: "analyze_v2", files, config: cfg });
      } catch {
        resolve(await this.analyzeFromContents(files, cfg, discovery));
      }
    });
  }

  // ── Main-thread paths ────────────────────────────────────────────────────────

  private async analyzeMainThread(
    filePaths: string[],
    cfg: Required<AnalysisConfig>,
  ): Promise<ProjectDebtAnalysis> {
    const discovery: DiscoveryMetrics = {
      discovered: filePaths.length,
      analyzed: 0, skipped: 0, failed: 0, fromCache: 0,
    };
    const metrics: FileDebtMetrics[] = [];
    for (const fp of filePaths) {
      if (!isSourceFile(fp))                                { discovery.skipped++; continue; }
      if (!cfg.includeTests && classifyFile(fp).isTestFile) { discovery.skipped++; continue; }
      const m = await this.analyzeFile(fp).catch(() => null);
      if (!m || m.linesOfCode === 0)                        { discovery.failed++;  continue; }
      metrics.push(m);
      discovery.analyzed++;
    }
    return this.buildResult(metrics, discovery);
  }

  private async analyzeFromContents(
    files: Record<string, string>,
    _cfg: Required<AnalysisConfig>,
    discovery: DiscoveryMetrics,
  ): Promise<ProjectDebtAnalysis> {
    const metrics: FileDebtMetrics[] = [];
    for (const [fp] of Object.entries(files)) {
      const m = await this.analyzeFile(fp).catch(() => null);
      if (m && m.linesOfCode > 0) metrics.push(m);
      else discovery.failed++;
    }
    return this.buildResult(metrics, discovery);
  }

  // ── Result assembly ──────────────────────────────────────────────────────────

  private buildResult(
    metrics: FileDebtMetrics[],
    discovery: DiscoveryMetrics,
    _importMaps: import('./ImportExtractor').FileImportExportMap[] = [],
  ): ProjectDebtAnalysis {
    const sorted = [...metrics].sort((a, b) => a.fileScore - b.fileScore);
    const candidates = sorted.filter(
      (m) => !m.isUtilityFile && m.linesOfCode >= THRESHOLDS.SMALL_FILE_LOC
    );
    const hotspots: DebtHotspot[] = candidates.slice(0, 10).map((m) => ({
      filePath:       m.filePath,
      score:          m.fileScore,
      primaryIssue:   detectPrimaryIssue(m),
      recommendation: generateRecommendation(m),
      astDetail:      buildHotspotASTDetail(m),
    }));
    const overallScore = metrics.length > 0
      ? Math.round(metrics.reduce((s, m) => s + m.fileScore, 0) / metrics.length)
      : 100;

    return {
      files: sorted,
      hotspots,
      overallScore,
      totalFilesAnalyzed: metrics.length,
      totalLinesOfCode:   metrics.reduce((s, m) => s + m.linesOfCode, 0),
      discovery,
      graph: null,   // populated later by applyGraphData()
    };
  }

  // ── Helpers ──────────────────────────────────────────────────────────────────

  private emptyMetrics(filePath: string): FileDebtMetrics {
    const { isUtilityFile, isTestFile } = classifyFile(filePath);
    return {
      filePath, linesOfCode: 0, commentLines: 0, commentRatio: 0,
      functionCount: 0, avgFunctionLength: 0, maxFunctionLength: 0,
      todoCount: 0, fixmeCount: 0, hackCount: 0,
      sizeRiskScore: 0, dependencyDepth: 0, fileScore: 100,
      isUtilityFile, isTestFile, astMetrics: null,
      couplingScore: null, dependencyRisk: null,
      isHubFile: null, isInCycle: null,
    };
  }
}

// ── Singleton ──────────────────────────────────────────────────────────────────

let instance: DebtAnalyzer | null = null;

export function getDebtAnalyzer(): DebtAnalyzer {
  if (!instance) instance = new DebtAnalyzer();
  return instance;
}

export { isSourceFile, classifyFile, computeFileScore, sha256, THRESHOLDS };
