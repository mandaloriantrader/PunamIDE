/**
 * LoopGuard.ts — Phase 2: Agent Loop Detection
 *
 * Detects when the background agent is stuck in repetitive patterns:
 *   1. Identical model outputs across attempts (same response text hash)
 *   2. Identical file writes (same path + same content written twice)
 *   3. Same command failing repeatedly
 *   4. No-progress cycles (multiple attempts with no new files applied)
 *
 * When a loop is detected, the guard provides:
 *   - A diagnostic message explaining what pattern was detected
 *   - A corrective prompt to inject into the next model call
 *   - A recommendation (retry_with_hint | abort)
 *
 * Usage:
 *   const guard = new LoopGuard();
 *   guard.recordAttempt(responseHash, fileChanges, commands);
 *   const detection = guard.check();
 *   if (detection.loopDetected) { ... }
 */

// ── Types ──────────────────────────────────────────────────────────────────────

export interface LoopDetection {
  loopDetected: boolean;
  pattern: LoopPattern | null;
  message: string;
  /** Prompt to inject into the model to break the loop */
  correctivePrompt: string | null;
  /** What to do about it */
  recommendation: "continue" | "retry_with_hint" | "abort";
}

export type LoopPattern =
  | "identical_output"       // Model returned the same response 2+ times
  | "identical_file_write"   // Same file written with same content 2+ times
  | "repeated_command_fail"  // Same command failed 2+ times
  | "no_progress"            // 3+ attempts with zero files successfully applied
  | "oscillation";           // Alternating between two outputs

// ── Internal tracking ──────────────────────────────────────────────────────────

interface AttemptRecord {
  responseHash: string;
  fileHashes: Map<string, string>; // path → content hash
  commandResults: Map<string, boolean>; // command → success
  filesApplied: number;
  timestamp: number;
}

// ── LoopGuard ──────────────────────────────────────────────────────────────────

export class LoopGuard {
  private attempts: AttemptRecord[] = [];
  private readonly maxHistory = 10;

  /** Record one model attempt (call after getting results, before deciding to retry). */
  recordAttempt(
    responseHash: string,
    fileChanges: Array<{ path: string; contentHash: string; applied: boolean }>,
    commandResults: Array<{ command: string; success: boolean }>,
  ): void {
    const record: AttemptRecord = {
      responseHash,
      fileHashes: new Map(fileChanges.map(f => [f.path, f.contentHash])),
      commandResults: new Map(commandResults.map(c => [c.command, c.success])),
      filesApplied: fileChanges.filter(f => f.applied).length,
      timestamp: Date.now(),
    };

    this.attempts.push(record);

    // Keep bounded history
    if (this.attempts.length > this.maxHistory) {
      this.attempts.shift();
    }
  }

  /** Check if a loop pattern has been detected. Call after recordAttempt(). */
  check(): LoopDetection {
    if (this.attempts.length < 2) {
      return { loopDetected: false, pattern: null, message: "", correctivePrompt: null, recommendation: "continue" };
    }

    // Check patterns in priority order (most specific first)
    const identical = this.checkIdenticalOutput();
    if (identical) return identical;

    const fileLoop = this.checkIdenticalFileWrite();
    if (fileLoop) return fileLoop;

    const cmdFail = this.checkRepeatedCommandFail();
    if (cmdFail) return cmdFail;

    const noProgress = this.checkNoProgress();
    if (noProgress) return noProgress;

    const oscillation = this.checkOscillation();
    if (oscillation) return oscillation;

    return { loopDetected: false, pattern: null, message: "", correctivePrompt: null, recommendation: "continue" };
  }

  /** Reset guard state (new subtask or new session). */
  reset(): void {
    this.attempts = [];
  }

  /** Get attempt count for diagnostics. */
  getAttemptCount(): number {
    return this.attempts.length;
  }

  // ── Pattern Detectors ────────────────────────────────────────────────────

  private checkIdenticalOutput(): LoopDetection | null {
    const last = this.attempts[this.attempts.length - 1];
    const prev = this.attempts[this.attempts.length - 2];

    if (last.responseHash === prev.responseHash) {
      return {
        loopDetected: true,
        pattern: "identical_output",
        message: `Agent produced identical output on consecutive attempts (hash: ${last.responseHash.slice(0, 8)})`,
        correctivePrompt: [
          "IMPORTANT: Your previous response was identical to the one before it.",
          "The same approach is not working. You MUST try a fundamentally different strategy.",
          "Do NOT repeat the same file contents or commands.",
          "If you're stuck, explain what's blocking you instead of repeating the same output.",
        ].join("\n"),
        recommendation: "retry_with_hint",
      };
    }

    return null;
  }

  private checkIdenticalFileWrite(): LoopDetection | null {
    if (this.attempts.length < 2) return null;

    const last = this.attempts[this.attempts.length - 1];
    const prev = this.attempts[this.attempts.length - 2];

    // Find files written with identical content across both attempts
    const duplicateFiles: string[] = [];
    for (const [path, hash] of last.fileHashes) {
      if (prev.fileHashes.get(path) === hash) {
        duplicateFiles.push(path);
      }
    }

    if (duplicateFiles.length > 0 && duplicateFiles.length === last.fileHashes.size) {
      return {
        loopDetected: true,
        pattern: "identical_file_write",
        message: `Agent wrote identical content to ${duplicateFiles.length} file(s) on consecutive attempts: ${duplicateFiles.join(", ")}`,
        correctivePrompt: [
          `IMPORTANT: You wrote identical content to these files on your last attempt: ${duplicateFiles.join(", ")}`,
          "The output was already applied previously — writing the same thing again has no effect.",
          "Either the task is already complete (stop and say so), or your fix didn't address the issue.",
          "If there's a verification error, read it carefully and produce DIFFERENT corrected content.",
        ].join("\n"),
        recommendation: "retry_with_hint",
      };
    }

    return null;
  }

  private checkRepeatedCommandFail(): LoopDetection | null {
    if (this.attempts.length < 2) return null;

    const last = this.attempts[this.attempts.length - 1];
    const prev = this.attempts[this.attempts.length - 2];

    // Find commands that failed in both attempts
    const repeatedFails: string[] = [];
    for (const [cmd, success] of last.commandResults) {
      if (!success && prev.commandResults.get(cmd) === false) {
        repeatedFails.push(cmd);
      }
    }

    if (repeatedFails.length > 0) {
      return {
        loopDetected: true,
        pattern: "repeated_command_fail",
        message: `Same command(s) failed on consecutive attempts: ${repeatedFails.map(c => c.slice(0, 40)).join("; ")}`,
        correctivePrompt: [
          `IMPORTANT: These commands failed on your previous attempt too: ${repeatedFails.join(", ")}`,
          "Running the same failing command again will not fix anything.",
          "Either fix the underlying issue (wrong path, missing dependency, syntax error) before re-running,",
          "or use a different approach entirely.",
        ].join("\n"),
        recommendation: "retry_with_hint",
      };
    }

    return null;
  }

  private checkNoProgress(): LoopDetection | null {
    if (this.attempts.length < 3) return null;

    // Check last 3 attempts: if none applied any files, we're stuck
    const recentAttempts = this.attempts.slice(-3);
    const totalApplied = recentAttempts.reduce((sum, a) => sum + a.filesApplied, 0);

    if (totalApplied === 0) {
      return {
        loopDetected: true,
        pattern: "no_progress",
        message: `No files successfully applied in the last ${recentAttempts.length} attempts`,
        correctivePrompt: null, // No hint can help — just stop
        recommendation: "abort",
      };
    }

    return null;
  }

  private checkOscillation(): LoopDetection | null {
    if (this.attempts.length < 4) return null;

    // Pattern: A → B → A → B (alternating between two outputs)
    const a1 = this.attempts[this.attempts.length - 4].responseHash;
    const b1 = this.attempts[this.attempts.length - 3].responseHash;
    const a2 = this.attempts[this.attempts.length - 2].responseHash;
    const b2 = this.attempts[this.attempts.length - 1].responseHash;

    if (a1 === a2 && b1 === b2 && a1 !== b1) {
      return {
        loopDetected: true,
        pattern: "oscillation",
        message: "Agent is oscillating between two different outputs without making progress",
        correctivePrompt: [
          "IMPORTANT: You are alternating between two approaches, neither of which works.",
          "Stop and explain what's going wrong. Do not produce code.",
          "Describe the specific error or conflict that prevents progress.",
        ].join("\n"),
        recommendation: "abort",
      };
    }

    return null;
  }
}

// ── Singleton ──────────────────────────────────────────────────────────────────

let instance: LoopGuard | null = null;

export function getLoopGuard(): LoopGuard {
  if (!instance) {
    instance = new LoopGuard();
  }
  return instance;
}

export function resetLoopGuard(): void {
  instance?.reset();
}
