// src/components/chat/services/agentContextBuilder.ts
//
// Agent context assembly — builds the payload for agentProposeFix.
// Async but deterministic given inputs. No React state, no hooks, no refs.

import type { ChatMessage } from "../../../types";
import type { FileEntry } from "../../../utils/tauri";
import { readFile } from "../../../utils/tauri";
import { invoke } from "@tauri-apps/api/core";
import { getProjectFilePath, getRelativePath, getFilePathsFromText } from "../../../utils/chatHelpers";
import { buildInternalToolInventoryPrompt } from "../../../utils/agentTools";
import {
  assemblePersistentPayload,
  loadAgentMemories,
  compressMemories,
  summarizeOldMessages,
} from "../../../utils/contextEngine";
import { useAIStore } from "../../../store/aiStore";
import type { RepoMap, RepoNode, SymbolEntry } from "../../../utils/systemPrompt";
import type { AgentTaskState } from "../types";

// ── Types ────────────────────────────────────────────────────────────────────

export interface AgentContextInputs {
  activeTask: AgentTaskState;
  projectPath: string;
  files: FileEntry[];
  openTabs: Array<{ path: string }>;
  activeFilePath?: string | null;
  terminalOutput?: string;
  proactiveError?: { command: string; output: string } | null;
  messages: ChatMessage[];
  existingFiles: Set<string>;
}

export interface AgentContextResult {
  payload: Awaited<ReturnType<typeof assemblePersistentPayload>>;
  currentTask: string;
  existingFiles: Set<string>;
}

// ── Main builder ─────────────────────────────────────────────────────────────

/**
 * Build the full agent context payload from structured inputs.
 * Pure async — no state mutations.
 *
 * On agent session start:
 *  - Fetches repo map via invoke("get_repo_map") if cache is stale (Requirement 1.1)
 *  - Refreshes git diff stat before each turn (Requirement 1.5)
 */
export async function buildAgentContext(inputs: AgentContextInputs): Promise<AgentContextResult> {
  const {
    activeTask,
    projectPath,
    files,
    openTabs,
    activeFilePath,
    terminalOutput,
    proactiveError,
    messages,
    existingFiles,
  } = inputs;

  // ── Repo Map: fetch and cache on agent session start (Requirement 1.1) ─────
  const store = useAIStore.getState();
  if (store.repoMapIsStale || !store.repoMapCache) {
    try {
      const rawSymbols = await invoke<Array<{ file_path: string; exports: string[]; file_type: string }>>(
        "get_repo_map",
        { projectPath }
      );
      // Transform Vec<RepoSymbol> into the RepoMap interface format
      const repoMap = transformRepoSymbolsToRepoMap(rawSymbols);
      store.setRepoMapCache(repoMap);
    } catch (err) {
      console.warn("[AgentContext] get_repo_map failed (non-fatal):", err);
    }
  }

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

  const visibleProjectFiles = Array.from(existingFiles).sort();
  const topLevelEntries = files
    .slice(0, 60)
    .map((entry) => `${entry.is_dir ? "DIR " : "FILE"} ${entry.path || entry.name}`)
    .join("\n");
  snippets.unshift(
    `## Current workspace from file explorer\nProject root: ${projectPath || "unknown"}\nVisible files: ${visibleProjectFiles.length}\n\nTop-level entries:\n${topLevelEntries || "none"}\n\nVisible file sample:\n${visibleProjectFiles.slice(0, 120).map((path) => `FILE ${path}`).join("\n") || "none"}`
  );

  // Load persistent memories
  const memories = await loadAgentMemories(projectPath);
  const compressedMemory = compressMemories(memories);

  // Summarize old messages
  const chatSummary = summarizeOldMessages(messages);
  const fullMemory = [compressedMemory, chatSummary].filter(Boolean).join("\n\n");

  // Previous attempt history
  const historyContext = activeTask.history.length > 0
    ? `Previous attempts (DO NOT repeat):\n${activeTask.history.map((h, i) => `${i + 1}. ${h}`).join("\n")}`
    : "";

  // Build the payload using the Context Engine formula
  const currentTask = activeTask.subtasks.length > 1
    ? activeTask.subtasks[activeTask.currentSubtask]
    : activeTask.task;

  const commandMemory = [
    fullMemory,
    "COMMAND EXECUTION ENVIRONMENT:\n- This app runs on Windows.\n- CMD blocks execute through PowerShell.\n- Commands execute independently. Each CMD block starts from the project root.\n- Working directory changes do not persist between CMD blocks.\n- If a command requires a different directory, use Set-Location within the same command, for example: Set-Location src; npm run build.\n- Use PowerShell-native commands such as Get-ChildItem, Get-Content, Select-String, Test-Path, New-Item, and Remove-Item.\n- Do not use Unix-only helpers like head, grep, sed, awk, cat, or ls -la unless the user explicitly asks for a Unix shell.\n- Internal agent tools are separate from terminal commands. list_files means the internal agent tool, not Get-ChildItem, dir, or ls.\n- If the user says not to run a terminal command, do not produce CMD blocks.",
    buildInternalToolInventoryPrompt(),
  ].filter(Boolean).join("\n\n");

  const payload = await assemblePersistentPayload({
    globalGoal: activeTask.task,
    currentSubtask: `${currentTask} (attempt ${activeTask.attempt}/${activeTask.maxAttempts})${historyContext ? "\n" + historyContext : ""}`,
    fullHistory: messages,
    activeFileSnippets: snippets,
    latestErrors: errorContextText.slice(-2000),
    projectMemory: commandMemory,
    projectPath,
    activeFilePath: activeFilePath || undefined,
    projectFiles: files,
    openTabPaths: openTabs.map((t) => getRelativePath(projectPath, t.path)),
  });

  return { payload, currentTask, existingFiles };
}

// ── Repo Map Transformation ──────────────────────────────────────────────────

/**
 * Transform the flat `Vec<RepoSymbol>` from Rust's `get_repo_map` into the
 * hierarchical `RepoMap` interface that `buildSystemPrompt` expects.
 *
 * Builds a tree structure from file paths and maps symbols to entries.
 */
function transformRepoSymbolsToRepoMap(
  rawSymbols: Array<{ file_path: string; exports: string[]; file_type: string }>
): RepoMap {
  // Build symbols list
  const symbols: SymbolEntry[] = rawSymbols.map(s => ({
    filePath: s.file_path,
    exports: s.exports.slice(0, 8),
    fileType: s.file_type,
  }));

  // Build tree from file paths
  const tree = buildTreeFromPaths(rawSymbols.map(s => s.file_path));

  return {
    tree,
    symbols,
    totalFiles: rawSymbols.length,
    indexedFiles: rawSymbols.length,
  };
}

/**
 * Build a hierarchical RepoNode[] tree from a flat list of file paths.
 * Groups files by directory structure with max depth 4.
 */
function buildTreeFromPaths(paths: string[]): RepoNode[] {
  const root: Map<string, any> = new Map();

  for (const filePath of paths) {
    // Normalize path separators
    const normalized = filePath.replace(/\\/g, "/");
    const parts = normalized.split("/");

    let current = root;
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      if (i === parts.length - 1) {
        // File node
        current.set(part, { __file: true, __path: normalized });
      } else {
        // Directory node
        if (!current.has(part)) {
          current.set(part, new Map());
        }
        const next = current.get(part);
        if (next instanceof Map) {
          current = next;
        } else {
          break; // conflict: file and dir with same name
        }
      }
    }
  }

  // Convert Map structure to RepoNode[]
  function mapToNodes(map: Map<string, any>, parentPath: string, depth: number): RepoNode[] {
    if (depth > 4) return [];
    const nodes: RepoNode[] = [];

    // Sort: directories first, then files, alphabetically within each group
    const entries = Array.from(map.entries()).sort(([aKey, aVal], [bKey, bVal]) => {
      const aIsDir = aVal instanceof Map;
      const bIsDir = bVal instanceof Map;
      if (aIsDir && !bIsDir) return -1;
      if (!aIsDir && bIsDir) return 1;
      return aKey.localeCompare(bKey);
    });

    for (const [name, value] of entries) {
      const currentPath = parentPath ? `${parentPath}/${name}` : name;

      if (value instanceof Map) {
        // Directory
        const children = mapToNodes(value, currentPath, depth + 1);
        nodes.push({ name, path: currentPath, isDir: true, children });
      } else if (value && value.__file) {
        // File
        nodes.push({ name, path: value.__path, isDir: false });
      }
    }

    return nodes;
  }

  return mapToNodes(root, "", 1);
}
