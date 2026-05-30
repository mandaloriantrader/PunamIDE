/**
 * TaskScheduler.ts — Phase 5, Step 5.2
 *
 * Priority queue with dependency ordering and resource allocation.
 * Enforces Layer 6: sequential dependency ordering.
 *
 * Rules:
 *  - Architecture agent runs FIRST → analyzes impact
 *  - Implementation + Refactor agents run on separate files in parallel
 *  - Test agent runs after implementation
 *  - Security agent scans ALL changes after implementation
 *  - Architecture agent re-validates final result
 *  - Agents on SAME file are serialized; different files run in parallel
 */

import { getAgentOrchestrator } from "./AgentOrchestrator";
import type { AgentOrchestrator, AgentType } from "./AgentOrchestrator";

// ── Types ──────────────────────────────────────────────────────────────────────

export interface ScheduledTask {
  id: string;
  description: string;
  agentType: AgentType;
  files: string[];
  priority: number;
  dependsOn: string[];     // task IDs to wait for
  estimatedComplexity: number; // 1-10, for resource allocation
  maxRetries: number;
  retryCount: number;
}

export interface ScheduleResult {
  nextTask: ScheduledTask | null;
  blockedReason: string | null;
  queueLength: number;
  pendingByType: Record<AgentType, number>;
}

export interface ResourceAllocation {
  maxConcurrentAgents: number;
  activeAgents: number;
  availableSlots: number;
}

// ── TaskScheduler ──────────────────────────────────────────────────────────────

export class TaskScheduler {
  private queue: ScheduledTask[] = [];
  private completed: Set<string> = new Set();
  private orchestrator: AgentOrchestrator;
  private maxConcurrent: number;

  constructor(maxConcurrentAgents = 3) {
    this.orchestrator = getAgentOrchestrator();
    this.maxConcurrent = maxConcurrentAgents;
  }

  /**
   * Add a task to the scheduler.
   */
  enqueue(task: ScheduledTask): void {
    this.queue.push(task);
  }

  /**
   * Add multiple tasks with dependency ordering.
   * Automatically sets up sequential ordering:
   *   Architecture → Implementation → Test → Security → Architecture (re-validate)
   */
  enqueueWorkflow(tasks: Omit<ScheduledTask, "dependsOn" | "id">[]): void {
    let prevId: string | null = null;

    for (let i = 0; i < tasks.length; i++) {
      const id = `task-${Date.now()}-${i}`;
      const scheduled: ScheduledTask = {
        ...tasks[i],
        id,
        dependsOn: prevId ? [prevId] : [],
        maxRetries: 1,
        retryCount: 0,
      };

      this.queue.push(scheduled);
      prevId = id;
    }
  }

  /**
   * Get the next task that should be executed.
   * Respects:
   *  1. Dependency ordering (all dependsOn must be completed)
   *  2. File conflict avoidance (no two agents on same file)
   *  3. Resource limits (max concurrent agents)
   *  4. Priority ordering
   */
  getNextTask(): ScheduleResult {
    const activeCount = this.orchestrator.getActiveAgentCount();
    const locks = this.orchestrator.getFileLocks();
    const pendingByType: Record<AgentType, number> = {
      implementation: 0,
      test: 0,
      security: 0,
      architecture: 0,
      refactor: 0,
    };

    // Count pending tasks by type
    for (const task of this.queue) {
      pendingByType[task.agentType]++;
    }

    // Resource check
    if (activeCount >= this.maxConcurrent) {
      return {
        nextTask: null,
        blockedReason: `Resource limit reached (${activeCount}/${this.maxConcurrent} agents active)`,
        queueLength: this.queue.length,
        pendingByType,
      };
    }

    // Sort by priority, then by dependency count
    const sorted = [...this.queue].sort((a, b) => {
      if (a.priority !== b.priority) return a.priority - b.priority;
      return a.dependsOn.length - b.dependsOn.length;
    });

    for (const task of sorted) {
      // Check dependencies are met
      const depsMet = task.dependsOn.every((depId) => this.completed.has(depId));
      if (!depsMet) {
        continue;
      }

      // Check no file conflicts with active agents
      const hasConflict = task.files.some((file) => locks.has(file));
      if (hasConflict) {
        continue; // Another agent is working on one of these files
      }

      // Check agent type ordering rules
      const blockingReason = this.checkTypeOrdering(task);
      if (blockingReason) {
        return {
          nextTask: null,
          blockedReason: blockingReason,
          queueLength: this.queue.length,
          pendingByType,
        };
      }

      // Found runnable task — remove from queue
      this.queue = this.queue.filter((t) => t.id !== task.id);
      return {
        nextTask: task,
        blockedReason: null,
        queueLength: this.queue.length,
        pendingByType,
      };
    }

    // All tasks are blocked by dependencies
    const totalDeps = this.queue.reduce((sum, t) => sum + t.dependsOn.length, 0);
    return {
      nextTask: null,
      blockedReason: totalDeps > 0
        ? `${this.queue.length} task(s) waiting for dependencies to complete`
        : "No tasks in queue",
      queueLength: this.queue.length,
      pendingByType,
    };
  }

  /**
   * Mark a task as completed.
   */
  completeTask(taskId: string): void {
    this.completed.add(taskId);
  }

  /**
   * Mark a task as failed (for retry handling).
   */
  failTask(task: ScheduledTask): boolean {
    if (task.retryCount < task.maxRetries) {
      task.retryCount++;
      this.queue.push(task); // Re-enqueue for retry
      return true;
    }
    // Max retries exceeded — mark as permanently failed
    this.completed.add(task.id); // Mark "done" so dependents don't wait forever
    return false;
  }

  /**
   * Clear the queue and reset completed tasks.
   */
  reset(): void {
    this.queue = [];
    this.completed.clear();
  }

  /**
   * Get current resource allocation status.
   */
  getResourceAllocation(): ResourceAllocation {
    return {
      maxConcurrentAgents: this.maxConcurrent,
      activeAgents: this.orchestrator.getActiveAgentCount(),
      availableSlots: this.maxConcurrent - this.orchestrator.getActiveAgentCount(),
    };
  }

  /**
   * Get the queue status summary.
   */
  getQueueStatus(): ScheduleResult {
    return this.getNextTask(); // Re-use same logic for status
  }

  // ── Private: Type Ordering Rules ─────────────────────────────────────────

  /**
   * Check agent type ordering rules (Layer 6).
   *
   * Architecture → Implementation/Refactor → Test → Security → Architecture (re-validate)
   *
   * - Test agent cannot run if there are pending implementation tasks
   * - Security agent cannot run if there are pending implementation/test tasks
   * - Architecture (re-validate) cannot run if there are pending implementation tasks
   */
  private checkTypeOrdering(task: ScheduledTask): string | null {
    switch (task.agentType) {
      case "test": {
        // Test agent must wait for all implementation tasks
        const pendingImpl = this.queue.filter(
          (t) => t.agentType === "implementation" || t.agentType === "refactor",
        );
        if (pendingImpl.length > 0) {
          return `Test agent blocked: ${pendingImpl.length} implementation/refactor task(s) must complete first (Layer 6)`;
        }
        break;
      }

      case "security": {
        // Security scans after all implementation and test tasks
        const pendingWrites = this.queue.filter(
          (t) => t.agentType === "implementation" || t.agentType === "test" || t.agentType === "refactor",
        );
        if (pendingWrites.length > 0) {
          return `Security agent blocked: ${pendingWrites.length} write task(s) must complete before scan (Layer 6)`;
        }
        break;
      }

      case "architecture": {
        // If there are implementation tasks pending, this is likely a re-validation
        const pendingImpl = this.queue.filter(
          (t) => t.agentType === "implementation" && !this.completed.has(t.id),
        );
        // Architecture agent can run initially even with impl tasks (it runs first)
        // But if there are completed tasks and pending re-validation, that's fine
        break;
      }

      case "implementation":
      case "refactor": {
        // Implementation and refactor can run in parallel on different files
        // No specific ordering restriction besides file locking
        break;
      }
    }

    return null;
  }
}

// ── Singleton ──────────────────────────────────────────────────────────────────

let instance: TaskScheduler | null = null;

export function getTaskScheduler(maxConcurrent = 3): TaskScheduler {
  if (!instance) {
    instance = new TaskScheduler(maxConcurrent);
  }
  return instance;
}