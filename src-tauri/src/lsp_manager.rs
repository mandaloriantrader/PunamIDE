//! LSP Manager — Language Server Protocol client implementation.
//! Spawns language servers, communicates via JSON-RPC over stdio,
//! and emits diagnostics/responses to the frontend.
//! Supports auto-restart with max retry limit.

use serde::Serialize;
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::path::Path;
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Emitter, State};
use tokio::sync::oneshot;

// --- Configuration ---

const MAX_RESTART_ATTEMPTS: u32 = 3;
const RESTART_DELAY_MS: u64 = 2000;

/// Known language server configurations.
#[derive(Clone, Debug)]
pub struct LspServerConfig {
    pub language_id: String,
    pub command: String,
    pub args: Vec<String>,
}

fn get_server_config(language_id: &str) -> Option<LspServerConfig> {
    match language_id {
        "typescript" | "javascript" => Some(LspServerConfig {
            language_id: "typescript".to_string(),
            command: "typescript-language-server".to_string(),
            args: vec!["--stdio".to_string()],
        }),
        "rust" => Some(LspServerConfig {
            language_id: "rust".to_string(),
            command: "rust-analyzer".to_string(),
            args: vec![],
        }),
        "python" => Some(LspServerConfig {
            language_id: "python".to_string(),
            command: "pyright-langserver".to_string(),
            args: vec!["--stdio".to_string()],
        }),
        "json" => Some(LspServerConfig {
            language_id: "json".to_string(),
            command: "vscode-json-language-server".to_string(),
            args: vec!["--stdio".to_string()],
        }),
        "go" => Some(LspServerConfig {
            language_id: "go".to_string(),
            command: "gopls".to_string(),
            args: vec![],
        }),
        "c" | "cpp" | "objc" | "objcpp" => Some(LspServerConfig {
            language_id: language_id.to_string(),
            command: "clangd".to_string(),
            args: vec![],
        }),
        "php" => Some(LspServerConfig {
            language_id: "php".to_string(),
            command: "intelephense".to_string(),
            args: vec!["--stdio".to_string()],
        }),
        "ruby" => Some(LspServerConfig {
            language_id: "ruby".to_string(),
            command: "solargraph".to_string(),
            args: vec!["stdio".to_string()],
        }),
        "css" | "scss" | "less" => Some(LspServerConfig {
            language_id: language_id.to_string(),
            command: "vscode-css-language-server".to_string(),
            args: vec!["--stdio".to_string()],
        }),
        "html" => Some(LspServerConfig {
            language_id: "html".to_string(),
            command: "vscode-html-language-server".to_string(),
            args: vec!["--stdio".to_string()],
        }),
        "yaml" => Some(LspServerConfig {
            language_id: "yaml".to_string(),
            command: "yaml-language-server".to_string(),
            args: vec!["--stdio".to_string()],
        }),
        "toml" => Some(LspServerConfig {
            language_id: "toml".to_string(),
            command: "taplo".to_string(),
            args: vec!["lsp".to_string(), "stdio".to_string()],
        }),
        "svelte" => Some(LspServerConfig {
            language_id: "svelte".to_string(),
            command: "svelteserver".to_string(),
            args: vec!["--stdio".to_string()],
        }),
        "vue" => Some(LspServerConfig {
            language_id: "vue".to_string(),
            command: "vue-language-server".to_string(),
            args: vec!["--stdio".to_string()],
        }),
        _ => None,
    }
}

// --- Types ---

#[derive(Serialize, Clone, Debug)]
pub struct LspStatusEvent {
    pub language_id: String,
    pub status: String, // "starting", "ready", "crashed", "restarting", "stopped"
    pub error: Option<String>,
}

#[derive(Serialize, Clone)]
pub struct LspResponseEvent {
    pub language_id: String,
    pub id: Option<i64>,
    pub result: Option<String>,  // JSON string
    pub error: Option<String>,
}

#[derive(Serialize, Clone)]
pub struct LspDiagnosticsEvent {
    pub language_id: String,
    pub uri: String,
    pub diagnostics: String, // JSON array string
}

/// Internal state for a running LSP server.
pub struct LspServer {
    pub stdin: Arc<Mutex<std::process::ChildStdin>>,
    pub killed: Arc<AtomicBool>,
    pub restart_count: Arc<AtomicU32>,
    pub request_id: Arc<AtomicU32>,
    pub workspace_root: String,
}

/// Pending request channels — allows synchronous waiting for specific LSP responses.
/// Maps request_id → oneshot sender that delivers the raw JSON result string.
pub type PendingRequests = Arc<Mutex<HashMap<i64, oneshot::Sender<Result<String, String>>>>>;

/// Tauri-managed state holding all LSP servers.
#[derive(Clone)]
pub struct LspState {
    pub servers: Arc<Mutex<HashMap<String, LspServer>>>,
    pub pending: PendingRequests,
}

impl LspState {
    pub fn new() -> Self {
        Self {
            servers: Arc::new(Mutex::new(HashMap::new())),
            pending: Arc::new(Mutex::new(HashMap::new())),
        }
    }
}

// --- JSON-RPC Helpers ---

fn encode_message(content: &str) -> Vec<u8> {
    let header = format!("Content-Length: {}\r\n\r\n", content.len());
    let mut bytes = header.into_bytes();
    bytes.extend_from_slice(content.as_bytes());
    bytes
}

fn send_to_stdin(stdin: &Arc<Mutex<std::process::ChildStdin>>, content: &str) -> Result<(), String> {
    let encoded = encode_message(content);
    let mut writer = stdin.lock().map_err(|_| "Stdin lock error".to_string())?;
    writer.write_all(&encoded).map_err(|e| format!("Write error: {}", e))?;
    writer.flush().map_err(|e| format!("Flush error: {}", e))?;
    Ok(())
}

// --- Tauri Commands ---

/// Start an LSP server for a given language.
#[tauri::command]
pub fn lsp_start(
    workspace_root: String,
    language_id: String,
    app: AppHandle,
    state: State<LspState>,
) -> Result<(), String> {
    let config = get_server_config(&language_id)
        .ok_or_else(|| format!("No LSP server configured for '{}'", language_id))?;

    // Check if already running
    {
        let servers = state.servers.lock().map_err(|_| "Lock error".to_string())?;
        if servers.contains_key(&language_id) {
            return Ok(()); // Already running
        }
    }

    // Emit starting status
    let _ = app.emit("lsp-status", LspStatusEvent {
        language_id: language_id.clone(),
        status: "starting".to_string(),
        error: None,
    });

    spawn_lsp_server(&config, &workspace_root, &language_id, &app, &state)
}

fn spawn_lsp_server(
    config: &LspServerConfig,
    workspace_root: &str,
    language_id: &str,
    app: &AppHandle,
    state: &State<LspState>,
) -> Result<(), String> {
    // On Windows, npm global packages are .cmd batch wrappers.
    // We need to spawn them via cmd.exe to resolve properly.
    #[cfg(target_os = "windows")]
    let mut cmd = {
        let mut c = Command::new("cmd");
        c.arg("/C").arg(&config.command);
        c.args(&config.args);
        c
    };

    #[cfg(not(target_os = "windows"))]
    let mut cmd = {
        let mut c = Command::new(&config.command);
        c.args(&config.args);
        c
    };

    cmd.stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .current_dir(workspace_root);

    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
    }

    let mut child = cmd.spawn().map_err(|e| {
        let err_msg = format!("Failed to start '{}': {}. Is it installed?", config.command, e);
        let _ = app.emit("lsp-status", LspStatusEvent {
            language_id: language_id.to_string(),
            status: "crashed".to_string(),
            error: Some(err_msg.clone()),
        });
        err_msg
    })?;

    let stdin = child.stdin.take().ok_or("Failed to get LSP stdin")?;
    let stdout = child.stdout.take().ok_or("Failed to get LSP stdout")?;
    let _stderr = child.stderr.take(); // Consume to avoid blocking

    let killed = Arc::new(AtomicBool::new(false));
    let restart_count = Arc::new(AtomicU32::new(0));
    let request_id = Arc::new(AtomicU32::new(10)); // Start after init

    let stdin_arc = Arc::new(Mutex::new(stdin));

    // Store server
    {
        let mut servers = state.servers.lock().map_err(|_| "Lock error".to_string())?;
        servers.insert(language_id.to_string(), LspServer {
            stdin: stdin_arc.clone(),
            killed: killed.clone(),
            restart_count: restart_count.clone(),
            request_id: request_id.clone(),
            workspace_root: workspace_root.to_string(),
        });
    }

    // Send initialize request
    let root_uri = path_to_uri(workspace_root);
    let init_request = serde_json::json!({
        "jsonrpc": "2.0",
        "id": 1,
        "method": "initialize",
        "params": {
            "processId": std::process::id(),
            "rootUri": root_uri,
            "capabilities": {
                "textDocument": {
                    "completion": {
                        "completionItem": {
                            "snippetSupport": true,
                            "resolveSupport": { "properties": ["documentation", "detail"] }
                        }
                    },
                    "hover": { "contentFormat": ["markdown", "plaintext"] },
                    "definition": { "linkSupport": true },
                    "references": {},
                    "formatting": {},
                    "publishDiagnostics": { "relatedInformation": true },
                    "synchronization": { "didSave": true, "willSave": false }
                },
                "workspace": { "workspaceFolders": true }
            },
            "workspaceFolders": [{
                "uri": root_uri,
                "name": workspace_root.split(['/', '\\']).last().unwrap_or("project")
            }]
        }
    });

    send_to_stdin(&stdin_arc, &init_request.to_string())?;

    // Spawn stdout reader thread
    let lang_id = language_id.to_string();
    let app_reader = app.clone();
    let killed_reader = killed.clone();
    let stdin_for_reader = stdin_arc.clone();
    let lang_id_for_ready = language_id.to_string();
    let app_for_ready = app.clone();
    let pending_for_reader = state.pending.clone();
    std::thread::spawn(move || {
        read_lsp_stdout(stdout, &lang_id, &app_reader, &killed_reader, &stdin_for_reader, &lang_id_for_ready, &app_for_ready, &pending_for_reader);
    });

    // Spawn child watcher for crash detection + auto-restart
    let lang_id_watch = language_id.to_string();
    let app_watch = app.clone();
    let killed_watch = killed.clone();
    let restart_count_watch = restart_count.clone();
    let _config_watch = config.clone();
    let _workspace_watch = workspace_root.to_string();
    // Clone the inner Arc so the thread can remove the dead server entry
    let state_inner = state.servers.clone();
    std::thread::spawn(move || {
        let _ = child.wait(); // Block until process exits

        if killed_watch.load(Ordering::SeqCst) {
            return; // Intentionally killed, don't restart
        }

        // Remove the dead server from state so lsp_start can be called again
        if let Ok(mut servers) = state_inner.lock() {
            servers.remove(&lang_id_watch);
        }

        let attempts = restart_count_watch.fetch_add(1, Ordering::SeqCst);
        if attempts >= MAX_RESTART_ATTEMPTS {
            let _ = app_watch.emit("lsp-status", LspStatusEvent {
                language_id: lang_id_watch.clone(),
                status: "crashed".to_string(),
                error: Some(format!("Server crashed {} times. Not restarting.", MAX_RESTART_ATTEMPTS)),
            });
            return;
        }

        // Auto-restart
        let _ = app_watch.emit("lsp-status", LspStatusEvent {
            language_id: lang_id_watch.clone(),
            status: "restarting".to_string(),
            error: Some(format!("Restarting (attempt {}/{})", attempts + 1, MAX_RESTART_ATTEMPTS)),
        });

        std::thread::sleep(Duration::from_millis(RESTART_DELAY_MS));

        // Emit crashed status so the frontend can call lsp_start again
        let _ = app_watch.emit("lsp-status", LspStatusEvent {
            language_id: lang_id_watch,
            status: "crashed".to_string(),
            error: Some("Server exited unexpectedly. Restart available.".to_string()),
        });
    });

    Ok(())
}

/// Read JSON-RPC messages from LSP stdout and emit events.
/// Also handles the initialize response: sends `initialized` notification and emits "ready".
/// Routes responses to pending request channels if registered.
fn read_lsp_stdout(
    stdout: std::process::ChildStdout,
    language_id: &str,
    app: &AppHandle,
    killed: &Arc<AtomicBool>,
    stdin: &Arc<Mutex<std::process::ChildStdin>>,
    ready_lang_id: &str,
    ready_app: &AppHandle,
    pending: &PendingRequests,
) {
    let mut reader = BufReader::new(stdout);
    let mut initialized_sent = false;

    loop {
        if killed.load(Ordering::SeqCst) { break; }

        // Read headers
        let mut content_length: usize = 0;
        loop {
            let mut line = String::new();
            match reader.read_line(&mut line) {
                Ok(0) => return, // EOF
                Ok(_) => {
                    let trimmed = line.trim();
                    if trimmed.is_empty() { break; }
                    if let Some(len_str) = trimmed.strip_prefix("Content-Length: ") {
                        content_length = len_str.parse().unwrap_or(0);
                    }
                }
                Err(_) => return,
            }
        }

        if content_length == 0 { continue; }

        // Read body
        let mut body = vec![0u8; content_length];
        if reader.read_exact(&mut body).is_err() { return; }

        let message = String::from_utf8_lossy(&body).to_string();

        // Parse and route
        if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(&message) {
            let method = parsed.get("method").and_then(|m| m.as_str());
            let id = parsed.get("id").and_then(|i| i.as_i64());

            if method == Some("textDocument/publishDiagnostics") {
                // Diagnostics notification
                if let Some(params) = parsed.get("params") {
                    let uri = params.get("uri").and_then(|u| u.as_str()).unwrap_or("").to_string();
                    let diagnostics = params.get("diagnostics").map(|d| d.to_string()).unwrap_or("[]".to_string());
                    let _ = app.emit("lsp-diagnostics", LspDiagnosticsEvent {
                        language_id: language_id.to_string(),
                        uri,
                        diagnostics,
                    });
                }
            } else if id.is_some() && parsed.get("method").is_none() {
                // Response to a request
                let resp_id = id.unwrap();

                // Handle initialize response (id: 1) — send initialized notification + emit ready
                if resp_id == 1 && !initialized_sent {
                    initialized_sent = true;

                    // Send the required "initialized" notification (LSP protocol requirement)
                    let initialized_notif = serde_json::json!({
                        "jsonrpc": "2.0",
                        "method": "initialized",
                        "params": {}
                    });
                    let _ = send_to_stdin(stdin, &initialized_notif.to_string());

                    // Now the server is truly ready
                    let _ = ready_app.emit("lsp-status", LspStatusEvent {
                        language_id: ready_lang_id.to_string(),
                        status: "ready".to_string(),
                        error: None,
                    });
                }

                // Check if there's a pending channel waiting for this response
                let pending_sender = if let Ok(mut map) = pending.lock() {
                    map.remove(&resp_id)
                } else {
                    None
                };

                if let Some(sender) = pending_sender {
                    // Route to the waiting channel
                    if let Some(error) = parsed.get("error") {
                        let err_msg = error.get("message")
                            .and_then(|m| m.as_str())
                            .unwrap_or("Unknown LSP error")
                            .to_string();
                        let _ = sender.send(Err(err_msg));
                    } else {
                        let result_str = parsed.get("result")
                            .map(|r| r.to_string())
                            .unwrap_or("null".to_string());
                        let _ = sender.send(Ok(result_str));
                    }
                } else {
                    // Emit response to frontend (for completion, hover, etc.)
                    let result = parsed.get("result").map(|r| r.to_string());
                    let error = parsed.get("error").map(|e| {
                        e.get("message").and_then(|m| m.as_str()).unwrap_or("Unknown error").to_string()
                    });
                    let _ = app.emit("lsp-response", LspResponseEvent {
                        language_id: language_id.to_string(),
                        id: Some(resp_id),
                        result,
                        error,
                    });
                }
            }
            // Ignore other notifications (window/logMessage, etc.)
        }
    }
}

// --- Document Sync Commands ---

#[tauri::command]
pub fn lsp_did_open(
    file_uri: String,
    language_id: String,
    text: String,
    state: State<LspState>,
) -> Result<(), String> {
    let servers = state.servers.lock().map_err(|_| "Lock error".to_string())?;
    let server = servers.get(&language_id)
        .ok_or_else(|| format!("LSP server for '{}' not running", language_id))?;

    let notification = serde_json::json!({
        "jsonrpc": "2.0",
        "method": "textDocument/didOpen",
        "params": {
            "textDocument": {
                "uri": file_uri,
                "languageId": language_id,
                "version": 1,
                "text": text
            }
        }
    });

    send_to_stdin(&server.stdin, &notification.to_string())
}

#[tauri::command]
pub fn lsp_did_change(
    file_uri: String,
    language_id: String,
    version: i32,
    text: String,
    state: State<LspState>,
) -> Result<(), String> {
    let servers = state.servers.lock().map_err(|_| "Lock error".to_string())?;
    let server = servers.get(&language_id)
        .ok_or_else(|| format!("LSP server for '{}' not running", language_id))?;

    let notification = serde_json::json!({
        "jsonrpc": "2.0",
        "method": "textDocument/didChange",
        "params": {
            "textDocument": { "uri": file_uri, "version": version },
            "contentChanges": [{ "text": text }]
        }
    });

    send_to_stdin(&server.stdin, &notification.to_string())
}

#[tauri::command]
pub fn lsp_did_save(
    file_uri: String,
    language_id: String,
    state: State<LspState>,
) -> Result<(), String> {
    let servers = state.servers.lock().map_err(|_| "Lock error".to_string())?;
    let server = servers.get(&language_id)
        .ok_or_else(|| format!("LSP server for '{}' not running", language_id))?;

    let notification = serde_json::json!({
        "jsonrpc": "2.0",
        "method": "textDocument/didSave",
        "params": { "textDocument": { "uri": file_uri } }
    });

    send_to_stdin(&server.stdin, &notification.to_string())
}

#[tauri::command]
pub fn lsp_did_close(
    file_uri: String,
    language_id: String,
    state: State<LspState>,
) -> Result<(), String> {
    let servers = state.servers.lock().map_err(|_| "Lock error".to_string())?;
    let server = servers.get(&language_id)
        .ok_or_else(|| format!("LSP server for '{}' not running", language_id))?;

    let notification = serde_json::json!({
        "jsonrpc": "2.0",
        "method": "textDocument/didClose",
        "params": { "textDocument": { "uri": file_uri } }
    });

    send_to_stdin(&server.stdin, &notification.to_string())
}

// --- Request Commands ---

#[tauri::command]
pub fn lsp_completion(
    file_uri: String,
    language_id: String,
    line: u32,
    character: u32,
    state: State<LspState>,
) -> Result<i64, String> {
    let servers = state.servers.lock().map_err(|_| "Lock error".to_string())?;
    let server = servers.get(&language_id)
        .ok_or_else(|| format!("LSP server for '{}' not running", language_id))?;

    let id = server.request_id.fetch_add(1, Ordering::SeqCst) as i64;

    let request = serde_json::json!({
        "jsonrpc": "2.0",
        "id": id,
        "method": "textDocument/completion",
        "params": {
            "textDocument": { "uri": file_uri },
            "position": { "line": line, "character": character }
        }
    });

    send_to_stdin(&server.stdin, &request.to_string())?;
    Ok(id)
}

#[tauri::command]
pub fn lsp_hover(
    file_uri: String,
    language_id: String,
    line: u32,
    character: u32,
    state: State<LspState>,
) -> Result<i64, String> {
    let servers = state.servers.lock().map_err(|_| "Lock error".to_string())?;
    let server = servers.get(&language_id)
        .ok_or_else(|| format!("LSP server for '{}' not running", language_id))?;

    let id = server.request_id.fetch_add(1, Ordering::SeqCst) as i64;

    let request = serde_json::json!({
        "jsonrpc": "2.0",
        "id": id,
        "method": "textDocument/hover",
        "params": {
            "textDocument": { "uri": file_uri },
            "position": { "line": line, "character": character }
        }
    });

    send_to_stdin(&server.stdin, &request.to_string())?;
    Ok(id)
}

#[tauri::command]
pub fn lsp_definition(
    file_uri: String,
    language_id: String,
    line: u32,
    character: u32,
    state: State<LspState>,
) -> Result<i64, String> {
    let servers = state.servers.lock().map_err(|_| "Lock error".to_string())?;
    let server = servers.get(&language_id)
        .ok_or_else(|| format!("LSP server for '{}' not running", language_id))?;

    let id = server.request_id.fetch_add(1, Ordering::SeqCst) as i64;

    let request = serde_json::json!({
        "jsonrpc": "2.0",
        "id": id,
        "method": "textDocument/definition",
        "params": {
            "textDocument": { "uri": file_uri },
            "position": { "line": line, "character": character }
        }
    });

    send_to_stdin(&server.stdin, &request.to_string())?;
    Ok(id)
}

#[tauri::command]
pub fn lsp_format(
    file_uri: String,
    language_id: String,
    state: State<LspState>,
) -> Result<i64, String> {
    let servers = state.servers.lock().map_err(|_| "Lock error".to_string())?;
    let server = servers.get(&language_id)
        .ok_or_else(|| format!("LSP server for '{}' not running", language_id))?;

    let id = server.request_id.fetch_add(1, Ordering::SeqCst) as i64;

    let request = serde_json::json!({
        "jsonrpc": "2.0",
        "id": id,
        "method": "textDocument/formatting",
        "params": {
            "textDocument": { "uri": file_uri },
            "options": { "tabSize": 2, "insertSpaces": true }
        }
    });

    send_to_stdin(&server.stdin, &request.to_string())?;
    Ok(id)
}

// --- Shutdown ---

#[tauri::command]
pub fn lsp_shutdown(
    language_id: String,
    state: State<LspState>,
) -> Result<(), String> {
    let mut servers = state.servers.lock().map_err(|_| "Lock error".to_string())?;
    if let Some(server) = servers.remove(&language_id) {
        server.killed.store(true, Ordering::SeqCst);

        // Send shutdown request
        let shutdown = serde_json::json!({
            "jsonrpc": "2.0",
            "id": 9999,
            "method": "shutdown",
            "params": null
        });
        let _ = send_to_stdin(&server.stdin, &shutdown.to_string());

        // Send exit notification
        std::thread::sleep(Duration::from_millis(100));
        let exit = serde_json::json!({ "jsonrpc": "2.0", "method": "exit" });
        let _ = send_to_stdin(&server.stdin, &exit.to_string());
    }
    Ok(())
}

/// Shutdown all LSP servers — called on app exit.
pub fn shutdown_all(state: &LspState) {
    if let Ok(mut servers) = state.servers.lock() {
        for (_, server) in servers.drain() {
            server.killed.store(true, Ordering::SeqCst);
            let shutdown = serde_json::json!({
                "jsonrpc": "2.0", "id": 9999, "method": "shutdown", "params": null
            });
            let _ = send_to_stdin(&server.stdin, &shutdown.to_string());
            let exit = serde_json::json!({ "jsonrpc": "2.0", "method": "exit" });
            let _ = send_to_stdin(&server.stdin, &exit.to_string());
        }
    }
}

// --- Utility ---

fn path_to_uri(path: &str) -> String {
    let normalized = path.replace('\\', "/");
    if normalized.starts_with('/') {
        format!("file://{}", normalized)
    } else {
        format!("file:///{}", normalized)
    }
}

fn uri_to_path(uri: &str) -> String {
    let path = uri
        .strip_prefix("file:///")
        .or_else(|| uri.strip_prefix("file://"))
        .unwrap_or(uri);
    // On Windows, URIs look like file:///C:/path — keep the drive letter
    // On Unix, file:///path — starts with /
    #[cfg(target_os = "windows")]
    {
        path.replace('/', "\\")
    }
    #[cfg(not(target_os = "windows"))]
    {
        format!("/{}", path)
    }
}

/// Detect language_id from file extension.
fn detect_language_id(file_path: &str) -> Option<String> {
    let ext = Path::new(file_path)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("");
    match ext {
        "ts" | "tsx" | "js" | "jsx" | "mjs" | "cjs" => Some("typescript".to_string()),
        "rs" => Some("rust".to_string()),
        "py" | "pyw" => Some("python".to_string()),
        "json" => Some("json".to_string()),
        "go" => Some("go".to_string()),
        "c" => Some("c".to_string()),
        "cpp" | "cc" | "cxx" | "h" | "hpp" => Some("cpp".to_string()),
        "php" => Some("php".to_string()),
        "rb" => Some("ruby".to_string()),
        "css" => Some("css".to_string()),
        "scss" => Some("scss".to_string()),
        "less" => Some("less".to_string()),
        "html" | "htm" => Some("html".to_string()),
        "yaml" | "yml" => Some("yaml".to_string()),
        "toml" => Some("toml".to_string()),
        "svelte" => Some("svelte".to_string()),
        "vue" => Some("vue".to_string()),
        _ => None,
    }
}

/// Read a context window of lines around a target line from a file.
/// Returns up to `window` lines centered on `target_line` (0-based).
fn read_context_window(file_path: &str, target_line: u32, window: u32) -> String {
    let Ok(content) = std::fs::read_to_string(file_path) else {
        return String::new();
    };
    let lines: Vec<&str> = content.lines().collect();
    let total = lines.len() as u32;
    if total == 0 {
        return String::new();
    }
    let half = window / 2;
    let start = target_line.saturating_sub(half) as usize;
    let end = std::cmp::min(target_line + half + 1, total) as usize;
    lines[start..end].join("\n")
}

// --- LSP Symbol Navigation Commands ---

/// Location result from LSP references.
#[derive(Serialize, Clone, Debug)]
pub struct LspLocation {
    pub file_path: String,
    pub line: u32,
    pub column: u32,
    pub context: String,
}

/// Symbol info from LSP workspace/symbol.
#[derive(Serialize, Clone, Debug)]
pub struct LspSymbolInfo {
    pub name: String,
    pub kind: String,
    pub file_path: String,
    pub line: u32,
    pub container_name: Option<String>,
}

/// Map LSP SymbolKind number to a string.
fn symbol_kind_to_string(kind: u64) -> String {
    match kind {
        1 => "file".to_string(),
        2 => "module".to_string(),
        3 => "namespace".to_string(),
        4 => "package".to_string(),
        5 => "class".to_string(),
        6 => "method".to_string(),
        7 => "property".to_string(),
        8 => "field".to_string(),
        9 => "constructor".to_string(),
        10 => "enum".to_string(),
        11 => "interface".to_string(),
        12 => "function".to_string(),
        13 => "variable".to_string(),
        14 => "constant".to_string(),
        15 => "string".to_string(),
        16 => "number".to_string(),
        17 => "boolean".to_string(),
        18 => "array".to_string(),
        19 => "object".to_string(),
        20 => "key".to_string(),
        21 => "null".to_string(),
        22 => "enum_member".to_string(),
        23 => "struct".to_string(),
        24 => "event".to_string(),
        25 => "operator".to_string(),
        26 => "type_parameter".to_string(),
        _ => "unknown".to_string(),
    }
}

/// Helper: send an LSP request and wait for the response with a timeout.
/// Returns the raw JSON result string on success.
async fn send_lsp_request_await(
    state: &State<'_, LspState>,
    language_id: &str,
    method: &str,
    params: serde_json::Value,
    timeout_secs: u64,
) -> Result<String, String> {
    let (tx, rx) = oneshot::channel::<Result<String, String>>();

    let request_id = {
        let servers = state.servers.lock().map_err(|_| "Lock error".to_string())?;
        let server = servers.get(language_id)
            .ok_or_else(|| format!("LSP server for '{}' not running. Start the server first.", language_id))?;

        let id = server.request_id.fetch_add(1, Ordering::SeqCst) as i64;

        let request = serde_json::json!({
            "jsonrpc": "2.0",
            "id": id,
            "method": method,
            "params": params
        });

        send_to_stdin(&server.stdin, &request.to_string())?;
        id
    };

    // Register the pending response channel
    {
        let mut pending = state.pending.lock().map_err(|_| "Pending lock error".to_string())?;
        pending.insert(request_id, tx);
    }

    // Wait with timeout
    match tokio::time::timeout(Duration::from_secs(timeout_secs), rx).await {
        Ok(Ok(result)) => result,
        Ok(Err(_)) => {
            // Channel closed without sending — remove from pending
            if let Ok(mut pending) = state.pending.lock() {
                pending.remove(&request_id);
            }
            Err("LSP response channel closed unexpectedly".to_string())
        }
        Err(_) => {
            // Timeout — remove from pending
            if let Ok(mut pending) = state.pending.lock() {
                pending.remove(&request_id);
            }
            Err("LSP request timed out after 5 seconds".to_string())
        }
    }
}

/// Find all references to the symbol at the given position.
/// Uses LSP textDocument/references request.
/// Timeout: 5 seconds. Returns error if LSP unavailable or times out.
#[tauri::command]
pub async fn lsp_references(
    file_path: String,
    line: u32,
    col: u32,
    include_declaration: bool,
    state: State<'_, LspState>,
) -> Result<Vec<LspLocation>, String> {
    let language_id = detect_language_id(&file_path)
        .ok_or_else(|| format!("Cannot detect language for file: {}", file_path))?;

    let file_uri = path_to_uri(&file_path);

    let params = serde_json::json!({
        "textDocument": { "uri": file_uri },
        "position": { "line": line, "character": col },
        "context": { "includeDeclaration": include_declaration }
    });

    let result_str = send_lsp_request_await(
        &state, &language_id, "textDocument/references", params, 5
    ).await?;

    // Parse the LSP result — can be null or an array of Location objects
    let parsed: serde_json::Value = serde_json::from_str(&result_str)
        .map_err(|e| format!("Failed to parse LSP response: {}", e))?;

    if parsed.is_null() {
        return Ok(vec![]);
    }

    let locations = parsed.as_array()
        .ok_or_else(|| "Unexpected LSP references response format".to_string())?;

    let mut results: Vec<LspLocation> = Vec::new();

    for loc in locations {
        let uri = loc.get("uri").and_then(|u| u.as_str()).unwrap_or("");
        let range = loc.get("range").and_then(|r| r.as_object());

        if let Some(range) = range {
            let start = range.get("start").and_then(|s| s.as_object());
            if let Some(start) = start {
                let loc_line = start.get("line").and_then(|l| l.as_u64()).unwrap_or(0) as u32;
                let loc_col = start.get("character").and_then(|c| c.as_u64()).unwrap_or(0) as u32;
                let loc_path = uri_to_path(uri);
                let context = read_context_window(&loc_path, loc_line, 10);

                results.push(LspLocation {
                    file_path: loc_path,
                    line: loc_line,
                    column: loc_col,
                    context,
                });
            }
        }
    }

    Ok(results)
}

/// Search workspace symbols by name (case-insensitive substring match).
/// Uses LSP workspace/symbol request.
/// max_results valid range: 1–200, default 50.
/// Timeout: 5 seconds.
#[tauri::command]
pub async fn lsp_workspace_symbol(
    query: String,
    max_results: Option<usize>,
    state: State<'_, LspState>,
) -> Result<Vec<LspSymbolInfo>, String> {
    let max = max_results.unwrap_or(50).max(1).min(200);

    // We need to find an active LSP server to send the request to.
    // workspace/symbol is a workspace-level request — use any running server.
    let language_id = {
        let servers = state.servers.lock().map_err(|_| "Lock error".to_string())?;
        if servers.is_empty() {
            return Err("No LSP server is running. Start an LSP server first.".to_string());
        }
        // Pick the first available server
        servers.keys().next().unwrap().clone()
    };

    let params = serde_json::json!({
        "query": query
    });

    let result_str = send_lsp_request_await(
        &state, &language_id, "workspace/symbol", params, 5
    ).await?;

    // Parse the LSP result — can be null or an array of SymbolInformation objects
    let parsed: serde_json::Value = serde_json::from_str(&result_str)
        .map_err(|e| format!("Failed to parse LSP response: {}", e))?;

    if parsed.is_null() {
        return Ok(vec![]);
    }

    let symbols = parsed.as_array()
        .ok_or_else(|| "Unexpected LSP workspace/symbol response format".to_string())?;

    let query_lower = query.to_lowercase();
    let mut results: Vec<LspSymbolInfo> = Vec::new();

    for sym in symbols {
        let name = sym.get("name").and_then(|n| n.as_str()).unwrap_or("");

        // Case-insensitive substring match
        if !name.to_lowercase().contains(&query_lower) {
            continue;
        }

        let kind_num = sym.get("kind").and_then(|k| k.as_u64()).unwrap_or(0);
        let kind = symbol_kind_to_string(kind_num);

        let container_name = sym.get("containerName")
            .and_then(|c| c.as_str())
            .map(|s| s.to_string());

        // Location can be in "location" field (SymbolInformation) or "range" (DocumentSymbol)
        let (sym_path, sym_line) = if let Some(location) = sym.get("location") {
            let uri = location.get("uri").and_then(|u| u.as_str()).unwrap_or("");
            let loc_line = location.get("range")
                .and_then(|r| r.get("start"))
                .and_then(|s| s.get("line"))
                .and_then(|l| l.as_u64())
                .unwrap_or(0) as u32;
            (uri_to_path(uri), loc_line)
        } else {
            continue; // Skip entries without location
        };

        results.push(LspSymbolInfo {
            name: name.to_string(),
            kind,
            file_path: sym_path,
            line: sym_line,
            container_name,
        });

        if results.len() >= max {
            break;
        }
    }

    Ok(results)
}
