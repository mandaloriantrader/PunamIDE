use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::net::{TcpStream, ToSocketAddrs};
use std::path::Path;
use std::process::Command;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, State};
use tokio::io::AsyncReadExt;
use tokio::process::Command as TokioCommand;
use notify_debouncer_mini::{new_debouncer, DebouncedEventKind};
use std::time::Duration;

pub mod pty_manager;
pub mod lsp_manager;
pub mod dap_manager;

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

mod safety;
use safety::{SafetyValidator, ValidationResult};

// --- Data Types ---

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct FileEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub children: Option<Vec<FileEntry>>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct AppConfig {
    pub provider: String,
    pub api_key: String,
    pub model: String,
    pub theme: String,
}

#[derive(Deserialize, Debug)]
pub struct LlmRequest {
    pub provider: String,
    pub api_key: String,
    pub model: String,
    pub system_prompt: String,
    pub user_prompt: String,
    pub images: Option<Vec<ImageData>>,
}

#[derive(Deserialize, Debug, Clone)]
pub struct ImageData {
    pub base64: String,
    pub mime_type: String,
}

#[derive(Serialize, Debug)]
pub struct LlmResponse {
    pub text: String,
    pub success: bool,
    pub error: Option<String>,
}

#[derive(Serialize, Debug)]
pub struct CmdResult {
    pub stdout: String,
    pub stderr: String,
    pub exit_code: i32,
}

#[derive(Serialize, Debug)]
pub struct SearchResult {
    pub path: String,
    pub line: usize,
    pub column: usize,
    pub preview: String,
}

#[derive(Serialize, Debug)]
pub struct PortCheckResult {
    pub open: bool,
    pub host: String,
    pub port: u16,
    pub error: Option<String>,
}

// --- Project Root State (sandbox boundary) ---

pub struct ProjectRoot(pub Mutex<Option<String>>);

// --- Terminal Process State ---

use std::sync::Arc;

#[derive(Clone)]
pub struct TerminalProcessHandle {
    child: Arc<tokio::sync::Mutex<tokio::process::Child>>,
    killed: Arc<AtomicBool>,
}

pub struct TerminalProcesses(pub Arc<Mutex<HashMap<String, TerminalProcessHandle>>>);

// --- File Watcher State ---

pub struct FileWatcherHandle(pub Mutex<Option<notify_debouncer_mini::Debouncer<notify::RecommendedWatcher>>>);

// --- Path Safety ---

fn validate_path_within_project(path: &str, project_root: &str) -> Result<String, String> {
    let canonical_root = fs::canonicalize(project_root)
        .map_err(|e| format!("Invalid project root: {}", e))?;

    let raw_path = Path::new(path);
    let joined = if raw_path.is_absolute() {
        raw_path.to_path_buf()
    } else {
        canonical_root.join(path)
    };

    let target = if joined.exists() {
        fs::canonicalize(&joined).map_err(|e| format!("Invalid path: {}", e))?
    } else {
        // For new files, walk up to find the first existing ancestor
        // and verify it's within the project root
        let mut ancestor = joined.parent();
        let mut existing_ancestor: Option<std::path::PathBuf> = None;

        while let Some(dir) = ancestor {
            if dir.exists() {
                existing_ancestor = Some(dir.to_path_buf());
                break;
            }
            ancestor = dir.parent();
        }

        if let Some(existing) = existing_ancestor {
            let canon_ancestor = fs::canonicalize(&existing)
                .map_err(|e| format!("Invalid path: {}", e))?;

            // Verify the existing ancestor is within (or is) the project root
            if !canon_ancestor.starts_with(&canonical_root) {
                return Err("Access denied: path is outside the project directory".to_string());
            }

            // Build the full target path relative to the canonicalized ancestor
            let relative_from_ancestor = joined.strip_prefix(&existing)
                .unwrap_or(&joined);
            canon_ancestor.join(relative_from_ancestor)
        } else {
            return Err("Invalid path: no existing ancestor directory found".to_string());
        }
    };

    if !target.starts_with(&canonical_root) {
        return Err("Access denied: path is outside the project directory".to_string());
    }

    Ok(target.to_string_lossy().to_string())
}

fn get_project_root(state: &State<ProjectRoot>) -> Result<String, String> {
    state
        .0
        .lock()
        .map_err(|_| "Lock error".to_string())?
        .clone()
        .ok_or_else(|| "No project directory is open".to_string())
}

// --- Skip lists ---

const SKIP_DIRS: &[&str] = &[
    ".git", "node_modules", "__pycache__", ".pytest_cache", "venv", ".venv",
    "dist", "build", "out", "target", ".idea", ".vscode", ".next", ".nuxt",
    "coverage", ".gradle", "vendor", ".dart_tool", "egg-info",
];

const SKIP_FILES: &[&str] = &[
    "package-lock.json", "yarn.lock", "pnpm-lock.yaml",
    "Cargo.lock", "poetry.lock", "go.sum",
];

// --- File System Commands ---

#[tauri::command]
fn set_project_root(path: String, state: State<ProjectRoot>) -> Result<(), String> {
    let p = Path::new(&path);
    if !p.is_dir() {
        return Err(format!("Not a directory: {}", path));
    }
    let canonical = fs::canonicalize(p).map_err(|e| e.to_string())?;
    *state.0.lock().map_err(|_| "Lock error".to_string())? =
        Some(canonical.to_string_lossy().to_string());
    Ok(())
}

#[tauri::command]
fn read_directory(path: String, state: State<ProjectRoot>) -> Result<Vec<FileEntry>, String> {
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
    build_tree(root, 0, 4)
}

fn build_tree(dir: &Path, depth: usize, max_depth: usize) -> Result<Vec<FileEntry>, String> {
    if depth >= max_depth {
        return Ok(vec![]);
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
            Some(build_tree(&file_path, depth + 1, max_depth).unwrap_or_default())
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
fn read_file(path: String, state: State<ProjectRoot>) -> Result<String, String> {
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
fn path_exists(path: String, state: State<ProjectRoot>) -> Result<bool, String> {
    let root = get_project_root(&state)?;
    let safe_path = validate_path_within_project(&path, &root)?;
    Ok(Path::new(&safe_path).exists())
}

#[tauri::command]
fn write_file(path: String, content: String, state: State<ProjectRoot>) -> Result<(), String> {
    let root = get_project_root(&state)?;
    let safe_path = validate_path_within_project(&path, &root)?;
    let p = Path::new(&safe_path);
    if let Some(parent) = p.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    fs::write(p, content).map_err(|e| format!("Failed to write: {}", e))
}

#[tauri::command]
fn create_file(path: String, state: State<ProjectRoot>) -> Result<(), String> {
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
fn create_directory(path: String, state: State<ProjectRoot>) -> Result<(), String> {
    let root = get_project_root(&state)?;
    let safe_path = validate_path_within_project(&path, &root)?;
    fs::create_dir_all(&safe_path).map_err(|e| e.to_string())
}

#[tauri::command]
fn delete_path(path: String, state: State<ProjectRoot>) -> Result<(), String> {
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
fn rename_path(old_path: String, new_path: String, state: State<ProjectRoot>) -> Result<(), String> {
    let root = get_project_root(&state)?;
    let safe_old = validate_path_within_project(&old_path, &root)?;
    let safe_new = validate_path_within_project(&new_path, &root)?;
    fs::rename(&safe_old, &safe_new).map_err(|e| e.to_string())
}

#[tauri::command]
fn reveal_path(path: String, state: State<ProjectRoot>) -> Result<(), String> {
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

#[tauri::command]
fn search_project(query: String, state: State<ProjectRoot>) -> Result<Vec<SearchResult>, String> {
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

fn search_directory(
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

// --- Terminal Command (async, non-blocking, streaming) ---

#[derive(Serialize, Clone)]
struct TerminalOutputEvent {
    session_id: String,
    stream: String, // "stdout" | "stderr"
    line: String,
}

#[derive(Serialize, Clone)]
struct TerminalStatusEvent {
    session_id: String,
    status: String, // "running" | "completed" | "failed" | "killed"
    exit_code: Option<i32>,
}

async fn stream_terminal_output<R>(mut reader: R, app: AppHandle, session_id: String, stream: &'static str)
where
    R: tokio::io::AsyncRead + Unpin,
{
    let mut buffer = [0_u8; 4096];
    let mut pending = String::new();

    loop {
        match reader.read(&mut buffer).await {
            Ok(0) => break,
            Ok(n) => {
                pending.push_str(&String::from_utf8_lossy(&buffer[..n]));
                while let Some(newline_pos) = pending.find('\n') {
                    let mut line = pending[..newline_pos].to_string();
                    if line.ends_with('\r') {
                        line.pop();
                    }
                    let _ = app.emit("terminal-output", TerminalOutputEvent {
                        session_id: session_id.clone(),
                        stream: stream.to_string(),
                        line,
                    });
                    pending = pending[newline_pos + 1..].to_string();
                }
            }
            Err(_) => break,
        }
    }

    if !pending.is_empty() {
        let _ = app.emit("terminal-output", TerminalOutputEvent {
            session_id,
            stream: stream.to_string(),
            line: pending.trim_end_matches('\r').to_string(),
        });
    }
}

#[tauri::command]
async fn start_terminal_process(
    command: String,
    cwd: String,
    client_session_id: Option<String>,
    app: AppHandle,
    state: State<'_, TerminalProcesses>,
) -> Result<String, String> {
    let session_id = client_session_id.unwrap_or_else(|| format!("term-{}", uuid_simple()));

    let (shell, flag) = if cfg!(target_os = "windows") {
        ("cmd", "/c")
    } else {
        ("bash", "-c")
    };

    let mut cmd = TokioCommand::new(shell);
    cmd.arg(flag)
        .arg(&command)
        .current_dir(&cwd)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true);

    // On Windows, prevent a console window from flashing and ensure output goes through pipes
    #[cfg(target_os = "windows")]
    {
        cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
    }

    let mut child = cmd.spawn()
        .map_err(|e| format!("Failed to spawn process: {}", e))?;

    let stdout = child.stdout.take();
    let stderr = child.stderr.take();

    let child_handle = TerminalProcessHandle {
        child: Arc::new(tokio::sync::Mutex::new(child)),
        killed: Arc::new(AtomicBool::new(false)),
    };

    // Store the child handle so we can kill it later
    {
        let mut procs = state.0.lock().map_err(|_| "Lock error".to_string())?;
        procs.insert(session_id.clone(), child_handle.clone());
    }

    // Emit running status
    let _ = app.emit("terminal-status", TerminalStatusEvent {
        session_id: session_id.clone(),
        status: "running".to_string(),
        exit_code: None,
    });

    // Spawn stdout reader and capture its handle for awaiting
    let sid_stdout = session_id.clone();
    let app_stdout = app.clone();
    let stdout_handle = if let Some(out) = stdout {
        Some(tauri::async_runtime::spawn(async move {
            stream_terminal_output(out, app_stdout, sid_stdout, "stdout").await;
        }))
    } else {
        None
    };

    // Spawn stderr reader and capture its handle for awaiting
    let sid_stderr = session_id.clone();
    let app_stderr = app.clone();
    let stderr_handle = if let Some(err) = stderr {
        Some(tauri::async_runtime::spawn(async move {
            stream_terminal_output(err, app_stderr, sid_stderr, "stderr").await;
        }))
    } else {
        None
    };

    // Spawn a task to wait for exit AND for all output to be flushed before emitting status
    let sid_wait = session_id.clone();
    let app_wait = app.clone();
    let state_clone = Arc::clone(&state.0);
    tauri::async_runtime::spawn(async move {
        let exit_code = {
            let mut child = child_handle.child.lock().await;
            child.wait().await.ok().and_then(|status| status.code())
        };

        // Wait for all output to be flushed before emitting status
        if let Some(h) = stdout_handle { let _ = h.await; }
        if let Some(h) = stderr_handle { let _ = h.await; }

        if let Ok(mut procs) = state_clone.lock() {
            procs.remove(&sid_wait);
        }

        if child_handle.killed.load(Ordering::SeqCst) {
            return;
        }

        let status_str = if exit_code == Some(0) { "completed" } else { "failed" };
        let _ = app_wait.emit("terminal-status", TerminalStatusEvent {
            session_id: sid_wait.clone(),
            status: status_str.to_string(),
            exit_code,
        });
    });

    Ok(session_id)
}

#[tauri::command]
async fn stop_terminal_process(
    session_id: String,
    app: AppHandle,
    state: State<'_, TerminalProcesses>,
) -> Result<(), String> {
    let process = {
        let mut procs = state.0.lock().map_err(|_| "Lock error".to_string())?;
        procs.remove(&session_id).ok_or("No such process")?
    };
    process.killed.store(true, Ordering::SeqCst);
    let mut child = process.child.lock().await;

    // On Windows, kill the entire process tree using taskkill /T /F /PID.
    // We use /T (tree) and /F (force) to ensure all child processes spawned
    // by cmd.exe are terminated. We also wait for taskkill to finish before
    // proceeding, so the process is fully dead before we emit the killed status.
    #[cfg(target_os = "windows")]
    {
        if let Some(pid) = child.id() {
            // First attempt: taskkill with tree kill
            let _ = Command::new("taskkill")
                .args(["/T", "/F", "/PID", &pid.to_string()])
                .creation_flags(0x08000000) // CREATE_NO_WINDOW
                .output(); // .output() waits for completion

            // Also try killing by the process image name's children via wmic
            // as a secondary fallback for deeply nested process trees
            let _ = Command::new("taskkill")
                .args(["/F", "/PID", &pid.to_string()])
                .creation_flags(0x08000000)
                .output();
        }
        // Final fallback: tokio kill signal
        let _ = child.kill().await;
        // Wait for the process to fully exit so stdout/stderr readers terminate
        let _ = child.wait().await;
    }

    #[cfg(not(target_os = "windows"))]
    {
        // On Unix, kill the process group to terminate all children
        if let Some(pid) = child.id() {
            let _ = Command::new("kill")
                .args(["-9", &format!("-{}", pid)])
                .output();
        }
        let _ = child.kill().await;
        let _ = child.wait().await;
    }

    let _ = app.emit("terminal-status", TerminalStatusEvent {
        session_id,
        status: "killed".to_string(),
        exit_code: None,
    });
    Ok(())
}

/// Simple unique id generator (no external crate needed)
fn uuid_simple() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    format!("{:x}", nanos)
}

// Async version that runs on a background thread to avoid freezing the UI
#[tauri::command]
async fn run_terminal_command(command: String, cwd: String) -> Result<CmdResult, String> {
    let result = tokio::task::spawn_blocking(move || {
        let (shell, flag) = if cfg!(target_os = "windows") {
            ("cmd", "/c")
        } else {
            ("bash", "-c")
        };

        let output = Command::new(shell)
            .arg(flag)
            .arg(&command)
            .current_dir(&cwd)
            .output()
            .map_err(|e| format!("Failed to execute: {}", e))?;

        Ok::<CmdResult, String>(CmdResult {
            stdout: String::from_utf8_lossy(&output.stdout).to_string(),
            stderr: String::from_utf8_lossy(&output.stderr).to_string(),
            exit_code: output.status.code().unwrap_or(-1),
        })
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))?;

    result
}

#[tauri::command]
async fn check_tcp_port(host: String, port: u16) -> Result<PortCheckResult, String> {
    tokio::task::spawn_blocking(move || {
        let address = format!("{}:{}", host, port);
        let mut addrs = address
            .to_socket_addrs()
            .map_err(|e| format!("Invalid address {}: {}", address, e))?;
        let Some(addr) = addrs.next() else {
            return Ok(PortCheckResult {
                open: false,
                host,
                port,
                error: Some("No socket address resolved".to_string()),
            });
        };

        match TcpStream::connect_timeout(&addr, Duration::from_millis(800)) {
            Ok(_) => Ok(PortCheckResult { open: true, host, port, error: None }),
            Err(err) => Ok(PortCheckResult {
                open: false,
                host,
                port,
                error: Some(err.to_string()),
            }),
        }
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))?
}

// Config is now managed through tauri-plugin-store (frontend) — legacy file-based
// load_config and save_config commands removed as they are dead code.
// The frontend uses loadConfigFromStore/saveConfigFromStore which talk to the plugin.

// --- LLM API Command ---

#[tauri::command]
async fn call_llm(request: LlmRequest) -> Result<LlmResponse, String> {
    let result = match request.provider.as_str() {
        "gemini" => call_gemini(&request).await,
        "groq" | "openai" => call_openai_compatible(&request).await,
        _ => Err(format!("Unknown provider: {}", request.provider)),
    };

    match result {
        Ok(text) => Ok(LlmResponse {
            text,
            success: true,
            error: None,
        }),
        Err(e) => Ok(LlmResponse {
            text: String::new(),
            success: false,
            error: Some(e),
        }),
    }
}

async fn call_gemini(req: &LlmRequest) -> Result<String, String> {
    let url = format!(
        "https://generativelanguage.googleapis.com/v1beta/models/{}:generateContent?key={}",
        req.model, req.api_key
    );

    // Build user parts: text + optional images
    let mut user_parts = vec![serde_json::json!({"text": req.user_prompt})];

    if let Some(images) = &req.images {
        for img in images {
            user_parts.push(serde_json::json!({
                "inline_data": {
                    "mime_type": img.mime_type,
                    "data": img.base64
                }
            }));
        }
    }

    let body = serde_json::json!({
        "system_instruction": {
            "parts": [{"text": req.system_prompt}]
        },
        "contents": [{
            "role": "user",
            "parts": user_parts
        }],
        "generationConfig": {
            "temperature": 0.3,
            "maxOutputTokens": 65536
        }
    });

    let client = reqwest::Client::new();
    let resp = client
        .post(&url)
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("Network error: {}", e))?;

    let status = resp.status();
    let resp_body: serde_json::Value = resp.json().await.map_err(|e| e.to_string())?;

    if !status.is_success() {
        return Err(format!("API error {}: {}", status, resp_body));
    }

    resp_body["candidates"][0]["content"]["parts"][0]["text"]
        .as_str()
        .map(|s| s.to_string())
        .ok_or_else(|| format!("Unexpected response format: {}", resp_body))
}

// --- Gemini Native Streaming ---

#[tauri::command]
#[allow(non_snake_case)]
async fn call_gemini_stream(
    apiKey: String,
    model: String,
    systemPrompt: String,
    userPrompt: String,
    images: Option<Vec<ImageData>>,
    app: AppHandle,
) -> Result<LlmResponse, String> {
    let url = format!(
        "https://generativelanguage.googleapis.com/v1beta/models/{}:streamGenerateContent?alt=sse&key={}",
        model, apiKey
    );

    // Build user parts: text + optional images
    let mut user_parts = vec![serde_json::json!({"text": userPrompt})];
    if let Some(imgs) = &images {
        for img in imgs {
            user_parts.push(serde_json::json!({
                "inline_data": {
                    "mime_type": img.mime_type,
                    "data": img.base64
                }
            }));
        }
    }

    let body = serde_json::json!({
        "system_instruction": {
            "parts": [{"text": systemPrompt}]
        },
        "contents": [{
            "role": "user",
            "parts": user_parts
        }],
        "generationConfig": {
            "temperature": 0.3,
            "maxOutputTokens": 65536
        }
    });

    let client = reqwest::Client::new();
    let resp = match client.post(&url).json(&body).send().await {
        Ok(r) => r,
        Err(e) => {
            return Ok(LlmResponse {
                text: String::new(),
                success: false,
                error: Some(format!("Network error: {}", e)),
            });
        }
    };

    if !resp.status().is_success() {
        let status = resp.status();
        let err_body = resp.text().await.unwrap_or_default();
        if status == reqwest::StatusCode::TOO_MANY_REQUESTS {
            return Ok(LlmResponse {
                text: String::new(),
                success: false,
                error: Some("Rate limited by Gemini. Wait a moment and try again.".to_string()),
            });
        }
        return Ok(LlmResponse {
            text: String::new(),
            success: false,
            error: Some(format!("Gemini API error {}: {}", status, err_body.chars().take(200).collect::<String>())),
        });
    }

    // Stream SSE response from Gemini
    let mut full_text = String::new();
    let mut stream = resp.bytes_stream();
    use futures_util::StreamExt;
    let mut buffer = String::new();

    while let Some(chunk) = stream.next().await {
        let chunk = match chunk {
            Ok(c) => c,
            Err(_) => break,
        };
        buffer.push_str(&String::from_utf8_lossy(&chunk));

        // Process complete SSE lines
        while let Some(line_end) = buffer.find('\n') {
            let line = buffer[..line_end].trim().to_string();
            buffer = buffer[line_end + 1..].to_string();

            if line.starts_with("data: ") {
                let data = &line[6..];
                if data == "[DONE]" {
                    break;
                }
                if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(data) {
                    // Gemini streaming format: candidates[0].content.parts[0].text
                    if let Some(text) = parsed["candidates"][0]["content"]["parts"][0]["text"].as_str() {
                        full_text.push_str(text);
                        let _ = app.emit("llm-stream", LlmStreamEvent { token: text.to_string(), done: false });
                    }
                }
            }
        }
    }

    // Final done signal
    let _ = app.emit("llm-stream", LlmStreamEvent { token: String::new(), done: true });

    if full_text.is_empty() {
        return Ok(LlmResponse {
            text: String::new(),
            success: false,
            error: Some("Gemini returned empty response".to_string()),
        });
    }

    Ok(LlmResponse {
        text: full_text,
        success: true,
        error: None,
    })
}

async fn call_openai_compatible(req: &LlmRequest) -> Result<String, String> {
    let base_url = match req.provider.as_str() {
        "groq" => "https://api.groq.com/openai/v1",
        "openai" => "https://api.openai.com/v1",
        _ => return Err(format!("Unknown provider: {}", req.provider)),
    };

    let url = format!("{}/chat/completions", base_url);

    // Build user content: text + optional images (OpenAI vision format)
    let user_content = if let Some(images) = &req.images {
        if !images.is_empty() {
            let mut parts = vec![serde_json::json!({"type": "text", "text": req.user_prompt})];
            for img in images {
                parts.push(serde_json::json!({
                    "type": "image_url",
                    "image_url": {
                        "url": format!("data:{};base64,{}", img.mime_type, img.base64)
                    }
                }));
            }
            serde_json::json!(parts)
        } else {
            serde_json::json!(req.user_prompt)
        }
    } else {
        serde_json::json!(req.user_prompt)
    };

    let body = serde_json::json!({
        "model": req.model,
        "messages": [
            {"role": "system", "content": req.system_prompt},
            {"role": "user", "content": user_content}
        ],
        "temperature": 0.3,
        "max_tokens": 16384
    });

    let client = reqwest::Client::new();
    let resp = client
        .post(&url)
        .header("Authorization", format!("Bearer {}", req.api_key))
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("Network error: {}", e))?;

    let status = resp.status();
    let resp_body: serde_json::Value = resp.json().await.map_err(|e| e.to_string())?;

    if !status.is_success() {
        return Err(format!("API error {}: {}", status, resp_body));
    }

    resp_body["choices"][0]["message"]["content"]
        .as_str()
        .map(|s| s.to_string())
        .ok_or_else(|| format!("Unexpected response format: {}", resp_body))
}

// --- Generic OpenAI-Compatible Command (for multi-provider support) ---

#[derive(Serialize, Clone)]
struct LlmStreamEvent {
    token: String,
    done: bool,
}

#[tauri::command]
#[allow(non_snake_case)]
async fn call_openai_compatible_stream(
    apiKey: String,
    baseUrl: String,
    model: String,
    systemPrompt: String,
    userPrompt: String,
    images: Option<Vec<ImageData>>,
    isOpenRouter: bool,
    app: AppHandle,
) -> Result<LlmResponse, String> {
    let url = format!("{}/chat/completions", baseUrl.trim_end_matches('/'));

    // Build user content with optional images
    let user_content = if let Some(ref imgs) = images {
        if !imgs.is_empty() {
            let mut parts = vec![serde_json::json!({"type": "text", "text": userPrompt})];
            for img in imgs {
                parts.push(serde_json::json!({
                    "type": "image_url",
                    "image_url": {
                        "url": format!("data:{};base64,{}", img.mime_type, img.base64)
                    }
                }));
            }
            serde_json::json!(parts)
        } else {
            serde_json::json!(userPrompt)
        }
    } else {
        serde_json::json!(userPrompt)
    };

    let body = serde_json::json!({
        "model": model,
        "messages": [
            {"role": "system", "content": systemPrompt},
            {"role": "user", "content": user_content}
        ],
        "temperature": 0.3,
        "max_tokens": 16384,
        "stream": true
    });

    let client = reqwest::Client::new();
    let mut req_builder = client
        .post(&url)
        .header("Content-Type", "application/json");

    if !apiKey.is_empty() {
        req_builder = req_builder.header("Authorization", format!("Bearer {}", apiKey));
    }
    if isOpenRouter {
        req_builder = req_builder
            .header("HTTP-Referer", "https://punamide.app")
            .header("X-Title", "PunamIDE");
    }

    let resp = match req_builder.json(&body).send().await {
        Ok(r) => r,
        Err(e) => {
            return Ok(LlmResponse {
                text: String::new(),
                success: false,
                error: Some(format!("Network error: {}", e)),
            });
        }
    };

    if !resp.status().is_success() {
        let status = resp.status();
        let err_body = resp.text().await.unwrap_or_default();
        if status == reqwest::StatusCode::TOO_MANY_REQUESTS {
            return Ok(LlmResponse {
                text: String::new(),
                success: false,
                error: Some("Rate limited. Wait a moment and try again.".to_string()),
            });
        }
        return Ok(LlmResponse {
            text: String::new(),
            success: false,
            error: Some(format!("API error {}: {}", status, err_body.chars().take(200).collect::<String>())),
        });
    }

    // Stream SSE response
    let mut full_text = String::new();
    let mut stream = resp.bytes_stream();
    use futures_util::StreamExt;
    let mut buffer = String::new();

    while let Some(chunk) = stream.next().await {
        let chunk = match chunk {
            Ok(c) => c,
            Err(_) => break,
        };
        buffer.push_str(&String::from_utf8_lossy(&chunk));

        // Process complete SSE lines
        while let Some(line_end) = buffer.find('\n') {
            let line = buffer[..line_end].trim().to_string();
            buffer = buffer[line_end + 1..].to_string();

            if line.starts_with("data: ") {
                let data = &line[6..];
                if data == "[DONE]" {
                    let _ = app.emit("llm-stream", LlmStreamEvent { token: String::new(), done: true });
                    break;
                }
                if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(data) {
                    if let Some(token) = parsed["choices"][0]["delta"]["content"].as_str() {
                        full_text.push_str(token);
                        let _ = app.emit("llm-stream", LlmStreamEvent { token: token.to_string(), done: false });
                    }
                }
            }
        }
    }

    // Final done signal
    let _ = app.emit("llm-stream", LlmStreamEvent { token: String::new(), done: true });

    Ok(LlmResponse {
        text: full_text,
        success: true,
        error: None,
    })
}

#[tauri::command]
#[allow(non_snake_case)]
async fn call_openai_compatible_cmd(
    apiKey: String,
    baseUrl: String,
    mut model: String,
    systemPrompt: String,
    userPrompt: String,
    images: Option<Vec<ImageData>>,
    isOpenRouter: bool,
) -> Result<LlmResponse, String> {
    // Normalize common model ID typos for OpenRouter
    if isOpenRouter {
        // Fix missing hyphen in qwen2.5 → qwen-2.5
        if model.contains("qwen2.5") && !model.contains("qwen-2.5") {
            model = model.replace("qwen2.5", "qwen-2.5");
        }
        // Fix missing hyphen in deepseek-r1 variants
        if model.contains("deepseekr1") {
            model = model.replace("deepseekr1", "deepseek-r1");
        }
    }

    let url = format!("{}/chat/completions", baseUrl.trim_end_matches('/'));

    log::info!("call_openai_compatible_cmd: url={}, model={}, is_open_router={}", url, model, isOpenRouter);

    // Build user content with optional images
    let user_content = if let Some(ref imgs) = images {
        if !imgs.is_empty() {
            let mut parts = vec![serde_json::json!({"type": "text", "text": userPrompt})];
            for img in imgs {
                parts.push(serde_json::json!({
                    "type": "image_url",
                    "image_url": {
                        "url": format!("data:{};base64,{}", img.mime_type, img.base64)
                    }
                }));
            }
            serde_json::json!(parts)
        } else {
            serde_json::json!(userPrompt)
        }
    } else {
        serde_json::json!(userPrompt)
    };

    let body = serde_json::json!({
        "model": model,
        "messages": [
            {"role": "system", "content": systemPrompt},
            {"role": "user", "content": user_content}
        ],
        "temperature": 0.3,
        "max_tokens": 16384
    });

    let client = reqwest::Client::new();
    let mut req_builder = client
        .post(&url)
        .header("Content-Type", "application/json");

    // Add auth header (skip if empty for Ollama)
    if !apiKey.is_empty() {
        req_builder = req_builder.header("Authorization", format!("Bearer {}", apiKey));
    }

    // OpenRouter requires these headers for free models
    if isOpenRouter {
        req_builder = req_builder
            .header("HTTP-Referer", "https://punamide.app")
            .header("X-Title", "PunamIDE");
    }

    let resp = match req_builder.json(&body).send().await {
        Ok(r) => r,
        Err(e) => {
            log::error!("call_openai_compatible_cmd network error: {}", e);
            return Ok(LlmResponse {
                text: String::new(),
                success: false,
                error: Some(format!("Network error: {}", e)),
            });
        }
    };

    let status = resp.status();

    // Retry with exponential backoff on 429 (rate limited)
    if status == reqwest::StatusCode::TOO_MANY_REQUESTS {
        log::info!("Rate limited, retrying with backoff...");
        let delays = [2000u64, 4000, 8000]; // ms
        for delay in delays {
            tokio::time::sleep(tokio::time::Duration::from_millis(delay)).await;

            // Rebuild the request
            let mut retry_builder = client
                .post(&url)
                .header("Content-Type", "application/json");
            if !apiKey.is_empty() {
                retry_builder = retry_builder.header("Authorization", format!("Bearer {}", apiKey));
            }
            if isOpenRouter {
                retry_builder = retry_builder
                    .header("HTTP-Referer", "https://punamide.app")
                    .header("X-Title", "PunamIDE");
            }

            match retry_builder.json(&body).send().await {
                Ok(r) => {
                    if r.status() != reqwest::StatusCode::TOO_MANY_REQUESTS {
                        // Got a non-429 response, process it
                        let retry_status = r.status();
                        if retry_status == reqwest::StatusCode::NOT_FOUND {
                            return Ok(LlmResponse {
                                text: String::new(),
                                success: false,
                                error: Some(format!("Model '{}' not found.", model)),
                            });
                        }
                        let retry_body: serde_json::Value = r.json().await.map_err(|e| e.to_string())?;
                        if !retry_status.is_success() {
                            return Ok(LlmResponse {
                                text: String::new(),
                                success: false,
                                error: Some(format!("API error {}: {}", retry_status, retry_body)),
                            });
                        }
                        let text = retry_body["choices"][0]["message"]["content"]
                            .as_str()
                            .map(|s| s.to_string())
                            .unwrap_or_default();
                        return Ok(LlmResponse { text, success: true, error: None });
                    }
                    // Still 429, continue retry loop
                }
                Err(_) => continue,
            }
        }
        // All retries exhausted
        return Ok(LlmResponse {
            text: String::new(),
            success: false,
            error: Some("Rate limited. Retried 3 times but still throttled — wait a minute and try again.".to_string()),
        });
    }

    // Handle other error status codes
    if status == reqwest::StatusCode::NOT_FOUND {
        return Ok(LlmResponse {
            text: String::new(),
            success: false,
            error: Some(format!("Model '{}' not found. Try 'deepseek/deepseek-r1:free' or 'openrouter/free'.", model)),
        });
    }

    if status == reqwest::StatusCode::UNAUTHORIZED || status == reqwest::StatusCode::FORBIDDEN {
        return Ok(LlmResponse {
            text: String::new(),
            success: false,
            error: Some("Invalid API key. Check your key in Settings.".to_string()),
        });
    }

    let resp_body: serde_json::Value = resp.json().await.map_err(|e| e.to_string())?;

    if !status.is_success() {
        return Ok(LlmResponse {
            text: String::new(),
            success: false,
            error: Some(format!("API error {}: {}", status, resp_body)),
        });
    }

    let text = resp_body["choices"][0]["message"]["content"]
        .as_str()
        .map(|s| s.to_string())
        .unwrap_or_default();

    Ok(LlmResponse {
        text,
        success: true,
        error: None,
    })
}

// --- File Watcher Command ---

#[derive(Serialize, Clone)]
struct FsChangeEvent {
    paths: Vec<String>,
    kind: String, // "create" | "modify" | "remove" | "any"
}

#[tauri::command]
fn watch_project(
    path: String,
    app: AppHandle,
    state: State<FileWatcherHandle>,
) -> Result<(), String> {
    let watch_path = Path::new(&path);
    if !watch_path.is_dir() {
        return Err(format!("Not a directory: {}", path));
    }

    // Stop existing watcher if any
    {
        let mut handle = state.0.lock().map_err(|_| "Lock error".to_string())?;
        *handle = None;
    }

    let app_clone = app.clone();
    let debouncer = new_debouncer(
        Duration::from_millis(500),
        move |result: Result<Vec<notify_debouncer_mini::DebouncedEvent>, notify::Error>| {
            if let Ok(events) = result {
                let mut paths: Vec<String> = Vec::new();
                let mut kind = "any";

                for event in &events {
                    let p = event.path.to_string_lossy().to_string();
                    // Skip node_modules, .git, target, dist, build
                    if p.contains("node_modules")
                        || p.contains(".git")
                        || p.contains("\\target\\")
                        || p.contains("/target/")
                        || p.contains("\\dist\\")
                        || p.contains("/dist/")
                    {
                        continue;
                    }
                    paths.push(p);
                    kind = match event.kind {
                        DebouncedEventKind::Any => "modify",
                        DebouncedEventKind::AnyContinuous => "modify",
                        _ => "any",
                    };
                }

                if !paths.is_empty() {
                    let _ = app_clone.emit("fs-changed", FsChangeEvent {
                        paths,
                        kind: kind.to_string(),
                    });
                }
            }
        },
    )
    .map_err(|e| format!("Failed to create watcher: {}", e))?;

    // Start watching
    let watcher = debouncer;
    {
        let mut handle = state.0.lock().map_err(|_| "Lock error".to_string())?;
        *handle = Some(watcher);
    }

    // Add the path to watch
    {
        let mut handle = state.0.lock().map_err(|_| "Lock error".to_string())?;
        if let Some(ref mut debouncer) = *handle {
            debouncer
                .watcher()
                .watch(watch_path, notify::RecursiveMode::Recursive)
                .map_err(|e| format!("Failed to watch path: {}", e))?;
        }
    }

    Ok(())
}

#[tauri::command]
fn stop_watching(state: State<FileWatcherHandle>) -> Result<(), String> {
    let mut handle = state.0.lock().map_err(|_| "Lock error".to_string())?;
    *handle = None;
    Ok(())
}

// --- Command Safety Validator ---

#[tauri::command]
#[allow(non_snake_case)]
fn inspect_command(command: String, workspacePath: String) -> ValidationResult {
    let validator = SafetyValidator::new(std::path::PathBuf::from(workspacePath));
    validator.validate_command(&command)
}

#[tauri::command]
#[allow(non_snake_case)]
fn verify_path_safety(targetPath: String, workspacePath: String) -> Result<String, String> {
    let validator = SafetyValidator::new(std::path::PathBuf::from(workspacePath));
    match validator.validate_path_jail(&targetPath) {
        Ok(safe_path) => Ok(safe_path.to_string_lossy().to_string()),
        Err(e) => Err(e),
    }
}

// --- Project Context Cache (Phase 2 — fast AI context building) ---

#[derive(Serialize, Clone, Debug)]
pub struct FileIndexEntry {
    pub path: String,        // relative path
    pub extension: String,
    pub size: u64,
    pub modified: u64,       // unix timestamp
    pub preview: String,     // first 500 chars
    pub is_binary: bool,
}

pub struct ProjectIndexCache(pub Mutex<Vec<FileIndexEntry>>);

#[tauri::command]
fn get_project_index(state: State<ProjectRoot>, cache: State<ProjectIndexCache>) -> Result<Vec<FileIndexEntry>, String> {
    let cached = cache.0.lock().map_err(|_| "Lock error".to_string())?;
    if !cached.is_empty() {
        return Ok(cached.clone());
    }
    // If cache is empty, build it now
    drop(cached);
    refresh_project_index(state, cache)
}

#[tauri::command]
fn refresh_project_index(state: State<ProjectRoot>, cache: State<ProjectIndexCache>) -> Result<Vec<FileIndexEntry>, String> {
    let root = get_project_root(&state)?;
    let root_path = Path::new(&root);
    let mut entries = Vec::new();
    index_directory(root_path, root_path, &mut entries, 0);
    let mut cached = cache.0.lock().map_err(|_| "Lock error".to_string())?;
    *cached = entries.clone();
    Ok(entries)
}

#[tauri::command]
fn update_file_index(path: String, state: State<ProjectRoot>, cache: State<ProjectIndexCache>) -> Result<(), String> {
    let root = get_project_root(&state)?;
    let safe_path = validate_path_within_project(&path, &root)?;
    let root_path = Path::new(&root);
    let file_path = Path::new(&safe_path);

    let relative = file_path.strip_prefix(root_path)
        .unwrap_or(file_path)
        .to_string_lossy()
        .replace('\\', "/");

    let mut cached = cache.0.lock().map_err(|_| "Lock error".to_string())?;

    // Remove old entry for this path
    cached.retain(|e| e.path != relative);

    // Add updated entry if file still exists
    if file_path.is_file() {
        if let Some(entry) = build_index_entry(file_path, root_path) {
            cached.push(entry);
        }
    }

    Ok(())
}

fn index_directory(dir: &Path, root: &Path, entries: &mut Vec<FileIndexEntry>, depth: usize) {
    if depth > 8 || entries.len() > 5000 { return; }

    let items = match fs::read_dir(dir) {
        Ok(items) => items,
        Err(_) => return,
    };

    for item in items.filter_map(|e| e.ok()) {
        let name = item.file_name().to_string_lossy().to_string();
        let path = item.path();
        let is_dir = item.file_type().map(|t| t.is_dir()).unwrap_or(false);

        // Skip hidden, ignored dirs, and lock files
        if name.starts_with('.') { continue; }
        if is_dir && SKIP_DIRS.contains(&name.as_str()) { continue; }
        if !is_dir && SKIP_FILES.contains(&name.as_str()) { continue; }

        if is_dir {
            index_directory(&path, root, entries, depth + 1);
        } else {
            if let Some(entry) = build_index_entry(&path, root) {
                entries.push(entry);
            }
        }
    }
}

fn build_index_entry(file_path: &Path, root: &Path) -> Option<FileIndexEntry> {
    let metadata = fs::metadata(file_path).ok()?;
    let size = metadata.len();

    // Skip files > 500KB
    if size > 500_000 { return None; }

    let extension = file_path.extension()
        .unwrap_or_default()
        .to_string_lossy()
        .to_string();

    // Skip binary extensions
    let binary_exts = ["png", "jpg", "jpeg", "gif", "webp", "ico", "bmp",
        "woff", "woff2", "ttf", "eot", "otf", "mp3", "mp4", "wav",
        "zip", "tar", "gz", "rar", "7z", "pdf", "exe", "dll", "so"];
    if binary_exts.contains(&extension.as_str()) {
        return Some(FileIndexEntry {
            path: file_path.strip_prefix(root).unwrap_or(file_path).to_string_lossy().replace('\\', "/"),
            extension,
            size,
            modified: metadata.modified().ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_secs())
                .unwrap_or(0),
            preview: String::new(),
            is_binary: true,
        });
    }

    // Read first 500 chars as preview
    let preview = fs::read_to_string(file_path).ok()
        .map(|s| s.chars().take(500).collect::<String>())
        .unwrap_or_default();

    Some(FileIndexEntry {
        path: file_path.strip_prefix(root).unwrap_or(file_path).to_string_lossy().replace('\\', "/"),
        extension,
        size,
        modified: metadata.modified().ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_secs())
            .unwrap_or(0),
        preview,
        is_binary: false,
    })
}

// --- Git Engine (using libgit2 via git2 crate) ---

#[derive(Serialize, Debug)]
pub struct GitStatusEntry {
    pub path: String,
    pub status: String, // "modified", "added", "deleted", "renamed", "untracked", "conflict"
}

#[derive(Serialize, Debug)]
pub struct GitDiffResult {
    pub diff_text: String,
    pub additions: usize,
    pub deletions: usize,
}

#[tauri::command]
fn git_status(state: State<ProjectRoot>) -> Result<Vec<GitStatusEntry>, String> {
    let root = get_project_root(&state)?;
    let repo = git2::Repository::open(&root).map_err(|e| format!("Not a git repo: {}", e))?;
    let statuses = repo.statuses(None).map_err(|e| e.to_string())?;

    let mut entries = Vec::new();
    for entry in statuses.iter() {
        let path = entry.path().unwrap_or("").to_string();
        let st = entry.status();
        let status_str = if st.contains(git2::Status::CONFLICTED) {
            "conflict"
        } else if st.contains(git2::Status::WT_NEW) || st.contains(git2::Status::INDEX_NEW) {
            if st.contains(git2::Status::INDEX_NEW) { "added" } else { "untracked" }
        } else if st.contains(git2::Status::WT_DELETED) || st.contains(git2::Status::INDEX_DELETED) {
            "deleted"
        } else if st.contains(git2::Status::WT_RENAMED) || st.contains(git2::Status::INDEX_RENAMED) {
            "renamed"
        } else if st.contains(git2::Status::WT_MODIFIED) || st.contains(git2::Status::INDEX_MODIFIED) {
            "modified"
        } else {
            continue; // skip clean files
        };
        entries.push(GitStatusEntry { path, status: status_str.to_string() });
    }
    Ok(entries)
}

#[tauri::command]
fn git_diff_file(path: String, state: State<ProjectRoot>) -> Result<GitDiffResult, String> {
    let root = get_project_root(&state)?;
    let repo = git2::Repository::open(&root).map_err(|e| format!("Not a git repo: {}", e))?;

    let mut diff_opts = git2::DiffOptions::new();
    diff_opts.pathspec(&path);
    diff_opts.context_lines(3);

    let diff = repo.diff_index_to_workdir(None, Some(&mut diff_opts))
        .map_err(|e| e.to_string())?;

    let mut diff_text = String::new();
    let mut additions = 0usize;
    let mut deletions = 0usize;

    diff.print(git2::DiffFormat::Patch, |_delta, _hunk, line| {
        match line.origin() {
            '+' => { additions += 1; diff_text.push('+'); }
            '-' => { deletions += 1; diff_text.push('-'); }
            ' ' => { diff_text.push(' '); }
            'H' | 'F' => { diff_text.push_str("@@"); }
            _ => {}
        }
        if let Ok(content) = std::str::from_utf8(line.content()) {
            diff_text.push_str(content);
        }
        true
    }).map_err(|e| e.to_string())?;

    Ok(GitDiffResult { diff_text, additions, deletions })
}

#[tauri::command]
fn git_log(count: usize, state: State<ProjectRoot>) -> Result<Vec<String>, String> {
    let root = get_project_root(&state)?;
    let repo = git2::Repository::open(&root).map_err(|e| format!("Not a git repo: {}", e))?;
    let mut revwalk = repo.revwalk().map_err(|e| e.to_string())?;
    revwalk.push_head().map_err(|e| e.to_string())?;
    revwalk.set_sorting(git2::Sort::TIME).map_err(|e| e.to_string())?;

    let mut logs = Vec::new();
    for oid in revwalk.take(count).filter_map(|r| r.ok()) {
        if let Ok(commit) = repo.find_commit(oid) {
            let msg = commit.summary().unwrap_or("").to_string();
            let short_id = &oid.to_string()[..7];
            logs.push(format!("{} {}", short_id, msg));
        }
    }
    Ok(logs)
}

#[tauri::command]
fn git_branch(state: State<ProjectRoot>) -> Result<String, String> {
    let root = get_project_root(&state)?;
    let repo = git2::Repository::open(&root).map_err(|e| format!("Not a git repo: {}", e))?;
    let head = repo.head().map_err(|e| e.to_string())?;
    Ok(head.shorthand().unwrap_or("HEAD").to_string())
}

// --- Rust Fuzzy Edit Engine ---

#[derive(Serialize, Debug)]
pub struct FuzzyMatchResult {
    pub start_line: usize,
    pub end_line: usize,
    pub score: f64,
    pub matched: bool,
}

#[tauri::command]
fn fuzzy_find_block(content: String, search_text: String, threshold: f64) -> Result<FuzzyMatchResult, String> {
    let content_lines: Vec<&str> = content.lines().collect();
    let search_lines: Vec<&str> = search_text.lines().map(|l| l.trim_end()).collect();
    let window_size = search_lines.len();

    if window_size == 0 || content_lines.len() < window_size {
        return Ok(FuzzyMatchResult { start_line: 0, end_line: 0, score: 0.0, matched: false });
    }

    let mut best_score: f64 = 0.0;
    let mut best_start: usize = 0;

    for i in 0..=(content_lines.len() - window_size) {
        let window: Vec<&str> = content_lines[i..i + window_size].iter()
            .map(|l| l.trim_end())
            .collect();
        let score = line_similarity(&window, &search_lines);
        if score > best_score {
            best_score = score;
            best_start = i;
        }
    }

    if best_score >= threshold {
        Ok(FuzzyMatchResult {
            start_line: best_start,
            end_line: best_start + window_size,
            score: best_score,
            matched: true,
        })
    } else {
        Ok(FuzzyMatchResult { start_line: 0, end_line: 0, score: best_score, matched: false })
    }
}

fn line_similarity(a: &[&str], b: &[&str]) -> f64 {
    if a.len() != b.len() { return 0.0; }
    if a.is_empty() { return 1.0; }

    let mut total: f64 = 0.0;
    for i in 0..a.len() {
        if a[i] == b[i] {
            total += 1.0;
        } else {
            total += char_similarity(a[i], b[i]);
        }
    }
    total / a.len() as f64
}

fn char_similarity(a: &str, b: &str) -> f64 {
    if a == b { return 1.0; }
    if a.is_empty() || b.is_empty() { return 0.0; }
    let max_len = a.len().max(b.len());
    if max_len == 0 { return 1.0; }
    // For very long lines, use a quick heuristic
    if max_len > 300 {
        let prefix_match = a.chars().zip(b.chars()).take_while(|(x, y)| x == y).count();
        return prefix_match as f64 / max_len as f64;
    }
    let dist = levenshtein(a, b);
    1.0 - (dist as f64 / max_len as f64)
}

fn levenshtein(a: &str, b: &str) -> usize {
    let a_bytes = a.as_bytes();
    let b_bytes = b.as_bytes();
    let a_len = a_bytes.len();
    let b_len = b_bytes.len();

    let mut prev: Vec<usize> = (0..=b_len).collect();
    let mut curr = vec![0usize; b_len + 1];

    for i in 1..=a_len {
        curr[0] = i;
        for j in 1..=b_len {
            let cost = if a_bytes[i - 1] == b_bytes[j - 1] { 0 } else { 1 };
            curr[j] = (prev[j] + 1).min(curr[j - 1] + 1).min(prev[j - 1] + cost);
        }
        std::mem::swap(&mut prev, &mut curr);
    }
    prev[b_len]
}

// --- Rust TF-IDF Codebase Index ---

#[derive(Serialize, Debug)]
pub struct CodeSearchHit {
    pub path: String,
    pub start_line: usize,
    pub end_line: usize,
    pub snippet: String,
    pub score: f64,
}

pub struct CodebaseIndex(pub Mutex<Option<TfIdfIndex>>);

pub struct TfIdfIndex {
    chunks: Vec<CodeChunk>,
    inverted: HashMap<String, Vec<(usize, f64)>>, // token -> [(chunk_idx, tf)]
}

struct CodeChunk {
    path: String,
    start_line: usize,
    end_line: usize,
    content: String,
    token_count: usize,
}

const CHUNK_LINES: usize = 30;
const CHUNK_OVERLAP: usize = 5;

#[tauri::command]
fn index_codebase(state: State<ProjectRoot>, index_state: State<CodebaseIndex>) -> Result<usize, String> {
    let root = get_project_root(&state)?;
    let root_path = Path::new(&root);

    let mut chunks: Vec<CodeChunk> = Vec::new();
    collect_chunks(root_path, root_path, &mut chunks, 0);

    // Build inverted index
    let mut inverted: HashMap<String, Vec<(usize, f64)>> = HashMap::new();
    for idx in 0..chunks.len() {
        let tokens = tokenize_code(&chunks[idx].content);
        let token_count = tokens.len();
        if token_count == 0 { continue; }

        let mut freq: HashMap<&str, usize> = HashMap::new();
        for t in &tokens {
            *freq.entry(t.as_str()).or_insert(0) += 1;
        }
        for (token, count) in freq {
            let tf = count as f64 / token_count as f64;
            inverted.entry(token.to_string()).or_default().push((idx, tf));
        }
    }

    let chunk_count = chunks.len();
    let mut idx = index_state.0.lock().map_err(|_| "Lock error".to_string())?;
    *idx = Some(TfIdfIndex { chunks, inverted });

    Ok(chunk_count)
}

#[tauri::command]
fn search_codebase(query: String, top_k: usize, index_state: State<CodebaseIndex>) -> Result<Vec<CodeSearchHit>, String> {
    let idx_guard = index_state.0.lock().map_err(|_| "Lock error".to_string())?;
    let index = idx_guard.as_ref().ok_or("Codebase not indexed yet. Call index_codebase first.")?;

    let query_tokens = tokenize_code(&query);
    if query_tokens.is_empty() { return Ok(vec![]); }

    let doc_count = index.chunks.len() as f64;
    let mut scores: HashMap<usize, f64> = HashMap::new();

    for token in &query_tokens {
        if let Some(entries) = index.inverted.get(token.as_str()) {
            let idf = (doc_count / (entries.len() as f64 + 1.0)).ln() + 1.0;
            for &(chunk_idx, tf) in entries {
                *scores.entry(chunk_idx).or_insert(0.0) += tf * idf;
            }
        }
    }

    let mut sorted: Vec<(usize, f64)> = scores.into_iter().collect();
    sorted.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));

    let results: Vec<CodeSearchHit> = sorted.into_iter().take(top_k).map(|(idx, score)| {
        let chunk = &index.chunks[idx];
        CodeSearchHit {
            path: chunk.path.clone(),
            start_line: chunk.start_line,
            end_line: chunk.end_line,
            snippet: chunk.content.chars().take(200).collect(),
            score,
        }
    }).collect();

    Ok(results)
}

fn collect_chunks(dir: &Path, root: &Path, chunks: &mut Vec<CodeChunk>, depth: usize) {
    if depth > 8 || chunks.len() > 10000 { return; }

    let items = match fs::read_dir(dir) {
        Ok(i) => i,
        Err(_) => return,
    };

    for item in items.filter_map(|e| e.ok()) {
        let name = item.file_name().to_string_lossy().to_string();
        let path = item.path();
        let is_dir = item.file_type().map(|t| t.is_dir()).unwrap_or(false);

        if name.starts_with('.') { continue; }
        if is_dir && SKIP_DIRS.contains(&name.as_str()) { continue; }
        if !is_dir && SKIP_FILES.contains(&name.as_str()) { continue; }

        if is_dir {
            collect_chunks(&path, root, chunks, depth + 1);
        } else {
            let ext = path.extension().unwrap_or_default().to_string_lossy().to_string();
            let binary_exts = ["png","jpg","jpeg","gif","webp","ico","bmp","woff","woff2",
                "ttf","eot","otf","mp3","mp4","wav","zip","tar","gz","rar","pdf","exe","dll"];
            if binary_exts.contains(&ext.as_str()) { continue; }

            let content = match fs::read_to_string(&path) {
                Ok(c) => c,
                Err(_) => continue,
            };
            if content.len() > 200_000 { continue; } // skip huge files

            let relative = path.strip_prefix(root).unwrap_or(&path)
                .to_string_lossy().replace('\\', "/");
            let lines: Vec<&str> = content.lines().collect();

            let mut i = 0;
            while i < lines.len() {
                let end = (i + CHUNK_LINES).min(lines.len());
                let chunk_content: String = lines[i..end].join("\n");
                let token_count = tokenize_code(&chunk_content).len();
                chunks.push(CodeChunk {
                    path: relative.clone(),
                    start_line: i + 1,
                    end_line: end,
                    content: chunk_content,
                    token_count,
                });
                i += CHUNK_LINES - CHUNK_OVERLAP;
                if end >= lines.len() { break; }
            }
        }
    }
}

fn tokenize_code(text: &str) -> Vec<String> {
    text.to_lowercase()
        .split(|c: char| !c.is_alphanumeric() && c != '_' && c != '$')
        .filter(|t| t.len() > 2 && t.len() < 40)
        .filter(|t| !is_stop_word(t))
        .map(|t| t.to_string())
        .collect()
}

fn is_stop_word(word: &str) -> bool {
    matches!(word,
        "the" | "and" | "for" | "are" | "but" | "not" | "you" | "all" |
        "can" | "had" | "her" | "was" | "one" | "our" | "out" | "has" |
        "from" | "this" | "that" | "with" | "have" | "will" | "each" |
        "make" | "like" | "been" | "than" | "them" | "then" | "into" |
        "import" | "export" | "const" | "function" | "return" | "class" |
        "true" | "false" | "null" | "undefined" | "let" | "var" | "new"
    )
}

// --- App Entry ---

// --- Diff Engine ---

#[derive(Serialize, Debug)]
pub struct DiffResult {
    pub hunks: Vec<DiffHunk>,
    pub additions: usize,
    pub deletions: usize,
}

#[derive(Serialize, Debug)]
pub struct DiffHunk {
    pub old_start: usize,
    pub old_lines: usize,
    pub new_start: usize,
    pub new_lines: usize,
    pub lines: Vec<DiffLine>,
}

#[derive(Serialize, Debug)]
pub struct DiffLine {
    pub kind: String, // "add", "remove", "context"
    pub content: String,
}

#[tauri::command]
fn diff_strings(old_text: String, new_text: String) -> DiffResult {
    let old_lines: Vec<&str> = old_text.lines().collect();
    let new_lines: Vec<&str> = new_text.lines().collect();

    let mut hunks = Vec::new();
    let mut additions = 0usize;
    let mut deletions = 0usize;

    // Simple LCS-based diff
    let mut i = 0;
    let mut j = 0;
    let mut current_hunk: Option<DiffHunk> = None;

    while i < old_lines.len() || j < new_lines.len() {
        if i < old_lines.len() && j < new_lines.len() && old_lines[i] == new_lines[j] {
            // Context line
            if let Some(ref mut hunk) = current_hunk {
                hunk.lines.push(DiffLine { kind: "context".to_string(), content: old_lines[i].to_string() });
            }
            i += 1;
            j += 1;
        } else {
            // Start a hunk if not already in one
            if current_hunk.is_none() {
                current_hunk = Some(DiffHunk {
                    old_start: i + 1,
                    old_lines: 0,
                    new_start: j + 1,
                    new_lines: 0,
                    lines: Vec::new(),
                });
            }

            // Find next matching line
            let mut found = false;
            for look_ahead in 1..=3 {
                if j + look_ahead < new_lines.len() && i < old_lines.len() && old_lines[i] == new_lines[j + look_ahead] {
                    // Lines were added
                    for k in 0..look_ahead {
                        if let Some(ref mut hunk) = current_hunk {
                            hunk.lines.push(DiffLine { kind: "add".to_string(), content: new_lines[j + k].to_string() });
                            hunk.new_lines += 1;
                            additions += 1;
                        }
                    }
                    j += look_ahead;
                    found = true;
                    break;
                }
                if i + look_ahead < old_lines.len() && j < new_lines.len() && old_lines[i + look_ahead] == new_lines[j] {
                    // Lines were removed
                    for k in 0..look_ahead {
                        if let Some(ref mut hunk) = current_hunk {
                            hunk.lines.push(DiffLine { kind: "remove".to_string(), content: old_lines[i + k].to_string() });
                            hunk.old_lines += 1;
                            deletions += 1;
                        }
                    }
                    i += look_ahead;
                    found = true;
                    break;
                }
            }

            if !found {
                // Replace: remove old, add new
                if i < old_lines.len() {
                    if let Some(ref mut hunk) = current_hunk {
                        hunk.lines.push(DiffLine { kind: "remove".to_string(), content: old_lines[i].to_string() });
                        hunk.old_lines += 1;
                        deletions += 1;
                    }
                    i += 1;
                }
                if j < new_lines.len() {
                    if let Some(ref mut hunk) = current_hunk {
                        hunk.lines.push(DiffLine { kind: "add".to_string(), content: new_lines[j].to_string() });
                        hunk.new_lines += 1;
                        additions += 1;
                    }
                    j += 1;
                }
            }

            // Close hunk after 3 context lines
            if i < old_lines.len() && j < new_lines.len() && old_lines[i] == new_lines[j] {
                if let Some(hunk) = current_hunk.take() {
                    if !hunk.lines.is_empty() {
                        hunks.push(hunk);
                    }
                }
            }
        }
    }

    // Push final hunk
    if let Some(hunk) = current_hunk {
        if !hunk.lines.is_empty() {
            hunks.push(hunk);
        }
    }

    DiffResult { hunks, additions, deletions }
}

// --- AI Context Builder ---

#[derive(Serialize, Debug)]
pub struct AIContext {
    pub project_summary: String,
    pub relevant_files: Vec<ContextFile>,
    pub total_tokens_estimate: usize,
}

#[derive(Serialize, Debug)]
pub struct ContextFile {
    pub path: String,
    pub content: String,
    pub relevance: f64,
}

#[tauri::command]
fn build_ai_context(query: String, max_files: usize, state: State<ProjectRoot>, cache: State<ProjectIndexCache>) -> Result<AIContext, String> {
    let root = get_project_root(&state)?;
    let index = cache.0.lock().map_err(|_| "Lock error".to_string())?;

    if index.is_empty() {
        return Ok(AIContext {
            project_summary: format!("Project at: {}", root),
            relevant_files: Vec::new(),
            total_tokens_estimate: 0,
        });
    }

    let query_tokens = tokenize_code(&query);
    let mut scored_files: Vec<(f64, &FileIndexEntry)> = Vec::new();

    for entry in index.iter() {
        if entry.is_binary || entry.preview.is_empty() { continue; }

        let file_tokens = tokenize_code(&entry.preview);
        let mut score = 0.0;

        // Score based on token overlap
        for qt in &query_tokens {
            for ft in &file_tokens {
                if ft.contains(qt.as_str()) || qt.contains(ft.as_str()) {
                    score += 1.0;
                }
            }
        }

        // Boost by file extension relevance
        let ext_boost = match entry.extension.as_str() {
            "ts" | "tsx" | "js" | "jsx" => 1.2,
            "rs" => 1.1,
            "py" => 1.1,
            "css" | "scss" => 0.8,
            "json" | "toml" | "yaml" => 0.7,
            "md" => 0.5,
            _ => 1.0,
        };
        score *= ext_boost;

        // Boost if query mentions the filename
        let filename = entry.path.split('/').last().unwrap_or(&entry.path).to_lowercase();
        if query.to_lowercase().contains(&filename.replace('.', "")) {
            score += 5.0;
        }

        if score > 0.0 {
            scored_files.push((score, entry));
        }
    }

    scored_files.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap_or(std::cmp::Ordering::Equal));

    let top_files: Vec<ContextFile> = scored_files.iter()
        .take(max_files)
        .filter_map(|(score, entry)| {
            let full_path = Path::new(&root).join(&entry.path);
            let content = fs::read_to_string(&full_path).ok()?;
            // Limit to 2000 chars per file for context
            let trimmed = if content.len() > 2000 {
                format!("{}...\n[truncated]", &content[..2000])
            } else {
                content
            };
            Some(ContextFile {
                path: entry.path.clone(),
                content: trimmed,
                relevance: *score,
            })
        })
        .collect();

    let total_tokens_estimate = top_files.iter()
        .map(|f| f.content.len() / 4) // rough token estimate
        .sum();

    let file_count = index.len();
    let project_summary = format!(
        "Project: {} ({} files). Query: {}",
        root.split(['/', '\\']).last().unwrap_or(&root),
        file_count,
        query
    );

    Ok(AIContext {
        project_summary,
        relevant_files: top_files,
        total_tokens_estimate,
    })
}

// --- SQLite Persistence ---

use rusqlite::Connection;
use std::sync::Once;

static DB_INIT: Once = Once::new();

fn get_db_path() -> std::path::PathBuf {
    let data_dir = dirs::data_local_dir().unwrap_or_else(|| std::path::PathBuf::from("."));
    let app_dir = data_dir.join("punamide");
    fs::create_dir_all(&app_dir).ok();
    app_dir.join("punamide.db")
}

fn get_connection() -> Result<Connection, String> {
    let db_path = get_db_path();
    Connection::open(&db_path).map_err(|e| format!("DB error: {}", e))
}

#[tauri::command]
fn db_init() -> Result<(), String> {
    let conn = get_connection()?;
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS chat_sessions (
            id TEXT PRIMARY KEY,
            title TEXT NOT NULL,
            provider TEXT NOT NULL,
            model TEXT NOT NULL,
            messages TEXT NOT NULL,
            token_count INTEGER DEFAULT 0,
            cost REAL DEFAULT 0.0,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_sessions_updated ON chat_sessions(updated_at DESC);
        "
    ).map_err(|e| format!("DB init error: {}", e))?;
    Ok(())
}

#[derive(Deserialize, Debug)]
pub struct ChatSessionData {
    pub id: String,
    pub title: String,
    pub provider: String,
    pub model: String,
    pub messages: String, // JSON string
    pub token_count: i64,
    pub cost: f64,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Serialize, Debug)]
pub struct ChatSessionRow {
    pub id: String,
    pub title: String,
    pub provider: String,
    pub model: String,
    pub messages: String,
    pub token_count: i64,
    pub cost: f64,
    pub created_at: i64,
    pub updated_at: i64,
}

#[tauri::command]
fn db_save_chat_session(session: ChatSessionData) -> Result<(), String> {
    let conn = get_connection()?;
    conn.execute(
        "INSERT OR REPLACE INTO chat_sessions (id, title, provider, model, messages, token_count, cost, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
        rusqlite::params![
            session.id, session.title, session.provider, session.model,
            session.messages, session.token_count, session.cost,
            session.created_at, session.updated_at
        ],
    ).map_err(|e| format!("DB save error: {}", e))?;
    Ok(())
}

#[tauri::command]
fn db_load_chat_sessions(limit: usize) -> Result<Vec<ChatSessionRow>, String> {
    let conn = get_connection()?;
    let mut stmt = conn.prepare(
        "SELECT id, title, provider, model, messages, token_count, cost, created_at, updated_at
         FROM chat_sessions ORDER BY updated_at DESC LIMIT ?1"
    ).map_err(|e| format!("DB query error: {}", e))?;

    let rows = stmt.query_map(rusqlite::params![limit as i64], |row| {
        Ok(ChatSessionRow {
            id: row.get(0)?,
            title: row.get(1)?,
            provider: row.get(2)?,
            model: row.get(3)?,
            messages: row.get(4)?,
            token_count: row.get(5)?,
            cost: row.get(6)?,
            created_at: row.get(7)?,
            updated_at: row.get(8)?,
        })
    }).map_err(|e| format!("DB query error: {}", e))?;

    let mut sessions = Vec::new();
    for row in rows {
        sessions.push(row.map_err(|e| format!("DB row error: {}", e))?);
    }
    Ok(sessions)
}

#[tauri::command]
fn db_delete_chat_session(id: String) -> Result<(), String> {
    let conn = get_connection()?;
    conn.execute("DELETE FROM chat_sessions WHERE id = ?1", rusqlite::params![id])
        .map_err(|e| format!("DB delete error: {}", e))?;
    Ok(())
}

// --- App Entry ---

// --- PTY Terminal (Interactive Shell) ---

// --- LSP (Language Server Protocol) ---
// Moved to lsp_manager.rs module

// --- PTY Terminal (Interactive Shell) ---
// Moved to pty_manager.rs module

// --- App Entry ---

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Create shared state — Clone-able for the exit handler
    let lsp_state = lsp_manager::LspState::new();
    let pty_state = pty_manager::PtyState::new();
    let dap_state = dap_manager::DebuggerSessions::new();

    // Clone for the exit handler closure
    let lsp_exit = lsp_state.clone();
    let pty_exit = pty_state.clone();
    let dap_exit = dap_state.clone();

    tauri::Builder::default()
        .manage(ProjectRoot(Mutex::new(None)))
        .manage(TerminalProcesses(Arc::new(Mutex::new(HashMap::new()))))
        .manage(FileWatcherHandle(Mutex::new(None)))
        .manage(ProjectIndexCache(Mutex::new(Vec::new())))
        .manage(CodebaseIndex(Mutex::new(None)))
        .manage(pty_state)
        .manage(lsp_state)
        .manage(dap_state)
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_store::Builder::default().build())
        .setup(|app| {
            // P2-15: Enable logging in all builds
            let log_level = if cfg!(debug_assertions) {
                log::LevelFilter::Info
            } else {
                log::LevelFilter::Warn
            };
            app.handle().plugin(
                tauri_plugin_log::Builder::default()
                    .level(log_level)
                    .build(),
            )?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            set_project_root,
            read_directory,
            read_file,
            path_exists,
            write_file,
            create_file,
            create_directory,
            delete_path,
            rename_path,
            reveal_path,
            search_project,
            run_terminal_command,
            check_tcp_port,
            start_terminal_process,
            stop_terminal_process,
            watch_project,
            stop_watching,
            call_llm,
            call_gemini_stream,
            call_openai_compatible_cmd,
            call_openai_compatible_stream,
            inspect_command,
            verify_path_safety,
            get_project_index,
            refresh_project_index,
            update_file_index,
            git_status,
            git_diff_file,
            git_log,
            git_branch,
            fuzzy_find_block,
            index_codebase,
            search_codebase,
            // Differ commands
            diff_strings,
            // Context builder commands
            build_ai_context,
            // SQLite persistence commands
            db_init,
            db_save_chat_session,
            db_load_chat_sessions,
            db_delete_chat_session,
            // DAP commands
            dap_manager::dap_start,
            dap_manager::dap_start_tcp,
            dap_manager::dap_send_request,
            dap_manager::dap_stop,
            // PTY commands
            pty_manager::terminal_create,
            pty_manager::terminal_write,
            pty_manager::terminal_resize,
            pty_manager::terminal_kill,
            // LSP commands
            lsp_manager::lsp_start,
            lsp_manager::lsp_did_open,
            lsp_manager::lsp_did_change,
            lsp_manager::lsp_did_save,
            lsp_manager::lsp_completion,
            lsp_manager::lsp_hover,
            lsp_manager::lsp_definition,
            lsp_manager::lsp_format,
            lsp_manager::lsp_shutdown,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(move |_app_handle, event| {
            if let tauri::RunEvent::Exit = event {
                // Graceful cleanup on app exit:
                // 1. Shut down all LSP servers
                lsp_manager::shutdown_all(&lsp_exit);

                // 2. Kill all PTY sessions
                pty_manager::kill_all(&pty_exit);

                // 3. Shut down all DAP sessions
                dap_manager::shutdown_all(&dap_exit);

                // 4. File watcher is dropped automatically when app exits
            }
        });
}
