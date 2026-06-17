/**
 * LSP Manager — Language Server Protocol management for multiple languages.
 * Spawns real language servers via Tauri's Rust backend, manages lifecycle,
 * and provides the shared LspService instance for Monaco integration.
 *
 * The Rust backend (lsp_manager.rs) handles:
 * - Spawning language server processes
 * - JSON-RPC communication over stdio
 * - Auto-restart on crash (max 3 attempts)
 * - Emitting events: lsp-response, lsp-diagnostics, lsp-status
 *
 * This frontend manager:
 * - Calls invoke("lsp_start", { workspaceRoot, languageId }) to start servers
 * - Uses the shared lspService singleton for all communication
 * - Tracks which servers are running
 * - Provides document sync helpers
 */

import { lspService } from "./lspClient";
import type { LspStatus } from "./lspClient";
import { filePathToUri } from "./monacoLspBridge";

export interface LSPServerConfig {
  languageId: string;
  serverCommand: string;
  fileExtensions: string[];
  autoStart: boolean;
}

export type LSPServerStatus = "stopped" | "starting" | "running" | "error";

export interface LSPServerState {
  config: LSPServerConfig;
  status: LSPServerStatus;
  error?: string;
}

/**
 * Supported language servers.
 * The Rust backend has its own config map — these just track what we support
 * on the frontend and which file extensions map to which language.
 */
const DEFAULT_LSP_CONFIGS: LSPServerConfig[] = [
  { languageId: "typescript", serverCommand: "typescript-language-server", fileExtensions: [".ts", ".tsx", ".js", ".jsx"], autoStart: true },
  { languageId: "rust", serverCommand: "rust-analyzer", fileExtensions: [".rs"], autoStart: false },
  { languageId: "python", serverCommand: "pyright-langserver", fileExtensions: [".py"], autoStart: false },
  { languageId: "json", serverCommand: "vscode-json-language-server", fileExtensions: [".json", ".jsonc"], autoStart: false },
];

export class LSPManager {
  private servers: Map<string, LSPServerState> = new Map();
  private projectPath = "";
  private connected = false;
  private connectPromise: Promise<void> | null = null;
  private connectionGeneration = 0;
  private statusUnlisten: (() => void) | null = null;

  setProjectPath(path: string): void {
    this.projectPath = path;
  }

  getProjectPath(): string {
    return this.projectPath;
  }

  getDefaultConfigs(): LSPServerConfig[] {
    return DEFAULT_LSP_CONFIGS;
  }

  /**
   * Connect the shared LspService to Tauri events.
   * Call once when the app starts or when a project is opened.
   */
  async connect(): Promise<void> {
    if (this.connected) return;
    if (this.connectPromise) return this.connectPromise;

    const generation = ++this.connectionGeneration;
    this.connectPromise = this.connectOnce(generation);
    try {
      await this.connectPromise;
    } finally {
      this.connectPromise = null;
    }
  }

  private async connectOnce(generation: number): Promise<void> {
    await lspService.connect();
    if (generation !== this.connectionGeneration) return;
    // Listen for status changes from the Rust backend
    this.statusUnlisten = lspService.onStatus((languageId: string, status: LspStatus, error?: string) => {
      const existing = this.servers.get(languageId);
      if (!existing) return;

      if (status === "ready") {
        this.servers.set(languageId, { ...existing, status: "running", error: undefined });
        console.log(`[LSP] ${languageId} server ready`);
      } else if (status === "crashed") {
        this.servers.set(languageId, { ...existing, status: "error", error: error || "Server crashed" });
        console.warn(`[LSP] ${languageId} crashed: ${error}`);
      } else if (status === "restarting") {
        this.servers.set(languageId, { ...existing, status: "starting", error });
      }
    });

    this.connected = true;
  }

  /**
   * Disconnect from events and stop all servers.
   */
  disconnect(): void {
    this.connectionGeneration += 1;
    if (this.statusUnlisten) {
      this.statusUnlisten();
      this.statusUnlisten = null;
    }
    lspService.disconnect();
    this.servers.clear();
    this.connected = false;
  }

  /**
   * Start an LSP server for a given language via the Rust backend.
   * The Rust side picks the correct binary based on languageId.
   */
  async startServer(languageId: string): Promise<boolean> {
    const config = DEFAULT_LSP_CONFIGS.find((c) => c.languageId === languageId);
    if (!config) {
      console.warn(`[LSP] No config for language: ${languageId}`);
      return false;
    }

    if (!this.projectPath) {
      console.warn("[LSP] No project path set, cannot start server");
      return false;
    }

    // Don't restart if already running
    const existing = this.servers.get(languageId);
    if (existing?.status === "running") {
      return true;
    }

    this.servers.set(languageId, { config, status: "starting" });

    try {
      // This matches the Rust command signature:
      // pub fn lsp_start(workspace_root: String, language_id: String, ...)
      await lspService.start(this.projectPath, languageId);
      // Status will be updated via the lsp-status event listener
      console.log(`[LSP] Starting ${languageId} (${config.serverCommand})...`);
      return true;
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      this.servers.set(languageId, { config, status: "error", error: errorMsg });
      console.warn(`[LSP] Failed to start ${languageId}: ${errorMsg}`);
      return false;
    }
  }

  /**
   * Stop an LSP server.
   */
  async stopServer(languageId: string): Promise<void> {
    const server = this.servers.get(languageId);
    if (!server) return;

    try {
      await lspService.shutdown(languageId);
    } catch {
      // Server may already be dead
    }

    this.servers.set(languageId, { ...server, status: "stopped", error: undefined });
    console.log(`[LSP] ${languageId} server stopped`);
  }

  /**
   * Stop all running servers.
   */
  async stopAll(): Promise<void> {
    for (const [langId, server] of this.servers) {
      if (server.status === "running" || server.status === "starting") {
        await this.stopServer(langId);
      }
    }
  }

  /**
   * Auto-start servers based on file extensions present in the project.
   */
  async autoStartForLanguage(languageId: string): Promise<void> {
    const config = DEFAULT_LSP_CONFIGS.find((c) => c.languageId === languageId);
    if (!config) return;
    if (this.servers.get(languageId)?.status === "running") return;
    await this.startServer(languageId);
  }

  getServerState(languageId: string): LSPServerState | undefined {
    return this.servers.get(languageId);
  }

  getAllServers(): LSPServerState[] {
    return Array.from(this.servers.values());
  }

  isServerRunning(languageId: string): boolean {
    return this.servers.get(languageId)?.status === "running";
  }

  getRunningLanguages(): string[] {
    const running: string[] = [];
    for (const [lang, server] of this.servers) {
      if (server.status === "running") running.push(lang);
    }
    return running;
  }

  /**
   * Get the LSP language ID for a given file path based on extension.
   */
  getLanguageForFile(filePath: string): string | undefined {
    const ext = "." + (filePath.split(".").pop()?.toLowerCase() || "");
    for (const config of DEFAULT_LSP_CONFIGS) {
      if (config.fileExtensions.includes(ext)) return config.languageId;
    }
    return undefined;
  }

  /**
   * Check if a file is supported by any configured LSP server.
   */
  isFileSupported(filePath: string): boolean {
    return this.getLanguageForFile(filePath) !== undefined;
  }

  // --- Document Sync Helpers ---
  // These use the shared lspService singleton directly.

  /**
   * Notify the LSP server that a document was opened.
   */
  notifyDocumentOpen(filePath: string, languageId: string, content: string): void {
    if (!this.isServerRunning(languageId)) return;
    const uri = filePathToUri(filePath);
    lspService.didOpen(uri, languageId, content);
  }

  /**
   * Notify the LSP server that a document changed (debounced internally).
   */
  notifyDocumentChange(filePath: string, languageId: string, content: string): void {
    if (!this.isServerRunning(languageId)) return;
    const uri = filePathToUri(filePath);
    lspService.didChange(uri, languageId, content);
  }

  /**
   * Notify the LSP server that a document was saved.
   */
  notifyDocumentSave(filePath: string, languageId: string): void {
    if (!this.isServerRunning(languageId)) return;
    const uri = filePathToUri(filePath);
    lspService.didSave(uri, languageId);
  }

  /**
   * Notify the LSP server that a document was closed.
   */
  notifyDocumentClose(filePath: string, languageId: string): void {
    if (!this.isServerRunning(languageId)) return;
    const uri = filePathToUri(filePath);
    lspService.didClose(uri, languageId);
  }
}

/** Singleton LSP manager instance. */
export const lspManager = new LSPManager();
