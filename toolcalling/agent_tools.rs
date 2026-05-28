use std::{
    fs,
    path::{Path, PathBuf},
    process::Command,
};

use serde::{Deserialize, Serialize};

#[derive(Debug, Serialize)]
pub struct SearchMatch {
    pub path: String,
    pub line: usize,
    pub content: String,
    pub before: Vec<String>,
    pub after: Vec<String>,
}

#[derive(Debug, Serialize)]
pub struct FileReadResult {
    pub path: String,
    pub from: usize,
    pub to: usize,
    pub total_lines: usize,
    pub content: String,
}

fn project_root() -> Result<PathBuf, String> {
    std::env::current_dir().map_err(|e| e.to_string())
}

fn safe_path(path: &str) -> Result<PathBuf, String> {
    let root = project_root()?;
    let joined = root.join(path);

    let canonical_root = root.canonicalize().map_err(|e| e.to_string())?;
    let canonical_target = if joined.exists() {
        joined.canonicalize().map_err(|e| e.to_string())?
    } else {
        joined
    };

    if canonical_target.starts_with(&canonical_root) {
        Ok(canonical_target)
    } else {
        Err("Blocked path outside project".to_string())
    }
}

fn should_skip(path: &Path) -> bool {
    let s = path.to_string_lossy();

    s.contains("node_modules")
        || s.contains(".git")
        || s.contains("target")
        || s.contains("dist")
        || s.contains("build")
        || s.contains(".next")
        || s.contains("coverage")
}

fn is_text_file(path: &Path) -> bool {
    match path.extension().and_then(|x| x.to_str()).unwrap_or("") {
        "rs" | "ts" | "tsx" | "js" | "jsx" | "json" | "css" | "scss" | "html" | "md" | "txt"
        | "toml" | "yml" | "yaml" | "xml" | "svg" | "py" | "java" | "go" | "c" | "cpp" | "h"
        | "hpp" => true,
        _ => false,
    }
}

#[tauri::command]
pub fn agent_list_files() -> Result<Vec<String>, String> {
    let root = project_root()?;
    let mut files = Vec::new();
    collect_files(&root, &root, &mut files)?;
    files.sort();
    Ok(files)
}

fn collect_files(root: &Path, dir: &Path, files: &mut Vec<String>) -> Result<(), String> {
    if should_skip(dir) {
        return Ok(());
    }

    for entry in fs::read_dir(dir).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path();

        if should_skip(&path) {
            continue;
        }

        if path.is_dir() {
            collect_files(root, &path, files)?;
        } else if is_text_file(&path) {
            let rel = path
                .strip_prefix(root)
                .unwrap_or(&path)
                .to_string_lossy()
                .replace("\\", "/");

            files.push(rel);
        }
    }

    Ok(())
}

#[tauri::command]
pub fn agent_read_file(path: String) -> Result<String, String> {
    let path = safe_path(&path)?;
    fs::read_to_string(path).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn agent_read_lines(path: String, from: usize, to: usize) -> Result<FileReadResult, String> {
    let safe = safe_path(&path)?;
    let content = fs::read_to_string(&safe).map_err(|e| e.to_string())?;
    let lines: Vec<&str> = content.lines().collect();

    let total = lines.len();
    let start = from.max(1);
    let end = to.min(total).max(start);

    let selected = lines[start - 1..end]
        .iter()
        .enumerate()
        .map(|(i, line)| format!("{:>5}: {}", start + i, line))
        .collect::<Vec<_>>()
        .join("\n");

    Ok(FileReadResult {
        path,
        from: start,
        to: end,
        total_lines: total,
        content: selected,
    })
}

#[tauri::command]
pub fn agent_search_file(path: String, query: String) -> Result<Vec<SearchMatch>, String> {
    let safe = safe_path(&path)?;
    let content = fs::read_to_string(&safe).map_err(|e| e.to_string())?;
    Ok(search_content(&path, &content, &query))
}

#[tauri::command]
pub fn agent_search_project(query: String) -> Result<Vec<SearchMatch>, String> {
    let files = agent_list_files()?;
    let mut results = Vec::new();

    for file in files {
        if results.len() >= 100 {
            break;
        }

        let safe = match safe_path(&file) {
            Ok(p) => p,
            Err(_) => continue,
        };

        let content = match fs::read_to_string(&safe) {
            Ok(c) => c,
            Err(_) => continue,
        };

        results.extend(search_content(&file, &content, &query));
    }

    results.truncate(100);
    Ok(results)
}

fn search_content(path: &str, content: &str, query: &str) -> Vec<SearchMatch> {
    let q = query.to_lowercase();
    let lines: Vec<&str> = content.lines().collect();
    let mut matches = Vec::new();

    for (idx, line) in lines.iter().enumerate() {
        if line.to_lowercase().contains(&q) {
            let before_start = idx.saturating_sub(2);
            let after_end = (idx + 3).min(lines.len());

            matches.push(SearchMatch {
                path: path.to_string(),
                line: idx + 1,
                content: line.to_string(),
                before: lines[before_start..idx]
                    .iter()
                    .map(|x| x.to_string())
                    .collect(),
                after: lines[idx + 1..after_end]
                    .iter()
                    .map(|x| x.to_string())
                    .collect(),
            });
        }
    }

    matches
}

#[tauri::command]
pub fn agent_write_file(path: String, content: String) -> Result<(), String> {
    let safe = safe_path(&path)?;

    if let Some(parent) = safe.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }

    fs::write(safe, content).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn agent_apply_patch(
    path: String,
    from: usize,
    to: usize,
    replacement: String,
) -> Result<(), String> {
    let safe = safe_path(&path)?;
    let content = fs::read_to_string(&safe).map_err(|e| e.to_string())?;
    let mut lines: Vec<String> = content.lines().map(|x| x.to_string()).collect();

    if from == 0 || to < from || from > lines.len() {
        return Err("Invalid line range".to_string());
    }

    let start = from - 1;
    let end = to.min(lines.len());

    let replacement_lines: Vec<String> = replacement.lines().map(|x| x.to_string()).collect();

    lines.splice(start..end, replacement_lines);

    let new_content = lines.join("\n");
    fs::write(safe, new_content).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn agent_run_command(command: String) -> Result<String, String> {
    #[cfg(target_os = "windows")]
    let output = Command::new("cmd")
        .args(["/C", &command])
        .output()
        .map_err(|e| e.to_string())?;

    #[cfg(not(target_os = "windows"))]
    let output = Command::new("sh")
        .args(["-c", &command])
        .output()
        .map_err(|e| e.to_string())?;

    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();

    Ok(format!("STDOUT:\n{}\n\nSTDERR:\n{}", stdout, stderr))
}