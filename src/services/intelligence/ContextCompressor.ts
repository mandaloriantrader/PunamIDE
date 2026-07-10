/**
 * Context Compressor Service
 *
 * Compresses large files (>50KB) into relevant AST sections for AI context
 * inclusion. Uses the Rust `compress_file_ast` command for AST-based extraction,
 * then formats the result with ellipsis markers indicating omitted ranges.
 *
 * Falls back to raw token-limited content on timeout or parse failure.
 *
 * Requirements: 7.1, 7.2, 7.3, 7.5, 7.6, 7.7, 7.8
 */

import { invoke } from "@tauri-apps/api/core";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Configuration for the context compression pipeline. */
export interface CompressionConfig {
  /** File size threshold in bytes. Files below this are not compressed. Default: 51200 (50KB). */
  fileSizeThreshold: number;
  /** Maximum tokens per compressed file output. Default: 4000. */
  perFileTokenLimit: number;
  /** Maximum percentage of per-file token limit allowed for imports + type definitions. Default: 50. */
  importTypeCeilingPct: number;
  /** Timeout in milliseconds for the Rust compress command. Default: 2000. */
  timeoutMs: number;
}

/** Default compression configuration. */
export const DEFAULT_COMPRESSION_CONFIG: CompressionConfig = {
  fileSizeThreshold: 50 * 1024, // 51200 bytes
  perFileTokenLimit: 4000,
  importTypeCeilingPct: 50,
  timeoutMs: 2000,
};

/** Result of compressing a single file. */
export interface CompressedFile {
  /** Original file path. */
  filePath: string;
  /** Compressed content string with ellipsis markers. */
  content: string;
  /** Estimated token count of the compressed content. */
  tokenCount: number;
  /** Number of AST sections included in the output. */
  sectionsIncluded: number;
  /** Whether fallback (raw truncation) was used instead of AST extraction. */
  fallbackUsed: boolean;
}

// ---------------------------------------------------------------------------
// Rust command response types (mirrors src-tauri/src/context_compressor.rs)
// ---------------------------------------------------------------------------

/** A single extracted section from the Rust compressor. */
interface CompressedSection {
  content: string;
  symbol_name: string;
  kind: string;
  start_line: number;
  end_line: number;
  rank: number;
}

/** An omitted line range between sections. */
interface OmittedRange {
  start_line: number;
  end_line: number;
}

/** Full result returned by the `compress_file_ast` Tauri command. */
interface CompressedFileResult {
  sections: CompressedSection[];
  imports: string;
  total_tokens: number;
  omitted_ranges: OmittedRange[];
  fallback_used: boolean;
}

// ---------------------------------------------------------------------------
// ContextCompressor
// ---------------------------------------------------------------------------

/**
 * Compresses large files into relevant AST sections for AI prompt inclusion.
 *
 * Usage:
 * ```ts
 * const compressor = new ContextCompressor();
 * if (compressor.needsCompression(fileContent)) {
 *   const compressed = await compressor.compress(filePath, fileContent, keywords);
 *   // Use compressed.content in the prompt
 * }
 * ```
 */
export class ContextCompressor {
  private config: CompressionConfig;

  constructor(config?: Partial<CompressionConfig>) {
    this.config = { ...DEFAULT_COMPRESSION_CONFIG, ...config };
  }

  /**
   * Check if a file needs compression based on byte length exceeding the threshold.
   */
  needsCompression(fileContent: string): boolean {
    // Use TextEncoder for accurate byte length (handles multi-byte chars)
    return new TextEncoder().encode(fileContent).length > this.config.fileSizeThreshold;
  }

  /**
   * Compress a file for AI context inclusion.
   *
   * Invokes the Rust `compress_file_ast` command with a timeout. On success,
   * formats the result with ellipsis markers between non-adjacent sections.
   * On timeout or error, falls back to the first `perFileTokenLimit` tokens
   * of raw content.
   *
   * @param filePath - Absolute path to the file
   * @param fileContent - Raw file content string
   * @param queryKeywords - Keywords from the user's query for relevance ranking
   * @returns Compressed file representation
   */
  async compress(
    filePath: string,
    fileContent: string,
    queryKeywords: string[]
  ): Promise<CompressedFile> {
    try {
      const result = await this.invokeWithTimeout(
        filePath,
        queryKeywords,
        this.config.perFileTokenLimit
      );

      if (result.fallback_used) {
        // Rust side already did a raw fallback — format it directly
        const content = this.formatFallbackResult(result);
        return {
          filePath,
          content,
          tokenCount: this.estimateTokens(content),
          sectionsIncluded: result.sections.length,
          fallbackUsed: true,
        };
      }

      const content = this.formatWithEllipsis(result);
      return {
        filePath,
        content,
        tokenCount: this.estimateTokens(content),
        sectionsIncluded: result.sections.length,
        fallbackUsed: false,
      };
    } catch {
      // Timeout or invoke error — fall back to raw token-limited content
      const content = this.rawFallback(fileContent);
      return {
        filePath,
        content,
        tokenCount: this.estimateTokens(content),
        sectionsIncluded: 0,
        fallbackUsed: true,
      };
    }
  }

  // -------------------------------------------------------------------------
  // Private methods
  // -------------------------------------------------------------------------

  /**
   * Invoke the Rust `compress_file_ast` command with a timeout.
   * Rejects with an error if the command exceeds `timeoutMs`.
   */
  private invokeWithTimeout(
    filePath: string,
    queryKeywords: string[],
    maxTokens: number
  ): Promise<CompressedFileResult> {
    const invokePromise = invoke<CompressedFileResult>("compress_file_ast", {
      filePath,
      queryKeywords,
      maxTokens,
    });

    const timeoutPromise = new Promise<never>((_, reject) => {
      setTimeout(
        () => reject(new Error(`compress_file_ast timed out after ${this.config.timeoutMs}ms`)),
        this.config.timeoutMs
      );
    });

    return Promise.race([invokePromise, timeoutPromise]);
  }

  /**
   * Format the Rust compression result into a readable string with
   * "[... lines N-M omitted]" markers between non-adjacent sections.
   *
   * Assembly order:
   * 1. Imports block (if present)
   * 2. Sections sorted by start_line ascending
   * 3. Ellipsis markers between non-adjacent sections
   */
  private formatWithEllipsis(result: CompressedFileResult): string {
    const parts: string[] = [];

    // Include imports block first if present
    if (result.imports && result.imports.trim().length > 0) {
      parts.push(result.imports.trim());
    }

    // Sort sections by start_line to maintain source order
    const sortedSections = [...result.sections].sort(
      (a, b) => a.start_line - b.start_line
    );

    // Track the last line we've output to detect gaps
    let lastEndLine = 0;

    // If we have imports, figure out where they end
    if (result.imports && result.imports.trim().length > 0) {
      // Imports are typically at the top; use the first section's start as reference
      const importLineCount = result.imports.trim().split("\n").length;
      lastEndLine = importLineCount;
    }

    for (const section of sortedSections) {
      // If there's a gap between the last content and this section, insert ellipsis
      if (section.start_line > lastEndLine + 1) {
        const gapStart = lastEndLine + 1;
        const gapEnd = section.start_line - 1;
        parts.push(`[... lines ${gapStart}-${gapEnd} omitted]`);
      }

      parts.push(section.content);
      lastEndLine = section.end_line;
    }

    // If there are omitted ranges after the last section, add a trailing ellipsis
    if (result.omitted_ranges.length > 0) {
      const lastOmitted = result.omitted_ranges[result.omitted_ranges.length - 1];
      if (lastOmitted.end_line > lastEndLine) {
        parts.push(
          `[... lines ${lastEndLine + 1}-${lastOmitted.end_line} omitted]`
        );
      }
    }

    return parts.join("\n\n");
  }

  /**
   * Format a result where the Rust side already performed a fallback.
   */
  private formatFallbackResult(result: CompressedFileResult): string {
    const parts: string[] = [];

    if (result.imports && result.imports.trim().length > 0) {
      parts.push(result.imports.trim());
    }

    for (const section of result.sections) {
      parts.push(section.content);
    }

    parts.push("[... file was not fully parsed — content truncated]");
    return parts.join("\n\n");
  }

  /**
   * Raw fallback: extract the first `perFileTokenLimit` tokens of content.
   * Uses character-based estimation: ~4 chars per token (matches Rust heuristic).
   */
  private rawFallback(fileContent: string): string {
    const maxChars = this.config.perFileTokenLimit * 4;
    const truncated = fileContent.slice(0, maxChars);

    // Try to cut at a line boundary for readability
    const lastNewline = truncated.lastIndexOf("\n");
    const content = lastNewline > maxChars * 0.8 ? truncated.slice(0, lastNewline) : truncated;

    return content + "\n\n[... file was not fully parsed — content truncated]";
  }

  /**
   * Estimate the token count for a text string.
   * Uses `Math.ceil(text.length / 4)` to match the Rust backend heuristic.
   */
  private estimateTokens(text: string): number {
    if (!text || text.length === 0) return 0;
    return Math.ceil(text.length / 4);
  }
}
