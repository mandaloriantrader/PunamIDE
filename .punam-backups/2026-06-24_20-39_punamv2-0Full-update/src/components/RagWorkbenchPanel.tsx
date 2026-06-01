/**
 * RagWorkbenchPanel.tsx — Phase 8
 *
 * UI panel for the RAG Engineering Suite.
 * Provides tabs for: Chunk Inspector, Embedding Analyzer, Retrieval Debugger, Hallucination Check.
 */

import { useState, useCallback } from "react";
import {
  Brain,
  Search,
  Layers,
  AlertTriangle,
  Loader2,
  FileText,
  BarChart3,
  CheckCircle2,
  XCircle,
} from "lucide-react";
import { ChunkInspector } from "../services/embeddings/ChunkInspector";
import type { ChunkConfig, ChunkAnalysis } from "../services/embeddings/ChunkInspector";
import { RetrieverDebugger } from "../services/embeddings/RetrieverDebugger";
import type { RetrievalDebugResult } from "../services/embeddings/RetrieverDebugger";
import { HallucinationDetector } from "../services/embeddings/HallucinationDetector";
import type { HallucinationCheck } from "../services/embeddings/HallucinationDetector";

// ── Styles ────────────────────────────────────────────────────────────────────

const PANEL_STYLE: React.CSSProperties = {
  display: "flex", flexDirection: "column", height: "100%",
  background: "var(--bg-primary, #1a1a2e)", color: "var(--text-primary, #e0e0e0)",
  fontFamily: "var(--font-mono, 'JetBrains Mono', monospace)", overflow: "auto",
};

const HEADER_STYLE: React.CSSProperties = {
  padding: "12px 16px", borderBottom: "1px solid var(--border-color, #2a2a4a)",
  display: "flex", alignItems: "center", gap: "8px", fontSize: "13px", fontWeight: 600, flexShrink: 0,
};

const TAB_BAR_STYLE: React.CSSProperties = {
  display: "flex", gap: "2px", padding: "6px 16px",
  borderBottom: "1px solid var(--border-color, #2a2a4a)", flexShrink: 0, overflowX: "auto",
};

const SECTION_STYLE: React.CSSProperties = {
  margin: "10px 16px", padding: "12px",
  background: "var(--bg-card, #16162a)", border: "1px solid var(--border-color, #2a2a4a)", borderRadius: "8px",
};

const INPUT_STYLE: React.CSSProperties = {
  width: "100%", padding: "8px 10px",
  background: "var(--bg-input, #16162a)", border: "1px solid var(--border-color, #2a2a4a)",
  borderRadius: "6px", color: "var(--text-primary, #e0e0e0)", fontSize: "12px",
  fontFamily: "var(--font-mono, 'JetBrains Mono', monospace)", outline: "none",
};

const BTN_STYLE: React.CSSProperties = {
  padding: "6px 14px", background: "var(--accent-color, #3b82f6)", border: "none",
  borderRadius: "6px", color: "#fff", fontSize: "11px", fontWeight: 600,
  cursor: "pointer", display: "flex", alignItems: "center", gap: "6px", fontFamily: "inherit",
};

// ── Types ──────────────────────────────────────────────────────────────────────

type RagTab = "chunks" | "retrieval" | "hallucination";

// ── Component ─────────────────────────────────────────────────────────────────

export default function RagWorkbenchPanel() {
  const [activeTab, setActiveTab] = useState<RagTab>("chunks");

  return (
    <div style={PANEL_STYLE}>
      <div style={HEADER_STYLE}>
        <Brain size={16} />
        RAG Engineering Suite
        <span style={{ fontSize: "10px", color: "var(--text-secondary, #a0a0b0)", marginLeft: "auto" }}>Phase 8</span>
      </div>

      {/* Tabs */}
      <div style={TAB_BAR_STYLE}>
        {([
          ["chunks", "Chunks", Layers],
          ["retrieval", "Retrieval", Search],
          ["hallucination", "Hallucination", AlertTriangle],
        ] as const).map(([id, label, Icon]) => (
          <button
            key={id}
            onClick={() => setActiveTab(id)}
            style={{
              display: "flex", alignItems: "center", gap: "4px",
              padding: "5px 10px", borderRadius: "4px", border: "none",
              background: activeTab === id ? "var(--accent-color, #3b82f6)" : "transparent",
              color: activeTab === id ? "#fff" : "var(--text-secondary, #a0a0b0)",
              fontSize: "11px", fontWeight: 500, cursor: "pointer", fontFamily: "inherit",
            }}
          >
            <Icon size={12} />
            {label}
          </button>
        ))}
      </div>

      {/* Tab content */}
      {activeTab === "chunks" && <ChunkTab />}
      {activeTab === "retrieval" && <RetrievalTab />}
      {activeTab === "hallucination" && <HallucinationTab />}
    </div>
  );
}

// ── Chunk Inspector Tab ───────────────────────────────────────────────────────

function ChunkTab() {
  const [text, setText] = useState("");
  const [chunkSize, setChunkSize] = useState(500);
  const [overlap, setOverlap] = useState(50);
  const [analysis, setAnalysis] = useState<ChunkAnalysis | null>(null);

  const handleChunk = useCallback(() => {
    if (!text.trim()) return;
    const inspector = new ChunkInspector();
    const config: ChunkConfig = { chunkSize, overlap, strategy: "fixed" };
    const result = inspector.chunkDocument(text, config);
    setAnalysis(result);
  }, [text, chunkSize, overlap]);

  return (
    <div style={{ flex: 1, overflow: "auto" }}>
      <div style={SECTION_STYLE}>
        <div style={{ fontSize: "11px", fontWeight: 600, color: "var(--text-secondary, #a0a0b0)", marginBottom: "8px" }}>
          <FileText size={12} style={{ verticalAlign: "middle", marginRight: "4px" }} />
          Document Content
        </div>
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Paste document content to chunk..."
          rows={5}
          style={{ ...INPUT_STYLE, resize: "vertical" }}
        />
        <div style={{ display: "flex", gap: "12px", marginTop: "8px", alignItems: "center" }}>
          <label style={{ fontSize: "10px", color: "var(--text-secondary, #a0a0b0)" }}>
            Size: <input type="number" value={chunkSize} onChange={(e) => setChunkSize(+e.target.value)}
              style={{ ...INPUT_STYLE, width: "60px", padding: "4px 6px" }} />
          </label>
          <label style={{ fontSize: "10px", color: "var(--text-secondary, #a0a0b0)" }}>
            Overlap: <input type="number" value={overlap} onChange={(e) => setOverlap(+e.target.value)}
              style={{ ...INPUT_STYLE, width: "60px", padding: "4px 6px" }} />
          </label>
          <button onClick={handleChunk} disabled={!text.trim()} style={{ ...BTN_STYLE, opacity: text.trim() ? 1 : 0.5 }}>
            <Layers size={12} /> Chunk
          </button>
        </div>
      </div>

      {analysis && (
        <div style={SECTION_STYLE}>
          <div style={{ fontSize: "11px", fontWeight: 600, color: "var(--text-secondary, #a0a0b0)", marginBottom: "8px" }}>
            Result: {analysis.chunks.length} chunks · avg {Math.round(analysis.averageChunkSize)} chars
          </div>
          <div style={{ maxHeight: "300px", overflow: "auto" }}>
            {analysis.chunks.map((chunk, i) => (
              <div key={i} style={{
                padding: "6px 8px", marginBottom: "4px", background: "var(--bg-input, #1a1a2e)",
                borderRadius: "4px", fontSize: "10px", borderLeft: "3px solid var(--accent-color, #3b82f6)",
              }}>
                <div style={{ fontWeight: 600, marginBottom: "2px", color: "var(--text-secondary, #a0a0b0)" }}>
                  Chunk {i + 1} ({chunk.content.length} chars)
                </div>
                <div style={{ color: "var(--text-primary, #e0e0e0)", whiteSpace: "pre-wrap", maxHeight: "60px", overflow: "hidden" }}>
                  {chunk.content.slice(0, 200)}{chunk.content.length > 200 ? "..." : ""}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ── Retrieval Debugger Tab ────────────────────────────────────────────────────

function RetrievalTab() {
  const [query, setQuery] = useState("");
  const [docs, setDocs] = useState("");
  const [result, setResult] = useState<RetrievalDebugResult | null>(null);
  const [loading, setLoading] = useState(false);

  const handleDebug = useCallback(async () => {
    if (!query.trim() || !docs.trim()) return;
    setLoading(true);
    try {
      const debugger_ = new RetrieverDebugger();
      const documents = docs.split("\n---\n").map((content, i) => ({
        path: `doc-${i + 1}.md`,
        content: content.trim(),
        language: "markdown",
      }));
      const res = await debugger_.debugQuery(documents, query, 5);
      setResult(res);
    } catch {
      // Handle error
    } finally {
      setLoading(false);
    }
  }, [query, docs]);

  return (
    <div style={{ flex: 1, overflow: "auto" }}>
      <div style={SECTION_STYLE}>
        <div style={{ fontSize: "11px", fontWeight: 600, color: "var(--text-secondary, #a0a0b0)", marginBottom: "8px" }}>
          <Search size={12} style={{ verticalAlign: "middle", marginRight: "4px" }} />
          Query
        </div>
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Enter search query..."
          style={INPUT_STYLE}
        />
        <div style={{ fontSize: "11px", fontWeight: 600, color: "var(--text-secondary, #a0a0b0)", margin: "10px 0 6px" }}>
          Documents (separate with ---)
        </div>
        <textarea
          value={docs}
          onChange={(e) => setDocs(e.target.value)}
          placeholder="Paste documents separated by --- on a new line..."
          rows={4}
          style={{ ...INPUT_STYLE, resize: "vertical" }}
        />
        <button onClick={handleDebug} disabled={loading || !query.trim() || !docs.trim()}
          style={{ ...BTN_STYLE, marginTop: "8px", opacity: (query.trim() && docs.trim()) ? 1 : 0.5 }}>
          {loading ? <Loader2 size={12} style={{ animation: "spin 1s linear infinite" }} /> : <Search size={12} />}
          Debug Retrieval
        </button>
      </div>

      {result && (
        <div style={SECTION_STYLE}>
          <div style={{ fontSize: "11px", fontWeight: 600, color: "var(--text-secondary, #a0a0b0)", marginBottom: "8px" }}>
            <BarChart3 size={12} style={{ verticalAlign: "middle", marginRight: "4px" }} />
            Results: {result.hits.length} hits · {result.queryTimeMs}ms · {result.totalChunks} total chunks
          </div>
          {result.hits.map((hit, i) => (
            <div key={i} style={{
              padding: "6px 8px", marginBottom: "4px", background: "var(--bg-input, #1a1a2e)",
              borderRadius: "4px", fontSize: "10px",
            }}>
              <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "2px" }}>
                <span style={{ fontWeight: 600 }}>{hit.path}</span>
                <span style={{ color: "#60a5fa" }}>score: {hit.score.toFixed(3)}</span>
              </div>
              <div style={{ color: "var(--text-secondary, #a0a0b0)", maxHeight: "40px", overflow: "hidden" }}>
                {hit.chunk.slice(0, 150)}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Hallucination Check Tab ───────────────────────────────────────────────────

function HallucinationTab() {
  const [claim, setClaim] = useState("");
  const [sources, setSources] = useState("");
  const [result, setResult] = useState<HallucinationCheck | null>(null);

  const handleCheck = useCallback(() => {
    if (!claim.trim() || !sources.trim()) return;
    const detector = new HallucinationDetector();
    const sourceList = sources.split("\n---\n").map((content, i) => ({
      id: `source-${i + 1}`,
      content: content.trim(),
    }));
    const check = detector.checkClaim(claim, sourceList);
    setResult(check);
  }, [claim, sources]);

  return (
    <div style={{ flex: 1, overflow: "auto" }}>
      <div style={SECTION_STYLE}>
        <div style={{ fontSize: "11px", fontWeight: 600, color: "var(--text-secondary, #a0a0b0)", marginBottom: "8px" }}>
          <AlertTriangle size={12} style={{ verticalAlign: "middle", marginRight: "4px" }} />
          Claim to Verify
        </div>
        <textarea
          value={claim}
          onChange={(e) => setClaim(e.target.value)}
          placeholder="Enter an LLM-generated claim to verify..."
          rows={2}
          style={{ ...INPUT_STYLE, resize: "vertical" }}
        />
        <div style={{ fontSize: "11px", fontWeight: 600, color: "var(--text-secondary, #a0a0b0)", margin: "10px 0 6px" }}>
          Source Documents (separate with ---)
        </div>
        <textarea
          value={sources}
          onChange={(e) => setSources(e.target.value)}
          placeholder="Paste source documents separated by --- on a new line..."
          rows={4}
          style={{ ...INPUT_STYLE, resize: "vertical" }}
        />
        <button onClick={handleCheck} disabled={!claim.trim() || !sources.trim()}
          style={{ ...BTN_STYLE, marginTop: "8px", opacity: (claim.trim() && sources.trim()) ? 1 : 0.5 }}>
          <AlertTriangle size={12} /> Check Hallucination
        </button>
      </div>

      {result && (
        <div style={{
          ...SECTION_STYLE,
          borderColor: result.verified ? "#34d39940" : "#ef444440",
          background: result.verified ? "#065f4610" : "#7f1d1d10",
        }}>
          <div style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "8px" }}>
            {result.verified ? (
              <CheckCircle2 size={16} color="#34d399" />
            ) : (
              <XCircle size={16} color="#ef4444" />
            )}
            <span style={{ fontSize: "12px", fontWeight: 600, color: result.verified ? "#34d399" : "#ef4444" }}>
              {result.verified ? "Claim Verified" : "Potential Hallucination"}
            </span>
            <span style={{ fontSize: "10px", color: "var(--text-secondary, #a0a0b0)", marginLeft: "auto" }}>
              Confidence: {Math.round(result.confidence * 100)}%
            </span>
          </div>
          <div style={{ fontSize: "11px", color: "var(--text-secondary, #a0a0b0)", lineHeight: 1.5 }}>
            {result.explanation}
          </div>
          {result.supportingEvidence.length > 0 && (
            <div style={{ marginTop: "6px", fontSize: "10px", color: "#34d399" }}>
              Supporting: {result.supportingEvidence.join(", ")}
            </div>
          )}
          {result.contradictingEvidence.length > 0 && (
            <div style={{ marginTop: "4px", fontSize: "10px", color: "#ef4444" }}>
              Contradicting: {result.contradictingEvidence.join(", ")}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
