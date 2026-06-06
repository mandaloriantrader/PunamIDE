//! Environment Scanner — Phase 4, Step 4.1
//!
//! Detects installed development tools (node, python, rust, docker, kubectl,
//! git, aws-cli, gcloud) with their versions and paths.
//!
//! Used by ToolOrchestrator.ts (Phase 4, Step 4.4) and EnvironmentManager.ts
//! (Phase 4, Step 4.6) to power the environment dashboard UI.

use serde::{Deserialize, Serialize};
use std::process::Command;
use std::path::PathBuf;
use std::collections::HashMap;

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

// ── Data Types ─────────────────────────────────────────────────────────────────

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct ToolInfo {
    /// Tool name (e.g., "node", "python", "docker")
    pub name: String,
    /// Full path to the executable, if found
    pub path: Option<String>,
    /// Detected version string
    pub version: String,
    /// Whether the tool was found and is functional
    pub installed: bool,
    /// Category: "runtime", "package_manager", "container", "vcs", "cloud", "build"
    pub category: String,
    /// Human-readable tool display name
    pub display_name: String,
    /// Error message if detection failed
    pub error: Option<String>,
}

#[derive(Serialize, Debug)]
pub struct EnvironmentScanResult {
    pub tools: Vec<ToolInfo>,
    pub summary: EnvironmentSummary,
}

#[derive(Serialize, Debug)]
pub struct EnvironmentSummary {
    pub total_detected: usize,
    pub total_installed: usize,
    pub total_missing: usize,
    pub runtimes: Vec<String>,
    pub package_managers: Vec<String>,
    pub containers: Vec<String>,
    pub missing_recommendations: Vec<String>,
}

// ── Tool Definitions ───────────────────────────────────────────────────────────

/// Registry of all tools to detect.
/// Each entry: (command_name, display_name, category, version_args, version_regex_hint)
struct ToolDef {
    cmd: &'static str,
    display_name: &'static str,
    category: &'static str,
    version_args: &'static [&'static str],
}

const TOOLS: &[ToolDef] = &[
    // ── Runtimes ────────────────────────────────────────────────────────────
    ToolDef { cmd: "node",    display_name: "Node.js",           category: "runtime",         version_args: &["--version"] },
    ToolDef { cmd: "python",  display_name: "Python",            category: "runtime",         version_args: &["--version"] },
    ToolDef { cmd: "python3", display_name: "Python 3",          category: "runtime",         version_args: &["--version"] },
    ToolDef { cmd: "rustc",   display_name: "Rust Compiler",     category: "runtime",         version_args: &["--version"] },
    ToolDef { cmd: "go",      display_name: "Go",                category: "runtime",         version_args: &["version"] },
    ToolDef { cmd: "java",    display_name: "Java",              category: "runtime",         version_args: &["--version"] },
    ToolDef { cmd: "dotnet",  display_name: ".NET SDK",          category: "runtime",         version_args: &["--version"] },

    // ── Package Managers ─────────────────────────────────────────────────────
    ToolDef { cmd: "npm",     display_name: "npm",               category: "package_manager", version_args: &["--version"] },
    ToolDef { cmd: "npx",     display_name: "npx",               category: "package_manager", version_args: &["--version"] },
    ToolDef { cmd: "yarn",    display_name: "Yarn",              category: "package_manager", version_args: &["--version"] },
    ToolDef { cmd: "pnpm",    display_name: "pnpm",              category: "package_manager", version_args: &["--version"] },
    ToolDef { cmd: "pip",     display_name: "pip",               category: "package_manager", version_args: &["--version"] },
    ToolDef { cmd: "pip3",    display_name: "pip3",              category: "package_manager", version_args: &["--version"] },
    ToolDef { cmd: "cargo",   display_name: "Cargo",             category: "package_manager", version_args: &["--version"] },
    ToolDef { cmd: "bun",     display_name: "Bun",               category: "package_manager", version_args: &["--version"] },

    // ── Containers & Orchestration ───────────────────────────────────────────
    ToolDef { cmd: "docker",  display_name: "Docker",            category: "container",       version_args: &["--version"] },
    ToolDef { cmd: "kubectl", display_name: "Kubernetes CLI",    category: "container",       version_args: &["version", "--client"] },

    // ── Version Control ──────────────────────────────────────────────────────
    ToolDef { cmd: "git",     display_name: "Git",               category: "vcs",             version_args: &["--version"] },

    // ── Cloud CLIs ───────────────────────────────────────────────────────────
    ToolDef { cmd: "aws",     display_name: "AWS CLI",           category: "cloud",           version_args: &["--version"] },
    ToolDef { cmd: "gcloud",  display_name: "Google Cloud CLI",  category: "cloud",           version_args: &["--version"] },
];

// ── Scanner Implementation ─────────────────────────────────────────────────────

/// Try to find a tool executable on the system PATH.
fn find_executable(cmd: &str) -> Option<PathBuf> {
    let extensions = if cfg!(windows) {
        vec!["", ".exe", ".cmd", ".bat"]
    } else {
        vec![""]
    };

    if let Ok(path_var) = std::env::var("PATH") {
        let sep = if cfg!(windows) { ';' } else { ':' };
        for dir in path_var.split(sep) {
            for ext in &extensions {
                let full = PathBuf::from(dir).join(format!("{}{}", cmd, ext));
                if full.is_file() || (cfg!(windows) && full.exists()) {
                    // On Windows, also check the actual file
                    return Some(full);
                }
            }
        }
    }

    None
}

/// Run --version and capture stdout.
fn get_version(exe_path: &PathBuf, version_args: &[&str]) -> Result<String, String> {
    let mut cmd = Command::new(exe_path);
    cmd.args(version_args);

    #[cfg(target_os = "windows")]
    cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW

    let output = cmd
        .output()
        .map_err(|e| format!("Failed to run: {}", e))?;

    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);

    // Some tools output version to stderr (e.g., python --version)
    let version_text = if stdout.trim().is_empty() {
        stderr.trim().to_string()
    } else {
        stdout.trim().to_string()
    };

    if version_text.is_empty() {
        Err("No version output".to_string())
    } else {
        // Take just the first line
        let first_line = version_text.lines().next().unwrap_or(&version_text);
        Ok(first_line.to_string())
    }
}

/// Scan all registered tools and return their info.
pub fn scan_environment() -> EnvironmentScanResult {
    let mut tools = Vec::new();
    let mut runtimes = Vec::new();
    let mut package_managers = Vec::new();
    let mut containers = Vec::new();
    let mut missing_recommendations = Vec::new();
    let mut installed_count = 0;
    let mut missing_count = 0;

    for def in TOOLS {
        let path = find_executable(def.cmd);

        let (version, error) = if let Some(ref p) = path {
            match get_version(p, def.version_args) {
                Ok(v) => (v, None),
                Err(e) => ("unknown".to_string(), Some(e)),
            }
        } else {
            ("not installed".to_string(), None)
        };

        let installed = path.is_some() && error.is_none();

        if installed {
            installed_count += 1;
            match def.category {
                "runtime" => runtimes.push(def.display_name.to_string()),
                "package_manager" => package_managers.push(def.display_name.to_string()),
                "container" => containers.push(def.display_name.to_string()),
                _ => {}
            }
        } else {
            missing_count += 1;
            missing_recommendations.push(format!(
                "{} is not installed. Run `{} --help` to install or check PATH.",
                def.display_name, def.cmd
            ));
        }

        tools.push(ToolInfo {
            name: def.cmd.to_string(),
            path: path.map(|p| p.to_string_lossy().to_string()),
            version,
            installed,
            category: def.category.to_string(),
            display_name: def.display_name.to_string(),
            error,
        });
    }

    let summary = EnvironmentSummary {
        total_detected: tools.len(),
        total_installed: installed_count,
        total_missing: missing_count,
        runtimes,
        package_managers,
        containers,
        missing_recommendations,
    };

    EnvironmentScanResult { tools, summary }
}

// ── Tauri Commands ─────────────────────────────────────────────────────────────

/// Scan the development environment for installed tools.
///
/// Returns structured ToolInfo for all supported tools (Node, Python, Rust,
/// Docker, Git, etc.) along with a summary for dashboard display.
#[tauri::command]
pub fn scan_tools() -> EnvironmentScanResult {
    scan_environment()
}

/// Quick check: is a specific tool available?
#[tauri::command]
pub fn tool_installed(tool_name: String) -> bool {
    find_executable(&tool_name).is_some()
}

/// Get the version of a specific tool.
#[tauri::command]
pub fn tool_version(tool_name: String) -> Result<String, String> {
    let path = find_executable(&tool_name)
        .ok_or_else(|| format!("Tool not found: {}", tool_name))?;

    let version_args = TOOLS
        .iter()
        .find(|t| t.cmd == tool_name)
        .map(|t| t.version_args)
        .unwrap_or(&["--version"]);

    get_version(&path, version_args)
}

// ── Tests ──────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_tool_definitions_complete() {
        // Verify all tools have required fields
        for tool in TOOLS {
            assert!(!tool.cmd.is_empty(), "Tool {} has empty cmd", tool.display_name);
            assert!(!tool.display_name.is_empty());
            assert!(!tool.category.is_empty());
            assert!(!tool.version_args.is_empty());
        }
    }

    #[test]
    fn test_scan_returns_all_tools() {
        let result = scan_environment();
        assert_eq!(result.tools.len(), TOOLS.len());
        assert!(result.summary.total_detected > 0);
    }

    #[test]
    fn test_git_is_usually_installed() {
        assert!(tool_installed("git".to_string()));
    }

    #[test]
    fn test_nonexistent_tool_not_installed() {
        assert!(!tool_installed("nonexistent_tool_xyz_123".to_string()));
    }
}