/**
 * Unit tests for IncrementalGraphEngine — incremental graph rebuild logic.
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { IncrementalGraphEngine } from '../../services/technicalDebt/IncrementalGraphEngine'
import type { FileImportExportMap } from '../../services/technicalDebt/ImportExtractor'

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeImportMap(
  filePath: string,
  imports: { resolvedPath: string }[] = [],
  exports: { name: string }[] = [],
  externalDeps: string[] = [],
): FileImportExportMap {
  return {
    filePath,
    imports: imports.map((i, idx) => ({
      fromFile: filePath,
      rawSpecifier: i.resolvedPath.split('/').pop()!,
      resolvedPath: i.resolvedPath,
      isExternal: false,
      kind: 'static' as const,
      importedNames: [],
      line: idx + 1,
    })),
    exports: exports.map((e, idx) => ({
      name: e.name,
      isDefault: e.name === 'default',
      isReexport: false,
      reexportSource: null,
      line: idx + 1,
    })),
    externalDeps,
  }
}

describe('IncrementalGraphEngine', () => {
  let engine: IncrementalGraphEngine

  beforeEach(() => {
    engine = new IncrementalGraphEngine()
  })

  describe('first run — full build', () => {
    it('performs full build on first call', () => {
      const maps = [
        makeImportMap('/a.ts', [{ resolvedPath: '/b.ts' }]),
        makeImportMap('/b.ts'),
      ]
      const result = engine.buildIncremental(maps, ['/a.ts', '/b.ts'])

      expect(result.wasIncremental).toBe(false)
      expect(result.stats.rebuildReason).toBe('first-run')
      expect(result.graph.nodes.size).toBe(2)
      expect(result.graph.edges).toHaveLength(1)
    })

    it('hasBaseline is false before first build', () => {
      expect(engine.hasBaseline).toBe(false)
    })

    it('hasBaseline is true after first build', () => {
      engine.buildIncremental(
        [makeImportMap('/a.ts')],
        ['/a.ts'],
      )
      expect(engine.hasBaseline).toBe(true)
    })
  })

  describe('no changes — returns cached graph', () => {
    it('returns previous graph when nothing changed', () => {
      const maps = [
        makeImportMap('/a.ts', [{ resolvedPath: '/b.ts' }]),
        makeImportMap('/b.ts'),
      ]

      // First build
      const first = engine.buildIncremental(maps, ['/a.ts', '/b.ts'])
      expect(first.wasIncremental).toBe(false)

      // Same input — should be incremental with 0 changes
      const second = engine.buildIncremental(maps, ['/a.ts', '/b.ts'])
      expect(second.wasIncremental).toBe(true)
      expect(second.changedFiles).toHaveLength(0)
      expect(second.stats.unchangedFiles).toBe(2)
      expect(second.stats.changedFiles).toBe(0)
      expect(second.stats.rebuildReason).toBe('incremental')
    })

    it('graph structure is preserved', () => {
      const maps = [
        makeImportMap('/a.ts', [{ resolvedPath: '/b.ts' }]),
        makeImportMap('/b.ts', [{ resolvedPath: '/c.ts' }]),
        makeImportMap('/c.ts'),
      ]
      const paths = ['/a.ts', '/b.ts', '/c.ts']

      engine.buildIncremental(maps, paths)
      const second = engine.buildIncremental(maps, paths)

      expect(second.graph.nodes.size).toBe(3)
      expect(second.graph.edges).toHaveLength(2)
      expect(second.graph.nodes.get('/a.ts')!.imports).toContain('/b.ts')
      expect(second.graph.nodes.get('/b.ts')!.imports).toContain('/c.ts')
    })
  })

  describe('incremental patch — few files changed', () => {
    it('detects changed file and rebuilds only its edges', () => {
      const maps1 = [
        makeImportMap('/a.ts', [{ resolvedPath: '/b.ts' }]),
        makeImportMap('/b.ts'),
        makeImportMap('/c.ts'),
      ]
      const paths = ['/a.ts', '/b.ts', '/c.ts']

      engine.buildIncremental(maps1, paths)

      // Change /a.ts to now import /c.ts instead of /b.ts
      const maps2 = [
        makeImportMap('/a.ts', [{ resolvedPath: '/c.ts' }]),
        makeImportMap('/b.ts'),
        makeImportMap('/c.ts'),
      ]

      const result = engine.buildIncremental(maps2, paths)
      expect(result.wasIncremental).toBe(true)
      expect(result.changedFiles).toContain('/a.ts')
      expect(result.stats.changedFiles).toBe(1)

      // Verify the graph reflects the new edge
      expect(result.graph.nodes.get('/a.ts')!.imports).toContain('/c.ts')
      expect(result.graph.nodes.get('/a.ts')!.imports).not.toContain('/b.ts')
    })

    it('handles added files incrementally', () => {
      const maps1 = [
        makeImportMap('/a.ts', [{ resolvedPath: '/b.ts' }]),
        makeImportMap('/b.ts'),
      ]
      engine.buildIncremental(maps1, ['/a.ts', '/b.ts'])

      // Add /c.ts
      const maps2 = [
        makeImportMap('/a.ts', [{ resolvedPath: '/b.ts' }]),
        makeImportMap('/b.ts'),
        makeImportMap('/c.ts', [{ resolvedPath: '/a.ts' }]),
      ]
      const result = engine.buildIncremental(maps2, ['/a.ts', '/b.ts', '/c.ts'])

      expect(result.wasIncremental).toBe(true)
      expect(result.stats.addedFiles).toBe(1)
      expect(result.graph.nodes.has('/c.ts')).toBe(true)
      expect(result.graph.nodes.get('/c.ts')!.imports).toContain('/a.ts')
    })

    it('handles removed files incrementally', () => {
      const maps1 = [
        makeImportMap('/a.ts', [{ resolvedPath: '/b.ts' }]),
        makeImportMap('/b.ts', [{ resolvedPath: '/c.ts' }]),
        makeImportMap('/c.ts'),
      ]
      engine.buildIncremental(maps1, ['/a.ts', '/b.ts', '/c.ts'])

      // Remove /c.ts
      const maps2 = [
        makeImportMap('/a.ts', [{ resolvedPath: '/b.ts' }]),
        makeImportMap('/b.ts'),
      ]
      const result = engine.buildIncremental(maps2, ['/a.ts', '/b.ts'])

      expect(result.wasIncremental).toBe(true)
      expect(result.stats.removedFiles).toBe(1)
      expect(result.graph.nodes.has('/c.ts')).toBe(false)
    })
  })

  describe('threshold exceeded — full rebuild', () => {
    it('triggers full rebuild when >10% of files change AND >5 absolute', () => {
      // 20 files — need >2 changed (>10%) AND >5 absolute to trigger
      const paths = Array.from({ length: 20 }, (_, i) => `/${i}.ts`)
      const maps1 = paths.map(p => makeImportMap(p))
      engine.buildIncremental(maps1, paths)

      // Change 6 files (30% > threshold, 6 > 5 absolute minimum)
      const maps2 = [
        ...Array.from({ length: 6 }, (_, i) =>
          makeImportMap(`/${i}.ts`, [{ resolvedPath: `/${i + 10}.ts` }])
        ),
        ...paths.slice(6).map(p => makeImportMap(p)),
      ]

      const result = engine.buildIncremental(maps2, paths)
      expect(result.wasIncremental).toBe(false)
      expect(result.stats.rebuildReason).toBe('threshold-exceeded')
    })

    it('stays incremental when changes exceed % but not absolute minimum', () => {
      // 3 files, 1 change = 33% but only 1 absolute (< 5)
      const paths = ['/a.ts', '/b.ts', '/c.ts']
      const maps1 = paths.map(p => makeImportMap(p))
      engine.buildIncremental(maps1, paths)

      // Change 1 file
      const maps2 = [
        makeImportMap('/a.ts', [{ resolvedPath: '/b.ts' }]),
        makeImportMap('/b.ts'),
        makeImportMap('/c.ts'),
      ]
      const result = engine.buildIncremental(maps2, paths)
      expect(result.wasIncremental).toBe(true)
    })
  })

  describe('reset', () => {
    it('forces full rebuild on next call', () => {
      const maps = [makeImportMap('/a.ts')]
      engine.buildIncremental(maps, ['/a.ts'])
      expect(engine.hasBaseline).toBe(true)

      engine.reset()
      expect(engine.hasBaseline).toBe(false)

      const result = engine.buildIncremental(maps, ['/a.ts'])
      expect(result.wasIncremental).toBe(false)
      expect(result.stats.rebuildReason).toBe('first-run')
    })
  })
})
