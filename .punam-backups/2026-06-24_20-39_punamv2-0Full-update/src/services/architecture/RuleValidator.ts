/**
 * RuleValidator.ts — Phase 1
 *
 * TypeScript wrapper around Rust `rule_engine.rs`.
 * Validates individual architecture rules and provides a clean API
 * for UI components to check specific rules on demand.
 *
 * Available rules:
 *   - ui_cannot_access_database
 *   - no_circular_dependencies
 *   - services_cannot_import_components
 *   - repositories_handle_db_only
 */

import { invoke } from "@tauri-apps/api/core";
import {
  getCachedRules,
  validateArchitecture,
  validatePatchAgainstRules,
} from "./ArchitectureEngine";
import type {
  ArchitectureRules,
  DependencyViolation,
  ValidationResult,
} from "./ArchitectureEngine";

// ── Types ──────────────────────────────────────────────────────────────────────

export interface RuleValidationResult {
  ruleId: string;
  passed: boolean;
  violations: RuleViolation[];
  checkedFiles: number;
  timeMs: number;
}

export interface RuleViolation {
  fromFile: string;
  toFile: string;
  description: string;
  severity: "error" | "warning";
}

export interface RuleDefinition {
  id: string;
  description: string;
  severity: "error" | "warning";
  category: "layer" | "circular" | "boundary" | "custom";
}

// ── Built-in Rule Definitions ──────────────────────────────────────────────────

export const BUILT_IN_RULES: RuleDefinition[] = [
  {
    id: "ui_cannot_access_database",
    description: "UI components must not directly import database/persistence modules",
    severity: "error",
    category: "layer",
  },
  {
    id: "no_circular_dependencies",
    description: "No circular dependency chains allowed between modules",
    severity: "error",
    category: "circular",
  },
  {
    id: "services_cannot_import_components",
    description: "Service layer must not import from UI component layer",
    severity: "error",
    category: "layer",
  },
  {
    id: "repositories_handle_db_only",
    description: "Repository/persistence modules must not contain business logic",
    severity: "warning",
    category: "boundary",
  },
];

// ── RuleValidator Class ────────────────────────────────────────────────────────

export class RuleValidator {
  private rules: ArchitectureRules | null = null;

  /**
   * Load rules from cache or Rust backend.
   */
  async loadRules(): Promise<ArchitectureRules> {
    if (!this.rules) {
      this.rules = await getCachedRules();
    }
    return this.rules;
  }

  /**
   * Validate a single rule against the entire project.
   */
  async validateRule(ruleId: string): Promise<RuleValidationResult> {
    const startTime = Date.now();
    const rules = await this.loadRules();

    // Filter to only the requested rule
    const singleRuleConfig: ArchitectureRules = {
      rules: rules.rules.filter((r) => r.id === ruleId),
      layers: rules.layers,
    };

    if (singleRuleConfig.rules.length === 0) {
      return {
        ruleId,
        passed: true,
        violations: [],
        checkedFiles: 0,
        timeMs: Date.now() - startTime,
      };
    }

    const result = await validateArchitecture(singleRuleConfig);
    const timeMs = Date.now() - startTime;

    return {
      ruleId,
      passed: result.error_count === 0,
      violations: result.violations.map((v) => ({
        fromFile: v.from_file,
        toFile: v.to_file,
        description: v.description,
        severity: v.violation_type === "circular_dependency" ? "error" : "error",
      })),
      checkedFiles: result.violations.length > 0 ? result.violations.length : 0,
      timeMs,
    };
  }

  /**
   * Validate a specific rule against a set of files (incremental).
   */
  async validateRuleForFiles(
    ruleId: string,
    filePaths: string[],
  ): Promise<RuleValidationResult> {
    const startTime = Date.now();
    const rules = await this.loadRules();

    const singleRuleConfig: ArchitectureRules = {
      rules: rules.rules.filter((r) => r.id === ruleId),
      layers: rules.layers,
    };

    if (singleRuleConfig.rules.length === 0) {
      return {
        ruleId,
        passed: true,
        violations: [],
        checkedFiles: filePaths.length,
        timeMs: Date.now() - startTime,
      };
    }

    const result = await validatePatchAgainstRules(singleRuleConfig, filePaths);
    const timeMs = Date.now() - startTime;

    return {
      ruleId,
      passed: result.error_count === 0,
      violations: result.violations.map((v) => ({
        fromFile: v.from_file,
        toFile: v.to_file,
        description: v.description,
        severity: "error",
      })),
      checkedFiles: filePaths.length,
      timeMs,
    };
  }

  /**
   * Validate ALL rules at once and return per-rule results.
   */
  async validateAllRules(): Promise<RuleValidationResult[]> {
    const rules = await this.loadRules();
    const results: RuleValidationResult[] = [];

    for (const rule of rules.rules) {
      const result = await this.validateRule(rule.id);
      results.push(result);
    }

    return results;
  }

  /**
   * Get all available rule definitions (built-in + user-configured).
   */
  async getRuleDefinitions(): Promise<RuleDefinition[]> {
    const rules = await this.loadRules();
    return rules.rules.map((r) => {
      const builtIn = BUILT_IN_RULES.find((b) => b.id === r.id);
      return {
        id: r.id,
        description: r.description,
        severity: r.severity,
        category: builtIn?.category ?? "custom",
      };
    });
  }

  /**
   * Check if a specific file violates any rules.
   */
  async checkFile(filePath: string): Promise<{
    passed: boolean;
    violations: RuleViolation[];
  }> {
    const rules = await this.loadRules();
    const result = await validatePatchAgainstRules(rules, [filePath]);

    return {
      passed: result.error_count === 0,
      violations: result.violations.map((v) => ({
        fromFile: v.from_file,
        toFile: v.to_file,
        description: v.description,
        severity: "error",
      })),
    };
  }
}

// ── Singleton ──────────────────────────────────────────────────────────────────

let instance: RuleValidator | null = null;

export function getRuleValidator(): RuleValidator {
  if (!instance) {
    instance = new RuleValidator();
  }
  return instance;
}
