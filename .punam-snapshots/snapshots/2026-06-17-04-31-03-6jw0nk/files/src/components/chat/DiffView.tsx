/**
 * DiffView — unified diff display with +/- line highlighting.
 *
 * Takes original and modified content, computes a line-by-line diff,
 * and renders with green/red gutter indicators.
 */

import { useMemo } from "react";

interface Props {
  original: string;
  modified: string;
  fileName: string;
}

interface DiffLine {
  type: "same" | "added" | "removed";
  content: string;
  lineNum?: number;
}

function computeUnifiedDiff(original: string, modified: string): DiffLine[] {
  const originalLines = original.split("\n");
  const modifiedLines = modified.split("\n");

  // Simple LCS-based diff (O(m*n) but fine for typical file sizes)
  const m = originalLines.length;
  const n = modifiedLines.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0));

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (originalLines[i - 1] === modifiedLines[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1] + 1;
      } else {
        dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
      }
    }
  }

  const result: DiffLine[] = [];
  let i = m, j = n;

  // Backtrack to build the diff
  const temp: Array<{ type: "added" | "removed" | "same"; line: string }> = [];
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && originalLines[i - 1] === modifiedLines[j - 1]) {
      temp.push({ type: "same", line: originalLines[i - 1] });
      i--;
      j--;
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      temp.push({ type: "added", line: modifiedLines[j - 1] });
      j--;
    } else {
      temp.push({ type: "removed", line: originalLines[i - 1] });
      i--;
    }
  }

  // Reverse and add line numbers
  let origLine = 1;
  let modLine = 1;
  for (let k = temp.length - 1; k >= 0; k--) {
    const item = temp[k];
    if (item.type === "removed") {
      result.push({ type: "removed", content: item.line, lineNum: origLine });
      origLine++;
    } else if (item.type === "added") {
      result.push({ type: "added", content: item.line, lineNum: modLine });
      modLine++;
    } else {
      result.push({ type: "same", content: item.line });
      origLine++;
      modLine++;
    }
  }

  return result;
}

export default function DiffView({ original, modified, fileName }: Props) {
  const diffLines = useMemo(
    () => computeUnifiedDiff(original, modified),
    [original, modified]
  );

  const extension = fileName.split(".").pop() || "";

  return (
    <div className="cl-diff-view">
      <div className="cl-diff-header">
        <span className="cl-diff-file">{fileName}</span>
        {extension && <span className="cl-diff-lang">{extension}</span>}
        <span className="cl-diff-stats">
          {diffLines.filter((l) => l.type === "added").length}+ /{" "}
          {diffLines.filter((l) => l.type === "removed").length}-
        </span>
      </div>
      <div className="cl-diff-body">
        {diffLines.map((line, idx) => (
          <div
            key={idx}
            className={`cl-diff-line ${line.type}`}
          >
            <span className="cl-diff-gutter">
              {line.type === "removed" ? "-" : line.type === "added" ? "+" : ""}
            </span>
            <span className="cl-diff-linenum">
              {line.lineNum !== undefined ? line.lineNum : ""}
            </span>
            <span className="cl-diff-content">{line.content}</span>
          </div>
        ))}
      </div>
    </div>
  );
}