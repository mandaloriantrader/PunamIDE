/**
 * StatusBar — VS Code–style bottom status strip.
 * Shows: git branch | problems | background agent | cursor position | language | encoding | spaces
 */

import { GitBranch, AlertCircle, AlertTriangle, CheckCircle2, Loader2, Pause, X, Check } from "lucide-react";
import { useBackgroundAgentStore } from "../store/backgroundAgentStore";
import { cancelBackgroundExecution } from "../services/backgroundAgentExecutor";

interface Props {
  gitBranch?: string;
  errors: number;
  warnings: number;
  cursorLine: number;
  cursorCol: number;
  language: string;
  filePath?: string;
  isModified?: boolean;
}

export default function StatusBar({
  gitBranch,
  errors,
  warnings,
  cursorLine,
  cursorCol,
  language,
  filePath,
  isModified,
}: Props) {
  const { session, isRunning, isPaused, togglePanel, pause, resume, cancel } = useBackgroundAgentStore();

  const handleCancel = () => {
    cancelBackgroundExecution();
    cancel();
  };

  const langLabel = language
    ? language.charAt(0).toUpperCase() + language.slice(1)
    : "";

  const getElapsedTime = () => {
    if (!session) return "";
    const elapsed = Date.now() - session.startedAt;
    if (elapsed < 60000) return `${Math.round(elapsed / 1000)}s`;
    return `${Math.round(elapsed / 60000)}m`;
  };

  const getStepLabel = () => {
    if (!session) return "";
    if (isPaused) return "Paused";
    if (session.step === "completed") return "Done ✓";
    if (session.step === "failed") return "Failed";
    if (session.subtasks.length > 1) {
      return `${session.currentSubtask + 1}/${session.subtasks.length}: ${session.subtasks[session.currentSubtask]?.slice(0, 30) || "Working..."}`;
    }
    switch (session.step) {
      case "planning": return "Planning...";
      case "proposing_fix": return "Generating code...";
      case "running_command": return "Running command...";
      case "analyzing_output": return "Analyzing...";
      case "verifying": return "Verifying...";
      default: return "Working...";
    }
  };

  return (
    <div className="status-bar" role="status" aria-label="Status bar">
      {/* Left side */}
      <div className="status-bar-left">
        {gitBranch && (
          <span className="status-item status-git" title="Git branch">
            <GitBranch size={12} />
            <span>{gitBranch}</span>
          </span>
        )}
        <span
          className={`status-item ${errors > 0 ? "status-error" : "status-ok"}`}
          title={`${errors} error(s)`}
        >
          <AlertCircle size={12} />
          <span>{errors}</span>
        </span>
        <span
          className={`status-item ${warnings > 0 ? "status-warn" : "status-ok"}`}
          title={`${warnings} warning(s)`}
        >
          <AlertTriangle size={12} />
          <span>{warnings}</span>
        </span>
        {errors === 0 && warnings === 0 && (
          <span className="status-item status-ok" title="No problems">
            <CheckCircle2 size={12} />
          </span>
        )}

        {/* Background Agent Indicator */}
        {session && (isRunning || session.step === "completed" || session.step === "failed") && (
          <span
            className={`status-item status-bg-agent ${isPaused ? "paused" : ""} ${session.step === "completed" ? "completed" : ""} ${session.step === "failed" ? "failed" : ""}`}
            title={`Background: ${session.task}\nElapsed: ${getElapsedTime()}`}
            onClick={togglePanel}
          >
            {isRunning && !isPaused && <Loader2 size={12} className="spin" />}
            {isPaused && <Pause size={12} />}
            {session.step === "completed" && <Check size={12} />}
            {session.step === "failed" && <AlertCircle size={12} />}
            <span className="status-bg-agent-label">{getStepLabel()}</span>
            {isRunning && (
              <span className="status-bg-agent-actions">
                {isPaused ? (
                  <button className="status-bg-btn" onClick={(e) => { e.stopPropagation(); resume(); }} title="Resume">▶</button>
                ) : (
                  <button className="status-bg-btn" onClick={(e) => { e.stopPropagation(); pause(); }} title="Pause">⏸</button>
                )}
                <button className="status-bg-btn cancel" onClick={(e) => { e.stopPropagation(); handleCancel(); }} title="Cancel">
                  <X size={10} />
                </button>
              </span>
            )}
          </span>
        )}
      </div>

      {/* Right side */}
      <div className="status-bar-right">
        {filePath && isModified && (
          <span className="status-item status-modified" title="Unsaved changes">
            ●
          </span>
        )}
        <span className="status-item" title="Cursor position">
          Ln {cursorLine}, Col {cursorCol}
        </span>
        <span className="status-item status-divider" />
        <span className="status-item" title="Spaces">
          Spaces: 2
        </span>
        <span className="status-item status-divider" />
        <span className="status-item" title="File encoding">
          UTF-8
        </span>
        {langLabel && (
          <>
            <span className="status-item status-divider" />
            <span className="status-item status-lang" title="Language mode">
              {langLabel}
            </span>
          </>
        )}
      </div>
    </div>
  );
}
