/**
 * ThinkingBlock — collapsible "Thinking..." section.
 *
 * During streaming: auto-expanded, shows animated spinner + streaming content.
 * When complete: collapsed by default with a summary chevron.
 */

import React, { useState, useEffect } from "react";
import { ChevronDown, ChevronRight, Loader2 } from "lucide-react";

interface Props {
  content: string;
  isStreaming?: boolean;
}

const ThinkingBlock = React.memo(function ThinkingBlock({ content, isStreaming = true }: Props) {
  const [open, setOpen] = useState(true);

  // Auto-collapse when streaming finishes
  useEffect(() => {
    if (!isStreaming) {
      const timer = setTimeout(() => setOpen(false), 1500);
      return () => clearTimeout(timer);
    }
  }, [isStreaming]);

  // Always open during streaming
  useEffect(() => {
    if (isStreaming) setOpen(true);
  }, [isStreaming]);

  const summary = content.slice(0, 60).replace(/\n/g, " ") + (content.length > 60 ? "…" : "");

  return (
    <div className={`cl-thinking ${isStreaming ? "streaming" : "complete"}`}>
      <button
        className="cl-thinking-toggle"
        onClick={() => setOpen(!open)}
        type="button"
        aria-label={open ? "Collapse thinking" : "Expand thinking"}
      >
        {isStreaming ? (
          <Loader2 size={12} className="spin cl-thinking-spinner" />
        ) : open ? (
          <ChevronDown size={12} />
        ) : (
          <ChevronRight size={12} />
        )}
        <span className="cl-thinking-label">Thinking</span>
        {!open && !isStreaming && (
          <span className="cl-thinking-summary">{summary}</span>
        )}
      </button>
      {(open || isStreaming) && (
        <div className="cl-thinking-body">
          <p>{content}{isStreaming && <span className="cl-cursor">▍</span>}</p>
        </div>
      )}
    </div>
  );
});

export default ThinkingBlock;