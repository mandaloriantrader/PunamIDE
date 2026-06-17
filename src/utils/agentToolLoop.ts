// src/utils/agentToolLoop.ts
//
// Phase 1 — Agent Tool-Calling Orchestration Loop
// Phase 2 — Planner Stage + Auto-Verifier Loop
//
// This module handles:
//   1. Native tool calling for Anthropic (claude-*) providers
//   2. Gemini function calling adapter
//   3. JSON-fallback for all other providers (openai-compatible, groq, etc.)
//   4. Planner: LLM-generated step-by-step plan before tool execution
//   5. Verifier: auto-runs typecheck/lint/test after patches, retries on failure

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
  /** Phase 2: Called when the planner produces a step-by-step plan before tool execution */
  onPlanReady?: (plan: AgentPlan) => void;
  /** Phase 2: Called when auto-verification runs after patch application */
  onVerifyResult?: (result: VerifyResult) => void;
  /** Phase 2: Enable auto-verification loop (default: true when project has package.json) */
  enableAutoVerify?: boolean;
}

/** Structured plan produced by the Planner stage */
export interface AgentPlan {
  goal: string;
  steps: Array<{ index: number; description: string; tool_hint?: string }>;
  generatedAt: number;
}

/** Result from the auto-verification stage */
export interface VerifyResult {
  passed: boolean;
  checks: Array<{ name: string; passed: boolean; output: string }>;
  retryCount: number;
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
  "symbol_lookup",
  "find_callers",
  "find_callees",
  "semantic_search",
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

  const fileHint = activeFilePath
    ? `\n\nCurrently open in editor: ${activeFilePath}`
    : "";

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
    const response = await callAnthropicWithTools(
      provider,
      modelId,
      systemPrompt,
      messages,
      onToken
    );
    throwIfCancelled(opts);

    const textBlocks = response.content.filter(
      (b): b is { type: "text"; text: string } => b.type === "text"
    );
    const toolUseBlocks = response.content.filter(
      (b): b is ToolCall & { type: "tool_use" } => b.type === "tool_use"
    );

    if (textBlocks.length > 0) {
      finalText = textBlocks.map((b) => b.text).join("");
    }

    if (response.stop_reason === "end_turn" || toolUseBlocks.length === 0) {
      return finalText;
    }

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

  const fullSystem = `${systemPrompt}\n\n${buildToolSystemPrompt()}`;

  const conversationParts: string[] = [];
  const observations: ToolObservation[] = [];
  const seenToolCalls = new Set<string>();
  let userTurn = task + fileHint;
  let lastText = "";

  for (let round = 0; round < maxRounds; round++) {
    throwIfCancelled(opts);
    const fullPrompt =
      conversationParts.length > 0
        ? conversationParts.join("\n\n") + "\n\nUser: " + userTurn
        : userTurn;

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

    const toolCall = parseJsonToolCall(responseText);

    if (!toolCall) {
      const toolIntent = /\b(list|read|search|find|check|look|show|get)\b/i;
      if (toolIntent.test(responseText)) {
        conversationParts.push(
          `Assistant:\n${responseText}`,
          "Tool result: Please output ONLY a JSON tool call block (```json { \"tool\": \"...\", \"input\": {...} } ```) to proceed. Do not output any other text."
        );
        userTurn = "Output the tool call now.";
        continue;
      }
      return responseText;
    }

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

    conversationParts.push(
      `Assistant:\n${responseText}`,
      `Tool result (${normalizedName}):\n${result.content}`
    );

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
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelId}:generateContent?key=${apiKey}`;

  const body = {
    system_instruction: { parts: [{ text: systemPrompt }] },
    contents,
    tools: [{ functionDeclarations: toGeminiFunctionDeclarations() }],
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

    const textParts = parts.filter((p): p is { text: string } => typeof p.text === "string");
    if (textParts.length > 0) {
      finalText = textParts.map((p) => p.text).join("");
    }

    const fnCalls = parts.filter(
      (p): p is { functionCall: { name: string; args: Record<string, unknown> } } =>
        p.functionCall !== undefined
    );

    if (fnCalls.length === 0 || finishReason === "STOP") {
      return finalText;
    }

    contents.push({ role: "model", parts });

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

// ── Planner Stage (Phase 2) ──────────────────────────────────────────────────

/**
 * Generate a structured plan before the main tool loop starts.
 * Uses a cheap/fast LLM call to produce a 3-5 step exploration plan.
 * Falls back silently if the LLM call fails — the agent still works reactively.
 */
async function generatePlan(opts: ToolLoopOptions): Promise<AgentPlan | null> {
  try {
    const { sendToProviderStreaming } = await import("./providers");
    const planSystemPrompt = [
      "You are a planning assistant. Given a user's task, produce a concise step-by-step plan.",
      "Output ONLY a JSON object with format:",
      '{ "goal": "brief goal", "steps": [ {"index":1,"description":"step description"} ] }',
      "No markdown, no explanation — only the JSON object.",
      "Maximum 5 steps. Each step describes WHAT to investigate, not HOW.",
    ].join("\n");
    const planPrompt = `Task: ${opts.task}\n\nProject: ${opts.projectPath}\n${opts.activeFilePath ? "Active file: " + opts.activeFilePath : ""}\n\nProduce the plan JSON:`;

    const resp = await sendToProviderStreaming(opts.provider, opts.modelId, {
      systemPrompt: planSystemPrompt,
      userPrompt: planPrompt,
      signal: opts.signal,
    });
    if (!resp.success || !resp.text.trim()) return null;

    const jsonMatch = resp.text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;
    const parsed = JSON.parse(jsonMatch[0]) as { goal: string; steps: Array<{ index: number; description: string }> };
    if (!parsed.goal || !Array.isArray(parsed.steps)) return null;

    const plan: AgentPlan = {
      goal: parsed.goal,
      steps: parsed.steps.slice(0, 5).map((s, i) => ({ index: i + 1, description: s.description })),
      generatedAt: Date.now(),
    };
    opts.onPlanReady?.(plan);
    return plan;
  } catch {
    return null;
  }
}

// ── Verification Stage (Phase 2) ─────────────────────────────────────────────

/** Auto-detect what verification commands to run based on project structure */
async function detectVerificationCommands(projectPath: string): Promise<string[]> {
  const commands: string[] = [];
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    const pkgExists = await invoke<boolean>("path_exists", { path: "package.json" });
    if (pkgExists) {
      try {
        const pkgContent = await invoke<string>("read_file", { path: "package.json" });
        const pkg = JSON.parse(pkgContent);
        if (pkg.scripts?.typecheck) commands.push("npm run typecheck 2>&1");
        else if (pkg.scripts?.["type-check"]) commands.push("npm run type-check 2>&1");
        else if (pkg.devDependencies?.typescript || pkg.dependencies?.typescript) {
          const tsconfigExists = await invoke<boolean>("path_exists", { path: "tsconfig.json" });
          if (tsconfigExists) commands.push("npx tsc --noEmit 2>&1");
        }
        if (pkg.scripts?.lint) commands.push("npm run lint 2>&1");
        if (pkg.scripts?.test && !/no test/i.test(pkg.scripts.test)) {
          commands.push("npm test -- --run 2>&1");
        }
      } catch { /* package.json parse failed — skip */ }
    }
    const cargoExists = await invoke<boolean>("path_exists", { path: "Cargo.toml" });
    if (cargoExists) {
      commands.push("cargo check 2>&1");
    }
    const pyprojectExists = await invoke<boolean>("path_exists", { path: "pyproject.toml" });
    if (pyprojectExists) {
      commands.push("ruff check . 2>&1");
    }
  } catch { /* detection failed — skip */ }
  return commands;
}

/** Run verification commands and return results */
async function runVerification(
  projectPath: string,
  opts: ToolLoopOptions,
  retryCount: number,
): Promise<VerifyResult> {
  const verifCommands = await detectVerificationCommands(projectPath);
  if (verifCommands.length === 0) {
    return { passed: true, checks: [], retryCount };
  }

  const checks: VerifyResult["checks"] = [];
  let allPassed = true;

  for (const cmd of verifCommands) {
    try {
      const result = await executeAgentTool(
        { name: "run_command", input: { command: cmd, cwd: projectPath }, id: `verify-${Date.now()}` } as unknown as ToolCall,
        projectPath
      );
      const output = result.content.slice(0, 2000);
      const failed = result.is_error ||
        (/\berror\b/i.test(output) && !/0 errors|no errors|error 0/i.test(output)) ||
        result.content.includes("FAIL") ||
        result.content.includes("failed");
      checks.push({ name: cmd, passed: !failed, output });
      if (failed) allPassed = false;
    } catch (err) {
      checks.push({ name: cmd, passed: false, output: String(err).slice(0, 500) });
      allPassed = false;
    }
  }

  const verifyResult: VerifyResult = { passed: allPassed, checks, retryCount };
  opts.onVerifyResult?.(verifyResult);
  return verifyResult;
}

// ── Public entry point ────────────────────────────────────────────────────────

/**
 * Run the full tool-calling agent loop.
 * Automatically selects the right adapter based on provider type.
 *
 * Phase 2 features:
 *   - Planner: generates a step-by-step plan before tool execution (calls onPlanReady)
 *   - Verifier: runs typecheck/lint/test after patch application (calls onVerifyResult)
 *               retries up to 2 times if verification fails, feeding errors back to the model
 */
export async function runAgentToolLoop(opts: ToolLoopOptions): Promise<void> {
  const { provider, onDone, onError, onCancelled } = opts;
  const collectedMetrics: ResponseMetrics[] = [];
  const perRoundTimeoutMs = 120_000;
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
    if (!loopOpts.signal) {
      const internalController = new AbortController();
      loopOpts.signal = internalController.signal;
      timeoutId = setTimeout(() => {
        if (!internalController.signal.aborted) {
          internalController.abort();
        }
      }, perRoundTimeoutMs);
    }

    // ── Phase 2: Planner ───────────────────────────────────────────────
    // Generate a plan before tool execution (non-blocking — agent works without it)
    generatePlan(loopOpts).catch(() => {});

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
      recordToolObservation(observations, normalizedName, normalizedInput, result);
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
      finalText = await runJsonFallbackToolLoop(loopOpts);
    }

    throwIfCancelled(loopOpts);

    // ── Phase 2: Auto-Verifier ─────────────────────────────────────────
    // After successful agent run, verify changes if any write/patch tools were used
    const shouldVerify = opts.enableAutoVerify !== false;
    if (shouldVerify) {
      const MAX_RETRIES = 2;
      for (let retry = 0; retry <= MAX_RETRIES; retry++) {
        const verifyResult = await runVerification(opts.projectPath, loopOpts, retry);
        if (verifyResult.passed) break;
        if (retry < MAX_RETRIES) {
          // Feed errors back to the model for self-correction
          const failedChecks = verifyResult.checks.filter(c => !c.passed);
          const errorFeedback = [
            "AUTO-VERIFICATION FAILED. The following checks did not pass:",
            ...failedChecks.map(c => `- ${c.name}\n${c.output.slice(0, 500)}`),
            "",
            "Please fix the issues above and produce corrected file changes.",
          ].join("\n");
          const correctionOpts: ToolLoopOptions = {
            ...loopOpts,
            task: `Fix the following verification failures in ${opts.projectPath}:\n\n${errorFeedback}`,
            maxRounds: 4,
          };
          try {
            if (provider.type === "anthropic") {
              finalText = await runAnthropicToolLoop(correctionOpts);
            } else if (provider.type === "gemini") {
              finalText = await runGeminiToolLoop(correctionOpts);
            } else {
              finalText = await runJsonFallbackToolLoop(correctionOpts);
            }
          } catch {
            break; // if correction fails, stop retrying
          }
        }
      }
    }

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