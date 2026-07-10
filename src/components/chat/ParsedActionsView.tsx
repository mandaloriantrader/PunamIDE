// src/components/chat/ParsedActionsView.tsx
//
// Renders file changes, edit operations, deletions, and commands from a ParsedResponse.

import { Check, Loader2 } from "lucide-react";
import type { ParsedResponse } from "../../utils/prompts";
import { getActionLabel } from "./ChatComponents";
import { hasParsedActions } from "./types";

interface ParsedActionsViewProps {
  parsed: ParsedResponse;
  applied?: boolean;
  autoApplying?: boolean;
  onApply: () => void;
  onReject?: () => void;
}

export function ParsedActionsView({
  parsed,
  applied,
  autoApplying,
  onApply,
  onReject,
}: ParsedActionsViewProps) {
  if (!hasParsedActions(parsed)) return null;

  return (
    <div className="chat-changes">
      {parsed.fileChanges.map((fc, j) => (
        <details key={`file-${j}`} className="chat-file-preview">
          <summary>
            <span className={`change-item file-change ${fc.isNew ? "new" : "edit"}`}>
              {fc.isNew ? "+ NEW" : "~ EDIT"}
            </span>
            <span className="chat-file-preview-path">{fc.path}</span>
            <span className="chat-file-preview-label">View code</span>
          </summary>
          <pre className="chat-file-code-scroll"><code>{fc.content}</code></pre>
        </details>
      ))}
      {parsed.editOperations.map((edit, j) => (
        <details key={`edit-${j}`} className="chat-file-preview">
          <summary>
            <span className="change-item file-change edit">~ PATCH</span>
            <span className="chat-file-preview-path">{edit.path}</span>
            <span className="chat-file-preview-label">View patch</span>
          </summary>
          <pre className="chat-file-code-scroll"><code>{edit.searchReplace.map((pair, idx) => (
            `# Change ${idx + 1}\n<<<SEARCH\n${pair.search}\n>>>REPLACE\n${pair.replace}`
          )).join("\n\n")}</code></pre>
        </details>
      ))}
      {parsed.deletions.map((d, j) => (
        <div key={`delete-${j}`} className="change-item deletion">x DEL: {d}</div>
      ))}
      {parsed.commands.map((c, j) => (
        <div key={`cmd-${j}`} className="change-item command">$ {c}</div>
      ))}
      {!applied ? (
        autoApplying ? (
          <div className="applied-badge auto-applying"><Loader2 size={14} className="spin-inline" /> Auto-applying...</div>
        ) : (
          <div className="apply-actions">
            <button className="apply-btn" onClick={onApply}>
              <Check size={14} /> {getActionLabel(parsed)}
            </button>
            {onReject && <button className="apply-btn reject" onClick={onReject}>Reject</button>}
          </div>
        )
      ) : (
        <div className="applied-badge"><Check size={14} /> Applied</div>
      )}
    </div>
  );
}
