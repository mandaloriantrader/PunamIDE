/**
 * EnvironmentManager.ts — Phase 4, Step 4.6
 *
 * Orchestrates tool detection, dependency analysis, and environment repair.
 * Coordinates ToolOrchestrator + DependencyResolver.
 * Provides the data layer for EnvironmentDashboard UI panel.
 */

import { getToolOrchestrator } from "./ToolOrchestrator";
import { getDependencyResolver } from "./DependencyResolver";
import type { ToolInfo, EnvironmentScanResult, EnvironmentSummary, DockerContainerInfo } from "./ToolOrchestrator";
import type { DependencyHealth, ProjectManifestInfo } from "./DependencyResolver";
import type { ProjectDependencyReport } from "./ToolOrchestrator";

// ── Types ──────────────────────────────────────────────────────────────────────

export interface EnvironmentState {
  scanResult: EnvironmentScanResult | null;
  dependencies: ProjectDependencyReport | null;
  dependencyHealth: DependencyHealth | null;
  containers: DockerContainerInfo[];
  manifests: ProjectManifestInfo[];
  isLoading: boolean;
  error: string | null;
}

export interface ToolCategory {
  name: string; // "runtimes", "package_managers", "containers", "vcs", "cloud"
  tools: ToolInfo[];
  installedCount: number;
  totalCount: number;
}

export interface DependencyAlert {
  type: "outdated" | "vulnerable" | "deprecated" | "conflict";
  packageName: string;
  currentVersion?: string;
  latestVersion?: string;
  severity: "low" | "medium" | "high" | "critical";
  recommendation: string;
}

// ── EnvironmentManager Class ───────────────────────────────────────────────────

export class EnvironmentManager {
  private orchestrator = getToolOrchestrator();
  private resolver = getDependencyResolver();

  /**
   * Full environment scan — tools, dependencies, containers, manifests.
   */
  async scan(projectPath?: string): Promise<EnvironmentState> {
    const state: EnvironmentState = {
      scanResult: null,
      dependencies: null,
      dependencyHealth: null,
      containers: [],
      manifests: [],
      isLoading: true,
      error: null,
    };

    try {
      // Parallel: scan tools, containers, and manifests
      const [scanResult, containers, manifests] = await Promise.all([
        this.orchestrator.scanEnvironment().catch(() => null),
        this.orchestrator.listContainers(true).catch(() => [] as DockerContainerInfo[]),
        projectPath
          ? this.resolver.detectManagers(projectPath).catch(() => [] as ProjectManifestInfo[])
          : Promise.resolve([] as ProjectManifestInfo[]),
      ]);

      state.scanResult = scanResult;
      state.containers = containers;
      state.manifests = manifests;

      // If we have a project path, get dependencies
      if (projectPath) {
        const report = await this.resolver.getReport(projectPath).catch(() => null);
        state.dependencies = report;
        state.dependencyHealth = report ? this.resolver.calculateHealth(report) : null;
      }
    } catch (err) {
      state.error = `Environment scan failed: ${err}`;
    } finally {
      state.isLoading = false;
    }

    return state;
  }

  /**
   * Group tools by category for display.
   */
  categorizeTools(result: EnvironmentScanResult): ToolCategory[] {
    const categoryMap = new Map<string, ToolInfo[]>();

    for (const tool of result.tools) {
      const existing = categoryMap.get(tool.category) || [];
      existing.push(tool);
      categoryMap.set(tool.category, existing);
    }

    return Array.from(categoryMap.entries()).map(([name, tools]) => ({
      name,
      tools,
      installedCount: tools.filter((t) => t.installed).length,
      totalCount: tools.length,
    }));
  }

  /**
   * Get only missing tools with install recommendations.
   */
  getMissingTools(result: EnvironmentScanResult): Array<{ tool: ToolInfo; recommendation: string | null }> {
    return result.tools
      .filter((t) => !t.installed)
      .map((tool) => ({
        tool,
        recommendation: this.orchestrator.getInstallRecommendation(tool.name),
      }));
  }

  /**
   * Generate actionable alerts from dependency health.
   */
  generateAlerts(report: ProjectDependencyReport): DependencyAlert[] {
    const alerts: DependencyAlert[] = [];

    for (const pkg of report.packages) {
      if (pkg.warnings) {
        for (const warn of pkg.warnings) {
          if (warn.includes("vulnerabilit")) {
            alerts.push({
              type: "vulnerable",
              packageName: pkg.name,
              currentVersion: pkg.version,
              severity: "critical",
              recommendation: `Update ${pkg.name} immediately`,
            });
          }
        }
      }

      if (pkg.isDeprecated) {
        alerts.push({
          type: "deprecated",
          packageName: pkg.name,
          currentVersion: pkg.version,
          severity: "medium",
          recommendation: "Replace with supported alternative",
        });
      }

      if (pkg.latestVersion && pkg.latestVersion !== pkg.version) {
        alerts.push({
          type: "outdated",
          packageName: pkg.name,
          currentVersion: pkg.version,
          latestVersion: pkg.latestVersion,
          severity: "low",
          recommendation: `Update from ${pkg.version} to ${pkg.latestVersion}`,
        });
      }
    }

    for (const conflict of report.conflicts) {
      alerts.push({
        type: "conflict",
        packageName: `${conflict.pkgA} ↔ ${conflict.pkgB}`,
        severity: "high",
        recommendation: `Resolve: ${conflict.reason}`,
      });
    }

    return alerts;
  }

  /**
   * Get environment summary for display header.
   */
  getSummary(result: EnvironmentScanResult): EnvironmentSummary {
    return result.summary;
  }

  /**
   * Quick check: is the environment ready for development?
   */
  isReady(result: EnvironmentScanResult): boolean {
    // At minimum: node or python or rust must be installed
    const essentialTools = ["node", "python", "python3", "rustc", "go"];
    const hasEssential = result.tools.some(
      (t) => essentialTools.includes(t.name) && t.installed
    );

    // Git should be present
    const hasGit = result.tools.some((t) => t.name === "git" && t.installed);

    return hasEssential && hasGit;
  }
}

// ── Singleton ──────────────────────────────────────────────────────────────────

let instance: EnvironmentManager | null = null;

export function getEnvironmentManager(): EnvironmentManager {
  if (!instance) {
    instance = new EnvironmentManager();
  }
  return instance;
}