/**
 * Context Engine — Punam's memory architecture.
 * 
 * Final Prompt Formula:
 *   System Instruction
 *   + Global Goal
 *   + Compressed Project Memory
 *   + Current Subtask
 *   + Relevant Snippets from Rust
 *   + Latest Errors
 *   + Last 3-4 Messages Only
 * 
 * Rules:
 *   - SLIDING_WINDOW_TURNS = 4 (only last 4 messages go to LLM)
 *   - Never send full chat history
 *   - Never send full files (only relevant snippets)
 *   - Persistent memory survives across sessions (localStorage for now, SQLite later)
 */

import type { ChatMessage } from "../types";

// ── Constants ─────────────────────────────────────────────────────────────────

const SLIDING_WINDOW_TURNS = 4;
const MAX_SNIPPET_CHARS = 4000;
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
  activeFilePath?: string; // currently open file in editor
}

// ── Core: Assemble Persistent Payload ─────────────────────────────────────────

/**
 * Build the final prompt payload using the memory formula.
 * This is the ONLY function that should be used to build prompts for the agent loop.
 */
export function assemblePersistentPayload(inputs: ContextInputs): ContextPayload {
  const {
    globalGoal,
    currentSubtask,
    fullHistory,
    activeFileSnippets,
    latestErrors,
    projectMemory,
  } = inputs;

  // 1. System instruction with global goal + rules
  const systemInstruction = buildSystemInstruction(globalGoal, currentSubtask, projectMemory, inputs.activeFilePath);

  // 2. Relevant code context + errors as the first "user" turn
  const contextBlock = buildContextBlock(activeFileSnippets, latestErrors);

  // 3. No chat history in agent prompts — causes confusion and bleeds previous answers
  // The current task is already in the system instruction as CURRENT SUBTASK
  const recentMessages: typeof fullHistory = [];

  // 4. Assemble contents array
  const contents: ContextPayload["contents"] = [];

  // Context block as first user message
  if (contextBlock.trim()) {
    contents.push({
      role: "user",
      parts: [{ text: contextBlock }],
    });
  }

  // Recent messages only
  for (const msg of recentMessages) {
    contents.push({
      role: msg.role === "user" ? "user" : "model",
      parts: [{ text: msg.content.slice(0, 3000) }], // cap individual messages
    });
  }

  // Estimate tokens
  const allText = systemInstruction + contents.map(c => c.parts[0].text).join("");
  const tokenEstimate = Math.ceil(allText.length / 4);

  return { systemInstruction, contents, tokenEstimate };
}

// ── System Instruction Builder ────────────────────────────────────────────────

function buildSystemInstruction(
  globalGoal: string,
  currentSubtask: string,
  projectMemory: string,
  activeFilePath?: string
): string {
  const activeFileName = activeFilePath
    ? activeFilePath.replace(/.*[\/\\]/, "")
    : null;

  return `You are Punam IDE Autopilot.

GLOBAL OBJECTIVE: ${globalGoal || "Help the user with their coding task."}

CURRENT SUBTASK: ${currentSubtask || "Respond to the user's latest message."}

EDITOR STATE:
- File currently open: ${activeFileName || "No file open"}
- Full path: ${activeFilePath || "unknown"}

PROJECT MEMORY:
${projectMemory || "No persistent memories yet."}

RULES:
- The file shown in EDITOR STATE is what the user is currently looking at.
- When asked about a specific line number, look at the line numbers in the code context and quote the EXACT content of that line.
- Answer line questions in this format: "Line X of filename contains: <exact content>"
- NEVER answer a line-content question with just the filename — always include the actual content.
- If asked "which file is open", answer with the filename from EDITOR STATE above.
- If the line content is not in the provided context, say "I cannot see that line in the current context."
- Do not ask for old chat history — use only what is provided here.
- Use the retrieved code context below instead of guessing file contents.
- Be precise and minimal. Only change what is necessary.
- If you need to see a file's content that isn't provided, say so explicitly.

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
}

// ── Context Block Builder ─────────────────────────────────────────────────────

function buildContextBlock(snippets: string[], errors: string): string {
  const parts: string[] = [];

  if (snippets.length > 0) {
    // Cap at MAX_SNIPPET_CHARS but also add line numbers so the model can reference them
    const clipped = snippets.map(s => {
      const raw = s.slice(0, MAX_SNIPPET_CHARS);
      // If snippet has a header (## filename) keep it, add line numbers to code
      const headerMatch = raw.match(/^(## .+
```[^
]*
)([\s\S]*)$/);
      if (headerMatch) {
        const header = headerMatch[1];
        const code = headerMatch[2];
        const numbered = code.split("\n").map((line, i) =>
          `${String(i + 1).padStart(4, " ")} | ${line}`
        ).join("\n");
        return header + numbered;
      }
      return raw;
    }).join("\n\n---\n\n");
    parts.push(`RELEVANT CODE CONTEXT:\n${clipped}`);
  }

  if (errors.trim()) {
    parts.push(`LATEST ERRORS:\n${errors.slice(0, 2000)}`);
  }

  return parts.join("\n\n");
}

// ── Persistent Agent Memory (localStorage for now, SQLite later) ──────────────

/**
 * Load all memories for a project.
 */
export function loadAgentMemories(projectPath: string): AgentMemoryEntry[] {
  try {
    const raw = localStorage.getItem(MEMORY_STORAGE_KEY);
    if (!raw) return [];
    const all: AgentMemoryEntry[] = JSON.parse(raw);
    return all
      .filter(m => m.projectId === normalizeProjectId(projectPath))
      .sort((a, b) => b.importance - a.importance);
  } catch {
    return [];
  }
}

/**
 * Save a new memory entry.
 */
export function saveAgentMemory(projectPath: string, entry: Omit<AgentMemoryEntry, "id" | "projectId" | "createdAt" | "updatedAt">): void {
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

    // Add and cap at MAX_MEMORY_ENTRIES per project
    all.push(newEntry);
    const projectEntries = all.filter(m => m.projectId === projectId);
    if (projectEntries.length > MAX_MEMORY_ENTRIES) {
      // Remove lowest importance entries
      const sorted = projectEntries.sort((a, b) => a.importance - b.importance);
      const toRemove = new Set(sorted.slice(0, projectEntries.length - MAX_MEMORY_ENTRIES).map(m => m.id));
      const filtered = all.filter(m => !toRemove.has(m.id));
      localStorage.setItem(MEMORY_STORAGE_KEY, JSON.stringify(filtered));
    } else {
      localStorage.setItem(MEMORY_STORAGE_KEY, JSON.stringify(all));
    }
  } catch {
    // Storage full or unavailable — skip silently
  }
}

/**
 * Delete a memory entry.
 */
export function deleteAgentMemory(memoryId: string): void {
  try {
    const raw = localStorage.getItem(MEMORY_STORAGE_KEY);
    if (!raw) return;
    const all: AgentMemoryEntry[] = JSON.parse(raw);
    const filtered = all.filter(m => m.id !== memoryId);
    localStorage.setItem(MEMORY_STORAGE_KEY, JSON.stringify(filtered));
  } catch { /* skip */ }
}

/**
 * Compress memories into a single string for the system prompt.
 */
export function compressMemories(memories: AgentMemoryEntry[]): string {
  if (memories.length === 0) return "";
  return memories
    .slice(0, 10) // top 10 by importance
    .map(m => `- [${m.type}] ${m.title}: ${m.content.slice(0, 150)}`)
    .join("\n");
}

// ── Chat Summarization ────────────────────────────────────────────────────────

/**
 * Summarize old chat messages into a compressed block.
 * Call this when history exceeds SLIDING_WINDOW_TURNS * 3.
 */
export function summarizeOldMessages(messages: ChatMessage[]): string {
  if (messages.length <= SLIDING_WINDOW_TURNS) return "";

  const oldMessages = messages.slice(0, -SLIDING_WINDOW_TURNS);
  const summaryParts: string[] = [];

  for (const msg of oldMessages) {
    if (msg.role === "user") {
      summaryParts.push(`User asked: ${msg.content.slice(0, 80)}`);
    } else if (msg.parsed && msg.parsed.fileChanges.length > 0) {
      const files = msg.parsed.fileChanges.map(f => f.path).join(", ");
      summaryParts.push(`Punam edited: ${files}`);
    } else if (msg.parsed && msg.parsed.commands.length > 0) {
      summaryParts.push(`Punam ran: ${msg.parsed.commands[0]}`);
    }
  }

  // Keep it short — max 500 chars
  const summary = summaryParts.join("\n").slice(0, 500);
  return summary ? `CONVERSATION SUMMARY (older messages):\n${summary}` : "";
}

// ── Auto-extract memories from AI responses ───────────────────────────────────

/**
 * After an AI response, check if there's something worth remembering.
 * Call this after every successful agent step.
 */
export function extractMemoriesFromResponse(
  projectPath: string,
  userMessage: string,
  assistantResponse: string,
  fileChanges: string[]
): void {
  // Remember architecture decisions
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
      break; // one memory per response max
    }
  }

  // Remember file locations for key concepts
  if (fileChanges.length > 0 && userMessage.length > 10) {
    const keywords = userMessage.toLowerCase().match(/\b(auth|login|api|database|route|config|test|deploy)\b/g);
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
