//! Shared types for the GitHub integration module.

use serde::{Deserialize, Serialize};

// ─── Git Core Check Types ─────────────────────────────────────────────────────

/// Result of checking whether the current project is a valid git repository.
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct GitCoreStatus {
    /// Whether the folder is inside a git work tree.
    pub is_git_repo: bool,
    /// Current branch name (None if detached HEAD or not a repo).
    pub branch: Option<String>,
    /// Whether HEAD is detached.
    pub detached: bool,
    /// Number of dirty (modified/untracked) files.
    pub dirty_count: usize,
    /// List of dirty file paths (capped at 100 for performance).
    pub dirty_files: Vec<String>,
    /// Remote "origin" URL if configured.
    pub remote_origin: Option<String>,
    /// Commits ahead of upstream (0 if no upstream).
    pub ahead: usize,
    /// Commits behind upstream (0 if no upstream).
    pub behind: usize,
    /// Whether an upstream tracking branch is configured.
    pub has_upstream: bool,
    /// Whether git2 crate is functional (always true in our case).
    pub git_available: bool,
}

// ─── GitHub API Types ─────────────────────────────────────────────────────────

/// Authenticated GitHub user info.
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct GitHubUser {
    pub login: String,
    pub id: u64,
    pub avatar_url: String,
    pub name: Option<String>,
    pub email: Option<String>,
    pub html_url: String,
}

/// Repository info from GitHub API.
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct RepoInfo {
    pub id: u64,
    pub name: String,
    pub full_name: String,
    pub private: bool,
    pub html_url: String,
    pub clone_url: String,
    pub ssh_url: String,
    pub description: Option<String>,
    pub default_branch: String,
    pub stargazers_count: u32,
    pub forks_count: u32,
    pub language: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

/// Pull request summary.
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct PullRequest {
    pub number: u32,
    pub title: String,
    pub body: Option<String>,
    pub state: String,
    pub html_url: String,
    pub head_ref: String,
    pub base_ref: String,
    pub user_login: String,
    pub created_at: String,
    pub updated_at: String,
    pub draft: bool,
    pub mergeable: Option<bool>,
}

/// Issue summary.
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Issue {
    pub number: u32,
    pub title: String,
    pub body: Option<String>,
    pub state: String,
    pub html_url: String,
    pub user_login: String,
    pub labels: Vec<String>,
    pub created_at: String,
    pub updated_at: String,
}

/// Comment on a PR or issue.
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Comment {
    pub id: u64,
    pub body: String,
    pub user_login: String,
    pub created_at: String,
}

/// GitHub Actions workflow run.
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct WorkflowRun {
    pub id: u64,
    pub name: String,
    pub status: String,
    pub conclusion: Option<String>,
    pub html_url: String,
    pub head_branch: String,
    pub created_at: String,
}

/// Gist info.
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct GistInfo {
    pub id: String,
    pub html_url: String,
    pub description: Option<String>,
    pub public: bool,
    pub created_at: String,
}

/// Pre-push safety check result.
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct PrePushStatus {
    pub dirty_files: Vec<String>,
    pub ahead: usize,
    pub behind: usize,
    pub has_remote: bool,
    pub has_upstream: bool,
    pub current_branch: Option<String>,
    /// Whether it's safe to push (no dirty files, has remote, not behind).
    pub safe_to_push: bool,
    /// Human-readable warnings.
    pub warnings: Vec<String>,
}

/// Branch info.
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct BranchInfo {
    pub name: String,
    pub is_current: bool,
    pub is_remote: bool,
    pub upstream: Option<String>,
}
