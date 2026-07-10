import { describe, it, expect } from 'vitest';
import {
  estimateTokens,
  scoreRelevance,
  PRIORITY,
  type ContextSlot,
  type ContextKind,
} from '../services/intelligence/contextTypes';

describe('estimateTokens', () => {
  it('returns 0 for empty string', () => {
    expect(estimateTokens('')).toBe(0);
  });

  it('returns 0 for whitespace-only string', () => {
    expect(estimateTokens('   \t\n  ')).toBe(0);
  });

  it('estimates tokens as ceil(wordCount / 0.75)', () => {
    // 4 words → ceil(4 / 0.75) = ceil(5.33) = 6
    expect(estimateTokens('hello world foo bar')).toBe(6);
  });

  it('handles single word', () => {
    // 1 word → ceil(1 / 0.75) = ceil(1.33) = 2
    expect(estimateTokens('hello')).toBe(2);
  });

  it('handles multiple spaces between words', () => {
    // Still 3 words regardless of extra spacing
    expect(estimateTokens('one   two    three')).toBe(Math.ceil(3 / 0.75));
  });
});

describe('PRIORITY', () => {
  it('maps system_prompt to 10', () => {
    expect(PRIORITY.system_prompt).toBe(10);
  });

  it('maps task to 10', () => {
    expect(PRIORITY.task).toBe(10);
  });

  it('maps current_file to 9', () => {
    expect(PRIORITY.current_file).toBe(9);
  });

  it('maps conversation_turn to 7', () => {
    expect(PRIORITY.conversation_turn).toBe(7);
  });

  it('maps repo_map to 2 (lowest)', () => {
    expect(PRIORITY.repo_map).toBe(2);
  });

  it('covers all ContextKind values', () => {
    const allKinds: ContextKind[] = [
      'system_prompt', 'task', 'conversation_turn',
      'current_file', 'related_file', 'symbol_definition',
      'search_result', 'semantic_result', 'project_memory',
      'repo_map', 'tool_result',
    ];
    for (const kind of allKinds) {
      expect(PRIORITY[kind]).toBeGreaterThanOrEqual(2);
      expect(PRIORITY[kind]).toBeLessThanOrEqual(10);
    }
  });
});

describe('scoreRelevance', () => {
  function makeSlot(overrides: Partial<ContextSlot> = {}): ContextSlot {
    return {
      id: 'test-slot',
      kind: 'related_file',
      content: 'some content here for testing',
      tokenCount: 10,
      relevanceScore: 0,
      priority: 5,
      round: 0,
      evictable: true,
      ...overrides,
    };
  }

  it('returns 0 for no overlap, no file match, different round', () => {
    const slot = makeSlot({ content: 'xyz abc', round: 0 });
    const score = scoreRelevance(slot, 'completely unrelated words here', [], 5);
    expect(score).toBe(0);
  });

  it('adds 0.4 when filePath is in currentFiles', () => {
    const slot = makeSlot({ filePath: '/src/foo.ts', content: 'xyz abc', round: 0 });
    const score = scoreRelevance(slot, 'no overlap words', ['/src/foo.ts'], 5);
    expect(score).toBeCloseTo(0.4, 5);
  });

  it('adds up to 0.5 for keyword overlap', () => {
    // task has "implement context assembler" → keywords > 3 chars: "implement", "context", "assembler"
    // slot content has all those words
    const slot = makeSlot({ content: 'implement context assembler plus more stuff', round: 0 });
    const score = scoreRelevance(slot, 'implement context assembler', [], 5);
    // overlap = 3, taskWords.size = 3 → min(3/3, 0.5) = min(1, 0.5) = 0.5
    expect(score).toBeCloseTo(0.5, 5);
  });

  it('adds 0.1 recency bonus for current round', () => {
    const slot = makeSlot({ content: 'xyz abc', round: 3 });
    const score = scoreRelevance(slot, 'no overlap words', [], 3);
    expect(score).toBeCloseTo(0.1, 5);
  });

  it('caps score at 1.0', () => {
    // file match (0.4) + full keyword overlap (0.5) + recency (0.1) = 1.0
    const slot = makeSlot({
      filePath: '/src/foo.ts',
      content: 'implement context assembler',
      round: 2,
    });
    const score = scoreRelevance(slot, 'implement context assembler', ['/src/foo.ts'], 2);
    expect(score).toBe(1.0);
  });

  it('filters out short words (≤3 chars) from keyword matching', () => {
    // "the" and "a" are ≤3 chars, so only "implement" counts as a task keyword
    const slot = makeSlot({ content: 'the a implement', round: 0 });
    const score = scoreRelevance(slot, 'the a implement', [], 5);
    // taskWords = {"implement"}, overlap = 1, min(1/1, 0.5) = 0.5
    expect(score).toBeCloseTo(0.5, 5);
  });

  it('handles empty task gracefully', () => {
    const slot = makeSlot({ content: 'some content', round: 0 });
    const score = scoreRelevance(slot, '', [], 0);
    // No keywords (all filtered), so overlap term = min(0/max(0,1), 0.5) = 0
    // Recency: round matches → 0.1
    expect(score).toBeCloseTo(0.1, 5);
  });
});
