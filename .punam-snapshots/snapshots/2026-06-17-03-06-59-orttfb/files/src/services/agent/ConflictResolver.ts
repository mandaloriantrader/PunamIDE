/**
 * ConflictResolver.ts — Phase 5, Step 5.3
 *
 * Layer 1 (File-Level Mutex) + Layer 4 (3-Way Merge) integration.
 *
 * Detects overlapping file edits across agents and resolves conflicts.
 * Delegates to existing try_3way_merge in lib.rs for actual merging.
 */

import { getAgentOrchestrator } from "./AgentOrchestrator";
import type { AgentOrchestrator } from "./AgentOrchestrator";

export interface ConflictResult {
  file: string;
  hasConflict: boolean;
  resolution: "locked_by_other" | "merged" | "queued" | "no_conflict";
  message: string;
  mergedContent?: string;
}

interface EditAttempt {
  agentId: string;
  file: string;
  proposedContent: string;
  timestamp: number;
}

export class ConflictResolver {
  private orchestrator: AgentOrchestrator;
  private pendingEdits: Map<string, EditAttempt[]> = new Map();

  constructor() {
    this.orchestrator = getAgentOrchestrator();
  }

  /**
   * Attempt to acquire a file lock and register an edit.
   * If successful, the agent can proceed. If not, the edit is queued.
   */
  attemptEdit(
    agentId: string,
    file: string,
    proposedContent: string,
  ): ConflictResult {
    // Check write permission first (Layer 5)
    const permission = this.orchestrator.checkWritePermission(agentId, file);
    if (!permission.allowed) {
      return {
        file,
        hasConflict: true,
        resolution: "locked_by_other",
        message: `Permission denied: ${permission.reason}`,
      };
    }

    // Try to acquire file lock (Layer 1)
    const locked = this.orchestrator.acquireFileLock(agentId, file);
    if (!locked) {
      const owner = this.orchestrator.getFileLockOwner(file);
      // Queue the edit
      if (!this.pendingEdits.has(file)) {
        this.pendingEdits.set(file, []);
      }
      this.pendingEdits.get(file)!.push({
        agentId,
        file,
        proposedContent,
        timestamp: Date.now(),
      });

      return {
        file,
        hasConflict: true,
        resolution: "queued",
        message: `File locked by agent "${owner}". Edit queued for processing.`,
      };
    }

    // Lock is HELD — caller must call releaseAndFlush() after write completes.
    // Do NOT release here.
    return {
      file,
      hasConflict: false,
      resolution: "no_conflict",
      message: "File lock acquired and held — agent may proceed. Call releaseAndFlush() after write.",
    };
  }

  /**
   * Release a file lock and process any queued edits.
   */
  releaseAndFlush(agentId: string, file: string): EditAttempt[] {
    this.orchestrator.releaseFileLock(agentId, file);

    const queued = this.pendingEdits.get(file) || [];
    this.pendingEdits.delete(file);
    return queued;
  }

  /**
   * Check if any two agents have overlapping file targets.
   * Returns conflicting file paths.
   */
  detectOverlaps(agentFiles: Map<string, string[]>): string[] {
    const fileToAgents = new Map<string, string[]>();

    for (const [agentId, files] of agentFiles) {
      for (const file of files) {
        if (!fileToAgents.has(file)) {
          fileToAgents.set(file, []);
        }
        fileToAgents.get(file)!.push(agentId);
      }
    }

    // Return files with multiple agents targeting them
    const conflicts: string[] = [];
    for (const [file, agents] of fileToAgents) {
      if (agents.length > 1) {
        conflicts.push(file);
      }
    }

    return conflicts;
  }

  /**
   * Get all currently locked files and their owners.
   */
  getActiveLocks(): { file: string; agentId: string }[] {
    const locks = this.orchestrator.getFileLocks();
    return Array.from(locks.entries()).map(([file, agentId]) => ({ file, agentId }));
  }

  /**
   * Get pending edit queue for a file.
   */
  getPendingQueue(file: string): EditAttempt[] {
    return this.pendingEdits.get(file) || [];
  }
}

// ── Singleton ──────────────────────────────────────────────────────────────────

let instance: ConflictResolver | null = null;

export function getConflictResolver(): ConflictResolver {
  if (!instance) {
    instance = new ConflictResolver();
  }
  return instance;
}