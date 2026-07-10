/**
 * AutocompleteEngine — Main orchestrator for the inline completion lifecycle.
 *
 * Coordinates mode detection, debouncing, abort management, timeout enforcement,
 * caching, and result post-processing. Exports a single `registerAutocompleteProvider`
 * function that wires everything into Monaco's InlineCompletionsProvider API.
 */

import { invoke } from "@tauri-apps/api/core";
import * as monaco from "monaco-editor";
import { useSettingsStore } from "../../store/settingsStore";
import { loadAIProviders } from "../../utils/tauri";
import type { AIProviderConfig } from "../../utils/providers";
import { completionCache } from "./CompletionCache";
import { supportsFIM, formatPrompt } from "./FIMFormatter";
import { formatMessages } from "./ChatFallbackFormatter";
import { extractContext } from "./AutocompleteContext";
import { shouldSuppress } from "./shouldSuppress";
import { postProcess } from "./postProcess";
import type { CompletionResponse, AutocompleteSettings } from "./types";

type AutocompleteMode = "auto" | "fim" | "chat" | "disabled";

/** Frontend timeout — slightly longer than backend to let Rust handle the actual timeout */
const REQUEST_TIMEOUT_MS = 10_000;

class AutocompleteEngine {
  private abortController: AbortController | null = null;
  private requestCounter = 0;
  private lastLineCount = 0;

  async requestCompletion(
    model: monaco.editor.ITextModel,
    position: monaco.Position,
    token: monaco.CancellationToken
  ): Promise<monaco.languages.InlineCompletions> {
    const EMPTY: monaco.languages.InlineCompletions = { items: [] };

    // Read settings
    const config = useSettingsStore.getState().config;
    const settings: AutocompleteSettings = {
      autocompleteEnabled: config.autocompleteEnabled ?? config.ghostText ?? true,
      autocompleteMode: (config.autocompleteMode as AutocompleteMode) ?? "auto",
      autocompleteDebounceMs: config.autocompleteDebounceMs ?? 150,
      autocompleteMaxTokens: config.autocompleteMaxTokens ?? 128,
    };

    // Guard: disabled
    if (!settings.autocompleteEnabled || settings.autocompleteMode === "disabled") {
      return EMPTY;
    }

    // Abort previous in-flight request
    this.abortController?.abort();
    this.abortController = new AbortController();
    const signal = this.abortController.signal;
    const requestId = ++this.requestCounter;

    // Extract context
    const ctx = extractContext(model, position, this.lastLineCount);
    this.lastLineCount = model.getLineCount();

    // Suppression check
    if (shouldSuppress(ctx)) return EMPTY;

    // Debounce
    const debounceMs = Math.max(settings.autocompleteDebounceMs, 150);
    await new Promise((r) => setTimeout(r, debounceMs));
    if (signal.aborted || token.isCancellationRequested || this.requestCounter !== requestId) {
      return EMPTY;
    }

    // Cache check
    const cached = completionCache.get(ctx.cacheKey);
    if (cached) {
      return {
        items: [
          {
            insertText: cached,
            range: new monaco.Range(
              position.lineNumber,
              position.column,
              position.lineNumber,
              position.column
            ),
          },
        ],
      };
    }

    // Get active provider
    const activeProvider = await getActiveProvider();
    if (!activeProvider) return EMPTY;

    const apiKey = activeProvider.apiKey || "";
    const activeModel = activeProvider.models?.find((m) => m.enabled);
    const modelId = activeModel?.id || config.model || "";
    const baseUrl =
      activeProvider.baseUrl ||
      getBaseUrl(activeProvider.type || config.provider, config);

    const isLocalProvider = activeProvider.name?.toLowerCase().includes("ollama") || 
      config.provider === "ollama";
    if (!apiKey && !isLocalProvider) {
      return EMPTY;
    }
    if (!modelId) return EMPTY;

    // Resolve mode
    const mode = resolveMode(settings.autocompleteMode, modelId);

    // Call backend with timeout
    try {
      const result = await Promise.race([
        this.callProvider(ctx, mode, apiKey, baseUrl, modelId, settings.autocompleteMaxTokens),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("timeout")), REQUEST_TIMEOUT_MS)
        ),
      ]);

      if (signal.aborted || token.isCancellationRequested || this.requestCounter !== requestId) {
        return EMPTY;
      }

      if (!result || !result.success || !result.text) return EMPTY;

      const cleaned = postProcess(result.text, ctx.prefix);
      if (!cleaned) return EMPTY;

      completionCache.set(ctx.cacheKey, cleaned);
      return {
        items: [
          {
            insertText: cleaned,
            range: new monaco.Range(
              position.lineNumber,
              position.column,
              position.lineNumber,
              position.column
            ),
          },
        ],
      };
    } catch {
      return EMPTY;
    }
  }

  private async callProvider(
    ctx: { prefix: string; suffix: string; language: string },
    mode: "fim" | "chat",
    apiKey: string,
    baseUrl: string,
    modelId: string,
    maxTokens: number
  ): Promise<CompletionResponse> {
    if (mode === "fim") {
      const prompt = formatPrompt(ctx.prefix, ctx.suffix, modelId);
      if (!prompt) {
        return this.callChat(ctx, apiKey, baseUrl, modelId, maxTokens);
      }
      return invoke<CompletionResponse>("call_fim_completion", {
        request: {
          apiKey,
          baseUrl,
          model: modelId,
          prompt,
          maxTokens,
          stopTokens: getStopTokens(modelId),
        },
      });
    }
    return this.callChat(ctx, apiKey, baseUrl, modelId, maxTokens);
  }

  private async callChat(
    ctx: { prefix: string; suffix: string; language: string },
    apiKey: string,
    baseUrl: string,
    modelId: string,
    maxTokens: number
  ): Promise<CompletionResponse> {
    const messages = formatMessages(ctx.prefix, ctx.suffix, ctx.language);
    return invoke<CompletionResponse>("call_chat_completion_simple", {
      request: {
        apiKey,
        baseUrl,
        model: modelId,
        systemPrompt: messages[0].content,
        userPrompt: messages[1].content,
        maxTokens,
      },
    });
  }

  abort(): void {
    this.abortController?.abort();
    this.abortController = null;
  }

  dispose(): void {
    this.abort();
    completionCache.invalidate();
  }
}

// ─── Helper Functions ────────────────────────────────────────────────────────

/**
 * Resolves the effective completion mode based on user settings and model capabilities.
 */
export function resolveMode(settingMode: AutocompleteMode, modelId: string): "fim" | "chat" {
  if (settingMode === "fim") {
    return supportsFIM(modelId) ? "fim" : "chat";
  }
  if (settingMode === "chat") return "chat";
  return supportsFIM(modelId) ? "fim" : "chat";
}

/**
 * Returns the base URL for the given provider type.
 */
function getBaseUrl(providerType: string, config: { ollamaUrl?: string }): string {
  switch (providerType) {
    case "ollama":
      return config.ollamaUrl || "http://localhost:11434";
    case "groq":
      return "https://api.groq.com/openai/v1";
    case "openrouter":
      return "https://openrouter.ai/api/v1";
    case "mistral":
      return "https://api.mistral.ai/v1";
    case "openai":
      return "https://api.openai.com/v1";
    case "gemini":
      return "https://generativelanguage.googleapis.com/v1beta/openai";
    case "anthropic":
      return "https://api.anthropic.com/v1";
    default:
      return "https://api.openai.com/v1";
  }
}

// ─── Provider Loading ────────────────────────────────────────────────────────

let cachedProviders: AIProviderConfig[] | null = null;
let cachedProvidersAt = 0;
const PROVIDER_CACHE_TTL = 10_000;

/**
 * Loads providers from tauri-plugin-store with 10s cache.
 * Returns the first provider with an API key (or Ollama).
 */
async function getActiveProvider(): Promise<AIProviderConfig | null> {
  const now = Date.now();
  if (!cachedProviders || now - cachedProvidersAt > PROVIDER_CACHE_TTL) {
    try {
      cachedProviders = await loadAIProviders();
      cachedProvidersAt = now;
    } catch {
      cachedProviders = null;
      return null;
    }
  }
  if (!cachedProviders || cachedProviders.length === 0) return null;

  return (
    cachedProviders.find(
      (p) => p.apiKey || p.name?.toLowerCase().includes("ollama")
    ) || cachedProviders[0]
  );
}

/**
 * Returns model-specific stop tokens for FIM completion.
 */
function getStopTokens(modelId: string): string[] {
  const base = ["\n\n", "```"];
  const lower = modelId.toLowerCase();
  if (lower.includes("deepseek"))
    return [...base, "<｜fim▁begin｜>", "<｜fim▁hole｜>", "<｜fim▁end｜>"];
  if (lower.includes("starcoder") || lower.includes("qwen"))
    return [...base, "<|endoftext|>", "<fim_prefix>", "<fim_suffix>"];
  if (lower.includes("codestral"))
    return [...base, "[PREFIX]", "[SUFFIX]", "[MIDDLE]"];
  return [...base, "<|endoftext|>", "</s>"];
}

// ─── Singleton & Public API ──────────────────────────────────────────────────

const engine = new AutocompleteEngine();

/**
 * Registers the inline completions provider with Monaco for all languages.
 * Returns an IDisposable that cleans up the provider and engine on dispose.
 */
export function registerAutocompleteProvider(
  editor: monaco.editor.IStandaloneCodeEditor
): monaco.IDisposable {
  void editor;

  const providerDisposable = monaco.languages.registerInlineCompletionsProvider("*", {
    provideInlineCompletions: async (model, position, _context, token) => {
      return engine.requestCompletion(model, position, token);
    },
    freeInlineCompletions: () => {},
    disposeInlineCompletions: () => {},
  } as monaco.languages.InlineCompletionsProvider & { disposeInlineCompletions?: () => void });

  return {
    dispose: () => {
      providerDisposable.dispose();
      engine.dispose();
    },
  };
}
