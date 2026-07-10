/**
 * ContextSidebarModel — State + selection logic for the AI Context Sidebar.
 *
 * Drives the `ContextSidebar` UI by gathering the AI's working context — callers
 * and callees of the function at the cursor, related files (import analysis +
 * semantic search), active LSP diagnostics, and the current token budget — and by
 * exposing the pure selection logic that decides which items are *displayed*
 * (`selectVisible`) and which items are *injected into AI prompts*
 * (`selectForPrompt`).
 *
 * Pinned items are first-class: they are always retained for display (exempt from
 * per-section caps) and are never dropped from the prompt regardless of budget.
 *
 * Reuses existing infrastructure rather than duplicating it:
 *  - `callgraph_lookup` / `callgraph_callees` / `symbol_list_file` for call graph
 *  - `ContextInjector` (import analysis) + `search_codebase` for related files
 *  - `TokenBudgetManager` `BudgetStatus` for the budget display/cap
 *
 * @see Requirements 16.1, 16.2, 16.3, 16.5, 16.6
 * @see Design — Tier C, Component 16
 */

import { invoke } from "@tauri-apps/api/core";
import type { BudgetStatus } from "../agent/TokenBudgetManager";
import {
  ContextInjector,
  type CallEdge,
  type SymbolEntry,
} from "../intelligence/ContextInjector";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** The category of a context item shown in the sidebar. */
export type ContextItemKind = "caller" | "callee" | "related_file" | "diagnostic";

/** A single, navigable/pinnable context item displayed in the sidebar. */
export interface ContextItem {
  /** Stable id (e.g. "caller:src/a.ts:foo") — used to preserve pin state across refreshes. */
  id: string;
  kind: ContextItemKind;
  label: string;
  /** Navigation target for callers/callees/related files. */
  location?: { filePath: string; line: number; character: number };
  /** Relevance score used for automatic ranking (0..1). */
  score: number;
  pinned: boolean;
}

/** Per-section display caps for the sidebar. */
export interface SidebarCaps {
  callers: number; // default 20
  callees: number; // default 20
  relatedFiles: number; // default 15
}

/** Default per-section display caps. */
export const DEFAULT_SIDEBAR_CAPS: SidebarCaps = {
  callers: 20,
  callees: 20,
  relatedFiles: 15,
};

/** A single diagnostic mirrored from the active LSP diagnostics for the file. */
export interface DiagnosticInfo {
  code: string;
  message: string;
  severity: "error" | "warning" | "info" | "hint";
  startLine: number;
  endLine: number;
}

/** Observable state of the context sidebar. */
export interface SidebarState {
  cursorSymbol: string | null;
  items: ContextItem[];
  budget: BudgetStatus;
  caps: SidebarCaps;
}

/** Debounce window (ms) for cursor-driven refreshes. */
const CURSOR_REFRESH_DEBOUNCE_MS = 500;

/**
 * Rough per-item token estimate used by `selectForPrompt` when filling the
 * remaining code-context budget. Kept deterministic and intentionally simple:
 * label length + a fixed location overhead, divided by the ~4 chars/token ratio.
 */
function estimateItemTokens(item: ContextItem): number {
  const locationOverhead = item.location ? 16 : 0;
  return Math.max(1, Math.ceil((item.label.length + locationOverhead) / 4));
}

/** A zero/empty budget used before a real `BudgetStatus` is supplied. */
function emptyBudget(): BudgetStatus {
  return {
    allocation: {
      systemPrompt: 0,
      userMessage: 0,
      codeContext: 0,
      responseReserve: 0,
      totalAvailable: 0,
    },
    used: {
      systemPrompt: 0,
      userMessage: 0,
      codeContext: 0,
      conversationHistory: 0,
    },
    remaining: {
      codeContext: 0,
      total: 0,
    },
    percentUsed: 0,
    overBudget: false,
  };
}

// ---------------------------------------------------------------------------
// ContextSidebarModel
// ---------------------------------------------------------------------------

/**
 * Holds the sidebar's items and budget, gathers context from the backend, and
 * provides the pure selection logic for display and prompt injection.
 */
export class ContextSidebarModel {
  private cursorSymbol: string | null = null;
  private items: ContextItem[] = [];
  private budget: BudgetStatus = emptyBudget();
  private caps: SidebarCaps;

  private readonly injector: ContextInjector;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(options?: { caps?: Partial<SidebarCaps>; injector?: ContextInjector }) {
    this.caps = { ...DEFAULT_SIDEBAR_CAPS, ...options?.caps };
    this.injector = options?.injector ?? new ContextInjector();
  }

  // -------------------------------------------------------------------------
  // State accessors
  // -------------------------------------------------------------------------

  /** Returns a snapshot of the current sidebar state. */
  getState(): SidebarState {
    return {
      cursorSymbol: this.cursorSymbol,
      items: this.getItems(),
      budget: { ...this.budget },
      caps: { ...this.caps },
    };
  }

  /** Returns a copy of the current items. */
  getItems(): ContextItem[] {
    return this.items.map((item) => ({ ...item }));
  }

  /** Updates the token budget shown in the sidebar. */
  setBudget(budget: BudgetStatus): void {
    this.budget = budget;
  }

  /** Returns the current per-section caps. */
  getCaps(): SidebarCaps {
    return { ...this.caps };
  }

  // -------------------------------------------------------------------------
  // Pure selection logic
  // -------------------------------------------------------------------------

  /**
   * Select the items to display per section. Pinned items are ALWAYS retained
   * (exempt from caps); the remaining `max(0, cap - pinnedCount)` slots per
   * section are filled with the highest-scoring unpinned items (descending
   * score). Diagnostics are uncapped. Order of returned items follows the
   * section order: callers, callees, related files, diagnostics.
   *
   * Pure given (items, caps).
   *
   * @see Property 42 (pinned always included), Property 43 (caps respected)
   */
  selectVisible(items: ContextItem[], caps: SidebarCaps): ContextItem[] {
    const sectionOrder: ContextItemKind[] = [
      "caller",
      "callee",
      "related_file",
      "diagnostic",
    ];

    const result: ContextItem[] = [];

    for (const kind of sectionOrder) {
      const sectionItems = items.filter((i) => i.kind === kind);
      const pinned = sectionItems.filter((i) => i.pinned);
      const unpinned = sectionItems.filter((i) => !i.pinned);

      // Diagnostics are not capped.
      if (kind === "diagnostic") {
        result.push(...pinned, ...unpinned);
        continue;
      }

      const cap = this.capForKind(kind, caps);
      // Highest-scoring unpinned items fill the slots remaining after pinned.
      const remainingSlots = Math.max(0, cap - pinned.length);
      const topUnpinned = [...unpinned]
        .sort((a, b) => b.score - a.score)
        .slice(0, remainingSlots);

      result.push(...pinned, ...topUnpinned);
    }

    return result;
  }

  /**
   * Select the items that MUST be injected into the AI prompt: every pinned item
   * plus the top-scoring unpinned items that fit within the code-context budget.
   *
   * Pinned items are NEVER dropped, even when their combined estimate exceeds the
   * budget. Unpinned items are added in descending score order while the running
   * estimate stays within `budget.remaining.codeContext`.
   *
   * Pure given (items, budget).
   *
   * @see Property 42 (pinned always included)
   */
  selectForPrompt(items: ContextItem[], budget: BudgetStatus): ContextItem[] {
    const pinned = items.filter((i) => i.pinned);
    const unpinned = items
      .filter((i) => !i.pinned)
      .sort((a, b) => b.score - a.score);

    const result: ContextItem[] = [...pinned];

    const cap = Math.max(0, budget?.remaining?.codeContext ?? 0);
    let used = pinned.reduce((sum, item) => sum + estimateItemTokens(item), 0);

    for (const item of unpinned) {
      const cost = estimateItemTokens(item);
      if (used + cost > cap) {
        // Stop once the next item would exceed the remaining budget.
        break;
      }
      result.push(item);
      used += cost;
    }

    return result;
  }

  // -------------------------------------------------------------------------
  // Pinning
  // -------------------------------------------------------------------------

  /** Flip the pinned flag for the item with the given id (no-op if not found). */
  togglePin(itemId: string): void {
    const item = this.items.find((i) => i.id === itemId);
    if (item) {
      item.pinned = !item.pinned;
    }
  }

  // -------------------------------------------------------------------------
  // Data gathering
  // -------------------------------------------------------------------------

  /**
   * Refresh callers/callees for the symbol at the cursor. Debounced to 500ms so
   * rapid cursor movement coalesces into a single backend round-trip.
   *
   * Resolves the enclosing symbol via `symbol_list_file`, then gathers callers
   * via `callgraph_lookup` and callees via `callgraph_callees`, mapping each edge
   * to a `ContextItem`. Existing pinned flags are preserved by matching item ids.
   */
  refreshForCursor(filePath: string, line: number, character: number): Promise<void> {
    if (this.debounceTimer !== null) {
      clearTimeout(this.debounceTimer);
    }

    return new Promise<void>((resolve) => {
      this.debounceTimer = setTimeout(() => {
        this.debounceTimer = null;
        void this.refreshForCursorNow(filePath, line, character).finally(resolve);
      }, CURSOR_REFRESH_DEBOUNCE_MS);
    });
  }

  /** Immediate (non-debounced) caller/callee refresh — see `refreshForCursor`. */
  private async refreshForCursorNow(
    filePath: string,
    line: number,
    _character: number
  ): Promise<void> {
    const symbol = await this.resolveEnclosingSymbol(filePath, line);
    this.cursorSymbol = symbol ? symbol.name : null;

    // Clear previous call-graph items; related files and diagnostics are untouched.
    const preserved = this.items.filter(
      (i) => i.kind !== "caller" && i.kind !== "callee"
    );

    if (!symbol) {
      this.items = preserved;
      return;
    }

    const [callers, callees] = await Promise.all([
      this.fetchCallers(symbol.name),
      this.fetchCallees(symbol.name),
    ]);

    const callerItems = this.mapCallersToItems(callers);
    const calleeItems = this.mapCalleesToItems(callees);

    this.items = this.mergePreservingPins([
      ...preserved,
      ...callerItems,
      ...calleeItems,
    ]);
  }

  /**
   * Gather related files via `ContextInjector` (import analysis) + semantic
   * search (`search_codebase`), mapping results to `related_file` items.
   * Existing pinned flags are preserved by id.
   */
  async refreshRelatedFiles(filePath: string): Promise<void> {
    let relatedItems: ContextItem[] = [];

    try {
      const context = await this.injector.gatherContext({
        filePath,
        cursorLine: 0,
        cursorColumn: 0,
        userQuery: filePath,
        userMentions: [],
        tokenBudget: this.budget.allocation.codeContext || 4000,
      });

      const seen = new Set<string>();
      relatedItems = context.embeddingSnippets
        .filter((snippet) => {
          if (snippet.filePath === filePath) return false;
          if (seen.has(snippet.filePath)) return false;
          seen.add(snippet.filePath);
          return true;
        })
        .map((snippet) => ({
          id: `related_file:${snippet.filePath}`,
          kind: "related_file" as const,
          label: snippet.filePath,
          location: { filePath: snippet.filePath, line: 0, character: 0 },
          score: clampScore(snippet.score),
          pinned: false,
        }));
    } catch {
      // Fall back to whatever we have; keep the section functional.
      relatedItems = [];
    }

    const preserved = this.items.filter((i) => i.kind !== "related_file");
    this.items = this.mergePreservingPins([...preserved, ...relatedItems]);
  }

  /**
   * Mirror active LSP diagnostics for the current file into `diagnostic` items.
   * Replaces any prior diagnostic items while preserving pin state by id.
   */
  setDiagnostics(filePath: string, diagnostics: DiagnosticInfo[]): void {
    const diagnosticItems: ContextItem[] = diagnostics.map((diag, index) => ({
      id: `diagnostic:${filePath}:${diag.startLine}:${diag.code || index}`,
      kind: "diagnostic" as const,
      label: `${diag.severity.toUpperCase()}: ${diag.message}`,
      location: { filePath, line: diag.startLine, character: 0 },
      score: severityScore(diag.severity),
      pinned: false,
    }));

    const preserved = this.items.filter((i) => i.kind !== "diagnostic");
    this.items = this.mergePreservingPins([...preserved, ...diagnosticItems]);
  }

  // -------------------------------------------------------------------------
  // Backend round-trips (mirror ContextInjector patterns)
  // -------------------------------------------------------------------------

  /** Resolve the function symbol enclosing the cursor via `symbol_list_file`. */
  private async resolveEnclosingSymbol(
    filePath: string,
    cursorLine: number
  ): Promise<SymbolEntry | null> {
    try {
      const result = await invoke<{ symbols: SymbolEntry[]; count: number }>(
        "symbol_list_file",
        { filePath }
      );

      const functionKinds = new Set([
        "function",
        "method",
        "arrow_function",
        "generator",
      ]);
      const enclosing = result.symbols
        .filter((s) => functionKinds.has(s.kind) && s.line <= cursorLine)
        .sort((a, b) => b.line - a.line);

      return enclosing.length > 0 ? enclosing[0] : null;
    } catch {
      return null;
    }
  }

  /** Fetch callers of a function, with a frequency-derived relevance score. */
  private async fetchCallers(
    functionName: string
  ): Promise<Array<{ edge: CallEdge; count: number }>> {
    try {
      const result = await invoke<{
        function_name: string;
        callers: CallEdge[];
        total_callers: number;
      }>("callgraph_lookup", { functionName });

      return frequencyRank(result.callers, (edge) => `${edge.caller}::${edge.caller_file}`);
    } catch {
      return [];
    }
  }

  /** Fetch callees of a function, with a frequency-derived relevance score. */
  private async fetchCallees(
    functionName: string
  ): Promise<Array<{ edge: CallEdge; count: number }>> {
    try {
      const result = await invoke<{
        function_name: string;
        callees: CallEdge[];
        total_callees: number;
      }>("callgraph_callees", { functionName });

      return frequencyRank(result.callees, (edge) => `${edge.callee}::${edge.caller_file}`);
    } catch {
      return [];
    }
  }

  // -------------------------------------------------------------------------
  // Mapping helpers
  // -------------------------------------------------------------------------

  private mapCallersToItems(
    callers: Array<{ edge: CallEdge; count: number }>
  ): ContextItem[] {
    const maxCount = Math.max(1, ...callers.map((c) => c.count));
    return callers.map(({ edge, count }) => ({
      id: `caller:${edge.caller_file}:${edge.caller}`,
      kind: "caller" as const,
      label: edge.caller,
      location: { filePath: edge.caller_file, line: edge.call_line, character: 0 },
      score: clampScore(count / maxCount),
      pinned: false,
    }));
  }

  private mapCalleesToItems(
    callees: Array<{ edge: CallEdge; count: number }>
  ): ContextItem[] {
    const maxCount = Math.max(1, ...callees.map((c) => c.count));
    return callees.map(({ edge, count }) => ({
      id: `callee:${edge.caller_file}:${edge.callee}`,
      kind: "callee" as const,
      label: edge.callee,
      location: { filePath: edge.caller_file, line: edge.call_line, character: 0 },
      score: clampScore(count / maxCount),
      pinned: false,
    }));
  }

  private capForKind(kind: ContextItemKind, caps: SidebarCaps): number {
    switch (kind) {
      case "caller":
        return caps.callers;
      case "callee":
        return caps.callees;
      case "related_file":
        return caps.relatedFiles;
      default:
        return Number.POSITIVE_INFINITY;
    }
  }

  /**
   * Merge a fresh set of items into a list, preserving the `pinned` flag of any
   * existing item with the same id. Later entries win on id collision.
   */
  private mergePreservingPins(next: ContextItem[]): ContextItem[] {
    const previousPins = new Map<string, boolean>();
    for (const item of this.items) {
      previousPins.set(item.id, item.pinned);
    }

    const byId = new Map<string, ContextItem>();
    for (const item of next) {
      const wasPinned = previousPins.get(item.id);
      byId.set(item.id, {
        ...item,
        pinned: item.pinned || wasPinned === true,
      });
    }

    return Array.from(byId.values());
  }
}

// ---------------------------------------------------------------------------
// Module-private helpers
// ---------------------------------------------------------------------------

/** Clamp a score into the 0..1 range. */
function clampScore(score: number): number {
  if (!Number.isFinite(score)) return 0;
  return Math.min(1, Math.max(0, score));
}

/** Map a diagnostic severity to a relevance score (errors rank highest). */
function severityScore(severity: DiagnosticInfo["severity"]): number {
  switch (severity) {
    case "error":
      return 1;
    case "warning":
      return 0.75;
    case "info":
      return 0.5;
    case "hint":
      return 0.25;
    default:
      return 0;
  }
}

/**
 * Group edges by a derived key, count occurrences, and return them sorted by
 * frequency (descending). The count drives the relevance score downstream.
 */
function frequencyRank<T>(
  edges: T[],
  keyOf: (edge: T) => string
): Array<{ edge: T; count: number }> {
  const map = new Map<string, { edge: T; count: number }>();
  for (const edge of edges) {
    const key = keyOf(edge);
    const existing = map.get(key);
    if (existing) {
      existing.count++;
    } else {
      map.set(key, { edge, count: 1 });
    }
  }
  return Array.from(map.values()).sort((a, b) => b.count - a.count);
}
