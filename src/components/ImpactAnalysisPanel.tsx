/**
 * ImpactAnalysisPanel.tsx — Phase 3, Step 3.5
 *
 * UI for Natural Language Architecture Mapping.
 *
 * Provides:
 *   - Natural language input box ("Add multi-tenant support")
 *   - Impact summary card (systems, file count, risk level)
 *   - Dependency diagram placeholder
 *   - Past similar changes from Phase 2 memory
 *   - Risk factors and explanation
 */

import { useState, useCallback, useEffect, useRef } from "react";
import {
  Search,
  AlertTriangle,
  AlertCircle,
  Info,
  Loader2,
  FileCode,
  GitBranch,
  Layers,
  Clock,
  Zap,
  ChevronDown,
  ChevronRight,
  Brain,
  CheckCircle,
  XCircle,
  ArrowRight,
} from "lucide-react";
import type {
  ImpactResult,
  AffectedSystem,
  AffectedFile,
  RiskLevel,
} from "../services/architecture/ImpactAnalyzer";
import type { ChangePrediction } from "../services/architecture/ChangePredictor";
import type { MemoryEntry } from "../services/memory/MemoryManager";
import { createImpactAnalyzer } from "../services/architecture/ImpactAnalyzer";
import { createChangePredictor } from "../services/architecture/ChangePredictor";
import { createDependencyExplorer } from "../services/architecture/DependencyExplorer";
import { buildArchitectureMap } from "../services/architecture/ArchitectureMap";
import { getRuleValidator } from "../services/architecture/RuleValidator";
import { getCachedDependencyGraph } from "../services/architecture/DependencyGraph";
import type { ArchitectureMap } from "../services/architecture/ArchitectureMap";

// ── Styles ────────────────────────────────────────────────────────────────────

const PANEL_STYLE: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  height: "100%",
  background: "var(--bg-primary, #1a1a2e)",
  color: "var(--text-primary, #e0e0e0)",
  fontFamily: "var(--font-mono, 'JetBrains Mono', monospace)",
  overflow: "auto",
};

const HEADER_STYLE: React.CSSProperties = {
  padding: "12px 16px",
  borderBottom: "1px solid var(--border-color, #2a2a4a)",
  display: "flex",
  alignItems: "center",
  gap: "8px",
  fontSize: "13px",
  fontWeight: 600,
  flexShrink: 0,
};

const INPUT_ROW_STYLE: React.CSSProperties = {
  padding: "12px 16px",
  borderBottom: "1px solid var(--border-color, #2a2a4a)",
  flexShrink: 0,
};

const INPUT_STYLE: React.CSSProperties = {
  width: "100%",
  padding: "10px 12px",
  background: "var(--bg-input, #16162a)",
  border: "1px solid var(--border-color, #2a2a4a)",
  borderRadius: "6px",
  color: "var(--text-primary, #e0e0e0)",
  fontSize: "13px",
  fontFamily: "var(--font-mono, 'JetBrains Mono', monospace)",
  outline: "none",
};

const BUTTON_ROW_STYLE: React.CSSProperties = {
  display: "flex",
  gap: "8px",
  marginTop: "8px",
};

const PRIMARY_BTN_STYLE: React.CSSProperties = {
  padding: "8px 16px",
  background: "var(--accent-color, #3b82f6)",
  border: "none",
  borderRadius: "6px",
  color: "#fff",
  fontSize: "12px",
  fontWeight: 600,
  cursor: "pointer",
  display: "flex",
  alignItems: "center",
  gap: "6px",
  fontFamily: "var(--font-mono, 'JetBrains Mono', monospace)",
};

const SECONDARY_BTN_STYLE: React.CSSProperties = {
  padding: "8px 16px",
  background: "transparent",
  border: "1px solid var(--border-color, #2a2a4a)",
  borderRadius: "6px",
  color: "var(--text-secondary, #a0a0b0)",
  fontSize: "12px",
  cursor: "pointer",
  fontFamily: "var(--font-mono, 'JetBrains Mono', monospace)",
};

const SUMMARY_CARD_STYLE: React.CSSProperties = {
  margin: "12px 16px",
  padding: "14px",
  background: "var(--bg-card, #16162a)",
  border: "1px solid var(--border-color, #2a2a4a)",
  borderRadius: "8px",
  flexShrink: 0,
};

const SYSTEM_TAG_STYLE: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: "4px",
  padding: "4px 10px",
  borderRadius: "12px",
  fontSize: "11px",
  fontWeight: 500,
  marginRight: "6px",
  marginBottom: "6px",
};

const RISK_BADGE_COLORS: Record<RiskLevel, { bg: string; text: string }> = {
  low: { bg: "#065f4620", text: "#34d399" },
  medium: { bg: "#92400e20", text: "#fbbf24" },
  high: { bg: "#991b1b20", text: "#f87171" },
  critical: { bg: "#7f1d1d30", text: "#ef4444" },
};

const SECTION_STYLE: React.CSSProperties = {
  margin: "12px 16px",
  padding: "14px",
  background: "var(--bg-card, #16162a)",
  border: "1px solid var(--border-color, #2a2a4a)",
  borderRadius: "8px",
  flexShrink: 0,
};

const SECTION_TITLE_STYLE: React.CSSProperties = {
  fontSize: "12px",
  fontWeight: 600,
  color: "var(--text-secondary, #a0a0b0)",
  marginBottom: "10px",
  display: "flex",
  alignItems: "center",
  gap: "6px",
};

const FILE_ROW_STYLE: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "8px",
  padding: "4px 0",
  fontSize: "12px",
  fontFamily: "var(--font-mono, 'JetBrains Mono', monospace)",
};

const MEMORY_ROW_STYLE: React.CSSProperties = {
  display: "flex",
  alignItems: "flex-start",
  gap: "8px",
  padding: "6px 0",
  fontSize: "11px",
  borderBottom: "1px solid var(--border-color, #2a2a4a20)",
};

// ── Component ─────────────────────────────────────────────────────────────────

export default function ImpactAnalysisPanel() {
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(false);
  const [impact, setImpact] = useState<ImpactResult | null>(null);
  const [prediction, setPrediction] = useState<ChangePrediction | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showFiles, setShowFiles] = useState(false);
  const [showTransitive, setShowTransitive] = useState(false);
  const [showMemory, setShowMemory] = useState(false);
  const [archMap, setArchMap] = useState<ArchitectureMap | null>(null);
  const initialized = useRef(false);

  // Initialize architecture map on mount
  useEffect(() => {
    if (initialized.current) return;
    initialized.current = true;

    buildArchitectureMap()
      .then((map) => setArchMap(map))
      .catch(() => {});

    // Pre-load dependency graph and rule validator for faster analysis
    getCachedDependencyGraph().catch(() => {});
    getRuleValidator().loadRules().catch(() => {});
  }, []);

  const handleAnalyze = useCallback(async () => {
    if (!query.trim()) return;

    setLoading(true);
    setError(null);
    setImpact(null);
    setPrediction(null);

    try {
      const analyzer = await createImpactAnalyzer();
      const predictor = await createChangePredictor(analyzer["archMap"]);

      // Run analysis and prediction
      const impactResult = await analyzer.analyzeChange(query.trim());
      setImpact(impactResult);

      const predictionResult = await predictor.predict(impactResult, query.trim());
      setPrediction(predictionResult);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Analysis failed");
    } finally {
      setLoading(false);
    }
  }, [query]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        handleAnalyze();
      }
    },
    [handleAnalyze],
  );

  // ── Render Helpers ───────────────────────────────────────────────────────

  const renderRiskBadge = (level: RiskLevel) => {
    const colors = RISK_BADGE_COLORS[level];
    return (
      <span
        style={{
          ...SYSTEM_TAG_STYLE,
          background: colors.bg,
          color: colors.text,
        }}
      >
        <AlertTriangle size={12} />
        {level.toUpperCase()}
      </span>
    );
  };

  const renderSystemTag = (system: AffectedSystem) => (
    <span
      key={system.name}
      style={{
        ...SYSTEM_TAG_STYLE,
        background: system.confidence > 0.7 ? "#1e3a5f20" : "#4a3a1e20",
        color: system.confidence > 0.7 ? "#60a5fa" : "#fbbf24",
      }}
    >
      {system.name}
      <span style={{ fontSize: "10px", opacity: 0.7 }}>
        ({Math.round(system.confidence * 100)}%)
      </span>
    </span>
  );

  const getSeverityIcon = (severity: string) => {
    switch (severity) {
      case "critical": return <XCircle size={12} color="#ef4444" />;
      case "high": return <AlertTriangle size={12} color="#f87171" />;
      case "medium": return <AlertCircle size={12} color="#fbbf24" />;
      default: return <Info size={12} color="#a0a0b0" />;
    }
  };

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div style={PANEL_STYLE}>
      {/* Header */}
      <div style={HEADER_STYLE}>
        <GitBranch size={16} />
        Architecture Impact Analysis
      </div>

      {/* Input */}
      <div style={INPUT_ROW_STYLE}>
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder='Describe a change... e.g., "Add multi-tenant support"'
          style={INPUT_STYLE}
          disabled={loading}
        />
        <div style={BUTTON_ROW_STYLE}>
          <button
            onClick={handleAnalyze}
            disabled={loading || !query.trim()}
            style={{
              ...PRIMARY_BTN_STYLE,
              opacity: loading || !query.trim() ? 0.5 : 1,
            }}
          >
            {loading ? (
              <>
                <Loader2 size={14} style={{ animation: "spin 1s linear infinite" }} />
                Analyzing...
              </>
            ) : (
              <>
                <Search size={14} />
                Analyze Impact
              </>
            )}
          </button>
          {impact && (
            <button
              onClick={() => {
                setQuery("");
                setImpact(null);
                setPrediction(null);
              }}
              style={SECONDARY_BTN_STYLE}
            >
              Clear
            </button>
          )}
        </div>
      </div>

      {/* Error */}
      {error && (
        <div style={{ ...SUMMARY_CARD_STYLE, borderColor: "#ef444440", background: "#7f1d1d20" }}>
          <div style={{ display: "flex", alignItems: "center", gap: "8px", color: "#f87171" }}>
            <AlertCircle size={16} />
            <span style={{ fontSize: "12px" }}>{error}</span>
          </div>
        </div>
      )}

      {/* Loading state */}
      {loading && !impact && (
        <div style={{ padding: "32px", textAlign: "center", color: "var(--text-secondary, #a0a0b0)" }}>
          <Loader2 size={24} style={{ marginBottom: "8px", animation: "spin 1s linear infinite" }} />
          <div style={{ fontSize: "12px" }}>Building architecture map and querying LLM...</div>
        </div>
      )}

      {/* Impact Summary */}
      {impact && (
        <>
          {/* Summary card */}
          <div style={SUMMARY_CARD_STYLE}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: "12px" }}>
              <div style={{ fontSize: "13px", fontWeight: 600 }}>Impact Summary</div>
              {renderRiskBadge(impact.riskLevel)}
            </div>

            {/* Stats row */}
            <div style={{ display: "flex", gap: "16px", marginBottom: "12px" }}>
              <div style={{ display: "flex", alignItems: "center", gap: "6px", fontSize: "12px", color: "var(--text-secondary, #a0a0b0)" }}>
                <FileCode size={14} />
                <span>{impact.totalFileCount} files</span>
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: "6px", fontSize: "12px", color: "var(--text-secondary, #a0a0b0)" }}>
                <Layers size={14} />
                <span>{impact.affectedSystems.length} systems</span>
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: "6px", fontSize: "12px", color: "var(--text-secondary, #a0a0b0)" }}>
                <Clock size={14} />
                <span>{impact.analysisTimeMs}ms</span>
              </div>
            </div>

            {/* Affected systems */}
            <div style={{ marginBottom: "8px" }}>
              {impact.affectedSystems.map(renderSystemTag)}
            </div>

            {/* Summary text */}
            <div style={{ fontSize: "12px", color: "var(--text-secondary, #a0a0b0)", lineHeight: 1.5 }}>
              {impact.summary}
            </div>
          </div>

          {/* Prediction card */}
          {prediction && (
            <div style={SUMMARY_CARD_STYLE}>
              <div style={SECTION_TITLE_STYLE}>
                <Zap size={14} />
                Change Prediction
              </div>

              <div style={{ display: "flex", gap: "12px", marginBottom: "10px", flexWrap: "wrap" }}>
                <PredictionStat
                  label="Estimated Effort"
                  value={prediction.estimatedEffort.replace(/_/g, " ")}
                  extra={`~${prediction.estimatedHours}h`}
                />
                <PredictionStat
                  label="Confidence"
                  value={`${Math.round(prediction.confidence * 100)}%`}
                />
                <PredictionStat
                  label="Max Depth"
                  value={`${prediction.maxDependencyDepth} levels`}
                />
                <PredictionStat
                  label="Transitive"
                  value={`${prediction.transitiveModuleCount} modules`}
                />
              </div>

              {/* Explanation */}
              <div style={{ fontSize: "11px", color: "var(--text-secondary, #a0a0b0)", lineHeight: 1.6, marginBottom: "8px" }}>
                {prediction.explanation}
              </div>

              {/* Risk factors */}
              {prediction.riskFactors.length > 0 && (
                <div style={{ marginTop: "8px" }}>
                  <div style={{ fontSize: "11px", fontWeight: 600, marginBottom: "4px", color: "#fbbf24" }}>
                    ⚠ Risk Factors
                  </div>
                  {prediction.riskFactors.map((factor, i) => (
                    <div
                      key={i}
                      style={{ fontSize: "11px", color: "var(--text-secondary, #a0a0b0)", padding: "2px 0", paddingLeft: "12px" }}
                    >
                      • {factor}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Affected Files */}
          <div style={SECTION_STYLE}>
            <button
              onClick={() => setShowFiles(!showFiles)}
              style={{
                ...SECTION_TITLE_STYLE,
                background: "none",
                border: "none",
                width: "100%",
                textAlign: "left",
                cursor: "pointer",
                fontFamily: "inherit",
              }}
            >
              {showFiles ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
              <FileCode size={14} />
              Affected Files ({impact.affectedFiles.length})
            </button>

            {showFiles && (
              <div style={{ marginTop: "8px", maxHeight: "300px", overflow: "auto" }}>
                {impact.affectedFiles.slice(0, 30).map((file) => (
                  <div key={file.path} style={FILE_ROW_STYLE}>
                    <FileCode size={12} color="var(--text-secondary, #a0a0b0)" />
                    <span style={{ color: "var(--text-primary, #e0e0e0)" }}>{file.path}</span>
                    <span style={{ color: "var(--text-secondary, #a0a0b0)", fontSize: "10px", marginLeft: "auto" }}>
                      {file.reason}
                    </span>
                  </div>
                ))}
                {impact.affectedFiles.length > 30 && (
                  <div style={{ fontSize: "11px", color: "var(--text-secondary, #a0a0b0)", padding: "8px", textAlign: "center" }}>
                    ... and {impact.affectedFiles.length - 30} more files
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Transitive Impact */}
          {impact.transitiveImpactFiles.length > 0 && (
            <div style={SECTION_STYLE}>
              <button
                onClick={() => setShowTransitive(!showTransitive)}
                style={{
                  ...SECTION_TITLE_STYLE,
                  background: "none",
                  border: "none",
                  width: "100%",
                  textAlign: "left",
                  cursor: "pointer",
                  fontFamily: "inherit",
                }}
              >
                {showTransitive ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                <ArrowRight size={14} />
                Transitive Impact ({impact.transitiveImpactFiles.length} files)
              </button>

              {showTransitive && (
                <div style={{ marginTop: "8px", maxHeight: "300px", overflow: "auto" }}>
                  {impact.transitiveImpactFiles.slice(0, 20).map((file) => (
                    <div key={file.path} style={FILE_ROW_STYLE}>
                      <ArrowRight size={12} color="var(--text-secondary, #a0a0b0)" />
                      <span style={{ color: "var(--text-secondary, #a0a0b0)" }}>{file.path}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Past Similar Changes from Phase 2 Memory */}
          {prediction && prediction.similarPastChanges.length > 0 && (
            <div style={SECTION_STYLE}>
              <button
                onClick={() => setShowMemory(!showMemory)}
                style={{
                  ...SECTION_TITLE_STYLE,
                  background: "none",
                  border: "none",
                  width: "100%",
                  textAlign: "left",
                  cursor: "pointer",
                  fontFamily: "inherit",
                }}
              >
                {showMemory ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                <Brain size={14} />
                Past Similar Changes ({prediction.similarPastChanges.length})
              </button>

              {showMemory && (
                <div style={{ marginTop: "8px", maxHeight: "300px", overflow: "auto" }}>
                  {prediction.similarPastChanges.map((mem) => (
                    <div key={mem.id} style={MEMORY_ROW_STYLE}>
                      {getSeverityIcon(mem.severity)}
                      <div style={{ flex: 1 }}>
                        <div style={{ fontWeight: 600, marginBottom: "2px" }}>
                          {mem.title}
                          <span style={{
                            fontSize: "10px",
                            marginLeft: "6px",
                            padding: "1px 6px",
                            borderRadius: "4px",
                            background: "var(--bg-input, #1a1a2e)",
                            color: "var(--text-secondary, #a0a0b0)",
                          }}>
                            {mem.memory_type.replace(/_/g, " ")}
                          </span>
                        </div>
                        <div style={{ color: "var(--text-secondary, #a0a0b0)", lineHeight: 1.4 }}>
                          {mem.description.slice(0, 120)}
                          {mem.description.length > 120 ? "..." : ""}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Dependency Diagram placeholder */}
          <div style={SECTION_STYLE}>
            <div style={SECTION_TITLE_STYLE}>
              <GitBranch size={14} />
              Dependency Diagram
            </div>
            <div
              style={{
                height: "200px",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                background: "var(--bg-input, #1a1a2e)",
                borderRadius: "6px",
                color: "var(--text-secondary, #a0a0b0)",
                fontSize: "12px",
              }}
            >
              <div style={{ textAlign: "center" }}>
                <GitBranch size={32} style={{ marginBottom: "8px", opacity: 0.5 }} />
                <div>Force-directed graph rendering available</div>
                <div style={{ fontSize: "10px", marginTop: "4px" }}>
                  Install d3-force or vis-network to enable interactive diagram
                </div>
              </div>
            </div>
          </div>

          {/* Footer with architecture stats */}
          {archMap && (
            <div style={{
              padding: "12px 16px",
              borderTop: "1px solid var(--border-color, #2a2a4a)",
              fontSize: "10px",
              color: "var(--text-secondary, #a0a0b0)",
              display: "flex",
              gap: "12px",
            }}>
              <span>{archMap.getStats().totalFiles} files indexed</span>
              <span>{archMap.getStats().totalModules} modules</span>
              <span>{archMap.getStats().totalSystems} systems</span>
            </div>
          )}
        </>
      )}

      {/* Empty state */}
      {!loading && !impact && (
        <div style={{ padding: "32px 16px", textAlign: "center", color: "var(--text-secondary, #a0a0b0)" }}>
          <Search size={24} style={{ marginBottom: "8px", opacity: 0.5 }} />
          <div style={{ fontSize: "12px" }}>
            Describe a proposed change above to analyze its impact
          </div>
          <div style={{ fontSize: "10px", marginTop: "4px", opacity: 0.7 }}>
            e.g., "Add multi-tenant support", "Refactor authentication", "Migrate to TypeScript strict mode"
          </div>
        </div>
      )}
    </div>
  );
}

// ── Sub-component: Prediction Stat ──────────────────────────────────────────

function PredictionStat({
  label,
  value,
  extra,
}: {
  label: string;
  value: string;
  extra?: string;
}) {
  return (
    <div
      style={{
        padding: "8px 12px",
        background: "var(--bg-input, #1a1a2e)",
        borderRadius: "6px",
        minWidth: "100px",
      }}
    >
      <div style={{ fontSize: "10px", color: "var(--text-secondary, #a0a0b0)", marginBottom: "2px" }}>
        {label}
      </div>
      <div style={{ fontSize: "12px", fontWeight: 600 }}>
        {value}
        {extra && (
          <span style={{ fontSize: "10px", color: "var(--text-secondary, #a0a0b0)", marginLeft: "4px" }}>
            ({extra})
          </span>
        )}
      </div>
    </div>
  );
}