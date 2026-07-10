import { useEffect, useState, useCallback } from "react";
import { Search, X, Replace, CaseSensitive, Regex, FileCode, ChevronDown, ChevronRight } from "lucide-react";
import { searchProjectEnhanced, searchAndReplacePreview, searchAndReplaceApply } from "../utils/tauri";
import type { SearchResult, ReplacePreview } from "../utils/tauri";

interface Props {
  projectPath: string;
  onOpenResult: (result: SearchResult) => void;
  onClose: () => void;
}

export default function ProjectSearch({ projectPath, onOpenResult, onClose }: Props) {
  const [query, setQuery] = useState("");
  const [replacement, setReplacement] = useState("");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [replacePreviews, setReplacePreviews] = useState<ReplacePreview[]>([]);
  const [searching, setSearching] = useState(false);

  // Options
  const [isRegex, setIsRegex] = useState(false);
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [showReplace, setShowReplace] = useState(false);
  const [fileFilter, setFileFilter] = useState("");
  const [showFilters, setShowFilters] = useState(false);

  // Replace state
  const [replacing, setReplacing] = useState(false);
  const [replaceCount, setReplaceCount] = useState<number | null>(null);

  // Parse file extensions from filter input
  const parseExtensions = useCallback((): string[] | undefined => {
    if (!fileFilter.trim()) return undefined;
    return fileFilter
      .split(",")
      .map((e) => e.trim())
      .filter(Boolean);
  }, [fileFilter]);

  // Search effect
  useEffect(() => {
    if (!query.trim() || !projectPath) {
      setResults([]);
      setReplacePreviews([]);
      return;
    }

    let cancelled = false;
    const timer = window.setTimeout(async () => {
      setSearching(true);
      setReplaceCount(null);
      try {
        const nextResults = await searchProjectEnhanced({
          query,
          isRegex,
          caseSensitive,
          fileExtensions: parseExtensions(),
        });
        if (!cancelled) setResults(nextResults);
      } catch (err) {
        console.error("Search failed:", err);
        if (!cancelled) setResults([]);
      } finally {
        if (!cancelled) setSearching(false);
      }
    }, 250);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [query, projectPath, isRegex, caseSensitive, fileFilter, parseExtensions]);

  // Replace preview
  const handleReplacePreview = useCallback(async () => {
    if (!query.trim() || !replacement) return;
    try {
      const previews = await searchAndReplacePreview(
        query,
        replacement,
        isRegex,
        caseSensitive,
        parseExtensions(),
      );
      setReplacePreviews(previews);
    } catch (err) {
      console.error("Replace preview failed:", err);
    }
  }, [query, replacement, isRegex, caseSensitive, parseExtensions]);

  // Apply replace
  const handleReplaceAll = useCallback(async () => {
    if (!query.trim() || !results.length) return;
    setReplacing(true);
    try {
      const filePaths = [...new Set(results.map((r) => r.path))];
      const count = await searchAndReplaceApply(
        query,
        replacement,
        isRegex,
        caseSensitive,
        filePaths,
      );
      setReplaceCount(count);
      // Re-search to show updated results
      const nextResults = await searchProjectEnhanced({
        query,
        isRegex,
        caseSensitive,
        fileExtensions: parseExtensions(),
      });
      setResults(nextResults);
    } catch (err) {
      console.error("Replace failed:", err);
    } finally {
      setReplacing(false);
    }
  }, [query, replacement, isRegex, caseSensitive, results, parseExtensions]);

  // Group results by file
  const groupedResults = results.reduce<Record<string, SearchResult[]>>((acc, result) => {
    if (!acc[result.path]) acc[result.path] = [];
    acc[result.path].push(result);
    return acc;
  }, {});

  return (
    <div className="project-search" role="search">
      <div className="panel-header project-search-header">
        <span>SEARCH</span>
        <button type="button" className="icon-btn small" onClick={onClose} aria-label="Close search">
          <X size={14} />
        </button>
      </div>

      {/* Search input row */}
      <div className="project-search-input-wrap">
        <Search size={15} />
        <input
          autoFocus
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={isRegex ? "Search regex..." : "Search in project..."}
          aria-label="Search in project"
        />
        <div className="search-toggle-group">
          <button
            type="button"
            className={`search-toggle-btn ${caseSensitive ? "active" : ""}`}
            onClick={() => setCaseSensitive(!caseSensitive)}
            title="Case Sensitive"
            aria-label="Toggle case sensitive"
            aria-pressed={caseSensitive}
          >
            <CaseSensitive size={14} />
          </button>
          <button
            type="button"
            className={`search-toggle-btn ${isRegex ? "active" : ""}`}
            onClick={() => setIsRegex(!isRegex)}
            title="Use Regex"
            aria-label="Toggle regex"
            aria-pressed={isRegex}
          >
            <Regex size={14} />
          </button>
          <button
            type="button"
            className={`search-toggle-btn ${showReplace ? "active" : ""}`}
            onClick={() => setShowReplace(!showReplace)}
            title="Toggle Replace"
            aria-label="Toggle replace"
            aria-pressed={showReplace}
          >
            <Replace size={14} />
          </button>
        </div>
      </div>

      {/* Replace input row */}
      {showReplace && (
        <div className="project-search-input-wrap replace-row">
          <Replace size={15} />
          <input
            value={replacement}
            onChange={(event) => setReplacement(event.target.value)}
            placeholder="Replace with..."
            aria-label="Replace text"
          />
          <button
            type="button"
            className="search-action-btn"
            onClick={handleReplacePreview}
            disabled={!query.trim()}
            title="Preview replacements"
          >
            Preview
          </button>
          <button
            type="button"
            className="search-action-btn replace-all-btn"
            onClick={handleReplaceAll}
            disabled={!query.trim() || replacing}
            title="Replace all occurrences"
          >
            {replacing ? "..." : "All"}
          </button>
        </div>
      )}

      {/* File filter row */}
      <div className="project-search-filters">
        <button
          type="button"
          className="search-filter-toggle"
          onClick={() => setShowFilters(!showFilters)}
          aria-expanded={showFilters}
        >
          {showFilters ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
          <FileCode size={12} />
          <span>Filters</span>
        </button>
        {showFilters && (
          <input
            value={fileFilter}
            onChange={(event) => setFileFilter(event.target.value)}
            placeholder="File types: ts, tsx, rs..."
            aria-label="Filter by file extension"
            className="search-filter-input"
          />
        )}
      </div>

      {/* Results */}
      <div className="project-search-results">
        {replaceCount !== null && (
          <div className="search-info">Replaced {replaceCount} occurrences</div>
        )}
        {!query.trim() && <div className="search-empty">Type to search project files</div>}
        {query.trim() && searching && <div className="search-empty">Searching...</div>}
        {query.trim() && !searching && results.length === 0 && (
          <div className="search-empty">No results</div>
        )}
        {query.trim() && !searching && results.length > 0 && (
          <div className="search-summary">
            {results.length} result{results.length !== 1 ? "s" : ""} in {Object.keys(groupedResults).length} file{Object.keys(groupedResults).length !== 1 ? "s" : ""}
          </div>
        )}

        {/* Replace previews */}
        {replacePreviews.length > 0 && showReplace && (
          <div className="replace-preview-section">
            <div className="replace-preview-header">Replace Preview ({replacePreviews.length} changes)</div>
            {replacePreviews.slice(0, 50).map((preview, index) => (
              <div className="replace-preview-item" key={`${preview.path}-${preview.line}-${index}`}>
                <span className="search-result-path">{preview.path}:{preview.line}</span>
                <div className="replace-diff">
                  <span className="replace-old">{preview.original}</span>
                  <span className="replace-new">{preview.replaced}</span>
                </div>
              </div>
            ))}
          </div>
        )}

        {/* Grouped search results */}
        {Object.entries(groupedResults).map(([filePath, fileResults]) => (
          <FileResultGroup
            key={filePath}
            filePath={filePath}
            results={fileResults}
            onOpenResult={onOpenResult}
          />
        ))}
      </div>
    </div>
  );
}

// ─── File Result Group (collapsible) ────────────────────────────────────────────

interface FileResultGroupProps {
  filePath: string;
  results: SearchResult[];
  onOpenResult: (result: SearchResult) => void;
}

function FileResultGroup({ filePath, results, onOpenResult }: FileResultGroupProps) {
  const [collapsed, setCollapsed] = useState(false);

  return (
    <div className="search-file-group">
      <button
        type="button"
        className="search-file-header"
        onClick={() => setCollapsed(!collapsed)}
      >
        {collapsed ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
        <span className="search-file-name">{filePath}</span>
        <span className="search-file-count">{results.length}</span>
      </button>
      {!collapsed &&
        results.map((result, index) => (
          <button
            type="button"
            className="search-result"
            key={`${result.line}-${result.column}-${index}`}
            onClick={() => onOpenResult(result)}
          >
            <span className="search-result-preview">
              <span className="search-line-num">{result.line}</span>
              {result.preview}
            </span>
          </button>
        ))}
    </div>
  );
}
