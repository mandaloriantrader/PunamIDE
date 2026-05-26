/**
 * TitleBar — Dedicated title bar with command bar, git branch display,
 * diagnostic count, and panel toggle buttons.
 * Ported from Zenith IDE for Punam IDE.
 */

import {
  FolderOpen, Settings, PanelLeftClose, PanelLeftOpen,
  TerminalSquare, Bot, Search, GitBranch,
  AlertTriangle, Columns2, Command,
} from "lucide-react";

interface Props {
  projectPath: string;
  showSidebar: boolean;
  showTerminal: boolean;
  showAiPanel: boolean;
  gitBranch: string;
  diagnosticCount: number;
  onOpenFolder: () => void;
  onToggleSidebar: () => void;
  onToggleTerminal: () => void;
  onToggleAiPanel: () => void;
  onToggleSplit: () => void;
  onOpenSearch: () => void;
  onOpenGit: () => void;
  onOpenSettings: () => void;
  onOpenCommandPalette: () => void;
  onOpenProblems: () => void;
}

export default function TitleBar({
  projectPath, showSidebar, showTerminal, showAiPanel,
  gitBranch, diagnosticCount,
  onOpenFolder, onToggleSidebar, onToggleTerminal, onToggleAiPanel,
  onToggleSplit, onOpenSearch, onOpenGit, onOpenSettings,
  onOpenCommandPalette, onOpenProblems,
}: Props) {
  const projectName = projectPath ? projectPath.split(/[\\/]/).pop() : "Punam IDE";

  return (
    <div className="titlebar" role="banner">
      <div className="titlebar-left">
        <button className="titlebar-btn" onClick={onOpenFolder} title="Open Folder (Ctrl+O)">
          <FolderOpen size={16} />
        </button>
        <button className="titlebar-btn" onClick={onToggleSidebar} title="Toggle Sidebar (Ctrl+B)">
          {showSidebar ? <PanelLeftClose size={16} /> : <PanelLeftOpen size={16} />}
        </button>
        <div className="titlebar-divider" />
        <button className="titlebar-btn" onClick={onOpenSearch} title="Search (Ctrl+Shift+F)">
          <Search size={16} />
        </button>
        <button className="titlebar-btn" onClick={onOpenGit} title="Git (Ctrl+Shift+G)">
          <GitBranch size={16} />
          {gitBranch && <span className="titlebar-badge">{gitBranch}</span>}
        </button>
        <button className="titlebar-btn" onClick={onToggleSplit} title="Split Editor (Ctrl+\\)">
          <Columns2 size={16} />
        </button>
      </div>

      <div className="titlebar-center">
        <button className="titlebar-command-bar" onClick={onOpenCommandPalette} title="Command Palette (Ctrl+Shift+P)">
          <Command size={12} />
          <span>{projectName} — Command Palette</span>
        </button>
      </div>

      <div className="titlebar-right">
        {diagnosticCount > 0 && (
          <button className="titlebar-btn warning" onClick={onOpenProblems} title={`${diagnosticCount} problems`}>
            <AlertTriangle size={14} />
            <span className="titlebar-count">{diagnosticCount}</span>
          </button>
        )}
        <button className={`titlebar-btn ${showTerminal ? "active" : ""}`} onClick={onToggleTerminal} title="Toggle Terminal (Ctrl+`)">
          <TerminalSquare size={16} />
        </button>
        <button className={`titlebar-btn ${showAiPanel ? "active" : ""}`} onClick={onToggleAiPanel} title="Toggle AI Panel (Ctrl+Shift+A)">
          <Bot size={16} />
        </button>
        <button className="titlebar-btn" onClick={onOpenSettings} title="Settings (Ctrl+,)">
          <Settings size={16} />
        </button>
      </div>
    </div>
  );
}
