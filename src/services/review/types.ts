/**
 * @phase P1-P8
 * @purpose Core type definitions for the Unified Analysis Engine.
 *          Shared TDA types are imported from the actual engine files (single source of truth).
 *          This file defines review-specific types only.
 */

// ── Shared types imported from TDA (single source of truth) ─────────
import type {
  DependencyGraph,
  GraphNode,
} from '../technicalDebt/DependencyGraphEngine';
import type {
  FileDebtMetrics,
  ASTMetrics,
} from '../technicalDebt/DebtAnalyzer';

// Re-export shared types for convenience
export type { DependencyGraph, GraphNode, FileDebtMetrics, ASTMetrics };

// ── Severity & Confidence ──────────────────────────────────────────

export type Severity = 'critical' | 'high' | 'medium' | 'low' | 'info';
export type Confidence = 'direct' | 'traced' | 'heuristic' | 'unresolvable';
export type FindingSource = 'debt' | 'security' | 'type' | 'architecture' | 'review-agent';

/** Numeric severity ranking for sorting (higher = more severe). */
export const SEVERITY_RANK: Record<Severity, number> = {
  critical: 5, high: 4, medium: 3, low: 2, info: 1,
};

/** Numeric confidence ranking for sorting (higher = more certain). */
export const CONFIDENCE_RANK: Record<Confidence, number> = {
  direct: 4, traced: 3, heuristic: 2, unresolvable: 1,
};

// ── Core Finding ───────────────────────────────────────────────────

/**
 * The atomic unit of analysis output. Every layer — debt, security,
 * type, architecture, review-agent — produces Finding[] in this shape
 * so results merge into one panel, not five disconnected tabs.
 */
export interface Finding {
  id: string;
  file: string;
  line?: number;
  column?: number;
  source: FindingSource;
  severity: Severity;
  confidence: Confidence;
  title: string;
  description: string;
  whyFlagged: string;
  expectedPayoff?: string;
  fix?: string;
  cwe?: string;
}

// ── FileRiskProfile ────────────────────────────────────────────────

/**
 * The single source of truth per file. Combines debt score, all
 * findings, git churn, coupling, architecture layer, and a composite
 * risk score that drives the refactor queue ordering.
 */
export interface FileRiskProfile {
  file: string;
  debtScore: number;
  findings: Finding[];
  churn: ChurnData;
  coupling: CouplingData;
  architectureLayer: string | null;
  compositeRiskScore: number;
}

/** Git churn data joined onto each file. */
export interface ChurnData {
  commitsLast30d: number;
  lastModified: string;
}

/** Coupling metrics from the existing CouplingAnalyzer. */
export interface CouplingData {
  fanIn: number;
  fanOut: number;
  instability: number;
}

// ── Analysis Result ────────────────────────────────────────────────

/** Map of file paths to their FileRiskProfile. */
export type AnalysisResult = Map<string, FileRiskProfile>;

// ── Filtering & Sorting ────────────────────────────────────────────

/** Filter criteria for querying findings. */
export interface FindingFilter {
  sources?: FindingSource[];
  severities?: Severity[];
  confidences?: Confidence[];
  files?: string[];
  cwe?: string;
}

/** Sort order for findings. */
export type FindingSorter = (a: Finding, b: Finding) => number;

// ── Configuration ──────────────────────────────────────────────────

/** Configuration for the Unified Analysis Engine. */
export interface UnifiedAnalysisConfig {
  enabledLayers: string[];
  maxFindingsPerFile: number;
  diffMode: boolean;
  diffBase?: string;
  diffHead?: string;
  semantic?: SemanticAnalysisConfig;
  reviewAgent?: ReviewAgentConfig;
  taint?: TaintConfig;
}

/** Semantic analysis configuration (P4). */
export interface SemanticAnalysisConfig {
  enabledRules: string[];
  maxFindingsPerRulePerFile: number;
  severityThreshold: Severity;
}

/** Review agent configuration (P6). */
export interface ReviewAgentConfig {
  modelId: string;
  temperature: number;
  maxTokens: number;
  enabledRules: string[];
  customPromptAdditions?: string;
}

/** Taint tracking configuration (P5). */
export interface TaintConfig {
  maxHops: number;
  enabledSources: string[];
  enabledSinks: string[];
  failClosedOnUnresolvable: boolean;
}

// ── Analysis Layer Interface ───────────────────────────────────────

/** Context passed to each analysis layer. */
export interface AnalysisContext {
  files: string[];
  fileContents: Map<string, string>;
  graph?: DependencyGraph;
  config: UnifiedAnalysisConfig;
}

/**
 * Plugin interface for analysis layers. Each layer registers as a
 * plugin and the engine runs them in order, merging results.
 */
export interface AnalysisLayer {
  name: string;
  analyze(files: string[], context: AnalysisContext): Promise<Finding[]>;
  isEnabled(config: UnifiedAnalysisConfig): boolean;
}

// ── Rust Security Scanner Compatibility ────────────────────────────

/**
 * Rust SecurityFinding struct — serialized to JSON and received by
 * frontend via Tauri command. The TypeScript Finding must be
 * compatible with these Rust structs.
 */
export interface SecurityFindingRust {
  pattern_id: string;
  file_path: string;
  line: number;
  column: number;
  snippet: string;
  severity: string;
  owasp: string;
  description: string;
  suggestion: string;
  cwe: number | null;
}

/** Rust SecurityScanResult struct. */
export interface SecurityScanResultRust {
  file_path: string;
  findings: SecurityFindingRust[];
  critical_count: number;
  high_count: number;
  medium_count: number;
  low_count: number;
}

// ── Agent System Types ─────────────────────────────────────────────

/** Agent query — sent between agents via the coordinator bus. */
export interface AgentQuery {
  from: string;
  to: string;
  question: string;
  context: string;
}

/** Agent response — answer from a queried agent. */
export interface AgentResponse {
  to: string;
  from: string;
  answer: string;
  confidence: number;
  references: string[];
}

/** Shared context for multi-agent workflows. */
export interface SharedContext {
  taskDescription: string;
  affectedFiles: string[];
  architectureAdvice: string | null;
  securityConcerns: string[];
  currentPhase: string;
  completedPhases: string[];
}

// ── Utility Types ──────────────────────────────────────────────────

/** Result of merging findings from multiple sources. */
export interface MergeStats {
  totalInput: number;
  totalOutput: number;
  duplicatesRemoved: number;
  perSource: Record<string, number>;
}

/** Review summary for diff mode. */
export interface ReviewSummary {
  totalFiles: number;
  totalFindings: number;
  criticalCount: number;
  highCount: number;
  mediumCount: number;
  lowCount: number;
  infoCount: number;
  filesWithCritical: string[];
}

/** Changed file in a diff. */
export interface ChangedFile {
  path: string;
  status: 'added' | 'modified' | 'deleted' | 'renamed';
  addedLines: number;
  deletedLines: number;
  changedLineRanges: { start: number; end: number }[];
}

/** Diff review result. */
export interface DiffReviewResult {
  base: string;
  head: string;
  changedFiles: ChangedFile[];
  profiles: Map<string, FileRiskProfile>;
  summary: ReviewSummary;
}