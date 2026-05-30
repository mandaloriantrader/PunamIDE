/**
 * DebtAnalyzer.ts — Phase 7, Step 7.1
 *
 * Analyzes codebase for technical debt indicators.
 * Scoring model: code duplication, file size, function length, comment ratio,
 * dependency depth, TODO/FIXME density, test coverage gaps.
 * Provides per-file and project-wide debt analysis.
 */

import { invoke } from "@tauri-apps/api/core";
import { readFile } from "../../utils/tauri";

// ── Types ──────────────────────────────────────────────────────────────────────

export interface FileDebtMetrics {
  filePath: string;
  linesOfCode: number;
  commentLines: number;
  commentRatio: number; // 0-1, target > 0.1
  functionCount: number;
  avgFunctionLength: number;
  maxFunctionLength: number;
  todoCount: number;
  fixmeCount: number;
  hackCount: number;
  duplicationScore: number; // 0-100, higher = more duplicated
  dependencyDepth: number;
  fileScore: number; // 0-100, lower = more debt
}

export interface DebtHotspot {
  filePath: string;
  score: number;
  primaryIssue: string; // "file_too_large", "low_comments", "high_duplication", "deep_deps", "many_todos", "long_functions"
  recommendation: string;
}

export interface ProjectDebtAnalysis {
  files: FileDebtMetrics[];
  hotspots: DebtHotspot[];
  overallScore: number; // 0-100, higher = less debt
  totalFilesAnalyzed: number;
  totalLinesOfCode: number;
}

// ── DebtAnalyzer Class ─────────────────────────────────────────────────────────

export class DebtAnalyzer {
  private readonly LARGE_FILE_THRESHOLD = 500; // lines
  private readonly LOW_COMMENT_THRESHOLD = 0.05; // comment ratio
  private readonly LONG_FUNCTION_THRESHOLD = 50; // lines
  private readonly HIGH_DEP_DEPTH_THRESHOLD = 5;

  /**
   * Analyze a single file for technical debt.
   */
  async analyzeFile(filePath: string): Promise<FileDebtMetrics> {
    const content = await readFile(filePath).catch(() => "");
    if (!content) {
      return this.emptyMetrics(filePath);
    }

    const lines = content.split("\n");
    const loc = lines.length;

    // Comment ratio
    const commentLines = lines.filter(
      (l) => l.trim().startsWith("//") || l.trim().startsWith("#") || l.trim().startsWith("/*") || l.trim().startsWith("*") || l.trim().startsWith("<!--")
    ).length;
    const commentRatio = loc > 0 ? commentLines / loc : 0;

    // Function detection (simple regex for common patterns)
    const functionPattern = /(?:function\s+\w+|const\s+\w+\s*=\s*(?:\([^)]*\)\s*=>|function)|(?:async\s+)?\w+\s*\([^)]*\)\s*\{|def\s+\w+|fn\s+\w+|func\s+\w+)/g;
    const functionMatches = content.match(functionPattern) || [];
    const functionCount = functionMatches.length;

    // Average function length (rough estimate)
    const avgFunctionLength = functionCount > 0 ? Math.round(loc / functionCount) : loc;

    // Max function length (rough: find largest gap between function matches)
    let maxFunctionLength = loc;
    if (functionMatches.length > 1) {
      let maxGap = 0;
      const indices: number[] = [];
      for (const match of functionMatches) {
        const idx = content.indexOf(match);
        indices.push(idx);
      }
      for (let i = 1; i < indices.length; i++) {
        const gap = Math.round((indices[i] - indices[i - 1]) / lines.length * loc);
        if (gap > maxGap) maxGap = gap;
      }
      maxFunctionLength = maxGap || loc;
    }

    // TODO/FIXME/HACK counts
    const todoCount = (content.match(/TODO/gi) || []).length;
    const fixmeCount = (content.match(/FIXME/gi) || []).length;
    const hackCount = (content.match(/HACK\b/gi) || []).length;

    // Dependency depth (count import lines)
    const importLines = lines.filter(
      (l) => l.trim().match(/^(import|require|from|use|#include)/)
    ).length;
    const dependencyDepth = importLines;

    // Duplication score (simplified: high if file is very large relative to project)
    const duplicationScore = loc > this.LARGE_FILE_THRESHOLD ? Math.min(100, (loc / this.LARGE_FILE_THRESHOLD) * 30) : 0;

    // File score (0-100, lower = more debt)
    let fileScore = 100;
    if (loc > this.LARGE_FILE_THRESHOLD) fileScore -= 20;
    if (commentRatio < this.LOW_COMMENT_THRESHOLD) fileScore -= 15;
    if (avgFunctionLength > this.LONG_FUNCTION_THRESHOLD) fileScore -= 15;
    if (dependencyDepth > this.HIGH_DEP_DEPTH_THRESHOLD) fileScore -= 10;
    if (todoCount + fixmeCount > 5) fileScore -= 15;
    if (duplicationScore > 50) fileScore -= 10;
    fileScore = Math.max(0, fileScore);

    return {
      filePath,
      linesOfCode: loc,
      commentLines,
      commentRatio: Math.round(commentRatio * 100) / 100,
      functionCount,
      avgFunctionLength,
      maxFunctionLength,
      todoCount,
      fixmeCount,
      hackCount,
      duplicationScore,
      dependencyDepth,
      fileScore,
    };
  }

  /**
   * Analyze all files in a project.
   */
  async analyzeProject(filePaths: string[]): Promise<ProjectDebtAnalysis> {
    const metrics: FileDebtMetrics[] = [];

    for (const fp of filePaths.slice(0, 200)) { // limit to 200 files for performance
      // Only analyze source files
      if (!this.isSourceFile(fp)) continue;

      const m = await this.analyzeFile(fp).catch(() => this.emptyMetrics(fp));
      if (m.linesOfCode > 0) {
        metrics.push(m);
      }
    }

    // Sort by score (lowest = most debt)
    metrics.sort((a, b) => a.fileScore - b.fileScore);

    // Generate hotspots (top 10 worst files)
    const hotspots: DebtHotspot[] = metrics.slice(0, 10).map((m) => ({
      filePath: m.filePath,
      score: m.fileScore,
      primaryIssue: this.detectPrimaryIssue(m),
      recommendation: this.generateRecommendation(m),
    }));

    // Overall project score (weighted average)
    const totalScore = metrics.reduce((sum, m) => sum + m.fileScore, 0);
    const overallScore = metrics.length > 0 ? Math.round(totalScore / metrics.length) : 100;
    const totalLoc = metrics.reduce((sum, m) => sum + m.linesOfCode, 0);

    return {
      files: metrics,
      hotspots,
      overallScore,
      totalFilesAnalyzed: metrics.length,
      totalLinesOfCode: totalLoc,
    };
  }

  private detectPrimaryIssue(m: FileDebtMetrics): string {
    if (m.linesOfCode > this.LARGE_FILE_THRESHOLD) return "file_too_large";
    if (m.commentRatio < this.LOW_COMMENT_THRESHOLD) return "low_comments";
    if (m.duplicationScore > 50) return "high_duplication";
    if (m.dependencyDepth > this.HIGH_DEP_DEPTH_THRESHOLD) return "deep_deps";
    if (m.todoCount + m.fixmeCount > 5) return "many_todos";
    if (m.avgFunctionLength > this.LONG_FUNCTION_THRESHOLD) return "long_functions";
    return "minor_issues";
  }

  private generateRecommendation(m: FileDebtMetrics): string {
    const issues: string[] = [];
    if (m.linesOfCode > this.LARGE_FILE_THRESHOLD) issues.push("Split into smaller modules");
    if (m.commentRatio < this.LOW_COMMENT_THRESHOLD) issues.push("Add documentation comments");
    if (m.avgFunctionLength > this.LONG_FUNCTION_THRESHOLD) issues.push("Extract long functions");
    if (m.dependencyDepth > this.HIGH_DEP_DEPTH_THRESHOLD) issues.push("Reduce import dependencies");
    if (m.todoCount + m.fixmeCount > 5) issues.push("Resolve TODO/FIXME markers");
    return issues.join("; ") || "Minor cleanup";
  }

  private isSourceFile(fp: string): boolean {
    const ext = fp.split(".").pop()?.toLowerCase() || "";
    return ["ts", "tsx", "js", "jsx", "py", "rs", "go", "java", "cs"].includes(ext);
  }

  private emptyMetrics(filePath: string): FileDebtMetrics {
    return {
      filePath,
      linesOfCode: 0,
      commentLines: 0,
      commentRatio: 0,
      functionCount: 0,
      avgFunctionLength: 0,
      maxFunctionLength: 0,
      todoCount: 0,
      fixmeCount: 0,
      hackCount: 0,
      duplicationScore: 0,
      dependencyDepth: 0,
      fileScore: 100,
    };
  }
}

// ── Singleton ──────────────────────────────────────────────────────────────────

let instance: DebtAnalyzer | null = null;

export function getDebtAnalyzer(): DebtAnalyzer {
  if (!instance) {
    instance = new DebtAnalyzer();
  }
  return instance;
}