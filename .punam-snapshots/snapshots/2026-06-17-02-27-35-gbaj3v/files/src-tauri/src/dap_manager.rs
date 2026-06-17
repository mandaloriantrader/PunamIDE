use std::collections::HashMap;
use std::process::Stdio;
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, State};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader as TokioBufReader};
use tokio::net::TcpStream;
use tokio::process::{Child as TokioChild, Command as TokioCommand};
use tokio::sync::mpsc;
use serde::{Deserialize, Serialize};

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

// ─── DAP Types ──────────────────────────────────────────────────────────────────

/// We manually deserialize DapMessage based on the "type" field
/// because serde's untagged enum can misclassify DAP messages.
#[derive(Serialize, Debug, Clone)]
pub enum DapMessage {
    Response(DapResponse),
    Event(DapEvent),
    Request(DapRequest),
}

impl<'de> Deserialize<'de> for DapMessage {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        let value = serde_json::Value::deserialize(deserializer)?;
        let type_field = value.get("type").and_then(|v| v.as_str()).unwrap_or("");

        match type_field {
            "response" => {
                let resp: DapResponse = serde_json::from_value(value).map_err(serde::de::Error::custom)?;
                Ok(DapMessage::Response(resp))
            }
            "event" => {
                let evt: DapEvent = serde_json::from_value(value).map_err(serde::de::Error::custom)?;
                Ok(DapMessage::Event(evt))
            }
            "request" => {
                let req: DapRequest = serde_json::from_value(value).map_err(serde::de::Error::custom)?;
                Ok(DapMessage::Request(req))
            }
            _ => {
                // Try response first, then event, then request as fallback
                if let Ok(resp) = serde_json::from_value::<DapResponse>(value.clone()) {
                    return Ok(DapMessage::Response(resp));
                }
                if let Ok(evt) = serde_json::from_value::<DapEvent>(value.clone()) {
                    return Ok(DapMessage::Event(evt));
                }
                if let Ok(req) = serde_json::from_value::<DapRequest>(value) {
                    return Ok(DapMessage::Request(req));
                }
                Err(serde::de::Error::custom("Unknown DAP message type"))
            }
        }
    }
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct DapRequest {
    pub seq: i32,
    #[serde(rename = "type")]
    pub r#type: String,
    pub command: String,
    #[serde(default)]
    pub arguments: serde_json::Value,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct DapResponse {
    pub seq: i32,
    #[serde(rename = "type")]
    pub r#type: String,
    pub request_seq: i32,
    pub success: bool,
    pub command: String,
    #[serde(default)]
    pub message: Option<String>,
    #[serde(default)]
    pub body: Option<serde_json::Value>,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct DapEvent {
    pub seq: i32,
    #[serde(rename = "type")]
    pub r#type: String,
    pub event: String,
    #[serde(default)]
    pub body: Option<serde_json::Value>,
}

#[derive(Serialize, Clone)]
pub struct DebuggerEvent {
    pub session_id: String,
    pub event_type: String,
    pub payload: serde_json::Value,
}

// ─── Session Management ─────────────────────────────────────────────────────────

struct DapSession {
    child: Option<TokioChild>,
    stdin_tx: mpsc::Sender<Vec<u8>>,
}

#[derive(Clone)]
pub struct DebuggerSessions(pub std::sync::Arc<Mutex<HashMap<String, DapSession>>>);

impl DebuggerSessions {
    pub fn new() -> Self {
        DebuggerSessions(std::sync::Arc::new(Mutex::new(HashMap::new())))
    }
}

// ─── DAP Message Framing ────────────────────────────────────────────────────────

fn encode_dap_message(json: &str) -> Vec<u8> {
    let header = format!("Content-Length: {}\r\n\r\n", json.len());
    let mut msg = header.into_bytes();
    msg.extend_from_slice(json.as_bytes());
    msg
}

/// Generic DAP message reader that works with any AsyncBufRead + AsyncRead stream.
async fn read_dap_message_generic<R: AsyncBufReadExt + AsyncReadExt + Unpin>(
    reader: &mut R,
) -> Option<String> {
    let mut content_length: usize = 0;

    loop {
        let mut line = String::new();
        match reader.read_line(&mut line).await {
            Ok(0) => return None,
            Ok(_) => {
                let trimmed = line.trim();
                if trimmed.is_empty() {
                    break;
                }
                // Case-insensitive header parsing (some adapters use different casing)
                let lower = trimmed.to_lowercase();
                if let Some(value) = lower.strip_prefix("content-length:") {
                    if let Ok(len) = value.trim().parse::<usize>() {
                        content_length = len;
                    }
                }
                // Skip other headers (e.g., Content-Type)
            }
            Err(_) => return None,
        }
    }

    if content_length == 0 {
        return None;
    }

    let mut body = vec![0u8; content_length];
    match reader.read_exact(&mut body).await {
        Ok(_) => String::from_utf8(body).ok(),
        Err(_) => None,
    }
}

/// Processes parsed DAP messages and emits them to the frontend.
fn emit_dap_message(app_handle: &AppHandle, session_id: &str, json_str: &str) {
    // Log all raw DAP messages for debugging
    log::info!("DAP RAW [{}]: {}", session_id, &json_str[..json_str.len().min(500)]);

    if let Ok(message) = serde_json::from_str::<DapMessage>(json_str) {
        let (event_type, payload) = match &message {
            DapMessage::Event(e) => {
                log::info!("DAP EVENT: seq={} event={}", e.seq, e.event);
                (e.event.clone(), serde_json::to_value(e).unwrap_or_default())
            }
            DapMessage::Response(r) => {
                log::info!("DAP RESPONSE: seq={} request_seq={} command={} success={}", r.seq, r.request_seq, r.command, r.success);
                (format!("response_{}", r.command), serde_json::to_value(r).unwrap_or_default())
            }
            DapMessage::Request(r) => {
                log::info!("DAP REVERSE_REQUEST: seq={} command={}", r.seq, r.command);
                (format!("reverse_request_{}", r.command), serde_json::to_value(r).unwrap_or_default())
            }
        };

        let _ = app_handle.emit(
            "debugger-event",
            DebuggerEvent {
                session_id: session_id.to_string(),
                event_type,
                payload,
            },
        );
    } else {
        log::warn!(
            "DAP: Could not parse message: {}",
            &json_str[..json_str.len().min(500)]
        );
    }
}

// ─── Commands ───────────────────────────────────────────────────────────────────

/// Start a debug adapter using stdio transport.
/// The adapter communicates via stdin/stdout with Content-Length framing.
#[tauri::command]
pub async fn dap_start(
    session_id: String,
    adapter_command: String,
    adapter_args: Vec<String>,
    cwd: String,
    app_handle: AppHandle,
    state: State<'_, DebuggerSessions>,
) -> Result<(), String> {
    let mut cmd = TokioCommand::new(&adapter_command);
    cmd.args(&adapter_args)
        .current_dir(&cwd)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);

    #[cfg(target_os = "windows")]
    cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("Failed to spawn debug adapter '{}': {}", adapter_command, e))?;

    let stdin = child.stdin.take().ok_or("Failed to get adapter stdin")?;
    let stdout = child.stdout.take().ok_or("Failed to get adapter stdout")?;
    let stderr = child.stderr.take().ok_or("Failed to get adapter stderr")?;

    // Channel for sending requests to the adapter
    let (stdin_tx, mut stdin_rx) = mpsc::channel::<Vec<u8>>(64);

    // Task: write requests to adapter stdin
    let mut stdin_writer = stdin;
    tauri::async_runtime::spawn(async move {
        while let Some(data) = stdin_rx.recv().await {
            if stdin_writer.write_all(&data).await.is_err() {
                break;
            }
            if stdin_writer.flush().await.is_err() {
                break;
            }
        }
    });

    // Task: read DAP messages from adapter stdout
    let app_handle_stdout = app_handle.clone();
    let session_id_stdout = session_id.clone();
    tauri::async_runtime::spawn(async move {
        let mut reader = TokioBufReader::new(stdout);
        while let Some(json_str) = read_dap_message_generic(&mut reader).await {
            emit_dap_message(&app_handle_stdout, &session_id_stdout, &json_str);
        }
        // Adapter stdout closed
        let _ = app_handle_stdout.emit(
            "debugger-event",
            DebuggerEvent {
                session_id: session_id_stdout.clone(),
                event_type: "terminated".to_string(),
                payload: serde_json::json!({"reason": "adapter_stdout_closed"}),
            },
        );
    });

    // Task: read stderr for logging
    spawn_stderr_reader(app_handle.clone(), session_id.clone(), stderr);

    // Store the session
    let session = DapSession {
        child: Some(child),
        stdin_tx,
    };
    state
        .0
        .lock()
        .map_err(|e| e.to_string())?
        .insert(session_id, session);

    Ok(())
}

/// Start a debug adapter using TCP transport.
/// Spawns the adapter process (which listens on a port), waits briefly,
/// then connects to host:port and communicates via TCP with Content-Length framing.
#[tauri::command]
pub async fn dap_start_tcp(
    session_id: String,
    adapter_command: String,
    adapter_args: Vec<String>,
    cwd: String,
    host: String,
    port: u16,
    app_handle: AppHandle,
    state: State<'_, DebuggerSessions>,
) -> Result<(), String> {
    // Spawn the adapter process (it will listen on host:port)
    let mut cmd = TokioCommand::new(&adapter_command);
    cmd.args(&adapter_args)
        .current_dir(&cwd)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);

    #[cfg(target_os = "windows")]
    cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("Failed to spawn debug adapter '{}': {}", adapter_command, e))?;

    // Capture stderr for logging (adapter may print startup info here)
    if let Some(stderr) = child.stderr.take() {
        spawn_stderr_reader(app_handle.clone(), session_id.clone(), stderr);
    }
    // Capture stdout too (some adapters print to stdout before DAP starts)
    if let Some(stdout) = child.stdout.take() {
        let app_h = app_handle.clone();
        let sid = session_id.clone();
        tauri::async_runtime::spawn(async move {
            let mut reader = TokioBufReader::new(stdout);
            let mut buf = vec![0u8; 4096];
            loop {
                match reader.read(&mut buf).await {
                    Ok(0) => break,
                    Ok(n) => {
                        let output = String::from_utf8_lossy(&buf[..n]).to_string();
                        let _ = app_h.emit(
                            "debugger-stderr",
                            DebuggerEvent {
                                session_id: sid.clone(),
                                event_type: "adapter_stdout".to_string(),
                                payload: serde_json::json!({"output": output}),
                            },
                        );
                    }
                    Err(_) => break,
                }
            }
        });
    }

    // Wait for the adapter to start listening (retry connection)
    let addr = format!("{}:{}", host, port);
    let mut tcp_stream: Option<TcpStream> = None;
    let max_retries = 20; // 20 * 250ms = 5 seconds max wait
    for attempt in 0..max_retries {
        match TcpStream::connect(&addr).await {
            Ok(stream) => {
                tcp_stream = Some(stream);
                log::info!("DAP TCP: Connected to {} on attempt {}", addr, attempt + 1);
                break;
            }
            Err(_) => {
                if attempt < max_retries - 1 {
                    tokio::time::sleep(tokio::time::Duration::from_millis(250)).await;
                }
            }
        }
    }

    let stream = tcp_stream.ok_or_else(|| {
        format!(
            "Failed to connect to debug adapter at {} after 5 seconds. Is the adapter running?",
            addr
        )
    })?;

    // Split TCP stream into read and write halves
    let (tcp_read, mut tcp_write) = stream.into_split();

    // Channel for sending requests to the adapter via TCP
    let (stdin_tx, mut stdin_rx) = mpsc::channel::<Vec<u8>>(64);

    // Task: write requests to TCP stream
    tauri::async_runtime::spawn(async move {
        while let Some(data) = stdin_rx.recv().await {
            if tcp_write.write_all(&data).await.is_err() {
                break;
            }
            if tcp_write.flush().await.is_err() {
                break;
            }
        }
    });

    // Task: read DAP messages from TCP stream
    let app_handle_tcp = app_handle.clone();
    let session_id_tcp = session_id.clone();
    tauri::async_runtime::spawn(async move {
        let mut reader = TokioBufReader::new(tcp_read);
        while let Some(json_str) = read_dap_message_generic(&mut reader).await {
            emit_dap_message(&app_handle_tcp, &session_id_tcp, &json_str);
        }
        // TCP connection closed
        let _ = app_handle_tcp.emit(
            "debugger-event",
            DebuggerEvent {
                session_id: session_id_tcp.clone(),
                event_type: "terminated".to_string(),
                payload: serde_json::json!({"reason": "tcp_connection_closed"}),
            },
        );
    });

    // Store the session
    let session = DapSession {
        child: Some(child),
        stdin_tx,
    };
    state
        .0
        .lock()
        .map_err(|e| e.to_string())?
        .insert(session_id, session);

    Ok(())
}

#[tauri::command]
pub async fn dap_send_request(
    session_id: String,
    request: DapRequest,
    state: State<'_, DebuggerSessions>,
) -> Result<(), String> {
    let tx = {
        let sessions = state.0.lock().map_err(|e| e.to_string())?;
        let session = sessions.get(&session_id).ok_or("Debug session not found")?;
        session.stdin_tx.clone()
    };

    let json = serde_json::to_string(&request).map_err(|e| e.to_string())?;
    let encoded = encode_dap_message(&json);

    tx.send(encoded)
        .await
        .map_err(|_| "Failed to send request to adapter (channel closed)".to_string())?;

    Ok(())
}

#[tauri::command]
pub async fn dap_stop(
    session_id: String,
    state: State<'_, DebuggerSessions>,
) -> Result<(), String> {
    let mut session = {
        let mut sessions = state.0.lock().map_err(|e| e.to_string())?;
        sessions.remove(&session_id).ok_or("Debug session not found")?
    };

    // Drop the sender channel to close the write task
    drop(session.stdin_tx);

    // Kill the child process
    if let Some(ref mut child) = session.child {
        let _ = child.kill().await;
    }

    Ok(())
}

pub fn shutdown_all(state: &DebuggerSessions) {
    if let Ok(mut sessions) = state.0.lock() {
        for (_, mut session) in sessions.drain() {
            drop(session.stdin_tx);
            if let Some(ref mut child) = session.child {
                let _ = child.start_kill();
            }
        }
    }
}

// ─── Helpers ────────────────────────────────────────────────────────────────────

fn spawn_stderr_reader(
    app_handle: AppHandle,
    session_id: String,
    stderr: tokio::process::ChildStderr,
) {
    tauri::async_runtime::spawn(async move {
        let mut reader = TokioBufReader::new(stderr);
        let mut buf = vec![0u8; 4096];
        loop {
            match reader.read(&mut buf).await {
                Ok(0) => break,
                Ok(n) => {
                    let output = String::from_utf8_lossy(&buf[..n]).to_string();
                    let _ = app_handle.emit(
                        "debugger-stderr",
                        DebuggerEvent {
                            session_id: session_id.clone(),
                            event_type: "stderr".to_string(),
                            payload: serde_json::json!({"output": output}),
                        },
                    );
                }
                Err(_) => break,
            }
        }
    });
}
