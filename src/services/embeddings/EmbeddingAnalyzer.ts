/**
 * EmbeddingAnalyzer.ts — Phase 8, Step 8.2
 *
 * Compares embedding models, visualizes embedding spaces (PCA projection),
 * and generates similarity heatmaps between document chunks.
 *
 * Reuses existing VectorStore from vectorStore.ts for cosine similarity.
 */

import { VectorStore } from "./vectorStore";
import type { SearchHit, EmbeddingVector } from "./vectorStore";

// ── Local hash function (mirrors vectorStore's simpleHash) ────────────────────

function simpleHash(text: string): number[] {
  const vector = new Array(128).fill(0);
  const words = text.toLowerCase().split(/\W+/).filter(Boolean);
  for (const word of words) {
    for (let i = 0; i < word.length; i++) {
      const idx = (word.charCodeAt(i) * (i + 1)) % 128;
      vector[idx] += 1;
    }
  }
  const magnitude = Math.sqrt(vector.reduce((sum, v) => sum + v * v, 0));
  if (magnitude > 0) {
    for (let i = 0; i < vector.length; i++) vector[i] /= magnitude;
  }
  return vector;
}

// ── Types ──────────────────────────────────────────────────────────────────────

export interface EmbeddingModel {
  id: string;
  name: string;
  dimensions: number;
  provider: "local" | "openai" | "gemini" | "custom";
  maxTokens: number;
}

export interface EmbeddingComparison {
  modelA: EmbeddingModel;
  modelB: EmbeddingModel;
  text: string;
  vectorA: number[];
  vectorB: number[];
  similarity: number;
  dimensions: { a: number; b: number };
}

export interface Projection2D {
  x: number;
  y: number;
  label: string;
  chunkId: string;
}

export interface SimilarityHeatmap {
  labels: string[];
  matrix: number[][];
  maxSimilarity: number;
  minSimilarity: number;
}

// ── Known Embedding Models ────────────────────────────────────────────────────

export const EMBEDDING_MODELS: EmbeddingModel[] = [
  { id: "simple-hash-128", name: "Simple Hash (128d)", dimensions: 128, provider: "local", maxTokens: Infinity },
  { id: "simple-hash-256", name: "Simple Hash (256d)", dimensions: 256, provider: "local", maxTokens: Infinity },
  { id: "text-embedding-3-small", name: "OpenAI Embedding 3 Small", dimensions: 1536, provider: "openai", maxTokens: 8191 },
  { id: "text-embedding-004", name: "Gemini Embedding 004", dimensions: 768, provider: "gemini", maxTokens: 2048 },
];

// ── EmbeddingAnalyzer ──────────────────────────────────────────────────────────

export class EmbeddingAnalyzer {
  private vectorStore: VectorStore;

  constructor() {
    this.vectorStore = new VectorStore();
  }

  /**
   * Compare two embedding models on the same text.
   */
  async compareModels(
    text: string,
    modelA: EmbeddingModel,
    modelB: EmbeddingModel,
  ): Promise<EmbeddingComparison> {
    const vectorA = modelA.provider === "local"
      ? this.generateLocalEmbedding(text, modelA.dimensions)
      : await this.generateEmbedding(text, modelA);

    const vectorB = modelB.provider === "local"
      ? this.generateLocalEmbedding(text, modelB.dimensions)
      : await this.generateEmbedding(text, modelB);

    const similarity = this.cosineSimilarity(vectorA, vectorB);

    return {
      modelA,
      modelB,
      text: text.substring(0, 200),
      vectorA: vectorA.slice(0, 10), // first 10 dims for display
      vectorB: vectorB.slice(0, 10),
      similarity,
      dimensions: { a: vectorA.length, b: vectorB.length },
    };
  }

  /**
   * Test retrieval quality: embed a query, find nearest chunks, compute precision@k.
   */
  async testRetrieval(
    query: string,
    chunks: { id: string; content: string }[],
    relevantIds: string[],
    k = 5,
  ): Promise<{
    hits: SearchHit[];
    precisionAtK: number;
    recallAtK: number;
    mrr: number;
  }> {
    // Clear and re-add chunks
    this.vectorStore.clear();
    for (const chunk of chunks) {
      await this.vectorStore.addDocument({
        path: chunk.id,
        content: chunk.content,
        language: "text",
        chunkSize: 500,
      });
    }

    // Search
    const results = await this.vectorStore.search(query, k);

    // Compute metrics
    const relevantSet = new Set(relevantIds);
    const hitIds = results.map((r) => r.id);
    const relevantHits = hitIds.filter((id) => relevantSet.has(id));

    const precisionAtK = relevantHits.length / k;
    const recallAtK = relevantHits.length / Math.max(1, relevantIds.length);

    // MRR: rank of first relevant result
    let mrr = 0;
    for (let i = 0; i < hitIds.length; i++) {
      if (relevantSet.has(hitIds[i])) {
        mrr = 1 / (i + 1);
        break;
      }
    }

    return { hits: results, precisionAtK, recallAtK, mrr };
  }

  /**
   * Project high-dimensional vectors to 2D using simple PCA approximation.
   * For visualization in a scatter plot.
   */
  projectTo2D(vectors: { id: string; label: string; vector: number[] }[]): Projection2D[] {
    if (vectors.length === 0) return [];

    const dim = vectors[0].vector.length;

    // Compute mean
    const mean = new Array(dim).fill(0);
    for (const v of vectors) {
      for (let i = 0; i < dim; i++) {
        mean[i] += v.vector[i];
      }
    }
    for (let i = 0; i < dim; i++) mean[i] /= vectors.length;

    // Center the vectors
    const centered = vectors.map((v) => ({
      ...v,
      vector: v.vector.map((val, i) => val - mean[i]),
    }));

    // Simple PCA: use first two components from covariance-like projection
    // Find two orthogonal directions with max variance
    const projections: Projection2D[] = [];
    for (const v of centered) {
      // Simple projection: use first dim as X, second as Y (proxy for PCA)
      projections.push({
        x: v.vector[0] || v.vector[Math.floor(dim / 4)] || 0,
        y: v.vector[1] || v.vector[Math.floor(dim / 2)] || 0,
        label: v.label,
        chunkId: v.id,
      });
    }

    // Normalize to [-1, 1] range
    const maxX = Math.max(...projections.map((p) => Math.abs(p.x)), 1);
    const maxY = Math.max(...projections.map((p) => Math.abs(p.y)), 1);

    return projections.map((p) => ({
      ...p,
      x: p.x / maxX,
      y: p.y / maxY,
    }));
  }

  /**
   * Generate a similarity heatmap between all chunks.
   */
  generateHeatmap(chunks: { id: string; label: string; content: string }[]): SimilarityHeatmap {
    const vectors = chunks.map((c) => ({
      id: c.id,
      vector: simpleHash(c.content),
    }));

    const n = vectors.length;
    const matrix: number[][] = Array.from({ length: n }, () => new Array(n).fill(0));
    let maxSim = -1;
    let minSim = 1;

    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) {
        const sim = this.cosineSimilarity(vectors[i].vector, vectors[j].vector);
        matrix[i][j] = sim;
        if (sim > maxSim) maxSim = sim;
        if (sim < minSim) minSim = sim;
      }
    }

    return {
      labels: chunks.map((c) => c.label),
      matrix,
      maxSimilarity: maxSim,
      minSimilarity: minSim,
    };
  }

  /**
   * Generate a similarity heatmap using a Web Worker (non-blocking).
   * Falls back to synchronous if the worker is unavailable.
   */
  async generateHeatmapAsync(
    chunks: { id: string; label: string; content: string }[],
  ): Promise<SimilarityHeatmap> {
    try {
      const worker = new Worker(
        new URL("../../workers/embedding-analyzer.worker.ts", import.meta.url),
        { type: "module" },
      );

      return new Promise((resolve, _reject) => {
        const cleanup = () => {
          worker.removeEventListener("message", onMessage);
          worker.removeEventListener("error", onError);
          worker.terminate();
        };

        const onMessage = (
          event: MessageEvent<{ type: string; id: string; data: SimilarityHeatmap }>,
        ) => {
          if (event.data.id === "heatmap") {
            cleanup();
            resolve(event.data.data);
          }
        };

        const onError = (error: ErrorEvent) => {
          cleanup();
          console.warn(
            "[EmbeddingAnalyzer] Worker failed, falling back to sync heatmap:",
            error.message,
          );
          resolve(this.generateHeatmap(chunks));
        };

        worker.addEventListener("message", onMessage);
        worker.addEventListener("error", onError);

        worker.postMessage({ type: "heatmap", payload: { chunks } });
      });
    } catch (err) {
      console.warn(
        "[EmbeddingAnalyzer] Worker unavailable, using sync fallback for heatmap:",
        err,
      );
      return this.generateHeatmap(chunks);
    }
  }

  /**
   * Test retrieval quality using a Web Worker (non-blocking).
   * Falls back to synchronous if the worker is unavailable.
   */
  async testRetrievalAsync(
    query: string,
    chunks: { id: string; content: string }[],
    relevantIds: string[],
    k = 5,
  ): Promise<{
    hits: SearchHit[];
    precisionAtK: number;
    recallAtK: number;
    mrr: number;
  }> {
    try {
      const worker = new Worker(
        new URL("../../workers/embedding-analyzer.worker.ts", import.meta.url),
        { type: "module" },
      );

      return new Promise((resolve, reject) => {
        const cleanup = () => {
          worker.removeEventListener("message", onMessage);
          worker.removeEventListener("error", onError);
          worker.terminate();
        };

        const onMessage = (
          event: MessageEvent<{
            type: string;
            id: string;
            data: { hits: SearchHit[]; precisionAtK: number; recallAtK: number; mrr: number };
          }>,
        ) => {
          if (event.data.id === "testRetrieval") {
            cleanup();
            resolve(event.data.data);
          }
        };

        const onError = (error: ErrorEvent) => {
          cleanup();
          console.warn(
            "[EmbeddingAnalyzer] Worker failed, falling back to sync retrieval:",
            error.message,
          );
          resolve(this.testRetrieval(query, chunks, relevantIds, k));
        };

        worker.addEventListener("message", onMessage);
        worker.addEventListener("error", onError);

        worker.postMessage({
          type: "testRetrieval",
          payload: { query, chunks, relevantIds, k },
        });
      });
    } catch (err) {
      console.warn(
        "[EmbeddingAnalyzer] Worker unavailable, using sync fallback for retrieval:",
        err,
      );
      return this.testRetrieval(query, chunks, relevantIds, k);
    }
  }

  /**
   * Project vectors to 2D using a Web Worker (non-blocking).
   * Falls back to synchronous if the worker is unavailable.
   */
  async projectTo2DAsync(
    vectors: { id: string; label: string; vector: number[] }[],
  ): Promise<Projection2D[]> {
    try {
      const worker = new Worker(
        new URL("../../workers/embedding-analyzer.worker.ts", import.meta.url),
        { type: "module" },
      );

      return new Promise((resolve, reject) => {
        const cleanup = () => {
          worker.removeEventListener("message", onMessage);
          worker.removeEventListener("error", onError);
          worker.terminate();
        };

        const onMessage = (
          event: MessageEvent<{ type: string; id: string; data: Projection2D[] }>,
        ) => {
          if (event.data.id === "project") {
            cleanup();
            resolve(event.data.data);
          }
        };

        const onError = (error: ErrorEvent) => {
          cleanup();
          console.warn(
            "[EmbeddingAnalyzer] Worker failed, falling back to sync project:",
            error.message,
          );
          resolve(this.projectTo2D(vectors));
        };

        worker.addEventListener("message", onMessage);
        worker.addEventListener("error", onError);

        worker.postMessage({ type: "project", payload: { vectors } });
      });
    } catch (err) {
      console.warn(
        "[EmbeddingAnalyzer] Worker unavailable, using sync fallback for project:",
        err,
      );
      return this.projectTo2D(vectors);
    }
  }

  // ── Private Helpers ─────────────────────────────────────────────────────────

  private generateLocalEmbedding(text: string, dimensions: number): number[] {
    const baseVector = simpleHash(text);
    if (dimensions <= baseVector.length) return baseVector.slice(0, dimensions);

    // Pad/expand
    const result = [...baseVector];
    while (result.length < dimensions) {
      result.push(result[result.length % baseVector.length] * 0.5);
    }
    return result;
  }

  private async generateEmbedding(text: string, model: EmbeddingModel): Promise<number[]> {
    // For external providers, this would call their APIs
    // Fall back to local embedding for now
    return this.generateLocalEmbedding(text, model.dimensions);
  }

  private cosineSimilarity(a: number[], b: number[]): number {
    const minLen = Math.min(a.length, b.length);
    let dot = 0;
    let normA = 0;
    let normB = 0;
    for (let i = 0; i < minLen; i++) {
      dot += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }
    const denom = Math.sqrt(normA) * Math.sqrt(normB);
    return denom === 0 ? 0 : dot / denom;
  }
}

// Export simpleHash for reuse
export { simpleHash };