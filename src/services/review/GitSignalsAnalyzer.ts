/**
 * @phase P2
 * @purpose Analyzes git history for churn signals. Calls Tauri git
 *          commands via an injected GitCommandInterface to compute
 *          commit frequency, recency, authors, and churn score.
 *          Results join onto FileRiskProfile.churn.
 */

import { type ChurnData } from './types';

/** Options for git log queries. */
export interface GitLogOptions {
  /** Maximum number of commits to return. */
  maxCount?: number;
  /** Follow file renames. */
  follow?: boolean;
  /** Include numstat (lines added/deleted per file). */
  numstat?: boolean;
  /** Format string for --format. */
  format?: string;
  /** Specific file path (optional — if omitted, repo-wide). */
  file?: string;
  /** Since date (e.g., '30 days ago'). */
  since?: string;
}

/**
 * Interface for Tauri git commands. Inject the real Tauri invoke
 * in production, a mock in tests.
 */
export interface GitCommandInterface {
  /** Run git log with given options, return raw stdout. */
  log(options: GitLogOptions): Promise<string>;
  /** Run git diff between two refs, return raw stdout. */
  diff(base: string, head: string): Promise<string>;
  /** Run git blame on a file, return raw stdout. */
  blame(file: string): Promise<string>;
}

/** Extended churn data with all computed fields. */
export interface ExtendedChurnData extends ChurnData {
  totalCommits: number;
  authors: string[];
  churnScore: number;
  linesAdded: number;
  linesDeleted: number;
}

/** Parsed git log entry. */
interface GitLogEntry {
  sha: string;
  date: string;       // ISO 8601
  author: string;
  files: { path: string; added: number; deleted: number }[];
}

/**
 * Analyzes git history for churn signals.
 */
export class GitSignalsAnalyzer {
  private git: GitCommandInterface;
  constructor(git: GitCommandInterface) {
    this.git = git;
  }

  /**
   * Computes churn data for all files in the repo.
   * Makes one repo-wide git log call and parses numstat output.
   *
   * @param since - Only consider commits since this date (default: '30 days ago')
   * @returns Map of file path → ExtendedChurnData
   */
  async computeChurnForAllFiles(since: string = '30 days ago'): Promise<Map<string, ExtendedChurnData>> {
    // One repo-wide call: git log --numstat --format='%H|%aI|%an' --since='30 days ago'
    const raw = await this.git.log({
      numstat: true,
      since,
      format: '%H|%aI|%an',
      maxCount: 1000,
    });

    const entries = this.parseGitLog(raw);
    return this.aggregateChurn(entries, since);
  }

  /**
   * Computes churn data for specific files.
   * Uses --follow for individual file history.
   *
   * @param files - File paths to analyze
   * @param since - Only consider commits since this date
   */
  async computeChurnForFiles(files: string[], since: string = '30 days ago'): Promise<Map<string, ExtendedChurnData>> {
    const allEntries: GitLogEntry[] = [];

    // Batch: one call per file (git log --follow is per-file)
    // For efficiency with many files, prefer computeChurnForAllFiles
    for (const file of files) {
      const raw = await this.git.log({
        follow: true,
        numstat: true,
        since,
        format: '%H|%aI|%an',
        file,
        maxCount: 500,
      });
      allEntries.push(...this.parseGitLog(raw));
    }

    return this.aggregateChurn(allEntries, since);
  }

  /**
   * Parses raw git log --numstat --format output.
   * Format: commit lines start with SHA|date|author, followed by numstat lines.
   *
   * @param raw - Raw git log stdout
   * @returns Parsed log entries
   */
  parseGitLog(raw: string): GitLogEntry[] {
    const entries: GitLogEntry[] = [];
    const lines = raw.split('\n');
    let currentEntry: GitLogEntry | null = null;

    for (const line of lines) {
      // Commit header: SHA|ISO date|author
      const headerMatch = line.match(/^([0-9a-f]{40})\|(.+?)\|(.+)$/);
      if (headerMatch) {
        if (currentEntry) entries.push(currentEntry);
        currentEntry = {
          sha: headerMatch[1],
          date: headerMatch[2],
          author: headerMatch[3],
          files: [],
        };
        continue;
      }

      // Numstat line: added\tdeleted\tpath
      const numstatMatch = line.match(/^(\d+|-)\t(\d+|-)\t(.+)$/);
      if (numstatMatch && currentEntry) {
        currentEntry.files.push({
          path: numstatMatch[3],
          added: numstatMatch[1] === '-' ? 0 : parseInt(numstatMatch[1], 10),
          deleted: numstatMatch[2] === '-' ? 0 : parseInt(numstatMatch[2], 10),
        });
      }
    }

    if (currentEntry) entries.push(currentEntry);
    return entries;
  }

  /**
   * Aggregates parsed log entries into per-file churn data.
   */
  aggregateChurn(entries: GitLogEntry[], since: string): Map<string, ExtendedChurnData> {
    const fileMap = new Map<string, {
      commits: Set<string>;
      authors: Set<string>;
      lastModified: string;
      linesAdded: number;
      linesDeleted: number;
    }>();

    for (const entry of entries) {
      for (const fileEntry of entry.files) {
        if (!fileMap.has(fileEntry.path)) {
          fileMap.set(fileEntry.path, {
            commits: new Set(),
            authors: new Set(),
            lastModified: entry.date,
            linesAdded: 0,
            linesDeleted: 0,
          });
        }
        const data = fileMap.get(fileEntry.path)!;
        data.commits.add(entry.sha);
        data.authors.add(entry.author);
        data.linesAdded += fileEntry.added;
        data.linesDeleted += fileEntry.deleted;
        // Track most recent modification
        if (entry.date > data.lastModified) {
          data.lastModified = entry.date;
        }
      }
    }

    // Convert to ExtendedChurnData
    const result = new Map<string, ExtendedChurnData>();
    for (const [path, data] of fileMap) {
      const commitsLast30d = data.commits.size;
      const authors = Array.from(data.authors);
      // churnScore = commitsLast30d * 2 + (authors.length > 3 ? 10 : 0), capped at 100
      const churnScore = Math.min(commitsLast30d * 2 + (authors.length > 3 ? 10 : 0), 100);

      result.set(path, {
        commitsLast30d,
        lastModified: data.lastModified,
        totalCommits: commitsLast30d,
        authors,
        churnScore,
        linesAdded: data.linesAdded,
        linesDeleted: data.linesDeleted,
      });
    }

    return result;
  }

  /**
   * Gets churn data for a single file.
   */
  async getChurnForFile(file: string, since: string = '30 days ago'): Promise<ExtendedChurnData | null> {
    const map = await this.computeChurnForFiles([file], since);
    return map.get(file) ?? null;
  }
}

// ── Singleton pattern (follows existing codebase convention) ───────
let instance: GitSignalsAnalyzer | null = null;

/**
 * Gets the singleton GitSignalsAnalyzer instance.
 * Must be initialized first via initGitSignalsAnalyzer() with a GitCommandInterface.
 */
export function getGitSignalsAnalyzer(): GitSignalsAnalyzer {
  if (!instance) throw new Error('GitSignalsAnalyzer not initialized. Call initGitSignalsAnalyzer() first.');
  return instance;
}

export function initGitSignalsAnalyzer(git: GitCommandInterface): GitSignalsAnalyzer {
  instance = new GitSignalsAnalyzer(git);
  return instance;
}
