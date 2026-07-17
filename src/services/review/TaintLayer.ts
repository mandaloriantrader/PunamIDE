/**
 * @phase P5
 * @purpose Taint analysis layer for the Unified Analysis Engine.
 *          Wraps TaintTracker to implement the AnalysisLayer interface.
 */

import { getTaintTracker, type TaintTracker } from './TaintTracker';
import type { AnalysisLayer, AnalysisContext, Finding, TaintConfig, UnifiedAnalysisConfig } from './types';

/**
 * Taint analysis layer that uses TaintTracker for cross-file taint flow detection.
 * This is an experimental feature - enable via taint config in unified analysis.
 */
export class TaintLayer implements AnalysisLayer {
  name = 'taint';
  private tracker: TaintTracker;

  constructor() {
    this.tracker = getTaintTracker();
  }

  isEnabled(config: UnifiedAnalysisConfig): boolean {
    // Taint is experimental — gate behind 'taint' in enabledLayers
    return config.enabledLayers?.includes('taint') ?? false;
  }

  async analyze(_files: string[], context: AnalysisContext): Promise<Finding[]> {
    const { graph, fileContents, config } = context;
    
    if (!graph || !fileContents) {
      return [];
    }

    const taintConfig: Partial<TaintConfig> = {
      maxHops: config.taint?.maxHops ?? 10,
      enabledSources: config.taint?.enabledSources ?? [],
      enabledSinks: config.taint?.enabledSinks ?? [],
      failClosedOnUnresolvable: config.taint?.failClosedOnUnresolvable ?? true,
    };

    // Convert Map<string, string> to Map<string, string> for TaintTracker
    const filesMap = new Map<string, string>();
    fileContents.forEach((content, path) => filesMap.set(path, content));

    return this.tracker.trackTaint(graph, filesMap, taintConfig);
  }
}

// ── Singleton pattern ───────
let instance: TaintLayer | null = null;

export function getTaintLayer(): TaintLayer {
  if (!instance) instance = new TaintLayer();
  return instance;
}