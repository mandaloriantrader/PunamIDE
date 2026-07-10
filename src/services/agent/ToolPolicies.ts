/**
 * ToolPolicies.ts — Phase 1: Tool Policy System
 *
 * Defines per-tool approval policies for the background agent.
 * Replaces window.confirm() with structured, non-blocking approval flow.
 *
 * Policy types:
 *   - "auto"          → execute immediately (read-only / safe operations)
 *   - "once_session"  → ask once per session, remember for the rest
 *   - "once_per_tool" → ask once per unique tool name in this session
 *   - "always"        → always ask (destructive / risky operations)
 *
 * Risk levels inform the UI about how to present the approval request.
 */

// ── Types ──────────────────────────────────────────────────────────────────────

export type ApprovalPolicy = "auto" | "once_session" | "once_per_tool" | "always";
export type RiskLevel = "safe" | "low" | "medium" | "high" | "blocked";

export interface ToolPolicy {
  policy: ApprovalPolicy;
  risk: RiskLevel;
  reason: string;
}

export interface CommandApprovalRequest {
  id: string;
  command: string;
  sanitizedCommand: string;
  riskLevel: RiskLevel;
  feedbackMessage: string;
  timestamp: number;
}

export interface CommandApprovalResult {
  approved: boolean;
  rememberedForSession: boolean;
}

// ── Policy Resolution ──────────────────────────────────────────────────────────

/**
 * Resolve the policy for a command based on its risk level from safety.rs.
 *
 * Maps Rust-side risk levels to approval policies:
 *   - "safe" / "informational" → auto-approve
 *   - "low"                    → auto-approve (logged)
 *   - "medium"                 → ask once per session
 *   - "high"                   → always ask
 *   - "blocked"                → never allow (handled before this)
 */
export function resolveCommandPolicy(riskLevel: string): ToolPolicy {
  switch (riskLevel) {
    case "safe":
    case "informational":
      return { policy: "auto", risk: "safe", reason: "Read-only or informational command" };

    case "low":
      return { policy: "auto", risk: "low", reason: "Low-risk command (build, lint, test)" };

    case "medium":
      return { policy: "once_session", risk: "medium", reason: "Modifies files or installs packages" };

    case "high":
      return { policy: "always", risk: "high", reason: "Potentially destructive operation" };

    case "blocked":
      return { policy: "always", risk: "blocked", reason: "Blocked by safety policy" };

    default:
      return { policy: "always", risk: "medium", reason: "Unknown risk — requires approval" };
  }
}

// ── Session Approval Memory ────────────────────────────────────────────────────

/**
 * Tracks what the user has already approved in this session.
 * Prevents re-asking for the same tool/command type.
 */
export class ApprovalMemory {
  /** Commands approved globally for the session (once_session policy) */
  private sessionApproved = false;
  /** Specific command patterns approved (once_per_tool) */
  private approvedPatterns = new Set<string>();
  /** Commands explicitly denied */
  private denied = new Set<string>();

  /** Check if a command is already approved by prior user action. */
  isPreApproved(command: string, policy: ToolPolicy): boolean {
    if (policy.policy === "auto") return true;
    if (policy.policy === "once_session" && this.sessionApproved) return true;
    if (policy.policy === "once_per_tool" && this.approvedPatterns.has(this.getPattern(command))) return true;
    if (policy.policy === "always" && this.approvedPatterns.has(this.getPattern(command))) return true;
    return false;
  }

  /** Record an approval decision. */
  recordApproval(command: string, policy: ToolPolicy): void {
    if (policy.policy === "once_session") {
      this.sessionApproved = true;
    }
    if (policy.policy === "once_per_tool" || policy.policy === "always") {
      this.approvedPatterns.add(this.getPattern(command));
    }
  }

  /** Record a denial. */
  recordDenial(command: string): void {
    this.denied.add(this.getPattern(command));
  }

  /** Check if a command pattern was previously denied. */
  wasDenied(command: string): boolean {
    return this.denied.has(this.getPattern(command));
  }

  /** Reset all approvals (new session). */
  reset(): void {
    this.sessionApproved = false;
    this.approvedPatterns.clear();
    this.denied.clear();
  }

  /**
   * Extract a "pattern" from a command for grouping.
   * e.g., "npm run build" → "npm run build"
   *        "npm install lodash" → "npm install"
   */
  private getPattern(command: string): string {
    const parts = command.trim().split(/\s+/);
    // For package managers, group by the subcommand (install, run, etc.)
    if (["npm", "pnpm", "yarn", "bun", "cargo", "pip"].includes(parts[0])) {
      return parts.slice(0, 2).join(" ");
    }
    // For everything else, use the base command
    return parts[0];
  }
}

// ── Singleton ──────────────────────────────────────────────────────────────────

let memoryInstance: ApprovalMemory | null = null;

export function getApprovalMemory(): ApprovalMemory {
  if (!memoryInstance) {
    memoryInstance = new ApprovalMemory();
  }
  return memoryInstance;
}

export function resetApprovalMemory(): void {
  memoryInstance?.reset();
}
