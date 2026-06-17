/**
 * ChunkInspector.ts — Phase 8, Step 8.1
 *
 * Visualizes how documents are chunked for RAG pipelines.
 * Allows adjusting chunk size, overlap, and previewing the impact
 * on chunk boundaries and content distribution.
 */

// ── Types ──────────────────────────────────────────────────────────────────────

export interface ChunkConfig {
  chunkSize: number;       // lines per chunk
  chunkOverlap: number;    // overlapping lines between chunks
  splitByHeading: boolean; // try to split on markdown headings (#, ##)
  splitByFunction: boolean; // try to split on function boundaries
}

export interface Chunk {
  index: number;
  startLine: number;
  endLine: number;
  content: string;
  tokenCount: number;      // approximate
  heading: string | null;  // nearest markdown heading
}

export interface ChunkAnalysis {
  config: ChunkConfig;
  totalLines: number;
  totalChunks: number;
  averageChunkSize: number;   // lines
  averageTokenCount: number;
  overlapPercentage: number;
  chunksBoundByHeading: number;
  chunksBoundByFunction: number;
  chunks: Chunk[];
  distribution: {
    sizeBuckets: Record<string, number>; // "0-10", "11-25", etc.
  };
}

// ── Default Config ────────────────────────────────────────────────────────────

export const DEFAULT_CHUNK_CONFIG: ChunkConfig = {
  chunkSize: 30,
  chunkOverlap: 5,
  splitByHeading: true,
  splitByFunction: true,
};

// ── ChunkInspector ─────────────────────────────────────────────────────────────

export class ChunkInspector {
  /**
   * Chunk a document with configurable parameters.
   */
  chunkDocument(content: string, config: ChunkConfig = DEFAULT_CHUNK_CONFIG): ChunkAnalysis {
    const lines = content.split("\n");
    const totalLines = lines.length;
    const chunks: Chunk[] = [];
    const chunkSize = config.chunkSize;
    const overlap = config.chunkOverlap;

    // Detect heading positions for split hints
    const headingPositions = this.detectHeadings(lines);
    const functionPositions = this.detectFunctions(content, lines);

    let i = 0;
    let chunkIndex = 0;
    let boundByHeading = 0;
    let boundByFunction = 0;
    let totalTokens = 0;

    while (i < totalLines) {
      let end = Math.min(i + chunkSize, totalLines);

      // Try to align to heading boundaries
      if (config.splitByHeading) {
        const nextHeading = headingPositions.find((h) => h >= i && h <= end);
        if (nextHeading && nextHeading > i && nextHeading < end) {
          end = nextHeading;
          boundByHeading++;
        }
      }

      // Try to align to function boundaries
      if (config.splitByFunction && !boundByHeading) {
        const nextFunc = functionPositions.find((f) => f >= i && f <= end);
        if (nextFunc && nextFunc > i && nextFunc < end) {
          end = nextFunc;
          boundByFunction++;
        }
      }

      const chunkContent = lines.slice(i, end).join("\n");
      const tokenCount = Math.ceil(chunkContent.length / 4); // rough estimate
      totalTokens += tokenCount;

      // Find nearest heading before this chunk
      const heading = this.findNearestHeading(headingPositions, lines, i);

      chunks.push({
        index: chunkIndex,
        startLine: i + 1,
        endLine: end,
        content: chunkContent,
        tokenCount,
        heading,
      });

      chunkIndex++;
      i = end - overlap; // Step forward with overlap
    }

    // Distribution analysis
    const sizeBuckets: Record<string, number> = {
      "0-10": 0, "11-25": 0, "26-50": 0, "51-100": 0, "101+": 0,
    };
    for (const chunk of chunks) {
      const len = chunk.endLine - chunk.startLine + 1;
      if (len <= 10) sizeBuckets["0-10"]++;
      else if (len <= 25) sizeBuckets["11-25"]++;
      else if (len <= 50) sizeBuckets["26-50"]++;
      else if (len <= 100) sizeBuckets["51-100"]++;
      else sizeBuckets["101+"]++;
    }

    return {
      config,
      totalLines,
      totalChunks: chunks.length,
      averageChunkSize: chunks.length > 0 ? totalLines / chunks.length : 0,
      averageTokenCount: chunks.length > 0 ? totalTokens / chunks.length : 0,
      overlapPercentage: (overlap / chunkSize) * 100,
      chunksBoundByHeading: boundByHeading,
      chunksBoundByFunction: boundByFunction,
      chunks,
      distribution: { sizeBuckets },
    };
  }

  /**
   * Compare two chunking strategies side by side.
   */
  compareStrategies(
    content: string,
    configs: ChunkConfig[],
  ): { config: ChunkConfig; analysis: ChunkAnalysis }[] {
    return configs.map((config) => ({
      config,
      analysis: this.chunkDocument(content, config),
    }));
  }

  /**
   * Estimate optimal chunk size based on document characteristics.
   */
  estimateOptimalConfig(content: string): ChunkConfig {
    const lines = content.split("\n");
    const avgLineLength = lines.reduce((sum, l) => sum + l.length, 0) / Math.max(1, lines.length);

    // Heuristic: shorter lines (code) → larger chunks; longer lines (prose) → smaller chunks
    if (avgLineLength < 60) {
      // Likely code
      return { chunkSize: 40, chunkOverlap: 10, splitByHeading: true, splitByFunction: true };
    } else if (avgLineLength < 100) {
      return { chunkSize: 30, chunkOverlap: 5, splitByHeading: true, splitByFunction: true };
    } else {
      // Likely prose
      return { chunkSize: 20, chunkOverlap: 3, splitByHeading: true, splitByFunction: false };
    }
  }

  // ── Private Helpers ─────────────────────────────────────────────────────────

  private detectHeadings(lines: string[]): number[] {
    const positions: number[] = [];
    for (let i = 0; i < lines.length; i++) {
      const trimmed = lines[i].trim();
      if (trimmed.startsWith("#") && !trimmed.startsWith("##")) {
        positions.push(i);
      }
    }
    return positions;
  }

  private detectFunctions(_content: string, lines: string[]): number[] {
    const positions: number[] = [];
    // Simple detection: lines starting with function/def/class/public/export
    for (let i = 0; i < lines.length; i++) {
      const trimmed = lines[i].trim();
      if (
        /^(?:export\s+)?(?:async\s+)?function\b/.test(trimmed) ||
        /^(?:export\s+)?(?:const|let|var)\s+\w+\s*=\s*(?:async\s+)?\(/.test(trimmed) ||
        /^(?:export\s+)?(?:default\s+)?class\b/.test(trimmed) ||
        /^def\s+\w+/.test(trimmed) ||
        /^fn\s+\w+/.test(trimmed) ||
        /^pub\s+(?:async\s+)?fn\s+/.test(trimmed)
      ) {
        positions.push(i);
      }
    }
    return positions;
  }

  private findNearestHeading(
    headingPositions: number[],
    lines: string[],
    lineIndex: number,
  ): string | null {
    let nearest: string | null = null;
    let nearestDist = Infinity;

    for (const pos of headingPositions) {
      if (pos <= lineIndex) {
        const dist = lineIndex - pos;
        if (dist < nearestDist) {
          nearestDist = dist;
          nearest = lines[pos].trim().replace(/^#+\s*/, "");
        }
      }
    }
    return nearest;
  }
}