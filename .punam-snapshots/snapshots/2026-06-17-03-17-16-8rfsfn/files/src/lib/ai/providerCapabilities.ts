import type { AIProviderConfig } from "../../utils/providers";

export type AdaptiveStrategy = "free_first" | "fast_first" | "best_quality" | "cheapest" | "coding_optimized";

export type TaskType =
  | "autocomplete"
  | "quick_chat"
  | "coding_fix"
  | "code_generation"
  | "debugging"
  | "large_context"
  | "vision"
  | "terminal_error_fix"
  | "refactor"
  | "agent_task";

export type ProviderHealthStatus = "healthy" | "rate_limited" | "invalid_key" | "unavailable" | "timeout";

export type CostTier = "free" | "cheap" | "paid" | "local";
export type SpeedTier = "fast" | "medium" | "slow";
export type ProviderStrength = "coding" | "reasoning" | "large-context" | "chat" | "autocomplete";

export interface ProviderCapability {
  providerId: string;
  displayName: string;
  defaultModel: string;
  availableModels: string[];
  maxContextEstimate: number;
  supportsStreaming: boolean;
  supportsVision: boolean;
  supportsTools: boolean;
  costTier: CostTier;
  speedTier: SpeedTier;
  strengths: ProviderStrength[];
  enabled: boolean;
  hasApiKey: boolean;
  config: AIProviderConfig;
}

export interface AdaptiveSelectionResult {
  provider: AIProviderConfig;
  model: string;
  taskType: TaskType;
  strategy: AdaptiveStrategy;
  contextSize: number;
  reason: string;
  candidates: Array<{ provider: AIProviderConfig; model: string; reason: string }>;
}

interface ProviderProfile {
  match: (provider: AIProviderConfig) => boolean;
  defaultModel: string;
  knownModels: string[];
  maxContextEstimate: number;
  supportsVision: boolean;
  supportsTools: boolean;
  costTier: CostTier;
  speedTier: SpeedTier;
  strengths: ProviderStrength[];
}

const PROVIDER_PROFILES: ProviderProfile[] = [
  {
    match: (p) => p.type === "gemini" || /gemini|google/i.test(p.name),
    defaultModel: "gemini-2.5-flash",
    knownModels: ["gemini-2.5-flash", "gemini-2.5-pro", "gemini-2.0-flash"],
    maxContextEstimate: 1_000_000,
    supportsVision: true,
    supportsTools: false,
    costTier: "free",
    speedTier: "fast",
    strengths: ["large-context", "reasoning", "chat", "coding"],
  },
  {
    match: (p) => /groq/i.test(p.name) || /groq\.com/i.test(p.baseUrl || ""),
    defaultModel: "llama-3.3-70b-versatile",
    knownModels: ["llama-3.3-70b-versatile", "llama-3.1-8b-instant", "openai/gpt-oss-120b"],
    maxContextEstimate: 32_000,
    supportsVision: false,
    supportsTools: false,
    costTier: "free",
    speedTier: "fast",
    strengths: ["autocomplete", "chat"],
  },
  {
    match: (p) => /openrouter/i.test(p.name) || /openrouter\.ai/i.test(p.baseUrl || ""),
    defaultModel: "deepseek/deepseek-r1:free",
    knownModels: [
      "deepseek/deepseek-r1:free",
      "qwen/qwen-2.5-coder-32b-instruct:free",
      "anthropic/claude-sonnet-4",
    ],
    maxContextEstimate: 128_000,
    supportsVision: true,
    supportsTools: false,
    costTier: "cheap",
    speedTier: "medium",
    strengths: ["coding", "reasoning", "large-context"],
  },
  {
    match: (p) => /deepseek/i.test(p.name) || /api\.deepseek\.com/i.test(p.baseUrl || ""),
    defaultModel: "deepseek-v4-flash",
    knownModels: ["deepseek-v4-flash", "deepseek-v4-pro", "deepseek-chat", "deepseek-reasoner"],
    maxContextEstimate: 128_000,
    supportsVision: false,
    supportsTools: false,
    costTier: "cheap",
    speedTier: "medium",
    strengths: ["coding", "reasoning", "chat"],
  },
  {
    match: (p) => /mistral/i.test(p.name) || /mistral\.ai/i.test(p.baseUrl || ""),
    defaultModel: "codestral-latest",
    knownModels: ["codestral-latest", "mistral-small-latest", "mistral-large-latest"],
    maxContextEstimate: 128_000,
    supportsVision: false,
    supportsTools: true,
    costTier: "cheap",
    speedTier: "medium",
    strengths: ["coding", "autocomplete", "chat"],
  },
  {
    match: (p) => /ollama/i.test(p.name) || /localhost:11434/i.test(p.baseUrl || ""),
    defaultModel: "qwen2.5:7b",
    knownModels: ["qwen2.5:7b", "codellama", "llama3.1"],
    maxContextEstimate: 32_000,
    supportsVision: false,
    supportsTools: false,
    costTier: "local",
    speedTier: "medium",
    strengths: ["coding", "chat"],
  },
  {
    match: (p) => /openai/i.test(p.name) || /api\.openai\.com/i.test(p.baseUrl || ""),
    defaultModel: "gpt-4o-mini",
    knownModels: ["gpt-4o-mini", "gpt-4o", "gpt-4.1-mini"],
    maxContextEstimate: 128_000,
    supportsVision: true,
    supportsTools: true,
    costTier: "paid",
    speedTier: "medium",
    strengths: ["reasoning", "coding", "chat"],
  },
];

function getProfile(provider: AIProviderConfig): ProviderProfile {
  return PROVIDER_PROFILES.find((profile) => profile.match(provider)) ?? {
    match: () => true,
    defaultModel: provider.models[0]?.id || "gpt-4o-mini",
    knownModels: provider.models.map((model) => model.id).filter(Boolean),
    maxContextEstimate: 64_000,
    supportsVision: false,
    supportsTools: false,
    costTier: "paid",
    speedTier: "medium",
    strengths: ["chat"],
  };
}

function providerNeedsKey(provider: AIProviderConfig): boolean {
  return !(/ollama/i.test(provider.name) || /localhost:11434/i.test(provider.baseUrl || ""));
}

export function buildProviderCapabilities(providers: AIProviderConfig[]): ProviderCapability[] {
  return providers.map((provider) => {
    const profile = getProfile(provider);
    const enabledModels = provider.models.filter((model) => model.enabled && model.id).map((model) => model.id);
    const availableModels = Array.from(new Set([...enabledModels, ...provider.models.map((model) => model.id), ...profile.knownModels].filter(Boolean)));

    return {
      providerId: provider.id,
      displayName: provider.name,
      defaultModel: enabledModels[0] || provider.models[0]?.id || profile.defaultModel,
      availableModels,
      maxContextEstimate: profile.maxContextEstimate,
      supportsStreaming: true,
      supportsVision: profile.supportsVision,
      supportsTools: profile.supportsTools,
      costTier: profile.costTier,
      speedTier: profile.speedTier,
      strengths: profile.strengths,
      enabled: enabledModels.length > 0,
      hasApiKey: !providerNeedsKey(provider) || Boolean(provider.apiKey),
      config: provider,
    };
  });
}
