/**
 * AiFixPipelinePanel.tsx — Live progress panel shown during "Fix with AI" pipeline.
 *
 * Replaces the PlanApprovalModal with a real-time progress indicator while
 * runAiFix() executes. Shows the original code block + live-streamed AI output
 * in side-by-side panels, with a step-by-step checklist at the bottom.
 */

import { useEffect, useState } from "react";
import { FileCode, Sparkles, CheckCircle2, Loader2 } from "lucide-react";
import type { FixScopeResult } from "../services/refactor/AiFixHandler";

// ── Types ──────────────────────────────────────────────────────────────────────

export interface PipelineStep {
  id: string;
  label: string;
  completed: boolean;
  active: boolean;
  details?: string;
}

interface Props {
  originalCode: string;
  scope: FixScopeResult | null;
  fileName: string;
  steps: PipelineStep[];
  /** Live-streamed code from the LLM (grows in real-time) */
  streamingCode: string;
}

// ── Step definitions (in execution order) ──────────────────────────────────────

const STEP_LABELS: Record<string, string> = {
  scope_extract: "Scope extracted",
  prompt_build: "Prompt built",
  debt_analyze: "Debt analyzed",
  llm_call: "AI generating fix",
  validate_output: "Output validated",
  security_scan: "Security scan",
  apply_patch: "Patch applied",
  score_calc: "Score recalculated",
};

// ── Component ──────────────────────────────────────────────────────────────────

export default function AiFixPipelinePanel({
  originalCode,
  scope,
  fileName,
  steps,
  streamingCode,
}: Props) {
  const displayPath = fileName.replace(/\\/g, "/").split("/").slice(-2).join("/");
  const scopeLabel = scope
    ? `Lines ${scope.startLine}-${scope.endLine} (${scope.scope})`
    : "Full file";

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 9998,
        background: "rgba(0,0,0,0.65)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        fontFamily: "var(--font-family, monospace)",
      }}
    >
      <div
        style={{
          background: "var(--bg-panel, #16162a)",
          border: "1px solid var(--border-color, #2a2a4a)",
          borderRadius: "10px",
          padding: "24px",
          maxWidth: "900px",
          width: "95%",
          maxHeight: "90vh",
          overflowY: "auto",
          color: "var(--text-primary, #e0e0e0)",
          fontSize: "12px",
        }}
      >
        {/* Header */}
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            marginBottom: "16px",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
            <Loader2 size={16} color="#818cf8" style={{ animation: "spin 1s linear infinite" }} />
            <span style={{ fontWeight: 700, fontSize: "13px" }}>
              AI Refactoring Job — Running...
            </span>
          </div>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: "6px",
              color: "var(--text-secondary, #a0a0b0)",
              fontSize: "10px",
            }}
          >
            <FileCode size={12} />
            {displayPath}
          </div>
        </div>

        {/* Side-by-side code panels */}
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "1fr 1fr",
            gap: "12px",
            marginBottom: "16px",
            maxHeight: "320px",
          }}
        >
          {/* Original code (left) */}
          <div>
            <div
              style={{
                fontSize: "9px",
                fontWeight: 600,
                color: "var(--text-secondary, #a0a0b0)",
                marginBottom: "4px",
                textTransform: "uppercase",
                letterSpacing: "0.05em",
              }}
            >
              Original Code · {scopeLabel}
            </div>
            <div
              style={{
                background: "var(--bg-input, #1a1a2e)",
                border: "1px solid var(--border-color, #2a2a4a)",
                borderRadius: "6px",
                padding: "10px",
                fontSize: "10px",
                fontFamily: "Monaco, Consolas, monospace",
                maxHeight: "280px",
                overflowY: "auto",
                whiteSpace: "pre-wrap",
                wordBreak: "break-word",
                lineHeight: 1.5,
                color: "var(--text-primary, #e0e0e0)",
              }}
            >
              {originalCode || "No code available"}
            </div>
          </div>

          {/* AI working copy (right) */}
          <div>
            <div
              style={{
                fontSize: "9px",
                fontWeight: 600,
                color: "#818cf8",
                marginBottom: "4px",
                textTransform: "uppercase",
                letterSpacing: "0.05em",
              }}
            >
              AI Working Copy <Sparkles size={10} style={{ verticalAlign: "middle" }} />
            </div>
            <div
              style={{
                background: "var(--bg-input, #1a1a2e)",
                border: "1px solid #818cf830",
                borderRadius: "6px",
                padding: "10px",
                fontSize: "10px",
                fontFamily: "Monaco, Consolas, monospace",
                maxHeight: "280px",
                overflowY: "auto",
                whiteSpace: "pre-wrap",
                wordBreak: "break-word",
                lineHeight: 1.5,
                color: streamingCode ? "#e0e0e0" : "#a0a0b0",
              }}
            >
              {streamingCode || (
                <span style={{ fontStyle: "italic", color: "#a0a0b0" }}>
                  Waiting for AI response...
                </span>
              )}
              {/* Cursor animation when streaming */}
              {streamingCode && (
                <span
                  style={{
                    animation: "blink 1s step-end infinite",
                    color: "#818cf8",
                    fontWeight: 700,
                  }}
                >
                  ▊
                </span>
              )}
            </div>
          </div>
        </div>

        {/* Step checklist */}
        <div
          style={{
            borderTop: "1px solid var(--border-color, #2a2a4a)",
            paddingTop: "12px",
          }}
        >
          {steps.map((step) => (
            <div
              key={step.id}
              style={{
                display: "flex",
                alignItems: "center",
                gap: "8px",
                padding: "3px 0",
                fontSize: "11px",
                color: step.completed
                  ? "#34d399"
                  : step.active
                  ? "#818cf8"
                  : "var(--text-secondary, #a0a0b0)",
              }}
            >
              {step.completed ? (
                <CheckCircle2 size={13} />
              ) : step.active ? (
                <Loader2 size={13} style={{ animation: "spin 1s linear infinite" }} />
              ) : (
                <div
                  style={{
                    width: 13,
                    height: 13,
                    borderRadius: "50%",
                    border: "1.5px solid currentColor",
                    opacity: 0.4,
                  }}
                />
              )}
              <span>{STEP_LABELS[step.id] ?? step.label}</span>
              {step.details && step.active && (
                <span
                  style={{
                    fontSize: "10px",
                    color: "var(--text-secondary, #a0a0b0)",
                    marginLeft: "auto",
                    maxWidth: "200px",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {step.details.length > 60
                    ? step.details.slice(-60)
                    : step.details}
                </span>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}