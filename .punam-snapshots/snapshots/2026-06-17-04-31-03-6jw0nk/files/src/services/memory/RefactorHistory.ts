/**
 * RefactorHistory.ts — Phase 2 Memory Subsystem
 *
 * CRUD store for refactor history (Refactor Memory).
 * Each entry stores: why the refactor occurred, what changed, risk level, and affected files.
 * Uses Zustand + Rust memory_engine. Supports timeline queries and risk analysis.
 */

import { create } from "zustand";
import { memoryCreate, memoryDelete, memoryList, memorySearch } from "./MemoryManager";
import { getMemoryIndexer } from "./MemoryIndexer";
import type { MemoryEntry, MemoryInput } from "./MemoryManager";

// ── Types ──────────────────────────────────────────────────────────────────────

export type RefactorRisk = "low" | "medium" | "high";

export interface RefactorEntry {
  id: string;
  title: string;
  reason: string;           // Why refactor occurred
  whatChanged: string;      // Summary of changes
  risk: RefactorRisk;
  filesInvolved: string[];
  tags: string[];
  performedAt: number;      // When the refactor happened
}

export interface RefactorTimeline {
  entries: RefactorEntry[];
  total: number;
  riskDistribution: { low: number; medium: number; high: number };
}

export interface RefactorHistoryState {
  refactors: Map<string, RefactorEntry>;
  isLoading: boolean;
  error: string | null;

  loadRefactors: () => Promise<void>;
  addRefactor: (input: { title: string; reason: string; whatChanged: string; risk?: RefactorRisk; filesInvolved?: string[]; tags?: string[] }) => Promise<RefactorEntry | null>;
  removeRefactor: (id: string) => Promise<void>;
  getTimeline: (limit?: number) => RefactorTimeline;
  searchRefactors: (query: string) => Promise<RefactorEntry[]>;
  getRefactorsByFile: (filePath: string) => RefactorEntry[];
  clear: () => void;
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function toRefactorView(entry: MemoryEntry): RefactorEntry {
  return {
    id: entry.id,
    title: entry.title,
    reason: entry.tags.find((t) => t.startsWith("reason:"))?.replace("reason:", "") || "",
    whatChanged: entry.tags.find((t) => t.startsWith("changed:"))?.replace("changed:", "") || entry.description,
    risk: (entry.tags.find((t) => t.startsWith("risk:"))?.replace("risk:", "") || "medium") as RefactorRisk,
    filesInvolved: entry.files_involved || [],
    tags: entry.tags.filter((t) => !t.startsWith("reason:") && !t.startsWith("changed:") && !t.startsWith("risk:")),
    performedAt: entry.created_at,
  };
}

function toMemoryInput(r: { title: string; reason: string; whatChanged: string; risk?: RefactorRisk; filesInvolved?: string[]; tags?: string[] }): MemoryInput {
  return {
    memory_type: "refactor",
    title: r.title,
    description: r.whatChanged.slice(0, 500),
    tags: [...(r.tags || []), `reason:${r.reason}`, `changed:${r.whatChanged.slice(0, 200)}`, `risk:${r.risk || "medium"}`],
    files_involved: r.filesInvolved || [],
    severity: r.risk === "high" ? "high" : r.risk === "medium" ? "medium" : "low",
  };
}

// ── Store ──────────────────────────────────────────────────────────────────────

export const useRefactorHistoryStore = create<RefactorHistoryState>((set, get) => ({
  refactors: new Map(),
  isLoading: false,
  error: null,

  loadRefactors: async () => {
    set({ isLoading: true, error: null });
    try {
      const result = await memoryList("refactor", 500, 0);
      const map = new Map<string, RefactorEntry>();
      for (const entry of result.entries) {
        map.set(entry.id, toRefactorView(entry));
      }
      set({ refactors: map, isLoading: false });
    } catch (err) {
      set({ error: `Failed to load refactors: ${err}`, isLoading: false });
    }
  },

  addRefactor: async (input) => {
    try {
      const entry = await memoryCreate(toMemoryInput(input));
      const refactor = toRefactorView(entry);
      set((s) => {
        const next = new Map(s.refactors);
        next.set(refactor.id, refactor);
        return { refactors: next };
      });
      getMemoryIndexer().invalidateCache();
      return refactor;
    } catch (err) {
      set({ error: `Failed to add refactor: ${err}` });
      return null;
    }
  },

  removeRefactor: async (id) => {
    try {
      await memoryDelete(id);
      set((s) => {
        const next = new Map(s.refactors);
        next.delete(id);
        return { refactors: next };
      });
      getMemoryIndexer().invalidateCache();
    } catch (err) {
      set({ error: `Failed to delete refactor: ${err}` });
    }
  },

  getTimeline: (limit = 30) => {
    const entries = Array.from(get().refactors.values())
      .sort((a, b) => b.performedAt - a.performedAt)
      .slice(0, limit);

    const riskDistribution = { low: 0, medium: 0, high: 0 };
    for (const r of entries) {
      riskDistribution[r.risk]++;
    }

    return {
      entries,
      total: get().refactors.size,
      riskDistribution,
    };
  },

  searchRefactors: async (query) => {
    try {
      const result = await memorySearch(query, "refactor", 20);
      return result.entries.map(toRefactorView);
    } catch {
      return [];
    }
  },

  getRefactorsByFile: (filePath) => {
    return Array.from(get().refactors.values()).filter((r) =>
      r.filesInvolved.some((f) => f === filePath || filePath.includes(f))
    );
  },

  clear: () => set({ refactors: new Map(), error: null }),
}));