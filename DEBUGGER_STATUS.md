# Debugger Integration â€” Status Report

**Date:** 2026-05-27  
**State:** Phases 1â€“5D complete. Phase 5E (semi-autonomous) deferred. Phase 5F (agentic) deferred.  
**TypeScript compilation:** âœ… Zero errors (`tsc --noEmit` passes clean)

---

## 1. What Debugger Code Remains

### Rust Backend (`src-tauri/src/dap_manager.rs`)
- **DAP types:** `DapMessage`, `DapRequest`, `DapResponse`, `DapEvent`, `DebuggerEvent`
- **Session management:** `DebuggerSessions` (Mutex<HashMap>) with `DapSession` struct holding `TokioChild` + `mpsc::Sender`
- **Content-Length framing:** `encode_dap_message()` and `read_dap_message()` â€” proper DAP wire protocol
- **Commands:**
  - `dap_start` â€” spawns adapter process, wires stdin/stdout/stderr async tasks, emits `debugger-event`
  - `dap_send_request` â€” encodes and sends request via channel to adapter stdin
  - `dap_stop` â€” removes session, kills child process (after sending DAP disconnect)
  - `shutdown_all` â€” non-async cleanup for app exit

### Rust Registration (`src-tauri/src/lib.rs`)
- `pub mod dap_manager;`
- `.manage(dap_manager::DebuggerSessions::new())`
- Commands in `invoke_handler`: `dap_start`, `dap_send_request`, `dap_stop`
- `dap_manager::shutdown_all(...)` in `RunEvent::Exit` handler

### Frontend Utilities (`src/utils/tauri.ts`)
- Types: `DapRequest`, `DapResponse`, `DapEvent`, `DapMessage`
- Functions: `dapStart()`, `dapSendRequest()`, `dapStop()` â€” invoke wrappers

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
- **Event listener:** `debugger-event` in the main useEffect â€” handles `stopped`, `continued`, `exited`, `terminated`, `output`, `breakpoint`, `response_stackTrace`, `response_scopes`, `response_variables`, `response_evaluate`
- **Keyboard shortcuts:** F5, Shift+F5, F6, F10, F11, Shift+F11

### Components
- **`src/components/DebuggerPanel.tsx`** â€” Toolbar + Call Stack + Variables + Console tabs with evaluate input
- **`src/components/BreakpointGlyphs.tsx`** â€” Monaco glyph margin decorations (red dots + yellow current line)
- **`src/components/DebugConfigPicker.tsx`** â€” Compact dropdown for selecting debug configurations with Add/Edit actions

### CSS (`src/App.css`)
- `.debug-breakpoint` â€” red circle glyph
- `.debug-current-line` â€” yellow highlight
- `.debugger-panel`, `.debugger-controls`, `.debugger-tabs`, `.debugger-content`
- `.stack-frames-list`, `.variables-list`, `.debug-console`, `.debug-console-input`
- `.debug-config-picker-*` styles for configuration selector

---

## 2. What Was Removed as Duplicate/Orphaned

| Removed | Details |
|---------|---------|
| 6Ã— duplicate `handleToggleBreakpoint` | Identical copies with minor variations (one had `// TODO` instead of actual DAP call) |
| 2Ã— duplicate `sendDapRequest` | Both used `r#type` (Rust syntax) in TypeScript â€” replaced with single clean version using `type` |
| 5Ã— duplicate step handler blocks | `handleDebugContinue/StepOver/StepInto/StepOut/Pause` repeated with each toggle block |
| 3Ã— duplicate `handleDebuggerJumpToSource` | Identical copies |
| 2Ã— duplicate `handleStartDebug` / `handleStopDebug` | One before `showToast` definition (broken reference), one after |
| 2Ã— duplicate `useEffect(() => { tabsRef.current = tabs })` | Exact duplicates |
| 1Ã— duplicate `// Keep tabsRef in sync` comment block | Stale leftover |
| 1Ã— `showToast` ordering issue | Was defined AFTER code that used it â€” reordered correctly |
| 1Ã— `getProjectFilePath` ordering issue | Same â€” moved after `showToast` |
| 1Ã— `registerToastHandler` ordering issue | Same |
| `r#type` in TypeScript | Rust raw identifier syntax leaked into TS `DapRequest` construction â€” replaced with `type` |
| `is: true` typo in BreakpointGlyphs | Was `is: true` instead of `isWholeLine: true` â€” fixed |
| Old broken stdout reader | Used `read_to_string` (reads until EOF) â€” replaced with proper Content-Length parser |
| Old `BufReader`/`BufWriter` ownership issue | Stored stdout/stderr in struct after moving them to async tasks â€” removed, now uses channel pattern |
| `fix-app.cjs` temp script | Used for the surgery, deleted after |

**Total lines removed:** ~280 lines of duplicated/orphaned code from App.tsx

---

## 3. Current Working Commands

### Tauri Commands (Rust â†’ Frontend)
| Command | Status | Notes |
|---------|--------|-------|
| `dap_start` | âœ… Compiles | Spawns adapter, wires I/O, emits events |
| `dap_send_request` | âœ… Compiles | Encodes with Content-Length, sends via channel |
| `dap_stop` | âœ… Compiles | Sends DAP disconnect, waits, then kills process, removes session |

### Frontend Actions
| Action | Status | Trigger |
|--------|--------|---------|
| Start debug | âœ… | Button / F5 (uses selected launch config) |
| Stop debug | âœ… | Button / Shift+F5 (sends disconnect first) |
| Continue | âœ… | Button / F5 (when paused) |
| Pause | âœ… | Button / F6 |
| Step Over | âœ… | Button / F10 |
| Step Into | âœ… | Button / F11 |
| Step Out | âœ… | Button / Shift+F11 |
| Toggle breakpoint | âœ… | Click glyph margin |
| Jump to source | âœ… | Click stack frame |
| Evaluate expression | âœ… | Console input (Enter) - shows response |
| Select debug config | âœ… | Debug Config Picker toolbar button |
| Add debug config | âœ… | "Add Configuration" button in picker |
| Edit launch.json | âœ… | "Edit launch.json" button in picker/sidebar |

### Event Handling
| Event | Status | Action |
|-------|--------|--------|
| `stopped` | âœ… | Sets paused, extracts threadId, fetches stack |
| `continued` | âœ… | Sets running, clears source highlight |
| `exited`/`terminated` | âœ… | Clears all debug state |
| `output` | âœ… | Appends to console output |
| `response_stackTrace` | âœ… | Populates frames, sets source, fetches scopes |
| `response_scopes` | âœ… | Fetches variables for Locals scope |
| `response_variables` | âœ… | Populates variables list |
| `response_evaluate` | âœ… | Shows evaluate result in console |

---

## 4. Phase 4A Implementation Summary

**Status:** âœ… COMPLETE

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
     - Implement proper DAP handshake: initialize â†’ wait for initialized â†’ setBreakpoints â†’ configurationDone â†’ launch/attach
   - Rewrote `handleStopDebug` to send DAP disconnect before force-killing
   - Added `handleAddDebugConfig` and `handleEditLaunchJson` handlers
   - Enhanced `debugger-event` listener to handle `response_evaluate`
   - Updated DebuggerPanel props to pass config system data

2. **`src/components/DebuggerPanel.tsx`**:
   - Added config picker to toolbar (receives `debugConfigs`, `selectedConfigId`, `onSelectConfig`, `onAddConfig`, `onEditConfigs` props)

3. **`src/App.css`**:
   - Added `.debug-config-picker-*` styles for configuration selector

### DAP Handshake Flow (Now Correct):
1. User selects configuration â†’ clicks Start Debugging
2. `dapStart()` spawns adapter from config's `adapterCommand` + `adapterArgs`
3. Sends `initialize` request with capabilities
4. On `initialized` event:
   - Sends `setBreakpoints` for all files with breakpoints
   - Sends `configurationDone`
   - Sends `launch` (or `attach`) with full configuration parameters
5. On stop: sends `disconnect` â†’ waits 500ms â†’ `dapStop()` force kills process

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
| **No adapter bundled** | ðŸ”´ High | No debug adapter binary ships with the app. User must have one installed (e.g., `node-debug2`, `debugpy`, `codelldb`). |
| **`threads` state unused** | ðŸŸ¡ Medium | State exists but never populated from `threads` response. No threads panel in UI. |
| **No disconnect request on stop** | ðŸŸ¡ Low | `dap_stop` kills the process directly instead of sending DAP `disconnect` request first. *(NOTE: Partially addressed - disconnect is now sent before kill)* |
| **Console auto-scroll edge case** | ðŸŸ¢ Low | If user scrolls up manually, new output still forces scroll to bottom. |

---

## 6. Phase 5: AI-Assisted Debugging

### Phase 5A: Context Sanitizer â€” COMPLETE
- **File:** `src/utils/debugSanitizer.ts`
- Strips secrets (API keys, tokens, JWTs, connection strings, private keys) from debug context before AI calls
- Redacts variable values when the variable name suggests sensitivity (password, token, api_key, etc.)
- Sanitizes console output and source code
- Replaces home directory paths with `~` in stack traces

### Phase 5B: "Ask Punam" â€” Explain What Happened â€” COMPLETE
- **File:** `src/components/AiDebugAssistant.tsx`
- "Explain" button visible when debugger is paused
- Collects stack frames, variables, source code (plus/minus 10 lines), console output
- Sanitizes context then sends to configured AI provider
- Shows plain-language explanation in collapsible panel below debug tabs
- Supports multiple queries (timestamped), copy, clear

### Phase 5C: Fix Suggestions â€” COMPLETE
- "Fix it" button sends full file content + debug context to AI
- AI responds with fix blocks containing complete fixed file
- Parsed fix triggers existing `MultiFileDiffBoard` review flow
- User must explicitly accept/reject each change â€” nothing auto-applies
- Falls back to showing analysis text if AI cannot produce parseable fix

### Phase 5D: Smart Debug Guidance â€” COMPLETE
- "Guide me" button asks AI for actionable debugging suggestions
- AI responds with structured JSON suggestions parsed into clickable cards:
  - **Breakpoint** â€” click "Set" to call `handleToggleBreakpoint`
  - **Watch** â€” click "Watch" to evaluate expression via DAP
  - **Inspect** â€” click "Eval" to run expression evaluation
  - **Tip** â€” click "Copy" to copy debugging tip to clipboard
- Graceful fallback if AI does not return valid JSON

### Phase 5E: Semi-Autonomous Debugging â€” DEFERRED
- AI chains actions: fetch variables, evaluate, set breakpoint, continue
- Each AI-initiated action requires explicit user approval
- **Why deferred:** 5B/5C/5D need real-world testing first. The approval UX needs proper design. Value curve flattens â€” 5B-5D covers 90% of developer needs.
- **When to revisit:** After 5B-5D are battle-tested on real debugging sessions.

### Phase 5F: Full Agentic Debugging â€” DEFERRED
- Multi-step autonomous debugging with periodic checkpoints
- Only after 5E is stable and validated
- Requires comprehensive logging, undo capability, kill switch

### Safety Principles (Implemented)
1. **Explicit Consent**: No AI action occurs without user clicking a button
2. **Context Sanitization**: All data stripped of secrets before AI calls
3. **Transparency**: Users see AI responses before any action is taken
4. **Reversibility**: Fix suggestions go through diff review â€” accept/reject per hunk
5. **Read-Only by Default**: Explain and Guide modes never modify files or debug state

---

## 7. Files Touched During Phase 5 Implementation

| File | Changes |
|------|---------|
| `src/utils/debugSanitizer.ts` | **NEW** - Secret/sensitive data stripping for debug context |
| `src/components/AiDebugAssistant.tsx` | **NEW** - AI debug panel with Explain, Guide, Fix buttons |
| `src/components/DebuggerPanel.tsx` | Added AiDebugAssistant integration, new props for AI provider/model/actions |
| `src/App.tsx` | Passes source code context, full file content, AI provider, breakpoint/evaluate/fix callbacks to DebuggerPanel |
| `src/styles/debugger.css` | Added styles for AI debug assistant, suggestion cards, fix button |


---

## 8. Files Touched During Phase 4A Implementation

| File | Changes |
|------|---------|
| `src/App.tsx` | Added debug config state, rewrote handleStartDebug/handleStopDebug for proper DAP handshake, added config management handlers, enhanced event listener, updated DebuggerPanel props |
| `src/utils/debugConfig.ts` | **NEW** - Complete launch configuration system with variable substitution and file I/O |
| `src/components/DebugConfigPicker.tsx` | **NEW** - Configuration selector UI component |
| `src/components/DebuggerPanel.tsx` | Added config picker to toolbar (new props: debugConfigs, selectedConfigId, onSelectConfig, onAddConfig, onEditConfigs) |
| `src/App.css` | Added `.debug-config-picker-*` styles |
| `src/utils/tauri.ts` | Enhanced `dap_stop` to send DAP disconnect before process termination |
| `fix-app.cjs` | Temporary script used for bulk line replacement — **deleted** |

