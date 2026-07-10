/**
 * RefactorPanel — One-click refactoring panel providing Rename, Extract Function,
 * and Move File operations with preview, confirm, and rollback controls.
 *
 * Renders a tabbed interface bound to `RefactorService`. Shows inline diff previews
 * with affected file counts before apply. Offers single-action rollback after apply.
 *
 * Requirements: 12.1, 12.4, 12.5, 12.7, 12.8, 12.9
 */

import { useState, useCallback, useMemo, useEffect, useRef } from "react";
import {
  Loader2,
  PenLine,
  FunctionSquare,
  FolderInput,
  Eye,
  Check,
  X,
  Undo2,
  AlertCircle,
  ChevronDown,
  ChevronRight,
  FileCode,
} from "lucide-react";
import { useEditorStore } from "../store/editorStore";
import { showToast } from "../utils/toast";
import { buildConflictMarkedContent } from "../utils/conflictParser";
import {
  RefactorService,
  RefactorError,
  type RefactorChangeSet,
  type RefactorPreview,
  type ValidationResult,
  type RenameParams,
  type ExtractParams,
  type MoveParams,
  type MergeConflict,
} from "../services/refactor/RefactorService";
import type { DiffHunk, DiffLine } from "../services/agent/differ";

// ─── Types ─────────────────────────────────────────────────────────────────────

type RefactorMode = "rename" | "extract" | "move";

type PanelPhase =
  | "input"       // User is filling in the form
  | "computing"   // Computing preview
  | "preview"     // Showing preview, awaiting confirm
  | "applying"    // Apply in progress
  | "done"        // Applied successfully, rollback available
  | "error";      // Error occurred

interface RefactorPanelProps {
  onClose?: () => void;
}

// ─── Helpers ───────────────────────────────────────────────────────────────────

function basename(filePath: string): string {
  const parts = filePath.replace(/\\/g, "/").split("/");
  return parts[parts.length - 1] || filePath;
}

// ─── DiffView Sub-Component ────────────────────────────────────────────────────

interface DiffFileViewProps {
  filePath: string;
  changeCount: number;
  diff: DiffHunk[];
}

function DiffFileView({ filePath, changeCount, diff }: DiffFileViewProps) {
  const [expanded, setExpanded] = useState(false);
  return (
    <div className="border border-gray-700/40 rounded overflow-hidden" role="listitem">
      <button
        className="w-full flex items-center gap-2 px-3 py-1.5 text-left hover:bg-gray-800/50 transition-colors"
        onClick={() => setExpanded(!expanded)}
        aria-expanded={expanded}
        aria-label={`${basename(filePath)} — ${changeCount} change${changeCount !== 1 ? "s" : ""}`}
      >
        {expanded ? <ChevronDown size={12} className="text-gray-400 shrink-0" /> : <ChevronRight size={12} className="text-gray-400 shrink-0" />}
        <FileCode size={12} className="text-blue-400 shrink-0" />
        <span className="flex-1 text-xs text-gray-200 truncate">{filePath}</span>
        <span className="text-[10px] text-gray-400 shrink-0">{changeCount} change{changeCount !== 1 ? "s" : ""}</span>
      </button>
      {expanded && diff.length > 0 && (
        <div className="border-t border-gray-700/30 bg-gray-900/40 px-2 py-1 max-h-64 overflow-y-auto">
          {diff.map((hunk, hi) => (
            <div key={hi} className="mb-1 last:mb-0">
              <div className="text-[10px] text-gray-500 font-mono mb-0.5">
                @@ -{hunk.old_start},{hunk.old_lines} +{hunk.new_start},{hunk.new_lines} @@
              </div>
              {hunk.lines.map((line: DiffLine, li: number) => (
                <div key={li} className={`text-[11px] font-mono whitespace-pre-wrap break-all leading-relaxed ${line.kind === "add" ? "bg-green-900/20 text-green-300" : line.kind === "remove" ? "bg-red-900/20 text-red-300" : "text-gray-400"}`}>
                  <span className="inline-block w-4 text-right mr-1 text-gray-600 select-none">
                    {line.kind === "add" ? "+" : line.kind === "remove" ? "-" : " "}
                  </span>
                  {line.content}
                </div>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Main Panel ────────────────────────────────────────────────────────────────

export default function RefactorPanel({ onClose }: RefactorPanelProps) {
  // Editor state
  const activeTabId = useEditorStore((s) => s.activeTabId);
  const tabs = useEditorStore((s) => s.tabs);
  const cursorPosition = useEditorStore((s) => s.cursorPosition);
  const selectedText = useEditorStore((s) => s.selectedText);

  const activeTab = useMemo(
    () => tabs.find((t) => t.id === activeTabId),
    [tabs, activeTabId]
  );

  // Panel state
  const [mode, setMode] = useState<RefactorMode>("rename");
  const [phase, setPhase] = useState<PanelPhase>("input");

  // Input state
  const [newName, setNewName] = useState("");
  const [functionName, setFunctionName] = useState("");
  const [destinationPath, setDestinationPath] = useState("");

  // Validation
  const [validationError, setValidationError] = useState<string | null>(null);

  // Preview/Apply state
  const [preview, setPreview] = useState<RefactorPreview | null>(null);
  const [changeSet, setChangeSet] = useState<RefactorChangeSet | null>(null);
  const [snapshotId, setSnapshotId] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [errorSnapshotId, setErrorSnapshotId] = useState<string | null>(null);

  // Service ref (created fresh per operation)
  const serviceRef = useRef<RefactorService | null>(null);

  const getService = useCallback((): RefactorService => {
    if (!serviceRef.current) {
      serviceRef.current = new RefactorService();
    }
    return serviceRef.current;
  }, []);

  const handleModeChange = useCallback((newMode: RefactorMode) => {
    setMode(newMode);
    setPhase("input");
    setValidationError(null);
    setPreview(null);
    setChangeSet(null);
    setSnapshotId(null);
    setErrorMessage(null);
    setErrorSnapshotId(null);
  }, []);

  const handlePreview = useCallback(async () => {
    if (!activeTab) {
      setValidationError("No active file. Open a file first.");
      return;
    }

    const service = getService();
    setValidationError(null);
    setErrorMessage(null);

    // Validate based on mode
    if (mode === "rename") {
      const params: RenameParams = {
        filePath: activeTab.path,
        line: cursorPosition.line - 1, // Convert 1-based to 0-based
        character: cursorPosition.column - 1,
        newName: newName.trim(),
      };
      // Basic validation (in-scope symbols would come from LSP; pass empty for now)
      const validation: ValidationResult = service.validateRename(params, []);
      if (!validation.ok) {
        setValidationError(validation.message || "Invalid rename.");
        return;
      }

      setPhase("computing");
      try {
        const cs = await service.computeRename(params);
        const pv = await service.buildPreview(cs);
        setChangeSet(cs);
        setPreview(pv);
        setPhase("preview");
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Failed to compute rename preview.";
        setValidationError(msg);
        setPhase("input");
      }
    } else if (mode === "extract") {
      // Validate selection
      const validation: ValidationResult = service.validateExtractSelection(selectedText);
      if (!validation.ok) {
        setValidationError(validation.message || "Invalid selection for extraction.");
        return;
      }
      if (!functionName.trim()) {
        setValidationError("Function name is required.");
        return;
      }

      // Get selection positions from cursor
      const selLines = selectedText.split("\n");
      const params: ExtractParams = {
        filePath: activeTab.path,
        selectionStart: { line: cursorPosition.line - 1, character: 0 },
        selectionEnd: { line: cursorPosition.line - 1 + selLines.length - 1, character: selLines[selLines.length - 1].length },
        functionName: functionName.trim(),
      };

      setPhase("computing");
      try {
        const cs = await service.computeExtract(params);
        const pv = await service.buildPreview(cs);
        setChangeSet(cs);
        setPreview(pv);
        setPhase("preview");
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Failed to compute extract preview.";
        setValidationError(msg);
        setPhase("input");
      }
    } else if (mode === "move") {
      if (!destinationPath.trim()) {
        setValidationError("Destination path is required.");
        return;
      }

      const params: MoveParams = {
        sourcePath: activeTab.path,
        destinationPath: destinationPath.trim(),
      };

      setPhase("computing");
      try {
        const cs = await service.computeMove(params);
        const pv = await service.buildPreview(cs);
        setChangeSet(cs);
        setPreview(pv);
        setPhase("preview");
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Failed to compute move preview.";
        setValidationError(msg);
        setPhase("input");
      }
    }
  }, [activeTab, mode, newName, functionName, destinationPath, cursorPosition, selectedText, getService]);

  const handleConfirm = useCallback(async () => {
    if (!changeSet) return;

    const service = getService();
    setPhase("applying");
    setErrorMessage(null);

    const onConflict = (conflicts: MergeConflict[]) => {
      // Wire conflicts to the existing 3-way merge panel.
      // For each conflict, build conflict-marked content and open the file in the editor.
      // The MergeConflictPanel (rendered in App.tsx) auto-displays when tab content has conflict markers.
      const { tabs, openTab, updateTabContent, setActiveTab } = useEditorStore.getState();

      for (const conflict of conflicts) {
        const markedContent = buildConflictMarkedContent(
          conflict.actualContent,
          conflict.intendedContent,
          "Current (on disk)",
          "Refactoring"
        );

        // Check if the file is already open in a tab
        const existingTab = tabs.find((t) => t.path === conflict.filePath);
        if (existingTab) {
          // Update the tab content with conflict markers
          updateTabContent(existingTab.id, markedContent);
        } else {
          // Open a new tab with the conflict-marked content
          const fileName = conflict.filePath.replace(/\\/g, "/").split("/").pop() || conflict.filePath;
          const ext = fileName.split(".").pop() || "";
          const langMap: Record<string, string> = {
            ts: "typescript", tsx: "typescriptreact", js: "javascript", jsx: "javascriptreact",
            py: "python", rs: "rust", css: "css", html: "html", json: "json", md: "markdown",
          };
          openTab({
            id: `conflict-${conflict.filePath}-${Date.now()}`,
            path: conflict.filePath,
            name: fileName,
            content: markedContent,
            originalContent: conflict.actualContent,
            modified: true,
            language: langMap[ext] || "plaintext",
          });
        }
      }

      // Activate the first conflicted file's tab so the merge panel is visible
      if (conflicts.length > 0) {
        const firstConflict = conflicts[0];
        const updatedTabs = useEditorStore.getState().tabs;
        const targetTab = updatedTabs.find((t) => t.path === firstConflict.filePath);
        if (targetTab) {
          setActiveTab(targetTab.id);
        }
      }

      showToast(
        `Merge conflict in ${conflicts.length} file(s). Resolve in the editor merge panel.`,
        "warning"
      );
    };

    try {
      const result = await service.apply(changeSet, onConflict);
      setSnapshotId(result.snapshotId);
      setPhase("done");
    } catch (err) {
      if (err instanceof RefactorError) {
        setErrorMessage(err.message);
        setErrorSnapshotId(err.snapshotId || null);
      } else {
        const msg = err instanceof Error ? err.message : "Apply failed.";
        setErrorMessage(msg);
      }
      setPhase("error");
    }
  }, [changeSet, getService]);

  const handleCancel = useCallback(() => {
    setPhase("input");
    setPreview(null);
    setChangeSet(null);
  }, []);

  const handleRollback = useCallback(async (id: string) => {
    const service = getService();
    try {
      await service.rollback(id);
      showToast("Rollback successful. Files restored.", "success");
      setPhase("input");
      setSnapshotId(null);
      setPreview(null);
      setChangeSet(null);
      setErrorMessage(null);
      setErrorSnapshotId(null);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Rollback failed.";
      showToast(`Rollback failed: ${msg}`, "error");
    }
  }, [getService]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape" && onClose) {
        e.preventDefault();
        onClose();
      }
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [onClose]);

  const modeButtons: { key: RefactorMode; label: string; icon: typeof PenLine }[] = [
    { key: "rename", label: "Rename", icon: PenLine },
    { key: "extract", label: "Extract Function", icon: FunctionSquare },
    { key: "move", label: "Move File", icon: FolderInput },
  ];

  return (
    <div
      className="flex flex-col h-full bg-[#1e1e2e] text-gray-200 overflow-hidden"
      role="region"
      aria-label="Refactoring panel"
    >
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-gray-700/50">
        <div className="flex items-center gap-2">
          <PenLine size={16} className="text-purple-400" />
          <span className="text-xs font-medium text-gray-200">Refactor</span>
        </div>
        {onClose && (
          <button
            className="p-1 rounded hover:bg-gray-700/50 text-gray-400 hover:text-gray-200 transition-colors"
            onClick={onClose}
            aria-label="Close refactoring panel"
            title="Close"
          >
            <X size={14} />
          </button>
        )}
      </div>

      {/* Mode tabs */}
      <div className="flex border-b border-gray-700/50" role="tablist" aria-label="Refactoring operation">
        {modeButtons.map(({ key, label, icon: Icon }) => (
          <button
            key={key} role="tab" aria-selected={mode === key} aria-controls={`panel-${key}`}
            className={`flex-1 flex items-center justify-center gap-1.5 px-2 py-1.5 text-[11px] transition-colors ${mode === key ? "border-b-2 border-purple-400 text-purple-300 bg-purple-900/10" : "text-gray-400 hover:text-gray-200 hover:bg-gray-800/40"}`}
            onClick={() => handleModeChange(key)}
            disabled={phase === "computing" || phase === "applying"}
          >
            <Icon size={12} />
            {label}
          </button>
        ))}
      </div>

      {/* Body */}
      <div className="flex-1 overflow-y-auto p-3 space-y-3">
        {/* Input Phase */}
        {(phase === "input" || phase === "computing") && (
          <div id={`panel-${mode}`} role="tabpanel" className="space-y-3">
            {/* Active file indicator */}
            {activeTab && (
              <div className="text-[10px] text-gray-500 truncate">
                Active: {activeTab.path}
              </div>
            )}

            {/* Rename inputs */}
            {mode === "rename" && (
              <div className="space-y-2">
                <label className="block">
                  <span className="text-[11px] text-gray-400 mb-1 block">New Name</span>
                  <input
                    type="text" value={newName}
                    onChange={(e) => { setNewName(e.target.value); setValidationError(null); }}
                    placeholder="Enter new symbol name…"
                    className="w-full px-2 py-1.5 text-xs bg-gray-900/60 border border-gray-700/50 rounded text-gray-200 placeholder-gray-500 focus:outline-none focus:border-purple-500/60 transition-colors"
                    aria-label="New symbol name" aria-invalid={!!validationError}
                    aria-describedby={validationError ? "rename-error" : undefined}
                    disabled={phase === "computing"}
                    onKeyDown={(e) => { if (e.key === "Enter") handlePreview(); }}
                  />
                </label>
                <div className="text-[10px] text-gray-500">Cursor at line {cursorPosition.line}, col {cursorPosition.column}</div>
              </div>
            )}

            {/* Extract inputs */}
            {mode === "extract" && (
              <div className="space-y-2">
                <label className="block">
                  <span className="text-[11px] text-gray-400 mb-1 block">Function Name</span>
                  <input
                    type="text" value={functionName}
                    onChange={(e) => { setFunctionName(e.target.value); setValidationError(null); }}
                    placeholder="Enter function name…"
                    className="w-full px-2 py-1.5 text-xs bg-gray-900/60 border border-gray-700/50 rounded text-gray-200 placeholder-gray-500 focus:outline-none focus:border-purple-500/60 transition-colors"
                    aria-label="Extracted function name" aria-invalid={!!validationError}
                    aria-describedby={validationError ? "extract-error" : undefined}
                    disabled={phase === "computing"}
                    onKeyDown={(e) => { if (e.key === "Enter") handlePreview(); }}
                  />
                </label>
                {selectedText ? (
                  <div className="text-[10px] text-gray-500">Selection: {selectedText.split("\n").length} line(s) selected</div>
                ) : (
                  <div className="text-[10px] text-yellow-500/80">No code selected. Select code to extract.</div>
                )}
              </div>
            )}

            {/* Move inputs */}
            {mode === "move" && (
              <div className="space-y-2">
                <div className="text-[10px] text-gray-500">Source: {activeTab?.path || "No file open"}</div>
                <label className="block">
                  <span className="text-[11px] text-gray-400 mb-1 block">Destination Path</span>
                  <input
                    type="text" value={destinationPath}
                    onChange={(e) => { setDestinationPath(e.target.value); setValidationError(null); }}
                    placeholder="Enter destination file path…"
                    className="w-full px-2 py-1.5 text-xs bg-gray-900/60 border border-gray-700/50 rounded text-gray-200 placeholder-gray-500 focus:outline-none focus:border-purple-500/60 transition-colors"
                    aria-label="Destination file path" aria-invalid={!!validationError}
                    aria-describedby={validationError ? "move-error" : undefined}
                    disabled={phase === "computing"}
                    onKeyDown={(e) => { if (e.key === "Enter") handlePreview(); }}
                  />
                </label>
              </div>
            )}

            {/* Validation error (inline) */}
            {validationError && (
              <div
                id={`${mode}-error`}
                className="flex items-start gap-1.5 text-[11px] text-red-400"
                role="alert"
              >
                <AlertCircle size={12} className="shrink-0 mt-0.5" />
                <span>{validationError}</span>
              </div>
            )}

            {/* Preview button */}
            <button
              className="w-full flex items-center justify-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded bg-purple-600/80 hover:bg-purple-600 text-white transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              onClick={handlePreview}
              disabled={phase === "computing" || !activeTab}
              aria-label="Preview refactoring changes"
            >
              {phase === "computing" ? (
                <>
                  <Loader2 size={12} className="animate-spin" />
                  Computing…
                </>
              ) : (
                <>
                  <Eye size={12} />
                  Preview
                </>
              )}
            </button>
          </div>
        )}

        {/* Preview Phase */}
        {phase === "preview" && preview && (
          <div className="space-y-3">
            {/* Summary */}
            <div className="flex items-center gap-2 text-[11px] text-gray-300">
              <span className="font-medium">
                {preview.totalFiles} file{preview.totalFiles !== 1 ? "s" : ""} affected
              </span>
              <span className="text-gray-500">•</span>
              <span>
                {preview.totalChanges} total change{preview.totalChanges !== 1 ? "s" : ""}
              </span>
            </div>

            {/* Per-file diffs */}
            <div className="space-y-1.5" role="list" aria-label="Affected files">
              {preview.diffs.map((fileDiff) => (
                <DiffFileView
                  key={fileDiff.filePath}
                  filePath={fileDiff.filePath}
                  changeCount={fileDiff.changeCount}
                  diff={fileDiff.diff}
                />
              ))}
            </div>

            {/* Confirm / Cancel buttons */}
            <div className="flex gap-2">
              <button
                className="flex-1 flex items-center justify-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded bg-green-600/80 hover:bg-green-600 text-white transition-colors"
                onClick={handleConfirm}
                aria-label="Confirm and apply refactoring"
              >
                <Check size={12} />
                Confirm
              </button>
              <button
                className="flex-1 flex items-center justify-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded bg-gray-700/60 hover:bg-gray-700 text-gray-200 transition-colors"
                onClick={handleCancel}
                aria-label="Cancel and discard preview"
              >
                <X size={12} />
                Cancel
              </button>
            </div>
          </div>
        )}

        {/* Applying Phase */}
        {phase === "applying" && (
          <div className="flex flex-col items-center justify-center py-8 gap-2">
            <Loader2 size={20} className="animate-spin text-purple-400" />
            <span className="text-xs text-gray-400">Applying refactoring…</span>
          </div>
        )}

        {/* Done Phase (Rollback available) */}
        {phase === "done" && (
          <div className="space-y-3">
            <div className="flex items-center gap-2 text-[11px] text-green-400">
              <Check size={14} />
              <span>Refactoring applied successfully.</span>
            </div>

            {snapshotId && (
              <button
                className="w-full flex items-center justify-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded bg-amber-700/60 hover:bg-amber-700 text-amber-100 transition-colors"
                onClick={() => handleRollback(snapshotId)}
                aria-label="Rollback refactoring"
              >
                <Undo2 size={12} />
                Rollback
              </button>
            )}

            <button
              className="w-full flex items-center justify-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded bg-gray-700/60 hover:bg-gray-700 text-gray-200 transition-colors"
              onClick={() => handleModeChange(mode)}
              aria-label="Start a new refactoring"
            >
              New Refactoring
            </button>
          </div>
        )}

        {/* Error Phase */}
        {phase === "error" && (
          <div className="space-y-3">
            <div
              className="flex items-start gap-1.5 text-[11px] text-red-400 bg-red-900/10 border border-red-700/30 rounded p-2"
              role="alert"
            >
              <AlertCircle size={12} className="shrink-0 mt-0.5" />
              <span>{errorMessage || "An error occurred during the refactoring."}</span>
            </div>

            {errorSnapshotId && (
              <button
                className="w-full flex items-center justify-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded bg-amber-700/60 hover:bg-amber-700 text-amber-100 transition-colors"
                onClick={() => handleRollback(errorSnapshotId)}
                aria-label="Rollback using error snapshot"
              >
                <Undo2 size={12} />
                Rollback (Restore Files)
              </button>
            )}

            <button
              className="w-full flex items-center justify-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded bg-gray-700/60 hover:bg-gray-700 text-gray-200 transition-colors"
              onClick={() => handleModeChange(mode)}
              aria-label="Try again"
            >
              Try Again
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
