/**
 * Terminal Store — Multiple terminal sessions with rename and resize.
 * Ported from Zenith IDE for Punam IDE.
 */

import { create } from "zustand";

export interface TerminalSession {
  id: string;
  name: string;
  cwd: string;
  active: boolean;
}

interface TerminalState {
  sessions: TerminalSession[];
  activeSessionId: string;
  showTerminal: boolean;
  terminalHeight: number;

  addSession: (session: TerminalSession) => void;
  removeSession: (id: string) => void;
  setActiveSession: (id: string) => void;
  setShowTerminal: (show: boolean) => void;
  toggleTerminal: () => void;
  setTerminalHeight: (height: number) => void;
  renameSession: (id: string, name: string) => void;
}

export const useTerminalStore = create<TerminalState>((set) => ({
  sessions: [],
  activeSessionId: "",
  showTerminal: false,
  terminalHeight: 250,

  addSession: (session) => {
    set((state) => ({
      sessions: [...state.sessions, session],
      activeSessionId: session.id,
    }));
  },

  removeSession: (id) => {
    set((state) => {
      const filtered = state.sessions.filter((s) => s.id !== id);
      let activeId = state.activeSessionId;
      if (activeId === id) {
        activeId = filtered.length > 0 ? filtered[filtered.length - 1].id : "";
      }
      return { sessions: filtered, activeSessionId: activeId };
    });
  },

  setActiveSession: (id) => set({ activeSessionId: id }),
  setShowTerminal: (show) => set({ showTerminal: show }),
  toggleTerminal: () => set((state) => ({ showTerminal: !state.showTerminal })),
  setTerminalHeight: (height) => set({ terminalHeight: Math.max(100, Math.min(600, height)) }),

  renameSession: (id, name) => {
    set((state) => ({
      sessions: state.sessions.map((s) => (s.id === id ? { ...s, name } : s)),
    }));
  },
}));
