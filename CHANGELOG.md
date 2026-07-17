# Changelog

All notable changes to PunamIDE are documented here.  
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).  
Versioning follows [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Fixed
- **File Explorer render optimization (H-2)** — the `FileExplorer` component re-rendered on every App state change (cursor moves, toasts, breakpoint toggles) even when its props hadn't changed. Wrapped in `React.memo` and added stable callback wrappers (ref-delegation pattern) for `onFileSelect`, `onPathDeleted`, `onPathRenamed`, and `onBeforePathAction` so `memo`'s shallow comparison can skip renders. Also moved `appEventStateRef` assignment from render body to `useEffect` to avoid stale ref values in concurrent mode.
- **Batch IPC for file index updates (H-3)** — the file watcher handler was calling `updateFileIndex` in a per-file loop, causing N serialized IPC roundtrips + N `RwLock` acquisitions for each `fs-changed` event (e.g., 100 files = 200 serialize/deserialize passes). Added Rust `update_file_index_batch(Vec<String>)` command that locks the `ProjectIndexCache` once and processes all paths. Frontend now calls a single `updateFileIndexBatch` per event.
- **Architecture dependency analyzer regex caching (M-1)** — every call to `parse_es6_imports`, `parse_commonjs_requires`, `parse_dynamic_imports`, `parse_python_imports`, and `parse_rust_imports` was compiling 2-3 regex patterns from scratch. For a 500-file project, that's 1,000-1,500 regex compilations. Replaced inline `Regex::new()` calls with 8 `OnceLock<Regex>` static caches (zero new dependencies — `OnceLock` is stable since Rust 1.70, project MSRV is 1.77). All 13 existing unit tests pass unmodified.
- **File watcher double debounce (M-3)** — the Rust debouncer was set to 500ms and the frontend applied its own 500ms debounce on top, resulting in up to 1 second delay between a file save and the tree refreshing. Reduced both to 150ms (combined worst-case ~300ms). Bulk operations like `git checkout` are still coalesced by the OS-level notify debouncer.
- **Incremental project index (M-6)** — `refresh_project_index` was rebuilding the entire file index from scratch on every call, re-reading ~500 chars of preview content from every file even when nothing had changed. Added `index_directory_incremental` that reuses cached `FileIndexEntry` values when both `size` and `modified` timestamp match the previous scan. For a 500-file project with no changes, this drops from ~500 `fs::read_to_string` calls to ~500 `fs::metadata` calls (10-50x faster).
- **Environment scan freezes IDE** — the Env dashboard's `scan_tools` command was a synchronous Tauri command using `std::process::Command::output()` to check 20 tools sequentially on the main thread. Each subprocess spawn blocked the UI thread, causing Windows to report "Not Responding" for the duration of the scan (~10 seconds). Fixed by making `scan_tools` async (offloaded to Tauri's tokio runtime), replacing `std::process::Command` with `tokio::process::Command` for non-blocking subprocess I/O, and running all 20 tool checks in parallel via `futures_util::future::join_all`. Scan now completes in ~1-2 seconds without blocking the UI.
- **File explorer freezes IDE on project open** — the `read_directory` Rust command was a synchronous Tauri command that recursively scanned 4 levels deep on the main thread, blocking the UI for 2-5 seconds on large projects. Fixed by making `read_directory` async (offloaded to Tauri's tokio runtime) and removing recursive tree-building — it now returns only immediate directory children. The frontend FileExplorer was refactored to lazy-load directory contents on expand, caching results in a `childrenCache` Map to avoid redundant IPC calls. Project root loads instantly (~20ms for 50 entries) and subdirectories load on demand when the user clicks the chevron.
- **Refactor workflow** — connected the panel to the live editor cursor and exact selection, added the missing Rust LSP rename command, and made Move File remove its source after updating imports.
- **Refactor safety** — refreshes open editor content and the file tree after confirmed changes; updated move tests to cover source removal.
- **Tool panel behavior** — opening a top-bar workspace tool now replaces the previous tool instead of leaving overlapping panels mounted.
- **tsconfig strict mode restored** — permanently fixed TS1484 (`verbatimModuleSyntax`) and TS1294 (`erasableSyntaxOnly`) errors from the v2.2.0 TDA migration. Applied ESLint `@typescript-eslint/consistent-type-imports` auto-fix across the review/ layer (~50 bare type imports corrected to `import type`), converted 3 enums (`ProviderType`, `SupportedLanguage`, `AgentRole`) to the `as const` + companion type pattern, and converted 5 parameter property constructors (`constructor(private x: T)`) to explicit property declarations + manual assignment. Both `verbatimModuleSyntax` and `erasableSyntaxOnly` restored to `true` in `tsconfig.app.json`. `tsc --noEmit` passes with 0 errors.

### Added
- **"Fix with AI" wired to LLM** — created `FixWithAiProvider` adapter bridging PunamIDE's existing AI provider system (`AIConfigProvider` / `sendToProvider()`) to the `FixLlmProvider` interface expected by `AiFixHandler`. Wired via `RightPanel.tsx` so the "Fix with AI" button in the Technical Debt dashboard is no longer grayed out when an LLM is configured.
- **Plan approval modal** — new `PlanApprovalModal` component shows a deterministic pre-approval step before the LLM generates code. Built entirely from existing TDA metadata (`RefactorPlanItem`, `HotspotASTDetail`, `extractFixScope`): target file/scope, problem details (CC, god functions, nesting, params), planned operations, guard rails, and expected payoff. `[Cancel]` / `[Approve & Generate Fix with AI]` buttons. Zero additional LLM tokens consumed.

### Changed
- **Refactor panel** — expanded form controls and operation labels, added contextual guidance and an internal scroll area, and made the right-side panel resizable from its left border.
- **Development launcher** — `autorun.bat` validates the Rust backend with `cargo check` before starting Tauri development mode.

---

## [2.1.2] — 2026-07-10

### Added
- **Inline Diff Preview** — shows AI proposed changes directly in the editor gutter before applying
- **Edit Preview Panel** — dedicated review panel for AI-generated edits with accept/reject per hunk
- **Intelligence Panel** — unified view of embeddings, symbol index, and call graph status
- **Dependency Graph View** — interactive visual dependency graph powered by `@xyflow/react`
- **Context Sidebar** — live breakdown of what's in the AI context window (files, symbols, git diff)
- **Context Window Bar** — real-time token usage indicator in chat input area
- **Import Panel** — workspace and project import UI
- **Merge Conflict Panel** — visual merge conflict resolution with accept/reject per block
- **Refactor Panel** — UI for reviewing and applying AI-assisted refactor operations
- **Reasoning Panel** — shows AI chain-of-thought in compact or expanded mode
- **Task Planner Panel** — AI generates step-by-step plan before executing tasks
- **Task Cost Summary** — per-task cost breakdown overlay
- **Budget Selector** — configure per-task token/cost budget from chat
- **Budget Warning Dialog** — prompts user when approaching token/cost limits
- **Clarification Dialog** — AI asks clarifying questions before ambiguous tasks
- **Agent Approval Gate** — fine-grained accept/reject per tool call in supervised mode
- **Breadcrumbs** — navigation breadcrumb bar above editor
- **Tree-sitter WASM** — added Python (`tree-sitter-python.wasm`) and Rust (`tree-sitter-rust.wasm`) parsers
- **Autocomplete Engine** — FIM / chat-fallback / auto-detect ghost-text completion
- **Completion Cache** — avoids redundant autocomplete requests
- **Suppression Logic** — smart suppression in comments, strings, and short tokens
- **Context Compressor** — configurable compression strategies for large context windows
- **Context Assembler** — unified multi-source context builder
- **Context Injector** — injects assembled context into AI prompts with configurable strategy
- **Symbol Search** (`lsp/symbolSearch.ts`) — LSP-powered cross-file symbol lookup
- **Proactive Error Detector** — watches terminal output and surfaces actionable fixes
- **Session Memory** — persists agent decisions and context summaries across turns
- **Refactor Service** — changeset-based refactoring with validation
- **TestGenerator Service** — AI-assisted unit test generation
- **DAPBridge** — frontend ↔ Rust Debug Adapter Protocol bridge
- **Ambiguity Detector** — pre-flight task analysis to detect unclear instructions
- **Budget Controller** — enforces per-task token and cost limits
- **Loop Guard** — prevents infinite agent tool-calling loops
- **Tool Policies** — configurable per-tool permission policy
- **Model Cost Registry** — centralized model pricing table (USD + INR)
- **Token Budget Manager** — tracks token usage per agent session
- **Refinement Loop** — post-response quality check and refinement
- **Clarification Memory** — stores prior clarifications to avoid re-asking
- **Workspace Importer** (`workspace_import.rs`) — Rust-native workspace import
- **Autocomplete backend** (`autocomplete.rs`) — Rust-side completion support
- **Context Compressor** (`context_compressor.rs`) — Rust-side context compression
- **Tree-sitter query files** — `.scm` query files for TypeScript, Python, Rust
- **Observability** (`observability.ts`) — Sentry performance monitoring integration
- **Alpha feedback config** (`config/alpha.ts`) — alpha-phase feature flags
- **System prompt utility** (`systemPrompt.ts`) — centralized system prompt builder
- **Conflict parser** — git merge conflict block parser
- **Context compactor** — trims context to fit within model limits
- **Context window size utility** — model-aware context limit lookup
- **Diff lines utility** — line-level diff computation
- **MCP curated servers** — pre-configured list of popular MCP servers
- **Anthropic provider module** — dedicated streaming provider with native tool-use
- **Per-provider tool loops** — `anthropicLoop`, `geminiLoop`, `openaiLoop`, `jsonFallbackLoop`
- **Approval gate** and **approval helpers** in tool loop pipeline
- **Planner** and **verifier** steps in tool loop pipeline
- **Property-based tests** via `fast-check` for streaming pipeline components
- **Technical debt tests** — full test suite for AST engine, debt scorer, graph engine, etc.
- **Incremental Graph Engine** — updates dependency graph on file changes without full re-scan
- **Graph Exporter** — exports dependency graph as JSON/SVG
- **Diff Engine** — tracks technical debt changes over time
- **Circular Dependency Detector**
- **Coupling Analyzer**
- CSS: `20-merge-conflict.css`, `context-sidebar.css`, `import-panel.css`, `18-edit-preview.css`, `19-intelligence-panel.css`, `alpha-feedback.css`

### Changed
- Agent autopilot mode now has a master toggle in settings (auto-approve safe ops vs supervised per-action)
- Settings store extended with `autocompleteEnabled`, `autocompleteMode`, `autocompleteDebounceMs`, `autocompleteMaxTokens`, `agentAutopilot`, `reasoningDisplay`, `contextInjectorConfig`, `compressionConfig`
- Token estimation now includes per-model pricing for DeepSeek v3/R1/v4 variants
- Activity bar now includes **AI Context** panel (Brain icon)
- Tool loop shared types extended with budget, clarification, and context optimization options

### Fixed
- CSS brace mismatch in `polish.css` around `.context-budget-indicator` block
- `@import "tailwindcss" layer(utilities)` syntax in `src/index.css`

---

## [2.1.1] — 2026-06-26

### Added
- Multi-agent dashboard UI
- RAG Workbench panel
- Chunk inspector and hallucination detector
- Embedding analyzer worker
- Architecture rules editor in settings
- Environment dashboard
- CI Dashboard
- Security panel
- Impact analysis panel

### Changed
- Chat message bubbles refactored into dedicated sub-components (CodeBlock, DiffView, MessageBubble, ResponseBlock, ThinkingBlock, ToolCallCard, ToolResultCard)
- Chat input area extracted to dedicated component

### Fixed
- Various streaming pipeline stability issues
- Architecture rule validation on patch apply

---

## [2.1.0] — 2026-06-24

### Added
- **Multi-Agent System** — AgentOrchestrator, TaskScheduler, ConflictResolver
- **AgentApplyGuard** — validates patches through architecture + security layers before apply
- **Background Agent Executor** — runs agents in the background without blocking UI
- **Architecture Engine** — full dependency analysis, impact prediction, rule validation
- **Technical Debt Dashboard** — debt visualization with charts and file-level breakdown
- **Memory System** — BugKnowledgeBase, DecisionStore, MemoryIndexer, MemoryManager, RefactorHistory
- **Security Scanner** — Rust-native vulnerability detection
- **CI Monitor** — GitHub Actions integration
- **Docker panel** — container management
- **Environment scanner** (Rust)
- **Package manager** (Rust)
- **Embedding pipeline** (Rust) — batch local embedding processing
- **Vector store** — semantic search over codebase

### Changed
- Provider system unified under `AIProviderConfig` with support for Gemini, OpenAI-compatible, and Anthropic types
- Token cost estimation now covers all major providers with USD + INR display

---

## [2.0.0] — 2026-06-22

### Added
- Initial v2.0 release
- Monaco Editor integration
- Tauri 2 desktop shell
- Multi-provider AI chat (Gemini, OpenAI, Groq, Mistral, Ollama, OpenRouter)
- File explorer with VS Code–style icons
- Integrated PTY terminal (xterm.js)
- Git panel (git2 Rust library)
- GitHub integration (auth, repos, issues, PRs, gists)
- LSP client and Monaco bridge
- Snapshot manager
- Inline AI edit (`Ctrl+K`)
- Diff viewer
- Debugger panel (DAP)
- Command palette
- Notepads
- Split editor
- Project search
- Find & replace
- Run profiles
- Live preview
- Fuzzy file picker
- Status bar
- Title bar with window controls
- Settings panel with full keybinding customization
- Usage dashboard with token/cost tracking
- Agent Kanban board

---

## [1.x] — Legacy

PunamIDE v1.x was a browser-based prototype. v2.0 is a complete rewrite as a native desktop app using Tauri.