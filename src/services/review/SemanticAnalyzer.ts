/**
 * @phase P4
 * @purpose Type-aware semantic analysis using ts-morph. This is the
 *          module that moves the product from "metrics tool" to
 *          "bug finder." Runs as a second worker pass alongside the
 *          existing AST worker — does not block the fast path.
 *
 * Detection capabilities:
 * 1. Null/undefined mismatches across function boundaries
 * 2. Unhandled promise rejections and floating promises
 * 3. Unsafe type assertions (as any, non-null overuse, double assertions)
 * 4. Unreachable code after return/throw
 * 5. Implicit any leakage in exported functions
 * 6. Type narrowing errors (typeof on wrong types, instanceof on non-class)
 */

import { Project, SourceFile, type CompilerOptions } from 'ts-morph';
import { type Finding, type SemanticAnalysisConfig } from './types';
import { SemanticRuleEngine } from './SemanticRuleEngine';

/** Default compiler options for ts-morph project. */
const DEFAULT_COMPILER_OPTIONS: CompilerOptions = {
  strict: true,
  jsx: 2, // react-jsx
  esModuleInterop: true,
  skipLibCheck: true,
  noImplicitAny: true,
  strictNullChecks: true,
  target: 99, // ESNext
  module: 99, // ESNext
  moduleResolution: 99, // Bundler
};

/**
 * Type-aware semantic analyzer using ts-morph.
 *
 * This runs as a second pass after the tree-sitter AST analysis.
 * Type-checking is slower than tree-sitter parsing, so it degrades
 * gracefully: if ts-morph fails on a file, it logs and skips.
 */
export class SemanticAnalyzer {
  private project: Project;
  private ruleEngine: SemanticRuleEngine;
  private initialized = false;

  constructor(compilerOptions?: Partial<CompilerOptions>) {
    this.project = new Project({
      compilerOptions: { ...DEFAULT_COMPILER_OPTIONS, ...compilerOptions },
      useInMemoryFileSystem: true,
    });
    this.ruleEngine = new SemanticRuleEngine();
    this.initialized = true;
  }

  /**
   * Analyzes a single file for semantic issues.
   *
   * @param filePath - Path to the file
   * @param sourceContent - Source code content
   * @param config - Semantic analysis configuration
   * @returns Array of findings with source='type'
   */
  analyzeFile(
    filePath: string,
    sourceContent: string,
    config?: SemanticAnalysisConfig,
  ): Finding[] {
    if (!this.initialized) {
      console.warn('SemanticAnalyzer not initialized, skipping');
      return [];
    }

    try {
      // Add or update the source file in the project
      const existing = this.project.getSourceFile(filePath);
      if (existing) {
        this.project.removeSourceFile(existing);
      }

      const sourceFile = this.project.createSourceFile(filePath, sourceContent);

      // Run all enabled rules
      const findings = this.ruleEngine.runAll(
        sourceFile,
        config?.enabledRules,
        config?.maxFindingsPerRulePerFile ?? 50,
      );

      // Filter by severity threshold
      const severityOrder = ['critical', 'high', 'medium', 'low', 'info'];
      const thresholdIdx = severityOrder.indexOf(config?.severityThreshold ?? 'low');

      return findings.filter(f => {
        const fIdx = severityOrder.indexOf(f.severity);
        return fIdx <= thresholdIdx;
      });
    } catch (err) {
      // Degrade gracefully — don't crash the pipeline
      console.error(`Semantic analysis failed for ${filePath}:`, err);
      return [];
    }
  }

  /**
   * Analyzes multiple files for semantic issues.
   *
   * @param files - Map of file paths to source content
   * @param config - Semantic analysis configuration
   * @returns Map of file path to findings
   */
  analyzeFiles(
    files: Map<string, string>,
    config?: SemanticAnalysisConfig,
  ): Map<string, Finding[]> {
    const results = new Map<string, Finding[]>();

    for (const [filePath, content] of files) {
      // Only analyze .ts and .tsx files where full type info is available
      if (!filePath.endsWith('.ts') && !filePath.endsWith('.tsx')) {
        continue;
      }

      const findings = this.analyzeFile(filePath, content, config);
      if (findings.length > 0) {
        results.set(filePath, findings);
      }
    }

    return results;
  }

  /**
   * Analyzes a diff — only checks changed files.
   *
   * @param changedFiles - Map of changed file paths to source content
   * @param config - Semantic analysis configuration
   * @returns Map of file path to findings
   */
  analyzeDiff(
    changedFiles: Map<string, string>,
    config?: SemanticAnalysisConfig,
  ): Map<string, Finding[]> {
    return this.analyzeFiles(changedFiles, config);
  }

  /**
   * Gets all registered rule IDs.
   */
  getRuleIds(): string[] {
    return this.ruleEngine.getAllRules().map(r => r.id);
  }

  /**
   * Gets all registered rules with their metadata.
   */
  getRules() {
    return this.ruleEngine.getAllRules().map(r => ({
      id: r.id,
      name: r.name,
      severity: r.severity,
      defaultEnabled: r.defaultEnabled,
      cwe: r.cwe,
    }));
  }

  /**
   * Cleans up the ts-morph project to free memory.
   */
  dispose(): void {
    this.project.getSourceFiles().forEach(f => this.project.removeSourceFile(f));
    this.initialized = false;
  }
}

// ── Singleton pattern (follows existing codebase convention) ───────
let instance: SemanticAnalyzer | null = null;

/**
 * Gets the singleton SemanticAnalyzer instance.
 * Every service uses this pattern: `let instance: T | null = null`
 * with an exported `getXxx(): T` getter.
 */
export function getSemanticAnalyzer(): SemanticAnalyzer {
  if (!instance) instance = new SemanticAnalyzer();
  return instance;
}
