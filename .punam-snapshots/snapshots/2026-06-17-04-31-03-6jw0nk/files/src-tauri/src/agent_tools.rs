// src-tauri/src/agent_tools.rs
//
// Phase 1 agent tool commands: read_lines + apply_patch
// Phase 3: apply_multi_patch — atomic multi-file editing with rollback

use serde::{Deserialize, Serialize};
use std::fs;
use std::path::Path;
use tauri::State;

use crate::{validate_path_within_project, get_project_root, ProjectRoot};

// ── Shared return types ───────────────────────────────────────────────────────

#[derive(Serialize, Debug)]
pub struct ReadLinesResult {
    pub path: String,
    pub start_line: usize,
    pub end_line: usize,
    pub total_lines: usize,
    pub content: String,
}

#[derive(Deserialize, Debug, Clone)]
pub struct PatchHunk {
    pub start_line: usize,
    pub end_line: usize,
    pub new_content: String,
}

#[derive(Serialize, Debug)]
pub struct ApplyPatchResult {
    pub path: String,
    pub lines_replaced: usize,
    pub new_total_lines: usize,
}

// ── Multi-patch types ─────────────────────────────────────────────────────────

#[derive(Deserialize, Debug)]
pub struct MultiPatchRequest {
    pub patches: Vec<MultiPatchFileEntry>,
}

#[derive(Deserialize, Debug)]
pub struct MultiPatchFileEntry {
    pub path: String,
    pub hunks: Vec<PatchHunk>,
}

#[derive(Serialize, Debug)]
pub struct MultiPatchResult {
    pub success: bool,
    pub files_modified: usize,
    pub patches_applied: usize,
    pub total_patches: usize,
    pub errors: Vec<String>,
    pub file_results: Vec<ApplyPatchResult>,
}

// ── read_lines ────────────────────────────────────────────────────────────────

#[tauri::command]
pub fn read_lines(
    path: String, start_line: usize, end_line: usize, state: State<ProjectRoot>,
) -> Result<ReadLinesResult, String> {
    let root = get_project_root(&state)?;
    let safe_path = validate_path_within_project(&path, &root)?;
    let p = Path::new(&safe_path);
    if !p.is_file() { return Err(format!("Not a file: {}", path)); }
    let size = fs::metadata(p).map_err(|e| e.to_string())?.len();
    if size > 2_000_000 { return Err("File too large (>2MB)".to_string()); }
    let raw = fs::read_to_string(p).map_err(|e| format!("Failed to read: {}", e))?;
    let all_lines: Vec<&str> = raw.lines().collect();
    let total = all_lines.len();
    if total == 0 { return Ok(ReadLinesResult { path, start_line: 0, end_line: 0, total_lines: 0, content: String::new() }); }
    let start_idx = if start_line == 0 { 0 } else { (start_line - 1).min(total - 1) };
    let end_idx = if end_line == 0 || end_line > total { total - 1 } else { (end_line - 1).min(total - 1) };
    let end_idx = end_idx.max(start_idx);
    let slice = &all_lines[start_idx..=end_idx];
    let content = slice.iter().enumerate().map(|(i, line)| format!("{:>4} | {}", start_idx + i + 1, line)).collect::<Vec<_>>().join("\n");
    Ok(ReadLinesResult { path, start_line: start_idx + 1, end_line: end_idx + 1, total_lines: total, content })
}

// ── apply_patch (single) ─────────────────────────────────────────────────────

#[tauri::command]
pub fn apply_patch(
    path: String, hunk: PatchHunk, state: State<ProjectRoot>,
) -> Result<ApplyPatchResult, String> {
    let root = get_project_root(&state)?;
    apply_patch_impl(&path, &hunk, &root)
}

// ── apply_multi_patch (atomic multi-file editing) ─────────────────────────────

#[tauri::command]
pub fn apply_multi_patch(
    request: MultiPatchRequest, state: State<ProjectRoot>,
) -> Result<MultiPatchResult, String> {
    let root = get_project_root(&state)?;
    let mut file_results = Vec::new();
    let mut errors = Vec::new();
    let mut rollback_snapshots: Vec<(String, String)> = Vec::new();

    // Phase 1: Pre-validate and snapshot
    for entry in &request.patches {
        let safe_path = match validate_path_within_project(&entry.path, &root) {
            Ok(p) => p,
            Err(e) => {
                errors.push(format!("{}: {}", entry.path, e));
                return Ok(MultiPatchResult { success: false, files_modified: 0, patches_applied: 0, total_patches: request.patches.iter().map(|e| e.hunks.len()).sum(), errors, file_results });
            }
        };
        if !Path::new(&safe_path).is_file() && entry.hunks.iter().any(|h| h.start_line > 0) {
            errors.push(format!("{}: Not a file", entry.path));
            return Ok(MultiPatchResult { success: false, files_modified: 0, patches_applied: 0, total_patches: request.patches.iter().map(|e| e.hunks.len()).sum(), errors, file_results });
        }
        let original = fs::read_to_string(&safe_path).unwrap_or_default();
        rollback_snapshots.push((safe_path, original));
    }

    let total_patches: usize = request.patches.iter().map(|e| e.hunks.len()).sum();
    let mut patches_applied = 0usize;
    let mut files_modified = 0usize;
    let mut last_modified: Option<String> = None;

    // Phase 2: Apply all patches
    for entry in &request.patches {
        for hunk in &entry.hunks {
            match apply_patch_impl(&entry.path, hunk, &root) {
                Ok(result) => {
                    file_results.push(result);
                    patches_applied += 1;
                    if last_modified.as_deref() != Some(&entry.path) { files_modified += 1; last_modified = Some(entry.path.clone()); }
                }
                Err(e) => {
                    errors.push(format!("{} (lines {}-{}): {}", entry.path, hunk.start_line, hunk.end_line, e));
                    // Phase 3: Full rollback
                    for (path, original) in rollback_snapshots.iter().rev() { let _ = std::fs::write(path, original); }
                    return Ok(MultiPatchResult { success: false, files_modified: 0, patches_applied, total_patches, errors, file_results });
                }
            }
        }
    }

    Ok(MultiPatchResult { success: true, files_modified, patches_applied, total_patches, errors, file_results })
}

// ── Shared implementation ─────────────────────────────────────────────────────

fn apply_patch_impl(path: &str, hunk: &PatchHunk, root: &str) -> Result<ApplyPatchResult, String> {
    let p = Path::new(path);
    let full_path = if p.is_absolute() { p.to_path_buf() } else { Path::new(root).join(path) };
    if !full_path.is_file() { return Err(format!("Not a file: {}", path)); }
    let size = fs::metadata(&full_path).map_err(|e| e.to_string())?.len();
    if size > 2_000_000 { return Err("File too large (>2MB)".to_string()); }
    let raw = fs::read_to_string(&full_path).map_err(|e| format!("Failed to read: {}", e))?;
    let uses_crlf = raw.contains("\r\n");
    let line_ending = if uses_crlf { "\r\n" } else { "\n" };
    let mut all_lines: Vec<String> = raw.lines().map(|l| l.to_string()).collect();
    let total = all_lines.len();
    if hunk.start_line == 0 || hunk.start_line > total + 1 { return Err(format!("start_line {} out of range (file has {} lines)", hunk.start_line, total)); }
    if hunk.end_line < hunk.start_line { return Err(format!("end_line {} must be >= start_line {}", hunk.end_line, hunk.start_line)); }
    let end_idx = (hunk.end_line - 1).min(total.saturating_sub(1));
    let start_idx = hunk.start_line - 1;
    let new_lines: Vec<String> = hunk.new_content.lines().map(|l| l.to_string()).collect();
    let lines_replaced = end_idx - start_idx + 1;
    all_lines.drain(start_idx..=end_idx);
    for (i, line) in new_lines.iter().enumerate() { all_lines.insert(start_idx + i, line.clone()); }
    let had_trailing_newline = raw.ends_with('\n');
    let mut result = all_lines.join(line_ending);
    if had_trailing_newline { result.push_str(line_ending); }
    fs::write(&full_path, result.as_bytes()).map_err(|e| format!("Failed to write: {}", e))?;
    Ok(ApplyPatchResult { path: path.to_string(), lines_replaced, new_total_lines: all_lines.len() })
}