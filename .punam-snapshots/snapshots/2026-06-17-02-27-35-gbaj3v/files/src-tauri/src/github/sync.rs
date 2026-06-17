//! GitHub Sync — push, pull, fetch operations.
//! Phase 3 implementation.
//!
//! These commands use shell git for push/pull/fetch because git2's
//! transport layer requires complex credential callback setup.
//! The safety layer (Phase 6) is called from the frontend before these.

use serde::{Deserialize, Serialize};
use tauri::State;
use crate::ProjectRoot;
use std::process::Command;

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

// ─── Result Types ─────────────────────────────────────────────────────────────

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct PushResult {
    pub success: bool,
    pub message: String,
    pub branch: Option<String>,
    pub remote: String,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct PullResult {
    pub success: bool,
    pub message: String,
    pub files_changed: usize,
    pub insertions: usize,
    pub deletions: usize,
    pub conflicts: Vec<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct FetchResult {
    pub success: bool,
    pub message: String,
    pub updates: Vec<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct StashResult {
    pub success: bool,
    pub message: String,
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

fn get_project_root(state: &State<ProjectRoot>) -> Result<String, String> {
    let lock = state.0.lock().map_err(|e| format!("Lock error: {}", e))?;
    lock.clone().ok_or_else(|| "No project root set".to_string())
}

fn run_git_command(args: &[&str], cwd: &str) -> Result<(String, String, i32), String> {
    let mut cmd = Command::new("git");
    cmd.args(args).current_dir(cwd);

    #[cfg(target_os = "windows")]
    cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW

    let output = cmd.output().map_err(|e| format!("Failed to run git: {}", e))?;
    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();
    let code = output.status.code().unwrap_or(-1);

    Ok((stdout, stderr, code))
}

// ─── Commands ─────────────────────────────────────────────────────────────────

/// Push to remote. Supports force push and branch specification.
/// Safety checks should be done BEFORE calling this (from frontend).
#[tauri::command]
pub fn github_push(
    force: bool,
    set_upstream: bool,
    branch: Option<String>,
    remote: Option<String>,
    state: State<'_, ProjectRoot>,
) -> Result<PushResult, String> {
    let root = get_project_root(&state)?;
    let remote_name = remote.unwrap_or_else(|| "origin".to_string());

    // Build push command
    let mut args: Vec<&str> = vec!["push"];
    if force {
        args.push("--force-with-lease"); // safer than --force
    }
    if set_upstream {
        args.push("-u");
    }
    args.push(&remote_name);

    let branch_str;
    if let Some(ref b) = branch {
        branch_str = b.clone();
        args.push(&branch_str);
    }

    let (stdout, stderr, code) = run_git_command(&args, &root)?;
    let output = format!("{}{}", stdout, stderr).trim().to_string();

    if code == 0 {
        Ok(PushResult {
            success: true,
            message: if output.is_empty() { "Push successful".to_string() } else { output },
            branch,
            remote: remote_name,
        })
    } else {
        Err(format!("Push failed: {}", output))
    }
}

/// Pull from remote with optional rebase.
/// Safety snapshot should be created BEFORE calling this (from frontend).
#[tauri::command]
pub fn github_pull(
    rebase: bool,
    branch: Option<String>,
    remote: Option<String>,
    state: State<'_, ProjectRoot>,
) -> Result<PullResult, String> {
    let root = get_project_root(&state)?;
    let remote_name = remote.unwrap_or_else(|| "origin".to_string());

    let mut args: Vec<&str> = vec!["pull"];
    if rebase {
        args.push("--rebase");
    }
    args.push(&remote_name);

    let branch_str;
    if let Some(ref b) = branch {
        branch_str = b.clone();
        args.push(&branch_str);
    }

    let (stdout, stderr, code) = run_git_command(&args, &root)?;
    let output = format!("{}{}", stdout, stderr);

    if code == 0 {
        // Parse stats from output
        let (files_changed, insertions, deletions) = parse_pull_stats(&output);
        Ok(PullResult {
            success: true,
            message: output.trim().to_string(),
            files_changed,
            insertions,
            deletions,
            conflicts: Vec::new(),
        })
    } else {
        // Check for merge conflicts
        let conflicts = detect_conflicts(&root);
        if !conflicts.is_empty() {
            Ok(PullResult {
                success: false,
                message: "Pull resulted in merge conflicts".to_string(),
                files_changed: 0,
                insertions: 0,
                deletions: 0,
                conflicts,
            })
        } else {
            Err(format!("Pull failed: {}", output.trim()))
        }
    }
}

/// Fetch from remote (updates tracking info without modifying working tree).
#[tauri::command]
pub fn github_fetch(
    remote: Option<String>,
    prune: bool,
    state: State<'_, ProjectRoot>,
) -> Result<FetchResult, String> {
    let root = get_project_root(&state)?;
    let remote_name = remote.unwrap_or_else(|| "origin".to_string());

    let mut args: Vec<&str> = vec!["fetch"];
    if prune {
        args.push("--prune");
    }
    args.push(&remote_name);

    let (stdout, stderr, code) = run_git_command(&args, &root)?;
    let output = format!("{}{}", stdout, stderr).trim().to_string();

    if code == 0 {
        // Parse fetch updates from stderr (git fetch outputs to stderr)
        let updates: Vec<String> = output
            .lines()
            .filter(|l| l.contains("->") || l.contains("new branch") || l.contains("new tag"))
            .map(|l| l.trim().to_string())
            .collect();

        Ok(FetchResult {
            success: true,
            message: if output.is_empty() { "Fetch complete — no updates".to_string() } else { output },
            updates,
        })
    } else {
        Err(format!("Fetch failed: {}", output))
    }
}

/// Stash current changes (useful before pull/rebase).
#[tauri::command]
pub fn github_stash(
    message: Option<String>,
    state: State<'_, ProjectRoot>,
) -> Result<StashResult, String> {
    let root = get_project_root(&state)?;

    let msg_str;
    let args: Vec<&str> = if let Some(ref m) = message {
        msg_str = m.clone();
        vec!["stash", "push", "-m", &msg_str]
    } else {
        vec!["stash", "push"]
    };

    let (stdout, stderr, code) = run_git_command(&args, &root)?;
    let output = format!("{}{}", stdout, stderr).trim().to_string();

    if code == 0 {
        Ok(StashResult {
            success: true,
            message: output,
        })
    } else {
        Err(format!("Stash failed: {}", output))
    }
}

/// Pop the most recent stash.
#[tauri::command]
pub fn github_stash_pop(state: State<'_, ProjectRoot>) -> Result<StashResult, String> {
    let root = get_project_root(&state)?;
    let (stdout, stderr, code) = run_git_command(&["stash", "pop"], &root)?;
    let output = format!("{}{}", stdout, stderr).trim().to_string();

    if code == 0 {
        Ok(StashResult {
            success: true,
            message: output,
        })
    } else {
        Err(format!("Stash pop failed: {}", output))
    }
}

/// Create a new branch and optionally switch to it.
#[tauri::command]
pub fn github_create_branch(
    name: String,
    checkout: bool,
    state: State<'_, ProjectRoot>,
) -> Result<(), String> {
    let root = get_project_root(&state)?;

    if checkout {
        let (_, stderr, code) = run_git_command(&["checkout", "-b", &name], &root)?;
        if code != 0 {
            return Err(format!("Failed to create branch: {}", stderr.trim()));
        }
    } else {
        let (_, stderr, code) = run_git_command(&["branch", &name], &root)?;
        if code != 0 {
            return Err(format!("Failed to create branch: {}", stderr.trim()));
        }
    }

    Ok(())
}

/// Switch to an existing branch.
#[tauri::command]
pub fn github_switch_branch(
    name: String,
    state: State<'_, ProjectRoot>,
) -> Result<(), String> {
    let root = get_project_root(&state)?;
    let (_, stderr, code) = run_git_command(&["checkout", &name], &root)?;
    if code != 0 {
        return Err(format!("Failed to switch branch: {}", stderr.trim()));
    }
    Ok(())
}

/// Delete a branch (local or remote).
#[tauri::command]
pub fn github_delete_branch(
    name: String,
    remote: bool,
    force: bool,
    state: State<'_, ProjectRoot>,
) -> Result<(), String> {
    let root = get_project_root(&state)?;

    if remote {
        let refspec = format!(":{}", name);
        let (_, stderr, code) = run_git_command(&["push", "origin", "--delete", &name], &root)?;
        if code != 0 {
            return Err(format!("Failed to delete remote branch: {}", stderr.trim()));
        }
    } else {
        let flag = if force { "-D" } else { "-d" };
        let (_, stderr, code) = run_git_command(&["branch", flag, &name], &root)?;
        if code != 0 {
            return Err(format!("Failed to delete branch: {}", stderr.trim()));
        }
    }

    Ok(())
}

/// Abort a merge in progress.
#[tauri::command]
pub fn github_merge_abort(state: State<'_, ProjectRoot>) -> Result<(), String> {
    let root = get_project_root(&state)?;
    let (_, stderr, code) = run_git_command(&["merge", "--abort"], &root)?;
    if code != 0 {
        return Err(format!("Failed to abort merge: {}", stderr.trim()));
    }
    Ok(())
}

// ─── Parsing Helpers ──────────────────────────────────────────────────────────

fn parse_pull_stats(output: &str) -> (usize, usize, usize) {
    // Parse "X files changed, Y insertions(+), Z deletions(-)"
    let mut files = 0;
    let mut ins = 0;
    let mut del = 0;

    for line in output.lines() {
        if line.contains("file") && line.contains("changed") {
            // "3 files changed, 10 insertions(+), 5 deletions(-)"
            for part in line.split(',') {
                let part = part.trim();
                if part.contains("file") {
                    files = part.split_whitespace().next()
                        .and_then(|n| n.parse().ok())
                        .unwrap_or(0);
                } else if part.contains("insertion") {
                    ins = part.split_whitespace().next()
                        .and_then(|n| n.parse().ok())
                        .unwrap_or(0);
                } else if part.contains("deletion") {
                    del = part.split_whitespace().next()
                        .and_then(|n| n.parse().ok())
                        .unwrap_or(0);
                }
            }
        }
    }

    (files, ins, del)
}

fn detect_conflicts(root: &str) -> Vec<String> {
    // Use git2 to detect conflicted files
    match git2::Repository::open(root) {
        Ok(repo) => {
            let mut opts = git2::StatusOptions::new();
            opts.include_untracked(false);
            match repo.statuses(Some(&mut opts)) {
                Ok(statuses) => {
                    statuses.iter()
                        .filter(|entry| entry.status().contains(git2::Status::CONFLICTED))
                        .filter_map(|entry| entry.path().map(|p| p.to_string()))
                        .collect()
                }
                Err(_) => Vec::new(),
            }
        }
        Err(_) => Vec::new(),
    }
}
