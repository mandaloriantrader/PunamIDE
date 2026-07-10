// src/utils/toolLoops/jsonFallbackLoop.ts
//
// JSON-based fallback tool loop for providers that don't support native tool calling
// (OpenAI-compatible, Groq, local models, etc.)

import {
  executeAgentTool,
  normalizeAgentToolCall,
  buildToolSystemPrompt,
  parseJsonToolCall,
} from "../agentTools";
import {
  type ToolLoopOptions,
  type ToolObservation,
  MAX_VERIFICATION_RETRIES,
  throwIfCancelled,
  recordLoopMetrics,
  toolCallKey,
  duplicateToolResult,
  recordToolObservation,
  synthesizeFinalAnswer,
} from "./shared";
import { executeToolWithVerification, isMutatingTool } from "./verification";
import { gatePatchWithApproval, type PatchProposal, type ApprovalDecision } from "./approvalGate";
import { buildPatchProposalFromToolArgs, isPatchTool, buildRejectionContext, buildPartialAcceptanceContext } from "./approvalHelpers";

// ── JSON fallback tool loop ──────────────────────────────────────────────────

export async function runJsonFallbackToolLoop(opts: ToolLoopOptions): Promise<string> {
  const {
    provider,
    modelId,
    systemPrompt,
    task,
    projectPath,
    activeFilePath,
    maxRounds = 10,
    onToolCall,
  } = opts;

  const fileHint = activeFilePath
    ? `\n\nCurrently open in editor: ${activeFilePath}`
    : "";

  const fullSystem = `${systemPrompt}\n\n${buildToolSystemPrompt()}`;

  const conversationParts: string[] = [];
  const observations: ToolObservation[] = [];
  const seenToolCalls = new Set<string>();
  let userTurn = task + fileHint;
  let lastText = "";

  for (let round = 0; round < maxRounds; round++) {
    throwIfCancelled(opts);
    const fullPrompt =
      conversationParts.length > 0
        ? conversationParts.join("\n\n") + "\n\nUser: " + userTurn
        : userTurn;

    const { sendToProviderStreaming } = await import("../providers");
    const resp = await sendToProviderStreaming(provider, modelId, {
      systemPrompt: fullSystem,
      userPrompt: fullPrompt,
      signal: opts.signal,
    });
    recordLoopMetrics(opts, resp.metrics);

    // Reset per-round timeout after each successful API response
    if ((opts as any)._resetTimeout) (opts as any)._resetTimeout();

    if (!resp.success) {
      throw new Error(resp.error || "Provider error");
    }

    throwIfCancelled(opts);
    const responseText = resp.text;
    lastText = responseText;

    const toolCall = parseJsonToolCall(responseText);

    if (!toolCall) {
      const toolIntent = /\b(list|read|search|find|check|look|show|get)\b/i;
      if (toolIntent.test(responseText)) {
        conversationParts.push(
          `Assistant:\n${responseText}`,
          "Tool result: Please output ONLY a JSON tool call block (```json { \"tool\": \"...\", \"input\": {...} } ```) to proceed. Do not output any other text."
        );
        userTurn = "Output the tool call now.";
        continue;
      }
      return responseText;
    }

    throwIfCancelled(opts);
    const normalizedToolCall = normalizeAgentToolCall(toolCall);
    const normalizedName = "tool" in normalizedToolCall ? normalizedToolCall.tool : normalizedToolCall.name;
    const normalizedInput = normalizedToolCall.input as Record<string, unknown>;
    const key = toolCallKey(normalizedName, normalizedInput);
    if (seenToolCalls.has(key)) {
      conversationParts.push(
        `Assistant:\n${responseText}`,
        `Tool result (${normalizedName}):\n${duplicateToolResult(normalizedName)}`
      );
      userTurn = "Do not repeat the same tool call. Write the final answer now if you have enough information, or choose a different useful tool.";
      continue;
    }
    seenToolCalls.add(key);
    onToolCall?.(normalizedName, normalizedInput);
    throwIfCancelled(opts);

    // ── Approval gate for patch tools ────────────────────────────────────
    if (isPatchTool(normalizedName)) {
      const proposal = buildPatchProposalFromToolArgs(normalizedName, normalizedInput, lastText);
      const decision = await gatePatchWithApproval(proposal);
      throwIfCancelled(opts);

      if (!decision.accepted) {
        // User rejected — inject rejection context into conversation
        const rejectionContent = buildRejectionContext(proposal, decision.reason);
        opts.onToolResult?.(normalizedName, normalizedInput, rejectionContent, false);
        recordToolObservation(observations, normalizedName, normalizedInput, {
          tool_use_id: `json-${normalizedName}-${Date.now()}`,
          content: rejectionContent,
          is_error: false,
        });
        conversationParts.push(
          `Assistant:\n${responseText}`,
          `Tool result (${normalizedName}):\n${rejectionContent}`
        );
        userTurn = "The user rejected this edit. Acknowledge the rejection and ask what they'd prefer instead.";
        continue;
      }

      // Partial acceptance — apply only accepted hunks
      if (decision.acceptedHunks && decision.acceptedHunks.length < proposal.hunks.length) {
        const partialContext = buildPartialAcceptanceContext(proposal, decision.acceptedHunks);
        if (decision.editedPatch) {
          (normalizedInput as any).patch = decision.editedPatch;
        }
      }
    }

    // ── Verification wrapper for mutating tools ──────────────────────────
    if (isMutatingTool(normalizedName) && opts.enableAutoVerify !== false) {
      let attempt = 1;
      let lastVerificationOutput = "";

      while (attempt <= MAX_VERIFICATION_RETRIES) {
        throwIfCancelled(opts);
        const verifyResult = await executeToolWithVerification(
          normalizedName,
          normalizedInput,
          projectPath,
          attempt,
          opts.onBeforeWrite,
        );
        throwIfCancelled(opts);

        if (verifyResult.success) {
          // Verification passed
          const verifiedContent = verifyResult.output + "\n✅ Edit verified";
          opts.onToolResult?.(normalizedName, normalizedInput, verifiedContent, false);
          recordToolObservation(observations, normalizedName, normalizedInput, {
            tool_use_id: `json-${normalizedName}-${Date.now()}`,
            content: verifiedContent,
            is_error: false,
          });
          conversationParts.push(
            `Assistant:\n${responseText}`,
            `Tool result (${normalizedName}):\n${verifiedContent}`
          );
          userTurn = "Continue based on the tool result above.";
          break;
        }

        lastVerificationOutput = verifyResult.output;

        // Max retries reached — halt with error
        if (attempt >= MAX_VERIFICATION_RETRIES) {
          opts.onError?.(`❌ Edit verification failed after ${MAX_VERIFICATION_RETRIES} attempts for ${normalizedName}`);
          opts.onToolResult?.(normalizedName, normalizedInput, lastVerificationOutput, true);
          recordToolObservation(observations, normalizedName, normalizedInput, {
            tool_use_id: `json-${normalizedName}-${Date.now()}`,
            content: lastVerificationOutput,
            is_error: true,
          });
          conversationParts.push(
            `Assistant:\n${responseText}`,
            `Tool result (${normalizedName}):\n${lastVerificationOutput}`
          );
          // Halt the loop — return the error to the user
          return lastVerificationOutput;
        }

        // Inject failure context for retry — ask LLM to re-attempt
        conversationParts.push(
          `Assistant:\n${responseText}`,
          `Tool result (${normalizedName}):\n${lastVerificationOutput}`
        );
        userTurn = "The edit failed verification. Re-read the file and retry with corrected content.";

        // Get a new response from the LLM
        throwIfCancelled(opts);
        const retryPrompt =
          conversationParts.join("\n\n") + "\n\nUser: " + userTurn;

        const { sendToProviderStreaming } = await import("../providers");
        const retryResp = await sendToProviderStreaming(provider, modelId, {
          systemPrompt: fullSystem,
          userPrompt: retryPrompt,
          signal: opts.signal,
        });
        recordLoopMetrics(opts, retryResp.metrics);
        throwIfCancelled(opts);

        if (!retryResp.success) {
          // Provider error during retry — halt
          opts.onToolResult?.(normalizedName, normalizedInput, lastVerificationOutput, true);
          return lastVerificationOutput;
        }

        const retryToolCall = parseJsonToolCall(retryResp.text);
        if (!retryToolCall) {
          // LLM didn't produce a retry tool call — halt with the failure
          opts.onToolResult?.(normalizedName, normalizedInput, lastVerificationOutput, true);
          return retryResp.text || lastVerificationOutput;
        }

        // Update input with LLM's corrected arguments
        const retryNorm = normalizeAgentToolCall(retryToolCall);
        const retryInput = retryNorm.input as Record<string, unknown>;
        Object.assign(normalizedInput, retryInput);

        conversationParts.push(`Assistant:\n${retryResp.text}`);
        lastText = retryResp.text;
        attempt++;
      }
      continue;
    }

    // ── Non-mutating tools: direct execution ─────────────────────────────
    const result = await executeAgentTool(normalizedToolCall, projectPath, opts.onBeforeWrite);
    throwIfCancelled(opts);
    opts.onToolResult?.(normalizedName, normalizedInput, result.content, result.is_error);
    recordToolObservation(observations, normalizedName, normalizedInput, result);

    conversationParts.push(
      `Assistant:\n${responseText}`,
      `Tool result (${normalizedName}):\n${result.content}`
    );

    // ── Circuit breaker: halt loop if writes are blocked by user action ──
    if (
      result.is_error &&
      (result.content.includes("rejected by user") ||
       result.content.includes("active inline diff preview") ||
       result.content.includes("Patch rejected by user"))
    ) {
      const haltMessage = "⏸️ Paused: File edits are awaiting your review in the inline diff preview. Accept or reject the changes, then re-run the task.";
      opts.onToken?.(haltMessage);
      return haltMessage;
    }

    userTurn = "Continue based on the tool result above.";
  }

  return synthesizeFinalAnswer(opts, observations, lastText);
}
