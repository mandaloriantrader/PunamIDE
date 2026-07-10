/**
 * CompletionCache — Map-based LRU cache with TTL for completion results.
 *
 * Uses JavaScript Map's insertion-order guarantee for LRU tracking.
 * - get() promotes entries to MRU via delete + re-insert
 * - set() evicts the first (oldest) entry when over capacity
 * - Entries expire after 30s TTL (lazy removal on access)
 */

import type { ICacheEntry } from "./types";

export class CompletionCache {
  private cache = new Map<string, ICacheEntry>();
  private readonly maxEntries: number;
  private readonly ttlMs: number;

  constructor(maxEntries = 60, ttlMs = 30_000) {
    this.maxEntries = maxEntries;
    this.ttlMs = ttlMs;
  }

  /**
   * Retrieve a cached completion.
   * Returns null if key is missing or entry has expired.
   * Promotes the entry to MRU position on successful access.
   */
  get(key: string): string | null {
    const entry = this.cache.get(key);
    if (!entry) return null;

    // TTL check — lazy expiry
    if (Date.now() - entry.timestamp > this.ttlMs) {
      this.cache.delete(key);
      return null;
    }

    // Promote to MRU: delete and re-insert at end
    this.cache.delete(key);
    this.cache.set(key, entry);
    return entry.completion;
  }

  /**
   * Store a completion in the cache.
   * If the key already exists, it's updated and promoted to MRU.
   * If capacity is exceeded, the LRU entry (first in Map) is evicted.
   */
  set(key: string, completion: string): void {
    // Remove existing to update insertion order
    this.cache.delete(key);
    this.cache.set(key, { completion, timestamp: Date.now() });

    // Evict LRU (first entry in Map) if over capacity
    if (this.cache.size > this.maxEntries) {
      const firstKey = this.cache.keys().next().value;
      if (firstKey !== undefined) {
        this.cache.delete(firstKey);
      }
    }
  }

  /** Clear all cached entries. */
  invalidate(): void {
    this.cache.clear();
  }

  /** Current number of entries in the cache. */
  get size(): number {
    return this.cache.size;
  }
}

/** Singleton cache instance for the autocomplete system */
export const completionCache = new CompletionCache();
