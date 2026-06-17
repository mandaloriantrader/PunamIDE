// src/utils/agentTools.ts
//
// Phase 1 — Agent Tool-Calling System
//
// Exports:
//   AGENT_TOOL_DEFINITIONS  — Anthropic-format tool schemas (also used for
//                             Gemini and JSON-fallback adapters)
//   executeAgentTool()      — routes a tool call to the correct Tauri command
//   buildToolSystemPrompt() — injects tool-calling rules into system prompt
//                             for providers that don't support native tools
//   isNativeToolProvider()  — returns true for Anthropic / Gemini providers
//   parseJsonToolCall()     — extracts a tool call from a JSON-fallback reply

import { invoke } from "@tauri-apps/api/core";
import type { AIProviderConfig } from "./providers";

// ── Tool definitions (Anthropic schema) ──────────────────────────────────────

export const AGENT_TOOL_DEFINITIONS = [
  {
    name: "read_lines",
    description:
      "Read a specific range of lines from a file. " +
      "Use for questions about specific lines, functions, or small sections. " +
      "Prefer this over read_file unless you need the whole file.",
    input_schema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Relative path from project root (e.g. src/index.ts)",
        },
        start_line: {
          type: "number",
          description: "First line to read, 1-indexed",
        },
        end_line: {
          type: "number",
          description:
            "Last line to read, 1-indexed. Pass 0 to read to end of file.",
        },
      },
      required: ["path", "start_line", "end_line"],
    },
  },
  {
    name: "read_file",
    description:
      "Read the entire content of a file. " +
      "Use only for full-file refactors, when you need global context, " +
      "or when the user explicitly asks to see the whole file. " +
      "For small questions use read_lines instead.",
    input_schema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Relative path from project root",
        },
      },
      required: ["path"],
    },
  },
  {
    name: "search_in_project",
    description:
      "Search for a string, symbol, or pattern across all project files. " +
      "Use before reading unknown files to locate where something is defined.",
    input_schema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Text to search for (case-insensitive)",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "list_files",
    description:
      "Get the project file index — a flat list of all files in the project. " +
      "Use to understand project structure before diving into files.",
    input_schema: {
      type: "object",
      properties: {},
      required: [],
    },
  },
  {
    name: "apply_patch",
    description:
      "Replace a range of lines in a file with new content. " +
      "Use for targeted edits. Preserves all lines outside the range exactly. " +
      "For creating new files or full rewrites, use write_file instead.",
    input_schema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Relative path from project root",
        },
        start_line: {
          type: "number",
          description: "First line to replace, 1-indexed",
        },
        end_line: {
          type: "number",
          description: "Last line to replace, 1-indexed (inclusive)",
        },
        new_content: {
          type: "string",
          description:
            "Replacement text. May be multiple lines separated by \\n. " +
            "Can be more or fewer lines than the range being replaced.",
        },
      },
      required: ["path", "start_line", "end_line", "new_content"],
    },
  },
  {
    name: "write_file",
    description:
      "Write complete content to a file (creates or overwrites). " +
      "Use for creating new files or full rewrites. " +
      "For partial edits use apply_patch instead.",
    input_schema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Relative path from project root",
        },
        content: {
          type: "string",
          description: "Complete file content to write",
        },
      },
      required: ["path", "content"],
    },
  },
  {
    name: "run_command",
    description:
      "Run a terminal command in the project directory. " +
      "Use for build, install, test, or lint commands. " +
      "Do not use for destructive OS commands (rm -rf, format, etc.).",
    input_schema: {
      type: "object",
      properties: {
        command: {
          type: "string",
          description: "Shell command to run",
        },
      },
      required: ["command"],
    },
  },
  {
    name: "symbol_lookup",
    description:
      "Find where a function, class, struct, type, or interface is defined across the project. " +
      "Returns file path, line number, kind (function/class/struct/etc.), and signature. " +
      "Use BEFORE editing to locate definitions. Case-insensitive matching.",
    input_schema: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description: "Symbol name to look up (e.g. 'handleSubmit', 'UserService', 'AppConfig')",
        },
      },
      required: ["name"],
    },
  },
  {
    name: "find_callers",
    description:
      "Find all functions that call a given function. " +
      "Returns caller name, file path, and line number for each call site. " +
      "Use to understand impact before modifying a function signature.",
    input_schema: {
      type: "object",
      properties: {
        function_name: {
          type: "string",
          description: "Name of the function to find callers for",
        },
      },
      required: ["function_name"],
    },
  },
  {
    name: "find_callees",
    description:
      "Find all functions called by a given function. " +
      "Returns callee name, call expression, and line number. " +
      "Use to trace call chains and understand dependencies before refactoring.",
    input_schema: {
      type: "object",
      properties: {
        function_name: {
          type: "string",
          description: "Name of the function to find callees for",
        },
      },
      required: ["function_name"],
    },
  },
  {
    name: "semantic_search",
    description:
      "Search for code by meaning, not just text. " +
      "Find code snippets semantically similar to a natural language description. " +
      "Use when you need to find related logic, similar implementations, or " +
      "code relevant to a concept (e.g. 'authentication flow', 'error handling').",
    input_schema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Natural language description of what you're looking for (e.g. 'user authentication logic', 'database connection setup')",
        },
        top_k: {
          type: "number",
          description: "Number of results to return (default: 5, max: 10)",
        },
      },
      required: ["query"],
    },
  },
] as const;

export type AgentToolName = typeof AGENT_TOOL_DEFINITIONS[number]["name"];

const READ_ONLY_AGENT_TOOLS: AgentToolName[] = [
  "list_files",
  "search_in_project",
  "read_file",
  "read_lines",
  "symbol_lookup",
  "find_callers",
  "find_callees",
  "semantic_search",
];

const GUARDED_ACTION_AGENT_TOOLS: AgentToolName[] = [
  "run_command",
  "apply_patch",
  "write_file",
];

export function buildInternalToolInventoryPrompt(): string {
  const descriptions = new Map(
    AGENT_TOOL_DEFINITIONS.map((tool) => [
      tool.name,
      tool.description.split(".")[0],
    ])
  );
  const formatTools = (tools: AgentToolName[]) =>
    tools
      .map((toolName) => `- ${toolName}: ${descriptions.get(toolName) || "Internal agent tool"}.`)
      .join("\n");

  return [
    "INTERNAL AGENT TOOL INVENTORY:",
    "Internal agent tools are not terminal commands and must not be described as PowerShell/Get-ChildItem/dir/ls unless run_command actually ran such a command.",
    "",
    "Read-only workspace tools:",
    formatTools(READ_ONLY_AGENT_TOOLS),
    "",
    "Guarded action tools:",
    formatTools(GUARDED_ACTION_AGENT_TOOLS),
    "",
    "When asked what tools are available, report both read-only workspace tools and guarded action tools. When asked about safe workspace exploration, prefer the read-only tools.",
  ].join("\n");
}

// ── Tool call / result types ──────────────────────────────────────────────────

export interface ToolCall {
  id: string;
  name: AgentToolName;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  input: Record<string, any>;
}

export interface ToolResult {
  tool_use_id: string;
  content: string; // always a string; JSON-stringify complex results
  is_error: boolean;
}

function firstDefined(input: Record<string, any>, keys: string[]) {
  for (const key of keys) {
    if (input[key] !== undefined && input[key] !== null && input[key] !== "") {
      return input[key];
    }
  }
  return undefined;
}

function requireField(tool: AgentToolName, input: Record<string, any>, field: string): void {
  if (input[field] === undefined || input[field] === null || input[field] === "") {
    throw new Error(`${tool} requires "${field}".`);
  }
}

export function normalizeAgentToolCall(
  toolCall: ToolCall | ParsedJsonToolCall
): ToolCall | ParsedJsonToolCall {
  const name = "tool" in toolCall ? toolCall.tool : toolCall.name;
  const input = { ...(toolCall.input || {}) };

  const assignAlias = (target: string, aliases: string[]) => {
    if (input[target] === undefined || input[target] === null || input[target] === "") {
      const value = firstDefined(input, aliases);
      if (value !== undefined) input[target] = value;
    }
    for (const alias of aliases) {
      if (alias !== target) delete input[alias];
    }
  };

  switch (name) {
    case "read_file":
      assignAlias("path", ["file", "filename", "filepath", "filePath"]);
      requireField(name, input, "path");
      break;
    case "read_lines":
      assignAlias("path", ["file", "filename", "filepath", "filePath"]);
      assignAlias("start_line", ["start", "from", "line_start", "startLine"]);
      assignAlias("end_line", ["end", "to", "line_end", "endLine"]);
      requireField(name, input, "path");
      input.start_line = Number(input.start_line ?? 1);
      input.end_line = Number(input.end_line ?? 0);
      break;
    case "search_in_project":
      assignAlias("query", ["pattern", "term", "text", "search", "keyword"]);
      requireField(name, input, "query");
      break;
    case "apply_patch":
      assignAlias("path", ["file", "filename", "filepath", "filePath"]);
      assignAlias("start_line", ["start", "from", "line_start", "startLine"]);
      assignAlias("end_line", ["end", "to", "line_end", "endLine"]);
      requireField(name, input, "path");
      requireField(name, input, "new_content");
      input.start_line = Number(input.start_line);
      input.end_line = Number(input.end_line);
      break;
    case "write_file":
      assignAlias("path", ["file", "filename", "filepath", "filePath"]);
      requireField(name, input, "path");
      requireField(name, input, "content");
      break;
    case "run_command":
      assignAlias("command", ["cmd", "shell", "script"]);
      requireField(name, input, "command");
      break;
    case "symbol_lookup":
      assignAlias("name", ["symbol", "symbolName", "symbol_name", "identifier", "function_name", "className"]);
      requireField(name, input, "name");
      break;
    case "find_callers":
      assignAlias("function_name", ["name", "functionName", "fn_name", "symbol", "callee"]);
      requireField(name, input, "function_name");
      break;
    case "find_callees":
      assignAlias("function_name", ["name", "functionName", "fn_name", "symbol", "caller"]);
      requireField(name, input, "function_name");
      break;
    case "semantic_search":
      assignAlias("query", ["search", "description", "text", "meaning"]);
      requireField(name, input, "query");
      if (input.top_k !== undefined) input.top_k = Math.min(Number(input.top_k) || 5, 10);
      break;
  }

  return { ...toolCall, input };
}
// ── Provider detection ────────────────────────────────────────────────────────

/**
 * Returns true for providers that support native tool/function calling.
 * Anthropic (type === "anthropic") and Gemini (type === "gemini") are
 * handled natively. Everything else (openai-compatible, ollama, etc.)
 * falls back to JSON prompt injection.
 */
export function isNativeToolProvider(provider: AIProviderConfig): boolean {
  return provider.type === "anthropic" || provider.type === "gemini";
}

// ── JSON fallback tool system prompt ─────────────────────────────────────────

/**
 * Appended to the system prompt for non-native-tool providers.
 * Instructs the model to emit tool calls as a JSON block that we parse.
 */
export function buildToolSystemPrompt(): string {
  const toolList = AGENT_TOOL_DEFINITIONS.map(
    (t) => `- ${t.name}: ${t.description.split(".")[0]}.`
  ).join("\n");

  return `
## TOOL CALLING (required for this task)

You have access to the following tools:
${toolList}

To call a tool, output a JSON block — and ONLY a JSON block — like this:
\`\`\`json
{
  "tool": "<tool_name>",
  "input": { <arguments matching the tool's schema> }
}
\`\`\`

Rules:
- Internal agent tools are not terminal commands. Do not translate list_files to Get-ChildItem, dir, ls, or any shell command.
- If the user explicitly names an internal tool such as list_files, read_file, read_lines, or search_in_project, call that exact tool.
- Call ONE tool at a time.
- After receiving the tool result, continue reasoning or call another tool.
- When you have a final answer, output plain text (no JSON block).
- Never fabricate file contents — always call read_lines or read_file first.
- Use search_in_project before reading a file whose path you are unsure of.
- Never use apply_patch or write_file without first reading the target lines.
`.trim();
}

// ── JSON tool call parser (for fallback providers) ────────────────────────────

export interface ParsedJsonToolCall {
  tool: AgentToolName;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  input: Record<string, any>;
}

/**
 * Extract a tool call from a model response that used JSON fallback format.
 * Returns null if the response is a final text answer (no JSON block found).
 */
export function parseJsonToolCall(
  responseText: string
): ParsedJsonToolCall | null {
  // Match ```json ... ``` block
  const match = responseText.match(/```json\s*([\s\S]*?)```/);
  if (!match) return null;

  try {
    const parsed = JSON.parse(match[1].trim());
    if (
      typeof parsed.tool === "string" &&
      typeof parsed.input === "object" &&
      parsed.input !== null
    ) {
      return parsed as ParsedJsonToolCall;
    }
  } catch {
    // Not valid JSON — treat as plain text answer
  }
  return null;
}

// ── Tool executor ─────────────────────────────────────────────────────────────

/**
 * Execute a single tool call by routing to the appropriate Tauri command.
 * projectPath is the absolute project root (used for path resolution on
 * commands that need an absolute path).
 */
export async function executeAgentTool(
  toolCall: ToolCall | ParsedJsonToolCall,
  projectPath: string
): Promise<ToolResult> {
  const normalizedToolCall = normalizeAgentToolCall(toolCall);
  const name = "tool" in normalizedToolCall ? normalizedToolCall.tool : normalizedToolCall.name;
  const input = normalizedToolCall.input;
  const id = "id" in normalizedToolCall ? normalizedToolCall.id : `fallback-${Date.now()}`;

  try {
    let resultText: string;

    if (name === "run_command") {
      const command = String(input.command || "");
      const validation = await invoke<{
        risk_level: "safe" | "needs_approval" | "blocked";
        sanitized_command: string;
        feedback_message: string;
      }>("inspect_command", { command, workspacePath: projectPath });
      if (validation.risk_level === "blocked") {
        return {
          tool_use_id: id,
          content: `Command blocked by safety policy: ${validation.feedback_message}`,
          is_error: true,
        };
      }
      const approved = window.confirm(
        `Punam agent wants to run:\n\n${validation.sanitized_command}\n\n${validation.feedback_message}\n\nAllow?`
      );
      if (!approved) {
        return { tool_use_id: id, content: "Command rejected by user.", is_error: true };
      }
      input.command = validation.sanitized_command;
    } else if (name === "apply_patch") {
      const approved = window.confirm(
        `Punam agent wants to modify:\n\n${String(input.path)}\nLines ${String(input.start_line)}-${String(input.end_line)}\n\nAllow this patch?`
      );
      if (!approved) {
        return { tool_use_id: id, content: "Patch rejected by user.", is_error: true };
      }
    } else if (name === "write_file") {
      const approved = window.confirm(
        `Punam agent wants to create or overwrite:\n\n${String(input.path)}\n\nAllow this file write?`
      );
      if (!approved) {
        return { tool_use_id: id, content: "File write rejected by user.", is_error: true };
      }
    }

    switch (name) {
      // ── read_lines (new Rust command) ──────────────────────────────────────
      case "read_lines": {
        const result = await invoke<{
          path: string;
          start_line: number;
          end_line: number;
          total_lines: number;
          content: string;
        }>("read_lines", {
          path: input.path,
          startLine: Number(input.start_line ?? 1),
          endLine: Number(input.end_line ?? 0),
        });
        resultText =
          `File: ${result.path} (${result.total_lines} lines total)\n` +
          `Lines ${result.start_line}–${result.end_line}:\n${result.content}`;
        break;
      }

      // ── read_file (existing Rust command) ─────────────────────────────────
      case "read_file": {
        const content = await invoke<string>("read_file", { path: input.path });
        // Return with line numbers so the model can reference them
        const numbered = content
          .split("\n")
          .map((line, i) => `${String(i + 1).padStart(4, " ")} | ${line}`)
          .join("\n");
        resultText = `File: ${input.path}\n${numbered}`;
        break;
      }

      // ── search_in_project (existing Rust command) ─────────────────────────
      case "search_in_project": {
        const results = await invoke<
          Array<{ path: string; line: number; column: number; preview: string }>
        >("search_project", { query: input.query });
        if (results.length === 0) {
          resultText = `No results found for: ${input.query}`;
        } else {
          resultText =
            `Found ${results.length} result(s) for "${input.query}":\n` +
            results
              .slice(0, 30) // cap at 30 to avoid token flood
              .map((r) => `  ${r.path}:${r.line}  ${r.preview.trim()}`)
              .join("\n");
        }
        break;
      }

      // ── list_files (existing Rust command) ────────────────────────────────
      case "list_files": {
        const index = await invoke<
          Array<{ path: string; name: string; is_dir: boolean }>
        >("refresh_project_index");
        const topLevel = index
          .filter((e) => !e.path.includes("/") && !e.path.includes("\\"))
          .sort((a, b) => Number(b.is_dir) - Number(a.is_dir) || a.path.localeCompare(b.path));
        const topLevelText = topLevel.length > 0
          ? topLevel.map((e) => `${e.is_dir ? "DIR " : "FILE"} ${e.path}`).join("\n")
          : "No top-level entries found.";
        const files = index
          .filter((e) => !e.is_dir)
          .map((e) => e.path)
          .slice(0, 200); // cap for token safety
        resultText =
          `Project root: ${projectPath}\n` +
          `Top-level entries:\n${topLevelText}\n\n` +
          `Project files (${files.length} shown of ${index.filter((e) => !e.is_dir).length}):\n` +
          files.join("\n");
        break;
      }

      // ── apply_patch (new Rust command) ────────────────────────────────────
      case "apply_patch": {
        const result = await invoke<{
          path: string;
          lines_replaced: number;
          new_total_lines: number;
        }>("apply_patch", {
          path: input.path,
          hunk: {
            start_line: Number(input.start_line),
            end_line: Number(input.end_line),
            new_content: String(input.new_content),
          },
        });
        resultText =
          `Patch applied to ${result.path}. ` +
          `Replaced ${result.lines_replaced} line(s). ` +
          `File now has ${result.new_total_lines} lines.`;
        break;
      }

      // ── write_file (existing Rust command) ────────────────────────────────
      case "write_file": {
        await invoke("write_file", {
          path: input.path,
          content: String(input.content),
        });
        resultText = `File written: ${input.path}`;
        break;
      }

      // ── run_command (existing Rust command) ───────────────────────────────
      case "run_command": {
        const result = await invoke<{
          stdout: string;
          stderr: string;
          exit_code: number;
        }>("run_terminal_command", {
          command: String(input.command),
          cwd: projectPath,
        });
        resultText =
          `Command: ${input.command}\n` +
          `Exit code: ${result.exit_code}\n` +
          (result.stdout ? `stdout:\n${result.stdout.slice(0, 3000)}` : "") +
          (result.stderr ? `\nstderr:\n${result.stderr.slice(0, 1000)}` : "");
        break;
      }

      // ── symbol_lookup (AST-based symbol index) ───────────────────────────
      case "symbol_lookup": {
        const result = await invoke<{
          query: string;
          matches: Array<{
            name: string;
            file: string;
            line: number;
            kind: string;
            signature: string;
          }>;
          total_count: number;
          query_time_ms: number;
        }>("symbol_lookup", { name: String(input.name) });

        if (result.matches.length === 0) {
          // Fallback: try tree-sitter extraction on likely files via search
          try {
            const { extractSymbolsFromFile } = await import("../services/intelligence/TreeSitterSymbolExtractor");
            const searchResults = await invoke<
              Array<{ path: string; line: number; column: number; preview: string }>
            >("search_project", { query: String(input.name) });
            const uniqueFiles = [...new Set(searchResults.slice(0, 5).map(r => r.path))];
            const tsMatches: Array<{ name: string; file: string; line: number; kind: string; signature: string }> = [];
            for (const filePath of uniqueFiles) {
              try {
                const content = await invoke<string>("read_file", { path: filePath });
                const symbols = await extractSymbolsFromFile(content, filePath);
                if (symbols) {
                  const matches = symbols.filter(s => s.name.toLowerCase() === input.name.toLowerCase());
                  tsMatches.push(...matches);
                }
              } catch { /* skip */ }
            }
            if (tsMatches.length > 0) {
              const entries = tsMatches.slice(0, 20).map(
                (m) => `  ${m.kind.padEnd(10)} ${m.file}:${m.line}  ${m.signature}`
              );
              resultText =
                `Found ${tsMatches.length} definition(s) for "${input.name}" (tree-sitter fallback):\n` +
                entries.join("\n");
              break;
            }
          } catch { /* tree-sitter unavailable, fall through */ }
          resultText = `No definitions found for symbol: "${input.name}"`;
        } else {
          const entries = result.matches.slice(0, 20).map(
            (m) => `  ${m.kind.padEnd(10)} ${m.file}:${m.line}  ${m.signature}`
          );
          resultText =
            `Found ${result.total_count} definition(s) for "${result.query}" (${result.query_time_ms}ms):\n` +
            entries.join("\n");
        }
        break;
      }

      // ── find_callers (call graph: who calls this function?) ───────────────
      case "find_callers": {
        const result = await invoke<{
          function_name: string;
          callers: Array<{
            caller: string;
            caller_file: string;
            call_line: number;
            callee: string;
            call_expression: string;
          }>;
          total_callers: number;
          query_time_ms: number;
        }>("callgraph_lookup", { functionName: String(input.function_name) });

        if (result.callers.length === 0) {
          resultText = `No callers found for function: "${input.function_name}".\nThis may mean: (1) function is unused, (2) only called dynamically, or (3) call graph needs rebuilding.`;
        } else {
          const entries = result.callers.slice(0, 25).map(
            (c) => `  ${c.caller_file}:${c.call_line}  ${c.caller}() → ${c.call_expression}`
          );
          resultText =
            `Found ${result.total_callers} caller(s) of "${result.function_name}" (${result.query_time_ms}ms):\n` +
            entries.join("\n");
        }
        break;
      }

      // ── find_callees (call graph: what does this function call?) ──────────
      case "find_callees": {
        const result = await invoke<{
          function_name: string;
          callees: Array<{
            caller: string;
            caller_file: string;
            call_line: number;
            callee: string;
            call_expression: string;
          }>;
          total_callees: number;
          query_time_ms: number;
        }>("callgraph_callees", { functionName: String(input.function_name) });

        if (result.callees.length === 0) {
          resultText = `No callees found for function: "${input.function_name}".\nThis may mean: (1) function is a leaf node, (2) only calls external/built-in functions, or (3) call graph needs rebuilding.`;
        } else {
          const entries = result.callees.slice(0, 25).map(
            (c) => `  ${c.caller_file}:${c.call_line}  → ${c.call_expression}`
          );
          resultText =
            `Found ${result.total_callees} callee(s) of "${result.function_name}" (${result.query_time_ms}ms):\n` +
            entries.join("\n");
        }
        break;
      }

      // ── semantic_search (embedding-based code search by meaning) ──────────
      case "semantic_search": {
        const { semanticCodeSearch } = await import("../services/intelligence/EmbeddingOrchestrator");
        const topK = Math.min(Number(input.top_k) || 5, 10);
        const searchResult = await semanticCodeSearch(String(input.query), topK);

        if (!searchResult || searchResult.hits.length === 0) {
          resultText = `No semantic search results for: "${input.query}".\nThis may mean: (1) embedding index is not built yet, (2) no similar code exists, or (3) run the project once to build the index.`;
        } else {
          const entries = searchResult.hits.map(
            (hit) => `  [${hit.score.toFixed(3)}] ${hit.file_path}:${hit.start_line}-${hit.end_line} (${hit.chunk_type}: ${hit.name})\n         ${hit.chunk_text.slice(0, 120).replace(/\n/g, " ")}`
          );
          resultText =
            `Semantic search for "${input.query}" — ${searchResult.hits.length} result(s) (${searchResult.query_time_ms}ms):\n` +
            entries.join("\n");
        }
        break;
      }

      default:
        return {
          tool_use_id: id,
          content: `Unknown tool: ${name}`,
          is_error: true,
        };
    }

    return { tool_use_id: id, content: resultText, is_error: false };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      tool_use_id: id,
      content: `Tool error (${name}): ${message}`,
      is_error: true,
    };
  }
}
