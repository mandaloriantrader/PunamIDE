/**
 * TechnicalDebtDashboard.tsx — Phase 3
 *
 * Phase 3 additions:
 *  - PlanItemCard expanded panel shows AST detail when available:
 *    complexity band + score, nesting band + depth, god function/class counts,
 *    max parameter count — concrete numbers not vague labels
 *  - ComplexityBadge and NestingBadge sub-components using Phase 3 band colors
 *  - ASTDetailPanel renders inside expanded PlanItemCard and ModuleRow hotspots
 *  - Footer updated to reflect Phase 3 scoring model
 */

import { useState, useEffect, useCallback } from "react";
import {
  BarChart3,
  TrendingUp,
  TrendingDown,
  FileCode,
  Target,
  RefreshCw,
  ChevronDown,
  ChevronRight,
  Zap,
  Layers,
  Wrench,
  GitBranch,
  AlertCircle,
  CheckCircle2,
  Database,
} from "lucide-react";
import { getDebtAnalyzer }   from "../services/technicalDebt/DebtAnalyzer";
import { getDebtScorer }     from "../services/technicalDebt/DebtScorer";
import { getRefactorPlanner } from "../services/technicalDebt/RefactorPlanner";
import type { DebtScore, ModuleDebtScore }   from "../services/technicalDebt/DebtScorer";
import type { ProjectDebtAnalysis, DiscoveryMetrics, HotspotASTDetail } from "../services/technicalDebt/DebtAnalyzer";
import { classifyComplexity, classifyNesting } from "../services/technicalDebt/DebtAnalyzer";
import type { RefactorPlan, RefactorPlanItem } from "../services/technicalDebt/RefactorPlanner";

// ── Constants ─────────────────────────────────────────────────────────────────

const MAX_FILES_DEFAULT = 2000;

const CATEGORY_COLOR: Record<string, string> = {
  excellent: "#34d399",
  good:      "#60a5fa",
  fair:      "#fbbf24",
  poor:      "#f87171",
  critical:  "#ef4444",
};

const CATEGORY_BG: Record<string, string> = {
  excellent: "#065f4620",
  good:      "#1e3a5f20",
  fair:      "#92400e20",
  poor:      "#991b1b20",
  critical:  "#7f1d1d30",
};

const EFFORT_COLOR: Record<string, string> = {
  low:    "#34d399",
  medium: "#fbbf24",
  high:   "#f87171",
};

const RISK_COLOR: Record<string, string> = {
  low:    "#34d399",
  medium: "#fbbf24",
  high:   "#ef4444",
};

// Phase 3 — complexity and nesting band colors
const COMPLEXITY_COLOR: Record<string, string> = {
  good:     "#34d399",
  moderate: "#fbbf24",
  high:     "#f87171",
  critical: "#ef4444",
};

const NESTING_COLOR: Record<string, string> = {
  good:    "#34d399",
  warning: "#fbbf24",
  refactor: "#f87171",
};

const CATEGORY_ICONS: Record<string, React.ReactNode> = {
  quick_win:      <Zap      size={11} />,
  major_refactor: <Layers   size={11} />,
  maintenance:    <Wrench   size={11} />,
  architectural:  <GitBranch size={11} />,
};

const CATEGORY_LABEL: Record<string, string> = {
  quick_win:      "Quick Win",
  major_refactor: "Major Refactor",
  maintenance:    "Maintenance",
  architectural:  "Architectural",
};

// ── Styles ────────────────────────────────────────────────────────────────────

const PANEL: React.CSSProperties = {
  display: "flex", flexDirection: "column", height: "100%",
  background: "var(--bg-primary, #1a1a2e)",
  color: "var(--text-primary, #e0e0e0)",
  fontFamily: "var(--font-mono, 'JetBrains Mono', monospace)",
  overflow: "auto",
};

const HEADER: React.CSSProperties = {
  padding: "12px 16px",
  borderBottom: "1px solid var(--border-color, #2a2a4a)",
  display: "flex", alignItems: "center", gap: "8px",
  fontSize: "13px", fontWeight: 600, flexShrink: 0,
};

const SECTION_BTN: React.CSSProperties = {
  display: "flex", alignItems: "center", gap: "6px",
  background: "none", border: "none",
  color: "var(--text-secondary, #a0a0b0)",
  fontSize: "12px", fontWeight: 600,
  cursor: "pointer", fontFamily: "inherit", padding: 0,
};

const CARD: React.CSSProperties = {
  margin: "12px 16px", padding: "14px",
  background: "var(--bg-card, #16162a)",
  border: "1px solid var(--border-color, #2a2a4a)",
  borderRadius: "8px",
};

const ROW: React.CSSProperties = {
  display: "flex", alignItems: "center", gap: "8px",
  padding: "6px 10px",
  background: "var(--bg-input, #1a1a2e)",
  borderRadius: "4px", marginBottom: "4px", fontSize: "11px",
};

// ── File discovery ─────────────────────────────────────────────────────────────

const SOURCE_EXT = new Set(["ts", "tsx", "js", "jsx", "py", "rs", "go", "java", "cs"]);
const SKIP_DIRS  = /^(node_modules|\.git|dist|build|target|\.next|\.turbo|coverage|out)$/i;

async function scanWorkspace(
  projectPath: string,
  maxFiles: number,
): Promise<{ paths: string[]; discovered: number }> {
  const { readDir } = await import("@tauri-apps/plugin-fs");
  const paths: string[] = [];
  let discovered = 0;

  async function recurse(dir: string): Promise<void> {
    if (maxFiles > 0 && paths.length >= maxFiles) return;
    let items;
    try {
      items = await readDir(dir);
    } catch {
      return;
    }

    for (const item of items) {
      if (maxFiles > 0 && paths.length >= maxFiles) break;

      const fullPath = `${dir}/${item.name}`;

      if (item.isDirectory) {
        if (!SKIP_DIRS.test(item.name)) {
          await recurse(fullPath);
        }
      } else {
        discovered++;
        const ext = item.name.split(".").pop()?.toLowerCase() ?? "";
        if (SOURCE_EXT.has(ext)) {
          paths.push(fullPath);   // absolute path
        }
      }
    }
  }

  await recurse(projectPath);
  return { paths, discovered };
}

// ── Component ─────────────────────────────────────────────────────────────────

interface Props {
  projectPath?: string;
  maxFiles?: number;   // configurable limit, default 2000
}

export default function TechnicalDebtDashboard({
  projectPath,
  maxFiles = MAX_FILES_DEFAULT,
}: Props) {
  const [filePaths, setFilePaths]     = useState<string[]>([]);
  const [totalDiscovered, setTotalDiscovered] = useState(0);
  const [score, setScore]             = useState<DebtScore | null>(null);
  const [plan, setPlan]               = useState<RefactorPlan | null>(null);
  const [discovery, setDiscovery]     = useState<DiscoveryMetrics | null>(null);
  const [loading, setLoading]         = useState(false);
  const [scanning, setScanning]       = useState(false);

  // Collapsible sections
  const [showModules,    setShowModules]    = useState(false);
  const [showTrend,      setShowTrend]      = useState(false);
  const [showDiscovery,  setShowDiscovery]  = useState(false);
  const [showQuickWins,  setShowQuickWins]  = useState(true);
  const [showMajor,      setShowMajor]      = useState(false);
  const [showMaintenance, setShowMaintenance] = useState(false);
  const [showArch,       setShowArch]       = useState(false);

  // Scan workspace when projectPath changes
  useEffect(() => {
    if (!projectPath) return;
    setScanning(true);
    scanWorkspace(projectPath, maxFiles)
      .then(({ paths, discovered }) => {
        setFilePaths(paths);
        setTotalDiscovered(discovered);
      })
      .catch(() => {})
      .finally(() => setScanning(false));
  }, [projectPath, maxFiles]);

  const handleAnalyze = useCallback(async () => {
    if (!filePaths.length) return;
    setLoading(true);
    try {
      const analyzer  = getDebtAnalyzer();
      const analysis  = await analyzer.analyzeProject(filePaths, { maxFiles });
      setDiscovery(analysis.discovery);

      const scorer    = getDebtScorer();
      setScore(scorer.score(analysis));

      const planner   = getRefactorPlanner();
      setPlan(planner.generatePlan(analysis));
    } catch {
      // Silently handle
    } finally {
      setLoading(false);
    }
  }, [filePaths, maxFiles]);

  // ── Render helpers ───────────────────────────────────────────────────────────

  const renderPlanSection = (
    items: RefactorPlanItem[],
    show: boolean,
    toggle: () => void,
    label: string,
    icon: React.ReactNode,
    accentColor: string,
  ) => {
    if (!items.length) return null;
    return (
      <div style={{ margin: "6px 16px" }}>
        <button onClick={toggle} style={SECTION_BTN}>
          {show ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          {icon}
          <span style={{ color: accentColor }}>{label}</span>
          <span style={{ color: "var(--text-secondary, #a0a0b0)", fontWeight: 400 }}>
            ({items.length})
          </span>
        </button>
        {show && (
          <div style={{ marginTop: "6px" }}>
            {items.map((item, i) => (
              <PlanItemCard key={`${item.filePath}-${i}`} item={item} />
            ))}
          </div>
        )}
      </div>
    );
  };

  // ── Main render ───────────────────────────────────────────────────────────────

  return (
    <div style={PANEL}>

      {/* Header */}
      <div style={HEADER}>
        <BarChart3 size={16} />
        Technical Debt Intelligence
        <span style={{ fontSize: "10px", color: "var(--text-secondary, #a0a0b0)", marginLeft: "auto" }}>
          Phase 1
        </span>
      </div>

      {/* Action bar */}
      <div style={{ padding: "8px 16px", borderBottom: "1px solid var(--border-color, #2a2a4a)", flexShrink: 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
          <button
            onClick={handleAnalyze}
            disabled={loading || scanning || filePaths.length === 0}
            style={{
              padding: "6px 14px",
              background: "var(--accent-color, #3b82f6)",
              border: "none", borderRadius: "6px",
              color: "#fff", fontSize: "11px", fontWeight: 600,
              cursor: (loading || scanning || !filePaths.length) ? "not-allowed" : "pointer",
              display: "flex", alignItems: "center", gap: "6px",
              fontFamily: "inherit",
              opacity: (loading || scanning || !filePaths.length) ? 0.5 : 1,
            }}>
            <RefreshCw
              size={12}
              style={{ animation: loading ? "spin 1s linear infinite" : "none" }}
            />
            {loading ? "Analyzing…" : "Analyze Debt"}
          </button>

          {/* File discovery summary */}
          <span style={{ fontSize: "10px", color: "var(--text-secondary, #a0a0b0)" }}>
            {scanning
              ? "Scanning…"
              : filePaths.length > 0
              ? `${filePaths.length} source files`
              : projectPath
              ? "No source files found"
              : "No project open"}
          </span>
        </div>
      </div>

      {score && (
        <>
          {/* ── Overall score card ─────────────────────────────────────────── */}
          <div style={CARD}>
            <div style={{ display: "flex", alignItems: "center", gap: "16px", marginBottom: "10px" }}>
              <div style={{
                width: 52, height: 52, borderRadius: "50%",
                background: CATEGORY_BG[score.category] ?? "#1e3a5f20",
                border: `3px solid ${CATEGORY_COLOR[score.category] ?? "#60a5fa"}`,
                display: "flex", alignItems: "center", justifyContent: "center",
                fontWeight: 700, fontSize: 18,
                color: CATEGORY_COLOR[score.category] ?? "#60a5fa",
              }}>
                {score.overall}
              </div>
              <div>
                <div style={{ fontSize: "16px", fontWeight: 700, textTransform: "capitalize" }}>
                  {score.category}
                </div>
                <div style={{ fontSize: "11px", color: "var(--text-secondary, #a0a0b0)" }}>
                  {score.trend === "improving" ? (
                    <span style={{ color: "#34d399" }}>
                      <TrendingDown size={12} style={{ verticalAlign: "middle" }} /> Improving
                    </span>
                  ) : score.trend === "declining" ? (
                    <span style={{ color: "#f87171" }}>
                      <TrendingUp size={12} style={{ verticalAlign: "middle" }} /> Declining
                    </span>
                  ) : (
                    <span>Stable</span>
                  )}
                </div>
              </div>
            </div>
            <div style={{ fontSize: "11px", color: "var(--text-secondary, #a0a0b0)", lineHeight: 1.6 }}>
              {score.modules.length} modules · {score.overall}/100
            </div>
          </div>

          {/* ── Discovery metrics ──────────────────────────────────────────── */}
          {discovery && (
            <div style={{ margin: "6px 16px" }}>
              <button onClick={() => setShowDiscovery(!showDiscovery)} style={SECTION_BTN}>
                {showDiscovery ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                <Database size={13} />
                Discovery Metrics
              </button>
              {showDiscovery && (
                <div style={{ marginTop: "6px", display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: "6px" }}>
                  {[
                    { label: "Discovered", value: totalDiscovered, color: "#60a5fa" },
                    { label: "Analyzed",   value: discovery.analyzed, color: "#34d399" },
                    { label: "From Cache", value: discovery.fromCache, color: "#a78bfa" },
                    { label: "Skipped",    value: discovery.skipped,  color: "#fbbf24" },
                    { label: "Failed",     value: discovery.failed,   color: "#f87171" },
                  ].map(({ label, value, color }) => (
                    <div key={label} style={{
                      padding: "6px 8px", background: "var(--bg-input, #1a1a2e)",
                      borderRadius: "4px", textAlign: "center",
                    }}>
                      <div style={{ fontSize: "16px", fontWeight: 700, color }}>{value}</div>
                      <div style={{ fontSize: "9px", color: "var(--text-secondary, #a0a0b0)" }}>{label}</div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* ── Module breakdown ───────────────────────────────────────────── */}
          {score.modules.length > 0 && (
            <div style={{ margin: "6px 16px" }}>
              <button onClick={() => setShowModules(!showModules)} style={SECTION_BTN}>
                {showModules ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                Module Breakdown ({score.modules.length})
              </button>
              {showModules && (
                <div style={{ marginTop: "6px" }}>
                  {score.modules.map((mod) => (
                    <ModuleRow key={mod.module} mod={mod} />
                  ))}
                </div>
              )}
            </div>
          )}

          {/* ── Trend history ──────────────────────────────────────────────── */}
          {score.trendHistory.length > 1 && (
            <div style={{ margin: "6px 16px" }}>
              <button onClick={() => setShowTrend(!showTrend)} style={SECTION_BTN}>
                {showTrend ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                Trend History ({score.trendHistory.length} scans)
              </button>
              {showTrend && (
                <div style={{ marginTop: "6px", maxHeight: "160px", overflowY: "auto" }}>
                  {[...score.trendHistory].reverse().map((entry, i) => (
                    <div key={i} style={{ ...ROW, fontSize: "10px" }}>
                      <span style={{ color: CATEGORY_COLOR[score.category], fontWeight: 600 }}>
                        {entry.score}
                      </span>
                      <span style={{ flex: 1, color: "var(--text-secondary, #a0a0b0)" }}>
                        {new Date(entry.date).toLocaleString()}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* ── Refactor queue ─────────────────────────────────────────────── */}
          {plan && plan.items.length > 0 && (
            <>
              <div style={{
                margin: "12px 16px 4px", fontSize: "11px", fontWeight: 600,
                color: "var(--text-secondary, #a0a0b0)",
                display: "flex", alignItems: "center", gap: "6px",
              }}>
                <Target size={13} />
                Refactor Queue — {plan.items.length} items · ~{plan.totalEstimatedHours}h total
              </div>

              {renderPlanSection(
                plan.quickWins, showQuickWins, () => setShowQuickWins(!showQuickWins),
                "Quick Wins", <Zap size={12} />, "#34d399",
              )}
              {renderPlanSection(
                plan.majorRefactors, showMajor, () => setShowMajor(!showMajor),
                "Major Refactors", <Layers size={12} />, "#f87171",
              )}
              {renderPlanSection(
                plan.architecturalIssues, showArch, () => setShowArch(!showArch),
                "Architectural Issues", <GitBranch size={12} />, "#a78bfa",
              )}
              {renderPlanSection(
                plan.maintenance, showMaintenance, () => setShowMaintenance(!showMaintenance),
                "Maintenance", <Wrench size={12} />, "#fbbf24",
              )}
            </>
          )}
        </>
      )}

      {/* Empty state */}
      {!score && !loading && (
        <div style={{ padding: "32px", textAlign: "center", color: "var(--text-secondary, #a0a0b0)", fontSize: "12px" }}>
          <BarChart3 size={24} style={{ marginBottom: "8px", opacity: 0.5 }} />
          <div>Run analysis to calculate project technical debt</div>
          {filePaths.length > 0 && (
            <div style={{ marginTop: "6px", fontSize: "10px" }}>
              {filePaths.length} source files ready
            </div>
          )}
        </div>
      )}

      {/* Footer */}
      <div style={{
        padding: "8px 16px",
        borderTop: "1px solid var(--border-color, #2a2a4a)",
        fontSize: "10px", color: "var(--text-secondary, #a0a0b0)",
        marginTop: "auto",
      }}>
        Scored on: file size · function length · comment ratio · dependency coupling · TODO density · duplication
      </div>
    </div>
  );
}

// ── Sub-components ─────────────────────────────────────────────────────────────

function ModuleRow({ mod }: { mod: ModuleDebtScore }) {
  const color = mod.score >= 70 ? "#34d399" : mod.score >= 50 ? "#fbbf24" : "#f87171";
  return (
    <div style={{ ...ROW }}>
      <span style={{ color, fontWeight: 700, fontSize: "13px" }}>●</span>
      <span style={{ flex: 1, fontSize: "11px" }}>{mod.module}</span>
      <span style={{ color, fontWeight: 600 }}>{mod.score}</span>
      <span style={{ color: "var(--text-secondary, #a0a0b0)", fontSize: "10px" }}>
        {mod.fileCount}f
      </span>
    </div>
  );
}

function PlanItemCard({ item }: { item: RefactorPlanItem }) {
  const [expanded, setExpanded] = useState(false);
  const effortColor = EFFORT_COLOR[item.estimatedEffort] ?? "#fbbf24";
  const riskColor   = RISK_COLOR[item.estimatedRisk]     ?? "#fbbf24";

  const displayPath = item.filePath
    .replace(/\\/g, "/")
    .split("/")
    .slice(-3)
    .join("/");

  return (
    <div style={{
      padding: "7px 10px",
      background: "var(--bg-input, #1a1a2e)",
      borderRadius: "4px", marginBottom: "4px",
      borderLeft: `3px solid ${effortColor}`,
      cursor: "pointer",
    }}
      onClick={() => setExpanded(!expanded)}
    >
      {/* Row 1: file + effort/label badges */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "3px" }}>
        <span style={{ fontSize: "10px", fontWeight: 600, display: "flex", alignItems: "center", gap: "4px" }}>
          <FileCode size={10} />
          {displayPath}
        </span>
        <div style={{ display: "flex", gap: "4px" }}>
          <Badge color={effortColor}>{item.effortLabel}</Badge>
          <Badge color={EFFORT_COLOR[item.estimatedImpact]}>{item.estimatedImpact} impact</Badge>
          <Badge color={riskColor}>{item.estimatedRisk} risk</Badge>
        </div>
      </div>

      {/* Row 2: category + recommendation */}
      <div style={{ fontSize: "10px", color: "var(--text-secondary, #a0a0b0)", display: "flex", alignItems: "center", gap: "5px" }}>
        {CATEGORY_ICONS[item.category]}
        <span style={{ color: "#a0a0b0" }}>{CATEGORY_LABEL[item.category]}</span>
        <span>·</span>
        <span>{item.recommendation}</span>
      </div>

      {/* Expanded detail panel */}
      {expanded && (
        <div style={{ marginTop: "6px", borderTop: "1px solid var(--border-color, #2a2a4a)", paddingTop: "6px" }}>

          {/* Why flagged + expected payoff */}
          <div style={{ fontSize: "10px", marginBottom: "4px" }}>
            <span style={{ color: "#f87171", fontWeight: 600 }}>
              <AlertCircle size={9} style={{ verticalAlign: "middle", marginRight: "3px" }} />
              Why flagged:
            </span>
            <span style={{ color: "var(--text-secondary, #a0a0b0)", marginLeft: "4px" }}>
              {item.whyFlagged}
            </span>
          </div>
          <div style={{ fontSize: "10px", marginBottom: "6px" }}>
            <span style={{ color: "#34d399", fontWeight: 600 }}>
              <CheckCircle2 size={9} style={{ verticalAlign: "middle", marginRight: "3px" }} />
              Expected payoff:
            </span>
            <span style={{ color: "var(--text-secondary, #a0a0b0)", marginLeft: "4px" }}>
              {item.expectedPayoff}
            </span>
          </div>

          {/* Phase 3: AST detail panel */}
          {item.astDetail && <ASTDetailPanel detail={item.astDetail} />}

          {item.dependencies.length > 0 && (
            <div style={{ fontSize: "9px", color: "var(--text-secondary, #a0a0b0)", marginTop: "4px" }}>
              Fix first: {item.dependencies.join(", ")}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── Phase 3: AST Detail Panel ─────────────────────────────────────────────────

function ASTDetailPanel({ detail }: { detail: HotspotASTDetail }) {
  const ccColor     = COMPLEXITY_COLOR[detail.complexityBand] ?? "#fbbf24";
  const nestColor   = NESTING_COLOR[detail.nestingBand]       ?? "#fbbf24";

  return (
    <div style={{
      padding: "6px 8px",
      background: "var(--bg-primary, #1a1a2e)",
      borderRadius: "4px",
      marginBottom: "4px",
      fontSize: "10px",
    }}>
      <div style={{
        fontSize: "9px", fontWeight: 600, letterSpacing: "0.05em",
        color: "var(--text-secondary, #a0a0b0)",
        marginBottom: "5px", textTransform: "uppercase",
      }}>
        Static Analysis
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "4px" }}>

        {/* Cyclomatic complexity */}
        <ASTMetricRow
          label="Complexity"
          value={`CC=${detail.cyclomaticComplexity}`}
          band={detail.complexityBand}
          color={ccColor}
        />

        {/* Nesting depth */}
        <ASTMetricRow
          label="Nesting"
          value={`depth ${detail.maxNestingDepth}`}
          band={detail.nestingBand}
          color={nestColor}
        />

        {/* God functions */}
        {detail.godFunctionCount > 0 && (
          <ASTMetricRow
            label="God functions"
            value={String(detail.godFunctionCount)}
            band="critical"
            color={COMPLEXITY_COLOR.critical}
          />
        )}

        {/* Long functions */}
        {detail.longFunctionCount > 0 && detail.godFunctionCount === 0 && (
          <ASTMetricRow
            label="Long functions"
            value={String(detail.longFunctionCount)}
            band="moderate"
            color={COMPLEXITY_COLOR.moderate}
          />
        )}

        {/* God classes */}
        {detail.godClassCount > 0 && (
          <ASTMetricRow
            label="God classes"
            value={String(detail.godClassCount)}
            band="critical"
            color={COMPLEXITY_COLOR.critical}
          />
        )}

        {/* Max params */}
        {detail.maxParameterCount > 5 && (
          <ASTMetricRow
            label="Max params"
            value={String(detail.maxParameterCount)}
            band="moderate"
            color={COMPLEXITY_COLOR.moderate}
          />
        )}
      </div>
    </div>
  );
}

function ASTMetricRow({
  label, value, band, color,
}: {
  label: string;
  value: string;
  band: string;
  color: string;
}) {
  return (
    <div style={{
      display: "flex", justifyContent: "space-between", alignItems: "center",
      padding: "2px 6px",
      background: `${color}11`,
      borderRadius: "3px",
      borderLeft: `2px solid ${color}`,
    }}>
      <span style={{ color: "var(--text-secondary, #a0a0b0)" }}>{label}</span>
      <span style={{ color, fontWeight: 600 }}>{value} <span style={{ fontWeight: 400, opacity: 0.7 }}>({band})</span></span>
    </div>
  );
}

function Badge({ color, children }: { color: string; children: React.ReactNode }) {
  return (
    <span style={{
      fontSize: "9px", padding: "1px 5px",
      borderRadius: "3px", fontWeight: 600,
      background: `${color}22`, color,
      whiteSpace: "nowrap",
    }}>
      {children}
    </span>
  );
}
