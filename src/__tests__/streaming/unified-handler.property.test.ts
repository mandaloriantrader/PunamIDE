/**
 * Property-based tests for Unified Token Handler — Stale Stream ID Discard
 *
 * Feature: streaming-architecture-fix, Property 2: Stale Stream ID Discard
 *
 * Validates: Requirements 1.5, 5.6
 */

import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';

// Simulate the guard logic from AiChat's onStreamToken
function simulateTokenHandler(
  activeStreamId: string | null,
  incomingStreamId: string,
  token: string,
  currentBuffer: string
): { buffer: string; wasProcessed: boolean } {
  if (incomingStreamId !== activeStreamId) {
    return { buffer: currentBuffer, wasProcessed: false };
  }
  return { buffer: currentBuffer + token, wasProcessed: true };
}

// UUID arbitrary for generating stream IDs
const uuidArb = fc.uuid();

// Non-empty token arbitrary
const tokenArb = fc.string({ minLength: 1, maxLength: 200 });

// Buffer content arbitrary (can be empty)
const bufferArb = fc.string({ minLength: 0, maxLength: 500 });

describe('Unified Token Handler - Property 2: Stale Stream ID Discard', () => {
  /**
   * **Validates: Requirements 1.2**
   *
   * Property: When streamId matches active, buffer grows by token length.
   * For any matching streamId, the resulting buffer should be the concatenation
   * of the current buffer and the incoming token.
   */
  it('when streamId matches active: buffer grows by token length', () => {
    fc.assert(
      fc.property(
        uuidArb,
        tokenArb,
        bufferArb,
        (streamId, token, currentBuffer) => {
          const result = simulateTokenHandler(streamId, streamId, token, currentBuffer);

          expect(result.wasProcessed).toBe(true);
          expect(result.buffer).toBe(currentBuffer + token);
          expect(result.buffer.length).toBe(currentBuffer.length + token.length);
        }
      ),
      { numRuns: 100 }
    );
  });

  /**
   * **Validates: Requirements 1.5, 5.6**
   *
   * Property: When streamId doesn't match, buffer stays unchanged.
   * For any token whose streamId doesn't match the active streamId,
   * the buffer must remain exactly as it was before.
   */
  it("when streamId doesn't match: buffer stays unchanged", () => {
    fc.assert(
      fc.property(
        uuidArb,
        uuidArb,
        tokenArb,
        bufferArb,
        (activeStreamId, incomingStreamId, token, currentBuffer) => {
          // Ensure the IDs are different
          fc.pre(activeStreamId !== incomingStreamId);

          const result = simulateTokenHandler(
            activeStreamId,
            incomingStreamId,
            token,
            currentBuffer
          );

          expect(result.wasProcessed).toBe(false);
          expect(result.buffer).toBe(currentBuffer);
        }
      ),
      { numRuns: 100 }
    );
  });

  /**
   * **Validates: Requirements 1.5, 5.6**
   *
   * Property: When activeStreamId is null, all tokens are discarded.
   * A null active stream means no stream is active, so every incoming
   * token should be discarded regardless of its streamId.
   */
  it('when activeStreamId is null: all tokens are discarded', () => {
    fc.assert(
      fc.property(
        uuidArb,
        tokenArb,
        bufferArb,
        (incomingStreamId, token, currentBuffer) => {
          const result = simulateTokenHandler(null, incomingStreamId, token, currentBuffer);

          expect(result.wasProcessed).toBe(false);
          expect(result.buffer).toBe(currentBuffer);
        }
      ),
      { numRuns: 100 }
    );
  });
});
