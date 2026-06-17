/**
 * FindReplace — project-wide find and replace.
 * Uses the existing searchProject tauri command for search,
 * then reads+writes each matching file for replace.
 */

import { useState, useRef, useCallback, useEffect } from "react";
import {
  Search, RefreshCw, X, ChevronDown, ChevronRight,
  Replace, CheckCheck, AlertTriangle,
} from "lucide-react";
import { searchProject, readFile, writeFile } from "../utils/tauri";
import type { SearchResult } from "../utils/tauri";

interface GroupedResult {
  path: string;
  matches: SearchResult[];
}

interface Props {
  projectPath: string;
  onOpenResult: (result: SearchResult) => void;
  onClose: () => void;
}

export default function FindReplace({ projectPath, onOpenResult, onClose }: Props) {
  const [query, setQuery] = useState("");
  const [replaceText, setReplaceText] = useState("");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [replacing, setReplacing] = useState(false);
  const [replaceMode, setReplaceMode] = useState(false);
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [wholeWord, setWholeWord] = useState(false);
  const [useRegex, setUseRegex] = useState(false);
  const [expandedFiles, setExpandedFiles] = useState<Set<string>>(new Set());
  const [replaced, setReplaced] = useState<{ count: number; files: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => { searchRef.current?.focus(); }, []);

  // Debounced search
  useEffect(() => {
    if (!query.trim() || !projectPath) { setResults([]); return; }
    let cancelled = false;
    setError(null);
    const timer = window.setTimeout(async () => {
      setSearching(true);
      try {
        const raw = await searchProject(query);
        if (cancelled) return;
        let filtered = raw;
        if (caseSensitive) {
          filtered = raw.filter(r => r.preview.includes(query));
        }
        if (wholeWord) {
          const wb = new RegExp(`\\b${query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, caseSensitive ? "" : "i");
          filtered = raw.filter(r => wb.test(r.preview));
        }
        if (!cancelled) {
          setResults(filtered);
          // Auto-expand first 3 files
          const first3 = [...new Set(filtered.slice(0, 30).map(r => r.path))].slice(0, 3);
          setExpandedFiles(new Set(first3));
        }
      } catch (err) {
        if (!cancelled) setError(String(err));
      } finally {
        if (!cancelled) setSearching(false);
      }
    }, 300);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [query, caseSensitive, wholeWord, useRegex, projectPath]);

  // Group results by file
  const grouped: GroupedResult[] = [];
  const seen = new Map<string, GroupedResult>();
  for (const r of results) {
    if (!seen.has(r.path)) {
      const g: GroupedResult = { path: r.path, matches: [] };
      grouped.push(g);
      seen.set(r.path, g);
    }
    seen.get(r.path)!.matches.push(r);
  }

  const toggleFile = (path: string) => {
    setExpandedFiles(prev => {
      const next = new Set(prev);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
      }
      return next;
    });
  };

  const totalMatches = results.length;
  const totalFiles = grouped.length;

  // Replace all
  const handleReplaceAll = useCallback(async () => {
    if (!query.trim() || results.length === 0) return;
    setReplacing(true);
    setReplaced(null);
    setError(null);
    let totalReplaced = 0;
    let filesChanged = 0;
    try {
      for (const group of grouped) {
        const fullPath = group.path.startsWith(projectPath)
          ? group.path
          : `${projectPath.replace(/[\\/]+$/, "")}/${group.path.replace(/^[\\/]+/, "")}`;
        const content = await readFile(fullPath).catch(() => null);
        if (content === null) continue;

        let newContent: string;
        if (useRegex) {
          try {
            const flags = caseSensitive ? "g" : "gi";
            const re = new RegExp(query, flags);
            const count = (content.match(re) || []).length;
            newContent = content.replace(re, replaceText);
            totalReplaced += count;
          } catch { continue; }
        } else {
          const flags = caseSensitive ? "g" : "gi";
          const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
          const pattern = wholeWord ? `\\b${escaped}\\b` : escaped;
          const re = new RegExp(pattern, flags);
          const count = (content.match(re) || []).length;
          newContent = content.replace(re, replaceText);
          totalReplaced += count;
        }

        if (newContent !== content) {
          await writeFile(fullPath, newContent);
          filesChanged++;
        }
      }
      setReplaced({ count: totalReplaced, files: filesChanged });
      setResults([]);
    } catch (err) {
      setError(String(err));
    } finally {
      setReplacing(false);
    }
  }, [query, replaceText, results, grouped, projectPath, useRegex, caseSensitive, wholeWord]);

  // Replace in single file
  const handleReplaceFile = useCallback(async (group: GroupedResult) => {
    if (!query.trim()) return;
    const fullPath = group.path.startsWith(projectPath)
      ? group.path
      : `${projectPath.replace(/[\\/]+$/, "")}/${group.path.replace(/^[\\/]+/, "")}`;
    try {
      const content = await readFile(fullPath);
      const flags = caseSensitive ? "g" : "gi";
      const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const pattern = useRegex ? query : (wholeWord ? `\\b${escaped}\\b` : escaped);
      const newContent = content.replace(new RegExp(pattern, flags), replaceText);
      if (newContent !== content) {
        await writeFile(fullPath, newContent);
        setResults(prev => prev.filter(r => r.path !== group.path));
      }
    } catch (err) {
      setError(String(err));
    }
  }, [query, replaceText, projectPath, caseSensitive, wholeWord, useRegex]);

  return (
    <div className="find-replace" role="search">
      {/* Header */}
      <div className="panel-header fr-header">
        <span>SEARCH</span>
        <button type="button" className="icon-btn small" onClick={onClose} aria-label="Close search">
          <X size={14} />
        </button>
      </div>

      {/* Search row */}
      <div className="fr-input-row">
        <button
          className={`fr-toggle-btn ${replaceMode ? "active" : ""}`}
          onClick={() => setReplaceMode(r => !r)}
          title="Toggle replace"
          aria-label="Toggle replace mode"
        >
          {replaceMode ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
        </button>
        <div className="fr-field-col">
          {/* Find field */}
          <div className="fr-input-wrap">
            <Search size={13} className="fr-input-icon" />
            <input
              ref={searchRef}
              className="fr-input"
              value={query}
              onChange={e => setQuery(e.target.value)}
              placeholder="Search"
              aria-label="Search query"
              spellCheck={false}
            />
            {/* Options */}
            <div className="fr-opts">
              <button
                className={`fr-opt-btn ${caseSensitive ? "active" : ""}`}
                onClick={() => setCaseSensitive(v => !v)}
                title="Match case"
              >Aa</button>
              <button
                className={`fr-opt-btn ${wholeWord ? "active" : ""}`}
                onClick={() => setWholeWord(v => !v)}
                title="Whole word"
              >W</button>
              <button
                className={`fr-opt-btn ${useRegex ? "active" : ""}`}
                onClick={() => setUseRegex(v => !v)}
                title="Use regex"
              >.*</button>
            </div>
            {searching && <RefreshCw size={12} className="fr-spin" />}
          </div>

          {/* Replace field */}
          {replaceMode && (
            <div className="fr-input-wrap fr-replace-wrap">
              <Replace size={13} className="fr-input-icon" />
              <input
                className="fr-input"
                value={replaceText}
                onChange={e => setReplaceText(e.target.value)}
                placeholder="Replace"
                aria-label="Replace text"
                spellCheck={false}
              />
              {results.length > 0 && (
                <button
                  className="fr-replace-all-btn"
                  onClick={handleReplaceAll}
                  disabled={replacing}
                  title={`Replace all ${totalMatches} matches in ${totalFiles} files`}
                >
                  {replacing ? <RefreshCw size={11} className="fr-spin" /> : <CheckCheck size={11} />}
                  All
                </button>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Stats row */}
      {query.trim() && !searching && (
        <div className="fr-stats">
          {error ? (
            <span className="fr-error"><AlertTriangle size={11} /> {error.slice(0, 60)}</span>
          ) : replaced ? (
            <span className="fr-success">
              <CheckCheck size={11} /> Replaced {replaced.count} occurrence{replaced.count !== 1 ? "s" : ""} in {replaced.files} file{replaced.files !== 1 ? "s" : ""}
            </span>
          ) : (
            <span>{totalMatches} result{totalMatches !== 1 ? "s" : ""} in {totalFiles} file{totalFiles !== 1 ? "s" : ""}</span>
          )}
        </div>
      )}

      {/* Results */}
      <div className="fr-results">
        {!query.trim() && (
          <div className="fr-empty">Type to search across all project files</div>
        )}
        {query.trim() && searching && results.length === 0 && (
          <div className="fr-empty">Searching…</div>
        )}
        {query.trim() && !searching && results.length === 0 && !replaced && (
          <div className="fr-empty">No results for "{query}"</div>
        )}

        {grouped.map(group => {
          const isExpanded = expandedFiles.has(group.path);
          const filename = group.path.split(/[\\/]/).pop() ?? group.path;
          const dir = group.path.split(/[\\/]/).slice(0, -1).join("/");
          return (
            <div key={group.path} className="fr-file-group">
              {/* File header */}
              <div className="fr-file-header" onClick={() => toggleFile(group.path)}>
                <span className="fr-file-chevron">
                  {isExpanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                </span>
                <span className="fr-file-name">{filename}</span>
                <span className="fr-file-dir">{dir}</span>
                <span className="fr-file-count">{group.matches.length}</span>
                {replaceMode && (
                  <button
                    className="fr-file-replace-btn"
                    onClick={e => { e.stopPropagation(); handleReplaceFile(group); }}
                    title={`Replace in ${filename}`}
                  >
                    <Replace size={11} />
                  </button>
                )}
              </div>

              {/* Matches */}
              {isExpanded && group.matches.map((match, i) => (
                <button
                  key={i}
                  className="fr-match"
                  onClick={() => onOpenResult(match)}
                  title={`${match.path}:${match.line}`}
                >
                  <span className="fr-match-line">{match.line}</span>
                  <span className="fr-match-preview">
                    <HighlightMatch text={match.preview} query={query} />
                  </span>
                </button>
              ))}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── Highlight matching text ────────────────────────────────────────────────────
function HighlightMatch({ text, query }: { text: string; query: string }) {
  if (!query.trim()) return <>{text}</>;
  let parts: string[];
  try {
    const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    parts = text.split(new RegExp(`(${escaped})`, "gi"));
  } catch {
    return <>{text}</>;
  }
  return (
    <>
      {parts.map((part, i) =>
        part.toLowerCase() === query.toLowerCase()
          ? <mark key={i} className="fr-highlight">{part}</mark>
          : <span key={i}>{part}</span>
      )}
    </>
  );
}
