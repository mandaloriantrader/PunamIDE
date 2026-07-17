/**
 * @phase P8
 * @purpose Manages benchmark datasets for accuracy measurement.
 *          Required before any "standalone product" claim — every
 *          serious competitor is measured on bug-catch-rate against
 *          real PR datasets.
 */

import { SupportedLanguage } from './MultiLanguageManager';
import { type Severity } from './types';

/** A known bug in a benchmark PR. */
export interface KnownBug {
  id: string;
  file: string;
  line: number;
  category: 'security' | 'type' | 'logic' | 'null-safety' | 'performance' | 'architecture';
  description: string;
  severity: Severity;
  cwe?: string;
}

/** Metadata about a benchmark PR. */
export interface PRMetadata {
  title: string;
  author: string;
  mergedAt: string;
  labels: string[];
}

/** A single PR in a benchmark dataset. */
export interface BenchmarkPR {
  id: string;
  repoUrl: string;
  baseSha: string;
  headSha: string;
  diff: string;
  knownBugs: KnownBug[];
  metadata: PRMetadata;
}

/** A complete benchmark dataset. */
export interface BenchmarkDataset {
  id: string;
  name: string;
  description: string;
  language: SupportedLanguage;
  prs: BenchmarkPR[];
  createdAt: string;
  version: string;
}

/**
 * Manages benchmark datasets. Handles loading from JSON, validation,
 * and provides sample datasets for testing.
 */
export class BenchmarkDataset {
  /** Loads a dataset from a JSON string. */
  static fromJson(json: string): BenchmarkDataset {
    const data = JSON.parse(json) as BenchmarkDataset;
    BenchmarkDataset.validate(data);
    return data;
  }

  /**
   * Validates dataset integrity — all known bugs have required fields.
   * @throws Error if validation fails
   */
  static validate(dataset: BenchmarkDataset): void {
    if (!dataset.id) throw new Error('Dataset missing id');
    if (!dataset.name) throw new Error('Dataset missing name');
    if (!dataset.prs || dataset.prs.length === 0) throw new Error('Dataset has no PRs');

    for (const pr of dataset.prs) {
      if (!pr.id) throw new Error(`PR missing id in dataset ${dataset.id}`);
      if (!pr.diff) throw new Error(`PR ${pr.id} missing diff`);
      if (!pr.knownBugs) throw new Error(`PR ${pr.id} missing knownBugs array`);

      for (const bug of pr.knownBugs) {
        if (!bug.id) throw new Error(`Bug missing id in PR ${pr.id}`);
        if (!bug.file) throw new Error(`Bug ${bug.id} missing file`);
        if (!bug.line || bug.line < 1) throw new Error(`Bug ${bug.id} has invalid line`);
        if (!bug.category) throw new Error(`Bug ${bug.id} missing category`);
        if (!bug.severity) throw new Error(`Bug ${bug.id} missing severity`);
      }
    }
  }

  /**
   * Gets statistics about the dataset.
   */
  static getStats(dataset: BenchmarkDataset): {
    totalPRs: number;
    totalBugs: number;
    bugsByCategory: Record<string, number>;
    bugsBySeverity: Record<string, number>;
  } {
    const bugsByCategory: Record<string, number> = {};
    const bugsBySeverity: Record<string, number> = {};
    let totalBugs = 0;

    for (const pr of dataset.prs) {
      for (const bug of pr.knownBugs) {
        totalBugs++;
        bugsByCategory[bug.category] = (bugsByCategory[bug.category] ?? 0) + 1;
        bugsBySeverity[bug.severity] = (bugsBySeverity[bug.severity] ?? 0) + 1;
      }
    }

    return {
      totalPRs: dataset.prs.length,
      totalBugs,
      bugsByCategory,
      bugsBySeverity,
    };
  }
}

/**
 * Sample benchmark dataset for TypeScript.
 * Contains 4 sample PRs with known bugs for testing the benchmark runner.
 * In production, this would be replaced with real merged PRs from
 * open-source TypeScript repos with documented bugs.
 */
export const SAMPLE_TYPESCRIPT_DATASET: BenchmarkDataset = {
  id: 'ts-sample-v1',
  name: 'TypeScript Sample Benchmark',
  description: 'Sample dataset with 4 PRs containing known bugs for benchmark testing',
  language: SupportedLanguage.TypeScript,
  version: '1.0.0',
  createdAt: '2025-01-01T00:00:00Z',
  prs: [
    {
      id: 'pr-001',
      repoUrl: 'https://github.com/example/repo',
      baseSha: 'abc123',
      headSha: 'def456',
      diff: `diff --git a/src/handler.ts b/src/handler.ts
--- a/src/handler.ts
+++ b/src/handler.ts
@@ -10,6 +10,12 @@
 function processRequest(req: Request) {
   const data = req.body;
+  const result = eval(data.expression);
+  return result;
+}
+function getUser(id: string) {
+  const user = db.query(\`SELECT * FROM users WHERE id = \${id}\`);
+  return user;
 }`,
      knownBugs: [
        {
          id: 'bug-001',
          file: 'src/handler.ts',
          line: 12,
          category: 'security',
          description: 'eval() with untrusted user input',
          severity: 'critical',
          cwe: 'CWE-94',
        },
        {
          id: 'bug-002',
          file: 'src/handler.ts',
          line: 17,
          category: 'security',
          description: 'SQL injection via string interpolation',
          severity: 'critical',
          cwe: 'CWE-89',
        },
      ],
      metadata: {
        title: 'Add request handler and user lookup',
        author: 'developer1',
        mergedAt: '2025-01-15T10:00:00Z',
        labels: ['feature', 'security-review-needed'],
      },
    },
    {
      id: 'pr-002',
      repoUrl: 'https://github.com/example/repo',
      baseSha: 'abc123',
      headSha: 'def456',
      diff: `diff --git a/src/service.ts b/src/service.ts
--- a/src/service.ts
+++ b/src/service.ts
@@ -5,6 +5,15 @@
 async function fetchData(url: string) {
+  const response = await fetch(url);
+  const data = response.json();
+  return data;
+}
+function processUser(user: User | null) {
+  return user.name;
 }`,
      knownBugs: [
        {
          id: 'bug-003',
          file: 'src/service.ts',
          line: 7,
          category: 'type',
          description: 'Missing await on response.json() — returns a Promise, not the data',
          severity: 'high',
        },
        {
          id: 'bug-004',
          file: 'src/service.ts',
          line: 11,
          category: 'null-safety',
          description: 'Accessing user.name without null check — user can be null',
          severity: 'high',
          cwe: 'CWE-476',
        },
      ],
      metadata: {
        title: 'Add data fetching and user processing',
        author: 'developer2',
        mergedAt: '2025-01-20T14:00:00Z',
        labels: ['feature'],
      },
    },
    {
      id: 'pr-003',
      repoUrl: 'https://github.com/example/repo',
      baseSha: 'abc123',
      headSha: 'def456',
      diff: `diff --git a/src/cache.ts b/src/cache.ts
--- a/src/cache.ts
+++ b/src/cache.ts
@@ -3,6 +3,18 @@
 class Cache {
+  get(key: string) {
+    return this.data[key];
+  }
+  set(key: string, value: any) {
+    this.data[key] = value;
+  }
+  async refresh() {
+    const data = await fetch('/api/data');
+    this.data = data;
+    for (let i = 0; i <= this.items.length; i++) {
+      this.process(this.items[i]);
+    }
+  }
 }`,
      knownBugs: [
        {
          id: 'bug-005',
          file: 'src/cache.ts',
          line: 7,
          category: 'type',
          description: 'Using `any` type — bypasses type checking',
          severity: 'medium',
        },
        {
          id: 'bug-006',
          file: 'src/cache.ts',
          line: 15,
          category: 'logic',
          description: 'Off-by-one error: <= should be < in loop',
          severity: 'high',
        },
      ],
      metadata: {
        title: 'Add cache implementation',
        author: 'developer3',
        mergedAt: '2025-02-01T09:00:00Z',
        labels: ['feature', 'bug'],
      },
    },
    {
      id: 'pr-004',
      repoUrl: 'https://github.com/example/repo',
      baseSha: 'abc123',
      headSha: 'def456',
      diff: `diff --git a/src/auth.ts b/src/auth.ts
--- a/src/auth.ts
+++ b/src/auth.ts
@@ -8,6 +8,20 @@
 function authenticate(token: string) {
+  const decoded = Buffer.from(token, 'base64').toString();
+  const user = JSON.parse(decoded);
+  if (user.role === 'admin') {
+    return { authorized: true, user };
+  }
+  return { authorized: false };
+}
+function redirect(url: string) {
+  res.redirect(url);
+}`,
      knownBugs: [
        {
          id: 'bug-007',
          file: 'src/auth.ts',
          line: 10,
          category: 'security',
          description: 'Token not verified — trusting client-provided role without signature validation',
          severity: 'critical',
          cwe: 'CWE-345',
        },
        {
          id: 'bug-008',
          file: 'src/auth.ts',
          line: 18,
          category: 'security',
          description: 'Open redirect — URL not validated before redirect',
          severity: 'medium',
          cwe: 'CWE-601',
        },
      ],
      metadata: {
        title: 'Add authentication and redirect',
        author: 'developer4',
        mergedAt: '2025-02-10T16:00:00Z',
        labels: ['security', 'auth'],
      },
    },
  ],
};

// ── Singleton pattern (follows existing codebase convention) ───────
// BenchmarkDataset uses static methods, so no singleton needed.
// Pattern shown for consistency:
let instance: BenchmarkDataset | null = null;

export function getBenchmarkDatasetManager(): BenchmarkDataset {
  if (!instance) instance = new BenchmarkDataset();
  return instance;
}
