/**
 * DapBridge — Agent-Assisted Debugging Bridge
 *
 * Listens for DAP debugger events and orchestrates AI analysis when breakpoints
 * are hit. Collects stack frames, local variables, and editor diagnostics, then
 * streams the analysis to the debug panel.
 *
 * Singleton service — call `DapBridge.getInstance()` to access.
 *
 * @see Requirements 3.1, 3.2, 3.5, 3.6, 3.7, 3.8
 */

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { useEditorStore, type Diagnostic } from "../../store/editorStore";
import { useSettingsStore } from "../../store/settingsStore";
import { startStream } from "../ai/streaming";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A single stack frame from the DAP stackTrace response. */
export interface StackFrame {
  id: number;
  name: string;
  source?: { name?: string; path?: string };
  line: number;
  column?: number;
}

/** A local variable from the DAP variables response. */
export interface Variable {
  name: string;
  value: string;
  type?: string;
  variablesReference?: number;
}

/** The assembled debug context sent to the AI agent. */
export interface DebugContextPayload {
  sessionId: string;
  stackFrames: StackFrame[];
  localVariables: Variable[];
  diagnostics: Diagnostic[];
  filePath: string;
  line: number;
  sourceSnippet: string;
}

/** Result of AI analysis on a breakpoint hit. */
export interface DapAnalysisResult {
  analysis: string;
  watchSuggestions: string[];
  suggestedFix?: {
    filePath: string;
    patch: string;
    explanation: string;
  };
}

/** Current state of the bridge analysis. */
export type DapBridgeStatus =
  | "idle"
  | "collecting"
  | "streaming"
  | "complete"
  | "error"
  | "timeout";

/** State exposed to the UI for rendering the AI Analysis tab. */
export interface DapBridgeState {
  status: DapBridgeStatus;
  streamingText: string;
  result: DapAnalysisResult | null;
  errorMessage: string | null;
  canRetry: boolean;
  lastPayload: DebugContextPayload | null;
}

/** Shape of the debugger-event payload emitted by Rust DAP manager. */
interface DebuggerEventPayload {
  session_id: string;
  event_type: string;
  body: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_STACK_FRAMES = 20;
const ANALYSIS_TIMEOUT_MS = 5000;
const STREAM_ID_PREFIX = "dap-analysis-";

// ---------------------------------------------------------------------------
// DapBridge Class
// ---------------------------------------------------------------------------

export class DapBridge {
  private static instance: DapBridge | null = null;

  private activeAbortController: AbortController | null = null;
  private timeoutHandle: ReturnType<typeof setTimeout> | null = null;
  private unlistenStopped: UnlistenFn | null = null;
  private unlistenContinued: UnlistenFn | null = null;
  private unlistenStream: UnlistenFn | null = null;
  private currentStreamId: string | null = null;

  private _state: DapBridgeState = {
    status: "idle",
    streamingText: "",
    result: null,
    errorMessage: null,
    canRetry: false,
    lastPayload: null,
  };

  /** Subscribers notified on state change. */
  private listeners: Set<(state: DapBridgeState) => void> = new Set();

  // ─── Singleton ─────────────────────────────────────────────────────────────

  static getInstance(): DapBridge {
    if (!DapBridge.instance) {
      DapBridge.instance = new DapBridge();
    }
    return DapBridge.instance;
  }

  private constructor() {}

  // ─── Lifecycle ─────────────────────────────────────────────────────────────

  /** Initialize event listeners. Call once on app startup. */
  async init(): Promise<void> {
    this.unlistenStopped = await listen<DebuggerEventPayload>(
      "debugger-event",
      (event) => {
        const { event_type, body, session_id } = event.payload;

        if (event_type === "stopped" && body.reason === "breakpoint") {
          this.handleBreakpointHit(session_id, body);
        }

        if (event_type === "continued") {
          this.cancelAnalysis();
        }
      }
    );
  }

  /** Tear down event listeners. Call on app unmount. */
  async destroy(): Promise<void> {
    this.cancelAnalysis();
    this.unlistenStopped?.();
    this.unlistenContinued?.();
    this.unlistenStopped = null;
    this.unlistenContinued = null;
  }

  // ─── State Management ──────────────────────────────────────────────────────

  /** Get current state snapshot. */
  getState(): DapBridgeState {
    return { ...this._state };
  }

  /** Subscribe to state changes. Returns unsubscribe function. */
  subscribe(listener: (state: DapBridgeState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private setState(partial: Partial<DapBridgeState>): void {
    this._state = { ...this._state, ...partial };
    for (const listener of this.listeners) {
      listener(this._state);
    }
  }

  // ─── Core Methods ──────────────────────────────────────────────────────────

  /**
   * Called when a DAP "stopped" event is received with reason "breakpoint".
   * Collects debug context and sends to AI for analysis.
   */
  async onBreakpointHit(params: {
    sessionId: string;
    stackFrames: StackFrame[];
    variables: Variable[];
    diagnostics: Diagnostic[];
    filePath: string;
    line: number;
  }): Promise<DapAnalysisResult | null> {
    // Check the setting toggle
    if (!this.isEnabled()) {
      return null;
    }

    // Cancel any previous in-progress analysis
    this.cancelAnalysis();

    const payload: DebugContextPayload = {
      sessionId: params.sessionId,
      stackFrames: params.stackFrames.slice(0, MAX_STACK_FRAMES),
      localVariables: params.variables,
      diagnostics: params.diagnostics,
      filePath: params.filePath,
      line: params.line,
      sourceSnippet: this.getSourceSnippet(params.filePath, params.line),
    };

    this.setState({
      status: "collecting",
      streamingText: "",
      result: null,
      errorMessage: null,
      canRetry: false,
      lastPayload: payload,
    });

    return this.runAnalysis(payload);
  }

  /** Cancel any in-progress analysis (called on resume/step). */
  cancelAnalysis(): void {
    // Abort the active stream
    if (this.activeAbortController) {
      this.activeAbortController.abort();
      this.activeAbortController = null;
    }

    // Cancel the native stream if active
    if (this.currentStreamId) {
      invoke("cancel_llm_stream", { streamId: this.currentStreamId }).catch(() => {});
      this.currentStreamId = null;
    }

    // Clear timeout
    if (this.timeoutHandle) {
      clearTimeout(this.timeoutHandle);
      this.timeoutHandle = null;
    }

    // Unlisten stream events
    if (this.unlistenStream) {
      this.unlistenStream();
      this.unlistenStream = null;
    }

    // Reset state
    this.setState({
      status: "idle",
      streamingText: "",
      result: null,
      errorMessage: null,
      canRetry: false,
    });
  }

  /**
   * User asks a follow-up question about the current program state.
   * @see Requirements 3.6
   */
  async askFollowUp(
    question: string,
    currentState: {
      stackFrames: StackFrame[];
      variables: Variable[];
      sessionId: string;
    }
  ): Promise<string | null> {
    if (!this.isEnabled()) {
      return null;
    }

    const abortController = new AbortController();
    this.activeAbortController = abortController;

    const streamId = `${STREAM_ID_PREFIX}followup-${Date.now()}`;
    this.currentStreamId = streamId;

    this.setState({
      status: "streaming",
      streamingText: "",
      errorMessage: null,
      canRetry: false,
    });

    const systemPrompt = this.buildFollowUpSystemPrompt(currentState);
    const userPrompt = question;

    const settings = useSettingsStore.getState().config;

    try {
      // Set up timeout
      const timeoutPromise = new Promise<"timeout">((resolve) => {
        this.timeoutHandle = setTimeout(() => resolve("timeout"), ANALYSIS_TIMEOUT_MS);
      });

      // Set up stream listener
      let fullText = "";
      const streamPromise = new Promise<string>((resolve, reject) => {
        listen<{ stream_id: string; token: string; done: boolean }>(
          "llm-stream",
          (event) => {
            if (event.payload.stream_id !== streamId) return;
            if (abortController.signal.aborted) return;

            if (event.payload.done) {
              resolve(fullText);
              return;
            }

            fullText += event.payload.token;
            this.setState({ streamingText: fullText });
          }
        ).then((unlisten) => {
          this.unlistenStream = unlisten;
        });

        // Start the stream
        startStream(
          {
            provider: settings.provider,
            api_key: settings.providerKeys[settings.provider] || settings.api_key,
            model: settings.model,
            system_prompt: systemPrompt,
            user_prompt: userPrompt,
          },
          streamId
        ).catch((err) => {
          if (!abortController.signal.aborted) {
            reject(err);
          }
        });
      });

      const result = await Promise.race([streamPromise, timeoutPromise]);

      if (this.timeoutHandle) {
        clearTimeout(this.timeoutHandle);
        this.timeoutHandle = null;
      }

      if (result === "timeout") {
        this.handleTimeout();
        return null;
      }

      this.setState({ status: "complete", streamingText: result });
      return result;
    } catch (err) {
      if (abortController.signal.aborted) return null;
      const message = err instanceof Error ? err.message : String(err);
      this.setState({
        status: "error",
        errorMessage: message,
        canRetry: true,
      });
      return null;
    } finally {
      this.unlistenStream?.();
      this.unlistenStream = null;
      this.activeAbortController = null;
      this.currentStreamId = null;
    }
  }

  /**
   * Retry the last failed or timed-out analysis.
   */
  async retry(): Promise<DapAnalysisResult | null> {
    const payload = this._state.lastPayload;
    if (!payload) return null;
    return this.runAnalysis(payload);
  }

  // ─── Private Methods ───────────────────────────────────────────────────────

  /** Check whether agent-assisted debugging is enabled in settings. */
  private isEnabled(): boolean {
    const config = useSettingsStore.getState().config;
    return config.agentAssistedDebugging !== false;
  }

  /**
   * Internal handler when the DAP "stopped" event fires with reason "breakpoint".
   */
  private async handleBreakpointHit(
    sessionId: string,
    body: Record<string, unknown>
  ): Promise<void> {
    if (!this.isEnabled()) return;

    const threadId = body.threadId as number | undefined;
    if (threadId === undefined) return;

    this.setState({ status: "collecting" });

    try {
      // Collect stack frames (up to 20)
      const stackTraceResponse = await invoke<{
        body: { stackFrames: StackFrame[]; totalFrames?: number };
      }>("dap_send_request", {
        sessionId,
        request: {
          command: "stackTrace",
          arguments: { threadId, levels: MAX_STACK_FRAMES },
        },
      });

      const stackFrames = stackTraceResponse.body.stackFrames || [];

      // Get the top frame for variable inspection
      const topFrame = stackFrames[0];
      let variables: Variable[] = [];

      if (topFrame) {
        try {
          // Get scopes for the top frame
          const scopesResponse = await invoke<{
            body: { scopes: Array<{ variablesReference: number; name: string }> };
          }>("dap_send_request", {
            sessionId,
            request: {
              command: "scopes",
              arguments: { frameId: topFrame.id },
            },
          });

          // Get local variables from the first "Locals" scope
          const localScope = scopesResponse.body.scopes.find(
            (s) => s.name === "Locals" || s.name === "Local"
          ) ?? scopesResponse.body.scopes[0];

          if (localScope) {
            const varsResponse = await invoke<{
              body: { variables: Variable[] };
            }>("dap_send_request", {
              sessionId,
              request: {
                command: "variables",
                arguments: { variablesReference: localScope.variablesReference },
              },
            });
            variables = varsResponse.body.variables || [];
          }
        } catch {
          // Variables collection failed — continue without them
        }
      }

      // Gather diagnostics from the editor store for the breakpoint file
      const filePath = topFrame?.source?.path ?? "";
      const line = topFrame?.line ?? 0;
      const allDiagnostics = useEditorStore.getState().diagnostics;
      const relevantDiagnostics = allDiagnostics.filter(
        (d) => d.path === filePath && (d.severity === "error" || d.severity === "warning")
      );

      // Trigger the analysis
      await this.onBreakpointHit({
        sessionId,
        stackFrames,
        variables,
        diagnostics: relevantDiagnostics,
        filePath,
        line,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.setState({
        status: "error",
        errorMessage: `Failed to collect debug context: ${message}`,
        canRetry: true,
      });
    }
  }

  /**
   * Run AI analysis on the assembled debug context payload.
   */
  private async runAnalysis(
    payload: DebugContextPayload
  ): Promise<DapAnalysisResult | null> {
    const abortController = new AbortController();
    this.activeAbortController = abortController;

    const streamId = `${STREAM_ID_PREFIX}${Date.now()}`;
    this.currentStreamId = streamId;

    this.setState({ status: "streaming", streamingText: "" });

    const systemPrompt = this.buildAnalysisSystemPrompt();
    const userPrompt = this.buildAnalysisUserPrompt(payload);

    const settings = useSettingsStore.getState().config;

    try {
      // Set up timeout
      const timeoutPromise = new Promise<"timeout">((resolve) => {
        this.timeoutHandle = setTimeout(() => resolve("timeout"), ANALYSIS_TIMEOUT_MS);
      });

      // Set up stream listener
      let fullText = "";
      const streamPromise = new Promise<string>((resolve, reject) => {
        listen<{ stream_id: string; token: string; done: boolean }>(
          "llm-stream",
          (event) => {
            if (event.payload.stream_id !== streamId) return;
            if (abortController.signal.aborted) return;

            // Clear timeout on first token — analysis has begun
            if (fullText === "" && event.payload.token) {
              if (this.timeoutHandle) {
                clearTimeout(this.timeoutHandle);
                this.timeoutHandle = null;
              }
            }

            if (event.payload.done) {
              resolve(fullText);
              return;
            }

            fullText += event.payload.token;
            this.setState({ streamingText: fullText });
          }
        ).then((unlisten) => {
          this.unlistenStream = unlisten;
        });

        // Start the stream
        startStream(
          {
            provider: settings.provider,
            api_key: settings.providerKeys[settings.provider] || settings.api_key,
            model: settings.model,
            system_prompt: systemPrompt,
            user_prompt: userPrompt,
          },
          streamId
        ).catch((err) => {
          if (!abortController.signal.aborted) {
            reject(err);
          }
        });
      });

      const result = await Promise.race([streamPromise, timeoutPromise]);

      if (this.timeoutHandle) {
        clearTimeout(this.timeoutHandle);
        this.timeoutHandle = null;
      }

      if (result === "timeout") {
        this.handleTimeout();
        return null;
      }

      // Parse the AI response into structured result
      const analysisResult = this.parseAnalysisResponse(result);
      this.setState({
        status: "complete",
        result: analysisResult,
        streamingText: result,
      });

      return analysisResult;
    } catch (err) {
      if (abortController.signal.aborted) return null;
      const message = err instanceof Error ? err.message : String(err);
      this.setState({
        status: "error",
        errorMessage: message,
        canRetry: true,
      });
      return null;
    } finally {
      this.unlistenStream?.();
      this.unlistenStream = null;
      this.activeAbortController = null;
      this.currentStreamId = null;
    }
  }

  /** Handle timeout — show "Analysis unavailable" with retry. */
  private handleTimeout(): void {
    // Cancel the stream
    if (this.currentStreamId) {
      invoke("cancel_llm_stream", { streamId: this.currentStreamId }).catch(() => {});
    }
    this.unlistenStream?.();
    this.unlistenStream = null;
    this.activeAbortController = null;
    this.currentStreamId = null;

    this.setState({
      status: "timeout",
      errorMessage: "Analysis unavailable — AI did not respond within 5 seconds.",
      canRetry: true,
    });
  }

  /** Get a source code snippet around the breakpoint line. */
  private getSourceSnippet(filePath: string, line: number): string {
    const tabs = useEditorStore.getState().tabs;
    const tab = tabs.find((t) => t.path === filePath);
    if (!tab) return "";

    const lines = tab.content.split("\n");
    const start = Math.max(0, line - 6); // 5 lines above
    const end = Math.min(lines.length, line + 5); // 5 lines below
    return lines
      .slice(start, end)
      .map((l, i) => {
        const lineNum = start + i + 1;
        const marker = lineNum === line ? ">>>" : "   ";
        return `${marker} ${lineNum}: ${l}`;
      })
      .join("\n");
  }

  /** Build the system prompt for breakpoint analysis. */
  private buildAnalysisSystemPrompt(): string {
    return `You are an expert debugger assistant embedded in an IDE. When a breakpoint is hit, you analyze the program state and provide:

1. **Root Cause Analysis**: Explain what's happening at this breakpoint and why the code reached this state.
2. **Variable Insights**: Highlight any suspicious variable values or unexpected state.
3. **Watch Suggestions**: Suggest up to 5 watch expressions that would help the developer understand the issue. Format each on its own line prefixed with "WATCH:" (e.g., "WATCH: obj.property.length").
4. **Fix Suggestion** (if applicable): If you identify a likely bug, suggest a fix. Format the fix as:
   FIX_START
   file: <file_path>
   explanation: <brief explanation>
   \`\`\`
   <corrected code patch>
   \`\`\`
   FIX_END

Keep your analysis concise but thorough. Focus on actionable insights.`;
  }

  /** Build the user prompt from the debug context payload. */
  private buildAnalysisUserPrompt(payload: DebugContextPayload): string {
    const parts: string[] = [];

    parts.push(`## Breakpoint Hit\n**File:** ${payload.filePath}\n**Line:** ${payload.line}\n`);

    if (payload.sourceSnippet) {
      parts.push(`## Source Code\n\`\`\`\n${payload.sourceSnippet}\n\`\`\`\n`);
    }

    if (payload.stackFrames.length > 0) {
      parts.push("## Call Stack");
      for (const frame of payload.stackFrames.slice(0, 10)) {
        const loc = frame.source?.path
          ? `${frame.source.name || frame.source.path}:${frame.line}`
          : `<unknown>:${frame.line}`;
        parts.push(`- ${frame.name} (${loc})`);
      }
      if (payload.stackFrames.length > 10) {
        parts.push(`  ... and ${payload.stackFrames.length - 10} more frames`);
      }
      parts.push("");
    }

    if (payload.localVariables.length > 0) {
      parts.push("## Local Variables");
      for (const v of payload.localVariables.slice(0, 30)) {
        const typeStr = v.type ? ` (${v.type})` : "";
        parts.push(`- \`${v.name}\`${typeStr} = ${v.value}`);
      }
      parts.push("");
    }

    if (payload.diagnostics.length > 0) {
      parts.push("## Active Diagnostics");
      for (const d of payload.diagnostics) {
        parts.push(`- [${d.severity}] Line ${d.line}: ${d.message}`);
      }
      parts.push("");
    }

    parts.push("Please analyze this breakpoint context and provide insights.");

    return parts.join("\n");
  }

  /** Build system prompt for follow-up questions. */
  private buildFollowUpSystemPrompt(currentState: {
    stackFrames: StackFrame[];
    variables: Variable[];
  }): string {
    const contextLines: string[] = [
      "You are a debugger assistant. The user is paused at a breakpoint and asking a follow-up question about the current program state.",
      "",
      "Current stack frames:",
    ];

    for (const frame of currentState.stackFrames.slice(0, 5)) {
      contextLines.push(`  - ${frame.name} at line ${frame.line}`);
    }

    contextLines.push("", "Current local variables:");
    for (const v of currentState.variables.slice(0, 15)) {
      contextLines.push(`  - ${v.name} = ${v.value}`);
    }

    contextLines.push("", "Answer concisely and helpfully.");

    return contextLines.join("\n");
  }

  /** Parse structured result from the AI response text. */
  private parseAnalysisResponse(text: string): DapAnalysisResult {
    const result: DapAnalysisResult = {
      analysis: text,
      watchSuggestions: [],
    };

    // Extract watch suggestions (lines starting with "WATCH:")
    const watchRegex = /^WATCH:\s*(.+)$/gm;
    let match: RegExpExecArray | null;
    while ((match = watchRegex.exec(text)) !== null) {
      if (result.watchSuggestions.length < 5) {
        result.watchSuggestions.push(match[1].trim());
      }
    }

    // Extract fix suggestion (between FIX_START and FIX_END)
    const fixRegex = /FIX_START\s*\nfile:\s*(.+)\nexplanation:\s*(.+)\n```[\s\S]*?\n([\s\S]*?)```\s*\nFIX_END/;
    const fixMatch = fixRegex.exec(text);
    if (fixMatch) {
      result.suggestedFix = {
        filePath: fixMatch[1].trim(),
        explanation: fixMatch[2].trim(),
        patch: fixMatch[3].trim(),
      };
    }

    // Clean analysis text by removing the structured markers
    result.analysis = text
      .replace(/^WATCH:\s*.+$/gm, "")
      .replace(/FIX_START[\s\S]*?FIX_END/, "")
      .trim();

    return result;
  }
}
