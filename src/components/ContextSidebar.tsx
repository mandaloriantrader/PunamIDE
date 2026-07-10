/**
 * ContextSidebar — Displays the AI's working context: callers, callees,
 * related files, diagnostics, and token budget status.
 *
 * Each item is clickable (navigates to source) and pinnable (pinned items are
 * exempt from per-section truncation caps). The token budget section shows
 * consumed vs. remaining from `aiStore.tokenBudgetStatus`.
 *
 * @see Requirements 16.1, 16.2, 16.3, 16.4, 16.5, 16.6
 */

import { useState, useMemo, useCallback } from "react";
import {
  ChevronDown,
  ChevronRight,
  Pin,
  PinOff,
  PhoneIncoming,
  PhoneOutgoing,
  FileText,
  AlertCircle,
  Gauge,
} from "lucide-react";
import { useEditorStore } from "../store/editorStore";
import { useAIStore } from "../store/aiStore";
import {
  ContextSidebarModel,
  type ContextItem,
  type ContextItemKind,
  DEFAULT_SIDEBAR_CAPS,
} from "../services/context/ContextSidebarModel";

// ---------------------------------------------------------------------------
// Singleton model instance (created once, shared across renders).
// Refresh calls are wired externally (task 29.3).
// ---------------------------------------------------------------------------

const sidebarModel = new ContextSidebarModel();

// ---------------------------------------------------------------------------
// Section configuration
// ---------------------------------------------------------------------------

interface SectionConfig {
  kind: ContextItemKind;
  title: string;
  icon: React.ReactNode;
}

const SECTIONS: SectionConfig[] = [
  { kind: "caller", title: "Callers", icon: <PhoneIncoming size={14} /> },
  { kind: "callee", title: "Callees", icon: <PhoneOutgoing size={14} /> },
  { kind: "related_file", title: "Related Files", icon: <FileText size={14} /> },
  { kind: "diagnostic", title: "Diagnostics", icon: <AlertCircle size={14} /> },
];

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

interface ContextItemRowProps {
  item: ContextItem;
  onNavigate: (filePath: string, line: number) => void;
  onTogglePin: (itemId: string) => void;
}

function ContextItemRow({ item, onNavigate, onTogglePin }: ContextItemRowProps) {
  const handleClick = () => {
    if (item.location) {
      onNavigate(item.location.filePath, item.location.line);
    }
  };

  const handlePin = (e: React.MouseEvent) => {
    e.stopPropagation();
    onTogglePin(item.id);
  };

  return (
    <div
      className={`context-sidebar-item ${item.pinned ? "context-sidebar-item--pinned" : ""}`}
      role="button"
      tabIndex={0}
      aria-label={`${item.label}${item.pinned ? " (pinned)" : ""}`}
      onClick={handleClick}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          handleClick();
        }
      }}
    >
      <span className="context-sidebar-item-label" title={item.label}>
        {item.label}
      </span>
      {item.location && (
        <span className="context-sidebar-item-location">
          :{item.location.line}
        </span>
      )}
      <button
        className={`context-sidebar-pin-btn ${item.pinned ? "context-sidebar-pin-btn--active" : ""}`}
        onClick={handlePin}
        type="button"
        aria-label={item.pinned ? `Unpin ${item.label}` : `Pin ${item.label}`}
        title={item.pinned ? "Unpin" : "Pin"}
      >
        {item.pinned ? <Pin size={12} /> : <PinOff size={12} />}
      </button>
    </div>
  );
}

interface CollapsibleSectionProps {
  title: string;
  icon: React.ReactNode;
  count: number;
  children: React.ReactNode;
}

function CollapsibleSection({ title, icon, count, children }: CollapsibleSectionProps) {
  const [collapsed, setCollapsed] = useState(false);

  return (
    <div className="context-sidebar-section" role="region" aria-label={title}>
      <button
        className="context-sidebar-section-header"
        onClick={() => setCollapsed(!collapsed)}
        type="button"
        aria-expanded={!collapsed}
      >
        {collapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
        {icon}
        <span className="context-sidebar-section-title">{title}</span>
        <span className="context-sidebar-section-count">{count}</span>
      </button>
      {!collapsed && (
        <div className="context-sidebar-section-body">{children}</div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export interface ContextSidebarProps {
  /** Externally-provided items (for testing or overrides). Falls back to model state. */
  items?: ContextItem[];
}

export default function ContextSidebar({ items: externalItems }: ContextSidebarProps) {
  const openTab = useEditorStore((s) => s.openTab);
  const setCursorPosition = useEditorStore((s) => s.setCursorPosition);
  const tokenBudgetStatus = useAIStore((s) => s.tokenBudgetStatus);

  // Use external items when provided (testing), otherwise model state.
  const state = sidebarModel.getState();
  const rawItems = externalItems ?? state.items;

  // Apply selectVisible to respect per-section caps.
  const visibleItems = useMemo(
    () => sidebarModel.selectVisible(rawItems, DEFAULT_SIDEBAR_CAPS),
    [rawItems]
  );

  // Group items by kind for rendering.
  const grouped = useMemo(() => {
    const map: Record<ContextItemKind, ContextItem[]> = {
      caller: [],
      callee: [],
      related_file: [],
      diagnostic: [],
    };
    for (const item of visibleItems) {
      map[item.kind].push(item);
    }
    return map;
  }, [visibleItems]);

  // Navigation: open tab and set cursor position.
  const handleNavigate = useCallback(
    (filePath: string, line: number) => {
      const fileName = filePath.replace(/\\/g, "/").split("/").pop() || filePath;
      openTab({
        id: filePath,
        path: filePath,
        name: fileName,
        content: "",
        originalContent: "",
        modified: false,
        language: "",
      });
      setCursorPosition(line, 1);
    },
    [openTab, setCursorPosition]
  );

  // Pin toggling (force re-render via local state bump).
  const [, forceUpdate] = useState(0);
  const handleTogglePin = useCallback(
    (itemId: string) => {
      sidebarModel.togglePin(itemId);
      forceUpdate((n) => n + 1);
    },
    []
  );

  // Token budget display values.
  const budgetUsed = tokenBudgetStatus
    ? tokenBudgetStatus.used.systemPrompt +
      tokenBudgetStatus.used.userMessage +
      tokenBudgetStatus.used.codeContext +
      tokenBudgetStatus.used.conversationHistory
    : 0;
  const budgetTotal = tokenBudgetStatus?.allocation.totalAvailable ?? 0;
  const budgetPercent = tokenBudgetStatus?.percentUsed ?? 0;

  return (
    <div className="context-sidebar" role="complementary" aria-label="AI Context Sidebar">
      {/* Item sections */}
      {SECTIONS.map((section) => (
        <CollapsibleSection
          key={section.kind}
          title={section.title}
          icon={section.icon}
          count={grouped[section.kind].length}
        >
          {grouped[section.kind].length === 0 ? (
            <p className="context-sidebar-empty">No {section.title.toLowerCase()} found.</p>
          ) : (
            grouped[section.kind].map((item) => (
              <ContextItemRow
                key={item.id}
                item={item}
                onNavigate={handleNavigate}
                onTogglePin={handleTogglePin}
              />
            ))
          )}
        </CollapsibleSection>
      ))}

      {/* Token Budget section */}
      <div className="context-sidebar-section" role="region" aria-label="Token Budget">
        <div className="context-sidebar-section-header context-sidebar-section-header--static">
          <Gauge size={14} />
          <span className="context-sidebar-section-title">Token Budget</span>
        </div>
        <div className="context-sidebar-section-body">
          {tokenBudgetStatus ? (
            <div className="context-sidebar-budget">
              <div className="context-sidebar-budget-bar" role="progressbar" aria-valuenow={budgetPercent} aria-valuemin={0} aria-valuemax={100}>
                <div
                  className={`context-sidebar-budget-fill ${tokenBudgetStatus.overBudget ? "context-sidebar-budget-fill--over" : ""}`}
                  style={{ width: `${Math.min(100, budgetPercent)}%` }}
                />
              </div>
              <span className="context-sidebar-budget-text">
                {budgetUsed.toLocaleString()} / {budgetTotal.toLocaleString()} tokens used
              </span>
              {tokenBudgetStatus.overBudget && (
                <span className="context-sidebar-budget-warning">Over budget</span>
              )}
            </div>
          ) : (
            <p className="context-sidebar-empty">No budget data available.</p>
          )}
        </div>
      </div>
    </div>
  );
}

/** Expose the shared model instance for external wiring (task 29.3). */
export { sidebarModel };
