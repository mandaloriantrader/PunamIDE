// src/utils/agentToolLoop.ts
//
// Entry point for the Agent Tool-Calling Orchestration Loop.
// Delegates to provider-specific implementations in ./toolLoops/
//
// External consumers import from this file only — internal splits are not public.

import type { ResponseMetrics } from "./providers";
import { executeAgentTool, normalizeAgentToolCall } from "./agentTools";
import {
  type ToolLoopOptions,
  type AgentPlan,
  type VerifyResult,
  type ToolObservation,
  throwIfCancelled,
  isCancellationError,
  combineLoopMetrics,
  buildExplicitReadOnlyToolCall,
  synthesizeFinalAnswer,
  recordToolObservation,
} from "./toolLoops";
import { runAnthropicToolLoop } from "./toolLoops/anthropicLoop";
import { runGeminiToolLoop } from "./toolLoops/geminiLoop";
import { runJsonFallbackToolLoop } from "./toolLoops/jsonFallbackLoop";
import { generatePlan } from "./toolLoops/planner";
import { runVerification } from "./toolLoops/verifier";
import { detectAmbiguity, refineTaskWithClarification } from "../services/agent/AmbiguityDetector";
import { findSimilarClarification, storeClarification } from "../services/agent/ClarificationMemory";
import { BudgetController } from "../services/agent/BudgetController";
import { ContextAssembler } from "../services/intelligence/ContextAssembler";
import { ContextInjector } from "../services/intelligence/ContextInjector";
import { getModelContextLimit, CONTEXT_FILL_PCT } from "../services/intelligence/contextLimits";
import { TokenBudgetManager } from "../services/agent/TokenBudgetManager";
import { useAIStore } from "../store/aiStore";
import { useSettingsStore } from "../store/settingsStore";
import { useEditorStore } from "../store/editorStore";
import type { ToolCallHistory } from "../services/intelligence/contextTypes";
import { sidebarModel } from "../components/ContextSidebar";

// ── Re-export public types ───────────────────────────────────────────────────

export type { ToolLoopOptions, AgentPlan, VerifyResult };

// ── Public entry point ───────────────────────────────────────────────────────

/**
 * Run the full tool-calling agent loop.
 * Automatically selects the right adapter based on provider type.
 *
 * Phase 2 features:
 *   - Planner: generates a step-by-step plan before tool execution (calls onPlanReady)
 *   - Verifier: runs typecheck/lint/test after patch application (calls onVerifyResult)
 *               retries up to 2 times if verification fails, feeding errors back to the model
 */
export async function runAgentToolLoop(opts: ToolLoopOptions): Promise<void> {
  const { provider, onDone, onError, onCancelled } = opts;
  const collectedMetrics: ResponseMetrics[] = [];
  const perRoundTimeoutMs = 180_000; // 3 minutes per round (not global)
  let timeoutId: ReturnType<typeof setTimeout> | null = null;
  let internalController: AbortController | null = null;

  // ── Context Optimization history (declared early for closure access) ────
  const contextAgentHistory: ToolCallHistory[] = [];

  // ── Budget Controller (zero overhead if opts.budget undefined) ──────────
  const budgetController = opts.budget
    ? new BudgetController(opts.budget, opts.modelId)
    : null;

  const loopOpts: ToolLoopOptions = {
    ...opts,
    onToolResult: (name, input, result, isError) => {
      opts.onToolResult?.(name, input, result, isError);

      // Track tool calls for context optimization history
      if (opts.enableContextOptimization) {
        contextAgentHistory.push({
          round: collectedMetrics.length,
          toolName: name,
          input: JSON.stringify(input).slice(0, 500),
          output: result.slice(0, 1000),
          tokenCount: Math.ceil(result.length / 4),
        });
      }
    },
    onMetrics: (metrics) => {
      collectedMetrics.push(metrics);
      opts.onMetrics?.(metrics);

      // Budget enforcement — only active when budgetController exists
      if (budgetController) {
        budgetController.recordRound({
          inputTokens: metrics.promptTokens ?? 0,
          outputTokens: metrics.responseTokens ?? 0,
          model: metrics.model || opts.modelId,
        });

        const status = budgetController.checkBudget();

        if (status === "exceeded") {
          // Hard stop — abort the loop via internal signal
          internalController?.abort();
        } else if (status === "warning" || status === "critical") {
          budgetController.markWarningFired();
          if (opts.onBudgetWarning) {
            // Fire-and-forget: onMetrics is sync, but the decision will
            // abort before the next round starts if user chooses 'stop'
            opts.onBudgetWarning(
              status,
              budgetController.getConsumed(),
              budgetController.getRemaining(),
            ).then((decision) => {
              if (decision === "stop") {
                internalController?.abort();
              }
            }).catch(() => {});
          }
        }

        // Model downgrade recommendation (logging only — actual switching is complex)
        if (budgetController.shouldDowngrade()) {
          console.info(
            `[BudgetController] Recommends downgrade to "${opts.budget!.downgradeModel}" — ` +
            `current usage: ${budgetController.getConsumed().totalTokens} tokens`,
          );
        }
      }
    },
  };

  /** Reset the per-round timeout. Call after each successful round. */
  function resetTimeout() {
    if (timeoutId) clearTimeout(timeoutId);
    if (internalController && !internalController.signal.aborted) {
      timeoutId = setTimeout(() => {
        if (internalController && !internalController.signal.aborted) {
          internalController.abort();
        }
      }, perRoundTimeoutMs);
    }
  }

  try {
    throwIfCancelled(loopOpts);

    // ── Pre-flight: Clarification Protocol ────────────────────────────────
    let finalTask = opts.task;
    if (opts.enableClarification && opts.onClarificationNeeded) {
      // Check memory for similar past clarification first
      const remembered = await findSimilarClarification(opts.task, opts.projectPath);
      if (remembered) {
        finalTask = remembered.refinedTask;
      } else {
        // Run ambiguity detection
        const report = await detectAmbiguity(
          opts.task,
          opts.projectMemorySummary,
          opts.provider.type,
          opts.provider.apiKey,
          opts.modelId,
          opts.provider.baseUrl,
        );
        if (report.isAmbiguous && report.suggestedQuestion) {
          const answer = await opts.onClarificationNeeded(report);
          if (answer && answer.trim()) {
            finalTask = await refineTaskWithClarification(
              opts.task,
              answer,
              opts.provider.type,
              opts.provider.apiKey,
              opts.modelId,
              opts.provider.baseUrl,
            );
            // Store for future recall (fire-and-forget)
            storeClarification({
              taskPattern: opts.task,
              clarification: answer,
              refinedTask: finalTask,
              projectPath: opts.projectPath,
              timestamp: Date.now(),
            }).catch(() => {});
          }
        }
      }
      // Update task for the rest of the loop
      loopOpts.task = finalTask;
    }

    // ── Context Injection — Automatic Smart Context ────────────────────────
    // Gathers call graph callers/callees, type definitions, and embedding snippets
    // based on cursor position. Runs upstream of ContextAssembler and appends
    // injected context to the system prompt.
    let injectedContextSection = "";
    try {
      const settingsConfig = useSettingsStore.getState().config.contextInjectorConfig;
      const editorState = useEditorStore.getState();
      const cursorPos = editorState.cursorPosition;
      const activeFile = opts.activeFilePath;

      if (activeFile) {
        const contextInjector = new ContextInjector(settingsConfig);

        // Estimate total token budget from model limits
        const modelLimit = getModelContextLimit(opts.modelId);
        const tokenBudget = Math.floor(modelLimit * CONTEXT_FILL_PCT);

        const injectedContext = await contextInjector.gatherContext({
          filePath: activeFile,
          cursorLine: cursorPos.line,
          cursorColumn: cursorPos.column,
          userQuery: loopOpts.task,
          userMentions: [], // User mentions are handled separately by ContextAssembler
          tokenBudget,
        });

        // Format injected context as a section to append to the system prompt
        if (injectedContext.totalTokens > 0) {
          const parts: string[] = [];
          parts.push("## Auto-Injected Context (Call Graph & Semantic)");

          if (injectedContext.callers.length > 0) {
            parts.push("### Callers of current function:");
            for (const edge of injectedContext.callers) {
              parts.push(`- ${edge.caller} (${edge.caller_file}:${edge.call_line}): ${edge.call_expression}`);
            }
          }

          if (injectedContext.callees.length > 0) {
            parts.push("### Callees from current function:");
            for (const edge of injectedContext.callees) {
              parts.push(`- ${edge.callee} (${edge.caller_file}:${edge.call_line}): ${edge.call_expression}`);
            }
          }

          if (injectedContext.typeDefinitions.length > 0) {
            parts.push("### Referenced type definitions:");
            for (const sym of injectedContext.typeDefinitions) {
              parts.push(`- ${sym.kind} ${sym.name} (${sym.file}:${sym.line}): ${sym.signature}`);
            }
          }

          if (injectedContext.embeddingSnippets.length > 0) {
            parts.push("### Related code snippets (semantic search):");
            for (const snippet of injectedContext.embeddingSnippets) {
              parts.push(`\`\`\`\n// ${snippet.filePath} (relevance: ${snippet.score.toFixed(2)})\n${snippet.content}\n\`\`\``);
            }
          }

          injectedContextSection = parts.join("\n");
        }
      }
    } catch (err) {
      // Fail-open: if context injection fails, proceed without injected context
      console.warn("[ContextInjector] Injection failed, proceeding without auto-context:", err);
    }

    // ── Context Sidebar Prompt Injection ────────────────────────────────────
    // Inject pinned + top-scoring items from the ContextSidebar into the prompt.
    // These items represent user-curated context (pinned) and the highest-relevance
    // callers, callees, related files, and diagnostics.
    try {
      const sidebarState = sidebarModel.getState();
      const budgetStatus = useAIStore.getState().tokenBudgetStatus;
      if (sidebarState.items.length > 0 && budgetStatus) {
        const selectedItems = sidebarModel.selectForPrompt(sidebarState.items, budgetStatus);
        if (selectedItems.length > 0) {
          const sidebarParts: string[] = [];
          sidebarParts.push("## Context Sidebar (Pinned & Top-Scored)");

          const pinned = selectedItems.filter(i => i.pinned);
          const auto = selectedItems.filter(i => !i.pinned);

          if (pinned.length > 0) {
            sidebarParts.push("### Pinned by user:");
            for (const item of pinned) {
              const loc = item.location ? ` (${item.location.filePath}:${item.location.line})` : "";
              sidebarParts.push(`- [${item.kind}] ${item.label}${loc}`);
            }
          }

          if (auto.length > 0) {
            sidebarParts.push("### High-relevance context:");
            for (const item of auto) {
              const loc = item.location ? ` (${item.location.filePath}:${item.location.line})` : "";
              sidebarParts.push(`- [${item.kind}] ${item.label}${loc} (score: ${item.score.toFixed(2)})`);
            }
          }

          const sidebarSection = sidebarParts.join("\n");
          injectedContextSection = injectedContextSection
            ? `${injectedContextSection}\n\n${sidebarSection}`
            : sidebarSection;
        }
      }
    } catch (err) {
      // Fail-open: sidebar injection is best-effort
      console.warn("[ContextSidebar] Prompt injection failed, proceeding without sidebar context:", err);
    }

    // ── Context Optimization ────────────────────────────────────────────────
    if (opts.enableContextOptimization && opts.projectPath && opts.projectPath.trim() !== "") {
      try {
        const { compressionConfig } = useSettingsStore.getState().config;
        const assembler = new ContextAssembler(opts.modelId, compressionConfig);

        // If we have injected context, prepend it to the system prompt before assembly
        const systemPromptWithInjection = injectedContextSection
          ? `${loopOpts.systemPrompt}\n\n${injectedContextSection}`
          : loopOpts.systemPrompt;

        const assemblyResult = await assembler.assemble({
          task: loopOpts.task,
          round: 0,
          model: opts.modelId,
          projectPath: opts.projectPath,
          currentFiles: opts.activeFilePath ? [opts.activeFilePath] : [],
          agentHistory: contextAgentHistory,
          systemPrompt: systemPromptWithInjection,
        });

        // ── Token Budget Management ──────────────────────────────────────────
        // Validate and trim assembled context slots against model budget
        try {
          const budgetManager = new TokenBudgetManager(opts.modelId);

          // Validate and trim context slots against budget
          const budgetResult = budgetManager.validateAndTrim({
            systemPrompt: systemPromptWithInjection,
            userMessage: loopOpts.task,
            contextSlots: assemblyResult.slots,
            conversationHistory: [], // History is managed internally by each sub-loop
          });

          // Use trimmed slots if trimming occurred
          if (budgetResult.trimActions.length > 0) {
            // Rebuild assembled context from trimmed slots
            const trimmedContent = budgetResult.slots
              .map(slot => slot.content)
              .join("\n\n");
            if (trimmedContent) {
              loopOpts.systemPrompt = trimmedContent;
            }
          } else {
            // No trimming needed — use original assembled context
            loopOpts.systemPrompt = assemblyResult.assembledContext;
          }

          // Check if conversation history (from aiStore) exceeds its allocation
          const aiStoreMessages = useAIStore.getState().messages || [];
          const budgetHistory = aiStoreMessages
            .filter(m => m.role === "user" || m.role === "assistant")
            .map(m => ({
              role: m.role as "user" | "assistant" | "system",
              content: m.content,
            }));

          if (budgetHistory.length > 0) {
            const historyTokens = budgetHistory.reduce(
              (sum, msg) => sum + budgetManager.estimateTokens(msg.content), 0
            );
            const historyAllocation = budgetManager.getAllocation().userMessage;

            if (historyTokens > historyAllocation) {
              try {
                await budgetManager.summarizeHistory(budgetHistory, historyAllocation);
                // Summarization result available — sub-loops handle their own message arrays
                // so this primarily informs the budget status calculation
              } catch {
                // Fallback: truncation happens naturally in the sub-loops (they keep recent messages)
              }
            }
          }

          // Update the store with budget status for StatusBar display
          useAIStore.getState().setTokenBudgetStatus(budgetResult.status);
        } catch (budgetErr) {
          // Budget management failure is non-critical — proceed without trimming
          loopOpts.systemPrompt = assemblyResult.assembledContext;
          console.warn("[TokenBudgetManager] Budget validation failed:", budgetErr);
        }

        // If context budget is nearly full, append a pressure note
        if (assemblyResult.budgetUsed > 0.85) {
          loopOpts.systemPrompt +=
            "\n\n[Note: Context window is nearly full. Prioritize the most critical information in your response.]";
        }
      } catch (err) {
        // Fail-open: if context optimization fails, proceed with original system prompt
        // Still apply injected context if available
        if (injectedContextSection) {
          loopOpts.systemPrompt += `\n\n${injectedContextSection}`;
        }
        console.warn("[ContextAssembler] Assembly failed, using original context:", err);
      }
    } else if (injectedContextSection) {
      // Context optimization disabled but injection succeeded — append directly
      loopOpts.systemPrompt += `\n\n${injectedContextSection}`;
    }

    if (!loopOpts.signal) {
      internalController = new AbortController();
      loopOpts.signal = internalController.signal;
      // Store resetTimeout on opts so sub-loops can reset after each API call
      (loopOpts as any)._resetTimeout = resetTimeout;
      timeoutId = setTimeout(() => {
        if (internalController && !internalController.signal.aborted) {
          internalController.abort();
        }
      }, perRoundTimeoutMs);
    }

    // ── Phase 2: Planner ───────────────────────────────────────────────
    // Generate a plan before tool execution (non-blocking — agent works without it)
    generatePlan(loopOpts).catch(() => {});

    throwIfCancelled(loopOpts);
    const explicitReadOnlyToolCall = buildExplicitReadOnlyToolCall(opts.task);
    if (explicitReadOnlyToolCall) {
      const normalized = normalizeAgentToolCall(explicitReadOnlyToolCall);
      const normalizedName = "tool" in normalized ? normalized.tool : normalized.name;
      const normalizedInput = normalized.input as Record<string, unknown>;
      loopOpts.onToolCall?.(normalizedName, normalizedInput);
      const result = await executeAgentTool(normalized, opts.projectPath);
      throwIfCancelled(loopOpts);
      const observations: ToolObservation[] = [];
      recordToolObservation(observations, normalizedName, normalizedInput, result);
      const finalText = await synthesizeFinalAnswer(loopOpts, observations, "");
      throwIfCancelled(loopOpts);
      onDone?.(finalText, combineLoopMetrics(provider, opts.modelId, collectedMetrics));
      return;
    }

    let finalText: string;

    if (provider.type === "anthropic") {
      finalText = await runAnthropicToolLoop(loopOpts);
    } else if (provider.type === "gemini") {
      finalText = await runGeminiToolLoop(loopOpts);
    } else if (provider.type === "openai-compatible") {
      const { runOpenAIToolLoop } = await import("./toolLoops/openaiLoop");
      finalText = await runOpenAIToolLoop(loopOpts);
    } else {
      finalText = await runJsonFallbackToolLoop(loopOpts);
    }

    // Reset timeout after main loop completes — verifier gets fresh time
    resetTimeout();
    throwIfCancelled(loopOpts);

    // ── Phase 2: Auto-Verifier ─────────────────────────────────────────
    const shouldVerify = opts.enableAutoVerify !== false;
    if (shouldVerify) {
      const MAX_RETRIES = 2;
      for (let retry = 0; retry <= MAX_RETRIES; retry++) {
        const verifyResult = await runVerification(opts.projectPath, loopOpts, retry);
        if (verifyResult.passed) break;
        if (retry < MAX_RETRIES) {
          // Feed errors back to the model for self-correction
          const failedChecks = verifyResult.checks.filter(c => !c.passed);
          const errorFeedback = [
            "AUTO-VERIFICATION FAILED. The following checks did not pass:",
            ...failedChecks.map(c => `- ${c.name}\n${c.output.slice(0, 500)}`),
            "",
            "Please fix the issues above and produce corrected file changes.",
          ].join("\n");
          const correctionOpts: ToolLoopOptions = {
            ...loopOpts,
            task: `Fix the following verification failures in ${opts.projectPath}:\n\n${errorFeedback}`,
            maxRounds: 4,
          };
          try {
            if (provider.type === "anthropic") {
              finalText = await runAnthropicToolLoop(correctionOpts);
            } else if (provider.type === "gemini") {
              finalText = await runGeminiToolLoop(correctionOpts);
            } else if (provider.type === "openai-compatible") {
              const { runOpenAIToolLoop } = await import("./toolLoops/openaiLoop");
              finalText = await runOpenAIToolLoop(correctionOpts);
            } else {
              finalText = await runJsonFallbackToolLoop(correctionOpts);
            }
          } catch {
            break; // if correction fails, stop retrying
          }
        }
      }
    }

    // ── Budget summary (append if budget was tracked) ────────────────────
    if (budgetController) {
      finalText += `\n\n---\n${budgetController.getSummary()}`;
    }

    onDone?.(finalText, combineLoopMetrics(provider, opts.modelId, collectedMetrics));
  } catch (err) {
    if (isCancellationError(err)) {
      onCancelled?.();
      return;
    }
    const message = err instanceof Error ? err.message : String(err);
    onError?.(message);
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}
