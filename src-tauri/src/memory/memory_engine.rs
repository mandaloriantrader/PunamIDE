//! Long-Term Project Memory System (Phase 2)
//!
//! Persistent memory across sessions — architectural decisions, bug fixes,
//! refactor history, and team conventions.
//!
//! Schema: 4 tables + FTS5 indexes for full-text search.
//! Storage: SQLite (same punamide.db as chat_sessions and embeddings).

use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use std::sync::Once;

// ── Data Types ─────────────────────────────────────────────────────────────────

/// A single memory entry — stored in one of the four memory tables.
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct MemoryEntry {
    pub id: String,
    pub memory_type: String, // "architectural_decision", "bug_resolution", "refactor", "convention"
    pub title: String,
    pub description: String,
    pub tags: Vec<String>,   // JSON array stored as text
    pub files_involved: Vec<String>, // JSON array stored as text
    pub severity: String,    // "low", "medium", "high", "critical"
    pub created_at: i64,     // unix timestamp ms
    pub updated_at: i64,
}

/// Input for creating/updating a memory entry.
#[derive(Deserialize, Debug)]
pub struct MemoryInput {
    pub memory_type: String,
    pub title: String,
    pub description: String,
    pub tags: Vec<String>,
    pub files_involved: Vec<String>,
    pub severity: String,
}

/// Result of a memory search query.
#[derive(Serialize, Debug)]
pub struct MemorySearchResult {
    pub entries: Vec<MemoryEntry>,
    pub total_count: usize,
    pub query_time_ms: u64,
}

// ── Database ───────────────────────────────────────────────────────────────────

static MEMORY_DB_INIT: Once = Once::new();

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

/// Initialize memory tables and FTS5 indexes.
fn ensure_memory_schema(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        "
        -- Base memory table (unified schema for all memory types)
        CREATE TABLE IF NOT EXISTS project_memory (
            id TEXT PRIMARY KEY,
            memory_type TEXT NOT NULL CHECK(memory_type IN ('architectural_decision', 'bug_resolution', 'refactor', 'convention')),
            title TEXT NOT NULL,
            description TEXT NOT NULL DEFAULT '',
            tags TEXT NOT NULL DEFAULT '[]',          -- JSON array
            files_involved TEXT NOT NULL DEFAULT '[]', -- JSON array
            severity TEXT NOT NULL DEFAULT 'medium',
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
        );

        -- Indexes for common queries
        CREATE INDEX IF NOT EXISTS idx_memory_type ON project_memory(memory_type);
        CREATE INDEX IF NOT EXISTS idx_memory_updated ON project_memory(updated_at DESC);
        CREATE INDEX IF NOT EXISTS idx_memory_severity ON project_memory(severity);

        -- FTS5 full-text search virtual table (external content table)
        -- Allows fast text search across title + description
        CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(
            title,
            description,
            content='project_memory',
            content_rowid='rowid'
        );

        -- Triggers to keep FTS5 in sync with project_memory
        CREATE TRIGGER IF NOT EXISTS memory_fts_insert AFTER INSERT ON project_memory BEGIN
            INSERT INTO memory_fts(rowid, title, description)
            VALUES (new.rowid, new.title, new.description);
        END;

        CREATE TRIGGER IF NOT EXISTS memory_fts_delete AFTER DELETE ON project_memory BEGIN
            INSERT INTO memory_fts(memory_fts, rowid, title, description)
            VALUES ('delete', old.rowid, old.title, old.description);
        END;

        CREATE TRIGGER IF NOT EXISTS memory_fts_update AFTER UPDATE ON project_memory BEGIN
            INSERT INTO memory_fts(memory_fts, rowid, title, description)
            VALUES ('delete', old.rowid, old.title, old.description);
            INSERT INTO memory_fts(rowid, title, description)
            VALUES (new.rowid, new.title, new.description);
        END;

        -- ── Session Tasks Table (Agent Task History & Learned Patterns) ─────────
        -- Stores granular task execution metadata for agent self-improvement.
        CREATE TABLE IF NOT EXISTS session_tasks (
            id TEXT PRIMARY KEY,
            task_description TEXT NOT NULL,
            status TEXT NOT NULL CHECK(status IN ('success', 'failure', 'partial')),
            approach TEXT NOT NULL,
            error_type TEXT,
            files_affected TEXT NOT NULL DEFAULT '[]',
            patterns_learned TEXT NOT NULL DEFAULT '[]',
            duration_ms INTEGER NOT NULL,
            created_at INTEGER NOT NULL,
            last_accessed_at INTEGER NOT NULL
        );

        -- Indexes for session_tasks queries
        CREATE INDEX IF NOT EXISTS idx_session_tasks_status ON session_tasks(status);
        CREATE INDEX IF NOT EXISTS idx_session_tasks_created ON session_tasks(created_at DESC);
        CREATE INDEX IF NOT EXISTS idx_session_tasks_accessed ON session_tasks(last_accessed_at);

        -- FTS5 for semantic search across task descriptions and approaches
        CREATE VIRTUAL TABLE IF NOT EXISTS session_tasks_fts USING fts5(
            task_description,
            approach,
            content='session_tasks',
            content_rowid='rowid'
        );

        -- Triggers to keep session_tasks_fts in sync with session_tasks
        CREATE TRIGGER IF NOT EXISTS session_tasks_fts_insert AFTER INSERT ON session_tasks BEGIN
            INSERT INTO session_tasks_fts(rowid, task_description, approach)
            VALUES (new.rowid, new.task_description, new.approach);
        END;

        CREATE TRIGGER IF NOT EXISTS session_tasks_fts_delete AFTER DELETE ON session_tasks BEGIN
            INSERT INTO session_tasks_fts(session_tasks_fts, rowid, task_description, approach)
            VALUES ('delete', old.rowid, old.task_description, old.approach);
        END;

        CREATE TRIGGER IF NOT EXISTS session_tasks_fts_update AFTER UPDATE ON session_tasks BEGIN
            INSERT INTO session_tasks_fts(session_tasks_fts, rowid, task_description, approach)
            VALUES ('delete', old.rowid, old.task_description, old.approach);
            INSERT INTO session_tasks_fts(rowid, task_description, approach)
            VALUES (new.rowid, new.task_description, new.approach);
        END;
        "
    ).map_err(|e| format!("Memory schema init error: {}", e))?;

    Ok(())
}

// ── CRUD Operations ────────────────────────────────────────────────────────────

fn row_to_entry(row: &rusqlite::Row) -> rusqlite::Result<MemoryEntry> {
    let tags_str: String = row.get(4)?;
    let files_str: String = row.get(5)?;
    Ok(MemoryEntry {
        id: row.get(0)?,
        memory_type: row.get(1)?,
        title: row.get(2)?,
        description: row.get(3)?,
        tags: serde_json::from_str(&tags_str).unwrap_or_default(),
        files_involved: serde_json::from_str(&files_str).unwrap_or_default(),
        severity: row.get(6)?,
        created_at: row.get(7)?,
        updated_at: row.get(8)?,
    })
}

// ── Tauri Commands ─────────────────────────────────────────────────────────────

/// Initialize the memory system (called once at app startup).
#[tauri::command]
pub fn memory_init() -> Result<(), String> {
    let conn = get_conn()?;
    ensure_memory_schema(&conn)?;
    Ok(())
}

/// Create a new memory entry.
#[tauri::command]
pub fn memory_create(input: MemoryInput) -> Result<MemoryEntry, String> {
    let conn = get_conn()?;
    ensure_memory_schema(&conn)?;

    let id = format!("mem-{}", uuid_v4());
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|e| e.to_string())?
        .as_millis() as i64;

    let tags_json = serde_json::to_string(&input.tags).unwrap_or_else(|_| "[]".to_string());
    let files_json = serde_json::to_string(&input.files_involved).unwrap_or_else(|_| "[]".to_string());

    conn.execute(
        "INSERT INTO project_memory (id, memory_type, title, description, tags, files_involved, severity, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
        params![id, input.memory_type, input.title, input.description, tags_json, files_json, input.severity, now, now],
    ).map_err(|e| format!("Create error: {}", e))?;

    memory_get_by_id(id)
}

/// Get a memory entry by ID.
#[tauri::command]
pub fn memory_get_by_id(id: String) -> Result<MemoryEntry, String> {
    let conn = get_conn()?;
    ensure_memory_schema(&conn)?;

    conn.query_row(
        "SELECT id, memory_type, title, description, tags, files_involved, severity, created_at, updated_at
         FROM project_memory WHERE id = ?1",
        params![id],
        row_to_entry,
    ).map_err(|e| format!("Not found: {}", e))
}

/// List memory entries, optionally filtered by type.
#[tauri::command]
pub fn memory_list(
    memory_type: Option<String>,
    limit: usize,
    offset: usize,
) -> Result<MemorySearchResult, String> {
    let conn = get_conn()?;
    ensure_memory_schema(&conn)?;

    let start = std::time::Instant::now();

    let (entries, total_count) = if let Some(ref mt) = memory_type {
        let count: i64 = conn.query_row(
            "SELECT COUNT(*) FROM project_memory WHERE memory_type = ?1",
            params![mt],
            |r| r.get(0),
        ).map_err(|e| e.to_string())?;

        let mut stmt = conn.prepare(
            "SELECT id, memory_type, title, description, tags, files_involved, severity, created_at, updated_at
             FROM project_memory WHERE memory_type = ?1
             ORDER BY updated_at DESC LIMIT ?2 OFFSET ?3"
        ).map_err(|e| e.to_string())?;

        let rows = stmt.query_map(params![mt, limit as i64, offset as i64], row_to_entry)
            .map_err(|e| e.to_string())?;

        let mut entries = Vec::new();
        for row in rows {
            entries.push(row.map_err(|e| e.to_string())?);
        }
        (entries, count as usize)
    } else {
        let count: i64 = conn.query_row("SELECT COUNT(*) FROM project_memory", [], |r| r.get(0))
            .map_err(|e| e.to_string())?;

        let mut stmt = conn.prepare(
            "SELECT id, memory_type, title, description, tags, files_involved, severity, created_at, updated_at
             FROM project_memory ORDER BY updated_at DESC LIMIT ?1 OFFSET ?2"
        ).map_err(|e| e.to_string())?;

        let rows = stmt.query_map(params![limit as i64, offset as i64], row_to_entry)
            .map_err(|e| e.to_string())?;

        let mut entries = Vec::new();
        for row in rows {
            entries.push(row.map_err(|e| e.to_string())?);
        }
        (entries, count as usize)
    };

    Ok(MemorySearchResult {
        entries,
        total_count,
        query_time_ms: start.elapsed().as_millis() as u64,
    })
}

/// Full-text search across memory entries.
#[tauri::command]
pub fn memory_search(
    query: String,
    memory_type: Option<String>,
    limit: usize,
) -> Result<MemorySearchResult, String> {
    let conn = get_conn()?;
    ensure_memory_schema(&conn)?;

    let start = std::time::Instant::now();

    let (entries, total_count) = if let Some(ref mt) = memory_type {
        // FTS5 search with type filter
        let count: i64 = conn.query_row(
            "SELECT COUNT(*) FROM memory_fts
             JOIN project_memory ON memory_fts.rowid = project_memory.rowid
             WHERE memory_fts MATCH ?1 AND project_memory.memory_type = ?2",
            params![query, mt],
            |r| r.get(0),
        ).map_err(|e| e.to_string())?;

        let mut stmt = conn.prepare(
            "SELECT project_memory.id, project_memory.memory_type, project_memory.title,
                    project_memory.description, project_memory.tags, project_memory.files_involved,
                    project_memory.severity, project_memory.created_at, project_memory.updated_at
             FROM memory_fts
             JOIN project_memory ON memory_fts.rowid = project_memory.rowid
             WHERE memory_fts MATCH ?1 AND project_memory.memory_type = ?2
             ORDER BY rank LIMIT ?3"
        ).map_err(|e| e.to_string())?;

        let rows = stmt.query_map(params![query, mt, limit as i64], row_to_entry)
            .map_err(|e| e.to_string())?;

        let mut entries = Vec::new();
        for row in rows {
            entries.push(row.map_err(|e| e.to_string())?);
        }
        (entries, count as usize)
    } else {
        let count: i64 = conn.query_row(
            "SELECT COUNT(*) FROM memory_fts WHERE memory_fts MATCH ?1",
            params![query],
            |r| r.get(0),
        ).map_err(|e| e.to_string())?;

        let mut stmt = conn.prepare(
            "SELECT project_memory.id, project_memory.memory_type, project_memory.title,
                    project_memory.description, project_memory.tags, project_memory.files_involved,
                    project_memory.severity, project_memory.created_at, project_memory.updated_at
             FROM memory_fts
             JOIN project_memory ON memory_fts.rowid = project_memory.rowid
             WHERE memory_fts MATCH ?1
             ORDER BY rank LIMIT ?2"
        ).map_err(|e| e.to_string())?;

        let rows = stmt.query_map(params![query, limit as i64], row_to_entry)
            .map_err(|e| e.to_string())?;

        let mut entries = Vec::new();
        for row in rows {
            entries.push(row.map_err(|e| e.to_string())?);
        }
        (entries, count as usize)
    };

    Ok(MemorySearchResult {
        entries,
        total_count,
        query_time_ms: start.elapsed().as_millis() as u64,
    })
}

/// Update an existing memory entry.
#[tauri::command]
pub fn memory_update(
    id: String,
    input: MemoryInput,
) -> Result<MemoryEntry, String> {
    let conn = get_conn()?;
    ensure_memory_schema(&conn)?;

    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|e| e.to_string())?
        .as_millis() as i64;

    let tags_json = serde_json::to_string(&input.tags).unwrap_or_else(|_| "[]".to_string());
    let files_json = serde_json::to_string(&input.files_involved).unwrap_or_else(|_| "[]".to_string());

    let affected = conn.execute(
        "UPDATE project_memory SET memory_type = ?1, title = ?2, description = ?3,
         tags = ?4, files_involved = ?5, severity = ?6, updated_at = ?7
         WHERE id = ?8",
        params![input.memory_type, input.title, input.description, tags_json, files_json, input.severity, now, id],
    ).map_err(|e| format!("Update error: {}", e))?;

    if affected == 0 {
        return Err("Memory entry not found".to_string());
    }

    memory_get_by_id(id)
}

/// Delete a memory entry by ID.
#[tauri::command]
pub fn memory_delete(id: String) -> Result<(), String> {
    let conn = get_conn()?;
    ensure_memory_schema(&conn)?;

    let affected = conn.execute("DELETE FROM project_memory WHERE id = ?1", params![id])
        .map_err(|e| format!("Delete error: {}", e))?;

    if affected == 0 {
        return Err("Memory entry not found".to_string());
    }
    Ok(())
}

/// Get memory entries related to a specific file.
///
/// Useful for showing relevant past decisions/bugs when a developer opens a file.
#[tauri::command]
pub fn memory_get_by_file(file_path: String) -> Result<Vec<MemoryEntry>, String> {
    let conn = get_conn()?;
    ensure_memory_schema(&conn)?;

    // Search for entries where files_involved JSON array contains the path
    // Using LIKE since it's simple and effective for JSON array matching
    let like_pattern = format!("%{}%", file_path);

    let mut stmt = conn.prepare(
        "SELECT id, memory_type, title, description, tags, files_involved, severity, created_at, updated_at
         FROM project_memory WHERE files_involved LIKE ?1
         ORDER BY updated_at DESC LIMIT 20"
    ).map_err(|e| e.to_string())?;

    let rows = stmt.query_map(params![like_pattern], row_to_entry)
        .map_err(|e| e.to_string())?;

    let mut entries = Vec::new();
    for row in rows {
        entries.push(row.map_err(|e| e.to_string())?);
    }
    Ok(entries)
}

/// Get recent memory entries across all types for the project timeline view.
#[tauri::command]
pub fn memory_get_timeline(limit: usize) -> Result<Vec<MemoryEntry>, String> {
    let conn = get_conn()?;
    ensure_memory_schema(&conn)?;

    let mut stmt = conn.prepare(
        "SELECT id, memory_type, title, description, tags, files_involved, severity, created_at, updated_at
         FROM project_memory ORDER BY created_at DESC LIMIT ?1"
    ).map_err(|e| e.to_string())?;

    let rows = stmt.query_map(params![limit as i64], row_to_entry)
        .map_err(|e| e.to_string())?;

    let mut entries = Vec::new();
    for row in rows {
        entries.push(row.map_err(|e| e.to_string())?);
    }
    Ok(entries)
}

/// Quick-add a memory entry from AI context (low-friction API for agent use).
///
/// The AI or user can tag something as important, and it gets saved as a convention
/// or architectural decision for future context retrieval.
#[tauri::command]
pub fn memory_quick_add(
    memory_type: String,
    title: String,
    description: String,
) -> Result<MemoryEntry, String> {
    memory_create(MemoryInput {
        memory_type,
        title,
        description,
        tags: vec![],
        files_involved: vec![],
        severity: "medium".to_string(),
    })
}

// ── Session Task Types ─────────────────────────────────────────────────────────

/// A session task entry — stores agent task execution history for self-improvement.
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct SessionTaskEntry {
    pub id: String,
    pub task_description: String,
    pub status: String,       // "success", "failure", "partial"
    pub approach: String,
    pub error_type: Option<String>,
    pub files_affected: Vec<String>,
    pub patterns_learned: Vec<String>,
    pub duration_ms: i64,
    pub created_at: i64,
    pub last_accessed_at: i64,
}

/// Input for creating a session task entry.
#[derive(Deserialize, Debug)]
pub struct SessionTaskInput {
    pub task_description: String,
    pub status: String,
    pub approach: String,
    pub error_type: Option<String>,
    pub files_affected: Vec<String>,
    pub patterns_learned: Vec<String>,
    pub duration_ms: i64,
}

/// Result of a session task search query.
#[derive(Serialize, Debug)]
pub struct SessionTaskSearchResult {
    pub entries: Vec<SessionTaskEntry>,
    pub total_count: usize,
}

/// Result of a session task eviction operation.
#[derive(Serialize, Debug)]
pub struct SessionTaskEvictResult {
    pub evicted_count: usize,
    pub db_size_bytes: i64,
}

// ── Session Task Commands ──────────────────────────────────────────────────────

fn row_to_session_task(row: &rusqlite::Row) -> rusqlite::Result<SessionTaskEntry> {
    let files_str: String = row.get(5)?;
    let patterns_str: String = row.get(6)?;
    Ok(SessionTaskEntry {
        id: row.get(0)?,
        task_description: row.get(1)?,
        status: row.get(2)?,
        approach: row.get(3)?,
        error_type: row.get(4)?,
        files_affected: serde_json::from_str(&files_str).unwrap_or_default(),
        patterns_learned: serde_json::from_str(&patterns_str).unwrap_or_default(),
        duration_ms: row.get(7)?,
        created_at: row.get(8)?,
        last_accessed_at: row.get(9)?,
    })
}

/// Generate a session task ID in format "st-{unix_millis}-{4_random_chars}".
fn generate_session_task_id() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    // Generate 4 random hex chars using a simple LCG seeded with nanos
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let rand_val: u64 = (nanos as u64).wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
    let random_chars = format!("{:04x}", rand_val & 0xFFFF);
    format!("st-{}-{}", millis, random_chars)
}

/// Create a new session task entry (persists agent task history).
///
/// The FTS5 sync trigger automatically updates the `session_tasks_fts` index.
#[tauri::command]
pub fn session_task_create(input: SessionTaskInput) -> Result<SessionTaskEntry, String> {
    let conn = get_conn()?;
    ensure_memory_schema(&conn)?;

    let id = generate_session_task_id();
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|e| e.to_string())?
        .as_millis() as i64;

    let files_json = serde_json::to_string(&input.files_affected).unwrap_or_else(|_| "[]".to_string());
    let patterns_json = serde_json::to_string(&input.patterns_learned).unwrap_or_else(|_| "[]".to_string());

    conn.execute(
        "INSERT INTO session_tasks (id, task_description, status, approach, error_type, files_affected, patterns_learned, duration_ms, created_at, last_accessed_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
        params![
            id,
            input.task_description,
            input.status,
            input.approach,
            input.error_type,
            files_json,
            patterns_json,
            input.duration_ms,
            now,
            now
        ],
    ).map_err(|e| format!("Session task create error: {}", e))?;

    // Retrieve the created entry
    conn.query_row(
        "SELECT id, task_description, status, approach, error_type, files_affected, patterns_learned, duration_ms, created_at, last_accessed_at
         FROM session_tasks WHERE id = ?1",
        params![id],
        row_to_session_task,
    ).map_err(|e| format!("Session task retrieve error: {}", e))
}

/// Search session tasks using FTS5 full-text search.
///
/// Queries the `session_tasks_fts` index, orders by rank, limits results,
/// and updates `last_accessed_at` for returned entries.
#[tauri::command]
pub fn session_task_search(query: String, limit: usize) -> Result<SessionTaskSearchResult, String> {
    let conn = get_conn()?;
    ensure_memory_schema(&conn)?;

    let limit = if limit == 0 { 5 } else { limit };

    // Count total matches
    let total_count: i64 = conn.query_row(
        "SELECT COUNT(*) FROM session_tasks_fts WHERE session_tasks_fts MATCH ?1",
        params![query],
        |r| r.get(0),
    ).unwrap_or(0);

    // Query FTS5 with MATCH, order by rank, limit results
    let mut stmt = conn.prepare(
        "SELECT session_tasks.id, session_tasks.task_description, session_tasks.status,
                session_tasks.approach, session_tasks.error_type, session_tasks.files_affected,
                session_tasks.patterns_learned, session_tasks.duration_ms,
                session_tasks.created_at, session_tasks.last_accessed_at
         FROM session_tasks_fts
         JOIN session_tasks ON session_tasks_fts.rowid = session_tasks.rowid
         WHERE session_tasks_fts MATCH ?1
         ORDER BY rank
         LIMIT ?2"
    ).map_err(|e| format!("Session task search prepare error: {}", e))?;

    let rows = stmt.query_map(params![query, limit as i64], row_to_session_task)
        .map_err(|e| format!("Session task search error: {}", e))?;

    let mut entries = Vec::new();
    for row in rows {
        entries.push(row.map_err(|e| format!("Session task row error: {}", e))?);
    }

    // Update last_accessed_at for returned entries
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|e| e.to_string())?
        .as_millis() as i64;

    for entry in &entries {
        conn.execute(
            "UPDATE session_tasks SET last_accessed_at = ?1 WHERE id = ?2",
            params![now, entry.id],
        ).ok(); // Best-effort update, don't fail the search
    }

    Ok(SessionTaskSearchResult {
        entries,
        total_count: total_count as usize,
    })
}

/// Evict stale session task entries based on age and database size constraints.
///
/// Deletes entries not accessed in `max_age_days` (oldest first, batches of 100),
/// then checks DB size via PRAGMA page_count * page_size.
#[tauri::command]
pub fn session_task_evict(max_size_mb: f64, max_age_days: i64) -> Result<SessionTaskEvictResult, String> {
    let conn = get_conn()?;
    ensure_memory_schema(&conn)?;

    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|e| e.to_string())?
        .as_millis() as i64;

    // Calculate cutoff timestamp (entries not accessed in max_age_days)
    let cutoff_ms = now - (max_age_days * 24 * 60 * 60 * 1000);

    let mut total_evicted: usize = 0;

    // Delete in batches of 100 (oldest first by last_accessed_at)
    loop {
        let affected = conn.execute(
            "DELETE FROM session_tasks WHERE id IN (
                SELECT id FROM session_tasks
                WHERE last_accessed_at < ?1
                ORDER BY last_accessed_at ASC
                LIMIT 100
            )",
            params![cutoff_ms],
        ).map_err(|e| format!("Session task evict error: {}", e))?;

        total_evicted += affected;

        // Stop if no more entries to delete or batch was less than 100
        if affected < 100 {
            break;
        }
    }

    // Check DB size via PRAGMA
    let db_size_bytes: i64 = conn.query_row(
        "SELECT page_count * page_size FROM pragma_page_count(), pragma_page_size()",
        [],
        |r| r.get(0),
    ).unwrap_or(0);

    // If DB still exceeds max_size_mb, evict more entries (oldest first)
    let max_size_bytes = (max_size_mb * 1024.0 * 1024.0) as i64;
    if db_size_bytes > max_size_bytes {
        // Delete oldest entries in batches until under limit
        loop {
            let current_size: i64 = conn.query_row(
                "SELECT page_count * page_size FROM pragma_page_count(), pragma_page_size()",
                [],
                |r| r.get(0),
            ).unwrap_or(0);

            if current_size <= max_size_bytes {
                break;
            }

            let affected = conn.execute(
                "DELETE FROM session_tasks WHERE id IN (
                    SELECT id FROM session_tasks
                    ORDER BY last_accessed_at ASC
                    LIMIT 100
                )",
                params![],
            ).map_err(|e| format!("Session task size evict error: {}", e))?;

            total_evicted += affected;

            if affected == 0 {
                break; // No more entries to delete
            }
        }
    }

    let final_size: i64 = conn.query_row(
        "SELECT page_count * page_size FROM pragma_page_count(), pragma_page_size()",
        [],
        |r| r.get(0),
    ).unwrap_or(0);

    Ok(SessionTaskEvictResult {
        evicted_count: total_evicted,
        db_size_bytes: final_size,
    })
}

/// Clear all session task entries and rebuild FTS5 index.
#[tauri::command]
pub fn session_task_clear() -> Result<(), String> {
    let conn = get_conn()?;
    ensure_memory_schema(&conn)?;

    conn.execute("DELETE FROM session_tasks", [])
        .map_err(|e| format!("Session task clear error: {}", e))?;

    // Rebuild FTS5 index to reclaim space
    conn.execute(
        "INSERT INTO session_tasks_fts(session_tasks_fts) VALUES('rebuild')",
        [],
    ).map_err(|e| format!("Session task FTS rebuild error: {}", e))?;

    Ok(())
}

// ── UUID v4 (simple, dependency-free) ──────────────────────────────────────────

fn uuid_v4() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let random_part: u64 = (timestamp as u64).wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
    format!(
        "{:08x}-{:04x}-4{:03x}-{:04x}-{:012x}",
        (random_part >> 32) as u32,
        ((random_part >> 16) & 0xFFFF) as u16,
        (random_part & 0xFFF) as u16,
        ((random_part >> 48) | 0x8000) & 0xFFFF,
        random_part
    )
}

// ── Tests ──────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    fn setup_test_db() -> Connection {
        let conn = Connection::open_in_memory().expect("Test DB");
        // We need a minimal schema — create tables manually
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS project_memory (
                id TEXT PRIMARY KEY,
                memory_type TEXT NOT NULL,
                title TEXT NOT NULL,
                description TEXT NOT NULL DEFAULT '',
                tags TEXT NOT NULL DEFAULT '[]',
                files_involved TEXT NOT NULL DEFAULT '[]',
                severity TEXT NOT NULL DEFAULT 'medium',
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL
            )"
        ).expect("Schema");
        conn
    }

    fn insert_test_entry(conn: &Connection, id: &str, memory_type: &str, title: &str) {
        let now = 1000i64;
        conn.execute(
            "INSERT INTO project_memory (id, memory_type, title, description, tags, files_involved, severity, created_at, updated_at)
             VALUES (?1, ?2, ?3, '', '[]', '[]', 'medium', ?4, ?4)",
            params![id, memory_type, title, now],
        ).expect("Insert");
    }

    #[test]
    fn test_create_and_retrieve() {
        let conn = setup_test_db();
        insert_test_entry(&conn, "mem-test1", "architectural_decision", "Auth moved to middleware");

        let result: MemoryEntry = conn.query_row(
            "SELECT id, memory_type, title, description, tags, files_involved, severity, created_at, updated_at
             FROM project_memory WHERE id = 'mem-test1'",
            [],
            row_to_entry,
        ).expect("Query");

        assert_eq!(result.title, "Auth moved to middleware");
        assert_eq!(result.memory_type, "architectural_decision");
    }

    #[test]
    fn test_filter_by_type() {
        let conn = setup_test_db();
        insert_test_entry(&conn, "mem-1", "architectural_decision", "Decision A");
        insert_test_entry(&conn, "mem-2", "bug_resolution", "Bug fix B");
        insert_test_entry(&conn, "mem-3", "architectural_decision", "Decision C");

        let count: i64 = conn.query_row(
            "SELECT COUNT(*) FROM project_memory WHERE memory_type = 'architectural_decision'",
            [],
            |r| r.get(0),
        ).expect("Count");

        assert_eq!(count, 2);
    }

    #[test]
    fn test_severity_field() {
        let conn = setup_test_db();
        let now = 1000i64;
        conn.execute(
            "INSERT INTO project_memory (id, memory_type, title, description, tags, files_involved, severity, created_at, updated_at)
             VALUES ('mem-crit', 'bug_resolution', 'Critical bug', '', '[]', '[]', 'critical', ?1, ?1)",
            params![now],
        ).expect("Insert");

        let entry: MemoryEntry = conn.query_row(
            "SELECT id, memory_type, title, description, tags, files_involved, severity, created_at, updated_at
             FROM project_memory WHERE id = 'mem-crit'",
            [],
            row_to_entry,
        ).expect("Query");

        assert_eq!(entry.severity, "critical");
    }
}