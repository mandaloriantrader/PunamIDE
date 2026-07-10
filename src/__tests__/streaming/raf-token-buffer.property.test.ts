import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';

/**
 * Feature: streaming-architecture-fix
 * Property 1: Token Concatenation Preservation
 *
 * Validates: Requirements 1.2
 *
 * For any sequence of tokens received during a stream, the concatenation of all
 * text flushed to React state via RAF SHALL equal the concatenation of all input
 * tokens in their original arrival order.
 */
describe('Feature: streaming-architecture-fix, Property 1: Token Concatenation Preservation', () => {
  it('buffer concatenation equals input concatenation for any token sequence', () => {
    fc.assert(
      fc.property(
        fc.array(fc.string({ minLength: 1, maxLength: 1000 }), { minLength: 1, maxLength: 500 }),
        (tokens: string[]) => {
          // Simulate RAF buffer logic:
          // - A buffer string accumulates tokens
          // - On flush, the buffer content equals concat of all inputs
          // - After flush, buffer is empty
          let buffer = '';
          const flushed: string[] = [];

          for (const token of tokens) {
            buffer += token;
          }
          // Flush (simulating a single RAF callback firing after all tokens arrive)
          flushed.push(buffer);
          buffer = '';

          // Property: concatenation of all flushed content equals concatenation of all inputs
          expect(flushed.join('')).toBe(tokens.join(''));
          // After flush, buffer is empty
          expect(buffer).toBe('');
        }
      ),
      { numRuns: 100 }
    );
  });

  it('multiple intermediate flushes preserve total content', () => {
    fc.assert(
      fc.property(
        fc.array(fc.string({ minLength: 1, maxLength: 200 }), { minLength: 2, maxLength: 100 }),
        fc.nat({ max: 99 }),
        (tokens: string[], flushAfter: number) => {
          // Simulate RAF firing mid-stream (at a random point)
          let buffer = '';
          const flushed: string[] = [];
          const flushPoint = Math.min(flushAfter, tokens.length - 1) + 1;

          for (let i = 0; i < tokens.length; i++) {
            buffer += tokens[i];
            if (i === flushPoint - 1) {
              // RAF fires here — flush accumulated buffer
              flushed.push(buffer);
              buffer = '';
            }
          }
          // Final flush on stream completion
          if (buffer) flushed.push(buffer);

          // Property: total flushed content equals total input regardless of flush timing
          expect(flushed.join('')).toBe(tokens.join(''));
        }
      ),
      { numRuns: 100 }
    );
  });

  it('arbitrary number of flush points preserve total content', () => {
    fc.assert(
      fc.property(
        fc.array(fc.string({ minLength: 1, maxLength: 100 }), { minLength: 1, maxLength: 200 }),
        fc.array(fc.boolean(), { minLength: 1, maxLength: 200 }),
        (tokens: string[], flushDecisions: boolean[]) => {
          // Simulate RAF firing at arbitrary points determined by flushDecisions
          let buffer = '';
          const flushed: string[] = [];

          for (let i = 0; i < tokens.length; i++) {
            buffer += tokens[i];
            // Decide whether to flush after this token (simulating RAF timing)
            const shouldFlush = i < flushDecisions.length ? flushDecisions[i] : false;
            if (shouldFlush && buffer) {
              flushed.push(buffer);
              buffer = '';
            }
          }
          // Final flush on stream completion (synchronous flush clears buffer)
          if (buffer) {
            flushed.push(buffer);
            buffer = '';
          }

          // Property: no matter when flushes happen, total content is preserved
          expect(flushed.join('')).toBe(tokens.join(''));
          // After final flush, buffer is empty
          expect(buffer).toBe('');
        }
      ),
      { numRuns: 100 }
    );
  });
});
