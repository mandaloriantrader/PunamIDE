/**
 * ToolOrchestrator.ts — Phase 4, Step 4.4
 *
 * Unified TypeScript interface for tool orchestration.
 * Calls Rust backend commands: environment_scanner, package_manager, docker_controller.
 * Provides a clean API for the EnvironmentDashboard UI panel.
 */

import { invoke } from "@tauri-apps/api/core";

// ── Types (mirrors Rust structs from environment_scanner.rs) ──────────────────

export interface ToolInfo {
  name: string;
  path: string | null;
  version: string;
  installed: boolean;
  category: string;
  display_name: string;
  error: string | null;
}

export interface EnvironmentSummary {
  total_detected: number;
  total_installed: number;
  total_missing: number;
  runtimes: string[];
  package_managers: string[];
  containers: string[];
  missing_recommendations: string[];
}

export interface EnvironmentScanResult {
  tools: ToolInfo[];
  summary: EnvironmentSummary;
}

export interface PackageInfo {
  name: string;
  version: string;
  manager: string; // "npm", "pip", "cargo", "apt", "brew", "choco"
  isGlobal: boolean;
  isDeprecated?: boolean;
  latestVersion?: string;
  warnings?: string[];
}

export interface ProjectDependencyReport {
  manager: string;
  packages: PackageInfo[];
  totalCount: number;
  outdatedCount: number;
  vulnerableCount: number;
  conflicts: Array<{ pkgA: string; pkgB: string; reason: string }>;
}

export interface DockerContainerInfo {
  id: string;
  name: string;
  image: string;
  status: string; // "running", "stopped", "paused"
  ports: string[];
  created: string;
}

// ── Tool Orchestrator Class ───────────────────────────────────────────────────

export class ToolOrchestrator {

  // Cache scan results for 60 seconds — prevents re-scanning every tab click
  private _cache: EnvironmentScanResult | null = null;
  private _cacheTime = 0;
  private static readonly CACHE_TTL_MS = 60_000;

  // ── Environment Scanner ──────────────────────────────────────────────────

  /** Scan the system for all installed development tools.
   *  Results are cached for 60 seconds — pass force=true to bypass. */
  async scanEnvironment(force = false): Promise<EnvironmentScanResult> {
    if (!force && this._cache && Date.now() - this._cacheTime < ToolOrchestrator.CACHE_TTL_MS) {
      return this._cache;
    }
    const result = await invoke<EnvironmentScanResult>("scan_tools");
    this._cache = result;
    this._cacheTime = Date.now();
    return result;
  }

  /** Get a single tool's status — uses cached scan, no extra IPC call. */
  async getToolStatus(toolName: string): Promise<ToolInfo | null> {
    const result = await this.scanEnvironment();
    return result.tools.find((t) => t.name === toolName) || null;
  }

  /** Check if a specific tool is installed — uses cached scan. */
  async isToolInstalled(toolName: string): Promise<boolean> {
    const tool = await this.getToolStatus(toolName);
    return tool?.installed ?? false;
  }

  // ── Package Manager ──────────────────────────────────────────────────────

  /** List installed packages for a given package manager. */
  async listPackages(manager: "npm" | "pip" | "cargo" | "apt" | "brew" | "choco"): Promise<PackageInfo[]> {
    return invoke<PackageInfo[]>("list_packages", { manager });
  }

  /** Install a package using the appropriate package manager. */
  async installPackage(manager: string, packageName: string, isGlobal = false): Promise<{ success: boolean; output: string }> {
    return invoke("install_package", { manager, packageName, isGlobal });
  }

  /** Update a package to latest version. */
  async updatePackage(manager: string, packageName: string): Promise<{ success: boolean; output: string }> {
    return invoke("update_package", { manager, packageName });
  }

  /** Remove a package. */
  async removePackage(manager: string, packageName: string): Promise<{ success: boolean; output: string }> {
    return invoke("remove_package", { manager, packageName });
  }

  /** Get a project dependency report (reads package.json/Cargo.toml/requirements.txt). */
  async getProjectDependencies(projectPath: string): Promise<ProjectDependencyReport> {
    return invoke<ProjectDependencyReport>("analyze_project_dependencies", { projectPath });
  }

  // ── Docker Controller ────────────────────────────────────────────────────

  /** List all Docker containers. */
  async listContainers(all = false): Promise<DockerContainerInfo[]> {
    return invoke<DockerContainerInfo[]>("list_containers", { all });
  }

  /** Start a Docker container. */
  async startContainer(containerId: string): Promise<{ success: boolean; message: string }> {
    return invoke("start_container", { containerId });
  }

  /** Stop a Docker container. */
  async stopContainer(containerId: string): Promise<{ success: boolean; message: string }> {
    return invoke("stop_container", { containerId });
  }

  /** Get container logs. */
  async getContainerLogs(containerId: string, tail = 100): Promise<string> {
    return invoke<string>("get_container_logs", { containerId, tail });
  }

  // ── Convenience Methods ──────────────────────────────────────────────────

  /** Refresh all environment data at once. */
  async refreshAll(projectPath?: string): Promise<{
    environment: EnvironmentScanResult;
    dependencies?: ProjectDependencyReport;
    containers?: DockerContainerInfo[];
  }> {
    const [environment, containers] = await Promise.all([
      this.scanEnvironment(),
      this.listContainers(true).catch(() => [] as DockerContainerInfo[]),
    ]);

    let dependencies: ProjectDependencyReport | undefined;
    if (projectPath) {
      dependencies = await this.getProjectDependencies(projectPath).catch(() => undefined);
    }

    return { environment, dependencies, containers };
  }

  /** Get install recommendations for a missing tool. */
  getInstallRecommendation(toolName: string): string | null {
    const recommendations: Record<string, string> = {
      "node": "Install from https://nodejs.org or use: winget install OpenJS.NodeJS",
      "python": "Install from https://python.org or use: winget install Python.Python.3",
      "rustc": "Install Rust from https://rustup.rs",
      "go": "Install from https://go.dev/dl or use: winget install GoLang.Go",
      "docker": "Install Docker Desktop from https://docker.com",
      "git": "Install from https://git-scm.com or use: winget install Git.Git",
      "kubectl": "Install via: winget install Kubernetes.kubectl",
      "aws": "Install AWS CLI from https://aws.amazon.com/cli",
      "gcloud": "Install Google Cloud SDK from https://cloud.google.com/sdk",
    };
    return recommendations[toolName] || null;
  }
}

// ── Singleton ──────────────────────────────────────────────────────────────────

let instance: ToolOrchestrator | null = null;

export function getToolOrchestrator(): ToolOrchestrator {
  if (!instance) {
    instance = new ToolOrchestrator();
  }
  return instance;
}