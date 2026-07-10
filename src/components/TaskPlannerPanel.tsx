/**
 * TaskPlannerPanel — Visualizes the agent's multi-step task decomposition,
 * reasoning phases, subtask progress, and streaming chain-of-thought.
 *
 * Requirements: 6.1, 6.2, 6.3, 6.4, 6.5, 6.7
 */

import { useEffect, useRef, useState, useCallback } from "react";
import {
  CheckCircle2,
  Circle,
  Loader2,
  XCircle,
  SkipForward,
  ChevronDown,
  ChevronRight,
  FileCode,
  GitBranch,
  X,
} from "lucide-react";
import { useBackgroundAgentStore } from "../store/backgroundAgentStore";
import type { TaskPhase, PlannerSubtask, PlannerSubtaskStatus } from "../store/backgroundAgentStore";

// ─── Phase Configuration ────────────────────────────────────────────────────────

const PHASE_CONFIG: Array<{ name: TaskPhase["name"]; icon: string; label: string }> = [
  { name: "decompose", icon: "📋", label: "Decompose" },
  { name: "gather_context", icon: "🔍", label: "Gather Context" },
  { name: "reason", icon: "🧠", label: "Reason" },
  { name: "generate", icon: "⚡", label: "Generate" },
  { name: "verify", icon: "✅", label: "Verify" },
];

// ─── Helpers ────────────────────────────────────────────────────────────────────

function formatElapsed(startedAt?: number, completedAt?: number): string {
  if (!startedAt) return "";
  const end = completedAt || Date.now();
  const ms = end - startedAt;
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  const mins = Math.floor(ms / 60000);
  const secs = Math.round((ms % 60000) / 1000);
  return `${mins}m ${secs}s`;
}

function getStatusIcon(status: PlannerSubtaskStatus) {
  switch (status) {
    case "completed":
      return <CheckCircle2 size={14} className="text-green-400" />;
    case "in_progress":
      return <Loader2 size={14} className="text-blue-400 animate-spin" />;
    case "failed":
      return <XCircle size={14} className="text-red-400" />;
    case "skipped":
      return <SkipForward size={14} className="text-gray-500" />;
    case "pending":
    default:
      return <Circle size={14} className="text-gray-500" />;
  }
}

function getStatusBadgeClass(status: PlannerSubtaskStatus): string {
  switch (status) {
    case "completed":
      return "bg-green-900/30 text-green-400 border-green-700/50";
    case "in_progress":
      return "bg-blue-900/30 text-blue-400 border-blue-700/50";
    case "failed":
      return "bg-red-900/30 text-red-400 border-red-700/50";
    case "skipped":
      return "bg-gray-800/30 text-gray-500 border-gray-700/50";
    case "pending":
    default:
      return "bg-gray-800/30 text-gray-400 border-gray-700/50";
  }
}

// ─── Phase Progress Indicator ───────────────────────────────────────────────────

function PhaseProgressIndicator() {
  const phases = useBackgroundAgentStore((s) => s.phases);
  const currentPhase = useBackgroundAgentStore((s) => s.currentPhase);

  const phaseMap = new Map(phases.map((p) => [p.name, p]));

  return (
    <div className="flex items-center gap-1 px-3 py-2 overflow-x-auto border-b border-gray-700/50">
      {PHASE_CONFIG.map((cfg, idx) => {
        const phase = phaseMap.get(cfg.name);
        const isActive = currentPhase === cfg.name;
        const isCompleted = phase?.status === "completed";
        const elapsed = phase ? formatElapsed(phase.startedAt, phase.completedAt) : "";

        return (
          <div key={cfg.name} className="flex items-center">
            <div
              className={`flex flex-col items-center px-2 py-1 rounded transition-all duration-150 ${
                isActive
                  ? "bg-blue-900/30 border border-blue-600/50"
                  : isCompleted
                  ? "opacity-80"
                  : "opacity-50"
              }`}
            >
              <div className="flex items-center gap-1">
                <span className="text-xs">{cfg.icon}</span>
                <span
                  className={`text-[10px] font-medium whitespace-nowrap ${
                    isActive ? "text-blue-300" : isCompleted ? "text-green-400" : "text-gray-400"
                  }`}
                >
                  {cfg.label}
                </span>
                {isActive && <Loader2 size={10} className="text-blue-400 animate-spin" />}
                {isCompleted && <CheckCircle2 size={10} className="text-green-400" />}
              </div>
              {elapsed && (
                <span className="text-[9px] text-gray-500 mt-0.5">{elapsed}</span>
              )}
            </div>
            {idx < PHASE_CONFIG.length - 1 && (
              <span className="text-gray-600 text-xs mx-0.5">→</span>
            )}
          </div>
        );
      })}
    </div>
  );
}

// ─── Subtask Item ───────────────────────────────────────────────────────────────

interface SubtaskItemProps {
  subtask: PlannerSubtask;
  onCancel: (id: string) => void;
}

function SubtaskItem({ subtask, onCancel }: SubtaskItemProps) {
  const [expanded, setExpanded] = useState(false);

  const canCancel = subtask.status === "pending" || subtask.status === "in_progress";

  return (
    <div
      className={`border rounded px-2 py-1.5 transition-colors ${
        subtask.status === "in_progress"
          ? "border-blue-700/50 bg-blue-900/10"
          : "border-gray-700/40 bg-transparent"
      }`}
    >
      {/* Main row */}
      <div className="flex items-center gap-2">
        <button
          className="p-0.5 rounded hover:bg-gray-700/50 transition-colors"
          onClick={() => setExpanded(!expanded)}
          aria-label={expanded ? "Collapse subtask details" : "Expand subtask details"}
        >
          {expanded ? (
            <ChevronDown size={12} className="text-gray-400" />
          ) : (
            <ChevronRight size={12} className="text-gray-400" />
          )}
        </button>

        {getStatusIcon(subtask.status)}

        <span className="text-[11px] text-gray-500 font-mono w-5 shrink-0">
          {subtask.index + 1}.
        </span>

        <span className="text-xs text-gray-200 flex-1 truncate">{subtask.title}</span>

        <span
          className={`text-[9px] px-1.5 py-0.5 rounded border font-medium ${getStatusBadgeClass(
            subtask.status
          )}`}
        >
          {subtask.status}
        </span>

        {canCancel && (
          <button
            className="p-0.5 rounded hover:bg-red-900/30 text-gray-500 hover:text-red-400 transition-colors"
            onClick={() => onCancel(subtask.id)}
            title="Cancel subtask"
            aria-label={`Cancel subtask: ${subtask.title}`}
          >
            <X size={12} />
          </button>
        )}
      </div>

      {/* Expanded details */}
      {expanded && (
        <div className="mt-2 ml-7 space-y-2 text-[11px]">
          {/* Affected files */}
          {subtask.affectedFiles.length > 0 && (
            <div>
              <div className="flex items-center gap-1 text-gray-400 mb-1">
                <FileCode size={11} />
                <span>Affected files ({Math.min(subtask.affectedFiles.length, 20)})</span>
              </div>
              <div className="space-y-0.5 max-h-32 overflow-y-auto">
                {subtask.affectedFiles.slice(0, 20).map((file) => (
                  <div
                    key={file}
                    className="text-gray-300 font-mono text-[10px] px-1.5 py-0.5 bg-gray-800/50 rounded truncate"
                    title={file}
                  >
                    {file}
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Dependencies */}
          {(subtask.dependsOn.length > 0 || subtask.dependedBy.length > 0) && (
            <div>
              <div className="flex items-center gap-1 text-gray-400 mb-1">
                <GitBranch size={11} />
                <span>Dependencies</span>
              </div>
              <div className="space-y-0.5">
                {subtask.dependsOn.length > 0 && (
                  <div className="text-gray-400">
                    <span className="text-gray-500">Depends on:</span>{" "}
                    {subtask.dependsOn.join(", ")}
                  </div>
                )}
                {subtask.dependedBy.length > 0 && (
                  <div className="text-gray-400">
                    <span className="text-gray-500">Depended by:</span>{" "}
                    {subtask.dependedBy.join(", ")}
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Reasoning Stream ───────────────────────────────────────────────────────────

function ReasoningStream() {
  const reasoningStream = useBackgroundAgentStore((s) => s.reasoningStream);
  const scrollRef = useRef<HTMLDivElement>(null);
  const endRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to bottom on new content
  useEffect(() => {
    if (endRef.current) {
      endRef.current.scrollIntoView({ behavior: "smooth" });
    }
  }, [reasoningStream]);

  if (!reasoningStream) return null;

  return (
    <div className="border-t border-gray-700/50">
      <div className="px-3 py-1.5 text-[10px] text-gray-400 font-medium uppercase tracking-wider">
        Chain of Thought
      </div>
      <div
        ref={scrollRef}
        className="max-h-48 overflow-y-auto px-3 pb-2"
      >
        <pre className="text-[11px] text-gray-300 font-mono whitespace-pre-wrap break-words leading-relaxed">
          {reasoningStream}
        </pre>
        <div ref={endRef} />
      </div>
    </div>
  );
}

// ─── Main Panel ─────────────────────────────────────────────────────────────────

export default function TaskPlannerPanel() {
  const phases = useBackgroundAgentStore((s) => s.phases);
  const plannerSubtasks = useBackgroundAgentStore((s) => s.plannerSubtasks);
  const cancelSubtask = useBackgroundAgentStore((s) => s.cancelSubtask);

  const handleCancel = useCallback(
    (subtaskId: string) => {
      cancelSubtask(subtaskId);
    },
    [cancelSubtask]
  );

  // Don't render if there's nothing to show
  if (phases.length === 0 && plannerSubtasks.length === 0) {
    return (
      <div className="flex items-center justify-center h-full text-gray-500 text-xs">
        No active task plan
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full bg-[#1e1e2e] text-gray-200 overflow-hidden">
      {/* Phase Progress Indicator */}
      {phases.length > 0 && <PhaseProgressIndicator />}

      {/* Subtask List */}
      {plannerSubtasks.length > 0 && (
        <div className="flex-1 overflow-y-auto px-2 py-2 space-y-1">
          {plannerSubtasks.map((subtask) => (
            <SubtaskItem
              key={subtask.id}
              subtask={subtask}
              onCancel={handleCancel}
            />
          ))}
        </div>
      )}

      {/* Reasoning Stream */}
      <ReasoningStream />
    </div>
  );
}
