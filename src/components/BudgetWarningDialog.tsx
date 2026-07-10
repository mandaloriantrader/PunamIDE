/**
 * BudgetWarningDialog — Non-blocking overlay for mid-task budget warnings.
 *
 * Positioned above the chat input (similar to ClarificationDialog — no modal
 * backdrop). Displays current consumption (percentage, cost in INR, rounds)
 * with a progress bar, and offers two actions: continue or stop.
 *
 * Visual urgency adapts to status:
 *  - 'warning' → yellow accent (AlertTriangle icon)
 *  - 'critical' → red accent (XCircle icon)
 */

import { useEffect, useRef } from "react";
import { AlertTriangle, XCircle } from "lucide-react";
import type {
  BudgetStatus,
  BudgetConsumed,
  BudgetRemaining,
} from "../services/agent/BudgetController";
import { formatCostInr } from "../services/agent/ModelCostRegistry";

interface BudgetWarningDialogProps {
  status: BudgetStatus;
  consumed: BudgetConsumed;
  remaining: BudgetRemaining;
  onDecision: (decision: "continue" | "stop") => void;
}

export default function BudgetWarningDialog({
  status,
  consumed,
  remaining,
  onDecision,
}: BudgetWarningDialogProps) {
  const continueRef = useRef<HTMLButtonElement>(null);

  // Auto-focus the first action button for keyboard accessibility
  useEffect(() => {
    continueRef.current?.focus();
  }, []);

  const isCritical = status === "critical";
  const percentUsed = Math.min(Math.round(remaining.percentageUsed * 100), 100);
  const costDisplay = formatCostInr(consumed.estimatedCostUsd);

  const Icon = isCritical ? XCircle : AlertTriangle;
  const statusLabel = isCritical ? "Budget critical" : "Budget warning";
  const accentClass = isCritical ? "budget-warning--critical" : "budget-warning--warn";

  return (
    <div
      className={`budget-warning-panel ${accentClass}`}
      role="alertdialog"
      aria-label={statusLabel}
      aria-describedby="budget-warning-stats"
    >
      {/* Header */}
      <div className="budget-warning-header">
        <Icon size={14} className="budget-warning-icon" />
        <span className="budget-warning-label">{statusLabel}</span>
      </div>

      {/* Progress bar */}
      <div className="budget-warning-progress-track" aria-hidden="true">
        <div
          className="budget-warning-progress-fill"
          style={{ width: `${percentUsed}%` }}
        />
      </div>

      {/* Stats row */}
      <p className="budget-warning-stats" id="budget-warning-stats">
        {percentUsed}% used · {costDisplay} spent · {consumed.rounds}{" "}
        {consumed.rounds === 1 ? "round" : "rounds"}
      </p>

      {/* Action buttons */}
      <div className="budget-warning-actions">
        <button
          ref={continueRef}
          type="button"
          className="budget-warning-btn budget-warning-btn--continue"
          onClick={() => onDecision("continue")}
        >
          Continue anyway
        </button>
        <button
          type="button"
          className="budget-warning-btn budget-warning-btn--stop"
          onClick={() => onDecision("stop")}
        >
          Stop &amp; summarize
        </button>
      </div>
    </div>
  );
}
