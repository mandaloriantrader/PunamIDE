# Cline-Like Chat UI Overhaul — Punam IDE

> **Status:** In Progress (Phase 1-2, 4-6 complete; Phase 3 ~85% done)  
> **Last Updated:** 2026-05-29 00:37 IST  
> **Scope:** Frontend-only (React/TypeScript UI layer)  
> **Backend Changes Required:** None  

## ═══════ IMPLEMENTATION STATUS ═══════

| Phase | Description | Status |
|---|---|---|
| 1. Structured Streaming Protocol | protocol.ts, streamBlocks.ts, prompts.ts update | ✅ DONE |
| 2. New Visual Components | ThinkingBlock, ToolCallCard, ToolResultCard, ResponseBlock, MessageBubble | ✅ DONE |
| 3. Streaming Rendering Overhaul | AiChat.tsx integration — flushStreamedText callbacks + finalization + JSX | ⚠️ 85% |
| 4. Diff View Upgrade | DiffView.tsx with LCS diff | ✅ DONE |
| 5. Syntax Highlighting | highlight.js + CodeBlock.tsx | ✅ DONE |
| 6. Polish & Transitions | 17-cline-chat-blocks.css (350 lines) | ✅ DONE |

### Phase 3 Detailed Status
- ✅ `import { parseStreamBlocks, resetParseState }` added to AiChat.tsx
- ✅ `import MessageBubble` added to AiChat.tsx  
- ✅ ChatMessage type updated with `blocks?: StreamBlock[]` and `isComplete?: boolean`
- ✅ CSS import chain updated in `src/styles/index.css`
- ⚠️ 3 `flushStreamedText` callbacks need to use `resetParseState()` + `parseStreamBlocks()` to push `blocks` + `isComplete: false`
- ⚠️ 3 final `setMessages` calls need `blocks` from `parseStreamBlocks(finalText).completed` + `isComplete: true`
- ⚠️ JSX message renderer needs `<MessageBubble>` before fallback `<MarkdownMessage>`

---

## 1. Problem Statement

The current AI chat panel renders responses as a single markdown blob — everything streams into one box. There are no visual distinctions between:
- The AI's internal reasoning ("thinking")
- Structured tool calls and their results  
- The final user-facing response
- Multi-step agent/progress tracking

The goal is to restructure the **rendering layer** so Punam's chat feels as polished and structured as Claude/Cline's chat interface, regardless of what model is used under the hood.

---

## 2. What's OUT of Scope (Deferred)

| Item | Reason |
|---|---|
| Native tool calling (Gemini/OpenAI function calling APIs) | Failed with Gemini 2.5 Flash. JSON prompt-based tool loop (`jsonToolLoop.ts`) works fine. |
| Backend architecture changes | Keep existing Rust Tauri layer unchanged |
| MCP server changes | Existing MCP infrastructure stays as-is |
| Multi-model orchestration changes | `providers.ts` remains untouched |

---

## 3. What We're Actually Building

A **structured streaming response renderer** — not new AI capabilities, but a dramatically improved visual experience for existing ones.

### Key Principles
1. **Progressive rendering** — each logical block (thinking, code, results) renders as it streams in, not after the full response
2. **Visual hierarchy** — tool calls are visually distinct from natural language, grouped with their results
3. **Breathability** — more padding, better typography, clearer section separation
4. **Clarity** — the user always knows what the AI is doing right now

---

## 4. Phased Implementation Plan

---

### Phase 1: Structured Streaming Protocol ✅ DONE

**Goal:** The AI prompt now instructs the model to emit structured XML-like blocks. The client parses these blocks in real-time during streaming.

**Files created/modified:**
| File | Action | Purpose |
|---|---|---|
| `src/utils/streamBlocks.ts` | CREATED | Block parser: splits streaming text into {thinking, tool_call, tool_result, response} blocks as tokens arrive |
| `src/utils/prompts.ts` | MODIFIED | Structured output protocol appended to `SYSTEM_PROMPT` |
| `src/utils/protocol.ts` | CREATED | Type definitions for structured blocks |

---

### Phase 2: New Visual Components ✅ DONE

**Files created:**
| File | Purpose |
|---|---|
| `src/components/chat/ThinkingBlock.tsx` | Collapsible "Thinking..." section with animated spinner during streaming, fade-to-collapse when done |
| `src/components/chat/ToolCallCard.tsx` | Shows tool name, icon, collapsible params, loading spinner → ✓ checkmark |
| `src/components/chat/ToolResultCard.tsx` | Shows tool result in collapsible code block, connected via left-border bridge |
| `src/components/chat/ResponseBlock.tsx` | The final markdown response, streamed incrementally with typing cursor |
| `src/components/chat/MessageBubble.tsx` | Refined message container — groups thinking + tool_call + tool_result + response for a single AI turn |

---

### Phase 3: Streaming Rendering Overhaul in AiChat.tsx ⚠️ 85% DONE

**Goal:** Replace the current single-stream rendering logic with block-aware progressive rendering.

**What remains (5 small changes):**

1. **Single-model flushStreamedText callback** (lines ~990-1010): Replace `getStreamingTextBeforeActionBlocks` + raw content display with `resetParseState()` + `parseStreamBlocks()` to set `blocks` + `isComplete: false`

2. **Agent-mode flushStreamedText callback** (lines ~1676-1690): Same replacement

3. **Adaptive-mode final setMessages** (lines ~958-977): Add `blocks` from `parseStreamBlocks(finalText).completed` and `isComplete: true`

4. **Single-model final setMessages** (lines ~1034-1088): Same addition

5. **JSX renderer** (lines ~2127-2199): Add `<MessageBubble>` before the `<MarkdownMessage>` fallback:
   ```tsx
   {!msg.parsed && !msg.blocks && <MarkdownMessage text={msg.content} />}
   {msg.blocks && msg.blocks.length > 0 && (
     <MessageBubble blocks={msg.blocks} isStreaming={!msg.isComplete} />
   )}
   ```

---

### Phase 4: Diff View Upgrade ✅ DONE

Created `src/components/chat/DiffView.tsx` with LCS-based unified diff algorithm, +/- line highlighting with colored gutters.

---

### Phase 5: Syntax Highlighting ✅ DONE

Installed `highlight.js`, created `src/components/chat/CodeBlock.tsx` with 15 registered languages (tree-shakeable).

---

### Phase 6: Polish & Transitions ✅ DONE

Created `src/styles/app/17-cline-chat-blocks.css` — 350 lines covering all new component styles, animations (slideIn, thinkingFadeIn, toolPulse, blink cursor, responseFadeIn), diff view, tool cards, message bubble.

---

## 5. File Summary

### New Files (all created ✅)
```
src/utils/
  protocol.ts                  # StreamBlock types
  streamBlocks.ts              # Block parser

src/components/chat/
  ThinkingBlock.tsx            # Collapsible thinking section
  ToolCallCard.tsx             # Tool invocation card  
  ToolResultCard.tsx           # Tool result display
  ResponseBlock.tsx            # Enhanced markdown response
  MessageBubble.tsx            # AI turn container
  DiffView.tsx                 # Unified diff display
  CodeBlock.tsx                # Syntax-highlighted code

src/styles/app/
  17-cline-chat-blocks.css     # All new block styles

punam/
  cline-like-chat-plan.md      # This document
```

### Modified Files (all done ✅)
```
src/
  types/index.ts               # Added blocks, isComplete to ChatMessage
  utils/prompts.ts              # Updated SYSTEM_PROMPT with structured protocol
  components/AiChat.tsx         # Partially: imports added, callbacks pending
  styles/index.css              # Added CSS import chain
```

---

## 6. Remaining Tasks for Next Session

**Only 5 small changes in `src/components/AiChat.tsx`:**

1. In `requestPunam()`, single-model path: replace `flushStreamedText` to use `resetParseState()` + `parseStreamBlocks()` instead of `getStreamingTextBeforeActionBlocks`
2. In `agentProposeFix()`, agent path: same replacement
3. In single-model finalization: add `blocks` + `isComplete: true` to the `setMessages` call
4. In adaptive-mode finalization: same addition
5. In JSX: add `<MessageBubble>` before `<MarkdownMessage>` fallback

**Verification:** Run `npx tsc --noEmit` after changes to confirm clean compilation.

---

## 7. Success Criteria

- [ ] AI responses display as structured blocks (thinking → tool calls → results → response) instead of one markdown blob
- [ ] Streaming renders each block progressively as tokens arrive
- [ ] Tool calls and their results are visually grouped with connector lines
- [ ] File diffs show line-by-line changes with +/- highlighting instead of full file dumps
- [ ] Code blocks have syntax highlighting
- [ ] All existing functionality (Apply, Reject, commands, multi-model) continues to work
- [ ] Graceful fallback for models that don't follow the structured protocol
- [ ] No regression in token usage or response latency