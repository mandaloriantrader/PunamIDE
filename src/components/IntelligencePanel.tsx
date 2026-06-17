/**
 * IntelligencePanel.tsx — Developer-facing panel for browsing the code intelligence layer.
 *
 * Three tabs:
 *   - Symbols: search for function/class/type definitions across the project
 *   - Call Graph: find callers or callees of any function
 *   - Embeddings: view index stats, trigger re-index
 */
import { useState, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Search, GitBranch, Database, RefreshCw, ArrowUpRight, ArrowDownRight } from "lucide-react";

// ── Types ─────────────────────────────────────────────────────────────────────

interface SymbolEntry {
  name: string;
  file: string;
  line: number;
  kind: string;
  signature: string;
}

interface CallEdge {
  caller: string;
  caller_file: string;
  call_line: number;
  callee: string;
  call_expression: string;
}

interface EmbeddingStats {
  total_chunks_indexed: number;
  total_embeddings_stored: number;
  unique_files: number;
}

type TabId = "symbols" | "callgraph" | "embeddings";

// ── Component ─────────────────────────────────────────────────────────────────

interface IntelligencePanelProps {
  onNavigateToFile?: (filePath: string, line: number) => void;
}

export default function IntelligencePanel({ onNavigateToFile }: IntelligencePanelProps) {
  const [activeTab, setActiveTab] = useState<TabId>("symbols");

  return (
    <div className="intelligence-panel">
      <div className="intelligence-tabs">
        <button
          className={`intelligence-tab ${activeTab === "symbols" ? "active" : ""}`}
          onClick={() => setActiveTab("symbols")}
          title="Symbol Index"
        >
          <Search size={13} />
          <span>Symbols</span>
        </button>
        <button
          className={`intelligence-tab ${activeTab === "callgraph" ? "active" : ""}`}
          onClick={() => setActiveTab("callgraph")}
          title="Call Graph"
        >
          <GitBranch size={13} />
          <span>Call Graph</span>
        </button>
        <button
          className={`intelligence-tab ${activeTab === "embeddings" ? "active" : ""}`}
          onClick={() => setActiveTab("embeddings")}
          title="Embeddings"
        >
          <Database size={13} />
          <span>Embeddings</span>
        </button>
      </div>
      <div className="intelligence-body">
        {activeTab === "symbols" && <SymbolsTab onNavigate={onNavigateToFile} />}
        {activeTab === "callgraph" && <CallGraphTab onNavigate={onNavigateToFile} />}
        {activeTab === "embeddings" && <EmbeddingsTab />}
      </div>
    </div>
  );
}

// ── Symbols Tab ───────────────────────────────────────────────────────────────

function SymbolsTab({ onNavigate }: { onNavigate?: (file: string, line: number) => void }) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SymbolEntry[]>([]);
  const [searching, setSearching] = useState(false);
  const [stats, setStats] = useState<string>("");

  const handleSearch = useCallback(async () => {
    if (!query.trim()) return;
    setSearching(true);
    try {
      const result = await invoke<{
        query: string;
        matches: SymbolEntry[];
        total_count: number;
        query_time_ms: number;
      }>("symbol_lookup", { name: query.trim() });
      setResults(result.matches);
      setStats(`${result.total_count} result(s) in ${result.query_time_ms}ms`);
    } catch (err) {
      setStats(`Error: ${String(err)}`);
      setResults([]);
    } finally {
      setSearching(false);
    }
  }, [query]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") handleSearch();
  };

  return (
    <div className="intelligence-tab-content">
      <div className="intelligence-search-row">
        <input
          type="text"
          className="intelligence-input"
          placeholder="Function, class, or type name..."
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={handleKeyDown}
          aria-label="Symbol search"
        />
        <button
          className="intelligence-search-btn"
          onClick={handleSearch}
          disabled={searching || !query.trim()}
          aria-label="Search symbols"
        >
          <Search size={13} />
        </button>
      </div>
      {stats && <div className="intelligence-stats">{stats}</div>}
      <div className="intelligence-results">
        {results.map((entry, i) => (
          <div
            key={`${entry.file}-${entry.line}-${i}`}
            className="intelligence-result-item clickable"
            onClick={() => onNavigate?.(entry.file, entry.line)}
            title={`${entry.file}:${entry.line}`}
            role="button"
            tabIndex={0}
            onKeyDown={(e) => { if (e.key === "Enter") onNavigate?.(entry.file, entry.line); }}
          >
            <span className="result-kind">{entry.kind}</span>
            <span className="result-name">{entry.name}</span>
            <span className="result-location">{entry.file}:{entry.line}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Call Graph Tab ────────────────────────────────────────────────────────────

function CallGraphTab({ onNavigate }: { onNavigate?: (file: string, line: number) => void }) {
  const [query, setQuery] = useState("");
  const [mode, setMode] = useState<"callers" | "callees">("callers");
  const [results, setResults] = useState<CallEdge[]>([]);
  const [searching, setSearching] = useState(false);
  const [stats, setStats] = useState<string>("");

  const handleSearch = useCallback(async () => {
    if (!query.trim()) return;
    setSearching(true);
    try {
      if (mode === "callers") {
        const result = await invoke<{
          function_name: string;
          callers: CallEdge[];
          total_callers: number;
          query_time_ms: number;
        }>("callgraph_lookup", { functionName: query.trim() });
        setResults(result.callers);
        setStats(`${result.total_callers} caller(s) in ${result.query_time_ms}ms`);
      } else {
        const result = await invoke<{
          function_name: string;
          callees: CallEdge[];
          total_callees: number;
          query_time_ms: number;
        }>("callgraph_callees", { functionName: query.trim() });
        setResults(result.callees);
        setStats(`${result.total_callees} callee(s) in ${result.query_time_ms}ms`);
      }
    } catch (err) {
      setStats(`Error: ${String(err)}`);
      setResults([]);
    } finally {
      setSearching(false);
    }
  }, [query, mode]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") handleSearch();
  };

  return (
    <div className="intelligence-tab-content">
      <div className="intelligence-search-row">
        <input
          type="text"
          className="intelligence-input"
          placeholder="Function name..."
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={handleKeyDown}
          aria-label="Function name search"
        />
        <button
          className={`intelligence-mode-btn ${mode === "callers" ? "active" : ""}`}
          onClick={() => setMode("callers")}
          title="Find callers (who calls this?)"
          aria-label="Find callers"
          aria-pressed={mode === "callers"}
        >
          <ArrowDownRight size={12} />
        </button>
        <button
          className={`intelligence-mode-btn ${mode === "callees" ? "active" : ""}`}
          onClick={() => setMode("callees")}
          title="Find callees (what does this call?)"
          aria-label="Find callees"
          aria-pressed={mode === "callees"}
        >
          <ArrowUpRight size={12} />
        </button>
        <button
          className="intelligence-search-btn"
          onClick={handleSearch}
          disabled={searching || !query.trim()}
          aria-label="Search call graph"
        >
          <Search size={13} />
        </button>
      </div>
      {stats && <div className="intelligence-stats">{stats}</div>}
      <div className="intelligence-results">
        {results.map((edge, i) => (
          <div
            key={`${edge.caller_file}-${edge.call_line}-${i}`}
            className="intelligence-result-item clickable"
            onClick={() => onNavigate?.(edge.caller_file, edge.call_line)}
            title={edge.call_expression}
            role="button"
            tabIndex={0}
            onKeyDown={(e) => { if (e.key === "Enter") onNavigate?.(edge.caller_file, edge.call_line); }}
          >
            <span className="result-kind">{mode === "callers" ? "←" : "→"}</span>
            <span className="result-name">
              {mode === "callers" ? edge.caller : edge.callee || edge.call_expression}
            </span>
            <span className="result-location">{edge.caller_file}:{edge.call_line}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Embeddings Tab ────────────────────────────────────────────────────────────

function EmbeddingsTab() {
  const [stats, setStats] = useState<EmbeddingStats | null>(null);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState("");

  const loadStats = useCallback(async () => {
    try {
      const result = await invoke<EmbeddingStats>("embedding_pipeline_stats");
      setStats(result);
    } catch {
      setStats(null);
      setMessage("Codebase not indexed yet. Open a project to start.");
    }
  }, []);

  const handleReindex = useCallback(async () => {
    setLoading(true);
    setMessage("Rebuilding index...");
    try {
      const chunks = await invoke<number>("index_codebase");
      setMessage(`Indexed ${chunks} chunks. Run embedding pipeline for semantic search.`);
      await loadStats();
    } catch (err) {
      setMessage(`Error: ${String(err)}`);
    } finally {
      setLoading(false);
    }
  }, [loadStats]);

  // Load stats on mount
  useState(() => { loadStats(); });

  return (
    <div className="intelligence-tab-content">
      <div className="intelligence-search-row">
        <button
          className="intelligence-search-btn"
          onClick={loadStats}
          title="Refresh stats"
          aria-label="Refresh embedding stats"
        >
          <RefreshCw size={13} />
        </button>
        <button
          className="intelligence-search-btn"
          onClick={handleReindex}
          disabled={loading}
          title="Rebuild codebase index"
          aria-label="Rebuild index"
        >
          <Database size={13} />
          <span style={{ marginLeft: 4, fontSize: 10 }}>Reindex</span>
        </button>
      </div>
      {message && <div className="intelligence-stats">{message}</div>}
      {stats && (
        <div className="intelligence-stats-grid">
          <div className="stat-item">
            <span className="stat-label">Chunks indexed</span>
            <span className="stat-value">{stats.total_chunks_indexed.toLocaleString()}</span>
          </div>
          <div className="stat-item">
            <span className="stat-label">Embeddings stored</span>
            <span className="stat-value">{stats.total_embeddings_stored.toLocaleString()}</span>
          </div>
          <div className="stat-item">
            <span className="stat-label">Unique files</span>
            <span className="stat-value">{stats.unique_files.toLocaleString()}</span>
          </div>
          <div className="stat-item">
            <span className="stat-label">Coverage</span>
            <span className="stat-value">
              {stats.total_chunks_indexed > 0
                ? `${Math.round((stats.total_embeddings_stored / stats.total_chunks_indexed) * 100)}%`
                : "—"}
            </span>
          </div>
        </div>
      )}
    </div>
  );
}
