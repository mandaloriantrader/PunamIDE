import { Zap } from "lucide-react";
import type { AdaptiveStrategy } from "../../lib/ai/providerCapabilities";

interface AdaptiveModeSettingsProps {
  enabled: boolean;
  strategy: AdaptiveStrategy;
  onEnabledChange: (enabled: boolean) => void;
  onStrategyChange: (strategy: AdaptiveStrategy) => void;
}

const STRATEGIES: Array<{ value: AdaptiveStrategy; label: string }> = [
  { value: "free_first", label: "Free First" },
  { value: "fast_first", label: "Fast First" },
  { value: "best_quality", label: "Best Quality" },
  { value: "cheapest", label: "Cheapest" },
  { value: "coding_optimized", label: "Coding Optimized" },
];

export function AdaptiveModeSettings({
  enabled,
  strategy,
  onEnabledChange,
  onStrategyChange,
}: AdaptiveModeSettingsProps) {
  return (
    <div className="provider-card adaptive-mode-card">
      <div className="provider-card-header">
        <span className="provider-card-type">Adaptive</span>
        <div className="provider-name-input adaptive-mode-title">
          <Zap size={14} />
          Adaptive Mode
        </div>
        <label className="settings-toggle">
          <input
            type="checkbox"
            checked={enabled}
            onChange={(event) => onEnabledChange(event.target.checked)}
          />
          <span>{enabled ? "On" : "Off"}</span>
        </label>
      </div>
      <div className="provider-card-body">
        <div className="provider-field">
          <label>Strategy</label>
          <select
            className="settings-input"
            value={strategy}
            onChange={(event) => onStrategyChange(event.target.value as AdaptiveStrategy)}
            disabled={!enabled}
          >
            {STRATEGIES.map((item) => (
              <option key={item.value} value={item.value}>{item.label}</option>
            ))}
          </select>
        </div>
      </div>
    </div>
  );
}
