/**
 * File Store — Centralized file/project state management.
 * Ported from Zenith IDE for Punam IDE.
 */

import { create } from "zustand";
import type { FileEntry } from "../utils/tauri";

interface FileState {
  projectPath: string;
  files: FileEntry[];
  expandedDirs: Set<string>;
  selectedPath: string;
  recentProjects: string[];

  setProjectPath: (path: string) => void;
  setFiles: (files: FileEntry[]) => void;
  toggleDir: (path: string) => void;
  setSelectedPath: (path: string) => void;
  addRecentProject: (path: string) => void;
  setRecentProjects: (projects: string[]) => void;
}

export const useFileStore = create<FileState>((set, get) => ({
  projectPath: "",
  files: [],
  expandedDirs: new Set<string>(),
  selectedPath: "",
  recentProjects: [],

  setProjectPath: (path) => set({ projectPath: path, files: [], expandedDirs: new Set() }),
  setFiles: (files) => set({ files }),

  toggleDir: (path) => {
    set((state) => {
      const next = new Set(state.expandedDirs);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return { expandedDirs: next };
    });
  },

  setSelectedPath: (path) => set({ selectedPath: path }),

  addRecentProject: (path) => {
    const current = get().recentProjects.filter((p) => p !== path);
    set({ recentProjects: [path, ...current].slice(0, 20) });
  },

  setRecentProjects: (projects) => set({ recentProjects: projects }),
}));
