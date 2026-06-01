/**
 * ToolCallCard — visual card for a tool invocation.
 *
 * Shows the tool name with an icon, optional collapsible params,
 * and a status indicator (loading spinner, success checkmark, or error ❌).
 */

import { useState } from "react";
import { Check, ChevronDown, ChevronRight, Loader2, X } from "lucide-react";

interface Props {
  name: string;
  params?: string;
  isComplete: boolean;
  isError?: boolean;
}

const TOOL_ICONS: Record<string, string> = {
  read_file: "📖",
  write_file: "✏️",
  execute_command: "▶️",
  search_code: "🔍",
  default: "🔧",
};

const TOOL_ACTION_LABELS: Record<string, string> = {
  read_file: "Reading file",
  write_file: "Writing file",
  execute_command: "Running command",
  search_code: "Searching codebase",
  default: "Running tool",
};

function parseParamsLabel(params: string): string {
  try {
    const parsed = JSON.parse(params);
    if (parsed.path) return parsed.path;
    if (parsed.command) return parsed.command.slice(0, 50);
    return JSON.stringify(parsed).slice(0, 50);
  } catch {
    return params.replace(/\n/g, " ").slice(0, 50);
  }
}

export default function ToolCallCard({ name, params, isComplete, isError }: Props) {
  const [paramsOpen, setParamsOpen] = useState(false);
  const icon = TOOL_ICONS[name] || TOOL_ICONS.default;
  const label = TOOL_ACTION_LABELS[name] || TOOL_ACTION_LABELS.default;
  const paramsLabel = params ? parseParamsLabel(params) : "";

  return (
    <div
      className={`cl-tool-call ${isComplete ? "complete" : "loading"} ${isError ? "error" : ""}`}
    >
      <div className="cl-tool-call-header">
        <span className="cl-tool-call-icon">{icon}</span>
        <span className="cl-tool-call-label">{label}</span>
        {paramsLabel && (
          <span className="cl-tool-call-target">{paramsLabel}</span>
        )}
        <span className="cl-tool-call-status">
          {isError ? (
            <X size={12} className="cl-tool-error-icon" />
          ) : isComplete ? (
            <Check size={12} className="cl-tool-check" />
          ) : (
            <Loader2 size={12} className="spin" />
          )}
        </span>
        {params && (
          <button
            className="cl-tool-call-toggle"
            onClick={(e) => { e.stopPropagation(); setParamsOpen(!paramsOpen); }}
            type="button"
          >
            {paramsOpen ? <ChevronDown size={10} /> : <ChevronRight size={10} />}
          </button>
        )}
      </div>
      {paramsOpen && params && (
        <div className="cl-tool-call-params">
          <pre><code>{params}</code></pre>
        </div>
      )}
    </div>
  );
}