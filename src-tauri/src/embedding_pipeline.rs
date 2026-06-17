//! Embedding Pipeline — Batch embedding generation for code chunks (Phase 3).
//!
//! Orchestrates: chunk → embed (frontend/API) → store → semantic search.
//! The embedding model runs on the frontend (ONNX/Transformers.js or API),
//! this module handles batching, progress tracking, and storage.
//!
//! Commands:
//!   embedding_pipeline_get_chunks      — get chunks for frontend to embed
//!   embedding_pipeline_store_batch     — store batch of embeddings
//!   embedding_pipeline_semantic_search — semantic code search via embeddings
//!   embedding_pipeline_stats           — get embedding index statistics

use serde::Serialize;
use tauri::State;

use crate::embeddings;
use crate::CodebaseIndex;
use crate::CodeChunk;

// ── Data Types ─────────────────────────────────────────────────────────────────

/// A chunk ready for embedding (sent to frontend for vector generation).
#[derive(Serialize, Debug, Clone)]
pub struct EmbeddingChunkPayload {
    pub chunk_id: String,
    pub file_path: String,
    pub chunk_text: String,
    pub start_line: usize,
    pub end_line: usize,
    pub chunk_type: String,
    pub name: String,
    pub signature: String,
    pub imports: Vec<String>,
}

/// Result of a semantic search query.
#[derive(Serialize, Debug)]
pub struct SemanticSearchResult {
    pub query: String,
    pub hits: Vec<SemanticSearchHit>,
    pub total_scanned: usize,
    pub query_time_ms: u64,
}

#[derive(Serialize, Debug)]
pub struct SemanticSearchHit {
    pub chunk_id: String,
    pub file_path: String,
    pub chunk_text: String,
    pub start_line: usize,
    pub end_line: usize,
    pub chunk_type: String,
    pub name: String,
    pub signature: String,
    pub score: f64,
}

/// Statistics about the embedding index.
#[derive(Serialize, Debug)]
pub struct EmbeddingPipelineStats {
    pub total_chunks_indexed: usize,
    pub total_embeddings_stored: usize,
    pub unique_files: usize,
}

// ── Pipeline ───────────────────────────────────────────────────────────────────

/// Extract all chunks from the TF-IDF codebase index and convert them
/// into EmbeddingChunkPayload for the frontend to generate embeddings.
///
/// The frontend calls this to get chunks, generates embeddings via ONNX/API,
/// then calls `embedding_pipeline_store_batch` to persist them.
#[tauri::command]
pub fn embedding_pipeline_get_chunks(
    index_state: State<CodebaseIndex>,
    offset: usize,
    limit: usize,
) -> Result<Vec<EmbeddingChunkPayload>, String> {
    let idx_guard = index_state.0.read().map_err(|_| "Lock error".to_string())?;
    let index = idx_guard.as_ref().ok_or("Codebase not indexed yet. Call index_codebase first.")?;

    let total = index.chunks.len();
    let start = offset.min(total);
    let end = (offset + limit).min(total);

    let payloads: Vec<EmbeddingChunkPayload> = index.chunks[start..end]
        .iter()
        .map(|chunk| EmbeddingChunkPayload {
            chunk_id: format!("{}_{}", chunk.path.replace(['/', '\\'], "_"), chunk.start_line),
            file_path: chunk.path.clone(),
            chunk_text: chunk.content.clone(),
            start_line: chunk.start_line,
            end_line: chunk.end_line,
            chunk_type: chunk.chunk_type.clone(),
            name: chunk.name.clone(),
            signature: chunk.signature.clone(),
            imports: chunk.imports.clone(),
        })
        .collect();

    Ok(payloads)
}

/// Store a batch of embeddings (chunk_id + vector pairs).
/// Called by the frontend after generating embeddings for chunks.
#[tauri::command]
pub fn embedding_pipeline_store_batch(
    batch: Vec<serde_json::Value>,
) -> Result<usize, String> {
    let mut stored = 0usize;

    for item in &batch {
        let chunk_id = item["chunk_id"].as_str().unwrap_or("");
        let file_path = item["file_path"].as_str().unwrap_or("");
        let chunk_text = item["chunk_text"].as_str().unwrap_or("");
        let start_line = item["start_line"].as_i64().unwrap_or(1);
        let end_line = item["end_line"].as_i64().unwrap_or(1);
        let embedding: Vec<f32> = item["embedding"]
            .as_array()
            .map(|arr| arr.iter().filter_map(|v| v.as_f64().map(|f| f as f32)).collect())
            .unwrap_or_default();

        if chunk_id.is_empty() || embedding.is_empty() {
            continue;
        }

        embeddings::store_embedding_internal(chunk_id, file_path, chunk_text, start_line, end_line, &embedding)?;
        stored += 1;
    }

    Ok(stored)
}

/// Get statistics about the current embedding index.
#[tauri::command]
pub fn embedding_pipeline_stats(
    index_state: State<CodebaseIndex>,
) -> Result<EmbeddingPipelineStats, String> {
    let idx_guard = index_state.0.read().map_err(|_| "Lock error".to_string())?;
    let index = idx_guard.as_ref().ok_or("Codebase not indexed yet.")?;

    let mut unique_files = std::collections::HashSet::new();
    for chunk in &index.chunks {
        unique_files.insert(&chunk.path);
    }

    let total_stored = embeddings::embeddings_count().unwrap_or(0);

    Ok(EmbeddingPipelineStats {
        total_chunks_indexed: index.chunks.len(),
        total_embeddings_stored: total_stored,
        unique_files: unique_files.len(),
    })
}

/// Semantic search: takes a query embedding (generated by frontend model)
/// and searches the stored code embeddings for similar chunks.
///
/// This is the "find similar logic across the repo" endpoint.
#[tauri::command]
pub fn embedding_pipeline_semantic_search(
    query_embedding: Vec<f32>,
    top_k: usize,
    index_state: State<CodebaseIndex>,
) -> Result<SemanticSearchResult, String> {
    let start = std::time::Instant::now();

    let hits = embeddings::search_embeddings_internal(&query_embedding, top_k)?;

    let idx_guard = index_state.0.read().map_err(|_| "Lock error".to_string())?;
    let index = idx_guard.as_ref();

    let enriched: Vec<SemanticSearchHit> = hits
        .into_iter()
        .map(|hit| {
            let (chunk_type, name, signature) = if let Some(idx) = index {
                idx.chunks
                    .iter()
                    .find(|c| c.path == hit.file_path && c.start_line == hit.start_line as usize)
                    .map(|c| (c.chunk_type.clone(), c.name.clone(), c.signature.clone()))
                    .unwrap_or_default()
            } else {
                (String::new(), String::new(), String::new())
            };

            SemanticSearchHit {
                chunk_id: hit.chunk_id,
                file_path: hit.file_path,
                chunk_text: hit.chunk_text,
                start_line: hit.start_line as usize,
                end_line: hit.end_line as usize,
                chunk_type,
                name,
                signature,
                score: hit.score,
            }
        })
        .collect();

    let total = enriched.len();

    Ok(SemanticSearchResult {
        query: "embedding_vector".to_string(),
        hits: enriched,
        total_scanned: total,
        query_time_ms: start.elapsed().as_millis() as u64,
    })
}

// ── Tests ──────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_chunk_payload_conversion() {
        let chunk = CodeChunk {
            path: "src/main.ts".to_string(),
            start_line: 10,
            end_line: 25,
            content: "function foo() {}".to_string(),
            token_count: 5,
            chunk_type: "function".to_string(),
            name: "foo".to_string(),
            signature: "function foo()".to_string(),
            imports: vec!["import React from 'react'".to_string()],
        };

        let payload = EmbeddingChunkPayload {
            chunk_id: "src_main.ts_10".to_string(),
            file_path: chunk.path.clone(),
            chunk_text: chunk.content.clone(),
            start_line: chunk.start_line,
            end_line: chunk.end_line,
            chunk_type: chunk.chunk_type.clone(),
            name: chunk.name.clone(),
            signature: chunk.signature.clone(),
            imports: chunk.imports.clone(),
        };

        assert_eq!(payload.name, "foo");
        assert_eq!(payload.chunk_type, "function");
        assert_eq!(payload.imports.len(), 1);
    }
}