# 🔬 PunamIDE AI Chat Streaming — Full Audit Report

**Date**: 2026-05-31  
**Scope**: End-to-end audit of how AI chat responses stream from providers to the UI  
**Finding**: The streaming pipeline is technically streaming, but **the user experience is broken by multiple design flaws** that make it feel like everything arrives at once.

---

## 1. Architecture Overview

```
[AI Provider API] ──SSE──▶ [Rust Backend (lib.rs)] ──Tauri Event "llm-stream"──▶ [React Frontend (AiChat.tsx)]
                                                                                         │
                                                                               ┌───────┴────────┐
                                                                               │  streamBlocks.ts │
                                                                               │  (XML tag parser) │
                                                                               └───────┬────────┘
                                                                                       │
                                                                               ┌───────┴────────┐
                                                                               │ MessageBubble   │
                                                                               │ (block renderer)│
                                                                               └────────────────┘
```

---

## 2. Backend (Rust) — ✅ CORRECT

### 2.1 Gemini Streaming (`call_gemini_stream` — lib.rs line 309-428)
- Uses SSE endpoint with `alt=sse` parameter
- Iterates `resp.bytes_stream()` correctly
- Parses each SSE line and emits `llm-stream` event **per token**
- Emits final `done: true` event
- **Verdict: Streaming is real. Tokens are emitted as they arrive.**

### 2.2 OpenAI-Compatible Streaming (`call_openai_compatible_stream` — lib.rs line 501-628)
- Sends request with `"stream": true`
- Iterates `resp.bytes_stream()` correctly
- Parses `choices[0].delta.content` from each SSE chunk
- Emits `llm-stream` event **per token**
- **Verdict: Streaming is real. Tokens are emitted as they arrive.**

### 2.3 `call_llm` (legacy non-streaming) — lib.rs line 229-248
- This is the **old non-streaming path** — it calls `call_gemini` or `call_openai_compatible` (non-stream variants)
- These variants wait for the ENTIRE response before returning
- **Verdict: This path is NOT streaming. But it's only used for fallback/multi-model paths.**

---

## 3. Frontend — Provider Abstraction Layer

### 3.1 `sendToProviderStreaming` (providers.ts line 306-391)
- **Gemini path**: Calls `invoke("call_gemini_stream", ...)` which runs the Rust streaming function
- **OpenAI path**: Calls `invoke("call_openai_compatible_stream", ...)` which runs the Rust streaming function
- Both return `{ text: full_text, success, error }` after the stream completes
- **Verdict: Correct. All non-legacy streaming goes through Rust's streaming commands.**

---

## 4. Frontend — AiChat.tsx (The Core Problem Area)

There are **four distinct code paths** for AI responses. Each has different streaming behavior.

### 4.1 🔴 Path A: Adaptive Mode (line ~886-996)
**Streaming strategy**: `setTimeout(flushStreamedText, 40)` — debounced at 40ms intervals

```typescript
flushTimer = setTimeout(flushStreamedText, 40);
```

**Problems**:
1. **`flushStreamedText` replaces the ENTIRE message content** with `parseStreamBlocks` output on every tick. This means the UI flickers between block-parsed views and raw text.
2. The blocks parser (`parseStreamBlocks`) resets its internal state on every call (`resetParseState()`), then re-parses the **entire accumulated text**. This is O(n²) — inefficient but not a UX bug per se.
3. **After the stream finishes**, the code calls `parseStreamBlocks` AGAIN to produce `finalBlocks`, then sets `isComplete: true`. This means the user sees block-parsed content during streaming, then BLANK raw text for the final render if blocks don't parse. This creates a visual "glitch" at the end.
4. **CRITICAL**: The final message set (`setMessages` at line 983-995) sets `content: responseText` AND `blocks: finalBlocks`. But the JSX rendering logic (line 2304-2308) shows `MarkdownMessage` for `!msg.parsed && !msg.blocks` — so a completed message with both `parsed` and `blocks` set will show parsed actions, NOT the block-structured content. This is confusing — blocks get lost when there's a parsed response.

### 4.2 🔴 Path B: Single Model Mode (line ~1000-1113)
**Streaming strategy**: `requestAnimationFrame` — batched at ~16ms (60fps)

```typescript
if (!rafId) rafId = requestAnimationFrame(() => { rafId = 0; flushStreamedText(); });
```

**Problems**:
1. Same `parseStreamBlocks` re-parsing issue as Path A.
2. Uses `requestAnimationFrame` which means **updates are capped at display refresh rate (~60Hz)**. For high-throughput models (Gemini Flash, Groq), tokens can arrive faster than 60fps, causing perceived batching. This is less severe than Path A's `setTimeout` but still not truly per-token.
3. Same end-of-stream "glitch" where final blocks replace streaming blocks.
4. **No streaming indicator**: The token/s counter (`streamProgress`) only updates at ~60fps, which feels laggy.

### 4.3 🔴 Path C: Agent Mode / Full Context (line ~1730-1810)
**Streaming strategy**: `setTimeout(flushStreamedText, 40)` — same as Adaptive Mode

**Problems**:
1. Identical debouncing issues as Path A.
2. **Doesn't even parse blocks during streaming** — the `flushStreamedText` just copies `streamedText` directly into `content`. Block parsing only happens at the END (line 1802). So during streaming, the user sees raw text with XML tags (`<thinking>`, `<tool_call>`) mixed in.
3. This is the **worst streaming UX** — the user sees raw XML tokens until the entire response completes.

### 4.4 🔴 Path D: Legacy / Multi-Model (line ~1115-1173)
**No streaming at all** — uses `callLlm` (non-streaming Rust command) or `sendToMultipleModels`. The entire response is awaited and then rendered at once.

---

## 5. The Block Parser (`streamBlocks.ts`) — ⚠️ DESIGN FLAW

### Issue: Global Mutable State
```typescript
let _state = createState();  // Singleton — line 73
```

The parser uses a **module-level singleton** state. Multiple concurrent streaming messages would corrupt each other. While `resetParseState()` is called before each use, there's a race condition if a new message starts streaming before the old one finishes (though this is unlikely in practice since `loading` state prevents concurrent sends).

### Issue: Full Re-parse on Every Flush
Every call to `parseStreamBlocks(rawText)` replaces the entire `_state.buffer` and re-scans from `cursor`. This means:
- The parser **re-processes already-scanned text** on every flush
- Never actually **incremental** — it's just re-parsing the full accumulated text each time

### Issue: Preamble Text is Silently Discarded
Line 141-144: Any text before the first XML tag is **ignored**. If a model emits text before `<thinking>`, it's silently dropped.

---

## 6. Rendering Pipeline

### JSX Render Logic (AiChat.tsx lines 2202-2337)
```
if (msg.parsed)  →  show ParsedActionsView (file changes, commands, apply buttons)
if (msg.blocks)  →  show MessageBubble (structured blocks)
else             →  show MarkdownMessage (raw markdown)
```

**Critical conflict**: Messages with BOTH `parsed` AND `blocks` show parsed actions first, THEN blocks below, THEN markdown. This means a streaming message that starts showing blocks will **abruptly change** to showing parsed actions at the end. The blocks accumulated during streaming are also shown, but in a confusing layered way.

### `MessageBubble` (MessageBubble.tsx)
Correctly renders blocks in order: `thinking → tool_call → tool_result → response`. No performance issues — it's a pure component rendering the `blocks` array.

### `MarkdownMessage` (ChatComponents.tsx)
Renders text with basic markdown and code block detection. Used as the fallback when no blocks/parsed actions exist. **This is what shows during streaming for Path C (Agent mode)** — meaning the user sees raw XML tags during agent streaming.

---

## 7. The Patch File (`files/AiChat_patch.tsx`) — NOT YET APPLIED

The patch file proposes:
1. **Importing `agentToolLoop`** — a new tool-calling loop for agents
2. **Replacing `agentProposeFix`** with a dual-path: tool-loop (Path A) or full-context fallback (Path B)
3. **Extracting `_agentProposeFixFullContext`** helper

The patch's `_agentProposeFixFullContext` (lines 178-298) has a slightly different streaming approach:
- Uses `getStreamingTextBeforeActionBlocks(streamedText)` (line 240) — a function that strips action blocks (FILE/CMD/EDIT) from streaming text before displaying. **This function does NOT exist in the current codebase** — it would need to be imported/created.
- Still uses the same `setTimeout(..., 40)` debouncing
- Still doesn't use `parseStreamBlocks` during streaming — just shows raw text

**Statuts**: This patch appears to be a planned but unapplied improvement, not a fix for the streaming issues.

---

## 8. Root Causes Summary

| # | Issue | Severity | Paths Affected |
|---|-------|----------|----------------|
| 1 | **40ms debounce on streaming updates** — creates 40ms batching that feels laggy for fast models | HIGH | A, C |
| 2 | **Agent mode shows raw XML during streaming** — no block parsing until stream ends | CRITICAL | C |
| 3 | **End-of-stream glitch** — message transforms from blocks view to parsed-actions view abruptly | MEDIUM | A, B |
| 4 | **No incremental parsing** — `streamBlocks.ts` re-parses entire text on every flush instead of appending | LOW (perf) | A, B, C |
| 5 | **Legacy multi-model path has no streaming** — acceptable for multi-model but confusing UX | LOW | D |
| 6 | **`setTimeout(40)` in Adaptive Mode** — 25 updates/sec max, but models emit 50-200 tokens/sec | MEDIUM | A |
| 7 | **`requestAnimationFrame` in Single Model** — ~60 updates/sec, better but still not per-token | LOW | B |
| 8 | **Blocks and parsed content conflict in render** — message with both shows duplicated/confusing UI | MEDIUM | A, B, C |
| 9 | **`parseStreamBlocks` resets state every call** — `resetParseState()` loses incremental progress | LOW | A, B, C |
| 10 | **Preamble text silently dropped** — any text before first `<thinking>` tag is discarded | LOW | A, B, C |

---

## 9. Why It Feels Like "Everything at Once"

The user's observation is **correct and validated**. Here's why:

1. **For Agent Mode**: The streaming code at line 1745-1751 shows raw `streamedText` (including XML tags) during streaming. The actual block parsing (`parseStreamBlocks`) happens ONLY at the end (line 1802). So during streaming, the user sees:
   ```
   <thinking>Let me analyze this...<thinking>OK here's my plan...<tool_call>
   ```
   This is incomprehensible, so the UI update feels useless — effectively the user waits for the full response.

2. **For Chat Mode with Adaptive Mode**: The 40ms debounce means tokens arrive in chunks of ~2-8 tokens, which is perceptible but feels "stuttery." More critically, the `parseStreamBlocks` re-parsing means the visual output is jumping between block-formatted views as tags open and close. When the stream finishes, the final `setMessages` replaces everything with `responseText + blocks`, causing a visible "jump."

3. **For Single Model Chat Mode**: The 60fps batching via `requestAnimationFrame` is smoother but still batches. For providers like Groq or Gemini Flash that emit 100+ tokens/second, you're seeing ~2-3 tokens per frame, which is okay but not the fluid character-by-character streaming seen in ChatGPT or Cline.

4. **The "Throw at once" feeling**: After all streaming updates finish, the final message is set with `parsed`, `blocks`, and `content` all populated. The render logic shows parsed actions first (file changes, commands, apply buttons), which completely replaces whatever was streaming. This creates the illusion that "everything just appeared at once."

---

## 10. Recommended Fixes (Priority Order)

### 🔴 P1: Fix Agent Mode Streaming (Path C)
```typescript
// In agentProposeFix (or _agentProposeFixFullContext), line 1739-1752:
// Use parseStreamBlocks during streaming, same as Adaptive Mode
const flushStreamedText = () => {
  pendingFlush = false;
  flushTimer = null;
  resetParseState();
  const result = parseStreamBlocks(streamedText);
  const blocks = [...result.completed, ...(result.inProgress ? [result.inProgress] : [])];
  setMessages(prev => prev.map(m =>
    (m as any).streamId === streamId
      ? { ...m, content: "", blocks, isComplete: false }
      : m
  ));
};
```
**This alone fixes the "#1 user complaint" of seeing raw XML during agent tasks.**

### 🔴 P2: Reduce Debounce to 16ms (requestAnimationFrame) in All Paths
Replace all `setTimeout(flushStreamedText, 40)` with `requestAnimationFrame` — matching Path B:
```typescript
if (!rafId) rafId = requestAnimationFrame(() => { rafId = 0; flushStreamedText(); });
```
This gives 60 updates/sec instead of 25, making streaming feel 2.4x smoother.

### 🟡 P3: Fix End-of-Stream Glitch
When finalizing a streaming message, update the EXISTING message in-place rather than replacing it:
```typescript
setMessages(prev => prev.map(m => {
  if ((m as any).streamId !== streamId) return m;
  return { ...m, isComplete: true, parsed, applied: false, metrics };
}));
// Do NOT replace blocks/content — just add isComplete and parsed
// The MessageBubble already handles isStreaming={!msg.isComplete}
```

### 🟡 P4: Make `parseStreamBlocks` Truly Incremental
Instead of resetting state and re-parsing the full buffer, add an `appendStreamChunk` method:
```typescript
export function appendStreamChunk(newText: string): BlockParseResult {
  _state.buffer += newText;
  // Continue scanning from _state.cursor (which is already positioned)
  // ...rest of existing scan loop
}
```
This would make O(n) instead of O(n²) per flush.

### 🟢 P5: Handle Preamble Text
Before the first XML tag, show a "Thinking..." indicator instead of silently dropping text.

### 🟢 P6: Add Streaming Token Counter
Already partially implemented with `streamProgress` but only shown in Path B. Add to all paths.

---

## 11. File-Level Summary

| File | Role | Status |
|------|------|--------|
| `src-tauri/src/lib.rs` (line 309-428) | Gemini SSE streaming | ✅ Correct |
| `src-tauri/src/lib.rs` (line 501-628) | OpenAI SSE streaming | ✅ Correct |
| `src/utils/providers.ts` (line 306-391) | Provider dispatch to Rust | ✅ Correct |
| `src/components/AiChat.tsx` (line 886-996) | Adaptive Mode streaming | ⚠️ 40ms debounce, end-of-stream glitch |
| `src/components/AiChat.tsx` (line 1000-1113) | Single Model streaming | ⚠️ rAF batching only, end-of-stream glitch |
| `src/components/AiChat.tsx` (line 1730-1810) | Agent Mode streaming | 🔴 No block parsing during stream |
| `src/utils/streamBlocks.ts` | XML block parser | ⚠️ Re-parses full text, global state |
| `src/components/chat/MessageBubble.tsx` | Block renderer | ✅ Correct |
| `src/components/chat/ChatComponents.tsx` | Markdown renderer | ✅ Correct |
| `files/AiChat_patch.tsx` | Pending patch | ⚠️ Not applied, references missing function |

---

## 12. Conclusion

The backend streaming infrastructure is **sound** — tokens truly stream from AI providers through Rust to the frontend via Tauri events. The problem is entirely in the **frontend consumption of those events**:

1. **Agent Mode** (the most complex and impressive mode) has the WORST streaming UX — raw XML is shown.
2. **40ms debouncing** creates perceptible batching that feels like "spurts" of text rather than fluid typing.
3. **End-of-stream message replacement** destroys the streaming illusion by abruptly transforming the UI.
4. The lack of incremental parsing means blocks appear/disappear as tags open and close mid-stream.

**Estimated effort to fix**: 2-4 hours for P1+P2+P3 (the critical fixes). P4-P6 are nice-to-haves.