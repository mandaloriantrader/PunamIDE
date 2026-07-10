/**
 * useContextSidebar — Wires the ContextSidebarModel to editor lifecycle events.
 *
 * Subscriptions:
 * - Cursor move (editorStore.cursorPosition) → refreshForCursor() (debounced internally)
 * - Active file change (editorStore.activeTabId) → refreshRelatedFiles()
 * - LSP diagnostics (Tauri `lsp-diagnostics` event) → setDiagnostics()
 *
 * This hook should be called once from the component that mounts ContextSidebar
 * or from App.tsx to ensure subscriptions are always active.
 *
 * Requirements: 16.1, 16.4, 16.6
 */

import { useEffect, useRef } from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { useEditorStore } from "../store/editorStore";
import { sidebarModel } from "../components/ContextSidebar";
import type { DiagnosticInfo } from "../services/context/ContextSidebarModel";

// ─── Types ─────────────────────────────────────────────────────────────────────

interface LspDiagnosticsEventPayload {
  language_id: string;
  uri: string;
  diagnostics: string; // JSON-encoded array from Rust backend
}

// ─── Hook ──────────────────────────────────────────────────────────────────────

/**
 * Activates sidebar model subscriptions. Call once at mount.
 */
export function useContextSidebar(): void {
  const cursorPosition = useEditorStore((s) => s.cursorPosition);
  const activeTabId = useEditorStore((s) => s.activeTabId);
  const tabs = useEditorStore((s) => s.tabs);

  // Track previous active tab to detect file changes
  const prevActiveTabRef = useRef<string>("");
  const unlistenRef = useRef<UnlistenFn | null>(null);

  // ── Cursor move → refreshForCursor (debounced 500ms in model) ──────────
  useEffect(() => {
    const activeTab = tabs.find((t) => t.id === activeTabId);
    if (!activeTab?.path) return;

    // refreshForCursor already has internal 500ms debounce
    sidebarModel.refreshForCursor(
      activeTab.path,
      cursorPosition.line,
      cursorPosition.column
    );
  }, [cursorPosition.line, cursorPosition.column, activeTabId, tabs]);

  // ── Active file change → refreshRelatedFiles ───────────────────────────
  useEffect(() => {
    const activeTab = tabs.find((t) => t.id === activeTabId);
    const currentPath = activeTab?.path || "";

    if (currentPath && currentPath !== prevActiveTabRef.current) {
      prevActiveTabRef.current = currentPath;
      sidebarModel.refreshRelatedFiles(currentPath);
    }
  }, [activeTabId, tabs]);

  // ── LSP diagnostics → setDiagnostics ──────────────────────────────────
  useEffect(() => {
    let cancelled = false;

    const setup = async () => {
      try {
        const unlisten = await listen<LspDiagnosticsEventPayload>(
          "lsp-diagnostics",
          (event) => {
            if (cancelled) return;

            const { uri, diagnostics: diagJson } = event.payload;
            // Extract file path from URI
            let filePath = uri;
            if (filePath.startsWith("file:///")) {
              filePath = filePath.slice(8); // Remove file:///
              // On Windows, paths start with drive letter after file:///
              if (/^[a-zA-Z]:/.test(filePath) === false && filePath.startsWith("/")) {
                filePath = filePath.slice(1);
              }
            }
            filePath = decodeURIComponent(filePath);

            // Only process diagnostics for the active file
            const state = useEditorStore.getState();
            const activeTab = state.tabs.find((t) => t.id === state.activeTabId);
            if (!activeTab?.path) return;

            // Normalize for comparison
            const normPath = (p: string) =>
              p.replace(/\\/g, "/").replace(/\/+/g, "/").toLowerCase();

            if (normPath(filePath) !== normPath(activeTab.path)) return;

            try {
              const rawDiags = JSON.parse(diagJson);
              const mapped: DiagnosticInfo[] = rawDiags.map((d: any) => ({
                code: String(d.code ?? ""),
                message: d.message ?? "",
                severity: mapSeverity(d.severity),
                startLine: d.range?.start?.line ?? 0,
                endLine: d.range?.end?.line ?? 0,
              }));

              sidebarModel.setDiagnostics(activeTab.path, mapped);
            } catch {
              // Ignore parse errors
            }
          }
        );

        if (!cancelled) {
          unlistenRef.current = unlisten;
        } else {
          unlisten();
        }
      } catch {
        // listen() may fail in test environments
      }
    };

    setup();

    return () => {
      cancelled = true;
      if (unlistenRef.current) {
        unlistenRef.current();
        unlistenRef.current = null;
      }
    };
  }, []);
}

// ─── Helpers ───────────────────────────────────────────────────────────────────

function mapSeverity(
  lspSeverity: number | undefined
): DiagnosticInfo["severity"] {
  switch (lspSeverity) {
    case 1:
      return "error";
    case 2:
      return "warning";
    case 3:
      return "info";
    case 4:
      return "hint";
    default:
      return "info";
  }
}
