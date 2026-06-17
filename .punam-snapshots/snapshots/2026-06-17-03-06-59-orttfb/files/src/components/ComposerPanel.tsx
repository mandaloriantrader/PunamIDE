/**
 * ComposerPanel — Multi-file AI edit orchestration.
 * Users describe a change, AI generates edits across multiple files,
 * user reviews and applies them as a batch.
 */

import { useState, useCallback } from "react";
import { Layers, Play, X, FileCode, Check, RotateCcw, Loader2 } from "lucide-react";
import type { AIProviderConfig } from "../utils/providers";

interface FileChange {
  path: string;
  content: string;
  isNew: boolean;
  originalContent?: string;
}

interface ComposerState {
  instruction: string;
  targetFiles: string[];
  generatedChanges: FileChange[];
  status: "idle" | "generating" | "reviewing" | "applied" | "error";
  error?: string;
}

interface Props {
  projectPath: string;
  files: { name: string; path: string; is_dir: boolean; children?: any[] }[];
  aiProviders: AIProviderConfig[];
  config: { provider: string; api_key: string; model: string };
  onApplyChanges: (changes: any) => Promise<void>;
}

function flattenFiles(entries: any[]): string[] {
  const result: string[] = [];
  for (const entry of entries) {
    if (entry.is_dir && entry.children) {
      result.push(...flattenFiles(entry.children));
    } else if (!entry.is_dir) {
      result.push(entry.path);
    }
  }
  return result;
}

export default function ComposerPanel({ projectPath, files, onApplyChanges }: Props) {
  const [state, setState] = useState<ComposerState>({
    instruction: "",
    targetFiles: [],
    generatedChanges: [],
    status: "idle",
  });

  const allFiles = flattenFiles(files);

  const handleGenerate = useCallback(async () => {
    if (!state.instruction.trim()) return;

    setState((s) => ({ ...s, status: "generating", error: undefined }));

    try {
      // Build context from target files or all open files
      // For now, show the generating state — actual AI integration
      // will use the same call_llm/call_gemini_stream backend
      setState((s) => ({
        ...s,
        status: "reviewing",
        generatedChanges: [], // Will be populated by AI response
      }));
    } catch (err) {
      setState((s) => ({
        ...s,
        status: "error",
        error: err instanceof Error ? err.message : "Generation failed",
      }));
    }
  }, [state.instruction, state.targetFiles]);

  const handleApply = useCallback(async () => {
    if (state.generatedChanges.length === 0) return;

    try {
      await onApplyChanges({
        fileChanges: state.generatedChanges.map((fc) => ({
          path: fc.path.replace(projectPath + "/", "").replace(projectPath + "\\", ""),
          content: fc.content,
          isNew: fc.isNew,
        })),
        deletions: [],
        explanation: state.instruction,
      });
      setState((s) => ({ ...s, status: "applied" }));
    } catch (err) {
      setState((s) => ({
        ...s,
        status: "error",
        error: "Failed to apply changes",
      }));
    }
  }, [state.generatedChanges, state.instruction, projectPath, onApplyChanges]);

  const handleReset = () => {
    setState({
      instruction: "",
      targetFiles: [],
      generatedChanges: [],
      status: "idle",
    });
  };

  return (
    <div className="composer-panel">
      <div className="composer-header">
        <Layers size={16} />
        <span>Composer</span>
        <span className="composer-badge">Multi-file</span>
      </div>

      {/* Instruction input */}
      <div className="composer-input-section">
        <textarea
          className="composer-textarea"
          value={state.instruction}
          onChange={(e) => setState((s) => ({ ...s, instruction: e.target.value }))}
          placeholder="Describe the change you want across multiple files...&#10;&#10;e.g. 'Add error handling to all API calls' or 'Refactor auth to use JWT tokens'"
          rows={4}
          disabled={state.status === "generating"}
        />
      </div>

      {/* Target files selector */}
      <div className="composer-files-section">
        <div className="composer-files-header">
          <FileCode size={13} />
          <span>Target files ({state.targetFiles.length || "all"})</span>
        </div>
        <div className="composer-files-list">
          {allFiles.slice(0, 20).map((file) => {
            const relativePath = file.replace(projectPath, "").replace(/^[\\/]/, "");
            const isSelected = state.targetFiles.includes(file);
            return (
              <label key={file} className="composer-file-item">
                <input
                  type="checkbox"
                  checked={isSelected}
                  onChange={() => {
                    setState((s) => ({
                      ...s,
                      targetFiles: isSelected
                        ? s.targetFiles.filter((f) => f !== file)
                        : [...s.targetFiles, file],
                    }));
                  }}
                />
                <span className="composer-file-name">{relativePath}</span>
              </label>
            );
          })}
          {allFiles.length > 20 && (
            <span className="composer-files-more">+{allFiles.length - 20} more files</span>
          )}
        </div>
      </div>

      {/* Generated changes review */}
      {state.status === "reviewing" && state.generatedChanges.length > 0 && (
        <div className="composer-review">
          <div className="composer-review-header">
            <span>{state.generatedChanges.length} file(s) will be modified</span>
          </div>
          {state.generatedChanges.map((fc) => (
            <div key={fc.path} className="composer-change-item">
              <FileCode size={13} />
              <span>{fc.path.split(/[\\/]/).pop()}</span>
              {fc.isNew && <span className="composer-new-badge">NEW</span>}
            </div>
          ))}
        </div>
      )}

      {/* Error display */}
      {state.status === "error" && state.error && (
        <div className="composer-error">
          <span>{state.error}</span>
        </div>
      )}

      {/* Actions */}
      <div className="composer-actions">
        {state.status === "idle" && (
          <button
            className="composer-btn primary"
            onClick={handleGenerate}
            disabled={!state.instruction.trim()}
          >
            <Play size={14} />
            Generate Changes
          </button>
        )}

        {state.status === "generating" && (
          <button className="composer-btn" disabled>
            <Loader2 size={14} className="animate-spin" />
            Generating...
          </button>
        )}

        {state.status === "reviewing" && (
          <>
            <button className="composer-btn primary" onClick={handleApply}>
              <Check size={14} />
              Apply All
            </button>
            <button className="composer-btn" onClick={handleReset}>
              <X size={14} />
              Discard
            </button>
          </>
        )}

        {state.status === "applied" && (
          <button className="composer-btn" onClick={handleReset}>
            <RotateCcw size={14} />
            New Composition
          </button>
        )}
      </div>
    </div>
  );
}
