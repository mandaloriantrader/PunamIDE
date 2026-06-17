/**
 * Chat panel header with mode dropdown, session controls, and export button.
 * Extracted from AiChat.tsx.
 */

import { useState } from "react";
import type { ElementType } from "react";
import { Bot, Check, ChevronDown, Download, History, Plus, Trash2, X } from "lucide-react";
import type { ChatSession } from "../../utils/tauri";
import type { AgentMode } from "../../types";

interface AgentModeConfig {
  id: AgentMode;
  label: string;
  icon: ElementType;
  placeholder: string;
  instruction: string;
}

interface ChatHeaderProps {
  agentMode: AgentMode;
  agentModes: AgentModeConfig[];
  loading: boolean;
  messages: { length: number };
  sessions: ChatSession[];
  activeSessionId: string | null;
  showSessionList: boolean;
  onSetAgentMode: (mode: AgentMode) => void;
  onExportChat: () => void;
  onNewSession: () => void;
  onToggleSessionList: () => void;
  onSwitchSession: (id: string) => void;
  onDeleteSession: (id: string) => void;
  onCloseSessionList: () => void;
}

export function ChatHeader({
  agentMode,
  agentModes,
  loading,
  messages,
  sessions,
  activeSessionId,
  showSessionList,
  onSetAgentMode,
  onExportChat,
  onNewSession,
  onToggleSessionList,
  onSwitchSession,
  onDeleteSession,
  onCloseSessionList,
}: ChatHeaderProps) {
  const [modeDropdownOpen, setModeDropdownOpen] = useState(false);

  return (
    <>
      <div className="ai-chat-header">
        <div className="ai-chat-title">
          <Bot size={14} />
          <span>PUNAM AI</span>
        </div>
        <div className="ai-header-actions">
          <button
            className="ai-header-btn"
            onClick={onExportChat}
            title="Export Chat"
            aria-label="Export chat as markdown"
            disabled={messages.length === 0}
          >
            <Download size={14} />
          </button>
          <button
            className="ai-header-btn"
            onClick={onNewSession}
            title="New Chat"
            aria-label="New chat session"
          >
            <Plus size={14} />
          </button>
          <button
            className="ai-header-btn"
            onClick={onToggleSessionList}
            title="Chat History"
            aria-label="Show chat history"
          >
            <History size={14} />
          </button>
          <div className="ai-mode-dropdown-wrap">
            <button
              className="ai-mode-dropdown-trigger"
              onClick={() => setModeDropdownOpen(!modeDropdownOpen)}
              disabled={loading}
              type="button"
              aria-expanded={modeDropdownOpen}
            >
              {(() => {
                const current = agentModes.find((m) => m.id === agentMode);
                const Icon = current?.icon || agentModes[1]?.icon;
                return (
                  <>
                    {Icon && <Icon size={14} />}
                    <span>{current?.label || "Chat"}</span>
                    <ChevronDown size={12} className={`dropdown-chevron ${modeDropdownOpen ? "open" : ""}`} />
                  </>
                );
              })()}
            </button>
            {modeDropdownOpen && (
              <>
                <div className="ai-mode-dropdown-backdrop" onClick={() => setModeDropdownOpen(false)} />
                <div className="ai-mode-dropdown-menu">
                  {agentModes.map((mode) => {
                    const Icon = mode.icon;
                    return (
                      <button
                        key={mode.id}
                        className={`ai-mode-dropdown-item ${agentMode === mode.id ? "active" : ""}`}
                        onClick={() => { onSetAgentMode(mode.id); setModeDropdownOpen(false); }}
                        type="button"
                      >
                        <Icon size={14} />
                        <div className="ai-mode-dropdown-text">
                          <span className="ai-mode-dropdown-label">{mode.label}</span>
                          <span className="ai-mode-dropdown-desc">{mode.placeholder}</span>
                        </div>
                        {agentMode === mode.id && <Check size={14} className="ai-mode-check" />}
                      </button>
                    );
                  })}
                </div>
              </>
            )}
          </div>
        </div>
      </div>

      {/* Session List Panel */}
      {showSessionList && (
        <div className="ai-session-list">
          <div className="ai-session-list-header">
            <span>Chat History</span>
            <button className="ai-session-list-close" onClick={onCloseSessionList}>
              <X size={14} />
            </button>
          </div>
          <div className="ai-session-list-items">
            {sessions.map((session) => (
              <div
                key={session.id}
                className={`ai-session-item ${session.id === activeSessionId ? "active" : ""}`}
                onClick={() => onSwitchSession(session.id)}
              >
                <div className="ai-session-item-info">
                  <span className="ai-session-item-title">{session.title}</span>
                  <span className="ai-session-item-meta">
                    {session.messageCount} msgs • {new Date(session.updatedAt).toLocaleDateString()}
                  </span>
                </div>
                {sessions.length > 1 && (
                  <button
                    className="ai-session-item-delete"
                    onClick={(e) => { e.stopPropagation(); onDeleteSession(session.id); }}
                    title="Delete session"
                  >
                    <Trash2 size={12} />
                  </button>
                )}
              </div>
            ))}
            {sessions.length === 0 && (
              <div className="ai-session-list-empty">No chat sessions yet.</div>
            )}
          </div>
        </div>
      )}
    </>
  );
}
