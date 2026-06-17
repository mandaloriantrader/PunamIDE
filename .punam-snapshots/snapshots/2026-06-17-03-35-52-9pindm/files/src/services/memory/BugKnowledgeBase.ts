/**
 * BugKnowledgeBase.ts — Phase 2 Memory Subsystem
 *
 * CRUD store for bug resolutions (Bug Resolution Memory).
 * Each entry stores: root cause, fix applied, files involved, and date.
 * Uses Zustand + Rust memory_engine FTS5 for searchable bug history.
 */

import { create } from "zustand";
import { memoryCreate, memoryUpdate, memoryDelete, memoryList, memorySearch } from "./MemoryManager";
import { getMemoryIndexer } from "./MemoryIndexer";
import type { MemoryEntry, MemoryInput } from "./MemoryManager";

// ── Types ──────────────────────────────────────────────────────────────────────

export interface BugResolution {
  id: string;
  title: string;
  rootCause: string;
  fix: string;
  filesInvolved: string[];
  tags: string[];
  severity: "low" | "medium" | "high" | "critical";
  resolvedAt: number;
  updatedAt: number;
}

export interface BugKnowledgeState {
  bugs: Map<string, BugResolution>;
  isLoading: boolean;
  error: string | null;

  loadBugs: () => Promise<void>;
  addBug: (input: { title: string; rootCause: string; fix: string; filesInvolved?: string[]; tags?: string[]; severity?: string }) => Promise<BugResolution | null>;
  removeBug: (id: string) => Promise<void>;
  searchBugs: (query: string) => Promise<BugResolution[]>;
  getBugsByFile: (filePath: string) => BugResolution[];
  clear: () => void;
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function toBugView(entry: MemoryEntry): BugResolution {
  return {
    id: entry.id,
    title: entry.title,
    rootCause: entry.tags.find((t) => t.startsWith("root:"))?.replace("root:", "") || "",
    fix: entry.tags.find((t) => t.startsWith("fix:"))?.replace("fix:", "") || entry.description,
    filesInvolved: entry.files_involved || [],
    tags: entry.tags.filter((t) => !t.startsWith("root:") && !t.startsWith("fix:")),
    severity: entry.severity,
    resolvedAt: entry.created_at,
    updatedAt: entry.updated_at,
  };
}

function toMemoryInput(b: { title: string; rootCause: string; fix: string; filesInvolved?: string[]; tags?: string[]; severity?: string }): MemoryInput {
  return {
    memory_type: "bug_resolution",
    title: b.title,
    description: `Fix: ${b.fix.slice(0, 500)}`,
    tags: [...(b.tags || []), `root:${b.rootCause}`, `fix:${b.fix.slice(0, 200)}`],
    files_involved: b.filesInvolved || [],
    severity: b.severity || "medium",
  };
}

// ── Store ──────────────────────────────────────────────────────────────────────

export const useBugKnowledgeStore = create<BugKnowledgeState>((set, get) => ({
  bugs: new Map(),
  isLoading: false,
  error: null,

  loadBugs: async () => {
    set({ isLoading: true, error: null });
    try {
      const result = await memoryList("bug_resolution", 500, 0);
      const map = new Map<string, BugResolution>();
      for (const entry of result.entries) {
        map.set(entry.id, toBugView(entry));
      }
      set({ bugs: map, isLoading: false });
    } catch (err) {
      set({ error: `Failed to load bugs: ${err}`, isLoading: false });
    }
  },

  addBug: async (input) => {
    try {
      const entry = await memoryCreate(toMemoryInput(input));
      const bug = toBugView(entry);
      set((s) => {
        const next = new Map(s.bugs);
        next.set(bug.id, bug);
        return { bugs: next };
      });
      getMemoryIndexer().invalidateCache();
      return bug;
    } catch (err) {
      set({ error: `Failed to add bug: ${err}` });
      return null;
    }
  },

  removeBug: async (id) => {
    try {
      await memoryDelete(id);
      set((s) => {
        const next = new Map(s.bugs);
        next.delete(id);
        return { bugs: next };
      });
      getMemoryIndexer().invalidateCache();
    } catch (err) {
      set({ error: `Failed to delete bug: ${err}` });
    }
  },

  searchBugs: async (query) => {
    try {
      const result = await memorySearch(query, "bug_resolution", 20);
      return result.entries.map(toBugView);
    } catch {
      return [];
    }
  },

  getBugsByFile: (filePath) => {
    return Array.from(get().bugs.values()).filter((b) =>
      b.filesInvolved.some((f) => f === filePath || filePath.includes(f))
    );
  },

  clear: () => set({ bugs: new Map(), error: null }),
}));