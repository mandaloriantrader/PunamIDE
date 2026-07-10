/**
 * debt-analyzer.worker.ts — Phase 4
 *
 * Phase 4 changes over Phase 2:
 *  - ImportExtractor runs during the same Tree-sitter pass as ASTMetricsExtractor
 *    (one parse → two outputs: astMetrics + importMap)
 *  - Worker response now includes importMaps: FileImportExportMap[]
 *    alongside fileMetrics: FileDebtMetrics[]
 *  - sizeRiskScore field used consistently (was duplicationScore in Phase 2 output)
 *  - Legacy 'analyze' shim updated to use sizeRiskScore
 *  - WorkerCacheEntry stores importMap alongside metrics so cache hits
 *    return both without re-parsing
 *
 * Message protocol v2 (analyze_v2):
 *
 *   Incoming:
 *     { type: 'analyze_v2', files: Record<string, string>, config: AnalysisConfig }
 *
 *   Outgoing:
 *     {
 *       fileMetrics: FileDebtMetrics[],
 *       importMaps:  FileImportExportMap[],
 *       fromCache:   number,
 *     }
 *
 * The main thread (DebtAnalyzer.analyzeInWorker) receives importMaps and
 * stores them for DependencyGraphEngine.build() which runs after the worker
 * returns. Graph building is NOT done in the worker — it needs all files
 * to be known first and runs on the main thread after analysis completes.
 */

import { getASTEngine, extensionToLanguage }  from '../services/technicalDebt/ASTEngine'
import { getASTMetricsExtractor }             from '../services/technicalDebt/ASTMetricsExtractor'
import { getImportExtractor }                 from '../services/technicalDebt/ImportExtractor'
import type { FileImportExportMap }           from '../services/technicalDebt/ImportExtractor'
import {
  computeFileScore,
  classifyFile,
  sha256,
  THRESHOLDS,
  type FileDebtMetrics,
  type ASTMetrics,
  type AnalysisConfig,
} from '../services/technicalDebt/DebtAnalyzer'

// ── Worker-local cache with LRU eviction ──────────────────────────────────────

const MAX_CACHE_ENTRIES = 1500

interface WorkerCacheEntry {
  hash:       string
  metrics:    FileDebtMetrics
  importMap:  FileImportExportMap
  lastAccess: number
}

const workerCache = new Map<string, WorkerCacheEntry>()

/** Evict oldest 20% of entries when cache exceeds max size. */
function evictIfNeeded(): void {
  if (workerCache.size < MAX_CACHE_ENTRIES) return

  const evictCount = Math.floor(MAX_CACHE_ENTRIES * 0.2)
  const entries = [...workerCache.entries()]
    .sort((a, b) => a[1].lastAccess - b[1].lastAccess)

  for (let i = 0; i < evictCount && i < entries.length; i++) {
    workerCache.delete(entries[i][0])
  }
}

// ── Message handler ───────────────────────────────────────────────────────────

self.onmessage = async (event: MessageEvent) => {
  const { type, files } = event.data as {
    type:   'analyze_v2' | 'analyze'
    files:  Record<string, string>
    config: AnalysisConfig
  }

  const isLegacy = type === 'analyze'

  const fileMetrics: FileDebtMetrics[]  = []
  const importMaps:  FileImportExportMap[] = []
  let   fromCache = 0

  // Pre-warm Tree-sitter grammars for all languages in this batch
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
    const hash   = await sha256(content)
    const cached = workerCache.get(filePath)
    if (cached && cached.hash === hash) {
      cached.lastAccess = Date.now()
      fileMetrics.push(cached.metrics)
      importMaps.push(cached.importMap)
      fromCache++
      continue
    }

    // ── Analyse ──────────────────────────────────────────────────────────────
    const { metrics, importMap } = await analyzeFile(filePath, content, hash)
    evictIfNeeded()
    workerCache.set(filePath, { hash, metrics, importMap, lastAccess: Date.now() })
    fileMetrics.push(metrics)
    importMaps.push(importMap)
  }

  // ── Legacy response shim ─────────────────────────────────────────────────
  if (isLegacy) {
    self.postMessage({
      report: {
        fileScores: fileMetrics.map((m) => ({
          path:       m.filePath,
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

  self.postMessage({
    fileMetrics,
    importMaps,
    fromCache,
    astDiagnostics: engine.getDiagnostics(),
  })
}

// ── Per-file analysis ─────────────────────────────────────────────────────────

async function analyzeFile(
  filePath: string,
  content:  string,
  _hash:    string,
): Promise<{ metrics: FileDebtMetrics; importMap: FileImportExportMap }> {
  const lines = content.split('\n')
  const loc   = lines.length
  const { isUtilityFile, isTestFile } = classifyFile(filePath)

  // ── Regex baseline ────────────────────────────────────────────────────────
  const baseline = computeBaselineMetrics(content, lines, loc)

  // ── AST path: metrics + imports in one parse ──────────────────────────────
  const language  = extensionToLanguage(filePath)
  let astMetrics: ASTMetrics | null = null

  let importMap: FileImportExportMap = {
    filePath,
    imports:      [],
    exports:      [],
    externalDeps: [],
  }

  if (language) {
    try {
      const engine    = getASTEngine()
      const tree      = await engine.parse(content, language)

      if (tree) {
        const metricsExtractor = getASTMetricsExtractor()
        const importExtractor  = getImportExtractor()

        astMetrics = metricsExtractor.extract(tree)
        importMap  = importExtractor.extract(tree, filePath)
      }
    } catch {
      // AST failure — both stay as defaults, regex baseline used
    }
  }

  if (importMap.imports.length === 0 && baseline.dependencyDepth > 0) {
    // Regex-extracted import count is already in baseline.dependencyDepth
    // No action needed — computeFileScore uses dependencyDepth directly
  }

  // ── Score ─────────────────────────────────────────────────────────────────
  const functionCount     = astMetrics?.functionCount ?? baseline.functionCount
  const avgFunctionLength = functionCount > 0 ? Math.round(loc / functionCount) : loc

  const fileScore = computeFileScore({
    loc,
    commentRatio:      baseline.commentRatio,
    avgFunctionLength,
    dependencyDepth:   baseline.dependencyDepth,
    todoCount:         baseline.todoCount,
    fixmeCount:        baseline.fixmeCount,
    sizeRiskScore:     baseline.sizeRiskScore,
    isUtilityFile,
    isTestFile,
    astMetrics,
    couplingScore: null,
    isInCycle:     null,
  })

  const metrics: FileDebtMetrics = {
    filePath,
    linesOfCode:       loc,
    commentLines:      baseline.commentLines,
    commentRatio:      baseline.commentRatio,
    functionCount,
    avgFunctionLength,
    maxFunctionLength: baseline.maxFunctionLength,
    todoCount:         baseline.todoCount,
    fixmeCount:        baseline.fixmeCount,
    hackCount:         baseline.hackCount,
    sizeRiskScore:     baseline.sizeRiskScore,
    dependencyDepth:   baseline.dependencyDepth,
    fileScore,
    isUtilityFile,
    isTestFile,
    astMetrics,
    couplingScore:  null,
    dependencyRisk: null,
    isHubFile:      null,
    isInCycle:      null,
  }

  return { metrics, importMap }
}

// ── Regex baseline ────────────────────────────────────────────────────────────

function computeBaselineMetrics(
  content: string,
  lines:   string[],
  loc:     number,
) {
  const commentLines = lines.filter((l) => {
    const t = l.trim()
    return (
      t.startsWith('//') || t.startsWith('#') ||
      t.startsWith('/*') || t.startsWith('*') ||
      t.startsWith('<!--')
    )
  }).length
  const commentRatio = loc > 0 ? Math.round((commentLines / loc) * 100) / 100 : 0

  // Strip string contents and comments to avoid false positive function matches
  const stripped = content
    .replace(/\/\*[\s\S]*?\*\//g, '/* */')        // block comments → placeholder
    .replace(/\/\/.*/g, '//')                       // line comments → placeholder
    .replace(/(["'`])(?:(?!\1|\\).|\\.)*\1/g, '""') // string literals → empty

  // Tightened function patterns — require line-start context to reduce false positives
  // Each pattern is designed to match declarations, not invocations
  const functionPattern =
    /(?:^|\n)\s*(?:export\s+)?(?:async\s+)?function\s+\w+|(?:^|\n)\s*(?:export\s+)?(?:const|let|var)\s+\w+\s*=\s*(?:async\s+)?(?:\([^)]*\)|[\w$]+)\s*=>|(?:^|\n)\s*(?:export\s+)?(?:async\s+)?(?:public|private|protected|static)?\s*\w+\s*\([^)]*\)\s*[:{]|(?:^|\n)\s*(?:async\s+)?def\s+\w+\s*\(|(?:^|\n)\s*(?:pub\s+)?(?:async\s+)?fn\s+\w+|(?:^|\n)\s*func\s+\w+/g
  const functionMatches   = stripped.match(functionPattern) ?? []
  const functionCount     = functionMatches.length
  const avgFunctionLength = functionCount > 0 ? Math.round(loc / functionCount) : loc

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

  const todoCount  = (content.match(/TODO/gi)     ?? []).length
  const fixmeCount = (content.match(/FIXME/gi)    ?? []).length
  const hackCount  = (content.match(/\bHACK\b/gi) ?? []).length

  const dependencyDepth = lines.filter((l) =>
    /^\s*(import|require|from|use\s|#include)/.test(l)
  ).length

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
