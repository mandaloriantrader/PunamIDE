/**
 * DebtScorer.ts — Phase 7, Step 7.2
 *
 * Weighted composite technical debt score (0–100) with trend tracking
 * and per-module breakdown. Builds on DebtAnalyzer's file-level scores.
 */

import type { DebtReport, DebtGrade, FileDebtScore, ModuleDebtScore } from "./DebtAnalyzer";
import { DebtAnalyzer } from "./DebtAnalyzer";
import type { ArchitectureMap } from "../architecture/ArchitectureMap";

// ── Types ──────────────────────────────────────────────────────────────────────

export interface TrendPoint {
  timestamp: number;
  overallScore: number;
  grade: DebtGrade;
  totalFiles: number;
  topIssue: string;
}

export interface WeightedScore {
  overallScore: number;
  overallGrade: DebtGrade;
  trend: TrendPoint[];
  modules: ModuleDebtScore[];
  changeFromLast: number; // positive = improving, negative = worsening
  summary: string;
}

// ── DebtScorer ─────────────────────────────────────────────────────────────────

export class DebtScorer {
  private history: TrendPoint[] = [];
  private analyzer: DebtAnalyzer;

  constructor(archMap: ArchitectureMap) {
    this.analyzer = new DebtAnalyzer(archMap);
  }

  /**
   * Score the project and add to trend history.
   */
  score(files: Map<string, string>): WeightedScore {
    const report = this.analyzer.analyzeAllFiles(files);

    const point: TrendPoint = {
      timestamp: Date.now(),
      overallScore: report.overallScore,
      grade: report.overallGrade,
      totalFiles: report.totalFiles,
      topIssue: report.topIssues[0] || "None",
    };

    this.history.push(point);
    if (this.history.length > 200) {
      this.history = this.history.slice(-200);
    }

    const lastScore = this.history.length >= 2
      ? this.history[this.history.length - 2].overallScore
      : report.overallScore;

    const changeFromLast = lastScore - report.overallScore; // positive = improved

    const summary = this.generateSummary(report, changeFromLast);

    return {
      overallScore: report.overallScore,
      overallGrade: report.overallGrade,
      trend: [...this.history],
      modules: report.moduleScores,
      changeFromLast,
      summary,
    };
  }

  /**
   * Score the project using a Web Worker (non-blocking).
   * Falls back to sync score() if the worker is unavailable.
   */
  async scoreAsync(files: Map<string, string>): Promise<WeightedScore> {
    const report = await this.analyzer.analyzeAllFilesAsync(files);

    const point: TrendPoint = {
      timestamp: Date.now(),
      overallScore: report.overallScore,
      grade: report.overallGrade,
      totalFiles: report.totalFiles,
      topIssue: report.topIssues[0] || "None",
    };

    this.history.push(point);
    if (this.history.length > 200) {
      this.history = this.history.slice(-200);
    }

    const lastScore = this.history.length >= 2
      ? this.history[this.history.length - 2].overallScore
      : report.overallScore;

    const changeFromLast = lastScore - report.overallScore;

    const summary = this.generateSummary(report, changeFromLast);

    return {
      overallScore: report.overallScore,
      overallGrade: report.overallGrade,
      trend: [...this.history],
      modules: report.moduleScores,
      changeFromLast,
      summary,
    };
  }

  /**
   * Get trend history.
   */
  getTrend(): TrendPoint[] {
    return this.history;
  }

  /**
   * Get the score for a specific module.
   */
  getModuleScore(moduleName: string, files: Map<string, string>): ModuleDebtScore | null {
    const report = this.analyzer.analyzeAllFiles(files);
    return report.moduleScores.find((m) => m.module === moduleName) || null;
  }

  private generateSummary(report: DebtReport, change: number): string {
    const parts: string[] = [];

    parts.push(
      `Technical debt score: ${report.overallScore}/100 (Grade ${report.overallGrade}).`
    );

    if (change > 0) {
      parts.push(`Improved by ${Math.round(change)} points from last scan.`);
    } else if (change < 0) {
      parts.push(`Worsened by ${Math.round(Math.abs(change))} points from last scan.`);
    } else {
      parts.push(`No change from last scan.`);
    }

    if (report.hotspots.length > 0) {
      parts.push(
        `Top hotspot: ${report.hotspots[0].file} (${report.hotspots[0].score}/100).`
      );
    }

    if (report.topIssues.length > 0) {
      parts.push(`Most common issue: ${report.topIssues[0]}.`);
    }

    return parts.join(" ");
  }
}

// ── RefactorPlanner (Phase 7, Step 7.3) ───────────────────────────────────────

export interface RefactorTask {
  id: string;
  file: string;
  issue: string;
  estimatedEffort: "low" | "medium" | "high";
  estimatedHours: number;
  impact: "low" | "medium" | "high";
  recommendation: string;
}

export interface RefactorPlan {
  tasks: RefactorTask[];
  totalEstimatedHours: number;
  priorityOrder: string[]; // task IDs in priority order
  summary: string;
}

export class RefactorPlanner {
  /**
   * Generate a refactor plan from debt analysis results.
   */
  generatePlan(report: DebtReport): RefactorPlan {
    const tasks: RefactorTask[] = [];
    let taskCounter = 0;

    for (const file of report.hotspots) {
      const fileScore = report.fileScores.find((f) => f.path === file.file);
      if (!fileScore) continue;

      for (const issue of fileScore.issues) {
        const task: RefactorTask = {
          id: `refactor-${taskCounter++}`,
          file: file.file,
          issue,
          estimatedEffort: this.estimateEffort(fileScore),
          estimatedHours: this.estimateHours(fileScore),
          impact: this.estimateImpact(file.score),
          recommendation: this.generateRecommendation(fileScore, issue),
        };
        tasks.push(task);
      }
    }

    // Sort by impact (high first), then by score (worst first)
    tasks.sort((a, b) => {
      const impactOrder = { high: 3, medium: 2, low: 1 };
      const impactDiff = impactOrder[b.impact] - impactOrder[a.impact];
      if (impactDiff !== 0) return impactDiff;
      const scoreA = report.fileScores.find((f) => f.path === a.file)?.totalScore || 0;
      const scoreB = report.fileScores.find((f) => f.path === b.file)?.totalScore || 0;
      return scoreB - scoreA;
    });

    const totalHours = tasks.reduce((s, t) => s + t.estimatedHours, 0);

    return {
      tasks,
      totalEstimatedHours: totalHours,
      priorityOrder: tasks.map((t) => t.id),
      summary: `Found ${tasks.length} refactor opportunities across ${report.hotspots.length} hotspot files. Estimated ${totalHours} hours total.`,
    };
  }

  private estimateEffort(file: FileDebtScore): RefactorTask["estimatedEffort"] {
    if (file.totalScore >= 80) return "high";
    if (file.totalScore >= 50) return "medium";
    return "low";
  }

  private estimateHours(file: FileDebtScore): number {
    if (file.totalScore >= 80) return 8;
    if (file.totalScore >= 60) return 4;
    if (file.totalScore >= 40) return 2;
    return 1;
  }

  private estimateImpact(score: number): RefactorTask["impact"] {
    if (score >= 70) return "high";
    if (score >= 40) return "medium";
    return "low";
  }

  private generateRecommendation(file: FileDebtScore, issue: string): string {
    if (issue.includes("Large file")) {
      return `Split ${file.path} into smaller modules (< 300 lines each).`;
    }
    if (issue.includes("function")) {
      return `Extract large functions from ${file.path} into separate utility functions.`;
    }
    if (issue.includes("comment")) {
      return `Add JSDoc/docstrings to public functions in ${file.path}.`;
    }
    if (issue.includes("dependency")) {
      return `Reduce coupling in ${file.path} by introducing interfaces or dependency injection.`;
    }
    if (issue.includes("TODO")) {
      return `Address TODO/FIXME markers in ${file.path} — schedule or remove stale ones.`;
    }
    if (issue.includes("test")) {
      return `Add unit tests for ${file.path} — see Phase 5 Test Agent for automated generation.`;
    }
    if (issue.includes("duplicat")) {
      return `Extract duplicated code from ${file.path} into a shared utility module.`;
    }
    return `Review and refactor ${file.path} to reduce technical debt.`;
  }
}