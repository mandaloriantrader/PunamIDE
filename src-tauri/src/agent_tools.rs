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

// ── Patch Verification ────────────────────────────────────────────────────────

#[derive(Serialize, Debug)]
pub struct PatchVerificationResult {
    pub matched: bool,
    pub match_line: Option<usize>,       // 1-based line where match starts
    pub similarity_score: f32,           // 0.0–1.0
}

/// Verifies that expected_snippet exists contiguously in the target file.
/// If fuzzy=true: normalizes whitespace (collapse spaces/tabs to single space,
/// trim trailing whitespace per line, normalize line endings to LF) before comparison.
/// Returns highest similarity_score and best match_line even when matched=false.
/// Errors if file not found or unreadable.
#[tauri::command]
pub fn verify_patch_applied(
    file_path: String,
    expected_snippet: String,
    fuzzy: bool,
    state: State<ProjectRoot>,
) -> Result<PatchVerificationResult, String> {
    let root = get_project_root(&state)?;
    let safe_path = validate_path_within_project(&file_path, &root)?;
    let p = Path::new(&safe_path);

    // Check file exists
    if !p.exists() {
        return Err(format!("File not found: {}", file_path));
    }

    if !p.is_file() {
        return Err(format!("Not a file: {}", file_path));
    }

    // Check if file is readable (permissions + binary detection)
    let metadata = fs::metadata(p).map_err(|e| format!("File unreadable: {}", e))?;
    if metadata.len() > 10_000_000 {
        return Err("File unreadable: file too large (>10MB)".to_string());
    }

    let raw_bytes = fs::read(p).map_err(|e| format!("File unreadable: {}", e))?;

    // Binary detection: check for null bytes in first 8KB
    let check_len = raw_bytes.len().min(8192);
    if raw_bytes[..check_len].contains(&0u8) {
        return Err("File unreadable: binary content detected".to_string());
    }

    let file_content = String::from_utf8(raw_bytes)
        .map_err(|_| "File unreadable: not valid UTF-8 text".to_string())?;

    // Enforce 500-line limit on expected snippet
    let snippet_line_count = expected_snippet.lines().count();
    if snippet_line_count > 500 {
        return Err(format!(
            "Expected snippet too large: {} lines (max 500)",
            snippet_line_count
        ));
    }

    // Normalize content if fuzzy mode
    let (file_lines, snippet_lines) = if fuzzy {
        let f_lines = normalize_lines(&file_content);
        let s_lines = normalize_lines(&expected_snippet);
        (f_lines, s_lines)
    } else {
        let f_lines: Vec<String> = file_content.lines().map(|l| l.to_string()).collect();
        let s_lines: Vec<String> = expected_snippet.lines().map(|l| l.to_string()).collect();
        (f_lines, s_lines)
    };

    if snippet_lines.is_empty() {
        return Ok(PatchVerificationResult {
            matched: true,
            match_line: Some(1),
            similarity_score: 1.0,
        });
    }

    let file_len = file_lines.len();
    let snippet_len = snippet_lines.len();

    // Exact contiguous substring match (sliding window)
    if file_len >= snippet_len {
        for i in 0..=(file_len - snippet_len) {
            let window = &file_lines[i..i + snippet_len];
            if window == snippet_lines.as_slice() {
                return Ok(PatchVerificationResult {
                    matched: true,
                    match_line: Some(i + 1), // 1-based
                    similarity_score: 1.0,
                });
            }
        }
    }

    // No exact match found
    if !fuzzy {
        return Ok(PatchVerificationResult {
            matched: false,
            match_line: None,
            similarity_score: 0.0,
        });
    }

    // Fuzzy mode: sliding window similarity scoring
    // Slide the expected snippet over the file content line by line
    // At each position, count matching lines vs total lines
    let mut best_score: f32 = 0.0;
    let mut best_line: usize = 1;

    if file_len >= snippet_len {
        for i in 0..=(file_len - snippet_len) {
            let mut matching_lines = 0usize;
            for j in 0..snippet_len {
                if file_lines[i + j] == snippet_lines[j] {
                    matching_lines += 1;
                }
            }
            let score = matching_lines as f32 / snippet_len as f32;
            if score > best_score {
                best_score = score;
                best_line = i + 1; // 1-based
            }
        }
    } else {
        // File is shorter than snippet — compare what we can
        let overlap = file_len;
        if overlap > 0 {
            let mut matching_lines = 0usize;
            for j in 0..overlap {
                if file_lines[j] == snippet_lines[j] {
                    matching_lines += 1;
                }
            }
            best_score = matching_lines as f32 / snippet_len as f32;
            best_line = 1;
        }
    }

    Ok(PatchVerificationResult {
        matched: false,
        match_line: if best_score > 0.0 { Some(best_line) } else { None },
        similarity_score: best_score,
    })
}

/// Normalize lines for fuzzy comparison:
/// - Normalize line endings to LF
/// - Collapse consecutive spaces/tabs to a single space
/// - Trim trailing whitespace per line
fn normalize_lines(content: &str) -> Vec<String> {
    // Normalize line endings to LF first
    let normalized = content.replace("\r\n", "\n").replace('\r', "\n");
    normalized
        .lines()
        .map(|line| {
            // Collapse consecutive whitespace (spaces and tabs) to single space
            let mut result = String::with_capacity(line.len());
            let mut prev_was_ws = false;
            for ch in line.chars() {
                if ch == ' ' || ch == '\t' {
                    if !prev_was_ws {
                        result.push(' ');
                        prev_was_ws = true;
                    }
                } else {
                    result.push(ch);
                    prev_was_ws = false;
                }
            }
            // Trim trailing whitespace
            result.trim_end().to_string()
        })
        .collect()
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