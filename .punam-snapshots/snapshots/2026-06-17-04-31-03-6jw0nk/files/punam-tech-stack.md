# PunamIDE v2.0 — Comprehensive Tech Stack & Architecture Report

> **Generated:** 2026-06-01  
> **Version:** 2.0.0  
> **License:** MIT  
> **Repository:** github.com/mandaloriantrader/punamIDe-v2.0-full-update

---

## Table of Contents

1. [Overview & Vision](#1-overview--vision)
2. [Desktop Shell — Tauri 2.x](#2-desktop-shell--tauri-2x)
3. [Frontend — React 19 + TypeScript 6](#3-frontend--react-19--typescript-6)
4. [State Management — Zustand 5](#4-state-management--zustand-5)
5. [Code Editor — Monaco Editor](#5-code-editor--monaco-editor)
6. [Terminal — xterm.js + PTY](#6-terminal--xtermjs--pty)
7. [Styling — Tailwind CSS 4 + Custom CSS](#7-styling--tailwind-css-4--custom-css)
8. [Build Tooling — Vite 8](#8-build-tooling--vite-8)
9. [Rust Backend — Full Module Map](#9-rust-backend--full-module-map)
10. [AI / LLM Integration Layer](#10-ai--llm-integration-layer)
11. [Multi-Agent System](#11-multi-agent-system)
12. [LSP (Language Server Protocol)](#12-lsp-language-server-protocol)
13. [DAP (Debug Adapter Protocol)](#13-dap-debug-adapter-protocol)
14. [Git & GitHub Integration](#14-git--github-integration)
15. [Technical Debt Analysis Engine](#15-technical-debt-analysis-engine)
16. [Project Memory System](#16-project-memory-system)
17. [Project Indexing & Search](#17-project-indexing--search)
18. [Snapshot System](#18-snapshot-system)
19. [Security Layer](#19-security-layer)
20. [Architecture Guardrails Engine](#20-architecture-guardrails-engine)
21. [Docker & Package Manager Integration](#21-docker--package-manager-integration)
22. [CI/CD Monitoring](#22-cicd-monitoring)
23. [Embeddings & RAG Workbench](#23-embeddings--rag-workbench)
24. [Web Search & Context Gathering](#24-web-search--context-gathering)
25. [In-Built Terminal & Shell Environment](#25-in-built-terminal--shell-environment)
26. [File Watcher & Live Reload](#26-file-watcher--live-reload)
27. [Persistence Layer — SQLite + Plugin Store](#27-persistence-layer--sqlite--plugin-store)
28. [Workers & Off-Thread Processing](#28-workers--off-thread-processing)
29. [UI Component Map (Full List)](#29-ui-component-map-full-list)
30. [Feature Roadmap (Planned & Research)](#30-feature-roadmap-planned--research)
31. [CSP & Security Posture](#31-csp--security-posture)
32. [Keyboard Shortcuts](#32-keyboard-shortcuts)
33. [Supported AI Providers & Models](#33-supported-ai-providers--models)
34. [Build Outputs & Distribution](#34-build-outputs--distribution)

---

## 1. Overview & Vision

PunamIDE v2.0 is a **VS Code-like, AI-powered, native desktop code editor** built for **$0** — no subscriptions, no cloud lock-in. The entire application runs locally on the user's machine with optional connections to free-tier LLM providers. It is built on a **Tauri + Rust + React + TypeScript** stack, producing a ~15 MB binary versus Electron's 200 MB+.

**Core Design Principles:**
- **Native Performance** — Rust backend for all heavy operations (filesystem, indexing, AI API calls, LSP, DAP, PTY, git).
- **AI-First** — Multi-provider LLM support (Gemini, OpenAI, OpenRouter, Groq, Mistral AI, Ollama) with streaming, tool-use loop, and multi-agent orchestration.
- **Offline-Capable** — Full project indexing, search, diff, merge, technical debt analysis all run locally without internet.
- **Security-First** — Command safety validation, path sandboxing, CSP enforcement, pre-push safety checks.
- **Extensible** — LSP-based language intelligence, DAP-based debugging, MCP (Model Context Protocol) server configuration.

---

## 2. Desktop Shell — Tauri 2.x

| Aspect | Detail |
|---|---|
| **Framework** | Tauri 2.11.2 |
| **Language** | Rust (edition 2021, rust-version 1.77.2) |
| **WebView** | System-native (WebKit2GTK on Linux, WebView2 on Windows, WKWebView on macOS) |
| **Window Config** | 1400×900 default, 800×600 min, resizable, decorated |
| **Product Name** | `PunamIDE v2.0` |
| **Identifier** | `com.punamide.app` |
| **Frontend Dist** | `../dist` (Vite build output) |
| **Dev URL** | `http://localhost:5173` |
| **Binary Size** | ~15 MB (vs Electron ~200 MB) |

### Tauri Plugins Used

| Plugin | Version | Purpose |
|---|---|---|
| `tauri-plugin-dialog` | 2 | Native file open/save dialogs |
| `tauri-plugin-fs` | 2 | File system access |
| `tauri-plugin-shell` | 2 | Shell command execution |
| `tauri-plugin-store` | 2 | Persistent key-value storage |
| `tauri-plugin-log` | 2 | Structured logging (Info in dev, Warn in release) |

---

## 3. Frontend — React 19 + TypeScript 6

| Layer | Technology | Version |
|---|---|---|
| **UI Framework** | React | 19.2.6 |
| **DOM Rendering** | react-dom | 19.2.6 |
| **Language** | TypeScript | ~6.0.2 |
| **Type Checker** | tsc (TypeScript compiler) | 6.0.2 |
| **Linting** | ESLint | 10.3.0 |
| **Lint Plugins** | typescript-eslint 8.59.2, eslint-plugin-react-hooks 7.1.1, eslint-plugin-react-refresh 0.5.2 |

### Frontend Architecture

```
src/
├── main.tsx                    # React entry point
├── App.tsx                     # Main app layout (~2958 lines)
├── App.css                     # Global app styling
├── index.css                   # Tailwind entry
├── monacoSetup.ts              # Monaco editor configuration
├── components/                 # 60+ UI components
│   ├── ActivityBar.tsx         # VS Code-style activity bar
│   ├── FileExplorer.tsx        # Tree-view file browser
│   ├── CodeEditor.tsx          # Monaco editor wrapper
│   ├── EditorTabs.tsx          # Multi-tab editor management
│   ├── TerminalPanel.tsx       # Integrated terminal panel
│   ├── AiChat.tsx              # AI chat interface (Cline-like)
│   ├── CommandPalette.tsx      # Ctrl+Shift+P command palette
│   ├── StatusBar.tsx           # Bottom status bar
│   ├── TitleBar.tsx            # Custom title bar
│   ├── Settings.tsx            # Settings panel
│   ├── SplitEditor.tsx         # Split-pane editor
│   ├── SearchPanel.tsx         # Project-wide search
│   ├── FindReplace.tsx         # Find & replace widget
│   ├── GitPanel.tsx            # Git operations panel
│   ├── GitDiffView.tsx         # Git diff viewer
│   ├── DebuggerPanel.tsx       # Debugger interface
│   ├── DebugConfigPicker.tsx   # Debug configuration picker
│   ├── BreakpointGlyphs.tsx    # Breakpoint gutter decorations
│   ├── MultiFileDiffBoard.tsx  # PR-style multi-file diff review
│   ├── AiDiffPreview.tsx       # AI change preview
│   ├── ComposerPanel.tsx       # AI composer/agent panel
│   ├── InlineEdit.tsx          # Inline code editing
│   ├── InlineEditWidget.tsx    # Inline edit widget
│   ├── BackgroundAgentPanel.tsx # Background agent status
│   ├── AgentKanban.tsx         # Agent task kanban board
│   ├── MultiAgentDashboard.tsx # Multi-agent overview
│   ├── BugHunt.tsx             # Bug hunting interface
│   ├── CodeReview.tsx          # Code review panel
│   ├── CiDashboard.tsx         # CI monitoring dashboard
│   ├── DockerPanel.tsx         # Docker container management
│   ├── EnvironmentDashboard.tsx # Development environment status
│   ├── DependencyGraphView.tsx  # Interactive dependency graph (canvas, force-directed)
│   ├── ImpactAnalysisPanel.tsx  # Change impact analysis
│   ├── TechnicalDebtDashboard.tsx # Technical debt overview
│   ├── LivePreview.tsx         # Live HTML/CSS preview
│   ├── WebPreviewPanel.tsx     # Web preview panel
│   ├── McpSettings.tsx         # MCP server configuration
│   ├── MemoryExplorer.tsx      # Project memory browser
│   ├── NotepadsPanel.tsx       # Notepad manager
│   ├── NotesPanel.tsx          # Notes panel
│   ├── ProblemsPanel.tsx       # Diagnostics/problems panel
│   ├── ProjectSearch.tsx       # Project-wide file search
│   ├── RagWorkbenchPanel.tsx   # RAG debugging workbench
│   ├── RightPanel.tsx          # Right-side panel container
│   ├── RunProfiles.tsx         # Run configuration profiles
│   ├── SecurityPanel.tsx       # Security scan panel
│   ├── SettingsPanel.tsx       # Settings panel (alternate)
│   ├── ShellTerminal.tsx       # Shell terminal wrapper
│   ├── SnapshotManager.tsx     # Project snapshot manager
│   ├── TestGenerator.tsx       # AI test generator
│   ├── UsageDashboard.tsx      # API usage metrics dashboard
│   ├── FuzzyFilePicker.tsx     # Fuzzy file finder
│   ├── FileTemplatePicker.tsx  # File template selector
│   ├── FileIcon.tsx            # File type icon component
│   ├── ConfirmDialog.tsx       # Reusable confirmation dialog
│   ├── ErrorBoundary.tsx       # React error boundary
│   ├── Logger.ts               # Frontend logging utility
│   ├── chat/                   # Chat sub-components
│   │   ├── ChatComponents.tsx
│   │   ├── ChatHeader.tsx
│   │   ├── ChatInputArea.tsx
│   │   ├── CodeBlock.tsx
│   │   ├── DiffView.tsx
│   │   ├── MessageBubble.tsx
│   │   ├── ResponseBlock.tsx
│   │   ├── ThinkingBlock.tsx
│   │   ├── ToolCallCard.tsx
│   │   └── ToolResultCard.tsx
│   ├── github/                 # GitHub integration UI
│   │   ├── GitHubPanel.tsx
│   │   ├── IssuesPanel.tsx
│   │   ├── PullRequestPanel.tsx
│   │   ├── RepoManager.tsx
│   │   └── SyncPanel.tsx
│   └── settings/
│       └── AdaptiveModeSettings.tsx
├── hooks/                      # React custom hooks
│   ├── useAiWorker.ts
│   ├── useAttachments.ts
│   ├── useAutoSave.ts
│   ├── useChatSessions.ts
│   └── useKeyboardShortcuts.ts
├── lib/                        # Core libraries
│   ├── constants.ts
│   └── ai/
│       ├── adaptiveRouter.ts
│       ├── providerCapabilities.ts
│       ├── providerHealth.ts
│       └── taskDetection.ts
├── services/                   # Business logic services (see §11)
├── store/                      # Zustand stores (see §4)
├── stores/                     # Additional Zustand stores
├── styles/                     # CSS stylesheets
├── types/
│   └── index.ts                # Shared TypeScript types
├── utils/                      # Utility modules (see §10)
└── workers/                    # Web Workers (see §28)
```

---

## 4. State Management — Zustand 5

PunamIDE uses **Zustand 5.0.5** for lightweight, hook-based state management.

### Stores

| Store | Purpose |
|---|---|
| `aiStore.ts` | Chat messages, streaming state, notepads, token usage tracking, usage records |
| `backgroundAgentStore.ts` | Background agent task state, execution queue |
| `editorStore.ts` | Open tabs, active file, cursor positions, editor state |
| `fileStore.ts` | File tree, file contents cache, file metadata |
| `gitStore.ts` | Git status, branches, diffs, staging area |
| `searchStore.ts` | Search queries, results, search history |
| `settingsStore.ts` | AI provider config, API keys, models, theme, preferences |
| `terminalStore.ts` | Terminal sessions, command history, PTY state |
| `uiStore.ts` | Panel visibility, sidebar state, activity bar selection, layout |
| `githubStore.ts` | GitHub auth, repos, PRs, issues, sync status |
| `memoryStore.ts` | Project memory entries, embedding state, timeline |

---

## 5. Code Editor — Monaco Editor

| Aspect | Detail |
|---|---|
| **Package** | `@monaco-editor/react` 4.7.0 |
| **Core** | `monaco-editor` 0.55.1 |
| **Languages** | 30+ (TypeScript, JavaScript, Python, Rust, JSON, HTML, CSS, Markdown, etc.) |
| **Features** | Syntax highlighting, IntelliSense (via LSP bridge), minimap, multi-cursor, find/replace, bracket matching, code folding, glyph margins (breakpoints) |
| **Integration** | Wrapped in `CodeEditor.tsx` with LSP bridge (`monacoLspBridge.ts`) for real-time diagnostics |

### Monaco Setup (`monacoSetup.ts`)
Configures Monaco with language registrations, theme integration, and LSP bridge initialization. The `getLanguage()` helper maps file extensions to Monaco language IDs.

---

## 6. Terminal — xterm.js + PTY

| Aspect | Detail |
|---|---|
| **Frontend** | `@xterm/xterm` 6.0.0 |
| **Addons** | `@xterm/addon-fit` 0.11.0 (auto-resize), `@xterm/addon-web-links` 0.12.0 (clickable links) |
| **Backend** | `portable-pty` 0.8 (Rust crate) — true pseudo-terminal |
| **Architecture** | `pty_manager.rs` spawns native shell processes, streams I/O to xterm.js via Tauri events |

### Terminal Components
- `Terminal.tsx` — xterm.js wrapper
- `TerminalPanel.tsx` — Terminal tab container with multi-session support
- `ShellTerminal.tsx` — Shell terminal specialization
- `terminalCommands.ts` (Rust) — `run_terminal_command`, `check_tcp_port`, `start_terminal_process`, `stop_terminal_process`
- `errorParser.ts` — Parses terminal output for error patterns (Quick Action integration)

---

## 7. Styling — Tailwind CSS 4 + Custom CSS

| Layer | Technology | Version |
|---|---|---|
| **Utility Framework** | Tailwind CSS | 4.3.0 |
| **Vite Plugin** | `@tailwindcss/vite` | 4.3.0 |
| **Icons** | Lucide React | 1.16.0 |
| **Custom Styles** | 9 CSS files + App.css | Dark/Light themes |

### CSS Files
- `src/App.css` — Global app layout, dark/light themes (Catppuccin-inspired dark theme)
- `src/index.css` — Tailwind base
- `src/styles/debugger.css` — Debugger panel styles
- `src/styles/github.css` — GitHub panel styles
- `src/styles/index.css` — Index styles
- `src/styles/kanban.css` — Kanban board styles
- `src/styles/layout.css` — Layout grid/flex styles
- `src/styles/phase1.css` — Phase 1 feature styles
- `src/styles/polish.css` — UI polish/refinements
- `src/styles/right-panel.css` — Right panel styles
- `src/styles/snapshot.css` — Snapshot manager styles
- `src/styles/terminal-panel.css` — Terminal panel styles

---

## 8. Build Tooling — Vite 8

| Tool | Version | Purpose |
|---|---|---|
| **Vite** | 8.0.12 | Dev server + production bundler |
| **@vitejs/plugin-react** | 6.0.1 | React JSX/TSX transformation |
| **@tailwindcss/vite** | 4.3.0 | Tailwind CSS processing |
| **Base path** | `./` | Relative paths for Tauri file:// protocol |
| **WASM handling** | Custom Rollup config routes `.wasm` files to `assets/wasm/` |

### Vite Config Highlights
- `optimizeDeps.exclude: ['web-tree-sitter']` — prevents Vite from breaking WASM `instantiateStreaming`
- `worker.format: 'es'` — ES module workers for debt analyzer
- WASM asset routing via custom `assetFileNames` function

---

## 9. Rust Backend — Full Module Map

### Entry Point & Core (`src-tauri/src/`)

```
lib.rs (1652 lines) — Main application entry, all Tauri command registration, data types
main.rs — Process entry point
```

### Module Breakdown

| Module | File(s) | Purpose |
|---|---|---|
| **fs_commands** | `fs_commands.rs` | Filesystem operations: read/write/create/delete/rename directory/file, path exists, reveal in OS |
| **search_commands** | `search_commands.rs` | Project-wide text search (regex) |
| **terminal_commands** | `terminal_commands.rs` | Terminal command execution, TCP port checking, process management |
| **git_commands** | `git_commands.rs` | Git operations via `git2` crate: status, diff, log, branch |
| **index_commands** | `index_commands.rs` | Project index building, TF-IDF codebase indexing, fuzzy matching, AI context building |
| **agent_tools** | `agent_tools.rs` | Agent tool commands: `read_lines`, `apply_patch` |
| **pty_manager** | `pty_manager.rs` | Pseudo-terminal management: create, write, resize, kill sessions |
| **lsp_manager** | `lsp_manager.rs` | Language Server Protocol client: start/stop servers, send/receive JSON-RPC, diagnostics, auto-restart |
| **dap_manager** | `dap_manager.rs` | Debug Adapter Protocol client: start TCP/stdio debug sessions, send requests |
| **snapshot** | `snapshot/mod.rs` | Project snapshot creation, listing, restore preview, restore, export to ZIP, auto-snapshot |
| **safety** | `safety.rs` | Command safety validation (dangerous command detection, path jail enforcement) |
| **security_scanner** | `security_scanner.rs` | Security-first development: scan files and patches for vulnerabilities |
| **environment_scanner** | `environment_scanner.rs` | Environment tool detection: scan installed tools, check versions |
| **package_manager** | `package_manager.rs` | Universal package manager: install, remove, update, audit |
| **docker_controller** | `docker_controller.rs` | Docker operations: list containers, start, stop, logs, exec, remove |
| **embeddings** | `embeddings.rs` | Embedding generation stub (GPU research ongoing) |

### Sub-Modules

#### Architecture (`architecture/`)
| File | Purpose |
|---|---|
| `mod.rs` | Module exports |
| `dependency_analyzer.rs` | File/module dependency analysis |
| `graph_builder.rs` | Dependency graph construction |
| `rule_engine.rs` | Architecture rule validation, patch validation against rules |

#### GitHub (`github/`)
| File | Purpose |
|---|---|
| `mod.rs` | Module exports |
| `auth.rs` | Token storage, validation, user info |
| `client.rs` | HTTP client wrapper (reqwest) |
| `repos.rs` | Create, list, link, remove repos |
| `pull_requests.rs` | Create, list, merge, close PRs with comments |
| `issues.rs` | List, create, close issues with comments |
| `actions.rs` | Workflow runs: list, get, re-run |
| `gists.rs` | Create single and multi-file gists |
| `sync.rs` | Push, pull, fetch, stash, branch create/switch/delete, merge abort |
| `safety.rs` | Pre-push checks, pre-pull checks, dry-run push, safety snapshots |
| `types.rs` | Shared data types |

#### Memory (`memory/`)
| File | Purpose |
|---|---|
| `mod.rs` | Module exports |
| `memory_engine.rs` | CRUD for project memories, quick add, timeline, file-based lookup |
| `embedding_store.rs` | Vector embedding storage and similarity search |
| `retrieval_engine.rs` | Semantic memory retrieval, prompt injection |

### Rust Dependencies

| Crate | Version | Purpose |
|---|---|---|
| `tauri` | 2.11.2 | Desktop framework |
| `tauri-build` | 2.6.2 | Build tooling |
| `serde` / `serde_json` | 1.0 | Serialization/deserialization |
| `reqwest` | 0.12 | HTTP client (LLM APIs, GitHub API) |
| `tokio` | 1 | Async runtime (full features) |
| `futures-util` | 0.3 | Stream processing (SSE streaming) |
| `notify` + `notify-debouncer-mini` | 7 / 0.5 | File system watcher |
| `git2` | 0.19 | Git operations (libgit2 bindings) |
| `portable-pty` | 0.8 | Pseudo-terminal |
| `rusqlite` | 0.31 (bundled) | SQLite database for chat persistence |
| `regex-lite` | 0.1 | Lightweight regex for search |
| `dirs` | 5 | Platform-appropriate app data directories |
| `walkdir` | 2 | Recursive directory walking |
| `zip` | 2.1 | ZIP archive creation for snapshot export |
| `log` | 0.4 | Logging facade |

### Tauri Commands (All Registered in `lib.rs` `run()`)

Total: **~95 registered commands** spanning:
- FS: `set_project_root`, `read_directory`, `read_file`, `write_file`, `create_file`, `create_directory`, `delete_path`, `rename_path`, `reveal_path`, `path_exists`
- Agent: `read_lines`, `apply_patch`
- Search: `search_project`
- Terminal: `run_terminal_command`, `check_tcp_port`, `start_terminal_process`, `stop_terminal_process`
- File Watch: `watch_project`, `stop_watching`
- LLM: `call_llm`, `call_gemini_stream`, `call_openai_compatible_cmd`, `call_openai_compatible_stream`
- Safety: `inspect_command`, `verify_path_safety`
- Index: `get_project_index`, `refresh_project_index`, `update_file_index`, `fuzzy_find_block`, `index_codebase`, `search_codebase`, `build_ai_context`, `get_relevant_context`
- Git: `git_status`, `git_diff_file`, `git_log`, `git_branch`
- Diff: `diff_strings`, `try_3way_merge`
- DB: `db_init`, `db_save_chat_session`, `db_load_chat_sessions`, `db_delete_chat_session`
- DAP: `dap_start`, `dap_start_tcp`, `dap_send_request`, `dap_stop`
- Snapshot: `create_snapshot`, `list_snapshots`, `get_restore_preview`, `restore_snapshot`, `export_snapshot_zip`, `delete_snapshot`, `auto_snapshot_if_enabled`
- PTY: `terminal_create`, `terminal_write`, `terminal_resize`, `terminal_kill`
- LSP: `lsp_start`, `lsp_did_open`, `lsp_did_change`, `lsp_did_save`, `lsp_completion`, `lsp_hover`, `lsp_definition`, `lsp_format`, `lsp_shutdown`, `lsp_did_close`
- GitHub: 30+ commands covering auth, repos, PRs, issues, actions, gists, sync, safety
- Architecture: `analyze_dependencies`, `analyze_file_dependencies`, `build_dependency_graph`, `validate_architecture`, `validate_patch_against_rules`, `get_default_rules`
- Security: `security_scan_file`, `security_scan_patch`
- Tools: `scan_tools`, `tool_installed`, `tool_version`
- Package Manager: `package_install`, `package_remove`, `package_update`, `package_audit`
- Docker: `docker_list_containers`, `docker_start`, `docker_stop`, `docker_logs`, `docker_exec`, `docker_remove_container`, `docker_available`
- Memory: 11 commands for CRUD + embedding store + retrieval engine

---

## 10. AI / LLM Integration Layer

### Supported Providers

| Provider | API Type | Pricing | Streaming |
|---|---|---|---|
| **Google Gemini** | Native Gemini API | Free tier | ✅ SSE streaming (`call_gemini_stream`) |
| **OpenAI** | OpenAI-compatible | Paid | ✅ SSE streaming |
| **OpenRouter** | OpenAI-compatible | Free/Paid models | ✅ SSE streaming |
| **Groq** | OpenAI-compatible | Free tier | ✅ Streaming |
| **Mistral AI** | OpenAI-compatible | Free/Paid tiers | ✅ Streaming |
| **Ollama** | OpenAI-compatible (localhost) | Free (local) | ✅ Streaming |

### Streaming Architecture
- **Rust Backend:** SSE (Server-Sent Events) parsing in `lib.rs`:
  - `call_gemini_stream` — Gemini-native SSE format (`candidates[0].content.parts[0].text`)
  - `call_openai_compatible_stream` — OpenAI SSE format (`choices[0].delta.content`)
- **Frontend:** `streamBlocks.ts` parses streaming tokens into structured blocks (thinking, tool calls, code blocks, markdown)
- **Rate Limiting:** Exponential backoff with retry (2s, 4s, 8s delays) in `call_openai_compatible_cmd`

### Model ID Normalization
Automatic model ID correction for OpenRouter:
- `qwen2.5` → `qwen-2.5`
- `deepseekr1` → `deepseek-r1`

### AI Utilities (Frontend)

| Module | Purpose |
|---|---|
| `utils/providers.ts` | Provider definitions, model lists, default configs, response metrics |
| `utils/prompts.ts` | System prompt construction, response parser (`ParsedResponse`) |
| `utils/protocol.ts` | `StreamBlock` types for structured streaming output |
| `utils/streamBlocks.ts` | Streaming token → structured block parser |
| `utils/contextEngine.ts` | AI context assembly (file tree, git status, open tabs, TF-IDF relevance) |
| `utils/contextGathering.ts` | Context gathering helpers |
| `utils/agentToolLoop.ts` | Agentic tool-use loop (read file → apply edit → verify) |
| `utils/agentTools.ts` | Agent tool definitions |
| `utils/mentionResolver.ts` | @-mention resolver (@file, @folder, @codebase, @web, @git, @terminal, @selection, @problems) |
| `utils/chatHelpers.ts` | Chat utility functions |
| `utils/tauri.ts` | Tauri invoke wrappers, ChatAttachment type |
| `services/ai/context.ts` | AI context building service |
| `services/ai/streaming.ts` | Streaming response handler |
| `services/ai/webSearch.ts` | DuckDuckGo web search integration |
| `lib/ai/adaptiveRouter.ts` | Adaptive AI provider routing |
| `lib/ai/providerCapabilities.ts` | Provider capability detection (vision, streaming, tool-use, etc.) |
| `lib/ai/providerHealth.ts` | Provider health monitoring |
| `lib/ai/taskDetection.ts` | Automatic task type detection |

---

## 11. Multi-Agent System

PunamIDE features a sophisticated multi-agent orchestration layer:

### Agent Services (`src/services/agent/`)

| Module | Purpose |
|---|---|
| `AgentCoordinator.ts` | Coordinates multiple agents on complex tasks |
| `AgentOrchestrator.ts` | Orchestrates agent execution order and dependencies |
| `AgentApplyGuard.ts` | Validates agent-proposed file changes before application |
| `ConflictResolver.ts` | Resolves conflicts when multiple agents touch same files |
| `contextBuilder.ts` | Builds context payloads for agent invocations |
| `differ.ts` | Agent-specific diff generation |
| `TaskScheduler.ts` | Schedules and prioritizes agent tasks |

### Agent Execution

| Module | Purpose |
|---|---|
| `services/backgroundAgentExecutor.ts` | Executes agent tasks in background |
| `store/backgroundAgentStore.ts` | Tracks background agent state |

### Agent UI Components

| Component | Purpose |
|---|---|
| `AgentKanban.tsx` | Kanban board for agent task visualization |
| `BackgroundAgentPanel.tsx` | Background agent status and control |
| `MultiAgentDashboard.tsx` | Multi-agent overview dashboard |

### Tool-Use Loop
The Cline-like tool-use loop (`utils/agentToolLoop.ts`) enables:
1. AI reasons about what action to take
2. Calls a tool (read file, search, run command, apply edit)
3. Sees the result
4. Continues reasoning until task complete
5. All thinking (in `<thinking>` tags) rendered separately in `ThinkingBlock.tsx`
6. Tool calls rendered in `ToolCallCard.tsx`
7. Tool results rendered in `ToolResultCard.tsx`

### Integration Test
- `src/__tests__/multi-agent.integration.test.ts` — Multi-agent system integration tests

---

## 12. LSP (Language Server Protocol)

### Rust Backend (`lsp_manager.rs` — 663 lines)

Full LSP client implementation:
- **JSON-RPC over stdio** communication
- **Auto-restart** on crash (max 3 attempts, 2s delay)
- **Supported language servers:**
  - TypeScript/JavaScript: `typescript-language-server --stdio`
  - Rust: `rust-analyzer`
  - Python: `pyright-langserver --stdio`
  - JSON: `vscode-json-language-server --stdio`

### LSP Commands
| Command | Purpose |
|---|---|
| `lsp_start` | Start a language server for a language ID |
| `lsp_did_open` | Notify server of opened file |
| `lsp_did_change` | Notify server of file changes |
| `lsp_did_save` | Notify server of file save |
| `lsp_completion` | Request code completions |
| `lsp_hover` | Request hover information |
| `lsp_definition` | Request go-to-definition |
| `lsp_format` | Request document formatting |
| `lsp_shutdown` | Graceful server shutdown |
| `lsp_did_close` | Notify server of closed file |

### Frontend LSP Bridge

| Module | Purpose |
|---|---|
| `services/lsp/lspClient.ts` | LSP client for frontend |
| `services/lsp/lspManager.ts` | Manages LSP server lifecycle |
| `services/lsp/monacoLspBridge.ts` | Bridges LSP diagnostics/completions to Monaco editor |

### Graceful Shutdown
On app exit, all LSP servers are shut down cleanly via `shutdown_all()`.

---

## 13. DAP (Debug Adapter Protocol)

### Rust Backend (`dap_manager.rs`)

Supports spawning debug sessions via stdio or TCP:
- `dap_start` — Start debugger via stdio
- `dap_start_tcp` — Start debugger via TCP connection
- `dap_send_request` — Send DAP request to debug adapter
- `dap_stop` — Stop debug session

### Debugger UI Components
| Component | Purpose |
|---|---|
| `DebuggerPanel.tsx` | Debugger interface (variables, call stack, watch, breakpoints) |
| `DebugConfigPicker.tsx` | Debug configuration selection |
| `BreakpointGlyphs.tsx` | Monaco editor glyph margin breakpoint rendering |

### Debugger Workflow
1. User sets breakpoints in editor (F9 or click gutter)
2. `DebugConfigPicker` selects launch configuration
3. `dap_start` / `dap_start_tcp` spawns debug adapter
4. `DebuggerPanel` displays runtime state via DAP events
5. Step controls (F10, F11, Shift+F11) send DAP requests
6. `BreakpointGlyphs` renders breakpoint dots and current line highlight

---

## 14. Git & GitHub Integration

### Git Core (Rust — `git_commands.rs`)
Uses `git2` crate (libgit2 bindings):
- `git_status` — Working tree status
- `git_diff_file` — File-level diffs
- `git_log` — Commit history
- `git_branch` — Branch listing

### GitHub Integration (Rust — `github/` module)

**Phase 0: Git Core Check**
`github_check_repo`, `github_is_git_repo`, `github_get_branch`, `github_get_dirty_files`, `github_get_remote_origin`, `github_get_ahead_behind`, `github_list_branches`

**Phase 1: Authentication**
`github_set_token`, `github_get_user`, `github_check_auth`, `github_logout`

**Phase 2: Repository Management**
`github_create_repo`, `github_list_repos`, `github_get_repo_info`, `github_link_remote`, `github_remove_remote`, `github_init_repo`, `github_get_repo_slug`

**Phase 3: Push/Pull/Sync**
`github_push`, `github_pull`, `github_fetch`, `github_stash`, `github_stash_pop`, `github_create_branch`, `github_switch_branch`, `github_delete_branch`, `github_merge_abort`

**Phase 4: Pull Requests**
`github_create_pr`, `github_list_prs`, `github_get_pr`, `github_merge_pr`, `github_close_pr`, `github_pr_list_comments`, `github_pr_add_comment`

**Phase 5: Issues & Actions & Gists**
Issues: `github_list_issues`, `github_create_issue`, `github_close_issue`, `github_issue_list_comments`, `github_issue_add_comment`
Actions: `github_list_workflow_runs`, `github_get_workflow_run`, `github_rerun_workflow`
Gists: `github_create_gist`, `github_create_multi_gist`

**Phase 6: Safety Layer**
`github_pre_push_check`, `github_pre_pull_check`, `github_dry_run_push`, `github_create_safety_snapshot`, `github_rollback_to_snapshot`, `github_list_safety_snapshots`, `github_delete_safety_snapshot`

### GitHub Frontend
| Component | Purpose |
|---|---|
| `github/GitHubPanel.tsx` | Main GitHub panel |
| `github/IssuesPanel.tsx` | Issue management UI |
| `github/PullRequestPanel.tsx` | PR management UI |
| `github/RepoManager.tsx` | Repository management UI |
| `github/SyncPanel.tsx` | Sync/push/pull UI |
| `GitPanel.tsx` | Local Git operations panel |
| `GitDiffView.tsx` | Git diff viewer |
| `services/githubService.ts` | GitHub API service layer |
| `stores/githubStore.ts` | GitHub state management |

---

## 15. Technical Debt Analysis Engine

A comprehensive code quality analysis system that runs locally.

### Architecture

```
User clicks "Analyze Debt"
  → TechnicalDebtDashboard.tsx
    → Web Worker: debt-analyzer.worker.ts
      → DebtAnalyzer.ts (orchestrator)
        → ASTEngine.ts (Tree-sitter WASM or regex fallback)
        → ASTMetricsExtractor.ts (complexity, nesting, god functions)
        → DebtScorer.ts (scoring with AST metrics)
        → DependencyGraphEngine.ts (import/export graph, circular deps)
        → DeadCodeAnalyzer.ts (unused exports/imports/declarations)
      → RefactorPlanner.ts (4-category refactor plan)
```

### AST Engine (`services/technicalDebt/ASTEngine.ts`)
- Tree-sitter WASM for TypeScript/JavaScript/TSX parsing
- Graceful fallback to regex-based analysis if WASM fails to load
- WASM files: `tree-sitter.wasm`, `tree-sitter-typescript.wasm`, `tree-sitter-tsx.wasm`, `tree-sitter-javascript.wasm`
- Singleton pattern for efficient WASM reuse

### Metrics Extracted (`ASTMetricsExtractor.ts`)
- **Cyclomatic complexity** (bands: 1-10 Good, 11-20 Moderate, 21-30 High, 30+ Critical)
- **Nesting depth** (bands: 1-3 Good, 4-5 Warning, 6+ Refactor Candidate)
- **God function detection** (>150 lines)
- **God class detection** (>20 methods)
- **Excessive parameters** (>5 parameters)
- Per-function nesting measurement (not leaf-node average)

### Scoring (`DebtScorer.ts`)
- SHA-256 content hashing (replaces old djb2)
- Small-file guards: <50 LOC never Critical, <100 LOC reduced weighting
- Utility/config/constants file detection with lower penalties
- AST metrics baked into score

### Dependency Graph (`DependencyGraphEngine.ts`)
- Parses import/export statements from AST
- Builds adjacency graph (who imports whom)
- Circular dependency detection (DFS with back-edge detection)
- Hub file detection (statistical threshold: mean + 2×stddev or >10 dependents)
- Per-file coupling scores (0-100)
- Module-level coupling aggregation

### Dead Code Analysis (`DeadCodeAnalyzer.ts`)
- Unused exports detection (exported but never imported)
- Unused imports detection (imported but never referenced in file body)
- Unused declarations detection (not exported, not referenced locally)
- Conservative — skips entry points, test files, barrel files, framework exports

### Refactor Planner (`RefactorPlanner.ts`)
4 categories:
1. **Quick Wins** (<1 hour effort)
2. **Major Refactors** (1-4 hours)
3. **Maintenance** (4-8 hours)
4. **Architectural Issues** (Multi-day)

Each item includes: effort, impact, risk scores, "Why flagged", "Expected payoff"

### Dashboard (`TechnicalDebtDashboard.tsx`)
- Overall debt score with category badge and trend
- Discovery metrics (discovered/analyzed/skipped/failed/cached)
- Module breakdown with per-module scores
- Trend history
- Refactor queue with 4 categories and expandable cards
- AST detail panel (complexity band, nesting, god counts)
- Dependency Graph section (stats grid, circular deps list, hub files list)
- Dead Code "Safe Cleanup Candidates" section
- Interactive dependency graph visualization (`DependencyGraphView.tsx` — canvas-based, force-directed)

### Caching
Persistent cache via `@tauri-apps/plugin-store` (`punamide-debt-cache.json`), absolute project-relative paths.

---

## 16. Project Memory System

A long-term memory system for AI context across sessions.

### Rust Backend — Memory Engine (`memory/memory_engine.rs`)
CRUD operations stored in SQLite:
- `memory_init` — Initialize memory store
- `memory_create` — Create a memory entry
- `memory_get_by_id` — Retrieve by ID
- `memory_list` — List all memories
- `memory_search` — Full-text search
- `memory_update` — Update a memory
- `memory_delete` — Delete a memory
- `memory_get_by_file` — Find memories related to a file
- `memory_get_timeline` — Chronological memory timeline
- `memory_quick_add` — Quick memory creation

### Embedding Store (`memory/embedding_store.rs`)
- `embedding_store` — Store vector embedding
- `embedding_get` — Retrieve embedding
- `embedding_search` — Similarity search
- `embedding_delete` — Delete embedding
- `embedding_count` — Count stored embeddings

### Retrieval Engine (`memory/retrieval_engine.rs`)
- `retrieve_memories` — Keyword-based retrieval
- `retrieve_memories_semantic` — Semantic/embedding-based retrieval
- `inject_memories_into_prompt` — Auto-inject relevant memories into AI system prompt

### Frontend Memory Services
| Module | Purpose |
|---|---|
| `services/memory/BugKnowledgeBase.ts` | Bug pattern knowledge base |
| `services/memory/DecisionStore.ts` | Architecture decision records |
| `services/memory/MemoryIndexer.ts` | Memory indexing |
| `services/memory/MemoryManager.ts` | Memory lifecycle management |
| `services/memory/RefactorHistory.ts` | Refactoring history tracking |

### Memory UI
- `MemoryExplorer.tsx` — Browse and search project memories

---

## 17. Project Indexing & Search

### Index Types
1. **Project File Index** (`ProjectIndexCache`) — Full file listing with metadata (path, extension, size, modified time, preview, binary detection)
2. **TF-IDF Codebase Index** (`CodebaseIndex`) — Tokenized code chunks with inverted index for semantic search
3. **Fuzzy Block Matching** — Find similar code blocks with edit-distance scoring

### Index Commands
| Command | Purpose |
|---|---|
| `get_project_index` | Get cached file index |
| `refresh_project_index` | Rebuild file index |
| `update_file_index` | Update single file entry |
| `index_codebase` | Build TF-IDF index (chunk size: 30 lines, overlap: 5 lines) |
| `search_codebase` | Semantic code search with relevance scoring |
| `fuzzy_find_block` | Find similar code blocks |
| `build_ai_context` | Build AI context from index + git + tabs |
| `get_relevant_context` | Get context with token estimation |

### Skip Lists
Directories skipped during indexing: `.git`, `node_modules`, `__pycache__`, `venv`, `dist`, `build`, `out`, `target`, `.idea`, `.vscode`, `.next`, `.nuxt`, `coverage`, `.gradle`, `vendor`, and 40+ more.
Files skipped: `package-lock.json`, `yarn.lock`, `pnpm-lock.yaml`, `Cargo.lock`, `poetry.lock`, `go.sum`.

### Search Frontend
| Component | Purpose |
|---|---|
| `SearchPanel.tsx` | Project-wide search UI |
| `ProjectSearch.tsx` | File search with results display |
| `FuzzyFilePicker.tsx` | Fuzzy file finder (Ctrl+P) |
| `store/searchStore.ts` | Search state management |

---

## 18. Snapshot System

Full project state checkpointing and restoration.

### Snapshot Commands
| Command | Purpose |
|---|---|
| `create_snapshot` | Create a new project snapshot |
| `list_snapshots` | List all available snapshots |
| `get_restore_preview` | Preview files that would change on restore |
| `restore_snapshot` | Restore project to a snapshot |
| `export_snapshot_zip` | Export snapshot as ZIP archive |
| `delete_snapshot` | Delete a snapshot |
| `auto_snapshot_if_enabled` | Automatic snapshot on schedule |

### Snapshot UI
- `SnapshotManager.tsx` — Create, browse, restore, export snapshots

---

## 19. Security Layer

### Command Safety (`safety.rs`)
- `SafetyValidator` inspects shell commands before execution
- Detects dangerous patterns (rm -rf, format commands, system modifications)
- `validate_path_jail` — Ensures all file operations stay within project root
- `validate_path_within_project` — Canonical path resolution with ancestor validation

### Security Scanner (`security_scanner.rs`)
- `security_scan_file` — Scan a file for security vulnerabilities
- `security_scan_patch` — Scan a proposed patch for security issues before application

### Frontend Security Services
| Module | Purpose |
|---|---|
| `services/security/SecurityPatterns.ts` | Security vulnerability patterns |
| `services/security/ThreatAnalyzer.ts` | Threat analysis engine |
| `services/security/VulnerabilityDatabase.ts` | Known vulnerability database |

### Security UI
- `SecurityPanel.tsx` — Security scan results and management

---

## 20. Architecture Guardrails Engine

Ensures code changes comply with project architecture rules.

### Rust Commands
| Command | Purpose |
|---|---|
| `analyze_dependencies` | Analyze project dependencies |
| `analyze_file_dependencies` | Analyze single file dependencies |
| `build_dependency_graph` | Build full dependency graph |
| `validate_architecture` | Validate codebase against rules |
| `validate_patch_against_rules` | Validate proposed changes against architecture rules |
| `get_default_rules` | Get default architecture rules |

### Architecture Services (Frontend)
| Module | Purpose |
|---|---|
| `services/architecture/ArchitectureEngine.ts` | Core architecture analysis engine |
| `services/architecture/ArchitectureMap.ts` | Architecture map/visualization |
| `services/architecture/ArchitectureScanner.ts` | Project architecture scanner |
| `services/architecture/ChangePredictor.ts` | Change impact prediction |
| `services/architecture/DependencyExplorer.ts` | Dependency exploration |
| `services/architecture/DependencyGraph.ts` | Dependency graph data structure |
| `services/architecture/ImpactAnalyzer.ts` | Change impact analysis |
| `services/architecture/RuleValidator.ts` | Architecture rule validation |
| `services/architecture/ViolationReporter.ts` | Violation reporting |

### Architecture UI
- `ImpactAnalysisPanel.tsx` — Visual impact analysis of proposed changes
- `DependencyGraphView.tsx` — Interactive dependency graph

---

## 21. Docker & Package Manager Integration

### Docker Controller (`docker_controller.rs`)
| Command | Purpose |
|---|---|
| `docker_list_containers` | List all Docker containers |
| `docker_start` | Start a container |
| `docker_stop` | Stop a container |
| `docker_logs` | Get container logs |
| `docker_exec` | Execute command in container |
| `docker_remove_container` | Remove a container |
| `docker_available` | Check if Docker is available |

### Package Manager (`package_manager.rs`)
Universal package management across ecosystems:
| Command | Purpose |
|---|---|
| `package_install` | Install packages (auto-detects npm/pip/cargo/etc.) |
| `package_remove` | Remove packages |
| `package_update` | Update packages |
| `package_audit` | Security audit packages |

### Environment Scanner (`environment_scanner.rs`)
| Command | Purpose |
|---|---|
| `scan_tools` | Scan for all installed development tools |
| `tool_installed` | Check if specific tool is installed |
| `tool_version` | Get installed tool version |

### UI
- `DockerPanel.tsx` — Docker container management UI
- `EnvironmentDashboard.tsx` — Development environment overview

---

## 22. CI/CD Monitoring

### CI Services (`services/ci/`)
| Module | Purpose |
|---|---|
| `CiMonitor.ts` | CI workflow monitoring |
| `LogAnalyzer.ts` | CI log analysis for failures |
| `PatchGenerator.ts` | Automated patch generation from CI failures |
| `VerificationRunner.ts` | Run verification commands |

### CI UI
- `CiDashboard.tsx` — CI monitoring dashboard

---

## 23. Embeddings & RAG Workbench

### Embedding Services (`services/embeddings/`)
| Module | Purpose |
|---|---|
| `ChunkInspector.ts` | Inspect code chunks and their embeddings |
| `EmbeddingAnalyzer.ts` | Analyze embedding quality and coverage |
| `HallucinationDetector.ts` | Detect potential RAG hallucinations |
| `RagWorkbench.ts` | RAG debugging and experimentation workbench |
| `RetrieverDebugger.ts` | Debug retrieval quality |
| `vectorStore.ts` | Vector store for embeddings |

### Embedding Worker
- `workers/embedding-analyzer.worker.ts` — Off-thread embedding analysis

### GPU Acceleration Research (`research/gpu-embeddings-research.md`)
Exploring:
- ONNX Runtime Web (WebGPU backend) — 10-50× speedup
- Transformers.js (Hugging Face) — Drop-in pipeline API
- Model: all-MiniLM-L6-v2 (384 dimensions, ~23MB)
- Target: 10,000+ chunk codebases (100M+ cosine similarity ops)

### RAG UI
- `RagWorkbenchPanel.tsx` — RAG debugging interface

---

## 24. Web Search & Context Gathering

### Web Search (`services/ai/webSearch.ts`)
DuckDuckGo API integration for web search context.

### Context Gathering
- `utils/contextGathering.ts` — Context gathering from multiple sources
- `utils/contextEngine.ts` — Unified context engine (TF-IDF + git + tabs)
- `mentionResolver.ts` — Resolves @-mentions to actual content:
  - `@file` — Include file content
  - `@folder` — Include folder structure
  - `@codebase` — Full codebase context
  - `@web` — Web search results
  - `@git` — Git status/diff
  - `@terminal` — Terminal output
  - `@selection` — Editor selection
  - `@problems` — Diagnostic problems

---

## 25. In-Built Terminal & Shell Environment

### Terminal Types
1. **Simple Command Terminal** — Run single commands (`terminal_commands.rs`)
2. **PTY Terminal** — Interactive shell with full terminal emulation (`pty_manager.rs`)
3. **Process Management** — Start/stop long-running processes

### PTY Commands
| Command | Purpose |
|---|---|
| `terminal_create` | Create a new PTY session |
| `terminal_write` | Write input to PTY |
| `terminal_resize` | Resize PTY on window resize |
| `terminal_kill` | Kill a PTY session |
| `start_terminal_process` | Start a managed process |
| `stop_terminal_process` | Stop a managed process |

### Terminal Error Parsing (`services/terminal/errorParser.ts`)
Parses terminal output for error patterns — enables "Quick Fix" suggestions.

### Terminal UI
- `TerminalPanel.tsx` — Multi-tab terminal container
- `ShellTerminal.tsx` — Interactive shell terminal
- `Terminal.tsx` — xterm.js terminal instance

---

## 26. File Watcher & Live Reload

### File Watcher (`lib.rs` — `watch_project` command)
- Uses `notify` crate with `notify-debouncer-mini` (500ms debounce)
- Recursive directory watching
- Skips `node_modules`, `.git`, `target`, `dist`
- Emits `fs-changed` event with affected paths and change kind

### Frontend Handler
- `useAutoSave.ts` — Auto-save hook
- `fileStore.ts` — Auto-refreshes file tree on `fs-changed` events

---

## 27. Persistence Layer — SQLite + Plugin Store

### SQLite Database (`lib.rs` + `rusqlite`)
- Path: `{data_local_dir}/punamide/punamide.db`
- Table: `chat_sessions`
  - Columns: `id`, `title`, `provider`, `model`, `messages` (JSON), `token_count`, `cost`, `created_at`, `updated_at`
- Commands: `db_init`, `db_save_chat_session`, `db_load_chat_sessions`, `db_delete_chat_session`

### Plugin Store (`tauri-plugin-store`)
- Used for settings persistence (`punamide-settings.json`)
- Used for debt analysis cache (`punamide-debt-cache.json`)
- Frontend: `loadConfigFromStore()`, `saveConfigToStore()` in `utils/tauri.ts`

### Chat Persistence Service
- `services/persistence/chatDb.ts` — Frontend chat database operations

---

## 28. Workers & Off-Thread Processing

### Web Workers

| Worker | Purpose |
|---|---|
| `workers/ai-worker.ts` | AI processing off main thread |
| `workers/debt-analyzer.worker.ts` | Technical debt analysis (Tree-sitter WASM, scoring, dependency graph) |
| `workers/embedding-analyzer.worker.ts` | Embedding similarity calculations |

### Worker Configuration
- Vite config: `worker.format: 'es'`
- Debt analyzer worker uses ES module syntax with `?url` imports
- Workers load Tree-sitter WASM independently

---

## 29. UI Component Map (Full List)

### Core Layout (11 components)
`App.tsx`, `ActivityBar.tsx`, `TitleBar.tsx`, `StatusBar.tsx`, `RightPanel.tsx`, `ErrorBoundary.tsx`, `ConfirmDialog.tsx`, `CommandPalette.tsx`, `FileIcon.tsx`, `SplitEditor.tsx`, `Logger.ts`

### Editor & Files (8 components)
`CodeEditor.tsx`, `EditorTabs.tsx`, `FileExplorer.tsx`, `FindReplace.tsx`, `FuzzyFilePicker.tsx`, `FileTemplatePicker.tsx`, `InlineEdit.tsx`, `InlineEditWidget.tsx`

### AI Chat (11 components)
`AiChat.tsx`, `AiDiffPreview.tsx`, `ComposerPanel.tsx`, `chat/ChatComponents.tsx`, `chat/ChatHeader.tsx`, `chat/ChatInputArea.tsx`, `chat/CodeBlock.tsx`, `chat/DiffView.tsx`, `chat/MessageBubble.tsx`, `chat/ResponseBlock.tsx`, `chat/ThinkingBlock.tsx`

### Agent System (7 components)
`AgentKanban.tsx`, `BackgroundAgentPanel.tsx`, `MultiAgentDashboard.tsx`, `chat/ToolCallCard.tsx`, `chat/ToolResultCard.tsx`, `MultiFileDiffBoard.tsx`, `SnapshotManager.tsx`

### Debugger (3 components)
`DebuggerPanel.tsx`, `DebugConfigPicker.tsx`, `BreakpointGlyphs.tsx`

### Git & GitHub (7 components)
`GitPanel.tsx`, `GitDiffView.tsx`, `github/GitHubPanel.tsx`, `github/IssuesPanel.tsx`, `github/PullRequestPanel.tsx`, `github/RepoManager.tsx`, `github/SyncPanel.tsx`

### Analysis & Quality (6 components)
`TechnicalDebtDashboard.tsx`, `DependencyGraphView.tsx`, `ImpactAnalysisPanel.tsx`, `CodeReview.tsx`, `BugHunt.tsx`, `ProblemsPanel.tsx`

### DevOps & Environment (5 components)
`DockerPanel.tsx`, `EnvironmentDashboard.tsx`, `CiDashboard.tsx`, `RunProfiles.tsx`, `TerminalPanel.tsx`

### Memory & RAG (2 components)
`MemoryExplorer.tsx`, `RagWorkbenchPanel.tsx`

### Settings & Config (3 components)
`Settings.tsx`, `SettingsPanel.tsx`, `McpSettings.tsx`

### Other Panels (8 components)
`NotesPanel.tsx`, `NotepadsPanel.tsx`, `SearchPanel.tsx`, `ProjectSearch.tsx`, `LivePreview.tsx`, `WebPreviewPanel.tsx`, `TestGenerator.tsx`, `SecurityPanel.tsx`

### Shell (2 components)
`ShellTerminal.tsx`, `Terminal.tsx`

### Usage & Tracking (1 component)
`UsageDashboard.tsx`

---

## 30. Feature Roadmap (Planned & Research)

### Plans (`plans/`)

| Plan File | Status | Description |
|---|---|---|
| `github-integration-plan.md` | ✅ Implemented (6 phases) | Full GitHub integration: auth, repos, PRs, issues, actions, gists, sync, safety |
| `multi-file-diff-board.md` | ✅ Implemented | PR-style multi-file diff review with per-hunk accept/reject |
| `phase2-debugger-plan.md` | ✅ Implemented | DAP debugger with breakpoints, stepping, variable inspection |
| `phase3-threads-panel.md` | 📋 Planned | Thread/conversation panel for AI chats |
| `terminal-error-quick-action.md` | 📋 Planned | Quick-action suggestions from terminal error output |

### Research (`research/`)

| Research File | Status | Description |
|---|---|---|
| `gpu-embeddings-research.md` | 🔬 Research | GPU-accelerated embeddings via ONNX/WebGPU for large codebases |

### Punam-Specific Plans

| File | Description |
|---|---|
| `punam/cline-like-chat-plan.md` | Cline-style chat interface plan (thinking blocks, tool cards, streaming) |

---

## 31. CSP & Security Posture

### Content Security Policy (`tauri.conf.json`)
```
default-src 'self';
script-src 'self' 'unsafe-eval' blob:;
style-src 'self' 'unsafe-inline';
font-src 'self' data:;
img-src 'self' data: blob: https:;
connect-src 'self'
  https://generativelanguage.googleapis.com
  https://api.groq.com
  https://api.openai.com
  https://openrouter.ai
  https://api.openrouter.ai
  https://api.duckduckgo.com
  http://localhost:* https://localhost:*;
worker-src 'self' blob:
```

### Security Measures
1. **Path Sandboxing:** All file operations validated via `validate_path_within_project` — canonical path resolution prevents directory traversal
2. **Command Inspection:** `inspect_command` validates shell commands before execution — blocks dangerous patterns
3. **3-Way Merge:** `try_3way_merge` prevents silent overwrite of user edits by AI — generates conflict markers
4. **Pre-Push Safety:** GitHub safety layer checks before push/pull operations — dry-run, safety snapshots
5. **Security Scanner:** `security_scan_file` and `security_scan_patch` detect vulnerabilities
6. **Agent Apply Guard:** `AgentApplyGuard.ts` validates agent-proposed changes before applying
7. **API Key Security:** Keys stored in `tauri-plugin-store` (local filesystem), never in React state, only sent via Rust backend

---

## 32. Keyboard Shortcuts

| Shortcut | Action |
|---|---|
| `Ctrl+S` | Save current file |
| `Ctrl+Shift+P` | Command palette |
| `Ctrl+P` | Fuzzy file picker |
| `Ctrl+B` | Toggle sidebar |
| `Ctrl+J` | Toggle terminal |
| `Ctrl+Shift+I` | Toggle AI panel |
| `F5` | Start debugging |
| `Shift+F5` | Stop debugging |
| `F9` | Toggle breakpoint |
| `F10` | Step over |
| `F11` | Step into |
| `Shift+F11` | Step out |

---

## 33. Supported AI Providers & Models

### Providers

| Provider | API Key Source | Free Tier | Features |
|---|---|---|---|
| **Google Gemini** | [aistudio.google.com/apikey](https://aistudio.google.com/apikey) | ✅ Yes | Streaming, Vision (image input), 65K max tokens |
| **Groq** | [console.groq.com/keys](https://console.groq.com/keys) | ✅ Yes | Streaming, Ultra-fast inference |
| **OpenAI** | [platform.openai.com/api-keys](https://platform.openai.com/api-keys) | $5 credit | Streaming, Vision |
| **OpenRouter** | [openrouter.ai](https://openrouter.ai) | ✅ Free models | Streaming, Multi-model access |
| **Mistral AI** | [console.mistral.ai/api-keys](https://console.mistral.ai/api-keys) | Free/Paid tiers | Streaming |
| **Ollama** | Local (no key needed) | ✅ Fully free | Streaming, Local models, No internet required |

### Default Models
- **Gemini:** `gemini-2.0-flash` (free, fast, 65K output tokens)
- **OpenAI-compatible:** Configurable model ID via settings

### AI Features
- **Streaming responses** — Real-time token display via SSE
- **Vision support** — Image input (base64) for Gemini and OpenAI-compatible providers
- **Multi-turn chat** — Full conversation history with system prompt
- **Structured output** — AI responses parsed into file changes via `ParsedResponse`
- **Tool-use loop** — Agentic AI can read files, search, run commands, apply patches in a loop
- **Cline-like UX** — Thinking blocks separated from content, tool call/result cards
- **Usage tracking** — Token counting, cost estimation, per-provider breakdown

---

## 34. Build Outputs & Distribution

### Build Command
```bash
npm run tauri build
```

### Output Formats by OS

| OS | Formats |
|---|---|
| **Windows** | `.msi` installer, `.exe` standalone |
| **Linux** | `.deb` package, `.AppImage`, `.rpm` |
| **macOS** | `.dmg` disk image, `.app` bundle |

### Build Pipeline
1. `tsc -b` — TypeScript compilation and type checking
2. `vite build` — Frontend bundling with Rollup
3. Tauri build — Rust compilation + binary packaging + bundling

### Frontend Build
- Output: `dist/` directory
- WASM files routed to `assets/wasm/`
- Base path: `./` (relative for Tauri file:// protocol)
- Tree-shaking and minification via Vite/Rollup

### Rust Build
- Output: `src-tauri/target/release/punamide`
- Static linking where possible
- Bundled SQLite (via `rusqlite/bundled` feature)
- Bundled libgit2 (via `git2` crate)

---

## Appendix: Quick Reference Card

| Category | Technology | Version |
|---|---|---|
| Desktop Shell | Tauri | 2.11.2 |
| Backend Language | Rust | 1.77.2+ |
| Frontend Framework | React | 19.2.6 |
| Type System | TypeScript | 6.0.2 |
| Build Tool | Vite | 8.0.12 |
| CSS Framework | Tailwind CSS | 4.3.0 |
| State Management | Zustand | 5.0.5 |
| Code Editor | Monaco Editor | 0.55.1 |
| Terminal | xterm.js | 6.0.0 |
| Icons | Lucide React | 1.16.0 |
| Git Library | git2 (libgit2) | 0.19 |
| Database | SQLite (rusqlite) | 0.31 |
| HTTP Client | reqwest | 0.12 |
| Async Runtime | tokio | 1 |
| Pseudo-Terminal | portable-pty | 0.8 |
| File Watching | notify | 7 |
| AST Parser | Tree-sitter (WASM) | 0.26.9 |
| Code Highlighting | highlight.js | 11.11.1 |
| Split Panes | react-split | 2.0.14 |

---

*End of Report — PunamIDE v2.0 Full Tech Stack & Architecture*