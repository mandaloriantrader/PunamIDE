/**
 * JSON-Mode Tool Loop for PunamIDE
 * 
 * Universal tool calling that works with ANY provider (Gemini, OpenAI, Claude, etc.)
 * No native function calling API — just prompt engineering + JSON parsing.
 * 
 * Flow:
 *   1. System prompt tells model it has tools, output JSON to call them
 *   2. Model outputs ```json {"tool": "read_lines", ...} ```
 *   3. We parse, execute locally, feed result back
 *   4. Model outputs final text answer
 *   5. Done. ~500 tokens instead of 10k.
 */

import { invoke } from "@tauri-apps/api/core";
import type { AIProviderConfig, AIResponse } from "./providers";
import { sendToProviderStreaming } from "./providers";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface ToolLoopResult {
  text: string;
  success: boolean;
  error?: string;
  rounds: number;
  toolsCalled: string[];
  tokensSaved: number; // estimated vs full-context
}

interface ToolCall {
  tool: string;
  input: Record<string, unknown>;
}

// ── Constants ─────────────────────────────────────────────────────────────────

const MAX_ROUNDS = 5;

// ── Tool Definitions (injected into system prompt) ────────────────────────────

const TOOL_INSTRUCTIONS = `
## AVAILABLE TOOLS

You have access to these tools to gather information before answering. Call them by outputting a JSON block:

\`\`\`json
{"tool": "tool_name", "input": {parameters}}
\`\`\`

### Tools:

1. **read_lines** — Read specific lines from a file
   Input: {"path": "relative/path.py", "start": 1, "end": 50}
   Returns: The content of those lines with line numbers

2. **search_project** — Search for text across all project files
   Input: {"query": "search term"}
   Returns: Matching files, line numbers, and previews

3. **list_files** — List all files in the project
   Input: {}
   Returns: File tree

4. **read_file** — Read an entire file (use only when you need the whole thing)
   Input: {"path": "relative/path.py"}
   Returns: Full file content with line numbers

## RULES:
- Call ONE tool at a time
- After receiving the tool result, either call another tool or give your final answer
- When you have enough information, respond with plain text (NO json block)
- NEVER guess file contents — always call read_lines or read_file first
- For line-specific questions, use read_lines with a small range (±5 lines)
- For "what's on line X" questions, read lines X-1 to X+1
`.trim();

// ── Main Export ───────────────────────────────────────────────────────────────

/**
 * Run the JSON-mode tool loop.
 * Works with any provider — Gemini, OpenAI, Claude, Groq, Ollama, etc.
 */
export async function runJsonToolLoop(opts: {
  provider: AIProviderConfig;
  modelId: string;
  task: string;
  projectPath: string;
  activeFilePath?: string | null;
  onToolCall?: (toolName: string) => void;
  onToken?: (token: string) => void;
}): Promise<ToolLoopResult> {
  const { provider, modelId, task, projectPath, activeFilePath, onToolCall } = opts;

  const activeFileName = activeFilePath?.replace(/.*[\\/]/, "") || null;
  const activeRelPath = activeFilePath
    ? activeFilePath.replace(projectPath.replace(/\\/g, "/"), "").replace(/^[\\/]/, "").replace(/\\/g, "/")
    : null;

  // Build system prompt with tool instructions
  const systemPrompt = `You are Punam, an AI coding assistant in PunamIDE.

EDITOR STATE:
- File currently open: ${activeFileName || "No file open"}
- File path: ${activeRelPath || "unknown"}

${TOOL_INSTRUCTIONS}

When answering:
- Be concise and precise
- For line questions, quote the exact content
- For code edits, use ===FILE: path=== blocks as usual`;

  // Build conversation as a growing message list
  const conversation: string[] = [];
  conversation.push(task);

  const toolsCalled: string[] = [];
  let finalText = "";

  for (let round = 0; round < MAX_ROUNDS; round++) {
    // Join conversation into a single user prompt
    const userPrompt = conversation.join("\n\n");

    // Call the LLM
    const resp: AIResponse = await sendToProviderStreaming(provider, modelId, {
      systemPrompt,
      userPrompt,
    });

    if (!resp.success) {
      return {
        text: resp.error || "LLM call failed",
        success: false,
        rounds: round + 1,
        toolsCalled,
        tokensSaved: 0,
      };
    }

    // Try to parse a tool call from the response
    const toolCall = parseToolCall(resp.text);

    if (!toolCall) {
      // No tool call — this is the final answer
      finalText = resp.text;
      return {
        text: finalText,
        success: true,
        rounds: round + 1,
        toolsCalled,
        tokensSaved: estimateTokenSavings(finalText),
      };
    }

    // Execute the tool
    toolsCalled.push(toolCall.tool);
    onToolCall?.(toolCall.tool);

    console.log(`[TOOL LOOP] Round ${round + 1}: calling ${toolCall.tool}`, toolCall.input);

    const toolResult = await executeTool(toolCall, projectPath);

    console.log(`[TOOL LOOP] Result (${toolResult.length} chars):`, toolResult.slice(0, 200));

    // Append tool call + result to conversation
    conversation.push(`[Tool called: ${toolCall.tool}]\nResult:\n${toolResult}`);
    conversation.push("Now answer the original question using the tool result above. Do NOT output another tool call unless you need more information.");
  }

  // Max rounds hit — return whatever we have
  return {
    text: finalText || "I couldn't complete this within the allowed steps. Please try again.",
    success: false,
    rounds: MAX_ROUNDS,
    toolsCalled,
    tokensSaved: 0,
  };
}

// ── JSON Parser ───────────────────────────────────────────────────────────────

/**
 * Extract a tool call JSON block from the model's response.
 * Returns null if no tool call found (meaning it's a final text answer).
 */
function parseToolCall(responseText: string): ToolCall | null {
  // Match ```json {...} ``` blocks
  const jsonBlockMatch = responseText.match(/```json\s*\n?([\s\S]*?)```/);
  if (jsonBlockMatch) {
    try {
      const parsed = JSON.parse(jsonBlockMatch[1].trim());
      if (parsed.tool && typeof parsed.tool === "string" && parsed.input && typeof parsed.input === "object") {
        return parsed as ToolCall;
      }
    } catch { /* not valid JSON */ }
  }

  // Also try matching raw JSON without code fences (some models skip the fences)
  const rawJsonMatch = responseText.match(/\{\s*"tool"\s*:\s*"(\w+)"\s*,\s*"input"\s*:\s*(\{[\s\S]*?\})\s*\}/);
  if (rawJsonMatch) {
    try {
      const full = JSON.parse(rawJsonMatch[0]);
      if (full.tool && full.input) {
        return full as ToolCall;
      }
    } catch { /* not valid JSON */ }
  }

  return null;
}

// ── Tool Executor ─────────────────────────────────────────────────────────────

async function executeTool(toolCall: ToolCall, projectPath: string): Promise<string> {
  const { tool, input } = toolCall;

  try {
    switch (tool) {
      case "read_lines": {
        const path = String(input.path || "");
        const start = Number(input.start || 1);
        const end = Number(input.end || start + 30);

        // Read full file then slice lines (no separate Rust command needed)
        const content = await invoke<string>("read_file", { path });
        const lines = content.split("\n");
        const from = Math.max(0, start - 1);
        const to = Math.min(lines.length, end);
        const numbered = lines.slice(from, to)
          .map((line, i) => `${String(from + i + 1).padStart(4, " ")} | ${line}`)
          .join("\n");
        return `File: ${path} (${lines.length} lines total)\nLines ${from + 1}-${to}:\n${numbered}`;
      }

      case "read_file": {
        const path = String(input.path || "");
        const content = await invoke<string>("read_file", { path });
        const lines = content.split("\n");
        const numbered = lines
          .map((line, i) => `${String(i + 1).padStart(4, " ")} | ${line}`)
          .join("\n");
        return `File: ${path} (${lines.length} lines)\n${numbered}`;
      }

      case "search_project": {
        const query = String(input.query || "");
        const results = await invoke<Array<{ path: string; line: number; column: number; preview: string }>>(
          "search_project", { query }
        );
        if (results.length === 0) {
          return `No results found for: "${query}"`;
        }
        const formatted = results.slice(0, 20).map(
          r => `  ${r.path}:${r.line} — ${r.preview.trim()}`
        ).join("\n");
        return `Found ${results.length} result(s) for "${query}":\n${formatted}`;
      }

      case "list_files": {
        const files = await invoke<Array<{ name: string; path: string; isDir: boolean }>>(
          "read_directory", { path: projectPath }
        );
        const fileList = files
          .filter(f => !f.isDir)
          .map(f => f.path.replace(projectPath.replace(/\\/g, "/"), "").replace(/^[\\/]/, ""))
          .slice(0, 50);
        return `Project files (${fileList.length}):\n${fileList.join("\n")}${files.length > 50 ? `\n... and more` : ""}`;
      }

      default:
        return `Unknown tool: ${tool}`;
    }
  } catch (err) {
    return `Tool error (${tool}): ${err instanceof Error ? err.message : String(err)}`;
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function estimateTokenSavings(responseText: string): number {
  // Rough estimate: full-context would be ~10k tokens, tool mode used ~responseText/4
  const toolModeTokens = Math.ceil(responseText.length / 4) + 200; // +200 for tool overhead
  const fullContextTokens = 10000; // typical full-file dump
  return Math.max(0, fullContextTokens - toolModeTokens);
}
