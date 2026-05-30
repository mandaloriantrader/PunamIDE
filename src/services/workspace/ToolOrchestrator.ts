/**
 * ToolOrchestrator.ts — Phase 4, Step 4.4
 *
 * Unified command interface dispatching to the correct runtime (Node, Python,
 * Rust, Docker, etc.) based on detected environment tools.
 *
 * Consumes Phase 4 Rust backends:
 *   - environment_scanner.rs (scan_tools, tool_installed)
 *   - package_manager.rs (package_install, package_remove, etc.)
 *   - docker_controller.rs (docker_start, docker_stop, etc.)
 */

import { invoke } from "@tauri-apps/api/core";

// ── Types ──────────────────────────────────────────────────────────────────────

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

export interface PackageOperationResult {
  success: boolean;
  manager: string;
  operation: string;
  packages: string[];
  stdout: string;
  stderr: string;
  exit_code: number | null;
  error: string | null;
}

export interface DockerContainerInfo {
  id: string;
  name: string;
  image: string;
  status: string;
  ports: string;
}

export interface DockerResult {
  success: boolean;
  operation: string;
  container_or_image: string;
  stdout: string;
  stderr: string;
  error: string | null;
}

// ── ToolOrchestrator Class ────────────────────────────────────────────────────

export class ToolOrchestrator {
  // ── Environment Scanner ──────────────────────────────────────────────────

  /** Scan the development environment for all installed tools. */
  static async scanTools(): Promise<EnvironmentScanResult> {
    return invoke<EnvironmentScanResult>("scan_tools");
  }

  /** Quick check: is a specific tool available? */
  static async isToolInstalled(toolName: string): Promise<boolean> {
    return invoke<boolean>("tool_installed", { toolName });
  }

  /** Get the version of a specific tool. */
  static async getToolVersion(toolName: string): Promise<string> {
    return invoke<string>("tool_version", { toolName });
  }

  /** Check if Docker is available. */
  static async isDockerAvailable(): Promise<boolean> {
    return invoke<boolean>("docker_available");
  }

  // ── Package Manager ──────────────────────────────────────────────────────

  /** Install packages using the specified manager. */
  static async installPackage(
    manager: "npm" | "yarn" | "pnpm" | "pip" | "cargo" | "bun",
    packages: string[],
    projectPath?: string,
  ): Promise<PackageOperationResult> {
    return invoke<PackageOperationResult>("package_install", {
      manager,
      packages,
      projectPath: projectPath || null,
    });
  }

  /** Remove packages using the specified manager. */
  static async removePackage(
    manager: "npm" | "yarn" | "pnpm" | "pip" | "cargo" | "bun",
    packages: string[],
    projectPath?: string,
  ): Promise<PackageOperationResult> {
    return invoke<PackageOperationResult>("package_remove", {
      manager,
      packages,
      projectPath: projectPath || null,
    });
  }

  /** Update packages using the specified manager. */
  static async updatePackage(
    manager: "npm" | "yarn" | "pnpm" | "pip" | "cargo" | "bun",
    packages: string[],
    projectPath?: string,
  ): Promise<PackageOperationResult> {
    return invoke<PackageOperationResult>("package_update", {
      manager,
      packages,
      projectPath: projectPath || null,
    });
  }

  /** Audit dependencies for vulnerabilities. */
  static async auditDependencies(
    manager: "npm" | "yarn" | "pnpm" | "pip" | "cargo" | "bun",
    projectPath?: string,
  ): Promise<PackageOperationResult> {
    return invoke<PackageOperationResult>("package_audit", {
      manager,
      projectPath: projectPath || null,
    });
  }

  // ── Docker Controller ────────────────────────────────────────────────────

  /** List Docker containers. */
  static async listContainers(all = false): Promise<DockerContainerInfo[]> {
    return invoke<DockerContainerInfo[]>("docker_list_containers", { all });
  }

  /** Start a Docker container. */
  static async startContainer(container: string): Promise<DockerResult> {
    return invoke<DockerResult>("docker_start", { container });
  }

  /** Stop a Docker container. */
  static async stopContainer(container: string): Promise<DockerResult> {
    return invoke<DockerResult>("docker_stop", { container });
  }

  /** Get logs from a Docker container. */
  static async containerLogs(container: string, tail?: number): Promise<DockerResult> {
    return invoke<DockerResult>("docker_logs", { container, tail: tail || null });
  }

  /** Execute a command inside a container. */
  static async execInContainer(container: string, command: string[]): Promise<DockerResult> {
    return invoke<DockerResult>("docker_exec", { container, command });
  }

  /** Remove a Docker container. */
  static async removeContainer(container: string, force = false): Promise<DockerResult> {
    return invoke<DockerResult>("docker_remove_container", { container, force });
  }

  // ── Convenience: Install dev dependencies for the current project ────────

  /** Auto-detect package manager and install common dev dependencies. */
  static async installCommonDevDeps(projectPath?: string): Promise<PackageOperationResult[]> {
    const scan = await ToolOrchestrator.scanTools();
    const results: PackageOperationResult[] = [];

    // Prefer npm if available
    const npmTool = scan.tools.find((t) => t.name === "npm" && t.installed);
    if (npmTool) {
      const result = await ToolOrchestrator.installPackage(
        "npm",
        ["typescript", "@types/node", "eslint", "prettier"],
        projectPath,
      );
      results.push(result);
    }

    return results;
  }
}