/**
 * Background Agent Store — Manages state for background AI task execution.
 * Allows the user to keep coding while Punam works on a task independently.
 */

import { create } from "zustand";
import type { CommandApprovalRequest } from "../services/agent/ToolPolicies";

const MAX_BACKGROUND_LOGS = 500;
const MAX_BACKGROUND_FILE_CHANGES = 500;
const MAX_BACKGROUND_TERMINAL_CHARS = 500_000;

// ─── Task Planner Types ────────────────────────────────────────────────────────

export interface TaskPhase {
  name: "decompose" | "gather_context" | "reason" | "generate" | "verify";
  status: "pending" | "in_progress" | "completed" | "skipped";
  startedAt?: number;
  completedAt?: number;
}

export type PlannerSubtaskStatus = "pending" | "in_progress" | "completed" | "failed" | "skipped";

export interface PlannerSubtask {
  id: string;
  index: number;
  title: string;
  status: PlannerSubtaskStatus;
  affectedFiles: string[];
  dependsOn: string[];
  dependedBy: string[];
}

export interface SubtaskDetail {
  affectedFiles: string[];
  dependsOn: string[];
  dependedBy: string[];
}

// ─── Reasoning Display Types ───────────────────────────────────────────────────

export interface CodeReference {
  filePath: string;
  startLine: number;
  endLine: number;
  symbol?: string;
}

export interface ReasoningChunk {
  id: string;
  phase: "analysis" | "planning" | "execution";
  content: string;
  timestamp: number;
  codeReferences: CodeReference[];
}

function appendLog(logs: BackgroundAgentLog[], log: BackgroundAgentLog): BackgroundAgentLog[] {
  return [...logs, log].slice(-MAX_BACKGROUND_LOGS);
}

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

  /** Pending command approval (non-blocking — replaces window.confirm) */
  pendingCommandApproval: CommandApprovalRequest | null;

  // ─── Task Planner State ────────────────────────────────────────────────────
  phases: TaskPhase[];
  currentPhase: TaskPhase["name"] | null;
  reasoningStream: string;
  subtaskDetails: Map<string, SubtaskDetail>;
  plannerSubtasks: PlannerSubtask[];

  // ─── Reasoning Display State ───────────────────────────────────────────────
  reasoningChunks: ReasoningChunk[];
  reasoningMode: "compact" | "expanded";
  reasoningVisible: boolean;
  phaseTimings: Map<string, { startedAt: number; elapsedMs: number }>;

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

  /** Set a pending command approval request (non-blocking). */
  requestCommandApproval: (request: CommandApprovalRequest) => void;
  /** Resolve the pending command approval (user clicked approve/deny). */
  resolveCommandApproval: (approved: boolean) => void;

  // ─── Task Planner Actions ──────────────────────────────────────────────────
  /** Set the phases for the current task plan */
  setPhases: (phases: TaskPhase[]) => void;
  /** Advance to the specified phase, marking prior as completed */
  advancePhase: (phase: TaskPhase["name"]) => void;
  /** Append a chunk of text to the reasoning stream */
  appendReasoningStream: (chunk: string) => void;
  /** Clear the reasoning stream */
  clearReasoningStream: () => void;
  /** Set the planner subtasks list */
  setPlannerSubtasks: (subtasks: PlannerSubtask[]) => void;
  /** Cancel a subtask and transitively mark all dependents as "skipped" */
  cancelSubtask: (subtaskId: string) => void;
  /** Traverse dependency graph and mark unreachable subtasks as "skipped" */
  skipDependentSubtasks: (cancelledId: string) => void;

  // ─── Reasoning Display Actions ─────────────────────────────────────────────
  /** Append a reasoning chunk (evicts oldest when exceeding 1000 chunks) */
  appendReasoningChunk: (chunk: ReasoningChunk) => void;
  /** Set the reasoning display mode */
  setReasoningMode: (mode: "compact" | "expanded") => void;
  /** Toggle reasoning panel visibility */
  setReasoningVisible: (visible: boolean) => void;
  /** Update timing for a reasoning phase */
  updatePhaseTiming: (phase: string, elapsedMs: number) => void;
}

export const useBackgroundAgentStore = create<BackgroundAgentState>((set, get) => ({
  session: null,
  isRunning: false,
  isPaused: false,
  showPanel: false,
  pendingCommandApproval: null,

  // ─── Task Planner Initial State ────────────────────────────────────────────
  phases: [],
  currentPhase: null,
  reasoningStream: "",
  subtaskDetails: new Map<string, SubtaskDetail>(),
  plannerSubtasks: [],

  // ─── Reasoning Display Initial State ───────────────────────────────────────
  reasoningChunks: [],
  reasoningMode: "compact",
  reasoningVisible: true,
  phaseTimings: new Map(),

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
      session: { ...session, step, logs: appendLog(session.logs, log) },
    });
  },

  addLog: (step, message) => {
    const { session } = get();
    if (!session) return;
    const log: BackgroundAgentLog = { timestamp: Date.now(), step, message };
    set({ session: { ...session, logs: appendLog(session.logs, log) } });
  },

  addFileChange: (change) => {
    const { session } = get();
    if (!session) return;
    set({
      session: {
        ...session,
        fileChanges: [...session.fileChanges, change].slice(-MAX_BACKGROUND_FILE_CHANGES),
      },
    });
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
    const combined = session.terminalOutput + output;
    set({
      session: {
        ...session,
        terminalOutput: combined.slice(-MAX_BACKGROUND_TERMINAL_CHARS),
      },
    });
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
          logs: appendLog(session.logs, {
            timestamp: Date.now(),
            step: "planning",
            message: `Subtask ${next + 1}/${session.subtasks.length}: ${session.subtasks[next]}`,
          }),
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
        logs: appendLog(session.logs, { timestamp: Date.now(), step: "paused", message: "Paused by user" }),
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
        logs: appendLog(session.logs, { timestamp: Date.now(), step: previousStep as BackgroundAgentStep, message: "Resumed" }),
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
        logs: appendLog(session.logs, { timestamp: Date.now(), step: "cancelled", message: "Cancelled by user" }),
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
        logs: appendLog(session.logs, { timestamp: Date.now(), step: "completed", message: "All tasks completed" }),
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
        logs: appendLog(session.logs, { timestamp: Date.now(), step: "failed", message: error }),
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
        logs: appendLog(session.logs, { timestamp: Date.now(), step: "verifying", message: "Changes approved by user" }),
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
        logs: appendLog(session.logs, { timestamp: Date.now(), step: "analyzing_output", message: "Changes rejected by user — will retry with different approach" }),
      },
    });
  },

  togglePanel: () => set((s) => ({ showPanel: !s.showPanel })),

  requestCommandApproval: (request) => {
    const { session } = get();
    if (!session) return;
    set({
      pendingCommandApproval: request,
      showPanel: true, // Auto-show panel when approval is needed
      session: {
        ...session,
        step: "awaiting_approval",
        logs: appendLog(session.logs, {
          timestamp: Date.now(),
          step: "awaiting_approval",
          message: `Awaiting approval: ${request.sanitizedCommand.slice(0, 60)}`,
        }),
      },
    });
  },

  resolveCommandApproval: (approved) => {
    const { session } = get();
    if (!session) return;
    set({
      pendingCommandApproval: null,
      session: {
        ...session,
        step: approved ? "running_command" : "analyzing_output",
        logs: appendLog(session.logs, {
          timestamp: Date.now(),
          step: approved ? "running_command" : "analyzing_output",
          message: approved ? "Command approved by user" : "Command denied by user",
        }),
      },
    });
  },

  // ─── Task Planner Actions ──────────────────────────────────────────────────

  setPhases: (phases) => {
    set({ phases, currentPhase: phases.length > 0 ? phases[0].name : null });
  },

  advancePhase: (phase) => {
    const { phases } = get();
    const now = Date.now();
    const updatedPhases = phases.map((p) => {
      if (p.name === phase) {
        return { ...p, status: "in_progress" as const, startedAt: now };
      }
      // Mark all phases before the target as completed (if they were in_progress)
      if (p.status === "in_progress" && p.name !== phase) {
        return { ...p, status: "completed" as const, completedAt: now };
      }
      return p;
    });
    set({ phases: updatedPhases, currentPhase: phase });
  },

  appendReasoningStream: (chunk) => {
    set((state) => ({ reasoningStream: state.reasoningStream + chunk }));
  },

  clearReasoningStream: () => {
    set({ reasoningStream: "" });
  },

  setPlannerSubtasks: (subtasks) => {
    // Build subtaskDetails map from the subtask data
    const details = new Map<string, SubtaskDetail>();
    for (const st of subtasks) {
      details.set(st.id, {
        affectedFiles: st.affectedFiles,
        dependsOn: st.dependsOn,
        dependedBy: st.dependedBy,
      });
    }
    set({ plannerSubtasks: subtasks, subtaskDetails: details });
  },

  cancelSubtask: (subtaskId) => {
    const { plannerSubtasks } = get();

    // 1. Mark the target subtask as "skipped" (cancelled)
    let updatedSubtasks = plannerSubtasks.map((st) =>
      st.id === subtaskId ? { ...st, status: "skipped" as PlannerSubtaskStatus } : st
    );

    // 2. BFS to find all subtasks that transitively depend on the cancelled one
    const dependentsToSkip = new Set<string>();
    const queue: string[] = [subtaskId];

    while (queue.length > 0) {
      const current = queue.shift()!;
      const currentSubtask = updatedSubtasks.find((st) => st.id === current);
      if (!currentSubtask) continue;

      // Find all subtasks that depend on `current` (via dependedBy links)
      for (const dependentId of currentSubtask.dependedBy) {
        if (!dependentsToSkip.has(dependentId) && dependentId !== subtaskId) {
          dependentsToSkip.add(dependentId);
          queue.push(dependentId);
        }
      }
    }

    // 3. Mark all transitive dependents as "skipped"
    updatedSubtasks = updatedSubtasks.map((st) =>
      dependentsToSkip.has(st.id) ? { ...st, status: "skipped" as PlannerSubtaskStatus } : st
    );

    // 4. Update subtaskDetails map
    const details = new Map<string, SubtaskDetail>();
    for (const st of updatedSubtasks) {
      details.set(st.id, {
        affectedFiles: st.affectedFiles,
        dependsOn: st.dependsOn,
        dependedBy: st.dependedBy,
      });
    }

    set({ plannerSubtasks: updatedSubtasks, subtaskDetails: details });
  },

  skipDependentSubtasks: (cancelledId) => {
    // Traverse dependency graph and mark all subtasks that are unreachable
    // (i.e., transitively depend on the cancelled subtask) as "skipped"
    const { plannerSubtasks } = get();

    const dependentsToSkip = new Set<string>();
    const queue: string[] = [cancelledId];

    while (queue.length > 0) {
      const current = queue.shift()!;
      const currentSubtask = plannerSubtasks.find((st) => st.id === current);
      if (!currentSubtask) continue;

      for (const dependentId of currentSubtask.dependedBy) {
        if (!dependentsToSkip.has(dependentId)) {
          dependentsToSkip.add(dependentId);
          queue.push(dependentId);
        }
      }
    }

    const updatedSubtasks = plannerSubtasks.map((st) =>
      dependentsToSkip.has(st.id) ? { ...st, status: "skipped" as PlannerSubtaskStatus } : st
    );

    const details = new Map<string, SubtaskDetail>();
    for (const st of updatedSubtasks) {
      details.set(st.id, {
        affectedFiles: st.affectedFiles,
        dependsOn: st.dependsOn,
        dependedBy: st.dependedBy,
      });
    }

    set({ plannerSubtasks: updatedSubtasks, subtaskDetails: details });
  },

  clearSession: () => set({ session: null, isRunning: false, isPaused: false }),

  // ─── Reasoning Display Actions ─────────────────────────────────────────────

  appendReasoningChunk: (chunk) => {
    const { reasoningChunks } = get();
    // Eviction: when exceeds 1000 chunks, keep last 500
    const newChunks = reasoningChunks.length >= 1000
      ? [...reasoningChunks.slice(-499), chunk]
      : [...reasoningChunks, chunk];
    set({ reasoningChunks: newChunks });
  },

  setReasoningMode: (mode) => set({ reasoningMode: mode }),

  setReasoningVisible: (visible) => set({ reasoningVisible: visible }),

  updatePhaseTiming: (phase, elapsedMs) => {
    const { phaseTimings } = get();
    const newTimings = new Map(phaseTimings);
    const existing = newTimings.get(phase);
    if (existing) {
      newTimings.set(phase, { ...existing, elapsedMs });
    } else {
      newTimings.set(phase, { startedAt: Date.now(), elapsedMs });
    }
    set({ phaseTimings: newTimings });
  },
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
