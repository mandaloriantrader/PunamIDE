/**
 * Property-based tests for Provider-Independent Parse Determinism.
 *
 * Feature: streaming-architecture-fix
 * Property 8: Provider-Independent Parse Determinism
 *
 * Different LLM providers (OpenAI, Anthropic, Gemini, DeepSeek, etc.) chunk
 * token streams differently — some emit single characters, others emit full
 * words or sentences. This property verifies that regardless of how the same
 * text is chunked into tokens, processing through createBlockParser with
 * sequential appendStreamText calls always produces identical BlockParseResult
 * structures.
 *
 * Uses fast-check with 100+ iterations.
 *
 * **Validates: Requirements 5.5**
 */

import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import { createBlockParser } from '../../utils/streamBlocks';
import type { BlockParseResult, StreamBlock } from '../../utils/protocol';

// ── Helpers ───────────────────────────────────────────────────────────────

/** Extract the trimmed content from a StreamBlock for comparison */
function getBlockContent(block: StreamBlock): string {
  switch (block.kind) {
    case 'thinking':
    case 'tool_result':
    case 'response':
      return block.content.trim();
    case 'tool_call':
      return `${block.name}|${block.params}`.trim();
  }
}

/** Compare two BlockParseResults for structural equality (completed blocks) */
function completedBlocksEqual(a: BlockParseResult, b: BlockParseResult): boolean {
  if (a.completed.length !== b.completed.length) return false;
  for (let i = 0; i < a.completed.length; i++) {
    const blockA = a.completed[i];
    const blockB = b.completed[i];
    if (blockA.kind !== blockB.kind) return false;
    if (getBlockContent(blockA) !== getBlockContent(blockB)) return false;
  }
  return true;
}

/**
 * Find "safe" split positions in a string — positions that do not fall
 * within a `<tagname>` or `</tagname>` sequence. Splitting inside a `<...>`
 * delimiter would cause the parser to classify the `<` as preamble (since
 * the full tag isn't visible yet), which is valid streaming behavior but
 * not what we test here. We test that splits at any *content boundary*
 * produce identical results regardless of chunking strategy.
 */
function findSafeSplitPositions(text: string): number[] {
  const safe: number[] = [];
  let i = 0;
  while (i < text.length) {
    if (text[i] === '<') {
      // Skip past the entire tag (opening or closing)
      const closeAngle = text.indexOf('>', i);
      if (closeAngle !== -1) {
        i = closeAngle + 1;
        safe.push(i); // right after '>' is always safe
      } else {
        i++;
      }
    } else {
      safe.push(i);
      i++;
    }
  }
  return safe.filter(p => p > 0 && p < text.length);
}

/** Split a string at the given positions (must be sorted, unique, within range) */
function splitAtPositions(str: string, positions: number[]): string[] {
  const sorted = [...new Set([0, ...positions, str.length])].sort((a, b) => a - b);
  const parts: string[] = [];
  for (let i = 0; i < sorted.length - 1; i++) {
    parts.push(str.slice(sorted[i], sorted[i + 1]));
  }
  return parts;
}

/**
 * Generate a distinct chunking from available safe positions.
 * Returns an array of selected split positions (subset of safePositions).
 */
function generateChunking(
  safePositions: number[],
  indices: number[],
): number[] {
  return indices
    .map(idx => safePositions[idx % safePositions.length])
    .filter((v, i, arr) => arr.indexOf(v) === i); // deduplicate
}

/**
 * Process a chunking through a fresh block parser, accumulating all
 * completed blocks across sequential appendStreamText calls.
 * Returns the final accumulated BlockParseResult.
 */
function processChunking(chunks: string[]): BlockParseResult {
  const parser = createBlockParser();
  const allCompleted: StreamBlock[] = [];
  let lastInProgress: StreamBlock | null = null;

  for (const chunk of chunks) {
    const result = parser.appendStreamText(chunk);
    allCompleted.push(...result.completed);
    lastInProgress = result.inProgress;
  }

  return { completed: allCompleted, inProgress: lastInProgress };
}

// ── Generators ────────────────────────────────────────────────────────────

/**
 * Generator for safe content that does not contain any characters that
 * could look like XML tag delimiters.
 */
const safeContentArb = fc.string({ minLength: 1, maxLength: 80 })
  .map(s => s.replace(/[<>]/g, '_'));

/** Generator for XML block tags with safe content */
const xmlBlockArb = fc.oneof(
  fc.record({
    tag: fc.constant('thinking' as const),
    content: safeContentArb,
  }),
  fc.record({
    tag: fc.constant('response' as const),
    content: safeContentArb,
  }),
  fc.record({
    tag: fc.constant('tool_result' as const),
    content: safeContentArb,
  }),
);

/** Generate a complete XML string from a list of blocks */
function blocksToXml(blocks: Array<{ tag: string; content: string }>): string {
  return blocks
    .map(b => `<${b.tag}>${b.content}</${b.tag}>`)
    .join('');
}

/**
 * Generator for chunking index arrays.
 * Each array represents one "provider's" chunking strategy.
 */
const chunkingIndicesArb = fc.array(fc.nat({ max: 80 }), { minLength: 1, maxLength: 12 });

// ── Property 8: Provider-Independent Parse Determinism ────────────────────

describe('Property 8: Provider-Independent Parse Determinism', () => {
  /**
   * **Validates: Requirements 5.5**
   *
   * For any text content T and for any two different chunkings of T into
   * token arrays (simulating different provider chunking behavior), processing
   * both through the block parser (createBlockParser + sequential
   * appendStreamText calls) SHALL produce identical BlockParseResult structures
   * (same completed blocks, same kinds, same content).
   */
  it('two different provider chunkings produce identical parse results', () => {
    fc.assert(
      fc.property(
        fc.array(xmlBlockArb, { minLength: 1, maxLength: 5 }),
        chunkingIndicesArb,
        chunkingIndicesArb,
        (blocks, indicesA, indicesB) => {
          const fullText = blocksToXml(blocks);
          if (fullText.length === 0) return;

          const safePositions = findSafeSplitPositions(fullText);
          if (safePositions.length === 0) return;

          // Generate two different chunkings simulating different providers
          const positionsA = generateChunking(safePositions, indicesA);
          const positionsB = generateChunking(safePositions, indicesB);

          const chunksA = splitAtPositions(fullText, positionsA);
          const chunksB = splitAtPositions(fullText, positionsB);

          // Verify both chunkings reconstruct the same text
          expect(chunksA.join('')).toBe(fullText);
          expect(chunksB.join('')).toBe(fullText);

          // Process each chunking through a fresh parser
          const resultA = processChunking(chunksA);
          const resultB = processChunking(chunksB);

          // Both must produce identical completed block structures
          expect(completedBlocksEqual(resultA, resultB)).toBe(true);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('three or more provider chunkings all produce identical results', () => {
    fc.assert(
      fc.property(
        fc.array(xmlBlockArb, { minLength: 1, maxLength: 4 }),
        fc.array(chunkingIndicesArb, { minLength: 3, maxLength: 5 }),
        (blocks, allChunkingIndices) => {
          const fullText = blocksToXml(blocks);
          if (fullText.length === 0) return;

          const safePositions = findSafeSplitPositions(fullText);
          if (safePositions.length === 0) return;

          // Generate N different chunkings (simulating N different providers)
          const allChunkings = allChunkingIndices.map(indices => {
            const positions = generateChunking(safePositions, indices);
            return splitAtPositions(fullText, positions);
          });

          // Process each chunking through a fresh parser
          const results = allChunkings.map(chunks => processChunking(chunks));

          // All results must be identical to the first
          const referenceResult = results[0];
          for (let i = 1; i < results.length; i++) {
            expect(completedBlocksEqual(referenceResult, results[i])).toBe(true);
          }
        },
      ),
      { numRuns: 100 },
    );
  });

  it('single-character chunking matches large-chunk provider behavior', () => {
    fc.assert(
      fc.property(
        fc.array(xmlBlockArb, { minLength: 1, maxLength: 3 }),
        chunkingIndicesArb,
        (blocks, largeChunkIndices) => {
          const fullText = blocksToXml(blocks);
          if (fullText.length === 0) return;

          const safePositions = findSafeSplitPositions(fullText);
          if (safePositions.length === 0) return;

          // Provider A: character-by-character (like a slow provider)
          // Use ALL safe positions as split points for finest granularity
          const charChunks = splitAtPositions(fullText, safePositions);

          // Provider B: large chunks (like a fast provider)
          const largePositions = generateChunking(safePositions, largeChunkIndices)
            .filter((_, idx) => idx % 3 === 0); // keep only every 3rd for larger chunks
          const largeChunks = splitAtPositions(fullText, largePositions);

          // Verify concatenation
          expect(charChunks.join('')).toBe(fullText);
          expect(largeChunks.join('')).toBe(fullText);

          // Process both
          const charResult = processChunking(charChunks);
          const largeResult = processChunking(largeChunks);

          // Must be identical
          expect(completedBlocksEqual(charResult, largeResult)).toBe(true);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('whole-text single chunk matches any multi-chunk provider', () => {
    fc.assert(
      fc.property(
        fc.array(xmlBlockArb, { minLength: 1, maxLength: 5 }),
        chunkingIndicesArb,
        (blocks, chunkIndices) => {
          const fullText = blocksToXml(blocks);
          if (fullText.length === 0) return;

          const safePositions = findSafeSplitPositions(fullText);
          if (safePositions.length === 0) return;

          // Provider A: entire text in one shot (e.g., cached response)
          const singleChunkResult = processChunking([fullText]);

          // Provider B: multi-chunk delivery
          const positions = generateChunking(safePositions, chunkIndices);
          const multiChunks = splitAtPositions(fullText, positions);
          expect(multiChunks.join('')).toBe(fullText);
          const multiResult = processChunking(multiChunks);

          // Must be identical
          expect(completedBlocksEqual(singleChunkResult, multiResult)).toBe(true);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('mixed thinking and response blocks are deterministic across providers', () => {
    fc.assert(
      fc.property(
        fc.tuple(
          safeContentArb,
          safeContentArb,
          safeContentArb,
        ),
        chunkingIndicesArb,
        chunkingIndicesArb,
        ([thinkContent, responseContent, moreResponse], indicesA, indicesB) => {
          // Construct a realistic multi-block stream
          const fullText =
            `<thinking>${thinkContent}</thinking>` +
            `<response>${responseContent}</response>` +
            `<thinking>${moreResponse}</thinking>`;

          const safePositions = findSafeSplitPositions(fullText);
          if (safePositions.length === 0) return;

          // Two different provider chunkings
          const chunksA = splitAtPositions(
            fullText,
            generateChunking(safePositions, indicesA),
          );
          const chunksB = splitAtPositions(
            fullText,
            generateChunking(safePositions, indicesB),
          );

          expect(chunksA.join('')).toBe(fullText);
          expect(chunksB.join('')).toBe(fullText);

          const resultA = processChunking(chunksA);
          const resultB = processChunking(chunksB);

          // Verify structural equality
          expect(resultA.completed.length).toBe(resultB.completed.length);
          for (let i = 0; i < resultA.completed.length; i++) {
            expect(resultA.completed[i].kind).toBe(resultB.completed[i].kind);
            expect(getBlockContent(resultA.completed[i])).toBe(
              getBlockContent(resultB.completed[i]),
            );
          }
        },
      ),
      { numRuns: 100 },
    );
  });
});
