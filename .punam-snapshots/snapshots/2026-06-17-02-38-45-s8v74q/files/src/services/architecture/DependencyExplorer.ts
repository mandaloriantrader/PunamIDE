/**
 * DependencyExplorer.ts — Phase 3, Step 3.4
 *
 * Interactive dependency graph visualization data layer.
 *
 * Transforms the ArchitectureMap's module-level edges into a format
 * suitable for force-directed graph rendering (D3-force, vis-network, or Canvas).
 *
 * Provides:
 *   - Node/link data for graph libraries
 *   - Filtering by system, layer, module, or edge weight
 *   - Centrality metrics (degree, betweenness approximation)
 *   - Export to DOT format (Graphviz-compatible)
 */

import type { ArchitectureMap, ModuleEdge, ModuleIndex, SystemBoundaries, LayerMap, ArchitectureMapStats } from "./ArchitectureMap";
import { buildArchitectureMap } from "./ArchitectureMap";

// ── Types ──────────────────────────────────────────────────────────────────────

/** A node in the dependency graph visualization. */
export interface GraphNode {
  id: string;           // module path (e.g., "src/services")
  label: string;        // short label for display
  system: string;       // system name
  layer: string;        // architectural layer
  fileCount: number;    // number of files in module
  weight: number;       // total edges (in + out) — used for node sizing
  centrality: number;   // degree centrality (0–1)
  x?: number;           // computed by force simulation
  y?: number;
  fx?: number;          // fixed position (for pinned nodes)
  fy?: number;
}

/** A link/edge between two graph nodes. */
export interface GraphLink {
  source: string;       // module path
  target: string;       // module path
  count: number;        // number of file-level imports
  value: number;        // normalized weight for stroke width
}

/** The complete graph data ready for rendering. */
export interface GraphData {
  nodes: GraphNode[];
  links: GraphLink[];
}

/** Filter options for the graph. */
export interface GraphFilter {
  /** Only show nodes belonging to these systems. */
  systems?: string[];
  /** Only show nodes belonging to these layers. */
  layers?: string[];
  /** Hide nodes with fewer than this many file-level edges. */
  minEdgeWeight?: number;
  /** Maximum number of nodes to show (takes highest-weight). */
  maxNodes?: number;
  /** Only show nodes within N hops of this module. */
  focusModule?: string;
  /** Maximum depth from focus module. */
  focusDepth?: number;
  /** Include external modules (those outside the focus depth). */
  includeExternal?: boolean;
}

/** Layout options for the force simulation. */
export interface LayoutOptions {
  /** Charge strength (negative = repulsion, positive = attraction). */
  chargeStrength: number;
  /** Link distance (px). */
  linkDistance: number;
  /** Gravity toward center. */
  gravity: number;
  /** Number of simulation iterations. */
  iterations: number;
}

export const DEFAULT_LAYOUT_OPTIONS: LayoutOptions = {
  chargeStrength: -300,
  linkDistance: 150,
  gravity: 0.3,
  iterations: 300,
};

// ── DependencyExplorer Class ──────────────────────────────────────────────────

export class DependencyExplorer {
  private archMap: ArchitectureMap;

  constructor(archMap: ArchitectureMap) {
    this.archMap = archMap;
  }

  /**
   * Build the full graph data for visualization.
   *
   * @param filter - Optional filters to reduce graph complexity
   * @returns GraphData with nodes and links
   */
  buildGraphData(filter?: GraphFilter): GraphData {
    const moduleEdges = this.archMap.getInterModuleEdges();
    const stats = this.archMap.getStats();

    // Apply edge weight filter
    const filteredEdges = filter?.minEdgeWeight
      ? moduleEdges.filter((e) => e.count >= filter.minEdgeWeight!)
      : moduleEdges;

    // Collect all module nodes from filtered edges
    const moduleSet = new Set<string>();
    for (const edge of filteredEdges) {
      moduleSet.add(edge.from);
      moduleSet.add(edge.to);
    }

    // Apply focus filter (neighborhood of a specific module)
    let visibleModules: Set<string>;
    if (filter?.focusModule && moduleSet.has(filter.focusModule)) {
      visibleModules = this.focusNeighborhood(
        filter.focusModule,
        filteredEdges,
        filter.focusDepth ?? 2,
      );
    } else {
      visibleModules = moduleSet;
    }

    // Apply system filter
    if (filter?.systems && filter.systems.length > 0) {
      const systemSet = new Set(filter.systems);
      visibleModules = new Set(
        Array.from(visibleModules).filter((m) => {
          const classification = this.archMap.classifyFile(m);
          return systemSet.has(classification.system);
        }),
      );
    }

    // Apply layer filter
    if (filter?.layers && filter.layers.length > 0) {
      const layerSet = new Set(filter.layers);
      visibleModules = new Set(
        Array.from(visibleModules).filter((m) => {
          const classification = this.archMap.classifyFile(m);
          return layerSet.has(classification.layer);
        }),
      );
    }

    // Build edges (only if both source and target are visible)
    const visibleEdges = filteredEdges.filter(
      (e) => visibleModules.has(e.from) && visibleModules.has(e.to),
    );

    // Calculate max edge weight for normalization
    const maxEdgeWeight = visibleEdges.length > 0
      ? Math.max(...visibleEdges.map((e) => e.count))
      : 1;

    // Build links
    const links: GraphLink[] = visibleEdges.map((e) => ({
      source: e.from,
      target: e.to,
      count: e.count,
      value: Math.max(0.5, (e.count / maxEdgeWeight) * 5), // 0.5–5 range
    }));

    // Calculate centerality for node sizing
    const centrality = this.calculateDegreeCentrality(visibleEdges, visibleModules);

    // Build nodes
    const nodes: GraphNode[] = Array.from(visibleModules).map((module) => {
      const classification = this.archMap.classifyFile(module);
      return {
        id: module,
        label: this.formatModuleLabel(module),
        system: classification.system,
        layer: classification.layer,
        fileCount: this.archMap.getModuleFileCount(module),
        weight: this.archMap.getModuleEdgeCount(module),
        centrality: centrality.get(module) || 0,
      };
    });

    // Apply maxNodes limit (keep highest-weight nodes)
    if (filter?.maxNodes && filter.maxNodes > 0 && nodes.length > filter.maxNodes) {
      nodes.sort((a, b) => b.weight - a.weight);
      const topNodeIds = new Set(nodes.slice(0, filter.maxNodes).map((n) => n.id));
      const filteredNodes = nodes.filter((n) => topNodeIds.has(n.id));
      const filteredLinks = links.filter(
        (l) => topNodeIds.has(l.source) && topNodeIds.has(l.target),
      );
      return { nodes: filteredNodes, links: filteredLinks };
    }

    return { nodes, links };
  }

  /**
   * Get a simplified graph for a specific system.
   */
  buildSystemGraph(systemName: string): GraphData {
    return this.buildGraphData({
      systems: [systemName],
      minEdgeWeight: 1,
    });
  }

  /**
   * Get the dependency subgraph centered on a specific module.
   */
  buildModuleNeighborhood(modulePath: string, depth = 2): GraphData {
    return this.buildGraphData({
      focusModule: modulePath,
      focusDepth: depth,
    });
  }

  /**
   * Get a high-level system graph: one node per system, edges between systems.
   */
  buildSystemOverview(): GraphData {
    const systems = this.archMap.getSystemBoundaries();
    const moduleEdges = this.archMap.getInterModuleEdges();

    // Aggregate module edges into system edges
    const systemEdgeMap = new Map<string, number>(); // "SystemA→SystemB" → count
    const systemModuleMap = new Map<string, Set<string>>(); // system → modules

    for (const [sys, mods] of Object.entries(systems)) {
      systemModuleMap.set(sys, new Set(mods));
    }

    for (const edge of moduleEdges) {
      const fromSys = this.getSystemForModule(edge.from, systemModuleMap);
      const toSys = this.getSystemForModule(edge.to, systemModuleMap);
      if (!fromSys || !toSys || fromSys === toSys) continue;

      const key = `${fromSys}→${toSys}`;
      systemEdgeMap.set(key, (systemEdgeMap.get(key) || 0) + edge.count);
    }

    const maxSystemWeight = systemEdgeMap.size > 0
      ? Math.max(...systemEdgeMap.values())
      : 1;

    const nodes: GraphNode[] = Object.entries(systems).map(([name, mods]) => {
      let totalWeight = 0;
      for (const mod of mods) {
        totalWeight += this.archMap.getModuleEdgeCount(mod);
      }
      return {
        id: name,
        label: name,
        system: name,
        layer: "system",
        fileCount: mods.reduce((sum, m) => sum + this.archMap.getModuleFileCount(m), 0),
        weight: totalWeight,
        centrality: 0.5, // all systems are equal at this level
      };
    });

    const links: GraphLink[] = Array.from(systemEdgeMap.entries()).map(
      ([key, count]) => {
        const [source, target] = key.split("→");
        return {
          source,
          target,
          count,
          value: Math.max(0.5, (count / maxSystemWeight) * 5),
        };
      },
    );

    return { nodes, links };
  }

  /**
   * Export the graph to DOT format (Graphviz compatible).
   * Useful for generating static architecture diagrams.
   */
  exportToDOT(data: GraphData, title = "Project Dependencies"): string {
    const lines: string[] = [];
    lines.push(`// ${title} — generated by Punam IDE DependencyExplorer`);
    lines.push("digraph G {");
    lines.push("  rankdir=LR;");
    lines.push(`  label="${title}";`);
    lines.push("  fontsize=16;");
    lines.push("");

    // Color map for layers
    const layerColors: Record<string, string> = {
      ui: "#3b82f6",       // blue
      services: "#10b981",  // green
      stores: "#f59e0b",    // amber
      data: "#ef4444",      // red
      utils: "#8b5cf6",     // purple
      types: "#ec4899",     // pink
      core: "#6366f1",      // indigo
      assets: "#14b8a6",    // teal
      workers: "#f97316",   // orange
      unknown: "#9ca3af",   // gray
    };

    // Nodes
    for (const node of data.nodes) {
      const color = layerColors[node.layer] || "#9ca3af";
      lines.push(
        `  "${node.id}" [label="${node.label}\\n${node.fileCount} files", ` +
        `shape=box, style=filled, fillcolor="${color}33", color="${color}"];`
      );
    }
    lines.push("");

    // Edges
    for (const link of data.links) {
      const penwidth = Math.max(1, Math.round(link.value));
      lines.push(
        `  "${link.source}" -> "${link.target}" [weight=${link.count}, penwidth=${penwidth}];`
      );
    }

    lines.push("}");
    return lines.join("\n");
  }

  /**
   * Format module/submodule summary for a given system.
   */
  getSystemSummary(systemName: string): {
    system: string;
    moduleCount: number;
    fileCount: number;
    topModules: { name: string; fileCount: number; edgeCount: number }[];
    internalEdges: number;
    externalEdges: number;
    dependentSystems: string[];
  } {
    const systems = this.archMap.getSystemBoundaries();
    const modules = systems[systemName] || [];
    const moduleEdges = this.archMap.getInterModuleEdges();

    let fileCount = 0;
    let internalEdges = 0;
    let externalEdges = 0;
    const dependentSystems = new Set<string>();

    const moduleStats = modules.map((mod) => {
      const fc = this.archMap.getModuleFileCount(mod);
      const ec = this.archMap.getModuleEdgeCount(mod);
      fileCount += fc;

      // Count edges
      for (const edge of moduleEdges) {
        if (edge.from === mod || edge.to === mod) {
          const fromSys = this.getSystemForModuleSimple(edge.from, systems);
          const toSys = this.getSystemForModuleSimple(edge.to, systems);
          if (fromSys === systemName && toSys === systemName) {
            internalEdges += edge.count;
          } else {
            externalEdges += edge.count;
            if (edge.to === mod && fromSys !== systemName) {
              dependentSystems.add(fromSys || "unknown");
            }
          }
        }
      }

      return { name: mod, fileCount: fc, edgeCount: ec };
    });

    // Sort by edgeCount descending
    moduleStats.sort((a, b) => b.edgeCount - a.edgeCount);

    return {
      system: systemName,
      moduleCount: modules.length,
      fileCount,
      topModules: moduleStats.slice(0, 10),
      internalEdges,
      externalEdges,
      dependentSystems: Array.from(dependentSystems).sort(),
    };
  }

  // ── Private Helpers ─────────────────────────────────────────────────────────

  /** Find all modules within N hops of a focus module. */
  private focusNeighborhood(
    focusModule: string,
    edges: ModuleEdge[],
    depth: number,
  ): Set<string> {
    const visited = new Set<string>();
    const queue: Array<{ module: string; dist: number }> = [
      { module: focusModule, dist: 0 },
    ];
    visited.add(focusModule);

    const adjacency = new Map<string, Set<string>>();
    for (const edge of edges) {
      if (!adjacency.has(edge.from)) adjacency.set(edge.from, new Set());
      if (!adjacency.has(edge.to)) adjacency.set(edge.to, new Set());
      adjacency.get(edge.from)!.add(edge.to);
      adjacency.get(edge.to)!.add(edge.from); // undirected for exploration
    }

    while (queue.length > 0) {
      const { module, dist } = queue.shift()!;
      if (dist >= depth) continue;

      const neighbors = adjacency.get(module);
      if (!neighbors) continue;

      for (const neighbor of neighbors) {
        if (!visited.has(neighbor)) {
          visited.add(neighbor);
          queue.push({ module: neighbor, dist: dist + 1 });
        }
      }
    }

    return visited;
  }

  /** Calculate degree centrality for each module (0–1 normalized). */
  private calculateDegreeCentrality(
    edges: ModuleEdge[],
    modules: Set<string>,
  ): Map<string, number> {
    const degree = new Map<string, number>();
    for (const mod of modules) {
      degree.set(mod, 0);
    }

    for (const edge of edges) {
      if (modules.has(edge.from)) {
        degree.set(edge.from, (degree.get(edge.from) || 0) + 1);
      }
      if (modules.has(edge.to)) {
        degree.set(edge.to, (degree.get(edge.to) || 0) + 1);
      }
    }

    const maxDegree = degree.size > 0 ? Math.max(...degree.values()) : 1;
    const centrality = new Map<string, number>();
    for (const [mod, deg] of degree) {
      centrality.set(mod, maxDegree > 0 ? deg / maxDegree : 0);
    }

    return centrality;
  }

  /** Format a module path into a short display label. */
  private formatModuleLabel(modulePath: string): string {
    // e.g., "src/services/architecture" → "services/architecture"
    const parts = modulePath.replace(/\\/g, "/").split("/").filter(Boolean);
    if (parts[0] === "src" || parts[0] === "src-tauri") {
      parts.shift();
    }
    return parts.join("/") || modulePath;
  }

  private getSystemForModule(
    module: string,
    systemModuleMap: Map<string, Set<string>>,
  ): string | null {
    for (const [sys, mods] of systemModuleMap) {
      if (mods.has(module)) return sys;
    }
    return null;
  }

  private getSystemForModuleSimple(
    module: string,
    systems: SystemBoundaries,
  ): string | null {
    for (const [sys, mods] of Object.entries(systems)) {
      if (mods.includes(module)) return sys;
    }
    return null;
  }
}

// ── Convenience Factory ───────────────────────────────────────────────────────

export async function createDependencyExplorer(): Promise<DependencyExplorer> {
  const archMap = await buildArchitectureMap();
  return new DependencyExplorer(archMap);
}