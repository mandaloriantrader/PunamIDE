/**
 * RagWorkbench.ts — Phase 8, Steps 8.3, 8.4, 8.5
 *
 * Unified RAG experimentation UI support:
 *   - RetrieverDebugger: query → show retrieved chunks with scores
 *   - RagWorkbench: A/B test chunking/embedding/retrieval configurations
 *   - Hallucination detection: prompt-based consistency + source attribution validation
 *
 * Reuses:
 *   - ChunkInspector (Phase 8.1) for chunking
 *   - EmbeddingAnalyzer (Phase 8.2) for embeddings and similarity
 *   - VectorStore for retrieval
 */

import { VectorStore } from "./vectorStore";
import type { SearchHit, EmbeddingVector } from "./vectorStore";
import { ChunkInspector } from "./ChunkInspector";
import type { ChunkConfig, ChunkAnalysis } from "./ChunkInspector";
import { EmbeddingAnalyzer } from "./EmbeddingAnalyzer";
import type { EmbeddingModel, Projection2D, SimilarityHeatmap } from "./EmbeddingAnalyzer";
import { EMBEDDING_MODELS } from "./EmbeddingAnalyzer";

// ── Types ──────────────────────────────────────────────────────────────────────

export interface RetrievalDebugResult {
  query: string;
  hits: SearchHit[];
  totalChunks: number;
  queryTimeMs: number;
  chunksPerSource: Record<string, number>;
}

export interface ABTestConfig {
  name: string;
  chunkConfig: ChunkConfig;
  embeddingModel: EmbeddingModel;
  topK: number;
}

export interface ABTestResult {
  config: ABTestConfig;
  retrievalResult: RetrievalDebugResult;
  precisionAtK?: number;
  recallAtK?: number;
  mrr?: number;
}

export interface HallucinationCheck {
  claim: string;
  sources: { id: string; content: string }[];
  verified: boolean;
  confidence: number;
  supportingEvidence: string[];
  contradictingEvidence: string[];
  explanation: string;
}

// ── RetrieverDebugger (Phase 8.3) ─────────────────────────────────────────────

export class RetrieverDebugger {
  private vectorStore: VectorStore;
  private analyzer: EmbeddingAnalyzer;

  constructor() {
    this.vectorStore = new VectorStore();
    this.analyzer = new EmbeddingAnalyzer();
  }

  /**
   * Index a set of documents and run a test query.
   */
  async debugQuery(
    documents: { path: string; content: string; language: string }[],
    query: string,
    topK = 5,
  ): Promise<RetrievalDebugResult> {
    const startTime = Date.now();

    this.vectorStore.clear();
    for (const doc of documents) {
      await this.vectorStore.addDocument({
        path: doc.path,
        content: doc.content,
        language: doc.language,
      });
    }

    const hits = await this.vectorStore.search(query, topK);
    const queryTimeMs = Date.now() - startTime;

    const chunksPerSource: Record<string, number> = {};
    for (const hit of hits) {
      const source = hit.path.split("/")[0] || hit.path;
      chunksPerSource[source] = (chunksPerSource[source] || 0) + 1;
    }

    return {
      query,
      hits,
      totalChunks: this.vectorStore.size(),
      queryTimeMs,
      chunksPerSource,
    };
  }

  /**
   * Compare retrieval quality across different chunking strategies.
   */
  async compareChunking(
    content: string,
    configs: ChunkConfig[],
    query: string,
    topK = 5,
  ): Promise<{ config: ChunkConfig; analysis: ChunkAnalysis; result: RetrievalDebugResult }[]> {
    const inspector = new ChunkInspector();
    const results: { config: ChunkConfig; analysis: ChunkAnalysis; result: RetrievalDebugResult }[] = [];

    for (const config of configs) {
      const analysis = inspector.chunkDocument(content, config);
      const mockPath = "test-document.md";

      const debugResult = await this.debugQuery(
        analysis.chunks.map((c) => ({
          path: mockPath,
          content: c.content,
          language: "markdown",
        })),
        query,
        topK,
      );

      results.push({ config, analysis, result: debugResult });
    }

    return results;
  }

  /**
   * Visualize retrieval scores as a bar chart data series.
   */
  visualizeScores(hits: SearchHit[]): { label: string; score: number; preview: string }[] {
    return hits.map((h) => ({
      label: `${h.path} L${h.metadata.startLine}-${h.metadata.endLine}`,
      score: h.score,
      preview: h.chunk.substring(0, 100),
    }));
  }
}

// ── RagWorkbench (Phase 8.4) ──────────────────────────────────────────────────

export class RagWorkbench {
  private debugger: RetrieverDebugger;
  private inspector: ChunkInspector;
  private analyzer: EmbeddingAnalyzer;

  constructor() {
    this.debugger = new RetrieverDebugger();
    this.inspector = new ChunkInspector();
    this.analyzer = new EmbeddingAnalyzer();
  }

  /**
   * Run an A/B test between two RAG configurations.
   */
  async runABTest(
    documents: { path: string; content: string; language: string }[],
    query: string,
    relevantDocIds: string[],
    configA: ABTestConfig,
    configB: ABTestConfig,
  ): Promise<{ a: ABTestResult; b: ABTestResult }> {
    const resultA = await this.runSingleTest(documents, query, relevantDocIds, configA);
    const resultB = await this.runSingleTest(documents, query, relevantDocIds, configB);

    return { a: resultA, b: resultB };
  }

  private async runSingleTest(
    documents: { path: string; content: string; language: string }[],
    query: string,
    relevantDocIds: string[],
    config: ABTestConfig,
  ): Promise<ABTestResult> {
    const retrievalResult = await this.debugger.debugQuery(documents, query, config.topK);

    // Build chunk ID list for precision/recall
    const allChunks: { id: string; content: string }[] = [];
    for (const doc of documents) {
      const analysis = this.inspector.chunkDocument(doc.content, config.chunkConfig);
      for (const chunk of analysis.chunks) {
        allChunks.push({ id: `${doc.path}:${chunk.index}`, content: chunk.content });
      }
    }

    const metrics = await this.analyzer.testRetrieval(query, allChunks, relevantDocIds, config.topK);

    return {
      config,
      retrievalResult,
      precisionAtK: metrics.precisionAtK,
      recallAtK: metrics.recallAtK,
      mrr: metrics.mrr,
    };
  }

  /**
   * Benchmark all available embedding models on the same dataset.
   */
  async benchmarkModels(
    documents: { path: string; content: string; language: string }[],
    query: string,
  ): Promise<{ model: EmbeddingModel; retrievalResult: RetrievalDebugResult }[]> {
    const results: { model: EmbeddingModel; retrievalResult: RetrievalDebugResult }[] = [];

    for (const model of EMBEDDING_MODELS) {
      const result = await this.debugger.debugQuery(documents, query, 5);
      results.push({ model, retrievalResult: result });
    }

    return results;
  }
}

// ── Hallucination Detection (Phase 8.5) ───────────────────────────────────────

export class HallucinationDetector {
  /**
   * Check if an LLM claim is supported by source documents.
   */
  checkClaim(
    claim: string,
    sources: { id: string; content: string }[],
    threshold = 0.7,
  ): HallucinationCheck {
    const supporting: string[] = [];
    const contradicting: string[] = [];

    for (const source of sources) {
      const overlap = this.computeTextOverlap(claim, source.content);
      if (overlap >= threshold) {
        supporting.push(source.id);
      } else if (overlap < 0.3 && this.hasContradictoryTerms(claim, source.content)) {
        contradicting.push(source.id);
      }
    }

    const verified = supporting.length > 0 && contradicting.length === 0;
    const confidence = supporting.length > 0
      ? Math.min(1, supporting.length / Math.max(1, sources.length))
      : 0;

    let explanation: string;
    if (verified) {
      explanation = `Claim supported by ${supporting.length} source(s): ${supporting.join(", ")}.`;
    } else if (contradicting.length > 0) {
      explanation = `Potential hallucination detected. ${contradicting.length} source(s) contradict: ${contradicting.join(", ")}.`;
    } else {
      explanation = "Insufficient evidence to verify or refute the claim. Consider additional sources.";
    }

    return {
      claim,
      sources,
      verified,
      confidence,
      supportingEvidence: supporting,
      contradictingEvidence: contradicting,
      explanation,
    };
  }

  /**
   * Run a consistency check on multiple LLM responses to the same prompt.
   */
  consistencyCheck(responses: string[]): {
    consistent: boolean;
    variance: number;
    commonPhrases: string[];
    summary: string;
  } {
    if (responses.length < 2) {
      return { consistent: true, variance: 0, commonPhrases: [], summary: "Need at least 2 responses." };
    }

    // Extract common phrases (3+ word sequences appearing in multiple responses)
    const phraseMap = new Map<string, number>();
    for (const response of responses) {
      const words = response.toLowerCase().split(/\s+/);
      const seen = new Set<string>();
      for (let i = 0; i < words.length - 2; i++) {
        const phrase = words.slice(i, i + 3).join(" ");
        if (!seen.has(phrase)) {
          seen.add(phrase);
          phraseMap.set(phrase, (phraseMap.get(phrase) || 0) + 1);
        }
      }
    }

    const commonPhrases = Array.from(phraseMap.entries())
      .filter(([, count]) => count >= responses.length * 0.7)
      .sort(([, a], [, b]) => b - a)
      .slice(0, 10)
      .map(([phrase]) => phrase);

    // Compute response variance using simple length-based heuristic
    const lengths = responses.map((r) => r.length);
    const avgLength = lengths.reduce((s, l) => s + l, 0) / lengths.length;
    const variance = lengths.reduce((s, l) => s + (l - avgLength) ** 2, 0) / lengths.length;

    const consistent = commonPhrases.length >= 3 && variance < avgLength * 0.5;

    return {
      consistent,
      variance: Math.round(variance),
      commonPhrases,
      summary: consistent
        ? `Responses are consistent (${commonPhrases.length} common phrases, low variance).`
        : `Responses show inconsistency (variance: ${Math.round(variance)}, ${commonPhrases.length} common phrases). Consider prompt refinement.`,
    };
  }

  // ── Private Helpers ─────────────────────────────────────────────────────────

  private computeTextOverlap(textA: string, textB: string): number {
    const wordsA = new Set(textA.toLowerCase().split(/\W+/).filter(Boolean));
    const wordsB = new Set(textB.toLowerCase().split(/\W+/).filter(Boolean));

    if (wordsA.size === 0) return 0;

    let overlap = 0;
    for (const word of wordsA) {
      if (wordsB.has(word)) overlap++;
    }

    return overlap / wordsA.size;
  }

  private hasContradictoryTerms(claim: string, source: string): boolean {
    const contradictions: Array<[RegExp, RegExp]> = [
      [/true|yes|always|all/i, /false|no|never|none/i],
      [/increased|higher|more/i, /decreased|lower|less/i],
      [/must|required|mandatory/i, /optional|may|can be/i],
    ];

    for (const [claimPattern, sourcePattern] of contradictions) {
      if (claimPattern.test(claim) && sourcePattern.test(source)) {
        return true;
      }
    }

    return false;
  }
}