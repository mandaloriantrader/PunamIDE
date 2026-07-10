/**
 * Unit tests for CircularDepDetector — Tarjan's SCC cycle detection.
 */

import { describe, it, expect } from 'vitest'
import { CircularDepDetector } from '../../services/technicalDebt/CircularDepDetector'
import type { DependencyGraph, GraphNode } from '../../services/technicalDebt/DependencyGraphEngine'

// ── Helper: build a mock DependencyGraph from adjacency list ──────────────────

function buildMockGraph(adj: Record<string, string[]>): DependencyGraph {
  const nodes = new Map<string, GraphNode>()

  for (const fp of Object.keys(adj)) {
    nodes.set(fp, {
      filePath: fp,
      imports: adj[fp],
      rawImports: [],
      exports: [],
      importedBy: [],
      dependsOn: adj[fp],
      dependedBy: [],
      externalDeps: [],
      fanOut: adj[fp].length,
      fanIn: 0,
    })
  }

  // Compute importedBy / fanIn
  for (const [fp, targets] of Object.entries(adj)) {
    for (const target of targets) {
      const node = nodes.get(target)
      if (node) {
        node.importedBy.push(fp)
        node.dependedBy.push(fp)
        node.fanIn = node.importedBy.length
      }
    }
  }

  const edges: [string, string][] = []
  for (const [fp, targets] of Object.entries(adj)) {
    for (const t of targets) edges.push([fp, t])
  }

  return {
    nodes,
    edges,
    unresolvedImports: [],
    totalEdges: edges.length,
  }
}

describe('CircularDepDetector', () => {
  const detector = new CircularDepDetector()

  describe('acyclic graphs', () => {
    it('returns no cycles for empty graph', () => {
      const graph = buildMockGraph({})
      const result = detector.detect(graph)
      expect(result.cycleCount).toBe(0)
      expect(result.cycles).toHaveLength(0)
      expect(result.severity).toBe('none')
    })

    it('returns no cycles for linear chain A→B→C', () => {
      const graph = buildMockGraph({
        '/src/a.ts': ['/src/b.ts'],
        '/src/b.ts': ['/src/c.ts'],
        '/src/c.ts': [],
      })
      const result = detector.detect(graph)
      expect(result.cycleCount).toBe(0)
      expect(result.severity).toBe('none')
      expect(result.filesInCycles.size).toBe(0)
    })

    it('returns no cycles for tree structure', () => {
      const graph = buildMockGraph({
        '/src/root.ts': ['/src/a.ts', '/src/b.ts'],
        '/src/a.ts': ['/src/c.ts'],
        '/src/b.ts': ['/src/c.ts'],
        '/src/c.ts': [],
      })
      const result = detector.detect(graph)
      expect(result.cycleCount).toBe(0)
    })
  })

  describe('simple cycles', () => {
    it('detects A→B→A (2-node cycle)', () => {
      const graph = buildMockGraph({
        '/src/a.ts': ['/src/b.ts'],
        '/src/b.ts': ['/src/a.ts'],
      })
      const result = detector.detect(graph)
      expect(result.cycleCount).toBe(1)
      expect(result.cycles[0]).toHaveLength(2)
      expect(result.filesInCycles.has('/src/a.ts')).toBe(true)
      expect(result.filesInCycles.has('/src/b.ts')).toBe(true)
    })

    it('detects A→B→C→A (3-node cycle)', () => {
      const graph = buildMockGraph({
        '/src/a.ts': ['/src/b.ts'],
        '/src/b.ts': ['/src/c.ts'],
        '/src/c.ts': ['/src/a.ts'],
      })
      const result = detector.detect(graph)
      expect(result.cycleCount).toBe(1)
      expect(result.cycles[0]).toHaveLength(3)
      expect(result.filesInCycles.size).toBe(3)
    })

    it('detects self-import (A→A)', () => {
      const graph = buildMockGraph({
        '/src/a.ts': ['/src/a.ts'],
      })
      const result = detector.detect(graph)
      expect(result.cycleCount).toBe(1)
      expect(result.cycles[0]).toContain('/src/a.ts')
    })
  })

  describe('multiple cycles', () => {
    it('detects two independent cycles', () => {
      const graph = buildMockGraph({
        '/src/a.ts': ['/src/b.ts'],
        '/src/b.ts': ['/src/a.ts'],
        '/src/c.ts': ['/src/d.ts'],
        '/src/d.ts': ['/src/c.ts'],
        '/src/e.ts': [],
      })
      const result = detector.detect(graph)
      expect(result.cycleCount).toBe(2)
      expect(result.filesInCycles.size).toBe(4)
      expect(result.filesInCycles.has('/src/e.ts')).toBe(false)
    })

    it('detects nested/overlapping cycles in large SCC', () => {
      // A→B→C→A and A→D→A all in one SCC
      const graph = buildMockGraph({
        '/src/a.ts': ['/src/b.ts', '/src/d.ts'],
        '/src/b.ts': ['/src/c.ts'],
        '/src/c.ts': ['/src/a.ts'],
        '/src/d.ts': ['/src/a.ts'],
      })
      const result = detector.detect(graph)
      // Tarjan's returns one SCC containing all 4 nodes
      expect(result.cycleCount).toBe(1)
      expect(result.cycles[0]).toHaveLength(4)
    })
  })

  describe('severity classification', () => {
    it('returns none for no cycles', () => {
      const graph = buildMockGraph({
        '/src/a.ts': ['/src/b.ts'],
        '/src/b.ts': [],
      })
      expect(detector.detect(graph).severity).toBe('none')
    })

    it('returns minor for 1 small cycle (2–3 files)', () => {
      const graph = buildMockGraph({
        '/src/a.ts': ['/src/b.ts'],
        '/src/b.ts': ['/src/a.ts'],
      })
      expect(detector.detect(graph).severity).toBe('minor')
    })

    it('returns moderate for 3+ cycles', () => {
      const graph = buildMockGraph({
        '/a.ts': ['/b.ts'], '/b.ts': ['/a.ts'],
        '/c.ts': ['/d.ts'], '/d.ts': ['/c.ts'],
        '/e.ts': ['/f.ts'], '/f.ts': ['/e.ts'],
      })
      expect(detector.detect(graph).severity).toBe('moderate')
    })

    it('returns severe for 6+ cycles', () => {
      // 6 independent 2-node cycles
      const adj: Record<string, string[]> = {}
      for (let i = 0; i < 12; i += 2) {
        adj[`/${i}.ts`] = [`/${i + 1}.ts`]
        adj[`/${i + 1}.ts`] = [`/${i}.ts`]
      }
      const graph = buildMockGraph(adj)
      expect(detector.detect(graph).severity).toBe('severe')
    })

    it('returns severe for single large cycle (8+ files)', () => {
      // Chain: 0→1→2→...→7→0
      const adj: Record<string, string[]> = {}
      for (let i = 0; i < 8; i++) {
        adj[`/${i}.ts`] = [`/${(i + 1) % 8}.ts`]
      }
      const graph = buildMockGraph(adj)
      const result = detector.detect(graph)
      expect(result.severity).toBe('severe')
      expect(result.cycles[0]).toHaveLength(8)
    })
  })

  describe('disconnected subgraphs', () => {
    it('correctly handles disconnected components', () => {
      const graph = buildMockGraph({
        '/src/a.ts': ['/src/b.ts'],
        '/src/b.ts': ['/src/a.ts'],
        // Disconnected acyclic component
        '/src/x.ts': ['/src/y.ts'],
        '/src/y.ts': [],
      })
      const result = detector.detect(graph)
      expect(result.cycleCount).toBe(1)
      expect(result.filesInCycles.has('/src/x.ts')).toBe(false)
      expect(result.filesInCycles.has('/src/y.ts')).toBe(false)
    })
  })
})
