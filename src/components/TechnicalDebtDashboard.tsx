/**
 * TechnicalDebtDashboard.tsx — Phase 4
 *
 * Phase 4 additions:
 *  - handleAnalyze runs DependencyGraphEngine + CircularDepDetector +
 *    CouplingAnalyzer after file analysis, then calls applyGraphData()
 *  - Architectural Issues section shows real cycle paths and hub file
 *    fan-in/fan-out/coupling scores (not stub data)
 *  - GraphSummaryPanel: cycle count + severity, hub file count,
 *    average coupling, unresolved imports
 *  - CycleDetailPanel: expandable list of files in each cycle
 *  - Refactor Queue architectural items now carry real graph numbers
 *  - Two-phase loading: "Analyzing files…" then "Building graph…"
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
  Link,
  ArrowRightLeft,
} from "lucide-react";
import { getDebtAnalyzer }    from "../services/technicalDebt/DebtAnalyzer";
import { getDebtScorer }      from "../services/technicalDebt/DebtScorer";
import { getRefactorPlanner } from "../services/technicalDebt/RefactorPlanner";
import { getDependencyGraphEngine } from "../services/technicalDebt/DependencyGraphEngine";
import { getCircularDepDetector }   from "../services/technicalDebt/CircularDepDetector";
import { getCouplingAnalyzer }      from "../services/technicalDebt/CouplingAnalyzer";
import type { DebtScore, ModuleDebtScore }   from "../services/technicalDebt/DebtScorer";
import type {
  ProjectDebtAnalysis,
  DiscoveryMetrics,
  HotspotASTDetail,
  GraphBundle,
  ASTAnalysisStatus,
} from "../services/technicalDebt/DebtAnalyzer";
import type { RefactorPlan, RefactorPlanItem } from "../services/technicalDebt/RefactorPlanner";
import type { CycleDetectionResult }           from "../services/technicalDebt/CircularDepDetector";
import type { CouplingAnalysis }               from "../services/technicalDebt/CouplingAnalyzer";
import type { FileEntry } from "../utils/tauri";

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

function collectSourcePathsFromTree(entries: FileEntry[]): { paths: string[]; discovered: number } {
  const paths: string[] = [];
  let discovered = 0;

  function walk(items: FileEntry[]) {
    for (const entry of items) {
      discovered++;
      if (entry.is_dir) {
        if (entry.children) walk(entry.children);
        continue;
      }
      const ext = entry.name.split(".").pop()?.toLowerCase() || "";
      if (SOURCE_EXT.has(ext)) {
        paths.push(entry.path);
      }
    }
  }

  walk(entries);
  return { paths, discovered };
}

async function scanWorkspace(
  projectPath: string,
  maxFiles: number,
  explorerFiles: FileEntry[] = [],
): Promise<{ paths: string[]; discovered: number }> {
  const explorerScan = collectSourcePathsFromTree(explorerFiles);
  if (explorerScan.paths.length > 0) {
    return {
      paths: explorerScan.paths.slice(0, maxFiles > 0 ? maxFiles : undefined),
      discovered: explorerScan.discovered,
    };
  }

  const { refreshProjectIndex, readDirectory } = await import("../utils/tauri");
  const separator = projectPath.includes("\\") ? "\\" : "/";
  const root = projectPath.replace(/[\\/]+$/, "");

  const entries = await refreshProjectIndex();
  const sourcePaths = entries
    .filter((entry) => !entry.is_binary && SOURCE_EXT.has(entry.extension.toLowerCase()))
    .map((entry) => `${root}${separator}${entry.path.replace(/^[\\/]+/, "").replace(/[\\/]/g, separator)}`)
    .slice(0, maxFiles > 0 ? maxFiles : undefined);

  if (sourcePaths.length > 0) {
    return { paths: sourcePaths, discovered: entries.length };
  }

  const tree = await readDirectory(projectPath).catch(() => []);
  const treeScan = collectSourcePathsFromTree(tree);
  return {
    paths: treeScan.paths.slice(0, maxFiles > 0 ? maxFiles : undefined),
    discovered: Math.max(entries.length, treeScan.discovered),
  };
}

// ── Import map builder (Phase 4) ──────────────────────────────────────────────

async function buildImportMaps(
  filePaths: string[],
  _analysis: ProjectDebtAnalysis,
): Promise<import("../services/technicalDebt/ImportExtractor").FileImportExportMap[]> {
  const maps: import("../services/technicalDebt/ImportExtractor").FileImportExportMap[] = [];

  try {
    const { getASTEngine, extensionToLanguage } =
      await import("../services/technicalDebt/ASTEngine");
    const { getImportExtractor } =
      await import("../services/technicalDebt/ImportExtractor");
    const { readFile } = await import("../utils/tauri");

    const engine    = getASTEngine();
    const extractor = getImportExtractor();

    for (const fp of filePaths) {
      const lang = extensionToLanguage(fp);
      if (!lang) continue;
      try {
        const content = await readFile(fp).catch(() => "");
        if (!content.trim()) continue;
        const tree = await engine.parseFile(content, fp);
        if (tree) {
          maps.push(extractor.extract(tree, fp));
        }
      } catch { /* skip file */ }
    }
  } catch { /* AST unavailable — graph will be empty */ }

  return maps;
}

// ── Component ─────────────────────────────────────────────────────────────────

interface Props {
  projectPath?: string;
  maxFiles?: number;
  files?: FileEntry[];
}

export default function TechnicalDebtDashboard({
  projectPath,
  maxFiles = MAX_FILES_DEFAULT,
  files = [],
}: Props) {
  const [filePaths, setFilePaths]         = useState<string[]>([]);
  const [totalDiscovered, setTotalDiscovered] = useState(0);
  const [score, setScore]                 = useState<DebtScore | null>(null);
  const [plan, setPlan]                   = useState<RefactorPlan | null>(null);
  const [discovery, setDiscovery]         = useState<DiscoveryMetrics | null>(null);
  const [cycleResult, setCycleResult]     = useState<CycleDetectionResult | null>(null);
  const [couplingResult, setCouplingResult] = useState<CouplingAnalysis | null>(null);
  const [astStatus, setAstStatus]           = useState<ASTAnalysisStatus | null>(null);
  const [scanDurationMs, setScanDurationMs] = useState<number | null>(null);
  const [showASTDetails, setShowASTDetails] = useState(false);
  const [loading, setLoading]             = useState(false);
  const [graphBuilding, setGraphBuilding] = useState(false);
  const [scanning, setScanning]           = useState(false);

  const [showModules,     setShowModules]     = useState(false);
  const [showTrend,       setShowTrend]       = useState(false);
  const [showDiscovery,   setShowDiscovery]   = useState(false);
  const [showGraph,       setShowGraph]       = useState(true);
  const [showQuickWins,   setShowQuickWins]   = useState(true);
  const [showMajor,       setShowMajor]       = useState(false);
  const [showMaintenance, setShowMaintenance] = useState(false);
  const [showArch,        setShowArch]        = useState(true);

  useEffect(() => {
    if (!projectPath) return;
    setScanning(true);
    scanWorkspace(projectPath, maxFiles, files)
      .then(({ paths, discovered }) => {
        setFilePaths(paths);
        setTotalDiscovered(discovered);
      })
      .catch(() => {})
      .finally(() => setScanning(false));
  }, [projectPath, maxFiles, files]);

  const handleAnalyze = useCallback(async () => {
    if (!filePaths.length) return;
    setLoading(true);
    setAstStatus(null);
    setScanDurationMs(null);
    setCycleResult(null);
    setCouplingResult(null);
    const scanStartedAt = performance.now();

    try {
      // ── Phase 1: file analysis ──────────────────────────────────────────
      const analyzer = getDebtAnalyzer();
      let analysis   = await analyzer.analyzeProject(filePaths, { maxFiles });
      setDiscovery(analysis.discovery);
      setAstStatus(analysis.astStatus);
      setScanDurationMs(performance.now() - scanStartedAt);

      const scorer = getDebtScorer();
      setScore(scorer.score(analysis));
      setLoading(false);

      // ── Phase 2: dependency graph build ─────────────────────────────────
      setGraphBuilding(true);
      try {
        const importMaps = await buildImportMaps(filePaths, analysis);

        const graphEngine  = getDependencyGraphEngine();
        const graph        = graphEngine.build(importMaps, filePaths);

        const cycleDetector = getCircularDepDetector();
        const cycles        = cycleDetector.detect(graph);
        setCycleResult(cycles);

        const couplingAnalyzer = getCouplingAnalyzer();
        const coupling         = couplingAnalyzer.analyze(graph, cycles);
        setCouplingResult(coupling);

        const bundle: GraphBundle = {
          dependencyGraph:  graph,
          couplingAnalysis: coupling,
        };

        analysis = analyzer.applyGraphData(analysis, bundle);

        setScore(scorer.score(analysis));

        const planner = getRefactorPlanner();
        setPlan(planner.generatePlan(analysis));

      } finally {
        setGraphBuilding(false);
      }

    } catch {
      setLoading(false);
      setGraphBuilding(false);
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
        <span style={{ fontSize: "10px", color: "var(--text-secondary, #a0a0b0)", marginLeft: "auto", display: "flex", alignItems: "center", gap: "6px" }}>
          <ASTStatusBadge
            status={astStatus}
            onClick={() => astStatus && setShowASTDetails(true)}
          />
          Phase 4
        </span>
      </div>

      {/* Action bar */}
      <div style={{ padding: "8px 16px", borderBottom: "1px solid var(--border-color, #2a2a4a)", flexShrink: 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
          <button
            onClick={handleAnalyze}
            disabled={loading || scanning || graphBuilding || filePaths.length === 0}
            style={{
              padding: "6px 14px",
              background: "var(--accent-color, #3b82f6)",
              border: "none", borderRadius: "6px",
              color: "#fff", fontSize: "11px", fontWeight: 600,
              cursor: (loading || scanning || graphBuilding || !filePaths.length) ? "not-allowed" : "pointer",
              display: "flex", alignItems: "center", gap: "6px",
              fontFamily: "inherit",
              opacity: (loading || scanning || graphBuilding || !filePaths.length) ? 0.5 : 1,
            }}>
            <RefreshCw
              size={12}
              style={{ animation: (loading || graphBuilding) ? "spin 1s linear infinite" : "none" }}
            />
            {loading ? "Analyzing files…" : graphBuilding ? "Building graph…" : "Analyze Debt"}
          </button>

          <span style={{ fontSize: "10px", color: "var(--text-secondary, #a0a0b0)" }}>
            {scanning
              ? "Scanning…"
              : filePaths.length > 0
              ? `${filePaths.length} source files`
              : projectPath
              ? "No source files found"
              : "No project open"}
          </span>
          {astStatus && (
            <span style={{ fontSize: "9px", color: "var(--text-secondary, #a0a0b0)" }}>
              Coverage: {astStatus.supportedFiles > 0
                ? Math.round((astStatus.astFiles / astStatus.supportedFiles) * 100)
                : 0}% ({astStatus.astFiles}/{astStatus.supportedFiles})
              {astStatus.fallbackFiles > 0 ? ` · Fallback: ${astStatus.fallbackFiles}` : ""}
              {astStatus.unsupportedFiles > 0 ? ` · Unsupported: ${astStatus.unsupportedFiles}` : ""}
          </span>
          )}
        </div>
      </div>

      {showASTDetails && astStatus && (
        <ASTDetailsPanel
          status={astStatus}
          discovery={discovery}
          scanDurationMs={scanDurationMs}
          onClose={() => setShowASTDetails(false)}
        />
      )}

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

          {/* ── Graph summary (Phase 4) ──────────────────────────────────── */}
          {(cycleResult || couplingResult) && (
            <div style={{ margin: "6px 16px" }}>
              <button onClick={() => setShowGraph(!showGraph)} style={SECTION_BTN}>
                {showGraph ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                <Link size={13} />
                Dependency Graph
                {cycleResult && cycleResult.cycleCount > 0 && (
                  <span style={{ color: "#f87171", fontSize: "10px", marginLeft: "4px" }}>
                    ⚠ {cycleResult.cycleCount} cycle{cycleResult.cycleCount > 1 ? "s" : ""}
                  </span>
                )}
              </button>
              {showGraph && cycleResult && couplingResult && (
                <GraphSummaryPanel cycles={cycleResult} coupling={couplingResult} />
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

      <div style={{ fontSize: "10px", color: "var(--text-secondary, #a0a0b0)", display: "flex", alignItems: "center", gap: "5px" }}>
        {CATEGORY_ICONS[item.category]}
        <span style={{ color: "#a0a0b0" }}>{CATEGORY_LABEL[item.category]}</span>
        <span>·</span>
        <span>{item.recommendation}</span>
      </div>

      {expanded && (
        <div style={{ marginTop: "6px", borderTop: "1px solid var(--border-color, #2a2a4a)", paddingTop: "6px" }}>
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
        <ASTMetricRow
          label="Complexity"
          value={`CC=${detail.cyclomaticComplexity}`}
          band={detail.complexityBand}
          color={ccColor}
        />
        <ASTMetricRow
          label="Nesting"
          value={`depth ${detail.maxNestingDepth}`}
          band={detail.nestingBand}
          color={nestColor}
        />
        {detail.godFunctionCount > 0 && (
          <ASTMetricRow
            label="God functions"
            value={String(detail.godFunctionCount)}
            band="critical"
            color={COMPLEXITY_COLOR.critical}
          />
        )}
        {detail.longFunctionCount > 0 && detail.godFunctionCount === 0 && (
          <ASTMetricRow
            label="Long functions"
            value={String(detail.longFunctionCount)}
            band="moderate"
            color={COMPLEXITY_COLOR.moderate}
          />
        )}
        {detail.godClassCount > 0 && (
          <ASTMetricRow
            label="God classes"
            value={String(detail.godClassCount)}
            band="critical"
            color={COMPLEXITY_COLOR.critical}
          />
        )}
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

// ── Phase 4: Graph Summary Panel ─────────────────────────────────────────────

const SEVERITY_COLOR: Record<string, string> = {
  none:     "#34d399",
  minor:    "#fbbf24",
  moderate: "#f87171",
  severe:   "#ef4444",
};

function GraphSummaryPanel({
  cycles,
  coupling,
}: {
  cycles: CycleDetectionResult;
  coupling: CouplingAnalysis;
}) {
  const [showCycles, setShowCycles] = useState(false);
  const sevColor = SEVERITY_COLOR[cycles.severity] ?? "#fbbf24";

  return (
    <div style={{ marginTop: "6px" }}>

      <div style={{
        display: "grid", gridTemplateColumns: "1fr 1fr 1fr",
        gap: "6px", marginBottom: "6px",
      }}>
        <GraphStatCard
          label="Cycles"
          value={String(cycles.cycleCount)}
          sub={cycles.severity}
          color={sevColor}
        />
        <GraphStatCard
          label="Hub Files"
          value={String(coupling.hubFiles.length)}
          sub={coupling.hubFiles.length > 0 ? "bottlenecks" : "none found"}
          color={coupling.hubFiles.length > 0 ? "#f87171" : "#34d399"}
        />
        <GraphStatCard
          label="Avg Coupling"
          value={String(coupling.averageCoupling)}
          sub={coupling.averageCoupling > 60 ? "high" : coupling.averageCoupling > 30 ? "moderate" : "good"}
          color={coupling.averageCoupling > 60 ? "#f87171" : coupling.averageCoupling > 30 ? "#fbbf24" : "#34d399"}
        />
      </div>

      {cycles.cycleCount > 0 && (
        <div style={{ marginTop: "4px" }}>
          <button onClick={() => setShowCycles(!showCycles)} style={{ ...SECTION_BTN, fontSize: "10px" }}>
            {showCycles ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
            <ArrowRightLeft size={11} />
            Cycles ({cycles.cycleCount})
          </button>
          {showCycles && (
            <div style={{ marginTop: "4px" }}>
              {cycles.cycles.slice(0, 8).map((cycle, i) => (
                <div key={i} style={{
                  padding: "5px 8px",
                  background: "var(--bg-input, #1a1a2e)",
                  borderRadius: "3px", marginBottom: "3px",
                  borderLeft: `2px solid ${sevColor}`,
                  fontSize: "9px",
                }}>
                  <div style={{ color: sevColor, fontWeight: 600, marginBottom: "2px" }}>
                    Cycle {i + 1} — {cycle.length} file{cycle.length > 1 ? "s" : ""}
                  </div>
                  <div style={{ color: "var(--text-secondary, #a0a0b0)", lineHeight: 1.6 }}>
                    {cycle.map((fp) => fp.replace(/\\/g, "/").split("/").slice(-2).join("/")).join(" → ")}
                  </div>
                </div>
              ))}
              {cycles.cycleCount > 8 && (
                <div style={{ fontSize: "9px", color: "var(--text-secondary, #a0a0b0)", padding: "2px 8px" }}>
                  +{cycles.cycleCount - 8} more cycles
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {coupling.hubFiles.length > 0 && (
        <div style={{ marginTop: "4px" }}>
          <div style={{ fontSize: "10px", color: "var(--text-secondary, #a0a0b0)", marginBottom: "3px", fontWeight: 600 }}>
            Hub Files
          </div>
          {coupling.hubFiles.slice(0, 5).map((fp) => {
            const metrics = coupling.files.find((f) => f.filePath === fp);
            const displayPath = fp.replace(/\\/g, "/").split("/").slice(-3).join("/");
            return (
              <div key={fp} style={{
                ...ROW, fontSize: "10px",
                borderLeft: "2px solid #f87171",
              }}>
                <span style={{ flex: 1 }}>{displayPath}</span>
                <span style={{ color: "#60a5fa", fontSize: "9px" }}>
                  ↑{metrics?.fanIn ?? 0} ↓{metrics?.fanOut ?? 0}
                </span>
                <span style={{ color: "#f87171", fontSize: "9px", marginLeft: "4px" }}>
                  {metrics?.couplingScore ?? 0}
                </span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function GraphStatCard({
  label, value, sub, color,
}: {
  label: string; value: string; sub: string; color: string;
}) {
  return (
    <div style={{
      padding: "6px 8px",
      background: "var(--bg-input, #1a1a2e)",
      borderRadius: "4px", textAlign: "center",
    }}>
      <div style={{ fontSize: "16px", fontWeight: 700, color }}>{value}</div>
      <div style={{ fontSize: "9px", color: "var(--text-secondary, #a0a0b0)" }}>{label}</div>
      <div style={{ fontSize: "8px", color, marginTop: "1px" }}>{sub}</div>
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

// ── AST Status Badge ──────────────────────────────────────────────────────────

function ASTStatusBadge({
  status,
  onClick,
}: {
  status: ASTAnalysisStatus | null;
  onClick: () => void;
}) {
  if (!status) {
    return (
      <span style={{ fontSize: "9px", color: "var(--text-secondary, #a0a0b0)" }}>
        AST not checked
      </span>
    );
  }

  const presentation = {
    active: { label: "AST Active", color: "#34d399" },
    partial: { label: "AST Partial", color: "#fbbf24" },
    fallback: { label: "Regex Fallback", color: "#f87171" },
    "not-applicable": { label: "AST N/A", color: "#a0a0b0" },
  }[status.mode];

  const title = [
    `${status.astFiles}/${status.supportedFiles} supported files parsed with Tree-sitter`,
    `${status.fallbackFiles} regex fallback`,
    `${status.unsupportedFiles} unsupported language files`,
    `Execution: ${status.execution}`,
    status.lastError ? `Last error: ${status.lastError}` : "",
  ].filter(Boolean).join("\n");

  return (
    <button type="button" title={title} onClick={onClick} style={{
      fontSize: "9px", padding: "1px 6px",
      borderRadius: "3px", fontWeight: 600,
      background: `${presentation.color}22`,
      color: presentation.color,
      border: `1px solid ${presentation.color}44`,
      cursor: "pointer",
      fontFamily: "inherit",
    }}>
      {presentation.label}
    </button>
  );
}

function ASTDetailsPanel({
  status,
  discovery,
  scanDurationMs,
  onClose,
}: {
  status: ASTAnalysisStatus;
  discovery: DiscoveryMetrics | null;
  scanDurationMs: number | null;
  onClose: () => void;
}) {
  const coverage = status.supportedFiles > 0
    ? Math.round((status.astFiles / status.supportedFiles) * 100)
    : 0;
  const healthy = status.mode === "active" && status.parserFailures === 0;
  const confidence =
    coverage >= 95 && status.parserFailures === 0 ? "High"
    : coverage >= 75 ? "Medium"
    : "Low";
  const confidenceColor =
    confidence === "High" ? "#34d399"
    : confidence === "Medium" ? "#fbbf24"
    : "#f87171";
  const coverageColor =
    coverage === 100 ? "#34d399"
    : coverage >= 90 ? "#fbbf24"
    : "#f87171";
  const languageLabels: Record<string, string> = {
    typescript: "TypeScript",
    tsx: "TSX",
    javascript: "JavaScript",
    jsx: "JSX",
  };

  return (
    <div style={{
      margin: "10px 16px 0",
      padding: "12px",
      borderRadius: "8px",
      border: "1px solid var(--border-color, #2a2a4a)",
      background: "var(--bg-input, #1a1a2e)",
      fontSize: "10px",
    }}>
      <div style={{ display: "flex", alignItems: "center", marginBottom: "10px" }}>
        <strong style={{ fontSize: "12px" }}>Analysis Engine</strong>
        <button type="button" onClick={onClose} style={{
          marginLeft: "auto", border: "none", background: "transparent",
          color: "var(--text-secondary, #a0a0b0)", cursor: "pointer", fontFamily: "inherit",
        }}>
          Close
        </button>
      </div>
      <div style={{ display: "grid", gap: "5px", color: "var(--text-secondary, #a0a0b0)" }}>
        <span style={{ color: healthy ? "#34d399" : "#fbbf24", fontWeight: 600 }}>
          Parser Health: {healthy ? "Healthy" : "Degraded"}
        </span>
        <span style={{ color: confidenceColor, fontWeight: 600 }}>
          Analysis Confidence: {confidence}
        </span>
        <span>✓ Tree-sitter {status.mode === "fallback" ? "Unavailable" : "Active"}</span>
        <span>✓ {status.execution === "worker" ? "Worker Running" : "Main-thread fallback"}</span>
        <span style={{ color: coverageColor }}>
          ✓ Coverage: {coverage}% ({status.astFiles}/{status.supportedFiles})
        </span>
        {scanDurationMs !== null && (
          <span>Scan Time: {(scanDurationMs / 1000).toFixed(2)}s</span>
        )}
        <span>{status.fallbackFiles === 0 ? "✓" : "!"} {status.fallbackFiles} fallback files</span>
        <span>{status.parserFailures === 0 ? "✓" : "!"} {status.parserFailures} parser failures</span>
        <span>{status.unsupportedFiles} unsupported source files</span>
        {discovery && <span>{discovery.skipped} skipped files · {discovery.failed} unreadable/failed files</span>}
      </div>
      <div style={{ marginTop: "10px", color: "var(--text-secondary, #a0a0b0)" }}>
        <strong style={{ color: "var(--text-primary, #fff)" }}>Languages:</strong>{" "}
        {status.loadedLanguages.length > 0
          ? status.loadedLanguages.map((language) => languageLabels[language] ?? language).join(", ")
          : "None loaded"}
      </div>
      {status.lastError && (
        <div style={{ marginTop: "8px", color: "#f87171", wordBreak: "break-word" }}>
          Last parser error: {status.lastError}
        </div>
      )}
      {status.fallbackFilePaths.length > 0 && (
        <div style={{ marginTop: "10px" }}>
          <strong style={{ color: "#fbbf24" }}>
            Fallback Files ({status.fallbackFilePaths.length})
          </strong>
          <div style={{
            marginTop: "5px", display: "grid", gap: "3px",
            color: "var(--text-secondary, #a0a0b0)",
            maxHeight: "120px", overflowY: "auto",
          }}>
            {status.fallbackFilePaths.map((filePath) => (
              <span key={filePath} title={filePath}>
                {filePath.replace(/\\/g, "/").split("/").slice(-3).join("/")}
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
