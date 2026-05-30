# 🔬 PunaIDe v2.0 — Full Tech Stack & Core Functionality Audit

> Generated: 2026-05-30 | Deep scan of all source files, configuration, and dependencies.

---

## 1. TECH STACK

### Frontend (React Desktop App)

| Layer | Technology | Version |
|-------|-----------|---------|
| **Framework** | React (TSX) | 19.2.6 |
| **Language** | TypeScript | 6.0 |
| **Build Tool** | Vite | 8.0 |
| **Desktop Shell** | Tauri (Rust backend) | 2.11.2 |
| **Code Editor** | Monaco Editor | 0.55.1 |
| **Terminal Emulator** | xterm.js + addon-fit + addon-web-links | 6.0 |
| **Styling** | Tailwind CSS | 4.3 |
| **State Management** | Zustand | 5.0.5 |
| **Icons** | Lucide React | 1.16 |
| **Syntax Highlight** | highlight.js | 11.11 |
| **Pane Splitting** | react-split | 2.0.14 |
| **Linting** | ESLint + typescript-eslint | 10.3 / 8.59 |

### Frontend Tauri Plugins (JS side)
- `@tauri-apps/api` 2.11.0
- `@tauri-apps/plugin-dialog` 2.7.1
- `@tauri-apps/plugin-fs` 2.5.1
- `@tauri-apps/plugin-shell` 2.3.5
- `@tauri-apps/plugin-store` 2.4.3

### Backend (Rust / Tauri)

| Crate | Purpose |
|-------|---------|
| `tauri` 2.11.2 | Desktop framework |
| `reqwest` 0.12 | HTTP client (rustls TLS, JSON, streaming) |
| `tokio` 1 (full) | Async runtime |
| `git2` 0.19 | Native Git operations (libgit2) |
| `portable-pty` 0.8 | Cross-platform pseudo-terminals |
| `rusqlite` 0.31 (bundled) | Embedded SQLite database |
| `notify` 7 + `notify-debouncer-mini` | File system watcher |
| `walkdir` 2 | Recursive directory traversal |
| `zip` 2.1 | Snapshot export/compression |
| `serde` / `serde_json` 1.0 | Serialization |
| `dirs` 5 | OS data directories |
| `futures-util` 0.3 | Async stream utilities |

### LLM Providers Integrated
| Provider | Protocol | Streaming |
|----------|----------|-----------|
| **Google Gemini** | Native Gemini API (generateContent + streamGenerateContent SSE) | Yes |
| **OpenAI** | Chat Completions API (/v1) | Yes (SSE) |
| **Groq** | OpenAI-compatible (/openai/v1) | Yes |
| **OpenRouter** | OpenAI-compatible gateway with referer/title headers, model name normalization | Yes |
| **Ollama** | Local, OpenAI-compatible, no API key required | Yes |
| **DuckDuckGo** | Web search API | N/A |

---

## 2. COMPREHENSIVE FUNCTIONALITY / CAPABILITY LIST

### A. IDE Core (Code Editing & Project Management)

1. **Multi-tab Code Editor** — Monaco Editor with syntax highlighting for 100+ languages, multi-cursor, minimap, diff editor, split editor (horizontal/vertical)
2. **File Explorer** — Tree-based file browser with create/rename/delete, directory-aware icons, hidden file toggle
3. **Project Search** — Full-text search across all project files with live results, file-type filtering, regex support
4. **Find & Replace** — Editor-level find/replace with regex, case-sensitivity, whole-word options
5. **Command Palette** — Fuzzy command search (Ctrl+Shift+P) for all IDE actions
6. **Status Bar** — File info, language mode, line/column, encoding, indentation, git branch display
7. **Title Bar** — Custom title bar with window controls
8. **Activity Bar** — Left sidebar with icon navigation (Explorer, Search, Git, Debug, AI Chat, Settings)
9. **Editor Tabs** — Drag-reorderable, close, pin, context menu
10. **Inline Edit** — In-editor AI code suggestions with diff preview and accept/reject
11. **Inline Completion (Ghost Text)** — AI-powered ghost text completions as you type
12. **File Templates** — Pre-built templates for common file types (components, pages, etc.)

### B. Terminal System

13. **Integrated Terminal** — Multi-tab terminal with xterm.js rendering
14. **PTY Shell** — Native pseudo-terminal (cmd/PowerShell on Windows, bash/zsh on Unix) with full interactivity
15. **Streaming Terminal Output** — Line-by-line stdout/stderr streaming with live status events (running/completed/failed/killed)
16. **Command Execution** — Blocking async commands with stdout/stderr capture
17. **Terminal Error Parser** — Auto-detects build errors, test failures, TypeScript errors from terminal output with quick-action links
18. **Process Tree Kill** — Windows: `taskkill /T /F /PID` + fallback; Unix: process group `kill -9`
19. **TCP Port Check** — Check if a local port is open (for dev server detection)

### C. AI Chat & Agent System

20. **AI Chat Panel** — Multi-session chat with persistent history, provider/model selection, streaming responses
21. **Agent Mode** — Autonomous coding agent that can read/write files, execute commands, apply patches
22. **Thinking/Reasoning Extraction** — Separates `<thinking>` tags from user-visible content
23. **Tool Events Tracking** — Records tool_call, tool_result, and command events per message
24. **Multi-Response Handling** — Support for parallel AI responses
25. **Structured Streaming Blocks** — Progressive rendering of AI output (think/message/tool blocks)
26. **Context Mentions** — @file, @folder, @codebase, @web, @docs, @git, @terminal, @selection, @problems resolution
27. **Context Engine** — Automatic relevant file gathering using TF-IDF scoring, git recency boost, open tab boost
28. **Web Search** — DuckDuckGo-powered web search integration for AI context
29. **JSON Tool Loop** — Frontend tool execution orchestration with read_lines and apply_patch
30. **AI Worker** — Background Web Worker for non-blocking AI processing
31. **Code Review** — AI-powered code review panel
32. **Test Generator** — AI-powered test generation from source code
33. **Bug Hunt** — AI-assisted bug detection
34. **Agent Kanban** — Kanban board for agent task management
35. **Background Agent Panel** — Background task execution and monitoring
36. **Background Agent Executor** — Service for running agent tasks in the background
37. **AI Diff Preview** — Side-by-side diff of AI-proposed changes before applying
38. **Composer Panel** — AI code composition interface
39. **Multi-File Diff Board** — View diffs across multiple files simultaneously
40. **Usage Dashboard** — Token usage tracking, cost estimation, per-provider/per-day breakdown
41. **Chat Sessions Persistence** — SQLite-backed chat history with title, provider, model, messages, token count, cost

### D. Git Integration

42. **Git Status** — Native git status via libgit2 (modified, added, deleted, renamed, untracked, conflicted)
43. **Git Diff** — Per-file diff with context lines, line counts, patch formatting
44. **Git Log** — Recent commit history
45. **Git Branch** — Current branch detection
46. **Git Panel** — Full git operations panel (commit, push, pull, branch management)
47. **Git Diff View** — Visual diff viewer component
48. **Git Store** — Zustand store for git state management

### E. GitHub Integration (Full REST API Client — PAT never leaves Rust)

49. **GitHub Auth** — PAT-based authentication, user info, auth check, logout
50. **Repo Management** — Create repo, list repos, get repo info, link/remove remote, init repo, get repo slug
51. **Push/Pull/Sync** — Push, pull, fetch, stash/stash-pop, create/switch/delete branch, merge abort
52. **Pull Requests** — Create PR, list PRs, get PR, merge PR, close PR, list/add comments
53. **Issues** — List issues, create issue, close issue, list/add comments
54. **GitHub Actions** — List workflow runs, get workflow run, rerun workflow
55. **Gists** — Create single gist, create multi-file gist
56. **Safety Layer** — Pre-push check, pre-pull check, dry-run push, safety snapshots, rollback
57. **Git Core Check** — Full repo status, dirty files, remote origin, ahead/behind counts

### F. Debugging

58. **DAP Manager** — Debug Adapter Protocol client (supports stdio and TCP connections)
59. **Debugger Panel** — Breakpoints, call stack, variables, watch expressions
60. **Breakpoint Glyphs** — Editor gutter breakpoint indicators
61. **Debug Config Picker** — Launch configuration selector

### G. Language Server Protocol (LSP)

62. **LSP Manager** — Auto-restart (max 3 retries, 2s delay), startup tracking, crash recovery
63. **Supported Languages** — TypeScript/JavaScript (typescript-language-server), Rust (rust-analyzer), Python (pyright-langserver), JSON (vscode-json-language-server)
64. **LSP Features** — Diagnostics, Completion (Ctrl+Space), Hover (type info), Go to Definition, Format Document
65. **Monaco LSP Bridge** — Connects Rust LSP backend to Monaco editor diagnostics and completions

### H. Snapshot & Backup System

66. **Create Snapshot** — Full project snapshot with manifest, stored in `.punam-backups/`
67. **List Snapshots** — View all snapshots with metadata (name, date, file count, size, version)
68. **Restore Preview** — See what files will be modified/added/deleted before restoring
69. **Restore Snapshot** — Full project state rollback
70. **Export Snapshot** — Export as ZIP file
71. **Delete Snapshot** — Remove old snapshots
72. **Auto-Snapshot** — Automatic safety snapshots with max retention (20)
73. **Snapshot Manager UI** — Dedicated UI component for snapshot interactions

### I. Code Intelligence

74. **Project Index** — File index cache with preview text (first 500 chars), with skip lists for node_modules, .git, build dirs, binary files, etc.
75. **Codebase Search (TF-IDF)** — Semantic code search with inverted index, chunk-based (30-line windows, 5-line overlap), stop-word filtering, tokenization
76. **Fuzzy Find Block** — Levenshtein-distance-based code block matching for AI edits
77. **Diff Engine** — LCS-based text diff with hunk tracking, additions/deletions counts
78. **3-Way Merge** — Conflict-aware merge for AI changes vs concurrent user edits, with conflict markers (<<<Current File / === / >>>AI Proposed)
79. **Context Engine (Unified)** — Combines TF-IDF semantic search + token overlap + git recency boost + open tab boost for optimal AI context gathering

### J. File System & Safety

80. **Path Sandbox** — All file operations validated to stay within project root (canonical path verification)
81. **Command Safety Validator** — Inspects commands for dangerous operations (`rm -rf`, `:(){`, fork bombs, `> /dev/sda`, etc.) before execution
82. **File Watcher** — Debounced (500ms) recursive file watching with events emitted to frontend
83. **File Operations** — Read (2MB limit), write, create, delete, rename, reveal in explorer, path existence check
84. **Directory Operations** — Read tree (depth-limited to 4 levels), create, with comprehensive skip lists (50+ build/cache directories)

### K. Web & Preview

85. **Live Preview** — Embedded web browser preview for HTML/React projects
86. **Web Preview Panel** — Dedicated panel for web content rendering
87. **Docker Panel** — Docker container management interface

### L. Notes & Productivity

88. **Notepads Panel** — Persistent notepads with title, content, pinning, creation/update timestamps
89. **Notes Panel** — Quick notes interface
90. **Problems Panel** — Aggregated errors/warnings display
91. **Search Panel** — Advanced project-wide search interface
92. **Run Profiles** — Saved terminal command profiles for quick execution
93. **Right Panel** — Configurable right sidebar container
94. **Split Editor** — Side-by-side or stacked editor panes

### M. Settings & Configuration

95. **Settings Panel** — Full settings UI with sections for AI providers, editor, terminal, appearance
96. **MCP Settings** — Model Context Protocol server configuration
97. **Theme Support** — Multiple themes (dark/light)
98. **Keyboard Shortcuts** — Configurable keyboard shortcut system (useKeyboardShortcuts hook)
99. **Auto-Save** — Configurable auto-save with debounce

### N. Embedded Database

100. **SQLite Persistence** — Local database (`punamide.db`) via rusqlite with `chat_sessions` table storing id, title, provider, model, messages (JSON), token_count, cost, timestamps
101. **Vector Store** — Embeddings-based vector storage for semantic code search

### O. System & Architecture

102. **Tauri IPC** — All backend functionality exposed via `#[tauri::command]` with streaming events
103. **Error Boundary** — React error boundary for graceful crash handling
104. **Toast System** — Toast notification utility
105. **ANSI Terminal Parser** — ANSI escape code rendering for terminal output
106. **File Icon System** — File-type-aware icon mapping
107. **App Config** — Provider, API key, model, theme stored via Tauri Store plugin
108. **Graceful Shutdown** — LSP servers, PTY sessions, and DAP sessions all killed on app exit

---

## 3. PROJECT ARCHITECTURE

```
project-root/
├── src/                        # React frontend
│   ├── components/             # 50+ React TSX components
│   │   ├── ActivityBar.tsx, AiChat.tsx, CodeEditor.tsx, FileExplorer.tsx
│   │   ├── Terminal.tsx, GitPanel.tsx, DebuggerPanel.tsx, Settings.tsx
│   │   ├── chat/               # Chat-specific components
│   │   ├── github/             # GitHub UI components
│   │   └── settings/           # Settings UI components
│   ├── hooks/                  # Custom React hooks (useChatSessions, useKeyboardShortcuts, etc.)
│   ├── store/                  # 10 Zustand stores (aiStore, editorStore, gitStore, uiStore, etc.)
│   ├── services/               # 15+ service modules
│   │   ├── ai/                 # AI context, streaming, web search
│   │   ├── agent/              # Agent context builder, differ
│   │   ├── embeddings/         # Vector store
│   │   ├── indexing/           # Project indexer
│   │   ├── lsp/                # LSP client, manager, Monaco bridge
│   │   ├── mcp/                # MCP integration
│   │   ├── persistence/        # Chat DB (SQLite)
│   │   ├── terminal/           # Error parser
│   │   └── workspace/          # Workspace manager
│   ├── types/                  # TypeScript type definitions
│   ├── utils/                  # 20+ utility modules (context engine, inline completion, etc.)
│   └── workers/                # AI Web Worker
├── src-tauri/                  # Rust backend
│   └── src/
│       ├── lib.rs              # Main Tauri commands (2,864 lines)
│       ├── agent_tools.rs      # read_lines + apply_patch
│       ├── pty_manager.rs      # PTY terminal management
│       ├── lsp_manager.rs      # LSP client implementation
│       ├── dap_manager.rs      # Debug Adapter Protocol client
│       ├── safety.rs           # Command safety validation
│       ├── snapshot/           # Snapshot/backup system
│       └── github/             # GitHub integration (auth, sync, PRs, issues, actions, gists)
├── package.json                # Frontend dependencies
├── Cargo.toml                  # Rust dependencies
└── tauri.conf.json             # Tauri app configuration
```

## 4. SUMMARY

**PunamIDE v2.0** is a full-featured, AI-native desktop IDE built on **Tauri (Rust + React)**. It features:

- A Monaco-based **code editor** with LSP intelligence (TypeScript, Rust, Python, JSON)
- A **multi-provider AI system** (Gemini, OpenAI, Groq, OpenRouter, Ollama) with streaming, agent mode, tool execution, and context awareness
- **Full GitHub integration** with PAT security (token stays in Rust)
- **Debugger** via Debug Adapter Protocol (DAP)
- **Snapshot/backup** system with restore and export
- **Git** operations via native libgit2
- **Embedded PTY terminal** with process management
- **SQLite** persistence for chat sessions
- **50+ React components**, **10 Zustand stores**, **15+ service modules**, and a **Web Worker** for background AI processing