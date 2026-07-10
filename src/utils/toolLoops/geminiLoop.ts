// src/utils/toolLoops/geminiLoop.ts
//
// Gemini native function-calling loop + HTTP adapter.

import {
  AGENT_TOOL_DEFINITIONS,
  executeAgentTool,
  normalizeAgentToolCall,
  type ToolCall,
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

// ── Gemini-specific types ────────────────────────────────────────────────────

interface GeminiPart {
  text?: string;
  functionCall?: { name: string; args: Record<string, unknown> };
  functionResponse?: { name: string; response: { content: string } };
}

interface GeminiContent {
  role: "user" | "model";
  parts: GeminiPart[];
}

interface GeminiResponse {
  candidates: Array<{
    content: { role: string; parts: GeminiPart[] };
    finishReason: string;
  }>;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function toGeminiFunctionDeclarations() {
  return AGENT_TOOL_DEFINITIONS.map((tool) => ({
    name: tool.name,
    description: tool.description,
    parameters: tool.input_schema,
  }));
}

// ── Gemini API call ──────────────────────────────────────────────────────────

export async function callGeminiWithTools(
  apiKey: string,
  modelId: string,
  systemPrompt: string,
  contents: GeminiContent[]
): Promise<GeminiResponse> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelId}:generateContent?key=${apiKey}`;

  const body = {
    system_instruction: { parts: [{ text: systemPrompt }] },
    contents,
    tools: [{ functionDeclarations: toGeminiFunctionDeclarations() }],
    tool_config: { function_calling_config: { mode: "AUTO" } },
    generationConfig: { temperature: 0.3, maxOutputTokens: 8192 },
  };

  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`Gemini API error ${resp.status}: ${errText.slice(0, 300)}`);
  }

  return resp.json() as Promise<GeminiResponse>;
}

// ── Gemini tool loop ─────────────────────────────────────────────────────────

export async function runGeminiToolLoop(opts: ToolLoopOptions): Promise<string> {
  const {
    provider,
    modelId,
    systemPrompt,
    task,
    projectPath,
    activeFilePath,
    maxRounds = 10,
    onToolCall,
    onToolResult,
  } = opts;

  const fileHint = activeFilePath
    ? `\n\nCurrently open in editor: ${activeFilePath}`
    : "";

  const contents: GeminiContent[] = [
    { role: "user", parts: [{ text: task + fileHint }] },
  ];

  let finalText = "";
  const observations: ToolObservation[] = [];
  const seenToolCalls = new Set<string>();

  for (let round = 0; round < maxRounds; round++) {
    throwIfCancelled(opts);
    const response = await callGeminiWithTools(
      provider.apiKey,
      modelId,
      systemPrompt,
      contents
    );
    // Reset per-round timeout after each successful API response
    if ((opts as any)._resetTimeout) (opts as any)._resetTimeout();
    throwIfCancelled(opts);

    const candidate = response.candidates?.[0];
    if (!candidate) throw new Error("Gemini returned no candidates");

    const parts = candidate.content?.parts ?? [];
    const finishReason = candidate.finishReason;

    const textParts = parts.filter((p): p is { text: string } => typeof p.text === "string");
    if (textParts.length > 0) {
      finalText = textParts.map((p) => p.text).join("");
    }

    const fnCalls = parts.filter(
      (p): p is { functionCall: { name: string; args: Record<string, unknown> } } =>
        p.functionCall !== undefined
    );

    if (fnCalls.length === 0 || finishReason === "STOP") {
      return finalText;
    }

    contents.push({ role: "model", parts });

    const responseParts: GeminiPart[] = [];
    await Promise.all(
      fnCalls.map(async (fc) => {
        throwIfCancelled(opts);
        const normalized = normalizeAgentToolCall({
          tool: fc.functionCall.name as ToolCall["name"],
          input: fc.functionCall.args,
        });
        const normalizedName = "tool" in normalized ? normalized.tool : normalized.name;
        const input = normalized.input as Record<string, unknown>;
        const key = toolCallKey(normalizedName, input);
        if (seenToolCalls.has(key)) {
          responseParts.push({
            functionResponse: {
              name: normalizedName,
              response: { content: duplicateToolResult(normalizedName) },
            },
          });
          return;
        }
        seenToolCalls.add(key);
        onToolCall?.(normalizedName, input);
        throwIfCancelled(opts);

        // ── Approval gate for patch tools ────────────────────────────────
        if (isPatchTool(normalizedName)) {
          const proposal = buildPatchProposalFromToolArgs(normalizedName, input, finalText);
          const decision = await gatePatchWithApproval(proposal);
          throwIfCancelled(opts);

          if (!decision.accepted) {
            // User rejected — inject rejection context into conversation
            const rejectionContent = buildRejectionContext(proposal, decision.reason);
            onToolResult?.(normalizedName, input, rejectionContent, false);
            recordToolObservation(observations, normalizedName, input, {
              tool_use_id: `gemini-${normalizedName}-${Date.now()}`,
              content: rejectionContent,
              is_error: false,
            });
            responseParts.push({
              functionResponse: {
                name: normalizedName,
                response: { content: rejectionContent },
              },
            });
            return;
          }

          // Partial acceptance — apply only accepted hunks
          if (decision.acceptedHunks && decision.acceptedHunks.length < proposal.hunks.length) {
            const partialContext = buildPartialAcceptanceContext(proposal, decision.acceptedHunks);
            if (decision.editedPatch) {
              (input as any).patch = decision.editedPatch;
            }
          }
        }

        // ── Verification wrapper for mutating tools ──────────────────────
        if (isMutatingTool(normalizedName) && opts.enableAutoVerify !== false) {
          let attempt = 1;
          let lastVerificationOutput = "";

          while (attempt <= MAX_VERIFICATION_RETRIES) {
            throwIfCancelled(opts);
            const verifyResult = await executeToolWithVerification(
              normalizedName,
              input,
              projectPath,
              attempt,
              opts.onBeforeWrite,
            );
            throwIfCancelled(opts);

            if (verifyResult.success) {
              // Verification passed
              const verifiedContent = verifyResult.output + "\n✅ Edit verified";
              onToolResult?.(normalizedName, input, verifiedContent, false);
              recordToolObservation(observations, normalizedName, input, {
                tool_use_id: `gemini-${normalizedName}-${Date.now()}`,
                content: verifiedContent,
                is_error: false,
              });
              responseParts.push({
                functionResponse: {
                  name: normalizedName,
                  response: { content: verifiedContent },
                },
              });
              return;
            }

            lastVerificationOutput = verifyResult.output;

            // Max retries reached — halt with error
            if (attempt >= MAX_VERIFICATION_RETRIES) {
              opts.onError?.(`❌ Edit verification failed after ${MAX_VERIFICATION_RETRIES} attempts for ${normalizedName}`);
              onToolResult?.(normalizedName, input, lastVerificationOutput, true);
              recordToolObservation(observations, normalizedName, input, {
                tool_use_id: `gemini-${normalizedName}-${Date.now()}`,
                content: lastVerificationOutput,
                is_error: true,
              });
              responseParts.push({
                functionResponse: {
                  name: normalizedName,
                  response: { content: lastVerificationOutput },
                },
              });
              return;
            }

            // Inject failure context and get retry from LLM
            contents.push({ role: "user", parts: [{
              functionResponse: {
                name: normalizedName,
                response: { content: lastVerificationOutput },
              },
            }] });

            throwIfCancelled(opts);
            const retryResponse = await callGeminiWithTools(
              provider.apiKey,
              modelId,
              systemPrompt,
              contents
            );
            throwIfCancelled(opts);

            const retryCandidate = retryResponse.candidates?.[0];
            if (!retryCandidate) {
              // LLM gave no retry — report failure
              onToolResult?.(normalizedName, input, lastVerificationOutput, true);
              recordToolObservation(observations, normalizedName, input, {
                tool_use_id: `gemini-${normalizedName}-${Date.now()}`,
                content: lastVerificationOutput,
                is_error: true,
              });
              responseParts.push({
                functionResponse: {
                  name: normalizedName,
                  response: { content: lastVerificationOutput },
                },
              });
              return;
            }

            const retryParts = retryCandidate.content?.parts ?? [];
            const retryFnCalls = retryParts.filter(
              (p): p is { functionCall: { name: string; args: Record<string, unknown> } } =>
                p.functionCall !== undefined
            );

            const retryTextParts = retryParts.filter(
              (p): p is { text: string } => typeof p.text === "string"
            );
            if (retryTextParts.length > 0) {
              finalText = retryTextParts.map((p) => p.text).join("");
            }

            // Find the retry call for the same or any mutating tool
            const retryFc = retryFnCalls.find(
              (f) => isMutatingTool(f.functionCall.name)
            ) || retryFnCalls[0];

            if (!retryFc) {
              // LLM gave up — use last failure
              onToolResult?.(normalizedName, input, lastVerificationOutput, true);
              recordToolObservation(observations, normalizedName, input, {
                tool_use_id: `gemini-${normalizedName}-${Date.now()}`,
                content: lastVerificationOutput,
                is_error: true,
              });
              responseParts.push({
                functionResponse: {
                  name: normalizedName,
                  response: { content: lastVerificationOutput },
                },
              });
              return;
            }

            // Update input with LLM's corrected args
            Object.assign(input, retryFc.functionCall.args);
            contents.push({ role: "model", parts: retryParts });

            attempt++;
          }
          return;
        }

        // ── Non-mutating tools: direct execution ─────────────────────────
        const result = await executeAgentTool(normalized, projectPath, opts.onBeforeWrite);
        throwIfCancelled(opts);
        onToolResult?.(normalizedName, input, result.content, result.is_error);
        recordToolObservation(observations, normalizedName, input, result);
        responseParts.push({
          functionResponse: {
            name: normalizedName,
            response: { content: result.content },
          },
        });
      })
    );

    contents.push({ role: "user", parts: responseParts });

    // ── Circuit breaker: halt loop if writes are blocked by user action ──
    const writeBlocked = responseParts.some(
      (p) =>
        p.functionResponse &&
        typeof p.functionResponse.response?.content === "string" &&
        (p.functionResponse.response.content.includes("rejected by user") ||
         p.functionResponse.response.content.includes("active inline diff preview") ||
         p.functionResponse.response.content.includes("Patch rejected by user"))
    );
    if (writeBlocked) {
      const haltMessage = "⏸️ Paused: File edits are awaiting your review in the inline diff preview. Accept or reject the changes, then re-run the task.";
      opts.onToken?.(haltMessage);
      return haltMessage;
    }
  }

  return synthesizeFinalAnswer(opts, observations, finalText);
}
