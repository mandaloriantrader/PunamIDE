/**
 * Unit tests for ImportExtractor — path resolution logic.
 * Tests the pure resolveImportPath function (no Tree-sitter required).
 */

import { describe, it, expect } from 'vitest'
import { resolveImportPath } from '../../services/technicalDebt/ImportExtractor'

describe('resolveImportPath', () => {
  describe('external packages', () => {
    it('classifies bare specifiers as external', () => {
      const result = resolveImportPath('/src/app.ts', 'react')
      expect(result.isExternal).toBe(true)
      expect(result.resolvedPath).toBeNull()
    })

    it('classifies scoped packages as external', () => {
      const result = resolveImportPath('/src/app.ts', '@tauri-apps/api')
      expect(result.isExternal).toBe(true)
      expect(result.resolvedPath).toBeNull()
    })

    it('classifies deep package paths as external', () => {
      const result = resolveImportPath('/src/app.ts', 'lodash/debounce')
      expect(result.isExternal).toBe(true)
      expect(result.resolvedPath).toBeNull()
    })
  })

  describe('relative imports', () => {
    it('resolves sibling file import', () => {
      const result = resolveImportPath('/src/components/App.ts', './Button')
      expect(result.isExternal).toBe(false)
      expect(result.resolvedPath).toBe('/src/components/Button.ts')
    })

    it('resolves parent directory import', () => {
      const result = resolveImportPath('/src/components/App.ts', '../utils/hash')
      expect(result.isExternal).toBe(false)
      expect(result.resolvedPath).toBe('/src/utils/hash.ts')
    })

    it('resolves deep relative import', () => {
      const result = resolveImportPath('/src/a/b/c/deep.ts', '../../shared/types')
      expect(result.isExternal).toBe(false)
      expect(result.resolvedPath).toBe('/src/a/shared/types.ts')
    })

    it('preserves existing extension', () => {
      const result = resolveImportPath('/src/app.ts', './styles.css')
      expect(result.isExternal).toBe(false)
      expect(result.resolvedPath).toBe('/src/styles.css')
    })

    it('preserves .tsx extension', () => {
      const result = resolveImportPath('/src/app.ts', './Component.tsx')
      expect(result.isExternal).toBe(false)
      expect(result.resolvedPath).toBe('/src/Component.tsx')
    })

    it('adds .ts extension when no extension given', () => {
      const result = resolveImportPath('/src/app.ts', './utils')
      expect(result.isExternal).toBe(false)
      expect(result.resolvedPath).toContain('/src/utils')
      expect(result.resolvedPath).toMatch(/\.ts$/)
    })
  })

  describe('absolute imports', () => {
    it('resolves absolute path starting with /', () => {
      const result = resolveImportPath('/src/app.ts', '/lib/shared')
      expect(result.isExternal).toBe(false)
      expect(result.resolvedPath).toBe('/lib/shared.ts')
    })
  })

  describe('path normalization', () => {
    it('normalizes backslashes to forward slashes', () => {
      const result = resolveImportPath('C:\\src\\app.ts', './utils')
      expect(result.isExternal).toBe(false)
      expect(result.resolvedPath).not.toContain('\\')
    })

    it('resolves ../ segments correctly', () => {
      const result = resolveImportPath('/src/a/b/c.ts', '../../x')
      expect(result.isExternal).toBe(false)
      expect(result.resolvedPath).toBe('/src/x.ts')
    })

    it('resolves ./ segments correctly', () => {
      const result = resolveImportPath('/src/app.ts', '././nested')
      expect(result.isExternal).toBe(false)
      // Should normalize away the double ./
      expect(result.resolvedPath).toContain('nested')
    })
  })
})
