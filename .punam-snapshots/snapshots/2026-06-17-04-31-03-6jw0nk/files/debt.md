# Technical Debt System v2 — Status Report

## What Was Done

### Phase 1 — Foundation ✅ COMPLETE
- SHA-256 content hashing (replaces old djb2 hash)
- Persistent cache via `@tauri-apps/plugin-store` ("punamide-debt-cache.json")
- Small-file guards: files <50 LOC never Critical, <100 LOC get reduced weighting
- Utility/config/constants file detection — lower debt penalties
- Discovery metrics: discovered / analyzed / skipped / failed / fromCache
- Absolute project-relative paths stored (not bare filenames)
- Configurable file/depth limits (passed in, not hard-coded)
- Full recursive workspace scan (no depth=3 or 200-file limits)

### Phase 2 — AST Engine ⚠️ CODE COMPLETE, RUNTIME UNVERIFIED
- `ASTEngine.ts` created — singleton that manages Tree-sitter WASM loading
- `ASTMetricsExtractor.ts` created — pure AST walker for all metrics
- `web-tree-sitter`, `tree-sitter-typescript`, `tree-sitter-javascript` installed
- WASM files copied to `public/` folder (tree-sitter.wasm, tree-sitter-typescript.wasm, tree-sitter-tsx.wasm, tree-sitter-javascript.wasm)
- Dynamic import pattern used (graceful fallback if WASM fails to load)
- **UNVERIFIED**: Tree-sitter WASM may not actually load at runtime in Tauri's webview. System silently falls back to regex analysis. Needs console debugging.

### Phase 3 — Real Metrics Wired Into Scoring ✅ COMPLETE
- `computeFileScore()` accepts optional `astMetrics` — AST penalties baked into score
- Cyclomatic complexity bands: 1-10 Good, 11-20 Moderate, 21-30 High, 30+ Critical
- Nesting depth bands: 1-3 Good, 4-5 Warning, 6+ Refactor Candidate
- God function detection (>150 lines)
- God class detection (>20 methods)
- Excessive parameters detection (>5)
- `detectPrimaryIssue()` is AST-aware — prioritizes complexity/nesting/god issues
- `generateRecommendation()` produces specific data-driven advice with counts
- `HotspotASTDetail` interface for dashboard display
- Per-function nesting measurement (not leaf-node average)

### Phase 4 — Dependency Graph Engine ✅ CODE COMPLETE, WIRED
- `DependencyGraphEngine.ts` created
- Parses import/export statements from AST (or falls back gracefully)
- Builds adjacency graph (who imports whom)
- Circular dependency detection (DFS with back-edge detection)
- Hub file detection (statistical threshold: mean + 2*stddev or >10 dependents)
- Per-file coupling scores (0-100)
- Module-level coupling aggregation
- Wired into `handleAnalyze()` in dashboard
- Wired into `RefactorPlanner.generatePlan()` — passes real circular deps and hub files

### Phase 5 — Dead Code Analysis ✅ CODE COMPLETE, WIRED
- `DeadCodeAnalyzer.ts` created
- Unused exports detection (exported but never imported)
- Unused imports detection (imported but never referenced in file body)
- Unused declarations detection (not exported, not referenced locally)
- Conservative approach — skips entry points, test files, barrel files, framework exports
- Wired into `handleAnalyze()` in dashboard
- "Safe Cleanup Candidates" section in UI

### Phase 6 — Refactor Planning Engine ✅ COMPLETE
- 4 categories: Quick Wins, Major Refactors, Maintenance, Architectural Issues
- Effort labels: <1 hour, 1-4 hours, 4-8 hours, Multi-day
- Impact/effort/risk scores for each item
- "Why flagged" and "Expected payoff" fields
- Dependency graph data (circular deps, hub files) fed into architectural issues
- All Phase 3 issue types covered in effort/impact tables

### Phase 7 — Dashboard ✅ MOSTLY COMPLETE
- Overall debt score with category badge and trend
- Discovery metrics (discovered/analyzed/skipped/failed/cached)
- Module breakdown with per-module scores
- Trend history
- Refactor queue with 4 categories and expandable cards
- AST detail panel in expanded cards (complexity band, nesting, god counts)
- Dependency Graph section (stats grid, circular deps list, hub files list)
- Dead Code "Safe Cleanup Candidates" section (unused exports/imports/declarations)
- Interactive dependency graph visualization (`DependencyGraphView.tsx` — canvas-based, force-directed)

### Accuracy Fixes Applied ✅
- Fix #1: Removed optional_chain, logical_expression, else_clause, binary_expression, type_predicate from complexity nodes
- Fix #2: Replaced leaf-node nesting algorithm with per-function nesting measurement
- Fix #3: Renamed `duplicationScore` → `sizeRiskScore` across all files
- Fix #4: Reduced clean-file bonus from +5 to +2
- Fix #5: Two-level module grouping (services/debt instead of just services)
- TypeScript error: Moved `interface FunctionInfo` outside class body

### Build/Config Changes
- `vite.config.ts` updated: optimizeDeps.exclude for web-tree-sitter, worker format 'es', WASM asset routing
- Packages installed: web-tree-sitter, tree-sitter-typescript, tree-sitter-javascript

---

## Files Modified/Created

### src/services/technicalDebt/
| File | Status |
|------|--------|
| ASTEngine.ts | NEW — Phase 2 |
| ASTMetricsExtractor.ts | NEW — Phase 2 + fixes |
| DebtAnalyzer.ts | REPLACED — Phase 3 + fixes |
| DebtScorer.ts | REPLACED — Phase 3 + fixes |
| RefactorPlanner.ts | REPLACED — Phase 3 |
| DependencyGraphEngine.ts | NEW — Phase 4 |
| DeadCodeAnalyzer.ts | NEW — Phase 5 |

### src/workers/
| File | Status |
|------|--------|
| debt-analyzer.worker.ts | REPLACED — Phase 2 + fix #3 |

### src/components/
| File | Status |
|------|--------|
| TechnicalDebtDashboard.tsx | REPLACED — Phase 3/7 |
| DependencyGraphView.tsx | NEW — Phase 7 |

### Root
| File | Status |
|------|--------|
| vite.config.ts | MODIFIED — WASM/worker config |
| public/tree-sitter.wasm | NEW — copied from node_modules |
| public/tree-sitter-typescript.wasm | NEW — copied from node_modules |
| public/tree-sitter-tsx.wasm | NEW — copied from node_modules |
| public/tree-sitter-javascript.wasm | NEW — copied from node_modules |

---

## What's NOT Working / Unverified

1. **Tree-sitter WASM runtime loading** — The dynamic `import('web-tree-sitter')` may fail silently in Tauri's webview. The system falls back to regex, so it doesn't crash, but AST analysis isn't actually running.

2. **Dependency Graph + Dead Code sections not visible** — They only appear when analyzing a project with multiple interconnected files. Single-file projects won't trigger them.

3. **Interactive graph visualization** — Created but untested with real data (needs a project with enough import connections).

---

## TODO — Next Session

### Priority 1: Verify Tree-sitter WASM Loading
- [ ] Open browser console in Tauri dev mode
- [ ] Click "Analyze Debt" and check for WASM loading errors
- [ ] If WASM fails: check Tauri CSP settings in `tauri.conf.json`
- [ ] If path issue: adjust `TREE_SITTER_WASM_URL` to use absolute path or Tauri asset protocol
- [ ] Verify `astMetrics` field is populated (not null) on analyzed files
- [ ] If needed, add `wasm-unsafe-eval` to CSP in tauri.conf.json

### Priority 2: Test With Large Project
- [ ] Open PunamIDE's own source in PunamIDE
- [ ] Run "Analyze Debt" on 200+ TS files
- [ ] Verify Dependency Graph section appears
- [ ] Verify Dead Code section appears
- [ ] Verify interactive graph renders with nodes and edges
- [ ] Check performance (should complete in <10s for 500 files)

### Priority 3: Worker AST Integration
- [ ] Verify the worker (`debt-analyzer.worker.ts`) can load Tree-sitter WASM
- [ ] Workers have different WASM loading constraints than main thread
- [ ] May need to pass WASM URL via postMessage or use importScripts pattern
- [ ] Confirm worker returns `astMetrics` populated (not null) in results

### Priority 4: Dashboard Polish
- [ ] Update header from "Phase 1" to "Phase 3" or remove phase label
- [ ] Add loading indicator during dependency graph analysis (it's slower than basic analysis)
- [ ] Add "AST Active" / "Regex Fallback" indicator so user knows which mode is running
- [ ] Test graph visualization zoom/pan if needed

### Priority 5: Future Phases (Not Started)
- [ ] Python/Rust/Go grammar support (add WASM files + extend ASTEngine language map)
- [ ] Real duplication detection (AST-based, replace sizeRiskScore with actual duplicate block finder)
- [ ] Dependency graph interactive features (zoom, pan, filter by module)
- [ ] Export debt report as JSON/PDF
- [ ] Historical trend persistence across sessions (store trend data in plugin-store)
