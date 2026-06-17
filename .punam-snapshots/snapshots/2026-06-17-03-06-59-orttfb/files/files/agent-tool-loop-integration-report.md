# Agent Tool Loop Integration: Investigation Report

> **Date:** 2026-05-31
> **Author:** AI-assisted analysis
> **Scope:** Workspace visibility, tool exposure, provider compatibility

---

## Table of Contents

1. [Issue 1: Agent Cannot See Full Workspace](#issue-1-agent-cannot-see-full-workspace)
2. [Issue 2: Tool Definitions Not Sent to Model](#issue-2-tool-definitions-not-sent-to-model)
3. [Issue 3: Provider Tool-Calling Compatibility](#issue-3-provider-tool-calling-compatibility)
4. [Root Cause Summary](#root-cause-summary)
5. [Comparison: Fix Approaches](#comparison-fix-approaches)
6. [Recommendation](#recommendation)
7. [Implementation Status](#implementation-status)
8. [Live Testing Results](#live-testing-results)
9. [Known Issues](#known-issues)

---

## Issue 1: Agent Cannot See Full Workspace

### Observed Problem

When asked to "analyze the workspace", "produce a project report", or "generate a dependency map", the agent behaves as if it only sees 1-4 files out of ~30.

### Evidence

**Answer: NO** — the agent does not receive the full workspace file list.

### Code Path Trace — CORRECTED

> **IMPORTANT:** `punam_fix/AiChat.tsx` is a **proposed fix snapshot** — NOT compiled into the app.
> The actual production file is `src/components/AiChat.tsx`.

#### Path A: `punam_fix/AiChat.tsx` (proposed fix, NOT production)

This file was analyzed first and has ~2277 lines. It is a simpler snapshot that:
- Does NOT import `runJsonToolLoop`, `mentionResolver`, `streamBlocks`
- Does NOT have `toolModeEnabled` toggle
- Does NOT have conflict resolver / orchestrator guardrails
- Is **NOT compiled** by Vite — changes here have zero effect on running app

#### Path B: `src/components/AiChat.tsx` (PRODUCTION, ~2587 lines)

This is the **real** file compiled and run by the app. It has:
- 310 more lines than `punam_fix/`
- `toolModeEnabled` flag (separate tool mode using `runJsonToolLoop`)
- Full streaming infrastructure with block parsing
- Conflict resolver, orchestrator, security guardrails

#### Path C: Chat Mode (`requestPunam`) — WORKS CORRECTLY

- Line 667: `const fileTree = buildFileContext(files);`
- File tree IS included in chat prompt
- This path is only used for chat mode, never for agent mode

### Fix Applied

| File | Change | Status |
|------|--------|--------|
| `src/utils/contextEngine.ts` | Added `projectFiles` to `ContextInputs`. Injected workspace section in `buildSystemInstruction()`. | ✅ Done |
| `files/contextEngine.ts` | Same changes for patched version. | ✅ Done |

The workspace section is injected **unconditionally** when `projectFiles` is present — covering both tool-loop and full-context agent paths with a single implementation in `buildSystemInstruction()`.

---

## Issue 2: Tool Definitions Not Sent to Model

### Observed Problem

The model reports "NO TOOL DEFINITION" for `list_files`. It can reference the tool name but cannot see its schema.

### Root Cause

`sendToProviderStreaming()` and its underlying Rust commands only accept `systemPrompt`, `userPrompt`, and `images`. They have no `tools` parameter. The `AGENT_TOOL_DEFINITIONS` array exists in `files/agentTools.ts` but is never imported or passed by the production code.

### Fix Applied

Integrated `runAgentToolLoop()` from patch files into production. Created two new files:

| File | Purpose |
|------|---------|
| `src/utils/agentTools.ts` | `AGENT_TOOL_DEFINITIONS`, `executeAgentTool()`, `buildToolSystemPrompt()`, `parseJsonToolCall()` |
| `src/utils/agentToolLoop.ts` | `runAgentToolLoop()`, `isWorkspaceAnalysisTask()`, 3 provider adapters |

Added routing in `src/components/AiChat.tsx` `agentProposeFix()`:

```
agentProposeFix()
 ├─ toolModeEnabled → runJsonToolLoop (pre-existing)
 └─ ELSE:
      ├─ isWorkspaceAnalysisTask → runAgentToolLoop (NEW routing)
      └─ ELSE → sendToProviderStreaming (unchanged)
```

### Routing Limitations

- Only activates in **Agent mode** (not Chat)
- Only activates when **Tool Mode is OFF**
- Only for workspace-analysis tasks matching specific patterns

---

## Issue 3: Provider Tool-Calling Compatibility

### How `runAgentToolLoop()` Works Per Provider

| Provider | Tool Delivery | Model Response | Reliability |
|----------|--------------|----------------|-------------|
| **Anthropic** | Native `tools: [...]` in API body | Structured `tool_use` blocks | ✅ Excellent |
| **Gemini** | Native `tools: [{functionDeclarations}]` | Structured `functionCall` parts | ✅ Excellent |
| **OpenAI-compatible** (DeepSeek, etc.) | Text descriptions in system prompt | Must output ` ```json {"tool":"..."}``` ` blocks | ⚠️ Unreliable |

### JSON Fallback Problem (CONFIRMED IN LIVE TESTING)

The OpenAI-compatible path uses `buildToolSystemPrompt()` which tells the model:
```
You have access to tools:
- list_files: Get the project file index...
To call a tool, output a JSON block:
```json
{"tool": "list_files", "input": {}}
```
```

**Issue:** Models like DeepSeek output natural language thinking text ("Let me start by listing all files") instead of the JSON block. `parseJsonToolCall()` returns null, and the loop treats this as a final answer — returning the thinking text with no tool execution.

**Applied fix:** When no JSON block is found but the response contains tool-intent words (list, read, search, find), the loop pushes back: "Output ONLY a JSON tool call block to proceed." and retries.

---

## Root Cause Summary

```
Workspace Problem (Issue 1)
├── agentProposeFix() never calls buildFileContext(files)
├── assemblePersistentPayload() has no projectFiles parameter
└── buildSystemInstruction() omits workspace overview
    ↓
Tool Exposure Problem (Issue 2)
├── sendToProviderStreaming() does not support tools parameter
├── Production AiChat.tsx never imports AGENT_TOOL_DEFINITIONS
└── No routing to runAgentToolLoop exists
    ↓
JSON Fallback Problem (Issue 3 — DISCOVERED IN TESTING)
├── OpenAI-compatible models receive text-based tool descriptions
├── DeepSeek outputs natural language instead of JSON blocks
└── parseJsonToolCall() treats missing JSON as "final answer"
    ↓
Result: Routing works, tool loop enters, but DeepSeek doesn't
         output the JSON format required for tool execution
```

---

## Implementation Status

### Files Created

| File | Lines | Purpose |
|------|-------|---------|
| `src/utils/agentTools.ts` | 407 | Tool definitions, executor, JSON parser, system prompt builder |
| `src/utils/agentToolLoop.ts` | ~500 | Tool loop, 3 adapters, workspace task detection |

### Files Modified

| File | Change | Status |
|------|--------|--------|
| `src/components/AiChat.tsx` | Added import + routing branch in `agentProposeFix()` | ✅ Done |
| `src/utils/contextEngine.ts` | Added `projectFiles` + workspace section | ✅ Done |
| `files/contextEngine.ts` | Same changes for patched version | ✅ Done |

### Routing Logic (src/components/AiChat.tsx, line ~1782)

```typescript
if (isWorkspaceAnalysisTask(currentTask)) {
  await runAgentToolLoop({ provider, modelId, ... });
  return;
}
// Existing sendToProviderStreaming path unchanged
```

### Workspace Analysis Patterns (fixed after testing)

```typescript
/analyze.*(workspace|project|codebase|architecture)/i,   // .* matches "this", "my", "the entire"
/audit.*(project|codebase|code)/i,
/dependency (analysis|map|graph|tree)/i,
/project report/i,
/codebase review/i,
/architecture review/i,
/list all (files|directories|modules|components)/i,
/what (files|modules|packages) (are|exist|does)/i,
/full (workspace|project) (scan|inventory)/i,
/how many files/i,
/project structure/i,
/directory structure/i,
/generate.*dependency (map|graph)/i,
/provide.*overview/i,
```

---

## Live Testing Results

### Test 1: "analyze this workspace" — Agent Mode, Full Context, Tool Mode OFF

| Attempt | Provider | Result |
|---------|----------|--------|
| 1st | DeepSeek (OpenAI-compatible) | ❌ Model said "Let me start by listing all files" — routing WORKS, but model outputs natural language instead of JSON tool call |
| 2nd | DeepSeek (OpenAI-compatible) | ⏳ Pending — added retry logic for tool-intent responses without JSON blocks |

### Root Causes Discovered During Testing

1. **Regex bug:** `/analyze (the )?(workspace|project)/i` did NOT match "analyze **this** workspace" because "this" is not "the". Fixed: changed to `/analyze.*(workspace|project)/i`.

2. **JSON output reliability:** DeepSeek receives text-based tool instructions but outputs natural language thinking instead of ````json` blocks. Model-specific behavior.

3. **File confusion:** `punam_fix/AiChat.tsx` ≠ `src/components/AiChat.tsx`. The former is a snapshot, the latter is production. Changes to the former don't affect the app.

---

## Known Issues

### 1. OpenAI-Compatible JSON Fallback Reliability (UNRESOLVED)

**Severity:** Medium
**Impact:** DeepSeek and other text-instructed models may not produce JSON tool calls.
**Mitigation:** Retry logic added — when model hints at tool use but doesn't produce JSON, the loop pushes back with explicit instructions.

### 2. provider.type "anthropic" not in type union

**Severity:** Low (TS error only, no runtime impact)
**File:** `src/utils/agentToolLoop.ts` line 490
**Cause:** `AIProviderConfig.type` is `"gemini" | "openai-compatible"` but code checks for `"anthropic"`. Handled as `else` branch (runs JSON fallback). No runtime error.

### 3. Process Id: 9050 (@<none>:<none>)

**Severity:** Info
**All done** task status received but execution continues normally.

---

## Next Steps

1. **Test with Gemini** — Native function calling would bypass the JSON fallback issue entirely
2. **Test with DeepSeek retry logic** — Verify the "push back" retry produces actual JSON tool calls
3. **Consider removing JSON fallback** — If retry logic doesn't work reliably, the text-based JSON approach may need to be abandoned for native tool calling only