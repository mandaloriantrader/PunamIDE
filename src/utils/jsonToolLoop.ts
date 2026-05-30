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
  metrics: any; // ResponseMetrics from provider — passed through for display
}

interface ToolCall {
  tool: string;
  input: Record<string, unknown>;
}

/**
 * Block emitter callback — compatible with streamBlocks.ts parseStreamBlocks().
 * Caller wires this to feed tool execution visibility into the chat UI.
 * Emits XML-format blocks: thinking, tool_call, tool_result, response.
 */
export type BlockEmitter = (block: string) => void;

// ── Constants ─────────────────────────────────────────────────────────────────

const MAX_ROUNDS = 8; // increased from 5 for multi-tool + retry headroom
const TOOL_TIMEOUT_MS = 30_000; // 30s for most tools
const COMMAND_TIMEOUT_MS = 120_000; // 2min for run_command
const TOKEN_BUDGET = 8000; // cumulative tokens before forcing full-context fallback

// ── Provider-Specific Tuning ──────────────────────────────────────────────────

/**
 * Different models need different levels of hand-holding for JSON tool calling.
 * This map provides extra instructions appended to the system prompt per provider.
 */
const PROVIDER_EXTRA_INSTRUCTIONS: Record<string, string> = {
  gemini:
    "\n\nIMPORTANT for Gemini: Output ONLY the JSON block — NO other text before or after. Start your response with ```json.",
  deepseek:
    "\n\nIMPORTANT for DeepSeek: Output exactly in this format:\n```json\n{\"tool\": \"read_lines\", \"input\": {\"path\": \"src/main.py\", \"start\": 1, \"end\": 30}}\n```\nDo NOT add explanations or markdown outside the code block.",
  ollama:
    "\n\nOutput format: {\"tool\": \"name\", \"input\": {params}}\nWrap in ```json ... ``` code fence. Keep responses short.",
  groq: "",
  openai: "",
  mistral: "",
  anthropic: "",
  claude: "",
};

function detectProviderType(provider: { type: string; id?: string; name?: string }, modelId: string): string {
  const type = provider.type?.toLowerCase() || "";
  if (type === "gemini") return "gemini";
  const combined = ((provider.id || "") + (provider.name || "") + modelId).toLowerCase();
  if (combined.includes("deepseek")) return "deepseek";
  if (combined.includes("ollama")) return "ollama";
  if (combined.includes("groq")) return "groq";
  if (combined.includes("openai") || combined.includes("gpt")) return "openai";
  if (combined.includes("mistral") || combined.includes("mixtral")) return "mistral";
  if (combined.includes("claude") || combined.includes("anthropic")) return "anthropic";
  return type || "default";
}

// ── Tool Definitions (injected into system prompt) ────────────────────────────

const TOOL_INSTRUCTIONS = `
## AVAILABLE TOOLS

You have access to these tools. Call them by outputting a JSON block:

\`\`\`json
{"tool": "tool_name", "input": {parameters}}
\`\`\`

### Read Tools:
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

### Write/Edit Tools (use ONLY when user explicitly asks to edit, fix, create, or run):
5. **apply_patch** — Replace specific line range in a file (safest for edits)
   Input: {"path": "relative/path.py", "start_line": 10, "end_line": 15, "new_content": "replacement\\nlines\\nhere"}
   Note: start_line and end_line are 1-indexed and inclusive. new_content can have any number of lines.

6. **write_file** — Create a new file or fully overwrite existing file
   Input: {"path": "relative/newfile.py", "content": "complete file content\\nhere"}
   Note: Use only for NEW files or COMPLETE rewrites. For partial edits use apply_patch.

7. **run_command** — Execute a terminal command in the project directory
   Input: {"command": "npm run build"}
   Note: Use for build, install, test, lint commands. Do NOT use for destructive commands (rm -rf, format, etc.).

## RULES:
- Call ONE tool at a time
- For READ-ONLY questions: only use read_lines, read_file, search_project, list_files. NEVER call write tools.
- For EDIT/FIX requests: first READ the target lines using read_lines, then apply changes with apply_patch or write_file.
- After receiving the tool result, either call another tool or give your final answer
- When you have enough information, respond with plain text (NO json block)
- NEVER guess file contents — always call read_lines or read_file first
- For line-specific questions, use read_lines with a small range (±5 lines)
- For "what's on line X" questions, read lines X-1 to X+1
- When the user asks to RUN, START, EXECUTE, BUILD, or INSTALL — use run_command
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
  systemPrompt?: string; // optional — from contextEngine, falls back to default
  onToolCall?: (toolName: string, input?: Record<string, unknown>) => void;
  onToken?: (token: string) => void;
  /** Optional: receive XML-format blocks for streamBlocks.ts display in chat UI */
  onBlock?: BlockEmitter;
}): Promise<ToolLoopResult> {
  const { provider, modelId, task, projectPath, activeFilePath, onToolCall, onToken, onBlock } = opts;

  const activeFileName = activeFilePath?.replace(/.*[\\/]/, "") || null;
  const activeRelPath = (() => {
    // Safe prefix stripping — avoids regex-special chars in projectPath
    if (!activeFilePath) return null;
    const normalizedProject = projectPath.replace(/\\/g, "/").replace(/\/$/, "");
    const normalizedActive = activeFilePath.replace(/\\/g, "/");
    if (normalizedActive.startsWith(normalizedProject + "/")) {
      return normalizedActive.slice(normalizedProject.length + 1);
    }
    if (normalizedActive.startsWith(normalizedProject)) {
      return normalizedActive.slice(normalizedProject.length).replace(/^\//, "");
    }
    return normalizedActive.split("/").pop() || null;
  })();

  // Build system prompt — use contextEngine's prompt if provided, otherwise default
  const providerExtra = PROVIDER_EXTRA_INSTRUCTIONS[detectProviderType(provider, modelId)] || "";

  const defaultSystemPrompt = `You are Punam, an AI coding assistant in PunamIDE.

EDITOR STATE:
- File currently open: ${activeFileName || "No file open"}
- File path: ${activeRelPath || "unknown"}

${TOOL_INSTRUCTIONS}${providerExtra}

When answering:
- Be concise and precise
- For line questions, quote the exact content
- For code edits, use ===FILE: path=== blocks as usual`;

  const systemPrompt = opts.systemPrompt
    ? `${opts.systemPrompt}\n\n${TOOL_INSTRUCTIONS}${providerExtra}`
    : defaultSystemPrompt;

  // Build conversation as a growing message list
  const conversation: string[] = [];
  conversation.push(task);

  const toolsCalled: string[] = [];
  let finalText = "";
  let accumulatedMetrics: any = null;
  let cumulativeTokens = 0;
  let parseRetriesUsed = 0;
  const MAX_PARSE_RETRIES = 1; // only retry once per round

  for (let round = 0; round < MAX_ROUNDS; round++) {
    // Check token budget
    if (cumulativeTokens > TOKEN_BUDGET) {
      return {
        text: finalText || "Task too large for tool loop — switching to full-context mode.",
        success: false,
        error: "TOKEN_BUDGET_EXCEEDED",
        rounds: round,
        toolsCalled,
        tokensSaved: 0,
        metrics: accumulatedMetrics,
      };
    }

    // Join conversation into a single user prompt
    const userPrompt = conversation.join("\n\n");

    // ── Set up real streaming via Tauri llm-stream event ────────────────────
    const { listen } = await import("@tauri-apps/api/event");
    let streamedSoFar = "";
    let streamingDone = false;

    // Emit response block start for this round
    onBlock?.(`<response>\n`);

    const unlisten = await listen<{ token: string; done: boolean }>(
      "llm-stream",
      (event) => {
        const { token, done } = event.payload;
        if (done) {
          streamingDone = true;
          onBlock?.(`</response>\n`);
          return;
        }
        if (token) {
          streamedSoFar += token;
          onToken?.(token);
        }
      }
    );

    // Call the LLM (streaming happens via Tauri backend → llm-stream events)
    const resp: AIResponse = await sendToProviderStreaming(provider, modelId, {
      systemPrompt,
      userPrompt,
    });

    unlisten();
    // Small delay to ensure final llm-stream events are flushed
    if (!streamingDone) {
      await new Promise((r) => setTimeout(r, 100));
    }

    // Track cumulative tokens
    const roundTokens = (resp.metrics?.totalTokens || 0) + Math.ceil(userPrompt.length / 4);
    cumulativeTokens += roundTokens;

    // Accumulate metrics — keep the last response's metrics but sum tokens
    if (resp.metrics) {
      if (!accumulatedMetrics) {
        accumulatedMetrics = { ...resp.metrics };
      } else {
        accumulatedMetrics.promptTokens = (accumulatedMetrics.promptTokens || 0) + (resp.metrics.promptTokens || 0);
        accumulatedMetrics.responseTokens = (accumulatedMetrics.responseTokens || 0) + (resp.metrics.responseTokens || 0);
        accumulatedMetrics.totalTokens = (accumulatedMetrics.totalTokens || 0) + (resp.metrics.totalTokens || 0);
        accumulatedMetrics.durationMs = (accumulatedMetrics.durationMs || 0) + (resp.metrics.durationMs || 0);
        if (resp.metrics.estimatedCostUsd) {
          accumulatedMetrics.estimatedCostUsd = (accumulatedMetrics.estimatedCostUsd || 0) + resp.metrics.estimatedCostUsd;
          accumulatedMetrics.estimatedCostInr = (accumulatedMetrics.estimatedCostInr || 0) + resp.metrics.estimatedCostInr;
        }
      }
    }

    if (!resp.success) {
      return {
        text: resp.error || "LLM call failed",
        success: false,
        rounds: round + 1,
        toolsCalled,
        tokensSaved: 0,
        metrics: accumulatedMetrics,
      };
    }

    // ── Try to parse tool calls (support parallel tools) ─────────────────────
    const allToolCalls = parseAllToolCalls(resp.text);

    if (allToolCalls.length === 0) {
      // No tool calls parsed. Check if model INTENDED a tool call but mangled JSON.
      const looksLikeToolCall = /"tool"\s*:/i.test(resp.text) ||
        /\b(read_lines|read_file|search_project|list_files|apply_patch|write_file|run_command)\b/i.test(resp.text);

      if (looksLikeToolCall && parseRetriesUsed < MAX_PARSE_RETRIES) {
        // Retry: ask model to re-emit JSON correctly
        parseRetriesUsed++;
        conversation.push(
          "Your last response was not valid JSON. Output ONLY a JSON block:\n```json\n{\"tool\": \"tool_name\", \"input\": { \"param\": \"value\" }}\n```\nDo NOT include any other text."
        );
        console.log("[TOOL LOOP] Parse failed but detected tool intent — retrying with correction prompt");
        continue; // retry same round
      }

      // No tool call — this is the final answer
      finalText = resp.text;
      return {
        text: finalText,
        success: true,
        rounds: round + 1,
        toolsCalled,
        tokensSaved: estimateTokenSavings(finalText),
        metrics: accumulatedMetrics,
      };
    }

    parseRetriesUsed = 0; // reset on successful parse

    // ── Execute all tool calls (parallel if multiple) ────────────────────────
    console.log(`[TOOL LOOP] Round ${round + 1}: ${allToolCalls.length} tool(s) — ${allToolCalls.map(c => c.tool).join(", ")}`);

    const toolPromises = allToolCalls.map(async (tc) => {
      toolsCalled.push(tc.tool);
      onToolCall?.(tc.tool, tc.input);

      // Emit tool_call block for streamBlocks.ts UI
      const paramsStr = JSON.stringify(tc.input);
      onBlock?.(`<tool_call>${tc.tool}\n<tool_params>${paramsStr}</tool_params>\n</tool_call>\n`);

      console.log(`[TOOL LOOP] Calling: ${tc.tool}`, tc.input);
      const result = await executeToolWithTimeout(tc, projectPath);
      console.log(`[TOOL LOOP] Result (${result.length} chars):`, result.slice(0, 200));

      // Emit tool_result block
      onBlock?.(`<tool_result>${result.slice(0, 2000)}</tool_result>\n`);

      return `[${tc.tool} result]: ${result}`;
    });

    const allResults = await Promise.all(toolPromises);

    // Append all results to conversation
    conversation.push("Tool results:\n" + allResults.join("\n---\n"));
    conversation.push("Now answer the original question using the tool results above. Do NOT output another tool call unless you need more information.");
  }

  // Max rounds hit — return whatever we have
  return {
    text: finalText || "I couldn't complete this within the allowed steps. Please try again.",
    success: false,
    rounds: MAX_ROUNDS,
    toolsCalled,
    tokensSaved: 0,
    metrics: accumulatedMetrics,
  };
}

// ── JSON Parser ───────────────────────────────────────────────────────────────

/**
 * Extract ALL tool calls from a response. Supports multiple ```json``` blocks
 * in a single response for parallel execution.
 */
function parseAllToolCalls(responseText: string): ToolCall[] {
  const results: ToolCall[] = [];

  // Match all ```json {...} ``` blocks
  const jsonBlockRegex = /```json\s*\n?([\s\S]*?)```/g;
  let blockMatch: RegExpExecArray | null;
  while ((blockMatch = jsonBlockRegex.exec(responseText)) !== null) {
    try {
      const parsed = JSON.parse(blockMatch[1].trim());
      if (parsed.tool && typeof parsed.tool === "string" && parsed.input && typeof parsed.input === "object") {
        results.push(parsed as ToolCall);
      }
    } catch { /* skip invalid JSON blocks */ }
  }

  // If no code-fenced blocks found, try raw JSON without fences
  if (results.length === 0) {
    const rawJsonRegex = /\{\s*"tool"\s*:\s*"(\w+)"\s*,\s*"input"\s*:\s*(\{[\s\S]*?\})\s*\}/g;
    let rawMatch: RegExpExecArray | null;
    while ((rawMatch = rawJsonRegex.exec(responseText)) !== null) {
      try {
        const full = JSON.parse(rawMatch[0]);
        if (full.tool && full.input) {
          results.push(full as ToolCall);
        }
      } catch { /* skip */ }
    }
  }

  return results;
}

// ── Tool Execution with Timeout ───────────────────────────────────────────────

/**
 * Execute a tool with a configurable timeout.
 * `run_command` gets a longer timeout (2min), everything else 30s.
 */
async function executeToolWithTimeout(toolCall: ToolCall, projectPath: string): Promise<string> {
  const timeoutMs = toolCall.tool === "run_command" ? COMMAND_TIMEOUT_MS : TOOL_TIMEOUT_MS;

  return Promise.race([
    executeTool(toolCall, projectPath),
    new Promise<string>((_, reject) =>
      setTimeout(() => reject(new Error(`Tool '${toolCall.tool}' timed out after ${timeoutMs / 1000}s`)), timeoutMs)
    ),
  ]).catch((err) => {
    return `Tool error (${toolCall.tool}): ${err instanceof Error ? err.message : String(err)}`;
  });
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

        // Try Rust-backed read_lines first (fast, only reads needed lines)
        try {
          const result = await invoke<{
            path: string; start_line: number; end_line: number;
            total_lines: number; content: string;
          }>("read_lines", { path, startLine: start, endLine: end });
          return `File: ${result.path} (${result.total_lines} lines total)\nLines ${result.start_line}-${result.end_line}:\n${result.content}`;
        } catch {
          // Fallback: read full file then slice (works even if Rust command not yet deployed)
          const content = await invoke<string>("read_file", { path });
          const lines = content.split("\n");
          const from = Math.max(0, start - 1);
          const to = Math.min(lines.length, end);
          const numbered = lines.slice(from, to)
            .map((line, i) => `${String(from + i + 1).padStart(4, " ")} | ${line}`)
            .join("\n");
          return `File: ${path} (${lines.length} lines total)\nLines ${from + 1}-${to}:\n${numbered}`;
        }
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
        // Normalize paths for consistent comparison (handle Windows backslashes)
        const normalizedProject = projectPath.replace(/\\/g, "/").replace(/\/$/, "");
        const fileList = files
          .filter(f => !f.isDir)
          .map(f => {
            const normalizedPath = f.path.replace(/\\/g, "/");
            // Strip project root prefix safely (avoid regex special chars in path)
            if (normalizedPath.startsWith(normalizedProject + "/")) {
              return normalizedPath.slice(normalizedProject.length + 1);
            }
            if (normalizedPath.startsWith(normalizedProject)) {
              return normalizedPath.slice(normalizedProject.length).replace(/^\//, "");
            }
            // Fallback: return just the filename
            return f.name;
          })
          .slice(0, 50);
        return `Project files (${fileList.length}):\n${fileList.join("\n")}${files.length > 50 ? `\n... and more` : ""}`;
      }

      // ── Write/Edit Tools ──────────────────────────────────────────────────

      case "apply_patch": {
        const path = String(input.path || "");
        const startLine = Number(input.start_line || input.start || 0);
        const endLine = Number(input.end_line || input.end || 0);
        const newContent = String(input.new_content || input.content || "");
        const result = await invoke<{
          path: string; lines_replaced: number; new_total_lines: number;
        }>("apply_patch", {
          path,
          hunk: { start_line: startLine, end_line: endLine, new_content: newContent },
        });
        return `Patch applied to ${result.path}. Replaced ${result.lines_replaced} line(s). File now has ${result.new_total_lines} lines.`;
      }

      case "write_file": {
        const path = String(input.path || "");
        const content = String(input.content || "");
        await invoke("write_file", { path, content });
        return `File written successfully: ${path}`;
      }

      case "run_command": {
        const command = String(input.command || "");
        const result = await invoke<{ stdout: string; stderr: string; exit_code: number }>(
          "run_terminal_command", { command, cwd: projectPath }
        );
        let output = `Command: ${command}\nExit code: ${result.exit_code}\n`;
        if (result.stdout) output += `stdout:\n${result.stdout.slice(0, 3000)}`;
        if (result.stderr) output += `\nstderr:\n${result.stderr.slice(0, 1000)}`;
        return output;
      }

      default:
        return `Unknown tool: ${tool}`;
    }
  } catch (err) {
    return `Tool error (${tool}): ${err instanceof Error ? err.message : String(err)}`;
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

// ── DevTools Test Harness ─────────────────────────────────────────────────────
// Open DevTools console (F12 or Ctrl+Shift+I) and type:
//   await window.__testToolLoop("read lines 10-20 of index.html")
//   await window.__testToolLoop("search for useState in the project")
//   await window.__testToolLoop("list all files in the project")
// Ensure a project is open and AI providers are configured first.

if (typeof window !== "undefined") {
  (window as any).__testToolLoop = async (task: string) => {
    const { load } = await import("@tauri-apps/plugin-store");
    const stores = await load("punam-config.json");

    const [providerId, activeFilePath, projectPath] = await Promise.all([
      stores.get<string>("activeProviderId"),
      stores.get<string>("activeFilePath"),
      stores.get<string>("projectPath"),
    ]);

    if (!projectPath) {
      console.error("❌ No project open. Open a project first.");
      return;
    }

    // Load provider configs
    const providersRaw = await stores.get<any[]>("providers") || [];
    const providers: any[] = typeof providersRaw === "string"
      ? JSON.parse(providersRaw) : providersRaw;

    const provider = providers.find((p: any) => p.id === (providerId || "default"));
    if (!provider) {
      console.error("❌ No provider configured. Add one in Settings.");
      return;
    }
    const enabledModel = provider.models?.find((m: any) => m.enabled);
    if (!enabledModel) {
      console.error("❌ No enabled model for provider:", provider.name);
      return;
    }

    console.log(`🚀 Testing tool loop | Provider: ${provider.name} | Model: ${enabledModel.id}`);
    console.log(`📝 Task: ${task}`);
    console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");

    let streamedText = "";
    const toolsFired: Array<{ name: string; input: any }> = [];

    const result = await runJsonToolLoop({
      provider,
      modelId: enabledModel.id,
      task,
      projectPath,
      activeFilePath: activeFilePath || null,
      onToolCall: (name, input) => {
        toolsFired.push({ name, input: input || {} });
        console.log(`  🔧 ${name}(${JSON.stringify(input).slice(0, 80)})`);
      },
      onToken: (token) => {
        streamedText += token;
      },
      onBlock: (block) => {
        // Log blocks at debug level
        if (block.includes("<tool_result>")) {
          const match = block.match(/<tool_result>([\s\S]*?)<\/tool_result>/);
          if (match) console.log(`  ✅ Result: ${match[1].slice(0, 120)}...`);
        }
      },
    });

    console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    console.log(`📊 Rounds: ${result.rounds}/${8} | Tools: ${toolsFired.length} | Tokens saved: ~${result.tokensSaved}`);
    console.log(`✅ Success: ${result.success} | Error: ${result.error || "none"}`);
    console.log(`💬 Response:\n${result.text.slice(0, 500)}`);
    if (result.metrics) {
      console.log(`💰 Cost: $${result.metrics.estimatedCostUsd?.toFixed(6) || "0"} (~₹${result.metrics.estimatedCostInr?.toFixed(4) || "0"})`);
    }
    return result;
  };

  console.log("%c🧪 Tool Loop Test Ready %c| Type: %cawait window.__testToolLoop(\"your task here\")%c | Open project & configure AI provider first",
    "color: #4CAF50; font-weight: bold", "", "color: #FFD700; font-weight: bold", "");
}

function estimateTokenSavings(responseText: string): number {
  // Rough estimate: full-context would be ~10k tokens, tool mode used ~responseText/4
  const toolModeTokens = Math.ceil(responseText.length / 4) + 200; // +200 for tool overhead
  const fullContextTokens = 10000; // typical full-file dump
  return Math.max(0, fullContextTokens - toolModeTokens);
}
