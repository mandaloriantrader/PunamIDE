/**
 * Debt Analyzer Web Worker — Phase 10, Step 10.7
 *
 * Offloads expensive debt analysis (O(n²) duplication detection + scoring)
 * from the main thread onto a Web Worker.
 *
 * Communication:
 *   Main → Worker: { type: "analyze", files: Record<path, content>, archMapData }
 *   Worker → Main: { type: "result", report: DebtReport }
 */

// ── Types (mirrors DebtAnalyzer.ts) ──────────────────────────────────────────

type DebtGrade = "A" | "B" | "C" | "D" | "F";

interface FileDebtScore {
  path: string;
  module: string;
  scores: {
    fileSize: number;
    functionLength: number;
    commentRatio: number;
    duplication: number;
    dependencyDepth: number;
    todoDensity: number;
    testCoverage: number;
  };
  totalScore: number;
  grade: DebtGrade;
  issues: string[];
}

interface ModuleDebtScore {
  module: string;
  fileCount: number;
  averageScore: number;
  maxScore: number;
  worstFiles: string[];
  totalIssues: number;
  grade: DebtGrade;
}

interface DebtReport {
  overallScore: number;
  overallGrade: DebtGrade;
  totalFiles: number;
  analyzedFiles: number;
  fileScores: FileDebtScore[];
  moduleScores: ModuleDebtScore[];
  topIssues: string[];
  hotspots: { file: string; score: number }[];
}

/** Serialized ArchitectureMap data needed by the scorer (no class reference). */
interface ArchMapData {
  moduleFiles: Record<string, string[]>;
  fileDependencies: Record<string, string[]>;
  fileDependents: Record<string, string[]>;
  classifyFileModule: Record<string, string>;
}

interface AnalyzeMessage {
  type: "analyze";
  files: Record<string, string>;
  archMapData: ArchMapData;
}

interface AnalyzeResult {
  type: "result";
  report: DebtReport;
}

// ── Pure scoring helpers (extracted from DebtAnalyzer) ──────────────────────

function gradeFromScore(score: number): DebtGrade {
  if (score <= 20) return "A";
  if (score <= 40) return "B";
  if (score <= 60) return "C";
  if (score <= 80) return "D";
  return "F";
}

function scoreFileSize(lines: number): number {
  if (lines <= 100) return 0;
  if (lines <= 300) return 2;
  if (lines <= 500) return 5;
  if (lines <= 800) return 10;
  if (lines <= 1500) return 15;
  return 20;
}

function scoreFunctionLength(content: string): number {
  const functionMatches = content.match(
    /(?:function\s+\w+|(?:\w+|\([^)]*\))\s*=>)\s*\{/g
  );
  if (!functionMatches || functionMatches.length === 0) return 0;

  let currentDepth = 0;
  let braceLineCount = 0;
  let maxBlockLines = 0;

  for (const char of content) {
    if (char === "{") {
      currentDepth++;
      braceLineCount = 0;
    } else if (char === "}") {
      if (braceLineCount > maxBlockLines) maxBlockLines = braceLineCount;
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

function scoreCommentRatio(content: string, totalLines: number): number {
  if (totalLines === 0) return 0;
  const commentLines = content.split("\n").filter((line) => {
    const trimmed = line.trim();
    return trimmed.startsWith("//") || trimmed.startsWith("#") ||
           trimmed.startsWith("/*") || trimmed.startsWith("*") ||
           trimmed.startsWith("/**") || trimmed === "*/" ||
           trimmed.startsWith("--");
  }).length;

  const ratio = commentLines / totalLines;
  if (ratio >= 0.15 && ratio <= 0.4) return 0;
  if (ratio >= 0.05 && ratio < 0.15) return 3;
  if (ratio < 0.05 && totalLines > 50) return 8;
  if (ratio > 0.4) return 5;
  if (ratio < 0.02) return 12;
  return 20;
}

function scoreDependencyDepth(path: string, archMapData: ArchMapData): number {
  const deps = archMapData.fileDependencies[path] || [];
  const transitive = archMapData.fileDependents[path] || [];
  const totalConnections = deps.length + transitive.length;

  if (totalConnections <= 3) return 0;
  if (totalConnections <= 10) return 2;
  if (totalConnections <= 25) return 5;
  if (totalConnections <= 50) return 10;
  return 15;
}

function scoreTodoDensity(content: string, totalLines: number): number {
  if (totalLines === 0) return 0;
  const todoMatches = content.match(/(?:TODO|FIXME|HACK|XXX|BUG|OPTIMIZE)\b/gi);
  const count = todoMatches ? todoMatches.length : 0;
  const density = count / totalLines;

  if (count === 0) return 0;
  if (density <= 0.01) return 2;
  if (density <= 0.03) return 5;
  if (density <= 0.05) return 8;
  return 10;
}

function scoreTestCoverage(path: string, archMapData: ArchMapData): number {
  const module = archMapData.classifyFileModule[path] || "unknown";
  const moduleFiles = archMapData.moduleFiles[module] || [];

  const hasNearbyTest = moduleFiles.some((f) =>
    f.includes(".test.") || f.includes(".spec.") || f.includes("__tests__")
  );
  return hasNearbyTest ? 0 : 5;
}

function scoreDuplication(percentDuplicated: number): number {
  if (percentDuplicated === 0) return 0;
  if (percentDuplicated <= 10) return 3;
  if (percentDuplicated <= 25) return 7;
  if (percentDuplicated <= 50) return 12;
  return 15;
}

// ── Duplication detection ───────────────────────────────────────────────────

function detectDuplication(files: Record<string, string>): Record<string, number> {
  const result: Record<string, number> = {};
  const paths = Object.keys(files);

  // Pre-split all files into lines
  const fileLines: Record<string, string[]> = {};
  for (const path of paths) {
    fileLines[path] = files[path].split("\n");
  }

  for (let i = 0; i < paths.length; i++) {
    const pathA = paths[i];
    const linesA = fileLines[pathA];
    if (linesA.length < 10) {
      result[pathA] = 0;
      continue;
    }

    const linesBSet = new Set<string>();
    for (let j = 0; j < paths.length; j++) {
      if (i === j) continue;
      const linesB = fileLines[paths[j]];
      for (const line of linesB) {
        const trimmed = line.trim();
        if (trimmed.length > 10) linesBSet.add(trimmed);
      }
    }

    let duplicatedLines = 0;
    for (const line of linesA) {
      const trimmed = line.trim();
      if (trimmed.length > 10 && linesBSet.has(trimmed)) {
        duplicatedLines++;
      }
    }

    result[pathA] = linesA.length > 0 ? (duplicatedLines / linesA.length) * 100 : 0;
  }

  return result;
}

// ── Issue collection ────────────────────────────────────────────────────────

function collectIssues(scores: FileDebtScore["scores"], path: string): string[] {
  const issues: string[] = [];
  if (scores.fileSize >= 10) issues.push(`Large file (${scores.fileSize}/20)`);
  if (scores.functionLength >= 10) issues.push(`Large function blocks (${scores.functionLength}/20)`);
  if (scores.commentRatio >= 8) issues.push(`Poor comment ratio (${scores.commentRatio}/20)`);
  if (scores.dependencyDepth >= 10) issues.push(`High dependency depth (${scores.dependencyDepth}/15)`);
  if (scores.todoDensity >= 5) issues.push(`Many TODO/FIXME markers (${scores.todoDensity}/10)`);
  if (scores.testCoverage >= 5) issues.push(`Missing tests (${scores.testCoverage}/10)`);
  return issues;
}

// ── Main analysis (duplicated from DebtAnalyzer.analyzeAllFiles) ────────────

function analyzeAllFiles(files: Record<string, string>, archMapData: ArchMapData): DebtReport {
  const paths = Object.keys(files);
  const fileScores: FileDebtScore[] = [];

  // First pass: score each file
  for (const path of paths) {
    const content = files[path];
    const lines = content.split("\n");
    const totalLines = lines.length;

    const scores = {
      fileSize: scoreFileSize(totalLines),
      functionLength: scoreFunctionLength(content),
      commentRatio: scoreCommentRatio(content, totalLines),
      duplication: 0, // filled in second pass
      dependencyDepth: scoreDependencyDepth(path, archMapData),
      todoDensity: scoreTodoDensity(content, totalLines),
      testCoverage: scoreTestCoverage(path, archMapData),
    };

    const totalScore = Object.values(scores).reduce((sum, s) => sum + s, 0);
    const issues = collectIssues(scores, path);

    fileScores.push({
      path,
      module: archMapData.classifyFileModule[path] || "unknown",
      scores,
      totalScore,
      grade: gradeFromScore(totalScore),
      issues,
    });
  }

  // Second pass: duplication detection
  const duplicationMap = detectDuplication(files);
  for (const score of fileScores) {
    const dupPercent = duplicationMap[score.path] || 0;
    score.scores.duplication = scoreDuplication(dupPercent);
    score.totalScore = Object.values(score.scores).reduce((sum, s) => sum + s, 0);
    score.grade = gradeFromScore(score.totalScore);
    if (dupPercent > 0) {
      score.issues.push(`~${Math.round(dupPercent)}% duplicated code`);
    }
  }

  // Module aggregation
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

  // Overall
  const overallScore = fileScores.length > 0
    ? Math.round(fileScores.reduce((s, f) => s + f.totalScore, 0) / fileScores.length * 10) / 10
    : 0;

  const hotspots = fileScores
    .sort((a, b) => b.totalScore - a.totalScore)
    .slice(0, 10)
    .map((f) => ({ file: f.path, score: f.totalScore }));

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
    totalFiles: paths.length,
    analyzedFiles: fileScores.length,
    fileScores,
    moduleScores,
    topIssues,
    hotspots,
  };
}

// ── Worker message handler ──────────────────────────────────────────────────

self.onmessage = (event: MessageEvent<AnalyzeMessage>) => {
  const { type, files, archMapData } = event.data;

  if (type === "analyze") {
    const report = analyzeAllFiles(files, archMapData);
    const response: AnalyzeResult = { type: "result", report };
    self.postMessage(response);
  }
};