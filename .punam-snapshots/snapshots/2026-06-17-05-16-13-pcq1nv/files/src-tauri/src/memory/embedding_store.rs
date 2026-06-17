//! Embedding Store (Phase 2 — Memory Subsystem)
//!
//! Stores embedding vectors in SQLite BLOBs for semantic memory search.
//! Provides cosine similarity search for finding similar memories.
//!
//! Schema: embedding_vectors table with BLOB storage for f32 vectors.
//! Each embedding is associated with a memory entry ID for cross-referencing.

use rusqlite::{params, Connection, Result as SqlResult};
use serde::{Deserialize, Serialize};

// ── Data Types ─────────────────────────────────────────────────────────────────

/// An embedding vector as flat f32 array.
pub type EmbeddingVector = Vec<f32>;

/// Stored embedding entry.
#[derive(Serialize, Debug, Clone)]
pub struct EmbeddingEntry {
    /// Memory entry ID this embedding belongs to
    pub memory_id: String,
    /// Flat f32 embedding vector
    pub vector: EmbeddingVector,
    /// Dimension of the embedding
    pub dimensions: usize,
    /// Source text chunk (for reference)
    pub source_text: String,
    /// When the embedding was created
    pub created_at: i64,
}

/// Result of a similarity search.
#[derive(Serialize, Debug)]
pub struct SimilarityResult {
    pub memory_id: String,
    pub similarity: f32,     // Cosine similarity score (0-1)
    pub source_text: String,
    pub dimensions: usize,
}

/// Input for storing an embedding.
#[derive(Deserialize, Debug)]
pub struct EmbeddingInput {
    pub memory_id: String,
    pub vector: Vec<f32>,
    pub source_text: String,
}

// ── Database ───────────────────────────────────────────────────────────────────

fn get_db_path() -> std::path::PathBuf {
    let data_dir = dirs::data_local_dir().unwrap_or_else(|| std::path::PathBuf::from("."));
    let app_dir = data_dir.join("punamide");
    std::fs::create_dir_all(&app_dir).ok();
    app_dir.join("punamide.db")
}

fn get_conn() -> Result<Connection, String> {
    let conn = Connection::open(&get_db_path()).map_err(|e| format!("DB error: {}", e))?;
    conn.execute_batch(
        "PRAGMA journal_mode=WAL;
         PRAGMA synchronous=NORMAL;
         PRAGMA busy_timeout=5000;
         PRAGMA foreign_keys=ON;"
    ).map_err(|e| format!("DB pragma error: {}", e))?;
    Ok(conn)
}

/// Initialize the embedding table.
fn ensure_embedding_schema(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        "
        CREATE TABLE IF NOT EXISTS embedding_vectors (
            memory_id TEXT PRIMARY KEY,
            vector_blob BLOB NOT NULL,
            dimensions INTEGER NOT NULL,
            source_text TEXT NOT NULL DEFAULT '',
            created_at INTEGER NOT NULL,
            FOREIGN KEY (memory_id) REFERENCES project_memory(id) ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS idx_embeddings_memory_id ON embedding_vectors(memory_id);
        CREATE INDEX IF NOT EXISTS idx_embeddings_created ON embedding_vectors(created_at DESC);
        "
    ).map_err(|e| format!("Embedding schema init error: {}", e))
}

// ── Vector Operations ──────────────────────────────────────────────────────────

/// Serialize f32 vector to BLOB bytes.
fn vector_to_blob(vector: &[f32]) -> Vec<u8> {
    let bytes: Vec<u8> = vector
        .iter()
        .flat_map(|f| f.to_le_bytes())
        .collect();
    bytes
}

/// Deserialize BLOB bytes back to f32 vector.
fn blob_to_vector(blob: &[u8], dimensions: usize) -> Vec<f32> {
    blob.chunks_exact(4)
        .take(dimensions)
        .map(|chunk| f32::from_le_bytes([chunk[0], chunk[1], chunk[2], chunk[3]]))
        .collect()
}

/// Compute cosine similarity between two vectors.
/// Returns 0.0 to 1.0 (higher = more similar).
fn cosine_similarity(a: &[f32], b: &[f32]) -> f32 {
    if a.len() != b.len() || a.is_empty() {
        return 0.0;
    }

    let dot_product: f32 = a.iter().zip(b.iter()).map(|(x, y)| x * y).sum();
    let norm_a: f32 = a.iter().map(|x| x * x).sum::<f32>().sqrt();
    let norm_b: f32 = b.iter().map(|x| x * x).sum::<f32>().sqrt();

    if norm_a == 0.0 || norm_b == 0.0 {
        return 0.0;
    }

    // Clamp to [-1, 1] range and return
    (dot_product / (norm_a * norm_b)).clamp(-1.0, 1.0)
}

// ── CRUD Operations ────────────────────────────────────────────────────────────

/// Store an embedding vector.
pub fn store_embedding(input: &EmbeddingInput) -> Result<EmbeddingEntry, String> {
    let conn = get_conn()?;
    ensure_embedding_schema(&conn)?;

    let dimensions = input.vector.len();
    let blob = vector_to_blob(&input.vector);
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64;

    conn.execute(
        "INSERT OR REPLACE INTO embedding_vectors (memory_id, vector_blob, dimensions, source_text, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5)",
        params![input.memory_id, blob, dimensions, input.source_text, now],
    ).map_err(|e| format!("Failed to store embedding: {}", e))?;

    Ok(EmbeddingEntry {
        memory_id: input.memory_id.clone(),
        vector: input.vector.clone(),
        dimensions,
        source_text: input.source_text.clone(),
        created_at: now,
    })
}

/// Retrieve an embedding by memory ID.
pub fn get_embedding(memory_id: &str) -> Result<Option<EmbeddingEntry>, String> {
    let conn = get_conn()?;
    ensure_embedding_schema(&conn)?;

    let mut stmt = conn
        .prepare(
            "SELECT vector_blob, dimensions, source_text, created_at
             FROM embedding_vectors WHERE memory_id = ?1"
        )
        .map_err(|e| format!("Failed to prepare query: {}", e))?;

    let entry_result = stmt.query_row(
        params![memory_id],
        |row| {
            let blob: Vec<u8> = row.get(0)?;
            let dimensions: usize = row.get(1)?;
            let source_text: String = row.get(2)?;
            let created_at: i64 = row.get(3)?;
            let vector = blob_to_vector(&blob, dimensions);

            Ok(EmbeddingEntry {
                memory_id: memory_id.to_string(),
                vector,
                dimensions,
                source_text,
                created_at,
            })
        },
    );

    match entry_result {
        Ok(entry) => Ok(Some(entry)),
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
        Err(e) => Err(format!("Failed to get embedding: {}", e)),
    }
}

/// Search for similar embeddings using cosine similarity.
/// Returns top-k most similar memories (sorted descending by similarity).
pub fn search_similar(
    query_vector: &[f32],
    limit: usize,
    min_similarity: f32,
) -> Result<Vec<SimilarityResult>, String> {
    let conn = get_conn()?;
    ensure_embedding_schema(&conn)?;

    let mut stmt = conn
        .prepare(
            "SELECT memory_id, vector_blob, dimensions, source_text
             FROM embedding_vectors
             ORDER BY created_at DESC
             LIMIT 1000"
        )
        .map_err(|e| format!("Failed to prepare search query: {}", e))?;

    let rows = stmt
        .query_map([], |row| {
            let memory_id: String = row.get(0)?;
            let blob: Vec<u8> = row.get(1)?;
            let dimensions: usize = row.get(2)?;
            let source_text: String = row.get(3)?;
            Ok((memory_id, blob, dimensions, source_text))
        })
        .map_err(|e| format!("Failed to query embeddings: {}", e))?;

    let mut results: Vec<SimilarityResult> = Vec::new();

    for row in rows {
        let (memory_id, blob, dimensions, source_text) =
            row.map_err(|e| format!("Failed to read row: {}", e))?;

        let stored_vector = blob_to_vector(&blob, dimensions);

        // Skip if dimensions don't match
        if stored_vector.len() != query_vector.len() {
            continue;
        }

        let similarity = cosine_similarity(query_vector, &stored_vector);

        if similarity >= min_similarity {
            results.push(SimilarityResult {
                memory_id,
                similarity,
                source_text,
                dimensions,
            });
        }
    }

    // Sort by similarity (highest first)
    results.sort_by(|a, b| b.similarity.partial_cmp(&a.similarity).unwrap_or(std::cmp::Ordering::Equal));

    // Limit results
    results.truncate(limit);

    Ok(results)
}

/// Delete an embedding by memory ID.
pub fn delete_embedding(memory_id: &str) -> Result<(), String> {
    let conn = get_conn()?;
    ensure_embedding_schema(&conn)?;

    conn.execute(
        "DELETE FROM embedding_vectors WHERE memory_id = ?1",
        params![memory_id],
    ).map_err(|e| format!("Failed to delete embedding: {}", e))?;

    Ok(())
}

/// Count total stored embeddings.
pub fn count_embeddings() -> Result<usize, String> {
    let conn = get_conn()?;
    ensure_embedding_schema(&conn)?;

    let count: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM embedding_vectors",
            [],
            |row| row.get(0),
        )
        .map_err(|e| format!("Failed to count embeddings: {}", e))?;

    Ok(count as usize)
}

// ── Tauri Commands ─────────────────────────────────────────────────────────────

#[tauri::command]
pub fn embedding_store(input: EmbeddingInput) -> Result<EmbeddingEntry, String> {
    store_embedding(&input)
}

#[tauri::command]
pub fn embedding_get(memory_id: String) -> Result<Option<EmbeddingEntry>, String> {
    get_embedding(&memory_id)
}

#[tauri::command]
pub fn embedding_search(
    query_vector: Vec<f32>,
    limit: usize,
    min_similarity: f32,
) -> Result<Vec<SimilarityResult>, String> {
    search_similar(&query_vector, limit, min_similarity)
}

#[tauri::command]
pub fn embedding_delete(memory_id: String) -> Result<(), String> {
    delete_embedding(&memory_id)
}

#[tauri::command]
pub fn embedding_count() -> Result<usize, String> {
    count_embeddings()
}

// ── Tests ──────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_cosine_similarity_identical() {
        let v1 = vec![1.0, 2.0, 3.0];
        let v2 = vec![1.0, 2.0, 3.0];
        let sim = cosine_similarity(&v1, &v2);
        assert!((sim - 1.0).abs() < 0.001);
    }

    #[test]
    fn test_cosine_similarity_orthogonal() {
        let v1 = vec![1.0, 0.0, 0.0];
        let v2 = vec![0.0, 1.0, 0.0];
        let sim = cosine_similarity(&v1, &v2);
        assert!((sim - 0.0).abs() < 0.001);
    }

    #[test]
    fn test_vector_blob_roundtrip() {
        let original = vec![0.5, -1.0, 0.25, 0.0, 3.14];
        let blob = vector_to_blob(&original);
        let restored = blob_to_vector(&blob, original.len());
        assert_eq!(original.len(), restored.len());
        for (a, b) in original.iter().zip(restored.iter()) {
            assert!((a - b).abs() < 0.001);
        }
    }
}
