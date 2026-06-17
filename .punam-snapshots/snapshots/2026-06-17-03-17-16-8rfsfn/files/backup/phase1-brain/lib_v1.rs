use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::net::{TcpStream, ToSocketAddrs};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, RwLock};
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::io::AsyncReadExt;
use tokio::process::Command as TokioCommand;
use tokio::sync::Notify;
use notify_debouncer_mini::{new_debouncer, DebouncedEventKind};
use std::time::Duration;
use sysinfo::System;

pub mod pty_manager;
pub mod lsp_manager;
pub mod dap_manager;
pub mod snapshot;
pub mod architecture;
pub mod memory;
pub mod embeddings;
pub mod github;
pub mod security_scanner;
pub mod environment_scanner;
pub mod package_manager;
pub mod docker_controller;
pub mod agent_tools;
pub mod fs_commands;
pub mod search_commands;
pub mod terminal_commands;
pub mod git_commands;
pub mod index_commands;

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

#[derive(Clone)]
pub struct TerminalProcessHandle {
    child: Arc<tokio::sync::Mutex<tokio::process::Child>>,
    killed: Arc<AtomicBool>,
}

pub struct TerminalProcesses(pub Arc<Mutex<HashMap<String, TerminalProcessHandle>>>);

// --- File Watcher State ---

pub struct FileWatcherHandle(pub Mutex<Option<notify_debouncer_mini::Debouncer<notify::RecommendedWatcher>>>);

// --- Path Safety ---

pub(crate) fn validate_path_within_project(path: &str, project_root: &str) -> Result<String, String> {
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

pub(crate) fn get_project_root(state: &State<ProjectRoot>) -> Result<String, String> {
    state
        .0
        .lock()
        .map_err(|_| "Lock error".to_string())?
        .clone()
        .ok_or_else(|| "No project directory is open".to_string())
}

// --- Skip lists ---

pub(crate) const SKIP_DIRS: &[&str] = &[
    ".git", "node_modules", "__pycache__", ".pytest_cache", "venv", ".venv",
    "dist", "build", "out", "target", ".idea", ".vscode", ".next", ".nuxt",
    "coverage", ".gradle", "vendor", ".dart_tool", "egg-info",
    // Additional heavy directories — never worth scanning
    ".angular", ".cache", ".cargo", ".cdk", ".coverage", ".devcontainer",
    ".expo", ".expo-shared", ".gitlab", ".husky", ".jekyll-cache",
    ".meteor", ".nx", ".parcel-cache", ".platformio", ".roo",
    ".rush", ".serverless", ".storybook", ".terraform", ".trunk",
    ".turbo", ".vs", ".yarn", ".zeplin",
    "android", "ios", "__MACOSX",
    "bazel-bin", "bazel-out", "bazel-testlogs", "bazel-punamide",
    "bin", "obj", "Debug", "Release", "x64", "x86",
    ".rs", "cmake-build-debug", "cmake-build-release",
    "DerivedData", "Library", "Pods",
    "generated", ".svelte-kit", ".solid", ".output",
    "tmp", "temp", "cache", ".cache",
    ".terraform.d", ".serverless_next",
];

pub(crate) const SKIP_FILES: &[&str] = &[
    "package-lock.json", "yarn.lock", "pnpm-lock.yaml",
    "Cargo.lock", "poetry.lock", "go.sum",
];

// --- File System Commands ---
// Moved to fs_commands.rs module

// --- Search Commands ---
// Moved to search_commands.rs module

// --- Terminal Command (async, non-blocking, streaming) ---
// Moved to terminal_commands.rs module

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

    let client = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(120))
        .build()
        .map_err(|e| format!("Failed to build HTTP client: {}", e))?;
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
    streamId: String,
    app: AppHandle,
    stream_state: State<'_, LlmStreamState>,
) -> Result<LlmResponse, String> {
    let cancellation = stream_state.register(&streamId)?;
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

    let client = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(120))
        .build()
        .map_err(|e| format!("Failed to build HTTP client: {}", e))?;
    let resp = match tokio::select! {
        result = client.post(&url).json(&body).send() => Some(result),
        _ = cancellation.notify.notified() => None,
    } {
        None => {
            stream_state.remove(&streamId);
            return Ok(LlmResponse {
                text: String::new(),
                success: false,
                error: Some("Request cancelled".to_string()),
            });
        }
        Some(result) => match result {
        Ok(r) => r,
        Err(e) => {
            stream_state.remove(&streamId);
            return Ok(LlmResponse {
                text: String::new(),
                success: false,
                error: Some(format!("Network error: {}", e)),
            });
        }
        },
    };

    if !resp.status().is_success() {
        let status = resp.status();
        let err_body = resp.text().await.unwrap_or_default();
        stream_state.remove(&streamId);
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

    loop {
        let chunk = tokio::select! {
            next = stream.next() => next,
            _ = cancellation.notify.notified() => None,
        };
        let Some(chunk) = chunk else { break };
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
                        let _ = app.emit("llm-stream", LlmStreamEvent {
                            stream_id: streamId.clone(),
                            token: text.to_string(),
                            done: false,
                        });
                    }
                }
            }
        }
    }

    // Final done signal
    let cancelled = cancellation.cancelled.load(Ordering::SeqCst);
    stream_state.remove(&streamId);
    let _ = app.emit("llm-stream", LlmStreamEvent {
        stream_id: streamId,
        token: String::new(),
        done: true,
    });
    tokio::task::yield_now().await;

    if cancelled {
        return Ok(LlmResponse {
            text: String::new(),
            success: false,
            error: Some("Request cancelled".to_string()),
        });
    }

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

    let client = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(120))
        .build()
        .map_err(|e| format!("Failed to build HTTP client: {}", e))?;
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
    stream_id: String,
    token: String,
    done: bool,
}

struct LlmCancellation {
    cancelled: AtomicBool,
    notify: Notify,
}

pub struct LlmStreamState(Mutex<HashMap<String, Arc<LlmCancellation>>>);

impl LlmStreamState {
    fn register(&self, stream_id: &str) -> Result<Arc<LlmCancellation>, String> {
        let cancellation = Arc::new(LlmCancellation {
            cancelled: AtomicBool::new(false),
            notify: Notify::new(),
        });
        self.0
            .lock()
            .map_err(|_| "LLM stream state lock error".to_string())?
            .insert(stream_id.to_string(), cancellation.clone());
        Ok(cancellation)
    }

    fn remove(&self, stream_id: &str) {
        if let Ok(mut streams) = self.0.lock() {
            streams.remove(stream_id);
        }
    }
}

#[tauri::command]
fn cancel_llm_stream(stream_id: String, state: State<'_, LlmStreamState>) -> Result<(), String> {
    let cancellation = state
        .0
        .lock()
        .map_err(|_| "LLM stream state lock error".to_string())?
        .get(&stream_id)
        .cloned();
    if let Some(cancellation) = cancellation {
        cancellation.cancelled.store(true, Ordering::SeqCst);
        cancellation.notify.notify_one();
    }
    Ok(())
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
    streamId: String,
    app: AppHandle,
    stream_state: State<'_, LlmStreamState>,
) -> Result<LlmResponse, String> {
    let cancellation = stream_state.register(&streamId)?;
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

    let client = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(120))
        .build()
        .map_err(|e| format!("Failed to build HTTP client: {}", e))?;
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

    let resp = match tokio::select! {
        result = req_builder.json(&body).send() => Some(result),
        _ = cancellation.notify.notified() => None,
    } {
        None => {
            stream_state.remove(&streamId);
            return Ok(LlmResponse {
                text: String::new(),
                success: false,
                error: Some("Request cancelled".to_string()),
            });
        }
        Some(result) => match result {
        Ok(r) => r,
        Err(e) => {
            stream_state.remove(&streamId);
            return Ok(LlmResponse {
                text: String::new(),
                success: false,
                error: Some(format!("Network error: {}", e)),
            });
        }
        },
    };

    if !resp.status().is_success() {
        let status = resp.status();
        let err_body = resp.text().await.unwrap_or_default();
        stream_state.remove(&streamId);
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

    loop {
        let chunk = tokio::select! {
            next = stream.next() => next,
            _ = cancellation.notify.notified() => None,
        };
        let Some(chunk) = chunk else { break };
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
                    let _ = app.emit("llm-stream", LlmStreamEvent {
                        stream_id: streamId.clone(),
                        token: String::new(),
                        done: true,
                    });
                    break;
                }
                if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(data) {
                    if let Some(token) = parsed["choices"][0]["delta"]["content"].as_str() {
                        full_text.push_str(token);
                        let _ = app.emit("llm-stream", LlmStreamEvent {
                            stream_id: streamId.clone(),
                            token: token.to_string(),
                            done: false,
                        });
                    }
                }
            }
        }
    }

    // Final done signal
    let cancelled = cancellation.cancelled.load(Ordering::SeqCst);
    stream_state.remove(&streamId);
    let _ = app.emit("llm-stream", LlmStreamEvent {
        stream_id: streamId,
        token: String::new(),
        done: true,
    });

    if cancelled {
        return Ok(LlmResponse {
            text: String::new(),
            success: false,
            error: Some("Request cancelled".to_string()),
        });
    }

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

    let client = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(120))
        .build()
        .map_err(|e| format!("Failed to build HTTP client: {}", e))?;
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

    let app_clone = app.clone();
    let mut debouncer = new_debouncer(
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

    // Atomically replace old watcher with new one under a single lock
    {
        let mut handle = state.0.lock().map_err(|_| "Lock error".to_string())?;
        // Set to None first to drop the old watcher cleanly
        *handle = None;
        // Add the path to watch on the new watcher before storing it
        debouncer
            .watcher()
            .watch(watch_path, notify::RecursiveMode::Recursive)
            .map_err(|e| format!("Failed to watch path: {}", e))?;
        *handle = Some(debouncer);
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
// Types kept here, commands moved to index_commands.rs module

#[derive(Serialize, Clone, Debug)]
pub struct FileIndexEntry {
    pub path: String,        // relative path
    pub extension: String,
    pub size: u64,
    pub modified: u64,       // unix timestamp
    pub preview: String,     // first 500 chars
    pub is_binary: bool,
}

pub struct ProjectIndexCache(pub RwLock<Vec<FileIndexEntry>>);

// --- Git Engine (using libgit2 via git2 crate) ---
// Moved to git_commands.rs module

// --- Rust Fuzzy Edit Engine ---
// Moved to index_commands.rs module

#[derive(Serialize, Debug)]
pub struct FuzzyMatchResult {
    pub start_line: usize,
    pub end_line: usize,
    pub score: f64,
    pub matched: bool,
}

// --- Rust TF-IDF Codebase Index ---
// Commands moved to index_commands.rs, types kept here

#[derive(Serialize, Debug)]
pub struct CodeSearchHit {
    pub path: String,
    pub start_line: usize,
    pub end_line: usize,
    pub snippet: String,
    pub score: f64,
}

pub struct CodebaseIndex(pub RwLock<Option<TfIdfIndex>>);

pub struct TfIdfIndex {
    pub chunks: Vec<CodeChunk>,
    pub inverted: HashMap<String, Vec<(usize, f64)>>, // token -> [(chunk_idx, tf)]
}

pub struct CodeChunk {
    pub path: String,
    pub start_line: usize,
    pub end_line: usize,
    pub content: String,
    pub token_count: usize,
}

pub const CHUNK_LINES: usize = 30;
pub const CHUNK_OVERLAP: usize = 5;

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

// --- Unified Context Engine (TF-IDF + git + tabs) ---
// Types kept here, commands moved to index_commands.rs module

#[derive(Serialize, Debug)]
pub struct RelevantContext {
    pub project_summary: String,
    pub relevant_files: Vec<ContextFile>,
    pub git_status: Vec<String>,
    pub open_tab_paths: Vec<String>,
    pub total_tokens_estimate: usize,
}

// --- 3-Way Merge Engine (prevents silent overwrite) ---

#[derive(Serialize, Debug)]
pub struct ThreeWayMergeResult {
    pub merged: bool,              // true if no conflicts
    pub merged_content: String,    // the merged result (with conflict markers if any)
    pub has_conflicts: bool,
    pub conflict_count: usize,
    pub conflict_regions: Vec<(usize, usize)>, // (line_start, line_end) of conflict blocks
}

#[tauri::command]
fn try_3way_merge(
    file_path: String,
    ai_proposed_content: String,
    state: State<ProjectRoot>,
) -> Result<ThreeWayMergeResult, String> {
    let root = get_project_root(&state)?;
    let safe_path = validate_path_within_project(&file_path, &root)?;
    let current_content = fs::read_to_string(&safe_path)
        .map_err(|e| format!("Failed to read file: {}", e))?;

    let current_lines: Vec<&str> = current_content.lines().collect();
    let proposed_lines: Vec<&str> = ai_proposed_content.lines().collect();

    let mut merged_lines: Vec<String> = Vec::new();
    let mut conflicts = 0;
    let mut conflict_regions: Vec<(usize, usize)> = Vec::new();

    // Simple 3-way diff: if AI output equals current → no conflict
    // Otherwise, use overlap-based merge with conflict markers
    let mut i = 0;
    let mut j = 0;
    let mut in_conflict = false;
    let mut conflict_start = 0;

    while i < current_lines.len() || j < proposed_lines.len() {
        if i < current_lines.len() && j < proposed_lines.len()
            && current_lines[i] == proposed_lines[j]
        {
            if in_conflict {
                merged_lines.push(">>>>>>> AI Proposed".to_string());
                conflicts += 1;
                conflict_regions.push((conflict_start, merged_lines.len()));
                in_conflict = false;
            }
            merged_lines.push(current_lines[i].to_string());
            i += 1;
            j += 1;
        } else if i < current_lines.len() && j < proposed_lines.len() {
            // Lines differ — look ahead up to 4 lines for re-sync
            let mut synced = false;
            for look in 1..=4 {
                if i + look < current_lines.len()
                    && j < proposed_lines.len()
                    && current_lines[i + look] == proposed_lines[j]
                {
                    // User added lines
                    for k in 0..look {
                        if !in_conflict {
                            in_conflict = true;
                            conflict_start = merged_lines.len();
                            merged_lines.push("<<<<<<< Current File (user edits)".to_string());
                        }
                        merged_lines.push(current_lines[i + k].to_string());
                    }
                    merged_lines.push("=======".to_string());
                    i += look;
                    synced = true;
                    break;
                }
                if j + look < proposed_lines.len()
                    && i < current_lines.len()
                    && current_lines[i] == proposed_lines[j + look]
                {
                    // AI proposed new lines
                    for k in 0..look {
                        if !in_conflict {
                            in_conflict = true;
                            conflict_start = merged_lines.len();
                            merged_lines.push("<<<<<<< Current File (user edits)".to_string());
                        }
                        merged_lines.push(proposed_lines[j + k].to_string());
                    }
                    merged_lines.push("=======".to_string());
                    j += look;
                    synced = true;
                    break;
                }
            }
            if !synced {
                // Both changed — true conflict
                if !in_conflict {
                    in_conflict = true;
                    conflict_start = merged_lines.len();
                    merged_lines.push("<<<<<<< Current File (user edits)".to_string());
                }
                if i < current_lines.len() {
                    merged_lines.push(current_lines[i].to_string());
                    i += 1;
                }
                if j < proposed_lines.len() {
                    merged_lines.push(proposed_lines[j].to_string());
                    j += 1;
                }
            }
        } else if i < current_lines.len() {
            // Only in current — user added lines (no conflict since AI didn't touch this region)
            merged_lines.push(current_lines[i].to_string());
            i += 1;
        } else {
            // Only in proposed — AI added new lines
            merged_lines.push(proposed_lines[j].to_string());
            j += 1;
        }
    }

    if in_conflict {
        merged_lines.push(">>>>>>> AI Proposed".to_string());
        conflicts += 1;
        conflict_regions.push((conflict_start, merged_lines.len()));
    }

    Ok(ThreeWayMergeResult {
        merged: conflicts == 0,
        merged_content: merged_lines.join("\n"),
        has_conflicts: conflicts > 0,
        conflict_count: conflicts,
        conflict_regions,
    })
}

// --- Legacy AI Context Builder ---
// Types kept here, commands moved to index_commands.rs module

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

// --- SQLite Persistence ---

use rusqlite::Connection;

static DB_MAINTENANCE_LOCK: Mutex<()> = Mutex::new(());
const DAY_MS: i64 = 86_400_000;
const CHAT_RETENTION_DAYS: i64 = 180;
const MEMORY_RETENTION_DAYS: i64 = 365;
const EMBEDDING_RETENTION_DAYS: i64 = 180;
const VACUUM_INTERVAL_DAYS: i64 = 7;

fn get_db_path() -> std::path::PathBuf {
    let data_dir = dirs::data_local_dir().unwrap_or_else(|| std::path::PathBuf::from("."));
    let app_dir = data_dir.join("punamide");
    fs::create_dir_all(&app_dir).ok();
    app_dir.join("punamide.db")
}

fn get_connection() -> Result<Connection, String> {
    let db_path = get_db_path();
    let conn = Connection::open(&db_path).map_err(|e| format!("DB error: {}", e))?;
    conn.execute_batch(
        "PRAGMA journal_mode=WAL;
         PRAGMA synchronous=NORMAL;
         PRAGMA busy_timeout=5000;
         PRAGMA foreign_keys=ON;"
    ).map_err(|e| format!("DB pragma error: {}", e))?;
    Ok(conn)
}

fn table_exists(conn: &Connection, table: &str) -> bool {
    conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?1)",
        [table],
        |row| row.get::<_, i64>(0),
    )
    .map(|value| value == 1)
    .unwrap_or(false)
}

fn unix_timestamp_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}

fn log_prune(result: rusqlite::Result<usize>, label: &str, log: &mut Vec<String>) {
    match result {
        Ok(count) if count > 0 => log.push(format!("Pruned {} {}", count, label)),
        Ok(_) => {}
        Err(error) => log.push(format!("{} prune error: {}", label, error)),
    }
}

/// Periodic database maintenance. Serialized so startup and write-triggered runs cannot overlap.
#[tauri::command]
fn db_maintenance() -> Result<String, String> {
    let _maintenance_guard = DB_MAINTENANCE_LOCK
        .lock()
        .map_err(|_| "Database maintenance lock was poisoned".to_string())?;
    let conn = get_connection()?;
    let mut log = Vec::new();
    let now = unix_timestamp_ms();

    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS maintenance_meta (
            key TEXT PRIMARY KEY,
            value INTEGER NOT NULL
        );",
    )
    .map_err(|e| format!("Maintenance metadata error: {}", e))?;

    if table_exists(&conn, "chat_sessions") {
        let cutoff = now - CHAT_RETENTION_DAYS * DAY_MS;
        log_prune(
            conn.execute(
                "DELETE FROM chat_sessions AS old
                 WHERE old.updated_at < ?1
                   AND 10 <= (
                     SELECT COUNT(*) FROM chat_sessions AS newer
                     WHERE newer.project_path = old.project_path
                       AND (newer.updated_at > old.updated_at
                         OR (newer.updated_at = old.updated_at AND newer.id >= old.id))
                   )",
                [cutoff],
            ),
            "old chat sessions",
            &mut log,
        );
        log_prune(
            conn.execute(
                "DELETE FROM chat_sessions
                 WHERE id IN (
                   SELECT id FROM (
                     SELECT id,
                            ROW_NUMBER() OVER (
                              PARTITION BY project_path
                              ORDER BY updated_at DESC, id DESC
                            ) AS row_num
                     FROM chat_sessions
                   )
                   WHERE row_num > 100
                 )",
                [],
            ),
            "excess chat sessions",
            &mut log,
        );
    }

    if table_exists(&conn, "project_memory") {
        let cutoff = now - MEMORY_RETENTION_DAYS * DAY_MS;
        log_prune(
            conn.execute(
                "DELETE FROM project_memory
                 WHERE updated_at < ?1
                   AND severity NOT IN ('critical', 'high')
                   AND memory_type <> 'convention'",
                [cutoff],
            ),
            "stale memory entries",
            &mut log,
        );
        log_prune(
            conn.execute(
                "DELETE FROM project_memory
                 WHERE id IN (
                   SELECT id FROM project_memory
                   WHERE severity NOT IN ('critical', 'high')
                     AND memory_type <> 'convention'
                   ORDER BY updated_at DESC
                   LIMIT -1 OFFSET 2000
                 )",
                [],
            ),
            "excess memory entries",
            &mut log,
        );
    }

    if table_exists(&conn, "embeddings") {
        let cutoff = now - EMBEDDING_RETENTION_DAYS * DAY_MS;
        log_prune(
            conn.execute("DELETE FROM embeddings WHERE created_at < ?1", [cutoff]),
            "stale code embeddings",
            &mut log,
        );
        log_prune(
            conn.execute(
                "DELETE FROM embeddings
                 WHERE chunk_id IN (
                   SELECT chunk_id FROM embeddings
                   ORDER BY created_at DESC
                   LIMIT -1 OFFSET 50000
                 )",
                [],
            ),
            "excess code embeddings",
            &mut log,
        );
    }

    if table_exists(&conn, "embedding_vectors") {
        let cutoff = now - MEMORY_RETENTION_DAYS * DAY_MS;
        log_prune(
            conn.execute("DELETE FROM embedding_vectors WHERE created_at < ?1", [cutoff]),
            "stale memory embeddings",
            &mut log,
        );
    }

    if table_exists(&conn, "memory_fts") {
        match conn.execute_batch("INSERT INTO memory_fts(memory_fts) VALUES('optimize');") {
            Ok(_) => log.push("FTS5 optimize: ok".to_string()),
            Err(e) => log.push(format!("FTS5 optimize error: {}", e)),
        }
    }

    match conn.execute_batch("ANALYZE; PRAGMA optimize;") {
        Ok(_) => log.push("Analyze and optimize: ok".to_string()),
        Err(e) => log.push(format!("Analyze/optimize error: {}", e)),
    }

    match conn.execute_batch("PRAGMA wal_checkpoint(TRUNCATE);") {
        Ok(_) => log.push("WAL checkpoint: ok".to_string()),
        Err(e) => log.push(format!("WAL checkpoint error: {}", e)),
    }

    let last_vacuum = conn
        .query_row(
            "SELECT value FROM maintenance_meta WHERE key = 'last_vacuum_ms'",
            [],
            |row| row.get::<_, i64>(0),
        )
        .unwrap_or(0);
    if now - last_vacuum >= VACUUM_INTERVAL_DAYS * DAY_MS {
        let free_pages = conn
            .query_row("PRAGMA freelist_count", [], |row| row.get::<_, i64>(0))
            .unwrap_or(0);
        if free_pages >= 256 {
            match conn.execute_batch("VACUUM;") {
                Ok(_) => log.push(format!("Vacuum: reclaimed {} free pages", free_pages)),
                Err(e) => log.push(format!("Vacuum error: {}", e)),
            }
        }
        conn.execute(
            "INSERT INTO maintenance_meta (key, value) VALUES ('last_vacuum_ms', ?1)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            [now],
        )
        .map_err(|e| format!("Vacuum timestamp error: {}", e))?;
    }

    Ok(log.join("\n"))
}

#[tauri::command]
fn db_init() -> Result<(), String> {
    let conn = get_connection()?;
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS chat_sessions (
            id TEXT PRIMARY KEY,
            project_path TEXT NOT NULL DEFAULT '',
            title TEXT NOT NULL,
            provider TEXT NOT NULL,
            model TEXT NOT NULL,
            messages TEXT NOT NULL,
            token_count INTEGER DEFAULT 0,
            cost REAL DEFAULT 0.0,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
        );
        "
    ).map_err(|e| format!("DB init error: {}", e))?;
    let has_project_path = {
        let mut stmt = conn
            .prepare("PRAGMA table_info(chat_sessions)")
            .map_err(|e| format!("DB migration check error: {}", e))?;
        let columns = stmt
            .query_map([], |row| row.get::<_, String>(1))
            .map_err(|e| format!("DB migration check error: {}", e))?;
        let mut found = false;
        for column in columns {
            if column.map_err(|e| format!("DB migration check error: {}", e))? == "project_path" {
                found = true;
                break;
            }
        }
        found
    };
    if !has_project_path {
        conn.execute(
            "ALTER TABLE chat_sessions ADD COLUMN project_path TEXT NOT NULL DEFAULT ''",
            [],
        ).map_err(|e| format!("DB migration error: {}", e))?;
    }
    conn.execute_batch(
        "DROP INDEX IF EXISTS idx_sessions_updated;
         CREATE INDEX IF NOT EXISTS idx_sessions_project_updated
         ON chat_sessions(project_path, updated_at DESC);"
    ).map_err(|e| format!("DB index migration error: {}", e))?;
    embeddings::ensure_embeddings_table()?;
    Ok(())
}

#[derive(Deserialize, Debug)]
pub struct ChatSessionData {
    pub id: String,
    pub project_path: String,
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
    pub project_path: String,
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
        "INSERT OR REPLACE INTO chat_sessions (id, project_path, title, provider, model, messages, token_count, cost, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
        rusqlite::params![
            session.id, session.project_path, session.title, session.provider,
            session.model, session.messages, session.token_count,
            session.cost, session.created_at, session.updated_at
        ],
    ).map_err(|e| format!("DB save error: {}", e))?;
    Ok(())
}

#[tauri::command]
fn db_load_chat_sessions(project_path: String, limit: usize) -> Result<Vec<ChatSessionRow>, String> {
    let conn = get_connection()?;
    let mut stmt = conn.prepare(
        "SELECT id, project_path, title, provider, model, messages, token_count, cost, created_at, updated_at
         FROM chat_sessions WHERE project_path = ?1 ORDER BY updated_at DESC LIMIT ?2"
    ).map_err(|e| format!("DB query error: {}", e))?;

    let rows = stmt.query_map(rusqlite::params![project_path, limit as i64], |row| {
        Ok(ChatSessionRow {
            id: row.get(0)?,
            project_path: row.get(1)?,
            title: row.get(2)?,
            provider: row.get(3)?,
            model: row.get(4)?,
            messages: row.get(5)?,
            token_count: row.get(6)?,
            cost: row.get(7)?,
            created_at: row.get(8)?,
            updated_at: row.get(9)?,
        })
    }).map_err(|e| format!("DB query error: {}", e))?;

    let mut sessions = Vec::new();
    for row in rows {
        sessions.push(row.map_err(|e| format!("DB row error: {}", e))?);
    }
    Ok(sessions)
}

#[tauri::command]
fn db_load_chat_session(id: String, project_path: String) -> Result<Option<ChatSessionRow>, String> {
    let conn = get_connection()?;
    let mut stmt = conn.prepare(
        "SELECT id, project_path, title, provider, model, messages, token_count, cost, created_at, updated_at
         FROM chat_sessions WHERE id = ?1 AND project_path = ?2"
    ).map_err(|e| format!("DB query error: {}", e))?;
    let mut rows = stmt
        .query(rusqlite::params![id, project_path])
        .map_err(|e| format!("DB query error: {}", e))?;
    let Some(row) = rows.next().map_err(|e| format!("DB row error: {}", e))? else {
        return Ok(None);
    };
    Ok(Some(ChatSessionRow {
        id: row.get(0).map_err(|e| format!("DB row error: {}", e))?,
        project_path: row.get(1).map_err(|e| format!("DB row error: {}", e))?,
        title: row.get(2).map_err(|e| format!("DB row error: {}", e))?,
        provider: row.get(3).map_err(|e| format!("DB row error: {}", e))?,
        model: row.get(4).map_err(|e| format!("DB row error: {}", e))?,
        messages: row.get(5).map_err(|e| format!("DB row error: {}", e))?,
        token_count: row.get(6).map_err(|e| format!("DB row error: {}", e))?,
        cost: row.get(7).map_err(|e| format!("DB row error: {}", e))?,
        created_at: row.get(8).map_err(|e| format!("DB row error: {}", e))?,
        updated_at: row.get(9).map_err(|e| format!("DB row error: {}", e))?,
    }))
}

#[tauri::command]
fn db_delete_chat_session(id: String, project_path: String) -> Result<(), String> {
    let conn = get_connection()?;
    conn.execute(
        "DELETE FROM chat_sessions WHERE id = ?1 AND project_path = ?2",
        rusqlite::params![id, project_path],
    )
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

#[tauri::command]
fn request_app_exit(app: AppHandle) {
    app.exit(0);
}

#[derive(Serialize)]
struct SystemDiagnostics {
    app_version: String,
    build_number: String,
    release_date: String,
    release_channel: String,
    os: String,
    os_version: String,
    cpu: String,
    logical_cpus: usize,
    total_memory_mb: u64,
    tauri_version: String,
    rust_backend_version: String,
    log_path: String,
    data_path: String,
}

#[tauri::command]
fn get_system_diagnostics(app: AppHandle) -> Result<SystemDiagnostics, String> {
    let mut system = System::new_all();
    system.refresh_all();

    let package_info = app.package_info();
    let cpu = system
        .cpus()
        .first()
        .map(|cpu| cpu.brand().to_string())
        .filter(|brand| !brand.trim().is_empty())
        .unwrap_or_else(|| "Unknown CPU".to_string());
    let log_path = app
        .path()
        .app_log_dir()
        .map(|path| path.display().to_string())
        .unwrap_or_else(|_| "Unavailable".to_string());
    let data_path = app
        .path()
        .app_data_dir()
        .map(|path| path.display().to_string())
        .unwrap_or_else(|_| "Unavailable".to_string());

    Ok(SystemDiagnostics {
        app_version: package_info.version.to_string(),
        build_number: option_env!("PUNAM_BUILD_NUMBER").unwrap_or("alpha.1").to_string(),
        release_date: option_env!("PUNAM_RELEASE_DATE").unwrap_or("2026-06-02").to_string(),
        release_channel: option_env!("PUNAM_RELEASE_CHANNEL").unwrap_or("Alpha").to_string(),
        os: System::name().unwrap_or_else(|| std::env::consts::OS.to_string()),
        os_version: System::os_version().unwrap_or_else(|| "Unknown".to_string()),
        cpu,
        logical_cpus: system.cpus().len(),
        total_memory_mb: system.total_memory() / 1024 / 1024,
        tauri_version: "2.11.2".to_string(),
        rust_backend_version: env!("CARGO_PKG_VERSION").to_string(),
        log_path,
        data_path,
    })
}

fn open_folder_path(path: PathBuf) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        let mut cmd = Command::new("explorer");
        cmd.arg(path);
        cmd.creation_flags(0x08000000);
        cmd.spawn().map_err(|err| format!("Failed to open folder: {}", err))?;
    }

    #[cfg(target_os = "macos")]
    {
        Command::new("open")
            .arg(path)
            .spawn()
            .map_err(|err| format!("Failed to open folder: {}", err))?;
    }

    #[cfg(all(unix, not(target_os = "macos")))]
    {
        Command::new("xdg-open")
            .arg(path)
            .spawn()
            .map_err(|err| format!("Failed to open folder: {}", err))?;
    }

    Ok(())
}

#[tauri::command]
fn open_logs_folder(app: AppHandle) -> Result<(), String> {
    let path = app.path().app_log_dir().map_err(|err| err.to_string())?;
    fs::create_dir_all(&path).map_err(|err| err.to_string())?;
    open_folder_path(path)
}

#[tauri::command]
fn open_data_folder(app: AppHandle) -> Result<(), String> {
    let path = app.path().app_data_dir().map_err(|err| err.to_string())?;
    fs::create_dir_all(&path).map_err(|err| err.to_string())?;
    open_folder_path(path)
}

fn read_recent_logs(app: &AppHandle) -> String {
    let log_dir = match app.path().app_log_dir() {
        Ok(path) => path,
        Err(err) => return format!("Log directory unavailable: {}", err),
    };

    let mut files: Vec<PathBuf> = match fs::read_dir(&log_dir) {
        Ok(entries) => entries.filter_map(|entry| entry.ok().map(|entry| entry.path())).collect(),
        Err(err) => return format!("No log files found in {}: {}", log_dir.display(), err),
    };

    files.sort_by_key(|path| fs::metadata(path).and_then(|meta| meta.modified()).ok());
    files.reverse();

    let mut output = String::new();
    for path in files.into_iter().take(3) {
        output.push_str(&format!("\n--- {} ---\n", path.display()));
        match fs::read_to_string(&path) {
            Ok(contents) => {
                let excerpt = if contents.chars().count() > 80_000 {
                    contents
                        .chars()
                        .rev()
                        .take(80_000)
                        .collect::<String>()
                        .chars()
                        .rev()
                        .collect::<String>()
                } else {
                    contents
                };
                output.push_str(&excerpt);
                output.push('\n');
            }
            Err(err) => output.push_str(&format!("Failed to read log: {}\n", err)),
        }
    }

    if output.trim().is_empty() {
        format!("No log files found in {}", log_dir.display())
    } else {
        output
    }
}

#[tauri::command]
fn generate_diagnostics_report(
    app: AppHandle,
    state: State<ProjectRoot>,
    include_project_path: bool,
    user_message: Option<String>,
) -> Result<String, String> {
    let package_info = app.package_info();
    let system = get_system_diagnostics(app.clone())?;
    let log_dir = app
        .path()
        .app_log_dir()
        .map(|path| path.display().to_string())
        .unwrap_or_else(|_| "Unavailable".to_string());
    let project_path = if include_project_path {
        state
            .0
            .lock()
            .map_err(|_| "Lock error".to_string())?
            .clone()
            .unwrap_or_else(|| "No project open".to_string())
    } else {
        "Hidden by user choice".to_string()
    };

    let mut report = String::new();
    report.push_str("PunamIDE Alpha Diagnostics\n");
    report.push_str("===========================\n\n");
    report.push_str(&format!("App: {}\n", package_info.name));
    report.push_str(&format!("Version: {}\n", system.app_version));
    report.push_str(&format!("Build: {}\n", system.build_number));
    report.push_str(&format!("Release date: {}\n", system.release_date));
    report.push_str(&format!("Channel: {}\n", system.release_channel));
    report.push_str(&format!("OS: {} {}\n", system.os, system.os_version));
    report.push_str(&format!("Arch: {}\n", std::env::consts::ARCH));
    report.push_str(&format!("CPU: {} ({} logical)\n", system.cpu, system.logical_cpus));
    report.push_str(&format!("RAM: {} MB\n", system.total_memory_mb));
    report.push_str(&format!("Tauri: {}\n", system.tauri_version));
    report.push_str(&format!("Rust backend: {}\n", system.rust_backend_version));
    report.push_str(&format!("Project: {}\n", project_path));
    report.push_str(&format!("Log directory: {}\n", log_dir));
    report.push_str(&format!("Data directory: {}\n", system.data_path));
    report.push_str("\nUser message\n------------\n");
    report.push_str(user_message.as_deref().unwrap_or("No message provided."));
    report.push_str("\n\nRecent logs\n-----------\n");
    report.push_str(&read_recent_logs(&app));

    Ok(report)
}

#[tauri::command]
fn export_diagnostics_report(path: String, report: String) -> Result<(), String> {
    fs::write(&path, report).map_err(|err| format!("Failed to export diagnostics: {}", err))
}

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
        .manage(LlmStreamState(Mutex::new(HashMap::new())))
        .manage(FileWatcherHandle(Mutex::new(None)))
        .manage(ProjectIndexCache(RwLock::new(Vec::new())))
        .manage(CodebaseIndex(RwLock::new(None)))
        .manage(github::auth::GitHubAuthState::new())
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
            fs_commands::set_project_root,
            fs_commands::read_directory,
            fs_commands::read_file,
            agent_tools::read_lines,
            agent_tools::apply_patch,
            fs_commands::path_exists,
            fs_commands::write_file,
            fs_commands::create_file,
            fs_commands::create_directory,
            fs_commands::delete_path,
            fs_commands::rename_path,
            fs_commands::reveal_path,
            search_commands::search_project,
            terminal_commands::run_terminal_command,
            terminal_commands::check_tcp_port,
            terminal_commands::start_terminal_process,
            terminal_commands::stop_terminal_process,
            watch_project,
            stop_watching,
            call_llm,
            call_gemini_stream,
            call_openai_compatible_cmd,
            call_openai_compatible_stream,
            cancel_llm_stream,
            inspect_command,
            verify_path_safety,
            index_commands::get_project_index,
            index_commands::refresh_project_index,
            index_commands::update_file_index,
            git_commands::git_status,
            git_commands::git_diff_file,
            git_commands::git_log,
            git_commands::git_branch,
            index_commands::fuzzy_find_block,
            index_commands::index_codebase,
            index_commands::search_codebase,
            // Differ commands
            diff_strings,
            try_3way_merge,
            // Context builder commands
            index_commands::build_ai_context,
            index_commands::get_relevant_context,
            // SQLite persistence commands
            db_init,
            db_maintenance,
            db_save_chat_session,
            db_load_chat_sessions,
            db_load_chat_session,
            db_delete_chat_session,
            // DAP commands
            dap_manager::dap_start,
            dap_manager::dap_start_tcp,
            dap_manager::dap_send_request,
            dap_manager::dap_stop,
            // Snapshot commands
            snapshot::create_snapshot,
            snapshot::list_snapshots,
            snapshot::get_restore_preview,
            snapshot::restore_snapshot,
            snapshot::export_snapshot_zip,
            snapshot::delete_snapshot,
            snapshot::auto_snapshot_if_enabled,
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
            lsp_manager::lsp_did_close,
            // GitHub Phase 0: Git Core Check
            github::github_check_repo,
            github::github_is_git_repo,
            github::github_get_branch,
            github::github_get_dirty_files,
            github::github_get_remote_origin,
            github::github_get_ahead_behind,
            github::github_list_branches,
            // GitHub Phase 1: Auth
            github::auth::github_set_token,
            github::auth::github_get_user,
            github::auth::github_check_auth,
            github::auth::github_logout,
            // GitHub Phase 2: Repos
            github::repos::github_create_repo,
            github::repos::github_list_repos,
            github::repos::github_get_repo_info,
            github::repos::github_link_remote,
            github::repos::github_remove_remote,
            github::repos::github_init_repo,
            github::repos::github_get_repo_slug,
            // GitHub Phase 6: Safety Layer
            github::safety::github_pre_push_check,
            github::safety::github_pre_pull_check,
            github::safety::github_dry_run_push,
            github::safety::github_create_safety_snapshot,
            github::safety::github_rollback_to_snapshot,
            github::safety::github_list_safety_snapshots,
            github::safety::github_delete_safety_snapshot,
            // GitHub Phase 3: Push/Pull/Sync
            github::sync::github_push,
            github::sync::github_pull,
            github::sync::github_fetch,
            github::sync::github_stash,
            github::sync::github_stash_pop,
            github::sync::github_create_branch,
            github::sync::github_switch_branch,
            github::sync::github_delete_branch,
            github::sync::github_merge_abort,
            // GitHub Phase 4: Pull Requests
            github::pull_requests::github_create_pr,
            github::pull_requests::github_list_prs,
            github::pull_requests::github_get_pr,
            github::pull_requests::github_merge_pr,
            github::pull_requests::github_close_pr,
            github::pull_requests::github_pr_list_comments,
            github::pull_requests::github_pr_add_comment,
            // GitHub Phase 5: Issues
            github::issues::github_list_issues,
            github::issues::github_create_issue,
            github::issues::github_close_issue,
            github::issues::github_issue_list_comments,
            github::issues::github_issue_add_comment,
            // GitHub Phase 5: Actions
            github::actions::github_list_workflow_runs,
            github::actions::github_get_workflow_run,
            github::actions::github_rerun_workflow,
            // GitHub Phase 5: Gists
            github::gists::github_create_gist,
            github::gists::github_create_multi_gist,
            // Architecture Guardrails Engine (Phase 1)
            architecture::dependency_analyzer::analyze_dependencies,
            architecture::dependency_analyzer::analyze_file_dependencies,
            architecture::dependency_analyzer::build_dependency_graph,
            architecture::rule_engine::validate_architecture,
            architecture::rule_engine::validate_patch_against_rules,
            architecture::rule_engine::get_default_rules,
            // Phase 6: Security-First Development Layer
            security_scanner::security_scan_file,
            security_scanner::security_scan_patch,
            // Phase 4: Universal Tool Orchestration
            environment_scanner::scan_tools,
            environment_scanner::tool_installed,
            environment_scanner::tool_version,
            package_manager::package_install,
            package_manager::package_remove,
            package_manager::package_update,
            package_manager::package_audit,
            docker_controller::docker_list_containers,
            docker_controller::docker_start,
            docker_controller::docker_stop,
            docker_controller::docker_logs,
            docker_controller::docker_exec,
            docker_controller::docker_remove_container,
            docker_controller::docker_available,
            // Long-Term Project Memory System (Phase 2)
            memory::memory_engine::memory_init,
            memory::memory_engine::memory_create,
            memory::memory_engine::memory_get_by_id,
            memory::memory_engine::memory_list,
            memory::memory_engine::memory_search,
            memory::memory_engine::memory_update,
            memory::memory_engine::memory_delete,
            memory::memory_engine::memory_get_by_file,
            memory::memory_engine::memory_get_timeline,
            memory::memory_engine::memory_quick_add,
            // Phase 2E: Embedding Store + Retrieval Engine
            memory::embedding_store::embedding_store,
            memory::embedding_store::embedding_get,
            memory::embedding_store::embedding_search,
            memory::embedding_store::embedding_delete,
            memory::embedding_store::embedding_count,
            memory::retrieval_engine::retrieve_memories,
            memory::retrieval_engine::retrieve_memories_semantic,
            memory::retrieval_engine::inject_memories_into_prompt,
            request_app_exit,
            get_system_diagnostics,
            open_logs_folder,
            open_data_folder,
            generate_diagnostics_report,
            export_diagnostics_report,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(move |_app_handle, event| {
            match event {
                tauri::RunEvent::ExitRequested { .. } | tauri::RunEvent::Exit => {
                    // Graceful cleanup on app exit:
                    // 1. Shut down all LSP servers
                    lsp_manager::shutdown_all(&lsp_exit);

                    // 2. Kill all PTY sessions
                    pty_manager::kill_all(&pty_exit);

                    // 3. Shut down all DAP sessions
                    dap_manager::shutdown_all(&dap_exit);

                    // 4. File watcher is dropped automatically when app exits

                    // 5. Force exit — on Windows, orphaned child processes (PTY shells)
                    //    can keep the app process alive even after the window is destroyed.
                    std::process::exit(0);
                }
                _ => {}
            }
        });
}

#[cfg(test)]
mod lib_tests;
