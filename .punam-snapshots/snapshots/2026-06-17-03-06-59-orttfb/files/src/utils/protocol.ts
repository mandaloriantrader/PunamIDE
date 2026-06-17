/**
 * Structured streaming protocol types for Cline-like chat rendering.
 *
 * The AI is instructed to emit XML-like blocks: <thinking>, <tool_call>,
 * <tool_result>, <response>.  The streaming parser splits the raw token
 * stream into these blocks so the UI can render each one progressively.
 */

// ── Block Types ───────────────────────────────────────────────────────────

export type BlockType = "thinking" | "tool_call" | "tool_result" | "response";

export interface ThinkingBlock {
  kind: "thinking";
  content: string;
}

export interface ToolCallBlock {
  kind: "tool_call";
  name: string;          // e.g. "read_file", "write_file", "execute_command"
  params: string;        // raw JSON params string
  isComplete: boolean;   // true when </tool_call> tag has been seen
}

export interface ToolResultBlock {
  kind: "tool_result";
  content: string;       // the raw result text
}

export interface ResponseBlock {
  kind: "response";
  content: string;
  isStreaming: boolean;  // true while </response> hasn't been seen yet
}

export type StreamBlock =
  | ThinkingBlock
  | ToolCallBlock
  | ToolResultBlock
  | ResponseBlock;

// ── Parser State ──────────────────────────────────────────────────────────

export interface BlockParseResult {
  /** Completed blocks that can be rendered immediately. */
  completed: StreamBlock[];
  /** The single block that is currently being streamed (open tag seen, close tag not yet seen). */
  inProgress: StreamBlock | null;
}