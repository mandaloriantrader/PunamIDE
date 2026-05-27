//! GitHub repository management — create, list, clone, link.
//! Phase 2 implementation.

use serde::{Deserialize, Serialize};
use tauri::State;
use super::auth::GitHubAuthState;
use super::client::GitHubClient;
use super::types::RepoInfo;
use crate::ProjectRoot;
use std::sync::Mutex;

// ─── API Response Types (GitHub API shape) ────────────────────────────────────

#[derive(Deserialize)]
struct ApiRepo {
    id: u64,
    name: String,
    full_name: String,
    private: bool,
    html_url: String,
    clone_url: String,
    ssh_url: String,
    description: Option<String>,
    default_branch: Option<String>,
    stargazers_count: Option<u32>,
    forks_count: Option<u32>,
    language: Option<String>,
    created_at: Option<String>,
    updated_at: Option<String>,
}

impl From<ApiRepo> for RepoInfo {
    fn from(r: ApiRepo) -> Self {
        RepoInfo {
            id: r.id,
            name: r.name,
            full_name: r.full_name,
            private: r.private,
            html_url: r.html_url,
            clone_url: r.clone_url,
            ssh_url: r.ssh_url,
            description: r.description,
            default_branch: r.default_branch.unwrap_or_else(|| "main".to_string()),
            stargazers_count: r.stargazers_count.unwrap_or(0),
            forks_count: r.forks_count.unwrap_or(0),
            language: r.language,
            created_at: r.created_at.unwrap_or_default(),
            updated_at: r.updated_at.unwrap_or_default(),
        }
    }
}

// ─── Request Bodies ───────────────────────────────────────────────────────────

#[derive(Serialize)]
struct CreateRepoBody {
    name: String,
    description: Option<String>,
    private: bool,
    auto_init: bool,
}

// ─── Helper ───────────────────────────────────────────────────────────────────

fn get_client(auth: &State<GitHubAuthState>) -> Result<GitHubClient, String> {
    let token = auth.get_token().ok_or("Not authenticated. Connect to GitHub first.")?;
    Ok(GitHubClient::new(&token))
}

fn get_project_root(state: &State<ProjectRoot>) -> Result<String, String> {
    let lock = state.0.lock().map_err(|e| format!("Lock error: {}", e))?;
    lock.clone().ok_or_else(|| "No project root set".to_string())
}

// ─── Commands ─────────────────────────────────────────────────────────────────

/// Create a new GitHub repository.
#[tauri::command]
pub async fn github_create_repo(
    name: String,
    private: bool,
    description: Option<String>,
    auto_init: bool,
    auth: State<'_, GitHubAuthState>,
) -> Result<RepoInfo, String> {
    let client = get_client(&auth)?;
    let body = CreateRepoBody {
        name,
        description,
        private,
        auto_init,
    };
    let repo: ApiRepo = client.post("/user/repos", &body).await?;
    Ok(repo.into())
}

/// List authenticated user's repositories.
#[tauri::command]
pub async fn github_list_repos(
    page: u32,
    per_page: u32,
    sort: Option<String>,
    auth: State<'_, GitHubAuthState>,
) -> Result<Vec<RepoInfo>, String> {
    let client = get_client(&auth)?;
    let sort_param = sort.unwrap_or_else(|| "updated".to_string());
    let path = format!("/user/repos?sort={}&per_page={}&page={}&type=all", sort_param, per_page, page);
    let repos: Vec<ApiRepo> = client.get(&path).await?;
    Ok(repos.into_iter().map(|r| r.into()).collect())
}

/// Get info about a specific repository.
#[tauri::command]
pub async fn github_get_repo_info(
    owner: String,
    repo: String,
    auth: State<'_, GitHubAuthState>,
) -> Result<RepoInfo, String> {
    let client = get_client(&auth)?;
    let path = format!("/repos/{}/{}", owner, repo);
    let api_repo: ApiRepo = client.get(&path).await?;
    Ok(api_repo.into())
}

/// Add a remote origin to the current git repository.
#[tauri::command]
pub fn github_link_remote(
    repo_url: String,
    remote_name: Option<String>,
    state: State<'_, ProjectRoot>,
) -> Result<(), String> {
    let root = get_project_root(&state)?;
    let repo = git2::Repository::open(&root)
        .map_err(|e| format!("Not a git repository: {}", e))?;

    let name = remote_name.unwrap_or_else(|| "origin".to_string());

    // Check if remote already exists
    if repo.find_remote(&name).is_ok() {
        // Update existing remote URL
        repo.remote_set_url(&name, &repo_url)
            .map_err(|e| format!("Failed to update remote '{}': {}", name, e))?;
    } else {
        // Create new remote
        repo.remote(&name, &repo_url)
            .map_err(|e| format!("Failed to add remote '{}': {}", name, e))?;
    }

    Ok(())
}

/// Remove a remote from the current git repository.
#[tauri::command]
pub fn github_remove_remote(
    remote_name: String,
    state: State<'_, ProjectRoot>,
) -> Result<(), String> {
    let root = get_project_root(&state)?;
    let repo = git2::Repository::open(&root)
        .map_err(|e| format!("Not a git repository: {}", e))?;

    repo.remote_delete(&remote_name)
        .map_err(|e| format!("Failed to remove remote '{}': {}", remote_name, e))?;

    Ok(())
}

/// Initialize a new git repository in the current project folder.
#[tauri::command]
pub fn github_init_repo(state: State<'_, ProjectRoot>) -> Result<(), String> {
    let root = get_project_root(&state)?;

    // Check if already a repo
    if git2::Repository::open(&root).is_ok() {
        return Err("Already a git repository".to_string());
    }

    git2::Repository::init(&root)
        .map_err(|e| format!("Failed to initialize repository: {}", e))?;

    Ok(())
}

/// Get the current repo's owner/name from the remote origin URL.
/// Returns (owner, repo_name) or error if no remote or can't parse.
#[tauri::command]
pub fn github_get_repo_slug(state: State<'_, ProjectRoot>) -> Result<(String, String), String> {
    let root = get_project_root(&state)?;
    let repo = git2::Repository::open(&root)
        .map_err(|e| format!("Not a git repository: {}", e))?;

    let remote = repo.find_remote("origin")
        .map_err(|_| "No 'origin' remote configured".to_string())?;

    let url = remote.url()
        .ok_or("Remote URL is not valid UTF-8")?
        .to_string();

    parse_github_url(&url)
        .ok_or_else(|| format!("Could not parse GitHub owner/repo from URL: {}", url))
}

// ─── URL Parsing ──────────────────────────────────────────────────────────────

/// Parse a GitHub URL into (owner, repo) tuple.
/// Supports:
///   https://github.com/owner/repo.git
///   https://github.com/owner/repo
///   git@github.com:owner/repo.git
///   git@github.com:owner/repo
fn parse_github_url(url: &str) -> Option<(String, String)> {
    // HTTPS format
    if url.contains("github.com/") {
        let parts: Vec<&str> = url.split("github.com/").collect();
        if parts.len() >= 2 {
            let path = parts[1].trim_end_matches(".git").trim_end_matches('/');
            let segments: Vec<&str> = path.split('/').collect();
            if segments.len() >= 2 {
                return Some((segments[0].to_string(), segments[1].to_string()));
            }
        }
    }

    // SSH format
    if url.contains("github.com:") {
        let parts: Vec<&str> = url.split("github.com:").collect();
        if parts.len() >= 2 {
            let path = parts[1].trim_end_matches(".git").trim_end_matches('/');
            let segments: Vec<&str> = path.split('/').collect();
            if segments.len() >= 2 {
                return Some((segments[0].to_string(), segments[1].to_string()));
            }
        }
    }

    None
}
