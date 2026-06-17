/**
 * VerificationRunner.ts — Phase 9, Step 9.4
 *
 * Sandbox execution via Docker — runs test suite against a proposed patch
 * and verifies it passes before human approval.
 *
 * Pipeline: PatchCandidate → Docker sandbox → run tests → report results
 *
 * Delegates to docker_controller.rs for container lifecycle.
 */

import { invoke } from "@tauri-apps/api/core";
import type { CiFixProposal } from "./CiMonitor";

// ── Types ──────────────────────────────────────────────────────────────────────

export interface DockerConfig {
  image: string;
  workDir: string;
  env: Record<string, string>;
  timeout: number; // seconds
}

export interface SandboxResult {
  passed: boolean;
  output: string;
  exitCode: number;
  durationMs: number;
  containerUsed: string | null;
}

export interface TestResults {
  passed: boolean;
  totalTests: number;
  passedTests: number;
  failedTests: number;
  output: string;
  durationMs: number;
}

export const DEFAULT_DOCKER_CONFIG: DockerConfig = {
  image: "node:20-slim",
  workDir: "/app",
  env: { CI: "true", NODE_ENV: "test" },
  timeout: 120,
};

// ── VerificationRunner Class ───────────────────────────────────────────────────

export class VerificationRunner {
  private config: DockerConfig;

  constructor(config?: Partial<DockerConfig>) {
    this.config = { ...DEFAULT_DOCKER_CONFIG, ...config };
  }

  /**
   * Run a patch in a Docker sandbox and execute the test suite.
   * Returns whether all tests pass.
   */
  async runInSandbox(proposal: CiFixProposal): Promise<SandboxResult> {
    const startTime = Date.now();

    try {
      // Delegate to Rust docker_controller for sandbox execution
      const result = await invoke<{ success: boolean; output: string; exit_code: number }>(
        "verify_fix_in_sandbox",
        {
          patch: proposal.patch,
          files: proposal.affectedFiles,
          image: this.config.image,
          timeout: this.config.timeout,
        }
      );

      return {
        passed: result.success && result.exit_code === 0,
        output: result.output,
        exitCode: result.exit_code,
        durationMs: Date.now() - startTime,
        containerUsed: this.config.image,
      };
    } catch (err) {
      return {
        passed: false,
        output: `Sandbox execution failed: ${err instanceof Error ? err.message : String(err)}`,
        exitCode: -1,
        durationMs: Date.now() - startTime,
        containerUsed: null,
      };
    }
  }

  /**
   * Run a specific test command in a sandbox.
   * Useful for targeted test verification.
   */
  async verifyTestSuite(
    testCommand: string,
    projectPath: string,
  ): Promise<TestResults> {
    const startTime = Date.now();

    try {
      const result = await invoke<{ success: boolean; output: string; exit_code: number }>(
        "run_terminal_command",
        { command: testCommand, cwd: projectPath }
      );

      const { total, passed, failed } = this.parseTestOutput(result.output);

      return {
        passed: result.exit_code === 0,
        totalTests: total,
        passedTests: passed,
        failedTests: failed,
        output: result.output,
        durationMs: Date.now() - startTime,
      };
    } catch (err) {
      return {
        passed: false,
        totalTests: 0,
        passedTests: 0,
        failedTests: 0,
        output: `Test execution failed: ${err instanceof Error ? err.message : String(err)}`,
        durationMs: Date.now() - startTime,
      };
    }
  }

  /**
   * Check if Docker is available for sandbox execution.
   */
  async isDockerAvailable(): Promise<boolean> {
    try {
      const result = await invoke<{ success: boolean }>("check_docker_available");
      return result.success;
    } catch {
      return false;
    }
  }

  /**
   * Update the Docker configuration.
   */
  setConfig(config: Partial<DockerConfig>): void {
    this.config = { ...this.config, ...config };
  }

  // ── Private ──────────────────────────────────────────────────────────────

  private parseTestOutput(output: string): { total: number; passed: number; failed: number } {
    // Try common test output patterns
    // Jest: Tests: X passed, Y failed, Z total
    const jestMatch = output.match(/Tests:\s*(\d+)\s*passed.*?(\d+)\s*failed.*?(\d+)\s*total/i);
    if (jestMatch) {
      return { passed: parseInt(jestMatch[1]), failed: parseInt(jestMatch[2]), total: parseInt(jestMatch[3]) };
    }

    // Vitest: X passed | Y failed (Z)
    const vitestMatch = output.match(/(\d+)\s*passed.*?(\d+)\s*failed/i);
    if (vitestMatch) {
      const passed = parseInt(vitestMatch[1]);
      const failed = parseInt(vitestMatch[2]);
      return { passed, failed, total: passed + failed };
    }

    // Cargo test: test result: ok. X passed; Y failed
    const cargoMatch = output.match(/(\d+)\s*passed;\s*(\d+)\s*failed/i);
    if (cargoMatch) {
      const passed = parseInt(cargoMatch[1]);
      const failed = parseInt(cargoMatch[2]);
      return { passed, failed, total: passed + failed };
    }

    // Fallback: count "PASS" and "FAIL" lines
    const passCount = (output.match(/✓|PASS|passed/gi) || []).length;
    const failCount = (output.match(/✗|FAIL|failed/gi) || []).length;
    return { passed: passCount, failed: failCount, total: passCount + failCount };
  }
}

// ── Singleton ──────────────────────────────────────────────────────────────────

let instance: VerificationRunner | null = null;

export function getVerificationRunner(config?: Partial<DockerConfig>): VerificationRunner {
  if (!instance) {
    instance = new VerificationRunner(config);
  }
  return instance;
}
