import { useEffect, useState } from "react";
import { Search, X } from "lucide-react";
import { searchProject } from "../utils/tauri";
import type { SearchResult } from "../utils/tauri";

interface Props {
  projectPath: string;
  onOpenResult: (result: SearchResult) => void;
  onClose: () => void;
}

export default function ProjectSearch({ projectPath, onOpenResult, onClose }: Props) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [searching, setSearching] = useState(false);

  useEffect(() => {
    if (!query.trim() || !projectPath) {
      setResults([]);
      return;
    }

    let cancelled = false;
    const timer = window.setTimeout(async () => {
      setSearching(true);
      try {
        const nextResults = await searchProject(query);
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
  }, [query, projectPath]);

  return (
    <div className="project-search" role="search">
      <div className="panel-header project-search-header">
        <span>SEARCH</span>
        <button type="button" className="icon-btn small" onClick={onClose} aria-label="Close search">
          <X size={14} />
        </button>
      </div>
      <div className="project-search-input-wrap">
        <Search size={15} />
        <input
          autoFocus
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search in project..."
          aria-label="Search in project"
        />
      </div>
      <div className="project-search-results">
        {!query.trim() && <div className="search-empty">Type to search project files</div>}
        {query.trim() && searching && <div className="search-empty">Searching...</div>}
        {query.trim() && !searching && results.length === 0 && (
          <div className="search-empty">No results</div>
        )}
        {results.map((result, index) => (
          <button
            type="button"
            className="search-result"
            key={`${result.path}-${result.line}-${result.column}-${index}`}
            onClick={() => onOpenResult(result)}
          >
            <span className="search-result-path">{result.path}</span>
            <span className="search-result-preview">
              {result.line}:{result.column} {result.preview}
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}
