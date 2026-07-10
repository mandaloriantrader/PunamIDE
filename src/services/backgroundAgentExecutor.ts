/**
 * Background Agent Executor — Runs agent tasks independently of the chat UI.
 * Uses the same AI providers and parsing logic but writes to the background store.
 */

import { useBackgroundAgentStore } from "../store/backgroundAgentStore";
import type { TaskPhase, PlannerSubtask, ReasoningChunk } from "../store/backgroundAgentStore";
import { sendToProviderStreaming } from "../utils/providers";
import type { AIProviderConfig } from "../utils/providers";
import { parseResponse, SYSTEM_PROMPT } from "../utils/prompts";
import { inspectCommand, readFile, writeFile, runTerminalCommand } from "../utils/tauri";
import {
  assemblePersistentPayload,
  loadAgentMemories,
  compressMemories,
} from "../utils/contextEngine";
import { showToast } from "../utils/toast";
import { getAgentOrchestrator } from "./agent/AgentOrchestrator";
import { getConflictResolver } from "./agent/ConflictResolver";
import { getAgentCoordinator } from "./agent/AgentCoordinator";
import { validateApply } from "./agent/AgentApplyGuard";
import {
  resolveCommandPolicy,
  getApprovalMemory,
  resetApprovalMemory,
  type CommandApprovalRequest,
} from "./agent/ToolPolicies";
import { getLoopGuard, resetLoopGuard } from "./agent/LoopGuard";
import { compactAgentAttempts, type AgentAttemptContext } from "../utils/contextCompactor";
import { RefinementLoop } from "./agent/RefinementLoop";
import type { ErrorContext } from "./agent/RefinementLoop";
import { filePathToUri } from "./lsp/monacoLspBridge";
import { lspManager } from "./lsp/lspManager";

interface ExecutorConfig {
  projectPath: string;
  aiProviders: AIProviderConfig[];
  openTabPaths: string[]; // For conflict detection
}

let executorRunning = false;
let executorCancelled = false;
const NO_ACTION_ERROR = "No actionable FILE or CMD blocks were produced.";

/** Shared refinement loop instance for post-edit corrective passes. */
const refinementLoop = new RefinementLoop();

/** Monotonic counter for unique reasoning chunk IDs. */
let reasoningChunkSeq = 0;

/**
 * Map a task planner phase to a ReasoningPanel phase category.
 * decompose → planning, gather_context/reason → analysis, generate/verify → execution.
 */
function mapPhaseToReasoningPhase(phase: TaskPhase["name"] | null): ReasoningChunk["phase"] {
  switch (phase) {
    case "decompose": return "planning";
    case "gather_context": return "analysis";
    case "reason": return "analysis";
    case "generate": return "execution";
    case "verify": return "execution";
    default: return "analysis";
  }
}

/**
 * Emit reasoning text to BOTH the legacy string stream (Task Planner panel) and
 * the structured chunk system (Reasoning panel). Also updates phase timing so the
 * Reasoning panel can show per-phase elapsed time.
 */
function emitReasoning(content: string): void {
  const store = useBackgroundAgentStore.getState();
  // Legacy string stream (existing Task Planner consumers)
  store.appendReasoningStream(content);

  // Structured chunk for the Reasoning panel (Tier B)
  const phase = mapPhaseToReasoningPhase(store.currentPhase);
  store.appendReasoningChunk({
    id: `rc-${Date.now()}-${reasoningChunkSeq++}`,
    phase,
    content,
    timestamp: Date.now(),
    codeReferences: [], // ReasoningPanel parses content directly for clickable refs
  });

  // Update phase timing (elapsed since phase start)
  const timing = store.phaseTimings.get(phase);
  const startedAt = timing?.startedAt ?? Date.now();
  store.updatePhaseTiming(phase, Date.now() - startedAt);
}

/**
 * Start executing the background agent task.
 * This runs asynchronously and updates the store as it progresses.
 */
export async function startBackgroundExecution(config: ExecutorConfig): Promise<void> {
  if (executorRunning) return;
  executorRunning = true;
  executorCancelled = false;

  // Reset approval memory for the new session
  resetApprovalMemory();
  resetLoopGuard();

  // Register this agent with the orchestrator
  const orchestrator = getAgentOrchestrator();
  const bgAgentId = `bg-agent-${Date.now()}`;
  const provider = config.aiProviders.find(p => p.apiKey && p.models.some(m => m.enabled));
  const model = provider?.models.find(m => m.enabled);

  try {
    orchestrator.spawnAgent({
      id: bgAgentId,
      type: "implementation",
      provider: provider?.name || "unknown",
      model: model?.id || "unknown",
      apiKey: "redacted",
    });
  } catch (err) {
    console.warn("[BG-Agent] Failed to register with orchestrator:", err);
  }

  const store = useBackgroundAgentStore.getState();
  const session = store.session;
  if (!session) {
    console.warn("[BG-Agent] No session found, aborting");
    executorRunning = false;
    return;
  }

  const { projectPath, openTabPaths } = config;
  console.log("[BG-Agent] Starting execution:", { task: session.task, projectPath, subtasks: session.subtasks });

  // ── Initialize Task Planner phases and subtasks ──────────────────────────
  const initialPhases: TaskPhase[] = [
    { name: "decompose", status: "pending" },
    { name: "gather_context", status: "pending" },
    { name: "reason", status: "pending" },
    { name: "generate", status: "pending" },
    { name: "verify", status: "pending" },
  ];
  store.setPhases(initialPhases);

  // Build planner subtasks from session subtasks
  if (session.subtasks.length > 1) {
    const plannerSubtasks: PlannerSubtask[] = session.subtasks.map((title, idx) => ({
      id: `subtask-${idx}`,
      index: idx,
      title,
      status: idx === 0 ? "in_progress" : "pending",
      affectedFiles: [],
      dependsOn: idx > 0 ? [`subtask-${idx - 1}`] : [],
      dependedBy: idx < session.subtasks.length - 1 ? [`subtask-${idx + 1}`] : [],
    }));
    store.setPlannerSubtasks(plannerSubtasks);
  }

  // Start with the "decompose" phase
  store.advancePhase("decompose");
  emitReasoning("Analyzing task and decomposing into subtasks...\n");

  // Track files already written this session (deduplication)
  const writtenFiles = new Map<string, string>(); // path → content hash
  // Track attempt history for context compaction
  const attemptHistory: AgentAttemptContext[] = [];

  try {
    // Execute each subtask
    while (true) {
      const currentState = useBackgroundAgentStore.getState();
      if (!currentState.session || !currentState.isRunning || executorCancelled) {
        console.log("[BG-Agent] Loop exit:", { hasSession: !!currentState.session, isRunning: currentState.isRunning, cancelled: executorCancelled });
        break;
      }
      if (currentState.isPaused) {
        await sleep(1000);
        continue;
      }

      const { session: currentSession } = currentState;
      if (currentSession.step === "completed" || currentSession.step === "failed" || currentSession.step === "cancelled") break;

      const currentTask = currentSession.subtasks[currentSession.currentSubtask] || currentSession.task;
      console.log("[BG-Agent] Executing subtask:", currentTask);

      // ── Phase: Gather Context ──────────────────────────────────────────────
      useBackgroundAgentStore.getState().advancePhase("gather_context");
      emitReasoning(`\nGathering context for: ${currentTask.slice(0, 80)}...\n`);

      // Step 1: Plan and propose fix
      store.updateStep("proposing_fix", `Working on: ${currentTask.slice(0, 50)}`);

      // Inject loop guard corrective hint if one was set from previous attempt
      const loopGuardHint = getLoopGuard().check();
      const taskWithHint = (loopGuardHint.loopDetected && loopGuardHint.correctivePrompt)
        ? `${currentTask}\n\n${loopGuardHint.correctivePrompt}`
        : currentTask;

      // Inject compacted attempt history for context efficiency (attempt > 1)
      const compactedHistory = attemptHistory.length > 0
        ? compactAgentAttempts(attemptHistory)
        : "";
      const taskWithContext = compactedHistory
        ? `${taskWithHint}\n\n${compactedHistory}`
        : taskWithHint;

      // ── Phase: Reason ──────────────────────────────────────────────────────
      useBackgroundAgentStore.getState().advancePhase("reason");
      emitReasoning("Sending context to AI for reasoning...\n");

      const result = await executeOneStep(taskWithContext, currentSession, config);
      console.log("[BG-Agent] Step result:", { success: result.success, error: result.error, fileChanges: result.fileChanges?.length, commands: result.commands?.length });

      if (executorCancelled) break;

      if (!result.success) {
        emitReasoning(`Step failed: ${result.error || "Unknown error"}\n`);
        if (result.error === NO_ACTION_ERROR) {
          store.fail(`${NO_ACTION_ERROR} Background tasks must return real file changes or commands before they can be marked complete.`);
          showToast("Background task stopped: no actionable changes were produced", "error");
          break;
        }

        // Record failed attempt for compaction
        attemptHistory.push({
          attempt: currentSession.attempt,
          task: currentTask,
          filesWritten: [],
          commandsRun: [],
          errors: [result.error || "Unknown error"],
          outcome: "failed",
        });

        // ── Loop Guard: record failed attempt and check for patterns ──
        const loopGuard = getLoopGuard();
        loopGuard.recordAttempt(
          simpleHash(result.error || ""),
          [],
          [],
        );
        const detection = loopGuard.check();
        if (detection.loopDetected) {
          console.log("[BG-Agent] Loop detected:", detection.pattern, detection.message);
          store.addLog("failed", `Loop detected (${detection.pattern}): ${detection.message}`);
          if (detection.recommendation === "abort") {
            store.fail(`Agent stuck in loop: ${detection.message}`);
            showToast("⚠️ Background agent stuck — stopped automatically", "error");
            break;
          }
          // retry_with_hint: inject corrective prompt into the task for next attempt
          if (detection.correctivePrompt) {
            store.addLog("analyzing_output", "Injecting corrective hint for next attempt...");
          }
        }

        const attempt = currentSession.attempt + 1;
        if (attempt > currentSession.maxAttempts) {
          store.fail(`Max attempts reached for: ${currentTask}`);
          showToast("⚠️ Background task failed — check progress panel", "error");
          break;
        }
        const s = useBackgroundAgentStore.getState().session;
        if (s) {
          useBackgroundAgentStore.setState({
            session: { ...s, attempt: attempt, step: "analyzing_output" },
          });
        }
        store.addLog("analyzing_output", `Attempt ${attempt}: ${result.error || "Retrying..."}`);
        await sleep(2000);
        continue;
      }

      // Step 2: Apply file changes (through ConflictResolver)
      if (result.fileChanges && result.fileChanges.length > 0) {
        // ── Phase: Generate ────────────────────────────────────────────────
        useBackgroundAgentStore.getState().advancePhase("generate");
        emitReasoning(`Applying ${result.fileChanges.length} file change(s)...\n`);

        // Auto-snapshot before AI agent edits (Ghost Restore safety net)
        try {
          const { invoke } = await import("@tauri-apps/api/core");
          await invoke("create_snapshot", {
            projectRoot: projectPath,
            name: `pre-agent-edit-${Date.now()}`,
            reason: "before-ai-edit",
          });
        } catch (err) {
          console.warn("[BG-Agent] Auto-snapshot failed:", err);
        }

        const resolver = getConflictResolver();

        for (const change of result.fileChanges) {
          if (executorCancelled) break;

          const fullPath = buildFullPath(projectPath, change.path);
          console.log("[BG-Agent] Attempting file write:", { path: change.path, fullPath, isNew: change.isNew });

          // Check open tabs conflict
          const isOpenInEditor = openTabPaths.some(
            (tabPath) => normalizePath(tabPath) === normalizePath(fullPath)
          );

          // Check via ConflictResolver (permission + lock)
          const conflictResult = resolver.attemptEdit(bgAgentId, change.path, change.content);

          store.addFileChange({
            path: change.path,
            content: change.content,
            isNew: change.isNew,
            applied: false,
            conflicting: conflictResult.hasConflict || isOpenInEditor,
          });

          if (conflictResult.hasConflict) {
            store.addLog("verifying", `Blocked: ${change.path} — ${conflictResult.message}`);
            continue;
          }

          if (isOpenInEditor) {
            store.addLog("verifying", `Conflict: ${change.path} is open in editor — skipped`);
            resolver.releaseAndFlush(bgAgentId, change.path);
            continue;
          }

          // Deduplication: skip if we already wrote identical content to this file
          const contentHash = simpleHash(change.content);
          const previousHash = writtenFiles.get(change.path);
          if (previousHash === contentHash) {
            store.addLog("verifying", `Skipped (duplicate): ${change.path} — already written with same content`);
            resolver.releaseAndFlush(bgAgentId, change.path);
            continue;
          }

          // Validate against architecture + security guardrails (Phase 1 + Phase 6)
          const guardResult = await validateApply(bgAgentId, change.path, change.content, projectPath);
          if (!guardResult.allowed) {
            store.addLog("failed", `Blocked by guardrails: ${change.path} — ${guardResult.reason}`);
            resolver.releaseAndFlush(bgAgentId, change.path);
            if (guardResult.architectureViolations.length > 0) {
              store.addLog("verifying", `Architecture violations: ${guardResult.architectureViolations.map(v => v.description).join("; ")}`);
            }
            continue;
          }

          // Write the file
          try {
            // Capture pre-edit content for refinement loop
            let preEditContent: string | null = null;
            if (!change.isNew) {
              try {
                preEditContent = await readFile(fullPath);
              } catch { /* new file or read failure — skip refinement */ }
            }

            await writeFile(fullPath, change.content);
            store.markFileApplied(change.path);
            store.addLog("verifying", `Applied: ${change.path}`);
            console.log("[BG-Agent] File written successfully:", fullPath);
            writtenFiles.set(change.path, contentHash);

            // ── Refinement Loop: auto-fix newly introduced errors ──────────
            const languageId = lspManager.getLanguageForFile(change.path);
            if (preEditContent !== null && languageId && lspManager.isServerRunning(languageId)) {
              try {
                const fileUri = filePathToUri(fullPath);
                const refinementResult = await refinementLoop.runAfterEdit({
                  filePath: change.path,
                  fileUri,
                  languageId,
                  preEditContent,
                  postEditContent: change.content,
                  preEditDiagnostics: [],
                  requestAiFix: async (context: ErrorContext) => {
                    // Build a correction-focused prompt with error context and previous attempts
                    const errorList = context.errors
                      .map((e) => `  Line ${e.startLine + 1}: ${e.message}${e.code ? ` [${e.code}]` : ""}`)
                      .join("\n");

                    const previousAttemptsText = context.previousAttempts.length > 0
                      ? `\n\nPrevious fix attempts that did NOT resolve the errors:\n${context.previousAttempts.map((a) =>
                          `Attempt ${a.attemptNumber}: applied patch but still got errors:\n${a.resultingErrors.map((e) => `  - ${e.message}`).join("\n")}`
                        ).join("\n")}`
                      : "";

                    const fixPrompt = `The following file has newly introduced errors after an edit. Fix ALL errors and return the complete corrected file content.

File: ${context.filePath}
Errors:
${errorList}
${previousAttemptsText}

Current file content:
\`\`\`
${context.currentContent}
\`\`\`

Return ONLY the corrected file content inside a single FILE block:
===FILE: ${context.filePath}===
<corrected content>
===END_FILE===`;

                    try {
                      const fixProvider = config.aiProviders.find(
                        (p) => p.apiKey && p.models.some((m) => m.enabled && m.id)
                      );
                      const fixModel = fixProvider?.models.find((m) => m.enabled && m.id);
                      if (!fixProvider || !fixModel) return null;

                      const fixResp = await sendToProviderStreaming(fixProvider, fixModel.id, {
                        systemPrompt: "You are a code-fixing assistant. Return only the corrected file content in the exact format requested. Do not explain.",
                        userPrompt: fixPrompt,
                      });

                      if (!fixResp.success || !fixResp.text) return null;

                      // Parse the response to extract file content
                      const parsed = parseResponse(fixResp.text, new Set<string>());
                      if (parsed.fileChanges.length > 0) {
                        return parsed.fileChanges[0].content;
                      }

                      // Fallback: try to extract content between code fences
                      const fenceMatch = fixResp.text.match(/```[\w]*\n([\s\S]*?)```/);
                      if (fenceMatch) return fenceMatch[1];

                      return null;
                    } catch {
                      return null;
                    }
                  },
                });

                // Handle refinement result
                if (refinementResult.rolledBack && refinementResult.rollbackContent) {
                  // Roll back the file to pre-edit content
                  await writeFile(fullPath, refinementResult.rollbackContent);
                  store.addLog("failed", `Auto-fix failed after 3 attempts — rolled back`);
                  console.log("[BG-Agent] Refinement rolled back:", change.path);
                } else if (refinementResult.success && refinementResult.passesUsed > 0) {
                  store.addLog("verifying", `Auto-fix applied (${refinementResult.passesUsed} corrective pass(es))`);
                  console.log("[BG-Agent] Refinement succeeded:", change.path, `${refinementResult.passesUsed} pass(es)`);
                }
              } catch (refinementErr) {
                // Refinement failures must not crash the executor
                console.warn("[BG-Agent] Refinement loop error (non-fatal):", change.path, refinementErr);
              }
            }
          } catch (err) {
            console.error("[BG-Agent] File write failed:", fullPath, err);
            store.addLog("failed", `Failed to write ${change.path}: ${err}`);
          } finally {
            // Always release the lock after write attempt
            resolver.releaseAndFlush(bgAgentId, change.path);
          }
        }
      }

      // Completion detection: if we wrote files AND ran commands successfully, task is done
      const allFilesApplied = result.fileChanges?.every(fc => {
        const hash = simpleHash(fc.content);
        return writtenFiles.has(fc.path) && writtenFiles.get(fc.path) === hash;
      }) ?? false;

      const allCommandsPassed = !result.commands?.length ||
        useBackgroundAgentStore.getState().session?.logs
          .filter(l => l.step === "verifying" && l.message.startsWith("Command passed"))
          .length === result.commands.length;

      if (allFilesApplied && allCommandsPassed && result.fileChanges && result.fileChanges.length > 0) {
        store.addLog("verifying", "Task complete — all files written and commands passed. Stopping loop.");
      }

      // Step 3: Run commands if any
      let commandApprovalStoppedTask = false;
      if (result.commands && result.commands.length > 0) {
        // ── Phase: Verify ──────────────────────────────────────────────────
        useBackgroundAgentStore.getState().advancePhase("verify");
        emitReasoning(`Running ${result.commands.length} command(s) for verification...\n`);

        for (const cmd of result.commands) {
          if (executorCancelled) break;

          store.updateStep("running_command", `Running: ${cmd.slice(0, 40)}`);
          console.log("[BG-Agent] Running command:", cmd);
          try {
            const validation = await inspectCommand(cmd, projectPath);
            if (validation.risk_level === "blocked") {
              store.addLog("failed", `Command blocked by safety policy: ${validation.feedback_message}`);
              commandApprovalStoppedTask = true;
              break;
            }

            // ── Tool Policy Check (replaces window.confirm) ──────────────
            const approvalMemory = getApprovalMemory();
            const policy = resolveCommandPolicy(validation.risk_level);

            let commandApproved = false;

            if (approvalMemory.wasDenied(cmd)) {
              store.addLog("analyzing_output", `Command previously denied: ${cmd}`);
              commandApprovalStoppedTask = true;
              break;
            }

            if (approvalMemory.isPreApproved(cmd, policy)) {
              // Auto-approved by policy or prior user decision
              commandApproved = true;
              store.addLog("running_command", `Auto-approved (${policy.risk}): ${validation.sanitized_command}`);
            } else {
              // Request non-blocking approval via the panel UI
              const approvalRequest: CommandApprovalRequest = {
                id: `cmd-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
                command: cmd,
                sanitizedCommand: validation.sanitized_command,
                riskLevel: policy.risk,
                feedbackMessage: validation.feedback_message,
                timestamp: Date.now(),
              };

              store.requestCommandApproval(approvalRequest);

              // Wait for user response (non-blocking — panel stays open, user keeps coding)
              commandApproved = await waitForApprovalDecision();

              if (commandApproved) {
                approvalMemory.recordApproval(cmd, policy);
              } else {
                approvalMemory.recordDenial(cmd);
                store.addLog("analyzing_output", `Command rejected by user: ${cmd}`);
                commandApprovalStoppedTask = true;
                break;
              }
            }

            if (!commandApproved) {
              commandApprovalStoppedTask = true;
              break;
            }

            const cmdResult = await runTerminalCommand(validation.sanitized_command, projectPath);
            const output = `$ ${cmd}\n${cmdResult.stdout}${cmdResult.stderr ? `\n${cmdResult.stderr}` : ""}`;
            store.appendTerminalOutput(output + "\n");

            if (cmdResult.exit_code !== 0) {
              store.addLog("analyzing_output", `Command failed (exit ${cmdResult.exit_code}): ${cmd}`);
            } else {
              store.addLog("verifying", `Command passed: ${cmd}`);
            }
          } catch (err) {
            store.addLog("failed", `Command error: ${err}`);
            commandApprovalStoppedTask = true;
            break;
          }
        }
      }
      if (commandApprovalStoppedTask) {
        store.fail("Background task stopped because a command was blocked or not approved.");
        break;
      }

      // ── Loop Guard: record successful attempt ──────────────────────
      // Record successful attempt for compaction
      attemptHistory.push({
        attempt: currentSession.attempt,
        task: currentTask,
        filesWritten: (result.fileChanges || []).filter(fc => writtenFiles.has(fc.path)).map(fc => fc.path),
        commandsRun: (result.commands || []).map(cmd => ({ command: cmd, success: true })),
        errors: [],
        outcome: "success",
      });

      const loopGuard = getLoopGuard();
      const attemptFileChanges = (result.fileChanges || []).map(fc => ({
        path: fc.path,
        contentHash: simpleHash(fc.content),
        applied: writtenFiles.has(fc.path),
      }));
      const attemptCommandResults: Array<{ command: string; success: boolean }> = [];
      // Gather command results from logs
      const recentLogs = useBackgroundAgentStore.getState().session?.logs.slice(-10) || [];
      for (const cmd of (result.commands || [])) {
        const passed = recentLogs.some(l => l.message.includes("Command passed") && l.message.includes(cmd.slice(0, 30)));
        attemptCommandResults.push({ command: cmd, success: passed });
      }
      const responseHash = simpleHash(JSON.stringify(result.fileChanges?.map(f => f.path + f.content) || []));
      loopGuard.recordAttempt(responseHash, attemptFileChanges, attemptCommandResults);

      const loopCheck = loopGuard.check();
      if (loopCheck.loopDetected) {
        console.log("[BG-Agent] Loop detected after success:", loopCheck.pattern, loopCheck.message);
        store.addLog("analyzing_output", `Loop pattern: ${loopCheck.message}`);
        if (loopCheck.recommendation === "abort") {
          store.fail(`Agent stuck: ${loopCheck.message}`);
          showToast("⚠️ Background agent stuck in loop — stopped", "error");
          break;
        }
      }

      // Advance to next subtask
      store.advanceSubtask();

      // ── Update planner subtask status ────────────────────────────────────
      const plannerState = useBackgroundAgentStore.getState();
      if (plannerState.plannerSubtasks.length > 0) {
        const completedIdx = currentSession.currentSubtask;
        const nextIdx = completedIdx + 1;
        const updatedPlannerSubtasks = plannerState.plannerSubtasks.map((st, idx) => {
          if (idx === completedIdx) return { ...st, status: "completed" as const };
          if (idx === nextIdx) return { ...st, status: "in_progress" as const };
          return st;
        });
        useBackgroundAgentStore.getState().setPlannerSubtasks(updatedPlannerSubtasks);
      }

      // Reset reasoning for new subtask and restart from decompose phase
      useBackgroundAgentStore.getState().clearReasoningStream();
      useBackgroundAgentStore.getState().advancePhase("decompose");
      emitReasoning("Moving to next subtask...\n");

      // Notify user of progress
      const updatedState = useBackgroundAgentStore.getState();
      if (updatedState.session?.step === "completed") {
        const fileCount = updatedState.session.fileChanges.filter((f) => f.applied).length;
        showToast(`✓ Background task done — ${fileCount} file${fileCount !== 1 ? "s" : ""} updated`, "success");
        console.log("[BG-Agent] Task completed successfully");
      }

      // Small delay between subtasks
      await sleep(500);
    }
  } catch (err) {
    console.error("[BG-Agent] Unexpected error:", err);
    const store2 = useBackgroundAgentStore.getState();
    if (store2.isRunning) {
      useBackgroundAgentStore.getState().fail(`Unexpected error: ${err}`);
      showToast("⚠️ Background task crashed", "error");
    }
  } finally {
    // Unregister from orchestrator
    try {
      orchestrator.removeAgent(bgAgentId);
    } catch { /* ignore */ }
    executorRunning = false;
    console.log("[BG-Agent] Executor stopped");
  }
}

/**
 * Cancel the running background execution.
 */
export function cancelBackgroundExecution(): void {
  executorCancelled = true;
}

/**
 * Check if the executor is currently running.
 */
export function isExecutorRunning(): boolean {
  return executorRunning;
}

// --- Internal ---

/**
 * Wait for the user to approve or deny a command via the panel UI.
 * Polls the store for resolution — non-blocking to the UI thread.
 * Times out after 5 minutes (returns false = denied).
 */
async function waitForApprovalDecision(): Promise<boolean> {
  const TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
  const POLL_INTERVAL_MS = 300;
  const startTime = Date.now();

  return new Promise<boolean>((resolve) => {
    const check = () => {
      // If executor was cancelled while waiting, treat as denial
      if (executorCancelled) {
        resolve(false);
        return;
      }

      const state = useBackgroundAgentStore.getState();

      // If approval was resolved (user clicked approve/deny), the pendingCommandApproval is null
      if (state.pendingCommandApproval === null) {
        // Check the session step to determine what happened
        const step = state.session?.step;
        if (step === "running_command") {
          resolve(true); // approved
        } else {
          resolve(false); // denied or cancelled
        }
        return;
      }

      // Timeout check
      if (Date.now() - startTime > TIMEOUT_MS) {
        useBackgroundAgentStore.getState().resolveCommandApproval(false);
        resolve(false);
        return;
      }

      setTimeout(check, POLL_INTERVAL_MS);
    };

    check();
  });
}

interface StepResult {
  success: boolean;
  error?: string;
  fileChanges?: Array<{ path: string; content: string; isNew: boolean }>;
  commands?: string[];
}

async function executeOneStep(
  task: string,
  session: ReturnType<typeof useBackgroundAgentStore.getState>["session"] & {},
  config: ExecutorConfig
): Promise<StepResult> {
  const { projectPath, aiProviders } = config;

  // Find a usable provider
  const provider = aiProviders.find(
    (p) => p.apiKey && p.models.some((m) => m.enabled && m.id)
  );
  if (!provider) return { success: false, error: "No AI provider configured" };

  const model = provider.models.find((m) => m.enabled && m.id);
  if (!model) return { success: false, error: "No model enabled" };

  // Build context
  const memories = await loadAgentMemories(projectPath);
  const compressedMemory = compressMemories(memories);

  // Load relevant files from context snapshot
  const snippets: string[] = [];
  for (const filePath of session.contextFiles.slice(0, 5)) {
    try {
      const fullPath = buildFullPath(projectPath, filePath);
      const content = await readFile(fullPath);
      if (content) {
        snippets.push(`## ${filePath}\n\`\`\`\n${content.slice(0, 4000)}\n\`\`\``);
      }
    } catch { /* skip */ }
  }

  const historyContext = session.logs
    .filter((l) => l.step === "analyzing_output" || l.step === "failed")
    .slice(-3)
    .map((l) => l.message)
    .join("\n");

  const payload = await assemblePersistentPayload({
    globalGoal: session.task,
    currentSubtask: `${task} (attempt ${session.attempt}/${session.maxAttempts})${historyContext ? "\nPrevious issues:\n" + historyContext : ""}`,
    fullHistory: [],
    activeFileSnippets: snippets,
    latestErrors: session.terminalOutput.slice(-2000),
    projectMemory: compressedMemory,
    projectPath,
  });

  try {
    const backgroundExecutionRules = `
## Background Agent Action Contract
You are running as PunamIDE's background agent. Your response is parsed by the IDE.

Use the exact same action format as Punam chat:

===FILE: path/to/file.ext===
<complete file content>
===END_FILE===

===DELETE: path/to/file.ext===

===CMD: command to run===

Rules:
- For background tasks, do not use markdown code fences as a substitute for FILE blocks.
- Do not use EDIT blocks in background tasks; use FILE blocks so the executor can apply the result directly.
- If the user asks to create an app and run/open it, include both the FILE block(s) and a CMD block.
- For a standalone HTML file on Windows, open it with: ===CMD: start filename.html===
- Never claim a file was created, an app was opened, or a task is complete unless you returned the FILE/CMD blocks needed for the IDE to do that work.
- If you cannot safely act, explain why and do not claim completion.
`;

    // Get shared context from coordinator (architecture advice, security concerns)
    const coordinator = getAgentCoordinator();
    const agentContext = coordinator.buildAgentContext("implementation");

    const systemPrompt = `${SYSTEM_PROMPT}\n\n${payload.systemInstruction}\n\n${backgroundExecutionRules}${agentContext ? `\n\n## Multi-Agent Context\n${agentContext}` : ""}`;
    const baseUserPrompt = payload.contents.map((c) => c.parts[0].text).join("\n\n");

    let resp = await sendToProviderStreaming(provider, model.id, {
      systemPrompt,
      userPrompt: baseUserPrompt,
    });

    console.log("[BG-Agent] LLM response:", { success: resp.success, textLength: resp.text?.length, error: resp.error });

    if (!resp.success) {
      return { success: false, error: resp.error || "AI request failed" };
    }

    // Pipe AI reasoning to the planner panel
    if (resp.text) {
      // Extract explanation/reasoning portion (text before FILE/CMD blocks)
      const reasoningEnd = resp.text.search(/===FILE:|===CMD:|===DELETE:/);
      const reasoning = reasoningEnd > 0 ? resp.text.slice(0, reasoningEnd).trim() : "";
      if (reasoning) {
        emitReasoning(reasoning.slice(0, 500) + "\n");
      }
    }

    // Parse the response
    let parsed = parseResponse(resp.text, new Set<string>());
    let hasChanges = parsed.fileChanges.length > 0 || parsed.commands.length > 0;
    console.log("[BG-Agent] Parsed:", { fileChanges: parsed.fileChanges.length, commands: parsed.commands.length, explanation: parsed.explanation?.slice(0, 80) });

    if (!hasChanges) {
      // AI responded but no actionable changes — might be done or confused
      useBackgroundAgentStore.getState().addLog("analyzing_output", "No actionable FILE/CMD blocks. Retrying once with strict action-only instruction.");
      resp = await sendToProviderStreaming(provider, model.id, {
        systemPrompt,
        userPrompt: `${baseUserPrompt}

Your previous response had no actionable FILE or CMD blocks.
Return ONLY the required FILE/CMD blocks.
Do not explain.`,
      });

      console.log("[BG-Agent] Strict retry response:", { success: resp.success, textLength: resp.text?.length, error: resp.error });

      if (!resp.success) {
        return { success: false, error: resp.error || "AI request failed" };
      }

      parsed = parseResponse(resp.text, new Set<string>());
      hasChanges = parsed.fileChanges.length > 0 || parsed.commands.length > 0;
      console.log("[BG-Agent] Strict retry parsed:", { fileChanges: parsed.fileChanges.length, commands: parsed.commands.length, explanation: parsed.explanation?.slice(0, 80) });

      if (!hasChanges) {
        return { success: false, error: NO_ACTION_ERROR };
      }
    }

    const fileChanges = parsed.fileChanges.map((fc) => ({
      path: fc.path,
      content: fc.content,
      isNew: fc.isNew,
    }));
    const commands = [...parsed.commands];
    const htmlOpenCommand = inferHtmlOpenCommand(session.task, task, fileChanges, commands);
    if (htmlOpenCommand) {
      commands.push(htmlOpenCommand);
      useBackgroundAgentStore.getState().addLog("verifying", `Added browser open command: ${htmlOpenCommand}`);
    }

    return {
      success: true,
      fileChanges,
      commands,
    };
  } catch (err) {
    return { success: false, error: `Request error: ${err}` };
  }
}

function inferHtmlOpenCommand(
  globalTask: string,
  currentTask: string,
  fileChanges: Array<{ path: string }>,
  commands: string[]
): string | null {
  const taskText = `${globalTask}\n${currentTask}`.toLowerCase();
  const askedToOpen =
    /\b(open|run|launch|start)\b/.test(taskText) &&
    /\b(browser|complete|completed|finished|completion|done|app|html|page|game)\b/.test(taskText);
  if (!askedToOpen || commands.length > 0) return null;

  const htmlFiles = fileChanges
    .map((change) => change.path)
    .filter((path) => /\.html?$/i.test(path));

  if (htmlFiles.length !== 1) return null;
  return `start ${htmlFiles[0]}`;
}

function buildFullPath(projectPath: string, relativePath: string): string {
  if (/^[A-Za-z]:[\\/]/.test(relativePath) || relativePath.startsWith("/")) {
    return relativePath;
  }
  const separator = projectPath.includes("\\") ? "\\" : "/";
  return `${projectPath.replace(/[\\/]+$/, "")}${separator}${relativePath.replace(/^[\\/]+/, "")}`;
}

function normalizePath(p: string): string {
  return p.replace(/\\/g, "/").toLowerCase();
}

function simpleHash(str: string): string {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash |= 0; // Convert to 32-bit integer
  }
  return hash.toString(36);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
