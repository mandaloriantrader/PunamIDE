/**
 * Context Engine — Punam's memory architecture.
 *
 * Final Prompt Formula:
 *   System Instruction
 *   + Global Goal
 *   + Compressed Project Memory
 *   + Current Subtask
 *   + Relevant Snippets from Rust   ← only injected on full-context fallback
 *   + Latest Errors
 *   + Last 3-4 Messages Only
 *
 * Rules:
 *   - SLIDING_WINDOW_TURNS = 4 (only last 4 messages go to LLM)
 *   - Never send full chat history
 *   - Never send full files (only relevant snippets) — full-context fallback only
 *   - Tool-loop path: NO snippets injected upfront; agent reads what it needs
 *   - Persistent memory survives across sessions (localStorage for now, SQLite later)
 */

import type { ChatMessage } from "../types";

// ── Constants ─────────────────────────────────────────────────────────────────

const SLIDING_WINDOW_TURNS = 8;
const MAX_SNIPPET_CHARS = 60000;
const MAX_MEMORY_ENTRIES = 20;
const MEMORY_STORAGE_KEY = "punam-agent-memory";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface AgentMemoryEntry {
  id: string;
  projectId: string;
  type: "decision" | "preference" | "fact" | "error_fix" | "architecture";
  title: string;
  content: string;
  filePaths: string[];
  importance: number; // 1-10
  createdAt: string;
  updatedAt: string;
}

export interface ContextPayload {
  systemInstruction: string;
  contents: Array<{ role: "user" | "model"; parts: Array<{ text: string }> }>;
  tokenEstimate: number;
}

export interface ContextInputs {
  globalGoal: string;
  currentSubtask: string;
  fullHistory: ChatMessage[];
  activeFileSnippets: string[];
  latestErrors: string;
  projectMemory: string;
  projectPath: string;
  /** NEW: when true, skip injecting file snippets (tool loop will read on demand) */
  toolLoopMode?: boolean;
  projectFiles?: Array<{ name: string; path: string; is_dir: boolean; children?: any[] }>;
}

// ── Core: Assemble Persistent Payload ─────────────────────────────────────────

/**
 * Build the final prompt payload using the memory formula.
 * This is the ONLY function that should be used to build prompts for the agent loop.
 *
 * When toolLoopMode=true:
 *   - File snippets are NOT injected (agent reads files via tools on demand)
 *   - Only system instruction + memory + error summary are included
 *   - This saves 80-90% of tokens on most tasks
 *
 * When toolLoopMode=false (default, full-context fallback):
 *   - Behaviour is unchanged from before
 */
export function assemblePersistentPayload(inputs: ContextInputs): ContextPayload {
  const {
    globalGoal,
    currentSubtask,
    fullHistory,
    activeFileSnippets,
    latestErrors,
    projectMemory,
    toolLoopMode = false,
  } = inputs;

  // 1. System instruction with global goal + rules
  const systemInstruction = buildSystemInstruction(
    globalGoal,
    currentSubtask,
    projectMemory,
    toolLoopMode,
    inputs.projectFiles
  );

  // 2. Context block — skip for tool-loop path
  const contextBlock = toolLoopMode
    ? buildErrorOnlyBlock(latestErrors) // errors only, no file content
    : buildContextBlock(activeFileSnippets, latestErrors);

  // 3. No chat history in agent prompts (causes confusion)
  const recentMessages: typeof fullHistory = [];

  // 4. Assemble contents array
  const contents: ContextPayload["contents"] = [];

  if (contextBlock.trim()) {
    contents.push({
      role: "user",
      parts: [{ text: contextBlock }],
    });
    contents.push({
      role: "model",
      parts: [{ text: "Understood. I am ready to help." }],
    });
  }

  for (const msg of recentMessages) {
    const isUser = msg.role === "user";
    const text = isUser ? msg.content : msg.content.slice(0, 3000);
    contents.push({
      role: isUser ? "user" : "model",
      parts: [{ text }],
    });
  }

  // Ensure last turn is always a user turn
  if (contents.length === 0 || contents[contents.length - 1].role !== "user") {
    contents.push({
      role: "user",
      parts: [{ text: currentSubtask || globalGoal }],
    });
  }

  const allText = systemInstruction + contents.map((c) => c.parts[0].text).join("");
  const tokenEstimate = Math.ceil(allText.length / 4);

  return { systemInstruction, contents, tokenEstimate };
}

// ── System Instruction Builder ────────────────────────────────────────────────

function buildSystemInstruction(
  globalGoal: string,
  currentSubtask: string,
  projectMemory: string,
  toolLoopMode: boolean,
  projectFiles?: Array<{ name: string; path: string; is_dir: boolean; children?: any[] }>
): string {
  // Count non-directory files
  const fileCount = projectFiles?.filter(f => !f.is_dir).length ?? 0;
  const workspaceSection = fileCount > 0
    ? `\n\nWORKSPACE: ${fileCount} source files in project.\nFor workspace-wide tasks — analyze, audit, architecture, dependencies, project overview, codebase review — use list_files before making conclusions.\n`
    : "";

  const modeSection = toolLoopMode
    ? `
TOOL MODE ACTIVE:
- You have tools available to read files, search the project, apply patches, and run commands.
- NEVER guess file contents — always call read_lines or read_file first.
- Use search_in_project before reading a file whose location you are unsure of.
- Use apply_patch for targeted edits. Use write_file only for new files or full rewrites.
- Use read_lines for questions about specific lines. Use read_file only when you need the whole file.
- After reading, answer directly. Do not produce FILE blocks — use the apply_patch or write_file tools instead.
`
    : `
OUTPUT FORMAT (MANDATORY — the IDE parser requires this exact format):

For creating or editing files, use FILE blocks with the COMPLETE file content:
===FILE: path/to/file.ext===
<entire content of the file>
===END_FILE===

For deleting files:
===DELETE: path/to/file.ext===

For running terminal commands:
===CMD: command here===

You can include multiple FILE blocks, DELETE blocks, and CMD blocks in one response.
Before the FILE/CMD/DELETE blocks, briefly explain what you're doing (2-3 sentences max).
Do NOT use markdown code fences for file content — use the FILE block format above.

When the user asks to RUN, START, EXECUTE, or OPEN something, produce CMD blocks.
Examples:
- "run dev" → ===CMD: npm run dev===
- "open in browser" → ===CMD: start index.html===
- "install deps" → ===CMD: npm install===
`;

  return `You are Punam IDE Autopilot.${workspaceSection}

GLOBAL OBJECTIVE: ${globalGoal || "Help the user with their coding task."}

CURRENT SUBTASK: ${currentSubtask || "Respond to the user's latest message."}

PROJECT MEMORY:
${projectMemory || "No persistent memories yet."}

RULES:
- If the user is asking a QUESTION (what, which, where, how, why), answer it directly in plain text.
- If the user is asking to READ or LOOK AT a file, read it and answer. Do NOT modify anything.
- Only produce FILE/CMD/DELETE blocks (or tool calls in tool mode) when the user explicitly asks to CREATE, EDIT, FIX, or RUN something.
- Be precise and minimal. Only change what is necessary.
- Use only the last ${SLIDING_WINDOW_TURNS} chat messages for context.
${modeSection}`;
}

// ── Context Block Builders ────────────────────────────────────────────────────

/** Full-context fallback: file snippets + errors */
function buildContextBlock(snippets: string[], errors: string): string {
  const parts: string[] = [];

  if (snippets.length > 0) {
    const clipped = snippets
      .map((s) => s.slice(0, MAX_SNIPPET_CHARS))
      .join("\n\n---\n\n");
    parts.push(`RELEVANT CODE CONTEXT:\n${clipped}`);
  }

  if (errors.trim()) {
    parts.push(`LATEST ERRORS:\n${errors.slice(0, 2000)}`);
  }

  return parts.join("\n\n");
}

/** Tool-loop path: errors only (no file content) */
function buildErrorOnlyBlock(errors: string): string {
  if (!errors.trim()) return "";
  return `LATEST ERRORS (use tools to read the relevant files):\n${errors.slice(0, 2000)}`;
}

// ── Persistent Agent Memory (localStorage for now, SQLite later) ──────────────

export function loadAgentMemories(projectPath: string): AgentMemoryEntry[] {
  try {
    const raw = localStorage.getItem(MEMORY_STORAGE_KEY);
    if (!raw) return [];
    const all: AgentMemoryEntry[] = JSON.parse(raw);
    return all
      .filter((m) => m.projectId === normalizeProjectId(projectPath))
      .sort((a, b) => b.importance - a.importance);
  } catch {
    return [];
  }
}

export function saveAgentMemory(
  projectPath: string,
  entry: Omit<AgentMemoryEntry, "id" | "projectId" | "createdAt" | "updatedAt">
): void {
  try {
    const raw = localStorage.getItem(MEMORY_STORAGE_KEY);
    const all: AgentMemoryEntry[] = raw ? JSON.parse(raw) : [];
    const projectId = normalizeProjectId(projectPath);

    const newEntry: AgentMemoryEntry = {
      ...entry,
      id: `mem-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      projectId,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    all.push(newEntry);
    const projectEntries = all.filter((m) => m.projectId === projectId);
    if (projectEntries.length > MAX_MEMORY_ENTRIES) {
      const sorted = projectEntries.sort((a, b) => a.importance - b.importance);
      const toRemove = new Set(
        sorted.slice(0, projectEntries.length - MAX_MEMORY_ENTRIES).map((m) => m.id)
      );
      const filtered = all.filter((m) => !toRemove.has(m.id));
      localStorage.setItem(MEMORY_STORAGE_KEY, JSON.stringify(filtered));
    } else {
      localStorage.setItem(MEMORY_STORAGE_KEY, JSON.stringify(all));
    }
  } catch {
    // Storage full or unavailable
  }
}

export function deleteAgentMemory(memoryId: string): void {
  try {
    const raw = localStorage.getItem(MEMORY_STORAGE_KEY);
    if (!raw) return;
    const all: AgentMemoryEntry[] = JSON.parse(raw);
    const filtered = all.filter((m) => m.id !== memoryId);
    localStorage.setItem(MEMORY_STORAGE_KEY, JSON.stringify(filtered));
  } catch {
    /* skip */
  }
}

export function compressMemories(memories: AgentMemoryEntry[]): string {
  if (memories.length === 0) return "";
  return memories
    .slice(0, 10)
    .map((m) => `- [${m.type}] ${m.title}: ${m.content.slice(0, 150)}`)
    .join("\n");
}

// ── Chat Summarization ────────────────────────────────────────────────────────

export function summarizeOldMessages(messages: ChatMessage[]): string {
  if (messages.length <= SLIDING_WINDOW_TURNS) return "";

  const oldMessages = messages.slice(0, -SLIDING_WINDOW_TURNS);
  const summaryParts: string[] = [];

  for (const msg of oldMessages) {
    if (msg.role === "user") {
      summaryParts.push(`User asked: ${msg.content.slice(0, 80)}`);
    } else if (msg.parsed && msg.parsed.fileChanges.length > 0) {
      const files = msg.parsed.fileChanges.map((f) => f.path).join(", ");
      summaryParts.push(`Punam edited: ${files}`);
    } else if (msg.parsed && msg.parsed.commands.length > 0) {
      summaryParts.push(`Punam ran: ${msg.parsed.commands[0]}`);
    }
  }

  const summary = summaryParts.join("\n").slice(0, 500);
  return summary ? `CONVERSATION SUMMARY (older messages):\n${summary}` : "";
}

// ── Auto-extract memories from AI responses ───────────────────────────────────

export function extractMemoriesFromResponse(
  projectPath: string,
  userMessage: string,
  assistantResponse: string,
  fileChanges: string[]
): void {
  const decisionPatterns = [
    /(?:decided|chose|using|switched to|prefer)\s+(.{10,60})/i,
    /(?:the issue was|root cause|fixed by)\s+(.{10,80})/i,
  ];

  for (const pattern of decisionPatterns) {
    const match = assistantResponse.match(pattern);
    if (match) {
      saveAgentMemory(projectPath, {
        type: "decision",
        title: match[1].slice(0, 60),
        content: match[0].slice(0, 200),
        filePaths: fileChanges,
        importance: 5,
      });
      break;
    }
  }

  if (fileChanges.length > 0 && userMessage.length > 10) {
    const keywords = userMessage
      .toLowerCase()
      .match(/\b(auth|login|api|database|route|config|test|deploy)\b/g);
    if (keywords && keywords.length > 0) {
      saveAgentMemory(projectPath, {
        type: "fact",
        title: `${keywords[0]} is in ${fileChanges[0]}`,
        content: `User worked on ${keywords.join(", ")} in files: ${fileChanges.join(", ")}`,
        filePaths: fileChanges,
        importance: 4,
      });
    }
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function normalizeProjectId(path: string): string {
  return path.replace(/\\/g, "/").toLowerCase();
}

export { SLIDING_WINDOW_TURNS };
