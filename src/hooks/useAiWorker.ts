/**
 * useAiWorker — hook to offload AI response parsing to a Web Worker.
 * Falls back to main-thread parsing if worker fails to load.
 */

import { useRef, useCallback, useEffect } from "react";
import { parseResponse } from "../utils/prompts";
import type { ParsedResponse } from "../utils/prompts";

let workerInstance: Worker | null = null;
const pendingCallbacks: Map<string, (result: ParsedResponse) => void> = new Map();
let idCounter = 0;

function getWorker(): Worker | null {
  if (workerInstance) return workerInstance;
  try {
    workerInstance = new Worker(
      new URL("../workers/ai-worker.ts", import.meta.url),
      { type: "module" }
    );
    workerInstance.onmessage = (event) => {
      const { type, id, result } = event.data;
      if (type === "parsed" && id) {
        const cb = pendingCallbacks.get(id);
        if (cb) {
          cb(result);
          pendingCallbacks.delete(id);
        }
      }
    };
    workerInstance.onerror = () => {
      // Worker failed — clear it so we fallback to main thread
      workerInstance = null;
    };
    return workerInstance;
  } catch {
    return null;
  }
}

/**
 * Parse an AI response using the Web Worker (off main thread).
 * Falls back to synchronous parsing if worker unavailable.
 */
export function parseResponseAsync(
  text: string,
  existingFiles: Set<string>
): Promise<ParsedResponse> {
  const worker = getWorker();

  if (!worker) {
    // Fallback: parse on main thread
    return Promise.resolve(parseResponse(text, existingFiles));
  }

  return new Promise((resolve) => {
    const id = `parse-${++idCounter}`;
    pendingCallbacks.set(id, resolve);

    // Timeout: if worker doesn't respond in 5s, fallback
    const timeout = setTimeout(() => {
      if (pendingCallbacks.has(id)) {
        pendingCallbacks.delete(id);
        resolve(parseResponse(text, existingFiles));
      }
    }, 5000);

    worker.postMessage({
      type: "parse",
      id,
      text,
      existingFiles: [...existingFiles],
    });

    // Clear timeout when resolved normally
    const originalCb = pendingCallbacks.get(id);
    if (originalCb) {
      pendingCallbacks.set(id, (result) => {
        clearTimeout(timeout);
        originalCb(result);
      });
    }
  });
}

/**
 * Hook version — provides parseResponseAsync with cleanup on unmount.
 */
export function useAiWorker() {
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  const parse = useCallback(
    (text: string, existingFiles: Set<string>): Promise<ParsedResponse> => {
      return parseResponseAsync(text, existingFiles);
    },
    []
  );

  return { parseResponseAsync: parse };
}
