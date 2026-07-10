/**
 * ContextInjector — Automatic Smart Context Injection for AI Prompts
 *
 * Sits upstream of the ContextAssembler to provide pre-ranked context candidates
 * by querying the call graph, symbol index, and embedding store. Automatically
 * injects relevant callers, callees, type definitions, and embedding snippets
 * into AI prompts without manual @mentions.
 *
 * @see Requirements 2.1, 2.2, 2.3, 2.4
 */

import { invoke } from "@tauri-apps/api/core";
import { estimateTokens } from "./contextTypes";

// ---------------------------------------------------------------------------
// Types — Call Graph (matching Rust backend CallEdge shape)
// ---------------------------------------------------------------------------

/** A single call edge from the Rust call_graph module. */
export interface CallEdge {
  caller: string;
  caller_file: string;
  call_line: number;
  callee: string;
  call_expression: string;
}

// ---------------------------------------------------------------------------
// Types — Symbol Index (matching Rust backend SymbolEntry shape)
// ---------------------------------------------------------------------------

/** A symbol entry from the Rust symbol_index module. */
export interface SymbolEntry {
  name: string;
  file: string;
  line: number;
  kind: string;
  signature: string;
}

// ---------------------------------------------------------------------------
// Types — Embedding Results
// ---------------------------------------------------------------------------

/** A single embedding search result. */
export interface EmbeddingSnippet {
  content: string;
  filePath: string;
  score: number;
}

// ---------------------------------------------------------------------------
// Types — User Mentions
// ---------------------------------------------------------------------------

/** Context explicitly specified by the user via @mentions. */
export interface MentionContext {
  filePath: string;
  content: string;
  tokenCount: number;
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/**
 * Configuration for the ContextInjector service.
 *
 * Controls budget allocation, similarity thresholds, and caps for
 * each category of automatically injected context.
 */
export interface ContextInjectorConfig {
  /** Maximum percentage of total token budget for auto-injected context (range: 10–50, default: 30). */
  maxBudgetPercent: number;
  /** Minimum cosine similarity threshold for embedding results (0–1 scale, default: 0.70). */
  embeddingThreshold: number;
  /** Maximum number of caller entries to include (default: 5). */
  maxCallers: number;
  /** Maximum number of callee entries to include (default: 5). */
  maxCallees: number;
  /** Maximum number of type definitions to include (default: 10). */
  maxTypeDefinitions: number;
  /** Maximum number of embedding snippets to include (default: 3). */
  maxEmbeddingSnippets: number;
}

/** Default configuration values for the ContextInjector. */
export const DEFAULT_CONTEXT_INJECTOR_CONFIG: ContextInjectorConfig = {
  maxBudgetPercent: 30,
  embeddingThreshold: 0.70,
  maxCallers: 5,
  maxCallees: 5,
  maxTypeDefinitions: 10,
  maxEmbeddingSnippets: 3,
};

// ---------------------------------------------------------------------------
// Result Type
// ---------------------------------------------------------------------------

/**
 * The result of gathering automatic context for an AI prompt.
 *
 * Contains callers, callees, type definitions, and embedding snippets
 * with token accounting information.
 */
export interface InjectedContext {
  /** Top callers of the function at cursor, ranked by frequency (up to maxCallers). */
  callers: CallEdge[];
  /** Top callees of the function at cursor, ranked by frequency (up to maxCallees). */
  callees: CallEdge[];
  /** Type definitions referenced by the active function (up to maxTypeDefinitions). */
  typeDefinitions: SymbolEntry[];
  /** Embedding snippets matching the user query above threshold (up to maxEmbeddingSnippets). */
  embeddingSnippets: EmbeddingSnippet[];
  /** Total estimated token count of all injected context. */
  totalTokens: number;
  /** Percentage of the allocated budget consumed by injected context. */
  budgetUsedPercent: number;
}

// ---------------------------------------------------------------------------
// ContextInjector Class
// ---------------------------------------------------------------------------

/**
 * Gathers and ranks context candidates from call graph, symbol index,
 * and embedding store for automatic injection into AI prompts.
 *
 * The `gatherContext` implementation is provided in task 3.2.
 */
export class ContextInjector {
  private config: ContextInjectorConfig;

  constructor(config: Partial<ContextInjectorConfig> = {}) {
    this.config = { ...DEFAULT_CONTEXT_INJECTOR_CONFIG, ...config };

    // Validate maxBudgetPercent is within range
    if (this.config.maxBudgetPercent < 10) {
      this.config.maxBudgetPercent = 10;
    } else if (this.config.maxBudgetPercent > 50) {
      this.config.maxBudgetPercent = 50;
    }
  }

  /**
   * Gathers relevant context for an AI prompt based on cursor position and user query.
   *
   * Data flow:
   * 1. Determines the active function enclosing the cursor
   * 2. If inside a function: fetches callers, callees, and type definitions
   * 3. If NOT inside a function: skips call graph, includes only embedding results
   * 4. Always fetches embedding snippets matching the user query
   * 5. Enforces budget: caps total at maxBudgetPercent of tokenBudget
   * 6. Priority: user @mentions first, auto-context fills remainder
   *
   * @param params - Context gathering parameters
   * @returns The gathered and budget-capped injected context
   */
  async gatherContext(params: {
    filePath: string;
    cursorLine: number;
    cursorColumn: number;
    userQuery: string;
    userMentions: MentionContext[];
    tokenBudget: number;
  }): Promise<InjectedContext> {
    const { filePath, cursorLine, userQuery, userMentions, tokenBudget } = params;

    // Calculate available budget for auto-context after user mentions
    const maxAutoTokens = Math.floor(tokenBudget * this.config.maxBudgetPercent / 100);
    const mentionTokens = userMentions.reduce((sum, m) => sum + m.tokenCount, 0);
    let remainingBudget = Math.max(0, maxAutoTokens - mentionTokens);

    let callers: CallEdge[] = [];
    let callees: CallEdge[] = [];
    let typeDefinitions: SymbolEntry[] = [];
    let embeddingSnippets: EmbeddingSnippet[] = [];

    // Step 1: Determine the active function enclosing the cursor
    const activeFunction = await this.findEnclosingFunction(filePath, cursorLine);

    // Step 2: If cursor is inside a function, gather call graph and type definitions
    if (activeFunction) {
      // Fetch callers — top 5 by frequency
      callers = await this.fetchCallers(activeFunction.name);
      // Fetch callees — top 5 by frequency
      callees = await this.fetchCallees(activeFunction.name);
      // Fetch type definitions referenced in the function signature
      typeDefinitions = await this.fetchTypeDefinitions(activeFunction.signature);
    }
    // Step 3: If cursor is NOT inside a function, skip call graph (callers/callees/types stay empty)

    // Step 4: Always fetch embedding snippets matching the user query
    embeddingSnippets = await this.fetchEmbeddingSnippets(userQuery);

    // Step 5: Enforce budget — estimate tokens and cap at remaining budget
    const result = this.enforceBudget(
      { callers, callees, typeDefinitions, embeddingSnippets },
      remainingBudget
    );

    // Calculate final token usage
    const totalTokens = this.estimateContextTokens(result);
    const budgetUsedPercent = tokenBudget > 0
      ? Math.round((totalTokens + mentionTokens) / tokenBudget * 100)
      : 0;

    return {
      ...result,
      totalTokens,
      budgetUsedPercent,
    };
  }

  // ---------------------------------------------------------------------------
  // Private helper methods
  // ---------------------------------------------------------------------------

  /**
   * Finds the function symbol that encloses the given cursor line.
   * Returns null if the cursor is not inside any function body.
   */
  private async findEnclosingFunction(
    filePath: string,
    cursorLine: number
  ): Promise<SymbolEntry | null> {
    try {
      const result = await invoke<{ symbols: SymbolEntry[]; count: number }>(
        "symbol_list_file",
        { filePath }
      );

      // Filter to function-like symbols and find the one enclosing the cursor
      const functionKinds = new Set(["function", "method", "arrow_function", "generator"]);
      const functions = result.symbols.filter(s => functionKinds.has(s.kind));

      // Sort by line descending to find the nearest enclosing function
      // (the function whose start line is <= cursor line and is closest)
      const enclosing = functions
        .filter(s => s.line <= cursorLine)
        .sort((a, b) => b.line - a.line);

      return enclosing.length > 0 ? enclosing[0] : null;
    } catch {
      // If symbol_list_file fails, skip — proceed without function context
      return null;
    }
  }

  /**
   * Fetches top callers of the given function, ranked by frequency (call count).
   * Returns at most `maxCallers` entries.
   */
  private async fetchCallers(functionName: string): Promise<CallEdge[]> {
    try {
      const result = await invoke<{
        function_name: string;
        callers: CallEdge[];
        total_callers: number;
      }>("callgraph_lookup", { functionName });

      // Rank by frequency: count occurrences of each caller
      const frequencyMap = new Map<string, { edge: CallEdge; count: number }>();
      for (const edge of result.callers) {
        const key = `${edge.caller}::${edge.caller_file}`;
        const existing = frequencyMap.get(key);
        if (existing) {
          existing.count++;
        } else {
          frequencyMap.set(key, { edge, count: 1 });
        }
      }

      // Sort by frequency descending, take top N
      return Array.from(frequencyMap.values())
        .sort((a, b) => b.count - a.count)
        .slice(0, this.config.maxCallers)
        .map(entry => entry.edge);
    } catch {
      // If callgraph_lookup fails, skip callers
      return [];
    }
  }

  /**
   * Fetches top callees of the given function, ranked by frequency (call count).
   * Returns at most `maxCallees` entries.
   */
  private async fetchCallees(functionName: string): Promise<CallEdge[]> {
    try {
      const result = await invoke<{
        function_name: string;
        callees: CallEdge[];
        total_callees: number;
      }>("callgraph_callees", { functionName });

      // Rank by frequency: count occurrences of each callee
      const frequencyMap = new Map<string, { edge: CallEdge; count: number }>();
      for (const edge of result.callees) {
        const key = `${edge.callee}::${edge.caller_file}`;
        const existing = frequencyMap.get(key);
        if (existing) {
          existing.count++;
        } else {
          frequencyMap.set(key, { edge, count: 1 });
        }
      }

      // Sort by frequency descending, take top N
      return Array.from(frequencyMap.values())
        .sort((a, b) => b.count - a.count)
        .slice(0, this.config.maxCallees)
        .map(entry => entry.edge);
    } catch {
      // If callgraph_callees fails, skip callees
      return [];
    }
  }

  /**
   * Extracts type references from a function signature and looks them up
   * in the symbol index. Returns at most `maxTypeDefinitions` entries.
   */
  private async fetchTypeDefinitions(signature: string): Promise<SymbolEntry[]> {
    try {
      // Extract potential type names from the signature
      // Matches PascalCase identifiers that are likely type/interface names
      const typePattern = /\b([A-Z][A-Za-z0-9]*(?:<[^>]*>)?)\b/g;
      const typeNames = new Set<string>();
      let match: RegExpExecArray | null;

      while ((match = typePattern.exec(signature)) !== null) {
        // Strip generic parameters for lookup
        const typeName = match[1].replace(/<[^>]*>/, "");
        // Exclude common built-in types
        const builtins = new Set([
          "String", "Number", "Boolean", "Array", "Object", "Promise",
          "Map", "Set", "Record", "Partial", "Readonly", "Required",
          "Pick", "Omit", "Exclude", "Extract", "ReturnType", "Parameters",
          "Awaited", "Void", "Never", "Unknown", "Any", "Null", "Undefined",
        ]);
        if (!builtins.has(typeName) && typeName.length > 1) {
          typeNames.add(typeName);
        }
      }

      // Look up each type in the symbol index
      const results: SymbolEntry[] = [];
      for (const typeName of typeNames) {
        if (results.length >= this.config.maxTypeDefinitions) break;

        try {
          const lookupResult = await invoke<{
            query: string;
            matches: SymbolEntry[];
            total_count: number;
          }>("symbol_lookup", { name: typeName });

          // Include type/interface/class definitions only
          const typeKinds = new Set(["interface", "type_alias", "class", "enum", "type"]);
          const typeMatches = lookupResult.matches.filter(s => typeKinds.has(s.kind));

          for (const entry of typeMatches) {
            if (results.length >= this.config.maxTypeDefinitions) break;
            // Avoid duplicates
            if (!results.some(r => r.name === entry.name && r.file === entry.file)) {
              results.push(entry);
            }
          }
        } catch {
          // Skip failed lookups for individual types
          continue;
        }
      }

      return results;
    } catch {
      // If type extraction fails entirely, return empty
      return [];
    }
  }

  /**
   * Fetches embedding snippets matching the user query.
   * Filters by the configured similarity threshold and takes top N.
   * Uses `search_codebase` with BM25 scoring as the semantic search backend.
   */
  private async fetchEmbeddingSnippets(userQuery: string): Promise<EmbeddingSnippet[]> {
    if (!userQuery.trim()) return [];

    try {
      // Use search_codebase (BM25-based) for semantic search
      const results = await invoke<Array<{
        path: string;
        start_line: number;
        end_line: number;
        snippet: string;
        score: number;
      }>>("search_codebase", {
        query: userQuery,
        topK: this.config.maxEmbeddingSnippets * 2, // fetch extra to filter by threshold
      });

      if (!results || results.length === 0) return [];

      // Normalize scores to 0–1 range for threshold comparison
      const maxScore = Math.max(...results.map(r => r.score), 1);
      const normalized = results.map(r => ({
        content: r.snippet,
        filePath: r.path,
        score: maxScore > 0 ? r.score / maxScore : 0,
      }));

      // Filter by threshold and take top N
      return normalized
        .filter(r => r.score >= this.config.embeddingThreshold)
        .slice(0, this.config.maxEmbeddingSnippets);
    } catch {
      // If semantic search fails, return empty
      return [];
    }
  }

  /**
   * Estimates the total token count for a set of context items.
   */
  private estimateContextTokens(context: {
    callers: CallEdge[];
    callees: CallEdge[];
    typeDefinitions: SymbolEntry[];
    embeddingSnippets: EmbeddingSnippet[];
  }): number {
    let total = 0;

    // Callers: estimate based on call_expression + caller name + file path
    for (const edge of context.callers) {
      const text = `${edge.caller} (${edge.caller_file}:${edge.call_line}): ${edge.call_expression}`;
      total += estimateTokens(text);
    }

    // Callees: similar estimation
    for (const edge of context.callees) {
      const text = `${edge.callee} (${edge.caller_file}:${edge.call_line}): ${edge.call_expression}`;
      total += estimateTokens(text);
    }

    // Type definitions: estimate based on signature
    for (const sym of context.typeDefinitions) {
      const text = `${sym.kind} ${sym.name}: ${sym.signature}`;
      total += estimateTokens(text);
    }

    // Embedding snippets: estimate based on content
    for (const snippet of context.embeddingSnippets) {
      total += estimateTokens(snippet.content);
    }

    return total;
  }

  /**
   * Enforces the token budget by progressively trimming lowest-priority context.
   * Priority order (highest to lowest): callers/callees > type definitions > embedding snippets.
   *
   * Within the budget, all items are included. If over budget, items are removed
   * from lowest priority first (embedding snippets → type definitions → callees → callers).
   */
  private enforceBudget(
    context: {
      callers: CallEdge[];
      callees: CallEdge[];
      typeDefinitions: SymbolEntry[];
      embeddingSnippets: EmbeddingSnippet[];
    },
    maxTokens: number
  ): {
    callers: CallEdge[];
    callees: CallEdge[];
    typeDefinitions: SymbolEntry[];
    embeddingSnippets: EmbeddingSnippet[];
  } {
    // If budget is 0 or negative, return empty
    if (maxTokens <= 0) {
      return { callers: [], callees: [], typeDefinitions: [], embeddingSnippets: [] };
    }

    let currentTokens = this.estimateContextTokens(context);

    // If within budget, return as-is
    if (currentTokens <= maxTokens) {
      return context;
    }

    // Clone arrays so we can mutate
    let { callers, callees, typeDefinitions, embeddingSnippets } = {
      callers: [...context.callers],
      callees: [...context.callees],
      typeDefinitions: [...context.typeDefinitions],
      embeddingSnippets: [...context.embeddingSnippets],
    };

    // Trim embedding snippets first (lowest priority)
    while (embeddingSnippets.length > 0 && currentTokens > maxTokens) {
      embeddingSnippets.pop();
      currentTokens = this.estimateContextTokens({ callers, callees, typeDefinitions, embeddingSnippets });
    }

    // Trim type definitions next
    while (typeDefinitions.length > 0 && currentTokens > maxTokens) {
      typeDefinitions.pop();
      currentTokens = this.estimateContextTokens({ callers, callees, typeDefinitions, embeddingSnippets });
    }

    // Trim callees
    while (callees.length > 0 && currentTokens > maxTokens) {
      callees.pop();
      currentTokens = this.estimateContextTokens({ callers, callees, typeDefinitions, embeddingSnippets });
    }

    // Trim callers (highest priority auto-context, trimmed last)
    while (callers.length > 0 && currentTokens > maxTokens) {
      callers.pop();
      currentTokens = this.estimateContextTokens({ callers, callees, typeDefinitions, embeddingSnippets });
    }

    return { callers, callees, typeDefinitions, embeddingSnippets };
  }

  /** Returns the current configuration. */
  getConfig(): Readonly<ContextInjectorConfig> {
    return this.config;
  }

  /** Updates the configuration with partial overrides. */
  updateConfig(partial: Partial<ContextInjectorConfig>): void {
    this.config = { ...this.config, ...partial };

    // Re-validate maxBudgetPercent range
    if (this.config.maxBudgetPercent < 10) {
      this.config.maxBudgetPercent = 10;
    } else if (this.config.maxBudgetPercent > 50) {
      this.config.maxBudgetPercent = 50;
    }
  }
}
