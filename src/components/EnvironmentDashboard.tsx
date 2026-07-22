/**
 * EnvironmentDashboard.tsx — Phase 4, Step 4.6
 *
 * UI dashboard showing detected tools, versions, project dependencies,
 * and one-click install/repair actions.
 */

import { useState, useEffect, useCallback } from "react";
import {
  Monitor,
  Wrench,
  Package,
  Box,
  CheckCircle2,
  XCircle,
  AlertTriangle,
  Loader2,
  RefreshCw,
  Terminal,
  ChevronDown,
  ChevronRight,
  ExternalLink,
} from "lucide-react";
import { getToolOrchestrator } from "../services/tooling/ToolOrchestrator";
import { getEnvironmentManager } from "../services/tooling/EnvironmentManager";
import { getDependencyResolver } from "../services/tooling/DependencyResolver";
import { getInstallationEngine } from "../services/tooling/InstallationEngine";
import type { ToolInfo, EnvironmentScanResult, EnvironmentSummary, DockerContainerInfo } from "../services/tooling/ToolOrchestrator";
import type { EnvironmentState, DependencyAlert, ToolCategory } from "../services/tooling/EnvironmentManager";
import type { DependencyHealth, ProjectManifestInfo } from "../services/tooling/DependencyResolver";
import type { InstallResult } from "../services/tooling/InstallationEngine";

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

const TOOL_ROW_STYLE: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "10px",
  padding: "8px 16px",
  borderBottom: "1px solid var(--border-color, #2a2a4a20)",
  fontSize: "12px",
};

const SECTION_STYLE: React.CSSProperties = {
  margin: "10px 16px",
  padding: "12px",
  background: "var(--bg-card, #16162a)",
  border: "1px solid var(--border-color, #2a2a4a)",
  borderRadius: "8px",
};

const CATEGORY_COLORS: Record<string, string> = {
  runtime: "#3b82f6",
  package_manager: "#10b981",
  container: "#f59e0b",
  vcs: "#8b5cf6",
  cloud: "#ec4899",
};

// ── Component ─────────────────────────────────────────────────────────────────

export default function EnvironmentDashboard() {
  const [scan, setScan] = useState<EnvironmentScanResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showRuntimes, setShowRuntimes] = useState(true);
  const [showPkgMgrs, setShowPkgMgrs] = useState(true);
  const [showOther, setShowOther] = useState(true);
  const [installing, setInstalling] = useState<string | null>(null);
  const [installResult, setInstallResult] = useState<InstallResult | null>(null);

  const handleInstall = useCallback(async (toolName: string) => {
    setInstalling(toolName);
    setInstallResult(null);
    try {
      const engine = await getInstallationEngine();
      const result = await engine.installTool(toolName);
      setInstallResult(result);
      if (result.success) {
        // Re-scan after successful install
        handleScan();
      }
    } catch (err) {
      setInstallResult({ success: false, toolName, output: String(err), command: "", durationMs: 0 });
    } finally {
      setInstalling(null);
    }
  }, []);

  const handleScan = useCallback(async (force = false) => {
    setLoading(true);
    setError(null);
    try {
      const orchestrator = getToolOrchestrator();
      const result = await orchestrator.scanEnvironment(force);
      setScan(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Scan failed");
    } finally {
      setLoading(false);
    }
  }, []);

  // Auto-scan on mount
  useEffect(() => {
    handleScan();
  }, [handleScan]);

  // ── Render helpers ───────────────────────────────────────────────────────

  const toolsByCategory = (category: string) =>
    scan?.tools.filter((t) => t.category === category) || [];

  const renderToolRow = (tool: ToolInfo) => (
    <div key={tool.name} style={TOOL_ROW_STYLE}>
      {tool.installed ? (
        <CheckCircle2 size={14} color="#34d399" />
      ) : (
        <XCircle size={14} color="#6b7280" />
      )}
      <span
        style={{
          display: "inline-block",
          padding: "1px 6px",
          borderRadius: "4px",
          fontSize: "9px",
          fontWeight: 600,
          background: `${CATEGORY_COLORS[tool.category] || "#6b7280"}20`,
          color: CATEGORY_COLORS[tool.category] || "#6b7280",
        }}
      >
        {tool.category}
      </span>
      <span style={{ flex: 1, fontWeight: 500 }}>{tool.display_name}</span>
      <span style={{
        fontSize: "11px",
        color: tool.installed ? "var(--accent-color, #60a5fa)" : "var(--text-secondary, #6b7280)",
        fontFamily: "inherit",
        maxWidth: "200px",
        overflow: "hidden",
        textOverflow: "ellipsis",
        whiteSpace: "nowrap",
      }}>
        {tool.version}
      </span>
    </div>
  );

  const renderCategory = (
    title: string,
    category: string,
    expanded: boolean,
    toggle: () => void,
  ) => {
    const tools = toolsByCategory(category);
    const installed = tools.filter((t) => t.installed).length;
    const total = tools.length;

    return (
      <div style={SECTION_STYLE}>
        <button
          onClick={toggle}
          style={{
            display: "flex",
            alignItems: "center",
            gap: "6px",
            background: "none",
            border: "none",
            color: "var(--text-secondary, #a0a0b0)",
            fontSize: "12px",
            fontWeight: 600,
            cursor: "pointer",
            fontFamily: "inherit",
            width: "100%",
            textAlign: "left",
            padding: 0,
            marginBottom: expanded ? "8px" : "0",
          }}
        >
          {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          {title}
          <span style={{ fontSize: "10px", opacity: 0.7 }}>
            ({installed}/{total})
          </span>
        </button>
        {expanded && tools.map(renderToolRow)}
      </div>
    );
  };

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div style={PANEL_STYLE}>
      {/* Header */}
      <div style={HEADER_STYLE}>
        <Monitor size={16} />
        Environment Dashboard
        <span style={{ fontSize: "10px", color: "var(--text-secondary, #a0a0b0)", marginLeft: "auto" }}>
          Phase 4
        </span>
      </div>

      {/* Action bar */}
      <div style={{ padding: "8px 16px", display: "flex", gap: "8px", borderBottom: "1px solid var(--border-color, #2a2a4a)", flexShrink: 0 }}>
        <button
          onClick={() => handleScan()}
          disabled={loading}
          style={{
            padding: "6px 14px",
            background: "var(--accent-color, #3b82f6)",
            border: "none",
            borderRadius: "6px",
            color: "#fff",
            fontSize: "11px",
            fontWeight: 600,
            cursor: loading ? "not-allowed" : "pointer",
            display: "flex",
            alignItems: "center",
            gap: "6px",
            fontFamily: "inherit",
            opacity: loading ? 0.5 : 1,
          }}
        >
          {loading ? (
            <>
              <Loader2 size={12} style={{ animation: "spin 1s linear infinite" }} />
              Scanning...
            </>
          ) : (
            <>
              <RefreshCw size={12} />
              Rescan Tools
            </>
          )}
        </button>
      </div>

      {/* Error */}
      {error && (
        <div style={{ padding: "12px 16px", color: "#f87171", fontSize: "12px", background: "#7f1d1d20" }}>
          <AlertTriangle size={14} style={{ marginRight: "6px", verticalAlign: "middle" }} />
          {error}
        </div>
      )}

      {/* Loading */}
      {loading && !scan && (
        <div style={{ padding: "32px", textAlign: "center", color: "var(--text-secondary, #a0a0b0)" }}>
          <Loader2 size={24} style={{ marginBottom: "8px", animation: "spin 1s linear infinite" }} />
          <div style={{ fontSize: "12px" }}>Detecting installed tools...</div>
        </div>
      )}

      {/* Scan results */}
      {scan && (
        <>
          {/* Summary bar */}
          <div style={{
            padding: "10px 16px",
            display: "flex",
            gap: "16px",
            borderBottom: "1px solid var(--border-color, #2a2a4a)",
            flexShrink: 0,
            fontSize: "11px",
            color: "var(--text-secondary, #a0a0b0)",
          }}>
            <span>{scan.summary.total_installed}/{scan.summary.total_detected} installed</span>
            {scan.summary.total_missing > 0 && (
              <span style={{ color: "#fbbf24" }}>{scan.summary.total_missing} missing</span>
            )}
          </div>

          {/* Categories */}
          {renderCategory("Runtimes", "runtime", showRuntimes, () => setShowRuntimes(!showRuntimes))}
          {renderCategory("Package Managers", "package_manager", showPkgMgrs, () => setShowPkgMgrs(!showPkgMgrs))}
          {renderCategory("Other Tools", "container", showOther, () => setShowOther(!showOther))}
          {/* Also show vcs and cloud */}
          {(() => {
            const otherTools = scan.tools.filter(
              (t) => t.category === "vcs" || t.category === "cloud",
            );
            if (otherTools.length === 0) return null;
            return (
              <div style={SECTION_STYLE}>
                <div style={{ fontSize: "12px", fontWeight: 600, color: "var(--text-secondary, #a0a0b0)", marginBottom: "6px" }}>
                  Version Control & Cloud
                </div>
                {otherTools.map(renderToolRow)}
              </div>
            );
          })()}

          {/* Missing tools */}
          {scan.summary.missing_recommendations.length > 0 && (
            <div style={SECTION_STYLE}>
              <div style={{ fontSize: "12px", fontWeight: 600, color: "#fbbf24", marginBottom: "8px", display: "flex", alignItems: "center", gap: "6px" }}>
                <AlertTriangle size={14} />
                Missing Tools
              </div>
              {scan.tools.filter((t) => !t.installed).map((tool) => (
                <div
                  key={tool.name}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: "8px",
                    fontSize: "11px",
                    color: "var(--text-secondary, #a0a0b0)",
                    padding: "4px 0",
                    lineHeight: 1.5,
                  }}
                >
                  <XCircle size={12} color="#6b7280" />
                  <span style={{ flex: 1 }}>{tool.display_name}</span>
                  <button
                    onClick={() => handleInstall(tool.name)}
                    disabled={installing === tool.name}
                    style={{
                      padding: "2px 8px",
                      background: "#065f4620",
                      border: "1px solid #34d39940",
                      borderRadius: "4px",
                      color: "#34d399",
                      fontSize: "10px",
                      cursor: installing === tool.name ? "not-allowed" : "pointer",
                      fontFamily: "inherit",
                      opacity: installing === tool.name ? 0.5 : 1,
                    }}
                  >
                    {installing === tool.name ? "Installing..." : "Install"}
                  </button>
                </div>
              ))}
              {installResult && (
                <div style={{
                  marginTop: "8px",
                  padding: "6px 8px",
                  borderRadius: "4px",
                  fontSize: "10px",
                  background: installResult.success ? "#065f4620" : "#7f1d1d20",
                  color: installResult.success ? "#34d399" : "#f87171",
                }}>
                  {installResult.success ? "✓" : "✗"} {installResult.toolName}: {installResult.output.slice(0, 150)}
                </div>
              )}
            </div>
          )}
        </>
      )}

      {/* Footer */}
      <div style={{
        padding: "8px 16px",
        borderTop: "1px solid var(--border-color, #2a2a4a)",
        fontSize: "10px",
        color: "var(--text-secondary, #a0a0b0)",
        marginTop: "auto",
      }}>
        Tools detected via PATH scanning. Install missing tools for full Punam IDE feature support.
      </div>
    </div>
  );
}