/**
 * DecisionStore.ts — Phase 2 Memory Subsystem
 *
 * CRUD store for architectural decisions.
 * Uses Zustand for reactive state. Persists via Rust memory_engine.
 * Each decision records: what was decided, why, when, and which files are affected.
 */

import { create } from "zustand";
import { memoryCreate, memoryUpdate, memoryDelete, memoryList, memorySearch } from "./MemoryManager";
import { getMemoryIndexer } from "./MemoryIndexer";
import type { MemoryEntry, MemoryInput } from "./MemoryManager";

// ── Types ──────────────────────────────────────────────────────────────────────

export interface ArchitecturalDecision {
  id: string;
  title: string;
  description: string;
  reason: string;
  filesAffected: string[];
  tags: string[];
  severity: "low" | "medium" | "high" | "critical";
  createdAt: number;
  updatedAt: number;
}

export interface DecisionStoreState {
  decisions: Map<string, ArchitecturalDecision>;
  isLoading: boolean;
  error: string | null;

  // Actions
  loadDecisions: () => Promise<void>;
  addDecision: (input: { title: string; description: string; reason: string; filesAffected?: string[]; tags?: string[]; severity?: string }) => Promise<ArchitecturalDecision | null>;
  updateDecision: (id: string, updates: Partial<ArchitecturalDecision>) => Promise<void>;
  removeDecision: (id: string) => Promise<void>;
  searchDecisions: (query: string) => Promise<ArchitecturalDecision[]>;
  getDecisionsByFile: (filePath: string) => ArchitecturalDecision[];
  clear: () => void;
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function toDecisionView(entry: MemoryEntry): ArchitecturalDecision {
  return {
    id: entry.id,
    title: entry.title,
    description: entry.description,
    reason: entry.tags.find((t) => t.startsWith("reason:"))?.replace("reason:", "") || "",
    filesAffected: entry.files_involved || [],
    tags: entry.tags.filter((t) => !t.startsWith("reason:")),
    severity: entry.severity,
    createdAt: entry.created_at,
    updatedAt: entry.updated_at,
  };
}

function toMemoryInput(d: { title: string; description: string; reason: string; filesAffected?: string[]; tags?: string[]; severity?: string }): MemoryInput {
  return {
    memory_type: "architectural_decision",
    title: d.title,
    description: d.description,
    tags: [...(d.tags || []), `reason:${d.reason}`],
    files_involved: d.filesAffected || [],
    severity: d.severity || "medium",
  };
}

// ── Store ──────────────────────────────────────────────────────────────────────

export const useDecisionStore = create<DecisionStoreState>((set, get) => ({
  decisions: new Map(),
  isLoading: false,
  error: null,

  loadDecisions: async () => {
    set({ isLoading: true, error: null });
    try {
      const result = await memoryList("architectural_decision", 500, 0);
      const map = new Map<string, ArchitecturalDecision>();
      for (const entry of result.entries) {
        map.set(entry.id, toDecisionView(entry));
      }
      set({ decisions: map, isLoading: false });
    } catch (err) {
      set({ error: `Failed to load decisions: ${err}`, isLoading: false });
    }
  },

  addDecision: async (input) => {
    try {
      const entry = await memoryCreate(toMemoryInput(input));
      const decision = toDecisionView(entry);
      set((s) => {
        const next = new Map(s.decisions);
        next.set(decision.id, decision);
        return { decisions: next };
      });
      getMemoryIndexer().invalidateCache();
      return decision;
    } catch (err) {
      set({ error: `Failed to add decision: ${err}` });
      return null;
    }
  },

  updateDecision: async (id, updates) => {
    try {
      const current = get().decisions.get(id);
      if (!current) return;

      const merged = { ...current, ...updates };
      const input: MemoryInput = {
        memory_type: "architectural_decision",
        title: merged.title,
        description: merged.description,
        tags: [...merged.tags, `reason:${merged.reason}`],
        files_involved: merged.filesAffected,
        severity: merged.severity,
      };
      await memoryUpdate(id, input);

      set((s) => {
        const next = new Map(s.decisions);
        next.set(id, { ...merged, updatedAt: Date.now() });
        return { decisions: next };
      });
      getMemoryIndexer().invalidateCache();
    } catch (err) {
      set({ error: `Failed to update decision: ${err}` });
    }
  },

  removeDecision: async (id) => {
    try {
      await memoryDelete(id);
      set((s) => {
        const next = new Map(s.decisions);
        next.delete(id);
        return { decisions: next };
      });
      getMemoryIndexer().invalidateCache();
    } catch (err) {
      set({ error: `Failed to delete decision: ${err}` });
    }
  },

  searchDecisions: async (query) => {
    try {
      const result = await memorySearch(query, "architectural_decision", 20);
      return result.entries.map(toDecisionView);
    } catch {
      return [];
    }
  },

  getDecisionsByFile: (filePath) => {
    return Array.from(get().decisions.values()).filter((d) =>
      d.filesAffected.some((f) => f === filePath || filePath.includes(f))
    );
  },

  clear: () => set({ decisions: new Map(), error: null }),
}));