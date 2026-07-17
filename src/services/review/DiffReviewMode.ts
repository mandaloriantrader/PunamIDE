/**
 * @phase P2
 * @purpose Local, zero-infrastructure PR review mode. Gets git diff
 *          between two refs, parses changed files and line ranges,
 *          filters the full analysis pipeline to only changed files,
 *          and produces a DiffReviewResult.
 */

import type {
  Finding,
  FileRiskProfile,
  ChangedFile,
  DiffReviewResult,
  ReviewSummary,
  UnifiedAnalysisConfig,
  AnalysisResult,
} from './types';
import type { UnifiedAnalysisEngine } from './UnifiedAnalysisEngine';
import type { GitCommandInterface } from './GitSignalsAnalyzer';

/** Context window (lines before/after changed lines) to include findings. */
const CONTEXT_LINES = 3;

/**
 * Local diff-review mode — the zero-infrastructure version of PR review.
 * Works before any GitHub webhook exists.
 */
export class DiffReviewMode {
  private git: GitCommandInterface;
  private engine: UnifiedAnalysisEngine;
  constructor(
    git: GitCommandInterface,
    engine: UnifiedAnalysisEngine,
  ) {
    this.git = git;
    this.engine = engine;
  }

  /**
   * Reviews changes between two git refs.
   *
   * @param base - Base ref (branch name, commit SHA, or 'HEAD~N')
   * @param head - Head ref
   * @param config - Engine configuration
   * @returns Diff review result with profiles for changed files
   */
  async review(
    base: string,
    head: string,
    config: UnifiedAnalysisConfig,
  ): Promise<DiffReviewResult> {
    // 1. Get the diff
    const rawDiff = await this.git.diff(base, head);

    // 2. Parse changed files and line ranges
    const changedFiles = this.parseDiff(rawDiff);

    // 3. Run the full analysis pipeline on just the changed files
    const filePaths = changedFiles
      .filter(f => f.status !== 'deleted')
      .map(f => f.path);

    const profiles = await this.engine.analyzeDiff(filePaths, config);

    // 4. Filter findings to those within changed line ranges ± context
    const filteredProfiles = this.filterFindingsToChangedLines(profiles, changedFiles);

    // 5. Build summary
    const summary = this.buildSummary(changedFiles, filteredProfiles);

    return {
      base,
      head,
      changedFiles,
      profiles: filteredProfiles,
      summary,
    };
  }

  /**
   * Parses a unified git diff into ChangedFile[] with line ranges.
   *
   * @param rawDiff - Raw `git diff` stdout
   * @returns Array of changed files with metadata
   */
  parseDiff(rawDiff: string): ChangedFile[] {
    const files: ChangedFile[] = [];
    const lines = rawDiff.split('\n');

    let currentFile: ChangedFile | null = null;
    let addedLines = 0;
    let deletedLines = 0;
    let currentRanges: { start: number; end: number }[] = [];
    let rangeStart = 0;
    let inRange = false;

    for (const line of lines) {
      // File header: diff --git a/path b/path
      const fileMatch = line.match(/^diff --git a\/(.+?) b\/(.+)$/);
      if (fileMatch) {
        if (currentFile) {
          currentFile.addedLines = addedLines;
          currentFile.deletedLines = deletedLines;
          currentFile.changedLineRanges = currentRanges;
          files.push(currentFile);
        }
        currentFile = {
          path: fileMatch[2],
          status: 'modified',
          addedLines: 0,
          deletedLines: 0,
          changedLineRanges: [],
        };
        addedLines = 0;
        deletedLines = 0;
        currentRanges = [];
        inRange = false;
        continue;
      }

      // New file
      if (line.startsWith('new file mode')) {
        if (currentFile) currentFile.status = 'added';
        continue;
      }

      // Deleted file
      if (line.startsWith('deleted file mode')) {
        if (currentFile) currentFile.status = 'deleted';
        continue;
      }

      // Renamed
      if (line.startsWith('rename from') || line.startsWith('rename to')) {
        if (currentFile) currentFile.status = 'renamed';
        continue;
      }

      // Hunk header: @@ -old_start,old_len +new_start,new_len @@
      const hunkMatch = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/);
      if (hunkMatch && currentFile) {
        if (inRange && rangeStart > 0) {
          currentRanges.push({ start: rangeStart, end: rangeStart });
        }
        rangeStart = parseInt(hunkMatch[1], 10);
        inRange = true;
        continue;
      }

      // Added line
      if (line.startsWith('+') && !line.startsWith('+++') && currentFile) {
        addedLines++;
        if (inRange) {
          // Extend or start a range
          const lastRange = currentRanges[currentRanges.length - 1];
          if (lastRange && lastRange.end === rangeStart - 1) {
            lastRange.end = rangeStart;
          } else {
            currentRanges.push({ start: rangeStart, end: rangeStart });
          }
          rangeStart++;
        }
        continue;
      }

      // Deleted line
      if (line.startsWith('-') && !line.startsWith('---') && currentFile) {
        deletedLines++;
        continue;
      }

      // Context line (not + or -)
      if (inRange && line.startsWith(' ')) {
        rangeStart++;
      }
    }

    // Don't forget the last file
    if (currentFile) {
      currentFile.addedLines = addedLines;
      currentFile.deletedLines = deletedLines;
      currentFile.changedLineRanges = currentRanges;
      files.push(currentFile);
    }

    return files;
  }

  /**
   * Filters findings to those within changed line ranges ± context lines.
   */
  filterFindingsToChangedLines(
    profiles: AnalysisResult,
    changedFiles: ChangedFile[],
  ): Map<string, FileRiskProfile> {
    const changedFileMap = new Map(changedFiles.map(f => [f.path, f]));
    const result = new Map<string, FileRiskProfile>();

    for (const [file, profile] of profiles) {
      const changed = changedFileMap.get(file);
      if (!changed) {
        // File not in diff — include as-is (shouldn't happen in diff mode)
        result.set(file, profile);
        continue;
      }

      // Filter findings to changed line ranges ± CONTEXT_LINES
      const filteredFindings = profile.findings.filter(f => {
        if (!f.line) return true; // File-level findings always included
        return this.isInChangedRange(f.line, changed.changedLineRanges, CONTEXT_LINES);
      });

      result.set(file, {
        ...profile,
        findings: filteredFindings,
      });
    }

    return result;
  }

  /**
   * Checks if a line number is within any changed range ± context.
   */
  private isInChangedRange(
    line: number,
    ranges: { start: number; end: number }[],
    context: number,
  ): boolean {
    return ranges.some(r => line >= r.start - context && line <= r.end + context);
  }

  /**
   * Builds a review summary from the profiles.
   */
  private buildSummary(
    changedFiles: ChangedFile[],
    profiles: Map<string, FileRiskProfile>,
  ): ReviewSummary {
    let totalFindings = 0;
    let criticalCount = 0;
    let highCount = 0;
    let mediumCount = 0;
    let lowCount = 0;
    let infoCount = 0;
    const filesWithCritical: string[] = [];

    for (const [, profile] of profiles) {
      for (const f of profile.findings) {
        totalFindings++;
        switch (f.severity) {
          case 'critical': criticalCount++; filesWithCritical.push(profile.file); break;
          case 'high': highCount++; break;
          case 'medium': mediumCount++; break;
          case 'low': lowCount++; break;
          case 'info': infoCount++; break;
        }
      }
    }

    return {
      totalFiles: changedFiles.length,
      totalFindings,
      criticalCount,
      highCount,
      mediumCount,
      lowCount,
      infoCount,
      filesWithCritical,
    };
  }
}

// ── Singleton pattern (follows existing codebase convention) ───────
let instance: DiffReviewMode | null = null;

/**
 * Gets the singleton DiffReviewMode instance.
 * Must be initialized first via initDiffReviewMode() with git and engine.
 */
export function getDiffReviewMode(): DiffReviewMode {
  if (!instance) throw new Error('DiffReviewMode not initialized. Call initDiffReviewMode() first.');
  return instance;
}

export function initDiffReviewMode(git: import('./GitSignalsAnalyzer').GitCommandInterface, engine: import('./UnifiedAnalysisEngine').UnifiedAnalysisEngine): DiffReviewMode {
  instance = new DiffReviewMode(git, engine);
  return instance;
}
