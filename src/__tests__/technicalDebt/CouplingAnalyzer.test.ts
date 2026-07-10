/**
 * Unit tests for CouplingAnalyzer — fan-in/out, instability, hub detection, coupling scores.
 */

import { describe, it, expect } from 'vitest'
import { CouplingAnalyzer } from '../../services/technicalDebt/CouplingAnalyzer'
import type { DependencyGraph, GraphNode } from '../../services/technicalDebt/DependencyGraphEngine'
import type { CycleDetectionResult } from '../../services/technicalDebt/CircularDepDetector'

// ── Helpers ──────────────────────────────────────────────────────────────────

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
  return { nodes, edges, unresolvedImports: [], totalEdges: edges.length }
}

function noCycles(): CycleDetectionResult {
  return { cycles: [], filesInCycles: new Set(), cycleCount: 0, severity: 'none' }
}

function withCycles(files: string[]): CycleDetectionResult {
  return {
    cycles: [files],
    filesInCycles: new Set(files),
    cycleCount: 1,
    severity: 'minor',
  }
}

describe('CouplingAnalyzer', () => {
  const analyzer = new CouplingAnalyzer()

  describe('instability metric', () => {
    it('computes instability = 0 for file with only fan-in (stable)', () => {
      // b is imported by a, c, d but imports nothing
      const graph = buildMockGraph({
        '/a.ts': ['/b.ts'],
        '/c.ts': ['/b.ts'],
        '/d.ts': ['/b.ts'],
        '/b.ts': [],
      })
      const result = analyzer.analyze(graph, noCycles())
      const bMetrics = result.files.find(f => f.filePath === '/b.ts')!
      expect(bMetrics.instability).toBe(0)
    })

    it('computes instability = 1 for file with only fan-out (unstable)', () => {
      // a imports b, c, d but nothing imports a
      const graph = buildMockGraph({
        '/a.ts': ['/b.ts', '/c.ts', '/d.ts'],
        '/b.ts': [],
        '/c.ts': [],
        '/d.ts': [],
      })
      const result = analyzer.analyze(graph, noCycles())
      const aMetrics = result.files.find(f => f.filePath === '/a.ts')!
      expect(aMetrics.instability).toBe(1)
    })

    it('computes instability = 0 for isolated file (no edges)', () => {
      const graph = buildMockGraph({ '/a.ts': [] })
      const result = analyzer.analyze(graph, noCycles())
      const aMetrics = result.files.find(f => f.filePath === '/a.ts')!
      expect(aMetrics.instability).toBe(0)
    })

    it('computes instability between 0 and 1 for mixed file', () => {
      // a: fan-in=2, fan-out=2 → I = 2/(2+2) = 0.5
      const graph = buildMockGraph({
        '/x.ts': ['/a.ts'],
        '/y.ts': ['/a.ts'],
        '/a.ts': ['/b.ts', '/c.ts'],
        '/b.ts': [],
        '/c.ts': [],
      })
      const result = analyzer.analyze(graph, noCycles())
      const aMetrics = result.files.find(f => f.filePath === '/a.ts')!
      expect(aMetrics.instability).toBe(0.5)
    })
  })

  describe('coupling score', () => {
    it('returns 0 coupling for isolated file', () => {
      const graph = buildMockGraph({ '/a.ts': [] })
      const result = analyzer.analyze(graph, noCycles())
      const aMetrics = result.files.find(f => f.filePath === '/a.ts')!
      expect(aMetrics.couplingScore).toBe(0)
    })

    it('increases coupling with more fan-out', () => {
      const targets = Array.from({ length: 15 }, (_, i) => `/dep${i}.ts`)
      const adj: Record<string, string[]> = { '/hub.ts': targets }
      for (const t of targets) adj[t] = []

      const graph = buildMockGraph(adj)
      const result = analyzer.analyze(graph, noCycles())
      const hubMetrics = result.files.find(f => f.filePath === '/hub.ts')!
      expect(hubMetrics.couplingScore).toBeGreaterThan(30)
    })

    it('penalizes cycle membership', () => {
      const graph = buildMockGraph({
        '/a.ts': ['/b.ts'],
        '/b.ts': ['/a.ts'],
      })
      const noCycleResult = analyzer.analyze(graph, noCycles())
      const withCycleResult = analyzer.analyze(graph, withCycles(['/a.ts', '/b.ts']))

      const aWithout = noCycleResult.files.find(f => f.filePath === '/a.ts')!
      const aWith = withCycleResult.files.find(f => f.filePath === '/a.ts')!
      expect(aWith.couplingScore).toBeGreaterThan(aWithout.couplingScore)
    })

    it('coupling score is always 0–100', () => {
      // File with extreme connectivity
      const targets = Array.from({ length: 30 }, (_, i) => `/dep${i}.ts`)
      const importers = Array.from({ length: 30 }, (_, i) => `/imp${i}.ts`)
      const adj: Record<string, string[]> = { '/hub.ts': targets }
      for (const t of targets) adj[t] = []
      for (const imp of importers) adj[imp] = ['/hub.ts']

      const graph = buildMockGraph(adj)
      const result = analyzer.analyze(graph, withCycles(['/hub.ts', targets[0]]))
      const hubMetrics = result.files.find(f => f.filePath === '/hub.ts')!
      expect(hubMetrics.couplingScore).toBeGreaterThanOrEqual(0)
      expect(hubMetrics.couplingScore).toBeLessThanOrEqual(100)
    })
  })

  describe('hub file detection', () => {
    it('does not flag low-connectivity files as hubs', () => {
      const graph = buildMockGraph({
        '/a.ts': ['/b.ts', '/c.ts'],
        '/b.ts': [],
        '/c.ts': [],
      })
      const result = analyzer.analyze(graph, noCycles())
      expect(result.hubFiles).toHaveLength(0)
    })

    it('flags file with high fan-in AND high fan-out as hub', () => {
      // hub imported by 12 files, imports 10 files
      const importers = Array.from({ length: 12 }, (_, i) => `/imp${i}.ts`)
      const targets = Array.from({ length: 10 }, (_, i) => `/dep${i}.ts`)
      const adj: Record<string, string[]> = { '/hub.ts': targets }
      for (const t of targets) adj[t] = []
      for (const imp of importers) adj[imp] = ['/hub.ts']

      const graph = buildMockGraph(adj)
      const result = analyzer.analyze(graph, noCycles())
      expect(result.hubFiles).toContain('/hub.ts')
    })

    it('does not flag high fan-in with low fan-out as hub (shared utility)', () => {
      // utils imported by 20 files, imports 1 file
      const importers = Array.from({ length: 20 }, (_, i) => `/comp${i}.ts`)
      const adj: Record<string, string[]> = { '/utils.ts': ['/constants.ts'], '/constants.ts': [] }
      for (const imp of importers) adj[imp] = ['/utils.ts']

      const graph = buildMockGraph(adj)
      const result = analyzer.analyze(graph, noCycles())
      expect(result.hubFiles).not.toContain('/utils.ts')
    })
  })

  describe('average coupling', () => {
    it('returns 0 for empty graph', () => {
      const graph = buildMockGraph({})
      const result = analyzer.analyze(graph, noCycles())
      expect(result.averageCoupling).toBe(0)
    })

    it('computes average across all files', () => {
      const graph = buildMockGraph({
        '/a.ts': ['/b.ts'],
        '/b.ts': ['/c.ts'],
        '/c.ts': [],
      })
      const result = analyzer.analyze(graph, noCycles())
      expect(result.averageCoupling).toBeGreaterThanOrEqual(0)
      expect(result.averageCoupling).toBeLessThanOrEqual(100)
    })
  })

  describe('dependency risk scores', () => {
    it('all risk scores are 0–100', () => {
      const targets = Array.from({ length: 20 }, (_, i) => `/dep${i}.ts`)
      const adj: Record<string, string[]> = { '/hub.ts': targets }
      for (const t of targets) adj[t] = ['/hub.ts']

      const graph = buildMockGraph(adj)
      const result = analyzer.analyze(graph, withCycles(['/hub.ts', targets[0]]))

      for (const file of result.files) {
        expect(file.dependencyRiskScore).toBeGreaterThanOrEqual(0)
        expect(file.dependencyRiskScore).toBeLessThanOrEqual(100)
      }
    })
  })
})
