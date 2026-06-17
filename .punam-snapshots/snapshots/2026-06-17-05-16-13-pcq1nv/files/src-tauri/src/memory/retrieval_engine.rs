//! Retrieval Engine (Phase 2 — Memory Subsystem)
//!
//! Hybrid search engine combining FTS5 full-text search with embedding similarity.
//! Auto-injects relevant memories into AI prompts for context-aware responses.
//!
//! Pipeline:
//! 1. FTS5 text search for keyword matching
//! 2. Embedding similarity search for semantic matching (optional)
//! 3. Merge + rerank results
//! 4. Format as context snippets for AI injection

use serde::Serialize;
use std::time::Instant;

use super::memory_engine::{MemoryEntry, memory_search as fts5_search, memory_list};
use super::embedding_store::search_similar;

// ── Types ──────────────────────────────────────────────────────────────────────

/// A single context snippet ready for AI injection.
#[derive(Serialize, Debug, Clone)]
pub struct ContextSnippet {
    pub memory_id: String,
    pub memory_type: String,
    pub title: String,
    pub description: String,
    pub relevance_score: f32, // 0-1, higher = more relevant
    pub source: String,       // "fts5", "embedding", "hybrid"
    pub files_involved: Vec<String>,
    pub tags: Vec<String>,
}

/// Result of a retrieval query.
#[derive(Serialize, Debug)]
pub struct RetrievalResult {
    pub snippets: Vec<ContextSnippet>,
    pub query_time_ms: u64,
    pub total_candidates: usize,
}

// ── Retrieval Engine ───────────────────────────────────────────────────────────

/// Hybrid search: FTS5 text + optional embedding similarity.
///
/// # Arguments
/// * `query` - Search query text
/// * `limit` - Max results to return
/// * `memory_type` - Optional filter by memory type
/// * `query_vector` - Optional embedding vector for semantic search
/// * `min_similarity` - Minimum embedding similarity threshold (default 0.5)
pub fn retrieve_context(
    query: &str,
    limit: usize,
    memory_type: Option<&str>,
    query_vector: Option<&[f32]>,
    min_similarity: f32,
) -> Result<RetrievalResult, String> {
    let start = Instant::now();
    let mut snippets: Vec<ContextSnippet> = Vec::new();
    let mut seen_ids = std::collections::HashSet::new();
    let mut total_candidates = 0;

    // ── Layer 1: FTS5 full-text search ──────────────────────────────────────
    let fts5_result = fts5_search(query.to_string(), memory_type.map(|s| s.to_string()), limit * 2)
        .map_err(|e| format!("FTS5 search failed: {}", e))?;

    total_candidates += fts5_result.total_count;

    for entry in &fts5_result.entries {
        if seen_ids.contains(&entry.id) {
            continue;
        }
        seen_ids.insert(entry.id.clone());

        snippets.push(ContextSnippet {
            memory_id: entry.id.clone(),
            memory_type: entry.memory_type.clone(),
            title: entry.title.clone(),
            description: entry.description.clone(),
            relevance_score: 0.8, // FTS5 results get high base score
            source: "fts5".to_string(),
            files_involved: entry.files_involved.clone(),
            tags: entry.tags.clone(),
        });
    }

    // ── Layer 2: Embedding similarity search (optional) ─────────────────────
    if let Some(vector) = query_vector {
        if let Ok(similar_results) = search_similar(vector, limit * 2, min_similarity) {
            total_candidates += similar_results.len();

            for result in &similar_results {
                if seen_ids.contains(&result.memory_id) {
                    // Update existing snippet's relevance if found in both layers
                    if let Some(existing) = snippets.iter_mut().find(|s| s.memory_id == result.memory_id) {
                        let combined = existing.relevance_score * 0.6 + result.similarity * 0.4;
                        existing.relevance_score = combined;
                        existing.source = "hybrid".to_string();
                    }
                    continue;
                }
                seen_ids.insert(result.memory_id.clone());

                // Fetch the full memory entry for this embedding
                // Use memory_list with limit 1 to get metadata
                let entry = get_memory_by_id(&result.memory_id);

                if let Ok(Some(entry)) = entry {
                    snippets.push(ContextSnippet {
                        memory_id: result.memory_id.clone(),
                        memory_type: entry.memory_type,
                        title: entry.title,
                        description: entry.description,
                        relevance_score: result.similarity * 0.7, // Slightly lower base score for embedding-only
                        source: "embedding".to_string(),
                        files_involved: entry.files_involved,
                        tags: entry.tags,
                    });
                }
            }
        }
    }

    // ── Layer 3: Rerank ─────────────────────────────────────────────────────
    snippets.sort_by(|a, b| {
        b.relevance_score
            .partial_cmp(&a.relevance_score)
            .unwrap_or(std::cmp::Ordering::Equal)
    });

    // ── Layer 4: Limit + format ─────────────────────────────────────────────
    snippets.truncate(limit);

    let elapsed = start.elapsed().as_millis() as u64;

    Ok(RetrievalResult {
        snippets,
        query_time_ms: elapsed,
        total_candidates,
    })
}

/// Format retrieval results as an AI context string (for system prompt injection).
pub fn format_context_for_prompt(
    snippets: &[ContextSnippet],
    max_chars: usize,
) -> String {
    if snippets.is_empty() {
        return String::new();
    }

    let mut lines: Vec<String> = Vec::new();
    lines.push("## Relevant Project Memories\n".to_string());

    let mut char_count = 0;
    let header_len = lines[0].len();
    char_count += header_len;

    for (i, snippet) in snippets.iter().enumerate() {
        let type_label = match snippet.memory_type.as_str() {
            "architectural_decision" => "Decision",
            "bug_resolution" => "Bug Fix",
            "refactor" => "Refactor",
            "convention" => "Convention",
            _ => "Memory",
        };

        let entry = format!(
            "\n### {}. [{}] {} (relevance: {:.0}%)\n{}\n",
            i + 1,
            type_label,
            snippet.title,
            snippet.relevance_score * 100.0,
            snippet.description
        );
        let entry_len = entry.len();

        if char_count + entry_len > max_chars {
            break;
        }

        if !snippet.tags.is_empty() {
            let tag_line = format!("Tags: {}\n", snippet.tags.join(", "));
            if char_count + entry_len + tag_line.len() <= max_chars {
                lines.push(format!("{}{}", entry, tag_line));
                char_count += entry_len + tag_line.len();
            } else {
                lines.push(entry);
                char_count += entry_len;
            }
        } else {
            lines.push(entry);
            char_count += entry_len;
        }
    }

    if char_count >= max_chars {
        lines.push("\n_(Some memories omitted due to context limits)_\n".to_string());
    }

    lines.join("")
}

/// Auto-inject relevant memories into an AI system prompt.
/// Wraps retrieve_context + format_context_for_prompt into a single operation.
pub fn auto_inject_memories(
    query: &str,
    system_prompt: &str,
    limit: usize,
    query_vector: Option<&[f32]>,
    max_context_chars: usize,
) -> Result<String, String> {
    let retrieval = retrieve_context(query, limit, None, query_vector, 0.5)?;

    if retrieval.snippets.is_empty() {
        return Ok(system_prompt.to_string());
    }

    let context = format_context_for_prompt(&retrieval.snippets, max_context_chars);
    Ok(format!("{system_prompt}\n\n{context}"))
}

// ── Helpers ────────────────────────────────────────────────────────────────────

/// Get a single memory entry by ID.
fn get_memory_by_id(id: &str) -> Result<Option<MemoryEntry>, String> {
    // Use memory_engine's memory_get_by_id via Tauri command
    // For internal use, we query directly
    match memory_get_by_id_internal(id) {
        Ok(entry) => Ok(entry),
        Err(_) => Ok(None),
    }
}

/// Internal helper to get memory by ID without Tauri command overhead.
fn memory_get_by_id_internal(id: &str) -> Result<Option<MemoryEntry>, String> {
    let entries = memory_list(None, 1, 0)
        .map_err(|e| format!("Failed to list memories: {}", e))?
        .entries;

    Ok(entries.into_iter().find(|e| e.id == id))
}

// ── Tauri Commands ─────────────────────────────────────────────────────────────

#[tauri::command]
pub fn retrieve_memories(
    query: String,
    limit: usize,
    memory_type: Option<String>,
) -> Result<Vec<ContextSnippet>, String> {
    let result = retrieve_context(
        &query,
        limit,
        memory_type.as_deref(),
        None,
        0.5,
    )?;
    Ok(result.snippets)
}

#[tauri::command]
pub fn retrieve_memories_semantic(
    query: String,
    limit: usize,
    query_vector: Vec<f32>,
    min_similarity: f32,
) -> Result<Vec<ContextSnippet>, String> {
    let result = retrieve_context(
        &query,
        limit,
        None,
        Some(&query_vector),
        min_similarity,
    )?;
    Ok(result.snippets)
}

#[tauri::command]
pub fn inject_memories_into_prompt(
    query: String,
    system_prompt: String,
    limit: usize,
) -> Result<String, String> {
    auto_inject_memories(
        &query,
        &system_prompt,
        limit,
        None,
        4000,
    )
}

// ── Tests ──────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_format_context_empty() {
        let result = format_context_for_prompt(&[], 1000);
        assert_eq!(result, "");
    }

    #[test]
    fn test_format_context_with_snippets() {
        let snippets = vec![ContextSnippet {
            memory_id: "test-1".to_string(),
            memory_type: "architectural_decision".to_string(),
            title: "Moved auth to middleware".to_string(),
            description: "Prevent duplicated checks".to_string(),
            relevance_score: 0.95,
            source: "fts5".to_string(),
            files_involved: vec!["src/auth/middleware.ts".to_string()],
            tags: vec!["auth".to_string(), "architecture".to_string()],
        }];

        let result = format_context_for_prompt(&snippets, 2000);
        assert!(result.contains("Moved auth to middleware"));
        assert!(result.contains("Decision"));
        assert!(result.contains("auth"));
    }

    #[test]
    fn test_format_context_respects_limit() {
        let snippets = vec![ContextSnippet {
            memory_id: "test-1".to_string(),
            memory_type: "bug_resolution".to_string(),
            title: "Fix".to_string(),
            description: "A very long description that should be truncated because it exceeds the character limit we set for the test. ".repeat(20),
            relevance_score: 0.9,
            source: "fts5".to_string(),
            files_involved: vec![],
            tags: vec![],
        }];

        let result = format_context_for_prompt(&snippets, 200);
        assert!(result.len() <= 250); // Allow some margin
    }
}