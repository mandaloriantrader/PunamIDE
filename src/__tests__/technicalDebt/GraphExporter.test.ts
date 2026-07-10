/**
 * Unit tests for GraphExporter — DOT, JSON, and Mermaid export.
 */

import { describe, it, expect } from 'vitest'
import { GraphExporter } from '../../services/technicalDebt/GraphExporter'
import type { DependencyGraph, GraphNode } from '../../services/technicalDebt/DependencyGraphEngine'

function buildGraph(adj: Record<string, string[]>): DependencyGraph {
  const nodes = new Map<string, GraphNode>()
  for (const fp of Object.keys(adj)) {
    nodes.set(fp, {
      filePath: fp, imports: adj[fp], rawImports: [], exports: [],
      importedBy: [], dependsOn: adj[fp], dependedBy: [],
      externalDeps: [], fanOut: adj[fp].length, fanIn: 0,
    })
  }
  for (const [fp, targets] of Object.entries(adj)) {
    for (const t of targets) {
      const node = nodes.get(t)
      if (node) { node.importedBy.push(fp); node.fanIn = node.importedBy.length }
    }
  }
  const edges: [string, string][] = []
  for (const [fp, targets] of Object.entries(adj)) {
    for (const t of targets) edges.push([fp, t])
  }
  return { nodes, edges, unresolvedImports: [], totalEdges: edges.length }
}

describe('GraphExporter', () => {
  const exporter = new GraphExporter()

  const graph = buildGraph({
    '/src/a.ts': ['/src/b.ts', '/src/c.ts'],
    '/src/b.ts': ['/src/c.ts'],
    '/src/c.ts': [],
  })

  describe('toDOT', () => {
    it('produces valid DOT syntax', () => {
      const dot = exporter.toDOT(graph)
      expect(dot).toContain('digraph DependencyGraph {')
      expect(dot).toContain('rankdir=LR')
      expect(dot).toContain('}')
      expect(dot).toContain('"/src/a.ts"')
      expect(dot).toContain('"/src/a.ts" -> "/src/b.ts"')
    })

    it('highlights cycle files in red', () => {
      const dot = exporter.toDOT(graph, {
        highlightCycles: new Set(['/src/a.ts']),
      })
      // Cycle node should have red border
      expect(dot).toContain('#ef4444')
    })

    it('highlights hub files in orange', () => {
      const dot = exporter.toDOT(graph, {
        highlightHubs: new Set(['/src/b.ts']),
      })
      expect(dot).toContain('#f59e0b')
    })

    it('respects rankDir option', () => {
      const dot = exporter.toDOT(graph, { rankDir: 'TB' })
      expect(dot).toContain('rankdir=TB')
    })
  })

  describe('toJSON', () => {
    it('produces correct structure', () => {
      const json = exporter.toJSON(graph)
      expect(json.meta.totalNodes).toBe(3)
      expect(json.meta.totalEdges).toBe(3)
      expect(json.nodes).toHaveLength(3)
      expect(json.edges).toHaveLength(3)
    })

    it('includes fan-in/fan-out per node', () => {
      const json = exporter.toJSON(graph)
      const nodeA = json.nodes.find(n => n.id === '/src/a.ts')!
      expect(nodeA.fanOut).toBe(2)
      expect(nodeA.fanIn).toBe(0)

      const nodeC = json.nodes.find(n => n.id === '/src/c.ts')!
      expect(nodeC.fanIn).toBe(2)
      expect(nodeC.fanOut).toBe(0)
    })

    it('includes coupling data when provided', () => {
      const coupling = {
        files: [
          { filePath: '/src/a.ts', fanIn: 0, fanOut: 2, instability: 1, couplingScore: 45, isHubFile: false, isInCycle: false, dependencyRiskScore: 20, externalDepCount: 0 },
        ],
        hubFiles: [],
        couplingScores: { '/src/a.ts': 45 },
        dependencyRiskScores: { '/src/a.ts': 20 },
        averageCoupling: 15,
        p90FanOut: 2,
        p90FanIn: 2,
      }
      const json = exporter.toJSON(graph, coupling)
      const nodeA = json.nodes.find(n => n.id === '/src/a.ts')!
      expect(nodeA.coupling).toBe(45)
    })

    it('has ISO timestamp in meta', () => {
      const json = exporter.toJSON(graph)
      expect(json.meta.exportedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    })
  })

  describe('toMermaid', () => {
    it('produces valid Mermaid flowchart', () => {
      const mermaid = exporter.toMermaid(graph)
      expect(mermaid).toContain('flowchart LR')
      expect(mermaid).toContain('-->')
      expect(mermaid).toContain('classDef cycle')
      expect(mermaid).toContain('classDef hub')
    })

    it('marks cycle files with cycle class', () => {
      const mermaid = exporter.toMermaid(graph, {
        highlightCycles: new Set(['/src/a.ts']),
      })
      expect(mermaid).toContain(':::cycle')
    })

    it('generates unique node IDs', () => {
      const mermaid = exporter.toMermaid(graph)
      expect(mermaid).toContain('N0')
      expect(mermaid).toContain('N1')
      expect(mermaid).toContain('N2')
    })
  })

  describe('edge cases', () => {
    it('handles empty graph', () => {
      const empty = buildGraph({})
      expect(exporter.toDOT(empty)).toContain('digraph')
      expect(exporter.toJSON(empty).nodes).toHaveLength(0)
      expect(exporter.toMermaid(empty)).toContain('flowchart LR')
    })
  })
})
