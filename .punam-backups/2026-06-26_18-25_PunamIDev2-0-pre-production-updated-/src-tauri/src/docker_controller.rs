//! Docker Controller — Phase 4, Step 4.3
//!
//! Container lifecycle management via Docker CLI wrapper.
//! Provides start, stop, logs, exec, and image management.
//!
//! Used by ToolOrchestrator.ts (Phase 4, Step 4.4).

use serde::{Deserialize, Serialize};
use std::process::Command;

// ── Data Types ─────────────────────────────────────────────────────────────────

#[derive(Serialize, Debug)]
pub struct DockerResult {
    pub success: bool,
    pub operation: String,
    pub container_or_image: String,
    pub stdout: String,
    pub stderr: String,
    pub error: Option<String>,
}

#[derive(Serialize, Debug)]
pub struct DockerContainerInfo {
    pub id: String,
    pub name: String,
    pub image: String,
    pub status: String,
    pub ports: String,
}

// ── Commands ───────────────────────────────────────────────────────────────────

/// List all running (and stopped) containers.
#[tauri::command]
pub fn docker_list_containers(all: bool) -> Result<Vec<DockerContainerInfo>, String> {
    let mut args = vec!["ps".to_string(), "--format".to_string(), "{{.ID}}\t{{.Names}}\t{{.Image}}\t{{.Status}}\t{{.Ports}}".to_string()];
    if all { args.push("-a".to_string()); }

    let output = Command::new("docker")
        .args(&args)
        .output()
        .map_err(|e| format!("Failed to run docker ps: {}. Is Docker installed?", e))?;

    let stdout = String::from_utf8_lossy(&output.stdout);
    let mut containers = Vec::new();

    for line in stdout.lines() {
        let parts: Vec<&str> = line.split('\t').collect();
        if parts.len() >= 5 {
            containers.push(DockerContainerInfo {
                id: parts[0].to_string(),
                name: parts[1].to_string(),
                image: parts[2].to_string(),
                status: parts[3].to_string(),
                ports: parts[4].to_string(),
            });
        }
    }

    Ok(containers)
}

/// Start a container.
#[tauri::command]
pub fn docker_start(container: String) -> Result<DockerResult, String> {
    let output = Command::new("docker")
        .args(["start", &container])
        .output()
        .map_err(|e| format!("Failed to run docker start: {}", e))?;

    Ok(DockerResult {
        success: output.status.success(),
        operation: "start".to_string(),
        container_or_image: container,
        stdout: String::from_utf8_lossy(&output.stdout).to_string(),
        stderr: String::from_utf8_lossy(&output.stderr).to_string(),
        error: if output.status.success() { None } else { Some("Container start failed".to_string()) },
    })
}

/// Stop a container.
#[tauri::command]
pub fn docker_stop(container: String) -> Result<DockerResult, String> {
    let output = Command::new("docker")
        .args(["stop", &container])
        .output()
        .map_err(|e| format!("Failed to run docker stop: {}", e))?;

    Ok(DockerResult {
        success: output.status.success(),
        operation: "stop".to_string(),
        container_or_image: container,
        stdout: String::from_utf8_lossy(&output.stdout).to_string(),
        stderr: String::from_utf8_lossy(&output.stderr).to_string(),
        error: if output.status.success() { None } else { Some("Container stop failed".to_string()) },
    })
}

/// Get logs from a container.
#[tauri::command]
pub fn docker_logs(container: String, tail: Option<usize>) -> Result<DockerResult, String> {
    let mut args = vec!["logs".to_string()];
    if let Some(n) = tail {
        args.push("--tail".to_string());
        args.push(n.to_string());
    }
    args.push(container.clone());

    let output = Command::new("docker")
        .args(&args)
        .output()
        .map_err(|e| format!("Failed to run docker logs: {}", e))?;

    Ok(DockerResult {
        success: output.status.success(),
        operation: "logs".to_string(),
        container_or_image: container,
        stdout: String::from_utf8_lossy(&output.stdout).to_string(),
        stderr: String::from_utf8_lossy(&output.stderr).to_string(),
        error: None,
    })
}

/// Execute a command inside a running container.
#[tauri::command]
pub fn docker_exec(container: String, command: Vec<String>) -> Result<DockerResult, String> {
    let mut args = vec!["exec".to_string(), container.clone()];
    args.extend(command);

    let output = Command::new("docker")
        .args(&args)
        .output()
        .map_err(|e| format!("Failed to run docker exec: {}", e))?;

    Ok(DockerResult {
        success: output.status.success(),
        operation: "exec".to_string(),
        container_or_image: container,
        stdout: String::from_utf8_lossy(&output.stdout).to_string(),
        stderr: String::from_utf8_lossy(&output.stderr).to_string(),
        error: if output.status.success() { None } else { Some("Exec failed".to_string()) },
    })
}

/// Remove a container.
#[tauri::command]
pub fn docker_remove_container(container: String, force: bool) -> Result<DockerResult, String> {
    let mut args = vec!["rm".to_string()];
    if force { args.push("-f".to_string()); }
    args.push(container.clone());

    let output = Command::new("docker")
        .args(&args)
        .output()
        .map_err(|e| format!("Failed to run docker rm: {}", e))?;

    Ok(DockerResult {
        success: output.status.success(),
        operation: "remove".to_string(),
        container_or_image: container,
        stdout: String::from_utf8_lossy(&output.stdout).to_string(),
        stderr: String::from_utf8_lossy(&output.stderr).to_string(),
        error: if output.status.success() { None } else { Some("Container removal failed".to_string()) },
    })
}

/// Check if Docker is available.
#[tauri::command]
pub fn docker_available() -> bool {
    Command::new("docker")
        .arg("--version")
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

// ── Tests ──────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_docker_available_doesnt_crash() {
        // Just verify this doesn't panic
        let _ = docker_available();
    }
}