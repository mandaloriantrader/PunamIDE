import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import { areMessageBubblePropsEqual } from '../../components/chat/MessageBubble';
import type { MessageBubbleProps } from '../../components/chat/MessageBubble';
import type { BlockParseResult } from '../../utils/protocol';
import type { ChatMessage } from '../../types';

/**
 * Feature: streaming-architecture-fix
 * Property 3: MessageBubble Comparison Function Correctness
 *
 * Validates: Requirements 2.2, 2.3
 *
 * For any pair of MessageBubbleProps (prev, next):
 * - If isStreaming is false on both and message.id and message.content are equal,
 *   the comparison SHALL return true (skip re-render).
 * - If isStreaming is true on either and both isStreaming values are equal and
 *   streamingBlocks references are identical, the comparison SHALL return true.
 * - Otherwise it SHALL return false (allow re-render).
 */
describe('Feature: streaming-architecture-fix, Property 3: MessageBubble Comparison Function Correctness', () => {
  // Helper: generate a ChatMessage with a defined id
  const chatMessageArb = fc.record({
    id: fc.string({ minLength: 1, maxLength: 50 }),
    role: fc.constantFrom('user' as const, 'assistant' as const),
    content: fc.string({ minLength: 0, maxLength: 500 }),
  });

  // Helper: generate a BlockParseResult object
  const blockParseResultArb = fc.record({
    completed: fc.constant([]),
    inProgress: fc.constant(null),
  }) as fc.Arbitrary<BlockParseResult>;

  it('returns true when both isStreaming=false and message.id + message.content are equal', () => {
    fc.assert(
      fc.property(
        chatMessageArb,
        (msg) => {
          // Create two different message objects with same id and content
          const prevMsg: ChatMessage = { ...msg };
          const nextMsg: ChatMessage = { ...msg };

          const prev: MessageBubbleProps = { message: prevMsg, isStreaming: false };
          const next: MessageBubbleProps = { message: nextMsg, isStreaming: false };

          expect(areMessageBubblePropsEqual(prev, next)).toBe(true);
        }
      ),
      { numRuns: 100 }
    );
  });

  it('returns false when both isStreaming=false but message.id differs', () => {
    fc.assert(
      fc.property(
        chatMessageArb,
        fc.string({ minLength: 1, maxLength: 50 }),
        (msg, differentId) => {
          // Ensure IDs are actually different
          fc.pre(differentId !== msg.id);

          const prevMsg: ChatMessage = { ...msg };
          const nextMsg: ChatMessage = { ...msg, id: differentId };

          const prev: MessageBubbleProps = { message: prevMsg, isStreaming: false };
          const next: MessageBubbleProps = { message: nextMsg, isStreaming: false };

          expect(areMessageBubblePropsEqual(prev, next)).toBe(false);
        }
      ),
      { numRuns: 100 }
    );
  });

  it('returns false when both isStreaming=false but message.content differs', () => {
    fc.assert(
      fc.property(
        chatMessageArb,
        fc.string({ minLength: 0, maxLength: 500 }),
        (msg, differentContent) => {
          // Ensure content is actually different
          fc.pre(differentContent !== msg.content);

          const prevMsg: ChatMessage = { ...msg };
          const nextMsg: ChatMessage = { ...msg, content: differentContent };

          const prev: MessageBubbleProps = { message: prevMsg, isStreaming: false };
          const next: MessageBubbleProps = { message: nextMsg, isStreaming: false };

          expect(areMessageBubblePropsEqual(prev, next)).toBe(false);
        }
      ),
      { numRuns: 100 }
    );
  });

  it('returns true when either isStreaming=true, isStreaming values match, and streamingBlocks reference is identical', () => {
    fc.assert(
      fc.property(
        chatMessageArb,
        chatMessageArb,
        blockParseResultArb,
        (prevMsg, nextMsg, blocks) => {
          // Same shared reference for streamingBlocks
          const prev: MessageBubbleProps = {
            message: prevMsg,
            isStreaming: true,
            streamingBlocks: blocks,
          };
          const next: MessageBubbleProps = {
            message: nextMsg,
            isStreaming: true,
            streamingBlocks: blocks, // identical reference
          };

          expect(areMessageBubblePropsEqual(prev, next)).toBe(true);
        }
      ),
      { numRuns: 100 }
    );
  });

  it('returns false when both isStreaming=true but streamingBlocks references differ', () => {
    fc.assert(
      fc.property(
        chatMessageArb,
        chatMessageArb,
        blockParseResultArb,
        blockParseResultArb,
        (prevMsg, nextMsg, blocks1, blocks2) => {
          // Two separate objects — different references even if content is the same
          const prev: MessageBubbleProps = {
            message: prevMsg,
            isStreaming: true,
            streamingBlocks: blocks1,
          };
          const next: MessageBubbleProps = {
            message: nextMsg,
            isStreaming: true,
            streamingBlocks: blocks2, // different reference
          };

          // Different references should return false (allow re-render)
          expect(areMessageBubblePropsEqual(prev, next)).toBe(false);
        }
      ),
      { numRuns: 100 }
    );
  });

  it('returns false when isStreaming values differ (prev=true, next=false)', () => {
    fc.assert(
      fc.property(
        chatMessageArb,
        blockParseResultArb,
        (msg, blocks) => {
          const prev: MessageBubbleProps = {
            message: msg,
            isStreaming: true,
            streamingBlocks: blocks,
          };
          const next: MessageBubbleProps = {
            message: msg,
            isStreaming: false,
          };

          expect(areMessageBubblePropsEqual(prev, next)).toBe(false);
        }
      ),
      { numRuns: 100 }
    );
  });

  it('returns false when isStreaming values differ (prev=false, next=true)', () => {
    fc.assert(
      fc.property(
        chatMessageArb,
        blockParseResultArb,
        (msg, blocks) => {
          const prev: MessageBubbleProps = {
            message: msg,
            isStreaming: false,
          };
          const next: MessageBubbleProps = {
            message: msg,
            isStreaming: true,
            streamingBlocks: blocks,
          };

          expect(areMessageBubblePropsEqual(prev, next)).toBe(false);
        }
      ),
      { numRuns: 100 }
    );
  });

  it('comprehensive: comparison function matches specification for all generated prop combinations', () => {
    fc.assert(
      fc.property(
        fc.boolean(),
        fc.boolean(),
        chatMessageArb,
        chatMessageArb,
        fc.boolean(), // whether to share streamingBlocks reference
        blockParseResultArb,
        (prevStreaming, nextStreaming, prevMsg, nextMsg, shareBlocks, blocks) => {
          const blocks2: BlockParseResult = { completed: [], inProgress: null };
          const prevBlocks = blocks;
          const nextBlocks = shareBlocks ? blocks : blocks2;

          const prev: MessageBubbleProps = {
            message: prevMsg,
            isStreaming: prevStreaming,
            streamingBlocks: prevBlocks,
          };
          const next: MessageBubbleProps = {
            message: nextMsg,
            isStreaming: nextStreaming,
            streamingBlocks: nextBlocks,
          };

          const result = areMessageBubblePropsEqual(prev, next);

          // Compute expected result based on the specification
          let expected: boolean;
          if (prevStreaming || nextStreaming) {
            // Streaming case: true if isStreaming matches AND streamingBlocks is same reference
            expected = prevStreaming === nextStreaming && prevBlocks === nextBlocks;
          } else {
            // Completed case: true if id and content match
            // The implementation uses id equality when both ids are defined
            const idMatch = prevMsg.id !== undefined && nextMsg.id !== undefined
              ? prevMsg.id === nextMsg.id
              : prevMsg === nextMsg; // reference fallback when id undefined
            expected = idMatch && prevMsg.content === nextMsg.content;
          }

          expect(result).toBe(expected);
        }
      ),
      { numRuns: 100 }
    );
  });
});
