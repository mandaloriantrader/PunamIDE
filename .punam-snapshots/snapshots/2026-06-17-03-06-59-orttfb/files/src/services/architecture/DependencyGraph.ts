/**
 * DependencyGraph.ts — Phase 1
 *
 * Frontend dependency graph data structure and visualization wrapper.
 * Calls Rust `graph_builder.rs` via Tauri commands and provides
 * graph traversal utilities for DependencyExplorer and ImpactAnalyzer.
 */

import { invoke } from "@tauri-apps/api/core";
import type { DependencyGraph as RustGraph, GraphStats } from "./ArchitectureEngine";

// ── Types ──────────────────────────────────────────────────────────────────────

export interface GraphNode {
  id: string;
  label: string;
  dependencyCount: number;
  dependentCount: number;
}

export interface GraphEdge {
  source: string;
  target: string;
}

export interface GraphData {
  nodes: GraphNode[];
  edges: GraphEdge[];
  stats: GraphStats;
}

export interface Cycle {
  files: string[];
  length: number;
}

export interface PathResult {
  exists: boolean;
  path: string[];
  length: number;
}

// ── DependencyGraph Class ──────────────────────────────────────────────────────

export class DependencyGraph {
  private graph: RustGraph;

  constructor(graph: RustGraph) {
    this.graph = graph;
  }

  /**
   * Get all files in the graph.
   */
  getFiles(): string[] {
    return this.graph.files;
  }

  /**
   * Get graph statistics.
   */
  getStats(): GraphStats {
    return this.graph.stats;
  }

  /**
   * Get direct dependencies of a file (what it imports).
   */
  getDependencies(filePath: string): string[] {
    return this.graph.forward[filePath] || [];
  }

  /**
   * Get direct dependents of a file (what imports it).
   */
  getDependents(filePath: string): string[] {
    return this.graph.reverse[filePath] || [];
  }

  /**
   * Get all upstream dependencies (transitive).
   * BFS through forward edges.
   */
  getUpstreamDeps(filePath: string, maxDepth = 10): string[] {
    const visited = new Set<string>();
    const queue: Array<{ file: string; depth: number }> = [{ file: filePath, depth: 0 }];

    while (queue.length > 0) {
      const { file, depth } = queue.shift()!;
      if (visited.has(file) || depth > maxDepth) continue;
      visited.add(file);

      const deps = this.graph.forward[file] || [];
      for (const dep of deps) {
        if (!visited.has(dep)) {
          queue.push({ file: dep, depth: depth + 1 });
        }
      }
    }

    visited.delete(filePath); // Don't include the file itself
    return Array.from(visited);
  }

  /**
   * Get all downstream dependents (transitive).
   * BFS through reverse edges.
   */
  getDownstreamDeps(filePath: string, maxDepth = 10): string[] {
    const visited = new Set<string>();
    const queue: Array<{ file: string; depth: number }> = [{ file: filePath, depth: 0 }];

    while (queue.length > 0) {
      const { file, depth } = queue.shift()!;
      if (visited.has(file) || depth > maxDepth) continue;
      visited.add(file);

      const dependents = this.graph.reverse[file] || [];
      for (const dep of dependents) {
        if (!visited.has(dep)) {
          queue.push({ file: dep, depth: depth + 1 });
        }
      }
    }

    visited.delete(filePath);
    return Array.from(visited);
  }

  /**
   * Find the shortest path between two files in the dependency graph.
   */
  findPath(from: string, to: string): PathResult {
    if (from === to) return { exists: true, path: [from], length: 0 };

    const visited = new Set<string>();
    const queue: Array<{ file: string; path: string[] }> = [{ file: from, path: [from] }];

    while (queue.length > 0) {
      const { file, path } = queue.shift()!;
      if (visited.has(file)) continue;
      visited.add(file);

      const deps = this.graph.forward[file] || [];
      for (const dep of deps) {
        if (dep === to) {
          return { exists: true, path: [...path, dep], length: path.length };
        }
        if (!visited.has(dep)) {
          queue.push({ file: dep, path: [...path, dep] });
        }
      }
    }

    return { exists: false, path: [], length: -1 };
  }

  /**
   * Detect cycles in the graph using DFS.
   */
  getCycles(): Cycle[] {
    const cycles: Cycle[] = [];
    const visited = new Set<string>();
    const recursionStack = new Set<string>();

    const dfs = (file: string, path: string[]): void => {
      visited.add(file);
      recursionStack.add(file);

      const deps = this.graph.forward[file] || [];
      for (const dep of deps) {
        if (!visited.has(dep)) {
          dfs(dep, [...path, dep]);
        } else if (recursionStack.has(dep)) {
          // Found a cycle
          const cycleStart = path.indexOf(dep);
          if (cycleStart >= 0) {
            const cycle = path.slice(cycleStart);
            cycles.push({ files: cycle, length: cycle.length });
          } else {
            cycles.push({ files: [...path, dep], length: path.length + 1 });
          }
        }
      }

      recursionStack.delete(file);
    };

    for (const file of this.graph.files) {
      if (!visited.has(file)) {
        dfs(file, [file]);
      }
    }

    return cycles;
  }

  /**
   * Get the depth of the dependency chain from a file.
   */
  getDepth(filePath: string): number {
    const visited = new Set<string>();
    let maxDepth = 0;

    const dfs = (file: string, depth: number): void => {
      if (visited.has(file)) return;
      visited.add(file);
      maxDepth = Math.max(maxDepth, depth);

      const deps = this.graph.forward[file] || [];
      for (const dep of deps) {
        dfs(dep, depth + 1);
      }
    };

    dfs(filePath, 0);
    return maxDepth;
  }

  /**
   * Convert to a format suitable for graph visualization libraries.
   */
  toGraphData(): GraphData {
    const nodeMap = new Map<string, GraphNode>();

    for (const file of this.graph.files) {
      nodeMap.set(file, {
        id: file,
        label: file.split("/").pop() || file,
        dependencyCount: (this.graph.forward[file] || []).length,
        dependentCount: (this.graph.reverse[file] || []).length,
      });
    }

    const edges: GraphEdge[] = [];
    for (const [source, targets] of Object.entries(this.graph.forward)) {
      for (const target of targets) {
        edges.push({ source, target });
      }
    }

    return {
      nodes: Array.from(nodeMap.values()),
      edges,
      stats: this.graph.stats,
    };
  }

  /**
   * Get the most connected files (highest in-degree + out-degree).
   */
  getMostConnected(limit = 10): GraphNode[] {
    const nodes = this.graph.files.map((file) => ({
      id: file,
      label: file.split("/").pop() || file,
      dependencyCount: (this.graph.forward[file] || []).length,
      dependentCount: (this.graph.reverse[file] || []).length,
    }));

    return nodes
      .sort((a, b) => (b.dependencyCount + b.dependentCount) - (a.dependencyCount + a.dependentCount))
      .slice(0, limit);
  }
}

// ── Factory ────────────────────────────────────────────────────────────────────

/**
 * Build a DependencyGraph from the Rust backend.
 */
export async function buildDependencyGraph(): Promise<DependencyGraph> {
  const graph = await invoke<RustGraph>("build_dependency_graph");
  return new DependencyGraph(graph);
}

/**
 * Get a cached DependencyGraph instance (rebuilds if stale).
 */
let cachedGraph: DependencyGraph | null = null;
let lastBuildTime = 0;
const GRAPH_CACHE_TTL = 30_000;

export async function getCachedDependencyGraph(forceRefresh = false): Promise<DependencyGraph> {
  const now = Date.now();
  if (!forceRefresh && cachedGraph && now - lastBuildTime < GRAPH_CACHE_TTL) {
    return cachedGraph;
  }

  cachedGraph = await buildDependencyGraph();
  lastBuildTime = now;
  return cachedGraph;
}
