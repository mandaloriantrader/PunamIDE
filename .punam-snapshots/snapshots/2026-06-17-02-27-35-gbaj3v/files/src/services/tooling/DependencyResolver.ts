/**
 * DependencyResolver.ts — Phase 4, Step 4.5
 *
 * Detects and resolves project dependencies.
 * Reads package.json, Cargo.toml, requirements.txt, go.mod, pom.xml.
 * Flags conflicts, outdated packages, and vulnerability warnings.
 * Used by EnvironmentManager and EnvironmentDashboard.
 */

import { invoke } from "@tauri-apps/api/core";
import type { ProjectDependencyReport } from "./ToolOrchestrator";

// ── Types ──────────────────────────────────────────────────────────────────────

export interface DependencyConflict {
  packageA: string;
  packageB: string;
  reason: string; // "version_conflict", "peer_dependency", "license_incompatible"
  severity: "warning" | "error";
}

export interface DependencyHealth {
  total: number;
  outdated: number;
  vulnerable: number;
  deprecated: number;
  conflicts: DependencyConflict[];
  healthScore: number; // 0-100, higher = healthier
}

export interface ProjectManifestInfo {
  manager: string; // "npm", "cargo", "pip", "go", "maven"
  manifestPath: string; // relative path to manifest file
  exists: boolean;
}

// ── DependencyResolver Class ───────────────────────────────────────────────────

export class DependencyResolver {

  /**
   * Detect which dependency managers are used in the project.
   */
  async detectManagers(projectPath: string): Promise<ProjectManifestInfo[]> {
    try {
      return invoke<ProjectManifestInfo[]>("detect_package_managers", { projectPath });
    } catch {
      // Fallback: local detection via well-known manifest files
      const manifests = [
        { file: "package.json", manager: "npm" },
        { file: "Cargo.toml", manager: "cargo" },
        { file: "requirements.txt", manager: "pip" },
        { file: "go.mod", manager: "go" },
        { file: "pom.xml", manager: "maven" },
      ];

      const results: ProjectManifestInfo[] = [];
      for (const m of manifests) {
        try {
          const exists = await invoke<boolean>("file_exists", {
            path: `${projectPath}/${m.file}`,
          });
          results.push({ manager: m.manager, manifestPath: m.file, exists });
        } catch {
          results.push({ manager: m.manager, manifestPath: m.file, exists: false });
        }
      }
      return results;
    }
  }

  /**
   * Get full dependency report for the project.
   */
  async getReport(projectPath: string): Promise<ProjectDependencyReport | null> {
    try {
      return invoke<ProjectDependencyReport>("analyze_project_dependencies", { projectPath });
    } catch {
      return null;
    }
  }

  /**
   * Calculate dependency health score from a report.
   */
  calculateHealth(report: ProjectDependencyReport): DependencyHealth {
    const total = report.totalCount;
    if (total === 0) {
      return { total: 0, outdated: 0, vulnerable: 0, deprecated: 0, conflicts: [], healthScore: 100 };
    }

    const outdated = report.outdatedCount;
    const vulnerable = report.vulnerableCount;
    const deprecated = report.packages.filter((p) => p.isDeprecated).length;

    const conflicts: DependencyConflict[] = report.conflicts.map((c) => ({
      packageA: c.pkgA,
      packageB: c.pkgB,
      reason: c.reason,
      severity: c.reason.includes("peer") ? "error" : "warning",
    }));

    // Health score: start at 100, deduct for each issue
    let score = 100;
    score -= (outdated / total) * 30; // max -30 for outdated
    score -= (vulnerable / total) * 50; // max -50 for vulnerabilities
    score -= (deprecated / total) * 20; // max -20 for deprecated
    score -= conflicts.length * 5; // -5 per conflict
    score = Math.max(0, Math.round(score));

    return { total, outdated, vulnerable, deprecated, conflicts, healthScore: score };
  }

  /**
   * Check for known vulnerabilities in a package (delegates to security scanner).
   */
  async checkVulnerabilities(packageName: string, version: string): Promise<string[]> {
    try {
      return invoke<string[]>("check_package_vulnerabilities", { packageName, version });
    } catch {
      return [];
    }
  }

  /**
   * Resolve version conflicts using semver resolution.
   * Returns the resolved version or null if unresolvable.
   */
  resolveVersionConflict(versionA: string, versionB: string): string | null {
    // Simple semver: pick the higher compatible version
    const parse = (v: string) => v.replace(/^[~^>=<]/, "").split(".").map(Number);
    const a = parse(versionA);
    const b = parse(versionB);

    if (a.length !== 3 || b.length !== 3) return null;

    // Same major — pick higher
    if (a[0] === b[0]) {
      return a[1] > b[1] || (a[1] === b[1] && a[2] >= b[2]) ? versionA : versionB;
    }

    // Different major — unresolvable
    return null;
  }
}

// ── Singleton ──────────────────────────────────────────────────────────────────

let instance: DependencyResolver | null = null;

export function getDependencyResolver(): DependencyResolver {
  if (!instance) {
    instance = new DependencyResolver();
  }
  return instance;
}