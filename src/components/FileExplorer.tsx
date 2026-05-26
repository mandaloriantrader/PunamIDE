import { useState } from "react";
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

// ─── File tree item ────────────────────────────────────────────────────────────

function FileTreeItem({
  entry,
  depth,
  onFileSelect,
  selectedFile,
  onContextMenu,
}: {
  entry: FileEntry;
  depth: number;
  onFileSelect: (path: string) => void;
  selectedFile?: string;
  onContextMenu: (event: React.MouseEvent, entry: FileEntry) => void;
}) {
  const [expanded, setExpanded] = useState(depth < 1);
  const isSelected = selectedFile === entry.path;

  if (entry.is_dir) {
    return (
      <div>
        <div
          className={`file-tree-item ${isSelected ? "selected" : ""}`}
          style={{ paddingLeft: depth * 16 + 8 }}
          onClick={() => setExpanded(!expanded)}
          onContextMenu={(event) => onContextMenu(event, entry)}
        >
          <span className={`tree-icon chevron-icon ${expanded ? "expanded" : ""}`}>
            <ChevronRight size={14} />
          </span>
          <span className="tree-icon" style={{ display: "flex", alignItems: "center" }}>
            <FolderIcon open={expanded} name={entry.name} size={16} />
          </span>
          <span className="tree-name">{entry.name}</span>
        </div>
        {expanded && entry.children && (
          <div className="folder-children expanded">
            {entry.children.map((child) => (
              <FileTreeItem
                key={child.path}
                entry={child}
                depth={depth + 1}
                onFileSelect={onFileSelect}
                selectedFile={selectedFile}
                onContextMenu={onContextMenu}
              />
            ))}
          </div>
        )}
      </div>
    );
  }

  return (
    <div
      className={`file-tree-item ${isSelected ? "selected" : ""}`}
      style={{ paddingLeft: depth * 16 + 8 }}
      onClick={() => onFileSelect(entry.path)}
      onContextMenu={(event) => onContextMenu(event, entry)}
    >
      <span className="tree-icon" style={{ width: 14 }} />
      <span className="tree-icon" style={{ display: "flex", alignItems: "center", flexShrink: 0 }}>
        <FileIcon name={entry.name} size={16} />
      </span>
      <span className="tree-name">{entry.name}</span>
    </div>
  );
}

// ─── Main export ───────────────────────────────────────────────────────────────

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
      <div className="file-tree" role="tree" aria-label="Project files">
        {loading && files.length === 0 && (
          <div className="file-tree-loading">
            <div className="loading-spinner" />
            <span>Loading files...</span>
          </div>
        )}
        {files.map((entry) => (
          <FileTreeItem
            key={entry.path}
            entry={entry}
            depth={0}
            onFileSelect={onFileSelect}
            selectedFile={selectedFile}
            onContextMenu={handleContextMenu}
          />
        ))}
      </div>
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
