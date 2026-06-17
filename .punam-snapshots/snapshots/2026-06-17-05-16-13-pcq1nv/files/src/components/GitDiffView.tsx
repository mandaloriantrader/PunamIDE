/**
 * GitDiffView — shows the actual git diff for a single file.
 * Parses unified diff output into a side-by-side line view.
 * Purely additive — used only from GitPanel when user clicks a changed file.
 */

import { useEffect, useState } from "react";
import { X, RefreshCw } from "lucide-react";
import { gitDiffFile } from "../utils/tauri";
import { runTerminalCommand } from "../utils/tauri";

interface Props {
  projectPath: string;
  filePath: string;
  onClose: () => void;
  onOpenFile: (path: string) => void;
}

interface DiffLine {
  type: "added" | "removed" | "context" | "header";
  content: string;
  lineNumOld?: number;
  lineNumNew?: number;
}

function parseDiff(raw: string): DiffLine[] {
  const lines = raw.split("\n");
  const result: DiffLine[] = [];
  let oldLine = 0;
  let newLine = 0;

  for (const line of lines) {
    if (line.startsWith("@@")) {
      // Parse hunk header: @@ -old,count +new,count @@
      const m = line.match(/@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
      if (m) {
        oldLine = parseInt(m[1], 10);
        newLine = parseInt(m[2], 10);
      }
      result.push({ type: "header", content: line });
    } else if (line.startsWith("+") && !line.startsWith("+++")) {
      result.push({ type: "added", content: line.slice(1), lineNumNew: newLine++ });
    } else if (line.startsWith("-") && !line.startsWith("---")) {
      result.push({ type: "removed", content: line.slice(1), lineNumOld: oldLine++ });
    } else if (!line.startsWith("diff ") && !line.startsWith("index ") && !line.startsWith("---") && !line.startsWith("+++")) {
      result.push({ type: "context", content: line.slice(1), lineNumOld: oldLine++, lineNumNew: newLine++ });
    }
  }
  return result;
}

export default function GitDiffView({ projectPath, filePath, onClose, onOpenFile }: Props) {
  const [diffLines, setDiffLines] = useState<DiffLine[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const filename = filePath.split(/[\\/]/).pop() ?? filePath;

  const loadDiff = async () => {
    setLoading(true);
    setError(null);
    try {
      // Try Rust git2 engine first (instant, no process spawn)
      const rustResult = await gitDiffFile(filePath).catch(() => null);
      if (rustResult && rustResult.diff_text.trim()) {
        setDiffLines(parseDiff(rustResult.diff_text));
        setLoading(false);
        return;
      }

      // Fallback: shell git command (for untracked/staged files)
      let result = await runTerminalCommand(
        `git diff --unified=3 -- "${filePath}"`,
        projectPath
      );
      if (!result.stdout.trim()) {
        result = await runTerminalCommand(
          `git diff --unified=3 --cached -- "${filePath}"`,
          projectPath
        );
      }
      if (!result.stdout.trim()) {
        setDiffLines([]);
        setError("No diff available. The file may be untracked or identical to HEAD.");
      } else {
        setDiffLines(parseDiff(result.stdout));
      }
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { loadDiff(); }, [filePath, projectPath]);

  const added = diffLines.filter(l => l.type === "added").length;
  const removed = diffLines.filter(l => l.type === "removed").length;

  return (
    <div className="git-diff-view">
      {/* Header */}
      <div className="gdv-header">
        <div className="gdv-title">
          <span className="gdv-filename">{filename}</span>
          {!loading && !error && (
            <span className="gdv-stats">
              <span className="gdv-added">+{added}</span>
              <span className="gdv-removed">-{removed}</span>
            </span>
          )}
        </div>
        <div className="gdv-actions">
          <button
            className="icon-btn small"
            onClick={loadDiff}
            disabled={loading}
            title="Refresh diff"
            aria-label="Refresh diff"
          >
            <RefreshCw size={13} className={loading ? "spin" : ""} />
          </button>
          <button
            className="btn-secondary compact"
            onClick={() => onOpenFile(filePath)}
            title="Open file"
          >
            Open
          </button>
          <button
            className="icon-btn small"
            onClick={onClose}
            aria-label="Close diff"
          >
            <X size={14} />
          </button>
        </div>
      </div>

      {/* Body */}
      <div className="gdv-body">
        {loading && (
          <div className="gdv-loading">
            <RefreshCw size={16} className="spin" />
            <span>Loading diff…</span>
          </div>
        )}
        {error && !loading && (
          <div className="gdv-empty">{error}</div>
        )}
        {!loading && !error && diffLines.length === 0 && (
          <div className="gdv-empty">No changes detected.</div>
        )}
        {!loading && !error && diffLines.length > 0 && (
          <div className="gdv-lines">
            {diffLines.map((line, i) => (
              <div key={i} className={`gdv-line gdv-${line.type}`}>
                <span className="gdv-ln gdv-ln-old">
                  {line.type === "context" || line.type === "removed" ? line.lineNumOld ?? "" : ""}
                </span>
                <span className="gdv-ln gdv-ln-new">
                  {line.type === "context" || line.type === "added" ? line.lineNumNew ?? "" : ""}
                </span>
                <span className="gdv-sign">
                  {line.type === "added" ? "+" : line.type === "removed" ? "-" : line.type === "header" ? "" : " "}
                </span>
                <span className="gdv-content">{line.content}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
