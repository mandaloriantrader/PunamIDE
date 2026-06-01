/**
 * MultiAgentDashboard.tsx — Phase 5, Step 5.6
 *
 * Dashboard showing active agents, their tasks, progress, file locks,
 * and inter-agent communication log.
 */

import { useState, useEffect, useCallback } from "react";
import {
  Bot,
  Cpu,
  Shield,
  GitBranch,
  Wrench,
  Play,
  Square,
  Lock,
  MessageCircle,
  CheckCircle2,
  XCircle,
  Clock,
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  RefreshCw,
} from "lucide-react";
import { getAgentOrchestrator } from "../services/agent/AgentOrchestrator";
import type {
  AgentSession,
  AgentType,
  AgentStatus,
  AgentMessage,
  OrchestratorState,
} from "../services/agent/AgentOrchestrator";
import { getTaskScheduler } from "../services/agent/TaskScheduler";
import { getConflictResolver } from "../services/agent/ConflictResolver";
import { getAgentCoordinator } from "../services/agent/AgentCoordinator";

// ── Styles ────────────────────────────────────────────────────────────────────

const PANEL_STYLE: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  height: "100%",
  background: "var(--bg-primary, #1a1a2e)",
  color: "var(--text-primary, #e0e0e0)",
  fontFamily: "var(--font-mono, 'JetBrains Mono', monospace)",
  overflow: "auto",
};

const HEADER_STYLE: React.CSSProperties = {
  padding: "12px 16px",
  borderBottom: "1px solid var(--border-color, #2a2a4a)",
  display: "flex",
  alignItems: "center",
  gap: "8px",
  fontSize: "13px",
  fontWeight: 600,
  flexShrink: 0,
};

const AGENT_CARD_STYLE: React.CSSProperties = {
  margin: "8px 16px",
  padding: "12px",
  background: "var(--bg-card, #16162a)",
  border: "1px solid var(--border-color, #2a2a4a)",
  borderRadius: "8px",
};

const TYPE_COLORS: Record<AgentType, string> = {
  architecture: "#8b5cf6",
  implementation: "#3b82f6",
  test: "#10b981",
  security: "#ef4444",
  refactor: "#f59e0b",
};

const STATUS_COLORS: Record<AgentStatus, string> = {
  idle: "#6b7280",
  running: "#3b82f6",
  waiting: "#fbbf24",
  completed: "#34d399",
  blocked: "#ef4444",
  error: "#ef4444",
};

const TYPE_ICONS: Record<AgentType, React.FC<{ size?: number }>> = {
  architecture: (p) => <GitBranch size={p?.size ?? 14} color={TYPE_COLORS.architecture} />,
  implementation: (p) => <Bot size={p?.size ?? 14} color={TYPE_COLORS.implementation} />,
  test: (p) => <CheckCircle2 size={p?.size ?? 14} color={TYPE_COLORS.test} />,
  security: (p) => <Shield size={p?.size ?? 14} color={TYPE_COLORS.security} />,
  refactor: (p) => <Wrench size={p?.size ?? 14} color={TYPE_COLORS.refactor} />,
};

// ── Component ─────────────────────────────────────────────────────────────────

export default function MultiAgentDashboard() {
  const [orchestrator] = useState(() => getAgentOrchestrator());
  const [scheduler] = useState(() => getTaskScheduler());
  const [resolver] = useState(() => getConflictResolver());
  const [coordinator] = useState(() => getAgentCoordinator());

  const [agents, setAgents] = useState<AgentSession[]>([]);
  const [locks, setLocks] = useState<{ file: string; agentId: string }[]>([]);
  const [tick, setTick] = useState(0);
  const [expandedAgents, setExpandedAgents] = useState<Set<string>>(new Set());
  const [showMessages, setShowMessages] = useState(false);

  const refresh = useCallback(() => setTick((t) => t + 1), []);

  useEffect(() => {
    orchestrator.onStateChange(refresh);
    const interval = setInterval(refresh, 2000);
    return () => clearInterval(interval);
  }, [orchestrator, refresh]);

  useEffect(() => {
    setAgents(orchestrator.getAgentSessions());
    setLocks(resolver.getActiveLocks());
  }, [tick, orchestrator, resolver]);

  const toggleAgent = (id: string) => {
    const next = new Set(expandedAgents);
    if (next.has(id)) {
      next.delete(id);
    } else {
      next.add(id);
    }
    setExpandedAgents(next);
  };

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div style={PANEL_STYLE}>
      {/* Header */}
      <div style={HEADER_STYLE}>
        <Cpu size={16} />
        Multi-Agent Dashboard
        <span style={{ fontSize: "10px", color: "var(--text-secondary, #a0a0b0)", marginLeft: "auto" }}>
          Phase 5
        </span>
      </div>

      {/* Stats bar */}
      <div style={{
        padding: "8px 16px",
        display: "flex",
        gap: "12px",
        borderBottom: "1px solid var(--border-color, #2a2a4a)",
        flexShrink: 0,
        fontSize: "11px",
        color: "var(--text-secondary, #a0a0b0)",
      }}>
        <span>{agents.length} agents</span>
        <span>{agents.filter((a) => a.status === "running").length} active</span>
        <span style={{ display: "flex", alignItems: "center", gap: "4px" }}>
          <Lock size={10} />
          {locks.length} locks
        </span>
        <span>{orchestrator.getPendingTaskCount()} tasks pending</span>
      </div>

      {/* Agent cards */}
      {agents.length === 0 && (
        <div style={{ padding: "32px", textAlign: "center", color: "var(--text-secondary, #a0a0b0)", fontSize: "12px" }}>
          <Bot size={24} style={{ marginBottom: "8px", opacity: 0.5 }} />
          <div>No agents spawned</div>
          <div style={{ fontSize: "10px", marginTop: "4px", opacity: 0.7 }}>
            Use the AgentOrchestrator API to spawn agents
          </div>
        </div>
      )}

      {agents.map((agent) => {
        const isExpanded = expandedAgents.has(agent.config.id);
        const IconComp = TYPE_ICONS[agent.config.type];

        return (
          <div key={agent.config.id} style={AGENT_CARD_STYLE}>
            {/* Agent header */}
            <button
              onClick={() => toggleAgent(agent.config.id)}
              style={{
                display: "flex",
                alignItems: "center",
                gap: "8px",
                background: "none",
                border: "none",
                width: "100%",
                textAlign: "left",
                cursor: "pointer",
                fontFamily: "inherit",
                padding: 0,
                marginBottom: isExpanded ? "8px" : "0",
              }}
            >
              {isExpanded ? <ChevronDown size={12} color="var(--text-secondary, #a0a0b0)" /> : <ChevronRight size={12} color="var(--text-secondary, #a0a0b0)" />}
              <IconComp />
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: "12px", fontWeight: 600 }}>
                  {agent.config.id}
                </div>
                <div style={{ fontSize: "10px", color: "var(--text-secondary, #a0a0b0)" }}>
                  {agent.config.type} · {agent.config.model}
                </div>
              </div>
              <StatusBadge status={agent.status} />
            </button>

            {/* Expanded details */}
            {isExpanded && (
              <div style={{ paddingLeft: "20px" }}>
                {/* Current task */}
                {agent.currentTask && (
                  <div style={{ marginBottom: "8px" }}>
                    <div style={{ fontSize: "10px", color: "var(--text-secondary, #a0a0b0)", marginBottom: "2px" }}>
                      Current Task:
                    </div>
                    <div style={{ fontSize: "11px", color: "var(--text-primary, #e0e0e0)" }}>
                      {agent.currentTask.description}
                    </div>
                    <div style={{ fontSize: "10px", color: "var(--text-secondary, #a0a0b0)", marginTop: "2px" }}>
                      Files: {agent.currentTask.files.join(", ")}
                    </div>
                  </div>
                )}

                {/* Locked files */}
                {agent.lockedFiles.size > 0 && (
                  <div style={{ marginBottom: "8px" }}>
                    <div style={{ fontSize: "10px", color: "#fbbf24", marginBottom: "2px" }}>
                      <Lock size={10} style={{ verticalAlign: "middle", marginRight: "4px" }} />
                      Locked Files:
                    </div>
                    {Array.from(agent.lockedFiles).map((f) => (
                      <div key={f} style={{ fontSize: "10px", color: "var(--text-secondary, #a0a0b0)", paddingLeft: "14px" }}>
                        {f}
                      </div>
                    ))}
                  </div>
                )}

                {/* Completed tasks */}
                {agent.completedTasks.length > 0 && (
                  <div style={{ fontSize: "10px", color: "#34d399" }}>
                    <CheckCircle2 size={10} style={{ verticalAlign: "middle", marginRight: "4px" }} />
                    {agent.completedTasks.length} task(s) completed
                  </div>
                )}

                {/* Messages count */}
                {agent.messages.length > 0 && (
                  <div style={{ marginTop: "4px", fontSize: "10px", color: "var(--text-secondary, #a0a0b0)" }}>
                    <MessageCircle size={10} style={{ verticalAlign: "middle", marginRight: "4px" }} />
                    {agent.messages.length} message(s)
                  </div>
                )}
              </div>
            )}
          </div>
        );
      })}

      {/* File locks section */}
      {locks.length > 0 && (
        <div style={{ margin: "8px 16px", padding: "10px", background: "var(--bg-card, #16162a)", border: "1px solid var(--border-color, #2a2a4a)", borderRadius: "8px" }}>
          <div style={{ fontSize: "11px", fontWeight: 600, color: "#fbbf24", marginBottom: "6px", display: "flex", alignItems: "center", gap: "6px" }}>
            <Lock size={12} />
            Active File Locks ({locks.length})
          </div>
          {locks.map((lock) => (
            <div key={lock.file} style={{ display: "flex", justifyContent: "space-between", fontSize: "10px", padding: "2px 0", color: "var(--text-secondary, #a0a0b0)" }}>
              <span>{lock.file}</span>
              <span style={{ color: TYPE_COLORS[agents.find((a) => a.config.id === lock.agentId)?.config.type ?? "implementation"] }}>
                {lock.agentId}
              </span>
            </div>
          ))}
        </div>
      )}

      {/* Architecture report */}
      {orchestrator.getArchitectureReport() && (
        <div style={{ margin: "8px 16px", padding: "10px", background: "#3b076420", border: "1px solid #8b5cf640", borderRadius: "8px" }}>
          <div style={{ fontSize: "11px", fontWeight: 600, color: "#8b5cf6", marginBottom: "4px", display: "flex", alignItems: "center", gap: "6px" }}>
            <GitBranch size={12} />
            Architecture Report
          </div>
          <div style={{ fontSize: "10px", color: "var(--text-secondary, #a0a0b0)", maxHeight: "100px", overflow: "auto", lineHeight: 1.4 }}>
            {orchestrator.getArchitectureReport()}
          </div>
        </div>
      )}

      {/* Inter-agent messages */}
      {agents.some((a) => a.messages.length > 0) && (
        <div style={{ margin: "8px 16px" }}>
          <button
            onClick={() => setShowMessages(!showMessages)}
            style={{
              display: "flex",
              alignItems: "center",
              gap: "6px",
              background: "none",
              border: "none",
              color: "var(--text-secondary, #a0a0b0)",
              fontSize: "11px",
              cursor: "pointer",
              fontFamily: "inherit",
              padding: 0,
            }}
          >
            {showMessages ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
            <MessageCircle size={12} />
            Inter-Agent Communication (
            {agents.reduce((s, a) => s + a.messages.length, 0)} messages)
          </button>

          {showMessages && (
            <div style={{ marginTop: "8px", maxHeight: "200px", overflow: "auto" }}>
              {agents.flatMap((a) =>
                a.messages.map((msg, i) => (
                  <div
                    key={`${a.config.id}-${i}`}
                    style={{
                      padding: "4px 8px",
                      margin: "2px 0",
                      background: "var(--bg-input, #1a1a2e)",
                      borderRadius: "4px",
                      fontSize: "10px",
                      borderLeft: `3px solid ${TYPE_COLORS[agents.find((ag) => ag.config.id === msg.from)?.config.type ?? "implementation"]}`,
                    }}
                  >
                    <span style={{ fontWeight: 600, color: TYPE_COLORS[agents.find((ag) => ag.config.id === msg.from)?.config.type ?? "implementation"] }}>
                      {msg.from}
                    </span>
                    <span style={{ color: "var(--text-secondary, #a0a0b0)", margin: "0 4px" }}>→</span>
                    <span style={{ fontWeight: 600, color: TYPE_COLORS[agents.find((ag) => ag.config.id === msg.to)?.config.type ?? "implementation"] }}>
                      {msg.to}
                    </span>
                    <span style={{
                      marginLeft: "6px",
                      padding: "1px 4px",
                      borderRadius: "3px",
                      fontSize: "8px",
                      background: msg.type === "veto" || msg.type === "block" ? "#7f1d1d30" : "#1e3a5f20",
                      color: msg.type === "veto" || msg.type === "block" ? "#ef4444" : "#60a5fa",
                    }}>
                      {msg.type}
                    </span>
                    <div style={{ marginTop: "2px", color: "var(--text-primary, #e0e0e0)" }}>
                      {msg.content}
                    </div>
                  </div>
                )),
              )}
            </div>
          )}
        </div>
      )}

      {/* Footer */}
      <div style={{
        padding: "8px 16px",
        borderTop: "1px solid var(--border-color, #2a2a4a)",
        fontSize: "10px",
        color: "var(--text-secondary, #a0a0b0)",
        marginTop: "auto",
      }}>
        7-layer safety pipeline active. Architecture + Security guardrails enforce boundaries.
      </div>
    </div>
  );
}

// ── Sub-component ─────────────────────────────────────────────────────────────

function StatusBadge({ status }: { status: AgentStatus }) {
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: "4px",
        padding: "2px 8px",
        borderRadius: "10px",
        fontSize: "10px",
        fontWeight: 600,
        background: `${STATUS_COLORS[status]}20`,
        color: STATUS_COLORS[status],
        border: `1px solid ${STATUS_COLORS[status]}40`,
      }}
    >
      {status === "running" && <RefreshCw size={8} style={{ animation: "spin 1s linear infinite" }} />}
      {status.toUpperCase()}
    </span>
  );
}
