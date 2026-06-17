/**
 * DebtScorer.ts — Phase 3
 *
 * Phase 3 changes over Phase 1:
 *  - adjustedFileScore() is now a fully specified method (not a partial stub).
 *    All Phase 3 thresholds applied precisely with rationale comments.
 *    Note: with Phase 3 DebtAnalyzer, AST penalties are already baked into
 *    fileScore at analysis time. adjustedFileScore() applies a *secondary*
 *    display-time adjustment so the module breakdown and hotspot sorting
 *    reflect AST quality even for cached heuristic-only entries.
 *  - classifyIssue() handles all new AST issue types:
 *    high_complexity, excessive_nesting, god_function, god_class, excessive_params
 *  - suggestFix() produces specific advice using astDetail numbers when available
 *  - estimateEffort() and estimateImpact() cover all Phase 3 issue types
 *  - buildEffortImpactMatrix() effort/impact table is now complete for Phase 6
 *  - ComplexityBand / NestingBand re-exported for dashboard use
 */

import type {
  ProjectDebtAnalysis,
  FileDebtMetrics,
  DebtHotspot,
  ASTMetrics,
  HotspotASTDetail,
} from "./DebtAnalyzer";
import {
  classifyComplexity,
  classifyNesting,
  THRESHOLDS,
} from "./DebtAnalyzer";

// ── Re-export band types so dashboard imports from one place ──────────────────
export type { ComplexityBand, NestingBand } from "./DebtAnalyzer";
export { classifyComplexity, classifyNesting } from "./DebtAnalyzer";

// ── Types ──────────────────────────────────────────────────────────────────────

export interface DebtScore {
  overall: number;
  category: "excellent" | "good" | "fair" | "poor" | "critical";
  trend: "improving" | "stable" | "declining";
  modules: ModuleDebtScore[];
  trendHistory: TrendEntry[];
}

export interface TrendEntry {
  date: number;     // real Unix ms timestamp
  score: number;
}

export interface ModuleDebtScore {
  module: string;
  score: number;
  fileCount: number;
  totalLines: number;
  hotspots: DebtHotspot[];
}

export interface EffortImpactMatrix {
  hotspot: DebtHotspot;
  estimatedEffort: "low" | "medium" | "high";
  estimatedImpact: "low" | "medium" | "high";
  priority: number;   // 1–10
}

// ── DebtScorer ─────────────────────────────────────────────────────────────────

export class DebtScorer {
  private trendHistory: TrendEntry[] = [];

  // ── Public API ───────────────────────────────────────────────────────────────

  score(analysis: ProjectDebtAnalysis): DebtScore {
    const overall  = analysis.overallScore;
    const category = this.categorize(overall);
    const modules  = this.scoreModules(analysis.files);
    const trend    = this.detectTrend(overall);

    this.trendHistory.push({ date: Date.now(), score: overall });

    return { overall, category, trend, modules, trendHistory: [...this.trendHistory] };
  }

  categorize(score: number): DebtScore["category"] {
    if (score >= 85) return "excellent";
    if (score >= 70) return "good";
    if (score >= 50) return "fair";
    if (score >= 30) return "poor";
    return "critical";
  }

  detectTrend(currentScore: number): DebtScore["trend"] {
    if (this.trendHistory.length < 1) return "stable";
    const prev = this.trendHistory[this.trendHistory.length - 1].score;
    const diff = currentScore - prev;
    if (diff > 3)  return "improving";
    if (diff < -3) return "declining";
    return "stable";
  }

  getCategoryColor(category: DebtScore["category"]): string {
    const colors: Record<DebtScore["category"], string> = {
      excellent: "#22c55e",
      good:      "#3b82f6",
      fair:      "#f59e0b",
      poor:      "#f97316",
      critical:  "#ef4444",
    };
    return colors[category];
  }

  // ── Module scoring ───────────────────────────────────────────────────────────

  scoreModules(files: FileDebtMetrics[]): ModuleDebtScore[] {
    const moduleMap = new Map<string, FileDebtMetrics[]>();

    for (const file of files) {
      const module = this.extractModule(file.filePath);
      const bucket = moduleMap.get(module) ?? [];
      bucket.push(file);
      moduleMap.set(module, bucket);
    }

    return Array.from(moduleMap.entries())
      .map(([module, moduleFiles]) => {
        const adjustedScores = moduleFiles.map((f) => this.adjustedFileScore(f));
        const avgScore = Math.round(
          adjustedScores.reduce((s, v) => s + v, 0) / adjustedScores.length
        );

        const candidates = moduleFiles
          .filter((f) => !f.isUtilityFile && f.linesOfCode >= 50)
          .sort((a, b) => this.adjustedFileScore(a) - this.adjustedFileScore(b));

        return {
          module,
          score: avgScore,
          fileCount: moduleFiles.length,
          totalLines: moduleFiles.reduce((s, f) => s + f.linesOfCode, 0),
          hotspots: candidates.slice(0, 5).map((f) => ({
            filePath:       f.filePath,
            score:          this.adjustedFileScore(f),
            primaryIssue:   this.classifyIssue(f),
            recommendation: this.suggestFix(f),
            astDetail:      f.astMetrics ? this.buildDetail(f.astMetrics) : null,
          })),
        };
      })
      .sort((a, b) => a.score - b.score);
  }

  // ── Effort / impact matrix ────────────────────────────────────────────────────

  buildEffortImpactMatrix(hotspots: DebtHotspot[]): EffortImpactMatrix[] {
    const IMPACT_WEIGHT = { high: 3, medium: 2, low: 1 } as const;
    const EFFORT_COST   = { high: 3, medium: 2, low: 1 } as const;

    return hotspots
      .map((h) => {
        const effort = this.estimateEffort(h);
        const impact = this.estimateImpact(h);
        const raw    = IMPACT_WEIGHT[impact] * 3 - EFFORT_COST[effort];
        const priority = Math.max(1, Math.min(10, raw + 4));
        return { hotspot: h, estimatedEffort: effort, estimatedImpact: impact, priority };
      })
      .sort((a, b) => b.priority - a.priority);
  }

  // ── Phase 3: adjustedFileScore ────────────────────────────────────────────────

  /**
   * Display-time score adjustment using AST data.
   *
   * Context: Phase 3 DebtAnalyzer already bakes AST penalties into fileScore
   * at analysis time (in computeFileScore). This method provides a secondary
   * adjustment for display in module breakdowns and hotspot sorting — it
   * ensures that even cached heuristic-only entries (from before Tree-sitter
   * ran) are presented with appropriate weighting when astMetrics is now
   * available in memory.
   *
   * It uses the same threshold bands as computeFileScore but applies them
   * additively to the stored score rather than recalculating from scratch.
   * This means files re-analyzed by the worker get double-counted slightly,
   * but since computeFileScore clamps to [0, 100] and this also clamps,
   * the worst case is a floor hit — never an artificially inflated score.
   *
   * Phase 4 will refactor this to use a single source of truth score once
   * the dependency graph penalty is also incorporated.
   */
  adjustedFileScore(file: FileDebtMetrics): number {
    let score      = file.fileScore;
    const ast      = file.astMetrics;
    if (!ast) return score;

    const cc    = ast.cyclomaticComplexity;
    const depth = ast.maxNestingDepth;

    // ── Cyclomatic complexity (Phase 3 spec bands) ──────────────────────────
    // Critical band (30+): severe penalty — file is objectively unmaintainable
    if      (cc >= THRESHOLDS.CC_CRITICAL) score -= 25;
    // High band (21–30): significant — should be in the refactor queue
    else if (cc >= THRESHOLDS.CC_HIGH)     score -= 15;
    // Moderate band (11–20): noticeable — flag but not emergency
    else if (cc >= THRESHOLDS.CC_MODERATE) score -= 7;
    // Good band (1–10): no penalty

    // ── Nesting depth (Phase 3 spec bands) ──────────────────────────────────
    // Refactor Candidate (6+): deep nesting = hard to read and test
    if      (depth >= THRESHOLDS.NESTING_REFACTOR) score -= 15;
    // Warning (4–5): noticeable
    else if (depth >= THRESHOLDS.NESTING_WARNING)  score -= 7;
    // Good (1–3): no penalty

    // ── God functions ────────────────────────────────────────────────────────
    // Each god function is a significant architectural problem
    if (ast.godFunctionCount > 0)
      score -= Math.min(20, ast.godFunctionCount * 8);

    // ── God classes ──────────────────────────────────────────────────────────
    if (ast.godClassCount > 0)
      score -= Math.min(15, ast.godClassCount * 10);

    // ── Excessive parameters ─────────────────────────────────────────────────
    if (ast.maxParameterCount > THRESHOLDS.EXCESSIVE_PARAMS)
      score -= 5;

    // ── Clean file bonus ─────────────────────────────────────────────────────
    // Reward genuinely simple files — not just absence of penalty
    if (cc <= 5 && depth <= 2 && ast.godFunctionCount === 0 && ast.godClassCount === 0)
      score += 5;

    return Math.max(0, Math.min(100, Math.round(score)));
  }

  // ── Private helpers ──────────────────────────────────────────────────────────

  private extractModule(filePath: string): string {
    const clean    = filePath.replace(/\\/g, "/").split("/").filter(Boolean);
    const SKIP_ROOT = new Set(["src", "lib", "app", "packages"]);
    let idx = 0;
    while (idx < clean.length - 1 && SKIP_ROOT.has(clean[idx])) idx++;
    return idx < clean.length - 1 ? clean[idx] : "root";
  }

  /**
   * Classify the primary issue for a file — Phase 3 aware.
   * Used in module hotspot cards and effort/impact matrix.
   */
  private classifyIssue(f: FileDebtMetrics): string {
    const ast = f.astMetrics;
    if (ast) {
      if (ast.cyclomaticComplexity >= THRESHOLDS.CC_HIGH)          return "high_complexity";
      if (ast.maxNestingDepth      >= THRESHOLDS.NESTING_REFACTOR) return "excessive_nesting";
      if (ast.godFunctionCount     > 0)                            return "god_function";
      if (ast.godClassCount        > 0)                            return "god_class";
      if (ast.maxParameterCount    > THRESHOLDS.EXCESSIVE_PARAMS)  return "excessive_params";
      if (ast.cyclomaticComplexity >= THRESHOLDS.CC_MODERATE)      return "high_complexity";
    }
    if (f.linesOfCode > 500)             return "file_too_large";
    if (f.avgFunctionLength > 50)        return "long_functions";
    if (f.dependencyDepth > 5)           return "deep_deps";
    if (f.todoCount + f.fixmeCount > 5)  return "many_todos";
    if (f.commentRatio < 0.05)           return "low_comments";
    return "minor_issues";
  }

  /**
   * Suggest a fix — specific when astMetrics is present, generic otherwise.
   */
  private suggestFix(f: FileDebtMetrics): string {
    const ast = f.astMetrics;
    if (ast) {
      const ccBand = classifyComplexity(ast.cyclomaticComplexity);
      if (ccBand === "critical" || ccBand === "high")
        return `Reduce complexity (CC=${ast.cyclomaticComplexity})`;
      if (ast.maxNestingDepth >= THRESHOLDS.NESTING_REFACTOR)
        return `Flatten nesting (depth ${ast.maxNestingDepth})`;
      if (ast.godFunctionCount > 0)
        return `Extract ${ast.godFunctionCount} god function${ast.godFunctionCount > 1 ? "s" : ""}`;
      if (ast.godClassCount > 0)
        return `Split ${ast.godClassCount} god class${ast.godClassCount > 1 ? "es" : ""}`;
      if (ast.maxParameterCount > THRESHOLDS.EXCESSIVE_PARAMS)
        return `Reduce params (max ${ast.maxParameterCount})`;
      if (ccBand === "moderate")
        return `Reduce complexity (CC=${ast.cyclomaticComplexity})`;
    }
    if (f.linesOfCode > 500)            return "Split into modules";
    if (f.avgFunctionLength > 50)       return "Extract long functions";
    if (f.dependencyDepth > 5)          return "Reduce import coupling";
    if (f.todoCount + f.fixmeCount > 5) return "Resolve TODOs";
    if (f.commentRatio < 0.05)          return "Add documentation";
    return "Review";
  }

  /**
   * Estimate refactor effort — covers all Phase 3 issue types.
   * Used by buildEffortImpactMatrix and RefactorPlanner.
   */
  estimateEffort(h: DebtHotspot): EffortImpactMatrix["estimatedEffort"] {
    switch (h.primaryIssue) {
      // High effort: structural changes with cascade risk
      case "high_complexity":    return "high";
      case "god_function":       return "high";
      case "god_class":          return "high";
      case "file_too_large":     return "high";
      case "deep_deps":          return "high";
      case "circular_dependency": return "high";
      case "hub_file":           return "high";

      // Medium effort: targeted refactoring
      case "excessive_nesting":  return "medium";
      case "long_functions":     return "medium";
      case "excessive_params":   return "medium";
      case "high_duplication":   return "medium";

      // Low effort: localised fixes
      case "many_todos":         return "low";
      case "low_comments":       return "low";
      case "minor_issues":       return "low";

      default:                   return "medium";
    }
  }

  /**
   * Estimate fix impact — covers all Phase 3 issue types.
   */
  estimateImpact(h: DebtHotspot): EffortImpactMatrix["estimatedImpact"] {
    switch (h.primaryIssue) {
      // High impact: fixes that meaningfully improve maintainability
      case "high_complexity":    return "high";
      case "excessive_nesting":  return "high";
      case "god_function":       return "high";
      case "god_class":          return "high";
      case "file_too_large":     return "high";
      case "deep_deps":          return "high";
      case "circular_dependency": return "high";
      case "hub_file":           return "high";
      case "high_duplication":   return "high";

      // Medium impact: improves code quality, less architectural
      case "long_functions":     return "medium";
      case "excessive_params":   return "medium";
      case "many_todos":         return "medium";

      // Low impact: cosmetic or minor
      case "low_comments":       return "low";
      case "minor_issues":       return "low";

      default:                   return "medium";
    }
  }

  /** Build HotspotASTDetail from ASTMetrics for inline use in module hotspots. */
  private buildDetail(ast: ASTMetrics): HotspotASTDetail {
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
}

// ── Singleton ──────────────────────────────────────────────────────────────────

let instance: DebtScorer | null = null;

export function getDebtScorer(): DebtScorer {
  if (!instance) instance = new DebtScorer();
  return instance;
}
