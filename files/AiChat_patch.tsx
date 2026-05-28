// ─────────────────────────────────────────────────────────────────────────────
// AiChat.tsx — Phase 1 patch
//
// Apply these changes. The rest of the file is UNTOUCHED.
// ─────────────────────────────────────────────────────────────────────────────

// ── CHANGE 1: Add imports at the top ─────────────────────────────────────────
// Find this existing import block (around line 20):
//
//   import { sendToMultipleModels, sendToProviderStreaming, estimateTokens } from "../utils/providers";
//
// Add these two lines AFTER it:

import { runAgentToolLoop, shouldUseToolLoop } from "../utils/agentToolLoop";

// ─────────────────────────────────────────────────────────────────────────────
// ── CHANGE 2: Replace agentProposeFix ────────────────────────────────────────
//
// Find the existing agentProposeFix function (starts around line 1565):
//   const agentProposeFix = async () => {
//
// Replace the ENTIRE function body with the version below.
// The function signature stays the same.
// ─────────────────────────────────────────────────────────────────────────────

  const agentProposeFix = async () => {
    if (!agentTask || !agentTask.active) return;

    setAgentTask((prev) => prev ? { ...prev, step: "proposing_fix" } : null);

    // ── Shared setup (same for both paths) ──────────────────────────────────
    const existingFiles = collectExistingFiles();
    const errorContextText = [terminalOutput || "", proactiveError?.output || ""]
      .filter(Boolean)
      .join("\n");

    // Load persistent memories
    const memories = loadAgentMemories(projectPath);
    const compressedMemory = compressMemories(memories);
    const chatSummary = summarizeOldMessages(messages);
    const fullMemory = [compressedMemory, chatSummary].filter(Boolean).join("\n\n");

    // Previous attempt history
    const historyContext = agentTask.history.length > 0
      ? `Previous attempts (DO NOT repeat):\n${agentTask.history.map((h, i) => `${i + 1}. ${h}`).join("\n")}`
      : "";

    const currentTask = agentTask.subtasks.length > 1
      ? agentTask.subtasks[agentTask.currentSubtask]
      : agentTask.task;

    // ── Pick path: tool loop OR full-context fallback ────────────────────────
    const enabledModels = getEnabledModels();
    if (enabledModels.length === 0) {
      setMessages(prev => [...prev, { role: "assistant", content: "No AI provider configured." }]);
      setLoading(false);
      return;
    }
    const { providerId, model: modelId } = enabledModels[0];
    const provider = aiProviders.find(p => p.id === providerId);
    if (!provider) {
      setMessages(prev => [...prev, { role: "assistant", content: "Provider not found." }]);
      setLoading(false);
      return;
    }

    const useToolLoop = shouldUseToolLoop(currentTask);

    // ── Path A: Tool-calling loop ────────────────────────────────────────────
    if (useToolLoop) {
      const payload = assemblePersistentPayload({
        globalGoal: agentTask.task,
        currentSubtask: `${currentTask} (attempt ${agentTask.attempt}/${agentTask.maxAttempts})${historyContext ? "\n" + historyContext : ""}`,
        fullHistory: messages,
        activeFileSnippets: [], // tool loop reads on demand — no snippets upfront
        latestErrors: errorContextText.slice(-2000),
        projectMemory: fullMemory,
        projectPath,
        toolLoopMode: true, // ← key flag
      });

      setLoading(true);

      // Add streaming placeholder
      const streamId = `stream-${Date.now()}`;
      setMessages(prev => [...prev, { role: "assistant", content: "▍", mode: "chat", streamId } as any]);

      // Track which tools fired (for UI feedback)
      const firedTools: string[] = [];

      await runAgentToolLoop({
        provider,
        modelId,
        systemPrompt: payload.systemInstruction,
        task: currentTask,
        projectPath,
        activeFilePath,
        maxRounds: 10,

        onToolCall: (toolName) => {
          firedTools.push(toolName);
          // Show a subtle status while tools are running
          const statusText = `🔧 Using tool: \`${toolName}\`…`;
          setMessages(prev => prev.map(m =>
            (m as any).streamId === streamId
              ? { ...m, content: statusText + "\n\n▍" }
              : m
          ));
        },

        onToken: (token) => {
          // For JSON-fallback providers, update the message as text arrives
          setMessages(prev => prev.map(m =>
            (m as any).streamId === streamId
              ? { ...m, content: token + "▍" }
              : m
          ));
        },

        onDone: async (finalText) => {
          // Parse the final answer for any FILE/CMD blocks (full-context style)
          let parsed = await parseResponseAsync(finalText, existingFiles).catch(() => null);
          if (parsed && parsed.editOperations.length > 0) {
            parsed = await resolveEditOperations(parsed, projectPath);
          }
          const hasActions = parsed ? hasParsedActions(parsed) : false;

          setMessages(prev => prev.map(m => {
            if ((m as any).streamId !== streamId) return m;
            const { streamId: _sid, ...rest } = m as any;
            return {
              ...rest,
              content: finalText,
              parsed: hasActions ? parsed : undefined,
              applied: false,
            };
          }));

          if (parsed) {
            const changedFiles = parsed.fileChanges.map(f => f.path);
            extractMemoriesFromResponse(projectPath, currentTask, finalText, changedFiles);
          }

          setLoading(false);
          setAgentTask((prev) => prev ? { ...prev, step: "awaiting_approval" } : null);
        },

        onError: (err) => {
          console.warn("[AGENT TOOL LOOP] Tool loop failed, will retry with full-context fallback:", err);
          // On tool loop error: fall through to full-context fallback below
          setMessages(prev => prev.filter(m => (m as any).streamId !== streamId));
          setLoading(false);
          // Trigger full-context retry by re-running without tool loop
          _agentProposeFixFullContext(
            currentTask, existingFiles, errorContextText, fullMemory, historyContext,
            provider, modelId
          );
        },
      });

      return; // Path A done
    }

    // ── Path B: Full-context fallback (original behaviour, unchanged) ────────
    await _agentProposeFixFullContext(
      currentTask, existingFiles, errorContextText, fullMemory, historyContext,
      provider, modelId
    );
  };

// ─────────────────────────────────────────────────────────────────────────────
// ── CHANGE 3: Add _agentProposeFixFullContext helper ─────────────────────────
//
// Add this NEW function IMMEDIATELY AFTER the agentProposeFix function above.
// It contains the original agentProposeFix body, unchanged.
// ─────────────────────────────────────────────────────────────────────────────

  // Full-context fallback — original logic extracted into its own function
  // so it can be called from agentProposeFix (Path B) and as an error fallback.
  const _agentProposeFixFullContext = async (
    currentTask: string,
    existingFiles: ReturnType<typeof collectExistingFiles>,
    errorContextText: string,
    fullMemory: string,
    historyContext: string,
    provider: import("../utils/providers").AIProviderConfig,
    modelId: string
  ) => {
    const errorFiles = getFilePathsFromText(errorContextText, existingFiles);

    // Load relevant file snippets (error-referenced files + active file)
    const snippets: string[] = [];
    const AGENT_FILE_LIMIT = 60000;
    for (const filePath of errorFiles.slice(0, 3)) {
      try {
        const content = await readFile(getProjectFilePath(projectPath, filePath));
        if (content) {
          const clipped = content.slice(0, AGENT_FILE_LIMIT);
          const numbered = clipped.split("\n").map((line, i) => `${String(i + 1).padStart(4, " ")} | ${line}`).join("\n");
          snippets.push(`## ${filePath}\n\`\`\`\n${numbered}\n\`\`\``);
        }
      } catch { /* skip */ }
    }
    if (activeFilePath) {
      const relPath = getRelativePath(projectPath, activeFilePath);
      if (!errorFiles.includes(relPath)) {
        const content = await readFile(activeFilePath).catch(() => "");
        if (content) {
          const clipped = content.slice(0, AGENT_FILE_LIMIT);
          const numbered = clipped.split("\n").map((line, i) => `${String(i + 1).padStart(4, " ")} | ${line}`).join("\n");
          snippets.push(`## ${relPath}\n\`\`\`\n${numbered}\n\`\`\``);
        }
      }
    }

    const payload = assemblePersistentPayload({
      globalGoal: agentTask!.task,
      currentSubtask: `${currentTask} (attempt ${agentTask!.attempt}/${agentTask!.maxAttempts})${historyContext ? "\n" + historyContext : ""}`,
      fullHistory: messages,
      activeFileSnippets: snippets,
      latestErrors: errorContextText.slice(-2000),
      projectMemory: fullMemory,
      projectPath,
      toolLoopMode: false, // full-context path
    });

    setLoading(true);
    try {
      const streamId = `stream-${Date.now()}`;
      setMessages(prev => [...prev, { role: "assistant", content: "▍", mode: "chat", streamId } as any]);

      const { listen } = await import("@tauri-apps/api/event");
      let streamedText = "";
      let pendingFlush = false;
      let flushTimer: ReturnType<typeof setTimeout> | null = null;

      const flushStreamedText = () => {
        pendingFlush = false;
        flushTimer = null;
        const displayText = getStreamingTextBeforeActionBlocks(streamedText);
        setMessages(prev => prev.map(m =>
          (m as any).streamId === streamId ? { ...m, content: displayText + "▍" } : m
        ));
      };

      const unlisten = await listen<{ token: string; done: boolean }>("llm-stream", (event) => {
        const { token, done } = event.payload;
        if (!done && token) {
          streamedText += token;
          if (!pendingFlush) {
            pendingFlush = true;
            flushTimer = setTimeout(flushStreamedText, 40);
          }
        }
      });

      // Only take the first user turn — the context block
      const contextBlock = payload.contents
        .find(c => c.role === "user")
        ?.parts[0].text ?? "";

      const finalUserPrompt = `${contextBlock}\n\n# USER QUESTION:\n${currentTask}`;

      const resp = await sendToProviderStreaming(provider, modelId, {
        systemPrompt: payload.systemInstruction,
        userPrompt: finalUserPrompt,
      });
      unlisten();
      if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
      if (pendingFlush) flushStreamedText();

      const finalText = resp.success ? resp.text : (resp.error || "Unknown error");
      let parsed = resp.success ? await parseResponseAsync(finalText, existingFiles) : null;
      if (parsed && parsed.editOperations.length > 0) {
        parsed = await resolveEditOperations(parsed, projectPath);
      }
      const hasActions = parsed ? hasParsedActions(parsed) : false;
      recordResponseUsage(resp.metrics);

      setMessages(prev => prev.map(m => {
        if ((m as any).streamId !== streamId) return m;
        const { streamId: _sid, ...rest } = m as any;
        return { ...rest, content: finalText, parsed: hasActions ? parsed : undefined, applied: false, metrics: resp.metrics };
      }));

      if (resp.success && parsed) {
        const changedFiles = parsed.fileChanges.map(f => f.path);
        extractMemoriesFromResponse(projectPath, currentTask, finalText, changedFiles);
      }

    } catch (err) {
      const providerName = aiProviders.find(hasUsableProvider)?.name || "AI";
      setMessages(prev => [...prev, { role: "assistant", content: `Currently using ${providerName}. Something went wrong — please try again.` }]);
    } finally {
      setLoading(false);
    }

    setAgentTask((prev) => prev ? { ...prev, step: "awaiting_approval" } : null);
  };
