/**
 * debt-analyzer.worker.ts — Phase 2
 *
 * Web Worker for debt analysis. Runs off the main thread so large workspace
 * scans never block the UI.
 *
 * Message protocol:
 *
 *   Incoming (from DebtAnalyzer.ts):
 *     {
 *       type: 'analyze_v2',
 *       files: Record<string, string>,   // filePath → content
 *       config: AnalysisConfig,
 *     }
 *
 *   Outgoing (to DebtAnalyzer.ts):
 *     {
 *       fileMetrics: FileDebtMetrics[],
 *       fromCache: number,               // how many files were cache hits
 *     }
 *
 * Analysis strategy per file:
 *   1. Compute SHA-256 of content
 *   2. Check worker-local in-memory cache (keyed by path + hash)
 *   3. If cache miss: attempt AST analysis via ASTEngine + ASTMetricsExtractor
 *   4. If AST fails (unsupported extension, parse error): fall back to regex analysis
 *   5. Store result in worker-local cache
 *
 * Note on persistent cache:
 *   The worker cannot access @tauri-apps/plugin-store (Tauri APIs are
 *   main-thread only). Worker-local cache is in-memory for the worker's
 *   lifetime. The main thread's DebtAnalyzer handles persistent cache
 *   via plugin-store for individual analyzeFile() calls.
 *
 * Note on legacy messages:
 *   The old worker accepted { type: 'analyze', files, archMapData }.
 *   That message type is handled here with a compatibility shim so any
 *   callers not yet updated to 'analyze_v2' still get a valid response.
 */

import { getASTEngine, extensionToLanguage }  from '../services/technicalDebt/ASTEngine'
import { getASTMetricsExtractor }             from '../services/technicalDebt/ASTMetricsExtractor'
import {
  computeFileScore,
  classifyFile,
  sha256,
  THRESHOLDS,
  type FileDebtMetrics,
  type ASTMetrics,
  type AnalysisConfig,
} from '../services/technicalDebt/DebtAnalyzer'

// ── Worker-local cache ────────────────────────────────────────────────────────

interface WorkerCacheEntry {
  hash:    string
  metrics: FileDebtMetrics
}

const workerCache = new Map<string, WorkerCacheEntry>()

// ── Message handler ───────────────────────────────────────────────────────────

self.onmessage = async (event: MessageEvent) => {
  const { type, files, config } = event.data as {
    type:   'analyze_v2' | 'analyze'   // 'analyze' = legacy compat
    files:  Record<string, string>
    config: AnalysisConfig
  }

  // Legacy message shim — translate old format and continue
  const isLegacy = type === 'analyze'

  const fileMetrics: FileDebtMetrics[] = []
  let fromCache = 0

  // Pre-warm grammars for all languages present in this batch.
  // Fires concurrently — analysis loop awaits individual grammar loads
  // which are idempotent, so this just gives them a head start.
  const engine = getASTEngine()
  const presentLanguages = new Set(
    Object.keys(files)
      .map((fp) => extensionToLanguage(fp))
      .filter((l): l is NonNullable<typeof l> => l !== null)
  )
  void Promise.allSettled([...presentLanguages].map((l) => engine.parse('', l)))

  for (const [filePath, content] of Object.entries(files)) {
    if (!content.trim()) continue

    // ── Cache check ──────────────────────────────────────────────────────────
    const hash = await sha256(content)
    const cached = workerCache.get(filePath)
    if (cached && cached.hash === hash) {
      fileMetrics.push(cached.metrics)
      fromCache++
      continue
    }

    // ── Analyse ──────────────────────────────────────────────────────────────
    const metrics = await analyzeFile(filePath, content, hash)
    workerCache.set(filePath, { hash, metrics })
    fileMetrics.push(metrics)
  }

  // Legacy callers expect { report: { fileScores: [] } }
  if (isLegacy) {
    self.postMessage({
      report: {
        fileScores: fileMetrics.map((m) => ({
          path: m.filePath,
          totalScore: 100 - m.fileScore,
          scores: {
            duplication:     m.sizeRiskScore,
            dependencyDepth: m.dependencyDepth,
          },
        })),
      },
    })
    return
  }

  self.postMessage({ fileMetrics, fromCache })
}

// ── Per-file analysis ─────────────────────────────────────────────────────────

async function analyzeFile(
  filePath: string,
  content:  string,
  hash:     string,
): Promise<FileDebtMetrics> {
  const lines = content.split('\n')
  const loc   = lines.length
  const { isUtilityFile, isTestFile } = classifyFile(filePath)

  // ── Regex baseline (always computed — fast, used as fallback) ────────────
  const baseline = computeBaselineMetrics(filePath, content, lines, loc, isUtilityFile, isTestFile)

  // ── AST path ─────────────────────────────────────────────────────────────
  const language = extensionToLanguage(filePath)
  let astMetrics: ASTMetrics | null = null

  if (language) {
    try {
      const engine    = getASTEngine()
      const extractor = getASTMetricsExtractor()
      const tree      = await engine.parse(content, language)

      if (tree) {
        astMetrics = extractor.extract(tree)
      }
    } catch {
      // AST failure — astMetrics stays null, regex baseline is used
    }
  }

  // ── Score ─────────────────────────────────────────────────────────────────
  // Use AST function count if available (more accurate than regex)
  const functionCount     = astMetrics?.functionCount     ?? baseline.functionCount
  const avgFunctionLength = functionCount > 0 ? Math.round(loc / functionCount) : loc

  const fileScore = computeFileScore({
    loc,
    commentRatio:       baseline.commentRatio,
    avgFunctionLength,
    dependencyDepth:    baseline.dependencyDepth,
    todoCount:          baseline.todoCount,
    fixmeCount:         baseline.fixmeCount,
    sizeRiskScore:   baseline.sizeRiskScore,
    isUtilityFile,
    isTestFile,
  })

  return {
    filePath,
    linesOfCode:        loc,
    commentLines:       baseline.commentLines,
    commentRatio:       baseline.commentRatio,
    functionCount,
    avgFunctionLength,
    maxFunctionLength:  baseline.maxFunctionLength,
    todoCount:          baseline.todoCount,
    fixmeCount:         baseline.fixmeCount,
    hackCount:          baseline.hackCount,
    sizeRiskScore:   baseline.sizeRiskScore,
    dependencyDepth:    baseline.dependencyDepth,
    fileScore,
    isUtilityFile,
    isTestFile,
    astMetrics,         // null in Phase 1 callers; populated here in Phase 2
  }
}

// ── Regex baseline ────────────────────────────────────────────────────────────

/**
 * Regex-based metric extraction — identical logic to Phase 1 DebtAnalyzer.
 * Used as the baseline and as fallback when AST is unavailable.
 * Kept here (not imported from DebtAnalyzer) because the worker cannot
 * import Tauri APIs that DebtAnalyzer also imports.
 */
function computeBaselineMetrics(
  _filePath:    string,
  content:      string,
  lines:        string[],
  loc:          number,
  _isUtility:   boolean,
  _isTest:      boolean,
) {
  // Comment ratio
  const commentLines = lines.filter((l) => {
    const t = l.trim()
    return (
      t.startsWith('//') || t.startsWith('#') ||
      t.startsWith('/*') || t.startsWith('*') ||
      t.startsWith('<!--')
    )
  }).length
  const commentRatio = loc > 0 ? Math.round((commentLines / loc) * 100) / 100 : 0

  // Function detection (regex)
  const functionPattern =
    /(?:function\s+\w+|const\s+\w+\s*=\s*(?:\([^)]*\)\s*=>|function)|(?:async\s+)?\w+\s*\([^)]*\)\s*\{|def\s+\w+|fn\s+\w+|func\s+\w+)/g
  const functionMatches = content.match(functionPattern) ?? []
  const functionCount   = functionMatches.length
  const avgFunctionLength = functionCount > 0 ? Math.round(loc / functionCount) : loc

  // Max function length
  let maxFunctionLength = loc
  if (functionMatches.length > 1) {
    let searchFrom = 0
    const positions: number[] = []
    for (const match of functionMatches) {
      const idx = content.indexOf(match, searchFrom)
      if (idx !== -1) { positions.push(idx); searchFrom = idx + 1 }
    }
    let maxGap = 0
    for (let i = 1; i < positions.length; i++) {
      const gapLines = Math.round(((positions[i] - positions[i - 1]) / content.length) * loc)
      if (gapLines > maxGap) maxGap = gapLines
    }
    maxFunctionLength = maxGap || loc
  }

  // TODO / FIXME / HACK
  const todoCount  = (content.match(/TODO/gi)    ?? []).length
  const fixmeCount = (content.match(/FIXME/gi)   ?? []).length
  const hackCount  = (content.match(/\bHACK\b/gi) ?? []).length

  // Import depth
  const dependencyDepth = lines.filter((l) =>
    /^\s*(import|require|from|use\s|#include)/.test(l)
  ).length

  // Duplication heuristic
  const sizeRiskScore =
    loc > THRESHOLDS.LARGE_FILE_LOC
      ? Math.min(100, (loc / THRESHOLDS.LARGE_FILE_LOC) * 30)
      : 0

  return {
    commentLines,
    commentRatio,
    functionCount,
    avgFunctionLength,
    maxFunctionLength,
    todoCount,
    fixmeCount,
    hackCount,
    dependencyDepth,
    sizeRiskScore,
  }
}
