# Changelog

All notable changes to PunamIDE are documented here.  
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).  
Versioning follows [Semantic Versioning](https://semver.org/).

## [2.1.5] — 2026-07-20

### Fixed
- **File explorer depth limit** — folders nested beyond 4 levels (e.g., `src/renderer/src/subfolder/`) were showing as expandable but rendering empty. Root cause: Rust `read_directory` had a hard `max_depth=4`. Replaced with true lazy loading architecture.
- **React useMemo warning** — fixed `The final argument passed to useMemo changed size between renders` caused by spreading tab paths into a dependency array. Changed to stable `.join(",")` key.

### Changed
- **File explorer — lazy loading architecture** — complete rewrite of directory loading strategy:
  - Initial project open now loads depth=2 only (root + first level) — fast for any project size
  - Expanding a folder lazy-loads its immediate children via new `read_directory_shallow` Rust command
  - No artificial depth limit — any nesting depth works on demand
  - `node_modules`, `dist`, `build` etc. are never loaded until user explicitly expands them
  - Eliminates UI freeze on large projects regardless of directory structure
  - New Rust command: `read_directory_shallow` (single-level, no recursion)
  - Frontend: `FileExplorer.tsx` manages local enriched tree with `mergeChildrenIntoTree`

### Added
- **TDA deep audit report** — comprehensive technical debt analysis audit documented at `docs/TDA-AUDIT-2026-07-20.md`. Covers wiring status (14 working features, 5 bugs found, 4 performance issues, 6 enhancement opportunities).

---

## [2.1.4] — 2026-07-18

### Fixed
- **File explorer "not responding" on large projects** — 5 targeted performance fixes:
  - `refresh_project_index` converted to async with `spawn_blocking` (no longer blocks Tauri command thread during indexing)
  - Preview generation threshold reduced from 500KB to 50KB (lazy previews — avoids reading large files during bulk indexing)
  - New `update_file_index_batch` command (single write-lock acquisition for batches, async with `spawn_blocking`)
  - File watcher event coalescing (accumulates paths across 500ms debounce window, flushes as single batched index update + tree refresh)
  - React tree optimization — `flattenVisibleTree` result cached to avoid full O(n) traversal on expand/collapse
- **TypeScript build error** — fixed `onClick={handleScan}` type mismatch in `EnvironmentDashboard.tsx` (pre-existing bug blocking production builds)
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
