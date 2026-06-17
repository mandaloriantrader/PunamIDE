/**
 * PullRequestPanel — Create, list, merge pull requests.
 */

import { useCallback, useEffect, useState } from "react";
import {
  GitPullRequest,
  Plus,
  RefreshCw,
  Merge,
  X,
  ExternalLink,
  Send,
} from "lucide-react";
import {
  githubListPrs,
  githubCreatePr,
  githubMergePr,
  githubClosePr,
  githubPrListComments,
  githubPrAddComment,
} from "../../services/githubService";
import type { PullRequest, Comment } from "../../services/githubService";
import { showToast } from "../../utils/toast";

interface Props {
  owner: string;
  repo: string;
  currentBranch: string | null;
  defaultBranch: string;
}

export default function PullRequestPanel({ owner, repo, currentBranch, defaultBranch }: Props) {
  const [prs, setPrs] = useState<PullRequest[]>([]);
  const [loading, setLoading] = useState(false);
  const [showCreate, setShowCreate] = useState(false);
  const [selectedPr, setSelectedPr] = useState<PullRequest | null>(null);
  const [comments, setComments] = useState<Comment[]>([]);
  const [newComment, setNewComment] = useState("");
  const [sendingComment, setSendingComment] = useState(false);

  // Create form
  const [prTitle, setPrTitle] = useState("");
  const [prBody, setPrBody] = useState("");
  const [prBase, setPrBase] = useState(defaultBranch);
  const [prDraft, setPrDraft] = useState(false);
  const [creating, setCreating] = useState(false);

  // ── Load PRs ───────────────────────────────────────────────────────────────

  const loadPrs = useCallback(async () => {
    if (!owner || !repo) return;
    setLoading(true);
    try {
      const list = await githubListPrs(owner, repo, "open");
      setPrs(list);
    } catch (err) {
      showToast(`Failed to load PRs: ${err}`, "error");
    } finally {
      setLoading(false);
    }
  }, [owner, repo]);

  useEffect(() => { loadPrs(); }, [loadPrs]);

  // ── Create PR ──────────────────────────────────────────────────────────────

  const handleCreate = async () => {
    if (!prTitle.trim()) {
      showToast("PR title is required", "warning");
      return;
    }
    if (!currentBranch) {
      showToast("No current branch detected", "warning");
      return;
    }
    setCreating(true);
    try {
      const pr = await githubCreatePr(
        owner, repo, prTitle.trim(),
        prBody.trim() || null,
        currentBranch, prBase, prDraft
      );
      showToast(`PR #${pr.number} created`, "success");
      setPrTitle("");
      setPrBody("");
      setShowCreate(false);
      loadPrs();
    } catch (err) {
      showToast(`Failed to create PR: ${err}`, "error");
    } finally {
      setCreating(false);
    }
  };

  // ── Merge PR ───────────────────────────────────────────────────────────────

  const handleMerge = async (pr: PullRequest, method: string) => {
    const confirmed = window.confirm(`Merge PR #${pr.number} "${pr.title}" into ${pr.base_ref}?\nMethod: ${method}`);
    if (!confirmed) return;
    try {
      const result = await githubMergePr(owner, repo, pr.number, method);
      if (result.merged) {
        showToast(`PR #${pr.number} merged successfully`, "success");
        loadPrs();
        setSelectedPr(null);
      } else {
        showToast(`Merge failed: ${result.message}`, "error");
      }
    } catch (err) {
      showToast(`Merge failed: ${err}`, "error");
    }
  };

  // ── Close PR ───────────────────────────────────────────────────────────────

  const handleClose = async (pr: PullRequest) => {
    const confirmed = window.confirm(`Close PR #${pr.number} "${pr.title}" without merging?`);
    if (!confirmed) return;
    try {
      await githubClosePr(owner, repo, pr.number);
      showToast(`PR #${pr.number} closed`, "info");
      loadPrs();
      setSelectedPr(null);
    } catch (err) {
      showToast(`Failed to close PR: ${err}`, "error");
    }
  };

  // ── Comments ───────────────────────────────────────────────────────────────

  const loadComments = async (pr: PullRequest) => {
    setSelectedPr(pr);
    try {
      const list = await githubPrListComments(owner, repo, pr.number);
      setComments(list);
    } catch {
      setComments([]);
    }
  };

  const handleAddComment = async () => {
    if (!selectedPr || !newComment.trim()) return;
    setSendingComment(true);
    try {
      const comment = await githubPrAddComment(owner, repo, selectedPr.number, newComment.trim());
      setComments(prev => [...prev, comment]);
      setNewComment("");
      showToast("Comment added", "success");
    } catch (err) {
      showToast(`Failed to add comment: ${err}`, "error");
    } finally {
      setSendingComment(false);
    }
  };

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <div className="github-pr-panel">
      {/* Header actions */}
      <div className="github-pr-actions">
        <button
          type="button"
          className="github-action-btn"
          onClick={() => setShowCreate(!showCreate)}
        >
          <Plus size={12} /> Create PR
        </button>
        <button
          type="button"
          className="icon-btn small"
          onClick={loadPrs}
          disabled={loading}
        >
          <RefreshCw size={12} className={loading ? "spin" : ""} />
        </button>
      </div>

      {/* Create form */}
      {showCreate && (
        <div className="github-create-form">
          <div className="github-pr-branch-info">
            <span>{currentBranch || "?"}</span>
            <span>→</span>
            <input
              type="text"
              className="github-input github-input-sm"
              value={prBase}
              onChange={(e) => setPrBase(e.target.value)}
              placeholder="base branch"
            />
          </div>
          <input
            type="text"
            className="github-input"
            placeholder="PR title"
            value={prTitle}
            onChange={(e) => setPrTitle(e.target.value)}
            autoFocus
          />
          <textarea
            className="github-input github-textarea"
            placeholder="Description (optional)"
            value={prBody}
            onChange={(e) => setPrBody(e.target.value)}
            rows={3}
          />
          <div className="github-create-options">
            <label className="github-checkbox-label">
              <input
                type="checkbox"
                checked={prDraft}
                onChange={(e) => setPrDraft(e.target.checked)}
              />
              Draft PR
            </label>
          </div>
          <div className="github-create-actions">
            <button
              type="button"
              className="github-connect-btn"
              onClick={handleCreate}
              disabled={creating || !prTitle.trim()}
            >
              {creating ? "Creating..." : "Create Pull Request"}
            </button>
            <button
              type="button"
              className="github-cancel-btn"
              onClick={() => setShowCreate(false)}
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* PR Detail View */}
      {selectedPr && (
        <div className="github-pr-detail">
          <div className="github-pr-detail-header">
            <span className="github-pr-detail-title">
              #{selectedPr.number} {selectedPr.title}
            </span>
            <button
              type="button"
              className="icon-btn small"
              onClick={() => setSelectedPr(null)}
            >
              <X size={12} />
            </button>
          </div>
          <div className="github-pr-detail-meta">
            <span>{selectedPr.head_ref} → {selectedPr.base_ref}</span>
            <span>by {selectedPr.user_login}</span>
          </div>
          <div className="github-pr-detail-actions">
            <button
              type="button"
              className="github-action-btn github-merge-btn"
              onClick={() => handleMerge(selectedPr, "squash")}
            >
              <Merge size={11} /> Squash
            </button>
            <button
              type="button"
              className="github-action-btn github-merge-btn"
              onClick={() => handleMerge(selectedPr, "merge")}
            >
              <Merge size={11} /> Merge
            </button>
            <button
              type="button"
              className="github-action-btn"
              onClick={() => handleClose(selectedPr)}
            >
              <X size={11} /> Close
            </button>
          </div>

          {/* Comments */}
          <div className="github-pr-comments">
            {comments.map((c) => (
              <div key={c.id} className="github-comment">
                <div className="github-comment-header">
                  <span className="github-comment-user">{c.user_login}</span>
                  <span className="github-comment-date">{new Date(c.created_at).toLocaleDateString()}</span>
                </div>
                <div className="github-comment-body">{c.body}</div>
              </div>
            ))}
            <div className="github-comment-input-row">
              <input
                type="text"
                className="github-input"
                placeholder="Add a comment..."
                value={newComment}
                onChange={(e) => setNewComment(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") handleAddComment(); }}
                disabled={sendingComment}
              />
              <button
                type="button"
                className="icon-btn small"
                onClick={handleAddComment}
                disabled={sendingComment || !newComment.trim()}
              >
                <Send size={12} />
              </button>
            </div>
          </div>
        </div>
      )}

      {/* PR List */}
      {!selectedPr && (
        <div className="github-pr-list">
          {loading && (
            <div className="github-loading">
              <RefreshCw size={12} className="spin" /> Loading...
            </div>
          )}
          {!loading && prs.length === 0 && (
            <div className="github-empty">No open pull requests.</div>
          )}
          {!loading && prs.map((pr) => (
            <div
              key={pr.number}
              className="github-pr-item"
              onClick={() => loadComments(pr)}
              role="button"
              tabIndex={0}
            >
              <div className="github-pr-item-icon">
                <GitPullRequest size={14} className={pr.draft ? "draft" : pr.state === "open" ? "open" : "closed"} />
              </div>
              <div className="github-pr-item-info">
                <div className="github-pr-item-title">
                  {pr.title}
                  {pr.draft && <span className="github-pr-badge draft">draft</span>}
                </div>
                <div className="github-pr-item-meta">
                  #{pr.number} • {pr.head_ref} → {pr.base_ref} • {pr.user_login}
                </div>
              </div>
              <a
                href={pr.html_url}
                target="_blank"
                rel="noopener noreferrer"
                className="github-external-link"
                onClick={(e) => e.stopPropagation()}
              >
                <ExternalLink size={11} />
              </a>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
