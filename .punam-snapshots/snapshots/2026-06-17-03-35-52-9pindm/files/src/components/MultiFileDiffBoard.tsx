import { useMemo, useState, useCallback } from "react";
import { Check, X, ChevronDown, ChevronRight, FileCode, FileX, FilePlus, GitPullRequest } from "lucide-react";
import type { ReviewFileChange } from "./AiDiffPreview";

// ── Re-export the ReviewChanges type ─────────────────────────
export interface ReviewChanges {
  fileChanges: ReviewFileChange[];
  deletions: { path: string; original: string }[];
  commands: string[];
}

// ── Types ──────────────────────────────────────────────────────────────────

interface DiffHunk {
  index: number;
  oldStart: number;
  newStart: number;
  lines: Array<{
    id: number;
    kind: "add" | "remove" | "context";
    original: string;
    proposed: string;
  }>;
}

type HunkStatus = "accepted" | "rejected" | "pending";

interface FileDiffState {
  path: string;
  isNew: boolean;
  isDelete: boolean;
  hunks: DiffHunk[];
  hunkStatus: HunkStatus[];
  hasUnsavedChanges?: boolean;
}

// ── Props ──────────────────────────────────────────────────────────────────

interface Props {
  changes: ReviewChanges;
  onApplyAll: () => void;
  onApplyFile: (path: string) => void;
  onRejectFile: (path: string) => void;
  onCancel: () => void;
}

// ── Helper: Parse diff into hunks ──────────────────────────────────────────

function computeLCS(a: string[], b: string[]): string[] {
  const m = a.length, n = b.length;
  if (m * n > 1_000_000) {
    return Array.from({ length: Math.max(m, n) }, (_, i) => a[i] === b[i] ? a[i] : "").filter(Boolean);
  }
  const dp: number[][] = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0));
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i - 1] === b[j - 1] ? dp[i - 1][j - 1] + 1 : Math.max(dp[i - 1][j], dp[i][j - 1]);
    }
  }
  const lcs: string[] = [];
  let i = m, j = n;
  while (i > 0 && j > 0) {
    if (a[i - 1] === b[j - 1]) { lcs.unshift(a[i - 1]); i--; j--; }
    else if (dp[i - 1][j] > dp[i][j - 1]) i--;
    else j--;
  }
  return lcs;
}

function parseHunks(original: string, proposed: string): DiffHunk[] {
  const origLines = original.split("\n");
  const propLines = proposed.split("\n");

  // If identical, no hunks
  if (original === proposed) return [];

  const lcs = computeLCS(origLines, propLines);
  const hunks: DiffHunk[] = [];
  let currentHunk: DiffHunk["lines"] = [];
  let oi = 0, pi = 0, li = 0, id = 0;
  let hunkOldStart = 1, hunkNewStart = 1;
  let inHunk = false;

  const flushHunk = () => {
    if (currentHunk.length > 0) {
      // Count context lines at start/end to trim for compactness
      let startIdx = 0;
      while (startIdx < currentHunk.length && currentHunk[startIdx].kind === "context") startIdx++;
      let endIdx = currentHunk.length;
      while (endIdx > startIdx && currentHunk[endIdx - 1].kind === "context") endIdx--;

      const trimmed = currentHunk.slice(Math.max(0, startIdx - 1), Math.min(currentHunk.length, endIdx + 1));
      if (trimmed.length > 0) {
        // Find actual old/new start from first non-context line in trimmed
        let actualOldStart = hunkOldStart;
        let actualNewStart = hunkNewStart;
        for (let i = 0; i < trimmed.length; i++) {
          const line = trimmed[i];
          if (line.kind !== "context") break;
          if (line.original !== "") actualOldStart++;
          if (line.proposed !== "") actualNewStart++;
        }

        hunks.push({
          index: hunks.length,
          oldStart: actualOldStart,
          newStart: actualNewStart,
          lines: trimmed,
        });
      }
      currentHunk = [];
    }
  };

  while (oi < origLines.length || pi < propLines.length) {
    const origLine = oi < origLines.length ? origLines[oi] : null;
    const propLine = pi < propLines.length ? propLines[pi] : null;
    const lcsLine = li < lcs.length ? lcs[li] : null;

    if (origLine !== null && propLine !== null && lcsLine !== null && origLine === lcsLine && propLine === lcsLine) {
      // Context line
      if (inHunk) {
        currentHunk.push({ id: id++, kind: "context", original: origLine, proposed: propLine });
      }
      oi++; pi++; li++;
      hunkOldStart++; hunkNewStart++;
    } else if (propLine !== null && lcsLine !== null && propLine === lcsLine && (origLine === null || origLine !== lcsLine)) {
      // Line removed
      if (!inHunk) { flushHunk(); inHunk = true; hunkOldStart = oi + 1; hunkNewStart = pi + 1; }
      currentHunk.push({ id: id++, kind: "remove", original: origLine ?? "", proposed: "" });
      oi++;
      hunkOldStart++;
    } else if (origLine !== null && lcsLine !== null && origLine === lcsLine && (propLine === null || propLine !== lcsLine)) {
      // Line added
      if (!inHunk) { flushHunk(); inHunk = true; hunkOldStart = oi + 1; hunkNewStart = pi + 1; }
      currentHunk.push({ id: id++, kind: "add", original: "", proposed: propLine ?? "" });
      pi++;
      hunkNewStart++;
    } else {
      // Both differ — change
      if (!inHunk) { flushHunk(); inHunk = true; hunkOldStart = oi + 1; hunkNewStart = pi + 1; }
      if (origLine !== null) {
        currentHunk.push({ id: id++, kind: "remove", original: origLine, proposed: "" });
        oi++; hunkOldStart++;
      }
      if (propLine !== null) {
        currentHunk.push({ id: id++, kind: "add", original: "", proposed: propLine });
        pi++; hunkNewStart++;
      }
      if (origLine === null) { pi++; hunkNewStart++; }
      if (propLine === null) { oi++; hunkOldStart++; }
    }
  }

  flushHunk();
  return hunks;
}

// ── Helper: Apply accepted hunks to produce final content ──────────────────

function applyAcceptedHunks(original: string, hunks: DiffHunk[], statuses: HunkStatus[]): string {
  const origLines = original.split("\n");
  const result: string[] = [];
  let oi = 0;

  for (let h = 0; h < hunks.length; h++) {
    const hunk = hunks[h];
    const status = statuses[h] || "pending";

    // Copy unchanged lines before this hunk
    const hunkOldStart = hunk.oldStart - 1; // 0-indexed
    while (oi < hunkOldStart && oi < origLines.length) {
      result.push(origLines[oi]);
      oi++;
    }

    // Count how many original lines this hunk covers
    const removeCount = hunk.lines.filter(l => l.kind === "remove" || l.kind === "context").length;

    if (status === "accepted") {
      // Apply the hunk's additions
      const adds = hunk.lines.filter(l => l.kind === "add").map(l => l.proposed);
      result.push(...adds);
    } else {
      // Rejected/pending: keep original lines
      for (let k = 0; k < removeCount; k++) {
        if (oi < origLines.length) {
          result.push(origLines[oi]);
          oi++;
        }
      }
      continue;
    }

    // Skip the removed lines in original
    oi += removeCount;
  }

  // Copy remaining lines
  while (oi < origLines.length) {
    result.push(origLines[oi]);
    oi++;
  }

  return result.join("\n");
}

// ── Component ──────────────────────────────────────────────────────────────

export default function MultiFileDiffBoard({
  changes,
  onApplyAll,
  onApplyFile,
  onCancel,
}: Props) {
  // Parse all files into hunks
  const fileDiffs = useMemo<FileDiffState[]>(() => {
    const result: FileDiffState[] = [];

    for (const change of changes.fileChanges) {
      const hunks = parseHunks(change.original, change.proposed);
      result.push({
        path: change.path,
        isNew: change.isNew,
        isDelete: false,
        hunks: hunks.length > 0 ? hunks : [{ index: 0, oldStart: 1, newStart: 1, lines: [{ id: 0, kind: "add", original: "", proposed: change.proposed }] }],
        hunkStatus: new Array(Math.max(1, hunks.length)).fill("pending"),
        hasUnsavedChanges: change.hasUnsavedChanges,
      });
    }

    for (const deletion of changes.deletions) {
      result.push({
        path: deletion.path,
        isNew: false,
        isDelete: true,
        hunks: [{ index: 0, oldStart: 1, newStart: 1, lines: [{ id: 0, kind: "remove", original: deletion.original, proposed: "" }] }],
        hunkStatus: ["pending"],
      });
    }

    return result;
  }, [changes]);

  const [selectedPath, setSelectedPath] = useState(fileDiffs[0]?.path || "");
  const [hunkStatuses, setHunkStatuses] = useState<Record<string, HunkStatus[]>>(() => {
    const map: Record<string, HunkStatus[]> = {};
    for (const fd of fileDiffs) {
      map[fd.path] = [...fd.hunkStatus];
    }
    return map;
  });
  const [collapsedFiles, setCollapsedFiles] = useState<Record<string, boolean>>({});

  const selectedFile = fileDiffs.find(fd => fd.path === selectedPath) || fileDiffs[0];

  // Derived counts
  const fileStatusCounts = useMemo(() => {
    const counts: Record<string, { accepted: number; rejected: number; total: number }> = {};
    for (const fd of fileDiffs) {
      const statuses = hunkStatuses[fd.path] || fd.hunkStatus;
      counts[fd.path] = {
        total: statuses.length,
        accepted: statuses.filter(s => s === "accepted").length,
        rejected: statuses.filter(s => s === "rejected").length,
      };
    }
    return counts;
  }, [fileDiffs, hunkStatuses]);

  const totalAccepted = Object.values(fileStatusCounts).reduce((sum, c) => sum + c.accepted, 0);
  const totalRejected = Object.values(fileStatusCounts).reduce((sum, c) => sum + c.rejected, 0);
  const totalHunks = Object.values(fileStatusCounts).reduce((sum, c) => sum + c.total, 0);
  const allDecided = totalAccepted + totalRejected === totalHunks && totalHunks > 0;

  const setHunkStatus = useCallback((path: string, hunkIndex: number, status: HunkStatus) => {
    setHunkStatuses(prev => {
      const current = prev[path] ? [...prev[path]] : (fileDiffs.find(fd => fd.path === path)?.hunkStatus || []);
      current[hunkIndex] = status;
      return { ...prev, [path]: current };
    });
  }, [fileDiffs]);

  const acceptAllHunks = useCallback((path: string) => {
    const fd = fileDiffs.find(f => f.path === path);
    if (!fd) return;
    setHunkStatuses(prev => ({
      ...prev,
      [path]: fd.hunkStatus.map(() => "accepted" as HunkStatus),
    }));
  }, [fileDiffs]);

  const rejectAllHunks = useCallback((path: string) => {
    const fd = fileDiffs.find(f => f.path === path);
    if (!fd) return;
    setHunkStatuses(prev => ({
      ...prev,
      [path]: fd.hunkStatus.map(() => "rejected" as HunkStatus),
    }));
  }, [fileDiffs]);

  const acceptAll = useCallback(() => {
    const next: Record<string, HunkStatus[]> = {};
    for (const fd of fileDiffs) {
      next[fd.path] = fd.hunkStatus.map(() => "accepted");
    }
    setHunkStatuses(next);
  }, [fileDiffs]);

  const rejectAll = useCallback(() => {
    const next: Record<string, HunkStatus[]> = {};
    for (const fd of fileDiffs) {
      next[fd.path] = fd.hunkStatus.map(() => "rejected");
    }
    setHunkStatuses(next);
  }, [fileDiffs]);

  const toggleFileCollapse = useCallback((path: string) => {
    setCollapsedFiles(prev => ({ ...prev, [path]: !prev[path] }));
  }, []);

  // Apply selected hunks: reconstruct changes with only accepted hunks
  const handleApplySelected = useCallback(async () => {
    // For each file, reconstruct the proposed content from only accepted hunks
    const acceptedChanges: ReviewFileChange[] = [];
    for (const fd of fileDiffs) {
      if (fd.isDelete) {
        const status = (hunkStatuses[fd.path] || fd.hunkStatus)[0];
        if (status === "accepted") {
          // Still include deletions
          acceptedChanges.push({
            path: fd.path,
            original: fd.hunks[0]?.lines.find(l => l.kind === "remove")?.original || "",
            proposed: "",
            isNew: false,
          });
        }
        continue;
      }

      const statuses = hunkStatuses[fd.path] || fd.hunkStatus;
      const original = changes.fileChanges.find(c => c.path === fd.path)?.original || "";
      const proposed = applyAcceptedHunks(original, fd.hunks, statuses);

      if (proposed !== original) {
        acceptedChanges.push({
          path: fd.path,
          original,
          proposed,
          isNew: fd.isNew,
        });
      }
    }

    // If no changes remain, cancel
    if (acceptedChanges.length === 0) {
      onCancel();
      return;
    }

    // Call apply file for each
    for (const change of acceptedChanges) {
      onApplyFile(change.path);
    }
  }, [fileDiffs, hunkStatuses, changes.fileChanges, onApplyFile, onCancel]);

  // Get total line counts per file for display
  const fileStats = useMemo(() => {
    const stats: Record<string, { adds: number; removes: number }> = {};
    for (const fd of fileDiffs) {
      let adds = 0, removes = 0;
      for (const hunk of fd.hunks) {
        for (const line of hunk.lines) {
          if (line.kind === "add") adds++;
          if (line.kind === "remove") removes++;
        }
      }
      stats[fd.path] = { adds, removes };
    }
    return stats;
  }, [fileDiffs]);

  // Get hunk count label
  const getFileLabel = (fd: FileDiffState) => {
    if (fd.isDelete) return "DELETE";
    if (fd.isNew) return "NEW";
    const stats = fileStats[fd.path];
    if (!stats) return "EDIT";
    return `~${stats.removes} +${stats.adds}`;
  };

  // Get overall status icon for a file
  const getFileStatusIcon = (fd: FileDiffState) => {
    const counts = fileStatusCounts[fd.path];
    if (!counts) return null;
    if (counts.accepted === counts.total && counts.total > 0) return <Check size={14} className="diff-file-accepted-icon" />;
    if (counts.rejected === counts.total && counts.total > 0) return <X size={14} className="diff-file-rejected-icon" />;
    return null;
  };

  return (
    <div className="multi-diff-overlay" role="dialog" aria-label="Review AI changes per hunk">
      <div className="multi-diff">
        {/* Header */}
        <div className="multi-diff-header">
          <div className="multi-diff-header-left">
            <GitPullRequest size={18} />
            <div>
              <h2>Review AI Changes</h2>
              <p className="multi-diff-header-subtitle">
                {fileDiffs.length} file{fileDiffs.length !== 1 ? "s" : ""} changed &mdash; Accept or reject individual hunks
              </p>
            </div>
          </div>
          <button className="icon-btn" type="button" onClick={onCancel} aria-label="Close review">
            <X size={16} />
          </button>
        </div>

        {/* Body */}
        <div className="multi-diff-body">
          {/* Sidebar: file list */}
          <aside className="multi-diff-sidebar">
            <div className="multi-diff-sidebar-header">
              <span className="multi-diff-sidebar-title">Changed Files</span>
              <span className="multi-diff-sidebar-count">{fileDiffs.length}</span>
            </div>
            <div className="multi-diff-file-list">
              {fileDiffs.map((fd) => {
                const counts = fileStatusCounts[fd.path];
                const isCollapsed = collapsedFiles[fd.path];
                const allAccepted = counts?.accepted === counts?.total && counts.total > 0;
                const allRejected = counts?.rejected === counts?.total && counts.total > 0;
                return (
                  <div key={fd.path} className="multi-diff-file-group">
                    <button
                      className={`multi-diff-file-item ${fd.path === selectedPath ? "selected" : ""} ${allAccepted ? "file-accepted" : ""} ${allRejected ? "file-rejected" : ""}`}
                      onClick={() => setSelectedPath(fd.path)}
                    >
                      <span className="multi-diff-file-icon" onClick={(e) => { e.stopPropagation(); toggleFileCollapse(fd.path); }}>
                        {isCollapsed ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
                      </span>
                      {fd.isDelete ? <FileX size={14} className="diff-file-type-delete" /> : fd.isNew ? <FilePlus size={14} className="diff-file-type-add" /> : <FileCode size={14} />}
                      <span className="multi-diff-file-name">{fd.path.split("/").pop()}</span>
                      <span className="multi-diff-file-label">{getFileLabel(fd)}</span>
                      {getFileStatusIcon(fd)}
                    </button>
                    {/* Per-file hunk list (only if expanded) */}
                    {!isCollapsed && fd.path === selectedPath && (
                      <div className="multi-diff-hunk-summary">
                        {fd.hunks.map((hunk, hi) => {
                          const st = (hunkStatuses[fd.path] || fd.hunkStatus)[hi] || "pending";
                          return (
                            <div key={hi} className={`multi-diff-hunk-summary-item hunk-${st}`}>
                              <span className="hunk-summary-loc">
                                {hunk.oldStart}-{hunk.lines.filter(l => l.kind !== "add").length + hunk.oldStart - 1}
                              </span>
                              <span className="hunk-summary-counts">
                                +{hunk.lines.filter(l => l.kind === "add").length}
                                -{hunk.lines.filter(l => l.kind === "remove").length}
                              </span>
                              {st === "pending" && (
                                <div className="hunk-summary-actions">
                                  <button className="hunk-accept-btn" onClick={(e) => { e.stopPropagation(); setHunkStatus(fd.path, hi, "accepted"); }} title="Accept hunk"><Check size={10} /></button>
                                  <button className="hunk-reject-btn" onClick={(e) => { e.stopPropagation(); setHunkStatus(fd.path, hi, "rejected"); }} title="Reject hunk"><X size={10} /></button>
                                </div>
                              )}
                              {st === "accepted" && <span className="hunk-status-badge hunk-status-accepted">Accepted</span>}
                              {st === "rejected" && <span className="hunk-status-badge hunk-status-rejected">Rejected</span>}
                            </div>
                          );
                        })}
                        {fd.hunks.length > 1 && (
                          <div className="hunk-bulk-actions">
                            <button className="hunk-bulk-accept" onClick={() => acceptAllHunks(fd.path)}>Accept all</button>
                            <button className="hunk-bulk-reject" onClick={() => rejectAllHunks(fd.path)}>Reject all</button>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
            {/* Commands section */}
            {changes.commands.length > 0 && (
              <div className="multi-diff-commands">
                <div className="multi-diff-sidebar-header">
                  <span className="multi-diff-sidebar-title">Commands</span>
                  <span className="multi-diff-sidebar-count">{changes.commands.length}</span>
                </div>
                <div className="multi-diff-command-list">
                  {changes.commands.map((cmd, i) => (
                    <code key={i} className="multi-diff-command-item">{cmd}</code>
                  ))}
                </div>
              </div>
            )}
          </aside>

          {/* Main: diff viewer */}
          <section className="multi-diff-main">
            {selectedFile ? (
              <>
                <div className="multi-diff-file-header">
                  <div className="multi-diff-file-info">
                    <span className="multi-diff-file-path">{selectedFile.path}</span>
                    {selectedFile.hasUnsavedChanges && (
                      <span className="diff-unsaved-warning">Unsaved editor changes</span>
                    )}
                  </div>
                  <div className="multi-diff-file-actions">
                    <button
                      className="btn-secondary compact"
                      onClick={() => rejectAllHunks(selectedFile.path)}
                      title="Reject all hunks in this file"
                    >
                      Reject File
                    </button>
                    <button
                      className="btn-primary compact"
                      onClick={() => acceptAllHunks(selectedFile.path)}
                      title="Accept all hunks in this file"
                    >
                      Accept File
                    </button>
                  </div>
                </div>

                {/* Hunk viewer */}
                <div className="multi-diff-hunks">
                  {selectedFile.hunks.map((hunk, hi) => {
                    const st = (hunkStatuses[selectedFile.path] || selectedFile.hunkStatus)[hi] || "pending";
                    return (
                      <div key={hi} className={`multi-diff-hunk ${st === "accepted" ? "hunk-accepted" : ""} ${st === "rejected" ? "hunk-rejected" : ""}`}>
                        <div className="multi-diff-hunk-header">
                          <div className="hunk-header-loc">
                            <span className="hunk-header-badge">@@</span>
                            <span>Line {hunk.oldStart}</span>
                          </div>
                          <div className="hunk-header-actions">
                            {st === "pending" ? (
                              <>
                                <button
                                  className="hunk-btn hunk-btn-accept"
                                  onClick={() => setHunkStatus(selectedFile.path, hi, "accepted")}
                                  title="Accept this hunk"
                                >
                                  <Check size={12} /> Accept
                                </button>
                                <button
                                  className="hunk-btn hunk-btn-reject"
                                  onClick={() => setHunkStatus(selectedFile.path, hi, "rejected")}
                                  title="Reject this hunk"
                                >
                                  <X size={12} /> Reject
                                </button>
                              </>
                            ) : (
                              <button
                                className="hunk-btn hunk-btn-undecide"
                                onClick={() => setHunkStatus(selectedFile.path, hi, "pending")}
                                title="Reset to pending"
                              >
                                Reset
                              </button>
                            )}
                          </div>
                        </div>
                        <div className="multi-diff-hunk-lines">
                          {hunk.lines.map((line) => (
                            <div
                              key={line.id}
                              className={`diff-hunk-line ${line.kind === "add" ? "line-added" : ""} ${line.kind === "remove" ? "line-removed" : ""} ${st === "rejected" ? "line-dimmed" : ""}`}
                            >
                              <span className="hunk-line-num">{line.kind === "remove" || line.kind === "context" ? (line.original ? (selectedFile.hunks[hi]?.oldStart || 0) + hunk.lines.indexOf(line) : "") : ""}</span>
                              <span className="hunk-line-num">{line.kind === "add" || line.kind === "context" ? (line.proposed ? (selectedFile.hunks[hi]?.newStart || 0) + hunk.lines.indexOf(line) : "") : ""}</span>
                              <span className="hunk-line-prefix">{line.kind === "add" ? "+" : line.kind === "remove" ? "-" : " "}</span>
                              <span className="hunk-line-content">{line.proposed || line.original}</span>
                            </div>
                          ))}
                        </div>
                      </div>
                    );
                  })}
                </div>

                {/* File-level action: apply the accepted hunks */}
                <div className="multi-diff-file-footer">
                  <button
                    className="btn-primary"
                    onClick={() => {
                      const fd = selectedFile;
                      if (fd.isDelete) {
                        const status = (hunkStatuses[fd.path] || fd.hunkStatus)[0];
                        if (status === "accepted") onApplyFile(fd.path);
                      } else {
                        onApplyFile(fd.path);
                      }
                    }}
                    disabled={
                      (hunkStatuses[selectedFile.path] || selectedFile.hunkStatus).every(s => s === "rejected")
                    }
                  >
                    Apply Accepted Hunks in This File
                  </button>
                </div>
              </>
            ) : (
              <div className="multi-diff-empty">No changes to review.</div>
            )}
          </section>
        </div>

        {/* Footer */}
        <div className="multi-diff-footer">
          <div className="multi-diff-footer-stats">
            <span className="footer-stat-accepted">{totalAccepted} accepted</span>
            <span className="footer-stat-rejected">{totalRejected} rejected</span>
            <span className="footer-stat-pending">{totalHunks - totalAccepted - totalRejected} pending</span>
          </div>
          <div className="multi-diff-footer-actions">
            <button className="btn-secondary" onClick={rejectAll}>
              Reject All
            </button>
            <button className="btn-secondary" onClick={acceptAll}>
              Accept All
            </button>
            <button className="btn-secondary" onClick={onCancel}>
              Cancel
            </button>
            <button
              className="btn-primary"
              onClick={allDecided ? onApplyAll : handleApplySelected}
              disabled={totalAccepted === 0}
            >
              <Check size={16} />
              {allDecided ? "Apply All" : "Apply Selected"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
