import { AlertCircle, AlertTriangle, CheckCircle2, Info, X } from "lucide-react";
import type { Problem } from "../utils/problems";

interface Props {
  problems: Problem[];
  active: boolean;
  onSelect: (problem: Problem) => void;
  onClose: () => void;
}

function getProblemIcon(severity: Problem["severity"]) {
  if (severity === "warning") return <AlertTriangle size={14} />;
  if (severity === "info") return <Info size={14} />;
  return <AlertCircle size={14} />;
}

export default function ProblemsPanel({ problems, active, onSelect, onClose }: Props) {
  return (
    <div className={`problems-panel ${active ? "active" : ""}`} role="region" aria-label="Problems">
      <div className="problems-list">
        {problems.length === 0 ? (
          <div className="problems-empty">
            <CheckCircle2 size={18} />
            <span>No problems found from the latest run.</span>
          </div>
        ) : (
          problems.map((problem) => (
            <button
              key={problem.id}
              className={`problem-row ${problem.severity}`}
              onClick={() => onSelect(problem)}
              type="button"
              title={`${problem.path}:${problem.line}${problem.column ? `:${problem.column}` : ""}`}
            >
              <span className="problem-icon">{getProblemIcon(problem.severity)}</span>
              <span className="problem-message">{problem.message}</span>
              <span className="problem-location">
                {problem.path}:{problem.line}
                {problem.column ? `:${problem.column}` : ""}
              </span>
            </button>
          ))
        )}
      </div>
      <button className="problems-close" onClick={onClose} type="button" aria-label="Close bottom panel">
        <X size={14} />
      </button>
    </div>
  );
}
