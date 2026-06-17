/**
 * Rust-native diff engine — faster than JS-based diffing for large files.
 */

import { invoke } from "@tauri-apps/api/core";

export interface DiffHunk {
  old_start: number;
  old_lines: number;
  new_start: number;
  new_lines: number;
  lines: DiffLine[];
}

export interface DiffLine {
  kind: "add" | "remove" | "context";
  content: string;
}

export interface DiffResult {
  hunks: DiffHunk[];
  additions: number;
  deletions: number;
}

/**
 * Compute a diff between two strings using the Rust backend.
 * Falls back to a simple JS diff if Tauri is unavailable.
 */
export async function diffStrings(oldText: string, newText: string): Promise<DiffResult> {
  try {
    return await invoke("diff_strings", { oldText, newText });
  } catch {
    // Fallback: simple line-by-line comparison
    return jsFallbackDiff(oldText, newText);
  }
}

function jsFallbackDiff(oldText: string, newText: string): DiffResult {
  const oldLines = oldText.split("\n");
  const newLines = newText.split("\n");
  const lines: DiffLine[] = [];
  let additions = 0;
  let deletions = 0;

  const maxLen = Math.max(oldLines.length, newLines.length);
  for (let i = 0; i < maxLen; i++) {
    if (i >= oldLines.length) {
      lines.push({ kind: "add", content: newLines[i] });
      additions++;
    } else if (i >= newLines.length) {
      lines.push({ kind: "remove", content: oldLines[i] });
      deletions++;
    } else if (oldLines[i] !== newLines[i]) {
      lines.push({ kind: "remove", content: oldLines[i] });
      lines.push({ kind: "add", content: newLines[i] });
      additions++;
      deletions++;
    } else {
      lines.push({ kind: "context", content: oldLines[i] });
    }
  }

  return {
    hunks: [{ old_start: 1, old_lines: oldLines.length, new_start: 1, new_lines: newLines.length, lines }],
    additions,
    deletions,
  };
}
