import { useState, useRef, useEffect, useCallback, useMemo, memo } from "react";
import { startTerminalProcess, stopTerminalProcess, loadTerminalHistory, saveTerminalHistory } from "../utils/tauri";
import { listen } from "@tauri-apps/api/event";
import { parseAnsi, stripAnsi } from "../utils/ansi";
import type { AnsiSpan } from "../utils/ansi";
import { Plus, X, Lightbulb } from "lucide-react";
import { sendToProviderStreaming } from "../utils/providers";
import type { AIProviderConfig } from "../utils/providers";
import { createRunObservation, type RunObservation } from "../services/run/verifiedRun";

// --- Types ---

interface TerminalLine {
  type: "input" | "output" | "error" | "success" | "warning" | "system";
  text: string;
  spans: AnsiSpan[];
}

interface TerminalSession {
  id: string;
  name: string;
  lines: TerminalLine[];
  running: boolean;
  activeCommand: string;
  activeSessionId: string | null;
  status: "idle" | "running" | "completed" | "failed" | "killed";
  history: string[];
  historyIdx: number;
}

interface Props {
  cwd: string;
  embedded?: boolean;
  tabBarPrefix?: React.ReactNode;
  onOutputChange?: (output: string) => void;
  commandToRun?: string | null;
  onCommandStarted?: () => void;
  onCommandFailed?: (command: string, output: string) => void;
  onRunObservation?: (observation: RunObservation) => void;
  onOpenUrl?: (url: string) => void;
  aiProviders?: AIProviderConfig[];
  onFixWithAi?: (errorContext: string) => void;
}

interface TerminalOutputPayload {
  session_id: string;
  stream: string;
  line: string;
}

interface TerminalStatusPayload {
  session_id: string;
  status: string;
  exit_code: number | null;
  stdout?: string | null;
  stderr?: string | null;
}

const MAX_TERMINAL_LINES = 5_000;
const MAX_TERMINAL_HISTORY = 200;
const MAX_CAPTURED_OUTPUT_CHARS = 1_000_000;

function appendTerminalLines(lines: TerminalLine[], additions: TerminalLine[]): TerminalLine[] {
  const combined = [...lines, ...additions];
  return combined.length > MAX_TERMINAL_LINES
    ? combined.slice(-MAX_TERMINAL_LINES)
    : combined;
}

function appendTerminalHistory(history: string[], command: string): string[] {
  return [...history, command].slice(-MAX_TERMINAL_HISTORY);
}

function appendCapturedOutput(current: string, addition: string): string {
  const combined = current + addition;
  return combined.length > MAX_CAPTURED_OUTPUT_CHARS
    ? combined.slice(-MAX_CAPTURED_OUTPUT_CHARS)
    : combined;
}

// --- URL detection regex ---
const URL_RE = /https?:\/\/[^\s<>"')\]},;]+/g;

// --- Helper: create a line object ---
function makeLine(type: TerminalLine["type"], text: string): TerminalLine {
  return { type, text, spans: parseAnsi(text) };
}

// --- Memoized ANSI line renderer with clickable URLs ---
const AnsiLine = memo(({ spans, onOpenUrl }: { spans: AnsiSpan[]; onOpenUrl?: (url: string) => void }) => {
  return (
    <>
      {spans.map((span, i) => (
        <AnsiSpanWithLinks key={i} span={span} onOpenUrl={onOpenUrl} />
      ))}
    </>
  );
});

/** Renders a single ANSI span, splitting URLs into clickable links */
const AnsiSpanWithLinks = memo(({ span, onOpenUrl }: { span: AnsiSpan; onOpenUrl?: (url: string) => void }) => {
  const { text, style } = span;
  const hasStyle = Object.keys(style).length > 0;
  const matches = [...text.matchAll(URL_RE)];

  // Check if text contains URLs
  if (matches.length === 0) {
    // No URLs — fast path
    return hasStyle ? <span style={style}>{text}</span> : <span>{text}</span>;
  }

  // Split text around URLs
  const parts: (string | { url: string })[] = [];
  let lastIdx = 0;

  for (const match of matches) {
    if (match.index > lastIdx) {
      parts.push(text.slice(lastIdx, match.index));
    }
    parts.push({ url: match[0] });
    lastIdx = match.index + match[0].length;
  }
  if (lastIdx < text.length) {
    parts.push(text.slice(lastIdx));
  }

  return (
    <span style={hasStyle ? style : undefined}>
      {parts.map((part, j) =>
        typeof part === "string" ? (
          <span key={j}>{part}</span>
        ) : (
          <a
            key={j}
            href={part.url}
            className="terminal-link"
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              if (onOpenUrl) onOpenUrl(part.url);
              else window.open(part.url, "_blank", "noopener,noreferrer");
            }}
          >
            {part.url}
          </a>
        )
      )}
    </span>
  );
});

// --- Initial session factory ---
function createSession(index: number, cwd: string): TerminalSession {
  return {
    id: `session-${Date.now()}-${index}`,
    name: `Terminal ${index}`,
    lines: [
      makeLine("system", `PunamIDE v2.0 Terminal - ${cwd || "No project opened"}`),
      makeLine("system", 'Type commands and press Enter. Type "clear" to clear.'),
    ],
    running: false,
    activeCommand: "",
    activeSessionId: null,
    status: "idle",
    history: [],
    historyIdx: -1,
  };
}

function createProcessId(tabId: string): string {
  return `${tabId}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

// --- Main Component ---

export default function Terminal({ cwd, onOutputChange, commandToRun, onCommandStarted, onCommandFailed, onRunObservation, onOpenUrl, aiProviders = [], onFixWithAi, tabBarPrefix }: Props) {
  const [sessions, setSessions] = useState<TerminalSession[]>(() => [createSession(1, cwd)]);
  const [activeTabId, setActiveTabId] = useState<string>(() => sessions[0]?.id || "");
  const [input, setInput] = useState("");
  const bottomRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const bufferRef = useRef<Map<string, TerminalLine[]>>(new Map());
  const streamedOutputRef = useRef<Map<string, string>>(new Map());
  const processTabRef = useRef<Map<string, string>>(new Map());
  const completedProcessTabRef = useRef<Map<string, string>>(new Map());
  const killedSessionsRef = useRef<Set<string>>(new Set());
  const reportedObservationsRef = useRef<Set<string>>(new Set());
  const flushTimerRef = useRef<number | null>(null);
  const tabCounterRef = useRef(1);
  const punamCommandTabRef = useRef<string | null>(null);
  const lastInjectedCommandRef = useRef<{ command: string; time: number } | null>(null);
  const persistedHistoryLoaded = useRef(false);

  const activeSession = sessions.find((s) => s.id === activeTabId);

  // ── Terminal output virtualization ──────────────────────────────────────────
  const TERMINAL_LINE_HEIGHT = 20; // px — monospace line height at 13px font
  const TERMINAL_OVERSCAN = 20;
  const terminalOutputRef = useRef<HTMLDivElement>(null);
  const [terminalScrollTop, setTerminalScrollTop] = useState(0);
  const [terminalViewHeight, setTerminalViewHeight] = useState(400);
  const autoScrollRef = useRef(true); // tracks if user is at bottom

  // ResizeObserver for terminal output container height
  useEffect(() => {
    const el = terminalOutputRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        setTerminalViewHeight(entry.contentRect.height);
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const handleTerminalScroll = useCallback((e: React.UIEvent<HTMLDivElement>) => {
    const el = e.currentTarget;
    setTerminalScrollTop(el.scrollTop);
    // Detect if user is near the bottom (within 50px) — enable auto-scroll
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 50;
    autoScrollRef.current = atBottom;
  }, []);

  // Auto-scroll to bottom when new lines arrive (only if user was already at bottom)
  useEffect(() => {
    if (autoScrollRef.current && terminalOutputRef.current) {
      terminalOutputRef.current.scrollTop = terminalOutputRef.current.scrollHeight;
    }
  }, [activeSession?.lines.length]);

  // Compute visible line window
  const visibleLines = useMemo(() => {
    if (!activeSession) return [];
    const lines = activeSession.lines;
    const startIdx = Math.max(0, Math.floor(terminalScrollTop / TERMINAL_LINE_HEIGHT) - TERMINAL_OVERSCAN);
    const endIdx = Math.min(lines.length, Math.ceil((terminalScrollTop + terminalViewHeight) / TERMINAL_LINE_HEIGHT) + TERMINAL_OVERSCAN);
    const result: Array<{ line: TerminalLine; index: number }> = [];
    for (let i = startIdx; i < endIdx; i++) {
      result.push({ line: lines[i], index: i });
    }
    return result;
  }, [activeSession?.lines, terminalScrollTop, terminalViewHeight]);
  // ── End virtualization ─────────────────────────────────────────────────────

  const reportRunObservation = useCallback((command: string, output: string, status?: RunObservation["status"]) => {
    if (!onRunObservation || !command) return;
    const observation = createRunObservation(command, output, status);
    if (!observation) return;
    const dedupeKey = `${observation.command}|${observation.status}|${observation.url || ""}|${observation.reason || ""}`;
    if (reportedObservationsRef.current.has(dedupeKey)) return;
    reportedObservationsRef.current.add(dedupeKey);
    onRunObservation(observation);
  }, [onRunObservation]);

  // --- Smart terminal suggestion state ---
  const [suggestion, setSuggestion] = useState<string | null>(null);
  const [suggestionLoading, setSuggestionLoading] = useState(false);
  const lastSuggestedFor = useRef<string>("");

  // Load persistent history on mount
  useEffect(() => {
    if (persistedHistoryLoaded.current) return;
    persistedHistoryLoaded.current = true;
    loadTerminalHistory().then((savedHistory) => {
      if (savedHistory.length > 0) {
        setSessions((prev) =>
          prev.map((s, i) => i === 0 ? { ...s, history: savedHistory } : s)
        );
      }
    }).catch(() => { /* store may be empty or corrupted */ });
  }, []);

  // --- Smart terminal suggestions after failure ---
  useEffect(() => {
    if (!activeSession || activeSession.status !== "failed") return;
    if (!aiProviders.length) return;
    const output = activeSession.lines
      .slice(-40)
      .map((l) => stripAnsi(l.text))
      .join("\n");
    const key = `${activeSession.activeCommand}|${output.slice(-200)}`;
    if (lastSuggestedFor.current === key) return;
    lastSuggestedFor.current = key;

    const provider = aiProviders.find((p) => p.apiKey && p.models.some((m) => m.enabled));
    if (!provider) return;
    const model = provider.models.find((m) => m.enabled);
    if (!model) return;

    setSuggestionLoading(true);
    setSuggestion(null);

    sendToProviderStreaming(provider, model.id, {
      systemPrompt:
        "You are a terminal assistant. Given a failed command and its error output, output ONLY the next single shell command to try to fix the problem. " +
        "No explanation. No markdown. Just the raw command. If no fix is obvious output an empty string.",
      userPrompt: `Failed command: ${activeSession.activeCommand}\n\nOutput:\n${output.slice(-1500)}`,
    })
      .then((resp) => {
        const cmd = resp.success
          ? resp.text.replace(/^```[\w]*\n?/, "").replace(/\n?```$/, "").trim()
          : "";
        setSuggestion(cmd || null);
      })
      .catch(() => setSuggestion(null))
      .finally(() => setSuggestionLoading(false));
  }, [activeSession?.status, activeSession?.id]);
  useEffect(() => {
    if (!commandToRun || !cwd) return;

    const runInjectedCommand = async () => {
      const cmd = commandToRun;

      const now = Date.now();
      const lastInjected = lastInjectedCommandRef.current;
      if (lastInjected?.command === cmd && now - lastInjected.time < 2000) {
        onCommandStarted?.();
        return;
      }
      lastInjectedCommandRef.current = { command: cmd, time: now };

      onCommandStarted?.();

      const tabId = punamCommandTabRef.current || `session-punam-${now}`;
      punamCommandTabRef.current = tabId;
      const newSession: TerminalSession = {
        id: tabId,
        name: shortName(cmd),
        lines: [makeLine("system", "Punam AI -> Running command"), makeLine("input", `PS> ${cmd}`)],
        running: true,
        activeCommand: cmd,
        activeSessionId: null,
        status: "running",
        history: [cmd],
        historyIdx: -1,
      };

      setSessions((prev) =>
        prev.some((session) => session.id === tabId)
          ? prev.map((session) =>
              session.id === tabId
                ? {
                    ...session,
                    name: shortName(cmd),
                    lines: appendTerminalLines(session.lines, newSession.lines),
                    running: true,
                    activeCommand: cmd,
                    activeSessionId: null,
                    status: "running" as const,
                    history: appendTerminalHistory(session.history, cmd),
                    historyIdx: -1,
                  }
                : session
            )
          : [...prev, newSession]
      );
      setActiveTabId(tabId);

      try {
        const processId = createProcessId(tabId);
        killedSessionsRef.current.delete(processId);
        bufferRef.current.delete(processId);
        streamedOutputRef.current.delete(processId);
        processTabRef.current.set(processId, tabId);
        setSessions((prev) =>
          prev.map((s) =>
            s.id === tabId ? { ...s, activeSessionId: processId } : s
          )
        );
        const sessionId = await startTerminalProcess(cmd, cwd, processId);
        if (sessionId !== processId) {
          processTabRef.current.delete(processId);
          processTabRef.current.set(sessionId, tabId);
          setSessions((prev) =>
            prev.map((s) =>
              s.id === tabId && s.activeSessionId === processId
                ? { ...s, activeSessionId: sessionId }
                : s
            )
          );
        }
        window.setTimeout(flushBuffer, 0);
      } catch (err) {
        const processIds = [...processTabRef.current.entries()]
          .filter(([, mappedTabId]) => mappedTabId === tabId)
          .map(([processId]) => processId);
        processIds.forEach((processId) => {
          processTabRef.current.delete(processId);
          bufferRef.current.delete(processId);
          streamedOutputRef.current.delete(processId);
        });
        setSessions((prev) =>
          prev.map((s) =>
            s.id === tabId
              ? {
                  ...s,
                  lines: appendTerminalLines(s.lines, [makeLine("error", `Error: ${err}`)]),
                  running: false,
                  activeCommand: "",
                  status: "failed" as const,
                }
              : s
          )
        );
      }
    };

    runInjectedCommand();
  }, [commandToRun]);

  // Scroll to bottom is now handled by the virtualization auto-scroll mechanism above

  // Report recent terminal output to parent for AI context.
  // Debounced to avoid expensive string ops on every terminal line.
  const outputReportTimerRef = useRef<number | null>(null);
  useEffect(() => {
    if (!onOutputChange) return;
    if (outputReportTimerRef.current !== null) {
      window.clearTimeout(outputReportTimerRef.current);
    }
    outputReportTimerRef.current = window.setTimeout(() => {
      outputReportTimerRef.current = null;
      const recentSessions = sessions
        .filter((session) => session.lines.length > 0)
        .slice(-3);
      const text = recentSessions
        .map((session) => {
          const lastLines = session.lines.slice(-120).map((line) => stripAnsi(line.text));
          return [`--- ${session.name} (${session.status}) ---`, ...lastLines].join("\n");
        })
        .join("\n\n")
        .slice(-12000);
      onOutputChange(text);

      for (const session of recentSessions) {
        const output = session.lines.slice(-120).map((line) => stripAnsi(line.text)).join("\n");
        reportRunObservation(session.activeCommand, output, session.status === "failed" ? "failed" : undefined);
      }
    }, 500);

    return () => {
      if (outputReportTimerRef.current !== null) {
        window.clearTimeout(outputReportTimerRef.current);
      }
    };
  }, [sessions, onOutputChange, reportRunObservation]);

  useEffect(() => {
    inputRef.current?.focus();
  }, [activeTabId, activeSession?.running]);

  // --- Buffer flush (throttled) ---
  const flushBuffer = useCallback(() => {
    const buf = bufferRef.current;
    if (buf.size === 0) {
      flushTimerRef.current = null;
      return;
    }

    setSessions((prev) => {
      const consumedProcessIds = new Set<string>();
      const next = prev.map((session) => {
        const completedSessionIds = [...completedProcessTabRef.current.entries()]
          .filter(([, tabId]) => tabId === session.id)
          .map(([processId]) => processId);
        const mappedSessionIds = [...processTabRef.current.entries()]
          .filter(([, tabId]) => tabId === session.id)
          .map(([processId]) => processId);
        const processIds = [
          ...(session.activeSessionId ? [session.activeSessionId] : []),
          ...completedSessionIds,
          ...mappedSessionIds,
        ];
        const pending = processIds.flatMap((processId) => buf.get(processId) || []);
        if (!pending || pending.length === 0) return session;
        processIds.forEach((processId) => {
          if (buf.has(processId)) consumedProcessIds.add(processId);
        });
        return { ...session, lines: appendTerminalLines(session.lines, pending) };
      });
      consumedProcessIds.forEach((processId) => buf.delete(processId));
      return next;
    });
    flushTimerRef.current = null;
  }, []);

  // --- Classify output ---
  const classifyOutput = (text: string): TerminalLine["type"] => {
    const plain = stripAnsi(text);
    if (/\b(error|failed|fatal|exception|panic)\b/i.test(plain)) return "error";
    if (/\b(warn|warning|deprecated)\b/i.test(plain)) return "warning";
    if (/\b(success|done|passed|compiled|finished)\b/i.test(plain)) return "success";
    return "output";
  };

  // --- Listen for terminal-output events ---
  // Routes all output through bufferRef and flushes once per animation frame.
  // This prevents 10,000+ state updates/sec from verbose processes (npm install, cargo build).
  const rafFlushRef = useRef<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | null = null;
    void listen<TerminalOutputPayload>("terminal-output", (event) => {
      if (cancelled) return;
      const { session_id, line } = event.payload;

      // Ignore output from sessions that have been killed (B011 fix)
      if (killedSessionsRef.current.has(session_id)) return;

      const type = classifyOutput(line);
      const termLine: TerminalLine = { type, text: line, spans: parseAnsi(line) };
      streamedOutputRef.current.set(
        session_id,
        appendCapturedOutput(streamedOutputRef.current.get(session_id) || "", `${line}\n`)
      );

      // Buffer the line — don't flush to state yet
      const existing = bufferRef.current.get(session_id);
      if (existing) {
        existing.push(termLine);
      } else {
        bufferRef.current.set(session_id, [termLine]);
      }

      // Schedule a single RAF flush if not already scheduled
      if (rafFlushRef.current === null) {
        rafFlushRef.current = requestAnimationFrame(() => {
          rafFlushRef.current = null;
          flushBuffer();
        });
      }
    }).then((registeredUnlisten) => {
      if (cancelled) registeredUnlisten();
      else unlisten = registeredUnlisten;
    }).catch((err) => console.warn("Failed to register terminal-output listener:", err));

    return () => {
      cancelled = true;
      unlisten?.();
      if (rafFlushRef.current !== null) {
        cancelAnimationFrame(rafFlushRef.current);
        rafFlushRef.current = null;
      }
    };
  }, [flushBuffer]);

  // --- Listen for terminal-status events ---
  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | null = null;
    void listen<TerminalStatusPayload>("terminal-status", (event) => {
      if (cancelled) return;
      const { session_id, status, exit_code } = event.payload;

      if (status === "running") {
        const mappedTabId = processTabRef.current.get(session_id);
        setSessions((prev) =>
          prev.map((s) =>
            s.activeSessionId === session_id || s.id === mappedTabId
              ? { ...s, running: true, activeSessionId: session_id, status: "running" as const }
              : s
          )
        );
        return;
      }

      // Mark killed sessions so we ignore any trailing output (B011 fix)
      if (status === "killed") {
        killedSessionsRef.current.add(session_id);
        // Also clear any buffered output for this session
        bufferRef.current.delete(session_id);
      }

      // Flush remaining buffer for this session
      if (flushTimerRef.current !== null) {
        window.clearTimeout(flushTimerRef.current);
        flushTimerRef.current = null;
      }
      flushBuffer();

      let statusLine: TerminalLine;
      let sessionStatus: TerminalSession["status"];
      switch (status) {
        case "completed":
          statusLine = makeLine("success", `✓ Process finished successfully (exit code ${exit_code ?? 0})`);
          sessionStatus = "completed";
          break;
        case "failed":
          statusLine = makeLine("error", `✕ Process exited with code ${exit_code ?? -1}`);
          sessionStatus = "failed";
          break;
        case "killed":
          statusLine = makeLine("warning", "■ Process was stopped by user");
          sessionStatus = "killed";
          break;
        default:
          statusLine = makeLine("system", `Process status: ${status}`);
          sessionStatus = "idle";
      }

      setSessions((prev) => {
        const mappedTabId = processTabRef.current.get(session_id);
        const finishedSession = prev.find((s) => s.activeSessionId === session_id || s.id === mappedTabId);
        const finishedTabId = finishedSession?.id || mappedTabId;
        if (finishedTabId) {
          completedProcessTabRef.current.set(session_id, finishedTabId);
          window.setTimeout(() => {
            completedProcessTabRef.current.delete(session_id);
            processTabRef.current.delete(session_id);
            streamedOutputRef.current.delete(session_id);
          }, 5000);
        }

        // Notify parent when a command fails (for proactive error detection)
        if (sessionStatus === "failed" && onCommandFailed && finishedSession) {
          const outputText = finishedSession.lines.map((l) => stripAnsi(l.text)).join("\n");
          setTimeout(() => onCommandFailed(finishedSession.activeCommand, outputText), 500);
        }
        if (finishedSession) {
          const outputText = finishedSession.lines.map((l) => stripAnsi(l.text)).join("\n");
          reportRunObservation(
            finishedSession.activeCommand,
            outputText,
            sessionStatus === "failed" ? "failed" : sessionStatus === "completed" ? "completed" : undefined
          );
        }

        return prev.map((s) =>
          s.activeSessionId === session_id || s.id === mappedTabId
            ? {
                ...s,
                lines: appendTerminalLines(s.lines, [statusLine]),
                running: false,
                activeCommand: "",
                activeSessionId: null,
                status: sessionStatus,
              }
            : s
        );
      });
    }).then((registeredUnlisten) => {
      if (cancelled) registeredUnlisten();
      else unlisten = registeredUnlisten;
    }).catch((err) => console.warn("Failed to register terminal-status listener:", err));

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [flushBuffer]);

  // Cleanup flush timer on unmount
  useEffect(() => {
    return () => {
      if (flushTimerRef.current !== null) {
        window.clearTimeout(flushTimerRef.current);
      }
    };
  }, []);

  // --- Tab management ---
  const addTab = () => {
    tabCounterRef.current += 1;
    const newSession = createSession(tabCounterRef.current, cwd);
    setSessions((prev) => [...prev, newSession]);
    setActiveTabId(newSession.id);
    setInput("");
  };

  const closeTab = (id: string) => {
    const session = sessions.find((s) => s.id === id);
    if (session?.activeSessionId) {
      stopTerminalProcess(session.activeSessionId).catch(() => {});
    }

    setSessions((prev) => {
      const filtered = prev.filter((s) => s.id !== id);
      if (filtered.length === 0) {
        // Always keep at least one tab
        tabCounterRef.current += 1;
        const newSession = createSession(tabCounterRef.current, cwd);
        setActiveTabId(newSession.id);
        return [newSession];
      }
      if (activeTabId === id) {
        setActiveTabId(filtered[filtered.length - 1].id);
      }
      return filtered;
    });
    setInput("");
  };

  // --- Command execution ---
  const handleSubmit = async () => {
    const cmd = input.trim();
    if (!cmd || !activeSession) return;

    if (cmd === "clear") {
      setSessions((prev) =>
        prev.map((s) => (s.id === activeTabId ? { ...s, lines: [] } : s))
      );
      setInput("");
      return;
    }

    const inputLine = makeLine("input", `PS> ${cmd}`);
    setSuggestion(null);

    setSessions((prev) =>
      prev.map((s) =>
        s.id === activeTabId
          ? {
              ...s,
              lines: appendTerminalLines(s.lines, [inputLine]),
              history: appendTerminalHistory(s.history, cmd),
              historyIdx: -1,
              running: true,
              activeCommand: cmd,
              status: "running" as const,
              // Auto-name tab after first command
              name: s.history.length === 0 ? shortName(cmd) : s.name,
            }
          : s
      )
    );
    setInput("");

    // Persist history
    const updatedHistory = [...(activeSession?.history || []), cmd];
    saveTerminalHistory(updatedHistory).catch(() => {});

    try {
      const processId = createProcessId(activeTabId);
      killedSessionsRef.current.delete(processId);
      bufferRef.current.delete(processId);
      streamedOutputRef.current.delete(processId);
      processTabRef.current.set(processId, activeTabId);
      setSessions((prev) =>
        prev.map((s) =>
          s.id === activeTabId ? { ...s, activeSessionId: processId } : s
        )
      );
      const sessionId = await startTerminalProcess(cmd, cwd, processId);
      if (sessionId !== processId) {
        processTabRef.current.delete(processId);
        processTabRef.current.set(sessionId, activeTabId);
        setSessions((prev) =>
          prev.map((s) =>
            s.id === activeTabId && s.activeSessionId === processId
              ? { ...s, activeSessionId: sessionId }
              : s
          )
        );
      }
      window.setTimeout(flushBuffer, 0);
    } catch (err) {
      const processIds = [...processTabRef.current.entries()]
        .filter(([, tabId]) => tabId === activeTabId)
        .map(([processId]) => processId);
      processIds.forEach((processId) => {
        processTabRef.current.delete(processId);
        bufferRef.current.delete(processId);
        streamedOutputRef.current.delete(processId);
      });
      setSessions((prev) =>
        prev.map((s) =>
          s.id === activeTabId
            ? {
                ...s,
                lines: appendTerminalLines(s.lines, [makeLine("error", `Error: ${err}`)]),
                running: false,
                activeCommand: "",
                status: "failed" as const,
              }
            : s
        )
      );
    }
  };

  const handleStop = async () => {
    if (activeSession?.activeSessionId) {
      const sessionId = activeSession.activeSessionId;

      // Immediately mark as killed in the UI so output stops appearing (B011 fix)
      killedSessionsRef.current.add(sessionId);
      bufferRef.current.delete(sessionId);

      // Update UI immediately to show stopped state
      setSessions((prev) =>
        prev.map((s) =>
          s.id === activeTabId
            ? { ...s, running: false, status: "killed", activeCommand: "", activeSessionId: null,
                lines: appendTerminalLines(s.lines, [makeLine("warning", "■ Process was stopped by user")]) }
            : s
        )
      );

      try {
        await stopTerminalProcess(sessionId);
      } catch (err) {
        setSessions((prev) =>
          prev.map((s) =>
            s.id === activeTabId
              ? { ...s, lines: appendTerminalLines(s.lines, [makeLine("error", `Failed to stop: ${err}`)]) }
              : s
          )
        );
      }
    }
  };

  // --- Keyboard handling ---
  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (!activeSession) return;

    if (e.key === "Enter") {
      handleSubmit();
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      const hist = activeSession.history;
      if (hist.length > 0) {
        const newIdx = activeSession.historyIdx < hist.length - 1
          ? activeSession.historyIdx + 1
          : activeSession.historyIdx;
        setSessions((prev) =>
          prev.map((s) => (s.id === activeTabId ? { ...s, historyIdx: newIdx } : s))
        );
        setInput(hist[hist.length - 1 - newIdx]);
      }
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      if (activeSession.historyIdx > 0) {
        const newIdx = activeSession.historyIdx - 1;
        setSessions((prev) =>
          prev.map((s) => (s.id === activeTabId ? { ...s, historyIdx: newIdx } : s))
        );
        setInput(activeSession.history[activeSession.history.length - 1 - newIdx]);
      } else {
        setSessions((prev) =>
          prev.map((s) => (s.id === activeTabId ? { ...s, historyIdx: -1 } : s))
        );
        setInput("");
      }
    } else if (e.key === "c" && e.ctrlKey) {
      if (activeSession.running) {
        e.preventDefault();
        handleStop();
      }
    }
  };

  // --- Render ---
  return (
    <div className="terminal" role="region" aria-label="Terminal" onClick={() => inputRef.current?.focus()}>
      {/* Tab bar */}
      <div className="terminal-tabs">
        {tabBarPrefix}
        {sessions.map((session) => (
          <div
            key={session.id}
            className={`terminal-tab ${session.id === activeTabId ? "active" : ""}`}
            onClick={() => { setActiveTabId(session.id); setInput(""); }}
          >
            <StatusBadge status={session.status} />
            <span className="terminal-tab-name">{session.name}</span>
            <button
              className="terminal-tab-close"
              onClick={(e) => { e.stopPropagation(); closeTab(session.id); }}
              aria-label={`Close ${session.name}`}
            >
              <X size={12} />
            </button>
          </div>
        ))}
        <button className="terminal-tab-add" onClick={addTab} title="New Terminal" aria-label="New terminal tab">
          <Plus size={14} />
        </button>
      </div>

      {/* Terminal output — virtualized */}
      <div className="terminal-output" ref={terminalOutputRef} onScroll={handleTerminalScroll}>
        {activeSession && (
          <>
            {activeSession.running && (
              <div className="terminal-status running">
                <StatusBadge status="running" />
                <span>Running: {activeSession.activeCommand}</span>
                <button
                  className="terminal-stop-btn"
                  onClick={handleStop}
                  title="Stop process (Ctrl+C)"
                  aria-label="Stop running process"
                >
                  ■ Stop
                </button>
              </div>
            )}
            <div
              className="terminal-lines-virtual"
              style={{ height: activeSession.lines.length * TERMINAL_LINE_HEIGHT, position: "relative" }}
            >
              {visibleLines.map(({ line, index }) => (
                <div
                  key={index}
                  className={`terminal-line ${line.type}`}
                  style={{ position: "absolute", top: index * TERMINAL_LINE_HEIGHT, left: 0, right: 0, height: TERMINAL_LINE_HEIGHT }}
                >
                  <pre><AnsiLine spans={line.spans} onOpenUrl={onOpenUrl} /></pre>
                  {line.type === "error" && onFixWithAi && activeSession.status === "failed" && (
                    <button
                      className="terminal-fix-ai-btn"
                      onClick={() => {
                        const errorContext = [
                          `Command: ${activeSession.activeCommand}`,
                          `Error: ${stripAnsi(line.text)}`,
                          "",
                          activeSession.lines
                            .slice(Math.max(0, index - 20), index + 1)
                            .map(l => stripAnsi(l.text))
                            .join("\n"),
                        ].join("\n");
                        onFixWithAi(errorContext);
                      }}
                      title="Fix this error with AI"
                      aria-label="Fix this error with AI"
                    >
                      ⚡ Fix
                    </button>
                  )}
                </div>
              ))}
            </div>
          </>
        )}
        <div className="terminal-input-line">
          {/* Smart suggestion bar */}
          {(suggestion || suggestionLoading) && (
            <div className="terminal-suggestion">
              <Lightbulb size={12} className="terminal-suggestion-icon" />
              {suggestionLoading
                ? <span className="terminal-suggestion-text muted">Thinking…</span>
                : (
                  <>
                    <span className="terminal-suggestion-text">Try: <code>{suggestion}</code></span>
                    <button
                      className="terminal-suggestion-run"
                      onClick={() => {
                        if (suggestion) { setInput(suggestion); setSuggestion(null); }
                      }}
                      title="Insert suggested command"
                    >
                      Use
                    </button>
                    <button
                      className="terminal-suggestion-dismiss"
                      onClick={() => setSuggestion(null)}
                      title="Dismiss"
                    >
                      <X size={10} />
                    </button>
                  </>
                )
              }
            </div>
          )}
          <span className="terminal-prompt">PS&gt;</span>
          <input
            ref={inputRef}
            type="text"
            className="terminal-input"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            disabled={activeSession?.running}
            placeholder={activeSession?.running ? "Running... (Ctrl+C to stop)" : "Type a command..."}
            spellCheck={false}
            autoComplete="off"
            aria-label="Terminal command input"
          />
          {!input && !activeSession?.running && <span className="terminal-cursor" aria-hidden="true" />}
        </div>
        <div ref={bottomRef} />
      </div>
    </div>
  );
}

// --- Status Badge Component ---

function StatusBadge({ status }: { status: TerminalSession["status"] }) {
  switch (status) {
    case "running":
      return <span className="terminal-badge running" title="Running">●</span>;
    case "completed":
      return <span className="terminal-badge completed" title="Completed">✓</span>;
    case "failed":
      return <span className="terminal-badge failed" title="Failed">✕</span>;
    case "killed":
      return <span className="terminal-badge killed" title="Killed">■</span>;
    default:
      return <span className="terminal-badge idle" title="Ready">○</span>;
  }
}

// --- Helpers ---

/** Generate a short tab name from a command */
function shortName(cmd: string): string {
  const parts = cmd.trim().split(/\s+/);
  // Use last meaningful part for common patterns
  if (parts[0] === "npm" && parts[1] === "run" && parts[2]) return parts[2];
  if (parts[0] === "npm" && parts[1]) return parts[1];
  if (parts[0] === "yarn" && parts[1]) return parts[1];
  if (parts[0] === "pnpm" && parts[1] === "run" && parts[2]) return parts[2];
  if (parts[0] === "cargo" && parts[1]) return parts[1];
  if (parts[0] === "python" || parts[0] === "node") return parts.slice(0, 2).join(" ");
  // Fallback: first 16 chars
  return cmd.length > 16 ? cmd.slice(0, 16) + "…" : cmd;
}
