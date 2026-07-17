/**
 * AiFixPreviewModal.tsx — "Fix with AI" diff preview and confirmation dialog.
 *
 * Enhanced failure UX: every unsuccessful AI refactor explains:
 * 1. What happened
 * 2. Why it happened
 * 3. What this means
 * 4. Available options
 * 5. Technical details (collapsed)
 */

import { useState, useEffect } from "react";
import {
  Check,
  X,
  Shield,
  ShieldAlert,
  TrendingUp,
  TrendingDown,
  Loader2,
  Undo2,
  Info,
  ChevronDown,
  ChevronRight,
  AlertCircle,
  FileCode,
  Search,
  Settings,
} from "lucide-react";
import type { AiFixResult, AiFixValidation } from "../services/refactor/AiFixHandler";
import type { SecurityFinding } from "../services/security/SecurityPatterns";

// ── Types ──────────────────────────────────────────────────────────────

interface Props {
  result: AiFixResult;
  onAccept: () => void;
  onReject: () => void;
  onUndo?: () => void;
  isApplying: boolean;
  hasBeenAccepted: boolean;
}

// ── Styles ─────────────────────────────────────────────────────────────

const MODAL_OVERLAY: React.CSSProperties = {
  position: "fixed",
  inset: 0,
  background: "rgba(0, 0, 0, 0.7)",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  zIndex: 1000,
};

const MODAL: React.CSSProperties = {
  background: "var(--bg-primary, #0f0f23)",
  border: "1px solid var(--border-color, #2a2a4a)",
  borderRadius: "10px",
  width: "720px",
  maxHeight: "85vh",
  overflow: "auto",
  padding: "20px",
  color: "var(--text-primary, #e0e0e0)",
  fontFamily: "inherit",
};

const TITLE_ROW: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "10px",
  marginBottom: "12px",
  fontSize: "15px",
  fontWeight: 700,
};

const STATUS_BADGE: React.CSSProperties = {
  fontSize: "11px",
  padding: "2px 8px",
  borderRadius: "4px",
  fontWeight: 600,
};

const CODE_PANEL: React.CSSProperties = {
  fontFamily: "'Fira Code', 'Cascadia Code', monospace",
  fontSize: "10px",
  lineHeight: 1.5,
  padding: "10px",
  borderRadius: "6px",
  overflow: "auto",
  maxHeight: "250px",
  whiteSpace: "pre-wrap",
  wordBreak: "break-word",
};

const BTN_ROW: React.CSSProperties = {
  display: "flex",
  gap: "8px",
  marginTop: "16px",
  justifyContent: "flex-end",
};

const BTN: React.CSSProperties = {
  padding: "8px 18px",
  borderRadius: "6px",
  border: "none",
  fontSize: "12px",
  fontWeight: 600,
  cursor: "pointer",
  fontFamily: "inherit",
  display: "flex",
  alignItems: "center",
  gap: "6px",
};

// ── Helpers ────────────────────────────────────────────────────────────

/** Translate validation violations to developer-friendly language. */
function translateViolation(violation: string): string {
  if (violation.includes("Imports were added or removed")) {
    return "The fix would require adding or removing import statements. This could break module dependencies in other files.";
  }
  if (violation.includes("New exports were introduced")) {
    return "The fix would introduce new exported functions or classes. This could change the public API surface of this module.";
  }
  if (violation.includes("Code grew")) {
    return "The generated fix is substantially larger than the original code. Large expansions often introduce new logic or complexity that should be reviewed separately.";
  }
  if (violation.includes("empty")) {
    return "The AI returned an empty response. The generated code block contained no usable output.";
  }
  if (violation.includes("identical")) {
    return "The AI returned code identical to the original. No changes were proposed.";
  }
  if (violation.includes("references other files")) {
    return "The generated code contains references to other files in the project. Cross-file changes require manual review.";
  }
  return violation;
}

/** Human-readable what-happened message per status. */
function getWhatHappened(status: string): string {
  switch (status) {
    case "unable":
      return "The AI could not produce a safe refactoring within the current automatic refactoring scope.";
    case "validation_failed":
      return "The AI generated a fix, but it did not pass structural quality checks.";
    case "security_blocked":
      return "The AI-generated code triggered security alerts during automated scanning.";
    case "error":
      return "The AI service could not complete the refactoring request.";
    default:
      return "An unexpected error occurred during the refactoring pipeline.";
  }
}

/** Human-readable why-it-happened message per status. */
function getWhy(status: string, result: AiFixResult): string {
  switch (status) {
    case "unable":
      return "This refactor appears to require changes outside the currently selected file, or would require changing imports or module dependencies that could affect other parts of the project.";
    case "validation_failed":
      return `The generated fix triggered ${result.validation.violations.length} structural check(s):`;
    case "security_blocked":
      return `The proposed fix introduces patterns flagged as potential vulnerabilities (${result.securityFindings.length} finding(s)).`;
    case "error":
      return "The AI provider may be experiencing a network issue, rate limiting, or an API key misconfiguration.";
    default:
      return result.errorMessage ?? "An unexpected error occurred.";
  }
}

/** What-this-means message per status. */
function getImpact(status: string): string {
  switch (status) {
    case "unable":
    case "validation_failed":
    case "security_blocked":
      return "Automatic refactoring stopped before any changes were applied. Your project has not been modified.";
    case "error":
      return "No changes were applied to your project. The refactoring could not be started or completed.";
    default:
      return "No changes were applied.";
  }
}

// ── Component ──────────────────────────────────────────────────────────

export default function AiFixPreviewModal({
  result,
  onAccept,
  onReject,
  onUndo,
  isApplying,
  hasBeenAccepted,
}: Props) {
  const [activeTab, setActiveTab] = useState<"diff" | "security" | "info">(
    result.status === "success" ? "diff" : "info",
  );
  const [showTechDetails, setShowTechDetails] = useState(false);

  // Close on Escape
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !isApplying) onReject();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [isApplying, onReject]);

  // ── Score delta display ─────────────────────────────────────────
  const scoreDelta =
    result.beforeScore !== null && result.afterScore !== null
      ? result.afterScore - result.beforeScore
      : null;

  const scoreDeltaColor =
    scoreDelta !== null
      ? scoreDelta > 0
        ? "#34d399"
        : scoreDelta < 0
          ? "#f87171"
          : "#a0a0b0"
      : "#a0a0b0";

  // ── Status badge color ──────────────────────────────────────────
  const statusColor: Record<string, string> = {
    success: "#34d399",
    validation_failed: "#f87171",
    security_blocked: "#ef4444",
    unable: "#fbbf24",
    error: "#f87171",
  };

  // ── Generate a simple line-by-line diff ─────────────────────────
  const diffLines = generateSimpleDiff(
    result.originalCode,
    result.proposedCode,
  );

  const isSuccess = result.status === "success";
  const whatHappened = getWhatHappened(result.status);
  const why = getWhy(result.status, result);
  const impact = getImpact(result.status);

  return (
    <div style={MODAL_OVERLAY} onClick={(e) => {
      if (e.target === e.currentTarget && !isApplying) onReject();
    }}>
      <div style={MODAL} onClick={(e) => e.stopPropagation()}>
        {/* ── Title ─────────────────────────────────────────────── */}
        <div style={TITLE_ROW}>
          <span>{isSuccess ? "✅" : "🤖"} AI Fix Preview</span>
          <span
            style={{
              ...STATUS_BADGE,
              background: `${statusColor[result.status]}22`,
              color: statusColor[result.status],
            }}
          >
            {result.status.replace(/_/g, " ")}
          </span>
          {result.scope.scope !== "file" && (
            <span style={{ fontSize: "10px", color: "#a0a0b0", marginLeft: "auto" }}>
              Scope: {result.scope.scope} (lines {result.scope.startLine}-{result.scope.endLine})
            </span>
          )}
        </div>

        {/* ── File path ─────────────────────────────────────────── */}
        <div
          style={{
            fontSize: "10px",
            color: "#a0a0b0",
            marginBottom: "10px",
            wordBreak: "break-all",
          }}
        >
          {result.filePath}
        </div>

        {/* ── Failure UX (for non-success statuses) ─────────────── */}
        {!isSuccess && (
          <>
            {/* What happened */}
            <div style={{
              padding: "10px 12px",
              background: `${statusColor[result.status]}15`,
              borderRadius: "6px",
              border: `1px solid ${statusColor[result.status]}33`,
              marginBottom: "10px",
            }}>
              <div style={{
                fontSize: "11px",
                fontWeight: 600,
                color: statusColor[result.status],
                marginBottom: "4px",
                display: "flex",
                alignItems: "center",
                gap: "6px",
              }}>
                <AlertCircle size={14} />
                What happened
              </div>
              <div style={{ fontSize: "12px", color: "var(--text-primary, #e0e0e0)", lineHeight: 1.5 }}>
                {whatHappened}
              </div>
            </div>

            {/* Why */}
            <div style={{
              padding: "10px 12px",
              background: "var(--bg-input, #1a1a2e)",
              borderRadius: "6px",
              border: "1px solid var(--border-color, #2a2a4a)",
              marginBottom: "10px",
            }}>
              <div style={{
                fontSize: "10px",
                fontWeight: 600,
                color: "var(--text-secondary, #a0a0b0)",
                marginBottom: "4px",
              }}>
                Why this happened
              </div>
              <div style={{ fontSize: "11px", color: "var(--text-secondary, #a0a0b0)", lineHeight: 1.5 }}>
                {why}
              </div>

              {/* Validation violations — show translated */}
              {result.status === "validation_failed" && result.validation.violations.length > 0 && (
                <div style={{ marginTop: "6px" }}>
                  {result.validation.violations.map((v, i) => (
                    <div
                      key={i}
                      style={{
                        padding: "5px 8px",
                        background: `${statusColor[result.status]}10`,
                        borderRadius: "4px",
                        marginBottom: "3px",
                        fontSize: "10px",
                        color: "var(--text-secondary, #a0a0b0)",
                        borderLeft: `2px solid ${statusColor[result.status]}`,
                      }}
                    >
                      {translateViolation(v)}
                    </div>
                  ))}
                </div>
              )}

              {/* Security findings summary */}
              {result.status === "security_blocked" && result.securityFindings.length > 0 && (
                <button
                  onClick={() => setActiveTab("security")}
                  style={{
                    marginTop: "6px",
                    padding: "4px 10px",
                    fontSize: "10px",
                    fontWeight: 600,
                    background: "var(--bg-input, #1a1a2e)",
                    border: "1px solid var(--border-color, #2a2a4a)",
                    borderRadius: "4px",
                    color: "#f87171",
                    cursor: "pointer",
                    fontFamily: "inherit",
                    display: "flex",
                    alignItems: "center",
                    gap: "4px",
                  }}
                >
                  <ShieldAlert size={11} />
                  Review {result.securityFindings.length} security finding(s)
                </button>
              )}
            </div>

            {/* What this means */}
            <div style={{
              padding: "8px 12px",
              background: "#065f4620",
              borderRadius: "6px",
              border: "1px solid #34d39922",
              marginBottom: "10px",
            }}>
              <div style={{
                fontSize: "10px",
                fontWeight: 600,
                color: "#34d399",
                marginBottom: "2px",
              }}>
                What this means
              </div>
              <div style={{ fontSize: "11px", color: "#34d399", lineHeight: 1.4 }}>
                {impact}
              </div>
            </div>

            {/* Available options */}
            <div style={{
              padding: "10px 12px",
              background: "var(--bg-input, #1a1a2e)",
              borderRadius: "6px",
              border: "1px solid var(--border-color, #2a2a4a)",
              marginBottom: "10px",
            }}>
              <div style={{
                fontSize: "10px",
                fontWeight: 600,
                color: "#60a5fa",
                marginBottom: "6px",
              }}>
                Available options
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
                {result.status === "security_blocked" && (
                  <OptionButton
                    icon={<ShieldAlert size={12} />}
                    label="Review Security Findings"
                    onClick={() => setActiveTab("security")}
                  />
                )}
                {result.status === "unable" && (
                  <>
                    <OptionButton
                      icon={<FileCode size={12} />}
                      label="Try manual refactoring"
                      description="This issue needs human judgment. Open the file and refactor manually."
                    />
                    <OptionButton
                      icon={<Search size={12} />}
                      label="Re-run Technical Debt Analysis"
                      description="Re-scan your project and check if other items can be fixed automatically."
                    />
                  </>
                )}
                {result.status === "validation_failed" && (
                  <>
                    <OptionButton
                      icon={<Info size={12} />}
                      label="Explain in more detail"
                      onClick={() => setShowTechDetails(!showTechDetails)}
                    />
                    <OptionButton
                      icon={<FileCode size={12} />}
                      label="Try manual refactoring"
                      description="The structural checks flagged issues. Manual refactoring gives you full control."
                    />
                  </>
                )}
                {result.status === "error" && (
                  <OptionButton
                    icon={<Settings size={12} />}
                    label="Check Provider Settings"
                    description="Verify your AI provider is configured correctly in Settings → AI Providers."
                  />
                )}
                <OptionButton
                  icon={<X size={12} />}
                  label="Cancel"
                  onClick={onReject}
                />
              </div>
            </div>

            {/* Technical Details (collapsed) */}
            <div style={{ marginBottom: "10px" }}>
              <button
                onClick={() => setShowTechDetails(!showTechDetails)}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: "4px",
                  background: "none",
                  border: "none",
                  color: "var(--text-secondary, #a0a0b0)",
                  fontSize: "10px",
                  cursor: "pointer",
                  fontFamily: "inherit",
                  padding: 0,
                }}
              >
                {showTechDetails ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                Technical Details
              </button>
              {showTechDetails && (
                <div style={{
                  marginTop: "6px",
                  padding: "8px 10px",
                  background: "#1a1a2e",
                  borderRadius: "4px",
                  border: "1px solid #2a2a4a",
                  fontSize: "10px",
                  color: "var(--text-secondary, #a0a0b0)",
                  lineHeight: 1.6,
                }}>
                  <div><strong style={{ color: "#e0e0e0" }}>File:</strong> {result.filePath}</div>
                  <div><strong style={{ color: "#e0e0e0" }}>Scope:</strong> {result.scope.scope} (lines {result.scope.startLine}-{result.scope.endLine})</div>
                  <div><strong style={{ color: "#e0e0e0" }}>Status:</strong> {result.status}</div>
                  {result.beforeScore !== null && (
                    <div><strong style={{ color: "#e0e0e0" }}>Score Before:</strong> {result.beforeScore}/100</div>
                  )}
                  {result.errorMessage && (
                    <div style={{ marginTop: "4px", color: "#a0a0b0" }}>
                      <strong>Error:</strong> {result.errorMessage}
                    </div>
                  )}
                  {result.validation.violations.length > 0 && (
                    <div style={{ marginTop: "4px" }}>
                      <strong>Raw Violations:</strong>
                      {result.validation.violations.map((v, i) => (
                        <div key={i} style={{ paddingLeft: "8px", color: "#a0a0b0" }}>· {v}</div>
                      ))}
                    </div>
                  )}
                  {result.securityFindings.length > 0 && (
                    <div style={{ marginTop: "4px" }}>
                      <strong>Security Findings ({result.securityFindings.length}):</strong>
                      {result.securityFindings.map((f, i) => (
                        <div key={i} style={{ paddingLeft: "8px" }}>
                          {f.severity.toUpperCase()}: {f.patternId} @ line {f.line}
                          {f.cwe ? ` (CWE-${f.cwe})` : ""}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          </>
        )}

        {/* ── Tab bar (for diff/security/details) ────────────────── */}
        <div style={{ display: "flex", gap: "2px", marginBottom: "10px" }}>
          {(["diff", "security", "info"] as const).map((tab) => (
            <button
              key={tab}
              onClick={() => setActiveTab(tab)}
              style={{
                padding: "4px 12px",
                fontSize: "11px",
                fontWeight: 600,
                border: "none",
                borderRadius: "4px 4px 0 0",
                background:
                  activeTab === tab
                    ? "var(--bg-input, #1a1a2e)"
                    : "transparent",
                color:
                  activeTab === tab
                    ? "var(--text-primary, #e0e0e0)"
                    : "#a0a0b0",
                cursor: "pointer",
                fontFamily: "inherit",
              }}
            >
              {tab === "diff" && "📝 Diff"}
              {tab === "security" && (
                <>
                  {result.securityFindings.length > 0 ? (
                    <ShieldAlert size={12} style={{ marginRight: "3px", verticalAlign: "middle" }} />
                  ) : (
                    <Shield size={12} style={{ marginRight: "3px", verticalAlign: "middle" }} />
                  )}
                  Security
                  {result.securityFindings.length > 0 && (
                    <span style={{ color: "#f87171", marginLeft: "3px" }}>
                      ({result.securityFindings.length})
                    </span>
                  )}
                </>
              )}
              {tab === "info" && "ℹ️ Details"}
            </button>
          ))}
        </div>

        {/* ── Tab content ──────────────────────────────────────── */}
        {activeTab === "diff" && (
          <div>
            {result.status === "success" ? (
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "8px" }}>
                {/* Before */}
                <div>
                  <div
                    style={{
                      fontSize: "9px",
                      fontWeight: 600,
                      color: "#f87171",
                      marginBottom: "4px",
                    }}
                  >
                    Before
                  </div>
                  <div
                    style={{
                      ...CODE_PANEL,
                      background: "#1a1a2e",
                      border: "1px solid #2a2a4a",
                    }}
                  >
                    {result.originalCode}
                  </div>
                </div>

                {/* After */}
                <div>
                  <div
                    style={{
                      fontSize: "9px",
                      fontWeight: 600,
                      color: "#34d399",
                      marginBottom: "4px",
                    }}
                  >
                    After
                  </div>
                  <div
                    style={{
                      ...CODE_PANEL,
                      background: "#1a1a2e",
                      border: "1px solid #2a2a4a",
                    }}
                  >
                    {result.proposedCode}
                  </div>
                </div>
              </div>
            ) : (
              /* Inline diff for non-success states */
              <div style={{ ...CODE_PANEL, background: "#1a1a2e" }}>
                {diffLines}
              </div>
            )}

            {/* Score delta */}
            {scoreDelta !== null && hasBeenAccepted && (
              <div
                style={{
                  marginTop: "12px",
                  padding: "8px 12px",
                  background: `${scoreDeltaColor}15`,
                  borderRadius: "6px",
                  border: `1px solid ${scoreDeltaColor}`,
                  display: "flex",
                  alignItems: "center",
                  gap: "8px",
                  fontSize: "13px",
                  fontWeight: 600,
                }}
              >
                {scoreDelta > 0 ? (
                  <TrendingUp size={14} color={scoreDeltaColor} />
                ) : (
                  <TrendingDown size={14} color={scoreDeltaColor} />
                )}
                <span style={{ color: "#a0a0b0" }}>Score:</span>
                <span style={{ color: "#e0e0e0" }}>{result.beforeScore}</span>
                <span style={{ color: "#a0a0b0" }}>→</span>
                <span style={{ color: scoreDeltaColor }}>{result.afterScore}</span>
                <span
                  style={{
                    color: scoreDeltaColor,
                    fontSize: "11px",
                    fontWeight: 400,
                  }}
                >
                  ({scoreDelta > 0 ? "+" : ""}
                  {scoreDelta})
                </span>
              </div>
            )}
          </div>
        )}

        {activeTab === "security" && (
          <div>
            {result.securityFindings.length === 0 ? (
              <div
                style={{
                  padding: "16px",
                  textAlign: "center",
                  color: "#34d399",
                  fontSize: "12px",
                }}
              >
                <Shield size={20} style={{ marginBottom: "6px" }} />
                <div>Security scan passed — no issues detected.</div>
              </div>
            ) : (
              <div>
                <div
                  style={{
                    fontSize: "10px",
                    fontWeight: 600,
                    color: "#f87171",
                    marginBottom: "8px",
                  }}
                >
                  {result.securityFindings.length} security finding(s) in proposed code:
                </div>
                {result.securityFindings.map((f, i) => (
                  <SecurityFindingCard key={i} finding={f} />
                ))}
              </div>
            )}
          </div>
        )}

        {activeTab === "info" && (
          <InfoTab result={result} />
        )}

        {/* ── Snapshot note for success ────────────────────────── */}
        {isSuccess && hasBeenAccepted && (
          <div style={{
            marginTop: "10px",
            padding: "8px 10px",
            background: "#065f4620",
            borderRadius: "4px",
            border: "1px solid #34d39922",
            fontSize: "10px",
            color: "#34d399",
            display: "flex",
            alignItems: "center",
            gap: "6px",
          }}>
            <Shield size={12} />
            Applied changes are protected by a native snapshot. You can roll back this refactor at any time.
          </div>
        )}

        {/* ── Action buttons ──────────────────────────────────────── */}
        <div style={BTN_ROW}>
          {onUndo && hasBeenAccepted && (
            <button
              onClick={onUndo}
              disabled={isApplying}
              style={{
                ...BTN,
                background: "#92400e20",
                color: "#fbbf24",
                border: "1px solid #fbbf2444",
                opacity: isApplying ? 0.5 : 1,
              }}
            >
              <Undo2 size={14} />
              Undo Fix
            </button>
          )}

          {!hasBeenAccepted && (
            <>
              <button
                onClick={onReject}
                disabled={isApplying}
                style={{
                  ...BTN,
                  background: "#1a1a2e",
                  color: "#a0a0b0",
                  border: "1px solid #2a2a4a",
                  opacity: isApplying ? 0.5 : 1,
                }}
              >
                <X size={14} />
                {isSuccess ? "Reject" : "Close"}
              </button>

              {isSuccess && (
                <button
                  onClick={onAccept}
                  disabled={isApplying || result.status !== "success"}
                  style={{
                    ...BTN,
                    background:
                      result.status === "success" ? "#065f46" : "#1a1a2e",
                    color:
                      result.status === "success" ? "#34d399" : "#a0a0b0",
                    border:
                      result.status === "success"
                        ? "1px solid #34d39944"
                        : "1px solid #2a2a4a",
                    opacity:
                      isApplying || result.status !== "success" ? 0.5 : 1,
                    cursor:
                      result.status !== "success" ? "not-allowed" : "pointer",
                  }}
                >
                  {isApplying ? (
                    <Loader2
                      size={14}
                      style={{ animation: "spin 1s linear infinite" }}
                    />
                  ) : (
                    <Check size={14} />
                  )}
                  Accept Fix
                </button>
              )}
            </>
          )}

          {hasBeenAccepted && !onUndo && (
            <button
              onClick={onReject}
              style={{
                ...BTN,
                background: "#1a1a2e",
                color: "#a0a0b0",
                border: "1px solid #2a2a4a",
              }}
            >
              Close
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Sub-components ─────────────────────────────────────────────────────

function OptionButton({
  icon,
  label,
  description,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  description?: string;
  onClick?: () => void;
}) {
  return (
    <button
      onClick={onClick}
      style={{
        display: "flex",
        alignItems: "flex-start",
        gap: "6px",
        padding: "6px 10px",
        background: "var(--bg-primary, #1a1a2e)",
        border: "1px solid var(--border-color, #2a2a4a)",
        borderRadius: "4px",
        color: "var(--text-secondary, #a0a0b0)",
        fontSize: "10px",
        cursor: onClick ? "pointer" : "default",
        fontFamily: "inherit",
        textAlign: "left",
        width: "100%",
      }}
      disabled={!onClick}
    >
      <span style={{ flexShrink: 0, marginTop: "1px", color: "#60a5fa" }}>{icon}</span>
      <div>
        <div style={{ fontWeight: 600, marginBottom: description ? "2px" : 0 }}>{label}</div>
        {description && (
          <div style={{ color: "var(--text-secondary, #a0a0b0)", fontSize: "9px", fontWeight: 400 }}>
            {description}
          </div>
        )}
      </div>
    </button>
  );
}

function SecurityFindingCard({ finding }: { finding: SecurityFinding }) {
  const severityColor: Record<string, string> = {
    critical: "#ef4444",
    high: "#f87171",
    medium: "#fbbf24",
    low: "#60a5fa",
  };

  return (
    <div
      style={{
        padding: "8px 10px",
        background: "#1a1a2e",
        borderRadius: "4px",
        marginBottom: "4px",
        borderLeft: `3px solid ${severityColor[finding.severity] ?? "#a0a0b0"}`,
        fontSize: "10px",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: "6px", marginBottom: "3px" }}>
        <span
          style={{
            fontWeight: 600,
            color: severityColor[finding.severity] ?? "#a0a0b0",
          }}
        >
          [{finding.severity.toUpperCase()}]
        </span>
        <span style={{ color: "#e0e0e0" }}>{finding.patternId}</span>
        <span style={{ color: "#a0a0b0", marginLeft: "auto" }}>
          Line {finding.line}
        </span>
      </div>
      <div style={{ color: "#a0a0b0", marginBottom: "3px" }}>
        {finding.description}
      </div>
      <div style={{ color: "#34d399", fontSize: "9px" }}>
        Fix: {finding.suggestion}
      </div>
      {finding.cwe && (
        <div style={{ color: "#a0a0b0", fontSize: "9px", marginTop: "2px" }}>
          CWE-{finding.cwe} · {finding.owasp}
        </div>
      )}
    </div>
  );
}

function InfoTab({ result }: { result: AiFixResult }) {
  const isEarlyExit = result.status === "unable" || result.status === "error";

  return (
    <div style={{ fontSize: "10px", color: "#a0a0b0", lineHeight: 1.8 }}>
      <div style={{ marginBottom: "8px" }}>
        <strong style={{ color: "#e0e0e0" }}>File:</strong>{" "}
        <span style={{ wordBreak: "break-all" }}>{result.filePath}</span>
      </div>
      <div style={{ marginBottom: "8px" }}>
        <strong style={{ color: "#e0e0e0" }}>Scope:</strong>{" "}
        {result.scope.scope} (lines {result.scope.startLine}-
        {result.scope.endLine})
      </div>
      <div style={{ marginBottom: "8px" }}>
        <strong style={{ color: "#e0e0e0" }}>Status:</strong>{" "}
        <span
          style={{
            color:
              result.status === "success"
                ? "#34d399"
                : result.status === "unable"
                  ? "#fbbf24"
                  : "#f87171",
          }}
        >
          {result.status.replace(/_/g, " ")}
          {isEarlyExit && " (early exit)"}
        </span>
      </div>
      {result.beforeScore !== null && (
        <div style={{ marginBottom: "8px" }}>
          <strong style={{ color: "#e0e0e0" }}>Score Before:</strong>{" "}
          {result.beforeScore}/100
        </div>
      )}
      {result.afterScore !== null && (
        <div style={{ marginBottom: "8px" }}>
          <strong style={{ color: "#e0e0e0" }}>Score After:</strong>{" "}
          {result.afterScore}/100
        </div>
      )}
      <div style={{ marginBottom: "8px" }}>
        <strong style={{ color: "#e0e0e0" }}>Validation:</strong>{" "}
        <span style={{ color: result.validation.passed ? "#34d399" : "#fbbf24" }}>
          {isEarlyExit
            ? "Not run — pipeline exited before validation"
            : result.validation.passed
            ? "All checks passed"
            : `${result.validation.violations.length} violation(s)`}
        </span>
      </div>
      <div>
        <strong style={{ color: "#e0e0e0" }}>Security Findings:</strong>{" "}
        <span
          style={{
            color: result.securityFindings.length === 0 ? "#34d399" : "#f87171",
          }}
        >
          {isEarlyExit
            ? "Not run — pipeline exited before security scan"
            : result.securityFindings.length === 0
            ? "None"
            : result.securityFindings.length}
        </span>
      </div>
    </div>
  );
}

// ── Simple diff generator ──────────────────────────────────────────────

function generateSimpleDiff(
  original: string,
  proposed: string,
): React.ReactNode[] {
  const origLines = original.split("\n");
  const propLines = proposed.split("\n");
  const result: React.ReactNode[] = [];
  const maxLen = Math.max(origLines.length, propLines.length);

  for (let i = 0; i < maxLen; i++) {
    const orig = origLines[i];
    const prop = propLines[i];

    if (orig === prop) {
      // Unchanged
      result.push(
        <div key={i} style={{ color: "#a0a0b0" }}>
          {"  "}{orig ?? ""}
        </div>,
      );
    } else {
      if (orig !== undefined) {
        result.push(
          <div
            key={`${i}-old`}
            style={{ color: "#f87171", background: "#7f1d1d20" }}
          >
            {"- "}{orig}
          </div>,
        );
      }
      if (prop !== undefined) {
        result.push(
          <div
            key={`${i}-new`}
            style={{ color: "#34d399", background: "#065f4620" }}
          >
            {"+ "}{prop}
          </div>,
        );
      }
    }
  }

  return result;
}

// ── Inline spinner animation ──────────────────────────────────────────
// (injected via a style element — the modal uses <Loader2> which relies on
//  the app's global CSS for the "spin" keyframe. If not present, add:)
if (typeof document !== "undefined" && !document.getElementById("ai-fix-spin-keyframe")) {
  const style = document.createElement("style");
  style.id = "ai-fix-spin-keyframe";
  style.textContent = `
    @keyframes spin {
      from { transform: rotate(0deg); }
      to { transform: rotate(360deg); }
    }
  `;
  document.head.appendChild(style);
}