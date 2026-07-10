import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';

/**
 * Feature: streaming-architecture-fix
 * Property 9: Emit Throttle Preserves Order and Completeness
 * Property 10: Immediate Emit on Buffer Size Threshold
 *
 * Validates: Requirements 7.1, 7.2
 *
 * Simulates the Rust-side adaptive emit throttle logic in TypeScript.
 * The throttle buffers tokens and emits when elapsed >= 16ms OR buffer > 512 bytes,
 * with a final flush at the end.
 */

// --- Throttle simulation (mirrors Rust logic) ---

const MIN_EMIT_INTERVAL_MS = 16;
const MAX_BUFFER_BYTES = 512;

interface TokenInput {
  text: string;
  timestampMs: number;
}

function simulateThrottle(tokens: TokenInput[]): string[] {
  const emitted: string[] = [];
  let buffer = '';
  let lastEmitMs = 0;

  for (const { text, timestampMs } of tokens) {
    buffer += text;
    const elapsed = timestampMs - lastEmitMs;

    if (elapsed >= MIN_EMIT_INTERVAL_MS || buffer.length > MAX_BUFFER_BYTES) {
      emitted.push(buffer);
      buffer = '';
      lastEmitMs = timestampMs;
    }
  }

  // Final flush
  if (buffer) {
    emitted.push(buffer);
  }

  return emitted;
}

// --- Generators ---

/**
 * Generates a token with arbitrary text and a monotonically increasing timestamp.
 */
const tokenSequenceArb = (minLen: number, maxLen: number) =>
  fc
    .array(
      fc.record({
        text: fc.string({ minLength: 1, maxLength: 200 }),
        delayMs: fc.nat({ max: 50 }), // inter-token delay 0-50ms
      }),
      { minLength: minLen, maxLength: maxLen }
    )
    .map((items) => {
      let currentMs = 0;
      return items.map(({ text, delayMs }) => {
        currentMs += delayMs;
        return { text, timestampMs: currentMs };
      });
    });

/**
 * Generates token sequences specifically designed to exceed 512 bytes.
 * Uses larger tokens to guarantee buffer overflow.
 */
const largeTokenSequenceArb = fc
  .array(
    fc.record({
      text: fc.string({ minLength: 50, maxLength: 300 }),
      delayMs: fc.constant(0), // no time passes, so only size threshold triggers
    }),
    { minLength: 3, maxLength: 20 }
  )
  .map((items) => {
    let currentMs = 0;
    return items.map(({ text, delayMs }) => {
      currentMs += delayMs;
      return { text, timestampMs: currentMs };
    });
  });

// --- Property 9: Emit Throttle Preserves Order and Completeness ---

describe('Feature: streaming-architecture-fix, Property 9: Emit Throttle Preserves Order and Completeness', () => {
  it('concatenation of all emitted payloads equals concatenation of all input tokens in order', () => {
    fc.assert(
      fc.property(
        tokenSequenceArb(1, 500),
        (tokens: TokenInput[]) => {
          const emitted = simulateThrottle(tokens);

          // Property: concatenation of all emitted payloads equals concatenation of all input tokens
          const emittedConcat = emitted.join('');
          const inputConcat = tokens.map((t) => t.text).join('');
          expect(emittedConcat).toBe(inputConcat);
        }
      ),
      { numRuns: 100 }
    );
  });

  it('relative character order is preserved across all emissions', () => {
    fc.assert(
      fc.property(
        tokenSequenceArb(1, 200),
        (tokens: TokenInput[]) => {
          const emitted = simulateThrottle(tokens);

          // Verify order: walk through emitted payloads and verify each character
          // appears in the same order as in the original token sequence
          const inputChars = tokens.map((t) => t.text).join('');
          const emittedChars = emitted.join('');

          expect(emittedChars.length).toBe(inputChars.length);
          for (let i = 0; i < inputChars.length; i++) {
            expect(emittedChars[i]).toBe(inputChars[i]);
          }
        }
      ),
      { numRuns: 100 }
    );
  });

  it('emitted payloads are non-empty (no spurious empty emissions)', () => {
    fc.assert(
      fc.property(
        tokenSequenceArb(1, 300),
        (tokens: TokenInput[]) => {
          const emitted = simulateThrottle(tokens);

          // Every emitted payload should be non-empty
          for (const payload of emitted) {
            expect(payload.length).toBeGreaterThan(0);
          }
        }
      ),
      { numRuns: 100 }
    );
  });

  it('at least one emission occurs for any non-empty token sequence', () => {
    fc.assert(
      fc.property(
        tokenSequenceArb(1, 100),
        (tokens: TokenInput[]) => {
          const emitted = simulateThrottle(tokens);
          expect(emitted.length).toBeGreaterThanOrEqual(1);
        }
      ),
      { numRuns: 100 }
    );
  });
});

// --- Property 10: Immediate Emit on Buffer Size Threshold ---

describe('Feature: streaming-architecture-fix, Property 10: Immediate Emit on Buffer Size Threshold', () => {
  it('buffer is flushed before growing beyond threshold+one-token when size exceeds 512 bytes', () => {
    fc.assert(
      fc.property(
        largeTokenSequenceArb,
        (tokens: TokenInput[]) => {
          // Walk through the throttle simulation step-by-step and verify that
          // no single emitted payload exceeds MAX_BUFFER_BYTES + the size of the
          // token that pushed it over the threshold.
          let buffer = '';
          let lastEmitMs = 0;
          const emitted: string[] = [];

          for (const { text, timestampMs } of tokens) {
            buffer += text;
            const elapsed = timestampMs - lastEmitMs;

            if (elapsed >= MIN_EMIT_INTERVAL_MS || buffer.length > MAX_BUFFER_BYTES) {
              emitted.push(buffer);
              buffer = '';
              lastEmitMs = timestampMs;
            }
          }
          if (buffer) emitted.push(buffer);

          // Verify: each emitted payload is at most MAX_BUFFER_BYTES + max single token size
          // because the buffer is flushed as soon as it exceeds the threshold
          // (i.e. after the token that crosses the threshold is appended)
          const maxTokenSize = Math.max(...tokens.map((t) => t.text.length));
          for (const payload of emitted) {
            expect(payload.length).toBeLessThanOrEqual(MAX_BUFFER_BYTES + maxTokenSize);
          }
        }
      ),
      { numRuns: 100 }
    );
  });

  it('emission occurs when buffer exceeds 512 bytes regardless of time elapsed', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.string({ minLength: 200, maxLength: 400 }),
          { minLength: 4, maxLength: 30 }
        ),
        (tokenTexts: string[]) => {
          // All tokens arrive at the same timestamp (0ms elapsed between them)
          // so time-based threshold never fires — only size threshold can trigger
          const tokens: TokenInput[] = tokenTexts.map((text) => ({
            text,
            timestampMs: 0,
          }));

          const emitted = simulateThrottle(tokens);

          // Check if the buffer would have exceeded 512 at some intermediate point.
          // Walk through tokens accumulating and check if any prefix sum > 512
          // before the last token (meaning a mid-stream emission must have occurred).
          let accum = 0;
          let wouldExceedMidStream = false;
          for (let i = 0; i < tokenTexts.length - 1; i++) {
            accum += tokenTexts[i].length;
            if (accum > MAX_BUFFER_BYTES) {
              wouldExceedMidStream = true;
              break;
            }
          }

          if (wouldExceedMidStream) {
            // At least one mid-stream emission must have occurred
            // (more than just the final flush)
            expect(emitted.length).toBeGreaterThan(1);
          }

          // Concatenation still holds
          expect(emitted.join('')).toBe(tokenTexts.join(''));
        }
      ),
      { numRuns: 100 }
    );
  });

  it('no emitted payload exceeds 512 bytes + one token length (buffer is flushed at threshold crossing)', () => {
    fc.assert(
      fc.property(
        tokenSequenceArb(1, 300),
        (tokens: TokenInput[]) => {
          const emitted = simulateThrottle(tokens);

          // Find the maximum single token size
          const maxTokenSize = Math.max(...tokens.map((t) => t.text.length));

          // Each emitted payload can be at most MAX_BUFFER_BYTES + maxTokenSize
          // because the check triggers after appending a token to the buffer.
          // In the worst case, the buffer was just under threshold and one large
          // token pushed it over.
          for (const payload of emitted) {
            expect(payload.length).toBeLessThanOrEqual(MAX_BUFFER_BYTES + maxTokenSize);
          }
        }
      ),
      { numRuns: 100 }
    );
  });
});
