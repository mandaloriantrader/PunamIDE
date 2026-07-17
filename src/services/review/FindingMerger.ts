/**
 * @phase P1
 * @purpose Merges Finding[] arrays from multiple analysis sources.
 *          Deduplicates, sorts, groups by file, and caps per-file
 *          to prevent dashboard overload.
 */

import { type Finding, type MergeStats, SEVERITY_RANK, CONFIDENCE_RANK, type FindingSource } from './types';

/**
 * Merges findings from multiple sources into a single sorted, deduplicated array.
 *
 * @param findingsBySource - Map of source name to findings from that source
 * @param maxPerFile - Maximum findings per file (default 50)
 * @returns Merged findings and merge statistics
 */
export function mergeFindings(
  findingsBySource: Map<string, Finding[]>,
  maxPerFile: number = 50,
): { findings: Finding[]; stats: MergeStats } {
  const allFindings: Finding[] = [];
  const perSource: Record<string, number> = {};

  // Flatten all findings
  for (const [source, findings] of findingsBySource) {
    perSource[source] = findings.length;
    allFindings.push(...findings);
  }

  const totalInput = allFindings.length;

  // Deduplicate: same file + line + source + title = duplicate
  const seen = new Set<string>();
  const deduped: Finding[] = [];

  for (const f of allFindings) {
    const key = `${f.file}:${f.line ?? -1}:${f.source}:${f.title}`;
    if (!seen.has(key)) {
      seen.add(key);
      deduped.push(f);
    }
  }

  const duplicatesRemoved = totalInput - deduped.length;

  // Sort: severity desc, then confidence desc, then file name
  deduped.sort((a, b) => {
    const sevDiff = SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity];
    if (sevDiff !== 0) return sevDiff;
    const confDiff = CONFIDENCE_RANK[b.confidence] - CONFIDENCE_RANK[a.confidence];
    if (confDiff !== 0) return confDiff;
    return a.file.localeCompare(b.file);
  });

  // Group by file and cap per file
  const byFile = new Map<string, Finding[]>();
  for (const f of deduped) {
    if (!byFile.has(f.file)) byFile.set(f.file, []);
    byFile.get(f.file)!.push(f);
  }

  const capped: Finding[] = [];
  for (const [, fileFindings] of byFile) {
    capped.push(...fileFindings.slice(0, maxPerFile));
  }

  const stats: MergeStats = {
    totalInput,
    totalOutput: capped.length,
    duplicatesRemoved,
    perSource,
  };

  return { findings: capped, stats };
}

/**
 * Groups findings by file path.
 * @param findings - Array of findings
 * @returns Map of file path to findings for that file
 */
export function groupByFile(findings: Finding[]): Map<string, Finding[]> {
  const map = new Map<string, Finding[]>();
  for (const f of findings) {
    if (!map.has(f.file)) map.set(f.file, []);
    map.get(f.file)!.push(f);
  }
  return map;
}

/**
 * Filters findings based on filter criteria.
 * @param findings - Array of findings
 * @param filter - Filter criteria
 * @returns Filtered findings
 */
export function filterFindings(findings: Finding[], filter: {
  sources?: FindingSource[];
  severities?: string[];
  files?: string[];
  cwe?: string;
}): Finding[] {
  return findings.filter(f => {
    if (filter.sources && !filter.sources.includes(f.source)) return false;
    if (filter.severities && !filter.severities.includes(f.severity)) return false;
    if (filter.files && !filter.files.includes(f.file)) return false;
    if (filter.cwe && f.cwe !== filter.cwe) return false;
    return true;
  });
}
