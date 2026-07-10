/**
 * Shared types used across multiple components in PunamIDE.
 */

import type { ParsedResponse } from "../utils/prompts";
import type { ResponseMetrics } from "../utils/providers";
import type { StreamBlock } from "../utils/protocol";

// --- Agent Modes ---

export type AgentMode = "chat" | "agent";

// --- Checkpoints (multi-level undo) ---

export interface Checkpoint {
  id: string;
  label: string;
  timestamp: number;
  files: Array<{ path: string; previousContent: string }>;
}

// --- Tool Events (for message metadata) ---

export interface ToolEvent {
  kind: "tool_call" | "tool_result" | "command";
  name: string;
  input?: Record<string, unknown>;
  output?: string;
  timestamp?: number;
}

// --- Chat Messages ---

export interface ChatMessage {
  /** Stable unique identifier for this message (used for memoization comparisons). */
  id?: string;
  role: "user" | "assistant";
  /** Final user-visible answer (never contains <thinking> tags). */
  content: string;
  mode?: AgentMode;
  parsed?: ParsedResponse;
  applied?: boolean;
  checkResult?: ProjectCheckResult;
  metrics?: ResponseMetrics;
  attachments?: import("../utils/tauri").ChatAttachment[];
  multiResponses?: Array<{
    content: string;
    parsed?: ParsedResponse;
    applied?: boolean;
    metrics: ResponseMetrics;
  }>;
  /** Structured streaming blocks for Cline-like progressive rendering. */
  blocks?: StreamBlock[];
  /** True when the AI has finished streaming its full response. */
  isComplete?: boolean;
  /** Agent reasoning — extracted from <thinking> tags, never mixed into content. */
  thinking?: string;
  /** Tool execution events — stored separately from user-visible content. */
  toolEvents?: ToolEvent[];
}

// --- Project Check ---

export interface ProjectCheckResult {
  id: number;
  command: string;
  stdout: string;
  stderr: string;
  exitCode: number;
}

// --- Open Tab Context (for AI) ---

export interface OpenTabContext {
  path: string;
  name: string;
  content: string;
}