/**
 * ComposerPanel — Multi-file AI edit orchestration.
 * Users describe a change, AI auto-detects which files to modify,
 * generates edits across those files, user reviews and applies as batch.
 */

import { useState, useCallback } from "react";
import { Layers, Play, X, FileCode, Check, RotateCcw, Loader2, Sparkles, Search } from "lucide-react";
import { sendToProvider } from "../utils/providers";
import type { AIProviderConfig } from "../utils/providers";
import { searchCodebase, isIndexed } from "../utils/codebaseIndex";

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
  status: "idle" | "detecting" | "generating" | "reviewing" | "applied" | "error";
  error?: string;
  detectedAutomatically?: boolean;
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

/** Truncate a file tree to just relative paths, max 120 entries */
function buildCompactFileTree(allFiles: string[], projectPath: string): string {
  const relativePaths = allFiles
    .map((f) => f.replace(projectPath, "").replace(/^[\\/]/, "").replace(/\\/g, "/"))
    .slice(0, 120);
  return relativePaths.join("\n");
}

const FILE_DETECT_SYSTEM_PROMPT = `You are a file-detection assistant for a code IDE.
Given a user's change instruction and a project file list, identify which files need to be modified or created.

Rules:
- Output ONLY a JSON array of relative file paths, e.g. ["src/utils/auth.ts", "src/components/Login.tsx"]
- Include files that NEED changes — not every file in the project
- If new files need to be created, include them with a "NEW:" prefix, e.g. "NEW:src/hooks/useAuth.ts"
- Maximum 10 files
- No markdown, no explanation — only the JSON array`;

export default function ComposerPanel({ projectPath, files, aiProviders, config, onApplyChanges }: Props) {
  const [state, setState] = useState<ComposerState>({
    instruction: "",
    targetFiles: [],
    generatedChanges: [],
    status: "idle",
  });
  const [showAllFiles, setShowAllFiles] = useState(false);

  const allFiles = flattenFiles(files);

  /** Find a usable provider + model from available providers */
  const getProvider = useCallback(() => {
    const provider = aiProviders.find((p) => p.apiKey && p.models.some((m) => m.enabled));
    if (!provider) return null;
    const model = provider.models.find((m) => m.enabled);
    if (!model) return null;
    return { provider, modelId: model.id };
  }, [aiProviders]);

  /**
   * Auto-detect which files the instruction likely needs to modify.
   * Strategy:
   * 1. Use local TF-IDF search to find top candidate files (fast, no LLM cost)
   * 2. Make a quick LLM call with the instruction + candidate files to refine the list
   * 3. Falls back to TF-IDF-only results if LLM call fails
   */
  const detectTargetFiles = useCallback(async (instruction: string): Promise<string[]> => {
    const compactTree = buildCompactFileTree(allFiles, projectPath);

    // Step 1: TF-IDF pre-filter (fast, free)
    let candidates: string[] = [];
    if (isIndexed()) {
      const hits = searchCodebase(instruction, 15);
      candidates = [...new Set(hits.map((h) => h.path))].slice(0, 15);
    }

    // Step 2: LLM refinement (uses the planner pattern — quick JSON call)
    const providerInfo = getProvider();
    if (!providerInfo) {
      // No provider available — fall back to TF-IDF results only
      return candidates.slice(0, 8);
    }

    const candidateContext = candidates.length > 0
      ? `\n\nMost relevant files (by code similarity):\n${candidates.join("\n")}`
      : "";

    const userPrompt = `Instruction: ${instruction}\n\nProject files:\n${compactTree}${candidateContext}\n\nWhich files need to be modified or created? Return ONLY a JSON array of relative file paths.`;

    try {
      const resp = await sendToProvider(providerInfo.provider, providerInfo.modelId, {
        systemPrompt: FILE_DETECT_SYSTEM_PROMPT,
        userPrompt,
        temperature: 0.1,
        maxTokens: 500,
      });

      if (!resp.success || !resp.text.trim()) {
        return candidates.slice(0, 8);
      }

      // Parse JSON array from response
      const jsonMatch = resp.text.match(/\[[\s\S]*?\]/);
      if (!jsonMatch) return candidates.slice(0, 8);

      const parsed = JSON.parse(jsonMatch[0]) as string[];
      if (!Array.isArray(parsed)) return candidates.slice(0, 8);

      // Resolve relative paths back to absolute paths
      const resolved: string[] = [];
      for (const relPath of parsed.slice(0, 10)) {
        const cleanPath = relPath.replace(/^NEW:/, "");
        const isNew = relPath.startsWith("NEW:");

        // Find matching absolute path in project
        const match = allFiles.find((f) => {
          const rel = f.replace(projectPath, "").replace(/^[\\/]/, "").replace(/\\/g, "/");
          return rel === cleanPath || rel === cleanPath.replace(/\//g, "\\");
        });

        if (match) {
          resolved.push(match);
        } else if (isNew) {
          // New file — construct the path
          const sep = projectPath.includes("/") ? "/" : "\\";
          resolved.push(projectPath + sep + cleanPath.replace(/\//g, sep));
        }
      }

      return resolved.length > 0 ? resolved : candidates.slice(0, 8);
    } catch {
      // LLM failed — fall back to TF-IDF
      return candidates.slice(0, 8);
    }
  }, [allFiles, projectPath, getProvider]);

  /** Handle the "Generate" click — auto-detects files if none selected */
  const handleGenerate = useCallback(async () => {
    if (!state.instruction.trim()) return;

    // If no files manually selected, auto-detect first
    if (state.targetFiles.length === 0) {
      setState((s) => ({ ...s, status: "detecting", error: undefined }));

      const detected = await detectTargetFiles(state.instruction);

      if (detected.length === 0) {
        setState((s) => ({
          ...s,
          status: "error",
          error: "Could not detect relevant files. Try selecting files manually.",
        }));
        return;
      }

      setState((s) => ({
        ...s,
        targetFiles: detected,
        detectedAutomatically: true,
        status: "generating",
      }));
    } else {
      setState((s) => ({ ...s, status: "generating", error: undefined }));
    }

    // TODO: Actual multi-file generation call goes here (separate task)
    // For now, transition to reviewing with the detected files shown
    setState((s) => ({
      ...s,
      status: "reviewing",
      generatedChanges: [],
    }));
  }, [state.instruction, state.targetFiles, detectTargetFiles]);

  /** Manually trigger file detection without generating */
  const handleDetectOnly = useCallback(async () => {
    if (!state.instruction.trim()) return;
    setState((s) => ({ ...s, status: "detecting", error: undefined }));

    const detected = await detectTargetFiles(state.instruction);

    setState((s) => ({
      ...s,
      targetFiles: detected,
      detectedAutomatically: true,
      status: "idle",
    }));
  }, [state.instruction, detectTargetFiles]);

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
    } catch {
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
    setShowAllFiles(false);
  };

  const visibleFiles = showAllFiles ? allFiles : allFiles.slice(0, 20);

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
          disabled={state.status === "generating" || state.status === "detecting"}
        />
      </div>

      {/* Target files selector */}
      <div className="composer-files-section">
        <div className="composer-files-header">
          <FileCode size={13} />
          <span>
            Target files ({state.targetFiles.length || "auto"})
            {state.detectedAutomatically && state.targetFiles.length > 0 && (
              <span className="composer-auto-badge">AI detected</span>
            )}
          </span>
          {state.instruction.trim() && state.status === "idle" && (
            <button
              className="composer-detect-btn"
              onClick={handleDetectOnly}
              title="Auto-detect which files need changes"
            >
              <Search size={11} />
              Detect
            </button>
          )}
        </div>

        {/* Show detected files as chips */}
        {state.targetFiles.length > 0 && (
          <div className="composer-detected-files">
            {state.targetFiles.map((file) => {
              const relativePath = file.replace(projectPath, "").replace(/^[\\/]/, "");
              return (
                <div key={file} className="composer-file-chip">
                  <FileCode size={10} />
                  <span>{relativePath}</span>
                  <button
                    className="composer-file-chip-remove"
                    onClick={() => setState((s) => ({
                      ...s,
                      targetFiles: s.targetFiles.filter((f) => f !== file),
                      detectedAutomatically: false,
                    }))}
                    title="Remove"
                  >
                    <X size={9} />
                  </button>
                </div>
              );
            })}
          </div>
        )}

        {/* Manual file selection (collapsible) */}
        <details className="composer-files-details">
          <summary className="composer-files-summary">Manual selection</summary>
          <div className="composer-files-list">
            {visibleFiles.map((file) => {
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
                        detectedAutomatically: false,
                      }));
                    }}
                  />
                  <span className="composer-file-name">{relativePath}</span>
                </label>
              );
            })}
            {allFiles.length > 20 && !showAllFiles && (
              <button className="composer-files-more" onClick={() => setShowAllFiles(true)}>
                +{allFiles.length - 20} more files
              </button>
            )}
          </div>
        </details>
      </div>

      {/* Detecting indicator */}
      {state.status === "detecting" && (
        <div className="composer-detecting">
          <Sparkles size={13} className="animate-spin" />
          <span>Detecting relevant files…</span>
        </div>
      )}

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
        {(state.status === "idle" || state.status === "error") && (
          <button
            className="composer-btn primary"
            onClick={handleGenerate}
            disabled={!state.instruction.trim()}
            title={state.targetFiles.length === 0 ? "Will auto-detect files first" : "Generate changes for selected files"}
          >
            {state.targetFiles.length === 0 ? <Sparkles size={14} /> : <Play size={14} />}
            {state.targetFiles.length === 0 ? "Auto-detect & Generate" : "Generate Changes"}
          </button>
        )}

        {state.status === "detecting" && (
          <button className="composer-btn" disabled>
            <Loader2 size={14} className="animate-spin" />
            Detecting files...
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
