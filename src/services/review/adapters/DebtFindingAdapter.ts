/**
 * @phase P1
 * @purpose Adapts existing FileDebtMetrics to the unified Finding[] model.
 *          Converts structural risk metrics (complexity, nesting, god
 *          functions/classes, cycles, hubs) into typed Finding objects.
 */

import { type Finding } from '../types';
import type { FileDebtMetrics, ASTMetrics } from '../../technicalDebt/DebtAnalyzer';
import { THRESHOLDS } from '../../technicalDebt/DebtAnalyzer';

/**
 * Converts FileDebtMetrics into Finding[] with source='debt'.
 *
 * @param metrics - Existing per-file debt metrics
 * @returns Array of debt findings for this file
 */
export function adaptDebtMetrics(metrics: FileDebtMetrics): Finding[] {
  const findings: Finding[] = [];
  const file = metrics.filePath;
  const ast = metrics.astMetrics;

  // ── Cyclomatic Complexity ──────────────────────────────────
  if (ast && ast.cyclomaticComplexity > 15) {
    findings.push({
      id: `debt:${file}:cc:${ast.cyclomaticComplexity}`,
      file,
      source: 'debt',
      severity: ast.cyclomaticComplexity > 25 ? 'high' : 'medium',
      confidence: 'direct',
      title: `High cyclomatic complexity (${ast.cyclomaticComplexity})`,
      description: `Cyclomatic complexity of ${ast.cyclomaticComplexity} exceeds the threshold of 15. This function has many decision paths, making it harder to test and maintain.`,
      whyFlagged: `McCabe CC = ${ast.cyclomaticComplexity} (threshold: 15)`,
      expectedPayoff: 'Reduced testing burden, easier maintenance, lower defect probability',
      fix: 'Extract decision branches into named helper functions. Consider polymorphism over conditional chains.',
    });
  }

  // ── God Functions (>150 lines) ─────────────────────────────
  if (ast && ast.godFunctionCount > 0) {
    findings.push({
      id: `debt:${file}:godfunc:${ast.godFunctionCount}`,
      file,
      source: 'debt',
      severity: 'high',
      confidence: 'direct',
      title: `${ast.godFunctionCount} god function(s) detected (>150 lines)`,
      description: `${ast.godFunctionCount} function(s) exceed 150 lines. These are likely doing too much and should be decomposed.`,
      whyFlagged: `godFunctionCount = ${ast.godFunctionCount} (threshold: 0)`,
      expectedPayoff: 'Improved readability, testability, and reusability',
      fix: 'Break large functions into smaller, single-responsibility functions. Extract cohesive logic blocks.',
    });
  }

  // ── God Classes (>20 methods) ──────────────────────────────
  if (ast && ast.godClassCount > 0) {
    findings.push({
      id: `debt:${file}:godclass:${ast.godClassCount}`,
      file,
      source: 'debt',
      severity: 'high',
      confidence: 'direct',
      title: `${ast.godClassCount} god class(es) detected (>20 methods)`,
      description: `${ast.godClassCount} class(es) have more than 20 methods. This suggests the class has too many responsibilities.`,
      whyFlagged: `godClassCount = ${ast.godClassCount} (threshold: 0)`,
      expectedPayoff: 'Better adherence to Single Responsibility Principle',
      fix: 'Split the class into smaller, focused classes. Group related methods into separate classes.',
    });
  }

  // ── Deep Nesting (>5) ──────────────────────────────────────
  if (ast && ast.maxNestingDepth > 5) {
    findings.push({
      id: `debt:${file}:nesting:${ast.maxNestingDepth}`,
      file,
      source: 'debt',
      severity: 'medium',
      confidence: 'direct',
      title: `Deep nesting detected (depth ${ast.maxNestingDepth})`,
      description: `Maximum nesting depth of ${ast.maxNestingDepth} exceeds the threshold of 5. Deeply nested code is hard to read and error-prone.`,
      whyFlagged: `maxNestingDepth = ${ast.maxNestingDepth} (threshold: 5)`,
      expectedPayoff: 'Improved readability, reduced cognitive load',
      fix: 'Use early returns (guard clauses), extract nested logic into functions, or use array methods instead of loops.',
    });
  }

  // ── High Parameter Count (>5) ──────────────────────────────
  if (ast && ast.maxParameterCount > 5) {
    findings.push({
      id: `debt:${file}:params:${ast.maxParameterCount}`,
      file,
      source: 'debt',
      severity: 'low',
      confidence: 'direct',
      title: `High parameter count (${ast.maxParameterCount})`,
      description: `A function has ${ast.maxParameterCount} parameters. Functions with many parameters are hard to use and often indicate too many responsibilities.`,
      whyFlagged: `maxParameterCount = ${ast.maxParameterCount} (threshold: 5)`,
      expectedPayoff: 'Simpler function signatures, reduced misuse',
      fix: 'Group related parameters into an options object. Consider splitting the function.',
    });
  }

  // ── TODO/FIXME ─────────────────────────────────────────────
  if (metrics.todoCount > 0 || metrics.fixmeCount > 0) {
    findings.push({
      id: `debt:${file}:todos:${metrics.todoCount}:${metrics.fixmeCount}`,
      file,
      source: 'debt',
      severity: 'info',
      confidence: 'direct',
      title: `${metrics.todoCount} TODO(s), ${metrics.fixmeCount} FIXME(s)`,
      description: `This file contains ${metrics.todoCount} TODO comments and ${metrics.fixmeCount} FIXME comments. These should be tracked and resolved.`,
      whyFlagged: `todoCount=${metrics.todoCount}, fixmeCount=${metrics.fixmeCount}`,
    });
  }

  // ── Hub File ───────────────────────────────────────────────
  if (metrics.isHubFile) {
    findings.push({
      id: `debt:${file}:hub`,
      file,
      source: 'debt',
      severity: 'low',
      confidence: 'heuristic',
      title: 'Hub file detected (high fan-in/fan-out)',
      description: 'This file is a hub — it is imported by many files and/or imports many files. Changes here have wide blast radius.',
      whyFlagged: 'isHubFile = true (adaptive threshold exceeded)',
      expectedPayoff: 'Reduced change propagation risk',
      fix: 'Consider splitting the hub into smaller, more focused modules.',
    });
  }

  // ── Circular Dependency ────────────────────────────────────
  if (metrics.isInCycle) {
    findings.push({
      id: `debt:${file}:cycle`,
      file,
      source: 'debt',
      severity: 'high',
      confidence: 'direct',
      title: 'File is part of a circular dependency',
      description: 'This file is involved in a circular dependency. Circular dependencies cause initialization order issues and make the codebase harder to reason about.',
      whyFlagged: 'isInCycle = true (Tarjan SCC detected)',
      expectedPayoff: 'Eliminates initialization order bugs, improves modularity',
      fix: 'Break the cycle by extracting shared logic into a third module, or use dependency inversion.',
    });
  }

  return findings;
}

/**
 * Adapts an array of FileDebtMetrics into a map of file → Finding[].
 */
export function adaptAllDebtMetrics(allMetrics: FileDebtMetrics[]): Map<string, Finding[]> {
  const map = new Map<string, Finding[]>();
  for (const m of allMetrics) {
    map.set(m.filePath, adaptDebtMetrics(m));
  }
  return map;
}