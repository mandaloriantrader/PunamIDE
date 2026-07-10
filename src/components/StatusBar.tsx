/**
 * StatusBar — VS Code–style bottom status strip.
 * Shows: git branch | problems | background agent | cursor position | language | encoding | spaces
 */

import { GitBranch, AlertCircle, AlertTriangle, CheckCircle2, Loader2, Pause, X, Check, ShieldAlert, ShieldCheck } from "lucide-react";
import { useBackgroundAgentStore } from "../store/backgroundAgentStore";
import { useAIStore } from "../store/aiStore";
import { cancelBackgroundExecution } from "../services/backgroundAgentExecutor";
import { getArchitectureHealth } from "../services/architecture/ArchitectureEngine";
import { useCallback, useEffect, useState } from "react";

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
  const pendingApprovalCount = useAIStore((state) => state.pendingApprovalCount);
  const tokenBudgetStatus = useAIStore((state) => state.tokenBudgetStatus);

  const [archHealth, setArchHealth] = useState<{
    score: "good" | "warning" | "critical";
    errorCount: number;
    loaded: boolean;
  }>({ score: "good", errorCount: 0, loaded: false });

  const refreshArchHealth = useCallback(async () => {
    try {
      const health = await getArchitectureHealth();
      setArchHealth({ score: health.score, errorCount: health.circularDeps + health.layerViolations, loaded: true });
    } catch {
      setArchHealth((prev) => ({ ...prev, loaded: true }));
    }
  }, []);

  useEffect(() => {
    refreshArchHealth();
    // Refresh every 60s
    const interval = setInterval(refreshArchHealth, 60_000);
    return () => clearInterval(interval);
  }, [refreshArchHealth]);

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

        {/* Pending Approvals Badge */}
        {pendingApprovalCount > 0 && (
          <span
            className="status-item status-pending-approvals"
            title={`${pendingApprovalCount} patch approval(s) waiting`}
          >
            <span>⏳ {pendingApprovalCount} pending</span>
          </span>
        )}

        {/* Architecture Health Indicator */}
        {archHealth.loaded && (
          <span
            className={`status-item status-arch ${
              archHealth.score === "critical" ? "status-error" :
              archHealth.score === "warning" ? "status-warn" :
              "status-ok"
            }`}
            title={
              archHealth.score === "critical"
                ? `Architecture: ${archHealth.errorCount} violations — manual review required`
                : archHealth.score === "warning"
                  ? `Architecture: ${archHealth.errorCount} violation(s) — review recommended`
                  : "Architecture rules passing"
            }
            onClick={refreshArchHealth}
            style={{ cursor: "pointer" }}
          >
            {archHealth.score === "critical" ? (
              <ShieldAlert size={12} />
            ) : archHealth.score === "warning" ? (
              <AlertTriangle size={12} />
            ) : (
              <ShieldCheck size={12} />
            )}
            <span>
              {archHealth.score === "critical"
                ? `Arch: ${archHealth.errorCount}`
                : archHealth.score === "warning"
                  ? `Arch: ${archHealth.errorCount}`
                  : "Arch: OK"}
            </span>
          </span>
        )}
      </div>

      {/* Right side */}
      <div className="status-bar-right">
        {tokenBudgetStatus && (
          <span
            className="status-item status-budget"
            title={`Context budget: ${tokenBudgetStatus.percentUsed}% used (${tokenBudgetStatus.used.codeContext} / ${tokenBudgetStatus.allocation.codeContext} tokens)`}
          >
            <span className="status-budget-label">{tokenBudgetStatus.percentUsed}% context</span>
            <span className="status-budget-bar-container">
              <span
                className={`status-budget-bar ${
                  tokenBudgetStatus.percentUsed > 90 ? "budget-red" :
                  tokenBudgetStatus.percentUsed > 70 ? "budget-yellow" : "budget-green"
                }`}
                style={{ width: `${Math.min(tokenBudgetStatus.percentUsed, 100)}%` }}
              />
            </span>
          </span>
        )}
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
