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