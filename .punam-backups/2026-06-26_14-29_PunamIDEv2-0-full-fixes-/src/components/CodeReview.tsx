/**
 * CodeReview — AI-powered structured code review panel.
 * Reviews a file or selection for security, performance, style, and correctness.
 */

import { useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Loader2,
  Shield,
  Zap,
  Code2,
  Bug,
  X,
} from "lucide-react";
import { sendToProviderStreaming } from "../utils/providers";
import type { AIProviderConfig } from "../utils/providers";
import { MarkdownMessage } from "./chat/ChatComponents";

export interface ReviewIssue {
  severity: "critical" | "warning" | "info" | "good";
  category: "security" | "performance" | "style" | "correctness" | "general";
  line?: number;
  title: string;
  detail: string;
}

export interface ReviewResult {
  summary: string;
  score: number; // 0-100
  issues: ReviewIssue[];
  rawText: string;
}

interface Props {
  filePath: string;
  fileContent: string;
  selectedText?: string;
  language: string;
  aiProviders: AIProviderConfig[];
  onClose: () => void;
  onJumpToLine?: (line: number) => void;
}

const CATEGORY_ICONS: Record<ReviewIssue["category"], React.ReactNode> = {
  security: <Shield size={13} />,
  performance: <Zap size={13} />,
  style: <Code2 size={13} />,
  correctness: <Bug size={13} />,
  general: <CheckCircle2 size={13} />,
};

const SEVERITY_COLOR: Record<ReviewIssue["severity"], string> = {
  critical: "var(--red)",
  warning: "var(--yellow)",
  info: "var(--accent)",
  good: "var(--green)",
};

const CODE_REVIEW_SYSTEM_PROMPT = `You are an expert code reviewer. Analyze the provided code and respond with a JSON object only — no markdown, no explanation outside the JSON.

Schema:
{
  "summary": "2-3 sentence overall summary",
  "score": <0-100 integer quality score>,
  "issues": [
    {
      "severity": "critical|warning|info|good",
      "category": "security|performance|style|correctness|general",
      "line": <line number or null>,
      "title": "short title (max 60 chars)",
      "detail": "markdown explanation with code examples if relevant"
    }
  ]
}

Severity rules:
- critical: security vulnerabilities, crashes, data loss
- warning: bugs, performance bottlenecks, bad patterns
- info: suggestions, minor style issues
- good: things done well (always include 1-3 positives)

Focus on actionable, specific issues. Max 12 issues total. Score honestly.`;

function parseReviewResult(text: string): ReviewResult {
  try {
    // Strip markdown fences if present
    const cleaned = text.replace(/^```(?:json)?\n?/, "").replace(/\n?```$/, "").trim();
    const parsed = JSON.parse(cleaned);
    return {
      summary: parsed.summary || "Review complete.",
      score: typeof parsed.score === "number" ? Math.min(100, Math.max(0, parsed.score)) : 70,
      issues: Array.isArray(parsed.issues) ? parsed.issues : [],
      rawText: text,
    };
  } catch {
    return {
      summary: text.slice(0, 300),
      score: 0,
      issues: [],
      rawText: text,
    };
  }
}

function ScoreRing({ score }: { score: number }) {
  const color = score >= 80 ? "var(--green)" : score >= 60 ? "var(--yellow)" : "var(--red)";
  const r = 22;
  const circ = 2 * Math.PI * r;
  const dash = (score / 100) * circ;
  return (
    <svg className="review-score-ring" width={56} height={56} viewBox="0 0 56 56" aria-label={`Score ${score}`}>
      <circle cx={28} cy={28} r={r} fill="none" stroke="var(--border)" strokeWidth={4} />
      <circle
        cx={28} cy={28} r={r} fill="none"
        stroke={color} strokeWidth={4}
        strokeDasharray={`${dash} ${circ}`}
        strokeLinecap="round"
        transform="rotate(-90 28 28)"
        style={{ transition: "stroke-dasharray 0.5s ease" }}
      />
      <text x={28} y={33} textAnchor="middle" fontSize={13} fontWeight={700} fill={color}>{score}</text>
    </svg>
  );
}

export default function CodeReview({
  filePath, fileContent, selectedText, language, aiProviders, onClose, onJumpToLine,
}: Props) {
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<ReviewResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expandedIssues, setExpandedIssues] = useState<Set<number>>(new Set([0]));
  const [filterSeverity, setFilterSeverity] = useState<ReviewIssue["severity"] | "all">("all");

  const targetCode = selectedText?.trim() ? selectedText : fileContent;
  const targetLabel = selectedText?.trim()
    ? `selected code in ${filePath.split(/[\\/]/).pop()}`
    : filePath.split(/[\\/]/).pop();

  const runReview = async () => {
    const provider = aiProviders.find((p) => p.apiKey && p.models.some((m) => m.enabled));
    if (!provider) { setError("No AI provider configured."); return; }
    const model = provider.models.find((m) => m.enabled);
    if (!model) { setError("No model enabled."); return; }

    setLoading(true);
    setError(null);
    setResult(null);

    const userPrompt =
      `Language: ${language}\n` +
      `File: ${filePath}\n\n` +
      `Code to review:\n\`\`\`${language}\n${targetCode.slice(0, 12000)}\n\`\`\``;

    try {
      const resp = await sendToProviderStreaming(provider, model.id, {
        systemPrompt: CODE_REVIEW_SYSTEM_PROMPT,
        userPrompt,
      });
      if (resp.success) {
        setResult(parseReviewResult(resp.text));
        setExpandedIssues(new Set([0]));
      } else {
        setError(resp.error || "Unknown error");
      }
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
    }
  };

  const toggleIssue = (i: number) => {
    setExpandedIssues((prev) => {
      const next = new Set(prev);
      next.has(i) ? next.delete(i) : next.add(i);
      return next;
    });
  };

  const filteredIssues = result?.issues.filter(
    (iss) => filterSeverity === "all" || iss.severity === filterSeverity
  ) ?? [];

  const countBySeverity = (s: ReviewIssue["severity"]) =>
    result?.issues.filter((i) => i.severity === s).length ?? 0;

  return (
    <div className="code-review-panel">
      {/* Header */}
      <div className="cr-header">
        <div className="cr-title">
          <Shield size={14} />
          <span>Code Review</span>
          {targetLabel && <span className="cr-target">— {targetLabel}</span>}
        </div>
        <button className="icon-btn small" onClick={onClose} aria-label="Close review panel">
          <X size={14} />
        </button>
      </div>

      {/* Body */}
      <div className="cr-body">
        {!result && !loading && !error && (
          <div className="cr-start">
            <Shield size={40} className="cr-start-icon" />
            <p>Review <strong>{targetLabel}</strong> for security, performance, style and correctness issues.</p>
            <button className="btn-primary" onClick={runReview} disabled={loading}>
              Start Review
            </button>
          </div>
        )}

        {loading && (
          <div className="cr-loading">
            <Loader2 size={24} className="spin" />
            <span>Analyzing code…</span>
          </div>
        )}

        {error && !loading && (
          <div className="cr-error">
            <AlertTriangle size={16} />
            <span>{error}</span>
            <button className="btn-secondary compact" onClick={runReview}>Retry</button>
          </div>
        )}

        {result && !loading && (
          <>
            {/* Summary row */}
            <div className="cr-summary-row">
              <ScoreRing score={result.score} />
              <div className="cr-summary-text">
                <p>{result.summary}</p>
                <div className="cr-severity-counts">
                  {(["critical", "warning", "info", "good"] as const).map((s) => (
                    countBySeverity(s) > 0 && (
                      <span
                        key={s}
                        className={`cr-sev-badge ${s} ${filterSeverity === s ? "active" : ""}`}
                        onClick={() => setFilterSeverity(filterSeverity === s ? "all" : s)}
                        style={{ color: SEVERITY_COLOR[s] }}
                      >
                        {countBySeverity(s)} {s}
                      </span>
                    )
                  ))}
                </div>
              </div>
            </div>

            {/* Issues list */}
            <div className="cr-issues">
              {filteredIssues.length === 0 && (
                <div className="cr-no-issues">No issues match the current filter.</div>
              )}
              {filteredIssues.map((issue, i) => (
                <div key={i} className={`cr-issue ${issue.severity}`}>
                  <button className="cr-issue-header" onClick={() => toggleIssue(i)}>
                    <span className="cr-issue-icon" style={{ color: SEVERITY_COLOR[issue.severity] }}>
                      {CATEGORY_ICONS[issue.category]}
                    </span>
                    <span className="cr-issue-title">{issue.title}</span>
                    {issue.line && onJumpToLine && (
                      <span
                        className="cr-issue-line"
                        onClick={(e) => { e.stopPropagation(); onJumpToLine(issue.line!); }}
                        title={`Jump to line ${issue.line}`}
                      >
                        :{issue.line}
                      </span>
                    )}
                    <span className={`cr-sev-pill ${issue.severity}`}>{issue.severity}</span>
                    {expandedIssues.has(i)
                      ? <ChevronDown size={12} />
                      : <ChevronRight size={12} />
                    }
                  </button>
                  {expandedIssues.has(i) && (
                    <div className="cr-issue-detail">
                      <MarkdownMessage text={issue.detail} />
                    </div>
                  )}
                </div>
              ))}
            </div>

            {/* Re-run */}
            <div className="cr-footer">
              <button className="btn-secondary compact" onClick={runReview}>
                Re-run Review
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
