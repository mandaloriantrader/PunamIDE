import { invoke } from "@tauri-apps/api/core";
import { load } from "@tauri-apps/plugin-store";

export interface FileEntry {
  name: string;
  path: string;
  is_dir: boolean;
  children?: FileEntry[];
}

export interface AppConfig {
  provider: string;
  api_key: string;
  model: string;
  theme: string;
  adaptiveMode?: boolean;
  adaptiveStrategy?: import("../lib/ai/providerCapabilities").AdaptiveStrategy;
}

export interface LlmRequest {
  provider: string;
  api_key: string;
  model: string;
  system_prompt: string;
  user_prompt: string;
}

export interface LlmResponse {
  text: string;
  success: boolean;
  error?: string;
}

export interface CmdResult {
  stdout: string;
  stderr: string;
  exit_code: number;
}

export interface PortCheckResult {
  open: boolean;
  host: string;
  port: number;
  error?: string;
}

export interface SearchResult {
  path: string;
  line: number;
  column: number;
  preview: string;
}

export interface RunProfile {
  id: string;
  name: string;
  command: string;
}

// Project root (sandbox boundary)
export const setProjectRoot = async (path: string) => {
  await invoke<void>("set_project_root", { path });
  // Auto-trigger background indexing (fire-and-forget)
  setTimeout(() => {
    // Phase 1: Rust regex-based indexes (instant, ~ms)
    invoke<number>("symbol_rebuild").catch(() => {});
    invoke<number>("callgraph_build").catch(() => {});

    // Phase 2: TF-IDF codebase index → embedding pipeline
    invoke<void>("index_codebase").then(() => {
      // Embedding pipeline runs after codebase is indexed
      import("../services/intelligence/EmbeddingOrchestrator")
        .then(({ runEmbeddingPipeline }) => runEmbeddingPipeline())
        .catch(() => {}); // Non-fatal: embeddings are optional
    }).catch(() => {});

    // Phase 3: Tree-sitter enhancement pass (after regex index is built)
    // Refines TS/JS symbols with full AST accuracy; regex results remain for Python/Rust
    setTimeout(() => {
      import("../services/intelligence/TreeSitterSymbolExtractor")
        .then(({ enhanceSymbolIndexWithTreeSitter }) => enhanceSymbolIndexWithTreeSitter())
        .then((stats) => {
          if (stats.filesProcessed > 0) {
            console.log(`[Index] Tree-sitter enhanced ${stats.filesProcessed} files, ${stats.symbolsExtracted} symbols`);
          }
        })
        .catch(() => {}); // Non-fatal: regex index still works
    }, 2000); // Wait 2s for Rust indexes to finish
  }, 500);
};

// File System
export const readDirectory = (path: string) =>
  invoke<FileEntry[]>("read_directory", { path });

export const readFile = (path: string) =>
  invoke<string>("read_file", { path });

export const pathExists = (path: string) =>
  invoke<boolean>("path_exists", { path });

export const writeFile = (path: string, content: string) =>
  invoke<void>("write_file", { path, content });

export const createFile = (path: string) =>
  invoke<void>("create_file", { path });

export const createDirectory = (path: string) =>
  invoke<void>("create_directory", { path });

export const deletePath = (path: string) =>
  invoke<void>("delete_path", { path });

export const renamePath = (oldPath: string, newPath: string) =>
  invoke<void>("rename_path", { oldPath, newPath });

export const revealPath = (path: string) =>
  invoke<void>("reveal_path", { path });

export const searchProject = (query: string) =>
  invoke<SearchResult[]>("search_project", { query });

// Terminal
export const runTerminalCommand = (command: string, cwd: string, timeoutMs = 600_000) =>
  invoke<CmdResult>("run_terminal_command", { command, cwd, timeoutMs });

export const checkTcpPort = (host: string, port: number) =>
  invoke<PortCheckResult>("check_tcp_port", { host, port });

export const startTerminalProcess = (command: string, cwd: string, clientSessionId?: string) =>
  invoke<string>("start_terminal_process", { command, cwd, clientSessionId });

export const stopTerminalProcess = (sessionId: string) =>
  invoke<void>("stop_terminal_process", { sessionId });

// File Watcher
export const watchProject = (path: string) =>
  invoke<void>("watch_project", { path });

export const stopWatching = () =>
  invoke<void>("stop_watching");

// Command Safety Validator
export interface CommandValidation {
  risk_level: "safe" | "needs_approval" | "blocked";
  sanitized_command: string;
  feedback_message: string;
}

export const inspectCommand = (command: string, workspacePath: string) =>
  invoke<CommandValidation>("inspect_command", { command, workspacePath });

// Terminal History (persistent)
const TERMINAL_HISTORY_KEY = "terminal_history";
const MAX_HISTORY_SIZE = 200;

export async function loadTerminalHistory(): Promise<string[]> {
  try {
    const store = await load(STORE_NAME, { autoSave: true, defaults: {} });
    return ((await store.get(TERMINAL_HISTORY_KEY)) as string[]) || [];
  } catch {
    return [];
  }
}

export async function saveTerminalHistory(history: string[]): Promise<void> {
  const store = await load(STORE_NAME, { autoSave: true, defaults: {} });
  // Keep only the last MAX_HISTORY_SIZE entries
  const trimmed = history.slice(-MAX_HISTORY_SIZE);
  await store.set(TERMINAL_HISTORY_KEY, trimmed);
  await store.save();
}

// AI Provider Configs (multi-provider support)
const AI_PROVIDERS_KEY = "ai_providers";

export async function loadAIProviders(): Promise<import("./providers").AIProviderConfig[]> {
  try {
    const store = await load(STORE_NAME, { autoSave: true, defaults: {} });
    return ((await store.get(AI_PROVIDERS_KEY)) as import("./providers").AIProviderConfig[]) || [];
  } catch {
    return [];
  }
}

export async function saveAIProviders(providers: import("./providers").AIProviderConfig[]): Promise<void> {
  const store = await load(STORE_NAME, { autoSave: true, defaults: {} });
  await store.set(AI_PROVIDERS_KEY, providers);
  await store.save();
}

// Config — uses tauri-plugin-store (app data directory, not plaintext in project)
const STORE_NAME = "punamide-settings.json";
const RECENT_PROJECT_PATH_KEY = "recent_project_path";
const RUN_PROFILES_KEY = "run_profiles_by_project";

export async function loadConfigFromStore(): Promise<AppConfig> {
  try {
    const store = await load(STORE_NAME, { autoSave: true, defaults: {} });
    const provider = ((await store.get("provider")) as string) || "gemini";
    const api_key = ((await store.get("api_key")) as string) || "";
    const model = ((await store.get("model")) as string) || "gemini-2.0-flash";
    const theme = ((await store.get("theme")) as string) || "dark";
    const adaptiveMode = Boolean(await store.get("adaptiveMode"));
    const adaptiveStrategy = ((await store.get("adaptiveStrategy")) as AppConfig["adaptiveStrategy"]) || "coding_optimized";
    return { provider, api_key, model, theme, adaptiveMode, adaptiveStrategy };
  } catch {
    return {
      provider: "gemini",
      api_key: "",
      model: "gemini-2.0-flash",
      theme: "dark",
      adaptiveMode: false,
      adaptiveStrategy: "coding_optimized",
    };
  }
}

export async function saveConfigToStore(config: AppConfig): Promise<void> {
  const store = await load(STORE_NAME, { autoSave: true, defaults: {} });
  await store.set("provider", config.provider);
  await store.set("api_key", config.api_key);
  await store.set("model", config.model);
  await store.set("theme", config.theme);
  await store.set("adaptiveMode", Boolean(config.adaptiveMode));
  await store.set("adaptiveStrategy", config.adaptiveStrategy || "coding_optimized");
  await store.save();
}

export async function loadRecentProjectPath(): Promise<string> {
  try {
    const store = await load(STORE_NAME, { autoSave: true, defaults: {} });
    return ((await store.get(RECENT_PROJECT_PATH_KEY)) as string) || "";
  } catch {
    return "";
  }
}

export async function saveRecentProjectPath(path: string): Promise<void> {
  const store = await load(STORE_NAME, { autoSave: true, defaults: {} });
  await store.set(RECENT_PROJECT_PATH_KEY, path);
  await store.save();
}

export async function clearRecentProjectPath(): Promise<void> {
  const store = await load(STORE_NAME, { autoSave: true, defaults: {} });
  await store.delete(RECENT_PROJECT_PATH_KEY);
  await store.save();
}

function getProjectStoreKey(projectPath: string) {
  return projectPath.replace(/\\/g, "/");
}

export async function loadRunProfiles(projectPath: string): Promise<RunProfile[] | null> {
  try {
    const store = await load(STORE_NAME, { autoSave: true, defaults: {} });
    const profilesByProject = ((await store.get(RUN_PROFILES_KEY)) as Record<string, RunProfile[]>) || {};
    return profilesByProject[getProjectStoreKey(projectPath)] || null;
  } catch {
    return null;
  }
}

export async function saveRunProfiles(projectPath: string, profiles: RunProfile[]): Promise<void> {
  const store = await load(STORE_NAME, { autoSave: true, defaults: {} });
  const profilesByProject = ((await store.get(RUN_PROFILES_KEY)) as Record<string, RunProfile[]>) || {};
  profilesByProject[getProjectStoreKey(projectPath)] = profiles;
  await store.set(RUN_PROFILES_KEY, profilesByProject);
  await store.save();
}

// Chat History (per-project, multi-session persistence)
const CHAT_HISTORY_KEY = "chat_history_by_project";
const CHAT_SESSIONS_KEY = "chat_sessions_by_project";
const MAX_CHAT_HISTORY = 30; // Keep last 30 messages per session

export interface PersistedChatMessage {
  role: "user" | "assistant";
  content: string;
  mode?: string;
  timestamp?: number;
  attachments?: ChatAttachment[];
}

export interface ChatAttachment {
  id: string;
  name: string;
  type: "image" | "file";
  mimeType: string;
  base64: string; // base64-encoded content
  size: number; // bytes
}

export interface ChatSession {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messageCount: number;
}

// Generate a simple unique ID
function generateSessionId(): string {
  return `session-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

// --- Session Management ---

export async function loadChatSessions(projectPath: string): Promise<ChatSession[]> {
  try {
    const store = await load(STORE_NAME, { autoSave: true, defaults: {} });
    const sessionsByProject = ((await store.get(CHAT_SESSIONS_KEY)) as Record<string, ChatSession[]>) || {};
    return sessionsByProject[getProjectStoreKey(projectPath)] || [];
  } catch {
    return [];
  }
}

export async function saveChatSessions(projectPath: string, sessions: ChatSession[]): Promise<void> {
  const store = await load(STORE_NAME, { autoSave: true, defaults: {} });
  const sessionsByProject = ((await store.get(CHAT_SESSIONS_KEY)) as Record<string, ChatSession[]>) || {};
  sessionsByProject[getProjectStoreKey(projectPath)] = sessions;
  await store.set(CHAT_SESSIONS_KEY, sessionsByProject);
  await store.save();
}

export async function createChatSession(projectPath: string, title?: string): Promise<ChatSession> {
  const session: ChatSession = {
    id: generateSessionId(),
    title: title || "New Chat",
    createdAt: Date.now(),
    updatedAt: Date.now(),
    messageCount: 0,
  };
  const sessions = await loadChatSessions(projectPath);
  sessions.unshift(session); // newest first
  await saveChatSessions(projectPath, sessions);
  return session;
}

export async function deleteChatSession(projectPath: string, sessionId: string): Promise<void> {
  const sessions = await loadChatSessions(projectPath);
  const filtered = sessions.filter((s) => s.id !== sessionId);
  await saveChatSessions(projectPath, filtered);
  // Also delete the messages for this session
  const store = await load(STORE_NAME, { autoSave: true, defaults: {} });
  const historyByProject = ((await store.get(CHAT_HISTORY_KEY)) as Record<string, Record<string, PersistedChatMessage[]>>) || {};
  const projectKey = getProjectStoreKey(projectPath);
  if (historyByProject[projectKey] && typeof historyByProject[projectKey] === "object") {
    delete (historyByProject[projectKey] as Record<string, PersistedChatMessage[]>)[sessionId];
    await store.set(CHAT_HISTORY_KEY, historyByProject);
    await store.save();
  }
}

export async function renameChatSession(projectPath: string, sessionId: string, newTitle: string): Promise<void> {
  const sessions = await loadChatSessions(projectPath);
  const session = sessions.find((s) => s.id === sessionId);
  if (session) {
    session.title = newTitle;
    await saveChatSessions(projectPath, sessions);
  }
}

// --- Message Persistence (session-aware) ---

export async function loadChatHistory(projectPath: string, sessionId?: string): Promise<PersistedChatMessage[]> {
  try {
    const store = await load(STORE_NAME, { autoSave: true, defaults: {} });
    const historyByProject = ((await store.get(CHAT_HISTORY_KEY)) as Record<string, unknown>) || {};
    const projectKey = getProjectStoreKey(projectPath);
    const projectHistory = historyByProject[projectKey];

    // Migration: if old format (flat array), return it for the default session
    if (Array.isArray(projectHistory)) {
      return projectHistory as PersistedChatMessage[];
    }

    // New format: Record<sessionId, messages[]>
    if (projectHistory && typeof projectHistory === "object" && sessionId) {
      return ((projectHistory as Record<string, PersistedChatMessage[]>)[sessionId]) || [];
    }

    return [];
  } catch {
    return [];
  }
}

export async function saveChatHistory(projectPath: string, messages: PersistedChatMessage[], sessionId?: string): Promise<void> {
  const store = await load(STORE_NAME, { autoSave: true, defaults: {} });
  const historyByProject = ((await store.get(CHAT_HISTORY_KEY)) as Record<string, unknown>) || {};
  const projectKey = getProjectStoreKey(projectPath);
  const trimmed = messages.slice(-MAX_CHAT_HISTORY);

  if (sessionId) {
    // New multi-session format
    let projectHistory = historyByProject[projectKey];

    // Migrate from old flat array format
    if (Array.isArray(projectHistory) || !projectHistory) {
      projectHistory = {};
    }

    (projectHistory as Record<string, PersistedChatMessage[]>)[sessionId] = trimmed;
    historyByProject[projectKey] = projectHistory;
  } else {
    // Legacy fallback (flat array)
    historyByProject[projectKey] = trimmed;
  }

  await store.set(CHAT_HISTORY_KEY, historyByProject);
  await store.save();

  // Update session metadata
  if (sessionId) {
    const sessions = await loadChatSessions(projectPath);
    const session = sessions.find((s) => s.id === sessionId);
    if (session) {
      session.updatedAt = Date.now();
      session.messageCount = trimmed.length;
      // Auto-title from first user message if still "New Chat"
      if (session.title === "New Chat" && trimmed.length > 0) {
        const firstUser = trimmed.find((m) => m.role === "user");
        if (firstUser) {
          session.title = firstUser.content.slice(0, 50) + (firstUser.content.length > 50 ? "..." : "");
        }
      }
      await saveChatSessions(projectPath, sessions);
    }
  }
}

export async function clearChatHistory(projectPath: string, sessionId?: string): Promise<void> {
  const store = await load(STORE_NAME, { autoSave: true, defaults: {} });
  const historyByProject = ((await store.get(CHAT_HISTORY_KEY)) as Record<string, unknown>) || {};
  const projectKey = getProjectStoreKey(projectPath);

  if (sessionId) {
    const projectHistory = historyByProject[projectKey];
    if (projectHistory && typeof projectHistory === "object" && !Array.isArray(projectHistory)) {
      delete (projectHistory as Record<string, PersistedChatMessage[]>)[sessionId];
      historyByProject[projectKey] = projectHistory;
    }
  } else {
    delete historyByProject[projectKey];
  }

  await store.set(CHAT_HISTORY_KEY, historyByProject);
  await store.save();
}

// --- Migration helper: convert old flat history to a session ---
export async function migrateToSessions(projectPath: string): Promise<string | null> {
  try {
    const store = await load(STORE_NAME, { autoSave: true, defaults: {} });
    const historyByProject = ((await store.get(CHAT_HISTORY_KEY)) as Record<string, unknown>) || {};
    const projectKey = getProjectStoreKey(projectPath);
    const projectHistory = historyByProject[projectKey];

    // Only migrate if it's the old flat array format
    if (Array.isArray(projectHistory) && projectHistory.length > 0) {
      const session = await createChatSession(projectPath, "Previous Chat");
      // Move old messages into the new session
      historyByProject[projectKey] = { [session.id]: projectHistory };
      await store.set(CHAT_HISTORY_KEY, historyByProject);
      await store.save();
      return session.id;
    }
    return null;
  } catch {
    return null;
  }
}

// LLM
export const callLlm = (request: LlmRequest) =>
  invoke<LlmResponse>("call_llm", { request });

// --- Inline Completion Setting ---
const INLINE_COMPLETION_KEY = "inline_completion_enabled";

export async function loadInlineCompletionEnabled(): Promise<boolean> {
  try {
    const store = await load(STORE_NAME, { autoSave: true, defaults: {} });
    const value = await store.get(INLINE_COMPLETION_KEY);
    return value !== false; // Default to true
  } catch {
    return true;
  }
}

export async function saveInlineCompletionEnabled(enabled: boolean): Promise<void> {
  const store = await load(STORE_NAME, { autoSave: true, defaults: {} });
  await store.set(INLINE_COMPLETION_KEY, enabled);
  await store.save();
}

// --- Custom Themes ---
const CUSTOM_THEMES_KEY = "custom_themes";
const ACTIVE_THEME_KEY = "active_theme_id";

export async function loadCustomThemes(): Promise<import("./themes").ThemeDefinition[]> {
  try {
    const store = await load(STORE_NAME, { autoSave: true, defaults: {} });
    return ((await store.get(CUSTOM_THEMES_KEY)) as import("./themes").ThemeDefinition[]) || [];
  } catch {
    return [];
  }
}

export async function saveCustomThemes(themes: import("./themes").ThemeDefinition[]): Promise<void> {
  const store = await load(STORE_NAME, { autoSave: true, defaults: {} });
  await store.set(CUSTOM_THEMES_KEY, themes);
  await store.save();
}

export async function loadActiveThemeId(): Promise<string | null> {
  try {
    const store = await load(STORE_NAME, { autoSave: true, defaults: {} });
    return ((await store.get(ACTIVE_THEME_KEY)) as string) || null;
  } catch {
    return null;
  }
}

export async function saveActiveThemeId(themeId: string): Promise<void> {
  const store = await load(STORE_NAME, { autoSave: true, defaults: {} });
  await store.set(ACTIVE_THEME_KEY, themeId);
  await store.save();
}

// ─── MCP Server Configs ────────────────────────────────────────────────────────

const MCP_SERVERS_KEY = "mcp_servers";

export async function loadMcpServers(): Promise<import("./mcp").MCPServerConfig[]> {
  try {
    const store = await load(STORE_NAME, { autoSave: true, defaults: {} });
    return ((await store.get(MCP_SERVERS_KEY)) as import("./mcp").MCPServerConfig[]) || [];
  } catch {
    return [];
  }
}

export async function saveMcpServers(servers: import("./mcp").MCPServerConfig[]): Promise<void> {
  const store = await load(STORE_NAME, { autoSave: true, defaults: {} });
  // Strip cached tool lists before saving to keep storage light
  const stripped = servers.map(({ tools: _tools, ...rest }) => rest);
  await store.set(MCP_SERVERS_KEY, stripped);
  await store.save();
}

// ─── Settings export / import ─────────────────────────────────────────────────

export async function exportAllSettings(): Promise<string> {
  const store = await load(STORE_NAME, { autoSave: true, defaults: {} });
  const keys = [
    "provider", "api_key", "model", "theme",
    "adaptiveMode", "adaptiveStrategy",
    "ai_providers", "mcp_servers", "active_theme_id",
    "custom_themes", "inline_completion_enabled",
  ];
  const data: Record<string, unknown> = { _punamide_export: true, version: "2.0" };
  for (const key of keys) {
    const val = await store.get(key);
    if (val !== null && val !== undefined) data[key] = val;
  }
  return JSON.stringify(data, null, 2);
}

export async function importAllSettings(json: string): Promise<void> {
  const data = JSON.parse(json);
  if (!data._punamide_export) throw new Error("Not a valid PunamIDE settings export.");
  const store = await load(STORE_NAME, { autoSave: true, defaults: {} });
  const skip = new Set(["_punamide_export", "version"]);
  for (const [key, val] of Object.entries(data)) {
    if (skip.has(key)) continue;
    await store.set(key, val);
  }
  await store.save();
}

// ─── Recent Projects (list of last N project paths) ───────────────────────────

const RECENT_PROJECTS_KEY = "recent_projects_list";
const MAX_RECENT_PROJECTS = 8;

export async function loadRecentProjects(): Promise<string[]> {
  try {
    const store = await load(STORE_NAME, { autoSave: true, defaults: {} });
    return ((await store.get(RECENT_PROJECTS_KEY)) as string[]) || [];
  } catch {
    return [];
  }
}

export async function addRecentProject(path: string): Promise<void> {
  const store = await load(STORE_NAME, { autoSave: true, defaults: {} });
  const list = ((await store.get(RECENT_PROJECTS_KEY)) as string[]) || [];
  const updated = [path, ...list.filter((p) => p !== path)].slice(0, MAX_RECENT_PROJECTS);
  await store.set(RECENT_PROJECTS_KEY, updated);
  await store.save();
}

// ─── Project Context Cache (Rust-side fast index) ─────────────────────────────

export interface FileIndexEntry {
  path: string;
  extension: string;
  size: number;
  modified: number;
  preview: string;
  is_binary: boolean;
}

export const getProjectIndex = () =>
  invoke<FileIndexEntry[]>("get_project_index");

export const refreshProjectIndex = () =>
  invoke<FileIndexEntry[]>("refresh_project_index");

export const updateFileIndex = (path: string) =>
  invoke<void>("update_file_index", { path });

// ─── Rust Git Engine (libgit2) ────────────────────────────────────────────────

export interface GitStatusEntry {
  path: string;
  status: string;
}

export interface GitDiffResult {
  diff_text: string;
  additions: number;
  deletions: number;
}

export const gitStatus = () =>
  invoke<GitStatusEntry[]>("git_status");

export const gitDiffFile = (path: string) =>
  invoke<GitDiffResult>("git_diff_file", { path });

export const gitLog = (count: number) =>
  invoke<string[]>("git_log", { count });

export const gitBranch = () =>
  invoke<string>("git_branch");

// Alpha diagnostics / feedback
export const generateDiagnosticsReport = (
  includeProjectPath: boolean,
  userMessage?: string,
) =>
  invoke<string>("generate_diagnostics_report", {
    includeProjectPath,
    userMessage,
  });

export const exportDiagnosticsReport = (path: string, report: string) =>
  invoke<void>("export_diagnostics_report", { path, report });

export interface SystemDiagnostics {
  app_version: string;
  build_number: string;
  release_date: string;
  release_channel: string;
  os: string;
  os_version: string;
  cpu: string;
  logical_cpus: number;
  total_memory_mb: number;
  tauri_version: string;
  rust_backend_version: string;
  log_path: string;
  data_path: string;
}

export const getSystemDiagnostics = () =>
  invoke<SystemDiagnostics>("get_system_diagnostics");

export const openLogsFolder = () =>
  invoke<void>("open_logs_folder");

export const openDataFolder = () =>
  invoke<void>("open_data_folder");

// ─── (Rust fuzzy edit and codebase index wrappers removed — JS implementations used instead) ───


// ─── DAP (Debug Adapter Protocol) ─────────────────────────────────────────────

export interface DapRequest {
  seq: number;
  type: string;
  command: string;
  arguments: any;
}

export interface DapResponse {
  seq: number;
  type: string;
  request_seq: number;
  success: boolean;
  command: string;
  message?: string;
  body?: any;
}

export interface DapEvent {
  seq: number;
  type: string;
  event: string;
  body?: any;
}

export type DapMessage = DapRequest | DapResponse | DapEvent;

export const dapStart = (sessionId: string, adapterCommand: string, adapterArgs: string[], cwd: string) =>
  invoke<void>("dap_start", { sessionId, adapterCommand, adapterArgs, cwd });

export const dapStartTcp = (sessionId: string, adapterCommand: string, adapterArgs: string[], cwd: string, host: string, port: number) =>
  invoke<void>("dap_start_tcp", { sessionId, adapterCommand, adapterArgs, cwd, host, port });

export const dapSendRequest = (sessionId: string, request: DapRequest) =>
  invoke<void>("dap_send_request", { sessionId, request });

export const dapStop = (sessionId: string) =>
  invoke<void>("dap_stop", { sessionId });
