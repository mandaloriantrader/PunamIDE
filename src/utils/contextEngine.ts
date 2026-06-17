/**
 * Context Engine — Punam's memory architecture.
 * 
 * Final Prompt Formula:
 *   System Instruction
 *   + Global Goal
 *   + Compressed Project Memory
 *   + Current Subtask
 *   + Relevant Snippets from Rust (TF-IDF + dependency graph + git boost + tab boost)
 *   + Latest Errors
 *   + Last 3-4 Messages Only
 * 
 * Rules:
 *   - SLIDING_WINDOW_TURNS = 4 (only last 4 messages go to LLM)
 *   - Never send full chat history
 *   - Never send full files (only relevant snippets)
 *   - Persistent memory survives across sessions (SQLite via Tauri)
 *   - Rust context engine provides intelligent file scoring automatically
 */

import type { ChatMessage } from "../types";
import { invoke } from "@tauri-apps/api/core";
import { memoryList, memoryQuickAdd, memoryDelete, memorySearch } from "../services/memory/MemoryManager";
import type { MemoryEntry } from "../services/memory/MemoryManager";

// ── Constants ─────────────────────────────────────────────────────────────────

const SLIDING_WINDOW_TURNS = 4;
const MAX_SNIPPET_CHARS = 100000;
const MAX_MEMORY_ENTRIES = 20;
const MEMORY_STORAGE_KEY = "punam-agent-memory";

// ── Rust Context Engine Types ─────────────────────────────────────────────────

/** File returned by the Rust get_relevant_context command with TF-IDF scoring. */
export interface RustContextFile {
  path: string;
  content: string;
  relevance: number;
}

/** Full response from Rust's unified context engine. */
export interface RustRelevantContext {
  project_summary: string;
  relevant_files: RustContextFile[];
  git_status: string[];
  open_tab_paths: string[];
  total_tokens_estimate: number;
}

/**
 * Fetch intelligent code context from the Rust backend.
 *
 * Uses TF-IDF + token overlap + git recency boost (1.5×) + open tab boost (3×)
 * + dependency graph neighbor expansion. Returns ranked, trimmed file snippets
 * ready for injection into the LLM prompt.
 *
 * This is fire-and-forget safe: returns empty context on any failure so the
 * chat flow is never blocked.
 */
export async function fetchRustContext(
  query: string,
  openTabPaths: string[] = [],
  maxFiles: number = 8,
): Promise<RustRelevantContext | null> {
  try {
    const result = await invoke<RustRelevantContext>("get_relevant_context", {
      query,
      openTabPaths,
      maxFiles,
    });
    return result;
  } catch (err) {
    console.warn("[ContextEngine] Rust context fetch failed (non-fatal):", err);
    return null;
  }
}

/**
 * Format Rust context into snippet strings compatible with the existing
 * buildContextBlock pipeline. Each file becomes a "## path\n```\n...\n```" block.
 *
 * Files are ordered by relevance score (highest first).
 * Dependency neighbors (relevance ≤ 0.5) are labeled as such.
 */
export function formatRustContextAsSnippets(ctx: RustRelevantContext): string[] {
  const snippets: string[] = [];

  // Sort by relevance descending
  const sorted = [...ctx.relevant_files].sort((a, b) => b.relevance - a.relevance);

  for (const file of sorted) {
    const ext = file.path.split(".").pop() || "";
    const label = file.relevance <= 0.5 ? " (dependency neighbor)" : "";
    snippets.push(`## ${file.path}${label}\n\`\`\`${ext}\n${file.content}\n\`\`\``);
  }

  // Append git status as context if present
  if (ctx.git_status.length > 0) {
    snippets.push(`## Git Status (modified files)\n\`\`\`\n${ctx.git_status.join("\n")}\n\`\`\``);
  }

  return snippets;
}

// ── Types ─────────────────────────────────────────────────────────────────────

export interface AgentMemoryEntry {
  id: string;
  projectId: string;
  type: "decision" | "preference" | "fact" | "error_fix" | "architecture";
  title: string;
  content: string;
  filePaths: string[];
  importance: number;
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
  activeFilePath?: string;
  projectFiles?: Array<{ name: string; path: string; is_dir: boolean; children?: any[] }>;
  /** Paths of currently open editor tabs — used for Rust context scoring (3× boost). */
  openTabPaths?: string[];
  /** If true, skip Rust context fetch (useful for fast-path or when already provided). */
  skipRustContext?: boolean;
}

// ── Core: Assemble Persistent Payload ─────────────────────────────────────────

/**
 * Build the full context payload for the AI. Now async because it queries the
 * Rust backend for intelligent file selection (TF-IDF + dep graph + git + tabs).
 *
 * The Rust context is merged with any manually-provided activeFileSnippets.
 * If Rust context fails or is skipped, falls back to the provided snippets only.
 */
export async function assemblePersistentPayload(inputs: ContextInputs): Promise<ContextPayload> {
  const { globalGoal, currentSubtask, fullHistory, activeFileSnippets, latestErrors, projectMemory } = inputs;
  const systemInstruction = buildSystemInstruction(globalGoal, currentSubtask, projectMemory, inputs.activeFilePath, inputs.projectFiles);

  // ── Fetch Rust intelligent context (TF-IDF + dep graph + git + tabs) ───
  let allSnippets = [...activeFileSnippets];

  if (!inputs.skipRustContext) {
    // Use the subtask/goal as the search query for Rust's TF-IDF engine
    const searchQuery = currentSubtask || globalGoal || "";
    if (searchQuery.length > 3) {
      const rustCtx = await fetchRustContext(
        searchQuery,
        inputs.openTabPaths || [],
        8,
      );
      if (rustCtx && rustCtx.relevant_files.length > 0) {
        const rustSnippets = formatRustContextAsSnippets(rustCtx);
        // Merge: Rust context goes BEFORE manual snippets (higher quality, scored)
        // but deduplicate — if the active file is already in Rust results, skip it
        const activeFileRelative = inputs.activeFilePath
          ? inputs.activeFilePath.replace(/\\/g, "/").split("/").slice(-3).join("/")
          : null;
        const rustPaths = new Set(rustCtx.relevant_files.map(f => f.path));
        const deduped = activeFileSnippets.filter(s => {
          // Keep manually-provided snippets that Rust didn't already include
          if (!activeFileRelative) return true;
          return !rustPaths.has(activeFileRelative);
        });
        allSnippets = [...rustSnippets, ...deduped];
      }
    }
  }

  const contextBlock = buildContextBlock(allSnippets, latestErrors);
  const recentMessages: typeof fullHistory = [];
  const contents: ContextPayload["contents"] = [];
  if (contextBlock.trim()) {
    contents.push({ role: "user", parts: [{ text: contextBlock }] });
  }
  for (const msg of recentMessages) {
    contents.push({ role: msg.role === "user" ? "user" : "model", parts: [{ text: msg.content.slice(0, 3000) }] });
  }
  const allText = systemInstruction + contents.map(c => c.parts[0].text).join("");
  const tokenEstimate = Math.ceil(allText.length / 4);
  return { systemInstruction, contents, tokenEstimate };
}

// ── System Instruction Builder ────────────────────────────────────────────────

function buildSystemInstruction(
  globalGoal: string, currentSubtask: string, projectMemory: string,
  activeFilePath?: string, projectFiles?: Array<{ name: string; path: string; is_dir: boolean; children?: any[] }>
): string {
  const activeFileName = activeFilePath ? activeFilePath.replace(/.*[\/\\]/, "") : null;
  const projectFilePaths: string[] = [];
  const walkProjectFiles = (entries: Array<{ name: string; path: string; is_dir: boolean; children?: any[] }> = []) => {
    for (const entry of entries) {
      if (projectFilePaths.length >= 120) return;
      if (entry.is_dir) { if (entry.children?.length) walkProjectFiles(entry.children); }
      else { projectFilePaths.push(entry.path); }
    }
  };
  walkProjectFiles(projectFiles);
  const fileCount = projectFilePaths.length;
  const workspaceSection = fileCount > 0
    ? `\n\nWORKSPACE: ${fileCount} source files in project.\nFor workspace-wide tasks — analyze, audit, architecture, dependencies, project overview, codebase review — use list_files before making conclusions.\n`
    : "";

  return `You are Punam IDE Autopilot.${workspaceSection}

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

DEFENSIVE CODING RULES (these prevent common mistakes):
- ALWAYS check imports before editing — verify that every symbol you use is already imported or add the import.
- ALWAYS trace the call chain before modifying a function signature — understand what calls this function and what it calls.
- NEVER assume missing code — if a function, type, or module is not in the provided context, do NOT invent its implementation. Ask to see it first.
- NEVER hallucinate import paths or external dependencies — only use imports that exist in the project or standard library. Do not invent npm package names, crate names, or module paths.
- PREFER minimal, surgical patches over full-file rewrites — change only the lines that need to change. Do not reformat or restructure unrelated code.
- RESPECT existing code patterns — follow the naming conventions, indentation style, and architectural patterns already used in the file.
- When in doubt, ask for clarification rather than guessing — it is better to request more context than to produce incorrect code.

CODE MODIFICATION CHECKLIST (apply before every EDIT or FILE block):
1. Have I verified all imports are correct and exist?
2. Have I checked what calls this function and what it calls?
3. Is this a minimal patch — am I changing ONLY what's necessary?
4. Does my code follow the existing patterns in this file?
5. If I'm unsure about anything, have I asked for the relevant file content?

OUTPUT FORMAT (MANDATORY — the IDE parser requires this exact format):

=== PREFERRED: EDIT blocks for existing files ===
EDIT blocks use search/replace for targeted changes — this is the PREFERRED format for existing files:
===EDIT: path/to/file.ext===
<<<SEARCH
exact lines to find (include 2-3 context lines before and after)
>>>REPLACE
replacement lines
<<<SEARCH
another change in the same file
>>>REPLACE
its replacement
===END_EDIT===

Rules for EDIT blocks:
- SEARCH text must match EXACTLY (including whitespace, indentation, line endings)
- Include 2-3 context lines around the change for unique matching
- You can have multiple SEARCH/REPLACE pairs per EDIT block (for multiple changes in one file)
- You can have multiple EDIT blocks in one response (for changes across multiple files)
- ALWAYS prefer EDIT blocks over FILE blocks — they use fewer output tokens and cannot accidentally overwrite unrelated code
- For multi-file changes, use one EDIT block per file

=== FILE blocks for new files or complete rewrites ===
===FILE: path/to/new/file.ext===
<entire content of the new file>
===END_FILE===

=== DELETE blocks ===
===DELETE: path/to/file.ext===

=== CMD blocks for terminal commands ===
===CMD: command here===

You can include multiple EDIT, FILE, DELETE, and CMD blocks in one response.
Multi-file editing is fully supported — output as many EDIT/FILE blocks as needed.
Before the blocks, briefly explain what you're doing (2-3 sentences max).
Do NOT use markdown code fences for file content — use the EDIT or FILE block format above.

When the user asks to RUN, START, EXECUTE, or OPEN something, produce CMD blocks.
Examples:
- "run dev" → ===CMD: npm run dev===
- "open in browser" → ===CMD: start index.html===
- "install deps" → ===CMD: npm install===
`;
}

// ── Context Block Builder ─────────────────────────────────────────────────────

const LARGE_FILE_CHARS = 8000;

function buildContextBlock(snippets: string[], errors: string): string {
  const parts: string[] = [];
  if (snippets.length > 0) {
    const clipped = snippets.map(s => {
      const raw = s.slice(0, MAX_SNIPPET_CHARS);
      const headerMatch = raw.match(/^(## .+\n```[^\n]*\n)([\s\S]*)$/);
      if (!headerMatch) return raw;
      const header = headerMatch[1];
      const code = headerMatch[2];

      // Smart compression for large files
      if (raw.length > LARGE_FILE_CHARS) {
        const lines = code.split("\n");
        const importCount = Math.min(Math.floor(lines.length * 0.12), 25);
        const numberedImports = lines.slice(0, importCount).map((line, i) => `${String(i + 1).padStart(4, " ")} | ${line}`);
        const sigs: string[] = [];
        for (let i = importCount; i < lines.length; i++) {
          const ln = lines[i].trim();
          if (/^(export\s+)?(async\s+)?function\s+\w+|^(export\s+)?class\s+\w+|^(export\s+)?(const|let|var)\s+\w+\s*=\s*(async\s*)?\(|^pub\s+(async\s+)?fn\s+\w+|^def\s+\w+|^class\s+\w+/.test(ln)) {
            sigs.push(`${String(i + 1).padStart(4, " ")} | ${ln}`);
          }
        }
        if (sigs.length > 0) {
          return `${header}${numberedImports.join("\n")}\n     | ... ${lines.length - importCount - sigs.length} lines compressed — signatures:\n${sigs.join("\n")}`;
        }
      }

      const numbered = code.split("\n").map((line, i) => `${String(i + 1).padStart(4, " ")} | ${line}`).join("\n");
      return header + numbered;
    }).join("\n\n---\n\n");
    parts.push(`RELEVANT CODE CONTEXT:\n${clipped}`);
  }
  if (errors.trim()) { parts.push(`LATEST ERRORS:\n${errors.slice(0, 2000)}`); }
  return parts.join("\n\n");
}

// ── Persistent Agent Memory (SQLite via Tauri commands) ────────────────────────

export async function loadAgentMemories(projectPath: string): Promise<AgentMemoryEntry[]> {
  try {
    const projectToken = normalizeProjectId(projectPath).replace(/[\/\\]/g, "_").slice(-40);
    const result = await memorySearch(projectToken, undefined, MAX_MEMORY_ENTRIES);
    if (!result || result.entries.length === 0) return [];
    return result.entries
      .filter(e => e.description.startsWith(`[proj:${projectToken}]`) || e.description.includes(`[proj:${projectToken}]`))
      .map(memToAgentEntry).sort((a, b) => b.importance - a.importance);
  } catch { return legacyLoadFromLocalStorage(projectPath); }
}

async function legacyLoadFromLocalStorage(projectPath: string): Promise<AgentMemoryEntry[]> {
  try {
    const raw = localStorage.getItem(MEMORY_STORAGE_KEY);
    if (!raw) return [];
    const all: AgentMemoryEntry[] = JSON.parse(raw);
    const projectEntries = all.filter(m => m.projectId === normalizeProjectId(projectPath));
    for (const entry of projectEntries.slice(0, MAX_MEMORY_ENTRIES)) {
      await saveAgentMemory(projectPath, { type: entry.type, title: entry.title, content: entry.content, filePaths: entry.filePaths, importance: entry.importance }).catch(() => {});
    }
    if (projectEntries.length > 0) {
      try {
        const remaining = all.filter(m => m.projectId !== normalizeProjectId(projectPath));
        if (remaining.length === 0) localStorage.removeItem(MEMORY_STORAGE_KEY);
        else localStorage.setItem(MEMORY_STORAGE_KEY, JSON.stringify(remaining));
      } catch { /* best-effort */ }
    }
    return projectEntries.sort((a, b) => b.importance - a.importance);
  } catch { return []; }
}

export async function saveAgentMemory(projectPath: string, entry: Omit<AgentMemoryEntry, "id" | "projectId" | "createdAt" | "updatedAt">): Promise<void> {
  try {
    const projectToken = normalizeProjectId(projectPath).replace(/[\/\\]/g, "_").slice(-40);
    const description = `[proj:${projectToken}] [imp:${entry.importance}] [files:${entry.filePaths.join(",")}] ${entry.content}`;
    await memoryQuickAdd("convention", `[${entry.type}] ${entry.title}`, description);
  } catch { /* silent skip */ }
}

export async function deleteAgentMemory(memoryId: string): Promise<void> {
  try { await memoryDelete(memoryId); } catch { /* skip */ }
}

function memToAgentEntry(mem: MemoryEntry): AgentMemoryEntry {
  let projectId = ""; let importance = 5; let filePaths: string[] = []; let content = mem.description;
  const projMatch = mem.description.match(/^\[proj:([^\]]+)\]/);
  if (projMatch) { projectId = projMatch[1]; content = content.slice(projMatch[0].length).trim(); }
  const impMatch = content.match(/^\[imp:(\d+)\]/);
  if (impMatch) { importance = parseInt(impMatch[1], 10) || 5; content = content.slice(impMatch[0].length).trim(); }
  const filesMatch = content.match(/^\[files:([^\]]*)\]/);
  if (filesMatch) { filePaths = filesMatch[1].split(",").filter(Boolean); content = content.slice(filesMatch[0].length).trim(); }
  let type: AgentMemoryEntry["type"] = "decision";
  const typeMatch = mem.title.match(/^\[(\w+)\]\s/);
  if (typeMatch && ["decision", "preference", "fact", "error_fix", "architecture"].includes(typeMatch[1])) { type = typeMatch[1] as AgentMemoryEntry["type"]; }
  return { id: mem.id, projectId, type, title: mem.title, content: content.slice(0, 200), filePaths, importance, createdAt: new Date(mem.created_at).toISOString(), updatedAt: new Date(mem.updated_at).toISOString() };
}

export function compressMemories(memories: AgentMemoryEntry[]): string {
  if (memories.length === 0) return "";
  return memories.slice(0, 10).map(m => `- [${m.type}] ${m.title}: ${m.content.slice(0, 150)}`).join("\n");
}

// ── Chat Summarization ────────────────────────────────────────────────────────

export function summarizeOldMessages(messages: ChatMessage[]): string {
  if (messages.length <= SLIDING_WINDOW_TURNS) return "";
  const oldMessages = messages.slice(0, -SLIDING_WINDOW_TURNS);
  const summaryParts: string[] = [];
  for (const msg of oldMessages) {
    if (msg.role === "user") { summaryParts.push(`User asked: ${msg.content.slice(0, 80)}`); }
    else if (msg.parsed && msg.parsed.fileChanges.length > 0) { summaryParts.push(`Punam edited: ${msg.parsed.fileChanges.map(f => f.path).join(", ")}`); }
    else if (msg.parsed && msg.parsed.commands.length > 0) { summaryParts.push(`Punam ran: ${msg.parsed.commands[0]}`); }
  }
  const summary = summaryParts.join("\n").slice(0, 500);
  return summary ? `CONVERSATION SUMMARY (older messages):\n${summary}` : "";
}

// ── Auto-extract memories from AI responses ───────────────────────────────────

export async function extractMemoriesFromResponse(projectPath: string, userMessage: string, assistantResponse: string, fileChanges: string[]): Promise<void> {
  const decisionPatterns = [/(?:decided|chose|using|switched to|prefer)\s+(.{10,60})/i, /(?:the issue was|root cause|fixed by)\s+(.{10,80})/i];
  for (const pattern of decisionPatterns) {
    const match = assistantResponse.match(pattern);
    if (match) { await saveAgentMemory(projectPath, { type: "decision", title: match[1].slice(0, 60), content: match[0].slice(0, 200), filePaths: fileChanges, importance: 5 }); break; }
  }
  if (fileChanges.length > 0 && userMessage.length > 10) {
    const keywords = userMessage.toLowerCase().match(/\b(auth|login|api|database|route|config|test|deploy)\b/g);
    if (keywords && keywords.length > 0) {
      await saveAgentMemory(projectPath, { type: "fact", title: `${keywords[0]} is in ${fileChanges[0]}`, content: `User worked on ${keywords.join(", ")} in files: ${fileChanges.join(", ")}`, filePaths: fileChanges, importance: 4 });
    }
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function normalizeProjectId(path: string): string { return path.replace(/\\/g, "/").toLowerCase(); }

export { SLIDING_WINDOW_TURNS };