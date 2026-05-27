//! GitHub integration module for Punam IDE.
//!
//! Architecture:
//!   React UI → invoke() → Tauri Commands (this module) → GitHub API / git2
//!
//! The PAT never leaves Rust. All GitHub API calls happen server-side.

pub mod types;
pub mod auth;
pub mod client;
pub mod repos;
pub mod safety;
pub mod sync;
pub mod pull_requests;
pub mod issues;
pub mod actions;
pub mod gists;

use tauri::State;
use crate::ProjectRoot;

pub use types::*;

// ─── Phase 0: Git Core Check Commands ─────────────────────────────────────────

/// Full git status check for the current project.
/// Returns repo state, branch, dirty files, remote, ahead/behind.
#[tauri::command]
pub fn github_check_repo(state: State<ProjectRoot>) -> Result<GitCoreStatus, String> {
    let root = get_project_root_str(&state)?;
    check_git_repo(&root)
}

/// Quick check: is the current folder a git repo?
#[tauri::command]
pub fn github_is_git_repo(state: State<ProjectRoot>) -> Result<bool, String> {
    let root = get_project_root_str(&state)?;
    Ok(git2::Repository::open(&root).is_ok())
}

/// Get current branch name.
#[tauri::command]
pub fn github_get_branch(state: State<ProjectRoot>) -> Result<Option<String>, String> {
    let root = get_project_root_str(&state)?;
    let repo = open_repo(&root)?;
    Ok(get_current_branch(&repo))
}

/// Get list of dirty (uncommitted) files.
#[tauri::command]
pub fn github_get_dirty_files(state: State<ProjectRoot>) -> Result<Vec<String>, String> {
    let root = get_project_root_str(&state)?;
    let repo = open_repo(&root)?;
    Ok(get_dirty_files(&repo))
}

/// Get remote origin URL.
#[tauri::command]
pub fn github_get_remote_origin(state: State<ProjectRoot>) -> Result<Option<String>, String> {
    let root = get_project_root_str(&state)?;
    let repo = open_repo(&root)?;
    Ok(get_remote_url(&repo, "origin"))
}

/// Get ahead/behind counts relative to upstream.
#[tauri::command]
pub fn github_get_ahead_behind(state: State<ProjectRoot>) -> Result<(usize, usize), String> {
    let root = get_project_root_str(&state)?;
    let repo = open_repo(&root)?;
    Ok(get_ahead_behind(&repo))
}

/// List all local and optionally remote branches.
#[tauri::command]
pub fn github_list_branches(include_remote: bool, state: State<ProjectRoot>) -> Result<Vec<BranchInfo>, String> {
    let root = get_project_root_str(&state)?;
    let repo = open_repo(&root)?;
    list_branches(&repo, include_remote)
}

// ─── Internal Helpers ─────────────────────────────────────────────────────────

fn get_project_root_str(state: &State<ProjectRoot>) -> Result<String, String> {
    let lock = state.0.lock().map_err(|e| format!("Lock error: {}", e))?;
    lock.clone().ok_or_else(|| "No project root set".to_string())
}

fn open_repo(root: &str) -> Result<git2::Repository, String> {
    git2::Repository::open(root).map_err(|e| format!("Not a git repository: {}", e))
}

fn get_current_branch(repo: &git2::Repository) -> Option<String> {
    repo.head()
        .ok()
        .and_then(|h| {
            if h.is_branch() {
                h.shorthand().map(|s| s.to_string())
            } else {
                None // detached HEAD
            }
        })
}

fn is_head_detached(repo: &git2::Repository) -> bool {
    repo.head_detached().unwrap_or(false)
}

fn get_dirty_files(repo: &git2::Repository) -> Vec<String> {
    let mut opts = git2::StatusOptions::new();
    opts.include_untracked(true)
        .recurse_untracked_dirs(true);

    let statuses = match repo.statuses(Some(&mut opts)) {
        Ok(s) => s,
        Err(_) => return Vec::new(),
    };

    statuses
        .iter()
        .filter_map(|entry| {
            let st = entry.status();
            // Skip clean entries
            if st == git2::Status::CURRENT {
                return None;
            }
            entry.path().map(|p| p.to_string())
        })
        .take(100) // cap for performance
        .collect()
}

fn get_remote_url(repo: &git2::Repository, name: &str) -> Option<String> {
    repo.find_remote(name)
        .ok()
        .and_then(|remote| remote.url().map(|u| u.to_string()))
}

fn get_ahead_behind(repo: &git2::Repository) -> (usize, usize) {
    // Get HEAD oid
    let head_oid = match repo.head().ok().and_then(|h| h.target()) {
        Some(oid) => oid,
        None => return (0, 0),
    };

    // Get upstream oid
    let upstream_oid = match repo.head().ok().and_then(|h| {
        let branch_name = h.shorthand()?.to_string();
        let branch = repo.find_branch(&branch_name, git2::BranchType::Local).ok()?;
        let upstream = branch.upstream().ok()?;
        upstream.get().target()
    }) {
        Some(oid) => oid,
        None => return (0, 0), // no upstream configured
    };

    repo.graph_ahead_behind(head_oid, upstream_oid)
        .unwrap_or((0, 0))
}

fn has_upstream(repo: &git2::Repository) -> bool {
    repo.head()
        .ok()
        .and_then(|h| {
            let branch_name = h.shorthand()?.to_string();
            let branch = repo.find_branch(&branch_name, git2::BranchType::Local).ok()?;
            branch.upstream().ok()
        })
        .is_some()
}

fn check_git_repo(root: &str) -> Result<GitCoreStatus, String> {
    let repo = match git2::Repository::open(root) {
        Ok(r) => r,
        Err(_) => {
            return Ok(GitCoreStatus {
                is_git_repo: false,
                branch: None,
                detached: false,
                dirty_count: 0,
                dirty_files: Vec::new(),
                remote_origin: None,
                ahead: 0,
                behind: 0,
                has_upstream: false,
                git_available: true,
            });
        }
    };

    let branch = get_current_branch(&repo);
    let detached = is_head_detached(&repo);
    let dirty_files = get_dirty_files(&repo);
    let dirty_count = dirty_files.len();
    let remote_origin = get_remote_url(&repo, "origin");
    let (ahead, behind) = get_ahead_behind(&repo);
    let upstream = has_upstream(&repo);

    Ok(GitCoreStatus {
        is_git_repo: true,
        branch,
        detached,
        dirty_count,
        dirty_files,
        remote_origin,
        ahead,
        behind,
        has_upstream: upstream,
        git_available: true,
    })
}

fn list_branches(repo: &git2::Repository, include_remote: bool) -> Result<Vec<BranchInfo>, String> {
    let mut branches = Vec::new();
    let current_branch = get_current_branch(repo);

    // Local branches
    let local_branches = repo.branches(Some(git2::BranchType::Local))
        .map_err(|e| format!("Failed to list branches: {}", e))?;

    for branch_result in local_branches {
        let (branch, _) = branch_result.map_err(|e| e.to_string())?;
        let name = branch.name().ok().flatten().unwrap_or("").to_string();
        let is_current = current_branch.as_deref() == Some(&name);
        let upstream = branch.upstream().ok()
            .and_then(|u| u.name().ok().flatten().map(|s| s.to_string()));

        branches.push(BranchInfo {
            name: name.clone(),
            is_current,
            is_remote: false,
            upstream,
        });
    }

    // Remote branches
    if include_remote {
        let remote_branches = repo.branches(Some(git2::BranchType::Remote))
            .map_err(|e| format!("Failed to list remote branches: {}", e))?;

        for branch_result in remote_branches {
            let (branch, _) = branch_result.map_err(|e| e.to_string())?;
            let name = branch.name().ok().flatten().unwrap_or("").to_string();
            // Skip HEAD references like "origin/HEAD"
            if name.ends_with("/HEAD") {
                continue;
            }
            branches.push(BranchInfo {
                name,
                is_current: false,
                is_remote: true,
                upstream: None,
            });
        }
    }

    Ok(branches)
}
