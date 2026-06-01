/**
 * TerminalPanel — Wrapper with mode toggle between Command and Shell (PTY).
 * Option B: Sub-tabs inside the terminal panel.
 */

import { useState, lazy, Suspense } from "react";
import { Zap, Monitor } from "lucide-react";
import Terminal from "./Terminal";
import type { RunObservation } from "../services/run/verifiedRun";
import type { AIProviderConfig } from "../utils/providers";

const ShellTerminal = lazy(() => import("./ShellTerminal"));

export type TerminalMode = "command" | "shell";

interface Props {
  cwd: string;
  onOutputChange?: (output: string) => void;
  commandToRun?: string | null;
  onCommandStarted?: () => void;
  onCommandFailed?: (command: string, output: string) => void;
  onRunObservation?: (observation: RunObservation) => void;
  onOpenUrl?: (url: string) => void;
  aiProviders?: AIProviderConfig[];
  onFixWithAi?: (errorContext: string) => void;
}

export default function TerminalPanel(props: Props) {
  const [mode, setMode] = useState<TerminalMode>("command");
  const workspaceName = props.cwd?.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || "";
  const hasWorkspace = Boolean(props.cwd && props.cwd.trim());

  return (
    <div className="terminal-panel-wrapper">
      {/* Mode toggle bar */}
      <div className="terminal-mode-bar">
        <button
          className={`terminal-mode-btn ${mode === "command" ? "active" : ""}`}
          onClick={() => setMode("command")}
          title="Command Mode - Run one-shot PowerShell commands with AI-friendly output"
        >
          <Zap size={12} />
          <span>Command</span>
        </button>
        <button
          className={`terminal-mode-btn ${mode === "shell" ? "active" : ""}`}
          onClick={() => setMode("shell")}
          title="Shell Mode - Full interactive PTY terminal"
        >
          <Monitor size={12} />
          <span>Shell</span>
        </button>
      </div>

      <div className={`terminal-guidance ${hasWorkspace ? "" : "warning"}`} title={props.cwd || "No workspace selected"}>
        <span className="terminal-guidance-mode">{mode === "command" ? "Command" : "Shell"}</span>
        <span className="terminal-guidance-text">
          {mode === "command"
            ? hasWorkspace
              ? `One-shot PowerShell from ${workspaceName}. Directory changes do not persist between runs.`
              : "No workspace selected. Open a project folder before running project commands."
            : hasWorkspace
              ? `Interactive shell in ${workspaceName}. Session state persists while this tab stays open.`
              : "Interactive shell is available, but no project workspace is selected."}
        </span>
      </div>

      {/* Terminal content */}
      <div className="terminal-mode-content">
        {mode === "command" && (
          <Terminal
            cwd={props.cwd}
            embedded
            onOutputChange={props.onOutputChange}
            commandToRun={props.commandToRun}
            onCommandStarted={props.onCommandStarted}
            onCommandFailed={props.onCommandFailed}
            onRunObservation={props.onRunObservation}
            onOpenUrl={props.onOpenUrl}
            aiProviders={props.aiProviders}
            onFixWithAi={props.onFixWithAi}
          />
        )}
        {mode === "shell" && (
          <Suspense fallback={<div className="shell-loading">Loading shell...</div>}>
            <ShellTerminal cwd={props.cwd} onOpenUrl={props.onOpenUrl} />
          </Suspense>
        )}
      </div>
    </div>
  );
}
