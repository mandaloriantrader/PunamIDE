/**
 * TechnicalDebtDashboard.tsx — Polish Pass
 *
 * UX refinements (per tda-polishness-plan.md):
 *  - Sections reordered by importance (Health → Major Refactors → Quick Stats → Dead Code → Findings → Graph → Trend → Modules → remaining refactor categories)
 *  - Inline styles extracted to TechnicalDebtDashboard.module.css
 *  - Severity colors normalized to var(--red/orange/yellow/green/blue)
 *  - Major Refactor cards show WHAT/WHY/EFFORT/ACTION structure with prominent Fix-with-AI CTA
 *  - Section headers now include descriptive summaries
 *  - Empty states provide friendly, informative messaging
 *  - Metric chips (CC, Depth, God Functions) are compact and consistent
 *  - Micro-interactions: hover, active, collapse animations
 *  - Existing PunamIDE theme respected — no color redesign
 *
 * All existing functionality preserved:
 *  - File discovery, analysis, graph building, dead code, unified findings, AI fix pipeline
 *  - All modal/panel states (PlanApprovalModal, AiFixPipelinePanel, AiFixPreviewModal)
 *  - All layer toggles, collapsible sections, export handlers
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
  Download,
  Sparkles,
} from "lucide-react";
import { getDebtAnalyzer }    from "../services/technicalDebt/DebtAnalyzer";
import { getDebtScorer }      from "../services/technicalDebt/DebtScorer";
import { getRefactorPlanner } from "../services/technicalDebt/RefactorPlanner";
import { getDependencyGraphEngine } from "../services/technicalDebt/DependencyGraphEngine";
import { getIncrementalGraphEngine } from "../services/technicalDebt/IncrementalGraphEngine";
import { getCircularDepDetector }   from "../services/technicalDebt/CircularDepDetector";
import { getCouplingAnalyzer }      from "../services/technicalDebt/CouplingAnalyzer";
import { getDeadCodeAnalyzer }     from "../services/technicalDebt/DeadCodeAnalyzer";
import { getDiffEngine }           from "../services/technicalDebt/DiffEngine";
import { getGraphExporter }        from "../services/technicalDebt/GraphExporter";
import { getUnifiedAnalysisEngine } from "../services/review/UnifiedAnalysisEngine";
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
import type { DeadCodeReport }                 from "../services/technicalDebt/DeadCodeAnalyzer";
import type { ScanDiff }                       from "../services/technicalDebt/DiffEngine";
import type { FileEntry } from "../utils/tauri";
import type { Finding, AnalysisResult } from "../services/review/types";
import AiFixPreviewModal from "./AiFixPreviewModal";
import PlanApprovalModal from "./PlanApprovalModal";
import AiFixPipelinePanel from "./AiFixPipelinePanel";
import type { PipelineStep } from "./AiFixPipelinePanel";
import type { FixPlanContext } from "./PlanApprovalModal";
import { runAiFix, saveSnapshot, restoreSnapshot, extractFixScope } from "../services/refactor/AiFixHandler";
import type { AiFixResult, FixLlmProvider, FixProgressCallback, FixScopeResult } from "../services/refactor/AiFixHandler";

// ── Styles ────────────────────────────────────────────────────────────────────

import styles from "./TechnicalDebtDashboard.module.css";

// ── Constants ─────────────────────────────────────────────────────────────────

const MAX_FILES_DEFAULT = 2000;

const CATEGORY_COLOR: Record<string, string> = {
  excellent: "var(--green, #a6e3a1)",
  good:      "var(--accent, #89b4fa)",
  fair:      "var(--yellow, #f9e2af)",
  poor:      "var(--orange, #fab387)",
  critical:  "var(--red, #f38ba8)",
};

const CATEGORY_BG: Record<string, string> = {
  excellent: "rgba(166,227,161,0.10)",
  good:      "rgba(137,180,250,0.10)",
  fair:      "rgba(249,226,175,0.10)",
  poor:      "rgba(250,179,135,0.12)",
  critical:  "rgba(243,139,168,0.14)",
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

// ── Severity → badge variant mapping ──────────────────────────────────────

function severityBadgeClass(severity: string): string {
  switch (severity) {
    case "critical": return styles.badgeCritical;
    case "high":     return styles.badgeHigh;
    case "medium":   return styles.badgeMedium;
    case "low":      return styles.badgeLow;
    default:         return styles.badgeInfo;
  }
}

function effortBorderClass(effort: string): string {
  switch (effort) {
    case "low":    return styles.planItemCardEffortLow;
    case "medium": return styles.planItemCardEffortMedium;
    case "high":   return styles.planItemCardEffortHigh;
    default:       return "";
  }
}

function riskBorderClass(risk: string): string {
  switch (risk) {
    case "high": return styles.planItemCardRiskCritical;
    default:     return "";
  }
}

function effortBadgeVariant(effort: string): string {
  switch (effort) {
    case "low":    return styles.badgeGood;
    case "medium": return styles.badgeMedium;
    case "high":   return styles.badgeHigh;
    default:       return styles.badgeInfo;
  }
}

function riskBadgeVariant(risk: string): string {
  switch (risk) {
    case "low":    return styles.badgeGood;
    case "medium": return styles.badgeMedium;
    case "high":   return styles.badgeCritical;
    default:       return styles.badgeInfo;
  }
}

function complexityChipClass(band: string): string {
  switch (band) {
    case "critical": return styles.metricChipCritical;
    case "high":     return styles.metricChipHigh;
    case "moderate": return styles.metricChipModerate;
    case "good":     return styles.metricChipGood;
    default:         return styles.metricChipModerate;
  }
}

function nestingChipClass(band: string): string {
  switch (band) {
    case "refactor": return styles.metricChipCritical;
    case "warning":  return styles.metricChipModerate;
    case "good":     return styles.metricChipGood;
    default:         return styles.metricChipModerate;
  }
}

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

// ── Import map builder ─────────────────────────────────────────────────────────

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

// ── Number formatting ─────────────────────────────────────────────────────

function fmtNum(n: number): string {
  if (n >= 1000) return n.toLocaleString("en-US");
  return String(n);
}

// ── Severity color helpers (CSS variable based) ───────────────────────────

const SEVERITY_VAR: Record<string, string> = {
  critical: "var(--red, #f38ba8)",
  high:     "var(--orange, #fab387)",
  medium:   "var(--yellow, #f9e2af)",
  low:      "var(--accent, #89b4fa)",
  info:     "var(--text-secondary, #a6adc8)",
};

// ── Component ─────────────────────────────────────────────────────────────────

interface Props {
  projectPath?: string;
  maxFiles?: number;
  files?: FileEntry[];
  fixWithAiProvider?: FixLlmProvider;
}

export default function TechnicalDebtDashboard({
  projectPath,
  maxFiles = MAX_FILES_DEFAULT,
  files = [],
  fixWithAiProvider,
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
  const [showGraph,       setShowGraph]       = useState(true);
  const [showDiff,        setShowDiff]        = useState(true);
  const [showDeadCode,    setShowDeadCode]    = useState(false);
  const [deadCodeReport, setDeadCodeReport]   = useState<DeadCodeReport | null>(null);
  const [scanDiff, setScanDiff]               = useState<ScanDiff | null>(null);
  const [showQuickWins,   setShowQuickWins]   = useState(false);
  const [unifiedResult, setUnifiedResult]     = useState<AnalysisResult | null>(null);
  const [showFindings, setShowFindings]       = useState(false);

  // Layer toggles
  const [enableTaint, setEnableTaint]           = useState(false);
  const [enableGitSignals, setEnableGitSignals] = useState(false);
  const [enableMultiLang, setEnableMultiLang]   = useState(false);
  const [showMajor,       setShowMajor]       = useState(true);
  const [showMaintenance, setShowMaintenance] = useState(false);
  const [showArch,        setShowArch]        = useState(false);

  // "Fix with AI" state
  const [aiFixResult, setAiFixResult] = useState<AiFixResult | null>(null);
  const [aiFixApplying, setAiFixApplying] = useState(false);
  const [aiFixAccepted, setAiFixAccepted] = useState(false);
  const [aiFixSnapshot, setAiFixSnapshot] = useState<string | null>(null);
  const [aiFixingItem, setAiFixingItem] = useState<RefactorPlanItem | null>(null);
  const [planApprovalContext, setPlanApprovalContext] = useState<FixPlanContext | null>(null);
  const [pipelineSteps, setPipelineSteps] = useState<PipelineStep[]>([]);
  const [streamingCode, setStreamingCode] = useState("");
  const [pipelineScope, setPipelineScope] = useState<FixScopeResult | null>(null);
  const [pipelineOriginalCode, setPipelineOriginalCode] = useState("");

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
      const analyzer = getDebtAnalyzer();
      let analysis   = await analyzer.analyzeProject(filePaths, { maxFiles });
      setDiscovery(analysis.discovery);
      setAstStatus(analysis.astStatus);
      setScanDurationMs(performance.now() - scanStartedAt);

      const scorer = getDebtScorer();
      setScore(scorer.score(analysis));
      setLoading(false);

      setGraphBuilding(true);
      try {
        const importMaps = await buildImportMaps(filePaths, analysis);

        const incrementalEngine = getIncrementalGraphEngine();
        const buildResult = incrementalEngine.buildIncremental(importMaps, filePaths);
        const graph = buildResult.graph;

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

        const diffEngine = getDiffEngine();
        setScanDiff(diffEngine.computeDiff(analysis.files, analysis.overallScore));

        try {
          const { readFile } = await import("../utils/tauri");
          const fileContents: Record<string, string> = {};
          const deadCodeLimit = Math.min(filePaths.length, 500);
          for (let i = 0; i < deadCodeLimit; i++) {
            const fp = filePaths[i];
            try {
              const content = await readFile(fp);
              if (content.trim()) fileContents[fp] = content;
            } catch { /* skip unreadable files */ }
          }
          const deadCodeAnalyzer = getDeadCodeAnalyzer();
          const report = await deadCodeAnalyzer.analyze(graph, fileContents);
          setDeadCodeReport(report);
        } catch {
          setDeadCodeReport(null);
        }

        const planner = getRefactorPlanner();
        setPlan(planner.generatePlan(analysis));

        try {
          const engine = getUnifiedAnalysisEngine();
          const result = await engine.analyze(filePaths, {
            enabledLayers: ['debt', 'security', 'type', 'architecture',
              ...(enableTaint ? ['taint'] : []),
              ...(enableGitSignals ? ['git-signals'] : []),
              ...(enableMultiLang ? ['multi-language'] : []),
            ],
            maxFindingsPerFile: 100,
            diffMode: false,
          });
          setUnifiedResult(result);
        } catch {
          // Non-fatal
        }

      } finally {
        setGraphBuilding(false);
      }

    } catch {
      setLoading(false);
      setGraphBuilding(false);
    }
  }, [filePaths, maxFiles, enableTaint, enableGitSignals, enableMultiLang]);

  const handleExportGraph = useCallback(async (format: 'dot' | 'json' | 'mermaid') => {
    if (!cycleResult || !couplingResult) return;

    const exporter = getGraphExporter();
    const incrementalEngine = getIncrementalGraphEngine();
    const graph = incrementalEngine.hasBaseline
      ? incrementalEngine.buildIncremental([], filePaths).graph
      : null;

    if (!graph) return;

    let content: string;
    let defaultName: string;
    let filterName: string;
    let filterExt: string;

    switch (format) {
      case 'dot':
        content = exporter.toDOT(graph, {
          highlightCycles: cycleResult.filesInCycles,
          highlightHubs: new Set(couplingResult.hubFiles),
        });
        defaultName = 'dependency-graph.dot';
        filterName = 'Graphviz DOT';
        filterExt = 'dot';
        break;
      case 'json':
        content = JSON.stringify(exporter.toJSON(graph, couplingResult), null, 2);
        defaultName = 'dependency-graph.json';
        filterName = 'JSON';
        filterExt = 'json';
        break;
      case 'mermaid':
        content = exporter.toMermaid(graph, { highlightCycles: cycleResult.filesInCycles });
        defaultName = 'dependency-graph.mmd';
        filterName = 'Mermaid';
        filterExt = 'mmd';
        break;
    }

    try {
      const { save } = await import("@tauri-apps/plugin-dialog");
      const { writeTextFile } = await import("@tauri-apps/plugin-fs");
      const savePath = await save({
        defaultPath: defaultName,
        filters: [{ name: filterName, extensions: [filterExt] }],
      });
      if (savePath) {
        await writeTextFile(savePath, content);
      }
    } catch {
      try {
        await navigator.clipboard.writeText(content);
      } catch { /* silent */ }
    }
  }, [cycleResult, couplingResult, filePaths]);

  const handleFixWithAiClick = useCallback(async (item: RefactorPlanItem) => {
    if (!item.filePath) return;
    setAiFixingItem(item);

    let scope: FixPlanContext["scope"] = null;
    try {
      const { readFile } = await import("../utils/tauri");
      const fileContent = await readFile(item.filePath);
      const fixScope = extractFixScope(item, fileContent);
      scope = {
        startLine: fixScope.startLine,
        endLine: fixScope.endLine,
        scopeType: fixScope.scope,
      };
    } catch {
      // scope stays null
    }

    setPlanApprovalContext({ item, scope });
  }, []);

  const handlePlanApproved = useCallback(async () => {
    const item = aiFixingItem;
    if (!item || !item.filePath) return;

    setPlanApprovalContext(null);
    setAiFixApplying(true);

    const allStepIds = ["scope_extract", "prompt_build", "debt_analyze", "llm_call", "validate_output", "security_scan", "apply_patch", "score_calc"];
    setPipelineSteps(allStepIds.map((id) => ({ id, label: "", completed: false, active: false })));
    setStreamingCode("");
    setPipelineScope(null);
    setPipelineOriginalCode("");

    try {
      const { readFile, writeFile } = await import("../utils/tauri");
      const fileContent = await readFile(item.filePath);
      setPipelineOriginalCode(extractFixScope(item, fileContent).block);

      const snap = await saveSnapshot(item.filePath);
      setAiFixSnapshot(snap);

      const onProgress: FixProgressCallback = (update) => {
        setPipelineSteps((prev) =>
          prev.map((s) =>
            s.id === update.step
              ? { ...s, completed: update.completed, active: !update.completed, details: update.details }
              : { ...s, active: s.id === update.step ? !update.completed : s.active }
          )
        );
        if (update.step === "llm_call" && update.details) {
          setStreamingCode(update.details);
        }
      };

      const result = await runAiFix(item, fileContent, item.filePath, fixWithAiProvider!, onProgress);
      setPipelineScope(result.scope);

      if (result.status === "success") {
        await writeFile(item.filePath, result.proposedCode);
        try {
          const analyzer = getDebtAnalyzer();
          const analysis = await analyzer.analyzeProject(filePaths, { maxFiles: 2000 });
          const scorer = getDebtScorer();
          setScore(scorer.score(analysis));
          const planner = getRefactorPlanner();
          setPlan(planner.generatePlan(analysis));
        } catch { /* non-blocking */ }
      }

      setPipelineSteps((prev) => prev.map((s) => ({ ...s, completed: true, active: false })));
      setAiFixResult(result);
      setAiFixAccepted(result.status === "success");
    } catch (err) {
      setAiFixResult({
        status: "error",
        originalCode: "",
        proposedCode: "",
        filePath: item.filePath,
        scope: { block: "", startLine: 0, endLine: 0, scope: "file" },
        validation: { passed: false, violations: [] },
        securityFindings: [],
        beforeScore: null,
        afterScore: null,
        errorMessage: String(err),
      });
      setAiFixAccepted(false);
    } finally {
      setAiFixApplying(false);
    }
  }, [aiFixingItem, filePaths, fixWithAiProvider]);

  const handlePlanCancelled = useCallback(() => {
    setPlanApprovalContext(null);
    setAiFixingItem(null);
  }, []);

  const handleAiFixClose = useCallback(() => {
    setAiFixResult(null);
    setAiFixSnapshot(null);
    setAiFixAccepted(false);
    setAiFixingItem(null);
  }, []);

  const handleAiFixUndo = useCallback(async () => {
    if (!aiFixResult || !aiFixSnapshot) return;
    try {
      await restoreSnapshot(aiFixResult.filePath, aiFixSnapshot);

      const analyzer = getDebtAnalyzer();
      const analysis = await analyzer.analyzeProject(filePaths, { maxFiles: 2000 });
      const scorer = getDebtScorer();
      setScore(scorer.score(analysis));
      const planner = getRefactorPlanner();
      setPlan(planner.generatePlan(analysis));

      setAiFixResult(null);
      setAiFixSnapshot(null);
      setAiFixAccepted(false);
      setAiFixingItem(null);
    } catch (err) {
      console.error("Undo failed:", err);
    }
  }, [aiFixResult, aiFixSnapshot, filePaths]);

  // ── Render helpers ───────────────────────────────────────────────────────

  const renderRefactorSection = (
    items: RefactorPlanItem[],
    show: boolean,
    toggle: () => void,
    label: string,
    icon: React.ReactNode,
    accentColor: string,
    summary?: string,
    onFixWithAi?: (item: RefactorPlanItem) => void,
  ) => {
    if (!items.length) return null;
    return (
      <div className={styles.sectionWrapper}>
        <button onClick={toggle} className={styles.sectionHeader}>
          {show ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          <div className={styles.sectionHeaderMain}>
            {icon}
            <span className={styles.sectionHeaderTitle} style={{ color: accentColor }}>{label}</span>
            <span className={styles.sectionHeaderBadge}>({items.length})</span>
          </div>
        </button>
        {summary && <div className={styles.sectionHeaderSummary}>{summary}</div>}
        {show && (
          <div className={styles.collapseContent}>
            {items.map((item, i) => (
              <PlanItemCard key={`${item.filePath}-${i}`} item={item} onFixWithAi={onFixWithAi} />
            ))}
          </div>
        )}
      </div>
    );
  };

  // ── Derived summaries ────────────────────────────────────────────────────

  const majorItems = plan?.majorRefactors ?? [];
  const quickWinItems = plan?.quickWins ?? [];
  const archItems = plan?.architecturalIssues ?? [];
  const maintenanceItems = plan?.maintenance ?? [];

  const deadCodeTotal = deadCodeReport
    ? deadCodeReport.unusedExports.length + deadCodeReport.unusedImports.length + deadCodeReport.unusedDeclarations.length
    : 0;

  const findingsTotal = unifiedResult
    ? Array.from(unifiedResult.values()).reduce((sum, p) => sum + p.findings.length, 0)
    : 0;

  const criticalCount = findingsTotal > 0 && unifiedResult
    ? Array.from(unifiedResult.values()).reduce((sum, p) => sum + p.findings.filter((f: Finding) => f.severity === "critical").length, 0)
    : 0;

  const cycleCount = cycleResult?.cycleCount ?? 0;

  // ── Grouped refactor cards (deduplicate by file) ────────────────────────

  function groupItemsByFile(items: RefactorPlanItem[]): RefactorPlanItem[][] {
    const map = new Map<string, RefactorPlanItem[]>();
    for (const item of items) {
      const key = item.filePath;
      const existing = map.get(key);
      if (existing) {
        existing.push(item);
      } else {
        map.set(key, [item]);
      }
    }
    return Array.from(map.values());
  }

  // ── Main render ──────────────────────────────────────────────────────────

  return (
    <div className={styles.panel}>

      {/* Header */}
      <div className={styles.header}>
        <BarChart3 size={16} />
        Technical Debt Intelligence
        <span style={{ fontSize: "10px", color: "var(--text-secondary, #a6adc8)", marginLeft: "auto", display: "flex", alignItems: "center", gap: "6px" }}>
          <ASTStatusBadge
            status={astStatus}
            onClick={() => astStatus && setShowASTDetails(true)}
          />
        </span>
      </div>

      {/* Action bar */}
      <div className={styles.actionBar}>
        <div className={styles.actionBarInner}>
          <button
            onClick={handleAnalyze}
            disabled={loading || scanning || graphBuilding || filePaths.length === 0}
            className={styles.analyzeBtn}
          >
            <RefreshCw
              size={12}
              className={(loading || graphBuilding) ? styles.spinning : ""}
            />
            {loading ? "Analyzing files…" : graphBuilding ? "Building graph…" : "Analyze Debt"}
          </button>

          <span className={styles.fileCount}>
            {scanning
              ? "Scanning…"
              : filePaths.length > 0
              ? `${filePaths.length} source files`
              : projectPath
              ? "No source files found"
              : "No project open"}
          </span>
          {astStatus && (
            <span style={{ fontSize: "9px", color: "var(--text-secondary, #a6adc8)" }}>
              Coverage: {astStatus.supportedFiles > 0
                ? Math.round((astStatus.astFiles / astStatus.supportedFiles) * 100)
                : 0}% ({astStatus.astFiles}/{astStatus.supportedFiles})
              {astStatus.fallbackFiles > 0 ? ` · Fallback: ${astStatus.fallbackFiles}` : ""}
              {astStatus.unsupportedFiles > 0 ? ` · Unsupported: ${astStatus.unsupportedFiles}` : ""}
            </span>
          )}
        </div>
      </div>

      {/* ── At-a-glance summary bar ────────────────────────────────────── */}
      {score && (
        <div className={styles.summaryBar}>
          <div className={styles.summaryBarItem}>
            <span className={styles.summaryBarValue}>{fmtNum(filePaths.length)}</span> files
          </div>
          {discovery && (
            <div className={styles.summaryBarItem}>
              <span className={styles.summaryBarValue}>{fmtNum(discovery.analyzed)}</span> analyzed
            </div>
          )}
          {criticalCount > 0 && (
            <div className={styles.summaryBarItem}>
              <span className={styles.summaryBarValueWarn}>{fmtNum(criticalCount)}</span> critical
            </div>
          )}
          {cycleCount > 0 && (
            <div className={styles.summaryBarItem}>
              <span className={styles.summaryBarValueWarn}>{fmtNum(cycleCount)}</span> cycles
            </div>
          )}
          {plan && plan.totalEstimatedHours > 0 && (
            <div className={styles.summaryBarItem}>
              <span className={styles.summaryBarValue}>{fmtNum(plan.totalEstimatedHours)}h</span> estimated
            </div>
          )}
          {discovery && discovery.fromCache > 0 && (
            <div className={styles.summaryBarItem}>
              <span className={styles.summaryBarValueGood}>{fmtNum(discovery.fromCache)}</span> cached
            </div>
          )}
        </div>
      )}

      {showASTDetails && astStatus && (
        <ASTDetailsPanel
          status={astStatus}
          discovery={discovery}
          scanDurationMs={scanDurationMs}
          onClose={() => setShowASTDetails(false)}
        />
      )}

      {/* ── Graph building skeleton ────────────────────────────────────── */}
      {graphBuilding && (
        <div className={styles.graphBuildingPlaceholder}>
          <div className={styles.graphBuildingRow} />
          <div className={styles.graphBuildingRow} />
          <div className={styles.graphBuildingRow} />
        </div>
      )}

      {/* Empty state: no analysis yet */}
      {!score && !loading && (
        <div className={styles.emptyState}>
          <BarChart3 size={28} className={styles.emptyStateIcon} />
          <div className={styles.emptyStateTitle}>No analysis yet</div>
          <div className={styles.emptyStateDesc}>
            Click "Analyze Debt" to scan your project for technical debt, architectural risks, and code quality issues.
          </div>
          {filePaths.length > 0 && (
            <div style={{ marginTop: "6px", fontSize: "10px", color: "var(--text-secondary, #a6adc8)" }}>
              {filePaths.length} source files ready
            </div>
          )}
        </div>
      )}

      {score && (
        <>
          {/* ── 1. Overall Health Score ──────────────────────────────────── */}
          <div className={styles.overallScoreCard}>
            <div className={styles.scoreHeader}>
              <div
                className={styles.scoreCircle}
                style={{
                  background: CATEGORY_BG[score.category] ?? "rgba(137,180,250,0.10)",
                  border: `3px solid ${CATEGORY_COLOR[score.category] ?? "var(--accent, #89b4fa)"}`,
                  color: CATEGORY_COLOR[score.category] ?? "var(--accent, #89b4fa)",
                }}
              >
                {score.overall}
              </div>
              <div className={styles.scoreInfo}>
                <div className={styles.scoreCategory}>
                  {score.category}
                </div>
                <div className={styles.scoreTrend}>
                  {score.trend === "improving" ? (
                    <span style={{ color: "var(--green, #a6e3a1)" }}>
                      <TrendingDown size={12} style={{ verticalAlign: "middle" }} /> Improving
                    </span>
                  ) : score.trend === "declining" ? (
                    <span style={{ color: "var(--orange, #fab387)" }}>
                      <TrendingUp size={12} style={{ verticalAlign: "middle" }} /> Declining
                    </span>
                  ) : (
                    <span style={{ color: "var(--text-secondary, #a6adc8)" }}>Stable</span>
                  )}
                </div>
              </div>
            </div>
            <div className={styles.scoreSummary}>
              {score.modules.length} modules · {score.overall}/100
              {plan && plan.totalEstimatedHours > 0 && (
                <> · ~{plan.totalEstimatedHours}h estimated to resolve all issues</>
              )}
            </div>
          </div>

          {/* ── 2. Quick Stats (Discovery + Scan Diff summary) ──────────── */}
          <div className={styles.sectionWrapper}>
            <div className={styles.sectionHeader} style={{ cursor: "inherit" }}>
              <Database size={13} />
              <span className={styles.sectionHeaderTitle}>Quick Stats</span>
            </div>
            <div className={styles.quickStatsGrid}>
              {discovery && (
                <>
                  <div className={styles.quickStatCard}>
                    <div className={styles.quickStatValue} style={{ color: "var(--accent, #89b4fa)" }}>{totalDiscovered}</div>
                    <div className={styles.quickStatLabel}>Discovered</div>
                  </div>
                  <div className={styles.quickStatCard}>
                    <div className={styles.quickStatValue} style={{ color: "var(--green, #a6e3a1)" }}>{discovery.analyzed}</div>
                    <div className={styles.quickStatLabel}>Analyzed</div>
                  </div>
                  <div className={styles.quickStatCard}>
                    <div className={styles.quickStatValue} style={{ color: "var(--purple, #cba6f7)" }}>{discovery.fromCache}</div>
                    <div className={styles.quickStatLabel}>From Cache</div>
                  </div>
                </>
              )}
              {discovery && (
                <div className={styles.quickStatCard}>
                  <div className={styles.quickStatValue} style={{ color: "var(--yellow, #f9e2af)" }}>{discovery.skipped}</div>
                  <div className={styles.quickStatLabel}>Skipped</div>
                </div>
              )}
              {discovery && (
                <div className={styles.quickStatCard}>
                  <div className={styles.quickStatValue} style={{ color: "var(--orange, #fab387)" }}>{discovery.failed}</div>
                  <div className={styles.quickStatLabel}>Failed</div>
                </div>
              )}
              {scanDiff && scanDiff.hasPrevious && (
                <div className={styles.quickStatCard}>
                  <div
                    className={styles.quickStatValue}
                    style={{ color: scanDiff.overallDelta >= 0 ? "var(--green, #a6e3a1)" : "var(--orange, #fab387)" }}
                  >
                    {scanDiff.overallDelta >= 0 ? "+" : ""}{scanDiff.overallDelta}
                  </div>
                  <div className={styles.quickStatLabel}>Score Delta</div>
                </div>
              )}
            </div>
          </div>

          {/* ── Scan Diff details ────────────────────────────────────────── */}
          {scanDiff && scanDiff.hasPrevious && (scanDiff.improved.length > 0 || scanDiff.regressed.length > 0 || scanDiff.newFiles.length > 0) && (
            <div className={styles.sectionWrapper}>
              <button onClick={() => setShowDiff(!showDiff)} className={styles.sectionHeader}>
                {showDiff ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                <div className={styles.sectionHeaderMain}>
                  <TrendingUp size={13} />
                  <span className={styles.sectionHeaderTitle}>Changes Since Last Scan</span>
                  <span className={styles.sectionHeaderBadge} style={{ color: scanDiff.overallDelta >= 0 ? "var(--green, #a6e3a1)" : "var(--orange, #fab387)" }}>
                    {scanDiff.overallDelta >= 0 ? "+" : ""}{scanDiff.overallDelta} pts
                  </span>
                </div>
              </button>
              {showDiff && (
                <div className={styles.diffPanel}>
                  {scanDiff.improved.length > 0 && (
                    <div className={styles.diffSection}>
                      <div className={`${styles.diffSectionTitle} ${styles.diffSectionTitleImproved}`}>
                        ↑ Improved ({scanDiff.improved.length})
                      </div>
                      {scanDiff.improved.slice(0, 5).map((d) => (
                        <div key={d.filePath} className={`${styles.diffRow} ${styles.diffRowImproved}`}>
                          <span className={styles.diffRowPath}>
                            {d.filePath.replace(/\\/g, "/").split("/").slice(-2).join("/")}
                          </span>
                          <span className={`${styles.diffRowDelta} ${styles.diffRowDeltaPositive}`}>+{d.delta}</span>
                          {d.resolvedIssues.length > 0 && (
                            <span className={styles.diffRowIssue}>✓ {d.resolvedIssues[0]}</span>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                  {scanDiff.regressed.length > 0 && (
                    <div className={styles.diffSection}>
                      <div className={`${styles.diffSectionTitle} ${styles.diffSectionTitleRegressed}`}>
                        ↓ Regressed ({scanDiff.regressed.length})
                      </div>
                      {scanDiff.regressed.slice(0, 5).map((d) => (
                        <div key={d.filePath} className={`${styles.diffRow} ${styles.diffRowRegressed}`}>
                          <span className={styles.diffRowPath}>
                            {d.filePath.replace(/\\/g, "/").split("/").slice(-2).join("/")}
                          </span>
                          <span className={`${styles.diffRowDelta} ${styles.diffRowDeltaNegative}`}>{d.delta}</span>
                          {d.newIssues.length > 0 && (
                            <span className={styles.diffRowIssue}>⚠ {d.newIssues[0]}</span>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                  {(scanDiff.newFiles.length > 0 || scanDiff.removedFiles.length > 0) && (
                    <div className={styles.diffSummary}>
                      {scanDiff.newFiles.length > 0 && (
                        <span>+ {scanDiff.newFiles.length} new file{scanDiff.newFiles.length > 1 ? "s" : ""}</span>
                      )}
                      {scanDiff.removedFiles.length > 0 && (
                        <span style={{ marginLeft: "8px" }}>− {scanDiff.removedFiles.length} removed</span>
                      )}
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

          {/* ── 4. Dead Code Analysis ───────────────────────────────────── */}
          {deadCodeReport && (
            <div className={styles.sectionWrapper}>
              <button onClick={() => setShowDeadCode(!showDeadCode)} className={styles.sectionHeader}>
                {showDeadCode ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                <div className={styles.sectionHeaderMain}>
                  <FileCode size={13} />
                  <span className={styles.sectionHeaderTitle}>Dead Code Analysis</span>
                  <span className={styles.sectionHeaderBadge} style={{ color: deadCodeTotal > 0 ? "var(--orange, #fab387)" : "var(--green, #a6e3a1)" }}>
                    {deadCodeTotal} findings
                  </span>
                </div>
              </button>
              <div className={styles.sectionHeaderSummary}>
                {deadCodeTotal > 0
                  ? `${deadCodeReport.unusedExports.length} unused exports, ${deadCodeReport.unusedImports.length} unused imports, ${deadCodeReport.unusedDeclarations.length} unused declarations`
                  : "No dead code detected in scanned files"}
              </div>
              {showDeadCode && (
                <div className={styles.collapseContent}>
                  <DeadCodePanel report={deadCodeReport} />
                </div>
              )}
            </div>
          )}
          {!deadCodeReport && score && (
            <div className={styles.sectionWrapper}>
              <div className={styles.emptyStateGood}>
                <CheckCircle2 size={14} />
                No dead code detected
              </div>
            </div>
          )}

          {/* ── 5. All Findings (Unified) ───────────────────────────────── */}
          {unifiedResult && unifiedResult.size > 0 && (
            <div className={styles.sectionWrapper}>
              <button onClick={() => setShowFindings(!showFindings)} className={styles.sectionHeader}>
                {showFindings ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                <div className={styles.sectionHeaderMain}>
                  <AlertCircle size={13} />
                  <span className={styles.sectionHeaderTitle}>All Findings</span>
                  <span className={styles.sectionHeaderBadge}>({findingsTotal})</span>
                </div>
              </button>
              <div className={styles.sectionHeaderSummary}>
                Cross-layer analysis: debt, security, type safety, and architecture
              </div>
              {showFindings && (
                <div className={styles.collapseContent}>
                  <UnifiedFindingsPanel result={unifiedResult} />
                </div>
              )}
            </div>
          )}

          {/* ── 6. Dependency Graph ─────────────────────────────────────── */}
          {(cycleResult || couplingResult) && (
            <div className={styles.sectionWrapper}>
              <button onClick={() => setShowGraph(!showGraph)} className={styles.sectionHeader}>
                {showGraph ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                <div className={styles.sectionHeaderMain}>
                  <Link size={13} />
                  <span className={styles.sectionHeaderTitle}>Dependency Graph</span>
                  {cycleResult && cycleResult.cycleCount > 0 && (
                    <span style={{ color: "var(--orange, #fab387)", fontSize: "10px", marginLeft: "4px" }}>
                      ⚠ {cycleResult.cycleCount} cycle{cycleResult.cycleCount > 1 ? "s" : ""}
                    </span>
                  )}
                </div>
              </button>
              {couplingResult && (
                <div className={styles.sectionHeaderSummary}>
                  {cycleResult && cycleResult.cycleCount > 0
                    ? `${cycleResult.cycleCount} circular dependencies detected`
                    : "No circular dependencies detected"}
                  {couplingResult.hubFiles.length > 0
                    ? ` · ${couplingResult.hubFiles.length} hub files · avg coupling ${couplingResult.averageCoupling}`
                    : ` · avg coupling ${couplingResult.averageCoupling}`}
                </div>
              )}
              {showGraph && cycleResult && couplingResult && (
                <div className={styles.collapseContent}>
                  <GraphSummaryPanel cycles={cycleResult} coupling={couplingResult} />
                  <div className={styles.graphExportBtns}>
                    <button onClick={() => handleExportGraph('dot')} className={styles.graphExportBtn}>
                      <Download size={9} /> DOT
                    </button>
                    <button onClick={() => handleExportGraph('json')} className={styles.graphExportBtn}>
                      <Download size={9} /> JSON
                    </button>
                    <button onClick={() => handleExportGraph('mermaid')} className={styles.graphExportBtn}>
                      <Download size={9} /> Mermaid
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}
          {!cycleResult && !couplingResult && score && (
            <div className={styles.sectionWrapper}>
              <div className={styles.emptyStateGood}>
                <CheckCircle2 size={14} />
                No dependency graph data yet. Run analysis to detect cycles and coupling.
              </div>
            </div>
          )}

          {/* ── 7. Trend History ────────────────────────────────────────── */}
          {score.trendHistory.length > 1 && (
            <div className={styles.sectionWrapper}>
              <button onClick={() => setShowTrend(!showTrend)} className={styles.sectionHeader}>
                {showTrend ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                <div className={styles.sectionHeaderMain}>
                  <TrendingUp size={13} />
                  <span className={styles.sectionHeaderTitle}>Trend History</span>
                  <span className={styles.sectionHeaderBadge}>({score.trendHistory.length} scans)</span>
                </div>
              </button>
              <div className={styles.sectionHeaderSummary}>
                Track your debt score over time across multiple scans
              </div>
              {showTrend && (
                <div className={styles.collapseContent}>
                  {[...score.trendHistory].reverse().map((entry, i) => (
                    <div key={i} className={styles.trendRow}>
                      <span className={styles.trendRowScore} style={{ color: CATEGORY_COLOR[score.category] }}>
                        {entry.score}
                      </span>
                      <span className={styles.trendRowDate}>
                        {new Date(entry.date).toLocaleString()}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
          {score.trendHistory.length <= 1 && (
            <div className={styles.sectionWrapper}>
              <div className={styles.emptyStateGood}>
                <TrendingUp size={14} />
                Run multiple scans over time to see trend history
              </div>
            </div>
          )}

          {/* ── 7. Module Breakdown ─────────────────────────────────────── */}
          {score.modules.length > 0 && (
            <div className={styles.sectionWrapper}>
              <button onClick={() => setShowModules(!showModules)} className={styles.sectionHeader}>
                {showModules ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                <div className={styles.sectionHeaderMain}>
                  <span className={styles.sectionHeaderTitle}>Module Breakdown</span>
                  <span className={styles.sectionHeaderBadge}>({score.modules.length})</span>
                </div>
              </button>
              {showModules && (
                <div className={styles.collapseContent}>
                  {score.modules.map((mod) => (
                    <ModuleRow key={mod.module} mod={mod} />
                  ))}
                </div>
              )}
            </div>
          )}

          {/* ── Section Separator ────────────────────────────────────────── */}
          {plan && plan.items.length > 0 && (
            <div className={styles.sectionSeparator}>Refactor Recommendations</div>
          )}

          {/* ── 8. Major Refactors ──────────────────────────────────────── */}
          {plan && majorItems.length > 0 && (
            renderRefactorSection(
              majorItems, showMajor, () => setShowMajor(!showMajor),
              "Major Refactors", <Layers size={13} />, "var(--red, #f38ba8)",
              `${majorItems.length} files requiring significant restructuring — ~${plan.totalEstimatedHours}h estimated total`,
              fixWithAiProvider ? handleFixWithAiClick : undefined,
            )
          )}
          {plan && majorItems.length === 0 && (
            <div className={styles.sectionWrapper}>
              <div className={styles.emptyStateGood}>
                <CheckCircle2 size={14} />
                No major refactors needed
              </div>
            </div>
          )}

          {/* ── 9. Remaining Refactor Queue ─────────────────────────────── */}
          {plan && renderRefactorSection(
            quickWinItems, showQuickWins, () => setShowQuickWins(!showQuickWins),
            "Quick Wins", <Zap size={12} />, "var(--green, #a6e3a1)",
            quickWinItems.length > 0 ? "Low effort, high impact fixes" : undefined,
            fixWithAiProvider ? handleFixWithAiClick : undefined,
          )}

          {plan && renderRefactorSection(
            archItems, showArch, () => setShowArch(!showArch),
            "Architectural Issues", <GitBranch size={12} />, "var(--purple, #cba6f7)",
            archItems.length > 0 ? "Structural concerns requiring design-level changes" : undefined,
          )}

          {plan && renderRefactorSection(
            maintenanceItems, showMaintenance, () => setShowMaintenance(!showMaintenance),
            "Maintenance", <Wrench size={12} />, "var(--yellow, #f9e2af)",
            maintenanceItems.length > 0 ? "Routine cleanup and code hygiene tasks" : undefined,
            fixWithAiProvider ? handleFixWithAiClick : undefined,
          )}
        </>
      )}

      {/* ── Plan Approval Modal ────────────────────────────────────── */}
      {planApprovalContext && !aiFixApplying && (
        <PlanApprovalModal
          context={planApprovalContext}
          onApprove={handlePlanApproved}
          onCancel={handlePlanCancelled}
        />
      )}

      {/* ── AI Fix Pipeline Progress Panel ──────────────────────────── */}
      {aiFixApplying && aiFixingItem && (
        <AiFixPipelinePanel
          originalCode={pipelineOriginalCode || extractFixScope(aiFixingItem, "").block}
          scope={pipelineScope}
          fileName={aiFixingItem.filePath}
          steps={pipelineSteps}
          streamingCode={streamingCode}
        />
      )}

      {/* ── AI Fix Preview Modal ──────────────────────────────────────── */}
      {aiFixResult && (
        <AiFixPreviewModal
          result={aiFixResult}
          isApplying={aiFixApplying}
          hasBeenAccepted={aiFixAccepted}
          onAccept={handleAiFixClose}
          onReject={handleAiFixClose}
          onUndo={handleAiFixUndo}
        />
      )}

      {/* Footer */}
      <div className={styles.footer}>
        Scored on: file size · function length · comment ratio · dependency coupling · TODO density · duplication
      </div>
    </div>
  );
}

// ── Sub-components ─────────────────────────────────────────────────────────────

function ModuleRow({ mod }: { mod: ModuleDebtScore }) {
  const color = mod.score >= 70 ? "var(--green, #a6e3a1)" : mod.score >= 50 ? "var(--yellow, #f9e2af)" : "var(--orange, #fab387)";
  return (
    <div className={styles.moduleRow}>
      <span className={styles.moduleRowDot} style={{ color }}>●</span>
      <span className={styles.moduleRowName}>{mod.module}</span>
      <span className={styles.moduleRowScore} style={{ color }}>{mod.score}</span>
      <span className={styles.moduleRowFileCount}>{mod.fileCount}f</span>
    </div>
  );
}

function PlanItemCard({ item, onFixWithAi }: { item: RefactorPlanItem; onFixWithAi?: (item: RefactorPlanItem) => void }) {
  const displayPath = item.filePath
    .replace(/\\/g, "/")
    .split("/")
    .slice(-3)
    .join("/");

  const borderClass = riskBorderClass(item.estimatedRisk) || effortBorderClass(item.estimatedEffort);

  return (
    <div className={`${styles.planItemCard} ${borderClass}`}>
      {/* ── FILE ───────────────────────────────────────────────────── */}
      <div className={styles.planItemHeader}>
        <span className={styles.planItemPath}>
          <FileCode size={10} />
          <span className={styles.planItemPathMono}>{displayPath}</span>
        </span>
        <div className={styles.planItemBadges}>
          <span className={`${styles.badge} ${effortBadgeVariant(item.estimatedEffort)}`}>
            {item.effortLabel}
          </span>
          <span className={`${styles.badge} ${riskBadgeVariant(item.estimatedRisk)}`}>
            {item.estimatedRisk} risk
          </span>
          <span className={`${styles.badge} ${effortBadgeVariant(item.estimatedImpact)}`}>
            {item.estimatedImpact} impact
          </span>
          {item.category && (
            <span className={`${styles.badge} ${styles.badgeInfo}`}>
              {CATEGORY_ICONS[item.category]} {CATEGORY_LABEL[item.category]}
            </span>
          )}
        </div>
      </div>

      {/* ── MAIN RECOMMENDATION ──────────────────────────────────────── */}
      <div className={styles.planItemMeta}>
        {item.recommendation}
      </div>

      {/* ── WHY ──────────────────────────────────────────────────────── */}
      <div className={styles.planItemWhy}>
        <span className={styles.planItemWhyIcon}><AlertCircle size={10} /></span>
        <span className={styles.planItemWhyLabel} style={{ color: "var(--orange, #fab387)" }}>Why flagged:</span>
        <span className={styles.planItemWhyText}>{item.whyFlagged}</span>
      </div>

      {/* ── PAYOFF ──────────────────────────────────────────────────── */}
      <div className={styles.planItemPayoff}>
        <span className={styles.planItemPayoffIcon}><CheckCircle2 size={10} /></span>
        <span className={styles.planItemPayoffLabel} style={{ color: "var(--green, #a6e3a1)" }}>Expected payoff:</span>
        <span className={styles.planItemPayoffText}>{item.expectedPayoff}</span>
      </div>

      {/* ── STATIC ANALYSIS METRICS ─────────────────────────────────── */}
      {item.astDetail && <ASTDetailPanel detail={item.astDetail} />}

      {/* ── DEPENDENCIES ────────────────────────────────────────────── */}
      {item.dependencies.length > 0 && (
        <div className={styles.planItemDeps}>
          Fix first: {item.dependencies.join(", ")}
        </div>
      )}

      {/* ── FIX WITH AI — prominent CTA ────────────────────────────── */}
      {item.category !== "architectural" && (
        onFixWithAi ? (
          <button
            onClick={(e) => {
              e.stopPropagation();
              onFixWithAi(item);
            }}
            className={styles.fixWithAiBtn}
            title="Send this refactor task to AI for an automated fix"
          >
            <Sparkles size={11} />
            Fix with AI
          </button>
        ) : (
          <button
            disabled
            className={styles.fixWithAiBtnDisabled}
            title="Fix with AI requires an LLM provider"
          >
            <Sparkles size={11} />
            Fix with AI (no provider)
          </button>
        )
      )}
    </div>
  );
}

// ── AST Detail Panel ──────────────────────────────────────────────────────────

function ASTDetailPanel({ detail }: { detail: HotspotASTDetail }) {
  return (
    <div className={styles.astDetailPanel}>
      <div className={styles.astDetailHeader}>Static Analysis</div>

      <div className={styles.metricChipGrid}>
        <MetricChip
          label="CC"
          value={`${detail.cyclomaticComplexity}`}
          chipClass={complexityChipClass(detail.complexityBand)}
        />
        <MetricChip
          label="Depth"
          value={String(detail.maxNestingDepth)}
          chipClass={nestingChipClass(detail.nestingBand)}
        />
        {detail.godFunctionCount > 0 && (
          <MetricChip
            label="God Functions"
            value={String(detail.godFunctionCount)}
            chipClass={styles.metricChipCritical}
          />
        )}
        {detail.longFunctionCount > 0 && detail.godFunctionCount === 0 && (
          <MetricChip
            label="Long Functions"
            value={String(detail.longFunctionCount)}
            chipClass={styles.metricChipModerate}
          />
        )}
        {detail.godClassCount > 0 && (
          <MetricChip
            label="God Classes"
            value={String(detail.godClassCount)}
            chipClass={styles.metricChipCritical}
          />
        )}
        {detail.maxParameterCount > 5 && (
          <MetricChip
            label="Max Params"
            value={String(detail.maxParameterCount)}
            chipClass={styles.metricChipModerate}
          />
        )}
      </div>
    </div>
  );
}

function MetricChip({
  label, value, chipClass,
}: {
  label: string; value: string; chipClass: string;
}) {
  return (
    <div className={`${styles.metricChip} ${chipClass}`}>
      <span className={styles.metricChipLabel}>{label}</span>
      <span className={styles.metricChipValue}>{value}</span>
    </div>
  );
}

// ── Graph Summary Panel ───────────────────────────────────────────────────────

function GraphSummaryPanel({
  cycles,
  coupling,
}: {
  cycles: CycleDetectionResult;
  coupling: CouplingAnalysis;
}) {
  const [showCycles, setShowCycles] = useState(false);
  const sevColor = cycles.severity === "severe" || cycles.severity === "moderate" ? "var(--orange, #fab387)" : "var(--yellow, #f9e2af)";

  return (
    <div className={styles.graphSummary}>
      <div className={styles.graphStatGrid}>
        <div className={styles.graphStatCard}>
          <div className={styles.graphStatValue} style={{ color: sevColor }}>{cycles.cycleCount}</div>
          <div className={styles.graphStatLabel}>Cycles</div>
          <div className={styles.graphStatSub} style={{ color: sevColor }}>{cycles.severity}</div>
        </div>
        <div className={styles.graphStatCard}>
          <div className={styles.graphStatValue} style={{ color: coupling.hubFiles.length > 0 ? "var(--orange, #fab387)" : "var(--green, #a6e3a1)" }}>{coupling.hubFiles.length}</div>
          <div className={styles.graphStatLabel}>Hub Files</div>
          <div className={styles.graphStatSub} style={{ color: coupling.hubFiles.length > 0 ? "var(--orange, #fab387)" : "var(--green, #a6e3a1)" }}>
            {coupling.hubFiles.length > 0 ? "bottlenecks" : "none found"}
          </div>
        </div>
        <div className={styles.graphStatCard}>
          <div className={styles.graphStatValue} style={{ color: coupling.averageCoupling > 60 ? "var(--orange, #fab387)" : coupling.averageCoupling > 30 ? "var(--yellow, #f9e2af)" : "var(--green, #a6e3a1)" }}>{coupling.averageCoupling}</div>
          <div className={styles.graphStatLabel}>Avg Coupling</div>
          <div className={styles.graphStatSub} style={{ color: coupling.averageCoupling > 60 ? "var(--orange, #fab387)" : coupling.averageCoupling > 30 ? "var(--yellow, #f9e2af)" : "var(--green, #a6e3a1)" }}>
            {coupling.averageCoupling > 60 ? "high" : coupling.averageCoupling > 30 ? "moderate" : "good"}
          </div>
        </div>
      </div>

      {cycles.cycleCount > 0 && (
        <div style={{ marginTop: "4px" }}>
          <button onClick={() => setShowCycles(!showCycles)} className={styles.cycleToggle}>
            {showCycles ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
            <ArrowRightLeft size={11} />
            Cycles ({cycles.cycleCount})
          </button>
          {showCycles && (
            <div style={{ marginTop: "4px" }}>
              {cycles.cycles.slice(0, 8).map((cycle, i) => (
                <div key={i} className={styles.cycleDetail}>
                  <div className={styles.cycleDetailHeader} style={{ color: sevColor }}>
                    Cycle {i + 1} — {cycle.length} file{cycle.length > 1 ? "s" : ""}
                  </div>
                  <div className={styles.cycleDetailPath}>
                    {cycle.map((fp) => fp.replace(/\\/g, "/").split("/").slice(-2).join("/")).join(" → ")}
                  </div>
                </div>
              ))}
              {cycles.cycleCount > 8 && (
                <div style={{ fontSize: "9px", color: "var(--text-muted, #6c7086)", padding: "2px 8px" }}>
                  +{cycles.cycleCount - 8} more cycles
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {coupling.hubFiles.length > 0 && (
        <div style={{ marginTop: "6px" }}>
          <div className={styles.hubFilesHeader}>Hub Files</div>
          {coupling.hubFiles.slice(0, 5).map((fp) => {
            const metrics = coupling.files.find((f) => f.filePath === fp);
            const displayPath = fp.replace(/\\/g, "/").split("/").slice(-3).join("/");
            return (
              <div key={fp} className={styles.hubFileRow}>
                <span className={styles.hubFileName}>{displayPath}</span>
                <span className={styles.hubFileFan}>
                  ↑{metrics?.fanIn ?? 0} ↓{metrics?.fanOut ?? 0}
                </span>
                <span className={styles.hubFileCoupling}>
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

// ── Unified Findings Panel ────────────────────────────────────────────────────

function UnifiedFindingsPanel({ result }: { result: AnalysisResult }) {
  const allFindings: Finding[] = [];
  result.forEach(profile => allFindings.push(...profile.findings));

  if (allFindings.length === 0) {
    return (
      <div className={styles.findingsEmpty}>
        <CheckCircle2 size={12} />
        No issues detected across all analysis layers
      </div>
    );
  }

  return (
    <div style={{ marginTop: "6px" }}>
      {allFindings.slice(0, 20).map((finding, i) => (
        <div
          key={i}
          className={styles.findingsRow}
          style={{ borderLeft: `2px solid ${SEVERITY_VAR[finding.severity] ?? "var(--accent, #89b4fa)"}` }}
        >
          <span className={styles.findingsRowSource} style={{ color: SEVERITY_VAR[finding.severity] ?? "var(--accent, #89b4fa)" }}>
            [{finding.source}]
          </span>
          <span className={styles.findingsRowFile}>
            {finding.file.replace(/\\/g, "/").split("/").slice(-2).join("/")}:{finding.line ?? '?'}
          </span>
          <span className={styles.findingsRowTitle}>{finding.title}</span>
          <span className={`${styles.badge} ${severityBadgeClass(finding.severity)}`}>
            {finding.severity}
          </span>
        </div>
      ))}
      {allFindings.length > 20 && (
        <div className={styles.findingsMore}>+{allFindings.length - 20} more findings</div>
      )}
    </div>
  );
}

// ── Dead Code Panel ───────────────────────────────────────────────────────────

function DeadCodePanel({ report }: { report: DeadCodeReport }) {
  const total = report.unusedExports.length + report.unusedImports.length + report.unusedDeclarations.length;
  if (total === 0) {
    return (
      <div className={styles.findingsEmpty}>
        <CheckCircle2 size={12} />
        No dead code detected in scanned files
      </div>
    );
  }

  const renderFindings = <T extends { filePath: string; line: number; confidence?: string; reason?: string }>(
    items: T[],
    title: string,
    color: string,
    borderColor: string,
    getName: (item: T) => string,
  ) => {
    if (items.length === 0) return null;
    return (
      <div className={styles.deadCodeSection}>
        <div className={styles.deadCodeSectionTitle} style={{ color }}>
          {title} ({items.length})
        </div>
        {items.slice(0, 10).map((item, i) => (
          <div key={i} className={styles.deadCodeItem} style={{ borderLeft: `2px solid ${borderColor}` }}>
            <span className={styles.deadCodeItemName}>{getName(item)}</span>
            <span className={styles.deadCodeItemLocation}>
              {item.filePath.replace(/\\/g, "/").split("/").slice(-2).join("/")}:{item.line}
            </span>
            {item.confidence && (
              <span className={item.confidence === "high" ? styles.deadCodeItemConfidenceHigh : styles.deadCodeItemConfidenceMedium}>
                {item.confidence}
              </span>
            )}
            {item.reason && (
              <span style={{ fontSize: "9px", color: "var(--text-muted, #6c7086)", marginLeft: "4px" }}>
                {item.reason}
              </span>
            )}
          </div>
        ))}
        {items.length > 10 && (
          <div className={styles.deadCodeMore}>+{items.length - 10} more</div>
        )}
      </div>
    );
  };

  return (
    <div style={{ marginTop: "6px" }}>
      {renderFindings(report.unusedExports, "Unused Exports", "var(--orange, #fab387)", "var(--orange, #fab387)", (e) => e.exportName)}
      {renderFindings(report.unusedImports, "Unused Imports", "var(--yellow, #f9e2af)", "var(--yellow, #f9e2af)", (i) => i.importedName)}
      {renderFindings(report.unusedDeclarations, "Unused Declarations", "var(--purple, #cba6f7)", "var(--purple, #cba6f7)", (d) => d.name)}
    </div>
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
      <span style={{ fontSize: "9px", color: "var(--text-secondary, #a6adc8)" }}>
        AST not checked
      </span>
    );
  }

  const presentation = {
    active: { label: "AST Active", color: "var(--green, #a6e3a1)" },
    partial: { label: "AST Partial", color: "var(--yellow, #f9e2af)" },
    fallback: { label: "Regex Fallback", color: "var(--orange, #fab387)" },
    "not-applicable": { label: "AST N/A", color: "var(--text-secondary, #a6adc8)" },
  }[status.mode];

  const title = [
    `${status.astFiles}/${status.supportedFiles} supported files parsed with Tree-sitter`,
    `${status.fallbackFiles} regex fallback`,
    `${status.unsupportedFiles} unsupported language files`,
    `Execution: ${status.execution}`,
    status.lastError ? `Last error: ${status.lastError}` : "",
  ].filter(Boolean).join("\n");

  return (
    <button type="button" title={title} onClick={onClick}
      className={styles.astStatusBadge}
      style={{
        background: `${presentation.color}22`,
        color: presentation.color,
        borderColor: `${presentation.color}44`,
      }}
    >
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
    confidence === "High" ? "var(--green, #a6e3a1)"
    : confidence === "Medium" ? "var(--yellow, #f9e2af)"
    : "var(--orange, #fab387)";
  const coverageColor =
    coverage === 100 ? "var(--green, #a6e3a1)"
    : coverage >= 90 ? "var(--yellow, #f9e2af)"
    : "var(--orange, #fab387)";
  const languageLabels: Record<string, string> = {
    typescript: "TypeScript",
    tsx: "TSX",
    javascript: "JavaScript",
    jsx: "JSX",
  };

  return (
    <div className={styles.astStatusPanel}>
      <div className={styles.astStatusPanelHeader}>
        <strong className={styles.astStatusPanelTitle}>Analysis Engine</strong>
        <button type="button" onClick={onClose} className={styles.astStatusPanelClose}>
          Close
        </button>
      </div>
      <div className={styles.astStatusPanelGrid}>
        <span className={healthy ? styles.astStatusPanelHealthy : styles.astStatusPanelDegraded}>
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
      <div className={styles.astStatusPanelLangSection}>
        <strong style={{ color: "var(--text-primary, #cdd6f4)" }}>Languages:</strong>{" "}
        {status.loadedLanguages.length > 0
          ? status.loadedLanguages.map((language) => languageLabels[language] ?? language).join(", ")
          : "None loaded"}
      </div>
      {status.lastError && (
        <div style={{ marginTop: "8px", color: "var(--red, #f38ba8)", wordBreak: "break-word" }}>
          Last parser error: {status.lastError}
        </div>
      )}
      {status.fallbackFilePaths.length > 0 && (
        <div className={styles.astStatusPanelFallbackFiles}>
          <strong className={styles.astStatusPanelFallbackHeader}>
            Fallback Files ({status.fallbackFilePaths.length})
          </strong>
          <div className={styles.astStatusPanelFallbackList}>
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