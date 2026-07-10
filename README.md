# PunamIDE v2.0

A full-featured, AI-powered desktop code editor built with **Tauri 2**, **React 19**, and **Monaco Editor**. PunamIDE combines a professional IDE experience with deep multi-provider AI integration, agentic tool-calling, and intelligent code analysis — all running natively on your machine.

---

## Quick Start

```bash
# Install dependencies
npm install

# Start the full desktop app (Tauri + Vite)
autorun.bat          # Windows — double-click or run from terminal

# Or manually
cargo tauri dev

# Frontend only (browser, no Rust backend)
npm run dev
```

---

## Tech Stack

| Layer | Technology |
|---|---|
| Desktop shell | Tauri 2.11 |
| Frontend | React 19, TypeScript 6, Vite 8 |
| Editor | Monaco Editor 0.55 |
| Styling | Tailwind CSS v4, custom CSS modules |
| State | Zustand 5 |
| Backend | Rust (Tokio, reqwest, git2, rusqlite) |
| Terminal | xterm.js 6 with portable-pty |
| AI | Multi-provider (Gemini, Anthropic, OpenAI, Groq, OpenRouter, Ollama, Mistral) |
| Embeddings | @xenova/transformers (local, in-browser) |
| AST/Parsing | web-tree-sitter (JS, TS, Python, Rust) |
| Graph UI | @xyflow/react |
| Testing | Vitest + fast-check (property-based) |

---

## AI Providers

PunamIDE supports the following AI providers with per-provider API key management:

- **Google Gemini** — Gemini 2.5 Pro, 2.5 Flash, 2.5 Flash-Lite, 2.0 Flash, 2.0 Flash-Lite
- **Anthropic Claude** — Native streaming with tool-use support
- **OpenAI** — GPT-4o, GPT-4 Turbo, and compatible models
- **Groq** — Ultra-fast inference (Llama, Mixtral, Gemma)
- **OpenRouter** — Unified access to 100+ models including DeepSeek v3/R1/v4
- **Ollama** — Fully local, offline AI (configurable base URL)
- **Mistral** — Mistral Large, Codestral

**Cost tracking:** Real-time USD and INR cost estimation per request with per-model pricing table.

---

## Features

### AI Chat & Agent System

- **Multi-turn AI chat** with full project context awareness
- **Agentic tool-calling** — AI autonomously reads files, searches code, applies patches, runs commands
- **Multi-provider tool loops** — native tool-use for Anthropic/Gemini, JSON-fallback for others
- **Agent Orchestrator** — spawns multiple specialized agents simultaneously:
  - `implementation` — writes to `src/`, `src-tauri/src/`
  - `test` — writes only to `*.test.ts` / `*.spec.ts`
  - `architecture` — read-only observer, can veto patches
  - `security` — read-only scanner, can block critical patches
  - `refactor` — same write scope as implementation + architecture re-validation
- **Autopilot / Supervised modes** — autopilot auto-approves safe operations; supervised requires per-action approval
- **Agent approval gate** — fine-grained accept/reject per tool call
- **Budget enforcement** — per-task token/cost budget with warning dialogs
- **Loop guard** — prevents infinite agent loops
- **Ambiguity detection + clarification protocol** — AI asks clarifying questions before ambiguous tasks
- **Context window optimization** — unified context assembler, compressor, and injector
- **Task planner panel** — AI generates step-by-step plan before executing
- **Reasoning panel** — shows AI chain-of-thought in compact or expanded mode
- **Session memory** — persists decisions and context across turns
- **Chat export** — export conversation history

### Agent Tools (callable by AI)

| Tool | Description |
|---|---|
| `read_file` | Read entire file |
| `read_lines` | Read specific line range |
| `search_in_project` | Full-text search across project |
| `write_file` | Create or overwrite a file |
| `apply_patch` | Apply unified diff patch |
| `run_command` | Execute shell commands |
| `list_directory` | List folder contents |
| `search_symbol` | LSP-powered symbol lookup |
| `get_diagnostics` | Fetch current editor errors/warnings |

### Code Editor

- **Monaco Editor** — full VS Code editing experience
- **Split editor** — side-by-side file comparison
- **Inline AI edit** (`Ctrl+K`) — edit selected code with AI instruction
- **Inline diff preview** — shows proposed changes before applying
- **Edit preview panel** — review AI edits with accept/reject
- **Breakpoint glyphs** — visual breakpoint markers in gutter
- **Find & Replace** — in-file search with regex support
- **File templates** — new file creation with language-specific boilerplate
- **Auto-save** with configurable delay
- **Multi-tab editor** with tab management

### Autocomplete

- **Inline ghost-text completion** powered by AI
- **FIM (Fill-in-Middle)** mode for supported models
- **Chat fallback** mode for models without FIM
- **Auto-detect** mode — picks best strategy per provider
- **Completion cache** — avoids redundant requests
- **Suppression logic** — no completions in comments/strings when not needed
- **Configurable debounce** (150ms+) and max tokens (16–512)

### File Explorer & Navigation

- **File tree** with VS Code–style icons (63 file type icons)
- **Fuzzy file picker** (`Ctrl+P`)
- **Project-wide search** (`Ctrl+Shift+F`) with ripgrep-style results
- **Breadcrumbs** navigation bar
- **File icon system** with folder-type specific icons

### Terminal

- **Integrated PTY terminal** via `portable-pty` (real shell, not fake)
- **xterm.js** rendering with fit addon and web links
- **Multiple terminal sessions**
- **Shell Terminal** panel with ANSI color support
- **Terminal error parser** — auto-detects errors and surfaces quick actions
- **Proactive error detection** — watches terminal output for actionable errors

### Git & GitHub

**Local Git** (via `git2` Rust library):
- Stage, unstage, commit files
- View diffs with syntax highlighting
- Branch management
- Git diff viewer with side-by-side comparison
- Multi-file diff board

**GitHub Integration** (via Rust HTTP backend):
- OAuth authentication
- Repository management (create, clone, push, pull)
- Issues — create, list, comment, close
- Pull Requests — create, review, merge
- Actions / CI — monitor workflow runs, view logs
- Gists — create and manage
- Sync panel — push/pull with conflict detection
- Merge conflict panel with resolution UI

### Debugger

- **DAP (Debug Adapter Protocol)** manager via Rust backend
- **Debug configuration picker**
- **Breakpoint management**
- **Variables, call stack, watch** panels
- **Run profiles** — configurable launch configurations
- **Verified Run** — run with pre-flight checks
- **DAPBridge** — frontend ↔ Rust DAP bridge

### Technical Debt Analyzer

- **AST-based analysis** using Tree-sitter (JS, TS, Python, Rust)
- **Debt scoring** — quantified technical debt per file and project
- **Dependency graph engine** — builds import/dependency graph
- **Dead code analyzer** — finds unreachable code
- **Circular dependency detector**
- **Coupling analyzer** — measures module coupling
- **Refactor planner** — AI-assisted refactor suggestions
- **Incremental graph engine** — updates graph on file changes
- **Graph exporter** — export dependency graph as JSON/SVG
- **Diff engine** — tracks debt changes over time
- **Web Worker** — analysis runs off main thread

### Architecture Analysis

- **Dependency analyzer** — deep import graph analysis
- **Graph builder** — visual dependency graph
- **Rule engine** — define and enforce architectural rules
- **Architecture Engine** — validates patches against defined rules
- **Impact analyzer** — predicts change impact across codebase
- **Violation reporter** — surfaces rule violations with file/line context
- **Dependency Graph View** — interactive visual graph (`@xyflow/react`)

### Security Scanner

- **Rust-native security scanner** (`security_scanner.rs`)
- **Vulnerability database** — known pattern matching
- **Threat analyzer** — contextual threat assessment
- **Security patterns** — configurable rule set
- **Security panel** — surfaces findings with severity levels
- **Integration tests** for scanner accuracy

### Embeddings & RAG

- **Local embeddings** via `@xenova/transformers` (runs in browser, no API needed)
- **Vector store** — in-memory semantic search
- **Embedding pipeline** (Rust) — batch processing
- **Embedding generator worker** — off-thread embedding generation
- **RAG Workbench** — test retrieval quality
- **Chunk inspector** — inspect embedding chunks
- **Hallucination detector** — cross-checks AI responses against codebase
- **Retriever debugger** — debug semantic search results
- **Memory engine** (Rust) — persistent embedding store with retrieval

### Context Intelligence

- **Context assembler** — multi-source context builder (open files, symbols, git diff, errors)
- **Context compressor** — smart truncation preserving most relevant content
- **Context injector** — injects context into AI prompts with configurable strategy
- **Context sidebar** — visual breakdown of what's in the AI context window
- **Context window bar** — live token usage indicator in chat
- **Symbol index** (Rust) — fast symbol lookup via Tree-sitter
- **Call graph** (Rust) — function call relationship tracking
- **Codebase index** — lightweight in-memory project index

### Code Review

- **AI-powered code review** panel
- **Diff viewer** — rich diff with syntax highlighting
- **Inline diff preview** — shows changes in editor gutter

### Refactor

- **Refactor service** — AI-assisted refactoring with changeset management
- **Refactor panel** — UI for reviewing and applying refactor operations
- **AST edit validator** — validates proposed AST-level edits

### Test Generation

- **TestGenerator service** — AI generates unit tests for selected code
- **TestGenPanel** — UI for test generation workflow
- **Test generator component** — embedded in right panel

### CI/CD Integration

- **CI Monitor** — watches GitHub Actions workflow runs
- **Log analyzer** — parses CI logs for errors
- **Patch generator** — auto-generates fixes for CI failures
- **Verification runner** — runs local test/build verification
- **CI Dashboard** — visual CI status panel

### Docker

- **Docker controller** (Rust) — manages container lifecycle
- **Docker panel** — list, start, stop, inspect containers

### Environment & Tooling

- **Environment scanner** (Rust) — detects installed runtimes, tools, versions
- **Environment dashboard** — visual environment summary
- **Package manager** (Rust) — cross-platform package operations
- **Dependency resolver** — resolves and installs project dependencies
- **Installation engine** — automated tool installation
- **Workspace importer** — import external workspaces

### MCP (Model Context Protocol)

- **MCP Manager** — connect to MCP servers
- **MCP Settings panel** — configure MCP server connections
- **Curated MCP servers list** — pre-configured popular MCP servers
- **Tool executor** — route MCP tool calls through agent loop

### Notes & Productivity

- **Notepads** — persistent markdown notepads per project
- **Notes panel** — quick inline notes
- **Command palette** (`Ctrl+Shift+P`) — searchable command launcher

### Snapshots

- **Snapshot manager** — create named project snapshots
- **Rust snapshot backend** — efficient zip-based snapshot storage

### Observability & Performance

- **Sentry integration** (`@sentry/react`) — error tracking and performance monitoring
- **Usage dashboard** — token usage, cost breakdown, request history
- **Task cost summary** — per-task cost breakdown
- **Token estimator** — real-time token count estimation
- **Metrics per request** — duration, tokens, cost in USD + INR

---

## Project Structure

```
PunamIde v2.0/
├── src/                          # React frontend
│   ├── components/               # 70+ UI components
│   │   ├── chat/                 # Chat UI (message bubbles, tool cards, etc.)
│   │   ├── github/               # GitHub panels
│   │   └── settings/             # Settings UI
│   ├── services/                 # Business logic
│   │   ├── agent/                # Agent orchestration, budget, loop guard
│   │   ├── ai/                   # AI streaming, context
│   │   ├── architecture/         # Architecture analysis engine
│   │   ├── autocomplete/         # Ghost-text completion engine
│   │   ├── ci/                   # CI/CD integration
│   │   ├── embeddings/           # RAG + vector store
│   │   ├── intelligence/         # Context assembly, compression
│   │   ├── lsp/                  # LSP client, Monaco bridge
│   │   ├── mcp/                  # MCP server management
│   │   ├── memory/               # Session memory, decision store
│   │   ├── persistence/          # SQLite chat history
│   │   ├── refactor/             # Refactor service
│   │   ├── security/             # Security scanning
│   │   ├── technicalDebt/        # Debt analysis, AST engine
│   │   ├── testgen/              # Test generation
│   │   └── tooling/              # Environment, package management
│   ├── store/                    # Zustand state stores
│   ├── utils/                    # Utilities, agent tools, tool loops
│   │   └── toolLoops/            # Per-provider tool-calling loops
│   ├── workers/                  # Web Workers (AI, debt analyzer, embeddings)
│   └── providers/anthropic/      # Anthropic streaming provider
│
├── src-tauri/                    # Rust backend
│   └── src/
│       ├── architecture/         # Dependency analysis, rule engine
│       ├── github/               # GitHub API client
│       ├── memory/               # Embedding store, memory engine
│       ├── snapshot/             # Project snapshots
│       ├── agent_tools.rs        # Tauri commands for agent tools
│       ├── autocomplete.rs       # Autocomplete backend
│       ├── call_graph.rs         # Call graph analysis
│       ├── context_compressor.rs # Context compression
│       ├── dap_manager.rs        # Debug Adapter Protocol
│       ├── docker_controller.rs  # Docker management
│       ├── embedding_pipeline.rs # Batch embedding processing
│       ├── embeddings.rs         # Embedding operations
│       ├── environment_scanner.rs# Runtime/tool detection
│       ├── fs_commands.rs        # File system operations
│       ├── git_commands.rs       # Git operations (git2)
│       ├── index_commands.rs     # Project indexing
│       ├── lsp_manager.rs        # LSP server management
│       ├── package_manager.rs    # Package operations
│       ├── pty_manager.rs        # PTY terminal
│       ├── safety.rs             # Operation safety checks
│       ├── search_commands.rs    # Full-text search
│       ├── security_scanner.rs   # Security analysis
│       ├── symbol_index.rs       # Symbol indexing (Tree-sitter)
│       ├── terminal_commands.rs  # Terminal operations
│       └── workspace_import.rs   # Workspace import
│
├── public/                       # Static assets
│   ├── icons/                    # 63 file type SVG icons
│   └── *.wasm                    # Tree-sitter WASM parsers
│
├── autorun.bat                   # Windows dev server launcher
├── package.json                  # v2.1.2
└── src-tauri/Cargo.toml          # Rust v2.1.2
```

---

## Keyboard Shortcuts

| Shortcut | Action |
|---|---|
| `Ctrl+P` | Quick open file |
| `Ctrl+Shift+P` | Command palette |
| `Ctrl+Shift+F` | Project-wide search |
| `Ctrl+Shift+E` | Explorer |
| `Ctrl+Shift+G` | Source control |
| `Ctrl+Shift+H` | GitHub panel |
| `Ctrl+Shift+A` | Toggle AI panel |
| `Ctrl+K` | Inline AI edit |
| `Ctrl+B` | Toggle sidebar |
| `Ctrl+\`` | Toggle terminal |
| `Ctrl+S` | Save file |
| `Ctrl+Shift+S` | Save all |
| `Ctrl+W` | Close tab |
| `Ctrl+N` | New file |
| `Ctrl+F` | Find in file |

---

## Configuration

All settings are persisted via `tauri-plugin-store`. Key settings:

- **AI provider & model** — per-provider API keys, model selection
- **Theme** — dark / light / system
- **Editor** — font size, font family, tab size, word wrap, minimap, line numbers
- **Auto-save** — enable/disable with delay
- **Autocomplete** — enable/disable, mode (auto/fim/chat), debounce, max tokens
- **Agent autopilot** — full auto vs supervised mode
- **Reasoning display** — compact or expanded chain-of-thought
- **Context injector** — configure what gets injected into AI context
- **Context compressor** — compression strategy settings
- **Project rules** — custom instructions applied to every AI request
- **Ollama URL** — custom local Ollama endpoint

---

## Testing

```bash
# Run all tests (single pass)
npm test

# Watch mode
npm run test:watch
```

Test coverage includes:
- Context limits & types
- Agent loop guard
- Tool policies
- Refactor service & changesets
- Technical debt analyzer (AST, debt scoring, coupling, circular deps, etc.)
- Streaming architecture (block parser, token buffer, scroll controller)
- Security scanner integration
- Multi-agent integration
- Property-based tests via `fast-check`

---

## Build

```bash
# Build desktop app (all platforms)
cargo tauri build

# Frontend only
npm run build
```

Output bundles to `dist/` (frontend) and `src-tauri/target/release/bundle/` (installers).

---

## License

MIT
