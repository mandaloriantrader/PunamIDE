/**
 * InlineEditWidget — Cursor-style Ctrl+K floating AI edit bar.
 * Shows a red/green diff preview BEFORE applying changes.
 * Renders as an absolutely-positioned overlay inside the editor container,
 * anchored just below the current cursor / selection end line.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { Check, Loader2, Pencil, RefreshCw, Undo2, X } from "lucide-react";
import { sendToProviderStreaming } from "../utils/providers";
import type { AIProviderConfig } from "../utils/providers";
import { getDiffLines } from "../utils/diffLines";

export interface InlineEditPosition {
  top: number;       // px from editor viewport top
  left: number;      // px from editor viewport left
  lineHeight: number;
}

export interface InlineEditSelectionRange {
  startLineNumber: number;
  startColumn: number;
  endLineNumber: number;
  endColumn: number;
}

interface Props {
  position: InlineEditPosition;
  selectedCode: string;
  prefixContext: string;
  suffixContext: string;
  language: string;
  aiProviders: AIProviderConfig[];
  multiCursorCount?: number;
  onApply: (code: string) => void;
  onRevert: () => void;
  onDismiss: () => void;
}

const INLINE_EDIT_SYSTEM_PROMPT = `You are a precise inline code editor.
Rules (CRITICAL):
- Output ONLY the replacement code, nothing else
- No markdown fences, no backticks, no explanations
- Preserve the original indentation exactly — do not add or remove leading spaces
- Match the existing coding style (naming, spacing, semicolons, quotes)
- Only change what the instruction requests — leave everything else exactly as-is
- If the instruction is to add something (e.g. error handling), add it inline without restructuring unrelated code
- The output will be inserted verbatim — any extra text will corrupt the file`;

export default function InlineEditWidget({
  position,
  selectedCode,
  prefixContext,
  suffixContext,
  language,
  aiProviders,
  multiCursorCount = 0,
  onApply,
  onRevert,
  onDismiss,
}: Props) {
  const [prompt, setPrompt] = useState("");
  const [loading, setLoading] = useState(false);
  const [proposed, setProposed] = useState<string | null>(null);
  const [applied, setApplied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Auto-focus the input on mount
  useEffect(() => {
    const frame = requestAnimationFrame(() => inputRef.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, []);

  // Escape key dismisses (capture phase so it fires before Monaco's handler)
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        e.preventDefault();
        onDismiss();
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [onDismiss]);

  // Compute diff lines when proposed code is available
  const diffLines = useMemo(() => {
    if (proposed === null) return [];
    return getDiffLines(selectedCode, proposed);
  }, [selectedCode, proposed]);

  const diffStats = useMemo(() => {
    let additions = 0, deletions = 0;
    for (const line of diffLines) {
      if (!line.changed) continue;
      if (line.original && !line.proposed) deletions++;
      else if (!line.original && line.proposed) additions++;
      else { additions++; deletions++; }
    }
    return { additions, deletions };
  }, [diffLines]);

  const handleSend = async () => {
    if (!prompt.trim() || loading) return;

    const provider = aiProviders.find((p) => p.apiKey && p.models.some((m) => m.enabled));
    if (!provider) {
      setError("No AI provider configured. Add one in Settings.");
      return;
    }
    const model = provider.models.find((m) => m.enabled);
    if (!model) {
      setError("No model enabled. Check Settings → Providers.");
      return;
    }

    setLoading(true);
    setProposed(null);
    setApplied(false);
    setError(null);

    const isMulti = multiCursorCount > 1;
    const userPrompt = isMulti
      ? `Language: ${language}\n\n` +
        `You have ${multiCursorCount} selected code snippets, each separated by "---".\n` +
        `Apply the instruction to EACH snippet independently.\n` +
        `Return the ${multiCursorCount} edited snippets in the SAME order, each separated by exactly:\n---\n\n` +
        `Snippets:\n${selectedCode}\n\n` +
        `Instruction: ${prompt}\n\n` +
        `Output ONLY the ${multiCursorCount} edited snippets separated by ---`
      : `Language: ${language}\n\n` +
        `Code before the selection (context only — do NOT output this):\n` +
        `\`\`\`\n${prefixContext.slice(-1200)}\n\`\`\`\n\n` +
        `Code to edit (THIS is the only thing you output the replacement for):\n` +
        `\`\`\`\n${selectedCode}\n\`\`\`\n\n` +
        `Code after the selection (context only — do NOT output this):\n` +
        `\`\`\`\n${suffixContext.slice(0, 400)}\n\`\`\`\n\n` +
        `Instruction: ${prompt}\n\n` +
        `Output ONLY the replacement for the "Code to edit" block above.`;

    try {
      const resp = await sendToProviderStreaming(provider, model.id, {
        systemPrompt: INLINE_EDIT_SYSTEM_PROMPT,
        userPrompt,
      });

      if (resp.success) {
        // Strip markdown fences if the model added them anyway
        const cleaned = resp.text
          .replace(/^```[\w]*\r?\n?/, "")
          .replace(/\r?\n?```$/, "")
          .trimEnd(); // preserve leading indent, trim trailing newline
        setProposed(cleaned);
      } else {
        setError(resp.error || "Unknown error");
      }
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const handleAccept = () => {
    if (proposed !== null) {
      onApply(proposed);
      setApplied(true);
    }
  };

  const handleRevert = () => {
    onRevert();
    setApplied(false);
    // Keep proposed visible so user can re-accept if needed
  };

  const handleRetry = () => {
    setProposed(null);
    setApplied(false);
    setError(null);
    inputRef.current?.focus();
  };

  // Preview first 3 lines of selected code
  const previewLines = selectedCode.split("\n");
  const previewText =
    previewLines.slice(0, 3).join("\n") +
    (previewLines.length > 3 ? `\n… (+${previewLines.length - 3} lines)` : "");

  return (
    <div
      className="iew-container"
      style={{
        top: position.top + position.lineHeight + 4,
        left: Math.max(60, position.left),
      }}
      // Prevent keystrokes from leaking into the Monaco editor
      onKeyDown={(e) => e.stopPropagation()}
      onKeyUp={(e) => e.stopPropagation()}
    >
      {/* ── Input row ── */}
      <div className="iew-input-row">
        <Pencil size={12} className="iew-icon" aria-hidden />
        {multiCursorCount > 1 && (
          <span className="iew-multi-badge" title={`Editing ${multiCursorCount} selections simultaneously`}>
            ×{multiCursorCount}
          </span>
        )}
        <input
          ref={inputRef}
          className="iew-input"
          placeholder="Edit with Punam…  e.g. make this async, add null check"
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          onKeyDown={handleKeyDown}
          disabled={loading || applied}
          aria-label="Inline edit instruction"
          spellCheck={false}
        />
        {loading ? (
          <Loader2 size={14} className="iew-spinner" aria-label="Generating…" />
        ) : (
          <button
            className="iew-btn iew-send"
            onClick={handleSend}
            disabled={!prompt.trim() || applied}
            title="Apply instruction (Enter)"
            aria-label="Send"
          >
            <Check size={13} />
          </button>
        )}
        <button
          className="iew-btn iew-close"
          onClick={onDismiss}
          title="Dismiss (Escape)"
          aria-label="Dismiss inline editor"
        >
          <X size={13} />
        </button>
      </div>

      {/* ── Selected code preview (only before AI responds) ── */}
      {!proposed && !error && !loading && selectedCode.trim() && (
        <div className="iew-preview">
          <span className="iew-preview-label">Editing:</span>
          <pre className="iew-preview-code">{previewText}</pre>
        </div>
      )}

      {/* ── Loading indicator ── */}
      {loading && (
        <div className="iew-loading-hint">
          <Loader2 size={11} className="iew-spinner" />
          <span>Generating…</span>
        </div>
      )}

      {/* ── Error ── */}
      {error && !loading && (
        <div className="iew-error">
          <span>⚠️ {error}</span>
          <button className="iew-btn iew-close" onClick={handleRetry} title="Retry">
            <RefreshCw size={12} />
          </button>
        </div>
      )}

      {/* ── Diff preview (red/green) ── */}
      {proposed !== null && !loading && (
        <div className="iew-result">
          <div className="iew-result-header">
            <span className="iew-result-label">
              {applied ? "Applied" : "Preview"}
              {diffStats.additions > 0 && <span className="iew-diff-stat iew-stat-add">+{diffStats.additions}</span>}
              {diffStats.deletions > 0 && <span className="iew-diff-stat iew-stat-del">-{diffStats.deletions}</span>}
            </span>
            <div className="iew-result-actions">
              {!applied ? (
                <>
                  <button className="iew-btn iew-accept" onClick={handleAccept} title="Accept change (Tab)">
                    <Check size={12} /> Accept
                  </button>
                  <button className="iew-btn iew-retry" onClick={handleRetry} title="Retry with different prompt">
                    <RefreshCw size={12} /> Retry
                  </button>
                </>
              ) : (
                <button className="iew-btn iew-revert" onClick={handleRevert} title="Undo this edit (Ctrl+Z)">
                  <Undo2 size={12} /> Revert
                </button>
              )}
              <button className="iew-btn iew-close" onClick={onDismiss} title="Close">
                <X size={12} />
              </button>
            </div>
          </div>
          <div className="iew-diff-view" role="region" aria-label="Diff preview">
            {diffLines.map((line) => {
              if (!line.changed) {
                // Context line — unchanged
                return (
                  <div key={line.id} className="iew-diff-line iew-diff-ctx">
                    <span className="iew-diff-marker"> </span>
                    <span className="iew-diff-content">{line.original || " "}</span>
                  </div>
                );
              }
              // Changed lines — show removal and addition
              return (
                <div key={line.id} className="iew-diff-line-group">
                  {line.original && (
                    <div className="iew-diff-line iew-diff-del">
                      <span className="iew-diff-marker">-</span>
                      <span className="iew-diff-content">{line.original}</span>
                    </div>
                  )}
                  {line.proposed && (
                    <div className="iew-diff-line iew-diff-add">
                      <span className="iew-diff-marker">+</span>
                      <span className="iew-diff-content">{line.proposed}</span>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
