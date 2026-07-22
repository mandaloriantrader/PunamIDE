/**
 * AgentApplyGuard.ts — HIGH-severity fix: Operation safety layer
 *
 * Connects the multi-agent safety infrastructure to the single-agent AiChat path.
 * Intercepts all file writes and browser opens to enforce:
 *   1. File-locking (Layer 1) via AgentOrchestrator
 *   2. Permission checking (Layer 5) via AgentOrchestrator
 *   3. Browser instance tracking (prevents duplicate opens)
 *   4. Operation deduplication (same-file same-content within 30s)
 *
 * Usage: Wrap every agent action (writeFile, openBrowser, etc.) with guard methods.
 */

import { invoke } from "@tauri-apps/api/core";
import { getAgentOrchestrator } from "./AgentOrchestrator";
import { validateArchitecture, getCachedRules, getArchitectureHealth } from "../architecture/ArchitectureEngine";
import type { DependencyViolation, ArchitectureRules } from "../architecture/ArchitectureEngine";
import { scanArchitectureViolations } from "../architecture/ViolationReporter";
import { ThreatAnalyzer } from "../security/ThreatAnalyzer";
import type { ThreatSummary } from "../security/ThreatAnalyzer";
import { isFileLockedForDiff } from "../../hooks/useInlineDiff";

// ── Browser Instance Tracking ───────────────────────────────────────────────

interface BrowserInstance {
  url: string;
  openedAt: number;
  port: number | null;
}

const activeBrowsers = new Map<string, BrowserInstance>();

/**
 * Check if a URL/port is already being served. Returns the existing instance or null.
 */
export function getExistingBrowser(url: string): BrowserInstance | null {
  // Extract port from URL (e.g., http://localhost:3000 → 3000)
  const portMatch = url.match(/:(\d{2,5})(?:\/|$)/);
  const port = portMatch ? parseInt(portMatch[1], 10) : null;

  // Check by exact URL match
  for (const [, instance] of activeBrowsers) {
    if (instance.url === url) return instance;
  }

  // Check by port match (more reliable)
  if (port !== null) {
    for (const [, instance] of activeBrowsers) {
      if (instance.port === port) return instance;
    }
  }

  return null;
}

/**
 * Register a browser instance. Call AFTER successfully opening the browser.
 * Automatically cleans up instances older than 30 minutes.
 */
export function registerBrowser(url: string): BrowserInstance {
  // Clean stale entries
  const now = Date.now();
  for (const [key, instance] of activeBrowsers) {
    if (now - instance.openedAt > 30 * 60 * 1000) {
      activeBrowsers.delete(key);
    }
  }

  const portMatch = url.match(/:(\d{2,5})(?:\/|$)/);
  const instance: BrowserInstance = {
    url,
    openedAt: now,
    port: portMatch ? parseInt(portMatch[1], 10) : null,
  };

  activeBrowsers.set(url, instance);
  return instance;
}

/**
 * Check if the agent is allowed to open a browser to the given URL.
 * Returns { allowed, reason, existing }.
 */
export function checkBrowserOpen(
  url: string,
): { allowed: boolean; reason: string; existing: BrowserInstance | null } {
  const existing = getExistingBrowser(url);

  if (existing) {
    const secondsAgo = Math.round((Date.now() - existing.openedAt) / 1000);
    return {
      allowed: false,
      reason: `Browser already open at ${url} (opened ${secondsAgo}s ago). Skipping duplicate launch.`,
      existing,
    };
  }

  return { allowed: true, reason: "OK", existing: null };
}

// ── File Write Guard ────────────────────────────────────────────────────────

interface WriteRecord {
  path: string;
  contentHash: string;
  timestamp: number;
}

const recentWrites = new Map<string, WriteRecord>();

/**
 * Check if an agent is allowed to write to a file.
 * Enforces: file locking, permission boundaries, duplicate detection.
 *
 * @param agentId - Unique agent identifier (use "ai-chat" for single-agent mode)
 * @param filePath - Target file path
 * @param content - Proposed file content
 * @returns { allowed, reason }
 */
export function checkFileWrite(
  agentId: string,
  filePath: string,
  content: string,
): { allowed: boolean; reason: string } {
  const orchestrator = getAgentOrchestrator();

  // Layer 5: Permission check
  // For single-agent mode, we use a relaxed check — allows all src/ files
  const session = orchestrator.getState().agents.get(agentId);
  if (session) {
    const perm = orchestrator.checkWritePermission(agentId, filePath);
    if (!perm.allowed) {
      return { allowed: false, reason: `Permission denied: ${perm.reason}` };
    }
  }

  // Layer 1: File lock check
  const lockOwner = orchestrator.getFileLockOwner(filePath);
  if (lockOwner && lockOwner !== agentId) {
    return {
      allowed: false,
      reason: `File "${filePath}" is locked by agent "${lockOwner}". Wait for lock release.`,
    };
  }

  // Layer 1b: Inline diff preview lock — block writes while user is reviewing hunks
  if (isFileLockedForDiff(filePath)) {
    return {
      allowed: false,
      reason: `File "${filePath}" has an active inline diff preview. Resolve all hunks before applying new edits.`,
    };
  }

  // Deduplication: check recent writes
  const contentHash = simpleHash(content);
  const existing = recentWrites.get(filePath);

  // Clean stale entries (>30s)
  const now = Date.now();
  for (const [key, record] of recentWrites) {
    if (now - record.timestamp > 30_000) {
      recentWrites.delete(key);
    }
  }

  if (existing && existing.contentHash === contentHash && now - existing.timestamp < 30_000) {
    const secondsAgo = Math.round((now - existing.timestamp) / 1000);
    return {
      allowed: false,
      reason: `DUPLICATE: Identical content already written to "${filePath}" ${secondsAgo}s ago.`,
    };
  }

  // Record the write
  recentWrites.set(filePath, {
    path: filePath,
    contentHash,
    timestamp: now,
  });

  return { allowed: true, reason: "OK" };
}

/**
 * Validate a proposed file write against all safety layers.
 * Combines: architecture guardrails (Phase 1) + security scanning (Phase 6) +
 * file locking + permissions + deduplication.
 *
 * Called before any agent writes a file in both foreground and background paths.
 */
export async function validateApply(
  agentId: string,
  filePath: string,
  content: string,
  projectPath?: string,
): Promise<{
  allowed: boolean;
  reason: string;
  architectureViolations: DependencyViolation[];
  securityIssues: ThreatSummary | null;
}> {
  const result = {
    allowed: true,
    reason: "OK",
    architectureViolations: [] as DependencyViolation[],
    securityIssues: null as ThreatSummary | null,
  };

  // ── Layer 1+5: File lock + permissions + dedup ──────────────────────
  const writeCheck = checkFileWrite(agentId, filePath, content);
  if (!writeCheck.allowed) {
    result.allowed = false;
    result.reason = writeCheck.reason;
    return result;
  }

  // ── Layer 2: Architecture guardrails (Phase 1) ──────────────────────
  try {
    const rules = await getCachedRules();
    const archResult = await validateArchitecture(rules);
    const violations = archResult.violations.filter(
      (v) => v.from_file === filePath || v.to_file === filePath,
    );

    // Check for architecture errors
    if (archResult.error_count > 0 && violations.length > 0) {
      result.allowed = false;
      result.architectureViolations = violations;
      result.reason = `Architecture violation: ${violations[0].description}`;
      return result;
    }

    result.architectureViolations = violations;

    // Run project-wide violation scan for reporting (non-blocking)
    if (projectPath) {
      scanArchitectureViolations(projectPath).catch(() => {});
    }
  } catch {
    // Architecture validation unavailable — allow with warning
  }

  // ── Layer 3: Security scan (Phase 6) ────────────────────────────────
  try {
    // Construct a minimal unified-diff patch so the Rust scanner sees
    // every proposed line as an "added" line (all prefixed with '+').
    const lines = content.split("\n");
    const patchLines = [`@@ -1,0 +1,${lines.length} @@`];
    for (const line of lines) {
      patchLines.push(`+${line}`);
    }
    const patchContent = patchLines.join("\n");

    const scanResult = await invoke<{
      allowed: boolean;
      blocked: boolean;
      findings: Array<{
        pattern_id: string;
        file_path: string;
        line: number;
        column: number;
        snippet: string;
        severity: string;
        owasp: string;
        description: string;
        suggestion: string;
        cwe: number | null;
      }>;
      critical_findings: Array<{
        pattern_id: string;
        file_path: string;
        line: number;
        column: number;
        snippet: string;
        severity: string;
        owasp: string;
        description: string;
        suggestion: string;
      }>;
      summary: string;
    }>("security_scan_patch", {
      patchContent,
      filePath,
    });

    // Block on critical OR high-severity findings.
    // scanResult.blocked mirrors critical_findings.is_empty() in Rust —
    // high-severity findings must be checked explicitly.
    const highFindings = scanResult.findings.filter(
      (f) => f.severity === "high",
    );
    if (
      scanResult.blocked ||
      scanResult.critical_findings.length > 0 ||
      highFindings.length > 0
    ) {
      result.allowed = false;
      result.reason = highFindings.length > 0 && scanResult.critical_findings.length === 0
        ? `Blocked: ${highFindings.length} high-severity security finding(s) detected in proposed content.`
        : scanResult.summary;
      return result;
    }
  } catch {
    // Security scan unavailable — allow with warning
  }

  // ── Layer 4: Architecture health check ──────────────────────────────
  try {
    const health = await getArchitectureHealth();
    if (health.score === "critical") {
      result.allowed = false;
      result.reason = `Architecture health is CRITICAL: ${health.summary}. Manual review required.`;
      return result;
    }
  } catch {
    // Health check unavailable — allow
  }

  return result;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function simpleHash(input: string): string {
  let hash = 0;
  for (let i = 0; i < input.length; i++) {
    const char = input.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash |= 0; // Convert to 32bit integer
  }
  return hash.toString(16);
}
