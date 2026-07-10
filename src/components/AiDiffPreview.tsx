import { useCallback, useEffect, useMemo, useState } from "react";
import { Check, X } from "lucide-react";
import { getDiffLines } from "../utils/diffLines";
import type { DiffLineEntry } from "../utils/diffLines";

export interface ReviewFileChange {
  path: string;
  original: string;
  proposed: string;
  isNew: boolean;
  hasUnsavedChanges?: boolean;
}

export interface ReviewDeletion {
  path: string;
  original: string;
}

export interface ReviewChanges {
  fileChanges: ReviewFileChange[];
  deletions: ReviewDeletion[];
  commands: string[];
}

/** A detected hunk (group of consecutive changed lines) within the diff. */
export interface DetectedHunk {
  id: number;
  startIdx: number; // index in diffLines array
  endIdx: number;   // inclusive
  lineCount: number;
}

interface Props {
  changes: ReviewChanges;
  onApplyAll: () => void;
  onApplyFile: (path: string) => void;
  onRejectFile: (path: string) => void;
  onCancel: () => void;
  /** When true, shows per-hunk checkboxes for individual hunk selection. */
  selectable?: boolean;
  /** Callback fired whenever the set of selected hunk IDs changes. */
  onHunkSelectionChange?: (selectedIds: number[]) => void;
}

type ReviewItem =
  | { type: "file"; path: string; original: string; proposed: string; isNew: boolean; hasUnsavedChanges?: boolean }
  | { type: "delete"; path: string; original: string; proposed: string; isNew: false };

/**
 * Detect hunks from diff lines — a hunk is a contiguous group of changed lines.
 */
function detectHunks(lines: DiffLineEntry[]): DetectedHunk[] {
  const hunks: DetectedHunk[] = [];
  let hunkId = 0;
  let i = 0;

  while (i < lines.length) {
    if (lines[i].changed) {
      const startIdx = i;
      while (i < lines.length && lines[i].changed) {
        i++;
      }
      hunks.push({
        id: hunkId++,
        startIdx,
        endIdx: i - 1,
        lineCount: i - startIdx,
      });
    } else {
      i++;
    }
  }

  return hunks;
}

export default function AiDiffPreview({
  changes,
  onApplyAll,
  onApplyFile,
  onRejectFile,
  onCancel,
  selectable = false,
  onHunkSelectionChange,
}: Props) {
  const reviewItems = useMemo<ReviewItem[]>(
    () => [
      ...changes.fileChanges.map((change) => ({ type: "file" as const, ...change })),
      ...changes.deletions.map((deletion) => ({
        type: "delete" as const,
        path: deletion.path,
        original: deletion.original,
        proposed: "",
        isNew: false as const,
      })),
    ],
    [changes]
  );

  const [selectedPath, setSelectedPath] = useState(reviewItems[0]?.path || "");
  const selectedItem = reviewItems.find((item) => item.path === selectedPath) || reviewItems[0];
  const diffLines = selectedItem
    ? getDiffLines(selectedItem.original, selectedItem.proposed)
    : [];

  // Detect hunks from the current diff lines
  const hunks = useMemo(() => detectHunks(diffLines), [diffLines]);

  // State tracking which hunk IDs are selected (all selected by default)
  const [selectedHunkIds, setSelectedHunkIds] = useState<Set<number>>(new Set());

  // Re-initialize selected hunks whenever hunks change (new file selected)
  useEffect(() => {
    const allIds = new Set(hunks.map((h) => h.id));
    setSelectedHunkIds(allIds);
  }, [hunks]);

  // Notify parent when selection changes
  useEffect(() => {
    if (selectable && onHunkSelectionChange) {
      onHunkSelectionChange(Array.from(selectedHunkIds));
    }
  }, [selectedHunkIds, selectable, onHunkSelectionChange]);

  const toggleHunk = useCallback((hunkId: number) => {
    setSelectedHunkIds((prev) => {
      const next = new Set(prev);
      if (next.has(hunkId)) {
        next.delete(hunkId);
      } else {
        next.add(hunkId);
      }
      return next;
    });
  }, []);

  const selectAllHunks = useCallback(() => {
    setSelectedHunkIds(new Set(hunks.map((h) => h.id)));
  }, [hunks]);

  const deselectAllHunks = useCallback(() => {
    setSelectedHunkIds(new Set());
  }, []);

  // Build a map from line index → hunk for rendering
  const lineToHunkMap = useMemo(() => {
    const map = new Map<number, DetectedHunk>();
    for (const hunk of hunks) {
      for (let i = hunk.startIdx; i <= hunk.endIdx; i++) {
        map.set(i, hunk);
      }
    }
    return map;
  }, [hunks]);

  return (
    <div className="diff-preview-overlay" role="dialog" aria-label="Review AI changes">
      <div className="diff-preview">
        <div className="diff-preview-header">
          <div>
            <h2>Review AI Changes</h2>
            <p>Inspect proposed edits before Punam writes to your project.</p>
          </div>
          <button className="icon-btn" type="button" onClick={onCancel} aria-label="Close review">
            <X size={16} />
          </button>
        </div>

        <div className="diff-preview-body">
          <aside className="diff-preview-sidebar">
            {reviewItems.map((item) => (
              <button
                key={`${item.type}-${item.path}`}
                type="button"
                className={`diff-file-item ${item.path === selectedItem?.path ? "selected" : ""}`}
                onClick={() => setSelectedPath(item.path)}
              >
                <span>{item.type === "delete" ? "- DELETE" : item.isNew ? "+ NEW" : "~ EDIT"}</span>
                <strong>{item.path}</strong>
                {item.type === "file" && item.hasUnsavedChanges && (
                  <em>Unsaved editor changes</em>
                )}
              </button>
            ))}
            {changes.commands.length > 0 && (
              <div className="diff-command-list">
                <span>Commands</span>
                {changes.commands.map((command, index) => (
                  <code key={`${command}-${index}`}>{command}</code>
                ))}
              </div>
            )}
          </aside>

          <section className="diff-preview-main">
            {selectedItem ? (
              <>
                <div className="diff-selected-header">
                  <span>
                    {selectedItem.path}
                    {selectedItem.type === "file" && selectedItem.hasUnsavedChanges && (
                      <strong className="diff-unsaved-warning">Unsaved changes in editor</strong>
                    )}
                  </span>
                  <div className="diff-selected-actions">
                    {selectable && hunks.length > 0 && (
                      <div className="diff-hunk-bulk-actions">
                        <button
                          type="button"
                          className="btn-secondary compact"
                          onClick={selectAllHunks}
                          title="Select all hunks"
                        >
                          Select All
                        </button>
                        <button
                          type="button"
                          className="btn-secondary compact"
                          onClick={deselectAllHunks}
                          title="Deselect all hunks"
                        >
                          Deselect All
                        </button>
                      </div>
                    )}
                    <button type="button" className="btn-secondary compact" onClick={() => onRejectFile(selectedItem.path)}>
                      Reject File
                    </button>
                    <button type="button" className="btn-primary compact" onClick={() => onApplyFile(selectedItem.path)}>
                      Apply File
                    </button>
                  </div>
                </div>
                <div className="diff-grid" aria-label="File diff">
                  <div className="diff-column-title">Current</div>
                  <div className="diff-column-title">Proposed
                    <button type="button" className="diff-copy-btn" onClick={() => {
                      const proposed = diffLines.map((l) => l.proposed || "").join("\n");
                      navigator.clipboard.writeText(proposed);
                    }} title="Copy proposed code">
                      📋
                    </button>
                  </div>
                  {diffLines.map((line, idx) => {
                    const hunk = lineToHunkMap.get(idx);
                    const isHunkStart = hunk && hunk.startIdx === idx;
                    const isDeselected = selectable && hunk && !selectedHunkIds.has(hunk.id);

                    return (
                      <div className="diff-line-pair" key={line.id}>
                        {/* Hunk header row with toggle — rendered before the first line of each hunk */}
                        {selectable && isHunkStart && hunk && (
                          <div className="diff-hunk-toggle-row">
                            <label className="diff-hunk-toggle" aria-label={`Toggle hunk ${hunk.id + 1}`}>
                              <input
                                type="checkbox"
                                checked={selectedHunkIds.has(hunk.id)}
                                onChange={() => toggleHunk(hunk.id)}
                              />
                              <span className="diff-hunk-toggle-label">
                                Hunk {hunk.id + 1} ({hunk.lineCount} line{hunk.lineCount > 1 ? "s" : ""})
                              </span>
                            </label>
                          </div>
                        )}
                        <pre className={`${line.changed ? "changed removed" : ""}${isDeselected ? " hunk-deselected" : ""}`}>
                          <span className="diff-line-num">{idx + 1}</span>{line.original || " "}
                        </pre>
                        <pre className={`${line.changed ? "changed added" : ""}${isDeselected ? " hunk-deselected" : ""}`}>
                          <span className="diff-line-num">{idx + 1}</span>{line.proposed || " "}
                        </pre>
                      </div>
                    );
                  })}
                </div>
              </>
            ) : (
              <div className="diff-empty">Only terminal commands were suggested.</div>
            )}
          </section>
        </div>

        <div className="diff-preview-footer">
          <button type="button" className="btn-secondary" onClick={onCancel}>
            Cancel
          </button>
          <button type="button" className="btn-primary" onClick={onApplyAll}>
            <Check size={16} />
            Apply All
          </button>
        </div>
      </div>
    </div>
  );
}
