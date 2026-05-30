/**
 * ArchitectureScanner.ts
 *
 * Listens to file system changes (via Tauri fs-changed events) and triggers
 * incremental dependency re-analysis. Runs a full project scan on startup.
 *
 * Integrates with ArchitectureEngine for the actual Rust command invocations
 * and with Zustand stores for state management.
 */

import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import {
  analyzeFileDependencies,
  invalidateCache as invalidateEngineCache,
} from "./ArchitectureEngine";
import type { DependencyAnalysisResult } from "./ArchitectureEngine";

// ── Types ──────────────────────────────────────────────────────────────────────

export interface ArchitectScannerState {
  /** Whether the scanner is currently active (listening for file changes). */
  isScanning: boolean;
  /** Count of files analyzed in the last scan. */
  lastFileCount: number;
  /** Timestamp of the last scan. */
  lastScanAt: number | null;
  /** Errors from the last scan. */
  errors: string[];
  /** Whether the initial full project scan has completed. */
  initialScanDone: boolean;
}

// ── Scanner Instance ───────────────────────────────────────────────────────────

let unlistenFn: UnlistenFn | null = null;
let debounceTimer: ReturnType<typeof setTimeout> | null = null;
const pendingFiles = new Set<string>();
const DEBOUNCE_MS = 1000; // 1 second debounce before re-scanning
const BATCH_MAX_WAIT_MS = 3000; // Maximum wait before forced flush

let batchTimer: ReturnType<typeof setTimeout> | null = null;
let batchStartTime = 0;

/** Callback invoked after each scan completes. */
type ScanCallback = (state: ArchitectScannerState) => void;
let onScanComplete: ScanCallback | null = null;

// ── Public API ─────────────────────────────────────────────────────────────────

/**
 * Start the architecture scanner.
 *
 * Begins listening for file system change events and runs an initial
 * full project dependency analysis.
 *
 * @param onResult - Optional callback invoked after each scan with the current state.
 * @returns A cleanup function to stop the scanner.
 */
export async function startArchitectureScanner(
  onResult?: ScanCallback,
): Promise<() => void> {
  if (unlistenFn) {
    // Already running — just update the callback
    onScanComplete = onResult ?? null;
    return stopArchitectureScanner;
  }

  onScanComplete = onResult ?? null;

  // Listen for Rust file watcher events (emitted as "fs-changed")
  unlistenFn = await listen<FsChangePayload>("fs-changed", (event) => {
    const { paths } = event.payload;

    // Filter to only source files we can analyze
    const analyzable = paths.filter(isAnalyzableFile);
    if (analyzable.length === 0) return;

    // Add to pending set
    for (const p of analyzable) {
      pendingFiles.add(p);
    }

    // Trigger debounced re-scan
    scheduleFlush();
  });

  // Run initial full scan
  await runInitialScan();

  return stopArchitectureScanner;
}

/**
 * Stop the architecture scanner and clean up listeners.
 */
export function stopArchitectureScanner(): void {
  if (unlistenFn) {
    unlistenFn();
    unlistenFn = null;
  }
  if (debounceTimer) {
    clearTimeout(debounceTimer);
    debounceTimer = null;
  }
  if (batchTimer) {
    clearTimeout(batchTimer);
    batchTimer = null;
  }
  pendingFiles.clear();
}

/**
 * Manually trigger a re-scan of specific files.
 */
export async function scanFiles(filePaths: string[]): Promise<void> {
  const analyzable = filePaths.filter(isAnalyzableFile);
  if (analyzable.length === 0) return;

  try {
    const result = await analyzeFileDependencies(analyzable);
    invalidateEngineCache();
    notifyState(result, []);
  } catch (err) {
    notifyState(null, [String(err)]);
  }
}

/**
 * Trigger an immediate full project re-scan.
 */
export async function fullRescan(): Promise<void> {
  invalidateEngineCache();
  await runInitialScan();
}

// ── Internal ───────────────────────────────────────────────────────────────────

interface FsChangePayload {
  paths: string[];
  kind: string;
}

/** File extensions that the dependency analyzer can parse. */
const ANALYZABLE_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".py",
  ".rs",
]);

/** Directories that should never trigger a re-scan. */
const IGNORED_DIR_PATTERNS = [
  "node_modules",
  ".git",
  "target",
  "dist",
  "build",
  "__pycache__",
  ".punam-backups",
];

function isAnalyzableFile(path: string): boolean {
  // Skip ignored directories
  const normalized = path.replace(/\\/g, "/");
  for (const pattern of IGNORED_DIR_PATTERNS) {
    if (normalized.includes(`/${pattern}/`) || normalized.includes(`\\${pattern}\\`)) {
      return false;
    }
  }

  // Check extension
  const lastDot = path.lastIndexOf(".");
  if (lastDot === -1) return false;
  const ext = path.slice(lastDot).toLowerCase();
  return ANALYZABLE_EXTENSIONS.has(ext);
}

function scheduleFlush(): void {
  // Clear existing debounce timer
  if (debounceTimer) {
    clearTimeout(debounceTimer);
  }

  // Set batch start time if this is the first file in a batch
  if (pendingFiles.size === 1 || batchStartTime === 0) {
    batchStartTime = Date.now();
  }

  // Set max batch timer (force flush after BATCH_MAX_WAIT_MS)
  if (!batchTimer) {
    batchTimer = setTimeout(() => {
      flushPendingFiles();
    }, BATCH_MAX_WAIT_MS);
  }

  // Debounce: wait for more files, then flush
  debounceTimer = setTimeout(() => {
    flushPendingFiles();
  }, DEBOUNCE_MS);
}

async function flushPendingFiles(): Promise<void> {
  if (pendingFiles.size === 0) return;

  // Clear timers
  if (debounceTimer) {
    clearTimeout(debounceTimer);
    debounceTimer = null;
  }
  if (batchTimer) {
    clearTimeout(batchTimer);
    batchTimer = null;
  }

  const files = Array.from(pendingFiles);
  pendingFiles.clear();
  batchStartTime = 0;

  try {
    const result = await analyzeFileDependencies(files);
    invalidateEngineCache();
    notifyState(result, []);
  } catch (err) {
    notifyState(null, [String(err)]);
  }
}

async function runInitialScan(): Promise<void> {
  // Import dynamically to avoid circular dependency
  const { getCachedAnalysis } = await import("./ArchitectureEngine");

  try {
    const result = await getCachedAnalysis(true); // force refresh
    notifyState(result, []);
  } catch (err) {
    notifyState(null, [String(err)]);
  }
}

function notifyState(
  result: DependencyAnalysisResult | null,
  errors: string[],
): void {
  if (onScanComplete) {
    onScanComplete({
      isScanning: unlistenFn !== null,
      lastFileCount: result?.file_count ?? 0,
      lastScanAt: Date.now(),
      errors,
      initialScanDone: true,
    });
  }
}