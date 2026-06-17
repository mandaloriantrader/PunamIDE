/**
 * EmbeddingPipelineService.ts — Frontend wrapper for Code Embedding Pipeline (Phase 3).
 */
import { invoke } from "@tauri-apps/api/core";

export interface EmbeddingChunkPayload {
  chunk_id: string; file_path: string; chunk_text: string;
  start_line: number; end_line: number;
  chunk_type: string; name: string; signature: string; imports: string[];
}
export interface SemanticSearchHit {
  chunk_id: string; file_path: string; chunk_text: string;
  start_line: number; end_line: number;
  chunk_type: string; name: string; signature: string; score: number;
}
export interface SemanticSearchResult {
  query: string; hits: SemanticSearchHit[]; total_scanned: number; query_time_ms: number;
}
export interface EmbeddingPipelineStats {
  total_chunks_indexed: number; total_embeddings_stored: number; unique_files: number;
}

export async function getEmbeddingChunks(offset: number, limit: number): Promise<EmbeddingChunkPayload[]> {
  return invoke("embedding_pipeline_get_chunks", { offset, limit });
}
export async function storeEmbeddingBatch(batch: Array<{
  chunk_id: string; file_path: string; chunk_text: string;
  start_line: number; end_line: number; embedding: number[];
}>): Promise<number> {
  return invoke("embedding_pipeline_store_batch", { batch });
}
export async function semanticSearch(queryEmbedding: number[], topK: number): Promise<SemanticSearchResult> {
  return invoke("embedding_pipeline_semantic_search", { queryEmbedding, topK });
}
export async function getEmbeddingPipelineStats(): Promise<EmbeddingPipelineStats> {
  return invoke("embedding_pipeline_stats");
}