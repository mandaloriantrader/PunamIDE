// src/utils/toolLoops/planner.ts
//
// Phase 2: Planner stage — generates a structured step-by-step plan before tool execution.

import { type ToolLoopOptions, type AgentPlan, recordLoopMetrics } from "./shared";

/**
 * Generate a structured plan before the main tool loop starts.
 * Uses a cheap/fast LLM call to produce a 3-5 step exploration plan.
 * Falls back silently if the LLM call fails — the agent still works reactively.
 */
export async function generatePlan(opts: ToolLoopOptions): Promise<AgentPlan | null> {
  try {
    const { sendToProviderStreaming } = await import("../providers");
    const planSystemPrompt = [
      "You are a planning assistant. Given a user's task, produce a concise step-by-step plan.",
      "Output ONLY a JSON object with format:",
      '{ "goal": "brief goal", "steps": [ {"index":1,"description":"step description"} ] }',
      "No markdown, no explanation — only the JSON object.",
      "Maximum 5 steps. Each step describes WHAT to investigate, not HOW.",
    ].join("\n");
    const planPrompt = `Task: ${opts.task}\n\nProject: ${opts.projectPath}\n${opts.activeFilePath ? "Active file: " + opts.activeFilePath : ""}\n\nProduce the plan JSON:`;

    const resp = await sendToProviderStreaming(opts.provider, opts.modelId, {
      systemPrompt: planSystemPrompt,
      userPrompt: planPrompt,
      signal: opts.signal,
    });
    recordLoopMetrics(opts, resp.metrics);
    if (!resp.success || !resp.text.trim()) return null;

    const jsonMatch = resp.text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;
    const parsed = JSON.parse(jsonMatch[0]) as { goal: string; steps: Array<{ index: number; description: string }> };
    if (!parsed.goal || !Array.isArray(parsed.steps)) return null;

    const plan: AgentPlan = {
      goal: parsed.goal,
      steps: parsed.steps.slice(0, 5).map((s, i) => ({ index: i + 1, description: s.description })),
      generatedAt: Date.now(),
    };
    opts.onPlanReady?.(plan);
    return plan;
  } catch {
    return null;
  }
}
