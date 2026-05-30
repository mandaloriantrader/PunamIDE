/**
 * TechnicalDebtDashboard.tsx — Phase 7, Step 7.4
 *
 * Dashboard showing overall technical debt score, trend chart, hotspot
 * heatmap, refactor queue, and effort/impact matrix.
 */

import { useState, useEffect, useCallback } from "react";
import {
  TrendingUp,
  TrendingDown,
  BarChart3,
  AlertTriangle,
  FileCode,
  Target,
  Clock,
  ChevronDown,
  ChevronRight,
  RefreshCw,
  Zap,
} from "lucide-react";
import { getDebtScorer } from "../services/technicalDebt/DebtScorer";
import { getRefactorPlanner } from "../services/technicalDebt/RefactorPlanner";
import { getDebtAnalyzer } from "../services/technicalDebt/DebtAnalyzer";
import type { DebtScore, ModuleDebtScore as DebtModuleScore, EffortImpactMatrix } from "../services/technicalDebt/DebtScorer";
import type { ProjectDebtAnalysis, FileDebtMetrics, DebtHotspot } from "../services/technicalDebt/DebtAnalyzer";
import type { RefactorPlan, RefactorPlanItem } from "../services/technicalDebt/RefactorPlanner";

// ── Styles ────────────────────────────────────────────────────────────────────

const CATEGORY_COLORS: Record<string, string> = {
  excellent: "#34d399",
  good: "#60a5fa",
  fair: "#fbbf24",
  poor: "#f87171",
  critical: "#ef4444",
};

const CATEGORY_BG: Record<string, string> = {
  excellent: "#065f4620",
  good: "#1e3a5f20",
  fair: "#92400e20",
  poor: "#991b1b20",
  critical: "#7f1d1d30",
};

const EFFORT_COLORS: Record<string, string> = {
  low: "#34d399",
  medium: "#fbbf24",
  high: "#f87171",
};

const PANEL_STYLE: React.CSSProperties = {
  display: "flex", flexDirection: "column", height: "100%",
  background: "var(--bg-primary, #1a1a2e)", color: "var(--text-primary, #e0e0e0)",
  fontFamily: "var(--font-mono, 'JetBrains Mono', monospace)", overflow: "auto",
};

const HEADER_STYLE: React.CSSProperties = {
  padding: "12px 16px", borderBottom: "1px solid var(--border-color, #2a2a4a)",
  display: "flex", alignItems: "center", gap: "8px", fontSize: "13px", fontWeight: 600, flexShrink: 0,
};

// ── Component ─────────────────────────────────────────────────────────────────

export default function TechnicalDebtDashboard({ projectPath }: { projectPath?: string }) {
  const [score, setScore] = useState<DebtScore | null>(null);
  const [plan, setPlan] = useState<RefactorPlan | null>(null);
  const [loading, setLoading] = useState(false);
  const [showModules, setShowModules] = useState(false);
  const [showTasks, setShowTasks] = useState(false);
  const [showTrend, setShowTrend] = useState(false);
  const [filePaths, setFilePaths] = useState<string[]>([]);

  // Collect project file paths on mount
  useEffect(() => {
    if (!projectPath) return;
    const files: string[] = [];
    const scanDir = async (dir: string, depth = 0) => {
      if (depth > 3 || files.length > 200) return;
      try {
        const { readDir } = await import("@tauri-apps/plugin-fs");
        const items = await readDir(dir);
        for (const item of items) {
          if (item.isDirectory && !/^(node_modules|\.git|dist|build|target)/i.test(item.name)) {
            await scanDir(`${dir}/${item.name}`, depth + 1);
          } else {
            const ext = item.name.split(".").pop()?.toLowerCase() || "";
            if (["ts", "tsx", "js", "jsx", "py", "rs", "go", "java"].includes(ext)) {
              files.push(item.name);
            }
          }
        }
      } catch { /* skip */ }
    };
    scanDir(projectPath).then(() => setFilePaths(files));
  }, [projectPath]);

  const handleAnalyze = useCallback(async () => {
    setLoading(true);
    try {
      const analyzer = getDebtAnalyzer();
      const analysis = await analyzer.analyzeProject(filePaths);
      const debtScorer = getDebtScorer();
      const scored = debtScorer.score(analysis);
      setScore(scored);

      // Generate refactor plan
      const planGenerator = getRefactorPlanner();
      const generatedPlan = planGenerator.generatePlan(analysis);
      setPlan(generatedPlan);
    } catch {
      // Silently handle
    } finally {
      setLoading(false);
    }
  }, [filePaths]);

  return (
    <div style={PANEL_STYLE}>
      <div style={HEADER_STYLE}>
        <BarChart3 size={16} />
        Technical Debt Intelligence
        <span style={{ fontSize: "10px", color: "var(--text-secondary, #a0a0b0)", marginLeft: "auto" }}>Phase 7</span>
      </div>

      {/* Action */}
      <div style={{ padding: "8px 16px", borderBottom: "1px solid var(--border-color, #2a2a4a)", flexShrink: 0 }}>
        <button onClick={handleAnalyze} disabled={loading || filePaths.length === 0}
          style={{ padding: "6px 14px", background: "var(--accent-color, #3b82f6)", border: "none",
            borderRadius: "6px", color: "#fff", fontSize: "11px", fontWeight: 600,
            cursor: loading ? "not-allowed" : "pointer", display: "flex", alignItems: "center", gap: "6px",
            fontFamily: "inherit", opacity: loading ? 0.5 : 1 }}>
          {loading ? <RefreshCw size={12} style={{ animation: "spin 1s linear infinite" }} /> : <RefreshCw size={12} />}
          Analyze Debt
        </button>
      </div>

      {score && (
        <>
          {/* Score card */}
          <div style={{ margin: "12px 16px", padding: "14px", background: "var(--bg-card, #16162a)",
            border: "1px solid var(--border-color, #2a2a4a)", borderRadius: "8px" }}>
            <div style={{ display: "flex", alignItems: "center", gap: "16px", marginBottom: "10px" }}>
              <div style={{
                width: 52, height: 52, borderRadius: "50%",
                background: CATEGORY_BG[score.category] || "#1e3a5f20",
                border: `3px solid ${CATEGORY_COLORS[score.category] || "#60a5fa"}`,
                display: "flex", alignItems: "center", justifyContent: "center",
                fontWeight: 700, fontSize: 18, color: CATEGORY_COLORS[score.category] || "#60a5fa",
              }}>
                {score.category.charAt(0).toUpperCase()}
              </div>
              <div>
                <div style={{ fontSize: "20px", fontWeight: 700 }}>{score.overall}/100</div>
                <div style={{ fontSize: "11px", color: "var(--text-secondary, #a0a0b0)" }}>
                  {score.trend === "improving" ? (
                    <span style={{ color: "#34d399" }}><TrendingDown size={12} style={{ verticalAlign: "middle" }} /> Improving</span>
                  ) : score.trend === "declining" ? (
                    <span style={{ color: "#f87171" }}><TrendingUp size={12} style={{ verticalAlign: "middle" }} /> Declining</span>
                  ) : (
                    "Stable"
                  )}
                </div>
              </div>
            </div>
            <div style={{ fontSize: "11px", color: "var(--text-secondary, #a0a0b0)", lineHeight: 1.5 }}>
              Category: {score.category} · {score.modules.length} modules analyzed
            </div>
          </div>

          {/* Modules */}
          {score.modules.length > 0 && (
            <div style={{ margin: "8px 16px" }}>
              <button onClick={() => setShowModules(!showModules)}
                style={{ display: "flex", alignItems: "center", gap: "6px", background: "none", border: "none",
                  color: "var(--text-secondary, #a0a0b0)", fontSize: "12px", fontWeight: 600, cursor: "pointer", fontFamily: "inherit", padding: 0 }}>
                {showModules ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                Module Breakdown ({score.modules.length})
              </button>
              {showModules && (
                <div style={{ marginTop: "6px" }}>
                  {score.modules.map((mod) => (
                    <div key={mod.module} style={{ display: "flex", alignItems: "center", gap: "8px",
                      padding: "6px 10px", background: "var(--bg-input, #1a1a2e)", borderRadius: "4px", marginBottom: "4px", fontSize: "11px" }}>
                      <span style={{ width: "24px", textAlign: "center", fontWeight: 700, color: CATEGORY_COLORS[score.category] || "#60a5fa" }}>●</span>
                      <span style={{ flex: 1 }}>{mod.module}</span>
                      <span style={{ color: "var(--text-secondary, #a0a0b0)" }}>{mod.score}</span>
                      <span style={{ color: "var(--text-secondary, #a0a0b0)", fontSize: "10px" }}>{mod.fileCount}f</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Trend history */}
          {score.trendHistory && score.trendHistory.length > 1 && (
            <div style={{ margin: "8px 16px" }}>
              <button onClick={() => setShowTrend(!showTrend)}
                style={{ display: "flex", alignItems: "center", gap: "6px", background: "none", border: "none",
                  color: "var(--text-secondary, #a0a0b0)", fontSize: "12px", fontWeight: 600, cursor: "pointer", fontFamily: "inherit", padding: 0 }}>
                {showTrend ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                Trend History ({score.trendHistory.length} scans)
              </button>
              {showTrend && (
                <div style={{ marginTop: "6px", maxHeight: "200px", overflow: "auto" }}>
                  {score.trendHistory.slice(-20).reverse().map((t, i) => (
                    <div key={i} style={{ display: "flex", alignItems: "center", gap: "8px", padding: "3px 8px", fontSize: "10px", color: "var(--text-secondary, #a0a0b0)" }}>
                      <span style={{ color: CATEGORY_COLORS[score.category] || "#60a5fa", fontWeight: 600 }}>{score.category.charAt(0).toUpperCase()}</span>
                      <span>{t.score}</span>
                      <span style={{ flex: 1 }}>{new Date(t.date).toLocaleDateString()}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Refactor plan */}
          {plan && plan.items && plan.items.length > 0 && (
            <div style={{ margin: "8px 16px" }}>
              <button onClick={() => setShowTasks(!showTasks)}
                style={{ display: "flex", alignItems: "center", gap: "6px", background: "none", border: "none",
                  color: "var(--text-secondary, #a0a0b0)", fontSize: "12px", fontWeight: 600, cursor: "pointer", fontFamily: "inherit", padding: 0 }}>
                {showTasks ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                <Target size={14} />
                Refactor Queue ({plan.items.length} items, ~{plan.totalEstimatedHours}h)
              </button>
              {showTasks && (
                <div style={{ marginTop: "6px" }}>
                  {plan.items.slice(0, 10).map((item) => (
                    <div key={item.filePath} style={{ padding: "6px 8px", background: "var(--bg-input, #1a1a2e)",
                      borderRadius: "4px", marginBottom: "4px", fontSize: "10px",
                      borderLeft: `3px solid ${EFFORT_COLORS[item.estimatedEffort] || "#fbbf24"}` }}>
                      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "2px" }}>
                        <span style={{ fontWeight: 600 }}>
                          <FileCode size={10} style={{ verticalAlign: "middle", marginRight: "4px" }} />
                          {item.filePath}
                        </span>
                        <span style={{ color: EFFORT_COLORS[item.estimatedEffort] || "#fbbf24" }}>{item.estimatedEffort} · {item.effortHours}h</span>
                      </div>
                      <div style={{ color: "var(--text-secondary, #a0a0b0)", lineHeight: 1.4 }}>
                        {item.recommendation}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </>
      )}

      {!score && !loading && (
        <div style={{ padding: "32px", textAlign: "center", color: "var(--text-secondary, #a0a0b0)", fontSize: "12px" }}>
          <BarChart3 size={24} style={{ marginBottom: "8px", opacity: 0.5 }} />
          <div>Run analysis to calculate project technical debt</div>
        </div>
      )}

      <div style={{ padding: "8px 16px", borderTop: "1px solid var(--border-color, #2a2a4a)",
        fontSize: "10px", color: "var(--text-secondary, #a0a0b0)", marginTop: "auto" }}>
        Scored on: file size, function length, comments, duplication, dependency depth, TODOs, test coverage
      </div>
    </div>
  );
}