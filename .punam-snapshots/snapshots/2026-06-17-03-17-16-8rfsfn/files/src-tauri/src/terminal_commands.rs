use std::net::{TcpStream, ToSocketAddrs};
use std::process::Command;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::sync::Mutex;
use std::time::Duration;
use std::collections::HashMap;
use tauri::{AppHandle, Emitter, State};
use tokio::process::Command as TokioCommand;

use crate::CmdResult;
use crate::PortCheckResult;
use crate::TerminalProcessHandle;
use crate::TerminalProcesses;

fn command_shell(command: &str) -> (String, Vec<String>) {
    if cfg!(target_os = "windows") {
        let powershell = std::env::var("SystemRoot")
            .map(|root| format!("{}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe", root))
            .unwrap_or_else(|_| "powershell.exe".to_string());
        (
            powershell,
            vec![
                "-NoLogo".to_string(),
                "-NoProfile".to_string(),
                "-ExecutionPolicy".to_string(),
                "Bypass".to_string(),
                "-Command".to_string(),
                command.to_string(),
            ],
        )
    } else {
        (
            "bash".to_string(),
            vec!["-lc".to_string(), command.to_string()],
        )
    }
}

#[derive(serde::Serialize, Clone)]
struct TerminalOutputEvent {
    session_id: String,
    stream: String, // "stdout" | "stderr"
    line: String,
}

#[derive(serde::Serialize, Clone)]
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
        match tokio::io::AsyncReadExt::read(&mut reader, &mut buffer).await {
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
pub async fn start_terminal_process(
    command: String,
    cwd: String,
    client_session_id: Option<String>,
    app: AppHandle,
    state: State<'_, TerminalProcesses>,
) -> Result<String, String> {
    let session_id = client_session_id.unwrap_or_else(|| format!("term-{}", uuid_simple()));

    let (shell, args) = command_shell(&command);

    let mut cmd = TokioCommand::new(shell);
    cmd.args(args)
        .current_dir(&cwd)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true);

    // On Windows, prevent a console window from flashing and ensure output goes through pipes
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
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
pub async fn stop_terminal_process(
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
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        if let Some(pid) = child.id() {
            // First attempt: taskkill with tree kill
            let _ = Command::new("taskkill")
                .args(["/T", "/F", "/PID", &pid.to_string()])
                .creation_flags(0x08000000)
                .output();

            // Also try killing by the process image name's children via wmic
            let _ = Command::new("taskkill")
                .args(["/F", "/PID", &pid.to_string()])
                .creation_flags(0x08000000)
                .output();
        }
        let _ = child.kill().await;
        let _ = child.wait().await;
    }

    #[cfg(not(target_os = "windows"))]
    {
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
pub(crate) fn uuid_simple() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    format!("{:x}", nanos)
}

// Async version that runs on a background thread to avoid freezing the UI
#[tauri::command]
pub async fn run_terminal_command(
    command: String,
    cwd: String,
    timeout_ms: Option<u64>,
) -> Result<CmdResult, String> {
    let (shell, args) = command_shell(&command);
    let mut cmd = TokioCommand::new(shell);
    cmd.args(args)
        .current_dir(&cwd)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true);

    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
    }

    let child = cmd
        .spawn()
        .map_err(|e| format!("Failed to execute: {}", e))?;
    let timeout = Duration::from_millis(timeout_ms.unwrap_or(600_000).clamp(1_000, 3_600_000));

    match tokio::time::timeout(timeout, child.wait_with_output()).await {
        Ok(Ok(output)) => Ok(CmdResult {
            stdout: String::from_utf8_lossy(&output.stdout).to_string(),
            stderr: String::from_utf8_lossy(&output.stderr).to_string(),
            exit_code: output.status.code().unwrap_or(-1),
        }),
        Ok(Err(e)) => Err(format!("Failed to execute: {}", e)),
        Err(_) => Err(format!(
            "Command timed out after {} seconds and was terminated",
            timeout.as_secs()
        )),
    }
}

#[tauri::command]
pub async fn check_tcp_port(host: String, port: u16) -> Result<PortCheckResult, String> {
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
