import { useState, useEffect, useCallback, useRef, useMemo, lazy, Suspense } from "react";
import {
  FolderOpen,
  TerminalSquare,
  AlertCircle,
  Maximize2,
  Minimize2,
  ChevronRight,
  Terminal as TerminalIcon,
  Search,
  Command,
  Bug,
  Columns2,
  ShieldCheck,
  StickyNote,
  Monitor,
  FlaskConical,
  FilePlus,
  FileUp,
  X,
  Play,
  BugPlay,
  SquareDot,
  HelpCircle,
  MessageSquare,
  FileText,
  Download,
  Info,
  ExternalLink,
  Clipboard,
  FolderCog,
  RefreshCw,
  Globe,
  Wrench,
} from "lucide-react";
import FileExplorer from "./components/FileExplorer";
import FindReplace from "./components/FindReplace";
import GitPanel from "./components/GitPanel";
const GitDiffView = lazy(() => import("./components/GitDiffView"));
import RunProfiles from "./components/RunProfiles";
import ProblemsPanel from "./components/ProblemsPanel";
import EditorTabs from "./components/EditorTabs";
import type { Tab } from "./components/EditorTabs";
import CodeEditor, { getLanguage } from "./components/CodeEditor";
import CommandPalette from "./components/CommandPalette";
import type { CommandAction } from "./components/CommandPalette";
import MultiFileDiffBoard from "./components/MultiFileDiffBoard";
import type { ReviewChanges } from "./components/MultiFileDiffBoard";
import MergeConflictPanel from "./components/MergeConflictPanel";
import { hasConflictMarkers } from "./utils/conflictParser";
import Breadcrumbs from "./components/Breadcrumbs";
import TerminalPanel from "./components/TerminalPanel";
import RightPanel from "./components/RightPanel";
import { PanelErrorBoundary } from "./components/ErrorBoundary";
import ConfirmDialog from "./components/ConfirmDialog";
import type { ProjectCheckResult } from "./types";
import SettingsPanel from "./components/Settings";
import FuzzyFilePicker from "./components/FuzzyFilePicker";
import StatusBar from "./components/StatusBar";
import ActivityBar from "./components/ActivityBar";
import type { ActivityView } from "./components/ActivityBar";
import { FileIcon } from "./components/FileIcon";
import DebuggerPanel from "./components/DebuggerPanel";
import DebugConfigPicker from "./components/DebugConfigPicker";

// ── Lazily loaded panels (only load when first opened) ─────────────────────
const BugHunt        = lazy(() => import("./components/BugHunt"));
const CodeReview     = lazy(() => import("./components/CodeReview"));
const SplitEditor    = lazy(() => import("./components/SplitEditor"));
const FileTemplatePicker = lazy(() => import("./components/FileTemplatePicker"));
const NotesPanel     = lazy(() => import("./components/NotesPanel").then(m => ({ default: m.default })));
const LivePreview    = lazy(() => import("./components/LivePreview"));
const WebPreviewPanel = lazy(() => import("./components/WebPreviewPanel"));
const TestGenerator  = lazy(() => import("./components/TestGenerator"));
const TestGenPanel   = lazy(() => import("./components/TestGenPanel"));
const RefactorPanel  = lazy(() => import("./components/RefactorPanel"));
const ImportPanel    = lazy(() => import("./components/ImportPanel"));

// Phase 1 — Ported from Zenith IDE
const DockerPanel       = lazy(() => import("./components/DockerPanel"));
const NotepadsPanel     = lazy(() => import("./components/NotepadsPanel"));
const GitHubPanel       = lazy(() => import("./components/github/GitHubPanel"));
const ContextSidebar    = lazy(() => import("./components/ContextSidebar"));

// loadNotes is a small utility — import directly, not lazily
import { loadNotes } from "./components/NotesPanel";

// ── Lazy fallback ──────────────────────────────────────────────────────────
// (Suspense uses null fallback for instant transitions)
import {
  readDirectory,
  readFile,
  writeFile,
  pathExists,
  deletePath,
  loadConfigFromStore,
  saveConfigToStore,
  loadRecentProjectPath,
  saveRecentProjectPath,
  clearRecentProjectPath,
  loadRunProfiles,
  saveRunProfiles,
  runTerminalCommand,
  setProjectRoot,
  watchProject,
  loadAIProviders,
  inspectCommand,
  loadInlineCompletionEnabled,
  saveInlineCompletionEnabled,
  loadActiveThemeId,
  saveActiveThemeId,
  loadCustomThemes,
  loadRecentProjects,
  addRecentProject,
  updateFileIndex,
  dapStart,
  dapStartTcp,
  dapSendRequest,
  dapStop,
  generateDiagnosticsReport,
  exportDiagnosticsReport,
  getSystemDiagnostics,
  openLogsFolder,
  openDataFolder,
} from "./utils/tauri";
import type { AppConfig, FileEntry, RunProfile, SearchResult, DapRequest, SystemDiagnostics, RecentProject } from "./utils/tauri";
import type { ParsedResponse } from "./utils/prompts";
import { parseProblemsFromOutput } from "./utils/problems";
import type { DebugLaunchConfig } from "./utils/debugConfig";
import { loadLaunchConfigs, saveLaunchConfigs, createDefaultLaunchJson, resolveConfigVariables, getDefaultConfig, detectProjectType, autoGenerateLaunchJson } from "./utils/debugConfig";
import type { Problem } from "./utils/problems";
import { registerToastHandler } from "./utils/toast";
import { applyTheme, getDefaultTheme, getThemeById } from "./utils/themes";
import { open, save } from "@tauri-apps/plugin-dialog";
import { open as openExternal } from "@tauri-apps/plugin-shell";
import { listen } from "@tauri-apps/api/event";
import Split from "react-split";
import "./styles/index.css";
import type { RunObservation } from "./services/run/verifiedRun";
import {
  ALPHA_RELEASE_NOTES,
  PUNAM_BUILD_NUMBER,
  PUNAM_CHANGELOG,
  PUNAM_DISCORD_URL,
  PUNAM_GITHUB_URL,
  PUNAM_LICENSE,
  PUNAM_RELEASE_CHANNEL,
  PUNAM_RELEASE_DATE,
  PUNAM_VERSION,
  PUNAM_WEBSITE_URL,
} from "./config/alpha";

// LSP integration
import { lspManager } from "./services/lsp/lspManager";

// Agent safety guard — intercepts file writes and browser opens
import { checkFileWrite, checkBrowserOpen, registerBrowser } from "./services/agent/AgentApplyGuard";

// Auto-save hook
import { useAutoSave } from "./hooks/useAutoSave";

// Auto AST re-indexing on file save
import { useAutoReindex } from "./hooks/useAutoReindex";

// Agent-assisted debugging bridge
import { DapBridge } from "./services/debug/DapBridge";

// Proactive error detection on recent edits
import { useProactiveErrors } from "./hooks/useProactiveErrors";

// Context sidebar wiring (cursor-move, file change, diagnostics)
import { useContextSidebar } from "./hooks/useContextSidebar";

// Inline diff preview for AI edits
import { useInlineDiff } from "./hooks/useInlineDiff";
import InlineDiffPreview from "./components/InlineDiffPreview";

// Background agent panel
import BackgroundAgentPanel from "./components/BackgroundAgentPanel";

// Keyboard shortcuts

// Doc Generator (Component 14)
import { DocGenerator } from "./services/docs/DocGenerator";
import type { DocTarget } from "./services/docs/DocGenerator";
import { useEditorStore } from "./store/editorStore";
import type { TestGenSource } from "./components/TestGenPanel";
import type { RefactorMode } from "./components/RefactorPanel";

const isAbsolutePath = (path: string) => /^[A-Za-z]:[\\/]/.test(path) || path.startsWith("/");
const normalizeFsPath = (path: string) => path.replace(/\\/g, "/").replace(/\/+/g, "/").toLowerCase();

/** Format a timestamp as a relative time string (e.g. "5 min ago", "Yesterday") */
function formatRelativeTime(timestamp: number): string {
  const now = Date.now();
  const diff = now - timestamp;
  const minutes = Math.floor(diff / 60_000);
  const hours = Math.floor(diff / 3_600_000);
  const days = Math.floor(diff / 86_400_000);

  if (minutes < 1) return "Just now";
  if (minutes < 60) return `${minutes} min ago`;
  if (hours < 24) return `${hours}h ago`;
  if (days === 1) return "Yesterday";
  if (days < 7) return `${days} days ago`;
  if (days < 30) return `${Math.floor(days / 7)}w ago`;
  return `${Math.floor(days / 30)}mo ago`;
}

export default function App() {
  const [projectPath, setProjectPath] = useState<string>("");
  const [files, setFiles] = useState<FileEntry[]>([]);
  const [tabs, setTabs] = useState<Tab[]>([]);
  const [activeTab, setActiveTab] = useState<string>("");
  const [config, setConfig] = useState<AppConfig>({
    provider: "gemini",
    api_key: "",
    model: "gemini-2.0-flash",
    theme: "dark",
    adaptiveMode: false,
    adaptiveStrategy: "coding_optimized",
  });

  const [showSidebar, setShowSidebar] = useState(true);
  const [showAiPanel, setShowAiPanel] = useState(true);
  const [showTerminal, setShowTerminal] = useState(false);
  const [showProblems, setShowProblems] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [showHelpMenu, setShowHelpMenu] = useState(false);
  const [showFeedback, setShowFeedback] = useState(false);
  const [showDiagnostics, setShowDiagnostics] = useState(false);
  const [showAbout, setShowAbout] = useState(false);
  const [showFirstRunWelcome, setShowFirstRunWelcome] = useState(false);
  const [feedbackMessage, setFeedbackMessage] = useState("");
  const [includeProjectPathInDiagnostics, setIncludeProjectPathInDiagnostics] = useState(false);
  const [diagnosticsReport, setDiagnosticsReport] = useState("");
  const [systemDiagnostics, setSystemDiagnostics] = useState<SystemDiagnostics | null>(null);
  const [diagnosticsBusy, setDiagnosticsBusy] = useState(false);
  const [showRunProfiles, setShowRunProfiles] = useState(false);
  const [showSearch, setShowSearch] = useState(false);
  const [showGitPanel, setShowGitPanel] = useState(false);
  const [showSplash, setShowSplash] = useState(true);
  const [showCommandPalette, setShowCommandPalette] = useState(false);
  const [showImportPanel, setShowImportPanel] = useState(false);
  const [showShortcuts, setShowShortcuts] = useState(false);
  const [runningProjectCheck, setRunningProjectCheck] = useState(false);
  const [projectCheckResult, setProjectCheckResult] = useState<ProjectCheckResult | null>(null);
  const [problems, setProblems] = useState<Problem[]>([]);
  const [bottomPanelActive, setBottomPanelActive] = useState<"terminal" | "problems" | "debug">("terminal");
  const [runProfiles, setRunProfiles] = useState<RunProfile[]>([]);
  // Debugger state
  const [showDebug, setShowDebug] = useState(false);
  const [debugSessionId, setDebugSessionId] = useState<string | null>(null);
  const [debugAdapterStatus, setDebugAdapterStatus] = useState<"stopped" | "running" | "paused">("stopped");
  const [breakpoints, setBreakpoints] = useState<Record<string, number[]>>({}); // path -> lines
  const [currentThreadId, setCurrentThreadId] = useState<number | null>(null);
  const [currentStackFrames, setCurrentStackFrames] = useState<any[]>([]); // Simplified for now
  const [currentVariables, setCurrentVariables] = useState<any[]>([]); // Simplified for now
  const [currentSource, setCurrentSource] = useState<{ path: string; line: number; } | null>(null);
  const [debugConsoleOutput, setDebugConsoleOutput] = useState<string[]>([]);
  const [_threads, _setThreads] = useState<{ id: number; name: string }[]>([]);
  const [debugLaunchConfigs, setDebugLaunchConfigs] = useState<DebugLaunchConfig[]>([]);
  const [selectedDebugConfigId, setSelectedDebugConfigId] = useState<string | null>(null);

  // Activity bar state
  const [activityView, setActivityView] = useState<ActivityView>("explorer");

  // Sync activityView with sidebar/panel state
  const handleActivitySelect = useCallback((view: ActivityView) => {
    setActivityView(view);
    if (view === null) { setShowSidebar(false); return; }
    setShowSidebar(true);
    setShowSearch(view === "search");
    setShowGitPanel(view === "git");
    setShowAiPanel(view === "ai" ? true : showAiPanel);
    if (view === "git") setGitRefreshKey(k => k + 1);
  }, [showAiPanel]);
  const [pendingReview, setPendingReview] = useState<{
    changes: ReviewChanges;
    resolve: (applied: boolean) => void;
  } | null>(null);
  const [editorLine, setEditorLine] = useState<number | undefined>(undefined);
  const [gitRefreshKey, setGitRefreshKey] = useState(0);
  const [selectedText, setSelectedText] = useState("");
  const [terminalOutput, setTerminalOutput] = useState("");
  const [aiProviders, setAiProviders] = useState<import("./utils/providers").AIProviderConfig[]>([]);
  const [inlineCompletionEnabled, setInlineCompletionEnabled] = useState(true);
  const [blameEnabled, setBlameEnabled] = useState(false);
  const [pendingTerminalCmd, setPendingTerminalCmd] = useState<string | null>(null);
  const [checkpoints, setCheckpoints] = useState<import("./types").Checkpoint[]>([]);
  // Derived: last applied files for undo button state
  const lastAppliedChanges = checkpoints.length > 0 ? checkpoints[checkpoints.length - 1].files : null;
  void lastAppliedChanges; // used via checkpoints.length in command palette
  const [proactiveError, setProactiveError] = useState<{ command: string; output: string } | null>(null);
  const [runObservation, setRunObservation] = useState<RunObservation | null>(null);
  const [zenMode, setZenMode] = useState(false);
  const [showBugHunt, setShowBugHunt] = useState(false);
  const [toasts, setToasts] = useState<Array<{ id: number; message: string; type: "info" | "success" | "error" | "warning" }>>([]);
  // --- New feature state ---
  const [showFuzzyPicker, setShowFuzzyPicker] = useState(false);
  const [recentPaths, setRecentPaths] = useState<string[]>([]);
  const [showCodeReview, setShowCodeReview] = useState(false);
  const [splitMode, setSplitMode] = useState(false);
  const [rightTabs, setRightTabs] = useState<Tab[]>([]);
  const [rightActiveTab, setRightActiveTab] = useState<string>("");
  const [gitBranch, setGitBranch] = useState<string>("");
  const [mcpServers, setMcpServers] = useState<import("./utils/mcp").MCPServerConfig[]>([]);
  const [editorCursorPosition, setEditorCursorPosition] = useState<{ line: number; column: number }>({ line: 1, column: 1 });
  // --- 4 new features ---
  const [showTemplatePicker, setShowTemplatePicker] = useState(false);
  const [showNotes, setShowNotes] = useState(false);
  const [projectNotes, setProjectNotes] = useState<string>("");
  const [showLivePreview, setShowLivePreview] = useState(false);
  const [webPreviewUrl, setWebPreviewUrl] = useState<string | null>(null);
  const [showTestGenerator, setShowTestGenerator] = useState(false);
  const [testGenPanelSource, setTestGenPanelSource] = useState<TestGenSource | null>(null);
  const [showRefactorPanel, setShowRefactorPanel] = useState(false);
  const [refactorPanelWidth, setRefactorPanelWidth] = useState(520);
  const [refactorMode, setRefactorMode] = useState<RefactorMode>("rename");
  const [refactorSelection, setRefactorSelection] = useState<{ startLine: number; startColumn: number; endLine: number; endColumn: number; text: string } | null>(null);

  // These panels share the same workspace.  Keep only one mounted so a newly
  // opened tool is immediately usable instead of being hidden behind older ones.
  type WorkspaceTool = "codeReview" | "livePreview" | "testGenerator" | "refactor" | "notes" | null;
  const openWorkspaceTool = useCallback((tool: WorkspaceTool) => {
    setShowCodeReview(tool === "codeReview");
    setShowLivePreview(tool === "livePreview");
    setShowTestGenerator(tool === "testGenerator");
    setShowRefactorPanel(tool === "refactor");
    setShowNotes(tool === "notes");
    setTestGenPanelSource(null);
  }, []);

  const toggleWorkspaceTool = useCallback((tool: Exclude<WorkspaceTool, null>, isOpen: boolean) => {
    openWorkspaceTool(isOpen ? null : tool);
  }, [openWorkspaceTool]);

  const openTestGenPanel = useCallback((source: TestGenSource) => {
    openWorkspaceTool(null);
    setTestGenPanelSource(source);
  }, [openWorkspaceTool]);

  const openRefactorPanel = useCallback((mode: RefactorMode = "rename") => {
    setRefactorMode(mode);
    openWorkspaceTool("refactor");
  }, [openWorkspaceTool]);
  // Font size control (Ctrl+= / Ctrl+-)
  const [editorFontSize, setEditorFontSize] = useState(14);
  // Recent projects
  const [recentProjects, setRecentProjects] = useState<RecentProject[]>([]);
  // Editor display toggles
  const [showMinimap, setShowMinimap] = useState(true);
  const [wordWrap, setWordWrap] = useState<"on" | "off">("on");
  // Git diff view
  const [gitDiffFile, setGitDiffFile] = useState<string | null>(null);
  // Force prompt from right-click context menu (explain/fix/refactor)
  const [forceAiPrompt, setForceAiPrompt] = useState<{ text: string; mode: string } | null>(null);
  const toastIdRef = useRef(0);
  const tabsRef = useRef<Tab[]>([]);
  const isClosingRef = useRef(false);
  const dapRequestSeq = useRef(1);
  const handleFileSelectRef = useRef<(path: string) => Promise<void>>(async () => {});

  // ── Auto-cap debug console at 500 lines to prevent unbounded memory growth ──
  // Use a ref to avoid re-triggering when we trim (prevents infinite loop)
  const debugCapRef = useRef(false);
  useEffect(() => {
    if (debugCapRef.current) { debugCapRef.current = false; return; }
    if (debugConsoleOutput.length > 500) {
      debugCapRef.current = true;
      setDebugConsoleOutput(prev => prev.slice(-500));
    }
  }, [debugConsoleOutput]);

  // Keep tabsRef in sync
  useEffect(() => { tabsRef.current = tabs; }, [tabs]);

  const showToast = useCallback((message: string, type: "info" | "success" | "error" | "warning" = "info") => {
    const id = ++toastIdRef.current;
    setToasts((prev) => [...prev, { id, message, type }]);
    setTimeout(() => setToasts((prev) => prev.filter((t) => t.id !== id)), 4000);
  }, []);

  // Register global toast handler so any component can show toasts without props
  registerToastHandler(showToast);

  useEffect(() => {
    const key = "punamide_alpha_welcome_seen";
    if (!window.localStorage.getItem(key)) {
      setShowFirstRunWelcome(true);
      window.localStorage.setItem(key, "1");
    }
  }, []);

  const refreshSystemDiagnostics = useCallback(async () => {
    try {
      const info = await getSystemDiagnostics();
      setSystemDiagnostics(info);
      return info;
    } catch (err) {
      showToast(`Failed to load system info: ${err}`, "error");
      return null;
    }
  }, [showToast]);

  const buildDiagnosticsReport = useCallback(async (message?: string) => {
    return generateDiagnosticsReport(includeProjectPathInDiagnostics, message?.trim() || undefined);
  }, [includeProjectPathInDiagnostics]);

  const handleGenerateDiagnostics = useCallback(async (message?: string) => {
    setDiagnosticsBusy(true);
    try {
      await refreshSystemDiagnostics();
      const report = await buildDiagnosticsReport(message);
      setDiagnosticsReport(report);
      setShowDiagnostics(true);
      return report;
    } catch (err) {
      showToast(`Failed to generate diagnostics: ${err}`, "error");
      return "";
    } finally {
      setDiagnosticsBusy(false);
    }
  }, [buildDiagnosticsReport, refreshSystemDiagnostics, showToast]);

  const handleExportDiagnostics = useCallback(async (message?: string, forceFresh = false) => {
    setDiagnosticsBusy(true);
    try {
      const report = forceFresh || message ? await buildDiagnosticsReport(message) : diagnosticsReport || await buildDiagnosticsReport(message);
      const path = await save({
        defaultPath: "punamide-alpha-diagnostics.txt",
        filters: [{ name: "Text", extensions: ["txt"] }],
      });
      if (!path) return;
      await exportDiagnosticsReport(path, report);
      setDiagnosticsReport(report);
      showToast("Diagnostics exported.", "success");
    } catch (err) {
      showToast(`Failed to export diagnostics: ${err}`, "error");
    } finally {
      setDiagnosticsBusy(false);
    }
  }, [buildDiagnosticsReport, diagnosticsReport, showToast]);

  const handleCopyDiagnostics = useCallback(async (message?: string) => {
    try {
      const report = diagnosticsReport || await buildDiagnosticsReport(message);
      await navigator.clipboard.writeText(report);
      setDiagnosticsReport(report);
      showToast("Diagnostics copied.", "success");
    } catch (err) {
      showToast(`Failed to copy diagnostics: ${err}`, "error");
    }
  }, [buildDiagnosticsReport, diagnosticsReport, showToast]);

  const handleCopySystemInfo = useCallback(async () => {
    const info = systemDiagnostics || await refreshSystemDiagnostics();
    if (!info) return;
    const activeProvider = aiProviders.find((provider) => provider.apiKey || provider.name === "Ollama (Local)")?.name || config.provider || "Not configured";
    const lines = [
      `PunamIDE ${PUNAM_VERSION}`,
      `Build: ${info.build_number}`,
      `Channel: ${info.release_channel}`,
      `OS: ${info.os} ${info.os_version}`,
      `CPU: ${info.cpu} (${info.logical_cpus} logical)`,
      `RAM: ${info.total_memory_mb} MB`,
      `Tauri: ${info.tauri_version}`,
      `Rust backend: ${info.rust_backend_version}`,
      `Provider: ${activeProvider}`,
      `Logs: ${info.log_path}`,
    ];
    await navigator.clipboard.writeText(lines.join("\n"));
    showToast("System info copied.", "success");
  }, [aiProviders, config.provider, refreshSystemDiagnostics, showToast, systemDiagnostics]);

  const handleJoinDiscord = useCallback(async () => {
    if (PUNAM_DISCORD_URL.includes("REPLACE_ME")) {
      showToast("Discord invite is not configured yet.", "warning");
      return;
    }
    try {
      await openExternal(PUNAM_DISCORD_URL);
    } catch (err) {
      showToast(`Failed to open Discord: ${err}`, "error");
    }
  }, [showToast]);

  const handleOpenExternal = useCallback(async (url: string) => {
    try {
      await openExternal(url);
    } catch (err) {
      showToast(`Failed to open link: ${err}`, "error");
    }
  }, [showToast]);

  const handleCheckForUpdates = useCallback(() => {
    showToast("You are on the Alpha channel. Update checks are manual for v0.1.", "info");
  }, [showToast]);

  useEffect(() => {
    if (showDiagnostics && !systemDiagnostics) {
      refreshSystemDiagnostics();
    }
  }, [refreshSystemDiagnostics, showDiagnostics, systemDiagnostics]);

  const getProjectFilePath = useCallback((relativePath: string) => {
    if (isAbsolutePath(relativePath)) return relativePath;
    const separator = projectPath.includes("\\") ? "\\" : "/";
    return `${projectPath.replace(/[\\/]+$/, "")}${separator}${relativePath.replace(/^[\\/]+/, "")}`;
  }, [projectPath]);

    // ─── Debugger Actions ─────────────────────────────────────────────────────────

  const sendDapRequest = useCallback(async (command: string, args: any): Promise<void> => {
    if (!debugSessionId) { showToast("No active debug session.", "error"); return; }
    const request: DapRequest = {
      seq: dapRequestSeq.current++,
      type: "request",
      command,
      arguments: args,
    };
    try {
      await dapSendRequest(debugSessionId, request);
    } catch (err) {
      showToast(`Failed to send debugger command '${command}': ${err}`, "error");
      console.error(`DAP send error for ${command}:`, err);
    }
  }, [debugSessionId, showToast]);

  const debugSequencingRef = useRef<{ step: "idle" | "initializing" | "initialized" | "launching" | "ready"; config?: DebugLaunchConfig }>({ step: "idle" });

  // DAP handshake: send initialize, wait for initialized event, then launch
  const sendDapRequestRaw = useCallback(async (command: string, args: any): Promise<void> => {
    if (!debugSessionId) { showToast("No active debug session.", "error"); return; }
    const request: DapRequest = {
      seq: dapRequestSeq.current++,
      type: "request",
      command,
      arguments: args,
    };
    try {
      await dapSendRequest(debugSessionId, request);
    } catch (err) {
      showToast(`Failed to send debugger command '${command}': ${err}`, "error");
      console.error(`DAP send error for ${command}:`, err);
    }
  }, [debugSessionId, showToast]);

  // Fetch stack frames for a given thread from the debug adapter
  const fetchStackFrames = useCallback(async (threadId: number) => {
    if (!debugSessionId) return;
    try {
      await dapSendRequest(debugSessionId, {
        seq: dapRequestSeq.current++,
        type: "request",
        command: "stackTrace",
        arguments: { threadId, startFrame: 0, levels: 20 },
      });
    } catch (err) {
      console.error("Failed to fetch stack frames:", err);
    }
  }, [debugSessionId]);

  // Fetch scopes for a given frame
  const fetchScopes = useCallback(async (frameId: number) => {
    if (!debugSessionId) return;
    try {
      await dapSendRequest(debugSessionId, {
        seq: dapRequestSeq.current++,
        type: "request",
        command: "scopes",
        arguments: { frameId },
      });
    } catch (err) {
      console.error("Failed to fetch scopes:", err);
    }
  }, [debugSessionId]);

  // Fetch variables for a given variablesReference
  const fetchVariables = useCallback(async (variablesReference: number) => {
    if (!debugSessionId) return;
    try {
      await dapSendRequest(debugSessionId, {
        seq: dapRequestSeq.current++,
        type: "request",
        command: "variables",
        arguments: { variablesReference },
      });
    } catch (err) {
      console.error("Failed to fetch variables:", err);
    }
  }, [debugSessionId]);

  const handleStartDebug = useCallback(async () => {
    if (!projectPath) { showToast("No project open", "warning"); return; }
    if (debugAdapterStatus !== "stopped") { showToast("Debugger already running", "warning"); return; }

    // Get the selected launch configuration
    const selectedConfig = debugLaunchConfigs.find(c => c.id === selectedDebugConfigId);
    if (!selectedConfig) {
      showToast("No debug configuration selected. Create one via the config picker or edit .punam/launch.json", "warning");
      return;
    }

    // Validate config before attempting launch
    if (!selectedConfig.adapterCommand) {
      showToast("Invalid config: 'adapterCommand' is required. Edit launch.json to fix.", "error");
      return;
    }
    if (selectedConfig.request === "launch" && !selectedConfig.program) {
      showToast("Invalid config: 'program' is required for launch mode. Edit launch.json to fix.", "error");
      return;
    }
    if (selectedConfig.request === "attach" && !selectedConfig.port) {
      showToast("Invalid config: 'port' is required for attach mode. Edit launch.json to fix.", "error");
      return;
    }

    // Resolve variables like ${workspaceFolder}
    const config = resolveConfigVariables(selectedConfig, projectPath);

    console.log("[DEBUG] Starting debug session with config:", config.name, config);

    try {
      const newSessionId = `debug-${Date.now()}`;

      // Choose transport: TCP or stdio
      if (config.transport === "tcp" && config.host && config.port) {
        await dapStartTcp(
          newSessionId,
          config.adapterCommand,
          config.adapterArgs || [],
          config.cwd || projectPath,
          config.host,
          config.port,
        );
      } else {
        await dapStart(
          newSessionId,
          config.adapterCommand,
          config.adapterArgs || [],
          config.cwd || projectPath,
        );
      }

      setDebugSessionId(newSessionId);
      setDebugAdapterStatus("running");
      setShowDebug(true);
      setBottomPanelActive("debug");
      setDebugConsoleOutput(prev => [...prev, `[PunamIDE] Starting: ${config.name} (${config.adapterCommand}) [${config.transport || "stdio"}]`]);
      debugSequencingRef.current = { step: "initializing", config };

      // Set a timeout — if we don't get 'initialized' within 10s, something is wrong
      const initTimeout = setTimeout(() => {
        if (debugSequencingRef.current.step === "initializing") {
          console.warn("[DEBUG] Adapter did not respond to initialize within 10s");
          setDebugConsoleOutput(prev => [...prev, `[PunamIDE] ⚠ Adapter not responding. It may not be installed or may have crashed.`]);
          showToast("Debug adapter not responding. Is it installed?", "warning");
        }
      }, 10000);
      // Store timeout so we can clear it on success
      (debugSequencingRef.current as any)._initTimeout = initTimeout;

      // Send DAP initialize request (first step of handshake)
      // Note: We use dapSendRequest directly with newSessionId because
      // setDebugSessionId hasn't flushed to state yet at this point.
      const initRequest: DapRequest = {
        seq: dapRequestSeq.current++,
        type: "request",
        command: "initialize",
        arguments: {
          adapterID: config.type || "punam",
          clientID: "punam-ide",
          clientName: "PunamIDE",
          pathFormat: "path",
          linesStartAt1: true,
          columnsStartAt1: true,
          supportsVariableType: true,
          supportsVariablePaging: false,
          supportsRunInTerminalRequest: false,
          locale: "en-US",
        },
      };
      await dapSendRequest(newSessionId, initRequest);

      showToast(`Debugger starting: ${config.name}`, "success");
    } catch (err: any) {
      // Detect common failure modes and show helpful messages
      const errStr = String(err);
      if (errStr.includes("spawn") || errStr.includes("No such file") || errStr.includes("not found") || errStr.includes("ENOENT")) {
        showToast(`Debug adapter '${config.adapterCommand}' not found. Install it or check your PATH.`, "error");
        setDebugConsoleOutput(prev => [...prev, `[PunamIDE] ✗ Adapter not found: ${config.adapterCommand}`, `[PunamIDE] Hint: Install the adapter and ensure it's on your system PATH.`]);
      } else if (errStr.includes("EACCES") || errStr.includes("permission")) {
        showToast(`Permission denied running '${config.adapterCommand}'. Check file permissions.`, "error");
      } else if (errStr.includes("EADDRINUSE") || errStr.includes("address already in use")) {
        showToast(`Port already in use. Another debug session may be running.`, "error");
      } else {
        showToast(`Failed to start debugger: ${err}`, "error");
      }
      console.error("[DEBUG] Start error:", err);
    }
  }, [projectPath, debugAdapterStatus, debugLaunchConfigs, selectedDebugConfigId, showToast, sendDapRequestRaw]);

  const handleStopDebug = useCallback(async () => {
    if (!debugSessionId) return;
    try {
      // Send disconnect request before killing (graceful shutdown)
      try {
        await dapSendRequest(debugSessionId, {
          seq: dapRequestSeq.current++,
          type: "request",
          command: "disconnect",
          arguments: { restart: false, terminateDebuggee: true },
        });
      } catch {
        // Disconnect may fail if adapter already closed — that's fine
      }

      // Give adapter a moment to process disconnect, then force kill
      setTimeout(async () => {
        try { await dapStop(debugSessionId); } catch { /* already dead */ }
      }, 500);

      setDebugAdapterStatus("stopped");
      setDebugSessionId(null);
      setCurrentThreadId(null);
      setCurrentStackFrames([]);
      setCurrentVariables([]);
      setCurrentSource(null);
      setDebugConsoleOutput([]);
      debugSequencingRef.current = { step: "idle" };
      setShowDebug(false);
      showToast("Debugger stopped", "info");
    } catch (err) {
      showToast(`Failed to stop debugger: ${err}`, "error");
      console.error("Stop debugger error:", err);
    }
  }, [debugSessionId, showToast]);

  const handleToggleBreakpoint = useCallback((path: string, line: number) => {
    setBreakpoints(prev => {
      const newBreakpoints = { ...prev };
      const fileBreakpoints = newBreakpoints[path] || [];
      if (fileBreakpoints.includes(line)) {
        newBreakpoints[path] = fileBreakpoints.filter(l => l !== line);
      } else {
        newBreakpoints[path] = [...fileBreakpoints, line].sort((a, b) => a - b);
      }
      // If debugger is active, sync breakpoints with adapter
      if (debugSessionId) {
        sendDapRequest("setBreakpoints", {
          source: { path },
          breakpoints: (newBreakpoints[path] || []).map(l => ({ line: l })),
        });
      }
      return newBreakpoints;
    });
  }, [debugSessionId, sendDapRequest]);

  const handleDebugContinue = useCallback(() => { sendDapRequest("continue", { threadId: currentThreadId }); }, [sendDapRequest, currentThreadId]);
  const handleDebugStepOver = useCallback(() => { sendDapRequest("next", { threadId: currentThreadId }); }, [sendDapRequest, currentThreadId]);
  const handleDebugStepInto = useCallback(() => { sendDapRequest("stepIn", { threadId: currentThreadId }); }, [sendDapRequest, currentThreadId]);
  const handleDebugStepOut = useCallback(() => { sendDapRequest("stepOut", { threadId: currentThreadId }); }, [sendDapRequest, currentThreadId]);
  const handleDebugPause = useCallback(() => { sendDapRequest("pause", { threadId: currentThreadId }); }, [sendDapRequest, currentThreadId]);
  const handleDebuggerJumpToSource = useCallback(async (path: string, line: number) => {
    await handleFileSelectRef.current(path);
    setEditorLine(line);
  }, []);

  // ─── Debug Config Handlers ──────────────────────────────────────────────────

  const handleAddDebugConfig = useCallback(async () => {
    if (!projectPath) return;
    const newConfig = getDefaultConfig();
    const updated = [...debugLaunchConfigs, newConfig];
    setDebugLaunchConfigs(updated);
    setSelectedDebugConfigId(newConfig.id);
    await saveLaunchConfigs(projectPath, updated);
    showToast("New debug configuration added", "success");
    // Open the launch.json file for editing
    handleEditLaunchJson();
  }, [projectPath, debugLaunchConfigs, showToast]);

  const handleEditLaunchJson = useCallback(async () => {
    if (!projectPath) return;
    const sep = projectPath.includes("\\") ? "\\" : "/";
    const launchJsonPath = `${projectPath}${sep}.punam${sep}launch.json`;

    // Create default if it doesn't exist
    const exists = await pathExists(launchJsonPath);
    if (!exists) {
      await createDefaultLaunchJson(projectPath, "node");
      const configs = await loadLaunchConfigs(projectPath);
      setDebugLaunchConfigs(configs);
      if (configs.length > 0) setSelectedDebugConfigId(configs[0].id);
    }

    // Open the file in the editor
    await handleFileSelectRef.current(launchJsonPath);
  }, [projectPath]);


  // Load config on mount from secure store
  useEffect(() => {
    loadConfigFromStore().then((storedConfig) => {
      setConfig(storedConfig);
      const fallbackTheme = getDefaultTheme(storedConfig.theme === "light" ? "light" : "dark");
      applyTheme(fallbackTheme);
    }).catch(() => {});
    loadAIProviders().then(setAiProviders).catch(() => {});
    loadInlineCompletionEnabled().then(setInlineCompletionEnabled).catch(() => {});
    import("./utils/tauri").then(({ loadMcpServers }) => loadMcpServers().then(setMcpServers).catch(() => {}));
    loadRecentProjects().then(setRecentProjects).catch(() => {});
    // Load and apply saved theme
    Promise.all([loadActiveThemeId(), loadCustomThemes()]).then(([themeId, customThemes]) => {
      const theme = themeId
        ? getThemeById(themeId, customThemes) || getDefaultTheme("dark", customThemes)
        : getDefaultTheme("dark", customThemes);
      applyTheme(theme);
      setConfig((prev) => ({ ...prev, theme: theme.type }));
      if (!themeId || theme.id !== themeId) {
        saveActiveThemeId(theme.id).catch(() => {});
      }
    }).catch(() => {});
  }, []);

  useEffect(() => {
    let cancelled = false;

    const restoreRecentProject = async () => {
      try {
        const recentPath = await loadRecentProjectPath();
        if (!recentPath || cancelled) return;

        // Set path first to trigger loading state, then do heavy IPC
        if (!cancelled) {
          setProjectPath(recentPath);
          setTabs([]);
          setActiveTab("");
        }

        // Defer the heavy Rust IPC to allow the loading UI to paint
        requestAnimationFrame(() => {
          if (!cancelled) {
            setProjectRoot(recentPath).catch((err) => {
              console.error("Failed to set project root:", err);
            });
          }
        });
      } catch (err) {
        console.error("Failed to restore recent project:", err);
        await clearRecentProjectPath().catch(() => {});
      }
    };

    restoreRecentProject();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => setShowSplash(false), 3500);
    return () => window.clearTimeout(timer);
  }, []);

  // Refresh file tree
  const [filesLoading, setFilesLoading] = useState(false);
  const refreshFiles = useCallback(async () => {
    if (!projectPath) return;
    setFilesLoading(true);

    // Allow the loading indicator to paint before firing the heavy IPC call.
    // readDirectory scans up to 4 levels deep on the Rust side — can take seconds for large projects.
    await new Promise((r) => requestAnimationFrame(r));

    try {
      const entries = await readDirectory(projectPath);
      setFiles(entries);
    } catch (err) {
      console.error("Failed to read directory:", err);
      showToast(`Failed to load files: ${err}`, "error");
    } finally {
      setFilesLoading(false);
    }
  }, [projectPath, showToast]);

  // Detect git branch when project changes
  useEffect(() => {
    if (!projectPath) { setGitBranch(""); return; }
    runTerminalCommand("git branch --show-current", projectPath)
      .then((r) => setGitBranch(r.exit_code === 0 ? r.stdout.trim() : ""))
      .catch(() => setGitBranch(""));
  }, [projectPath]);

  // LSP: Stop all servers when project changes, cleanup on unmount
  useEffect(() => {
    if (!projectPath) return;

    // When project changes, stop previous servers (lspManager handles fresh start)
    lspManager.stopAll().catch(() => {});
    lspManager.setProjectPath(projectPath);

    return () => {
      lspManager.stopAll().catch(() => {});
    };
  }, [projectPath]);

  // Load notes when project changes
  useEffect(() => {
    if (!projectPath) return;
    setProjectNotes(loadNotes(projectPath));
  }, [projectPath]);

  useEffect(() => {
    refreshFiles();
  }, [refreshFiles]);

  // Start file watcher when project opens, auto-refresh on external changes
  const appEventStateRef = useRef({
    refreshFiles,
    getProjectFilePath,
    showToast,
    fetchStackFrames,
    fetchScopes,
    fetchVariables,
    breakpoints,
    projectPath,
  });
  appEventStateRef.current = {
    refreshFiles,
    getProjectFilePath,
    showToast,
    fetchStackFrames,
    fetchScopes,
    fetchVariables,
    breakpoints,
    projectPath,
  };

  useEffect(() => {
    if (!projectPath) return;

    let cancelled = false;
    const unlisteners: Array<() => void> = [];
    const registerListener = async <T,>(
      eventName: string,
      handler: (event: { payload: T }) => void,
    ) => {
      try {
        const unlisten = await listen<T>(eventName, handler);
        if (cancelled) {
          unlisten();
        } else {
          unlisteners.push(unlisten);
        }
      } catch (err) {
        if (!cancelled) console.warn(`Failed to register ${eventName} listener:`, err);
      }
    };

    const startWatcher = async () => {
      try {
        await watchProject(projectPath);
      } catch (err) {
        console.error("Failed to start file watcher:", err);
      }
    };

    startWatcher();

    // Debounce file tree refresh — prevents refresh storm from git checkout / bulk operations
    let fsRefreshTimer: ReturnType<typeof setTimeout> | null = null;

    void registerListener<{ paths: string[]; kind: string }>("fs-changed", async (event) => {
      if (cancelled) return;
      const { refreshFiles, getProjectFilePath } = appEventStateRef.current;

      // Debounced refresh — coalesces rapid file change events into one tree scan
      if (fsRefreshTimer !== null) clearTimeout(fsRefreshTimer);
      fsRefreshTimer = setTimeout(() => {
        fsRefreshTimer = null;
        refreshFiles();
      }, 500);

      // Update Rust project index cache for changed files
      const changedPaths = event.payload.paths;
      for (const p of changedPaths) {
        updateFileIndex(p).catch(() => {});
      }

      // Reload open tabs whose files changed externally
      const tabsSnapshot = tabsRef.current;
      if (!tabsSnapshot) return;

      for (const changedPath of changedPaths) {
        const normalizedChanged = normalizeFsPath(
          isAbsolutePath(changedPath) ? changedPath : getProjectFilePath(changedPath)
        );

        const matchingTab = tabsSnapshot.find((tab) => normalizeFsPath(tab.path) === normalizedChanged);
        if (!matchingTab || matchingTab.modified) continue;

        try {
          const newContent = await readFile(matchingTab.path);
          if (newContent !== matchingTab.content) {
            setTabs((prev) =>
              prev.map((t) =>
                t.id === matchingTab.id ? { ...t, content: newContent } : t
              )
            );
          }
        } catch {
          // File read error — ignore silently
        }
      }
    });

    // Listen for debugger events from Rust backend
    void registerListener<{ session_id: string; event_type: string; payload: any }>("debugger-event", (event) => {
      if (cancelled) return;
      const {
        showToast,
        fetchStackFrames,
        fetchScopes,
        fetchVariables,
        breakpoints,
        projectPath,
      } = appEventStateRef.current;
      const { event_type, payload } = event.payload;
      console.log("[DEBUG] DAP Event:", event_type, payload);

      // Check for failed responses (DAP error responses)
      if (event_type.startsWith("response_") && payload?.success === false) {
        const errMsg = payload?.message || payload?.body?.error?.format || "Unknown error";
        console.error(`[DEBUG] DAP request failed: ${event_type} — ${errMsg}`);
        setDebugConsoleOutput(prev => [...prev, `[DAP Error] ${event_type.replace("response_", "")}: ${errMsg}`]);

        // Special handling for critical failures
        if (event_type === "response_launch" || event_type === "response_attach") {
          showToast(`Debug ${event_type.replace("response_", "")} failed: ${errMsg}`, "error");
          setDebugAdapterStatus("stopped");
          debugSequencingRef.current = { step: "idle" };
          return;
        }
      }

      switch (event_type) {
        case "stopped": {
          setDebugAdapterStatus("paused");
          const threadId = payload?.body?.threadId ?? payload?.threadId ?? 1;
          const reason = payload?.body?.reason ?? "unknown";
          setCurrentThreadId(threadId);
          setDebugConsoleOutput(prev => [...prev, `[PunamIDE] Paused: ${reason} (thread ${threadId})`]);
          console.log(`[DEBUG] Stopped: reason=${reason}, threadId=${threadId}`);
          fetchStackFrames(threadId);
          break;
        }
        case "response_initialize": {
          // DAP handshake: we received the initialize response (capabilities).
          console.log("[DEBUG] Received initialize response — proceeding with handshake");
          setDebugConsoleOutput(prev => [...prev, `[PunamIDE] Initialize response received. Proceeding...`]);
          // DAP handshake step 2: adapter is ready
          console.log("[DEBUG] Adapter initialized — sending breakpoints + configurationDone + launch/attach");
          // Clear the init timeout
          if ((debugSequencingRef.current as any)?._initTimeout) {
            clearTimeout((debugSequencingRef.current as any)._initTimeout);
          }
          setDebugConsoleOutput(prev => [...prev, `[PunamIDE] Adapter ready. Configuring...`]);

          if (debugSequencingRef.current.step === "initializing") {
            debugSequencingRef.current.step = "initialized";

            // Send breakpoints for all files that have them
            const bpCount = Object.values(breakpoints).reduce((sum, lines) => sum + lines.length, 0);
            for (const [filePath, lines] of Object.entries(breakpoints)) {
              if (lines.length > 0) {
                sendDapRequestRaw("setBreakpoints", {
                  source: { path: filePath },
                  breakpoints: lines.map(l => ({ line: l })),
                });
              }
            }
            if (bpCount > 0) {
              setDebugConsoleOutput(prev => [...prev, `[PunamIDE] Sent ${bpCount} breakpoint(s)`]);
            }

            // Signal that configuration is done
            sendDapRequestRaw("configurationDone", {});

            // Send launch or attach request based on config
            const config = debugSequencingRef.current.config;
            debugSequencingRef.current.step = "launching";

            if (config?.request === "attach") {
              setDebugConsoleOutput(prev => [...prev, `[PunamIDE] Attaching to ${config.host || "127.0.0.1"}:${config.port}...`]);
              sendDapRequestRaw("attach", {
                ...(config.host ? { host: config.host } : {}),
                ...(config.port ? { port: config.port } : {}),
                ...(config.launchArgs || {}),
              });
            } else {
              setDebugConsoleOutput(prev => [...prev, `[PunamIDE] Launching: ${config?.program || "unknown"}`]);
              sendDapRequestRaw("launch", {
                noDebug: false,
                program: config?.program || projectPath + "/index.js",
                args: config?.args || [],
                cwd: config?.cwd || projectPath,
                env: config?.env || {},
                stopOnEntry: config?.stopOnEntry || false,
                ...(config?.launchArgs || {}),
              });
            }

            debugSequencingRef.current.step = "ready";
          }
          break;
        }
        case "initialized": {
          // DAP handshake step 2: adapter is ready
          console.log("[DEBUG] Adapter initialized — sending breakpoints + configurationDone + launch/attach");
          // Clear the init timeout
          if ((debugSequencingRef.current as any)?._initTimeout) {
            clearTimeout((debugSequencingRef.current as any)._initTimeout);
          }
          setDebugConsoleOutput(prev => [...prev, `[PunamIDE] Adapter ready. Configuring...`]);

          if (debugSequencingRef.current.step === "initializing") {
            debugSequencingRef.current.step = "initialized";

            // Send breakpoints for all files that have them
            const bpCount2 = Object.values(breakpoints).reduce((sum, lines) => sum + lines.length, 0);
            for (const [filePath, lines] of Object.entries(breakpoints)) {
              if (lines.length > 0) {
                sendDapRequestRaw("setBreakpoints", {
                  source: { path: filePath },
                  breakpoints: lines.map(l => ({ line: l })),
                });
              }
            }
            if (bpCount2 > 0) {
              setDebugConsoleOutput(prev => [...prev, `[PunamIDE] Sent ${bpCount2} breakpoint(s)`]);
            }

            // Signal that configuration is done
            sendDapRequestRaw("configurationDone", {});

            // Send launch or attach request based on config
            const config = debugSequencingRef.current.config;
            debugSequencingRef.current.step = "launching";

            if (config?.request === "attach") {
              setDebugConsoleOutput(prev => [...prev, `[PunamIDE] Attaching to ${config.host || "127.0.0.1"}:${config.port}...`]);
              sendDapRequestRaw("attach", {
                ...(config.host ? { host: config.host } : {}),
                ...(config.port ? { port: config.port } : {}),
                ...(config.launchArgs || {}),
              });
            } else {
              setDebugConsoleOutput(prev => [...prev, `[PunamIDE] Launching: ${config?.program || "unknown"}`]);
              sendDapRequestRaw("launch", {
                noDebug: false,
                program: config?.program || projectPath + "/index.js",
                args: config?.args || [],
                cwd: config?.cwd || projectPath,
                env: config?.env || {},
                stopOnEntry: config?.stopOnEntry || false,
                ...(config?.launchArgs || {}),
              });
            }

            debugSequencingRef.current.step = "ready";
          }
          break;
        }
        case "continued":
          setDebugAdapterStatus("running");
          setCurrentSource(null);
          break;
        case "exited":
        case "terminated": {
          const exitCode = payload?.body?.exitCode;
          setDebugAdapterStatus("stopped");
          setDebugSessionId(null);
          setCurrentThreadId(null);
          setCurrentStackFrames([]);
          setCurrentVariables([]);
          setCurrentSource(null);
          debugSequencingRef.current = { step: "idle" };
          const msg = exitCode != null ? `Program exited with code ${exitCode}` : "Debug session ended";
          setDebugConsoleOutput(prev => [...prev, `[PunamIDE] ${msg}`]);
          showToast(msg, exitCode === 0 || exitCode == null ? "info" : "warning");
          break;
        }
        case "output": {
          const outputText = payload?.body?.output ?? payload?.output ?? "";
          const category = payload?.body?.category ?? "console";
          if (outputText) {
            const prefix = category === "stderr" ? "[stderr] " : "";
            setDebugConsoleOutput(prev => [...prev, `${prefix}${outputText}`]);
          }
          break;
        }
        case "breakpoint":
          // Breakpoint verified/changed event
          console.log("[DEBUG] Breakpoint event:", payload?.body);
          break;

        // Handle DAP responses
        case "response_stackTrace": {
          const body = payload?.body;
          if (body?.stackFrames) {
            setCurrentStackFrames(body.stackFrames);
            const topFrame = body.stackFrames[0];
            if (topFrame?.source?.path && topFrame?.line) {
              setCurrentSource({ path: topFrame.source.path, line: topFrame.line });
            }
            if (topFrame?.id != null) {
              fetchScopes(topFrame.id);
            }
          }
          break;
        }
        case "response_scopes": {
          const body = payload?.body;
          if (body?.scopes && body.scopes.length > 0) {
            const localScope = body.scopes.find((s: any) => s.name === "Locals") || body.scopes[0];
            if (localScope?.variablesReference) {
              fetchVariables(localScope.variablesReference);
            }
          }
          break;
        }
        case "response_variables": {
          const body = payload?.body;
          if (body?.variables) {
            setCurrentVariables(body.variables);
          }
          break;
        }
        case "response_evaluate": {
          const body = payload?.body;
          if (body?.result) {
            setDebugConsoleOutput(prev => [...prev, `→ ${body.result}`]);
          } else if (payload?.message) {
            setDebugConsoleOutput(prev => [...prev, `⚠ ${payload.message}`]);
          }
          break;
        }
        case "response_launch":
        case "response_attach":
          if (payload?.success !== false) {
            setDebugAdapterStatus("running");
            setDebugConsoleOutput(prev => [...prev, `[PunamIDE] ✓ ${event_type === "response_attach" ? "Attached" : "Launched"} successfully`]);
          }
          // Error case handled by the generic error check above
          break;
        default:
          // Log unhandled events for debugging
          if (event_type && !event_type.startsWith("response_")) {
            console.log("[DEBUG] Unhandled DAP event:", event_type);
          }
          break;
      }
    });

    // Listen for adapter stderr output (crash logs, warnings)
    void registerListener<{ session_id: string; event_type: string; payload: any }>("debugger-stderr", (event) => {
      if (cancelled) return;
      const output = event.payload?.payload?.output || "";
      if (output.trim()) {
        console.warn("[DEBUG] Adapter stderr:", output);
        setDebugConsoleOutput(prev => [...prev, `[adapter] ${output.trim()}`]);
      }
    });

    return () => {
      cancelled = true;
      for (const unlisten of unlisteners.splice(0)) unlisten();
    };
  }, [projectPath]);

  const getRootFileNames = useCallback(() => new Set(files.map((file) => file.name)), [files]);

  const detectRunProfiles = useCallback((): RunProfile[] => {
    const rootFiles = getRootFileNames();
    const profiles: RunProfile[] = [];

    if (rootFiles.has("package.json")) {
      profiles.push(
        { id: "dev", name: "Dev", command: "npm run dev" },
        { id: "build", name: "Build", command: "npm run build" },
        { id: "test", name: "Test", command: "npm test" },
        { id: "lint", name: "Lint", command: "npm run lint" }
      );
    } else if (rootFiles.has("Cargo.toml")) {
      profiles.push(
        { id: "dev", name: "Dev", command: "cargo run" },
        { id: "build", name: "Build", command: "cargo build" },
        { id: "test", name: "Test", command: "cargo test" },
        { id: "lint", name: "Check", command: "cargo check" }
      );
    } else if (rootFiles.has("pyproject.toml") || rootFiles.has("pytest.ini")) {
      profiles.push(
        { id: "test", name: "Test", command: "python -m pytest" },
        { id: "lint", name: "Lint", command: "python -m ruff check ." }
      );
    } else if (rootFiles.has("go.mod")) {
      profiles.push(
        { id: "dev", name: "Dev", command: "go run ." },
        { id: "build", name: "Build", command: "go build ./..." },
        { id: "test", name: "Test", command: "go test ./..." }
      );
    }

    return profiles;
  }, [getRootFileNames]);

  useEffect(() => {
    if (!projectPath) {
      setRunProfiles([]);
      return;
    }

    let cancelled = false;
    const loadProfiles = async () => {
      const savedProfiles = await loadRunProfiles(projectPath);
      if (!cancelled) {
        setRunProfiles(savedProfiles || detectRunProfiles());
      }
    };

    loadProfiles();
    return () => {
      cancelled = true;
    };
  }, [projectPath, detectRunProfiles]);

  // Load debug launch configurations from .punam/launch.json
  // If none exist, auto-detect project type and generate suggested configs
  useEffect(() => {
    if (!projectPath) {
      setDebugLaunchConfigs([]);
      setSelectedDebugConfigId(null);
      return;
    }

    let cancelled = false;
    const loadConfigs = async () => {
      let configs = await loadLaunchConfigs(projectPath);

      // If no configs exist, try smart detection
      if (configs.length === 0 && files.length > 0) {
        const rootFileNames = files.map(f => f.name);
        const detected = detectProjectType(rootFileNames);
        if (detected.length > 0) {
          // Auto-generate launch.json with detected configs
          configs = await autoGenerateLaunchJson(projectPath, rootFileNames);
        }
      }

      if (!cancelled) {
        setDebugLaunchConfigs(configs);
        // Auto-select first config if none selected
        if (configs.length > 0 && !selectedDebugConfigId) {
          setSelectedDebugConfigId(configs[0].id);
        }
      }
    };

    loadConfigs();
    return () => { cancelled = true; };
  }, [projectPath, files]);

  // Open folder
  const handleOpenFolder = async () => {
    try {
      if (!(await confirmDiscardModifiedTabs())) return;

      const selected = await open({ directory: true, multiple: false });
      if (selected) {
        const dir = selected as string;

        // Reset UI state immediately so the user sees instant feedback
        setTabs([]);
        setActiveTab("");
        setProblems([]);
        setTerminalOutput("");
        setProactiveError(null);
        setRunObservation(null);
        setShowSearch(false);
        setShowGitPanel(false);
        setGitRefreshKey((key) => key + 1);

        // Set project path first — this triggers the file tree loading indicator
        setProjectPath(dir);
        setRecentProjects(prev => [{ path: dir, openedAt: Date.now() }, ...prev.filter(p => p.path !== dir)].slice(0, 8));

        // Defer heavy IPC calls to next frame so the loading UI can paint
        requestAnimationFrame(() => {
          setProjectRoot(dir).catch(() => {});
          saveRecentProjectPath(dir).catch(() => {});
          addRecentProject(dir).catch(() => {});
        });

        // Note: refreshProjectIndex is already triggered inside setProjectRoot's
        // background pipeline (symbol_rebuild → callgraph_build → index_codebase).
      }
    } catch (err) {
      showToast(`Failed to open folder: ${err}`, "error");
    }
  };

  // Open individual file(s) via file picker dialog
  const handleOpenFile = async () => {
    try {
      const selected = await open({
        directory: false,
        multiple: true,
        filters: [
          { name: "All Files", extensions: ["*"] },
          { name: "Code", extensions: ["ts", "tsx", "js", "jsx", "py", "rs", "go", "java", "c", "cpp", "h", "css", "html", "json", "md", "yaml", "yml", "toml"] },
        ],
      });
      if (selected) {
        const paths = Array.isArray(selected) ? selected : [selected];
        for (const filePath of paths) {
          await handleFileSelect(filePath as string);
        }
      }
    } catch (err) {
      showToast(`Failed to open file: ${err}`, "error");
    }
  };

  // Open file in tab
  const handleFileSelect = async (path: string) => {
    const normalizedPath = normalizeFsPath(path);
    const existing = tabs.find((t) => normalizeFsPath(t.path) === normalizedPath);
    if (existing) {
      setActiveTab(existing.id);
      return;
    }

    try {
      const content = await readFile(path);
      const name = path.split(/[\\/]/).pop() || path;
      const tab: Tab = {
        id: `tab-${Date.now()}`,
        path,
        name,
        content,
        modified: false,
      };
      setTabs((prev) => [...prev, tab]);
      setActiveTab(tab.id);
      // Track recent paths for Ctrl+P
      const rel = normalizeFsPath(path).replace(normalizeFsPath(projectPath) + "/", "");
      setRecentPaths((prev) => [rel, ...prev.filter((p) => p !== rel)].slice(0, 20));
    } catch (err) {
      const fileName = path.split(/[\\/]/).pop() || path;
      showToast(`Failed to open "${fileName}": ${err}`, "error");
    }
  };

  const handleSearchResultOpen = async (result: SearchResult) => {
    const fullPath = getProjectFilePath(result.path);
    await handleFileSelect(fullPath);
    setEditorLine(result.line);
  };

  // Keep ref in sync for callbacks defined before handleFileSelect
  handleFileSelectRef.current = handleFileSelect;

  const handleGitFileOpen = async (relativePath: string) => {
    await handleFileSelect(getProjectFilePath(relativePath));
  };

  const handleProblemOpen = async (problem: Problem) => {
    const fullPath = /^[A-Za-z]:[\\/]/.test(problem.path) || problem.path.startsWith("/")
      ? problem.path
      : getProjectFilePath(problem.path);
    await handleFileSelect(fullPath);
    setEditorLine(problem.line);
  };

  // Close tab
  const [confirmDialog, setConfirmDialog] = useState<{
    message: string;
    resolve: (action: "save" | "discard" | "cancel") => void;
  } | null>(null);

  const askUnsavedAction = (message: string): Promise<"save" | "discard" | "cancel"> => {
    return new Promise((resolve) => {
      setConfirmDialog({ message, resolve });
    });
  };

  const closePendingConfirm = (action: "save" | "discard" | "cancel") => {
    if (confirmDialog) {
      confirmDialog.resolve(action);
      setConfirmDialog(null);
    }
  };

  const confirmDiscardModifiedTabs = useCallback(async () => {
    const modifiedTabs = tabs.filter((tab) => tab.modified);
    if (modifiedTabs.length === 0) return true;

    const action = await askUnsavedAction(`${modifiedTabs.length} file(s) have unsaved changes.`);
    if (action === "cancel") return false;
    if (action === "discard") return true;

    try {
      for (const tab of modifiedTabs) {
        await writeFile(tab.path, tab.content);
      }
      setTabs((prev) => prev.map((tab) => ({ ...tab, modified: false })));
      setGitRefreshKey((key) => key + 1);
      return true;
    } catch (err) {
      showToast(`Failed to save changes: ${err}`, "error");
      return false;
    }
  }, [tabs]);

  const handleTabClose = async (id: string) => {
    const tab = tabs.find((item) => item.id === id);
    if (tab?.modified) {
      const action = await askUnsavedAction(`"${tab.name}" has unsaved changes.`);
      if (action === "cancel") return;

      if (action === "save") {
        try {
          await writeFile(tab.path, tab.content);
        } catch (err) {
          showToast(`Failed to save "${tab.name}": ${err}`, "error");
          return;
        }
      }
    }

    setTabs((prev) => {
      const filtered = prev.filter((t) => t.id !== id);
      if (id === activeTabRef.current && filtered.length > 0) {
        setActiveTab(filtered[filtered.length - 1].id);
      } else if (filtered.length === 0) {
        setActiveTab("");
      }
      return filtered;
    });
  };

  const activeTabRef = useRef("");
  useEffect(() => { activeTabRef.current = activeTab; });

  const handlePathDeleted = (path: string) => {
    setGitRefreshKey((key) => key + 1);
    setTabs((prev) => {
      const filtered = prev.filter((tab) => !tab.path.startsWith(path));
      if (activeTab && !filtered.some((tab) => tab.id === activeTab)) {
        setActiveTab(filtered[filtered.length - 1]?.id || "");
      }
      return filtered;
    });
  };

  const confirmPathOperation = async (path: string, action: string) => {
    const modifiedMatches = tabs.filter(
      (tab) => tab.modified && (tab.path === path || tab.path.startsWith(`${path}\\`) || tab.path.startsWith(`${path}/`))
    );

    if (modifiedMatches.length === 0) return true;

    const choice = await askUnsavedAction(
      `${modifiedMatches.length} open file(s) under this path have unsaved changes before ${action}.`
    );
    if (choice === "cancel") return false;
    if (choice === "discard") return true;

    try {
      for (const tab of modifiedMatches) {
        await writeFile(tab.path, tab.content);
      }
      setTabs((prev) =>
        prev.map((tab) =>
          modifiedMatches.some((match) => match.path === tab.path)
            ? { ...tab, modified: false }
            : tab
        )
      );
      return true;
    } catch (err) {
      showToast(`Failed to save before ${action}: ${err}`, "error");
      return false;
    }
  };

  const handlePathRenamed = (oldPath: string, newPath: string) => {
    setGitRefreshKey((key) => key + 1);
    setTabs((prev) =>
      prev.map((tab) =>
        tab.path.startsWith(oldPath)
          ? {
              ...tab,
              path: `${newPath}${tab.path.slice(oldPath.length)}`,
              name: tab.path === oldPath ? newPath.split(/[\\/]/).pop() || tab.name : tab.name,
            }
          : tab
      )
    );
  };

  // Update tab content — optimized to avoid full array scan on every keystroke
  const handleContentChange = useCallback((value: string) => {
    setTabs((prev) => {
      const idx = prev.findIndex((t) => t.id === activeTab);
      if (idx === -1) return prev;
      const tab = prev[idx];
      if (tab.content === value) return prev; // no-op guard
      const updated = [...prev];
      updated[idx] = { ...tab, content: value, modified: true };
      return updated;
    });
  }, [activeTab]);

  const handleSaveTab = useCallback(async (tabId: string) => {
    const tab = tabs.find((t) => t.id === tabId) || rightTabs.find((t) => t.id === tabId);
    if (!tab) return;

    try {
      await writeFile(tab.path, tab.content);
      setGitRefreshKey((key) => key + 1);
      setTabs((prev) =>
        prev.map((t) =>
          t.id === tabId ? { ...t, modified: false } : t
        )
      );
      setRightTabs((prev) =>
        prev.map((t) =>
          t.id === tabId ? { ...t, modified: false } : t
        )
      );
      showToast(`Saved ${tab.name}`, "success");
    } catch (err) {
      console.error("Failed to save:", err);
      showToast(`Failed to save ${tab.name}`, "error");
    }
  }, [tabs, rightTabs, showToast]);

  const handleSaveActiveFile = useCallback(async () => {
    await handleSaveTab(activeTab);
  }, [activeTab, handleSaveTab]);

  // ── Auto-save: periodically save modified files ────────────────────────────
  const handleAutoSaveTab = useCallback((tabId: string) => {
    setTabs((prev) => prev.map((t) => t.id === tabId ? { ...t, modified: false } : t));
  }, []);

  useAutoSave({
    enabled: true, // Always auto-save — user's work is too important to lose
    delay: 2000,   // Save 2 seconds after last edit
    tabs,
    onTabSaved: handleAutoSaveTab,
  });

  // ── Auto AST re-indexing on file save ──────────────────────────────────────
  // Subscribes to editor save events and incrementally rebuilds the symbol index
  // and call graph for the saved file so AI context stays current.
  useAutoReindex();

  // ── Proactive error detection on recent edits ──────────────────────────────
  // Captures diagnostic baselines on file open/first edit, then on each save
  // compares against baseline and notifies about newly introduced errors.
  useProactiveErrors({ tabs });

  // ── Context sidebar wiring ─────────────────────────────────────────────────
  // Subscribes to cursor-move, file-change, and lsp-diagnostics events to keep
  // the ContextSidebarModel up-to-date with callers, callees, and diagnostics.
  useContextSidebar();

  // ── Agent-assisted debugging bridge ────────────────────────────────────────
  // Initializes the DAP event listener once on startup so breakpoint hits trigger
  // AI analysis in the Debugger panel's "AI Analysis" tab. Torn down on unmount.
  useEffect(() => {
    const bridge = DapBridge.getInstance();
    bridge.init().catch((err) => {
      console.warn("[DapBridge] Failed to initialize debugger event listener:", err);
    });
    return () => {
      bridge.destroy().catch(() => {});
    };
  }, []);

  // ── Inline diff preview for AI edits ───────────────────────────────────────
  const inlineDiff = useInlineDiff();

  // ── Save-on-exit: intercept window close and save all modified files ───────
  useEffect(() => {
    let unlistenClose: (() => void) | null = null;
    let cancelled = false;

    // Use Tauri's onCloseRequested to intercept window close
    const setupCloseHandler = async () => {
      try {
        const { getCurrentWindow } = await import("@tauri-apps/api/window");
        const appWindow = getCurrentWindow();

        const registeredUnlisten = await appWindow.onCloseRequested(async (event) => {
          event.preventDefault();

          if (isClosingRef.current) return;
          isClosingRef.current = true;

          const modifiedTabs = tabsRef.current.filter((t) => t.modified);
          if (modifiedTabs.length > 0) {

            // Save with a timeout — don't let a stuck save prevent closing
            try {
              const savePromises = modifiedTabs.map((tab) => writeFile(tab.path, tab.content));
              await Promise.race([
                Promise.allSettled(savePromises),
                new Promise((resolve) => setTimeout(resolve, 3000)), // 3s timeout
              ]);
              console.log(`[AutoSave] Saved ${modifiedTabs.length} file(s) on exit`);
            } catch (err) {
              console.error("[AutoSave] Failed to save on exit:", err);
            }

          }

          // Ask the backend to exit so native cleanup runs even if webview close is blocked.
          try {
            const { invoke } = await import("@tauri-apps/api/core");
            await invoke("request_app_exit");
          } catch (err) {
            console.error("[AutoSave] Backend exit failed; destroying window:", err);
            await appWindow.destroy();
          }
        });
        if (cancelled) {
          registeredUnlisten();
        } else {
          unlistenClose = registeredUnlisten;
        }
      } catch {
        // Not in Tauri environment (dev mode in browser) — use beforeunload
      }
    };

    setupCloseHandler();

    // Web fallback: beforeunload (for dev mode / browser preview)
    const handleBeforeUnload = (e: BeforeUnloadEvent) => {
      const modifiedTabs = tabsRef.current.filter((t) => t.modified);
      if (modifiedTabs.length > 0) {
        // Trigger async saves (best effort)
        for (const tab of modifiedTabs) {
          writeFile(tab.path, tab.content).catch(() => {});
        }
        // Show browser's "unsaved changes" dialog
        e.preventDefault();
        e.returnValue = "";
      }
    };

    window.addEventListener("beforeunload", handleBeforeUnload);

    return () => {
      cancelled = true;
      if (unlistenClose) unlistenClose();
      window.removeEventListener("beforeunload", handleBeforeUnload);
    };
  }, []);

  const detectProjectCheckCommand = useCallback(() => {
    return (
      runProfiles.find((profile) => /build|check|test/i.test(profile.name))?.command ||
      runProfiles[0]?.command ||
      ""
    );
  }, [runProfiles]);

  const runProfile = useCallback(async (profile: RunProfile) => {
    if (!projectPath || runningProjectCheck || !profile.command.trim()) return;

      setShowAiPanel(true);
      setShowTerminal(true);
    setBottomPanelActive("terminal");
    setRunningProjectCheck(true);

    try {
      const result = await runTerminalCommand(profile.command, projectPath);
      const output = `${result.stdout}${result.stderr ? `\n${result.stderr}` : ""}`;
      const detectedProblems = parseProblemsFromOutput(output, profile.name, projectPath);
      setProblems(detectedProblems);
      if (result.exit_code !== 0 || detectedProblems.length > 0) {
        setShowProblems(true);
        setBottomPanelActive("problems");
      }
      setProjectCheckResult({
        id: Date.now(),
        command: profile.command,
        stdout: result.stdout,
        stderr: result.stderr,
        exitCode: result.exit_code,
      });
    } catch (err) {
      setProblems([]);
      setShowProblems(true);
      setBottomPanelActive("problems");
      setProjectCheckResult({
        id: Date.now(),
        command: profile.command,
        stdout: "",
        stderr: `Failed to run profile "${profile.name}": ${err}`,
        exitCode: -1,
      });
    } finally {
      setRunningProjectCheck(false);
    }
  }, [projectPath, runningProjectCheck]);

  const handleRunProjectCheck = useCallback(async () => {
    if (!projectPath || runningProjectCheck) return;

    const command = detectProjectCheckCommand();
    if (!command) {
      alert("Punam could not detect a build or test command for this project yet.");
      return;
    }

    await runProfile({ id: "project-check", name: "Project Check", command });
  }, [projectPath, runningProjectCheck, detectProjectCheckCommand, runProfile]);

  const handleSaveRunProfiles = async () => {
    if (!projectPath) return;
    try {
      const cleanedProfiles = runProfiles.filter((profile) => profile.name.trim() && profile.command.trim());
      await saveRunProfiles(projectPath, cleanedProfiles);
      setRunProfiles(cleanedProfiles);
      setShowRunProfiles(false);
    } catch (err) {
      alert(`Failed to save run profiles: ${err}`);
    }
  };

  // Use refs for values needed in keyboard handler to avoid stale closure issues
  const closePendingReviewRef = useRef<(applied: boolean) => void>(() => {});
  useEffect(() => {
    closePendingReviewRef.current = closePendingReview;
  });

  // Keyboard handler refs — keep volatile state in refs so the effect
  // registers ONCE instead of on every keystroke/tab change/debug event.
  const kbActiveTabRef = useRef(activeTab);
  const kbTabsRef = useRef(tabs);
  const kbShowCommandPaletteRef = useRef(showCommandPalette);
  const kbShowSettingsRef = useRef(showSettings);
  const kbShowRunProfilesRef = useRef(showRunProfiles);
  const kbShowShortcutsRef = useRef(showShortcuts);
  const kbDebugAdapterStatusRef = useRef(debugAdapterStatus);
  const kbZenModeRef = useRef(zenMode);
  const kbPendingReviewRef = useRef(pendingReview);
  const kbProjectPathRef = useRef(projectPath);
  const kbHandleTabCloseRef = useRef(handleTabClose);
  const kbHandleStopDebugRef = useRef(handleStopDebug);
  const kbHandleDebugStepOverRef = useRef(handleDebugStepOver);
  const kbHandleDebugStepIntoRef = useRef(handleDebugStepInto);
  const kbHandleDebugStepOutRef = useRef(handleDebugStepOut);
  const kbHandleSaveActiveFileRef = useRef(handleSaveActiveFile);
  const kbAiProvidersRef = useRef(aiProviders);
  const kbConfigRef = useRef(config);
  // Sync refs whenever state changes
  useEffect(() => { kbActiveTabRef.current = activeTab; }, [activeTab]);
  useEffect(() => { kbTabsRef.current = tabs; }, [tabs]);
  useEffect(() => { kbShowCommandPaletteRef.current = showCommandPalette; }, [showCommandPalette]);
  useEffect(() => { kbShowSettingsRef.current = showSettings; }, [showSettings]);
  useEffect(() => { kbShowRunProfilesRef.current = showRunProfiles; }, [showRunProfiles]);
  useEffect(() => { kbShowShortcutsRef.current = showShortcuts; }, [showShortcuts]);
  useEffect(() => { kbDebugAdapterStatusRef.current = debugAdapterStatus; }, [debugAdapterStatus]);
  useEffect(() => { kbZenModeRef.current = zenMode; }, [zenMode]);
  useEffect(() => { kbPendingReviewRef.current = pendingReview; }, [pendingReview]);
  useEffect(() => { kbProjectPathRef.current = projectPath; }, [projectPath]);
  useEffect(() => { kbHandleTabCloseRef.current = handleTabClose; }, [handleTabClose]);
  useEffect(() => { kbHandleStopDebugRef.current = handleStopDebug; }, [handleStopDebug]);
  useEffect(() => { kbHandleDebugStepOverRef.current = handleDebugStepOver; }, [handleDebugStepOver]);
  useEffect(() => { kbHandleDebugStepIntoRef.current = handleDebugStepInto; }, [handleDebugStepInto]);
  useEffect(() => { kbHandleDebugStepOutRef.current = handleDebugStepOut; }, [handleDebugStepOut]);
  useEffect(() => { kbHandleSaveActiveFileRef.current = handleSaveActiveFile; }, [handleSaveActiveFile]);
  useEffect(() => { kbAiProvidersRef.current = aiProviders; }, [aiProviders]);
  useEffect(() => { kbConfigRef.current = config; }, [config]);

  // Keyboard shortcuts — registered once, reads latest values via refs
  useEffect(() => {
    const handleKeyDown = async (e: KeyboardEvent) => {
      const ctrl = e.ctrlKey || e.metaKey;

      // Ctrl+Shift+P or F1 = Command Palette
      if ((ctrl && e.shiftKey && e.key.toLowerCase() === "p") || e.key === "F1") {
        e.preventDefault();
        setShowCommandPalette((visible) => !visible);
        return;
      }

      // Ctrl+Shift+F = Project Search
      if (ctrl && e.shiftKey && e.key.toLowerCase() === "f") {
        e.preventDefault();
        setShowSidebar(true);
        setShowGitPanel(false);
        setShowSearch((visible) => !visible);
        return;
      }

      // Ctrl+Shift+G = Git Panel
      if (ctrl && e.shiftKey && e.key.toLowerCase() === "g") {
        e.preventDefault();
        setShowSidebar(true);
        setShowSearch(false);
        setShowGitPanel((visible) => !visible);
        setGitRefreshKey((key) => key + 1);
        return;
      }

      // Ctrl+Shift+H = GitHub Panel
      if (ctrl && e.shiftKey && e.key.toLowerCase() === "h") {
        e.preventDefault();
        setActivityView((prev) => {
          const next = prev === "github" ? "explorer" : "github";
          setShowSidebar(true);
          return next;
        });
        return;
      }

      // Ctrl+Shift+O = Open File
      if (ctrl && e.shiftKey && e.key.toLowerCase() === "o") {
        e.preventDefault();
        handleOpenFile();
        return;
      }

      // Ctrl+Shift+D = Generate Documentation (DocGenerator)
      if (ctrl && e.shiftKey && e.key.toLowerCase() === "d") {
        e.preventDefault();

        // Get active tab from refs
        const tb = kbTabsRef.current;
        const at = kbActiveTabRef.current;
        const tab = tb.find((t) => t.id === at);
        if (!tab) return;

        // Determine if language is supported by DocGenerator
        const lang = getLanguage(tab.name);
        const supportedLangs: Record<string, DocTarget["language"]> = {
          typescript: "typescript",
          javascript: "javascript",
          python: "python",
          rust: "rust",
        };
        const docLang = supportedLangs[lang];
        if (!docLang) return; // Only supported languages

        // Get AI provider config
        const providers = kbAiProvidersRef.current;
        const cfg = kbConfigRef.current;
        const activeProvider = providers.find((p) => p.apiKey || p.name === "Ollama (Local)");
        if (!activeProvider) return; // No AI provider configured

        const modelId = cfg.model || activeProvider.models.find((m) => m.enabled)?.id || "";
        if (!modelId) return;

        // Get cursor position and selection from editorStore
        const editorState = useEditorStore.getState();
        const cursorPos = editorState.cursorPosition;
        const selText = editorState.selectedText;

        // Build DocTarget
        const lines = tab.content.split("\n");
        let selection: DocTarget["selection"] | undefined;
        if (selText) {
          // Find the selection range from cursor position
          const startLine = cursorPos.line;
          const selLines = selText.split("\n");
          const endLine = startLine + selLines.length - 1;
          selection = { startLine, endLine, text: selText };
        }

        // Detect existing doc block preceding the selection/cursor
        let existingDoc: DocTarget["existingDoc"] | undefined;
        const targetLine = selection ? selection.startLine : cursorPos.line;
        if (targetLine > 1) {
          // Look for a doc comment block ending just above the target line
          let docEnd = targetLine - 1;
          const lineAbove = lines[docEnd - 1]?.trim() || "";
          if (lineAbove === "*/" || lineAbove.startsWith("///") || lineAbove === '"""') {
            let docStart = docEnd;
            if (lineAbove === "*/") {
              // Multi-line JSDoc/TSDoc block
              for (let i = docEnd - 1; i >= 0; i--) {
                if (lines[i].trim().startsWith("/**") || lines[i].trim().startsWith("/*")) {
                  docStart = i + 1;
                  break;
                }
              }
            } else if (lineAbove.startsWith("///")) {
              // Rustdoc line comments
              for (let i = docEnd - 1; i >= 0; i--) {
                if (!lines[i].trim().startsWith("///")) {
                  docStart = i + 2;
                  break;
                }
              }
            } else if (lineAbove === '"""') {
              // Python docstring
              for (let i = docEnd - 2; i >= 0; i--) {
                if (lines[i].trim().startsWith('"""')) {
                  docStart = i + 1;
                  break;
                }
              }
            }
            const docText = lines.slice(docStart - 1, docEnd).join("\n");
            existingDoc = { startLine: docStart, endLine: docEnd, text: docText };
          }
        }

        // Gather nearby documented symbols for style matching
        const nearbyDocs: string[] = [];
        const docBlockRegex = /\/\*\*[\s\S]*?\*\/|\/\/\/.*|"""[\s\S]*?"""/;
        for (let i = Math.max(0, targetLine - 30); i < Math.min(lines.length, targetLine + 30); i++) {
          const match = lines[i]?.match(docBlockRegex);
          if (match && nearbyDocs.length < 3) {
            nearbyDocs.push(match[0]);
          }
        }

        const target: DocTarget = {
          filePath: tab.path,
          language: docLang,
          selection,
          existingDoc,
          nearbyDocs,
        };

        // Create DocGenerator and run generation → preview
        const generator = new DocGenerator(activeProvider, modelId);
        generator.generate(target).then((result) => {
          generator.previewAndApply(result, tab.path);
        }).catch(() => {
          // Generation failure is non-fatal; the AI streaming layer handles errors
        });

        return;
      }

      // Ctrl+Shift+R = Open Refactor Panel
      if (ctrl && e.shiftKey && e.key.toLowerCase() === "r") {
        e.preventDefault();
        openRefactorPanel("rename");
        return;
      }

      // Ctrl+Shift+T = Generate Tests (TestGenPanel)
      if (ctrl && e.shiftKey && e.key.toLowerCase() === "t") {
        e.preventDefault();
        const tb = kbTabsRef.current;
        const at = kbActiveTabRef.current;
        const tab = tb.find((t) => t.id === at);
        if (!tab) return;
        const editorState = useEditorStore.getState();
        const selText = editorState.selectedText;
        const functionCode = selText?.trim() ? selText : tab.content;
        if (functionCode.trim()) {
          openTestGenPanel({ filePath: tab.path, functionCode });
        }
        return;
      }

      // Ctrl+S = Save
      if (ctrl && e.key === "s") {
        e.preventDefault();
        await kbHandleSaveActiveFileRef.current();
        return;
      }

      // Ctrl+` = Toggle Terminal
      if (ctrl && e.key === "`") {
        e.preventDefault();
        setShowTerminal((visible) => !visible);
        setBottomPanelActive("terminal");
        return;
      }

      // Ctrl+W = Close current tab
      if (ctrl && e.key === "w") {
        e.preventDefault();
        const tabId = kbActiveTabRef.current;
        if (tabId) {
          kbHandleTabCloseRef.current(tabId);
        }
        return;
      }

      // Ctrl+Tab = Next tab
      if (ctrl && e.key === "Tab" && !e.shiftKey) {
        e.preventDefault();
        const tb = kbTabsRef.current;
        const at = kbActiveTabRef.current;
        if (tb.length > 1) {
          const currentIdx = tb.findIndex((t) => t.id === at);
          const nextIdx = (currentIdx + 1) % tb.length;
          setActiveTab(tb[nextIdx].id);
        }
        return;
      }

      // Ctrl+Shift+Tab = Previous tab
      if (ctrl && e.shiftKey && e.key === "Tab") {
        e.preventDefault();
        const tb = kbTabsRef.current;
        const at = kbActiveTabRef.current;
        if (tb.length > 1) {
          const currentIdx = tb.findIndex((t) => t.id === at);
          const prevIdx = (currentIdx - 1 + tb.length) % tb.length;
          setActiveTab(tb[prevIdx].id);
        }
        return;
      }

      // Ctrl+= or Ctrl++ = Increase font size
      if (ctrl && (e.key === "=" || e.key === "+")) {
        e.preventDefault();
        setEditorFontSize(prev => Math.min(prev + 1, 28));
        return;
      }

      // Ctrl+- = Decrease font size
      if (ctrl && e.key === "-") {
        e.preventDefault();
        setEditorFontSize(prev => Math.max(prev - 1, 10));
        return;
      }

      // Ctrl+0 = Reset font size
      if (ctrl && e.key === "0") {
        e.preventDefault();
        setEditorFontSize(14);
        return;
      }

      // Ctrl+P = Fuzzy file picker (quick open)
      if (ctrl && !e.shiftKey && e.key.toLowerCase() === "p") {
        e.preventDefault();
        if (kbProjectPathRef.current) setShowFuzzyPicker(true);
        else setShowCommandPalette(true);
        return;
      }

      // Ctrl+\ = Toggle split editor
      if (ctrl && e.key === "\\") {
        e.preventDefault();
        setSplitMode((s) => !s);
        return;
      }

      // Ctrl+B = Toggle Sidebar
      if (ctrl && e.key.toLowerCase() === "b") {
        e.preventDefault();
        setShowSidebar((visible) => !visible);
        return;
      }

      // Ctrl+N = New file (opens command palette with create action)
      if (ctrl && e.key.toLowerCase() === "n") {
        e.preventDefault();
        setShowCommandPalette(true);
        return;
      }

      // Ctrl+, = Open Settings
      if (ctrl && e.key === ",") {
        e.preventDefault();
        setShowSettings(true);
        return;
      }

      // ===== Refresh Keyboard Shortcuts =====
      // F5 / Ctrl+F5 = Refresh PunamIDE, matching browser behavior.
      if (e.key === "F5" && !e.shiftKey && !e.altKey) {
        e.preventDefault();
        window.location.reload();
        return;
      }

      // Shift+F5 = Stop debugging
      if (e.key === "F5" && e.shiftKey) {
        e.preventDefault();
        if (kbDebugAdapterStatusRef.current !== "stopped") {
          kbHandleStopDebugRef.current();
        }
        return;
      }

      // F10 = Step Over
      if (e.key === "F10") {
        e.preventDefault();
        if (kbDebugAdapterStatusRef.current === "paused") {
          kbHandleDebugStepOverRef.current();
        }
        return;
      }

      // F11 = Step Into (only when not in zen mode toggle context)
      if (e.key === "F11" && !e.ctrlKey && !e.shiftKey) {
        e.preventDefault();
        if (kbDebugAdapterStatusRef.current === "paused") {
          kbHandleDebugStepIntoRef.current();
        } else {
          // If debugger not paused, toggle zen mode as fallback
          setZenMode((z) => !z);
        }
        return;
      }

      // Shift+F11 = Step Out
      if (e.key === "F11" && e.shiftKey) {
        e.preventDefault();
        if (kbDebugAdapterStatusRef.current === "paused") {
          kbHandleDebugStepOutRef.current();
        }
        return;
      }

      // Ctrl+Shift+Z = Zen Mode (Focus Mode) - moved from F11
      if (ctrl && e.shiftKey && e.key.toLowerCase() === "z") {
        e.preventDefault();
        setZenMode((z) => !z);
        return;
      }

      // Escape = Close active modal/panel or exit zen mode
      if (e.key === "Escape") {
        if (kbZenModeRef.current) { setZenMode(false); return; }
        if (kbShowCommandPaletteRef.current) { setShowCommandPalette(false); return; }
        if (kbShowSettingsRef.current) { setShowSettings(false); return; }
        if (kbShowRunProfilesRef.current) { setShowRunProfiles(false); return; }
        if (kbShowShortcutsRef.current) { setShowShortcuts(false); return; }
        if (kbPendingReviewRef.current) { closePendingReviewRef.current(false); return; }
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  const applyParsedChanges = async (parsed: ParsedResponse) => {
    if (!projectPath) return;

    // ── Auto-snapshot before AI edits (Ghost Restore safety net) ──
    if (parsed.fileChanges.length > 0 || parsed.deletions.length > 0) {
      try {
        const { invoke } = await import("@tauri-apps/api/core");
        await invoke("create_snapshot", {
          projectRoot: projectPath,
          name: `pre-ai-edit-${Date.now()}`,
          reason: "before-ai-edit",
        });
      } catch (err) {
        // Non-blocking — don't prevent the apply if snapshot fails
        console.warn("[Snapshot] Auto-snapshot before AI edit failed:", err);
      }
    }

    // Save previous content for undo (checkpoint stack)
    const undoBuffer: Array<{ path: string; previousContent: string }> = [];
    for (const change of parsed.fileChanges) {
      if (!change.isNew) {
        const fullPath = getProjectFilePath(change.path);
        const prev = await readFile(fullPath).catch(() => "");
        undoBuffer.push({ path: fullPath, previousContent: prev });
      }
    }
    // Push new checkpoint (keep last 10)
    if (undoBuffer.length > 0) {
      const cp: import("./types").Checkpoint = {
        id: `cp-${Date.now()}`,
        label: parsed.fileChanges.map(f => f.path.split(/[\\/]/).pop()).join(", "),
        timestamp: Date.now(),
        files: undoBuffer,
      };
      setCheckpoints(prev => [...prev.slice(-9), cp]);
    }

    let firstAppliedTabId: string | null = null;

    for (const change of parsed.fileChanges) {
      const fullPath = getProjectFilePath(change.path);
      await writeFile(fullPath, change.content);
      const existsAfterWrite = await pathExists(fullPath);
      if (!existsAfterWrite) {
        throw new Error(`Punam could not verify that ${change.path} exists after writing it.`);
      }
      const normalizedFullPath = normalizeFsPath(fullPath);
      const openTab = tabs.find((tab) => normalizeFsPath(tab.path) === normalizedFullPath);
      const newTabId = `tab-${Date.now()}-${change.path}`;
      firstAppliedTabId = firstAppliedTabId || openTab?.id || newTabId;

      setTabs((prev) => {
        let foundOpenTab = false;
        const updatedTabs = prev.map((t) => {
          if (normalizeFsPath(t.path) !== normalizedFullPath) return t;
          foundOpenTab = true;
          return { ...t, path: fullPath, content: change.content, modified: false };
        });

        if (foundOpenTab) return updatedTabs;

        const name = fullPath.split(/[\\/]/).pop() || change.path;
        const newTab: Tab = {
          id: newTabId,
          path: fullPath,
          name,
          content: change.content,
          modified: false,
        };
        return [...updatedTabs, newTab];
      });
    }

    for (const deletion of parsed.deletions) {
      const fullPath = getProjectFilePath(deletion);
      await deletePath(fullPath);
      const existsAfterDelete = await pathExists(fullPath).catch(() => false);
      if (existsAfterDelete) {
        throw new Error(`Punam could not verify that ${deletion} was deleted.`);
      }
      handlePathDeleted(fullPath);
    }

    // Guard command execution with Rust-side safety validator
    if (parsed.commands.length > 0) {
      for (const cmd of parsed.commands) {
        try {
          const validation = await inspectCommand(cmd, projectPath);

          if (validation.risk_level === "blocked") {
            alert(`⚠️ BLOCKED: ${cmd}\n\nReason: ${validation.feedback_message}`);
            continue;
          }

          // needs_approval or safe — auto-approve since inspect_command validated safety
          // (window.confirm is not available in Tauri webview)
          const confirmed = true;
          if (confirmed) {
            // Run command in the visible terminal panel
            setShowTerminal(true);
            setBottomPanelActive("terminal");
            setPendingTerminalCmd(cmd);
          }
        } catch (err) {
          console.error(`Safety validation failed for: ${cmd}`, err);
        }
      }
    }

    if (firstAppliedTabId) {
      setActiveTab(firstAppliedTabId);
    }

    await refreshFiles();
    setGitRefreshKey((key) => key + 1);
  };

  const handleApplyChanges = async (parsed: ParsedResponse): Promise<boolean> => {
    if (!projectPath) return false;

    const unsavedTargets = parsed.fileChanges
      .map((change) => getProjectFilePath(change.path))
      .filter((fullPath) => tabs.some((tab) => normalizeFsPath(tab.path) === normalizeFsPath(fullPath) && tab.modified));

    if (unsavedTargets.length > 0) {
      // Auto-proceed — the inline diff preview will show changes for user review
      // (window.confirm is not available in Tauri webview)
      const proceed = true;
      if (!proceed) return false;
    }

    const reviewChanges: ReviewChanges = {
      fileChanges: await Promise.all(
        parsed.fileChanges.map(async (change) => {
          const fullPath = getProjectFilePath(change.path);
          let original = "";
          if (!change.isNew) {
            original = await readFile(fullPath).catch(() => "");
          }
          return {
            path: change.path,
            original,
            proposed: change.content,
            isNew: change.isNew,
            hasUnsavedChanges: tabs.some((tab) => normalizeFsPath(tab.path) === normalizeFsPath(fullPath) && tab.modified),
          };
        })
      ),
      deletions: await Promise.all(
        parsed.deletions.map(async (path) => ({
          path,
          original: await readFile(getProjectFilePath(path)).catch(() => ""),
        }))
      ),
      commands: parsed.commands,
    };

    return new Promise((resolve) => {
      setPendingReview({ changes: reviewChanges, resolve });
    });
  };

  const closePendingReview = (applied: boolean) => {
    pendingReview?.resolve(applied);
    setPendingReview(null);
  };

  // ── Agent diff preview event listener ───────────────────────────────────────
  // When the agent tool loop wants to write/patch a file, it emits this event.
  // We intercept it, show the MultiFileDiffBoard, and resolve the Promise
  // with the user's decision (accept/reject).
  useEffect(() => {
    const handleAgentDiffPreview = (e: Event) => {
      const { path, original, proposed, resolve } = (e as CustomEvent).detail;
      const isNew = !original;
      const reviewChanges: ReviewChanges = {
        fileChanges: [{
          path,
          original: original || "",
          proposed,
          isNew,
        }],
        deletions: [],
        commands: [],
      };
      setPendingReview({
        changes: reviewChanges,
        resolve: (applied: boolean) => {
          resolve(applied);
          setPendingReview(null);
        },
      });
    };
    window.addEventListener("punam-agent-diff-preview", handleAgentDiffPreview);
    return () => window.removeEventListener("punam-agent-diff-preview", handleAgentDiffPreview);
  }, []);

  // ── Inline diff preview event listener ──────────────────────────────────────
  // When the agent tool loop wants to write/patch a file, it emits this event.
  // We show the InlineDiffPreview for the user to accept/reject hunks individually.
  // We resolve(false) because the full write_file should NOT also apply — the hunks
  // handle the actual content changes one by one. The circuit breaker in the tool
  // loops ensures the agent stops after this instead of retrying endlessly.
  useEffect(() => {
    const handleInlineDiffPreview = (e: Event) => {
      const { path: filePath, original, proposed, resolve } = (e as CustomEvent).detail;
      // Show inline diff — user will accept/reject hunks individually
      inlineDiff.showDiff(filePath, original || "", proposed);
      // Resolve false: the bulk write_file is not needed — hunks apply individually.
      // The tool loop circuit breaker will halt the agent so it doesn't retry.
      resolve(false);
    };
    window.addEventListener("punam-inline-diff-preview", handleInlineDiffPreview);
    return () => window.removeEventListener("punam-inline-diff-preview", handleInlineDiffPreview);
  }, [inlineDiff.showDiff]);

  const applyReviewedChanges = async (changes: ReviewChanges) => {
    await applyParsedChanges({
      explanation: "",
      fileChanges: changes.fileChanges.map((change) => ({
        path: change.path,
        content: change.proposed,
        isNew: change.isNew,
      })),
      editOperations: [],
      deletions: changes.deletions.map((deletion) => deletion.path),
      commands: changes.commands,
    });
  };

  const handleApplyReviewedAll = async () => {
    if (!pendingReview) return;
    try {
      await applyReviewedChanges(pendingReview.changes);
      setGitRefreshKey((key) => key + 1);
      closePendingReview(true);
    } catch (err) {
      alert(`Failed to apply changes: ${err}`);
      closePendingReview(false);
    }
  };

  const handleApplyReviewedFile = async (path: string) => {
    if (!pendingReview) return;
    const change = pendingReview.changes.fileChanges.find((item) => item.path === path);
    const deletion = pendingReview.changes.deletions.find((item) => item.path === path);
    try {
      await applyReviewedChanges({
        fileChanges: change ? [change] : [],
        deletions: deletion ? [deletion] : [],
        commands: [],
      });
    } catch (err) {
      alert(`Failed to apply file "${path}": ${err}`);
      return;
    }
    setGitRefreshKey((key) => key + 1);

    const remainingChanges = {
      ...pendingReview.changes,
      fileChanges: pendingReview.changes.fileChanges.filter((item) => item.path !== path),
      deletions: pendingReview.changes.deletions.filter((item) => item.path !== path),
    };

    if (remainingChanges.fileChanges.length === 0 && remainingChanges.deletions.length === 0) {
      if (remainingChanges.commands.length > 0) {
        setPendingReview({ ...pendingReview, changes: remainingChanges });
      } else {
        closePendingReview(true);
      }
      return;
    }

    setPendingReview({ ...pendingReview, changes: remainingChanges });
  };

  const handleRejectReviewedFile = (path: string) => {
    if (!pendingReview) return;
    const remainingChanges = {
      ...pendingReview.changes,
      fileChanges: pendingReview.changes.fileChanges.filter((item) => item.path !== path),
      deletions: pendingReview.changes.deletions.filter((item) => item.path !== path),
    };

    if (remainingChanges.fileChanges.length === 0 && remainingChanges.deletions.length === 0 && remainingChanges.commands.length === 0) {
      closePendingReview(false);
      return;
    }

    setPendingReview({ ...pendingReview, changes: remainingChanges });
  };

  const currentTab = tabs.find((t) => t.id === activeTab);
  const themeClass = zenMode ? "zen-mode" : "";
  const projectCheckCommand = detectProjectCheckCommand();

  // Memoize openTabs to prevent AiChat from re-rendering on every keystroke.
  // Only recomputes when tab paths/names actually change (not content edits).
  const openTabsMemo = useMemo(
    () => tabs.map((tab) => ({ path: tab.path, name: tab.name, content: tab.content })),
    // Intentionally shallow — we only care about the tab list identity, not content changes.
    // Content is already available via the tab path if needed by AI.
    [tabs.length, activeTab, ...tabs.map(t => t.path)]
  );
  const activeBottomPanel =
    showDebug && bottomPanelActive === "debug" ? "debug" :
    showProblems && (bottomPanelActive === "problems" || !showTerminal) ? "problems" : "terminal";
  const hasBottomPanel = showTerminal || showProblems || showDebug;

  // Split pane layout calculations
  const showSidePane = showSidebar && !!activityView && activityView !== "ai";
  const showAiPane = showAiPanel || activityView === "ai";
  const splitSizes = showSidePane && showAiPane ? [22, 50, 28]
    : showSidePane ? [24, 76]
    : showAiPane ? [72, 28]
    : [100];
  const splitMin = showSidePane && showAiPane ? [180, 360, 280]
    : showSidePane ? [180, 360]
    : showAiPane ? [360, 260]
    : [360];
  const commandActions: CommandAction[] = [
    {
      id: "open-folder",
      title: "Open Project Folder",
      detail: "Choose a folder to work in",
      run: handleOpenFolder,
    },
    {
      id: "import-ai-project",
      title: "Import AI Project",
      detail: "Import a ZIP project generated by any AI (DeepSeek, ChatGPT, Claude)",
      run: () => setShowImportPanel(true),
    },
    {
      id: "open-file",
      title: "Open File",
      detail: "Open individual file(s) from disk",
      shortcut: "Ctrl+Shift+O",
      run: handleOpenFile,
    },
    {
      id: "quick-open",
      title: "Quick Open File",
      detail: "Fuzzy search project files",
      shortcut: "Ctrl+P",
      disabled: !projectPath,
      run: () => setShowFuzzyPicker(true),
    },
    {
      id: "toggle-split",
      title: splitMode ? "Close Split Editor" : "Split Editor",
      detail: splitMode ? "Return to single pane" : "Open side-by-side editor",
      shortcut: "Ctrl+\\",
      disabled: !currentTab,
      run: () => setSplitMode((s) => !s),
    },
    {
      id: "code-review",
      title: "Code Review",
      detail: currentTab ? `Review ${currentTab.name}` : "Open a file first",
      disabled: !currentTab,
      run: () => openWorkspaceTool("codeReview"),
    },
    {
      id: "save-file",
      title: "Save Current File",
      detail: currentTab?.name,
      shortcut: "Ctrl+S",
      disabled: !currentTab,
      run: handleSaveActiveFile,
    },
    {
      id: "close-tab",
      title: "Close Current Tab",
      detail: currentTab?.name,
      disabled: !currentTab,
      run: () => currentTab && handleTabClose(currentTab.id),
    },
    {
      id: "refresh-explorer",
      title: "Refresh Explorer",
      detail: projectPath ? "Reload project files" : "Open a project first",
      disabled: !projectPath,
      run: refreshFiles,
    },
    {
      id: "project-search",
      title: showSearch ? "Hide Project Search" : "Search In Project",
      detail: "Find text across project files",
      shortcut: "Ctrl+Shift+F",
      disabled: !projectPath,
      run: () => {
        setShowSidebar(true);
        setShowGitPanel(false);
        setShowSearch((visible) => !visible);
      },
    },
    {
      id: "git-changes",
      title: showGitPanel ? "Hide Git Changes" : "Show Git Changes",
      detail: "View changed files",
      disabled: !projectPath,
      run: () => {
        setShowSidebar(true);
        setShowSearch(false);
        setShowGitPanel((visible) => !visible);
        setGitRefreshKey((key) => key + 1);
      },
    },
    {
      id: "github-panel",
      title: "Show GitHub Panel",
      detail: "GitHub integration — repos, PRs, issues",
      disabled: !projectPath,
      run: () => {
        handleActivitySelect("github");
      },
    },
    {
      id: "run-project-check",
      title: runningProjectCheck ? "Running Project Check..." : "Run Project Check",
      detail: projectCheckCommand || "No known check command detected",
      disabled: !projectPath || !projectCheckCommand || runningProjectCheck,
      run: handleRunProjectCheck,
    },
    ...runProfiles
      .filter((profile) => profile.name.trim() && profile.command.trim())
      .map((profile) => ({
        id: `run-profile-${profile.id}`,
        title: `Run: ${profile.name}`,
        detail: profile.command,
        disabled: !projectPath || runningProjectCheck,
        run: () => runProfile(profile),
      })),
    {
      id: "manage-run-profiles",
      title: "Manage Run Profiles",
      detail: "Edit project commands",
      disabled: !projectPath,
      run: () => setShowRunProfiles(true),
    },
    {
      id: "toggle-sidebar",
      title: showSidebar ? "Hide Sidebar" : "Show Sidebar",
      run: () => setShowSidebar((visible) => !visible),
    },
    {
      id: "toggle-ai",
      title: showAiPanel ? "Hide AI Panel" : "Show AI Panel",
      run: () => setShowAiPanel((visible) => !visible),
    },
    {
      id: "toggle-terminal",
      title: showTerminal ? "Hide Terminal" : "Show Terminal",
      run: () => {
        setShowTerminal((visible) => !visible);
        setBottomPanelActive("terminal");
      },
    },
    {
      id: "toggle-problems",
      title: showProblems ? "Hide Problems" : "Show Problems",
      detail: problems.length > 0 ? `${problems.length} problem(s)` : "Problems from latest run",
      run: () => {
        setShowProblems((visible) => !visible);
        setBottomPanelActive("problems");
      },
    },
    {
      id: "open-settings",
      title: "Open Settings",
      run: () => setShowSettings(true),
    },
    {
      id: "toggle-theme",
      title: config.theme === "light" ? "Switch To Dark Theme" : "Switch To Light Theme",
      run: async () => {
        const nextType = config.theme === "light" ? "dark" : "light";
        const nextTheme = getDefaultTheme(nextType);
        const nextConfig = { ...config, theme: nextType };
        applyTheme(nextTheme);
        setConfig(nextConfig);
        await saveConfigToStore(nextConfig).catch(() => {});
        await saveActiveThemeId(nextTheme.id).catch(() => {});
      },
    },
    {
      id: "undo-last-apply",
      title: "Undo Last AI Apply",
      detail: checkpoints.length > 0 ? `Revert ${checkpoints[checkpoints.length - 1].files.length} file(s) — "${checkpoints[checkpoints.length - 1].label}"` : "No changes to undo",
      disabled: checkpoints.length === 0,
      run: async () => {
        if (checkpoints.length === 0) return;
        const cp = checkpoints[checkpoints.length - 1];
        for (const { path, previousContent } of cp.files) {
          await writeFile(path, previousContent);
          setTabs((prev) => prev.map((t) =>
            t.path === path ? { ...t, content: previousContent, modified: false } : t
          ));
        }
        setCheckpoints(prev => prev.slice(0, -1));
        refreshFiles();
        alert(`Reverted "${cp.label}" (${cp.files.length} file(s)).`);
      },
    },
    {
      id: "checkpoint-history",
      title: "Checkpoint History",
      detail: checkpoints.length > 0 ? `${checkpoints.length} checkpoint(s) available` : "No checkpoints",
      disabled: checkpoints.length === 0,
      run: () => {
        const list = checkpoints.slice().reverse().map((cp, i) =>
          `${i + 1}. [${new Date(cp.timestamp).toLocaleTimeString()}] ${cp.label} (${cp.files.length} file(s))`
        ).join("\n");
        alert(`Checkpoint History (newest first):\n\n${list}\n\nUse "Undo Last AI Apply" to restore the most recent.`);
      },
    },
    {
      id: "refactor-panel",
      title: "Refactor: Open Panel",
      detail: "Open the refactoring panel (Rename / Extract / Move)",
      shortcut: "Ctrl+Shift+R",
      disabled: !currentTab,
      run: () => openRefactorPanel("rename"),
    },
    {
      id: "refactor-rename",
      title: "Refactor: Rename Symbol",
      detail: currentTab ? "Rename symbol at cursor" : "Open a file first",
      disabled: !currentTab,
      run: () => openRefactorPanel("rename"),
    },
    {
      id: "refactor-extract-function",
      title: "Refactor: Extract Function",
      detail: currentTab ? "Extract selection into a new function" : "Open a file first",
      disabled: !currentTab || !selectedText,
      run: () => openRefactorPanel("extract"),
    },
    {
      id: "refactor-move-file",
      title: "Refactor: Move File",
      detail: currentTab ? `Move ${currentTab.name}` : "Open a file first",
      disabled: !currentTab,
      run: () => openRefactorPanel("move"),
    },
    {
      id: "generate-tests",
      title: "Generate Tests (AI)",
      detail: currentTab ? (selectedText ? "Generate tests for selected function" : "Generate tests for current file") : "Open a file first",
      shortcut: "Ctrl+Shift+T",
      disabled: !currentTab,
      run: () => {
        if (!currentTab) return;
        const functionCode = selectedText?.trim() ? selectedText : currentTab.content;
        if (functionCode.trim()) {
          openTestGenPanel({ filePath: currentTab.path, functionCode });
        }
      },
    },
  ];

  if (showSplash) {
    return (
      <div className={`app ${themeClass}`}>
        <div className="splash-screen" aria-label="PunamIDE v2.0 is starting">
          {/* Ambient glow layers */}
          <div className="splash-glow splash-glow-1" />
          <div className="splash-glow splash-glow-2" />
          <div className="splash-content">
            <div className="splash-emblem-wrap">
              <div className="splash-inner-core" />
              <img src="/logo_cropped.png" alt="PunamIDE" className="splash-logo" />
            </div>
            <div className="splash-brand-lockup">
              <h1 className="splash-title">
                <span className="splash-title-punam">Punam</span>
                <span className="splash-title-ide">IDE</span>
                <span className="splash-version">v2.0</span>
              </h1>
              <p className="splash-tagline">
                Code <span className="splash-tagline-blue">boldly.</span>
                {" "}Recover <span className="splash-tagline-purple">safely.</span>
              </p>
            </div>
            <div className="splash-loading">
              <div className="splash-bar"><div className="splash-bar-fill" /></div>
              <span className="splash-hint">Initializing workspace...</span>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className={`app ${themeClass}`}>
      {/* Title Bar — minimal, just title + run controls */}
      <div className="titlebar">
        <div className="titlebar-left">
          <button className="toolbar-btn" onClick={handleOpenFolder} title="Open Folder" aria-label="Open project folder">
            <FolderOpen size={15} />
          </button>
          <button className="toolbar-btn" onClick={handleOpenFile} title="Open File (Ctrl+Shift+O)" aria-label="Open file">
            <FileUp size={15} />
          </button>
          <button
            className={`toolbar-btn ${splitMode ? "active" : ""}`}
            onClick={() => setSplitMode((s) => !s)}
            title="Split Editor (Ctrl+\)"
            disabled={!currentTab}
          >
            <Columns2 size={15} />
          </button>
          <button
            className="toolbar-btn"
            onClick={() => setShowTemplatePicker(true)}
            title="New File from Template"
            disabled={!projectPath}
          >
            <FilePlus size={15} />
          </button>
          <button
            className="toolbar-btn"
            onClick={() => setShowBugHunt(true)}
            title="Bug Hunt"
            disabled={!projectPath}
          >
            <Bug size={15} />
          </button>
        </div>
        <div className="titlebar-center">
          <span className="titlebar-text">
            {projectPath ? projectPath.split(/[\\/]/).pop() : "PunamIDE v2.0"}
          </span>
        </div>
        <div className="titlebar-right">
          {/* Tool buttons moved here — the ones not in activity bar */}
          <button className={`toolbar-btn ${showCodeReview ? "active" : ""}`} onClick={() => { if (currentTab) toggleWorkspaceTool("codeReview", showCodeReview); }} title="Code Review" disabled={!currentTab}><ShieldCheck size={15} /></button>
          <button className={`toolbar-btn ${showLivePreview ? "active" : ""}`} onClick={() => { if (currentTab) toggleWorkspaceTool("livePreview", showLivePreview); }} title="Live Preview" disabled={!currentTab}><Monitor size={15} /></button>
          <button className={`toolbar-btn ${showTestGenerator ? "active" : ""}`} onClick={() => { if (currentTab) toggleWorkspaceTool("testGenerator", showTestGenerator); }} title="Generate Tests" disabled={!currentTab}><FlaskConical size={15} /></button>
          <button className={`toolbar-btn ${showRefactorPanel ? "active" : ""}`} onClick={() => { if (currentTab) showRefactorPanel ? openWorkspaceTool(null) : openRefactorPanel(); }} title="Refactor (Ctrl+Shift+R)" disabled={!currentTab}><Wrench size={15} /></button>
          <button className={`toolbar-btn ${showNotes ? "active" : ""}`} onClick={() => toggleWorkspaceTool("notes", showNotes)} title="Project Notes" disabled={!projectPath}><StickyNote size={15} /></button>
          <span className="titlebar-sep" />
          <button className={`toolbar-btn ${showTerminal ? "active" : ""}`} onClick={() => { setShowTerminal(prev => !prev); setBottomPanelActive("terminal"); }} title="Terminal (Ctrl+`)"><TerminalSquare size={15} /></button>
          <button className={`toolbar-btn ${showProblems ? "active" : ""}`} onClick={() => { setShowProblems(prev => !prev); setBottomPanelActive("problems"); }} title="Problems">
            <AlertCircle size={15} />
            {problems.length > 0 && <span className="toolbar-badge">{problems.length}</span>}
          </button>
          <span className="titlebar-sep" />
          <div className="help-menu-root">
            <button
              className={`toolbar-btn ${showHelpMenu ? "active" : ""}`}
              onClick={() => setShowHelpMenu((open) => !open)}
              title="Help"
              aria-label="Help"
              aria-expanded={showHelpMenu}
            >
              <HelpCircle size={15} />
            </button>
            {showHelpMenu && (
              <>
                <div className="help-menu-backdrop" onClick={() => setShowHelpMenu(false)} />
                <div className="help-menu">
                  <button onClick={() => { setShowFeedback(true); setShowHelpMenu(false); }}>
                    <MessageSquare size={14} />
                    <span>Send Feedback</span>
                  </button>
                  <button onClick={() => { handleExportDiagnostics(undefined, true); setShowHelpMenu(false); }}>
                    <Download size={14} />
                    <span>Export Logs</span>
                  </button>
                  <button onClick={() => { handleGenerateDiagnostics(); setShowHelpMenu(false); }}>
                    <FileText size={14} />
                    <span>Generate Diagnostics</span>
                  </button>
                  <button onClick={() => { setShowShortcuts(true); setShowHelpMenu(false); }}>
                    <Command size={14} />
                    <span>Keyboard Shortcuts</span>
                  </button>
                  <button onClick={() => { handleCheckForUpdates(); setShowHelpMenu(false); }}>
                    <RefreshCw size={14} />
                    <span>Check for Updates</span>
                  </button>
                  <button onClick={() => { openDataFolder().catch((err) => showToast(`Failed to open data folder: ${err}`, "error")); setShowHelpMenu(false); }}>
                    <FolderCog size={14} />
                    <span>Open Data Folder</span>
                  </button>
                  <button onClick={() => { handleJoinDiscord(); setShowHelpMenu(false); }}>
                    <ExternalLink size={14} />
                    <span>Join Discord</span>
                  </button>
                  <button onClick={() => { setShowAbout(true); setShowHelpMenu(false); }}>
                    <Info size={14} />
                    <span>About</span>
                  </button>
                </div>
              </>
            )}
          </div>
          <button className={`toolbar-btn ${zenMode ? "active" : ""}`} onClick={() => setZenMode(prev => !prev)} title="Zen Mode (F11)">{zenMode ? <Minimize2 size={15} /> : <Maximize2 size={15} />}</button>
        </div>
      </div>

      {/* Main body — activity bar + resizable split (sidebar + editor + ai) */}
      <div className="app-body">
        {/* Activity Bar — outside Split, never resized */}
        {!zenMode && (
          <ActivityBar
            active={activityView}
            onSelect={handleActivitySelect}
            onSettings={() => setShowSettings(true)}
            onShortcuts={() => setShowShortcuts(true)}
            gitBadge={0}
          />
        )}

        {/* Resizable 3-pane split: sidebar | editor | ai-panel */}
        <Split
          key={`split-${showSidePane ? "s" : ""}${showAiPane ? "a" : ""}`}
          className="main-layout split-horizontal"
          sizes={splitSizes}
          minSize={splitMin}
          gutterSize={5}
          snapOffset={60}
          direction="horizontal"
          style={{ display: "flex", flex: 1, minWidth: 0, overflow: "hidden" }}
        >
        {/* Sidebar panel */}
        {showSidebar && activityView && activityView !== "ai" && (
          <div className="sidebar" role="navigation" aria-label="Sidebar">
            {activityView === "git" ? (
              <GitPanel
                projectPath={projectPath}
                refreshKey={gitRefreshKey}
                onOpenFile={handleGitFileOpen}
                onViewDiff={(path) => setGitDiffFile(path)}
                onClose={() => handleActivitySelect("explorer")}
                aiProviders={aiProviders}
              />
            ) : activityView === "search" ? (
              <FindReplace
                projectPath={projectPath}
                onOpenResult={handleSearchResultOpen}
                onClose={() => handleActivitySelect("explorer")}
              />
            ) : activityView === "run" ? (
              <div className="sidebar-run-panel">
                <div className="panel-header">RUN & DEBUG</div>
                <div className="run-panel-body">
                  <div className="run-debug-actions">
                    <div style={{ display: "flex", alignItems: "center", gap: 4, width: "100%" }}>
                      <button className="run-profile-btn" style={{ flex: 1 }} onClick={() => handleStartDebug()} disabled={!projectPath || debugAdapterStatus !== "stopped" || !selectedDebugConfigId}>
                        <BugPlay size={13} />
                        <span>Start Debugging</span>
                      </button>
                    </div>
                    <DebugConfigPicker
                      configs={debugLaunchConfigs}
                      selectedId={selectedDebugConfigId}
                      onSelect={setSelectedDebugConfigId}
                      onAddConfig={handleAddDebugConfig}
                      onEditConfigs={handleEditLaunchJson}
                      disabled={debugAdapterStatus !== "stopped"}
                    />
                    <button className="run-profile-btn" onClick={() => handleStopDebug()} disabled={debugAdapterStatus === "stopped"}>
                      <SquareDot size={13} />
                      <span>Stop Debugging</span>
                    </button>
                  </div>
                  {runProfiles.length === 0 ? (
                    <p className="run-empty">No run profiles detected.<br/>Open a project with package.json, Cargo.toml, etc.</p>
                  ) : (
                    runProfiles.map(profile => (
                      <button key={profile.id} className="run-profile-btn" onClick={() => runProfile(profile)} disabled={runningProjectCheck}>
                        <Play size={13} />
                        <span>{profile.name}</span>
                        <code>{profile.command}</code>
                      </button>
                    ))
                  )}
                  <button className="btn-secondary compact" style={{margin: "10px 12px"}} onClick={() => setShowRunProfiles(true)}>Edit Profiles</button>
                  <button className="btn-secondary compact" style={{margin: "0 12px 10px"}} onClick={handleEditLaunchJson}>Edit launch.json</button>
                </div>
              </div>
            ) : activityView === "docker" ? (
              <Suspense fallback={null}>
                <DockerPanel projectPath={projectPath} />
              </Suspense>
            ) : activityView === "notepads" ? (
              <Suspense fallback={null}>
                <NotepadsPanel projectPath={projectPath} onClose={() => handleActivitySelect("explorer")} />
              </Suspense>
            ) : activityView === "github" ? (
              <Suspense fallback={null}>
                <GitHubPanel projectPath={projectPath} onClose={() => handleActivitySelect("explorer")} />
              </Suspense>
            ) : activityView === "context" ? (
              <Suspense fallback={null}>
                <ContextSidebar />
              </Suspense>
            ) : (
              <FileExplorer
                files={files}
                projectPath={projectPath}
                loading={filesLoading}
                onFileSelect={handleFileSelect}
                onRefresh={refreshFiles}
                onPathDeleted={handlePathDeleted}
                onPathRenamed={handlePathRenamed}
                onBeforePathAction={confirmPathOperation}
                selectedFile={currentTab?.path}
              />
            )}
          </div>
        )}

        {/* Editor Area */}
        <div className="editor-area" role="main" aria-label="Code editor area">
          <Split
            key={hasBottomPanel ? "editor-with-bottom-panel" : "editor-only"}
            className="editor-vertical-split"
            sizes={hasBottomPanel ? [68, 32] : [100]}
            minSize={hasBottomPanel ? [240, 120] : [240]}
            gutterSize={hasBottomPanel ? 5 : 0}
            snapOffset={24}
            direction="vertical"
          >
            <div className="editor-main">
              {tabs.length > 0 ? (
                <>
                  <EditorTabs
                    tabs={tabs}
                    activeTab={activeTab}
                    onTabSelect={setActiveTab}
                    onTabClose={handleTabClose}
                  />
                  {currentTab && (
                    <>
                      <div className="breadcrumb-bar">
                        <Breadcrumbs
                          filePath={currentTab.path}
                          projectPath={projectPath}
                          cursorLine={editorCursorPosition.line}
                          currentSymbol={undefined}
                        />
                        <span className="breadcrumb-spacer" />
                        <button
                          className={`breadcrumb-toggle ${wordWrap === "on" ? "active" : ""}`}
                          onClick={() => setWordWrap(w => w === "on" ? "off" : "on")}
                          title={wordWrap === "on" ? "Disable word wrap" : "Enable word wrap"}
                          aria-label="Toggle word wrap"
                        >
                          wrap
                        </button>
                        <button
                          className={`breadcrumb-toggle ${showMinimap ? "active" : ""}`}
                          onClick={() => setShowMinimap(m => !m)}
                          title={showMinimap ? "Hide minimap" : "Show minimap"}
                          aria-label="Toggle minimap"
                        >
                          map
                        </button>
                        <button
                          className={`breadcrumb-toggle ${blameEnabled ? "active" : ""}`}
                          onClick={() => setBlameEnabled(b => !b)}
                          title={blameEnabled ? "Hide git blame" : "Show git blame"}
                          aria-label="Toggle git blame"
                        >
                          blame
                        </button>
                      </div>
                      {splitMode ? (
                        <Suspense fallback={null}>
                          <SplitEditor
                          leftTabs={tabs}
                          leftPane={{ activeTab }}
                          onLeftTabSelect={setActiveTab}
                          onLeftTabClose={handleTabClose}
                          onLeftChange={handleContentChange}
                          rightTabs={rightTabs.length > 0 ? rightTabs : tabs}
                          rightPane={{ activeTab: rightActiveTab || activeTab }}
                          onRightTabSelect={setRightActiveTab}
                          onRightTabClose={(id) => {
                            setRightTabs((prev) => prev.filter((t) => t.id !== id));
                            if (rightActiveTab === id) {
                              const remaining = rightTabs.filter((t) => t.id !== id);
                              setRightActiveTab(remaining[remaining.length - 1]?.id || "");
                            }
                          }}
                          onRightChange={(value) => {
                            const rTab = rightActiveTab || activeTab;
                            setRightTabs((prev) =>
                              prev.map((t) => t.id === rTab ? { ...t, content: value, modified: true } : t)
                            );
                            setTabs((prev) =>
                              prev.map((t) => t.id === rTab ? { ...t, content: value, modified: true } : t)
                            );
                          }}
                          problems={problems}
                          theme={config.theme}
                          aiProviders={aiProviders}
                          inlineCompletionEnabled={inlineCompletionEnabled}
                          onSelectionChange={setSelectedText}
                          onCursorChange={setEditorCursorPosition}
                          onLeftSave={() => handleSaveTab(activeTab)}
                          onRightSave={() => handleSaveTab(rightActiveTab || activeTab)}
                          onAskPunam={(text, mode) => {
                            setSelectedText(text);
                            handleActivitySelect("ai");
                            setShowAiPanel(true);
                            setForceAiPrompt({ text, mode: String(mode) });
                          }}
                        />
                        </Suspense>
                      ) : (
        <>
        {/* Merge conflict resolver — shown when active file has conflict markers */}
        {currentTab.content && hasConflictMarkers(currentTab.content) && (
          <MergeConflictPanel
            filePath={currentTab.path}
            content={currentTab.content}
            onResolve={async (resolved) => {
              await writeFile(currentTab.path, resolved);
              setTabs((prev) => prev.map((t) => t.id === currentTab.id ? { ...t, content: resolved, modified: false } : t));
              refreshFiles();
            }}
            onDismiss={() => {/* user can continue editing with markers */}}
          />
        )}
        <CodeEditor
          content={currentTab.content}
          language={getLanguage(currentTab.name)}
          path={currentTab.path}
          projectPath={projectPath}
          line={editorLine}
          problems={problems}
          onChange={handleContentChange}
          onSelectionChange={setSelectedText}
          onCursorChange={setEditorCursorPosition}
          onSave={handleSaveActiveFile}
              onAskPunam={(text, mode) => {
                setSelectedText(text);
                handleActivitySelect("ai");
                setShowAiPanel(true);
                setForceAiPrompt({ text, mode: String(mode) });
              }}
              theme={config.theme}
              aiProviders={aiProviders}
              inlineCompletionEnabled={inlineCompletionEnabled}
              fontSize={editorFontSize}
              showMinimap={showMinimap}
              wordWrap={wordWrap}
              breakpoints={breakpoints[currentTab.path] || []}
              onToggleBreakpoint={(line) => handleToggleBreakpoint(currentTab.path, line)}
              currentDebugSource={currentSource}
              blameEnabled={blameEnabled}
              onEditorReady={inlineDiff.setEditorInstance}
              onOpenRefactorPanel={openRefactorPanel}
              onSelectionRangeChange={setRefactorSelection}
              onOpenTestGenPanel={(functionCode) => {
                if (currentTab && functionCode.trim()) {
                  openTestGenPanel({ filePath: currentTab.path, functionCode });
                }
              }}
            />
        {/* Inline diff preview toolbar — shown when AI generates edits for the active file */}
        {inlineDiff.state.activeFile === currentTab.path && inlineDiff.state.hunks.length > 0 && (
          <InlineDiffPreview
            hunks={inlineDiff.state.hunks}
            onAcceptHunk={inlineDiff.acceptHunk}
            onRejectHunk={inlineDiff.rejectHunk}
            onDismissAll={inlineDiff.dismissAll}
            onNavigatePrev={inlineDiff.navigatePrev}
            onNavigateNext={inlineDiff.navigateNext}
            focusedHunkIndex={inlineDiff.state.focusedHunkIndex}
            activeFile={inlineDiff.state.activeFile}
          />
        )}
        </>
                      )}
                    </>
                  )}
                </>
              ) : (
                <div className={`editor-empty ${hasBottomPanel ? "editor-empty--compact" : ""}`}>
                  <div className="welcome-logo-stage" aria-hidden="true">
                    <img src="/logo_transparent.png" alt="" className="editor-empty-logo" draggable={false} />
                  </div>
                  {!hasBottomPanel && <h2 className="welcome-title">Welcome to PunamIDE</h2>}
                  <div className="welcome-workspace">
                    <div className="welcome-shortcuts">
                      <button className="welcome-shortcut-btn welcome-shortcut-btn--primary" onClick={() => setShowImportPanel(true)}><Download size={15} /><span>Import AI Project</span><span className="welcome-badge">ZIP</span></button>
                      <button className="welcome-shortcut-btn" onClick={handleOpenFolder}><FolderOpen size={15} /><span>Open Folder</span><kbd>Ctrl+O</kbd></button>
                      <button className="welcome-shortcut-btn" onClick={() => { setShowTerminal(true); setBottomPanelActive("terminal"); }}><TerminalIcon size={15} /><span>New Terminal</span><kbd>Ctrl+`</kbd></button>
                      <button className="welcome-shortcut-btn" onClick={() => setShowCommandPalette(true)}><Command size={15} /><span>Command Palette</span><kbd>Ctrl+Shift+P</kbd></button>
                      {!hasBottomPanel && <button className="welcome-shortcut-btn" onClick={() => handleActivitySelect("search")}><Search size={15} /><span>Search Files</span><kbd>Ctrl+Shift+F</kbd></button>}
                    </div>
                    {!hasBottomPanel && recentProjects.length > 0 && (
                      <div className="welcome-recent">
                        <p className="welcome-recent-label">Recent Projects</p>
                        {recentProjects.slice(0, 4).map((p) => (
                          <button
                            key={p.path}
                            className="welcome-recent-btn"
                            onClick={async () => {
                              await setProjectRoot(p.path);
                              await saveRecentProjectPath(p.path);
                              setProjectPath(p.path);
                              setTabs([]);
                              setActiveTab("");
                              setProblems([]);
                              setGitRefreshKey(k => k + 1);
                            }}
                            title={p.path}
                          >
                            <FolderOpen size={13} />
                            <span className="welcome-recent-name">{p.path.split(/[\\/]/).pop()}</span>
                            <span className="welcome-recent-time">{formatRelativeTime(p.openedAt)}</span>
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                  {!hasBottomPanel && (
                    <div className="welcome-footer">
                      <button className="welcome-footer-link" onClick={() => handleOpenExternal(PUNAM_WEBSITE_URL)}><Globe size={12} /><span>Documentation</span></button>
                      <span className="welcome-footer-dot">·</span>
                      <button className="welcome-footer-link" onClick={handleJoinDiscord}><ExternalLink size={12} /><span>Discord</span><span className="welcome-badge welcome-badge--subtle">Alpha</span></button>
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* Bottom Panel */}
            {hasBottomPanel && (
              <div className="bottom-panel">
                <div className="bottom-panel-tabs">
                  {showTerminal && (
                    <button className={`bottom-panel-tab ${activeBottomPanel === "terminal" ? "active" : ""}`} onClick={() => setBottomPanelActive("terminal")} type="button">
                      <TerminalSquare size={13} /><span>Terminal</span>
                    </button>
                  )}
                  {showProblems && (
                    <button className={`bottom-panel-tab ${activeBottomPanel === "problems" ? "active" : ""}`} onClick={() => setBottomPanelActive("problems")} type="button">
                      <AlertCircle size={13} /><span>Problems</span>
                      {problems.length > 0 && <span className="bottom-panel-count">{problems.length}</span>}
                    </button>
                  )}
                  {showDebug && (
                    <button className={`bottom-panel-tab ${activeBottomPanel === "debug" ? "active" : ""}`} onClick={() => setBottomPanelActive("debug")} type="button">
                      <BugPlay size={13} /><span>Debugger</span>
                      {debugAdapterStatus !== "stopped" && <span className="bottom-panel-badge debug-active" />}
                    </button>
                  )}
                  <span className="bottom-panel-spacer" />
                  <button className="bottom-panel-close" onClick={() => { setShowTerminal(false); setShowProblems(false); setShowDebug(false); }} title="Close panel"><X size={13} /></button>
                </div>
                <div className="bottom-panel-content">
                  {activeBottomPanel === "terminal" && showTerminal && <TerminalPanel cwd={projectPath} onOutputChange={setTerminalOutput} commandToRun={pendingTerminalCmd} onCommandStarted={() => setPendingTerminalCmd(null)} onCommandFailed={(cmd, output) => setProactiveError({ command: cmd, output })} onRunObservation={setRunObservation} onOpenUrl={setWebPreviewUrl} aiProviders={aiProviders} onFixWithAi={() => { setShowAiPanel(true); handleActivitySelect("ai"); }} />}
                  {activeBottomPanel === "problems" && showProblems && (
                    <ProblemsPanel problems={problems} active={activeBottomPanel === "problems"} onSelect={handleProblemOpen} onClose={() => { setShowProblems(false); if (showTerminal) setBottomPanelActive("terminal"); }} />
                  )}
                  {activeBottomPanel === "debug" && showDebug && (
                    <DebuggerPanel
                      sessionId={debugSessionId}
                      adapterStatus={debugAdapterStatus}
                      breakpoints={breakpoints}
                      currentSource={currentSource}
                      stackFrames={currentStackFrames}
                      variables={currentVariables}
                      consoleOutput={debugConsoleOutput}
                      debugConfigs={debugLaunchConfigs}
                      selectedConfigId={selectedDebugConfigId}
                      onSelectConfig={setSelectedDebugConfigId}
                      onAddConfig={handleAddDebugConfig}
                      onEditConfigs={handleEditLaunchJson}
                      onSendRequest={sendDapRequest}
                      onContinue={handleDebugContinue}
                      onStepOver={handleDebugStepOver}
                      onStepInto={handleDebugStepInto}
                      onStepOut={handleDebugStepOut}
                      onStop={handleStopDebug}
                      onPause={handleDebugPause}
                      onJumpToSource={handleDebuggerJumpToSource}
                    />
                  )}
                </div>
              </div>
            )}
          </Split>
        </div>

        {/* AI Chat Panel — right side panel with tabs */}
        {(showAiPanel || activityView === "ai") && (
          <div className="ai-panel" role="complementary" aria-label="AI assistant">
            <PanelErrorBoundary fallbackLabel="Right Panel">
              <RightPanel
                config={config}
                projectPath={projectPath}
                files={files}
                openTabs={openTabsMemo}
                activeFilePath={currentTab?.path}
                selectedText={selectedText}
                problems={problems}
                terminalOutput={terminalOutput}
                aiProviders={aiProviders}
                proactiveError={proactiveError}
                runObservation={runObservation}
                onDismissProactiveError={() => setProactiveError(null)}
                onDismissRunObservation={() => setRunObservation(null)}
                checkResult={projectCheckResult}
                checkingProject={runningProjectCheck}
                onRunProjectCheck={handleRunProjectCheck}
                checkpointCount={checkpoints.length}
                mcpServers={mcpServers}
                projectNotes={projectNotes}
                onApplyChanges={handleApplyChanges}
                onApplyDirect={async (parsed) => { if (!projectPath) return; await applyParsedChanges(parsed); }}
                onRunCommand={(cmd) => { setShowTerminal(true); setBottomPanelActive("terminal"); setPendingTerminalCmd(cmd); }}
                forcePrompt={forceAiPrompt}
                onForcePromptConsumed={() => setForceAiPrompt(null)}
                onRevertLastApply={async () => {
                  if (checkpoints.length === 0) return;
                  const cp = checkpoints[checkpoints.length - 1];
                  for (const { path, previousContent } of cp.files) {
                    await writeFile(path, previousContent);
                    setTabs((prev) => prev.map((t) => t.path === path ? { ...t, content: previousContent, modified: false } : t));
                  }
                  setCheckpoints(prev => prev.slice(0, -1));
                  refreshFiles();
                }}
              />
            </PanelErrorBoundary>
          </div>
        )}
      </Split>

      </div>
      {/* ── End of app body ── */}

      {/* Status Bar */}
      <StatusBar
        gitBranch={gitBranch}
        errors={problems.filter((p) => p.severity === "error").length}
        warnings={problems.filter((p) => p.severity === "warning").length}
        cursorLine={editorCursorPosition.line}
        cursorCol={editorCursorPosition.column}
        language={currentTab ? currentTab.name.split(".").pop() || "" : ""}
        filePath={currentTab?.path}
        isModified={currentTab?.modified}
      />

      {/* File Template Picker */}
      {showTemplatePicker && (
        <Suspense fallback={null}>
          <FileTemplatePicker
            defaultFolder={projectPath}
            onConfirm={async (relativePath, content) => {
              setShowTemplatePicker(false);
              const fullPath = `${projectPath.replace(/[\\/]+$/, "")}/${relativePath.replace(/^[\\/]+/, "")}`;
              await writeFile(fullPath, content);
              await refreshFiles();
              handleFileSelect(fullPath);
              showToast(`Created ${relativePath.split("/").pop()}`, "success");
            }}
            onClose={() => setShowTemplatePicker(false)}
          />
        </Suspense>
      )}

      {/* Project Notes */}
      {showNotes && projectPath && (
        <div className="notes-overlay">
          <Suspense fallback={null}>
            <NotesPanel
              projectPath={projectPath}
              onClose={() => setShowNotes(false)}
              onChange={setProjectNotes}
            />
          </Suspense>
        </div>
      )}

      {/* Live Preview */}
      {showLivePreview && currentTab && (
        <div className="live-preview-overlay">
          <Suspense fallback={null}>
            <LivePreview
              filePath={currentTab.path}
              content={currentTab.content}
              language={getLanguage(currentTab.name)}
              projectPath={projectPath}
              terminalOutput={terminalOutput}
              onClose={() => setShowLivePreview(false)}
            />
          </Suspense>
        </div>
      )}

      {/* Web Preview from terminal links */}
      {webPreviewUrl && (
        <div className="web-preview-overlay">
          <Suspense fallback={null}>
            <WebPreviewPanel
              key={webPreviewUrl}
              initialUrl={webPreviewUrl}
              onClose={() => setWebPreviewUrl(null)}
            />
          </Suspense>
        </div>
      )}

      {/* Test Generator */}
      {showTestGenerator && currentTab && (
        <div className="test-gen-overlay">
          <Suspense fallback={null}>
            <TestGenerator
              filePath={currentTab.path}
              fileContent={currentTab.content}
              language={getLanguage(currentTab.name)}
              aiProviders={aiProviders}
              projectFiles={(() => {
                const paths: string[] = [];
                const walk = (entries: import("./utils/tauri").FileEntry[]) => {
                  for (const e of entries) {
                    if (e.is_dir && e.children) walk(e.children);
                    else paths.push(e.path);
                  }
                };
                walk(files);
                return paths;
              })()}
              onCreateFile={async (path, content) => {
                const fullPath = path.startsWith(projectPath) ? path : `${projectPath.replace(/[\\/]+$/, "")}/${path.replace(/^[\\/]+/, "")}`;
                await writeFile(fullPath, content);
                await refreshFiles();
                handleFileSelect(fullPath);
                showToast(`Test file created`, "success");
              }}
              onClose={() => setShowTestGenerator(false)}
            />
          </Suspense>
        </div>
      )}

      {/* Refactor Panel */}
      {showRefactorPanel && currentTab && (
        <div className="refactor-overlay" style={{ width: refactorPanelWidth }}>
          <div
            className="refactor-resize-handle"
            onMouseDown={(event) => {
              event.preventDefault();
              const onMove = (moveEvent: MouseEvent) => {
                const maxWidth = Math.min(860, window.innerWidth - 280);
                setRefactorPanelWidth(Math.max(380, Math.min(maxWidth, window.innerWidth - moveEvent.clientX)));
              };
              const onUp = () => {
                document.removeEventListener("mousemove", onMove);
                document.removeEventListener("mouseup", onUp);
              };
              document.addEventListener("mousemove", onMove);
              document.addEventListener("mouseup", onUp);
            }}
            role="separator"
            aria-label="Resize refactor panel"
            aria-orientation="vertical"
          />
          <Suspense fallback={null}>
            <RefactorPanel
              activeFile={currentTab ? { path: currentTab.path, name: currentTab.name } : null}
              cursorPosition={editorCursorPosition}
              selection={refactorSelection}
              initialMode={refactorMode}
              onApplied={async (changeSet) => {
                setTabs((previousTabs) => previousTabs.map((tab) => {
                  const edit = changeSet.edits.find((candidate) => candidate.filePath === tab.path);
                  if (edit && !edit.delete) return { ...tab, content: edit.newContent, modified: false };
                  if (edit?.delete) {
                    const destination = changeSet.edits.find((candidate) => !candidate.delete && candidate.newContent === changeSet.originalContent[tab.path]);
                    if (destination) {
                      return { ...tab, path: destination.filePath, name: destination.filePath.split(/[\\/]/).pop() || tab.name, content: destination.newContent, modified: false };
                    }
                  }
                  return tab;
                }));
                await refreshFiles();
              }}
              onClose={() => setShowRefactorPanel(false)}
            />
          </Suspense>
        </div>
      )}

      {/* AI Test Generation Panel (TestGenPanel) */}
      {testGenPanelSource && (
        <div className="test-gen-overlay">
          <Suspense fallback={null}>
            <TestGenPanel
              source={testGenPanelSource}
              onClose={() => setTestGenPanelSource(null)}
            />
          </Suspense>
        </div>
      )}

      {/* Git Diff View */}
      {gitDiffFile && (
        <div className="git-diff-overlay">
          <Suspense fallback={null}>
            <GitDiffView
              projectPath={projectPath}
              filePath={gitDiffFile}
              onClose={() => setGitDiffFile(null)}
              onOpenFile={(path) => {
                setGitDiffFile(null);
                handleGitFileOpen(path);
              }}
            />
          </Suspense>
        </div>
      )}

      {/* Fuzzy File Picker (Ctrl+P) */}
      {showFuzzyPicker && (
        <FuzzyFilePicker
          files={files}
          recentPaths={recentPaths}
          onSelect={(relativePath) => {
            setShowFuzzyPicker(false);
            handleFileSelect(getProjectFilePath(relativePath));
          }}
          onClose={() => setShowFuzzyPicker(false)}
        />
      )}

      {/* Code Review Panel */}
      {showCodeReview && currentTab && (
        <div className="code-review-overlay">
          <Suspense fallback={null}>
            <CodeReview
              filePath={currentTab.path}
              fileContent={currentTab.content}
              selectedText={selectedText}
              language={getLanguage(currentTab.name)}
              aiProviders={aiProviders}
              onClose={() => setShowCodeReview(false)}
              onJumpToLine={(line) => setEditorLine(line)}
            />
          </Suspense>
        </div>
      )}

      {showFeedback && (
        <div className="alpha-modal-overlay" onClick={() => setShowFeedback(false)}>
          <div className="alpha-modal" onClick={(event) => event.stopPropagation()}>
            <div className="alpha-modal-header">
              <div>
                <h2>Send Feedback</h2>
                <p>Tell us what happened. Diagnostics stay local until you copy or export them.</p>
              </div>
              <button className="toolbar-btn" onClick={() => setShowFeedback(false)} aria-label="Close feedback">
                <X size={15} />
              </button>
            </div>
            <textarea
              className="alpha-textarea"
              value={feedbackMessage}
              onChange={(event) => setFeedbackMessage(event.target.value)}
              placeholder="What happened? What were you trying to do?"
            />
            <label className="alpha-checkbox-row">
              <input
                type="checkbox"
                checked={includeProjectPathInDiagnostics}
                onChange={(event) => setIncludeProjectPathInDiagnostics(event.target.checked)}
              />
              <span>Include current project path in diagnostics</span>
            </label>
            <div className="alpha-modal-actions">
              <button className="btn-secondary compact" onClick={() => handleCopyDiagnostics(feedbackMessage)} disabled={diagnosticsBusy}>
                <Clipboard size={14} />
                Copy Report
              </button>
              <button className="btn-secondary compact" onClick={() => handleExportDiagnostics(feedbackMessage)} disabled={diagnosticsBusy}>
                <Download size={14} />
                Export Report
              </button>
              <button className="btn-primary compact" onClick={handleJoinDiscord}>
                <ExternalLink size={14} />
                Discord
              </button>
            </div>
          </div>
        </div>
      )}

      {showDiagnostics && (
        <div className="alpha-modal-overlay" onClick={() => setShowDiagnostics(false)}>
          <div className="alpha-modal alpha-modal-wide" onClick={(event) => event.stopPropagation()}>
            <div className="alpha-modal-header">
              <div>
                <h2>Diagnostics</h2>
                <p>Review before sharing. No source files are included.</p>
              </div>
              <button className="toolbar-btn" onClick={() => setShowDiagnostics(false)} aria-label="Close diagnostics">
                <X size={15} />
              </button>
            </div>
            <div className="alpha-diagnostics-grid">
              {[
                ["App version", systemDiagnostics?.app_version || PUNAM_VERSION],
                ["Build", systemDiagnostics?.build_number || PUNAM_BUILD_NUMBER],
                ["Release date", systemDiagnostics?.release_date || PUNAM_RELEASE_DATE],
                ["Channel", systemDiagnostics?.release_channel || PUNAM_RELEASE_CHANNEL],
                ["OS", systemDiagnostics ? `${systemDiagnostics.os} ${systemDiagnostics.os_version}` : "Loading..."],
                ["CPU", systemDiagnostics ? `${systemDiagnostics.cpu} (${systemDiagnostics.logical_cpus} logical)` : "Loading..."],
                ["RAM", systemDiagnostics ? `${systemDiagnostics.total_memory_mb} MB` : "Loading..."],
                ["Tauri", systemDiagnostics?.tauri_version || "Loading..."],
                ["Rust backend", systemDiagnostics?.rust_backend_version || "Loading..."],
                ["Active provider", aiProviders.find((provider) => provider.apiKey || provider.name === "Ollama (Local)")?.name || config.provider || "Not configured"],
                ["Log path", systemDiagnostics?.log_path || "Loading..."],
              ].map(([label, value]) => (
                <div className="alpha-diagnostics-item" key={label}>
                  <span>{label}</span>
                  <strong>{value}</strong>
                </div>
              ))}
            </div>
            <textarea className="alpha-report" value={diagnosticsReport} readOnly />
            <div className="alpha-modal-actions">
              <button className="btn-secondary compact" onClick={() => refreshSystemDiagnostics()} disabled={diagnosticsBusy}>
                <RefreshCw size={14} />
                Refresh
              </button>
              <button className="btn-secondary compact" onClick={() => handleCopyDiagnostics()} disabled={diagnosticsBusy}>
                <Clipboard size={14} />
                Copy Report
              </button>
              <button className="btn-secondary compact" onClick={handleCopySystemInfo} disabled={diagnosticsBusy}>
                <Clipboard size={14} />
                Copy System Info
              </button>
              <button className="btn-secondary compact" onClick={() => openLogsFolder().catch((err) => showToast(`Failed to open logs: ${err}`, "error"))}>
                <FolderCog size={14} />
                Open Logs Folder
              </button>
              <button className="btn-primary compact" onClick={() => handleExportDiagnostics()} disabled={diagnosticsBusy}>
                <Download size={14} />
                Export Diagnostics
              </button>
            </div>
          </div>
        </div>
      )}

      {showAbout && (
        <div className="alpha-modal-overlay" onClick={() => setShowAbout(false)}>
          <div className="alpha-modal alpha-about" onClick={(event) => event.stopPropagation()}>
            <div className="alpha-modal-header">
              <div className="alpha-about-title">
                <img src="/logo_transparent.png" alt="PunamIDE" />
                <div>
                  <h2>PunamIDE {PUNAM_VERSION}</h2>
                  <p>AI-Powered Desktop IDE built with Rust + Tauri</p>
                </div>
              </div>
              <button className="toolbar-btn" onClick={() => setShowAbout(false)} aria-label="Close about">
                <X size={15} />
              </button>
            </div>
            <div className="alpha-diagnostics-grid">
              <div className="alpha-diagnostics-item"><span>Build</span><strong>{PUNAM_BUILD_NUMBER}</strong></div>
              <div className="alpha-diagnostics-item"><span>Release date</span><strong>{PUNAM_RELEASE_DATE}</strong></div>
              <div className="alpha-diagnostics-item"><span>Channel</span><strong>{PUNAM_RELEASE_CHANNEL}</strong></div>
              <div className="alpha-diagnostics-item"><span>License</span><strong>{PUNAM_LICENSE}</strong></div>
            </div>
            <div className="alpha-about-list">
              {ALPHA_RELEASE_NOTES.map((note) => (
                <div key={note}>{note}</div>
              ))}
            </div>
            <div className="alpha-changelog">
              {PUNAM_CHANGELOG.map((line, index) => (
                <div key={`${line}-${index}`} className={index === 0 ? "alpha-changelog-title" : ""}>{line}</div>
              ))}
            </div>
            <div className="alpha-modal-actions">
              <button className="btn-secondary compact" onClick={() => handleOpenExternal(PUNAM_WEBSITE_URL)}>
                <Globe size={14} />
                Website
              </button>
              <button className="btn-secondary compact" onClick={() => handleOpenExternal(PUNAM_GITHUB_URL)}>
                <ExternalLink size={14} />
                GitHub
              </button>
              <button className="btn-secondary compact" onClick={() => handleGenerateDiagnostics()} disabled={diagnosticsBusy}>
                <FileText size={14} />
                Diagnostics
              </button>
              <button className="btn-secondary compact" onClick={handleCheckForUpdates}>
                <RefreshCw size={14} />
                Check for Updates
              </button>
              <button className="btn-primary compact" onClick={handleJoinDiscord}>
                <ExternalLink size={14} />
                Discord
              </button>
            </div>
          </div>
        </div>
      )}

      {showFirstRunWelcome && (
        <div className="alpha-modal-overlay" onClick={() => setShowFirstRunWelcome(false)}>
          <div className="alpha-modal alpha-first-run" onClick={(event) => event.stopPropagation()}>
            <div className="alpha-modal-header">
              <div className="alpha-about-title">
                <img src="/logo_transparent.png" alt="PunamIDE" />
                <div>
                  <h2>Welcome to PunamIDE</h2>
                  <p>Set up the essentials for your first alpha session.</p>
                </div>
              </div>
              <button className="toolbar-btn" onClick={() => setShowFirstRunWelcome(false)} aria-label="Close welcome">
                <X size={15} />
              </button>
            </div>
            <div className="alpha-onboarding-steps">
              <button onClick={() => { setShowSettings(true); setShowFirstRunWelcome(false); }}>
                <span>1</span>
                <strong>Choose AI Provider</strong>
                <small>Gemini, OpenAI-compatible, Groq, OpenRouter, or local Ollama.</small>
              </button>
              <button onClick={() => { setShowSettings(true); setShowFirstRunWelcome(false); }}>
                <span>2</span>
                <strong>Configure API Key</strong>
                <small>Keys stay in your local Punam settings store.</small>
              </button>
              <button onClick={() => { setShowSettings(true); setShowFirstRunWelcome(false); }}>
                <span>3</span>
                <strong>Select Theme</strong>
                <small>Choose the editor look before settling in.</small>
              </button>
              <button onClick={() => { setShowFirstRunWelcome(false); handleOpenFolder(); }}>
                <span>4</span>
                <strong>Open Sample Project</strong>
                <small>Pick a local folder to start exploring Punam.</small>
              </button>
            </div>
            <div className="alpha-modal-actions">
              <button className="btn-secondary compact" onClick={() => setShowFirstRunWelcome(false)}>Skip</button>
              <button className="btn-primary compact" onClick={() => { setShowSettings(true); setShowFirstRunWelcome(false); }}>
                Start Setup
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Settings Modal */}
      {showSettings && (
        <SettingsPanel
          config={config}
          onConfigChange={setConfig}
          onClose={() => setShowSettings(false)}
          onProvidersChange={setAiProviders}
          onMcpServersChange={setMcpServers}
          projectPath={projectPath}
          inlineCompletionEnabled={inlineCompletionEnabled}
          onInlineCompletionChange={async (enabled) => {
            setInlineCompletionEnabled(enabled);
            await saveInlineCompletionEnabled(enabled);
          }}
        />
      )}

      {showRunProfiles && (
        <RunProfiles
          profiles={runProfiles}
          onChange={setRunProfiles}
          onSave={handleSaveRunProfiles}
          onClose={() => setShowRunProfiles(false)}
        />
      )}

      {showCommandPalette && (
        <CommandPalette
          commands={commandActions}
          onClose={() => setShowCommandPalette(false)}
        />
      )}

      {showImportPanel && (
        <div className="import-panel-overlay">
          <Suspense fallback={null}>
            <ImportPanel
              onProjectImported={async (importedPath) => {
                setShowImportPanel(false);
                try {
                  await setProjectRoot(importedPath);
                  await saveRecentProjectPath(importedPath);
                  await addRecentProject(importedPath);
                  setRecentProjects(prev => [{ path: importedPath, openedAt: Date.now() }, ...prev.filter(p => p.path !== importedPath)].slice(0, 8));
                  setProjectPath(importedPath);
                  setTabs([]);
                  setActiveTab("");
                  setProblems([]);
                  setTerminalOutput("");
                  setGitRefreshKey((key) => key + 1);
                } catch (err) {
                  console.error("Failed to open imported project:", err);
                }
              }}
              onClose={() => setShowImportPanel(false)}
            />
          </Suspense>
        </div>
      )}

      {pendingReview && (
        <MultiFileDiffBoard
          changes={pendingReview.changes}
          onApplyAll={handleApplyReviewedAll}
          onApplyFile={handleApplyReviewedFile}
          onRejectFile={handleRejectReviewedFile}
          onCancel={() => closePendingReview(false)}
        />
      )}

      {showShortcuts && (
        <div className="shortcuts-overlay" onClick={() => setShowShortcuts(false)}>
          <div className="shortcuts-panel" onClick={(e) => e.stopPropagation()}>
            <div className="shortcuts-panel-header">
              <h2>Keyboard Shortcuts</h2>
              <button className="icon-btn small" onClick={() => setShowShortcuts(false)} aria-label="Close"><X size={14} /></button>
            </div>
            <div className="shortcuts-grid">
              <div className="shortcuts-section">
                <h3>Files &amp; Tabs</h3>
                <div className="shortcut-row"><kbd>Ctrl+P</kbd><span>Quick open file</span></div>
                <div className="shortcut-row"><kbd>Ctrl+S</kbd><span>Save file</span></div>
                <div className="shortcut-row"><kbd>Ctrl+W</kbd><span>Close tab</span></div>
                <div className="shortcut-row"><kbd>Ctrl+Tab</kbd><span>Next tab</span></div>
                <div className="shortcut-row"><kbd>Ctrl+Shift+Tab</kbd><span>Previous tab</span></div>
                <div className="shortcut-row"><kbd>Ctrl+\</kbd><span>Toggle split editor</span></div>
              </div>
              <div className="shortcuts-section">
                <h3>Editor</h3>
                <div className="shortcut-row"><kbd>Ctrl+K</kbd><span>Inline edit (AI)</span></div>
                <div className="shortcut-row"><kbd>Ctrl+Shift+D</kbd><span>Generate docs (AI)</span></div>
                <div className="shortcut-row"><kbd>Ctrl+Shift+T</kbd><span>Generate tests (AI)</span></div>
                <div className="shortcut-row"><kbd>Ctrl+Z</kbd><span>Undo</span></div>
                <div className="shortcut-row"><kbd>Ctrl+Y</kbd><span>Redo</span></div>
                <div className="shortcut-row"><kbd>Ctrl+D</kbd><span>Select next occurrence</span></div>
                <div className="shortcut-row"><kbd>Ctrl+/</kbd><span>Toggle comment</span></div>
                <div className="shortcut-row"><kbd>Ctrl+Shift+E</kbd><span>Explain selection (AI)</span></div>
                <div className="shortcut-row"><kbd>Tab</kbd><span>Accept inline completion</span></div>
              </div>
              <div className="shortcuts-section">
                <h3>Panels &amp; Views</h3>
                <div className="shortcut-row"><kbd>Ctrl+B</kbd><span>Toggle sidebar</span></div>
                <div className="shortcut-row"><kbd>Ctrl+`</kbd><span>Toggle terminal</span></div>
                <div className="shortcut-row"><kbd>Ctrl+Shift+F</kbd><span>Find &amp; replace</span></div>
                <div className="shortcut-row"><kbd>Ctrl+Shift+G</kbd><span>Git panel</span></div>
                <div className="shortcut-row"><kbd>Ctrl+Shift+H</kbd><span>GitHub panel</span></div>
                <div className="shortcut-row"><kbd>Ctrl+Shift+P</kbd><span>Command palette</span></div>
                <div className="shortcut-row"><kbd>F1</kbd><span>Command palette</span></div>
                <div className="shortcut-row"><kbd>F11</kbd><span>Zen mode</span></div>
              </div>
              <div className="shortcuts-section">
                <h3>Settings &amp; Tools</h3>
                <div className="shortcut-row"><kbd>Ctrl+,</kbd><span>Settings</span></div>
                <div className="shortcut-row"><kbd>Ctrl+Shift+Z</kbd><span>Zen mode</span></div>
                <div className="shortcut-row"><kbd>Esc</kbd><span>Close modal / dismiss</span></div>
              </div>
              <div className="shortcuts-section">
                <h3>Chat &amp; AI</h3>
                <div className="shortcut-row"><kbd>Enter</kbd><span>Send message</span></div>
                <div className="shortcut-row"><kbd>Shift+Enter</kbd><span>New line in chat</span></div>
                <div className="shortcut-row"><kbd>@codebase</kbd><span>Load all files into context</span></div>
                <div className="shortcut-row"><kbd>@git</kbd><span>Add git history to context</span></div>
                <div className="shortcut-row"><kbd>@web</kbd><span>Search web before asking</span></div>
                <div className="shortcut-row"><kbd>@notes</kbd><span>Include project notes</span></div>
              </div>
              <div className="shortcuts-section">
                <h3>Refresh &amp; Debugger</h3>
                <div className="shortcut-row"><kbd>F5</kbd><span>Refresh PunamIDE</span></div>
                <div className="shortcut-row"><kbd>Ctrl+F5</kbd><span>Refresh PunamIDE</span></div>
                <div className="shortcut-row"><kbd>Shift+F5</kbd><span>Stop debugging</span></div>
                <div className="shortcut-row"><kbd>F10</kbd><span>Step over</span></div>
                <div className="shortcut-row"><kbd>F11</kbd><span>Step into</span></div>
                <div className="shortcut-row"><kbd>Shift+F11</kbd><span>Step out</span></div>
                <div className="shortcut-row"><kbd>F6</kbd><span>Pause</span></div>
              </div>
              <div className="shortcuts-section">
                <h3>Terminal</h3>
                <div className="shortcut-row"><kbd>↑ / ↓</kbd><span>Command history</span></div>
                <div className="shortcut-row"><kbd>Ctrl+C</kbd><span>Stop running process</span></div>
                <div className="shortcut-row"><kbd>clear</kbd><span>Clear terminal output</span></div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Bug Hunt */}
      {showBugHunt && projectPath && (
        <Suspense fallback={null}>
          <BugHunt
            projectPath={projectPath}
            runProfiles={runProfiles}
            aiProviders={aiProviders}
            legacyProvider={config.provider}
            legacyModel={config.model}
            legacyApiKey={config.api_key}
            onClose={() => setShowBugHunt(false)}
            onApplyFix={async (parsed) => {
              await applyParsedChanges(parsed);
            }}
            onJumpToFile={async (filePath, line) => {
              const fullPath = /^[A-Za-z]:[\\/]/.test(filePath) || filePath.startsWith("/")
                ? filePath
                : getProjectFilePath(filePath);
              await handleFileSelect(fullPath);
              setEditorLine(line);
            }}
          />
        </Suspense>
      )}

      {/* Zen mode exit button — only rendered when in zen mode */}
      {zenMode && (
        <button
          className="zen-mode-exit-btn"
          onClick={() => setZenMode(false)}
          title="Exit Zen Mode (F11 or Esc)"
          aria-label="Exit zen mode"
        >
          <Minimize2 size={13} />
          Exit Zen Mode
        </button>
      )}

      {/* Toast Notifications */}
      <div className="toast-container">
        {toasts.map((toast) => {
          const icons: Record<string, string> = { success: "✓", error: "✕", warning: "⚠", info: "ℹ" };
          return (
            <div key={toast.id} className={`toast toast-${toast.type}`} role="alert">
              <span className="toast-icon">{icons[toast.type]}</span>
              <span className="toast-message">{toast.message}</span>
              <button className="toast-close" onClick={() => setToasts((prev) => prev.filter((t) => t.id !== toast.id))} aria-label="Dismiss">×</button>
              <div className="toast-progress" />
            </div>
          );
        })}
      </div>

      {/* Confirm Dialog (replaces window.prompt for unsaved changes) */}
      {confirmDialog && (
        <ConfirmDialog
          title="Unsaved Changes"
          message={confirmDialog.message}
          onSave={() => closePendingConfirm("save")}
          onDiscard={() => closePendingConfirm("discard")}
          onCancel={() => closePendingConfirm("cancel")}
        />
      )}

      {/* Background Agent Progress Panel */}
      <BackgroundAgentPanel />
    </div>
  );
}
