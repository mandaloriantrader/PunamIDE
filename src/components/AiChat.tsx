import { useState, useRef, useEffect } from "react";
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
} from "lucide-react";
import { callLlm, readFile, searchProject } from "../utils/tauri";
import type { AppConfig, FileEntry } from "../utils/tauri";
import { checkTcpPort, runTerminalCommand } from "../utils/tauri";
import type { MCPServerConfig } from "../utils/mcp";
import { buildMcpToolsPrompt, parseMcpCalls, mcpCallTool, formatMcpResult } from "../utils/mcp";
import { SYSTEM_PROMPT, parseResponse } from "../utils/prompts";
import type { ParsedResponse } from "../utils/prompts";
import { sendToMultipleModels, sendToProviderStreaming, estimateTokens } from "../utils/providers";
import type { AIProviderConfig, ResponseMetrics } from "../utils/providers";
import { recordUsage } from "./UsageDashboard";
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
import { MarkdownMessage, PunamAvatar, ResponseMetricsDisplay, getActionLabel, formatAgentStep } from "./chat/ChatComponents";
import { ChatHeader } from "./chat/ChatHeader";
import { ChatInputArea } from "./chat/ChatInputArea";
import { useChatSessions } from "../hooks/useChatSessions";
import { useAttachments } from "../hooks/useAttachments";
import { parseResponseAsync } from "../hooks/useAiWorker";
import {
  assemblePersistentPayload,
  loadAgentMemories,
  compressMemories,
  summarizeOldMessages,
  extractMemoriesFromResponse,
} from "../utils/contextEngine";
import { runJsonToolLoop } from "../utils/jsonToolLoop";
import { resolveMentions, buildSuggestions } from "../utils/mentionResolver";
import { detectTaskType } from "../lib/ai/taskDetection";
import { selectAdaptiveProvider } from "../lib/ai/adaptiveRouter";
import type { AdaptiveStrategy } from "../lib/ai/providerCapabilities";
import { classifyProviderError, describeHealthStatus, markProviderHealthy, setProviderHealth } from "../lib/ai/providerHealth";
import type { RunObservation } from "../services/run/verifiedRun";
import { parseStreamBlocks, resetParseState } from "../utils/streamBlocks";
import MessageBubble from "./chat/MessageBubble";

// Background agent store
import { useBackgroundAgentStore } from "../store/backgroundAgentStore";
import { startBackgroundExecution } from "../services/backgroundAgentExecutor";

// --- Agent Task Types ---

type AgentStep = "planning" | "proposing_fix" | "awaiting_approval" | "awaiting_run" | "running_command" | "analyzing_output" | "verifying" | "completed" | "stopped";

interface AgentTaskState {
  active: boolean;
  task: string;
  step: AgentStep;
  attempt: number;
  maxAttempts: number;
  history: string[];
  suggestedCommand: string | null;
  autoApply: boolean;       // Skip diff preview, apply directly
  subtasks: string[];       // Task queue — list of subtasks to execute
  currentSubtask: number;   // Index of current subtask being executed
}

const DEPENDENCY_DRIFT_PATTERNS = [
  /node_modules[\\/]/i,
  /package-lock\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml|yarn\.lock/i,
  /\bnpm install\b|\bnpm update\b|\bnpm audit\b/i,
  /\brd \/s \/q node_modules\b|\brm -rf node_modules\b/i,
  /\btsc'? is not recognized\b/i,
  /tsBuildInfoFile|TS5069|TS6046|lib\.es\d+\.d\.ts/i,
  /@vitejs\/plugin-react|vite-plugin-checker|Cannot find module .+vite/i,
  /typescript|vite|tsconfig/i,
];

function looksLikeDependencyDrift(command: string, output: string, history: string[]): boolean {
  const text = [command, output, ...history].join("\n");
  return DEPENDENCY_DRIFT_PATTERNS.some((pattern) => pattern.test(text));
}

function hasParsedActions(parsed: ParsedResponse): boolean {
  return (
    parsed.fileChanges.length > 0 ||
    parsed.deletions.length > 0 ||
    parsed.commands.length > 0 ||
    parsed.editOperations.length > 0
  );
}

function getStreamingTextBeforeActionBlocks(text: string): string {
  const actionMarker = text.match(/(^|\n)===(FILE|EDIT|DELETE|CMD):/);
  if (!actionMarker) return text.trim();

  const markerIndex = actionMarker.index ?? 0;
  return text.slice(0, markerIndex).trim() || "Preparing code changes...";
}

function ParsedActionsView({
  parsed,
  applied,
  autoApplying,
  onApply,
  onReject,
}: {
  parsed: ParsedResponse;
  applied?: boolean;
  autoApplying?: boolean;
  onApply: () => void;
  onReject?: () => void;
}) {
  if (!hasParsedActions(parsed)) return null;

  return (
    <div className="chat-changes">
      {parsed.fileChanges.map((fc, j) => (
        <details key={`file-${j}`} className="chat-file-preview">
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
      {parsed.editOperations.map((edit, j) => (
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
      {parsed.deletions.map((d, j) => (
        <div key={`delete-${j}`} className="change-item deletion">x DEL: {d}</div>
      ))}
      {parsed.commands.map((c, j) => (
        <div key={`cmd-${j}`} className="change-item command">$ {c}</div>
      ))}
      {!applied ? (
        autoApplying ? (
          <div className="applied-badge auto-applying"><Loader2 size={14} className="spin-inline" /> Auto-applying...</div>
        ) : (
          <div className="apply-actions">
            <button className="apply-btn" onClick={onApply}>
              <Check size={14} /> {getActionLabel(parsed)}
            </button>
            {onReject && <button className="apply-btn reject" onClick={onReject}>Reject</button>}
          </div>
        )
      ) : (
        <div className="applied-badge"><Check size={14} /> Applied</div>
      )}
    </div>
  );
}

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

const AGENT_MODES: Array<{
  id: AgentMode;
  label: string;
  icon: ElementType;
  placeholder: string;
  instruction: string;
}> = [
  {
    id: "chat",
    label: "Chat",
    icon: MessageCircle,
    placeholder: "Describe the change you want...",
    instruction:
      "Mode: Chat. You are Punam, an AI coding assistant. Respond to the user's request appropriately:\n" +
      "- If they ask a question, explain clearly and concisely.\n" +
      "- If they ask for a code change, fix, or refactor, produce FILE blocks using the required format so the IDE can show a diff preview.\n" +
      "- If they ask to run, start, execute, or open something, produce CMD blocks (e.g. ===CMD: npm run dev===).\n" +
      "- If they ask to open a standalone HTML file in the browser on Windows, produce a CMD block like ===CMD: start index.html===.\n" +
      "- Keep responses focused and practical. Show code changes when asked, explain when asked, run commands when asked.",
  },
  {
    id: "agent",
    label: "Agent",
    icon: Zap,
    placeholder: "Describe any task — I'll plan and execute it autonomously...",
    instruction:
      "Mode: Agent. You are an autonomous coding agent. Plan step-by-step, then execute: create/edit/delete files, run commands, and iterate until the task is complete. Be thorough and precise.",
  },
];

const MODE_LABELS = Object.fromEntries(
  AGENT_MODES.map((mode) => [mode.id, mode.label])
) as Record<AgentMode, string>;

const hasUsableProvider = (provider: AIProviderConfig) =>
  provider.models.some((model) => model.enabled && model.id) &&
  (Boolean(provider.apiKey) || /ollama/i.test(provider.name) || /localhost:11434/i.test(provider.baseUrl || ""));

function recordResponseUsage(metrics?: ResponseMetrics) {
  if (!metrics || metrics.status !== "success") return;
  recordUsage(
    metrics.provider,
    metrics.model,
    metrics.promptTokens || 0,
    metrics.responseTokens || 0,
    metrics.estimatedCostInr
  );
}

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
  const [toolModeEnabled, setToolModeEnabled] = useState<boolean>(() => {
    try { return localStorage.getItem("punam-tool-mode") === "true"; } catch { return false; }
  });
  const [modelDropdownOpen, setModelDropdownOpen] = useState(false);
  const [activeModelOverride, setActiveModelOverride] = useState<{ providerId: string; model: string } | null>(null);
  const [loading, setLoading] = useState(false);
  const [cooldown, setCooldown] = useState(false);
  const [contextSummary, setContextSummary] = useState("");
  const [contextFiles, setContextFiles] = useState<string[]>([]);
  const [sessionTokens, setSessionTokens] = useState<{ totalIn: number; totalOut: number; totalCostInr: number; requestCount: number }>({ totalIn: 0, totalOut: 0, totalCostInr: 0, requestCount: 0 });

  // --- Extracted Hooks ---
  const {
    sessions,
    activeSessionId,
    showSessionList,
    setShowSessionList,
    handleNewSession,
    handleSwitchSession,
    handleDeleteSession,
  } = useChatSessions({ projectPath, messages, setMessages });

  const {
    attachments,
    isDragOver,
    fileInputRef,
    handleFileAttach,
    handleFileInputChange,
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
  const activeStreamRef = useRef<{ cancel: () => void; streamId: string } | null>(null);
  const [streamProgress, setStreamProgress] = useState<{ tokens: number; startedAt: number } | null>(null);
  // Prevents duplicate sends while streaming
  const isStreamingRef = useRef(false);

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
  useEffect(() => {
    if (!projectPath || !files.length) return;
    if (!isIndexed()) {
      indexProject(projectPath, files).catch(() => {});
    }
  }, [projectPath, files]);

  // Compute session totals from messages with metrics
  useEffect(() => {
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
  }, [messages]);
  const bottomRef = useRef<HTMLDivElement>(null);

  // --- Agent Task State ---
  const [agentTask, setAgentTask] = useState<AgentTaskState | null>(null);

  // --- Chat Export ---
  const handleExportChat = async () => {
    if (messages.length === 0) return;
    const activeSession = sessions.find((s) => s.id === activeSessionId);
    const title = activeSession?.title || "Punam Chat";
    const date = new Date().toISOString().split("T")[0];

    let markdown = `# ${title}\n\n`;
    markdown += `*Exported from PunamIDE on ${date}*\n\n---\n\n`;

    for (const msg of messages) {
      const role = msg.role === "user" ? "**You**" : "**Punam**";
      const modeTag = msg.mode ? ` _(${msg.mode} mode)_` : "";
      markdown += `### ${role}${modeTag}\n\n`;

      if (msg.parsed?.explanation) {
        markdown += `${msg.parsed.explanation}\n\n`;
        if (msg.parsed.fileChanges.length > 0) {
          markdown += `**Files changed:**\n`;
          for (const fc of msg.parsed.fileChanges) {
            markdown += `- ${fc.isNew ? "Created" : "Modified"}: \`${fc.path}\`\n`;
          }
          markdown += "\n";
        }
      } else {
        markdown += `${msg.content}\n\n`;
      }

      if (msg.attachments && msg.attachments.length > 0) {
        markdown += `*Attachments: ${msg.attachments.map((a) => a.name).join(", ")}*\n\n`;
      }

      markdown += "---\n\n";
    }

    try {
      const { save } = await import("@tauri-apps/plugin-dialog");
      const { writeTextFile } = await import("@tauri-apps/plugin-fs");
      const filePath = await save({
        defaultPath: `${title.replace(/[^a-zA-Z0-9]/g, "_")}_${date}.md`,
        filters: [{ name: "Markdown", extensions: ["md"] }],
      });
      if (filePath) {
        await writeTextFile(filePath, markdown);
        setMessages((prev) => [...prev, { role: "assistant", content: `✅ Chat exported to \`${filePath}\`` }]);
      }
    } catch {
      try {
        await navigator.clipboard.writeText(markdown);
        setMessages((prev) => [...prev, { role: "assistant", content: "✅ Chat copied to clipboard (save dialog unavailable)." }]);
      } catch {
        setMessages((prev) => [...prev, { role: "assistant", content: "⚠️ Could not export chat. Try again." }]);
      }
    }
  };

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, loading]);

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

  const getIdentityResponse = (text: string): string | null => {
    const lower = text.toLowerCase().replace(/[?!.,]/g, "").trim();

    // Exact-match greetings (only fire if the ENTIRE message is just a greeting)
    const exactGreetings = ["hello", "hi", "hey", "hey punam", "hi punam", "hello punam"];
    const isExactGreeting = exactGreetings.includes(lower);

    // Phrase-match identity questions (can appear within longer text)
    const identityPhrases = [
      "who are you", "what are you", "whats your name", "what is your name",
      "your name", "introduce yourself", "tell me about yourself",
      "who made you", "who created you", "who built you", "who developed you",
      "who is your creator", "who is your developer", "who designed you",
      "are you ai", "are you a bot", "are you human",
    ];

    // "what can you do" only if it's the main intent (short message)
    const isCapabilityQuestion = (lower.includes("what can you do") || lower.includes("what do you do") || lower.includes("how do you work")) && lower.length < 40;

    const isIdentityQuestion = identityPhrases.some((trigger) => lower.includes(trigger));

    if (!isExactGreeting && !isIdentityQuestion && !isCapabilityQuestion) return null;

    if (lower.includes("who made") || lower.includes("who created") || lower.includes("who built") || lower.includes("who developed") || lower.includes("creator") || lower.includes("developer") || lower.includes("designed")) {
      return "I was created and developed by **Amritanshu Amar**. He designed me to be an intelligent, AI-powered coding assistant that helps developers write, edit, and manage code through natural language — all from within a sleek desktop IDE.";
    }

    if (lower.includes("what can you do") || lower.includes("what do you do") || lower.includes("how do you work")) {
      return "I'm **Punam**, your AI-powered coding assistant! I was created by **Amritanshu Amar**.\n\nHere's what I can do:\n\n• **Edit & create files** — describe what you want in plain English and I'll generate the code changes\n• **Understand your project** — I can see your file tree and understand the structure\n• **Multi-language support** — Python, JavaScript, TypeScript, Rust, Go, Java, and many more\n• **Run commands** — I can suggest terminal commands to run\n• **Debug & fix** — describe a bug and I'll find and fix it\n\nJust type what you need!";
    }

    if (isExactGreeting) {
      return "Hey there! I'm **Punam**, your AI coding assistant created by **Amritanshu Amar**. I'm here to help you write, edit, and manage your code. Just tell me what you need — describe it in plain English and I'll take care of the rest!";
    }

    return "Hi! I'm **Punam** — an AI-powered coding assistant built right into this IDE. I was created and developed by **Amritanshu Amar**.\n\nI help you write, modify, and debug code using natural language. Just describe what you want — like \"add a login page\" or \"fix the error in main.py\" — and I'll generate the exact code changes, show you a preview, and apply them when you're ready.\n\nI support multiple AI providers (Google Gemini, OpenAI, OpenRouter, Groq, Mistral AI, Ollama) and work with any programming language. Think of me as your personal coding partner!";
  };

  const collectExistingFiles = () => {
    const existingFiles = new Set<string>();
    const collectPaths = (entries: FileEntry[], prefix = "") => {
      for (const e of entries) {
        const p = prefix ? `${prefix}/${e.name}` : e.name;
        if (e.is_dir && e.children) collectPaths(e.children, p);
        else existingFiles.add(p);
      }
    };
    collectPaths(files);
    return existingFiles;
  };

  /**
   * Unified context builder — single-pass with deduplication.
   * Priority order (highest to lowest): open tabs, @mentions, key files, @codebase/search hits, errors.
   * Files already loaded by mentionResolver are tracked to avoid re-reads.
   */
  const buildProjectContext = async (userPrompt = "", alreadyLoadedResolved?: Set<string>) => {
    const existingFiles = collectExistingFiles();
    const contextFiles = new Map<string, string>();
    const queued = new Set<string>(); // paths queued for loading (avoids duplicate reads)
    const resolvedSet = alreadyLoadedResolved || new Set<string>();

    // Queue a file for loading without checking disk yet (batched later)
    const queueFile = (relativePath: string) => {
      if (!relativePath || relativePath === "none") return;
      if (contextFiles.has(relativePath)) return;
      if (resolvedSet.has(relativePath)) return;
      if (queued.has(relativePath)) return;
      queued.add(relativePath);
    };

    // 1. Open tabs (in-memory, highest priority, don't override disk content)
    for (const tab of openTabs) {
      const rel = getRelativePath(projectPath, tab.path);
      if (!contextFiles.has(rel)) {
        contextFiles.set(rel, tab.content);
      }
    }

    // 2. @file mentions from the NEW resolver (already resolved before this call)
    // The mention context blocks were appended to the prompt; we don't need to re-read.
    // But any remaining mentions in userPrompt not caught by @ notation should still load.
    for (const mentionedPath of getMentionedFilePaths(userPrompt, existingFiles)) {
      if (contextFiles.has(mentionedPath)) continue;
      if (resolvedSet.has(mentionedPath)) {
        resolvedSet.delete(mentionedPath);
        continue;
      }
      queueFile(mentionedPath);
    }

    // 3. @folder mentions
    for (const folderFile of getMentionedFolderFiles(userPrompt, existingFiles)) {
      if (contextFiles.has(folderFile)) continue;
      queueFile(folderFile);
    }

    // 4. Key context files (package.json, tsconfig.json, etc.) — only if available
    for (const keyFile of KEY_CONTEXT_FILES) {
      if (!existingFiles.has(keyFile)) continue;
      if (contextFiles.has(keyFile)) continue;
      queueFile(keyFile);
    }

    // 5. Selected project files (multi-file refactoring)
    for (const fp of selectedProjectFiles) {
      if (contextFiles.has(fp)) continue;
      queueFile(fp);
    }

    // 6. @codebase mention: TF-IDF hits or limited fallback
    const hasCodebaseMention = /@codebase\b/i.test(userPrompt);
    if (hasCodebaseMention) {
      if (isIndexed()) {
        const codebaseQuery = userPrompt.replace(/@codebase\b/i, "").trim();
        const hits = searchCodebase(codebaseQuery || userPrompt, 5);
        for (const hit of hits) {
          if (contextFiles.has(hit.path)) continue;
          queueFile(hit.path);
        }
      }
      // Small fallback: load up to 10 more files if context is still sparse
      if (contextFiles.size < 5) {
        for (const fp of [...existingFiles].slice(0, 10)) {
          if (contextFiles.has(fp)) continue;
          if (queued.has(fp)) continue;
          queueFile(fp);
        }
      }
    }

    // 7. Semantic search hits
    const searchMatch = userPrompt.match(/(?:where|find|search|which file|who uses|grep|look for)\s+["`']?([^"`'\n]{3,40})["`']?/i);
    if (searchMatch && projectPath) {
      const searchQuery = searchMatch[1].trim();
      try {
        const results = await searchProject(searchQuery);
        for (const result of results.slice(0, 3)) {
          if (contextFiles.has(result.path)) continue;
          queueFile(result.path);
        }
      } catch { /* ignore */ }
    }

    // 8. Error-referenced files
    const errorContextText = [terminalOutput || "", proactiveError?.output || ""].filter(Boolean).join("\n");
    for (const errorFile of getFilePathsFromText(errorContextText, existingFiles)) {
      if (contextFiles.has(errorFile)) continue;
      queueFile(errorFile);
    }

    // 9. Active file (always include)
    if (activeFilePath) {
      const relPath = getRelativePath(projectPath, activeFilePath);
      if (!contextFiles.has(relPath)) {
        queueFile(relPath);
      }
    }

    // ═══ BATCH LOAD: read all queued files ═══
    const queuedArr = [...queued];
    const readPromises = queuedArr.map(async (relPath) => {
      const fp = getProjectFilePath(projectPath, relPath);
      // For active file, use the original path directly
      const readPath = (relPath === getRelativePath(projectPath, activeFilePath || "")) && activeFilePath
        ? activeFilePath
        : fp;
      const content = await readFile(readPath).catch(() => "");
      return { path: relPath, content };
    });

    const results = await Promise.all(readPromises);
    for (const { path: relPath, content } of results) {
      if (content && !contextFiles.has(relPath)) {
        contextFiles.set(relPath, content);
      }
    }

    // ═══ BUILD OUTPUT ═══
    let totalChars = 0;
    const sections: string[] = [];
    const attachedNames: string[] = [];

    for (const [path, content] of contextFiles) {
      if (totalChars >= MAX_TOTAL_CONTEXT_CHARS) break;
      const remaining = MAX_TOTAL_CONTEXT_CHARS - totalChars;
      const clipped = truncateContext(content, Math.min(MAX_CONTEXT_FILE_CHARS, remaining));
      sections.push(`## ${path}\n\`\`\`\n${clipped}\n\`\`\``);
      attachedNames.push(path);
      totalChars += clipped.length;
    }

    setContextFiles(attachedNames);
    setContextSummary(
      attachedNames.length > 0
        ? `Context attached: ${attachedNames.slice(0, 4).join(", ")}${attachedNames.length > 4 ? ` +${attachedNames.length - 4} more` : ""}`
        : "Context attached: file tree only"
    );

    // Frameworks
    const packageJson = contextFiles.get("package.json") || null;
    const cargoToml = contextFiles.get("Cargo.toml") || contextFiles.get("src-tauri/Cargo.toml") || null;
    const frameworks = detectFrameworks(packageJson, cargoToml);
    const frameworkSection = frameworks.length > 0
      ? `\n\n# Detected Frameworks\n${frameworks.join(", ")}`
      : "";

    // Project rules
    let projectRulesSection = "";
    for (const rulesFile of PROJECT_RULES_FILES) {
      const rulesContent = await readFile(getProjectFilePath(projectPath, rulesFile)).catch(() => "");
      if (rulesContent) {
        projectRulesSection = `\n\n# Project Rules (from ${rulesFile})\nFollow these project-specific instructions:\n${rulesContent.slice(0, 3000)}`;
        break;
      }
    }

    // --- @git mention or fix/explain mode: inject git history ---
    const needsGit = /@git\b/i.test(userPrompt) || agentMode === "agent";
    let gitSection = "";
    if (needsGit && projectPath) {
      const activePaths = [...contextFiles.keys()].slice(0, 3);
      gitSection = await buildGitContext(projectPath, activePaths, runTerminalCommand).catch(() => "");
      if (gitSection) gitSection = `\n\n${gitSection}`;
    }

    // --- @web mention: inject cached web search results ---
    let webSection = "";
    if (webSearchResults) {
      webSection = `\n\n# Web Search Results\n${webSearchResults}`;
      setWebSearchResults(""); // consume once
    }

    // --- Project Notes (@notes) ---
    let notesSection = "";
    const hasNotesMention = /@notes\b/i.test(userPrompt);
    const notesContent = hasNotesMention ? projectNotes : projectNotes;
    if (notesContent && notesContent.trim()) {
      notesSection = `\n\n# Project Notes (always read these)\n${notesContent.slice(0, 3000)}`;
    }

    return sections.join("\n\n") + frameworkSection + projectRulesSection + gitSection + webSection + notesSection;
  };

  const requestPunam = async (userPrompt: string, mode: AgentMode = agentMode) => {
    // Check if any API key is available (new provider system OR legacy config)
    const hasProviderKey = aiProviders.some((p) => p.apiKey && p.models.some((m) => m.enabled));
    if (!config.api_key && !hasProviderKey) {
      setMessages((prev) => [
        ...prev,
        { role: "assistant", content: "Please set your API key in Settings first." },
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

      const fileTree = buildFileContext(files);
      const attachedContext = await buildProjectContext(enrichedUserPrompt);

      // If user is searching for something, include search results
      let searchSection = "";
      const searchKeywords = /\b(find|search|where|locate|which file|grep|usage|used|called|imported)\b/i;
      if (searchKeywords.test(userPrompt) && projectPath) {
        // Extract likely search terms from the prompt
        const searchTerms = userPrompt
          .replace(/\b(find|search|where|locate|which file|grep|usage|used|called|imported|in|the|is|are|all|of|for|this|that|how|many|times)\b/gi, "")
          .trim()
          .split(/\s+/)
          .filter((w) => w.length > 2)
          .slice(0, 2);
        if (searchTerms.length > 0) {
          const query = searchTerms.join(" ");
          const results = await searchProject(query).catch(() => []);
          if (results.length > 0) {
            const resultLines = results.slice(0, 15).map(
              (r) => `${r.path}:${r.line} — ${r.preview.slice(0, 100)}`
            );
            searchSection = `\n\n# Search Results for "${query}" (${results.length} matches)\n\`\`\`\n${resultLines.join("\n")}\n\`\`\``;
          }
        }
      }
      const modeInstruction = AGENT_MODES.find((item) => item.id === mode)?.instruction ?? AGENT_MODES[1].instruction;

      // --- MCP Tools section ---
      const mcpToolsSection = buildMcpToolsPrompt(mcpServers);
      const mcpSection = mcpToolsSection ? `\n\n${mcpToolsSection}` : "";

      // Build prompt with priority order
      const hasSelection = selectedText && selectedText.trim().length > 0;
      const activeRelPath = activeFilePath ? getRelativePath(projectPath, activeFilePath) : "";
      const openTabNames = openTabs.map((tab) => getRelativePath(projectPath, tab.path));
      const workspaceSection = `\n\n# Current Workspace (authoritative)\nProject root: ${projectPath || "none"}\nProject name: ${projectPath ? projectPath.split(/[\\/]/).pop() : "none"}\nIMPORTANT: Treat this as the only current project. If conversation history, terminal output, or prior messages mention another path, they are stale unless they match this project root.`;
      const editorStateSection = `\n\n# Editor State\nActive file: ${activeRelPath || "none"}\nOpen tabs: ${openTabNames.length > 0 ? openTabNames.join(", ") : "none"}`;

      let selectionSection = "";
      if (hasSelection) {
        selectionSection = `\n\n# Selected Code${activeRelPath ? ` (in ${activeRelPath})` : ""}\nThis is the PRIMARY TARGET of the user's request. Analyze, explain, or modify THIS code.\n\`\`\`\n${selectedText!.slice(0, 3000)}\n\`\`\``;
      }

      let problemsSection = "";
      if (problems && problems.length > 0) {
        const problemLines = problems.slice(0, 20).map(
          (p) => `[${p.severity}] ${p.path}:${p.line} — ${p.message}`
        );
        problemsSection = `\n\n# Current Problems/Errors (${problems.length} total)\n\`\`\`\n${problemLines.join("\n")}\n\`\`\``;
      }

      let terminalSection = "";
      const terminalContextText = [terminalOutput || "", proactiveError?.output || ""]
        .filter(Boolean)
        .join("\n");
      if (terminalContextText.trim().length > 0) {
        terminalSection = `\n\n# Recent Terminal Output\n\`\`\`\n${terminalContextText.slice(-6000)}\n\`\`\``;
      }

      const contextInstruction = hasSelection
        ? "\n\nIMPORTANT: Selected code exists. Treat it as the primary target of the request. Do NOT give a generic introduction. Directly analyze, explain, or modify the selected code based on the user's request."
        : "";

      // Build conversation history (last 10 messages for context continuity)
      const recentHistory = messages.slice(-10).map((m) => {
        const role = m.role === "user" ? "User" : "Punam";
        const content = m.role === "assistant" && m.parsed
          ? m.parsed.explanation || "(applied code changes)"
          : m.content.slice(0, 500);
        return `${role}: ${content}`;
      }).join("\n");
      const historySection = recentHistory ? `\n\n# Conversation History (recent)\n${recentHistory}` : "";

      // Detect @file mentions that don't resolve to existing files (B010)
      const unresolvedFiles = getUnresolvedMentions(userPrompt, collectExistingFiles());
      const unresolvedSection = unresolvedFiles.length > 0
        ? `\n\n# ⚠️ Non-Existent File References\nThe user mentioned the following file(s) that do NOT exist in the project:\n${unresolvedFiles.map((f) => `- ${f}`).join("\n")}\nIMPORTANT: Before proposing to create these files, explicitly tell the user that the file does not exist and ask if they want you to create it. Do NOT silently create files that the user may have assumed already existed.`
        : "";

      const prompt = `# Agent Mode\n${modeInstruction}${contextInstruction}${mcpSection}${workspaceSection}\n\n# User Request\n${userPrompt}${editorStateSection}${selectionSection}${searchSection}${problemsSection}${terminalSection}${unresolvedSection}${historySection}\n\n# Project Structure\n\`\`\`\n${fileTree}\`\`\`\n\n# Attached File Context\n${attachedContext || "No file contents attached."}`;

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
            terminalOutput: terminalContextText,
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

          const streamId = `stream-${Date.now()}`;
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
            let pendingFlush = false;
            let flushTimer: ReturnType<typeof setTimeout> | null = null;

            const flushStreamedText = () => {
              pendingFlush = false;
              flushTimer = null;
              resetParseState();
              const result = parseStreamBlocks(streamedText);
              const blocks = [...result.completed, ...(result.inProgress ? [result.inProgress] : [])];
              const displayText = "";
              setMessages((prev) => prev.map((m) =>
                (m as any).streamId === streamId
                  ? { ...m, content: `${[firstNotice, ...fallbackNotices].join("\n")}\n`, blocks, isComplete: false }
                  : m
              ));
            };

            const unlisten = await listen<{ token: string; done: boolean }>("llm-stream", (event) => {
              const { token, done } = event.payload;
              if (!done && token) {
                streamedText += token;
                if (!pendingFlush) {
                  pendingFlush = true;
                  flushTimer = setTimeout(flushStreamedText, 40);
                }
              }
            });

            const resp = await sendToProviderStreaming(candidate.provider, candidate.model, {
              systemPrompt: SYSTEM_PROMPT,
              userPrompt: prompt,
              images: imagePayload,
            });
            unlisten();
            if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
            if (pendingFlush) flushStreamedText();

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

          const noticeText = [`Used ${selectedProviderName} / ${selectedModelId}.`, ...fallbackNotices].join("\n");
          const responseText = `${noticeText}\n\n${finalText}`;
          let parsed = finalResp?.success ? await parseResponseAsync(finalText, collectExistingFiles()) : null;
          if (parsed && parsed.editOperations.length > 0) {
            parsed = await resolveEditOperations(parsed, projectPath);
          }
          const hasActions = parsed ? hasParsedActions(parsed) : false;
          recordResponseUsage(finalResp?.metrics);

          const finalBlocks = parseStreamBlocks(finalText).completed;
          setMessages((prev) => prev.map((m) => {
            if ((m as any).streamId !== streamId) return m;
            const { streamId: _sid, ...rest } = m as any;
            return {
              ...rest,
              content: responseText,
              blocks: finalBlocks,
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
            const streamId = `stream-${Date.now()}`;
            setMessages((prev) => [...prev, { role: "assistant", content: "▍", mode, streamId } as ChatMessage & { streamId: string }]);

            // Listen for streaming tokens — BATCHED for performance
            const { listen } = await import("@tauri-apps/api/event");
            let streamedText = "";
            let tokenCount = 0;
            const streamStart = performance.now();
            let rafId = 0;

            const flushStreamedText = () => {
              resetParseState();
              const result = parseStreamBlocks(streamedText);
              const blocks = [...result.completed, ...(result.inProgress ? [result.inProgress] : [])];
              const elapsed = (performance.now() - streamStart) / 1000;
              const tps = elapsed > 0 ? Math.round(tokenCount / elapsed) : 0;
              setMessages((prev) => prev.map((m) =>
                (m as any).streamId === streamId
                  ? { ...m, content: "", blocks, isComplete: false, streamProgress: `${tps} t/s` }
                  : m
              ));
            };

            const unlisten = await listen<{ token: string; done: boolean }>("llm-stream", (event) => {
              const { token, done } = event.payload;
              if (!done && token) {
                streamedText += token;
                tokenCount++;
                if (!rafId) rafId = requestAnimationFrame(() => { rafId = 0; flushStreamedText(); });
              }
            });

            activeStreamRef.current = { cancel: () => { cancelAnimationFrame(rafId); unlisten(); }, streamId };

            // Send the streaming request
            const imagePayload = currentImages.length > 0
              ? currentImages.map((img) => ({ base64: img.base64, mimeType: img.mimeType }))
              : undefined;
            const resp = await sendToProviderStreaming(provider, modelId, { systemPrompt: SYSTEM_PROMPT, userPrompt: prompt, images: imagePayload });
            unlisten();
            cancelAnimationFrame(rafId);
            flushStreamedText(); // final flush

            // Finalize: parse the full response and render properly
            const finalText = resp.success ? resp.text : (resp.error || "Unknown error");
            let parsed = resp.success ? await parseResponseAsync(finalText, collectExistingFiles()) : null;
            // Resolve EDIT blocks into fileChanges
            if (parsed && parsed.editOperations.length > 0) {
              parsed = await resolveEditOperations(parsed, projectPath);
            }
            const hasActions = parsed ? hasParsedActions(parsed) : false;

            // --- MCP tool auto-execution ---
            let effectiveFinalText = finalText;
            if (resp.success && mcpServers.length > 0) {
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

            const finalBlocks = parseStreamBlocks(effectiveFinalText).completed;
            setMessages((prev) => prev.map((m) => {
              if ((m as any).streamId !== streamId) return m;
              const { streamId: _sid, ...rest } = m as any;
              return {
                ...rest,
                content: effectiveFinalText,
                blocks: finalBlocks,
                isComplete: true,
                parsed: hasActions ? parsed : undefined,
                applied: false,
                metrics: resp.metrics,
              };
            }));
            recordResponseUsage(resp.metrics);
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
            let parsed = parseResponse(resp.text, collectExistingFiles());
            if (parsed.editOperations.length > 0) {
              parsed = await resolveEditOperations(parsed, projectPath);
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

        let parsed = parseResponse(response.text, collectExistingFiles());
        if (parsed.editOperations.length > 0) {
          parsed = await resolveEditOperations(parsed, projectPath);
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
      startAgentTask(text);
      await agentProposeFix();
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
      startAgentTask(text);
      await agentProposeFix();
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

  const startAgentTask = (task: string) => {
    // Parse subtasks if the user provided a numbered list
    const subtaskPattern = /^\s*(?:\d+[\.\)]\s*|[-*]\s+)(.+)$/gm;
    const matches = [...task.matchAll(subtaskPattern)];
    const subtasks = matches.length > 1
      ? matches.map(m => m[1].trim())
      : [task];

    setAgentTask({
      active: true,
      task,
      step: "planning",
      attempt: 1,
      maxAttempts: 15,
      history: [],
      suggestedCommand: null,
      autoApply: true,  // Agent mode defaults to auto-apply
      subtasks,
      currentSubtask: 0,
    });
  };

  const stopAgent = () => {
    setAgentTask(null);
    setMessages((prev) => [...prev, {
      role: "assistant",
      content: "Agent stopped by user.",
    }]);
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

  const agentProposeFix = async () => {
    if (!agentTask || !agentTask.active) {
      console.log("[AGENT] agentProposeFix bailed — agentTask:", agentTask);
      return;
    }

    // ── Intercept simple meta-questions that don't need an API call ──────────
    const taskLower = agentTask.task.toLowerCase();
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

    // ── Tool Mode Path (JSON tool loop — low token usage) ───────────────────
    if (toolModeEnabled) {
      setAgentTask((prev) => prev ? { ...prev, step: "proposing_fix" } : null);
      setLoading(true);

      try {
        const enabledModels = getEnabledModels();
        if (enabledModels.length === 0) {
          setMessages(prev => [...prev, { role: "assistant", content: "No AI provider configured." }]);
          setLoading(false);
          return;
        }
        const { providerId, model: modelId } = enabledModels[0];
        const provider = aiProviders.find(p => p.id === providerId);
        if (!provider) {
          setMessages(prev => [...prev, { role: "assistant", content: "Provider not found." }]);
          setLoading(false);
          return;
        }

        // Show thinking indicator
        setMessages(prev => [...prev, { role: "assistant", content: "🔧 Tool mode: reading files...", mode: "chat" } as any]);

        const result = await runJsonToolLoop({
          provider,
          modelId,
          task: agentTask.task,
          projectPath,
          activeFilePath,
          onToolCall: (toolName) => {
            setMessages(prev => {
              const last = prev[prev.length - 1];
              if (last?.role === "assistant" && last.content.startsWith("🔧")) {
                return [...prev.slice(0, -1), { ...last, content: `🔧 Tool mode: ${toolName}...` }];
              }
              return prev;
            });
          },
        });

        // Replace thinking indicator with final answer
        setMessages(prev => {
          const filtered = prev.filter(m => !(m.role === "assistant" && m.content.startsWith("🔧")));
          return [...filtered, {
            role: "assistant",
            content: result.text,
            mode: "chat",
            metrics: result.metrics,
          } as any];
        });

        console.log(`[TOOL MODE] Done in ${result.rounds} round(s). Tools: ${result.toolsCalled.join(", ") || "none"}. Saved ~${result.tokensSaved} tokens.`);

      } catch (err) {
        setMessages(prev => [...prev, { role: "assistant", content: `Tool mode error: ${err instanceof Error ? err.message : String(err)}. Falling back to full context.` }]);
      } finally {
        setLoading(false);
        setAgentTask(null);
      }
      return;
    }

    setAgentTask((prev) => prev ? { ...prev, step: "proposing_fix" } : null);

    // ── Build context using the Context Engine ──────────────────────────────
    const existingFiles = collectExistingFiles();
    const errorContextText = [terminalOutput || "", proactiveError?.output || ""]
      .filter(Boolean)
      .join("\n");
    const errorFiles = getFilePathsFromText(errorContextText, existingFiles);

    // Load relevant file snippets (error-referenced files + active file)
    const snippets: string[] = [];
    for (const filePath of errorFiles.slice(0, 3)) {
      try {
        const content = await readFile(getProjectFilePath(projectPath, filePath));
        if (content) {
          snippets.push(`## ${filePath}\n\`\`\`\n${content.slice(0, 6000)}\n\`\`\``);
        }
      } catch { /* skip */ }
    }
    if (activeFilePath) {
      const relPath = getRelativePath(projectPath, activeFilePath);
      if (!errorFiles.includes(relPath)) {
        const content = await readFile(activeFilePath).catch(() => "");
        if (content) snippets.push(`## ${relPath}\n\`\`\`\n${content.slice(0, 100000)}\n\`\`\``);
      }
    }

    // Load persistent memories
    const memories = loadAgentMemories(projectPath);
    const compressedMemory = compressMemories(memories);

    // Summarize old messages
    const chatSummary = summarizeOldMessages(messages);
    const fullMemory = [compressedMemory, chatSummary].filter(Boolean).join("\n\n");

    // Previous attempt history
    const historyContext = agentTask.history.length > 0
      ? `Previous attempts (DO NOT repeat):\n${agentTask.history.map((h, i) => `${i + 1}. ${h}`).join("\n")}`
      : "";

    // Build the payload using the Context Engine formula
    const currentTask = agentTask.subtasks.length > 1
      ? agentTask.subtasks[agentTask.currentSubtask]
      : agentTask.task;

    const payload = assemblePersistentPayload({
      globalGoal: agentTask.task,
      currentSubtask: `${currentTask} (attempt ${agentTask.attempt}/${agentTask.maxAttempts})${historyContext ? "\n" + historyContext : ""}`,
      fullHistory: messages,
      activeFileSnippets: snippets,
      latestErrors: errorContextText.slice(-2000),
      projectMemory: fullMemory,
      projectPath,
      activeFilePath: activeFilePath || undefined,
    });

    // ── Send to AI using the optimized payload ──────────────────────────────
    setLoading(true);
    try {
      const enabledModels = getEnabledModels();
      if (enabledModels.length === 0) {
        setMessages(prev => [...prev, { role: "assistant", content: "No AI provider configured." }]);
        setLoading(false);
        return;
      }

      const { providerId, model: modelId } = enabledModels[0];
      const provider = aiProviders.find(p => p.id === providerId);
      if (!provider) {
        setMessages(prev => [...prev, { role: "assistant", content: "Provider not found." }]);
        setLoading(false);
        return;
      }

      // Stream with batching
      const streamId = `stream-${Date.now()}`;
      setMessages(prev => [...prev, { role: "assistant", content: "▍", mode: "chat", streamId } as any]);

      const { listen } = await import("@tauri-apps/api/event");
      let streamedText = "";
      let pendingFlush = false;
      let flushTimer: ReturnType<typeof setTimeout> | null = null;

      const flushStreamedText = () => {
        pendingFlush = false;
        flushTimer = null;
        resetParseState();
        const result = parseStreamBlocks(streamedText);
        const blocks = [...result.completed, ...(result.inProgress ? [result.inProgress] : [])];
        setMessages(prev => prev.map(m =>
          (m as any).streamId === streamId ? { ...m, content: "", blocks, isComplete: false } : m
        ));
      };

      const unlisten = await listen<{ token: string; done: boolean }>("llm-stream", (event) => {
        const { token, done } = event.payload;
        if (!done && token) {
          streamedText += token;
          if (!pendingFlush) {
            pendingFlush = true;
            flushTimer = setTimeout(flushStreamedText, 40);
          }
        }
      });

      // Send with the context engine's system instruction
      // Only use the first user turn (context block) + append the actual question
      // Never join all turns — that bleeds previous Q&A into the prompt
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
      });
      unlisten();
      if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
      if (pendingFlush) flushStreamedText();

      // Parse response
      const finalText = resp.success ? resp.text : (resp.error || "Unknown error");
      let parsed = resp.success ? await parseResponseAsync(finalText, existingFiles) : null;
      if (parsed && parsed.editOperations.length > 0) {
        parsed = await resolveEditOperations(parsed, projectPath);
      }
      const hasActions = parsed ? hasParsedActions(parsed) : false;
      recordResponseUsage(resp.metrics);

      // Finalize message with blocks
      const finalBlocks = parseStreamBlocks(finalText).completed;
      setMessages(prev => prev.map(m => {
        if ((m as any).streamId !== streamId) return m;
        const { streamId: _sid, ...rest } = m as any;
        return { ...rest, content: finalText, blocks: finalBlocks, isComplete: true, parsed: hasActions ? parsed : undefined, applied: false, metrics: resp.metrics };
      }));

      // Auto-extract memories from the response
      if (resp.success && parsed) {
        const changedFiles = parsed.fileChanges.map(f => f.path);
        extractMemoriesFromResponse(projectPath, currentTask, finalText, changedFiles);
      }

      // Tool Mode tip — soft hint when full context was overkill
      if (!toolModeEnabled && payload.tokenEstimate > 5000) {
        const SIMPLE_FILE_QUERY_PATTERNS = [
          /what.*line\s+\d+/i,
          /line\s+\d+/i,
          /what.*written/i,
          /where.*defined/i,
          /find .* in/i,
          /search .* file/i,
          /which file/i,
          /current file/i,
          /open file/i,
        ];
        const isSimple = SIMPLE_FILE_QUERY_PATTERNS.some(p => p.test(currentTask));
        if (isSimple) {
          setMessages(prev => [...prev, {
            role: "assistant",
            content: "💡 Tip: Tool Mode could answer simple file lookups with far fewer tokens.",
            mode: "chat",
          } as any]);
        }
      }

    } catch (err) {
      const providerName = aiProviders.find(hasUsableProvider)?.name || config.provider || "AI";
      setMessages(prev => [...prev, { role: "assistant", content: `Currently using ${providerName}. Something went wrong — please try again.` }]);
    } finally {
      setLoading(false);
    }

    // Update step
    setAgentTask((prev) => prev ? { ...prev, step: "awaiting_approval" } : null);
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

    if (runObservation.status === "failed") {
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
        const msgIdx = messages.length - 1;
        onApplyDirect(lastMsg.parsed).then(() => {
          setMessages((prev) => prev.map((m, i) => (i === msgIdx ? { ...m, applied: true } : m)));
          // If there are commands, suggest running them
          if (lastMsg.parsed?.commands?.length) {
            agentSuggestCommand(lastMsg.parsed.commands[0]);
          } else {
            // No commands — check if we should move to next subtask
            advanceSubtask();
          }
        }).catch(() => {});
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

      {/* Messages — virtualized: browser skips rendering off-screen messages */}
      <div className="chat-messages" style={{ contentVisibility: "auto", containIntrinsicSize: "auto 500px" }}>
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
            <img src="/logo-Transparent.png" alt="Punam" className="chat-welcome-logo" />
            <p><strong>Hi, I'm Punam!</strong></p>
            <p className="chat-welcome-hint">Your AI coding assistant by Amritanshu Amar</p>
          </div>
        )}

        {messages.map((msg, i) => (
          <div key={i} className={`chat-message ${msg.role}`}>
            <div className="chat-message-icon">
              {msg.role === "user" ? <User size={14} /> : <PunamAvatar />}
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
                      {!msg.parsed && !msg.blocks && <MarkdownMessage text={msg.content} />}
                      {msg.blocks && msg.blocks.length > 0 && (
                        <MessageBubble blocks={msg.blocks} isStreaming={!msg.isComplete} />
                      )}
                    </>
                  )}
                  {msg.metrics && <ResponseMetricsDisplay metrics={msg.metrics} />}
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
        ))}

        {loading && (
          <div className="chat-message assistant working">
            <div className="chat-message-icon">
              <PunamAvatar active />
            </div>
            <div className="chat-message-content loading">
              <div className="agent-working-card">
                <div className="agent-working-main">
                  <Loader2 size={16} className="spin" />
                  <div>
                    <strong>Working in {MODE_LABELS[agentMode]} mode</strong>
                    <span>{contextSummary || "Collecting project context..."}</span>
                  </div>
                </div>
                {contextFiles.length > 0 && (
                  <div className="context-chip-row">
                    {contextFiles.slice(0, 4).map((file) => (
                      <span className="context-chip" key={file}>
                        <FileText size={10} />
                        {file}
                      </span>
                    ))}
                    {contextFiles.length > 4 && (
                      <span className="context-chip muted">+{contextFiles.length - 4}</span>
                    )}
                  </div>
                )}
              </div>
            </div>
          </div>
        )}

        {/* Agent Task Card — at bottom so it's always visible */}
        {agentTask && agentTask.active && (
          <div className="agent-task-card">
            <div className="agent-task-header">
              <Zap size={14} />
              <strong>Agent Mode</strong>
              <button className="agent-bg-btn" onClick={sendToBackground} title="Continue in background — keep coding while Punam works">
                ↗ Background
              </button>
              <button className="agent-stop-btn" onClick={stopAgent} title="Stop Agent">
                ■ Stop
              </button>
            </div>
            <div className="agent-task-body">
              <div className="agent-task-info">
                <span className="agent-task-label">Task:</span>
                <span>{agentTask.subtasks.length > 1 ? agentTask.subtasks[agentTask.currentSubtask] : agentTask.task}</span>
              </div>
              {agentTask.subtasks.length > 1 && (
                <div className="agent-task-info">
                  <span className="agent-task-label">Progress:</span>
                  <span>{agentTask.currentSubtask + 1} / {agentTask.subtasks.length} subtasks</span>
                </div>
              )}
              <div className="agent-task-info">
                <span className="agent-task-label">Step:</span>
                <span>{formatAgentStep(agentTask.step)}</span>
              </div>
              <div className="agent-task-info">
                <span className="agent-task-label">Attempt:</span>
                <span>{agentTask.attempt}/{agentTask.maxAttempts}</span>
              </div>
              <div className="agent-task-info">
                <span className="agent-task-label">Auto-apply:</span>
                <button
                  className={`agent-toggle-btn ${agentTask.autoApply ? "on" : "off"}`}
                  onClick={() => setAgentTask(prev => prev ? { ...prev, autoApply: !prev.autoApply } : null)}
                  title={agentTask.autoApply ? "Auto-apply ON — edits apply without review" : "Auto-apply OFF — shows diff preview"}
                >
                  {agentTask.autoApply ? "ON (autopilot)" : "OFF (review each)"}
                </button>
              </div>
            </div>
            {agentTask.step === "awaiting_run" && agentTask.suggestedCommand && (
              <div className="agent-command-prompt">
                <span>Run <code>{agentTask.suggestedCommand}</code>?</span>
                <div className="agent-command-actions">
                  <button className="btn-primary compact" onClick={agentRunCommand}>Run</button>
                  <button className="btn-secondary compact" onClick={agentSkipCommand}>Skip</button>
                </div>
              </div>
            )}
          </div>
        )}

        <div ref={bottomRef} />
      </div>

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
        sendDisabled={loading || cooldown || (!input.trim() && attachments.length === 0)}
        isAgentMode={agentMode === "agent"}
        toolModeEnabled={toolModeEnabled}
        onToggleToolMode={() => {
          const next = !toolModeEnabled;
          setToolModeEnabled(next);
          try { localStorage.setItem("punam-tool-mode", String(next)); } catch {}
        }}
      />
    </div>
  );
}

