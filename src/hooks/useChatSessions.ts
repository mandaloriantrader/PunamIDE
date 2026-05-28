import { useState, useEffect } from "react";
import { saveChatSession, loadChatSessions as dbLoadSessions, deleteChatSession as dbDeleteSession, initChatDb } from "../services/persistence/chatDb";
import type { ChatSessionRecord } from "../services/persistence/chatDb";
import type { ChatMessage, AgentMode } from "../types";
import type { ChatAttachment } from "../utils/tauri";
import type { ParsedResponse } from "../utils/prompts";
import type { ResponseMetrics } from "../utils/providers";

/** Map old mode values to the new 2-mode system */
function normalizeMode(mode: string | undefined): AgentMode | undefined {
  if (!mode) return undefined;
  if (mode === "chat" || mode === "agent") return mode;
  // Old modes: ask, edit, fix, explain, refactor → map to "chat"
  return "chat";
}

interface UseChatSessionsOptions {
  projectPath: string;
  messages: ChatMessage[];
  setMessages: React.Dispatch<React.SetStateAction<ChatMessage[]>>;
}

interface PersistedChatMessage {
  role: "user" | "assistant";
  content: string;
  mode?: string;
  timestamp?: number;
  attachments?: ChatAttachment[];
  parsed?: ParsedResponse;
  applied?: boolean;
  metrics?: ResponseMetrics;
  multiResponses?: ChatMessage["multiResponses"];
  checkResult?: ChatMessage["checkResult"];
}

interface ChatSession {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messageCount: number;
}

function generateSessionId(): string {
  return `session-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function recordToSession(rec: ChatSessionRecord): ChatSession {
  return {
    id: rec.id,
    title: rec.title,
    createdAt: rec.created_at,
    updatedAt: rec.updated_at,
    messageCount: rec.messages ? JSON.parse(rec.messages).length : 0,
  };
}

function restorePersistedMessage(message: PersistedChatMessage): ChatMessage {
  return {
    role: message.role,
    content: message.content,
    mode: normalizeMode(message.mode),
    attachments: message.attachments,
    parsed: message.parsed,
    applied: message.applied,
    metrics: message.metrics,
    multiResponses: message.multiResponses,
    checkResult: message.checkResult,
  };
}

export function useChatSessions({ projectPath, messages, setMessages }: UseChatSessionsOptions) {
  const [sessions, setSessions] = useState<ChatSession[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [showSessionList, setShowSessionList] = useState(false);

  useEffect(() => {
    if (!projectPath) return;
    let cancelled = false;
    setMessages([]);
    setActiveSessionId(null);
    setSessions([]);

    const initSession = async () => {
      try {
        await initChatDb();
      } catch {
        // DB init failed (e.g., running in browser dev mode) — skip session management
        return;
      }
      if (cancelled) return;

      let loadedRecords: ChatSessionRecord[] = [];
      try {
        loadedRecords = await dbLoadSessions(50);
      } catch {
        // DB load failed — start fresh
      }
      if (cancelled) return;

      // Always start a fresh session when project changes
      // This prevents old project context from leaking into new projects
      const newRecord: ChatSessionRecord = {
        id: generateSessionId(),
        title: "New Chat",
        provider: "",
        model: "",
        messages: "[]",
        token_count: 0,
        cost: 0,
        created_at: Date.now(),
        updated_at: Date.now(),
      };
      try {
        await saveChatSession(newRecord);
      } catch {
        // Save failed — continue with in-memory session only
      }
      if (cancelled) return;

      // Load existing sessions for the session list (user can switch back if needed)
      const loadedSessions = loadedRecords.length > 0
        ? [recordToSession(newRecord), ...loadedRecords.map(recordToSession)]
        : [recordToSession(newRecord)];
      setSessions(loadedSessions);
      setActiveSessionId(newRecord.id);
      setMessages([]);
    };

    initSession();
    return () => {
      cancelled = true;
    };
  }, [projectPath]);

  useEffect(() => {
    if (!projectPath || messages.length === 0 || !activeSessionId) return;
    const timer = setTimeout(async () => {
      const toSave: PersistedChatMessage[] = messages
        .filter((m) => (m.content && m.content.length > 0) || m.parsed || m.multiResponses)
        .slice(-30)
        .map((m) => ({
          role: m.role,
          content: m.content.slice(0, 200000),
          mode: m.mode,
          timestamp: Date.now(),
          attachments: m.attachments,
          parsed: m.parsed,
          applied: m.applied,
          metrics: m.metrics,
          multiResponses: m.multiResponses,
          checkResult: m.checkResult,
        }));

      const existing = await dbLoadSessions(1);
      const existingRec = existing.find((r) => r.id === activeSessionId);
      const rec: ChatSessionRecord = {
        id: activeSessionId,
        title: existingRec?.title || "New Chat",
        provider: existingRec?.provider || "",
        model: existingRec?.model || "",
        messages: JSON.stringify(toSave),
        token_count: existingRec?.token_count || 0,
        cost: existingRec?.cost || 0,
        created_at: existingRec?.created_at || Date.now(),
        updated_at: Date.now(),
      };
      if (rec.title === "New Chat" && toSave.length > 0) {
        const firstUser = toSave.find((m) => m.role === "user");
        if (firstUser) {
          rec.title = firstUser.content.slice(0, 50) + (firstUser.content.length > 50 ? "..." : "");
        }
      }
      await saveChatSession(rec).catch(() => {});
    }, 2000);
    return () => clearTimeout(timer);
  }, [messages, projectPath, activeSessionId]);

  const handleNewSession = async () => {
    if (!projectPath) return;
    const newRecord: ChatSessionRecord = {
      id: generateSessionId(),
      title: "New Chat",
      provider: "",
      model: "",
      messages: "[]",
      token_count: 0,
      cost: 0,
      created_at: Date.now(),
      updated_at: Date.now(),
    };
    await saveChatSession(newRecord);
    setSessions((prev) => [recordToSession(newRecord), ...prev]);
    setActiveSessionId(newRecord.id);
    setMessages([]);
    setShowSessionList(false);
  };

  const handleSwitchSession = async (sessionId: string) => {
    if (!projectPath || sessionId === activeSessionId) return;
    setActiveSessionId(sessionId);
    setShowSessionList(false);
    const records = await dbLoadSessions(50);
    const target = records.find((r) => r.id === sessionId);
    if (target) {
      try {
        const saved: PersistedChatMessage[] = JSON.parse(target.messages || "[]");
        setMessages(saved.map(restorePersistedMessage));
      } catch {
        setMessages([]);
      }
    } else {
      setMessages([]);
    }
  };

  const handleDeleteSession = async (sessionId: string) => {
    if (!projectPath) return;
    await dbDeleteSession(sessionId);
    const remaining = sessions.filter((s) => s.id !== sessionId);
    if (remaining.length === 0) {
      const newRecord: ChatSessionRecord = {
        id: generateSessionId(),
        title: "New Chat",
        provider: "",
        model: "",
        messages: "[]",
        token_count: 0,
        cost: 0,
        created_at: Date.now(),
        updated_at: Date.now(),
      };
      await saveChatSession(newRecord);
      setSessions([recordToSession(newRecord)]);
      setActiveSessionId(newRecord.id);
      setMessages([]);
    } else {
      setSessions(remaining);
      if (sessionId === activeSessionId) {
        setActiveSessionId(remaining[0].id);
        const records = await dbLoadSessions(50);
        const target = records.find((r) => r.id === remaining[0].id);
        if (target) {
          try {
            const saved: PersistedChatMessage[] = JSON.parse(target.messages || "[]");
            setMessages(saved.map(restorePersistedMessage));
          } catch {
            setMessages([]);
          }
        }
      }
    }
  };

  return {
    sessions,
    activeSessionId,
    showSessionList,
    setShowSessionList,
    handleNewSession,
    handleSwitchSession,
    handleDeleteSession,
  };
}
