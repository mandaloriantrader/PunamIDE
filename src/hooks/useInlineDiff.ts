/**
 * useInlineDiff — Inline diff preview hook for AI-generated code edits.
 *
 * Shows red/green inline diff in the Monaco editor with per-hunk Accept/Reject
 * actions, keyboard navigation, undo support, and file locking.
 *
 * Features:
 * - Computes hunks via `diff_strings` Tauri command
 * - Warns on unsaved changes before showing diff
 * - Creates Monaco decorations (red=removed, green=added) with glyph margin widgets
 * - Accept: pushes undo snapshot via pushEditOperations, applies only that hunk
 * - Reject: removes decorations without modifying content
 * - Escape: retains accepted changes, discards pending hunks
 * - Tab/Shift+Tab: cycles focused hunk with wrap, highlights with distinct border
 * - File lock via module-level Set<string> to block AI edits on locked files
 *
 * Requirements: 5.1, 5.2, 5.3, 5.4, 5.5, 5.6, 5.7
 */

import { useState, useCallback, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { editor as monacoEditor } from "monaco-editor";
import { useEditorStore } from "../store/editorStore";
import { showToast } from "../utils/toast";

// ── Types ──────────────────────────────────────────────────────────────────────

export interface InlineDiffHunk {
  id: number;
  filePath: string;
  startLine: number;
  endLine: number;
  oldLines: string[];
  newLines: string[];
  status: "pending" | "accepted" | "rejected";
}

export interface InlineDiffState {
  activeFile: string | null;
  hunks: InlineDiffHunk[];
  focusedHunkIndex: number;
  isLocked: boolean;
}

interface DiffLine {
  kind: "add" | "remove" | "context";
  content: string;
}

interface DiffHunkRaw {
  old_start: number;
  old_lines: number;
  new_start: number;
  new_lines: number;
  lines: DiffLine[];
}

interface DiffResult {
  hunks: DiffHunkRaw[];
  additions: number;
  deletions: number;
}

// ── Module-level file lock ─────────────────────────────────────────────────────

/**
 * Module-level set of file paths currently locked for diff preview.
 * Other parts of the codebase can import and check this before submitting AI edits.
 */
export const lockedForDiffPreview = new Set<string>();

/**
 * Check whether a file is currently locked for diff preview.
 * AI edit submission paths should call this before applying changes.
 */
export function isFileLockedForDiff(filePath: string): boolean {
  return lockedForDiffPreview.has(filePath);
}

// ── Decoration tracking ────────────────────────────────────────────────────────

interface DecorationEntry {
  hunkId: number;
  decorationIds: string[];
}

// ── Hook ───────────────────────────────────────────────────────────────────────

export function useInlineDiff() {
  const [state, setState] = useState<InlineDiffState>({
    activeFile: null,
    hunks: [],
    focusedHunkIndex: 0,
    isLocked: false,
  });

  // References to editor instance and decoration tracking
  const editorRef = useRef<monacoEditor.IStandaloneCodeEditor | null>(null);
  const decorationsRef = useRef<DecorationEntry[]>([]);
  const hunkIdCounter = useRef(0);

  /**
   * Set the Monaco editor instance for decoration management.
   * Must be called before showDiff.
   */
  const setEditorInstance = useCallback((editor: monacoEditor.IStandaloneCodeEditor | null) => {
    editorRef.current = editor;
  }, []);

  /**
   * Show inline diff for a file, computing hunks from old/new content.
   * Warns if the file has unsaved changes.
   */
  const showDiff = useCallback(async (filePath: string, oldContent: string, newContent: string) => {
    // Check for unsaved changes
    const tabs = useEditorStore.getState().tabs;
    const tab = tabs.find((t) => t.path === filePath);
    if (tab?.modified) {
      showToast(
        `File "${tab.name}" has unsaved changes. Save or discard before viewing diff.`,
        "warning"
      );
      return;
    }

    // Compute diff hunks via Tauri
    let diffResult: DiffResult;
    try {
      diffResult = await invoke<DiffResult>("diff_strings", { oldText: oldContent, newText: newContent });
    } catch (err) {
      console.error("[useInlineDiff] diff_strings failed:", err);
      showToast("Failed to compute diff. Try again.", "error");
      return;
    }

    // Convert raw hunks to InlineDiffHunk format
    const hunks: InlineDiffHunk[] = diffResult.hunks
      .filter((h) => h.lines.some((l) => l.kind !== "context"))
      .map((rawHunk) => {
        const id = ++hunkIdCounter.current;
        const oldLines: string[] = [];
        const newLines: string[] = [];

        for (const line of rawHunk.lines) {
          if (line.kind === "remove") {
            oldLines.push(line.content);
          } else if (line.kind === "add") {
            newLines.push(line.content);
          }
        }

        return {
          id,
          filePath,
          startLine: rawHunk.old_start,
          endLine: rawHunk.old_start + rawHunk.old_lines - 1,
          oldLines,
          newLines,
          status: "pending" as const,
        };
      });

    if (hunks.length === 0) {
      showToast("No differences found.", "info");
      return;
    }

    // Lock the file
    lockedForDiffPreview.add(filePath);

    setState({
      activeFile: filePath,
      hunks,
      focusedHunkIndex: 0,
      isLocked: true,
    });

    // Apply Monaco decorations
    applyDecorations(hunks, 0);
  }, []);

  /**
   * Apply Monaco decorations for all pending hunks.
   * Adds red background for removed lines, green for added lines,
   * and a distinct border for the focused hunk.
   */
  function applyDecorations(hunks: InlineDiffHunk[], focusedIndex: number): void {
    const ed = editorRef.current;
    if (!ed) return;

    // Clear existing decorations
    clearAllDecorations();

    const newDecorationEntries: DecorationEntry[] = [];

    for (let i = 0; i < hunks.length; i++) {
      const hunk = hunks[i];
      if (hunk.status !== "pending") continue;

      const isFocused = i === focusedIndex;
      const decorations: monacoEditor.IModelDeltaDecoration[] = [];

      // Red decoration for removed lines (existing lines that will be replaced)
      if (hunk.oldLines.length > 0 && hunk.startLine > 0) {
        const endLine = Math.min(hunk.endLine, hunk.startLine + hunk.oldLines.length - 1);
        decorations.push({
          range: {
            startLineNumber: hunk.startLine,
            startColumn: 1,
            endLineNumber: endLine,
            endColumn: Number.MAX_SAFE_INTEGER,
          },
          options: {
            isWholeLine: true,
            className: isFocused
              ? "inline-diff-removed inline-diff-focused"
              : "inline-diff-removed",
            glyphMarginClassName: "inline-diff-glyph-removed",
            overviewRuler: {
              color: "#ff000080",
              position: 4, // OverviewRulerLane.Full
            },
          },
        });
      }

      // Green decoration for added lines (shown after the removed block)
      if (hunk.newLines.length > 0) {
        const insertLine = hunk.endLine > 0 ? hunk.endLine : hunk.startLine;
        decorations.push({
          range: {
            startLineNumber: insertLine,
            startColumn: 1,
            endLineNumber: insertLine,
            endColumn: Number.MAX_SAFE_INTEGER,
          },
          options: {
            isWholeLine: true,
            className: isFocused
              ? "inline-diff-added inline-diff-focused"
              : "inline-diff-added",
            glyphMarginClassName: "inline-diff-glyph-added",
            afterContentClassName: "inline-diff-new-content",
            overviewRuler: {
              color: "#00ff0080",
              position: 4,
            },
          },
        });
      }

      // Apply decorations to the editor
      const ids = ed.deltaDecorations([], decorations);
      newDecorationEntries.push({ hunkId: hunk.id, decorationIds: ids });
    }

    decorationsRef.current = newDecorationEntries;
  }

  /**
   * Clear all decorations from the editor.
   */
  function clearAllDecorations(): void {
    const ed = editorRef.current;
    if (!ed) return;

    const allIds = decorationsRef.current.flatMap((e) => e.decorationIds);
    if (allIds.length > 0) {
      ed.deltaDecorations(allIds, []);
    }
    decorationsRef.current = [];
  }

  /**
   * Clear decorations for a specific hunk.
   */
  function clearHunkDecorations(hunkId: number): void {
    const ed = editorRef.current;
    if (!ed) return;

    const entry = decorationsRef.current.find((e) => e.hunkId === hunkId);
    if (entry) {
      ed.deltaDecorations(entry.decorationIds, []);
      decorationsRef.current = decorationsRef.current.filter((e) => e.hunkId !== hunkId);
    }
  }

  /**
   * Check if all hunks are resolved (accepted or rejected) and unlock file if so.
   */
  function checkAndUnlock(hunks: InlineDiffHunk[], filePath: string): void {
    const allResolved = hunks.every((h) => h.status !== "pending");
    if (allResolved) {
      lockedForDiffPreview.delete(filePath);
      clearAllDecorations();
      setState({
        activeFile: null,
        hunks: [],
        focusedHunkIndex: 0,
        isLocked: false,
      });
    }
  }

  /**
   * Accept a hunk: push undo snapshot via pushEditOperations, apply only
   * that hunk's changes to the model, remove its decorations.
   */
  const acceptHunk = useCallback((hunkId: number) => {
    const ed = editorRef.current;
    if (!ed) return;

    setState((prev) => {
      const hunkIndex = prev.hunks.findIndex((h) => h.id === hunkId);
      if (hunkIndex === -1) return prev;

      const hunk = prev.hunks[hunkIndex];
      if (hunk.status !== "pending") return prev;

      const model = ed.getModel();
      if (!model) return prev;

      // Use pushEditOperations to create an undo snapshot and apply the hunk
      const range = {
        startLineNumber: hunk.startLine,
        startColumn: 1,
        endLineNumber: hunk.endLine,
        endColumn: model.getLineMaxColumn(Math.min(hunk.endLine, model.getLineCount())),
      };

      const newText = hunk.newLines.join("\n");

      model.pushEditOperations(
        [], // no cursor state needed
        [{ range, text: newText }],
        () => null // no inverse cursor needed
      );

      // Update hunk status
      const updatedHunks = prev.hunks.map((h) =>
        h.id === hunkId ? { ...h, status: "accepted" as const } : h
      );

      // Adjust line numbers for subsequent hunks based on the line count change
      const lineDelta = hunk.newLines.length - hunk.oldLines.length;
      const adjustedHunks = updatedHunks.map((h) => {
        if (h.id !== hunkId && h.startLine > hunk.endLine && h.status === "pending") {
          return {
            ...h,
            startLine: h.startLine + lineDelta,
            endLine: h.endLine + lineDelta,
          };
        }
        return h;
      });

      // Clear decorations for this hunk
      clearHunkDecorations(hunkId);

      // Determine new focused index
      const pendingHunks = adjustedHunks.filter((h) => h.status === "pending");
      const newFocusedIndex = pendingHunks.length > 0
        ? adjustedHunks.indexOf(pendingHunks[0])
        : 0;

      const newState = {
        ...prev,
        hunks: adjustedHunks,
        focusedHunkIndex: newFocusedIndex,
      };

      // Check if all resolved
      checkAndUnlock(adjustedHunks, prev.activeFile || "");

      // Re-apply decorations for remaining pending hunks
      if (pendingHunks.length > 0) {
        setTimeout(() => applyDecorations(adjustedHunks, newFocusedIndex), 0);
      }

      return newState;
    });
  }, []);

  /**
   * Reject a hunk: remove decorations without modifying content.
   */
  const rejectHunk = useCallback((hunkId: number) => {
    setState((prev) => {
      const hunkIndex = prev.hunks.findIndex((h) => h.id === hunkId);
      if (hunkIndex === -1) return prev;

      const hunk = prev.hunks[hunkIndex];
      if (hunk.status !== "pending") return prev;

      // Clear decorations for this hunk
      clearHunkDecorations(hunkId);

      // Update hunk status
      const updatedHunks = prev.hunks.map((h) =>
        h.id === hunkId ? { ...h, status: "rejected" as const } : h
      );

      // Determine new focused index
      const pendingHunks = updatedHunks.filter((h) => h.status === "pending");
      const newFocusedIndex = pendingHunks.length > 0
        ? updatedHunks.indexOf(pendingHunks[0])
        : 0;

      const newState = {
        ...prev,
        hunks: updatedHunks,
        focusedHunkIndex: newFocusedIndex,
      };

      // Check if all resolved
      checkAndUnlock(updatedHunks, prev.activeFile || "");

      // Re-apply decorations for remaining pending hunks
      if (pendingHunks.length > 0) {
        setTimeout(() => applyDecorations(updatedHunks, newFocusedIndex), 0);
      }

      return newState;
    });
  }, []);

  /**
   * Dismiss all: retain accepted changes (already applied), discard pending hunks.
   * Triggered by Escape key.
   */
  const dismissAll = useCallback(() => {
    setState((prev) => {
      if (!prev.activeFile) return prev;

      // Clear all decorations
      clearAllDecorations();

      // Unlock file
      lockedForDiffPreview.delete(prev.activeFile);

      return {
        activeFile: null,
        hunks: [],
        focusedHunkIndex: 0,
        isLocked: false,
      };
    });
  }, []);

  /**
   * Navigate to the next pending hunk (Tab). Wraps from last to first.
   */
  const navigateNext = useCallback(() => {
    setState((prev) => {
      const pendingIndices = prev.hunks
        .map((h, i) => (h.status === "pending" ? i : -1))
        .filter((i) => i !== -1);

      if (pendingIndices.length === 0) return prev;

      const currentPendingPos = pendingIndices.indexOf(prev.focusedHunkIndex);
      let nextPos: number;

      if (currentPendingPos === -1) {
        // Current focus is not on a pending hunk, go to first pending
        nextPos = 0;
      } else {
        // Wrap from last to first
        nextPos = (currentPendingPos + 1) % pendingIndices.length;
      }

      const newFocusedIndex = pendingIndices[nextPos];

      // Re-apply decorations with new focus
      applyDecorations(prev.hunks, newFocusedIndex);

      // Scroll to the focused hunk
      const focusedHunk = prev.hunks[newFocusedIndex];
      if (focusedHunk && editorRef.current) {
        editorRef.current.revealLineInCenter(focusedHunk.startLine);
      }

      return { ...prev, focusedHunkIndex: newFocusedIndex };
    });
  }, []);

  /**
   * Navigate to the previous pending hunk (Shift+Tab). Wraps from first to last.
   */
  const navigatePrev = useCallback(() => {
    setState((prev) => {
      const pendingIndices = prev.hunks
        .map((h, i) => (h.status === "pending" ? i : -1))
        .filter((i) => i !== -1);

      if (pendingIndices.length === 0) return prev;

      const currentPendingPos = pendingIndices.indexOf(prev.focusedHunkIndex);
      let prevPos: number;

      if (currentPendingPos === -1) {
        // Current focus is not on a pending hunk, go to last pending
        prevPos = pendingIndices.length - 1;
      } else {
        // Wrap from first to last
        prevPos = (currentPendingPos - 1 + pendingIndices.length) % pendingIndices.length;
      }

      const newFocusedIndex = pendingIndices[prevPos];

      // Re-apply decorations with new focus
      applyDecorations(prev.hunks, newFocusedIndex);

      // Scroll to the focused hunk
      const focusedHunk = prev.hunks[newFocusedIndex];
      if (focusedHunk && editorRef.current) {
        editorRef.current.revealLineInCenter(focusedHunk.startLine);
      }

      return { ...prev, focusedHunkIndex: newFocusedIndex };
    });
  }, []);

  return {
    state,
    showDiff,
    acceptHunk,
    rejectHunk,
    dismissAll,
    navigateNext,
    navigatePrev,
    setEditorInstance,
  };
}
