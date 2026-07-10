// src/components/chat/services/promptBuilder.ts
//
// Pure prompt assembly — builds the full system+user prompt from structured inputs.
// No React state, no hooks, no refs, no side effects.

import type { AgentMode, ChatMessage } from "../../../types";
import type { FileEntry } from "../../../utils/tauri";
import { searchProject } from "../../../utils/tauri";
import { buildMcpToolsPrompt } from "../../../utils/mcp";
import type { MCPServerConfig } from "../../../utils/mcp";
import { buildFileContext, getRelativePath, getUnresolvedMentions } from "../../../utils/chatHelpers";
import { buildMemoryContext } from "../../../services/memory/MemoryManager";
import { AGENT_MODES } from "../constants";

// ── Types ────────────────────────────────────────────────────────────────────

export interface PromptBuildInputs {
  userPrompt: string;
  mode: AgentMode;
  projectPath: string;
  files: FileEntry[];
  openTabs: Array<{ path: string }>;
  activeFilePath?: string;
  selectedText?: string;
  problems?: Array<{ severity: string; message: string; path: string; line: number }>;
  terminalOutput?: string;
  proactiveError?: { command: string; output: string } | null;
  messages: ChatMessage[];
  mcpServers: MCPServerConfig[];
  attachedContext: string;
  existingFiles: Set<string>;
}

export interface BuiltPrompt {
  prompt: string;
  searchSection: string;
  unresolvedSection: string;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function buildSearchSection(userPrompt: string, projectPath: string): Promise<string> {
  const searchKeywords = /\b(find|search|where|locate|which file|grep|usage|used|called|imported)\b/i;
  if (!searchKeywords.test(userPrompt) || !projectPath) return Promise.resolve("");

  const searchTerms = userPrompt
    .replace(/\b(find|search|where|locate|which file|grep|usage|used|called|imported|in|the|is|are|all|of|for|this|that|how|many|times)\b/gi, "")
    .trim()
    .split(/\s+/)
    .filter((w) => w.length > 2)
    .slice(0, 2);

  if (searchTerms.length === 0) return Promise.resolve("");

  const query = searchTerms.join(" ");
  return searchProject(query)
    .then((results) => {
      if (results.length > 0) {
        const resultLines = results.slice(0, 15).map(
          (r) => `${r.path}:${r.line} — ${r.preview.slice(0, 100)}`
        );
        return `\n\n# Search Results for "${query}" (${results.length} matches)\n\`\`\`\n${resultLines.join("\n")}\n\`\`\``;
      }
      return "";
    })
    .catch(() => "");
}

function buildHistorySection(messages: ChatMessage[]): string {
  const recentHistory = messages.slice(-10).map((m) => {
    const role = m.role === "user" ? "User" : "Punam";
    const content = m.role === "assistant" && m.parsed
      ? m.parsed.explanation || "(applied code changes)"
      : m.content.slice(0, 500);
    return `${role}: ${content}`;
  }).join("\n");
  return recentHistory ? `\n\n# Conversation History (recent)\n${recentHistory}` : "";
}

function buildUnresolvedSection(userPrompt: string, existingFiles: Set<string>): string {
  const unresolvedFiles = getUnresolvedMentions(userPrompt, existingFiles);
  if (unresolvedFiles.length === 0) return "";
  return `\n\n# ⚠️ Non-Existent File References\nThe user mentioned the following file(s) that do NOT exist in the project:\n${unresolvedFiles.map((f) => `- ${f}`).join("\n")}\nIMPORTANT: Before proposing to create these files, explicitly tell the user that the file does not exist and ask if they want you to create it. Do NOT silently create files that the user may have assumed already existed.`;
}

// ── Main prompt builder ──────────────────────────────────────────────────────

/**
 * Assemble the full LLM prompt from structured inputs.
 * Pure async function — no state mutations, no side effects beyond searchProject and buildMemoryContext calls.
 */
export async function buildLlmPrompt(inputs: PromptBuildInputs): Promise<BuiltPrompt> {
  const {
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
    existingFiles,
  } = inputs;

  const modeInstruction = AGENT_MODES.find((item) => item.id === mode)?.instruction ?? AGENT_MODES[1].instruction;

  // MCP tools
  const mcpToolsSection = buildMcpToolsPrompt(mcpServers);
  const mcpSection = mcpToolsSection ? `\n\n${mcpToolsSection}` : "";

  // Core sections
  const hasSelection = selectedText && selectedText.trim().length > 0;
  const activeRelPath = activeFilePath ? getRelativePath(projectPath, activeFilePath) : "";
  const openTabNames = openTabs.map((tab) => getRelativePath(projectPath, tab.path));

  const workspaceSection = `\n\n# Current Workspace (authoritative)\nProject root: ${projectPath || "none"}\nProject name: ${projectPath ? projectPath.split(/[\\/]/).pop() : "none"}\nIMPORTANT: Treat this as the only current project. If conversation history, terminal output, or prior messages mention another path, they are stale unless they match this project root.`;

  const editorStateSection = `\n\n# Editor State\nActive file: ${activeRelPath || "none"}\nOpen tabs: ${openTabNames.length > 0 ? openTabNames.join(", ") : "none"}`;

  const commandEnvironmentSection = `\n\n# Command Execution Environment\n- The project is running on Windows.\n- CMD blocks execute through PowerShell, not cmd.exe and not a Linux shell.\n- Commands execute independently. Each CMD block starts from the project root.\n- Working directory changes do not persist between CMD blocks.\n- If a command requires a different directory, use Set-Location within the same command, for example: Set-Location src; npm run build.\n- Use PowerShell-native commands: Get-ChildItem, Get-Content, Select-String, Test-Path, New-Item, Remove-Item.\n- Do not use Unix-only helpers like head, grep, sed, awk, cat, or ls -la unless the user explicitly asks for a Unix shell.\n- Prefer project-relative paths and quote paths with spaces using straight ASCII double quotes.`;

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

  // Async sections
  const [searchSection, memoryContext] = await Promise.all([
    buildSearchSection(userPrompt, projectPath),
    buildMemoryContext(activeRelPath).catch(() => ""),
  ]);

  const historySection = buildHistorySection(messages);
  const unresolvedSection = buildUnresolvedSection(userPrompt, existingFiles);

  const fileTree = buildFileContext(files);

  const prompt = `# Agent Mode\n${modeInstruction}${contextInstruction}${mcpSection}${workspaceSection}${commandEnvironmentSection}${memoryContext}\n\n# User Request\n${userPrompt}${editorStateSection}${selectionSection}${searchSection}${problemsSection}${terminalSection}${unresolvedSection}${historySection}\n\n# Project Structure\n\`\`\`\n${fileTree}\`\`\`\n\n# Attached File Context\n${attachedContext || "No file contents attached."}`;

  return { prompt, searchSection, unresolvedSection };
}
