/**
 * Background Agent Executor — Runs agent tasks independently of the chat UI.
 * Uses the same AI providers and parsing logic but writes to the background store.
 */

import { useBackgroundAgentStore } from "../store/backgroundAgentStore";
import { sendToProviderStreaming } from "../utils/providers";
import type { AIProviderConfig } from "../utils/providers";
import { parseResponse, SYSTEM_PROMPT } from "../utils/prompts";
import { readFile, writeFile, runTerminalCommand } from "../utils/tauri";
import {
  assemblePersistentPayload,
  loadAgentMemories,
  compressMemories,
} from "../utils/contextEngine";
import { showToast } from "../utils/toast";

interface ExecutorConfig {
  projectPath: string;
  aiProviders: AIProviderConfig[];
  openTabPaths: string[]; // For conflict detection
}

let executorRunning = false;
let executorCancelled = false;
const NO_ACTION_ERROR = "No actionable FILE or CMD blocks were produced.";

/**
 * Start executing the background agent task.
 * This runs asynchronously and updates the store as it progresses.
 */
export async function startBackgroundExecution(config: ExecutorConfig): Promise<void> {
  if (executorRunning) return;
  executorRunning = true;
  executorCancelled = false;

  const store = useBackgroundAgentStore.getState();
  const session = store.session;
  if (!session) {
    console.warn("[BG-Agent] No session found, aborting");
    executorRunning = false;
    return;
  }

  const { projectPath, openTabPaths } = config;
  console.log("[BG-Agent] Starting execution:", { task: session.task, projectPath, subtasks: session.subtasks });

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

      // Step 1: Plan and propose fix
      store.updateStep("proposing_fix", `Working on: ${currentTask.slice(0, 50)}`);

      const result = await executeOneStep(currentTask, currentSession, config);
      console.log("[BG-Agent] Step result:", { success: result.success, error: result.error, fileChanges: result.fileChanges?.length, commands: result.commands?.length });

      if (executorCancelled) break;

      if (!result.success) {
        if (result.error === NO_ACTION_ERROR) {
          store.fail(`${NO_ACTION_ERROR} Background tasks must return real file changes or commands before they can be marked complete.`);
          showToast("Background task stopped: no actionable changes were produced", "error");
          break;
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

      // Step 2: Apply file changes
      if (result.fileChanges && result.fileChanges.length > 0) {
        for (const change of result.fileChanges) {
          if (executorCancelled) break;

          const fullPath = buildFullPath(projectPath, change.path);
          console.log("[BG-Agent] Applying file:", { path: change.path, fullPath, isNew: change.isNew });

          const isConflicting = openTabPaths.some(
            (tabPath) => normalizePath(tabPath) === normalizePath(fullPath)
          );

          store.addFileChange({
            path: change.path,
            content: change.content,
            isNew: change.isNew,
            applied: false,
            conflicting: isConflicting,
          });

          if (isConflicting) {
            store.addLog("verifying", `Conflict: ${change.path} is open in editor — skipped`);
            continue;
          }

          // Apply directly
          try {
            await writeFile(fullPath, change.content);
            store.markFileApplied(change.path);
            store.addLog("verifying", `Applied: ${change.path}`);
            console.log("[BG-Agent] File written successfully:", fullPath);
          } catch (err) {
            console.error("[BG-Agent] File write failed:", fullPath, err);
            store.addLog("failed", `Failed to write ${change.path}: ${err}`);
          }
        }
      }

      // Step 3: Run commands if any
      if (result.commands && result.commands.length > 0) {
        for (const cmd of result.commands) {
          if (executorCancelled) break;

          store.updateStep("running_command", `Running: ${cmd.slice(0, 40)}`);
          console.log("[BG-Agent] Running command:", cmd);
          try {
            const cmdResult = await runTerminalCommand(cmd, projectPath);
            const output = `$ ${cmd}\n${cmdResult.stdout}${cmdResult.stderr ? `\n${cmdResult.stderr}` : ""}`;
            store.appendTerminalOutput(output + "\n");

            if (cmdResult.exit_code !== 0) {
              store.addLog("analyzing_output", `Command failed (exit ${cmdResult.exit_code}): ${cmd}`);
            } else {
              store.addLog("verifying", `Command passed: ${cmd}`);
            }
          } catch (err) {
            store.addLog("failed", `Command error: ${err}`);
          }
        }
      }

      // Advance to next subtask
      store.advanceSubtask();

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
  const memories = loadAgentMemories(projectPath);
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

  const payload = assemblePersistentPayload({
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

    const systemPrompt = `${SYSTEM_PROMPT}\n\n${payload.systemInstruction}\n\n${backgroundExecutionRules}`;
    const baseUserPrompt = payload.contents.map((c) => c.parts[0].text).join("\n\n");

    let resp = await sendToProviderStreaming(provider, model.id, {
      systemPrompt,
      userPrompt: baseUserPrompt,
    });

    console.log("[BG-Agent] LLM response:", { success: resp.success, textLength: resp.text?.length, error: resp.error });

    if (!resp.success) {
      return { success: false, error: resp.error || "AI request failed" };
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
