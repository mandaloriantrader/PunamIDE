use std::fs;
use std::path::Path;
use tauri::State;

use crate::SearchResult;
use crate::ProjectRoot;
use crate::get_project_root;
use crate::SKIP_DIRS;
use crate::SKIP_FILES;

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
    )?;
    Ok(results)
}

pub(crate) fn search_directory(
    dir: &Path,
    project_root: &str,
    query: &str,
    results: &mut Vec<SearchResult>,
    depth: usize,
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
            search_directory(&path, project_root, query, results, depth + 1)?;
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