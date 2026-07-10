/**
 * SessionMemory.ts
 *
 * Frontend TypeScript service for agent task history persistence (Tier B, Requirement 8).
 *
 * Provides the agent with self-improvement capabilities by storing task execution
 * history (successes, failures, learned patterns) and retrieving similar past tasks
 * for context injection. Built atop the Rust session_task_* commands in memory_engine.rs.
 */

import { invoke } from "@tauri-apps/api/core";

// ── TypeScript Types (mirrors Rust structs) ────────────────────────────────────

/**
 * A persisted session task entry representing a completed (or failed) agent task.
 */
export interface SessionTask {
  id: string;
  taskDescription: string;
  status: "success" | "failure" | "partial";
  approach: string;
  errorType: string | null;
  filesAffected: string[];
  patternsLearned: string[];
  durationMs: number;
  createdAt: number;
  lastAccessedAt: number;
}

/**
 * Input for creating a new session task entry.
 */
export interface SessionTaskInput {
  taskDescription: string;
  status: "success" | "failure" | "partial";
  approach: string;
  errorType?: string;
  filesAffected: string[];
  patternsLearned: string[];
  durationMs: number;
}

/**
 * Result returned from the session_task_search Rust command.
 */
interface SessionTaskSearchResult {
  entries: RawSessionTaskEntry[];
  total_count: number;
}

/**
 * Result returned from the session_task_evict Rust command.
 */
interface SessionTaskEvictResult {
  evicted_count: number;
  db_size_bytes: number;
}

/**
 * Raw entry as returned from the Rust backend (snake_case fields).
 */
interface RawSessionTaskEntry {
  id: string;
  task_description: string;
  status: string;
  approach: string;
  error_type: string | null;
  files_affected: string[];
  patterns_learned: string[];
  duration_ms: number;
  created_at: number;
  last_accessed_at: number;
}

// ── Helpers ────────────────────────────────────────────────────────────────────

/**
 * Convert a raw Rust-side entry (snake_case) to the TypeScript interface (camelCase).
 */
function toSessionTask(raw: RawSessionTaskEntry): SessionTask {
  return {
    id: raw.id,
    taskDescription: raw.task_description,
    status: raw.status as SessionTask["status"],
    approach: raw.approach,
    errorType: raw.error_type,
    filesAffected: raw.files_affected,
    patternsLearned: raw.patterns_learned,
    durationMs: raw.duration_ms,
    createdAt: raw.created_at,
    lastAccessedAt: raw.last_accessed_at,
  };
}

// ── SessionMemory Service ──────────────────────────────────────────────────────

/**
 * Service for persisting and retrieving agent task history.
 *
 * Used by AgentOrchestrator to:
 * - Record task outcomes (success/failure) after execution
 * - Retrieve similar past tasks before starting a new task
 * - Build context strings for AI prompt injection
 * - Manage storage size via eviction
 */
export class SessionMemory {
  /**
   * Persist a completed (or failed) task to session history.
   * Called by AgentOrchestrator after task completion.
   *
   * @param input - Task execution data to persist
   * @returns The created session task entry with generated ID and timestamps
   */
  async recordTask(input: SessionTaskInput): Promise<SessionTask> {
    const raw = await invoke<RawSessionTaskEntry>("session_task_create", {
      input: {
        task_description: input.taskDescription,
        status: input.status,
        approach: input.approach,
        error_type: input.errorType ?? null,
        files_affected: input.filesAffected,
        patterns_learned: input.patternsLearned,
        duration_ms: input.durationMs,
      },
    });
    return toSessionTask(raw);
  }

  /**
   * Retrieve up to `limit` similar past tasks for context injection.
   * Uses FTS5 search against the task description.
   * Updates last_accessed_at for retrieved entries (done by backend).
   *
   * @param taskDescription - The new task description to find similar past tasks for
   * @param limit - Maximum number of results (default: 5)
   * @returns Array of similar past tasks, ranked by relevance
   */
  async retrieveSimilarTasks(
    taskDescription: string,
    limit: number = 5,
  ): Promise<SessionTask[]> {
    const result = await invoke<SessionTaskSearchResult>("session_task_search", {
      query: taskDescription,
      limit,
    });
    return result.entries.map(toSessionTask);
  }

  /**
   * Build a context string from similar past tasks for AI prompt injection.
   *
   * Format:
   * ```
   * ## Past Similar Tasks
   * - [success] Task: Fix auth token refresh, Approach: Added retry logic with exponential backoff
   * - [failure] Task: Migrate DB schema, Approach: Attempted in-place migration (type_error)
   * ```
   *
   * Returns an empty string if no similar tasks are found.
   *
   * @param taskDescription - The new task description to find similar context for
   * @returns Formatted context string for AI prompt injection
   */
  async buildSessionContext(taskDescription: string): Promise<string> {
    const tasks = await this.retrieveSimilarTasks(taskDescription);

    if (tasks.length === 0) {
      return "";
    }

    const lines = tasks.map((task) => {
      const errorSuffix = task.errorType ? ` (${task.errorType})` : "";
      return `- [${task.status}] Task: ${task.taskDescription}, Approach: ${task.approach}${errorSuffix}`;
    });

    return `## Past Similar Tasks\n${lines.join("\n")}`;
  }

  /**
   * Evict old entries when DB exceeds size limit.
   * Removes entries not accessed in 30+ days, oldest first.
   *
   * @returns The number of entries evicted
   */
  async evictStaleEntries(): Promise<number> {
    const result = await invoke<SessionTaskEvictResult>("session_task_evict", {
      maxSizeMb: 50,
      maxAgeDays: 30,
    });
    return result.evicted_count;
  }

  /**
   * Clear all session memory (user-initiated via settings).
   * Deletes all persisted task history and learned patterns.
   */
  async clearAll(): Promise<void> {
    await invoke<void>("session_task_clear");
  }
}
