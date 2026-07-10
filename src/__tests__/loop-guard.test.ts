/**
 * Unit tests for LoopGuard — agent loop detection system.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { LoopGuard } from "../services/agent/LoopGuard";

describe("LoopGuard", () => {
  let guard: LoopGuard;

  beforeEach(() => {
    guard = new LoopGuard();
  });

  describe("no loop detected", () => {
    it("returns no loop on first attempt", () => {
      guard.recordAttempt("hash-1", [], []);
      const result = guard.check();
      expect(result.loopDetected).toBe(false);
      expect(result.recommendation).toBe("continue");
    });

    it("returns no loop when outputs differ", () => {
      guard.recordAttempt("hash-1", [], []);
      guard.recordAttempt("hash-2", [], []);
      const result = guard.check();
      expect(result.loopDetected).toBe(false);
    });
  });

  describe("identical_output detection", () => {
    it("detects same response hash on consecutive attempts", () => {
      guard.recordAttempt("same-hash", [], []);
      guard.recordAttempt("same-hash", [], []);
      const result = guard.check();
      expect(result.loopDetected).toBe(true);
      expect(result.pattern).toBe("identical_output");
      expect(result.recommendation).toBe("retry_with_hint");
      expect(result.correctivePrompt).toBeTruthy();
    });

    it("does not trigger if hashes differ", () => {
      guard.recordAttempt("hash-a", [], []);
      guard.recordAttempt("hash-b", [], []);
      const result = guard.check();
      expect(result.loopDetected).toBe(false);
    });
  });

  describe("identical_file_write detection", () => {
    it("detects same file written with same content twice", () => {
      guard.recordAttempt("resp-1", [
        { path: "src/App.tsx", contentHash: "abc123", applied: true },
      ], []);
      guard.recordAttempt("resp-2", [
        { path: "src/App.tsx", contentHash: "abc123", applied: true },
      ], []);
      const result = guard.check();
      expect(result.loopDetected).toBe(true);
      expect(result.pattern).toBe("identical_file_write");
      expect(result.recommendation).toBe("retry_with_hint");
    });

    it("does not trigger if file content differs", () => {
      guard.recordAttempt("resp-1", [
        { path: "src/App.tsx", contentHash: "abc123", applied: true },
      ], []);
      guard.recordAttempt("resp-2", [
        { path: "src/App.tsx", contentHash: "def456", applied: true },
      ], []);
      const result = guard.check();
      // identical_output won't trigger (different resp hashes)
      // identical_file_write won't trigger (different content hashes)
      expect(result.pattern).not.toBe("identical_file_write");
    });
  });

  describe("repeated_command_fail detection", () => {
    it("detects same command failing on consecutive attempts", () => {
      guard.recordAttempt("resp-1", [], [
        { command: "npm run build", success: false },
      ]);
      guard.recordAttempt("resp-2", [], [
        { command: "npm run build", success: false },
      ]);
      const result = guard.check();
      expect(result.loopDetected).toBe(true);
      expect(result.pattern).toBe("repeated_command_fail");
      expect(result.recommendation).toBe("retry_with_hint");
    });

    it("does not trigger if command succeeds on second attempt", () => {
      guard.recordAttempt("resp-1", [], [
        { command: "npm run build", success: false },
      ]);
      guard.recordAttempt("resp-2", [], [
        { command: "npm run build", success: true },
      ]);
      const result = guard.check();
      expect(result.pattern).not.toBe("repeated_command_fail");
    });
  });

  describe("no_progress detection", () => {
    it("detects 3 attempts with zero files applied", () => {
      guard.recordAttempt("r1", [{ path: "a.ts", contentHash: "x", applied: false }], []);
      guard.recordAttempt("r2", [{ path: "b.ts", contentHash: "y", applied: false }], []);
      guard.recordAttempt("r3", [{ path: "c.ts", contentHash: "z", applied: false }], []);
      const result = guard.check();
      expect(result.loopDetected).toBe(true);
      expect(result.pattern).toBe("no_progress");
      expect(result.recommendation).toBe("abort");
    });

    it("does not trigger if at least one file was applied", () => {
      guard.recordAttempt("r1", [{ path: "a.ts", contentHash: "x", applied: false }], []);
      guard.recordAttempt("r2", [{ path: "b.ts", contentHash: "y", applied: true }], []);
      guard.recordAttempt("r3", [{ path: "c.ts", contentHash: "z", applied: false }], []);
      const result = guard.check();
      expect(result.pattern).not.toBe("no_progress");
    });
  });

  describe("oscillation detection", () => {
    it("detects A-B-A-B pattern over 4 attempts", () => {
      guard.recordAttempt("hash-A", [{ path: "x.ts", contentHash: "a", applied: true }], []);
      guard.recordAttempt("hash-B", [{ path: "y.ts", contentHash: "b", applied: true }], []);
      guard.recordAttempt("hash-A", [{ path: "x.ts", contentHash: "a", applied: true }], []);
      guard.recordAttempt("hash-B", [{ path: "y.ts", contentHash: "b", applied: true }], []);
      const result = guard.check();
      expect(result.loopDetected).toBe(true);
      expect(result.pattern).toBe("oscillation");
      expect(result.recommendation).toBe("abort");
    });

    it("does not trigger with non-alternating patterns", () => {
      guard.recordAttempt("hash-A", [], []);
      guard.recordAttempt("hash-B", [], []);
      guard.recordAttempt("hash-C", [], []);
      guard.recordAttempt("hash-D", [], []);
      const result = guard.check();
      expect(result.pattern).not.toBe("oscillation");
    });
  });

  describe("reset", () => {
    it("clears all history", () => {
      guard.recordAttempt("same", [], []);
      guard.recordAttempt("same", [], []);
      expect(guard.check().loopDetected).toBe(true);

      guard.reset();
      expect(guard.getAttemptCount()).toBe(0);
      expect(guard.check().loopDetected).toBe(false);
    });
  });
});
