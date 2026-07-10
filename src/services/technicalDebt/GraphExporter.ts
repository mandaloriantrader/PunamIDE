/**
 * GraphExporter.ts — Fix #8
 *
 * Exports the dependency graph in DOT (Graphviz), JSON, and Mermaid formats.
 * Pure functions — no I/O, no side effects. The dashboard handles file saving.
 *
 * Usage:
 *   const exporter = getGraphExporter();
 *   const dot = exporter.toDOT(graph, { highlightCycles: cycles.filesInCycles });
 *   const json = exporter.toJSON(graph, coupling);
 *   const mermaid = exporter.toMermaid(graph);
 *   // Then save via Tauri dialog + writeTextFile
 */

import type { DependencyGraph } from './DependencyGraphEngine'
import type { CouplingAnalysis } from './CouplingAnalyzer'

// ── Types ──────────────────────────────────────────────────────────────────────

export interface DOTOptions {
  /** Files to highlight in red (typically cycle members). */
  highlightCycles?: Set<string>
  /** Files to highlight in orange (typically hub files). */
  highlightHubs?: Set<string>
  /** Maximum label length before truncating. Default: 30 */
  maxLabelLength?: number
  /** Graph direction: LR (left-to-right) or TB (top-to-bottom). Default: LR */
  rankDir?: 'LR' | 'TB'
}

export interface JSONExport {
  meta: {
    exportedAt: string
    totalNodes: number
    totalEdges: number
    unresolvedImports: number
  }
  nodes: JSONNode[]
  edges: JSONEdge[]
}

export interface JSONNode {
  id: string
  label: string
  fanIn: number
  fanOut: number
  externalDeps: string[]
  coupling: number | null
  isHub: boolean
  isInCycle: boolean
}

export interface JSONEdge {
  source: string
  target: string
}

// ── GraphExporter ──────────────────────────────────────────────────────────────

export class GraphExporter {

  /**
   * Export as Graphviz DOT format.
   * Produces a directed graph with color-coded nodes.
   */
  toDOT(graph: DependencyGraph, options: DOTOptions = {}): string {
    const {
      highlightCycles = new Set(),
      highlightHubs = new Set(),
      maxLabelLength = 30,
      rankDir = 'LR',
    } = options

    const lines: string[] = [
      'digraph DependencyGraph {',
      `  rankdir=${rankDir};`,
      '  node [shape=box, style="filled,rounded", fontname="JetBrains Mono", fontsize=9];',
      '  edge [color="#555555", arrowsize=0.6];',
      '',
    ]

    // Nodes
    for (const [fp, node] of graph.nodes) {
      const label = this.truncateLabel(fp, maxLabelLength)
      const escaped = label.replace(/"/g, '\\"')

      let fillColor = '#2a2a4a'  // default: dark
      let fontColor = '#e0e0e0'
      let borderColor = '#3b82f6'

      if (highlightCycles.has(fp)) {
        fillColor = '#7f1d1d'
        borderColor = '#ef4444'
        fontColor = '#fca5a5'
      } else if (highlightHubs.has(fp)) {
        fillColor = '#78350f'
        borderColor = '#f59e0b'
        fontColor = '#fde68a'
      } else if (node.fanIn === 0 && node.fanOut === 0) {
        fillColor = '#1a1a2e'
        borderColor = '#4a4a6a'
        fontColor = '#a0a0b0'
      }

      lines.push(`  "${fp}" [label="${escaped}", fillcolor="${fillColor}", fontcolor="${fontColor}", color="${borderColor}"];`)
    }

    lines.push('')

    // Edges
    for (const [from, to] of graph.edges) {
      lines.push(`  "${from}" -> "${to}";`)
    }

    lines.push('}')
    return lines.join('\n')
  }

  /**
   * Export as structured JSON for external tooling or visualization libraries.
   */
  toJSON(graph: DependencyGraph, coupling?: CouplingAnalysis | null): JSONExport {
    const nodes: JSONNode[] = [...graph.nodes.entries()].map(([fp, node]) => {
      const couplingData = coupling?.files.find(f => f.filePath === fp)
      return {
        id: fp,
        label: this.truncateLabel(fp, 40),
        fanIn: node.fanIn,
        fanOut: node.fanOut,
        externalDeps: node.externalDeps,
        coupling: couplingData?.couplingScore ?? null,
        isHub: couplingData?.isHubFile ?? false,
        isInCycle: couplingData?.isInCycle ?? false,
      }
    })

    const edges: JSONEdge[] = graph.edges.map(([source, target]) => ({
      source,
      target,
    }))

    return {
      meta: {
        exportedAt: new Date().toISOString(),
        totalNodes: graph.nodes.size,
        totalEdges: graph.totalEdges,
        unresolvedImports: graph.unresolvedImports.length,
      },
      nodes,
      edges,
    }
  }

  /**
   * Export as Mermaid flowchart syntax.
   * Compatible with GitHub markdown rendering and Mermaid Live Editor.
   */
  toMermaid(graph: DependencyGraph, options?: { highlightCycles?: Set<string> }): string {
    const highlightCycles = options?.highlightCycles ?? new Set()
    const lines: string[] = ['flowchart LR']
    const idMap = new Map<string, string>()
    let counter = 0

    // Generate stable short IDs
    for (const fp of graph.nodes.keys()) {
      const id = `N${counter++}`
      idMap.set(fp, id)
    }

    // Node declarations
    for (const [fp, node] of graph.nodes) {
      const id = idMap.get(fp)!
      const label = this.truncateLabel(fp, 25)
      const escaped = label.replace(/"/g, "'")

      if (highlightCycles.has(fp)) {
        lines.push(`  ${id}["${escaped}"]:::cycle`)
      } else if (node.fanIn >= 10 && node.fanOut >= 8) {
        lines.push(`  ${id}["${escaped}"]:::hub`)
      } else {
        lines.push(`  ${id}["${escaped}"]`)
      }
    }

    lines.push('')

    // Edges
    for (const [from, to] of graph.edges) {
      const fromId = idMap.get(from)
      const toId = idMap.get(to)
      if (fromId && toId) {
        lines.push(`  ${fromId} --> ${toId}`)
      }
    }

    // Style classes
    lines.push('')
    lines.push('  classDef cycle fill:#7f1d1d,stroke:#ef4444,color:#fca5a5')
    lines.push('  classDef hub fill:#78350f,stroke:#f59e0b,color:#fde68a')

    return lines.join('\n')
  }

  // ── Utilities ───────────────────────────────────────────────────────────────

  /** Truncate a file path to show only the last N characters worth of segments. */
  private truncateLabel(filePath: string, maxLen: number): string {
    const normalized = filePath.replace(/\\/g, '/')
    if (normalized.length <= maxLen) return normalized

    const segments = normalized.split('/')
    let result = segments[segments.length - 1] // always include filename

    for (let i = segments.length - 2; i >= 0; i--) {
      const candidate = segments[i] + '/' + result
      if (candidate.length > maxLen) break
      result = candidate
    }

    return result.length < normalized.length ? '.../' + result : result
  }
}

// ── Singleton ──────────────────────────────────────────────────────────────────

let instance: GraphExporter | null = null

export function getGraphExporter(): GraphExporter {
  if (!instance) instance = new GraphExporter()
  return instance
}
