/**
 * AgentApprovalGate — Approval overlay for agent-proposed edits.
 *
 * Shows a unified diff with syntax-highlighted additions/removals,
 * the agent's stated reasoning, per-hunk Accept/Reject toggles,
 * [Apply Selected], [Reject All], [Edit Before Apply] action buttons,
 * and a 5-minute countdown timer that auto-rejects on expiry.
 *
 * Emits Tauri events for the approval gate logic to consume:
 *   approval:{patchId} → { accepted, acceptedHunks, reason }
 *
 * Requirements: 5.4, 5.5, 5.6, 5.7
 */

import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import {
  Check,
  X,
  Clock,
  FileCode,
  ShieldAlert,
  Edit3,
  ChevronDown,
  ChevronRight,
} from "lucide-react";
import { emit } from "@tauri-apps/api/event";
import type { DiffHunk } from "../store/aiStore";
import type { ApprovalDecision } from "../utils/toolLoops/approvalGate";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface PatchProposalForUI {
  id: string;
  unifiedDiff: string;
  filesAffected: string[];
  linesChanged: number;
  agentReasoning: string;
  hunks: DiffHunk[];
  createdAt: number;
}

type HunkDecision = "accepted" | "rejected" | "pending";

interface Props {
  patch: PatchProposalForUI;
  onDecision: (decision: ApprovalDecision) => void;
}

// ─── Constants ───────────────────────────────────────────────────────────────

const TIMEOUT_SECONDS = 5 * 60; // 5 minutes

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Parse a unified diff string into displayable diff lines. */
function parseDiffLines(diff: string): Array<{
  id: number;
  type: "add" | "remove" | "context" | "header";
  content: string;
  oldLineNum?: number;
  newLineNum?: number;
}> {
  const lines = diff.split("\n");
  const result: Array<{
    id: number;
    type: "add" | "remove" | "context" | "header";
    content: string;
    oldLineNum?: number;
    newLineNum?: number;
  }> = [];

  let oldLine = 0;
  let newLine = 0;
  let id = 0;

  for (const line of lines) {
    if (line.startsWith("@@")) {
      // Parse hunk header: @@ -oldStart,oldCount +newStart,newCount @@
      const match = line.match(/@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
      if (match) {
        oldLine = parseInt(match[1], 10);
        newLine = parseInt(match[2], 10);
      }
      result.push({ id: id++, type: "header", content: line });
    } else if (line.startsWith("---") || line.startsWith("+++")) {
      result.push({ id: id++, type: "header", content: line });
    } else if (line.startsWith("+")) {
      result.push({ id: id++, type: "add", content: line.slice(1), newLineNum: newLine });
      newLine++;
    } else if (line.startsWith("-")) {
      result.push({ id: id++, type: "remove", content: line.slice(1), oldLineNum: oldLine });
      oldLine++;
    } else if (line.startsWith(" ") || line === "") {
      result.push({ id: id++, type: "context", content: line.startsWith(" ") ? line.slice(1) : line, oldLineNum: oldLine, newLineNum: newLine });
      oldLine++;
      newLine++;
    }
  }

  return result;
}

/** Format seconds into MM:SS display. */
function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

// ─── Component ───────────────────────────────────────────────────────────────

export default function AgentApprovalGate({ patch, onDecision }: Props) {
  // Per-hunk accept/reject state
  const [hunkDecisions, setHunkDecisions] = useState<HunkDecision[]>(
    () => patch.hunks.map(() => "pending")
  );

  // Countdown timer
  const [remainingSeconds, setRemainingSeconds] = useState(TIMEOUT_SECONDS);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Edit mode state
  const [editMode, setEditMode] = useState(false);
  const [editedDiff, setEditedDiff] = useState(patch.unifiedDiff);

  // Collapsed hunks in sidebar
  const [expandedHunks, setExpandedHunks] = useState<Record<number, boolean>>(
    () => Object.fromEntries(patch.hunks.map((_, i) => [i, true]))
  );

  // Parsed diff lines for display
  const diffLines = useMemo(() => parseDiffLines(patch.unifiedDiff), [patch.unifiedDiff]);

  // ─── Timer Logic ─────────────────────────────────────────────────────────

  useEffect(() => {
    timerRef.current = setInterval(() => {
      setRemainingSeconds((prev) => {
        if (prev <= 1) {
          // Timeout — auto-reject
          if (timerRef.current) clearInterval(timerRef.current);
          handleRejectAll("timeout");
          return 0;
        }
        return prev - 1;
      });
    }, 1000);

    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ─── Decision Handlers ───────────────────────────────────────────────────

  const emitDecision = useCallback(
    async (decision: ApprovalDecision) => {
      if (timerRef.current) clearInterval(timerRef.current);
      await emit(`approval:${patch.id}`, decision);
      onDecision(decision);
    },
    [patch.id, onDecision]
  );

  const handleApplySelected = useCallback(() => {
    const acceptedHunkIds = patch.hunks
      .filter((_, i) => hunkDecisions[i] === "accepted" || hunkDecisions[i] === "pending")
      .map((h) => h.id);

    const rejectedCount = hunkDecisions.filter((d) => d === "rejected").length;

    if (rejectedCount === 0) {
      // Full approval
      emitDecision({ accepted: true, acceptedHunks: patch.hunks.map((h) => h.id) });
    } else if (acceptedHunkIds.length === 0) {
      // All rejected
      emitDecision({ accepted: false, reason: "user rejected" });
    } else {
      // Partial acceptance
      emitDecision({ accepted: true, acceptedHunks: acceptedHunkIds });
    }
  }, [hunkDecisions, patch.hunks, emitDecision]);

  const handleRejectAll = useCallback(
    (reason = "user rejected") => {
      emitDecision({ accepted: false, reason });
    },
    [emitDecision]
  );

  const handleEditBeforeApply = useCallback(() => {
    if (editMode) {
      // Apply with edited patch
      emitDecision({
        accepted: true,
        acceptedHunks: patch.hunks.map((h) => h.id),
        editedPatch: editedDiff,
      });
    } else {
      setEditMode(true);
    }
  }, [editMode, editedDiff, patch.hunks, emitDecision]);

  const handleAcceptAll = useCallback(() => {
    setHunkDecisions(patch.hunks.map(() => "accepted"));
  }, [patch.hunks]);

  // ─── Per-hunk Toggle ─────────────────────────────────────────────────────

  const setHunkStatus = useCallback((index: number, status: HunkDecision) => {
    setHunkDecisions((prev) => {
      const next = [...prev];
      next[index] = status;
      return next;
    });
  }, []);

  const toggleExpand = useCallback((index: number) => {
    setExpandedHunks((prev) => ({ ...prev, [index]: !prev[index] }));
  }, []);

  // ─── Derived State ───────────────────────────────────────────────────────

  const acceptedCount = hunkDecisions.filter((d) => d === "accepted").length;
  const rejectedCount = hunkDecisions.filter((d) => d === "rejected").length;
  const pendingCount = hunkDecisions.filter((d) => d === "pending").length;
  const hasAnyAccepted = acceptedCount > 0 || pendingCount > 0;

  // Timer visual: warn when under 60 seconds
  const timerUrgent = remainingSeconds <= 60;
  const timerProgress = remainingSeconds / TIMEOUT_SECONDS;

  // ─── Render ──────────────────────────────────────────────────────────────

  return (
    <div className="approval-gate-overlay" role="dialog" aria-label="Agent approval gate">
      <div className="approval-gate">
        {/* Header */}
        <div className="approval-gate-header">
          <div className="approval-gate-header-left">
            <ShieldAlert size={18} />
            <div>
              <h2>Agent Edit Approval</h2>
              <p className="approval-gate-subtitle">
                {patch.filesAffected.length} file{patch.filesAffected.length !== 1 ? "s" : ""} &middot;{" "}
                {patch.linesChanged} lines changed
              </p>
            </div>
          </div>
          <div className="approval-gate-timer-area">
            <div className={`approval-gate-timer ${timerUrgent ? "timer-urgent" : ""}`}>
              <Clock size={14} />
              <span>{formatTime(remainingSeconds)}</span>
              <div className="timer-progress-bar">
                <div
                  className="timer-progress-fill"
                  style={{ width: `${timerProgress * 100}%` }}
                />
              </div>
            </div>
            <button className="icon-btn" type="button" onClick={() => handleRejectAll()} aria-label="Dismiss">
              <X size={16} />
            </button>
          </div>
        </div>

        {/* Body */}
        <div className="approval-gate-body">
          {/* Left: Reasoning + Hunk list */}
          <aside className="approval-gate-sidebar">
            {/* Agent reasoning */}
            <div className="approval-gate-reasoning">
              <span className="approval-gate-section-title">Agent Reasoning</span>
              <p className="approval-gate-reasoning-text">{patch.agentReasoning}</p>
            </div>

            {/* Files affected */}
            <div className="approval-gate-files">
              <span className="approval-gate-section-title">Files Affected</span>
              {patch.filesAffected.map((file) => (
                <div key={file} className="approval-gate-file-item">
                  <FileCode size={12} />
                  <span>{file}</span>
                </div>
              ))}
            </div>

            {/* Per-hunk toggles */}
            <div className="approval-gate-hunks-list">
              <span className="approval-gate-section-title">
                Hunks ({patch.hunks.length})
              </span>
              {patch.hunks.map((hunk, i) => (
                <div key={hunk.id} className="approval-gate-hunk-item">
                  <div className="approval-gate-hunk-header">
                    <button
                      className="approval-gate-hunk-expand"
                      onClick={() => toggleExpand(i)}
                      type="button"
                    >
                      {expandedHunks[i] ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                    </button>
                    <span className="approval-gate-hunk-loc">
                      {hunk.filePath.split(/[/\\]/).pop()}:{hunk.startLine}-{hunk.endLine}
                    </span>
                    <div className="approval-gate-hunk-actions">
                      <button
                        className={`hunk-toggle-btn ${hunkDecisions[i] === "accepted" ? "active-accept" : ""}`}
                        onClick={() => setHunkStatus(i, "accepted")}
                        title="Accept hunk"
                        type="button"
                      >
                        <Check size={10} />
                      </button>
                      <button
                        className={`hunk-toggle-btn ${hunkDecisions[i] === "rejected" ? "active-reject" : ""}`}
                        onClick={() => setHunkStatus(i, "rejected")}
                        title="Reject hunk"
                        type="button"
                      >
                        <X size={10} />
                      </button>
                    </div>
                  </div>
                  {expandedHunks[i] && (
                    <div className="approval-gate-hunk-preview">
                      <pre className="hunk-old-content">{hunk.oldContent.slice(0, 200)}{hunk.oldContent.length > 200 ? "..." : ""}</pre>
                      <pre className="hunk-new-content">{hunk.newContent.slice(0, 200)}{hunk.newContent.length > 200 ? "..." : ""}</pre>
                    </div>
                  )}
                </div>
              ))}
              {/* Bulk actions */}
              <div className="approval-gate-hunk-bulk">
                <button type="button" className="hunk-bulk-accept" onClick={handleAcceptAll}>
                  Accept All
                </button>
                <button type="button" className="hunk-bulk-reject" onClick={() => setHunkDecisions(patch.hunks.map(() => "rejected"))}>
                  Reject All
                </button>
              </div>
            </div>
          </aside>

          {/* Right: Diff viewer */}
          <section className="approval-gate-main">
            {editMode ? (
              <div className="approval-gate-edit-area">
                <div className="approval-gate-edit-header">
                  <span>Edit patch before applying</span>
                  <button
                    type="button"
                    className="btn-secondary compact"
                    onClick={() => { setEditMode(false); setEditedDiff(patch.unifiedDiff); }}
                  >
                    Cancel Edit
                  </button>
                </div>
                <textarea
                  className="approval-gate-edit-textarea"
                  value={editedDiff}
                  onChange={(e) => setEditedDiff(e.target.value)}
                  spellCheck={false}
                />
              </div>
            ) : (
              <div className="approval-gate-diff-view">
                <div className="approval-gate-diff-header">
                  <span>Unified Diff</span>
                </div>
                <div className="approval-gate-diff-lines">
                  {diffLines.map((line) => (
                    <div
                      key={line.id}
                      className={`approval-diff-line ${
                        line.type === "add"
                          ? "line-added"
                          : line.type === "remove"
                          ? "line-removed"
                          : line.type === "header"
                          ? "line-header"
                          : ""
                      }`}
                    >
                      <span className="approval-diff-line-num">
                        {line.type === "remove" || line.type === "context"
                          ? line.oldLineNum ?? ""
                          : ""}
                      </span>
                      <span className="approval-diff-line-num">
                        {line.type === "add" || line.type === "context"
                          ? line.newLineNum ?? ""
                          : ""}
                      </span>
                      <span className="approval-diff-line-prefix">
                        {line.type === "add" ? "+" : line.type === "remove" ? "-" : line.type === "header" ? "" : " "}
                      </span>
                      <span className="approval-diff-line-content">{line.content}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </section>
        </div>

        {/* Footer */}
        <div className="approval-gate-footer">
          <div className="approval-gate-footer-stats">
            <span className="footer-stat-accepted">{acceptedCount} accepted</span>
            <span className="footer-stat-rejected">{rejectedCount} rejected</span>
            <span className="footer-stat-pending">{pendingCount} pending</span>
          </div>
          <div className="approval-gate-footer-actions">
            <button
              type="button"
              className="btn-secondary"
              onClick={() => handleRejectAll()}
            >
              <X size={14} />
              Reject All
            </button>
            <button
              type="button"
              className="btn-secondary"
              onClick={handleEditBeforeApply}
            >
              <Edit3 size={14} />
              {editMode ? "Apply Edited" : "Edit Before Apply"}
            </button>
            <button
              type="button"
              className="btn-primary"
              onClick={handleApplySelected}
              disabled={!hasAnyAccepted}
            >
              <Check size={14} />
              Apply Selected
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
