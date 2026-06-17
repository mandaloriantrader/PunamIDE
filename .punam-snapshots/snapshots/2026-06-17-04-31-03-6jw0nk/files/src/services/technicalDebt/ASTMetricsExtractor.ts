/**
 * ASTMetricsExtractor.ts — Phase 2
 *
 * Pure AST walker. Given a Tree-sitter Tree, extracts all ASTMetrics
 * defined in DebtAnalyzer.ts.
 *
 * Design principles:
 *  - No I/O, no async — takes a Tree, returns ASTMetrics synchronously
 *  - Language-agnostic node type sets — TS and JS share most node names;
 *    differences are handled via per-language override maps
 *  - All thresholds match the Phase 3 spec exactly
 *  - Zero dependencies beyond web-tree-sitter types
 *
 * Metrics computed:
 *  cyclomaticComplexity  — McCabe complexity (decision points + 1 per function)
 *  maxNestingDepth       — deepest nesting level in the file
 *  avgNestingDepth       — mean nesting depth across all functions
 *  functionCount         — AST-accurate count (not regex)
 *  longFunctionCount     — functions > LONG_FUNCTION_LOC lines
 *  godFunctionCount      — functions > GOD_FUNCTION_LOC lines
 *  maxParameterCount     — largest parameter list
 *  avgParameterCount     — mean parameter count
 *  classCount            — class declarations
 *  godClassCount         — classes with > GOD_CLASS_METHOD_THRESHOLD methods
 *  returnCount           — total return statements (all functions)
 *
 * Cyclomatic complexity thresholds (Phase 3 spec):
 *   1–10   Good
 *   11–20  Moderate
 *   21–30  High
 *   30+    Critical
 *
 * Nesting depth thresholds (Phase 3 spec):
 *   1–3    Good
 *   4–5    Warning
 *   6+     Refactor Candidate
 *
 * Phase 3 additions:
 *  - Per-function breakdown (not just file-level aggregates)
 *  - Duplicate code block detection
 *  Add those by extending extractFunctionMetrics() and calling
 *  a new extractDuplicates() walker.
 */

import type { Node as SyntaxNode, Tree } from 'web-tree-sitter'
import type { ASTMetrics } from './DebtAnalyzer'

// ── Thresholds (kept in sync with DebtAnalyzer THRESHOLDS) ────────────────────

const LONG_FUNCTION_LOC     = 50
const GOD_FUNCTION_LOC      = 150
const GOD_CLASS_METHOD_COUNT = 20
const EXCESSIVE_PARAMS       = 5

// ── Node type sets ─────────────────────────────────────────────────────────────

/**
 * Node types that count as +1 to cyclomatic complexity.
 * Standard McCabe set — decision points that create distinct execution paths.
 * Modern syntax features (optional chaining, nullish coalescing, logical operators)
 * are intentionally excluded as they are language idioms, not maintainability risks.
 */
const COMPLEXITY_NODES = new Set([
  // Conditionals
  'if_statement',
  'switch_case',
  'ternary_expression',

  // Loops
  'for_statement',
  'for_in_statement',
  'for_of_statement',
  'while_statement',
  'do_statement',

  // Exception handling
  'catch_clause',
])

/**
 * Node types that define a new nesting scope.
 * Used for both nesting depth and function boundary detection.
 */
const NESTING_SCOPE_NODES = new Set([
  'if_statement',
  'else_clause',
  'for_statement',
  'for_in_statement',
  'for_of_statement',
  'while_statement',
  'do_statement',
  'switch_statement',
  'try_statement',
  'catch_clause',
  'with_statement',
])

/**
 * Node types that define a function boundary.
 * Used to count functions and measure per-function length.
 */
const FUNCTION_NODES = new Set([
  'function_declaration',
  'function_expression',
  'arrow_function',
  'method_definition',
  'generator_function_declaration',
  'generator_function',

  // TypeScript
  'method_signature',
  'function_signature',
  'abstract_method_signature',
])

/** Node types that define a class. */
const CLASS_NODES = new Set([
  'class_declaration',
  'class_expression',
  'abstract_class_declaration',
])

// ── Extractor ──────────────────────────────────────────────────────────────────

interface FunctionInfo {
  lineCount:  number
  paramCount: number
}

export class ASTMetricsExtractor {

  /**
   * Extract all ASTMetrics from a parsed Tree.
   * Returns null-safe defaults if the tree root is missing.
   */
  extract(tree: Tree): ASTMetrics {
    const root = tree.rootNode
    if (!root) return this.emptyMetrics()

    const functionMetrics = this.extractFunctionMetrics(root)
    const classMetrics    = this.extractClassMetrics(root)
    const complexity      = this.extractComplexity(root)
    const nestingMetrics  = this.extractNestingMetrics(root)
    const returnCount     = this.countNodeType(root, 'return_statement')

    const functionCount     = functionMetrics.length
    const longFunctionCount = functionMetrics.filter((f) => f.lineCount > LONG_FUNCTION_LOC).length
    const godFunctionCount  = functionMetrics.filter((f) => f.lineCount > GOD_FUNCTION_LOC).length

    const paramCounts       = functionMetrics.map((f) => f.paramCount)
    const maxParameterCount = paramCounts.length > 0 ? Math.max(...paramCounts) : 0
    const avgParameterCount = paramCounts.length > 0
      ? Math.round(paramCounts.reduce((s, v) => s + v, 0) / paramCounts.length)
      : 0

    return {
      cyclomaticComplexity: complexity,
      maxNestingDepth:      nestingMetrics.max,
      avgNestingDepth:      nestingMetrics.avg,
      functionCount,
      longFunctionCount,
      godFunctionCount,
      maxParameterCount,
      avgParameterCount,
      classCount:           classMetrics.count,
      godClassCount:        classMetrics.godCount,
      returnCount,
    }
  }

  // ── Cyclomatic complexity ─────────────────────────────────────────────────────

  /**
   * Walk the full tree and sum decision points.
   * Result = decision_points + 1 (McCabe).
   */
  private extractComplexity(root: SyntaxNode): number {
    let count = 1 // base complexity
    this.walk(root, (node) => {
      if (COMPLEXITY_NODES.has(node.type)) {
        count++
      }
    })
    return count
  }

  // ── Nesting depth ─────────────────────────────────────────────────────────────

  /**
   * Measure nesting depth per function, then aggregate.
   * max = deepest nesting in any single function
   * avg = mean of per-function max nesting depths
   */
  private extractNestingMetrics(root: SyntaxNode): { max: number; avg: number } {
    const functionNestings: number[] = []

    this.walk(root, (node) => {
      if (!FUNCTION_NODES.has(node.type)) return

      let maxDepth = 0
      const measureNesting = (n: SyntaxNode, depth: number) => {
        const newDepth = NESTING_SCOPE_NODES.has(n.type) ? depth + 1 : depth
        if (newDepth > maxDepth) maxDepth = newDepth

        for (let i = 0; i < n.childCount; i++) {
          const child = n.child(i)
          if (!child?.isNamed) continue
          if (FUNCTION_NODES.has(child.type)) continue
          measureNesting(child, newDepth)
        }
      }

      for (let i = 0; i < node.childCount; i++) {
        const child = node.child(i)
        if (child?.isNamed) measureNesting(child, 0)
      }

      functionNestings.push(maxDepth)
    })

    if (functionNestings.length === 0) return { max: 0, avg: 0 }

    const max = Math.max(...functionNestings)
    const avg = Math.round(functionNestings.reduce((s, v) => s + v, 0) / functionNestings.length)
    return { max, avg }
  }

  // ── Function metrics ──────────────────────────────────────────────────────────

  private extractFunctionMetrics(root: SyntaxNode): FunctionInfo[] {
    const results: FunctionInfo[] = []

    this.walk(root, (node) => {
      if (!FUNCTION_NODES.has(node.type)) return

      const startLine = node.startPosition.row
      const endLine   = node.endPosition.row
      const lineCount = endLine - startLine + 1

      // Count parameters — look for formal_parameters or parameters child
      const paramNode = node.children.find(
        (c) => c.type === 'formal_parameters' || c.type === 'parameters'
      )
      const paramCount = paramNode
        ? paramNode.children.filter(
            (c) =>
              c.isNamed &&
              c.type !== ',' &&
              c.type !== '(' &&
              c.type !== ')'
          ).length
        : 0

      results.push({ lineCount, paramCount })
    })

    return results
  }

  // ── Class metrics ─────────────────────────────────────────────────────────────

  private extractClassMetrics(root: SyntaxNode): { count: number; godCount: number } {
    let count    = 0
    let godCount = 0

    this.walk(root, (node) => {
      if (!CLASS_NODES.has(node.type)) return

      count++

      // Count methods inside the class body
      const body = node.children.find(
        (c) => c.type === 'class_body'
      )
      if (body) {
        const methodCount = body.children.filter(
          (c) => c.type === 'method_definition' || c.type === 'public_field_definition'
        ).length
        if (methodCount > GOD_CLASS_METHOD_COUNT) godCount++
      }
    })

    return { count, godCount }
  }

  // ── Generic helpers ───────────────────────────────────────────────────────────

  /** Count all nodes of a given type in the subtree. */
  private countNodeType(root: SyntaxNode, type: string): number {
    let count = 0
    this.walk(root, (node) => { if (node.type === type) count++ })
    return count
  }

  /**
   * Iterative DFS walk of all named nodes.
   * Iterative (not recursive) to avoid stack overflow on very large files.
   */
  private walk(root: SyntaxNode, visitor: (node: SyntaxNode) => void): void {
    const stack: SyntaxNode[] = [root]
    while (stack.length > 0) {
      const node = stack.pop()!
      visitor(node)
      // Push children in reverse order so left-to-right traversal
      for (let i = node.childCount - 1; i >= 0; i--) {
        const child = node.child(i)
        if (child?.isNamed) stack.push(child)
      }
    }
  }

  /** Safe empty metrics — returned on tree parse failure. */
  private emptyMetrics(): ASTMetrics {
    return {
      cyclomaticComplexity: 1,
      maxNestingDepth:      0,
      avgNestingDepth:      0,
      functionCount:        0,
      longFunctionCount:    0,
      godFunctionCount:     0,
      maxParameterCount:    0,
      avgParameterCount:    0,
      classCount:           0,
      godClassCount:        0,
      returnCount:          0,
    }
  }
}

// ── Singleton ──────────────────────────────────────────────────────────────────

let instance: ASTMetricsExtractor | null = null

export function getASTMetricsExtractor(): ASTMetricsExtractor {
  if (!instance) instance = new ASTMetricsExtractor()
  return instance
}
