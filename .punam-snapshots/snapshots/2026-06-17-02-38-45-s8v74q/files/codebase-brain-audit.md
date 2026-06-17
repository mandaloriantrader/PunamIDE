# PunamIDE v2.0 — "Codebase Brain" Feature Audit

> **Audit Date:** 2026-06-17
> **Audit Scope:** Compare PunamIDE against the 10-point "Cursor-like codebase brain" specification
> **Methodology:** Read-only scan of Rust backend and TypeScript frontend source files — no files were modified
>
> **Files Scanned:**
> `src-tauri/src/index_commands.rs`, `src-tauri/src/memory/memory_engine.rs`, `src-tauri/src/memory/embedding_store.rs`, `src-tauri/src/memory/retrieval_engine.rs`, `src-tauri/src/snapshot/mod.rs`, `src-tauri/src/architecture/dependency_analyzer.rs`, `src-tauri/src/architecture/graph_builder.rs`, `src/utils/contextEngine.ts`, `src/utils/agentToolLoop.ts`, `src/services/architecture/ArchitectureEngine.ts`

---

## 1. 3-Layer Memory System (a.k.a. "Codebase Brain")

> "A normal LLM fails on large codebases because it: can't see everything at once, forgets context quickly, doesn't know file relationships."

### Layer A — Structural Index (the map)

| Required Component | Status | PunamIDE Implementation |
|---|---|---|
| AST parsing (functions, classes, imports) | **MISSING** | Tree-sitter WASM is loaded (`tree-sitter.wasm`, `tree-sitter-typescript.wasm`, `tree-sitter-tsx.wasm`, `tree-sitter-javascript.wasm`) but used **only** in the technical debt analyzer worker (`debt-analyzer-v2.0/ASTEngine.ts`) to calculate cyclomatic complexity and nesting depth. It is NOT used to build a persistent function/class/method index across the project. |
| File dependency graph | **PRESENT** | `architecture/dependency_analyzer.rs` (542 lines) parses ES6 imports, CommonJS requires, dynamic imports, Python imports/from-imports, and Rust use/extern-crate statements. `architecture/graph_builder.rs` (350 lines) constructs a full directed graph with `forward` (who do I import) and `reverse` (who imports me) edge maps, DFS cycle detection with white/gray/black coloring, transitive dependency traversal, and impact analysis (`find_dependents()`, `get_transitive_dependencies()`). Commands: `analyze_dependencies`, `analyze_file_dependencies`, `build_dependency_graph`. |
| Symbol table (definitions & references) | **MISSING** | No persistent symbol table. The LSP client (`lsp_manager.rs`, 663 lines) provides on-demand go-to-definition and hover via `lsp_definition`, `lsp_hover`, `lsp_completion` commands, but there is no pre-built index mapping "function X is defined at file Y line Z" or "function X is called from files A, B, C". |
| Language servers (LSP) | **PRESENT** | Full LSP client for TypeScript (`typescript-language-server`), Rust (`rust-analyzer`), Python (`pyright-langserver`), JSON (`vscode-json-language-server`) with JSON-RPC over stdio, auto-restart on crash (max 3 attempts), graceful shutdown on exit. 10 commands: start, didOpen, didChange, didSave, completion, hover, definition, format, shutdown, didClose. But this is **on-demand**, not a pre-built index. |
| ripgrep/text search | **PRESENT** | `search_commands.rs` provides regex-based project-wide search via `regex-lite` crate. Equivalent functionality to ripgrep but running in-process. |

**Verdict: Layer A is ~40% complete.** The file-level dependency graph is strong with cycle detection and impact analysis. The two critical missing pieces are AST-based function/class/method indexing and a persistent symbol table. LSP provides these live but not as a pre-built, queryable index.

---

### Layer B — Semantic Index (meaning layer)

> "You embed chunks of code: function-level chunks (not full files), docstrings + comments included, store embeddings in a vector DB."

| Required Component | Status | PunamIDE Implementation |
|---|---|---|
| Function-level chunking | **MISSING** | `index_commands.rs` chunks code at **fixed 30-line windows with 5-line overlap** (`CHUNK_LINES=30`, `CHUNK_OVERLAP=5` defined in `lib.rs`). This is blind sliding-window chunking that cuts through the middle of functions, classes, and methods indiscriminately. The requirement specifies: chunks by function/class/method boundaries, each chunk including function signature, docstring, body, file path, and imports context. **None of this exists.** |
| Embedding model integration | **MISSING** | `embeddings.rs` is listed as a **stub** in the tech stack document. No embedding generation pipeline exists for code. The research document `research/gpu-embeddings-research.md` explores ONNX Runtime Web (WebGPU) and Transformers.js with all-MiniLM-L6-v2 (384 dimensions, ~23MB) but **nothing is implemented**. There is no code that takes a code chunk, passes it through an embedding model, and stores the resulting vector. |
| Vector database (FAISS / pgvector / Milvus) | **MISSING** | `memory/embedding_store.rs` stores f32 embedding vectors as **raw BLOBs in SQLite** with **brute-force cosine similarity** (iterates up to 1000 stored vectors per query, computes dot product + L2 norm for each). This is for **human-authored project memory entries** only (architecture decisions, bug resolutions, conventions), NOT for code embeddings. There is no Approximate Nearest Neighbor (ANN) index — no FAISS, no pgvector ivfflat/hnsw, no Milvus. The tech stack document mentions "pgvector / FAISS" under section 23 (Embeddings & RAG Workbench) as a target, but the current implementation uses SQLite BLOBs. |

**Verdict: Layer B is ~10% complete.** Code chunking is line-window-based (not function-level), there is no code embedding generation pipeline, and vector storage is brute-force SQLite BLOBs with no ANN index. The embedding infrastructure that exists is for project memories, not for code.

---

### Layer C — Runtime Context Builder

> "When user asks something, you don't just send prompt. You dynamically assemble context: user question, retrieve top-k relevant files (semantic + symbolic), pull dependency neighbors, include git diff (recent changes), include call graph neighbors. Then you build a context pack."

| Required Component | Status | PunamIDE Implementation |
|---|---|---|
| Top-k relevant files (semantic) | **PARTIAL** | `get_relevant_context` in `index_commands.rs` uses TF-IDF with inverted index to score code chunks by relevance. Falls back to token-overlap scoring against file previews if TF-IDF index is not yet built. This is keyword/similarity-based, not embedding-based semantic search. |
| Top-k relevant files (symbolic) | **MISSING** | No symbol search. You cannot query "find the function named `handleAuth`" because there is no symbol table. |
| Pull dependency neighbors | **MISSING** | The dependency graph in `graph_builder.rs` has `find_dependents()` and `get_transitive_dependencies()` but these are **NOT wired into the context builder**. The `get_relevant_context` command does not call the graph to pull import neighbors of matched files. This is a critical gap — Cursor includes files that are imported by or import the matched files. |
| Include git diff (recent changes) | **PRESENT** | Git status lines are included in context. Modified files get a **1.5× relevance boost** in scoring. `git_status_lines` are formatted as `[{STATUS}] {path}` and included in the `RelevantContext` response. |
| Include call graph neighbors | **MISSING** | No call graph exists (who calls whom). The dependency graph tracks file-level imports but not function-level call relationships. |
| Open tab boost | **PRESENT** | Files currently open in editor tabs get a **3× relevance multiplier** in scoring. |
| Token estimation | **PRESENT** | `total_tokens_estimate` computed from file content lengths (chars ÷ 4). |

**Verdict: Layer C is ~55% complete.** Context assembly works and is functional for basic queries. The key missing pieces are: (1) symbolic/symbol search, (2) the dependency graph is not wired to pull neighbor files into context, and (3) there is no call graph to include call-graph neighbors.

**Overall 3-Layer System Verdict: ~35% complete.** Structural index is partial, semantic index barely exists, and the context builder is functional but missing the graph-neighbor injection that makes Cursor's context precise.

---

## 2. Agent Loop (not just a prompt)

> "You don't just call an LLM. You build an agent loop: User request → Planner → Retriever → Context builder → LLM → Verifier → re-iterate if failure."

| Required Stage | Status | PunamIDE Implementation |
|---|---|---|
| **Planner** — identify entry points, search auth module, find API route, find DB layer | **MISSING** | The agent loop in `agentToolLoop.ts` (830 lines) is purely **reactive**. It sends the user's question directly to the LLM and executes whatever tool calls the model requests (`read_lines`, `read_file`, `search_in_project`, `list_files`, `apply_patch`, `write_file`, `run_command`). There is no pre-planning phase that breaks down a complex request into sub-steps, identifies likely entry points, or maps out which modules to investigate before the first tool call. The model is given `Currently open in editor: ${activeFilePath}` as a hint, but no structured exploration plan. |
| **Retriever** — semantic search + symbol search + grep search | **PARTIAL** | Has TF-IDF semantic search (`search_codebase`), regex grep search (`search_project`), fuzzy matching (`fuzzy_find_block`), file listing (`list_files`), and file reading (`read_file`, `read_lines`). But lacks **symbol search** (find function/class by name) and lacks **unified hybrid retrieval** that merges and deduplicates results from all three strategies. |
| **Context builder** — assemble minimal relevant code | **PRESENT** | `contextEngine.ts` assembles the prompt payload with system instruction, global goal, current subtask, project memory, relevant code context, and sliding window of recent messages. `get_relevant_context` in Rust provides the backend context assembly. |
| **LLM** — proposes patch | **PRESENT** | Full multi-provider streaming support across Anthropic (native tool use via `/v1/messages`), Gemini (native function calling via `functionDeclarations`), OpenAI-compatible / Groq / Mistral / Ollama (JSON fallback tool loop). Includes observation tracking, deduplicate detection (skips repeat tool calls), final answer synthesis, and cancellation/timeout support (120s per round). |
| **Verifier** — run tests, lint, type check, re-iterate if failure | **MISSING** | After the agent applies a patch (`apply_patch` or `write_file`), there is **no automatic verification step**. The agent does NOT run unit tests, linters, or type checkers. The `BugHunt.tsx` component and `services/ci/VerificationRunner.ts` have verification capabilities (can run `npm run build`, `npm run lint`, `npm test`, `npx tsc --noEmit`, `ruff check`, `mypy`, `pytest`) but these are **separate UI features**, not integrated into the agent workflow. The agent never re-iterates because it never discovers failures. |
| Multi-agent orchestration | **PRESENT** | Beyond the basic agent loop, PunamIDE has a full multi-agent system: `AgentCoordinator.ts`, `AgentOrchestrator.ts`, `AgentApplyGuard.ts` (validates changes before applying), `ConflictResolver.ts`, `TaskScheduler.ts`, `backgroundAgentExecutor.ts`, and UI components (`AgentKanban.tsx`, `BackgroundAgentPanel.tsx`, `MultiAgentDashboard.tsx`). |

**Verdict: Agent loop is ~50% complete.** Tool calling and multi-agent orchestration are strong. The two missing stages are the **Planner** (which would make the agent proactive) and the **Verifier** (which would close the feedback loop and prevent bad changes from accumulating). Without these, the agent is a tool-executing chatbot, not a self-correcting development agent.

---

## 3. Function-Level Chunking

> "DO NOT embed whole files. DO embed: functions, classes, methods, config blocks. Each chunk should include: function signature, docstring, body, file path, imports context."

| Aspect | Status | PunamIDE Implementation |
|---|---|---|
| Chunk boundary method | **WRONG APPROACH** | `index_commands.rs` uses **fixed-size sliding windows**: 30 lines per chunk with 5 lines of overlap (`CHUNK_LINES=30`, `CHUNK_OVERLAP=5`). The `collect_chunks()` function iterates through each file line-by-line and creates chunks at lines `[i..i+30]`, then advances by `30 - 5 = 25` lines. This means chunks arbitrarily cut through the middle of functions, split classes across multiple chunks, and splice unrelated code together. |
| Function signature included | **MISSING** | Since chunks are line-window-based, there is no guarantee a function's signature is at the top of any chunk. |
| Docstring included | **MISSING** | Docstrings are not extracted or attached to chunks. |
| Body included | **PARTIAL** | Yes, the body text is included — but as raw lines from a window, not as structured function/class bodies. |
| File path included | **PRESENT** | Each `CodeChunk` stores `path: relative.clone()`. |
| Imports context included | **MISSING** | Import statements are not extracted or attached to chunks. A chunk at lines 150-180 of a file has no context about what's imported at lines 1-10. |

**Verdict: Function-Level Chunking is MISSING.** The current approach is blind line-window chunking — the opposite of what's required. The Tree-sitter WASM needed for function-level AST parsing exists in the project (used by the debt analyzer) but is not used for chunking.

---

## 4. Code Graph

> "Build a graph. Nodes: functions, classes, files. Edges: calls, imports, inheritance. This lets Punam answer: 'what breaks if I change this?', 'where is this used?', 'trace request flow'."

### Nodes

| Required Node Type | Status | PunamIDE Implementation |
|---|---|---|
| File nodes | **PRESENT** | `graph_builder.rs` represents files as keys in `forward` and `reverse` HashMap fields. All unique file paths are collected in `files: Vec<String>`. |
| Function nodes | **MISSING** | No function-level granularity. The graph only operates at the file level. |
| Class nodes | **MISSING** | No class-level granularity. |

### Edges

| Required Edge Type | Status | PunamIDE Implementation |
|---|---|---|
| Import edges | **PRESENT** | `dependency_analyzer.rs` parses ES6 imports (`import X from 'Y'`, `import { X } from 'Y'`, `import type { X }`), CommonJS requires (`require('X')`), dynamic imports (`import('./X')`), Python imports (`import X`, `from X import Y`), Python relative imports (`from .module import X`), Rust use statements (`use crate::module::foo`, `use std::collections::HashMap`), and Rust extern crates (`extern crate serde`). External imports (from node_modules, stdlib, crates.io) are filtered out of the internal graph but counted in stats. |
| Call edges (function A calls function B) | **MISSING** | No call graph. PunamIDE cannot tell you which functions call which other functions. |
| Inheritance edges | **MISSING** | No class hierarchy. PunamIDE cannot tell you which classes extend which. |

### Graph Capabilities

| Required Capability | Status | PunamIDE Implementation |
|---|---|---|
| Cycle detection | **PRESENT** | DFS with white/gray/black node coloring. `detect_cycles()` returns all cycles found. Tests cover simple cycles (A→B→A) and transitive cycles (A→B→C→A). |
| Impact analysis ("what breaks if I change X?") | **PRESENT** | `find_dependents(file_path)` uses BFS on the reverse edge map to find all files that depend on the given file (both directly and transitively). Example tested: if `d.ts → a.ts → b.ts`, then `find_dependents("b.ts")` returns `["a.ts", "c.ts", "d.ts"]`. |
| "Where is this used?" | **PRESENT** | Same as impact analysis — `find_dependents()` answers this for file-level usage. |
| "Trace request flow" | **MISSING** | No call graph means no function-level flow tracing. File-level import tracing exists but does not show the execution/control flow path. |
| Topological sort | **MISSING** | No topological sort implementation. |
| Hub file detection | **PARTIAL** | The frontend debt analyzer (`DependencyGraphEngine.ts`) has hub file detection (statistical threshold: mean + 2×stddev or >10 dependents). The Rust graph builder does not compute this. |

### Graph Database

| Aspect | Status | PunamIDE Implementation |
|---|---|---|
| Storage engine | In-memory only | `HashMap<String, Vec<String>>` — not persisted, not a database. |
| Neo4j / NetworkX | **MISSING** | No graph database. The graph is rebuilt from scratch each time via `build_dependency_graph`. |

**Verdict: Code Graph is ~35% complete.** File-level import graph with cycle detection and impact analysis is solid. Function/class-level nodes, call edges, and inheritance edges are all completely missing. No graph database — pure in-memory HashMaps.

---

## 5. Hybrid Retrieval Strategy

> "Use hybrid retrieval: (1) Symbol search — exact function/class match, (2) Keyword search — grep/ripgrep, (3) Vector search — semantic similarity. Then merge: `final_context = deduplicate(symbol_results + keyword_results + vector_results)`"

| Retrieval Strategy | Status | PunamIDE Implementation |
|---|---|---|
| **Symbol search** (exact function/class name match) | **MISSING** | No symbol index or symbol table to search. You cannot query "find the function `handleSubmit`" — there is no pre-built index mapping symbol names to file locations. LSP's `lsp_definition` provides this on-demand for the currently open file, but not as a codebase-wide search. |
| **Keyword search** (grep/ripgrep) | **PRESENT** | Multiple implementations: `search_commands.rs` provides regex project search. `search_codebase` provides TF-IDF with inverted index for ranked keyword search. `fuzzy_find_block` provides edit-distance-based fuzzy matching with configurable threshold. Token overlap scoring against file previews provides a lighter-weight keyword match. |
| **Vector search** (semantic similarity) | **MISSING for code** | `memory/embedding_store.rs` has cosine similarity search for **project memory entries only** (human-authored notes about architecture decisions, bugs, conventions). There is no embedding-based code retrieval. No code chunks are embedded. No embedding model generates vectors for code. TF-IDF provides some semantic capability through term weighting and inverse document frequency, but this is bag-of-words, not true embedding-based semantic similarity. |
| **Merge + deduplicate pipeline** | **PARTIAL** | `memory/retrieval_engine.rs` implements a hybrid merge pipeline that: (1) runs FTS5 full-text search, (2) runs embedding similarity search (optional), (3) merges results with conflict resolution (if found in both layers, score is combined 60/40), (4) deduplicates by memory ID, (5) reranks by combined relevance score. **But this pipeline only operates on project memories, not on code retrieval.** Code retrieval in `index_commands.rs` uses TF-IDF + token overlap but has no such merge/deduplicate/rerank pipeline. |

**Verdict: Hybrid Retrieval is ~25% complete for code.** The pipeline architecture exists for memories (FTS5 + embedding hybrid) but not for code retrieval. Symbol search is absent. Vector/code-embedding search is absent. Only keyword search (regex + TF-IDF + fuzzy) is functional for code.

---

## 6. Cursor-Like "Thinking" System Prompt

> "Your system prompt should NOT be generic. It should include rules like: always check imports before editing, always trace call chain before modifying function, never assume missing code, ask for file context if uncertain, prefer minimal patch."

### Current System Prompt (from `contextEngine.ts`)

```
You are Punam IDE Autopilot.

GLOBAL OBJECTIVE: ${globalGoal}
CURRENT SUBTASK: ${currentSubtask}
EDITOR STATE: file currently open, full path
PROJECT MEMORY: ${projectMemory}

RULES:
- The file shown in EDITOR STATE is what the user is currently looking at.
- When asked about a specific line number, look at the line numbers in the code context and quote exact content.
- Answer line questions in format: "Line X of filename contains: <exact content>"
- NEVER answer a line-content question with just the filename
- If line content is not in context, say "I cannot see that line in the current context."
- Do not ask for old chat history — use only what is provided here.
- Use the retrieved code context below instead of guessing file contents.
- Be precise and minimal. Only change what is necessary.
- If you need to see a file's content that isn't provided, say so explicitly.

OUTPUT FORMAT (MANDATORY):
===FILE: path/to/file.ext===
<entire content>
===END_FILE===

===DELETE: path/to/file.ext===

===CMD: command here===
```

### Missing Cursor-Like Rules

| Rule | Status |
|---|---|
| "Always check imports before editing" | **MISSING** — The system prompt never instructs the model to verify that an import exists before using a symbol. |
| "Always trace call chain before modifying function" | **MISSING** — No instruction to understand what calls the function before changing its signature or behavior. |
| "Never assume missing code" | **PARTIAL** — The current prompt says "If you need to see a file's content that isn't provided, say so explicitly" which is close but weaker. Cursor's rule is stronger: the model should actively avoid guessing. |
| "Ask for file context if uncertain" | **MISSING** — No explicit instruction to request more context when uncertain. |
| "Prefer minimal patch" | **MISSING** — "Be precise and minimal. Only change what is necessary" covers this partially but doesn't explicitly prefer surgical patches over full-file rewrites. |
| "Don't hallucinate imports or dependencies" | **MISSING** — The model is never explicitly told not to invent import paths or external dependencies. |
| "Respect existing code patterns" | **MISSING** — No instruction to follow the existing code style and patterns in the file being edited. |

**Verdict: System prompt is ~45% complete for Cursor-like rules.** The technical output format rules (FILE/CMD/DELETE blocks) are well-defined. The line-number and context rules are good. But the defensive coding rules — check imports, trace call chains, don't hallucinate dependencies — are absent.

---

## 7. Context Compression

> "Large repos still exceed token limits. So you compress: instead of full file, keep only relevant function, summarize unrelated parts. You can do: 'summarize this file in 10 lines focusing on auth flow'. Then store summary separately."

| Compression Technique | Status | PunamIDE Implementation |
|---|---|---|
| **Sliding window** (keep only last N messages) | **PRESENT** | `SLIDING_WINDOW_TURNS = 4` in `contextEngine.ts`. Only the last 4 messages go to the LLM. Full history is never sent. |
| **Message truncation** | **PRESENT** | Individual messages capped at 3,000 characters in the payload builder. |
| **Snippet capping** | **PRESENT** | Code snippets capped at 100,000 characters (`MAX_SNIPPET_CHARS`). |
| **File truncation** | **PRESENT** | Full file contents in `get_relevant_context` truncated at 3,000 chars. In `build_ai_context` (legacy), truncated at 2,000 chars. Both display `[truncated]` markers. |
| **Old message summarization** | **PRESENT** | `summarizeOldMessages()` compresses older chat history into a single block: "User asked: ...", "Punam edited: ...", "Punam ran: ...". Capped at 500 characters. This is a **mechanical** summary, not AI-generated. |
| **AI-based file summarization** ("summarize this file in 10 lines focusing on X") | **MISSING** | No LLM is ever called to summarize large files. All compression is mechanical (character/line limits, sliding windows). The system cannot produce a "10-line summary focusing on the auth flow." |
| **Selective function inclusion** (only include relevant function, not whole file) | **MISSING** | Since chunks are 30-line sliding windows (not function-level), it's impossible to select specific functions. The context builder either includes a 3,000-char truncation of the entire file or nothing. |
| **Separate summary storage** | **MISSING** | No mechanism to store and reuse file summaries. |

**Verdict: Context compression is ~55% complete.** Mechanical compression (sliding window, character limits, old-message summarization) is well-implemented. The critical missing feature is **AI-based summarization** — the ability to compress a 500-line file into a focused 10-line summary. Since function-level chunking is also missing, selective function inclusion isn't possible either.

---

## 8. Minimal Architecture Comparison

| Component | What's Required | What PunamIDE Has | Gap |
|---|---|---|---|
| **Parser** | tree-sitter | tree-sitter WASM loaded (4 language WASM files in `public/`) | ✅ Present but **only used by debt analyzer**, not for indexing or chunking |
| **Indexer** | ripgrep + AST | regex-based search (`search_commands.rs`), TF-IDF inverted index (`index_commands.rs`), file-level import parsing (`dependency_analyzer.rs`) | ❌ No AST-based indexing (function/class/symbol level) |
| **Vector DB** | pgvector / FAISS | SQLite BLOBs with brute-force cosine similarity (`embedding_store.rs`, up to 1000 vectors) | ❌ No ANN index, no pgvector/FAISS, not used for code embeddings |
| **Graph DB** | Neo4j (optional) | In-memory `HashMap<String, Vec<String>>` (`graph_builder.rs`) — no persistence, no graph query language | ❌ No graph database, no persistence, no Cypher/Gremlin equivalent |
| **LLM** | GPT / Claude / local model | Gemini, OpenAI, OpenRouter, Groq, Mistral, Ollama — 6 providers with native streaming | ✅ Full multi-provider support with tool use across Anthropic, Gemini, and JSON-fallback |
| **Orchestrator** | Node.js / Python agent loop | TypeScript `agentToolLoop.ts` (830 lines) with 3 provider-specific adapters, cancellation, timeouts, observation tracking, deduplication | ✅ Present but missing Planner and Verifier stages |
| **Embedding Model** | OpenAI / bge / etc. | None implemented (`embeddings.rs` is a stub) | ❌ No code embedding generation at all |
| **System Prompt** | Cursor-like rules | Basic rules (be precise, don't guess, output format) | ⚠️ Missing defensive coding rules |

---

## 9. What Makes Cursor "Feel Magic"

| Success Factor | Status | Details |
|---|---|---|
| **Fast retrieval (<300ms)** | **UNCLEAR** | TF-IDF with in-memory HashMap should be fast for small-to-medium codebases. Embedding search with brute-force scan of up to 1000 vectors could be slow but is not used for code. No perf benchmarks found in the codebase. |
| **Correct context selection** | **PARTIAL** | The scoring pipeline (TF-IDF + token overlap + git boost + tab boost + extension boost) is reasonable. But missing: symbol search, dependency-neighbor inclusion, and function-level granularity. Context correctness likely degrades on large codebases. |
| **Structured code graph** | **PARTIAL** | File-level import graph with cycle detection and impact analysis is good. But function/class-level nodes and call/inheritance edges are missing — the graph lacks the resolution needed for precise answers. |
| **Tight agent loop** | **PRESENT** | The tool-calling loop is well-architected: 10-round max, 120s per-round timeout, duplicate detection, observation tracking, final answer synthesis, cancellation support. Multi-provider adapters handle Anthropic native tool use, Gemini function calling, and JSON fallback. |
| **Small, precise context injection** | **PRESENT** | Sliding window (4 turns), message caps (3000 chars), snippet limits (100K chars), file truncation (3000 chars), with `[truncated]` markers. Project memory compression (top 10 by importance). Context token estimation. |

**Verdict: 3 of 5 magic factors are present or partially present.** The agent loop and context compression are solid. The graph and retrieval are partially there. Fast retrieval timing is unproven without benchmarks.

---

## 10. Power Upgrades

| Upgrade | Status | Details |
|---|---|---|
| **🔥 Code-aware diff engine** — only send changed lines, not full files | **PRESENT** | `try_3way_merge` in Rust (`lib.rs`) prevents silent overwrites by detecting conflicts and generating conflict markers. Frontend components: `AiDiffPreview.tsx` shows AI-proposed changes as diffs, `MultiFileDiffBoard.tsx` provides PR-style multi-file diff review with per-hunk accept/reject, `chat/DiffView.tsx` renders inline diffs in chat. `AgentApplyGuard.ts` validates agent-proposed changes before applying. |
| **🔥 Auto-test loop** — run unit tests, lint, typecheck after each change | **MISSING** | The agent loop has **no verification step**. After applying a patch, it does NOT automatically run tests, linters, or type checkers. `BugHunt.tsx` has a verification/code-quality pipeline (`lint → typecheck → build → test`) and `services/ci/VerificationRunner.ts` exists for CI/CD monitoring with `run/audit/diagnose/summarize` operations, but neither is integrated into the agent's workflow. `services/ci/LogAnalyzer.ts` can parse CI logs for failure types (build, test, lint, type_check) and `services/ci/PatchGenerator.ts` can generate fixes but these are separate CI-monitoring features. |
| **🔥 Memory per repo** — remembers architecture decisions, modules, patterns | **PRESENT** | Full project memory system: `memory/memory_engine.rs` stores architecture decisions, bug resolutions, refactors, and conventions in SQLite with FTS5 full-text search. 11 Tauri commands: init, create, getById, list, search, update, delete, getByFile, getTimeline, quickAdd. `memory/retrieval_engine.rs` provides hybrid retrieval (FTS5 + embedding) with auto-injection into AI prompts. Frontend services: `BugKnowledgeBase.ts`, `DecisionStore.ts`, `MemoryIndexer.ts`, `MemoryManager.ts`, `RefactorHistory.ts`. |

---

## Overall Summary

| Category | Score |
|---|---|
| 1. 3-Layer Memory System | 35% — Strong file graph, no AST index, no code embeddings |
| 2. Agent Loop (Plan→Retrieve→LLM→Verify) | 50% — Tool loop works, missing Planner + Verifier |
| 3. Function-Level Chunking | 5% — Uses 30-line blind windows |
| 4. Code Graph | 35% — File-level only, no function/class/call/inheritance nodes |
| 5. Hybrid Retrieval | 25% — Keyword search works, no symbol or vector search for code |
| 6. System Prompt | 45% — Good format rules, missing defensive coding rules |
| 7. Context Compression | 55% — Mechanical compression solid, no AI summarization |
| 8. Minimal Architecture | Matches on LLM + orchestrator; gaps in parser usage, vector DB, graph DB, embedding model |
| 9. "Feels Magic" Factors | 3/5 present or partial |
| 10. Power Upgrades | 2/3 present (diff engine, memory); auto-test loop missing |

### Critical Gaps (Must-Have)

| # | Gap | Why It Matters |
|---|---|---|
| 1 | **No AST-based function/class index** | Can't answer "where is this function defined and what depends on it?" |
| 2 | **No function-level chunking** (30-line blind windows instead) | Embeddings and retrieval hit irrelevant context; causes hallucination |
| 3 | **No code embedding pipeline** | Can't do "find similar logic across the repo" — the core semantic search promise |
| 4 | **No Planner stage in agent loop** | Agent is reactive, not proactive — can't plan multi-step investigations |
| 5 | **No Verifier stage in agent loop** | No automatic test/lint/typecheck after patches — changes can silently break things |
| 6 | **No symbol search in retrieval** | Can't find a function by name across the codebase |
| 7 | **Call graph neighbors not wired into context builder** | Context lacks transitive import relationships — misses related code |
| 8 | **No function/class-level graph nodes** | Can't answer "what calls this function?" or "what extends this class?" |

### PunamIDE's Strengths

1. **Full agent tool loop** — 6 providers, 3 protocols, streaming, cancellation, timeouts
2. **File-level dependency graph** — imports, cycle detection, impact analysis across 4 languages
3. **TF-IDF codebase indexing** — inverted index with relevance scoring
4. **Multi-agent orchestration** — coordinator, scheduler, conflict resolver, apply guard
5. **Project memory system** — SQLite + FTS5 + embeddings, hybrid retrieval, auto-injection into prompts
6. **LSP integration** — go-to-definition, completions, hover, formatting for 4 languages
7. **3-way merge** — prevents silent overwrites during concurrent AI+human editing
8. **Architecture guardrails** — rule validation, dependency checking, patch safety gates
9. **Context compression** — sliding window, message caps, old-message summarization
10. **Snapshot system** — project state checkpointing with restore preview and ZIP export