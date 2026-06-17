/**
 * AI Worker — offloads AI provider streaming calls from the main thread.
 * 
 * NOTE: In Tauri, AI calls go through Rust IPC (invoke), which is already async.
 * This worker is a future-proofing layer for when we add direct HTTP calls
 * (e.g., for MCP servers or custom endpoints that bypass Rust).
 * 
 * For now, it handles:
 * - Token batching coordination
 * - Response parsing off the main thread
 * - Future: direct fetch() calls to AI providers
 * 
 * Communication:
 *   Main → Worker: { type: "parse", text, existingFiles }
 *   Worker → Main: { type: "parsed", result }
 */

// Import the parser (works in worker context since it's pure logic)
import { parseResponse } from "../utils/prompts";
import type { ParsedResponse } from "../utils/prompts";

export interface WorkerMessage {
  type: "parse";
  id: string;
  text: string;
  existingFiles: string[];
}

export interface WorkerResponse {
  type: "parsed";
  id: string;
  result: ParsedResponse;
}

self.onmessage = (event: MessageEvent<WorkerMessage>) => {
  const { type, id, text, existingFiles } = event.data;

  if (type === "parse") {
    // Parse AI response off the main thread
    const fileSet = new Set(existingFiles);
    const result = parseResponse(text, fileSet);
    const response: WorkerResponse = { type: "parsed", id, result };
    self.postMessage(response);
  }
};

export {};
