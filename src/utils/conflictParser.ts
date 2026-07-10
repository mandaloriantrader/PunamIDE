/**
 * Conflict marker parser — parses git-style <<<<, ====, >>>> markers
 * into structured regions for the MergeConflictPanel UI.
 */

export interface ConflictRegion {
  id: number;
  /** 0-indexed line where <<<<<<< starts */
  startLine: number;
  /** 0-indexed line where >>>>>>> ends */
  endLine: number;
  /** Lines from the "ours" (current) side */
  oursLines: string[];
  /** Lines from the "theirs" (incoming) side */
  theirsLines: string[];
  /** Label after <<<<<<< (e.g. "Current File (user edits)" or "HEAD") */
  oursLabel: string;
  /** Label after >>>>>>> (e.g. "AI Proposed" or branch name) */
  theirsLabel: string;
}

export interface ParsedConflictFile {
  /** Original file content (with markers) */
  rawContent: string;
  /** Non-conflict regions (context lines between conflicts) */
  regions: ConflictRegion[];
  /** Total number of conflicts */
  conflictCount: number;
  /** Whether the file has any conflict markers */
  hasConflicts: boolean;
}

/**
 * Parse a file's content for git-style conflict markers.
 * Supports standard 3-way format:
 *   <<<<<<< label
 *   ... ours ...
 *   =======
 *   ... theirs ...
 *   >>>>>>> label
 */
export function parseConflictMarkers(content: string): ParsedConflictFile {
  const lines = content.split("\n");
  const regions: ConflictRegion[] = [];
  let id = 0;

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];

    if (line.startsWith("<<<<<<<")) {
      const oursLabel = line.slice(7).trim() || "Current";
      const startLine = i;
      const oursLines: string[] = [];
      const theirsLines: string[] = [];
      let inTheirs = false;
      let theirsLabel = "Incoming";
      i++;

      while (i < lines.length) {
        const current = lines[i];

        if (current.startsWith("=======")) {
          inTheirs = true;
          i++;
          continue;
        }

        if (current.startsWith(">>>>>>>")) {
          theirsLabel = current.slice(7).trim() || "Incoming";
          regions.push({
            id: id++,
            startLine,
            endLine: i,
            oursLines,
            theirsLines,
            oursLabel,
            theirsLabel,
          });
          i++;
          break;
        }

        if (inTheirs) {
          theirsLines.push(current);
        } else {
          oursLines.push(current);
        }
        i++;
      }
    } else {
      i++;
    }
  }

  return {
    rawContent: content,
    regions,
    conflictCount: regions.length,
    hasConflicts: regions.length > 0,
  };
}

/**
 * Resolve a single conflict region by choosing a resolution strategy.
 */
export type ResolutionStrategy = "ours" | "theirs" | "both";

export interface ConflictResolution {
  regionId: number;
  strategy: ResolutionStrategy;
}

/**
 * Apply resolutions to a conflicted file and return the clean content.
 */
export function resolveConflicts(
  content: string,
  resolutions: ConflictResolution[],
): string {
  const lines = content.split("\n");
  const result: string[] = [];
  const resolutionMap = new Map(resolutions.map((r) => [r.regionId, r.strategy]));

  let i = 0;
  let regionId = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (line.startsWith("<<<<<<<")) {
      const strategy = resolutionMap.get(regionId) || "both";
      const oursLines: string[] = [];
      const theirsLines: string[] = [];
      let inTheirs = false;
      i++;

      while (i < lines.length) {
        const current = lines[i];

        if (current.startsWith("=======")) {
          inTheirs = true;
          i++;
          continue;
        }

        if (current.startsWith(">>>>>>>")) {
          // Apply resolution
          if (strategy === "ours") {
            result.push(...oursLines);
          } else if (strategy === "theirs") {
            result.push(...theirsLines);
          } else {
            // "both" — keep both sides
            result.push(...oursLines);
            result.push(...theirsLines);
          }
          regionId++;
          i++;
          break;
        }

        if (inTheirs) {
          theirsLines.push(current);
        } else {
          oursLines.push(current);
        }
        i++;
      }
    } else {
      result.push(line);
      i++;
    }
  }

  return result.join("\n");
}

/**
 * Check if a file content has conflict markers.
 */
export function hasConflictMarkers(content: string): boolean {
  return content.includes("<<<<<<<") && content.includes("=======") && content.includes(">>>>>>>");
}

/**
 * Build a file's content with embedded git-style conflict markers from a 3-way conflict.
 *
 * Takes the actual (on-disk) content as the base and inserts conflict markers
 * showing the actual lines (ours/current) vs. the intended lines (theirs/incoming).
 *
 * If the file was entirely replaced (not a partial hunk), the whole file is wrapped
 * in a single conflict block.
 *
 * @param actualContent   - The content currently on disk (ours / current)
 * @param intendedContent - The content the refactoring wanted to write (theirs / incoming)
 * @param oursLabel       - Label for the "current" side (default: "Current (on disk)")
 * @param theirsLabel     - Label for the "incoming" side (default: "Refactoring")
 */
export function buildConflictMarkedContent(
  actualContent: string,
  intendedContent: string,
  oursLabel = "Current (on disk)",
  theirsLabel = "Refactoring",
): string {
  const actualLines = actualContent.split("\n");
  const intendedLines = intendedContent.split("\n");

  // Find common prefix
  let prefixEnd = 0;
  while (
    prefixEnd < actualLines.length &&
    prefixEnd < intendedLines.length &&
    actualLines[prefixEnd] === intendedLines[prefixEnd]
  ) {
    prefixEnd++;
  }

  // Find common suffix (from the end, after the prefix)
  let suffixStart = 0;
  while (
    suffixStart < actualLines.length - prefixEnd &&
    suffixStart < intendedLines.length - prefixEnd &&
    actualLines[actualLines.length - 1 - suffixStart] === intendedLines[intendedLines.length - 1 - suffixStart]
  ) {
    suffixStart++;
  }

  const oursConflictLines = actualLines.slice(prefixEnd, actualLines.length - suffixStart);
  const theirsConflictLines = intendedLines.slice(prefixEnd, intendedLines.length - suffixStart);

  // If there's actually no difference, return actual content unchanged
  if (oursConflictLines.length === 0 && theirsConflictLines.length === 0) {
    return actualContent;
  }

  const result: string[] = [];

  // Common prefix
  if (prefixEnd > 0) {
    result.push(...actualLines.slice(0, prefixEnd));
  }

  // Conflict block
  result.push(`<<<<<<< ${oursLabel}`);
  result.push(...oursConflictLines);
  result.push("=======");
  result.push(...theirsConflictLines);
  result.push(`>>>>>>> ${theirsLabel}`);

  // Common suffix
  if (suffixStart > 0) {
    result.push(...actualLines.slice(actualLines.length - suffixStart));
  }

  return result.join("\n");
}
