use std::fs;
use std::path::Path;
use tauri::State;
use regex_lite::Regex;

use crate::SearchResult;
use crate::ProjectRoot;
use crate::get_project_root;
use crate::SKIP_DIRS;
use crate::SKIP_FILES;

// ─── Original search (backward compatible) ─────────────────────────────────────

#[tauri::command]
pub fn search_project(query: String, state: State<ProjectRoot>) -> Result<Vec<SearchResult>, String> {
    let root = get_project_root(&state)?;
    let trimmed_query = query.trim().to_lowercase();
    if trimmed_query.is_empty() {
        return Ok(vec![]);
    }

    let mut results = Vec::new();
    search_directory(
        Path::new(&root),
        &root,
        &trimmed_query,
        &mut results,
        0,
        &None,
        &None,
    )?;
    Ok(results)
}

// ─── Enhanced search with regex, file filter, exclude patterns ──────────────────

#[tauri::command]
pub fn search_project_enhanced(
    query: String,
    is_regex: bool,
    case_sensitive: bool,
    file_extensions: Option<Vec<String>>,
    exclude_patterns: Option<Vec<String>>,
    max_results: Option<usize>,
    state: State<ProjectRoot>,
) -> Result<Vec<SearchResult>, String> {
    let root = get_project_root(&state)?;
    let trimmed_query = query.trim();
    if trimmed_query.is_empty() {
        return Ok(vec![]);
    }

    let cap = max_results.unwrap_or(500);

    // Normalize file extensions (strip leading dots)
    let extensions: Option<Vec<String>> = file_extensions.map(|exts| {
        exts.iter()
            .map(|e| e.trim_start_matches('.').to_lowercase())
            .filter(|e| !e.is_empty())
            .collect()
    });

    let mut results = Vec::new();

    if is_regex {
        // Regex mode
        let pattern = if case_sensitive {
            Regex::new(trimmed_query)
        } else {
            Regex::new(&format!("(?i){}", trimmed_query))
        };
        let re = pattern.map_err(|e| format!("Invalid regex: {}", e))?;

        search_directory_regex(
            Path::new(&root),
            &root,
            &re,
            &mut results,
            0,
            &extensions,
            &exclude_patterns,
            cap,
        )?;
    } else {
        // Plain text mode
        let search_query = if case_sensitive {
            trimmed_query.to_string()
        } else {
            trimmed_query.to_lowercase()
        };

        search_directory_enhanced(
            Path::new(&root),
            &root,
            &search_query,
            case_sensitive,
            &mut results,
            0,
            &extensions,
            &exclude_patterns,
            cap,
        )?;
    }

    Ok(results)
}

// ─── Search & Replace (preview mode — returns what would change) ────────────────

#[derive(serde::Serialize, Debug)]
pub struct ReplacePreview {
    pub path: String,
    pub line: usize,
    pub column: usize,
    pub original: String,
    pub replaced: String,
}

#[tauri::command]
pub fn search_and_replace_preview(
    query: String,
    replacement: String,
    is_regex: bool,
    case_sensitive: bool,
    file_extensions: Option<Vec<String>>,
    state: State<ProjectRoot>,
) -> Result<Vec<ReplacePreview>, String> {
    let root = get_project_root(&state)?;
    let trimmed_query = query.trim();
    if trimmed_query.is_empty() {
        return Ok(vec![]);
    }

    let extensions: Option<Vec<String>> = file_extensions.map(|exts| {
        exts.iter()
            .map(|e| e.trim_start_matches('.').to_lowercase())
            .filter(|e| !e.is_empty())
            .collect()
    });

    let mut previews = Vec::new();
    let re = if is_regex {
        let pattern = if case_sensitive {
            Regex::new(trimmed_query)
        } else {
            Regex::new(&format!("(?i){}", trimmed_query))
        };
        Some(pattern.map_err(|e| format!("Invalid regex: {}", e))?)
    } else {
        None
    };

    collect_replace_previews(
        Path::new(&root),
        &root,
        trimmed_query,
        &replacement,
        &re,
        case_sensitive,
        &extensions,
        &mut previews,
        0,
    )?;

    Ok(previews)
}

#[tauri::command]
pub fn search_and_replace_apply(
    query: String,
    replacement: String,
    is_regex: bool,
    case_sensitive: bool,
    file_paths: Vec<String>,
    state: State<ProjectRoot>,
) -> Result<usize, String> {
    let root = get_project_root(&state)?;
    let trimmed_query = query.trim();
    if trimmed_query.is_empty() {
        return Ok(0);
    }

    let re = if is_regex {
        let pattern = if case_sensitive {
            Regex::new(trimmed_query)
        } else {
            Regex::new(&format!("(?i){}", trimmed_query))
        };
        Some(pattern.map_err(|e| format!("Invalid regex: {}", e))?)
    } else {
        None
    };

    let mut total_replacements = 0;

    for relative_path in &file_paths {
        let full_path = Path::new(&root).join(relative_path);
        if !full_path.exists() {
            continue;
        }

        let content = match fs::read_to_string(&full_path) {
            Ok(c) => c,
            Err(_) => continue,
        };

        let new_content = if let Some(ref regex) = re {
            regex.replace_all(&content, replacement.as_str()).to_string()
        } else if case_sensitive {
            content.replace(trimmed_query, &replacement)
        } else {
            // Case-insensitive replace without regex
            let lower_content = content.to_lowercase();
            let lower_query = trimmed_query.to_lowercase();
            let mut result = String::with_capacity(content.len());
            let mut last_end = 0;

            for (start, _) in lower_content.match_indices(&lower_query) {
                result.push_str(&content[last_end..start]);
                result.push_str(&replacement);
                last_end = start + trimmed_query.len();
                total_replacements += 1;
            }
            result.push_str(&content[last_end..]);
            result
        };

        if new_content != content {
            if re.is_some() || case_sensitive {
                // Count replacements for regex/case-sensitive
                let count_before = if let Some(ref regex) = re {
                    regex.find_iter(&content).count()
                } else {
                    content.matches(trimmed_query).count()
                };
                total_replacements += count_before;
            }
            fs::write(&full_path, &new_content).map_err(|e| format!("Failed to write {}: {}", relative_path, e))?;
        }
    }

    Ok(total_replacements)
}

// ─── Internal helpers ───────────────────────────────────────────────────────────

fn matches_extensions(path: &Path, extensions: &Option<Vec<String>>) -> bool {
    match extensions {
        None => true,
        Some(exts) if exts.is_empty() => true,
        Some(exts) => {
            path.extension()
                .and_then(|e| e.to_str())
                .map(|e| exts.contains(&e.to_lowercase()))
                .unwrap_or(false)
        }
    }
}

fn matches_exclude(path: &Path, project_root: &str, exclude_patterns: &Option<Vec<String>>) -> bool {
    match exclude_patterns {
        None => false,
        Some(patterns) if patterns.is_empty() => false,
        Some(patterns) => {
            let relative = path
                .strip_prefix(project_root)
                .unwrap_or(path)
                .to_string_lossy()
                .replace('\\', "/");

            patterns.iter().any(|pat| {
                // Simple glob matching: support * wildcard
                if pat.contains('*') {
                    let parts: Vec<&str> = pat.split('*').collect();
                    if parts.len() == 2 {
                        let (prefix, suffix) = (parts[0], parts[1]);
                        relative.starts_with(prefix) && relative.ends_with(suffix)
                    } else {
                        relative.contains(pat.trim_matches('*'))
                    }
                } else {
                    relative.contains(pat)
                }
            })
        }
    }
}

pub(crate) fn search_directory(
    dir: &Path,
    project_root: &str,
    query: &str,
    results: &mut Vec<SearchResult>,
    depth: usize,
    extensions: &Option<Vec<String>>,
    exclude_patterns: &Option<Vec<String>>,
) -> Result<(), String> {
    if depth > 12 || results.len() >= 200 {
        return Ok(());
    }

    let items = fs::read_dir(dir).map_err(|e| e.to_string())?;

    for item in items.filter_map(|entry| entry.ok()) {
        if results.len() >= 200 {
            break;
        }

        let name = item.file_name().to_string_lossy().to_string();
        let path = item.path();
        let is_dir = item.file_type().map(|t| t.is_dir()).unwrap_or(false);

        if name.starts_with('.') && name != ".env.example" {
            continue;
        }
        if is_dir && SKIP_DIRS.contains(&name.as_str()) {
            continue;
        }
        if !is_dir && SKIP_FILES.contains(&name.as_str()) {
            continue;
        }

        if is_dir {
            search_directory(&path, project_root, query, results, depth + 1, extensions, exclude_patterns)?;
            continue;
        }

        if !matches_extensions(&path, extensions) {
            continue;
        }
        if matches_exclude(&path, project_root, exclude_patterns) {
            continue;
        }

        let metadata = fs::metadata(&path).map_err(|e| e.to_string())?;
        if metadata.len() > 1_000_000 {
            continue;
        }

        let content = match fs::read_to_string(&path) {
            Ok(content) => content,
            Err(_) => continue,
        };

        for (line_index, line) in content.lines().enumerate() {
            let lower_line = line.to_lowercase();
            if let Some(column_index) = lower_line.find(query) {
                let relative_path = path
                    .strip_prefix(project_root)
                    .unwrap_or(&path)
                    .to_string_lossy()
                    .trim_start_matches(['\\', '/'])
                    .to_string();

                results.push(SearchResult {
                    path: relative_path,
                    line: line_index + 1,
                    column: column_index + 1,
                    preview: line.trim().chars().take(240).collect(),
                });

                if results.len() >= 200 {
                    break;
                }
            }
        }
    }

    Ok(())
}

fn search_directory_enhanced(
    dir: &Path,
    project_root: &str,
    query: &str,
    case_sensitive: bool,
    results: &mut Vec<SearchResult>,
    depth: usize,
    extensions: &Option<Vec<String>>,
    exclude_patterns: &Option<Vec<String>>,
    max_results: usize,
) -> Result<(), String> {
    if depth > 15 || results.len() >= max_results {
        return Ok(());
    }

    let items = fs::read_dir(dir).map_err(|e| e.to_string())?;

    for item in items.filter_map(|entry| entry.ok()) {
        if results.len() >= max_results {
            break;
        }

        let name = item.file_name().to_string_lossy().to_string();
        let path = item.path();
        let is_dir = item.file_type().map(|t| t.is_dir()).unwrap_or(false);

        if name.starts_with('.') && name != ".env.example" {
            continue;
        }
        if is_dir && SKIP_DIRS.contains(&name.as_str()) {
            continue;
        }
        if !is_dir && SKIP_FILES.contains(&name.as_str()) {
            continue;
        }

        if is_dir {
            search_directory_enhanced(&path, project_root, query, case_sensitive, results, depth + 1, extensions, exclude_patterns, max_results)?;
            continue;
        }

        if !matches_extensions(&path, extensions) {
            continue;
        }
        if matches_exclude(&path, project_root, exclude_patterns) {
            continue;
        }

        let metadata = fs::metadata(&path).map_err(|e| e.to_string())?;
        if metadata.len() > 2_000_000 {
            continue;
        }

        let content = match fs::read_to_string(&path) {
            Ok(content) => content,
            Err(_) => continue,
        };

        for (line_index, line) in content.lines().enumerate() {
            let found = if case_sensitive {
                line.find(query)
            } else {
                line.to_lowercase().find(query)
            };

            if let Some(column_index) = found {
                let relative_path = path
                    .strip_prefix(project_root)
                    .unwrap_or(&path)
                    .to_string_lossy()
                    .trim_start_matches(['\\', '/'])
                    .to_string();

                results.push(SearchResult {
                    path: relative_path,
                    line: line_index + 1,
                    column: column_index + 1,
                    preview: line.trim().chars().take(240).collect(),
                });

                if results.len() >= max_results {
                    break;
                }
            }
        }
    }

    Ok(())
}

fn search_directory_regex(
    dir: &Path,
    project_root: &str,
    re: &Regex,
    results: &mut Vec<SearchResult>,
    depth: usize,
    extensions: &Option<Vec<String>>,
    exclude_patterns: &Option<Vec<String>>,
    max_results: usize,
) -> Result<(), String> {
    if depth > 15 || results.len() >= max_results {
        return Ok(());
    }

    let items = fs::read_dir(dir).map_err(|e| e.to_string())?;

    for item in items.filter_map(|entry| entry.ok()) {
        if results.len() >= max_results {
            break;
        }

        let name = item.file_name().to_string_lossy().to_string();
        let path = item.path();
        let is_dir = item.file_type().map(|t| t.is_dir()).unwrap_or(false);

        if name.starts_with('.') && name != ".env.example" {
            continue;
        }
        if is_dir && SKIP_DIRS.contains(&name.as_str()) {
            continue;
        }
        if !is_dir && SKIP_FILES.contains(&name.as_str()) {
            continue;
        }

        if is_dir {
            search_directory_regex(&path, project_root, re, results, depth + 1, extensions, exclude_patterns, max_results)?;
            continue;
        }

        if !matches_extensions(&path, extensions) {
            continue;
        }
        if matches_exclude(&path, project_root, exclude_patterns) {
            continue;
        }

        let metadata = fs::metadata(&path).map_err(|e| e.to_string())?;
        if metadata.len() > 2_000_000 {
            continue;
        }

        let content = match fs::read_to_string(&path) {
            Ok(content) => content,
            Err(_) => continue,
        };

        for (line_index, line) in content.lines().enumerate() {
            if let Some(m) = re.find(line) {
                let relative_path = path
                    .strip_prefix(project_root)
                    .unwrap_or(&path)
                    .to_string_lossy()
                    .trim_start_matches(['\\', '/'])
                    .to_string();

                results.push(SearchResult {
                    path: relative_path,
                    line: line_index + 1,
                    column: m.start() + 1,
                    preview: line.trim().chars().take(240).collect(),
                });

                if results.len() >= max_results {
                    break;
                }
            }
        }
    }

    Ok(())
}

fn collect_replace_previews(
    dir: &Path,
    project_root: &str,
    query: &str,
    replacement: &str,
    re: &Option<Regex>,
    case_sensitive: bool,
    extensions: &Option<Vec<String>>,
    previews: &mut Vec<ReplacePreview>,
    depth: usize,
) -> Result<(), String> {
    if depth > 15 || previews.len() >= 500 {
        return Ok(());
    }

    let items = fs::read_dir(dir).map_err(|e| e.to_string())?;

    for item in items.filter_map(|entry| entry.ok()) {
        if previews.len() >= 500 {
            break;
        }

        let name = item.file_name().to_string_lossy().to_string();
        let path = item.path();
        let is_dir = item.file_type().map(|t| t.is_dir()).unwrap_or(false);

        if name.starts_with('.') && name != ".env.example" {
            continue;
        }
        if is_dir && SKIP_DIRS.contains(&name.as_str()) {
            continue;
        }
        if !is_dir && SKIP_FILES.contains(&name.as_str()) {
            continue;
        }

        if is_dir {
            collect_replace_previews(&path, project_root, query, replacement, re, case_sensitive, extensions, previews, depth + 1)?;
            continue;
        }

        if !matches_extensions(&path, extensions) {
            continue;
        }

        let metadata = fs::metadata(&path).map_err(|e| e.to_string())?;
        if metadata.len() > 2_000_000 {
            continue;
        }

        let content = match fs::read_to_string(&path) {
            Ok(content) => content,
            Err(_) => continue,
        };

        for (line_index, line) in content.lines().enumerate() {
            let has_match = if let Some(ref regex) = re {
                regex.is_match(line)
            } else if case_sensitive {
                line.contains(query)
            } else {
                line.to_lowercase().contains(&query.to_lowercase())
            };

            if has_match {
                let replaced_line = if let Some(ref regex) = re {
                    regex.replace_all(line, replacement).to_string()
                } else if case_sensitive {
                    line.replace(query, replacement)
                } else {
                    // Case-insensitive replace
                    let lower = line.to_lowercase();
                    let lower_q = query.to_lowercase();
                    let mut result = String::new();
                    let mut last = 0;
                    for (start, _) in lower.match_indices(&lower_q) {
                        result.push_str(&line[last..start]);
                        result.push_str(replacement);
                        last = start + query.len();
                    }
                    result.push_str(&line[last..]);
                    result
                };

                let relative_path = path
                    .strip_prefix(project_root)
                    .unwrap_or(&path)
                    .to_string_lossy()
                    .trim_start_matches(['\\', '/'])
                    .to_string();

                let col = if let Some(ref regex) = re {
                    regex.find(line).map(|m| m.start() + 1).unwrap_or(1)
                } else if case_sensitive {
                    line.find(query).map(|i| i + 1).unwrap_or(1)
                } else {
                    line.to_lowercase().find(&query.to_lowercase()).map(|i| i + 1).unwrap_or(1)
                };

                previews.push(ReplacePreview {
                    path: relative_path,
                    line: line_index + 1,
                    column: col,
                    original: line.trim().chars().take(240).collect(),
                    replaced: replaced_line.trim().chars().take(240).collect(),
                });

                if previews.len() >= 500 {
                    break;
                }
            }
        }
    }

    Ok(())
}
