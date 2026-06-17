/**
 * Task 10.8 — Security Scanner Integration Test
 *
 * Verifies all 13 SecurityPattern categories detect vulnerable code correctly.
 * Each test provides a deliberately vulnerable code snippet for one pattern,
 * then asserts the pattern's regex matches at the expected severity.
 *
 * Run: npx tsx src/__tests__/security-scanner.integration.test.ts
 */

import { SECURITY_PATTERNS, type SecurityPattern, type Severity } from "../services/security/SecurityPatterns";

// ── Test helpers ────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function assert(name: string, condition: boolean, detail?: string) {
  if (condition) {
    passed++;
    console.log(`  ✅ ${name}`);
  } else {
    failed++;
    console.error(`  ❌ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

function findPattern(id: string): SecurityPattern {
  const p = SECURITY_PATTERNS.find((p) => p.id === id);
  if (!p) throw new Error(`Pattern not found: ${id}`);
  return p;
}

/** Apply all patterns of a given severity against code and assert at least one match. */
function assertDetects(
  id: string,
  code: string,
  expectedSeverity: Severity,
) {
  const pattern = findPattern(id);
  assert(
    `${id} severity matches`,
    pattern.severity === expectedSeverity,
    `expected ${expectedSeverity}, got ${pattern.severity}`,
  );

  const matched = pattern.patterns.some((re) => {
    // Reset regex state
    re.lastIndex = 0;
    return re.test(code);
  });

  assert(`${id} detects snippet`, matched, JSON.stringify(code.slice(0, 60)));
}

// ── Test Cases (one per unique pattern ID) ─────────────────────────────────

console.log("\n═══ Security Scanner Integration Test — Phase 10.8 ═══\n");

// 1) sql-injection-string-concat
assertDetects(
  "sql-injection-string-concat",
  `const query = "SELECT * FROM users WHERE id = " + userId;`,
  "critical",
);

// 2) sql-injection-raw-execute
assertDetects(
  "sql-injection-raw-execute",
  `db.execute("DELETE FROM sessions WHERE token = " + tok);`,
  "critical",
);

// 3) xss-dangerously-set-inner-html
assertDetects(
  "xss-dangerously-set-inner-html",
  `<div dangerouslySetInnerHTML={{ __html: userInput }} />`,
  "high",
);

// 4) xss-inner-html-assignment
assertDetects(
  "xss-inner-html-assignment",
  `document.getElementById("out").innerHTML = userData;`,
  "high",
);

// 5) xss-eval-with-user-input
assertDetects(
  "xss-eval-with-user-input",
  `eval(userCode);`,
  "critical",
);

// 6) hardcoded-api-key
assertDetects(
  "hardcoded-api-key",
  `const OPENAI_API_KEY = "sk-proj-abcdefghijklmnopqrstuvwxyz";`,
  "critical",
);

// 7) hardcoded-jwt-secret
assertDetects(
  "hardcoded-jwt-secret",
  `const JWT_SECRET = "super-secret-signing-key-do-not-commit";`,
  "critical",
);

// 8) hardcoded-database-credentials
assertDetects(
  "hardcoded-database-credentials",
  `const DATABASE_URL = "postgres://admin:pass123@db.host:5432/mydb";`,
  "critical",
);

// 9) unsafe-deserialization
assertDetects(
  "unsafe-deserialization",
  `const data = JSON.parse(req.body.payload);`,
  "high",
);

// 10) unsafe-child-process
assertDetects(
  "unsafe-child-process",
  `child_process.exec("rm -rf " + userPath);`,
  "critical",
);

// 11) path-traversal-user-input
assertDetects(
  "path-traversal-user-input",
  `fs.readFile(req.query.file);`,
  "high",
);

// 12) weak-hash-algorithm
assertDetects(
  "weak-hash-algorithm",
  `const hash = crypto.createHash("md5").update(data).digest("hex");`,
  "high",
);

// 13) weak-encryption-cipher
assertDetects(
  "weak-encryption-cipher",
  `const cipher = crypto.createCipheriv("des", key, iv);`,
  "high",
);

// ── Summary ─────────────────────────────────────────────────────────────────

const total = passed + failed;
console.log(`\n═══ Results: ${passed}/${total} passed, ${failed} failed ═══\n`);

if (failed > 0) {
  process.exit(1);
}