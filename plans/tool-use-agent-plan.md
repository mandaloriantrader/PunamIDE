# Punam Tool-Use Agent System — Implementation Plan

## Problem Statement

Currently Punam receives file content as a static text blob in her prompt, truncated at ~6000 characters (~79 lines). She cannot:
- Read specific lines of large files on demand
- Search for text across the codebase
- Inspect file metadata (size, line count)
- Read files she hasn't been given upfront

This makes her blind to anything past the first 79 lines and unable to perform precise operations like "what's on line 1309?"

## Solution: Tool-Use / Function Calling

Give Punam the ability to **call tools** during her response generation. Instead of dumping everything into the prompt upfront, she requests specific information when she needs it.

### How It Works (User Perspective)

```
User: "what's on line 426 of ecommerce.py?"

Punam thinks: I need to read line 426. Let me call readFileLines.
Punam calls: readFileLines("ecommerce.py", 426, 426)
Backend returns: "lagoon"
Punam responds: "Line 426 contains the word 'lagoon'"
```

The user sees a seamless response. The tool call happens invisibly in the background.

---

## Architecture

```
┌─────────────────────────────────────────────────────┐
│  Frontend (AiChat.tsx)                               │
│                                                      │
│  1. User sends message                               │
│  2. Build prompt with tool definitions               │
│  3. Send to AI provider (Gemini function calling)    │
│  4. If response contains tool_call:                  │
│     a. Execute tool via Rust backend                 │
│     b. Feed result back to AI                        │
│     c. Repeat until AI gives final text response     │
│  5. Display final response to user                   │
│                                                      │
└─────────────────────────────────────────────────────┘
         │                          ▲
         ▼                          │
┌─────────────────────────────────────────────────────┐
│  Rust Backend (Tauri Commands)                       │
│                                                      │
│  tool_read_file(path, start_line, end_line)          │
│  tool_search_in_file(path, query)                    │
│  tool_search_project(query, file_pattern)            │
│  tool_list_directory(path)                           │
│  tool_file_info(path) → {lines, size, language}      │
│  tool_run_command(cmd) → {stdout, stderr, exit_code} │
│                                                      │
└─────────────────────────────────────────────────────┘
```

---

## Tools to Implement

### Core Tools (Phase 1)

| Tool | Description | Parameters |
|------|-------------|------------|
| `read_file` | Read file content with optional line range | `path`, `start_line?`, `end_line?` |
| `search_in_file` | Find text/regex in a specific file | `path`, `query`, `regex?` |
| `search_project` | Search across all project files | `query`, `file_pattern?`, `max_results?` |
| `file_info` | Get file metadata without reading content | `path` → returns `{lines, size_bytes, language}` |
| `list_directory` | List files in a directory | `path`, `recursive?` |

### Extended Tools (Phase 2)

| Tool | Description | Parameters |
|------|-------------|------------|
| `run_command` | Execute a shell command | `command`, `cwd?` |
| `write_file` | Write content to a file | `path`, `content` |
| `edit_file` | Apply search/replace edit | `path`, `search`, `replace` |
| `get_diagnostics` | Get lint/type errors for a file | `path` |
| `git_diff` | Get current git diff | `path?` |
| `git_log` | Get recent git history | `count?`, `path?` |

### Safety Tools (Phase 3)

| Tool | Description | Parameters |
|------|-------------|------------|
| `ask_user` | Ask the user a clarifying question | `question` |
| `confirm_action` | Request user approval before destructive action | `description` |

---

## Implementation Phases

### Phase 1: Gemini Function Calling Integration

**Goal:** Get the basic tool-call loop working with `read_file` and `search_in_file`.

**Steps:**

1. **Define tool schemas for Gemini API**
   - Gemini uses `tools` parameter with `function_declarations`
   - Each tool needs: name, description, parameters (JSON Schema)
   - File: `src/utils/toolDefinitions.ts`

2. **Modify the Rust streaming endpoint**
   - Current: `call_gemini_stream` sends request, streams text tokens
   - New: Must handle `functionCall` responses from Gemini
   - When Gemini returns a `functionCall` instead of text, emit a special event
   - File: `src-tauri/src/lib.rs` (modify `call_gemini_stream`)

3. **Add Rust tool execution commands**
   - `tool_read_file_range(path, start, end)` → returns lines with line numbers
   - `tool_search_in_file(path, query)` → returns matching lines with numbers
   - `tool_search_project(query, pattern)` → returns file:line:content matches
   - `tool_file_info(path)` → returns {lines, size, language}
   - File: `src-tauri/src/tools.rs` (new module)

4. **Implement the tool-call loop in frontend**
   - Listen for `tool-call` events from Rust during streaming
   - When received: execute the tool, get result, send back to Gemini as `functionResponse`
   - Continue streaming until Gemini gives a final text response
   - Show "thinking..." or tool-call indicators in the UI while tools execute
   - File: `src/components/AiChat.tsx` (modify streaming handler)

5. **Update the prompt to remove file content dumping**
   - Instead of attaching full file content, tell Punam she has tools available
   - Add to system prompt: "You have access to tools. Use read_file to read specific lines."
   - Keep the file tree in the prompt (it's small and helps her know what files exist)
   - File: `src/utils/prompts.ts`

**Estimated effort:** 2-3 days

---

### Phase 2: Multi-Turn Tool Execution

**Goal:** Allow Punam to call multiple tools in sequence before responding.

**Steps:**

1. **Support multiple sequential tool calls**
   - Gemini can request multiple tools in one turn
   - Or request one tool, get result, then request another
   - The loop must handle both patterns

2. **Add execution budget**
   - Max 10 tool calls per user message (prevent infinite loops)
   - Max 30 seconds total tool execution time
   - Show progress: "Reading file... Searching... Found it!"

3. **Add write/edit tools**
   - `write_file` — creates or overwrites a file
   - `edit_file` — applies search/replace (same as EDIT blocks but via tool)
   - These require user approval before execution (show diff)

4. **Add command execution tool**
   - `run_command` — runs shell commands
   - Requires approval for dangerous commands (same safety validator you already have)

**Estimated effort:** 2-3 days

---

### Phase 3: OpenAI-Compatible Function Calling

**Goal:** Make tool-use work with OpenAI, Groq, Mistral, and other providers.

**Steps:**

1. **Abstract the tool-call protocol**
   - Gemini uses `functionCall` / `functionResponse` format
   - OpenAI uses `tool_calls` / `tool` message role format
   - Create a unified interface that maps between them

2. **Modify OpenAI streaming endpoint**
   - Handle `tool_calls` in streamed responses
   - Parse `function` field from delta chunks

3. **Fallback for models without function calling**
   - Some free models don't support function calling
   - For these: keep the current "dump file content in prompt" approach
   - Auto-detect capability based on model name/provider

**Estimated effort:** 2 days

---

### Phase 4: UI Enhancements

**Goal:** Show the user what Punam is doing during tool execution.

**Steps:**

1. **Tool execution indicators**
   - Show "📂 Reading ecommerce.py lines 420-430..." during tool calls
   - Show "🔍 Searching project for 'lagoon'..." during search
   - Collapse these into a summary after response completes

2. **Tool call history**
   - Show which tools were called in a collapsible section below the response
   - Helps users understand how Punam arrived at her answer

3. **Approval UI for write operations**
   - When Punam wants to write/edit a file via tool, show a diff preview
   - User clicks "Allow" or "Deny"
   - Integrates with existing MultiFileDiffBoard

**Estimated effort:** 1-2 days

---

## Gemini Function Calling API Format

### Request (with tools defined)

```json
{
  "contents": [...],
  "tools": [{
    "function_declarations": [
      {
        "name": "read_file",
        "description": "Read file content. Returns lines with line numbers.",
        "parameters": {
          "type": "object",
          "properties": {
            "path": { "type": "string", "description": "Relative file path" },
            "start_line": { "type": "integer", "description": "Start line (1-indexed)" },
            "end_line": { "type": "integer", "description": "End line (1-indexed)" }
          },
          "required": ["path"]
        }
      },
      {
        "name": "search_in_file",
        "description": "Search for text in a file. Returns matching lines with numbers.",
        "parameters": {
          "type": "object",
          "properties": {
            "path": { "type": "string", "description": "Relative file path" },
            "query": { "type": "string", "description": "Text or regex to search for" }
          },
          "required": ["path", "query"]
        }
      }
    ]
  }]
}
```

### Response (tool call)

```json
{
  "candidates": [{
    "content": {
      "parts": [{
        "functionCall": {
          "name": "read_file",
          "args": { "path": "ecommerce.py", "start_line": 426, "end_line": 426 }
        }
      }]
    }
  }]
}
```

### Follow-up (tool result)

```json
{
  "contents": [
    ...previous_messages,
    {
      "role": "model",
      "parts": [{ "functionCall": { "name": "read_file", "args": {...} } }]
    },
    {
      "role": "user",
      "parts": [{ "functionResponse": { "name": "read_file", "response": { "content": "426: lagoon" } } }]
    }
  ]
}
```

---

## File Structure (New/Modified)

```
src/
  utils/
    toolDefinitions.ts    ← NEW: Tool schemas for Gemini/OpenAI
    toolExecutor.ts       ← NEW: Frontend tool execution dispatcher
  components/
    AiChat.tsx            ← MODIFY: Add tool-call loop to streaming handler
    chat/
      ToolCallIndicator.tsx ← NEW: UI for showing tool execution progress

src-tauri/src/
  tools.rs               ← NEW: Rust tool implementations
  lib.rs                 ← MODIFY: Register tool commands, modify streaming to handle functionCall
```

---

## Risk Assessment

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Gemini function calling adds latency | High | Medium | Each tool call adds ~200ms. Cap at 10 calls. Show progress UI. |
| Model calls wrong tool or bad params | Medium | Low | Validate params before execution. Return clear error messages. |
| Infinite tool-call loop | Low | High | Hard cap at 10 calls per message. Timeout at 30s. |
| Write tool modifies wrong file | Low | High | All write operations require user approval + diff preview. |
| Free models don't support function calling | High | Medium | Fallback to current prompt-dumping approach for those models. |
| Breaking change to streaming protocol | Medium | Medium | Keep old streaming path as fallback. Feature-flag the tool system. |

---

## Priority Order

1. **Phase 1** — This alone solves the "can't read line 426" problem
2. **Phase 4** — UI indicators (do alongside Phase 1)
3. **Phase 2** — Multi-turn + write tools (makes her truly agentic)
4. **Phase 3** — OpenAI compatibility (broader model support)

---

## Success Criteria

After Phase 1 is complete:
- User asks "what's on line 426?" → Punam calls `read_file(path, 426, 426)` → answers correctly
- User asks "find the word lagoon" → Punam calls `search_in_file(path, "lagoon")` → returns exact line
- User asks "how many lines in this file?" → Punam calls `file_info(path)` → answers with exact count
- No more truncation issues regardless of file size
- Works with Gemini 2.5 Flash (function calling supported)
