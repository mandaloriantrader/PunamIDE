/**
 * IssuesPanel — List, create, and comment on GitHub issues.
 */

import { useCallback, useEffect, useState } from "react";
import {
  CircleDot,
  Plus,
  RefreshCw,
  X,
  ExternalLink,
  Send,
  CheckCircle2,
} from "lucide-react";
import {
  githubListIssues,
  githubCreateIssue,
  githubCloseIssue,
  githubIssueListComments,
  githubIssueAddComment,
} from "../../services/githubService";
import type { Issue, Comment } from "../../services/githubService";
import { showToast } from "../../utils/toast";

interface Props {
  owner: string;
  repo: string;
}

export default function IssuesPanel({ owner, repo }: Props) {
  const [issues, setIssues] = useState<Issue[]>([]);
  const [loading, setLoading] = useState(false);
  const [showCreate, setShowCreate] = useState(false);
  const [selectedIssue, setSelectedIssue] = useState<Issue | null>(null);
  const [comments, setComments] = useState<Comment[]>([]);
  const [newComment, setNewComment] = useState("");
  const [sendingComment, setSendingComment] = useState(false);
  const [filter, setFilter] = useState<"open" | "closed">("open");

  // Create form
  const [issueTitle, setIssueTitle] = useState("");
  const [issueBody, setIssueBody] = useState("");
  const [issueLabels, setIssueLabels] = useState("");
  const [creating, setCreating] = useState(false);

  // ── Load Issues ────────────────────────────────────────────────────────────

  const loadIssues = useCallback(async () => {
    if (!owner || !repo) return;
    setLoading(true);
    try {
      const list = await githubListIssues(owner, repo, filter);
      setIssues(list);
    } catch (err) {
      showToast(`Failed to load issues: ${err}`, "error");
    } finally {
      setLoading(false);
    }
  }, [owner, repo, filter]);

  useEffect(() => { loadIssues(); }, [loadIssues]);

  // ── Create Issue ───────────────────────────────────────────────────────────

  const handleCreate = async () => {
    if (!issueTitle.trim()) {
      showToast("Issue title is required", "warning");
      return;
    }
    setCreating(true);
    try {
      const labels = issueLabels.split(",").map(l => l.trim()).filter(Boolean);
      const issue = await githubCreateIssue(owner, repo, issueTitle.trim(), issueBody.trim() || undefined, labels);
      showToast(`Issue #${issue.number} created`, "success");
      setIssueTitle("");
      setIssueBody("");
      setIssueLabels("");
      setShowCreate(false);
      loadIssues();
    } catch (err) {
      showToast(`Failed to create issue: ${err}`, "error");
    } finally {
      setCreating(false);
    }
  };

  // ── Close Issue ────────────────────────────────────────────────────────────

  const handleClose = async (issue: Issue) => {
    try {
      await githubCloseIssue(owner, repo, issue.number);
      showToast(`Issue #${issue.number} closed`, "info");
      loadIssues();
      setSelectedIssue(null);
    } catch (err) {
      showToast(`Failed to close issue: ${err}`, "error");
    }
  };

  // ── Comments ───────────────────────────────────────────────────────────────

  const loadComments = async (issue: Issue) => {
    setSelectedIssue(issue);
    try {
      const list = await githubIssueListComments(owner, repo, issue.number);
      setComments(list);
    } catch {
      setComments([]);
    }
  };

  const handleAddComment = async () => {
    if (!selectedIssue || !newComment.trim()) return;
    setSendingComment(true);
    try {
      const comment = await githubIssueAddComment(owner, repo, selectedIssue.number, newComment.trim());
      setComments(prev => [...prev, comment]);
      setNewComment("");
    } catch (err) {
      showToast(`Failed to add comment: ${err}`, "error");
    } finally {
      setSendingComment(false);
    }
  };

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <div className="github-issues-panel">
      {/* Header */}
      <div className="github-pr-actions">
        <button type="button" className="github-action-btn" onClick={() => setShowCreate(!showCreate)}>
          <Plus size={12} /> New Issue
        </button>
        <div className="github-filter-tabs">
          <button
            type="button"
            className={`github-filter-tab ${filter === "open" ? "active" : ""}`}
            onClick={() => setFilter("open")}
          >
            Open
          </button>
          <button
            type="button"
            className={`github-filter-tab ${filter === "closed" ? "active" : ""}`}
            onClick={() => setFilter("closed")}
          >
            Closed
          </button>
        </div>
        <button type="button" className="icon-btn small" onClick={loadIssues} disabled={loading}>
          <RefreshCw size={12} className={loading ? "spin" : ""} />
        </button>
      </div>

      {/* Create form */}
      {showCreate && (
        <div className="github-create-form">
          <input
            type="text"
            className="github-input"
            placeholder="Issue title"
            value={issueTitle}
            onChange={(e) => setIssueTitle(e.target.value)}
            autoFocus
          />
          <textarea
            className="github-input github-textarea"
            placeholder="Description (optional)"
            value={issueBody}
            onChange={(e) => setIssueBody(e.target.value)}
            rows={3}
          />
          <input
            type="text"
            className="github-input"
            placeholder="Labels (comma-separated, optional)"
            value={issueLabels}
            onChange={(e) => setIssueLabels(e.target.value)}
          />
          <div className="github-create-actions">
            <button
              type="button"
              className="github-connect-btn"
              onClick={handleCreate}
              disabled={creating || !issueTitle.trim()}
            >
              {creating ? "Creating..." : "Create Issue"}
            </button>
            <button type="button" className="github-cancel-btn" onClick={() => setShowCreate(false)}>
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Issue Detail */}
      {selectedIssue && (
        <div className="github-pr-detail">
          <div className="github-pr-detail-header">
            <span className="github-pr-detail-title">
              #{selectedIssue.number} {selectedIssue.title}
            </span>
            <button type="button" className="icon-btn small" onClick={() => setSelectedIssue(null)}>
              <X size={12} />
            </button>
          </div>
          {selectedIssue.body && (
            <div className="github-issue-body">{selectedIssue.body}</div>
          )}
          {selectedIssue.labels.length > 0 && (
            <div className="github-issue-labels">
              {selectedIssue.labels.map((l) => (
                <span key={l} className="github-label-badge">{l}</span>
              ))}
            </div>
          )}
          <div className="github-pr-detail-actions">
            {selectedIssue.state === "open" && (
              <button
                type="button"
                className="github-action-btn"
                onClick={() => handleClose(selectedIssue)}
              >
                <CheckCircle2 size={11} /> Close
              </button>
            )}
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

      {/* Issue List */}
      {!selectedIssue && (
        <div className="github-pr-list">
          {loading && <div className="github-loading"><RefreshCw size={12} className="spin" /> Loading...</div>}
          {!loading && issues.length === 0 && <div className="github-empty">No {filter} issues.</div>}
          {!loading && issues.map((issue) => (
            <div
              key={issue.number}
              className="github-pr-item"
              onClick={() => loadComments(issue)}
              role="button"
              tabIndex={0}
            >
              <div className="github-pr-item-icon">
                <CircleDot size={14} className={issue.state === "open" ? "open" : "closed"} />
              </div>
              <div className="github-pr-item-info">
                <div className="github-pr-item-title">{issue.title}</div>
                <div className="github-pr-item-meta">
                  #{issue.number} • {issue.user_login}
                  {issue.labels.length > 0 && ` • ${issue.labels.join(", ")}`}
                </div>
              </div>
              <a
                href={issue.html_url}
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
