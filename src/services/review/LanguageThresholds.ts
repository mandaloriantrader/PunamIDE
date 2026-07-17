/**
 * @phase P7
 * @purpose Per-language complexity threshold calibrations.
 *          McCabe complexity bands tuned for TypeScript are NOT
 *          automatically correct for Go or Rust idioms.
 *
 * Rationale for each language's thresholds is documented inline.
 */

import { SupportedLanguage, type ComplexityThresholds } from './MultiLanguageManager';

/**
 * Calibrated complexity thresholds for each supported language.
 *
 * Key principle: thresholds are NOT copy-pasted across languages.
 * Each language has different idioms, verbosity, and community norms.
 */
export const LANGUAGE_THRESHOLDS: Map<SupportedLanguage, ComplexityThresholds> = new Map([
  // ── TypeScript / JavaScript ──────────────────────────────────
  // Baseline thresholds. TS/JS functions tend to be moderate length
  // with moderate complexity. Community norm: small focused functions.
  [SupportedLanguage.TypeScript, {
    cyclomaticComplexityWarning: 10,
    cyclomaticComplexityCritical: 15,
    maxNestingDepthWarning: 4,
    maxNestingDepthCritical: 6,
    longFunctionLines: 50,
    godFunctionLines: 150,
    godClassMethods: 20,
    maxParameters: 5,
  }],
  [SupportedLanguage.JavaScript, {
    cyclomaticComplexityWarning: 10,
    cyclomaticComplexityCritical: 15,
    maxNestingDepthWarning: 4,
    maxNestingDepthCritical: 6,
    longFunctionLines: 50,
    godFunctionLines: 150,
    godClassMethods: 20,
    maxParameters: 5,
  }],

  // ── Python ───────────────────────────────────────────────────
  // Python strongly encourages simple, readable functions (PEP 8, Zen of Python).
  // Tighter thresholds than TS/JS — Python code that exceeds these is
  // almost certainly doing too much. Classes in Python tend to be smaller.
  [SupportedLanguage.Python, {
    cyclomaticComplexityWarning: 8,   // PEP 8 advocates simplicity
    cyclomaticComplexityCritical: 12,
    maxNestingDepthWarning: 4,
    maxNestingDepthCritical: 6,
    longFunctionLines: 40,             // Python functions should be short
    godFunctionLines: 100,
    godClassMethods: 15,               // Python classes tend to be focused
    maxParameters: 4,                  // Python favors *args/**kwargs over many params
  }],

  // ── Go ───────────────────────────────────────────────────────
  // Go functions tend to be longer than Python but shorter than Java.
  // Go's error handling (if err != nil) adds lines without adding complexity.
  // Go doesn't have classes — "god class" threshold applies to structs with methods.
  [SupportedLanguage.Go, {
    cyclomaticComplexityWarning: 10,
    cyclomaticComplexityCritical: 15,
    maxNestingDepthWarning: 4,
    maxNestingDepthCritical: 6,
    longFunctionLines: 60,             // Go functions are naturally longer (error handling)
    godFunctionLines: 120,
    godClassMethods: 20,               // Applies to structs with many methods
    maxParameters: 5,
  }],

  // ── Rust ─────────────────────────────────────────────────────
  // Rust is verbose due to explicit error handling (Result/Option) and
  // lifetime annotations. Functions are typically moderate length.
  // Rust's type system catches many bugs that complexity metrics proxy for.
  [SupportedLanguage.Rust, {
    cyclomaticComplexityWarning: 10,
    cyclomaticComplexityCritical: 15,
    maxNestingDepthWarning: 4,
    maxNestingDepthCritical: 6,
    longFunctionLines: 60,             // Rust is verbose — match arms add lines
    godFunctionLines: 120,
    godClassMethods: 15,               // Rust impl blocks should be focused
    maxParameters: 5,
  }],

  // ── Java ─────────────────────────────────────────────────────
  // Java is the most verbose mainstream language. Boilerplate (getters/setters,
  // try-catch, anonymous classes) inflates line counts without adding complexity.
  // Thresholds are relaxed accordingly. Enterprise Java classes are often large.
  [SupportedLanguage.Java, {
    cyclomaticComplexityWarning: 12,   // Java's verbosity inflates CC
    cyclomaticComplexityCritical: 18,
    maxNestingDepthWarning: 5,         // Java's anonymous classes add nesting
    maxNestingDepthCritical: 7,
    longFunctionLines: 60,
    godFunctionLines: 150,             // Java methods are naturally longer
    godClassMethods: 25,               // Java classes are often large (Spring, etc.)
    maxParameters: 6,                  // Java builders/factories use many params
  }],

  // ── C# ───────────────────────────────────────────────────────
  // C# is similar to Java in verbosity. LINQ and pattern matching reduce
  // some complexity vs Java, but overall thresholds are comparable.
  [SupportedLanguage.CSharp, {
    cyclomaticComplexityWarning: 12,
    cyclomaticComplexityCritical: 18,
    maxNestingDepthWarning: 5,
    maxNestingDepthCritical: 7,
    longFunctionLines: 60,
    godFunctionLines: 150,
    godClassMethods: 25,
    maxParameters: 6,
  }],

  // ── TSX / JSX ────────────────────────────────────────────────
  // Same as TypeScript — JSX is just syntax extension
  [SupportedLanguage.TSX, {
    cyclomaticComplexityWarning: 10,
    cyclomaticComplexityCritical: 15,
    maxNestingDepthWarning: 4,
    maxNestingDepthCritical: 6,
    longFunctionLines: 50,
    godFunctionLines: 150,
    godClassMethods: 20,
    maxParameters: 5,
  }],
  [SupportedLanguage.JSX, {
    cyclomaticComplexityWarning: 10,
    cyclomaticComplexityCritical: 15,
    maxNestingDepthWarning: 4,
    maxNestingDepthCritical: 6,
    longFunctionLines: 50,
    godFunctionLines: 150,
    godClassMethods: 20,
    maxParameters: 5,
  }],
]);
