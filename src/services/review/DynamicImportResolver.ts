/**
 * @phase P3
 * @purpose TypeScript-side wrapper that calls the Rust dynamic import
 *          handler via Tauri invoke. Maps Rust ImportClassification
 *          to TypeScript Finding with appropriate confidence and severity.
 */

import { type Finding } from './types';

/** Interface for Tauri's invoke function (inject for testability). */
export interface TauriInvokeInterface {
  invoke<T>(command: string, args?: Record<string, unknown>): Promise<T>;
}

/** Rust ImportClassification (mirrors the Rust enum). */
export type ImportClassification =
  | { type: 'StaticallyEnumerable'; resolvedPath: string }
  | { type: 'UnresolvableLocal'; confidence: number; traceHops: number }
  | { type: 'UnresolvableTrustBoundary'; reason: string };

/** Rust ImportContext (mirrors the Rust struct). */
export interface ImportContext {
  hasUserInput: boolean;
  hasNetworkResponse: boolean;
  hasEnvVar: boolean;
  localConstants: Record<string, string>;
}

/**
 * Resolves dynamic imports by calling the Rust native handler.
 * Maps classifications to unified Findings.
 */
export class DynamicImportResolver {
  private invoke: TauriInvokeInterface;
  constructor(invoke: TauriInvokeInterface) {
    this.invoke = invoke;
  }

  /**
   * Classifies a dynamic import and produces a Finding if needed.
   *
   * @param file - File containing the import
   * @param line - Line number of the import
   * @param specifierExpr - The import specifier expression
   * @param source - Full source code of the file
   * @param context - Import context for classification
   * @returns Finding if the import is unresolvable, null if it resolves cleanly
   */
  async resolveDynamicImport(
    file: string,
    line: number,
    specifierExpr: string,
    source: string,
    context: ImportContext,
  ): Promise<Finding | null> {
    const classification = await this.invoke.invoke<ImportClassification>(
      'classify_dynamic_import',
      {
        specifierExpr,
        source,
        context,
      },
    );

    switch (classification.type) {
      case 'StaticallyEnumerable':
        // Resolves normally — no finding needed
        return null;

      case 'UnresolvableLocal':
        // Traced to local const/enum with no external input → medium, non-blocking
        return {
          id: `dynimport:${file}:${line}:local`,
          file,
          line,
          source: 'architecture',
          severity: 'medium',
          confidence: 'heuristic',
          title: 'Dynamic import with unresolvable local specifier',
          description: `The dynamic import specifier "${specifierExpr}" could not be statically resolved. It was traced to a local variable (${classification.traceHops} hops) but the target module is uncertain.`,
          whyFlagged: `Unresolvable within trust boundary (confidence: ${classification.confidence}, hops: ${classification.traceHops})`,
          fix: 'Replace dynamic import with a static import, or add explicit type annotations for the imported module.',
        };

      case 'UnresolvableTrustBoundary':
        // User input, network response, env var → fail-closed, always flag
        return {
          id: `dynimport:${file}:${line}:trust`,
          file,
          line,
          source: 'architecture',
          severity: 'high',
          confidence: 'unresolvable',
          title: 'Dynamic import crossing trust boundary',
          description: `The dynamic import specifier "${specifierExpr}" crosses a trust boundary. This is a security risk — untrusted input could control which module is loaded.`,
          whyFlagged: `Unresolvable crossing trust boundary: ${classification.reason}`,
          cwe: 'CWE-829',
          fix: 'Never use untrusted input to determine import paths. Use a whitelist mapping from input values to static imports.',
        };
    }
  }

  /**
   * Resolves multiple dynamic imports in a file.
   *
   * @param file - File path
   * @param imports - Array of dynamic import locations
   * @param source - Full source code
   * @param context - Import context
   * @returns Findings for all unresolvable imports
   */
  async resolveAll(
    file: string,
    imports: { line: number; specifier: string }[],
    source: string,
    context: ImportContext,
  ): Promise<Finding[]> {
    const findings: Finding[] = [];

    for (const imp of imports) {
      const finding = await this.resolveDynamicImport(
        file,
        imp.line,
        imp.specifier,
        source,
        context,
      );
      if (finding) findings.push(finding);
    }

    return findings;
  }
}

// ── Singleton pattern (follows existing codebase convention) ───────
let instance: DynamicImportResolver | null = null;

export function getDynamicImportResolver(): DynamicImportResolver {
  if (!instance) throw new Error('DynamicImportResolver not initialized. Call initDynamicImportResolver() first.');
  return instance;
}

export function initDynamicImportResolver(invoke: TauriInvokeInterface): DynamicImportResolver {
  instance = new DynamicImportResolver(invoke);
  return instance;
}
