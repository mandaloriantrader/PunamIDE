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

import type { Node as SyntaxNode, Tree } from 'web-tree-sitter'

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
  importedNames: string[]
  line: number
}

/** A named export from a file. */
export interface ExportEntry {
  name: string                    // exported symbol name ('default' for default exports)
  isDefault: boolean
  isReexport: boolean             // true for `export { x } from './foo'`
  reexportSource: string | null   // raw specifier of re-export source
  line: number
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

// Python import node types
const PYTHON_IMPORT_NODES = new Set([
  'import_statement',         // import os, import sys
  'import_from_statement',    // from os.path import join
])

// Rust import node types
const RUST_IMPORT_NODES = new Set([
  'use_declaration',          // use std::io::Read;
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
            importedNames: [],
            line: node.startPosition.row + 1,
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

      // ── Python imports ──────────────────────────────────────────────────────
      if (PYTHON_IMPORT_NODES.has(node.type) && !IMPORT_NODES.has(node.type)) {
        // import_from_statement: from x import y
        const pyEdge = this.extractPythonImport(node, filePath)
        if (pyEdge) {
          imports.push(pyEdge)
          if (pyEdge.isExternal) externalDeps.add(this.packageName(pyEdge.rawSpecifier))
        }
      }

      // Python import_statement with dotted_name (import os.path)
      if (node.type === 'import_statement' && node.children.some(c => c.type === 'dotted_name')) {
        const pyEdge = this.extractPythonBareImport(node, filePath)
        if (pyEdge) {
          imports.push(pyEdge)
          if (pyEdge.isExternal) externalDeps.add(this.packageName(pyEdge.rawSpecifier))
        }
      }

      // ── Rust use declarations ───────────────────────────────────────────────
      if (RUST_IMPORT_NODES.has(node.type)) {
        const rustEdge = this.extractRustUse(node, filePath)
        if (rustEdge) {
          imports.push(rustEdge)
          if (rustEdge.isExternal) externalDeps.add(this.packageName(rustEdge.rawSpecifier))
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
        importedNames: [],
        line: node.startPosition.row + 1,
      }
    }

    // export default
    if (node.children.some((c) => c.text === 'default')) {
      entries.push({ name: 'default', isDefault: true, isReexport: !!specifier, reexportSource: specifier, line: node.startPosition.row + 1 })
      return { entries, reexportEdge }
    }

    // export * from './foo' or export * as ns from './foo'
    if (node.children.some((c) => c.text === '*')) {
      entries.push({ name: '*', isDefault: false, isReexport: true, reexportSource: specifier, line: node.startPosition.row + 1 })
      return { entries, reexportEdge }
    }

    // export { x, y as z }
    const exportClause = node.children.find((c) => c.type === 'export_clause' || c.type === 'named_exports')
    if (exportClause) {
      for (const child of exportClause.children) {
        if (child.type === 'export_specifier' || child.type === 'shorthand_property_identifier') {
          const name = child.children.find((c) => c.isNamed)?.text ?? child.text
          if (name && name !== ',' && name !== '{' && name !== '}') {
            entries.push({ name, isDefault: false, isReexport: !!specifier, reexportSource: specifier, line: node.startPosition.row + 1 })
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
        entries.push({ name, isDefault: false, isReexport: false, reexportSource: null, line: node.startPosition.row + 1 })
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

    return { fromFile: filePath, rawSpecifier: specifier, resolvedPath, isExternal, kind: 'dynamic', importedNames: [], line: node.startPosition.row + 1 }
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

    return { fromFile: filePath, rawSpecifier: specifier, resolvedPath, isExternal, kind: 'require', importedNames: [], line: node.startPosition.row + 1 }
  }

  // ── Python import extraction ────────────────────────────────────────────────

  /**
   * Extract Python "from x import y" statements.
   * AST structure: import_from_statement → [from, dotted_name, import, ...]
   *
   * Resolution strategy:
   *  - Relative imports (from .foo import bar) → resolve relative to file
   *  - Absolute imports (from os.path import join) → external
   *  - Local project imports (from mypackage.utils import helper) → resolved
   *    as external since we can't reliably distinguish without project config
   */
  private extractPythonImport(node: SyntaxNode, filePath: string): ImportEdge | null {
    // Find the module name (dotted_name after 'from')
    const dottedName = node.children.find(c => c.type === 'dotted_name')
    const relativeImport = node.children.find(c => c.type === 'relative_import')

    let specifier: string

    if (relativeImport) {
      // from .foo import bar → relative
      // Get the dots and module name
      const dots = relativeImport.children.filter(c => c.type === 'import_prefix' || c.text === '.')
      const moduleName = relativeImport.children.find(c => c.type === 'dotted_name')
      const prefix = dots.length > 0 ? '.'.repeat(dots.length) : '.'
      specifier = moduleName ? `${prefix}${moduleName.text}` : prefix
    } else if (dottedName) {
      // from os.path import join → treat as external
      specifier = dottedName.text
    } else {
      return null
    }

    // Extract imported names
    const importedNames: string[] = []
    for (const child of node.children) {
      if (child.type === 'dotted_name' && child !== dottedName) {
        importedNames.push(child.text)
      }
      if (child.type === 'aliased_import') {
        const name = child.children.find(c => c.type === 'dotted_name' || c.type === 'identifier')
        if (name) importedNames.push(name.text)
      }
      if (child.type === 'identifier' && child.text !== 'from' && child.text !== 'import') {
        importedNames.push(child.text)
      }
    }

    // Determine if relative (workspace-local) or external
    const isRelative = specifier.startsWith('.')
    if (isRelative) {
      const pySpecifier = specifier.replace(/\./g, (m, offset) => {
        if (offset === 0) return './'
        return '/'
      }).replace(/^\.\/\/+/, './')
      const { resolvedPath, isExternal } = this.resolvePythonPath(filePath, pySpecifier)
      return {
        fromFile: filePath,
        rawSpecifier: specifier,
        resolvedPath,
        isExternal,
        kind: 'static',
        importedNames,
        line: node.startPosition.row + 1,
      }
    }

    // Absolute Python import → external
    return {
      fromFile: filePath,
      rawSpecifier: specifier,
      resolvedPath: null,
      isExternal: true,
      kind: 'static',
      importedNames,
      line: node.startPosition.row + 1,
    }
  }

  /**
   * Extract Python bare "import x" statements.
   * AST structure: import_statement → [import, dotted_name]
   */
  private extractPythonBareImport(node: SyntaxNode, filePath: string): ImportEdge | null {
    const dottedName = node.children.find(c => c.type === 'dotted_name')
    if (!dottedName) return null

    const specifier = dottedName.text

    // Bare imports are almost always external packages (import os, import sys)
    return {
      fromFile: filePath,
      rawSpecifier: specifier,
      resolvedPath: null,
      isExternal: true,
      kind: 'static',
      importedNames: [specifier.split('.')[0]],
      line: node.startPosition.row + 1,
    }
  }

  /**
   * Resolve a Python relative import path.
   * from .utils import foo → ./utils.py
   */
  private resolvePythonPath(
    fromFile: string,
    specifier: string,
  ): { resolvedPath: string | null; isExternal: boolean } {
    if (!specifier.startsWith('.')) {
      return { resolvedPath: null, isExternal: true }
    }

    const fromDir = fromFile.replace(/\\/g, '/').split('/').slice(0, -1).join('/')
    const modulePath = specifier.replace(/\\/g, '/')
    const joined = modulePath.startsWith('/')
      ? modulePath
      : joinPaths(fromDir, modulePath)
    const normalized = normalizePath(joined)

    // Python: try .py extension
    if (/\.[a-z]+$/i.test(normalized)) {
      return { resolvedPath: normalized, isExternal: false }
    }
    return { resolvedPath: normalized + '.py', isExternal: false }
  }

  // ── Rust use extraction ────────────────────────────────────────────────────

  /**
   * Extract Rust "use" declarations.
   * AST structure: use_declaration → [use, scoped_identifier | use_wildcard | ...]
   *
   * Resolution strategy:
   *  - use crate::module → workspace-local (resolve relative to crate root)
   *  - use super::sibling → workspace-local (resolve relative to parent)
   *  - use self::child → workspace-local (resolve relative to current)
   *  - use std::io → external (standard library or crate dependency)
   *  - use other_crate::foo → external
   */
  private extractRustUse(node: SyntaxNode, filePath: string): ImportEdge | null {
    // Get the path identifier — can be scoped_identifier, use_wildcard, scoped_use_list, etc.
    const pathNode = node.children.find(c =>
      c.type === 'scoped_identifier' ||
      c.type === 'scoped_use_list' ||
      c.type === 'use_wildcard' ||
      c.type === 'identifier' ||
      c.type === 'use_as_clause'
    )
    if (!pathNode) return null

    const fullPath = pathNode.text.replace(/;$/, '').trim()

    // Extract imported names from the path
    const importedNames: string[] = []
    const lastSegment = fullPath.split('::').pop()
    if (lastSegment && lastSegment !== '*' && !lastSegment.includes('{')) {
      importedNames.push(lastSegment)
    }

    // Determine if workspace-local
    const isCrate = fullPath.startsWith('crate::')
    const isSuper = fullPath.startsWith('super::')
    const isSelf  = fullPath.startsWith('self::')

    if (isCrate || isSuper || isSelf) {
      const resolvedPath = this.resolveRustPath(filePath, fullPath)
      return {
        fromFile: filePath,
        rawSpecifier: fullPath,
        resolvedPath,
        isExternal: false,
        kind: 'static',
        importedNames,
        line: node.startPosition.row + 1,
      }
    }

    // External crate
    const crateName = fullPath.split('::')[0]
    return {
      fromFile: filePath,
      rawSpecifier: fullPath,
      resolvedPath: null,
      isExternal: true,
      kind: 'static',
      importedNames,
      line: node.startPosition.row + 1,
    }
  }

  /**
   * Resolve Rust crate-relative, super-relative, or self-relative paths.
   *
   * use crate::utils::hash → /src/utils/hash.rs
   * use super::sibling → ../sibling.rs
   * use self::child → ./child.rs
   */
  private resolveRustPath(fromFile: string, usePath: string): string | null {
    const fromDir = fromFile.replace(/\\/g, '/').split('/').slice(0, -1).join('/')
    const segments = usePath.split('::')

    if (segments[0] === 'crate') {
      // Resolve relative to crate root (find src/ ancestor)
      const normalized = fromFile.replace(/\\/g, '/')
      const srcIdx = normalized.lastIndexOf('/src/')
      if (srcIdx === -1) return null
      const crateRoot = normalized.substring(0, srcIdx + 4) // includes /src/
      const modulePath = segments.slice(1).join('/')
      return normalizePath(crateRoot + modulePath) + '.rs'
    }

    if (segments[0] === 'super') {
      const parentDir = fromDir.split('/').slice(0, -1).join('/')
      const modulePath = segments.slice(1).join('/')
      return normalizePath(parentDir + '/' + modulePath) + '.rs'
    }

    if (segments[0] === 'self') {
      const modulePath = segments.slice(1).join('/')
      return normalizePath(fromDir + '/' + modulePath) + '.rs'
    }

    return null
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
