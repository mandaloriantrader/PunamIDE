/**
 * AI Store — Chat messages, streaming, notepads, usage tracking, approval queue.
 * Ported from Zenith IDE for Punam IDE.
 */

import { create } from "zustand";
import type { RepoMap } from "../utils/systemPrompt";
import type { BudgetStatus } from "../services/agent/TokenBudgetManager";

export interface DiffHunk {
  id: number;
  filePath: string;
  startLine: number;
  endLine: number;
  oldContent: string;
  newContent: string;
}

export interface ApprovalQueueItem {
  patchId: string;
  diff: string;
  filesAffected: string[];
  agentReasoning: string;
  status: "pending" | "approved" | "rejected" | "timed_out";
  createdAt: number;
  hunks: DiffHunk[];
}

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

  repoMapCache: RepoMap | null;
  repoMapLastUpdated: number;
  repoMapIsStale: boolean;

  approvalQueue: ApprovalQueueItem[];
  pendingApprovalCount: number;

  tokenBudgetStatus: BudgetStatus | null;

  astIndexStatus: "idle" | "indexing" | "ready" | "error";
  astIndexedAt: number | null;

  setTokenBudgetStatus: (status: BudgetStatus | null) => void;

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

  setRepoMapCache: (map: RepoMap) => void;
  invalidateRepoMap: () => void;

  addApprovalRequest: (item: ApprovalQueueItem) => void;
  updateApprovalStatus: (patchId: string, status: ApprovalQueueItem["status"]) => void;
  clearApprovalQueue: () => void;

  setASTIndexStatus: (status: "idle" | "indexing" | "ready" | "error") => void;
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

  repoMapCache: null,
  repoMapLastUpdated: 0,
  repoMapIsStale: true,

  approvalQueue: [],
  pendingApprovalCount: 0,

  tokenBudgetStatus: null,

  astIndexStatus: "idle",
  astIndexedAt: null,

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

  setRepoMapCache: (map) => set({ repoMapCache: map, repoMapLastUpdated: Date.now(), repoMapIsStale: false }),
  invalidateRepoMap: () => set({ repoMapIsStale: true }),

  addApprovalRequest: (item) => set((state) => ({
    approvalQueue: [...state.approvalQueue, item],
    pendingApprovalCount: state.pendingApprovalCount + 1,
  })),
  updateApprovalStatus: (patchId, status) => set((state) => ({
    approvalQueue: state.approvalQueue.map((q) =>
      q.patchId === patchId ? { ...q, status } : q
    ),
    pendingApprovalCount: Math.max(0, state.pendingApprovalCount - 1),
  })),
  clearApprovalQueue: () => set({ approvalQueue: [], pendingApprovalCount: 0 }),

  setTokenBudgetStatus: (status) => set({ tokenBudgetStatus: status }),

  setASTIndexStatus: (status) => set({
    astIndexStatus: status,
    ...(status === "ready" ? { astIndexedAt: Date.now() } : {}),
  }),
}));
