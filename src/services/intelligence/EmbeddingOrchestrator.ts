/**
 * EmbeddingOrchestrator.ts — Orchestrates the full embedding pipeline end-to-end.
 *
 * Flow:
 *   1. Fetch code chunks from Rust (embedding_pipeline_get_chunks)
 *   2. Send chunks to the Web Worker for ONNX/Transformers.js embedding generation
 *   3. Store generated embeddings back in Rust (embedding_pipeline_store_batch)
 *   4. Provide semantic search API for agent tools
 *
 * Designed to run in the background after project open without blocking the UI.
 * Gracefully handles: worker load failures, partial batches, and re-indexing.
 */

import {
  getEmbeddingChunks,
  storeEmbeddingBatch,
  semanticSearch,
  getEmbeddingPipelineStats,
  type EmbeddingChunkPayload,
  type SemanticSearchResult,
  type EmbeddingPipelineStats,
} from "./EmbeddingPipelineService";

// ── Types ─────────────────────────────────────────────────────────────────────

export type EmbeddingStatus =
  | "idle"
  | "loading_model"
  | "indexing"
  | "ready"
  | "error"
  | "unavailable";

export interface EmbeddingProgress {
  status: EmbeddingStatus;
  chunksProcessed: number;
  chunksTotal: number;
  error?: string;
}

type ProgressCallback = (progress: EmbeddingProgress) => void;

// ── Singleton State ───────────────────────────────────────────────────────────

let worker: Worker | null = null;
let workerReady = false;
let currentStatus: EmbeddingStatus = "idle";
let progressCallbacks: ProgressCallback[] = [];

function notifyProgress(progress: EmbeddingProgress) {
  currentStatus = progress.status;
  for (const cb of progressCallbacks) {
    try { cb(progress); } catch { /* ignore */ }
  }
}

// ── Worker Management ─────────────────────────────────────────────────────────

function getOrCreateWorker(): Worker | null {
  if (worker) return worker;
  try {
    worker = new Worker(
      new URL("../../workers/embedding-generator.worker.ts", import.meta.url),
      { type: "module" }
    );
    worker.onerror = (err) => {
      console.warn("[EmbeddingOrchestrator] Worker error:", err.message);
      notifyProgress({ status: "error", chunksProcessed: 0, chunksTotal: 0, error: err.message });
      workerReady = false;
    };
    return worker;
  } catch (err) {
    console.warn("[EmbeddingOrchestrator] Failed to create worker:", err);
    notifyProgress({ status: "unavailable", chunksProcessed: 0, chunksTotal: 0, error: String(err) });
    return null;
  }
}

function terminateWorker() {
  if (worker) {
    worker.terminate();
    worker = null;
    workerReady = false;
  }
}

/**
 * Wait for the worker to post a "ready" message (model loaded).
 * Times out after 60s since the model download is ~23MB first time.
 */
function waitForWorkerReady(w: Worker): Promise<boolean> {
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      resolve(false);
    }, 60_000);

    const handler = (event: MessageEvent) => {
      if (event.data.type === "ready") {
        clearTimeout(timeout);
        w.removeEventListener("message", handler);
        workerReady = true;
        resolve(true);
      } else if (event.data.type === "error" && event.data.id === "init") {
        clearTimeout(timeout);
        w.removeEventListener("message", handler);
        resolve(false);
      }
    };
    w.addEventListener("message", handler);
  });
}

/**
 * Send a batch of chunks to the worker and wait for embeddings.
 */
function generateEmbeddingsBatch(
  w: Worker,
  chunks: EmbeddingChunkPayload[],
  batchId: string,
): Promise<Array<{ chunk_id: string; embedding: number[] }>> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error("Embedding generation timed out (300s)"));
    }, 300_000);

    const handler = (event: MessageEvent) => {
      const { type, id, embeddings, error } = event.data;
      if (id !== batchId) return;

      if (type === "result") {
        clearTimeout(timeout);
        w.removeEventListener("message", handler);
        resolve(embeddings);
      } else if (type === "error") {
        clearTimeout(timeout);
        w.removeEventListener("message", handler);
        reject(new Error(error));
      }
      // "progress" events are informational — we handle them elsewhere
    };
    w.addEventListener("message", handler);
    w.postMessage({ type: "generate", chunks, id: batchId });
  });
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Subscribe to embedding progress updates.
 * Returns an unsubscribe function.
 */
export function onEmbeddingProgress(callback: ProgressCallback): () => void {
  progressCallbacks.push(callback);
  return () => {
    progressCallbacks = progressCallbacks.filter((cb) => cb !== callback);
  };
}

/** Get the current status without subscribing. */
export function getEmbeddingStatus(): EmbeddingStatus {
  return currentStatus;
}

/**
 * Run the full embedding pipeline: fetch chunks → generate embeddings → store.
 *
 * This is designed to be called once after project open (fire-and-forget).
 * It processes in batches of 30 to avoid overwhelming the worker.
 * Skips chunks that are already embedded (based on stats).
 *
 * Safe to call multiple times — will skip if already running or complete.
 */
let indexingInProgress = false;

export async function runEmbeddingPipeline(): Promise<void> {
  if (indexingInProgress) return;
  if (currentStatus === "ready") return; // Already done this session

  indexingInProgress = true;

  try {
    // 1. Check if there's anything to embed
    let stats: EmbeddingPipelineStats;
    try {
      stats = await getEmbeddingPipelineStats();
    } catch {
      // Codebase not indexed yet — can't generate embeddings
      notifyProgress({ status: "idle", chunksProcessed: 0, chunksTotal: 0 });
      return;
    }

    const totalChunks = stats.total_chunks_indexed;
    const alreadyStored = stats.total_embeddings_stored;

    // If most chunks are already embedded, skip (allow 10% drift for incremental)
    if (alreadyStored > 0 && alreadyStored >= totalChunks * 0.9) {
      notifyProgress({ status: "ready", chunksProcessed: alreadyStored, chunksTotal: totalChunks });
      return;
    }

    if (totalChunks === 0) {
      notifyProgress({ status: "idle", chunksProcessed: 0, chunksTotal: 0 });
      return;
    }

    // 2. Initialize the worker
    notifyProgress({ status: "loading_model", chunksProcessed: 0, chunksTotal: totalChunks });
    const w = getOrCreateWorker();
    if (!w) {
      notifyProgress({ status: "unavailable", chunksProcessed: 0, chunksTotal: totalChunks, error: "Worker creation failed" });
      return;
    }

    if (!workerReady) {
      const ready = await waitForWorkerReady(w);
      if (!ready) {
        notifyProgress({
          status: "unavailable",
          chunksProcessed: 0,
          chunksTotal: totalChunks,
          error: "Embedding model failed to load. Install: npm install @xenova/transformers",
        });
        terminateWorker();
        return;
      }
    }

    // 3. Process in batches
    notifyProgress({ status: "indexing", chunksProcessed: 0, chunksTotal: totalChunks });
    const BATCH_SIZE = 30;
    let processed = 0;

    for (let offset = 0; offset < totalChunks; offset += BATCH_SIZE) {
      const chunks = await getEmbeddingChunks(offset, BATCH_SIZE);
      if (chunks.length === 0) break;

      const batchId = `batch-${offset}`;
      try {
        const embeddings = await generateEmbeddingsBatch(w, chunks, batchId);

        // Store: merge chunk metadata with generated embeddings
        const batch = embeddings.map((emb) => {
          const chunk = chunks.find((c) => c.chunk_id === emb.chunk_id);
          return {
            chunk_id: emb.chunk_id,
            file_path: chunk?.file_path || "",
            chunk_text: chunk?.chunk_text || "",
            start_line: chunk?.start_line || 0,
            end_line: chunk?.end_line || 0,
            embedding: emb.embedding,
          };
        });

        await storeEmbeddingBatch(batch);
        processed += embeddings.length;
        notifyProgress({ status: "indexing", chunksProcessed: processed, chunksTotal: totalChunks });
      } catch (err) {
        console.warn(`[EmbeddingOrchestrator] Batch ${batchId} failed:`, err);
        // Continue with next batch — partial indexing is still useful
      }
    }

    notifyProgress({ status: "ready", chunksProcessed: processed, chunksTotal: totalChunks });
  } catch (err) {
    notifyProgress({
      status: "error",
      chunksProcessed: 0,
      chunksTotal: 0,
      error: String(err),
    });
  } finally {
    indexingInProgress = false;
  }
}

/**
 * Perform a semantic search using a text query.
 *
 * Generates an embedding for the query text using the worker, then searches
 * the stored code embeddings via Rust for similar chunks.
 *
 * Returns null if the embedding pipeline isn't ready.
 */
export async function semanticCodeSearch(
  queryText: string,
  topK: number = 5,
): Promise<SemanticSearchResult | null> {
  // If no embeddings are stored, fall back
  try {
    const stats = await getEmbeddingPipelineStats();
    if (stats.total_embeddings_stored === 0) return null;
  } catch {
    return null;
  }

  // Generate embedding for the query
  const w = getOrCreateWorker();
  if (!w || !workerReady) return null;

  try {
    const queryChunk: EmbeddingChunkPayload = {
      chunk_id: "query",
      file_path: "",
      chunk_text: queryText,
      start_line: 0,
      end_line: 0,
      chunk_type: "query",
      name: "query",
      signature: "",
      imports: [],
    };

    const embeddings = await generateEmbeddingsBatch(w, [queryChunk], "query-search");
    if (embeddings.length === 0) return null;

    const queryEmbedding = embeddings[0].embedding;
    return await semanticSearch(queryEmbedding, topK);
  } catch (err) {
    console.warn("[EmbeddingOrchestrator] Semantic search failed:", err);
    return null;
  }
}

/** Force re-index all chunks (useful after major code changes). */
export async function reindexEmbeddings(): Promise<void> {
  currentStatus = "idle";
  indexingInProgress = false;
  await runEmbeddingPipeline();
}

/** Get current pipeline statistics. */
export { getEmbeddingPipelineStats as getStats };
