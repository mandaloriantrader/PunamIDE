/**
 * DebtCache.ts — Phase 10, Step 10.10
 *
 * Incremental caching layer for DebtAnalyzer that avoids re-analyzing
 * unchanged files by storing per-file scores keyed on file modification time.
 *
 * When a file's mtime hasn't changed since the last analysis, the cached
 * score is reused. Only files with changed mtime or new files are re-analyzed.
 *
 * Storage: in-memory Map (volatile) with optional IndexedDB persistence.
 * Designed to work with the DebtAnalyzer Web Worker for non-blocking operation.
 */

import type { FileDebtScore } from "./DebtAnalyzer";

// ── Types ────────────────────────────────────────────────────────────────────

export interface CachedEntry {
  /** The full file path. */
  path: string;
  /** File modification timestamp (ms since epoch). */
  mtime: number;
  /** The cached debt score for this file. */
  score: FileDebtScore;
  /** When this entry was cached (ms since epoch). */
  cachedAt: number;
}

export interface CacheStats {
  totalEntries: number;
  hits: number;
  misses: number;
  invalidations: number;
  lastHitRatio: number;
}

export interface IncrementalDiff {
  /** Files that need re-analysis (new or modified). */
  changed: Map<string, string>;
  /** Files whose cached score can be reused. */
  unchanged: FileDebtScore[];
  /** Files that were in cache but no longer exist in the project. */
  removed: string[];
}

// ── TTL: invalidate entries after 1 hour (to allow for dependency changes) ──

const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

// ── DebtCache ────────────────────────────────────────────────────────────────

export class DebtCache {
  private cache = new Map<string, CachedEntry>();
  private stats: CacheStats = {
    totalEntries: 0,
    hits: 0,
    misses: 0,
    invalidations: 0,
    lastHitRatio: 0,
  };

  /**
   * Check if a file has a valid cached score.
   * Returns the cached entry if mtime matches and TTL hasn't expired, else null.
   */
  get(path: string, mtime: number): CachedEntry | null {
    const entry = this.cache.get(path);
    if (!entry) {
      this.stats.misses++;
      return null;
    }

    // Check TTL expiration
    const age = Date.now() - entry.cachedAt;
    if (age > CACHE_TTL_MS) {
      this.cache.delete(path);
      this.stats.invalidations++;
      this.stats.misses++;
      return null;
    }

    // Check mtime match
    if (entry.mtime !== mtime) {
      this.cache.delete(path);
      this.stats.invalidations++;
      this.stats.misses++;
      return null;
    }

    this.stats.hits++;
    return entry;
  }

  /**
   * Store a file's debt score in the cache.
   */
  set(path: string, mtime: number, score: FileDebtScore): void {
    const entry: CachedEntry = {
      path,
      mtime,
      score,
      cachedAt: Date.now(),
    };
    this.cache.set(path, entry);
    this.stats.totalEntries = this.cache.size;
  }

  /**
   * Remove a path from the cache (manual invalidation).
   */
  invalidate(path: string): void {
    if (this.cache.delete(path)) {
      this.stats.invalidations++;
    }
  }

  /**
   * Clear the entire cache.
   */
  clear(): void {
    this.stats.invalidations += this.cache.size;
    this.cache.clear();
    this.stats.totalEntries = 0;
  }

  /**
   * Compute an incremental diff: given current files (with mtimes),
   * determine which need re-analysis and which are unchanged.
   *
   * @param files Current file paths → content map
   * @param fileMtimes Current file paths → mtime (ms) map
   * @returns { changed, unchanged, removed }
   */
  computeDiff(
    files: Map<string, string>,
    fileMtimes: Map<string, number>,
  ): IncrementalDiff {
    const changed = new Map<string, string>();
    const unchanged: FileDebtScore[] = [];
    const currentPaths = new Set(files.keys());

    for (const [path, content] of files) {
      const mtime = fileMtimes.get(path);
      if (mtime === undefined) {
        // No mtime available → must re-analyze
        changed.set(path, content);
        continue;
      }

      const cached = this.get(path, mtime);
      if (cached) {
        unchanged.push(cached.score);
      } else {
        changed.set(path, content);
      }
    }

    // Find removed files (in cache but not in current project)
    const removed: string[] = [];
    for (const cachedPath of this.cache.keys()) {
      if (!currentPaths.has(cachedPath)) {
        removed.push(cachedPath);
      }
    }
    // Clean up removed entries
    for (const path of removed) {
      this.cache.delete(path);
    }

    // Update stats
    this.stats.hits = unchanged.length;
    this.stats.misses = changed.size;
    this.stats.totalEntries = this.cache.size;
    const total = unchanged.length + changed.size;
    this.stats.lastHitRatio = total > 0 ? unchanged.length / total : 0;

    return { changed, unchanged, removed };
  }

  /**
   * Get cache statistics.
   */
  getStats(): CacheStats {
    return { ...this.stats };
  }

  /**
   * Get the number of cached entries.
   */
  get size(): number {
    return this.cache.size;
  }
}