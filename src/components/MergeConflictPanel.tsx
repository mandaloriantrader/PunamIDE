/**
 * MergeConflictPanel — Inline conflict resolution UI.
 * Parses conflict markers and shows a split view with
 * Accept Current / Accept Incoming / Accept Both per conflict region.
 */

import { useState, useMemo, useCallback } from "react";
import { GitMerge, Check, X, ArrowLeft, ArrowRight, Layers, CheckCheck } from "lucide-react";
import {
  parseConflictMarkers,
  resolveConflicts,
  hasConflictMarkers,
  type ConflictRegion,
  type ConflictResolution,
  type ResolutionStrategy,
} from "../utils/conflictParser";

interface Props {
  /** File path (for display) */
  filePath: string;
  /** Raw file content with conflict markers */
  content: string;
  /** Called when all conflicts are resolved with the clean content */
  onResolve: (resolvedContent: string) => void;
  /** Called when user dismisses without resolving */
  onDismiss: () => void;
}

export default function MergeConflictPanel({ filePath, content, onResolve, onDismiss }: Props) {
  const parsed = useMemo(() => parseConflictMarkers(content), [content]);
  const [resolutions, setResolutions] = useState<Map<number, ResolutionStrategy>>(new Map());

  const resolvedCount = resolutions.size;
  const totalConflicts = parsed.conflictCount;
  const allResolved = resolvedCount === totalConflicts;

  const handleResolve = useCallback((regionId: number, strategy: ResolutionStrategy) => {
    setResolutions((prev) => {
      const next = new Map(prev);
      next.set(regionId, strategy);
      return next;
    });
  }, []);

  const handleAcceptAll = useCallback((strategy: ResolutionStrategy) => {
    const all = new Map<number, ResolutionStrategy>();
    for (const region of parsed.regions) {
      all.set(region.id, strategy);
    }
    setResolutions(all);
  }, [parsed.regions]);

  const handleApply = useCallback(() => {
    const resolutionList: ConflictResolution[] = Array.from(resolutions.entries()).map(
      ([regionId, strategy]) => ({ regionId, strategy })
    );
    const resolved = resolveConflicts(content, resolutionList);
    onResolve(resolved);
  }, [content, resolutions, onResolve]);

  if (!hasConflictMarkers(content)) {
    return null;
  }

  const fileName = filePath.split(/[\\/]/).pop() || filePath;

  return (
    <div className="merge-conflict-panel" role="region" aria-label="Merge conflict resolution">
      {/* Header */}
      <div className="merge-conflict-header">
        <div className="merge-conflict-title">
          <GitMerge size={15} />
          <span>{fileName}</span>
          <span className="merge-conflict-count">
            {resolvedCount}/{totalConflicts} resolved
          </span>
        </div>
        <div className="merge-conflict-header-actions">
          <button
            className="merge-conflict-btn merge-accept-all-ours"
            onClick={() => handleAcceptAll("ours")}
            title="Accept all current (ours)"
          >
            <ArrowLeft size={11} /> All Current
          </button>
          <button
            className="merge-conflict-btn merge-accept-all-theirs"
            onClick={() => handleAcceptAll("theirs")}
            title="Accept all incoming (theirs)"
          >
            All Incoming <ArrowRight size={11} />
          </button>
          <button
            className="merge-conflict-btn merge-apply-btn"
            onClick={handleApply}
            disabled={!allResolved}
            title={allResolved ? "Apply resolutions" : `${totalConflicts - resolvedCount} conflict(s) still unresolved`}
          >
            <CheckCheck size={12} />
            Apply
          </button>
          <button
            className="merge-conflict-btn merge-dismiss-btn"
            onClick={onDismiss}
            title="Close without resolving"
          >
            <X size={12} />
          </button>
        </div>
      </div>

      {/* Conflict regions */}
      <div className="merge-conflict-body">
        {parsed.regions.map((region) => (
          <ConflictBlock
            key={region.id}
            region={region}
            resolution={resolutions.get(region.id)}
            onResolve={handleResolve}
          />
        ))}
      </div>
    </div>
  );
}

// ── Individual conflict block ────────────────────────────────────────────────

interface ConflictBlockProps {
  region: ConflictRegion;
  resolution?: ResolutionStrategy;
  onResolve: (regionId: number, strategy: ResolutionStrategy) => void;
}

function ConflictBlock({ region, resolution, onResolve }: ConflictBlockProps) {
  const isResolved = resolution !== undefined;

  return (
    <div className={`merge-conflict-block ${isResolved ? "resolved" : ""}`}>
      {/* Action buttons */}
      <div className="merge-conflict-actions">
        <button
          className={`merge-action-btn ${resolution === "ours" ? "active" : ""}`}
          onClick={() => onResolve(region.id, "ours")}
          title="Accept Current"
        >
          <Check size={11} /> Current
        </button>
        <button
          className={`merge-action-btn ${resolution === "theirs" ? "active" : ""}`}
          onClick={() => onResolve(region.id, "theirs")}
          title="Accept Incoming"
        >
          <Check size={11} /> Incoming
        </button>
        <button
          className={`merge-action-btn ${resolution === "both" ? "active" : ""}`}
          onClick={() => onResolve(region.id, "both")}
          title="Accept Both"
        >
          <Layers size={11} /> Both
        </button>
        {isResolved && (
          <span className="merge-resolved-badge">
            <Check size={10} /> {resolution}
          </span>
        )}
      </div>

      {/* Split view: ours vs theirs */}
      <div className="merge-conflict-split">
        <div className="merge-side merge-side-ours">
          <div className="merge-side-header">
            <span className="merge-side-label">{region.oursLabel}</span>
            <span className="merge-side-tag">Current</span>
          </div>
          <pre className="merge-side-code">
            {region.oursLines.length > 0
              ? region.oursLines.join("\n")
              : <span className="merge-empty">(empty)</span>}
          </pre>
        </div>
        <div className="merge-side merge-side-theirs">
          <div className="merge-side-header">
            <span className="merge-side-label">{region.theirsLabel}</span>
            <span className="merge-side-tag">Incoming</span>
          </div>
          <pre className="merge-side-code">
            {region.theirsLines.length > 0
              ? region.theirsLines.join("\n")
              : <span className="merge-empty">(empty)</span>}
          </pre>
        </div>
      </div>
    </div>
  );
}
