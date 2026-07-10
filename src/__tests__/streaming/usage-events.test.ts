import { describe, it, expect } from 'vitest';

// --- Types matching the design spec ---

interface UsageEvent {
  stream_id: string;
  input_tokens?: number;
  output_tokens?: number;
}

interface MessageMetrics {
  promptTokens?: number;
  responseTokens?: number;
  totalTokens?: number;
}

// --- Logic under test (simulated from design spec) ---

function processUsageEvent(
  event: UsageEvent,
  activeStreamId: string | null,
  currentMetrics: MessageMetrics | undefined
): { metrics: MessageMetrics | undefined; wasProcessed: boolean } {
  // Guard: only process if matches active stream
  if (event.stream_id !== activeStreamId) {
    return { metrics: currentMetrics, wasProcessed: false };
  }

  const updated: MessageMetrics = {
    promptTokens: event.input_tokens ?? currentMetrics?.promptTokens,
    responseTokens: event.output_tokens ?? currentMetrics?.responseTokens,
    totalTokens:
      (event.input_tokens ?? currentMetrics?.promptTokens ?? 0) +
      (event.output_tokens ?? currentMetrics?.responseTokens ?? 0),
  };

  return { metrics: updated, wasProcessed: true };
}

/**
 * Recalculate session totals from all message metrics.
 * Matches the requirement that session totals include accumulated token counts.
 */
function recalculateSessionTotals(
  allMessageMetrics: (MessageMetrics | undefined)[]
): { totalPromptTokens: number; totalResponseTokens: number; totalTokens: number } {
  let totalPromptTokens = 0;
  let totalResponseTokens = 0;

  for (const metrics of allMessageMetrics) {
    if (metrics) {
      totalPromptTokens += metrics.promptTokens ?? 0;
      totalResponseTokens += metrics.responseTokens ?? 0;
    }
  }

  return {
    totalPromptTokens,
    totalResponseTokens,
    totalTokens: totalPromptTokens + totalResponseTokens,
  };
}

// --- Tests ---

describe('Usage Event Flow', () => {
  describe('llm-stream-usage events with matching stream_id update message metrics', () => {
    it('should update promptTokens from input_tokens', () => {
      const event: UsageEvent = { stream_id: 'stream-abc', input_tokens: 150 };
      const result = processUsageEvent(event, 'stream-abc', undefined);

      expect(result.wasProcessed).toBe(true);
      expect(result.metrics).toBeDefined();
      expect(result.metrics!.promptTokens).toBe(150);
    });

    it('should update responseTokens from output_tokens', () => {
      const event: UsageEvent = { stream_id: 'stream-abc', output_tokens: 320 };
      const result = processUsageEvent(event, 'stream-abc', undefined);

      expect(result.wasProcessed).toBe(true);
      expect(result.metrics!.responseTokens).toBe(320);
    });

    it('should update both promptTokens and responseTokens when both provided', () => {
      const event: UsageEvent = { stream_id: 'stream-1', input_tokens: 100, output_tokens: 200 };
      const result = processUsageEvent(event, 'stream-1', undefined);

      expect(result.wasProcessed).toBe(true);
      expect(result.metrics!.promptTokens).toBe(100);
      expect(result.metrics!.responseTokens).toBe(200);
      expect(result.metrics!.totalTokens).toBe(300);
    });

    it('should calculate totalTokens as sum of input and output tokens', () => {
      const event: UsageEvent = { stream_id: 'stream-x', input_tokens: 42, output_tokens: 58 };
      const result = processUsageEvent(event, 'stream-x', undefined);

      expect(result.metrics!.totalTokens).toBe(100);
    });

    it('should merge with existing metrics when only input_tokens provided', () => {
      const existingMetrics: MessageMetrics = { promptTokens: 50, responseTokens: 200, totalTokens: 250 };
      const event: UsageEvent = { stream_id: 'stream-2', input_tokens: 75 };
      const result = processUsageEvent(event, 'stream-2', existingMetrics);

      expect(result.wasProcessed).toBe(true);
      expect(result.metrics!.promptTokens).toBe(75);
      expect(result.metrics!.responseTokens).toBe(200); // Retained from existing
      expect(result.metrics!.totalTokens).toBe(275);
    });

    it('should merge with existing metrics when only output_tokens provided', () => {
      const existingMetrics: MessageMetrics = { promptTokens: 100, responseTokens: 50, totalTokens: 150 };
      const event: UsageEvent = { stream_id: 'stream-3', output_tokens: 400 };
      const result = processUsageEvent(event, 'stream-3', existingMetrics);

      expect(result.wasProcessed).toBe(true);
      expect(result.metrics!.promptTokens).toBe(100); // Retained from existing
      expect(result.metrics!.responseTokens).toBe(400);
      expect(result.metrics!.totalTokens).toBe(500);
    });

    it('should handle event with zero tokens', () => {
      const event: UsageEvent = { stream_id: 'stream-z', input_tokens: 0, output_tokens: 0 };
      const result = processUsageEvent(event, 'stream-z', undefined);

      expect(result.wasProcessed).toBe(true);
      expect(result.metrics!.promptTokens).toBe(0);
      expect(result.metrics!.responseTokens).toBe(0);
      expect(result.metrics!.totalTokens).toBe(0);
    });
  });

  describe('events with stale/non-matching stream_id are discarded', () => {
    it('should not process event when stream_id does not match active stream', () => {
      const event: UsageEvent = { stream_id: 'stale-stream', input_tokens: 999, output_tokens: 888 };
      const result = processUsageEvent(event, 'active-stream', undefined);

      expect(result.wasProcessed).toBe(false);
      expect(result.metrics).toBeUndefined();
    });

    it('should return existing metrics unchanged when stream_id is stale', () => {
      const existingMetrics: MessageMetrics = { promptTokens: 50, responseTokens: 100, totalTokens: 150 };
      const event: UsageEvent = { stream_id: 'old-stream', input_tokens: 500, output_tokens: 600 };
      const result = processUsageEvent(event, 'current-stream', existingMetrics);

      expect(result.wasProcessed).toBe(false);
      expect(result.metrics).toBe(existingMetrics); // Same reference, no modification
    });

    it('should discard event when activeStreamId is null', () => {
      const event: UsageEvent = { stream_id: 'some-stream', input_tokens: 100 };
      const result = processUsageEvent(event, null, undefined);

      expect(result.wasProcessed).toBe(false);
      expect(result.metrics).toBeUndefined();
    });

    it('should discard event when stream_id is empty string and active is different', () => {
      const event: UsageEvent = { stream_id: '', input_tokens: 100 };
      const result = processUsageEvent(event, 'valid-stream', undefined);

      expect(result.wasProcessed).toBe(false);
    });
  });

  describe('session total recalculation includes accumulated token counts', () => {
    it('should sum all message metrics into session totals', () => {
      const messages: (MessageMetrics | undefined)[] = [
        { promptTokens: 100, responseTokens: 200, totalTokens: 300 },
        { promptTokens: 150, responseTokens: 350, totalTokens: 500 },
        { promptTokens: 80, responseTokens: 120, totalTokens: 200 },
      ];

      const totals = recalculateSessionTotals(messages);

      expect(totals.totalPromptTokens).toBe(330);
      expect(totals.totalResponseTokens).toBe(670);
      expect(totals.totalTokens).toBe(1000);
    });

    it('should handle messages without metrics (undefined)', () => {
      const messages: (MessageMetrics | undefined)[] = [
        { promptTokens: 50, responseTokens: 100, totalTokens: 150 },
        undefined,
        { promptTokens: 75, responseTokens: 200, totalTokens: 275 },
        undefined,
      ];

      const totals = recalculateSessionTotals(messages);

      expect(totals.totalPromptTokens).toBe(125);
      expect(totals.totalResponseTokens).toBe(300);
      expect(totals.totalTokens).toBe(425);
    });

    it('should return zero totals when no messages have metrics', () => {
      const messages: (MessageMetrics | undefined)[] = [undefined, undefined, undefined];

      const totals = recalculateSessionTotals(messages);

      expect(totals.totalPromptTokens).toBe(0);
      expect(totals.totalResponseTokens).toBe(0);
      expect(totals.totalTokens).toBe(0);
    });

    it('should handle empty message list', () => {
      const totals = recalculateSessionTotals([]);

      expect(totals.totalPromptTokens).toBe(0);
      expect(totals.totalResponseTokens).toBe(0);
      expect(totals.totalTokens).toBe(0);
    });

    it('should handle partial metrics (only promptTokens set)', () => {
      const messages: (MessageMetrics | undefined)[] = [
        { promptTokens: 100 },
        { promptTokens: 200, responseTokens: 50 },
      ];

      const totals = recalculateSessionTotals(messages);

      expect(totals.totalPromptTokens).toBe(300);
      expect(totals.totalResponseTokens).toBe(50);
      expect(totals.totalTokens).toBe(350);
    });

    it('should correctly accumulate after processing multiple usage events', () => {
      // Simulate processing multiple events for different streams and recalculating
      const event1: UsageEvent = { stream_id: 'stream-a', input_tokens: 100, output_tokens: 200 };
      const event2: UsageEvent = { stream_id: 'stream-b', input_tokens: 150, output_tokens: 300 };

      const result1 = processUsageEvent(event1, 'stream-a', undefined);
      const result2 = processUsageEvent(event2, 'stream-b', undefined);

      const totals = recalculateSessionTotals([result1.metrics, result2.metrics]);

      expect(totals.totalPromptTokens).toBe(250);
      expect(totals.totalResponseTokens).toBe(500);
      expect(totals.totalTokens).toBe(750);
    });
  });
});
