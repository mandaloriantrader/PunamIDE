// src/components/ContextBudgetIndicator.tsx
//
// Compact inline indicator showing context budget usage when
// enableContextOptimization is active. Non-blocking / informational only.

import { Layers } from "lucide-react";

export interface ContextBudgetSources {
  tfidf: number;
  ast: number;
  embeddings: number;
  memory: number;
}

export interface ContextBudgetInfo {
  /** 0-1 fraction of budget used */
  budgetUsed: number;
  /** Total tokens in assembled context */
  totalTokens: number;
  /** Maximum fillable tokens for the model */
  fillableTokens: number;
  /** Per-source contribution counts */
  sources: ContextBudgetSources;
}

interface Props {
  /** Budget info from ContextAssembler. If null, shows "active" placeholder. */
  info: ContextBudgetInfo | null;
  /** Whether the context optimization feature is enabled */
  enabled: boolean;
}

function formatTokenCount(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
  if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}K`;
  return String(tokens);
}

export default function ContextBudgetIndicator({ info, enabled }: Props) {
  if (!enabled) return null;

  // When no real-time data is available yet, show a compact "active" badge
  if (!info) {
    return (
      <div className="context-budget-indicator context-budget-indicator--placeholder">
        <Layers size={12} className="context-budget-icon" />
        <span className="context-budget-label">Context optimization: Active ✓</span>
      </div>
    );
  }

  const pct = Math.round(info.budgetUsed * 100);
  const usedStr = formatTokenCount(info.totalTokens);
  const maxStr = formatTokenCount(info.fillableTokens);
  const { tfidf, ast, embeddings, memory } = info.sources;

  return (
    <div className={`context-budget-indicator ${pct > 85 ? "context-budget-indicator--pressure" : ""}`}>
      <Layers size={12} className="context-budget-icon" />
      <span className="context-budget-usage">
        Context: {pct}% ({usedStr}/{maxStr} tokens)
      </span>
      <span className="context-budget-sources">
        TF-IDF: {tfidf} · AST: {ast} · Embed: {embeddings} · Mem: {memory}
      </span>
    </div>
  );
}
