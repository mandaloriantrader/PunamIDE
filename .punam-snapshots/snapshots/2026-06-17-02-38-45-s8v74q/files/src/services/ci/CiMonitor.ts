/**
 * CiMonitor.ts — Phase 9 (Self-Healing CI/CD)
 *
 * Monitors GitHub Actions CI pipelines.
 * Bundles: LogAnalyzer, PatchGenerator, and VerificationRunner logic.
 * Integrates with existing GitHub service (src/services/githubService.ts).
 *
 * Pipeline: CI Failure → Log Analysis → Root Cause → Patch → Sandbox → Human Approval
 */

import { invoke } from "@tauri-apps/api/core";

// ── Types ──────────────────────────────────────────────────────────────────────

export interface CiWorkflowRun {
  id: number;
  name: string;
  status: "queued" | "in_progress" | "completed";
  conclusion: "success" | "failure" | "cancelled" | "skipped" | null;
  branch: string;
  commitSha: string;
  commitMessage: string;
  runUrl: string;
  createdAt: string;
  updatedAt: string;
}

export interface CiFailureAnalysis {
  runId: number;
  workflowName: string;
  rootCause: string;
  failingStep: string;
  errorLog: string;
  failingFile: string | null;
  suggestedFix: string | null;
  confidence: number; // 0-1
  requiresHumanReview: boolean;
}

export interface CiFixProposal {
  analysis: CiFailureAnalysis;
  patch: string; // diff content
  affectedFiles: string[];
  testResults: { passed: boolean; output: string } | null;
  status: "pending" | "testing" | "ready" | "applied" | "rejected";
}

export interface CiPipelineStatus {
  repo: string;
  workflows: CiWorkflowRun[];
  recentFailures: CiFailureAnalysis[];
  pendingFixes: CiFixProposal[];
  isMonitoring: boolean;
}

// ── CiMonitor Class ────────────────────────────────────────────────────────────

export class CiMonitor {
  private pollingInterval: ReturnType<typeof setInterval> | null = null;
  private monitoredRepos: Set<string> = new Set();

  /**
   * Fetch recent workflow runs for a repository.
   */
  async fetchWorkflowRuns(repo: string, limit = 10): Promise<CiWorkflowRun[]> {
    try {
      return invoke<CiWorkflowRun[]>("get_workflow_runs", { repo, limit });
    } catch {
      // Fallback: return empty if GitHub integration not configured
      console.warn("[CiMonitor] GitHub integration not available for:", repo);
      return [];
    }
  }

  /**
   * Analyze a failed CI run — extract root cause and suggest fix.
   * Feeds failure logs to LLM for analysis.
   */
  async analyzeFailure(run: CiWorkflowRun): Promise<CiFailureAnalysis> {
    try {
      // Get job logs from the failed run
      const logs = await invoke<{ jobId: number; name: string; output: string }[]>(
        "get_workflow_run_logs",
        { repo: this.extractRepo(run), runId: run.id }
      );

      // Find the failing job
      const failingJob = logs.find((l) => l.output.includes("error") || l.output.includes("Error"));

      return {
        runId: run.id,
        workflowName: run.name,
        rootCause: failingJob
          ? this.extractRootCause(failingJob.output)
          : "Unknown — unable to parse logs",
        failingStep: failingJob?.name || "Unknown step",
        errorLog: failingJob?.output?.slice(-2000) || "No logs available",
        failingFile: this.extractFailingFile(failingJob?.output || ""),
        suggestedFix: null, // Will be filled by LLM in CiDashboard
        confidence: failingJob ? 0.7 : 0.3,
        requiresHumanReview: true,
      };
    } catch (err) {
      return {
        runId: run.id,
        workflowName: run.name,
        rootCause: `Failed to fetch logs: ${err}`,
        failingStep: "Unknown",
        errorLog: "",
        failingFile: null,
        suggestedFix: null,
        confidence: 0.1,
        requiresHumanReview: true,
      };
    }
  }

  /**
   * Generate a fix patch using AI (called from CiDashboard UI).
   */
  async generateFix(analysis: CiFailureAnalysis): Promise<CiFixProposal> {
    // This is the PatchGenerator logic — feeds the analysis to the AI
    // Actual AI call happens in the dashboard component using existing providers
    return {
      analysis,
      patch: "", // Filled by AI in CiDashboard
      affectedFiles: analysis.failingFile ? [analysis.failingFile] : [],
      testResults: null,
      status: "pending",
    };
  }

  /**
   * Verify a fix by running tests in a sandbox.
   * (Uses Docker for isolation — delegates to docker_controller.rs)
   */
  async verifyFix(proposal: CiFixProposal): Promise<{ passed: boolean; output: string }> {
    try {
      return invoke("verify_fix_in_sandbox", {
        patch: proposal.patch,
        files: proposal.affectedFiles,
      });
    } catch {
      return { passed: false, output: "Sandbox not available — verify manually" };
    }
  }

  /**
   * Start monitoring a repository for CI failures.
   */
  startMonitoring(repo: string, pollIntervalMs = 60000): void {
    this.monitoredRepos.add(repo);

    if (this.pollingInterval) {
      clearInterval(this.pollingInterval);
    }

    this.pollingInterval = setInterval(async () => {
      for (const r of this.monitoredRepos) {
        const runs = await this.fetchWorkflowRuns(r, 3);
        // Failures are surfaced via CiDashboard UI polling
      }
    }, pollIntervalMs);
  }

  /**
   * Stop monitoring.
   */
  stopMonitoring(): void {
    if (this.pollingInterval) {
      clearInterval(this.pollingInterval);
      this.pollingInterval = null;
    }
    this.monitoredRepos.clear();
  }

  /**
   * Get complete pipeline status for a repo.
   */
  async getPipelineStatus(repo: string): Promise<CiPipelineStatus> {
    const workflows = await this.fetchWorkflowRuns(repo, 20);

    const failures = workflows.filter(
      (w) => w.conclusion === "failure"
    );

    // Analyze recent failures (last 3)
    const recentFailures: CiFailureAnalysis[] = [];
    for (const f of failures.slice(0, 3)) {
      const analysis = await this.analyzeFailure(f).catch(() => null);
      if (analysis) recentFailures.push(analysis);
    }

    return {
      repo,
      workflows,
      recentFailures,
      pendingFixes: [],
      isMonitoring: this.monitoredRepos.has(repo),
    };
  }

  // ── Private Helpers ──────────────────────────────────────────────────────

  private extractRepo(run: CiWorkflowRun): string {
    // Extract owner/repo from runUrl
    const match = run.runUrl.match(/github\.com\/([^/]+\/[^/]+)/);
    return match ? match[1] : "";
  }

  private extractRootCause(log: string): string {
    // Extract last error message from log
    const errorLines = log
      .split("\n")
      .filter((l) => l.toLowerCase().includes("error") || l.toLowerCase().includes("fail"))
      .slice(-3);

    if (errorLines.length === 0) return "No specific error found in logs";

    // Clean up ANSI and return the most specific error
    const clean = errorLines.map((l) => l.replace(/\x1B\[[0-9;]*[a-zA-Z]/g, "").trim());
    return clean[clean.length - 1] || clean[0];
  }

  private extractFailingFile(log: string): string | null {
    // Match common file path patterns in error output
    const patterns = [
      /([a-zA-Z0-9_/\\-]+\.[a-z]{2,5}):(\d+):\d+/,
      /at\s+(?:Object\.)?(?:<anonymous>|[\w.]+)\s+\(([^)]+\.[a-z]{2,5}):\d+:\d+\)/,
      /File "([^"]+)"/,
      /--> ([^<]+\.\w+)/,
    ];

    for (const pattern of patterns) {
      const match = log.match(pattern);
      if (match) return match[1];
    }

    return null;
  }
}

// ── Singleton ──────────────────────────────────────────────────────────────────

let instance: CiMonitor | null = null;

export function getCiMonitor(): CiMonitor {
  if (!instance) {
    instance = new CiMonitor();
  }
  return instance;
}