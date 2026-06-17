// src/utils/agentToolLoop.ts
//
// Phase 1 — Agent Tool-Calling Orchestration Loop
//
// This module handles:
//   1. Native tool calling for Anthropic (claude-*) providers
//   2. Gemini function calling adapter
//   3. JSON-fallback for all other providers (openai-compatible, groq, etc.)

import type { AIProviderConfig, ResponseMetrics } from "./providers";
import {
  AGENT_TOOL_DEFINITIONS,
  executeAgentTool,
  normalizeAgentToolCall,
  buildToolSystemPrompt,
  parseJsonToolCall,
  type AgentToolName,
  type ToolCall,
  type ToolResult,
} from "./agentTools";

// ── Tool loop inputs ──────────────────────────────────────────────────────────

export interface ToolLoopOptions {
  provider: AIProviderConfig;
  modelId: string;
  systemPrompt: string; // from contextEngine (no file snippets needed)
  task: string; // the user's question / request
  projectPath: string;
  activeFilePath?: string | null; // hint — tool loop can use if needed
  maxRounds?: number; // default 10
  signal?: AbortSignal; // AbortController signal for cancellation + timeout
  onToken?: (token: string) => void; // streaming token callback
  onToolCall?: (name: string, input?: Record<string, unknown>) => void; // called when a tool fires (for UI)
  onDone?: (finalText: string, metrics?: ResponseMetrics) => void; // called with the final answer
  onError?: (err: string) => void;
  onCancelled?: () => void;
  shouldCancel?: () => boolean;
  onMetrics?: (metrics: ResponseMetrics) => void;
}

class AgentToolLoopCancelled extends Error {
  constructor() {
    super("Agent tool loop cancelled");
    this.name = "AgentToolLoopCancelled";
  }
}

function throwIfCancelled(opts: ToolLoopOptions): void {
  if (opts.signal?.aborted) {
    throw new AgentToolLoopCancelled();
  }
  if (opts.shouldCancel?.()) {
    throw new AgentToolLoopCancelled();
  }
}

function isCancellationError(err: unknown): boolean {
  return err instanceof AgentToolLoopCancelled;
}

function recordLoopMetrics(opts: ToolLoopOptions, metrics?: ResponseMetrics): void {
  if (metrics) {
    opts.onMetrics?.(metrics);
  }
}

function combineLoopMetrics(
  provider: AIProviderConfig,
  modelId: string,
  metrics: ResponseMetrics[]
): ResponseMetrics | undefined {
  if (metrics.length === 0) return undefined;

  const hasErrors = metrics.some((item) => item.status === "error");
  const hasRateLimit = metrics.some((item) => item.status === "rate_limited");
  const sumOptional = (selector: (item: ResponseMetrics) => number | undefined) => {
    const values = metrics.map(selector).filter((value): value is number => typeof value === "number");
    return values.length > 0 ? values.reduce((total, value) => total + value, 0) : undefined;
  };

  const promptTokens = sumOptional((item) => item.promptTokens);
  const responseTokens = sumOptional((item) => item.responseTokens);
  const totalTokens = sumOptional((item) => item.totalTokens)
    ?? (promptTokens !== undefined || responseTokens !== undefined
      ? (promptTokens || 0) + (responseTokens || 0)
      : undefined);

  return {
    provider: provider.name,
    model: modelId,
    promptTokens,
    responseTokens,
    totalTokens,
    estimatedCostUsd: sumOptional((item) => item.estimatedCostUsd),
    estimatedCostInr: sumOptional((item) => item.estimatedCostInr),
    durationMs: metrics.reduce((total, item) => total + item.durationMs, 0),
    status: hasRateLimit ? "rate_limited" : hasErrors ? "error" : "success",
  };
}

interface ToolObservation {
  tool: string;
  input: Record<string, unknown>;
  content: string;
  isError?: boolean;
}

function formatToolInput(input: Record<string, unknown>): string {
  const entries = Object.entries(input).filter(([, value]) => value !== undefined && value !== null && value !== "");
  if (entries.length === 0) return "{}";
  return `{ ${entries.map(([key, value]) => `${key}: ${JSON.stringify(value)}`).join(", ")} }`;
}

const INTERNAL_TOOL_NAMES: AgentToolName[] = [
  "read_lines",
  "read_file",
  "search_in_project",
  "list_files",
  "apply_patch",
  "write_file",
  "run_command",
];

function getExplicitToolNames(task: string): AgentToolName[] {
  const normalized = task.toLowerCase();
  return INTERNAL_TOOL_NAMES.filter((toolName) => normalized.includes(toolName));
}

function getFirstQuotedValue(task: string): string | null {
  const match = task.match(/"([^"]+)"|'([^']+)'|`([^`]+)`/);
  return match?.[1] || match?.[2] || match?.[3] || null;
}

function getPathLikeValue(task: string): string | null {
  const quoted = getFirstQuotedValue(task);
  if (quoted) return quoted;

  const pathMatch = task.match(/\b[\w./\\-]+\.(?:json|tsx?|jsx?|css|html|md|rs|toml|cjs|mjs|js)\b/i);
  return pathMatch?.[0] ?? null;
}

function getLineRange(task: string): { startLine: number; endLine: number } {
  const rangeMatch = task.match(/\b(?:lines?|line)\s+(\d+)\s*(?:-|to|through)\s*(\d+)\b/i);
  if (rangeMatch) {
    return {
      startLine: Number(rangeMatch[1]),
      endLine: Number(rangeMatch[2]),
    };
  }

  const singleLineMatch = task.match(/\b(?:lines?|line)\s+(\d+)\b/i);
  if (singleLineMatch) {
    const startLine = Number(singleLineMatch[1]);
    return { startLine, endLine: startLine };
  }

  return { startLine: 1, endLine: 80 };
}

function buildExplicitReadOnlyToolCall(task: string): { tool: AgentToolName; input: Record<string, unknown> } | null {
  const explicitTools = getExplicitToolNames(task);
  const readOnlyTools = explicitTools.filter((toolName) =>
    toolName === "list_files" ||
    toolName === "search_in_project" ||
    toolName === "read_file" ||
    toolName === "read_lines"
  );

  if (readOnlyTools.length !== 1 || explicitTools.length !== 1) return null;

  const tool = readOnlyTools[0];
  if (tool === "list_files") {
    return { tool, input: {} };
  }

  if (tool === "search_in_project") {
    const query = getFirstQuotedValue(task) || task.match(/\bsearch(?:\s+for)?\s+([^\n.]+)$/i)?.[1]?.trim();
    if (!query) return null;
    return { tool, input: { query } };
  }

  const path = getPathLikeValue(task);
  if (!path) return null;

  if (tool === "read_file") {
    return { tool, input: { path } };
  }

  const { startLine, endLine } = getLineRange(task);
  return { tool, input: { path, start_line: startLine, end_line: endLine } };
}

function truncateForFinalAnswer(text: string, maxChars = 4000): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n\n[truncated ${text.length - maxChars} chars]`;
}

function toolCallKey(tool: string, input: Record<string, unknown>): string {
  const sortValue = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(sortValue);
    if (value && typeof value === "object") {
      return Object.keys(value as Record<string, unknown>)
        .sort()
        .reduce<Record<string, unknown>>((acc, key) => {
          acc[key] = sortValue((value as Record<string, unknown>)[key]);
          return acc;
        }, {});
    }
    return value;
  };
  return `${tool}:${JSON.stringify(sortValue(input))}`;
}

function duplicateToolResult(tool: string): string {
  return `Skipped duplicate ${tool} call because the same tool input was already used in this run. Use the earlier result and write the final answer if you have enough information.`;
}

function recordToolObservation(
  observations: ToolObservation[],
  tool: string,
  input: Record<string, unknown>,
  result: ToolResult
): void {
  observations.push({
    tool,
    input,
    content: result.content,
    isError: result.is_error,
  });
}

function fallbackFinalAnswer(task: string, observations: ToolObservation[], lastText: string): string {
  if (lastText.trim() && !parseJsonToolCall(lastText)) {
    return lastText.trim();
  }

  const toolSummary = observations.length > 0
    ? observations
        .map((obs, index) => `${index + 1}. ${obs.tool} ${JSON.stringify(obs.input)}${obs.isError ? " (error)" : ""}`)
        .join("\n")
    : "No tool results were collected.";

  return [
    "I inspected the project with the available tools, but the model did not produce a final written answer before the tool budget ended.",
    "",
    "Original task:",
    task,
    "",
    "Tools used:",
    toolSummary,
    "",
    "Please retry with a narrower request if you need a deeper summary.",
  ].join("\n");
}

async function synthesizeFinalAnswer(
  opts: ToolLoopOptions,
  observations: ToolObservation[],
  lastText = ""
): Promise<string> {
  throwIfCancelled(opts);

  const observationText = observations.length > 0
    ? observations.map((obs, index) => [
        `## Tool result ${index + 1}: ${obs.tool}`,
        `Input: ${JSON.stringify(obs.input)}`,
        obs.isError ? "Status: error" : "Status: success",
        "Result:",
        truncateForFinalAnswer(obs.content),
      ].join("\n")).join("\n\n")
    : "No tool results were collected.";
  const ledgerText = observations.length > 0
    ? observations.map((obs, index) =>
        `${index + 1}. ${obs.tool} ${formatToolInput(obs.input)}${obs.isError ? " -> error" : " -> success"}`
      ).join("\n")
    : "No internal agent tools were executed.";

  const { sendToProviderStreaming } = await import("./providers");
  const resp = await sendToProviderStreaming(opts.provider, opts.modelId, {
    systemPrompt: [
      opts.systemPrompt,
      "",
      "INTERNAL TOOL TRUTH:",
      "- list_files, read_file, read_lines, search_in_project, run_command, apply_patch, and write_file are internal agent tools.",
      "- Do not describe internal tool use as PowerShell, Get-ChildItem, dir, ls, or terminal execution unless the run_command tool actually ran such a command.",
      "- The tool usage ledger below is the source of truth for what tools were actually used.",
      "- Only say a file was read if the ledger contains read_file or read_lines for that path.",
      "- If a file appears only in search_in_project results, say it was found by search, not read.",
      "",
      "FINAL ANSWER MODE:",
      "- Tools are now disabled.",
      "- Do not output JSON tool calls.",
      "- Do not ask for another tool.",
      "- Write the final answer in plain text for the user.",
      "- If the evidence is incomplete, say what you could determine from the collected tool results.",
    ].join("\n"),
    userPrompt: [
      "Original task:",
      opts.task,
      "",
      "Collected tool results:",
      observationText,
      "",
      "Tool usage ledger:",
      ledgerText,
      "",
      "Last assistant text before finalization:",
      lastText.trim() || "(none)",
      "",
      "Write the final answer now.",
    ].join("\n"),
    signal: opts.signal,
  });
  recordLoopMetrics(opts, resp.metrics);

  throwIfCancelled(opts);

  if (resp.success && resp.text.trim() && !parseJsonToolCall(resp.text)) {
    return resp.text.trim();
  }

  return fallbackFinalAnswer(opts.task, observations, lastText);
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
  const observations: ToolObservation[] = [];
  const seenToolCalls = new Set<string>();

  for (let round = 0; round < maxRounds; round++) {
    throwIfCancelled(opts);
    // Call Anthropic via Tauri backend streaming endpoint
    const response = await callAnthropicWithTools(
      provider,
      modelId,
      systemPrompt,
      messages,
      onToken
    );
    throwIfCancelled(opts);

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
        throwIfCancelled(opts);
        const normalized = normalizeAgentToolCall(
          { id: block.id, name: block.name as ToolCall["name"], input: block.input }
        ) as ToolCall;
        const input = normalized.input as Record<string, unknown>;
        const key = toolCallKey(normalized.name, input);
        if (seenToolCalls.has(key)) {
          toolResults.push({
            type: "tool_result",
            tool_use_id: block.id,
            content: duplicateToolResult(normalized.name),
            is_error: false,
          });
          return;
        }
        seenToolCalls.add(key);
        onToolCall?.(normalized.name, input);
        throwIfCancelled(opts);
        const result: ToolResult = await executeAgentTool(normalized, projectPath);
        throwIfCancelled(opts);
        recordToolObservation(observations, normalized.name, input, result);
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

  return synthesizeFinalAnswer(opts, observations, finalText);
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
    onToolCall,
  } = opts;

  const fileHint = activeFilePath
    ? `\n\nCurrently open in editor: ${activeFilePath}`
    : "";

  // Inject tool instructions into system prompt
  const fullSystem = `${systemPrompt}\n\n${buildToolSystemPrompt()}`;

  // Build a simple text conversation
  const conversationParts: string[] = [];
  const observations: ToolObservation[] = [];
  const seenToolCalls = new Set<string>();
  let userTurn = task + fileHint;
  let lastText = "";

  for (let round = 0; round < maxRounds; round++) {
    throwIfCancelled(opts);
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
      signal: opts.signal,
    });
    recordLoopMetrics(opts, resp.metrics);

    if (!resp.success) {
      throw new Error(resp.error || "Provider error");
    }

    throwIfCancelled(opts);
    const responseText = resp.text;
    lastText = responseText;

    // Try to parse a tool call from the response
    const toolCall = parseJsonToolCall(responseText);

    if (!toolCall) {
      // If the model hinted at tool use (e.g. "Let me list all files") but
      // didn't output a JSON block, push it to produce the tool call.
      const toolIntent = /\b(list|read|search|find|check|look|show|get)\b/i;
      if (toolIntent.test(responseText)) {
        conversationParts.push(
          `Assistant:\n${responseText}`,
          "Tool result: Please output ONLY a JSON tool call block (```json { \"tool\": \"...\", \"input\": {...} } ```) to proceed. Do not output any other text."
        );
        userTurn = "Output the tool call now.";
        continue;
      }
      // No tool call and no tool intent — this is the final answer
      return responseText;
    }

    // Execute the tool
    throwIfCancelled(opts);
    const normalizedToolCall = normalizeAgentToolCall(toolCall);
    const normalizedName = "tool" in normalizedToolCall ? normalizedToolCall.tool : normalizedToolCall.name;
    const normalizedInput = normalizedToolCall.input as Record<string, unknown>;
    const key = toolCallKey(normalizedName, normalizedInput);
    if (seenToolCalls.has(key)) {
      conversationParts.push(
        `Assistant:\n${responseText}`,
        `Tool result (${normalizedName}):\n${duplicateToolResult(normalizedName)}`
      );
      userTurn = "Do not repeat the same tool call. Write the final answer now if you have enough information, or choose a different useful tool.";
      continue;
    }
    seenToolCalls.add(key);
    onToolCall?.(normalizedName, normalizedInput);
    throwIfCancelled(opts);
    const result = await executeAgentTool(normalizedToolCall, projectPath);
    throwIfCancelled(opts);
    recordToolObservation(observations, normalizedName, normalizedInput, result);

    // Append to conversation history
    conversationParts.push(
      `Assistant:\n${responseText}`,
      `Tool result (${normalizedName}):\n${result.content}`
    );

    // Next user turn is empty (continue reasoning)
    userTurn = "Continue based on the tool result above.";
  }

  return synthesizeFinalAnswer(opts, observations, lastText);
}

// ── Gemini native function calling ───────────────────────────────────────────

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
  const observations: ToolObservation[] = [];
  const seenToolCalls = new Set<string>();

  for (let round = 0; round < maxRounds; round++) {
    throwIfCancelled(opts);
    const response = await callGeminiWithTools(
      provider.apiKey,
      modelId,
      systemPrompt,
      contents
    );
    throwIfCancelled(opts);

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
        throwIfCancelled(opts);
        const normalized = normalizeAgentToolCall({
          tool: fc.functionCall.name as ToolCall["name"],
          input: fc.functionCall.args,
        });
        const normalizedName = "tool" in normalized ? normalized.tool : normalized.name;
        const input = normalized.input as Record<string, unknown>;
        const key = toolCallKey(normalizedName, input);
        if (seenToolCalls.has(key)) {
          responseParts.push({
            functionResponse: {
              name: normalizedName,
              response: { content: duplicateToolResult(normalizedName) },
            },
          });
          return;
        }
        seenToolCalls.add(key);
        onToolCall?.(normalizedName, input);
        throwIfCancelled(opts);
        const result = await executeAgentTool(normalized, projectPath);
        throwIfCancelled(opts);
        recordToolObservation(observations, normalizedName, input, result);
        responseParts.push({
          functionResponse: {
            name: normalizedName,
            response: { content: result.content },
          },
        });
      })
    );

    // Feed results back as a user turn (Gemini requires this)
    contents.push({ role: "user", parts: responseParts });
  }

  return synthesizeFinalAnswer(opts, observations, finalText);
}

// ── Anthropic API call (via fetch) ────────────────────────────────────────────

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
  const { provider, onDone, onError, onCancelled } = opts;
  const collectedMetrics: ResponseMetrics[] = [];
  const perRoundTimeoutMs = 120_000; // 2 min hard timeout per LLM round
  let timeoutId: ReturnType<typeof setTimeout> | null = null;
  const loopOpts: ToolLoopOptions = {
    ...opts,
    onMetrics: (metrics) => {
      collectedMetrics.push(metrics);
      opts.onMetrics?.(metrics);
    },
  };

  try {
    throwIfCancelled(loopOpts);
    // If no external AbortController was provided, create one with a hard per-round timeout
    if (!loopOpts.signal) {
      const internalController = new AbortController();
      loopOpts.signal = internalController.signal;
      timeoutId = setTimeout(() => {
        if (!internalController.signal.aborted) {
          internalController.abort();
        }
      }, perRoundTimeoutMs);
    }
    throwIfCancelled(loopOpts);
    const explicitReadOnlyToolCall = buildExplicitReadOnlyToolCall(opts.task);
    if (explicitReadOnlyToolCall) {
      const normalized = normalizeAgentToolCall(explicitReadOnlyToolCall);
      const normalizedName = "tool" in normalized ? normalized.tool : normalized.name;
      const normalizedInput = normalized.input as Record<string, unknown>;
      loopOpts.onToolCall?.(normalizedName, normalizedInput);
      const result = await executeAgentTool(normalized, opts.projectPath);
      throwIfCancelled(loopOpts);
      const observations: ToolObservation[] = [];
      recordToolObservation(
        observations,
        normalizedName,
        normalizedInput,
        result
      );
      const finalText = await synthesizeFinalAnswer(loopOpts, observations, "");
      throwIfCancelled(loopOpts);
      onDone?.(finalText, combineLoopMetrics(provider, opts.modelId, collectedMetrics));
      return;
    }

    let finalText: string;

    if (provider.type === "anthropic") {
      finalText = await runAnthropicToolLoop(loopOpts);
    } else if (provider.type === "gemini") {
      finalText = await runGeminiToolLoop(loopOpts);
    } else {
      // openai-compatible, groq, ollama, mistral, etc.
      finalText = await runJsonFallbackToolLoop(loopOpts);
    }

    throwIfCancelled(loopOpts);
    onDone?.(finalText, combineLoopMetrics(provider, opts.modelId, collectedMetrics));
  } catch (err) {
    if (isCancellationError(err)) {
      onCancelled?.();
      return;
    }
    const message = err instanceof Error ? err.message : String(err);
    onError?.(message);
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}
