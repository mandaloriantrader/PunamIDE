// src/components/chat/AgentTraceCard.tsx
//
// Agent trace visualization card — shows the internal tool loop status.

import { Loader2, Check, Route, ListChecks, AlertCircle } from "lucide-react";
import { MarkdownMessage } from "./ChatComponents";
import type { AgentTrace } from "./types";

interface AgentTraceCardProps {
  trace: AgentTrace;
  isStreaming?: boolean;
  showFinal?: boolean;
}

export function AgentTraceCard({ trace, isStreaming, showFinal }: AgentTraceCardProps) {
  const status = trace.status.toLowerCase();
  const isComplete = status.includes("completed");
  const isStopped = status.includes("stopped");
  const isWaiting = status.includes("needs") || status.includes("waiting");
  const isError = status.includes("error") || status.includes("unavailable");

  return (
    <div className={`agent-trace-card ${isComplete ? "complete" : ""} ${isError ? "error" : ""} ${isStopped ? "stopped" : ""}`}>
      <div className="agent-trace-header">
        <div className="agent-trace-title">
          <Route size={14} />
          <span>Agent route</span>
        </div>
        <span className={`agent-trace-status ${isComplete ? "complete" : isError ? "error" : isStopped ? "stopped" : isWaiting ? "waiting" : "running"}`}>
          {isStreaming && !isComplete && !isStopped && !isError ? <Loader2 size={11} className="spin-inline" /> : null}
          {trace.status.replace(/\.$/, "")}
        </span>
      </div>
      <div className="agent-trace-grid">
        <div className="agent-trace-row">
          <span className="agent-trace-label">Type</span>
          <span className="agent-trace-value">{trace.routeType}</span>
        </div>
        <div className="agent-trace-row">
          <span className="agent-trace-label">Reason</span>
          <span className="agent-trace-value">{trace.reason}</span>
        </div>
      </div>
      <details className="agent-trace-tools" open={trace.tools.length > 0 && !isComplete}>
        <summary>
          <ListChecks size={13} />
          <span>Tools used</span>
          <span className="agent-trace-count">{trace.tools.length}</span>
        </summary>
        <div className="agent-trace-tool-list">
          {trace.tools.length > 0 ? trace.tools.map((tool, index) => (
            <div className="agent-trace-tool" key={`${tool}-${index}`}>
              <Check size={11} />
              <span>{tool}</span>
            </div>
          )) : (
            <div className="agent-trace-tool muted">
              <AlertCircle size={11} />
              <span>Waiting for first tool...</span>
            </div>
          )}
        </div>
      </details>
      {showFinal && trace.finalText && (
        <div className="agent-trace-final">
          <MarkdownMessage text={trace.finalText} />
        </div>
      )}
    </div>
  );
}
