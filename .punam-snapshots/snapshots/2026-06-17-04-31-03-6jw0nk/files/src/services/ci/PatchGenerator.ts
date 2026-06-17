/**
 * PatchGenerator.ts — Phase 9, Step 9.3
 *
 * Generates fix candidates using AI, validates against Phase 1 (architecture)
 * rules and Phase 6 (security) scanning before proposing to the user.
 *
 * Pipeline: FailureAnalysis → AI generates patch → validate → propose
 */

import { invoke } from "@tauri-apps/api/core";
import { getCiMonitor } from "./CiMonitor";
import type { CiFailureAnalysis, CiFixProposal } from "./CiMonitor";
import { validatePatchAgainstRules, getCachedRules } from "../architecture/ArchitectureEngine";
import type { ValidationResult } from "../architecture/ArchitectureEngine";

// ── Types ──────────────────────────────────────────────────────────────────────

export interface PatchCandidate {
  /** The diff/patch content. */
  patch: string;
  /** Files affected by this patch. */
  affectedFiles: string[];
  /** Human-readable description of the fix. */
  description: string;
  /** Confidence that this fix addresses the root cause (0-1). */
  confidence: number;
}

export interface PatchValidationResult {
  /** Whether the patch passes all guardrails. */
  valid: boolean;
  /** Architecture validation result. */
  architectureResult: ValidationResult | null;
  /** Security issues found (if any). */
  securityIssues: string[];
  /** Reasons for rejection (if invalid). */
  rejectionReasons: string[];
}

// ── PatchGenerator Class ───────────────────────────────────────────────────────

export class PatchGenerator {
  /**
   * Generate a fix candidate from a failure analysis.
   * This creates the proposal structure — actual AI generation
   * happens in the CiDashboard UI using the configured LLM provider.
   */
  async generateFixCandidate(analysis: CiFailureAnalysis): Promise<PatchCandidate> {
    const monitor = getCiMonitor();
    const proposal = await monitor.generateFix(analysis);

    return {
      patch: proposal.patch,
      affectedFiles: proposal.affectedFiles,
      description: analysis.suggestedFix || `Fix for: ${analysis.rootCause}`,
      confidence: analysis.confidence,
    };
  }

  /**
   * Validate a patch candidate against architecture rules and security scanning.
   * Must pass both Phase 1 and Phase 6 guardrails.
   */
  async validatePatch(candidate: PatchCandidate): Promise<PatchValidationResult> {
    const result: PatchValidationResult = {
      valid: true,
      architectureResult: null,
      securityIssues: [],
      rejectionReasons: [],
    };

    // Phase 1: Architecture validation
    if (candidate.affectedFiles.length > 0) {
      try {
        const rules = await getCachedRules();
        const archResult = await validatePatchAgainstRules(rules, candidate.affectedFiles);
        result.architectureResult = archResult;

        if (archResult.error_count > 0) {
          result.valid = false;
          result.rejectionReasons.push(
            `Architecture violations: ${archResult.error_count} error(s) — ${archResult.violations.map((v) => v.description).join("; ")}`
          );
        }
      } catch {
        // Architecture validation unavailable — allow with warning
        result.rejectionReasons.push("Architecture validation unavailable — manual review required");
      }
    }

    // Phase 6: Security scan
    try {
      const securityResult = await invoke<{ findings: string[] }>(
        "scan_patch_security",
        { patch: candidate.patch, files: candidate.affectedFiles }
      ).catch(() => ({ findings: [] }));

      if (securityResult.findings.length > 0) {
        result.securityIssues = securityResult.findings;
        const criticalFindings = securityResult.findings.filter(
          (f) => f.toLowerCase().includes("critical") || f.toLowerCase().includes("high")
        );
        if (criticalFindings.length > 0) {
          result.valid = false;
          result.rejectionReasons.push(
            `Security issues: ${criticalFindings.length} critical/high finding(s)`
          );
        }
      }
    } catch {
      // Security scan unavailable — allow
    }

    return result;
  }

  /**
   * Create a full CiFixProposal from a validated patch candidate.
   */
  createProposal(
    analysis: CiFailureAnalysis,
    candidate: PatchCandidate,
    validation: PatchValidationResult,
  ): CiFixProposal {
    return {
      analysis,
      patch: candidate.patch,
      affectedFiles: candidate.affectedFiles,
      testResults: null,
      status: validation.valid ? "ready" : "pending",
    };
  }
}

// ── Singleton ──────────────────────────────────────────────────────────────────

let instance: PatchGenerator | null = null;

export function getPatchGenerator(): PatchGenerator {
  if (!instance) {
    instance = new PatchGenerator();
  }
  return instance;
}
