/**
 * MemoryManager.ts
 *
 * Frontend TypeScript wrapper for the Long-Term Project Memory System (Phase 2).
 *
 * Coordinates Rust backend commands (memory_init, memory_create, memory_search, etc.)
 * and provides a clean API for React components and AI context injection.
 */

import { invoke } from "@tauri-apps/api/core";

// ── TypeScript Types (mirrors Rust structs) ────────────────────────────────────

export interface MemoryEntry {
  id: string;
  memory_type: "architectural_decision" | "bug_resolution" | "refactor" | "convention";
  title: string;
  description: string;
  tags: string[];
  files_involved: string[];
  severity: "low" | "medium" | "high" | "critical";
  created_at: number; // unix timestamp ms
  updated_at: number;
}

export interface MemoryInput {
  memory_type: string;
  title: string;
  description: string;
  tags: string[];
  files_involved: string[];
  severity: string;
}

export interface MemorySearchResult {
  entries: MemoryEntry[];
  total_count: number;
  query_time_ms: number;
}

// ── Rust Command Invocations ───────────────────────────────────────────────────

export async function memoryInit(): Promise<void> {
  return invoke("memory_init");
}

export async function memoryCreate(input: MemoryInput): Promise<MemoryEntry> {
  return invoke("memory_create", { input });
}

export async function memoryGetById(id: string): Promise<MemoryEntry> {
  return invoke("memory_get_by_id", { id });
}

export async function memoryList(
  memoryType?: string,
  limit = 20,
  offset = 0,
): Promise<MemorySearchResult> {
  return invoke("memory_list", { memoryType, limit, offset });
}

export async function memorySearch(
  query: string,
  memoryType?: string,
  limit = 20,
): Promise<MemorySearchResult> {
  return invoke("memory_search", { query, memoryType, limit });
}

export async function memoryUpdate(
  id: string,
  input: MemoryInput,
): Promise<MemoryEntry> {
  return invoke("memory_update", { id, input });
}

export async function memoryDelete(id: string): Promise<void> {
  return invoke("memory_delete", { id });
}

export async function memoryGetByFile(filePath: string): Promise<MemoryEntry[]> {
  return invoke("memory_get_by_file", { filePath });
}

export async function memoryGetTimeline(limit = 30): Promise<MemoryEntry[]> {
  return invoke("memory_get_timeline", { limit });
}

export async function memoryQuickAdd(
  memoryType: string,
  title: string,
  description: string,
): Promise<MemoryEntry> {
  return invoke("memory_quick_add", { memoryType, title, description });
}

// ── Convenience Helpers ────────────────────────────────────────────────────────

const TYPE_LABELS: Record<string, string> = {
  architectural_decision: "Arch. Decision",
  bug_resolution: "Bug Fix",
  refactor: "Refactor",
  convention: "Convention",
};

const SEVERITY_COLORS: Record<string, string> = {
  low: "#6b7280",
  medium: "#f59e0b",
  high: "#ef4444",
  critical: "#dc2626",
};

export function getMemoryTypeLabel(type: string): string {
  return TYPE_LABELS[type] || type;
}

export function getSeverityColor(severity: string): string {
  return SEVERITY_COLORS[severity] || "#6b7280";
}

export function formatMemoryDate(timestamp: number): string {
  return new Date(timestamp).toLocaleDateString("en-IN", {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/**
 * Build a context string to inject into AI system prompts.
 * Summarizes recent architectural decisions, bugs, and conventions
 * that the AI should be aware of when making code changes.
 */
export async function buildMemoryContext(
  activeFilePath?: string | null,
): Promise<string> {
  const sections: string[] = [];

  // 1. Recent architectural decisions (last 5)
  const decisions = await memoryList("architectural_decision", 5, 0);
  if (decisions.entries.length > 0) {
    sections.push("## Recent Architectural Decisions");
    for (const d of decisions.entries) {
      sections.push(`- **${d.title}**: ${d.description} (${formatMemoryDate(d.created_at)})`);
    }
  }

  // 2. Recent bug fixes (last 5)
  const bugs = await memoryList("bug_resolution", 5, 0);
  if (bugs.entries.length > 0) {
    sections.push("## Recent Bug Fixes");
    for (const b of bugs.entries) {
      sections.push(`- **${b.title}** (${b.severity}): ${b.description}`);
    }
  }

  // 3. File-specific memories (if a file is open)
  if (activeFilePath) {
    const fileMemories = await memoryGetByFile(activeFilePath);
    if (fileMemories.length > 0) {
      sections.push("## Memories Related to Current File");
      for (const m of fileMemories.slice(0, 5)) {
        sections.push(`- [${getMemoryTypeLabel(m.memory_type)}] **${m.title}**: ${m.description}`);
      }
    }
  }

  // 4. Recent conventions (last 3)
  const conventions = await memoryList("convention", 3, 0);
  if (conventions.entries.length > 0) {
    sections.push("## Project Conventions");
    for (const c of conventions.entries) {
      sections.push(`- **${c.title}**: ${c.description}`);
    }
  }

  return sections.length > 0
    ? "\n## Project Memory\n" + sections.join("\n\n")
    : "";
}