/**
 * Unit tests for RefactorPlanner — plan generation, categorization, effort estimates.
 */

import { describe, it, expect } from 'vitest'
import { RefactorPlanner } from '../../services/technicalDebt/RefactorPlanner'
import type { ProjectDebtAnalysis, FileDebtMetrics, DebtHotspot } from '../../services/technicalDebt/DebtAnalyzer'

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeMetrics(overrides: Partial<FileDebtMetrics> = {}): FileDebtMetrics {
  return {
    filePath: '/src/test.ts',
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
    fileScore: 50,
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

function makeHotspot(overrides: Partial<DebtHotspot> = {}): DebtHotspot {
  return {
    filePath: '/src/test.ts',
    score: 40,
    primaryIssue: 'high_complexity',
    recommendation: 'Reduce complexity',
    astDetail: null,
    ...overrides,
  }
}

function makeAnalysis(
  hotspots: DebtHotspot[],
  files: FileDebtMetrics[] = [],
): ProjectDebtAnalysis {
  return {
    files,
    hotspots,
    overallScore: 60,
    totalFilesAnalyzed: files.length,
    totalLinesOfCode: files.reduce((s, f) => s + f.linesOfCode, 0),
    discovery: { discovered: 100, analyzed: 100, skipped: 0, failed: 0, fromCache: 0 },
    graph: null,
    astStatus: {
      mode: 'fallback', execution: 'main-thread',
      supportedFiles: 100, astFiles: 0, fallbackFiles: 100,
      fallbackFilePaths: [], unsupportedFiles: 0, parserFailures: 0,
      loadedLanguages: [], lastError: null,
    },
  }
}

describe('RefactorPlanner', () => {
  const planner = new RefactorPlanner()

  describe('generatePlan — basic plan structure', () => {
    it('produces a plan with correct structure', () => {
      const analysis = makeAnalysis([
        makeHotspot({ filePath: '/src/a.ts', primaryIssue: 'high_complexity' }),
        makeHotspot({ filePath: '/src/b.ts', primaryIssue: 'many_todos' }),
      ])
      const plan = planner.generatePlan(analysis)

      expect(plan.items).toBeDefined()
      expect(plan.totalEstimatedHours).toBeGreaterThan(0)
      expect(plan.generatedAt).toBeGreaterThan(0)
      expect(plan.quickWins).toBeDefined()
      expect(plan.majorRefactors).toBeDefined()
      expect(plan.maintenance).toBeDefined()
      expect(plan.architecturalIssues).toBeDefined()
    })

    it('returns empty plan for no hotspots', () => {
      const analysis = makeAnalysis([])
      const plan = planner.generatePlan(analysis)
      expect(plan.items).toHaveLength(0)
      expect(plan.totalEstimatedHours).toBe(0)
    })
  })

  describe('categorization', () => {
    it('categorizes high_complexity as major_refactor', () => {
      const analysis = makeAnalysis([
        makeHotspot({ primaryIssue: 'high_complexity' }),
      ])
      const plan = planner.generatePlan(analysis)
      expect(plan.items[0].category).toBe('major_refactor')
    })

    it('categorizes deep_deps as architectural', () => {
      const analysis = makeAnalysis([
        makeHotspot({ primaryIssue: 'deep_deps' }),
      ])
      const plan = planner.generatePlan(analysis)
      expect(plan.items[0].category).toBe('architectural')
    })

    it('categorizes god_function as major_refactor', () => {
      const analysis = makeAnalysis([
        makeHotspot({ primaryIssue: 'god_function' }),
      ])
      const plan = planner.generatePlan(analysis)
      expect(plan.items[0].category).toBe('major_refactor')
    })

    it('populates whyFlagged for all items', () => {
      const analysis = makeAnalysis([
        makeHotspot({ primaryIssue: 'high_complexity' }),
        makeHotspot({ filePath: '/src/b.ts', primaryIssue: 'many_todos' }),
        makeHotspot({ filePath: '/src/c.ts', primaryIssue: 'file_too_large' }),
      ])
      const plan = planner.generatePlan(analysis)
      for (const item of plan.items) {
        expect(item.whyFlagged).toBeTruthy()
        expect(item.whyFlagged.length).toBeGreaterThan(10)
      }
    })

    it('populates expectedPayoff for all items', () => {
      const analysis = makeAnalysis([
        makeHotspot({ primaryIssue: 'excessive_nesting' }),
      ])
      const plan = planner.generatePlan(analysis)
      expect(plan.items[0].expectedPayoff).toBeTruthy()
      expect(plan.items[0].expectedPayoff.length).toBeGreaterThan(10)
    })
  })

  describe('effort estimation', () => {
    it('returns valid effort levels', () => {
      const validEfforts = ['low', 'medium', 'high']
      const issues = [
        'high_complexity', 'excessive_nesting', 'many_todos',
        'low_comments', 'file_too_large', 'god_function',
      ]
      for (const issue of issues) {
        const analysis = makeAnalysis([makeHotspot({ primaryIssue: issue })])
        const plan = planner.generatePlan(analysis)
        expect(validEfforts).toContain(plan.items[0].estimatedEffort)
      }
    })

    it('assigns effortHours > 0', () => {
      const analysis = makeAnalysis([
        makeHotspot({ primaryIssue: 'high_complexity' }),
      ])
      const plan = planner.generatePlan(analysis)
      expect(plan.items[0].effortHours).toBeGreaterThan(0)
    })

    it('totalEstimatedHours is sum of all item hours', () => {
      const analysis = makeAnalysis([
        makeHotspot({ filePath: '/a.ts', primaryIssue: 'high_complexity' }),
        makeHotspot({ filePath: '/b.ts', primaryIssue: 'many_todos' }),
      ])
      const plan = planner.generatePlan(analysis)
      const sum = plan.items.reduce((s, i) => s + i.effortHours, 0)
      expect(plan.totalEstimatedHours).toBeCloseTo(sum, 1)
    })
  })

  describe('risk estimation', () => {
    it('assigns high risk to file_too_large', () => {
      const risk = planner.estimateRisk(
        makeHotspot({ primaryIssue: 'file_too_large' }),
      )
      expect(risk).toBe('high')
    })

    it('assigns low risk to low_comments', () => {
      const risk = planner.estimateRisk(
        makeHotspot({ primaryIssue: 'low_comments' }),
      )
      expect(risk).toBe('low')
    })

    it('assigns high risk to circular_dependency', () => {
      const risk = planner.estimateRisk(
        makeHotspot({ primaryIssue: 'circular_dependency' }),
      )
      expect(risk).toBe('high')
    })
  })

  describe('priority ordering', () => {
    it('sorts items by priority descending', () => {
      const analysis = makeAnalysis([
        makeHotspot({ filePath: '/a.ts', primaryIssue: 'low_comments', score: 80 }),
        makeHotspot({ filePath: '/b.ts', primaryIssue: 'high_complexity', score: 20 }),
        makeHotspot({ filePath: '/c.ts', primaryIssue: 'many_todos', score: 60 }),
      ])
      const plan = planner.generatePlan(analysis)
      for (let i = 1; i < plan.items.length; i++) {
        expect(plan.items[i - 1].priority).toBeGreaterThanOrEqual(plan.items[i].priority)
      }
    })
  })

  describe('plan item fields', () => {
    it('each item has all required fields', () => {
      const analysis = makeAnalysis([
        makeHotspot({ primaryIssue: 'high_complexity' }),
      ])
      const plan = planner.generatePlan(analysis)
      const item = plan.items[0]

      expect(item.filePath).toBeTruthy()
      expect(item.issue).toBeTruthy()
      expect(item.recommendation).toBeTruthy()
      expect(['quick_win', 'major_refactor', 'maintenance', 'architectural']).toContain(item.category)
      expect(['low', 'medium', 'high']).toContain(item.estimatedEffort)
      expect(['low', 'medium', 'high']).toContain(item.estimatedRisk)
      expect(['low', 'medium', 'high']).toContain(item.estimatedImpact)
      expect(item.priority).toBeGreaterThanOrEqual(1)
      expect(item.priority).toBeLessThanOrEqual(10)
      expect(item.effortLabel).toBeTruthy()
      expect(item.effortHours).toBeGreaterThan(0)
      expect(Array.isArray(item.dependencies)).toBe(true)
    })
  })
})
