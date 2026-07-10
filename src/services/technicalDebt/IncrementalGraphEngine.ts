/**
 * IncrementalGraphEngine.ts — Fix #3
 *
 * Wraps DependencyGraphEngine with incremental rebuild capability.
 * On repeated scans, only rebuilds the graph for files whose import
 * maps actually changed — skipping unchanged files entirely.
 *
 * Strategy:
 *  - First run: full build (delegates to DependencyGraphEngine)
 *  - Subsequent runs: compare new import maps to previous snapshot
 *    - If <10% of files have different import maps → patch in-place
 *    - If ≥10% changed (or files added/removed) → full rebuild
 *
 * Detection of "changed":
 *  The worker already caches by SHA-256. If a file's content hasn't
 *  changed, its import map is identical. We fingerprint each file's
 *  import map by hashing its serialized import/export arrays. If the
 *  fingerprint differs, that file needs edge rebuilding.
 *
 * Usage:
 *   const engine = getIncrementalGraphEngine();
 *   const result = engine.buildIncremental(importMaps, knownFilePaths);
 *   // result.graph — DependencyGraph (same type as before)
 *   // result.changedFiles — files that were rebuilt
 *   // result.wasIncremental — true if patching was used
 *
 * The dashboard replaces getDependencyGraphEngine().build() with this.
 * All downstream consumers (CircularDepDetector, CouplingAnalyzer, etc.)
 * receive the same DependencyGraph type — zero changes needed there.
 */

import { DependencyGraphEngine, getDependencyGraphEngine } from './DependencyGraphEngine'
import type { DependencyGraph, GraphNode } from './DependencyGraphEngine'
import type { FileImportExportMap } from './ImportExtractor'

// ── Types ──────────────────────────────────────────────────────────────────────

export interface IncrementalBuildResult {
  graph: DependencyGraph
  changedFiles: string[]
  wasIncremental: boolean
  stats: {
    totalFiles: number
    unchangedFiles: number
    changedFiles: number
    addedFiles: number
    removedFiles: number
    rebuildReason: 'first-run' | 'incremental' | 'threshold-exceeded' | 'files-changed'
  }
}

// ── Import map fingerprinting ──────────────────────────────────────────────────

/**
 * Create a lightweight fingerprint of a file's import map.
 * Uses a fast string hash — not crypto-grade, just for equality checks.
 * If the fingerprint matches, the file's edges are unchanged.
 */
function fingerprintImportMap(map: FileImportExportMap): string {
  // Serialize only the parts that affect graph edges:
  // - import resolved paths (determines outgoing edges)
  // - export names (determines what's importable)
  // - external deps (tracked on node)
  const importKeys = map.imports
    .filter(i => !i.isExternal && i.resolvedPath)
    .map(i => i.resolvedPath!)
    .sort()
    .join('|')

  const exportKeys = map.exports
    .map(e => `${e.name}:${e.isReexport}`)
    .sort()
    .join('|')

  const externalKeys = [...map.externalDeps].sort().join('|')

  return `${importKeys}##${exportKeys}##${externalKeys}`
}

// ── Incremental threshold ──────────────────────────────────────────────────────

const INCREMENTAL_THRESHOLD = 0.10  // If >10% of files changed, do full rebuild

// ── IncrementalGraphEngine ─────────────────────────────────────────────────────

export class IncrementalGraphEngine {
  private previousGraph: DependencyGraph | null = null
  private previousFingerprints: Map<string, string> = new Map()
  private previousFilePaths: Set<string> = new Set()
  private fullEngine: DependencyGraphEngine

  constructor() {
    this.fullEngine = getDependencyGraphEngine()
  }

  /**
   * Build or incrementally update the dependency graph.
   *
   * @param importMaps     New import maps from the latest analysis
   * @param knownFilePaths All file paths discovered in this scan
   */
  buildIncremental(
    importMaps: FileImportExportMap[],
    knownFilePaths: string[],
  ): IncrementalBuildResult {
    const currentFilePaths = new Set(knownFilePaths)

    // ── First run — full build ─────────────────────────────────────────────
    if (!this.previousGraph) {
      return this.fullBuild(importMaps, knownFilePaths, 'first-run')
    }

    // ── Compute diff ───────────────────────────────────────────────────────
    const currentFingerprints = new Map<string, string>()
    for (const map of importMaps) {
      currentFingerprints.set(map.filePath, fingerprintImportMap(map))
    }

    const addedFiles: string[] = []
    const removedFiles: string[] = []
    const changedFiles: string[] = []

    // Files that are new (not in previous scan)
    for (const fp of currentFilePaths) {
      if (!this.previousFilePaths.has(fp)) {
        addedFiles.push(fp)
      }
    }

    // Files that were removed
    for (const fp of this.previousFilePaths) {
      if (!currentFilePaths.has(fp)) {
        removedFiles.push(fp)
      }
    }

    // Files whose import map fingerprint changed
    for (const [fp, fingerprint] of currentFingerprints) {
      if (this.previousFilePaths.has(fp)) {
        const prevFingerprint = this.previousFingerprints.get(fp)
        if (prevFingerprint !== fingerprint) {
          changedFiles.push(fp)
        }
      }
    }

    const totalChanged = addedFiles.length + removedFiles.length + changedFiles.length
    const unchangedFiles = knownFilePaths.length - totalChanged

    // ── Decide: incremental patch or full rebuild ──────────────────────────
    if (totalChanged === 0) {
      // Nothing changed — return previous graph as-is
      return {
        graph: this.previousGraph,
        changedFiles: [],
        wasIncremental: true,
        stats: {
          totalFiles: knownFilePaths.length,
          unchangedFiles: knownFilePaths.length,
          changedFiles: 0,
          addedFiles: 0,
          removedFiles: 0,
          rebuildReason: 'incremental',
        },
      }
    }

    if (totalChanged / knownFilePaths.length > INCREMENTAL_THRESHOLD
        && totalChanged > 5) {
      // Too many changes — full rebuild is cheaper
      // The absolute minimum of 5 changed files prevents full rebuilds
      // in small workspaces where any single change exceeds the percentage
      return this.fullBuild(importMaps, knownFilePaths, 'threshold-exceeded')
    }

    // ── Incremental patch ──────────────────────────────────────────────────
    const graph = this.patchGraph(
      importMaps,
      knownFilePaths,
      changedFiles,
      addedFiles,
      removedFiles,
    )

    // Update state
    this.previousGraph = graph
    this.previousFingerprints = currentFingerprints
    this.previousFilePaths = currentFilePaths

    return {
      graph,
      changedFiles: [...changedFiles, ...addedFiles],
      wasIncremental: true,
      stats: {
        totalFiles: knownFilePaths.length,
        unchangedFiles,
        changedFiles: changedFiles.length,
        addedFiles: addedFiles.length,
        removedFiles: removedFiles.length,
        rebuildReason: 'incremental',
      },
    }
  }

  // ── Full rebuild ───────────────────────────────────────────────────────────

  private fullBuild(
    importMaps: FileImportExportMap[],
    knownFilePaths: string[],
    reason: 'first-run' | 'threshold-exceeded',
  ): IncrementalBuildResult {
    const graph = this.fullEngine.build(importMaps, knownFilePaths)

    // Store state for next incremental comparison
    const fingerprints = new Map<string, string>()
    for (const map of importMaps) {
      fingerprints.set(map.filePath, fingerprintImportMap(map))
    }

    this.previousGraph = graph
    this.previousFingerprints = fingerprints
    this.previousFilePaths = new Set(knownFilePaths)

    return {
      graph,
      changedFiles: knownFilePaths,
      wasIncremental: false,
      stats: {
        totalFiles: knownFilePaths.length,
        unchangedFiles: 0,
        changedFiles: knownFilePaths.length,
        addedFiles: reason === 'first-run' ? knownFilePaths.length : 0,
        removedFiles: 0,
        rebuildReason: reason,
      },
    }
  }

  // ── Incremental patching ───────────────────────────────────────────────────

  /**
   * Patch the existing graph by:
   * 1. Removing outgoing edges from changed/removed files
   * 2. Removing nodes for deleted files
   * 3. Adding nodes for new files
   * 4. Re-processing import maps for changed/added files
   * 5. Recomputing fan-in/fan-out for affected nodes
   */
  private patchGraph(
    importMaps: FileImportExportMap[],
    knownFilePaths: string[],
    changedFiles: string[],
    addedFiles: string[],
    removedFiles: string[],
  ): DependencyGraph {
    const graph = this.previousGraph!
    const affectedFiles = new Set([...changedFiles, ...addedFiles])

    // ── Step 1: Remove outgoing edges for changed + removed files ──────────
    for (const fp of [...changedFiles, ...removedFiles]) {
      const node = graph.nodes.get(fp)
      if (!node) continue

      // Remove this file from importedBy lists of its targets
      for (const target of node.imports) {
        const targetNode = graph.nodes.get(target)
        if (targetNode) {
          targetNode.importedBy = targetNode.importedBy.filter(f => f !== fp)
          targetNode.dependedBy = targetNode.importedBy
          targetNode.fanIn = targetNode.importedBy.length
        }
      }

      // Clear outgoing edges
      node.imports = []
      node.rawImports = []
      node.dependsOn = []
      node.externalDeps = []
      node.fanOut = 0
    }

    // ── Step 2: Remove nodes for deleted files ────────────────────────────
    for (const fp of removedFiles) {
      // Also remove this file from importedBy of its former targets
      // (already done in step 1, but also remove from any node that imports it)
      for (const [, node] of graph.nodes) {
        if (node.imports.includes(fp)) {
          node.imports = node.imports.filter(i => i !== fp)
          node.dependsOn = node.imports
          node.fanOut = node.imports.length
        }
      }
      graph.nodes.delete(fp)
    }

    // ── Step 3: Add nodes for new files ───────────────────────────────────
    for (const fp of addedFiles) {
      if (!graph.nodes.has(fp)) {
        graph.nodes.set(fp, {
          filePath: fp,
          imports: [],
          rawImports: [],
          exports: [],
          importedBy: [],
          dependsOn: [],
          dependedBy: [],
          externalDeps: [],
          fanOut: 0,
          fanIn: 0,
        })
      }
    }

    // ── Step 4: Re-process import maps for changed + added files ──────────
    // Build a temporary path alias map for reconciliation
    const tempImportMaps = importMaps.filter(m => affectedFiles.has(m.filePath))

    // Use DependencyGraphEngine to rebuild just these files' edges
    // We build a mini-graph and merge the edges back
    if (tempImportMaps.length > 0) {
      const miniGraph = this.fullEngine.build(tempImportMaps, knownFilePaths)

      for (const fp of affectedFiles) {
        const miniNode = miniGraph.nodes.get(fp)
        const mainNode = graph.nodes.get(fp)
        if (!miniNode || !mainNode) continue

        // Apply the new outgoing edges from the mini-graph
        mainNode.imports = miniNode.imports
        mainNode.rawImports = miniNode.rawImports
        mainNode.exports = miniNode.exports
        mainNode.dependsOn = miniNode.imports
        mainNode.externalDeps = miniNode.externalDeps
        mainNode.fanOut = miniNode.fanOut

        // Update importedBy on targets
        for (const target of miniNode.imports) {
          const targetNode = graph.nodes.get(target)
          if (targetNode && !targetNode.importedBy.includes(fp)) {
            targetNode.importedBy.push(fp)
            targetNode.dependedBy = targetNode.importedBy
            targetNode.fanIn = targetNode.importedBy.length
          }
        }
      }
    }

    // ── Step 5: Rebuild edge list and total ───────────────────────────────
    const edges: [string, string][] = []
    for (const node of graph.nodes.values()) {
      for (const target of node.imports) {
        edges.push([node.filePath, target])
      }
    }
    graph.edges = edges
    graph.totalEdges = edges.length

    // Rebuild unresolved imports (only from changed files — keep old ones from unchanged)
    const unchangedUnresolved = graph.unresolvedImports.filter(
      u => !affectedFiles.has(u.fromFile) && !removedFiles.includes(u.fromFile)
    )
    if (tempImportMaps.length > 0) {
      const miniGraph = this.fullEngine.build(tempImportMaps, knownFilePaths)
      graph.unresolvedImports = [
        ...unchangedUnresolved,
        ...miniGraph.unresolvedImports,
      ]
    } else {
      graph.unresolvedImports = unchangedUnresolved
    }

    return graph
  }

  // ── Reset ──────────────────────────────────────────────────────────────────

  /** Force next build to be a full rebuild (e.g. when project changes). */
  reset(): void {
    this.previousGraph = null
    this.previousFingerprints.clear()
    this.previousFilePaths.clear()
  }

  /** Whether incremental data is available (at least one build has completed). */
  get hasBaseline(): boolean {
    return this.previousGraph !== null
  }
}

// ── Singleton ──────────────────────────────────────────────────────────────────

let instance: IncrementalGraphEngine | null = null

export function getIncrementalGraphEngine(): IncrementalGraphEngine {
  if (!instance) instance = new IncrementalGraphEngine()
  return instance
}
