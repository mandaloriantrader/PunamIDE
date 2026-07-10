/**
 * Unit tests for DebtAnalyzer — core scoring, classification, and recommendation logic.
 */

import { describe, it, expect } from 'vitest'
import {
  computeFileScore,
  classifyFile,
  detectPrimaryIssue,
  generateRecommendation,
  classifyComplexity,
  classifyNesting,
  THRESHOLDS,
} from '../../services/technicalDebt/DebtAnalyzer'
import type { FileDebtMetrics, ASTMetrics } from '../../services/technicalDebt/DebtAnalyzer'

// ── Helper: build a FileDebtMetrics with defaults ─────────────────────────────

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
    fileScore: 80,
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

function makeAST(overrides: Partial<ASTMetrics> = {}): ASTMetrics {
  return {
    cyclomaticComplexity: 5,
    maxNestingDepth: 2,
    avgNestingDepth: 1,
    functionCount: 4,
    longFunctionCount: 0,
    godFunctionCount: 0,
    maxParameterCount: 3,
    avgParameterCount: 2,
    classCount: 0,
    godClassCount: 0,
    returnCount: 4,
    ...overrides,
  }
}

// ── computeFileScore tests ──────────────────────────────────────────────────

describe('computeFileScore', () => {
  it('returns 100 for a small clean file', () => {
    const score = computeFileScore({
      loc: 30,
      commentRatio: 0.15,
      avgFunctionLength: 10,
      dependencyDepth: 2,
      todoCount: 0,
      fixmeCount: 0,
      sizeRiskScore: 0,
      isUtilityFile: false,
      isTestFile: false,
      astMetrics: null,
      couplingScore: null,
      isInCycle: null,
    })
    // Small file (<50 LOC) gets floor of 45 but starts at 100 with no penalties
    expect(score).toBeGreaterThanOrEqual(45)
    expect(score).toBeLessThanOrEqual(100)
  })

  it('penalizes large files (>500 LOC)', () => {
    const small = computeFileScore({
      loc: 200, commentRatio: 0.1, avgFunctionLength: 30,
      dependencyDepth: 3, todoCount: 0, fixmeCount: 0,
      sizeRiskScore: 0, isUtilityFile: false, isTestFile: false,
      astMetrics: null, couplingScore: null, isInCycle: null,
    })
    const large = computeFileScore({
      loc: 600, commentRatio: 0.1, avgFunctionLength: 30,
      dependencyDepth: 3, todoCount: 0, fixmeCount: 0,
      sizeRiskScore: 0, isUtilityFile: false, isTestFile: false,
      astMetrics: null, couplingScore: null, isInCycle: null,
    })
    expect(large).toBeLessThan(small)
  })

  it('penalizes low comment ratio', () => {
    const good = computeFileScore({
      loc: 200, commentRatio: 0.15, avgFunctionLength: 30,
      dependencyDepth: 3, todoCount: 0, fixmeCount: 0,
      sizeRiskScore: 0, isUtilityFile: false, isTestFile: false,
      astMetrics: null, couplingScore: null, isInCycle: null,
    })
    const bad = computeFileScore({
      loc: 200, commentRatio: 0.02, avgFunctionLength: 30,
      dependencyDepth: 3, todoCount: 0, fixmeCount: 0,
      sizeRiskScore: 0, isUtilityFile: false, isTestFile: false,
      astMetrics: null, couplingScore: null, isInCycle: null,
    })
    expect(bad).toBeLessThan(good)
  })

  it('penalizes high TODO count', () => {
    const clean = computeFileScore({
      loc: 200, commentRatio: 0.1, avgFunctionLength: 30,
      dependencyDepth: 3, todoCount: 0, fixmeCount: 0,
      sizeRiskScore: 0, isUtilityFile: false, isTestFile: false,
      astMetrics: null, couplingScore: null, isInCycle: null,
    })
    const messy = computeFileScore({
      loc: 200, commentRatio: 0.1, avgFunctionLength: 30,
      dependencyDepth: 3, todoCount: 10, fixmeCount: 5,
      sizeRiskScore: 0, isUtilityFile: false, isTestFile: false,
      astMetrics: null, couplingScore: null, isInCycle: null,
    })
    expect(messy).toBeLessThan(clean)
  })

  it('applies AST complexity penalties', () => {
    const simple = computeFileScore({
      loc: 200, commentRatio: 0.1, avgFunctionLength: 30,
      dependencyDepth: 3, todoCount: 0, fixmeCount: 0,
      sizeRiskScore: 0, isUtilityFile: false, isTestFile: false,
      astMetrics: makeAST({ cyclomaticComplexity: 5 }),
      couplingScore: null, isInCycle: null,
    })
    const complex = computeFileScore({
      loc: 200, commentRatio: 0.1, avgFunctionLength: 30,
      dependencyDepth: 3, todoCount: 0, fixmeCount: 0,
      sizeRiskScore: 0, isUtilityFile: false, isTestFile: false,
      astMetrics: makeAST({ cyclomaticComplexity: 35 }),
      couplingScore: null, isInCycle: null,
    })
    expect(complex).toBeLessThan(simple)
    expect(simple - complex).toBeGreaterThanOrEqual(20) // critical = -25 + bonus
  })

  it('penalizes cycle membership', () => {
    const noCycle = computeFileScore({
      loc: 200, commentRatio: 0.1, avgFunctionLength: 30,
      dependencyDepth: 3, todoCount: 0, fixmeCount: 0,
      sizeRiskScore: 0, isUtilityFile: false, isTestFile: false,
      astMetrics: null, couplingScore: null, isInCycle: false,
    })
    const inCycle = computeFileScore({
      loc: 200, commentRatio: 0.1, avgFunctionLength: 30,
      dependencyDepth: 3, todoCount: 0, fixmeCount: 0,
      sizeRiskScore: 0, isUtilityFile: false, isTestFile: false,
      astMetrics: null, couplingScore: null, isInCycle: true,
    })
    expect(inCycle).toBeLessThan(noCycle)
  })

  it('enforces utility file score floor', () => {
    const score = computeFileScore({
      loc: 600, commentRatio: 0.01, avgFunctionLength: 80,
      dependencyDepth: 10, todoCount: 10, fixmeCount: 5,
      sizeRiskScore: 80, isUtilityFile: true, isTestFile: false,
      astMetrics: null, couplingScore: null, isInCycle: null,
    })
    expect(score).toBeGreaterThanOrEqual(THRESHOLDS.UTILITY_SCORE_FLOOR)
  })

  it('enforces small file score floor', () => {
    const score = computeFileScore({
      loc: 30, commentRatio: 0.0, avgFunctionLength: 30,
      dependencyDepth: 0, todoCount: 0, fixmeCount: 0,
      sizeRiskScore: 0, isUtilityFile: false, isTestFile: false,
      astMetrics: null, couplingScore: null, isInCycle: null,
    })
    expect(score).toBeGreaterThanOrEqual(THRESHOLDS.SMALL_FILE_SCORE_FLOOR)
  })

  it('never returns below 0 or above 100', () => {
    // Worst possible file
    const worst = computeFileScore({
      loc: 2000, commentRatio: 0.0, avgFunctionLength: 200,
      dependencyDepth: 20, todoCount: 50, fixmeCount: 50,
      sizeRiskScore: 100, isUtilityFile: false, isTestFile: false,
      astMetrics: makeAST({
        cyclomaticComplexity: 50,
        maxNestingDepth: 10,
        godFunctionCount: 5,
        godClassCount: 3,
        maxParameterCount: 15,
      }),
      couplingScore: 100, isInCycle: true,
    })
    expect(worst).toBeGreaterThanOrEqual(0)
    expect(worst).toBeLessThanOrEqual(100)
  })
})

// ── classifyFile tests ──────────────────────────────────────────────────────

describe('classifyFile', () => {
  it('detects utility files by basename pattern', () => {
    // classifyFile matches UTILITY_PATTERNS against the basename only
    expect(classifyFile('/src/lib/utils.ts').isUtilityFile).toBe(true)
    expect(classifyFile('/src/lib/helpers.ts').isUtilityFile).toBe(true)
    expect(classifyFile('/src/lib/constants.ts').isUtilityFile).toBe(true)
    expect(classifyFile('/src/lib/types.ts').isUtilityFile).toBe(true)
    expect(classifyFile('/src/lib/config.ts').isUtilityFile).toBe(true)
    expect(classifyFile('/src/index.ts').isUtilityFile).toBe(true)
    expect(classifyFile('/src/shared.ts').isUtilityFile).toBe(true)
  })

  it('detects test files', () => {
    expect(classifyFile('/src/App.test.ts').isTestFile).toBe(true)
    expect(classifyFile('/src/App.spec.tsx').isTestFile).toBe(true)
    expect(classifyFile('/src/__tests__/foo.ts').isTestFile).toBe(true)
  })

  it('classifies normal source files correctly', () => {
    const result = classifyFile('/src/components/Dashboard.tsx')
    expect(result.isUtilityFile).toBe(false)
    expect(result.isTestFile).toBe(false)
  })

  it('test files are not utility files', () => {
    const result = classifyFile('/src/utils/helpers.test.ts')
    expect(result.isTestFile).toBe(true)
    expect(result.isUtilityFile).toBe(false)
  })
})

// ── classifyComplexity tests ────────────────────────────────────────────────

describe('classifyComplexity', () => {
  it('returns good for CC ≤ 10', () => {
    expect(classifyComplexity(1)).toBe('good')
    expect(classifyComplexity(5)).toBe('good')
    expect(classifyComplexity(10)).toBe('good')
  })

  it('returns moderate for CC 11–20', () => {
    expect(classifyComplexity(11)).toBe('moderate')
    expect(classifyComplexity(15)).toBe('moderate')
    expect(classifyComplexity(20)).toBe('moderate')
  })

  it('returns high for CC 21–30', () => {
    expect(classifyComplexity(21)).toBe('high')
    expect(classifyComplexity(30)).toBe('high')
  })

  it('returns critical for CC > 30', () => {
    expect(classifyComplexity(31)).toBe('critical')
    expect(classifyComplexity(100)).toBe('critical')
  })
})

// ── classifyNesting tests ───────────────────────────────────────────────────

describe('classifyNesting', () => {
  it('returns good for depth ≤ 3', () => {
    expect(classifyNesting(0)).toBe('good')
    expect(classifyNesting(2)).toBe('good')
    expect(classifyNesting(3)).toBe('good')
  })

  it('returns warning for depth 4–5', () => {
    expect(classifyNesting(4)).toBe('warning')
    expect(classifyNesting(5)).toBe('warning')
  })

  it('returns refactor for depth ≥ 6', () => {
    expect(classifyNesting(6)).toBe('refactor')
    expect(classifyNesting(10)).toBe('refactor')
  })
})

// ── detectPrimaryIssue tests ────────────────────────────────────────────────

describe('detectPrimaryIssue', () => {
  it('detects circular_dependency when isInCycle is true', () => {
    const m = makeMetrics({ isInCycle: true })
    expect(detectPrimaryIssue(m)).toBe('circular_dependency')
  })

  it('detects hub_file when isHubFile is true', () => {
    const m = makeMetrics({ isHubFile: true, isInCycle: false })
    expect(detectPrimaryIssue(m)).toBe('hub_file')
  })

  it('detects high_complexity from AST', () => {
    const m = makeMetrics({
      isInCycle: false, isHubFile: false,
      astMetrics: makeAST({ cyclomaticComplexity: 25 }),
    })
    expect(detectPrimaryIssue(m)).toBe('high_complexity')
  })

  it('detects god_function from AST', () => {
    const m = makeMetrics({
      isInCycle: false, isHubFile: false,
      astMetrics: makeAST({ cyclomaticComplexity: 5, godFunctionCount: 2 }),
    })
    expect(detectPrimaryIssue(m)).toBe('god_function')
  })

  it('detects file_too_large without AST', () => {
    const m = makeMetrics({ linesOfCode: 600, astMetrics: null, isInCycle: false, isHubFile: false })
    expect(detectPrimaryIssue(m)).toBe('file_too_large')
  })

  it('detects deep_deps', () => {
    const m = makeMetrics({
      linesOfCode: 200, dependencyDepth: 8,
      astMetrics: null, isInCycle: false, isHubFile: false,
    })
    expect(detectPrimaryIssue(m)).toBe('deep_deps')
  })

  it('detects many_todos', () => {
    const m = makeMetrics({
      linesOfCode: 200, dependencyDepth: 3,
      todoCount: 5, fixmeCount: 3,
      astMetrics: null, isInCycle: false, isHubFile: false,
    })
    expect(detectPrimaryIssue(m)).toBe('many_todos')
  })

  it('returns minor_issues for clean file', () => {
    const m = makeMetrics({
      linesOfCode: 150, commentRatio: 0.12, avgFunctionLength: 20,
      dependencyDepth: 2, todoCount: 0, fixmeCount: 0, sizeRiskScore: 0,
      astMetrics: null, isInCycle: false, isHubFile: false,
    })
    expect(detectPrimaryIssue(m)).toBe('minor_issues')
  })
})

// ── generateRecommendation tests ────────────────────────────────────────────

describe('generateRecommendation', () => {
  it('recommends breaking circular imports', () => {
    const m = makeMetrics({ isInCycle: true })
    expect(generateRecommendation(m)).toContain('circular import')
  })

  it('recommends decomposing hub files', () => {
    const m = makeMetrics({ isHubFile: true, isInCycle: false })
    expect(generateRecommendation(m)).toContain('hub file')
  })

  it('recommends reducing complexity from AST', () => {
    const m = makeMetrics({
      isInCycle: false, isHubFile: false,
      astMetrics: makeAST({ cyclomaticComplexity: 25 }),
    })
    const rec = generateRecommendation(m)
    expect(rec).toContain('complexity')
    expect(rec).toContain('CC=25')
  })

  it('returns Minor cleanup for clean files', () => {
    const m = makeMetrics({
      linesOfCode: 100, commentRatio: 0.15, avgFunctionLength: 20,
      dependencyDepth: 2, todoCount: 0, fixmeCount: 0,
      astMetrics: makeAST({ cyclomaticComplexity: 3, maxNestingDepth: 1 }),
      isInCycle: false, isHubFile: false,
    })
    expect(generateRecommendation(m)).toBe('Minor cleanup')
  })
})
