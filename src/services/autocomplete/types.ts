// Shared types for the autocomplete service module

export interface FIMTokenFormat {
  prefix: string;
  suffix: string;
  middle: string;
}

export interface ChatMessage {
  role: "system" | "user";
  content: string;
}

export interface ICacheEntry {
  completion: string;
  timestamp: number;
}

export interface CompletionContext {
  prefix: string;
  suffix: string;
  language: string;
  cacheKey: string;
  currentLine: string;
  beforeCursor: string;
  isAfterBlockOpen: boolean;
  triggeredByNewline: boolean;
}

export interface AutocompleteSettings {
  autocompleteEnabled: boolean;
  autocompleteMode: "auto" | "fim" | "chat" | "disabled";
  autocompleteDebounceMs: number;
  autocompleteMaxTokens: number;
}

export interface CompletionResponse {
  text: string;
  success: boolean;
  error?: string;
}
