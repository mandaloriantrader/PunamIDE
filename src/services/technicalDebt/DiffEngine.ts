/**
 * DiffEngine.ts — Fix #10
 *
 * Computes the difference between consecutive debt analysis scans.
 * Shows what improved, what regressed, what's new, and what was removed.
 *
 * Design:
 *  - Stores the previous scan's per-file scores and issue classifications
 *  - On each new scan, compares against previous snapshot
 *  - Produces a structured diff with sorted lists (biggest changes first)
 *  - Pure logic — no I/O, no UI concerns
 *  - Threshold: only reports changes > 3 points (same as trend detection)
 *
 * Usage:
 *   const engine = getDiffEngine();
 *   const diff = engine.computeDiff(currentFiles, currentOverall);
 *   // diff.improved, diff.regressed, diff.newFiles, diff.removedFiles
 *
 * The dashboard calls this after each analysis and displays a
 * "Changes Since Last Scan" panel.
 */

import { detectPrimaryIssue } from './DebtAnalyzer'
import type { FileDebtMetrics } from './DebtAnalyzer'

// ── Types ──────────────────────────────────────────────────────────────────────

export interface FileDelta {
  filePath: string
  previousScore: number
  currentScore: number
  /** Positive = improved, negative = regressed. */
  delta: number
  /** Issue types that appeared (not present in previous scan). */
  newIssues: string[]
  /** Issue types that disappeared (present before, resolved now). */
  resolvedIssues: string[]
  isNew: boolean
  isRemoved: boolean
}

export interface ScanDiff {
  /** Files that improved by > threshold points, sorted by biggest gain. */
  improved: FileDelta[]
  /** Files that regressed by > threshold points, sorted by biggest drop. */
  regressed: FileDelta[]
  /** Files not present in previous scan. */
  newFiles: FileDelta[]
  /** Files no longer present in current scan. */
  removedFiles: FileDelta[]
  /** Overall score change (current - previous). */
  overallDelta: number
  /** Previous overall score. */
  previousOverall: number
  /** Current overall score. */
  currentOverall: number
  /** Timestamp of this diff computation. */
  timestamp: number
  /** Number of total files in current scan. */
  totalFiles: number
  /** Whether a previous scan existed to diff against. */
  hasPrevious: boolean
}

// ── Constants ──────────────────────────────────────────────────────────────────

/** Minimum score change to report as improved/regressed (avoids noise). */
const CHANGE_THRESHOLD = 3

// ── Previous scan snapshot ─────────────────────────────────────────────────────

interface FileSnapshot {
  score: number
  issue: string
}

// ── DiffEngine ─────────────────────────────────────────────────────────────────

export class DiffEngine {
  private previousSnapshot: Map<string, FileSnapshot> | null = null
  private previousOverall: number = 0

  /**
   * Compute the diff between the current scan and the previous one.
   *
   * @param currentFiles   FileDebtMetrics[] from the latest analysis
   * @param currentOverall Overall project score from latest analysis
   * @returns ScanDiff with categorized changes
   */
  computeDiff(
    currentFiles: FileDebtMetrics[],
    currentOverall: number,
  ): ScanDiff {
    // Build current snapshot
    const current = new Map<string, FileSnapshot>()
    for (const file of currentFiles) {
      current.set(file.filePath, {
        score: file.fileScore,
        issue: detectPrimaryIssue(file),
      })
    }

    // First scan — no previous data to diff against
    if (!this.previousSnapshot) {
      this.previousSnapshot = current
      this.previousOverall = currentOverall
      return {
        improved: [],
        regressed: [],
        newFiles: [],
        removedFiles: [],
        overallDelta: 0,
        previousOverall: currentOverall,
        currentOverall,
        timestamp: Date.now(),
        totalFiles: currentFiles.length,
        hasPrevious: false,
      }
    }

    const improved: FileDelta[] = []
    const regressed: FileDelta[] = []
    const newFiles: FileDelta[] = []
    const removedFiles: FileDelta[] = []

    // Compare current files against previous
    for (const [fp, cur] of current) {
      const prev = this.previousSnapshot.get(fp)

      if (!prev) {
        // New file — not in previous scan
        newFiles.push({
          filePath: fp,
          previousScore: 0,
          currentScore: cur.score,
          delta: 0,
          newIssues: cur.issue !== 'minor_issues' ? [cur.issue] : [],
          resolvedIssues: [],
          isNew: true,
          isRemoved: false,
        })
        continue
      }

      const delta = cur.score - prev.score

      if (delta > CHANGE_THRESHOLD) {
        improved.push({
          filePath: fp,
          previousScore: prev.score,
          currentScore: cur.score,
          delta,
          newIssues: [],
          resolvedIssues: prev.issue !== cur.issue && prev.issue !== 'minor_issues'
            ? [prev.issue]
            : [],
          isNew: false,
          isRemoved: false,
        })
      } else if (delta < -CHANGE_THRESHOLD) {
        regressed.push({
          filePath: fp,
          previousScore: prev.score,
          currentScore: cur.score,
          delta,
          newIssues: cur.issue !== prev.issue && cur.issue !== 'minor_issues'
            ? [cur.issue]
            : [],
          resolvedIssues: [],
          isNew: false,
          isRemoved: false,
        })
      }
    }

    // Files removed (in previous but not in current)
    for (const [fp, prev] of this.previousSnapshot) {
      if (!current.has(fp)) {
        removedFiles.push({
          filePath: fp,
          previousScore: prev.score,
          currentScore: 0,
          delta: 0,
          newIssues: [],
          resolvedIssues: prev.issue !== 'minor_issues' ? [prev.issue] : [],
          isNew: false,
          isRemoved: true,
        })
      }
    }

    // Sort: improved by biggest gain, regressed by biggest drop
    improved.sort((a, b) => b.delta - a.delta)
    regressed.sort((a, b) => a.delta - b.delta)

    const overallDelta = currentOverall - this.previousOverall

    const result: ScanDiff = {
      improved,
      regressed,
      newFiles,
      removedFiles,
      overallDelta,
      previousOverall: this.previousOverall,
      currentOverall,
      timestamp: Date.now(),
      totalFiles: currentFiles.length,
      hasPrevious: true,
    }

    // Store current as previous for next diff
    this.previousSnapshot = current
    this.previousOverall = currentOverall

    return result
  }

  /** Reset diff state (e.g. when project changes). */
  reset(): void {
    this.previousSnapshot = null
    this.previousOverall = 0
  }

  /** Whether a previous scan exists to diff against. */
  get hasPrevious(): boolean {
    return this.previousSnapshot !== null
  }
}

// ── Singleton ──────────────────────────────────────────────────────────────────

let instance: DiffEngine | null = null

export function getDiffEngine(): DiffEngine {
  if (!instance) instance = new DiffEngine()
  return instance
}
