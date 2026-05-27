// src-tauri/src/snapshot/mod.rs
// PunamIDE Safe Snapshot & Backup System — Rust/Tauri Backend

use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use tauri::command;
use walkdir::WalkDir;
use zip::write::SimpleFileOptions;
use zip::ZipWriter;

// ─── TYPES ──────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SnapshotManifest {
    pub id: String,
    pub name: String,
    #[serde(rename = "createdAt")]
    pub created_at: String,
    pub files: usize,
    #[serde(rename = "sizeMB")]
    pub size_mb: f64,
    #[serde(rename = "punamVersion")]
    pub punam_version: String,
    pub reason: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RestorePreview {
    pub modified: Vec<String>,
    pub added: Vec<String>,
    pub deleted: Vec<String>,
}

#[derive(Debug, Serialize)]
pub struct CreateResult {
    pub success: bool,
    #[serde(rename = "snapshotId")]
    pub snapshot_id: String,
    pub files: usize,
    #[serde(rename = "sizeMB")]
    pub size_mb: f64,
}

#[derive(Debug, Serialize)]
pub struct ExportResult {
    pub success: bool,
    pub path: String,
}

// ─── CONSTANTS ───────────────────────────────────────────────────────────────

const BACKUP_DIR: &str = ".punam-backups";
const PUNAM_VERSION: &str = "2.0";
const MAX_RETENTION: usize = 20;

const INCLUDE_PATTERNS: &[&str] = &[
    "src",
    "src-tauri/src",
    "package.json",
    "package-lock.json",
    "yarn.lock",
    "pnpm-lock.yaml",
    "Cargo.toml",
    "Cargo.lock",
    "tsconfig.json",
    "tsconfig.node.json",
    "vite.config.ts",
    "vite.config.js",
    "tauri.conf.json",
    "src-tauri/tauri.conf.json",
    "src-tauri/Cargo.toml",
    ".eslintrc",
    ".eslintrc.js",
    ".eslintrc.json",
    "eslint.config.js",
    ".prettierrc",
    ".prettierrc.json",
    "styles",
    "assets",
    "public",
    ".vscode/launch.json",
    ".vscode/settings.json",
    ".punam",
    "templates",
    "index.html",
];

const EXCLUDE_PATTERNS: &[&str] = &[
    "node_modules",
    "target",
    "dist",
    "build",
    ".git",
    ".punam-backups",
    "*.log",
    "logs",
    ".cache",
    "cache",
    ".parcel-cache",
    ".vite",
    "coverage",
    "*.tmp",
];

// ─── PATH HELPERS ─────────────────────────────────────────────────────────────

fn is_excluded(path: &Path) -> bool {
    for component in path.components() {
        let name = component.as_os_str().to_string_lossy();
        for excl in EXCLUDE_PATTERNS {
            if excl.starts_with('*') {
                if name.ends_with(&excl[1..]) {
                    return true;
                }
            } else if name == *excl {
                return true;
            }
        }
    }
    false
}

fn backup_dir(project_root: &Path) -> PathBuf {
    project_root.join(BACKUP_DIR)
}

fn now_timestamp() -> String {
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    // Format as ISO-ish for sorting (proper chrono would be better)
    let s = secs;
    let days = s / 86400;
    let year = 1970 + days / 365; // approximate
    let remainder = s % 86400;
    let hours = remainder / 3600;
    let minutes = (remainder % 3600) / 60;
    format!(
        "{}-{:02}-{:02}_{:02}-{:02}",
        year,
        (days % 365) / 30 + 1,
        (days % 30) + 1,
        hours,
        minutes
    )
}

fn folder_name(snapshot_name: &str) -> String {
    let ts = now_timestamp();
    let safe_name = snapshot_name
        .chars()
        .map(|c| {
            if c.is_alphanumeric() || c == '-' {
                c
            } else {
                '-'
            }
        })
        .collect::<String>();
    format!("{}_{}", ts, safe_name)
}

fn short_id() -> String {
    let ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    format!("snap_{}", ms)
}

fn now_iso() -> String {
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    format!("{}Z", secs)
}

// ─── CORE: COPY FILES ─────────────────────────────────────────────────────────

fn copy_included_files(project_root: &Path, dest: &Path) -> io::Result<(usize, u64)> {
    let mut count = 0usize;
    let mut total_bytes = 0u64;

    for pattern in INCLUDE_PATTERNS {
        let src_path = project_root.join(pattern);
        if !src_path.exists() {
            continue;
        }
        let dest_path = dest.join(pattern);

        if src_path.is_dir() {
            copy_dir_recursive(&src_path, &dest_path, &mut count, &mut total_bytes)?;
        } else if src_path.is_file() {
            if let Some(parent) = dest_path.parent() {
                fs::create_dir_all(parent)?;
            }
            let bytes = fs::copy(&src_path, &dest_path)?;
            total_bytes += bytes;
            count += 1;
        }
    }

    Ok((count, total_bytes))
}

fn copy_dir_recursive(
    src: &Path,
    dest: &Path,
    count: &mut usize,
    bytes: &mut u64,
) -> io::Result<()> {
    fs::create_dir_all(dest)?;

    for entry in fs::read_dir(src)? {
        let entry = entry?;
        let src_path = entry.path();
        let dest_path = dest.join(entry.file_name());

        if is_excluded(&src_path) {
            continue;
        }

        if src_path.is_dir() {
            copy_dir_recursive(&src_path, &dest_path, count, bytes)?;
        } else if src_path.is_file() {
            let copied = fs::copy(&src_path, &dest_path)?;
            *bytes += copied;
            *count += 1;
        }
    }
    Ok(())
}

// ─── COMMANDS ─────────────────────────────────────────────────────────────────

#[command]
pub async fn create_snapshot(
    project_root: String,
    name: String,
    reason: String,
) -> Result<CreateResult, String> {
    let root = PathBuf::from(&project_root);
    if !root.exists() {
        return Err(format!("Project root does not exist: {}", project_root));
    }

    let folder = folder_name(&name);
    let dest = backup_dir(&root).join(&folder);
    fs::create_dir_all(&dest).map_err(|e| format!("Failed to create snapshot dir: {}", e))?;

    let (file_count, total_bytes) =
        copy_included_files(&root, &dest).map_err(|e| format!("Copy failed: {}", e))?;

    let size_mb = (total_bytes as f64) / (1024.0 * 1024.0);
    let snap_id = short_id();

    let manifest = SnapshotManifest {
        id: snap_id.clone(),
        name: name.clone(),
        created_at: now_iso(),
        files: file_count,
        size_mb: (size_mb * 10.0).round() / 10.0,
        punam_version: PUNAM_VERSION.to_string(),
        reason,
    };

    let manifest_json =
        serde_json::to_string_pretty(&manifest).map_err(|e| format!("Serialize error: {}", e))?;
    fs::write(dest.join("manifest.json"), manifest_json)
        .map_err(|e| format!("Failed to write manifest: {}", e))?;

    enforce_retention(&root, MAX_RETENTION).ok();

    Ok(CreateResult {
        success: true,
        snapshot_id: snap_id,
        files: file_count,
        size_mb: (size_mb * 10.0).round() / 10.0,
    })
}

#[command]
pub async fn list_snapshots(project_root: String) -> Result<Vec<SnapshotManifest>, String> {
    let bdir = backup_dir(&PathBuf::from(&project_root));
    if !bdir.exists() {
        return Ok(vec![]);
    }

    let mut snapshots = Vec::new();
    for entry in fs::read_dir(&bdir).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let manifest_path = path.join("manifest.json");
        if !manifest_path.exists() {
            continue;
        }
        if let Ok(content) = fs::read_to_string(&manifest_path) {
            if let Ok(manifest) = serde_json::from_str::<SnapshotManifest>(&content) {
                snapshots.push(manifest);
            }
        }
    }

    snapshots.sort_by(|a, b| b.created_at.cmp(&a.created_at));
    Ok(snapshots)
}

#[command]
pub async fn get_restore_preview(
    project_root: String,
    snapshot_id: String,
) -> Result<RestorePreview, String> {
    let root = PathBuf::from(&project_root);
    let snap_folder = find_snapshot_folder(&root, &snapshot_id)
        .ok_or_else(|| format!("Snapshot not found: {}", snapshot_id))?;

    let mut modified = Vec::new();
    let mut added = Vec::new();
    let mut deleted = Vec::new();

    walk_preview(&snap_folder, &snap_folder, &root, &mut modified, &mut added)
        .map_err(|e| format!("Preview walk error: {}", e))?;
    walk_deleted_preview(&snap_folder, &root, &root, &mut deleted)
        .map_err(|e| format!("Preview delete scan error: {}", e))?;

    Ok(RestorePreview {
        modified,
        added,
        deleted,
    })
}

fn walk_preview(
    snap_root: &Path,
    snap_dir: &Path,
    project_root: &Path,
    modified: &mut Vec<String>,
    added: &mut Vec<String>,
) -> io::Result<()> {
    for entry in fs::read_dir(snap_dir)? {
        let entry = entry?;
        let snap_path = entry.path();
        if entry.file_name() == "manifest.json" {
            continue;
        }

        let relative = snap_path.strip_prefix(snap_root).unwrap_or(&snap_path);
        let current_path = project_root.join(relative);
        let rel_str = relative.to_string_lossy().replace('\\', "/");

        if snap_path.is_dir() {
            walk_preview(snap_root, &snap_path, project_root, modified, added)?;
        } else if snap_path.is_file() {
            if !current_path.exists() {
                added.push(rel_str);
            } else {
                let snap_bytes = fs::read(&snap_path).unwrap_or_default();
                let curr_bytes = fs::read(&current_path).unwrap_or_default();
                if snap_bytes != curr_bytes {
                    modified.push(rel_str);
                }
            }
        }
    }
    Ok(())
}

fn walk_deleted_preview(
    snap_root: &Path,
    current_root: &Path,
    current_dir: &Path,
    deleted: &mut Vec<String>,
) -> io::Result<()> {
    for entry in fs::read_dir(current_dir)? {
        let entry = entry?;
        let current_path = entry.path();

        if is_excluded(&current_path) {
            continue;
        }

        let relative = current_path
            .strip_prefix(current_root)
            .unwrap_or(&current_path);
        let snapshot_path = snap_root.join(relative);
        let rel_str = relative.to_string_lossy().replace('\\', "/");

        if current_path.is_dir() {
            if !should_scan_current_relative(relative) {
                continue;
            }
            walk_deleted_preview(snap_root, current_root, &current_path, deleted)?;
        } else if current_path.is_file()
            && is_included_relative(relative)
            && !snapshot_path.exists()
        {
            deleted.push(rel_str);
        }
    }

    deleted.sort();
    Ok(())
}

fn is_included_relative(relative: &Path) -> bool {
    INCLUDE_PATTERNS.iter().any(|pattern| {
        let included = Path::new(pattern);
        relative == included || relative.starts_with(included)
    })
}

fn should_scan_current_relative(relative: &Path) -> bool {
    INCLUDE_PATTERNS.iter().any(|pattern| {
        let included = Path::new(pattern);
        relative == included || relative.starts_with(included) || included.starts_with(relative)
    })
}

#[command]
pub async fn restore_snapshot(project_root: String, snapshot_id: String) -> Result<bool, String> {
    let root = PathBuf::from(&project_root);
    let snap_folder = find_snapshot_folder(&root, &snapshot_id)
        .ok_or_else(|| format!("Snapshot not found: {}", snapshot_id))?;

    restore_walk(&snap_folder, &snap_folder, &root)
        .map_err(|e| format!("Restore failed: {}", e))?;
    delete_files_missing_from_snapshot(&snap_folder, &root, &root)
        .map_err(|e| format!("Restore cleanup failed: {}", e))?;

    Ok(true)
}

fn restore_walk(snap_root: &Path, snap_dir: &Path, project_root: &Path) -> io::Result<()> {
    for entry in fs::read_dir(snap_dir)? {
        let entry = entry?;
        let snap_path = entry.path();
        if entry.file_name() == "manifest.json" {
            continue;
        }

        let relative = snap_path.strip_prefix(snap_root).unwrap_or(&snap_path);
        let dest_path = project_root.join(relative);

        // Safety guards
        let path_str = dest_path.to_string_lossy();
        if path_str.contains("node_modules")
            || path_str.contains(".git")
            || path_str.contains("target")
            || path_str.contains(".cache")
        {
            continue;
        }

        if snap_path.is_dir() {
            fs::create_dir_all(&dest_path)?;
            restore_walk(snap_root, &snap_path, project_root)?;
        } else if snap_path.is_file() {
            if let Some(parent) = dest_path.parent() {
                fs::create_dir_all(parent)?;
            }
            // Atomic write: temp file then rename
            let tmp_path = dest_path.with_extension("punam-restore-tmp");
            fs::copy(&snap_path, &tmp_path)?;
            fs::rename(&tmp_path, &dest_path)?;
        }
    }
    Ok(())
}

fn delete_files_missing_from_snapshot(
    snap_root: &Path,
    current_root: &Path,
    current_dir: &Path,
) -> io::Result<()> {
    for entry in fs::read_dir(current_dir)? {
        let entry = entry?;
        let current_path = entry.path();

        if is_excluded(&current_path) {
            continue;
        }

        let relative = current_path
            .strip_prefix(current_root)
            .unwrap_or(&current_path);
        if current_path.is_dir() {
            if !should_scan_current_relative(relative) {
                continue;
            }
            delete_files_missing_from_snapshot(snap_root, current_root, &current_path)?;
            if fs::read_dir(&current_path)?.next().is_none() {
                let _ = fs::remove_dir(&current_path);
            }
        } else if current_path.is_file()
            && is_included_relative(relative)
            && !snap_root.join(relative).exists()
        {
            fs::remove_file(&current_path)?;
        }
    }

    Ok(())
}

#[command]
pub async fn export_snapshot_zip(
    project_root: String,
    snapshot_id: String,
    export_path: Option<String>,
) -> Result<ExportResult, String> {
    let root = PathBuf::from(&project_root);
    let snap_folder = find_snapshot_folder(&root, &snapshot_id)
        .ok_or_else(|| format!("Snapshot not found: {}", snapshot_id))?;

    let out_path = if let Some(path) = export_path {
        PathBuf::from(path)
    } else {
        backup_dir(&root).join(format!("{}.punam", snapshot_id))
    };

    if let Some(parent) = out_path.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create export directory: {}", e))?;
    }

    create_zip_archive(&snap_folder, &out_path).map_err(|e| format!("Export failed: {}", e))?;

    Ok(ExportResult {
        success: true,
        path: out_path.to_string_lossy().to_string(),
    })
}

fn create_zip_archive(src_dir: &Path, dest_zip: &Path) -> io::Result<()> {
    let file = fs::File::create(dest_zip)?;
    let mut zip = ZipWriter::new(file);
    let options = SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);

    for entry in WalkDir::new(src_dir).into_iter().filter_map(|e| e.ok()) {
        let path = entry.path();
        let name = path.strip_prefix(src_dir).unwrap_or(path);
        let name_str = name.to_string_lossy().replace('\\', "/");

        if name_str.is_empty() {
            continue;
        }

        if path.is_file() {
            zip.start_file(name_str.clone(), options)
                .map_err(|e| io::Error::new(io::ErrorKind::Other, e.to_string()))?;
            let mut f = fs::File::open(path)?;
            io::copy(&mut f, &mut zip)?;
        } else if path.is_dir() && !name_str.is_empty() {
            zip.add_directory(name_str.clone(), options)
                .map_err(|e| io::Error::new(io::ErrorKind::Other, e.to_string()))?;
        }
    }

    zip.finish()
        .map_err(|e| io::Error::new(io::ErrorKind::Other, e.to_string()))?;
    Ok(())
}

#[command]
pub async fn delete_snapshot(project_root: String, snapshot_id: String) -> Result<bool, String> {
    let root = PathBuf::from(&project_root);
    let snap_folder = find_snapshot_folder(&root, &snapshot_id)
        .ok_or_else(|| format!("Snapshot not found: {}", snapshot_id))?;

    let bdir = backup_dir(&root);
    if !snap_folder.starts_with(&bdir) {
        return Err("Safety: refusing to delete outside backup directory".to_string());
    }

    fs::remove_dir_all(&snap_folder).map_err(|e| format!("Delete error: {}", e))?;
    Ok(true)
}

#[command]
pub async fn auto_snapshot_if_enabled(
    project_root: String,
    trigger: String,
    enabled: bool,
) -> Result<Option<CreateResult>, String> {
    if !enabled {
        return Ok(None);
    }
    let name = format!("auto-{}", trigger.replace(' ', "-"));
    let result = create_snapshot(project_root, name, format!("auto:{}", trigger)).await?;
    Ok(Some(result))
}

// ─── HELPERS ──────────────────────────────────────────────────────────────────

fn enforce_retention(project_root: &Path, max: usize) -> io::Result<()> {
    let bdir = backup_dir(project_root);
    if !bdir.exists() {
        return Ok(());
    }

    let mut entries: Vec<(PathBuf, String)> = Vec::new();
    for entry in fs::read_dir(&bdir)? {
        let entry = entry?;
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let manifest_path = path.join("manifest.json");
        if !manifest_path.exists() {
            continue;
        }
        if let Ok(content) = fs::read_to_string(&manifest_path) {
            if let Ok(m) = serde_json::from_str::<SnapshotManifest>(&content) {
                entries.push((path, m.created_at));
            }
        }
    }

    entries.sort_by(|a, b| b.1.cmp(&a.1));
    for (path, _) in entries.iter().skip(max) {
        if path.starts_with(&bdir) {
            let _ = fs::remove_dir_all(path);
        }
    }
    Ok(())
}

fn find_snapshot_folder(project_root: &Path, snapshot_id: &str) -> Option<PathBuf> {
    let bdir = backup_dir(project_root);
    if !bdir.exists() {
        return None;
    }

    for entry in fs::read_dir(&bdir).ok()? {
        let entry = entry.ok()?;
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let manifest_path = path.join("manifest.json");
        if !manifest_path.exists() {
            continue;
        }
        if let Ok(content) = fs::read_to_string(&manifest_path) {
            if let Ok(m) = serde_json::from_str::<SnapshotManifest>(&content) {
                if m.id == snapshot_id {
                    return Some(path);
                }
            }
        }
    }
    None
}
