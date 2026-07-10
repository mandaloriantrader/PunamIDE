/**
 * useProactiveErrors — Activates the ProactiveErrorDetector at app startup.
 *
 * Creates a singleton detector instance and hooks it into editor lifecycle events:
 * - File open: captures baseline diagnostics when a new tab appears
 * - First edit: captures baseline diagnostics when a tab first becomes modified
 * - File save: triggers onSave() to compare current diagnostics against baseline
 * - Notification click: wires PROACTIVE_ERROR_FIX_EVENT to onNotificationClick()
 *
 * Follows the same hook-based service-activation pattern as useAutoReindex and
 * useAutoSave (subscribes to App.tsx local tabs state changes).
 *
 * Requirements: 15.1, 15.2, 15.4
 */

import { useEffect, useRef } from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import {
  ProactiveErrorDetector,
  PROACTIVE_ERROR_FIX_EVENT,
  type DiagnosticInfo,
} from "../services/diagnostics/ProactiveErrorDetector";

// ─── Types ─────────────────────────────────────────────────────────────────────

interface Tab {
  id: string;
  path: string;
  name: string;
  content: string;
  modified: boolean;
}

interface LspDiagnosticsEventPayload {
  language_id: string;
  uri: string;
  diagnostics: string; // JSON-encoded array from Rust backend
}

interface UseProactiveErrorsOptions {
  /** The current set of open tabs (from App.tsx local state). */
  tabs: Tab[];
}

// ─── Singleton Instance ────────────────────────────────────────────────────────

let detectorInstance: ProactiveErrorDetector | null = null;

/**
 * Get or create the singleton ProactiveErrorDetector instance.
 * Exported for use by other services that need to interact with the detector.
 */
export function getProactiveErrorDetector(): ProactiveErrorDetector {
  if (!detectorInstance) {
    detectorInstance = new ProactiveErrorDetector();
  }
  return detectorInstance;
}

// ─── Helpers ───────────────────────────────────────────────────────────────────

/** Parse raw LSP diagnostic JSON into DiagnosticInfo array (mirrors detector's internal parsing). */
function parseLspDiagnostics(diagnosticsJson: string): DiagnosticInfo[] {
  try {
    const rawDiags = JSON.parse(diagnosticsJson);
    if (!Array.isArray(rawDiags)) return [];
    return rawDiags.map((d: any) => ({
      code: d.code != null ? String(d.code) : "",
      message: d.message ?? "",
      severity: mapSeverity(d.severity ?? 1),
      startLine: d.range?.start?.line ?? 0,
      endLine: d.range?.end?.line ?? d.range?.start?.line ?? 0,
    }));
  } catch {
    return [];
  }
}

function mapSeverity(severity: number): DiagnosticInfo["severity"] {
  switch (severity) {
    case 1: return "error";
    case 2: return "warning";
    case 3: return "info";
    case 4: return "hint";
    default: return "error";
  }
}

/**
 * Normalize a URI or file path for comparison.
 * LSP sends `file:///c%3A/...` URIs; we strip protocol and decode for matching.
 */
function normalizeUri(uri: string): string {
  let normalized = uri.replace(/\\/g, "/");
  if (normalized.startsWith("file:///")) {
    normalized = normalized.slice(8); // Remove file:///
  } else if (normalized.startsWith("file://")) {
    normalized = normalized.slice(7);
  }
  try {
    normalized = decodeURIComponent(normalized);
  } catch { /* ignore decode errors */ }
  return normalized.toLowerCase();
}

function uriMatchesFile(eventUri: string, filePath: string): boolean {
  if (!eventUri || !filePath) return false;
  const normEvent = normalizeUri(eventUri);
  const normFile = normalizeUri(filePath);
  return normEvent === normFile || normEvent.endsWith(normFile) || normFile.endsWith(normEvent);
}

// ─── Hook ──────────────────────────────────────────────────────────────────────

export function useProactiveErrors({ tabs }: UseProactiveErrorsOptions): void {
  const detectorRef = useRef<ProactiveErrorDetector>(getProactiveErrorDetector());
  const previousTabsRef = useRef<Tab[]>([]);
  // Track which files have had their baseline captured via first-edit
  const baselineCapturedRef = useRef<Set<string>>(new Set());
  // Cache the latest diagnostics per file from LSP events for baseline capture
  const latestDiagnosticsRef = useRef<Map<string, DiagnosticInfo[]>>(new Map());

  useEffect(() => {
    const detector = detectorRef.current;
    let unlistenLsp: UnlistenFn | null = null;
    let unlistenFixEvent: (() => void) | null = null;

    // ── 1. Listen to lsp-diagnostics events to maintain a fresh diagnostics cache ──
    // This cache is used when capturing baselines on file-open and first-edit.
    const setupLspListener = async () => {
      unlistenLsp = await listen<LspDiagnosticsEventPayload>(
        "lsp-diagnostics",
        (event) => {
          const { uri, diagnostics: diagJson } = event.payload;
          const parsed = parseLspDiagnostics(diagJson);
          // Store under the raw URI for flexible matching later
          latestDiagnosticsRef.current.set(uri, parsed);
        }
      );
    };

    setupLspListener();

    // ── 2. Wire PROACTIVE_ERROR_FIX_EVENT to onNotificationClick ──────────────
    const handleFixEvent = (e: Event) => {
      const customEvent = e as CustomEvent<{ filePath: string; diagnostic: DiagnosticInfo }>;
      if (customEvent.detail) {
        detector.onNotificationClick(customEvent.detail.filePath, customEvent.detail.diagnostic);
      }
    };

    window.addEventListener(PROACTIVE_ERROR_FIX_EVENT, handleFixEvent);
    unlistenFixEvent = () => window.removeEventListener(PROACTIVE_ERROR_FIX_EVENT, handleFixEvent);

    // ── Cleanup ──────────────────────────────────────────────────────────────────
    return () => {
      if (unlistenLsp) unlistenLsp();
      if (unlistenFixEvent) unlistenFixEvent();
    };
  }, []);

  // ── 3. React to tab changes: file open, first edit, save ───────────────────
  useEffect(() => {
    const detector = detectorRef.current;
    const previousTabs = previousTabsRef.current;

    // Helper to get current diagnostics for a file from the cached LSP events
    const getDiagnosticsForFile = (filePath: string): DiagnosticInfo[] => {
      // Search through cached diagnostics for a match
      for (const [uri, diags] of latestDiagnosticsRef.current) {
        if (uriMatchesFile(uri, filePath)) {
          return diags;
        }
      }
      return [];
    };

    for (const currentTab of tabs) {
      const prevTab = previousTabs.find((t) => t.id === currentTab.id);

      // ── File Open: new tab that wasn't in previous state ──────────────────
      if (!prevTab) {
        const currentDiags = getDiagnosticsForFile(currentTab.path);
        detector.captureBaseline(currentTab.path, currentDiags);
        baselineCapturedRef.current.add(currentTab.path);
      }

      // ── First Edit: tab transitions from unmodified to modified ────────────
      // Only capture baseline if we haven't already captured one for this file
      if (prevTab && !prevTab.modified && currentTab.modified) {
        if (!baselineCapturedRef.current.has(currentTab.path)) {
          const currentDiags = getDiagnosticsForFile(currentTab.path);
          detector.captureBaseline(currentTab.path, currentDiags);
          baselineCapturedRef.current.add(currentTab.path);
        }
      }

      // ── File Save: tab transitions from modified to unmodified ─────────────
      if (prevTab && prevTab.modified && !currentTab.modified) {
        // Trigger onSave which internally listens for fresh lsp-diagnostics
        detector.onSave(currentTab.path, Date.now()).catch((err) => {
          console.warn("[useProactiveErrors] onSave failed:", err);
        });
      }
    }

    // ── Tab Closed: remove baseline tracking for closed tabs ─────────────────
    for (const prevTab of previousTabs) {
      const stillOpen = tabs.find((t) => t.id === prevTab.id);
      if (!stillOpen) {
        baselineCapturedRef.current.delete(prevTab.path);
        // Note: we don't clear the detector's baseline here because re-opening
        // the same file should start fresh, and captureBaseline is a no-op if
        // a baseline already exists. The baseline stays until the session ends.
      }
    }

    // Update previous tabs reference
    previousTabsRef.current = tabs;
  }, [tabs]);
}
