/**
 * Local codebase search using TF-IDF scoring.
 * Phase 4A: No external dependencies, works offline.
 * Chunks source files and builds an inverted index for semantic-ish search.
 */

import { readFile } from "./tauri";
import type { FileEntry } from "./tauri";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface CodeChunk {
  path: string;
  startLine: number;
  endLine: number;
  content: string;
  tokens: string[];
}

export interface SearchHit {
  path: string;
  startLine: number;
  endLine: number;
  snippet: string;
  score: number;
}

interface IndexEntry {
  chunkIdx: number;
  tf: number; // term frequency in this chunk
}

// ── Constants ─────────────────────────────────────────────────────────────────

const CHUNK_SIZE_LINES = 30;
const CHUNK_OVERLAP_LINES = 5;
const MAX_FILE_LINES = 2000;
const IGNORED_DIRS = new Set([
  "node_modules", "target", "dist", "build", ".git", ".next",
  ".tauri", "__pycache__", ".venv", "venv", ".cache", "coverage",
]);
const IGNORED_EXTENSIONS = new Set([
  "png", "jpg", "jpeg", "gif", "webp", "ico", "svg", "bmp",
  "woff", "woff2", "ttf", "eot", "otf",
  "mp3", "mp4", "wav", "avi", "mov",
  "zip", "tar", "gz", "rar", "7z",
  "pdf", "doc", "docx", "xls", "xlsx",
  "lock", "map",
]);
const STOP_WORDS = new Set([
  "the", "is", "at", "which", "on", "a", "an", "and", "or", "not",
  "in", "to", "for", "of", "with", "as", "by", "from", "this", "that",
  "it", "be", "are", "was", "were", "been", "being", "have", "has",
  "had", "do", "does", "did", "will", "would", "could", "should",
  "may", "might", "shall", "can", "if", "else", "then", "than",
  "import", "export", "from", "const", "let", "var", "function",
  "return", "class", "new", "true", "false", "null", "undefined",
]);

// ── Index State ───────────────────────────────────────────────────────────────

let chunks: CodeChunk[] = [];
let invertedIndex: Map<string, IndexEntry[]> = new Map();
let docCount = 0;
let indexed = false;

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Yield control back to the main thread.
 * Uses requestIdleCallback when available, falls back to setTimeout(0).
 * This prevents the UI from freezing during long indexing loops.
 */
function yieldToMain(): Promise<void> {
  return new Promise((resolve) => {
    if (typeof requestIdleCallback === "function") {
      requestIdleCallback(() => resolve());
    } else {
      setTimeout(resolve, 0);
    }
  });
}

/** How many files to process before yielding to the main thread. */
const INDEX_BATCH_SIZE = 8;

/**
 * Index the entire project. Call once on project open.
 * Subsequent calls re-index from scratch.
 *
 * Processes files in small batches with main-thread yields between them
 * so the UI stays responsive during indexing.
 */
export async function indexProject(
  projectPath: string,
  files: FileEntry[]
): Promise<{ chunksCount: number; filesIndexed: number }> {
  chunks = [];
  invertedIndex = new Map();
  docCount = 0;

  const filePaths = flattenFiles(files);
  let filesIndexed = 0;
  let batchCount = 0;

  for (const relPath of filePaths) {
    if (shouldIgnore(relPath)) continue;

    try {
      const separator = projectPath.includes("\\") ? "\\" : "/";
      const fullPath = `${projectPath.replace(/[\\/]+$/, "")}${separator}${relPath}`;
      const content = await readFile(fullPath);
      if (!content || content.length > 100000) continue; // skip huge files

      const fileChunks = chunkFile(relPath, content);
      chunks.push(...fileChunks);
      filesIndexed++;
    } catch {
      // File read failed — skip silently
    }

    // Yield to main thread every INDEX_BATCH_SIZE files to prevent UI freeze
    batchCount++;
    if (batchCount >= INDEX_BATCH_SIZE) {
      batchCount = 0;
      await yieldToMain();
    }
  }

  // Build inverted index (also in batches)
  docCount = chunks.length;
  for (let i = 0; i < chunks.length; i++) {
    const tokenCounts = new Map<string, number>();
    for (const token of chunks[i].tokens) {
      tokenCounts.set(token, (tokenCounts.get(token) || 0) + 1);
    }
    for (const [token, count] of tokenCounts) {
      if (!invertedIndex.has(token)) invertedIndex.set(token, []);
      invertedIndex.get(token)!.push({ chunkIdx: i, tf: count / chunks[i].tokens.length });
    }

    // Yield every 50 chunks during index build phase
    if (i > 0 && i % 50 === 0) {
      await yieldToMain();
    }
  }

  indexed = true;
  return { chunksCount: chunks.length, filesIndexed };
}

/**
 * Search the indexed codebase using TF-IDF scoring.
 * Returns top-K matching chunks.
 */
export function searchCodebase(query: string, topK = 10): SearchHit[] {
  if (!indexed || chunks.length === 0) return [];

  const queryTokens = tokenize(query);
  if (queryTokens.length === 0) return [];

  // Score each chunk using TF-IDF
  const scores = new Map<number, number>();

  for (const token of queryTokens) {
    const entries = invertedIndex.get(token);
    if (!entries) continue;

    // IDF = log(N / df) where df = number of chunks containing this token
    const idf = Math.log((docCount + 1) / (entries.length + 1)) + 1;

    for (const entry of entries) {
      const tfidf = entry.tf * idf;
      scores.set(entry.chunkIdx, (scores.get(entry.chunkIdx) || 0) + tfidf);
    }
  }

  // Sort by score descending
  const sorted = [...scores.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, topK);

  return sorted.map(([idx, score]) => {
    const chunk = chunks[idx];
    return {
      path: chunk.path,
      startLine: chunk.startLine,
      endLine: chunk.endLine,
      snippet: chunk.content.slice(0, 200),
      score,
    };
  });
}

/**
 * Check if the index is built.
 */
export function isIndexed(): boolean {
  return indexed;
}

/**
 * Get index stats.
 */
export function getIndexStats(): { chunks: number; terms: number; indexed: boolean } {
  return { chunks: chunks.length, terms: invertedIndex.size, indexed };
}

// ── Internal Helpers ──────────────────────────────────────────────────────────

function flattenFiles(entries: FileEntry[], prefix = ""): string[] {
  const result: string[] = [];
  for (const entry of entries) {
    const p = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.is_dir) {
      if (!IGNORED_DIRS.has(entry.name.toLowerCase())) {
        if (entry.children) result.push(...flattenFiles(entry.children, p));
      }
    } else {
      result.push(p);
    }
  }
  return result;
}

function shouldIgnore(path: string): boolean {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  if (IGNORED_EXTENSIONS.has(ext)) return true;
  const parts = path.split("/");
  return parts.some(p => IGNORED_DIRS.has(p.toLowerCase()));
}

function chunkFile(path: string, content: string): CodeChunk[] {
  const lines = content.split("\n");
  if (lines.length > MAX_FILE_LINES) return []; // skip very large files

  const result: CodeChunk[] = [];
  for (let i = 0; i < lines.length; i += CHUNK_SIZE_LINES - CHUNK_OVERLAP_LINES) {
    const end = Math.min(i + CHUNK_SIZE_LINES, lines.length);
    const chunkContent = lines.slice(i, end).join("\n");
    result.push({
      path,
      startLine: i + 1,
      endLine: end,
      content: chunkContent,
      tokens: tokenize(chunkContent),
    });
    if (end >= lines.length) break;
  }
  return result;
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9_$]/g, " ")
    .split(/\s+/)
    .filter(t => t.length > 2 && t.length < 40 && !STOP_WORDS.has(t));
}
