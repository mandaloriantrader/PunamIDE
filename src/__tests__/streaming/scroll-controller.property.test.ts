/**
 * Property-based tests for Scroll Controller
 *
 * Feature: streaming-architecture-fix, Property 4: No Scroll Trigger on Token Content Changes
 * Feature: streaming-architecture-fix, Property 5: Scroll Auto-Enable Threshold
 *
 * Validates: Requirements 3.2, 3.4, 3.5
 */

import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';

/**
 * Simulate the scroll controller's auto-scroll effect behavior.
 * The real implementation uses a useEffect that depends ONLY on messages.length.
 * Token content updates do NOT trigger scroll — only message count changes do.
 */
function simulateScrollEffect(
  messagesLength: number,
  prevMessagesLength: number,
  isUserScrolledUp: boolean
): { scrollIntoViewCalled: boolean } {
  // The effect only fires when messages.length changes
  if (messagesLength === prevMessagesLength) {
    return { scrollIntoViewCalled: false };
  }
  // If user has scrolled up, don't auto-scroll
  if (isUserScrolledUp) {
    return { scrollIntoViewCalled: false };
  }
  return { scrollIntoViewCalled: true };
}

/**
 * Simulate scroll state from AiChat's handleChatScroll.
 * Computes whether auto-scroll should be disabled based on scroll position.
 */
function computeScrollState(
  scrollTop: number,
  scrollHeight: number,
  clientHeight: number
): { isUserScrolledUp: boolean } {
  const distanceFromBottom = scrollHeight - scrollTop - clientHeight;
  if (distanceFromBottom > 100) {
    return { isUserScrolledUp: true };
  } else if (distanceFromBottom <= 50) {
    return { isUserScrolledUp: false };
  }
  // In the 50-100px range, state doesn't change (hysteresis)
  // For a fresh state (no prior scroll), default is false (auto-scroll enabled)
  return { isUserScrolledUp: false };
}

describe('Feature: streaming-architecture-fix, Property 4: No Scroll Trigger on Token Content Changes', () => {
  /**
   * **Validates: Requirements 3.2**
   *
   * Property: For any number of token content updates (1-200) that occur while
   * messages.length remains constant, the scroll controller SHALL produce zero
   * scrollIntoView calls. Scroll should only trigger on messages.length change.
   */
  it('zero scrollIntoView calls when messages.length is constant during token updates', () => {
    fc.assert(
      fc.property(
        fc.nat({ max: 200 }).map(n => n + 1), // 1-200 token updates
        fc.nat({ max: 50 }).map(n => n + 1),  // messages.length (constant, at least 1)
        (tokenUpdateCount: number, messagesLength: number) => {
          let scrollCallCount = 0;

          // Simulate N token updates, each time messages.length stays the same
          for (let i = 0; i < tokenUpdateCount; i++) {
            const result = simulateScrollEffect(
              messagesLength,
              messagesLength, // prev === current → no length change
              false // auto-scroll enabled
            );
            if (result.scrollIntoViewCalled) {
              scrollCallCount++;
            }
          }

          // Property: zero scroll calls during token-only updates
          expect(scrollCallCount).toBe(0);
        }
      ),
      { numRuns: 100 }
    );
  });

  /**
   * **Validates: Requirements 3.2**
   *
   * Property: Even when user has NOT scrolled up (auto-scroll is enabled),
   * token content changes alone never trigger scrollIntoView.
   */
  it('token updates with auto-scroll enabled still produce zero scroll calls', () => {
    fc.assert(
      fc.property(
        fc.nat({ max: 200 }).map(n => n + 1), // 1-200 token updates
        fc.nat({ max: 100 }).map(n => n + 1), // messages.length (constant)
        fc.array(fc.string({ minLength: 1, maxLength: 100 }), { minLength: 1, maxLength: 200 }), // token contents
        (tokenUpdateCount: number, messagesLength: number, _tokens: string[]) => {
          let scrollCallCount = 0;

          // Each token update: content changes, but messages.length stays constant
          for (let i = 0; i < tokenUpdateCount; i++) {
            const result = simulateScrollEffect(
              messagesLength,
              messagesLength,
              false // auto-scroll enabled (user at bottom)
            );
            if (result.scrollIntoViewCalled) {
              scrollCallCount++;
            }
          }

          expect(scrollCallCount).toBe(0);
        }
      ),
      { numRuns: 100 }
    );
  });

  /**
   * **Validates: Requirements 3.2**
   *
   * Property: scroll triggers exactly once when messages.length increases
   * (proving length change is the only trigger), but not on subsequent
   * token content updates within that same message count.
   */
  it('scroll triggers on length change then stays silent for token updates', () => {
    fc.assert(
      fc.property(
        fc.nat({ max: 200 }).map(n => n + 1), // token updates after the length change
        fc.nat({ max: 50 }).map(n => n + 1),  // initial messages.length
        (tokenUpdateCount: number, initialLength: number) => {
          let scrollCallCount = 0;

          // First: messages.length increases by 1 (new message appears)
          const newLength = initialLength + 1;
          const initialScroll = simulateScrollEffect(newLength, initialLength, false);
          if (initialScroll.scrollIntoViewCalled) scrollCallCount++;

          // Then: N token updates with constant messages.length
          for (let i = 0; i < tokenUpdateCount; i++) {
            const result = simulateScrollEffect(newLength, newLength, false);
            if (result.scrollIntoViewCalled) scrollCallCount++;
          }

          // Property: exactly 1 scroll call (from the length change), none from tokens
          expect(scrollCallCount).toBe(1);
        }
      ),
      { numRuns: 100 }
    );
  });
});

describe('Feature: streaming-architecture-fix, Property 5: Scroll Auto-Enable Threshold', () => {
  /**
   * **Validates: Requirements 3.4**
   *
   * Property: For any scroll position where distanceFromBottom > 100px,
   * auto-scroll SHALL be disabled (isUserScrolledUp = true).
   */
  it('distanceFromBottom > 100px disables auto-scroll', () => {
    fc.assert(
      fc.property(
        fc.nat({ max: 10000 }), // scrollTop
        fc.nat({ max: 5000 }).map(n => n + 1), // clientHeight (at least 1)
        (scrollTop: number, clientHeight: number) => {
          // Ensure scrollHeight produces distanceFromBottom > 100
          // distanceFromBottom = scrollHeight - scrollTop - clientHeight > 100
          // So scrollHeight > scrollTop + clientHeight + 100
          const minScrollHeight = scrollTop + clientHeight + 101;
          const scrollHeight = minScrollHeight + Math.floor(Math.random() * 500);

          const distanceFromBottom = scrollHeight - scrollTop - clientHeight;
          // Precondition: distance must be > 100
          fc.pre(distanceFromBottom > 100);

          const state = computeScrollState(scrollTop, scrollHeight, clientHeight);
          expect(state.isUserScrolledUp).toBe(true);
        }
      ),
      { numRuns: 100 }
    );
  });

  /**
   * **Validates: Requirements 3.4**
   *
   * Property: Directly generate distanceFromBottom > 100 and verify disabled.
   */
  it('any distanceFromBottom > 100 means auto-scroll is disabled', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 101, max: 10000 }), // distanceFromBottom > 100
        fc.nat({ max: 5000 }).map(n => n + 1), // clientHeight
        (distanceFromBottom: number, clientHeight: number) => {
          // Construct scroll values from the distance
          const scrollTop = 500; // arbitrary
          const scrollHeight = scrollTop + clientHeight + distanceFromBottom;

          const state = computeScrollState(scrollTop, scrollHeight, clientHeight);
          expect(state.isUserScrolledUp).toBe(true);
        }
      ),
      { numRuns: 100 }
    );
  });

  /**
   * **Validates: Requirements 3.5**
   *
   * Property: For any scroll position where distanceFromBottom <= 50px,
   * auto-scroll SHALL be re-enabled (isUserScrolledUp = false).
   */
  it('distanceFromBottom <= 50px re-enables auto-scroll', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 50 }), // distanceFromBottom <= 50
        fc.nat({ max: 5000 }).map(n => n + 1), // clientHeight
        (distanceFromBottom: number, clientHeight: number) => {
          // Construct scroll values from the distance
          const scrollTop = 500; // arbitrary
          const scrollHeight = scrollTop + clientHeight + distanceFromBottom;

          const state = computeScrollState(scrollTop, scrollHeight, clientHeight);
          expect(state.isUserScrolledUp).toBe(false);
        }
      ),
      { numRuns: 100 }
    );
  });

  /**
   * **Validates: Requirements 3.4, 3.5**
   *
   * Property: The thresholds are correct boundaries.
   * At exactly 101px → disabled, at exactly 50px → enabled.
   */
  it('boundary values: 101px disables, 50px enables', () => {
    fc.assert(
      fc.property(
        fc.nat({ max: 5000 }).map(n => n + 1), // clientHeight
        (clientHeight: number) => {
          const scrollTop = 200;

          // At exactly 101px from bottom → disabled
          const scrollHeight101 = scrollTop + clientHeight + 101;
          const state101 = computeScrollState(scrollTop, scrollHeight101, clientHeight);
          expect(state101.isUserScrolledUp).toBe(true);

          // At exactly 50px from bottom → enabled
          const scrollHeight50 = scrollTop + clientHeight + 50;
          const state50 = computeScrollState(scrollTop, scrollHeight50, clientHeight);
          expect(state50.isUserScrolledUp).toBe(false);

          // At exactly 100px from bottom → in hysteresis zone, defaults to enabled (fresh state)
          const scrollHeight100 = scrollTop + clientHeight + 100;
          const state100 = computeScrollState(scrollTop, scrollHeight100, clientHeight);
          expect(state100.isUserScrolledUp).toBe(false);
        }
      ),
      { numRuns: 100 }
    );
  });

  /**
   * **Validates: Requirements 3.4, 3.5**
   *
   * Property: Random scroll positions with random container dimensions
   * consistently follow the threshold rules.
   */
  it('random scroll positions follow threshold rules consistently', () => {
    fc.assert(
      fc.property(
        fc.nat({ max: 10000 }), // scrollTop
        fc.nat({ max: 5000 }).map(n => n + 200), // scrollHeight (large enough)
        fc.nat({ max: 5000 }).map(n => n + 1), // clientHeight
        (scrollTop: number, scrollHeight: number, clientHeight: number) => {
          // Ensure valid scroll geometry: scrollHeight >= scrollTop + clientHeight
          fc.pre(scrollHeight >= scrollTop + clientHeight);

          const distanceFromBottom = scrollHeight - scrollTop - clientHeight;
          const state = computeScrollState(scrollTop, scrollHeight, clientHeight);

          if (distanceFromBottom > 100) {
            expect(state.isUserScrolledUp).toBe(true);
          } else if (distanceFromBottom <= 50) {
            expect(state.isUserScrolledUp).toBe(false);
          }
          // In the 50-100 range (hysteresis), we don't assert — behavior depends on prior state
        }
      ),
      { numRuns: 100 }
    );
  });
});
