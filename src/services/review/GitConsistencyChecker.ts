/**
 * @phase P2
 * @purpose Lightweight consistency check between the GitHub module's
 *          git2 status checks and standalone git_commands.rs.
 *          Two independent git-reading paths should agree.
 */

import { type GitCommandInterface } from './GitSignalsAnalyzer';

/** A discrepancy between two git status readings. */
export interface Discrepancy {
  type: 'file_missing' | 'status_mismatch' | 'extra_file';
  file: string;
  githubStatus?: string;
  standaloneStatus?: string;
  description: string;
}

/** Result of a consistency check. */
export interface ConsistencyResult {
  consistent: boolean;
  discrepancies: Discrepancy[];
  checkedAt: string;
}

/** Interface for the GitHub module's git2-based status check. */
export interface GitHubStatusProvider {
  /** Get file statuses using the GitHub module's git2 path. */
  getStatuses(): Promise<Map<string, string>>;
}

/**
 * Checks consistency between two git status paths.
 */
export class GitConsistencyChecker {
  private git: GitCommandInterface;
  private githubStatus: GitHubStatusProvider;
  constructor(
    git: GitCommandInterface,
    githubStatus: GitHubStatusProvider,
  ) {
    this.git = git;
    this.githubStatus = githubStatus;
  }

  /**
   * Runs both git status paths on the same repo state and compares.
   *
   * @returns Consistency result with any discrepancies
   */
  async checkConsistency(): Promise<ConsistencyResult> {
    // Get statuses from both paths
    const githubStatuses = await this.githubStatus.getStatuses();

    // Get statuses from standalone git_commands.rs via git diff --name-status
    const rawDiff = await this.git.diff('HEAD', 'HEAD');
    const standaloneStatuses = this.parseGitStatus(rawDiff);

    const discrepancies: Discrepancy[] = [];

    // Check for files in GitHub but not standalone
    for (const [file, ghStatus] of githubStatuses) {
      if (!standaloneStatuses.has(file)) {
        discrepancies.push({
          type: 'file_missing',
          file,
          githubStatus: ghStatus,
          description: `File "${file}" has status "${ghStatus}" in GitHub module but is missing from standalone git_commands`,
        });
      } else {
        const saStatus = standaloneStatuses.get(file);
        if (ghStatus !== saStatus) {
          discrepancies.push({
            type: 'status_mismatch',
            file,
            githubStatus: ghStatus,
            standaloneStatus: saStatus,
            description: `File "${file}" has status "${ghStatus}" in GitHub module but "${saStatus}" in standalone git_commands`,
          });
        }
      }
    }

    // Check for files in standalone but not GitHub
    for (const [file, saStatus] of standaloneStatuses) {
      if (!githubStatuses.has(file)) {
        discrepancies.push({
          type: 'extra_file',
          file,
          standaloneStatus: saStatus,
          description: `File "${file}" has status "${saStatus}" in standalone git_commands but is missing from GitHub module`,
        });
      }
    }

    return {
      consistent: discrepancies.length === 0,
      discrepancies,
      checkedAt: new Date().toISOString(),
    };
  }

  /**
   * Parses git diff --name-status output into a map.
   */
  private parseGitStatus(rawDiff: string): Map<string, string> {
    const map = new Map<string, string>();
    const lines = rawDiff.split('\n');

    for (const line of lines) {
      // Format: STATUS\tpath (e.g., "M\tsrc/file.ts", "A\tsrc/new.ts")
      const match = line.match(/^([MARD])\t(.+)$/);
      if (match) {
        const statusMap: Record<string, string> = {
          M: 'modified',
          A: 'added',
          R: 'renamed',
          D: 'deleted',
        };
        map.set(match[2], statusMap[match[1]] ?? match[1]);
      }
    }

    return map;
  }
}

// ── Singleton pattern (follows existing codebase convention) ───────
let instance: GitConsistencyChecker | null = null;

export function getGitConsistencyChecker(): GitConsistencyChecker {
  if (!instance) throw new Error('GitConsistencyChecker not initialized. Call initGitConsistencyChecker() first.');
  return instance;
}

export function initGitConsistencyChecker(git: import('./GitSignalsAnalyzer').GitCommandInterface, githubStatus: import('./GitConsistencyChecker').GitHubStatusProvider): GitConsistencyChecker {
  instance = new GitConsistencyChecker(git, githubStatus);
  return instance;
}
