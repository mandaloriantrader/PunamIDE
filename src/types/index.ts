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

// --- Chat Messages ---

export interface ChatMessage {
  role: "user" | "assistant";
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