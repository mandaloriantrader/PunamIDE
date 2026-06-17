/**
 * ThreatAnalyzer.ts — Phase 6, Step 6.3
 *
 * Categorizes security findings by severity, OWASP category,
 * and provides trend analysis over time.
 */

import type { SecurityFinding, Severity, OwaspCategory } from "./SecurityPatterns";
import { severityLevel } from "./SecurityPatterns";

// ── Types ──────────────────────────────────────────────────────────────────────

export interface ThreatSummary {
  totalFindings: number;
  criticalCount: number;
  highCount: number;
  mediumCount: number;
  lowCount: number;
  byOwasp: Record<string, number>;
  byPattern: Record<string, number>;
  byFile: Record<string, number>;
  maxSeverity: Severity;
  newFindings: SecurityFinding[];
  resolvedFindings: SecurityFinding[];
}

export interface TrendDataPoint {
  timestamp: number;
  totalFindings: number;
  criticalCount: number;
  highCount: number;
  mediumCount: number;
  lowCount: number;
}

export interface ThreatReport {
  summary: ThreatSummary;
  trend: TrendDataPoint[];
  recommendations: string[];
}

const OWASP_DESCRIPTIONS: Record<string, string> = {
  "A01:2021-Broken Access Control": "Unauthorized access to functions or data",
  "A02:2021-Cryptographic Failures": "Weak or missing encryption of sensitive data",
  "A03:2021-Injection": "Untrusted data sent to interpreters (SQL, XSS, OS)",
  "A04:2021-Insecure Design": "Architectural flaws not addressable by implementation fixes",
  "A05:2021-Security Misconfiguration": "Insecure default configs, open cloud storage, verbose errors",
  "A06:2021-Vulnerable Components": "Using dependencies with known vulnerabilities",
  "A07:2021-Auth Failures": "Weak authentication, credential stuffing, session management flaws",
  "A08:2021-Software Integrity Failures": "Unsafe deserialization, untrusted CI/CD, unsigned updates",
  "A09:2021-Logging & Monitoring": "Insufficient logging, detection, and incident response",
  "A10:2021-SSRF": "Server-side request forgery to internal services",
};

// ── ThreatAnalyzer ─────────────────────────────────────────────────────────────

export class ThreatAnalyzer {
  /**
   * Generate a threat summary from a set of findings.
   */
  summarize(findings: SecurityFinding[]): ThreatSummary {
    const byOwasp: Record<string, number> = {};
    const byPattern: Record<string, number> = {};
    const byFile: Record<string, number> = {};
    let criticalCount = 0;
    let highCount = 0;
    let mediumCount = 0;
    let lowCount = 0;
    let maxSeverity: Severity = "low";

    for (const finding of findings) {
      // Count by severity
      switch (finding.severity) {
        case "critical": criticalCount++; break;
        case "high": highCount++; break;
        case "medium": mediumCount++; break;
        case "low": lowCount++; break;
      }

      // Track max severity
      if (severityLevel(finding.severity) > severityLevel(maxSeverity)) {
        maxSeverity = finding.severity;
      }

      // Count by OWASP
      byOwasp[finding.owasp] = (byOwasp[finding.owasp] || 0) + 1;

      // Count by pattern
      byPattern[finding.patternId] = (byPattern[finding.patternId] || 0) + 1;

      // Count by file
      byFile[finding.filePath] = (byFile[finding.filePath] || 0) + 1;
    }

    return {
      totalFindings: findings.length,
      criticalCount,
      highCount,
      mediumCount,
      lowCount,
      byOwasp,
      byPattern,
      byFile,
      maxSeverity,
      newFindings: [],
      resolvedFindings: [],
    };
  }

  /**
   * Compare two scans and identify new/resolved findings.
   */
  diffScans(
    previous: SecurityFinding[],
    current: SecurityFinding[],
  ): { newFindings: SecurityFinding[]; resolvedFindings: SecurityFinding[] } {
    const previousKeys = new Set(
      previous.map((f) => `${f.patternId}:${f.filePath}:${f.line}`),
    );
    const currentKeys = new Set(
      current.map((f) => `${f.patternId}:${f.filePath}:${f.line}`),
    );

    const newFindings = current.filter(
      (f) => !previousKeys.has(`${f.patternId}:${f.filePath}:${f.line}`),
    );
    const resolvedFindings = previous.filter(
      (f) => !currentKeys.has(`${f.patternId}:${f.filePath}:${f.line}`),
    );

    return { newFindings, resolvedFindings };
  }

  /**
   * Generate a data point for trend tracking.
   * Call this periodically (e.g., after each scan) and store in VulnerabilityDatabase.
   */
  createTrendPoint(findings: SecurityFinding[]): TrendDataPoint {
    let criticalCount = 0;
    let highCount = 0;
    let mediumCount = 0;
    let lowCount = 0;

    for (const f of findings) {
      switch (f.severity) {
        case "critical": criticalCount++; break;
        case "high": highCount++; break;
        case "medium": mediumCount++; break;
        case "low": lowCount++; break;
      }
    }

    return {
      timestamp: Date.now(),
      totalFindings: findings.length,
      criticalCount,
      highCount,
      mediumCount,
      lowCount,
    };
  }

  /**
   * Generate recommendations based on the findings.
   */
  generateRecommendations(summary: ThreatSummary): string[] {
    const recommendations: string[] = [];

    if (summary.criticalCount > 0) {
      recommendations.push(
        `Address ${summary.criticalCount} critical finding(s) immediately — these may block AI patches.`,
      );
    }

    if (summary.highCount > 5) {
      recommendations.push(
        `${summary.highCount} high-severity findings — schedule a dedicated security review sprint.`,
      );
    }

    const topOwasp = Object.entries(summary.byOwasp)
      .sort(([, a], [, b]) => b - a)
      .slice(0, 3);

    for (const [owaspId, count] of topOwasp) {
      const desc = OWASP_DESCRIPTIONS[owaspId] || owaspId;
      recommendations.push(
        `${owaspId}: ${count} finding(s) — ${desc}. Review and apply mitigations.`,
      );
    }

    // File-specific recommendations
    const topFiles = Object.entries(summary.byFile)
      .sort(([, a], [, b]) => b - a)
      .slice(0, 3);

    if (topFiles.length > 0) {
      recommendations.push(
        `Files with most findings: ${topFiles.map(([f]) => f).join(", ")} — prioritize review.`,
      );
    }

    if (summary.totalFindings === 0) {
      recommendations.push(
        "No security findings detected. Continue following secure coding practices.",
      );
    }

    return recommendations;
  }

  /**
   * Get the overall health status based on findings severity.
   */
  getHealthStatus(summary: ThreatSummary): "critical" | "warning" | "good" {
    if (summary.criticalCount > 0) return "critical";
    if (summary.highCount >= 3 || summary.totalFindings >= 20) return "warning";
    return "good";
  }

  /**
   * Get the OWASP category description.
   */
  getOwaspDescription(owaspId: string): string {
    return OWASP_DESCRIPTIONS[owaspId] || owaspId;
  }

  /**
   * Generate a full threat report.
   */
  generateReport(
    currentFindings: SecurityFinding[],
    trends: TrendDataPoint[],
  ): ThreatReport {
    const summary = this.summarize(currentFindings);
    const recommendations = this.generateRecommendations(summary);

    return {
      summary,
      trend: trends,
      recommendations,
    };
  }
}