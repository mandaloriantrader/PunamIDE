# Tool Calling — Status & Fix List

**Date:** 2026-05-28
**Status:** DISABLED (temporarily) — falls back to full-context path
**Reason:** Gemini function calling loop runs but never produces a final answer

---

## What's Implemented (All Code In Place)

| File | Status |
|------|--------|
| `src-tauri/src/agent_tools.rs` | Done — `read_lines` + `apply_patch` with append edge case |
| `src-tauri/src/lib.rs` | Done — module registered, 2 commands in invoke_handler |
| `src/utils/agentTools.ts` | Done — tool definitions + executor |
| `src/utils/agentToolLoop.ts` | Done — Gemini native + Anthropic + JSON fallback |
| `src/utils/contextEngine.ts` | Done — `toolLoopMode` flag, skips file injection |
| `src/components/AiChat.tsx` | Done — `agentProposeFix` has tool loop path + fallback |

## Currently Disabled

In `src/components/AiChat.tsx` line ~1610:
```typescript
// Tool loop disabled temporarily — needs Gemini function calling debugging
const useToolLoop = false; // shouldUseToolLoop(currentTask);
```

To re-enable: change `false` back to `shouldUseToolLoop(currentTask)`.

---

## Known Issues To Fix

### 1. Gemini Function Calling — Max Rounds Reached (CRITICAL)

**Symptom:** Tool loop runs 10 rounds, never gets a final text answer, shows blank.

**What happens:**
- `runGeminiToolLoop` in `agentToolLoop.ts` calls Gemini with function declarations
- Gemini responds (possibly with tool calls)
- Loop continues but never detects "model is done"
- Hits max 10 rounds, returns "Max tool rounds reached."

**Likely causes:**
- `finishReason` check: code checks `finishReason === "STOP"` but Gemini might return different values (`"FINISH"`, `"END"`, or undefined)
- Gemini might return BOTH text AND functionCall in the same response — code treats any functionCall as "keep going"
- The tool execution results might not be formatted correctly for Gemini's `functionResponse` format
- Gemini might not be receiving the tool results properly (wrong `contents` structure)

**Debug steps:**
1. Add `console.log` inside `runGeminiToolLoop` after each API call:
   ```typescript
   console.log("[GEMINI TOOL] Round", round, "finishReason:", candidate.finishReason);
   console.log("[GEMINI TOOL] Parts:", JSON.stringify(parts, null, 2));
   ```
2. Check what `finishReason` Gemini actually returns
3. Check if `functionCall` parts are present when they shouldn't be
4. Verify the `functionResponse` format matches Gemini's expected schema

**Fix approach:**
- If `finishReason` is different: update the check to handle all stop conditions
- If text + functionCall coexist: prioritize text when `finishReason` indicates stop
- If tool results format is wrong: check Gemini docs for exact `functionResponse` schema

---

### 2. 503 Errors on Direct Gemini Fetch

**Symptom:** `Gemini API error 503: This model is currently experiencing high demand`

**What happens:**
- Tool loop calls Gemini REST API directly via `fetch` from frontend
- Gets 503, triggers `onError`, falls back to full-context path (which uses Rust backend streaming)

**Why it happens differently:**
- Direct fetch goes to `generativelanguage.googleapis.com/v1beta/models/...`
- Rust backend streaming goes to the same endpoint but with `streamGenerateContent`
- Different endpoints may have different rate limits/availability

**Fix options:**
- Add retry logic (1-2 retries with 1s delay) before falling back
- Route tool-calling through Rust backend too (bigger change, Phase 1.1)
- Accept the fallback behavior (current approach — works but uses more tokens)

---

### 3. JSON Fallback for OpenAI-Compatible Providers

**Symptom:** Not tested yet. May work unreliably.

**What happens:**
- For non-Gemini/non-Anthropic providers (OpenRouter, Groq, Mistral, Ollama)
- Tool instructions are injected into the system prompt as text
- Model is asked to output JSON blocks for tool calls
- `parseJsonToolCall` extracts the tool call from the response

**Potential issues:**
- Free/small models may not follow the JSON format reliably
- Model might output tool call + text in same response (parser only checks for JSON block)
- Model might never call tools and just answer directly (which is fine — treated as final answer)

**Fix:** Test with each provider. Add more robust parsing if needed.

---

### 4. API Key Exposure in Frontend Fetch

**Symptom:** Not a bug, but a security consideration.

**What happens:**
- `callGeminiWithTools` in `agentToolLoop.ts` uses `fetch` directly with the API key in the URL
- In a Tauri desktop app this is fine (local process, not exposed to internet)
- But if PunamIDE ever becomes a web app, this would be a security issue

**Fix (Phase 1.1):** Route tool-calling API calls through the Rust backend proxy, same as streaming calls.

---

### 5. TokenPill Estimate Doesn't Reflect Tool Loop Savings

**Symptom:** TokenPill shows ~8.7K even when tool loop would only use ~500 tokens.

**What happens:**
- TokenPill estimates based on Chat mode's context builder (full file inclusion)
- It doesn't know about the Agent mode's tool loop path
- Shows misleading high estimate for Agent mode

**Fix:** Make TokenPill aware of agent mode — show "~500 (tool mode)" when agent mode is active and the task matches `shouldUseToolLoop` patterns.

---

## Re-enabling Checklist

Before re-enabling the tool loop:

1. [ ] Debug Gemini function calling response format (Issue #1)
2. [ ] Verify `finishReason` handling covers all Gemini stop conditions
3. [ ] Add console logging to `runGeminiToolLoop` for debugging
4. [ ] Test with a simple prompt: "what is on line 1 of ecommerce.py?"
5. [ ] Verify tool results are fed back in correct Gemini format
6. [ ] Test fallback triggers correctly on tool loop failure
7. [ ] Test with OpenRouter JSON fallback mode
8. [ ] Re-enable: change `false` back to `shouldUseToolLoop(currentTask)`

---

## Token Savings (Expected When Working)

| Task | Current (fallback) | With tool loop | Savings |
|------|---|---|---|
| "what's on line 20?" | ~5K tokens | ~500 tokens | 90% |
| "find word lagoon" | ~5K tokens | ~800 tokens | 84% |
| "fix this button" | ~5K tokens | ~2K tokens | 60% |
| "refactor entire file" | ~5K tokens | ~5K tokens | 0% (uses fallback) |
