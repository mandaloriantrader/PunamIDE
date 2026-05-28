/**
 * RepoManager — Create, list, and link GitHub repositories.
 */

import { useCallback, useEffect, useState } from "react";
import {
  Plus,
  RefreshCw,
  Link,
  Unlink,
  Lock,
  Unlock,
  Star,
  GitFork,
  ExternalLink,
  FolderGit2,
  ChevronDown,
  ChevronRight,
} from "lucide-react";
import {
  githubCreateRepo,
  githubListRepos,
  githubLinkRemote,
  githubInitRepo,
  githubGetRepoSlug,
} from "../../services/githubService";
import type { RepoInfo } from "../../services/githubService";
import { showToast } from "../../utils/toast";

interface Props {
  projectPath: string;
  remoteOrigin: string | null;
  isGitRepo: boolean;
  onRefresh: () => void;
}

export default function RepoManager({ projectPath, remoteOrigin, isGitRepo, onRefresh }: Props) {
  const [repos, setRepos] = useState<RepoInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [showCreateForm, setShowCreateForm] = useState(false);
  const [showRepoList, setShowRepoList] = useState(false);

  // Create form state
  const [newName, setNewName] = useState("");
  const [newDesc, setNewDesc] = useState("");
  const [newPrivate, setNewPrivate] = useState(true);
  const [creating, setCreating] = useState(false);

  // Link state
  const [linking, setLinking] = useState(false);
  const [currentSlug, setCurrentSlug] = useState<[string, string] | null>(null);

  // Load current repo slug
  useEffect(() => {
    if (isGitRepo && remoteOrigin) {
      githubGetRepoSlug()
        .then(setCurrentSlug)
        .catch(() => setCurrentSlug(null));
    } else {
      setCurrentSlug(null);
    }
  }, [isGitRepo, remoteOrigin]);

  // ── Load repos ─────────────────────────────────────────────────────────────

  const loadRepos = useCallback(async () => {
    setLoading(true);
    try {
      const list = await githubListRepos(1, 50, "updated");
      setRepos(list);
    } catch (err) {
      showToast(`Failed to load repos: ${err}`, "error");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (showRepoList && repos.length === 0) {
      loadRepos();
    }
  }, [showRepoList, repos.length, loadRepos]);

  // ── Create repo ────────────────────────────────────────────────────────────

  const handleCreate = async () => {
    if (!newName.trim()) {
      showToast("Repository name is required", "warning");
      return;
    }

    setCreating(true);
    try {
      const repo = await githubCreateRepo(newName.trim(), newPrivate, newDesc.trim() || undefined, false);

      // If current project is a git repo, link the new remote
      if (isGitRepo) {
        await githubLinkRemote(repo.clone_url);
        showToast(`Created "${repo.full_name}" and linked as origin`, "success");
      } else {
        // Init git repo first, then link
        await githubInitRepo();
        await githubLinkRemote(repo.clone_url);
        showToast(`Initialized git, created "${repo.full_name}", and linked as origin`, "success");
      }

      setNewName("");
      setNewDesc("");
      setShowCreateForm(false);
      onRefresh();
    } catch (err) {
      showToast(`Failed to create repo: ${err}`, "error");
    } finally {
      setCreating(false);
    }
  };

  // ── Link existing repo ─────────────────────────────────────────────────────

  const handleLinkRepo = async (repo: RepoInfo) => {
    setLinking(true);
    try {
      if (!isGitRepo) {
        await githubInitRepo();
      }
      await githubLinkRemote(repo.clone_url);
      showToast(`Linked "${repo.full_name}" as origin`, "success");
      onRefresh();
    } catch (err) {
      showToast(`Failed to link: ${err}`, "error");
    } finally {
      setLinking(false);
    }
  };

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <div className="github-repo-manager">
      {/* Current repo info */}
      {currentSlug && (
        <div className="github-current-repo">
          <FolderGit2 size={12} />
          <span className="github-current-repo-name">
            {currentSlug[0]}/{currentSlug[1]}
          </span>
          <a
            href={`https://github.com/${currentSlug[0]}/${currentSlug[1]}`}
            target="_blank"
            rel="noopener noreferrer"
            className="github-external-link"
            title="Open on GitHub"
          >
            <ExternalLink size={11} />
          </a>
        </div>
      )}

      {/* Action buttons */}
      <div className="github-repo-actions">
        <button
          type="button"
          className="github-action-btn"
          onClick={() => setShowCreateForm(!showCreateForm)}
          title="Create new repository on GitHub"
        >
          <Plus size={12} />
          Create Repo
        </button>
        <button
          type="button"
          className="github-action-btn"
          onClick={() => setShowRepoList(!showRepoList)}
          title="Link an existing repository"
        >
          <Link size={12} />
          Link Existing
        </button>
      </div>

      {/* Create form */}
      {showCreateForm && (
        <div className="github-create-form">
          <input
            type="text"
            className="github-input"
            placeholder="Repository name"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") handleCreate(); }}
            disabled={creating}
            autoFocus
          />
          <input
            type="text"
            className="github-input"
            placeholder="Description (optional)"
            value={newDesc}
            onChange={(e) => setNewDesc(e.target.value)}
            disabled={creating}
          />
          <div className="github-create-options">
            <button
              type="button"
              className={`github-visibility-btn ${newPrivate ? "active" : ""}`}
              onClick={() => setNewPrivate(true)}
              title="Private repository"
            >
              <Lock size={12} /> Private
            </button>
            <button
              type="button"
              className={`github-visibility-btn ${!newPrivate ? "active" : ""}`}
              onClick={() => setNewPrivate(false)}
              title="Public repository"
            >
              <Unlock size={12} /> Public
            </button>
          </div>
          <div className="github-create-actions">
            <button
              type="button"
              className="github-connect-btn"
              onClick={handleCreate}
              disabled={creating || !newName.trim()}
            >
              {creating ? "Creating..." : "Create & Link"}
            </button>
            <button
              type="button"
              className="github-cancel-btn"
              onClick={() => setShowCreateForm(false)}
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Repo list */}
      {showRepoList && (
        <div className="github-repo-list-section">
          <div className="github-repo-list-header">
            <span>Your Repositories</span>
            <button
              type="button"
              className="icon-btn small"
              onClick={loadRepos}
              disabled={loading}
              title="Refresh"
            >
              <RefreshCw size={12} className={loading ? "spin" : ""} />
            </button>
          </div>
          {loading && (
            <div className="github-loading">
              <RefreshCw size={12} className="spin" />
              <span>Loading...</span>
            </div>
          )}
          {!loading && repos.length === 0 && (
            <div className="github-empty">No repositories found.</div>
          )}
          {!loading && repos.length > 0 && (
            <div className="github-repo-list">
              {repos.map((repo) => (
                <div key={repo.id} className="github-repo-item">
                  <div className="github-repo-item-info">
                    <div className="github-repo-item-name">
                      {repo.private ? <Lock size={11} /> : <Unlock size={11} />}
                      <span>{repo.full_name}</span>
                    </div>
                    {repo.description && (
                      <div className="github-repo-item-desc">{repo.description}</div>
                    )}
                    <div className="github-repo-item-meta">
                      {repo.language && <span className="github-repo-lang">{repo.language}</span>}
                      <span><Star size={10} /> {repo.stargazers_count}</span>
                      <span><GitFork size={10} /> {repo.forks_count}</span>
                    </div>
                  </div>
                  <button
                    type="button"
                    className="github-link-btn"
                    onClick={() => handleLinkRepo(repo)}
                    disabled={linking}
                    title="Link this repo as origin"
                  >
                    <Link size={12} />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
