/**
 * AgentOrchestrator.ts — Phase 5, Step 5.1
 *
 * Spawns and manages multiple specialized AI agents simultaneously.
 * Each agent type has strict permission boundaries (Layer 5):
 *
 *  - Implementation: can write to src/, src-tauri/src/; cannot edit configs/tests
 *  - Test: can write to *.test.ts, *.spec.ts only; cannot touch production code
 *  - Architecture: READ-ONLY observer; can veto but cannot edit
 *  - Security: READ-ONLY scanner; can block patches with critical findings
 *  - Refactor: same write scope as Implementation; must pass Architecture re-validation
 *
 * All agents must pass through existing Phase 1 (architecture) and Phase 6 (security)
 * guardrails before any patch is applied.
 */

import type { AIProviderConfig } from "../../utils/providers";

// ── Types ──────────────────────────────────────────────────────────────────────

export type AgentType = "implementation" | "test" | "security" | "architecture" | "refactor";

export type AgentStatus = "idle" | "running" | "waiting" | "completed" | "blocked" | "error";

export interface AgentConfig {
  id: string;
  type: AgentType;
  provider: string;       // AI provider (gemini, openai, groq, etc.)
  model: string;
  apiKey: string;
  maxTokens?: number;
  temperature?: number;
}

export interface AgentTask {
  id: string;
  description: string;
  assignedTo: string;     // agent ID
  files: string[];        // files to work on
  priority: number;       // 1=highest, 5=lowest
  dependencies: string[]; // task IDs that must complete first
  status: "pending" | "running" | "completed" | "failed" | "vetoed";
  result?: string;
}

export interface AgentSession {
  config: AgentConfig;
  status: AgentStatus;
  currentTask: AgentTask | null;
  completedTasks: string[];
  lockedFiles: Set<string>;  // files this agent has locked
  startedAt: number | null;
  messages: AgentMessage[];  // inter-agent communication log
}

export interface AgentMessage {
  from: string;
  to: string;
  type: "query" | "response" | "warning" | "veto" | "block";
  content: string;
  timestamp: number;
}

export interface OrchestratorState {
  agents: Map<string, AgentSession>;
  tasks: AgentTask[];
  taskQueue: AgentTask[];
  globalFileLocks: Map<string, string>; // file → agentId
  architectureReport: string | null;     // last architecture analysis
  securityReport: string | null;         // last security scan
  isRunning: boolean;
}

// ── AgentType Permission Matrix ────────────────────────────────────────────────

const AGENT_PERMISSIONS: Record<AgentType, {
  writePatterns: string[];       // glob patterns where agent CAN write
  denyPatterns: string[];        // glob patterns where agent CANNOT write
  canVeto: boolean;              // can this agent veto other agents' patches?
  canBlock: boolean;             // can this agent block patches entirely?
  readonly: boolean;             // agent is read-only (observer only)
  requiresArchValidation: boolean; // must pass architecture re-validation?
}> = {
  implementation: {
    writePatterns: ["src/**", "src-tauri/src/**", "public/**", "index.html"],
    denyPatterns: ["**/*.test.*", "**/*.spec.*", "**/.env*", "**/config.*", "**/vite.config.*", "**/tsconfig.*"],
    canVeto: false,
    canBlock: false,
    readonly: false,
    requiresArchValidation: true,
  },
  test: {
    writePatterns: ["**/*.test.*", "**/*.spec.*", "**/__tests__/**"],
    denyPatterns: [],  // already restricted by writePatterns
    canVeto: false,
    canBlock: false,
    readonly: false,
    requiresArchValidation: false,
  },
  architecture: {
    writePatterns: [],   // read-only
    denyPatterns: ["**/*"],  // cannot write anything
    canVeto: true,
    canBlock: false,
    readonly: true,
    requiresArchValidation: false,
  },
  security: {
    writePatterns: [],   // read-only
    denyPatterns: ["**/*"],  // cannot write anything
    canVeto: false,
    canBlock: true,      // CAN block critical findings
    readonly: true,
    requiresArchValidation: false,
  },
  refactor: {
    writePatterns: ["src/**", "src-tauri/src/**"],
    denyPatterns: ["**/*.test.*", "**/*.spec.*", "**/.env*"],
    canVeto: false,
    canBlock: false,
    readonly: false,
    requiresArchValidation: true,  // MUST re-validate after refactor
  },
};

// ── AgentOrchestrator ──────────────────────────────────────────────────────────

export class AgentOrchestrator {
  private state: OrchestratorState;
  private listeners: Array<() => void> = [];

  constructor() {
    this.state = {
      agents: new Map(),
      tasks: [],
      taskQueue: [],
      globalFileLocks: new Map(),
      architectureReport: null,
      securityReport: null,
      isRunning: false,
    };
  }

  /** Subscribe to state changes (for UI updates). Returns unsubscribe function. */
  onStateChange(callback: () => void): () => void {
    this.listeners.push(callback);
    return () => {
      this.listeners = this.listeners.filter(l => l !== callback);
    };
  }

  private emitChange(): void {
    for (const listener of this.listeners) {
      listener();
    }
  }

  // ── Agent Lifecycle ──────────────────────────────────────────────────────

  /** Spawn a new agent session. */
  spawnAgent(config: AgentConfig): AgentSession {
    if (this.state.agents.has(config.id)) {
      throw new Error(`Agent "${config.id}" already exists`);
    }

    const permissions = AGENT_PERMISSIONS[config.type];
    const session: AgentSession = {
      config,
      status: "idle",
      currentTask: null,
      completedTasks: [],
      lockedFiles: new Set(),
      startedAt: null,
      messages: [],
    };

    this.state.agents.set(config.id, session);
    this.emitChange();
    return session;
  }

  /** Stop and remove an agent. Releases all file locks. */
  stopAgent(agentId: string): void {
    const session = this.state.agents.get(agentId);
    if (!session) return;

    // Release all file locks held by this agent
    for (const file of session.lockedFiles) {
      if (this.state.globalFileLocks.get(file) === agentId) {
        this.state.globalFileLocks.delete(file);
      }
    }

    session.status = "idle";
    session.lockedFiles.clear();
    session.currentTask = null;

    this.emitChange();
  }

  /** Remove an agent entirely. */
  removeAgent(agentId: string): void {
    this.stopAgent(agentId);
    this.state.agents.delete(agentId);
    this.emitChange();
  }

  // ── File Locking (Layer 1) ───────────────────────────────────────────────

  /**
   * Try to acquire exclusive lock on a file.
   * Returns true if lock acquired, false if file is already locked.
   */
  acquireFileLock(agentId: string, filePath: string): boolean {
    const existingOwner = this.state.globalFileLocks.get(filePath);
    if (existingOwner && existingOwner !== agentId) {
      return false; // File already locked by another agent
    }

    this.state.globalFileLocks.set(filePath, agentId);
    const session = this.state.agents.get(agentId);
    if (session) {
      session.lockedFiles.add(filePath);
    }
    this.emitChange();
    return true;
  }

  /** Release a file lock. */
  releaseFileLock(agentId: string, filePath: string): void {
    if (this.state.globalFileLocks.get(filePath) === agentId) {
      this.state.globalFileLocks.delete(filePath);
    }
    const session = this.state.agents.get(agentId);
    if (session) {
      session.lockedFiles.delete(filePath);
    }
    this.emitChange();
  }

  /** Check if a file is locked by any agent. */
  isFileLocked(filePath: string): boolean {
    return this.state.globalFileLocks.has(filePath);
  }

  /** Get which agent (if any) holds a lock on a file. */
  getFileLockOwner(filePath: string): string | null {
    return this.state.globalFileLocks.get(filePath) || null;
  }

  // ── Permission Checks (Layer 5) ──────────────────────────────────────────

  /**
   * Check if an agent is allowed to write to a file.
   * Returns { allowed: boolean, reason: string }
   */
  checkWritePermission(agentId: string, filePath: string): { allowed: boolean; reason: string } {
    const session = this.state.agents.get(agentId);
    if (!session) {
      return { allowed: false, reason: "Agent not found" };
    }

    const permissions = AGENT_PERMISSIONS[session.config.type];

    // Check if agent is read-only
    if (permissions.readonly) {
      return { allowed: false, reason: `${session.config.type} agent is read-only — cannot edit files` };
    }

    // Check deny patterns first (explicit denials)
    for (const pattern of permissions.denyPatterns) {
      if (this.matchGlob(filePath, pattern)) {
        return { allowed: false, reason: `File "${filePath}" matches deny pattern "${pattern}" for ${session.config.type} agent` };
      }
    }

    // Check write patterns (must match at least one)
    if (permissions.writePatterns.length > 0) {
      const allowed = permissions.writePatterns.some((p) => this.matchGlob(filePath, p));
      if (!allowed) {
        return {
          allowed: false,
          reason: `File "${filePath}" does not match any write pattern for ${session.config.type} agent (allowed: ${permissions.writePatterns.join(", ")})`,
        };
      }
    }

    // Check if file needs architecture re-validation after refactor
    if (permissions.requiresArchValidation && session.config.type === "refactor") {
      if (!this.state.architectureReport) {
        return {
          allowed: false,
          reason: "Architecture re-validation required before refactor agent can write (run architecture agent first)",
        };
      }
    }

    return { allowed: true, reason: "OK" };
  }

  /** Check if an agent can veto another agent's patch. */
  canVeto(agentId: string): boolean {
    const session = this.state.agents.get(agentId);
    if (!session) return false;
    return AGENT_PERMISSIONS[session.config.type].canVeto;
  }

  /** Check if an agent can block (not just veto) another agent's patch. */
  canBlock(agentId: string): boolean {
    const session = this.state.agents.get(agentId);
    if (!session) return false;
    return AGENT_PERMISSIONS[session.config.type].canBlock;
  }

  // ── Inter-Agent Communication ────────────────────────────────────────────

  /** Send a message from one agent to another. */
  sendMessage(from: string, to: string, type: AgentMessage["type"], content: string): void {
    const fromSession = this.state.agents.get(from);
    const toSession = this.state.agents.get(to);
    if (!fromSession || !toSession) return;

    const message: AgentMessage = {
      from,
      to,
      type,
      content,
      timestamp: Date.now(),
    };

    fromSession.messages.push(message);
    toSession.messages.push(message);
    this.emitChange();
  }

  /** Broadcast a message to all agents. */
  broadcast(from: string, type: AgentMessage["type"], content: string): void {
    for (const [id, session] of this.state.agents) {
      if (id === from) continue;
      const message: AgentMessage = {
        from,
        to: id,
        type,
        content,
        timestamp: Date.now(),
      };
      session.messages.push(message);
      this.state.agents.get(from)?.messages.push(message);
    }
    this.emitChange();
  }

  // ── Task Management ──────────────────────────────────────────────────────

  /** Add a task to the queue. */
  enqueueTask(task: AgentTask): void {
    this.state.taskQueue.push(task);
    this.state.tasks.push(task);
    this.emitChange();
  }

  /** Assign the next task from the queue to an idle agent. */
  assignNextTask(): AgentTask | null {
    // Sort queue by priority, then by dependency satisfaction
    const sorted = [...this.state.taskQueue]
      .filter((t) => t.status === "pending")
      .sort((a, b) => {
        // Priority first
        if (a.priority !== b.priority) return a.priority - b.priority;
        // Then dependency count (fewer dependencies first)
        return a.dependencies.length - b.dependencies.length;
      });

    for (const task of sorted) {
      // Check dependencies are complete
      const depsMet = task.dependencies.every((depId) => {
        const depTask = this.state.tasks.find((t) => t.id === depId);
        return depTask?.status === "completed";
      });
      if (!depsMet) continue;

      // Find an idle agent of matching type
      const agent = this.findIdleAgent();
      if (!agent) return null;

      task.status = "running";
      task.assignedTo = agent.config.id;
      agent.status = "running";
      agent.currentTask = task;
      agent.startedAt = Date.now();

      // Remove from queue, keep in tasks list
      this.state.taskQueue = this.state.taskQueue.filter((t) => t.id !== task.id);
      this.emitChange();
      return task;
    }

    return null;
  }

  /** Mark the current task of an agent as completed or failed. */
  completeTask(agentId: string, success: boolean, result?: string): void {
    const session = this.state.agents.get(agentId);
    if (!session || !session.currentTask) return;

    session.currentTask.status = success ? "completed" : "failed";
    session.currentTask.result = result;
    session.completedTasks.push(session.currentTask.id);
    session.currentTask = null;
    session.status = "idle";

    this.emitChange();
  }

  /** Veto an agent's current task (only architecture agent can do this). */
  vetoTask(agentId: string, reason: string): void {
    const session = this.state.agents.get(agentId);
    if (!session || !session.currentTask) return;

    session.currentTask.status = "vetoed";
    session.currentTask.result = reason;
    this.broadcast("orchestrator", "veto", `Task "${session.currentTask.description}" vetoed: ${reason}`);
    this.emitChange();
  }

  // ── State Getters ────────────────────────────────────────────────────────

  getState(): OrchestratorState {
    return this.state;
  }

  getAgentSessions(): AgentSession[] {
    return Array.from(this.state.agents.values());
  }

  getActiveAgentCount(): number {
    let count = 0;
    for (const [, session] of this.state.agents) {
      if (session.status === "running") count++;
    }
    return count;
  }

  getPendingTaskCount(): number {
    return this.state.taskQueue.filter((t) => t.status === "pending").length;
  }

  getFileLocks(): Map<string, string> {
    return new Map(this.state.globalFileLocks);
  }

  getArchitectureReport(): string | null {
    return this.state.architectureReport;
  }

  setArchitectureReport(report: string): void {
    this.state.architectureReport = report;
    this.emitChange();
  }

  getSecurityReport(): string | null {
    return this.state.securityReport;
  }

  setSecurityReport(report: string): void {
    this.state.securityReport = report;
    this.emitChange();
  }

  // ── Private Helpers ───────────────────────────────────────────────────────

  private findIdleAgent(): AgentSession | null {
    for (const [, session] of this.state.agents) {
      if (session.status === "idle") return session;
    }
    return null;
  }

  /** Simple glob matching: supports ** and * wildcards. */
  private matchGlob(filePath: string, pattern: string): boolean {
    // Normalize path separators
    const normalized = filePath.replace(/\\/g, "/");

    // Convert glob to regex
    const regexStr = pattern
      .replace(/\\/g, "/")
      .replace(/\./g, "\\.")
      .replace(/\*\*/g, "___DOUBLESTAR___")  // placeholder
      .replace(/\*/g, "[^/]*")
      .replace(/___DOUBLESTAR___/g, ".*");    // ** matches anything including /

    const regex = new RegExp(`^${regexStr}$`, "i");
    return regex.test(normalized);
  }
}

// ── Singleton ──────────────────────────────────────────────────────────────────

let instance: AgentOrchestrator | null = null;

export function getAgentOrchestrator(): AgentOrchestrator {
  if (!instance) {
    instance = new AgentOrchestrator();
  }
  return instance;
}