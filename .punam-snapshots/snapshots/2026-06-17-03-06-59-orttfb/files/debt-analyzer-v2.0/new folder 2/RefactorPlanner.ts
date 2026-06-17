/**
 * RefactorPlanner.ts — Phase 4
 *
 * Phase 4 changes:
 *  - DependencyGraph stub replaced with real GraphBundle from DebtAnalyzer
 *  - generatePlan() accepts GraphBundle directly from ProjectDebtAnalysis
 *  - buildArchitecturalItems() now uses real cycle + hub data from
 *    CircularDepDetector and CouplingAnalyzer
 *  - Circular dependency items include the full cycle path
 *  - Hub file items include real fan-in/fan-out/coupling scores
 *  - estimateRisk/estimateEffort/estimateImpact cover all Phase 4 issue types
 */

import type { DebtHotspot, ProjectDebtAnalysis, HotspotASTDetail, GraphBundle } from "./DebtAnalyzer";
import type { EffortImpactMatrix } from "./DebtScorer";
import { getDebtScorer } from "./DebtScorer";

// ── Types ──────────────────────────────────────────────────────────────────────

export interface RefactorPlanItem {
  filePath: string;
  issue: string;
  recommendation: string;
  category: "quick_win" | "major_refactor" | "maintenance" | "architectural";
  estimatedEffort: "low" | "medium" | "high";
  estimatedRisk:   "low" | "medium" | "high";
  estimatedImpact: "low" | "medium" | "high";
  priority: number;
  effortLabel: string;
  effortHours: number;
  dependencies: string[];
  whyFlagged: string;
  expectedPayoff: string;
  astDetail: HotspotASTDetail | null;   // Phase 3: passed through from DebtHotspot
}

export interface RefactorPlan {
  items: RefactorPlanItem[];
  totalEstimatedHours: number;

  // Four categories from the spec
  quickWins: RefactorPlanItem[];         // low effort, high impact
  majorRefactors: RefactorPlanItem[];    // high effort, high impact
  maintenance: RefactorPlanItem[];       // low effort, low impact
  architecturalIssues: RefactorPlanItem[]; // dependency/coupling problems

  generatedAt: number;
}

// ── RefactorPlanner ────────────────────────────────────────────────────────────

export class RefactorPlanner {
  private scorer = getDebtScorer();

  /**
   * Generate a complete prioritized refactor plan.
   *
   * @param analysis  Output of DebtAnalyzer.analyzeProject()
   * @param depGraph  Optional — pass Phase 4 graph for architectural items
   */
  /**
   * Generate a complete prioritized refactor plan.
   * Phase 4: reads graph data from analysis.graph (set by applyGraphData).
   */
  generatePlan(analysis: ProjectDebtAnalysis): RefactorPlan {
    const matrix = this.scorer.buildEffortImpactMatrix(analysis.hotspots);

    const items: RefactorPlanItem[] = matrix.map((entry) =>
      this.buildItem(entry, analysis)
    );

    // Phase 4: inject architectural items from real graph
    if (analysis.graph) {
      const archItems = this.buildArchitecturalItems(analysis.graph, analysis);
      const existingPaths = new Set(items.map((i) => i.filePath));
      for (const arch of archItems) {
        if (!existingPaths.has(arch.filePath)) {
          items.push(arch);
          existingPaths.add(arch.filePath);
        } else {
          // Upgrade existing item to architectural
          const existing = items.find((i) => i.filePath === arch.filePath);
          if (existing) {
            existing.category   = 'architectural';
            existing.priority   = Math.max(existing.priority, arch.priority);
            existing.whyFlagged = arch.whyFlagged;
          }
        }
      }
    }

    items.sort((a, b) => b.priority - a.priority);
    this.resolveDependencies(items);

    const quickWins           = items.filter((i) => i.category === "quick_win");
    const majorRefactors      = items.filter((i) => i.category === "major_refactor");
    const maintenance         = items.filter((i) => i.category === "maintenance");
    const architecturalIssues = items.filter((i) => i.category === "architectural");
    const totalEstimatedHours = Math.round(items.reduce((s, i) => s + i.effortHours, 0) * 10) / 10;

    return {
      items,
      totalEstimatedHours,
      quickWins,
      majorRefactors,
      maintenance,
      architecturalIssues,
      generatedAt: Date.now(),
    };
  }

  // ── Item builders ─────────────────────────────────────────────────────────────

  private buildItem(
    entry: EffortImpactMatrix,
    analysis: ProjectDebtAnalysis,
  ): RefactorPlanItem {
    const { hotspot, estimatedEffort, estimatedImpact, priority } = entry;
    const estimatedRisk = this.estimateRisk(hotspot, analysis);
    const category = this.categorize(estimatedEffort, estimatedImpact, hotspot.primaryIssue);
    const { effortLabel, effortHours } = this.effortDetails(estimatedEffort);

    return {
      filePath: hotspot.filePath,
      issue: hotspot.primaryIssue,
      recommendation: hotspot.recommendation,
      category,
      estimatedEffort,
      estimatedRisk,
      estimatedImpact,
      priority,
      effortLabel,
      effortHours,
      dependencies: [],
      whyFlagged: this.whyFlagged(hotspot),
      expectedPayoff: this.expectedPayoff(hotspot),
      astDetail: hotspot.astDetail ?? null,
    };
  }

  private buildArchitecturalItems(
    graph: GraphBundle,
    _analysis: ProjectDebtAnalysis,
  ): RefactorPlanItem[] {
    const items: RefactorPlanItem[] = [];
    const { dependencyGraph, couplingAnalysis } = graph;

    // ── Circular dependencies ───────────────────────────────────────────────
    // Import cycle data from graph.nodes — files with isInCycle=true
    const cycleFiles = [...dependencyGraph.nodes.values()]
      .filter((n) => couplingAnalysis.files.find(
        (c) => c.filePath === n.filePath && c.isInCycle
      ));

    // Group cycle members by finding their strongly connected components
    // We don't re-run Tarjan here — use the coupling data's isInCycle flag
    // and group files that import each other
    const cycleGroups = this.groupCycleFiles(cycleFiles.map((n) => n.filePath), dependencyGraph);

    for (const cycle of cycleGroups) {
      const filePath = cycle[0];
      items.push({
        filePath,
        issue: "circular_dependency",
        recommendation: `Break circular import cycle: ${cycle.slice(0, 4).join(" → ")}${cycle.length > 4 ? ` (+${cycle.length - 4} more)` : ""}`,
        category: "architectural",
        estimatedEffort: "high",
        estimatedRisk:   "high",
        estimatedImpact: "high",
        priority: 9,
        effortLabel: "Multi-day",
        effortHours: 16,
        dependencies: cycle.slice(1, 4),
        whyFlagged: `Circular import chain (${cycle.length} file${cycle.length > 1 ? "s" : ""}) — causes unpredictable module initialization and blocks tree-shaking`,
        expectedPayoff: "Eliminates runtime import errors, enables dead code elimination, reduces bundle size",
        astDetail: null,
      });
    }

    // ── Hub files ────────────────────────────────────────────────────────────
    for (const hubPath of couplingAnalysis.hubFiles) {
      const node     = dependencyGraph.nodes.get(hubPath);
      const coupling = couplingAnalysis.couplingScores[hubPath] ?? 0;
      const fanIn    = node?.fanIn  ?? 0;
      const fanOut   = node?.fanOut ?? 0;

      items.push({
        filePath:    hubPath,
        issue:       "hub_file",
        recommendation: "Decompose into smaller, focused modules with single responsibilities",
        category:   "architectural",
        estimatedEffort: "high",
        estimatedRisk:   "high",
        estimatedImpact: "high",
        priority: 8,
        effortLabel: "Multi-day",
        effortHours: 12,
        dependencies: [],
        whyFlagged: `Hub file — imported by ${fanIn} files, imports ${fanOut} files (coupling score ${coupling}). Any change here risks cascading failures.`,
        expectedPayoff: "Reduces cascade change risk, makes modules independently testable and deployable",
        astDetail: null,
      });
    }

    return items;
  }

  /**
   * Group cycle member files into clusters by mutual imports.
   * Simple approach: files that import each other form a group.
   * Returns an array of groups, each group is a list of file paths.
   */
  private groupCycleFiles(
    cycleFiles: string[],
    graph: import('./DependencyGraphEngine').DependencyGraph,
  ): string[][] {
    if (cycleFiles.length === 0) return [];

    const visited  = new Set<string>();
    const groups:  string[][] = [];

    for (const file of cycleFiles) {
      if (visited.has(file)) continue;

      const group   = [file];
      visited.add(file);

      const node    = graph.nodes.get(file);
      if (node) {
        for (const imported of node.imports) {
          if (cycleFiles.includes(imported) && !visited.has(imported)) {
            group.push(imported);
            visited.add(imported);
          }
        }
      }

      groups.push(group);
    }

    return groups;
  }

  // ── Dependency resolution ────────────────────────────────────────────────────

  /**
   * For each item, find other items in the plan that share an ancestor directory
   * AND have a higher priority — those should be addressed first.
   *
   * Keeps dependencies short (≤3) and never creates self-references.
   */
  private resolveDependencies(items: RefactorPlanItem[]): void {
    for (const item of items) {
      item.dependencies = items
        .filter(
          (other) =>
            other.filePath !== item.filePath &&
            other.priority > item.priority &&
            this.shareAncestorDir(item.filePath, other.filePath),
        )
        .slice(0, 3)
        .map((o) => o.filePath);
    }
  }

  // ── Categorization ────────────────────────────────────────────────────────────

  private categorize(
    effort: RefactorPlanItem["estimatedEffort"],
    impact: RefactorPlanItem["estimatedImpact"],
    issue: string,
  ): RefactorPlanItem["category"] {
    // Architectural issues — dependency and coupling problems
    if (["deep_deps", "circular_dependency", "hub_file"].includes(issue))
      return "architectural";

    // Phase 3 AST issues — always major refactors (high effort, high impact)
    if (["high_complexity", "god_function", "god_class"].includes(issue))
      return "major_refactor";

    // Nesting and params — medium effort, high impact = quick win territory
    // but categorize by actual effort/impact matrix values
    if (effort === "low"    && impact === "high")  return "quick_win";
    if (effort === "high"   && impact === "high")  return "major_refactor";
    if (effort === "low"    && impact === "low")   return "maintenance";
    if (effort === "medium" && impact === "low")   return "maintenance";
    return "major_refactor";
  }

  // ── Risk estimation ───────────────────────────────────────────────────────────

  estimateRisk(
    hotspot: DebtHotspot,
    analysis?: ProjectDebtAnalysis,
  ): "low" | "medium" | "high" {
    // Large files carry higher refactor risk regardless of issue type
    const file = analysis?.files.find((f) => f.filePath === hotspot.filePath);
    const isLarge = (file?.linesOfCode ?? 0) > 300;

    switch (hotspot.primaryIssue) {
      case "file_too_large":        return "high";
      case "deep_deps":             return "high";
      case "circular_dependency":   return "high";
      case "hub_file":              return "high";
      case "high_complexity":       return isLarge ? "high" : "medium";
      case "god_function":          return "high";
      case "god_class":             return "high";
      case "excessive_nesting":     return isLarge ? "high" : "medium";
      case "long_functions":        return isLarge ? "high" : "medium";
      case "excessive_params":      return "low";   // localised change
      case "many_todos":            return "medium";
      case "high_duplication":      return "medium";
      case "low_comments":          return "low";
      default:                      return "low";
    }
  }

  // ── Effort details ────────────────────────────────────────────────────────────

  /**
   * Returns a human-readable label and a mid-point hour estimate.
   * Buckets match the Phase 6 spec: <1h / 1–4h / 4–8h / Multi-day
   */
  private effortDetails(effort: "low" | "medium" | "high"): {
    effortLabel: string;
    effortHours: number;
  } {
    switch (effort) {
      case "low":    return { effortLabel: "<1 hour",   effortHours: 0.75 };
      case "medium": return { effortLabel: "1–4 hours", effortHours: 2.5 };
      case "high":   return { effortLabel: "4–8 hours", effortHours: 6 };
    }
  }

  // ── Human-readable explanations ───────────────────────────────────────────────

  private whyFlagged(hotspot: DebtHotspot): string {
    const d = hotspot.astDetail;
    switch (hotspot.primaryIssue) {
      case "high_complexity":
        return d
          ? `Cyclomatic complexity ${d.cyclomaticComplexity} (${d.complexityBand}) — too many decision paths to reason about or test reliably`
          : "High cyclomatic complexity — too many decision paths to reason about or test reliably";
      case "excessive_nesting":
        return d
          ? `Maximum nesting depth ${d.maxNestingDepth} (${d.nestingBand}) — deeply nested code is hard to read and error-prone`
          : "Excessive nesting depth — deeply nested code is hard to read and error-prone";
      case "god_function":
        return d
          ? `${d.godFunctionCount} function${d.godFunctionCount > 1 ? "s" : ""} exceed ${150} lines — violates single-responsibility, hard to test`
          : "God functions detected — functions exceeding 150 lines violate single-responsibility";
      case "god_class":
        return d
          ? `${d.godClassCount} class${d.godClassCount > 1 ? "es" : ""} with more than 20 methods — too many responsibilities in one place`
          : "God class detected — class has too many methods and responsibilities";
      case "excessive_params":
        return d
          ? `Maximum parameter count ${d.maxParameterCount} — functions with many parameters are hard to call correctly and test`
          : "Excessive parameters — functions with many parameters are hard to call correctly";
      case "file_too_large":    return "File exceeds 500 lines — high cognitive load and maintenance cost";
      case "long_functions":    return "Contains functions exceeding 50 lines — hard to test and reason about";
      case "deep_deps":         return "High import count indicates tight coupling to many other modules";
      case "many_todos":        return "5+ TODO/FIXME markers indicate deferred work and known defects";
      case "high_duplication":  return "Structural duplication detected — increases change surface area";
      case "low_comments":      return "Comment ratio below 5% — undocumented code is risky to modify";
      default:                  return hotspot.recommendation;
    }
  }

  private expectedPayoff(hotspot: DebtHotspot): string {
    switch (hotspot.primaryIssue) {
      case "high_complexity":   return "Testable, predictable code paths; easier to add features without breaking existing behavior";
      case "excessive_nesting": return "Readable control flow; easier to follow logic without mental stack tracking";
      case "god_function":      return "Small, testable, single-purpose functions; clear separation of concerns";
      case "god_class":         return "Focused classes with clear responsibilities; easier to extend and mock in tests";
      case "excessive_params":  return "Cleaner call sites; options objects make future parameter additions backward compatible";
      case "file_too_large":    return "Improved readability, easier testing, faster builds";
      case "long_functions":    return "Testable units, clearer intent, reduced bug surface";
      case "deep_deps":         return "Reduced cascade failures, easier mocking in tests";
      case "many_todos":        return "Eliminates known defects and unresolved design decisions";
      case "high_duplication":  return "Single source of truth, fewer places to update on change";
      case "low_comments":      return "Safer modifications, faster onboarding for new contributors";
      default:                  return "Improved maintainability score";
    }
  }

  // ── Path helpers ──────────────────────────────────────────────────────────────

  /**
   * Returns true if both files share at least one directory segment in common
   * (beyond a trivial root like "src").
   */
  private shareAncestorDir(pathA: string, pathB: string): boolean {
    const SKIP = new Set(["src", "lib", "app", ""]);
    const dirsA = pathA.replace(/\\/g, "/").split("/").slice(0, -1).filter((s) => !SKIP.has(s));
    const dirsB = pathB.replace(/\\/g, "/").split("/").slice(0, -1).filter((s) => !SKIP.has(s));
    return dirsA.some((d) => dirsB.includes(d));
  }
}

// ── Singleton ──────────────────────────────────────────────────────────────────

let instance: RefactorPlanner | null = null;

export function getRefactorPlanner(): RefactorPlanner {
  if (!instance) instance = new RefactorPlanner();
  return instance;
}
