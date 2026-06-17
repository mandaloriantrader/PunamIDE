/**
 * Vector Store — Semantic code search using cosine similarity on code chunks.
 * Ported from Zenith IDE for Punam IDE.
 */

export interface EmbeddingVector {
  id: string;
  path: string;
  chunk: string;
  vector: number[];
  metadata: {
    language: string;
    startLine: number;
    endLine: number;
    symbolName?: string;
  };
}

export interface SearchHit {
  id: string;
  path: string;
  chunk: string;
  score: number;
  metadata: EmbeddingVector["metadata"];
}

function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) return 0;
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

function simpleHash(text: string): number[] {
  const vector = new Array(128).fill(0);
  const words = text.toLowerCase().split(/\W+/).filter(Boolean);
  for (const word of words) {
    for (let i = 0; i < word.length; i++) {
      const idx = (word.charCodeAt(i) * (i + 1)) % 128;
      vector[idx] += 1;
    }
  }
  const magnitude = Math.sqrt(vector.reduce((sum: number, v: number) => sum + v * v, 0));
  if (magnitude > 0) {
    for (let i = 0; i < vector.length; i++) vector[i] /= magnitude;
  }
  return vector;
}

export class VectorStore {
  private vectors: EmbeddingVector[] = [];
  private embeddingFn: (text: string) => Promise<number[]>;

  constructor(embeddingFn?: (text: string) => Promise<number[]>) {
    this.embeddingFn = embeddingFn || (async (text: string) => simpleHash(text));
  }

  async addDocument(doc: { path: string; content: string; language: string; chunkSize?: number }): Promise<void> {
    const chunkSize = doc.chunkSize || 500;
    const lines = doc.content.split("\n");

    for (let i = 0; i < lines.length; i += chunkSize) {
      const chunkLines = lines.slice(i, i + chunkSize);
      const text = chunkLines.join("\n");
      const vector = await this.embeddingFn(text);
      this.vectors.push({
        id: `${doc.path}:${i + 1}-${Math.min(i + chunkSize, lines.length)}`,
        path: doc.path,
        chunk: text,
        vector,
        metadata: { language: doc.language, startLine: i + 1, endLine: Math.min(i + chunkSize, lines.length) },
      });
    }
  }

  async search(query: string, topK = 5): Promise<SearchHit[]> {
    const queryVector = await this.embeddingFn(query);
    const scored = this.vectors.map((v) => ({ ...v, score: cosineSimilarity(queryVector, v.vector) }));
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, topK).map((s) => ({
      id: s.id, path: s.path, chunk: s.chunk, score: s.score, metadata: s.metadata,
    }));
  }

  removeByPath(path: string): void { this.vectors = this.vectors.filter((v) => v.path !== path); }
  clear(): void { this.vectors = []; }
  size(): number { return this.vectors.length; }

  setEmbeddingFunction(fn: (text: string) => Promise<number[]>): void { this.embeddingFn = fn; }
}

export const vectorStore = new VectorStore();
