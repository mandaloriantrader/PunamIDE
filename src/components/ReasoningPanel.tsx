/**
 * ReasoningPanel — Displays the agent's chain-of-thought reasoning
 * in a collapsible panel below the chat area.
 * Requirements: 11.1, 11.2, 11.3, 11.4, 11.6
 */
import React, { useRef, useEffect } from "react";
import type { ReasoningChunk, CodeReference } from "../store/backgroundAgentStore";

// ─── Phase Configuration ────────────────────────────────────────────────────────

const PHASE_COLORS: Record<ReasoningChunk["phase"], { bg: string; text: string; border: string }> = {
  analysis: { bg: "rgba(96, 165, 250, 0.1)", text: "#60a5fa", border: "#60a5fa" },
  planning: { bg: "rgba(167, 139, 250, 0.1)", text: "#a78bfa", border: "#a78bfa" },
  execution: { bg: "rgba(74, 222, 128, 0.1)", text: "#4ade80", border: "#4ade80" },
};

const PHASE_ICONS: Record<ReasoningChunk["phase"], string> = {
  analysis: "🔍", planning: "📐", execution: "⚡",
};

const PHASE_LABELS: Record<ReasoningChunk["phase"], string> = {
  analysis: "Analysis", planning: "Planning", execution: "Execution",
};

// ─── Code Reference Extraction ──────────────────────────────────────────────────

/** Extracts code references from reasoning text. Detects `file.ts:42` and `[REF:path:line-line]`. */
export function extractCodeReferences(content: string): CodeReference[] {
  const refs: CodeReference[] = [];
  const fileLinePattern = /([a-zA-Z_\/\\\.\-]+\.(ts|tsx|js|jsx|rs|py)):(\d+)(?:-(\d+))?/g;
  let match;
  while ((match = fileLinePattern.exec(content)) !== null) {
    refs.push({
      filePath: match[1],
      startLine: parseInt(match[3], 10),
      endLine: match[4] ? parseInt(match[4], 10) : parseInt(match[3], 10),
    });
  }
  const refPattern = /\[REF:([^\]]+):(\d+)(?:-(\d+))?\]/g;
  while ((match = refPattern.exec(content)) !== null) {
    refs.push({
      filePath: match[1],
      startLine: parseInt(match[2], 10),
      endLine: match[3] ? parseInt(match[3], 10) : parseInt(match[2], 10),
    });
  }
  return refs;
}

// ─── Content Renderer with Clickable References ─────────────────────────────────

function ContentWithRefs({ content, onClickReference }: { content: string; onClickReference: (ref: CodeReference) => void }) {
  const pattern = /([a-zA-Z_\/\\\.\-]+\.(ts|tsx|js|jsx|rs|py)):(\d+)(?:-(\d+))?|\[REF:([^\]]+):(\d+)(?:-(\d+))?\]/g;
  const parts: Array<{ text: string; ref?: CodeReference }> = [];
  let lastIndex = 0;
  let match;

  while ((match = pattern.exec(content)) !== null) {
    if (match.index > lastIndex) parts.push({ text: content.slice(lastIndex, match.index) });
    const ref: CodeReference = match[5]
      ? { filePath: match[5], startLine: parseInt(match[6], 10), endLine: match[7] ? parseInt(match[7], 10) : parseInt(match[6], 10) }
      : { filePath: match[1], startLine: parseInt(match[3], 10), endLine: match[4] ? parseInt(match[4], 10) : parseInt(match[3], 10) };
    parts.push({ text: match[0], ref });
    lastIndex = match.index + match[0].length;
  }
  if (lastIndex < content.length) parts.push({ text: content.slice(lastIndex) });

  return (
    <span>
      {parts.map((part, i) =>
        part.ref ? (
          <span
            key={i}
            onClick={() => onClickReference(part.ref!)}
            style={{ cursor: "pointer", textDecoration: "underline", fontFamily: "monospace", color: "#93c5fd" }}
            title={`Open ${part.ref.filePath}:${part.ref.startLine}`}
          >
            {part.text}
          </span>
        ) : (
          <span key={i}>{part.text}</span>
        )
      )}
    </span>
  );
}

// ─── Props & Helpers ────────────────────────────────────────────────────────────

interface Props {
  chunks: ReasoningChunk[];
  mode: "compact" | "expanded";
  visible: boolean;
  phaseTimings: Map<string, { startedAt: number; elapsedMs: number }>;
  onToggleMode: () => void;
  onClickReference: (ref: CodeReference) => void;
  onClose: () => void;
}

function formatElapsedTime(timing: { startedAt: number; elapsedMs: number } | undefined): string {
  if (!timing) return "";
  return timing.elapsedMs <= 0 ? "(ongoing...)" : `(${(timing.elapsedMs / 1000).toFixed(1)}s)`;
}

// ─── Component ──────────────────────────────────────────────────────────────────

export default function ReasoningPanel(props: Props): React.ReactElement | null {
  const { chunks, mode, visible, phaseTimings, onToggleMode, onClickReference, onClose } = props;
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (mode === "expanded" && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [chunks, mode]);

  if (!visible) return null;

  // Group chunks by phase for compact mode
  const grouped = new Map<ReasoningChunk["phase"], ReasoningChunk[]>();
  for (const chunk of chunks) {
    const arr = grouped.get(chunk.phase) || [];
    arr.push(chunk);
    grouped.set(chunk.phase, arr);
  }

  return (
    <div className="flex flex-col border-t border-gray-700/50" style={{ maxHeight: "300px" }}>
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-1.5 bg-gray-900/50 border-b border-gray-700/50">
        <span className="text-xs font-medium text-gray-300">Reasoning</span>
        <div className="flex items-center gap-2">
          <button
            onClick={onToggleMode}
            className="text-[10px] px-2 py-0.5 rounded bg-gray-700/50 text-gray-400 hover:text-gray-200 hover:bg-gray-600/50 transition-colors"
          >
            {mode === "compact" ? "Expand" : "Compact"}
          </button>
          <button onClick={onClose} className="text-gray-500 hover:text-gray-200 transition-colors" title="Close">
            ×
          </button>
        </div>
      </div>

      {/* Content */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto px-3 py-2 space-y-1" style={{ maxHeight: "260px" }}>
        {mode === "compact" ? (
          <div className="space-y-1">
            {(["analysis", "planning", "execution"] as const).map((phase) => {
              if (!grouped.get(phase)?.length) return null;
              const colors = PHASE_COLORS[phase];
              return (
                <div
                  key={phase}
                  className="flex items-center gap-2 px-2 py-1 rounded text-xs"
                  style={{ backgroundColor: colors.bg, borderLeft: `3px solid ${colors.border}` }}
                >
                  <span>{PHASE_ICONS[phase]}</span>
                  <span style={{ color: colors.text }} className="font-medium">{PHASE_LABELS[phase]}</span>
                  <span className="text-gray-500 text-[10px]">{formatElapsedTime(phaseTimings.get(phase))}</span>
                </div>
              );
            })}
          </div>
        ) : (
          <div className="space-y-1.5">
            {chunks.map((chunk) => {
              const colors = PHASE_COLORS[chunk.phase];
              return (
                <div
                  key={chunk.id}
                  className="px-2 py-1.5 rounded text-xs whitespace-pre-wrap"
                  style={{ backgroundColor: colors.bg, borderLeft: `3px solid ${colors.border}`, color: "#e5e7eb" }}
                >
                  <ContentWithRefs content={chunk.content} onClickReference={onClickReference} />
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
