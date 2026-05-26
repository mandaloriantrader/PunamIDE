import { useCallback, useEffect, useState } from "react";
import { GitBranch, RefreshCw, X, Sparkles, Copy, Plus, Minus, Check, Upload, Undo2 } from "lucide-react";
import { runTerminalCommand } from "../utils/tauri";
import { sendToProviderStreaming } from "../utils/providers";
import type { AIProviderConfig } from "../utils/providers";
import { showToast } from "../utils/toast";

export type GitChangeStatus = "modified" | "added" | "deleted" | "renamed" | "untracked" | "conflict";

export interface GitChange {
  id: string;
  path: string;
  oldPath?: string;
  status: GitChangeStatus;
  staged: boolean;
}

interface Props {
  projectPath: string;
  refreshKey: number;
  onOpenFile: (path: string) => void;
  onViewDiff?: (path: string) => void;
  onClose: () => void;
  aiProviders?: AIProviderConfig[];
}

const STATUS_LABELS: Record<GitChangeStatus, string> = {
  modified: "M",
  added: "A",
  deleted: "D",
  renamed: "R",
  untracked: "U",
  conflict: "!",
};

function classifyStatus(rawStatus: string): GitChangeStatus {
  if (rawStatus.includes("U") || rawStatus === "AA" || rawStatus === "DD") return "conflict";
  if (rawStatus.includes("R")) return "renamed";
  if (rawStatus === "??") return "untracked";
  if (rawStatus.includes("A")) return "added";
  if (rawStatus.includes("D")) return "deleted";
  return "modified";
}

function parseGitStatus(output: string): GitChange[] {
  return output
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .map((line, index) => {
      const xy = line.slice(0, 2);
      const body = line.slice(3);
      const indexStatus = xy[0]; // staged area
      const workStatus = xy[1]; // working tree

      const [oldPath, newPath] = body.split(" -> ");
      const path = newPath || oldPath;

      // Determine if file is staged (index has a non-space, non-? status)
      const staged = indexStatus !== " " && indexStatus !== "?" && workStatus === " ";
      const rawStatus = staged ? `${indexStatus} ` : xy;
      const status = classifyStatus(rawStatus.trim() || xy);

      return {
        id: `${xy}-${path}-${index}`,
        path,
        oldPath: newPath ? oldPath : undefined,
        status,
        staged,
      };
    });
}

export default function GitPanel({ projectPath, refreshKey, onOpenFile, onViewDiff, onClose, aiProviders = [] }: Props) {
  const [changes, setChanges] = useState<GitChange[]>([]);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState("");
  const [commitMsg, setCommitMsg] = useState("");
  const [generatingMsg, setGeneratingMsg] = useState(false);
  const [committing, setCommitting] = useState(false);
  const [pushing, setPushing] = useState(false);
  const [branch, setBranch] = useState("");

  const stagedChanges = changes.filter((c) => c.staged);
  const unstagedChanges = changes.filter((c) => !c.staged);

  const loadChanges = useCallback(async () => {
    if (!projectPath) {
      setChanges([]);
      setMessage("Open a project folder to see Git changes.");
      return;
    }

    setLoading(true);
    setMessage("");
    try {
      const result = await runTerminalCommand("git status --porcelain", projectPath);
      const output = `${result.stdout}${result.stderr ? `\n${result.stderr}` : ""}`.trim();
      if (result.exit_code !== 0) {
        setChanges([]);
        setMessage(output || "This folder is not a Git repository.");
        return;
      }

      const parsedChanges = parseGitStatus(result.stdout);
      setChanges(parsedChanges);
      setMessage(parsedChanges.length === 0 ? "No Git changes." : "");

      // Get current branch
      const branchResult = await runTerminalCommand("git branch --show-current", projectPath);
      if (branchResult.exit_code === 0) {
        setBranch(branchResult.stdout.trim());
      }
    } catch (err) {
      setChanges([]);
      setMessage(`Could not read Git changes: ${err}`);
    } finally {
      setLoading(false);
    }
  }, [projectPath]);

  useEffect(() => {
    loadChanges();
  }, [loadChanges, refreshKey]);

  // ── Stage / Unstage ──────────────────────────────────────────────────────────

  const stageFile = async (filePath: string) => {
    try {
      const result = await runTerminalCommand(`git add "${filePath}"`, projectPath);
      if (result.exit_code !== 0) {
        showToast(`Failed to stage: ${result.stderr || "Unknown error"}`, "error");
        return;
      }
      await loadChanges();
    } catch (err) {
      showToast(`Failed to stage file: ${err}`, "error");
    }
  };

  const unstageFile = async (filePath: string) => {
    try {
      const result = await runTerminalCommand(`git restore --staged "${filePath}"`, projectPath);
      if (result.exit_code !== 0) {
        showToast(`Failed to unstage: ${result.stderr || "Unknown error"}`, "error");
        return;
      }
      await loadChanges();
    } catch (err) {
      showToast(`Failed to unstage file: ${err}`, "error");
    }
  };

  const stageAll = async () => {
    try {
      const result = await runTerminalCommand("git add -A", projectPath);
      if (result.exit_code !== 0) {
        showToast(`Failed to stage all: ${result.stderr || "Unknown error"}`, "error");
        return;
      }
      await loadChanges();
      showToast("All files staged", "success");
    } catch (err) {
      showToast(`Failed to stage all: ${err}`, "error");
    }
  };

  const unstageAll = async () => {
    try {
      const result = await runTerminalCommand("git restore --staged .", projectPath);
      if (result.exit_code !== 0) {
        showToast(`Failed to unstage all: ${result.stderr || "Unknown error"}`, "error");
        return;
      }
      await loadChanges();
      showToast("All files unstaged", "success");
    } catch (err) {
      showToast(`Failed to unstage all: ${err}`, "error");
    }
  };

  const discardFile = async (filePath: string) => {
    const confirmed = window.confirm(`Discard changes to "${filePath}"? This cannot be undone.`);
    if (!confirmed) return;
    try {
      const result = await runTerminalCommand(`git checkout -- "${filePath}"`, projectPath);
      if (result.exit_code !== 0) {
        // Try restore for untracked
        const result2 = await runTerminalCommand(`git clean -f "${filePath}"`, projectPath);
        if (result2.exit_code !== 0) {
          showToast(`Failed to discard: ${result.stderr || result2.stderr}`, "error");
          return;
        }
      }
      await loadChanges();
      showToast("Changes discarded", "info");
    } catch (err) {
      showToast(`Failed to discard: ${err}`, "error");
    }
  };

  // ── Commit ───────────────────────────────────────────────────────────────────

  const handleCommit = async () => {
    if (!commitMsg.trim()) {
      showToast("Please enter a commit message", "warning");
      return;
    }
    if (stagedChanges.length === 0) {
      showToast("No staged files to commit. Stage files first.", "warning");
      return;
    }

    setCommitting(true);
    try {
      // Escape quotes in commit message
      const escapedMsg = commitMsg.replace(/"/g, '\\"');
      const result = await runTerminalCommand(`git commit -m "${escapedMsg}"`, projectPath);
      if (result.exit_code !== 0) {
        showToast(`Commit failed: ${result.stderr || result.stdout}`, "error");
        return;
      }
      showToast("Committed successfully", "success");
      setCommitMsg("");
      await loadChanges();
    } catch (err) {
      showToast(`Commit failed: ${err}`, "error");
    } finally {
      setCommitting(false);
    }
  };

  // ── Push ─────────────────────────────────────────────────────────────────────

  const handlePush = async () => {
    setPushing(true);
    try {
      const result = await runTerminalCommand("git push", projectPath);
      if (result.exit_code !== 0) {
        // Try with upstream if no tracking branch
        if (result.stderr.includes("no upstream") || result.stderr.includes("has no upstream")) {
          const pushResult = await runTerminalCommand(`git push -u origin ${branch || "main"}`, projectPath);
          if (pushResult.exit_code !== 0) {
            showToast(`Push failed: ${pushResult.stderr || pushResult.stdout}`, "error");
            return;
          }
        } else {
          showToast(`Push failed: ${result.stderr || result.stdout}`, "error");
          return;
        }
      }
      showToast("Pushed successfully", "success");
    } catch (err) {
      showToast(`Push failed: ${err}`, "error");
    } finally {
      setPushing(false);
    }
  };

  // ── AI Commit Message ────────────────────────────────────────────────────────

  const generateCommitMessage = async () => {
    if (changes.length === 0 || generatingMsg) return;
    const provider = aiProviders.find((p) => p.models.some((m) => m.enabled));
    if (!provider) { showToast("No AI provider configured", "warning"); return; }
    const model = provider.models.find((m) => m.enabled);
    if (!model) return;

    setGeneratingMsg(true);
    setCommitMsg("");
    try {
      const diffResult = await runTerminalCommand("git diff --stat --no-color", projectPath);
      const diff = diffResult.stdout.slice(0, 4000) || changes.map((c) => `${c.status}: ${c.path}`).join("\n");

      const resp = await sendToProviderStreaming(provider, model.id, {
        systemPrompt: "Write a concise git commit message (max 72 chars subject, optional body). Use conventional commits format (feat:, fix:, refactor:, etc). Output ONLY the commit message, nothing else.",
        userPrompt: `Generate a commit message for these changes:\n\n${diff}`,
      });

      setCommitMsg(resp.success ? resp.text.trim() : "Failed to generate.");
    } catch {
      showToast("Error generating commit message", "error");
    } finally {
      setGeneratingMsg(false);
    }
  };

  // ── Render ───────────────────────────────────────────────────────────────────

  return (
    <div className="git-panel">
      <div className="panel-header git-panel-header">
        <span>GIT CHANGES</span>
        <div className="panel-actions">
          <button type="button" className="icon-btn small" onClick={loadChanges} disabled={loading} aria-label="Refresh Git changes">
            <RefreshCw size={14} className={loading ? "spin" : ""} />
          </button>
          <button type="button" className="icon-btn small" onClick={onClose} aria-label="Close Git panel">
            <X size={14} />
          </button>
        </div>
      </div>

      <div className="git-summary">
        <GitBranch size={14} />
        <span>{branch || "—"}</span>
        <span className="git-summary-count">
          {loading ? "..." : `${changes.length} change${changes.length === 1 ? "" : "s"}`}
        </span>
      </div>

      {/* ── Commit input section ── */}
      {changes.length > 0 && (
        <div className="git-commit-section">
          <textarea
            className="git-commit-input"
            placeholder="Commit message..."
            value={commitMsg}
            onChange={(e) => setCommitMsg(e.target.value)}
            rows={3}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
                e.preventDefault();
                handleCommit();
              }
            }}
          />
          <div className="git-commit-actions">
            <button
              type="button"
              className="git-action-btn git-generate-btn"
              onClick={generateCommitMessage}
              disabled={generatingMsg}
              title="Generate commit message with AI"
            >
              <Sparkles size={12} className={generatingMsg ? "spin" : ""} />
              {generatingMsg ? "..." : "AI"}
            </button>
            {commitMsg && (
              <button
                type="button"
                className="icon-btn small"
                onClick={() => navigator.clipboard.writeText(commitMsg)}
                title="Copy message"
              >
                <Copy size={12} />
              </button>
            )}
            <div className="git-commit-actions-right">
              <button
                type="button"
                className="git-action-btn git-commit-btn"
                onClick={handleCommit}
                disabled={committing || stagedChanges.length === 0 || !commitMsg.trim()}
                title={stagedChanges.length === 0 ? "Stage files first" : "Commit staged changes (Ctrl+Enter)"}
              >
                <Check size={12} />
                {committing ? "Committing..." : "Commit"}
              </button>
              <button
                type="button"
                className="git-action-btn git-push-btn"
                onClick={handlePush}
                disabled={pushing}
                title="Push to remote"
              >
                <Upload size={12} />
                {pushing ? "Pushing..." : "Push"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Staged changes ── */}
      {stagedChanges.length > 0 && (
        <div className="git-section">
          <div className="git-section-header">
            <span>Staged ({stagedChanges.length})</span>
            <button type="button" className="icon-btn small" onClick={unstageAll} title="Unstage all">
              <Minus size={12} />
            </button>
          </div>
          <div className="git-change-list">
            {stagedChanges.map((change) => (
              <div key={change.id} className="git-change-item">
                <button
                  type="button"
                  className={`git-change-row ${change.status}`}
                  onClick={() => change.status !== "deleted" && onOpenFile(change.path)}
                  disabled={change.status === "deleted"}
                  title={change.path}
                >
                  <span className="git-status-badge staged">{STATUS_LABELS[change.status]}</span>
                  <span className="git-change-path">{change.path}</span>
                </button>
                <button
                  type="button"
                  className="git-file-action-btn"
                  onClick={() => unstageFile(change.path)}
                  title="Unstage"
                >
                  <Minus size={12} />
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ── Unstaged changes ── */}
      {unstagedChanges.length > 0 && (
        <div className="git-section">
          <div className="git-section-header">
            <span>Changes ({unstagedChanges.length})</span>
            <button type="button" className="icon-btn small" onClick={stageAll} title="Stage all">
              <Plus size={12} />
            </button>
          </div>
          <div className="git-change-list">
            {unstagedChanges.map((change) => (
              <div key={change.id} className="git-change-item">
                <button
                  type="button"
                  className={`git-change-row ${change.status}`}
                  onClick={() => change.status !== "deleted" && onOpenFile(change.path)}
                  disabled={change.status === "deleted"}
                  title={change.path}
                >
                  <span className="git-status-badge">{STATUS_LABELS[change.status]}</span>
                  <span className="git-change-path">{change.path}</span>
                </button>
                <div className="git-file-actions">
                  {onViewDiff && change.status !== "untracked" && (
                    <button
                      type="button"
                      className="git-file-action-btn"
                      onClick={() => onViewDiff(change.path)}
                      title="View diff"
                    >
                      diff
                    </button>
                  )}
                  <button
                    type="button"
                    className="git-file-action-btn"
                    onClick={() => stageFile(change.path)}
                    title="Stage"
                  >
                    <Plus size={12} />
                  </button>
                  <button
                    type="button"
                    className="git-file-action-btn discard"
                    onClick={() => discardFile(change.path)}
                    title="Discard changes"
                  >
                    <Undo2 size={12} />
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ── Empty state ── */}
      {message && <div className="git-empty">{message}</div>}
    </div>
  );
}
