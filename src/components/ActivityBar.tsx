/**
 * ActivityBar — VS Code–style narrow left icon strip.
 * Controls which sidebar view is active.
 */

import {
  Files, Search, GitBranch, Bot,
  Settings, Keyboard, Play,
  Box, StickyNote, Github,
} from "lucide-react";

export type ActivityView =
  | "explorer"
  | "search"
  | "git"
  | "run"
  | "ai"
  | "docker"
  | "notepads"
  | "github"
  | null;

interface ActivityItem {
  id: ActivityView;
  icon: React.ReactNode;
  label: string;
  badge?: number;
}

interface Props {
  active: ActivityView;
  onSelect: (view: ActivityView) => void;
  onSettings: () => void;
  onShortcuts: () => void;
  problemsBadge?: number;
  gitBadge?: number;
}

export default function ActivityBar({
  active, onSelect, onSettings, onShortcuts, gitBadge = 0,
}: Props) {
  const items: ActivityItem[] = [
    { id: "explorer", icon: <Files size={22} />,   label: "Explorer (Ctrl+Shift+E)" },
    { id: "search",   icon: <Search size={22} />,  label: "Search (Ctrl+Shift+F)" },
    { id: "git",      icon: <GitBranch size={22} />, label: "Source Control (Ctrl+Shift+G)", badge: gitBadge || undefined },
    { id: "run",      icon: <Play size={22} />,    label: "Run & Debug" },
    { id: "ai",       icon: <Bot size={22} />,     label: "Punam AI" },
    { id: "docker",   icon: <Box size={22} />,     label: "Docker" },
    { id: "notepads", icon: <StickyNote size={22} />, label: "Notepads" },
    { id: "github",   icon: <Github size={22} />,  label: "GitHub (Ctrl+Shift+H)" },
  ];

  return (
    <div className="activity-bar" role="navigation" aria-label="Activity bar">
      {/* Top items */}
      <div className="activity-bar-top">
        {items.map((item) => (
          <button
            key={item.id}
            className={`activity-btn ${active === item.id ? "active" : ""}`}
            onClick={() => onSelect(active === item.id ? null : item.id)}
            title={item.label}
            aria-label={item.label}
            aria-pressed={active === item.id}
          >
            {item.icon}
            {item.badge !== undefined && item.badge > 0 && (
              <span className="activity-badge">{item.badge > 99 ? "99+" : item.badge}</span>
            )}
          </button>
        ))}
      </div>

      {/* Bottom items */}
      <div className="activity-bar-bottom">
        <button
          className="activity-btn"
          onClick={onShortcuts}
          title="Keyboard Shortcuts"
          aria-label="Keyboard shortcuts"
        >
          <Keyboard size={22} />
        </button>
        <button
          className="activity-btn"
          onClick={onSettings}
          title="Settings (Ctrl+,)"
          aria-label="Open settings"
        >
          <Settings size={22} />
        </button>
      </div>
    </div>
  );
}
