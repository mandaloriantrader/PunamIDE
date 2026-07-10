// src/utils/toolLoops/shared.ts
//
// Shared types, utilities, and helper functions used by all tool loop implementations.

import type { AIProviderConfig, ResponseMetrics } from "../providers";
import type { AgentToolName, ToolCall, ToolResult } from "../agentTools";
import type { AmbiguityReport } from "../../services/agent/AmbiguityDetector";
import type { TokenBudget, BudgetStatus, BudgetConsumed, BudgetRemaining } from "../../services/agent/BudgetController";
import {
  normalizeAgentToolCall,
  parseJsonToolCall,
} from "../agentTools";

// ── Public types (re-exported from entry point) ──────────────────────────────

export interface ToolLoopOptions {
  provider: AIProviderConfig;
  modelId: string;
  systemPrompt: string;
  task: string;
  projectPath: string;
  activeFilePath?: string | null;
  maxRounds?: number;
  signal?: AbortSignal;
  onToken?: (token: string) => void;
  onToolCall?: (name: string, input?: Record<string, unknown>) => void;
  onToolResult?: (name: string, input: Record<string, unknown>, result: string, isError?: boolean) => void;
  onDone?: (finalText: string, metrics?: ResponseMetrics) => void;
  onError?: (err: string) => void;
  onCancelled?: () => void;
  shouldCancel?: () => boolean;
  onMetrics?: (metrics: ResponseMetrics) => void;
  onPlanReady?: (plan: AgentPlan) => void;
  onVerifyResult?: (result: VerifyResult) => void;
  enableAutoVerify?: boolean;
  /**
   * Called before apply_patch or write_file executes.
   * If provided, replaces the default window.confirm() dialog.
   * Returns true to allow the write, false to reject it.
   * Receives the file path, original content, and proposed new content.
   */
  onBeforeWrite?: (path: string, originalContent: string, newContent: string) => Promise<boolean>;
  /** Enable pre-flight ambiguity detection and clarification protocol */
  enableClarification?: boolean;
  /** Called when ambiguity is detected — UI should show clarification dialog and resolve with user's answer */
  onClarificationNeeded?: (report: AmbiguityReport) => Promise<string>;
  /** Brief project context string used by the ambiguity detector for contextual analysis */
  projectMemorySummary?: string;
  /** Per-task token/cost budget configuration. If undefined, no budget enforcement. */
  budget?: TokenBudget;
  /** Called when budget approaches limits — return 'continue' to keep going or 'stop' to halt */
  onBudgetWarning?: (status: BudgetStatus, consumed: BudgetConsumed, remaining: BudgetRemaining) => Promise<'continue' | 'stop'>;
  /** Enable unified context assembler for optimized multi-source context filling */
  enableContextOptimization?: boolean;
}

export interface AgentPlan {
  goal: string;
  steps: Array<{ index: number; description: string; tool_hint?: string }>;
  generatedAt: number;
}

export interface VerifyResult {
  passed: boolean;
  checks: Array<{ name: string; passed: boolean; output: string }>;
  retryCount: number;
}

// ── Verification types for self-correcting tool loop ─────────────────────────

export interface VerificationResult {
  matched: boolean;
  expectedSnippet: string;
  actualSnippet: string;
  matchLine?: number;
  similarityScore: number;
  divergenceReason?: "line_offset" | "content_mismatch" | "file_not_found";
}

export interface ToolResultWithVerification {
  success: boolean;
  output: string;
  verificationResult?: VerificationResult;
  attempt: number;           // 1-based
  maxAttempts: number;       // always 3
}

export const MAX_VERIFICATION_RETRIES = 3;

// ── Cancellation ─────────────────────────────────────────────────────────────

export class AgentToolLoopCancelled extends Error {
  constructor() {
    super("Agent tool loop cancelled");
    this.name = "AgentToolLoopCancelled";
  }
}

export function throwIfCancelled(opts: ToolLoopOptions): void {
  if (opts.signal?.aborted) {
    throw new AgentToolLoopCancelled();
  }
  if (opts.shouldCancel?.()) {
    throw new AgentToolLoopCancelled();
  }
}

export function isCancellationError(err: unknown): boolean {
  return err instanceof AgentToolLoopCancelled;
}

// ── Metrics ──────────────────────────────────────────────────────────────────

export function recordLoopMetrics(opts: ToolLoopOptions, metrics?: ResponseMetrics): void {
  if (metrics) {
    opts.onMetrics?.(metrics);
  }
}

export function combineLoopMetrics(
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

// ── Tool observation tracking ────────────────────────────────────────────────

export interface ToolObservation {
  tool: string;
  input: Record<string, unknown>;
  content: string;
  isError?: boolean;
}

export function formatToolInput(input: Record<string, unknown>): string {
  const entries = Object.entries(input).filter(([, value]) => value !== undefined && value !== null && value !== "");
  if (entries.length === 0) return "{}";
  return `{ ${entries.map(([key, value]) => `${key}: ${JSON.stringify(value)}`).join(", ")} }`;
}

export function toolCallKey(tool: string, input: Record<string, unknown>): string {
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

export function duplicateToolResult(tool: string): string {
  return `Skipped duplicate ${tool} call because the same tool input was already used in this run. Use the earlier result and write the final answer if you have enough information.`;
}

export function recordToolObservation(
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

// ── Explicit tool shortcut detection ─────────────────────────────────────────

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

export function buildExplicitReadOnlyToolCall(task: string): { tool: AgentToolName; input: Record<string, unknown> } | null {
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

// ── Truncation ───────────────────────────────────────────────────────────────

export function truncateForFinalAnswer(text: string, maxChars = 4000): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n\n[truncated ${text.length - maxChars} chars]`;
}

// ── Final answer synthesis ───────────────────────────────────────────────────

export function fallbackFinalAnswer(task: string, observations: ToolObservation[], lastText: string): string {
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

export async function synthesizeFinalAnswer(
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

  const { sendToProviderStreaming } = await import("../providers");
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
