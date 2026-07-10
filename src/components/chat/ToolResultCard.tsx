/**
 * ToolResultCard — displays the result of a tool call.
 *
 * Visually connected to its ToolCallCard via a left-border bridge.
 * Shows the result content in a collapsible code block.
 * Displays ✅ or ⚠️ badge for verified/failed tool results.
 */

import { useState } from "react";
import { ChevronDown, ChevronRight, CheckCircle2, AlertTriangle, ShieldAlert } from "lucide-react";

interface Props {
  content: string;
  /** Verification status: "verified" = ✅, "failed" = ⚠️, undefined = no badge */
  verificationStatus?: "verified" | "failed";
}

/** Detect if the result was blocked by an architecture or security guardrail. */
function isGuardBlocked(content: string): boolean {
  return /^BLOCKED by (?:guardrail|architecture guardrail)/.test(content);
}

export default function ToolResultCard({ content, verificationStatus }: Props) {
  const [expanded, setExpanded] = useState(false);
  const lines = content.split("\n");
  const isLong = lines.length > 8;
  const previewLines = isLong ? lines.slice(0, 6) : lines;
  const preview = previewLines.join("\n");

  // Derive verification status from content markers if not explicitly provided
  const derivedStatus = verificationStatus
    ?? (content.includes("✅ Edit verified") ? "verified"
      : content.includes("⚠️ Edit verification FAILED") || content.includes("❌ Edit verification FAILED")
        ? "failed"
        : undefined);

  const blocked = isGuardBlocked(content);

  return (
    <div className={`cl-tool-result${blocked ? " cl-tool-result--blocked" : ""}`}>
      <div className="cl-tool-result-header">
        <span className="cl-tool-result-label">
          {blocked && <ShieldAlert size={12} className="cl-tool-result-icon--blocked" />}
          Result{isLong ? ` (${lines.length} lines)` : ""}
        </span>
        {blocked && (
          <span className="cl-tool-result-badge cl-tool-result-badge--blocked" title="Guardrail blocked this edit">
            <ShieldAlert size={12} /> Blocked
          </span>
        )}
        {derivedStatus === "verified" && (
          <span className="cl-tool-result-badge cl-tool-result-badge--verified" title="Edit verified successfully">
            <CheckCircle2 size={12} /> Verified
          </span>
        )}
        {derivedStatus === "failed" && (
          <span className="cl-tool-result-badge cl-tool-result-badge--failed" title="Edit verification failed">
            <AlertTriangle size={12} /> Mismatch
          </span>
        )}
        {isLong && (
          <button
            className="cl-tool-result-toggle"
            onClick={() => setExpanded(!expanded)}
            type="button"
          >
            {expanded ? (
              <><ChevronDown size={10} /> Collapse</>
            ) : (
              <><ChevronRight size={10} /> Show all</>
            )}
          </button>
        )}
      </div>
      <div className="cl-tool-result-body">
        <pre><code>{expanded ? content : preview}</code></pre>
        {isLong && !expanded && (
          <div className="cl-tool-result-more">
            … {lines.length - 6} more lines
          </div>
        )}
      </div>
    </div>
  );
}