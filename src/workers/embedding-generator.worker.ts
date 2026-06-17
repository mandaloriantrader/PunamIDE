/**
 * Embedding Generator Worker — Off-thread embedding generation via Transformers.js.
 *
 * This worker loads all-MiniLM-L6-v2 (384-dim, ~23MB) via @xenova/transformers
 * and exposes a simple message-based API:
 *
 *   Worker → Main: { type: "ready" }
 *   Main → Worker: { type: "generate", chunks: EmbeddingChunkPayload[], id: string }
 *   Worker → Main: { type: "result", id: string, embeddings: Array<{chunk_id: string, embedding: number[]}> }
 *   Worker → Main: { type: "error", id: string, error: string }
 *   Worker → Main: { type: "progress", id: string, done: number, total: number }
 *
 * Usage from main thread:
 *   const worker = new Worker(new URL("./embedding-generator.worker.ts", import.meta.url), { type: "module" });
 *   worker.postMessage({ type: "generate", chunks, id: "batch-1" });
 */

// We use dynamic import for the transformers library since it may not be installed
let model: any = null;
const MODEL_NAME = "Xenova/all-MiniLM-L6-v2";

async function loadModel(): Promise<void> {
  if (model) return;
  try {
    // Dynamic import to avoid bundling if not installed
    const { pipeline } = await import("@xenova/transformers");
    model = await pipeline("feature-extraction", MODEL_NAME);
    postMessage({ type: "ready" });
  } catch (err) {
    postMessage({ type: "error", id: "init", error: `Failed to load embedding model: ${String(err)}. Run: npm install @xenova/transformers` });
  }
}

// Start loading on worker init
loadModel();

self.onmessage = async (event: MessageEvent) => {
  const { type, chunks, id } = event.data;

  if (type === "generate") {
    if (!model) {
      postMessage({ type: "error", id, error: "Model not loaded yet" });
      return;
    }

    try {
      const embeddings: Array<{ chunk_id: string; embedding: number[] }> = [];
      const total = chunks.length;

      for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i];
        // Truncate long chunks to keep inference fast (512 token limit for MiniLM)
        const text = chunk.chunk_text.slice(0, 2000);

        // Extract the [CLS] token embedding or mean pool
        const output = await model(text, { pooling: "mean", normalize: true });
        // output is Float32Array, convert to regular number[]
        const vector: number[] = Array.from(output.data as Float32Array);

        embeddings.push({
          chunk_id: chunk.chunk_id,
          embedding: vector,
        });

        // Report progress every 10 chunks
        if (i % 10 === 0 || i === total - 1) {
          postMessage({ type: "progress", id, done: i + 1, total });
        }
      }

      postMessage({ type: "result", id, embeddings });
    } catch (err) {
      postMessage({ type: "error", id, error: String(err) });
    }
  }
};

// Ensure TypeScript knows this is a worker context
export {};