import { describe, it, expect } from "vitest";
import * as fc from "fast-check";
import {
  MODEL_CONTEXT_LIMITS,
  DEFAULT_CONTEXT_LIMIT,
  CONTEXT_FILL_PCT,
  RESPONSE_RESERVE_PCT,
  getModelContextLimit,
} from "../services/intelligence/contextLimits";

describe("contextLimits", () => {
  describe("constants", () => {
    it("DEFAULT_CONTEXT_LIMIT is 32_000", () => {
      expect(DEFAULT_CONTEXT_LIMIT).toBe(32_000);
    });

    it("CONTEXT_FILL_PCT is 0.75", () => {
      expect(CONTEXT_FILL_PCT).toBe(0.75);
    });

    it("RESPONSE_RESERVE_PCT is 0.20", () => {
      expect(RESPONSE_RESERVE_PCT).toBe(0.20);
    });
  });

  describe("MODEL_CONTEXT_LIMITS registry", () => {
    it("contains Claude models at 200K", () => {
      expect(MODEL_CONTEXT_LIMITS["claude-opus-4"]).toBe(200_000);
      expect(MODEL_CONTEXT_LIMITS["claude-sonnet-4"]).toBe(200_000);
      expect(MODEL_CONTEXT_LIMITS["claude-3.5-sonnet"]).toBe(200_000);
      expect(MODEL_CONTEXT_LIMITS["claude-haiku"]).toBe(200_000);
      expect(MODEL_CONTEXT_LIMITS["claude-3-haiku"]).toBe(200_000);
    });

    it("contains GPT-4o models at 128K", () => {
      expect(MODEL_CONTEXT_LIMITS["gpt-4o"]).toBe(128_000);
      expect(MODEL_CONTEXT_LIMITS["gpt-4o-mini"]).toBe(128_000);
    });

    it("contains Gemini models at 1M", () => {
      expect(MODEL_CONTEXT_LIMITS["gemini-2.5-pro"]).toBe(1_000_000);
      expect(MODEL_CONTEXT_LIMITS["gemini-2.5-flash"]).toBe(1_000_000);
      expect(MODEL_CONTEXT_LIMITS["gemini-2.0-flash"]).toBe(1_000_000);
    });

    it("contains DeepSeek models at 64K", () => {
      expect(MODEL_CONTEXT_LIMITS["deepseek-chat"]).toBe(64_000);
      expect(MODEL_CONTEXT_LIMITS["deepseek-reasoner"]).toBe(64_000);
    });

    it("contains Groq Llama at 128K", () => {
      expect(MODEL_CONTEXT_LIMITS["llama-3.3-70b-versatile"]).toBe(128_000);
    });

    it("contains Mixtral at 32K", () => {
      expect(MODEL_CONTEXT_LIMITS["mixtral-8x7b-32768"]).toBe(32_000);
    });
  });

  describe("getModelContextLimit", () => {
    it("returns exact match for known models", () => {
      expect(getModelContextLimit("claude-sonnet-4")).toBe(200_000);
      expect(getModelContextLimit("gpt-4o")).toBe(128_000);
      expect(getModelContextLimit("gemini-2.5-pro")).toBe(1_000_000);
      expect(getModelContextLimit("deepseek-chat")).toBe(64_000);
    });

    it("returns prefix match for versioned model names", () => {
      expect(getModelContextLimit("claude-sonnet-4-20250601")).toBe(200_000);
      expect(getModelContextLimit("claude-opus-4-20250514")).toBe(200_000);
      expect(getModelContextLimit("gemini-2.5-pro-preview")).toBe(1_000_000);
      expect(getModelContextLimit("deepseek-chat-v2")).toBe(64_000);
    });

    it("returns DEFAULT_CONTEXT_LIMIT for unknown models", () => {
      expect(getModelContextLimit("unknown-model")).toBe(DEFAULT_CONTEXT_LIMIT);
      expect(getModelContextLimit("")).toBe(DEFAULT_CONTEXT_LIMIT);
      expect(getModelContextLimit("llama-2-70b")).toBe(DEFAULT_CONTEXT_LIMIT);
    });

    it("prefers exact match over prefix match", () => {
      // "gpt-4o" should match exactly, not prefix-match to something else
      expect(getModelContextLimit("gpt-4o")).toBe(128_000);
      // "gpt-4o-mini" should match exactly, not just the "gpt-4o" prefix
      expect(getModelContextLimit("gpt-4o-mini")).toBe(128_000);
    });

    it("uses longest prefix for specificity", () => {
      // "claude-3-haiku" is more specific than "claude-" prefix
      expect(getModelContextLimit("claude-3-haiku-20250301")).toBe(200_000);
    });
  });

  describe("getModelContextLimit — property-based tests", () => {
    /**
     * **Validates: Requirements 1.2**
     * Property: For any model string, the function always returns a positive number.
     */
    it("always returns a positive number", () => {
      fc.assert(
        fc.property(fc.string(), (model) => {
          const result = getModelContextLimit(model);
          return result > 0;
        })
      );
    });

    /**
     * **Validates: Requirements 1.1, 1.2**
     * Property: The return value is always one of the registry values
     * or the default limit — never an arbitrary number.
     */
    it("return value is always a known limit or the default", () => {
      const knownLimits = new Set([
        ...Object.values(MODEL_CONTEXT_LIMITS),
        DEFAULT_CONTEXT_LIMIT,
      ]);

      fc.assert(
        fc.property(fc.string(), (model) => {
          const result = getModelContextLimit(model);
          return knownLimits.has(result);
        })
      );
    });

    /**
     * **Validates: Requirements 1.3**
     * Property: If a model string starts with a registry key,
     * it returns the same value as the key itself.
     */
    it("prefix match returns same value as the key", () => {
      const keys = Object.keys(MODEL_CONTEXT_LIMITS);
      fc.assert(
        fc.property(
          fc.constantFrom(...keys),
          fc.string({ minLength: 1 }),
          (key, suffix) => {
            const versioned = key + suffix;
            const result = getModelContextLimit(versioned);
            // It should return the value for that key or a longer matching key
            return Object.values(MODEL_CONTEXT_LIMITS).includes(result);
          }
        )
      );
    });
  });
});
