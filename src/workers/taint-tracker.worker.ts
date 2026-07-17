/**
 * @phase P5
 * @purpose Web Worker for off-thread taint tracking. Receives graph
 *          data + file sources from main thread, runs TaintTracker,
 *          and posts back Finding[] results.
 */

import { type Finding, type DependencyGraph, type TaintConfig } from '../services/review/types';
import { TaintTracker } from '../services/review/TaintTracker';

/** Request message from main thread. */
export interface TaintWorkerRequest {
  type: 'analyze_v2';
  graph: DependencyGraph;
  files: { path: string; content: string }[];
  config?: TaintConfig;
}

/** Response message to main thread. */
export interface TaintWorkerResponse {
  type: 'results' | 'error' | 'ready';
  findings?: Finding[];
  error?: string;
}

let tracker: TaintTracker | null = null;

try {
  tracker = new TaintTracker();
  self.postMessage({ type: 'ready' } as TaintWorkerResponse);
} catch (err) {
  self.postMessage({
    type: 'error',
    error: `Failed to initialize TaintTracker: ${err}`,
  } as TaintWorkerResponse);
  self.close();
}

self.onmessage = (event: MessageEvent<TaintWorkerRequest>) => {
  if (!tracker) {
    self.postMessage({ type: 'error', error: 'Tracker not initialized' } as TaintWorkerResponse);
    return;
  }

  const { type, graph, files, config } = event.data;

  if (type === 'analyze_v2') {
    try {
      const fileMap = new Map<string, string>();
      for (const file of files) {
        fileMap.set(file.path, file.content);
      }

      const findings = tracker.trackTaint(graph, fileMap, config);
      self.postMessage({ type: 'results', findings } as TaintWorkerResponse);
    } catch (err) {
      self.postMessage({
        type: 'error',
        error: `Taint tracking failed: ${err}`,
      } as TaintWorkerResponse);
    }
  }
};

export {};
