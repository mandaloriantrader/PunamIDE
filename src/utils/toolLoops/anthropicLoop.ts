// src/utils/toolLoops/anthropicLoop.ts
//
// Anthropic native tool-calling loop + HTTP adapter.

import type { AIProviderConfig } from "../providers";
import {
  AGENT_TOOL_DEFINITIONS,
  executeAgentTool,
  normalizeAgentToolCall,
  type ToolCall,
  type ToolResult,
} from "../agentTools";
import {
  type ToolLoopOptions,
  type ToolObservation,
  MAX_VERIFICATION_RETRIES,
  throwIfCancelled,
  toolCallKey,
  duplicateToolResult,
  recordToolObservation,
  synthesizeFinalAnswer,
} from "./shared";
import { executeToolWithVerification, isMutatingTool } from "./verification";
import { gatePatchWithApproval, type PatchProposal, type ApprovalDecision } from "./approvalGate";
import { buildPatchProposalFromToolArgs, isPatchTool, buildRejectionContext, buildPartialAcceptanceContext } from "./approvalHelpers";

// ── Anthropic-specific types ─────────────────────────────────────────────────

interface AnthropicMessage {
  role: "user" | "assistant";
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  content: any;
}

interface AnthropicResponse {
  stop_reason: "end_turn" | "tool_use" | "max_tokens" | string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  content: any[];
}

// ── Anthropic API call ───────────────────────────────────────────────────────

export async function callAnthropicWithTools(
  provider: AIProviderConfig,
  modelId: string,
  systemPrompt: string,
  messages: AnthropicMessage[],
  _onToken?: (token: string) => void
): Promise<AnthropicResponse> {
  const baseUrl = provider.baseUrl || "https://api.anthropic.com";
  const apiKey = provider.apiKey;

  const response = await fetch(`${baseUrl}/v1/messages`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: modelId,
      max_tokens: 4096,
      system: systemPrompt,
      tools: AGENT_TOOL_DEFINITIONS,
      messages,
    }),
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Anthropic API error ${response.status}: ${errText}`);
  }

  return response.json() as Promise<AnthropicResponse>;
}

// ── Anthropic tool loop ──────────────────────────────────────────────────────

export async function runAnthropicToolLoop(opts: ToolLoopOptions): Promise<string> {
  const {
    provider,
    modelId,
    systemPrompt,
    task,
    projectPath,
    activeFilePath,
    maxRounds = 10,
    onToken,
    onToolCall,
  } = opts;

  const fileHint = activeFilePath
    ? `\n\nCurrently open in editor: ${activeFilePath}`
    : "";

  type Message =
    | { role: "user"; content: string | AnthropicContent[] }
    | { role: "assistant"; content: AnthropicContent[] };

  type AnthropicContent =
    | { type: "text"; text: string }
    | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
    | { type: "tool_result"; tool_use_id: string; content: string; is_error?: boolean };

  const messages: Message[] = [
    { role: "user", content: task + fileHint },
  ];

  let finalText = "";
  const observations: ToolObservation[] = [];
  const seenToolCalls = new Set<string>();

  for (let round = 0; round < maxRounds; round++) {
    throwIfCancelled(opts);
    const response = await callAnthropicWithTools(
      provider,
      modelId,
      systemPrompt,
      messages,
      onToken
    );
    // Reset per-round timeout after each successful API response
    if ((opts as any)._resetTimeout) (opts as any)._resetTimeout();
    throwIfCancelled(opts);

    const textBlocks = response.content.filter(
      (b): b is { type: "text"; text: string } => b.type === "text"
    );
    const toolUseBlocks = response.content.filter(
      (b): b is ToolCall & { type: "tool_use" } => b.type === "tool_use"
    );

    if (textBlocks.length > 0) {
      finalText = textBlocks.map((b) => b.text).join("");
    }

    if (response.stop_reason === "end_turn" || toolUseBlocks.length === 0) {
      return finalText;
    }

    const toolResults: AnthropicContent[] = [];
    await Promise.all(
      toolUseBlocks.map(async (block) => {
        throwIfCancelled(opts);
        const normalized = normalizeAgentToolCall(
          { id: block.id, name: block.name as ToolCall["name"], input: block.input }
        ) as ToolCall;
        const input = normalized.input as Record<string, unknown>;
        const key = toolCallKey(normalized.name, input);
        if (seenToolCalls.has(key)) {
          toolResults.push({
            type: "tool_result",
            tool_use_id: block.id,
            content: duplicateToolResult(normalized.name),
            is_error: false,
          });
          return;
        }
        seenToolCalls.add(key);
        onToolCall?.(normalized.name, input);
        throwIfCancelled(opts);

        // ── Approval gate for patch tools ────────────────────────────────
        if (isPatchTool(normalized.name)) {
          const proposal = buildPatchProposalFromToolArgs(normalized.name, input, finalText);
          const decision = await gatePatchWithApproval(proposal);
          throwIfCancelled(opts);

          if (!decision.accepted) {
            // User rejected — inject rejection context into conversation
            const rejectionContent = buildRejectionContext(proposal, decision.reason);
            opts.onToolResult?.(normalized.name, input, rejectionContent, false);
            recordToolObservation(observations, normalized.name, input, {
              tool_use_id: block.id,
              content: rejectionContent,
              is_error: false,
            });
            toolResults.push({
              type: "tool_result",
              tool_use_id: block.id,
              content: rejectionContent,
              is_error: false,
            });
            return;
          }

          // Partial acceptance — apply only accepted hunks
          if (decision.acceptedHunks && decision.acceptedHunks.length < proposal.hunks.length) {
            const partialContext = buildPartialAcceptanceContext(proposal, decision.acceptedHunks);
            // Update input to only apply accepted hunks
            if (decision.editedPatch) {
              (input as any).patch = decision.editedPatch;
            }
            // Continue to execution with the narrowed patch
          }
        }

        // ── Verification wrapper for mutating tools ──────────────────────
        if (isMutatingTool(normalized.name) && opts.enableAutoVerify !== false) {
          let attempt = 1;
          let lastVerificationOutput = "";

          while (attempt <= MAX_VERIFICATION_RETRIES) {
            throwIfCancelled(opts);
            const verifyResult = await executeToolWithVerification(
              normalized.name,
              input,
              projectPath,
              attempt,
              opts.onBeforeWrite,
            );
            throwIfCancelled(opts);

            if (verifyResult.success) {
              // Verification passed — report with ✅ marker
              const verifiedContent = verifyResult.output + "\n✅ Edit verified";
              opts.onToolResult?.(normalized.name, input, verifiedContent, false);
              recordToolObservation(observations, normalized.name, input, {
                tool_use_id: block.id,
                content: verifiedContent,
                is_error: false,
              });
              toolResults.push({
                type: "tool_result",
                tool_use_id: block.id,
                content: verifiedContent,
                is_error: false,
              });
              return;
            }

            lastVerificationOutput = verifyResult.output;

            // Max retries reached — halt the loop with error
            if (attempt >= MAX_VERIFICATION_RETRIES) {
              const haltContent = verifyResult.output;
              opts.onToolResult?.(normalized.name, input, haltContent, true);
              opts.onError?.(`❌ Edit verification failed after ${MAX_VERIFICATION_RETRIES} attempts for ${normalized.name}`);
              recordToolObservation(observations, normalized.name, input, {
                tool_use_id: block.id,
                content: haltContent,
                is_error: true,
              });
              toolResults.push({
                type: "tool_result",
                tool_use_id: block.id,
                content: haltContent,
                is_error: true,
              });
              return;
            }

            // Verification failed, attempt < max — inject failure context for retry
            // Push current assistant + tool_result with failure context, then re-enter loop for next round
            messages.push({ role: "assistant", content: response.content });
            messages.push({
              role: "user",
              content: [{
                type: "tool_result",
                tool_use_id: block.id,
                content: lastVerificationOutput,
                is_error: true,
              }],
            });

            // Request a new response from the LLM for retry
            throwIfCancelled(opts);
            const retryResponse = await callAnthropicWithTools(
              provider,
              modelId,
              systemPrompt,
              messages,
              onToken
            );
            throwIfCancelled(opts);

            // Extract retried tool calls
            const retryToolBlocks = retryResponse.content.filter(
              (b): b is ToolCall & { type: "tool_use" } => b.type === "tool_use"
            );
            const retryTextBlocks = retryResponse.content.filter(
              (b): b is { type: "text"; text: string } => b.type === "text"
            );
            if (retryTextBlocks.length > 0) {
              finalText = retryTextBlocks.map((b) => b.text).join("");
            }

            // Find the retry for this same tool (or any mutating tool targeting same file)
            const retryBlock = retryToolBlocks.find(
              (b) => isMutatingTool(b.name)
            ) || retryToolBlocks[0];

            if (!retryBlock) {
              // LLM gave up — use last failure as final result
              opts.onToolResult?.(normalized.name, input, lastVerificationOutput, true);
              recordToolObservation(observations, normalized.name, input, {
                tool_use_id: block.id,
                content: lastVerificationOutput,
                is_error: true,
              });
              toolResults.push({
                type: "tool_result",
                tool_use_id: block.id,
                content: lastVerificationOutput,
                is_error: true,
              });
              return;
            }

            // Update input for the retry attempt with LLM's corrected args
            Object.assign(input, retryBlock.input);
            // Update messages with the retry response
            messages.push({ role: "assistant", content: retryResponse.content });

            attempt++;
          }
          return;
        }

        // ── Non-mutating tools: direct execution ─────────────────────────
        const result: ToolResult = await executeAgentTool(normalized, projectPath, opts.onBeforeWrite);
        throwIfCancelled(opts);
        opts.onToolResult?.(normalized.name, input, result.content, result.is_error);
        recordToolObservation(observations, normalized.name, input, result);
        toolResults.push({
          type: "tool_result",
          tool_use_id: result.tool_use_id,
          content: result.content,
          is_error: result.is_error,
        });
      })
    );

    messages.push({ role: "assistant", content: response.content });
    messages.push({ role: "user", content: toolResults });

    // ── Circuit breaker: halt loop if writes are blocked by user action ──
    const writeBlockedResults = toolResults.filter(
      (r: AnthropicContent) =>
        r.type === "tool_result" &&
        r.is_error &&
        typeof r.content === "string" &&
        (r.content.includes("rejected by user") ||
         r.content.includes("active inline diff preview") ||
         r.content.includes("Patch rejected by user"))
    );
    if (writeBlockedResults.length > 0) {
      // Writes are blocked — stop the loop and inform the user
      const haltMessage = "⏸️ Paused: File edits are awaiting your review in the inline diff preview. Accept or reject the changes, then re-run the task.";
      opts.onToken?.(haltMessage);
      return haltMessage;
    }
  }

  return synthesizeFinalAnswer(opts, observations, finalText);
}
