# PunamIDE v2.0 → v2.1 Improvement Roadmap

> Updated: 2026-05-30 | 5/6 Tasks Complete | 1 Deferred to Next Session

---

## TASK 1: LSP Auto-Download System ✅
**Status:** COMPLETED

Files:
- `src-tauri/src/lsp_manager.rs` — `lsp_check_installed` command + `install_command_for()` helper
- `src-tauri/src/lib.rs` — Command registered in invoke_handler
- `src/services/lsp/lspClient.ts` — `checkInstalled()` + `installServer()` with per-session cache

---

## TASK 2: Live Preview Dev Server Integration ✅
**Status:** COMPLETED

Files:
- `src-tauri/src/lib.rs` — `dev_server_detect` + `dev_server_get_project_root` commands
- `src/components/LivePreview.tsx` — Already has URL mode, hot reload, URL detection (no changes needed)

---

## TASK 3: Basic Test Suite ✅
**Status:** COMPLETED

Files:
- `src-tauri/src/lib_tests.rs` — **NEW** — 40 Rust unit tests (tokenize_code, levenshtein, diff_strings, fuzzy_find_block, etc.)
- `src-tauri/src/lib.rs` — `#[cfg(test)] mod lib_tests;` declaration

---

## TASK 4: Split lib.rs Monolith ⏭️ PENDING
**Status:** DEFERRED TO NEXT SESSION
**Priority:** HIGH
**Reason:** Requires fresh session with full context (2,800+ lines across 6 new modules + lib.rs refactor)

**Plan:**
Extract these modules from `src-tauri/src/lib.rs`:
1. `src-tauri/src/fs_commands.rs` — File system commands (~350 lines)
2. `src-tauri/src/search_commands.rs` — Search commands (~150 lines)
3. `src-tauri/src/terminal_commands.rs` — Terminal commands (~250 lines)
4. `src-tauri/src/llm_commands.rs` — LLM/API commands (~400 lines)
5. `src-tauri/src/git_commands.rs` — Git commands (~100 lines)
6. `src-tauri/src/index_commands.rs` — Index/codebase commands (~200 lines)

Keep in `lib.rs`: types, state structs, `validate_path_within_project`, `get_project_root`, `SKIP_DIRS`/`SKIP_FILES`, `run()` entry point, diff engine, merge engine, SQLite persistence (~400 lines).

After each extraction: `cargo build` to verify. Tests (Task 3) serve as safety net.

---

## TASK 5: MCP Implementation ✅
**Status:** COMPLETED

Files:
- `src/services/mcp/mcpManager.ts` — **NEW** — Multi-server lifecycle manager
- `src/services/mcp/mcpToolExecutor.ts` — **NEW** — Dynamic tool routing + prompt builder
- `src/utils/mcp.ts` — Protocol client (already existed, full MCP JSON-RPC over HTTP/SSE and stdio)
- `src/components/McpSettings.tsx` — UI (already existed, 3 preset servers)

---

## TASK 6: Vector Store Embeddings Pipeline ✅
**Status:** COMPLETED

Files:
- `src-tauri/src/embeddings.rs` — **NEW** — embeddings_store, embeddings_search, embeddings_clear, cosine_similarity
- `src-tauri/src/lib.rs` — `pub mod embeddings;` + table auto-created in `db_init()`
- `src/services/embeddings/vectorStore.ts` — Already existed with cosineSimilarity() and simpleHash() fallback

---

## Execution Status

| Task | Status | Notes |
|------|--------|-------|
| TASK 1: LSP Auto-Download | ✅ Complete | Rust + frontend, install cache |
| TASK 2: Live Preview | ✅ Complete | Dev server detection |
| TASK 3: Test Suite | ✅ Complete | 40 Rust unit tests |
| TASK 4: Split lib.rs | ⏭️ PENDING | NEXT SESSION — extract 6 modules |
| TASK 5: MCP Implementation | ✅ Complete | mcpManager + mcpToolExecutor |
| TASK 6: Vector Embeddings | ✅ Complete | SQLite BLOB storage + cosine similarity |