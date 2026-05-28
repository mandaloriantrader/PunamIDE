// src-tauri/src/agent_tools.rs
//
// Phase 1 agent tool commands: read_lines + apply_patch
// All other tools (read_file, search_project, run_terminal_command,
// get_project_index) already exist in lib.rs and are reused directly.
//
// Security: every path goes through validate_path_within_project from lib.rs.

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

#[derive(Deserialize, Debug)]
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

// ── read_lines ────────────────────────────────────────────────────────────────

#[tauri::command]
pub fn read_lines(
    path: String,
    start_line: usize,
    end_line: usize,
    state: State<ProjectRoot>,
) -> Result<ReadLinesResult, String> {
    let root = get_project_root(&state)?;
    let safe_path = validate_path_within_project(&path, &root)?;
    let p = Path::new(&safe_path);

    if !p.is_file() {
        return Err(format!("Not a file: {}", path));
    }

    let size = fs::metadata(p).map_err(|e| e.to_string())?.len();
    if size > 2_000_000 {
        return Err("File too large (>2MB)".to_string());
    }

    let raw = fs::read_to_string(p).map_err(|e| format!("Failed to read: {}", e))?;
    let all_lines: Vec<&str> = raw.lines().collect();
    let total = all_lines.len();

    if total == 0 {
        return Ok(ReadLinesResult {
            path,
            start_line: 0,
            end_line: 0,
            total_lines: 0,
            content: String::new(),
        });
    }

    let start_idx = if start_line == 0 { 0 } else { (start_line - 1).min(total - 1) };
    let end_idx = if end_line == 0 || end_line > total {
        total - 1
    } else {
        (end_line - 1).min(total - 1)
    };
    let end_idx = end_idx.max(start_idx);

    let slice = &all_lines[start_idx..=end_idx];
    let content = slice
        .iter()
        .enumerate()
        .map(|(i, line)| format!("{:>4} | {}", start_idx + i + 1, line))
        .collect::<Vec<_>>()
        .join("\n");

    Ok(ReadLinesResult {
        path,
        start_line: start_idx + 1,
        end_line: end_idx + 1,
        total_lines: total,
        content,
    })
}

// ── apply_patch ───────────────────────────────────────────────────────────────

#[tauri::command]
pub fn apply_patch(
    path: String,
    hunk: PatchHunk,
    state: State<ProjectRoot>,
) -> Result<ApplyPatchResult, String> {
    let root = get_project_root(&state)?;
    let safe_path = validate_path_within_project(&path, &root)?;
    let p = Path::new(&safe_path);

    if !p.is_file() {
        return Err(format!("Not a file: {}", path));
    }

    let size = fs::metadata(p).map_err(|e| e.to_string())?.len();
    if size > 2_000_000 {
        return Err("File too large (>2MB)".to_string());
    }

    let raw = fs::read_to_string(p).map_err(|e| format!("Failed to read: {}", e))?;

    let uses_crlf = raw.contains("\r\n");
    let line_ending = if uses_crlf { "\r\n" } else { "\n" };

    let mut all_lines: Vec<String> = raw.lines().map(|l| l.to_string()).collect();
    let total = all_lines.len();

    if hunk.start_line == 0 || hunk.start_line > total + 1 {
        return Err(format!(
            "start_line {} is out of range (file has {} lines)",
            hunk.start_line, total
        ));
    }
    if hunk.end_line < hunk.start_line && hunk.start_line <= total {
        return Err(format!(
            "end_line {} must be >= start_line {}",
            hunk.end_line, hunk.start_line
        ));
    }

    let new_lines: Vec<String> = hunk
        .new_content
        .lines()
        .map(|l| l.to_string())
        .collect();

    let lines_replaced;

    // ── Append edge case: start_line == total + 1 means "append after last line"
    if hunk.start_line == total + 1 {
        // Append mode — don't drain, just extend
        all_lines.extend(new_lines);
        lines_replaced = 0;
    } else {
        // Normal replace mode
        let end_idx = (hunk.end_line - 1).min(total.saturating_sub(1));
        let start_idx = hunk.start_line - 1;
        lines_replaced = end_idx - start_idx + 1;

        all_lines.drain(start_idx..=end_idx);
        for (i, line) in new_lines.iter().enumerate() {
            all_lines.insert(start_idx + i, line.clone());
        }
    }

    let had_trailing_newline = raw.ends_with('\n');
    let mut result = all_lines.join(line_ending);
    if had_trailing_newline {
        result.push_str(line_ending);
    }

    fs::write(p, result.as_bytes()).map_err(|e| format!("Failed to write: {}", e))?;

    Ok(ApplyPatchResult {
        path,
        lines_replaced,
        new_total_lines: all_lines.len(),
    })
}
