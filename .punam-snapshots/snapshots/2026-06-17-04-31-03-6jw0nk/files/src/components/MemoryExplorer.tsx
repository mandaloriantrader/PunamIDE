/**
 * MemoryExplorer.tsx — Project Memory Explorer UI (Phase 2, Step 2.7)
 *
 * Timeline view, type filters, search, and decision browser for the
 * Long-Term Project Memory System.
 */
import { useState, useEffect, useCallback } from "react";
import {
  Brain,
  Search,
  Clock,
  AlertTriangle,
  Lightbulb,
  RefreshCw,
  Trash2,
  Plus,
  ChevronDown,
  ChevronRight,
} from "lucide-react";
import { useMemoryStore } from "../stores/memoryStore";
import {
  memoryDelete,
  memoryInit,
  getMemoryTypeLabel,
  getSeverityColor,
  formatMemoryDate,
} from "../services/memory/MemoryManager";
import type { MemoryEntry } from "../services/memory/MemoryManager";

// ── Component ─────────────────────────────────────────────────────────────────

export default function MemoryExplorer() {
  const {
    entries,
    timeline,
    fileMemories,
    loading,
    searchQuery,
    searchResults,
    aiContext,
    loadEntries,
    loadTimeline,
    loadFileMemories,
    searchMemories,
    addMemory,
    buildAiContext,
    setSearchQuery,
  } = useMemoryStore();

  const [activeTab, setActiveTab] = useState<"timeline" | "search" | "decisions" | "bugs" | "conventions">("timeline");
  const [showAddForm, setShowAddForm] = useState(false);
  const [newTitle, setNewTitle] = useState("");
  const [newDescription, setNewDescription] = useState("");
  const [newType, setNewType] = useState<string>("convention");
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  // Init memory DB on mount
  useEffect(() => {
    memoryInit().catch(() => {});
  }, []);

  // Load data when tab changes
  useEffect(() => {
    if (activeTab === "timeline") loadTimeline();
    else if (activeTab === "decisions") loadEntries("architectural_decision");
    else if (activeTab === "bugs") loadEntries("bug_resolution");
    else if (activeTab === "conventions") loadEntries("convention");
  }, [activeTab]);

  const handleSearch = () => {
    if (searchQuery.trim()) {
      searchMemories(searchQuery);
    }
  };

  const handleAdd = async () => {
    if (!newTitle.trim()) return;
    await addMemory(newType, newTitle, newDescription);
    setNewTitle("");
    setNewDescription("");
    setShowAddForm(false);
    // Refresh current tab
    if (activeTab === "timeline") loadTimeline();
    else if (activeTab === "decisions") loadEntries("architectural_decision");
    else if (activeTab === "bugs") loadEntries("bug_resolution");
    else if (activeTab === "conventions") loadEntries("convention");
  };

  const handleDelete = async (id: string) => {
    await memoryDelete(id).catch(() => {});
    if (activeTab === "timeline") loadTimeline();
    else if (activeTab === "decisions") loadEntries("architectural_decision");
    else if (activeTab === "bugs") loadEntries("bug_resolution");
    else if (activeTab === "conventions") loadEntries("convention");
  };

  const toggleExpand = (id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const displayEntries = activeTab === "search" ? searchResults
    : activeTab === "timeline" ? timeline
    : entries;

  return (
    <div className="flex flex-col h-full bg-[#1e1e2e] text-gray-200">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-gray-700">
        <div className="flex items-center gap-2">
          <Brain size={18} className="text-purple-400" />
          <span className="font-semibold text-sm">Project Memory</span>
        </div>
        <button
          onClick={() => setShowAddForm(!showAddForm)}
          className="p-1.5 rounded hover:bg-gray-700 transition-colors"
          title="Add memory"
        >
          <Plus size={16} />
        </button>
      </div>

      {/* Add Form */}
      {showAddForm && (
        <div className="px-4 py-3 border-b border-gray-700 bg-[#252540]">
          <select
            value={newType}
            onChange={(e) => setNewType(e.target.value)}
            className="w-full mb-2 px-2 py-1 bg-[#1e1e2e] border border-gray-600 rounded text-sm"
          >
            <option value="convention">Convention</option>
            <option value="architectural_decision">Architectural Decision</option>
            <option value="bug_resolution">Bug Fix</option>
            <option value="refactor">Refactor</option>
          </select>
          <input
            value={newTitle}
            onChange={(e) => setNewTitle(e.target.value)}
            placeholder="Title..."
            className="w-full mb-2 px-2 py-1 bg-[#1e1e2e] border border-gray-600 rounded text-sm"
          />
          <textarea
            value={newDescription}
            onChange={(e) => setNewDescription(e.target.value)}
            placeholder="Description..."
            rows={2}
            className="w-full mb-2 px-2 py-1 bg-[#1e1e2e] border border-gray-600 rounded text-sm resize-none"
          />
          <div className="flex gap-2">
            <button
              onClick={handleAdd}
              disabled={!newTitle.trim()}
              className="px-3 py-1 bg-purple-600 hover:bg-purple-700 disabled:opacity-50 rounded text-sm text-white"
            >
              Save
            </button>
            <button
              onClick={() => setShowAddForm(false)}
              className="px-3 py-1 bg-gray-600 hover:bg-gray-500 rounded text-sm"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Search Bar */}
      <div className="px-4 py-2 border-b border-gray-700">
        <div className="flex gap-2">
          <div className="flex-1 relative">
            <Search size={14} className="absolute left-2 top-1/2 -translate-y-1/2 text-gray-500" />
            <input
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleSearch()}
              placeholder="Search memory..."
              className="w-full pl-7 pr-2 py-1 bg-[#252540] border border-gray-600 rounded text-sm text-gray-200 placeholder-gray-500 focus:outline-none focus:border-purple-500"
            />
          </div>
          <button
            onClick={handleSearch}
            className="px-2 py-1 bg-purple-600 hover:bg-purple-700 rounded text-sm"
          >
            Search
          </button>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 px-4 py-2 border-b border-gray-700 overflow-x-auto">
        {(
          [
            ["timeline", "Timeline", Clock],
            ["decisions", "Decisions", Lightbulb],
            ["bugs", "Bugs", AlertTriangle],
            ["conventions", "Conventions", RefreshCw],
          ] as const
        ).map(([id, label, Icon]) => (
          <button
            key={id}
            onClick={() => setActiveTab(id)}
            className={`flex items-center gap-1 px-3 py-1 rounded text-xs font-medium transition-colors ${
              activeTab === id
                ? "bg-purple-600 text-white"
                : "bg-[#252540] text-gray-400 hover:bg-gray-700"
            }`}
          >
            <Icon size={12} />
            {label}
          </button>
        ))}
      </div>

      {/* Entries List */}
      <div className="flex-1 overflow-y-auto px-2 py-2 space-y-1">
        {loading && (
          <div className="text-center text-gray-500 py-8 text-sm">Loading...</div>
        )}

        {!loading && displayEntries.length === 0 && (
          <div className="text-center text-gray-600 py-8 text-sm">
            No memories yet. Add one to help the AI remember.
          </div>
        )}

        {!loading &&
          displayEntries.map((entry) => (
            <MemoryCard
              key={entry.id}
              entry={entry}
              expanded={expanded.has(entry.id)}
              onToggle={() => toggleExpand(entry.id)}
              onDelete={() => handleDelete(entry.id)}
            />
          ))}
      </div>

      {/* AI Context Preview */}
      {aiContext && (
        <div className="border-t border-gray-700 px-4 py-2 max-h-32 overflow-y-auto">
          <div className="text-xs text-gray-500 mb-1">AI Context (auto-injected)</div>
          <pre className="text-xs text-gray-400 whitespace-pre-wrap">{aiContext.slice(0, 500)}</pre>
        </div>
      )}
    </div>
  );
}

// ── Memory Card ───────────────────────────────────────────────────────────────

function MemoryCard({
  entry,
  expanded,
  onToggle,
  onDelete,
}: {
  entry: MemoryEntry;
  expanded: boolean;
  onToggle: () => void;
  onDelete: () => void;
}) {
  const typeLabel = getMemoryTypeLabel(entry.memory_type);
  const severityColor = getSeverityColor(entry.severity);

  return (
    <div className="bg-[#252540] rounded border border-gray-700/50 hover:border-gray-600 transition-colors">
      <div
        className="flex items-start gap-2 px-3 py-2 cursor-pointer"
        onClick={onToggle}
      >
        {expanded ? (
          <ChevronDown size={14} className="mt-0.5 text-gray-500 flex-shrink-0" />
        ) : (
          <ChevronRight size={14} className="mt-0.5 text-gray-500 flex-shrink-0" />
        )}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-xs font-medium text-gray-400 bg-[#1e1e2e] px-1.5 py-0.5 rounded">
              {typeLabel}
            </span>
            {entry.severity !== "medium" && (
              <span
                className="text-xs px-1.5 py-0.5 rounded"
                style={{ backgroundColor: severityColor + "20", color: severityColor }}
              >
                {entry.severity}
              </span>
            )}
          </div>
          <div className="text-sm text-gray-200 mt-0.5 truncate">{entry.title}</div>
          <div className="text-xs text-gray-500 mt-0.5">
            {formatMemoryDate(entry.created_at)}
          </div>
        </div>
        <button
          onClick={(e) => {
            e.stopPropagation();
            onDelete();
          }}
          className="p-1 rounded hover:bg-red-900/30 text-gray-600 hover:text-red-400 transition-colors flex-shrink-0"
          title="Delete"
        >
          <Trash2 size={12} />
        </button>
      </div>
      {expanded && (
        <div className="px-3 pb-3 pt-0 border-t border-gray-700/30">
          <p className="text-sm text-gray-300 whitespace-pre-wrap mt-2">
            {entry.description || "(no description)"}
          </p>
          {entry.tags.length > 0 && (
            <div className="flex gap-1 mt-2 flex-wrap">
              {entry.tags.map((tag) => (
                <span
                  key={tag}
                  className="text-xs bg-purple-900/30 text-purple-300 px-1.5 py-0.5 rounded"
                >
                  {tag}
                </span>
              ))}
            </div>
          )}
          {entry.files_involved.length > 0 && (
            <div className="mt-2">
              <div className="text-xs text-gray-500 mb-1">Files:</div>
              {entry.files_involved.slice(0, 5).map((f) => (
                <div
                  key={f}
                  className="text-xs text-gray-400 font-mono truncate"
                >
                  {f}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}