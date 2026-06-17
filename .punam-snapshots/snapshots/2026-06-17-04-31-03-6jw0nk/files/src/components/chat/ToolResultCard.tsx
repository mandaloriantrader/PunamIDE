/**
 * ToolResultCard — displays the result of a tool call.
 *
 * Visually connected to its ToolCallCard via a left-border bridge.
 * Shows the result content in a collapsible code block.
 */

import { useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";

interface Props {
  content: string;
}

export default function ToolResultCard({ content }: Props) {
  const [expanded, setExpanded] = useState(false);
  const lines = content.split("\n");
  const isLong = lines.length > 8;
  const previewLines = isLong ? lines.slice(0, 6) : lines;
  const preview = previewLines.join("\n");

  return (
    <div className="cl-tool-result">
      <div className="cl-tool-result-header">
        <span className="cl-tool-result-label">
          Result{isLong ? ` (${lines.length} lines)` : ""}
        </span>
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