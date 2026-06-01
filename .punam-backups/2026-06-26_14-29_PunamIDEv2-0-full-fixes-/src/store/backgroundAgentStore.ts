/**
 * Background Agent Store — Manages state for background AI task execution.
 * Allows the user to keep coding while Punam works on a task independently.
 */

import { create } from "zustand";

export type BackgroundAgentStep =
  | "queued"
  | "planning"
  | "proposing_fix"
  | "awaiting_approval"
  | "running_command"
  | "analyzing_output"
  | "verifying"
  | "completed"
  | "failed"
  | "paused"
  | "cancelled";

export interface BackgroundFileChange {
  path: string;
  content: string;
  isNew: boolean;
  applied: boolean;
  conflicting: boolean;
}

export interface BackgroundAgentLog {
  timestamp: number;
  step: BackgroundAgentStep;
  message: string;
}

export interface BackgroundAgentSession {
  id: string;
  task: string;
  step: BackgroundAgentStep;
  subtasks: string[];
  currentSubtask: number;
  attempt: number;
  maxAttempts: number;
  startedAt: number;
  completedAt: number | null;
  logs: BackgroundAgentLog[];
  fileChanges: BackgroundFileChange[];
  terminalOutput: string;
  error: string | null;
  // Context snapshot at launch time
  projectPath: string;
  contextFiles: string[];
}

interface BackgroundAgentState {
  session: BackgroundAgentSession | null;
  isRunning: boolean;
  isPaused: boolean;
  showPanel: boolean;

  // Actions
  startSession: (task: string, projectPath: string, contextFiles: string[], subtasks?: string[]) => void;
  updateStep: (step: BackgroundAgentStep, message?: string) => void;
  addLog: (step: BackgroundAgentStep, message: string) => void;
  addFileChange: (change: BackgroundFileChange) => void;
  markFileApplied: (path: string) => void;
  markFileConflicting: (path: string) => void;
  appendTerminalOutput: (output: string) => void;
  advanceSubtask: () => void;
  pause: () => void;
  resume: () => void;
  cancel: () => void;
  complete: () => void;
  fail: (error: string) => void;
  approveChanges: () => void;
  rejectChanges: () => void;
  togglePanel: () => void;
  clearSession: () => void;
}

export const useBackgroundAgentStore = create<BackgroundAgentState>((set, get) => ({
  session: null,
  isRunning: false,
  isPaused: false,
  showPanel: false,

  startSession: (task, projectPath, contextFiles, subtasks = []) => {
    const session: BackgroundAgentSession = {
      id: `bg-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      task,
      step: "planning",
      subtasks,
      currentSubtask: 0,
      attempt: 1,
      maxAttempts: 5,
      startedAt: Date.now(),
      completedAt: null,
      logs: [{ timestamp: Date.now(), step: "planning", message: `Starting: ${task}` }],
      fileChanges: [],
      terminalOutput: "",
      error: null,
      projectPath,
      contextFiles,
    };
    set({ session, isRunning: true, isPaused: false });
  },

  updateStep: (step, message) => {
    const { session } = get();
    if (!session) return;
    const log: BackgroundAgentLog = {
      timestamp: Date.now(),
      step,
      message: message || formatStepLabel(step),
    };
    set({
      session: { ...session, step, logs: [...session.logs, log] },
    });
  },

  addLog: (step, message) => {
    const { session } = get();
    if (!session) return;
    const log: BackgroundAgentLog = { timestamp: Date.now(), step, message };
    set({ session: { ...session, logs: [...session.logs, log] } });
  },

  addFileChange: (change) => {
    const { session } = get();
    if (!session) return;
    set({ session: { ...session, fileChanges: [...session.fileChanges, change] } });
  },

  markFileApplied: (path) => {
    const { session } = get();
    if (!session) return;
    set({
      session: {
        ...session,
        fileChanges: session.fileChanges.map((fc) =>
          fc.path === path ? { ...fc, applied: true } : fc
        ),
      },
    });
  },

  markFileConflicting: (path) => {
    const { session } = get();
    if (!session) return;
    set({
      session: {
        ...session,
        fileChanges: session.fileChanges.map((fc) =>
          fc.path === path ? { ...fc, conflicting: true } : fc
        ),
      },
    });
  },

  appendTerminalOutput: (output) => {
    const { session } = get();
    if (!session) return;
    set({ session: { ...session, terminalOutput: session.terminalOutput + output } });
  },

  advanceSubtask: () => {
    const { session } = get();
    if (!session) return;
    const next = session.currentSubtask + 1;
    if (next >= session.subtasks.length) {
      get().complete();
    } else {
      set({
        session: {
          ...session,
          currentSubtask: next,
          step: "planning",
          attempt: 1,
          logs: [
            ...session.logs,
            { timestamp: Date.now(), step: "planning", message: `Subtask ${next + 1}/${session.subtasks.length}: ${session.subtasks[next]}` },
          ],
        },
      });
    }
  },

  pause: () => {
    const { session } = get();
    if (!session || !get().isRunning) return;
    set({
      isPaused: true,
      session: {
        ...session,
        step: "paused",
        logs: [...session.logs, { timestamp: Date.now(), step: "paused", message: "Paused by user" }],
      },
    });
  },

  resume: () => {
    const { session } = get();
    if (!session || !get().isPaused) return;
    const previousStep = session.logs
      .filter((l) => l.step !== "paused")
      .pop()?.step || "planning";
    set({
      isPaused: false,
      session: {
        ...session,
        step: previousStep as BackgroundAgentStep,
        logs: [...session.logs, { timestamp: Date.now(), step: previousStep as BackgroundAgentStep, message: "Resumed" }],
      },
    });
  },

  cancel: () => {
    const { session } = get();
    if (!session) return;
    set({
      isRunning: false,
      isPaused: false,
      session: {
        ...session,
        step: "cancelled",
        completedAt: Date.now(),
        logs: [...session.logs, { timestamp: Date.now(), step: "cancelled", message: "Cancelled by user" }],
      },
    });
  },

  complete: () => {
    const { session } = get();
    if (!session) return;
    set({
      isRunning: false,
      isPaused: false,
      session: {
        ...session,
        step: "completed",
        completedAt: Date.now(),
        logs: [...session.logs, { timestamp: Date.now(), step: "completed", message: "All tasks completed" }],
      },
    });
  },

  fail: (error) => {
    const { session } = get();
    if (!session) return;
    set({
      isRunning: false,
      isPaused: false,
      session: {
        ...session,
        step: "failed",
        completedAt: Date.now(),
        error,
        logs: [...session.logs, { timestamp: Date.now(), step: "failed", message: error }],
      },
    });
  },

  approveChanges: () => {
    const { session } = get();
    if (!session || session.step !== "awaiting_approval") return;
    set({
      session: {
        ...session,
        step: "verifying",
        logs: [...session.logs, { timestamp: Date.now(), step: "verifying", message: "Changes approved by user" }],
      },
    });
  },

  rejectChanges: () => {
    const { session } = get();
    if (!session || session.step !== "awaiting_approval") return;
    // Remove unapplied file changes from this round
    const cleaned = session.fileChanges.filter(fc => fc.applied);
    set({
      session: {
        ...session,
        step: "analyzing_output",
        fileChanges: cleaned,
        logs: [...session.logs, { timestamp: Date.now(), step: "analyzing_output", message: "Changes rejected by user — will retry with different approach" }],
      },
    });
  },

  togglePanel: () => set((s) => ({ showPanel: !s.showPanel })),

  clearSession: () => set({ session: null, isRunning: false, isPaused: false }),
}));

function formatStepLabel(step: BackgroundAgentStep): string {
  switch (step) {
    case "planning": return "Planning approach...";
    case "proposing_fix": return "Generating code changes...";
    case "running_command": return "Running command...";
    case "analyzing_output": return "Analyzing results...";
    case "verifying": return "Verifying...";
    case "completed": return "Done";
    case "failed": return "Failed";
    case "paused": return "Paused";
    case "cancelled": return "Cancelled";
    default: return step;
  }
}
