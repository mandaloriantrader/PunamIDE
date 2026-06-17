/**
 * UsageDashboard - minimal token usage summary.
 */

import { useState, useEffect } from "react";
import { BarChart3 } from "lucide-react";

interface UsageRecord {
  id: string;
  timestamp: number;
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cost: number;
}

interface CostGuardrail {
  enabled: boolean;
  dailyLimit: number;
  sessionLimit: number;
  warningThreshold: number;
}

const STORAGE_KEY = "punam-usage-records";
const GUARDRAIL_KEY = "punam-cost-guardrails";

function loadRecords(): UsageRecord[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function saveRecords(records: UsageRecord[]) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(records.slice(-500)));
}

function loadGuardrails(): CostGuardrail {
  try {
    const raw = localStorage.getItem(GUARDRAIL_KEY);
    return raw ? JSON.parse(raw) : { enabled: false, dailyLimit: 83, sessionLimit: 42, warningThreshold: 0.8 };
  } catch {
    return { enabled: false, dailyLimit: 83, sessionLimit: 42, warningThreshold: 0.8 };
  }
}

const COST_RATES_INR_PER_1K: Record<string, { input: number; output: number }> = {
  "gemini-2.0-flash": { input: 0, output: 0 },
  "gemini-1.5-flash": { input: 0, output: 0 },
  "llama-3.3-70b-versatile": { input: 0, output: 0 },
  "deepseek/deepseek-r1:free": { input: 0, output: 0 },
  "gpt-4o-mini": { input: 0.01245, output: 0.0498 },
  "gpt-4o": { input: 0.2075, output: 0.83 },
  default: { input: 0.083, output: 0.166 },
};

export function estimateCost(model: string, inputTokens: number, outputTokens: number): number {
  const rates = COST_RATES_INR_PER_1K[model] || COST_RATES_INR_PER_1K.default;
  return (inputTokens / 1000) * rates.input + (outputTokens / 1000) * rates.output;
}

export function recordUsage(provider: string, model: string, inputTokens: number, outputTokens: number, costInr?: number) {
  const records = loadRecords();
  records.push({
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    timestamp: Date.now(),
    provider,
    model,
    inputTokens,
    outputTokens,
    cost: costInr ?? estimateCost(model, inputTokens, outputTokens),
  });
  saveRecords(records);
}

export function checkGuardrail(): { allowed: boolean; warning?: string } {
  const guardrails = loadGuardrails();
  if (!guardrails.enabled) return { allowed: true };

  const records = loadRecords();
  const dayStart = Date.now() - 24 * 60 * 60 * 1000;
  const dailyCost = records
    .filter((r) => r.timestamp > dayStart)
    .reduce((sum, r) => sum + r.cost, 0);

  if (dailyCost >= guardrails.dailyLimit) {
    return { allowed: false, warning: `Daily budget exceeded (Rs ${dailyCost.toFixed(4)} / Rs ${guardrails.dailyLimit})` };
  }

  if (dailyCost >= guardrails.dailyLimit * guardrails.warningThreshold) {
    return { allowed: true, warning: `Approaching daily limit (Rs ${dailyCost.toFixed(4)} / Rs ${guardrails.dailyLimit})` };
  }

  return { allowed: true };
}

function tokenStats(records: UsageRecord[]) {
  const input = records.reduce((sum, record) => sum + record.inputTokens, 0);
  const output = records.reduce((sum, record) => sum + record.outputTokens, 0);
  return { input, output, total: input + output };
}

export default function UsageDashboard() {
  const [records, setRecords] = useState<UsageRecord[]>(loadRecords);

  useEffect(() => {
    const interval = setInterval(() => setRecords(loadRecords()), 5000);
    return () => clearInterval(interval);
  }, []);

  const now = Date.now();
  const today = records.filter((record) => record.timestamp > now - 24 * 60 * 60 * 1000);
  const week = records.filter((record) => record.timestamp > now - 7 * 24 * 60 * 60 * 1000);
  const month = records.filter((record) => record.timestamp > now - 30 * 24 * 60 * 60 * 1000);
  const monthCostInr = month.reduce((sum, record) => sum + record.cost, 0);

  const rows = [
    { label: "Today", stats: tokenStats(today) },
    { label: "This week", stats: tokenStats(week) },
    { label: "This month", stats: tokenStats(month) },
  ];

  return (
    <div className="usage-dashboard">
      <div className="usage-header">
        <BarChart3 size={16} />
        <span>Token Usage</span>
      </div>

      <div className="usage-token-list">
        {rows.map((row) => (
          <div key={row.label} className="usage-token-row">
            <span>{row.label}</span>
            <div className="usage-token-values">
              <strong>{row.stats.total.toLocaleString()}</strong>
              <small>
                {row.stats.input.toLocaleString()} in / {row.stats.output.toLocaleString()} out
              </small>
            </div>
          </div>
        ))}
      </div>

      <div className="usage-inr-note">
        Estimated month spend: Rs {monthCostInr.toFixed(monthCostInr < 1 ? 4 : 2)}
      </div>

      {records.length === 0 && (
        <div className="usage-empty">
          Usage appears after a model response completes.
        </div>
      )}
    </div>
  );
}
