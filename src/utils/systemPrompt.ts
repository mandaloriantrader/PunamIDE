/**
 * System Prompt Builder — Constructs a dynamic, context-rich system prompt
 * for the AI agent with project awareness via repo map, open tabs, and git status.
 *
 * Replaces the static system prompt with a structured prompt that gives the LLM
 * architectural understanding of the project before performing actions.
 *
 * Token budget: system prompt repo map section stays under 4000 tokens (~16000 chars).
 */

// ── Interfaces ────────────────────────────────────────────────────────────────

export interface SystemPromptContext {
  repoMap: RepoMap;
  openTabs: OpenTab[];          // max 10 tab file paths
  gitStatus: string;            // git diff --stat summary
  activeFile?: string;
  projectLanguages: string[];
  agentMode: "edit" | "chat" | "background";
}

export interface RepoMap {
  tree: RepoNode[];
  symbols: SymbolEntry[];
  totalFiles: number;
  indexedFiles: number;
}

export interface RepoNode {
  name: string;
  path: string;
  isDir: boolean;
  children?: RepoNode[];
}

export interface SymbolEntry {
  filePath: string;
  exports: string[];            // max 8 per file
  fileType: string;             // "ts" | "rs" | "py"
}

export interface OpenTab {
  path: string;
  language: string;
}

// ── Constants ─────────────────────────────────────────────────────────────────

/** Max characters for repo map output (~4000 tokens at 4 chars/token). */
const REPO_MAP_MAX_CHARS = 16000;

/** Max directory depth when rendering the tree. */
const MAX_TREE_DEPTH = 4;

/** Max open tabs to include in the prompt. */
const MAX_OPEN_TABS = 10;

// ── buildSystemPrompt ─────────────────────────────────────────────────────────

/**
 * Build the full structured system prompt for the AI agent.
 * Assembles behavioral rules, rendered repo map, open tabs, git status,
 * and project languages into a single prompt string.
 *
 * Graceful degradation: omits git sections if gitStatus is empty (no git repo).
 */
export function buildSystemPrompt(ctx: SystemPromptContext): string {
  const sections: string[] = [];

  // Identity + behavioral rules (always present)
  sections.push(BEHAVIORAL_RULES);

  // Repo map section
  const renderedMap = renderRepoMap(ctx.repoMap);
  if (renderedMap) {
    sections.push(`## Project Repo Map\n\`\`\`\n${renderedMap}\n\`\`\``);
  }

  // Currently open files (capped at 10)
  const tabs = ctx.openTabs.slice(0, MAX_OPEN_TABS);
  if (tabs.length > 0) {
    const tabLines = tabs.map(t => `- ${t.path} (${t.language})`).join("\n");
    sections.push(`## Currently Open Files\n${tabLines}`);
  }

  // Git status — omit entirely if no git repo (Requirement 1.7)
  if (ctx.gitStatus && ctx.gitStatus.trim().length > 0) {
    sections.push(`## Git Status\n\`\`\`\n${ctx.gitStatus.trim()}\n\`\`\``);
  }

  // Primary languages
  if (ctx.projectLanguages.length > 0) {
    sections.push(`## Primary Languages\n${ctx.projectLanguages.join(", ")}`);
  }

  return sections.join("\n\n").trim();
}

// ── renderRepoMap ─────────────────────────────────────────────────────────────

/**
 * Render a compact, token-efficient repo map from the tree and symbols.
 *
 * Walks the tree recursively (max depth 4), appending `[symbol1, symbol2, ...]`
 * after files that have exported symbols. Truncates output to stay under
 * 4000 tokens (~16000 chars).
 *
 * Example output:
 *   src/
 *     utils/
 *       agentToolLoop.ts  [runAgentToolLoop, ToolLoopOptions]
 *       contextEngine.ts  [buildSystemInstruction, assemblePersistentPayload]
 *     components/
 *       AiChat.tsx        [AiChat, ChatMessage]
 */
export function renderRepoMap(map: RepoMap): string {
  if (!map || !map.tree || map.tree.length === 0) {
    return "";
  }

  // Build a lookup: filePath → exports[]
  const symbolLookup = new Map<string, string[]>();
  for (const entry of map.symbols) {
    if (entry.exports.length > 0) {
      symbolLookup.set(entry.filePath, entry.exports);
    }
  }

  const lines: string[] = [];
  let charCount = 0;
  let truncated = false;

  function walkTree(nodes: RepoNode[], depth: number, indent: string): void {
    if (truncated || depth > MAX_TREE_DEPTH) return;

    for (const node of nodes) {
      if (truncated) return;

      let line: string;

      if (node.isDir) {
        line = `${indent}${node.name}/`;
      } else {
        // Check if this file has symbols
        const symbols = symbolLookup.get(node.path);
        if (symbols && symbols.length > 0) {
          line = `${indent}${node.name}  [${symbols.join(", ")}]`;
        } else {
          line = `${indent}${node.name}`;
        }
      }

      // Check if adding this line would exceed the budget
      const lineChars = line.length + 1; // +1 for newline
      if (charCount + lineChars > REPO_MAP_MAX_CHARS) {
        lines.push(`${indent}... (truncated — ${map.totalFiles} files total)`);
        truncated = true;
        return;
      }

      lines.push(line);
      charCount += lineChars;

      // Recurse into directory children
      if (node.isDir && node.children && node.children.length > 0) {
        walkTree(node.children, depth + 1, indent + "  ");
      }
    }
  }

  walkTree(map.tree, 1, "");

  return lines.join("\n");
}

// ── Behavioral Rules ──────────────────────────────────────────────────────────

const BEHAVIORAL_RULES = `You are an expert coding agent embedded in PunamIDE. You have tools to read files, apply edits, run terminal commands, and search the codebase.

## Environment
- OS: Windows
- Shell: PowerShell (pwsh)
- Use PowerShell syntax for all commands (e.g. Test-Path, Start-Process, Get-Content)
- Do NOT use bash/Linux commands (ls, cat, grep, &&, ||, 2>/dev/null)

## Behavioral Rules
- For NEW files: use \`write_file\` with the complete content in a single call. Never patch an empty or non-existent file.
- For EXISTING files: read first with \`read_file\`, then use \`apply_patch\` for surgical edits.
- After applying a patch: the loop auto-verifies. If verification fails, re-read and retry.
- When unsure which file to edit: use \`search_symbol\` or \`search_codebase\` first.
- State your plan in 1-3 sentences BEFORE calling any tool.
- If a command fails: analyze the error, then retry with a correction.
- Never edit .env, secrets, or lock files unless the user explicitly requests it.
- If a file write is rejected or blocked: STOP. Do not retry. Inform the user.`;
