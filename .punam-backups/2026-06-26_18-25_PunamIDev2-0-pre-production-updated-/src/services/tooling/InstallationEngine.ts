/**
 * InstallationEngine.ts — Phase 4
 *
 * Platform-abstracted automatic tool installation.
 * Dispatches to the appropriate package manager based on OS:
 *   - Windows: winget, choco
 *   - macOS: brew
 *   - Linux: apt, snap
 *
 * Delegates shell execution to Rust terminal_commands.rs via Tauri invoke.
 */

import { invoke } from "@tauri-apps/api/core";

// ── Types ──────────────────────────────────────────────────────────────────────

export type Platform = "windows" | "macos" | "linux" | "unknown";

export interface InstallResult {
  success: boolean;
  toolName: string;
  output: string;
  command: string;
  durationMs: number;
}

export interface InstallOption {
  manager: string;
  command: string;
  available: boolean;
}

export interface ToolInstallInfo {
  name: string;
  displayName: string;
  installOptions: InstallOption[];
  manualUrl: string;
}

// ── Tool Registry ──────────────────────────────────────────────────────────────

const TOOL_REGISTRY: Record<string, {
  displayName: string;
  windows: { winget?: string; choco?: string };
  macos: { brew?: string };
  linux: { apt?: string; snap?: string };
  manualUrl: string;
}> = {
  node: {
    displayName: "Node.js",
    windows: { winget: "OpenJS.NodeJS.LTS", choco: "nodejs-lts" },
    macos: { brew: "node" },
    linux: { apt: "nodejs", snap: "node" },
    manualUrl: "https://nodejs.org",
  },
  python: {
    displayName: "Python",
    windows: { winget: "Python.Python.3.12", choco: "python3" },
    macos: { brew: "python@3" },
    linux: { apt: "python3" },
    manualUrl: "https://python.org",
  },
  rustc: {
    displayName: "Rust",
    windows: { winget: "Rustlang.Rustup" },
    macos: { brew: "rustup" },
    linux: { apt: "rustc" },
    manualUrl: "https://rustup.rs",
  },
  go: {
    displayName: "Go",
    windows: { winget: "GoLang.Go" },
    macos: { brew: "go" },
    linux: { apt: "golang", snap: "go" },
    manualUrl: "https://go.dev/dl",
  },
  docker: {
    displayName: "Docker",
    windows: { winget: "Docker.DockerDesktop" },
    macos: { brew: "docker" },
    linux: { apt: "docker.io" },
    manualUrl: "https://docker.com",
  },
  git: {
    displayName: "Git",
    windows: { winget: "Git.Git", choco: "git" },
    macos: { brew: "git" },
    linux: { apt: "git" },
    manualUrl: "https://git-scm.com",
  },
  kubectl: {
    displayName: "kubectl",
    windows: { winget: "Kubernetes.kubectl", choco: "kubernetes-cli" },
    macos: { brew: "kubectl" },
    linux: { snap: "kubectl" },
    manualUrl: "https://kubernetes.io/docs/tasks/tools/",
  },
  aws: {
    displayName: "AWS CLI",
    windows: { winget: "Amazon.AWSCLI" },
    macos: { brew: "awscli" },
    linux: { apt: "awscli", snap: "aws-cli" },
    manualUrl: "https://aws.amazon.com/cli",
  },
  gcloud: {
    displayName: "Google Cloud SDK",
    windows: {},
    macos: { brew: "google-cloud-sdk" },
    linux: { apt: "google-cloud-cli", snap: "google-cloud-cli" },
    manualUrl: "https://cloud.google.com/sdk",
  },
};

// ── InstallationEngine Class ───────────────────────────────────────────────────

export class InstallationEngine {
  private platform: Platform = "unknown";
  private availableManagers: Set<string> = new Set();

  /**
   * Detect the current platform and available package managers.
   */
  async initialize(): Promise<void> {
    this.platform = await this.detectPlatform();
    this.availableManagers = await this.detectAvailableManagers();
  }

  /**
   * Get install options for a tool.
   */
  getInstallInfo(toolName: string): ToolInstallInfo | null {
    const entry = TOOL_REGISTRY[toolName];
    if (!entry) return null;

    const options: InstallOption[] = [];

    const platformConfig = this.platform === "windows" ? entry.windows
      : this.platform === "macos" ? entry.macos
      : entry.linux;

    for (const [manager, pkg] of Object.entries(platformConfig)) {
      if (pkg) {
        options.push({
          manager,
          command: this.buildInstallCommand(manager, pkg),
          available: this.availableManagers.has(manager),
        });
      }
    }

    return {
      name: toolName,
      displayName: entry.displayName,
      installOptions: options,
      manualUrl: entry.manualUrl,
    };
  }

  /**
   * Check if a tool can be installed automatically.
   */
  isToolInstallable(toolName: string): boolean {
    const info = this.getInstallInfo(toolName);
    if (!info) return false;
    return info.installOptions.some((o) => o.available);
  }

  /**
   * Get the recommended install command for a tool on the current platform.
   */
  getInstallCommand(toolName: string): string | null {
    const info = this.getInstallInfo(toolName);
    if (!info) return null;

    // Prefer available managers
    const available = info.installOptions.find((o) => o.available);
    if (available) return available.command;

    // Fall back to first option
    return info.installOptions[0]?.command || null;
  }

  /**
   * Install a tool using the best available package manager.
   */
  async installTool(toolName: string): Promise<InstallResult> {
    const startTime = Date.now();
    const command = this.getInstallCommand(toolName);

    if (!command) {
      return {
        success: false,
        toolName,
        output: `No install method available for "${toolName}" on ${this.platform}`,
        command: "",
        durationMs: Date.now() - startTime,
      };
    }

    try {
      const result = await invoke<{ success: boolean; output: string }>(
        "run_terminal_command",
        { command, cwd: "." }
      );

      return {
        success: result.success,
        toolName,
        output: result.output,
        command,
        durationMs: Date.now() - startTime,
      };
    } catch (err) {
      return {
        success: false,
        toolName,
        output: `Install failed: ${err instanceof Error ? err.message : String(err)}`,
        command,
        durationMs: Date.now() - startTime,
      };
    }
  }

  /**
   * Get all registered tools and their install status.
   */
  getAllTools(): ToolInstallInfo[] {
    return Object.keys(TOOL_REGISTRY)
      .map((name) => this.getInstallInfo(name))
      .filter((info): info is ToolInstallInfo => info !== null);
  }

  /**
   * Get the current platform.
   */
  getPlatform(): Platform {
    return this.platform;
  }

  // ── Private ──────────────────────────────────────────────────────────────

  private async detectPlatform(): Promise<Platform> {
    try {
      const os = await invoke<string>("get_os_type");
      if (os.includes("windows") || os.includes("Windows")) return "windows";
      if (os.includes("macos") || os.includes("darwin") || os.includes("Darwin")) return "macos";
      if (os.includes("linux") || os.includes("Linux")) return "linux";
    } catch {
      // Fallback: check navigator
      const ua = navigator?.userAgent?.toLowerCase() || "";
      if (ua.includes("win")) return "windows";
      if (ua.includes("mac")) return "macos";
      if (ua.includes("linux")) return "linux";
    }
    return "unknown";
  }

  private async detectAvailableManagers(): Promise<Set<string>> {
    const managers = new Set<string>();
    const checks: Array<{ name: string; command: string }> = [
      { name: "winget", command: "winget --version" },
      { name: "choco", command: "choco --version" },
      { name: "brew", command: "brew --version" },
      { name: "apt", command: "apt --version" },
      { name: "snap", command: "snap --version" },
    ];

    for (const { name, command } of checks) {
      try {
        const result = await invoke<{ success: boolean }>(
          "run_terminal_command",
          { command, cwd: "." }
        );
        if (result.success) managers.add(name);
      } catch {
        // Not available
      }
    }

    return managers;
  }

  private buildInstallCommand(manager: string, packageName: string): string {
    switch (manager) {
      case "winget": return `winget install --id ${packageName} --accept-source-agreements --accept-package-agreements`;
      case "choco": return `choco install ${packageName} -y`;
      case "brew": return `brew install ${packageName}`;
      case "apt": return `sudo apt install -y ${packageName}`;
      case "snap": return `sudo snap install ${packageName}`;
      default: return `${manager} install ${packageName}`;
    }
  }
}

// ── Singleton ──────────────────────────────────────────────────────────────────

let instance: InstallationEngine | null = null;

export async function getInstallationEngine(): Promise<InstallationEngine> {
  if (!instance) {
    instance = new InstallationEngine();
    await instance.initialize();
  }
  return instance;
}
