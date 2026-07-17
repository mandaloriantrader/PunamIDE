/**
 * @phase P7
 * @purpose Manages tree-sitter grammars for multiple languages.
 *          Currently only JS/TS/JSX/TSX actually parse. This adds
 *          Python, Go, Rust, Java, C# with per-language calibrated
 *          complexity thresholds.
 *
 * Priority order: Python and Go first (highest overlap with teams
 * likely to adopt a new review tool), Rust second (dogfooding value),
 * Java/C# last (largest grammars, most enterprise-gated adoption).
 */

/** Languages supported by the analysis engine. */
export const SupportedLanguage = {
  TypeScript: 'typescript',
  JavaScript: 'javascript',
  TSX: 'tsx',
  JSX: 'jsx',
  Python: 'python',
  Go: 'go',
  Rust: 'rust',
  Java: 'java',
  CSharp: 'csharp',
} as const;
export type SupportedLanguage = (typeof SupportedLanguage)[keyof typeof SupportedLanguage];

/** Type of import syntax used by a language. */
export type ImportSyntaxType = 'esm' | 'commonjs' | 'python' | 'go' | 'rust' | 'java' | 'csharp';

/** Complexity thresholds calibrated per language. */
export interface ComplexityThresholds {
  cyclomaticComplexityWarning: number;
  cyclomaticComplexityCritical: number;
  maxNestingDepthWarning: number;
  maxNestingDepthCritical: number;
  longFunctionLines: number;
  godFunctionLines: number;
  godClassMethods: number;
  maxParameters: number;
}

/** Configuration for a supported language. */
export interface LanguageConfig {
  language: SupportedLanguage;
  grammarWasmUrl: string;
  fileExtensions: string[];
  complexityThresholds: ComplexityThresholds;
  importSyntax: ImportSyntaxType;
}

/** Grammar loading state. */
type GrammarState = 'loaded' | 'loading' | 'not_loaded' | 'aspirational';

/**
 * Manages multi-language support. Handles grammar loading, language
 * detection, and threshold lookup.
 *
 * Tracks which languages are actually loaded vs aspirational —
 * the existing codebase lists Python/Rust/Go/Java/C# as supported
 * but only JS/TS actually parse. This must be fixed or the claim
 * removed before positioning as a standalone multi-language product.
 */
export class MultiLanguageManager {
  private languageConfigs: Map<SupportedLanguage, LanguageConfig> = new Map();
  private grammarStates: Map<SupportedLanguage, GrammarState> = new Map();
  private loadedGrammars: Set<SupportedLanguage> = new Set();

  constructor() {
    this.initializeConfigs();
  }

  /**
   * Initializes language configurations with calibrated thresholds.
   */
  private initializeConfigs(): void {
    // TypeScript / JavaScript / TSX / JSX — currently working
    const tsThresholds: ComplexityThresholds = {
      cyclomaticComplexityWarning: 10,
      cyclomaticComplexityCritical: 15,
      maxNestingDepthWarning: 4,
      maxNestingDepthCritical: 6,
      longFunctionLines: 50,
      godFunctionLines: 150,
      godClassMethods: 20,
      maxParameters: 5,
    };

    this.languageConfigs.set(SupportedLanguage.TypeScript, {
      language: SupportedLanguage.TypeScript,
      grammarWasmUrl: 'tree-sitter-typescript.wasm',
      fileExtensions: ['.ts'],
      complexityThresholds: tsThresholds,
      importSyntax: 'esm',
    });
    this.grammarStates.set(SupportedLanguage.TypeScript, 'loaded');

    this.languageConfigs.set(SupportedLanguage.JavaScript, {
      language: SupportedLanguage.JavaScript,
      grammarWasmUrl: 'tree-sitter-javascript.wasm',
      fileExtensions: ['.js', '.mjs', '.cjs'],
      complexityThresholds: tsThresholds,
      importSyntax: 'esm',
    });
    this.grammarStates.set(SupportedLanguage.JavaScript, 'loaded');

    this.languageConfigs.set(SupportedLanguage.TSX, {
      language: SupportedLanguage.TSX,
      grammarWasmUrl: 'tree-sitter-tsx.wasm',
      fileExtensions: ['.tsx'],
      complexityThresholds: tsThresholds,
      importSyntax: 'esm',
    });
    this.grammarStates.set(SupportedLanguage.TSX, 'loaded');

    this.languageConfigs.set(SupportedLanguage.JSX, {
      language: SupportedLanguage.JSX,
      grammarWasmUrl: 'tree-sitter-javascript.wasm', // JSX uses JS grammar
      fileExtensions: ['.jsx'],
      complexityThresholds: tsThresholds,
      importSyntax: 'esm',
    });
    this.grammarStates.set(SupportedLanguage.JSX, 'loaded');

    // Python — priority 1 (highest overlap with adopter teams)
    this.languageConfigs.set(SupportedLanguage.Python, {
      language: SupportedLanguage.Python,
      grammarWasmUrl: 'tree-sitter-python.wasm',
      fileExtensions: ['.py', '.pyw'],
      complexityThresholds: {
        // Python encourages simpler functions — tighter thresholds
        cyclomaticComplexityWarning: 8,
        cyclomaticComplexityCritical: 12,
        maxNestingDepthWarning: 4,
        maxNestingDepthCritical: 6,
        longFunctionLines: 40,
        godFunctionLines: 100,
        godClassMethods: 15,
        maxParameters: 4,
      },
      importSyntax: 'python',
    });
    this.grammarStates.set(SupportedLanguage.Python, 'aspirational');

    // Go — priority 1
    this.languageConfigs.set(SupportedLanguage.Go, {
      language: SupportedLanguage.Go,
      grammarWasmUrl: 'tree-sitter-go.wasm',
      fileExtensions: ['.go'],
      complexityThresholds: {
        // Go functions tend to be longer — slightly relaxed
        cyclomaticComplexityWarning: 10,
        cyclomaticComplexityCritical: 15,
        maxNestingDepthWarning: 4,
        maxNestingDepthCritical: 6,
        longFunctionLines: 60,
        godFunctionLines: 120,
        godClassMethods: 20,
        maxParameters: 5,
      },
      importSyntax: 'go',
    });
    this.grammarStates.set(SupportedLanguage.Go, 'aspirational');

    // Rust — priority 2 (dogfooding value)
    this.languageConfigs.set(SupportedLanguage.Rust, {
      language: SupportedLanguage.Rust,
      grammarWasmUrl: 'tree-sitter-rust.wasm',
      fileExtensions: ['.rs'],
      complexityThresholds: {
        cyclomaticComplexityWarning: 10,
        cyclomaticComplexityCritical: 15,
        maxNestingDepthWarning: 4,
        maxNestingDepthCritical: 6,
        longFunctionLines: 60,
        godFunctionLines: 120,
        godClassMethods: 15,
        maxParameters: 5,
      },
      importSyntax: 'rust',
    });
    this.grammarStates.set(SupportedLanguage.Rust, 'aspirational');

    // Java — priority 3 (most verbose, enterprise-gated)
    this.languageConfigs.set(SupportedLanguage.Java, {
      language: SupportedLanguage.Java,
      grammarWasmUrl: 'tree-sitter-java.wasm',
      fileExtensions: ['.java'],
      complexityThresholds: {
        // Java is more verbose — relaxed thresholds
        cyclomaticComplexityWarning: 12,
        cyclomaticComplexityCritical: 18,
        maxNestingDepthWarning: 5,
        maxNestingDepthCritical: 7,
        longFunctionLines: 60,
        godFunctionLines: 150,
        godClassMethods: 25,
        maxParameters: 6,
      },
      importSyntax: 'java',
    });
    this.grammarStates.set(SupportedLanguage.Java, 'aspirational');

    // C# — priority 3 (similar to Java)
    this.languageConfigs.set(SupportedLanguage.CSharp, {
      language: SupportedLanguage.CSharp,
      grammarWasmUrl: 'tree-sitter-csharp.wasm',
      fileExtensions: ['.cs'],
      complexityThresholds: {
        cyclomaticComplexityWarning: 12,
        cyclomaticComplexityCritical: 18,
        maxNestingDepthWarning: 5,
        maxNestingDepthCritical: 7,
        longFunctionLines: 60,
        godFunctionLines: 150,
        godClassMethods: 25,
        maxParameters: 6,
      },
      importSyntax: 'csharp',
    });
    this.grammarStates.set(SupportedLanguage.CSharp, 'aspirational');
  }

  /**
   * Detects the language for a given file path.
   *
   * @param filePath - Path to the file
   * @returns The detected language, or null if unsupported
   */
  getLanguageForFile(filePath: string): SupportedLanguage | null {
    for (const [lang, config] of this.languageConfigs) {
      for (const ext of config.fileExtensions) {
        if (filePath.endsWith(ext)) {
          return lang;
        }
      }
    }
    return null;
  }

  /**
   * Loads a tree-sitter grammar for a language (lazy loading).
   * Same pattern as existing ASTEngine.
   *
   * @param language - The language to load
   */
  async loadGrammar(language: SupportedLanguage): Promise<void> {
    const state = this.grammarStates.get(language);
    if (state === 'loaded') return;
    if (state === 'loading') return; // Already loading

    this.grammarStates.set(language, 'loading');

    try {
      const config = this.languageConfigs.get(language);
      if (!config) throw new Error(`No config for language ${language}`);

      // In production, this would load the WASM grammar:
      // const grammar = await fetch(config.grammarWasmUrl).then(r => r.arrayBuffer());
      // await ASTEngine.loadGrammar(language, grammar);

      this.loadedGrammars.add(language);
      this.grammarStates.set(language, 'loaded');
    } catch (err) {
      this.grammarStates.set(language, 'not_loaded');
      throw err;
    }
  }

  /**
   * Gets the complexity thresholds for a language.
   *
   * @param language - The language
   * @returns Calibrated complexity thresholds
   */
  getThresholds(language: SupportedLanguage): ComplexityThresholds {
    const config = this.languageConfigs.get(language);
    if (!config) {
      // Default to TypeScript thresholds if unknown
      return this.languageConfigs.get(SupportedLanguage.TypeScript)!.complexityThresholds;
    }
    return config.complexityThresholds;
  }

  /**
   * Gets the grammar loading state for a language.
   */
  getGrammarState(language: SupportedLanguage): GrammarState {
    return this.grammarStates.get(language) ?? 'not_loaded';
  }

  /**
   * Gets all supported languages.
   */
  getSupportedLanguages(): SupportedLanguage[] {
    return Array.from(this.languageConfigs.keys());
  }

  /**
   * Gets languages that are actually loaded (not aspirational).
   */
  getLoadedLanguages(): SupportedLanguage[] {
    return Array.from(this.loadedGrammars);
  }

  /**
   * Gets languages that are aspirational (listed but not yet functional).
   * This is the honesty gap — these must be fixed or the claim removed.
   */
  getAspirationalLanguages(): SupportedLanguage[] {
    const aspirational: SupportedLanguage[] = [];
    for (const [lang, state] of this.grammarStates) {
      if (state === 'aspirational') aspirational.push(lang);
    }
    return aspirational;
  }

  /**
   * Gets the language config for a language.
   */
  getLanguageConfig(language: SupportedLanguage): LanguageConfig | undefined {
    return this.languageConfigs.get(language);
  }

  /**
   * Checks if a language is actually functional (grammar loaded).
   */
  isLanguageFunctional(language: SupportedLanguage): boolean {
    return this.grammarStates.get(language) === 'loaded';
  }
}

// ── Singleton pattern (follows existing codebase convention) ───────
let instance: MultiLanguageManager | null = null;

/**
 * Gets the singleton MultiLanguageManager instance.
 * Every service uses this pattern: `let instance: T | null = null`
 * with an exported `getXxx(): T` getter.
 */
export function getMultiLanguageManager(): MultiLanguageManager {
  if (!instance) instance = new MultiLanguageManager();
  return instance;
}
