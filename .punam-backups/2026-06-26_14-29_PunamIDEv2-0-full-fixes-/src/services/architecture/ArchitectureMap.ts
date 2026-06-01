/**
 * ArchitectureMap.ts — Phase 3, Step 3.1
 *
 * Natural Language Architecture Mapping: indexes modules, layers, and system
 * boundaries from the Phase 1 dependency graph.
 *
 * Consumes DependencyGraph (from Rust's build_dependency_graph) and
 * DependencyEdge[] (from analyze_dependencies) to build three indices:
 *
 *   1. Module Index    — groups files into logical modules by directory
 *   2. Layer Detection  — classifies files into architectural layers
 *   3. System Boundaries — clusters related modules into named systems
 *
 * These indices power ImpactAnalyzer (3.2), ChangePredictor (3.3), and
 * DependencyExplorer (3.4).
 */

import { invoke } from "@tauri-apps/api/core";
import type {
  DependencyEdge,
  DependencyGraph,
} from "./ArchitectureEngine";

// ── Re-export Rust types ──────────────────────────────────────────────────────

export type { DependencyEdge, DependencyGraph };

// ── ArchitectureMap Types ─────────────────────────────────────────────────────

/** Maps a module name to the list of file paths it contains. */
export type ModuleIndex = Record<string, string[]>;

/** Maps a layer name to the list of module names in that layer. */
export type LayerMap = Record<string, string[]>;

/** Maps a system name to the list of module names in that system. */
export type SystemBoundaries = Record<string, string[]>;

/** A directed edge between two modules, with a weight (number of file-level edges). */
export interface ModuleEdge {
  from: string;
  to: string;
  count: number; // number of file-level import edges
}

/** File classification result. */
export interface FileClassification {
  path: string;
  module: string;
  layer: string;
  system: string;
}

/** Module-level dependency info. */
export interface ModuleDependencies {
  internal: string[]; // modules within same system
  external: string[]; // modules in other systems
}

/** Configuration for layer detection. */
export interface LayerConfig {
  /** Layer name → array of directory prefixes that define the layer. */
  layers: Record<string, string[]>;
}

/** Configuration for module detection. */
export interface ModuleConfig {
  /** Directory depth for module grouping.
   *  1 = top-level only (src/, src-tauri/)
   *  2 = second-level (src/components/, src/services/, etc.)
   *  Higher values group at deeper levels.
   */
  depth: number;
}

/** Summary statistics for the architecture map. */
export interface ArchitectureMapStats {
  totalFiles: number;
  totalModules: number;
  totalLayers: number;
  totalSystems: number;
  totalInterModuleEdges: number;
  largestModule: { name: string; fileCount: number };
  mostConnectedModule: { name: string; edgeCount: number };
}

// ── Default Configurations ─────────────────────────────────────────────────────

export const DEFAULT_LAYER_CONFIG: LayerConfig = {
  layers: {
    ui: ["src/components/", "src/pages/", "src/views/", "ui/"],
    services: ["src/services/", "src/api/"],
    stores: ["src/stores/", "src/store/"],
    data: ["src/database/", "src/data/", "src/repositories/", "src/models/", "src/schema/"],
    utils: ["src/utils/", "src/lib/", "src/helpers/", "src/hooks/"],
    types: ["src/types/"],
    core: ["src-tauri/src/", "core/"],
    assets: ["src/assets/", "public/", "static/"],
    workers: ["src/workers/"],
  },
};

export const DEFAULT_MODULE_CONFIG: ModuleConfig = {
  depth: 2, // group at src/{category}/ level
};

// ── ArchitectureMap Class ─────────────────────────────────────────────────────

export class ArchitectureMap {
  // Raw data
  private edges: DependencyEdge[];
  private graph: DependencyGraph | null;

  // Built indices
  private moduleIndex: ModuleIndex = {};
  private layerMap: LayerMap = {};
  private systemBoundaries: SystemBoundaries = {};
  private fileClassifications: Map<string, FileClassification> = new Map();
  private interModuleEdges: ModuleEdge[] = [];

  // Config
  private layerConfig: LayerConfig;
  private moduleConfig: ModuleConfig;

  constructor(
    edges: DependencyEdge[],
    graph?: DependencyGraph | null,
    layerConfig?: LayerConfig,
    moduleConfig?: ModuleConfig,
  ) {
    this.edges = edges;
    this.graph = graph ?? null;
    this.layerConfig = layerConfig ?? DEFAULT_LAYER_CONFIG;
    this.moduleConfig = moduleConfig ?? DEFAULT_MODULE_CONFIG;

    this.buildModuleIndex();
    this.buildLayerMap();
    this.buildSystemBoundaries();
    this.buildInterModuleEdges();
    this.classifyAllFiles();
  }

  // ── Index Building ──────────────────────────────────────────────────────────

  /**
   * Build the module index: groups files by directory prefix at the configured depth.
   *
   * Examples (depth=2):
   *   "src/services/architecture/ArchitectureEngine.ts" → module "src/services"
   *   "src-tauri/src/architecture/graph_builder.rs"     → module "src-tauri/src"
   *   "src/components/AiChat.tsx"                       → module "src/components"
   */
  buildModuleIndex(): void {
    const index: ModuleIndex = {};

    // Collect all unique file paths from edges
    const fileSet = new Set<string>();
    for (const edge of this.edges) {
      fileSet.add(edge.from_file);
      // Only add to_module if it's a local (non-external) reference
      if (!edge.is_external) {
        fileSet.add(edge.to_module);
      }
    }

    // Also add files from the graph if available
    if (this.graph) {
      for (const file of this.graph.files) {
        fileSet.add(file);
      }
    }

    for (const file of fileSet) {
      const module = this.extractModule(file);
      if (!index[module]) {
        index[module] = [];
      }
      if (!index[module].includes(file)) {
        index[module].push(file);
      }
    }

    // Sort files within each module
    for (const mod of Object.keys(index)) {
      index[mod].sort();
    }

    this.moduleIndex = index;
  }

  /**
   * Build the layer map: assigns each module to an architectural layer
   * based on directory prefix matching from the layer config.
   */
  buildLayerMap(): void {
    const map: LayerMap = {};

    // Initialize empty arrays for all layers
    for (const layer of Object.keys(this.layerConfig.layers)) {
      map[layer] = [];
    }

    // Add an "unknown" layer for files that don't match any pattern
    map["unknown"] = [];

    for (const module of Object.keys(this.moduleIndex)) {
      let matched = false;
      for (const [layer, patterns] of Object.entries(this.layerConfig.layers)) {
        for (const pattern of patterns) {
          if (module.startsWith(pattern) || module === pattern.replace(/\/$/, "")) {
            map[layer].push(module);
            matched = true;
            break;
          }
        }
        if (matched) break;
      }
      if (!matched) {
        map["unknown"].push(module);
      }
    }

    // Sort modules within each layer
    for (const layer of Object.keys(map)) {
      map[layer].sort();
    }

    // Remove empty unknown layer
    if (map["unknown"].length === 0) {
      delete map["unknown"];
    }

    this.layerMap = map;
  }

  /**
   * Build system boundaries: groups related modules into named "systems"
   * based on clustering of inter-module dependencies.
   *
   * Initially: each distinct top-level directory prefix is a "system".
   * Later refined by ImpactAnalyzer (Step 3.2) using LLM analysis.
   */
  buildSystemBoundaries(): void {
    const boundaries: SystemBoundaries = {};

    // Group modules by their first-level directory component
    const systemGroups: Record<string, string[]> = {};

    for (const module of Object.keys(this.moduleIndex)) {
      // Extract first meaningful component (e.g., "src" → go deeper, "src/services" → "services")
      const parts = module.replace(/\\/g, "/").split("/").filter(Boolean);
      let system: string;

      if (parts.length >= 2) {
        // Use the first non-generic component
        if (parts[0] === "src" || parts[0] === "src-tauri") {
          system = parts.length >= 2 ? parts[1] : parts[0];
        } else {
          system = parts[0];
        }
      } else if (parts.length === 1) {
        system = parts[0];
      } else {
        system = "root";
      }

      // Map abbreviations to full names
      system = SYSTEM_NAME_MAP[system] || system;

      if (!systemGroups[system]) {
        systemGroups[system] = [];
      }
      systemGroups[system].push(module);
    }

    // Sort
    for (const [sys, mods] of Object.entries(systemGroups)) {
      boundaries[sys] = mods.sort();
    }

    this.systemBoundaries = boundaries;
  }

  /**
   * Build inter-module edges: aggregates file-level edges into module-level edges
   * with counts. Only includes local (non-external) edges.
   */
  buildInterModuleEdges(): void {
    const edgeMap = new Map<string, number>(); // "from→to" → count

    for (const edge of this.edges) {
      if (edge.is_external) continue;

      const fromModule = this.extractModule(edge.from_file);
      const toModule = this.extractModule(edge.to_module);

      if (fromModule === toModule) continue; // skip self-edges (intra-module)

      const key = `${fromModule}→${toModule}`;
      edgeMap.set(key, (edgeMap.get(key) || 0) + 1);
    }

    // Also consider graph reverse edges for completeness
    if (this.graph) {
      for (const [fromFile, toFiles] of Object.entries(this.graph.forward)) {
        const fromModule = this.extractModule(fromFile);
        for (const toFile of toFiles) {
          const toModule = this.extractModule(toFile);
          if (fromModule === toModule) continue;
          const key = `${fromModule}→${toModule}`;
          if (!edgeMap.has(key)) {
            edgeMap.set(key, 1);
          }
        }
      }
    }

    this.interModuleEdges = Array.from(edgeMap.entries()).map(
      ([key, count]) => {
        const [from, to] = key.split("→");
        return { from, to, count };
      },
    );
  }

  /**
   * Classify all files into { module, layer, system } tuples.
   */
  classifyAllFiles(): void {
    const allFiles = new Set<string>();
    for (const edge of this.edges) {
      allFiles.add(edge.from_file);
      if (!edge.is_external) allFiles.add(edge.to_module);
    }
    if (this.graph) {
      for (const file of this.graph.files) {
        allFiles.add(file);
      }
    }

    for (const file of allFiles) {
      this.fileClassifications.set(file, {
        path: file,
        module: this.extractModule(file),
        layer: this.getFileLayer(file),
        system: this.getFileSystem(file),
      });
    }
  }

  // ── Public Queries ──────────────────────────────────────────────────────────

  /** Get the full module index: module → file[] */
  getModuleIndex(): ModuleIndex {
    return { ...this.moduleIndex };
  }

  /** Get the full layer map: layer → module[] */
  getLayerMap(): LayerMap {
    return { ...this.layerMap };
  }

  /** Get system boundaries: system → module[] */
  getSystemBoundaries(): SystemBoundaries {
    return { ...this.systemBoundaries };
  }

  /** Get all inter-module edges with counts. */
  getInterModuleEdges(): ModuleEdge[] {
    return [...this.interModuleEdges];
  }

  /** Get modules that a given module depends on (imports from). */
  getModuleDependencies(module: string): ModuleDependencies {
    const internal: string[] = [];
    const external: string[] = [];

    const ownSystem = this.getModuleSystem(module);

    const deps = new Set<string>();
    for (const edge of this.interModuleEdges) {
      if (edge.from === module) {
        deps.add(edge.to);
      }
    }

    for (const dep of deps) {
      if (this.getModuleSystem(dep) === ownSystem) {
        internal.push(dep);
      } else {
        external.push(dep);
      }
    }

    return { internal: internal.sort(), external: external.sort() };
  }

  /** Get modules that depend on a given module. */
  getModuleDependents(module: string): string[] {
    const dependents = new Set<string>();
    for (const edge of this.interModuleEdges) {
      if (edge.to === module) {
        dependents.add(edge.from);
      }
    }
    return Array.from(dependents).sort();
  }

  /** Classify a single file into its module, layer, and system. */
  classifyFile(path: string): FileClassification {
    const cached = this.fileClassifications.get(path);
    if (cached) return cached;

    return {
      path,
      module: this.extractModule(path),
      layer: this.getFileLayer(path),
      system: this.getFileSystem(path),
    };
  }

  /** Get all files in a given module. */
  getModuleFiles(module: string): string[] {
    return this.moduleIndex[module] || [];
  }

  /** Get all modules in a given layer. */
  getLayerModules(layer: string): string[] {
    return this.layerMap[layer] || [];
  }

  /** Get all modules in a given system. */
  getSystemModules(system: string): string[] {
    return this.systemBoundaries[system] || [];
  }

  /** Get the file count for a module. */
  getModuleFileCount(module: string): number {
    return this.moduleIndex[module]?.length || 0;
  }

  /** Get the total inter-module edge count for a module (in + out). */
  getModuleEdgeCount(module: string): number {
    let count = 0;
    for (const edge of this.interModuleEdges) {
      if (edge.from === module || edge.to === module) {
        count += edge.count;
      }
    }
    return count;
  }

  /** Get files that depend on a given file (direct + transitive). */
  getFileDependents(filePath: string): string[] {
    if (!this.graph) return [];
    return this.graph.reverse[filePath] || [];
  }

  /** Get files that a given file imports (direct). */
  getFileDependencies(filePath: string): string[] {
    if (!this.graph) return [];
    return this.graph.forward[filePath] || [];
  }

  /** Compute summary statistics. */
  getStats(): ArchitectureMapStats {
    const modules = Object.keys(this.moduleIndex);
    const layers = Object.keys(this.layerMap);
    const systems = Object.keys(this.systemBoundaries);

    let largestModule = { name: "", fileCount: 0 };
    let mostConnected = { name: "", edgeCount: 0 };

    for (const mod of modules) {
      const fc = this.getModuleFileCount(mod);
      if (fc > largestModule.fileCount) {
        largestModule = { name: mod, fileCount: fc };
      }
      const ec = this.getModuleEdgeCount(mod);
      if (ec > mostConnected.edgeCount) {
        mostConnected = { name: mod, edgeCount: ec };
      }
    }

    return {
      totalFiles: this.fileClassifications.size,
      totalModules: modules.length,
      totalLayers: layers.length,
      totalSystems: systems.length,
      totalInterModuleEdges: this.interModuleEdges.length,
      largestModule,
      mostConnectedModule: mostConnected,
    };
  }

  /**
   * Regenerate all indices from fresh data.
   * Useful when edges are updated via ArchitectureScanner.
   */
  refresh(edges: DependencyEdge[], graph?: DependencyGraph | null): void {
    this.edges = edges;
    this.graph = graph ?? null;
    this.moduleIndex = {};
    this.layerMap = {};
    this.systemBoundaries = {};
    this.fileClassifications.clear();
    this.interModuleEdges = [];

    this.buildModuleIndex();
    this.buildLayerMap();
    this.buildSystemBoundaries();
    this.buildInterModuleEdges();
    this.classifyAllFiles();
  }

  // ── Private Helpers ─────────────────────────────────────────────────────────

  /**
   * Extract the module name for a file path at the configured depth.
   *
   * depth=2: "src/services/auth/token.ts" → "src/services"
   * depth=1: "src/services/auth/token.ts" → "src"
   * depth=3: "src/services/auth/token.ts" → "src/services/auth"
   */
  private extractModule(filePath: string): string {
    const normalized = filePath.replace(/\\/g, "/");
    const parts = normalized.split("/").filter(Boolean);

    if (parts.length <= this.moduleConfig.depth) {
      // If the path is shorter than depth, use all parts except the filename
      const dirParts = parts.length > 1 ? parts.slice(0, -1) : parts;
      return dirParts.join("/");
    }

    return parts.slice(0, this.moduleConfig.depth).join("/");
  }

  /** Determine which layer a file belongs to. */
  private getFileLayer(filePath: string): string {
    const normalized = filePath.replace(/\\/g, "/");
    for (const [layer, patterns] of Object.entries(this.layerConfig.layers)) {
      for (const pattern of patterns) {
        if (normalized.startsWith(pattern) || normalized === pattern.replace(/\/$/, "")) {
          return layer;
        }
      }
    }
    return "unknown";
  }

  /** Determine which system a file belongs to. */
  private getFileSystem(filePath: string): string {
    const module = this.extractModule(filePath);
    return this.getModuleSystem(module);
  }

  /** Determine which system a module belongs to. */
  private getModuleSystem(module: string): string {
    for (const [system, mods] of Object.entries(this.systemBoundaries)) {
      if (mods.includes(module)) return system;
    }
    return "unknown";
  }
}

// ── System Name Map (abbreviation → readable name) ───────────────────────────

const SYSTEM_NAME_MAP: Record<string, string> = {
  components: "Components",
  pages: "Pages",
  views: "Views",
  services: "Services",
  stores: "Store",
  store: "Store",
  utils: "Utilities",
  lib: "Library",
  hooks: "Hooks",
  types: "Types",
  assets: "Assets",
  public: "Public",
  workers: "Workers",
  architecture: "Architecture",
  memory: "Memory",
  github: "GitHub",
  lsp: "LSP",
  dap: "Debugger",
  agent: "Agent",
  ai: "AI",
  embeddings: "Embeddings",
  indexing: "Indexing",
  persistence: "Persistence",
  mcp: "MCP",
  terminal: "Terminal",
  workspace: "Workspace",
  safety: "Safety",
  snapshot: "Snapshot",
  fs_commands: "FileSystem",
  search_commands: "Search",
  terminal_commands: "Terminal",
  git_commands: "Git",
  index_commands: "Index",
  agent_tools: "AgentTools",
  pty_manager: "PTY",
  lsp_manager: "LSP",
  dap_manager: "DAP",
  styles: "Styles",
};

// ── Tauri Command Invocation ─────────────────────────────────────────────────

/**
 * Build a full ArchitectureMap from the Rust backend.
 *
 * Calls `build_dependency_graph` (new Phase 3 command) to get the
 * DependencyGraph, and also fetches the raw edges via `analyze_dependencies`.
 *
 * Returns a fully initialized ArchitectureMap ready for queries.
 */
export async function buildArchitectureMap(
  layerConfig?: LayerConfig,
  moduleConfig?: ModuleConfig,
): Promise<ArchitectureMap> {
  // Fetch both graph and raw edges in parallel
  const [graph, edgeResult] = await Promise.all([
    invoke<DependencyGraph>("build_dependency_graph").catch(() => null),
    invoke<{ edges: DependencyEdge[] }>("analyze_dependencies").catch(() => ({
      edges: [] as DependencyEdge[],
    })),
  ]);

  const edges = "edges" in edgeResult ? edgeResult.edges : [];

  return new ArchitectureMap(edges, graph, layerConfig, moduleConfig);
}