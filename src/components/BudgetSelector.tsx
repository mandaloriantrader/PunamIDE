/**
 * BudgetSelector — Compact preset budget picker for embedding near chat input.
 *
 * Renders a horizontal row of small buttons (None, Small, Medium, Large).
 * Selection constructs a TokenBudget with default 'warn_continue' strategy
 * and calls onChange with the result.
 */

import { useState, useCallback } from "react";
import type { TokenBudget } from "../services/agent/BudgetController";

interface BudgetSelectorProps {
  onChange: (budget: TokenBudget | undefined) => void;
}

interface BudgetPreset {
  key: string;
  label: string;
  maxCostUsd?: number;
  maxTokens?: number;
}

const BUDGET_PRESETS: BudgetPreset[] = [
  { key: "none", label: "No limit" },
  { key: "small", label: "≈₹8", maxCostUsd: 0.10, maxTokens: 50_000 },
  { key: "medium", label: "≈₹42", maxCostUsd: 0.50, maxTokens: 150_000 },
  { key: "large", label: "≈₹167", maxCostUsd: 2.00, maxTokens: 500_000 },
];

export function BudgetSelector({ onChange }: BudgetSelectorProps) {
  const [activeKey, setActiveKey] = useState<string>("none");

  const handleSelect = useCallback(
    (preset: BudgetPreset) => {
      setActiveKey(preset.key);

      if (preset.key === "none") {
        onChange(undefined);
        return;
      }

      const budget: TokenBudget = {
        maxTokens: preset.maxTokens,
        maxCostUsd: preset.maxCostUsd,
        warningThresholdPct: 0.80,
        hardLimitPct: 0.95,
        strategy: "warn_continue",
      };

      onChange(budget);
    },
    [onChange],
  );

  return (
    <div className="budget-selector" role="group" aria-label="Task budget">
      {BUDGET_PRESETS.map((preset) => (
        <button
          key={preset.key}
          type="button"
          className={`budget-selector-btn${activeKey === preset.key ? " active" : ""}`}
          onClick={() => handleSelect(preset)}
          aria-pressed={activeKey === preset.key}
        >
          {preset.label}
        </button>
      ))}
    </div>
  );
}
