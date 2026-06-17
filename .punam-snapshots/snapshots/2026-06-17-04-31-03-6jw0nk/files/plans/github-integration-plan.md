# Punam IDE — Full GitHub Integration Plan

## Architecture

```
React UI (Components)
    ↓ invoke()
Tauri Rust Commands (src-tauri/src/github/)
    ↓
GitHub API Client (reqwest + serde)
    ↓
Secure Token Store (tauri-plugin-store / OS keychain)
```

**Key Principle:** PAT never lives in React state. Frontend only sends invoke() calls, Rust handles all auth + API.

---

## Required GitHub Token Scopes

```
repo            — full repo access (create, push, PRs, issues)
workflow        — GitHub Actions read/trigger
gist            — create/edit gists
read:user       — read user profile
user:email      — read user email
```

---

## File Structure

### Rust Backend

```
src-tauri/src/github/
├── mod.rs              — module exports, shared state
├── auth.rs             — token storage, validation, user info
├── client.rs           — HTTP client wrapper (reqwest), error handling
├── repos.rs            — create, list, clone, delete repos
├── pull_requests.rs    — create, list, merge, review PRs
├── issues.rs           — create, list, comment on issues
├── actions.rs          — workflow runs status, trigger re-run
├── gists.rs            — create gist from code
└── types.rs            — shared structs (GitHubUser, Repo, PR, Issue, etc.)
```

### Frontend

```
src/stores/githubStore.ts        — Zustand store for GitHub state
src/services/githubService.ts    — invoke() wrappers for all Rust commands

src/components/github/
├── GitHubPanel.tsx              — main panel (tab in sidebar)
├── GitHubSettings.tsx           — token input, scopes, connection status
├── RepoManager.tsx              — create/link/clone repos
├── PullRequestPanel.tsx         — PR list, create, merge
├── IssuesPanel.tsx              — issue list, create, comment
└── ActionsStatus.tsx            — workflow run badges
```

---

## Phase 0: Git Core Check (Foundation)

Before any GitHub operation, validate local git state.

### Rust Commands

| Command | Purpose |
|---------|---------|
| `github_check_git_repo` | Is current folder a git repo? |
| `github_get_branch` | Current branch name |
| `github_get_dirty_files` | Uncommitted changes list |
| `github_get_remote_origin` | Remote URL (if any) |
| `github_get_ahead_behind` | Commits ahead/behind remote |
| `github_check_git_available` | git2 crate is always available, no binary needed |

### Implementation Notes
- Use `git2` crate (already in your Cargo.toml) — no shell dependency
- Cache results in Rust state, refresh on demand
- Return structured errors: `NoRepo`, `NoRemote`, `Detached`, etc.

---

## Phase 1: Authentication & Token Management

### Rust (`auth.rs`)

```rust
#[tauri::command]
fn github_set_token(token: String) -> Result<(), String>
// Encrypts and stores token using tauri-plugin-store or OS keychain

#[tauri::command]
fn github_validate_token() -> Result<GitHubUser, String>
// GET /user — returns username, avatar, email

#[tauri::command]
fn github_get_user() -> Result<Option<GitHubUser>, String>
// Returns cached user info (or None if not authenticated)

#[tauri::command]
fn github_logout() -> Result<(), String>
// Clears stored token
```

### Frontend (`GitHubSettings.tsx`)
- Token input field (password type, paste-only)
- "Connect" button → calls `github_set_token` then `github_validate_token`
- Shows: avatar, username, connected scopes
- "Disconnect" button → calls `github_logout`
- Status indicator in activity bar (green dot = connected)

### Token Storage Options (pick one)
1. **tauri-plugin-store** — encrypted JSON file (simpler)
2. **keyring crate** — OS credential manager (Windows Credential Vault) (more secure)

Recommendation: Start with `tauri-plugin-store`, upgrade to keyring later.

---

## Phase 2: Repository Management

### Rust (`repos.rs`)

```rust
#[tauri::command]
fn github_create_repo(name: String, private: bool, description: Option<String>) -> Result<RepoInfo, String>
// POST /user/repos

#[tauri::command]
fn github_list_repos(page: u32, per_page: u32) -> Result<Vec<RepoInfo>, String>
// GET /user/repos?sort=updated

#[tauri::command]
fn github_link_remote(repo_url: String) -> Result<(), String>
// git remote add origin <url> (via git2)

#[tauri::command]
fn github_clone_repo(repo_url: String, local_path: String) -> Result<(), String>
// git2::Repository::clone()

#[tauri::command]
fn github_get_repo_info(owner: String, repo: String) -> Result<RepoInfo, String>
// GET /repos/{owner}/{repo}
```

### Frontend (`RepoManager.tsx`)
- "Create Repo" form: name, description, public/private toggle
- After create → auto-link remote + initial push
- "Clone" dialog: search repos or paste URL, pick folder
- "Link Remote" for existing projects without origin
- Show current repo info (name, visibility, stars, forks)

---

## Phase 3: Enhanced Push/Pull/Sync

### Rust Commands

```rust
#[tauri::command]
fn github_push(force: bool, branch: Option<String>) -> Result<PushResult, String>
// git2 push with refspec, handles upstream setup

#[tauri::command]
fn github_pull(branch: Option<String>) -> Result<PullResult, String>
// git2 fetch + merge

#[tauri::command]
fn github_fetch() -> Result<FetchResult, String>
// git2 fetch — updates ahead/behind count

#[tauri::command]
fn github_create_branch(name: String, checkout: bool) -> Result<(), String>

#[tauri::command]
fn github_switch_branch(name: String) -> Result<(), String>

#[tauri::command]
fn github_list_branches(include_remote: bool) -> Result<Vec<BranchInfo>, String>

#[tauri::command]
fn github_delete_branch(name: String, remote: bool) -> Result<(), String>
```

### Smart Push Flow
1. Check dirty files → block if uncommitted (show warning)
2. Check if remote exists → if not, offer "Create Repo" flow
3. Check ahead/behind → warn if behind (suggest pull first)
4. Push → show success/failure

---

## Phase 4: Pull Requests

### Rust (`pull_requests.rs`)

```rust
#[tauri::command]
fn github_create_pr(title: String, body: String, base: String, head: String, draft: bool) -> Result<PullRequest, String>
// POST /repos/{owner}/{repo}/pulls

#[tauri::command]
fn github_list_prs(state: String) -> Result<Vec<PullRequest>, String>
// GET /repos/{owner}/{repo}/pulls?state=open

#[tauri::command]
fn github_get_pr(number: u32) -> Result<PullRequestDetail, String>
// GET /repos/{owner}/{repo}/pulls/{number}

#[tauri::command]
fn github_merge_pr(number: u32, method: String) -> Result<(), String>
// PUT /repos/{owner}/{repo}/pulls/{number}/merge
// method: "merge" | "squash" | "rebase"

#[tauri::command]
fn github_pr_add_comment(number: u32, body: String) -> Result<(), String>

#[tauri::command]
fn github_pr_list_comments(number: u32) -> Result<Vec<Comment>, String>
```

### Frontend (`PullRequestPanel.tsx`)
- "Create PR" button on current branch → auto-fills head branch
- AI-generated PR description from commit log
- PR list with status badges (open, merged, closed, draft)
- Merge button with method selector
- Comment thread view

---

## Phase 5: Issues & Extras

### Rust (`issues.rs`, `actions.rs`, `gists.rs`)

```rust
// Issues
fn github_list_issues(state: String, labels: Vec<String>) -> Result<Vec<Issue>, String>
fn github_create_issue(title: String, body: String, labels: Vec<String>) -> Result<Issue, String>
fn github_add_issue_comment(number: u32, body: String) -> Result<(), String>

// Actions
fn github_list_workflow_runs(branch: Option<String>) -> Result<Vec<WorkflowRun>, String>
fn github_get_run_status(run_id: u64) -> Result<WorkflowRun, String>
fn github_rerun_workflow(run_id: u64) -> Result<(), String>

// Gists
fn github_create_gist(filename: String, content: String, public: bool, description: Option<String>) -> Result<GistInfo, String>
```

### Frontend
- Issues panel: list, create, filter by label
- Actions badge in status bar (green check / red X / yellow spinner)
- Right-click file/selection → "Create Gist"
- Auto-detect `#123` in commit messages → link to issue

---

## Phase 6: Safety Layer

### Pre-Operation Checks

| Operation | Safety Check |
|-----------|-------------|
| Push | Block if uncommitted changes exist |
| Force Push | Require explicit confirmation dialog |
| Pull/Merge/Rebase | Auto-create snapshot before operation |
| Delete Branch | Confirm + check if branch has unmerged commits |
| Create Repo | Confirm name + visibility |

### Rust Safety Commands

```rust
#[tauri::command]
fn github_pre_push_check() -> Result<PrePushStatus, String>
// Returns: { dirty_files: Vec<String>, ahead: u32, behind: u32, has_remote: bool }

#[tauri::command]
fn github_dry_run_push() -> Result<DryRunResult, String>
// Shows what would be pushed without actually pushing

#[tauri::command]
fn github_rollback_last_operation() -> Result<(), String>
// Restores from auto-snapshot taken before dangerous operation

#[tauri::command]
fn github_create_safety_snapshot(reason: String) -> Result<String, String>
// Creates a tagged snapshot before risky operations
```

### Safety Flow Example (Pull)
```
User clicks "Pull"
  → Rust: check dirty files
  → Rust: create safety snapshot (tagged: "pre-pull-2024-01-15")
  → Rust: git fetch + merge
  → If conflict: show conflict UI, offer rollback
  → If success: show "Pull complete, X files updated"
  → If failure: auto-rollback to snapshot, show error
```

### Confirmation Dialogs (Frontend)
- Force push: "This will overwrite remote history. Are you sure?"
- Delete remote branch: "This will delete '{branch}' from GitHub. Continue?"
- Merge PR: "Merge '{title}' into {base}? Method: {squash/merge/rebase}"

---

## Cargo.toml Additions

```toml
[dependencies]
reqwest = { version = "0.12", features = ["json", "rustls-tls"] }
serde = { version = "1", features = ["derive"] }
serde_json = "1"
tokio = { version = "1", features = ["full"] }
# git2 — already present
# tauri-plugin-store OR keyring for token storage
tauri-plugin-store = "2"
```

---

## Implementation Order

```
Phase 0 → Phase 1 → Phase 2 → Phase 6 → Phase 3 → Phase 4 → Phase 5
  ↑ foundation   ↑ auth      ↑ repos    ↑ safety   ↑ sync    ↑ PRs     ↑ extras
```

Phase 6 (Safety) comes before Phase 3 (Push/Pull) because every sync operation needs the safety layer in place first.

---

## Killer Feature Combo

With GitHub + Snapshots together:

```
Before risky operation → Auto-snapshot
  → GitHub operation fails? → One-click rollback to snapshot
  → GitHub operation succeeds? → Snapshot stays as safety net (auto-cleanup after 24h)
```

This gives users confidence to push, pull, merge, rebase — knowing they can always roll back.

---

## Status Bar Integration

```
[🟢 GitHub: username] [main ↑2 ↓0] [✓ Actions passing]
```

- Green dot = authenticated
- Branch + ahead/behind
- Actions status badge (clickable → opens Actions panel)

---

## Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| Ctrl+Shift+G | Toggle Git Panel (existing) |
| Ctrl+Shift+H | Toggle GitHub Panel (new) |
| Ctrl+Shift+P | Create Pull Request |
| Ctrl+Shift+U | Push to remote |

---

## Notes

- All API calls go through Rust — React never sees the token
- Use `reqwest` with connection pooling for performance
- Rate limit handling: GitHub allows 5000 req/hour with PAT
- Cache repo info, refresh on panel open or manual refresh
- Error types: `AuthError`, `NotFound`, `RateLimit`, `NetworkError`, `GitError`
