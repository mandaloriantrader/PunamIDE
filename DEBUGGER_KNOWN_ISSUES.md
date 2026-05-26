# Debugger — Known Issues & Testing Notes

**Date:** 2026-05-26  
**Phase:** Stabilization (post Phase 4)  
**Build:** ✅ Clean (`tsc --noEmit` = 0 errors, `vite build` = success)

---

## Adapter Requirements

The debugger does NOT bundle any debug adapters. Users must install them separately:

| Adapter | Install Command | Speaks DAP? | Notes |
|---------|----------------|-------------|-------|
| **debugpy** (Python) | `pip install debugpy` | ✅ Yes, natively | Most reliable. `python -m debugpy.adapter` starts DAP server on stdin/stdout. |
| **js-debug-adapter** (Node) | `npm i -g @vscode/js-debug` | ✅ Yes | VS Code's adapter. May need manual PATH setup. |
| **dlv** (Go) | `go install github.com/go-delve/delve/cmd/dlv@latest` | ✅ Yes (`dlv dap`) | Requires Go toolchain. |
| **codelldb** (Rust/C++) | Download from GitHub releases | ✅ Yes | Binary, no package manager install. |

---

## Known Issues

### 🔴 Critical

| # | Issue | Details | Workaround |
|---|-------|---------|------------|
| 1 | **Node `--inspect-brk` is NOT DAP** | The `node-inspect` config type uses Node's built-in inspector which speaks Chrome DevTools Protocol, not DAP. The Rust backend expects DAP framing. | Use `js-debug-adapter` config type instead. |
| 2 | **Adapter not found = silent failure** | If the adapter binary isn't on PATH, `dap_start` fails in Rust but the error message may be generic. | Added: error detection for ENOENT/spawn failures with helpful toast. Check debug console for `[PunamIDE] ✗ Adapter not found` messages. |
| 3 | **No initialize timeout recovery** | If adapter starts but never sends `initialized` (hangs), the UI stays in "running" state forever. | Added: 10-second timeout warning. User must manually stop. |

### 🟡 Medium

| # | Issue | Details | Workaround |
|---|-------|---------|------------|
| 4 | **Attach mode: no connection retry** | If the target process isn't listening yet when attach is sent, it fails immediately. No retry logic. | Start the target process first, then attach. |
| 5 | **Breakpoints not re-verified** | After `setBreakpoints` response, we don't update the UI to show which breakpoints were actually verified by the adapter. Unverified breakpoints still show as red dots. | Breakpoints are still sent correctly; visual feedback is just missing. |
| 6 | **Single scope only** | Only fetches variables from the first/Locals scope. Global, closure, and other scopes are ignored. | Variables from other scopes won't appear in the panel. |
| 7 | **No threads panel** | `threads` state exists but is never populated. Multi-threaded programs show only thread 1. | Single-thread debugging works fine. |
| 8 | **Orphan process on crash** | If PunamIDE crashes or is force-closed during a debug session, the adapter process may remain running. | `shutdown_all` handles graceful exit. Force-close may leave orphans. Kill manually via Task Manager. |
| 9 | **`disconnect` timeout not enforced** | `handleStopDebug` sends disconnect then waits 500ms before force-kill. If adapter is stuck, the 500ms may not be enough. | The force-kill at 500ms should handle most cases. |

### 🟢 Low

| # | Issue | Details |
|---|-------|---------|
| 10 | **Console auto-scroll** | New output always scrolls to bottom even if user scrolled up to read earlier output. |
| 11 | **No launch.json schema validation** | Invalid JSON or missing fields only fail at runtime, not in the editor. |
| 12 | **Variable expansion limited** | Complex objects show their string representation. No tree-expand for nested objects/arrays. |
| 13 | **No conditional breakpoints** | Only line breakpoints supported. No condition, hit count, or logpoint support. |
| 14 | **No watch expressions** | The evaluate input works but there's no persistent watch panel. |
| 15 | **`${workspaceFolderBasename}` in Rust config** | Used for the binary name but may not match the actual Cargo binary name if it differs from the folder name. |

---

## Error Handling Added (Stabilization Phase)

### Startup Errors
- **Adapter not found:** Detects ENOENT/spawn errors → shows "adapter not found, check PATH" toast + console message
- **Permission denied:** Detects EACCES → shows permission error
- **Port in use:** Detects EADDRINUSE → shows port conflict message
- **Invalid config:** Validates `adapterCommand`, `program` (launch), `port` (attach) before attempting start

### Runtime Errors
- **Failed DAP responses:** Generic handler catches any `response_*` with `success: false` → logs to console + shows error
- **Adapter crash:** stderr listener captures adapter output → shows in debug console as `[adapter]` prefix
- **Initialize timeout:** 10-second timer warns if adapter doesn't respond
- **Launch/attach failure:** Specific handler resets state and shows error toast

### Logging
- All DAP events logged to browser console with `[DEBUG]` prefix
- Adapter stderr captured and shown in debug console
- Handshake steps logged: "Adapter initialized", "Sent N breakpoints", "Launching: program"
- Unhandled events logged for debugging

---

## Testing Checklist

### Python (debugpy) — Recommended First Test

```bash
# Install
pip install debugpy

# Test file: test_debug.py
import debugpy
x = 1
y = 2
z = x + y  # Set breakpoint here
print(z)
```

**launch.json config:**
```json
{
  "id": "python-launch",
  "name": "Python: Launch File",
  "type": "python",
  "request": "launch",
  "adapterCommand": "python",
  "adapterArgs": ["-m", "debugpy.adapter"],
  "program": "${workspaceFolder}/test_debug.py",
  "cwd": "${workspaceFolder}",
  "stopOnEntry": false
}
```

**Expected behavior:**
1. Click Start Debugging → adapter spawns
2. Console shows: `[PunamIDE] Starting...` → `Adapter ready` → `Launching...` → `✓ Launched`
3. Set breakpoint on `z = x + y` → red dot appears
4. Program pauses at breakpoint → yellow line highlight
5. Variables panel shows: `x = 1`, `y = 2`
6. Call stack shows current frame
7. Step Over (F10) → moves to `print(z)`, variables show `z = 3`
8. Continue (F5) → program finishes, console shows exit code

### Python (debugpy) — Attach Mode

```bash
# Start target with debugpy listening
python -m debugpy --listen 5678 --wait-for-client test_debug.py
```

**launch.json config:**
```json
{
  "id": "python-attach",
  "name": "Python: Attach (port 5678)",
  "type": "python",
  "request": "attach",
  "adapterCommand": "python",
  "adapterArgs": ["-m", "debugpy.adapter"],
  "host": "127.0.0.1",
  "port": 5678
}
```

### Node.js (js-debug-adapter)

```bash
# Install
npm install -g @vscode/js-debug
# or find js-debug-adapter in VS Code extensions
```

**launch.json config:**
```json
{
  "id": "node-launch",
  "name": "Node.js: Launch",
  "type": "node",
  "request": "launch",
  "adapterCommand": "js-debug-adapter",
  "adapterArgs": [],
  "program": "${workspaceFolder}/index.js",
  "cwd": "${workspaceFolder}",
  "stopOnEntry": false
}
```

### Node.js — Attach Mode

```bash
# Start node with inspect
node --inspect=9229 index.js
```

**launch.json config:**
```json
{
  "id": "node-attach",
  "name": "Node.js: Attach (9229)",
  "type": "node",
  "request": "attach",
  "adapterCommand": "js-debug-adapter",
  "adapterArgs": [],
  "host": "127.0.0.1",
  "port": 9229
}
```

---

## Verification Matrix

| Feature | Python | Node | Go | Rust |
|---------|--------|------|-----|------|
| Adapter spawns | ⬜ | ⬜ | ⬜ | ⬜ |
| Initialize handshake | ⬜ | ⬜ | ⬜ | ⬜ |
| Launch succeeds | ⬜ | ⬜ | ⬜ | ⬜ |
| Breakpoint hits | ⬜ | ⬜ | ⬜ | ⬜ |
| Stack frames show | ⬜ | ⬜ | ⬜ | ⬜ |
| Variables populate | ⬜ | ⬜ | ⬜ | ⬜ |
| Step Over works | ⬜ | ⬜ | ⬜ | ⬜ |
| Step Into works | ⬜ | ⬜ | ⬜ | ⬜ |
| Step Out works | ⬜ | ⬜ | ⬜ | ⬜ |
| Continue works | ⬜ | ⬜ | ⬜ | ⬜ |
| Pause works | ⬜ | ⬜ | ⬜ | ⬜ |
| Attach mode | ⬜ | ⬜ | ⬜ | ⬜ |
| Disconnect clean | ⬜ | ⬜ | ⬜ | ⬜ |
| No orphan process | ⬜ | ⬜ | ⬜ | ⬜ |
| Error on missing adapter | ⬜ | ⬜ | ⬜ | ⬜ |

Legend: ⬜ = Not tested, ✅ = Pass, ❌ = Fail

---

## Files Modified in Stabilization Phase

| File | Changes |
|------|---------|
| `src/App.tsx` | Enhanced `handleStartDebug` with config validation, adapter-not-found detection, port-busy detection, 10s init timeout. Enhanced event handler with structured logging, stderr listener, error response handling, exit code display. |
| `DEBUGGER_KNOWN_ISSUES.md` | **NEW** — This file |
