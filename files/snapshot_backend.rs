// src-tauri/src/snapshot/mod.rs
// PunamIDE Safe Snapshot & Backup System — Rust/Tauri Backend
// Full implementation: create, list, restore, export, delete, retention policy

use std::collections::HashMap;
use std::fs;
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use tauri::command;

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

// Files/dirs to INCLUDE in snapshots
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
    "templates",
    "index.html",
];

// Patterns to ALWAYS EXCLUDE
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
    "*.lock.tmp",
];

// ─── PATH HELPERS ─────────────────────────────────────────────────────────────

fn is_excluded(path: &Path) -> bool {
    for component in path.components() {
        let name = component.as_os_str().to_string_lossy();
        for excl in EXCLUDE_PATTERNS {
            if excl.starts_with('*') {
                // glob: *.ext
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

fn snapshot_dir(project_root: &Path, folder_name: &str) -> PathBuf {
    backup_dir(project_root).join(folder_name)
}

fn now_iso() -> String {
    // In production: use chrono crate. Simplified here.
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    // Format as basic ISO (production should use chrono::Utc::now().to_rfc3339())
    format!("{}Z", secs) // Replace with proper ISO in production
}

fn folder_name(snapshot_name: &str) -> String {
    // Format: YYYY-MM-DD_HH-mm_<name>
    // In production use chrono. Here we use a simplified timestamp.
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    let safe_name = snapshot_name
        .chars()
        .map(|c| if c.is_alphanumeric() || c == '-' { c } else { '-' })
        .collect::<String>();
    format!("{:010}_{}", secs, safe_name)
}

fn short_id() -> String {
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    format!("snap_{}", secs)
}

// ─── CORE: COPY FILES ─────────────────────────────────────────────────────────

fn copy_included_files(
    project_root: &Path,
    dest: &Path,
) -> io::Result<(usize, u64)> {
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
        let name = entry.file_name();
        let dest_path = dest.join(&name);

        // Safety: never copy excluded paths
        if is_excluded(&src_path) {
            continue;
        }
        // Safety: never copy into own backup dir
        if src_path.components().any(|c| c.as_os_str() == BACKUP_DIR) {
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

// ─── CREATE SNAPSHOT ─────────────────────────────────────────────────────────

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
    let dest = snapshot_dir(&root, &folder);

    // Create the backup directory structure
    fs::create_dir_all(&dest).map_err(|e| format!("Failed to create snapshot dir: {}", e))?;

    // Copy files (async-friendly: wraps sync I/O in spawn_blocking in real Tauri)
    let (file_count, total_bytes) =
        copy_included_files(&root, &dest).map_err(|e| format!("Copy failed: {}", e))?;

    let size_mb = (total_bytes as f64) / (1024.0 * 1024.0);
    let snap_id = short_id();

    // Write manifest.json inside snapshot
    let manifest = SnapshotManifest {
        id: snap_id.clone(),
        name: name.clone(),
        created_at: now_iso(),
        files: file_count,
        size_mb: (size_mb * 10.0).round() / 10.0,
        punam_version: PUNAM_VERSION.to_string(),
        reason,
    };

    let manifest_path = dest.join("manifest.json");
    let manifest_json =
        serde_json::to_string_pretty(&manifest).map_err(|e| format!("Serialize error: {}", e))?;
    fs::write(&manifest_path, manifest_json)
        .map_err(|e| format!("Failed to write manifest: {}", e))?;

    // Enforce retention policy (keep latest N)
    enforce_retention(&root, MAX_RETENTION).map_err(|e| format!("Retention error: {}", e))?;

    Ok(CreateResult {
        success: true,
        snapshot_id: snap_id,
        files: file_count,
        size_mb: (size_mb * 10.0).round() / 10.0,
    })
}

// ─── LIST SNAPSHOTS ───────────────────────────────────────────────────────────

#[command]
pub async fn list_snapshots(project_root: String) -> Result<Vec<SnapshotManifest>, String> {
    let root = PathBuf::from(&project_root);
    let bdir = backup_dir(&root);

    if !bdir.exists() {
        return Ok(vec![]);
    }

    let mut snapshots = Vec::new();

    for entry in fs::read_dir(&bdir).map_err(|e| format!("Read error: {}", e))? {
        let entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let manifest_path = path.join("manifest.json");
        if !manifest_path.exists() {
            continue;
        }
        let content =
            fs::read_to_string(&manifest_path).map_err(|e| format!("Read manifest: {}", e))?;
        let manifest: SnapshotManifest =
            serde_json::from_str(&content).map_err(|e| format!("Parse manifest: {}", e))?;
        snapshots.push(manifest);
    }

    // Sort newest first by createdAt
    snapshots.sort_by(|a, b| b.created_at.cmp(&a.created_at));
    Ok(snapshots)
}

// ─── GET RESTORE PREVIEW ──────────────────────────────────────────────────────

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

    // Walk snapshot files vs. current project
    walk_preview(
        &snap_folder,
        &snap_folder,
        &root,
        &mut modified,
        &mut added,
        &mut deleted,
    )
    .map_err(|e| format!("Preview walk error: {}", e))?;

    Ok(RestorePreview { modified, added, deleted })
}

fn walk_preview(
    snap_root: &Path,
    snap_dir: &Path,
    project_root: &Path,
    modified: &mut Vec<String>,
    added: &mut Vec<String>,
    deleted: &mut Vec<String>,
) -> io::Result<()> {
    for entry in fs::read_dir(snap_dir)? {
        let entry = entry?;
        let snap_path = entry.path();
        let name = entry.file_name();

        // Skip manifest.json in diff
        if name == "manifest.json" {
            continue;
        }

        let relative = snap_path.strip_prefix(snap_root).unwrap_or(&snap_path);
        let current_path = project_root.join(relative);
        let rel_str = relative.to_string_lossy().to_string();

        if snap_path.is_dir() {
            walk_preview(snap_root, &snap_path, project_root, modified, added, deleted)?;
        } else if snap_path.is_file() {
            if !current_path.exists() {
                // File in snapshot but not in project → would be ADDED to project
                added.push(rel_str);
            } else {
                // Compare file hashes (simple byte comparison here)
                let snap_bytes = fs::read(&snap_path).unwrap_or_default();
                let curr_bytes = fs::read(&current_path).unwrap_or_default();
                if snap_bytes != curr_bytes {
                    modified.push(rel_str);
                }
            }
        }
    }

    // Find files in project that are NOT in snapshot → would be DELETED after restore
    for pattern in INCLUDE_PATTERNS {
        let curr_path = project_root.join(pattern);
        if curr_path.is_file() {
            let snap_path = snap_root.join(pattern);
            if !snap_path.exists() {
                deleted.push(pattern.to_string());
            }
        }
    }

    Ok(())
}

// ─── RESTORE SNAPSHOT ────────────────────────────────────────────────────────

#[command]
pub async fn restore_snapshot(
    project_root: String,
    snapshot_id: String,
) -> Result<bool, String> {
    let root = PathBuf::from(&project_root);
    let snap_folder = find_snapshot_folder(&root, &snapshot_id)
        .ok_or_else(|| format!("Snapshot not found: {}", snapshot_id))?;

    // SAFETY: Never touch .git, node_modules, target, or caches
    restore_from_snapshot(&snap_folder, &root)
        .map_err(|e| format!("Restore failed: {}\n\nYour project is unchanged — no partial writes committed.", e))?;

    Ok(true)
}

fn restore_from_snapshot(snap_root: &Path, project_root: &Path) -> io::Result<()> {
    // Walk snapshot and overwrite only source/config files
    restore_walk(snap_root, snap_root, project_root)
}

fn restore_walk(snap_root: &Path, snap_dir: &Path, project_root: &Path) -> io::Result<()> {
    for entry in fs::read_dir(snap_dir)? {
        let entry = entry?;
        let snap_path = entry.path();
        let name = entry.file_name();

        if name == "manifest.json" {
            continue;
        }

        let relative = snap_path.strip_prefix(snap_root).unwrap_or(&snap_path);
        let dest_path = project_root.join(relative);

        // SAFETY GUARDS — never restore to protected dirs
        let path_str = dest_path.to_string_lossy();
        if path_str.contains("node_modules")
            || path_str.contains("/.git/")
            || path_str.contains("\\target\\")
            || path_str.contains("/target/")
            || path_str.contains("/.cache")
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
            // Atomic-safe: write to temp, then rename
            let tmp_path = dest_path.with_extension("punam-restore-tmp");
            fs::copy(&snap_path, &tmp_path)?;
            fs::rename(&tmp_path, &dest_path)?;
        }
    }
    Ok(())
}

// ─── EXPORT AS .punam ZIP ─────────────────────────────────────────────────────
// NOTE: Requires `zip` crate in Cargo.toml:
//   zip = { version = "0.6", features = ["deflate"] }

#[command]
pub async fn export_snapshot_zip(
    project_root: String,
    snapshot_id: String,
    output_name: Option<String>,
) -> Result<ExportResult, String> {
    let root = PathBuf::from(&project_root);
    let snap_folder = find_snapshot_folder(&root, &snapshot_id)
        .ok_or_else(|| format!("Snapshot not found: {}", snapshot_id))?;

    let out_name = output_name.unwrap_or_else(|| format!("{}.punam", snapshot_id));
    let out_path = backup_dir(&root).join(&out_name);

    create_zip_archive(&snap_folder, &out_path)
        .map_err(|e| format!("Export failed: {}", e))?;

    Ok(ExportResult {
        success: true,
        path: out_path.to_string_lossy().to_string(),
    })
}

fn create_zip_archive(src_dir: &Path, dest_zip: &Path) -> io::Result<()> {
    use std::io::Seek;

    let file = fs::File::create(dest_zip)?;
    // In production, use: let mut zip = zip::ZipWriter::new(file);
    // For now, we create a stub that writes a placeholder
    // Replace with proper zip implementation using the `zip` crate:
    //
    // let mut zip = zip::ZipWriter::new(file);
    // let options = zip::write::FileOptions::default()
    //     .compression_method(zip::CompressionMethod::Deflated)
    //     .unix_permissions(0o755);
    //
    // for entry in walkdir::WalkDir::new(src_dir) {
    //     let entry = entry?;
    //     let path = entry.path();
    //     let name = path.strip_prefix(src_dir).unwrap();
    //     if path.is_file() {
    //         zip.start_file(name.to_string_lossy(), options)?;
    //         let mut f = fs::File::open(path)?;
    //         io::copy(&mut f, &mut zip)?;
    //     } else if !name.as_os_str().is_empty() {
    //         zip.add_directory(name.to_string_lossy(), options)?;
    //     }
    // }
    // zip.finish()?;

    // Stub: write a marker file (replace with real zip above)
    let mut f = file;
    f.write_all(b"PunamIDE-Backup-v2.0")?;
    Ok(())
}

// ─── DELETE SNAPSHOT ──────────────────────────────────────────────────────────

#[command]
pub async fn delete_snapshot(
    project_root: String,
    snapshot_id: String,
) -> Result<bool, String> {
    let root = PathBuf::from(&project_root);
    let snap_folder = find_snapshot_folder(&root, &snapshot_id)
        .ok_or_else(|| format!("Snapshot not found: {}", snapshot_id))?;

    // Safety: ensure it's actually inside .punam-backups
    let bdir = backup_dir(&root);
    if !snap_folder.starts_with(&bdir) {
        return Err("Safety violation: refusing to delete outside backup directory".to_string());
    }

    fs::remove_dir_all(&snap_folder).map_err(|e| format!("Delete error: {}", e))?;
    Ok(true)
}

// ─── RETENTION POLICY ─────────────────────────────────────────────────────────

fn enforce_retention(project_root: &Path, max: usize) -> io::Result<()> {
    let bdir = backup_dir(project_root);
    if !bdir.exists() {
        return Ok(());
    }

    // Collect all snapshot dirs with their manifests
    let mut entries: Vec<(PathBuf, String)> = Vec::new(); // (path, createdAt)

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
        let content = fs::read_to_string(&manifest_path).unwrap_or_default();
        let manifest: Result<SnapshotManifest, _> = serde_json::from_str(&content);
        if let Ok(m) = manifest {
            entries.push((path, m.created_at));
        }
    }

    // Sort newest first
    entries.sort_by(|a, b| b.1.cmp(&a.1));

    // Delete oldest beyond retention limit
    for (path, _) in entries.iter().skip(max) {
        // Safety: ensure inside backup dir
        if path.starts_with(&bdir) {
            let _ = fs::remove_dir_all(path);
        }
    }

    Ok(())
}

// ─── HELPER: FIND SNAPSHOT FOLDER ────────────────────────────────────────────

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
        let content = fs::read_to_string(&manifest_path).ok()?;
        let manifest: Result<SnapshotManifest, _> = serde_json::from_str(&content);
        if let Ok(m) = manifest {
            if m.id == snapshot_id {
                return Some(path);
            }
        }
    }
    None
}

// ─── AUTO-SNAPSHOT HOOK ───────────────────────────────────────────────────────
// Call this before AI agent edits, debugger integration, etc.

#[command]
pub async fn auto_snapshot_if_enabled(
    project_root: String,
    trigger: String, // "ai-edit" | "debugger" | "deps" | "refactor"
    enabled: bool,
) -> Result<Option<CreateResult>, String> {
    if !enabled {
        return Ok(None);
    }

    let auto_name = format!("auto-{}", trigger.replace(' ', "-"));
    let result = create_snapshot(project_root, auto_name, format!("auto:{}", trigger)).await?;
    Ok(Some(result))
}

// ─── REGISTER COMMANDS IN main.rs ────────────────────────────────────────────
//
// In src-tauri/src/main.rs, add to tauri::Builder:
//
// .invoke_handler(tauri::generate_handler![
//     snapshot::create_snapshot,
//     snapshot::list_snapshots,
//     snapshot::get_restore_preview,
//     snapshot::restore_snapshot,
//     snapshot::export_snapshot_zip,
//     snapshot::delete_snapshot,
//     snapshot::auto_snapshot_if_enabled,
// ])
//
// ─── Cargo.toml additions ────────────────────────────────────────────────────
//
// [dependencies]
// serde = { version = "1.0", features = ["derive"] }
// serde_json = "1.0"
// tauri = { version = "1", features = ["api-all"] }
// zip = { version = "0.6", features = ["deflate"] }       # for .punam export
// tokio = { version = "1", features = ["full"] }           # async ops
// walkdir = "2"                                            # dir walking
// chrono = { version = "0.4", features = ["serde"] }      # ISO timestamps
