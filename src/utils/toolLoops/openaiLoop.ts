// src/utils/toolLoops/openaiLoop.ts
//
// OpenAI-compatible Tool Loop for providers that support native function calling:
// DeepSeek, Groq, Mistral, OpenAI, Ollama, OpenRouter.
//
// Key difference from jsonFallbackLoop:
//   - Maintains full messages array with tool/assistant/user turns
//   - Tool results are returned as { role: "tool", tool_call_id, content }
//   - Model sees its own prior actions on every round (no memory loss)

import { invoke } from "@tauri-apps/api/core";
import {
  executeAgentTool,
  normalizeAgentToolCall,
  AGENT_TOOL_DEFINITIONS,
  type ToolCall,
} from "../agentTools";
import {
  type ToolLoopOptions,
  type ToolObservation,
  throwIfCancelled,
  recordLoopMetrics,
  recordToolObservation,
  synthesizeFinalAnswer,
  MAX_VERIFICATION_RETRIES,
} from "./shared";
import { gatePatchWithApproval } from "./approvalGate";
import {
  buildPatchProposalFromToolArgs,
  isPatchTool,
  buildRejectionContext,
} from "./approvalHelpers";
import { executeToolWithVerification, isMutatingTool } from "./verification";

// ── Types ──────────────────────────────────────────────────────────────────

interface OpenAIMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: OpenAIToolCall[];
  tool_call_id?: string;
  name?: string;
}

interface OpenAIToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

interface OpenAIWithToolsResult {
  text: string;
  success: boolean;
  error?: string;
  tool_calls?: Array<{
    id: string;
    name: string;
    arguments: string;
  }>;
}

// ── Convert Anthropic-schema tools to OpenAI function format ──────────────
// AGENT_TOOL_DEFINITIONS uses { name, description, input_schema } (Anthropic format)
// OpenAI wants { type: "function", function: { name, description, parameters } }

const OPENAI_TOOL_DEFINITIONS = AGENT_TOOL_DEFINITIONS.map((tool) => ({
  type: "function" as const,
  function: {
    name: tool.name,
    description: tool.description,
    parameters: tool.input_schema,
  },
}));

// ── Main Loop ──────────────────────────────────────────────────────────────

export async function runOpenAIToolLoop(opts: ToolLoopOptions): Promise<string> {
  const {
    provider,
    modelId,
    systemPrompt,
    task,
    projectPath,
    activeFilePath,
    maxRounds = 15,
    onToolCall,
  } = opts;

  const fileHint = activeFilePath
    ? `\n\nCurrently open in editor: ${activeFilePath}`
    : "";

  // Persistent messages array — this is the key difference from jsonFallbackLoop.
  // Every turn (user, assistant, tool results) is appended here so the model
  // sees its full history on every round.
  const messages: OpenAIMessage[] = [
    { role: "system", content: systemPrompt },
    { role: "user", content: task + fileHint },
  ];

  const observations: ToolObservation[] = [];
  const seenToolCallIds = new Set<string>();
  let lastText = "";

  for (let round = 0; round < maxRounds; round++) {
    throwIfCancelled(opts);

    // ── Call the model with full conversation history ──────────────────────
    let result: OpenAIWithToolsResult;
    try {
      result = await invoke<OpenAIWithToolsResult>("call_openai_compatible_with_tools", {
        apiKey: provider.apiKey,
        baseUrl: provider.baseUrl ?? "https://api.openai.com/v1",
        model: modelId,
        messages,
        tools: OPENAI_TOOL_DEFINITIONS,
        isOpenRouter: (provider.baseUrl ?? "").includes("openrouter.ai"),
      });
    } catch (err) {
      throw new Error(`[OpenAIToolLoop] Round ${round} invoke failed: ${String(err)}`);
    }

    // Reset per-round timeout after each successful API call
    if ((opts as any)._resetTimeout) (opts as any)._resetTimeout();

    if (!result.success) {
      throw new Error(`[OpenAIToolLoop] API error: ${result.error ?? "unknown"}`);
    }

    lastText = result.text ?? "";

    // ── No tool calls — model is done ─────────────────────────────────────
    if (!result.tool_calls || result.tool_calls.length === 0) {
      messages.push({ role: "assistant", content: lastText });
      break;
    }

    // ── Model made tool calls — add assistant turn to history ─────────────
    const assistantMsg: OpenAIMessage = {
      role: "assistant",
      content: lastText || null,
      tool_calls: result.tool_calls.map((tc) => ({
        id: tc.id,
        type: "function",
        function: { name: tc.name, arguments: tc.arguments },
      })),
    };
    messages.push(assistantMsg);

    // ── Execute each tool call ─────────────────────────────────────────────
    for (const toolCall of result.tool_calls) {
      throwIfCancelled(opts);

      // Deduplicate by tool_call_id
      if (seenToolCallIds.has(toolCall.id)) {
        messages.push({
          role: "tool",
          tool_call_id: toolCall.id,
          name: toolCall.name,
          content: `Duplicate tool call id skipped: ${toolCall.id}`,
        });
        continue;
      }
      seenToolCallIds.add(toolCall.id);

      // Parse arguments
      let toolInput: Record<string, unknown>;
      try {
        toolInput = JSON.parse(toolCall.arguments);
      } catch {
        toolInput = { raw: toolCall.arguments };
      }

      // Build a ToolCall object matching the existing type
      const rawToolCall: ToolCall = {
        id: toolCall.id,
        name: toolCall.name as any,
        input: toolInput,
      };

      // Normalize field aliases (e.g. "file" → "path", "cmd" → "command")
      const normalized = normalizeAgentToolCall(rawToolCall) as ToolCall;
      const normalizedName = normalized.name;
      const normalizedInput = normalized.input as Record<string, unknown>;

      onToolCall?.(normalizedName, normalizedInput);

      let toolResultContent: string;
      let isError = false;

      // ── Approval gate for patch/write tools ─────────────────────────────
      if (isPatchTool(normalizedName)) {
        const proposal = buildPatchProposalFromToolArgs(normalizedName, normalizedInput, lastText);
        const decision = await gatePatchWithApproval(proposal);
        throwIfCancelled(opts);

        if (!decision.accepted) {
          toolResultContent = buildRejectionContext(proposal, decision.reason);
          opts.onToolResult?.(normalizedName, normalizedInput, toolResultContent, false);
          recordToolObservation(observations, normalizedName, normalizedInput, {
            tool_use_id: toolCall.id,
            content: toolResultContent,
            is_error: false,
          });
          messages.push({
            role: "tool",
            tool_call_id: toolCall.id,
            name: normalizedName,
            content: toolResultContent,
          });
          continue;
        }

        if (decision.editedPatch) {
          (normalizedInput as any).patch = decision.editedPatch;
        }
      }

      // ── Verification for mutating tools ──────────────────────────────────
      if (isMutatingTool(normalizedName) && opts.enableAutoVerify !== false) {
        const verifyResult = await executeToolWithVerification(
          normalizedName,
          normalizedInput,
          projectPath,
          1,
          opts.onBeforeWrite,
        );
        throwIfCancelled(opts);

        toolResultContent = verifyResult.success
          ? verifyResult.output + "\n✅ Edit verified"
          : verifyResult.output;
        isError = !verifyResult.success;

        opts.onToolResult?.(normalizedName, normalizedInput, toolResultContent, isError);
        recordToolObservation(observations, normalizedName, normalizedInput, {
          tool_use_id: toolCall.id,
          content: toolResultContent,
          is_error: isError,
        });
        messages.push({
          role: "tool",
          tool_call_id: toolCall.id,
          name: normalizedName,
          content: toolResultContent,
        });
        continue;
      }

      // ── Non-mutating / direct execution ──────────────────────────────────
      const execResult = await executeAgentTool(normalized, projectPath, opts.onBeforeWrite);
      throwIfCancelled(opts);

      toolResultContent = execResult.content;
      isError = execResult.is_error;

      opts.onToolResult?.(normalizedName, normalizedInput, toolResultContent, isError);
      recordToolObservation(observations, normalizedName, normalizedInput, execResult);

      // THIS IS THE CRITICAL PART — tool result goes back into messages
      // so the model sees it on the next round
      messages.push({
        role: "tool",
        tool_call_id: toolCall.id,
        name: normalizedName,
        content: toolResultContent,
      });
    }

    // ── Circuit breaker: halt loop if writes are blocked by user action ──
    const lastToolMessages = messages.filter((m) => m.role === "tool").slice(-result.tool_calls!.length);
    const writeBlocked = lastToolMessages.some(
      (m) =>
        typeof m.content === "string" &&
        (m.content.includes("rejected by user") ||
         m.content.includes("active inline diff preview") ||
         m.content.includes("Patch rejected by user"))
    );
    if (writeBlocked) {
      const haltMessage = "⏸️ Paused: File edits are awaiting your review in the inline diff preview. Accept or reject the changes, then re-run the task.";
      opts.onToken?.(haltMessage);
      return haltMessage;
    }

    // Continue to next round — model now sees all tool results in messages
  }

  return lastText || await synthesizeFinalAnswer(opts, observations, "");
}
