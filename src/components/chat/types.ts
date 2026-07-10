// src/components/chat/types.ts
//
// Types specific to the AiChat component and its sub-modules.

import type { ParsedResponse } from "../../utils/prompts";
import type { AIProviderConfig, ResponseMetrics } from "../../utils/providers";
import type { FileEntry, AppConfig } from "../../utils/tauri";
import type { MCPServerConfig } from "../../utils/mcp";
import type { ChatMessage, ProjectCheckResult, OpenTabContext, AgentMode } from "../../types";
import type { RunObservation } from "../../services/run/verifiedRun";

export type AgentStep = "planning" | "proposing_fix" | "awaiting_approval" | "awaiting_run" | "running_command" | "analyzing_output" | "verifying" | "completed" | "stopped";

export interface AgentTaskState {
  active: boolean;
  task: string;
  step: AgentStep;
  attempt: number;
  maxAttempts: number;
  history: string[];
  suggestedCommand: string | null;
  autoApply: boolean;
  subtasks: string[];
  currentSubtask: number;
}

export interface AgentTrace {
  routeType: string;
  reason: string;
  tools: string[];
  status: string;
  finalText: string;
}

export interface AiChatProps {
  config: AppConfig;
  projectPath: string;
  files: FileEntry[];
  openTabs: OpenTabContext[];
  activeFilePath?: string;
  selectedText?: string;
  problems?: Array<{ severity: string; message: string; path: string; line: number }>;
  terminalOutput?: string;
  aiProviders?: AIProviderConfig[];
  proactiveError?: { command: string; output: string } | null;
  runObservation?: RunObservation | null;
  onDismissProactiveError?: () => void;
  onDismissRunObservation?: () => void;
  checkResult?: ProjectCheckResult | null;
  checkingProject?: boolean;
  onRunProjectCheck?: () => void;
  onApplyChanges: (parsed: ParsedResponse) => Promise<boolean>;
  onApplyDirect?: (parsed: ParsedResponse) => Promise<void>;
  onRunCommand?: (cmd: string) => void;
  onRevertLastApply?: () => Promise<void>;
  checkpointCount?: number;
  mcpServers?: MCPServerConfig[];
  projectNotes?: string;
  forcePrompt?: { text: string; mode?: string } | null;
  onForcePromptConsumed?: () => void;
}

export function createAgentTask(task: string): AgentTaskState {
  // Parse subtasks if the user provided a numbered list
  const subtaskPattern = /^\s*(?:\d+[\.\)]\s*|[-*]\s+)(.+)$/gm;
  const matches = [...task.matchAll(subtaskPattern)];
  const subtasks = matches.length > 1
    ? matches.map(m => m[1].trim())
    : [task];

  return {
    active: true,
    task,
    step: "planning",
    attempt: 1,
    maxAttempts: 15,
    history: [],
    suggestedCommand: null,
    autoApply: false,
    subtasks,
    currentSubtask: 0,
  };
}

export function hasParsedActions(parsed: ParsedResponse): boolean {
  return (
    parsed.fileChanges.length > 0 ||
    parsed.deletions.length > 0 ||
    parsed.commands.length > 0 ||
    parsed.editOperations.length > 0
  );
}

export function parseAgentTraceMessage(content: string): AgentTrace | null {
  if (!content.startsWith("Agent route")) return null;

  const traceEnd = content.indexOf("\n\n");
  const traceText = traceEnd >= 0 ? content.slice(0, traceEnd) : content;
  const finalText = traceEnd >= 0 ? content.slice(traceEnd + 2).replace(/�$/, "").trim() : "";
  const lines = traceText.split("\n").map((line) => line.trim());
  const toolsIndex = lines.findIndex((line) => line === "Tools used");
  const statusLine = lines.find((line) => line.startsWith("Status:"));
  const tools = toolsIndex >= 0
    ? lines.slice(toolsIndex + 1)
        .filter((line) => line.startsWith("- "))
        .map((line) => line.slice(2))
    : [];

  return {
    routeType: lines.find((line) => line.startsWith("Type:"))?.replace("Type:", "").trim() || "agent",
    reason: lines.find((line) => line.startsWith("Reason:"))?.replace("Reason:", "").trim() || "Using internal tools.",
    tools,
    status: statusLine?.replace("Status:", "").trim() || "Running...",
    finalText,
  };
}

export function summarizeCommandOutput(output: string, maxLines = 12): string {
  return output
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) =>
      line.trim() &&
      !/^Punam AI -> Running command$/i.test(line.trim()) &&
      !/^PS>\s*/.test(line.trim()) &&
      !/^Process finished successfully/i.test(line.trim()) &&
      !/^Process exited with code/i.test(line.trim())
    )
    .slice(-maxLines)
    .join("\n");
}

export function hasUsableProvider(provider: AIProviderConfig): boolean {
  return provider.models.some((model) => model.enabled && model.id) &&
    (Boolean(provider.apiKey) || /ollama/i.test(provider.name) || /localhost:11434/i.test(provider.baseUrl || ""));
}

export function recordResponseUsage(metrics?: ResponseMetrics): void {
  if (!metrics || metrics.status !== "success") return;
  // Fire-and-forget: avoid circular dependency at module load time
  void import("../UsageDashboard").then(({ recordUsage }) => {
    recordUsage(
      metrics.provider,
      metrics.model,
      metrics.promptTokens || 0,
      metrics.responseTokens || 0,
      metrics.estimatedCostInr
    );
  });
}
