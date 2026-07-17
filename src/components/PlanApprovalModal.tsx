/**
 * PlanApprovalModal.tsx — Deterministic pre-approval step before "Fix with AI".
 *
 * Shows the user exactly what the LLM will attempt using existing TDA metadata
 * (RefactorPlanItem, HotspotASTDetail, FixScopeResult) — NO extra LLM call.
 * Only after user clicks "Approve & Generate Fix" does runAiFix() execute.
 */

import { AlertCircle, CheckCircle2, FileCode, Layers, Shield, Wrench, Zap, Sparkles, X } from "lucide-react";
import type { RefactorPlanItem } from "../services/technicalDebt/RefactorPlanner";

// ── Types ──────────────────────────────────────────────────────────────────────

export interface FixPlanContext {
  item: RefactorPlanItem;
  scope: {
    startLine: number;
    endLine: number;
    scopeType: "function" | "class" | "block" | "file";
  } | null;
}

// ── Constants ──────────────────────────────────────────────────────────────────

const SCOPE_LABEL: Record<string, string> = {
  function: "Function scope",
  class: "Class scope",
  block: "Block scope",
  file: "Full file",
};

const CATEGORY_COLOR: Record<string, string> = {
  quick_win: "#34d399",
  major_refactor: "#f87171",
  maintenance: "#fbbf24",
  architectural: "#a78bfa",
};

const CATEGORY_ICON: Record<string, React.ReactNode> = {
  quick_win: <Zap size={16} />,
  major_refactor: <Layers size={16} />,
  maintenance: <Wrench size={16} />,
  architectural: <Shield size={16} />,
};

const CATEGORY_LABEL: Record<string, string> = {
  quick_win: "Quick Win",
  major_refactor: "Major Refactor",
  maintenance: "Maintenance",
  architectural: "Architectural",
};

const EFFORT_COLOR: Record<string, string> = {
  low: "#34d399",
  medium: "#fbbf24",
  high: "#f87171",
};

const RISK_COLOR: Record<string, string> = {
  low: "#34d399",
  medium: "#fbbf24",
  high: "#ef4444",
};

// ── Helpers ────────────────────────────────────────────────────────────────────

function displayPath(filePath: string): string {
  return filePath.replace(/\\/g, "/").split("/").slice(-3).join("/");
}

function buildOperationList(item: RefactorPlanItem): string[] {
  const ops: string[] = [];

  // Parse whyFlagged for specific issues
  if (item.whyFlagged.includes("CC =") || item.whyFlagged.includes("cyclomatic")) {
    ops.push("Extract decision branches into named helper functions");
    ops.push("Use polymorphism over conditional chains where applicable");
  }
  if (item.whyFlagged.includes("godFunctionCount") || item.whyFlagged.includes("god function")) {
    ops.push("Break god function into smaller, single-responsibility functions");
  }
  if (item.whyFlagged.includes("godClassCount") || item.whyFlagged.includes("god class")) {
    ops.push("Split class into smaller, focused classes");
    ops.push("Group related methods into separate classes");
  }
  if (item.whyFlagged.includes("nesting") || item.whyFlagged.includes("Nesting")) {
    ops.push("Use early returns (guard clauses) to flatten nesting");
    ops.push("Extract deeply nested logic into helper functions");
  }
  if (item.whyFlagged.includes("parameter") || item.whyFlagged.includes("Parameter")) {
    ops.push("Group related parameters into an options object");
  }
  if (item.whyFlagged.includes("hub") || item.whyFlagged.includes("Hub")) {
    ops.push("Split hub module into smaller, focused modules");
  }
  if (item.category === "quick_win" || item.whyFlagged.includes("TODO") || item.whyFlagged.includes("FIXME")) {
    ops.push("Resolve or document TODO/FIXME comments");
  }

  // Fallback: use recommendation text
  if (ops.length === 0 && item.recommendation) {
    ops.push(item.recommendation);
  }
  if (ops.length === 0) {
    ops.push("Apply AI-suggested refactoring to address the flagged issue");
  }

  return ops;
}

// ── Component ──────────────────────────────────────────────────────────────────

export default function PlanApprovalModal({
  context,
  onApprove,
  onCancel,
}: {
  context: FixPlanContext;
  onApprove: () => void;
  onCancel: () => void;
}) {
  const { item, scope } = context;
  const catColor = CATEGORY_COLOR[item.category] ?? "#60a5fa";
  const effortColor = EFFORT_COLOR[item.estimatedEffort] ?? "#fbbf24";
  const riskColor = RISK_COLOR[item.estimatedRisk] ?? "#fbbf24";
  const operations = buildOperationList(item);

  return (
    <div style={{
      position: "fixed", inset: 0, zIndex: 9999,
      background: "rgba(0,0,0,0.6)", display: "flex",
      alignItems: "center", justifyContent: "center",
      fontFamily: "var(--font-family, monospace)",
    }}>
      <div style={{
        background: "var(--bg-panel, #16162a)",
        border: "1px solid var(--border-color, #2a2a4a)",
        borderRadius: "10px", padding: "24px",
        maxWidth: "540px", width: "90%", maxHeight: "85vh", overflowY: "auto",
        color: "var(--text-primary, #e0e0e0)",
        fontSize: "12px",
      }}>
        {/* Header */}
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "16px" }}>
          <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
            <Sparkles size={18} color="#818cf8" />
            <span style={{ fontWeight: 700, fontSize: "14px" }}>Refactor Approval — Review Plan</span>
          </div>
          <button onClick={onCancel} style={{
            background: "none", border: "none", color: "var(--text-secondary, #a0a0b0)",
            cursor: "pointer", padding: "2px",
          }}>
            <X size={18} />
          </button>
        </div>

        {/* Target file + scope */}
        <div style={{
          padding: "10px 12px", background: "var(--bg-input, #1a1a2e)",
          borderRadius: "6px", marginBottom: "12px", fontSize: "11px",
        }}>
          <div style={{ display: "flex", alignItems: "center", gap: "6px", marginBottom: "4px" }}>
            <FileCode size={14} color="#60a5fa" />
            <span style={{ fontWeight: 600 }}>{displayPath(item.filePath)}</span>
          </div>
          {scope && (
            <div style={{ color: "var(--text-secondary, #a0a0b0)", fontSize: "10px", marginBottom: "4px" }}>
              Lines {scope.startLine}–{scope.endLine} · {SCOPE_LABEL[scope.scopeType] ?? "Code block"}
            </div>
          )}
          <div style={{ display: "flex", gap: "6px", flexWrap: "wrap" }}>
            <span style={{
              padding: "2px 8px", borderRadius: "10px", fontSize: "10px",
              background: `${catColor}20`, color: catColor, fontWeight: 600,
            }}>
              {CATEGORY_ICON[item.category]} {CATEGORY_LABEL[item.category] ?? item.category}
            </span>
            <span style={{
              padding: "2px 8px", borderRadius: "10px", fontSize: "10px",
              background: `${effortColor}20`, color: effortColor, fontWeight: 600,
            }}>
              {item.estimatedEffort} effort
            </span>
            <span style={{
              padding: "2px 8px", borderRadius: "10px", fontSize: "10px",
              background: `${riskColor}20`, color: riskColor, fontWeight: 600,
            }}>
              {item.estimatedRisk} risk
            </span>
          </div>
        </div>

        {/* Problem */}
        <div style={{ marginBottom: "12px" }}>
          <div style={{ fontWeight: 600, fontSize: "11px", marginBottom: "6px", color: "#f87171" }}>
            <AlertCircle size={12} style={{ verticalAlign: "middle", marginRight: "4px" }} />
            Problem
          </div>
          <div style={{
            padding: "8px 12px", background: "var(--bg-input, #1a1a2e)",
            borderRadius: "6px", fontSize: "11px",
            color: "var(--text-secondary, #a0a0b0)",
          }}>
            <div style={{ marginBottom: "4px", color: "var(--text-primary, #e0e0e0)", fontWeight: 600 }}>
              {item.issue}
            </div>
            <div>{item.whyFlagged}</div>

            {/* AST detail metrics */}
            {item.astDetail && (
              <div style={{ marginTop: "8px", display: "flex", gap: "8px", flexWrap: "wrap", fontSize: "10px" }}>
                {item.astDetail.cyclomaticComplexity > 0 && (
                  <ASTMetric label="Cyclomatic Complexity" value={item.astDetail.cyclomaticComplexity} threshold={15} />
                )}
                {item.astDetail.godFunctionCount > 0 && (
                  <ASTMetric label="God Functions" value={item.astDetail.godFunctionCount} threshold={0} color="#f87171" />
                )}
                {item.astDetail.godClassCount > 0 && (
                  <ASTMetric label="God Classes" value={item.astDetail.godClassCount} threshold={0} color="#f87171" />
                )}
                {item.astDetail.maxNestingDepth > 0 && (
                  <ASTMetric label="Max Nesting Depth" value={item.astDetail.maxNestingDepth} threshold={5} />
                )}
                {item.astDetail.maxParameterCount > 0 && (
                  <ASTMetric label="Max Parameters" value={item.astDetail.maxParameterCount} threshold={5} />
                )}
              </div>
            )}
          </div>
        </div>

        {/* Planned Operations */}
        <div style={{ marginBottom: "12px" }}>
          <div style={{ fontWeight: 600, fontSize: "11px", marginBottom: "6px", color: "#60a5fa" }}>
            Planned Operations
          </div>
          <div style={{
            padding: "8px 12px", background: "var(--bg-input, #1a1a2e)",
            borderRadius: "6px", fontSize: "11px",
          }}>
            {operations.map((op, i) => (
              <div key={i} style={{
                display: "flex", alignItems: "flex-start", gap: "6px",
                marginBottom: i < operations.length - 1 ? "4px" : 0,
                color: "var(--text-secondary, #a0a0b0)",
              }}>
                <span style={{ color: "#60a5fa", marginTop: "2px" }}>•</span>
                <span>{op}</span>
              </div>
            ))}
          </div>
        </div>

        {/* Guard Rails */}
        <div style={{ marginBottom: "14px" }}>
          <div style={{ fontWeight: 600, fontSize: "11px", marginBottom: "6px", color: "#34d399" }}>
            <CheckCircle2 size={12} style={{ verticalAlign: "middle", marginRight: "4px" }} />
            Guard Rails (Always Applied)
          </div>
          <div style={{
            padding: "8px 12px", background: "var(--bg-input, #1a1a2e)",
            borderRadius: "6px", fontSize: "10px",
            color: "var(--text-secondary, #a0a0b0)",
            lineHeight: 1.6,
          }}>
            <div>• Scope isolation: LLM sees only the target code block</div>
            <div>• No import/export changes allowed</div>
            <div>• No new dependencies or cross-file references</div>
            <div>• Security gate: scanFile() runs on all generated code</div>
            <div>• Diff preview before final apply</div>
            <div>• Rollback: snapshot saved automatically</div>
          </div>
        </div>

        {/* Expected Payoff */}
        {item.expectedPayoff && (
          <div style={{ marginBottom: "16px" }}>
            <div style={{ fontWeight: 600, fontSize: "11px", marginBottom: "6px", color: "#34d399" }}>
              Expected Payoff
            </div>
            <div style={{
              padding: "8px 12px", background: "#065f4620",
              borderRadius: "6px", fontSize: "11px", color: "#34d399",
              borderLeft: "3px solid #34d399",
            }}>
              {item.expectedPayoff}
            </div>
          </div>
        )}

        {/* Actions */}
        <div style={{ display: "flex", gap: "8px", justifyContent: "flex-end" }}>
          <button onClick={onCancel} style={{
            padding: "8px 18px", background: "var(--bg-input, #1a1a2e)",
            border: "1px solid var(--border-color, #2a2a4a)",
            borderRadius: "6px", color: "var(--text-secondary, #a0a0b0)",
            fontSize: "11px", fontWeight: 600, cursor: "pointer",
            fontFamily: "inherit",
          }}>
            Cancel
          </button>
          <button onClick={onApprove} style={{
            padding: "8px 18px", background: "var(--accent-color, #3b82f6)",
            border: "none", borderRadius: "6px", color: "#fff",
            fontSize: "11px", fontWeight: 600, cursor: "pointer",
            fontFamily: "inherit", display: "flex", alignItems: "center", gap: "6px",
          }}>
            <Sparkles size={14} />
            Approve & Generate Fix with AI
          </button>
        </div>
      </div>
    </div>
  );
}

// ── AST metric badge ───────────────────────────────────────────────────────────

function ASTMetric({
  label,
  value,
  threshold,
  color: overrideColor,
}: {
  label: string;
  value: number;
  threshold: number;
  color?: string;
}) {
  const isOver = value > threshold;
  const color = overrideColor ?? (isOver ? "#f87171" : "#fbbf24");
  return (
    <div style={{
      padding: "3px 8px", borderRadius: "4px",
      background: `${color}15`, border: `1px solid ${color}30`,
      fontSize: "10px", color,
    }}>
      <span style={{ fontWeight: 600 }}>{label}:</span> {value}{threshold > 0 ? ` (threshold: ${threshold})` : ""}
    </div>
  );
}