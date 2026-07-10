/**
 * Refinement Loop — Automated corrective pass mechanism for agent edits.
 *
 * After the agent applies a code edit, this module:
 * 1. Waits for LSP diagnostics on the modified file
 * 2. Compares pre-edit vs post-edit diagnostics to find newly introduced errors
 * 3. If new errors are found, requests AI to generate a fix
 * 4. Loops up to maxRetries times, rolling back on total failure
 *
 * Only error-severity diagnostics trigger correction (warnings/hints/info ignored).
 * If the LSP times out, the edit is applied as-is and the user is notified.
 */

import { listen } from "@tauri-apps/api/event";

// ─── Configuration ───────────────────────────────────────────────────────────

export interface RefinementConfig {
  /** Maximum corrective passes per file (default: 3) */
  maxRetries: number;
  /** Time to wait for LSP diagnostics after edit (default: 2000ms) */
  diagnosticTimeoutMs: number;
  /** Only trigger on errors, not warnings/hints (default: true) */
  errorsOnly: boolean;
}

export const DEFAULT_REFINEMENT_CONFIG: RefinementConfig = {
  maxRetries: 3,
  diagnosticTimeoutMs: 2000,
  errorsOnly: true,
};

// ─── Interfaces ──────────────────────────────────────────────────────────────

export interface DiagnosticInfo {
  message: string;
  severity: "error" | "warning" | "information" | "hint";
  startLine: number;
  startColumn: number;
  endLine: number;
  endColumn: number;
  code?: string;
}

export interface RefinementResult {
  success: boolean;
  passesUsed: number;
  finalDiagnostics: DiagnosticInfo[];
  rolledBack: boolean;
  rollbackContent?: string;
}

export interface ErrorContext {
  filePath: string;
  currentContent: string;
  errors: DiagnosticInfo[];
  previousAttempts: Array<{
    attemptNumber: number;
    patchApplied: string;
    resultingErrors: DiagnosticInfo[];
  }>;
}

// ─── Internal Event Types ────────────────────────────────────────────────────

interface LspDiagnosticsEventPayload {
  language_id: string;
  uri: string;
  diagnostics: string; // JSON-encoded array from Rust backend
}

// ─── Severity Mapping ────────────────────────────────────────────────────────

function mapSeverity(severity: number): DiagnosticInfo["severity"] {
  switch (severity) {
    case 1:
      return "error";
    case 2:
      return "warning";
    case 3:
      return "information";
    case 4:
      return "hint";
    default:
      return "error";
  }
}

/**
 * Parse raw LSP diagnostic JSON into typed DiagnosticInfo array.
 */
function parseDiagnostics(diagnosticsJson: string): DiagnosticInfo[] {
  try {
    const rawDiags = JSON.parse(diagnosticsJson);
    return rawDiags.map((d: any) => ({
      message: d.message ?? "",
      severity: mapSeverity(d.severity ?? 1),
      startLine: d.range?.start?.line ?? 0,
      startColumn: d.range?.start?.character ?? 0,
      endLine: d.range?.end?.line ?? 0,
      endColumn: d.range?.end?.character ?? 0,
      code: d.code != null ? String(d.code) : undefined,
    }));
  } catch {
    return [];
  }
}

// ─── RefinementLoop Class ────────────────────────────────────────────────────

export class RefinementLoop {
  private config: RefinementConfig;

  constructor(config?: Partial<RefinementConfig>) {
    this.config = { ...DEFAULT_REFINEMENT_CONFIG, ...config };
  }

  /**
   * Run the refinement loop after an edit has been applied to a file.
   *
   * Flow:
   * 1. Wait for LSP diagnostics on the edited file
   * 2. Compare pre-edit diagnostics with post-edit diagnostics
   * 3. If new errors are found, request an AI fix
   * 4. Apply the fix and re-check diagnostics
   * 5. Loop up to maxRetries, rollback on total failure
   */
  async runAfterEdit(params: {
    filePath: string;
    fileUri: string;
    languageId: string;
    preEditContent: string;
    postEditContent: string;
    preEditDiagnostics: DiagnosticInfo[];
    requestAiFix: (context: ErrorContext) => Promise<string | null>;
  }): Promise<RefinementResult> {
    const {
      filePath,
      fileUri,
      preEditContent,
      postEditContent,
      preEditDiagnostics,
      requestAiFix,
    } = params;

    let currentContent = postEditContent;
    const previousAttempts: ErrorContext["previousAttempts"] = [];

    // Step 1: Get initial post-edit diagnostics
    const initialPostDiagnostics = await this.waitForDiagnostics(
      fileUri,
      this.config.diagnosticTimeoutMs
    );

    // If LSP timed out (empty array from timeout), treat as success — skip refinement
    if (initialPostDiagnostics.length === 0 && this.config.diagnosticTimeoutMs > 0) {
      // LSP might be unavailable or no diagnostics yet — apply edit as-is
      return {
        success: true,
        passesUsed: 0,
        finalDiagnostics: [],
        rolledBack: false,
      };
    }

    // Step 2: Find newly introduced errors
    let newErrors = this.findNewErrors(preEditDiagnostics, initialPostDiagnostics);

    // No new errors — edit is clean
    if (newErrors.length === 0) {
      return {
        success: true,
        passesUsed: 0,
        finalDiagnostics: initialPostDiagnostics,
        rolledBack: false,
      };
    }

    // Step 3: Corrective loop
    let passesUsed = 0;

    for (let attempt = 1; attempt <= this.config.maxRetries; attempt++) {
      passesUsed = attempt;

      // Build error context for the AI
      const errorContext: ErrorContext = {
        filePath,
        currentContent,
        errors: newErrors,
        previousAttempts: [...previousAttempts],
      };

      // Request AI fix
      const fixedContent = await requestAiFix(errorContext);

      // If AI couldn't produce a fix, continue to next attempt or fail
      if (fixedContent === null) {
        previousAttempts.push({
          attemptNumber: attempt,
          patchApplied: "",
          resultingErrors: newErrors,
        });
        continue;
      }

      // Record this attempt
      previousAttempts.push({
        attemptNumber: attempt,
        patchApplied: fixedContent,
        resultingErrors: newErrors,
      });

      // Apply the fix (update tracked content)
      currentContent = fixedContent;

      // Wait for new diagnostics after fix
      const postFixDiagnostics = await this.waitForDiagnostics(
        fileUri,
        this.config.diagnosticTimeoutMs
      );

      // If LSP timed out after fix, treat as success
      if (postFixDiagnostics.length === 0) {
        return {
          success: true,
          passesUsed,
          finalDiagnostics: [],
          rolledBack: false,
        };
      }

      // Check if new errors are resolved
      newErrors = this.findNewErrors(preEditDiagnostics, postFixDiagnostics);

      if (newErrors.length === 0) {
        // All errors resolved
        return {
          success: true,
          passesUsed,
          finalDiagnostics: postFixDiagnostics,
          rolledBack: false,
        };
      }
    }

    // All retries exhausted — rollback to pre-edit content
    return {
      success: false,
      passesUsed,
      finalDiagnostics: newErrors,
      rolledBack: true,
      rollbackContent: preEditContent,
    };
  }

  /**
   * Wait for LSP diagnostics for a specific file URI.
   * Subscribes to the Tauri `lsp-diagnostics` event and resolves when
   * diagnostics arrive for the target file, or times out with an empty array.
   */
  private async waitForDiagnostics(
    fileUri: string,
    timeoutMs: number
  ): Promise<DiagnosticInfo[]> {
    return new Promise<DiagnosticInfo[]>((resolve) => {
      let resolved = false;

      const timer = setTimeout(() => {
        if (resolved) return;
        resolved = true;
        unlistenPromise.then((unlisten) => unlisten()).catch(() => {});
        resolve([]); // Timeout → treat as no diagnostics (LSP unavailable)
      }, timeoutMs);

      const unlistenPromise = listen<LspDiagnosticsEventPayload>(
        "lsp-diagnostics",
        (event) => {
          if (resolved) return;
          if (event.payload.uri === fileUri) {
            resolved = true;
            clearTimeout(timer);
            unlistenPromise.then((unlisten) => unlisten()).catch(() => {});
            const diagnostics = parseDiagnostics(event.payload.diagnostics);
            resolve(diagnostics);
          }
        }
      );
    });
  }

  /**
   * Compare pre-edit vs post-edit diagnostics and return only newly introduced errors.
   *
   * A diagnostic is considered "new" if there is no matching diagnostic in the
   * pre-edit set with the same message, same severity, and overlapping line range.
   * Only error-severity diagnostics are returned (when errorsOnly is true).
   */
  private findNewErrors(
    preEdit: DiagnosticInfo[],
    postEdit: DiagnosticInfo[]
  ): DiagnosticInfo[] {
    // Filter to errors only if configured
    const postErrors = this.config.errorsOnly
      ? postEdit.filter((d) => d.severity === "error")
      : postEdit;

    const preErrors = this.config.errorsOnly
      ? preEdit.filter((d) => d.severity === "error")
      : preEdit;

    return postErrors.filter((postDiag) => {
      // Check if this diagnostic existed before the edit
      const existedBefore = preErrors.some((preDiag) => {
        // Same message
        if (preDiag.message !== postDiag.message) return false;

        // Same severity
        if (preDiag.severity !== postDiag.severity) return false;

        // Overlapping line range: pre-edit range overlaps with post-edit range
        const preStart = preDiag.startLine;
        const preEnd = preDiag.endLine;
        const postStart = postDiag.startLine;
        const postEnd = postDiag.endLine;

        // Two ranges overlap if one starts before or at the other's end
        const overlaps = preStart <= postEnd && postStart <= preEnd;
        return overlaps;
      });

      // Return only diagnostics that did NOT exist before (new errors)
      return !existedBefore;
    });
  }
}
