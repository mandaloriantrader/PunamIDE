/**
 * LSP Client — Frontend service for communicating with language servers.
 * Uses dedicated Tauri commands (lsp_completion, lsp_hover, etc.)
 * and listens for diagnostics/response events.
 * Includes debounced didChange support and auto-install capabilities.
 */

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

// --- Types ---

export interface LspCompletionItem {
  label: string;
  kind: number;
  detail?: string;
  documentation?: string;
  insertText?: string;
  insertTextFormat?: number;
  sortText?: string;
}

export interface LspHoverResult {
  contents: string;
  range?: { startLine: number; startCol: number; endLine: number; endCol: number };
}

export interface LspDiagnostic {
  range: { startLine: number; startCol: number; endLine: number; endCol: number };
  severity: 1 | 2 | 3 | 4;
  message: string;
  source?: string;
  code?: string | number;
}

export interface LspLocation {
  uri: string;
  range: { startLine: number; startCol: number; endLine: number; endCol: number };
}

export type LspStatus = "starting" | "ready" | "crashed" | "restarting" | "stopped";

export interface LspInstalledStatus {
  language_id: string;
  installed: boolean;
  path: string | null;
  install_command: string | null;
  error: string | null;
}

// --- Event Payloads ---

interface LspResponsePayload {
  language_id: string;
  id: number | null;
  result: string | null;
  error: string | null;
}

interface LspDiagnosticsPayload {
  language_id: string;
  uri: string;
  diagnostics: string; // JSON array
}

interface LspStatusPayload {
  language_id: string;
  status: string;
  error: string | null;
}

// --- Client ---

type ResponseCallback = (result: any, error: string | null) => void;
type DiagnosticListener = (uri: string, diagnostics: LspDiagnostic[]) => void;
type StatusListener = (languageId: string, status: LspStatus, error?: string) => void;

export class LspService {
  private pendingRequests = new Map<number, ResponseCallback>();
  private diagnosticListeners: DiagnosticListener[] = [];
  private statusListeners: StatusListener[] = [];
  private unlisteners: (() => void)[] = [];
  private connectPromise: Promise<void> | null = null;
  private connectionGeneration = 0;
  private documentVersions = new Map<string, number>();
  private debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private connected = false;
  private defaultLanguageId: string;
  /** Cache install checks per session to avoid repeated `where`/`which` calls. */
  private installCache = new Map<string, LspInstalledStatus>();

  constructor(defaultLanguageId = "typescript") {
    this.defaultLanguageId = normalizeLanguageId(defaultLanguageId);
  }

  /** Connect to Tauri LSP events. Call once on app startup. */
  async connect(): Promise<void> {
    if (this.connected) return;
    if (this.connectPromise) return this.connectPromise;

    const generation = ++this.connectionGeneration;
    this.connectPromise = this.registerEventListeners(generation);
    try {
      await this.connectPromise;
      if (generation === this.connectionGeneration) this.connected = true;
    } finally {
      this.connectPromise = null;
    }
  }

  private async registerEventListeners(generation: number): Promise<void> {
    const registered: Array<() => void> = [];
    try {
      const unlistenResp = await listen<LspResponsePayload>("lsp-response", (event) => {
      const { id, result, error } = event.payload;
      if (id !== null && this.pendingRequests.has(id)) {
        const callback = this.pendingRequests.get(id)!;
        this.pendingRequests.delete(id);
        const parsed = result ? JSON.parse(result) : null;
        callback(parsed, error || null);
      }
      });
      registered.push(unlistenResp);

      const unlistenDiag = await listen<LspDiagnosticsPayload>("lsp-diagnostics", (event) => {
      const { uri, diagnostics: diagJson } = event.payload;
      try {
        const rawDiags = JSON.parse(diagJson);
        const diagnostics: LspDiagnostic[] = rawDiags.map((d: any) => ({
          range: {
            startLine: d.range?.start?.line ?? 0,
            startCol: d.range?.start?.character ?? 0,
            endLine: d.range?.end?.line ?? 0,
            endCol: d.range?.end?.character ?? 0,
          },
          severity: d.severity ?? 1,
          message: d.message ?? "",
          source: d.source,
          code: d.code,
        }));
        for (const listener of this.diagnosticListeners) {
          listener(uri, diagnostics);
        }
      } catch { /* ignore parse errors */ }
      });
      registered.push(unlistenDiag);

      const unlistenStatus = await listen<LspStatusPayload>("lsp-status", (event) => {
      const { language_id, status, error } = event.payload;
      for (const listener of this.statusListeners) {
        listener(language_id, status as LspStatus, error || undefined);
      }
      });
      registered.push(unlistenStatus);
      if (generation !== this.connectionGeneration) {
        for (const unlisten of registered) unlisten();
        return;
      }
      this.unlisteners = registered;
    } catch (error) {
      for (const unlisten of registered) unlisten();
      throw error;
    }
  }

  /** Disconnect from all events. */
  disconnect(): void {
    this.connectionGeneration += 1;
    for (const unlisten of this.unlisteners) {
      unlisten();
    }
    this.unlisteners = [];
    this.pendingRequests.clear();
    this.connected = false;
  }

  // --- Listeners ---

  onDiagnostics(listener: DiagnosticListener): () => void {
    this.diagnosticListeners.push(listener);
    return () => { this.diagnosticListeners = this.diagnosticListeners.filter((l) => l !== listener); };
  }

  onStatus(listener: StatusListener): () => void {
    this.statusListeners.push(listener);
    return () => { this.statusListeners = this.statusListeners.filter((l) => l !== listener); };
  }

  // --- Install Check (cached per session) ---

  /** Check if a language server binary is installed on the system. Results are cached per session. */
  async checkInstalled(languageId: string): Promise<LspInstalledStatus> {
    const cached = this.installCache.get(languageId);
    if (cached) return cached;

    const status = await invoke<LspInstalledStatus>("lsp_check_installed", { languageId });
    this.installCache.set(languageId, status);
    return status;
  }

  /** One-click install for a language server. Runs the recommended install command. */
  async installServer(languageId: string, workspaceRoot: string): Promise<{ stdout: string; stderr: string; exit_code: number }> {
    const status = await this.checkInstalled(languageId);
    if (!status.install_command) {
      return { stdout: "", stderr: "No install command available", exit_code: 1 };
    }
    const result = await invoke<{ stdout: string; stderr: string; exit_code: number }>("run_terminal_command", {
      command: status.install_command,
      cwd: workspaceRoot,
    });
    // Invalidate cache after install so re-check picks up the new binary
    this.installCache.delete(languageId);
    return result;
  }

  // --- Server Lifecycle ---

  async start(workspaceRoot: string, languageId: string): Promise<void> {
    await invoke("lsp_start", { workspaceRoot, languageId });
  }

  async shutdown(languageId: string): Promise<void> {
    await invoke("lsp_shutdown", { languageId });
  }

  // --- Document Sync ---

  didOpen(fileUri: string, languageId: string, text: string): void {
    this.documentVersions.set(fileUri, 1);
    invoke("lsp_did_open", { fileUri, languageId, text }).catch(() => {});
  }

  /** Debounced didChange — waits 300ms after last keystroke before sending. */
  didChange(fileUri: string, text: string): void;
  didChange(fileUri: string, languageId: string, text: string): void;
  didChange(fileUri: string, languageIdOrText: string, maybeText?: string): void {
    const { languageId, text } = this.resolveDocumentArgs(languageIdOrText, maybeText);
    // Clear existing timer for this file
    const existing = this.debounceTimers.get(fileUri);
    if (existing) clearTimeout(existing);

    const timer = setTimeout(() => {
      const version = (this.documentVersions.get(fileUri) || 0) + 1;
      this.documentVersions.set(fileUri, version);
      invoke("lsp_did_change", { fileUri, languageId, version, text }).catch(() => {});
      this.debounceTimers.delete(fileUri);
    }, 300);

    this.debounceTimers.set(fileUri, timer);
  }

  didSave(fileUri: string, languageId = this.defaultLanguageId): void {
    invoke("lsp_did_save", { fileUri, languageId }).catch(() => {});
  }

  didClose(fileUri: string, languageId = this.defaultLanguageId): void {
    this.documentVersions.delete(fileUri);
    invoke("lsp_did_close", { fileUri, languageId }).catch(() => {});
  }

  // --- Requests (return promises that resolve when response arrives) ---

  async completion(fileUri: string, line: number, character: number): Promise<LspCompletionItem[]>;
  async completion(fileUri: string, languageId: string, line: number, character: number): Promise<LspCompletionItem[]>;
  async completion(fileUri: string, languageIdOrLine: string | number, lineOrCharacter: number, maybeCharacter?: number): Promise<LspCompletionItem[]> {
    const { languageId, line, character } = this.resolvePositionArgs(languageIdOrLine, lineOrCharacter, maybeCharacter);
    try {
      const requestId: number = await invoke("lsp_completion", { fileUri, languageId, line, character });
      const result = await this.waitForResponse(requestId);
      if (!result) return [];

      const items = Array.isArray(result) ? result : result.items || [];
      return items.map((item: any) => ({
        label: item.label || "",
        kind: item.kind || 1,
        detail: item.detail,
        documentation: typeof item.documentation === "string" ? item.documentation : item.documentation?.value,
        insertText: item.insertText || item.textEdit?.newText || item.label,
        insertTextFormat: item.insertTextFormat,
        sortText: item.sortText,
      }));
    } catch {
      return [];
    }
  }

  async hover(fileUri: string, line: number, character: number): Promise<LspHoverResult | null>;
  async hover(fileUri: string, languageId: string, line: number, character: number): Promise<LspHoverResult | null>;
  async hover(fileUri: string, languageIdOrLine: string | number, lineOrCharacter: number, maybeCharacter?: number): Promise<LspHoverResult | null> {
    const { languageId, line, character } = this.resolvePositionArgs(languageIdOrLine, lineOrCharacter, maybeCharacter);
    try {
      const requestId: number = await invoke("lsp_hover", { fileUri, languageId, line, character });
      const result = await this.waitForResponse(requestId);
      if (!result?.contents) return null;

      let contents = "";
      const c = result.contents;
      if (typeof c === "string") contents = c;
      else if (c.value) contents = c.value;
      else if (Array.isArray(c)) contents = c.map((item: any) => typeof item === "string" ? item : item.value || "").join("\n\n");

      const range = c.range ? {
        startLine: c.range.start?.line ?? 0,
        startCol: c.range.start?.character ?? 0,
        endLine: c.range.end?.line ?? 0,
        endCol: c.range.end?.character ?? 0,
      } : undefined;

      return { contents, range };
    } catch {
      return null;
    }
  }

  async definition(fileUri: string, line: number, character: number): Promise<LspLocation[]>;
  async definition(fileUri: string, languageId: string, line: number, character: number): Promise<LspLocation[]>;
  async definition(fileUri: string, languageIdOrLine: string | number, lineOrCharacter: number, maybeCharacter?: number): Promise<LspLocation[]> {
    const { languageId, line, character } = this.resolvePositionArgs(languageIdOrLine, lineOrCharacter, maybeCharacter);
    try {
      const requestId: number = await invoke("lsp_definition", { fileUri, languageId, line, character });
      const result = await this.waitForResponse(requestId);
      if (!result) return [];

      const results = Array.isArray(result) ? result : [result];
      return results.map((loc: any) => ({
        uri: loc.uri || loc.targetUri || "",
        range: {
          startLine: (loc.range || loc.targetRange)?.start?.line ?? 0,
          startCol: (loc.range || loc.targetRange)?.start?.character ?? 0,
          endLine: (loc.range || loc.targetRange)?.end?.line ?? 0,
          endCol: (loc.range || loc.targetRange)?.end?.character ?? 0,
        },
      }));
    } catch {
      return [];
    }
  }

  async format(fileUri: string, languageId: string): Promise<any[]> {
    try {
      const requestId: number = await invoke("lsp_format", { fileUri, languageId });
      const result = await this.waitForResponse(requestId);
      return result || [];
    } catch {
      return [];
    }
  }

  async references(fileUri: string, line: number, character: number): Promise<LspLocation[]>;
  async references(fileUri: string, languageId: string, line: number, character: number): Promise<LspLocation[]>;
  async references(fileUri: string, languageIdOrLine: string | number, lineOrCharacter: number, maybeCharacter?: number): Promise<LspLocation[]> {
    const { languageId, line, character } = this.resolvePositionArgs(languageIdOrLine, lineOrCharacter, maybeCharacter);
    try {
      const requestId: number = await invoke("lsp_references", { fileUri, languageId, line, character });
      const result = await this.waitForResponse(requestId);
      if (!result) return [];

      const results = Array.isArray(result) ? result : [result];
      return results.map((loc: any) => ({
        uri: loc.uri || loc.targetUri || "",
        range: {
          startLine: (loc.range || loc.targetRange)?.start?.line ?? 0,
          startCol: (loc.range || loc.targetRange)?.start?.character ?? 0,
          endLine: (loc.range || loc.targetRange)?.end?.line ?? 0,
          endCol: (loc.range || loc.targetRange)?.end?.character ?? 0,
        },
      }));
    } catch {
      return [];
    }
  }

  // --- Internal ---

  private waitForResponse(requestId: number): Promise<any> {
    return new Promise((resolve) => {
      this.pendingRequests.set(requestId, (result, error) => {
        if (error) {
          console.warn("[LSP] Request error:", error);
          resolve(null);
        } else {
          resolve(result);
        }
      });

      // Timeout after 5 seconds
      setTimeout(() => {
        if (this.pendingRequests.has(requestId)) {
          this.pendingRequests.delete(requestId);
          resolve(null);
        }
      }, 5000);
    });
  }

  private resolvePositionArgs(languageIdOrLine: string | number, lineOrCharacter: number, maybeCharacter?: number) {
    if (typeof languageIdOrLine === "string") {
      return {
        languageId: normalizeLanguageId(languageIdOrLine),
        line: lineOrCharacter,
        character: maybeCharacter ?? 0,
      };
    }
    return {
      languageId: this.defaultLanguageId,
      line: languageIdOrLine,
      character: lineOrCharacter,
    };
  }

  private resolveDocumentArgs(languageIdOrText: string, maybeText?: string) {
    if (maybeText === undefined) {
      return { languageId: this.defaultLanguageId, text: languageIdOrText };
    }
    return { languageId: normalizeLanguageId(languageIdOrText), text: maybeText };
  }
}

/** Singleton LSP service instance. */
export const lspService = new LspService();
export { LspService as LspClient };

function normalizeLanguageId(value: string): string {
  const lower = value.toLowerCase();
  if (lower.includes("typescript")) return "typescript";
  if (lower.includes("javascript")) return "javascript";
  if (lower.includes("python")) return "python";
  if (lower.includes("rust")) return "rust";
  if (lower.includes("json")) return "json";
  if (lower.includes("html")) return "html";
  if (lower.includes("css")) return "css";
  if (lower.includes("go")) return "go";
  return value || "typescript";
}
