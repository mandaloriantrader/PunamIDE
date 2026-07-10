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

export interface GraphBundle {
  dependencyGraph: DependencyGraph;
  couplingAnalysis: CouplingAnalysis;
}

export type ASTAnalysisMode = "active" | "partial" | "fallback" | "not-applicable";
export type AnalysisExecution = "worker" | "main-thread";

export interface ASTAnalysisStatus {
  mode: ASTAnalysisMode;
  execution: AnalysisExecution;
  supportedFiles: number;
  astFiles: number;
  fallbackFiles: number;
  fallbackFilePaths: string[];
  unsupportedFiles: number;
  parserFailures: number;
  loadedLanguages: string[];
  lastError: string | null;
}

export interface ProjectDebtAnalysis {
  files: FileDebtMetrics[];
  hotspots: DebtHotspot[];
  overallScore: number;
  totalFilesAnalyzed: number;
  totalLinesOfCode: number;
  discovery: DiscoveryMetrics;
  graph: GraphBundle | null;      // Phase 4: null until graph is built
  astStatus: ASTAnalysisStatus;
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
  HIGH_COUPLING_SCORE:    70,
  HIGH_DEP_RISK:          60,
} as const;

// ── Cache ──────────────────────────────────────────────────────────────────────

interface CachedFileScore {
  filePath: string;
  metrics: FileDebtMetrics;
  sha256: string;
  timestamp: number;
}

const memCache = new Map<string, CachedFileScore>();
const MEM_CACHE_MAX = 2000;
const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
let storePromise: Promise<Awaited<ReturnType<typeof load>>> | null = null;

function getStore() {
  if (!storePromise) storePromise = load("punamide-debt-cache.json", { autoSave: true, defaults: {} });
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
  if (mem && mem.sha256 === hash && Date.now() - mem.timestamp < CACHE_TTL_MS) return mem.metrics;
  try {
    const store = await getStore();
    const entry = await store.get<CachedFileScore>(`file:${filePath}`);
    if (entry && entry.sha256 === hash && Date.now() - entry.timestamp < CACHE_TTL_MS) {
      memCache.set(filePath, entry);
      return entry.metrics;
    }
  } catch { /* degrade */ }
  return null;
}

async function setCached(filePath: string, hash: string, metrics: FileDebtMetrics): Promise<void> {
  // Evict oldest entries if memCache exceeds limit
  if (memCache.size >= MEM_CACHE_MAX) {
    const entries = [...memCache.entries()]
      .sort((a, b) => a[1].timestamp - b[1].timestamp);
    const evictCount = Math.floor(MEM_CACHE_MAX * 0.2);
    for (let i = 0; i < evictCount; i++) {
      memCache.delete(entries[i][0]);
    }
  }

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

  if (weightFactor > 0) {
    if (isInCycle) score -= 15;
    if (couplingScore != null && couplingScore > THRESHOLDS.HIGH_COUPLING_SCORE)
      score -= Math.min(15, Math.round((couplingScore - THRESHOLDS.HIGH_COUPLING_SCORE) / 5));
  }

  score = Math.max(0, Math.round(score));

  if (isUtilityFile)
    score = Math.max(score, THRESHOLDS.UTILITY_SCORE_FLOOR);
  if (loc < THRESHOLDS.SMALL_FILE_LOC)
    score = Math.max(score, THRESHOLDS.SMALL_FILE_SCORE_FLOOR);

  return Math.min(100, score);
}

// ── Issue detection ────────────────────────────────────────────────────────────

export function detectPrimaryIssue(m: FileDebtMetrics): string {
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

    // Strip string contents and comments to avoid false positive function matches
    const stripped = content
      .replace(/\/\*[\s\S]*?\*\//g, '/* */')
      .replace(/\/\/.*/g, '//')
      .replace(/(["'`])(?:(?!\1|\\).|\\.)*\1/g, '""');

    const functionPattern =
      /(?:^|\n)\s*(?:export\s+)?(?:async\s+)?function\s+\w+|(?:^|\n)\s*(?:export\s+)?(?:const|let|var)\s+\w+\s*=\s*(?:async\s+)?(?:\([^)]*\)|[\w$]+)\s*=>|(?:^|\n)\s*(?:export\s+)?(?:async\s+)?(?:public|private|protected|static)?\s*\w+\s*\([^)]*\)\s*[:{]|(?:^|\n)\s*(?:async\s+)?def\s+\w+\s*\(|(?:^|\n)\s*(?:pub\s+)?(?:async\s+)?fn\s+\w+|(?:^|\n)\s*func\s+\w+/g;
    const functionMatches   = stripped.match(functionPattern) ?? [];
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
    if (limited.length >= 1) return this.analyzeInWorker(limited, cfg);
    return this.analyzeMainThread(limited, cfg);
  }

  applyGraphData(
    analysis: ProjectDebtAnalysis,
    bundle: GraphBundle,
  ): ProjectDebtAnalysis {
    const { couplingAnalysis } = bundle;

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

    const sorted = [...enrichedFiles].sort((a, b) => a.fileScore - b.fileScore);

    const candidates = sorted.filter(
      (m) => !m.isUtilityFile && m.linesOfCode >= THRESHOLDS.SMALL_FILE_LOC
    );

    const archFiles = enrichedFiles.filter(
      (m) => (m.isHubFile || m.isInCycle) &&
              m.linesOfCode >= THRESHOLDS.SMALL_FILE_LOC
    );

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
    return new Promise((resolve) => {
      void (async () => {
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
          resolve(this.buildResult(
            workerMetrics,
            discovery,
            importMaps,
            "worker",
            {
              parserFailures: event.data.astDiagnostics?.failedParses ?? 0,
              loadedLanguages: event.data.astDiagnostics?.loadedLanguages ?? [],
              lastError: event.data.astDiagnostics?.lastError ?? null,
            },
          ));
        };
        worker.onerror = () => {
          worker.terminate();
          this.analyzeFromContents(files, cfg, discovery).then(resolve);
        };
        worker.postMessage({ type: "analyze_v2", files, config: cfg });
      } catch {
        resolve(await this.analyzeFromContents(files, cfg, discovery));
      }
      })();
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
    return this.buildResult(metrics, discovery, [], "main-thread");
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
    return this.buildResult(metrics, discovery, [], "main-thread");
  }

  // ── Result assembly ──────────────────────────────────────────────────────────

  private buildResult(
    metrics: FileDebtMetrics[],
    discovery: DiscoveryMetrics,
    _importMaps: import('./ImportExtractor').FileImportExportMap[] = [],
    execution: AnalysisExecution = "main-thread",
    diagnostics: {
      parserFailures: number;
      loadedLanguages: string[];
      lastError: string | null;
    } = { parserFailures: 0, loadedLanguages: [], lastError: null },
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
    const supportedFiles = metrics.filter((m) => /\.(?:[jt]sx?)$/i.test(m.filePath)).length;
    const astFiles = metrics.filter((m) => m.astMetrics !== null).length;
    const fallbackFiles = Math.max(0, supportedFiles - astFiles);
    const fallbackFilePaths = metrics
      .filter((m) => /\.(?:[jt]sx?)$/i.test(m.filePath) && m.astMetrics === null)
      .map((m) => m.filePath);
    const unsupportedFiles = Math.max(0, metrics.length - supportedFiles);
    const mode: ASTAnalysisMode =
      supportedFiles === 0 ? "not-applicable"
      : astFiles === supportedFiles ? "active"
      : astFiles > 0 ? "partial"
      : "fallback";

    return {
      files: sorted,
      hotspots,
      overallScore,
      totalFilesAnalyzed: metrics.length,
      totalLinesOfCode:   metrics.reduce((s, m) => s + m.linesOfCode, 0),
      discovery,
      graph: null,
      astStatus: {
        mode,
        execution,
        supportedFiles,
        astFiles,
        fallbackFiles,
        fallbackFilePaths,
        unsupportedFiles,
        parserFailures: diagnostics.parserFailures,
        loadedLanguages: diagnostics.loadedLanguages,
        lastError: diagnostics.lastError,
      },
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
