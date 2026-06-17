/**
 * CircularDepDetector.ts — Phase 4
 *
 * Finds all circular dependency cycles in the workspace dependency graph.
 *
 * Algorithm: Tarjan's Strongly Connected Components (SCC)
 *
 * Why Tarjan's SCC over simple DFS cycle detection:
 *  - Finds ALL cycles, not just the first one
 *  - O(V + E) time — scales to large workspaces
 *  - Returns each cycle as a minimal set (the SCC), not just a path
 *  - Standard in production static analysis tools (ESLint, madge, etc.)
 *
 * A Strongly Connected Component with more than one node = a cycle.
 * A single-node SCC with a self-edge = self-import (unusual but detected).
 *
 * Output:
 *  - cycles: each cycle is the list of file paths involved, sorted for
 *    stable output (same cycle always reported the same way)
 *  - cycleSets: same data as a Set for fast membership lookup
 *  - filesInCycles: flat Set of all files that are part of any cycle
 *
 * Usage:
 *   const detector = getCircularDepDetector()
 *   const result   = detector.detect(graph)
 *   result.cycles  // string[][] — each inner array is one cycle
 */

import type { DependencyGraph } from './DependencyGraphEngine'

// ── Types ──────────────────────────────────────────────────────────────────────

export interface CycleDetectionResult {
  /** Each entry is a cycle: list of file paths forming the cycle. */
  cycles: string[][]

  /** Quick membership lookup: is this file part of any cycle? */
  filesInCycles: Set<string>

  /** Number of distinct cycles found. */
  cycleCount: number

  /**
   * Severity classification for dashboard display.
   * none     — no cycles
   * minor    — 1–2 small cycles (2–3 files each)
   * moderate — 3–5 cycles or cycles involving 4+ files
   * severe   — 6+ cycles or cycles involving core modules
   */
  severity: 'none' | 'minor' | 'moderate' | 'severe'
}

// ── CircularDepDetector ────────────────────────────────────────────────────────

export class CircularDepDetector {

  /**
   * Run Tarjan's SCC on the dependency graph.
   * Returns all cycles and their severity classification.
   */
  detect(graph: DependencyGraph): CycleDetectionResult {
    const nodes   = [...graph.nodes.keys()]
    const adjList = this.buildAdjacencyList(graph)

    // Tarjan's SCC state
    const index    = new Map<string, number>()
    const lowlink  = new Map<string, number>()
    const onStack  = new Set<string>()
    const stack:   string[] = []
    const sccs:    string[][] = []
    let   counter  = 0

    const strongConnect = (v: string) => {
      index.set(v, counter)
      lowlink.set(v, counter)
      counter++
      stack.push(v)
      onStack.add(v)

      const neighbors = adjList.get(v) ?? []
      for (const w of neighbors) {
        if (!index.has(w)) {
          // w not yet visited
          strongConnect(w)
          lowlink.set(v, Math.min(lowlink.get(v)!, lowlink.get(w)!))
        } else if (onStack.has(w)) {
          // w is on stack → back edge → part of current SCC
          lowlink.set(v, Math.min(lowlink.get(v)!, index.get(w)!))
        }
      }

      // If v is a root of an SCC, pop the stack
      if (lowlink.get(v) === index.get(v)) {
        const scc: string[] = []
        let w: string
        do {
          w = stack.pop()!
          onStack.delete(w)
          scc.push(w)
        } while (w !== v)
        sccs.push(scc)
      }
    }

    // Run on all nodes (handles disconnected subgraphs)
    for (const node of nodes) {
      if (!index.has(node)) {
        strongConnect(node)
      }
    }

    // SCCs with more than one node = cycles
    // Single-node SCCs with self-edges = self-imports
    const cycles = sccs
      .filter((scc) => {
        if (scc.length > 1) return true
        // Single node: check for self-import
        const neighbors = adjList.get(scc[0]) ?? []
        return neighbors.includes(scc[0])
      })
      .map((scc) => [...scc].sort()) // stable sort for consistent output
      .sort((a, b) => b.length - a.length) // largest cycles first

    const filesInCycles = new Set<string>(cycles.flat())

    return {
      cycles,
      filesInCycles,
      cycleCount: cycles.length,
      severity: this.classifySeverity(cycles),
    }
  }

  // ── Severity classification ───────────────────────────────────────────────────

  private classifySeverity(cycles: string[][]): CycleDetectionResult['severity'] {
    if (cycles.length === 0) return 'none'

    const totalFiles = cycles.reduce((s, c) => s + c.length, 0)
    const maxCycleSize = cycles.reduce((m, c) => Math.max(m, c.length), 0)

    if (cycles.length >= 6 || maxCycleSize >= 8) return 'severe'
    if (cycles.length >= 3 || maxCycleSize >= 4) return 'moderate'
    return 'minor'
  }

  // ── Graph utilities ───────────────────────────────────────────────────────────

  /**
   * Build a simple adjacency list from the dependency graph.
   * Maps each file path to its direct import targets.
   */
  private buildAdjacencyList(graph: DependencyGraph): Map<string, string[]> {
    const adj = new Map<string, string[]>()
    for (const [fp, node] of graph.nodes) {
      adj.set(fp, [...node.imports])
    }
    return adj
  }
}

// ── Singleton ──────────────────────────────────────────────────────────────────

let instance: CircularDepDetector | null = null

export function getCircularDepDetector(): CircularDepDetector {
  if (!instance) instance = new CircularDepDetector()
  return instance
}
