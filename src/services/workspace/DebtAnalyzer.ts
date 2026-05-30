/**
 * DebtAnalyzer.ts — Phase 7, Step 7.1
 *
 * Technical debt scoring model that analyzes files and modules for:
 *   - Code duplication (simple hash-based)
 *   - File size (lines)
 *   - Function length
 *   - Comment ratio
 *   - Dependency depth (uses Phase 1 DependencyGraph)
 *   - TODO/FIXME density
 *   - Test coverage gaps (file existence check)
 *
 * Reuses:
 *   - Phase 1: ArchitectureMap, DependencyGraph for dependency depth
 *   - Phase 2: MemoryManager for past refactor history
 */

import type { ArchitectureMap } from "../architecture/ArchitectureMap";
import { memorySearch } from "../memory/MemoryManager";

/** Serialized ArchitectureMap sent to Workers (no class references). */
export interface ArchMapSnapshot {
  moduleFiles: Record<string, string[]>;
  fileDependencies: Record<string, string[]>;
  fileDependents: Record<string, string[]>;
  classifyFileModule: Record<string, string>;
}

// ── Types ──────────────────────────────────────────────────────────────────────

export interface FileDebtScore {
  path: string;
  module: string;
  scores: {
    fileSize: number;        // 0–20
    functionLength: number;  // 0–20
    commentRatio: number;    // 0–20
    duplication: number;     // 0–15
    dependencyDepth: number; // 0–15
    todoDensity: number;     // 0–10
    testCoverage: number;    // 0–10
  };
  totalScore: number;        // 0–100
  grade: DebtGrade;
  issues: string[];
}

export interface ModuleDebtScore {
  module: string;
  fileCount: number;
  averageScore: number;
  maxScore: number;
  worstFiles: string[];
  totalIssues: number;
  grade: DebtGrade;
}

export interface DebtReport {
  overallScore: number;       // 0–100 (higher = more debt)
  overallGrade: DebtGrade;
  totalFiles: number;
  analyzedFiles: number;
  fileScores: FileDebtScore[];
  moduleScores: ModuleDebtScore[];
  topIssues: string[];
  hotspots: { file: string; score: number }[];
}

export type DebtGrade = "A" | "B" | "C" | "D" | "F";

// ── Grade Mapping ──────────────────────────────────────────────────────────────

function gradeFromScore(score: number): DebtGrade {
  if (score <= 20) return "A";
  if (score <= 40) return "B";
  if (score <= 60) return "C";
  if (score <= 80) return "D";
  return "F";
}

// ── DebtAnalyzer ───────────────────────────────────────────────────────────────

export class DebtAnalyzer {
  private archMap: ArchitectureMap;

  constructor(archMap: ArchitectureMap) {
    this.archMap = archMap;
  }

  /**
   * Analyze a single file for technical debt.
   */
  analyzeFile(path: string, content: string): FileDebtScore {
    const lines = content.split("\n");
    const totalLines = lines.length;
    
    const scores = {
      fileSize: this.scoreFileSize(totalLines),
      functionLength: this.scoreFunctionLength(content),
      commentRatio: this.scoreCommentRatio(content, totalLines),
      duplication: 0, // filled by analyzeAllFiles
      dependencyDepth: this.scoreDependencyDepth(path),
      todoDensity: this.scoreTodoDensity(content, totalLines),
      testCoverage: this.scoreTestCoverage(path),
    };

    const totalScore = Object.values(scores).reduce((sum, s) => sum + s, 0);
    const issues = this.collectIssues(scores, path);

    return {
      path,
      module: this.archMap.classifyFile(path).module,
      scores,
      totalScore,
      grade: gradeFromScore(totalScore),
      issues,
    };
  }

  /**
   * Analyze all files in the project.
   */
  analyzeAllFiles(files: Map<string, string>): DebtReport {
    const fileScores: FileDebtScore[] = [];
    
    // First pass: analyze each file
    for (const [path, content] of files) {
      fileScores.push(this.analyzeFile(path, content));
    }

    // Second pass: detect duplication across files
    const duplicationMap = this.detectDuplication(files);
    for (const score of fileScores) {
      const dupPercent = duplicationMap.get(score.path) || 0;
      score.scores.duplication = this.scoreDuplication(dupPercent);
      // Recalculate total
      score.totalScore = Object.values(score.scores).reduce((sum, s) => sum + s, 0);
      score.grade = gradeFromScore(score.totalScore);
      if (dupPercent > 0) {
        score.issues.push(`~${Math.round(dupPercent)}% duplicated code`);
      }
    }

    // Module-level aggregation
    const moduleMap = new Map<string, FileDebtScore[]>();
    for (const fs of fileScores) {
      const mod = fs.module;
      if (!moduleMap.has(mod)) moduleMap.set(mod, []);
      moduleMap.get(mod)!.push(fs);
    }

    const moduleScores: ModuleDebtScore[] = [];
    for (const [module, files] of moduleMap) {
      const avg = files.reduce((s, f) => s + f.totalScore, 0) / files.length;
      const max = Math.max(...files.map((f) => f.totalScore));
      const worstFiles = files
        .sort((a, b) => b.totalScore - a.totalScore)
        .slice(0, 3)
        .map((f) => f.path);
      const totalIssues = files.reduce((s, f) => s + f.issues.length, 0);

      moduleScores.push({
        module,
        fileCount: files.length,
        averageScore: Math.round(avg * 10) / 10,
        maxScore: max,
        worstFiles,
        totalIssues,
        grade: gradeFromScore(avg),
      });
    }

    moduleScores.sort((a, b) => b.averageScore - a.averageScore);

    // Overall score
    const overallScore = fileScores.length > 0
      ? Math.round(fileScores.reduce((s, f) => s + f.totalScore, 0) / fileScores.length * 10) / 10
      : 0;

    // Hotspots (top 10 worst files)
    const hotspots = fileScores
      .sort((a, b) => b.totalScore - a.totalScore)
      .slice(0, 10)
      .map((f) => ({ file: f.path, score: f.totalScore }));

    // Top issues across all files
    const issueCounts = new Map<string, number>();
    for (const fs of fileScores) {
      for (const issue of fs.issues) {
        issueCounts.set(issue, (issueCounts.get(issue) || 0) + 1);
      }
    }
    const topIssues = Array.from(issueCounts.entries())
      .sort(([, a], [, b]) => b - a)
      .slice(0, 10)
      .map(([issue, count]) => `${issue} (${count} files)`);

    return {
      overallScore,
      overallGrade: gradeFromScore(overallScore),
      totalFiles: files.size,
      analyzedFiles: fileScores.length,
      fileScores,
      moduleScores,
      topIssues,
      hotspots,
    };
  }

  /**
   * Serialize the ArchitectureMap into a plain object safe for Worker transfer.
   */
  getArchMapSnapshot(): ArchMapSnapshot {
    const moduleFiles: Record<string, string[]> = {};
    const fileDependencies: Record<string, string[]> = {};
    const fileDependents: Record<string, string[]> = {};
    const classifyFileModule: Record<string, string> = {};

    // Collect all known files from the module index
    const index = this.archMap.getModuleIndex();
    const allFiles: string[] = [];
    for (const files of Object.values(index)) {
      allFiles.push(...files);
    }

    for (const file of allFiles) {
      classifyFileModule[file] = this.archMap.classifyFile(file).module;

      const mod = classifyFileModule[file];
      if (!moduleFiles[mod]) moduleFiles[mod] = [];
      if (!moduleFiles[mod].includes(file)) moduleFiles[mod].push(file);

      try {
        fileDependencies[file] = this.archMap.getFileDependencies(file);
      } catch {
        fileDependencies[file] = [];
      }

      try {
        fileDependents[file] = this.archMap.getFileDependents(file);
      } catch {
        fileDependents[file] = [];
      }
    }

    return { moduleFiles, fileDependencies, fileDependents, classifyFileModule };
  }

  /**
   * Analyze all files using a Web Worker (non-blocking).
   * Falls back to synchronous analysis if worker creation fails.
   */
  async analyzeAllFilesAsync(files: Map<string, string>): Promise<DebtReport> {
    try {
      const snapshot = this.getArchMapSnapshot();

      // Convert Map to plain Record for structured clone transfer
      const filesRecord: Record<string, string> = {};
      for (const [path, content] of files) {
        filesRecord[path] = content;
      }

      const worker = new Worker(
        new URL("../../workers/debt-analyzer.worker.ts", import.meta.url),
        { type: "module" },
      );

      return new Promise((resolve, reject) => {
        const cleanup = () => {
          worker.removeEventListener("message", onMessage);
          worker.removeEventListener("error", onError);
          worker.terminate();
        };

        const onMessage = (event: MessageEvent<{ type: string; report: DebtReport }>) => {
          if (event.data.type === "result") {
            cleanup();
            resolve(event.data.report);
          }
        };

        const onError = (error: ErrorEvent) => {
          cleanup();
          console.warn("[DebtAnalyzer] Worker failed, falling back to sync:", error.message);
          // Fallback to sync
          resolve(this.analyzeAllFiles(files));
        };

        worker.addEventListener("message", onMessage);
        worker.addEventListener("error", onError);

        worker.postMessage({
          type: "analyze",
          files: filesRecord,
          archMapData: snapshot,
        });
      });
    } catch (err) {
      console.warn("[DebtAnalyzer] Worker unavailable, using sync fallback:", err);
      return this.analyzeAllFiles(files);
    }
  }

  // ── Individual Scorers ────────────────────────────────────────────────────

  private scoreFileSize(lines: number): number {
    if (lines <= 100) return 0;       // small, healthy
    if (lines <= 300) return 2;       // moderate
    if (lines <= 500) return 5;       // getting large
    if (lines <= 800) return 10;      // large
    if (lines <= 1500) return 15;     // very large
    return 20;                         // extremely large
  }

  private scoreFunctionLength(content: string): number {
    // Detect JS/TS function/arrow function blocks by counting braces
    // Simple heuristic: count average lines between { and matching }
    const functionMatches = content.match(
      /(?:function\s+\w+|(?:\w+|\([^)]*\))\s*=>)\s*\{/g
    );
    if (!functionMatches || functionMatches.length === 0) return 0;

    // Estimate: count lines inside the largest blocks
    const maxBraceDepth = 0;
    let currentDepth = 0;
    let braceLineCount = 0;
    let maxBlockLines = 0;

    for (const char of content) {
      if (char === "{") {
        currentDepth++;
        braceLineCount = 0;
      } else if (char === "}") {
        if (braceLineCount > maxBlockLines) {
          maxBlockLines = braceLineCount;
        }
        currentDepth--;
        braceLineCount = 0;
      } else if (char === "\n") {
        if (currentDepth > 0) braceLineCount++;
      }
    }

    if (maxBlockLines <= 20) return 0;
    if (maxBlockLines <= 50) return 2;
    if (maxBlockLines <= 100) return 5;
    if (maxBlockLines <= 200) return 10;
    if (maxBlockLines <= 400) return 15;
    return 20;
  }

  private scoreCommentRatio(content: string, totalLines: number): number {
    if (totalLines === 0) return 0;
    const commentLines = content.split("\n").filter((line) => {
      const trimmed = line.trim();
      return trimmed.startsWith("//") || trimmed.startsWith("#") || 
             trimmed.startsWith("/*") || trimmed.startsWith("*") ||
             trimmed.startsWith("/**") || trimmed === "*/" ||
             trimmed.startsWith("--");
    }).length;

    const ratio = commentLines / totalLines;

    // Too few comments is debt, too many is also debt (over-commented)
    if (ratio >= 0.15 && ratio <= 0.4) return 0;   // healthy
    if (ratio >= 0.05 && ratio < 0.15) return 3;   // slightly under-commented
    if (ratio < 0.05 && totalLines > 50) return 8;  // poorly commented
    if (ratio > 0.4) return 5;                      // over-commented
    if (ratio < 0.02) return 12;                    // almost no comments
    return 20;                                       // zero comments
  }

  private scoreDependencyDepth(path: string): number {
    try {
      const deps = this.archMap.getFileDependencies(path);
      const transitive = this.archMap.getFileDependents(path);

      const totalConnections = deps.length + transitive.length;

      if (totalConnections <= 3) return 0;
      if (totalConnections <= 10) return 2;
      if (totalConnections <= 25) return 5;
      if (totalConnections <= 50) return 10;
      return 15;
    } catch {
      return 0;
    }
  }

  private scoreTodoDensity(content: string, totalLines: number): number {
    if (totalLines === 0) return 0;
    const todoMatches = content.match(/(?:TODO|FIXME|HACK|XXX|BUG|OPTIMIZE)\b/gi);
    const count = todoMatches ? todoMatches.length : 0;
    const density = count / totalLines;

    if (count === 0) return 0;
    if (density <= 0.01) return 2;   // rare
    if (density <= 0.03) return 5;   // some
    if (density <= 0.05) return 8;   // many
    return 10;                        // overflowing
  }

  private scoreTestCoverage(path: string): number {
    // Simple heuristic: check if a test file exists
    // Strip extension, look for .test.ext or .spec.ext
    const base = path.replace(/\.(ts|tsx|js|jsx|py|rs)$/, "");
    const testPatterns = [
      `${base}.test.ts`, `${base}.spec.ts`,
      `${base}.test.tsx`, `${base}.spec.tsx`,
      `${base}.test.js`, `${base}.spec.js`,
      `test_${base.split("/").pop()}.py`,
      `${base}_test.rs`,
    ];

    // We can't check filesystem here, so use a hash of known test files from the architecture map
    const module = this.archMap.classifyFile(path).module;
    const moduleFiles = this.archMap.getModuleFiles(module);

    const hasNearbyTest = moduleFiles.some((f) =>
      f.includes(".test.") || f.includes(".spec.") || f.includes("__tests__")
    );

    return hasNearbyTest ? 0 : 5; // Missing test = 5 points
  }

  private scoreDuplication(percentDuplicated: number): number {
    if (percentDuplicated === 0) return 0;
    if (percentDuplicated <= 10) return 3;
    if (percentDuplicated <= 25) return 7;
    if (percentDuplicated <= 50) return 12;
    return 15;
  }

  // ── Duplication Detection ─────────────────────────────────────────────────

  private detectDuplication(files: Map<string, string>): Map<string, number> {
    const result = new Map<string, number>();

    // Simple sliding window hash comparison
    // For each file, compare line-level hashes with other files
    const fileLines = new Map<string, string[]>();
    for (const [path, content] of files) {
      fileLines.set(path, content.split("\n"));
    }

    const paths = Array.from(files.keys());
    for (let i = 0; i < paths.length; i++) {
      const pathA = paths[i];
      const linesA = fileLines.get(pathA)!;
      if (linesA.length < 10) continue;

      let duplicatedLines = 0;
      const linesBSet = new Set<string>();

      // Check against all other files
      for (let j = 0; j < paths.length; j++) {
        if (i === j) continue;
        const linesB = fileLines.get(paths[j])!;
        for (const line of linesB) {
          const trimmed = line.trim();
          if (trimmed.length > 10) linesBSet.add(trimmed);
        }
      }

      for (const line of linesA) {
        const trimmed = line.trim();
        if (trimmed.length > 10 && linesBSet.has(trimmed)) {
          duplicatedLines++;
        }
      }

      const percent = linesA.length > 0 ? (duplicatedLines / linesA.length) * 100 : 0;
      result.set(pathA, percent);
    }

    return result;
  }

  // ── Issue Collection ──────────────────────────────────────────────────────

  private collectIssues(
    scores: FileDebtScore["scores"],
    path: string,
  ): string[] {
    const issues: string[] = [];

    if (scores.fileSize >= 10) issues.push(`Large file (${scores.fileSize}/20)`);
    if (scores.functionLength >= 10) issues.push(`Large function blocks (${scores.functionLength}/20)`);
    if (scores.commentRatio >= 8) issues.push(`Poor comment ratio (${scores.commentRatio}/20)`);
    if (scores.dependencyDepth >= 10) issues.push(`High dependency depth (${scores.dependencyDepth}/15)`);
    if (scores.todoDensity >= 5) issues.push(`Many TODO/FIXME markers (${scores.todoDensity}/10)`);
    if (scores.testCoverage >= 5) issues.push(`Missing tests (${scores.testCoverage}/10)`);

    return issues;
  }
}