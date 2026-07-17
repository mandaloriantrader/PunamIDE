import { useState, useCallback, useMemo, useRef, useEffect, memo } from "react";
import {
  createDirectory,
  createFile,
  deletePath,
  renamePath,
  revealPath,
  readDirectory,
  type FileEntry,
} from "../utils/tauri";
import { showToast } from "../utils/toast";
import { ChevronRight, Loader2 } from "lucide-react";
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

// ── Flatten visible tree (lazy: uses childrenCache instead of entry.children) ─

function flattenVisibleTree(
  rootEntries: FileEntry[],
  expandedSet: Set<string>,
  childrenCache: Map<string, FileEntry[]>,
): FlatNode[] {
  const result: FlatNode[] = [];
  function walk(entries: FileEntry[], depth: number) {
    for (const entry of entries) {
      result.push({ entry, depth, index: result.length });
      if (entry.is_dir && expandedSet.has(entry.path)) {
        const cached = childrenCache.get(entry.path);
        if (cached && cached.length > 0) {
          walk(cached, depth + 1);
        }
      }
    }
  }
  walk(rootEntries, 0);
  return result;
}

// ── VirtualTreeList ──────────────────────────────────────────────────────────

function VirtualTreeList({
  flatNodes,
  selectedFile,
  expandedSet,
  loadingPaths,
  onToggleExpand,
  onFileSelect,
  onContextMenu,
}: {
  flatNodes: FlatNode[];
  selectedFile?: string;
  expandedSet: Set<string>;
  loadingPaths: Set<string>;
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
          const isLoading = loadingPaths.has(entry.path);
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
                isLoading ? (
                  <span className="tree-icon chevron-icon" style={{ display: "flex", alignItems: "center" }}>
                    <Loader2 size={12} style={{ animation: "spin 1s linear infinite" }} />
                  </span>
                ) : (
                  <span className={`tree-icon chevron-icon ${isExpanded ? "expanded" : ""}`}>
                    <ChevronRight size={14} />
                  </span>
                )
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

const FileExplorer = memo(function FileExplorer({
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
    // Auto-expand root-level directories on first load
    const initial = new Set<string>();
    for (const f of files) {
      if (f.is_dir) initial.add(f.path);
    }
    return initial;
  });

  // ── Lazy directory cache — maps directory path → its immediate children ─────
  const [childrenCache, setChildrenCache] = useState<Map<string, FileEntry[]>>(() => new Map());
  const [loadingPaths, setLoadingPaths] = useState<Set<string>>(() => new Set());

  // When files (root entries) change, pre-populate the cache for root and re-expand.
  // Also pre-load children for all auto-expanded directories.
  useEffect(() => {
    if (files.length === 0) return;
    // Populate root-level cache
    setChildrenCache((prev) => {
      const next = new Map(prev);
      next.set(projectPath, files);
      return next;
    });
    setExpandedSet((prev) => {
      const next = new Set<string>();
      for (const f of files) {
        if (f.is_dir && (prev.size === 0 || prev.has(f.path))) {
          next.add(f.path);
        }
      }
      return next;
    });
  }, [files, projectPath]);

  // Pre-load children for all currently-expanded directories that aren't cached yet.
  // This handles both initial load (root-level dirs auto-expanded) and user expand clicks.
  useEffect(() => {
    for (const dirPath of expandedSet) {
      if (childrenCache.has(dirPath) || loadingPaths.has(dirPath)) continue;
      // Load this directory's children
      loadDirectory(dirPath);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [expandedSet]);

  const loadDirectory = useCallback(async (dirPath: string) => {
    setLoadingPaths((prev) => new Set(prev).add(dirPath));
    try {
      const children = await readDirectory(dirPath);
      setChildrenCache((prev) => {
        const next = new Map(prev);
        next.set(dirPath, children);
        return next;
      });
    } catch (err) {
      console.error(`Failed to load directory ${dirPath}:`, err);
    } finally {
      setLoadingPaths((prev) => {
        const next = new Set(prev);
        next.delete(dirPath);
        return next;
      });
    }
  }, []);

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

  // Flatten only visible nodes using the cache
  const flatNodes = useMemo(
    () => flattenVisibleTree(files, expandedSet, childrenCache),
    [files, expandedSet, childrenCache],
  );

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

  // ── Invalidate cache for a path and its children ─────────────────────────────
  const invalidateCacheForPath = useCallback((path: string) => {
    setChildrenCache((prev) => {
      const next = new Map(prev);
      // Remove the directory itself
      next.delete(path);
      // Remove parent directory cache so it reloads next time
      const parent = getParentPath(path);
      next.delete(parent);
      return next;
    });
    // Re-load the parent directory
    const parent = getParentPath(path);
    if (parent && parent !== path) {
      loadDirectory(parent);
    } else {
      // Root-level — trigger a full refresh
      onRefresh();
    }
  }, [loadDirectory, onRefresh]);

  const handleCreateFile = async () => {
    const name = window.prompt("New file name");
    if (!name) return closeContextMenu();
    try {
      const path = joinPath(getActionBasePath(), name);
      await createFile(path);
      invalidateCacheForPath(path);
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
      const path = joinPath(getActionBasePath(), name);
      await createDirectory(path);
      invalidateCacheForPath(path);
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
      invalidateCacheForPath(entry.path);
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
      invalidateCacheForPath(entry.path);
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
        <span className="workspace-strip-count">{flatNodes.length} visible</span>
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
          loadingPaths={loadingPaths}
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
});

export default FileExplorer;
