/**
 * Approval Helpers — Utility functions for integrating the approval gate
 * into the tool loops. Builds PatchProposal objects from tool call arguments,
 * generates rejection/partial-acceptance context messages, and determines
 * which tools are subject to the approval gate.
 *
 * Requirements: 5.5, 5.6, 5.7
 */

import type { PatchProposal } from "./approvalGate";
import type { DiffHunk } from "../../store/aiStore";

// ─── Patch Tool Detection ────────────────────────────────────────────────────

/** Tools that produce file edits and should go through the approval gate */
const PATCH_TOOLS = ["apply_patch", "apply_multi_patch"] as const;

/**
 * Checks whether a tool name is a patch tool that should trigger
 * the approval gate when thresholds are exceeded.
 */
export function isPatchTool(toolName: string): boolean {
  return (PATCH_TOOLS as readonly string[]).includes(toolName);
}

// ─── PatchProposal Builder ───────────────────────────────────────────────────

/**
 * Builds a PatchProposal from the raw tool call arguments.
 * Extracts file paths, line counts, and diff hunks from the tool input.
 *
 * @param toolName - "apply_patch" or "apply_multi_patch"
 * @param args - The tool call input parameters
 * @param agentText - The agent's reasoning text from the preceding message
 */
export function buildPatchProposalFromToolArgs(
  toolName: string,
  args: Record<string, unknown>,
  agentText: string
): PatchProposal {
  const id = `patch-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const now = Date.now();

  if (toolName === "apply_multi_patch") {
    return buildFromMultiPatch(id, args, agentText, now);
  }

  // Single apply_patch
  return buildFromSinglePatch(id, args, agentText, now);
}

function buildFromSinglePatch(
  id: string,
  args: Record<string, unknown>,
  agentText: string,
  createdAt: number
): PatchProposal {
  const filePath = (args.path || args.file_path || "") as string;
  const patch = (args.patch || args.diff || args.content || "") as string;

  const hunks = extractHunksFromPatch(patch, filePath);
  const linesChanged = countLinesChanged(patch);

  return {
    id,
    unifiedDiff: patch,
    filesAffected: [filePath].filter(Boolean),
    linesChanged,
    agentReasoning: extractReasoning(agentText),
    hunks,
    createdAt,
  };
}

function buildFromMultiPatch(
  id: string,
  args: Record<string, unknown>,
  agentText: string,
  createdAt: number
): PatchProposal {
  const patches = (args.patches || args.edits || []) as Array<Record<string, unknown>>;
  const filesAffected: string[] = [];
  const allHunks: DiffHunk[] = [];
  let totalLinesChanged = 0;
  let combinedDiff = "";
  let hunkId = 0;

  for (const p of patches) {
    const filePath = (p.path || p.file_path || "") as string;
    const patch = (p.patch || p.diff || p.content || "") as string;

    if (filePath) filesAffected.push(filePath);
    totalLinesChanged += countLinesChanged(patch);
    combinedDiff += `--- a/${filePath}\n+++ b/${filePath}\n${patch}\n`;

    const hunks = extractHunksFromPatch(patch, filePath);
    for (const h of hunks) {
      allHunks.push({ ...h, id: hunkId++ });
    }
  }

  return {
    id,
    unifiedDiff: combinedDiff,
    filesAffected: [...new Set(filesAffected)],
    linesChanged: totalLinesChanged,
    agentReasoning: extractReasoning(agentText),
    hunks: allHunks,
    createdAt,
  };
}

// ─── Diff Parsing Helpers ────────────────────────────────────────────────────

/**
 * Counts the number of lines changed (added + removed) in a patch string.
 */
function countLinesChanged(patch: string): number {
  if (!patch) return 0;
  const lines = patch.split("\n");
  let count = 0;
  for (const line of lines) {
    if (line.startsWith("+") && !line.startsWith("+++")) count++;
    if (line.startsWith("-") && !line.startsWith("---")) count++;
  }
  // If no diff-style markers found, estimate from total content length
  if (count === 0 && patch.trim().length > 0) {
    count = lines.length;
  }
  return count;
}

/**
 * Extracts DiffHunk objects from a unified diff string.
 */
function extractHunksFromPatch(patch: string, filePath: string): DiffHunk[] {
  if (!patch) return [];

  const lines = patch.split("\n");
  const hunks: DiffHunk[] = [];
  let currentHunk: { startLine: number; oldLines: string[]; newLines: string[] } | null = null;
  let lineNum = 1;
  let hunkId = 0;

  for (const line of lines) {
    // Hunk header: @@ -startOld,countOld +startNew,countNew @@
    const hunkMatch = line.match(/@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunkMatch) {
      // Finalize previous hunk
      if (currentHunk) {
        hunks.push({
          id: hunkId++,
          filePath,
          startLine: currentHunk.startLine,
          endLine: lineNum - 1,
          oldContent: currentHunk.oldLines.join("\n"),
          newContent: currentHunk.newLines.join("\n"),
        });
      }
      lineNum = parseInt(hunkMatch[2], 10);
      currentHunk = { startLine: lineNum, oldLines: [], newLines: [] };
      continue;
    }

    if (!currentHunk) {
      // Before first hunk header — start a synthetic one
      if (line.startsWith("+") || line.startsWith("-") || line.startsWith(" ")) {
        currentHunk = { startLine: 1, oldLines: [], newLines: [] };
      } else {
        continue;
      }
    }

    if (line.startsWith("+") && !line.startsWith("+++")) {
      currentHunk.newLines.push(line.slice(1));
      lineNum++;
    } else if (line.startsWith("-") && !line.startsWith("---")) {
      currentHunk.oldLines.push(line.slice(1));
    } else if (line.startsWith(" ")) {
      currentHunk.oldLines.push(line.slice(1));
      currentHunk.newLines.push(line.slice(1));
      lineNum++;
    }
  }

  // Finalize last hunk
  if (currentHunk) {
    hunks.push({
      id: hunkId++,
      filePath,
      startLine: currentHunk.startLine,
      endLine: Math.max(currentHunk.startLine, lineNum - 1),
      oldContent: currentHunk.oldLines.join("\n"),
      newContent: currentHunk.newLines.join("\n"),
    });
  }

  // Fallback: if no hunks extracted, create a single synthetic hunk
  if (hunks.length === 0 && patch.trim()) {
    hunks.push({
      id: 0,
      filePath,
      startLine: 1,
      endLine: patch.split("\n").length,
      oldContent: "",
      newContent: patch,
    });
  }

  return hunks;
}

/**
 * Extracts the agent's reasoning from the preceding text.
 * Takes the last meaningful paragraph or the last 200 characters.
 */
function extractReasoning(text: string): string {
  if (!text) return "Agent proposed this edit.";

  // Take the last paragraph or last 300 chars
  const trimmed = text.trim();
  const paragraphs = trimmed.split(/\n\n+/);
  const lastParagraph = paragraphs[paragraphs.length - 1] || "";

  if (lastParagraph.length > 300) {
    return lastParagraph.slice(0, 297) + "...";
  }

  return lastParagraph || trimmed.slice(-300);
}

// ─── Context Message Builders ────────────────────────────────────────────────

/**
 * Builds a rejection context message to inject into the agent conversation
 * when the user rejects a proposed edit.
 *
 * Requirement 5.6: inject "user rejected" + diff summary
 */
export function buildRejectionContext(
  proposal: PatchProposal,
  reason?: string
): string {
  const reasonText = reason || "user rejected";
  const filesList = proposal.filesAffected.join(", ");
  const diffSummary = proposal.unifiedDiff.length > 500
    ? proposal.unifiedDiff.slice(0, 497) + "..."
    : proposal.unifiedDiff;

  return [
    `⚠️ Edit REJECTED by user.`,
    `Reason: ${reasonText}`,
    `Files affected: ${filesList}`,
    `Lines changed: ${proposal.linesChanged}`,
    ``,
    `Rejected diff summary:`,
    "```",
    diffSummary,
    "```",
    ``,
    `Do NOT retry this exact edit. Ask the user what they'd prefer or take a different approach.`,
  ].join("\n");
}

/**
 * Builds a partial-acceptance context message to inject into the conversation
 * when the user accepts only some hunks.
 *
 * Requirement 5.7: list accepted and rejected hunks
 */
export function buildPartialAcceptanceContext(
  proposal: PatchProposal,
  acceptedHunkIds: number[]
): string {
  const acceptedSet = new Set(acceptedHunkIds);
  const accepted: string[] = [];
  const rejected: string[] = [];

  for (const hunk of proposal.hunks) {
    const desc = `${hunk.filePath}:${hunk.startLine}-${hunk.endLine}`;
    if (acceptedSet.has(hunk.id)) {
      accepted.push(desc);
    } else {
      rejected.push(desc);
    }
  }

  return [
    `⚠️ Edit PARTIALLY ACCEPTED by user.`,
    ``,
    `✅ Accepted hunks (${accepted.length}):`,
    ...accepted.map((h) => `  - ${h}`),
    ``,
    `❌ Rejected hunks (${rejected.length}):`,
    ...rejected.map((h) => `  - ${h}`),
    ``,
    `Only the accepted hunks were applied. The rejected changes were discarded.`,
    `If the rejected hunks are still needed, discuss with the user before retrying.`,
  ].join("\n");
}
