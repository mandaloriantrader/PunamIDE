/**
 * Unit tests for DebtScorer — categorization, module scoring, trend detection, effort/impact matrix.
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { DebtScorer } from '../../services/technicalDebt/DebtScorer'
import type { ProjectDebtAnalysis, FileDebtMetrics, ASTMetrics } from '../../services/technicalDebt/DebtAnalyzer'

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeMetrics(overrides: Partial<FileDebtMetrics> = {}): FileDebtMetrics {
  return {
    filePath: '/src/components/Foo.ts',
    linesOfCode: 200,
    commentLines: 20,
    commentRatio: 0.1,
    functionCount: 5,
    avgFunctionLength: 40,
    maxFunctionLength: 60,
    todoCount: 1,
    fixmeCount: 0,
    hackCount: 0,
    sizeRiskScore: 0,
    dependencyDepth: 3,
    fileScore: 75,
    isUtilityFile: false,
    isTestFile: false,
    astMetrics: null,
    couplingScore: null,
    dependencyRisk: null,
    isHubFile: null,
    isInCycle: null,
    ...overrides,
  }
}

function makeAnalysis(files: FileDebtMetrics[]): ProjectDebtAnalysis {
  const overallScore = files.length > 0
    ? Math.round(files.reduce((s, f) => s + f.fileScore, 0) / files.length)
    : 100
  return {
    files,
    hotspots: [],
    overallScore,
    totalFilesAnalyzed: files.length,
    totalLinesOfCode: files.reduce((s, f) => s + f.linesOfCode, 0),
    discovery: { discovered: files.length, analyzed: files.length, skipped: 0, failed: 0, fromCache: 0 },
    graph: null,
    astStatus: {
      mode: 'fallback', execution: 'main-thread',
      supportedFiles: files.length, astFiles: 0, fallbackFiles: files.length,
      fallbackFilePaths: [], unsupportedFiles: 0, parserFailures: 0,
      loadedLanguages: [], lastError: null,
    },
  }
}

describe('DebtScorer', () => {
  let scorer: DebtScorer

  beforeEach(() => {
    scorer = new DebtScorer()
  })

  describe('categorize', () => {
    it('returns excellent for score ≥ 85', () => {
      expect(scorer.categorize(85)).toBe('excellent')
      expect(scorer.categorize(100)).toBe('excellent')
    })

    it('returns good for score 70–84', () => {
      expect(scorer.categorize(70)).toBe('good')
      expect(scorer.categorize(84)).toBe('good')
    })

    it('returns fair for score 50–69', () => {
      expect(scorer.categorize(50)).toBe('fair')
      expect(scorer.categorize(69)).toBe('fair')
    })

    it('returns poor for score 30–49', () => {
      expect(scorer.categorize(30)).toBe('poor')
      expect(scorer.categorize(49)).toBe('poor')
    })

    it('returns critical for score < 30', () => {
      expect(scorer.categorize(0)).toBe('critical')
      expect(scorer.categorize(29)).toBe('critical')
    })
  })

  describe('detectTrend', () => {
    it('returns stable on first scan', () => {
      expect(scorer.detectTrend(75)).toBe('stable')
    })

    it('returns improving when score rises by > 3', () => {
      // Record a baseline
      scorer.score(makeAnalysis([makeMetrics({ fileScore: 70 })]))
      // Now check trend against previous
      expect(scorer.detectTrend(80)).toBe('improving')
    })

    it('returns declining when score drops by > 3', () => {
      scorer.score(makeAnalysis([makeMetrics({ fileScore: 80 })]))
      expect(scorer.detectTrend(70)).toBe('declining')
    })

    it('returns stable when difference is ≤ 3', () => {
      scorer.score(makeAnalysis([makeMetrics({ fileScore: 75 })]))
      expect(scorer.detectTrend(76)).toBe('stable')
      expect(scorer.detectTrend(73)).toBe('stable')
    })
  })

  describe('score — overall', () => {
    it('produces correct category from file scores', () => {
      const files = [
        makeMetrics({ fileScore: 90 }),
        makeMetrics({ fileScore: 85 }),
        makeMetrics({ fileScore: 88 }),
      ]
      const result = scorer.score(makeAnalysis(files))
      expect(result.category).toBe('excellent')
      expect(result.overall).toBeGreaterThanOrEqual(85)
    })

    it('accumulates trend history across multiple calls', () => {
      scorer.score(makeAnalysis([makeMetrics({ fileScore: 70 })]))
      scorer.score(makeAnalysis([makeMetrics({ fileScore: 75 })]))
      const third = scorer.score(makeAnalysis([makeMetrics({ fileScore: 80 })]))
      expect(third.trendHistory).toHaveLength(3)
    })
  })

  describe('scoreModules — module grouping', () => {
    it('groups files by directory path', () => {
      const files = [
        makeMetrics({ filePath: '/src/components/A.ts', fileScore: 70 }),
        makeMetrics({ filePath: '/src/components/B.ts', fileScore: 80 }),
        makeMetrics({ filePath: '/src/services/C.ts', fileScore: 60 }),
      ]
      const modules = scorer.scoreModules(files)
      expect(modules.length).toBeGreaterThanOrEqual(2)
      const componentModule = modules.find(m => m.module.includes('components'))
      expect(componentModule).toBeDefined()
      expect(componentModule!.fileCount).toBe(2)
    })

    it('computes per-module average scores', () => {
      const files = [
        makeMetrics({ filePath: '/src/services/A.ts', fileScore: 60 }),
        makeMetrics({ filePath: '/src/services/B.ts', fileScore: 80 }),
      ]
      const modules = scorer.scoreModules(files)
      const svcModule = modules.find(m => m.module.includes('services'))
      expect(svcModule).toBeDefined()
      // Average of 60 and 80 = 70 (with possible adjustedFileScore delta)
      expect(svcModule!.score).toBeGreaterThanOrEqual(55)
      expect(svcModule!.score).toBeLessThanOrEqual(85)
    })

    it('sorts modules by score ascending (worst first)', () => {
      const files = [
        makeMetrics({ filePath: '/src/good/A.ts', fileScore: 90 }),
        makeMetrics({ filePath: '/src/bad/B.ts', fileScore: 30 }),
      ]
      const modules = scorer.scoreModules(files)
      expect(modules[0].score).toBeLessThanOrEqual(modules[modules.length - 1].score)
    })
  })

  describe('buildEffortImpactMatrix', () => {
    it('assigns high effort to complex issues', () => {
      const matrix = scorer.buildEffortImpactMatrix([
        { filePath: '/a.ts', score: 30, primaryIssue: 'high_complexity', recommendation: 'Reduce CC', astDetail: null },
        { filePath: '/b.ts', score: 40, primaryIssue: 'god_function', recommendation: 'Extract', astDetail: null },
      ])
      expect(matrix[0].estimatedEffort).toBe('high')
      expect(matrix[1].estimatedEffort).toBe('high')
    })

    it('assigns low effort to TODO cleanup', () => {
      const matrix = scorer.buildEffortImpactMatrix([
        { filePath: '/a.ts', score: 60, primaryIssue: 'many_todos', recommendation: 'Resolve', astDetail: null },
      ])
      expect(matrix[0].estimatedEffort).toBe('low')
    })

    it('assigns priority 1–10', () => {
      const matrix = scorer.buildEffortImpactMatrix([
        { filePath: '/a.ts', score: 30, primaryIssue: 'high_complexity', recommendation: 'Fix', astDetail: null },
        { filePath: '/b.ts', score: 80, primaryIssue: 'low_comments', recommendation: 'Doc', astDetail: null },
      ])
      for (const item of matrix) {
        expect(item.priority).toBeGreaterThanOrEqual(1)
        expect(item.priority).toBeLessThanOrEqual(10)
      }
    })

    it('sorts by priority descending', () => {
      const matrix = scorer.buildEffortImpactMatrix([
        { filePath: '/a.ts', score: 80, primaryIssue: 'low_comments', recommendation: 'Doc', astDetail: null },
        { filePath: '/b.ts', score: 20, primaryIssue: 'high_complexity', recommendation: 'Fix', astDetail: null },
      ])
      expect(matrix[0].priority).toBeGreaterThanOrEqual(matrix[1].priority)
    })
  })

  describe('adjustedFileScore', () => {
    it('returns fileScore for files without AST', () => {
      const file = makeMetrics({ fileScore: 72, astMetrics: null })
      expect(scorer.adjustedFileScore(file)).toBe(72)
    })

    it('returns fileScore unchanged when no graph data present', () => {
      // With AST but no graph data — should NOT double-penalize AST metrics
      const file = makeMetrics({
        fileScore: 60,
        astMetrics: {
          cyclomaticComplexity: 25, maxNestingDepth: 6,
          avgNestingDepth: 3, functionCount: 10,
          longFunctionCount: 2, godFunctionCount: 1,
          maxParameterCount: 8, avgParameterCount: 4,
          classCount: 1, godClassCount: 0, returnCount: 8,
        },
        isInCycle: null,
        couplingScore: null,
      })
      // Should return fileScore as-is (no AST re-penalty)
      expect(scorer.adjustedFileScore(file)).toBe(60)
    })

    it('applies minor graph-enrichment nudge for cycle membership', () => {
      const file = makeMetrics({ fileScore: 50, isInCycle: true, couplingScore: null })
      const adjusted = scorer.adjustedFileScore(file)
      // Small -3 nudge for display sorting
      expect(adjusted).toBe(47)
    })

    it('applies minor graph-enrichment nudge for high coupling', () => {
      const file = makeMetrics({ fileScore: 60, isInCycle: false, couplingScore: 90 })
      const adjusted = scorer.adjustedFileScore(file)
      // Small penalty: Math.min(5, (90-70)/10) = Math.min(5, 2) = -2
      expect(adjusted).toBe(58)
    })

    it('score stays within 0–100 bounds', () => {
      const file = makeMetrics({
        fileScore: 10,
        astMetrics: {
          cyclomaticComplexity: 50, maxNestingDepth: 10,
          avgNestingDepth: 5, functionCount: 20,
          longFunctionCount: 10, godFunctionCount: 5,
          maxParameterCount: 12, avgParameterCount: 6,
          classCount: 3, godClassCount: 2, returnCount: 15,
        },
        isInCycle: true,
        couplingScore: 90,
      })
      const adjusted = scorer.adjustedFileScore(file)
      expect(adjusted).toBeGreaterThanOrEqual(0)
      expect(adjusted).toBeLessThanOrEqual(100)
    })

    it('does not double-penalize AST metrics already in fileScore', () => {
      // File scored at 40 due to high complexity (already penalized in computeFileScore)
      const file = makeMetrics({
        fileScore: 40,
        astMetrics: {
          cyclomaticComplexity: 35, maxNestingDepth: 8,
          avgNestingDepth: 4, functionCount: 15,
          longFunctionCount: 5, godFunctionCount: 3,
          maxParameterCount: 10, avgParameterCount: 5,
          classCount: 2, godClassCount: 1, returnCount: 10,
        },
        isInCycle: null,
        couplingScore: null,
      })
      // Without graph data, adjusted should equal fileScore exactly (no AST re-penalty)
      expect(scorer.adjustedFileScore(file)).toBe(40)
    })
  })
})
