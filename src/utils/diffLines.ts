/**
 * Shared line-diff utility — used by AiDiffPreview, InlineEditWidget,
 * MultiFileDiffBoard, and anywhere a red/green diff is needed.
 *
 * Uses LCS (Longest Common Subsequence) for accurate line-level diffs.
 */

export interface DiffLineEntry {
  id: number;
  original: string;
  proposed: string;
  changed: boolean;
}

/**
 * Compute a line-by-line diff between original and proposed text.
 * Returns an array of entries — unchanged lines have `changed: false`,
 * removed/added/modified lines have `changed: true`.
 */
export function getDiffLines(original: string, proposed: string): DiffLineEntry[] {
  const originalLines = original.split("\n");
  const proposedLines = proposed.split("\n");

  const lcs = computeLCS(originalLines, proposedLines);
  const result: DiffLineEntry[] = [];
  let oi = 0, pi = 0, li = 0, id = 0;

  while (oi < originalLines.length || pi < proposedLines.length) {
    if (li < lcs.length && oi < originalLines.length && pi < proposedLines.length &&
        originalLines[oi] === lcs[li] && proposedLines[pi] === lcs[li]) {
      result.push({ id: id++, original: originalLines[oi], proposed: proposedLines[pi], changed: false });
      oi++; pi++; li++;
    } else if (li < lcs.length && pi < proposedLines.length && proposedLines[pi] === lcs[li] &&
               (oi >= originalLines.length || originalLines[oi] !== lcs[li])) {
      result.push({ id: id++, original: originalLines[oi] ?? "", proposed: "", changed: true });
      oi++;
    } else if (li < lcs.length && oi < originalLines.length && originalLines[oi] === lcs[li] &&
               (pi >= proposedLines.length || proposedLines[pi] !== lcs[li])) {
      result.push({ id: id++, original: "", proposed: proposedLines[pi] ?? "", changed: true });
      pi++;
    } else {
      if (oi < originalLines.length && pi < proposedLines.length) {
        result.push({ id: id++, original: originalLines[oi], proposed: proposedLines[pi], changed: true });
        oi++; pi++;
      } else if (oi < originalLines.length) {
        result.push({ id: id++, original: originalLines[oi], proposed: "", changed: true });
        oi++;
      } else if (pi < proposedLines.length) {
        result.push({ id: id++, original: "", proposed: proposedLines[pi], changed: true });
        pi++;
      }
    }
  }

  return result;
}

/** Compute Longest Common Subsequence of two string arrays */
export function computeLCS(a: string[], b: string[]): string[] {
  const m = a.length, n = b.length;
  // For very large selections, fall back to simple line-by-line to avoid memory issues
  if (m * n > 1_000_000) {
    const maxLines = Math.max(m, n);
    return Array.from({ length: maxLines }, (_, i) => a[i] === b[i] ? a[i] : "").filter(Boolean);
  }

  const dp: number[][] = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0));

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (a[i - 1] === b[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1] + 1;
      } else {
        dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
      }
    }
  }

  const lcs: string[] = [];
  let i = m, j = n;
  while (i > 0 && j > 0) {
    if (a[i - 1] === b[j - 1]) {
      lcs.unshift(a[i - 1]);
      i--; j--;
    } else if (dp[i - 1][j] > dp[i][j - 1]) {
      i--;
    } else {
      j--;
    }
  }

  return lcs;
}
