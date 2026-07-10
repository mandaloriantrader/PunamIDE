/**
 * Mention Resolver — Resolves @mention tags to actual context content.
 * Supports: @file:, @folder:, @codebase, @codebase:<query>, @git, @terminal, @selection, @problems, @errors, @web:<query>, @docs
 *
 * Usage:
 *   const context = await resolveMentions("@file:src/App.tsx fix the bug", {
 *     projectPath: "/my-project",
 *     files: fileEntries,
 *     // ...other sources
 *   });
 *
 * Returns { resolvedPrompt, contextBlocks } where contextBlocks are appended to the prompt.
 */

import { readFile, runTerminalCommand } from "./tauri";
import type { FileEntry } from "./tauri";
import type { ChatMessage } from "../store/aiStore";
import { getProjectFilePath } from "./chatHelpers";
import { searchCodebase, isIndexed } from "./codebaseIndex";

// ── Types ────────────────────────────────────────────────────────────────────

export type MentionType =
  | "@file"
  | "@folder"
  | "@codebase"
  | "@git"
  | "@terminal"
  | "@selection"
  | "@problems"
  | "@errors"
  | "@web"
  | "@docs";

export interface ResolvedMention {
  type: MentionType;
  /** The raw tag text from the prompt, e.g., "@file:src/App.tsx" */
  raw: string;
  /** The resolved value, e.g., "src/App.tsx" */
  value: string;
  /** The actual context content */
  content: string;
  /** Context block label */
  label: string;
}

export interface ResolveResult {
  /** The prompt with mention tags replaced by inline labels */
  cleanPrompt: string;
  /** Resolved context blocks to append */
  contextBlocks: string[];
  /** All resolved mentions for post-processing */
  mentions: ResolvedMention[];
}

export interface MentionSources {
  projectPath: string;
  files: FileEntry[];
  allProjectFiles: string[];
  selectedText: string;
  terminalOutput: string;
  problemsRaw: string;
  gitBranch: string;
  lastMessages?: ChatMessage[];
  /** LSP diagnostics (errors/warnings) — structured for @errors */
  lspDiagnostics?: string;
  /** User's query context for @codebase smart search */
  userQuery?: string;
}

// ── Pattern matching ─────────────────────────────────────────────────────────

const MENTION_PATTERNS = [
  { type: "@file" as const, regex: /@file:([\w./\\-]+(?:\.[\w]+)?)/gi },
  { type: "@folder" as const, regex: /@folder:([\w./\\-]+)/gi },
  { type: "@codebase" as const, regex: /@codebase(?::([\w\s./\\-]+?))?(?=\s|$)/gi },
  { type: "@git" as const, regex: /@git\b/gi },
  { type: "@terminal" as const, regex: /@terminal\b/gi },
  { type: "@selection" as const, regex: /@selection\b/gi },
  { type: "@problems" as const, regex: /@problems\b/gi },
  { type: "@errors" as const, regex: /@errors\b/gi },
  { type: "@web" as const, regex: /@web:([\w\s./\\?&=-]+?)(?=\s{2}|$|\n)/gi },
  { type: "@docs" as const, regex: /@docs:([\w./\\-]+)/gi },
];

/**
 * Parse all mention tags from a prompt string.
 * Returns array of { type, raw, value } objects.
 */
export function parseMentions(prompt: string): Array<{ type: MentionType; raw: string; value: string }> {
  const results: Array<{ type: MentionType; raw: string; value: string }> = [];

  for (const pattern of MENTION_PATTERNS) {
    const matches = prompt.matchAll(pattern.regex);
    for (const match of matches) {
      results.push({
        type: pattern.type,
        raw: match[0],
        value: match[1] || pattern.type.replace("@", ""),
      });
    }
  }

  // Deduplicate by raw tag
  const seen = new Set<string>();
  return results.filter((r) => {
    const key = r.raw.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Get all .md files in a project for @docs autocomplete
 */
export function getDocFiles(files: FileEntry[]): string[] {
  const result: string[] = [];
  function walk(entries: FileEntry[]) {
    for (const e of entries) {
      if (e.name.endsWith(".md")) result.push(e.path);
      if (e.children) walk(e.children);
    }
  }
  walk(files);
  return result;
}

// ── Resolver ─────────────────────────────────────────────────────────────────

export async function resolveMentions(
  prompt: string,
  sources: MentionSources,
): Promise<ResolveResult> {
  const mentions = parseMentions(prompt);
  const resolved: ResolvedMention[] = [];
  const contextBlocks: string[] = [];
  let cleanPrompt = prompt;

  for (const mention of mentions) {
    let content = "";
    let label = "";

    switch (mention.type) {
      case "@file": {
        const filePath = resolveFilePath(mention.value, sources.projectPath, sources.files);
        if (filePath) {
          try {
            content = await readFile(filePath);
            const relative = filePath.replace(sources.projectPath, "").replace(/^[\\/]+/, "");
            label = `[📄 ${relative}]`;
            contextBlocks.push(`--- BEGIN @file: ${relative} ---\n${content}\n--- END @file: ${relative} ---`);
          } catch {
            label = `[⚠ file not found: ${mention.value}]`;
          }
        } else {
          label = `[⚠ file not resolved: ${mention.value}]`;
        }
        break;
      }

      case "@folder": {
        const folderFiles = getFilesInFolder(sources.allProjectFiles, mention.value);
        if (folderFiles.length > 0) {
          let folderContent = "";
          const fileLimit = Math.min(folderFiles.length, 8);
          for (const fp of folderFiles.slice(0, fileLimit)) {
            const fullPath = getProjectFilePath(sources.projectPath, fp);
            try {
              const text = await readFile(fullPath);
              folderContent += `\n=== ${fp} ===\n${text.slice(0, 3000)}\n`;
            } catch {
              // skip unreadable files
            }
          }
          content = folderContent;
          label = `[📁 @folder:${mention.value} (${folderFiles.length} files)]`;
          contextBlocks.push(`--- BEGIN @folder: ${mention.value} ---${folderContent}\n--- END @folder: ${mention.value} ---`);
        } else {
          label = `[⚠ folder not found: ${mention.value}]`;
        }
        break;
      }

      case "@codebase": {
        // Smart codebase search — use TF-IDF index if available
        const searchQuery = mention.value || sources.userQuery || "";
        if (isIndexed() && searchQuery) {
          const hits = searchCodebase(searchQuery, 8);
          if (hits.length > 0) {
            const snippets = hits.map((h) =>
              `=== ${h.path} (L${h.startLine}-${h.endLine}, relevance: ${(h.score * 100).toFixed(0)}%) ===\n${h.snippet}`
            ).join("\n\n");
            content = `Codebase search for "${searchQuery}" — ${hits.length} relevant snippets:\n\n${snippets}`;
            label = `[🏗️ @codebase:${searchQuery} (${hits.length} hits)]`;
            contextBlocks.push(`--- BEGIN @codebase search: "${searchQuery}" ---\n${content}\n--- END @codebase ---`);
          } else {
            content = `No results found for "${searchQuery}" in the codebase index.`;
            label = `[🏗️ @codebase (no matches)]`;
            contextBlocks.push(`--- BEGIN @codebase ---\n${content}\nProject has ${sources.allProjectFiles.length} files.\n--- END @codebase ---`);
          }
        } else if (isIndexed()) {
          // No query provided but index exists — give file tree + summary
          const topFiles = sources.allProjectFiles.slice(0, 30).join("\n  ");
          content = `Project has ${sources.allProjectFiles.length} files across ${countFolders(sources.files)} folders.\nTop files:\n  ${topFiles}`;
          label = "[🏗️ @codebase (overview)]";
          contextBlocks.push(`--- BEGIN @codebase ---\n${content}\n--- END @codebase ---`);
        } else {
          // Index not built — provide basic overview
          const topFiles = sources.allProjectFiles.slice(0, 20).join("\n  ");
          content = `Project has ${sources.allProjectFiles.length} files across ${countFolders(sources.files)} folders.\nFile index not built yet.\nFiles:\n  ${topFiles}`;
          label = "[🏗️ @codebase]";
          contextBlocks.push(`--- BEGIN @codebase ---\n${content}\n--- END @codebase ---`);
        }
        break;
      }

      case "@git": {
        try {
          const status = await runTerminalCommand("git status --short", sources.projectPath);
          const branch = sources.gitBranch || "";
          const log = await runTerminalCommand('git log --oneline -5', sources.projectPath);
          content = `Git branch: ${branch}\nRecent commits:\n${log.stdout}\nStatus:\n${status.stdout}`;
          label = `[🐙 @git (branch: ${branch || "unknown"})]`;
          contextBlocks.push(`--- BEGIN @git ---\n${content}\n--- END @git ---`);
        } catch {
          label = "[⚠ git not available]";
        }
        break;
      }

      case "@terminal": {
        content = sources.terminalOutput || "(no terminal output)";
        label = "[🖥️ @terminal]";
        if (content.length > 3) {
          contextBlocks.push(`--- BEGIN @terminal ---\n${content.slice(-4000)}\n--- END @terminal ---`);
        }
        break;
      }

      case "@selection": {
        content = sources.selectedText || "(no text selected)";
        label = "[✂️ @selection]";
        if (content.length > 3) {
          contextBlocks.push(`--- BEGIN @selection ---\n${content}\n--- END @selection ---`);
        }
        break;
      }

      case "@problems": {
        content = sources.problemsRaw || "(no problems)";
        label = "[⚠️ @problems]";
        if (content.length > 3) {
          contextBlocks.push(`--- BEGIN @problems ---\n${content}\n--- END @problems ---`);
        }
        break;
      }

      case "@docs": {
        const docFiles = getDocFiles(sources.files);
        const match = docFiles.find((f) =>
          f.toLowerCase().includes(mention.value.toLowerCase()),
        );
        if (match) {
          const fullPath = getProjectFilePath(sources.projectPath, match);
          try {
            content = await readFile(fullPath);
            const relative = match.replace(sources.projectPath, "").replace(/^[\\/]+/, "");
            label = `[📖 @docs:${relative}]`;
            contextBlocks.push(`--- BEGIN @docs: ${relative} ---\n${content}\n--- END @docs: ${relative} ---`);
          } catch {
            label = `[⚠ doc not readable: ${mention.value}]`;
          }
        } else {
          label = `[⚠ doc not found: ${mention.value}]`;
        }
        break;
      }

      case "@errors": {
        // LSP diagnostics — focused on errors (not just all problems)
        const diagnostics = sources.lspDiagnostics || sources.problemsRaw || "(no errors detected)";
        content = diagnostics;
        label = "[🔴 @errors]";
        if (diagnostics.length > 3 && diagnostics !== "(no errors detected)") {
          contextBlocks.push(`--- BEGIN @errors (LSP diagnostics) ---\n${diagnostics}\n--- END @errors ---`);
        }
        break;
      }

      case "@web": {
        // Web search — execute via DuckDuckGo instant answer API through terminal
        const webQuery = mention.value || "";
        if (webQuery) {
          try {
            const encoded = encodeURIComponent(webQuery);
            const result = await runTerminalCommand(
              `curl -sL "https://api.duckduckgo.com/?q=${encoded}&format=json&no_html=1"`,
              sources.projectPath,
            );
            if (result.exit_code === 0 && result.stdout.trim()) {
              try {
                const data = JSON.parse(result.stdout);
                const abstract_ = data.AbstractText || data.Abstract || "";
                const answer = data.Answer || "";
                const relatedTopics = (data.RelatedTopics || [])
                  .slice(0, 5)
                  .map((t: { Text?: string }) => t.Text || "")
                  .filter(Boolean)
                  .join("\n  - ");
                content = [
                  answer && `Answer: ${answer}`,
                  abstract_ && `Summary: ${abstract_}`,
                  relatedTopics && `Related:\n  - ${relatedTopics}`,
                ].filter(Boolean).join("\n\n");

                if (!content.trim()) {
                  content = `Web search for "${webQuery}" returned no immediate answers. The user may need to search manually.`;
                }
              } catch {
                content = `Web search for "${webQuery}" — response could not be parsed.`;
              }
            } else {
              content = `Web search for "${webQuery}" — could not reach search API.`;
            }
            label = `[🌐 @web:${webQuery}]`;
            contextBlocks.push(`--- BEGIN @web: "${webQuery}" ---\n${content}\n--- END @web ---`);
          } catch {
            label = `[⚠ web search failed: ${webQuery}]`;
          }
        } else {
          label = "[⚠ @web requires a search query, e.g., @web:react hooks]";
        }
        break;
      }
    }

    resolved.push({ ...mention, content, label });
    // Replace the raw tag in the prompt with an inline label
    cleanPrompt = cleanPrompt.replace(mention.raw, label);
  }

  return { cleanPrompt, contextBlocks, mentions: resolved };
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function resolveFilePath(
  partial: string,
  projectPath: string,
  files: FileEntry[],
): string | null {
  const lower = partial.replace(/\\/g, "/").toLowerCase();

  // Try exact match first
  const exact = getProjectFilePath(projectPath, partial);
  if (files.some(f => f.path.replace(/\\/g, "/").toLowerCase() === exact.replace(/\\/g, "/").toLowerCase())) {
    return exact;
  }

  // Try matching by filename ending
  function search(entries: FileEntry[]): string | null {
    for (const e of entries) {
      const normalPath = e.path.replace(/\\/g, "/").toLowerCase();
      if (normalPath.endsWith(lower) || normalPath.includes(lower)) {
        return getProjectFilePath(projectPath, e.path);
      }
      if (e.children) {
        const found = search(e.children);
        if (found) return found;
      }
    }
    return null;
  }

  return search(files);
}

function countFolders(files: FileEntry[]): number {
  let count = 0;
  function walk(entries: FileEntry[]) {
    for (const e of entries) {
      if (e.is_dir) count++;
      if (e.children) walk(e.children);
    }
  }
  walk(files);
  return count;
}

function getFilesInFolder(allFiles: string[], folderName: string): string[] {
  const lower = folderName.replace(/\\/g, "/").toLowerCase();
  return allFiles
    .filter((f) => f.replace(/\\/g, "/").toLowerCase().includes("/" + lower + "/"))
    .slice(0, 20);
}

// ── Autocomplete suggestion builder ───────────────────────────────────────────

export interface MentionSuggestion {
  type: MentionType;
  label: string;       // e.g., "@file:src/App.tsx"
  description: string; // e.g., "Read src/App.tsx"
  insertText: string;  // text to insert into the input
}

/**
 * Build autocomplete suggestions based on the current @mention prefix being typed.
 * e.g., if user types "@file:sr", return files matching "sr".
 */
export function buildSuggestions(
  partial: string,
  sources: MentionSources,
): MentionSuggestion[] {
  // Parse what the user is typing: e.g., "@file:sr" or "@fol"
  const match = partial.match(/^@(\w+):?(.*)/i);
  if (!match) return [];

  const cmd = match[1].toLowerCase();
  const query = (match[2] || "").toLowerCase();

  // Command auto-complete
  const allCommands: { prefix: string; type: MentionType; desc: string }[] = [
    { prefix: "@file:", type: "@file", desc: "File contents" },
    { prefix: "@folder:", type: "@folder", desc: "All files in folder" },
    { prefix: "@codebase", type: "@codebase", desc: "Smart codebase search (TF-IDF)" },
    { prefix: "@git", type: "@git", desc: "Git status & history" },
    { prefix: "@terminal", type: "@terminal", desc: "Recent terminal output" },
    { prefix: "@selection", type: "@selection", desc: "Current selection" },
    { prefix: "@problems", type: "@problems", desc: "All problems/diagnostics" },
    { prefix: "@errors", type: "@errors", desc: "LSP errors only" },
    { prefix: "@web:", type: "@web", desc: "Web search (DuckDuckGo)" },
    { prefix: "@docs:", type: "@docs", desc: "Documentation files" },
  ];

  // If no command typed yet (just "@"), show all command options
  if (!cmd || cmd.length < 1) {
    return allCommands.map((c) => ({
      type: c.type,
      label: c.prefix + (c.prefix.endsWith(":") ? "" : ""),
      description: c.desc,
      insertText: c.prefix,
    }));
  }

  // Match the command
  const matchedCommand = allCommands.find((c) => c.prefix.startsWith("@" + cmd));
  if (!matchedCommand) {
    // Fuzzy match
    return allCommands
      .filter((c) => c.prefix.includes(cmd))
      .map((c) => ({
        type: c.type,
        label: c.prefix,
        description: c.desc,
        insertText: c.prefix,
      }));
  }

  // If it's @file: or @docs: with a query, suggest actual files
  if ((matchedCommand.type === "@file" || matchedCommand.type === "@docs") && query) {
    const allFiles =
      matchedCommand.type === "@docs"
        ? getDocFiles(sources.files)
        : sources.allProjectFiles;

    const matching = allFiles
      .filter((f) => f.toLowerCase().includes(query))
      .slice(0, 8);

    if (matching.length > 0) {
      return matching.map((f) => ({
        type: matchedCommand.type,
        label: `@${matchedCommand.type.slice(1)}:${f}`,
        description: f,
        insertText: `@${matchedCommand.type.slice(1)}:${f}`,
      }));
    }
  }

  // If it's @folder: with a query, suggest folders
  if (matchedCommand.type === "@folder" && query) {
    const folders = new Set<string>();
    for (const f of sources.allProjectFiles) {
      const parts = f.split(/[/\\]/);
      for (let i = 1; i <= parts.length - 1; i++) {
        folders.add(parts.slice(0, i).join("/"));
      }
    }

    const matching = [...folders]
      .filter((f) => f.toLowerCase().includes(query))
      .slice(0, 8);

    if (matching.length > 0) {
      return matching.map((f) => ({
        type: "@folder",
        label: `@folder:${f}`,
        description: `${f}/ (folder)`,
        insertText: `@folder:${f}`,
      }));
    }
  }

  // Return the command itself as the only suggestion
  return [
    {
      type: matchedCommand.type,
      label: matchedCommand.prefix,
      description: matchedCommand.desc,
      insertText: matchedCommand.prefix,
    },
  ];
}