/**
 * Approval Gate — Pauses the agent tool loop and requests user approval
 * for edits that exceed defined thresholds (line count, file count, or
 * sensitive file patterns). Uses Tauri events for bi-directional
 * communication with the UI.
 *
 * Requirements: 5.1, 5.2, 5.3, 5.5, 5.6, 5.8, 6.5
 */

import { emit, listen } from "@tauri-apps/api/event";
import { useAIStore } from "../../store/aiStore";
import type { DiffHunk, ApprovalQueueItem } from "../../store/aiStore";

// ─── Interfaces ──────────────────────────────────────────────────────────────

export interface PatchProposal {
  id: string;
  unifiedDiff: string;
  filesAffected: string[];
  linesChanged: number;
  agentReasoning: string;
  hunks: DiffHunk[];
  createdAt: number;
}

export interface ApprovalDecision {
  accepted: boolean;
  acceptedHunks?: number[];
  editedPatch?: string;
  reason?: string;
}

// ─── Constants ───────────────────────────────────────────────────────────────

/** Thresholds that determine whether an edit requires user approval. */
export const APPROVAL_THRESHOLDS = {
  linesChanged: 500,
  filesChanged: 5,
  sensitiveFiles: [
    ".env",
    ".env.*",
    "*.lock",
    "*.key",
    "*.pem",
    "Cargo.toml",
    "package.json",
    "tauri.conf.json",
  ],
} as const;

/** Time (ms) before an unanswered approval request auto-rejects. */
const TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

/** Maximum number of pending items allowed in the approval queue. */
const MAX_QUEUE_SIZE = 10;

// ─── Sensitive File Matching ─────────────────────────────────────────────────

/**
 * Checks whether a file path matches any of the sensitive file patterns.
 *
 * Supported patterns:
 * - Exact name match: `Cargo.toml`, `package.json`, `tauri.conf.json`
 * - Extension glob: `*.lock`, `*.key`, `*.pem`
 * - Prefix with wildcard: `.env.*` (matches `.env.local`, `.env.production`, etc.)
 * - Exact dotfile: `.env`
 */
export function matchesSensitivePattern(filePath: string): boolean {
  const name = filePath.split(/[/\\]/).pop() || "";

  return APPROVAL_THRESHOLDS.sensitiveFiles.some((pattern) => {
    // Exact match (e.g. "Cargo.toml", "package.json", ".env")
    if (!pattern.includes("*")) {
      return name === pattern;
    }

    // Convert glob pattern to regex:
    //   .env.* → ^\.env\..*$
    //   *.lock → ^.*\.lock$
    const regexStr =
      "^" +
      pattern
        .replace(/\./g, "\\.")
        .replace(/\*/g, ".*") +
      "$";
    const regex = new RegExp(regexStr);
    return regex.test(name);
  });
}

// ─── Gate Logic ──────────────────────────────────────────────────────────────

/**
 * Evaluates whether a patch proposal requires user approval and, if so,
 * adds it to the approval queue, emits a Tauri event, and waits for the
 * user's decision or a 5-minute timeout.
 *
 * Auto-approves patches that are below ALL thresholds.
 */
export async function gatePatchWithApproval(
  patch: PatchProposal
): Promise<ApprovalDecision> {
  const requiresApproval =
    patch.linesChanged > APPROVAL_THRESHOLDS.linesChanged ||
    patch.filesAffected.length > APPROVAL_THRESHOLDS.filesChanged ||
    patch.filesAffected.some((f) => matchesSensitivePattern(f));

  // Below all thresholds — auto-approve without user interaction
  if (!requiresApproval) {
    return { accepted: true };
  }

  const store = useAIStore.getState();

  // If queue is at capacity, auto-reject the oldest pending item first
  if (store.pendingApprovalCount >= MAX_QUEUE_SIZE) {
    const oldest = store.approvalQueue.find((q) => q.status === "pending");
    if (oldest) {
      store.updateApprovalStatus(oldest.patchId, "timed_out");
    }
  }

  // Build queue item and add to store
  const queueItem: ApprovalQueueItem = {
    patchId: patch.id,
    diff: patch.unifiedDiff,
    filesAffected: patch.filesAffected,
    agentReasoning: patch.agentReasoning,
    status: "pending",
    createdAt: patch.createdAt,
    hunks: patch.hunks,
  };

  store.addApprovalRequest(queueItem);

  // Notify UI that approval is required
  await emit("agent:approval_required", {
    patchId: patch.id,
    diff: patch.unifiedDiff,
    filesAffected: patch.filesAffected,
    agentReasoning: patch.agentReasoning,
    linesChanged: patch.linesChanged,
  });

  // Wait for user decision or timeout
  return new Promise<ApprovalDecision>((resolve) => {
    let resolved = false;

    const timer = setTimeout(() => {
      if (resolved) return;
      resolved = true;

      // Timeout — auto-reject and notify
      useAIStore.getState().updateApprovalStatus(patch.id, "timed_out");
      resolve({ accepted: false, reason: "timeout" });

      // Notify user of the auto-rejection
      emit("agent:approval_timeout", { patchId: patch.id }).catch(() => {});
    }, TIMEOUT_MS);

    // Listen for user's decision event
    const unlistenPromise = listen<ApprovalDecision>(
      `approval:${patch.id}`,
      (event) => {
        if (resolved) return;
        resolved = true;

        clearTimeout(timer);
        unlistenPromise.then((unlisten) => unlisten());

        const decision = event.payload;
        const newStatus = decision.accepted ? "approved" : "rejected";
        useAIStore.getState().updateApprovalStatus(patch.id, newStatus);

        resolve(decision);
      }
    );
  });
}
