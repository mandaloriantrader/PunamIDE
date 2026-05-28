/**
 * TokenPill — live token estimator shown in the chat input bar.
 * Shows estimated token count before sending, color-coded by tier.
 * Click to expand a breakdown of message vs file context tokens.
 */

import { useState, useEffect, useRef } from "react";
import type { OpenTabContext } from "../../types";

// ─── Helpers ──────────────────────────────────────────────────────────────────

const charsToTokens = (chars: number) => Math.ceil(chars / 4);

const CASUAL_PATTERN =
  /^(hi|hello|hey|thanks|thank you|ok|okay|sure|yes|no|lol|cool|nice|got it|great)[\s!?.]*$/i;

const CODE_PATTERN =
  /line|function|class|error|bug|fix|explain|refactor|what|how|why|where|show|read|check|find|write|create|update|delete/i;

const FILE_CHAR_LIMIT = 60000;
const TOTAL_CHAR_LIMIT = 120000;

interface TokenEstimate {
  messageTokens: number;
  contextTokens: number;
  totalTokens: number;
  filesIncluded: string[];
  isCasual: boolean;
  tier: "minimal" | "light" | "medium" | "heavy";
}

function estimate(
  message: string,
  tabs: OpenTabContext[],
  activeTabPath: string | null
): TokenEstimate {
  const isCasual = CASUAL_PATTERN.test(message.trim());
  const isCodeQuery = CODE_PATTERN.test(message);
  const messageTokens = charsToTokens(message.length);

  if (isCasual || !tabs.length) {
    return { messageTokens, contextTokens: 0, totalTokens: messageTokens, filesIncluded: [], isCasual: true, tier: "minimal" };
  }

  const mentionedFiles = tabs.filter((tab) => {
    const name = tab.path.split(/[\\/]/).pop()?.toLowerCase() ?? "";
    return message.toLowerCase().includes(name) || message.toLowerCase().includes(tab.path.toLowerCase());
  });

  const activeTab = tabs.find((t) => t.path === activeTabPath) ?? null;
  const filesToInclude = isCodeQuery
    ? [...new Set([activeTab, ...mentionedFiles].filter(Boolean))] as OpenTabContext[]
    : mentionedFiles;

  const filesIncluded: string[] = [];
  let totalChars = 0;

  for (const tab of filesToInclude) {
    if (totalChars >= TOTAL_CHAR_LIMIT) break;
    const remaining = TOTAL_CHAR_LIMIT - totalChars;
    const used = Math.min(tab.content.length, Math.min(FILE_CHAR_LIMIT, remaining));
    totalChars += used;
    filesIncluded.push(tab.path.split(/[\\/]/).pop() ?? tab.path);
  }

  const contextTokens = charsToTokens(totalChars);
  const totalTokens = messageTokens + contextTokens;
  const tier =
    totalTokens < 500 ? "minimal"
    : totalTokens < 3000 ? "light"
    : totalTokens < 15000 ? "medium"
    : "heavy";

  return { messageTokens, contextTokens, totalTokens, filesIncluded, isCasual, tier };
}

function fmt(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : `${n}`;
}

// ─── Tier config ──────────────────────────────────────────────────────────────

const TIERS = {
  minimal: { color: "#4ade80", bg: "rgba(74,222,128,0.10)",  border: "rgba(74,222,128,0.25)",  label: "minimal", hint: "✓ No file context — casual message" },
  light:   { color: "#60a5fa", bg: "rgba(96,165,250,0.10)",  border: "rgba(96,165,250,0.25)",  label: "light",   hint: "✓ Efficient context" },
  medium:  { color: "#fbbf24", bg: "rgba(251,191,36,0.10)",  border: "rgba(251,191,36,0.25)",  label: "medium",  hint: "Moderate context" },
  heavy:   { color: "#f87171", bg: "rgba(248,113,113,0.10)", border: "rgba(248,113,113,0.30)", label: "heavy",   hint: "⚠️ Large context — consider narrowing your question" },
};

// ─── Component ────────────────────────────────────────────────────────────────

interface TokenPillProps {
  message: string;
  tabs: OpenTabContext[];
  activeTabPath: string | null;
}

export function TokenPill({ message, tabs, activeTabPath }: TokenPillProps) {
  const [est, setEst] = useState<TokenEstimate | null>(null);
  const [open, setOpen] = useState(false);
  const [flash, setFlash] = useState(false);
  const prevTierRef = useRef<string | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      if (!message.trim()) { setEst(null); setOpen(false); return; }
      const next = estimate(message, tabs, activeTabPath);
      setEst((prev) => {
        if (prev && prev.tier !== next.tier) {
          setFlash(true);
          setTimeout(() => setFlash(false), 300);
        }
        prevTierRef.current = next.tier;
        return next;
      });
    }, 120);
    return () => { if (timerRef.current) clearTimeout(timerRef.current); };
  }, [message, tabs, activeTabPath]);

  if (!est || !message.trim()) return null;

  const cfg = TIERS[est.tier];

  return (
    <div style={{ position: "relative", display: "inline-flex", flexShrink: 0 }}>
      {/* Pill button */}
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        title="Token estimate — click for breakdown"
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 4,
          padding: "2px 8px 2px 6px",
          borderRadius: 20,
          fontSize: 11,
          fontFamily: "var(--font-mono, monospace)",
          cursor: "pointer",
          backgroundColor: cfg.bg,
          border: `1px solid ${cfg.border}`,
          color: cfg.color,
          outline: "none",
          transition: "transform 0.15s",
          transform: flash ? "scale(1.08)" : "scale(1)",
          whiteSpace: "nowrap",
        }}
      >
        {/* Glow dot */}
        <span style={{
          width: 6, height: 6, borderRadius: "50%", flexShrink: 0,
          backgroundColor: cfg.color,
          boxShadow: `0 0 4px ${cfg.color}`,
        }} />
        <span style={{ fontWeight: 600 }}>~{fmt(est.totalTokens)}</span>
        <span style={{ opacity: 0.55, fontSize: 10 }}>{cfg.label}</span>
        <span style={{ fontSize: 8, opacity: 0.4, marginLeft: 1 }}>{open ? "▲" : "▼"}</span>
      </button>

      {/* Breakdown popover */}
      {open && (
        <>
          {/* backdrop to close on outside click */}
          <div
            style={{ position: "fixed", inset: 0, zIndex: 99 }}
            onClick={() => setOpen(false)}
          />
          <div style={{
            position: "absolute",
            bottom: "calc(100% + 8px)",
            left: 0,
            zIndex: 100,
            minWidth: 220,
            backgroundColor: "var(--bg-secondary, #1a1a2e)",
            border: `1px solid ${cfg.border}`,
            borderRadius: 10,
            padding: "12px 14px",
            boxShadow: "0 8px 32px rgba(0,0,0,0.55)",
            fontFamily: "var(--font-mono, monospace)",
            fontSize: 11,
          }}>
            <div style={{ color: "#555", fontSize: 10, textTransform: "uppercase", letterSpacing: "0.1em", marginBottom: 10 }}>
              Token Breakdown
            </div>

            {/* Rows */}
            {[
              ["Your message", est.messageTokens],
              ["File context",  est.contextTokens],
            ].map(([label, val]) => (
              <div key={label as string} style={{ display: "flex", justifyContent: "space-between", padding: "3px 0", borderBottom: "1px solid rgba(255,255,255,0.05)" }}>
                <span style={{ color: "#888" }}>{label}</span>
                <span style={{ color: "#ccc", fontWeight: 600 }}>~{fmt(val as number)}</span>
              </div>
            ))}

            {/* Total */}
            <div style={{ display: "flex", justifyContent: "space-between", padding: "6px 0 3px", borderTop: "1px solid rgba(255,255,255,0.1)", marginTop: 4 }}>
              <span style={{ color: "#aaa", fontWeight: 700 }}>Total input</span>
              <span style={{ color: cfg.color, fontWeight: 700 }}>~{fmt(est.totalTokens)}</span>
            </div>

            {/* Files */}
            {est.filesIncluded.length > 0 && (
              <div style={{ marginTop: 10 }}>
                <div style={{ color: "#444", fontSize: 10, textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 4 }}>Files included</div>
                {est.filesIncluded.map((f) => (
                  <div key={f} style={{ color: "#bbb", padding: "1px 0" }}>📄 {f}</div>
                ))}
              </div>
            )}

            {est.isCasual && (
              <div style={{ marginTop: 8, color: "#555", fontSize: 10, fontStyle: "italic" }}>
                Casual message — no files attached
              </div>
            )}

            {/* Hint */}
            <div style={{ marginTop: 10, color: "#555", fontSize: 10, borderTop: "1px solid rgba(255,255,255,0.05)", paddingTop: 8, lineHeight: 1.4 }}>
              {cfg.hint}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
