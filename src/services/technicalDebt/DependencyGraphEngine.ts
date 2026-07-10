/**
 * DependencyGraphEngine.ts — Phase 4
 *
 * Builds a workspace-level dependency graph from per-file ImportExportMaps.
 * The graph is the input to CircularDepDetector and CouplingAnalyzer.
 *
 * Graph model:
 *  - Nodes  = workspace files (absolute paths)
 *  - Edges  = directed import relationships (A → B means A imports B)
 *  - Only intra-workspace edges are in the main graph
 *  - External deps tracked separately on each node
 *
 * Path reconciliation:
 *  ImportExtractor resolves relative imports to paths ending in '.ts'.
 *  The actual file on disk may be '.tsx', '.js', or '/index.ts'.
 *  DependencyGraphEngine reconciles this by building a path alias map
 *  from the known file set and remapping edges before returning.
 *
 * Usage:
 *   const engine = getDependencyGraphEngine()
 *   const graph  = engine.build(importMaps, knownFilePaths)
 *   // graph is passed to CircularDepDetector and CouplingAnalyzer
 */

import type { ExportEntry, FileImportExportMap, ImportEdge } from './ImportExtractor'

// ── Types ──────────────────────────────────────────────────────────────────────

/** A node in the workspace dependency graph. */
export interface GraphNode {
  filePath: string
  /** Files this node imports (outgoing edges). */
  imports: string[]
  /** Import metadata extracted from source, used by dead-code analysis. */
  rawImports: ImportEdge[]
  /** Named exports extracted from source. */
  exports: ExportEntry[]
  /** Files that import this node (incoming edges = fan-in). */
  importedBy: string[]
  /** Compatibility alias for graph visualizations. */
  dependsOn: string[]
  /** Compatibility alias for older analyzers. */
  dependedBy: string[]
  /** External package names used by this file. */
  externalDeps: string[]
  /** Number of unique outgoing workspace edges (fan-out). */
  fanOut: number
  /** Number of unique incoming workspace edges (fan-in). */
  fanIn: number
}

/** The complete workspace dependency graph. */
export interface DependencyGraph {
  /** Map from absolute file path to its graph node. */
  nodes: Map<string, GraphNode>

  /** All directed edges as [from, to] pairs. */
  edges: [string, string][]

  /** Files that could not be resolved (broken imports). */
  unresolvedImports: { fromFile: string; rawSpecifier: string }[]

  /** Total number of workspace-local edges. */
  totalEdges: number
}

export type FileNode = GraphNode

export interface DependencyAnalysis {
  graph: DependencyGraph
  hubFiles: { filePath: string }[]
  circularDependencies: { cycle: string[] }[]
  couplingScores: Map<string, number>
}

// ── DependencyGraphEngine ──────────────────────────────────────────────────────

export class DependencyGraphEngine {

  /**
   * Build the workspace dependency graph.
   *
   * @param importMaps      Per-file import/export data from ImportExtractor
   * @param knownFilePaths  All files discovered in the workspace
   */
  build(
    importMaps: FileImportExportMap[],
    knownFilePaths: string[],
  ): DependencyGraph {
    // ── Step 1: build path alias map for reconciliation ──────────────────────
    const pathAliases = this.buildPathAliasMap(knownFilePaths)

    // ── Step 2: initialise all nodes ─────────────────────────────────────────
    const nodes = new Map<string, GraphNode>()
    for (const fp of knownFilePaths) {
      nodes.set(fp, {
        filePath:     fp,
        imports:      [],
        rawImports:   [],
        exports:      [],
        importedBy:   [],
        dependsOn:    [],
        dependedBy:   [],
        externalDeps: [],
        fanOut:       0,
        fanIn:        0,
      })
    }

    // ── Step 3: process import maps → add edges ───────────────────────────────
    const edges: [string, string][]   = []
    const unresolved: { fromFile: string; rawSpecifier: string }[] = []

    for (const map of importMaps) {
      const fromNode = nodes.get(map.filePath)
      if (!fromNode) continue

      fromNode.exports = map.exports

      // External deps
      fromNode.externalDeps = [...new Set([
        ...fromNode.externalDeps,
        ...map.externalDeps,
      ])]

      // Intra-workspace import edges
      for (const edge of map.imports) {
        fromNode.rawImports.push(edge)
        if (edge.isExternal || !edge.resolvedPath) continue

        // Reconcile path (extension guessing, index files, etc.)
        const canonical = this.reconcilePath(edge.resolvedPath, pathAliases)

        if (!canonical) {
          unresolved.push({ fromFile: map.filePath, rawSpecifier: edge.rawSpecifier })
          continue
        }

        // Skip self-imports
        if (canonical === map.filePath) continue

        // Add edge
        if (!fromNode.imports.includes(canonical)) {
          fromNode.imports.push(canonical)
          edges.push([map.filePath, canonical])
        }
        fromNode.rawImports[fromNode.rawImports.length - 1] = { ...edge, resolvedPath: canonical }

        // Add reverse edge on target
        let toNode = nodes.get(canonical)
        if (!toNode) {
          toNode = {
            filePath:     canonical,
            imports:      [],
            rawImports:   [],
            exports:      [],
            importedBy:   [],
            dependsOn:    [],
            dependedBy:   [],
            externalDeps: [],
            fanOut:       0,
            fanIn:        0,
          }
          nodes.set(canonical, toNode)
        }
        if (!toNode.importedBy.includes(map.filePath)) {
          toNode.importedBy.push(map.filePath)
        }
      }
    }

    // ── Step 4: compute fan-in / fan-out ──────────────────────────────────────
    for (const node of nodes.values()) {
      node.fanOut = node.imports.length
      node.fanIn  = node.importedBy.length
      node.dependsOn = node.imports
      node.dependedBy = node.importedBy
    }

    return {
      nodes,
      edges,
      unresolvedImports: unresolved,
      totalEdges: edges.length,
    }
  }

  // ── Path reconciliation ────────────────────────────────────────────────────

  private buildPathAliasMap(knownPaths: string[]): Map<string, string> {
    const map = new Map<string, string>()
    for (const fp of knownPaths) {
      map.set(fp, fp)

      const normalized = fp.replace(/\\/g, '/')

      const stripped = normalized.replace(/\.(ts|tsx|js|jsx|py|rs)$/, '')
      if (!map.has(stripped)) map.set(stripped, fp)

      if (normalized.endsWith('.ts')) {
        const tsx = normalized.replace(/\.ts$/, '.tsx')
        if (!map.has(tsx)) map.set(tsx, fp)
      }

      const indexMatch = normalized.match(/^(.+)\/index\.(ts|tsx|js|jsx)$/)
      if (indexMatch) {
        const dir = indexMatch[1]
        if (!map.has(dir))         map.set(dir, fp)
        if (!map.has(dir + '.ts')) map.set(dir + '.ts', fp)
      }

      // Python: __init__.py acts as directory index
      const initMatch = normalized.match(/^(.+)\/__init__\.py$/)
      if (initMatch) {
        const dir = initMatch[1]
        if (!map.has(dir))          map.set(dir, fp)
        if (!map.has(dir + '.py'))  map.set(dir + '.py', fp)
      }

      // Rust: mod.rs acts as directory index
      const modMatch = normalized.match(/^(.+)\/mod\.rs$/)
      if (modMatch) {
        const dir = modMatch[1]
        if (!map.has(dir))         map.set(dir, fp)
        if (!map.has(dir + '.rs')) map.set(dir + '.rs', fp)
      }
    }
    return map
  }

  private reconcilePath(
    extractedPath: string,
    pathAliases: Map<string, string>,
  ): string | null {
    const normalized = extractedPath.replace(/\\/g, '/')

    if (pathAliases.has(normalized)) return pathAliases.get(normalized)!

    const stripped = normalized.replace(/\.(ts|tsx|js|jsx|py|rs)$/, '')
    if (pathAliases.has(stripped)) return pathAliases.get(stripped)!

    for (const ext of ['.ts', '.tsx', '.js', '.jsx', '.py', '.rs']) {
      const candidate = stripped + ext
      if (pathAliases.has(candidate)) return pathAliases.get(candidate)!
    }

    for (const ext of ['.ts', '.tsx', '.js', '.jsx']) {
      const candidate = normalized.replace(/\.(ts|tsx|js|jsx|py|rs)$/, '') + '/index' + ext
      if (pathAliases.has(candidate)) return pathAliases.get(candidate)!
    }

    // Python: directory/__init__.py
    const pyInit = normalized.replace(/\.(py)$/, '') + '/__init__.py'
    if (pathAliases.has(pyInit)) return pathAliases.get(pyInit)!

    // Rust: directory/mod.rs
    const rsMod = normalized.replace(/\.(rs)$/, '') + '/mod.rs'
    if (pathAliases.has(rsMod)) return pathAliases.get(rsMod)!

    return null
  }
}

// ── Singleton ──────────────────────────────────────────────────────────────────

let instance: DependencyGraphEngine | null = null

export function getDependencyGraphEngine(): DependencyGraphEngine {
  if (!instance) instance = new DependencyGraphEngine()
  return instance
}
