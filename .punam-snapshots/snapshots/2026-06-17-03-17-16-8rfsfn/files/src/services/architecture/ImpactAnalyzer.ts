/**
 * ImpactAnalyzer.ts — Phase 3, Step 3.2
 *
 * Natural Language Architecture Impact Analysis.
 *
 * Given a natural language description of a proposed change (e.g.,
 * "Add multi-tenant support"), query the LLM to identify affected
 * systems, then cross-reference with the ArchitectureMap's dependency
 * graph for precise, transitive file lists.
 *
 * Architecture:
 *   1. Build a structured prompt containing the ArchitectureMap summary
 *      (systems, modules, layers, inter-module edges)
 *   2. Ask the LLM to return a JSON list of affected systems/modules
 *   3. Resolve system → module → file using the ArchitectureMap
 *   4. Run transitive dependency analysis via DependencyGraph
 *   5. Return ImpactResult with files, risk, and summary
 */

import { invoke } from "@tauri-apps/api/core";
import { loadConfigFromStore } from "../../utils/tauri";
import type { LlmRequest } from "../../utils/tauri";
import type { ArchitectureMap, ModuleEdge, ModuleIndex, ArchitectureMapStats, SystemBoundaries } from "./ArchitectureMap";
import { buildArchitectureMap } from "./ArchitectureMap";

// ── Types ──────────────────────────────────────────────────────────────────────

export interface ImpactResult {
  /** The original user query. */
  query: string;
  /** Systems predicted to be affected (with confidence). */
  affectedSystems: AffectedSystem[];
  /** All modules that may need changes (system-level + transitive). */
  affectedModules: string[];
  /** Precise list of files that may need changes (with reason). */
  affectedFiles: AffectedFile[];
  /** Total count of potentially affected files. */
  totalFileCount: number;
  /** Estimated risk level. */
  riskLevel: RiskLevel;
  /** Human-readable summary. */
  summary: string;
  /** Time taken for the analysis (ms). */
  analysisTimeMs: number;
  /** Modules that depend on affected modules (transitive impact). */
  transitiveImpactModules: string[];
  /** Files in transitive impact modules. */
  transitiveImpactFiles: AffectedFile[];
}

export interface AffectedSystem {
  name: string;
  confidence: number; // 0–1
  reason: string;
  modules: string[];
}

export interface AffectedFile {
  path: string;
  module: string;
  reason: string; // "direct" | "dependency_of_X" | "transitive"
  dependents: string[]; // files that depend on this file
  dependencies: string[]; // files this file depends on
}

export type RiskLevel = "low" | "medium" | "high" | "critical";

// ── LLM Prompt Template ───────────────────────────────────────────────────────

const IMPACT_ANALYSIS_SYSTEM_PROMPT = `You are an expert software architect analyzing the impact of a proposed code change.

Given a description of what the user wants to change, and a map of the project's systems, modules, and their interconnections, your job is to:

1. Identify which SYSTEMS are likely affected
2. For each system, list the specific MODULES that would need changes
3. Assign a confidence score (0.0–1.0) to each system based on how likely it is affected
4. Provide a brief reason for each system

Respond ONLY with a JSON object in this exact format:
{
  "affectedSystems": [
    {
      "name": "SystemName",
      "confidence": 0.85,
      "reason": "Brief explanation of why this system is affected",
      "modules": ["module/path/1", "module/path/2"]
    }
  ],
  "summary": "One-sentence summary of the overall impact"
}

Rules:
- Only include systems that are in the provided system list
- Only include modules that are listed under those systems
- Confidence should be 0.0–1.0 based on how clearly the change description maps to known architecture
- Be conservative: if unsure about a system, use lower confidence
- The "modules" array must use exact module paths from the project map`;

// ── ImpactAnalyzer Class ──────────────────────────────────────────────────────

export class ImpactAnalyzer {
  private archMap: ArchitectureMap;

  constructor(archMap: ArchitectureMap) {
    this.archMap = archMap;
  }

  /**
   * Analyze the impact of a proposed change described in natural language.
   *
   * @param query - Natural language description of the change (e.g., "Add multi-tenant support")
   * @returns ImpactResult with affected systems, modules, files, and risk level
   */
  async analyzeChange(query: string): Promise<ImpactResult> {
    const startTime = Date.now();

    // 1. Build the project architecture summary for the LLM prompt
    const archSummary = this.buildArchitectureSummary();

    // 2. Call LLM to identify affected systems and modules
    const llmResult = await this.queryLLM(query, archSummary);

    // 3. Resolve systems → files using ArchitectureMap
    const { affectedFiles, allModules } = this.resolveFiles(llmResult.affectedSystems);

    // 4. Run transitive dependency analysis
    const transitiveModules = this.findTransitiveImpactModules(allModules);
    const transitiveFiles = this.resolveTransitiveFiles(transitiveModules);

    // 5. Calculate risk level
    const riskLevel = this.calculateRiskLevel(
      affectedFiles.length + transitiveFiles.length,
      transitiveModules.length,
      llmResult.affectedSystems,
    );

    const elapsedMs = Date.now() - startTime;

    return {
      query,
      affectedSystems: llmResult.affectedSystems,
      affectedModules: allModules,
      affectedFiles,
      totalFileCount: affectedFiles.length + transitiveFiles.length,
      riskLevel,
      summary: llmResult.summary,
      analysisTimeMs: elapsedMs,
      transitiveImpactModules: transitiveModules,
      transitiveImpactFiles: transitiveFiles,
    };
  }

  /**
   * Quick analysis: only identify affected systems, skip file-level resolution.
   * Useful for fast feedback in the UI.
   */
  async quickAnalyze(query: string): Promise<{
    affectedSystems: AffectedSystem[];
    summary: string;
  }> {
    const archSummary = this.buildArchitectureSummary();
    const llmResult = await this.queryLLM(query, archSummary);
    return {
      affectedSystems: llmResult.affectedSystems,
      summary: llmResult.summary,
    };
  }

  // ── Private: Architecture Summary ───────────────────────────────────────────

  private buildArchitectureSummary(): string {
    const stats = this.archMap.getStats();
    const systems = this.archMap.getSystemBoundaries();
    const layers = this.archMap.getLayerMap();
    const moduleEdges = this.archMap.getInterModuleEdges();

    const lines: string[] = [];

    lines.push("## Project Architecture Map");
    lines.push(`Total Files: ${stats.totalFiles}`);
    lines.push(`Total Modules: ${stats.totalModules}`);
    lines.push(`Total Systems: ${stats.totalSystems}`);
    lines.push("");

    // Systems and their modules
    lines.push("### Systems & Modules");
    for (const [system, modules] of Object.entries(systems)) {
      lines.push(`**${system}** (${modules.length} modules):`);
      for (const mod of modules.slice(0, 15)) {
        const fileCount = this.archMap.getModuleFileCount(mod);
        lines.push(`  - ${mod} (${fileCount} files)`);
      }
      if (modules.length > 15) {
        lines.push(`  ... and ${modules.length - 15} more modules`);
      }
      lines.push("");
    }

    // Layers
    lines.push("### Architectural Layers");
    for (const [layer, modules] of Object.entries(layers)) {
      lines.push(`- **${layer}**: ${modules.length} modules`);
    }
    lines.push("");

    // Key inter-module connections (top 10 by edge count)
    const sortedEdges = [...moduleEdges].sort((a, b) => b.count - a.count).slice(0, 10);
    if (sortedEdges.length > 0) {
      lines.push("### Key Inter-Module Dependencies (most connected)");
      for (const edge of sortedEdges) {
        lines.push(`- ${edge.from} → ${edge.to} (${edge.count} imports)`);
      }
      lines.push("");
    }

    // Most connected module
    lines.push(`### Most Connected Module: ${stats.mostConnectedModule.name} (${stats.mostConnectedModule.edgeCount} edges)`);
    lines.push(`### Largest Module: ${stats.largestModule.name} (${stats.largestModule.fileCount} files)`);

    return lines.join("\n");
  }

  // ── Private: LLM Query ──────────────────────────────────────────────────────

  private async queryLLM(
    query: string,
    archSummary: string,
  ): Promise<{ affectedSystems: AffectedSystem[]; summary: string }> {
    const config = await loadConfigFromStore();

    if (!config.api_key) {
      // No API key configured — fall back to heuristic analysis
      return this.fallbackHeuristicAnalysis(query);
    }

    const userPrompt = `## Proposed Change
${query}

## Project Architecture
${archSummary}

Analyze which systems and modules would be affected by this change. Respond with JSON only.`;

    try {
      const request: LlmRequest = {
        provider: config.provider,
        api_key: config.api_key,
        model: config.model,
        system_prompt: IMPACT_ANALYSIS_SYSTEM_PROMPT,
        user_prompt: userPrompt,
      };

      const response = await invoke<{ text: string; success: boolean; error?: string }>(
        "call_llm",
        { request },
      );

      if (!response.success || !response.text) {
        console.warn("[ImpactAnalyzer] LLM call failed, using fallback:", response.error);
        return this.fallbackHeuristicAnalysis(query);
      }

      return this.parseLLMResponse(response.text, query);
    } catch (err) {
      console.warn("[ImpactAnalyzer] LLM call error, using fallback:", err);
      return this.fallbackHeuristicAnalysis(query);
    }
  }

  private parseLLMResponse(
    text: string,
    _query: string,
  ): { affectedSystems: AffectedSystem[]; summary: string } {
    // Try to extract JSON from the response
    // The LLM might wrap it in markdown code blocks
    let jsonStr = text.trim();

    // Remove markdown code fences if present
    const jsonMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (jsonMatch) {
      jsonStr = jsonMatch[1].trim();
    }

    try {
      const parsed = JSON.parse(jsonStr);
      return {
        affectedSystems: this.validateSystems(parsed.affectedSystems || []),
        summary: parsed.summary || "Impact analysis complete.",
      };
    } catch {
      // If JSON parsing fails, try to extract a reasonable fallback
      return this.fallbackHeuristicAnalysis("(parse failed)");
    }
  }

  /** Validate and sanitize the systems returned by the LLM. */
  private validateSystems(systems: unknown[]): AffectedSystem[] {
    const validSystems: AffectedSystem[] = [];
    const knownSystems = this.archMap.getSystemBoundaries();

    if (!Array.isArray(systems)) return validSystems;

    for (const sys of systems) {
      if (!sys || typeof sys !== "object") continue;
      const s = sys as Record<string, unknown>;
      const name = String(s.name || "");
      if (!name || !knownSystems[name]) continue; // skip unknown systems

      const modules = Array.isArray(s.modules)
        ? (s.modules as string[]).filter((m) => {
            const sysModules = knownSystems[name] || [];
            return sysModules.includes(m);
          })
        : [];

      validSystems.push({
        name,
        confidence: typeof s.confidence === "number" ? Math.max(0, Math.min(1, s.confidence)) : 0.5,
        reason: String(s.reason || "Unknown"),
        modules: modules.length > 0 ? modules : knownSystems[name] || [],
      });
    }

    return validSystems;
  }

  // ── Private: Fallback Heuristic Analysis ─────────────────────────────────────

  /**
   * When no LLM is available (no API key), perform keyword-based heuristic
   * matching against system/module names to give basic impact estimates.
   */
  private fallbackHeuristicAnalysis(
    query: string,
  ): { affectedSystems: AffectedSystem[]; summary: string } {
    const queryLower = query.toLowerCase();
    const systems = this.archMap.getSystemBoundaries();
    const affectedSystems: AffectedSystem[] = [];

    // Keyword → system mapping for common architectural changes
    const keywordMap: Record<string, string[]> = {
      auth: ["Authentication", "Services", "Core"],
      login: ["Authentication", "Components", "Services"],
      database: ["Data", "Persistence", "Core", "Services"],
      multi_tenant: ["Services", "Data", "Core", "Authentication"],
      api: ["Services", "Core", "LSP"],
      ui: ["Components", "Pages", "Styles"],
      component: ["Components", "Styles"],
      debug: ["Debugger", "DAP", "LSP"],
      debugger: ["Debugger", "DAP"],
      lsp: ["LSP"],
      memory: ["Memory", "Core"],
      git: ["GitHub", "Git"],
      github: ["GitHub"],
      search: ["Search", "Index", "Indexing"],
      index: ["Index", "Indexing"],
      terminal: ["Terminal", "PTY"],
      security: ["Safety", "Core"],
      agent: ["Agent", "AgentTools", "AI"],
      ai: ["AI", "Agent"],
      embeddings: ["Embeddings", "AI"],
      docker: ["Terminal"],
      performance: ["Core"],
      architecture: ["Architecture", "Core"],
      build: ["Core"],
    };

    const matchedSystemNames = new Set<string>();
    for (const [keyword, systemNames] of Object.entries(keywordMap)) {
      if (queryLower.includes(keyword)) {
        for (const name of systemNames) {
          if (systems[name]) {
            matchedSystemNames.add(name);
          }
        }
      }
    }

    // If no keyword matches, fall back to the largest system
    if (matchedSystemNames.size === 0) {
      const stats = this.archMap.getStats();
      const largestSystem = stats.largestModule.name;
      for (const [sysName, mods] of Object.entries(systems)) {
        if (mods.includes(largestSystem) || sysName === "Core" || sysName === "Services") {
          matchedSystemNames.add(sysName);
        }
      }
    }

    for (const sysName of matchedSystemNames) {
      affectedSystems.push({
        name: sysName,
        confidence: 0.4, // lower confidence for heuristic
        reason: `Keyword match: "${queryLower}" matched system "${sysName}"`,
        modules: systems[sysName] || [],
      });
    }

    return {
      affectedSystems,
      summary: `Heuristic analysis found ${affectedSystems.length} potentially affected system(s). Configure an API key for precise LLM-based analysis.`,
    };
  }

  // ── Private: File Resolution ────────────────────────────────────────────────

  private resolveFiles(systems: AffectedSystem[]): {
    affectedFiles: AffectedFile[];
    allModules: string[];
  } {
    const affectedFiles: AffectedFile[] = [];
    const allModules = new Set<string>();
    const seenFiles = new Set<string>();

    for (const system of systems) {
      for (const module of system.modules) {
        allModules.add(module);
        const files = this.archMap.getModuleFiles(module);

        for (const file of files) {
          if (seenFiles.has(file)) continue;
          seenFiles.add(file);

          affectedFiles.push({
            path: file,
            module,
            reason: `direct — part of ${system.name}`,
            dependents: this.archMap.getFileDependents(file),
            dependencies: this.archMap.getFileDependencies(file),
          });
        }
      }
    }

    return { affectedFiles, allModules: Array.from(allModules).sort() };
  }

  // ── Private: Transitive Impact ───────────────────────────────────────────────

  /**
   * Find modules that depend on any of the directly affected modules.
   * These are "transitively" affected — if module A is changed, anything
   * that depends on A may also need changes.
   */
  private findTransitiveImpactModules(directModules: string[]): string[] {
    const directSet = new Set(directModules);
    const transitive = new Set<string>();

    for (const mod of directModules) {
      const dependents = this.archMap.getModuleDependents(mod);
      for (const dep of dependents) {
        if (!directSet.has(dep)) {
          transitive.add(dep);
        }
      }
    }

    return Array.from(transitive).sort();
  }

  private resolveTransitiveFiles(modules: string[]): AffectedFile[] {
    const files: AffectedFile[] = [];
    const seenFiles = new Set<string>();

    for (const mod of modules) {
      const modFiles = this.archMap.getModuleFiles(mod);
      for (const file of modFiles) {
        if (seenFiles.has(file)) continue;
        seenFiles.add(file);

        files.push({
          path: file,
          module: mod,
          reason: "transitive — depends on affected module",
          dependents: this.archMap.getFileDependents(file),
          dependencies: this.archMap.getFileDependencies(file),
        });
      }
    }

    return files;
  }

  // ── Private: Risk Calculation ────────────────────────────────────────────────

  private calculateRiskLevel(
    totalFiles: number,
    transitiveModules: number,
    systems: AffectedSystem[],
  ): RiskLevel {
    // Weight factors:
    // - File count: more files = higher risk
    // - Transitive modules: widespread impact = higher risk
    // - Average confidence: low confidence could go either way

    let score = 0;

    // File count factor
    if (totalFiles <= 5) score += 1;
    else if (totalFiles <= 20) score += 2;
    else if (totalFiles <= 50) score += 4;
    else score += 6;

    // Transitive impact factor
    if (transitiveModules === 0) score += 0;
    else if (transitiveModules <= 3) score += 1;
    else if (transitiveModules <= 10) score += 3;
    else score += 5;

    // System count factor
    const sysCount = systems.length;
    if (sysCount <= 1) score += 0;
    else if (sysCount <= 3) score += 2;
    else score += 4;

    // Average confidence factor (inverse: low confidence = higher risk from uncertainty)
    const avgConfidence =
      systems.length > 0
        ? systems.reduce((sum, s) => sum + s.confidence, 0) / systems.length
        : 1;
    if (avgConfidence < 0.5) score += 3;
    else if (avgConfidence < 0.8) score += 1;

    if (score <= 4) return "low";
    if (score <= 8) return "medium";
    if (score <= 12) return "high";
    return "critical";
  }
}

// ── Convenience Factory ───────────────────────────────────────────────────────

/**
 * Create an ImpactAnalyzer from the current project's ArchitectureMap.
 * This is the primary entry point for UI components.
 */
export async function createImpactAnalyzer(): Promise<ImpactAnalyzer> {
  const archMap = await buildArchitectureMap();
  return new ImpactAnalyzer(archMap);
}