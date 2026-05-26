/**
 * Debug Launch Configuration System
 * Manages .punam/launch.json for per-project debug configurations.
 * Supports Node.js (via js-debug / node inspect), Python (via debugpy), and custom adapters.
 */

import { readFile, writeFile, pathExists } from "./tauri";

// ─── Types ──────────────────────────────────────────────────────────────────────

export interface DebugLaunchConfig {
  /** Unique identifier for this configuration */
  id: string;
  /** Display name shown in the picker */
  name: string;
  /** Adapter type: "node", "python", "lldb", "go", "custom" */
  type: string;
  /** "launch" to start a new process, "attach" to connect to existing */
  request: "launch" | "attach";
  /** Transport mode: "stdio" (default) or "tcp" */
  transport?: "stdio" | "tcp";
  /** Path to the debug adapter executable */
  adapterCommand: string;
  /** Arguments passed to the adapter executable to start it in DAP mode */
  adapterArgs?: string[];
  /** Program to debug (relative to workspace or absolute) */
  program?: string;
  /** Arguments passed to the program being debugged */
  args?: string[];
  /** Working directory for the debugged program */
  cwd?: string;
  /** Environment variables for the debugged program */
  env?: Record<string, string>;
  /** Port for TCP transport or attach mode */
  port?: number;
  /** Host for TCP transport or attach mode */
  host?: string;
  /** Whether to stop on entry */
  stopOnEntry?: boolean;
  /** Console type: "integratedTerminal", "internalConsole", "externalTerminal" */
  console?: string;
  /** Additional adapter-specific launch arguments (passed directly to DAP launch/attach) */
  launchArgs?: Record<string, any>;
}

export interface LaunchJsonFile {
  version: "1.0";
  configurations: DebugLaunchConfig[];
}

// ─── Adapter Knowledge Base ─────────────────────────────────────────────────────
// These define how to properly launch each adapter type in DAP mode.

export interface AdapterInfo {
  type: string;
  displayName: string;
  /** Command to start the adapter in DAP mode */
  adapterCommand: string;
  adapterArgs: string[];
  /** How to detect if this adapter is available */
  detectCommand?: string;
  /** File patterns that suggest this adapter type */
  projectIndicators: string[];
}

export const KNOWN_ADAPTERS: AdapterInfo[] = [
  {
    type: "python",
    displayName: "Python (debugpy)",
    adapterCommand: "python",
    adapterArgs: ["-m", "debugpy.adapter"],
    detectCommand: "python -m debugpy --version",
    projectIndicators: ["pyproject.toml", "setup.py", "requirements.txt", "Pipfile", "*.py"],
  },
  {
    type: "node",
    displayName: "Node.js (js-debug)",
    adapterCommand: "js-debug-adapter",
    adapterArgs: [],
    detectCommand: "js-debug-adapter --version",
    projectIndicators: ["package.json", "tsconfig.json", "*.js", "*.ts"],
  },
  {
    type: "node-inspect",
    displayName: "Node.js (built-in inspect)",
    // Node's built-in inspector protocol — we use a DAP wrapper approach
    // The adapter spawns node with --inspect and bridges to DAP
    adapterCommand: "node",
    adapterArgs: [],
    projectIndicators: ["package.json"],
  },
  {
    type: "lldb",
    displayName: "LLDB (CodeLLDB)",
    adapterCommand: "codelldb",
    adapterArgs: ["--port", "0"],
    detectCommand: "codelldb --version",
    projectIndicators: ["Cargo.toml", "CMakeLists.txt", "Makefile", "*.c", "*.cpp", "*.rs"],
  },
  {
    type: "go",
    displayName: "Go (Delve)",
    adapterCommand: "dlv",
    adapterArgs: ["dap"],
    detectCommand: "dlv version",
    projectIndicators: ["go.mod", "go.sum", "*.go"],
  },
];

// ─── Default Configurations ─────────────────────────────────────────────────────

/**
 * Python debugpy config — uses TCP transport.
 * debugpy.adapter listens on a port; we connect to it via TCP for DAP communication.
 */
export function getDefaultPythonConfig(): DebugLaunchConfig {
  return {
    id: "python-launch",
    name: "Python: Launch File",
    type: "python",
    request: "launch",
    transport: "tcp",
    adapterCommand: "python",
    adapterArgs: ["-m", "debugpy.adapter", "--host", "127.0.0.1", "--port", "5678"],
    host: "127.0.0.1",
    port: 5678,
    program: "${workspaceFolder}/main.py",
    cwd: "${workspaceFolder}",
    console: "integratedTerminal",
    stopOnEntry: false,
    launchArgs: {
      justMyCode: true,
    },
  };
}

export function getPythonAttachConfig(): DebugLaunchConfig {
  return {
    id: "python-attach",
    name: "Python: Attach (port 5678)",
    type: "python",
    request: "attach",
    transport: "tcp",
    adapterCommand: "python",
    adapterArgs: ["-m", "debugpy.adapter", "--host", "127.0.0.1", "--port", "5679"],
    host: "127.0.0.1",
    port: 5679,
    cwd: "${workspaceFolder}",
    launchArgs: {
      justMyCode: true,
      connect: { host: "127.0.0.1", port: 5678 },
    },
  };
}

/**
 * Node.js config using js-debug-adapter (VS Code's debug adapter).
 * If js-debug-adapter is installed globally, this works out of the box.
 * The adapter handles spawning node with the right flags.
 */
export function getDefaultNodeConfig(): DebugLaunchConfig {
  return {
    id: "node-launch",
    name: "Node.js: Launch Program",
    type: "node",
    request: "launch",
    adapterCommand: "js-debug-adapter",
    adapterArgs: [],
    program: "${workspaceFolder}/index.js",
    cwd: "${workspaceFolder}",
    console: "integratedTerminal",
    stopOnEntry: false,
    launchArgs: {
      skipFiles: ["<node_internals>/**"],
    },
  };
}

export function getNodeAttachConfig(): DebugLaunchConfig {
  return {
    id: "node-attach",
    name: "Node.js: Attach (port 9229)",
    type: "node",
    request: "attach",
    adapterCommand: "js-debug-adapter",
    adapterArgs: [],
    host: "127.0.0.1",
    port: 9229,
    cwd: "${workspaceFolder}",
    launchArgs: {
      skipFiles: ["<node_internals>/**"],
    },
  };
}

/**
 * Fallback Node config that uses node's built-in inspect protocol.
 * This doesn't require js-debug-adapter but has limited DAP support.
 * We spawn node directly and the Rust backend handles the communication.
 */
export function getNodeInspectConfig(): DebugLaunchConfig {
  return {
    id: "node-inspect-launch",
    name: "Node.js: Launch (built-in inspect)",
    type: "node-inspect",
    request: "launch",
    adapterCommand: "node",
    adapterArgs: ["--inspect-brk=0"],
    program: "${workspaceFolder}/index.js",
    cwd: "${workspaceFolder}",
    stopOnEntry: true,
  };
}

export function getDefaultGoConfig(): DebugLaunchConfig {
  return {
    id: "go-launch",
    name: "Go: Launch Package",
    type: "go",
    request: "launch",
    adapterCommand: "dlv",
    adapterArgs: ["dap"],
    program: "${workspaceFolder}",
    cwd: "${workspaceFolder}",
    stopOnEntry: false,
    launchArgs: {
      mode: "debug",
    },
  };
}

export function getDefaultRustConfig(): DebugLaunchConfig {
  return {
    id: "rust-launch",
    name: "Rust: Launch (CodeLLDB)",
    type: "lldb",
    request: "launch",
    adapterCommand: "codelldb",
    adapterArgs: ["--port", "0"],
    program: "${workspaceFolder}/target/debug/${workspaceFolderBasename}",
    cwd: "${workspaceFolder}",
    stopOnEntry: false,
  };
}

export function getDefaultConfig(): DebugLaunchConfig {
  return {
    id: `config-${Date.now()}`,
    name: "New Configuration",
    type: "python",
    request: "launch",
    adapterCommand: "python",
    adapterArgs: ["-m", "debugpy.adapter"],
    program: "${workspaceFolder}/main.py",
    cwd: "${workspaceFolder}",
    stopOnEntry: false,
  };
}

// ─── Smart Detection ────────────────────────────────────────────────────────────

export interface DetectedProject {
  type: string;
  confidence: "high" | "medium" | "low";
  suggestedConfigs: DebugLaunchConfig[];
  reason: string;
}

/**
 * Detects the project type from root file names and suggests debug configurations.
 */
export function detectProjectType(rootFileNames: string[]): DetectedProject[] {
  const detected: DetectedProject[] = [];
  const names = new Set(rootFileNames.map(n => n.toLowerCase()));

  // Python detection
  if (names.has("pyproject.toml") || names.has("setup.py") || names.has("requirements.txt") || names.has("pipfile")) {
    detected.push({
      type: "python",
      confidence: "high",
      suggestedConfigs: [getDefaultPythonConfig(), getPythonAttachConfig()],
      reason: "Python project files detected",
    });
  } else if (rootFileNames.some(n => n.endsWith(".py"))) {
    detected.push({
      type: "python",
      confidence: "medium",
      suggestedConfigs: [getDefaultPythonConfig()],
      reason: "Python files found in project root",
    });
  }

  // Node.js detection
  if (names.has("package.json")) {
    detected.push({
      type: "node",
      confidence: "high",
      suggestedConfigs: [getDefaultNodeConfig(), getNodeAttachConfig()],
      reason: "package.json found — Node.js project",
    });
  } else if (names.has("tsconfig.json")) {
    detected.push({
      type: "node",
      confidence: "medium",
      suggestedConfigs: [getDefaultNodeConfig()],
      reason: "tsconfig.json found — TypeScript/Node project",
    });
  }

  // Go detection
  if (names.has("go.mod")) {
    detected.push({
      type: "go",
      confidence: "high",
      suggestedConfigs: [getDefaultGoConfig()],
      reason: "go.mod found — Go project",
    });
  }

  // Rust detection
  if (names.has("cargo.toml")) {
    detected.push({
      type: "lldb",
      confidence: "high",
      suggestedConfigs: [getDefaultRustConfig()],
      reason: "Cargo.toml found — Rust project",
    });
  }

  return detected;
}

// ─── Variable Substitution ──────────────────────────────────────────────────────

export function resolveConfigVariables(config: DebugLaunchConfig, projectPath: string): DebugLaunchConfig {
  const folderName = projectPath.replace(/\\/g, "/").split("/").pop() || "project";

  const resolve = (value: string | undefined): string | undefined => {
    if (!value) return value;
    return value
      .replace(/\$\{workspaceFolder\}/g, projectPath)
      .replace(/\$\{workspaceFolderBasename\}/g, folderName)
      .replace(/\$\{cwd\}/g, projectPath);
  };

  return {
    ...config,
    program: resolve(config.program),
    cwd: resolve(config.cwd) || projectPath,
    adapterArgs: config.adapterArgs?.map(a => resolve(a) || a),
    args: config.args?.map(a => resolve(a) || a),
  };
}

// ─── File I/O ───────────────────────────────────────────────────────────────────

function getLaunchJsonPath(projectPath: string): string {
  const sep = projectPath.includes("\\") ? "\\" : "/";
  return `${projectPath}${sep}.punam${sep}launch.json`;
}

function getPunamDirPath(projectPath: string): string {
  const sep = projectPath.includes("\\") ? "\\" : "/";
  return `${projectPath}${sep}.punam`;
}

export async function loadLaunchConfigs(projectPath: string): Promise<DebugLaunchConfig[]> {
  const filePath = getLaunchJsonPath(projectPath);
  try {
    const exists = await pathExists(filePath);
    if (!exists) return [];

    const content = await readFile(filePath);
    const parsed: LaunchJsonFile = JSON.parse(content);
    if (parsed.version === "1.0" && Array.isArray(parsed.configurations)) {
      return parsed.configurations;
    }
    return [];
  } catch (err) {
    console.error("Failed to load launch.json:", err);
    return [];
  }
}

export async function saveLaunchConfigs(projectPath: string, configs: DebugLaunchConfig[]): Promise<void> {
  const filePath = getLaunchJsonPath(projectPath);
  const dirPath = getPunamDirPath(projectPath);

  // Ensure .punam directory exists
  const dirExists = await pathExists(dirPath);
  if (!dirExists) {
    const { createDirectory } = await import("./tauri");
    await createDirectory(dirPath);
  }

  const launchJson: LaunchJsonFile = {
    version: "1.0",
    configurations: configs,
  };

  await writeFile(filePath, JSON.stringify(launchJson, null, 2));
}

export async function createDefaultLaunchJson(projectPath: string, type: "node" | "python" | "generic" = "node"): Promise<DebugLaunchConfig[]> {
  let configs: DebugLaunchConfig[];

  switch (type) {
    case "node":
      configs = [getDefaultNodeConfig(), getNodeAttachConfig()];
      break;
    case "python":
      configs = [getDefaultPythonConfig(), getPythonAttachConfig()];
      break;
    default:
      configs = [getDefaultConfig()];
  }

  await saveLaunchConfigs(projectPath, configs);
  return configs;
}

/**
 * Auto-generate launch.json based on detected project type.
 * Returns the configs that were created, or empty if detection failed.
 */
export async function autoGenerateLaunchJson(projectPath: string, rootFileNames: string[]): Promise<DebugLaunchConfig[]> {
  const detected = detectProjectType(rootFileNames);
  if (detected.length === 0) return [];

  // Use the highest-confidence detection
  const best = detected.sort((a, b) => {
    const order = { high: 0, medium: 1, low: 2 };
    return order[a.confidence] - order[b.confidence];
  })[0];

  // Merge all suggested configs from all detections (deduplicate by id)
  const allConfigs: DebugLaunchConfig[] = [];
  const seenIds = new Set<string>();
  for (const d of detected) {
    for (const config of d.suggestedConfigs) {
      if (!seenIds.has(config.id)) {
        seenIds.add(config.id);
        allConfigs.push(config);
      }
    }
  }

  await saveLaunchConfigs(projectPath, allConfigs);
  return allConfigs;
}
