/**
 * LogAnalyzer.ts — Phase 9, Step 9.2
 *
 * Feeds CI failure logs to LLM, extracts root cause, identifies failing
 * file and error type. Delegates to CiMonitor's analyzeFailure() internally.
 *
 * Provides:
 *   - analyzeCiFailure(): Parse raw CI logs and extract structured failure info
 *   - extractRootCause(): Pull the most specific error from log output
 *   - extractFailingFile(): Identify the file that caused the failure
 */

import { getCiMonitor } from "./CiMonitor";
import type { CiWorkflowRun, CiFailureAnalysis } from "./CiMonitor";

// ── Types ──────────────────────────────────────────────────────────────────────

export interface FailureAnalysis {
  rootCause: string;
  failingStep: string;
  failingFile: string | null;
  errorType: ErrorType;
  errorLog: string;
  confidence: number;
  suggestions: string[];
}

export type ErrorType =
  | "compilation"
  | "test_failure"
  | "lint"
  | "type_check"
  | "runtime"
  | "dependency"
  | "timeout"
  | "unknown";

// ── LogAnalyzer Class ──────────────────────────────────────────────────────────

export class LogAnalyzer {
  /**
   * Analyze a CI failure from a workflow run.
   * Delegates to CiMonitor for log fetching, then enriches with error classification.
   */
  async analyzeCiFailure(run: CiWorkflowRun): Promise<FailureAnalysis> {
    const monitor = getCiMonitor();
    const analysis = await monitor.analyzeFailure(run);

    return {
      rootCause: analysis.rootCause,
      failingStep: analysis.failingStep,
      failingFile: analysis.failingFile,
      errorType: this.classifyError(analysis.errorLog),
      errorLog: analysis.errorLog,
      confidence: analysis.confidence,
      suggestions: this.generateSuggestions(analysis),
    };
  }

  /**
   * Extract the root cause from raw log output.
   */
  extractRootCause(log: string): string {
    const errorLines = log
      .split("\n")
      .filter((l) =>
        l.toLowerCase().includes("error") ||
        l.toLowerCase().includes("fail") ||
        l.toLowerCase().includes("fatal")
      )
      .slice(-5);

    if (errorLines.length === 0) return "No specific error found in logs";

    // Clean ANSI codes and return the most specific error
    const clean = errorLines.map((l) =>
      l.replace(/\x1B\[[0-9;]*[a-zA-Z]/g, "").trim()
    );
    return clean[clean.length - 1] || clean[0];
  }

  /**
   * Extract the failing file path from log output.
   */
  extractFailingFile(log: string): string | null {
    const patterns = [
      /([a-zA-Z0-9_/\\.-]+\.[a-z]{2,5}):(\d+):\d+/,
      /at\s+(?:Object\.)?(?:<anonymous>|[\w.]+)\s+\(([^)]+\.[a-z]{2,5}):\d+:\d+\)/,
      /File "([^"]+)"/,
      /--> ([^<\s]+\.\w+)/,
      /FAILED\s+([^\s]+\.[a-z]{2,5})/i,
    ];

    for (const pattern of patterns) {
      const match = log.match(pattern);
      if (match) return match[1];
    }

    return null;
  }

  // ── Private ──────────────────────────────────────────────────────────────

  private classifyError(log: string): ErrorType {
    const lower = log.toLowerCase();

    if (lower.includes("tsc") || lower.includes("type error") || lower.includes("ts(")) {
      return "type_check";
    }
    if (lower.includes("eslint") || lower.includes("lint")) {
      return "lint";
    }
    if (lower.includes("test") && (lower.includes("fail") || lower.includes("assert"))) {
      return "test_failure";
    }
    if (lower.includes("compile") || lower.includes("build") || lower.includes("cannot find module")) {
      return "compilation";
    }
    if (lower.includes("timeout") || lower.includes("timed out")) {
      return "timeout";
    }
    if (lower.includes("npm err") || lower.includes("cargo") || lower.includes("dependency")) {
      return "dependency";
    }
    if (lower.includes("runtime") || lower.includes("uncaught") || lower.includes("panic")) {
      return "runtime";
    }

    return "unknown";
  }

  private generateSuggestions(analysis: CiFailureAnalysis): string[] {
    const suggestions: string[] = [];

    if (analysis.failingFile) {
      suggestions.push(`Check ${analysis.failingFile} for the reported error`);
    }
    if (analysis.rootCause.includes("not found") || analysis.rootCause.includes("missing")) {
      suggestions.push("Run dependency install (npm install / cargo build) before CI");
    }
    if (analysis.rootCause.includes("type") || analysis.rootCause.includes("TS")) {
      suggestions.push("Run tsc --noEmit locally to reproduce type errors");
    }
    if (analysis.confidence < 0.5) {
      suggestions.push("Low confidence — manual log review recommended");
    }

    return suggestions;
  }
}

// ── Singleton ──────────────────────────────────────────────────────────────────

let instance: LogAnalyzer | null = null;

export function getLogAnalyzer(): LogAnalyzer {
  if (!instance) {
    instance = new LogAnalyzer();
  }
  return instance;
}
