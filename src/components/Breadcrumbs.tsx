/**
 * Breadcrumbs — Shows file path + current symbol at cursor position.
 * Updates on cursor move. Clickable segments for navigation.
 */

import { useState, useEffect, useCallback } from "react";
import { ChevronRight, FileCode } from "lucide-react";

interface Props {
  filePath: string;
  projectPath: string;
  /** Current cursor line (1-indexed) */
  cursorLine?: number;
  /** Symbol info at cursor — set externally from Monaco outline or symbol index */
  currentSymbol?: string;
  onNavigateToPath?: (segment: string) => void;
}

export default function Breadcrumbs({
  filePath,
  projectPath,
  cursorLine,
  currentSymbol,
  onNavigateToPath,
}: Props) {
  const [segments, setSegments] = useState<string[]>([]);

  useEffect(() => {
    if (!filePath || !projectPath) {
      setSegments([]);
      return;
    }

    // Compute relative path from project root
    const normalizedFile = filePath.replace(/\\/g, "/");
    const normalizedProject = projectPath.replace(/\\/g, "/").replace(/\/$/, "");
    const relative = normalizedFile.startsWith(normalizedProject)
      ? normalizedFile.slice(normalizedProject.length).replace(/^\//, "")
      : normalizedFile;

    setSegments(relative.split("/").filter(Boolean));
  }, [filePath, projectPath]);

  const handleSegmentClick = useCallback(
    (index: number) => {
      if (onNavigateToPath) {
        const partialPath = segments.slice(0, index + 1).join("/");
        onNavigateToPath(partialPath);
      }
    },
    [segments, onNavigateToPath]
  );

  if (segments.length === 0) return null;

  return (
    <div className="breadcrumbs" role="navigation" aria-label="File path breadcrumbs">
      <FileCode size={13} className="breadcrumb-icon" />
      {segments.map((segment, index) => (
        <span key={`${segment}-${index}`} className="breadcrumb-segment">
          {index > 0 && <ChevronRight size={11} className="breadcrumb-sep" />}
          <button
            type="button"
            className={`breadcrumb-btn ${index === segments.length - 1 ? "active" : ""}`}
            onClick={() => handleSegmentClick(index)}
            title={segments.slice(0, index + 1).join("/")}
          >
            {segment}
          </button>
        </span>
      ))}
      {currentSymbol && (
        <span className="breadcrumb-segment">
          <ChevronRight size={11} className="breadcrumb-sep" />
          <span className="breadcrumb-symbol" title={`Line ${cursorLine || "?"}`}>
            {currentSymbol}
          </span>
        </span>
      )}
    </div>
  );
}
