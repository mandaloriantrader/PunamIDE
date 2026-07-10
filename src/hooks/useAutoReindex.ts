/**
 * useAutoReindex — Automatic AST re-indexing on file save.
 *
 * Subscribes to editorStore tab save events (modified → false transitions)
 * and triggers incremental symbol index + call graph rebuilds via Rust commands.
 *
 * Features:
 * - Debounced symbol rebuild (300ms) and call graph rebuild (1500ms)
 * - AbortController-keyed map for cancellation on rapid saves
 * - Retry once on failure after 3s, then set status to "error"
 * - Listens for Tauri `fs-changed` event with kind "remove" to clear entries
 * - Updates aiStore.astIndexStatus for UI status indicator
 *
 * Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 1.7
 */

import { useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { useEditorStore, type EditorTab } from "../store/editorStore";
import { useAIStore } from "../store/aiStore";
import { showToast } from "../utils/toast";

// ── Types ──────────────────────────────────────────────────────────────────────

interface FsChangePayload {
  paths: string[];
  kind: string; // "create" | "modify" | "remove" | "any"
}

interface InFlightEntry {
  controller: AbortController;
  symbolTimer: ReturnType<typeof setTimeout> | null;
  callgraphTimer: ReturnType<typeof setTimeout> | null;
}

// ── Constants ──────────────────────────────────────────────────────────────────

const SYMBOL_DEBOUNCE_MS = 300;
const CALLGRAPH_DEBOUNCE_MS = 1500;
const RETRY_DELAY_MS = 3000;

// ── Hook ───────────────────────────────────────────────────────────────────────

export function useAutoReindex(): void {
  const inFlightRef = useRef<Map<string, InFlightEntry>>(new Map());
  const retryingRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    const inFlight = inFlightRef.current;
    const retrying = retryingRef.current;

    /**
     * Cancel any in-flight operations for a given file path.
     * Clears debounce timers and aborts the AbortController.
     */
    function cancelInFlight(filePath: string): void {
      const entry = inFlight.get(filePath);
      if (entry) {
        if (entry.symbolTimer) clearTimeout(entry.symbolTimer);
        if (entry.callgraphTimer) clearTimeout(entry.callgraphTimer);
        entry.controller.abort();
        inFlight.delete(filePath);
      }
    }

    /**
     * Trigger re-indexing for a saved file.
     * Debounces symbol rebuild (300ms) and call graph rebuild (1500ms).
     */
    function triggerReindex(filePath: string, content: string, isRetry = false): void {
      // Cancel any previous in-flight work for this file
      cancelInFlight(filePath);

      const controller = new AbortController();
      const signal = controller.signal;

      // Track completion of both operations
      let symbolDone = false;
      let callgraphDone = false;
      let symbolError: unknown = null;
      let callgraphError: unknown = null;

      function checkCompletion(): void {
        if (!symbolDone || !callgraphDone) return;
        if (signal.aborted) return;

        // Clean up the in-flight entry
        inFlight.delete(filePath);

        if (symbolError || callgraphError) {
          const errorMsg = symbolError || callgraphError;
          console.error(`[useAutoReindex] Reindex failed for ${filePath}:`, errorMsg);

          if (!isRetry && !retrying.has(filePath)) {
            // Retry once after 3s
            retrying.add(filePath);
            showToast(`Indexing failed for ${filePath.split(/[\\/]/).pop()}, retrying...`, "warning");

            setTimeout(() => {
              retrying.delete(filePath);
              if (!signal.aborted) {
                triggerReindex(filePath, content, true);
              }
            }, RETRY_DELAY_MS);
          } else {
            // Second failure — set error status
            retrying.delete(filePath);
            useAIStore.getState().setASTIndexStatus("error");
            showToast(`Indexing failed for ${filePath.split(/[\\/]/).pop()}`, "error");
          }
        } else {
          // Success — update status
          useAIStore.getState().setASTIndexStatus("ready");
        }
      }

      // Set indexing status
      useAIStore.getState().setASTIndexStatus("indexing");

      // Debounced symbol rebuild (300ms)
      const symbolTimer = setTimeout(() => {
        if (signal.aborted) return;

        invoke("symbol_rebuild_file", { filePath, content })
          .then(() => {
            symbolDone = true;
            checkCompletion();
          })
          .catch((err) => {
            if (signal.aborted) return;
            symbolError = err;
            symbolDone = true;
            checkCompletion();
          });
      }, SYMBOL_DEBOUNCE_MS);

      // Debounced call graph rebuild (1500ms)
      const callgraphTimer = setTimeout(() => {
        if (signal.aborted) return;

        invoke("callgraph_rebuild_file", { filePath, content })
          .then(() => {
            callgraphDone = true;
            checkCompletion();
          })
          .catch((err) => {
            if (signal.aborted) return;
            callgraphError = err;
            callgraphDone = true;
            checkCompletion();
          });
      }, CALLGRAPH_DEBOUNCE_MS);

      inFlight.set(filePath, { controller, symbolTimer, callgraphTimer });
    }

    // ── Subscribe to editorStore tab save events ───────────────────────────────
    // We detect saves by watching for tabs transitioning from modified=true to modified=false
    // (which happens when markTabSaved is called).

    let previousTabs: EditorTab[] = useEditorStore.getState().tabs;

    const unsubscribeStore = useEditorStore.subscribe((state) => {
      const currentTabs = state.tabs;

      for (const currentTab of currentTabs) {
        // Find the same tab in previous state
        const prevTab = previousTabs.find((t) => t.id === currentTab.id);

        // Detect save: tab was modified, now it's not (markTabSaved was called)
        if (prevTab && prevTab.modified && !currentTab.modified) {
          triggerReindex(currentTab.path, currentTab.content);
        }
      }

      previousTabs = currentTabs;
    });

    // ── Listen for Tauri fs-changed event to handle file deletion/rename ───────

    let unlistenFs: UnlistenFn | null = null;

    const setupFsListener = async () => {
      unlistenFs = await listen<FsChangePayload>("fs-changed", (event) => {
        const { paths, kind } = event.payload;

        // On file removal, cancel in-flight work and clear index entries
        if (kind === "remove") {
          for (const removedPath of paths) {
            cancelInFlight(removedPath);

            // Clear symbol index entries for removed file
            invoke("symbol_rebuild_file", { filePath: removedPath, content: "" }).catch(() => {});
            // Clear call graph entries for removed file
            invoke("callgraph_rebuild_file", { filePath: removedPath, content: "" }).catch(() => {});
          }
        }
      });
    };

    setupFsListener();

    // ── Cleanup ────────────────────────────────────────────────────────────────

    return () => {
      unsubscribeStore();

      if (unlistenFs) {
        unlistenFs();
      }

      // Cancel all in-flight operations
      for (const [, entry] of inFlight) {
        if (entry.symbolTimer) clearTimeout(entry.symbolTimer);
        if (entry.callgraphTimer) clearTimeout(entry.callgraphTimer);
        entry.controller.abort();
      }
      inFlight.clear();
      retrying.clear();
    };
  }, []);
}
