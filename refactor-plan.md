# PunamIDE v2.0 — Refactor Plan

> **Created:** 2026-06-17
> **Priority:** agentToolLoop.ts first, then AiChat.tsx, then App.tsx
> **Goal:** Split large files into focused modules without changing behavior

---

## Refactor Candidates

| Lines | File | Risk | Priority |
|---|---|---|---|
| 863 | `src/utils/agentToolLoop.ts` | Low | ✅ Do first |
| 2628 | `src/components/AiChat.tsx` | High | Later (UI-coupled) |
| 3243 | `src/App.tsx` | High | Later (root component) |
| 2081 | `src-tauri/src/lib.rs` | Medium | Later (Rust side) |
| 1159 | `src/components/BugHunt.tsx` | Medium | Optional |
| 1111 | `src/components/settings/ArchitectureRulesEditor.tsx` | Medium | Optional |

---

## Phase 1: agentToolLoop.ts (863 lines → ~6 files)

### Current Structure

The file contains 6 distinct responsibilities in one flat file:

```
src/utils/agentToolLoop.ts (863 lines)
├── Shared types + utilities (lines 1–130)
│     - ToolLoopOptions interface
│     - AgentPlan, VerifyResult interfaces
│     - AgentToolLoopCancelled class
│     - throwIfCancelled, isCancellationError
│     - recordLoopMetrics, combineLoopMetrics
│     - ToolObservation interface
│     - formatToolInput, toolCallKey, duplicateToolResult
│     - recordToolObservation
├── Explicit tool shortcut (lines 131–220)
│     - getExplicitToolNames
│     - getFirstQuotedValue, getPathLikeValue, getLineRange
│     - buildExplicitReadOnlyToolCall
│     - truncateForFinalAnswer
├── Final answer synthesis (lines 221–354)
│     - fallbackFinalAnswer
│     - synthesizeFinalAnswer
├── Anthropic tool loop (lines 355–456)
│     - runAnthropicToolLoop
├── JSON fallback tool loop (lines 457–551)
│     - runJsonFallbackToolLoop
├── Gemini tool loop + helpers (lines 552–702)
│     - GeminiPart, GeminiContent, GeminiResponse interfaces
│     - toGeminiFunctionDeclarations
│     - callGeminiWithTools
│     - runGeminiToolLoop
├── Anthropic HTTP call (lines 703–758)
│     - AnthropicMessage, AnthropicResponse interfaces
│     - callAnthropicWithTools
├── Planner (lines 759–832)
│     - generatePlan
├── Verifier (lines 833–880)
│     - detectVerificationCommands
│     - runVerification
└── Main entry point (lines 881–963)
      - runAgentToolLoop
```

### Proposed Split

```
src/utils/
  agentToolLoop.ts          — Entry point + shared types (~150 lines)
  toolLoops/
    anthropicLoop.ts        — runAnthropicToolLoop + callAnthropicWithTools (~140 lines)
    geminiLoop.ts           — runGeminiToolLoop + callGeminiWithTools + types (~190 lines)
    jsonFallbackLoop.ts     — runJsonFallbackToolLoop (~120 lines)
    planner.ts              — generatePlan (~80 lines)
    verifier.ts             — detectVerificationCommands + runVerification (~80 lines)
    shared.ts               — ToolObservation, synthesis, shortcut detection (~130 lines)
```

### What stays in agentToolLoop.ts (entry point)

```typescript
// Imports from split modules
import { runAnthropicToolLoop } from "./toolLoops/anthropicLoop";
import { runGeminiToolLoop } from "./toolLoops/geminiLoop";
import { runJsonFallbackToolLoop } from "./toolLoops/jsonFallbackLoop";
import { generatePlan } from "./toolLoops/planner";
import { runVerification } from "./toolLoops/verifier";
import { buildExplicitReadOnlyToolCall, synthesizeFinalAnswer, ... } from "./toolLoops/shared";

// Types (re-exported)
export interface ToolLoopOptions { ... }
export interface AgentPlan { ... }
export interface VerifyResult { ... }

// Main entry point
export async function runAgentToolLoop(opts: ToolLoopOptions): Promise<void> { ... }
```

### Rules for the split

1. **No behavior changes** — pure extraction, same logic, same flow
2. **Each file has one responsibility** — provider loop, planning, verification
3. **Shared utilities exported from `shared.ts`** — used by all loop implementations
4. **Types stay with their consumers** — Gemini types in geminiLoop, Anthropic types in anthropicLoop
5. **Entry point re-exports public API** — external code only imports from `agentToolLoop.ts`

---

## Phase 2: AiChat.tsx (2628 lines) — Future

### Current Structure (high-level)

```
src/components/AiChat.tsx (2628 lines)
├── Imports (~70 lines)
├── Types + constants (~50 lines)
├── AGENT_MODES array (~30 lines)
├── Component body:
│   ├── State declarations (~40 lines)
│   ├── Custom hooks (sessions, attachments) (~20 lines)
│   ├── Utility functions:
│   │   ├── collectExistingFiles (~30 lines)
│   │   ├── resolveEditsWithPreview (~40 lines)
│   │   ├── handleApplyAcceptedEdits (~15 lines)
│   │   ├── buildProjectContext (~200 lines) ← BIGGEST
│   │   ├── buildMemoryContext (~20 lines)
│   │   ├── buildMcpToolsPrompt (~30 lines)
│   │   └── getRelativePath helpers
│   ├── requestPunam (main chat send) (~400 lines) ← COMPLEX
│   ├── Agent mode handlers (~300 lines)
│   ├── Streaming handlers (~200 lines)
│   ├── Effects (~50 lines)
│   └── JSX render (~800 lines)
```

### Proposed Split (future)

```
src/components/
  AiChat.tsx                    — Slim shell: renders sub-components (~300 lines)
  chat/
    ChatHeader.tsx              — Already extracted ✓
    ChatInputArea.tsx           — Already extracted ✓
    ChatComponents.tsx          — Already extracted ✓
    ChatMessageList.tsx         — NEW: message rendering loop
    EditPreviewPanel.tsx        — Already extracted ✓

src/hooks/
  useChatContext.ts             — NEW: buildProjectContext + context loading
  useChatStreaming.ts           — NEW: streaming state + handlers
  useAgentExecution.ts          — NEW: agent mode start/stop/retry

src/utils/
  chatContextBuilder.ts         — NEW: buildProjectContext logic (extracted from component)
```

### Why this is high-risk

- `requestPunam` references 20+ pieces of component state directly
- Streaming handlers mutate message state with `setMessages(prev => ...)`
- Agent mode handlers reference `agentTask`, `activeTask`, `messages`, `loading`, `input`, etc.
- Extracting hooks requires carefully identifying which state belongs together
- One wrong closure capture = stale state bugs that only manifest at runtime

---

## Phase 3: App.tsx (3243 lines) — Future

### Current Structure

```
src/App.tsx (3243 lines)
├── Imports (~130 lines)
├── State declarations (~200 lines)
├── Keyboard shortcuts (~80 lines)
├── File system effects (~100 lines)
├── Tab management (~150 lines)
├── Split editor logic (~100 lines)
├── Project operations (~200 lines)
├── Theme/settings (~80 lines)
├── Event listeners (~150 lines)
├── JSX layout (~2000+ lines):
│   ├── Sidebar
│   ├── File tree
│   ├── Editor area (tabs + Monaco)
│   ├── Terminal panel
│   ├── Bottom panels
│   └── Right panel (AI Chat)
```

### Proposed Split (future)

```
src/
  App.tsx                       — Layout shell (~400 lines)
  hooks/
    useAppState.ts              — All useState consolidated
    useKeyboardShortcuts.ts     — Keyboard handling
    useFileSystem.ts            — File tree + read/write
    useProjectManager.ts        — Open/close project, recent projects
    useTabManager.ts            — Tab open/close/switch
  layouts/
    MainLayout.tsx              — Grid layout orchestration
    EditorArea.tsx              — Tabs + Monaco + split
    SidebarArea.tsx             — File tree + panels
```

---

## Phase 4: lib.rs (2081 lines) — Future

### Current Structure

```
src-tauri/src/lib.rs (2081 lines)
├── Structs (50 lines)
├── LLM calls: call_gemini, call_openai_compatible (~300 lines)
├── LLM streaming: call_gemini_stream, call_openai_compatible_stream (~200 lines)
├── File watcher (~80 lines)
├── Diff engine (~100 lines)
├── 3-way merge (~100 lines)
├── Context builder (get_relevant_context) — already in index_commands.rs
├── SQLite persistence (~350 lines)
├── Chat sessions DB (~100 lines)
├── System diagnostics (~150 lines)
├── run() with command registration (~200 lines)
```

### Proposed Split

```
src-tauri/src/
  lib.rs                    — run() + shared types only (~200 lines)
  llm_commands.rs           — NEW: call_gemini, call_openai_compatible, streaming
  db_commands.rs            — NEW: SQLite init, maintenance, chat sessions
  diff_commands.rs          — NEW: diff_strings, try_3way_merge
  diagnostics.rs            — NEW: system info, logs, reports
```

---

## Execution Order

1. **agentToolLoop.ts** — safe, self-contained, no UI coupling
2. **AiChat.tsx** — only after app is stable and testable
3. **App.tsx** — last (biggest blast radius)
4. **lib.rs** — independent (Rust side, can happen anytime)

---

## Files Referenced for This Plan

- `src/utils/agentToolLoop.ts` (863 lines) — primary refactor target
- `src/components/AiChat.tsx` (2628 lines) — future target
- `src/App.tsx` (3243 lines) — future target
- `src-tauri/src/lib.rs` (2081 lines) — future target
- `src/components/BugHunt.tsx` (1159 lines) — optional
- `src/components/settings/ArchitectureRulesEditor.tsx` (1111 lines) — optional
- `src/components/TechnicalDebtDashboard.tsx` (1024 lines) — optional
- `src/components/Terminal.tsx` (859 lines) — optional
