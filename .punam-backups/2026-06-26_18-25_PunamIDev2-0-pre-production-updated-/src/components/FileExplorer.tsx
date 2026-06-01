import { useState, useCallback, useMemo, useRef, useEffect } from "react";
import {
  createDirectory,
  createFile,
  deletePath,
  renamePath,
  revealPath,
  type FileEntry,
} from "../utils/tauri";
import { showToast } from "../utils/toast";
import { ChevronRight } from "lucide-react";
import { FileIcon, FolderIcon } from "./FileIcon";

interface Props {
  files: FileEntry[];
  projectPath: string;
  loading?: boolean;
  onFileSelect: (path: string) => void;
  onRefresh: () => void;
  onPathDeleted: (path: string) => void;
  onPathRenamed: (oldPath: string, newPath: string) => void;
  onBeforePathAction: (path: string, action: string) => Promise<boolean>;
  selectedFile?: string;
}

interface ContextMenuState {
  x: number;
  y: number;
  entry?: FileEntry;
}

// ── Flat node for virtualized rendering ──────────────────────────────────────

interface FlatNode {
  entry: FileEntry;
  depth: number;
  index: number;
}

const ROW_HEIGHT = 28;
const OVERSCAN = 15;

const getSeparator = (path: string) => (path.includes("\\") ? "\\" : "/");

const getParentPath = (path: string) => {
  const normalized = path.replace(/\\/g, "/");
  const index = normalized.lastIndexOf("/");
  if (index <= 0) return path;
  return path.slice(0, index);
};

const joinPath = (base: string, name: string) => {
  const separator = getSeparator(base);
  return `${base.replace(/[\\/]+$/, "")}${separator}${name}`;
};

const getWorkspaceName = (path: string) => {
  const normalized = path.replace(/[\\/]+$/, "");
  return normalized.split(/[\\/]/).pop() || "No workspace";
};

const countEntries = (entries: FileEntry[]): number =>
  entries.reduce((total, entry) => total + 1 + (entry.children ? countEntries(entry.children) : 0), 0);

// ── Flatten visible tree ─────────────────────────────────────────────────────

function flattenVisibleTree(
  entries: FileEntry[],
  expandedSet: Set<string>,
): FlatNode[] {
  const result: FlatNode[] = [];
  function walk(items: FileEntry[], depth: number) {
    for (const entry of items) {
      result.push({ entry, depth, index: result.length });
      if (entry.is_dir && entry.children && expandedSet.has(entry.path)) {
        walk(entry.children, depth + 1);
      }
    }
  }
  walk(entries, 0);
  return result;
}

// ── VirtualTreeList ──────────────────────────────────────────────────────────

function VirtualTreeList({
  flatNodes,
  selectedFile,
  expandedSet,
  onToggleExpand,
  onFileSelect,
  onContextMenu,
}: {
  flatNodes: FlatNode[];
  selectedFile?: string;
  expandedSet: Set<string>;
  onToggleExpand: (path: string) => void;
  onFileSelect: (path: string) => void;
  onContextMenu: (event: React.MouseEvent, entry: FileEntry) => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [containerHeight, setContainerHeight] = useState(600);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        setContainerHeight(entry.contentRect.height);
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const handleScroll = useCallback((e: React.UIEvent<HTMLDivElement>) => {
    setScrollTop(e.currentTarget.scrollTop);
  }, []);

  const totalHeight = flatNodes.length * ROW_HEIGHT;

  const startIndex = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN);
  const endIndex = Math.min(
    flatNodes.length,
    Math.ceil((scrollTop + containerHeight) / ROW_HEIGHT) + OVERSCAN,
  );

  const visibleNodes = useMemo(
    () => flatNodes.slice(startIndex, endIndex),
    [flatNodes, startIndex, endIndex],
  );

  return (
    <div
      ref={containerRef}
      className="file-tree"
      role="tree"
      aria-label="Project files"
      onScroll={handleScroll}
      style={{ overflowY: "auto", overflowX: "hidden", flex: 1, position: "relative" }}
    >
      <div style={{ height: totalHeight, position: "relative" }}>
        {visibleNodes.map((node) => {
          const { entry, depth, index } = node;
          const isSelected = selectedFile === entry.path;
          const isExpanded = entry.is_dir && expandedSet.has(entry.path);
          const top = index * ROW_HEIGHT;

          return (
            <div
              key={entry.path}
              className={`file-tree-item ${isSelected ? "selected" : ""}`}
              style={{
                position: "absolute",
                top,
                left: 0,
                right: 0,
                height: ROW_HEIGHT,
                paddingLeft: depth * 16 + 8,
              }}
              onClick={() => {
                if (entry.is_dir) {
                  onToggleExpand(entry.path);
                } else {
                  onFileSelect(entry.path);
                }
              }}
              onContextMenu={(event) => onContextMenu(event, entry)}
              data-path={entry.path}
            >
              {/* Chevron for directories */}
              {entry.is_dir ? (
                <span className={`tree-icon chevron-icon ${isExpanded ? "expanded" : ""}`}>
                  <ChevronRight size={14} />
                </span>
              ) : (
                <span className="tree-icon" style={{ width: 14 }} />
              )}
              {/* Folder/File icon */}
              <span className="tree-icon" style={{ display: "flex", alignItems: "center", flexShrink: 0 }}>
                {entry.is_dir ? (
                  <FolderIcon open={isExpanded ?? false} name={entry.name} size={16} />
                ) : (
                  <FileIcon name={entry.name} size={16} />
                )}
              </span>
              {/* Name */}
              <span className="tree-name">{entry.name}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── Main export ───────────────────────────────────────────────────────────────

export default function FileExplorer({
  files,
  projectPath,
  loading,
  onFileSelect,
  onRefresh,
  onPathDeleted,
  onPathRenamed,
  onBeforePathAction,
  selectedFile,
}: Props) {
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [expandedSet, setExpandedSet] = useState<Set<string>>(() => {
    // Auto-expand root-level entries
    const initial = new Set<string>();
    for (const f of files) {
      if (f.is_dir) initial.add(f.path);
    }
    return initial;
  });

  // Re-sync expanded set when files change (e.g. after refresh)
  useEffect(() => {
    setExpandedSet((prev) => {
      const next = new Set<string>();
      for (const f of files) {
        if (f.is_dir && (prev.size === 0 || prev.has(f.path))) {
          next.add(f.path);
        }
      }
      return next;
    });
  }, [files]);

  const handleToggleExpand = useCallback((path: string) => {
    setExpandedSet((prev) => {
      const next = new Set(prev);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
      }
      return next;
    });
  }, []);

  // Flatten only visible nodes
  const flatNodes = useMemo(
    () => flattenVisibleTree(files, expandedSet),
    [files, expandedSet],
  );
  const visibleEntryCount = useMemo(() => countEntries(files), [files]);
  const workspaceName = getWorkspaceName(projectPath);
  const hasWorkspace = Boolean(projectPath && projectPath.trim());

  const closeContextMenu = () => setContextMenu(null);

  const handleContextMenu = (event: React.MouseEvent, entry?: FileEntry) => {
    event.preventDefault();
    event.stopPropagation();
    setContextMenu({ x: event.clientX, y: event.clientY, entry });
  };

  const getActionBasePath = () => {
    const entry = contextMenu?.entry;
    if (!entry) return projectPath;
    return entry.is_dir ? entry.path : getParentPath(entry.path);
  };

  const handleCreateFile = async () => {
    const name = window.prompt("New file name");
    if (!name) return closeContextMenu();
    try {
      const path = joinPath(getActionBasePath(), name);
      await createFile(path);
      onRefresh();
      onFileSelect(path);
    } catch (err) {
      showToast(`Failed to create file: ${err}`, "error");
    } finally {
      closeContextMenu();
    }
  };

  const handleCreateFolder = async () => {
    const name = window.prompt("New folder name");
    if (!name) return closeContextMenu();
    try {
      await createDirectory(joinPath(getActionBasePath(), name));
      onRefresh();
    } catch (err) {
      showToast(`Failed to create folder: ${err}`, "error");
    } finally {
      closeContextMenu();
    }
  };

  const handleRename = async () => {
    const entry = contextMenu?.entry;
    if (!entry) return closeContextMenu();
    const name = window.prompt("New name", entry.name);
    if (!name || name === entry.name) return closeContextMenu();
    if (!(await onBeforePathAction(entry.path, "rename"))) return closeContextMenu();
    try {
      const newPath = joinPath(getParentPath(entry.path), name);
      await renamePath(entry.path, newPath);
      onPathRenamed(entry.path, newPath);
      onRefresh();
    } catch (err) {
      showToast(`Failed to rename: ${err}`, "error");
    } finally {
      closeContextMenu();
    }
  };

  const handleDelete = async () => {
    const entry = contextMenu?.entry;
    if (!entry) return closeContextMenu();
    const confirmed = window.confirm(`Delete "${entry.name}"?`);
    if (!confirmed) return closeContextMenu();
    if (!(await onBeforePathAction(entry.path, "delete"))) return closeContextMenu();
    try {
      await deletePath(entry.path);
      onPathDeleted(entry.path);
      onRefresh();
    } catch (err) {
      showToast(`Failed to delete: ${err}`, "error");
    } finally {
      closeContextMenu();
    }
  };

  const handleReveal = async () => {
    const path = contextMenu?.entry?.path || projectPath;
    try {
      await revealPath(path);
    } catch (err) {
      showToast(`Failed to reveal path: ${err}`, "error");
    } finally {
      closeContextMenu();
    }
  };

  return (
    <div
      className="file-explorer"
      onClick={closeContextMenu}
      onContextMenu={(event) => handleContextMenu(event)}
    >
      <div className="panel-header">
        <span>EXPLORER</span>
      </div>
      <div className="workspace-strip" title={projectPath || "No workspace open"}>
        <span className="workspace-strip-name">{workspaceName}</span>
        <span className="workspace-strip-count">{visibleEntryCount} visible</span>
      </div>

      {loading && files.length === 0 && (
        <div className="file-tree-loading">
          <div className="loading-spinner" />
          <span>Loading files...</span>
        </div>
      )}

      {flatNodes.length > 0 ? (
        <VirtualTreeList
          flatNodes={flatNodes}
          selectedFile={selectedFile}
          expandedSet={expandedSet}
          onToggleExpand={handleToggleExpand}
          onFileSelect={onFileSelect}
          onContextMenu={handleContextMenu}
        />
      ) : !loading ? (
        <div className={`file-tree-empty ${hasWorkspace ? "empty-folder" : "no-workspace"}`}>
          <strong>{hasWorkspace ? "No files found" : "No folder open"}</strong>
          <span>
            {hasWorkspace
              ? "This workspace is empty or the current filter/index has no visible files."
              : "Open a project folder to show files here and give Punam workspace context."}
          </span>
        </div>
      ) : null}

      {contextMenu && (
        <div
          className="context-menu"
          style={{ left: contextMenu.x, top: contextMenu.y }}
          onClick={(event) => event.stopPropagation()}
        >
          <button type="button" onClick={handleCreateFile}>New File</button>
          <button type="button" onClick={handleCreateFolder}>New Folder</button>
          {contextMenu.entry && (
            <>
              <button type="button" onClick={handleRename}>Rename</button>
              <button type="button" onClick={handleDelete}>Delete</button>
              <button type="button" onClick={() => {
                if (contextMenu.entry) navigator.clipboard.writeText(contextMenu.entry.path);
                setContextMenu(null);
              }}>Copy Path</button>
              <button type="button" onClick={() => {
                if (contextMenu.entry && projectPath) {
                  const relative = contextMenu.entry.path
                    .replace(projectPath, "")
                    .replace(/^[\\/]+/, "");
                  navigator.clipboard.writeText(relative);
                }
                setContextMenu(null);
              }}>Copy Relative Path</button>
            </>
          )}
          <button type="button" onClick={handleReveal}>Reveal in Explorer</button>
        </div>
      )}
    </div>
  );
}
