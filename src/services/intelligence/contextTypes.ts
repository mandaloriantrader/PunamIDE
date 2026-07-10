/**
 * Context Slot Types & Scoring Utilities
 *
 * Defines the data structures for the Unified Context Assembler's slot system
 * and provides scoring/estimation utilities used during budget filling.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** All possible kinds of context that can occupy a slot. */
export type ContextKind =
  | 'system_prompt'
  | 'task'
  | 'conversation_turn'
  | 'current_file'
  | 'related_file'
  | 'symbol_definition'
  | 'search_result'
  | 'semantic_result'
  | 'project_memory'
  | 'repo_map'
  | 'tool_result';

/** A single unit of context with metadata for scoring and eviction. */
export interface ContextSlot {
  /** Unique identifier for this slot (e.g., "tfidf-src/utils.ts" or "memory-3"). */
  id: string;
  /** What kind of context this slot holds. */
  kind: ContextKind;
  /** The actual content string to include in the assembled context. */
  content: string;
  /** Estimated token count for this slot's content. */
  tokenCount: number;
  /** Relevance score (0–1) computed against the current task. */
  relevanceScore: number;
  /** Priority tier (1–10) based on kind. */
  priority: number;
  /** The round number when this slot was added/last refreshed. */
  round: number;
  /** Optional file path this content is associated with. */
  filePath?: string;
  /** Whether this slot can be dropped under budget pressure. */
  evictable: boolean;
}

/** Input required to run a context assembly pass. */
export interface AssemblyInput {
  /** The current task/instruction for this round. */
  task: string;
  /** Current round number (0-indexed). */
  round: number;
  /** Model identifier (used to look up context limit). */
  model: string;
  /** Absolute path to the project root. */
  projectPath: string;
  /** File paths currently open/edited in the IDE. */
  currentFiles: string[];
  /** Tool call history from prior rounds (for stale eviction). */
  agentHistory: ToolCallHistory[];
  /** The system prompt to always include. */
  systemPrompt: string;
}

/** Result returned after assembling context for a round. */
export interface AssemblyResult {
  /** The final assembled context string ready to send to the model. */
  assembledContext: string;
  /** Total tokens used by the assembled context. */
  totalTokens: number;
  /** Fraction of the fillable budget consumed (0–1). */
  budgetUsed: number;
  /** IDs of slots that were truncated or dropped due to budget limits. */
  truncated: string[];
  /** The slots that were included in the assembled context. */
  slots: ContextSlot[];
}

/** Record of a single tool call for history tracking across rounds. */
export interface ToolCallHistory {
  /** The round this tool was called in. */
  round: number;
  /** Name of the tool that was invoked. */
  toolName: string;
  /** Input/arguments passed to the tool. */
  input: string;
  /** Output/result returned by the tool. */
  output: string;
  /** Estimated token count for the output. */
  tokenCount: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Priority mapping for each context kind (higher = more important). */
export const PRIORITY: Record<ContextKind, number> = {
  system_prompt: 10,
  task: 10,
  current_file: 9,
  conversation_turn: 7,
  symbol_definition: 6,
  related_file: 5,
  tool_result: 5,
  semantic_result: 4,
  search_result: 4,
  project_memory: 3,
  repo_map: 2,
};

// ---------------------------------------------------------------------------
// Utility Functions
// ---------------------------------------------------------------------------

/**
 * Estimates the number of tokens in a text string.
 *
 * Uses the same heuristic as the Rust backend (`index_commands.rs`):
 * word count divided by 0.75 (rounded up). This approximates typical
 * subword tokenization where ~0.75 words = 1 token on average.
 */
export function estimateTokens(text: string): number {
  const words = text.split(/\s+/).filter((w) => w.length > 0);
  return Math.ceil(words.length / 0.75);
}

/**
 * Scores how relevant a context slot is to the current task and files.
 *
 * Scoring components:
 * - File match (0.4): slot's filePath is in the currentFiles list
 * - Keyword overlap (0–0.5): proportion of task keywords found in slot content
 * - Recency bonus (0.1): slot is from the current round
 *
 * @param slot - The context slot to score
 * @param task - The current round's task description
 * @param currentFiles - Files currently open/edited
 * @param currentRound - The current round number (for recency scoring)
 * @returns A relevance score between 0 and 1
 */
export function scoreRelevance(
  slot: ContextSlot,
  task: string,
  currentFiles: string[],
  currentRound: number
): number {
  let score = 0;

  // File match: if slot's filePath is in currentFiles
  if (slot.filePath && currentFiles.includes(slot.filePath)) {
    score += 0.4;
  }

  // Keyword overlap: proportion of task keywords found in slot content
  const taskWords = new Set(
    task
      .toLowerCase()
      .split(/\s+/)
      .filter((w) => w.length > 3)
  );
  const slotWords = slot.content
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => w.length > 3);
  const overlap = slotWords.filter((w) => taskWords.has(w)).length;
  score += Math.min(overlap / Math.max(taskWords.size, 1), 0.5);

  // Recency: slight bonus for current-round content
  if (slot.round === currentRound) {
    score += 0.1;
  }

  return Math.min(score, 1.0);
}
