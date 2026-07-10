//! Workspace Import — Reads a ZIP project package, previews files, extracts to disk.
//!
//! This is the core of "AI Workspace Import." It only understands the project.punam
//! format (or raw ZIP with files). It does NOT know about DeepSeek, ChatGPT, etc.
//!
//! Commands:
//!   import_zip_preview  — read ZIP, return file list + metadata without extracting
//!   import_zip_extract  — extract ZIP to a destination folder
//!   import_detect_conflicts — check which files already exist in destination

use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};

// ─── Types ──────────────────────────────────────────────────────────────────────

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct PackageManifest {
    pub version: String,
    #[serde(rename = "projectName")]
    pub project_name: String,
    pub description: Option<String>,
    pub source: Option<PackageSource>,
    pub files: Vec<PackageFileEntry>,
    pub metadata: Option<PackageMetadata>,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct PackageSource {
    pub provider: Option<String>,
    #[serde(rename = "conversationName")]
    pub conversation_name: Option<String>,
    #[serde(rename = "generatedAt")]
    pub generated_at: Option<String>,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct PackageFileEntry {
    pub path: String,
    pub language: Option<String>,
    #[serde(rename = "lineCount")]
    pub line_count: Option<usize>,
    /// Size in bytes (computed during preview)
    pub size: Option<usize>,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct PackageMetadata {
    #[serde(rename = "totalFiles")]
    pub total_files: Option<usize>,
    #[serde(rename = "totalLines")]
    pub total_lines: Option<usize>,
    pub languages: Option<Vec<String>>,
    #[serde(rename = "entryPoint")]
    pub entry_point: Option<String>,
    #[serde(rename = "buildCommand")]
    pub build_command: Option<String>,
    #[serde(rename = "runCommand")]
    pub run_command: Option<String>,
}

#[derive(Serialize, Debug)]
pub struct ImportPreview {
    pub project_name: String,
    pub description: Option<String>,
    pub source: Option<PackageSource>,
    pub files: Vec<PackageFileEntry>,
    pub total_files: usize,
    pub total_lines: usize,
    pub total_bytes: usize,
    pub languages: Vec<String>,
    pub has_manifest: bool,
    pub suggested_build_command: Option<String>,
    pub suggested_run_command: Option<String>,
}

#[derive(Serialize, Debug)]
pub struct ConflictInfo {
    pub path: String,
    pub existing_size: usize,
    pub incoming_size: usize,
}

#[derive(Serialize, Debug)]
pub struct ImportResult {
    pub success: bool,
    pub files_written: usize,
    pub destination: String,
    pub error: Option<String>,
}

// ─── Commands ───────────────────────────────────────────────────────────────────

/// Preview a ZIP without extracting — returns file list and metadata.
#[tauri::command]
pub fn import_zip_preview(zip_path: String) -> Result<ImportPreview, String> {
    let path = Path::new(&zip_path);
    if !path.exists() {
        return Err(format!("File not found: {}", zip_path));
    }

    let file = fs::File::open(path).map_err(|e| format!("Cannot open file: {}", e))?;
    let mut archive = zip::ZipArchive::new(file).map_err(|e| format!("Invalid ZIP: {}", e))?;

    // Check for project.punam manifest
    let manifest = read_manifest(&mut archive);

    let mut files: Vec<PackageFileEntry> = Vec::new();
    let mut total_lines = 0usize;
    let mut total_bytes = 0usize;
    let mut languages_set: HashSet<String> = HashSet::new();

    for i in 0..archive.len() {
        let mut entry = archive.by_index(i).map_err(|e| e.to_string())?;
        let name = entry.name().to_string();

        // Skip directories and manifest file
        if entry.is_dir() || name == "project.punam" {
            continue;
        }

        // Skip hidden files and OS junk
        if name.starts_with("__MACOSX") || name.starts_with('.') || name.contains("/.") {
            continue;
        }

        // Security: no path traversal
        if name.contains("..") {
            continue;
        }

        let size = entry.size() as usize;
        total_bytes += size;

        // Read content to count lines
        let mut content = String::new();
        let line_count = if size < 5_000_000 {
            entry.read_to_string(&mut content).ok();
            content.lines().count()
        } else {
            0 // Skip huge files for line counting
        };
        total_lines += line_count;

        // Detect language from extension
        let language = detect_language_from_path(&name);
        if let Some(ref lang) = language {
            languages_set.insert(lang.clone());
        }

        files.push(PackageFileEntry {
            path: name,
            language,
            line_count: Some(line_count),
            size: Some(size),
        });
    }

    let total_files_count = files.len();

    // Use manifest data if available, otherwise infer
    let project_name = manifest.as_ref()
        .map(|m| m.project_name.clone())
        .unwrap_or_else(|| infer_project_name(&zip_path));

    let description = manifest.as_ref().and_then(|m| m.description.clone());
    let source = manifest.as_ref().and_then(|m| m.source.clone());

    let suggested_build = manifest.as_ref()
        .and_then(|m| m.metadata.as_ref())
        .and_then(|meta| meta.build_command.clone())
        .or_else(|| detect_build_command(&files));

    let suggested_run = manifest.as_ref()
        .and_then(|m| m.metadata.as_ref())
        .and_then(|meta| meta.run_command.clone())
        .or_else(|| detect_run_command(&files));

    Ok(ImportPreview {
        project_name,
        description,
        source,
        total_files: total_files_count,
        total_lines,
        total_bytes,
        languages: languages_set.into_iter().collect(),
        has_manifest: manifest.is_some(),
        suggested_build_command: suggested_build,
        suggested_run_command: suggested_run,
        files,
    })
}

/// Extract a ZIP to destination folder. Creates the folder if needed.
#[tauri::command]
pub fn import_zip_extract(zip_path: String, destination: String) -> Result<ImportResult, String> {
    let src_path = Path::new(&zip_path);
    if !src_path.exists() {
        return Err(format!("ZIP not found: {}", zip_path));
    }

    let dest_path = Path::new(&destination);

    // Create destination if it doesn't exist
    if !dest_path.exists() {
        fs::create_dir_all(dest_path).map_err(|e| format!("Cannot create folder: {}", e))?;
    }

    let file = fs::File::open(src_path).map_err(|e| format!("Cannot open ZIP: {}", e))?;
    let mut archive = zip::ZipArchive::new(file).map_err(|e| format!("Invalid ZIP: {}", e))?;

    let mut files_written = 0usize;

    for i in 0..archive.len() {
        let mut entry = archive.by_index(i).map_err(|e| e.to_string())?;
        let name = entry.name().to_string();

        // Skip directories, manifest, hidden files
        if entry.is_dir() || name == "project.punam" {
            continue;
        }
        if name.starts_with("__MACOSX") || name.starts_with('.') || name.contains("/.") {
            continue;
        }
        if name.contains("..") {
            continue;
        }

        // Skip files > 5MB
        if entry.size() > 5_000_000 {
            continue;
        }

        let target = dest_path.join(&name);

        // Create parent directories
        if let Some(parent) = target.parent() {
            if !parent.exists() {
                fs::create_dir_all(parent).map_err(|e| format!("Cannot create dir: {}", e))?;
            }
        }

        // Read and write
        let mut content = Vec::new();
        entry.read_to_end(&mut content).map_err(|e| format!("Read error: {}", e))?;
        fs::write(&target, &content).map_err(|e| format!("Write error for {}: {}", name, e))?;
        files_written += 1;
    }

    // Also write the project.punam manifest to the destination (if it existed in ZIP)
    // Re-open to get manifest
    let file2 = fs::File::open(src_path).map_err(|e| e.to_string())?;
    let mut archive2 = zip::ZipArchive::new(file2).map_err(|e| e.to_string())?;
    if let Some(manifest) = read_manifest(&mut archive2) {
        let manifest_json = serde_json::to_string_pretty(&manifest).unwrap_or_default();
        fs::write(dest_path.join("project.punam"), manifest_json).ok();
    }

    Ok(ImportResult {
        success: true,
        files_written,
        destination: destination.clone(),
        error: None,
    })
}

/// Detect which files in the ZIP already exist at the destination.
#[tauri::command]
pub fn import_detect_conflicts(zip_path: String, destination: String) -> Result<Vec<ConflictInfo>, String> {
    let src_path = Path::new(&zip_path);
    let dest_path = Path::new(&destination);

    if !src_path.exists() {
        return Err("ZIP not found".to_string());
    }
    if !dest_path.exists() {
        return Ok(vec![]); // No conflicts if destination doesn't exist
    }

    let file = fs::File::open(src_path).map_err(|e| e.to_string())?;
    let mut archive = zip::ZipArchive::new(file).map_err(|e| e.to_string())?;

    let mut conflicts = Vec::new();

    for i in 0..archive.len() {
        let entry = archive.by_index(i).map_err(|e| e.to_string())?;
        let name = entry.name().to_string();

        if entry.is_dir() || name == "project.punam" || name.contains("..") {
            continue;
        }

        let target = dest_path.join(&name);
        if target.exists() {
            let existing_size = fs::metadata(&target).map(|m| m.len() as usize).unwrap_or(0);
            conflicts.push(ConflictInfo {
                path: name,
                existing_size,
                incoming_size: entry.size() as usize,
            });
        }
    }

    Ok(conflicts)
}

// ─── Helpers ────────────────────────────────────────────────────────────────────

fn read_manifest(archive: &mut zip::ZipArchive<fs::File>) -> Option<PackageManifest> {
    let mut manifest_file = archive.by_name("project.punam").ok()?;
    let mut content = String::new();
    manifest_file.read_to_string(&mut content).ok()?;
    serde_json::from_str(&content).ok()
}

fn infer_project_name(zip_path: &str) -> String {
    Path::new(zip_path)
        .file_stem()
        .and_then(|s| s.to_str())
        .map(|s| s.replace("deepseek-", "").replace("-project", ""))
        .unwrap_or_else(|| "imported-project".to_string())
}

fn detect_language_from_path(path: &str) -> Option<String> {
    let ext = Path::new(path).extension()?.to_str()?;
    match ext.to_lowercase().as_str() {
        "rs" => Some("rust".to_string()),
        "ts" | "tsx" => Some("typescript".to_string()),
        "js" | "jsx" | "mjs" => Some("javascript".to_string()),
        "py" => Some("python".to_string()),
        "go" => Some("go".to_string()),
        "java" => Some("java".to_string()),
        "kt" | "kts" => Some("kotlin".to_string()),
        "c" | "h" => Some("c".to_string()),
        "cpp" | "cc" | "hpp" => Some("cpp".to_string()),
        "cs" => Some("csharp".to_string()),
        "rb" => Some("ruby".to_string()),
        "php" => Some("php".to_string()),
        "swift" => Some("swift".to_string()),
        "dart" => Some("dart".to_string()),
        "html" => Some("html".to_string()),
        "css" | "scss" => Some("css".to_string()),
        "json" => Some("json".to_string()),
        "toml" => Some("toml".to_string()),
        "yaml" | "yml" => Some("yaml".to_string()),
        "md" => Some("markdown".to_string()),
        "sh" | "bash" => Some("bash".to_string()),
        "sql" => Some("sql".to_string()),
        "xml" => Some("xml".to_string()),
        _ => None,
    }
}

fn detect_build_command(files: &[PackageFileEntry]) -> Option<String> {
    let paths: Vec<&str> = files.iter().map(|f| f.path.as_str()).collect();
    if paths.iter().any(|p| *p == "Cargo.toml") { return Some("cargo build".to_string()); }
    if paths.iter().any(|p| *p == "package.json") { return Some("npm install && npm run build".to_string()); }
    if paths.iter().any(|p| *p == "go.mod") { return Some("go build ./...".to_string()); }
    if paths.iter().any(|p| *p == "pyproject.toml" || *p == "requirements.txt") { return Some("pip install -r requirements.txt".to_string()); }
    None
}

fn detect_run_command(files: &[PackageFileEntry]) -> Option<String> {
    let paths: Vec<&str> = files.iter().map(|f| f.path.as_str()).collect();
    if paths.iter().any(|p| *p == "Cargo.toml") { return Some("cargo run".to_string()); }
    if paths.iter().any(|p| *p == "package.json") { return Some("npm start".to_string()); }
    if paths.iter().any(|p| *p == "go.mod") { return Some("go run .".to_string()); }
    if paths.iter().any(|p| p.ends_with("main.py")) { return Some("python main.py".to_string()); }
    None
}
