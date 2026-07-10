use tauri::State;

use crate::ProjectRoot;
use crate::get_project_root;

#[derive(serde::Serialize, Debug)]
pub struct GitStatusEntry {
    pub path: String,
    pub status: String, // "modified", "added", "deleted", "renamed", "untracked", "conflict"
}

#[derive(serde::Serialize, Debug)]
pub struct GitDiffResult {
    pub diff_text: String,
    pub additions: usize,
    pub deletions: usize,
}

#[tauri::command]
pub fn git_status(state: State<ProjectRoot>) -> Result<Vec<GitStatusEntry>, String> {
    let root = get_project_root(&state)?;
    let repo = git2::Repository::open(&root).map_err(|e| format!("Not a git repo: {}", e))?;
    let statuses = repo.statuses(None).map_err(|e| e.to_string())?;

    let mut entries = Vec::new();
    for entry in statuses.iter() {
        let path = entry.path().unwrap_or("").to_string();
        let st = entry.status();
        let status_str = if st.contains(git2::Status::CONFLICTED) {
            "conflict"
        } else if st.contains(git2::Status::WT_NEW) || st.contains(git2::Status::INDEX_NEW) {
            if st.contains(git2::Status::INDEX_NEW) { "added" } else { "untracked" }
        } else if st.contains(git2::Status::WT_DELETED) || st.contains(git2::Status::INDEX_DELETED) {
            "deleted"
        } else if st.contains(git2::Status::WT_RENAMED) || st.contains(git2::Status::INDEX_RENAMED) {
            "renamed"
        } else if st.contains(git2::Status::WT_MODIFIED) || st.contains(git2::Status::INDEX_MODIFIED) {
            "modified"
        } else {
            continue; // skip clean files
        };
        entries.push(GitStatusEntry { path, status: status_str.to_string() });
    }
    Ok(entries)
}

#[tauri::command]
pub fn git_diff_file(path: String, state: State<ProjectRoot>) -> Result<GitDiffResult, String> {
    let root = get_project_root(&state)?;
    let repo = git2::Repository::open(&root).map_err(|e| format!("Not a git repo: {}", e))?;

    let mut diff_opts = git2::DiffOptions::new();
    diff_opts.pathspec(&path);
    diff_opts.context_lines(3);

    let diff = repo.diff_index_to_workdir(None, Some(&mut diff_opts))
        .map_err(|e| e.to_string())?;

    let mut diff_text = String::new();
    let mut additions = 0usize;
    let mut deletions = 0usize;

    diff.print(git2::DiffFormat::Patch, |_delta, _hunk, line| {
        match line.origin() {
            '+' => { additions += 1; diff_text.push('+'); }
            '-' => { deletions += 1; diff_text.push('-'); }
            ' ' => { diff_text.push(' '); }
            'H' | 'F' => { diff_text.push_str("@@"); }
            _ => {}
        }
        if let Ok(content) = std::str::from_utf8(line.content()) {
            diff_text.push_str(content);
        }
        true
    }).map_err(|e| e.to_string())?;

    Ok(GitDiffResult { diff_text, additions, deletions })
}

#[tauri::command]
pub fn git_log(count: usize, state: State<ProjectRoot>) -> Result<Vec<String>, String> {
    let root = get_project_root(&state)?;
    let repo = git2::Repository::open(&root).map_err(|e| format!("Not a git repo: {}", e))?;
    let mut revwalk = repo.revwalk().map_err(|e| e.to_string())?;
    revwalk.push_head().map_err(|e| e.to_string())?;
    revwalk.set_sorting(git2::Sort::TIME).map_err(|e| e.to_string())?;

    let mut logs = Vec::new();
    for oid in revwalk.take(count).filter_map(|r| r.ok()) {
        if let Ok(commit) = repo.find_commit(oid) {
            let msg = commit.summary().unwrap_or("").to_string();
            let short_id = &oid.to_string()[..7];
            logs.push(format!("{} {}", short_id, msg));
        }
    }
    Ok(logs)
}

#[tauri::command]
pub fn git_branch(state: State<ProjectRoot>) -> Result<String, String> {
    let root = get_project_root(&state)?;
    let repo = git2::Repository::open(&root).map_err(|e| format!("Not a git repo: {}", e))?;
    let head = repo.head().map_err(|e| e.to_string())?;
    Ok(head.shorthand().unwrap_or("HEAD").to_string())
}


// ─── Git Blame ──────────────────────────────────────────────────────────────────

#[derive(serde::Serialize, Debug)]
pub struct BlameLine {
    pub line: usize,
    pub commit_id: String,
    pub author: String,
    pub date: String,
    pub summary: String,
}

#[tauri::command]
pub fn git_blame_file(path: String, state: State<ProjectRoot>) -> Result<Vec<BlameLine>, String> {
    let root = get_project_root(&state)?;
    let repo = git2::Repository::open(&root).map_err(|e| format!("Not a git repo: {}", e))?;

    let blame = repo.blame_file(std::path::Path::new(&path), None)
        .map_err(|e| format!("Blame failed: {}", e))?;

    let mut results = Vec::new();
    for i in 0..blame.len() {
        if let Some(hunk) = blame.get_index(i) {
            let sig = hunk.final_signature();
            let commit_id = hunk.final_commit_id().to_string();
            let short_id = if commit_id.len() >= 7 { commit_id[..7].to_string() } else { commit_id.clone() };
            let author = sig.name().unwrap_or("unknown").to_string();
            let epoch = sig.when().seconds();
            // Format epoch as YYYY-MM-DD
            let date = format_epoch(epoch);

            // Get commit summary
            let summary = repo.find_commit(hunk.final_commit_id())
                .ok()
                .and_then(|c| c.summary().map(|s| s.to_string()))
                .unwrap_or_default();

            let start_line = hunk.final_start_line();
            let lines_in_hunk = hunk.lines_in_hunk();

            for line_offset in 0..lines_in_hunk {
                results.push(BlameLine {
                    line: start_line + line_offset,
                    commit_id: short_id.clone(),
                    author: author.clone(),
                    date: date.clone(),
                    summary: summary.clone(),
                });
            }
        }
    }

    // Deduplicate — blame hunks can overlap in iteration
    results.sort_by_key(|b| b.line);
    results.dedup_by_key(|b| b.line);

    Ok(results)
}

fn format_epoch(epoch: i64) -> String {
    // Simple epoch to YYYY-MM-DD conversion
    let days_since_epoch = epoch / 86400;
    let mut y = 1970i64;
    let mut remaining = days_since_epoch;

    loop {
        let days_in_year = if is_leap(y) { 366 } else { 365 };
        if remaining < days_in_year {
            break;
        }
        remaining -= days_in_year;
        y += 1;
    }

    let months = if is_leap(y) {
        [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
    } else {
        [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
    };

    let mut m = 1u32;
    for &days_in_month in &months {
        if remaining < days_in_month {
            break;
        }
        remaining -= days_in_month;
        m += 1;
    }

    let d = remaining + 1;
    format!("{:04}-{:02}-{:02}", y, m, d)
}

fn is_leap(y: i64) -> bool {
    (y % 4 == 0 && y % 100 != 0) || (y % 400 == 0)
}

// ─── Branch List / Create / Switch ──────────────────────────────────────────────

#[derive(serde::Serialize, Debug)]
pub struct GitBranchInfo {
    pub name: String,
    pub is_current: bool,
    pub is_remote: bool,
}

#[tauri::command]
pub fn git_branch_list(state: State<ProjectRoot>) -> Result<Vec<GitBranchInfo>, String> {
    let root = get_project_root(&state)?;
    let repo = git2::Repository::open(&root).map_err(|e| format!("Not a git repo: {}", e))?;

    let branches = repo.branches(None).map_err(|e| e.to_string())?;
    let head = repo.head().ok();
    let current_branch = head.as_ref().and_then(|h| h.shorthand().map(|s| s.to_string()));

    let mut result = Vec::new();
    for branch_result in branches {
        let (branch, branch_type) = branch_result.map_err(|e| e.to_string())?;
        if let Some(name) = branch.name().map_err(|e| e.to_string())? {
            let is_remote = branch_type == git2::BranchType::Remote;
            let is_current = !is_remote && current_branch.as_deref() == Some(name);
            result.push(GitBranchInfo {
                name: name.to_string(),
                is_current,
                is_remote,
            });
        }
    }

    // Sort: current first, then local, then remote
    result.sort_by(|a, b| {
        if a.is_current && !b.is_current { return std::cmp::Ordering::Less; }
        if !a.is_current && b.is_current { return std::cmp::Ordering::Greater; }
        if !a.is_remote && b.is_remote { return std::cmp::Ordering::Less; }
        if a.is_remote && !b.is_remote { return std::cmp::Ordering::Greater; }
        a.name.cmp(&b.name)
    });

    Ok(result)
}

#[tauri::command]
pub fn git_branch_create(name: String, state: State<ProjectRoot>) -> Result<String, String> {
    let root = get_project_root(&state)?;
    let repo = git2::Repository::open(&root).map_err(|e| format!("Not a git repo: {}", e))?;

    // Get current HEAD commit
    let head = repo.head().map_err(|e| format!("No HEAD: {}", e))?;
    let commit = head.peel_to_commit().map_err(|e| format!("HEAD not a commit: {}", e))?;

    // Create the branch
    repo.branch(&name, &commit, false)
        .map_err(|e| format!("Failed to create branch: {}", e))?;

    Ok(format!("Branch '{}' created", name))
}

#[tauri::command]
pub fn git_branch_switch(name: String, state: State<ProjectRoot>) -> Result<String, String> {
    let root = get_project_root(&state)?;
    let repo = git2::Repository::open(&root).map_err(|e| format!("Not a git repo: {}", e))?;

    // Resolve the branch reference
    let refname = format!("refs/heads/{}", name);
    let reference = repo.find_reference(&refname)
        .map_err(|e| format!("Branch '{}' not found: {}", name, e))?;

    // Set HEAD to the branch
    repo.set_head(&refname)
        .map_err(|e| format!("Failed to switch: {}", e))?;

    // Checkout the tree
    let obj = reference.peel(git2::ObjectType::Tree)
        .map_err(|e| format!("Failed to peel: {}", e))?;

    let mut checkout_opts = git2::build::CheckoutBuilder::new();
    checkout_opts.safe(); // Don't overwrite uncommitted changes

    repo.checkout_tree(&obj, Some(&mut checkout_opts))
        .map_err(|e| format!("Checkout failed (uncommitted changes?): {}", e))?;

    Ok(format!("Switched to branch '{}'", name))
}

// ─── Git Stash ──────────────────────────────────────────────────────────────────

#[derive(serde::Serialize, Debug)]
pub struct GitStashEntry {
    pub index: usize,
    pub message: String,
}

#[tauri::command]
pub fn git_stash_list(state: State<ProjectRoot>) -> Result<Vec<GitStashEntry>, String> {
    let root = get_project_root(&state)?;
    let mut repo = git2::Repository::open(&root).map_err(|e| format!("Not a git repo: {}", e))?;

    let mut stashes = Vec::new();
    repo.stash_foreach(|index, message, _oid| {
        stashes.push(GitStashEntry {
            index,
            message: message.to_string(),
        });
        true
    }).map_err(|e| e.to_string())?;

    Ok(stashes)
}

#[tauri::command]
pub fn git_stash_save(message: Option<String>, state: State<ProjectRoot>) -> Result<String, String> {
    let root = get_project_root(&state)?;
    let mut repo = git2::Repository::open(&root).map_err(|e| format!("Not a git repo: {}", e))?;

    let sig = repo.signature().map_err(|e| format!("No git identity configured: {}", e))?;
    let msg = message.as_deref().unwrap_or("WIP");

    repo.stash_save(&sig, msg, Some(git2::StashFlags::DEFAULT))
        .map_err(|e| format!("Stash failed: {}", e))?;

    Ok(format!("Stashed: {}", msg))
}

#[tauri::command]
pub fn git_stash_pop(index: usize, state: State<ProjectRoot>) -> Result<String, String> {
    let root = get_project_root(&state)?;
    let mut repo = git2::Repository::open(&root).map_err(|e| format!("Not a git repo: {}", e))?;

    let mut opts = git2::StashApplyOptions::new();
    let mut checkout = git2::build::CheckoutBuilder::new();
    checkout.safe();
    opts.checkout_options(checkout);

    repo.stash_pop(index, Some(&mut opts))
        .map_err(|e| format!("Stash pop failed: {}", e))?;

    Ok("Stash applied and removed".to_string())
}

#[tauri::command]
pub fn git_stash_drop(index: usize, state: State<ProjectRoot>) -> Result<String, String> {
    let root = get_project_root(&state)?;
    let mut repo = git2::Repository::open(&root).map_err(|e| format!("Not a git repo: {}", e))?;

    repo.stash_drop(index)
        .map_err(|e| format!("Stash drop failed: {}", e))?;

    Ok(format!("Stash @{{{}}} dropped", index))
}
