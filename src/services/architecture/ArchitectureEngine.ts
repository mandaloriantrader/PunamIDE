/**
 * ArchitectureEngine.ts
 *
 * Frontend TypeScript wrapper for the Architecture Guardrails Engine (Phase 1).
 *
 * Coordinates Rust backend commands (analyze_dependencies, validate_architecture,
 * validate_patch_against_rules, get_default_rules) and provides a clean API
 * for React components.
 */

import { invoke } from "@tauri-apps/api/core";

// ── TypeScript Types (mirrors Rust structs) ────────────────────────────────────

export interface DependencyEdge {
  from_file: string;
  to_module: string;
  import_kind: string; // "es6_import", "commonjs_require", "python_import", "rust_use", etc.
  is_external: boolean;
}

export interface DependencyAnalysisResult {
  edges: DependencyEdge[];
  file_count: number;
  parse_errors: string[];
}

export interface GraphStats {
  total_files: number;
  total_edges: number;
  local_edges: number;
  external_edges: number;
}

export interface DependencyGraph {
  forward: Record<string, string[]>;
  reverse: Record<string, string[]>;
  files: string[];
  stats: GraphStats;
}

export interface CycleCheckResult {
  has_cycles: boolean;
  cycles: string[][];
}

export interface DependencyViolation {
  from_file: string;
  to_file: string;
  violation_type: string;
  description: string;
}

export interface ValidationResult {
  allowed: boolean;
  violations: DependencyViolation[];
  error_count: number;
  warning_count: number;
}

export interface ArchitectureRule {
  id: string;
  description: string;
  severity: "error" | "warning";
}

export interface ArchitectureRules {
  rules: ArchitectureRule[];
  layers: Record<string, string[]>;
}

// ── Rust Command Invocations ───────────────────────────────────────────────────

/**
 * Analyze all dependencies in the current project.
 * Walks the project tree and parses imports from TS, JS, Python, and Rust files.
 */
export async function analyzeDependencies(): Promise<DependencyAnalysisResult> {
  return invoke<DependencyAnalysisResult>("analyze_dependencies");
}

/**
 * Analyze dependencies for a specific set of changed files.
 * Useful for incremental analysis after file changes.
 */
export async function analyzeFileDependencies(
  filePaths: string[],
): Promise<DependencyAnalysisResult> {
  return invoke<DependencyAnalysisResult>("analyze_file_dependencies", {
    filePaths,
  });
}

/**
 * Validate the entire project against architecture rules.
 * Takes a JSON-serialized ArchitectureRules config.
 */
export async function validateArchitecture(
  rules: ArchitectureRules,
): Promise<ValidationResult> {
  const rulesJson = JSON.stringify(rules);
  return invoke<ValidationResult>("validate_architecture", {
    rulesJson,
  });
}

/**
 * Validate proposed file changes against architecture rules.
 *
 * This is the key function called BEFORE executing `apply_patch`.
 * It re-analyzes only the affected files and checks them against rules.
 *
 * @returns ValidationResult — if result.allowed is false, the patch should be blocked.
 */
export async function validatePatchAgainstRules(
  rules: ArchitectureRules,
  changedFiles: string[],
): Promise<ValidationResult> {
  const rulesJson = JSON.stringify(rules);
  return invoke<ValidationResult>("validate_patch_against_rules", {
    rulesJson,
    changedFiles,
  });
}

/**
 * Get the default/recommended architecture rules.
 * These can be customized by the user in settings.
 */
export async function getDefaultRules(): Promise<ArchitectureRules> {
  return invoke<ArchitectureRules>("get_default_rules");
}

// ── Caching Layer ──────────────────────────────────────────────────────────────

let cachedAnalysis: DependencyAnalysisResult | null = null;
let cachedRules: ArchitectureRules | null = null;
let lastAnalysisTime = 0;
const CACHE_TTL_MS = 30_000; // 30 seconds cache before re-scanning

/**
 * Get the full project dependency analysis with smart caching.
 * Re-scans after 30 seconds or if forceRefresh is true.
 */
export async function getCachedAnalysis(
  forceRefresh = false,
): Promise<DependencyAnalysisResult> {
  const now = Date.now();
  if (
    !forceRefresh &&
    cachedAnalysis &&
    now - lastAnalysisTime < CACHE_TTL_MS
  ) {
    return cachedAnalysis;
  }

  cachedAnalysis = await analyzeDependencies();
  lastAnalysisTime = now;
  return cachedAnalysis;
}

/**
 * Get architecture rules from cache or Rust backend.
 */
export async function getCachedRules(): Promise<ArchitectureRules> {
  if (cachedRules) return cachedRules;
  cachedRules = await getDefaultRules();
  return cachedRules;
}

/**
 * Invalidate all cached data (called when project root changes or rules are edited).
 */
export function invalidateCache(): void {
  cachedAnalysis = null;
  cachedRules = null;
  lastAnalysisTime = 0;
}

// ── Convenience Utility Functions ──────────────────────────────────────────────

/**
 * Quick check: does the project have any circular dependencies?
 */
export async function hasCircularDependencies(): Promise<{
  hasCycles: boolean;
  cycles: string[][];
}> {
  const rules = await getCachedRules();
  const result = await validateArchitecture(rules);

  const circularViolations = result.violations.filter(
    (v) => v.violation_type === "circular_dependency",
  );

  // Build cycle list from violation descriptions
  const cycles: string[][] = circularViolations.map((v) => {
    // Extract the cycle path from description: "Circular dependency detected: a → b → a"
    const match = v.description.match(/detected: (.+)$/);
    if (match) {
      return match[1].split(" → ");
    }
    return [v.from_file, v.to_file];
  });

  return {
    hasCycles: circularViolations.length > 0,
    cycles,
  };
}

/**
 * Validate a single file path against all rules.
 * Convenience wrapper around validatePatchAgainstRules.
 */
export async function validateFile(
  filePath: string,
): Promise<ValidationResult> {
  const rules = await getCachedRules();
  return validatePatchAgainstRules(rules, [filePath]);
}

/**
 * Get the number of files that depend on a given file (impact estimate).
 */
export async function getDependentCount(filePath: string): Promise<number> {
  const analysis = await getCachedAnalysis();
  // Count edges where to_module matches the file path
  const dependents = analysis.edges.filter(
    (e) => e.to_module === filePath && !e.is_external,
  );
  return dependents.length;
}

/**
 * Build a summary of architecture health for display in the status bar / dashboard.
 */
export async function getArchitectureHealth(): Promise<{
  totalFiles: number;
  totalEdges: number;
  circularDeps: number;
  layerViolations: number;
  score: "good" | "warning" | "critical";
  summary: string;
}> {
  const analysis = await getCachedAnalysis();
  const rules = await getCachedRules();
  const validation = await validateArchitecture(rules);

  const circularDeps = validation.violations.filter(
    (v) => v.violation_type === "circular_dependency",
  ).length;
  const layerViolations = validation.violations.filter(
    (v) => v.violation_type !== "circular_dependency",
  ).length;

  let score: "good" | "warning" | "critical";
  if (validation.error_count === 0) {
    score = "good";
  } else if (validation.error_count <= 5) {
    score = "warning";
  } else {
    score = "critical";
  }

  const summary =
    score === "good"
      ? "Architecture rules passing"
      : score === "warning"
        ? `${validation.error_count} rule violation(s)`
        : `${validation.error_count} critical violations — architecture at risk`;

  return {
    totalFiles: analysis.file_count,
    totalEdges: analysis.edges.length,
    circularDeps,
    layerViolations,
    score,
    summary,
  };
}

// ── Store Integration ──────────────────────────────────────────────────────────

import { load } from "@tauri-apps/plugin-store";

const STORE_NAME = "punamide-settings.json";
const ARCH_RULES_KEY = "architecture_rules";

/**
 * Load user-customized architecture rules from persistent store.
 * Falls back to Rust's get_default_rules if none saved.
 */
export async function loadArchitectureRules(): Promise<ArchitectureRules> {
  try {
    const store = await load(STORE_NAME, { autoSave: true, defaults: {} });
    const saved = (await store.get(ARCH_RULES_KEY)) as ArchitectureRules | null;
    if (saved && saved.rules) {
      cachedRules = saved;
      return saved;
    }
  } catch {
    // Fall through to defaults
  }
  return getCachedRules();
}

/**
 * Save user-customized architecture rules to persistent store.
 */
export async function saveArchitectureRules(
  rules: ArchitectureRules,
): Promise<void> {
  const store = await load(STORE_NAME, { autoSave: true, defaults: {} });
  await store.set(ARCH_RULES_KEY, rules);
  await store.save();
  cachedRules = rules;
}

/**
 * Reset architecture rules to defaults.
 */
export async function resetArchitectureRules(): Promise<ArchitectureRules> {
  const defaults = await getDefaultRules();
  await saveArchitectureRules(defaults);
  return defaults;
}