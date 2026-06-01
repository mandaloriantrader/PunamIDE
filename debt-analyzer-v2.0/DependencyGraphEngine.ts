/**
 * DependencyGraphEngine.ts — Phase 4
 *
 * Builds a workspace-level dependency graph from AST-parsed import/export
 * statements. Detects circular dependencies, hub files, and computes
 * per-module coupling scores.
 *
 * Architecture:
 *   File contents → ASTEngine.parse() → extractImports/extractExports
 *   → build adjacency graph → run analyses (cycles, hubs, coupling)
 *
 * Design principles:
 *  - No I/O — receives pre-read file contents (same pattern as worker)
 *  - Language-aware import extraction (TS/JS for now)
 *  - Handles: import/export statements, re-exports, dynamic imports
 *  - Does NOT resolve node_modules — only tracks project-internal deps
 *  - Relative path resolution uses simple heuristic (not full TS resolver)
 *
 * Usage:
 *   const engine = getDependencyGraphEngine();
 *   const graph = await engine.buildGraph(fileContents, projectRoot);
 *   const analysis = engine.analyze(graph);
 */

import type { Tree, SyntaxNode } from 'web-tree-sitter'
import { getASTEngine, extensionToLanguage } from './ASTEngine'

// ── Types ──────────────────────────────────────────────────────────────────────

export interface ImportInfo {
  resolvedPath: string | null
  rawSpecifier: string
  importedNames: string[]
  isDynamic: boolean
  line: number
}

export interface ExportInfo {
  name: string
  isReExport: boolean
  reExportSource: string | null
  line: number
}

export interface FileNode {
  filePath: string
  imports: ImportInfo[]
  exports: ExportInfo[]
  dependsOn: string[]
  dependedBy: string[]
}

export interface DependencyGraph {
  nodes: Map<string, FileNode>
  projectRoot: string
}

export interface CircularDependency {
  cycle: string[]
  length: number
}

export interface HubFile {
  filePath: string
  inDegree: number
  outDegree: number
  couplingScore: number
}

export interface GraphStats {
  totalFiles: number
  totalEdges: number
  circularCount: number
  hubCount: number
  avgInDegree: number
  avgOutDegree: number
  maxInDegree: number
  maxOutDegree: number
}

export interface DependencyAnalysis {
  graph: DependencyGraph
  circularDependencies: CircularDependency[]
  hubFiles: HubFile[]
  couplingScores: Map<string, number>
  moduleCoupling: Map<string, number>
  stats: GraphStats
}

// ── Import/Export extraction from AST ──────────────────────────────────────────

function extractImports(root: SyntaxNode): ImportInfo[] {
  const imports: ImportInfo[] = []

  walkNamed(root, (node) => {
    if (node.type === 'import_statement') {
      const source = findChildByType(node, 'string')
      if (!source) return
      imports.push({
        resolvedPath: null,
        rawSpecifier: stripQuotes(source.text),
        importedNames: extractImportedNames(node),
        isDynamic: false,
        line: node.startPosition.row + 1,
      })
    }

    if (node.type === 'call_expression') {
      const fn = node.child(0)
      if (fn?.type === 'import') {
        const args = findChildByType(node, 'arguments')
        const firstArg = args?.children.find(c => c.type === 'string')
        if (firstArg) {
          imports.push({
            resolvedPath: null,
            rawSpecifier: stripQuotes(firstArg.text),
            importedNames: ['*'],
            isDynamic: true,
            line: node.startPosition.row + 1,
          })
        }
      }
      if (fn?.type === 'identifier' && fn.text === 'require') {
        const args = findChildByType(node, 'arguments')
        const firstArg = args?.children.find(c => c.type === 'string')
        if (firstArg) {
          imports.push({
            resolvedPath: null,
            rawSpecifier: stripQuotes(firstArg.text),
            importedNames: ['*'],
            isDynamic: false,
            line: node.startPosition.row + 1,
          })
        }
      }
    }
  })

  return imports
}

function extractImportedNames(importNode: SyntaxNode): string[] {
  const names: string[] = []
  walkNamed(importNode, (child) => {
    if (child.type === 'identifier' && child.parent?.type === 'import_clause') names.push('default')
    if (child.type === 'import_specifier') {
      const name = child.children.find(c => c.type === 'identifier')
      if (name) names.push(name.text)
    }
    if (child.type === 'namespace_import') names.push('*')
  })
  return names.length > 0 ? names : ['*']
}

function extractExports(root: SyntaxNode): ExportInfo[] {
  const exports: ExportInfo[] = []

  walkNamed(root, (node) => {
    if (node.type !== 'export_statement') return
    const isDefault = node.children.some(c => c.type === 'default')
    const line = node.startPosition.row + 1
    const source = findChildByType(node, 'string')
    const isReExport = source !== null

    if (isDefault) {
      exports.push({ name: 'default', isReExport, reExportSource: isReExport ? stripQuotes(source!.text) : null, line })
    } else {
      const exportClause = node.children.find(c => c.type === 'export_clause')
      if (exportClause) {
        walkNamed(exportClause, (spec) => {
          if (spec.type === 'export_specifier') {
            const name = spec.children.find(c => c.type === 'identifier')
            if (name) exports.push({ name: name.text, isReExport, reExportSource: isReExport ? stripQuotes(source!.text) : null, line })
          }
        })
      } else {
        const declaration = node.children.find(c =>
          ['function_declaration', 'class_declaration', 'lexical_declaration',
           'variable_declaration', 'type_alias_declaration', 'interface_declaration',
           'enum_declaration'].includes(c.type)
        )
        if (declaration) {
          const nameNode = declaration.children.find(c => c.type === 'identifier' || c.type === 'type_identifier')
          if (nameNode) exports.push({ name: nameNode.text, isReExport: false, reExportSource: null, line })
        }
      }
    }
  })

  return exports
}

// ── Path resolution ────────────────────────────────────────────────────────────

function resolveImportPath(specifier: string, importingFilePath: string, allFilePaths: Set<string>): string | null {
  if (!specifier.startsWith('.') && !specifier.startsWith('/')) return null
  const importerDir = importingFilePath.replace(/\\/g, '/').split('/').slice(0, -1).join('/')
  const resolved = normalizePath(joinPath(importerDir, specifier))

  const extensions = ['', '.ts', '.tsx', '.js', '.jsx']
  const indexFiles = ['/index.ts', '/index.tsx', '/index.js', '/index.jsx']

  for (const ext of extensions) {
    if (allFilePaths.has(resolved + ext)) return resolved + ext
  }
  for (const idx of indexFiles) {
    if (allFilePaths.has(resolved + idx)) return resolved + idx
  }
  return null
}

// ── Graph Engine ───────────────────────────────────────────────────────────────

class DependencyGraphEngine {

  async buildGraph(files: Record<string, string>, projectRoot: string): Promise<DependencyGraph> {
    const engine = getASTEngine()
    const allPaths = new Set(Object.keys(files).map(normalizePath))
    const nodes = new Map<string, FileNode>()

    for (const [filePath, content] of Object.entries(files)) {
      const np = normalizePath(filePath)
      const language = extensionToLanguage(filePath)
      let imports: ImportInfo[] = []
      let exports: ExportInfo[] = []

      if (language) {
        const tree = await engine.parse(content, language)
        if (tree) {
          imports = extractImports(tree.rootNode)
          exports = extractExports(tree.rootNode)
        }
      }
      nodes.set(np, { filePath: np, imports, exports, dependsOn: [], dependedBy: [] })
    }

    for (const [filePath, node] of nodes) {
      for (const imp of node.imports) {
        const resolved = resolveImportPath(imp.rawSpecifier, filePath, allPaths)
        imp.resolvedPath = resolved
        if (resolved && nodes.has(resolved)) {
          node.dependsOn.push(resolved)
          nodes.get(resolved)!.dependedBy.push(filePath)
        }
      }
      node.dependsOn = [...new Set(node.dependsOn)]
    }
    for (const node of nodes.values()) node.dependedBy = [...new Set(node.dependedBy)]

    return { nodes, projectRoot }
  }

  analyze(graph: DependencyGraph): DependencyAnalysis {
    const circularDependencies = this.detectCycles(graph)
    const hubFiles = this.detectHubs(graph)
    const couplingScores = this.computeCouplingScores(graph)
    const moduleCoupling = this.computeModuleCoupling(couplingScores)
    const stats = this.computeStats(graph, circularDependencies, hubFiles)
    return { graph, circularDependencies, hubFiles, couplingScores, moduleCoupling, stats }
  }

  private detectCycles(graph: DependencyGraph): CircularDependency[] {
    const cycles: CircularDependency[] = []
    const visited = new Set<string>()
    const inStack = new Set<string>()
    const pathStack: string[] = []

    const dfs = (node: string) => {
      if (inStack.has(node)) {
        const cycleStart = pathStack.indexOf(node)
        if (cycleStart !== -1) {
          const cycle = [...pathStack.slice(cycleStart), node]
          cycles.push({ cycle, length: cycle.length - 1 })
        }
        return
      }
      if (visited.has(node)) return
      visited.add(node)
      inStack.add(node)
      pathStack.push(node)

      const fileNode = graph.nodes.get(node)
      if (fileNode) for (const dep of fileNode.dependsOn) dfs(dep)

      pathStack.pop()
      inStack.delete(node)
    }

    for (const filePath of graph.nodes.keys()) {
      if (!visited.has(filePath)) dfs(filePath)
    }
    return this.deduplicateCycles(cycles)
  }

  private deduplicateCycles(cycles: CircularDependency[]): CircularDependency[] {
    const seen = new Set<string>()
    const unique: CircularDependency[] = []
    for (const { cycle, length } of cycles) {
      const withoutLast = cycle.slice(0, -1)
      const minIdx = withoutLast.indexOf(withoutLast.reduce((min, s) => s < min ? s : min))
      const normalized = [...withoutLast.slice(minIdx), ...withoutLast.slice(0, minIdx)].join(' → ')
      if (!seen.has(normalized)) { seen.add(normalized); unique.push({ cycle, length }) }
    }
    return unique
  }

  private detectHubs(graph: DependencyGraph): HubFile[] {
    const entries = [...graph.nodes.entries()].map(([fp, node]) => ({
      filePath: fp, inDegree: node.dependedBy.length, outDegree: node.dependsOn.length,
    }))
    if (entries.length === 0) return []

    const mean = entries.reduce((s, d) => s + d.inDegree, 0) / entries.length
    const variance = entries.reduce((s, d) => s + (d.inDegree - mean) ** 2, 0) / entries.length
    const threshold = Math.max(mean + 2 * Math.sqrt(variance), 10)

    return entries
      .filter(d => d.inDegree >= threshold)
      .map(d => ({
        ...d,
        couplingScore: Math.min(100, Math.round((d.inDegree / Math.max(1, graph.nodes.size)) * 200)),
      }))
      .sort((a, b) => b.inDegree - a.inDegree)
  }

  private computeCouplingScores(graph: DependencyGraph): Map<string, number> {
    const scores = new Map<string, number>()
    for (const [filePath, node] of graph.nodes) {
      const raw = node.dependedBy.length * 2 + node.dependsOn.length
      scores.set(filePath, Math.min(100, Math.round((raw / Math.max(1, graph.nodes.size * 3)) * 300)))
    }
    return scores
  }

  private computeModuleCoupling(fileCoupling: Map<string, number>): Map<string, number> {
    const moduleScores = new Map<string, number[]>()
    for (const [filePath, score] of fileCoupling) {
      const module = this.extractModule(filePath)
      const existing = moduleScores.get(module) ?? []
      existing.push(score)
      moduleScores.set(module, existing)
    }
    const result = new Map<string, number>()
    for (const [module, scores] of moduleScores) {
      result.set(module, Math.round(scores.reduce((s, v) => s + v, 0) / scores.length))
    }
    return result
  }

  private computeStats(graph: DependencyGraph, cycles: CircularDependency[], hubs: HubFile[]): GraphStats {
    let totalEdges = 0, maxIn = 0, maxOut = 0, totalIn = 0, totalOut = 0
    for (const node of graph.nodes.values()) {
      totalEdges += node.dependsOn.length
      totalIn += node.dependedBy.length
      totalOut += node.dependsOn.length
      maxIn = Math.max(maxIn, node.dependedBy.length)
      maxOut = Math.max(maxOut, node.dependsOn.length)
    }
    const n = graph.nodes.size
    return {
      totalFiles: n, totalEdges, circularCount: cycles.length, hubCount: hubs.length,
      avgInDegree: n > 0 ? Math.round((totalIn / n) * 10) / 10 : 0,
      avgOutDegree: n > 0 ? Math.round((totalOut / n) * 10) / 10 : 0,
      maxInDegree: maxIn, maxOutDegree: maxOut,
    }
  }

  private extractModule(filePath: string): string {
    const parts = filePath.replace(/\\/g, '/').split('/').filter(Boolean)
    const SKIP = new Set(['src', 'lib', 'app', 'packages'])
    let idx = 0
    while (idx < parts.length - 1 && SKIP.has(parts[idx])) idx++
    const remaining = parts.slice(idx, -1)
    if (remaining.length >= 2) return remaining.slice(0, 2).join('/')
    if (remaining.length === 1) return remaining[0]
    return 'root'
  }
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function walkNamed(root: SyntaxNode, visitor: (node: SyntaxNode) => void): void {
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

function findChildByType(node: SyntaxNode, type: string): SyntaxNode | null {
  for (let i = 0; i < node.childCount; i++) {
    if (node.child(i)?.type === type) return node.child(i)!
  }
  return null
}

function stripQuotes(text: string): string { return text.replace(/^['"`]|['"`]$/g, '') }
function normalizePath(p: string): string { return p.replace(/\\/g, '/').replace(/\/+/g, '/') }

function joinPath(dir: string, relative: string): string {
  const parts = dir.split('/').filter(Boolean)
  for (const part of relative.split('/').filter(Boolean)) {
    if (part === '..') parts.pop()
    else if (part !== '.') parts.push(part)
  }
  return parts.join('/')
}

// ── Singleton ──────────────────────────────────────────────────────────────────

let instance: DependencyGraphEngine | null = null
export function getDependencyGraphEngine(): DependencyGraphEngine {
  if (!instance) instance = new DependencyGraphEngine()
  return instance
}
