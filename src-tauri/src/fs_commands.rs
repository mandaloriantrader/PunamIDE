use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use tauri::State;

use crate::FileEntry;
use crate::CodebaseIndex;
use crate::ProjectIndexCache;
use crate::ProjectRoot;
use crate::get_project_root;
use crate::validate_path_within_project;
use crate::SKIP_DIRS;
use crate::SKIP_FILES;

#[tauri::command]
pub fn set_project_root(
    path: String,
    state: State<ProjectRoot>,
    index_cache: State<ProjectIndexCache>,
    codebase_index: State<CodebaseIndex>,
) -> Result<(), String> {
    let p = Path::new(&path);
    if !p.is_dir() {
        return Err(format!("Not a directory: {}", path));
    }
    let canonical = fs::canonicalize(p).map_err(|e| e.to_string())?;
    *state.0.lock().map_err(|_| "Lock error".to_string())? =
        Some(canonical.to_string_lossy().to_string());
    index_cache.0.lock().map_err(|_| "Lock error".to_string())?.clear();
    *codebase_index.0.lock().map_err(|_| "Lock error".to_string())? = None;
    Ok(())
}

#[tauri::command]
pub fn read_directory(path: String, state: State<ProjectRoot>) -> Result<Vec<FileEntry>, String> {
    // For read_directory, the path IS the project root or a subdir
    let root = Path::new(&path);
    if !root.is_dir() {
        return Err(format!("Not a directory: {}", path));
    }
    // If project root is set, validate; otherwise allow (initial open)
    if let Ok(Some(proj)) = state.0.lock().map(|g| g.clone()) {
        let canonical = fs::canonicalize(root).map_err(|e| e.to_string())?;
        let proj_canonical = fs::canonicalize(&proj).map_err(|e| e.to_string())?;
        if !canonical.starts_with(&proj_canonical) {
            return Err("Access denied: path outside project".to_string());
        }
    }
    let mut visited = HashSet::new();
    build_tree(root, 0, 4, &mut visited)
}

pub(crate) fn build_tree(dir: &Path, depth: usize, max_depth: usize, visited: &mut HashSet<PathBuf>) -> Result<Vec<FileEntry>, String> {
    if depth >= max_depth {
        return Ok(vec![]);
    }

    // Symlink cycle detection: canonicalize and check if already visited
    let canonical = fs::canonicalize(dir).unwrap_or_else(|_| dir.to_path_buf());
    if !visited.insert(canonical) {
        return Ok(vec![]); // Already visited — skip to prevent infinite recursion
    }

    let mut entries: Vec<FileEntry> = Vec::new();
    let read_dir = fs::read_dir(dir).map_err(|e| e.to_string())?;

    let mut items: Vec<_> = read_dir.filter_map(|e| e.ok()).collect();
    items.sort_by(|a, b| {
        let a_is_dir = a.file_type().map(|t| t.is_dir()).unwrap_or(false);
        let b_is_dir = b.file_type().map(|t| t.is_dir()).unwrap_or(false);
        b_is_dir.cmp(&a_is_dir).then(
            a.file_name()
                .to_string_lossy()
                .to_lowercase()
                .cmp(&b.file_name().to_string_lossy().to_lowercase()),
        )
    });

    for item in items {
        let name = item.file_name().to_string_lossy().to_string();
        let file_path = item.path();
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

        let children = if is_dir {
            Some(build_tree(&file_path, depth + 1, max_depth, visited).unwrap_or_default())
        } else {
            None
        };

        entries.push(FileEntry {
            name,
            path: file_path.to_string_lossy().to_string(),
            is_dir,
            children,
        });
    }

    Ok(entries)
}

#[tauri::command]
pub fn read_file(path: String, state: State<ProjectRoot>) -> Result<String, String> {
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
    fs::read_to_string(p).map_err(|e| format!("Failed to read: {}", e))
}

#[tauri::command]
pub fn path_exists(path: String, state: State<ProjectRoot>) -> Result<bool, String> {
    let root = get_project_root(&state)?;
    let safe_path = validate_path_within_project(&path, &root)?;
    Ok(Path::new(&safe_path).exists())
}

#[tauri::command]
pub fn write_file(path: String, content: String, state: State<ProjectRoot>) -> Result<(), String> {
    let root = get_project_root(&state)?;
    let safe_path = validate_path_within_project(&path, &root)?;
    let p = Path::new(&safe_path);
    if let Some(parent) = p.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    fs::write(p, content).map_err(|e| format!("Failed to write: {}", e))
}

#[tauri::command]
pub fn create_file(path: String, state: State<ProjectRoot>) -> Result<(), String> {
    let root = get_project_root(&state)?;
    let safe_path = validate_path_within_project(&path, &root)?;
    let p = Path::new(&safe_path);
    if p.exists() {
        return Err("File already exists".to_string());
    }
    if let Some(parent) = p.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    fs::write(p, "").map_err(|e| e.to_string())
}

#[tauri::command]
pub fn create_directory(path: String, state: State<ProjectRoot>) -> Result<(), String> {
    let root = get_project_root(&state)?;
    let safe_path = validate_path_within_project(&path, &root)?;
    fs::create_dir_all(&safe_path).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn delete_path(path: String, state: State<ProjectRoot>) -> Result<(), String> {
    let root = get_project_root(&state)?;
    let safe_path = validate_path_within_project(&path, &root)?;
    let p = Path::new(&safe_path);
    if p.is_dir() {
        fs::remove_dir_all(p).map_err(|e| e.to_string())
    } else {
        fs::remove_file(p).map_err(|e| e.to_string())
    }
}

#[tauri::command]
pub fn rename_path(old_path: String, new_path: String, state: State<ProjectRoot>) -> Result<(), String> {
    let root = get_project_root(&state)?;
    let safe_old = validate_path_within_project(&old_path, &root)?;
    let safe_new = validate_path_within_project(&new_path, &root)?;
    fs::rename(&safe_old, &safe_new).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn reveal_path(path: String, state: State<ProjectRoot>) -> Result<(), String> {
    let root = get_project_root(&state)?;
    let safe_path = validate_path_within_project(&path, &root)?;

    #[cfg(target_os = "windows")]
    {
        Command::new("explorer")
            .arg("/select,")
            .arg(&safe_path)
            .spawn()
            .map_err(|e| format!("Failed to reveal path: {}", e))?;
    }

    #[cfg(target_os = "macos")]
    {
        Command::new("open")
            .arg("-R")
            .arg(&safe_path)
            .spawn()
            .map_err(|e| format!("Failed to reveal path: {}", e))?;
    }

    #[cfg(all(unix, not(target_os = "macos")))]
    {
        let target = Path::new(&safe_path);
        let dir = if target.is_dir() {
            target
        } else {
            target.parent().unwrap_or_else(|| Path::new(&root))
        };
        Command::new("xdg-open")
            .arg(dir)
            .spawn()
            .map_err(|e| format!("Failed to reveal path: {}", e))?;
    }

    Ok(())
}
