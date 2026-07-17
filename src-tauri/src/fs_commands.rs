use std::fs;
use std::path::Path;
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
    index_cache.0.write().map_err(|_| "Lock error".to_string())?.clear();
    *codebase_index.0.write().map_err(|_| "Lock error".to_string())? = None;
    Ok(())
}

/// Read ONLY the immediate children of the requested directory.
/// No recursion — returns a flat list with `children: None`.
/// The frontend calls this lazily when expanding a folder.
#[tauri::command]
pub async fn read_directory(path: String, state: State<'_, ProjectRoot>) -> Result<Vec<FileEntry>, String> {
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
    read_dir_flat(root)
}

/// Read the immediate contents of a single directory — no recursion.
fn read_dir_flat(dir: &Path) -> Result<Vec<FileEntry>, String> {
    let read_dir = fs::read_dir(dir).map_err(|e| e.to_string())?;

    let mut items: Vec<_> = read_dir.filter_map(|e| e.ok()).collect();
    // Directories first, then alphabetical
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

    let mut entries: Vec<FileEntry> = Vec::new();

    for item in items {
        let name = item.file_name().to_string_lossy().to_string();
        let file_path = item.path();
        let is_dir = item.file_type().map(|t| t.is_dir()).unwrap_or(false);

        // Skip hidden files/folders (except .env.example)
        if name.starts_with('.') && name != ".env.example" {
            continue;
        }
        if is_dir && SKIP_DIRS.contains(&name.as_str()) {
            continue;
        }
        if !is_dir && SKIP_FILES.contains(&name.as_str()) {
            continue;
        }

        entries.push(FileEntry {
            name,
            path: file_path.to_string_lossy().to_string(),
            is_dir,
            children: None, // No pre-loaded children — loaded lazily by frontend
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
