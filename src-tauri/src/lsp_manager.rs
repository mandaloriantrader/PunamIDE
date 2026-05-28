//! LSP Manager — Language Server Protocol client implementation.
//! Spawns language servers, communicates via JSON-RPC over stdio,
//! and emits diagnostics/responses to the frontend.
//! Supports auto-restart with max retry limit.

use serde::Serialize;
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Emitter, State};

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

/// Tauri-managed state holding all LSP servers.
#[derive(Clone)]
pub struct LspState(pub Arc<Mutex<HashMap<String, LspServer>>>);

impl LspState {
    pub fn new() -> Self {
        Self(Arc::new(Mutex::new(HashMap::new())))
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
        let servers = state.0.lock().map_err(|_| "Lock error".to_string())?;
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
        let mut servers = state.0.lock().map_err(|_| "Lock error".to_string())?;
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
    std::thread::spawn(move || {
        read_lsp_stdout(stdout, &lang_id, &app_reader, &killed_reader, &stdin_for_reader, &lang_id_for_ready, &app_for_ready);
    });

    // Spawn child watcher for crash detection + auto-restart
    let lang_id_watch = language_id.to_string();
    let app_watch = app.clone();
    let killed_watch = killed.clone();
    let restart_count_watch = restart_count.clone();
    let _config_watch = config.clone();
    let _workspace_watch = workspace_root.to_string();
    // Clone the inner Arc so the thread can remove the dead server entry
    let state_inner = state.0.clone();
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
fn read_lsp_stdout(
    stdout: std::process::ChildStdout,
    language_id: &str,
    app: &AppHandle,
    killed: &Arc<AtomicBool>,
    stdin: &Arc<Mutex<std::process::ChildStdin>>,
    ready_lang_id: &str,
    ready_app: &AppHandle,
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
    let servers = state.0.lock().map_err(|_| "Lock error".to_string())?;
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
    let servers = state.0.lock().map_err(|_| "Lock error".to_string())?;
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
    let servers = state.0.lock().map_err(|_| "Lock error".to_string())?;
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
    let servers = state.0.lock().map_err(|_| "Lock error".to_string())?;
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
    let servers = state.0.lock().map_err(|_| "Lock error".to_string())?;
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
    let servers = state.0.lock().map_err(|_| "Lock error".to_string())?;
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
    let servers = state.0.lock().map_err(|_| "Lock error".to_string())?;
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
    let servers = state.0.lock().map_err(|_| "Lock error".to_string())?;
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
    let mut servers = state.0.lock().map_err(|_| "Lock error".to_string())?;
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
    if let Ok(mut servers) = state.0.lock() {
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
