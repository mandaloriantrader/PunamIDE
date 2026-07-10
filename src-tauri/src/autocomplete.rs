use serde::{Deserialize, Serialize};
use std::time::Duration;

/// Timeout for autocomplete API requests (8 seconds).
/// Balances responsiveness with provider latency variability.
const REQUEST_TIMEOUT_MS: u64 = 8000;

#[derive(Deserialize, Debug)]
#[allow(non_snake_case)]
pub struct FimCompletionRequest {
    pub apiKey: String,
    pub baseUrl: String,
    pub model: String,
    pub prompt: String,
    pub maxTokens: u32,
    pub stopTokens: Vec<String>,
}

#[derive(Deserialize, Debug)]
#[allow(non_snake_case)]
pub struct ChatCompletionSimpleRequest {
    pub apiKey: String,
    pub baseUrl: String,
    pub model: String,
    pub systemPrompt: String,
    pub userPrompt: String,
    pub maxTokens: u32,
}

#[derive(Serialize, Debug)]
pub struct CompletionResponse {
    pub text: String,
    pub success: bool,
    pub error: Option<String>,
}

// ─── FIM Completion ──────────────────────────────────────────────────────────

/// Non-streaming FIM completion. POSTs to {baseUrl}/v1/completions.
#[tauri::command]
#[allow(non_snake_case)]
pub async fn call_fim_completion(request: FimCompletionRequest) -> CompletionResponse {
    let url = format!("{}/v1/completions", request.baseUrl.trim_end_matches('/'));

    let body = serde_json::json!({
        "model": request.model,
        "prompt": request.prompt,
        "max_tokens": request.maxTokens,
        "temperature": 0.1,
        "stop": request.stopTokens,
        "stream": false
    });

    let client = match build_client() {
        Ok(c) => c,
        Err(e) => return error_response(e),
    };

    let mut req_builder = client.post(&url).header("Content-Type", "application/json");
    if !request.apiKey.is_empty() {
        req_builder = req_builder.header("Authorization", format!("Bearer {}", request.apiKey));
    }

    let resp = match req_builder.json(&body).send().await {
        Ok(r) => r,
        Err(e) => return error_response(format_network_error(&e)),
    };

    let status = resp.status();
    let resp_body: serde_json::Value = match resp.json().await {
        Ok(v) => v,
        Err(e) => return error_response(format!("Failed to parse response: {}", e)),
    };

    if !status.is_success() {
        return error_response(format!("API error {}: {}", status, resp_body));
    }

    let text = resp_body["choices"][0]["text"]
        .as_str()
        .unwrap_or("")
        .to_string();

    CompletionResponse { text, success: true, error: None }
}

// ─── Chat Completion (Simple, Non-Streaming) ─────────────────────────────────

/// Non-streaming chat completion for autocomplete fallback.
/// Handles thinking-model quirks (DeepSeek v4/R1) by disabling CoT.
#[tauri::command]
#[allow(non_snake_case)]
pub async fn call_chat_completion_simple(request: ChatCompletionSimpleRequest) -> CompletionResponse {
    let url = format!("{}/v1/chat/completions", request.baseUrl.trim_end_matches('/'));
    let model_lower = request.model.to_lowercase();

    let mut body = serde_json::json!({
        "model": request.model,
        "messages": [
            {"role": "system", "content": request.systemPrompt},
            {"role": "user", "content": request.userPrompt}
        ],
        "max_tokens": request.maxTokens,
        "temperature": 0.1,
        "stream": false
    });

    // DeepSeek thinking models (v4, r1): disable chain-of-thought for code completions
    if model_lower.contains("deepseek") {
        body["thinking"] = serde_json::json!({"type": "disabled"});
    }

    let client = match build_client() {
        Ok(c) => c,
        Err(e) => return error_response(e),
    };

    let mut req_builder = client.post(&url).header("Content-Type", "application/json");
    if !request.apiKey.is_empty() {
        req_builder = req_builder.header("Authorization", format!("Bearer {}", request.apiKey));
    }

    let resp = match req_builder.json(&body).send().await {
        Ok(r) => r,
        Err(e) => return error_response(format_network_error(&e)),
    };

    let status = resp.status();
    let resp_body: serde_json::Value = match resp.json().await {
        Ok(v) => v,
        Err(e) => return error_response(format!("Failed to parse response: {}", e)),
    };

    if !status.is_success() {
        return error_response(format!("API error {}: {}", status, resp_body));
    }

    // Extract text: try content first, then reasoning_content as fallback
    let message = &resp_body["choices"][0]["message"];
    let text = extract_message_text(message);

    if text.is_empty() {
        return error_response("Provider returned empty completion".to_string());
    }

    CompletionResponse { text, success: true, error: None }
}

// ─── Shared Utilities ────────────────────────────────────────────────────────

fn build_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(Duration::from_millis(REQUEST_TIMEOUT_MS))
        .build()
        .map_err(|e| format!("Failed to build HTTP client: {}", e))
}

fn format_network_error(e: &reqwest::Error) -> String {
    if e.is_timeout() {
        "Request timed out".to_string()
    } else if e.is_connect() {
        "Connection failed — check network".to_string()
    } else {
        format!("Network error: {}", e)
    }
}

fn error_response(msg: String) -> CompletionResponse {
    CompletionResponse {
        text: String::new(),
        success: false,
        error: Some(msg),
    }
}

/// Extracts the completion text from a chat response message object.
/// Handles standard OpenAI format and DeepSeek reasoning_content fallback.
fn extract_message_text(message: &serde_json::Value) -> String {
    // Standard path: choices[0].message.content
    if let Some(content) = message["content"].as_str() {
        if !content.is_empty() {
            return content.to_string();
        }
    }

    // Fallback for thinking models: reasoning_content contains the answer
    if let Some(reasoning) = message["reasoning_content"].as_str() {
        if !reasoning.is_empty() {
            return reasoning.to_string();
        }
    }

    String::new()
}
