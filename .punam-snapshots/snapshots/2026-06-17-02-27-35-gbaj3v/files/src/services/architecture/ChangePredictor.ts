/**
 * ChangePredictor.ts — Phase 3, Step 3.3
 *
 * Estimates risk level, affected file count, and change complexity
 * based on dependency graph depth and Phase 2 memory of past similar changes.
 *
 * Combines two data sources:
 *   1. Dependency graph depth analysis (from ArchitectureMap/DependencyGraph)
 *      — how many files transitively depend on the affected files
 *   2. Phase 2 Memory (from memory_engine.rs via MemoryManager)
 *      — past bug fixes, refactors, and architectural decisions similar
 *        to the proposed change
 *
 * Output: a ChangePrediction with risk level, confidence, estimated effort,
 * and historical context from similar past changes.
 */

import type { ArchitectureMap } from "./ArchitectureMap";
import type { ImpactResult, AffectedSystem, AffectedFile, RiskLevel } from "./ImpactAnalyzer";
import { memorySearch, memoryList } from "../memory/MemoryManager";
import type { MemoryEntry } from "../memory/MemoryManager";

// ── Types ──────────────────────────────────────────────────────────────────────

export interface ChangePrediction {
  /** Estimated risk level (same scale as ImpactAnalyzer). */
  riskLevel: RiskLevel;
  /** Confidence in the prediction (0-1). */
  confidence: number;
  /** Estimated number of files that will need changes. */
  estimatedFileCount: number;
  /** Estimated effort: "trivial" | "small" | "moderate" | "large" | "very_large". */
  estimatedEffort: ChangeEffort;
  /** Estimated hours of work (rough heuristic). */
  estimatedHours: number;
  /** Depth of the dependency chain from the most affected file. */
  maxDependencyDepth: number;
  /** Number of modules that depend on the affected modules. */
  transitiveModuleCount: number;
  /** Past similar changes found in project memory. */
  similarPastChanges: MemoryEntry[];
  /** Human-readable explanation of the prediction. */
  explanation: string;
  /** Key risk factors identified. */
  riskFactors: string[];
}

export type ChangeEffort = "trivial" | "small" | "moderate" | "large" | "very_large";

export interface DepthAnalysis {
  /** The file with the deepest dependency chain. */
  deepestFile: string;
  /** Maximum depth from that file to its farthest transitive dependency. */
  maxDepth: number;
  /** Average depth across all affected files. */
  averageDepth: number;
  /** Files at each depth level. */
  depthDistribution: Record<number, number>; // depth → file count
}

// ── ChangePredictor Class ─────────────────────────────────────────────────────

export class ChangePredictor {
  private archMap: ArchitectureMap;

  constructor(archMap: ArchitectureMap) {
    this.archMap = archMap;
  }

  /**
   * Predict the impact of a change using both graph depth analysis
   * and historical memory of past similar changes.
   *
   * @param impactResult - The ImpactResult from ImpactAnalyzer
   * @param query - The original natural language query (used for memory search)
   */
  async predict(impactResult: ImpactResult, query: string): Promise<ChangePrediction> {
    // 1. Analyze dependency depth
    const depthAnalysis = this.analyzeDepth(impactResult.affectedFiles);

    // 2. Search memory for past similar changes
    const similarPastChanges = await this.findSimilarPastChanges(query);

    // 3. Calculate risk factors
    const riskFactors = this.identifyRiskFactors(impactResult, depthAnalysis, similarPastChanges);

    // 4. Estimate effort
    const { estimatedEffort, estimatedHours } = this.estimateEffort(
      impactResult,
      depthAnalysis,
      similarPastChanges,
    );

    // 5. Build explanation
    const explanation = this.buildExplanation(
      impactResult,
      depthAnalysis,
      similarPastChanges,
      riskFactors,
    );

    // 6. Calculate confidence
    const confidence = this.calculateConfidence(impactResult, depthAnalysis, similarPastChanges);

    return {
      riskLevel: impactResult.riskLevel,
      confidence,
      estimatedFileCount: impactResult.totalFileCount,
      estimatedEffort,
      estimatedHours,
      maxDependencyDepth: depthAnalysis.maxDepth,
      transitiveModuleCount: impactResult.transitiveImpactModules.length,
      similarPastChanges,
      explanation,
      riskFactors,
    };
  }

  /**
   * Quick prediction without memory lookup (when no API key / offline).
   */
  quickPredict(impactResult: ImpactResult): ChangePrediction {
    const depthAnalysis = this.analyzeDepth(impactResult.affectedFiles);
    const riskFactors = this.identifyRiskFactors(impactResult, depthAnalysis, []);
    const { estimatedEffort, estimatedHours } = this.estimateEffort(impactResult, depthAnalysis, []);
    const explanation = this.buildExplanation(impactResult, depthAnalysis, [], riskFactors);

    return {
      riskLevel: impactResult.riskLevel,
      confidence: 0.6,
      estimatedFileCount: impactResult.totalFileCount,
      estimatedEffort,
      estimatedHours,
      maxDependencyDepth: depthAnalysis.maxDepth,
      transitiveModuleCount: impactResult.transitiveImpactModules.length,
      similarPastChanges: [],
      explanation,
      riskFactors,
    };
  }

  // ── Depth Analysis ──────────────────────────────────────────────────────────

  private analyzeDepth(affectedFiles: AffectedFile[]): DepthAnalysis {
    let maxDepth = 0;
    let totalDepth = 0;
    let deepestFile = "";
    const depthDistribution: Record<number, number> = {};

    for (const file of affectedFiles) {
      // Calculate the depth of the dependency chain from this file
      const depth = this.calculateFileDepth(file.path);
      totalDepth += depth;

      depthDistribution[depth] = (depthDistribution[depth] || 0) + 1;

      if (depth > maxDepth) {
        maxDepth = depth;
        deepestFile = file.path;
      }
    }

    const averageDepth = affectedFiles.length > 0
      ? Math.round((totalDepth / affectedFiles.length) * 10) / 10
      : 0;

    return {
      deepestFile,
      maxDepth,
      averageDepth,
      depthDistribution,
    };
  }

  /**
   * Calculate the maximum depth of the dependency chain from a file.
   * Uses BFS through the forward edges of the dependency graph.
   * Returns the number of hops to the farthest transitive dependency.
   */
  private calculateFileDepth(filePath: string): number {
    const visited = new Set<string>();
    const queue: Array<{ file: string; depth: number }> = [{ file: filePath, depth: 0 }];
    let maxDepth = 0;

    while (queue.length > 0) {
      const { file, depth } = queue.shift()!;

      if (visited.has(file)) continue;
      visited.add(file);

      if (depth > maxDepth) {
        maxDepth = depth;
      }

      const deps = this.archMap.getFileDependencies(file);
      for (const dep of deps) {
        if (!visited.has(dep) && !dep.includes("node_modules/")) {
          queue.push({ file: dep, depth: depth + 1 });
        }
      }
    }

    return maxDepth;
  }

  // ── Memory Search ───────────────────────────────────────────────────────────

  /**
   * Search Phase 2 memory for past changes similar to this query.
   * Searches across architectural_decisions, bug_resolutions, and refactors.
   */
  private async findSimilarPastChanges(query: string): Promise<MemoryEntry[]> {
    try {
      // Extract key terms from the query for targeted search
      const terms = this.extractKeyTerms(query);

      // Search in parallel across memory types
      const searchPromises = terms.map(async (term) => {
        try {
          const result = await memorySearch(term, undefined, 5);
          return result.entries;
        } catch {
          return [];
        }
      });

      const allResults = await Promise.all(searchPromises);
      const flat = allResults.flat();

      // Deduplicate by ID
      const seen = new Set<string>();
      const unique = flat.filter((entry) => {
        if (seen.has(entry.id)) return false;
        seen.add(entry.id);
        return true;
      });

      // Sort by relevance (severity: critical > high > medium > low)
      return unique.sort((a, b) => {
        const severityOrder: Record<string, number> = {
          critical: 4,
          high: 3,
          medium: 2,
          low: 1,
        };
        return (severityOrder[b.severity] || 0) - (severityOrder[a.severity] || 0);
      }).slice(0, 10);
    } catch {
      return [];
    }
  }

  /**
   * Extract meaningful search terms from a natural language query.
   * Splits on common words and punctuation.
   */
  private extractKeyTerms(query: string): string[] {
    const stopWords = new Set([
      "the", "a", "an", "is", "are", "was", "were", "be", "been",
      "in", "on", "at", "to", "for", "of", "with", "by", "from",
      "and", "or", "not", "but", "if", "then", "else", "when",
      "up", "out", "add", "change", "modify", "update", "create",
      "remove", "delete", "fix", "implement", "support", "need",
      "want", "should", "would", "could", "will", "can",
    ]);

    const words = query
      .toLowerCase()
      .replace(/[^a-z0-9\s_-]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length > 2 && !stopWords.has(w));

    // Return unique terms, with multi-word combinations for precision
    const terms: string[] = [];
    for (let i = 0; i < words.length; i++) {
      if (i + 1 < words.length) {
        terms.push(`${words[i]} ${words[i + 1]}`);
      }
      terms.push(words[i]);
    }

    // Deduplicate and limit to 5 terms
    return [...new Set(terms)].slice(0, 5);
  }

  // ── Risk Factors ────────────────────────────────────────────────────────────

  private identifyRiskFactors(
    impact: ImpactResult,
    depth: DepthAnalysis,
    pastChanges: MemoryEntry[],
  ): string[] {
    const factors: string[] = [];

    // Deep dependency chains → higher risk of unintended consequences
    if (depth.maxDepth >= 5) {
      factors.push(`Deep dependency chain (${depth.maxDepth} levels) — high risk of cascading failures`);
    } else if (depth.maxDepth >= 3) {
      factors.push(`Moderate dependency chain (${depth.maxDepth} levels)`);
    }

    // Many affected systems → integration risk
    if (impact.affectedSystems.length >= 3) {
      factors.push(`${impact.affectedSystems.length} systems affected — integration risk`);
    }

    // Large file count → testing burden
    if (impact.totalFileCount >= 30) {
      factors.push(`Large change surface (${impact.totalFileCount} files) — significant testing required`);
    }

    // Many transitive modules → widespread impact
    if (impact.transitiveImpactModules.length >= 5) {
      factors.push(`${impact.transitiveImpactModules.length} modules transitively impacted`);
    }

    // Low confidence systems → uncertainty
    const lowConfidenceSystems = impact.affectedSystems.filter((s) => s.confidence < 0.5);
    if (lowConfidenceSystems.length > 0) {
      factors.push(`${lowConfidenceSystems.length} system(s) identified with low confidence — may affect more areas`);
    }

    // Past critical bugs in related areas
    const criticalPast = pastChanges.filter(
      (m) => m.severity === "critical" || m.severity === "high",
    );
    if (criticalPast.length > 0) {
      factors.push(`${criticalPast.length} past critical/high-severity issues in related areas`);
    }

    // Past refactors in related areas → code may already be unstable
    const pastRefactors = pastChanges.filter((m) => m.memory_type === "refactor");
    if (pastRefactors.length > 0) {
      factors.push(`${pastRefactors.length} prior refactor(s) in this area — code may be sensitive`);
    }

    return factors;
  }

  // ── Effort Estimation ───────────────────────────────────────────────────────

  private estimateEffort(
    impact: ImpactResult,
    depth: DepthAnalysis,
    _pastChanges: MemoryEntry[],
  ): { estimatedEffort: ChangeEffort; estimatedHours: number } {
    // Heuristic based on file count and depth
    const fileCount = impact.totalFileCount;
    const depthFactor = depth.maxDepth * 0.5; // each level of depth adds complexity
    const systemFactor = impact.affectedSystems.length * 1.5;

    const complexityScore = fileCount + depthFactor * 10 + systemFactor * 5;
    let estimatedEffort: ChangeEffort;
    let estimatedHours: number;

    if (complexityScore <= 5) {
      estimatedEffort = "trivial";
      estimatedHours = 0.5;
    } else if (complexityScore <= 15) {
      estimatedEffort = "small";
      estimatedHours = 2;
    } else if (complexityScore <= 40) {
      estimatedEffort = "moderate";
      estimatedHours = 8;
    } else if (complexityScore <= 80) {
      estimatedEffort = "large";
      estimatedHours = 24;
    } else {
      estimatedEffort = "very_large";
      estimatedHours = 40;
    }

    return { estimatedEffort, estimatedHours };
  }

  // ── Confidence ──────────────────────────────────────────────────────────────

  private calculateConfidence(
    impact: ImpactResult,
    depth: DepthAnalysis,
    pastChanges: MemoryEntry[],
  ): number {
    let confidence = 0.5; // base confidence

    // More past similar changes → higher confidence (we've seen this pattern before)
    if (pastChanges.length >= 5) confidence += 0.2;
    else if (pastChanges.length >= 2) confidence += 0.1;

    // High system confidence → higher prediction confidence
    const avgSystemConfidence =
      impact.affectedSystems.length > 0
        ? impact.affectedSystems.reduce((s, sys) => s + sys.confidence, 0) / impact.affectedSystems.length
        : 1;
    confidence += avgSystemConfidence * 0.2;

    // Low depth variance → more predictable
    const depths = Object.values(depth.depthDistribution);
    if (depths.length <= 3) confidence += 0.1;

    return Math.min(1, Math.max(0, Math.round(confidence * 100) / 100));
  }

  // ── Explanation ─────────────────────────────────────────────────────────────

  private buildExplanation(
    impact: ImpactResult,
    depth: DepthAnalysis,
    pastChanges: MemoryEntry[],
    riskFactors: string[],
  ): string {
    const parts: string[] = [];

    parts.push(
      `This change affects ${impact.affectedSystems.length} system(s) ` +
        `across ${impact.totalFileCount} file(s) ` +
        `with a maximum dependency depth of ${depth.maxDepth}.`,
    );

    if (impact.transitiveImpactModules.length > 0) {
      parts.push(
        `${impact.transitiveImpactModules.length} module(s) depend on the affected modules and may also need updates.`,
      );
    }

    if (pastChanges.length > 0) {
      const criticalCount = pastChanges.filter(
        (m) => m.severity === "critical" || m.severity === "high",
      ).length;
      parts.push(
        `Found ${pastChanges.length} past related change(s) in project memory` +
          (criticalCount > 0 ? `, including ${criticalCount} high-severity issues.` : "."),
      );
    }

    if (riskFactors.length > 0) {
      parts.push(`Key risks: ${riskFactors.slice(0, 3).join("; ")}.`);
    }

    return parts.join(" ");
  }
}

// ── Convenience Factory ───────────────────────────────────────────────────────

/**
 * Create a ChangePredictor from an existing ArchitectureMap.
 */
export async function createChangePredictor(
  archMap: ArchitectureMap,
): Promise<ChangePredictor> {
  return new ChangePredictor(archMap);
}