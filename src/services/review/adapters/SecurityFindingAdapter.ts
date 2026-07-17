/**
 * @phase P1 / Tier 3 (custom)
 * @purpose Custom adapter that converts the EXISTING, more-complete
 *          security scanner (src/services/security/SecurityPatterns.ts)
 *          into the unified Finding[] model.
 *
 * Per the integration plan, we deliberately DO NOT adopt the new
 * codebase's taint-based SecurityFindingAdapter (6 sources / 7 sinks /
 * no trend/diff/recommendation layer, and its own SecurityPanel hardcodes
 * a single file path). Instead we wrap our real 19-pattern library
 * (with CWE + OWASP + highFalsePositiveRate flags) and map it to Finding.
 */

import type { Finding, Severity } from '../types';
import type { SecurityFinding } from '../../security/SecurityPatterns';

/**
 * Converts SecurityFinding[] (from the real pattern scanner) into
 * Finding[] with source='security'.
 *
 * @param results - Raw security findings from scanFile/scanPatch
 * @returns Findings in the unified model
 */
export function adaptSecurityResults(results: SecurityFinding[]): Finding[] {
  return results.map(r => ({
    id: `security:${r.filePath}:${r.line}:${r.patternId}`,
    file: r.filePath,
    line: r.line,
    column: r.column,
    source: 'security' as const,
    severity: r.severity as Severity,
    // Pattern-based matches are heuristic — no taint tracking yet (P5 adds that)
    confidence: 'heuristic' as const,
    title: r.patternId,
    description: r.description,
    whyFlagged: `Pattern match: "${r.snippet}" (rule: ${r.patternId}, OWASP: ${r.owasp})`,
    cwe: r.cwe != null ? `CWE-${r.cwe}` : undefined,
    fix: r.suggestion,
  }));
}

/**
 * Adapts security results grouped by file.
 * @param resultsByFile - Map of file path to security findings
 * @returns Map of file path to findings
 */
export function adaptSecurityByFile(
  resultsByFile: Map<string, SecurityFinding[]>,
): Map<string, Finding[]> {
  const map = new Map<string, Finding[]>();
  for (const [file, results] of resultsByFile) {
    map.set(file, adaptSecurityResults(results));
  }
  return map;
}