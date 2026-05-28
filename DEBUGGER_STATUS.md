# Debugger Integration — Status Report

**Date:** 2026-05-26  
**State:** Phases 1–4A complete. Phase 4B (adapter bundling) not started. Phase 5 (AI debugging) roadmap defined.  
**TypeScript compilation:** ✅ Zero errors (`tsc --noEmit` passes clean)

---

## 1. What Debugger Code Remains

### Rust Backend (`src-tauri/src/dap_manager.rs`)
- **DAP types:** `DapMessage`, `DapRequest`, `DapResponse`, `DapEvent`, `DebuggerEvent`
- **Session management:** `DebuggerSessions` (Mutex<HashMap>) with `DapSession` struct holding `TokioChild` + `mpsc::Sender`
- **Content-Length framing:** `encode_dap_message()` and `read_dap_message()` — proper DAP wire protocol
- **Commands:**
  - `dap_start` — spawns adapter process, wires stdin/stdout/stderr async tasks, emits `debugger-event`
  - `dap_send_request` — encodes and sends request via channel to adapter stdin
  - `dap_stop` — removes session, kills child process (after sending DAP disconnect)
  - `shutdown_all` — non-async cleanup for app exit

### Rust Registration (`src-tauri/src/lib.rs`)
- `pub mod dap_manager;`
- `.manage(dap_manager::DebuggerSessions::new())`
- Commands in `invoke_handler`: `dap_start`, `dap_send_request`, `dap_stop`
- `dap_manager::shutdown_all(...)` in `RunEvent::Exit` handler

### Frontend Utilities (`src/utils/tauri.ts`)
- Types: `DapRequest`, `DapResponse`, `DapEvent`, `DapMessage`
- Functions: `dapStart()`, `dapSendRequest()`, `dapStop()` — invoke wrappers

### Debug Configuration System (`src/utils/debugConfig.ts`)
- **Types:** `DebugLaunchConfig`, `LaunchJsonFile`
- **Default Configs:** Node.js, Python, Generic configurations
- **Variable Substitution:** `${workspaceFolder}`, `${cwd}` resolution
- **File I/O:** Load/save `.punam/launch.json` with directory creation
- **API:** `loadLaunchConfigs()`, `saveLaunchConfigs()`, `createDefaultLaunchJson()`, `resolveConfigVariables()`

### App State & Handlers (`src/App.tsx`)
- **State:** `debugSessionId`, `debugAdapterStatus`, `breakpoints`, `currentThreadId`, `currentStackFrames`, `currentVariables`, `currentSource`, `debugConsoleOutput`, `threads`, `debugLaunchConfigs`, `selectedDebugConfigId`
- **Ref:** `dapRequestSeq`
- **Handlers:** 
  - Core: `sendDapRequest`, `fetchStackFrames`, `fetchScopes`, `fetchVariables`
  - Debug Flow: `handleStartDebug`, `handleStopDebug`, `handleToggleBreakpoint`, `handleDebugContinue`, `handleDebugStepOver`, `handleDebugStepInto`, `handleDebugStepOut`, `handleDebugPause`, `handleDebuggerJumpToSource`
  - Config Management: `handleAddDebugConfig`, `handleEditLaunchJson`, `handleLoadLaunchConfigs`
- **Event listener:** `debugger-event` in the main useEffect — handles `stopped`, `continued`, `exited`, `terminated`, `output`, `breakpoint`, `response_stackTrace`, `response_scopes`, `response_variables`, `response_evaluate`
- **Keyboard shortcuts:** F5, Shift+F5, F6, F10, F11, Shift+F11

### Components
- **`src/components/DebuggerPanel.tsx`** — Toolbar + Call Stack + Variables + Console tabs with evaluate input
- **`src/components/BreakpointGlyphs.tsx`** — Monaco glyph margin decorations (red dots + yellow current line)
- **`src/components/DebugConfigPicker.tsx`** — Compact dropdown for selecting debug configurations with Add/Edit actions

### CSS (`src/App.css`)
- `.debug-breakpoint` — red circle glyph
- `.debug-current-line` — yellow highlight
- `.debugger-panel`, `.debugger-controls`, `.debugger-tabs`, `.debugger-content`
- `.stack-frames-list`, `.variables-list`, `.debug-console`, `.debug-console-input`
- `.debug-config-picker-*` styles for configuration selector

---

## 2. What Was Removed as Duplicate/Orphaned

| Removed | Details |
|---------|---------|
| 6× duplicate `handleToggleBreakpoint` | Identical copies with minor variations (one had `// TODO` instead of actual DAP call) |
| 2× duplicate `sendDapRequest` | Both used `r#type` (Rust syntax) in TypeScript — replaced with single clean version using `type` |
| 5× duplicate step handler blocks | `handleDebugContinue/StepOver/StepInto/StepOut/Pause` repeated with each toggle block |
| 3× duplicate `handleDebuggerJumpToSource` | Identical copies |
| 2× duplicate `handleStartDebug` / `handleStopDebug` | One before `showToast` definition (broken reference), one after |
| 2× duplicate `useEffect(() => { tabsRef.current = tabs })` | Exact duplicates |
| 1× duplicate `// Keep tabsRef in sync` comment block | Stale leftover |
| 1× `showToast` ordering issue | Was defined AFTER code that used it — reordered correctly |
| 1× `getProjectFilePath` ordering issue | Same — moved after `showToast` |
| 1× `registerToastHandler` ordering issue | Same |
| `r#type` in TypeScript | Rust raw identifier syntax leaked into TS `DapRequest` construction — replaced with `type` |
| `is: true` typo in BreakpointGlyphs | Was `is: true` instead of `isWholeLine: true` — fixed |
| Old broken stdout reader | Used `read_to_string` (reads until EOF) — replaced with proper Content-Length parser |
| Old `BufReader`/`BufWriter` ownership issue | Stored stdout/stderr in struct after moving them to async tasks — removed, now uses channel pattern |
| `fix-app.cjs` temp script | Used for the surgery, deleted after |

**Total lines removed:** ~280 lines of duplicated/orphaned code from App.tsx

---

## 3. Current Working Commands

### Tauri Commands (Rust → Frontend)
| Command | Status | Notes |
|---------|--------|-------|
| `dap_start` | ✅ Compiles | Spawns adapter, wires I/O, emits events |
| `dap_send_request` | ✅ Compiles | Encodes with Content-Length, sends via channel |
| `dap_stop` | ✅ Compiles | Sends DAP disconnect, waits, then kills process, removes session |

### Frontend Actions
| Action | Status | Trigger |
|--------|--------|---------|
| Start debug | ✅ | Button / F5 (uses selected launch config) |
| Stop debug | ✅ | Button / Shift+F5 (sends disconnect first) |
| Continue | ✅ | Button / F5 (when paused) |
| Pause | ✅ | Button / F6 |
| Step Over | ✅ | Button / F10 |
| Step Into | ✅ | Button / F11 |
| Step Out | ✅ | Button / Shift+F11 |
| Toggle breakpoint | ✅ | Click glyph margin |
| Jump to source | ✅ | Click stack frame |
| Evaluate expression | ✅ | Console input (Enter) - shows response |
| Select debug config | ✅ | Debug Config Picker toolbar button |
| Add debug config | ✅ | "Add Configuration" button in picker |
| Edit launch.json | ✅ | "Edit launch.json" button in picker/sidebar |

### Event Handling
| Event | Status | Action |
|-------|--------|--------|
| `stopped` | ✅ | Sets paused, extracts threadId, fetches stack |
| `continued` | ✅ | Sets running, clears source highlight |
| `exited`/`terminated` | ✅ | Clears all debug state |
| `output` | ✅ | Appends to console output |
| `response_stackTrace` | ✅ | Populates frames, sets source, fetches scopes |
| `response_scopes` | ✅ | Fetches variables for Locals scope |
| `response_variables` | ✅ | Populates variables list |
| `response_evaluate` | ✅ | Shows evaluate result in console |

---

## 4. Phase 4A Implementation Summary

**Status:** ✅ COMPLETE

### New Files Added:
1. **`src/utils/debugConfig.ts`** - Complete launch configuration system:
   - `DebugLaunchConfig` interface with full DAP config support
   - Variable substitution (`${workspaceFolder}`, `${cwd}`)
   - Default configurations for Node.js and Python
   - JSON persistence to `.punam/launch.json`
   - Config creation/loading/saving API

2. **`src/components/DebugConfigPicker.tsx`** - Configuration selector UI:
   - Compact dropdown with active config display
   - Configuration type badges (node/python/custom)
   - Add Configuration and Edit launch.json actions
   - Outside-click-to-close behavior

### Modified Files:
1. **`src/App.tsx`**:
   - Added `debugLaunchConfigs` state and `selectedDebugConfigId`
   - Added `useEffect` to load launch.json on project open
   - Completely rewrote `handleStartDebug` to:
     - Use selected debug configuration
     - Implement proper DAP handshake: initialize → wait for initialized → setBreakpoints → configurationDone → launch/attach
   - Rewrote `handleStopDebug` to send DAP disconnect before force-killing
   - Added `handleAddDebugConfig` and `handleEditLaunchJson` handlers
   - Enhanced `debugger-event` listener to handle `response_evaluate`
   - Updated DebuggerPanel props to pass config system data

2. **`src/components/DebuggerPanel.tsx`**:
   - Added config picker to toolbar (receives `debugConfigs`, `selectedConfigId`, `onSelectConfig`, `onAddConfig`, `onEditConfigs` props)

3. **`src/App.css`**:
   - Added `.debug-config-picker-*` styles for configuration selector

### DAP Handshake Flow (Now Correct):
1. User selects configuration → clicks Start Debugging
2. `dapStart()` spawns adapter from config's `adapterCommand` + `adapterArgs`
3. Sends `initialize` request with capabilities
4. On `initialized` event:
   - Sends `setBreakpoints` for all files with breakpoints
   - Sends `configurationDone`
   - Sends `launch` (or `attach`) with full configuration parameters
5. On stop: sends `disconnect` → waits 500ms → `dapStop()` force kills process

### Features Enabled:
- Per-project debug configurations via `.punam/launch.json`
- Variable substitution (`${workspaceFolder}`) in config values
- Support for multiple adapter types (node, python, lldb, go, custom)
- Separate adapter args vs program args
- Working directory and environment variable configuration
- Stop on entry, port/host for attach mode
- Launch/attach request differentiation
- Config persistence across sessions
- UI for creating/editing configurations

---

## 5. Current Broken/Incomplete Parts

| Issue | Severity | Details |
|-------|----------|---------|
| **No adapter bundled** | 🔴 High | No debug adapter binary ships with the app. User must have one installed (e.g., `node-debug2`, `debugpy`, `codelldb`). |
| **`threads` state unused** | 🟡 Medium | State exists but never populated from `threads` response. No threads panel in UI. |
| **No disconnect request on stop** | 🟡 Low | `dap_stop` kills the process directly instead of sending DAP `disconnect` request first. *(NOTE: Partially addressed - disconnect is now sent before kill)* |
| **Console auto-scroll edge case** | 🟢 Low | If user scrolls up manually, new output still forces scroll to bottom. |

---

## 6. Phase 5: AI-Assisted Debugging Roadmap

**Status:** ⏳ NOT STARTED

### Overview
Phase 5 introduces AI-powered debugging assistance while maintaining strict user control and safety boundaries. All AI features require explicit user initiation and operate on sanitized debug context.

### Phase 5A: Guardrails
- **Token throttle**: Rate limiting for AI API calls to prevent excessive usage
- **Loop breaker**: Detection and prevention of infinite AI reasoning loops
- **Debug context sanitizer**: Automatic removal of sensitive data before AI processing
- **Secret/env stripping**: Removal of API keys, passwords, and environment variables
- **No automatic AI calls**: All AI features require explicit user action

### Phase 5B: Manual “Ask Punam” button
- User clicks when debugger pauses
- AI receives sanitized stack trace + variables + current source
- AI explains what likely happened (root cause hypothesis)
- Response appears in debug console or dedicated AI panel

### Phase 5C: Fix suggestions
- AI suggests code change to fix identified issue
- Presents as diff review (no auto-apply)
- User must explicitly accept/reject each suggestion
- Includes explanation of why the fix addresses the issue

### Phase 5D: Smart debug assistant
- Explain stack trace in plain language
- Suggest next breakpoint location based on code flow
- Recommend variables to inspect for better understanding
- Suggest reproduction steps for intermittent issues

### Phase 5E: Semi-autonomous debugging
- AI can request additional stack frames or variable inspections
- AI can suggest temporary breakpoints for hypothesis testing
- All AI-initiated actions require explicit user approval
- Maintains human-in-the-loop for all decisions

### Phase 5F: Full agentic debugging
- Only enabled after all previous phases are stable and validated
- AI can execute multi-step debugging sequences with supervision
- Still requires periodic user checkpoints and approvals
- Comprehensive logging of all AI actions for auditability

### Safety Principles
1. **Explicit Consent**: No AI action occurs without user initiation or approval
2. **Context Sanitization**: All data sent to AI is stripped of secrets and sensitive information
3. **Transparency**: Users see exactly what data is sent to AI and what actions AI proposes
4. **Reversibility**: All AI-suggested changes can be reviewed before application
5. **Progressive Disclosure**: Advanced features unlocked only after foundational stability

This phase will be implemented only after Phase 4 (adapter bundling and immediate improvements) reaches stability.

---

## 7. Files Touched During Phase 4A Implementation

| File | Changes |
|------|---------|
| `src/App.tsx` | Added debug config state, rewrote handleStartDebug/handleStopDebug for proper DAP handshake, added config management handlers, enhanced event listener, updated DebuggerPanel props |
| `src/utils/debugConfig.ts` | **NEW** - Complete launch configuration system with variable substitution and file I/O |
| `src/components/DebugConfigPicker.tsx` | **NEW** - Configuration selector UI component |
| `src/components/DebuggerPanel.tsx` | Added config picker to toolbar (new props: debugConfigs, selectedConfigId, onSelectConfig, onAddConfig, onEditConfigs) |
| `src/App.css` | Added `.debug-config-picker-*` styles |
| `src/utils/tauri.ts` | Enhanced `dap_stop` to send DAP disconnect before process termination |
| `fix-app.cjs` | Temporary script used for bulk line replacement — **deleted** |
