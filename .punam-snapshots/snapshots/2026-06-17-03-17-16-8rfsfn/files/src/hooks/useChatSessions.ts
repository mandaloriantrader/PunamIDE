import { useState, useEffect } from "react";
import { saveChatSession, loadChatSession as dbLoadSession, loadChatSessions as dbLoadSessions, deleteChatSession as dbDeleteSession, initChatDb } from "../services/persistence/chatDb";
import type { ChatSessionRecord } from "../services/persistence/chatDb";
import type { ChatMessage, AgentMode, ToolEvent } from "../types";
import type { ChatAttachment } from "../utils/tauri";
import type { ParsedResponse } from "../utils/prompts";
import type { ResponseMetrics } from "../utils/providers";

/** Map old mode values to the new 2-mode system */
function normalizeMode(mode: string | undefined): AgentMode | undefined {
  if (!mode) return undefined;
  if (mode === "chat" || mode === "agent") return mode;
  return "chat";
}

/** Split <thinking> blocks from raw AI output so they stay as metadata. */
function splitAssistantContent(raw: string): { thinking: string; content: string } {
  const thinkingMatch = raw.match(/<thinking>([\s\S]*?)<\/thinking>/i);
  return {
    thinking: thinkingMatch?.[1]?.trim() || "",
    content: raw.replace(/<thinking>[\s\S]*?<\/thinking>/gi, "").trim(),
  };
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
  thinking?: string;
  toolEvents?: ToolEvent[];
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
  let messageCount = 0;
  try {
    const parsed = JSON.parse(rec.messages || "[]");
    messageCount = Array.isArray(parsed) ? parsed.length : 0;
  } catch {
    console.warn(`Corrupt messages in chat session ${rec.id}; loading it as empty.`);
  }
  return {
    id: rec.id,
    title: rec.title,
    createdAt: rec.created_at,
    updatedAt: rec.updated_at,
    messageCount,
  };
}

function restorePersistedMessage(message: PersistedChatMessage): ChatMessage {
  // Sanitize: if thinking wasn't stored separately, extract <thinking> from old content
  let content = message.content;
  let thinking = message.thinking;

  if (message.role === "assistant" && !thinking && content.includes("<thinking>")) {
    const parsed = splitAssistantContent(content);
    content = parsed.content || content;
    thinking = parsed.thinking || undefined;
  }

  return {
    role: message.role,
    content,
    mode: normalizeMode(message.mode),
    thinking,
    toolEvents: message.toolEvents,
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

    (async () => {
      await initChatDb();
      if (cancelled) return;

      let loadedRecords = await dbLoadSessions(projectPath, 50);
      if (cancelled) return;

      if (loadedRecords.length === 0) {
        const newRecord: ChatSessionRecord = {
          id: generateSessionId(),
          project_path: projectPath,
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
        if (cancelled) return;
        loadedRecords = [newRecord];
        setActiveSessionId(newRecord.id);
      } else {
        setActiveSessionId(loadedRecords[0].id);
      }

      const loadedSessions = loadedRecords.map(recordToSession);
      setSessions(loadedSessions);

      const targetId = loadedSessions[0]?.id;
      if (targetId) {
        const targetRecord = loadedRecords.find((r) => r.id === targetId);
        if (targetRecord) {
          try {
            const saved: PersistedChatMessage[] = JSON.parse(targetRecord.messages || "[]");
            setMessages(saved.map(restorePersistedMessage));
          } catch { /* empty messages */ }
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [projectPath]);

  useEffect(() => {
    if (!projectPath || messages.length === 0 || !activeSessionId) return;
    const timer = setTimeout(async () => {
      const toSave: PersistedChatMessage[] = messages
        .filter((m) => (m.content && m.content.length > 0) || m.parsed || m.multiResponses || m.thinking)
        .slice(-30)
        .map((m) => {
          // Before saving: strip <thinking> from content into metadata
          let cleanContent = m.content.slice(0, 200000);
          let thinking = m.thinking;
          if (m.role === "assistant" && !thinking && cleanContent.includes("<thinking>")) {
            const parsed = splitAssistantContent(cleanContent);
            cleanContent = parsed.content || cleanContent;
            thinking = parsed.thinking || undefined;
          }
          return {
            role: m.role,
            content: cleanContent,
            thinking,
            toolEvents: m.toolEvents,
            mode: m.mode,
            timestamp: Date.now(),
            attachments: m.attachments,
            parsed: m.parsed,
            applied: m.applied,
            metrics: m.metrics,
            multiResponses: m.multiResponses,
            checkResult: m.checkResult,
          };
        });

      const existingRec = await dbLoadSession(activeSessionId, projectPath);
      if (!existingRec) {
        console.warn(`Skipped autosave because chat session metadata was unavailable: ${activeSessionId}`);
        return;
      }
      const rec: ChatSessionRecord = {
        id: activeSessionId,
        project_path: projectPath,
        title: existingRec.title,
        provider: existingRec.provider,
        model: existingRec.model,
        messages: JSON.stringify(toSave),
        token_count: existingRec.token_count,
        cost: existingRec.cost,
        created_at: existingRec.created_at,
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
      project_path: projectPath,
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
    const records = await dbLoadSessions(projectPath, 50);
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
    await dbDeleteSession(sessionId, projectPath);
    const remaining = sessions.filter((s) => s.id !== sessionId);
    if (remaining.length === 0) {
      const newRecord: ChatSessionRecord = {
        id: generateSessionId(),
        project_path: projectPath,
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
        const records = await dbLoadSessions(projectPath, 50);
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
