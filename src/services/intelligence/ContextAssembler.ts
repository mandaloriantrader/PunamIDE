/**
 * Unified Context Assembler
 *
 * Collects context candidates from all indexing sources (TF-IDF, AST,
 * embeddings, memory, repo map), ranks them on a unified scale, and fills
 * a model-aware token budget greedily by priority. Operates as a parallel
 * path to the existing `assemblePersistentPayload()` — activated via
 * feature flag.
 *
 * All Tauri invoke calls are wrapped in try/catch so that failures in any
 * single source are handled gracefully (skipped without propagation).
 */

import { invoke } from "@tauri-apps/api/core";
import {
  getModelContextLimit,
  CONTEXT_FILL_PCT,
  RESPONSE_RESERVE_PCT,
} from "./contextLimits";
import {
  type ContextSlot,
  type ContextKind,
  type AssemblyInput,
  type AssemblyResult,
  type ToolCallHistory,
  PRIORITY,
  estimateTokens,
  scoreRelevance,
} from "./contextTypes";
import {
  ContextCompressor,
  DEFAULT_COMPRESSION_CONFIG,
  type CompressionConfig,
} from "./ContextCompressor";

// ---------------------------------------------------------------------------
// Stop words for keyword extraction from task descriptions
// ---------------------------------------------------------------------------

const STOP_WORDS = new Set([
  "the", "is", "at", "which", "on", "a", "an", "and", "or", "not",
  "in", "to", "for", "of", "with", "as", "by", "from", "this", "that",
  "it", "be", "are", "was", "were", "been", "has", "have", "had",
  "do", "does", "did", "will", "would", "could", "should", "may",
  "can", "shall", "might", "must", "need", "want", "get", "set",
  "use", "new", "all", "any", "each", "every", "some", "no", "but",
  "if", "then", "else", "when", "how", "what", "why", "where", "who",
]);

/**
 * Extracts keywords from a task/query string.
 * Splits on whitespace, filters stop words, removes short words (≤2 chars),
 * and returns unique keywords.
 */
function extractKeywords(task: string): string[] {
  const words = task
    .toLowerCase()
    .replace(/[^a-z0-9\s_-]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOP_WORDS.has(w));
  return [...new Set(words)];
}

// ---------------------------------------------------------------------------
// ContextAssembler
// ---------------------------------------------------------------------------

export class ContextAssembler {
  private fillableTokens: number;
  private compressor: ContextCompressor;
  private compressionConfig: CompressionConfig;

  /**
   * Creates a new ContextAssembler configured for the given model.
   *
   * Budget calculation:
   *   modelLimit × CONTEXT_FILL_PCT × (1 - RESPONSE_RESERVE_PCT)
   *
   * @param model - Model identifier for context limit lookup
   * @param compressionConfig - Optional compression configuration (defaults to DEFAULT_COMPRESSION_CONFIG)
   */
  constructor(model: string, compressionConfig?: Partial<CompressionConfig>) {
    const modelLimit = getModelContextLimit(model);
    const available = modelLimit * CONTEXT_FILL_PCT;
    this.fillableTokens = Math.floor(available * (1 - RESPONSE_RESERVE_PCT));
    this.compressionConfig = { ...DEFAULT_COMPRESSION_CONFIG, ...compressionConfig };
    this.compressor = new ContextCompressor(this.compressionConfig);
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /**
   * Main assembly method — runs the full pipeline for one agent round.
   *
   * Steps:
   * 1. Build non-evictable slots (system prompt, task, current files)
   * 2. Collect from TF-IDF
   * 3. Collect from AST
   * 4. Collect from embeddings
   * 5. Collect from memory
   * 6. Add repo map (round 0 only)
   * 7. Add recent tool results from agentHistory
   * 8. Deduplicate by file path
   * 9. Score all evictable candidates
   * 10. Fill budget greedily
   */
  async assemble(input: AssemblyInput): Promise<AssemblyResult> {
    const { task, round, projectPath, currentFiles, agentHistory, systemPrompt } =
      input;

    // 1. Non-evictable slots: system prompt, task, current files
    const nonEvictable: ContextSlot[] = [];

    nonEvictable.push({
      id: "system_prompt",
      kind: "system_prompt",
      content: systemPrompt,
      tokenCount: estimateTokens(systemPrompt),
      relevanceScore: 1.0,
      priority: PRIORITY.system_prompt,
      round,
      evictable: false,
    });

    nonEvictable.push({
      id: "task",
      kind: "task",
      content: task,
      tokenCount: estimateTokens(task),
      relevanceScore: 1.0,
      priority: PRIORITY.task,
      round,
      evictable: false,
    });

    for (const filePath of currentFiles) {
      nonEvictable.push({
        id: `current_file:${filePath}`,
        kind: "current_file",
        content: `// ${filePath}\n[file content placeholder]`,
        tokenCount: estimateTokens(filePath),
        relevanceScore: 1.0,
        priority: PRIORITY.current_file,
        round,
        filePath,
        evictable: false,
      });
    }

    // 1b. Compress large current files before TF-IDF collection
    const keywords = extractKeywords(task);
    await this.compressCurrentFiles(nonEvictable, keywords);

    // 2-5. Collect evictable candidates from all sources (parallel)
    const [tfidfSlots, astSlots, embeddingSlots, memorySlots] =
      await Promise.all([
        this.collectFromTFIDF(task, projectPath, round),
        this.collectFromAST(task, projectPath, round),
        this.collectFromEmbeddings(task, projectPath, round),
        this.collectFromMemory(task, projectPath, round),
      ]);

    let evictable: ContextSlot[] = [
      ...tfidfSlots,
      ...astSlots,
      ...embeddingSlots,
      ...memorySlots,
    ];

    // 6. Repo map — only on round 0
    if (round === 0) {
      const repoMapSlot = await this.collectRepoMap(projectPath, round);
      if (repoMapSlot) {
        evictable.push(repoMapSlot);
      }
    }

    // 7. Recent tool results (last 5, older than 2 rounds are evictable)
    const recentHistory = agentHistory.slice(-5);
    for (const entry of recentHistory) {
      const isStale = round - entry.round > 2;
      const slot: ContextSlot = {
        id: `tool_result:${entry.toolName}:r${entry.round}`,
        kind: "tool_result",
        content: `[Tool: ${entry.toolName}]\nInput: ${entry.input}\nOutput: ${entry.output}`,
        tokenCount: entry.tokenCount,
        relevanceScore: isStale ? 0.3 : 0.7,
        priority: PRIORITY.tool_result,
        round: entry.round,
        evictable: isStale,
      };

      if (isStale) {
        evictable.push(slot);
      } else {
        nonEvictable.push(slot);
      }
    }

    // 8. Deduplicate by file path (keep highest scored)
    evictable = this.deduplicateByFilePath(evictable);

    // 9. Score all evictable candidates
    for (const slot of evictable) {
      slot.relevanceScore = scoreRelevance(slot, task, currentFiles, round);
    }

    // 10. Fill budget
    const allCandidates = [...nonEvictable, ...evictable];
    return this.fillBudget(allCandidates);
  }

  // -------------------------------------------------------------------------
  // File Compression (private)
  // -------------------------------------------------------------------------

  /**
   * Iterates over current_file slots and compresses those exceeding the
   * file size threshold. Replaces the slot's content with the compressed
   * version. Files under threshold or files that fail compression are
   * left unchanged (pass through as-is).
   */
  private async compressCurrentFiles(
    slots: ContextSlot[],
    keywords: string[]
  ): Promise<void> {
    for (let i = 0; i < slots.length; i++) {
      const slot = slots[i];
      if (slot.kind !== "current_file" || !slot.filePath) continue;

      try {
        // Read the file content to check its size
        const content = await invoke<string>("read_file", { path: slot.filePath });

        if (this.compressor.needsCompression(content)) {
          // File exceeds threshold — compress it
          const compressed = await this.compressor.compress(
            slot.filePath,
            content,
            keywords
          );
          // Replace the slot content with compressed content
          slots[i] = {
            ...slot,
            content: `// ${slot.filePath} [compressed]\n${compressed.content}`,
            tokenCount: estimateTokens(compressed.content),
          };
        } else {
          // File under threshold — include raw content as-is
          slots[i] = {
            ...slot,
            content: `// ${slot.filePath}\n${content}`,
            tokenCount: estimateTokens(content),
          };
        }
      } catch {
        // Read or compression failed — keep the placeholder, let budget
        // trimming handle overflow. This is fail-open behavior.
      }
    }
  }

  // -------------------------------------------------------------------------
  // Source Collection (private)
  // -------------------------------------------------------------------------

  /**
   * Collects candidates from TF-IDF search via Tauri invoke.
   * Command: `get_relevant_context`, limit 10.
   */
  private async collectFromTFIDF(
    task: string,
    projectPath: string,
    round: number
  ): Promise<ContextSlot[]> {
    try {
      const results = await invoke<any[]>("get_relevant_context", {
        query: task,
        projectPath,
        limit: 10,
      });
      return results.map((r) => ({
        id: `tfidf:${r.file_path}`,
        kind: "related_file" as ContextKind,
        content: `// ${r.file_path}\n${r.content}`,
        tokenCount: estimateTokens(r.content),
        relevanceScore: r.score ?? 0.5,
        priority: PRIORITY.related_file,
        round,
        filePath: r.file_path,
        evictable: true,
      }));
    } catch {
      return [];
    }
  }

  /**
   * Collects candidates from AST-aware search via Tauri invoke.
   * Command: `search_codebase_ast`, topK 8, maxTokens 6000.
   */
  private async collectFromAST(
    task: string,
    projectPath: string,
    round: number
  ): Promise<ContextSlot[]> {
    try {
      const response = await invoke<any>("search_codebase_ast", {
        query: task,
        projectPath,
        topK: 8,
        maxTokens: 6000,
      });
      const chunks: any[] = response?.chunks ?? [];
      return chunks.map((chunk) => ({
        id: `ast:${chunk.file_path}:${chunk.symbol_name ?? "chunk"}`,
        kind: "symbol_definition" as ContextKind,
        content: `// ${chunk.file_path} — ${chunk.symbol_name ?? "block"}\n${chunk.content}`,
        tokenCount: chunk.tokens_estimate ?? estimateTokens(chunk.content),
        relevanceScore: 0.5,
        priority: PRIORITY.symbol_definition,
        round,
        filePath: chunk.file_path,
        evictable: true,
      }));
    } catch {
      return [];
    }
  }

  /**
   * Collects candidates from embedding/semantic search via Tauri invoke.
   * Command: `embedding_pipeline_semantic_search`, limit 8, threshold 0.6.
   */
  private async collectFromEmbeddings(
    task: string,
    projectPath: string,
    round: number
  ): Promise<ContextSlot[]> {
    try {
      const results = await invoke<any[]>(
        "embedding_pipeline_semantic_search",
        {
          query: task,
          projectPath,
          limit: 8,
          threshold: 0.6,
        }
      );
      return (results ?? []).map((r) => ({
        id: `embedding:${r.file_path}`,
        kind: "semantic_result" as ContextKind,
        content: `// ${r.file_path}\n${r.content}`,
        tokenCount: estimateTokens(r.content),
        relevanceScore: r.score ?? r.similarity ?? 0.6,
        priority: PRIORITY.semantic_result,
        round,
        filePath: r.file_path,
        evictable: true,
      }));
    } catch {
      return [];
    }
  }

  /**
   * Collects candidates from project memory via Tauri invoke.
   * Command: `memory_search`, limit 5.
   */
  private async collectFromMemory(
    task: string,
    projectPath: string,
    round: number
  ): Promise<ContextSlot[]> {
    try {
      const results = await invoke<any[]>("memory_search", {
        query: task,
        limit: 5,
      });
      return (results ?? []).map((r, i) => ({
        id: `memory:${i}`,
        kind: "project_memory" as ContextKind,
        content: r.content ?? r.text ?? String(r),
        tokenCount: estimateTokens(r.content ?? r.text ?? String(r)),
        relevanceScore: r.score ?? 0.4,
        priority: PRIORITY.project_memory,
        round,
        evictable: true,
      }));
    } catch {
      return [];
    }
  }

  /**
   * Fetches and compresses the repo map (round 0 only).
   * Command: `get_repo_map`.
   */
  private async collectRepoMap(
    projectPath: string,
    round: number
  ): Promise<ContextSlot | null> {
    try {
      const repoMap = await invoke<string>("get_repo_map", { projectPath });
      const compressed = this.compressRepoMap(repoMap);
      if (!compressed) return null;
      return {
        id: "repo_map",
        kind: "repo_map",
        content: compressed,
        tokenCount: estimateTokens(compressed),
        relevanceScore: 0.3,
        priority: PRIORITY.repo_map,
        round,
        evictable: true,
      };
    } catch {
      return null;
    }
  }

  // -------------------------------------------------------------------------
  // Budget Filling
  // -------------------------------------------------------------------------

  /**
   * Fills the token budget greedily.
   *
   * 1. Non-evictable slots go first (always included).
   * 2. Remaining budget is filled with evictable slots sorted by
   *    `priority × relevanceScore` descending.
   * 3. Oversized evictable slots (>500 tokens) are partially truncated
   *    to fit remaining budget.
   */
  private fillBudget(candidates: ContextSlot[]): AssemblyResult {
    const nonEvictable = candidates.filter((s) => !s.evictable);
    const evictable = candidates.filter((s) => s.evictable);

    // Sort evictable by priority × relevanceScore (descending)
    evictable.sort(
      (a, b) =>
        b.priority * b.relevanceScore - a.priority * a.relevanceScore
    );

    const included: ContextSlot[] = [];
    const truncated: string[] = [];

    // Add non-evictable first
    let usedTokens = 0;
    for (const slot of nonEvictable) {
      included.push(slot);
      usedTokens += slot.tokenCount;
    }

    // Fill remaining with evictable
    let remaining = this.fillableTokens - usedTokens;

    for (const slot of evictable) {
      if (remaining <= 0) {
        truncated.push(slot.id);
        continue;
      }

      if (slot.tokenCount <= remaining) {
        // Fits entirely
        included.push(slot);
        usedTokens += slot.tokenCount;
        remaining -= slot.tokenCount;
      } else if (slot.tokenCount > 500 && remaining > 100) {
        // Partial truncation — include as much as fits
        const words = slot.content.split(/\s+/);
        const maxWords = Math.floor(remaining * 0.75); // inverse of estimateTokens
        const truncatedContent =
          words.slice(0, maxWords).join(" ") +
          "\n\n[... truncated — slot exceeded budget ...]";
        const truncatedSlot: ContextSlot = {
          ...slot,
          content: truncatedContent,
          tokenCount: estimateTokens(truncatedContent),
        };
        included.push(truncatedSlot);
        usedTokens += truncatedSlot.tokenCount;
        remaining -= truncatedSlot.tokenCount;
        truncated.push(slot.id);
      } else {
        // Too small to partially truncate or no room
        truncated.push(slot.id);
      }
    }

    // Order slots logically for LLM readability
    const ordered = this.orderSlotsLogically(included);

    // Assemble final context string
    const assembledContext = ordered
      .map((slot) => slot.content)
      .join("\n\n---\n\n");

    const totalTokens = usedTokens;
    const budgetUsed = totalTokens / this.fillableTokens;

    return {
      assembledContext,
      totalTokens,
      budgetUsed: Math.min(budgetUsed, 1.0),
      truncated,
      slots: ordered,
    };
  }

  // -------------------------------------------------------------------------
  // Slot Ordering
  // -------------------------------------------------------------------------

  /**
   * Orders slots by kind for optimal LLM readability.
   * system → task → repo_map → memory → files → results → history
   */
  private orderSlotsLogically(slots: ContextSlot[]): ContextSlot[] {
    const ORDER: ContextKind[] = [
      "system_prompt",
      "task",
      "repo_map",
      "project_memory",
      "current_file",
      "related_file",
      "symbol_definition",
      "search_result",
      "semantic_result",
      "tool_result",
      "conversation_turn",
    ];
    return [...slots].sort(
      (a, b) => ORDER.indexOf(a.kind) - ORDER.indexOf(b.kind)
    );
  }

  // -------------------------------------------------------------------------
  // Repo Map Compression
  // -------------------------------------------------------------------------

  /**
   * Compresses a repo map to at most 50 lines, filtering entries
   * to a maximum path depth of 3 levels.
   */
  private compressRepoMap(repoMap: string): string {
    const lines = repoMap.split("\n");
    const filtered = lines.filter((line) => {
      // Count path depth by number of "/" separators in the line
      const slashes = (line.match(/\//g) || []).length;
      return slashes <= 3;
    });
    return filtered.slice(0, 50).join("\n");
  }

  // -------------------------------------------------------------------------
  // Deduplication
  // -------------------------------------------------------------------------

  /**
   * Removes duplicate slots that reference the same file path.
   * When duplicates exist, keeps the one with the highest
   * `priority × relevanceScore`.
   */
  private deduplicateByFilePath(slots: ContextSlot[]): ContextSlot[] {
    const byPath = new Map<string, ContextSlot>();
    const noPath: ContextSlot[] = [];

    for (const slot of slots) {
      if (!slot.filePath) {
        noPath.push(slot);
        continue;
      }

      const existing = byPath.get(slot.filePath);
      if (!existing) {
        byPath.set(slot.filePath, slot);
      } else {
        const existingScore = existing.priority * existing.relevanceScore;
        const newScore = slot.priority * slot.relevanceScore;
        if (newScore > existingScore) {
          byPath.set(slot.filePath, slot);
        }
      }
    }

    return [...byPath.values(), ...noPath];
  }
}
