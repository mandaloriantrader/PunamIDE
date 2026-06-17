/**
 * ViolationReporter.ts — Step 1.6
 *
 * Converts architecture guardrail violations into Problem[] format
 * for display in the existing Problems Panel.
 *
 * Architecture violations detected by the Rust rule_engine are surfaced
 * as IDE problems — same format as build errors, type errors, etc.
 */

import type { Problem } from "../../utils/problems";
import {
  validateArchitecture,
  getCachedRules,
  getCachedAnalysis,
  invalidateCache,
} from "./ArchitectureEngine";
import type { DependencyViolation, ArchitectureRules } from "./ArchitectureEngine";

/**
 * Run architecture validation and return violations as Problem[] for the Problems Panel.
 *
 * @param projectPath - Project root path (for displaying relative paths)
 * @param rulesConfig - Optional custom rules; falls back to defaults from Rust
 * @returns Problems array suitable for setProblems() in App.tsx
 */
export async function scanArchitectureViolations(
  _projectPath: string,
  rulesConfig?: ArchitectureRules,
): Promise<Problem[]> {
  try {
    // Force fresh analysis so violations reflect current state
    invalidateCache();
    const rules = rulesConfig || (await getCachedRules());
    const validation = await validateArchitecture(rules);

    const problems: Problem[] = [];
    let idCounter = 0;

    for (const violation of validation.violations) {
      // Only report errors as problems; warnings are informational
      const severity = violation.violation_type === "circular_dependency"
        ? "error"
        : "warning";

      problems.push({
        id: `arch-${violation.violation_type}-${idCounter++}-${Date.now()}`,
        path: violation.from_file,
        line: 1, // Architecture violations are file-level, not line-level
        message: `[Architecture] ${violation.description}`,
        severity,
        source: "Architecture Guard",
      });

      // For file-to-file violations, also add the target file as info
      if (violation.to_file && violation.to_file !== violation.from_file) {
        problems.push({
          id: `arch-${violation.violation_type}-${idCounter++}-${Date.now()}`,
          path: violation.to_file,
          line: 1,
          message: `[Architecture] Imported by ${violation.from_file} — ${violation.description}`,
          severity: "info",
          source: "Architecture Guard",
        });
      }
    }

    return problems;
  } catch (err) {
    console.warn("[Architecture] Violation scan failed:", err);
    return [];
  }
}

/**
 * Lightweight: only check for circular dependencies (fastest rule).
 * Returns just the cycle information for status bar display.
 */
export async function quickCircularCheck(): Promise<{
  hasCycles: boolean;
  cycles: string[][];
}> {
  try {
    const { hasCircularDependencies } = await import("./ArchitectureEngine");
    return hasCircularDependencies();
  } catch {
    return { hasCycles: false, cycles: [] };
  }
}