/**
 * BackgroundAgentPanel — Shows detailed progress of the background agent task.
 * Opens when user clicks the status bar indicator.
 */

import { useState } from "react";
import { X, Play, Pause, Square, Check, AlertCircle, FileCode, Terminal, Clock, ShieldAlert, ShieldCheck, ListChecks } from "lucide-react";
import { useBackgroundAgentStore } from "../store/backgroundAgentStore";
import type { BackgroundAgentLog } from "../store/backgroundAgentStore";
import { runTerminalCommand } from "../utils/tauri";
import { showToast } from "../utils/toast";
import TaskPlannerPanel from "./TaskPlannerPanel";

function quotePathForStart(path: string): string {
  return /\s/.test(path) ? `"${path.replace(/"/g, '""')}"` : path;
}

export default function BackgroundAgentPanel() {
  const { session, isRunning, isPaused, showPanel, togglePanel, pause, resume, cancel, clearSession, pendingCommandApproval, resolveCommandApproval } = useBackgroundAgentStore();
  const [activeTab, setActiveTab] = useState<"activity" | "files" | "plan">("activity");

  if (!showPanel || !session) return null;

  const elapsed = session.completedAt
    ? session.completedAt - session.startedAt
    : Date.now() - session.startedAt;

  const formatDuration = (ms: number) => {
    if (ms < 60000) return `${Math.round(ms / 1000)}s`;
    const mins = Math.floor(ms / 60000);
    const secs = Math.round((ms % 60000) / 1000);
    return `${mins}m ${secs}s`;
  };

  const getStepIcon = (log: BackgroundAgentLog) => {
    switch (log.step) {
      case "completed": return <Check size={12} className="log-icon completed" />;
      case "failed": return <AlertCircle size={12} className="log-icon failed" />;
      case "paused": return <Pause size={12} className="log-icon paused" />;
      case "cancelled": return <Square size={12} className="log-icon cancelled" />;
      case "running_command": return <Terminal size={12} className="log-icon running" />;
      default: return <div className="log-icon-dot" />;
    }
  };

  const openGeneratedFile = async (path: string) => {
    try {
      await runTerminalCommand(`start ${quotePathForStart(path)}`, session.projectPath);
      showToast(`Opened ${path}`, "success");
    } catch (err) {
      showToast(`Failed to open ${path}: ${err}`, "error");
    }
  };

  return (
    <div className="bg-agent-panel">
      <div className="bg-agent-panel-header">
        <div className="bg-agent-panel-title">
          <span className="bg-agent-panel-icon">
            {isRunning && !isPaused && <div className="bg-pulse" />}
            {isPaused && <Pause size={14} />}
            {session.step === "completed" && <Check size={14} />}
            {session.step === "failed" && <AlertCircle size={14} />}
          </span>
          <div>
            <strong>Background Agent</strong>
            <span className="bg-agent-panel-task">{session.task.slice(0, 60)}{session.task.length > 60 ? "..." : ""}</span>
          </div>
        </div>
        <div className="bg-agent-panel-actions">
          {isRunning && !isPaused && (
            <button className="bg-agent-btn" onClick={pause} title="Pause">
              <Pause size={14} />
            </button>
          )}
          {isPaused && (
            <button className="bg-agent-btn" onClick={resume} title="Resume">
              <Play size={14} />
            </button>
          )}
          {isRunning && (
            <button className="bg-agent-btn cancel" onClick={cancel} title="Cancel">
              <Square size={14} />
            </button>
          )}
          {!isRunning && (
            <button className="bg-agent-btn" onClick={clearSession} title="Dismiss">
              <X size={14} />
            </button>
          )}
          <button className="bg-agent-btn" onClick={togglePanel} title="Close panel">
            <X size={14} />
          </button>
        </div>
      </div>

      {/* Progress info */}
      <div className="bg-agent-panel-info">
        <span className="bg-agent-info-item">
          <Clock size={11} />
          {formatDuration(elapsed)}
        </span>
        {session.subtasks.length > 1 && (
          <span className="bg-agent-info-item">
            Subtask {session.currentSubtask + 1}/{session.subtasks.length}
          </span>
        )}
        {session.fileChanges.length > 0 && (
          <span className="bg-agent-info-item">
            <FileCode size={11} />
            {session.fileChanges.filter((f) => f.applied).length}/{session.fileChanges.length} files applied
          </span>
        )}
      </div>

      {/* Tab bar */}
      <div className="bg-agent-panel-tabs">
        <button
          className={`bg-agent-tab ${activeTab === "activity" ? "active" : ""}`}
          onClick={() => setActiveTab("activity")}
        >
          <Terminal size={12} />
          Activity
        </button>
        <button
          className={`bg-agent-tab ${activeTab === "files" ? "active" : ""}`}
          onClick={() => setActiveTab("files")}
        >
          <FileCode size={12} />
          Files
        </button>
        <button
          className={`bg-agent-tab ${activeTab === "plan" ? "active" : ""}`}
          onClick={() => setActiveTab("plan")}
        >
          <ListChecks size={12} />
          Plan
        </button>
      </div>

      {/* Tab content */}
      {activeTab === "plan" && (
        <div className="bg-agent-panel-plan">
          <TaskPlannerPanel />
        </div>
      )}

      {activeTab === "files" && session.fileChanges.length > 0 && (
        <div className="bg-agent-panel-section">
          <div className="bg-agent-section-title">File Changes</div>
          <div className="bg-agent-file-list">
            {session.fileChanges.map((fc, i) => (
              <div key={i} className={`bg-agent-file-item ${fc.conflicting ? "conflicting" : ""} ${fc.applied ? "applied" : ""}`}>
                <FileCode size={12} />
                <span className="bg-agent-file-path">{fc.path}</span>
                {fc.isNew && <span className="bg-agent-file-badge new">NEW</span>}
                {fc.conflicting && <span className="bg-agent-file-badge conflict">CONFLICT</span>}
                <button className="bg-agent-file-action" onClick={() => openGeneratedFile(fc.path)}>
                  Open
                </button>
                <details className="bg-agent-file-preview">
                  <summary>View code</summary>
                  <pre className="bg-agent-file-code"><code>{fc.content}</code></pre>
                </details>
                {fc.applied && <span className="bg-agent-file-badge applied">✓</span>}
              </div>
            ))}
          </div>
        </div>
      )}

      {activeTab === "files" && session.fileChanges.length === 0 && (
        <div className="bg-agent-panel-section">
          <div className="bg-agent-section-empty">No file changes yet</div>
        </div>
      )}

      {/* Command Approval Card (non-blocking — replaces window.confirm) */}
      {activeTab === "activity" && pendingCommandApproval && (
        <div className="bg-agent-panel-section bg-agent-approval-card">
          <div className="bg-agent-approval-header">
            <ShieldAlert size={14} className={`approval-icon risk-${pendingCommandApproval.riskLevel}`} />
            <span className="bg-agent-approval-title">Command Approval Required</span>
            <span className={`bg-agent-risk-badge ${pendingCommandApproval.riskLevel}`}>
              {pendingCommandApproval.riskLevel.toUpperCase()}
            </span>
          </div>
          <div className="bg-agent-approval-command">
            <code>{pendingCommandApproval.sanitizedCommand}</code>
          </div>
          <div className="bg-agent-approval-message">
            {pendingCommandApproval.feedbackMessage}
          </div>
          <div className="bg-agent-approval-actions">
            <button
              className="bg-agent-approval-btn approve"
              onClick={() => resolveCommandApproval(true)}
            >
              <ShieldCheck size={13} />
              Approve
            </button>
            <button
              className="bg-agent-approval-btn deny"
              onClick={() => resolveCommandApproval(false)}
            >
              <X size={13} />
              Deny
            </button>
          </div>
        </div>
      )}

      {/* Activity log */}
      {activeTab === "activity" && (
        <div className="bg-agent-panel-section">
          <div className="bg-agent-section-title">Activity</div>
          <div className="bg-agent-log-list">
            {session.logs.slice(-20).map((log, i) => (
              <div key={i} className="bg-agent-log-item">
                {getStepIcon(log)}
                <span className="bg-agent-log-msg">{log.message}</span>
                <span className="bg-agent-log-time">
                  {new Date(log.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Error display */}
      {session.error && (
        <div className="bg-agent-panel-error">
          <AlertCircle size={12} />
          <span>{session.error}</span>
        </div>
      )}
    </div>
  );
}
