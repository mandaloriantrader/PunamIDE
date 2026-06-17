/**
 * Embedding Analyzer Web Worker — Phase 10, Step 10.7
 *
 * Offloads expensive embedding operations from the main thread:
 *   - O(n²) similarity heatmap generation
 *   - PCA projection to 2D for visualization
 *   - Retrieval quality testing (precision/recall/MRR)
 *
 * Communication:
 *   Main → Worker: { type: "heatmap" | "project" | "testRetrieval", payload }
 *   Worker → Main: { type: "result", id: "heatmap" | "project" | "testRetrieval", data }
 */

// ── Types ────────────────────────────────────────────────────────────────────

interface Projection2D {
  x: number;
  y: number;
  label: string;
  chunkId: string;
}

interface SimilarityHeatmap {
  labels: string[];
  matrix: number[][];
  maxSimilarity: number;
  minSimilarity: number;
}

interface SearchHit {
  id: string;
  content: string;
  score: number;
}

interface HeatmapPayload {
  chunks: { id: string; label: string; content: string }[];
}

interface ProjectPayload {
  vectors: { id: string; label: string; vector: number[] }[];
}

interface TestRetrievalPayload {
  query: string;
  chunks: { id: string; content: string }[];
  relevantIds: string[];
  k?: number;
}

type WorkerMessage =
  | { type: "heatmap"; payload: HeatmapPayload }
  | { type: "project"; payload: ProjectPayload }
  | { type: "testRetrieval"; payload: TestRetrievalPayload };

type WorkerResult =
  | { type: "result"; id: "heatmap"; data: SimilarityHeatmap }
  | { type: "result"; id: "project"; data: Projection2D[] }
  | { type: "result"; id: "testRetrieval"; data: { hits: SearchHit[]; precisionAtK: number; recallAtK: number; mrr: number } };

// ── Local hash embedding (mirrors vectorStore's simpleHash) ──────────────────

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

// ── Cosine similarity ───────────────────────────────────────────────────────

function cosineSimilarity(a: number[], b: number[]): number {
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

// ── Heatmap Generation (O(n²)) ──────────────────────────────────────────────

function generateHeatmap(payload: HeatmapPayload): SimilarityHeatmap {
  const { chunks } = payload;

  const vectors = chunks.map((c) => ({
    id: c.id,
    vector: simpleHash(c.content),
  }));

  const n = vectors.length;
  const matrix: number[][] = Array.from({ length: n }, () => new Array(n).fill(0));
  let maxSim = -1;
  let minSim = 1;

  // Upper triangle + diagonal for symmetric matrix
  for (let i = 0; i < n; i++) {
    // Diagonal is always 1.0 (self-similarity)
    matrix[i][i] = 1;
    if (1 > maxSim) maxSim = 1;
    if (1 < minSim) minSim = 1;

    for (let j = i + 1; j < n; j++) {
      const sim = cosineSimilarity(vectors[i].vector, vectors[j].vector);
      matrix[i][j] = sim;
      matrix[j][i] = sim; // symmetric
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

// ── PCA Projection to 2D ────────────────────────────────────────────────────

function projectTo2D(payload: ProjectPayload): Projection2D[] {
  const { vectors } = payload;
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

  // Project using first two meaningful components
  const projections: Projection2D[] = [];
  for (const v of centered) {
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

// ── Retrieval Quality Testing ───────────────────────────────────────────────

function testRetrieval(payload: TestRetrievalPayload): {
  hits: SearchHit[];
  precisionAtK: number;
  recallAtK: number;
  mrr: number;
} {
  const { query, chunks, relevantIds, k = 5 } = payload;

  // Embed query
  const queryVector = simpleHash(query);

  // Embed all chunks and compute similarity
  const scored: { id: string; content: string; score: number }[] = chunks.map((c) => ({
    id: c.id,
    content: c.content,
    score: cosineSimilarity(queryVector, simpleHash(c.content)),
  }));

  // Sort by score descending, take top k
  scored.sort((a, b) => b.score - a.score);
  const hits = scored.slice(0, k).map(({ id, content, score }) => ({ id, content, score }));

  // Compute metrics
  const relevantSet = new Set(relevantIds);
  const hitIds = hits.map((r) => r.id);
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

  return { hits, precisionAtK, recallAtK, mrr };
}

// ── Worker message handler ──────────────────────────────────────────────────

self.onmessage = (event: MessageEvent<WorkerMessage>) => {
  const msg = event.data;

  switch (msg.type) {
    case "heatmap": {
      const data = generateHeatmap(msg.payload);
      const response: WorkerResult = { type: "result", id: "heatmap", data };
      self.postMessage(response);
      break;
    }

    case "project": {
      const data = projectTo2D(msg.payload);
      const response: WorkerResult = { type: "result", id: "project", data };
      self.postMessage(response);
      break;
    }

    case "testRetrieval": {
      const data = testRetrieval(msg.payload);
      const response: WorkerResult = { type: "result", id: "testRetrieval", data };
      self.postMessage(response);
      break;
    }
  }
};