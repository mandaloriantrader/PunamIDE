/**
 * Editor Store — Centralized editor state: tabs, split, ghost text, diagnostics.
 * Ported from Zenith IDE for Punam IDE.
 */

import { create } from "zustand";

export interface EditorTab {
  id: string;
  path: string;
  name: string;
  content: string;
  originalContent: string;
  modified: boolean;
  language: string;
  viewState?: unknown;
  splitSide?: "left" | "right";
}

export interface EditorSplitState {
  enabled: boolean;
  orientation: "horizontal" | "vertical";
  sizes: number[];
}

export interface GhostTextSuggestion {
  text: string;
  range: {
    startLineNumber: number;
    startColumn: number;
    endLineNumber: number;
    endColumn: number;
  };
}

export interface InlineEditRequest {
  filePath: string;
  startLine: number;
  endLine: number;
  instruction: string;
  selectedText: string;
}

export interface Diagnostic {
  path: string;
  line: number;
  column: number;
  endLine?: number;
  endColumn?: number;
  message: string;
  severity: "error" | "warning" | "info" | "hint";
  source?: string;
  code?: string;
}

interface EditorState {
  tabs: EditorTab[];
  activeTabId: string;
  splitState: EditorSplitState;
  ghostText: GhostTextSuggestion | null;
  inlineEditRequest: InlineEditRequest | null;
  diagnostics: Diagnostic[];
  cursorPosition: { line: number; column: number };
  selectedText: string;

  openTab: (tab: EditorTab) => void;
  closeTab: (id: string) => void;
  setActiveTab: (id: string) => void;
  updateTabContent: (id: string, content: string) => void;
  markTabSaved: (id: string) => void;
  updateTabViewState: (id: string, viewState: unknown) => void;
  reorderTabs: (fromIndex: number, toIndex: number) => void;

  setSplitState: (state: Partial<EditorSplitState>) => void;
  toggleSplit: () => void;

  setGhostText: (suggestion: GhostTextSuggestion | null) => void;
  acceptGhostText: () => void;
  dismissGhostText: () => void;

  setInlineEditRequest: (request: InlineEditRequest | null) => void;

  setDiagnostics: (diagnostics: Diagnostic[]) => void;
  addDiagnostics: (diagnostics: Diagnostic[]) => void;
  clearDiagnostics: (path?: string) => void;

  setCursorPosition: (line: number, column: number) => void;
  setSelectedText: (text: string) => void;
}

export const useEditorStore = create<EditorState>((set, get) => ({
  tabs: [],
  activeTabId: "",
  splitState: { enabled: false, orientation: "vertical", sizes: [50, 50] },
  ghostText: null,
  inlineEditRequest: null,
  diagnostics: [],
  cursorPosition: { line: 1, column: 1 },
  selectedText: "",

  openTab: (tab) => {
    const existing = get().tabs.find((t) => t.path === tab.path);
    if (existing) {
      set({ activeTabId: existing.id });
      return;
    }
    set((state) => ({ tabs: [...state.tabs, tab], activeTabId: tab.id }));
  },

  closeTab: (id) => {
    set((state) => {
      const filtered = state.tabs.filter((t) => t.id !== id);
      let newActiveId = state.activeTabId;
      if (state.activeTabId === id) {
        const idx = state.tabs.findIndex((t) => t.id === id);
        if (filtered.length > 0) {
          newActiveId = filtered[Math.min(idx, filtered.length - 1)].id;
        } else {
          newActiveId = "";
        }
      }
      return { tabs: filtered, activeTabId: newActiveId };
    });
  },

  setActiveTab: (id) => set({ activeTabId: id }),

  updateTabContent: (id, content) => {
    set((state) => ({
      tabs: state.tabs.map((t) =>
        t.id === id ? { ...t, content, modified: content !== t.originalContent } : t
      ),
    }));
  },

  markTabSaved: (id) => {
    set((state) => ({
      tabs: state.tabs.map((t) =>
        t.id === id ? { ...t, modified: false, originalContent: t.content } : t
      ),
    }));
  },

  updateTabViewState: (id, viewState) => {
    set((state) => ({
      tabs: state.tabs.map((t) => (t.id === id ? { ...t, viewState } : t)),
    }));
  },

  reorderTabs: (fromIndex, toIndex) => {
    set((state) => {
      const tabs = [...state.tabs];
      const [removed] = tabs.splice(fromIndex, 1);
      tabs.splice(toIndex, 0, removed);
      return { tabs };
    });
  },

  setSplitState: (partial) => {
    set((state) => ({ splitState: { ...state.splitState, ...partial } }));
  },

  toggleSplit: () => {
    set((state) => ({ splitState: { ...state.splitState, enabled: !state.splitState.enabled } }));
  },

  setGhostText: (suggestion) => set({ ghostText: suggestion }),
  acceptGhostText: () => set({ ghostText: null }),
  dismissGhostText: () => set({ ghostText: null }),

  setInlineEditRequest: (request) => set({ inlineEditRequest: request }),

  setDiagnostics: (diagnostics) => set({ diagnostics }),
  addDiagnostics: (diagnostics) => {
    set((state) => ({ diagnostics: [...state.diagnostics, ...diagnostics] }));
  },
  clearDiagnostics: (path) => {
    if (path) {
      set((state) => ({ diagnostics: state.diagnostics.filter((d) => d.path !== path) }));
    } else {
      set({ diagnostics: [] });
    }
  },

  setCursorPosition: (line, column) => set({ cursorPosition: { line, column } }),
  setSelectedText: (text) => set({ selectedText: text }),
}));
