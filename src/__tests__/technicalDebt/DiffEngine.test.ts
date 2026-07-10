/**
 * Unit tests for DiffEngine — scan-to-scan differential analysis.
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { DiffEngine } from '../../services/technicalDebt/DiffEngine'
import type { FileDebtMetrics } from '../../services/technicalDebt/DebtAnalyzer'

function makeFile(filePath: string, fileScore: number, overrides: Partial<FileDebtMetrics> = {}): FileDebtMetrics {
  return {
    filePath,
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
    fileScore,
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

describe('DiffEngine', () => {
  let engine: DiffEngine

  beforeEach(() => {
    engine = new DiffEngine()
  })

  describe('first scan — no previous', () => {
    it('returns empty diff with hasPrevious=false', () => {
      const files = [makeFile('/a.ts', 70), makeFile('/b.ts', 80)]
      const diff = engine.computeDiff(files, 75)

      expect(diff.hasPrevious).toBe(false)
      expect(diff.improved).toHaveLength(0)
      expect(diff.regressed).toHaveLength(0)
      expect(diff.newFiles).toHaveLength(0)
      expect(diff.removedFiles).toHaveLength(0)
      expect(diff.overallDelta).toBe(0)
    })

    it('sets hasPrevious after first scan', () => {
      engine.computeDiff([makeFile('/a.ts', 70)], 70)
      expect(engine.hasPrevious).toBe(true)
    })
  })

  describe('detecting improvements', () => {
    it('detects file that improved by > 3 points', () => {
      engine.computeDiff([makeFile('/a.ts', 50)], 50)
      const diff = engine.computeDiff([makeFile('/a.ts', 60)], 60)

      expect(diff.hasPrevious).toBe(true)
      expect(diff.improved).toHaveLength(1)
      expect(diff.improved[0].filePath).toBe('/a.ts')
      expect(diff.improved[0].delta).toBe(10)
      expect(diff.improved[0].previousScore).toBe(50)
      expect(diff.improved[0].currentScore).toBe(60)
    })

    it('does not report improvement ≤ 3 points', () => {
      engine.computeDiff([makeFile('/a.ts', 70)], 70)
      const diff = engine.computeDiff([makeFile('/a.ts', 73)], 73)

      expect(diff.improved).toHaveLength(0)
    })

    it('sorts improvements by biggest delta first', () => {
      engine.computeDiff([
        makeFile('/a.ts', 50),
        makeFile('/b.ts', 40),
      ], 45)
      const diff = engine.computeDiff([
        makeFile('/a.ts', 55), // +5
        makeFile('/b.ts', 60), // +20
      ], 57)

      expect(diff.improved).toHaveLength(2)
      expect(diff.improved[0].filePath).toBe('/b.ts')
      expect(diff.improved[0].delta).toBe(20)
    })
  })

  describe('detecting regressions', () => {
    it('detects file that regressed by > 3 points', () => {
      engine.computeDiff([makeFile('/a.ts', 80)], 80)
      const diff = engine.computeDiff([makeFile('/a.ts', 60)], 60)

      expect(diff.regressed).toHaveLength(1)
      expect(diff.regressed[0].filePath).toBe('/a.ts')
      expect(diff.regressed[0].delta).toBe(-20)
    })

    it('does not report regression ≤ 3 points', () => {
      engine.computeDiff([makeFile('/a.ts', 70)], 70)
      const diff = engine.computeDiff([makeFile('/a.ts', 68)], 68)

      expect(diff.regressed).toHaveLength(0)
    })

    it('sorts regressions by biggest drop first', () => {
      engine.computeDiff([
        makeFile('/a.ts', 80),
        makeFile('/b.ts', 90),
      ], 85)
      const diff = engine.computeDiff([
        makeFile('/a.ts', 70), // -10
        makeFile('/b.ts', 50), // -40
      ], 60)

      expect(diff.regressed).toHaveLength(2)
      expect(diff.regressed[0].filePath).toBe('/b.ts')
      expect(diff.regressed[0].delta).toBe(-40)
    })
  })

  describe('detecting new and removed files', () => {
    it('detects new files (not in previous scan)', () => {
      engine.computeDiff([makeFile('/a.ts', 70)], 70)
      const diff = engine.computeDiff([
        makeFile('/a.ts', 70),
        makeFile('/b.ts', 60),
      ], 65)

      expect(diff.newFiles).toHaveLength(1)
      expect(diff.newFiles[0].filePath).toBe('/b.ts')
      expect(diff.newFiles[0].isNew).toBe(true)
    })

    it('detects removed files (in previous but not current)', () => {
      engine.computeDiff([
        makeFile('/a.ts', 70),
        makeFile('/b.ts', 60),
      ], 65)
      const diff = engine.computeDiff([makeFile('/a.ts', 70)], 70)

      expect(diff.removedFiles).toHaveLength(1)
      expect(diff.removedFiles[0].filePath).toBe('/b.ts')
      expect(diff.removedFiles[0].isRemoved).toBe(true)
    })
  })

  describe('overall delta', () => {
    it('computes positive overall delta (improvement)', () => {
      engine.computeDiff([makeFile('/a.ts', 60)], 60)
      const diff = engine.computeDiff([makeFile('/a.ts', 80)], 80)

      expect(diff.overallDelta).toBe(20)
      expect(diff.previousOverall).toBe(60)
      expect(diff.currentOverall).toBe(80)
    })

    it('computes negative overall delta (regression)', () => {
      engine.computeDiff([makeFile('/a.ts', 80)], 80)
      const diff = engine.computeDiff([makeFile('/a.ts', 50)], 50)

      expect(diff.overallDelta).toBe(-30)
    })
  })

  describe('issue tracking', () => {
    it('reports resolved issues on improvement', () => {
      // File with high complexity issue
      engine.computeDiff([
        makeFile('/a.ts', 40, {
          astMetrics: {
            cyclomaticComplexity: 25, maxNestingDepth: 2, avgNestingDepth: 1,
            functionCount: 5, longFunctionCount: 0, godFunctionCount: 0,
            maxParameterCount: 3, avgParameterCount: 2, classCount: 0, godClassCount: 0, returnCount: 3,
          },
        }),
      ], 40)

      // Now fixed — clean file
      const diff = engine.computeDiff([
        makeFile('/a.ts', 85, { astMetrics: null }),
      ], 85)

      expect(diff.improved).toHaveLength(1)
      expect(diff.improved[0].resolvedIssues).toContain('high_complexity')
    })

    it('reports new issues on regression', () => {
      engine.computeDiff([makeFile('/a.ts', 85)], 85)

      // Now has too many TODOs
      const diff = engine.computeDiff([
        makeFile('/a.ts', 50, { todoCount: 10, fixmeCount: 5, linesOfCode: 200, dependencyDepth: 3 }),
      ], 50)

      expect(diff.regressed).toHaveLength(1)
      expect(diff.regressed[0].newIssues.length).toBeGreaterThan(0)
    })
  })

  describe('reset', () => {
    it('clears previous state', () => {
      engine.computeDiff([makeFile('/a.ts', 70)], 70)
      expect(engine.hasPrevious).toBe(true)

      engine.reset()
      expect(engine.hasPrevious).toBe(false)

      const diff = engine.computeDiff([makeFile('/a.ts', 80)], 80)
      expect(diff.hasPrevious).toBe(false)
    })
  })

  describe('consecutive diffs', () => {
    it('updates baseline after each diff', () => {
      engine.computeDiff([makeFile('/a.ts', 50)], 50)
      engine.computeDiff([makeFile('/a.ts', 70)], 70) // baseline becomes 70

      // Third scan: compared against 70, not 50
      const diff = engine.computeDiff([makeFile('/a.ts', 75)], 75)
      expect(diff.improved).toHaveLength(1)
      expect(diff.improved[0].previousScore).toBe(70) // not 50
      expect(diff.improved[0].delta).toBe(5)
    })
  })
})
