// src/utils/toolLoops/verification.ts
//
// Self-correcting verification wrapper for file-mutating tool calls.
// After a mutating tool (apply_patch, apply_multi_patch, write_file) executes,
// this module reads the file back and compares actual content against the expected
// edit outcome. On mismatch, it provides failure context for retry.
//
// Requirements covered: 3.1, 3.2, 3.3, 3.4, 3.6

import { invoke } from "@tauri-apps/api/core";
import { executeAgentTool, type ToolCall, type AgentToolName } from "../agentTools";
import {
  type VerificationResult,
  type ToolResultWithVerification,
  MAX_VERIFICATION_RETRIES,
} from "./shared";

// ── Constants ────────────────────────────────────────────────────────────────

/** Tools that mutate files and require post-execution verification */
const MUTATING_TOOLS = ["apply_patch", "apply_multi_patch", "write_file"] as const;

/** Lines of context to read above and below the target area on failure */
const CONTEXT_LINES = 10;

// ── Rust backend response types ──────────────────────────────────────────────

interface PatchVerificationResult {
  matched: boolean;
  match_line: number | null;   // 1-based line where match starts, or null
  similarity_score: number;    // 0.0–1.0
}

interface ReadLinesResult {
  path: string;
  start_line: number;
  end_line: number;
  total_lines: number;
  content: string;
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Execute a tool call with post-execution verification for mutating tools.
 *
 * Non-mutating tools bypass verification entirely and return immediately.
 * For mutating tools (apply_patch, apply_multi_patch, write_file):
 *   1. Execute the tool
 *   2. Read the file back via `verify_patch_applied` with fuzzy=true
 *   3. On success: return verified result
 *   4. On failure + attempt < MAX: return failure with context for retry
 *   5. On failure + attempt = MAX: halt with final failure
 *
 * @param toolName - The agent tool name to execute
 * @param args - The tool arguments
 * @param projectPath - The project root path
 * @param attempt - Current attempt number (1-based, default 1)
 * @param onBeforeWrite - Optional write approval callback
 */
export async function executeToolWithVerification(
  toolName: string,
  args: Record<string, unknown>,
  projectPath: string,
  attempt: number = 1,
  onBeforeWrite?: (path: string, originalContent: string, newContent: string) => Promise<boolean>,
): Promise<ToolResultWithVerification> {
  // Execute the tool via the standard agent tool executor
  const toolCall: ToolCall = {
    id: `verify-${toolName}-${Date.now()}`,
    name: toolName as AgentToolName,
    input: args,
  };
  const result = await executeAgentTool(toolCall, projectPath, onBeforeWrite);

  // Non-mutating tools bypass verification entirely
  if (!isMutatingTool(toolName)) {
    return {
      success: !result.is_error,
      output: result.content,
      attempt,
      maxAttempts: MAX_VERIFICATION_RETRIES,
    };
  }

  // If the tool itself failed (rejected by user, file error, etc.), no need to verify
  if (result.is_error) {
    return {
      success: false,
      output: result.content,
      attempt,
      maxAttempts: MAX_VERIFICATION_RETRIES,
    };
  }

  // Derive what we expect to find in the file after the mutation
  const filePath = extractFilePath(toolName, args);
  const expectedSnippet = deriveExpectedSnippet(toolName, args);

  // If we can't derive an expected snippet, skip verification
  if (!expectedSnippet || !filePath) {
    return {
      success: true,
      output: result.content,
      attempt,
      maxAttempts: MAX_VERIFICATION_RETRIES,
    };
  }

  // Invoke the Rust verification command
  let verification: PatchVerificationResult;
  try {
    verification = await invoke<PatchVerificationResult>("verify_patch_applied", {
      filePath,
      expectedSnippet,
      fuzzy: true,
    });
  } catch {
    // If verification itself fails (e.g., file not found), treat as unverified
    return {
      success: false,
      output: result.content,
      verificationResult: {
        matched: false,
        expectedSnippet,
        actualSnippet: "",
        similarityScore: 0,
        divergenceReason: "file_not_found",
      },
      attempt,
      maxAttempts: MAX_VERIFICATION_RETRIES,
    };
  }

  // Verification passed
  if (verification.matched) {
    return {
      success: true,
      output: result.content,
      verificationResult: {
        matched: true,
        expectedSnippet,
        actualSnippet: expectedSnippet, // matches
        matchLine: verification.match_line ?? undefined,
        similarityScore: 1.0,
      },
      attempt,
      maxAttempts: MAX_VERIFICATION_RETRIES,
    };
  }

  // Verification failed — read actual content around the target area for context
  const actualSnippet = await readFailureContext(filePath, verification.match_line);

  const verificationResult: VerificationResult = {
    matched: false,
    expectedSnippet,
    actualSnippet,
    matchLine: verification.match_line ?? undefined,
    similarityScore: verification.similarity_score,
    divergenceReason: verification.match_line ? "content_mismatch" : "line_offset",
  };

  // If we've hit the max retry count, return final failure (halt)
  if (attempt >= MAX_VERIFICATION_RETRIES) {
    return {
      success: false,
      output: buildHaltMessage(filePath, verificationResult, attempt),
      verificationResult,
      attempt,
      maxAttempts: MAX_VERIFICATION_RETRIES,
    };
  }

  // Return failure with context for retry
  return {
    success: false,
    output: buildRetryContext(filePath, verificationResult, attempt),
    verificationResult,
    attempt,
    maxAttempts: MAX_VERIFICATION_RETRIES,
  };
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Check if a tool is file-mutating and requires verification */
export function isMutatingTool(toolName: string): boolean {
  return (MUTATING_TOOLS as readonly string[]).includes(toolName);
}

/** Extract the target file path from tool arguments */
function extractFilePath(toolName: string, args: Record<string, unknown>): string | null {
  // All mutating tools use 'path' for the target file
  if (args.path && typeof args.path === "string") {
    return args.path;
  }
  if (args.file_path && typeof args.file_path === "string") {
    return args.file_path;
  }
  // apply_multi_patch uses 'request.patches[0].path' — take first file for verification
  if (toolName === "apply_multi_patch" && args.request) {
    const request = args.request as { patches?: Array<{ path: string }> };
    if (request.patches && request.patches.length > 0) {
      return request.patches[0].path;
    }
  }
  return null;
}

/**
 * Derive the expected content snippet from tool call arguments.
 * This is what we expect to find in the file after the mutation.
 */
export function deriveExpectedSnippet(
  toolName: string,
  args: Record<string, unknown>,
): string {
  switch (toolName) {
    case "apply_patch": {
      // apply_patch replaces lines start_line..end_line with new_content
      const newContent = args.new_content;
      if (typeof newContent === "string") {
        return newContent;
      }
      // Nested hunk format: { hunk: { new_content } }
      if (args.hunk && typeof args.hunk === "object") {
        const hunk = args.hunk as Record<string, unknown>;
        if (typeof hunk.new_content === "string") {
          return hunk.new_content;
        }
      }
      return "";
    }

    case "apply_multi_patch": {
      // For multi-patch, verify the first patch's last hunk's new content
      const request = args.request as { patches?: Array<{ path: string; hunks: Array<{ new_content: string }> }> } | undefined;
      if (request?.patches && request.patches.length > 0) {
        const firstPatch = request.patches[0];
        if (firstPatch.hunks && firstPatch.hunks.length > 0) {
          // Use the last hunk's new_content as representative snippet
          const lastHunk = firstPatch.hunks[firstPatch.hunks.length - 1];
          if (typeof lastHunk.new_content === "string") {
            return lastHunk.new_content;
          }
        }
      }
      return "";
    }

    case "write_file": {
      // write_file writes the entire content — use last 20 lines as snippet
      const content = args.content;
      if (typeof content === "string") {
        const lines = content.split("\n");
        // For large files, use last 20 lines as a representative check
        if (lines.length > 20) {
          return lines.slice(-20).join("\n");
        }
        return content;
      }
      return "";
    }

    default:
      return "";
  }
}

/** Read file content around the failure area for error context */
async function readFailureContext(
  filePath: string,
  matchLine: number | null,
): Promise<string> {
  const targetLine = matchLine ?? 1;
  const startLine = Math.max(1, targetLine - CONTEXT_LINES);
  const endLine = targetLine + CONTEXT_LINES;

  try {
    const result = await invoke<ReadLinesResult>("read_lines", {
      path: filePath,
      startLine,
      endLine,
    });
    return result.content;
  } catch {
    return "(unable to read file content)";
  }
}

/** Build a context message for the LLM to understand what went wrong and retry */
function buildRetryContext(
  filePath: string,
  verification: VerificationResult,
  attempt: number,
): string {
  return [
    `⚠️ Edit verification FAILED (attempt ${attempt}/${MAX_VERIFICATION_RETRIES}).`,
    `File: ${filePath}`,
    `Similarity score: ${verification.similarityScore.toFixed(2)}`,
    verification.matchLine ? `Best match found near line ${verification.matchLine}` : "",
    "",
    "Expected content after edit:",
    "```",
    verification.expectedSnippet.slice(0, 1500),
    "```",
    "",
    "Actual content around target area:",
    "```",
    verification.actualSnippet.slice(0, 1500),
    "```",
    "",
    "Re-read the file and retry the edit with corrected content.",
  ].filter(Boolean).join("\n");
}

/** Build a final halt message when max retries are exhausted */
function buildHaltMessage(
  filePath: string,
  verification: VerificationResult,
  attempt: number,
): string {
  return [
    `❌ Edit verification FAILED after ${attempt} attempts. Halting.`,
    `File: ${filePath}`,
    `Similarity score: ${verification.similarityScore.toFixed(2)}`,
    verification.matchLine ? `Closest match at line ${verification.matchLine}` : "No close match found",
    "",
    "Expected:",
    "```",
    verification.expectedSnippet.slice(0, 800),
    "```",
    "",
    "Actual:",
    "```",
    verification.actualSnippet.slice(0, 800),
    "```",
    "",
    "The edit could not be verified after maximum retries. Please inspect the file manually.",
  ].filter(Boolean).join("\n");
}
