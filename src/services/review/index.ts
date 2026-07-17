/**
 * @phase P1-P8
 * @purpose Barrel export for the entire review module.
 *          Import from '../review' to access the Unified Analysis Engine.
 */

// Core types
export type {
  Finding,
  FileRiskProfile,
  AnalysisResult,
  AnalysisLayer,
  AnalysisContext,
  UnifiedAnalysisConfig,
  SemanticAnalysisConfig,
  ReviewAgentConfig,
  TaintConfig,
  ChurnData,
  CouplingData,
  FindingFilter,
  FindingSorter,
  Severity,
  Confidence,
  FindingSource,
  MergeStats,
  ReviewSummary,
  ChangedFile,
  DiffReviewResult,
  // Agent system types
  AgentQuery,
  AgentResponse,
  SharedContext,
} from './types';

export { SEVERITY_RANK, CONFIDENCE_RANK } from './types';

// Engine
export { UnifiedAnalysisEngine, getUnifiedAnalysisEngine } from './UnifiedAnalysisEngine';
export type { Logger } from './UnifiedAnalysisEngine';

// Finding utilities
export { mergeFindings, groupByFile, filterFindings } from './FindingMerger';

// Risk scoring
export { calculateCompositeRiskScore, computeAllRiskScores } from './RiskScoreCalculator';

// Adapters
export {
  adaptDebtMetrics,
  adaptAllDebtMetrics,
  adaptSecurityResults,
  adaptSecurityByFile,
  adaptArchitectureViolations,
  adaptArchitectureByFile,
} from './adapters';
export type { ArchitectureViolationResult } from './adapters';

// P2: Git signals
export { GitSignalsAnalyzer, getGitSignalsAnalyzer, initGitSignalsAnalyzer } from './GitSignalsAnalyzer';
export type { GitCommandInterface, GitLogOptions } from './GitSignalsAnalyzer';

// P2: Diff review
export { DiffReviewMode, getDiffReviewMode, initDiffReviewMode } from './DiffReviewMode';

// P2: Consistency checker
export { GitConsistencyChecker, getGitConsistencyChecker, initGitConsistencyChecker } from './GitConsistencyChecker';

// P3: Dynamic import resolver
export { DynamicImportResolver, getDynamicImportResolver, initDynamicImportResolver } from './DynamicImportResolver';

// P4: Semantic analysis
export { SemanticAnalyzer, getSemanticAnalyzer } from './SemanticAnalyzer';
export { SemanticRuleEngine, getSemanticRuleEngine } from './SemanticRuleEngine';
export type { SemanticRule } from './SemanticRuleEngine';

// P5: Taint tracking
export { TaintTracker, getTaintTracker } from './TaintTracker';
export { TAINT_SOURCES, TAINT_SINKS, TAINT_SANITIZERS } from './TaintRules';
export type { TaintSource, TaintSink } from './TaintRules';
export type { TaintFlow, TaintPathNode } from './TaintTracker';
export { TaintFlowVisualizer, getTaintFlowVisualizer } from './TaintFlowVisualizer';
export { TaintLayer, getTaintLayer } from './TaintLayer';

// P2: Git signals layer (AnalysisLayer wrapper)
export { GitSignalsLayer, getGitSignalsLayer } from './GitSignalsLayer';

// P6: Review agent
export { ReviewAgent, getReviewAgent, initReviewAgent } from './ReviewAgent';
export type { ReviewContext } from './ReviewContextAssembler';
export { ReviewContextAssembler, getReviewContextAssembler } from './ReviewContextAssembler';
export { ReviewFeedbackLoop, getReviewFeedbackLoop, initReviewFeedbackLoop } from './ReviewFeedbackLoop';
export type { FeedbackEntry, NoiseReport, RuleTuningSuggestion } from './ReviewFeedbackLoop';
export { ProviderRegistry, getProviderRegistry, ProviderType } from './LLMProviderInterface';
export type { LLMProvider, LLMRequest, LLMResponse } from './LLMProviderInterface';

// P6: Agent coordinator
export { AgentCoordinator, getAgentCoordinator, initAgentCoordinator, AGENT_PROMPTS } from '../agents/AgentCoordinator';
export type { AgentRole, AgentConfig, AgentResult, CoordinationResult } from '../agents/AgentCoordinator';

// P7: Multi-language
export { MultiLanguageManager, getMultiLanguageManager, SupportedLanguage } from './MultiLanguageManager';
export type { LanguageConfig, ComplexityThresholds } from './MultiLanguageManager';
export { LANGUAGE_THRESHOLDS } from './LanguageThresholds';

// P8: Benchmarking
export type { BenchmarkResult, PerLayerResult } from './BenchmarkRunner';
export { BenchmarkDataset as BenchmarkDatasetManager } from './BenchmarkDataset';
export type { BenchmarkDataset, BenchmarkPR, KnownBug, PRMetadata } from './BenchmarkDataset';
export { BenchmarkReporter, getBenchmarkReporter } from './BenchmarkReporter';

// Re-export TDA types from actual engine files (not from non-existent types/tda)
export type { DependencyGraph, GraphNode } from '../technicalDebt/DependencyGraphEngine';
export type { FileDebtMetrics, ASTMetrics, ProjectDebtAnalysis, GraphBundle, DebtHotspot } from '../technicalDebt/DebtAnalyzer';
export type { CycleDetectionResult } from '../technicalDebt/CircularDepDetector';
export type { CouplingAnalysis, FileCouplingMetrics } from '../technicalDebt/CouplingAnalyzer';