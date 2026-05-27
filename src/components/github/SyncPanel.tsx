/**
 * SyncPanel — Push, Pull, Fetch with safety checks and auto-snapshots.
 * Integrates Phase 6 (Safety) + Phase 3 (Sync) into a single UI.
 */

import { useCallback, useState } from "react";
import {
  Upload,
  Download,
  RefreshCw,
  AlertTriangle,
  CheckCircle2,
  Shield,
  Undo2,
  GitBranch,
  Plus,
  Trash2,
  Archive,
  Check,
} from "lucide-react";
import {
  githubPrePushCheck,
  githubPrePullCheck,
  githubDryRunPush,
  githubCreateSafetySnapshot,
  githubRollbackToSnapshot,
  githubPush,
  githubPull,
  githubFetch,
  githubStash,
  githubStashPop,
  githubCreateBranch,
  githubSwitchBranch,
  githubDeleteBranch,
} from "../../services/githubService";
import { runTerminalCommand } from "../../utils/tauri";
import type {
  PrePushStatus,
  PrePullStatus,
  DryRunPushResult,
  SafetySnapshot,
  PushResult,
  PullResult,
} from "../../services/githubService";
import { showToast } from "../../utils/toast";

interface Props {
  projectPath: string;
  currentBranch: string | null;
  hasRemote: boolean;
  onRefresh: () => void;
}

export default function SyncPanel({ projectPath, currentBranch, hasRemote, onRefresh }: Props) {
  const [pushing, setPushing] = useState(false);
  const [pulling, setPulling] = useState(false);
  const [fetching, setFetching] = useState(false);
  const [lastSnapshot, setLastSnapshot] = useState<SafetySnapshot | null>(null);
  const [showConfirmPush, setShowConfirmPush] = useState(false);
  const [pushPreview, setPushPreview] = useState<DryRunPushResult | null>(null);
  const [pullConflicts, setPullConflicts] = useState<string[]>([]);

  // Branch management
  const [showBranchCreate, setShowBranchCreate] = useState(false);
  const [newBranchName, setNewBranchName] = useState("");
  const [creatingBranch, setCreatingBranch] = useState(false);

  // Commit
  const [commitMsg, setCommitMsg] = useState("");
  const [committing, setCommitting] = useState(false);

  // ── Commit Flow ────────────────────────────────────────────────────────────

  const handleCommit = async () => {
    if (!commitMsg.trim()) {
      showToast("Enter a commit message", "warning");
      return;
    }
    setCommitting(true);
    try {
      // Stage all changes
      const stageResult = await runTerminalCommand("git add -A", projectPath);
      if (stageResult.exit_code !== 0) {
        showToast(`Stage failed: ${stageResult.stderr || stageResult.stdout}`, "error");
        return;
      }

      // Check if there's anything to commit
      const diffCheck = await runTerminalCommand("git diff --cached --quiet", projectPath);
      if (diffCheck.exit_code === 0) {
        showToast("Nothing to commit — working tree clean", "info");
        return;
      }

      // Commit
      const escapedMsg = commitMsg.replace(/"/g, '\\"');
      const result = await runTerminalCommand(`git commit -m "${escapedMsg}"`, projectPath);
      if (result.exit_code !== 0) {
        showToast(`Commit failed: ${result.stderr || result.stdout}`, "error");
        return;
      }

      showToast("Committed successfully", "success");
      setCommitMsg("");
      onRefresh();
    } catch (err) {
      showToast(`Commit failed: ${err}`, "error");
    } finally {
      setCommitting(false);
    }
  };

  // ── Safe Push Flow ─────────────────────────────────────────────────────────

  const handlePush = async () => {
    if (!hasRemote) {
      showToast("No remote configured. Link a repository first.", "warning");
      return;
    }

    setPushing(true);
    try {
      // Step 1: Safety check
      const check = await githubPrePushCheck();

      if (!check.safe_to_push) {
        // Show warnings
        for (const w of check.warnings) {
          showToast(w, "warning");
        }
        setPushing(false);
        return;
      }

      // Step 2: Dry-run preview
      const preview = await githubDryRunPush();

      // First push — no upstream exists, so ahead count is 0 but we still need to push
      if (!check.has_upstream) {
        await executePush(true); // set upstream on first push
        return;
      }

      if (preview.ahead === 0 && !preview.would_create_remote_branch) {
        showToast("Nothing to push — already up to date", "info");
        setPushing(false);
        return;
      }

      // Step 3: Show confirmation for multi-commit pushes
      if (preview.ahead > 3) {
        setPushPreview(preview);
        setShowConfirmPush(true);
        setPushing(false);
        return;
      }

      // Step 4: Execute push
      await executePush(preview.would_create_remote_branch);
    } catch (err) {
      showToast(`Push failed: ${err}`, "error");
      setPushing(false);
    }
  };

  const executePush = async (setUpstream: boolean = false) => {
    setPushing(true);
    setShowConfirmPush(false);
    try {
      const result = await githubPush(false, setUpstream);
      showToast(`Pushed successfully to ${result.remote}`, "success");
      onRefresh();
    } catch (err) {
      showToast(`Push failed: ${err}`, "error");
    } finally {
      setPushing(false);
      setPushPreview(null);
    }
  };

  // ── Safe Pull Flow ─────────────────────────────────────────────────────────

  const handlePull = async () => {
    if (!hasRemote) {
      showToast("No remote configured.", "warning");
      return;
    }

    setPulling(true);
    setPullConflicts([]);
    try {
      // Step 1: Safety check
      const check = await githubPrePullCheck();

      if (!check.safe_to_pull) {
        for (const w of check.warnings) {
          showToast(w, "warning");
        }
        setPulling(false);
        return;
      }

      // Step 2: Create safety snapshot
      const snapshot = await githubCreateSafetySnapshot("pre-pull");
      setLastSnapshot(snapshot);

      // Step 3: Execute pull
      const result = await githubPull(false);

      if (result.success) {
        const stats = result.files_changed > 0
          ? `${result.files_changed} files, +${result.insertions}/-${result.deletions}`
          : "Already up to date";
        showToast(`Pull complete: ${stats}`, "success");
      } else if (result.conflicts.length > 0) {
        setPullConflicts(result.conflicts);
        showToast(`Pull has ${result.conflicts.length} conflict(s). Resolve or rollback.`, "warning");
      }

      onRefresh();
    } catch (err) {
      showToast(`Pull failed: ${err}. You can rollback using the safety snapshot.`, "error");
    } finally {
      setPulling(false);
    }
  };

  // ── Fetch ──────────────────────────────────────────────────────────────────

  const handleFetch = async () => {
    setFetching(true);
    try {
      const result = await githubFetch(undefined, true);
      if (result.updates.length > 0) {
        showToast(`Fetched ${result.updates.length} update(s)`, "success");
      } else {
        showToast("Fetch complete — no new updates", "info");
      }
      onRefresh();
    } catch (err) {
      showToast(`Fetch failed: ${err}`, "error");
    } finally {
      setFetching(false);
    }
  };

  // ── Rollback ───────────────────────────────────────────────────────────────

  const handleRollback = async () => {
    if (!lastSnapshot) return;
    const confirmed = window.confirm(
      `Rollback to snapshot "${lastSnapshot.reason}" (${lastSnapshot.files} files)?\nThis will restore your project to the state before the last operation.`
    );
    if (!confirmed) return;

    try {
      const restored = await githubRollbackToSnapshot(lastSnapshot.id);
      showToast(`Rolled back: ${restored} files restored`, "success");
      setLastSnapshot(null);
      setPullConflicts([]);
      onRefresh();
    } catch (err) {
      showToast(`Rollback failed: ${err}`, "error");
    }
  };

  // ── Branch Create ──────────────────────────────────────────────────────────

  const handleCreateBranch = async () => {
    if (!newBranchName.trim()) return;
    setCreatingBranch(true);
    try {
      await githubCreateBranch(newBranchName.trim(), true);
      showToast(`Created and switched to branch "${newBranchName.trim()}"`, "success");
      setNewBranchName("");
      setShowBranchCreate(false);
      onRefresh();
    } catch (err) {
      showToast(`Failed to create branch: ${err}`, "error");
    } finally {
      setCreatingBranch(false);
    }
  };

  // ── Stash ──────────────────────────────────────────────────────────────────

  const handleStash = async () => {
    try {
      const result = await githubStash();
      showToast(result.message || "Changes stashed", "success");
      onRefresh();
    } catch (err) {
      showToast(`Stash failed: ${err}`, "error");
    }
  };

  const handleStashPop = async () => {
    try {
      const result = await githubStashPop();
      showToast(result.message || "Stash applied", "success");
      onRefresh();
    } catch (err) {
      showToast(`Stash pop failed: ${err}`, "error");
    }
  };

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <div className="github-sync-panel">
      {/* Commit section */}
      <div className="github-commit-section">
        <div className="github-commit-input-row">
          <input
            type="text"
            className="github-input"
            placeholder="Commit message..."
            value={commitMsg}
            onChange={(e) => setCommitMsg(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
                e.preventDefault();
                handleCommit();
              }
            }}
            disabled={committing}
          />
        </div>
        <button
          type="button"
          className="github-sync-btn github-commit-btn"
          onClick={handleCommit}
          disabled={committing || !commitMsg.trim()}
          title="Stage all & commit (Ctrl+Enter)"
        >
          <Check size={13} />
          {committing ? "Committing..." : "Commit All"}
        </button>
      </div>

      {/* Main sync actions */}
      <div className="github-sync-actions">
        <button
          type="button"
          className="github-sync-btn github-push-btn"
          onClick={handlePush}
          disabled={pushing || !hasRemote}
          title="Push to remote (with safety checks)"
        >
          <Upload size={13} />
          {pushing ? "Pushing..." : "Push"}
        </button>
        <button
          type="button"
          className="github-sync-btn github-pull-btn"
          onClick={handlePull}
          disabled={pulling || !hasRemote}
          title="Pull from remote (auto-snapshot first)"
        >
          <Download size={13} />
          {pulling ? "Pulling..." : "Pull"}
        </button>
        <button
          type="button"
          className="github-sync-btn github-fetch-btn"
          onClick={handleFetch}
          disabled={fetching || !hasRemote}
          title="Fetch updates (no merge)"
        >
          <RefreshCw size={13} className={fetching ? "spin" : ""} />
          Fetch
        </button>
      </div>

      {/* Push confirmation dialog */}
      {showConfirmPush && pushPreview && (
        <div className="github-confirm-box">
          <div className="github-confirm-header">
            <AlertTriangle size={14} />
            <span>Push {pushPreview.ahead} commit(s)?</span>
          </div>
          <div className="github-confirm-commits">
            {pushPreview.commits_to_push.slice(0, 5).map((c, i) => (
              <div key={i} className="github-commit-preview">{c}</div>
            ))}
            {pushPreview.commits_to_push.length > 5 && (
              <div className="github-commit-more">...and {pushPreview.commits_to_push.length - 5} more</div>
            )}
          </div>
          <div className="github-confirm-actions">
            <button
              type="button"
              className="github-connect-btn"
              onClick={() => executePush(pushPreview.would_create_remote_branch)}
            >
              Push
            </button>
            <button
              type="button"
              className="github-cancel-btn"
              onClick={() => { setShowConfirmPush(false); setPushPreview(null); }}
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Conflict warning */}
      {pullConflicts.length > 0 && (
        <div className="github-conflict-box">
          <div className="github-conflict-header">
            <AlertTriangle size={14} />
            <span>{pullConflicts.length} merge conflict(s)</span>
          </div>
          <div className="github-conflict-list">
            {pullConflicts.map((f, i) => (
              <div key={i} className="github-conflict-file">{f}</div>
            ))}
          </div>
          <div className="github-conflict-actions">
            <button
              type="button"
              className="github-action-btn"
              onClick={handleRollback}
              title="Rollback to pre-pull state"
            >
              <Undo2 size={12} /> Rollback
            </button>
          </div>
        </div>
      )}

      {/* Safety snapshot indicator */}
      {lastSnapshot && pullConflicts.length === 0 && (
        <div className="github-snapshot-indicator">
          <Shield size={12} />
          <span>Safety snapshot: {lastSnapshot.reason}</span>
          <button
            type="button"
            className="icon-btn small"
            onClick={handleRollback}
            title="Rollback to this snapshot"
          >
            <Undo2 size={11} />
          </button>
        </div>
      )}

      {/* Branch + Stash actions */}
      <div className="github-secondary-actions">
        <button
          type="button"
          className="github-action-btn"
          onClick={() => setShowBranchCreate(!showBranchCreate)}
          title="Create new branch"
        >
          <Plus size={11} /> Branch
        </button>
        <button
          type="button"
          className="github-action-btn"
          onClick={handleStash}
          title="Stash changes"
        >
          <Archive size={11} /> Stash
        </button>
        <button
          type="button"
          className="github-action-btn"
          onClick={handleStashPop}
          title="Pop stash"
        >
          <Archive size={11} /> Pop
        </button>
      </div>

      {/* Branch create form */}
      {showBranchCreate && (
        <div className="github-branch-create-form">
          <input
            type="text"
            className="github-input"
            placeholder="New branch name"
            value={newBranchName}
            onChange={(e) => setNewBranchName(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") handleCreateBranch(); }}
            disabled={creatingBranch}
            autoFocus
          />
          <button
            type="button"
            className="github-connect-btn"
            onClick={handleCreateBranch}
            disabled={creatingBranch || !newBranchName.trim()}
          >
            {creatingBranch ? "Creating..." : "Create & Switch"}
          </button>
        </div>
      )}
    </div>
  );
}
