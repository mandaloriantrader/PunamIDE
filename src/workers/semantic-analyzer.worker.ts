/**
 * @phase P4
 * @purpose Web Worker for off-thread type checking. Receives file
 *          paths + source content from main thread, initializes
 *          ts-morph Project in the worker, runs SemanticAnalyzer,
 *          and posts back Finding[] results.
 *
 * Uses the same message-passing pattern as debt-analyzer.worker.ts.
 */

import { type Finding, type SemanticAnalysisConfig } from '../services/review/types';
import { SemanticAnalyzer } from '../services/review/SemanticAnalyzer';

/** Request message from main thread. */
export interface SemanticWorkerRequest {
  type: 'analyze_v2';
  files: { path: string; content: string }[];
  config?: SemanticAnalysisConfig;
}

/** Response message to main thread. */
export interface SemanticWorkerResponse {
  type: 'results' | 'error' | 'ready';
  findings?: Finding[];
  error?: string;
}

// Initialize the analyzer (one-time setup)
let analyzer: SemanticAnalyzer | null = null;

try {
  analyzer = new SemanticAnalyzer();
  const response: SemanticWorkerResponse = { type: 'ready' };
  self.postMessage(response);
} catch (err) {
  // If ts-morph init fails, post error and self-terminate
  const response: SemanticWorkerResponse = {
    type: 'error',
    error: `Failed to initialize SemanticAnalyzer: ${err}`,
  };
  self.postMessage(response);
  self.close();
}

// Message handler
self.onmessage = (event: MessageEvent<SemanticWorkerRequest>) => {
  if (!analyzer) {
    const response: SemanticWorkerResponse = {
      type: 'error',
      error: 'Analyzer not initialized',
    };
    self.postMessage(response);
    return;
  }

  const { type, files, config } = event.data;

  if (type === 'analyze_v2') {
    try {
      const fileMap = new Map<string, string>();
      for (const file of files) {
        fileMap.set(file.path, file.content);
      }

      const results = analyzer.analyzeFiles(fileMap, config);
      const allFindings: Finding[] = [];
      for (const [, findings] of results) {
        allFindings.push(...findings);
      }

      const response: SemanticWorkerResponse = {
        type: 'results',
        findings: allFindings,
      };
      self.postMessage(response);
    } catch (err) {
      const response: SemanticWorkerResponse = {
        type: 'error',
        error: `Analysis failed: ${err}`,
      };
      self.postMessage(response);
    }
  }
};

// Export for module worker support
export {};
