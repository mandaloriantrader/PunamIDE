// src/utils/agentToolLoop.ts
//
// Phase 1 — Agent Tool-Calling Orchestration Loop
//
// Drop-in replacement for the agentProposeFix inner logic.
// The existing agentProposeFix function in AiChat.tsx stays as a fallback.
// This module handles:
//   1. Native tool calling for Anthropic (claude-*) providers
//   2. Gemini function calling adapter
//   3. JSON-fallback for all other providers (openai-compatible, groq, etc.)
//
// Usage in AiChat.tsx:
//   import { runAgentToolLoop, shouldUseToolLoop } from "../utils/agentToolLoop";
//
//   // In agentProposeFix(), before the existing code:
//   if (shouldUseToolLoop(provider, agentTask)) {
//     await runAgentToolLoop({ provider, modelId, systemPrompt, task, projectPath, ... });
//     return;
//   }
//   // ...existing full-context fallback continues below...

import type { AIProviderConfig } from "./providers";
import {
  AGENT_TOOL_DEFINITIONS,
  executeAgentTool,
  isNativeToolProvider,
  buildToolSystemPrompt,
  parseJsonToolCall,
  type ToolCall,
  type ToolResult,
} from "./agentTools";

// ── Public: should we use the tool loop for this request? ────────────────────

/**
 * Heuristic: use tool loop for question/read/targeted-edit tasks.
 * Fall back to full-context for explicit full-file refactor requests.
 */
export function shouldUseToolLoop(task: string): boolean {
  const lower = task.toLowerCase();

  // Always use tool loop for these patterns
  const toolLoopPatterns = [
    /what (is|does|are|was)/i,
    /which (file|line|function|class)/i,
    /where (is|are|does)/i,
    /show me (line|function|class|the)/i,
    /read (line|file|the)/i,
    /on line \d+/i,
    /line number \d+/i,
    /what('s| is) (written|on|at) line/i,
    /explain (this|the|how)/i,
    /find (where|the|all)/i,
    /search for/i,
    /fix (this|the) (error|bug|issue|problem)/i,
    /add (a|an|the) (function|method|class|import|line)/i,
    /change (line|the|this)/i,
    /update (the|this|line)/i,
    /rename/i,
  ];

  // Fall back to full-context for explicit whole-file tasks
  const fullContextPatterns = [
    /refactor (the )?(whole|entire|full|all)/i,
    /rewrite (the )?(whole|entire|full)/i,
    /convert (the )?(whole|entire|full)/i,
  ];

  if (fullContextPatterns.some((p) => p.test(task))) return false;
  if (toolLoopPatterns.some((p) => p.test(lower))) return true;

  // Default: use tool loop (it will read what it needs)
  return true;
}

// ── Tool loop inputs ──────────────────────────────────────────────────────────

export interface ToolLoopOptions {
  provider: AIProviderConfig;
  modelId: string;
  systemPrompt: string; // from contextEngine (no file snippets needed)
  task: string; // the user's question / request
  projectPath: string;
  activeFilePath?: string | null; // hint — tool loop can use if needed
  maxRounds?: number; // default 10
  onToken?: (token: string) => void; // streaming token callback
  onToolCall?: (name: string) => void; // called when a tool fires (for UI)
  onDone?: (finalText: string) => void; // called with the final answer
  onError?: (err: string) => void;
}

// ── Anthropic native tool loop ────────────────────────────────────────────────

async function runAnthropicToolLoop(opts: ToolLoopOptions): Promise<string> {
  const {
    provider,
    modelId,
    systemPrompt,
    task,
    projectPath,
    activeFilePath,
    maxRounds = 10,
    onToken,
    onToolCall,
  } = opts;

  // Initial hint: tell the model which file is open (no content)
  const activeFileBasename = activeFilePath
    ? activeFilePath.replace(/.*[\\/]/, "")
    : null;
  const taskWithInstruction = activeFileBasename
    ? `${task}\n\nThe file open in the editor is: ${activeFileBasename}\nYou MUST call read_lines before answering questions about its content.`
    : task;

  // Anthropic messages format
  type Message =
    | { role: "user"; content: string | AnthropicContent[] }
    | { role: "assistant"; content: AnthropicContent[] };

  type AnthropicContent =
    | { type: "text"; text: string }
    | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
    | { type: "tool_result"; tool_use_id: string; content: string; is_error?: boolean };

  const messages: Message[] = [
    { role: "user", content: taskWithInstruction },
  ];

  let finalText = "";

  for (let round = 0; round < maxRounds; round++) {
    // Call Anthropic via Tauri backend streaming endpoint
    const response = await callAnthropicWithTools(
      provider,
      modelId,
      systemPrompt,
      messages,
      onToken
    );

    // Collect text + tool_use blocks
    const textBlocks = response.content.filter(
      (b): b is { type: "text"; text: string } => b.type === "text"
    );
    const toolUseBlocks = response.content.filter(
      (b): b is ToolCall & { type: "tool_use" } => b.type === "tool_use"
    );

    // Accumulate any text
    if (textBlocks.length > 0) {
      finalText = textBlocks.map((b) => b.text).join("");
    }

    // If model is done (no tool calls), return the answer
    if (response.stop_reason === "end_turn" || toolUseBlocks.length === 0) {
      return finalText;
    }

    // Execute all tool calls in parallel
    const toolResults: AnthropicContent[] = [];
    await Promise.all(
      toolUseBlocks.map(async (block) => {
        onToolCall?.(block.name);
        const result: ToolResult = await executeAgentTool(
          { id: block.id, name: block.name as ToolCall["name"], input: block.input },
          projectPath
        );
        toolResults.push({
          type: "tool_result",
          tool_use_id: result.tool_use_id,
          content: result.content,
          is_error: result.is_error,
        });
      })
    );

    // Feed results back
    messages.push({ role: "assistant", content: response.content });
    messages.push({ role: "user", content: toolResults });
  }

  return finalText || "Max tool rounds reached.";
}

// ── JSON fallback loop (all other providers) ──────────────────────────────────

async function runJsonFallbackToolLoop(opts: ToolLoopOptions): Promise<string> {
  const {
    provider,
    modelId,
    systemPrompt,
    task,
    projectPath,
    activeFilePath,
    maxRounds = 10,
    onToken,
    onToolCall,
  } = opts;

  const fileHint = activeFilePath
    ? `\n\nCurrently open in editor: ${activeFilePath}`
    : "";

  // Inject tool instructions into system prompt
  const fullSystem = `${systemPrompt}\n\n${buildToolSystemPrompt()}`;

  // Build a simple text conversation
  const conversationParts: string[] = [];
  let userTurn = task + fileHint;

  for (let round = 0; round < maxRounds; round++) {
    // Build the full prompt string for this round
    const fullPrompt =
      conversationParts.length > 0
        ? conversationParts.join("\n\n") + "\n\nUser: " + userTurn
        : userTurn;

    // Call via the existing sendToProviderStreaming path
    const { sendToProviderStreaming } = await import("./providers");
    const resp = await sendToProviderStreaming(provider, modelId, {
      systemPrompt: fullSystem,
      userPrompt: fullPrompt,
    });

    if (!resp.success) {
      throw new Error(resp.error || "Provider error");
    }

    const responseText = resp.text;
    onToken?.(responseText);

    // Try to parse a tool call from the response
    const toolCall = parseJsonToolCall(responseText);

    if (!toolCall) {
      // No tool call — this is the final answer
      return responseText;
    }

    // Execute the tool
    onToolCall?.(toolCall.tool);
    const result = await executeAgentTool(toolCall, projectPath);

    // Append to conversation history
    conversationParts.push(
      `Assistant:\n${responseText}`,
      `Tool result (${toolCall.tool}):\n${result.content}`
    );

    // Next user turn is empty (continue reasoning)
    userTurn = "Continue based on the tool result above.";
  }

  return "Max tool rounds reached.";
}

// ── Gemini native function calling ───────────────────────────────────────────
//
// Gemini's function calling API (v1beta REST, confirmed against May 2026 docs):
//   - Tools: `tools: [{ functionDeclarations: [...] }]`
//   - Tool call response: `candidates[0].content.parts[].functionCall`
//     where functionCall = { name, args, id }  ← id is NEW in Gemini 3.x
//   - Tool result: sent back as a "user" turn with parts[].functionResponse
//     where functionResponse = { id, name, response: { output: string } }
//     ↑ NOTE: field is `output` not `content`, and `id` must match the call id
//   - finishReason "STOP" means done (text answer), no functionCall parts means done
//   - finishReason is NOT set to something else during tool use — model just
//     returns functionCall parts with finishReason "STOP" or absent
//
// Bug fixes vs prior version:
//   1. functionResponse used `content` field — correct field is `output`
//   2. Missing `id` field in functionResponse — required for Gemini 3.x models
//   3. Loop termination was checking finishReason === "STOP" AND fnCalls === 0
//      but Gemini can return finishReason "STOP" WITH functionCalls on the same
//      turn. Correct check: if NO functionCall parts exist → model is done.
//   4. 503 errors = Gemini overloaded — add retry with exponential backoff

interface GeminiPart {
  text?: string;
  functionCall?: { name: string; args: Record<string, unknown>; id?: string };
  functionResponse?: {
    id?: string;
    name: string;
    response: { output: string }; // ← `output`, not `content`
  };
}

interface GeminiContent {
  role: "user" | "model";
  parts: GeminiPart[];
}

interface GeminiResponse {
  candidates: Array<{
    content: { role: string; parts: GeminiPart[] };
    finishReason?: string;
  }>;
  promptFeedback?: { blockReason?: string };
}

/** Convert our Anthropic-format tool schemas to Gemini functionDeclarations */
function toGeminiFunctionDeclarations() {
  return AGENT_TOOL_DEFINITIONS.map((tool) => ({
    name: tool.name,
    description: tool.description,
    parameters: tool.input_schema,
  }));
}

async function callGeminiWithTools(
  apiKey: string,
  modelId: string,
  systemPrompt: string,
  contents: GeminiContent[],
  retries = 3
): Promise<GeminiResponse> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelId}:generateContent?key=${apiKey}`;

  const body = {
    system_instruction: { parts: [{ text: systemPrompt }] },
    contents,
    tools: [{ functionDeclarations: toGeminiFunctionDeclarations() }],
    tool_config: { function_calling_config: { mode: "AUTO" } },
    generationConfig: { temperature: 0.3, maxOutputTokens: 8192 },
  };

  for (let attempt = 0; attempt <= retries; attempt++) {
    const resp = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": apiKey, // some endpoints prefer header over query param
      },
      body: JSON.stringify(body),
    });

    // 503 = Gemini overloaded — retry with backoff
    if (resp.status === 503 && attempt < retries) {
      const delay = 1000 * Math.pow(2, attempt); // 1s, 2s, 4s
      console.warn(`[GEMINI] 503 overloaded, retrying in ${delay}ms (attempt ${attempt + 1}/${retries})`);
      await new Promise((r) => setTimeout(r, delay));
      continue;
    }

    if (!resp.ok) {
      const errText = await resp.text();
      throw new Error(`Gemini API error ${resp.status}: ${errText.slice(0, 400)}`);
    }

    return resp.json() as Promise<GeminiResponse>;
  }

  throw new Error("Gemini API: max retries exceeded (503 overloaded)");
}

async function runGeminiToolLoop(opts: ToolLoopOptions): Promise<string> {
  const {
    provider,
    modelId,
    systemPrompt,
    task,
    projectPath,
    activeFilePath,
    maxRounds = 10,
    onToolCall,
  } = opts;

  // Do NOT pass filename as passive hint — Gemini answers from the name
  // without calling read_lines. Explicitly instruct it to use the tool.
  const activeFileBasename = activeFilePath
    ? activeFilePath.replace(/.*[\\/]/, "")
    : null;

  const taskWithInstruction = activeFileBasename
    ? `${task}\n\nThe file open in the editor is: ${activeFileBasename}\nYou MUST call read_lines to read its content before answering. Do not guess from the filename alone.`
    : task;

  const contents: GeminiContent[] = [
    { role: "user", parts: [{ text: taskWithInstruction }] },
  ];

  let finalText = "";

  for (let round = 0; round < maxRounds; round++) {
    console.log(`[GEMINI TOOL LOOP] Round ${round + 1}, sending ${contents.length} content turns`);

    const response = await callGeminiWithTools(
      provider.apiKey,
      modelId,
      systemPrompt,
      contents
    );

    // Safety: check for prompt block
    if (response.promptFeedback?.blockReason) {
      throw new Error(`Gemini blocked prompt: ${response.promptFeedback.blockReason}`);
    }

    const candidate = response.candidates?.[0];
    if (!candidate) throw new Error("Gemini returned no candidates");

    const parts = candidate.content?.parts ?? [];
    const finishReason = candidate.finishReason;

    console.log(`[GEMINI TOOL LOOP] Round ${round + 1} response:`, {
      finishReason,
      partCount: parts.length,
      textParts: parts.filter(p => p.text !== undefined).length,
      fnCallParts: parts.filter(p => p.functionCall !== undefined).length,
      parts: JSON.stringify(parts).slice(0, 500),
    });

    // Collect any text from this turn
    const textParts = parts.filter((p): p is { text: string } => typeof p.text === "string");
    if (textParts.length > 0) {
      finalText = textParts.map((p) => p.text).join("");
    }

    // Collect function calls
    const fnCalls = parts.filter(
      (p): p is { functionCall: { name: string; args: Record<string, unknown>; id?: string } } =>
        p.functionCall !== undefined
    );

    // ── Termination check ──────────────────────────────────────────────────
    // Correct rule: if there are NO functionCall parts, the model is done.
    // Don't rely on finishReason alone — Gemini 3.x can return "STOP" alongside
    // functionCall parts when it wants to call a tool AND provide a text preamble.
    if (fnCalls.length === 0) {
      console.log(`[GEMINI TOOL LOOP] Done after ${round + 1} rounds. Final text length: ${finalText.length}`);
      return finalText;
    }

    // Push the model's full response turn into history (including any text preamble)
    contents.push({ role: "model", parts });

    // Execute all tool calls sequentially (safer — avoids race conditions on file edits)
    const responseParts: GeminiPart[] = [];
    for (const fc of fnCalls) {
      const toolName = fc.functionCall.name;
      const toolId = fc.functionCall.id; // present in Gemini 3.x, may be undefined in 1.5

      console.log(`[GEMINI TOOL LOOP] Calling tool: ${toolName}`, fc.functionCall.args);
      onToolCall?.(toolName);

      const result = await executeAgentTool(
        {
          tool: toolName as ToolCall["name"],
          input: fc.functionCall.args,
        },
        projectPath
      );

      console.log(`[GEMINI TOOL LOOP] Tool result for ${toolName}:`, result.content.slice(0, 200));

      // Build functionResponse — include id if present (required for Gemini 3.x)
      const fnResponse: GeminiPart = {
        functionResponse: {
          name: toolName,
          response: { output: result.content }, // ← `output` not `content`
          ...(toolId ? { id: toolId } : {}),
        },
      };
      responseParts.push(fnResponse);
    }

    // Feed tool results back as a user turn
    contents.push({ role: "user", parts: responseParts });
  }

  // If we exhausted rounds but have text, return it rather than an error string
  console.warn("[GEMINI TOOL LOOP] Max rounds reached, returning last text");
  return finalText || "I wasn't able to complete this task within the allowed steps.";
}

// ── Anthropic API call (via Tauri backend) ────────────────────────────────────
// This calls the Anthropic Messages API directly with tool definitions.
// It bypasses the existing sendToProviderStreaming (which doesn't support tools)
// and calls fetch directly — same as how the AI-powered artifacts work.

interface AnthropicMessage {
  role: "user" | "assistant";
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  content: any;
}

interface AnthropicResponse {
  stop_reason: "end_turn" | "tool_use" | "max_tokens" | string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  content: any[];
}

async function callAnthropicWithTools(
  provider: AIProviderConfig,
  modelId: string,
  systemPrompt: string,
  messages: AnthropicMessage[],
  _onToken?: (token: string) => void
): Promise<AnthropicResponse> {
  const baseUrl = provider.baseUrl || "https://api.anthropic.com";
  const apiKey = provider.apiKey;

  const response = await fetch(`${baseUrl}/v1/messages`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: modelId,
      max_tokens: 4096,
      system: systemPrompt,
      tools: AGENT_TOOL_DEFINITIONS,
      messages,
    }),
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Anthropic API error ${response.status}: ${errText}`);
  }

  return response.json() as Promise<AnthropicResponse>;
}

// ── Public entry point ────────────────────────────────────────────────────────

/**
 * Run the full tool-calling agent loop.
 * Automatically selects the right adapter based on provider type.
 */
export async function runAgentToolLoop(opts: ToolLoopOptions): Promise<void> {
  const { provider, onDone, onError } = opts;

  try {
    let finalText: string;

    if (provider.type === "anthropic") {
      finalText = await runAnthropicToolLoop(opts);
    } else if (provider.type === "gemini") {
      finalText = await runGeminiToolLoop(opts);
    } else {
      // openai-compatible, groq, ollama, mistral, etc.
      finalText = await runJsonFallbackToolLoop(opts);
    }

    onDone?.(finalText);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    onError?.(message);
  }
}
