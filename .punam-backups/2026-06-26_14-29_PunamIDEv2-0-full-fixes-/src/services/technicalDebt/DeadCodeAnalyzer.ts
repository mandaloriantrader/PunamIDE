/**
 * DeadCodeAnalyzer.ts — Phase 5
 *
 * Detects unused code by cross-referencing the dependency graph's
 * export map against all imports across the workspace.
 *
 * Detects:
 *  - Unused exports (exported but never imported anywhere)
 *  - Unused imports (imported but never referenced in the file)
 *  - Unused declarations (not exported, not referenced locally)
 *
 * Design principles:
 *  - Never auto-deletes code — only reports "Safe Cleanup Candidates"
 *  - Conservative: if uncertain, does NOT flag
 *  - Skips: entry points, test files, config files, barrel re-export files
 *  - Requires Phase 4 DependencyGraph as input
 *  - Pure analysis — no I/O, no side effects
 *
 * Usage:
 *   const analyzer = getDeadCodeAnalyzer();
 *   const report = await analyzer.analyze(dependencyGraph, fileContents);
 */

import type { DependencyGraph, FileNode } from './DependencyGraphEngine'
import type { Node as SyntaxNode } from 'web-tree-sitter'
import { getASTEngine, extensionToLanguage } from './ASTEngine'

// ── Types ──────────────────────────────────────────────────────────────────────

export interface UnusedExport {
  filePath: string
  exportName: string
  line: number
  confidence: 'high' | 'medium'
  reason: string
}

export interface UnusedImport {
  filePath: string
  importedName: string
  fromModule: string
  line: number
  confidence: 'high' | 'medium'
}

export interface UnusedDeclaration {
  filePath: string
  name: string
  kind: 'function' | 'class' | 'variable' | 'type'
  line: number
  confidence: 'high' | 'medium'
  reason: string
}

export interface DeadCodeReport {
  unusedExports: UnusedExport[]
  unusedImports: UnusedImport[]
  unusedDeclarations: UnusedDeclaration[]
  estimatedDeadLines: number
  worstFiles: { filePath: string; deadItems: number }[]
  stats: DeadCodeStats
}

export interface DeadCodeStats {
  totalExportsAnalyzed: number
  unusedExportCount: number
  totalImportsAnalyzed: number
  unusedImportCount: number
  unusedDeclarationCount: number
  filesAnalyzed: number
  filesWithDeadCode: number
}

// ── Skip patterns ──────────────────────────────────────────────────────────────

const ENTRY_POINTS = [/\bmain\.[jt]sx?$/, /\bindex\.[jt]sx?$/, /\bapp\.[jt]sx?$/i, /\.config\.[jt]s$/, /\.d\.ts$/, /vite\.config/, /eslint/]
const TEST_FILES = [/\.test\.[jt]sx?$/, /\.spec\.[jt]sx?$/, /__tests__/]
const FRAMEWORK_EXPORTS = new Set(['default', 'getStaticProps', 'getServerSideProps', 'metadata', 'loader', 'action', 'meta'])

// ── Dead Code Analyzer ─────────────────────────────────────────────────────────

export class DeadCodeAnalyzer {

  async analyze(graph: DependencyGraph, files: Record<string, string>): Promise<DeadCodeReport> {
    const unusedExports = this.findUnusedExports(graph)
    const unusedImports = await this.findUnusedImports(graph, files)
    const unusedDeclarations = await this.findUnusedDeclarations(graph, files)

    let totalExports = 0, totalImports = 0
    for (const node of graph.nodes.values()) {
      totalExports += node.exports.length
      totalImports += node.imports.length
    }

    const filesWithDead = new Map<string, number>()
    for (const item of [...unusedExports, ...unusedImports, ...unusedDeclarations]) {
      filesWithDead.set(item.filePath, (filesWithDead.get(item.filePath) ?? 0) + 1)
    }

    return {
      unusedExports,
      unusedImports,
      unusedDeclarations,
      estimatedDeadLines: unusedExports.length * 8 + unusedImports.length + unusedDeclarations.length * 12,
      worstFiles: [...filesWithDead.entries()]
        .map(([filePath, deadItems]) => ({ filePath, deadItems }))
        .sort((a, b) => b.deadItems - a.deadItems)
        .slice(0, 10),
      stats: {
        totalExportsAnalyzed: totalExports,
        unusedExportCount: unusedExports.length,
        totalImportsAnalyzed: totalImports,
        unusedImportCount: unusedImports.length,
        unusedDeclarationCount: unusedDeclarations.length,
        filesAnalyzed: graph.nodes.size,
        filesWithDeadCode: filesWithDead.size,
      },
    }
  }

  // ── Unused exports ───────────────────────────────────────────────────────────

  private findUnusedExports(graph: DependencyGraph): UnusedExport[] {
    const usedExports = new Set<string>()

    for (const node of graph.nodes.values()) {
      for (const imp of node.imports) {
        if (!imp.resolvedPath) continue
        for (const name of imp.importedNames) {
          if (name === '*') {
            const target = graph.nodes.get(imp.resolvedPath)
            if (target) for (const exp of target.exports) usedExports.add(`${imp.resolvedPath}::${exp.name}`)
          } else {
            usedExports.add(`${imp.resolvedPath}::${name}`)
          }
        }
      }
    }

    const unused: UnusedExport[] = []
    for (const [filePath, node] of graph.nodes) {
      if (this.isEntryPoint(filePath) || this.isTestFile(filePath) || this.isBarrelFile(node)) continue

      for (const exp of node.exports) {
        if (FRAMEWORK_EXPORTS.has(exp.name) || exp.isReExport) continue
        if (!usedExports.has(`${filePath}::${exp.name}`)) {
          unused.push({
            filePath, exportName: exp.name, line: exp.line,
            confidence: node.dependedBy.length === 0 ? 'high' : 'medium',
            reason: node.dependedBy.length === 0
              ? 'File has no importers — export is unreachable'
              : `Export '${exp.name}' is not imported by any project file`,
          })
        }
      }
    }
    return unused
  }

  // ── Unused imports ───────────────────────────────────────────────────────────

  private async findUnusedImports(graph: DependencyGraph, files: Record<string, string>): Promise<UnusedImport[]> {
    const unused: UnusedImport[] = []
    const engine = getASTEngine()

    for (const [filePath, node] of graph.nodes) {
      if (this.isTestFile(filePath)) continue
      const content = files[filePath]
      if (!content) continue
      const language = extensionToLanguage(filePath)
      if (!language) continue
      const tree = await engine.parse(content, language)
      if (!tree) continue

      const usedIds = this.collectUsedIdentifiers(tree.rootNode)

      for (const imp of node.imports) {
        if (imp.importedNames.length === 0 || imp.importedNames[0] === '*') continue
        for (const name of imp.importedNames) {
          if (name === 'default' || name === '*') continue
          if (!usedIds.has(name)) {
            unused.push({ filePath, importedName: name, fromModule: imp.rawSpecifier, line: imp.line, confidence: 'high' })
          }
        }
      }
    }
    return unused
  }

  // ── Unused declarations ──────────────────────────────────────────────────────

  private async findUnusedDeclarations(graph: DependencyGraph, files: Record<string, string>): Promise<UnusedDeclaration[]> {
    const unused: UnusedDeclaration[] = []
    const engine = getASTEngine()

    for (const [filePath, node] of graph.nodes) {
      if (this.isTestFile(filePath)) continue
      const content = files[filePath]
      if (!content) continue
      const language = extensionToLanguage(filePath)
      if (!language) continue
      const tree = await engine.parse(content, language)
      if (!tree) continue

      const exportedNames = new Set(node.exports.map(e => e.name))
      const declarations = this.collectDeclarations(tree.rootNode)
      const usedIds = this.collectUsedIdentifiers(tree.rootNode)

      for (const decl of declarations) {
        if (exportedNames.has(decl.name)) continue
        if (usedIds.has(decl.name) && this.countUsages(tree.rootNode, decl.name) > 1) continue
        if (this.isConventionUsed(decl.name)) continue

        unused.push({
          filePath, name: decl.name, kind: decl.kind, line: decl.line, confidence: 'medium',
          reason: `'${decl.name}' is declared but never referenced or exported`,
        })
      }
    }
    return unused
  }

  // ── AST helpers ──────────────────────────────────────────────────────────────

  private collectUsedIdentifiers(root: SyntaxNode): Set<string> {
    const ids = new Set<string>()
    this.walk(root, (node) => {
      if (node.type !== 'identifier' && node.type !== 'type_identifier') return
      let parent = node.parent
      while (parent) {
        if (parent.type === 'import_statement' || parent.type === 'import_specifier') return
        if (['function_declaration', 'class_declaration', 'variable_declarator'].includes(parent.type)) {
          const nameChild = parent.children.find(c => c.type === 'identifier' || c.type === 'type_identifier')
          if (nameChild === node) return
          break
        }
        parent = parent.parent
      }
      ids.add(node.text)
    })
    return ids
  }

  private collectDeclarations(root: SyntaxNode): { name: string; kind: UnusedDeclaration['kind']; line: number }[] {
    const decls: { name: string; kind: UnusedDeclaration['kind']; line: number }[] = []
    for (let i = 0; i < root.childCount; i++) {
      const child = root.child(i)
      if (!child?.isNamed || child.type === 'export_statement') continue

      if (child.type === 'function_declaration') {
        const name = child.children.find(c => c.type === 'identifier')
        if (name) decls.push({ name: name.text, kind: 'function', line: child.startPosition.row + 1 })
      }
      if (child.type === 'class_declaration') {
        const name = child.children.find(c => c.type === 'identifier')
        if (name) decls.push({ name: name.text, kind: 'class', line: child.startPosition.row + 1 })
      }
      if (child.type === 'lexical_declaration' || child.type === 'variable_declaration') {
        for (const declarator of child.children) {
          if (declarator.type === 'variable_declarator') {
            const name = declarator.children.find(c => c.type === 'identifier')
            if (name) {
              const hasFunc = declarator.children.some(c => c.type === 'arrow_function' || c.type === 'function_expression')
              decls.push({ name: name.text, kind: hasFunc ? 'function' : 'variable', line: child.startPosition.row + 1 })
            }
          }
        }
      }
      if (child.type === 'type_alias_declaration' || child.type === 'interface_declaration') {
        const name = child.children.find(c => c.type === 'type_identifier' || c.type === 'identifier')
        if (name) decls.push({ name: name.text, kind: 'type', line: child.startPosition.row + 1 })
      }
    }
    return decls
  }

  private countUsages(root: SyntaxNode, name: string): number {
    let count = 0
    this.walk(root, (node) => {
      if ((node.type === 'identifier' || node.type === 'type_identifier') && node.text === name) count++
    })
    return count
  }

  // ── Classification ───────────────────────────────────────────────────────────

  private isEntryPoint(fp: string): boolean { return ENTRY_POINTS.some(p => p.test(fp)) }
  private isTestFile(fp: string): boolean { return TEST_FILES.some(p => p.test(fp)) }
  private isBarrelFile(node: FileNode): boolean {
    if (node.exports.length === 0) return false
    return node.exports.filter(e => e.isReExport).length / node.exports.length > 0.7
  }
  private isConventionUsed(name: string): boolean {
    return /^use[A-Z]/.test(name) || /^handle[A-Z]/.test(name) || name.startsWith('_')
  }

  private walk(root: SyntaxNode, visitor: (node: SyntaxNode) => void): void {
    const stack: SyntaxNode[] = [root]
    while (stack.length > 0) {
      const node = stack.pop()!
      visitor(node)
      for (let i = node.childCount - 1; i >= 0; i--) {
        const child = node.child(i)
        if (child) stack.push(child)
      }
    }
  }
}

// ── Singleton ──────────────────────────────────────────────────────────────────

let instance: DeadCodeAnalyzer | null = null
export function getDeadCodeAnalyzer(): DeadCodeAnalyzer {
  if (!instance) instance = new DeadCodeAnalyzer()
  return instance
}
