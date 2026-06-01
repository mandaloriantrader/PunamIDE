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
] as const;

export type AgentToolName = typeof AGENT_TOOL_DEFINITIONS[number]["name"];

const READ_ONLY_AGENT_TOOLS: AgentToolName[] = [
  "list_files",
  "search_in_project",
  "read_file",
  "read_lines",
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
  const name = "tool" in toolCall ? toolCall.tool : toolCall.name;
  const input = toolCall.input;
  const id = "id" in toolCall ? toolCall.id : `fallback-${Date.now()}`;

  try {
    let resultText: string;

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
