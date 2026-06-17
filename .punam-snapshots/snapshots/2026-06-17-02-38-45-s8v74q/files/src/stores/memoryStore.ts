/**
 * Memory Store — Zustand store for project memory state (Phase 2).
 * Manages memory entries, search results, and context injection state.
 */
import { create } from "zustand";
import type { MemoryEntry } from "../services/memory/MemoryManager";
import {
  memoryList,
  memorySearch,
  memoryGetByFile,
  memoryGetTimeline,
  memoryCreate,
  buildMemoryContext,
} from "../services/memory/MemoryManager";

interface MemoryState {
  /** All loaded memory entries. */
  entries: MemoryEntry[];
  /** Entries related to the currently active file. */
  fileMemories: MemoryEntry[];
  /** Timeline entries (most recent across all types). */
  timeline: MemoryEntry[];
  /** Context string for AI injection (auto-built). */
  aiContext: string;
  /** Loading states. */
  loading: boolean;
  /** Active search query + results. */
  searchQuery: string;
  searchResults: MemoryEntry[];
  /** Actions. */
  loadEntries: (type?: string) => Promise<void>;
  loadFileMemories: (filePath: string) => Promise<void>;
  loadTimeline: () => Promise<void>;
  searchMemories: (query: string, type?: string) => Promise<void>;
  addMemory: (
    memoryType: string,
    title: string,
    description: string,
  ) => Promise<MemoryEntry>;
  buildAiContext: (activeFilePath?: string | null) => Promise<string>;
  setSearchQuery: (q: string) => void;
}

export const useMemoryStore = create<MemoryState>((set, get) => ({
  entries: [],
  fileMemories: [],
  timeline: [],
  aiContext: "",
  loading: false,
  searchQuery: "",
  searchResults: [],

  loadEntries: async (type?: string) => {
    set({ loading: true });
    try {
      const result = await memoryList(type, 30, 0);
      set({ entries: result.entries, loading: false });
    } catch {
      set({ loading: false });
    }
  },

  loadFileMemories: async (filePath: string) => {
    try {
      const entries = await memoryGetByFile(filePath);
      set({ fileMemories: entries });
    } catch {
      set({ fileMemories: [] });
    }
  },

  loadTimeline: async () => {
    try {
      const entries = await memoryGetTimeline(30);
      set({ timeline: entries });
    } catch {
      set({ timeline: [] });
    }
  },

  searchMemories: async (query: string, type?: string) => {
    set({ loading: true, searchQuery: query });
    try {
      const result = await memorySearch(query, type, 20);
      set({ searchResults: result.entries, loading: false });
    } catch {
      set({ loading: false });
    }
  },

  addMemory: async (memoryType, title, description) => {
    const entry = await memoryCreate({
      memory_type: memoryType,
      title,
      description,
      tags: [],
      files_involved: [],
      severity: "medium",
    });
    // Refresh
    set((s) => ({ entries: [entry, ...s.entries], timeline: [entry, ...s.timeline] }));
    return entry;
  },

  buildAiContext: async (activeFilePath) => {
    const ctx = await buildMemoryContext(activeFilePath);
    set({ aiContext: ctx });
    return ctx;
  },

  setSearchQuery: (q) => set({ searchQuery: q }),
}));