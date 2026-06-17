/**
 * DebtAnalyzer.ts — Phase 3
 *
 * Phase 3 changes over Phase 1:
 *  - computeFileScore() accepts optional astMetrics — AST penalties baked
 *    into the score at analysis time, stored in cache with full data
 *  - detectPrimaryIssue() is AST-aware: high_complexity, excessive_nesting,
 *    god_function, god_class, excessive_params take priority over heuristics
 *  - generateRecommendation() produces specific, data-driven advice when
 *    astMetrics present (e.g. "3 god functions (>150 lines)")
 *  - DebtHotspot gains astDetail: HotspotASTDetail for dashboard display
 *  - ComplexityBand and NestingBand types exported for dashboard use
 *  - All Phase 3 spec thresholds wired in:
 *      Cyclomatic: 1–10 Good, 11–20 Moderate, 21–30 High, 30+ Critical
 *      Nesting:    1–3 Good, 4–5 Warning, 6+ Refactor Candidate
 *      God class:  > 20 methods
 *      God func:   > 150 lines
 *      Excessive params: > 5
 *
 * Backward compat: astMetrics remains null for main-thread analysis path.
 * The worker populates it via Tree-sitter (Phase 2) and its cache entry
 * overwrites the main-thread heuristic-only result.
 */

import { readFile } from "../../utils/tauri";
import { load } from "@tauri-apps/plugin-store";

// ── AST Metrics (Phase 2 Tree-sitter output) ───────────────────────────────────

export interface ASTMetrics {
  cyclomaticComplexity: number;
  maxNestingDepth: number;
  avgNestingDepth: number;
  functionCount: number;
  longFunctionCount: number;        // functions > LONG_FUNCTION_LOC lines
  godFunctionCount: number;         // functions > GOD_FUNCTION_LOC lines
  maxParameterCount: number;
  avgParameterCount: number;
  classCount: number;
  godClassCount: number;            // classes with > GOD_CLASS_METHODS methods
  returnCount: number;
}

// ── Complexity / nesting bands (Phase 3 spec) ──────────────────────────────────

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
  sizeRiskScore: number;
  dependencyDepth: number;
  fileScore: number;                // 0–100, higher = healthier
  isUtilityFile: boolean;
  isTestFile: boolean;
  astMetrics: ASTMetrics | null;
}

/**
 * Per-hotspot AST breakdown shown in the dashboard Refactor Queue.
 * Concrete numbers instead of vague labels — "CC=24 (high)" not "complex".
 */
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
  astDetail: HotspotASTDetail | null;   // null when Tree-sitter hasn't run yet
}

export interface DiscoveryMetrics {
  discovered: number;
  analyzed: number;
  skipped: number;
  failed: number;
  fromCache: number;
}

export interface ProjectDebtAnalysis {
  files: FileDebtMetrics[];
  hotspots: DebtHotspot[];
  overallScore: number;
  totalFilesAnalyzed: number;
  totalLinesOfCode: number;
  discovery: DiscoveryMetrics;
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
  // File size
  LARGE_FILE_LOC:     500,
  SMALL_FILE_LOC:     50,
  REDUCED_WEIGHT_LOC: 100,

  // Comments
  LOW_COMMENT_RATIO: 0.05,

  // Functions
  LONG_FUNCTION_LOC: 50,
  GOD_FUNCTION_LOC:  150,

  // Parameters (Phase 3 spec)
  EXCESSIVE_PARAMS: 5,

  // Dependencies
  HIGH_DEP_DEPTH: 5,

  // Annotations
  MANY_TODOS: 5,

  // Cyclomatic complexity bands (Phase 3 spec)
  CC_MODERATE: 11,
  CC_HIGH:     21,
  CC_CRITICAL: 31,

  // Nesting depth bands (Phase 3 spec)
  NESTING_WARNING:  4,
  NESTING_REFACTOR: 6,

  // Class size (Phase 3 spec)
  GOD_CLASS_METHODS: 20,

  // Score floors
  UTILITY_SCORE_FLOOR:    55,
  SMALL_FILE_SCORE_FLOOR: 45,
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
  if (!storePromise) {
    storePromise = load("punamide-debt-cache.json", { autoSave: true });
  }
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
  } catch { /* degrade gracefully */ }
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

/**
 * Composite file score (0–100, higher = healthier).
 *
 * Phase 3: accepts optional astMetrics. When present, AST-based penalties
 * are applied at analysis time so cached scores reflect full static analysis.
 *
 * Penalty layers:
 *   1. Heuristic penalties  — always applied, weight-scaled by file size
 *   2. AST penalties        — applied only when astMetrics is present
 *   3. Score floors         — utility and tiny files never fall below floor
 */
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
}): number {
  const {
    loc, commentRatio, avgFunctionLength, dependencyDepth,
    todoCount, fixmeCount, sizeRiskScore, isUtilityFile,
    astMetrics,
  } = params;

  // Small-file weight scaling — Phase 1 spec preserved
  const weightFactor =
    loc < THRESHOLDS.SMALL_FILE_LOC     ? 0   :
    loc < THRESHOLDS.REDUCED_WEIGHT_LOC ? 0.5 :
    1;

  let score = 100;

  // ── Layer 1: heuristic penalties ─────────────────────────────────────────
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

  // ── Layer 2: AST penalties (Phase 3) ─────────────────────────────────────
  if (astMetrics && weightFactor > 0) {
    const cc    = astMetrics.cyclomaticComplexity;
    const depth = astMetrics.maxNestingDepth;

    // Cyclomatic complexity — exact Phase 3 spec bands
    if      (cc >= THRESHOLDS.CC_CRITICAL) score -= 25;
    else if (cc >= THRESHOLDS.CC_HIGH)     score -= 15;
    else if (cc >= THRESHOLDS.CC_MODERATE) score -= 7;

    // Nesting depth — exact Phase 3 spec bands
    if      (depth >= THRESHOLDS.NESTING_REFACTOR) score -= 15;
    else if (depth >= THRESHOLDS.NESTING_WARNING)  score -= 7;

    // God functions — each is a major debt item; capped to avoid over-penalising
    if (astMetrics.godFunctionCount > 0)
      score -= Math.min(20, astMetrics.godFunctionCount * 8);

    // God classes
    if (astMetrics.godClassCount > 0)
      score -= Math.min(15, astMetrics.godClassCount * 10);

    // Excessive parameters — smaller penalty, common in many patterns
    if (astMetrics.maxParameterCount > THRESHOLDS.EXCESSIVE_PARAMS)
      score -= 5;

    // Bonus: genuinely clean file (reward, not just absence of penalty)
    if (cc <= 5 && depth <= 2 && astMetrics.godFunctionCount === 0)
      score += 5;
  }

  score = Math.max(0, Math.round(score));

  // ── Layer 3: score floors ─────────────────────────────────────────────────
  if (isUtilityFile)
    score = Math.max(score, THRESHOLDS.UTILITY_SCORE_FLOOR);
  if (loc < THRESHOLDS.SMALL_FILE_LOC)
    score = Math.max(score, THRESHOLDS.SMALL_FILE_SCORE_FLOOR);

  return Math.min(100, score);
}

// ── Issue detection ────────────────────────────────────────────────────────────

/**
 * Determine the single most important debt issue for a file.
 *
 * Phase 3: AST-derived issues take priority when astMetrics is present.
 * Ordering: severity and actionability, worst first.
 *
 * Issue type registry (consumed by RefactorPlanner effort/impact tables):
 *   high_complexity    — CC >= 21 (High or Critical band)
 *   excessive_nesting  — depth >= 6 (Refactor Candidate band)
 *   god_function       — function > 150 lines
 *   god_class          — class > 20 methods
 *   excessive_params   — max param count > 5
 *   file_too_large     — LOC > 500
 *   high_duplication   — duplication score > 50
 *   long_functions     — avg function length > 50 (heuristic only)
 *   deep_deps          — import count > 5
 *   many_todos         — TODO+FIXME > 5
 *   low_comments       — comment ratio < 5%
 *   minor_issues       — nothing significant
 */
export function detectPrimaryIssue(m: FileDebtMetrics): string {
  const ast = m.astMetrics;

  if (ast) {
    // Critical / High complexity takes top priority — it drives almost
    // every other problem (long functions, deep nesting, hard to test)
    if (ast.cyclomaticComplexity >= THRESHOLDS.CC_HIGH)          return "high_complexity";
    if (ast.maxNestingDepth      >= THRESHOLDS.NESTING_REFACTOR) return "excessive_nesting";
    if (ast.godFunctionCount     > 0)                            return "god_function";
    if (ast.godClassCount        > 0)                            return "god_class";
    if (ast.maxParameterCount    > THRESHOLDS.EXCESSIVE_PARAMS)  return "excessive_params";
    // Moderate complexity — still noteworthy, below structural issues
    if (ast.cyclomaticComplexity >= THRESHOLDS.CC_MODERATE)      return "high_complexity";
  }

  // Heuristic issues (always available, used when AST is absent)
  if (m.linesOfCode       > THRESHOLDS.LARGE_FILE_LOC)           return "file_too_large";
  if (m.sizeRiskScore  > 50)                                  return "high_duplication";
  if (m.avgFunctionLength > THRESHOLDS.LONG_FUNCTION_LOC)        return "long_functions";
  if (m.dependencyDepth   > THRESHOLDS.HIGH_DEP_DEPTH)           return "deep_deps";
  if (m.todoCount + m.fixmeCount > THRESHOLDS.MANY_TODOS)        return "many_todos";
  if (m.commentRatio      < THRESHOLDS.LOW_COMMENT_RATIO)        return "low_comments";

  return "minor_issues";
}

/**
 * Generate specific, data-driven recommendations.
 * Uses AST counts when available ("3 god functions (>150 lines)")
 * rather than generic advice ("Extract long functions").
 */
export function generateRecommendation(m: FileDebtMetrics): string {
  const issues: string[] = [];
  const ast = m.astMetrics;

  // AST-derived recommendations (specific and measurable)
  if (ast) {
    const ccBand = classifyComplexity(ast.cyclomaticComplexity);
    if (ccBand !== "good")
      issues.push(`Reduce complexity (CC=${ast.cyclomaticComplexity}, ${ccBand})`);

    if (ast.maxNestingDepth >= THRESHOLDS.NESTING_REFACTOR)
      issues.push(`Flatten nesting (max depth ${ast.maxNestingDepth})`);

    if (ast.godFunctionCount > 0)
      issues.push(
        `Extract ${ast.godFunctionCount} god function${ast.godFunctionCount > 1 ? "s" : ""} (>${THRESHOLDS.GOD_FUNCTION_LOC} lines)`
      );

    if (ast.godClassCount > 0)
      issues.push(
        `Split ${ast.godClassCount} god class${ast.godClassCount > 1 ? "es" : ""} (>${THRESHOLDS.GOD_CLASS_METHODS} methods)`
      );

    // Long functions (not god-level) — only report if not already covered above
    if (ast.longFunctionCount > 0 && ast.godFunctionCount === 0)
      issues.push(
        `Shorten ${ast.longFunctionCount} long function${ast.longFunctionCount > 1 ? "s" : ""} (>${THRESHOLDS.LONG_FUNCTION_LOC} lines)`
      );

    if (ast.maxParameterCount > THRESHOLDS.EXCESSIVE_PARAMS)
      issues.push(`Reduce parameter count (max ${ast.maxParameterCount} — use options object)`);
  }

  // Heuristic recommendations (always checked, fill gaps when AST is absent)
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

// ── Hotspot AST detail ─────────────────────────────────────────────────────────

function buildHotspotASTDetail(m: FileDebtMetrics): HotspotASTDetail | null {
  const ast = m.astMetrics;
  if (!ast) return null;
  return {
    complexityBand:      classifyComplexity(ast.cyclomaticComplexity),
    nestingBand:         classifyNesting(ast.maxNestingDepth),
    cyclomaticComplexity: ast.cyclomaticComplexity,
    maxNestingDepth:     ast.maxNestingDepth,
    longFunctionCount:   ast.longFunctionCount,
    godFunctionCount:    ast.godFunctionCount,
    godClassCount:       ast.godClassCount,
    maxParameterCount:   ast.maxParameterCount,
  };
}

// ── DebtAnalyzer ───────────────────────────────────────────────────────────────

export class DebtAnalyzer {

  /**
   * Analyze a single file — main thread path (heuristic-only, no Tree-sitter).
   * Worker path in analyzeInWorker() runs AST analysis and overwrites this
   * cache entry with an astMetrics-populated result.
   */
  async analyzeFile(filePath: string): Promise<FileDebtMetrics> {
    const content = await readFile(filePath).catch(() => "");
    if (!content.trim()) return this.emptyMetrics(filePath);

    const hash   = await sha256(content);
    const cached = await getCached(filePath, hash);
    if (cached) return cached;

    const lines = content.split("\n");
    const loc   = lines.length;
    const { isUtilityFile, isTestFile } = classifyFile(filePath);

    // Comment ratio
    const commentLines = lines.filter((l) => {
      const t = l.trim();
      return t.startsWith("//") || t.startsWith("#") ||
             t.startsWith("/*") || t.startsWith("*") || t.startsWith("<!--");
    }).length;
    const commentRatio = loc > 0 ? commentLines / loc : 0;

    // Function detection (regex — worker uses AST-accurate count)
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

    const todoCount      = (content.match(/TODO/gi)     ?? []).length;
    const fixmeCount     = (content.match(/FIXME/gi)    ?? []).length;
    const hackCount      = (content.match(/\bHACK\b/gi) ?? []).length;
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
      astMetrics: null,   // main thread doesn't run Tree-sitter
    });

    const metrics: FileDebtMetrics = {
      filePath, linesOfCode: loc, commentLines,
      commentRatio: Math.round(commentRatio * 100) / 100,
      functionCount, avgFunctionLength, maxFunctionLength,
      todoCount, fixmeCount, hackCount,
      sizeRiskScore, dependencyDepth, fileScore,
      isUtilityFile, isTestFile,
      astMetrics: null,
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
          const workerMetrics: FileDebtMetrics[] = event.data.fileMetrics ?? [];
          discovery.fromCache = event.data.fromCache ?? 0;
          resolve(this.buildResult(workerMetrics, discovery));
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
  ): ProjectDebtAnalysis {
    const sorted = [...metrics].sort((a, b) => a.fileScore - b.fileScore);

    // Hotspot candidates: non-utility, non-tiny files only
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
    };
  }
}

// ── Singleton ──────────────────────────────────────────────────────────────────

let instance: DebtAnalyzer | null = null;

export function getDebtAnalyzer(): DebtAnalyzer {
  if (!instance) instance = new DebtAnalyzer();
  return instance;
}

// ── Re-exports for worker ──────────────────────────────────────────────────────

export { isSourceFile, classifyFile, computeFileScore, sha256, THRESHOLDS };
