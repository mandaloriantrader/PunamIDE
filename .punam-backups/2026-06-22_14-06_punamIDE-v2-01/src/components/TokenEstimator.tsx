import { useState, useEffect, useRef } from "react";

// ─── Types ────────────────────────────────────────────────────────────────────

interface Tab {
  path: string;
  name: string;
  content: string;
}

interface TokenEstimate {
  messageTokens: number;
  contextTokens: number;
  totalTokens: number;
  filesIncluded: string[];
  isCasual: boolean;
  tier: "minimal" | "light" | "medium" | "heavy";
}

// ─── Token Estimation Helpers ─────────────────────────────────────────────────

// Rough approximation: 1 token ≈ 4 chars (standard heuristic)
const charsToTokens = (chars: number) => Math.ceil(chars / 4);

const CASUAL_PATTERNS =
  /^(hi|hello|hey|thanks|thank you|ok|okay|sure|yes|no|lol|cool|nice|got it|great)[\s!?.]*$/i;

const CODE_PATTERNS =
  /line|function|class|error|bug|fix|explain|refactor|what|how|why|where|show|read|check|find|write|create|update|delete/i;

function estimateTokens(
  message: string,
  tabs: Tab[],
  activeTabPath: string | null
): TokenEstimate {
  const isCasual = CASUAL_PATTERNS.test(message.trim());
  const isCodeQuery = CODE_PATTERNS.test(message);

  const messageTokens = charsToTokens(message.length);
  const filesIncluded: string[] = [];

  if (isCasual || !tabs.length) {
    return {
      messageTokens,
      contextTokens: 0,
      totalTokens: messageTokens,
      filesIncluded: [],
      isCasual: true,
      tier: "minimal",
    };
  }

  const mentionedFiles = tabs.filter(
    (tab) =>
      message.toLowerCase().includes(tab.name.toLowerCase()) ||
      message.toLowerCase().includes(tab.path.toLowerCase())
  );

  const activeTab = tabs.find((t) => t.path === activeTabPath) ?? null;

  const filesToInclude = isCodeQuery
    ? [...new Set([activeTab, ...mentionedFiles].filter(Boolean))] as Tab[]
    : mentionedFiles;

  const FILE_CHAR_LIMIT = 60000;
  const TOTAL_CHAR_LIMIT = 120000;
  let totalChars = 0;

  for (const tab of filesToInclude) {
    if (totalChars >= TOTAL_CHAR_LIMIT) break;
    const remaining = TOTAL_CHAR_LIMIT - totalChars;
    const maxForFile = Math.min(FILE_CHAR_LIMIT, remaining);
    const used = Math.min(tab.content.length, maxForFile);
    totalChars += used;
    filesIncluded.push(tab.name);
  }

  const contextTokens = charsToTokens(totalChars);
  const totalTokens = messageTokens + contextTokens;

  const tier =
    totalTokens < 500
      ? "minimal"
      : totalTokens < 3000
      ? "light"
      : totalTokens < 15000
      ? "medium"
      : "heavy";

  return {
    messageTokens,
    contextTokens,
    totalTokens,
    filesIncluded,
    isCasual,
    tier,
  };
}

function formatTokens(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return `${n}`;
}

// ─── Tier Config ──────────────────────────────────────────────────────────────

const TIER_CONFIG = {
  minimal: {
    color: "#4ade80",
    bg: "rgba(74,222,128,0.08)",
    border: "rgba(74,222,128,0.25)",
    label: "minimal",
    dot: "#4ade80",
  },
  light: {
    color: "#60a5fa",
    bg: "rgba(96,165,250,0.08)",
    border: "rgba(96,165,250,0.25)",
    label: "light",
    dot: "#60a5fa",
  },
  medium: {
    color: "#fbbf24",
    bg: "rgba(251,191,36,0.08)",
    border: "rgba(251,191,36,0.25)",
    label: "medium",
    dot: "#fbbf24",
  },
  heavy: {
    color: "#f87171",
    bg: "rgba(248,113,113,0.08)",
    border: "rgba(248,113,113,0.25)",
    label: "heavy",
    dot: "#f87171",
  },
};

// ─── Main Component ───────────────────────────────────────────────────────────

interface TokenEstimatorProps {
  message: string;
  tabs: Tab[];
  activeTabPath: string | null;
  /** Called with final prompt string when user submits */
  onSend: (prompt: string) => void;
}

export default function TokenEstimator({
  message,
  tabs,
  activeTabPath,
  onSend,
}: TokenEstimatorProps) {
  const [estimate, setEstimate] = useState<TokenEstimate | null>(null);
  const [showBreakdown, setShowBreakdown] = useState(false);
  const [prevTier, setPrevTier] = useState<string | null>(null);
  const [flash, setFlash] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      if (!message.trim()) {
        setEstimate(null);
        return;
      }
      const est = estimateTokens(message, tabs, activeTabPath);
      setEstimate((prev) => {
        if (prev?.tier !== est.tier) {
          setPrevTier(prev?.tier ?? null);
          setFlash(true);
          setTimeout(() => setFlash(false), 400);
        }
        return est;
      });
    }, 120);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [message, tabs, activeTabPath]);

  if (!estimate || !message.trim()) return null;

  const cfg = TIER_CONFIG[estimate.tier];

  return (
    <div style={styles.wrapper}>
      {/* ── Pill ── */}
      <button
        onClick={() => setShowBreakdown((v) => !v)}
        style={{
          ...styles.pill,
          backgroundColor: cfg.bg,
          border: `1px solid ${cfg.border}`,
          color: cfg.color,
          ...(flash ? styles.pillFlash : {}),
        }}
        title="Click to see token breakdown"
      >
        {/* animated dot */}
        <span
          style={{
            ...styles.dot,
            backgroundColor: cfg.dot,
            boxShadow: `0 0 6px ${cfg.dot}`,
          }}
        />
        <span style={styles.pillText}>
          ~{formatTokens(estimate.totalTokens)} tokens
        </span>
        <span style={{ ...styles.tierBadge, color: cfg.color }}>
          {cfg.label}
        </span>
        <span style={styles.chevron}>{showBreakdown ? "▲" : "▼"}</span>
      </button>

      {/* ── Breakdown panel ── */}
      {showBreakdown && (
        <div
          style={{
            ...styles.breakdown,
            borderColor: cfg.border,
          }}
        >
          <div style={styles.breakdownTitle}>Token Breakdown</div>

          <div style={styles.row}>
            <span style={styles.rowLabel}>Your message</span>
            <span style={styles.rowValue}>
              ~{formatTokens(estimate.messageTokens)}
            </span>
          </div>

          <div style={styles.row}>
            <span style={styles.rowLabel}>File context</span>
            <span style={styles.rowValue}>
              ~{formatTokens(estimate.contextTokens)}
            </span>
          </div>

          <div style={{ ...styles.row, ...styles.totalRow }}>
            <span style={styles.rowLabel}>Total input</span>
            <span style={{ ...styles.rowValue, color: cfg.color }}>
              ~{formatTokens(estimate.totalTokens)}
            </span>
          </div>

          {estimate.filesIncluded.length > 0 ? (
            <div style={styles.files}>
              <div style={styles.filesLabel}>Files included:</div>
              {estimate.filesIncluded.map((f) => (
                <div key={f} style={styles.fileChip}>
                  <span style={styles.fileIcon}>📄</span> {f}
                </div>
              ))}
            </div>
          ) : (
            <div style={styles.noFiles}>
              {estimate.isCasual
                ? "No files attached — casual message detected"
                : "No file context attached"}
            </div>
          )}

          {/* Cost hint */}
          <div style={styles.costHint}>
            {estimate.tier === "heavy" &&
              "⚠️ Large context — consider narrowing your question"}
            {estimate.tier === "medium" &&
              "Moderate context — looks reasonable"}
            {estimate.tier === "light" && "✓ Efficient context"}
            {estimate.tier === "minimal" && "✓ Minimal — no file context sent"}
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const styles: Record<string, React.CSSProperties> = {
  wrapper: {
    position: "relative",
    display: "inline-flex",
    flexDirection: "column",
    alignItems: "flex-start",
    fontFamily: "'JetBrains Mono', 'Fira Code', monospace",
    fontSize: "11px",
    userSelect: "none",
    zIndex: 10,
  },
  pill: {
    display: "inline-flex",
    alignItems: "center",
    gap: "5px",
    padding: "3px 8px 3px 6px",
    borderRadius: "20px",
    cursor: "pointer",
    fontSize: "11px",
    fontFamily: "inherit",
    transition: "all 0.2s ease",
    outline: "none",
  },
  pillFlash: {
    transform: "scale(1.06)",
  },
  dot: {
    width: "6px",
    height: "6px",
    borderRadius: "50%",
    flexShrink: 0,
    animation: "pulse 2s infinite",
  },
  pillText: {
    fontWeight: 600,
    letterSpacing: "0.02em",
  },
  tierBadge: {
    opacity: 0.7,
    fontSize: "10px",
    textTransform: "uppercase",
    letterSpacing: "0.06em",
  },
  chevron: {
    fontSize: "8px",
    opacity: 0.6,
    marginLeft: "2px",
  },
  breakdown: {
    position: "absolute",
    bottom: "calc(100% + 6px)",
    left: 0,
    minWidth: "220px",
    backgroundColor: "#1a1a2e",
    border: "1px solid",
    borderRadius: "10px",
    padding: "12px 14px",
    boxShadow: "0 8px 32px rgba(0,0,0,0.5)",
    backdropFilter: "blur(12px)",
  },
  breakdownTitle: {
    color: "#888",
    fontSize: "10px",
    textTransform: "uppercase",
    letterSpacing: "0.1em",
    marginBottom: "10px",
  },
  row: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    padding: "3px 0",
    borderBottom: "1px solid rgba(255,255,255,0.04)",
  },
  totalRow: {
    borderBottom: "none",
    marginTop: "4px",
    paddingTop: "6px",
    borderTop: "1px solid rgba(255,255,255,0.1)",
    fontWeight: 700,
  },
  rowLabel: {
    color: "#aaa",
    fontSize: "11px",
  },
  rowValue: {
    color: "#eee",
    fontSize: "11px",
    fontWeight: 600,
  },
  files: {
    marginTop: "10px",
  },
  filesLabel: {
    color: "#666",
    fontSize: "10px",
    textTransform: "uppercase",
    letterSpacing: "0.08em",
    marginBottom: "5px",
  },
  fileChip: {
    display: "flex",
    alignItems: "center",
    gap: "4px",
    color: "#ccc",
    fontSize: "11px",
    padding: "2px 0",
  },
  fileIcon: {
    fontSize: "10px",
  },
  noFiles: {
    marginTop: "8px",
    color: "#555",
    fontSize: "10px",
    fontStyle: "italic",
  },
  costHint: {
    marginTop: "10px",
    color: "#666",
    fontSize: "10px",
    lineHeight: 1.4,
    borderTop: "1px solid rgba(255,255,255,0.05)",
    paddingTop: "8px",
  },
};
