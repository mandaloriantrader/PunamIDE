/**
 * @phase P6
 * @purpose Multi-agent orchestrator with the new Review Agent role.
 *          Shows existing agent roles (Coding Agent, Architecture Agent)
 *          and adds the new ReviewAgent alongside them.
 *
 * Coordination flow:
 * 1. Coding Agent produces changes
 * 2. Architecture Agent checks layer compliance (existing)
 * 3. Review Agent reviews the diff with full codebase context (new)
 * 4. Findings from all agents merge into the unified panel
 */

import { type Finding, type DependencyGraph, type FileRiskProfile, type AgentQuery, type AgentResponse, type SharedContext, type ChangedFile } from '../review/types';
import { type ReviewAgent } from '../review/ReviewAgent';
import type { ReviewContextAssembler, ReviewContext } from '../review/ReviewContextAssembler';

/**
 * Agent system prompts — the Review Agent is registered as the 6th key
 * in the existing AGENT_PROMPTS map (existing keys: implementation, test,
 * security, architecture, refactor).
 *
 * Key constraints for the Review Agent: READ-ONLY, cannot write files,
 * can flag/veto. Follows the same pattern as the Architecture Agent.
 */
export const AGENT_PROMPTS: Record<string, string> = {
  implementation: 'You are a coding agent that implements features.',
  test: 'You are a test agent that writes and runs tests.',
  security: 'You are a security agent that checks for vulnerabilities.',
  architecture: 'You are an architecture agent that enforces layer rules.',
  refactor: 'You are a refactor agent that suggests code improvements.',
  review: `You are the REVIEW agent. Your job is to find what is WRONG with this patch, not what is good about it.

## Rules
1. Be adversarial — assume there IS a bug. Find it.
2. Ground your reasoning in the provided dependency graph, coupling data, and architecture context.
3. Do NOT flag style preferences as bugs. Distinguish "this is wrong" from "this could be better."
4. Provide concrete fixes, not just observations. Suggest specific code changes.
5. Acknowledge uncertainty — don't claim certainty where none exists.
6. Focus on: logic errors, missing error handling, race conditions, security issues, incorrect state management.
7. Do NOT repeat findings that are already listed in "Existing Findings."

## Constraints
- READ-ONLY: You cannot write files or make changes.
- You CAN flag and veto changes that have critical issues.
- You run AFTER the coding agent and architecture agent.`,
};

/** Agent roles in the orchestrator. */
export const AgentRole = {
  Coding: 'coding',
  Architecture: 'architecture',
  Review: 'review',
} as const;
export type AgentRole = (typeof AgentRole)[keyof typeof AgentRole];

/** Configuration for a single agent. */
export interface AgentConfig {
  role: AgentRole;
  modelId: string;
  systemPrompt: string;
  canWrite: boolean;
  canVeto: boolean;
  runOrder: number;
}

/** Result from a single agent's execution. */
export interface AgentResult {
  role: AgentRole;
  findings: Finding[];
  vetoed: boolean;
  executionTimeMs: number;
  error?: string;
}

/** Result of the full coordination cycle. */
export interface CoordinationResult {
  codingResult: AgentResult;
  architectureResult: AgentResult;
  reviewResult: AgentResult;
  mergedFindings: Finding[];
}

/** Interface for the existing Coding Agent. */
export interface CodingAgentInterface {
  implement(task: string): Promise<{ diff: string; files: string[] }>;
}

/** Interface for the existing Architecture Agent. */
export interface ArchitectureAgentInterface {
  checkCompliance(diff: string, files: string[]): Promise<Finding[]>;
  canVeto: boolean;
}

/**
 * Coordinates the multi-agent workflow: Coding → Architecture → Review.
 *
 * The Review Agent is structurally independent:
 * - Read-only (cannot write)
 * - Runs after implementation
 * - Can flag/veto
 * - Uses its own model config (can be a stronger model than the coding agent)
 */
export class AgentCoordinator {
  private codingAgent: CodingAgentInterface;
  private architectureAgent: ArchitectureAgentInterface;
  private reviewAgent: ReviewAgent;
  private contextAssembler: ReviewContextAssembler;

  constructor(
    codingAgent: CodingAgentInterface,
    architectureAgent: ArchitectureAgentInterface,
    reviewAgent: ReviewAgent,
    contextAssembler: ReviewContextAssembler,
  ) {
    this.codingAgent = codingAgent;
    this.architectureAgent = architectureAgent;
    this.reviewAgent = reviewAgent;
    this.contextAssembler = contextAssembler;
  }

  /**
   * Runs the full coordination cycle.
   *
   * @param task - The implementation task
   * @param graph - The dependency graph
   * @param profiles - Existing FileRiskProfiles
   * @param changedFiles - Changed files from the diff
   * @returns Coordination result with findings from all agents
   */
  async coordinate(
    task: string,
    graph: DependencyGraph | undefined,
    profiles: Map<string, FileRiskProfile>,
    changedFiles: ChangedFile[],
  ): Promise<CoordinationResult> {
    // Phase 1: Coding Agent produces changes
    const codingStart = Date.now();
    let codingResult: AgentResult;
    let diff = '';

    try {
      const codingOutput = await this.codingAgent.implement(task);
      diff = codingOutput.diff;
      codingResult = {
        role: AgentRole.Coding,
        findings: [],
        vetoed: false,
        executionTimeMs: Date.now() - codingStart,
      };
    } catch (err) {
      codingResult = {
        role: AgentRole.Coding,
        findings: [],
        vetoed: false,
        executionTimeMs: Date.now() - codingStart,
        error: String(err),
      };
    }

    // Phase 2: Architecture Agent checks layer compliance
    const archStart = Date.now();
    let architectureResult: AgentResult;

    try {
      const archFindings = await this.architectureAgent.checkCompliance(
        diff,
        changedFiles.map(f => f.path),
      );
      const vetoed = archFindings.some(f => f.severity === 'critical') && this.architectureAgent.canVeto;

      architectureResult = {
        role: AgentRole.Architecture,
        findings: archFindings,
        vetoed,
        executionTimeMs: Date.now() - archStart,
      };
    } catch (err) {
      architectureResult = {
        role: AgentRole.Architecture,
        findings: [],
        vetoed: false,
        executionTimeMs: Date.now() - archStart,
        error: String(err),
      };
    }

    // Phase 3: Review Agent reviews the diff with full codebase context
    const reviewStart = Date.now();
    let reviewResult: AgentResult;

    try {
      // Assemble context for the Review Agent
      const reviewContext = this.contextAssembler.assembleContext(
        diff,
        graph,
        profiles,
        changedFiles,
      );

      const reviewFindings = await this.reviewAgent.reviewPatch(diff, reviewContext);
      const vetoed = reviewFindings.some(f => f.severity === 'critical');

      reviewResult = {
        role: AgentRole.Review,
        findings: reviewFindings,
        vetoed,
        executionTimeMs: Date.now() - reviewStart,
      };
    } catch (err) {
      reviewResult = {
        role: AgentRole.Review,
        findings: [],
        vetoed: false,
        executionTimeMs: Date.now() - reviewStart,
        error: String(err),
      };
    }

    // Merge all findings
    const mergedFindings: Finding[] = [
      ...architectureResult.findings,
      ...reviewResult.findings,
    ];

    return {
      codingResult,
      architectureResult,
      reviewResult,
      mergedFindings,
    };
  }

  /**
   * Gets the agent configurations.
   * Uses AGENT_PROMPTS for system prompts, following the existing pattern.
   */
  getAgentConfigs(): AgentConfig[] {
    return [
      {
        role: AgentRole.Coding,
        modelId: 'coding-agent-model',
        systemPrompt: AGENT_PROMPTS['implementation'],
        canWrite: true,
        canVeto: false,
        runOrder: 1,
      },
      {
        role: AgentRole.Architecture,
        modelId: 'architecture-agent-model',
        systemPrompt: AGENT_PROMPTS['architecture'],
        canWrite: false,
        canVeto: true,
        runOrder: 2,
      },
      {
        role: AgentRole.Review,
        modelId: this.reviewAgent.getConfig().modelId,
        systemPrompt: AGENT_PROMPTS['review'],
        canWrite: false,
        canVeto: true,
        runOrder: 3,
      },
    ];
  }

  // ── Shared Context Bus (existing agent system pattern) ──────

  private sharedContext: SharedContext | null = null;

  /**
   * Initializes a multi-agent workflow with shared context.
   * Follows the existing AgentCoordinator pattern: initWorkflow(task, files) → SharedContext.
   */
  initWorkflow(task: string, files: string[]): SharedContext {
    this.sharedContext = {
      taskDescription: task,
      affectedFiles: files,
      architectureAdvice: null,
      securityConcerns: [],
      currentPhase: 'implementation',
      completedPhases: [],
    };
    return this.sharedContext;
  }

  /**
   * Sends a query from one agent to another via the coordinator bus.
   */
  queryAgent(query: AgentQuery): AgentResponse {
    // In production, this routes to the target agent and awaits its response.
    // For now, return a default response — the existing AgentCoordinator
    // handles routing via its internal orchestrator.
    return {
      to: query.from,
      from: query.to,
      answer: '',
      confidence: 0,
      references: [],
    };
  }

  /**
   * Updates architecture advice in the shared context.
   */
  setArchitectureAdvice(advice: string): void {
    if (this.sharedContext) {
      this.sharedContext.architectureAdvice = advice;
    }
  }

  /**
   * Adds a security concern to the shared context.
   */
  addSecurityConcern(concern: string): void {
    if (this.sharedContext) {
      this.sharedContext.securityConcerns.push(concern);
    }
  }

  /**
   * Builds agent context string for system prompts.
   */
  buildAgentContext(agentType: string): string {
    if (!this.sharedContext) return '';
    const ctx = this.sharedContext;
    return [
      `Task: ${ctx.taskDescription}`,
      `Affected files: ${ctx.affectedFiles.join(', ')}`,
      `Architecture advice: ${ctx.architectureAdvice ?? 'none'}`,
      `Security concerns: ${ctx.securityConcerns.length > 0 ? ctx.securityConcerns.join('; ') : 'none'}`,
      `Current phase: ${ctx.currentPhase}`,
    ].join('\n');
  }

  /**
   * Gets the current shared context.
   */
  getSharedContext(): SharedContext | null {
    return this.sharedContext;
  }
}

// ── Singleton pattern (follows existing codebase convention) ───────
let instance: AgentCoordinator | null = null;

export function getAgentCoordinator(): AgentCoordinator {
  if (!instance) throw new Error('AgentCoordinator not initialized. Call initAgentCoordinator() first.');
  return instance;
}

export function initAgentCoordinator(
  codingAgent: CodingAgentInterface,
  architectureAgent: ArchitectureAgentInterface,
  reviewAgent: import('../review/ReviewAgent').ReviewAgent,
  contextAssembler: import('../review/ReviewContextAssembler').ReviewContextAssembler,
): AgentCoordinator {
  instance = new AgentCoordinator(codingAgent, architectureAgent, reviewAgent, contextAssembler);
  return instance;
}
