//! GitHub Safety Layer — pre-operation checks, auto-snapshots, rollback.
//! Phase 6 implementation.
//!
//! Every dangerous operation (push, pull, merge, rebase, force-push) goes through
//! this layer first. It:
//! 1. Checks preconditions (dirty files, remote state, etc.)
//! 2. Creates an auto-snapshot before the operation
//! 3. Provides rollback if the operation fails

use serde::{Deserialize, Serialize};
use tauri::State;
use crate::ProjectRoot;
use super::types::PrePushStatus;
use std::sync::Mutex;

// ─── Safety Check Results ─────────────────────────────────────────────────────

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct PrePullStatus {
    pub dirty_files: Vec<String>,
    pub has_remote: bool,
    pub has_upstream: bool,
    pub current_branch: Option<String>,
    pub behind: usize,
    /// Whether it's safe to pull (no dirty files that would conflict).
    pub safe_to_pull: bool,
    /// Human-readable warnings.
    pub warnings: Vec<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct SafetySnapshot {
    pub id: String,
    pub reason: String,
    pub created_at: String,
    pub files: usize,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct DryRunPushResult {
    pub current_branch: Option<String>,
    pub remote: Option<String>,
    pub ahead: usize,
    pub commits_to_push: Vec<String>,
    pub would_create_remote_branch: bool,
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

fn get_project_root(state: &State<ProjectRoot>) -> Result<String, String> {
    let lock = state.0.lock().map_err(|e| format!("Lock error: {}", e))?;
    lock.clone().ok_or_else(|| "No project root set".to_string())
}

fn open_repo(root: &str) -> Result<git2::Repository, String> {
    git2::Repository::open(root).map_err(|e| format!("Not a git repository: {}", e))
}

fn get_dirty_files(repo: &git2::Repository) -> Vec<String> {
    let mut opts = git2::StatusOptions::new();
    opts.include_untracked(true).recurse_untracked_dirs(true);
    let statuses = match repo.statuses(Some(&mut opts)) {
        Ok(s) => s,
        Err(_) => return Vec::new(),
    };
    statuses
        .iter()
        .filter_map(|entry| {
            if entry.status() == git2::Status::CURRENT {
                return None;
            }
            entry.path().map(|p| p.to_string())
        })
        .take(100)
        .collect()
}

fn get_current_branch(repo: &git2::Repository) -> Option<String> {
    repo.head().ok().and_then(|h| {
        if h.is_branch() {
            h.shorthand().map(|s| s.to_string())
        } else {
            None
        }
    })
}

fn get_ahead_behind(repo: &git2::Repository) -> (usize, usize) {
    let head_oid = match repo.head().ok().and_then(|h| h.target()) {
        Some(oid) => oid,
        None => return (0, 0),
    };
    let upstream_oid = match repo.head().ok().and_then(|h| {
        let branch_name = h.shorthand()?.to_string();
        let branch = repo.find_branch(&branch_name, git2::BranchType::Local).ok()?;
        let upstream = branch.upstream().ok()?;
        upstream.get().target()
    }) {
        Some(oid) => oid,
        None => return (0, 0),
    };
    repo.graph_ahead_behind(head_oid, upstream_oid).unwrap_or((0, 0))
}

fn has_remote(repo: &git2::Repository, name: &str) -> bool {
    repo.find_remote(name).is_ok()
}

fn has_upstream(repo: &git2::Repository) -> bool {
    repo.head().ok().and_then(|h| {
        let branch_name = h.shorthand()?.to_string();
        let branch = repo.find_branch(&branch_name, git2::BranchType::Local).ok()?;
        branch.upstream().ok()
    }).is_some()
}

fn get_commits_ahead(repo: &git2::Repository, count: usize) -> Vec<String> {
    let head_oid = match repo.head().ok().and_then(|h| h.target()) {
        Some(oid) => oid,
        None => return Vec::new(),
    };

    let upstream_oid = match repo.head().ok().and_then(|h| {
        let branch_name = h.shorthand()?.to_string();
        let branch = repo.find_branch(&branch_name, git2::BranchType::Local).ok()?;
        let upstream = branch.upstream().ok()?;
        upstream.get().target()
    }) {
        Some(oid) => oid,
        None => {
            // No upstream — show last N commits
            let mut revwalk = match repo.revwalk() {
                Ok(r) => r,
                Err(_) => return Vec::new(),
            };
            revwalk.push(head_oid).ok();
            revwalk.set_sorting(git2::Sort::TIME).ok();
            return revwalk
                .take(count)
                .filter_map(|r| r.ok())
                .filter_map(|oid| {
                    let commit = repo.find_commit(oid).ok()?;
                    let msg = commit.summary().unwrap_or("").to_string();
                    Some(format!("{} {}", &oid.to_string()[..7], msg))
                })
                .collect();
        }
    };

    // Walk from HEAD to upstream
    let mut revwalk = match repo.revwalk() {
        Ok(r) => r,
        Err(_) => return Vec::new(),
    };
    revwalk.push(head_oid).ok();
    revwalk.hide(upstream_oid).ok();
    revwalk.set_sorting(git2::Sort::TIME).ok();

    revwalk
        .take(count)
        .filter_map(|r| r.ok())
        .filter_map(|oid| {
            let commit = repo.find_commit(oid).ok()?;
            let msg = commit.summary().unwrap_or("").to_string();
            Some(format!("{} {}", &oid.to_string()[..7], msg))
        })
        .collect()
}

// ─── Commands ─────────────────────────────────────────────────────────────────

/// Pre-push safety check. Returns status with warnings.
#[tauri::command]
pub fn github_pre_push_check(state: State<'_, ProjectRoot>) -> Result<PrePushStatus, String> {
    let root = get_project_root(&state)?;
    let repo = open_repo(&root)?;

    let dirty = get_dirty_files(&repo);
    let branch = get_current_branch(&repo);
    let (ahead, behind) = get_ahead_behind(&repo);
    let remote_exists = has_remote(&repo, "origin");
    let upstream_exists = has_upstream(&repo);

    let mut warnings = Vec::new();
    let mut safe = true;

    if !dirty.is_empty() {
        warnings.push(format!("{} uncommitted file(s). Commit or stash before pushing.", dirty.len()));
        safe = false;
    }
    if !remote_exists {
        warnings.push("No remote 'origin' configured. Link a repository first.".to_string());
        safe = false;
    }
    if behind > 0 {
        warnings.push(format!("Branch is {} commit(s) behind remote. Pull first to avoid conflicts.", behind));
        safe = false;
    }
    if ahead == 0 && upstream_exists {
        warnings.push("Nothing to push — already up to date with remote.".to_string());
        safe = false;
    }

    Ok(PrePushStatus {
        dirty_files: dirty,
        ahead,
        behind,
        has_remote: remote_exists,
        has_upstream: upstream_exists,
        current_branch: branch,
        safe_to_push: safe,
        warnings,
    })
}

/// Pre-pull safety check.
#[tauri::command]
pub fn github_pre_pull_check(state: State<'_, ProjectRoot>) -> Result<PrePullStatus, String> {
    let root = get_project_root(&state)?;
    let repo = open_repo(&root)?;

    let dirty = get_dirty_files(&repo);
    let branch = get_current_branch(&repo);
    let (_, behind) = get_ahead_behind(&repo);
    let remote_exists = has_remote(&repo, "origin");
    let upstream_exists = has_upstream(&repo);

    let mut warnings = Vec::new();
    let mut safe = true;

    if !dirty.is_empty() {
        warnings.push(format!("{} uncommitted file(s). These may conflict during pull. Consider committing or stashing first.", dirty.len()));
        // Not blocking — git pull can work with dirty files if no conflicts
    }
    if !remote_exists {
        warnings.push("No remote 'origin' configured.".to_string());
        safe = false;
    }
    if !upstream_exists {
        warnings.push("No upstream tracking branch configured.".to_string());
        safe = false;
    }
    if behind == 0 && upstream_exists {
        warnings.push("Already up to date — nothing to pull.".to_string());
    }

    Ok(PrePullStatus {
        dirty_files: dirty,
        has_remote: remote_exists,
        has_upstream: upstream_exists,
        current_branch: branch,
        behind,
        safe_to_pull: safe,
        warnings,
    })
}

/// Dry-run push preview — shows what would be pushed without actually pushing.
#[tauri::command]
pub fn github_dry_run_push(state: State<'_, ProjectRoot>) -> Result<DryRunPushResult, String> {
    let root = get_project_root(&state)?;
    let repo = open_repo(&root)?;

    let branch = get_current_branch(&repo);
    let (ahead, _) = get_ahead_behind(&repo);
    let remote_url = repo.find_remote("origin")
        .ok()
        .and_then(|r| r.url().map(|u| u.to_string()));
    let upstream_exists = has_upstream(&repo);
    let commits = get_commits_ahead(&repo, 20);

    Ok(DryRunPushResult {
        current_branch: branch,
        remote: remote_url,
        ahead,
        commits_to_push: commits,
        would_create_remote_branch: !upstream_exists,
    })
}

/// Create a safety snapshot before a dangerous operation.
/// Uses the existing snapshot system with a special "safety" reason tag.
#[tauri::command]
pub fn github_create_safety_snapshot(
    reason: String,
    state: State<'_, ProjectRoot>,
) -> Result<SafetySnapshot, String> {
    let root = get_project_root(&state)?;
    let root_path = std::path::Path::new(&root);

    // Use the existing snapshot infrastructure
    let timestamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    let id = format!("safety-{}-{}", reason.replace(' ', "-").to_lowercase(), timestamp);
    let name = format!("Safety: {}", reason);

    // Create snapshot directory
    let backup_dir = root_path.join(".punam-backups").join(&id);
    std::fs::create_dir_all(&backup_dir)
        .map_err(|e| format!("Failed to create snapshot dir: {}", e))?;

    // Copy tracked files (skip node_modules, dist, target, .git, .punam-backups)
    let skip_dirs: Vec<&str> = vec![
        "node_modules", "dist", "dist-ssr", ".git", ".punam-backups",
        "target", "build", ".next", "__pycache__", ".venv",
    ];

    let mut file_count = 0usize;
    for entry in walkdir::WalkDir::new(&root)
        .into_iter()
        .filter_entry(|e| {
            let name = e.file_name().to_string_lossy();
            !skip_dirs.iter().any(|s| name == *s)
        })
        .filter_map(|e| e.ok())
    {
        if entry.file_type().is_file() {
            let rel = entry.path().strip_prefix(&root).unwrap_or(entry.path());
            let dest = backup_dir.join(rel);
            if let Some(parent) = dest.parent() {
                std::fs::create_dir_all(parent).ok();
            }
            if std::fs::copy(entry.path(), &dest).is_ok() {
                file_count += 1;
            }
        }
    }

    // Write manifest
    let manifest = serde_json::json!({
        "id": id,
        "name": name,
        "reason": reason,
        "createdAt": chrono_like_timestamp(),
        "files": file_count,
        "punamVersion": "2.0",
        "type": "safety"
    });
    let manifest_path = backup_dir.join("manifest.json");
    std::fs::write(&manifest_path, serde_json::to_string_pretty(&manifest).unwrap_or_default())
        .map_err(|e| format!("Failed to write manifest: {}", e))?;

    Ok(SafetySnapshot {
        id,
        reason,
        created_at: chrono_like_timestamp(),
        files: file_count,
    })
}

/// Rollback to a safety snapshot (restore files from snapshot).
#[tauri::command]
pub fn github_rollback_to_snapshot(
    snapshot_id: String,
    state: State<'_, ProjectRoot>,
) -> Result<usize, String> {
    let root = get_project_root(&state)?;
    let root_path = std::path::Path::new(&root);
    let backup_dir = root_path.join(".punam-backups").join(&snapshot_id);

    if !backup_dir.exists() {
        return Err(format!("Snapshot '{}' not found", snapshot_id));
    }

    // Restore files from snapshot to project root
    let skip_dirs: Vec<&str> = vec!["node_modules", ".git", ".punam-backups"];
    let mut restored = 0usize;

    for entry in walkdir::WalkDir::new(&backup_dir)
        .into_iter()
        .filter_entry(|e| {
            let name = e.file_name().to_string_lossy();
            name != "manifest.json" && !skip_dirs.iter().any(|s| name == *s)
        })
        .filter_map(|e| e.ok())
    {
        if entry.file_type().is_file() {
            let rel = entry.path().strip_prefix(&backup_dir).unwrap_or(entry.path());
            let dest = root_path.join(rel);
            if let Some(parent) = dest.parent() {
                std::fs::create_dir_all(parent).ok();
            }
            if std::fs::copy(entry.path(), &dest).is_ok() {
                restored += 1;
            }
        }
    }

    Ok(restored)
}

/// List all safety snapshots for the current project.
#[tauri::command]
pub fn github_list_safety_snapshots(state: State<'_, ProjectRoot>) -> Result<Vec<SafetySnapshot>, String> {
    let root = get_project_root(&state)?;
    let backup_dir = std::path::Path::new(&root).join(".punam-backups");

    if !backup_dir.exists() {
        return Ok(Vec::new());
    }

    let mut snapshots = Vec::new();
    let entries = std::fs::read_dir(&backup_dir).map_err(|e| e.to_string())?;

    for entry in entries.filter_map(|e| e.ok()) {
        let path = entry.path();
        if !path.is_dir() { continue; }

        let dir_name = path.file_name().unwrap_or_default().to_string_lossy().to_string();
        if !dir_name.starts_with("safety-") { continue; }

        let manifest_path = path.join("manifest.json");
        if let Ok(content) = std::fs::read_to_string(&manifest_path) {
            if let Ok(manifest) = serde_json::from_str::<serde_json::Value>(&content) {
                snapshots.push(SafetySnapshot {
                    id: manifest["id"].as_str().unwrap_or(&dir_name).to_string(),
                    reason: manifest["reason"].as_str().unwrap_or("").to_string(),
                    created_at: manifest["createdAt"].as_str().unwrap_or("").to_string(),
                    files: manifest["files"].as_u64().unwrap_or(0) as usize,
                });
            }
        }
    }

    // Sort by created_at descending (newest first)
    snapshots.sort_by(|a, b| b.created_at.cmp(&a.created_at));
    Ok(snapshots)
}

/// Delete a safety snapshot.
#[tauri::command]
pub fn github_delete_safety_snapshot(
    snapshot_id: String,
    state: State<'_, ProjectRoot>,
) -> Result<(), String> {
    let root = get_project_root(&state)?;
    let backup_dir = std::path::Path::new(&root).join(".punam-backups").join(&snapshot_id);

    if !backup_dir.exists() {
        return Err(format!("Snapshot '{}' not found", snapshot_id));
    }

    std::fs::remove_dir_all(&backup_dir)
        .map_err(|e| format!("Failed to delete snapshot: {}", e))?;

    Ok(())
}

// ─── Utility ──────────────────────────────────────────────────────────────────

fn chrono_like_timestamp() -> String {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default();
    let secs = now.as_secs();
    // Simple ISO-like timestamp without chrono dependency
    // Format: 2024-01-15T10:30:00Z (approximate)
    let days = secs / 86400;
    let time_of_day = secs % 86400;
    let hours = time_of_day / 3600;
    let minutes = (time_of_day % 3600) / 60;
    let seconds = time_of_day % 60;

    // Approximate date calculation (good enough for sorting)
    let years_since_epoch = days / 365;
    let year = 1970 + years_since_epoch;
    let remaining_days = days - (years_since_epoch * 365) - (years_since_epoch / 4); // leap year approx
    let month = (remaining_days / 30).min(11) + 1;
    let day = (remaining_days % 30) + 1;

    format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}Z",
        year, month, day, hours, minutes, seconds
    )
}
