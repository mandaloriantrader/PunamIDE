/**
 * EditPreviewPanel.tsx — Per-hunk accept/reject diff preview for AI-generated edits.
 *
 * Shows each SEARCH→REPLACE pair as a reviewable hunk. Users can toggle individual
 * hunks on/off, then apply only the accepted ones via apply_multi_patch.
 *
 * Integrates with useEditPreview hook for state management.
 */
import { Check, X, CheckCheck, XCircle, Play, FileCode } from "lucide-react";
import type { EditPreviewItem } from "../hooks/useEditPreview";

interface EditPreviewPanelProps {
  items: EditPreviewItem[];
  allAccepted: boolean;
  onToggleItem: (index: number) => void;
  onAcceptAll: () => void;
  onRejectAll: () => void;
  onApply: () => void;
  onDismiss: () => void;
}

export default function EditPreviewPanel({
  items,
  allAccepted,
  onToggleItem,
  onAcceptAll,
  onRejectAll,
  onApply,
  onDismiss,
}: EditPreviewPanelProps) {
  if (items.length === 0) return null;

  const acceptedCount = items.filter((i) => i.accepted).length;
  const groupedByFile = groupByFile(items);

  return (
    <div className="edit-preview-panel" role="region" aria-label="Edit Preview">
      {/* Header */}
      <div className="edit-preview-header">
        <div className="edit-preview-title">
          <FileCode size={14} />
          <span>
            Review Changes — {acceptedCount}/{items.length} accepted
          </span>
        </div>
        <div className="edit-preview-actions">
          <button
            className="edit-preview-btn edit-preview-btn-accept"
            onClick={onAcceptAll}
            title="Accept All"
            aria-label="Accept all changes"
          >
            <CheckCheck size={13} />
            <span>All</span>
          </button>
          <button
            className="edit-preview-btn edit-preview-btn-reject"
            onClick={onRejectAll}
            title="Reject All"
            aria-label="Reject all changes"
          >
            <XCircle size={13} />
            <span>None</span>
          </button>
          <button
            className="edit-preview-btn edit-preview-btn-apply"
            onClick={onApply}
            disabled={acceptedCount === 0}
            title={acceptedCount === 0 ? "No changes accepted" : `Apply ${acceptedCount} change(s)`}
            aria-label={`Apply ${acceptedCount} accepted changes`}
          >
            <Play size={13} />
            <span>Apply{!allAccepted && acceptedCount > 0 ? ` (${acceptedCount})` : ""}</span>
          </button>
          <button
            className="edit-preview-btn edit-preview-btn-dismiss"
            onClick={onDismiss}
            title="Dismiss without applying"
            aria-label="Dismiss changes"
          >
            <X size={13} />
          </button>
        </div>
      </div>

      {/* Hunks grouped by file */}
      <div className="edit-preview-body">
        {groupedByFile.map(({ filePath, hunks }) => (
          <div key={filePath} className="edit-preview-file-group">
            <div className="edit-preview-file-header">
              <FileCode size={12} />
              <span className="edit-preview-file-path">{filePath}</span>
              <span className="edit-preview-file-count">
                {hunks.filter((h) => h.item.accepted).length}/{hunks.length}
              </span>
            </div>
            {hunks.map(({ item, globalIndex }) => (
              <div
                key={globalIndex}
                className={`edit-preview-hunk ${item.accepted ? "accepted" : "rejected"}`}
              >
                <button
                  className="edit-preview-hunk-toggle"
                  onClick={() => onToggleItem(globalIndex)}
                  title={item.accepted ? "Click to reject this change" : "Click to accept this change"}
                  aria-label={`${item.accepted ? "Reject" : "Accept"} change ${globalIndex + 1}`}
                  aria-pressed={item.accepted}
                >
                  {item.accepted ? <Check size={12} /> : <X size={12} />}
                </button>
                <div className="edit-preview-hunk-diff">
                  <div className="edit-preview-hunk-remove">
                    {item.searchText.split("\n").map((line, i) => (
                      <div key={i} className="diff-line diff-remove">
                        <span className="diff-marker">-</span>
                        <span className="diff-content">{line || " "}</span>
                      </div>
                    ))}
                  </div>
                  <div className="edit-preview-hunk-add">
                    {item.replaceText.split("\n").map((line, i) => (
                      <div key={i} className="diff-line diff-add">
                        <span className="diff-marker">+</span>
                        <span className="diff-content">{line || " "}</span>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function groupByFile(items: EditPreviewItem[]) {
  const map = new Map<string, Array<{ item: EditPreviewItem; globalIndex: number }>>();
  items.forEach((item, index) => {
    const existing = map.get(item.filePath) || [];
    existing.push({ item, globalIndex: index });
    map.set(item.filePath, existing);
  });
  return Array.from(map.entries()).map(([filePath, hunks]) => ({ filePath, hunks }));
}
