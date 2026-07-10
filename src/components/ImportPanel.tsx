/**
 * ImportPanel — AI Workspace Import UI.
 *
 * Punam IDE only understands project.punam format.
 * This panel reads a ZIP, previews its contents, and imports to a new folder.
 * It does NOT know where the ZIP came from (DeepSeek, ChatGPT, Claude, manual).
 */

import { useState, useCallback } from "react";
import { FolderOpen, Package, FileCode, ChevronRight, ChevronDown, AlertTriangle, Check, Loader2, X } from "lucide-react";
import { importZipPreview, importZipExtract, importDetectConflicts } from "../utils/tauri";
import type { ImportPreview, ImportFileEntry, ConflictInfo } from "../utils/tauri";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { showToast } from "../utils/toast";

interface Props {
  onProjectImported?: (path: string) => void;
  onClose?: () => void;
}

type ImportStep = "select" | "preview" | "importing" | "done";

export default function ImportPanel({ onProjectImported, onClose }: Props) {
  const [step, setStep] = useState<ImportStep>("select");
  const [zipPath, setZipPath] = useState("");
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [destination, setDestination] = useState("");
  const [conflicts, setConflicts] = useState<ConflictInfo[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState("");
  const [result, setResult] = useState<{ files: number; path: string } | null>(null);

  // ─── Step 1: Pick ZIP file ──────────────────────────────────────────────────

  const handlePickZip = useCallback(async () => {
    try {
      const selected = await open({
        title: "Select AI Project ZIP",
        directory: false,
        multiple: false,
        filters: [{ name: "ZIP Archive", extensions: ["zip"] }],
      });

      if (!selected) return;
      const filePath = typeof selected === "string" ? selected : String(selected);

      setZipPath(filePath as string);
      setError(null);
      setProgress("Reading ZIP...");

      const previewData = await importZipPreview(filePath as string);
      setPreview(previewData);

      // Set default destination
      const homeDir = await invoke<string>("get_home_dir").catch(() => "C:\\Users\\amrit");
      const separator = homeDir.includes("/") ? "/" : "\\";
      const defaultDest = `${homeDir}${separator}PunamProjects${separator}${previewData.project_name}`;
      setDestination(defaultDest);

      setStep("preview");
      setProgress("");
    } catch (err) {
      setError(String(err));
      setProgress("");
    }
  }, []);

  // ─── Change destination ─────────────────────────────────────────────────────

  const handleChangeDestination = useCallback(async () => {
    try {
      const selected = await open({
        title: "Choose destination folder",
        directory: true,
        multiple: false,
      });
      if (selected && typeof selected === "string") {
        setDestination(selected);
        // Check for conflicts
        if (zipPath) {
          const conflictList = await importDetectConflicts(zipPath, selected);
          setConflicts(conflictList);
        }
      }
    } catch { /* cancelled */ }
  }, [zipPath]);

  // ─── Step 2: Import ─────────────────────────────────────────────────────────

  const handleImport = useCallback(async () => {
    if (!zipPath || !destination) return;

    setStep("importing");
    setProgress("Creating project folder...");
    setError(null);

    try {
      setProgress("Extracting files...");
      const importResult = await importZipExtract(zipPath, destination);

      if (importResult.success) {
        setResult({ files: importResult.files_written, path: importResult.destination });
        setStep("done");
        showToast(`Imported ${importResult.files_written} files`, "success");
      } else {
        setError(importResult.error || "Import failed");
        setStep("preview");
      }
    } catch (err) {
      setError(String(err));
      setStep("preview");
    }
  }, [zipPath, destination]);

  // ─── Step 3: Open project ───────────────────────────────────────────────────

  const handleOpenProject = useCallback(() => {
    if (result?.path && onProjectImported) {
      onProjectImported(result.path);
    }
  }, [result, onProjectImported]);

  // ─── Render ─────────────────────────────────────────────────────────────────

  return (
    <div className="import-panel">
      {/* Header */}
      <div className="panel-header import-panel-header">
        <div className="import-title">
          <Package size={16} />
          <span>AI Workspace Import</span>
        </div>
        {onClose && (
          <button type="button" className="icon-btn small" onClick={onClose} aria-label="Close">
            <X size={14} />
          </button>
        )}
      </div>

      {/* Step: Select ZIP */}
      {step === "select" && (
        <div className="import-select">
          <div className="import-description">
            <p>Import a project generated by any AI model.</p>
            <p className="import-hint">Supports ZIP files exported from DeepSeek, ChatGPT, Claude, or any source.</p>
          </div>
          <button type="button" className="import-pick-btn" onClick={handlePickZip}>
            <FolderOpen size={18} />
            <span>Select ZIP File</span>
          </button>
          {error && <div className="import-error">{error}</div>}
          {progress && <div className="import-progress"><Loader2 size={14} className="spin" /> {progress}</div>}
        </div>
      )}

      {/* Step: Preview */}
      {step === "preview" && preview && (
        <div className="import-preview">
          {/* Project info */}
          <div className="import-project-info">
            <h3>{preview.project_name}</h3>
            {preview.description && <p className="import-desc">{preview.description}</p>}
            <div className="import-stats">
              <span>{preview.total_files} files</span>
              <span>{preview.total_lines.toLocaleString()} lines</span>
              <span>{(preview.total_bytes / 1024).toFixed(1)} KB</span>
              <span>{preview.languages.join(", ")}</span>
            </div>
            {preview.source?.provider && (
              <div className="import-source">Source: {preview.source.provider}</div>
            )}
          </div>

          {/* File tree */}
          <div className="import-file-tree">
            <FileTree files={preview.files} />
          </div>

          {/* Commands detected */}
          {(preview.suggested_build_command || preview.suggested_run_command) && (
            <div className="import-commands">
              {preview.suggested_build_command && <span>Build: <code>{preview.suggested_build_command}</code></span>}
              {preview.suggested_run_command && <span>Run: <code>{preview.suggested_run_command}</code></span>}
            </div>
          )}

          {/* Destination */}
          <div className="import-destination">
            <label>Import to:</label>
            <div className="import-dest-row">
              <input
                type="text"
                value={destination}
                onChange={(e) => setDestination(e.target.value)}
                className="import-dest-input"
              />
              <button type="button" className="import-dest-btn" onClick={handleChangeDestination}>
                Change
              </button>
            </div>
          </div>

          {/* Conflicts warning */}
          {conflicts.length > 0 && (
            <div className="import-conflicts">
              <AlertTriangle size={14} />
              <span>{conflicts.length} file(s) will be overwritten</span>
            </div>
          )}

          {/* Error */}
          {error && <div className="import-error">{error}</div>}

          {/* Actions */}
          <div className="import-actions">
            <button type="button" className="import-btn-secondary" onClick={() => { setStep("select"); setPreview(null); }}>
              Back
            </button>
            <button type="button" className="import-btn-primary" onClick={handleImport}>
              <Package size={14} />
              Import & Open Project
            </button>
          </div>
        </div>
      )}

      {/* Step: Importing */}
      {step === "importing" && (
        <div className="import-loading">
          <Loader2 size={24} className="spin" />
          <p>{progress || "Importing..."}</p>
        </div>
      )}

      {/* Step: Done */}
      {step === "done" && result && (
        <div className="import-done">
          <div className="import-done-icon">
            <Check size={32} />
          </div>
          <h3>Import Complete</h3>
          <p>{result.files} files imported to:</p>
          <code className="import-done-path">{result.path}</code>
          <div className="import-actions">
            <button type="button" className="import-btn-secondary" onClick={() => { setStep("select"); setResult(null); setPreview(null); }}>
              Import Another
            </button>
            <button type="button" className="import-btn-primary" onClick={handleOpenProject}>
              <FolderOpen size={14} />
              Open Project
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── File Tree Component ──────────────────────────────────────────────────────

interface FileTreeProps {
  files: ImportFileEntry[];
}

interface TreeNode {
  name: string;
  path: string;
  isDir: boolean;
  children: TreeNode[];
  file?: ImportFileEntry;
}

function buildTree(files: ImportFileEntry[]): TreeNode[] {
  const root: TreeNode[] = [];

  for (const file of files) {
    const parts = file.path.split("/");
    let current = root;

    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      const isLast = i === parts.length - 1;
      const existingNode = current.find((n) => n.name === part);

      if (existingNode) {
        if (isLast) {
          existingNode.file = file;
        } else {
          current = existingNode.children;
        }
      } else {
        const newNode: TreeNode = {
          name: part,
          path: parts.slice(0, i + 1).join("/"),
          isDir: !isLast,
          children: [],
          file: isLast ? file : undefined,
        };
        current.push(newNode);
        if (!isLast) {
          current = newNode.children;
        }
      }
    }
  }

  // Sort: dirs first, then alphabetical
  function sortTree(nodes: TreeNode[]) {
    nodes.sort((a, b) => {
      if (a.isDir && !b.isDir) return -1;
      if (!a.isDir && b.isDir) return 1;
      return a.name.localeCompare(b.name);
    });
    nodes.forEach((n) => sortTree(n.children));
  }
  sortTree(root);

  return root;
}

function FileTree({ files }: FileTreeProps) {
  const tree = buildTree(files);
  return (
    <div className="file-tree-container">
      {tree.map((node) => (
        <TreeNodeView key={node.path} node={node} depth={0} />
      ))}
    </div>
  );
}

function TreeNodeView({ node, depth }: { node: TreeNode; depth: number }) {
  const [expanded, setExpanded] = useState(depth < 2);

  if (node.isDir) {
    return (
      <div>
        <button
          type="button"
          className="tree-node tree-dir"
          style={{ paddingLeft: `${depth * 16 + 4}px` }}
          onClick={() => setExpanded(!expanded)}
        >
          {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
          <span className="tree-dir-name">{node.name}/</span>
          <span className="tree-count">{countFiles(node)}</span>
        </button>
        {expanded && node.children.map((child) => (
          <TreeNodeView key={child.path} node={child} depth={depth + 1} />
        ))}
      </div>
    );
  }

  return (
    <div
      className="tree-node tree-file"
      style={{ paddingLeft: `${depth * 16 + 20}px` }}
    >
      <FileCode size={12} />
      <span className="tree-file-name">{node.name}</span>
      {node.file?.line_count && (
        <span className="tree-file-lines">{node.file.line_count}L</span>
      )}
      {node.file?.language && (
        <span className="tree-file-lang">{node.file.language}</span>
      )}
    </div>
  );
}

function countFiles(node: TreeNode): number {
  if (!node.isDir) return 1;
  return node.children.reduce((sum, child) => sum + countFiles(child), 0);
}
