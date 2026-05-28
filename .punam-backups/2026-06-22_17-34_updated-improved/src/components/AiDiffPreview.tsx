import { useMemo, useState } from "react";
import { Check, X } from "lucide-react";

export interface ReviewFileChange {
  path: string;
  original: string;
  proposed: string;
  isNew: boolean;
  hasUnsavedChanges?: boolean;
}

export interface ReviewDeletion {
  path: string;
  original: string;
}

export interface ReviewChanges {
  fileChanges: ReviewFileChange[];
  deletions: ReviewDeletion[];
  commands: string[];
}

interface Props {
  changes: ReviewChanges;
  onApplyAll: () => void;
  onApplyFile: (path: string) => void;
  onRejectFile: (path: string) => void;
  onCancel: () => void;
}

type ReviewItem =
  | { type: "file"; path: string; original: string; proposed: string; isNew: boolean; hasUnsavedChanges?: boolean }
  | { type: "delete"; path: string; original: string; proposed: string; isNew: false };

function getDiffLines(original: string, proposed: string) {
  const originalLines = original.split("\n");
  const proposedLines = proposed.split("\n");

  // LCS-based diff: find longest common subsequence to identify actual changes
  const lcs = computeLCS(originalLines, proposedLines);
  const result: Array<{ id: number; original: string; proposed: string; changed: boolean }> = [];
  let oi = 0, pi = 0, li = 0, id = 0;

  while (oi < originalLines.length || pi < proposedLines.length) {
    if (li < lcs.length && oi < originalLines.length && pi < proposedLines.length &&
        originalLines[oi] === lcs[li] && proposedLines[pi] === lcs[li]) {
      // Common line — unchanged
      result.push({ id: id++, original: originalLines[oi], proposed: proposedLines[pi], changed: false });
      oi++; pi++; li++;
    } else if (li < lcs.length && pi < proposedLines.length && proposedLines[pi] === lcs[li] &&
               (oi >= originalLines.length || originalLines[oi] !== lcs[li])) {
      // Line removed from original
      result.push({ id: id++, original: originalLines[oi] ?? "", proposed: "", changed: true });
      oi++;
    } else if (li < lcs.length && oi < originalLines.length && originalLines[oi] === lcs[li] &&
               (pi >= proposedLines.length || proposedLines[pi] !== lcs[li])) {
      // Line added in proposed
      result.push({ id: id++, original: "", proposed: proposedLines[pi] ?? "", changed: true });
      pi++;
    } else {
      // Both differ from LCS — show as changed pair
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
function computeLCS(a: string[], b: string[]): string[] {
  const m = a.length, n = b.length;
  // For very large files, fall back to simple comparison to avoid memory issues
  if (m * n > 1_000_000) {
    // Fallback: simple line-by-line
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

  // Backtrack to find LCS
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

export default function AiDiffPreview({
  changes,
  onApplyAll,
  onApplyFile,
  onRejectFile,
  onCancel,
}: Props) {
  const reviewItems = useMemo<ReviewItem[]>(
    () => [
      ...changes.fileChanges.map((change) => ({ type: "file" as const, ...change })),
      ...changes.deletions.map((deletion) => ({
        type: "delete" as const,
        path: deletion.path,
        original: deletion.original,
        proposed: "",
        isNew: false as const,
      })),
    ],
    [changes]
  );

  const [selectedPath, setSelectedPath] = useState(reviewItems[0]?.path || "");
  const selectedItem = reviewItems.find((item) => item.path === selectedPath) || reviewItems[0];
  const diffLines = selectedItem
    ? getDiffLines(selectedItem.original, selectedItem.proposed)
    : [];

  return (
    <div className="diff-preview-overlay" role="dialog" aria-label="Review AI changes">
      <div className="diff-preview">
        <div className="diff-preview-header">
          <div>
            <h2>Review AI Changes</h2>
            <p>Inspect proposed edits before Punam writes to your project.</p>
          </div>
          <button className="icon-btn" type="button" onClick={onCancel} aria-label="Close review">
            <X size={16} />
          </button>
        </div>

        <div className="diff-preview-body">
          <aside className="diff-preview-sidebar">
            {reviewItems.map((item) => (
              <button
                key={`${item.type}-${item.path}`}
                type="button"
                className={`diff-file-item ${item.path === selectedItem?.path ? "selected" : ""}`}
                onClick={() => setSelectedPath(item.path)}
              >
                <span>{item.type === "delete" ? "- DELETE" : item.isNew ? "+ NEW" : "~ EDIT"}</span>
                <strong>{item.path}</strong>
                {item.type === "file" && item.hasUnsavedChanges && (
                  <em>Unsaved editor changes</em>
                )}
              </button>
            ))}
            {changes.commands.length > 0 && (
              <div className="diff-command-list">
                <span>Commands</span>
                {changes.commands.map((command, index) => (
                  <code key={`${command}-${index}`}>{command}</code>
                ))}
              </div>
            )}
          </aside>

          <section className="diff-preview-main">
            {selectedItem ? (
              <>
                <div className="diff-selected-header">
                  <span>
                    {selectedItem.path}
                    {selectedItem.type === "file" && selectedItem.hasUnsavedChanges && (
                      <strong className="diff-unsaved-warning">Unsaved changes in editor</strong>
                    )}
                  </span>
                  <div className="diff-selected-actions">
                    <button type="button" className="btn-secondary compact" onClick={() => onRejectFile(selectedItem.path)}>
                      Reject File
                    </button>
                    <button type="button" className="btn-primary compact" onClick={() => onApplyFile(selectedItem.path)}>
                      Apply File
                    </button>
                  </div>
                </div>
                <div className="diff-grid" aria-label="File diff">
                  <div className="diff-column-title">Current</div>
                  <div className="diff-column-title">Proposed
                    <button type="button" className="diff-copy-btn" onClick={() => {
                      const proposed = diffLines.map((l) => l.proposed || "").join("\n");
                      navigator.clipboard.writeText(proposed);
                    }} title="Copy proposed code">
                      📋
                    </button>
                  </div>
                  {diffLines.map((line, idx) => (
                    <div className="diff-line-pair" key={line.id}>
                      <pre className={line.changed ? "changed removed" : ""}><span className="diff-line-num">{idx + 1}</span>{line.original || " "}</pre>
                      <pre className={line.changed ? "changed added" : ""}><span className="diff-line-num">{idx + 1}</span>{line.proposed || " "}</pre>
                    </div>
                  ))}
                </div>
              </>
            ) : (
              <div className="diff-empty">Only terminal commands were suggested.</div>
            )}
          </section>
        </div>

        <div className="diff-preview-footer">
          <button type="button" className="btn-secondary" onClick={onCancel}>
            Cancel
          </button>
          <button type="button" className="btn-primary" onClick={onApplyAll}>
            <Check size={16} />
            Apply All
          </button>
        </div>
      </div>
    </div>
  );
}
