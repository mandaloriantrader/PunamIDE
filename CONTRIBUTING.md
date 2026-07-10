# Contributing to PunamIDE

Thank you for your interest in contributing. This document covers how to set up the project, coding standards, and the pull request process.

---

## Prerequisites

| Tool | Version |
|---|---|
| Node.js | 20+ |
| Rust | 1.77.2+ |
| Cargo | (comes with Rust) |
| Git | 2.x+ |

Install Rust via [rustup](https://rustup.rs/). Node via [nvm](https://github.com/nvm-sh/nvm) or direct download.

---

## Local Setup

```bash
# 1. Clone the repo
git clone https://github.com/mandaloriantrader/punamIDe-v2.0-full-update.git
cd punamIDe-v2.0-full-update

# 2. Install frontend dependencies
npm install

# 3. Start dev server (Tauri + Vite)
cargo tauri dev

# Or on Windows, double-click autorun.bat
```

The app window opens automatically. Vite HMR keeps the frontend live-reloading.

---

## Project Structure

```
src/           React frontend (TypeScript)
src-tauri/     Rust backend (Tauri)
public/        Static assets, SVG icons, WASM parsers
```

See [README.md](README.md) for the full directory breakdown.

---

## Development Guidelines

### Frontend (TypeScript / React)

- Use **TypeScript strictly** — no `any` unless unavoidable and commented
- Components go in `src/components/`, named in PascalCase
- Services (business logic) go in `src/services/`, no direct Tauri calls from components
- State goes in Zustand stores under `src/store/`
- All Tauri `invoke()` calls should be wrapped in `src/utils/tauri.ts` helpers
- Use `lucide-react` for icons — do not add new icon libraries
- CSS goes in `src/styles/` — one file per feature area, imported via `src/styles/index.css`

### Rust Backend

- New Tauri commands go in the relevant `src-tauri/src/*.rs` module, registered in `lib.rs`
- Use `async` commands with `tokio` — avoid blocking the main thread
- All file paths must be validated through `safety.rs` before use
- Add integration tests for new Rust modules in `src-tauri/src/lib_tests.rs`

### Commit Messages

Use conventional commits:

```
feat: add refactor panel UI
fix: resolve brace mismatch in polish.css
chore: update .gitignore for snapshots
docs: update README with v2.1.2 features
refactor: extract chat context builder to service
test: add property-based tests for stream parser
```

---

## Running Tests

```bash
# Frontend tests (single run)
npm test

# Watch mode
npm run test:watch

# Lint
npm run lint
```

---

## Pull Request Process

1. Fork the repo and create a feature branch from `master`
2. Keep PRs focused — one feature or fix per PR
3. Ensure `npm test` and `npm run lint` pass
4. Write a clear PR description: what changed, why, and how to test it
5. Request review — PRs are merged after at least one approval

---

## Reporting Issues

Open a GitHub issue with:
- PunamIDE version (shown in title bar)
- OS and version
- Steps to reproduce
- Expected vs actual behaviour
- Console errors if applicable (DevTools → Console)

---

## Code of Conduct

Be respectful and constructive. This project follows the standard [Contributor Covenant](https://www.contributor-covenant.org/).
