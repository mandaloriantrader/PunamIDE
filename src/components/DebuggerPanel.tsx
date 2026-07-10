import { useState, useRef, useEffect, useCallback } from "react";
import { Play, Pause, StepForward, StopCircle, Variable, List, Code, ArrowDownToLine, ArrowUpFromLine, BrainCircuit, Eye, RefreshCw, Check, X, AlertTriangle, Loader2 } from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import DebugConfigPicker from "./DebugConfigPicker";
import type { DebugLaunchConfig } from "../utils/debugConfig";
import { DapBridge, type DapBridgeState, type DapAnalysisResult } from "../services/debug/DapBridge";

interface DebuggerPanelProps {
  sessionId: string | null;
  adapterStatus: "stopped" | "running" | "paused";
  breakpoints: Record<string, number[]>;
  currentSource: { path: string; line: number } | null;
  stackFrames: any[];
  variables: any[];
  consoleOutput: string[];
  debugConfigs: DebugLaunchConfig[];
  selectedConfigId: string | null;
  onSelectConfig: (id: string) => void;
  onAddConfig: () => void;
  onEditConfigs: () => void;
  onSendRequest: (command: string, args: any) => Promise<void>;
  onContinue: () => void;
  onStepOver: () => void;
  onStepInto: () => void;
  onStepOut: () => void;
  onStop: () => void;
  onPause: () => void;
  onJumpToSource: (path: string, line: number) => void;
}

export default function DebuggerPanel({
  sessionId,
  adapterStatus,
  stackFrames,
  variables,
  consoleOutput,
  debugConfigs,
  selectedConfigId,
  onSelectConfig,
  onAddConfig,
  onEditConfigs,
  onSendRequest,
  onContinue,
  onStepOver,
  onStepInto,
  onStepOut,
  onStop,
  onPause,
  onJumpToSource,
}: DebuggerPanelProps) {
  const [activeView, setActiveView] = useState<"stack" | "variables" | "console" | "ai-analysis">("stack");
  const [evalInput, setEvalInput] = useState("");
  const consoleEndRef = useRef<HTMLDivElement>(null);
  const analysisEndRef = useRef<HTMLDivElement>(null);

  // DapBridge state for AI Analysis tab
  const [bridgeState, setBridgeState] = useState<DapBridgeState>(
    DapBridge.getInstance().getState()
  );

  // Subscribe to DapBridge state changes
  useEffect(() => {
    const unsubscribe = DapBridge.getInstance().subscribe(setBridgeState);
    return unsubscribe;
  }, []);

  // Auto-scroll analysis streaming text
  useEffect(() => {
    if (activeView === "ai-analysis" && analysisEndRef.current) {
      analysisEndRef.current.scrollIntoView({ behavior: "smooth" });
    }
  }, [bridgeState.streamingText, activeView]);

  // Auto-scroll console to bottom
  useEffect(() => {
    if (activeView === "console" && consoleEndRef.current) {
      consoleEndRef.current.scrollIntoView({ behavior: "smooth" });
    }
  }, [consoleOutput, activeView]);

  const handleEvaluate = async () => {
    if (!evalInput.trim() || !sessionId) return;
    try {
      await onSendRequest("evaluate", {
        expression: evalInput,
        context: "repl",
      });
      setEvalInput("");
    } catch (err) {
      console.error("Evaluate failed:", err);
    }
  };

  const handleRetryAnalysis = useCallback(() => {
    DapBridge.getInstance().retry();
  }, []);

  const handleAddWatch = useCallback((expression: string) => {
    if (!sessionId) return;
    onSendRequest("evaluate", { expression, context: "watch" }).catch((err) => {
      console.error("Failed to add watch expression:", err);
    });
  }, [sessionId, onSendRequest]);

  const handleAcceptFix = useCallback(async (fix: NonNullable<DapAnalysisResult["suggestedFix"]>) => {
    try {
      await invoke("write_file", { path: fix.filePath, content: fix.patch });
    } catch (err) {
      console.error("Failed to apply fix:", err);
    }
  }, []);

  const handleRejectFix = useCallback(() => {}, []);

  const getFileName = (path: string) => {
    const parts = path.replace(/\\/g, "/").split("/");
    return parts[parts.length - 1] || path;
  };

  return (
    <div className="debugger-panel">
      <div className="debugger-controls">
        <button
          className="icon-btn"
          onClick={onContinue}
          disabled={adapterStatus !== "paused" || !sessionId}
          title="Continue (F5)"
        >
          <Play size={15} />
        </button>
        <button
          className="icon-btn"
          onClick={onPause}
          disabled={adapterStatus !== "running" || !sessionId}
          title="Pause (F6)"
        >
          <Pause size={15} />
        </button>
        <button
          className="icon-btn"
          onClick={onStepOver}
          disabled={adapterStatus !== "paused" || !sessionId}
          title="Step Over (F10)"
        >
          <StepForward size={15} />
        </button>
        <button
          className="icon-btn"
          onClick={onStepInto}
          disabled={adapterStatus !== "paused" || !sessionId}
          title="Step Into (F11)"
        >
          <ArrowDownToLine size={15} />
        </button>
        <button
          className="icon-btn"
          onClick={onStepOut}
          disabled={adapterStatus !== "paused" || !sessionId}
          title="Step Out (Shift+F11)"
        >
          <ArrowUpFromLine size={15} />
        </button>
        <button
          className="icon-btn"
          onClick={onStop}
          disabled={adapterStatus === "stopped" || !sessionId}
          title="Stop (Shift+F5)"
        >
          <StopCircle size={15} />
        </button>
        <span style={{ marginLeft: 8, fontSize: 10, color: "var(--text-secondary)" }}>
          {adapterStatus === "stopped" ? "⏹ Stopped" : adapterStatus === "running" ? "▶ Running" : "⏸ Paused"}
        </span>
        <DebugConfigPicker
          configs={debugConfigs}
          selectedId={selectedConfigId}
          onSelect={onSelectConfig}
          onAddConfig={onAddConfig}
          onEditConfigs={onEditConfigs}
          disabled={adapterStatus !== "stopped"}
        />
      </div>

      <div className="debugger-tabs">
        <button
          className={`debugger-tab ${activeView === "stack" ? "active" : ""}`}
          onClick={() => setActiveView("stack")}
        >
          <List size={13} /> Call Stack
        </button>
        <button
          className={`debugger-tab ${activeView === "variables" ? "active" : ""}`}
          onClick={() => setActiveView("variables")}
        >
          <Variable size={13} /> Variables
        </button>
        <button
          className={`debugger-tab ${activeView === "console" ? "active" : ""}`}
          onClick={() => setActiveView("console")}
        >
          <Code size={13} /> Console
        </button>
        <button
          className={`debugger-tab ${activeView === "ai-analysis" ? "active" : ""}`}
          onClick={() => setActiveView("ai-analysis")}
        >
          <BrainCircuit size={13} /> AI Analysis
          {bridgeState.status === "streaming" && (
            <Loader2 size={11} className="ai-analysis-spinner" />
          )}
        </button>
      </div>

      <div className="debugger-content">
        {activeView === "stack" && (
          <div className="debug-section">
            {stackFrames.length === 0 ? (
              <p className="empty-message">
                {adapterStatus === "stopped"
                  ? "Start a debug session to see the call stack."
                  : adapterStatus === "running"
                  ? "Program is running. Pause or hit a breakpoint to inspect."
                  : "No stack frames available."}
              </p>
            ) : (
              <ul className="stack-frames-list">
                {stackFrames.map((frame, index) => (
                  <li
                    key={frame.id ?? index}
                    onClick={() => {
                      if (frame.source?.path) {
                        onJumpToSource(frame.source.path, frame.line);
                      }
                    }}
                  >
                    <span className="frame-name">{frame.name || "<anonymous>"}</span>
                    <span className="frame-location">
                      {frame.source?.name || getFileName(frame.source?.path || "")}:{frame.line}
                      {frame.column ? `:${frame.column}` : ""}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}

        {activeView === "variables" && (
          <div className="debug-section">
            {variables.length === 0 ? (
              <p className="empty-message">
                {adapterStatus === "paused"
                  ? "No variables in current scope."
                  : "Pause execution to inspect variables."}
              </p>
            ) : (
              <ul className="variables-list">
                {variables.map((v, index) => (
                  <li key={index}>
                    <span className="var-name">{v.name}</span>
                    <span className="var-value">{v.value}</span>
                    {v.type && <span className="var-type">{v.type}</span>}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}

        {activeView === "console" && (
          <div className="debug-section debug-console">
            {consoleOutput.length === 0 && (
              <p className="empty-message">Debug output will appear here.</p>
            )}
            {consoleOutput.map((line, index) => (
              <div key={index} className="debug-console-line">{line}</div>
            ))}
            <div ref={consoleEndRef} />
            <div className="debug-console-input">
              <span style={{ color: "var(--accent)" }}>&gt;</span>
              <input
                type="text"
                value={evalInput}
                onChange={(e) => setEvalInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") handleEvaluate();
                }}
                placeholder="Evaluate expression..."
                disabled={adapterStatus !== "paused" || !sessionId}
              />
            </div>
          </div>
        )}

        {activeView === "ai-analysis" && (
          <div className="debug-section ai-analysis-section">
            {bridgeState.status === "idle" && !bridgeState.result && (
              <p className="empty-message">
                {adapterStatus === "paused"
                  ? "AI analysis will appear when a breakpoint is hit."
                  : adapterStatus === "stopped"
                  ? "Start a debug session to get AI-assisted analysis."
                  : "Hit a breakpoint to trigger AI analysis."}
              </p>
            )}

            {bridgeState.status === "collecting" && (
              <div className="ai-analysis-loading">
                <Loader2 size={16} className="ai-analysis-spinner" />
                <span>Collecting debug context...</span>
              </div>
            )}

            {(bridgeState.status === "error" || bridgeState.status === "timeout") && (
              <div className="ai-analysis-error">
                <AlertTriangle size={16} />
                <span>{bridgeState.errorMessage || "AI analysis unavailable."}</span>
                {bridgeState.canRetry && (
                  <button className="ai-analysis-retry-btn" onClick={handleRetryAnalysis}>
                    <RefreshCw size={12} /> Retry
                  </button>
                )}
              </div>
            )}

            {(bridgeState.status === "streaming" || bridgeState.status === "complete") && (
              <>
                <div className="ai-analysis-text">
                  <pre className="ai-analysis-stream">
                    {bridgeState.result?.analysis || bridgeState.streamingText || ""}
                    {bridgeState.status === "streaming" && <span className="ai-analysis-cursor">▊</span>}
                  </pre>
                  <div ref={analysisEndRef} />
                </div>

                {bridgeState.result?.watchSuggestions && bridgeState.result.watchSuggestions.length > 0 && (
                  <div className="ai-analysis-watches">
                    <div className="ai-analysis-watches-header">
                      <Eye size={12} /><span>Suggested Watch Expressions</span>
                    </div>
                    <div className="ai-analysis-watch-chips">
                      {bridgeState.result.watchSuggestions.slice(0, 5).map((expr, i) => (
                        <button
                          key={i}
                          className="ai-analysis-watch-chip"
                          onClick={() => handleAddWatch(expr)}
                          title={`Add "${expr}" to watch panel`}
                        >
                          <Eye size={10} /><code>{expr}</code>
                        </button>
                      ))}
                    </div>
                  </div>
                )}

                {bridgeState.result?.suggestedFix && (
                  <div className="ai-analysis-fix-card">
                    <div className="ai-analysis-fix-header">
                      <span className="ai-analysis-fix-title">Suggested Fix</span>
                      <span className="ai-analysis-fix-file">
                        {getFileName(bridgeState.result.suggestedFix.filePath)}
                      </span>
                    </div>
                    <p className="ai-analysis-fix-explanation">
                      {bridgeState.result.suggestedFix.explanation}
                    </p>
                    <pre className="ai-analysis-fix-patch">
                      <code>{bridgeState.result.suggestedFix.patch}</code>
                    </pre>
                    <div className="ai-analysis-fix-actions">
                      <button
                        className="ai-analysis-fix-accept"
                        onClick={() => handleAcceptFix(bridgeState.result!.suggestedFix!)}
                        title="Accept and apply this fix"
                      >
                        <Check size={12} /> Accept
                      </button>
                      <button
                        className="ai-analysis-fix-reject"
                        onClick={handleRejectFix}
                        title="Reject this suggestion"
                      >
                        <X size={12} /> Reject
                      </button>
                    </div>
                  </div>
                )}
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
