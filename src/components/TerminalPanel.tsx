/**
 * TerminalPanel — Wrapper with Command/Shell mode toggle rendered
 * inline inside the terminal tab bar (zero extra chrome rows).
 */

import { useState, lazy, Suspense, useMemo } from "react";
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

  // Mode toggle buttons rendered inline in the terminal tab bar
  const modePrefix = useMemo(() => (
    <div className="terminal-mode-toggle">
      <button
        className={`terminal-mode-btn ${mode === "command" ? "active" : ""}`}
        onClick={() => setMode("command")}
        title="Command — One-shot PowerShell, directory changes do not persist"
      >
        <Zap size={11} />
        <span>Command</span>
      </button>
      <button
        className={`terminal-mode-btn ${mode === "shell" ? "active" : ""}`}
        onClick={() => setMode("shell")}
        title="Shell — Full interactive PTY terminal"
      >
        <Monitor size={11} />
        <span>Shell</span>
      </button>
    </div>
  ), [mode]);

  return (
    <div className="terminal-panel-wrapper">
      {mode === "command" && (
        <Terminal
          cwd={props.cwd}
          embedded
          tabBarPrefix={modePrefix}
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
        <div className="terminal shell-with-tabs">
          <div className="terminal-tabs">
            {modePrefix}
            <div className="terminal-tab active">
              <span className="terminal-tab-name">Shell</span>
            </div>
          </div>
          <div className="terminal-mode-content">
            <Suspense fallback={<div className="shell-loading">Loading shell...</div>}>
              <ShellTerminal cwd={props.cwd} onOpenUrl={props.onOpenUrl} />
            </Suspense>
          </div>
        </div>
      )}
    </div>
  );
}
