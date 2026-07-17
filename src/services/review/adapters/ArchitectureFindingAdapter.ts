/**
 * @phase P1
 * @purpose Adapts architecture rule violations to the unified Finding[]
 *          model. The existing Architecture Rules Engine produces
 *          violations when imports cross layer boundaries.
 */

import { type Finding, type Severity } from '../types';

/** Raw architecture violation from the existing Rules Engine. */
export interface ArchitectureViolationResult {
  file: string;
  line: number;
  ruleName: string;
  expectedLayer: string;
  actualLayer: string;
  importedFile: string;
  description: string;
  severity: Severity;
}

/**
 * Converts ArchitectureViolationResult[] into Finding[] with source='architecture'.
 *
 * @param violations - Architecture rule violations
 * @returns Findings in the unified model
 */
export function adaptArchitectureViolations(
  violations: ArchitectureViolationResult[],
): Finding[] {
  return violations.map(v => ({
    id: `architecture:${v.file}:${v.line}:${v.ruleName}`,
    file: v.file,
    line: v.line,
    source: 'architecture' as const,
    severity: v.severity,
    // Explicit import violations are directly confirmed
    confidence: 'direct' as const,
    title: `Architecture violation: ${v.ruleName}`,
    description: v.description,
    whyFlagged: `Import from "${v.importedFile}" (${v.actualLayer}) violates rule "${v.ruleName}". File is in layer "${v.expectedLayer}".`,
    fix: `Move the import to respect layer boundaries. The file "${v.importedFile}" is in the "${v.actualLayer}" layer but "${v.ruleName}" requires imports only from allowed layers.`,
  }));
}

/**
 * Adapts architecture violations grouped by file.
 */
export function adaptArchitectureByFile(
  violationsByFile: Map<string, ArchitectureViolationResult[]>,
): Map<string, Finding[]> {
  const map = new Map<string, Finding[]>();
  for (const [file, violations] of violationsByFile) {
    map.set(file, adaptArchitectureViolations(violations));
  }
  return map;
}
