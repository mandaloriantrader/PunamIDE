/**
 * TaskCostSummary — Post-task inline cost display.
 *
 * Renders a compact, non-intrusive summary after an agent task completes:
 *   "Task complete · X rounds · Y tokens · ₹Z.ZZ"
 *
 * Styled with small text and muted colors to avoid visual noise.
 */

import type { BudgetConsumed } from "../services/agent/BudgetController";
import { formatCostInr } from "../services/agent/ModelCostRegistry";

interface Props {
  consumed: BudgetConsumed;
}

export default function TaskCostSummary({ consumed }: Props) {
  return (
    <div className="task-cost-summary" aria-label="Task cost summary">
      Task complete · {consumed.rounds} {consumed.rounds === 1 ? "round" : "rounds"} ·{" "}
      {consumed.totalTokens.toLocaleString()} tokens · {formatCostInr(consumed.estimatedCostUsd)}
    </div>
  );
}
