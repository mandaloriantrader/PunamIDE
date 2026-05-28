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
import { readFile, searchProject } from "../utils/tauri";
import type { AppConfig, FileEntry } from "../utils/tauri";
import { checkTcpPort, runTerminalCommand } from "../utils/tauri";
import type { MCPServerConfig } from "../utils/mcp";
import { buildMcpToolsPrompt, parseMcpCalls, mcpCallTool, formatMcpResult } from "../utils/mcp";
import { SYSTEM_PROMPT, parseResponse } from "../utils/prompts";
import type { ParsedResponse } from "../utils/prompts";
import { sendToMultipleModels, sendToProviderStreaming, estimateTokens } from "../utils/providers";
import { runAgentToolLoop, shouldUseToolLoop } from "../utils/agentToolLoop";
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
  getMentionedFilePaths,
  getMentionedFolderFiles,
  getUnresolvedMentions,
  getFilePathsFromText,
  resolveEditOperations,
  buildGitContext,
  KEY_CONTEXT_FILES,
  PROJECT_RULES_FILES,
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
import { detectTaskType } from "../lib/ai/taskDetection";
import { selectAdaptiveProvider } from "../lib/ai/adaptiveRouter";
import type { AdaptiveStrategy } from "../lib/ai/providerCapabilities";
import { classifyProviderError, describeHealthStatus, markProviderHealthy, setProviderHealth } from "../lib/ai/providerHealth";
import type { RunObservation } from "../services/run/verifiedRun";

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
  subtasks: string[];       // Task queue â€” list of subtasks to execute
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
    placeholder: "Describe any task â€” I'll plan and execute it autonomously...",
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
        setMessages((prev) => [...prev, { role: "assistant", content: `âœ… Chat exported to \`${filePath}\`` }]);
      }
    } catch {
      try {
        await navigator.clipboard.writeText(markdown);
        setMessages((prev) => [...prev, { role: "assistant", content: "âœ… Chat copied to clipboard (save dialog unavailable)." }]);
      } catch {
        setMessages((prev) => [...prev, { role: "assistant", content: "âš ï¸ Could not export chat. Try again." }]);
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
      return "I was created and developed by **Amritanshu Amar**. He designed me to be an intelligent, AI-powered coding assistant that helps developers write, edit, and manage code through natural language â€” all from within a sleek desktop IDE.";
    }

    if (lower.includes("what can you do") || lower.includes("what do you do") || lower.includes("how do you work")) {
      return "I'm **Punam**, your AI-powered coding assistant! I was created by **Amritanshu Amar**.\n\nHere's what I can do:\n\nâ€¢ **Edit & create files** â€” describe what you want in plain English and I'll generate the code changes\nâ€¢ **Understand your project** â€” I can see your file tree and understand the structure\nâ€¢ **Multi-language support** â€” Python, JavaScript, TypeScript, Rust, Go, Java, and many more\nâ€¢ **Run commands** â€” I can suggest terminal commands to run\nâ€¢ **Debug & fix** â€” describe a bug and I'll find and fix it\n\nJust type what you need!";
    }

    if (isExactGreeting) {
      return "Hey there! I'm **Punam**, your AI coding assistant created by **Amritanshu Amar**. I'm here to help you write, edit, and manage your code. Just tell me what you need â€” describe it in plain English and I'll take care of the rest!";
    }

    return "Hi! I'm **Punam** â€” an AI-powered coding assistant built right into this IDE. I was created and developed by **Amritanshu Amar**.\n\nI help you write, modify, and debug code using natural language. Just describe what you want â€” like \"add a login page\" or \"fix the error in main.py\" â€” and I'll generate the exact code changes, show you a preview, and apply them when you're ready.\n\nI support multiple AI providers (Google Gemini, OpenAI, OpenRouter, Groq, Mistral AI, Ollama) and work with any programming language. Think of me as your personal coding partner!";
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

  const buildProjectContext = async (userPrompt = "") => {
    const existingFiles = collectExistingFiles();
    const contextFiles = new Map<string, string>();

    // Skip file context for casual/greeting messages â€” saves tokens
    const CASUAL_PATTERN = /^(hi|hello|hey|thanks|thank you|ok|okay|sure|yes|no|lol|haha|good|great|nice|cool|bye|gm|gn)[\s!?.]*$/i;
    if (CASUAL_PATTERN.test(userPrompt.trim())) {
      setContextFiles([]);
      setContextSummary("");
      return "";
    }

    // --- @codebase mention: use TF-IDF search if indexed, else load files ---
    const hasCodebaseMention = /@codebase\b/i.test(userPrompt);
    if (hasCodebaseMention) {
      if (isIndexed()) {
        // Extract the query part after @codebase
        const codebaseQuery = userPrompt.replace(/@codebase\b/i, "").trim();
        const hits = searchCodebase(codebaseQuery || userPrompt, 8);
        for (const hit of hits) {
          if (contextFiles.has(hit.path)) continue;
          const content = await readFile(getProjectFilePath(projectPath, hit.path)).catch(() => "");
          if (content) contextFiles.set(hit.path, content);
        }
      } else {
        // Fallback: load first 40 files
        for (const filePath of [...existingFiles].slice(0, 40)) {
          if (contextFiles.has(filePath)) continue;
          const content = await readFile(getProjectFilePath(projectPath, filePath)).catch(() => "");
          if (content) contextFiles.set(filePath, content);
        }
      }
    }

    // Load explicitly selected project files (multi-file refactoring)
    for (const filePath of selectedProjectFiles) {
      if (contextFiles.has(filePath)) continue;
      const content = await readFile(getProjectFilePath(projectPath, filePath)).catch(() => "");
      if (content) contextFiles.set(filePath, content);
    }

    // Smart tab inclusion: only include active file + files mentioned in the message
    // This avoids sending all open tabs (wasteful for simple questions)
    const CODE_QUERY_PATTERN = /line|function|class|error|bug|fix|explain|refactor|what|how|why|where|find|search|read|show|import|variable|method|def |const |let |var /i;
    const isCodeQuery = CODE_QUERY_PATTERN.test(userPrompt);

    for (const tab of openTabs) {
      const relPath = getRelativePath(projectPath, tab.path);
      const tabName = tab.path.split(/[\\/]/).pop()?.toLowerCase() || "";

      // Always include the active file
      const isActive = activeFilePath && tab.path === activeFilePath;
      // Include if mentioned by name in the message
      const isMentioned = userPrompt.toLowerCase().includes(tabName);
      // Include all tabs only for code queries (refactor, explain, etc.)
      const includeAll = isCodeQuery;

      if (isActive || isMentioned || includeAll) {
        contextFiles.set(relPath, tab.content);
      }
    }

    for (const keyFile of KEY_CONTEXT_FILES) {
      if (!existingFiles.has(keyFile) || contextFiles.has(keyFile)) continue;
      const content = await readFile(getProjectFilePath(projectPath, keyFile)).catch(() => "");
      if (content) contextFiles.set(keyFile, content);
    }

    for (const mentionedPath of getMentionedFilePaths(userPrompt, existingFiles)) {
      if (contextFiles.has(mentionedPath)) continue;
      const content = await readFile(getProjectFilePath(projectPath, mentionedPath)).catch(() => "");
      if (content) contextFiles.set(mentionedPath, content);
    }

    // Load files from mentioned folders (@folder support)
    for (const folderFile of getMentionedFolderFiles(userPrompt, existingFiles)) {
      if (contextFiles.has(folderFile)) continue;
      const content = await readFile(getProjectFilePath(projectPath, folderFile)).catch(() => "");
      if (content) contextFiles.set(folderFile, content);
    }

    // Semantic search: if user asks "where is X used", "find X", "which file has X"
    const searchMatch = userPrompt.match(/(?:where|find|search|which file|who uses|grep|look for)\s+["`']?([^"`'\n]{3,40})["`']?/i);
    if (searchMatch && projectPath) {
      const searchQuery = searchMatch[1].trim();
      try {
        const results = await searchProject(searchQuery);
        if (results.length > 0) {
          // Load top 3 files from search results
          for (const result of results.slice(0, 3)) {
            if (!contextFiles.has(result.path)) {
              const content = await readFile(getProjectFilePath(projectPath, result.path)).catch(() => "");
              if (content) contextFiles.set(result.path, content);
            }
          }
        }
      } catch { /* search failed, continue without */ }
    }

    // Auto-load files mentioned in terminal/proactive errors (critical for edit precision).
    const errorContextText = [terminalOutput || "", proactiveError?.output || ""]
      .filter(Boolean)
      .join("\n");
    for (const errorFile of getFilePathsFromText(errorContextText, existingFiles)) {
      if (!contextFiles.has(errorFile)) {
        const content = await readFile(getProjectFilePath(projectPath, errorFile)).catch(() => "");
        if (content) contextFiles.set(errorFile, content);
      }
    }

    if (activeFilePath) {
      const relativePath = getRelativePath(projectPath, activeFilePath);
      if (!contextFiles.has(relativePath)) {
        const content = await readFile(activeFilePath).catch(() => "");
        if (content) contextFiles.set(relativePath, content);
      }
    }

    let totalChars = 0;
    const sections: string[] = [];
    const attachedNames: string[] = [];

    // Inline limits to avoid Vite caching issues with imported constants
    const FILE_CHAR_LIMIT = 20000;
    const TOTAL_CHAR_LIMIT = 80000;

    for (const [path, content] of contextFiles) {
      if (totalChars >= TOTAL_CHAR_LIMIT) break;
      const remaining = TOTAL_CHAR_LIMIT - totalChars;
      const maxForFile = Math.min(FILE_CHAR_LIMIT, remaining);
      const clipped = content.length <= maxForFile ? content : content.slice(0, maxForFile) + "\n\n/* ...truncated... */";
      // Add line numbers so the model can reference specific lines accurately
      const numbered = clipped
        .split("\n")
        .map((line, i) => `${String(i + 1).padStart(4, " ")} | ${line}`)
        .join("\n");
      sections.push(`## ${path}\n\`\`\`\n${numbered}\n\`\`\``);
      attachedNames.push(path);
      totalChars += numbered.length;
    }

    setContextFiles(attachedNames);
    setContextSummary(
      attachedNames.length > 0
        ? `Context attached: ${attachedNames.slice(0, 4).join(", ")}${attachedNames.length > 4 ? ` +${attachedNames.length - 4} more` : ""}`
        : "Context attached: file tree only"
    );

    // Detect frameworks from attached context files
    const packageJson = contextFiles.get("package.json") || null;
    const cargoToml = contextFiles.get("Cargo.toml") || contextFiles.get("src-tauri/Cargo.toml") || null;
    const frameworks = detectFrameworks(packageJson, cargoToml);
    const frameworkSection = frameworks.length > 0
      ? `\n\n# Detected Frameworks\n${frameworks.join(", ")}`
      : "";

    // Load project rules (punam.rules.md, .punam/rules.md, AGENTS.md)
    let projectRulesSection = "";
    for (const rulesFile of PROJECT_RULES_FILES) {
      const rulesContent = await readFile(getProjectFilePath(projectPath, rulesFile)).catch(() => "");
      if (rulesContent) {
        projectRulesSection = `\n\n# Project Rules (from ${rulesFile})\nFollow these project-specific instructions:\n${rulesContent.slice(0, 3000)}`;
        break; // Use first found rules file
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

  // â”€â”€â”€ Auto-Continue: Detect truncated responses and continue automatically â”€â”€â”€
  const MAX_AUTO_CONTINUES = 4; // Safety limit to prevent infinite loops
  const autoContinueCountRef = useRef(0);
  const agentProposFixRunning = useRef(false);

  /** Detect if an AI response was truncated mid-output (unclosed FILE/EDIT blocks) */
  const isResponseTruncated = (text: string): boolean => {
    // Count opens vs closes for FILE blocks
    const fileOpens = (text.match(/===FILE:\s*.+?===/g) || []).length;
    const fileCloses = (text.match(/===END_FILE===/g) || []).length;
    if (fileOpens > fileCloses) return true;

    // Count opens vs closes for EDIT blocks
    const editOpens = (text.match(/===EDIT:\s*.+?===/g) || []).length;
    const editCloses = (text.match(/===END_EDIT===/g) || []).length;
    if (editOpens > editCloses) return true;

    // Check for unclosed code fences (``` without matching close)
    const fences = (text.match(/```/g) || []).length;
    if (fences % 2 !== 0) return true;

    return false;
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
      const fileTree = buildFileContext(files);
      const attachedContext = await buildProjectContext(userPrompt);

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
              (r) => `${r.path}:${r.line} â€” ${r.preview.slice(0, 100)}`
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
          (p) => `[${p.severity}] ${p.path}:${p.line} â€” ${p.message}`
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
      const historySection = recentHistory ? `\n\n# Conversation History (recent â€” for continuity only, current project context takes priority)\n${recentHistory}` : "";

      // Detect @file mentions that don't resolve to existing files (B010)
      const unresolvedFiles = getUnresolvedMentions(userPrompt, collectExistingFiles());
      const unresolvedSection = unresolvedFiles.length > 0
        ? `\n\n# âš ï¸ Non-Existent File References\nThe user mentioned the following file(s) that do NOT exist in the project:\n${unresolvedFiles.map((f) => `- ${f}`).join("\n")}\nIMPORTANT: Before proposing to create these files, explicitly tell the user that the file does not exist and ask if they want you to create it. Do NOT silently create files that the user may have assumed already existed.`
        : "";

      const prompt = `# Agent Mode\n${modeInstruction}${contextInstruction}${mcpSection}${workspaceSection}\n\n# Current Project Structure\n\`\`\`\n${fileTree}\`\`\`\n\n# Attached File Context\n${attachedContext || "No file contents attached."}\n\n# User Request\n${userPrompt}${editorStateSection}${selectionSection}${searchSection}${problemsSection}${terminalSection}${unresolvedSection}${historySection}`;

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
          setMessages((prev) => [...prev, { role: "assistant", content: `${firstNotice}\n\nÃ¢â€“Â`, mode, streamId } as ChatMessage & { streamId: string }]);

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
                ? { ...m, content: `${[firstNotice, ...fallbackNotices].join("\n")}\n\nUsing ${candidate.provider.name} / ${candidate.model}...\n\nÃ¢â€“Â` }
                : m
            ));

            const { listen } = await import("@tauri-apps/api/event");
            let streamedText = "";
            let pendingFlush = false;
            let flushTimer: ReturnType<typeof setTimeout> | null = null;

            const flushStreamedText = () => {
              pendingFlush = false;
              flushTimer = null;
              const displayText = getStreamingTextBeforeActionBlocks(streamedText);
              setMessages((prev) => prev.map((m) =>
                (m as any).streamId === streamId
                  ? { ...m, content: `${[firstNotice, ...fallbackNotices].join("\n")}\n\n${displayText}Ã¢â€“Â` }
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

          setMessages((prev) => prev.map((m) => {
            if ((m as any).streamId !== streamId) return m;
            const { streamId: _sid, ...rest } = m as any;
            return {
              ...rest,
              content: responseText,
              parsed: hasActions ? parsed : undefined,
              applied: false,
              metrics: finalResp?.metrics,
            };
          }));
          return;
        }

        // Use new multi-provider system
        if (enabledModels.length === 1) {
          // Single model â€” use streaming for real-time token display
          const { providerId, model: modelId } = enabledModels[0];
          const provider = aiProviders.find((p) => p.id === providerId);

          if (!provider) {
            setMessages((prev) => [...prev, { role: "assistant", content: "Provider not found." }]);
          } else {
            // Add placeholder message with unique stream ID for tracking
            const streamId = `stream-${Date.now()}`;
            setMessages((prev) => [...prev, { role: "assistant", content: "â–", mode, streamId } as ChatMessage & { streamId: string }]);

            // Listen for streaming tokens â€” BATCHED for performance
            const { listen } = await import("@tauri-apps/api/event");
            let streamedText = "";
            let pendingFlush = false;
            let flushTimer: ReturnType<typeof setTimeout> | null = null;

            const flushStreamedText = () => {
              pendingFlush = false;
              flushTimer = null;
              // Show only the explanation part during streaming (hide raw FILE blocks)
              const displayText = getStreamingTextBeforeActionBlocks(streamedText);
              setMessages((prev) => prev.map((m) =>
                (m as any).streamId === streamId ? { ...m, content: displayText + "â–" } : m
              ));
            };

            const unlisten = await listen<{ token: string; done: boolean }>("llm-stream", (event) => {
              const { token, done } = event.payload;
              if (!done && token) {
                streamedText += token;
                // Batch: only flush every 40ms to avoid excessive re-renders
                if (!pendingFlush) {
                  pendingFlush = true;
                  flushTimer = setTimeout(flushStreamedText, 40);
                }
              }
            });

            // Send the streaming request
            const imagePayload = currentImages.length > 0
              ? currentImages.map((img) => ({ base64: img.base64, mimeType: img.mimeType }))
              : undefined;
            const resp = await sendToProviderStreaming(provider, modelId, { systemPrompt: SYSTEM_PROMPT, userPrompt: prompt, images: imagePayload });
            unlisten();
            // Flush any remaining buffered tokens
            if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
            if (pendingFlush) flushStreamedText();

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
                    mcpResultParts.push(`âš ï¸ MCP server "${call.serverId}" not found or disabled.`);
                    continue;
                  }
                  setMessages(prev => [...prev, {
                    role: "assistant",
                    content: `ðŸ”§ Calling MCP tool **${call.serverId}.${call.toolName}**â€¦`,
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

            setMessages((prev) => prev.map((m) => {
              if ((m as any).streamId !== streamId) return m;
              const { streamId: _sid, ...rest } = m as any;
              return {
                ...rest,
                content: effectiveFinalText,
                parsed: hasActions ? parsed : undefined,
                applied: false,
                metrics: resp.metrics,
              };
            }));
            recordResponseUsage(resp.metrics);

            // â”€â”€â”€ Auto-Continue: If response was truncated, automatically continue â”€â”€â”€
            if (resp.success && isResponseTruncated(effectiveFinalText) && autoContinueCountRef.current < MAX_AUTO_CONTINUES) {
              autoContinueCountRef.current += 1;
              // Small delay to let the UI update, then auto-continue
              setTimeout(() => {
                requestPunam("Continue from where you stopped. Complete the remaining code. Do NOT repeat what you already wrote â€” pick up exactly where the output was cut off.", mode);
              }, 500);
              return;
            }
            // Reset auto-continue counter on successful complete response
            autoContinueCountRef.current = 0;
          }
        } else {
          // Multiple models â€” send in parallel (no streaming for multi)
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
        // Legacy single-provider system â€” now with streaming
        // Guard: if no API key configured, don't attempt streaming (would crash backend)
        if (!config.api_key && config.provider !== "ollama") {
          setMessages((prev) => [...prev, { role: "assistant", content: "No API key configured. Set one up in Settings to use AI features." }]);
          setLoading(false);
          setCooldown(true);
          setTimeout(() => setCooldown(false), 3000);
          return;
        }
        const legacyProviderConfig: import("../utils/providers").AIProviderConfig = {
          id: "legacy",
          type: config.provider === "gemini" ? "gemini" : "openai-compatible",
          name: config.provider === "gemini" ? "Google Gemini" : config.provider === "groq" ? "Groq" : config.provider === "openai" ? "OpenAI" : config.provider,
          apiKey: config.api_key || "",
          baseUrl: config.provider === "groq" ? "https://api.groq.com/openai/v1"
            : config.provider === "openai" ? "https://api.openai.com/v1"
            : undefined,
          models: [{ id: config.model, name: config.model, enabled: true }],
        };

        // Add placeholder message with streaming cursor
        const streamId = `stream-${Date.now()}`;
        setMessages((prev) => [...prev, { role: "assistant", content: "\u258D", mode, streamId } as ChatMessage & { streamId: string }]);

        // Listen for streaming tokens â€” BATCHED for performance
        const { listen } = await import("@tauri-apps/api/event");
        let streamedText = "";
        let pendingFlush = false;
        let flushTimer: ReturnType<typeof setTimeout> | null = null;

        const flushStreamedText = () => {
          pendingFlush = false;
          flushTimer = null;
          const displayText = getStreamingTextBeforeActionBlocks(streamedText);
          setMessages((prev) => prev.map((m) =>
            (m as any).streamId === streamId ? { ...m, content: displayText + "\u258D" } : m
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

        const resp = await sendToProviderStreaming(legacyProviderConfig, config.model, {
          systemPrompt: SYSTEM_PROMPT,
          userPrompt: prompt,
        });
        unlisten();
        if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
        if (pendingFlush) flushStreamedText();

        if (!resp.success) {
          const providerName = legacyProviderConfig.name;
          setMessages((prev) => prev.map((m) =>
            (m as any).streamId === streamId
              ? { ...m, content: `Currently using ${providerName} / ${config.model}. The service is temporarily unavailable \u2014 please try again in a moment.`, streamId: undefined }
              : m
          ));
          return;
        }

        let parsed = parseResponse(resp.text, collectExistingFiles());
        if (parsed.editOperations.length > 0) {
          parsed = await resolveEditOperations(parsed, projectPath);
        }
        const hasActions = hasParsedActions(parsed);
        recordResponseUsage(resp.metrics);

        setMessages((prev) => prev.map((m) => {
          if ((m as any).streamId !== streamId) return m;
          const { streamId: _sid, ...rest } = m as any;
          return {
            ...rest,
            content: resp.text,
            parsed: hasActions ? parsed : undefined,
            applied: false,
            metrics: resp.metrics,
          };
        }));

        // â”€â”€â”€ Auto-Continue: If response was truncated, automatically continue â”€â”€â”€
        if (isResponseTruncated(resp.text) && autoContinueCountRef.current < MAX_AUTO_CONTINUES) {
          autoContinueCountRef.current += 1;
          setTimeout(() => {
            requestPunam("Continue from where you stopped. Complete the remaining code. Do NOT repeat what you already wrote â€” pick up exactly where the output was cut off.", mode);
          }, 500);
          return;
        }
        autoContinueCountRef.current = 0;
      }
    } catch (err) {
      const providerName = config.provider === "gemini" ? "Google Gemini" : config.provider === "groq" ? "Groq" : config.provider === "openai" ? "OpenAI" : config.provider;
      setMessages((prev) => [...prev, { role: "assistant", content: `Currently using ${providerName} / ${config.model}. Something went wrong â€” please try again.` }]);
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

    const mode = agentMode;

    // --- Handle @web mention: do a quick web fetch before sending ---
    const webMatch = text.match(/@web\s+(.+?)(?:\n|$)/i);
    if (webMatch) {
      const query = webMatch[1].trim().slice(0, 150);
      setMessages((prev) => [...prev, { role: "assistant", content: `ðŸŒ Searching the web for: _${query}_...` }]);
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
            setMessages((prev) => [...prev.slice(0, -1), { role: "assistant", content: `ðŸŒ Web: ${abstract.slice(0, 200)}${abstract.length > 200 ? "â€¦" : ""}` }]);
          } else {
            setWebSearchResults(`Query: ${query}\n\nNo direct answer found. The AI will answer from training data.`);
            setMessages((prev) => [...prev.slice(0, -1), { role: "assistant", content: `ðŸŒ No instant answer found for "${query}". Proceeding with AI knowledge.` }]);
          }
        }
      } catch {
        setWebSearchResults("");
        setMessages((prev) => [...prev.slice(0, -1), { role: "assistant", content: `ðŸŒ Web search unavailable. Proceeding with AI knowledge.` }]);
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
      const warningMsg = `âš ï¸ Note: ${unresolvedFiles.map((f) => `\`${f}\``).join(", ")} ${unresolvedFiles.length === 1 ? "does" : "do"} not exist in the project. If you want me to create ${unresolvedFiles.length === 1 ? "it" : "them"}, I'll confirm before doing so.`;
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
      await new Promise(resolve => setTimeout(resolve, 300)); // wait for state to settle
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
      await new Promise(resolve => setTimeout(resolve, 300)); // wait for state to settle
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
      content: "âœ“ Task sent to background. You can keep coding â€” check the status bar for progress.",
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
      content: "âœ“ Task running in background. Keep coding â€” check the status bar for progress.",
    }]);
  };

  // Agent fix proposal implementation.
//
// Replace the ENTIRE function body with the version below.
// The function signature stays the same.
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

  const agentProposeFix = async () => {
    if (!agentTask || !agentTask.active) return;
    if (agentProposFixRunning.current) return;
    agentProposFixRunning.current = true;

    try {
      setAgentTask((prev) => prev ? { ...prev, step: "proposing_fix" } : null);

    // â”€â”€ Shared setup (same for both paths) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    const existingFiles = collectExistingFiles();
    const errorContextText = [terminalOutput || "", proactiveError?.output || ""]
      .filter(Boolean)
      .join("\n");

    // Load persistent memories
    const memories = loadAgentMemories(projectPath);
    const compressedMemory = compressMemories(memories);
    const chatSummary = summarizeOldMessages(messages);
    const fullMemory = [compressedMemory, chatSummary].filter(Boolean).join("\n\n");

    // Previous attempt history
    const historyContext = agentTask.history.length > 0
      ? `Previous attempts (DO NOT repeat):\n${agentTask.history.map((h, i) => `${i + 1}. ${h}`).join("\n")}`
      : "";

    const currentTask = agentTask.subtasks.length > 1
      ? agentTask.subtasks[agentTask.currentSubtask]
      : agentTask.task;

    // â”€â”€ Pick path: tool loop OR full-context fallback â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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

    const useToolLoop = shouldUseToolLoop(currentTask);

    // â”€â”€ Path A: Tool-calling loop â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    if (useToolLoop) {
      const payload = assemblePersistentPayload({
        globalGoal: agentTask.task,
        currentSubtask: `${currentTask} (attempt ${agentTask.attempt}/${agentTask.maxAttempts})${historyContext ? "\n" + historyContext : ""}`,
        fullHistory: messages,
        activeFileSnippets: [], // tool loop reads on demand â€” no snippets upfront
        latestErrors: errorContextText.slice(-2000),
        projectMemory: fullMemory,
        projectPath,
        toolLoopMode: true, // â† key flag
      });

      setLoading(true);

      // Add streaming placeholder
      const streamId = `stream-${Date.now()}`;
      setMessages(prev => [...prev, { role: "assistant", content: "â–", mode: "chat", streamId } as any]);

      // Track which tools fired (for UI feedback)
      const firedTools: string[] = [];

      await runAgentToolLoop({
        provider,
        modelId,
        systemPrompt: payload.systemInstruction,
        task: currentTask,
        projectPath,
        activeFilePath,
        maxRounds: 10,

        onToolCall: (toolName) => {
          firedTools.push(toolName);
          // Show a subtle status while tools are running
          const statusText = `ðŸ”§ Using tool: \`${toolName}\`â€¦`;
          setMessages(prev => prev.map(m =>
            (m as any).streamId === streamId
              ? { ...m, content: statusText + "\n\nâ–" }
              : m
          ));
        },

        onToken: (token) => {
          // For JSON-fallback providers, update the message as text arrives
          setMessages(prev => prev.map(m =>
            (m as any).streamId === streamId
              ? { ...m, content: token + "â–" }
              : m
          ));
        },

        onDone: async (finalText) => {
          // If tool loop exhausted rounds without a real answer, fall back to full-context
          if (finalText === "Max tool rounds reached." || !finalText.trim()) {
            console.warn("[AGENT TOOL LOOP] No useful answer from tool loop, falling back to full-context");
            setMessages(prev => prev.filter(m => (m as any).streamId !== streamId));
            setLoading(false);
            _agentProposeFixFullContext(
              currentTask, existingFiles, errorContextText, fullMemory, historyContext,
              provider, modelId
            );
            return;
          }

          // Parse the final answer for any FILE/CMD blocks (full-context style)
          let parsed = await parseResponseAsync(finalText, existingFiles).catch(() => null);
          if (parsed && parsed.editOperations.length > 0) {
            parsed = await resolveEditOperations(parsed, projectPath);
          }
          const hasActions = parsed ? hasParsedActions(parsed) : false;

          setMessages(prev => prev.map(m => {
            if ((m as any).streamId !== streamId) return m;
            const { streamId: _sid, ...rest } = m as any;
            return {
              ...rest,
              content: finalText,
              parsed: hasActions ? parsed : undefined,
              applied: false,
            };
          }));

          if (parsed) {
            const changedFiles = parsed.fileChanges.map(f => f.path);
            extractMemoriesFromResponse(projectPath, currentTask, finalText, changedFiles);
          }

          setLoading(false);
          setAgentTask((prev) => prev ? { ...prev, step: "awaiting_approval" } : null);
        },

        onError: (err) => {
          console.warn("[AGENT TOOL LOOP] Tool loop failed, will retry with full-context fallback:", err);
          // On tool loop error: fall through to full-context fallback below
          setMessages(prev => prev.filter(m => (m as any).streamId !== streamId));
          setLoading(false);
          // Trigger full-context retry by re-running without tool loop
          _agentProposeFixFullContext(
            currentTask, existingFiles, errorContextText, fullMemory, historyContext,
            provider, modelId
          );
        },
      });

      return; // Path A done
    }

    // â”€â”€ Path B: Full-context fallback (original behaviour, unchanged) â”€â”€â”€â”€â”€â”€â”€â”€
    await _agentProposeFixFullContext(
      currentTask, existingFiles, errorContextText, fullMemory, historyContext,
      provider, modelId
    );
    } finally {
      agentProposFixRunning.current = false;
    }
  };

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// â”€â”€ CHANGE 3: Add _agentProposeFixFullContext helper â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
//
// Add this NEW function IMMEDIATELY AFTER the agentProposeFix function above.
// It contains the original agentProposeFix body, unchanged.
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

  // Full-context fallback â€” original logic extracted into its own function
  // so it can be called from agentProposeFix (Path B) and as an error fallback.
  const _agentProposeFixFullContext = async (
    currentTask: string,
    existingFiles: ReturnType<typeof collectExistingFiles>,
    errorContextText: string,
    fullMemory: string,
    historyContext: string,
    provider: import("../utils/providers").AIProviderConfig,
    modelId: string
  ) => {
    const errorFiles = getFilePathsFromText(errorContextText, existingFiles);

    // Load relevant file snippets (error-referenced files + active file)
    const snippets: string[] = [];
    const AGENT_FILE_LIMIT = 20000;
    for (const filePath of errorFiles.slice(0, 3)) {
      try {
        const content = await readFile(getProjectFilePath(projectPath, filePath));
        if (content) {
          const clipped = content.slice(0, AGENT_FILE_LIMIT);
          const numbered = clipped.split("\n").map((line, i) => `${String(i + 1).padStart(4, " ")} | ${line}`).join("\n");
          snippets.push(`## ${filePath}\n\`\`\`\n${numbered}\n\`\`\``);
        }
      } catch { /* skip */ }
    }
    if (activeFilePath) {
      const relPath = getRelativePath(projectPath, activeFilePath);
      if (!errorFiles.includes(relPath)) {
        const content = await readFile(activeFilePath).catch(() => "");
        if (content) {
          const clipped = content.slice(0, AGENT_FILE_LIMIT);
          const numbered = clipped.split("\n").map((line, i) => `${String(i + 1).padStart(4, " ")} | ${line}`).join("\n");
          snippets.push(`## ${relPath}\n\`\`\`\n${numbered}\n\`\`\``);
        }
      }
    }

    const payload = assemblePersistentPayload({
      globalGoal: agentTask!.task,
      currentSubtask: `${currentTask} (attempt ${agentTask!.attempt}/${agentTask!.maxAttempts})${historyContext ? "\n" + historyContext : ""}`,
      fullHistory: messages,
      activeFileSnippets: snippets,
      latestErrors: errorContextText.slice(-2000),
      projectMemory: fullMemory,
      projectPath,
      toolLoopMode: false, // full-context path
    });

    setLoading(true);
    try {
      const streamId = `stream-${Date.now()}`;
      setMessages(prev => [...prev, { role: "assistant", content: "â–", mode: "chat", streamId } as any]);

      const { listen } = await import("@tauri-apps/api/event");
      let streamedText = "";
      let pendingFlush = false;
      let flushTimer: ReturnType<typeof setTimeout> | null = null;

      const flushStreamedText = () => {
        pendingFlush = false;
        flushTimer = null;
        const displayText = getStreamingTextBeforeActionBlocks(streamedText);
        setMessages(prev => prev.map(m =>
          (m as any).streamId === streamId ? { ...m, content: displayText + "â–" } : m
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

      // Only take the first user turn â€” the context block
      const contextBlock = payload.contents
        .find(c => c.role === "user")
        ?.parts[0].text ?? "";

      const finalUserPrompt = `${contextBlock}\n\n# USER QUESTION:\n${currentTask}`;

      const resp = await sendToProviderStreaming(provider, modelId, {
        systemPrompt: payload.systemInstruction,
        userPrompt: finalUserPrompt,
      });
      unlisten();
      if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
      if (pendingFlush) flushStreamedText();

      const finalText = resp.success ? resp.text : (resp.error || "Unknown error");
      let parsed = resp.success ? await parseResponseAsync(finalText, existingFiles) : null;
      if (parsed && parsed.editOperations.length > 0) {
        parsed = await resolveEditOperations(parsed, projectPath);
      }
      const hasActions = parsed ? hasParsedActions(parsed) : false;
      recordResponseUsage(resp.metrics);

      setMessages(prev => prev.map(m => {
        if ((m as any).streamId !== streamId) return m;
        const { streamId: _sid, ...rest } = m as any;
        return { ...rest, content: finalText, parsed: hasActions ? parsed : undefined, applied: false, metrics: resp.metrics };
      }));

      if (resp.success && parsed) {
        const changedFiles = parsed.fileChanges.map(f => f.path);
        extractMemoriesFromResponse(projectPath, currentTask, finalText, changedFiles);
      }

    } catch (err) {
      const providerName = aiProviders.find(hasUsableProvider)?.name || "AI";
      setMessages(prev => [...prev, { role: "assistant", content: `Currently using ${providerName}. Something went wrong â€” please try again.` }]);
    } finally {
      setLoading(false);
    }

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
        content: "âœ“ **Command passed.** Checking for next stepsâ€¦",
      }]);
      // Advance to next subtask after a brief pause
      setTimeout(() => advanceSubtask(), 800);
    } else if (hasFailed) {
      // Get the last ~2000 chars of terminal output as error context
      const errorOutput = output.slice(-2000);

      setMessages((msgs) => [...msgs, {
        role: "assistant",
        content: `âœ• Command failed. Analyzing errors...`,
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
            content: `âš ï¸ **Max attempts reached (${prev.maxAttempts}).** Reverting changes to restore your code to its previous state.`,
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
          content: `âœ… **All ${prev.subtasks.length} task${prev.subtasks.length > 1 ? "s" : ""} completed.**`,
        }]);
        return { ...prev, step: "completed", active: false };
      }
      // Move to next subtask
      setMessages((msgs) => [...msgs, {
        role: "assistant",
        content: `âž¡ï¸ Moving to subtask ${nextIdx + 1}/${prev.subtasks.length}: **${prev.subtasks[nextIdx]}**`,
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

  // Detect if the last AI response has commands and agent is active â†’ suggest running
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
            // No commands â€” check if we should move to next subtask
            advanceSubtask();
          }
        }).catch(() => {});
      } else if (!lastMsg.applied && !agentTask?.autoApply) {
        // Manual mode â€” wait for user to click Apply
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

      {/* Messages */}
      <div className="chat-messages">
        {/* Proactive Error Detection â€” sticky at top so it doesn't scroll away (B008 fix) */}
        {proactiveError && (
          <div className="proactive-error-card" style={{ position: "sticky", top: 0, zIndex: 10 }}>
            <div className="proactive-error-header">
              <span>âš ï¸ Command failed: <code>{proactiveError.command}</code></span>
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
                      inlineFileContext += `\n\n## Content of ${filePath} (DO NOT guess â€” use this exactly):\n\`\`\`\n${content.slice(0, 8000)}\n\`\`\``;
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
                            // In agent mode with autoApply, don't show buttons â€” they'll be auto-applied
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
                      {!msg.parsed && <MarkdownMessage text={msg.content} />}
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

        {/* Agent Task Card â€” at bottom so it's always visible */}
        {agentTask && agentTask.active && (
          <div className="agent-task-card">
            <div className="agent-task-header">
              <Zap size={14} />
              <strong>Agent Mode</strong>
              <button className="agent-bg-btn" onClick={sendToBackground} title="Continue in background â€” keep coding while Punam works">
                â†— Background
              </button>
              <button className="agent-stop-btn" onClick={stopAgent} title="Stop Agent">
                â–  Stop
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
                  title={agentTask.autoApply ? "Auto-apply ON â€” edits apply without review" : "Auto-apply OFF â€” shows diff preview"}
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
        openTabs={openTabs}
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
          setMessages((prev) => [...prev, { role: "assistant", content: "â†©ï¸ Last AI edit reverted." }]);
        } : undefined}
        hasAppliedMessages={checkpointCount}
        sendDisabled={loading || cooldown || (!input.trim() && attachments.length === 0)}
        isAgentMode={agentMode === "agent"}
      />
    </div>
  );
}



