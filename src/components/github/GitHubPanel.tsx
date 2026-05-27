/**
 * GitHubPanel — Main GitHub integration panel for the sidebar.
 * Shows git core status, auth state, and provides access to GitHub features.
 */

import { useCallback, useEffect, useState } from "react";
import {
  GitPullRequest,
  RefreshCw,
  X,
  GitBranch,
  AlertCircle,
  CheckCircle2,
  Cloud,
  CloudOff,
  LogIn,
  LogOut,
  User,
  Eye,
  EyeOff,
} from "lucide-react";
import { useGitHubStore } from "../../stores/githubStore";
import {
  githubCheckRepo,
  githubListBranches,
  githubSetToken,
  githubGetUser,
  githubCheckAuth,
  githubLogout,
  persistGitHubToken,
  restoreGitHubAuth,
  clearPersistedGitHubToken,
  githubGetRepoSlug,
} from "../../services/githubService";
import type { GitCoreStatus, GitHubUser, BranchInfo } from "../../services/githubService";
import { showToast } from "../../utils/toast";
import RepoManager from "./RepoManager";
import SyncPanel from "./SyncPanel";
import PullRequestPanel from "./PullRequestPanel";
import IssuesPanel from "./IssuesPanel";

interface Props {
  projectPath: string;
  onClose: () => void;
}

export default function GitHubPanel({ projectPath, onClose }: Props) {
  const {
    coreStatus, setCoreStatus,
    branches, setBranches,
    coreLoading, setCoreLoading,
    coreError, setCoreError,
    user, setUser,
    isAuthenticated,
    authLoading, setAuthLoading,
  } = useGitHubStore();

  const [tokenInput, setTokenInput] = useState("");
  const [showToken, setShowToken] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);
  const [repoSlug, setRepoSlug] = useState<[string, string] | null>(null);
  const [activeTab, setActiveTab] = useState<"overview" | "prs" | "issues">("overview");

  // ── Load git core status ────────────────────────────────────────────────────

  const refreshCoreStatus = useCallback(async () => {
    if (!projectPath) return;
    setCoreLoading(true);
    setCoreError(null);
    try {
      const status = await githubCheckRepo();
      setCoreStatus(status);
      if (status.is_git_repo) {
        const branchList = await githubListBranches(true);
        setBranches(branchList);
        // Try to get repo slug for PR/Issues panels
        if (status.remote_origin) {
          githubGetRepoSlug().then(setRepoSlug).catch(() => setRepoSlug(null));
        }
      }
    } catch (err) {
      setCoreError(String(err));
    } finally {
      setCoreLoading(false);
    }
  }, [projectPath, setCoreStatus, setBranches, setCoreLoading, setCoreError]);

  // ── Check existing auth on mount (restore from encrypted store) ─────────────

  useEffect(() => {
    const checkAuth = async () => {
      try {
        // First check if Rust already has the token in memory
        const authed = await githubCheckAuth();
        if (authed) {
          const existingUser = await githubGetUser();
          if (existingUser) {
            setUser(existingUser);
            return;
          }
        }
        // Otherwise try to restore from persisted store
        const restoredUser = await restoreGitHubAuth();
        if (restoredUser) setUser(restoredUser);
      } catch {
        // Not authenticated — that's fine
      }
    };
    checkAuth();
  }, [setUser]);

  // ── Refresh on mount and project change ────────────────────────────────────

  useEffect(() => {
    refreshCoreStatus();
  }, [refreshCoreStatus]);

  // ── Auth handlers ──────────────────────────────────────────────────────────

  const handleConnect = async () => {
    if (!tokenInput.trim()) {
      setAuthError("Please enter a GitHub Personal Access Token");
      return;
    }
    setAuthLoading(true);
    setAuthError(null);
    try {
      const ghUser = await githubSetToken(tokenInput.trim());
      // Persist token to encrypted store for next app launch
      await persistGitHubToken(tokenInput.trim());
      setUser(ghUser);
      setTokenInput("");
      showToast(`Connected as ${ghUser.login}`, "success");
    } catch (err) {
      setAuthError(String(err));
      showToast("Failed to connect to GitHub", "error");
    } finally {
      setAuthLoading(false);
    }
  };

  const handleDisconnect = async () => {
    try {
      await githubLogout();
      await clearPersistedGitHubToken();
      setUser(null);
      showToast("Disconnected from GitHub", "info");
    } catch (err) {
      showToast(`Logout failed: ${err}`, "error");
    }
  };

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <div className="github-panel">
      {/* Header */}
      <div className="panel-header github-panel-header">
        <span><GitPullRequest size={14} /> GITHUB</span>
        <div className="panel-actions">
          <button
            type="button"
            className="icon-btn small"
            onClick={refreshCoreStatus}
            disabled={coreLoading}
            aria-label="Refresh"
          >
            <RefreshCw size={14} className={coreLoading ? "spin" : ""} />
          </button>
          <button type="button" className="icon-btn small" onClick={onClose} aria-label="Close">
            <X size={14} />
          </button>
        </div>
      </div>

      {/* Auth Section */}
      <div className="github-section github-auth-section">
        {isAuthenticated && user ? (
          <div className="github-user-info">
            <div className="github-user-row">
              <img
                src={user.avatar_url}
                alt={user.login}
                className="github-avatar"
                width={28}
                height={28}
              />
              <div className="github-user-details">
                <span className="github-username">{user.name || user.login}</span>
                <span className="github-login">@{user.login}</span>
              </div>
              <button
                type="button"
                className="icon-btn small github-logout-btn"
                onClick={handleDisconnect}
                title="Disconnect from GitHub"
                aria-label="Disconnect"
              >
                <LogOut size={14} />
              </button>
            </div>
          </div>
        ) : (
          <div className="github-auth-form">
            <div className="github-auth-label">
              <LogIn size={14} />
              <span>Connect to GitHub</span>
            </div>
            <div className="github-token-input-row">
              <input
                type={showToken ? "text" : "password"}
                className="github-token-input"
                placeholder="ghp_xxxxxxxxxxxx"
                value={tokenInput}
                onChange={(e) => setTokenInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") handleConnect();
                }}
                disabled={authLoading}
                autoComplete="off"
                spellCheck={false}
              />
              <button
                type="button"
                className="icon-btn small"
                onClick={() => setShowToken(!showToken)}
                title={showToken ? "Hide token" : "Show token"}
                aria-label={showToken ? "Hide token" : "Show token"}
              >
                {showToken ? <EyeOff size={12} /> : <Eye size={12} />}
              </button>
            </div>
            <button
              type="button"
              className="github-connect-btn"
              onClick={handleConnect}
              disabled={authLoading || !tokenInput.trim()}
            >
              {authLoading ? "Connecting..." : "Connect"}
            </button>
            {authError && (
              <div className="github-auth-error">
                <AlertCircle size={12} />
                <span>{authError}</span>
              </div>
            )}
            <div className="github-auth-hint">
              Requires scopes: <code>repo</code>, <code>workflow</code>, <code>gist</code>, <code>read:user</code>
            </div>
          </div>
        )}
      </div>

      {/* Git Core Status */}
      <div className="github-section github-core-section">
        <div className="github-section-title">Repository Status</div>

        {coreError && (
          <div className="github-error">
            <AlertCircle size={12} />
            <span>{coreError}</span>
          </div>
        )}

        {coreStatus && !coreError && (
          <div className="github-status-grid">
            {/* Repo status */}
            <div className="github-status-row">
              <span className="github-status-label">Repository</span>
              <span className={`github-status-value ${coreStatus.is_git_repo ? "ok" : "warn"}`}>
                {coreStatus.is_git_repo ? (
                  <><CheckCircle2 size={12} /> Initialized</>
                ) : (
                  <><AlertCircle size={12} /> Not a git repo</>
                )}
              </span>
            </div>

            {coreStatus.is_git_repo && (
              <>
                {/* Branch */}
                <div className="github-status-row">
                  <span className="github-status-label">Branch</span>
                  <span className="github-status-value">
                    <GitBranch size={12} />
                    {coreStatus.detached ? "HEAD (detached)" : coreStatus.branch || "—"}
                  </span>
                </div>

                {/* Remote */}
                <div className="github-status-row">
                  <span className="github-status-label">Remote</span>
                  <span className={`github-status-value ${coreStatus.remote_origin ? "ok" : "dim"}`}>
                    {coreStatus.remote_origin ? (
                      <><Cloud size={12} /> {coreStatus.remote_origin.replace(/\.git$/, "").split("/").slice(-2).join("/")}</>
                    ) : (
                      <><CloudOff size={12} /> No remote</>
                    )}
                  </span>
                </div>

                {/* Ahead/Behind */}
                {coreStatus.has_upstream && (
                  <div className="github-status-row">
                    <span className="github-status-label">Sync</span>
                    <span className="github-status-value">
                      {coreStatus.ahead > 0 && <span className="github-ahead">↑{coreStatus.ahead}</span>}
                      {coreStatus.behind > 0 && <span className="github-behind">↓{coreStatus.behind}</span>}
                      {coreStatus.ahead === 0 && coreStatus.behind === 0 && (
                        <span className="github-synced"><CheckCircle2 size={12} /> Up to date</span>
                      )}
                    </span>
                  </div>
                )}

                {/* Dirty files */}
                <div className="github-status-row">
                  <span className="github-status-label">Changes</span>
                  <span className={`github-status-value ${coreStatus.dirty_count > 0 ? "warn" : "ok"}`}>
                    {coreStatus.dirty_count > 0 ? (
                      <>{coreStatus.dirty_count} uncommitted file{coreStatus.dirty_count !== 1 ? "s" : ""}</>
                    ) : (
                      <><CheckCircle2 size={12} /> Clean</>
                    )}
                  </span>
                </div>
              </>
            )}
          </div>
        )}

        {!coreStatus && !coreError && !coreLoading && (
          <div className="github-empty">Open a project to see repository status.</div>
        )}

        {coreLoading && (
          <div className="github-loading">
            <RefreshCw size={14} className="spin" />
            <span>Checking repository...</span>
          </div>
        )}
      </div>

      {/* Branches */}
      {coreStatus?.is_git_repo && branches.length > 0 && (
        <div className="github-section github-branches-section">
          <div className="github-section-title">
            Branches ({branches.filter(b => !b.is_remote).length} local, {branches.filter(b => b.is_remote).length} remote)
          </div>
          <div className="github-branch-list">
            {branches
              .filter(b => !b.is_remote)
              .map((b) => (
                <div
                  key={b.name}
                  className={`github-branch-item ${b.is_current ? "current" : ""}`}
                >
                  <GitBranch size={12} />
                  <span className="github-branch-name">{b.name}</span>
                  {b.is_current && <span className="github-branch-badge">current</span>}
                  {b.upstream && <span className="github-branch-upstream">→ {b.upstream}</span>}
                </div>
              ))}
          </div>
        </div>
      )}

      {/* Sync Panel — Phase 3 + Phase 6 Safety */}
      {coreStatus?.is_git_repo && (
        <div className="github-section">
          <div className="github-section-title">Sync</div>
          <SyncPanel
            projectPath={projectPath}
            currentBranch={coreStatus.branch}
            hasRemote={!!coreStatus.remote_origin}
            onRefresh={refreshCoreStatus}
          />
        </div>
      )}

      {/* Repository Manager — Phase 2 */}
      {isAuthenticated && coreStatus && (
        <div className="github-section">
          <div className="github-section-title">Repositories</div>
          <RepoManager
            projectPath={projectPath}
            remoteOrigin={coreStatus.remote_origin}
            isGitRepo={coreStatus.is_git_repo}
            onRefresh={refreshCoreStatus}
          />
        </div>
      )}

      {/* Tabs for PRs / Issues — Phase 4+5 */}
      {isAuthenticated && repoSlug && coreStatus?.is_git_repo && (
        <div className="github-section github-tabs-section">
          <div className="github-tabs">
            <button
              type="button"
              className={`github-tab ${activeTab === "overview" ? "active" : ""}`}
              onClick={() => setActiveTab("overview")}
            >
              Overview
            </button>
            <button
              type="button"
              className={`github-tab ${activeTab === "prs" ? "active" : ""}`}
              onClick={() => setActiveTab("prs")}
            >
              PRs
            </button>
            <button
              type="button"
              className={`github-tab ${activeTab === "issues" ? "active" : ""}`}
              onClick={() => setActiveTab("issues")}
            >
              Issues
            </button>
          </div>

          {activeTab === "prs" && (
            <PullRequestPanel
              owner={repoSlug[0]}
              repo={repoSlug[1]}
              currentBranch={coreStatus.branch}
              defaultBranch="main"
            />
          )}

          {activeTab === "issues" && (
            <IssuesPanel
              owner={repoSlug[0]}
              repo={repoSlug[1]}
            />
          )}
        </div>
      )}
    </div>
  );
}
