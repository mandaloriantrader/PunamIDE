/**
 * ClarificationMemory.ts — Persistence layer for agent clarifications.
 *
 * Stores and retrieves past clarification answers so that similar future tasks
 * don't ask the same question again. Uses the existing Tauri IPC memory system
 * with category "agent_clarification".
 *
 * Design principles:
 *   - Fail-safe: all operations are try/catch — never throw, never block
 *   - Similarity: 60% keyword overlap on words with length > 3 characters
 *   - Uses MemoryManager utilities (memorySearch, memoryQuickAdd)
 */

import { memorySearch, memoryQuickAdd } from "../memory/MemoryManager";

// ── Types ──────────────────────────────────────────────────────────────────────

export interface StoredClarification {
  taskPattern: string;
  clarification: string;
  refinedTask: string;
  projectPath: string;
  timestamp: number;
}

// ── Constants ──────────────────────────────────────────────────────────────────

const MEMORY_CATEGORY = "agent_clarification";
const SIMILARITY_THRESHOLD = 0.6;
const MIN_WORD_LENGTH = 3;

// ── Keyword Extraction ─────────────────────────────────────────────────────────

/**
 * Extracts significant keywords from a task string.
 * Filters to words longer than MIN_WORD_LENGTH characters and lowercases them.
 */
function extractKeywords(text: string): Set<string> {
  const words = text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > MIN_WORD_LENGTH);
  return new Set(words);
}

/**
 * Calculates keyword overlap ratio between two sets.
 * Returns the proportion of keywords in setA that also appear in setB.
 */
function keywordOverlap(setA: Set<string>, setB: Set<string>): number {
  if (setA.size === 0) return 0;
  let matchCount = 0;
  for (const word of setA) {
    if (setB.has(word)) matchCount++;
  }
  return matchCount / setA.size;
}

// ── Public API ─────────────────────────────────────────────────────────────────

/**
 * Searches existing clarification memory for a similar past clarification.
 *
 * Uses the memory system to find entries with category `agent_clarification`,
 * then applies keyword overlap matching (60% threshold) to find relevant results
 * for the given project.
 *
 * @param task - The current user task string
 * @param projectPath - The current project path (used to filter results)
 * @returns The matching StoredClarification, or null if none found
 */
export async function findSimilarClarification(
  task: string,
  projectPath: string
): Promise<StoredClarification | null> {
  try {
    // Search memory for entries matching keywords from the task
    const results = await memorySearch(task, MEMORY_CATEGORY, 10);

    if (!results || !results.entries || results.entries.length === 0) {
      return null;
    }

    const taskKeywords = extractKeywords(task);

    // Check each result for keyword overlap and project match
    for (const entry of results.entries) {
      try {
        // Parse the stored clarification from the description field (stored as JSON)
        const stored: StoredClarification = JSON.parse(entry.description);

        // Filter by project path
        if (stored.projectPath !== projectPath) {
          continue;
        }

        // Check keyword similarity
        const storedKeywords = extractKeywords(stored.taskPattern);
        const overlap = keywordOverlap(taskKeywords, storedKeywords);

        if (overlap >= SIMILARITY_THRESHOLD) {
          return stored;
        }
      } catch {
        // Skip entries that can't be parsed — corrupted or different format
        continue;
      }
    }

    return null;
  } catch (error) {
    // Fail-safe: log and return null — never block the agent
    console.warn("[ClarificationMemory] Search failed:", error);
    return null;
  }
}

/**
 * Stores a clarification in the memory system for future recall.
 *
 * Saves the full StoredClarification as JSON in the description field,
 * using the task pattern as the title for searchability.
 *
 * @param clarification - The clarification data to store
 */
export async function storeClarification(
  clarification: StoredClarification
): Promise<void> {
  try {
    const title = `Clarification: ${clarification.taskPattern.slice(0, 80)}`;
    const description = JSON.stringify(clarification);

    await memoryQuickAdd(MEMORY_CATEGORY, title, description);
  } catch (error) {
    // Fail-safe: log warning but never throw — storing is best-effort
    console.warn("[ClarificationMemory] Store failed:", error);
  }
}
