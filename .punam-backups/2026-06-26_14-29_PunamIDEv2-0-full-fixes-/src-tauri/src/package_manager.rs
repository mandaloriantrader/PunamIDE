//! Package Manager — Phase 4, Step 4.2
//!
//! Wraps npm, pip, cargo, and yarn with a unified interface for
//! install, update, remove, and list operations.
//!
//! Used by ToolOrchestrator.ts (Phase 4, Step 4.4).

use serde::{Deserialize, Serialize};
use std::process::Command;
use std::path::PathBuf;

// ── Data Types ─────────────────────────────────────────────────────────────────

#[derive(Serialize, Deserialize, Clone, Debug)]
pub enum PackageManager {
    Npm,
    Yarn,
    Pnpm,
    Pip,
    Cargo,
    Bun,
}

impl PackageManager {
    fn from_str(s: &str) -> Option<Self> {
        match s.to_lowercase().as_str() {
            "npm" => Some(Self::Npm),
            "yarn" => Some(Self::Yarn),
            "pnpm" => Some(Self::Pnpm),
            "pip" | "pip3" => Some(Self::Pip),
            "cargo" => Some(Self::Cargo),
            "bun" => Some(Self::Bun),
            _ => None,
        }
    }

    fn cmd(&self) -> &str {
        match self {
            Self::Npm => "npm",
            Self::Yarn => "yarn",
            Self::Pnpm => "pnpm",
            Self::Pip => "pip",
            Self::Cargo => "cargo",
            Self::Bun => "bun",
        }
    }

    fn install_args(&self, packages: &[String]) -> Vec<String> {
        match self {
            Self::Npm => {
                let mut v = vec!["install".to_string()];
                v.extend(packages.iter().cloned());
                v
            }
            Self::Yarn => {
                let mut v = vec!["add".to_string()];
                v.extend(packages.iter().cloned());
                v
            }
            Self::Pnpm => {
                let mut v = vec!["add".to_string()];
                v.extend(packages.iter().cloned());
                v
            }
            Self::Pip => {
                let mut v = vec!["install".to_string()];
                v.extend(packages.iter().cloned());
                v
            }
            Self::Cargo => {
                let mut v = vec!["add".to_string()];
                v.extend(packages.iter().cloned());
                v
            }
            Self::Bun => {
                let mut v = vec!["add".to_string()];
                v.extend(packages.iter().cloned());
                v
            }
        }
    }

    fn remove_args(&self, packages: &[String]) -> Vec<String> {
        match self {
            Self::Npm => {
                let mut v = vec!["uninstall".to_string()];
                v.extend(packages.iter().cloned());
                v
            }
            Self::Yarn => {
                let mut v = vec!["remove".to_string()];
                v.extend(packages.iter().cloned());
                v
            }
            Self::Pnpm => {
                let mut v = vec!["remove".to_string()];
                v.extend(packages.iter().cloned());
                v
            }
            Self::Pip => {
                let mut v = vec!["uninstall".to_string(), "-y".to_string()];
                v.extend(packages.iter().cloned());
                v
            }
            Self::Cargo => {
                let mut v = vec!["remove".to_string()];
                v.extend(packages.iter().cloned());
                v
            }
            Self::Bun => {
                let mut v = vec!["remove".to_string()];
                v.extend(packages.iter().cloned());
                v
            }
        }
    }

    fn update_args(&self, packages: &[String]) -> Vec<String> {
        match self {
            Self::Npm => {
                let mut v = vec!["update".to_string()];
                v.extend(packages.iter().cloned());
                v
            }
            Self::Yarn => {
                let mut v = vec!["upgrade".to_string()];
                v.extend(packages.iter().cloned());
                v
            }
            Self::Pnpm => {
                let mut v = vec!["update".to_string()];
                v.extend(packages.iter().cloned());
                v
            }
            Self::Pip => {
                let mut v = vec!["install".to_string(), "--upgrade".to_string()];
                v.extend(packages.iter().cloned());
                v
            }
            Self::Cargo => {
                let mut v = vec!["update".to_string()];
                v.extend(packages.iter().cloned());
                v
            }
            Self::Bun => {
                let mut v = vec!["update".to_string()];
                v.extend(packages.iter().cloned());
                v
            }
        }
    }
}

#[derive(Serialize, Debug)]
pub struct PackageOperationResult {
    pub success: bool,
    pub manager: String,
    pub operation: String,
    pub packages: Vec<String>,
    pub stdout: String,
    pub stderr: String,
    pub exit_code: Option<i32>,
    pub error: Option<String>,
}

// ── Tauri Commands ─────────────────────────────────────────────────────────────

/// Install one or more packages using the specified package manager.
#[tauri::command]
pub fn package_install(
    manager: String,
    packages: Vec<String>,
    project_path: Option<String>,
) -> Result<PackageOperationResult, String> {
    let pm = PackageManager::from_str(&manager)
        .ok_or_else(|| format!("Unknown package manager: {}", manager))?;

    let cwd = project_path
        .map(PathBuf::from)
        .unwrap_or_else(|| std::env::current_dir().unwrap_or_default());

    let args = pm.install_args(&packages);

    let output = Command::new(pm.cmd())
        .args(&args)
        .current_dir(&cwd)
        .output()
        .map_err(|e| format!("Failed to run {}: {}", pm.cmd(), e))?;

    Ok(PackageOperationResult {
        success: output.status.success(),
        manager: manager.clone(),
        operation: "install".to_string(),
        packages,
        stdout: String::from_utf8_lossy(&output.stdout).to_string(),
        stderr: String::from_utf8_lossy(&output.stderr).to_string(),
        exit_code: output.status.code(),
        error: if output.status.success() { None } else { Some("Installation failed".to_string()) },
    })
}

/// Remove one or more packages.
#[tauri::command]
pub fn package_remove(
    manager: String,
    packages: Vec<String>,
    project_path: Option<String>,
) -> Result<PackageOperationResult, String> {
    let pm = PackageManager::from_str(&manager)
        .ok_or_else(|| format!("Unknown package manager: {}", manager))?;

    let cwd = project_path
        .map(PathBuf::from)
        .unwrap_or_else(|| std::env::current_dir().unwrap_or_default());

    let args = pm.remove_args(&packages);

    let output = Command::new(pm.cmd())
        .args(&args)
        .current_dir(&cwd)
        .output()
        .map_err(|e| format!("Failed to run {}: {}", pm.cmd(), e))?;

    Ok(PackageOperationResult {
        success: output.status.success(),
        manager: manager.clone(),
        operation: "remove".to_string(),
        packages,
        stdout: String::from_utf8_lossy(&output.stdout).to_string(),
        stderr: String::from_utf8_lossy(&output.stderr).to_string(),
        exit_code: output.status.code(),
        error: if output.status.success() { None } else { Some("Removal failed".to_string()) },
    })
}

/// Update one or more packages.
#[tauri::command]
pub fn package_update(
    manager: String,
    packages: Vec<String>,
    project_path: Option<String>,
) -> Result<PackageOperationResult, String> {
    let pm = PackageManager::from_str(&manager)
        .ok_or_else(|| format!("Unknown package manager: {}", manager))?;

    let cwd = project_path
        .map(PathBuf::from)
        .unwrap_or_else(|| std::env::current_dir().unwrap_or_default());

    let args = pm.update_args(&packages);

    let output = Command::new(pm.cmd())
        .args(&args)
        .current_dir(&cwd)
        .output()
        .map_err(|e| format!("Failed to run {}: {}", pm.cmd(), e))?;

    Ok(PackageOperationResult {
        success: output.status.success(),
        manager: manager.clone(),
        operation: "update".to_string(),
        packages,
        stdout: String::from_utf8_lossy(&output.stdout).to_string(),
        stderr: String::from_utf8_lossy(&output.stderr).to_string(),
        exit_code: output.status.code(),
        error: if output.status.success() { None } else { Some("Update failed".to_string()) },
    })
}

/// Run audit/check on installed dependencies.
#[tauri::command]
pub fn package_audit(
    manager: String,
    project_path: Option<String>,
) -> Result<PackageOperationResult, String> {
    let cwd = project_path
        .map(PathBuf::from)
        .unwrap_or_else(|| std::env::current_dir().unwrap_or_default());

    let (cmd, args) = match manager.to_lowercase().as_str() {
        "npm" => ("npm", vec!["audit".to_string(), "--json".to_string()]),
        "yarn" => ("yarn", vec!["audit".to_string()]),
        "pnpm" => ("pnpm", vec!["audit".to_string()]),
        "pip" => ("pip", vec!["check".to_string()]),
        "cargo" => ("cargo", vec!["audit".to_string()]),
        "bun" => ("bun", vec!["pm".to_string(), "audit".to_string()]),
        _ => return Err(format!("Audit not supported for: {}", manager)),
    };

    let output = Command::new(cmd)
        .args(&args)
        .current_dir(&cwd)
        .output()
        .map_err(|e| format!("Failed to run audit: {}", e))?;

    Ok(PackageOperationResult {
        success: output.status.success(),
        manager: manager.clone(),
        operation: "audit".to_string(),
        packages: vec![],
        stdout: String::from_utf8_lossy(&output.stdout).to_string(),
        stderr: String::from_utf8_lossy(&output.stderr).to_string(),
        exit_code: output.status.code(),
        error: if output.status.success() { None } else { Some("Audit found vulnerabilities".to_string()) },
    })
}

// ── Tests ──────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_package_manager_parsing() {
        assert!(PackageManager::from_str("npm").is_some());
        assert!(PackageManager::from_str("cargo").is_some());
        assert!(PackageManager::from_str("pip").is_some());
        assert!(PackageManager::from_str("unknown").is_none());
    }

    #[test]
    fn test_npm_install_args() {
        let pm = PackageManager::Npm;
        let args = pm.install_args(&["react".to_string(), "lodash".to_string()]);
        assert_eq!(args, vec!["install", "react", "lodash"]);
    }

    #[test]
    fn test_cargo_install_args() {
        let pm = PackageManager::Cargo;
        let args = pm.install_args(&["serde".to_string()]);
        assert_eq!(args, vec!["add", "serde"]);
    }

    #[test]
    fn test_pip_remove_args() {
        let pm = PackageManager::Pip;
        let args = pm.remove_args(&["requests".to_string()]);
        assert!(args.contains(&"uninstall".to_string()));
    }
}