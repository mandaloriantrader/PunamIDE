import { useEffect, useMemo, useState } from "react";
import {
  FolderOpen, Save, X, RefreshCw, Search, GitBranch, Play,
  Settings, Sun, Moon, Terminal, AlertCircle, Bot, Bug,
  Columns2, ShieldCheck, Undo2, History, FileText,
} from "lucide-react";

export interface CommandAction {
  id: string;
  title: string;
  detail?: string;
  shortcut?: string;
  disabled?: boolean;
  run: () => void;
}

interface Props {
  commands: CommandAction[];
  onClose: () => void;
}

// Map command id prefixes to icons
function getCommandIcon(id: string) {
  if (id === "open-folder")           return <FolderOpen size={14} />;
  if (id === "quick-open")            return <FileText size={14} />;
  if (id === "save-file")             return <Save size={14} />;
  if (id === "close-tab")             return <X size={14} />;
  if (id === "refresh-explorer")      return <RefreshCw size={14} />;
  if (id === "project-search")        return <Search size={14} />;
  if (id === "git-changes")           return <GitBranch size={14} />;
  if (id.startsWith("run-profile") || id === "run-project-check") return <Play size={14} />;
  if (id === "manage-run-profiles")   return <Settings size={14} />;
  if (id === "toggle-sidebar")        return <FolderOpen size={14} />;
  if (id === "toggle-ai")             return <Bot size={14} />;
  if (id === "toggle-terminal")       return <Terminal size={14} />;
  if (id === "toggle-problems")       return <AlertCircle size={14} />;
  if (id === "open-settings")         return <Settings size={14} />;
  if (id === "toggle-theme")          return <Sun size={14} />;
  if (id === "undo-last-apply")       return <Undo2 size={14} />;
  if (id === "checkpoint-history")    return <History size={14} />;
  if (id === "toggle-split")          return <Columns2 size={14} />;
  if (id === "code-review")           return <ShieldCheck size={14} />;
  if (id.includes("bug"))             return <Bug size={14} />;
  if (id.includes("theme"))           return <Moon size={14} />;
  return <FileText size={14} />;
}

export default function CommandPalette({ commands, onClose }: Props) {
  const [query, setQuery] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);

  const filteredCommands = useMemo(() => {
    const q = query.trim().toLowerCase();
    const available = commands.filter((c) => !c.disabled);
    if (!q) return available;
    return available.filter((c) => `${c.title} ${c.detail || ""}`.toLowerCase().includes(q));
  }, [commands, query]);

  useEffect(() => setSelectedIndex(0), [query]);

  const runCommand = (command: CommandAction) => { command.run(); onClose(); };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Escape") { e.preventDefault(); onClose(); return; }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setSelectedIndex((i) => filteredCommands.length === 0 ? 0 : (i + 1) % filteredCommands.length);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSelectedIndex((i) => filteredCommands.length === 0 ? 0 : (i - 1 + filteredCommands.length) % filteredCommands.length);
    } else if (e.key === "Enter" && filteredCommands[selectedIndex]) {
      e.preventDefault();
      runCommand(filteredCommands[selectedIndex]);
    }
  };

  return (
    <div className="command-palette-overlay" onMouseDown={onClose}>
      <div className="command-palette" role="dialog" aria-label="Command palette" onMouseDown={(e) => e.stopPropagation()}>
        <div className="cp-input-row">
          <Search size={14} className="cp-search-icon" />
          <input
            autoFocus
            className="command-palette-input"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Type a command…"
            aria-label="Command search"
          />
          {query && (
            <button className="cp-clear" onClick={() => setQuery("")} aria-label="Clear">
              <X size={12} />
            </button>
          )}
        </div>

        <div className="command-palette-list" role="listbox">
          {filteredCommands.length > 0 ? (
            filteredCommands.map((cmd, index) => (
              <button
                key={cmd.id}
                type="button"
                className={`command-palette-item ${index === selectedIndex ? "selected" : ""}`}
                onMouseEnter={() => setSelectedIndex(index)}
                onClick={() => runCommand(cmd)}
                role="option"
                aria-selected={index === selectedIndex}
              >
                <span className="cp-item-icon">{getCommandIcon(cmd.id)}</span>
                <span className="command-palette-text">
                  <span className="command-palette-title">{cmd.title}</span>
                  {cmd.detail && <span className="command-palette-detail">{cmd.detail}</span>}
                </span>
                {cmd.shortcut && <span className="command-palette-shortcut">{cmd.shortcut}</span>}
              </button>
            ))
          ) : (
            <div className="command-palette-empty">No commands match "{query}"</div>
          )}
        </div>

        <div className="cp-footer">
          <span><kbd>↑↓</kbd> navigate</span>
          <span><kbd>Enter</kbd> run</span>
          <span><kbd>Esc</kbd> close</span>
        </div>
      </div>
    </div>
  );
}
