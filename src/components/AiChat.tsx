import { useState, useRef, useEffect, useCallback } from "react";
import type { ElementType } from "react";
import {
  User,
  Loader2,
  Check,
  Wrench,
  MessageCircle,
  FileText,
  Zap,
  Image,
  Route,
  ListChecks,
  AlertCircle,
  GitFork,
} from "lucide-react";
import { callLlm, readFile, searchProject, getProjectIndex } from "../utils/tauri";
import type { AppConfig, FileEntry } from "../utils/tauri";
import { checkTcpPort, runTerminalCommand } from "../utils/tauri";
import type { MCPServerConfig } from "../utils/mcp";
import { buildMcpToolsPrompt, parseMcpCalls, mcpCallTool, formatMcpResult } from "../utils/mcp";
import { SYSTEM_PROMPT, parseResponse } from "../utils/prompts";
import type { ParsedResponse } from "../utils/prompts";
import { sendToMultipleModels, sendToProviderStreaming, estimateTokens } from "../utils/providers";
import type { AIProviderConfig, ResponseMetrics } from "../utils/providers";
// recordUsage accessed via recordResponseUsage from ./chat/types
import { buildMemoryContext } from "../services/memory/MemoryManager";
import { detectFrameworks } from "../utils/contextGathering";
import { indexProject, searchCodebase, isIndexed } from "../utils/codebaseIndex";

import type { ChatMessage, ProjectCheckResult, OpenTabContext, AgentMode } from "../types";
export type { ProjectCheckResult };

// Extracted modules
import {
  buildFileContext,
  getProjectFilePath,
  getRelativePath,
  truncateContext,
  getMentionedFilePaths,
  getMentionedFolderFiles,
  getUnresolvedMentions,
  getFilePathsFromText,
  resolveEditOperations,
  buildGitContext,
  KEY_CONTEXT_FILES,
  PROJECT_RULES_FILES,
  MAX_CONTEXT_FILE_CHARS,
  MAX_TOTAL_CONTEXT_CHARS,
} from "../utils/chatHelpers";
import { MarkdownMessage, PunamAvatar, ResponseMetricsDisplay, getActionLabel, formatAgentStep, APPLY_CODE_EVENT } from "./chat/ChatComponents";
import { getAgentOrchestrator } from "../services/agent/AgentOrchestrator";
import { getConflictResolver } from "../services/agent/ConflictResolver";
import { validateApply } from "../services/agent/AgentApplyGuard";
import { ChatHeader } from "./chat/ChatHeader";
import { ChatInputArea } from "./chat/ChatInputArea";
import { useChatSessions } from "../hooks/useChatSessions";
import { useAttachments } from "../hooks/useAttachments";
import { parseResponseAsync } from "../hooks/useAiWorker";
import {
  assemblePersistentPayload,
  fetchRustContext,
  loadAgentMemories,
  compressMemories,
  summarizeOldMessages,
  extractMemoriesFromResponse,
} from "../utils/contextEngine";
import { runAgentToolLoop } from "../utils/agentToolLoop";
import { buildInternalToolInventoryPrompt } from "../utils/agentTools";
import { decideAgentRoute } from "../services/agent/AgentRuntime";
import { resolveMentions } from "../utils/mentionResolver";
import { useEditPreview } from "../hooks/useEditPreview";
import EditPreviewPanel from "./EditPreviewPanel";
import { detectTaskType } from "../lib/ai/taskDetection";
import { selectAdaptiveProvider } from "../lib/ai/adaptiveRouter";
import { useAIStore } from "../store/aiStore";
import type { AdaptiveStrategy } from "../lib/ai/providerCapabilities";
import { classifyProviderError, describeHealthStatus, markProviderHealthy, setProviderHealth } from "../lib/ai/providerHealth";
import type { RunObservation } from "../services/run/verifiedRun";
import { parseStreamBlocks, resetParseState, createBlockParser } from "../utils/streamBlocks";
import type { BlockParser } from "../utils/streamBlocks";
import type { BlockParseResult } from "../utils/protocol";
import ThinkingBlock from "./chat/ThinkingBlock";
import MessageBubble from "./chat/MessageBubble";

// Background agent store
import { useBackgroundAgentStore } from "../store/backgroundAgentStore";
import type { CodeReference } from "../store/backgroundAgentStore";
import { startBackgroundExecution } from "../services/backgroundAgentExecutor";

// Reasoning Panel
import ReasoningPanel from "./ReasoningPanel";
import { useEditorStore } from "../store/editorStore";

// Approval Gate overlay
import AgentApprovalGate from "./AgentApprovalGate";
import type { PatchProposalForUI } from "./AgentApprovalGate";
import type { ApprovalDecision } from "../utils/toolLoops/approvalGate";

// Clarification Protocol
import ClarificationDialog from "./ClarificationDialog";
import type { AmbiguityReport } from "../services/agent/AmbiguityDetector";

// Budget Enforcement UI
import { BudgetSelector } from "./BudgetSelector";
import BudgetWarningDialog from "./BudgetWarningDialog";
import TaskCostSummary from "./TaskCostSummary";
import type { TokenBudget, BudgetStatus, BudgetConsumed, BudgetRemaining } from "../services/agent/BudgetController";

// Context Budget Indicator
import ContextBudgetIndicator from "./ContextBudgetIndicator";
import type { ContextBudgetInfo } from "./ContextBudgetIndicator";

// --- Agent Task Types (extracted to ./chat/types.ts) ---
import type { AgentStep, AgentTaskState, AgentTrace, AiChatProps } from "./chat/types";
import { hasParsedActions, parseAgentTraceMessage, summarizeCommandOutput, hasUsableProvider as hasUsableProviderFn, recordResponseUsage, createAgentTask } from "./chat/types";
import { AGENT_MODES, MODE_LABELS, looksLikeDependencyDrift } from "./chat/constants";
import { AgentTraceCard } from "./chat/AgentTraceCard";
import ToolCallCard from "./chat/ToolCallCard";
import ToolResultCard from "./chat/ToolResultCard";
import { ParsedActionsView } from "./chat/ParsedActionsView";
import { finalizeResponseBlocks, applyFinalizationToMessages, generateStreamId, formatToolTrace, type ToolTraceEntry } from "./chat/services/responseFinalization";
import { buildLlmPrompt } from "./chat/services/promptBuilder";
import { buildAgentContext } from "./chat/services/agentContextBuilder";
import { buildProjectContext as buildProjectContextExtracted, collectExistingFiles as collectExistingFilesExtracted, countFileEntries, getWorkspaceName, getIdentityResponse } from "./chat/context";

// AgentTrace + parseAgentTraceMessage imported from ./chat/types

// AgentTraceCard extracted to ./chat/AgentTraceCard.tsx

// ParsedActionsView extracted to ./chat/ParsedActionsView.tsx

interface Props {
  config: AppConfig;
  projectPath: string;
  files: FileEntry[];
  openTabs: OpenTabContext[];
  activeFilePath?: string;
  selectedText?: string;
  problems?: Array<{ severity: string; message: string; path: string; line: number }>;
  terminalOutput?: string;
  aiProviders?: AIProviderConfig[];
  proactiveError?: { command: string; output: string } | null;
  runObservation?: RunObservation | null;
  onDismissProactiveError?: () => void;
  onDismissRunObservation?: () => void;
  checkResult?: ProjectCheckResult | null;
  checkingProject?: boolean;
  onRunProjectCheck?: () => void;
  onApplyChanges: (parsed: ParsedResponse) => Promise<boolean>;
  onApplyDirect?: (parsed: ParsedResponse) => Promise<void>;
  onRunCommand?: (cmd: string) => void;
  onRevertLastApply?: () => Promise<void>;
  checkpointCount?: number;
  mcpServers?: MCPServerConfig[];
  projectNotes?: string;
  /** External prompt trigger from right-click context menu (explain/fix/refactor) */
  forcePrompt?: { text: string; mode?: string } | null;
  onForcePromptConsumed?: () => void;
}

// ── Unified Stream Callbacks Interface ────────────────────────────────────────
// Single internal interface for all streaming paths. Provider-agnostic — both
// Rust IPC and browser-fetch fallback funnel through these three callbacks.
export interface UnifiedStreamCallbacks {
  onStreamToken: (token: string, streamId: string) => void;
  onStreamComplete: (streamId: string, fullText: string, usage?: ResponseMetrics) => void;
  onStreamError: (streamId: string, error: string) => void;
}

// AGENT_MODES + MODE_LABELS imported from ./chat/constants

// hasUsableProvider + recordResponseUsage imported from ./chat/types
const hasUsableProvider = hasUsableProviderFn;

export default function AiChat({
  config,
  projectPath,
  files,
  openTabs,
  activeFilePath,
  selectedText,
  problems,
  terminalOutput,
  aiProviders = [],
  proactiveError,
  runObservation,
  onDismissProactiveError,
  onDismissRunObservation,
  checkResult,
  checkingProject,
  onRunProjectCheck,
  onApplyChanges,
  onApplyDirect,
  onRunCommand,
  onRevertLastApply,
  checkpointCount = 0,
  mcpServers = [],
  projectNotes = "",
  forcePrompt,
  onForcePromptConsumed,
}: Props) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [agentMode, setAgentMode] = useState<AgentMode>("chat");
  const [modelDropdownOpen, setModelDropdownOpen] = useState(false);
  const [activeModelOverride, setActiveModelOverride] = useState<{ providerId: string; model: string } | null>(null);
  const [loading, setLoading] = useState(false);
  const [cooldown, setCooldown] = useState(false);
  const [contextSummary, setContextSummary] = useState("");
  const [contextFiles, setContextFiles] = useState<string[]>([]);
  const [agentActivityText, setAgentActivityText] = useState("");
  const [sessionTokens, setSessionTokens] = useState<{ totalIn: number; totalOut: number; totalCostInr: number; requestCount: number }>({ totalIn: 0, totalOut: 0, totalCostInr: 0, requestCount: 0 });

  // --- Reasoning Panel Store Selectors ---
  const reasoningChunks = useBackgroundAgentStore((s) => s.reasoningChunks);
  const reasoningMode = useBackgroundAgentStore((s) => s.reasoningMode);
  const reasoningVisible = useBackgroundAgentStore((s) => s.reasoningVisible);
  const phaseTimings = useBackgroundAgentStore((s) => s.phaseTimings);
  const setReasoningMode = useBackgroundAgentStore((s) => s.setReasoningMode);
  const setReasoningVisible = useBackgroundAgentStore((s) => s.setReasoningVisible);

  // --- Reasoning Panel: code reference click handler ---
  const handleReasoningRefClick = useCallback((ref: CodeReference) => {
    // editorStore doesn't have openFileAtLine — use openTab as a fallback to navigate
    const store = useEditorStore.getState();
    const tab = store.tabs.find((t) => t.path === ref.filePath);
    if (tab) {
      store.setActiveTab(tab.id);
      store.setCursorPosition(ref.startLine, 1);
    } else {
      // No matching tab open — log for debugging
      console.log("[ReasoningPanel] Reference clicked:", ref.filePath, ref.startLine);
    }
  }, []);

  // --- Clarification Protocol State ---
  const [clarificationReport, setClarificationReport] = useState<AmbiguityReport | null>(null);
  const clarificationResolverRef = useRef<((answer: string) => void) | null>(null);

  // --- Budget Enforcement State ---
  const [taskBudget, setTaskBudget] = useState<TokenBudget | undefined>(undefined);
  const [budgetWarning, setBudgetWarning] = useState<{ status: BudgetStatus; consumed: BudgetConsumed; remaining: BudgetRemaining } | null>(null);
  const [taskCostSummary, setTaskCostSummary] = useState<BudgetConsumed | null>(null);
  const budgetWarningResolverRef = useRef<((decision: "continue" | "stop") => void) | null>(null);

  // --- Context Optimization State ---
  const [enableContextOptimization, setEnableContextOptimization] = useState(true);
  const [contextBudgetInfo, setContextBudgetInfo] = useState<ContextBudgetInfo | null>(null);

  // --- Extracted Hooks ---
  const {
    sessions,
    activeSessionId,
    showSessionList,
    setShowSessionList,
    handleNewSession,
    handleSwitchSession,
    handleDeleteSession,
    handleForkSession,
  } = useChatSessions({ projectPath, messages, setMessages });

  // --- Edit Preview (per-hunk accept/reject in chat mode) ---
  const {
    preview: editPreview,
    buildPreview: buildEditPreview,
    toggleItem: toggleEditItem,
    acceptAll: acceptAllEdits,
    rejectAll: rejectAllEdits,
    getAcceptedEdits,
    reset: resetEditPreview,
  } = useEditPreview();
  const [pendingEditParsed, setPendingEditParsed] = useState<any>(null);

  const {
    attachments,
    isDragOver,
    fileInputRef,
    handleFileAttach,
    handleFileInputChange,
    handlePaste,
    removeAttachment,
    handleDragOver,
    handleDragLeave,
    handleDrop,
    clearAttachments,
  } = useAttachments({ setMessages });

  // --- Multi-file Selection State (for refactoring) ---
  const [selectedProjectFiles, setSelectedProjectFiles] = useState<string[]>([]);
  const [showFilePicker, setShowFilePicker] = useState(false);
  // --- @web / @codebase / @git mention state ---
  const [webSearchResults, setWebSearchResults] = useState<string>("");

  // --- Stream abort + tracking ---
  const activeStreamRef = useRef<{ cancel: () => void; streamId: string; kind?: "chat" | "agent_stream" | "tool_loop" } | null>(null);
  const agentRunIdRef = useRef(0);
  const agentCancelledRef = useRef(false);

  // ── RAF Token Buffer (streaming architecture fix) ──────────────────────────
  // Accumulates incoming tokens without triggering re-renders. Flushed to React
  // state at most once per animation frame (~60 fps cap).
  const tokenBufferRef = useRef<string>('');
  const rafHandleRef = useRef<number | null>(null);
  const activeStreamIdRef = useRef<string | null>(null);
  // Block parser ref — uses factory pattern for per-stream instance isolation.
  // Each new stream gets a fresh BlockParser instance via createBlockParser().
  const blockParserRef = useRef<BlockParser>(createBlockParser());

  // State target for RAF-flushed streaming blocks (max ~60 updates/sec)
  const [streamingBlocks, setStreamingBlocks] = useState<BlockParseResult | null>(null);

  /**
   * Schedule a flush to React state at most once per animation frame.
   * Reads from tokenBufferRef, clears it, passes accumulated text to the
   * block parser, and updates streamingBlocks state.
   */
  const scheduleFlush = useCallback(() => {
    if (rafHandleRef.current !== null) return; // already scheduled
    rafHandleRef.current = requestAnimationFrame(() => {
      rafHandleRef.current = null;
      const buffered = tokenBufferRef.current;
      if (!buffered) return;
      tokenBufferRef.current = '';
      const parseResult = blockParserRef.current.appendStreamText(buffered);
      setStreamingBlocks(parseResult);
    });
  }, []);

  /**
   * Cancel any pending RAF flush. Used on unmount, stream error, and new stream start.
   */
  const cancelPendingFlush = useCallback(() => {
    if (rafHandleRef.current !== null) {
      cancelAnimationFrame(rafHandleRef.current);
      rafHandleRef.current = null;
    }
  }, []);

  /**
   * Final synchronous flush on stream completion.
   * Cancels any pending RAF, then immediately flushes remaining buffer.
   */
  const flushBufferSync = useCallback(() => {
    cancelPendingFlush();
    const buffered = tokenBufferRef.current;
    if (!buffered) return;
    tokenBufferRef.current = '';
    const parseResult = blockParserRef.current.appendStreamText(buffered);
    setStreamingBlocks(parseResult);
  }, [cancelPendingFlush]);

  /**
   * Reset buffer state for a new stream. Cancels pending RAF, clears the token
   * buffer, and resets streamingBlocks to null.
   */
  const resetTokenBuffer = useCallback(() => {
    cancelPendingFlush();
    tokenBufferRef.current = '';
    setStreamingBlocks(null);
  }, [cancelPendingFlush]);

  // Cleanup: cancel pending RAF on component unmount
  useEffect(() => {
    return () => {
      cancelPendingFlush();
    };
  }, [cancelPendingFlush]);

  // ── Unified Token Handler (streaming architecture fix) ──────────────────────
  // Single internal interface through which ALL streaming paths funnel tokens.
  // Both the Rust IPC listener and browser-fetch fallback wire into these same
  // three callbacks. The UI layer is provider-blind.

  /**
   * Handles an incoming token from any streaming source.
   * Guards against stale streamId, accumulates in buffer, schedules RAF flush.
   */
  const onStreamToken = useCallback((token: string, streamId: string) => {
    if (streamId !== activeStreamIdRef.current) return;
    tokenBufferRef.current += token;
    scheduleFlush();
  }, [scheduleFlush]);

  /**
   * Handles stream completion from any streaming source.
   * Cancels pending RAF, performs synchronous flush, then finalizes the message.
   */
  const onStreamComplete = useCallback((streamId: string, fullText: string, usage?: ResponseMetrics) => {
    if (streamId !== activeStreamIdRef.current) return;
    flushBufferSync();
    // Finalize: parse full text into blocks and mark message complete
    resetParseState();
    const finalBlocks = parseStreamBlocks(fullText).completed;
    setMessages((prev) => prev.map((m) => {
      if ((m as any).streamId !== streamId) return m;
      const { streamId: _sid, streamProgress: _sp, ...rest } = m as any;
      const blocks = finalBlocks.length > 0 ? finalBlocks : ((m as any).blocks || []);
      return {
        ...rest,
        content: fullText,
        blocks,
        isComplete: true,
        applied: false,
        metrics: usage,
      };
    }));
    activeStreamIdRef.current = null;
  }, [flushBufferSync]);

  /**
   * Handles stream error from any streaming source.
   * Cancels pending RAF, discards buffer, surfaces error in chat UI, clears active stream.
   * Creates a fresh parser instance so no corrupted state carries into the next stream.
   */
  const onStreamError = useCallback((streamId: string, error: string) => {
    if (streamId !== activeStreamIdRef.current) return;
    cancelPendingFlush();
    tokenBufferRef.current = '';
    activeStreamIdRef.current = null;
    // Release current parser instance and create fresh one for next stream
    blockParserRef.current = createBlockParser();
    // Surface error as a message in the chat UI
    setMessages((prev) => prev.map((m) => {
      if ((m as any).streamId !== streamId) return m;
      const { streamId: _sid, streamProgress: _sp, ...rest } = m as any;
      return {
        ...rest,
        content: `⚠️ ${error}`,
        isComplete: true,
      };
    }));
  }, [cancelPendingFlush]);

  // --- Approval Gate State ---
  const [pendingApprovalPatch, setPendingApprovalPatch] = useState<PatchProposalForUI | null>(null);
  const [_streamProgress, _setStreamProgress] = useState<{ tokens: number; startedAt: number } | null>(null);

  // ── Memory safety: cap messages at 200 to prevent unbounded growth in long sessions ──
  const MAX_MESSAGES = 200;
  const msgCapRef = useRef(false);
  useEffect(() => {
    if (msgCapRef.current) { msgCapRef.current = false; return; }
    if (messages.length > MAX_MESSAGES) {
      msgCapRef.current = true;
      // Keep first system message + last MAX_MESSAGES entries
      setMessages(prev => prev.slice(-MAX_MESSAGES));
    }
  }, [messages.length]);

  // --- Auto-send forcePrompt from right-click context menu ---
  useEffect(() => {
    if (forcePrompt && forcePrompt.text && !loading) {
      const prefixes: Record<string, string> = {
        explain: "Explain the following code in detail:\n\n",
        fix: "Fix the following code. Only output the fixed code:\n\n",
        refactor: "Refactor this code for readability:\n\n",
      };
      const fullPrompt = (prefixes[forcePrompt.mode || "explain"] || "") + forcePrompt.text;
      requestPunam(fullPrompt, "chat");
      onForcePromptConsumed?.();
    }
  }, [forcePrompt?.text, forcePrompt?.mode]);

  // --- Auto-index project for TF-IDF search ---
  // Deferred by 2s to avoid racing with readDirectory and the Rust indexing pipeline.
  // The UI needs those first seconds to render the file tree and become interactive.
  useEffect(() => {
    if (!projectPath || !files.length) return;
    if (isIndexed()) return;

    const timer = setTimeout(() => {
      if (!isIndexed()) {
        indexProject(projectPath, files).catch(() => {});
      }
    }, 2000);

    return () => clearTimeout(timer);
  }, [projectPath, files]);

  // --- File-save event listener: invalidate repo map cache within 2 seconds (Requirement 1.6) ---
  useEffect(() => {
    if (!projectPath) return;

    let debounceTimer: ReturnType<typeof setTimeout> | null = null;
    let unlistenFn: (() => void) | null = null;

    const setupListener = async () => {
      try {
        const { listen } = await import("@tauri-apps/api/event");
        const unlisten = await listen<{ path: string }>("file-changed", () => {
          // Debounce: invalidate repo map cache within 2 seconds of file save
          if (debounceTimer) clearTimeout(debounceTimer);
          debounceTimer = setTimeout(() => {
            useAIStore.getState().invalidateRepoMap();
          }, 2000);
        });
        unlistenFn = unlisten;
      } catch {
        // Tauri event not available — no-op
      }
    };

    setupListener();

    return () => {
      if (debounceTimer) clearTimeout(debounceTimer);
      if (unlistenFn) unlistenFn();
    };
  }, [projectPath]);

  // --- Approval Gate event listener: show overlay when agent requires approval ---
  useEffect(() => {
    let unlistenFn: (() => void) | null = null;

    const setupApprovalListener = async () => {
      try {
        const { listen } = await import("@tauri-apps/api/event");
        const unlisten = await listen<PatchProposalForUI>("agent:approval_required", (event) => {
          const payload = event.payload as any;
          // Build a PatchProposalForUI from the event payload
          const proposal: PatchProposalForUI = {
            id: payload.patchId,
            unifiedDiff: payload.diff,
            filesAffected: payload.filesAffected || [],
            linesChanged: payload.linesChanged || 0,
            agentReasoning: payload.agentReasoning || "Agent proposed this edit.",
            hunks: payload.hunks || [],
            createdAt: Date.now(),
          };
          setPendingApprovalPatch(proposal);
        });
        unlistenFn = unlisten;
      } catch {
        // Tauri event not available — no-op
      }
    };

    setupApprovalListener();

    return () => {
      if (unlistenFn) unlistenFn();
    };
  }, []);

  // --- Apply from Chat code blocks (APPLY_CODE_EVENT listener) ---
  // When user clicks "Apply to File" on a code block in the chat, this writes
  // the code to the currently active file via the diff preview system.
  useEffect(() => {
    const handleApplyCode = (e: Event) => {
      const { code } = (e as CustomEvent<{ code: string; language: string }>).detail;
      if (!code || !activeFilePath || !onApplyChanges) return;

      // Build a minimal ParsedResponse to go through the existing diff preview flow
      const relativePath = activeFilePath.replace(projectPath, "").replace(/^[\\/]/, "").replace(/\\/g, "/");
      const parsed = {
        explanation: "Apply code from chat",
        fileChanges: [{ path: relativePath, content: code, isNew: false }],
        editOperations: [],
        deletions: [],
        commands: [],
      };
      onApplyChanges(parsed);
    };

    window.addEventListener(APPLY_CODE_EVENT, handleApplyCode);
    return () => window.removeEventListener(APPLY_CODE_EVENT, handleApplyCode);
  }, [activeFilePath, projectPath, onApplyChanges]);

  // --- LLM Stream Usage event listener: consume token usage from Rust backend ---
  // Listens for "llm-stream-usage" IPC events, guards against stale stream_id,
  // and updates the corresponding message's metrics with input/output token counts.
  // The existing session totals useEffect (below) auto-recalculates within 300ms.
  useEffect(() => {
    let unlistenFn: (() => void) | null = null;

    const setupUsageListener = async () => {
      try {
        const { listen } = await import("@tauri-apps/api/event");
        const unlisten = await listen<{ stream_id: string; input_tokens?: number; output_tokens?: number }>("llm-stream-usage", (event) => {
          const { stream_id, input_tokens, output_tokens } = event.payload;

          // Guard: only process if matches active stream (discard stale events)
          if (stream_id !== activeStreamIdRef.current) return;

          // Update the last assistant message's metrics with reported token counts.
          // If stream completes without usage data, this simply never fires and
          // previously estimated counts are retained (Requirement 9.5).
          setMessages(prev => {
            const updated = [...prev];
            // Find the last assistant message (the one being streamed)
            for (let i = updated.length - 1; i >= 0; i--) {
              if (updated[i].role === "assistant") {
                const existing = updated[i].metrics;
                updated[i] = {
                  ...updated[i],
                  metrics: {
                    ...(existing || { provider: "", model: "", durationMs: 0, status: "success" as const }),
                    promptTokens: input_tokens ?? existing?.promptTokens,
                    responseTokens: output_tokens ?? existing?.responseTokens,
                    totalTokens: (input_tokens ?? existing?.promptTokens ?? 0) + (output_tokens ?? existing?.responseTokens ?? 0),
                  },
                };
                break;
              }
            }
            return updated;
          });
        });
        unlistenFn = unlisten;
      } catch {
        // Tauri event not available — no-op
      }
    };

    setupUsageListener();

    return () => {
      if (unlistenFn) unlistenFn();
    };
  }, []);

  // Compute session totals from messages with metrics (debounced)
  const tokenComputeTimerRef = useRef<number | null>(null);
  useEffect(() => {
    if (tokenComputeTimerRef.current !== null) {
      window.clearTimeout(tokenComputeTimerRef.current);
    }
    tokenComputeTimerRef.current = window.setTimeout(() => {
      tokenComputeTimerRef.current = null;
      let totalIn = 0, totalOut = 0, totalCostInr = 0, requestCount = 0;
      for (const msg of messages) {
        if (msg.metrics) {
          totalIn += msg.metrics.promptTokens || 0;
          totalOut += msg.metrics.responseTokens || 0;
          totalCostInr += msg.metrics.estimatedCostInr || 0;
          requestCount++;
        }
        if (msg.multiResponses) {
          for (const resp of msg.multiResponses) {
            totalIn += resp.metrics.promptTokens || 0;
            totalOut += resp.metrics.responseTokens || 0;
            totalCostInr += resp.metrics.estimatedCostInr || 0;
            requestCount++;
          }
        }
      }
      setSessionTokens({ totalIn, totalOut, totalCostInr, requestCount });
    }, 300);

    return () => {
      if (tokenComputeTimerRef.current !== null) {
        window.clearTimeout(tokenComputeTimerRef.current);
      }
    };
  }, [messages]);
  const chatMessagesRef = useRef<HTMLDivElement>(null);
  const isInitialLoad = useRef(true);

  // --- Agent Task State ---
  const [agentTask, setAgentTask] = useState<AgentTaskState | null>(null);

  // --- Image Lightbox State ---
  const [lightboxSrc, setLightboxSrc] = useState<string | null>(null);

  // --- Clarification Protocol Handlers ---
  const handleClarificationNeeded = useCallback((report: AmbiguityReport): Promise<string> => {
    setClarificationReport(report);
    return new Promise<string>((resolve) => {
      clarificationResolverRef.current = resolve;
    });
  }, []);

  const handleClarificationAnswer = useCallback((answer: string) => {
    setClarificationReport(null);
    clarificationResolverRef.current?.(answer);
    clarificationResolverRef.current = null;
  }, []);

  const handleClarificationSkip = useCallback(() => {
    setClarificationReport(null);
    clarificationResolverRef.current?.("");
    clarificationResolverRef.current = null;
  }, []);

  // --- Budget Warning Handlers ---
  const handleBudgetWarning = useCallback(async (
    status: BudgetStatus,
    consumed: BudgetConsumed,
    remaining: BudgetRemaining,
  ): Promise<"continue" | "stop"> => {
    setBudgetWarning({ status, consumed, remaining });
    return new Promise<"continue" | "stop">((resolve) => {
      budgetWarningResolverRef.current = resolve;
    });
  }, []);

  const handleBudgetDecision = useCallback((decision: "continue" | "stop") => {
    setBudgetWarning(null);
    budgetWarningResolverRef.current?.(decision);
    budgetWarningResolverRef.current = null;
  }, []);

  // handleExportChat â€” delegates to extracted service
  const handleExportChat = async () => {
    const { exportChatToMarkdown } = await import("./chat/services/exportChat");
    const activeSession = sessions.find((s) => s.id === activeSessionId);
    const title = activeSession?.title || "Punam Chat";
    const result = await exportChatToMarkdown(messages, title);
    if (result.message) {
      setMessages((prev) => [...prev, { role: "assistant", content: result.message }]);
    }
  };
  // ── Scroll Controller (decoupled from content changes) ──────────────────────
  // Auto-scroll triggers ONLY on messages.length change, not on token content.
  // User scroll-up is detected via onScroll handler (threshold: >100px disables,
  // ≤50px re-enables). Uses scrollIntoView({ behavior: 'auto' }) for instant scroll.
  const scrollRafRef = useRef<number | null>(null);
  const isUserScrolledUpRef = useRef<boolean>(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  // Schedule a scroll-to-bottom within a single RAF callback, coalescing multiple triggers
  const scrollToBottom = useCallback(() => {
    if (isUserScrolledUpRef.current) return; // respect user reading position
    if (scrollRafRef.current !== null) return; // already scheduled
    scrollRafRef.current = requestAnimationFrame(() => {
      scrollRafRef.current = null;
      if (!isUserScrolledUpRef.current) {
        messagesEndRef.current?.scrollIntoView({ behavior: 'auto' });
      }
    });
  }, []);

  // Cancel any pending scroll RAF (used on unmount or stream change)
  const cancelPendingScroll = useCallback(() => {
    if (scrollRafRef.current !== null) {
      cancelAnimationFrame(scrollRafRef.current);
      scrollRafRef.current = null;
    }
  }, []);

  // Detect user scroll position to enable/disable auto-scroll
  const handleChatScroll = useCallback(() => {
    const container = chatMessagesRef.current;
    if (!container) return;
    const distanceFromBottom = container.scrollHeight - container.scrollTop - container.clientHeight;
    if (distanceFromBottom > 100) {
      // User scrolled up — disable auto-scroll
      isUserScrolledUpRef.current = true;
    } else if (distanceFromBottom <= 50) {
      // User scrolled back near bottom — re-enable auto-scroll
      isUserScrolledUpRef.current = false;
    }
  }, []);

  // Auto-scroll on messages.length change only (not on token content)
  useEffect(() => {
    const container = chatMessagesRef.current;
    if (!container) return;

    if (isInitialLoad.current) {
      if (messages.length > 0) {
        container.scrollTop = container.scrollHeight;
        isInitialLoad.current = false;
      }
      return;
    }

    if (!isUserScrolledUpRef.current) {
      messagesEndRef.current?.scrollIntoView({ behavior: 'auto' });
    }

    return () => {
      cancelPendingScroll();
    };
  }, [messages.length, cancelPendingScroll]);

  // Cleanup: cancel pending scroll RAF on unmount or active stream change
  useEffect(() => {
    return () => {
      cancelPendingScroll();
    };
  }, [activeStreamIdRef.current, cancelPendingScroll]);

  useEffect(() => {
    if (!checkResult) return;

    const passed = checkResult.exitCode === 0;
    const output = `${checkResult.stdout}${checkResult.stderr ? `\n${checkResult.stderr}` : ""}`.trim();
    setMessages((prev) => {
      if (prev.some((message) => message.checkResult?.id === checkResult.id)) return prev;

      return [
        ...prev,
        {
          role: "assistant",
          content: passed
            ? `Project check passed: ${checkResult.command}`
            : `Project check failed: ${checkResult.command}`,
          checkResult: {
            ...checkResult,
            stdout: output.slice(0, 12000),
            stderr: "",
          },
        },
      ];
    });
  }, [checkResult]);

  // getIdentityResponse imported from ./chat/context/identityResponses

  // ── Project file list — loaded once from Rust project index ───────────────
  const allProjectFilesRef = useRef<Set<string>>(new Set());

  // Load all project file paths from the Rust index on mount / project change
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const entries = await getProjectIndex();
        if (cancelled) return;
        const prefix = projectPath.replace(/\\/g, "/").replace(/\/+$/, "") + "/";
        const paths = new Set<string>();
        for (const e of entries) {
          const absPath = e.path.replace(/\\/g, "/");
          paths.add(absPath.startsWith(prefix) ? absPath.slice(prefix.length) : absPath);
        }
        allProjectFilesRef.current = paths;
      } catch {
        // Index not available — keep empty set
      }
    })();
    return () => { cancelled = true; };
  }, [projectPath]);

  /** Synchronous getter for all existing project file paths (used at 13 call sites) */
  const collectExistingFiles = () => allProjectFilesRef.current;

  /**
   * Resolve edit operations with optional preview in chat mode.
   * In agent mode: applies immediately (fast autonomous flow).
   * In chat mode: shows the EditPreviewPanel for per-hunk accept/reject.
   */
  const resolveEditsWithPreview = async (
    parsed: any,
    mode: AgentMode,
  ): Promise<any> => {
    if (!parsed || !parsed.editOperations || parsed.editOperations.length === 0) {
      return parsed;
    }

    // Agent mode: apply immediately (autonomous flow, no interruptions)
    if (mode === "agent") {
      return resolveEditOperations(parsed, projectPath);
    }

    // Chat mode: show preview panel for user review
    buildEditPreview(parsed.editOperations);
    setPendingEditParsed(parsed);
    // Return parsed as-is (edits NOT applied yet — user must review)
    return { ...parsed, editOperations: [] };
  };

  /** Called when user clicks "Apply" in the EditPreviewPanel */
  const handleApplyAcceptedEdits = async () => {
    if (!pendingEditParsed) return;
    const accepted = getAcceptedEdits();
    if (accepted.length > 0) {
      // Build a synthetic parsed response with only accepted edits
      const filteredParsed = {
        ...pendingEditParsed,
        editOperations: accepted,
      };
      await resolveEditOperations(filteredParsed, projectPath);
    }
    resetEditPreview();
    setPendingEditParsed(null);
  };

  /** Called when user dismisses the preview without applying */
  const handleDismissEditPreview = () => {
    resetEditPreview();
    setPendingEditParsed(null);
  };

  /**
   * Unified context builder — single-pass with deduplication.
   * Priority order (highest to lowest): open tabs, @mentions, key files, @codebase/search hits, errors.
   * Files already loaded by mentionResolver are tracked to avoid re-reads.
   */
  // buildProjectContext â€” delegates to extracted module
  const buildProjectContext = async (userPrompt = "", alreadyLoadedResolved?: Set<string>) => {
    const result = await buildProjectContextExtracted({
      userPrompt,
      projectPath,
      files,
      openTabs,
      activeFilePath,
      selectedProjectFiles,
      terminalOutput,
      proactiveError,
      agentMode,
      projectNotes,
      webSearchResults,
      alreadyLoadedResolved,
    });
    setContextFiles(result.attachedFileNames);
    setContextSummary(result.contextSummary);
    if (webSearchResults) setWebSearchResults(""); // consume once
    return result.contextText;
  };
  const requestPunam = async (userPrompt: string, mode: AgentMode = agentMode) => {
    // Check if any API key is available (new provider system OR legacy config)
    const providerReady = Boolean(config.api_key) || aiProviders.some(hasUsableProvider);
    if (!providerReady) {
      setMessages((prev) => [
        ...prev,
        { role: "assistant", content: "No model is ready yet. Add an API key or enable a local provider in Settings, then try again." },
      ]);
      return;
    }

    setLoading(true);

    try {
      // ── Resolve @mentions in the prompt ───────────────────────────────────
      const mentionSources = {
        projectPath,
        files,
        allProjectFiles: Array.from(collectExistingFiles()),
        selectedText: selectedText || "",
        terminalOutput: terminalOutput || "",
        problemsRaw: problems
          ? problems.map((p) => `[${p.severity}] ${p.path}:${p.line} — ${p.message}`).join("\n")
          : "",
        gitBranch: "",
      };
      const resolved = await resolveMentions(userPrompt, mentionSources);
      const effectivePrompt = resolved.cleanPrompt;
      const mentionContext = resolved.contextBlocks.join("\n\n");

      // Merge mention-resolved context into the prompt
      const enrichedUserPrompt = mentionContext
        ? `${effectivePrompt}\n\n# Resolved @Mention Context\n${mentionContext}`
        : effectivePrompt;

      const attachedContext = await buildProjectContext(enrichedUserPrompt);

      // Build prompt using extracted builder
      const { prompt } = await buildLlmPrompt({
        userPrompt,
        mode,
        projectPath,
        files,
        openTabs,
        activeFilePath,
        selectedText,
        problems,
        terminalOutput,
        proactiveError,
        messages,
        mcpServers,
        attachedContext,
        existingFiles: collectExistingFiles(),
      });
      // Collect current image attachments from the last user message
      const lastUserMsg = messages[messages.length - 1];
      const currentImages = (lastUserMsg?.role === "user" && lastUserMsg.attachments)
        ? lastUserMsg.attachments.filter((a) => a.type === "image")
        : attachments.filter((a) => a.type === "image"); // fallback to current state

      // Determine which models to use
      const enabledModels = getEnabledModels();

      if (enabledModels.length > 0) {
        if (config.adaptiveMode) {
          const imagePayload = currentImages.length > 0
            ? currentImages.map((img) => ({ base64: img.base64, mimeType: img.mimeType }))
            : undefined;
          const contextSize = estimateTokens(prompt);
          const taskType = detectTaskType(userPrompt, {
            selectedText,
            fileContext: attachedContext,
            terminalOutput: [terminalOutput || "", proactiveError?.output || ""].filter(Boolean).join("\n"),
            problemsCount: problems?.length || 0,
            attachedImageCount: currentImages.length,
            selectedFileCount: selectedProjectFiles.length,
            agentMode: mode,
          });
          const strategy = (config.adaptiveStrategy || "coding_optimized") as AdaptiveStrategy;
          const selection = selectAdaptiveProvider(taskType, contextSize, strategy, aiProviders);

          console.debug("[AdaptiveMode]", {
            taskType,
            contextSize,
            strategy,
            selectedProvider: selection?.provider.name,
            selectedModel: selection?.model,
          });

          if (!selection) {
            const activeProviderName = aiProviders.find(hasUsableProvider)?.name || config.provider || "AI";
            setMessages((prev) => [...prev, { role: "assistant", content: `Currently using ${activeProviderName}. Please check your API key in Settings to continue.` }]);
            return;
          }

          const streamId = `stream-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
          const streamController = new AbortController();
          const firstNotice = "";
          setMessages((prev) => [...prev, { role: "assistant", content: `${firstNotice}\n\nâ–`, mode, streamId } as ChatMessage & { streamId: string }]);

          const fallbackNotices: string[] = [];
          let finalResp: Awaited<ReturnType<typeof sendToProviderStreaming>> | null = null;
          let finalText = "";
          let selectedProviderName = selection.provider.name;
          let selectedModelId = selection.model;

          for (let index = 0; index < selection.candidates.length; index += 1) {
            const candidate = selection.candidates[index];
            selectedProviderName = candidate.provider.name;
            selectedModelId = candidate.model;

            setMessages((prev) => prev.map((m) =>
              (m as any).streamId === streamId
                ? { ...m, content: `${[firstNotice, ...fallbackNotices].join("\n")}\n\nUsing ${candidate.provider.name} / ${candidate.model}...\n\nâ–` }
                : m
            ));

            const { listen } = await import("@tauri-apps/api/event");
            let streamedText = "";

            // Wire Rust IPC listener to unified token handler
            activeStreamIdRef.current = streamId;
            resetTokenBuffer();
            resetParseState();
            blockParserRef.current = createBlockParser();

            const unlisten = await listen<{ stream_id: string; token: string; done: boolean }>("llm-stream", (event) => {
              const { stream_id, token, done } = event.payload;
              if (stream_id !== streamId) return;
              if (!done && token) {
                streamedText += token;
                onStreamToken(token, streamId);
              }
            });

            activeStreamRef.current = {
              cancel: () => {
                streamController.abort();
                cancelPendingFlush();
                unlisten();
              },
              streamId,
              kind: "chat",
            };

            const resp = await sendToProviderStreaming(candidate.provider, candidate.model, {
              systemPrompt: SYSTEM_PROMPT,
              userPrompt: prompt,
              images: imagePayload,
              streamId,
              signal: streamController.signal,
            });
            unlisten();

            // Use unified handler for completion/error
            if (resp.success) {
              flushBufferSync();
            } else {
              cancelPendingFlush();
              tokenBufferRef.current = '';
            }
            activeStreamIdRef.current = null;

            if (resp.success) {
              markProviderHealthy(candidate.provider.id);
              finalResp = resp;
              finalText = resp.text;
              break;
            }

            const healthStatus = classifyProviderError(resp.error);
            setProviderHealth(candidate.provider.id, healthStatus, resp.error);
            const nextCandidate = selection.candidates[index + 1];
            console.debug("[AdaptiveMode] fallback", {
              provider: candidate.provider.name,
              model: candidate.model,
              reason: describeHealthStatus(healthStatus),
              nextProvider: nextCandidate?.provider.name,
              nextModel: nextCandidate?.model,
            });

            if (nextCandidate) {
              fallbackNotices.push(`${candidate.provider.name} ${describeHealthStatus(healthStatus)}. Switched to ${nextCandidate.provider.name}.`);
            } else {
              finalResp = resp;
              finalText = resp.error || "Unknown error";
            }
          }
          if (activeStreamRef.current?.streamId === streamId) {
            activeStreamRef.current = null;
          }

          const noticeText = [`Used ${selectedProviderName} / ${selectedModelId}.`, ...fallbackNotices].join("\n");
          const responseText = `${noticeText}\n\n${finalText}`;
          let parsed = finalResp?.success ? await parseResponseAsync(finalText, collectExistingFiles()) : null;
          if (parsed && parsed.editOperations.length > 0) {
            parsed = await resolveEditsWithPreview(parsed, agentMode);
          }
          const hasActions = parsed ? hasParsedActions(parsed) : false;
          recordResponseUsage(finalResp?.metrics);

          // Finalize message in-place — preserves streaming blocks, just marks complete
          resetParseState();
          const finalBlocks = parseStreamBlocks(finalText).completed;
          setMessages((prev) => prev.map((m) => {
            if ((m as any).streamId !== streamId) return m;
            const { streamId: _sid, streamProgress: _sp, ...rest } = m as any;
            const blocks = finalBlocks.length > 0 ? finalBlocks : ((m as any).blocks || []);
            return {
              ...rest,
              content: responseText,
              blocks,
              isComplete: true,
              parsed: hasActions ? parsed : undefined,
              applied: false,
              metrics: finalResp?.metrics,
            };
          }));
          return;
        }

        // Use new multi-provider system
        if (enabledModels.length === 1) {
          // Single model — use streaming for real-time token display
          const { providerId, model: modelId } = enabledModels[0];
          const provider = aiProviders.find((p) => p.id === providerId);

          if (!provider) {
            setMessages((prev) => [...prev, { role: "assistant", content: "Provider not found." }]);
          } else {
            // Add placeholder message with unique stream ID for tracking
            const streamId = `stream-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
            setMessages((prev) => [...prev, { role: "assistant", content: "▍", mode, streamId } as ChatMessage & { streamId: string }]);

            // Listen for streaming tokens via unified handler
            const { listen } = await import("@tauri-apps/api/event");
            let streamedText = "";

            // Wire Rust IPC listener to unified token handler
            activeStreamIdRef.current = streamId;
            resetTokenBuffer();
            resetParseState();
            blockParserRef.current = createBlockParser();

            const streamController = new AbortController();
            const unlisten = await listen<{ stream_id: string; token: string; done: boolean }>("llm-stream", (event) => {
              const { stream_id, token, done } = event.payload;
              if (stream_id !== streamId) return;
              if (!done && token) {
                streamedText += token;
                onStreamToken(token, streamId);
              }
            });

            activeStreamRef.current = { cancel: () => { streamController.abort(); cancelPendingFlush(); unlisten(); }, streamId, kind: "chat" };

            // Send the streaming request
            const imagePayload = currentImages.length > 0
              ? currentImages.map((img) => ({ base64: img.base64, mimeType: img.mimeType }))
              : undefined;
            const resp = await sendToProviderStreaming(provider, modelId, {
              systemPrompt: SYSTEM_PROMPT,
              userPrompt: prompt,
              images: imagePayload,
              streamId,
              signal: streamController.signal,
            });
            unlisten();

            // Finalize via unified handler
            const finalText = resp.success ? resp.text : (resp.error || "Unknown error");
            if (!resp.success) {
              onStreamError(streamId, finalText);
            } else {
              // Synchronous flush before finalization
              flushBufferSync();
              activeStreamIdRef.current = null;

              let parsed = await parseResponseAsync(finalText, collectExistingFiles());
              // Resolve EDIT blocks into fileChanges
              if (parsed && parsed.editOperations.length > 0) {
                parsed = await resolveEditsWithPreview(parsed, agentMode);
              }
              const hasActions = parsed ? hasParsedActions(parsed) : false;

              // --- MCP tool auto-execution ---
              let effectiveFinalText = finalText;
              if (mcpServers.length > 0) {
                const mcpCalls = parseMcpCalls(finalText);
                if (mcpCalls.length > 0) {
                  const mcpResultParts: string[] = [];
                  for (const call of mcpCalls) {
                    const server = mcpServers.find(s => s.id === call.serverId && s.enabled);
                    if (!server) {
                      mcpResultParts.push(`⚠️ MCP server "${call.serverId}" not found or disabled.`);
                      continue;
                    }
                    setMessages(prev => [...prev, {
                      role: "assistant",
                      content: `🔧 Calling MCP tool **${call.serverId}.${call.toolName}**…`,
                    }]);
                    const result = await mcpCallTool(server, call.toolName, call.args, projectPath);
                    const formatted = formatMcpResult(call.toolName, result);
                    mcpResultParts.push(formatted);
                  }
                  // Feed results back into the AI for a follow-up response
                  if (mcpResultParts.length > 0) {
                    const toolResultsContext = mcpResultParts.join("\n\n");
                    effectiveFinalText = `${finalText}\n\n${toolResultsContext}`;
                    // Re-request with tool results in context
                    await requestPunam(
                      `Here are the MCP tool results:\n\n${toolResultsContext}\n\nNow provide your final answer using this data.`,
                      mode
                    );
                    return; // requestPunam will handle the final setMessages
                  }
                }
              }

              // Finalize message in-place — preserves streaming blocks, just marks complete
              resetParseState();
              const finalBlocks = parseStreamBlocks(effectiveFinalText).completed;
              setMessages((prev) => prev.map((m) => {
                if ((m as any).streamId !== streamId) return m;
                const { streamId: _sid, streamProgress: _sp, ...rest } = m as any;
                const blocks = finalBlocks.length > 0 ? finalBlocks : ((m as any).blocks || []);
                return {
                  ...rest,
                  content: effectiveFinalText,
                  blocks,
                  isComplete: true,
                  parsed: hasActions ? parsed : undefined,
                  applied: false,
                  metrics: resp.metrics,
                };
              }));
              recordResponseUsage(resp.metrics);
            }
          }
        } else {
          // Multiple models — send in parallel (no streaming for multi)
          const imagePayloadMulti = currentImages.length > 0
            ? currentImages.map((img) => ({ base64: img.base64, mimeType: img.mimeType }))
            : undefined;
          const responses = await sendToMultipleModels(
            aiProviders,
            enabledModels,
            { systemPrompt: SYSTEM_PROMPT, userPrompt: prompt, images: imagePayloadMulti }
          );

          const multiResponses = await Promise.all(responses.map(async (resp) => {
            if (!resp.success) {
              return { content: resp.error || "Unknown error", metrics: resp.metrics };
            }
            recordResponseUsage(resp.metrics);
            let parsed = await parseResponseAsync(resp.text, collectExistingFiles());
            if (parsed.editOperations.length > 0) {
              parsed = await resolveEditsWithPreview(parsed, agentMode);
            }
            const hasActions = hasParsedActions(parsed);
            return { content: resp.text, parsed: hasActions ? parsed : undefined, applied: false, metrics: resp.metrics };
          }));
          setMessages((prev) => [...prev, {
            role: "assistant",
            content: "",
            mode,
            multiResponses,
          }]);
        }
      } else {
        // Fallback to legacy single-provider system
        const response = await callLlm({
          provider: config.provider,
          api_key: config.api_key,
          model: config.model,
          system_prompt: SYSTEM_PROMPT,
          user_prompt: prompt,
        });

        if (!response.success) {
          const providerName = config.provider === "gemini" ? "Google Gemini" : config.provider === "groq" ? "Groq" : config.provider === "openai" ? "OpenAI" : config.provider;
          setMessages((prev) => [...prev, { role: "assistant", content: `Currently using ${providerName} / ${config.model}. The service is temporarily unavailable — please try again in a moment.` }]);
          return;
        }

        let parsed = await parseResponseAsync(response.text, collectExistingFiles());
        if (parsed.editOperations.length > 0) {
          parsed = await resolveEditsWithPreview(parsed, agentMode);
        }
        const hasActions = hasParsedActions(parsed);
        setMessages((prev) => [...prev, {
          role: "assistant",
          content: response.text,
          mode,
          parsed: hasActions ? parsed : undefined,
          applied: false,
        }]);
      }
    } catch (err) {
      const providerName = config.provider === "gemini" ? "Google Gemini" : config.provider === "groq" ? "Groq" : config.provider === "openai" ? "OpenAI" : config.provider;
      setMessages((prev) => [...prev, { role: "assistant", content: `Currently using ${providerName} / ${config.model}. Something went wrong — please try again.` }]);
    } finally {
      setLoading(false);
      setCooldown(true);
      setTimeout(() => setCooldown(false), 3000);
    }
  };

  /** Get all enabled models across all providers */
  const getEnabledModels = (): Array<{ providerId: string; model: string }> => {
    // If user has manually selected a model via the quick-switch dropdown, use only that
    if (activeModelOverride) {
      return [activeModelOverride];
    }
    const result: Array<{ providerId: string; model: string }> = [];
    for (const provider of aiProviders) {
      for (const model of provider.models) {
        if (model.enabled && model.id) {
          result.push({ providerId: provider.id, model: model.id });
        }
      }
    }
    return result;
  };

  /** Get token estimate for current context */
  const getTokenEstimate = (): number => {
    const contextSize = (input?.length || 0) + (selectedText?.length || 0) + (terminalOutput?.length || 0);
    // Rough estimate: file tree + open tabs + prompt overhead
    const overhead = 2000;
    return estimateTokens(String(contextSize + overhead));
  };

  const fixObservedRunFailure = async (observation: RunObservation) => {
    const errorOutput = observation.output.slice(-12000);
    const existingFiles = collectExistingFiles();
    const errorFiles = getFilePathsFromText(errorOutput, existingFiles);

    let inlineFileContext = "";
    for (const filePath of errorFiles.slice(0, 4)) {
      try {
        const content = await readFile(getProjectFilePath(projectPath, filePath));
        if (content) {
          inlineFileContext += `\n\n## Content of ${filePath}\n\`\`\`\n${content.slice(0, 8000)}\n\`\`\``;
        }
      } catch { /* ignore read failures */ }
    }

    const errorFilesList = errorFiles.length > 0
      ? `\n\nFiles referenced in the error:\n${errorFiles.map((filePath) => `- ${filePath}`).join("\n")}`
      : "";
    const fixPrompt =
      `A command Punam ran did not verify successfully. Diagnose the terminal output, patch the project, and do not claim success until the fix can run.\n\n` +
      `Command:\n${observation.command}\n\n` +
      `Detected issue:\n${observation.reason || "Run failed"}${errorFilesList}${inlineFileContext}\n\n` +
      `Terminal output:\n\`\`\`\n${errorOutput}\n\`\`\``;

    setMessages((prev) => [...prev, {
      role: "assistant",
      content: `I detected the command is failing, so I am reading the terminal output and preparing a fix for \`${observation.command}\`.`,
    }]);
    await requestPunam(fixPrompt, "chat");
  };

  const getAdaptivePreview = (): string | undefined => {
    if (!config.adaptiveMode) return undefined;
    const taskType = detectTaskType(input, {
      selectedText,
      terminalOutput,
      problemsCount: problems?.length || 0,
      attachedImageCount: attachments.filter((attachment) => attachment.type === "image").length,
      selectedFileCount: selectedProjectFiles.length,
      agentMode,
    });
    const contextSize = getTokenEstimate();
    const selection = selectAdaptiveProvider(
      taskType,
      contextSize,
      (config.adaptiveStrategy || "coding_optimized") as AdaptiveStrategy,
      aiProviders
    );
    if (!selection) return "Adaptive: no provider";
    return `Adaptive: ${selection.provider.name} / ${selection.model}`;
  };

  const handleSend = async () => {
    const text = input.trim();
    if ((!text && attachments.length === 0) || loading || cooldown) return;

    // Cancel any active stream before starting a new one
    if (activeStreamRef.current) {
      activeStreamRef.current.cancel();
      activeStreamRef.current = null;
    }

    const mode = agentMode;

    // --- Handle @web mention: do a quick web fetch before sending ---
    const webMatch = text.match(/@web\s+(.+?)(?:\n|$)/i);
    if (webMatch) {
      const query = webMatch[1].trim().slice(0, 150);
      setMessages((prev) => [...prev, { role: "assistant", content: `🌐 Searching the web for: _${query}_...` }]);
      try {
        // Build a minimal search via a DuckDuckGo instant-answer URL (no API key needed)
        const encoded = encodeURIComponent(query);
        const resp = await fetch(`https://api.duckduckgo.com/?q=${encoded}&format=json&no_html=1&skip_disambig=1`);
        if (resp.ok) {
          const data = await resp.json();
          const abstract = data.AbstractText || data.Answer || "";
          const source = data.AbstractURL || data.AnswerType || "";
          if (abstract) {
            setWebSearchResults(`Query: ${query}\n\nResult: ${abstract}${source ? `\nSource: ${source}` : ""}`);
            setMessages((prev) => [...prev.slice(0, -1), { role: "assistant", content: `🌐 Web: ${abstract.slice(0, 200)}${abstract.length > 200 ? "…" : ""}` }]);
          } else {
            setWebSearchResults(`Query: ${query}\n\nNo direct answer found. The AI will answer from training data.`);
            setMessages((prev) => [...prev.slice(0, -1), { role: "assistant", content: `🌐 No instant answer found for "${query}". Proceeding with AI knowledge.` }]);
          }
        }
      } catch {
        setWebSearchResults("");
        setMessages((prev) => [...prev.slice(0, -1), { role: "assistant", content: `🌐 Web search unavailable. Proceeding with AI knowledge.` }]);
      }
    }

    const currentAttachments = attachments.length > 0 ? [...attachments] : undefined;
    const userMsg: ChatMessage = { role: "user", content: text || "(attached files)", mode, attachments: currentAttachments };
    setMessages((prev) => [...prev, userMsg]);
    setInput("");
    clearAttachments(); // Clear attachments after sending

    // B010 fix: Show a visible warning when @file mentions don't resolve to existing files
    const unresolvedFiles = getUnresolvedMentions(text, collectExistingFiles());
    if (unresolvedFiles.length > 0) {
      const warningMsg = `⚠️ Note: ${unresolvedFiles.map((f) => `\`${f}\``).join(", ")} ${unresolvedFiles.length === 1 ? "does" : "do"} not exist in the project. If you want me to create ${unresolvedFiles.length === 1 ? "it" : "them"}, I'll confirm before doing so.`;
      setMessages((prev) => [...prev, { role: "assistant", content: warningMsg }]);
    }

    // Only check identity responses when NO code is selected AND no file is active
    const hasActiveContext = (selectedText && selectedText.trim().length > 0) || activeFilePath;
    if (!hasActiveContext) {
      const identityReply = getIdentityResponse(text);
      if (identityReply) {
        setMessages((prev) => [
          ...prev,
          { role: "assistant", content: identityReply },
        ]);
        return;
      }
    }

    // --- Agent mode: always use autonomous agent loop ---
    if (mode === "agent") {
      const nextTask = startAgentTask(text);
      await agentProposeFix(nextTask);
      return;
    }

    // Detect agent-triggering phrases (fix-related with errors/build context)
    const lower = text.toLowerCase();
    const isAgentTask = (
      /\b(fix|solve|resolve|debug|repair)\b/i.test(lower) &&
      /\b(build|error|bug|fail|broken|crash|issue)\b/i.test(lower) &&
      (problems?.length || (terminalOutput && terminalOutput.trim().length > 0))
    );

    if (isAgentTask && !agentTask?.active) {
      const nextTask = startAgentTask(text);
      await agentProposeFix(nextTask);
      return;
    }

    await requestPunam(text, mode);
  };

  const handleFixCheck = async (result: ProjectCheckResult) => {
    if (loading || cooldown) return;

    const output = `${result.stdout}${result.stderr ? `\n${result.stderr}` : ""}`.trim();
    setMessages((prev) => [
      ...prev,
      {
        role: "user",
        content: `Fix the failing project check: ${result.command}`,
        mode: "chat",
      },
    ]);

    await requestPunam(
      `The project check command failed. Diagnose the error and provide the smallest safe code changes to fix it.\n\nCommand:\n${result.command}\n\nExit code:\n${result.exitCode}\n\nOutput:\n\`\`\`\n${output.slice(0, 12000)}\n\`\`\``,
      "chat"
    );
  };

  const handleApply = async (msgIdx: number) => {
    const msg = messages[msgIdx];
    if (!msg.parsed) return;

    try {
      // Capture before-state for summary
      const beforeState: Array<{ path: string; existed: boolean; preview: string }> = [];
      for (const change of msg.parsed.fileChanges) {
        const fullPath = projectPath ? `${projectPath.replace(/[\\/]+$/, "")}${projectPath.includes("\\") ? "\\" : "/"}${change.path}` : change.path;
        const existing = await readFile(fullPath).catch(() => "");
        beforeState.push({
          path: change.path,
          existed: !!existing,
          preview: existing ? existing.split("\n").slice(0, 3).join("\n") : "",
        });
      }

      if (onApplyDirect) {
        await onApplyDirect(msg.parsed);
        setMessages((prev) =>
          prev.map((m, i) => (i === msgIdx ? { ...m, applied: true } : m))
        );
      } else {
        const applied = await onApplyChanges(msg.parsed);
        if (applied) {
          setMessages((prev) =>
            prev.map((m, i) => (i === msgIdx ? { ...m, applied: true } : m))
          );
        } else {
          return; // User cancelled
        }
      }

      // Show before/after summary
      const summaryLines = msg.parsed.fileChanges.map((change, idx) => {
        const before = beforeState[idx];
        if (!before.existed) return `+ **Created:** \`${change.path}\``;
        // Show a brief diff hint
        const oldLines = before.preview.split("\n").length;
        const newLines = change.content.split("\n").length;
        const lineDiff = newLines - oldLines;
        const diffHint = lineDiff > 0 ? `(+${lineDiff} lines)` : lineDiff < 0 ? `(${lineDiff} lines)` : "(modified)";
        return `~ **Edited:** \`${change.path}\` ${diffHint}`;
      });
      if (msg.parsed.deletions.length > 0) {
        summaryLines.push(...msg.parsed.deletions.map((d) => `- **Deleted:** \`${d}\``));
      }
      if (msg.parsed.commands.length > 0) {
        summaryLines.push(...msg.parsed.commands.map((cmd) => `$ **Command:** \`${cmd}\``));
      }
      if (summaryLines.length > 0) {
        setMessages((prev) => [...prev, {
          role: "assistant",
          content: `**Changes applied:**\n${summaryLines.join("\n")}`,
        }]);
      }
    } catch (err) {
      setMessages((prev) => [
        ...prev,
        { role: "assistant", content: `Failed to apply: ${err}` },
      ]);
    }
  };

  const handleReject = (msgIdx: number) => {
    setMessages((prev) =>
      prev.map((m, i) => (i === msgIdx ? { ...m, applied: true, parsed: undefined } : m))
    );
  };

  const handleApplyMulti = async (msgIdx: number, responseIdx: number) => {
    const msg = messages[msgIdx];
    const resp = msg.multiResponses?.[responseIdx];
    if (!resp?.parsed) return;

    try {
      const applied = await onApplyChanges(resp.parsed);
      if (applied) {
        setMessages((prev) =>
          prev.map((m, i) => {
            if (i !== msgIdx || !m.multiResponses) return m;
            const updated = [...m.multiResponses];
            updated[responseIdx] = { ...updated[responseIdx], applied: true };
            return { ...m, multiResponses: updated };
          })
        );
      }
    } catch (err) {
      setMessages((prev) => [
        ...prev,
        { role: "assistant", content: `Failed to apply: ${err}` },
      ]);
    }
  };

  // --- Agent Mode Functions ---

  // createAgentTask imported from ./chat/types

  const startAgentTask = (task: string) => {
    agentCancelledRef.current = false;
    agentRunIdRef.current += 1;
    setAgentActivityText("Planning approach...");
    const nextTask = createAgentTask(task);
    setAgentTask(nextTask);

    // Register foreground agent with orchestrator
    try {
      const provider = aiProviders.find(p => p.apiKey && p.models.some(m => m.enabled));
      const model = provider?.models.find(m => m.enabled);
      getAgentOrchestrator().spawnAgent({
        id: "foreground-agent",
        type: "implementation",
        provider: provider?.name || "unknown",
        model: model?.id || "unknown",
        apiKey: "redacted",
      });
    } catch { /* agent may already exist */ }

    return nextTask;
  };

  const stopAgent = () => {
    const activeStreamId = activeStreamRef.current?.streamId;
    const activeStreamKind = activeStreamRef.current?.kind;
    agentCancelledRef.current = true;
    agentRunIdRef.current += 1;
    if (activeStreamRef.current) {
      activeStreamRef.current.cancel();
      activeStreamRef.current = null;
    }
    // Unregister from orchestrator
    try {
      getAgentOrchestrator().removeAgent("foreground-agent");
    } catch { /* ignore */ }
    if (activeStreamId) {
      setMessages(prev => prev.map(m => {
        if ((m as any).streamId !== activeStreamId) return m;
        const { streamId: _sid, streamProgress: _sp, ...rest } = m as any;
        const content = String((m as any).content || "").replace(/[▍\s]+$/, "").trimEnd();
        const stoppedContent = activeStreamKind === "tool_loop"
          ? content.includes("Status:")
            ? content.replace(/Status:.*$/m, "Status: Stopped.")
            : `${content}\n\nStatus: Stopped.`
          : `${content}\n\nStopped.`;
        return { ...rest, content: stoppedContent, isComplete: true };
      }));
    }
    setAgentTask(null);
    setAgentActivityText("");
    setLoading(false);
    if (!activeStreamId) {
      setMessages((prev) => [...prev, {
        role: "assistant",
        content: "Agent stopped by user.",
      }]);
    }
  };
  const sendToBackground = () => {
    if (!agentTask || !agentTask.active) return;

    const bgStore = useBackgroundAgentStore.getState();
    bgStore.startSession(
      agentTask.task,
      projectPath,
      contextFiles,
      agentTask.subtasks.length > 0 ? agentTask.subtasks : [agentTask.task]
    );

    // Start the background execution engine
    const openTabPaths = openTabs.map((t) => t.path);
    startBackgroundExecution({
      projectPath,
      aiProviders,
      openTabPaths,
    });

    // Stop the foreground agent
    setAgentTask(null);
    setMessages((prev) => [...prev, {
      role: "assistant",
      content: "✓ Task sent to background. You can keep coding — check the status bar for progress.",
    }]);
  };

  /** Send a task directly to background without starting foreground agent first */
  const sendTaskDirectToBackground = (task: string) => {
    // Parse subtasks
    const subtaskPattern = /^\s*(?:\d+[\.\)]\s*|[-*]\s+)(.+)$/gm;
    const matches = [...task.matchAll(subtaskPattern)];
    const subtasks = matches.length > 1 ? matches.map(m => m[1].trim()) : [task];

    const bgStore = useBackgroundAgentStore.getState();
    bgStore.startSession(task, projectPath, contextFiles, subtasks);

    // Start execution
    const openTabPaths = openTabs.map((t) => t.path);
    startBackgroundExecution({ projectPath, aiProviders, openTabPaths });

    setMessages((prev) => [...prev, {
      role: "assistant",
      content: "✓ Task running in background. Keep coding — check the status bar for progress.",
    }]);
  };

  const agentProposeFix = async (taskOverride?: AgentTaskState) => {
    const activeTask = taskOverride ?? agentTask;
    if (!activeTask || !activeTask.active) {
      console.log("[AGENT] agentProposeFix bailed — agentTask:", agentTask);
      return;
    }
    const runId = agentRunIdRef.current;
    const isCurrentAgentRun = () => !agentCancelledRef.current && agentRunIdRef.current === runId;

    // ── Intercept simple meta-questions that don't need an API call ──────────
    const taskLower = activeTask.task.toLowerCase();
    const isFileQuery = /which file|what file|what'?s open|current file|opened in editor|open in editor|file is open/.test(taskLower);
    console.log("[AGENT] isFileQuery check:", { taskLower, isFileQuery, activeFilePath });
    if (isFileQuery) {
      const answer = activeFilePath
        ? `The file currently open in the editor is: **${activeFilePath.replace(/.*[\/\\]/, "")}**`
        : "No file is currently open in the editor.";
      setMessages(prev => [...prev, { role: "assistant", content: answer, mode: "chat" } as any]);
      setAgentTask(null);
      setLoading(false);
      return;
    }

    setAgentActivityText("Collecting project context...");
    setAgentTask((prev) => prev ? { ...prev, step: "proposing_fix" } : null);

    // Build context using extracted agentContextBuilder
    const { payload, currentTask, existingFiles } = await buildAgentContext({
      activeTask,
      projectPath,
      files,
      openTabs,
      activeFilePath,
      terminalOutput,
      proactiveError,
      messages,
      existingFiles: collectExistingFiles(),
    });

    // ── Send to AI using the optimized payload ──────────────────────────────
    setLoading(true);
    try {
      const enabledModels = getEnabledModels();
      if (enabledModels.length === 0) {
        setMessages(prev => [...prev, { role: "assistant", content: "No AI provider configured." }]);
        setAgentActivityText("");
        setLoading(false);
        return;
      }

      const { providerId, model: modelId } = enabledModels[0];
      const provider = aiProviders.find(p => p.id === providerId);
      if (!provider) {
        setMessages(prev => [...prev, { role: "assistant", content: "Provider not found." }]);
        setAgentActivityText("");
        setLoading(false);
        return;
      }

      // Stream with block-parsed rendering at 60fps (incremental)
      const streamId = `stream-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
      setMessages(prev => [...prev, { role: "assistant", content: "▍", mode: "chat", streamId } as any]);

      const { listen } = await import("@tauri-apps/api/event");
      let streamedText = "";

      // Wire Rust IPC listener to unified token handler
      activeStreamIdRef.current = streamId;
      resetTokenBuffer();
      resetParseState();
      blockParserRef.current = createBlockParser();

      const streamController = new AbortController();
      const unlisten = await listen<{ stream_id: string; token: string; done: boolean }>("llm-stream", (event) => {
        if (!isCurrentAgentRun()) return;
        const { stream_id, token, done } = event.payload;
        if (stream_id !== streamId) return;
        if (!done && token) {
          streamedText += token;
          onStreamToken(token, streamId);
        }
      });
      activeStreamRef.current = {
        streamId,
        kind: "agent_stream",
        cancel: () => {
          streamController.abort();
          cancelPendingFlush();
          unlisten();
          agentCancelledRef.current = true;
        },
      };

      const agentDecision = decideAgentRoute(currentTask);

      // For openai-compatible providers (DeepSeek, Groq, Mistral, etc.), ALWAYS use the tool loop.
      // These providers use structured tool_calls in API responses — the standard streaming path
      // can't handle their tool calls (it only captures text). The tool loop has its own
      // approval gate and verification, so safety is maintained.
      const forceToolLoop = provider.type === "openai-compatible";

      // Read-only inspection/search tasks use the tool loop. Edits and commands
      // stay on the standard guarded path so diff previews and command approval remain intact.
      // Exception: openai-compatible providers always use tool loop (forceToolLoop).
      if (agentDecision.route === "tool_loop" || forceToolLoop) {
        setAgentActivityText(forceToolLoop ? "Agent working..." : "Inspecting project with internal tools...");
        unlisten();
        cancelPendingFlush();
        activeStreamIdRef.current = null;
        setMessages(prev => prev.filter(m => (m as any).streamId !== streamId));
        const toolStreamId = `stream-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

        const toolTrace: ToolTraceEntry[] = [];
        const formatTrace = (status = "Running...") => formatToolTrace(toolTrace, agentDecision.kind, agentDecision.reason, status);

        setMessages(prev => [...prev, {
          role: "assistant",
          content: `${formatTrace()}\n\n▍`,
          mode: "chat",
          streamId: toolStreamId,
        } as any]);


        activeStreamRef.current = {
          streamId: toolStreamId,
          kind: "tool_loop",
          cancel: () => {
            agentCancelledRef.current = true;
          },
        };

        // Clear previous task cost summary when starting a new tool loop
        setTaskCostSummary(null);

        // Use the existing runAgentToolLoop which sends AGENT_TOOL_DEFINITIONS
        await runAgentToolLoop({
          provider,
          modelId,
          systemPrompt: payload.systemInstruction,
          task: currentTask,
          projectPath,
          activeFilePath,
          maxRounds: forceToolLoop ? 15 : (agentDecision.kind === "search" ? 6 : 8),
          shouldCancel: () => !isCurrentAgentRun(),

          // Clarification protocol — shows inline dialog when ambiguity detected
          enableClarification: true,
          onClarificationNeeded: handleClarificationNeeded,

          // Budget enforcement — per-task budget with mid-task warning dialog
          budget: taskBudget,
          onBudgetWarning: taskBudget ? handleBudgetWarning : undefined,

          // Context optimization — unified multi-source context assembly
          enableContextOptimization,

          // Diff preview before agent writes — respects autopilot setting
          onBeforeWrite: async (filePath, originalContent, newContent) => {
            // If file is already locked by inline diff, reject immediately
            const { isFileLockedForDiff: checkLock } = await import("../hooks/useInlineDiff");
            if (checkLock(filePath)) {
              return false; // Reject — file is locked
            }

            const { useSettingsStore } = await import("../store/settingsStore");
            const autopilot = useSettingsStore.getState().config.agentAutopilot;

            // ── Autopilot ON: auto-approve all writes ──
            // Safety is handled by:
            //   1. The approval gate (gatePatchWithApproval) for sensitive files
            //   2. Rust inspect_command for dangerous commands (handled separately)
            if (autopilot) {
              return true;
            }

            // ── Autopilot OFF (supervised): require approval for every write ──
            // Show inline diff for existing files, auto-approve new files
            if (!originalContent || originalContent.trim() === "") {
              // New file — show approval via event but don't block on diff
              return new Promise<boolean>((resolve) => {
                const event = new CustomEvent("punam-inline-diff-preview", {
                  detail: { path: filePath, original: "", proposed: newContent, resolve },
                });
                window.dispatchEvent(event);
              });
            }

            // Existing file — show inline diff for review
            return new Promise<boolean>((resolve) => {
              const event = new CustomEvent("punam-inline-diff-preview", {
                detail: {
                  path: filePath,
                  original: originalContent,
                  proposed: newContent,
                  resolve,
                },
              });
              window.dispatchEvent(event);
            });
          },

          onToolCall: (toolName, input) => {
            if (!isCurrentAgentRun()) return;
            setAgentActivityText(`Using internal tool: ${toolName}`);
            toolTrace.push({ tool: toolName, input });
            // Update message with both text trace AND toolEvents for progressive rendering
            setMessages(prev => prev.map(m =>
              (m as any).streamId === toolStreamId
                ? {
                    ...m,
                    content: `${formatTrace()}\n\n▍`,
                    toolEvents: [
                      ...(m.toolEvents || []),
                      { kind: "tool_call" as const, name: toolName, input, timestamp: Date.now() },
                    ],
                  }
                : m
            ));
          },

          onToolResult: (toolName, input, result, isError) => {
            if (!isCurrentAgentRun()) return;
            setMessages(prev => prev.map(m =>
              (m as any).streamId === toolStreamId
                ? {
                    ...m,
                    toolEvents: [
                      ...(m.toolEvents || []),
                      { kind: "tool_result" as const, name: toolName, input, output: result.slice(0, 2000), timestamp: Date.now() },
                    ],
                  }
                : m
            ));
          },

          onToken: (token) => {
            if (!isCurrentAgentRun()) return;
            setMessages(prev => prev.map(m =>
              (m as any).streamId === toolStreamId
                ? { ...m, content: token + "▍" }
                : m
            ));
          },

          onDone: async (finalText, metrics) => {
            if (!isCurrentAgentRun()) return;
            setAgentActivityText("Writing final answer...");

            // Extract task cost summary from metrics when budget is active
            if (taskBudget && metrics) {
              const consumed: BudgetConsumed = {
                inputTokens: metrics.promptTokens ?? 0,
                outputTokens: metrics.responseTokens ?? 0,
                totalTokens: metrics.totalTokens ?? ((metrics.promptTokens ?? 0) + (metrics.responseTokens ?? 0)),
                estimatedCostUsd: metrics.estimatedCostUsd ?? 0,
                rounds: toolTrace.length || 1,
              };
              setTaskCostSummary(consumed);
            }

            // Parse and handle final answer using existing logic
            resetParseState();
            const finalBlocks = parseStreamBlocks(finalText).completed;
            let parsed = await parseResponseAsync(finalText, existingFiles).catch(() => null);
            if (parsed && parsed.editOperations.length > 0) {
              parsed = await resolveEditsWithPreview(parsed, agentMode);
            }
            const hasActions = parsed ? hasParsedActions(parsed) : false;

            setMessages(prev => prev.map(m => {
              if ((m as any).streamId !== toolStreamId) return m;
              const { streamId: _sid, streamProgress: _sp, ...rest } = m as any;
              const blocks = finalBlocks.length > 0 ? finalBlocks : ((m as any).blocks || []);
              return {
                ...rest,
                content: `${formatTrace("Completed.")}\n\n${finalText}`,
                blocks,
                isComplete: true,
                parsed: hasActions ? parsed : undefined,
                applied: false,
                metrics,
              };
            }));
            recordResponseUsage(metrics);

            if (parsed) {
              const changedFiles = parsed.fileChanges.map(f => f.path);
              void extractMemoriesFromResponse(projectPath, currentTask, finalText, changedFiles);
            }
            activeStreamRef.current = null;
            setAgentActivityText("");
            setLoading(false);
          },

          onError: (err) => {
            if (!isCurrentAgentRun()) return;
            console.warn("[Tool loop] Error:", err);
            const needsToolInput = /\brequires\s+"[^"]+"/i.test(err);
            const traceStatus = needsToolInput
              ? "Tool request needs more information."
              : "Tool loop stopped with an error.";
            const userMessage = needsToolInput
              ? `Tool request needs more information.\n\n${err}`
              : `⚠️ Tool loop unavailable. Using standard mode.\n\n${err}`;
            setAgentActivityText(needsToolInput ? "Waiting for required tool input..." : "Recovering from tool error...");
            setMessages(prev => prev.map(m => {
              if ((m as any).streamId !== toolStreamId) return m;
              const { streamId: _sid, streamProgress: _sp, ...rest } = m as any;
              return { ...rest, content: formatTrace(traceStatus), isComplete: true };
            }));
            setLoading(false);
            setAgentActivityText("");
            setMessages(prev => [...prev, { role: "assistant", content: userMessage }]);
          },
          onCancelled: () => {
            if (activeStreamRef.current?.streamId === toolStreamId) {
              activeStreamRef.current = null;
            }
            setAgentActivityText("");
            setMessages(prev => prev.map(m => {
              if ((m as any).streamId !== toolStreamId) return m;
              const { streamId: _sid, streamProgress: _sp, ...rest } = m as any;
              return { ...rest, content: formatTrace("Stopped."), isComplete: true };
            }));
          },
        });

        if (isCurrentAgentRun()) {
          setLoading(false);
          setAgentTask((prev) => prev ? { ...prev, step: "awaiting_approval" } : null);
        }
        return; // tool loop handled this request
      }

      // ── Existing streaming path (unchanged) ─────────────────────────────────
      const contextBlock = payload.contents
        .find(c => c.role === "user")
        ?.parts[0].text ?? "";
      const finalUserPrompt = contextBlock
        ? `${contextBlock}\n\n# USER QUESTION (${new Date().toISOString()}):\n${currentTask}`
        : currentTask;
      console.log("=== AGENT CONTEXT DEBUG ===");
      console.log("[CTX] systemInstruction:", payload.systemInstruction);
      console.log("[CTX] contents count:", payload.contents.length);
      console.log("[CTX] contents:", JSON.stringify(payload.contents, null, 2));
      console.log("[CTX] tokenEstimate:", payload.tokenEstimate);
      console.log("[CTX] activeFilePath:", activeFilePath);
      console.log("[CTX] finalUserPrompt:", finalUserPrompt);
      console.log("=== END CONTEXT DEBUG ===");

      const resp = await sendToProviderStreaming(provider, modelId, {
        systemPrompt: payload.systemInstruction,
        userPrompt: finalUserPrompt,
        streamId,
        signal: streamController.signal,
      });
      setAgentActivityText("Writing final answer...");
      unlisten();
      cancelPendingFlush();
      if (!isCurrentAgentRun()) {
        activeStreamIdRef.current = null;
        activeStreamRef.current = null;
        return;
      }
      flushBufferSync(); // final synchronous flush via unified handler
      activeStreamIdRef.current = null;

      // Parse response
      const finalText = resp.success ? resp.text : (resp.error || "Unknown error");
      let parsed = resp.success ? await parseResponseAsync(finalText, existingFiles) : null;
      if (parsed && parsed.editOperations.length > 0) {
        parsed = await resolveEditsWithPreview(parsed, agentMode);
      }
      const hasActions = parsed ? hasParsedActions(parsed) : false;
      recordResponseUsage(resp.metrics);

      // Finalize message in-place — preserves streaming blocks, just marks complete
      resetParseState();
      const finalBlocks = parseStreamBlocks(finalText).completed;
      setMessages(prev => prev.map(m => {
        if ((m as any).streamId !== streamId) return m;
        const { streamId: _sid, streamProgress: _sp, ...rest } = m as any;
        // Keep existing blocks from streaming if finalBlocks is empty; otherwise use finalBlocks
        const blocks = finalBlocks.length > 0 ? finalBlocks : ((m as any).blocks || []);
        return {
          ...rest,
          content: finalText,
          blocks,
          isComplete: true,
          parsed: hasActions ? parsed : undefined,
          applied: false,
          metrics: resp.metrics,
        };
      }));

      // Auto-extract memories from the response
      if (resp.success && parsed) {
        const changedFiles = parsed.fileChanges.map(f => f.path);
        void extractMemoriesFromResponse(projectPath, currentTask, finalText, changedFiles);
      }
      activeStreamRef.current = null;
      setAgentActivityText("");

    } catch (err) {
      if (!isCurrentAgentRun()) return;
      setAgentActivityText("");
      const providerName = aiProviders.find(hasUsableProvider)?.name || config.provider || "AI";
      setMessages(prev => [...prev, { role: "assistant", content: `Currently using ${providerName}. Something went wrong — please try again.` }]);
    } finally {
      setLoading(false);
    }

    // Update step
    if (isCurrentAgentRun()) {
      setAgentTask((prev) => prev ? { ...prev, step: "awaiting_approval" } : null);
    }
  };

  const agentSuggestCommand = (command: string) => {
    setAgentTask((prev) => prev ? { ...prev, step: "awaiting_run", suggestedCommand: command } : null);
  };

  const agentRunCommand = async () => {
    if (!agentTask?.suggestedCommand) return;

    setAgentTask((prev) => prev ? { ...prev, step: "running_command" } : null);

    const cmd = agentTask.suggestedCommand;
    setMessages((prev) => [...prev, {
      role: "assistant",
      content: `Running in terminal: \`${cmd}\``,
    }]);

    // Run command in the visible terminal panel
    if (onRunCommand) {
      onRunCommand(cmd);
    }

    // The agent will auto-continue when terminal output changes (monitored below)
  };

  // Monitor terminal output for agent auto-continuation after command runs
  const prevTerminalOutputRef = useRef(terminalOutput || "");
  useEffect(() => {
    if (!agentTask?.active || agentTask.step !== "running_command") return;
    if (!terminalOutput) return;

    // Check if terminal output has new content indicating command finished
    const output = terminalOutput || "";
    const prev = prevTerminalOutputRef.current;
    prevTerminalOutputRef.current = output;

    // Detect completion signals in terminal output
    const hasFinished = output.includes("Process finished successfully") || output.includes("Process exited with code");
    const hasFailed = output.includes("Process exited with code") && !output.includes("exit code 0");
    const hasSucceeded = output.includes("Process finished successfully") || output.includes("exit code 0");

    if (!hasFinished || output === prev) return;

    const cmd = agentTask.suggestedCommand || "command";

    if (hasSucceeded) {
      // Success! Check if there are more subtasks
      setAgentTask((prev) => prev ? { ...prev, step: "verifying" } : null);
      setMessages((msgs) => [...msgs, {
        role: "assistant",
        content: "✓ **Command passed.** Checking for next steps…",
      }]);
      // Advance to next subtask after a brief pause
      setTimeout(() => advanceSubtask(), 800);
    } else if (hasFailed) {
      // Get the last ~2000 chars of terminal output as error context
      const errorOutput = output.slice(-2000);

      setMessages((msgs) => [...msgs, {
        role: "assistant",
        content: `✕ Command failed. Analyzing errors...`,
      }]);

      // Continue if under max attempts
      setAgentTask((prev) => {
        if (!prev) return null;
        const newAttempt = prev.attempt + 1;
        const dependencyDrift = looksLikeDependencyDrift(cmd, errorOutput, prev.history);
        if (dependencyDrift && prev.attempt >= 2) {
          setMessages((msgs) => [...msgs, {
            role: "assistant",
            content: "Stopping here: the latest failures look like dependency/toolchain drift rather than the original app bug. I should not keep changing package versions, lockfiles, node_modules, tsconfig, or build scripts without your approval. Please review the latest terminal error before continuing.",
          }]);
          return {
            ...prev,
            step: "stopped",
            active: false,
            history: [...prev.history, `Stopped after dependency/toolchain drift while running \`${cmd}\`: ${errorOutput.slice(0, 300)}`],
            suggestedCommand: null,
          };
        }
        if (newAttempt > prev.maxAttempts) {
          setMessages((msgs) => [...msgs, {
            role: "assistant",
            content: `⚠️ **Max attempts reached (${prev.maxAttempts}).** Reverting changes to restore your code to its previous state.`,
          }]);
          // Auto-revert all changes made during this agent task
          if (onRevertLastApply) {
            onRevertLastApply().catch(() => {});
          }
          return { ...prev, step: "stopped", active: false };
        }
        const historySummary = `Applied fix, ran \`${cmd}\`, still got errors: ${errorOutput.slice(0, 300)}`;
        return {
          ...prev,
          attempt: newAttempt,
          step: "analyzing_output",
          history: [...prev.history, historySummary],
          suggestedCommand: null,
        };
      });
    }
  }, [terminalOutput, agentTask?.step]);

  const agentSkipCommand = () => {
    setMessages((prev) => [...prev, {
      role: "assistant",
      content: "Command skipped. Want me to continue fixing, or are we done?",
    }]);
    setAgentTask((prev) => prev ? { ...prev, step: "stopped", active: false, suggestedCommand: null } : null);
  };

  // Advance to next subtask in the queue
  const advanceSubtask = () => {
    setAgentTask((prev) => {
      if (!prev || !prev.active) return prev;
      const nextIdx = prev.currentSubtask + 1;
      if (nextIdx >= prev.subtasks.length) {
        // All subtasks done
        setMessages((msgs) => [...msgs, {
          role: "assistant",
          content: `✅ **All ${prev.subtasks.length} task${prev.subtasks.length > 1 ? "s" : ""} completed.**`,
        }]);
        return { ...prev, step: "completed", active: false };
      }
      // Move to next subtask
      setMessages((msgs) => [...msgs, {
        role: "assistant",
        content: `➡️ Moving to subtask ${nextIdx + 1}/${prev.subtasks.length}: **${prev.subtasks[nextIdx]}**`,
      }]);
      return {
        ...prev,
        currentSubtask: nextIdx,
        step: "planning",
        attempt: 1,
        history: [],
        suggestedCommand: null,
      };
    });
  };

  // Auto-continue agent after analyzing output OR starting a new subtask
  useEffect(() => {
    if (agentTask?.active && (agentTask.step === "analyzing_output" || agentTask.step === "planning") && !loading) {
      const timer = setTimeout(() => {
        agentProposeFix();
      }, 1500);
      return () => clearTimeout(timer);
    }
  }, [agentTask?.step, agentTask?.attempt, agentTask?.currentSubtask, loading]);

  const handledRunObservationRef = useRef<string | null>(null);
  useEffect(() => {
    if (!runObservation || loading) return;
    if (handledRunObservationRef.current === runObservation.id) return;
    handledRunObservationRef.current = runObservation.id;

    if (runObservation.status === "ready" && runObservation.url) {
      const verifyDetectedServer = async () => {
        try {
          const parsedUrl = new URL(runObservation.url!);
          const host = parsedUrl.hostname.replace(/^\[|\]$/g, "");
          const port = Number(parsedUrl.port || (parsedUrl.protocol === "https:" ? 443 : 80));
          const check = await checkTcpPort(host, port);
          setMessages((prev) => [...prev, {
            role: "assistant",
            content: check.open
              ? `Dev server port is open: ${runObservation.url}`
              : `Dev server URL appeared in logs, but port ${port} is not reachable yet. I will keep reading the live output instead of calling it fixed.`,
          }]);
        } catch (err) {
          setMessages((prev) => [...prev, {
            role: "assistant",
            content: `Dev server URL appeared in logs, but I could not verify the port: ${String(err)}`,
          }]);
        } finally {
          onDismissRunObservation?.();
        }
      };
      verifyDetectedServer();
      return;
    }

    if (runObservation.status === "completed") {
      const summary = summarizeCommandOutput(runObservation.output);
      setMessages((prev) => [...prev, {
        role: "assistant",
        content:
          `Command completed successfully:\n\n\`${runObservation.command}\`` +
          (summary ? `\n\nOutput preview:\n\`\`\`\n${summary.slice(0, 4000)}\n\`\`\`` : "") +
          "\n\nFull output is in Terminal.",
      }]);
      onDismissRunObservation?.();
      return;
    }

    if (runObservation.status === "failed") {
      const summary = summarizeCommandOutput(runObservation.output);
      setMessages((prev) => [...prev, {
        role: "assistant",
        content:
          `Command failed:\n\n\`${runObservation.command}\`` +
          (summary ? `\n\nOutput preview:\n\`\`\`\n${summary.slice(0, 4000)}\n\`\`\`` : "") +
          "\n\nFull output is in Terminal.",
      }]);
      fixObservedRunFailure(runObservation)
        .finally(() => {
          onDismissRunObservation?.();
          onDismissProactiveError?.();
        });
    }
  }, [runObservation?.id, loading]);

  // Detect if the last AI response has commands and agent is active → suggest running
  useEffect(() => {
    if (!agentTask?.active || agentTask.step !== "awaiting_approval") return;

    const lastMsg = messages[messages.length - 1];
    if (lastMsg?.role === "assistant" && lastMsg.parsed) {
      // Auto-apply in agent mode (when autoApply is enabled)
      if (!lastMsg.applied && agentTask?.autoApply && onApplyDirect) {
        // Check file locks before applying
        const resolver = getConflictResolver();
        const blockedFiles: string[] = [];
        for (const fc of lastMsg.parsed.fileChanges) {
          const result = resolver.attemptEdit("foreground-agent", fc.path, fc.content);
          if (result.hasConflict) {
            blockedFiles.push(`${fc.path}: ${result.message}`);
          }
        }
        if (blockedFiles.length > 0) {
          setMessages(prev => [...prev, {
            role: "assistant",
            content: `⚠️ File lock conflict — cannot apply:\n${blockedFiles.join("\n")}`,
          }]);
          return; // Don't apply
        }

        // Run architecture + security guardrails (Phase 1 + Phase 6)
        (async () => {
          for (const fc of lastMsg.parsed!.fileChanges) {
            try {
              const guardResult = await validateApply("foreground-agent", fc.path, fc.content);
              if (!guardResult.allowed) {
                setMessages(prev => [...prev, {
                  role: "assistant",
                  content: `⚠️ Guardrails blocked ${fc.path}: ${guardResult.reason}`,
                }]);
                resolver.releaseAndFlush("foreground-agent", fc.path);
                return;
              }
            } catch { /* guard unavailable — allow */ }
          }

          const msgIdx = messages.length - 1;
          if (lastMsg.parsed) {
            onApplyDirect(lastMsg.parsed).then(() => {
              // Release locks after successful apply
              for (const fc of lastMsg.parsed!.fileChanges) {
                resolver.releaseAndFlush("foreground-agent", fc.path);
              }
              setMessages((prev) => prev.map((m, i) => (i === msgIdx ? { ...m, applied: true } : m)));
              // If there are commands, suggest running them
              if (lastMsg.parsed?.commands?.length) {
                agentSuggestCommand(lastMsg.parsed.commands[0]);
              } else {
                // No commands — check if we should move to next subtask
                advanceSubtask();
              }
            }).catch(() => {});
          }
          })();
      } else if (!lastMsg.applied && !agentTask?.autoApply) {
        // Manual mode — wait for user to click Apply
        setAgentTask((prev) => prev ? { ...prev, step: "awaiting_approval" } : null);
      } else if (lastMsg.applied && lastMsg.parsed.commands?.length) {
        agentSuggestCommand(lastMsg.parsed.commands[0]);
      }
    }
  }, [messages, agentTask?.step]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const workspaceName = getWorkspaceName(projectPath);
  const visibleFileCount = countFileEntries(files);
  const providerReady = Boolean(config.api_key) || aiProviders.some(hasUsableProvider);
  const lastMessage = messages[messages.length - 1];
  const hasVisibleAssistantStream = lastMessage?.role === "assistant" && lastMessage.isComplete === false;

  return (
    <div className="ai-chat" onDragOver={handleDragOver} onDragLeave={handleDragLeave} onDrop={handleDrop}>
      {/* Drag overlay */}
      {isDragOver && (
        <div className="ai-drag-overlay">
          <div className="ai-drag-overlay-content">
            <Image size={32} />
            <span>Drop image or file here</span>
          </div>
        </div>
      )}

      {/* Image lightbox overlay */}
      {lightboxSrc && (
        <div className="chat-image-lightbox" onClick={() => setLightboxSrc(null)}>
          <img src={lightboxSrc} alt="Expanded view" />
        </div>
      )}

      {/* Agent Approval Gate overlay — shown when agent requires user approval for edits */}
      {pendingApprovalPatch && (
        <AgentApprovalGate
          patch={pendingApprovalPatch}
          onDecision={(decision: ApprovalDecision) => {
            setPendingApprovalPatch(null);
          }}
        />
      )}

      {/* Header with mode dropdown + session controls */}
      <ChatHeader
        agentMode={agentMode}
        agentModes={AGENT_MODES}
        loading={loading}
        messages={messages}
        sessions={sessions}
        activeSessionId={activeSessionId}
        showSessionList={showSessionList}
        onSetAgentMode={setAgentMode}
        onExportChat={handleExportChat}
        onNewSession={handleNewSession}
        onToggleSessionList={() => setShowSessionList(!showSessionList)}
        onSwitchSession={handleSwitchSession}
        onDeleteSession={handleDeleteSession}
        onCloseSessionList={() => setShowSessionList(false)}
      />

      <div className="chat-workspace-strip" title={projectPath || "No workspace open"}>
        <span className="chat-workspace-label">Workspace</span>
        <span className="chat-workspace-name">{workspaceName}</span>
        <span className="chat-workspace-count">{visibleFileCount} visible</span>
      </div>

      {/* Messages — virtualized: browser skips rendering off-screen messages */}
      <div className="chat-messages" ref={chatMessagesRef} onScroll={handleChatScroll}>
        {/* Proactive Error Detection — sticky at top so it doesn't scroll away (B008 fix) */}
        {proactiveError && (
          <div className="proactive-error-card" style={{ position: "sticky", top: 0, zIndex: 10 }}>
            <div className="proactive-error-header">
              <span>⚠️ Command failed: <code>{proactiveError.command}</code></span>
            </div>
            <p className="proactive-error-text">Build/command error detected. Want me to fix it?</p>
            <div className="proactive-error-actions">
              <button className="btn-primary compact" onClick={async () => {
                const errorOutput = proactiveError?.output?.slice(-2000) || "";
                // Extract file paths from error output BEFORE dismissing, so they get loaded into context
                const existingFiles = collectExistingFiles();
                const errorFiles = getFilePathsFromText(errorOutput, existingFiles);

                // Pre-load error-referenced file contents directly into the fix prompt (B008 fix)
                // This ensures the AI sees the actual file content even if buildProjectContext
                // has a path-matching edge case.
                let inlineFileContext = "";
                for (const filePath of errorFiles.slice(0, 3)) {
                  try {
                    const content = await readFile(getProjectFilePath(projectPath, filePath));
                    if (content) {
                      inlineFileContext += `\n\n## Content of ${filePath} (DO NOT guess — use this exactly):\n\`\`\`\n${content.slice(0, 8000)}\n\`\`\``;
                    }
                  } catch { /* file read failed, buildProjectContext will try again */ }
                }

                const errorFilesList = errorFiles.length > 0
                  ? `\n\nFiles referenced in the error (their content is provided below):\n${errorFiles.map((f) => `- ${f}`).join("\n")}`
                  : "";
                // Keep proactiveError alive until requestPunam reads it for context
                const fixPrompt = `Fix the build error with the smallest possible edit. Preserve unrelated code exactly.${errorFilesList}${inlineFileContext}\n\nTerminal error output:\n\`\`\`\n${errorOutput}\n\`\`\``;
                setMessages((prev) => [...prev, { role: "user", content: "Fix the build error. Preserve unrelated code exactly.", mode: "chat" as AgentMode }]);
                await requestPunam(fixPrompt, "chat");
                // Dismiss AFTER the request so buildProjectContext can still read proactiveError
                onDismissProactiveError?.();
              }}>
                Fix It
              </button>
              <button className="btn-secondary compact" onClick={() => onDismissProactiveError?.()}>
                Ignore
              </button>
            </div>
          </div>
        )}

        {messages.length === 0 && (
          <div className="chat-welcome">
            <img src="/logo_transparent.png" alt="Punam" className="chat-welcome-logo" />
            <p><strong>Hi, I'm Punam!</strong></p>
            <p className="chat-welcome-hint">Your AI coding assistant by Amritanshu Amar</p>
          </div>
        )}

        {messages.map((msg, i) => {
          const agentTrace = msg.role === "assistant" ? parseAgentTraceMessage(msg.content) : null;
          return (
          <div key={i} className={`chat-message ${msg.role}`}>
            <div className="chat-message-icon">
              {msg.role === "user" ? <User size={14} /> : <PunamAvatar />}
              <button
                className="chat-message-fork-btn"
                onClick={() => handleForkSession(i)}
                title="Fork conversation from here"
                aria-label={`Fork conversation from message ${i + 1}`}
              >
                <GitFork size={10} />
              </button>
            </div>
            <div className="chat-message-content">
              {msg.role === "user" ? (
                <>
                  {msg.mode && <span className="chat-mode-pill">{MODE_LABELS[msg.mode]}</span>}
                  <p>{msg.content}</p>
                  {msg.attachments && msg.attachments.length > 0 && (
                    <div className="chat-attachments">
                      {msg.attachments.map((att) => (
                        <div key={att.id} className="chat-attachment-item">
                          {att.type === "image" ? (
                            <img
                              src={`data:${att.mimeType};base64,${att.base64}`}
                              alt={att.name}
                              className="chat-attachment-image"
                              onClick={() => setLightboxSrc(`data:${att.mimeType};base64,${att.base64}`)}
                              title="Click to expand"
                            />
                          ) : (
                            <div className="chat-attachment-file">
                              <FileText size={12} />
                              <span>{att.name}</span>
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                </>
              ) : (
                <>
                  {msg.multiResponses && msg.multiResponses.length > 0 ? (
                    <div className="multi-response-stack">
                      {msg.multiResponses.map((resp, ri) => (
                        <div key={ri} className="multi-response-card">
                          <ResponseMetricsDisplay metrics={resp.metrics} />
                          {resp.parsed?.explanation && <MarkdownMessage text={resp.parsed.explanation} />}
                          {resp.parsed && (
                            <ParsedActionsView
                              parsed={resp.parsed}
                              applied={resp.applied}
                              onApply={() => handleApplyMulti(i, ri)}
                            />
                          )}
                          {!resp.parsed && <MarkdownMessage text={resp.content} />}
                        </div>
                      ))}
                    </div>
                  ) : (
                    <>
                      {agentTrace && (
                        <AgentTraceCard
                          trace={agentTrace}
                          isStreaming={!msg.isComplete}
                          showFinal={!msg.parsed && !msg.blocks}
                        />
                      )}
                      {/* Progressive tool call cards — rendered live during agent execution */}
                      {msg.toolEvents && msg.toolEvents.length > 0 && (
                        <div className="cl-tool-events-live">
                          {msg.toolEvents.map((evt, idx) => {
                            if (evt.kind === "tool_call") {
                              // Check if there's a matching result for this call
                              const matchingResult = msg.toolEvents?.find(
                                (r, ri) => ri > idx && r.kind === "tool_result" && r.name === evt.name
                              );
                              return (
                                <ToolCallCard
                                  key={`tc-live-${idx}`}
                                  name={evt.name}
                                  params={evt.input ? JSON.stringify(evt.input) : undefined}
                                  isComplete={!!matchingResult}
                                  isError={false}
                                />
                              );
                            }
                            if (evt.kind === "tool_result" && evt.output) {
                              return (
                                <ToolResultCard
                                  key={`tr-live-${idx}`}
                                  content={evt.output}
                                />
                              );
                            }
                            return null;
                          })}
                        </div>
                      )}
                      {msg.parsed?.explanation && <MarkdownMessage text={msg.parsed.explanation} />}
                      {msg.parsed && (
                        <div className="chat-changes">
                          {msg.parsed.fileChanges.map((fc, j) => (
                            <details key={j} className="chat-file-preview">
                              <summary>
                                <span className={`change-item file-change ${fc.isNew ? "new" : "edit"}`}>
                                  {fc.isNew ? "+ NEW" : "~ EDIT"}
                                </span>
                                <span className="chat-file-preview-path">{fc.path}</span>
                                <span className="chat-file-preview-label">View code</span>
                              </summary>
                              <pre className="chat-file-code-scroll"><code>{fc.content}</code></pre>
                            </details>
                          ))}
                          {msg.parsed.editOperations.map((edit, j) => (
                            <details key={`edit-${j}`} className="chat-file-preview">
                              <summary>
                                <span className="change-item file-change edit">~ PATCH</span>
                                <span className="chat-file-preview-path">{edit.path}</span>
                                <span className="chat-file-preview-label">View patch</span>
                              </summary>
                              <pre className="chat-file-code-scroll"><code>{edit.searchReplace.map((pair, idx) => (
                                `# Change ${idx + 1}\n<<<SEARCH\n${pair.search}\n>>>REPLACE\n${pair.replace}`
                              )).join("\n\n")}</code></pre>
                            </details>
                          ))}
                          {msg.parsed.deletions.map((d, j) => (
                            <div key={j} className="change-item deletion">x DEL: {d}</div>
                          ))}
                          {msg.parsed.commands.map((c, j) => (
                            <div key={j} className="change-item command">$ {c}</div>
                          ))}
                          {!msg.applied ? (
                            // In agent mode with autoApply, don't show buttons — they'll be auto-applied
                            agentTask?.active && agentTask?.autoApply ? (
                              <div className="applied-badge auto-applying"><Loader2 size={14} className="spin-inline" /> Auto-applying...</div>
                            ) : (
                            <div className="apply-actions">
                              <button className="apply-btn" onClick={() => handleApply(i)}>
                                <Check size={14} /> {getActionLabel(msg.parsed)}
                              </button>
                              <button className="apply-btn reject" onClick={() => handleReject(i)}>Reject</button>
                            </div>
                            )
                          ) : (
                            <div className="applied-badge"><Check size={14} /> Applied</div>
                          )}
                        </div>
                      )}
                      {msg.thinking && <ThinkingBlock content={msg.thinking} />}
                      {!agentTrace && !msg.parsed && !msg.blocks && !(msg.isComplete === false && streamingBlocks) && <MarkdownMessage text={msg.content} />}
                      {(msg.blocks && msg.blocks.length > 0) || (msg.isComplete === false && streamingBlocks) ? (
                        <MessageBubble
                          message={msg}
                          isStreaming={!msg.isComplete}
                          streamingBlocks={msg.isComplete === false ? streamingBlocks ?? undefined : undefined}
                        />
                      ) : null}
                    </>
                  )}
                  {msg.metrics && <ResponseMetricsDisplay metrics={msg.metrics} />}
                  {i === messages.length - 1 && loading && agentMode === "agent" && !msg.isComplete && (
                    <button className="agent-stream-stop" onClick={stopAgent} title="Stop Agent">
                      Stop
                    </button>
                  )}
                  {msg.checkResult && (
                    <div className={`check-result ${msg.checkResult.exitCode === 0 ? "success" : "failure"}`}>
                      <div className="check-result-header">
                        <span>{msg.checkResult.exitCode === 0 ? "Check Passed" : "Check Failed"}</span>
                        <code>{msg.checkResult.command}</code>
                      </div>
                      <pre>{msg.checkResult.stdout || "No output"}</pre>
                      {msg.checkResult.exitCode !== 0 && (
                        <div className="check-result-actions">
                          <button className="apply-btn" onClick={() => handleFixCheck(msg.checkResult!)} disabled={loading || cooldown}>
                            <Wrench size={14} /> Ask Punam to Fix This
                          </button>
                          {onRunProjectCheck && (
                            <button className="apply-btn secondary" onClick={onRunProjectCheck} disabled={checkingProject}>
                              <Check size={14} /> {checkingProject ? "Running..." : "Run Check Again"}
                            </button>
                          )}
                        </div>
                      )}
                    </div>
                  )}
                </>
              )}
            </div>
          </div>
          );
        })}

        {loading && !hasVisibleAssistantStream && (
          <div className="chat-message assistant working">
            <div className="chat-message-icon">
              <PunamAvatar active />
            </div>
            <div className="chat-message-content loading">
              <div className="agent-working-card">
                <div className="agent-working-main">
                  <Loader2 size={16} className="spin" />
                  <div className="agent-working-copy">
                    <strong>Working in {MODE_LABELS[agentMode]} mode</strong>
                    <span>
                      {agentMode === "agent" && agentTask?.active
                        ? agentActivityText || formatAgentStep(agentTask.step)
                        : contextSummary || "Collecting project context..."}
                    </span>
                  </div>
                  {agentMode === "agent" && (
                    <button className="agent-stop-btn" onClick={stopAgent} title="Stop Agent" style={{ marginLeft: "auto", fontSize: "11px", padding: "3px 8px" }}>
                      Stop
                    </button>
                  )}
                </div>
                {contextFiles.length > 0 && (
                  <div className="agent-working-context" title={contextFiles.join(", ")}>
                    <FileText size={10} />
                    {contextFiles.length} context file{contextFiles.length === 1 ? "" : "s"}
                  </div>
                )}
              </div>
            </div>
          </div>
        )}

        {/* Scroll sentinel — scrollIntoView target for auto-scroll */}
        <div ref={messagesEndRef} />
      </div>

      {agentTask && agentTask.active && agentTask.step === "awaiting_run" && agentTask.suggestedCommand && (
        <div className="agent-command-prompt" style={{ margin: "0 12px 4px", padding: "6px 10px", fontSize: "12px", flexShrink: 0 }}>
          <span>Run <code>{agentTask.suggestedCommand}</code>?</span>
          <div className="agent-command-actions">
            <button className="btn-primary compact" onClick={agentRunCommand}>Run</button>
            <button className="btn-secondary compact" onClick={agentSkipCommand}>Skip</button>
          </div>
        </div>
      )}

      {/* Edit Preview Panel — shown in chat mode when edits need review */}
      {editPreview.items.length > 0 && (
        <EditPreviewPanel
          items={editPreview.items}
          allAccepted={editPreview.allAccepted}
          onToggleItem={toggleEditItem}
          onAcceptAll={acceptAllEdits}
          onRejectAll={rejectAllEdits}
          onApply={handleApplyAcceptedEdits}
          onDismiss={handleDismissEditPreview}
        />
      )}

      {/* Clarification Dialog — inline above input when ambiguity detected */}
      {clarificationReport && (
        <ClarificationDialog
          report={clarificationReport}
          onAnswer={handleClarificationAnswer}
          onSkip={handleClarificationSkip}
        />
      )}

      {/* Budget Warning Dialog — inline above input when budget threshold reached */}
      {budgetWarning && (
        <BudgetWarningDialog
          status={budgetWarning.status}
          consumed={budgetWarning.consumed}
          remaining={budgetWarning.remaining}
          onDecision={handleBudgetDecision}
        />
      )}

      {/* Task Cost Summary — shown after agent task completes with budget active */}
      {taskCostSummary && (
        <TaskCostSummary consumed={taskCostSummary} />
      )}

      {/* Reasoning Panel — shows agent chain-of-thought below messages */}
      {reasoningChunks.length > 0 && (
        <ReasoningPanel
          chunks={reasoningChunks}
          mode={reasoningMode}
          visible={reasoningVisible}
          phaseTimings={phaseTimings}
          onToggleMode={() => setReasoningMode(reasoningMode === "compact" ? "expanded" : "compact")}
          onClickReference={handleReasoningRefClick}
          onClose={() => setReasoningVisible(false)}
        />
      )}

      {/* Input Area */}
      <ChatInputArea
        input={input}
        setInput={setInput}
        loading={loading}
        cooldown={cooldown}
        agentModePlaceholder={AGENT_MODES.find((mode) => mode.id === agentMode)?.placeholder ?? "Describe the change you want..."}
        openTabsCount={openTabs.length}
        activeFileRelPath={activeFilePath ? getRelativePath(projectPath, activeFilePath) : ""}
        hasSelection={!!(selectedText && selectedText.trim().length > 0)}
        problemsCount={problems?.length || 0}
        hasTerminalOutput={!!(terminalOutput && terminalOutput.trim().length > 0)}
        selectedProjectFiles={selectedProjectFiles}
        setSelectedProjectFiles={setSelectedProjectFiles}
        showFilePicker={showFilePicker}
        setShowFilePicker={setShowFilePicker}
        allProjectFiles={Array.from(collectExistingFiles()).sort()}
        attachments={attachments}
        removeAttachment={removeAttachment}
        handleFileAttach={handleFileAttach}
        handleFileInputChange={handleFileInputChange}
        handlePaste={handlePaste}
        fileInputRef={fileInputRef}
        aiProviders={aiProviders}
        configModel={config.model}
        configProvider={config.provider}
        tokenEstimate={getTokenEstimate()}
        activeModelOverride={activeModelOverride}
        adaptivePreview={getAdaptivePreview()}
        modelDropdownOpen={modelDropdownOpen}
        setModelDropdownOpen={setModelDropdownOpen}
        setActiveModelOverride={setActiveModelOverride}
        sessionTokens={sessionTokens}
        onSend={handleSend}
        onSendBackground={agentMode === "agent" ? () => {
          const text = input.trim();
          if (!text) return;
          setInput("");
          setMessages((prev) => [...prev, { role: "user", content: text, mode: "agent" }]);
          sendTaskDirectToBackground(text);
        } : undefined}
        onKeyDown={handleKeyDown}
        onRevert={onRevertLastApply ? async () => {
          await onRevertLastApply();
          setMessages((prev) => [...prev, { role: "assistant", content: "↩️ Last AI edit reverted." }]);
        } : undefined}
        hasAppliedMessages={checkpointCount}
        sendDisabled={!providerReady || loading || cooldown || (!input.trim() && attachments.length === 0)}
        isAgentMode={agentMode === "agent"}
        providerReady={providerReady}
      />
    </div>
  );
}
