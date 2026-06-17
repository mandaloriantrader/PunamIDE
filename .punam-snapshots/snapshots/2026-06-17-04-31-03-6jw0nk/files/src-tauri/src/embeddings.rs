//! Embeddings (Vector Store) — Semantic code search backend.
//! Stores f32 embeddings as BLOBs in SQLite, supports cosine similarity search.
//! Embeddings are generated on the frontend (via API or local ONNX) and stored here.

use rusqlite::params;
use serde::Serialize;

fn unix_timestamp_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}

// ── Data Types ─────────────────────────────────────────────────────────────────

#[derive(Serialize, Debug, Clone)]
pub struct EmbeddingSearchHit {
    pub chunk_id: String,
    pub file_path: String,
    pub chunk_text: String,
    pub start_line: i64,
    pub end_line: i64,
    pub score: f64,
}

// ── SQLite Helpers ─────────────────────────────────────────────────────────────

fn get_db_path() -> std::path::PathBuf {
    let data_dir = dirs::data_local_dir().unwrap_or_else(|| std::path::PathBuf::from("."));
    let app_dir = data_dir.join("punamide");
    std::fs::create_dir_all(&app_dir).ok();
    app_dir.join("punamide.db")
}

fn get_conn() -> Result<rusqlite::Connection, String> {
    let db_path = get_db_path();
    let conn = rusqlite::Connection::open(&db_path).map_err(|e| format!("DB error: {}", e))?;
    conn.execute_batch(
        "PRAGMA journal_mode=WAL;
         PRAGMA synchronous=NORMAL;
         PRAGMA busy_timeout=5000;"
    ).map_err(|e| format!("DB pragma error: {}", e))?;
    Ok(conn)
}

// ── Cosine Similarity ─────────────────────────────────────────────────────────

fn cosine_similarity(a: &[f32], b: &[f32]) -> f64 {
    if a.len() != b.len() || a.is_empty() { return 0.0; }
    let mut dot = 0.0f64;
    let mut norm_a = 0.0f64;
    let mut norm_b = 0.0f64;
    for i in 0..a.len() {
        let va = a[i] as f64;
        let vb = b[i] as f64;
        dot += va * vb;
        norm_a += va * va;
        norm_b += vb * vb;
    }
    let denom = norm_a.sqrt() * norm_b.sqrt();
    if denom == 0.0 { 0.0 } else { dot / denom }
}

// ── Public Internal API (used by embedding_pipeline) ───────────────────────────

pub(crate) fn store_embedding_internal(
    chunk_id: &str, file_path: &str, chunk_text: &str,
    start_line: i64, end_line: i64, embedding: &[f32],
) -> Result<(), String> {
    let conn = get_conn()?;
    let blob: Vec<u8> = embedding.iter().flat_map(|f| f.to_le_bytes()).collect();
    let now = unix_timestamp_ms();
    conn.execute(
        "INSERT OR REPLACE INTO embeddings (chunk_id, file_path, chunk_text, start_line, end_line, embedding, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        params![chunk_id, file_path, chunk_text, start_line, end_line, blob, now],
    ).map_err(|e| format!("Embeddings store error: {}", e))?;
    Ok(())
}

pub(crate) fn search_embeddings_internal(
    query_embedding: &[f32], top_k: usize,
) -> Result<Vec<EmbeddingSearchHit>, String> {
    let conn = get_conn()?;
    let mut stmt = conn
        .prepare("SELECT chunk_id, file_path, chunk_text, start_line, end_line, embedding FROM embeddings")
        .map_err(|e| format!("Embeddings query error: {}", e))?;

    let mut hits: Vec<(f64, String, String, String, i64, i64)> = Vec::new();
    let rows = stmt.query_map([], |row| {
        Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, String>(2)?, row.get::<_, i64>(3)?, row.get::<_, i64>(4)?, row.get::<_, Vec<u8>>(5)?))
    }).map_err(|e| format!("Embeddings scan error: {}", e))?;

    for row in rows {
        if let Ok((id, path, text, sl, el, blob)) = row {
            let vec: Vec<f32> = blob.chunks(4).filter_map(|c| {
                if c.len() == 4 { Some(f32::from_le_bytes([c[0],c[1],c[2],c[3]])) } else { None }
            }).collect();
            if vec.len() != query_embedding.len() { continue; }
            hits.push((cosine_similarity(query_embedding, &vec), id, path, text, sl, el));
        }
    }
    hits.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap_or(std::cmp::Ordering::Equal));
    Ok(hits.into_iter().take(top_k)
        .map(|(score, chunk_id, file_path, chunk_text, start_line, end_line)| EmbeddingSearchHit {
            chunk_id, file_path, chunk_text, start_line, end_line, score,
        }).collect())
}

// ── Tauri Commands ─────────────────────────────────────────────────────────────

#[tauri::command]
pub fn embeddings_store(
    chunk_id: String, file_path: String, chunk_text: String,
    start_line: i64, end_line: i64, embedding: Vec<f32>,
) -> Result<(), String> {
    store_embedding_internal(&chunk_id, &file_path, &chunk_text, start_line, end_line, &embedding)
}

#[tauri::command]
pub fn embeddings_search(
    query_embedding: Vec<f32>, top_k: usize,
) -> Result<Vec<EmbeddingSearchHit>, String> {
    search_embeddings_internal(&query_embedding, top_k)
}

#[tauri::command]
pub fn embeddings_clear() -> Result<(), String> {
    let conn = get_conn()?;
    conn.execute("DELETE FROM embeddings", []).map_err(|e| format!("Embeddings clear error: {}", e))?;
    Ok(())
}

#[tauri::command]
pub fn embeddings_count() -> Result<usize, String> {
    let conn = get_conn()?;
    let count: i64 = conn.query_row("SELECT COUNT(*) FROM embeddings", [], |r| r.get(0))
        .map_err(|e| format!("Count error: {}", e))?;
    Ok(count as usize)
}

// ── Table Init ─────────────────────────────────────────────────────────────────

pub fn ensure_embeddings_table() -> Result<(), String> {
    let conn = get_conn()?;
    conn.execute(
        "CREATE TABLE IF NOT EXISTS embeddings (
            chunk_id TEXT PRIMARY KEY, file_path TEXT NOT NULL, chunk_text TEXT NOT NULL,
            start_line INTEGER NOT NULL, end_line INTEGER NOT NULL,
            embedding BLOB NOT NULL, created_at INTEGER NOT NULL DEFAULT 0
        )", [],
    ).map_err(|e| format!("Embeddings table init: {}", e))?;

    // Check if created_at column exists (migration from older schema)
    let mut stmt = conn.prepare("PRAGMA table_info(embeddings)").map_err(|e| format!("Check: {}", e))?;
    let columns: Vec<String> = stmt
        .query_map([], |row| row.get::<_, String>(1))
        .map_err(|e| format!("Check: {}", e))?
        .filter_map(|c| c.ok())
        .collect();
    let has_created_at = columns.iter().any(|col| col == "created_at");

    if !has_created_at {
        conn.execute("ALTER TABLE embeddings ADD COLUMN created_at INTEGER NOT NULL DEFAULT 0", [])
            .map_err(|e| format!("Migration: {}", e))?;
    }
    conn.execute("UPDATE embeddings SET created_at = ?1 WHERE created_at = 0", [unix_timestamp_ms()])
        .map_err(|e| format!("Timestamp migration: {}", e))?;
    conn.execute_batch("CREATE INDEX IF NOT EXISTS idx_code_embeddings_created ON embeddings(created_at DESC);")
        .map_err(|e| format!("Index: {}", e))?;
    Ok(())
}