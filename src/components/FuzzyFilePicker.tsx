/**
 * FuzzyFilePicker — Cursor/VS Code style Ctrl+P quick file open.
 * Fuzzy-scores all project files and opens on Enter.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { FileText, Search } from "lucide-react";
import type { FileEntry } from "../utils/tauri";

interface Props {
  files: FileEntry[];
  recentPaths?: string[];
  onSelect: (relativePath: string) => void;
  onClose: () => void;
}

// ── Flatten the file tree into relative paths ─────────────────────────────────
function flattenFiles(entries: FileEntry[], prefix = ""): string[] {
  const result: string[] = [];
  for (const entry of entries) {
    const p = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.is_dir) {
      if (entry.children) result.push(...flattenFiles(entry.children, p));
    } else {
      result.push(p);
    }
  }
  return result;
}

// ── Fuzzy score ───────────────────────────────────────────────────────────────
function fuzzyScore(query: string, path: string): number {
  if (!query) return 500; // show all when empty, stable order
  const lq = query.toLowerCase();
  const lp = path.toLowerCase();
  const filename = lp.split("/").pop() || lp;

  if (lp === lq) return 10000;
  if (filename === lq) return 9000;
  if (filename.startsWith(lq)) return 8000;
  if (lp.startsWith(lq)) return 7500;
  if (filename.includes(lq)) return 7000;
  if (lp.includes(lq)) return 6000;

  // All characters in order (fuzzy)
  let qi = 0;
  let score = 0;
  let lastIdx = -1;
  for (let i = 0; i < lp.length && qi < lq.length; i++) {
    if (lp[i] === lq[qi]) {
      score += 10 + (i - lastIdx === 1 ? 8 : 0); // consecutive bonus
      lastIdx = i;
      qi++;
    }
  }
  if (qi < lq.length) return 0; // not all chars matched

  // Extra bonus when filename matches all chars too
  let fqi = 0;
  for (const ch of filename) {
    if (ch === lq[fqi]) fqi++;
    if (fqi === lq.length) { score += 40; break; }
  }
  return score;
}

// ── Highlight matching characters ─────────────────────────────────────────────
function HighlightMatch({ text, query }: { text: string; query: string }) {
  if (!query.trim()) return <>{text}</>;
  const lq = query.toLowerCase();
  const lt = text.toLowerCase();
  const nodes: React.ReactNode[] = [];
  let qi = 0;
  for (let i = 0; i < text.length; i++) {
    if (qi < lq.length && lt[i] === lq[qi]) {
      nodes.push(<mark key={i}>{text[i]}</mark>);
      qi++;
    } else {
      nodes.push(text[i]);
    }
  }
  return <>{nodes}</>;
}

// ── File icon (simple extension-based) ───────────────────────────────────────
function fileColor(name: string): string {
  const ext = name.split(".").pop()?.toLowerCase() || "";
  if (["ts", "tsx"].includes(ext)) return "#3b9edd";
  if (["js", "jsx", "mjs"].includes(ext)) return "#f7df1e";
  if (["json"].includes(ext)) return "#fbc02d";
  if (["css", "scss"].includes(ext)) return "#42a5f5";
  if (["html"].includes(ext)) return "#e34c26";
  if (["rs"].includes(ext)) return "#ce422b";
  if (["py"].includes(ext)) return "#4584b6";
  if (["go"].includes(ext)) return "#00acd7";
  if (["md"].includes(ext)) return "#888";
  return "#7e8ba0";
}

export default function FuzzyFilePicker({ files, recentPaths = [], onSelect, onClose }: Props) {
  const [query, setQuery] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const allPaths = useMemo(() => flattenFiles(files), [files]);

  const results = useMemo(() => {
    const scored = allPaths
      .map((p) => ({ path: p, score: fuzzyScore(query, p) }))
      .filter((x) => x.score > 0);

    scored.sort((a, b) => {
      // Recent files always first when no query
      if (!query.trim()) {
        const aRecent = recentPaths.indexOf(a.path);
        const bRecent = recentPaths.indexOf(b.path);
        if (aRecent !== -1 && bRecent !== -1) return aRecent - bRecent;
        if (aRecent !== -1) return -1;
        if (bRecent !== -1) return 1;
      }
      return b.score - a.score;
    });

    return scored.slice(0, 60).map((x) => x.path);
  }, [allPaths, query, recentPaths]);

  // Reset selection on query change
  useEffect(() => { setSelectedIndex(0); }, [query]);

  // Auto-focus
  useEffect(() => { inputRef.current?.focus(); }, []);

  // Scroll selected item into view
  useEffect(() => {
    const el = listRef.current?.children[selectedIndex] as HTMLElement | undefined;
    el?.scrollIntoView({ block: "nearest" });
  }, [selectedIndex]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") { e.preventDefault(); onClose(); return; }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setSelectedIndex((i) => Math.min(i + 1, results.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSelectedIndex((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (results[selectedIndex]) onSelect(results[selectedIndex]);
    }
  };

  return (
    <div className="fp-overlay" onMouseDown={onClose}>
      <div className="fp-modal" onMouseDown={(e) => e.stopPropagation()}>
        {/* Search input */}
        <div className="fp-input-row">
          <Search size={14} className="fp-search-icon" />
          <input
            ref={inputRef}
            className="fp-input"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Type to search files…"
            aria-label="Quick file open"
            spellCheck={false}
          />
          <span className="fp-count">{results.length} of {allPaths.length}</span>
        </div>

        {/* Results */}
        <div className="fp-list" ref={listRef} role="listbox">
          {results.length === 0 && (
            <div className="fp-empty">No files match "{query}"</div>
          )}
          {results.map((path, i) => {
            const parts = path.split("/");
            const filename = parts.pop() || path;
            const dir = parts.join("/");
            return (
              <div
                key={path}
                role="option"
                aria-selected={i === selectedIndex}
                className={`fp-item ${i === selectedIndex ? "selected" : ""}`}
                onMouseEnter={() => setSelectedIndex(i)}
                onClick={() => onSelect(path)}
              >
                <FileText size={13} style={{ color: fileColor(filename), flexShrink: 0 }} />
                <span className="fp-item-name">
                  <HighlightMatch text={filename} query={query} />
                </span>
                {dir && (
                  <span className="fp-item-dir">
                    <HighlightMatch text={dir} query={query} />
                  </span>
                )}
                {!query && recentPaths.includes(path) && (
                  <span className="fp-recent-badge">recent</span>
                )}
              </div>
            );
          })}
        </div>

        <div className="fp-hint">
          <span><kbd>↑↓</kbd> navigate</span>
          <span><kbd>Enter</kbd> open</span>
          <span><kbd>Esc</kbd> close</span>
        </div>
      </div>
    </div>
  );
}
