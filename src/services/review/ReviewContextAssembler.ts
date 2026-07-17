/**
 * @phase P6
 * @purpose Assembles context for the Review Agent. Given a diff, pulls
 *          graph neighbors (fan-in/out), architecture layer, debt/security
 *          scores, and recent churn. Packages as structured context,
 *          NOT raw file dumps — to keep cost and latency bounded.
 */

import { type Finding, type FileRiskProfile, type DependencyGraph, type ChangedFile } from './types';

/** Info about a changed file in the diff. */
export interface ChangedFileInfo {
  path: string;
  addedLines: number;
  deletedLines: number;
  surroundingCode: string;
}

/** Graph context for a changed file. */
export interface GraphContext {
  file: string;
  callers: string[];
  callees: string[];
  layer: string;
  couplingScore: number;
  instability: number;
}

/** Architecture context for the review. */
export interface ArchitectureContext {
  violatedRules: string[];
  layerMemberships: Map<string, string>;
}

/** Churn context for a changed file. */
export interface ChurnContext {
  file: string;
  commitsLast30d: number;
  lastModified: string;
}

/** Complete context assembled for the Review Agent. */
export interface ReviewContext {
  diff: string;
  changedFiles: ChangedFileInfo[];
  graphContext: GraphContext[];
  architectureContext: ArchitectureContext;
  churnContext: ChurnContext[];
  existingFindings: Finding[];
}

/**
 * Assembles structured context for the LLM Review Agent.
 *
 * Context assembly logic:
 * 1. Parse the diff to get changed files
 * 2. For each changed file, look up graph neighbors (who imports it, what it imports)
 * 3. Get architecture layer membership for each changed file and its neighbors
 * 4. Get churn data for changed files
 * 5. Get existing findings (from debt, security, type, taint layers) for changed files
 * 6. Package everything into a structured prompt context
 * 7. Keep cost bounded: limit to changed files + 1-hop graph neighbors, not the whole repo
 */
export class ReviewContextAssembler {
  /**
   * Assembles review context from a diff and existing analysis data.
   *
   * @param diff - The code diff being reviewed
   * @param graph - The dependency graph
   * @param profiles - Existing FileRiskProfiles (from debt, security, type, taint layers)
   * @param changedFiles - Parsed changed files from the diff
   * @returns Structured context for the Review Agent
   */
  assembleContext(
    diff: string,
    graph: DependencyGraph | undefined,
    profiles: Map<string, FileRiskProfile>,
    changedFiles: ChangedFile[],
  ): ReviewContext {
    const changedPaths = changedFiles.map(f => f.path);

    // 1. Build changed file info with surrounding code
    const changedFileInfos: ChangedFileInfo[] = changedFiles.map(f => ({
      path: f.path,
      addedLines: f.addedLines,
      deletedLines: f.deletedLines,
      surroundingCode: this.extractSurroundingCode(diff, f),
    }));

    // 2. Build graph context for changed files (1-hop neighbors only)
    const graphContexts: GraphContext[] = [];
    if (graph) {
      for (const path of changedPaths) {
        const node = graph.nodes.get(path);
        if (node) {
          const profile = profiles.get(path);
          graphContexts.push({
            file: path,
            callers: node.importedBy,
            callees: node.imports,
            layer: profile?.architectureLayer ?? 'unknown',
            couplingScore: profile?.coupling?.fanOut ?? 0,
            instability: profile?.coupling?.instability ?? 0,
          });
        }
      }
    }

    // 3. Build architecture context
    const violatedRules: string[] = [];
    const layerMemberships = new Map<string, string>();
    for (const path of changedPaths) {
      const profile = profiles.get(path);
      if (profile?.architectureLayer) {
        layerMemberships.set(path, profile.architectureLayer);
      }
      // Collect architecture findings as violated rules
      for (const f of profile?.findings ?? []) {
        if (f.source === 'architecture' && !violatedRules.includes(f.title)) {
          violatedRules.push(f.title);
        }
      }
    }

    // 4. Build churn context
    const churnContexts: ChurnContext[] = changedPaths.map(path => {
      const profile = profiles.get(path);
      return {
        file: path,
        commitsLast30d: profile?.churn?.commitsLast30d ?? 0,
        lastModified: profile?.churn?.lastModified ?? '',
      };
    });

    // 5. Collect existing findings for changed files
    const existingFindings: Finding[] = [];
    for (const path of changedPaths) {
      const profile = profiles.get(path);
      if (profile) {
        existingFindings.push(...profile.findings);
      }
    }

    return {
      diff,
      changedFiles: changedFileInfos,
      graphContext: graphContexts,
      architectureContext: {
        violatedRules,
        layerMemberships,
      },
      churnContext: churnContexts,
      existingFindings,
    };
  }

  /**
   * Extracts surrounding code from the diff for a changed file.
   */
  private extractSurroundingCode(diff: string, file: ChangedFile): string {
    // Find the file's section in the diff
    const fileHeader = `diff --git a/${file.path} b/${file.path}`;
    const startIdx = diff.indexOf(fileHeader);
    if (startIdx === -1) return '';

    // Find the end of this file's diff section
    const nextFileIdx = diff.indexOf('diff --git', startIdx + 1);
    const endIdx = nextFileIdx === -1 ? diff.length : nextFileIdx;

    // Return the diff section (limited to first 2000 chars to bound context size)
    return diff.substring(startIdx, endIdx).substring(0, 2000);
  }

  /**
   * Formats the context as a structured prompt string for the LLM.
   */
  formatAsPrompt(context: ReviewContext): string {
    const sections: string[] = [];

    sections.push('## Code Diff');
    sections.push('```diff');
    sections.push(context.diff.substring(0, 5000)); // Bound the diff size
    sections.push('```');

    sections.push('\n## Changed Files');
    for (const f of context.changedFiles) {
      sections.push(`- ${f.path} (+${f.addedLines} -${f.deletedLines})`);
    }

    sections.push('\n## Dependency Graph Context');
    for (const g of context.graphContext) {
      sections.push(`- ${g.file}: layer=${g.layer}, instability=${g.instability.toFixed(2)}`);
      sections.push(`  callers: ${g.callers.join(', ') || 'none'}`);
      sections.push(`  callees: ${g.callees.join(', ') || 'none'}`);
    }

    sections.push('\n## Architecture Context');
    if (context.architectureContext.violatedRules.length > 0) {
      sections.push('Violated rules:');
      for (const rule of context.architectureContext.violatedRules) {
        sections.push(`- ${rule}`);
      }
    } else {
      sections.push('No architecture violations detected.');
    }

    sections.push('\n## Churn Context');
    for (const c of context.churnContext) {
      sections.push(`- ${c.file}: ${c.commitsLast30d} commits in last 30 days, last modified: ${c.lastModified}`);
    }

    sections.push('\n## Existing Findings (from static analysis)');
    if (context.existingFindings.length > 0) {
      for (const f of context.existingFindings) {
        sections.push(`- [${f.severity}] ${f.source}: ${f.title} at ${f.file}:${f.line ?? '?'}`);
      }
    } else {
      sections.push('No existing findings from static analysis.');
    }

    return sections.join('\n');
  }
}

// ── Singleton pattern (follows existing codebase convention) ───────
let instance: ReviewContextAssembler | null = null;

/**
 * Gets the singleton ReviewContextAssembler instance.
 * Every service uses this pattern: `let instance: T | null = null`
 * with an exported `getXxx(): T` getter.
 */
export function getReviewContextAssembler(): ReviewContextAssembler {
  if (!instance) instance = new ReviewContextAssembler();
  return instance;
}
