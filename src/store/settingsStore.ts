/**
 * Settings Store — App config, keybindings, and preferences.
 * Ported from Zenith IDE for Punam IDE.
 */

import { create } from "zustand";
import type { ContextInjectorConfig } from "../services/intelligence/ContextInjector";
import { DEFAULT_CONTEXT_INJECTOR_CONFIG } from "../services/intelligence/ContextInjector";
import type { CompressionConfig } from "../services/intelligence/ContextCompressor";
import { DEFAULT_COMPRESSION_CONFIG } from "../services/intelligence/ContextCompressor";

export type AIProvider = "openai" | "anthropic" | "gemini" | "openrouter" | "ollama" | "groq" | "mistral";

export interface ReasoningDisplayConfig {
  /** Whether to show the reasoning panel (default: true) */
  enabled: boolean;
  /** Default display mode (default: "compact") */
  defaultMode: "compact" | "expanded";
}

export interface Keybinding {
  id: string;
  label: string;
  keys: string;
  command: string;
  category: string;
  when?: string;
}

export interface AppConfig {
  provider: AIProvider;
  api_key: string;
  model: string;
  theme: "dark" | "light" | "system";
  fontSize: number;
  fontFamily: string;
  tabSize: number;
  wordWrap: boolean;
  minimap: boolean;
  lineNumbers: boolean;
  autoSave: boolean;
  autoSaveDelay: number;
  ghostText: boolean;
  providerKeys: Record<string, string>;
  recentProjects: string[];
  customKeybindings: Record<string, string>;
  projectRules: string;
  ollamaUrl: string;
  openrouterKey: string;
  contextInjectorConfig: ContextInjectorConfig;
  compressionConfig: CompressionConfig;
  agentAssistedDebugging: boolean;
  reasoningDisplay: ReasoningDisplayConfig;
  /** Agent autopilot mode: when ON, auto-approves reads, writes, and safe commands.
   *  Only dangerous commands still require approval. When OFF (supervised), every
   *  write and command requires per-action approval. */
  agentAutopilot: boolean;
  /** Master switch for inline autocomplete (supersedes ghostText) */
  autocompleteEnabled: boolean;
  /** Completion mode: auto detects FIM capability, or force a specific mode */
  autocompleteMode: "auto" | "fim" | "chat" | "disabled";
  /** Debounce delay in ms before triggering completion (min 150) */
  autocompleteDebounceMs: number;
  /** Max tokens for completion response (range 16–512) */
  autocompleteMaxTokens: number;
}

export const DEFAULT_KEYBINDINGS: Keybinding[] = [
  { id: "save", label: "Save File", keys: "Ctrl+S", command: "file.save", category: "File" },
  { id: "saveAll", label: "Save All", keys: "Ctrl+Shift+S", command: "file.saveAll", category: "File" },
  { id: "openFile", label: "Quick Open", keys: "Ctrl+P", command: "file.quickOpen", category: "File" },
  { id: "newFile", label: "New File", keys: "Ctrl+N", command: "file.new", category: "File" },
  { id: "closeTab", label: "Close Tab", keys: "Ctrl+W", command: "tab.close", category: "Editor" },
  { id: "commandPalette", label: "Command Palette", keys: "Ctrl+Shift+P", command: "palette.open", category: "General" },
  { id: "toggleSidebar", label: "Toggle Sidebar", keys: "Ctrl+B", command: "sidebar.toggle", category: "View" },
  { id: "toggleTerminal", label: "Toggle Terminal", keys: "Ctrl+`", command: "terminal.toggle", category: "View" },
  { id: "toggleAiPanel", label: "Toggle AI Panel", keys: "Ctrl+Shift+A", command: "ai.toggle", category: "View" },
  { id: "inlineEdit", label: "Inline Edit (AI)", keys: "Ctrl+K", command: "ai.inlineEdit", category: "AI" },
  { id: "search", label: "Search in Project", keys: "Ctrl+Shift+F", command: "search.open", category: "Search" },
  { id: "findInFile", label: "Find in File", keys: "Ctrl+F", command: "editor.find", category: "Editor" },
  { id: "replaceInFile", label: "Replace in File", keys: "Ctrl+H", command: "editor.replace", category: "Editor" },
  { id: "goToLine", label: "Go to Line", keys: "Ctrl+G", command: "editor.goToLine", category: "Editor" },
  { id: "toggleSplit", label: "Toggle Split Editor", keys: "Ctrl+\\", command: "editor.split", category: "Editor" },
  { id: "focusChat", label: "Focus Chat", keys: "Ctrl+L", command: "ai.focusChat", category: "AI" },
  { id: "gitPanel", label: "Toggle Git Panel", keys: "Ctrl+Shift+G", command: "git.toggle", category: "Git" },
  { id: "problems", label: "Toggle Problems", keys: "Ctrl+Shift+M", command: "problems.toggle", category: "View" },
  { id: "settings", label: "Open Settings", keys: "Ctrl+,", command: "settings.open", category: "General" },
  { id: "generateDocs", label: "Generate Documentation", keys: "Ctrl+Shift+D", command: "docs.generate", category: "AI" },
];

const DEFAULT_CONFIG: AppConfig = {
  provider: "gemini",
  api_key: "",
  model: "gemini-2.0-flash",
  theme: "dark",
  fontSize: 14,
  fontFamily: "'Fira Code', 'Cascadia Code', 'JetBrains Mono', 'Consolas', monospace",
  tabSize: 2,
  wordWrap: true,
  minimap: true,
  lineNumbers: true,
  autoSave: false,
  autoSaveDelay: 1000,
  ghostText: true,
  providerKeys: {},
  recentProjects: [],
  customKeybindings: {},
  projectRules: "",
  ollamaUrl: "http://localhost:11434",
  openrouterKey: "",
  contextInjectorConfig: DEFAULT_CONTEXT_INJECTOR_CONFIG,
  compressionConfig: DEFAULT_COMPRESSION_CONFIG,
  agentAssistedDebugging: true,
  reasoningDisplay: { enabled: true, defaultMode: "compact" },
  agentAutopilot: true,
  autocompleteEnabled: true,
  autocompleteMode: "auto",
  autocompleteDebounceMs: 150,
  autocompleteMaxTokens: 128,
};

interface SettingsState {
  config: AppConfig;
  keybindings: Keybinding[];

  setConfig: (config: AppConfig) => void;
  updateConfig: (partial: Partial<AppConfig>) => void;

  updateKeybinding: (id: string, keys: string) => void;
  resetKeybindings: () => void;
  getKeybinding: (command: string) => Keybinding | undefined;
}

export const useSettingsStore = create<SettingsState>((set, get) => ({
  config: DEFAULT_CONFIG,
  keybindings: DEFAULT_KEYBINDINGS,

  setConfig: (config) => set({ config }),
  updateConfig: (partial) => set((state) => ({ config: { ...state.config, ...partial } })),

  updateKeybinding: (id, keys) => {
    set((state) => ({
      keybindings: state.keybindings.map((kb) => (kb.id === id ? { ...kb, keys } : kb)),
    }));
  },

  resetKeybindings: () => set({ keybindings: DEFAULT_KEYBINDINGS }),

  getKeybinding: (command) => {
    return get().keybindings.find((kb) => kb.command === command);
  },
}));
