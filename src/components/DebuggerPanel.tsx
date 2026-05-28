import { useState, useRef, useEffect } from "react";
import { Play, Pause, StepForward, StepBack, StopCircle, Variable, List, Code, ArrowDownToLine, ArrowUpFromLine } from "lucide-react";
import DebugConfigPicker from "./DebugConfigPicker";
import AiDebugAssistant from "./AiDebugAssistant";
import type { DebugLaunchConfig } from "../utils/debugConfig";
import type { AIProviderConfig } from "../utils/providers";
import type { ReviewFileChange } from "./AiDiffPreview";

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
  // AI Debug Assistant (Phase 5B)
  currentSourceCode?: string;
  fullFileContent?: string;
  aiProvider: AIProviderConfig | null;
  aiModel: string;
  showToast: (message: string, type: "info" | "success" | "error" | "warning") => void;
  // Phase 5D: Smart guidance actions
  onToggleBreakpoint?: (path: string, line: number) => void;
  onEvaluateExpression?: (expression: string) => void;
  // Phase 5C: Fix suggestions
  onProposeFix?: (changes: ReviewFileChange[]) => void;
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
  currentSource,
  currentSourceCode,
  fullFileContent,
  aiProvider,
  aiModel,
  showToast,
  onToggleBreakpoint,
  onEvaluateExpression,
  onProposeFix,
}: DebuggerPanelProps) {
  const [activeView, setActiveView] = useState<"stack" | "variables" | "console">("stack");
  const [evalInput, setEvalInput] = useState("");
  const consoleEndRef = useRef<HTMLDivElement>(null);

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
      </div>

      {/* AI Debug Assistant — Phase 5B + 5D + 5C */}
      <AiDebugAssistant
        isPaused={adapterStatus === "paused"}
        stackFrames={stackFrames}
        variables={variables}
        consoleOutput={consoleOutput}
        currentSourceCode={currentSourceCode}
        fullFileContent={fullFileContent}
        currentFilePath={currentSource?.path}
        currentLine={currentSource?.line}
        aiProvider={aiProvider}
        aiModel={aiModel}
        showToast={showToast}
        onSetBreakpoint={onToggleBreakpoint}
        onEvaluateExpression={(expression) => {
          if (sessionId) {
            onSendRequest("evaluate", { expression, context: "repl" });
          }
        }}
        onJumpToSource={onJumpToSource}
        onProposeFix={onProposeFix}
      />
    </div>
  );
}
