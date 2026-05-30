/**
 * DependencyResolver.ts — Phase 4, Step 4.5
 *
 * Detects project dependencies from manifest files (package.json,
 * Cargo.toml, requirements.txt) and flags potential conflicts.
 */

// ── Types ──────────────────────────────────────────────────────────────────────

export interface ProjectDependency {
  name: string;
  version: string;
  dev: boolean;
  file: string; // the manifest file
}

export interface DependencyConflict {
  type: "version_mismatch" | "duplicate" | "deprecated" | "unused";
  dependency: string;
  versions: string[];
  files: string[];
  severity: "high" | "medium" | "low";
  suggestion: string;
}

export interface DependencyReport {
  projectType: "node" | "rust" | "python" | "mixed" | "unknown";
  dependencies: ProjectDependency[];
  conflicts: DependencyConflict[];
  totalDependencies: number;
  totalDevDependencies: number;
  frameworks: string[];
}

// ── Known framework detection ─────────────────────────────────────────────────

const FRAMEWORK_PATTERNS: Array<{ name: string; deps: string[] }> = [
  { name: "React", deps: ["react", "react-dom"] },
  { name: "Vue", deps: ["vue"] },
  { name: "Svelte", deps: ["svelte"] },
  { name: "Next.js", deps: ["next"] },
  { name: "Nuxt", deps: ["nuxt"] },
  { name: "Express", deps: ["express"] },
  { name: "Fastify", deps: ["fastify"] },
  { name: "Tauri", deps: ["@tauri-apps/api"] },
  { name: "Electron", deps: ["electron"] },
  { name: "Vite", deps: ["vite"] },
  { name: "Webpack", deps: ["webpack"] },
  { name: "Astro", deps: ["astro"] },
  { name: "Flask", deps: ["flask"] },
  { name: "Django", deps: ["django"] },
  { name: "FastAPI", deps: ["fastapi"] },
  { name: "Tokio", deps: ["tokio"] },
  { name: "Actix", deps: ["actix-web"] },
  { name: "Axum", deps: ["axum"] },
];

// ── DependencyResolver Class ──────────────────────────────────────────────────

export class DependencyResolver {
  /**
   * Parse package.json content and extract dependencies.
   */
  parseNodeDependencies(content: string, filePath: string): ProjectDependency[] {
    const deps: ProjectDependency[] = [];
    try {
      const parsed = JSON.parse(content);
      if (parsed.dependencies) {
        for (const [name, version] of Object.entries(parsed.dependencies)) {
          deps.push({
            name,
            version: String(version),
            dev: false,
            file: filePath,
          });
        }
      }
      if (parsed.devDependencies) {
        for (const [name, version] of Object.entries(parsed.devDependencies)) {
          deps.push({
            name,
            version: String(version),
            dev: true,
            file: filePath,
          });
        }
      }
    } catch {
      // Invalid JSON — return empty
    }
    return deps;
  }

  /**
   * Parse Cargo.toml content and extract dependencies.
   */
  parseRustDependencies(content: string, filePath: string): ProjectDependency[] {
    const deps: ProjectDependency[] = [];
    let inDepSection = false;
    let inDevDepSection = false;

    for (const line of content.split("\n")) {
      const trimmed = line.trim();

      if (trimmed === "[dependencies]") {
        inDepSection = true;
        inDevDepSection = false;
        continue;
      }
      if (trimmed === "[dev-dependencies]" || trimmed === "[dev_dependencies]") {
        inDevDepSection = true;
        inDepSection = false;
        continue;
      }
      if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
        inDepSection = false;
        inDevDepSection = false;
        continue;
      }

      if ((inDepSection || inDevDepSection) && trimmed.includes("=")) {
        const parts = trimmed.split("=");
        const name = parts[0].trim().replace(/"/g, "").replace(/'/g, "");
        const version = parts[1].trim().replace(/"/g, "").replace(/'/g, "");
        if (name && version) {
          deps.push({
            name,
            version: version.replace(/^"(.*)"$/, "$1").replace(/^'(.*)'$/, "$1"),
            dev: inDevDepSection,
            file: filePath,
          });
        }
      }
    }
    return deps;
  }

  /**
   * Parse requirements.txt content and extract Python dependencies.
   */
  parsePythonDependencies(content: string, filePath: string): ProjectDependency[] {
    const deps: ProjectDependency[] = [];
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith("-")) continue;

      // Handle: name==version, name>=version, name~=version
      const match = trimmed.match(/^([a-zA-Z0-9_.-]+)\s*([><=!~]+)\s*([\d.]+)/);
      if (match) {
        deps.push({
          name: match[1],
          version: `${match[2]}${match[3]}`,
          dev: false,
          file: filePath,
        });
      } else {
        // Just a bare name
        deps.push({
          name: trimmed.split(/[><=]/)[0].trim(),
          version: "latest",
          dev: false,
          file: filePath,
        });
      }
    }
    return deps;
  }

  /**
   * Detect conflicts across all dependencies.
   */
  detectConflicts(allDeps: ProjectDependency[]): DependencyConflict[] {
    const conflicts: DependencyConflict[] = [];
    const seen = new Map<string, { version: string; file: string }[]>();

    for (const dep of allDeps) {
      if (!seen.has(dep.name)) {
        seen.set(dep.name, []);
      }
      seen.get(dep.name)!.push({ version: dep.version, file: dep.file });
    }

    // Detect version mismatches across files
    for (const [name, entries] of seen) {
      if (entries.length <= 1) continue;

      const uniqueVersions = [...new Set(entries.map((e) => e.version))];
      if (uniqueVersions.length > 1) {
        conflicts.push({
          type: "version_mismatch",
          dependency: name,
          versions: uniqueVersions,
          files: entries.map((e) => e.file),
          severity: "medium",
          suggestion: `Unify "${name}" to a single version across all manifests.`,
        });
      }
    }

    return conflicts;
  }

  /**
   * Detect frameworks from the dependency list.
   */
  detectFrameworks(deps: ProjectDependency[]): string[] {
    const depNames = new Set(deps.map((d) => d.name.toLowerCase()));
    const frameworks: string[] = [];

    for (const { name, deps: requiredDeps } of FRAMEWORK_PATTERNS) {
      if (requiredDeps.some((d) => depNames.has(d))) {
        frameworks.push(name);
      }
    }

    return frameworks;
  }

  /**
   * Generate a complete dependency report.
   */
  generateReport(
    nodeDeps: ProjectDependency[],
    rustDeps: ProjectDependency[],
    pythonDeps: ProjectDependency[],
  ): DependencyReport {
    const allDeps = [...nodeDeps, ...rustDeps, ...pythonDeps];
    const conflicts = this.detectConflicts(allDeps);
    const frameworks = this.detectFrameworks(allDeps);

    const totalDev = allDeps.filter((d) => d.dev).length;

    let projectType: DependencyReport["projectType"];
    const hasNode = nodeDeps.length > 0;
    const hasRust = rustDeps.length > 0;
    const hasPython = pythonDeps.length > 0;

    if (hasNode && hasRust) projectType = "mixed";
    else if (hasNode && hasPython) projectType = "mixed";
    else if (hasNode) projectType = "node";
    else if (hasRust) projectType = "rust";
    else if (hasPython) projectType = "python";
    else projectType = "unknown";

    return {
      projectType,
      dependencies: allDeps,
      conflicts,
      totalDependencies: allDeps.filter((d) => !d.dev).length,
      totalDevDependencies: totalDev,
      frameworks,
    };
  }
}