/**
 * AgentCoordinator.ts — Phase 5, Step 5.4
 *
 * Shared context bus and agent-to-agent communication layer.
 * Enables the implementation agent to query the architecture agent
 * for guidance before writing code.
 */

import { getAgentOrchestrator } from "./AgentOrchestrator";
import type { AgentOrchestrator } from "./AgentOrchestrator";

// ── Types ──────────────────────────────────────────────────────────────────────

export interface AgentQuery {
  from: string;
  to: string;     // "architecture" or "security" (agent type)
  question: string;
  context: string; // relevant code/files for context
}

export interface AgentResponse {
  to: string;
  from: string;
  answer: string;
  confidence: number; // 0-1
  references: string[]; // files/modules referenced
}

export interface SharedContext {
  taskDescription: string;
  affectedFiles: string[];
  architectureAdvice: string | null;
  securityConcerns: string[];
  currentPhase: string;
  completedPhases: string[];
}

export class AgentCoordinator {
  private orchestrator: AgentOrchestrator;
  private sharedContext: SharedContext | null = null;
  private pendingQueries: Map<string, AgentQuery> = new Map();

  constructor() {
    this.orchestrator = getAgentOrchestrator();
  }

  /**
   * Initialize shared context for a multi-agent workflow.
   */
  initWorkflow(
    taskDescription: string,
    affectedFiles: string[],
  ): SharedContext {
    this.sharedContext = {
      taskDescription,
      affectedFiles,
      architectureAdvice: null,
      securityConcerns: [],
      currentPhase: "architecture",
      completedPhases: [],
    };
    return this.sharedContext;
  }

  /** Get the shared context. */
  getSharedContext(): SharedContext | null {
    return this.sharedContext;
  }

  /** Update the current workflow phase. */
  setPhase(phase: string): void {
    if (this.sharedContext) {
      this.sharedContext.currentPhase = phase;
    }
  }

  /** Mark a phase as completed. */
  completePhase(phase: string): void {
    if (this.sharedContext && !this.sharedContext.completedPhases.includes(phase)) {
      this.sharedContext.completedPhases.push(phase);
    }
  }

  /** Set architecture advice from the architecture agent. */
  setArchitectureAdvice(advice: string): void {
    if (this.sharedContext) {
      this.sharedContext.architectureAdvice = advice;
    }
    this.orchestrator.setArchitectureReport(advice);
  }

  /** Add a security concern found by the security agent. */
  addSecurityConcern(concern: string): void {
    if (this.sharedContext) {
      this.sharedContext.securityConcerns.push(concern);
    }
  }

  /**
   * Query the architecture agent for guidance.
   * This is how the implementation agent asks "is this design decision valid?"
   */
  queryArchitectureAgent(question: string, context: string): AgentQuery | null {
    // Find the architecture agent
    const archAgent = this.orchestrator.getAgentSessions()
      .find((s) => s.config.type === "architecture");
    if (!archAgent) return null;

    const query: AgentQuery = {
      from: "implementation",
      to: archAgent.config.id,
      question,
      context,
    };

    this.pendingQueries.set(query.question, query);
    this.orchestrator.sendMessage(
      "implementation",
      archAgent.config.id,
      "query",
      `Architecture query: ${question}\nContext: ${context.substring(0, 200)}`,
    );

    return query;
  }

  /**
   * Respond to a query from another agent.
   */
  respondToQuery(queryQuestion: string, answer: string, confidence: number): void {
    const query = this.pendingQueries.get(queryQuestion);
    if (!query) return;

    this.orchestrator.sendMessage(
      query.to,
      query.from,
      "response",
      `Response: ${answer.substring(0, 200)} (confidence: ${confidence})`,
    );
    this.pendingQueries.delete(queryQuestion);
  }

  /**
   * Build a context summary for an agent's system prompt.
   */
  buildAgentContext(_agentType: string): string {
    const ctx = this.sharedContext;
    if (!ctx) return "";

    const lines: string[] = [];

    lines.push(`## Current Task: ${ctx.taskDescription}`);
    lines.push(`## Current Phase: ${ctx.currentPhase}`);
    if (ctx.completedPhases.length > 0) {
      lines.push(`## Completed Phases: ${ctx.completedPhases.join(", ")}`);
    }

    if (ctx.architectureAdvice) {
      lines.push(`## Architecture Guidance:\n${ctx.architectureAdvice}`);
    }

    if (ctx.securityConcerns.length > 0) {
      lines.push("## Security Concerns:");
      for (const concern of ctx.securityConcerns) {
        lines.push(`- ${concern}`);
      }
    }

    if (ctx.affectedFiles.length > 0) {
      lines.push(`## Affected Files (${ctx.affectedFiles.length}):`);
      for (const file of ctx.affectedFiles.slice(0, 20)) {
        lines.push(`- ${file}`);
      }
    }

    return lines.join("\n");
  }
}

// ── Singleton ──────────────────────────────────────────────────────────────────

let instance: AgentCoordinator | null = null;

export function getAgentCoordinator(): AgentCoordinator {
  if (!instance) {
    instance = new AgentCoordinator();
  }
  return instance;
}

// ── Agent Prompt Templates ─────────────────────────────────────────────────────

export const AGENT_PROMPTS: Record<
  "implementation" | "test" | "security" | "architecture" | "refactor",
  string
> = {
  architecture: `You are the ARCHITECTURE GUARDIAN agent for Punam IDE.

Your role:
1. Analyze the proposed change for architectural impact
2. Identify circular dependencies, layer violations, coupling issues
3. Provide architectural guidance to the Implementation and Refactor agents
4. Veto changes that violate architectural rules

You CANNOT edit files. You are a READ-ONLY observer.
You CAN veto any implementation patch that violates architecture rules.

Respond with:
- AFFECTED: list of modules/systems affected
- RISKS: architectural risks identified
- GUIDANCE: recommendations for implementation
- VETO: only if a proposed change must be blocked

Your analysis must reference the project's dependency graph and memory of past architectural decisions.`,

  implementation: `You are the IMPLEMENTATION agent for Punam IDE.

Your permissions:
- CAN write to: src/, src-tauri/src/, public/, index.html
- CANNOT write to: test files (*.test.ts), config files (.env, vite.config.ts), tsconfig files

Rules:
1. Before writing code, check architecture guidance from the Architecture Agent
2. Every file edit requires a file lock — if locked by another agent, wait
3. All patches pass through architecture validation (Phase 1) and security scanning (Phase 6)
4. Critical security findings will BLOCK your patches automatically
5. Do NOT generate configuration files, environment files, or test files

Output format: Use FILE blocks for code changes, CMD blocks for commands.`,

  test: `You are the TEST agent for Punam IDE.

Your permissions:
- CAN write to: test files (*.test.ts, *.spec.ts, __tests__/)
- CANNOT write to: production code (src/, src-tauri/src/)

Rules:
1. Generate tests ONLY for code written by the Implementation agent
2. Do NOT modify production code — even to fix bugs
3. Focus on unit tests, integration tests, and edge cases
4. Cover the files listed in the "Affected Files" section
5. Wait for implementation to complete before generating tests

Output format: Use FILE blocks for test code.`,

  security: `You are the SECURITY SCANNER agent for Punam IDE.

Your permissions:
- CANNOT write files (READ-ONLY)
- CAN block any patch with critical security findings

Your role:
1. Scan all proposed code changes for vulnerabilities
2. Detect: SQL injection, XSS, hardcoded secrets, unsafe eval, path traversal, weak crypto
3. Report findings by severity (critical/high/medium/low)
4. BLOCK patches with critical findings (they cannot be applied)
5. Provide fix suggestions for each finding

Critical findings that MUST be blocked:
- SQL injection via string concatenation
- Hardcoded API keys, passwords, or JWT secrets
- eval() with user input
- Unsafe child process execution with user input

Output: A structured report with:
- CRITICAL: findings that block the patch
- HIGH: findings that should be reviewed
- MEDIUM/LOW: advisory findings`,

  refactor: `You are the REFACTOR agent for Punam IDE.

Your permissions:
- CAN write to: src/, src-tauri/src/
- CANNOT write to: test files, config files, .env files

Rules:
1. Refactor code for clarity, performance, and maintainability
2. Do NOT change external behavior or APIs
3. All refactored code MUST pass architecture re-validation
4. After refactoring, the Architecture agent re-validates the dependency graph
5. If architecture validation fails, your changes will be VETOED

Output format: Use FILE blocks for refactored code. Include a brief summary of what was refactored and why.`,
};