/**
 * @phase P6
 * @purpose Abstraction for the 8-provider LLM system. The Review Agent
 *          uses this interface — it reuses existing infrastructure,
 *          doesn't build a new routing system.
 *
 * Supported providers: OpenAI, Anthropic, Google, Ollama (local),
 * Azure, AWS, Mistral, Local.
 */

/** Request to an LLM provider. */
export interface LLMRequest {
  model: string;
  systemPrompt: string;
  userPrompt: string;
  temperature: number;
  maxTokens: number;
}

/** Response from an LLM provider. */
export interface LLMResponse {
  content: string;
  usage: {
    promptTokens: number;
    completionTokens: number;
  };
  latencyMs: number;
}

/** Supported provider types. */
export const ProviderType = {
  OpenAI: 'openai',
  Anthropic: 'anthropic',
  Google: 'google',
  Ollama: 'ollama',
  Azure: 'azure',
  AWS: 'aws',
  Mistral: 'mistral',
  Local: 'local',
} as const;
export type ProviderType = (typeof ProviderType)[keyof typeof ProviderType];

/** A single LLM provider. */
export interface LLMProvider {
  id: string;
  name: string;
  type: ProviderType;
  complete(request: LLMRequest): Promise<LLMResponse>;
}

/**
 * Registry that manages multiple LLM providers and routes by config.
 * This is the interface the Review Agent uses.
 */
export class ProviderRegistry {
  private providers = new Map<string, LLMProvider>();

  /** Registers a provider. */
  register(provider: LLMProvider): void {
    this.providers.set(provider.id, provider);
  }

  /** Unregisters a provider by ID. */
  unregister(id: string): void {
    this.providers.delete(id);
  }

  /** Gets a provider by ID. */
  getProvider(id: string): LLMProvider | undefined {
    return this.providers.get(id);
  }

  /** Gets all registered providers. */
  getAllProviders(): LLMProvider[] {
    return Array.from(this.providers.values());
  }

  /** Gets providers by type. */
  getProvidersByType(type: ProviderType): LLMProvider[] {
    return this.getAllProviders().filter(p => p.type === type);
  }

  /**
   * Completes a request using the specified provider.
   * @throws Error if provider not found
   */
  async complete(providerId: string, request: LLMRequest): Promise<LLMResponse> {
    const provider = this.providers.get(providerId);
    if (!provider) {
      throw new Error(`LLM provider "${providerId}" not registered`);
    }
    return provider.complete(request);
  }
}

// ── Singleton pattern (follows existing codebase convention) ───────
let instance: ProviderRegistry | null = null;

/**
 * Gets the singleton ProviderRegistry instance.
 * Every service uses this pattern: `let instance: T | null = null`
 * with an exported `getXxx(): T` getter.
 */
export function getProviderRegistry(): ProviderRegistry {
  if (!instance) instance = new ProviderRegistry();
  return instance;
}
