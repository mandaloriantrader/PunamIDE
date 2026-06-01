/**
 * RefactorPlanner.ts — Phase 7, Step 7.3
 *
 * Given debt hotspots, generates a prioritized refactor plan with
 * estimated effort, risk level, and expected impact.
 * Uses DebtAnalyzer analysis + DebtScorer scoring for recommendations.
 */

import type { DebtHotspot, ProjectDebtAnalysis } from "./DebtAnalyzer";
import type { EffortImpactMatrix } from "./DebtScorer";
import { getDebtScorer } from "./DebtScorer";

// ── Types ──────────────────────────────────────────────────────────────────────

export interface RefactorPlanItem {
  filePath: string;
  issue: string;
  recommendation: string;
  estimatedEffort: "low" | "medium" | "high"; // <2h, 2-8h, >8h
  estimatedRisk: "low" | "medium" | "high";
  estimatedImpact: "low" | "medium" | "high";
  priority: number; // 1-10, higher = should fix first
  effortHours: number; // estimated hours
  dependencies: string[]; // files that should be refactored first
}

export interface RefactorPlan {
  items: RefactorPlanItem[];
  totalEstimatedHours: number;
  quickWins: RefactorPlanItem[]; // low effort, high impact
  majorInitiatives: RefactorPlanItem[]; // high effort, high impact
  housekeeping: RefactorPlanItem[]; // low effort, low impact
  generatedAt: number;
}

// ── RefactorPlanner Class ──────────────────────────────────────────────────────

export class RefactorPlanner {
  private scorer = getDebtScorer();

  /**
   * Generate a complete refactor plan from debt analysis.
   */
  generatePlan(analysis: ProjectDebtAnalysis): RefactorPlan {
    const matrix = this.scorer.buildEffortImpactMatrix(analysis.hotspots);

    const items: RefactorPlanItem[] = matrix.map((item) => ({
      filePath: item.hotspot.filePath,
      issue: item.hotspot.primaryIssue,
      recommendation: item.hotspot.recommendation,
      estimatedEffort: item.estimatedEffort,
      estimatedRisk: this.estimateRisk(item.hotspot),
      estimatedImpact: item.estimatedImpact,
      priority: item.priority,
      effortHours: this.effortToHours(item.estimatedEffort),
      dependencies: [],
    }));

    // Sort by priority
    items.sort((a, b) => b.priority - a.priority);

    // Compute dependencies: if file A imports file B, B should be refactored first
    // (simplified: same directory files are interdependent)
    for (const item of items) {
      item.dependencies = items
        .filter(
          (other) =>
            other.filePath !== item.filePath &&
            this.sharesDirectory(item.filePath, other.filePath) &&
            other.priority > item.priority
        )
        .map((o) => o.filePath)
        .slice(0, 3);
    }

    // Categorize
    const quickWins = items.filter(
      (i) => i.estimatedEffort === "low" && i.estimatedImpact === "high"
    );
    const majorInitiatives = items.filter(
      (i) => i.estimatedEffort === "high" && i.estimatedImpact === "high"
    );
    const housekeeping = items.filter(
      (i) => i.estimatedEffort === "low" && i.estimatedImpact === "low"
    );

    const totalEstimatedHours = items.reduce((sum, i) => sum + i.effortHours, 0);

    return {
      items,
      totalEstimatedHours,
      quickWins,
      majorInitiatives,
      housekeeping,
      generatedAt: Date.now(),
    };
  }

  /**
   * Estimate risk of refactoring a file.
   */
  estimateRisk(hotspot: DebtHotspot): "low" | "medium" | "high" {
    switch (hotspot.primaryIssue) {
      case "file_too_large":
        return "high"; // large files = high risk to split
      case "deep_deps":
        return "high"; // changing deps = cascade risk
      case "long_functions":
        return "medium";
      case "many_todos":
        return "medium";
      case "low_comments":
        return "low"; // adding comments = safe
      default:
        return "low";
    }
  }

  /**
   * Rough hour estimate from effort category.
   */
  private effortToHours(effort: "low" | "medium" | "high"): number {
    switch (effort) {
      case "low": return 1.5;
      case "medium": return 5;
      case "high": return 12;
    }
  }

  /**
   * Check if two files share a directory (simple heuristic for dependency).
   */
  private sharesDirectory(fileA: string, fileB: string): boolean {
    const dirA = fileA.replace(/\\/g, "/").split("/").slice(0, -1).join("/");
    const dirB = fileB.replace(/\\/g, "/").split("/").slice(0, -1).join("/");
    return dirA === dirB;
  }
}

// ── Singleton ──────────────────────────────────────────────────────────────────

let instance: RefactorPlanner | null = null;

export function getRefactorPlanner(): RefactorPlanner {
  if (!instance) {
    instance = new RefactorPlanner();
  }
  return instance;
}