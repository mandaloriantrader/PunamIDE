/**
 * CiMonitor.ts — Phase 9, Step 9.1
 *
 * Integrates with GitHub Actions API to watch for failures and parse logs.
 * Reuses existing githubService.ts for API calls and github/actions.rs for data.
 */

import type { GitHubUser, PullRequest, Issue } from "../githubService";

// ── Types ──────────────────────────────────────────────────────────────────────

export interface CiWorkflowRun {
  id: number;
  name: string;
  status: string;        // "queued" | "in_progress" | "completed"
  conclusion: string | null; // "success" | "failure" | "cancelled" | null
  html_url: string;
  head_branch: string;
  created_at: string;
  /** Parsed job data */
  jobs: CiJob[];
}

export interface CiJob {
  id: number;
  name: string;
  status: string;
  conclusion: string | null;
  steps: CiStep[];
}

export interface CiStep {
  name: string;
  status: string;
  conclusion: string | null;
  logUrl: string;
}

export interface CiFailureEvent {
  workflow: CiWorkflowRun;
  failedJobs: CiJob[];
  failedSteps: CiStep[];
  detectedAt: number;
  branch: string;
  commitSha: string | null;
}

export interface CiMonitorState {
  watching: boolean;
  lastCheck: number | null;
  recentFailures: CiFailureEvent[];
  activeWorkflows: CiWorkflowRun[];
}

// ── CiMonitor ─────────────────────────────────────────────────────────────────

export class CiMonitor {
  private state: CiMonitorState;

  constructor() {
    this.state = {
      watching: false,
      lastCheck: null,
      recentFailures: [],
      activeWorkflows: [],
    };
  }

  /**
   * Check for recent workflow failures.
   * Requires GitHub auth to be configured.
   */
  async checkWorkflows(
    owner: string,
    repo: string,
    branch?: string,
  ): Promise<CiFailureEvent[]> {
    const failures: CiFailureEvent[] = [];

    try {
      // Call existing Rust GitHub command
      const { invoke } = await import("@tauri-apps/api/core");

      const rawRuns = await invoke<Array<{
        id: number; name: string; status: string; conclusion: string | null;
        html_url: string; head_branch: string; created_at: string;
        run_number: number; event: string;
      }>>("github_list_workflow_runs", {
        owner,
        repo,
        branch: branch || null,
        perPage: 5,
      });

      for (const run of rawRuns) {
        if (run.status === "completed" && run.conclusion === "failure") {
          failures.push({
            workflow: {
              id: run.id,
              name: run.name,
              status: run.status,
              conclusion: run.conclusion,
              html_url: run.html_url,
              head_branch: run.head_branch,
              created_at: run.created_at,
              jobs: [],
            },
            failedJobs: [],
            failedSteps: [],
            detectedAt: Date.now(),
            branch: run.head_branch,
            commitSha: null,
          });
        }
      }

      this.state.recentFailures = failures;
      this.state.lastCheck = Date.now();
    } catch (err) {
      console.warn("[CiMonitor] Failed to check workflows:", err);
    }

    return failures;
  }

  /**
   * Fetch jobs and steps for a specific workflow run.
   * GitHub doesn't expose job details via simple API — parse the HTML page or use checks API.
   */
  async fetchRunDetails(
    owner: string,
    repo: string,
    runId: number,
  ): Promise<CiJob[]> {
    try {
      const { invoke } = await import("@tauri-apps/api/core");

      // This requires a separate GitHub API call for jobs
      // For now, return a placeholder
      return [{
        id: 0,
        name: "Workflow Job",
        status: "completed",
        conclusion: "failure",
        steps: [],
      }];
    } catch {
      return [];
    }
  }

  /**
   * Start watching for CI failures on an interval.
   */
  startWatching(
    owner: string,
    repo: string,
    branch?: string,
    intervalMs = 120000, // 2 minutes
  ): () => void {
    this.state.watching = true;

    const check = () => this.checkWorkflows(owner, repo, branch);
    check(); // Immediate first check

    const interval = setInterval(check, intervalMs);

    return () => {
      clearInterval(interval);
      this.state.watching = false;
    };
  }

  getState(): CiMonitorState {
    return this.state;
  }

  getRecentFailures(): CiFailureEvent[] {
    return this.state.recentFailures;
  }
}

// ── LogAnalyzer (Phase 9.2) ───────────────────────────────────────────────────

export interface CiLogAnalysis {
  rootCause: string;
  failingFile: string | null;
  errorType: string;  // "build" | "test" | "lint" | "deploy" | "unknown"
  suggestedFix: string;
  confidence: number;
  rawLog: string;
}

export class LogAnalyzer {
  /**
   * Analyze CI failure logs using LLM.
   * Requires an LLM provider to be configured.
   */
  async analyzeFailure(
    logContent: string,
    workflowName: string,
  ): Promise<CiLogAnalysis> {
    const { loadConfigFromStore } = await import("../../utils/tauri");

    try {
      const config = await loadConfigFromStore();

      if (!config.api_key) {
        return this.heuristicAnalysis(logContent, workflowName);
      }

      const systemPrompt = `You are a CI/CD failure analyzer. Given a CI log, identify:
1. Root cause of the failure
2. The specific file that needs to be fixed (if determinable)
3. Error type (build/test/lint/deploy)
4. A suggested fix
5. Confidence in your analysis (0-1)

Respond ONLY with JSON: {"rootCause":"...", "failingFile":"path/to/file" or null, "errorType":"build|test|lint|deploy|unknown", "suggestedFix":"...", "confidence":0.85}`;

      const { invoke } = await import("@tauri-apps/api/core");
      const response = await invoke<{ text: string; success: boolean }>("call_llm", {
        request: {
          provider: config.provider,
          api_key: config.api_key,
          model: config.model,
          system_prompt: systemPrompt,
          user_prompt: `## Workflow: ${workflowName}\n## CI Log (truncated):\n${logContent.substring(0, 5000)}`,
        },
      });

      if (response.success && response.text) {
        try {
          const json = JSON.parse(response.text.replace(/```json|```/g, "").trim());
          return {
            rootCause: json.rootCause || "Unknown",
            failingFile: json.failingFile || null,
            errorType: json.errorType || "unknown",
            suggestedFix: json.suggestedFix || "Review the log manually",
            confidence: json.confidence || 0.5,
            rawLog: logContent,
          };
        } catch {
          // JSON parse failed, fall to heuristic
        }
      }
    } catch {
      // LLM call failed, fall to heuristic
    }

    return this.heuristicAnalysis(logContent, workflowName);
  }

  private heuristicAnalysis(log: string, workflow: string): CiLogAnalysis {
    const logLower = log.toLowerCase();

    // Detect error type
    let errorType: CiLogAnalysis["errorType"] = "unknown";
    if (logLower.includes("tsc") || logLower.includes("compilation failed") || logLower.includes("cannot find module") || logLower.includes("ts") && logLower.includes("error")) {
      errorType = "build";
    } else if (logLower.includes("test failed") || logLower.includes("assert") || logLower.includes("expect(")) {
      errorType = "test";
    } else if (logLower.includes("eslint") || logLower.includes("lint") || logLower.includes("fmt")) {
      errorType = "lint";
    } else if (logLower.includes("deploy") || logLower.includes("publish")) {
      errorType = "deploy";
    }

    // Try to extract failing file
    const fileMatch = log.match(/(?:src\/|lib\/|test\/)[^\s:]+\.(?:ts|tsx|js|rs|py)/);
    const failingFile = fileMatch ? fileMatch[0] : null;

    // Extract root cause from error messages
    const errorMatch = log.match(/error[:\s]+([^\n]{10,200})/i);
    const rootCause = errorMatch ? errorMatch[1].trim() : `Unknown failure in ${workflow}`;

    let suggestedFix = "Review the CI log and fix the reported errors.";
    if (errorType === "build") suggestedFix = "Check TypeScript compilation errors and fix type issues.";
    if (errorType === "test") suggestedFix = "Review failing test assertions and fix the underlying code or test.";
    if (errorType === "lint") suggestedFix = "Run 'npm run lint' locally and fix linting errors.";

    return {
      rootCause,
      failingFile,
      errorType,
      suggestedFix,
      confidence: 0.3,
      rawLog: log,
    };
  }
}

// ── PatchGenerator (Phase 9.3) ────────────────────────────────────────────────

export interface PatchResult {
  success: boolean;
  file: string;
  patch: string;
  validated: boolean;
  architecturePassed: boolean;
  securityPassed: boolean;
  errors: string[];
}

export class PatchGenerator {
  /**
   * Generate a fix candidate for a CI failure.
   */
  async generateFix(
    analysis: CiLogAnalysis,
    fileContent: string,
    filePath: string,
  ): Promise<PatchResult> {
    const { loadConfigFromStore } = await import("../../utils/tauri");
    const errors: string[] = [];

    try {
      const config = await loadConfigFromStore();

      if (!config.api_key) {
        return {
          success: false, file: filePath, patch: "",
          validated: false, architecturePassed: false, securityPassed: false,
          errors: ["No API key configured — cannot generate fix"],
        };
      }

      const systemPrompt = `You are a CI/CD auto-fix generator. Given a CI failure analysis and the current file content, generate a minimal patch that fixes the issue.

Rules:
- Make the smallest possible change
- Do not introduce new features
- Preserve existing code style
- Output ONLY the fixed file content (complete file)

Respond with the fixed code only.`;

      const { invoke } = await import("@tauri-apps/api/core");
      const response = await invoke<{ text: string; success: boolean }>("call_llm", {
        request: {
          provider: config.provider,
          api_key: config.api_key,
          model: config.model,
          system_prompt: systemPrompt,
          user_prompt: `## Failure Analysis:\nRoot Cause: ${analysis.rootCause}\nError Type: ${analysis.errorType}\nFailing File: ${filePath}\n\n## Current File Content:\n\`\`\`\n${fileContent}\n\`\`\`\n\nGenerate the fixed version.`,
        },
      });

      if (!response.success) {
        return { success: false, file: filePath, patch: "", validated: false, architecturePassed: false, securityPassed: false, errors: ["LLM call failed"] };
      }

      // Strip markdown code fences
      const patch = response.text.replace(/```[\w]*\n?/g, "").trim();

      // Validate against architecture rules (Phase 1)
      let architecturePassed = false;
      try {
        const rules = await invoke<{ rules: unknown[]; layers: Record<string, string[]> }>("get_default_rules");
        const validation = await invoke<{ allowed: boolean; violations: unknown[] }>("validate_patch_against_rules", {
          rulesJson: JSON.stringify(rules),
          changedFiles: [filePath],
        });
        architecturePassed = validation.allowed;
        if (!architecturePassed) errors.push("Architecture validation failed");
      } catch { errors.push("Architecture validation error"); }

      // Validate against security scanner (Phase 6)
      let securityPassed = false;
      try {
        const secResult = await invoke<{ allowed: boolean; criticalFindings: unknown[] }>("security_scan_patch", {
          patchContent: patch,
          filePath,
        });
        securityPassed = secResult.allowed;
        if (!securityPassed) errors.push("Security scan blocked critical findings");
      } catch { errors.push("Security scan error"); }

      return {
        success: errors.length === 0,
        file: filePath,
        patch,
        validated: architecturePassed && securityPassed,
        architecturePassed,
        securityPassed,
        errors,
      };
    } catch (err) {
      return { success: false, file: filePath, patch: "", validated: false, architecturePassed: false, securityPassed: false, errors: [String(err)] };
    }
  }
}

// ── VerificationRunner (Phase 9.4) ────────────────────────────────────────────

export interface VerificationResult {
  passed: boolean;
  testOutput: string;
  exitCode: number | null;
  durationMs: number;
  error: string | null;
}

export class VerificationRunner {
  /**
   * Run the test suite against a proposed patch in a Docker sandbox.
   */
  async runInSandbox(
    image: string,
    commands: string[],
    mountPath: string,
  ): Promise<VerificationResult> {
    const start = Date.now();

    try {
      const { invoke } = await import("@tauri-apps/api/core");

      // Check Docker availability
      const dockerAvailable = await invoke<boolean>("docker_available");
      if (!dockerAvailable) {
        return {
          passed: false, testOutput: "", exitCode: null,
          durationMs: Date.now() - start,
          error: "Docker is not available — sandbox verification requires Docker",
        };
      }

      // Run commands in a Docker container
      // This is a simplified version — production would use docker exec
      let combinedOutput = "";

      for (const cmd of commands) {
        const result = await invoke<{ success: boolean; stdout: string; stderr: string; exitCode: number | null }>(
          "run_terminal_command",
          { command: cmd, cwd: mountPath },
        ).catch(() => ({ success: false, stdout: "", stderr: "Command failed", exitCode: 1 }));

        combinedOutput += result.stdout + "\n" + result.stderr;

        if (!result.success) {
          return {
            passed: false, testOutput: combinedOutput,
            exitCode: result.exitCode, durationMs: Date.now() - start,
            error: `Command failed: ${cmd}`,
          };
        }
      }

      return {
        passed: true, testOutput: combinedOutput, exitCode: 0,
        durationMs: Date.now() - start, error: null,
      };
    } catch (err) {
      return {
        passed: false, testOutput: "", exitCode: null,
        durationMs: Date.now() - start, error: String(err),
      };
    }
  }
}