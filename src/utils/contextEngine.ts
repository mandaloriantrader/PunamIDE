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
import { buildSystemPrompt } from "./systemPrompt";
import type { SystemPromptContext } from "./systemPrompt";
import { useAIStore } from "../store/aiStore";

// ── Constants ─────────────────────────────────────────────────────────────────

const SLIDING_WINDOW_TURNS = 4;
const MAX_SNIPPET_CHARS = 100000;
const MAX_MEMORY_ENTRIES = 20;
const MEMORY_STORAGE_KEY = "punam-agent-memory";
const AST_CONTEXT_DEFAULT_MAX_TOKENS = 6000;
const AST_CONTEXT_TOP_K = 8;

// ── AST-Aware Chunking Types (mirrors Rust ASTChunk struct) ───────────────────

/**
 * A semantically complete code chunk extracted via tree-sitter AST analysis.
 * Represents a function, class, module block, or fallback line-range from the
 * Rust `search_codebase_ast` command.
 */
export interface ASTChunk {
  file_path: string;
  chunk_type: "function" | "class" | "module_block" | "fallback";
  symbol_name: string;
  start_line: number;
  end_line: number;
  content: string;
  language: string;
  tokens_estimate: number;
}

interface ASTSearchResult {
  chunks: ASTChunk[];
  total_matches: number;
  search_method: string;
}

// ── AST Context Builder (Requirements 10.1, 10.2, 10.6) ──────────────────────

/**
 * Deduplicate chunks from the same file that have overlapping or adjacent line ranges.
 * Merges chunks whose line ranges overlap (startB <= endA + 1) into a single chunk
 * with combined content spanning the full range.
 */
export function deduplicateChunks(chunks: ASTChunk[]): ASTChunk[] {
  if (chunks.length <= 1) return chunks;

  // Group chunks by file path
  const byFile = new Map<string, ASTChunk[]>();
  for (const chunk of chunks) {
    const existing = byFile.get(chunk.file_path) || [];
    existing.push(chunk);
    byFile.set(chunk.file_path, existing);
  }

  const result: ASTChunk[] = [];

  for (const [, fileChunks] of byFile) {
    if (fileChunks.length === 1) {
      result.push(fileChunks[0]);
      continue;
    }

    // Sort by start_line ascending
    const sorted = [...fileChunks].sort((a, b) => a.start_line - b.start_line);
    const merged: ASTChunk[] = [sorted[0]];

    for (let i = 1; i < sorted.length; i++) {
      const current = sorted[i];
      const last = merged[merged.length - 1];

      // Overlapping or adjacent: current starts within or immediately after last
      if (current.start_line <= last.end_line + 1) {
        // Merge into last chunk
        const mergedEndLine = Math.max(last.end_line, current.end_line);
        const mergedContent = last.content + "\n" + current.content;
        const mergedTokens = Math.ceil(mergedContent.split(/\s+/).length / 0.75);

        merged[merged.length - 1] = {
          file_path: last.file_path,
          chunk_type: last.chunk_type === "class" || current.chunk_type === "class" ? "class" : last.chunk_type,
          symbol_name: last.symbol_name + "+" + current.symbol_name,
          start_line: last.start_line,
          end_line: mergedEndLine,
          content: mergedContent,
          language: last.language,
          tokens_estimate: mergedTokens,
        };
      } else {
        merged.push(current);
      }
    }

    result.push(...merged);
  }

  return result;
}

/**
 * Format a single AST chunk for LLM consumption.
 * Format: `// file_path:startLine-endLine [chunk_type: symbol_name]\n{content}`
 */
function formatASTChunk(chunk: ASTChunk): string {
  const header = `// ${chunk.file_path}:${chunk.start_line}-${chunk.end_line} [${chunk.chunk_type}: ${chunk.symbol_name}]`;
  return `${header}\n${chunk.content}`;
}

/**
 * Build AST-aware context for an agent query.
 *
 * Calls the Rust `search_codebase_ast` backend to retrieve semantically complete
 * code chunks ranked by BM25, deduplicates overlapping results, formats them for
 * the LLM, and enforces a token budget.
 *
 * @param query - The search query (user question or subtask description)
 * @param projectPath - Absolute path to the project root
 * @param maxTokens - Maximum token budget for the output (default 6000)
 * @returns Formatted string of AST chunks ready for LLM context injection
 */
export async function buildASTContext(
  query: string,
  projectPath: string,
  maxTokens: number = AST_CONTEXT_DEFAULT_MAX_TOKENS
): Promise<string> {
  try {
    const searchResult = await invoke<ASTSearchResult>("search_codebase_ast", {
      query,
      projectPath,
      topK: AST_CONTEXT_TOP_K,
    });

    if (!searchResult || searchResult.chunks.length === 0) {
      return "";
    }

    // Deduplicate overlapping/adjacent chunks from same file
    const dedupedChunks = deduplicateChunks(searchResult.chunks);

    // Format chunks with token budget enforcement
    const formattedParts: string[] = [];
    let cumulativeTokens = 0;

    for (const chunk of dedupedChunks) {
      const formatted = formatASTChunk(chunk);
      // Estimate tokens for this formatted chunk (word count / 0.75)
      const chunkTokens = Math.ceil(formatted.split(/\s+/).length / 0.75);

      if (cumulativeTokens + chunkTokens > maxTokens) {
        break;
      }

      formattedParts.push(formatted);
      cumulativeTokens += chunkTokens;
    }

    return formattedParts.join("\n\n");
  } catch (err) {
    console.warn("[ContextEngine] AST context build failed (non-fatal):", err);
    return "";
  }
}

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

// ── Git Diff Stat (refreshed before each agent turn — Requirement 1.5) ────────

/**
 * Fetch fresh `git diff --stat` summary from the project.
 * Returns empty string if not a git repository or on any failure.
 */
export async function fetchGitDiffStat(projectPath: string): Promise<string> {
  try {
    const result = await invoke<{ stdout: string; stderr: string; exit_code: number }>(
      "run_terminal_command",
      { command: "git diff --stat --no-color HEAD", cwd: projectPath, timeoutMs: 5000 }
    );
    if (result.exit_code === 0 && result.stdout.trim()) {
      return result.stdout.trim().slice(0, 1500);
    }
    return "";
  } catch {
    return "";
  }
}

/**
 * Build a dynamic system instruction using the structured `buildSystemPrompt`
 * from systemPrompt.ts. Uses the repo map cache from aiStore and refreshes
 * git diff stat on every call (Requirement 1.5).
 *
 * Falls back to the legacy static prompt if repo map is unavailable.
 */
export async function buildDynamicSystemInstruction(
  projectPath: string,
  openTabs: Array<{ path: string; language?: string }>,
  activeFilePath?: string,
  projectFiles?: Array<{ name: string; path: string; is_dir: boolean; children?: any[] }>
): Promise<string> {
  const store = useAIStore.getState();
  const repoMap = store.repoMapCache;

  // Refresh git diff stat before each turn (Requirement 1.5)
  const gitStatus = await fetchGitDiffStat(projectPath);

  // If repo map is not available, return empty to signal fallback to legacy
  if (!repoMap) {
    return "";
  }

  // Detect project languages from repo map symbols
  const langSet = new Set<string>();
  for (const sym of repoMap.symbols) {
    if (sym.fileType) langSet.add(sym.fileType);
  }
  const projectLanguages = Array.from(langSet).slice(0, 5);

  const ctx: SystemPromptContext = {
    repoMap,
    openTabs: openTabs.slice(0, 10).map(t => ({
      path: t.path,
      language: t.language || t.path.split(".").pop() || "unknown",
    })),
    gitStatus,
    activeFile: activeFilePath,
    projectLanguages,
    agentMode: "edit",
  };

  return buildSystemPrompt(ctx);
}

// ── AST Index Timeout & Fallback Constants ────────────────────────────────────

const AST_INDEX_TIMEOUT_MS = 30_000; // 30 seconds max wait for indexing

// ── AST Context with Indexing & Fallback (Requirements 10.1, 10.3, 10.4, 10.5) ──

/**
 * Fetch AST-aware context for the agent query with full fallback chain:
 *
 * 1. If AST index is not ready → trigger indexing, wait up to 30 seconds
 * 2. If indexing fails or times out → fall back to line-based search, emit warning
 * 3. If AST search returns zero results → fall back to text-based grep with same output format
 *
 * Returns { astContext, warning } where `warning` is non-empty if AST was unavailable.
 */
async function fetchASTContextWithFallback(
  query: string,
  projectPath: string,
): Promise<{ astContext: string; warning: string }> {
  const store = useAIStore.getState();
  let warning = "";

  // Check if AST index is ready; if not, trigger indexing and wait
  if (store.astIndexStatus !== "ready") {
    store.setASTIndexStatus("indexing");
    try {
      // Trigger indexing and wait up to 30 seconds
      const indexPromise = invoke<number>("index_codebase_ast", { projectPath });
      const timeoutPromise = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("AST indexing timeout")), AST_INDEX_TIMEOUT_MS)
      );
      await Promise.race([indexPromise, timeoutPromise]);
      store.setASTIndexStatus("ready");
    } catch (err) {
      store.setASTIndexStatus("error");
      console.warn("[ContextEngine] AST indexing failed/timed out, falling back to line-based search:", err);
      warning = "⚠️ AST-aware code indexing was unavailable. Using line-based context search as fallback.";

      // Fall back to line-based grep search with same output structure
      const grepFallback = await fetchGrepFallbackContext(query, projectPath);
      return { astContext: grepFallback, warning };
    }
  }

  // AST index is ready — perform BM25 search
  const astResult = await buildASTContext(query, projectPath);

  if (astResult.length === 0) {
    // AST search returned zero results — fall back to text-based grep (Requirement 10.5)
    const grepFallback = await fetchGrepFallbackContext(query, projectPath);
    return { astContext: grepFallback, warning: "" };
  }

  return { astContext: astResult, warning: "" };
}

/**
 * Fall back to text-based grep search when AST context is unavailable or empty.
 * Formats results using the same structure as AST context output for consistency.
 *
 * Format: `// file_path:startLine-endLine [fallback: grep_match]\n{content}`
 */
async function fetchGrepFallbackContext(
  query: string,
  projectPath: string,
): Promise<string> {
  try {
    const grepResults = await invoke<Array<{
      file_path: string;
      content: string;
      start_line: number;
      end_line: number;
    }>>("search_codebase", {
      query,
      projectPath,
      topK: AST_CONTEXT_TOP_K,
    });

    if (!grepResults || grepResults.length === 0) return "";

    return grepResults
      .slice(0, AST_CONTEXT_TOP_K)
      .map(hit => `// ${hit.file_path}:${hit.start_line}-${hit.end_line} [fallback: grep_match]\n${hit.content}`)
      .join("\n\n");
  } catch (err) {
    console.warn("[ContextEngine] Grep fallback also failed (non-fatal):", err);
    return "";
  }
}

// ── Core: Assemble Persistent Payload ─────────────────────────────────────────

/**
 * Build the full context payload for the AI. Now async because it queries the
 * Rust backend for intelligent file selection (TF-IDF + dep graph + git + tabs).
 *
 * The Rust context is merged with any manually-provided activeFileSnippets.
 * If Rust context fails or is skipped, falls back to the provided snippets only.
 *
 * Additionally, AST-aware context is fetched and included as a separate section
 * to complement (not replace) the TF-IDF context (Requirements 10.1, 10.3-10.5).
 */
export async function assemblePersistentPayload(inputs: ContextInputs): Promise<ContextPayload> {
  const { globalGoal, currentSubtask, fullHistory, activeFileSnippets, latestErrors, projectMemory } = inputs;

  // Try dynamic system prompt with repo map (Requirement 1.1)
  let systemInstruction = "";
  if (inputs.projectPath) {
    systemInstruction = await buildDynamicSystemInstruction(
      inputs.projectPath,
      inputs.openTabPaths?.map(p => ({ path: p })) || [],
      inputs.activeFilePath,
      inputs.projectFiles
    );
  }

  // Fallback to legacy static system instruction if dynamic prompt unavailable
  if (!systemInstruction) {
    systemInstruction = buildSystemInstruction(globalGoal, currentSubtask, projectMemory, inputs.activeFilePath, inputs.projectFiles);
  }

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

  // ── Fetch AST-aware context (Requirements 10.1, 10.3, 10.4, 10.5) ──────
  // AST context complements (does not replace) the TF-IDF context above.
  // It provides semantically complete code chunks (functions, classes) via BM25.
  let astContextSection = "";
  let astWarning = "";

  if (inputs.projectPath && !inputs.skipRustContext) {
    const searchQuery = currentSubtask || globalGoal || "";
    if (searchQuery.length > 3) {
      const { astContext, warning } = await fetchASTContextWithFallback(searchQuery, inputs.projectPath);
      astContextSection = astContext;
      astWarning = warning;
    }
  }

  const contextBlock = buildContextBlock(allSnippets, latestErrors);
  const recentMessages: typeof fullHistory = [];
  const contents: ContextPayload["contents"] = [];

  // If AST indexing was unavailable, include a warning in the conversation
  if (astWarning) {
    contents.push({ role: "model", parts: [{ text: astWarning }] });
  }

  if (contextBlock.trim()) {
    contents.push({ role: "user", parts: [{ text: contextBlock }] });
  }

  // Inject AST-relevant code as a separate context section after TF-IDF context
  if (astContextSection.trim()) {
    contents.push({
      role: "user",
      parts: [{ text: `AST-RELEVANT CODE (semantically complete functions/classes):\n${astContextSection}` }],
    });
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