/**
 * ASTEngine.ts — Phase 2
 *
 * Singleton that owns all Tree-sitter state:
 *  - Loads the core Tree-sitter WASM once
 *  - Lazily loads per-language grammars on first use
 *  - Exposes a single parse() method used by ASTMetricsExtractor
 *
 * Supported languages (Phase 2): TypeScript, TSX, JavaScript, JSX
 * Phase 3 additions: Python, Rust, Go — add grammar imports + LANG_MAP entries
 *
 * WASM loading strategy:
 *  - ?url imports let Vite hash and emit WASM files as static assets
 *  - Parser.init({ locateFile }) explicitly points Tree-sitter at the
 *    correct hashed URL — required inside module Workers and Tauri's
 *    asset serving context
 *
 * Usage:
 *   const engine = getASTEngine();
 *   const tree = await engine.parse(fileContent, 'typescript');
 *   // tree is a Tree-sitter Tree — pass to ASTMetricsExtractor
 *
 * Error contract:
 *   parse() returns null on any failure (missing grammar, parse error, etc.)
 *   Callers must handle null and fall back to regex-based metrics.
 */

// These imports resolve after:  npm install web-tree-sitter tree-sitter-typescript tree-sitter-javascript
import Parser from 'web-tree-sitter'
import treeSitterWasmUrl      from 'web-tree-sitter/tree-sitter.wasm?url'
import tsGrammarUrl           from 'tree-sitter-typescript/tree-sitter-typescript.wasm?url'
import tsxGrammarUrl          from 'tree-sitter-typescript/tree-sitter-tsx.wasm?url'
import jsGrammarUrl           from 'tree-sitter-javascript/tree-sitter-javascript.wasm?url'

// ── Types ──────────────────────────────────────────────────────────────────────

export type SupportedLanguage = 'typescript' | 'tsx' | 'javascript' | 'jsx'

// Tree type re-exported so consumers don't import from web-tree-sitter directly
export type { Tree, SyntaxNode } from 'web-tree-sitter'

// ── Language detection ─────────────────────────────────────────────────────────

/**
 * Map a file extension to a SupportedLanguage.
 * Returns null for unsupported extensions — caller should skip AST analysis.
 */
export function extensionToLanguage(filePath: string): SupportedLanguage | null {
  const ext = filePath.split('.').pop()?.toLowerCase() ?? ''
  switch (ext) {
    case 'ts':  return 'typescript'
    case 'tsx': return 'tsx'
    case 'js':  return 'javascript'
    case 'jsx': return 'jsx'
    default:    return null
  }
}

// ── Grammar URL map ────────────────────────────────────────────────────────────

// Maps each language to its WASM grammar URL (resolved by Vite ?url import).
// JSX uses the JavaScript grammar — Tree-sitter's JS grammar handles JSX syntax.
const GRAMMAR_URL: Record<SupportedLanguage, string> = {
  typescript: tsGrammarUrl,
  tsx:        tsxGrammarUrl,
  javascript: jsGrammarUrl,
  jsx:        jsGrammarUrl,   // same grammar as JS
}

// ── ASTEngine ──────────────────────────────────────────────────────────────────

class ASTEngine {
  private coreReady: Promise<void> | null = null
  private parsers = new Map<SupportedLanguage, Parser>()
  private grammarLoading = new Map<SupportedLanguage, Promise<void>>()

  // ── Core init ────────────────────────────────────────────────────────────────

  /**
   * Initialize the Tree-sitter core WASM.
   * Called lazily on first parse() — idempotent.
   */
  private initCore(): Promise<void> {
    if (!this.coreReady) {
      this.coreReady = Parser.init({
        // locateFile is Tree-sitter's hook for resolving the core WASM path.
        // We return the Vite-hashed URL directly — no path guessing needed.
        locateFile: (_path: string, _prefix: string) => treeSitterWasmUrl,
      })
    }
    return this.coreReady
  }

  // ── Grammar loading ──────────────────────────────────────────────────────────

  /**
   * Load a language grammar. Idempotent — concurrent calls for the same
   * language will all await the same promise.
   */
  private async loadGrammar(language: SupportedLanguage): Promise<void> {
    // Already loaded
    if (this.parsers.has(language)) return

    // Already loading — join the existing promise
    if (this.grammarLoading.has(language)) {
      return this.grammarLoading.get(language)!
    }

    const loading = (async () => {
      await this.initCore()

      const grammarUrl = GRAMMAR_URL[language]
      const lang = await Parser.Language.load(grammarUrl)

      const parser = new Parser()
      parser.setLanguage(lang)

      // For JSX, store under both 'jsx' and reuse JS parser
      this.parsers.set(language, parser)
    })()

    this.grammarLoading.set(language, loading)

    try {
      await loading
    } finally {
      // Remove loading promise whether it succeeded or failed
      // so a retry on failure creates a fresh promise
      this.grammarLoading.delete(language)
    }
  }

  // ── Public API ────────────────────────────────────────────────────────────────

  /**
   * Parse file content and return a Tree-sitter Tree.
   *
   * Returns null if:
   *  - Language is unsupported
   *  - WASM fails to load (network, CSP, or Tauri asset serving issue)
   *  - Tree-sitter parse error
   *
   * Callers (ASTMetricsExtractor, Worker) must handle null gracefully
   * and fall back to regex-based analysis.
   */
  async parse(
    content: string,
    language: SupportedLanguage,
  ): Promise<Parser.Tree | null> {
    try {
      await this.loadGrammar(language)
      const parser = this.parsers.get(language)
      if (!parser) return null

      return parser.parse(content) ?? null
    } catch {
      // WASM load failure, parse error, memory pressure — degrade silently
      return null
    }
  }

  /**
   * Convenience: detect language from file path and parse.
   * Returns null for unsupported extensions.
   */
  async parseFile(
    content: string,
    filePath: string,
  ): Promise<Parser.Tree | null> {
    const language = extensionToLanguage(filePath)
    if (!language) return null
    return this.parse(content, language)
  }

  /**
   * Whether a given language grammar is already loaded (no async needed).
   * Used by the worker to skip await on warm cache hits.
   */
  isReady(language: SupportedLanguage): boolean {
    return this.parsers.has(language)
  }

  /**
   * Preload all supported grammars eagerly.
   * Call this once on IDE startup to warm the cache before analysis runs.
   * Non-blocking — returns a promise that resolves when all grammars are ready.
   */
  async preload(): Promise<void> {
    const languages: SupportedLanguage[] = ['typescript', 'tsx', 'javascript', 'jsx']
    await Promise.allSettled(languages.map((l) => this.loadGrammar(l)))
  }
}

// ── Singleton ──────────────────────────────────────────────────────────────────

let instance: ASTEngine | null = null

export function getASTEngine(): ASTEngine {
  if (!instance) instance = new ASTEngine()
  return instance
}
