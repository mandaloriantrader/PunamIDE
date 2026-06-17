/**
 * ImportExtractor.ts — Phase 4
 *
 * Extracts import and export relationships from a Tree-sitter AST.
 * Pure and synchronous — takes a Tree, returns ImportExportMap.
 * No I/O, no async, no side effects.
 *
 * Design:
 *  - Separate from ASTMetricsExtractor (different concern, different consumer)
 *  - Called by the worker during the same Tree-sitter parse pass
 *  - Resolves relative import specifiers to absolute project paths
 *  - Handles all TS/JS import/export syntax forms
 *
 * Import forms handled:
 *   import x from './foo'
 *   import { x } from './foo'
 *   import * as x from './foo'
 *   import './foo'                      (side-effect only)
 *   export { x } from './foo'           (re-export)
 *   export * from './foo'               (re-export all)
 *   export * as ns from './foo'
 *   const x = require('./foo')
 *   const x = await import('./foo')     (dynamic import)
 *
 * Non-relative imports (node_modules) are recorded as external deps,
 * not as intra-workspace edges. They are used for coupling analysis
 * (high external dep count = potential problem) but not for the cycle
 * detector (cycles only exist in workspace-local code).
 *
 * Export forms handled:
 *   export const / function / class / interface / type / enum
 *   export default
 *   export { x }
 *   export { x } from './foo'
 *
 * Phase 5 hook: unusedExports field is populated here as the full set
 * of named exports. DeadCodeAnalyzer (Phase 5) will cross-reference
 * against the import graph to flag exports with no importers.
 */

import type { SyntaxNode, Tree } from 'web-tree-sitter'

// ── Types ──────────────────────────────────────────────────────────────────────

/** A single resolved import edge from one file to another. */
export interface ImportEdge {
  /** Absolute path of the importing file. */
  fromFile: string
  /** Raw specifier string as written in source (e.g. '../utils/hash'). */
  rawSpecifier: string
  /** Resolved absolute path — null for external (node_modules) deps. */
  resolvedPath: string | null
  /** Whether this is an external (node_modules) dependency. */
  isExternal: boolean
  /** Import kind — used for dead code analysis in Phase 5. */
  kind: 'static' | 'dynamic' | 'require' | 'reexport'
}

/** A named export from a file. */
export interface ExportEntry {
  name: string                    // exported symbol name ('default' for default exports)
  isDefault: boolean
  isReexport: boolean             // true for `export { x } from './foo'`
  reexportSource: string | null   // raw specifier of re-export source
}

/** All import/export data extracted from a single file. */
export interface FileImportExportMap {
  filePath: string
  imports: ImportEdge[]
  exports: ExportEntry[]
  /** External package names imported (e.g. 'react', 'lodash'). */
  externalDeps: string[]
}

// ── Node type sets ─────────────────────────────────────────────────────────────

// Tree-sitter node types for import/export statements
const IMPORT_NODES = new Set([
  'import_statement',
  'import_declaration',       // TS alias
])

const EXPORT_NODES = new Set([
  'export_statement',
  'export_declaration',       // TS alias
])

// ── Path resolution ────────────────────────────────────────────────────────────

const EXTENSIONS_TO_TRY = ['.ts', '.tsx', '.js', '.jsx', '/index.ts', '/index.tsx', '/index.js']

/**
 * Resolve a relative import specifier to an absolute path.
 *
 * Strategy:
 *  1. If specifier starts with '.' or '/', it's workspace-local — resolve it
 *  2. Otherwise it's external (node_modules) — return null
 *  3. Try adding extensions if the specifier has none
 *
 * The workspace root is needed to resolve project-absolute paths.
 * We approximate it from the importing file's path — good enough for
 * cycle detection (all we need is consistent path keys).
 */
export function resolveImportPath(
  fromFile: string,
  specifier: string,
): { resolvedPath: string | null; isExternal: boolean } {
  // External package — not a workspace file
  if (!specifier.startsWith('.') && !specifier.startsWith('/')) {
    return { resolvedPath: null, isExternal: true }
  }

  // Normalize separators
  const fromDir = fromFile.replace(/\\/g, '/').split('/').slice(0, -1).join('/')
  const raw     = specifier.replace(/\\/g, '/')

  // Join paths
  const joined = raw.startsWith('/')
    ? raw
    : joinPaths(fromDir, raw)

  const normalized = normalizePath(joined)

  // If specifier already has an extension, use as-is
  if (/\.[a-z]+$/i.test(normalized)) {
    return { resolvedPath: normalized, isExternal: false }
  }

  // Try adding common extensions — return the first that "looks valid"
  // (We can't stat files in the worker, so we just return the .ts version
  //  as the canonical key. The graph builder reconciles this.)
  return { resolvedPath: normalized + '.ts', isExternal: false }
}

function joinPaths(base: string, relative: string): string {
  if (!base) return relative
  return base + '/' + relative
}

function normalizePath(path: string): string {
  const parts = path.split('/')
  const result: string[] = []
  for (const part of parts) {
    if (part === '..') {
      result.pop()
    } else if (part !== '.') {
      result.push(part)
    }
  }
  return result.join('/')
}

// ── ImportExtractor ────────────────────────────────────────────────────────────

export class ImportExtractor {

  /**
   * Extract all import and export relationships from a parsed Tree.
   *
   * @param tree      Tree-sitter parse tree
   * @param filePath  Absolute path of the file — used for edge resolution
   */
  extract(tree: Tree, filePath: string): FileImportExportMap {
    const root = tree.rootNode
    if (!root) {
      return { filePath, imports: [], exports: [], externalDeps: [] }
    }

    const imports: ImportEdge[]     = []
    const exports: ExportEntry[]    = []
    const externalDeps = new Set<string>()

    this.walk(root, (node) => {
      // ── Static imports ──────────────────────────────────────────────────────
      if (IMPORT_NODES.has(node.type)) {
        const specifier = this.extractStringSpecifier(node)
        if (specifier) {
          const { resolvedPath, isExternal } = resolveImportPath(filePath, specifier)
          imports.push({
            fromFile: filePath,
            rawSpecifier: specifier,
            resolvedPath,
            isExternal,
            kind: 'static',
          })
          if (isExternal) externalDeps.add(this.packageName(specifier))
        }
      }

      // ── Export statements ───────────────────────────────────────────────────
      if (EXPORT_NODES.has(node.type)) {
        const extracted = this.extractExports(node, filePath)
        exports.push(...extracted.entries)
        if (extracted.reexportEdge) {
          imports.push(extracted.reexportEdge)
        }
      }

      // ── Dynamic import() ────────────────────────────────────────────────────
      if (node.type === 'call_expression') {
        const dynEdge = this.extractDynamicImport(node, filePath)
        if (dynEdge) {
          imports.push(dynEdge)
          if (dynEdge.isExternal) externalDeps.add(this.packageName(dynEdge.rawSpecifier))
        }
      }

      // ── require() ───────────────────────────────────────────────────────────
      if (node.type === 'call_expression') {
        const reqEdge = this.extractRequire(node, filePath)
        if (reqEdge) {
          imports.push(reqEdge)
          if (reqEdge.isExternal) externalDeps.add(this.packageName(reqEdge.rawSpecifier))
        }
      }
    })

    // Deduplicate edges — same fromFile+resolvedPath pair may appear multiple times
    // (e.g. `import type` and `import` from the same file)
    const seen = new Set<string>()
    const uniqueImports = imports.filter((edge) => {
      const key = `${edge.fromFile}→${edge.resolvedPath ?? edge.rawSpecifier}:${edge.kind}`
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })

    return {
      filePath,
      imports: uniqueImports,
      exports,
      externalDeps: [...externalDeps],
    }
  }

  // ── Import specifier extraction ───────────────────────────────────────────────

  /**
   * Find the string literal specifier in an import statement node.
   * Handles: import ... from 'specifier' and import 'specifier'
   */
  private extractStringSpecifier(node: SyntaxNode): string | null {
    // Look for a string node that is a direct child or grandchild
    // Tree-sitter represents 'specifier' as a string node
    for (const child of node.children) {
      if (child.type === 'string') {
        return this.unquote(child.text)
      }
      // Some grammars wrap in string_fragment
      if (child.type === 'string_fragment') {
        return child.text
      }
    }
    // Deeper search for `from "specifier"` form
    const fromClause = node.children.find(
      (c) => c.type === 'from' || c.text === 'from'
    )
    if (fromClause) {
      const next = node.children[node.children.indexOf(fromClause) + 1]
      if (next?.type === 'string') return this.unquote(next.text)
    }
    return null
  }

  // ── Export extraction ─────────────────────────────────────────────────────────

  private extractExports(
    node: SyntaxNode,
    filePath: string,
  ): { entries: ExportEntry[]; reexportEdge: ImportEdge | null } {
    const entries: ExportEntry[] = []
    let reexportEdge: ImportEdge | null = null

    // Check for re-export source: export { x } from './foo'
    const specifier = this.extractStringSpecifier(node)
    if (specifier) {
      const { resolvedPath, isExternal } = resolveImportPath(filePath, specifier)
      reexportEdge = {
        fromFile: filePath,
        rawSpecifier: specifier,
        resolvedPath,
        isExternal,
        kind: 'reexport',
      }
    }

    // export default
    if (node.children.some((c) => c.text === 'default')) {
      entries.push({ name: 'default', isDefault: true, isReexport: !!specifier, reexportSource: specifier })
      return { entries, reexportEdge }
    }

    // export * from './foo' or export * as ns from './foo'
    if (node.children.some((c) => c.text === '*')) {
      entries.push({ name: '*', isDefault: false, isReexport: true, reexportSource: specifier })
      return { entries, reexportEdge }
    }

    // export { x, y as z }
    const exportClause = node.children.find((c) => c.type === 'export_clause' || c.type === 'named_exports')
    if (exportClause) {
      for (const child of exportClause.children) {
        if (child.type === 'export_specifier' || child.type === 'shorthand_property_identifier') {
          const name = child.children.find((c) => c.isNamed)?.text ?? child.text
          if (name && name !== ',' && name !== '{' && name !== '}') {
            entries.push({ name, isDefault: false, isReexport: !!specifier, reexportSource: specifier })
          }
        }
      }
      return { entries, reexportEdge }
    }

    // export const / function / class / interface / type / enum
    const declaration = node.children.find((c) =>
      ['variable_declaration', 'lexical_declaration', 'function_declaration',
       'class_declaration', 'interface_declaration', 'type_alias_declaration',
       'enum_declaration', 'abstract_class_declaration'].includes(c.type)
    )
    if (declaration) {
      const name = this.extractDeclaredName(declaration)
      if (name) {
        entries.push({ name, isDefault: false, isReexport: false, reexportSource: null })
      }
    }

    return { entries, reexportEdge }
  }

  private extractDeclaredName(node: SyntaxNode): string | null {
    // For variable/lexical declarations: const foo = ...
    const declarator = node.children.find((c) =>
      c.type === 'variable_declarator' || c.type === 'lexical_binding'
    )
    if (declarator) {
      const id = declarator.children.find((c) => c.type === 'identifier')
      return id?.text ?? null
    }
    // For function/class/interface: function foo / class Foo
    const id = node.children.find((c) => c.type === 'identifier' || c.type === 'type_identifier')
    return id?.text ?? null
  }

  // ── Dynamic import ────────────────────────────────────────────────────────────

  private extractDynamicImport(node: SyntaxNode, filePath: string): ImportEdge | null {
    // import('specifier') — function name is 'import'
    const fn = node.children[0]
    if (!fn || fn.text !== 'import') return null

    const args = node.children.find((c) => c.type === 'arguments')
    if (!args) return null

    const strArg = args.children.find((c) => c.type === 'string')
    if (!strArg) return null

    const specifier = this.unquote(strArg.text)
    const { resolvedPath, isExternal } = resolveImportPath(filePath, specifier)

    return { fromFile: filePath, rawSpecifier: specifier, resolvedPath, isExternal, kind: 'dynamic' }
  }

  // ── require() ────────────────────────────────────────────────────────────────

  private extractRequire(node: SyntaxNode, filePath: string): ImportEdge | null {
    const fn = node.children[0]
    if (!fn || fn.text !== 'require') return null

    const args = node.children.find((c) => c.type === 'arguments')
    if (!args) return null

    const strArg = args.children.find((c) => c.type === 'string')
    if (!strArg) return null

    const specifier = this.unquote(strArg.text)
    const { resolvedPath, isExternal } = resolveImportPath(filePath, specifier)

    return { fromFile: filePath, rawSpecifier: specifier, resolvedPath, isExternal, kind: 'require' }
  }

  // ── Utilities ─────────────────────────────────────────────────────────────────

  /** Strip surrounding quotes from a string literal. */
  private unquote(text: string): string {
    return text.replace(/^['"`]|['"`]$/g, '')
  }

  /** Extract the package name from an external specifier (strip subpath). */
  private packageName(specifier: string): string {
    // @scope/pkg/subpath → @scope/pkg
    if (specifier.startsWith('@')) {
      return specifier.split('/').slice(0, 2).join('/')
    }
    // pkg/subpath → pkg
    return specifier.split('/')[0]
  }

  /** Iterative DFS — same pattern as ASTMetricsExtractor for consistency. */
  private walk(root: SyntaxNode, visitor: (node: SyntaxNode) => void): void {
    const stack: SyntaxNode[] = [root]
    while (stack.length > 0) {
      const node = stack.pop()!
      visitor(node)
      for (let i = node.childCount - 1; i >= 0; i--) {
        const child = node.child(i)
        if (child?.isNamed) stack.push(child)
      }
    }
  }
}

// ── Singleton ──────────────────────────────────────────────────────────────────

let instance: ImportExtractor | null = null

export function getImportExtractor(): ImportExtractor {
  if (!instance) instance = new ImportExtractor()
  return instance
}
