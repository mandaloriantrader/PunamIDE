/**
 * InlineDiffPreview — Inline toolbar and overlay widgets for per-hunk
 * Accept/Reject actions on AI-generated diffs shown inside the Monaco editor.
 *
 * This is the UI layer; logic lives in `useInlineDiff` hook.
 *
 * Features:
 * - Floating toolbar showing hunk index/total, Accept/Reject for focused hunk, Dismiss All
 * - Unsaved changes warning banner when applicable
 * - Escape key dismisses the preview
 * - Tab/Shift+Tab navigates between hunks
 *
 * Requirements: 5.1, 5.2, 5.3, 5.5, 5.7
 */

import React, { useEffect, useCallback, useMemo } from "react";
import { Check, X, ChevronLeft, ChevronRight, AlertTriangle, XCircle } from "lucide-react";
import type { InlineDiffHunk } from "../hooks/useInlineDiff";
import { useEditorStore } from "../store/editorStore";

// ── Props ──────────────────────────────────────────────────────────────────────

interface Props {
  hunks: InlineDiffHunk[];
  onAcceptHunk: (hunkId: number) => void;
  onRejectHunk: (hunkId: number) => void;
  onDismissAll: () => void;
  /** Navigate to previous pending hunk (Shift+Tab) */
  onNavigatePrev?: () => void;
  /** Navigate to next pending hunk (Tab) */
  onNavigateNext?: () => void;
  /** Currently focused hunk index */
  focusedHunkIndex?: number;
  /** File path for unsaved changes check */
  activeFile?: string | null;
}

// ── Component ──────────────────────────────────────────────────────────────────

export default function InlineDiffPreview({
  hunks,
  onAcceptHunk,
  onRejectHunk,
  onDismissAll,
  onNavigatePrev,
  onNavigateNext,
  focusedHunkIndex = 0,
  activeFile,
}: Props): React.ReactElement | null {
  // ── Derived state ────────────────────────────────────────────────────────────

  const pendingHunks = useMemo(
    () => hunks.filter((h) => h.status === "pending"),
    [hunks]
  );

  const focusedHunk = hunks[focusedHunkIndex] ?? null;

  const currentPendingPosition = useMemo(() => {
    if (!focusedHunk || focusedHunk.status !== "pending") return 0;
    return pendingHunks.indexOf(focusedHunk) + 1;
  }, [pendingHunks, focusedHunk]);

  // Check for unsaved changes on the active file
  const hasUnsavedChanges = useEditorStore((s) => {
    if (!activeFile) return false;
    const tab = s.tabs.find((t) => t.path === activeFile);
    return tab?.modified ?? false;
  });

  // ── Keyboard handlers ────────────────────────────────────────────────────────

  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      // Escape → dismiss all
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        onDismissAll();
        return;
      }

      // Tab → next hunk, Shift+Tab → previous hunk
      if (e.key === "Tab") {
        e.preventDefault();
        e.stopPropagation();
        if (e.shiftKey) {
          onNavigatePrev?.();
        } else {
          onNavigateNext?.();
        }
        return;
      }
    },
    [onDismissAll, onNavigateNext, onNavigatePrev]
  );

  useEffect(() => {
    document.addEventListener("keydown", handleKeyDown, true);
    return () => {
      document.removeEventListener("keydown", handleKeyDown, true);
    };
  }, [handleKeyDown]);

  // ── Don't render if no pending hunks ─────────────────────────────────────────

  if (pendingHunks.length === 0) return null;

  // ── Render ───────────────────────────────────────────────────────────────────

  return (
    <div className="inline-diff-toolbar" role="toolbar" aria-label="Inline diff review">
      {/* Unsaved changes warning banner */}
      {hasUnsavedChanges && (
        <div className="inline-diff-warning" role="alert">
          <AlertTriangle size={14} />
          <span>Unsaved changes detected — save or discard before applying edits.</span>
        </div>
      )}

      {/* Main toolbar row */}
      <div className="inline-diff-toolbar-row">
        {/* Navigation: previous hunk */}
        <button
          type="button"
          className="inline-diff-btn inline-diff-nav-btn"
          onClick={onNavigatePrev}
          title="Previous hunk (Shift+Tab)"
          aria-label="Previous hunk"
          disabled={pendingHunks.length <= 1}
        >
          <ChevronLeft size={14} />
        </button>

        {/* Hunk counter */}
        <span className="inline-diff-counter" aria-live="polite">
          {currentPendingPosition} / {pendingHunks.length}
        </span>

        {/* Navigation: next hunk */}
        <button
          type="button"
          className="inline-diff-btn inline-diff-nav-btn"
          onClick={onNavigateNext}
          title="Next hunk (Tab)"
          aria-label="Next hunk"
          disabled={pendingHunks.length <= 1}
        >
          <ChevronRight size={14} />
        </button>

        {/* Separator */}
        <span className="inline-diff-separator" aria-hidden="true" />

        {/* Accept focused hunk */}
        <button
          type="button"
          className="inline-diff-btn inline-diff-accept-btn"
          onClick={() => focusedHunk && onAcceptHunk(focusedHunk.id)}
          title="Accept hunk (Enter)"
          aria-label="Accept current hunk"
          disabled={!focusedHunk || focusedHunk.status !== "pending"}
        >
          <Check size={14} />
          <span>Accept</span>
        </button>

        {/* Reject focused hunk */}
        <button
          type="button"
          className="inline-diff-btn inline-diff-reject-btn"
          onClick={() => focusedHunk && onRejectHunk(focusedHunk.id)}
          title="Reject hunk (Delete)"
          aria-label="Reject current hunk"
          disabled={!focusedHunk || focusedHunk.status !== "pending"}
        >
          <X size={14} />
          <span>Reject</span>
        </button>

        {/* Separator */}
        <span className="inline-diff-separator" aria-hidden="true" />

        {/* Dismiss all */}
        <button
          type="button"
          className="inline-diff-btn inline-diff-dismiss-btn"
          onClick={onDismissAll}
          title="Dismiss all (Escape)"
          aria-label="Dismiss all remaining hunks"
        >
          <XCircle size={14} />
          <span>Dismiss</span>
        </button>
      </div>
    </div>
  );
}
