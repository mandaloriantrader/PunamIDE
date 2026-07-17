/**
 * @phase P5
 * @purpose Cross-file taint tracking on the existing dependency graph.
 *          Traces untrusted input from sources to dangerous sinks
 *          across files using graph traversal.
 *
 * Algorithm:
 * 1. Scan each file for source patterns (user input, HTTP params, etc.)
 * 2. For each source, trace the tainted variable through the file (intra-file)
 * 3. When a tainted value is passed to an imported function or exported,
 *    follow the graph edge to the next file
 * 4. Continue until reaching a sink or max depth (configurable, default 10)
 * 5. Classify confidence: direct (same function), traced (cross-file),
 *    unresolvable (dynamic/unknown — fail-closed)
 */

import { type Finding, type DependencyGraph, type TaintConfig } from './types';
import { TAINT_SOURCES, TAINT_SINKS, TAINT_SANITIZERS, type TaintSource, type TaintSink } from './TaintRules';

/** A node in a taint flow path. */
export interface TaintPathNode {
  file: string;
  line: number;
  variable: string;
  operation: string;
}

/** A complete taint flow from source to sink. */
export interface TaintFlow {
  source: TaintSource;
  sink: TaintSink;
  path: TaintPathNode[];
  confidence: 'direct' | 'traced' | 'unresolvable';
  cwe: string;
}

/** Detected taint source in a file. */
interface DetectedSource {
  source: TaintSource;
  file: string;
  line: number;
  variable: string;
}

/** Detected sink in a file. */
interface DetectedSink {
  sink: TaintSink;
  file: string;
  line: number;
  variable: string;
}

/**
 * Cross-file taint tracker. Uses the existing DependencyGraph for
 * cross-file traversal — this is graph traversal on infrastructure
 * that already exists, not a new engine.
 */
export class TaintTracker {
  private defaultConfig: TaintConfig = {
    maxHops: 10,
    enabledSources: TAINT_SOURCES.map(s => s.id),
    enabledSinks: TAINT_SINKS.map(s => s.id),
    failClosedOnUnresolvable: true,
  };

  /**
   * Tracks taint flows across files using the dependency graph.
   *
   * @param graph - The dependency graph (nodes=files, edges=imports)
   * @param files - Map of file paths to source content
   * @param config - Taint tracking configuration
   * @returns Findings for all detected taint flows
   */
  trackTaint(
    graph: DependencyGraph,
    files: Map<string, string>,
    config?: Partial<TaintConfig>,
  ): Finding[] {
    const cfg = { ...this.defaultConfig, ...config };
    const findings: Finding[] = [];

    // 1. Scan all files for sources and sinks
    const allSources: DetectedSource[] = [];
    const allSinks: DetectedSink[] = [];

    for (const [file, content] of files) {
      allSources.push(...this.findSources(file, content, cfg));
      allSinks.push(...this.findSinks(file, content, cfg));
    }

    // 2. For each source, trace taint flow
    for (const detectedSource of allSources) {
      const flows = this.traceTaint(detectedSource, allSinks, graph, files, cfg);
      for (const flow of flows) {
        findings.push(this.flowToFinding(flow));
      }
    }

    return findings;
  }

  /**
   * Scans a file for taint sources.
   */
  private findSources(file: string, content: string, config: TaintConfig): DetectedSource[] {
    const sources: DetectedSource[] = [];
    const lines = content.split('\n');

    for (const taintSource of TAINT_SOURCES) {
      if (!config.enabledSources.includes(taintSource.id)) continue;

      for (let i = 0; i < lines.length; i++) {
        for (const pattern of taintSource.patterns) {
          pattern.lastIndex = 0; // Reset regex state
          const match = pattern.exec(lines[i]);
          if (match) {
            // Try to extract the variable name being assigned
            const varMatch = lines[i].match(/(?:const|let|var)\s+(\w+)\s*=/);
            const variable = varMatch ? varMatch[1] : match[0];

            sources.push({
              source: taintSource,
              file,
              line: i + 1,
              variable,
            });
          }
        }
      }
    }

    return sources;
  }

  /**
   * Scans a file for taint sinks.
   */
  private findSinks(file: string, content: string, config: TaintConfig): DetectedSink[] {
    const sinks: DetectedSink[] = [];
    const lines = content.split('\n');

    for (const taintSink of TAINT_SINKS) {
      if (!config.enabledSinks.includes(taintSink.id)) continue;

      for (let i = 0; i < lines.length; i++) {
        for (const pattern of taintSink.patterns) {
          pattern.lastIndex = 0;
          const match = pattern.exec(lines[i]);
          if (match) {
            // Extract the argument variable name
            const argMatch = lines[i].match(/\(([^)]+)\)/);
            const variable = argMatch ? argMatch[1].trim() : match[0];

            sinks.push({
              sink: taintSink,
              file,
              line: i + 1,
              variable,
            });
          }
        }
      }
    }

    return sinks;
  }

  /**
   * Traces taint from a source through the graph to find sinks.
   *
   * Algorithm:
   * 1. Check if source and sink are in the same file (direct)
   * 2. If not, follow graph edges to imported/exported files
   * 3. Check for sanitizers in the path
   * 4. Classify confidence based on path certainty
   */
  private traceTaint(
    source: DetectedSource,
    sinks: DetectedSink[],
    graph: DependencyGraph,
    files: Map<string, string>,
    config: TaintConfig,
  ): TaintFlow[] {
    const flows: TaintFlow[] = [];

    // Check for direct flows (same file)
    const sameFileSinks = sinks.filter(s => s.file === source.file);
    for (const sink of sameFileSinks) {
      // Check if the tainted variable reaches the sink
      const content = files.get(source.file) ?? '';
      if (this.isTaintReachable(source, sink, content)) {
        // Check for sanitizers in the path
        if (this.hasSanitizer(source.line, sink.line, content)) continue;

        flows.push({
          source: source.source,
          sink: sink.sink,
          path: [
            { file: source.file, line: source.line, variable: source.variable, operation: 'source' },
            { file: sink.file, line: sink.line, variable: sink.variable, operation: 'sink' },
          ],
          confidence: 'direct',
          cwe: sink.sink.cwe,
        });
      }
    }

    // Check for cross-file flows (traced)
    const visited = new Set<string>([source.file]);
    const crossFileFlows = this.traceCrossFile(
      source,
      sinks,
      graph,
      files,
      config,
      visited,
      0,
      [{ file: source.file, line: source.line, variable: source.variable, operation: 'source' }],
    );
    flows.push(...crossFileFlows);

    return flows;
  }

  /**
   * Traces taint across file boundaries using the dependency graph.
   */
  private traceCrossFile(
    source: DetectedSource,
    sinks: DetectedSink[],
    graph: DependencyGraph,
    files: Map<string, string>,
    config: TaintConfig,
    visited: Set<string>,
    depth: number,
    currentPath: TaintPathNode[],
  ): TaintFlow[] {
    if (depth >= config.maxHops) return [];

    const flows: TaintFlow[] = [];
    const currentFile = source.file;

    // Get files that the current file imports
    const node = graph.nodes.get(currentFile);
    if (!node) return [];

    for (const importedFile of node.imports) {
      if (visited.has(importedFile)) continue;
      visited.add(importedFile);

      // Check if the imported file has sinks
      const importedSinks = sinks.filter(s => s.file === importedFile);
      const content = files.get(importedFile) ?? '';

      for (const sink of importedSinks) {
        if (this.hasSanitizer(source.line, sink.line, content)) continue;

        flows.push({
          source: source.source,
          sink: sink.sink,
          path: [
            ...currentPath,
            { file: importedFile, line: sink.line, variable: sink.variable, operation: 'sink' },
          ],
          confidence: 'traced',
          cwe: sink.sink.cwe,
        });
      }

      // Continue tracing deeper
      const deeperFlows = this.traceCrossFile(
        { ...source, file: importedFile },
        sinks,
        graph,
        files,
        config,
        visited,
        depth + 1,
        [...currentPath, { file: importedFile, line: 0, variable: source.variable, operation: 'import' }],
      );
      flows.push(...deeperFlows);
    }

    // If no flows found and we're at max depth, flag as unresolvable if configured
    if (flows.length === 0 && depth === 0 && config.failClosedOnUnresolvable) {
      // Check if there are any sinks in imported files at all
      const hasAnyReachableSink = node.imports.some(imp =>
        sinks.some(s => s.file === imp)
      );

      if (!hasAnyReachableSink && node.imports.length > 0) {
        // Dynamic/unknown path — fail-closed
        flows.push({
          source: source.source,
          sink: TAINT_SINKS[0], // Generic — the actual sink is unknown
          path: currentPath,
          confidence: 'unresolvable',
          cwe: 'CWE-20',
        });
      }
    }

    return flows;
  }

  /**
   * Checks if taint from a source can reach a sink within the same file.
   * Simple heuristic: the source variable name appears between source and sink lines.
   */
  private isTaintReachable(source: DetectedSource, sink: DetectedSink, content: string): boolean {
    if (source.line > sink.line) return false; // Source must come before sink

    const lines = content.split('\n');
    for (let i = source.line; i < sink.line - 1 && i < lines.length; i++) {
      if (lines[i].includes(source.variable)) return true;
    }

    // Also check if the sink line contains the source variable
    return lines[sink.line - 1]?.includes(source.variable) ?? false;
  }

  /**
   * Checks if a sanitizer appears between the source and sink lines.
   */
  private hasSanitizer(sourceLine: number, sinkLine: number, content: string): boolean {
    if (sourceLine >= sinkLine) return false;

    const lines = content.split('\n');
    for (let i = sourceLine; i < sinkLine - 1 && i < lines.length; i++) {
      for (const sanitizer of TAINT_SANITIZERS) {
        for (const pattern of sanitizer.patterns) {
          pattern.lastIndex = 0;
          if (pattern.test(lines[i])) return true;
        }
      }
    }

    return false;
  }

  /**
   * Converts a TaintFlow to a Finding.
   */
  private flowToFinding(flow: TaintFlow): Finding {
    const lastNode = flow.path[flow.path.length - 1];
    const firstNode = flow.path[0];

    return {
      id: `taint:${firstNode.file}:${firstNode.line}:${flow.sink.id}`,
      file: firstNode.file,
      line: firstNode.line,
      source: 'security',
      severity: flow.sink.severity,
      confidence: flow.confidence,
      title: `Taint flow: ${flow.source.name} → ${flow.sink.name}`,
      description: this.formatFlowDescription(flow),
      whyFlagged: `Untrusted data from ${flow.source.name} reaches ${flow.sink.name} (${flow.confidence} confidence)`,
      cwe: flow.cwe,
      fix: this.getFixSuggestion(flow),
    };
  }

  /**
   * Formats a human-readable description of the taint flow.
   */
  private formatFlowDescription(flow: TaintFlow): string {
    const steps = flow.path.map(node =>
      `${node.operation} at ${node.file}:${node.line} (${node.variable})`
    );
    return `Taint flow detected (${flow.confidence}):\n${steps.join(' → ')}`;
  }

  /**
   * Suggests a fix based on the taint flow.
   */
  private getFixSuggestion(flow: TaintFlow): string {
    if (flow.sink.id === 'eval') {
      return 'Never pass untrusted input to eval(). Use JSON.parse() for data or a safe interpreter for code.';
    }
    if (flow.sink.id === 'sql-construction') {
      return 'Use parameterized queries instead of string concatenation for SQL.';
    }
    if (flow.sink.id === 'child-process') {
      return 'Never pass untrusted input to exec(). Use execFile() with explicit arguments.';
    }
    if (flow.sink.id === 'template-render') {
      return 'Always escape user input before rendering. Use a templating engine with auto-escaping.';
    }
    return `Sanitize the input from ${flow.source.name} before passing it to ${flow.sink.name}.`;
  }
}

// ── Singleton pattern (follows existing codebase convention) ───────
let instance: TaintTracker | null = null;

/**
 * Gets the singleton TaintTracker instance.
 * Every service uses this pattern: `let instance: T | null = null`
 * with an exported `getXxx(): T` getter.
 */
export function getTaintTracker(): TaintTracker {
  if (!instance) instance = new TaintTracker();
  return instance;
}
