/**
 * CouplingAnalyzer.ts — Phase 4
 *
 * Computes coupling metrics for every file in the workspace graph.
 *
 * Metrics:
 *
 *  Fan-in  (afferent coupling, Ca)
 *    Number of files that import this file.
 *    High fan-in = this file is heavily depended upon.
 *    Not inherently bad — shared utilities have high fan-in.
 *    Becomes a problem when combined with high fan-out (god module).
 *
 *  Fan-out (efferent coupling, Ce)
 *    Number of files this file imports.
 *    High fan-out = this file knows too much about the rest of the system.
 *    Makes testing and refactoring expensive.
 *
 *  Instability (I = Ce / (Ca + Ce))
 *    0 = maximally stable (many dependents, few dependencies)
 *    1 = maximally unstable (few dependents, many dependencies)
 *    Core shared modules should have low instability.
 *    Leaf/feature modules typically have high instability — that's fine.
 *
 *  Coupling score (0–100, higher = more coupled / worse)
 *    Composite score used by DebtScorer and RefactorPlanner.
 *    Combines fan-out, instability, and whether the file is in a cycle.
 *
 *  Hub file detection
 *    A file is a hub if:
 *      fan-in  > HUB_FAN_IN_THRESHOLD  AND
 *      fan-out > HUB_FAN_OUT_THRESHOLD
 *    Hub files are architectural bottlenecks — changing them risks
 *    cascading failures across many modules.
 *
 * Dependency Risk Score (per module/file)
 *    Combines coupling score + cycle membership + instability.
 *    This is the score that flows into DebtHotspot and RefactorPlanner
 *    as the "architectural" issue signal.
 *
 * Phase 5 hook: externalDeps count per file available on FileCouplingMetrics.
 * Dead code analysis will use this to weight unused-export severity.
 */

import type { DependencyGraph, GraphNode } from './DependencyGraphEngine'
import type { CycleDetectionResult } from './CircularDepDetector'

// ── Thresholds ─────────────────────────────────────────────────────────────────

const HUB_FAN_IN_THRESHOLD  = 10   // imported by 10+ files
const HUB_FAN_OUT_THRESHOLD = 8    // imports 8+ files
const HIGH_FAN_OUT           = 10  // fan-out above this = high coupling penalty
const HIGH_FAN_IN_STANDALONE = 20  // fan-in above this without high fan-out = shared util (acceptable)

// ── Types ──────────────────────────────────────────────────────────────────────

export interface FileCouplingMetrics {
  filePath: string
  fanIn: number
  fanOut: number
  instability: number         // 0–1
  couplingScore: number       // 0–100, higher = more coupled
  isHubFile: boolean
  isInCycle: boolean
  dependencyRiskScore: number // 0–100, used by RefactorPlanner
  externalDepCount: number
}

export interface CouplingAnalysis {
  files: FileCouplingMetrics[]

  /** Files classified as hub files (high fan-in AND high fan-out). */
  hubFiles: string[]

  /**
   * Coupling scores keyed by file path — convenience map for RefactorPlanner.
   * Same data as files[], just indexed.
   */
  couplingScores: Record<string, number>

  /**
   * Dependency risk scores keyed by file path.
   * Used by DebtScorer to inflate fileScore penalty for architecturally risky files.
   */
  dependencyRiskScores: Record<string, number>

  /** Average coupling score across all files (workspace-level signal). */
  averageCoupling: number

  /** p90 fan-out (90th percentile) — used to calibrate hub detection. */
  p90FanOut: number

  /** p90 fan-in. */
  p90FanIn: number
}

// ── CouplingAnalyzer ───────────────────────────────────────────────────────────

export class CouplingAnalyzer {

  /**
   * Analyze coupling for all files in the graph.
   *
   * @param graph   Workspace dependency graph
   * @param cycles  Cycle detection result — used to flag files in cycles
   */
  analyze(
    graph: DependencyGraph,
    cycles: CycleDetectionResult,
  ): CouplingAnalysis {
    const allFiles = [...graph.nodes.values()]

    // ── Compute percentiles for adaptive thresholds ─────────────────────────
    const fanOuts  = allFiles.map((n) => n.fanOut).sort((a, b) => a - b)
    const fanIns   = allFiles.map((n) => n.fanIn).sort((a, b) => a - b)
    const p90FanOut = percentile(fanOuts, 90)
    const p90FanIn  = percentile(fanIns, 90)

    // Use adaptive hub thresholds: max of static threshold and p90
    // This prevents flagging everything as a hub in small workspaces
    const effectiveHubFanIn  = Math.max(HUB_FAN_IN_THRESHOLD,  Math.round(p90FanIn  * 1.5))
    const effectiveHubFanOut = Math.max(HUB_FAN_OUT_THRESHOLD, Math.round(p90FanOut * 1.5))

    // ── Per-file metrics ────────────────────────────────────────────────────
    const files: FileCouplingMetrics[] = allFiles.map((node) => {
      const isInCycle     = cycles.filesInCycles.has(node.filePath)
      const externalDeps  = node.externalDeps.length
      const isHubFile     = node.fanIn  >= effectiveHubFanIn &&
                            node.fanOut >= effectiveHubFanOut

      const instability   = computeInstability(node.fanIn, node.fanOut)
      const couplingScore = this.computeCouplingScore(node, isInCycle, isHubFile)
      const depRiskScore  = this.computeDependencyRiskScore(
        node, isInCycle, isHubFile, instability, couplingScore
      )

      return {
        filePath:            node.filePath,
        fanIn:               node.fanIn,
        fanOut:              node.fanOut,
        instability,
        couplingScore,
        isHubFile,
        isInCycle,
        dependencyRiskScore: depRiskScore,
        externalDepCount:    externalDeps,
      }
    })

    // Sort worst-first
    files.sort((a, b) => b.couplingScore - a.couplingScore)

    const hubFiles         = files.filter((f) => f.isHubFile).map((f) => f.filePath)
    const couplingScores   = Object.fromEntries(files.map((f) => [f.filePath, f.couplingScore]))
    const depRiskScores    = Object.fromEntries(files.map((f) => [f.filePath, f.dependencyRiskScore]))
    const averageCoupling  = files.length > 0
      ? Math.round(files.reduce((s, f) => s + f.couplingScore, 0) / files.length)
      : 0

    return {
      files,
      hubFiles,
      couplingScores,
      dependencyRiskScores: depRiskScores,
      averageCoupling,
      p90FanOut,
      p90FanIn,
    }
  }

  // ── Coupling score ────────────────────────────────────────────────────────────

  /**
   * Coupling score: 0–100, higher = more coupled.
   *
   * Components:
   *  - Fan-out penalty (primary driver of coupling problems)
   *  - Hub file penalty (amplifies score for architectural bottlenecks)
   *  - Cycle membership penalty (cycles are always bad)
   *  - Fan-in bonus reduction (high fan-in alone is OK — shared utilities)
   */
  private computeCouplingScore(
    node: GraphNode,
    isInCycle: boolean,
    isHubFile: boolean,
  ): number {
    let score = 0

    // Fan-out: each import adds to coupling
    // Logarithmic scaling — first few imports are fine, high counts penalised heavily
    if (node.fanOut > 0) {
      score += Math.min(40, Math.round(Math.log2(node.fanOut + 1) * 10))
    }

    // High absolute fan-out is dangerous regardless of log scaling
    if (node.fanOut >= HIGH_FAN_OUT) {
      score += Math.min(20, (node.fanOut - HIGH_FAN_OUT) * 2)
    }

    // Hub file: both high fan-in and fan-out = architectural bottleneck
    if (isHubFile) {
      score += 25
      // Extra penalty for very large hubs
      if (node.fanIn > HIGH_FAN_IN_STANDALONE) score += 10
    }

    // Cycle membership: always a problem, always penalised
    if (isInCycle) score += 20

    // High fan-in alone (without high fan-out) = shared utility — reduce penalty
    // Utilities with many importers but few outgoing deps are healthy
    if (node.fanIn > HIGH_FAN_IN_STANDALONE && node.fanOut <= 3) {
      score = Math.max(0, score - 15)
    }

    return Math.min(100, Math.round(score))
  }

  // ── Dependency risk score ──────────────────────────────────────────────────────

  /**
   * Dependency risk score: 0–100.
   * More holistic than coupling score — used as the "architectural debt" signal.
   * Incorporates instability, cycle membership, and hub status.
   */
  private computeDependencyRiskScore(
    node: GraphNode,
    isInCycle: boolean,
    isHubFile: boolean,
    instability: number,
    couplingScore: number,
  ): number {
    let risk = couplingScore * 0.5  // base from coupling

    // Instability penalty: highly unstable files that many others depend on
    // are the most dangerous (high fan-in + high instability = ticking clock)
    if (node.fanIn > 5 && instability > 0.7) {
      risk += 20
    }

    // Cycle membership is always high-risk
    if (isInCycle) risk += 25

    // Hub files carry architectural risk even with low coupling scores
    if (isHubFile) risk += 15

    return Math.min(100, Math.round(risk))
  }
}

// ── Utilities ──────────────────────────────────────────────────────────────────

/**
 * Martin's instability metric: I = Ce / (Ca + Ce)
 * Ca = fan-in (afferent), Ce = fan-out (efferent)
 * Returns 0 if both are 0 (isolated file).
 */
function computeInstability(fanIn: number, fanOut: number): number {
  const total = fanIn + fanOut
  if (total === 0) return 0
  return Math.round((fanOut / total) * 100) / 100
}

/** Compute the Nth percentile of a sorted array. */
function percentile(sorted: number[], n: number): number {
  if (sorted.length === 0) return 0
  const idx = Math.floor((n / 100) * (sorted.length - 1))
  return sorted[Math.min(idx, sorted.length - 1)]
}

// ── Singleton ──────────────────────────────────────────────────────────────────

let instance: CouplingAnalyzer | null = null

export function getCouplingAnalyzer(): CouplingAnalyzer {
  if (!instance) instance = new CouplingAnalyzer()
  return instance
}
