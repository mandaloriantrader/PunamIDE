# PunamIDE v2.1 — Trust & Completion Release Roadmap

## Purpose

PunamIDE v2.0 already has a strong AI-native IDE foundation: Tauri/Rust backend, React/Zustand UI, Monaco editor, LSP/DAP, PTY terminal, Git/GitHub integration, snapshots, AI agents, vector store, TF-IDF context engine, command safety, path sandboxing, and SQLite persistence.

The next release should **not** focus on adding futuristic v3 features yet.

The goal of v2.1 is:

> Every visible feature should either work properly, be completed, or be hidden until ready.

This roadmap focuses on closing the 6 current partial gaps:

1. Bundle / auto-install LSP servers
2. Dev server lifecycle for Live Preview
3. Complete or hide Docker Panel
4. Complete MCP integration
5. Add real embedding pipeline for vector store
6. Refactor huge `lib.rs` into Rust modules

---

# Release Name

## PunamIDE v2.1 — Trust & Completion Release

### Core Objective

Move Punam from:

```text
Production-ready alpha
```

to:

```text
Reliable public beta / serious daily-driver candidate
```

---

# Golden Rule For This Release

Do not add new futuristic features during this phase.

Allowed:

- Complete partially wired features
- Improve reliability
- Improve onboarding
- Reduce setup friction
- Refactor backend safely
- Add tests
- Hide unfinished UI
- Improve error handling

Not allowed:

- New agent modes
- New provider integrations
- New futuristic AI systems
- Major UI redesign
- Experimental architecture brain layer

---

# Current Problem

Punam already has many advanced systems, but 6 areas can reduce user trust if they feel unfinished:

| Gap | User Impact | Product Risk |
|-----|-------------|--------------|
| LSP servers not bundled | User opens project, language intelligence fails | High |
| Live Preview has no dev server lifecycle | Preview feels incomplete | Medium |
| Docker Panel is empty / shallow | Looks unfinished | Medium |
| MCP directory empty | Tool extensibility promise feels incomplete | Medium |
| Vector store lacks embedding pipeline | Semantic memory/search underpowered | Medium |
| `lib.rs` monolith | Maintenance risk | Medium |

---

# Phase Overview

| Phase | Focus | Outcome |
|------|-------|---------|
| Phase 0 | Stabilization prep | Baseline, tests, snapshots |
| Phase 1 | Rust module refactor | Backend becomes maintainable |
| Phase 2 | LSP auto setup | Language intelligence works out of box |
| Phase 3 | Live Preview lifecycle | Preview becomes real product feature |
| Phase 4 | Docker Panel decision | Complete or hide unfinished feature |
| Phase 5 | MCP integration | Tool extensibility foundation |
| Phase 6 | Embedding pipeline | Real vector search/memory |
| Phase 7 | QA + release hardening | Public beta readiness |

---

# PHASE 0 — Stabilization Preparation

## Goal

Create a safety net before touching core backend systems.

## Why This Comes First

Punam already has many moving parts. Before refactoring `lib.rs` or adding installers, the project needs a known-good baseline.

---

## Tasks

### 0.1 Create a Release Branch

```bash
git checkout -b release/v2.1-trust-completion
```

### 0.2 Create Safety Snapshot

Use Punam's own snapshot system before changes.

Snapshot name:

```text
v2.0-before-v2.1-trust-completion
```

### 0.3 Record Current Baseline

Run:

```bash
npm run build
cargo check
cargo build
```

If available:

```bash
cargo test
npm test
```

### 0.4 Create Baseline Checklist

Create:

```text
docs/v2.1/BASELINE.md
```

Include:

```md
# v2.1 Baseline

## Build Status
- npm run build:
- cargo check:
- cargo build:

## Known Existing Issues
- LSP install manual
- Live preview lifecycle incomplete
- Docker panel incomplete
- MCP incomplete
- Vector store missing embedding generation
- lib.rs monolithic

## Verified Working
- AI chat
- Agent mode
- Git panel
- GitHub auth
- Snapshots
- PTY terminal
- File explorer
- Search
- LSP bridge where server exists
```

---

## Acceptance Criteria

- Branch created
- Snapshot created
- Current build state recorded
- No feature work started yet

---

## AI Agent Prompt For Phase 0

```text
You are working on PunamIDE v2.1 stabilization.

Your task is Phase 0 only.

Do not implement new features.

Create a baseline safety checkpoint:
1. Verify current build commands.
2. Create docs/v2.1/BASELINE.md.
3. Document known partial systems.
4. Do not modify core logic.
5. Do not refactor yet.

Return:
- Build results
- Files created
- Any existing errors
```

---

# PHASE 1 — Refactor `lib.rs` Into Rust Modules

## Goal

Split the large Rust backend file into domain modules without changing behavior.

## Why This Should Happen Early

Future work like LSP installers, MCP, embeddings, Docker, and dev server lifecycle will all touch Rust backend commands. If `lib.rs` remains monolithic, every future change becomes risky.

---

## Current Issue

`src-tauri/src/lib.rs` is too large and contains many unrelated responsibilities.

This increases:

- Merge conflict risk
- Regression risk
- AI coding mistakes
- Hard debugging
- Hard testing

---

## Target Rust Structure

```text
src-tauri/src/
├── lib.rs
├── commands/
│   ├── mod.rs
│   ├── ai.rs
│   ├── files.rs
│   ├── terminal.rs
│   ├── git.rs
│   ├── github.rs
│   ├── lsp.rs
│   ├── dap.rs
│   ├── snapshots.rs
│   ├── search.rs
│   ├── preview.rs
│   ├── docker.rs
│   ├── mcp.rs
│   └── embeddings.rs
├── core/
│   ├── mod.rs
│   ├── path_safety.rs
│   ├── command_safety.rs
│   ├── app_state.rs
│   └── errors.rs
├── services/
│   ├── mod.rs
│   ├── pty_manager.rs
│   ├── lsp_manager.rs
│   ├── dap_manager.rs
│   ├── git_service.rs
│   ├── github_service.rs
│   ├── snapshot_service.rs
│   ├── search_service.rs
│   ├── embedding_service.rs
│   └── dev_server_service.rs
├── db/
│   ├── mod.rs
│   ├── sqlite.rs
│   ├── chat_sessions.rs
│   ├── vector_store.rs
│   └── memory.rs
└── utils/
    ├── mod.rs
    ├── fs_utils.rs
    ├── process_utils.rs
    └── json_utils.rs
```

---

## Important Rule

This phase is **behavior-preserving only**.

Do not add:

- New commands
- New UI
- New features
- New database schema
- New AI logic

Only move code into modules.

---

## Refactor Order

### Step 1: Extract Pure Utilities

Move first:

```text
path validation
command safety validation
file utility helpers
JSON helpers
process helpers
```

These are easiest to test.

### Step 2: Extract Domain Services

Move:

```text
git service
github service
snapshot service
terminal service
LSP service
DAP service
```

### Step 3: Extract Tauri Commands

Commands should become thin wrappers.

Example:

```rust
#[tauri::command]
pub async fn git_status(project_path: String) -> Result<GitStatus, String> {
    git_service::get_status(project_path).await
}
```

### Step 4: Rebuild Command Registration

In `lib.rs`, keep only:

```rust
mod commands;
mod core;
mod services;
mod db;
mod utils;

pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            commands::files::read_file,
            commands::files::write_file,
            commands::git::git_status,
            commands::github::github_auth_check,
            ...
        ])
        .run(...)
}
```

---

## Add Initial Rust Tests

Start with:

```text
path_safety tests
command_safety tests
snapshot manifest tests
```

Example tests:

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn blocks_path_traversal() {
        // verify ../../ is blocked
    }

    #[test]
    fn blocks_dangerous_command() {
        // verify rm -rf is blocked
    }
}
```

---

## Acceptance Criteria

- `lib.rs` reduced significantly
- Commands compile
- No frontend API broken
- `cargo check` passes
- `npm run build` passes
- Existing Punam features still open
- At least path safety and command safety tests exist

---

## AI Agent Prompt For Phase 1

```text
You are refactoring PunamIDE's Rust backend for v2.1.

Goal:
Split the large src-tauri/src/lib.rs into domain modules without changing behavior.

Hard rules:
1. Do not change Tauri command names.
2. Do not change frontend IPC contracts.
3. Do not add new features.
4. Do not remove existing functionality.
5. Preserve all serialization structs.
6. Make small commits/checkpoints.
7. Run cargo check after each extraction group.

Target structure:
- commands/
- core/
- services/
- db/
- utils/

Start with pure utilities:
- path safety
- command safety
- filesystem helpers
- process helpers

Then extract:
- files
- terminal
- git
- github
- lsp
- dap
- snapshots
- search
- preview
- docker
- mcp
- embeddings

After refactor:
- lib.rs should mostly contain module declarations, app setup, state registration, and invoke_handler.
- Add tests for path safety and command safety.
- Ensure npm run build and cargo check pass.

Do not perform unrelated cleanup.
```

---

# PHASE 2 — LSP Auto Setup

## Goal

Remove manual language-server installation friction.

## Problem

Punam has LSP support, but users may need to manually install language servers.

That creates a bad first impression.

---

## Target Experience

When a user opens a project:

```text
Punam detects project language:
TypeScript project found.

typescript-language-server is missing.

[Install Automatically] [Use Existing] [Ignore]
```

After clicking install:

```text
Installing TypeScript language server...
Done.
LSP started.
Diagnostics active.
```

---

## Supported Language Servers For v2.1

Start with the languages already supported:

| Language | Server | Install Method |
|----------|--------|----------------|
| TypeScript/JavaScript | typescript-language-server | npm |
| Python | pyright | npm or bundled |
| Rust | rust-analyzer | GitHub release / rustup |
| JSON | vscode-json-language-server | npm |

---

## New Rust Module

```text
src-tauri/src/services/lsp_installer.rs
```

## New Frontend Service

```text
src/services/lspSetupService.ts
```

## New UI Component

```text
src/components/lsp/LspSetupPrompt.tsx
```

---

## Detection Logic

Check:

```text
node installed?
npm installed?
language server binary exists?
project language detected?
current LSP process failed because command missing?
```

---

## Install Strategy

### Option A — Global Install

```bash
npm install -g typescript typescript-language-server
npm install -g pyright
npm install -g vscode-langservers-extracted
```

Pros:
- Simple
- Works across projects

Cons:
- Pollutes global environment
- Permission issues

### Option B — Punam Managed Tool Directory

Recommended.

Store tools under:

```text
~/.punam/tools/lsp/
```

Example:

```text
~/.punam/tools/lsp/typescript-language-server/
~/.punam/tools/lsp/pyright/
~/.punam/tools/lsp/json-language-server/
```

Pros:
- Controlled by Punam
- No global pollution
- Easier version management

Cons:
- More work

---

## Recommended v2.1 Approach

Use Punam-managed directory.

Add settings:

```json
{
  "lsp.autoInstall": true,
  "lsp.toolPath": "~/.punam/tools/lsp",
  "lsp.promptBeforeInstall": true
}
```

---

## LSP Setup Flow

```text
Open project
↓
Detect language files
↓
Check installed LSP servers
↓
If missing, show prompt
↓
Install in Punam tools directory
↓
Update LSP path config
↓
Start server
↓
Show diagnostics
```

---

## Acceptance Criteria

- TypeScript LSP auto-installs
- Python LSP auto-installs
- JSON LSP auto-installs
- Rust analyzer detection works
- User can skip install
- Failed install shows readable error
- No blocking UI during install
- Install logs visible in terminal/output panel

---

## AI Agent Prompt For Phase 2

```text
Implement PunamIDE v2.1 LSP Auto Setup.

Goal:
Users should not manually install language servers.

Requirements:
1. Detect missing LSP binaries for TypeScript, Python, Rust, and JSON.
2. Use a Punam-managed tools directory, not global install by default.
3. Add Rust service lsp_installer.rs.
4. Add frontend lspSetupService.ts.
5. Add UI prompt LspSetupPrompt.tsx.
6. Do not break existing LSP manager.
7. Existing manually installed servers must still work.
8. Show progress and errors.
9. Add settings:
   - lsp.autoInstall
   - lsp.toolPath
   - lsp.promptBeforeInstall
10. Run cargo check and npm run build.

Important:
Do not install anything silently without user approval unless autoInstall is enabled.
```

---

# PHASE 3 — Live Preview Dev Server Lifecycle

## Goal

Make Live Preview behave like a real IDE feature.

## Problem

Live Preview exists, but it needs dev server lifecycle management.

A user should not need to manually run:

```bash
npm run dev
```

and then manually paste the port.

---

## Target Experience

User opens React/Vite/Next project.

Punam detects:

```text
Vite project detected.
Dev command: npm run dev
Port: 5173
```

Then shows:

```text
[Start Preview]
```

Punam:

```text
starts dev server
streams logs
detects port
opens preview
stops server when needed
```

---

## New Rust Service

```text
src-tauri/src/services/dev_server_service.rs
```

## New Frontend Service

```text
src/services/devServerService.ts
```

## UI Components

```text
src/components/preview/DevServerControls.tsx
src/components/preview/PreviewStatusBar.tsx
```

---

## Detection Rules

Read:

```text
package.json
vite.config.*
next.config.*
astro.config.*
svelte.config.*
angular.json
```

Detect scripts:

```json
{
  "scripts": {
    "dev": "vite",
    "start": "next start",
    "serve": "vite --host"
  }
}
```

---

## Framework Detection

| Framework | Default Command | Default Port |
|----------|-----------------|--------------|
| Vite | npm run dev | 5173 |
| Next.js | npm run dev | 3000 |
| Astro | npm run dev | 4321 |
| SvelteKit | npm run dev | 5173 |
| Angular | npm start | 4200 |
| React CRA | npm start | 3000 |

---

## Dev Server State Machine

```text
Idle
↓
Starting
↓
Running
↓
Stopping
↓
Stopped

Failed can occur from Starting or Running.
```

---

## Required Features

- Start dev server
- Stop dev server
- Restart dev server
- Detect open port
- Stream logs
- Auto-open preview
- Show failed start errors
- Kill process tree
- Reuse existing PTY/process safety where possible

---

## Safety Rules

- Never run install automatically
- Ask before running dev command first time
- Respect command safety validator
- Use project root sandbox
- Stop dev server on app exit if started by Punam

---

## Acceptance Criteria

- Vite project starts preview automatically
- Next.js project starts preview automatically
- Logs stream to output/terminal
- Port detection works
- Stop button kills process tree
- Failed command displays useful error
- Preview reconnects after restart

---

## AI Agent Prompt For Phase 3

```text
Implement Live Preview Dev Server Lifecycle for PunamIDE v2.1.

Goal:
Live Preview should detect, start, stop, restart, and monitor frontend dev servers.

Requirements:
1. Add Rust dev_server_service.rs.
2. Detect framework from package.json and config files.
3. Support Vite, Next.js, Astro, SvelteKit, Angular, and CRA.
4. Add frontend devServerService.ts.
5. Add DevServerControls.tsx and PreviewStatusBar.tsx.
6. Use existing command safety validator.
7. Use existing process kill logic.
8. Stream logs to UI.
9. Detect port automatically.
10. Stop server on app exit if Punam started it.
11. Do not break existing terminal or preview panels.

Acceptance:
- Vite and Next projects must work end-to-end.
- npm run build and cargo check must pass.
```

---

# PHASE 4 — Docker Panel: Complete or Hide

## Goal

Avoid unfinished UI.

## Decision Required

Docker Panel should either become genuinely useful or be hidden behind an experimental flag.

---

# Option A — Complete Docker Panel

## Minimum Useful Docker Features

```text
List containers
Start container
Stop container
Restart container
Remove container
View logs
List images
Remove image
Detect docker-compose.yml
Compose up
Compose down
Compose logs
```

---

## Rust Service

```text
src-tauri/src/services/docker_service.rs
```

## Frontend Service

```text
src/services/dockerService.ts
```

## UI

```text
src/components/docker/DockerPanel.tsx
src/components/docker/ContainerList.tsx
src/components/docker/ImageList.tsx
src/components/docker/ComposeControls.tsx
src/components/docker/DockerLogs.tsx
```

---

## Safety

All Docker commands must pass safety checks.

Commands should be explicit, not free-form.

Allowed operations:

```text
docker ps
docker images
docker logs
docker start
docker stop
docker restart
docker rm
docker rmi
docker compose up
docker compose down
docker compose logs
```

---

## Option B — Hide Docker Panel

If you do not want to build Docker fully now:

- Hide Docker Panel from Activity Bar
- Keep code in repo
- Add feature flag:

```json
{
  "experimental.dockerPanel": false
}
```

- Show only if enabled in settings

---

## Recommendation

For v2.1, choose Option B unless Docker is already close.

Reason:

LSP, Preview, MCP, embeddings, and refactor matter more.

Docker can wait for v2.2.

---

## Acceptance Criteria If Hiding

- Docker Panel not visible by default
- Setting exists to enable experimental Docker Panel
- No broken empty UI visible

## Acceptance Criteria If Completing

- Docker installed detection
- Container list works
- Start/stop works
- Logs visible
- Compose detection works

---

## AI Agent Prompt For Phase 4A — Hide Docker

```text
For PunamIDE v2.1, hide the incomplete Docker Panel behind an experimental feature flag.

Requirements:
1. Add setting experimental.dockerPanel default false.
2. Remove Docker Panel from default Activity Bar.
3. Keep existing Docker code intact.
4. If enabled, Docker Panel appears.
5. Add small label: Experimental.
6. Do not delete Docker files.
7. npm run build must pass.
```

---

## AI Agent Prompt For Phase 4B — Complete Docker

```text
Complete the Docker Panel for PunamIDE v2.1.

Requirements:
1. Add Rust docker_service.rs.
2. Implement safe explicit Docker commands only.
3. Add frontend dockerService.ts.
4. Show containers, images, compose controls, and logs.
5. Detect missing Docker and show setup message.
6. Support docker compose if docker-compose.yml exists.
7. Do not allow arbitrary Docker shell commands from UI.
8. Use existing command safety validator.
9. npm run build and cargo check must pass.
```

---

# PHASE 5 — MCP Integration

## Goal

Make MCP a real extensibility system inside Punam.

## Problem

MCP is important for AI tool extensibility, but an empty MCP directory feels incomplete.

---

## Target Experience

User opens MCP Settings:

```text
MCP Servers

[Add Server]
Name:
Command:
Args:
Environment:

Status:
Connected / Disconnected / Failed
```

AI Agent can use tools exposed by enabled MCP servers.

---

## Core Concepts

MCP server config:

```json
{
  "id": "filesystem",
  "name": "Filesystem MCP",
  "command": "npx",
  "args": ["-y", "@modelcontextprotocol/server-filesystem", "."],
  "enabled": true,
  "env": {}
}
```

---

## Rust Modules

```text
src-tauri/src/services/mcp_manager.rs
src-tauri/src/services/mcp_process.rs
src-tauri/src/services/mcp_protocol.rs
```

## Frontend

```text
src/services/mcpService.ts
src/components/settings/McpSettings.tsx
src/components/mcp/McpServerList.tsx
src/components/mcp/McpToolInspector.tsx
```

---

## MCP Features For v2.1

Minimum viable MCP:

```text
Add server
Edit server
Delete server
Start server
Stop server
Restart server
Show connection status
List tools
Allow AI tool router to call selected MCP tools
Show tool call logs
```

---

## Important Safety Rules

- Never run arbitrary MCP command without user approval
- Store configs locally
- Show full command before first run
- Use environment variable redaction
- Do not expose secrets to frontend logs
- MCP tools must respect project sandbox where applicable

---

## MCP Tool Routing

Flow:

```text
AI wants tool
↓
Tool router checks native Punam tools first
↓
If MCP tool matches and server enabled
↓
Request user approval for first use
↓
Execute MCP call
↓
Return result to AI
```

---

## Acceptance Criteria

- User can add one MCP server
- Server starts and stops
- Tools are listed
- Tool call can be executed
- Logs visible
- Failed server shows readable error
- MCP is disabled by default until configured

---

## AI Agent Prompt For Phase 5

```text
Implement minimum viable MCP integration for PunamIDE v2.1.

Goal:
MCP should be a real configurable tool system, not an empty settings section.

Requirements:
1. Add Rust MCP manager for process lifecycle.
2. Add MCP config storage.
3. Add start/stop/restart server commands.
4. Add tool listing.
5. Add frontend MCP settings UI.
6. Add MCP server list and tool inspector.
7. Add safe approval flow before first server run.
8. Redact environment variables and secrets in logs.
9. Do not expose raw secrets to frontend.
10. Integrate MCP tools into existing AI tool router only after server is enabled.
11. npm run build and cargo check must pass.

Do not implement complex marketplace features yet.
```

---

# PHASE 6 — Real Embedding Pipeline For Vector Store

## Goal

Make vector search and long-term memory real.

## Problem

Vector store exists, but without embedding generation it is incomplete.

---

## Target Experience

Punam indexes a project:

```text
Generating embeddings...
Indexed 248 code chunks.
Semantic search ready.
```

Then AI context can retrieve by meaning, not just keyword.

---

## Embedding Options

### Option A — API-Based Embeddings

Use providers:

- OpenAI embeddings
- Gemini embeddings
- Voyage / Jina / other provider later

Pros:
- Easier
- Good quality

Cons:
- Cost
- Internet required
- Privacy concern

### Option B — Local ONNX Embeddings

Use local model through ONNX runtime.

Pros:
- Private
- Offline
- Great for local IDE

Cons:
- More difficult
- Larger binary/model download

### Option C — Hybrid

Recommended.

Start with API embeddings, then add local embeddings later.

---

## Recommended v2.1 Approach

Implement provider-based embeddings first:

```text
Gemini embeddings if Gemini key exists
OpenAI embeddings if OpenAI key exists
Fallback to TF-IDF if no embedding provider configured
```

Later v2.2:

```text
Local ONNX embedding model
```

---

## Rust Modules

```text
src-tauri/src/services/embedding_service.rs
src-tauri/src/db/vector_store.rs
```

## Frontend

```text
src/services/embeddingService.ts
src/components/settings/EmbeddingSettings.tsx
src/components/search/SemanticSearchPanel.tsx
```

---

## Database Tables

```sql
CREATE TABLE IF NOT EXISTS embeddings (
    id TEXT PRIMARY KEY,
    project_path TEXT NOT NULL,
    file_path TEXT NOT NULL,
    chunk_start INTEGER NOT NULL,
    chunk_end INTEGER NOT NULL,
    content_hash TEXT NOT NULL,
    provider TEXT NOT NULL,
    model TEXT NOT NULL,
    dimensions INTEGER NOT NULL,
    vector BLOB NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_embeddings_project
ON embeddings(project_path);

CREATE INDEX IF NOT EXISTS idx_embeddings_file_hash
ON embeddings(file_path, content_hash);
```

---

## Chunking Strategy

Reuse current code indexer:

```text
30-line chunks
5-line overlap
skip node_modules
skip .git
skip build dirs
skip binary files
max file size limit
```

---

## Embedding Pipeline

```text
File watcher detects change
↓
Compute content hash
↓
If hash unchanged, skip
↓
Chunk file
↓
Generate embeddings
↓
Store vectors
↓
Semantic search available
```

---

## Search Flow

```text
User query
↓
Generate query embedding
↓
Compare cosine similarity
↓
Return top chunks
↓
Merge with TF-IDF results
↓
Apply boosts:
- open tab boost
- git recency boost
- file extension boost
```

---

## Privacy Settings

Add setting:

```json
{
  "embeddings.enabled": false,
  "embeddings.provider": "gemini",
  "embeddings.model": "text-embedding-004",
  "embeddings.allowCloud": false,
  "embeddings.indexOnOpen": false
}
```

Default should be conservative:

```text
embeddings.enabled = false
```

Ask user before cloud embedding.

---

## Acceptance Criteria

- User can enable embeddings
- Gemini embedding generation works if key exists
- OpenAI embedding generation works if key exists
- Existing TF-IDF still works if embeddings disabled
- Changed files are re-indexed
- Unchanged files are skipped
- Semantic search returns relevant chunks
- No secrets stored in vector table
- Build passes

---

## AI Agent Prompt For Phase 6

```text
Implement real embedding pipeline for PunamIDE v2.1.

Goal:
The existing vector store should become functional through provider-based embeddings.

Requirements:
1. Add embedding_service.rs.
2. Support Gemini embeddings and OpenAI embeddings.
3. Add embeddings table with content hash.
4. Reuse existing project chunking rules.
5. Skip unchanged chunks using content_hash.
6. Add frontend EmbeddingSettings.
7. Embeddings must be disabled by default.
8. Ask before using cloud embeddings.
9. If embeddings disabled, current TF-IDF search must continue working.
10. Add semantic search that merges embedding similarity with existing context scoring.
11. Do not expose API keys in logs or DB.
12. npm run build and cargo check must pass.
```

---

# PHASE 7 — QA, Release Hardening, and Public Beta Readiness

## Goal

Ensure v2.1 feels trustworthy.

---

## Manual Test Matrix

### Core IDE

```text
Open folder
Open file
Edit file
Save file
Create file
Rename file
Delete file
Search project
Find/replace
Command palette
Split editor
Tabs
```

### AI

```text
Chat streaming
Provider switch
Agent reads file
Agent applies patch
Diff preview
3-way merge conflict
Thinking block hidden
Token usage dashboard
```

### Terminal

```text
Open PTY terminal
Run npm install
Run npm run dev
Kill process
Open multiple terminal tabs
Error parser links to file
```

### Git/GitHub

```text
Git status
View diff
Commit
Push dry-run
Pull safety check
Create issue
List PR
GitHub Actions list
```

### Snapshot

```text
Create snapshot
Preview restore
Restore snapshot
Export ZIP
Auto snapshot retention
```

### New v2.1

```text
LSP auto install
Live preview server start
Live preview stop
MCP server add/start/list tools
Embedding enable/index/search
Docker hidden or working
lib.rs refactor no regression
```

---

## Release Blocking Bugs

A bug blocks v2.1 release if:

```text
App cannot open
Project cannot load
File save fails
AI patch corrupts file
Snapshot restore fails
Git status crashes
Terminal cannot start
LSP install breaks existing LSP
Preview cannot stop dev server
Secrets leak to logs
```

---

## Suggested Versioning

```text
v2.1.0-alpha.1
v2.1.0-alpha.2
v2.1.0-beta.1
v2.1.0
```

---

## Release Notes Template

```md
# PunamIDE v2.1 — Trust & Completion Release

## Highlights
- Automatic LSP setup
- Real Live Preview dev server lifecycle
- MCP integration foundation
- Functional embedding pipeline
- Rust backend modularized
- Docker Panel hidden behind experimental flag / completed

## Stability
- Safer backend module structure
- Improved first-run experience
- Better setup guidance

## Known Limitations
- Local embeddings coming later
- Docker features experimental
- Extension marketplace not yet available
```

---

# Recommended Execution Order

The safest order:

```text
1. Phase 0 — baseline
2. Phase 1 — lib.rs refactor
3. Phase 2 — LSP auto setup
4. Phase 3 — Live Preview lifecycle
5. Phase 4 — Hide Docker Panel
6. Phase 5 — MCP integration
7. Phase 6 — Embedding pipeline
8. Phase 7 — QA/release hardening
```

Why hide Docker first instead of completing it?

Because:

```text
LSP + Preview + MCP + Embeddings
```

matter more than Docker for an AI IDE.

Docker can become a v2.2 feature.

---

# Risk Management Strategy

## Always Create Snapshots Before Each Phase

Use names:

```text
v2.1-phase-0-baseline
v2.1-phase-1-before-lib-refactor
v2.1-phase-2-before-lsp-auto-setup
v2.1-phase-3-before-preview-lifecycle
v2.1-phase-5-before-mcp
v2.1-phase-6-before-embeddings
```

---

## Commit Style

Use small commits:

```text
refactor(rust): extract path safety module
refactor(rust): extract git commands
feat(lsp): add language server detection
feat(lsp): add managed tool directory
feat(preview): add dev server lifecycle state
chore(docker): hide panel behind experimental flag
feat(mcp): add MCP server config storage
feat(embeddings): add provider embedding service
```

---

## Do Not Let AI Agents Rewrite Large Files Blindly

For every AI agent task, require:

```text
- Read file first
- Plan exact target blocks
- Modify minimal sections
- Preserve command names
- Run build
- Report changed files
```

---

# Master Prompt For Coding Agent

Use this before each implementation phase:

```text
You are working inside PunamIDE, a Tauri 2 + Rust + React 19 + TypeScript AI-native IDE.

Critical rules:
1. Do not rewrite unrelated files.
2. Do not rename existing Tauri commands unless explicitly required.
3. Preserve all frontend IPC contracts.
4. Preserve path sandbox and command safety behavior.
5. Prefer small focused patches.
6. Do not remove existing working functionality.
7. Before changing a large file, identify exact sections to modify.
8. After changes, run:
   - cargo check
   - npm run build
9. If build fails, fix only the introduced error.
10. Report:
   - files changed
   - commands added
   - risks
   - test/build results

Current release goal:
PunamIDE v2.1 Trust & Completion Release.

This release completes partial systems only:
- LSP auto setup
- Live Preview dev server lifecycle
- Docker hidden or completed
- MCP integration
- Embedding pipeline
- Rust backend modularization

Do not implement v3 Brain Layer features yet.
```

---

# Final Definition of Done

PunamIDE v2.1 is complete when:

```text
User installs Punam
↓
Opens a project
↓
Language intelligence works or auto-setup guides them
↓
Preview starts without manual terminal work
↓
AI context search has real semantic option
↓
MCP settings are functional
↓
No empty unfinished panel is visible
↓
Rust backend is modular enough to maintain
↓
Core app builds cleanly
↓
No secrets leak
↓
Snapshots protect risky operations
```

---

# Strategic Outcome

After this release, Punam will be ready for the real v3 intelligence layer:

```text
Architecture Graph
Architecture Guardrails
Long-Term Memory
Project Health Score
Multi-Agent Orchestration
Self-Healing CI/CD
```

But those should be built only after v2.1 makes the current foundation feel complete, reliable, and trustworthy.
