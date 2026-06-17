/**
 * AI Store — Chat messages, streaming, notepads, usage tracking.
 * Ported from Zenith IDE for Punam IDE.
 */

import { create } from "zustand";

export interface TokenUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  estimated_cost?: number;
}

export interface ChatMessage {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  timestamp: number;
  images?: string[];
  usage?: TokenUsage;
  streaming?: boolean;
}

export interface MentionContext {
  type: "@file" | "@folder" | "@codebase" | "@web" | "@docs" | "@git" | "@terminal" | "@selection" | "@problems";
  value: string;
  resolvedContent?: string;
}

export interface UsageRecord {
  id: string;
  provider: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  estimatedCost: number;
  timestamp: number;
  type: "chat" | "ghost_text" | "inline_edit" | "agent";
}

export interface UsageSummary {
  totalTokens: number;
  totalCost: number;
  byProvider: Record<string, { tokens: number; cost: number }>;
  byDay: Record<string, { tokens: number; cost: number }>;
}

export interface Notepad {
  id: string;
  title: string;
  content: string;
  createdAt: number;
  updatedAt: number;
  pinned: boolean;
}

function calcUsageSummary(records: UsageRecord[]): UsageSummary {
  const summary: UsageSummary = { totalTokens: 0, totalCost: 0, byProvider: {}, byDay: {} };
  for (const r of records) {
    summary.totalTokens += r.totalTokens;
    summary.totalCost += r.estimatedCost;
    if (!summary.byProvider[r.provider]) summary.byProvider[r.provider] = { tokens: 0, cost: 0 };
    summary.byProvider[r.provider].tokens += r.totalTokens;
    summary.byProvider[r.provider].cost += r.estimatedCost;
    const day = new Date(r.timestamp).toISOString().split("T")[0];
    if (!summary.byDay[day]) summary.byDay[day] = { tokens: 0, cost: 0 };
    summary.byDay[day].tokens += r.totalTokens;
    summary.byDay[day].cost += r.estimatedCost;
  }
  return summary;
}

interface AIState {
  messages: ChatMessage[];
  isStreaming: boolean;
  streamingContent: string;
  currentMentions: MentionContext[];

  notepads: Notepad[];
  activeNotepadId: string;

  usageRecords: UsageRecord[];
  usageSummary: UsageSummary;

  promptHistory: string[];
  customInstructions: string;

  addMessage: (message: ChatMessage) => void;
  updateMessage: (id: string, update: Partial<ChatMessage>) => void;
  clearMessages: () => void;
  setStreaming: (streaming: boolean) => void;
  setStreamingContent: (content: string) => void;
  appendStreamingContent: (chunk: string) => void;

  setCurrentMentions: (mentions: MentionContext[]) => void;
  addMention: (mention: MentionContext) => void;

  addNotepad: (notepad: Notepad) => void;
  updateNotepad: (id: string, update: Partial<Notepad>) => void;
  deleteNotepad: (id: string) => void;
  setActiveNotepadId: (id: string) => void;

  addUsageRecord: (record: UsageRecord) => void;
  recalcUsageSummary: () => void;

  addToPromptHistory: (prompt: string) => void;
  setCustomInstructions: (instructions: string) => void;
}

export const useAIStore = create<AIState>((set) => ({
  messages: [],
  isStreaming: false,
  streamingContent: "",
  currentMentions: [],

  notepads: [],
  activeNotepadId: "",

  usageRecords: [],
  usageSummary: { totalTokens: 0, totalCost: 0, byProvider: {}, byDay: {} },

  promptHistory: [],
  customInstructions: "",

  addMessage: (message) => set((state) => ({ messages: [...state.messages, message] })),
  updateMessage: (id, update) => set((state) => ({
    messages: state.messages.map((m) => (m.id === id ? { ...m, ...update } : m)),
  })),
  clearMessages: () => set({ messages: [] }),
  setStreaming: (streaming) => set({ isStreaming: streaming }),
  setStreamingContent: (content) => set({ streamingContent: content }),
  appendStreamingContent: (chunk) => set((state) => ({ streamingContent: state.streamingContent + chunk })),

  setCurrentMentions: (mentions) => set({ currentMentions: mentions }),
  addMention: (mention) => set((state) => ({ currentMentions: [...state.currentMentions, mention] })),

  addNotepad: (notepad) => set((state) => ({ notepads: [...state.notepads, notepad] })),
  updateNotepad: (id, update) => set((state) => ({
    notepads: state.notepads.map((n) => (n.id === id ? { ...n, ...update } : n)),
  })),
  deleteNotepad: (id) => set((state) => ({ notepads: state.notepads.filter((n) => n.id !== id) })),
  setActiveNotepadId: (id) => set({ activeNotepadId: id }),

  addUsageRecord: (record) => {
    set((state) => {
      const records = [...state.usageRecords, record];
      return { usageRecords: records, usageSummary: calcUsageSummary(records) };
    });
  },
  recalcUsageSummary: () => set((state) => ({ usageSummary: calcUsageSummary(state.usageRecords) })),

  addToPromptHistory: (prompt) => set((state) => ({
    promptHistory: [prompt, ...state.promptHistory.filter((p) => p !== prompt)].slice(0, 100),
  })),
  setCustomInstructions: (instructions) => set({ customInstructions: instructions }),
}));
