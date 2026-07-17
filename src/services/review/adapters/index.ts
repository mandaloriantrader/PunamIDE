/**
 * @phase P1
 * @purpose Barrel export for all finding adapters.
 */

export { adaptDebtMetrics, adaptAllDebtMetrics } from './DebtFindingAdapter';
export { adaptSecurityResults, adaptSecurityByFile } from './SecurityFindingAdapter';
export { adaptArchitectureViolations, adaptArchitectureByFile } from './ArchitectureFindingAdapter';
export type { ArchitectureViolationResult } from './ArchitectureFindingAdapter';
