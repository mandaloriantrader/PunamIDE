//! PTY Manager — Cross-platform pseudo-terminal management.
//! Supports Windows (PowerShell/CMD) and Unix (bash/zsh) shells.
//! Provides create, write, resize, kill operations with streaming output.

use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, State};

// --- Types ---

/// Holds a running PTY session's resources.
pub struct PtySession {
    pub writer: Arc<Mutex<Box<dyn Write + Send>>>,
    pub master: Arc<Mutex<Box<dyn MasterPty + Send>>>,
    pub child: Arc<Mutex<Option<Box<dyn portable_pty::Child + Send>>>>,
    pub killed: Arc<AtomicBool>,
}

/// Tauri-managed state holding all active PTY sessions.
#[derive(Clone)]
pub struct PtyState(pub Arc<Mutex<HashMap<String, PtySession>>>);

impl PtyState {
    pub fn new() -> Self {
        Self(Arc::new(Mutex::new(HashMap::new())))
    }
}

/// Event payload streamed to the frontend.
#[derive(Serialize, Clone)]
pub struct PtyOutputEvent {
    pub terminal_id: String,
    pub data: String,
}

/// Event payload when a PTY session exits.
#[derive(Serialize, Clone)]
pub struct PtyExitEvent {
    pub terminal_id: String,
    pub exit_code: Option<i32>,
}

// --- Helpers ---

fn generate_id() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    format!("pty-{:x}", nanos)
}

/// Determine the shell to use based on platform.
fn get_shell() -> (String, Vec<String>) {
    #[cfg(target_os = "windows")]
    {
        // Prefer PowerShell if available, fall back to cmd.exe
        let ps_path = std::env::var("SystemRoot")
            .map(|root| format!("{}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe", root))
            .unwrap_or_else(|_| "powershell.exe".to_string());

        if std::path::Path::new(&ps_path).exists() {
            (ps_path, vec!["-NoLogo".to_string(), "-NoProfile".to_string()])
        } else {
            ("cmd.exe".to_string(), vec![])
        }
    }

    #[cfg(not(target_os = "windows"))]
    {
        let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/bash".to_string());
        (shell, vec!["-l".to_string()]) // login shell
    }
}

// --- Tauri Commands ---

/// Create a new PTY terminal session.
/// Returns the terminal_id for subsequent operations.
#[tauri::command]
pub fn terminal_create(
    project_root: String,
    app: AppHandle,
    state: State<PtyState>,
) -> Result<String, String> {
    let terminal_id = generate_id();
    let (shell, shell_args) = get_shell();

    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize {
            rows: 24,
            cols: 80,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| format!("Failed to open PTY: {}", e))?;

    let mut cmd = CommandBuilder::new(&shell);
    for arg in &shell_args {
        cmd.arg(arg);
    }
    cmd.cwd(&project_root);

    // Set common environment variables
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");

    let mut child = pair
        .slave
        .spawn_command(cmd)
        .map_err(|e| format!("Failed to spawn shell '{}': {}", shell, e))?;

    // Drop slave — only master is needed for I/O
    drop(pair.slave);

    // Guard: if any step between spawn and session storage fails, kill the child
    // to prevent zombie shell processes (especially on Windows).
    struct ChildGuard(Option<Box<dyn portable_pty::Child + Send>>);
    impl Drop for ChildGuard {
        fn drop(&mut self) {
            if let Some(mut c) = self.0.take() {
                // Best-effort kill + wait to prevent zombies
                let _ = c.kill();
                let _ = c.wait();
            }
        }
    }
    let mut guard = ChildGuard(Some(child));

    let writer = pair
        .master
        .take_writer()
        .map_err(|e| format!("Failed to get PTY writer: {}", e))?;

    let mut reader = pair
        .master
        .try_clone_reader()
        .map_err(|e| format!("Failed to get PTY reader: {}", e))?;

    let killed = Arc::new(AtomicBool::new(false));
    let child_arc = Arc::new(Mutex::new(Some(guard.0.take().unwrap())));

    // Store session — after this point the child is managed by the session, not the guard
    {
        let mut sessions = state.0.lock().map_err(|_| "Lock error".to_string())?;
        sessions.insert(
            terminal_id.clone(),
            PtySession {
                writer: Arc::new(Mutex::new(writer)),
                master: Arc::new(Mutex::new(pair.master)),
                child: child_arc.clone(),
                killed: killed.clone(),
            },
        );
    }
    // Session stored successfully — guard is disarmed (child moved out)

    // Spawn reader thread — streams output to frontend with backpressure
    let tid = terminal_id.clone();
    let app_reader = app.clone();
    let killed_reader = killed.clone();
    std::thread::spawn(move || {
        let mut buf = [0u8; 4096];
        // Buffer accumulated output to throttle event emission to ~60 fps (16ms window)
        let mut pending: Vec<String> = Vec::new();
        let mut pending_len: usize = 0;
        let flush_interval = std::time::Duration::from_millis(16);
        let max_pending_bytes: usize = 8192; // flush if accumulated > 8KB
        let mut last_flush = std::time::Instant::now();
        loop {
            if killed_reader.load(Ordering::SeqCst) {
                break;
            }
            match reader.read(&mut buf) {
                Ok(0) => {
                    // Flush any remaining output before breaking
                    if !pending.is_empty() {
                        let combined = pending.concat();
                        let _ = app_reader.emit(
                            "pty-output",
                            PtyOutputEvent {
                                terminal_id: tid.clone(),
                                data: combined,
                            },
                        );
                    }
                    break; // EOF — shell exited
                }
                Ok(n) => {
                    let data = String::from_utf8_lossy(&buf[..n]).to_string();
                    pending.push(data);
                    pending_len += n;
                    let now = std::time::Instant::now();
                    if pending_len >= max_pending_bytes || now.duration_since(last_flush) >= flush_interval {
                        let combined = pending.concat();
                        pending.clear();
                        pending_len = 0;
                        last_flush = now;
                        let _ = app_reader.emit(
                            "pty-output",
                            PtyOutputEvent {
                                terminal_id: tid.clone(),
                                data: combined,
                            },
                        );
                    }
                }
                Err(_) => {
                    // Flush any remaining output before breaking
                    if !pending.is_empty() {
                        let combined = pending.concat();
                        let _ = app_reader.emit(
                            "pty-output",
                            PtyOutputEvent {
                                terminal_id: tid.clone(),
                                data: combined,
                            },
                        );
                    }
                    break;
                }
            }
        }
    });

    // Spawn child watcher thread — detects when shell exits
    let tid_exit = terminal_id.clone();
    let app_exit = app.clone();
    let killed_exit = killed.clone();
    let child_watch = child_arc.clone();
    std::thread::spawn(move || {
        let exit_code = {
            let mut child_opt = child_watch.lock().ok();
            child_opt.as_mut().and_then(|co| co.as_mut()).and_then(|c| c.wait().ok()).map(|s| {
                s.exit_code() as i32
            })
        };
        if !killed_exit.load(Ordering::SeqCst) {
            let _ = app_exit.emit(
                "pty-exit",
                PtyExitEvent {
                    terminal_id: tid_exit,
                    exit_code,
                },
            );
        }
    });

    Ok(terminal_id)
}

/// Write data (keystrokes) to a PTY session.
#[tauri::command]
pub fn terminal_write(
    terminal_id: String,
    data: String,
    state: State<PtyState>,
) -> Result<(), String> {
    let sessions = state.0.lock().map_err(|_| "Lock error".to_string())?;
    let session = sessions
        .get(&terminal_id)
        .ok_or_else(|| format!("Terminal '{}' not found", terminal_id))?;

    let mut writer = session.writer.lock().map_err(|_| "Writer lock error".to_string())?;
    writer
        .write_all(data.as_bytes())
        .map_err(|e| format!("Write error: {}", e))?;
    writer.flush().map_err(|e| format!("Flush error: {}", e))?;
    Ok(())
}

/// Resize a PTY session.
#[tauri::command]
pub fn terminal_resize(
    terminal_id: String,
    cols: u16,
    rows: u16,
    state: State<PtyState>,
) -> Result<(), String> {
    let sessions = state.0.lock().map_err(|_| "Lock error".to_string())?;
    let session = sessions
        .get(&terminal_id)
        .ok_or_else(|| format!("Terminal '{}' not found", terminal_id))?;

    let master = session.master.lock().map_err(|_| "Master lock error".to_string())?;
    master
        .resize(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| format!("Resize error: {}", e))?;
    Ok(())
}

/// Kill a PTY session and clean up resources.
#[tauri::command]
pub fn terminal_kill(
    terminal_id: String,
    state: State<PtyState>,
) -> Result<(), String> {
    let mut sessions = state.0.lock().map_err(|_| "Lock error".to_string())?;
    if let Some(session) = sessions.remove(&terminal_id) {
        session.killed.store(true, Ordering::SeqCst);
        // Drop writer to close stdin, which causes the shell to exit
        drop(session.writer);
        drop(session.master);
        // Wait for the child process to exit (max 3 seconds) to prevent zombies
        if let Ok(mut child_opt) = session.child.lock() {
            if let Some(mut child) = child_opt.take() {
                let _ = child.wait();
            }
        }
    }
    Ok(())
}

/// Kill all PTY sessions — called on app exit.
pub fn kill_all(state: &PtyState) {
    if let Ok(mut sessions) = state.0.lock() {
        for (_, session) in sessions.drain() {
            session.killed.store(true, Ordering::SeqCst);
            // Wait for child process with 2-second timeout per session
            if let Ok(mut child_opt) = session.child.lock() {
                if let Some(mut child) = child_opt.take() {
                    let _ = child.wait();
                }
            }
            drop(session.writer);
            drop(session.master);
        }
    }
}
