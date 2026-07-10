/**
 * Proactive Error Detection on Recent Edits (Tier C — Component 15).
 *
 * `ProactiveErrorDetector` captures a baseline diagnostic snapshot when a file is
 * first opened or first edited in the current editor session, then on each save
 * compares the latest `lsp-diagnostics` against that baseline and surfaces only
 * newly introduced error-level diagnostics via a non-focus-stealing, auto-dismissing
 * toast.
 *
 * It reuses the same new-error detection approach as `RefinementLoop.findNewErrors`
 * (match by diagnostic code + overlapping line range), throttles notifications per
 * file, and suppresses dismissed diagnostics until the next save re-observes them.
 *
 * Requirements: 15.1, 15.2, 15.3, 15.4, 15.5, 15.6, 15.7
 */

import { listen } from "@tauri-apps/api/event";
import { showToast } from "../../utils/toast";
import { useEditorStore } from "../../store/editorStore";

// ─── Interfaces ──────────────────────────────────────────────────────────────

export interface DiagnosticInfo {
  code: string;
  message: string;
  severity: "error" | "warning" | "info" | "hint";
  startLine: number;
  endLine: number;
}

export interface DetectorConfig {
  /** Max time to wait for LSP diagnostics after a save (default 5000ms). */
  comparisonTimeoutMs: number;
  /** Throttle window: at most one notification per file per window (default 5000ms). */
  throttleWindowMs: number;
}

export const DEFAULT_DETECTOR_CONFIG: DetectorConfig = {
  comparisonTimeoutMs: 5000,
  throttleWindowMs: 5000,
};

export interface DetectorState {
  /** Baseline per file, captured on first open/edit. */
  baselines: Map<string, DiagnosticInfo[]>;
  /** Last notification timestamp per file (for throttling). */
  lastNotifiedAt: Map<string, number>;
  /** Dismissed diagnostics per file (code set), cleared on next save. */
  dismissed: Map<string, Set<string>>;
}

// ─── Internal Event Types ────────────────────────────────────────────────────

interface LspDiagnosticsEventPayload {
  language_id: string;
  uri: string;
  diagnostics: string; // JSON-encoded array from Rust backend
}

/** Custom DOM event dispatched to request an AI-assisted fix for a diagnostic. */
export const PROACTIVE_ERROR_FIX_EVENT = "punam:proactive-error-fix";

// ─── Severity Mapping ────────────────────────────────────────────────────────

function mapSeverity(severity: number): DiagnosticInfo["severity"] {
  switch (severity) {
    case 1:
      return "error";
    case 2:
      return "warning";
    case 3:
      return "info";
    case 4:
      return "hint";
    default:
      return "error";
  }
}

/**
 * Parse raw LSP diagnostic JSON into typed `DiagnosticInfo` array.
 * Mirrors RefinementLoop's parsing but normalizes to this component's shape.
 */
function parseDiagnostics(diagnosticsJson: string): DiagnosticInfo[] {
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

/**
 * Determine whether an `lsp-diagnostics` event payload targets the given file.
 * LSP emits `file://` URIs; we match tolerantly so callers can pass either a
 * plain path or a URI.
 */
function eventMatchesFile(eventUri: string, filePath: string): boolean {
  if (!eventUri) return false;
  if (eventUri === filePath) return true;
  const normalizedEvent = eventUri.replace(/\\/g, "/");
  const normalizedFile = filePath.replace(/\\/g, "/");
  return (
    normalizedEvent === normalizedFile ||
    normalizedEvent.endsWith(normalizedFile) ||
    normalizedEvent.includes(normalizedFile)
  );
}

// ─── ProactiveErrorDetector Class ────────────────────────────────────────────

export class ProactiveErrorDetector {
  private config: DetectorConfig;
  private state: DetectorState;

  constructor(config?: Partial<DetectorConfig>) {
    this.config = { ...DEFAULT_DETECTOR_CONFIG, ...config };
    this.state = {
      baselines: new Map<string, DiagnosticInfo[]>(),
      lastNotifiedAt: new Map<string, number>(),
      dismissed: new Map<string, Set<string>>(),
    };
  }

  /**
   * Capture the baseline diagnostic snapshot on first open/edit.
   * NO-OP if a baseline already exists for the file (Req 15.3).
   */
  captureBaseline(filePath: string, diagnostics: DiagnosticInfo[]): void {
    if (this.state.baselines.has(filePath)) return;
    // Defensive copy so later mutations to the caller's array don't leak in.
    this.state.baselines.set(filePath, diagnostics.map((d) => ({ ...d })));
  }

  /**
   * Pure diff: return error-level diagnostics present in `current` but not in
   * `baseline`, matched by diagnostic `code` + overlapping line range. Only
   * error-severity diagnostics are returned. Mirrors RefinementLoop.findNewErrors.
   */
  findNewErrors(baseline: DiagnosticInfo[], current: DiagnosticInfo[]): DiagnosticInfo[] {
    const currentErrors = current.filter((d) => d.severity === "error");
    const baselineErrors = baseline.filter((d) => d.severity === "error");

    return currentErrors.filter((curDiag) => {
      const existedBefore = baselineErrors.some((baseDiag) => {
        // Same diagnostic code
        if (baseDiag.code !== curDiag.code) return false;

        // Overlapping line range: two ranges overlap if one starts before or at
        // the other's end.
        const overlaps =
          baseDiag.startLine <= curDiag.endLine && curDiag.startLine <= baseDiag.endLine;
        return overlaps;
      });

      // Only diagnostics that did NOT exist before are "new".
      return !existedBefore;
    });
  }

  /**
   * Handle a save event (Req 15.1, 15.2, 15.5, 15.6, 15.7).
   *
   * Waits up to `comparisonTimeoutMs` for diagnostics to arrive for the file;
   * if they arrive, computes new errors against the baseline, filters out
   * throttled and dismissed diagnostics, emits a non-focus-stealing,
   * auto-dismissing toast for the remaining new errors, updates the throttle
   * timestamp, and returns the diagnostics actually notified.
   *
   * On LSP timeout (no diagnostics within `comparisonTimeoutMs`): skips and
   * returns an empty array without notifying.
   */
  async onSave(filePath: string, now: number): Promise<DiagnosticInfo[]> {
    // Clear the per-file dismissed set at the start of each save so that
    // dismissed-but-still-present diagnostics can re-notify on a later save
    // once the save re-observes them (Req 15.6).
    this.state.dismissed.set(filePath, new Set<string>());

    const current = await this.waitForDiagnostics(filePath, this.config.comparisonTimeoutMs);

    // LSP timeout → no diagnostics arrived: skip this save (Req 15.7).
    if (current === null) {
      return [];
    }

    const baseline = this.state.baselines.get(filePath) ?? [];
    const newErrors = this.findNewErrors(baseline, current);

    if (newErrors.length === 0) {
      return [];
    }

    // Throttle: at most one notification per file per throttleWindowMs (Req 15.5).
    const lastNotified = this.state.lastNotifiedAt.get(filePath);
    if (lastNotified !== undefined && now - lastNotified < this.config.throttleWindowMs) {
      return [];
    }

    // Filter out dismissed diagnostics (Req 15.6). The dismissed set was just
    // cleared, so this only suppresses items dismissed during this save cycle.
    const dismissedCodes = this.state.dismissed.get(filePath) ?? new Set<string>();
    const toNotify = newErrors.filter((d) => !dismissedCodes.has(d.code));

    if (toNotify.length === 0) {
      return [];
    }

    this.notify(filePath, toNotify);
    this.state.lastNotifiedAt.set(filePath, now);

    return toNotify;
  }

  /**
   * Mark a diagnostic dismissed for a file (Req 15.6). Suppressed until the next
   * save re-observes it (the dismissed set is cleared at the start of each save).
   */
  dismiss(filePath: string, code: string): void {
    const set = this.state.dismissed.get(filePath) ?? new Set<string>();
    set.add(code);
    this.state.dismissed.set(filePath, set);
  }

  /**
   * Handle a click on a proactive error notification (Req 15.4):
   * navigate the editor to the error location and offer an AI-assisted fix.
   */
  onNotificationClick(filePath: string, diag: DiagnosticInfo): void {
    const store = useEditorStore.getState();

    // Navigate: focus the file's tab if it is already open, then move the cursor
    // to the error location. Editor line numbers are 1-based; LSP lines are 0-based.
    const tab = store.tabs.find((t) => t.path === filePath);
    if (tab) {
      store.setActiveTab(tab.id);
    }
    store.setCursorPosition(diag.startLine + 1, 1);

    // Offer AI-assisted fix by dispatching a custom event that the AI fix path
    // listens for. If no provider is registered, this is a harmless no-op.
    if (typeof window !== "undefined" && typeof window.dispatchEvent === "function") {
      window.dispatchEvent(
        new CustomEvent(PROACTIVE_ERROR_FIX_EVENT, {
          detail: { filePath, diagnostic: diag },
        })
      );
    }
  }

  /**
   * Expose the internal state (primarily for testing).
   */
  getState(): DetectorState {
    return this.state;
  }

  // ─── Internals ─────────────────────────────────────────────────────────────

  /**
   * Emit a non-focus-stealing, auto-dismissing toast for the newly introduced
   * errors, identifying file name and line number (Req 15.2). Clicking is wired
   * via `onNotificationClick`; the toast system itself is non-focus-stealing and
   * auto-dismisses.
   */
  private notify(filePath: string, diagnostics: DiagnosticInfo[]): void {
    const fileName = filePath.replace(/\\/g, "/").split("/").pop() ?? filePath;
    for (const diag of diagnostics) {
      // LSP lines are 0-based; present a 1-based line number to the user.
      const line = diag.startLine + 1;
      showToast(`New error in ${fileName}:${line} — ${diag.message}`, "error");
    }
  }

  /**
   * Wait for LSP diagnostics for a specific file.
   *
   * Subscribes to the Tauri `lsp-diagnostics` event and resolves with the parsed
   * diagnostics when they arrive for the target file, or resolves with `null` on
   * timeout (so callers can distinguish "no diagnostics arrived" from "arrived
   * empty"). Mirrors RefinementLoop.waitForDiagnostics.
   */
  private async waitForDiagnostics(
    filePath: string,
    timeoutMs: number
  ): Promise<DiagnosticInfo[] | null> {
    return new Promise<DiagnosticInfo[] | null>((resolve) => {
      let resolved = false;

      const timer = setTimeout(() => {
        if (resolved) return;
        resolved = true;
        unlistenPromise.then((unlisten) => unlisten()).catch(() => {});
        resolve(null); // Timeout → no diagnostics arrived (Req 15.7).
      }, timeoutMs);

      const unlistenPromise = listen<LspDiagnosticsEventPayload>(
        "lsp-diagnostics",
        (event) => {
          if (resolved) return;
          if (eventMatchesFile(event.payload.uri, filePath)) {
            resolved = true;
            clearTimeout(timer);
            unlistenPromise.then((unlisten) => unlisten()).catch(() => {});
            resolve(parseDiagnostics(event.payload.diagnostics));
          }
        }
      );
    });
  }
}
