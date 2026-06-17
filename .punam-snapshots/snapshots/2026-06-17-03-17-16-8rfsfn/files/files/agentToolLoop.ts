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
  const fileHint = activeFilePath
    ? `\n\nCurrently open in editor: ${activeFilePath}`
    : "";

  // Anthropic messages format
  type Message =
    | { role: "user"; content: string | AnthropicContent[] }
    | { role: "assistant"; content: AnthropicContent[] };

  type AnthropicContent =
    | { type: "text"; text: string }
    | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
    | { type: "tool_result"; tool_use_id: string; content: string; is_error?: boolean };

  const messages: Message[] = [
    { role: "user", content: task + fileHint },
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
// Gemini's function calling API uses a different schema than Anthropic:
//   - Tools are passed as `tools: [{ functionDeclarations: [...] }]`
//   - Tool calls come back as `candidates[0].content.parts[].functionCall`
//   - Tool results are sent back as `parts[].functionResponse`
//   - Multi-turn is done via the `contents` array (role: user / model)
//
// Your existing call_gemini_stream Tauri command doesn't support function
// calling (it only takes userPrompt as a string). So we call the Gemini
// REST API directly via fetch — same pattern as the Anthropic path.
// The API key comes from provider.apiKey, model from modelId.

interface GeminiPart {
  text?: string;
  functionCall?: { name: string; args: Record<string, unknown> };
  functionResponse?: { name: string; response: { content: string } };
}

interface GeminiContent {
  role: "user" | "model";
  parts: GeminiPart[];
}

interface GeminiResponse {
  candidates: Array<{
    content: { role: string; parts: GeminiPart[] };
    finishReason: string;
  }>;
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
  contents: GeminiContent[]
): Promise<GeminiResponse> {
  // Gemini 1.5+ supports system_instruction
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelId}:generateContent?key=${apiKey}`;

  const body = {
    system_instruction: { parts: [{ text: systemPrompt }] },
    contents,
    tools: [{ functionDeclarations: toGeminiFunctionDeclarations() }],
    // ANY mode = model decides when to call tools; AUTO is default but explicit is safer
    tool_config: { function_calling_config: { mode: "AUTO" } },
    generationConfig: { temperature: 0.3, maxOutputTokens: 8192 },
  };

  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`Gemini API error ${resp.status}: ${errText.slice(0, 300)}`);
  }

  return resp.json() as Promise<GeminiResponse>;
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

  const fileHint = activeFilePath
    ? `\n\nCurrently open in editor: ${activeFilePath}`
    : "";

  const contents: GeminiContent[] = [
    { role: "user", parts: [{ text: task + fileHint }] },
  ];

  let finalText = "";

  for (let round = 0; round < maxRounds; round++) {
    const response = await callGeminiWithTools(
      provider.apiKey,
      modelId,
      systemPrompt,
      contents
    );

    const candidate = response.candidates?.[0];
    if (!candidate) throw new Error("Gemini returned no candidates");

    const parts = candidate.content?.parts ?? [];
    const finishReason = candidate.finishReason;

    // Collect text parts
    const textParts = parts.filter((p): p is { text: string } => typeof p.text === "string");
    if (textParts.length > 0) {
      finalText = textParts.map((p) => p.text).join("");
    }

    // Collect function call parts
    const fnCalls = parts.filter(
      (p): p is { functionCall: { name: string; args: Record<string, unknown> } } =>
        p.functionCall !== undefined
    );

    // If no tool calls or model is done, return final answer
    if (fnCalls.length === 0 || finishReason === "STOP") {
      return finalText;
    }

    // Push the model's response (with tool calls) into history
    contents.push({ role: "model", parts });

    // Execute all tool calls and collect function responses
    const responseParts: GeminiPart[] = [];
    await Promise.all(
      fnCalls.map(async (fc) => {
        onToolCall?.(fc.functionCall.name);
        const result = await executeAgentTool(
          {
            tool: fc.functionCall.name as ToolCall["name"],
            input: fc.functionCall.args,
          },
          projectPath
        );
        responseParts.push({
          functionResponse: {
            name: fc.functionCall.name,
            response: { content: result.content },
          },
        });
      })
    );

    // Feed results back as a user turn (Gemini requires this)
    contents.push({ role: "user", parts: responseParts });
  }

  return finalText || "Max tool rounds reached.";
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
