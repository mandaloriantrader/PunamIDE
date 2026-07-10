/**
 * Unit tests for DependencyGraphEngine — graph building, path reconciliation, edge tracking.
 */

import { describe, it, expect } from 'vitest'
import { DependencyGraphEngine } from '../../services/technicalDebt/DependencyGraphEngine'
import type { FileImportExportMap } from '../../services/technicalDebt/ImportExtractor'

function makeImportMap(overrides: Partial<FileImportExportMap> = {}): FileImportExportMap {
  return {
    filePath: '/src/a.ts',
    imports: [],
    exports: [],
    externalDeps: [],
    ...overrides,
  }
}

describe('DependencyGraphEngine', () => {
  const engine = new DependencyGraphEngine()

  describe('build — basic graph construction', () => {
    it('creates nodes for all known file paths', () => {
      const knownFiles = ['/src/a.ts', '/src/b.ts', '/src/c.ts']
      const graph = engine.build([], knownFiles)

      expect(graph.nodes.size).toBe(3)
      expect(graph.nodes.has('/src/a.ts')).toBe(true)
      expect(graph.nodes.has('/src/b.ts')).toBe(true)
      expect(graph.nodes.has('/src/c.ts')).toBe(true)
    })

    it('creates directed edges from imports', () => {
      const knownFiles = ['/src/a.ts', '/src/b.ts']
      const importMaps: FileImportExportMap[] = [
        makeImportMap({
          filePath: '/src/a.ts',
          imports: [{
            fromFile: '/src/a.ts',
            rawSpecifier: './b',
            resolvedPath: '/src/b.ts',
            isExternal: false,
            kind: 'static',
            importedNames: ['foo'],
            line: 1,
          }],
        }),
        makeImportMap({ filePath: '/src/b.ts' }),
      ]

      const graph = engine.build(importMaps, knownFiles)

      expect(graph.edges).toHaveLength(1)
      expect(graph.edges[0]).toEqual(['/src/a.ts', '/src/b.ts'])
      expect(graph.nodes.get('/src/a.ts')!.imports).toContain('/src/b.ts')
      expect(graph.nodes.get('/src/b.ts')!.importedBy).toContain('/src/a.ts')
    })

    it('computes fan-in and fan-out', () => {
      const knownFiles = ['/src/a.ts', '/src/b.ts', '/src/c.ts']
      const importMaps: FileImportExportMap[] = [
        makeImportMap({
          filePath: '/src/a.ts',
          imports: [
            { fromFile: '/src/a.ts', rawSpecifier: './b', resolvedPath: '/src/b.ts', isExternal: false, kind: 'static', importedNames: [], line: 1 },
            { fromFile: '/src/a.ts', rawSpecifier: './c', resolvedPath: '/src/c.ts', isExternal: false, kind: 'static', importedNames: [], line: 2 },
          ],
        }),
        makeImportMap({
          filePath: '/src/c.ts',
          imports: [
            { fromFile: '/src/c.ts', rawSpecifier: './b', resolvedPath: '/src/b.ts', isExternal: false, kind: 'static', importedNames: [], line: 1 },
          ],
        }),
        makeImportMap({ filePath: '/src/b.ts' }),
      ]

      const graph = engine.build(importMaps, knownFiles)

      // a imports b and c → fan-out = 2
      expect(graph.nodes.get('/src/a.ts')!.fanOut).toBe(2)
      // b is imported by a and c → fan-in = 2
      expect(graph.nodes.get('/src/b.ts')!.fanIn).toBe(2)
      // c is imported by a → fan-in = 1
      expect(graph.nodes.get('/src/c.ts')!.fanIn).toBe(1)
    })

    it('skips external dependencies in edge list', () => {
      const knownFiles = ['/src/a.ts']
      const importMaps: FileImportExportMap[] = [
        makeImportMap({
          filePath: '/src/a.ts',
          imports: [
            { fromFile: '/src/a.ts', rawSpecifier: 'react', resolvedPath: null, isExternal: true, kind: 'static', importedNames: ['useState'], line: 1 },
          ],
          externalDeps: ['react'],
        }),
      ]

      const graph = engine.build(importMaps, knownFiles)

      expect(graph.edges).toHaveLength(0)
      expect(graph.nodes.get('/src/a.ts')!.externalDeps).toContain('react')
    })

    it('skips self-imports', () => {
      const knownFiles = ['/src/a.ts']
      const importMaps: FileImportExportMap[] = [
        makeImportMap({
          filePath: '/src/a.ts',
          imports: [
            { fromFile: '/src/a.ts', rawSpecifier: './a', resolvedPath: '/src/a.ts', isExternal: false, kind: 'static', importedNames: [], line: 1 },
          ],
        }),
      ]

      const graph = engine.build(importMaps, knownFiles)
      expect(graph.edges).toHaveLength(0)
      expect(graph.nodes.get('/src/a.ts')!.fanOut).toBe(0)
    })

    it('tracks unresolved imports', () => {
      const knownFiles = ['/src/a.ts']
      const importMaps: FileImportExportMap[] = [
        makeImportMap({
          filePath: '/src/a.ts',
          imports: [
            { fromFile: '/src/a.ts', rawSpecifier: './missing', resolvedPath: '/src/missing.ts', isExternal: false, kind: 'static', importedNames: [], line: 1 },
          ],
        }),
      ]

      const graph = engine.build(importMaps, knownFiles)
      expect(graph.unresolvedImports).toHaveLength(1)
      expect(graph.unresolvedImports[0].fromFile).toBe('/src/a.ts')
      expect(graph.unresolvedImports[0].rawSpecifier).toBe('./missing')
    })

    it('deduplicates edges for same target', () => {
      const knownFiles = ['/src/a.ts', '/src/b.ts']
      const importMaps: FileImportExportMap[] = [
        makeImportMap({
          filePath: '/src/a.ts',
          imports: [
            { fromFile: '/src/a.ts', rawSpecifier: './b', resolvedPath: '/src/b.ts', isExternal: false, kind: 'static', importedNames: ['x'], line: 1 },
            { fromFile: '/src/a.ts', rawSpecifier: './b', resolvedPath: '/src/b.ts', isExternal: false, kind: 'static', importedNames: ['y'], line: 2 },
          ],
        }),
        makeImportMap({ filePath: '/src/b.ts' }),
      ]

      const graph = engine.build(importMaps, knownFiles)
      // Should be one edge, not two
      expect(graph.nodes.get('/src/a.ts')!.imports).toHaveLength(1)
      expect(graph.edges).toHaveLength(1)
    })
  })

  describe('build — path reconciliation', () => {
    it('reconciles .ts to .tsx extension', () => {
      const knownFiles = ['/src/a.ts', '/src/Component.tsx']
      const importMaps: FileImportExportMap[] = [
        makeImportMap({
          filePath: '/src/a.ts',
          imports: [
            { fromFile: '/src/a.ts', rawSpecifier: './Component', resolvedPath: '/src/Component.ts', isExternal: false, kind: 'static', importedNames: [], line: 1 },
          ],
        }),
        makeImportMap({ filePath: '/src/Component.tsx' }),
      ]

      const graph = engine.build(importMaps, knownFiles)
      expect(graph.nodes.get('/src/a.ts')!.imports).toContain('/src/Component.tsx')
      expect(graph.unresolvedImports).toHaveLength(0)
    })

    it('reconciles directory to index.ts', () => {
      const knownFiles = ['/src/a.ts', '/src/utils/index.ts']
      const importMaps: FileImportExportMap[] = [
        makeImportMap({
          filePath: '/src/a.ts',
          imports: [
            { fromFile: '/src/a.ts', rawSpecifier: './utils', resolvedPath: '/src/utils.ts', isExternal: false, kind: 'static', importedNames: [], line: 1 },
          ],
        }),
        makeImportMap({ filePath: '/src/utils/index.ts' }),
      ]

      const graph = engine.build(importMaps, knownFiles)
      expect(graph.nodes.get('/src/a.ts')!.imports).toContain('/src/utils/index.ts')
    })
  })

  describe('build — empty/edge cases', () => {
    it('handles empty file list', () => {
      const graph = engine.build([], [])
      expect(graph.nodes.size).toBe(0)
      expect(graph.edges).toHaveLength(0)
      expect(graph.totalEdges).toBe(0)
    })

    it('handles files with no imports', () => {
      const knownFiles = ['/src/a.ts', '/src/b.ts']
      const importMaps: FileImportExportMap[] = [
        makeImportMap({ filePath: '/src/a.ts' }),
        makeImportMap({ filePath: '/src/b.ts' }),
      ]

      const graph = engine.build(importMaps, knownFiles)
      expect(graph.edges).toHaveLength(0)
      expect(graph.nodes.get('/src/a.ts')!.fanOut).toBe(0)
      expect(graph.nodes.get('/src/a.ts')!.fanIn).toBe(0)
    })
  })
})
