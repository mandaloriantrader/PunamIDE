/**
 * SecurityPanel.tsx — Phase 6, Step 6.5
 *
 * Security vulnerability dashboard showing scan results, severity breakdown,
 * threat analysis, and fix suggestions.
 */

import { useState, useEffect, useCallback } from "react";
import {
  Shield,
  ShieldAlert,
  ShieldCheck,
  ShieldOff,
  AlertTriangle,
  AlertCircle,
  Info,
  Loader2,
  Search,
  FileCode,
  ChevronDown,
  ChevronRight,
  RefreshCw,
  CheckCircle2,
  XCircle,
  TrendingUp,
  TrendingDown,
  BarChart3,
} from "lucide-react";
import type { SecurityFinding, Severity } from "../services/security/SecurityPatterns";
import { scanFile } from "../services/security/SecurityPatterns";
import { ThreatAnalyzer } from "../services/security/ThreatAnalyzer";
import type { ThreatSummary, TrendDataPoint } from "../services/security/ThreatAnalyzer";
import {
  VulnerabilityDatabase,
  getVulnerabilityDatabase,
} from "../services/security/VulnerabilityDatabase";
import { invoke } from "@tauri-apps/api/core";

const SECURITY_SCAN_FILE_LIMIT = 50;
const SECURITY_SCAN_DEPTH_LIMIT = 4;

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

const SUMMARY_ROW_STYLE: React.CSSProperties = {
  padding: "12px 16px",
  display: "flex",
  gap: "12px",
  borderBottom: "1px solid var(--border-color, #2a2a4a)",
  flexShrink: 0,
};

const SEVERITY_COLORS: Record<Severity, string> = {
  critical: "#ef4444",
  high: "#f87171",
  medium: "#fbbf24",
  low: "#6b7280",
};

const SEVERITY_BG: Record<Severity, string> = {
  critical: "#7f1d1d30",
  high: "#991b1b20",
  medium: "#92400e20",
  low: "#37415130",
};

const FINDING_ITEM_STYLE: React.CSSProperties = {
  padding: "8px 16px",
  borderBottom: "1px solid var(--border-color, #2a2a4a20)",
  fontSize: "11px",
};

const SECTION_STYLE: React.CSSProperties = {
  margin: "12px 16px",
  padding: "14px",
  background: "var(--bg-card, #16162a)",
  border: "1px solid var(--border-color, #2a2a4a)",
  borderRadius: "8px",
};

// ── Component ─────────────────────────────────────────────────────────────────

export default function SecurityPanel({ projectPath }: { projectPath?: string }) {
  const [db] = useState(() => getVulnerabilityDatabase());
  const [analyzer] = useState(() => new ThreatAnalyzer());
  const [findings, setFindings] = useState<SecurityFinding[]>(() => db.getCurrentFindings());
  const [summary, setSummary] = useState<ThreatSummary | null>(null);
  const [scanStats, setScanStats] = useState({
    filesScanned: 0,
    filesDiscovered: 0,
    capped: false,
    skippedFiles: 0,
    lastScanAt: 0,
  });
  const [scanning, setScanning] = useState(false);
  const [health, setHealth] = useState<"critical" | "warning" | "good">("good");
  const [showAll, setShowAll] = useState(false);
  const [showOwasp, setShowOwasp] = useState(false);
  const [activeFilter, setActiveFilter] = useState<Severity | "all">("all");

  // Recompute summary when findings change
  useEffect(() => {
    if (findings.length > 0) {
      const s = analyzer.summarize(findings);
      setSummary(s);
      setHealth(analyzer.getHealthStatus(s));
    } else {
      setSummary(null);
      setHealth("good");
    }
  }, [findings, analyzer]);

  const handleScan = useCallback(async () => {
    setScanning(true);
    try {
      const allFindings: SecurityFinding[] = [];
      let scannedFiles: string[] = [];

      if (projectPath) {
        // Get list of source files to scan via Tauri
        const { readDir } = await import("@tauri-apps/plugin-fs");

        // Collect scannable source files (recursive, limited to common extensions)
        const scanExtensions = new Set(["ts", "tsx", "js", "jsx", "py", "rs", "go", "java", "rb", "php", "html", "sql"]);
        const filesToScan: string[] = [];
        let capped = false;

        const collectFiles = async (dirPath: string, depth = 0) => {
          if (depth > SECURITY_SCAN_DEPTH_LIMIT) return;
          try {
            const items = await readDir(dirPath).catch(() => []);
            for (const item of items) {
              if (filesToScan.length >= SECURITY_SCAN_FILE_LIMIT) {
                capped = true;
                return;
              }
              const fullPath = `${dirPath}${dirPath.endsWith("\\") || dirPath.endsWith("/") ? "" : "\\"}${item.name}`;
              if (item.isDirectory) {
                // Skip node_modules, .git, dist, build, target
                if (/^(node_modules|\.git|dist|build|target|\.punam-backups)$/i.test(item.name)) continue;
                await collectFiles(fullPath, depth + 1);
              } else {
                const ext = item.name.split(".").pop()?.toLowerCase() || "";
                if (scanExtensions.has(ext)) {
                  filesToScan.push(fullPath);
                }
              }
            }
          } catch { /* skip unreadable dirs */ }
        };

        await collectFiles(projectPath);
        const scanTargets = filesToScan.slice(0, SECURITY_SCAN_FILE_LIMIT);
        scannedFiles = scanTargets;

        // Scan each file via Rust security scanner
        for (const filePath of scanTargets) {
          try {
            const result = await invoke<{
              file_path: string;
              findings: SecurityFinding[];
            }>("security_scan_file", { filePath });
            if (result?.findings?.length > 0) {
              allFindings.push(...result.findings);
            }
          } catch { /* skip files that fail to scan */ }
        }

        setScanStats({
          filesScanned: scanTargets.length,
          filesDiscovered: filesToScan.length,
          capped,
          skippedFiles: Math.max(0, filesToScan.length - scanTargets.length),
          lastScanAt: Date.now(),
        });
      } else {
        setScanStats({
          filesScanned: 0,
          filesDiscovered: 0,
          capped: false,
          skippedFiles: 0,
          lastScanAt: Date.now(),
        });
      }

      db.addScan({
        id: `scan-${Date.now()}`,
        timestamp: Date.now(),
        filesScanned: scannedFiles,
        findings: allFindings,
        trendPoint: analyzer.createTrendPoint(allFindings),
      });

      setFindings(allFindings);
    } catch (err) {
      console.warn("[Security] Scan failed:", err);
    } finally {
      setScanning(false);
    }
  }, [db, analyzer, projectPath]);

  const filteredFindings =
    activeFilter === "all"
      ? findings
      : findings.filter((f) => f.severity === activeFilter);

  const displayedFindings = showAll ? filteredFindings : filteredFindings.slice(0, 20);
  const hasRunScan = scanStats.lastScanAt > 0;

  // ── Render Helpers ───────────────────────────────────────────────────────

  const renderSeverityBadge = (severity: Severity) => (
    <span
      style={{
        display: "inline-block",
        padding: "2px 8px",
        borderRadius: "4px",
        fontSize: "10px",
        fontWeight: 600,
        background: SEVERITY_BG[severity],
        color: SEVERITY_COLORS[severity],
      }}
    >
      {severity.toUpperCase()}
    </span>
  );

  const renderSeverityIcon = (severity: Severity) => {
    switch (severity) {
      case "critical": return <XCircle size={14} color={SEVERITY_COLORS.critical} />;
      case "high": return <AlertTriangle size={14} color={SEVERITY_COLORS.high} />;
      case "medium": return <AlertCircle size={14} color={SEVERITY_COLORS.medium} />;
      default: return <Info size={14} color={SEVERITY_COLORS.low} />;
    }
  };

  const renderHealthIcon = () => {
    switch (health) {
      case "critical": return <ShieldOff size={16} color="#ef4444" />;
      case "warning": return <ShieldAlert size={16} color="#fbbf24" />;
      case "good": return <ShieldCheck size={16} color="#34d399" />;
    }
  };

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div style={PANEL_STYLE}>
      {/* Header */}
      <div style={HEADER_STYLE}>
        {renderHealthIcon()}
        Security Scanner
        <span style={{ fontSize: "10px", color: "var(--text-secondary, #a0a0b0)", marginLeft: "auto" }}>
          Phase 6
        </span>
      </div>

      {/* Summary Row */}
      <div style={SUMMARY_ROW_STYLE}>
        <SeverityCount
          severity="critical"
          count={summary?.criticalCount ?? 0}
          onClick={() => setActiveFilter(activeFilter === "critical" ? "all" : "critical")}
          active={activeFilter === "critical"}
        />
        <SeverityCount
          severity="high"
          count={summary?.highCount ?? 0}
          onClick={() => setActiveFilter(activeFilter === "high" ? "all" : "high")}
          active={activeFilter === "high"}
        />
        <SeverityCount
          severity="medium"
          count={summary?.mediumCount ?? 0}
          onClick={() => setActiveFilter(activeFilter === "medium" ? "all" : "medium")}
          active={activeFilter === "medium"}
        />
        <SeverityCount
          severity="low"
          count={summary?.lowCount ?? 0}
          onClick={() => setActiveFilter(activeFilter === "low" ? "all" : "low")}
          active={activeFilter === "low"}
        />
      </div>

      {/* Action bar */}
      <div style={{ padding: "8px 16px", display: "flex", gap: "8px", borderBottom: "1px solid var(--border-color, #2a2a4a)", flexShrink: 0 }}>
        <button
          onClick={handleScan}
          disabled={scanning}
          style={{
            padding: "6px 14px",
            background: "var(--accent-color, #3b82f6)",
            border: "none",
            borderRadius: "6px",
            color: "#fff",
            fontSize: "11px",
            fontWeight: 600,
            cursor: scanning ? "not-allowed" : "pointer",
            display: "flex",
            alignItems: "center",
            gap: "6px",
            fontFamily: "inherit",
            opacity: scanning ? 0.5 : 1,
          }}
        >
          {scanning ? (
            <>
              <Loader2 size={12} style={{ animation: "spin 1s linear infinite" }} />
              Scanning...
            </>
          ) : (
            <>
              <RefreshCw size={12} />
              Scan Project
            </>
          )}
        </button>
        {hasRunScan && (
          <span style={{ alignSelf: "center", fontSize: "10px", color: "var(--text-secondary, #a0a0b0)" }}>
            Scanned {scanStats.filesScanned} file{scanStats.filesScanned === 1 ? "" : "s"}
            {scanStats.capped ? ` · capped at ${SECURITY_SCAN_FILE_LIMIT}` : ""}
            {scanStats.lastScanAt ? ` · ${new Date(scanStats.lastScanAt).toLocaleTimeString()}` : ""}
          </span>
        )}
        {activeFilter !== "all" && (
          <button
            onClick={() => setActiveFilter("all")}
            style={{
              padding: "6px 12px",
              background: "transparent",
              border: "1px solid var(--border-color, #2a2a4a)",
              borderRadius: "6px",
              color: "var(--text-secondary, #a0a0b0)",
              fontSize: "11px",
              cursor: "pointer",
              fontFamily: "inherit",
            }}
          >
            Clear Filter
          </button>
        )}
      </div>

      {/* Scanning state */}
      {scanning && findings.length === 0 && (
        <div style={{ padding: "32px", textAlign: "center", color: "var(--text-secondary, #a0a0b0)" }}>
          <Loader2 size={24} style={{ marginBottom: "8px", animation: "spin 1s linear infinite" }} />
          <div style={{ fontSize: "12px" }}>Scanning project for vulnerabilities...</div>
        </div>
      )}

      {/* Findings list */}
      {!scanning && findings.length > 0 && (
        <>
          <div style={{ padding: "8px 16px", fontSize: "11px", color: "var(--text-secondary, #a0a0b0)", flexShrink: 0 }}>
            {findings.length} finding(s) across {summary?.byFile ? Object.keys(summary.byFile).length : 0} file(s) · scanned {scanStats.filesScanned} file{scanStats.filesScanned === 1 ? "" : "s"}
          </div>

          {displayedFindings.map((f, i) => (
            <div key={`${f.patternId}:${f.filePath}:${f.line}:${i}`} style={FINDING_ITEM_STYLE}>
              <div style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "4px" }}>
                {renderSeverityIcon(f.severity)}
                {renderSeverityBadge(f.severity)}
                <span style={{ fontSize: "10px", color: "var(--text-secondary, #a0a0b0)" }}>
                  {f.owasp}
                </span>
                <span style={{ flex: 1, fontSize: "11px", fontWeight: 500 }}>
                  {f.description}
                </span>
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: "6px", marginLeft: "22px", marginBottom: "4px" }}>
                <FileCode size={10} color="var(--text-secondary, #a0a0b0)" />
                <span style={{ fontSize: "10px", color: "var(--accent-color, #60a5fa)" }}>
                  {f.filePath}:{f.line}:{f.column}
                </span>
              </div>
              <div style={{ marginLeft: "22px", fontSize: "10px", color: "var(--text-secondary, #a0a0b0)", lineHeight: 1.4 }}>
                <span style={{ color: "#fbbf24" }}>Fix: </span>
                {f.suggestion}
              </div>
              {f.cwe && (
                <div style={{ marginLeft: "22px", fontSize: "9px", color: "var(--text-secondary, #a0a0b0)", marginTop: "2px" }}>
                  CWE-{f.cwe}
                </div>
              )}
            </div>
          ))}

          {filteredFindings.length > 20 && !showAll && (
            <button
              onClick={() => setShowAll(true)}
              style={{
                padding: "8px",
                textAlign: "center",
                background: "none",
                border: "none",
                color: "var(--accent-color, #3b82f6)",
                fontSize: "11px",
                cursor: "pointer",
                fontFamily: "inherit",
                width: "100%",
              }}
            >
              Show all {filteredFindings.length} findings...
            </button>
          )}

          {/* OWASP Breakdown */}
          {summary && (
            <div style={SECTION_STYLE}>
              <button
                onClick={() => setShowOwasp(!showOwasp)}
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
                }}
              >
                {showOwasp ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                <BarChart3 size={14} />
                OWASP Breakdown
              </button>

              {showOwasp && (
                <div style={{ marginTop: "8px" }}>
                  {Object.entries(summary.byOwasp)
                    .sort(([, a], [, b]) => b - a)
                    .map(([owasp, count]) => (
                      <div
                        key={owasp}
                        style={{
                          display: "flex",
                          justifyContent: "space-between",
                          padding: "4px 0",
                          fontSize: "11px",
                          borderBottom: "1px solid var(--border-color, #2a2a4a20)",
                        }}
                      >
                        <span style={{ color: "var(--text-primary, #e0e0e0)" }}>{owasp}</span>
                        <span style={{ color: "var(--text-secondary, #a0a0b0)" }}>{count}</span>
                      </div>
                    ))}
                </div>
              )}
            </div>
          )}

          {/* Recommendations */}
          {summary && (
            <div style={SECTION_STYLE}>
              <div style={{ fontSize: "12px", fontWeight: 600, color: "var(--text-secondary, #a0a0b0)", marginBottom: "8px", display: "flex", alignItems: "center", gap: "6px" }}>
                <AlertTriangle size={14} color="#fbbf24" />
                Recommendations
              </div>
              {analyzer.generateRecommendations(summary).map((rec, i) => (
                <div
                  key={i}
                  style={{
                    fontSize: "11px",
                    color: "var(--text-secondary, #a0a0b0)",
                    padding: "3px 0",
                    lineHeight: 1.5,
                  }}
                >
                  • {rec}
                </div>
              ))}
            </div>
          )}
        </>
      )}

      {/* Empty state */}
      {!scanning && findings.length === 0 && (
        <div style={{ padding: "32px 16px", textAlign: "center", color: "var(--text-secondary, #a0a0b0)" }}>
          <ShieldCheck size={32} style={{ marginBottom: "8px", opacity: 0.5 }} />
          <div style={{ fontSize: "12px" }}>
            {hasRunScan ? "No matching security patterns found" : "No scan run yet"}
          </div>
          <div style={{ fontSize: "10px", marginTop: "4px", opacity: 0.7 }}>
            {hasRunScan
              ? `Scanned ${scanStats.filesScanned} source file${scanStats.filesScanned === 1 ? "" : "s"}. Pattern-based scan checks known risky code patterns.`
              : "Run a scan to check the project for known risky code patterns."}
          </div>
          {hasRunScan && scanStats.capped && (
            <div style={{ fontSize: "10px", marginTop: "8px", color: "#fbbf24", lineHeight: 1.4 }}>
              Scan limit reached. First {SECURITY_SCAN_FILE_LIMIT} source files were checked; deeper files may not be covered yet.
            </div>
          )}
        </div>
      )}

      {/* Footer */}
      <div style={{
        padding: "8px 16px",
        borderTop: "1px solid var(--border-color, #2a2a4a)",
        fontSize: "10px",
        color: "var(--text-secondary, #a0a0b0)",
        marginTop: "auto",
      }}>
        Security scan: pattern-based source code analysis. Critical findings block AI patch apply.
      </div>
    </div>
  );
}

// ── Sub-component: Severity Count ────────────────────────────────────────────

function SeverityCount({
  severity,
  count,
  onClick,
  active,
}: {
  severity: Severity;
  count: number;
  onClick: () => void;
  active: boolean;
}) {
  const icons: Record<Severity, React.ReactNode> = {
    critical: <XCircle size={12} />,
    high: <AlertTriangle size={12} />,
    medium: <AlertCircle size={12} />,
    low: <Info size={12} />,
  };

  return (
    <button
      onClick={onClick}
      style={{
        flex: 1,
        padding: "8px",
        background: active ? SEVERITY_BG[severity] : "var(--bg-input, #16162a)",
        border: `1px solid ${active ? SEVERITY_COLORS[severity] : "var(--border-color, #2a2a4a)"}`,
        borderRadius: "6px",
        color: SEVERITY_COLORS[severity],
        cursor: "pointer",
        fontFamily: "inherit",
        textAlign: "center",
      }}
    >
      <div style={{ display: "flex", justifyContent: "center", marginBottom: "2px" }}>
        {icons[severity]}
      </div>
      <div style={{ fontSize: "16px", fontWeight: 700 }}>{count}</div>
      <div style={{ fontSize: "9px", opacity: 0.7, marginTop: "2px" }}>
        {severity}
      </div>
    </button>
  );
}
