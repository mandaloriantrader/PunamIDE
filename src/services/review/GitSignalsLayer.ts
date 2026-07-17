/**
 * @phase P2
 * @purpose AnalysisLayer wrapper around GitSignalsAnalyzer.
 *          Provides churn-score findings and git-consistency checks
 *          as a pluggable layer for the Unified Analysis Engine.
 *          Requires a GitCommandInterface (Tauri git commands) to function.
 */

import type { AnalysisLayer, AnalysisContext, Finding, UnifiedAnalysisConfig } from './types';
import { GitSignalsAnalyzer, type GitCommandInterface } from './GitSignalsAnalyzer';
import type { ExtendedChurnData } from './GitSignalsAnalyzer';
import { GitConsistencyChecker, type GitHubStatusProvider, type ConsistencyResult } from './GitConsistencyChecker';

/**
 * Analysis layer that enriches findings with git churn signals.
 * When a GitCommandInterface is available, this layer computes per-file
 * churn scores, author counts, and commit frequency; otherwise it
 * gracefully degrades with zero findings.
 */
export class GitSignalsLayer implements AnalysisLayer {
  name = 'git-signals';
  private analyzer: GitSignalsAnalyzer | null = null;
  private checker: GitConsistencyChecker | null = null;
  private git: GitCommandInterface | null;

  constructor(git?: GitCommandInterface, githubStatus?: GitHubStatusProvider) {
    this.git = git ?? null;
    if (git) {
      this.analyzer = new GitSignalsAnalyzer(git);
      if (githubStatus) {
        this.checker = new GitConsistencyChecker(git, githubStatus);
      }
    }
  }

  isEnabled(config: UnifiedAnalysisConfig): boolean {
    const layers = config.enabledLayers ?? config.enabledLayers;
    return (
      this.git !== null &&
      (layers?.includes('git') || layers?.includes('git-signals') || false)
    );
  }

  async analyze(files: string[], _context: AnalysisContext): Promise<Finding[]> {
    if (!this.git) return [];
    const findings: Finding[] = [];

    // Run consistency check if available
    if (this.checker) {
      try {
        const consistency: ConsistencyResult = await this.checker.checkConsistency();
        if (!consistency.consistent) {
          for (const disc of consistency.discrepancies) {
            findings.push({
              id: `git-consistency:${disc.file}:${disc.type}`,
              file: disc.file,
              source: 'review-agent' as const,
              severity: 'medium',
              confidence: 'direct',
              title: `Git consistency: ${disc.type}`,
              description: disc.description,
              whyFlagged: `GitHub status: ${disc.githubStatus ?? 'none'} | Standalone: ${disc.standaloneStatus ?? 'none'}`,
              fix: 'Investigate discrepancy between git status paths.',
            });
          }
        }
      } catch {
        /* degrade gracefully */
      }
    }

    // Compute churn per file
    if (!this.analyzer) return findings;
    try {
      const churnMap = await this.analyzer.computeChurnForFiles(files);

      for (const [file, churn] of churnMap) {
        if (churn.churnScore > 30) {
          findings.push({
            id: `git-churn:${file}`,
            file,
            source: 'review-agent' as const,
            severity: churn.churnScore > 60 ? 'high' : 'medium',
            confidence: 'direct',
            title: `High churn: ${churn.churnScore} pts`,
            description: `${churn.commitsLast30d} commits by ${churn.authors?.length ?? 1} author(s) in last 30d — hot file.`,
            whyFlagged: `Churn score ${churn.churnScore} (${churn.totalCommits} total commits, ${churn.linesAdded}+ / ${churn.linesDeleted}-)`,
            fix: 'Consider splitting or stabilizing this file.',
          });
        }
      }
    } catch {
      /* degrade gracefully */
    }

    return findings;
  }
}

// ── Singleton pattern ───────
let instance: GitSignalsLayer | null = null;

export function getGitSignalsLayer(git?: GitCommandInterface, githubStatus?: GitHubStatusProvider): GitSignalsLayer {
  if (!instance && git) {
    instance = new GitSignalsLayer(git, githubStatus);
  }
  return instance ?? new GitSignalsLayer();
}