import type { AIProviderConfig } from "../../utils/providers";
import {
  buildProviderCapabilities,
  type AdaptiveSelectionResult,
  type AdaptiveStrategy,
  type ProviderCapability,
  type TaskType,
} from "./providerCapabilities";
import { getProviderHealth } from "./providerHealth";

const COST_SCORE = { free: 0, local: 0, cheap: 1, paid: 3 };
const SPEED_SCORE = { fast: 0, medium: 1, slow: 2 };

function isProvider(capability: ProviderCapability, name: string): boolean {
  return capability.displayName.toLowerCase().includes(name) || (capability.config.baseUrl || "").toLowerCase().includes(name);
}

function chooseModel(capability: ProviderCapability, taskType: TaskType): string {
  const enabledModels = capability.config.models.filter((model) => model.enabled && model.id).map((model) => model.id);
  const findModel = (patterns: RegExp[]) => enabledModels.find((model) => patterns.some((pattern) => pattern.test(model)));

  if (["coding_fix", "code_generation", "refactor", "agent_task"].includes(taskType)) {
    return findModel([/codestral/i, /deepseek/i, /qwen/i, /coder/i]) || enabledModels[0] || capability.defaultModel;
  }
  if (taskType === "large_context") {
    return findModel([/gemini-2\.5/i, /claude/i, /large/i, /pro/i]) || enabledModels[0] || capability.defaultModel;
  }
  return enabledModels[0] || capability.defaultModel;
}

function taskScore(capability: ProviderCapability, taskType: TaskType, contextSize: number): number {
  let score = 0;
  if (getProviderHealth(capability.providerId).status !== "healthy") score -= 100;
  if (!capability.enabled || !capability.hasApiKey) score -= 100;
  if (contextSize > capability.maxContextEstimate) score -= 40;

  if (taskType === "autocomplete" || taskType === "quick_chat") {
    if (isProvider(capability, "groq")) score += 35;
    if (capability.speedTier === "fast") score += 15;
  }
  if (taskType === "large_context") {
    if (isProvider(capability, "gemini")) score += 35;
    if (capability.strengths.includes("large-context")) score += 20;
  }
  if (["coding_fix", "code_generation", "refactor", "agent_task"].includes(taskType)) {
    if (isProvider(capability, "mistral")) score += 26;
    if (isProvider(capability, "openrouter")) score += 24;
    if (isProvider(capability, "gemini")) score += 14;
    if (capability.strengths.includes("coding")) score += 18;
  }
  if (taskType === "debugging" || taskType === "terminal_error_fix") {
    if (isProvider(capability, "gemini")) score += 28;
    if (isProvider(capability, "openrouter")) score += 20;
    if (capability.strengths.includes("reasoning")) score += 16;
  }
  if (taskType === "vision") {
    score += capability.supportsVision ? 35 : -80;
  }

  return score;
}

function strategyScore(capability: ProviderCapability, strategy: AdaptiveStrategy): number {
  switch (strategy) {
    case "free_first":
      return capability.costTier === "free" ? 25 : capability.costTier === "cheap" ? 12 : capability.costTier === "local" ? 8 : -12;
    case "fast_first":
      return 20 - SPEED_SCORE[capability.speedTier] * 10;
    case "best_quality":
      if (isProvider(capability, "openai") || isProvider(capability, "openrouter")) return 24;
      if (isProvider(capability, "gemini")) return 18;
      return capability.strengths.includes("reasoning") ? 8 : 0;
    case "cheapest":
      return 18 - COST_SCORE[capability.costTier] * 8;
    case "coding_optimized":
      return capability.strengths.includes("coding") ? 24 : 0;
    default:
      return 0;
  }
}

function reasonFor(taskType: TaskType, strategy: AdaptiveStrategy): string {
  if (taskType === "large_context") return "large context routing";
  if (taskType === "quick_chat" || taskType === "autocomplete") return "quick response routing";
  if (["coding_fix", "code_generation", "refactor", "agent_task"].includes(taskType)) return "coding optimized routing";
  if (taskType === "debugging" || taskType === "terminal_error_fix") return "debugging/error routing";
  if (taskType === "vision") return "vision-capable routing";
  return `${strategy.replace("_", " ")} routing`;
}

export function selectAdaptiveProvider(
  taskType: TaskType,
  contextSize: number,
  userStrategy: AdaptiveStrategy,
  enabledProviders: AIProviderConfig[]
): AdaptiveSelectionResult | null {
  const capabilities = buildProviderCapabilities(enabledProviders)
    .filter((capability) => capability.enabled && capability.hasApiKey)
    .filter((capability) => getProviderHealth(capability.providerId).status === "healthy");

  const ranked = capabilities
    .map((capability) => {
      const score = taskScore(capability, taskType, contextSize) + strategyScore(capability, userStrategy);
      const model = chooseModel(capability, taskType);
      return { capability, score, model };
    })
    .sort((a, b) => b.score - a.score);

  const best = ranked[0];
  if (!best) return null;

  const candidates = ranked.map(({ capability, model }) => ({
    provider: capability.config,
    model,
    reason: reasonFor(taskType, userStrategy),
  }));

  return {
    provider: best.capability.config,
    model: best.model,
    taskType,
    strategy: userStrategy,
    contextSize,
    reason: reasonFor(taskType, userStrategy),
    candidates,
  };
}
