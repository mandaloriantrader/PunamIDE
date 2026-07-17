/**
 * Barrel file for technicalDebt services.
 * Re-exports all singleton getters so the review/ layer can import
 * them as a package: `import { getDebtAnalyzer, ... } from '../technicalDebt'`
 */
export { getDebtAnalyzer } from './DebtAnalyzer';
export { getDebtScorer } from './DebtScorer';
export { getCouplingAnalyzer } from './CouplingAnalyzer';
export { getCircularDepDetector } from './CircularDepDetector';
export { getIncrementalGraphEngine } from './IncrementalGraphEngine';
export { getDependencyGraphEngine } from './DependencyGraphEngine';
export { getDeadCodeAnalyzer } from './DeadCodeAnalyzer';
export { getDiffEngine } from './DiffEngine';
export { getGraphExporter } from './GraphExporter';
export { getRefactorPlanner } from './RefactorPlanner';
export { getImportExtractor } from './ImportExtractor';
export { getASTEngine } from './ASTEngine';
export { getASTMetricsExtractor } from './ASTMetricsExtractor';