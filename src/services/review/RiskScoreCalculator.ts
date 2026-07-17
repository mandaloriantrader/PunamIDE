/**
 * @phase P1
 * @purpose Computes compositeRiskScore (0-100, higher = riskier).
 *
 * Formula (deterministic, documented):
 *   1. Inverted debt score: (100 - debtScore) × 0.40  → max 40 pts
 *   2. Churn multiplier: min(findingCount × (commitsLast30d / 10), 20)  → max 20 pts
 *   3. Finding severity: critical=15, high=10, medium=5, low=2, info=0
 *      per finding, capped at 25 pts
 *   4. Coupling penalty: instability > 0.7 → +10, fanOut > 10 → +5  → max 15 pts
 *   Total capped at 100.
 */

import { type Finding, type FileRiskProfile, type Severity, type ChurnData, type CouplingData } from './types';

/** Severity to point value mapping for risk scoring. */
const SEVERITY_POINTS: Record<Severity, number> = {
  critical: 15,
  high: 10,
  medium: 5,
  low: 2,
  info: 0,
};

/**
 * Computes the composite risk score for a single file.
 *
 * @param debtScore - Existing DebtScorer output (0-100, higher = healthier)
 * @param findings - All findings for this file
 * @param churn - Git churn data
 * @param coupling - Coupling metrics
 * @returns Composite risk score (0-100, higher = riskier)
 */
export function calculateCompositeRiskScore(
  debtScore: number,
  findings: Finding[],
  churn: ChurnData,
  coupling: CouplingData,
): number {
  // 1. Inverted debt score (40% weight, max 40 pts)
  const debtComponent = (100 - debtScore) * 0.40;

  // 2. Churn multiplier (max 20 pts)
  // Complexity proxy = finding count; multiplied by commit frequency
  const churnComponent = Math.min(
    findings.length * (churn.commitsLast30d / 10),
    20,
  );

  // 3. Finding severity (max 25 pts)
  let findingComponent = 0;
  for (const f of findings) {
    findingComponent += SEVERITY_POINTS[f.severity];
  }
  findingComponent = Math.min(findingComponent, 25);

  // 4. Coupling penalty (max 15 pts)
  let couplingComponent = 0;
  if (coupling.instability > 0.7) couplingComponent += 10;
  if (coupling.fanOut > 10) couplingComponent += 5;

  // Total, capped at 100
  const total = debtComponent + churnComponent + findingComponent + couplingComponent;
  return Math.round(Math.min(total, 100));
}

/**
 * Computes composite risk scores for all files and returns updated profiles.
 *
 * @param profiles - Map of file path to partial profile (without compositeRiskScore)
 * @returns Updated map with compositeRiskScore populated
 */
export function computeAllRiskScores(
  profiles: Map<string, Omit<FileRiskProfile, 'compositeRiskScore'>>,
): Map<string, FileRiskProfile> {
  const result = new Map<string, FileRiskProfile>();
  for (const [file, profile] of profiles) {
    const score = calculateCompositeRiskScore(
      profile.debtScore,
      profile.findings,
      profile.churn,
      profile.coupling,
    );
    result.set(file, { ...profile, compositeRiskScore: score });
  }
  return result;
}
