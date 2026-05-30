/**
 * DebtScorer.ts — Phase 7, Step 7.2
 *
 * Weighted composite scoring model for technical debt (0-100 scale).
 * Trend tracking, per-module breakdown, historical comparisons.
 * Uses DebtAnalyzer metrics to compute project-wide and per-category scores.
 */

import type { ProjectDebtAnalysis, FileDebtMetrics, DebtHotspot } from "./DebtAnalyzer";

// ── Types ──────────────────────────────────────────────────────────────────────

export interface DebtScore {
  overall: number; // 0-100, higher = less debt
  category: "excellent" | "good" | "fair" | "poor" | "critical";
  trend: "improving" | "stable" | "declining";
  modules: ModuleDebtScore[];
  trendHistory: { date: number; score: number }[];
}

export interface ModuleDebtScore {
  module: string; // e.g., "src/services", "src/components"
  score: number;
  fileCount: number;
  totalLines: number;
  hotspots: DebtHotspot[];
}

export interface EffortImpactMatrix {
  hotspot: DebtHotspot;
  estimatedEffort: "low" | "medium" | "high"; // hours: <2, 2-8, >8
  estimatedImpact: "low" | "medium" | "high";
  priority: number; // 1-10, higher = should fix first
}

// ── DebtScorer Class ───────────────────────────────────────────────────────────

export class DebtScorer {
  private history: DebtScore[] = [];

  /**
   * Compute a weighted debt score from project analysis.
   */
  score(analysis: ProjectDebtAnalysis): DebtScore {
    const overall = analysis.overallScore;
    const category = this.categorize(overall);
    const modules = this.scoreModules(analysis.files);
    const trend = this.detectTrend(overall);

    // Store in history
    this.history.push({ overall, category, trend, modules, trendHistory: [] });

    return { overall, category, trend, modules, trendHistory: this.getTrendHistory() };
  }

  /**
   * Categorize a score into human-readable labels.
   */
  categorize(score: number): DebtScore["category"] {
    if (score >= 85) return "excellent";
    if (score >= 70) return "good";
    if (score >= 50) return "fair";
    if (score >= 30) return "poor";
    return "critical";
  }

  /**
   * Score by module/package (group files by top-level directory).
   */
  scoreModules(files: FileDebtMetrics[]): ModuleDebtScore[] {
    const moduleMap = new Map<string, FileDebtMetrics[]>();

    for (const file of files) {
      // Extract module: first 2 path segments
      const parts = file.filePath.replace(/\\/g, "/").split("/");
      const module = parts.slice(0, 2).join("/") || "root";

      const existing = moduleMap.get(module) || [];
      existing.push(file);
      moduleMap.set(module, existing);
    }

    return Array.from(moduleMap.entries())
      .map(([module, moduleFiles]) => {
        const avgScore = Math.round(
          moduleFiles.reduce((s, f) => s + f.fileScore, 0) / moduleFiles.length
        );
        const sorted = [...moduleFiles].sort((a, b) => a.fileScore - b.fileScore);

        return {
          module,
          score: avgScore,
          fileCount: moduleFiles.length,
          totalLines: moduleFiles.reduce((s, f) => s + f.linesOfCode, 0),
          hotspots: sorted.slice(0, 5).map((f) => ({
            filePath: f.filePath,
            score: f.fileScore,
            primaryIssue: this.classifyIssue(f),
            recommendation: this.suggestFix(f),
          })),
        };
      })
      .sort((a, b) => a.score - b.score); // worst module first
  }

  /**
   * Build effort/impact matrix for refactor planning.
   */
  buildEffortImpactMatrix(hotspots: DebtHotspot[]): EffortImpactMatrix[] {
    return hotspots.map((h) => {
      const effort = this.estimateEffort(h);
      const impact = this.estimateImpact(h);

      // Priority = impact weight - effort weight (higher = fix first)
      const impactScore = impact === "high" ? 10 : impact === "medium" ? 6 : 2;
      const effortScore = effort === "high" ? 3 : effort === "medium" ? 2 : 1;
      const priority = impactScore - effortScore;

      return {
        hotspot: h,
        estimatedEffort: effort,
        estimatedImpact: impact,
        priority: Math.max(1, Math.min(10, priority)),
      };
    }).sort((a, b) => b.priority - a.priority);
  }

  /**
   * Detect trend from score history.
   */
  detectTrend(currentScore: number): DebtScore["trend"] {
    if (this.history.length < 2) return "stable";

    const prevScore = this.history[this.history.length - 2].overall;
    const diff = currentScore - prevScore;

    if (diff > 3) return "improving";
    if (diff < -3) return "declining";
    return "stable";
  }

  /**
   * Get trend history for charting.
   */
  getTrendHistory(): { date: number; score: number }[] {
    return this.history.map((h) => ({
      date: Date.now() - (this.history.length - this.history.indexOf(h)) * 86400000,
      score: h.overall,
    }));
  }

  /**
   * Get category color for UI rendering.
   */
  getCategoryColor(category: DebtScore["category"]): string {
    switch (category) {
      case "excellent": return "#22c55e"; // green
      case "good": return "#3b82f6"; // blue
      case "fair": return "#f59e0b"; // amber
      case "poor": return "#f97316"; // orange
      case "critical": return "#ef4444"; // red
    }
  }

  private classifyIssue(f: FileDebtMetrics): string {
    if (f.linesOfCode > 500) return "file_too_large";
    if (f.commentRatio < 0.05) return "low_comments";
    if (f.avgFunctionLength > 50) return "long_functions";
    return "minor_issues";
  }

  private suggestFix(f: FileDebtMetrics): string {
    if (f.linesOfCode > 500) return "Split into modules";
    if (f.commentRatio < 0.05) return "Add documentation";
    if (f.todoCount > 5) return "Resolve TODOs";
    return "Review";
  }

  private estimateEffort(h: DebtHotspot): EffortImpactMatrix["estimatedEffort"] {
    switch (h.primaryIssue) {
      case "file_too_large": return "high";
      case "long_functions": return "medium";
      case "deep_deps": return "high";
      case "many_todos": return "low";
      case "low_comments": return "low";
      default: return "medium";
    }
  }

  private estimateImpact(h: DebtHotspot): EffortImpactMatrix["estimatedImpact"] {
    switch (h.primaryIssue) {
      case "file_too_large": return "high";
      case "long_functions": return "high";
      case "deep_deps": return "high";
      case "many_todos": return "medium";
      case "low_comments": return "low";
      default: return "medium";
    }
  }
}

// ── Singleton ──────────────────────────────────────────────────────────────────

let instance: DebtScorer | null = null;

export function getDebtScorer(): DebtScorer {
  if (!instance) {
    instance = new DebtScorer();
  }
  return instance;
}