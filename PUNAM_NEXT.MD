Immediate (next session):

SQLite persistent memory — replace localStorage with real database. This is the #1 thing that makes Punam feel intelligent across sessions.

Context Engine for regular chat — right now only Agent mode uses the optimized sliding window. Regular Ask/Edit/Explain modes still send 24k tokens every time. Wire them to the same engine.

Rust getRelevantContext() unified command — one Rust call that combines TF-IDF + file cache + git recency + open tabs into a single "here's what matters" response.

Short-term (next 2-3 sessions):

Background agent — user keeps coding while Punam works on a task in the background. Shows a small progress indicator in the status bar.

Ollama embeddings — semantic search that actually understands "where is auth handled?" without exact keyword matches.

Git commit/stage/push UI — full git workflow without leaving the IDE. Stage files, write message (AI-generated), commit, push.

Medium-term (v2.5):

Multi-file diff view — when AI proposes changes to 5 files, show all diffs in a tabbed panel (like GitHub PR review).

Project templates — "Create a new FastAPI project with auth, database, and tests" → scaffolds the entire thing.

AI-powered refactoring — select a folder → "refactor this module to use dependency injection" → Punam rewrites the whole module safely.

Debugger integration — set breakpoints, step through code, inspect variables — all within PunamIDE.

Long-term (v3.0 — the vision):

Cloud sync — settings, memories, and project context sync across machines.

Team mode — share an AI session with a teammate. Both see edits in real-time.

Custom model fine-tuning — train a small model on YOUR codebase so completions are project-specific.

Voice coding — "Hey Punam, add error handling to the login function" → she does it.

Self-improving agent — Punam tracks which edits get accepted vs rejected, and adjusts her approach over time.