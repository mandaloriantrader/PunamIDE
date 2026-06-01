/**
 * MemoryIndexer.ts — Phase 2 Memory Subsystem
 *
 * Indexes memories by category, project, date, and tags.
 * Wraps the Rust memory_engine.rs FTS5 full-text search.
 * Provides classification, deduplication, and auto-tagging.
 */

import { invoke } from "@tauri-apps/api/core";
import type { MemoryEntry, MemorySearchResult } from "./MemoryManager";
import { memorySearch, memoryList } from "./MemoryManager";

// ── Index Types ────────────────────────────────────────────────────────────────

export interface CategoryIndex {
  category: string; // architectural_decision | bug_resolution | refactor | convention
  count: number;
  entries: string[]; // memory IDs
  lastUpdated: number;
}

export interface ProjectTimeline {
  entries: Array<{
    id: string;
    title: string;
    memory_type: string;
    created_at: number;
    severity: string;
  }>;
  total: number;
}

export interface TagCloud {
  tag: string;
  count: number;
  associatedCategories: string[];
}

// ── MemoryIndexer Class ────────────────────────────────────────────────────────

export class MemoryIndexer {
  private categoryCache: Map<string, CategoryIndex> = new Map();
  private cacheTimestamp: number = 0;
  private readonly CACHE_TTL = 30_000; // 30 seconds

  /**
   * Index all memories by category.
   * Returns category breakdown with counts and entry IDs.
   */
  async indexByCategory(): Promise<CategoryIndex[]> {
    // Use cache if fresh
    if (Date.now() - this.cacheTimestamp < this.CACHE_TTL && this.categoryCache.size > 0) {
      return Array.from(this.categoryCache.values());
    }

    const categories: Record<string, CategoryIndex> = {};

    // Fetch all memory types in parallel
    const types: Array<"architectural_decision" | "bug_resolution" | "refactor" | "convention"> = [
      "architectural_decision",
      "bug_resolution",
      "refactor",
      "convention",
    ];

    for (const memType of types) {
      try {
        const result = await memoryList(memType, 500, 0);
        categories[memType] = {
          category: memType,
          count: result.total_count,
          entries: result.entries.map((e) => e.id),
          lastUpdated: Date.now(),
        };
      } catch {
        categories[memType] = {
          category: memType,
          count: 0,
          entries: [],
          lastUpdated: Date.now(),
        };
      }
    }

    // Update cache
    this.categoryCache = new Map(Object.entries(categories));
    this.cacheTimestamp = Date.now();

    return Object.values(categories);
  }

  /**
   * Build project timeline — all memories sorted by creation date (newest first).
   */
  async buildTimeline(limit = 50): Promise<ProjectTimeline> {
    try {
      const result = await memoryList(undefined, limit, 0);

      return {
        entries: result.entries
          .sort((a, b) => b.created_at - a.created_at)
          .map((e) => ({
            id: e.id,
            title: e.title,
            memory_type: e.memory_type,
            created_at: e.created_at,
            severity: e.severity,
          })),
        total: result.total_count,
      };
    } catch {
      return { entries: [], total: 0 };
    }
  }

  /**
   * Full-text search across all memory types.
   * Delegates to Rust FTS5 engine.
   */
  async search(query: string, limit = 20): Promise<MemorySearchResult> {
    return memorySearch(query, undefined, limit);
  }

  /**
   * Build a tag cloud from all memories.
   * Tags with higher frequency appear larger in the cloud.
   */
  async buildTagCloud(): Promise<TagCloud[]> {
    try {
      const allTypes: Array<"architectural_decision" | "bug_resolution" | "refactor" | "convention"> = [
        "architectural_decision",
        "bug_resolution",
        "refactor",
        "convention",
      ];

      const tagMap = new Map<string, { count: number; categories: Set<string> }>();

      for (const memType of allTypes) {
        const result = await memoryList(memType, 500, 0);
        for (const entry of result.entries) {
          for (const tag of entry.tags) {
            const existing = tagMap.get(tag) || { count: 0, categories: new Set<string>() };
            existing.count++;
            existing.categories.add(entry.memory_type);
            tagMap.set(tag, existing);
          }
        }
      }

      return Array.from(tagMap.entries())
        .map(([tag, data]) => ({
          tag,
          count: data.count,
          associatedCategories: Array.from(data.categories),
        }))
        .sort((a, b) => b.count - a.count);
    } catch {
      return [];
    }
  }

  /**
   * Suggest auto-tags for a given memory title and description.
   * Uses keyword matching against existing tag cloud.
   */
  async suggestTags(title: string, description: string): Promise<string[]> {
    const text = `${title} ${description}`.toLowerCase();
    const tagCloud = await this.buildTagCloud();

    return tagCloud
      .filter((t) => text.includes(t.tag.toLowerCase()))
      .slice(0, 5)
      .map((t) => t.tag);
  }

  /**
   * Detect duplicate memories (same title, similar description).
   * Returns list of potential duplicate IDs.
   */
  async detectDuplicates(title: string): Promise<string[]> {
    try {
      const result = await memorySearch(title, undefined, 5);
      return result.entries
        .filter((e) => e.title.toLowerCase() === title.toLowerCase())
        .map((e) => e.id);
    } catch {
      return [];
    }
  }

  /**
   * Invalidate the category cache (call after creating/deleting memories).
   */
  invalidateCache(): void {
    this.categoryCache.clear();
    this.cacheTimestamp = 0;
  }
}

// ── Singleton ──────────────────────────────────────────────────────────────────

let instance: MemoryIndexer | null = null;

export function getMemoryIndexer(): MemoryIndexer {
  if (!instance) {
    instance = new MemoryIndexer();
  }
  return instance;
}