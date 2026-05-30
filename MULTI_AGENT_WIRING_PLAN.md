# Multi-Agent Full Wiring Plan

## Architecture: Modular (Not Monolithic)

The multi-agent system is properly modular — it lives in its own dedicated directory with clean separation of concerns:

```
src/services/
├── agent/                          ← MULTI-AGENT MODULE (4 core + 2 utility files)
│   ├── AgentOrchestrator.ts        — agent lifecycle, file locks, permissions, messaging
│   ├── TaskScheduler.ts            — priority queue, dependency ordering, concurrency limits
│   ├── ConflictResolver.ts         — file-level mutex, edit queuing, overlap detection
│   ├── AgentCoordinator.ts         — shared context bus, workflow phases, prompt templates
│   ├── contextBuilder.ts           — context assembly utility
│   └── differ.ts                   — diff utility
│
├── backgroundAgentExecutor.ts      ← CONSUMER (sits OUTSIDE the module — never imports it)
├── ai/
├── architecture/
├── security/
├── memory/
└── ... (other service modules)

src/components/
├── AiChat.tsx                      ← CONSUMER (foreground agent — never imports the module)
├── MultiAgentDashboard.tsx         ← UI (imports the module but has nothing to display)
└── ...

src/store/
├── backgroundAgentStore.ts         ← STATE (Zustand store — independent of orchestrator)
└── ...
```

**Key insight:** The module itself is well-designed and self-contained. The problem is purely that the two consumers (`backgroundAgentExecutor.ts` and `AiChat.tsx`) were built independently and never connected to the `agent/` module. The wiring plan below does NOT restructure anything — it only adds import lines and function calls from the existing module into the consumers that currently bypass it.

---

## Problem Statement

The multi-agent infrastructure (AgentOrchestrator, TaskScheduler, ConflictResolver, AgentCoordinator) is fully designed but **completely disconnected** from actual execution paths. Both the foreground agent (AiChat.tsx) and background agent (backgroundAgentExecutor.ts) bypass all safety layers and write files directly.

### Confirmed Issues

| # | Issue | Severity | Evidence |
|---|-------|----------|----------|
| 1 | Orchestrator/guardrails never invoked during real execution | CRITICAL | No import of AgentOrchestrator in AiChat.tsx or backgroundAgentExecutor.ts |
| 2 | Foreground + background can overwrite same file simultaneously | HIGH | No shared lock between the two execution paths |
| 3 | ConflictResolver releases lock immediately after acquiring (bug) | HIGH | Line 79 in ConflictResolver.ts calls `releaseFileLock` right after `acquireFileLock` |
| 4 | No completion detection — agent loops and re-applies same files | HIGH | Screenshot: tic-tac-toe created 3 times, edited twice identically |
| 5 | `autoApply: true` hardcoded — no human-in-the-loop gate | HIGH | AiChat.tsx line 1470: `autoApply: true` |
| 6 | No production code ever calls `spawnAgent()` | MEDIUM | Only called in integration test |
| 7 | Single `onChange` callback — multiple subscribers clobber each other | LOW | AgentOrchestrator.ts uses single callback, not array |
| 8 | No timeout on background API calls — potential hang | LOW | `executeOneStep` has no AbortController or timeout |

---

## Execution Plan

We proceed in **5 stages**, each building on the previous. Each stage is independently testable — you can verify it works before moving to the next.

---

## Stage 1: Fix the ConflictResolver Lock Bug

**Issue fixed:** #3  
**Files touched:** `src/services/agent/ConflictResolver.ts`  
**Size:** Tiny (5 min)

### What's wrong

In `attemptEdit()`, the lock is acquired and immediately released on the same call. By the time the agent actually writes the file, the lock is gone.

### What to do

Change `attemptEdit()` so it **holds** the lock on success (does NOT release). The caller is responsible for calling `releaseAndFlush()` after the write completes.

### Exact change in `ConflictResolver.ts`

**FIND this block (lines 72–84):**
```typescript
    // Try to acquire file lock (Layer 1)
    const locked = this.orchestrator.acquireFileLock(agentId, file);
    if (!locked) {
      const owner = this.orchestrator.getFileLockOwner(file);
      // Queue the edit
      if (!this.pendingEdits.has(file)) {
        this.pendingEdits.set(file, []);
      }
      this.pendingEdits.get(file)!.push({
        agentId,
        file,
        proposedContent,
        timestamp: Date.now(),
      });

      return {
        file,
        hasConflict: true,
        resolution: "queued",
        message: `File locked by agent "${owner}". Edit queued for processing.`,
      };
    }

    this.orchestrator.releaseFileLock(agentId, file);
    return {
      file,
      hasConflict: false,
      resolution: "no_conflict",
      message: "File lock acquired — agent may proceed.",
    };
```

**REPLACE WITH:**
```typescript
    // Try to acquire file lock (Layer 1)
    const locked = this.orchestrator.acquireFileLock(agentId, file);
    if (!locked) {
      const owner = this.orchestrator.getFileLockOwner(file);
      // Queue the edit
      if (!this.pendingEdits.has(file)) {
        this.pendingEdits.set(file, []);
      }
      this.pendingEdits.get(file)!.push({
        agentId,
        file,
        proposedContent,
        timestamp: Date.now(),
      });

      return {
        file,
        hasConflict: true,
        resolution: "queued",
        message: `File locked by agent "${owner}". Edit queued for processing.`,
      };
    }

    // Lock is HELD — caller must call releaseAndFlush() after write completes.
    // Do NOT release here.
    return {
      file,
      hasConflict: false,
      resolution: "no_conflict",
      message: "File lock acquired and held — agent may proceed. Call releaseAndFlush() after write.",
    };
```

### How to verify

Run the integration test: `npx tsx src/__tests__/multi-agent.integration.test.ts`  
After acquiring a lock via `attemptEdit`, check that `orchestrator.isFileLocked(file)` returns `true`.

---

## Stage 2: Register Agents with the Orchestrator

**Issues fixed:** #1, #6  
**Files touched:** `src/services/backgroundAgentExecutor.ts`, `src/components/AiChat.tsx`  
**Size:** Small (15 min)

### Goal

Every time an agent starts (foreground or background), it registers with the orchestrator via `spawnAgent()`. When it stops, it calls `removeAgent()`. This makes agents visible to each other and to the dashboard.

### 2A. Background Agent Executor

**At the top of `backgroundAgentExecutor.ts`, add this import:**
```typescript
import { getAgentOrchestrator } from "./agent/AgentOrchestrator";
import type { AgentConfig } from "./agent/AgentOrchestrator";
```

**Inside `startBackgroundExecution()`, right after `executorCancelled = false;` (line 36), add:**
```typescript
  // Register this agent with the orchestrator
  const orchestrator = getAgentOrchestrator();
  const bgAgentId = `bg-agent-${Date.now()}`;
  const provider = config.aiProviders.find(p => p.apiKey && p.models.some(m => m.enabled));
  const model = provider?.models.find(m => m.enabled);
  
  try {
    orchestrator.spawnAgent({
      id: bgAgentId,
      type: "implementation",
      provider: provider?.name || "unknown",
      model: model?.id || "unknown",
      apiKey: "redacted", // Don't store real key in orchestrator state
    });
  } catch (err) {
    console.warn("[BG-Agent] Failed to register with orchestrator:", err);
  }
```

**In the `finally` block at the end of `startBackgroundExecution()`, add before `executorRunning = false;`:**
```typescript
    // Unregister from orchestrator
    try {
      orchestrator.removeAgent(bgAgentId);
    } catch { /* ignore */ }
```

### 2B. Foreground Agent (AiChat.tsx)

**At the top of AiChat.tsx, add this import (near the other agent imports):**
```typescript
import { getAgentOrchestrator } from "../services/agent/AgentOrchestrator";
```

**In `startAgentTask()`, after `setAgentTask({...})`, add:**
```typescript
    // Register foreground agent with orchestrator
    try {
      const provider = aiProviders.find(p => p.apiKey && p.models.some(m => m.enabled));
      const model = provider?.models.find(m => m.enabled);
      getAgentOrchestrator().spawnAgent({
        id: "foreground-agent",
        type: "implementation",
        provider: provider?.name || "unknown",
        model: model?.id || "unknown",
        apiKey: "redacted",
      });
    } catch { /* agent may already exist */ }
```

**In `stopAgent()`, add before `setAgentTask(null)`:**
```typescript
    // Unregister from orchestrator
    try {
      getAgentOrchestrator().removeAgent("foreground-agent");
    } catch { /* ignore */ }
```

**Also in `advanceSubtask()`, inside the "All subtasks done" branch (where `step: "completed"` is set), add:**
```typescript
        try { getAgentOrchestrator().removeAgent("foreground-agent"); } catch {}
```

### How to verify

Open the Multi-Agent Dashboard panel. Start a foreground agent task → you should see "foreground-agent" appear with status "idle". Send to background → you should see a `bg-agent-*` entry appear. When tasks complete, entries disappear.

---

## Stage 3: Route All File Writes Through ConflictResolver

**Issues fixed:** #2, #4 (partial)  
**Files touched:** `src/services/backgroundAgentExecutor.ts`, `src/components/AiChat.tsx`  
**Size:** Medium (30 min)

### Goal

No direct `writeFile()` calls from agents. Every write goes through `ConflictResolver.attemptEdit()` → write → `releaseAndFlush()`.

### 3A. Background Agent Executor

**Add import at top of `backgroundAgentExecutor.ts`:**
```typescript
import { getConflictResolver } from "./agent/ConflictResolver";
```

**Replace the entire "Step 2: Apply file changes" section (the `if (result.fileChanges...)` block) with:**
```typescript
      // Step 2: Apply file changes (through ConflictResolver)
      if (result.fileChanges && result.fileChanges.length > 0) {
        // Auto-snapshot before AI agent edits (Ghost Restore safety net)
        try {
          const { invoke } = await import("@tauri-apps/api/core");
          await invoke("create_snapshot", {
            projectRoot: projectPath,
            name: `pre-agent-edit-${Date.now()}`,
            reason: "before-ai-edit",
          });
        } catch (err) {
          console.warn("[BG-Agent] Auto-snapshot failed:", err);
        }

        const resolver = getConflictResolver();

        for (const change of result.fileChanges) {
          if (executorCancelled) break;

          const fullPath = buildFullPath(projectPath, change.path);
          console.log("[BG-Agent] Attempting file write:", { path: change.path, fullPath, isNew: change.isNew });

          // Check open tabs conflict
          const isOpenInEditor = openTabPaths.some(
            (tabPath) => normalizePath(tabPath) === normalizePath(fullPath)
          );

          // Check via ConflictResolver (permission + lock)
          const conflictResult = resolver.attemptEdit(bgAgentId, change.path, change.content);

          store.addFileChange({
            path: change.path,
            content: change.content,
            isNew: change.isNew,
            applied: false,
            conflicting: conflictResult.hasConflict || isOpenInEditor,
          });

          if (conflictResult.hasConflict) {
            store.addLog("verifying", `Blocked: ${change.path} — ${conflictResult.message}`);
            continue;
          }

          if (isOpenInEditor) {
            store.addLog("verifying", `Conflict: ${change.path} is open in editor — skipped`);
            // Release the lock since we're not writing
            resolver.releaseAndFlush(bgAgentId, change.path);
            continue;
          }

          // Write the file
          try {
            await writeFile(fullPath, change.content);
            store.markFileApplied(change.path);
            store.addLog("verifying", `Applied: ${change.path}`);
            console.log("[BG-Agent] File written successfully:", fullPath);
          } catch (err) {
            console.error("[BG-Agent] File write failed:", fullPath, err);
            store.addLog("failed", `Failed to write ${change.path}: ${err}`);
          } finally {
            // Always release the lock after write attempt
            resolver.releaseAndFlush(bgAgentId, change.path);
          }
        }
      }
```

**Note:** The `bgAgentId` variable must be accessible here. Since we defined it at the top of `startBackgroundExecution()` in Stage 2, it's already in scope.

### 3B. Foreground Agent (AiChat.tsx) — Optional but recommended

The foreground agent uses `onApplyDirect(parsed)` which is a prop passed from the parent. The actual write happens in the parent component. For full protection, you'd wrap `onApplyDirect` to check locks first. A simpler approach:

**In the `useEffect` that handles auto-apply (the one with `agentTask?.autoApply && onApplyDirect`), wrap the apply call:**

**FIND:**
```typescript
      if (!lastMsg.applied && agentTask?.autoApply && onApplyDirect) {
        const msgIdx = messages.length - 1;
        onApplyDirect(lastMsg.parsed).then(() => {
```

**REPLACE WITH:**
```typescript
      if (!lastMsg.applied && agentTask?.autoApply && onApplyDirect) {
        // Check file locks before applying
        const resolver = getConflictResolver();
        const blockedFiles: string[] = [];
        for (const fc of lastMsg.parsed.fileChanges) {
          const result = resolver.attemptEdit("foreground-agent", fc.path, fc.content);
          if (result.hasConflict) {
            blockedFiles.push(`${fc.path}: ${result.message}`);
          }
        }
        if (blockedFiles.length > 0) {
          setMessages(prev => [...prev, {
            role: "assistant",
            content: `⚠️ File lock conflict — cannot apply:\n${blockedFiles.join("\n")}`,
          }]);
          return; // Don't apply
        }

        const msgIdx = messages.length - 1;
        onApplyDirect(lastMsg.parsed).then(() => {
          // Release locks after successful apply
          for (const fc of lastMsg.parsed!.fileChanges) {
            resolver.releaseAndFlush("foreground-agent", fc.path);
          }
```

**Also add the import at the top of AiChat.tsx (if not already added in Stage 2):**
```typescript
import { getConflictResolver } from "../services/agent/ConflictResolver";
```

### How to verify

1. Start a background task that creates files
2. While it's running, try to edit the same file from the foreground agent
3. The foreground agent should see "File locked by bg-agent-*" and refuse to apply
4. After background completes, foreground can apply normally

---

## Stage 4: Add Completion Detection + Deduplication

**Issues fixed:** #4 (fully)  
**Files touched:** `src/services/backgroundAgentExecutor.ts`  
**Size:** Small (20 min)

### Goal

The background executor should:
1. Track which files it has already written in this session
2. Not re-write a file with identical content
3. Recognize "task complete" when files are created + command ran successfully

### Exact changes in `backgroundAgentExecutor.ts`

**Add a `Set` to track written files. Inside `startBackgroundExecution()`, right after the orchestrator registration (Stage 2 code), add:**
```typescript
  // Track files already written this session (deduplication)
  const writtenFiles = new Map<string, string>(); // path → content hash
```

**Add a simple hash function at the bottom of the file:**
```typescript
function simpleHash(str: string): string {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash |= 0; // Convert to 32-bit integer
  }
  return hash.toString(36);
}
```

**In the file write loop (Stage 3's version), before the `// Write the file` comment, add this deduplication check:**
```typescript
          // Deduplication: skip if we already wrote identical content to this file
          const contentHash = simpleHash(change.content);
          const previousHash = writtenFiles.get(change.path);
          if (previousHash === contentHash) {
            store.addLog("verifying", `Skipped (duplicate): ${change.path} — already written with same content`);
            resolver.releaseAndFlush(bgAgentId, change.path);
            continue;
          }
```

**After the successful write (`store.markFileApplied` line), add:**
```typescript
            writtenFiles.set(change.path, contentHash);
```

**For completion detection, after the "Step 3: Run commands" section and before `store.advanceSubtask()`, add:**
```typescript
      // Completion detection: if we wrote files AND ran commands successfully, task is done
      // Don't loop back and regenerate the same files
      const allFilesApplied = result.fileChanges?.every(fc => {
        const hash = simpleHash(fc.content);
        return writtenFiles.has(fc.path) && writtenFiles.get(fc.path) === hash;
      }) ?? false;
      
      const allCommandsPassed = !result.commands?.length || 
        useBackgroundAgentStore.getState().session?.logs
          .filter(l => l.step === "verifying" && l.message.startsWith("Command passed"))
          .length === result.commands.length;

      if (allFilesApplied && allCommandsPassed && result.fileChanges && result.fileChanges.length > 0) {
        store.addLog("verifying", "Task complete — all files written and commands passed. Stopping loop.");
      }
```

### How to verify

Ask the agent to "make a tic-tac-toe game and open it in browser." It should:
1. Create the files (1st pass)
2. Run `start tic-tac-toe.html` (1st pass)
3. On 2nd loop iteration, detect files are identical → skip → advance subtask → complete

No more triple-write.

---

## Stage 5: Human-in-the-Loop Approval Gate

**Issues fixed:** #5  
**Files touched:** `src/store/backgroundAgentStore.ts`, `src/services/backgroundAgentExecutor.ts`, `src/components/AiChat.tsx`  
**Size:** Medium (45 min)

### Goal

Instead of auto-writing files, the background executor queues proposed changes and waits for user approval. The foreground agent's `autoApply` becomes configurable (default: `false`).

### 5A. Add approval state to BackgroundAgentStore

**In `backgroundAgentStore.ts`, add a new step to `BackgroundAgentStep`:**
```typescript
export type BackgroundAgentStep =
  | "queued"
  | "planning"
  | "proposing_fix"
  | "awaiting_approval"   // ← ADD THIS
  | "running_command"
  | "analyzing_output"
  | "verifying"
  | "completed"
  | "failed"
  | "paused"
  | "cancelled";
```

**Add new actions to the `BackgroundAgentState` interface:**
```typescript
  approveChanges: () => void;
  rejectChanges: () => void;
```

**Add implementations in the `create<BackgroundAgentState>` body:**
```typescript
  approveChanges: () => {
    const { session } = get();
    if (!session || session.step !== "awaiting_approval") return;
    set({
      session: {
        ...session,
        step: "verifying",
        logs: [...session.logs, { timestamp: Date.now(), step: "verifying", message: "Changes approved by user" }],
      },
    });
  },

  rejectChanges: () => {
    const { session } = get();
    if (!session || session.step !== "awaiting_approval") return;
    // Remove unapplied file changes from this round
    const cleaned = session.fileChanges.filter(fc => fc.applied);
    set({
      session: {
        ...session,
        step: "analyzing_output",
        fileChanges: cleaned,
        logs: [...session.logs, { timestamp: Date.now(), step: "analyzing_output", message: "Changes rejected by user — will retry with different approach" }],
      },
    });
  },
```

### 5B. Background Executor waits for approval

**In `backgroundAgentExecutor.ts`, replace the file write section (Stage 3's version) with an approval-gated version.**

The key change: instead of writing immediately, set step to `"awaiting_approval"` and wait in a polling loop until the user approves or rejects.

**After the snapshot and before the file write loop, add:**
```typescript
        // Set step to awaiting_approval and wait for user
        store.updateStep("awaiting_approval", `Proposed ${result.fileChanges.length} file change(s) — waiting for approval`);
        showToast(`📋 Background agent needs approval — ${result.fileChanges.length} file(s)`, "info");

        // Wait for user to approve or reject (or cancel)
        while (true) {
          await sleep(500);
          const state = useBackgroundAgentStore.getState();
          if (!state.session || !state.isRunning || executorCancelled) break;
          if (state.session.step === "verifying") break;  // approved
          if (state.session.step === "analyzing_output") break; // rejected
          if (state.session.step === "cancelled") break;
          // Still awaiting_approval — keep waiting
        }

        const postApproval = useBackgroundAgentStore.getState();
        if (!postApproval.session || postApproval.session.step !== "verifying") {
          // Rejected or cancelled — skip writes, continue loop
          continue;
        }
```

**Then the file write loop follows (only executes if approved).**

### 5C. Make foreground `autoApply` configurable

**In AiChat.tsx, change the `startAgentTask` function:**

**FIND:**
```typescript
      autoApply: true,  // Agent mode defaults to auto-apply
```

**REPLACE WITH:**
```typescript
      autoApply: false,  // Require user approval before applying changes
```

This means the foreground agent will now pause at `"awaiting_approval"` step and show the Apply/Reject buttons (which already exist in `ParsedActionsView`).

If you want a toggle in the UI later, add a state variable:
```typescript
const [agentAutoApply, setAgentAutoApply] = useState<boolean>(() => {
  try { return localStorage.getItem("punam-agent-autoapply") === "true"; } catch { return false; }
});
```

And use `agentAutoApply` instead of the hardcoded `true`.

### How to verify

1. Start a background task → it should show "awaiting approval" with a toast
2. Check the background panel — proposed files should be listed but NOT applied
3. Click Approve → files get written
4. Click Reject → agent retries with different approach
5. Foreground agent now shows Apply/Reject buttons instead of auto-applying

---

## Stage 6 (Bonus): Wire AgentCoordinator + onChange Fix

**Issues fixed:** #7, plus activates the shared context system  
**Files touched:** `src/services/agent/AgentOrchestrator.ts`, `src/services/backgroundAgentExecutor.ts`  
**Size:** Small (20 min)

### 6A. Fix single onChange → array of listeners

**In `AgentOrchestrator.ts`, replace:**
```typescript
  private onChange: (() => void) | null = null;
  
  onStateChange(callback: () => void): void {
    this.onChange = callback;
  }

  private emitChange(): void {
    if (this.onChange) this.onChange();
  }
```

**With:**
```typescript
  private listeners: Array<() => void> = [];

  onStateChange(callback: () => void): () => void {
    this.listeners.push(callback);
    // Return unsubscribe function
    return () => {
      this.listeners = this.listeners.filter(l => l !== callback);
    };
  }

  private emitChange(): void {
    for (const listener of this.listeners) {
      listener();
    }
  }
```

**Update MultiAgentDashboard.tsx to use the unsubscribe:**
```typescript
  useEffect(() => {
    const unsubscribe = orchestrator.onStateChange(refresh);
    const interval = setInterval(refresh, 2000);
    return () => {
      unsubscribe();
      clearInterval(interval);
    };
  }, [orchestrator, refresh]);
```

### 6B. Wire AgentCoordinator into background executor prompts

**In `backgroundAgentExecutor.ts`, add import:**
```typescript
import { getAgentCoordinator } from "./agent/AgentCoordinator";
```

**In `executeOneStep()`, before building the system prompt, add:**
```typescript
  // Get shared context from coordinator (architecture advice, security concerns)
  const coordinator = getAgentCoordinator();
  const agentContext = coordinator.buildAgentContext("implementation");
```

**Append it to the system prompt:**
```typescript
    const systemPrompt = `${SYSTEM_PROMPT}\n\n${payload.systemInstruction}\n\n${backgroundExecutionRules}${agentContext ? `\n\n## Multi-Agent Context\n${agentContext}` : ""}`;
```

### How to verify

- Multiple UI components can subscribe to orchestrator changes without clobbering
- If an architecture report is set via `coordinator.setArchitectureAdvice(...)`, the background agent's prompt will include it

---

## Execution Order Summary

```
Stage 1 → Fix lock bug (5 min)
    ↓
Stage 2 → Register agents (15 min)  
    ↓
Stage 3 → Route writes through ConflictResolver (30 min)
    ↓
Stage 4 → Completion detection + deduplication (20 min)
    ↓
Stage 5 → Human-in-the-loop approval gate (45 min)
    ↓
Stage 6 → onChange fix + coordinator wiring (20 min)
```

**After Stage 3:** Your double-write problem is solved. Agents can't overwrite each other's files.  
**After Stage 4:** The loop-and-regenerate problem is solved. Agent stops when task is done.  
**After Stage 5:** No changes apply without your permission.  
**After Stage 6:** Full multi-agent pipeline is live as designed.

Total: ~2.5 hours of focused work.

---

## Testing Checklist

After all stages:

- [ ] Background agent shows in Multi-Agent Dashboard when running
- [ ] Foreground agent shows in Multi-Agent Dashboard when running
- [ ] File locks visible in dashboard during writes
- [ ] "Make a tic-tac-toe game" creates files exactly once
- [ ] Browser opens exactly once
- [ ] Background agent shows "awaiting approval" before writing
- [ ] Approve → files written; Reject → agent retries differently
- [ ] Foreground agent shows Apply/Reject buttons (no auto-apply)
- [ ] Two agents targeting same file → second one gets "file locked" message
- [ ] Agent completes → removed from dashboard, locks released
- [ ] Integration test still passes: `npx tsx src/__tests__/multi-agent.integration.test.ts`
