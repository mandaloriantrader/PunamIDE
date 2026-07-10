/**
 * TestGenPanel — AI-generated test generation panel with selective per-case
 * accept/reject before writing to disk.
 *
 * Triggers `TestGenerator.generate()` for the selected function, streams results,
 * presents cases via inline diff preview for selective accept/reject, then calls
 * `commitAndVerify()` with accepted case IDs and surfaces the run/refinement outcome.
 *
 * Requirements: 13.1, 13.4, 13.6
 */

import { useState, useCallback, useMemo, useRef, useEffect } from "react";
import {
  Play,
  Loader2,
  CheckCircle2,
  XCircle,
  Check,
  X,
  FlaskConical,
  AlertTriangle,
  RefreshCw,
  FileCode,
} from "lucide-react";
import { useSettingsStore } from "../store/settingsStore";
import { loadAIProviders } from "../utils/tauri";
import {
  TestGenerator,
  type GeneratedTestCase,
  type TestGenResult,
  type TestRunOutcome,
} from "../services/testgen/TestGenerator";
import type { AIProviderConfig } from "../utils/providers";
import { showToast } from "../utils/toast";

// ─── Types ─────────────────────────────────────────────────────────────────────

export interface TestGenSource {
  filePath: string;
  functionCode: string;
}

type PanelPhase =
  | "idle"
  | "generating"
  | "reviewing"
  | "committing"
  | "done";

type CaseDecision = "accepted" | "rejected" | "pending";

interface CaseState {
  caseData: GeneratedTestCase;
  decision: CaseDecision;
}

interface RunResult {
  outcome: TestRunOutcome | null;
  error: string | null;
}

// ─── Props ─────────────────────────────────────────────────────────────────────

interface TestGenPanelProps {
  /** Source function to generate tests for. */
  source: TestGenSource;
  /** Callback when the panel should be closed. */
  onClose?: () => void;
}

// ─── Helpers ───────────────────────────────────────────────────────────────────

function getCategoryBadgeClass(category: GeneratedTestCase["category"]): string {
  switch (category) {
    case "normal":
      return "bg-blue-900/30 text-blue-400 border-blue-700/50";
    case "edge":
      return "bg-yellow-900/30 text-yellow-400 border-yellow-700/50";
    case "error":
      return "bg-red-900/30 text-red-400 border-red-700/50";
  }
}

function getCategoryLabel(category: GeneratedTestCase["category"]): string {
  switch (category) {
    case "normal":
      return "Normal";
    case "edge":
      return "Edge";
    case "error":
      return "Error";
  }
}

// ─── CaseItem Component ────────────────────────────────────────────────────────

interface CaseItemProps {
  caseState: CaseState;
  onAccept: (id: string) => void;
  onReject: (id: string) => void;
}

function CaseItem({ caseState, onAccept, onReject }: CaseItemProps) {
  const [expanded, setExpanded] = useState(true);
  const { caseData, decision } = caseState;

  const isResolved = decision !== "pending";

  return (
    <div
      className={`border rounded px-3 py-2 transition-colors ${
        decision === "accepted"
          ? "border-green-700/50 bg-green-900/10"
          : decision === "rejected"
          ? "border-red-700/50 bg-red-900/10 opacity-60"
          : "border-gray-700/40 bg-transparent"
      }`}
      role="listitem"
      aria-label={`Test case: ${caseData.title}`}
    >
      {/* Header row */}
      <div className="flex items-center gap-2">
        {/* Decision icon */}
        {decision === "accepted" && (
          <CheckCircle2 size={14} className="text-green-400 shrink-0" />
        )}
        {decision === "rejected" && (
          <XCircle size={14} className="text-red-400 shrink-0" />
        )}
        {decision === "pending" && (
          <FlaskConical size={14} className="text-gray-400 shrink-0" />
        )}

        {/* Title */}
        <button
          className="flex-1 text-left text-xs text-gray-200 truncate hover:text-white transition-colors"
          onClick={() => setExpanded(!expanded)}
          aria-expanded={expanded}
          aria-label={`Toggle code preview for: ${caseData.title}`}
        >
          {caseData.title}
        </button>

        {/* Category badge */}
        <span
          className={`text-[9px] px-1.5 py-0.5 rounded border font-medium shrink-0 ${getCategoryBadgeClass(
            caseData.category
          )}`}
        >
          {getCategoryLabel(caseData.category)}
        </span>

        {/* Accept/Reject buttons */}
        {!isResolved && (
          <div className="flex items-center gap-1 shrink-0">
            <button
              className="p-1 rounded hover:bg-green-900/30 text-gray-400 hover:text-green-400 transition-colors"
              onClick={() => onAccept(caseData.id)}
              title="Accept this test case"
              aria-label={`Accept test case: ${caseData.title}`}
            >
              <Check size={14} />
            </button>
            <button
              className="p-1 rounded hover:bg-red-900/30 text-gray-400 hover:text-red-400 transition-colors"
              onClick={() => onReject(caseData.id)}
              title="Reject this test case"
              aria-label={`Reject test case: ${caseData.title}`}
            >
              <X size={14} />
            </button>
          </div>
        )}
      </div>

      {/* Code preview */}
      {expanded && (
        <div className="mt-2">
          <pre className="text-[11px] text-gray-300 font-mono whitespace-pre-wrap break-words leading-relaxed bg-gray-900/50 rounded p-2 max-h-48 overflow-y-auto border border-gray-700/30">
            {caseData.code}
          </pre>
        </div>
      )}
    </div>
  );
}

// ─── Main Panel ────────────────────────────────────────────────────────────────

export default function TestGenPanel({ source, onClose }: TestGenPanelProps) {
  const config = useSettingsStore((s) => s.config);

  const [phase, setPhase] = useState<PanelPhase>("idle");
  const [cases, setCases] = useState<CaseState[]>([]);
  const [result, setResult] = useState<TestGenResult | null>(null);
  const [runResult, setRunResult] = useState<RunResult>({ outcome: null, error: null });
  const [genError, setGenError] = useState<string | null>(null);

  // Track the generator instance for the current session
  const generatorRef = useRef<TestGenerator | null>(null);

  // ── Derived state ──────────────────────────────────────────────────────────

  const acceptedCount = useMemo(
    () => cases.filter((c) => c.decision === "accepted").length,
    [cases]
  );

  const rejectedCount = useMemo(
    () => cases.filter((c) => c.decision === "rejected").length,
    [cases]
  );

  const pendingCount = useMemo(
    () => cases.filter((c) => c.decision === "pending").length,
    [cases]
  );

  const acceptedIds = useMemo(
    () => new Set(cases.filter((c) => c.decision === "accepted").map((c) => c.caseData.id)),
    [cases]
  );

  const allDecided = pendingCount === 0 && cases.length > 0;

  // ── Resolve provider ───────────────────────────────────────────────────────

  const resolveProvider = useCallback(async (): Promise<{
    provider: AIProviderConfig;
    modelId: string;
  } | null> => {
    try {
      const providers = await loadAIProviders();
      const activeProvider = providers.find(
        (p) => p.apiKey || p.name === "Ollama (Local)"
      );
      if (!activeProvider) {
        showToast("No AI provider configured. Please add one in Settings.", "warning");
        return null;
      }
      const modelId =
        config.model ||
        activeProvider.models.find((m) => m.enabled)?.id ||
        "";
      if (!modelId) {
        showToast("No AI model selected. Please configure one in Settings.", "warning");
        return null;
      }
      return { provider: activeProvider, modelId };
    } catch {
      showToast("Failed to load AI providers.", "error");
      return null;
    }
  }, [config.model]);

  // ── Generate tests ─────────────────────────────────────────────────────────

  const handleGenerate = useCallback(async () => {
    setPhase("generating");
    setGenError(null);
    setCases([]);
    setResult(null);
    setRunResult({ outcome: null, error: null });

    const resolved = await resolveProvider();
    if (!resolved) {
      setPhase("idle");
      return;
    }

    const generator = new TestGenerator(resolved.provider, resolved.modelId);
    generatorRef.current = generator;

    try {
      const genResult = await generator.generate(source);

      if (genResult.cases.length === 0) {
        setGenError("No test cases were generated. Try a different function or check your AI provider.");
        setPhase("idle");
        return;
      }

      // Initialize all cases as "pending"
      const initialCases: CaseState[] = genResult.cases.map((c) => ({
        caseData: c,
        decision: "pending" as CaseDecision,
      }));

      setResult(genResult);
      setCases(initialCases);
      setPhase("reviewing");
    } catch (err) {
      const message = err instanceof Error ? err.message : "Generation failed.";
      setGenError(message);
      setPhase("idle");
    }
  }, [source, resolveProvider]);

  // ── Accept / Reject handlers ───────────────────────────────────────────────

  const handleAccept = useCallback((id: string) => {
    setCases((prev) =>
      prev.map((c) =>
        c.caseData.id === id ? { ...c, decision: "accepted" } : c
      )
    );
  }, []);

  const handleReject = useCallback((id: string) => {
    setCases((prev) =>
      prev.map((c) =>
        c.caseData.id === id ? { ...c, decision: "rejected" } : c
      )
    );
  }, []);

  const handleAcceptAll = useCallback(() => {
    setCases((prev) =>
      prev.map((c) =>
        c.decision === "pending" ? { ...c, decision: "accepted" } : c
      )
    );
  }, []);

  const handleRejectAll = useCallback(() => {
    setCases((prev) =>
      prev.map((c) =>
        c.decision === "pending" ? { ...c, decision: "rejected" } : c
      )
    );
  }, []);

  // ── Commit and verify ──────────────────────────────────────────────────────

  const handleCommitAndVerify = useCallback(async () => {
    if (!result || acceptedCount === 0) return;

    setPhase("committing");
    setRunResult({ outcome: null, error: null });

    const generator = generatorRef.current;
    if (!generator) {
      setRunResult({ outcome: null, error: "Generator instance lost. Please regenerate." });
      setPhase("reviewing");
      return;
    }

    try {
      const outcome = await generator.commitAndVerify(result, acceptedIds);
      setRunResult({ outcome, error: null });
      setPhase("done");
    } catch (err) {
      const message = err instanceof Error ? err.message : "Commit & verify failed.";
      setRunResult({ outcome: null, error: message });
      setPhase("reviewing");
    }
  }, [result, acceptedIds, acceptedCount]);

  // ── Reset ──────────────────────────────────────────────────────────────────

  const handleReset = useCallback(() => {
    setPhase("idle");
    setCases([]);
    setResult(null);
    setRunResult({ outcome: null, error: null });
    setGenError(null);
    generatorRef.current = null;
  }, []);

  // ── Keyboard shortcut: Escape to close ─────────────────────────────────────

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape" && onClose) {
        e.preventDefault();
        onClose();
      }
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [onClose]);

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <div
      className="flex flex-col h-full bg-[#1e1e2e] text-gray-200 overflow-hidden"
      role="region"
      aria-label="Test generation panel"
    >
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-gray-700/50">
        <div className="flex items-center gap-2">
          <FlaskConical size={16} className="text-blue-400" />
          <span className="text-xs font-medium text-gray-200">Test Generator</span>
        </div>
        <div className="flex items-center gap-1">
          {phase !== "idle" && phase !== "generating" && (
            <button
              className="p-1 rounded hover:bg-gray-700/50 text-gray-400 hover:text-gray-200 transition-colors"
              onClick={handleReset}
              title="Reset and regenerate"
              aria-label="Reset test generation"
            >
              <RefreshCw size={14} />
            </button>
          )}
          {onClose && (
            <button
              className="p-1 rounded hover:bg-gray-700/50 text-gray-400 hover:text-gray-200 transition-colors"
              onClick={onClose}
              title="Close panel (Escape)"
              aria-label="Close test generation panel"
            >
              <X size={14} />
            </button>
          )}
        </div>
      </div>

      {/* Source info bar */}
      <div className="flex items-center gap-2 px-3 py-1.5 border-b border-gray-700/30 bg-gray-800/30">
        <FileCode size={12} className="text-gray-500" />
        <span className="text-[10px] text-gray-400 font-mono truncate" title={source.filePath}>
          {source.filePath.split(/[/\\]/).pop()}
        </span>
      </div>

      {/* Content area */}
      <div className="flex-1 overflow-y-auto px-3 py-2">
        {/* Idle state: show Generate button */}
        {phase === "idle" && (
          <div className="flex flex-col items-center justify-center h-full gap-3">
            {genError && (
              <div className="flex items-start gap-2 text-xs text-red-400 bg-red-900/20 border border-red-700/30 rounded px-3 py-2 w-full">
                <AlertTriangle size={14} className="shrink-0 mt-0.5" />
                <span>{genError}</span>
              </div>
            )}
            <button
              className="flex items-center gap-2 px-4 py-2 rounded bg-blue-600 hover:bg-blue-500 text-white text-xs font-medium transition-colors"
              onClick={handleGenerate}
              aria-label="Generate tests for the selected function"
            >
              <Play size={14} />
              Generate Tests
            </button>
            <span className="text-[10px] text-gray-500 text-center max-w-[200px]">
              AI will generate test cases covering normal, edge, and error scenarios.
            </span>
          </div>
        )}

        {/* Generating state: loading indicator */}
        {phase === "generating" && (
          <div className="flex flex-col items-center justify-center h-full gap-3">
            <Loader2 size={24} className="text-blue-400 animate-spin" />
            <span className="text-xs text-gray-400">Generating test cases…</span>
            <span className="text-[10px] text-gray-500">
              Streaming from AI provider
            </span>
          </div>
        )}

        {/* Reviewing state: show cases for accept/reject */}
        {phase === "reviewing" && (
          <div className="space-y-2">
            {/* Summary bar */}
            <div className="flex items-center justify-between text-[10px] text-gray-400 pb-1 border-b border-gray-700/30">
              <span>
                {cases.length} case{cases.length !== 1 ? "s" : ""} generated
                {result?.targetPath && (
                  <> → <span className="font-mono text-gray-500">{result.targetPath.split(/[/\\]/).pop()}</span></>
                )}
              </span>
              <div className="flex items-center gap-2">
                <span className="text-green-400">{acceptedCount} accepted</span>
                <span className="text-red-400">{rejectedCount} rejected</span>
                <span>{pendingCount} pending</span>
              </div>
            </div>

            {/* Bulk actions */}
            {pendingCount > 0 && (
              <div className="flex items-center gap-2 pb-1">
                <button
                  className="text-[10px] px-2 py-0.5 rounded bg-green-900/20 border border-green-700/40 text-green-400 hover:bg-green-900/40 transition-colors"
                  onClick={handleAcceptAll}
                  aria-label="Accept all pending test cases"
                >
                  Accept All
                </button>
                <button
                  className="text-[10px] px-2 py-0.5 rounded bg-red-900/20 border border-red-700/40 text-red-400 hover:bg-red-900/40 transition-colors"
                  onClick={handleRejectAll}
                  aria-label="Reject all pending test cases"
                >
                  Reject All
                </button>
              </div>
            )}

            {/* Error from commit attempt */}
            {runResult.error && (
              <div className="flex items-start gap-2 text-xs text-red-400 bg-red-900/20 border border-red-700/30 rounded px-3 py-2">
                <AlertTriangle size={14} className="shrink-0 mt-0.5" />
                <span>{runResult.error}</span>
              </div>
            )}

            {/* Case list */}
            <div className="space-y-1.5" role="list" aria-label="Generated test cases">
              {cases.map((caseState) => (
                <CaseItem
                  key={caseState.caseData.id}
                  caseState={caseState}
                  onAccept={handleAccept}
                  onReject={handleReject}
                />
              ))}
            </div>
          </div>
        )}

        {/* Committing state */}
        {phase === "committing" && (
          <div className="flex flex-col items-center justify-center h-full gap-3">
            <Loader2 size={24} className="text-blue-400 animate-spin" />
            <span className="text-xs text-gray-400">Writing tests & running…</span>
            <span className="text-[10px] text-gray-500">
              {acceptedCount} case{acceptedCount !== 1 ? "s" : ""} accepted
            </span>
          </div>
        )}

        {/* Done state: show outcome */}
        {phase === "done" && runResult.outcome && (
          <div className="space-y-3">
            {/* Outcome banner */}
            <div
              className={`flex items-center gap-2 px-3 py-2 rounded border ${
                runResult.outcome.passed
                  ? "bg-green-900/20 border-green-700/40 text-green-400"
                  : "bg-yellow-900/20 border-yellow-700/40 text-yellow-400"
              }`}
              role="status"
              aria-live="polite"
            >
              {runResult.outcome.passed ? (
                <CheckCircle2 size={16} />
              ) : (
                <AlertTriangle size={16} />
              )}
              <div className="flex-1">
                <div className="text-xs font-medium">
                  {runResult.outcome.passed ? "Tests passed!" : "Tests have issues"}
                </div>
                <div className="text-[10px] opacity-80 mt-0.5">
                  {runResult.outcome.refinementApplied
                    ? `Refinement applied (${runResult.outcome.refinementPasses} pass${
                        runResult.outcome.refinementPasses !== 1 ? "es" : ""
                      })`
                    : runResult.outcome.passed
                    ? "All tests passed on first run"
                    : "Auto-refinement was unable to fix all issues"}
                </div>
              </div>
            </div>

            {/* Target path */}
            <div className="flex items-center gap-2 text-[10px] text-gray-400">
              <FileCode size={12} />
              <span className="font-mono truncate" title={runResult.outcome.targetPath}>
                {runResult.outcome.targetPath}
              </span>
            </div>

            {/* Test output */}
            {runResult.outcome.output && (
              <div>
                <div className="text-[10px] text-gray-500 font-medium mb-1">Test Output</div>
                <pre className="text-[10px] text-gray-300 font-mono whitespace-pre-wrap break-words leading-relaxed bg-gray-900/50 rounded p-2 max-h-48 overflow-y-auto border border-gray-700/30">
                  {runResult.outcome.output}
                </pre>
              </div>
            )}

            {/* Actions */}
            <div className="flex items-center gap-2">
              <button
                className="flex items-center gap-1 text-[10px] px-2 py-1 rounded bg-blue-900/20 border border-blue-700/40 text-blue-400 hover:bg-blue-900/40 transition-colors"
                onClick={handleReset}
                aria-label="Generate more tests"
              >
                <RefreshCw size={12} />
                Generate Again
              </button>
              {onClose && (
                <button
                  className="text-[10px] px-2 py-1 rounded bg-gray-800/50 border border-gray-700/40 text-gray-400 hover:bg-gray-700/50 transition-colors"
                  onClick={onClose}
                  aria-label="Close panel"
                >
                  Close
                </button>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Footer action bar — visible during reviewing phase */}
      {phase === "reviewing" && (
        <div className="flex items-center justify-between px-3 py-2 border-t border-gray-700/50 bg-gray-800/30">
          <span className="text-[10px] text-gray-500">
            {allDecided
              ? acceptedCount > 0
                ? "Ready to commit"
                : "All cases rejected"
              : `${pendingCount} case${pendingCount !== 1 ? "s" : ""} pending review`}
          </span>
          <button
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded text-xs font-medium transition-colors ${
              acceptedCount > 0
                ? "bg-green-600 hover:bg-green-500 text-white"
                : "bg-gray-700 text-gray-500 cursor-not-allowed"
            }`}
            onClick={handleCommitAndVerify}
            disabled={acceptedCount === 0}
            title={
              acceptedCount === 0
                ? "Accept at least one case to proceed"
                : `Commit ${acceptedCount} case${acceptedCount !== 1 ? "s" : ""} and run`
            }
            aria-label={`Confirm and run ${acceptedCount} accepted test cases`}
          >
            <Play size={12} />
            Confirm & Run
          </button>
        </div>
      )}
    </div>
  );
}
