/**
 * CiDashboard.tsx — Phase 9, Steps 9.5 + 9.6
 *
 * CI/CD pipeline status, failure alerts, fix proposals with diff preview,
 * and approve/reject workflow. Human-in-the-loop approval gate.
 */

import { useState, useEffect, useCallback } from "react";
import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  XCircle,
  Clock,
  Loader2,
  RefreshCw,
  ExternalLink,
  ChevronDown,
  ChevronRight,
  Play,
  Shield,
  GitBranch,
  Eye,
  Check,
  X,
} from "lucide-react";
import { getCiMonitor } from "../services/ci/CiMonitor";
import { getLogAnalyzer } from "../services/ci/LogAnalyzer";
import { getPatchGenerator } from "../services/ci/PatchGenerator";
import { getVerificationRunner } from "../services/ci/VerificationRunner";
import type { CiWorkflowRun, CiFailureAnalysis, CiFixProposal, CiPipelineStatus } from "../services/ci/CiMonitor";

// ── Styles ────────────────────────────────────────────────────────────────────

const PANEL_STYLE: React.CSSProperties = {
  display: "flex", flexDirection: "column", height: "100%",
  background: "var(--bg-primary, #1a1a2e)", color: "var(--text-primary, #e0e0e0)",
  fontFamily: "var(--font-mono, 'JetBrains Mono', monospace)", overflow: "auto",
};

const HEADER_STYLE: React.CSSProperties = {
  padding: "12px 16px", borderBottom: "1px solid var(--border-color, #2a2a4a)",
  display: "flex", alignItems: "center", gap: "8px", fontSize: "13px", fontWeight: 600, flexShrink: 0,
};

const SECTION_STYLE: React.CSSProperties = {
  margin: "8px 16px", padding: "12px",
  background: "var(--bg-card, #16162a)", border: "1px solid var(--border-color, #2a2a4a)", borderRadius: "8px",
};

// ── Component ─────────────────────────────────────────────────────────────────

export default function CiDashboard({ projectPath }: { projectPath?: string }) {
  const [ciMonitor] = useState(() => getCiMonitor());
  const [failures, setFailures] = useState<CiWorkflowRun[]>([]);
  const [loading, setLoading] = useState(false);
  const [analyzing, setAnalyzing] = useState<string | null>(null);
  const [analyses, setAnalyses] = useState<Map<string, CiFailureAnalysis>>(new Map());
  const [patches, setPatches] = useState<Map<string, CiFixProposal>>(new Map());
  const [expandedFailure, setExpandedFailure] = useState<Set<string>>(new Set());
  const [watching, setWatching] = useState(false);
  const [approvals, setApprovals] = useState<Set<string>>(new Set());

  const checkFailures = useCallback(async () => {
    setLoading(true);
    try {
      let repoPath = "";
      if (projectPath) {
        try {
          const { invoke } = await import("@tauri-apps/api/core");
          const gitRemote = await invoke<string>("run_terminal_command", {
            command: "git remote get-url origin",
            cwd: projectPath,
          }).catch(() => "");
          const httpsMatch = gitRemote.match(/github\.com[/:]([^/]+)\/([^/]+)/);
          if (httpsMatch) {
            repoPath = `${httpsMatch[1]}/${httpsMatch[2].replace(/\.git$/, "")}`;
          }
        } catch { /* no git remote */ }
      }

      if (repoPath) {
        const recent = await ciMonitor.fetchWorkflowRuns(repoPath, 10);
        setFailures(recent.filter((w) => w.conclusion === "failure"));
      } else {
        setFailures([]);
      }
    } catch {
      // Silently handle — no auth configured
    } finally {
      setLoading(false);
    }
  }, [ciMonitor, projectPath]);

  const handleAnalyze = async (run: CiWorkflowRun) => {
    const key = `${run.id}`;
    setAnalyzing(key);
    try {
      const logAnalyzer = getLogAnalyzer();
      const fullAnalysis = await logAnalyzer.analyzeCiFailure(run);
      // Map to CiFailureAnalysis for display
      const analysis: CiFailureAnalysis = {
        runId: run.id,
        workflowName: run.name,
        rootCause: fullAnalysis.rootCause,
        failingStep: fullAnalysis.failingStep,
        errorLog: fullAnalysis.errorLog,
        failingFile: fullAnalysis.failingFile,
        suggestedFix: fullAnalysis.suggestions[0] || null,
        confidence: fullAnalysis.confidence,
        requiresHumanReview: true,
      };
      setAnalyses((prev) => new Map(prev).set(key, analysis));

      // Auto-generate fix proposal using PatchGenerator
      const patchGen = getPatchGenerator();
      const candidate = await patchGen.generateFixCandidate(analysis);
      const validation = await patchGen.validatePatch(candidate);
      const proposal = patchGen.createProposal(analysis, candidate, validation);
      setPatches((prev) => new Map(prev).set(key, proposal));
    } catch {
      // Handle error
    } finally {
      setAnalyzing(null);
    }
  };

  const toggleExpand = (id: string) => {
    const next = new Set(expandedFailure);
    if (next.has(id)) {
      next.delete(id);
    } else {
      next.add(id);
    }
    setExpandedFailure(next);
  };

  const handleApprove = async (key: string) => {
    // Run sandbox verification before approving
    const proposal = patches.get(key);
    if (proposal) {
      const runner = getVerificationRunner();
      const sandboxResult = await runner.runInSandbox(proposal);
      if (sandboxResult.passed) {
        setPatches((prev) => {
          const next = new Map(prev);
          const p = next.get(key);
          if (p) next.set(key, { ...p, testResults: { passed: true, output: sandboxResult.output }, status: "applied" });
          return next;
        });
        setApprovals((prev) => new Set(prev).add(key));
      } else {
        // Sandbox failed — show output but don't approve
        setPatches((prev) => {
          const next = new Map(prev);
          const p = next.get(key);
          if (p) next.set(key, { ...p, testResults: { passed: false, output: sandboxResult.output }, status: "rejected" });
          return next;
        });
      }
    } else {
      setApprovals((prev) => new Set(prev).add(key));
    }
  };

  const handleReject = (key: string) => {
    setApprovals((prev) => {
      const next = new Set(prev);
      next.delete(key);
      return next;
    });
  };

  return (
    <div style={PANEL_STYLE}>
      <div style={HEADER_STYLE}>
        <Activity size={16} />
        CI/CD Dashboard
        <span style={{ fontSize: "10px", color: "var(--text-secondary, #a0a0b0)", marginLeft: "auto" }}>Phase 9</span>
      </div>

      {/* Action bar */}
      <div style={{ padding: "8px 16px", display: "flex", gap: "8px", borderBottom: "1px solid var(--border-color, #2a2a4a)", flexShrink: 0 }}>
        <button onClick={checkFailures} disabled={loading}
          style={{ padding: "6px 14px", background: "var(--accent-color, #3b82f6)", border: "none",
            borderRadius: "6px", color: "#fff", fontSize: "11px", fontWeight: 600,
            cursor: loading ? "not-allowed" : "pointer", display: "flex", alignItems: "center", gap: "6px",
            fontFamily: "inherit", opacity: loading ? 0.5 : 1 }}>
          {loading ? <Loader2 size={12} style={{ animation: "spin 1s linear infinite" }} /> : <RefreshCw size={12} />}
          Check CI Status
        </button>
      </div>

      {/* Failures list */}
      {failures.length === 0 && !loading && (
        <div style={{ padding: "32px", textAlign: "center", color: "var(--text-secondary, #a0a0b0)", fontSize: "12px" }}>
          <CheckCircle2 size={24} style={{ marginBottom: "8px", opacity: 0.5 }} />
          <div>No recent CI failures detected</div>
          <div style={{ fontSize: "10px", marginTop: "4px", opacity: 0.7 }}>
            Connect GitHub to monitor Actions workflows
          </div>
        </div>
      )}

      {failures.map((run) => {
        const key = `${run.id}`;
        const isExpanded = expandedFailure.has(key);
        const analysis = analyses.get(key);
        const patch = patches.get(key);
        const isApproved = approvals.has(key);

        return (
          <div key={key} style={SECTION_STYLE}>
            {/* Failure header */}
            <button onClick={() => toggleExpand(key)}
              style={{ display: "flex", alignItems: "center", gap: "8px", width: "100%",
                background: "none", border: "none", cursor: "pointer", fontFamily: "inherit", padding: 0, textAlign: "left" }}>
              {isExpanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
              <XCircle size={14} color="#ef4444" />
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: "12px", fontWeight: 600 }}>{run.name}</div>
                <div style={{ fontSize: "10px", color: "var(--text-secondary, #a0a0b0)" }}>
                  {run.branch} · {new Date(run.createdAt).toLocaleDateString()}
                </div>
              </div>
              <a href={run.runUrl} target="_blank" rel="noopener noreferrer"
                style={{ color: "var(--text-secondary, #a0a0b0)" }}>
                <ExternalLink size={12} />
              </a>
            </button>

            {/* Expanded details */}
            {isExpanded && (
              <div style={{ marginTop: "10px", paddingLeft: "20px" }}>
                {/* Analyze button */}
                {!analysis && (
               <button onClick={() => handleAnalyze(run)} disabled={analyzing === key}
                    style={{ padding: "4px 10px", background: "#92400e20", border: "1px solid #fbbf2440",
                      borderRadius: "4px", color: "#fbbf24", fontSize: "10px", cursor: "pointer",
                      fontFamily: "inherit", display: "flex", alignItems: "center", gap: "4px" }}>
                    {analyzing === key ? <Loader2 size={10} style={{ animation: "spin 1s linear infinite" }} /> : <Shield size={10} />}
                    Analyze Failure
                  </button>
                )}

                {/* Analysis result */}
                {analysis && (
                  <div style={{ marginTop: "8px", padding: "8px", background: "var(--bg-input, #1a1a2e)", borderRadius: "4px", fontSize: "10px" }}>
                    <div style={{ fontWeight: 600, marginBottom: "4px", color: "#fbbf24" }}>Failure Analysis</div>
                    <div style={{ color: "var(--text-secondary, #a0a0b0)", lineHeight: 1.5 }}>
                      <div>Root cause: {analysis.rootCause}</div>
                      {analysis.failingFile && <div>Failing file: {analysis.failingFile}</div>}
                      <div>Failing step: {analysis.failingStep}</div>
                      <div>Suggested fix: {analysis.suggestedFix || "None — human review required"}</div>
                      <div style={{ marginTop: "4px", fontSize: "9px" }}>
                        Confidence: {Math.round(analysis.confidence * 100)}%
                      </div>
                    </div>
                  </div>
                )}

                {/* Patch result */}
                {patch && (
                  <div style={{ marginTop: "8px", padding: "8px", background: patch.status === "ready" ? "#065f4620" : "#7f1d1d20",
                    border: `1px solid ${patch.status === "ready" ? "#34d39940" : "#ef444440"}`, borderRadius: "4px", fontSize: "10px" }}>
                    <div style={{ fontWeight: 600, marginBottom: "4px", color: patch.status === "ready" ? "#34d399" : "#ef4444" }}>
                      {patch.status === "ready" ? "Fix Ready ✓" : "Fix Pending"}
                    </div>
                    <div style={{ color: "var(--text-secondary, #a0a0b0)", lineHeight: 1.5 }}>
                      <div>Affected files: {patch.affectedFiles.join(", ") || "none"}</div>
                      <div>Status: {patch.status}</div>
                      {patch.analysis.errorLog && (
                        <div style={{ marginTop: "4px", color: "#ef4444" }}>
                          <div>• {patch.analysis.errorLog.slice(0, 200)}</div>
                        </div>
                      )}
                    </div>

                    {/* Approve/Reject */}
                    {!isApproved ? (
                      <div style={{ display: "flex", gap: "8px", marginTop: "8px" }}>
                        <button onClick={() => handleApprove(key)}
                          style={{ padding: "4px 12px", background: "#065f4640", border: "1px solid #34d39940",
                            borderRadius: "4px", color: "#34d399", fontSize: "10px", cursor: "pointer",
                            fontFamily: "inherit", display: "flex", alignItems: "center", gap: "4px" }}>
                          <Check size={10} /> Approve & Apply
                        </button>
                        <button onClick={() => handleReject(key)}
                          style={{ padding: "4px 12px", background: "#7f1d1d40", border: "1px solid #ef444440",
                            borderRadius: "4px", color: "#ef4444", fontSize: "10px", cursor: "pointer",
                            fontFamily: "inherit", display: "flex", alignItems: "center", gap: "4px" }}>
                          <X size={10} /> Reject
                        </button>
                      </div>
                    ) : (
                      <div style={{ marginTop: "8px", color: "#34d399", fontSize: "10px", display: "flex", alignItems: "center", gap: "4px" }}>
                        <CheckCircle2 size={10} /> Approved — ready to apply
                      </div>
                    )}
                  </div>
                )}

                {/* Human approval gate */}
                <div style={{ marginTop: "8px", padding: "6px 8px", background: "#1e3a5f20", border: "1px solid #60a5fa40",
                  borderRadius: "4px", fontSize: "9px", color: "#60a5fa", display: "flex", alignItems: "center", gap: "4px" }}>
                  <Shield size={10} />
                  Human approval required — no auto-deploy. Phase 1 (Architecture) + Phase 6 (Security) guardrails enforced.
                </div>
              </div>
            )}
          </div>
        );
      })}

      <div style={{ padding: "8px 16px", borderTop: "1px solid var(--border-color, #2a2a4a)",
        fontSize: "10px", color: "var(--text-secondary, #a0a0b0)", marginTop: "auto" }}>
        Self-healing pipeline: detect → analyze → patch → validate → approve
      </div>
    </div>
  );
}
