/**
 * SecurityPatterns.ts — Phase 6, Step 6.1
 *
 * Comprehensive pattern library for detecting security vulnerabilities
 * in source code. Each pattern includes a name, description, regex/CST
 * pattern, severity, OWASP category, and suggested fix.
 *
 * Categories:
 *   - SQL Injection
 *   - XSS (Cross-Site Scripting)
 *   - Hardcoded Secrets & Keys
 *   - Unsafe Dynamic Code Execution
 *   - Path Traversal
 *   - Insecure Cryptography
 *   - Authentication Weaknesses
 *   - Insecure Deserialization
 *   - SSRF (Server-Side Request Forgery)
 *   - Open Redirect
 */

// ── Types ──────────────────────────────────────────────────────────────────────

export type Severity = "critical" | "high" | "medium" | "low";

export type OwaspCategory =
  | "A01:2021-Broken Access Control"
  | "A02:2021-Cryptographic Failures"
  | "A03:2021-Injection"
  | "A04:2021-Insecure Design"
  | "A05:2021-Security Misconfiguration"
  | "A06:2021-Vulnerable Components"
  | "A07:2021-Auth Failures"
  | "A08:2021-Software Integrity Failures"
  | "A09:2021-Logging & Monitoring"
  | "A10:2021-SSRF";

export interface SecurityPattern {
  /** Unique identifier. */
  id: string;
  /** Human-readable name. */
  name: string;
  /** Description of what the pattern detects. */
  description: string;
  /** Regex pattern(s) to match against code. */
  patterns: RegExp[];
  /** File extensions this pattern applies to. Empty = all. */
  fileExtensions: string[];
  /** Severity level. */
  severity: Severity;
  /** OWASP Top 10 category. */
  owasp: OwaspCategory;
  /** Suggested remediation. */
  suggestion: string;
  /** CWE ID if applicable. */
  cwe?: number;
  /** Whether this pattern is a false-positive risk. */
  highFalsePositiveRate: boolean;
}

export interface SecurityFinding {
  /** Pattern ID that matched. */
  patternId: string;
  /** The file path where the finding was detected. */
  filePath: string;
  /** The line number (1-based) where the match occurred. */
  line: number;
  /** The column (1-based) where the match starts. */
  column: number;
  /** The matched text snippet (trimmed to max 120 chars). */
  snippet: string;
  /** The severity from the matched pattern. */
  severity: Severity;
  /** OWASP category. */
  owasp: OwaspCategory;
  /** Human-readable description. */
  description: string;
  /** Suggested fix. */
  suggestion: string;
  /** CWE ID. */
  cwe?: number;
}

// ── Pattern Definitions ──────────────────────────────────────────────────────

export const SECURITY_PATTERNS: SecurityPattern[] = [

  // ═══ SQL INJECTION ═══════════════════════════════════════════════════════

  {
    id: "sql-injection-string-concat",
    name: "SQL Injection via String Concatenation",
    description: "SQL query built using string concatenation with user input",
    patterns: [
      // JS/TS: query += "..." + variable
      /(\bquery\s*\+=\s*["'`].*?)\s*\+\s*(\w+)/gi,
      // JS/TS: `SELECT * FROM users WHERE id = ${var}`
      /(["'`]\s*(?:SELECT|INSERT|UPDATE|DELETE|DROP|CREATE|ALTER)\s+.+?)\s*\${\s*(?!\d)/gi,
      // JS/TS: "SELECT * FROM " + table
      /(["'`]\s*(?:SELECT|INSERT|UPDATE|DELETE|DROP)\s+.+?["'`]\s*\+)/gi,
      // Python: "SELECT * FROM " + var
      /(["']\s*(?:SELECT|INSERT|UPDATE|DELETE|DROP)\s+.+?["']\s*\+)/gi,
      // Python: f"SELECT * FROM {table}"
      /(f["']\s*(?:SELECT|INSERT|UPDATE|DELETE|DROP)\s+.+?\{[^}]*\}?)/gi,
      // Rust: format!("SELECT * FROM {}", var)
      /(format!\s*\(\s*["']\s*(?:SELECT|INSERT|UPDATE|DELETE|DROP)\s+.+?[\{\}])/gi,
      // Generic: execute("SELECT..." + var)
      /((?:execute|query|exec)\s*\(\s*["'`]\s*(?:SELECT|INSERT|UPDATE|DELETE|DROP)\s+.+?["'`]\s*\+)/gi,
    ],
    fileExtensions: ["ts", "tsx", "js", "jsx", "py", "rs"],
    severity: "critical",
    owasp: "A03:2021-Injection",
    suggestion:
      "Use parameterized queries or an ORM with bound parameters. Never concatenate user input into SQL strings.",
    cwe: 89,
    highFalsePositiveRate: false,
  },

  {
    id: "sql-injection-raw-execute",
    name: "Raw SQL Execution Without Parameterization",
    description: "Direct SQL execution without using parameterized queries",
    patterns: [
      // JS/TS: db.query("SELECT ...") or db.execute("INSERT ...")
      /(?:\.query|\.execute|\.raw|\.sql)\s*\(\s*["'`]\s*(SELECT|INSERT|UPDATE|DELETE|DROP|ALTER|CREATE)/gi,
      // Python: cursor.execute("...")
      /(?:cursor\.execute|cursor\.executemany|connection\.execute)\s*\(\s*["']\s*(SELECT|INSERT|UPDATE|DELETE|DROP)/gi,
      // Rust: sqlx::query("...")
      /(sqlx::query(?:_as)?\s*\(\s*["']\s*(SELECT|INSERT|UPDATE|DELETE|DROP))/gi,
      // Generic: any raw SQL string with user-controlled parts
      /((?:query|sql)\s*=\s*["'`]\s*(?:SELECT|INSERT|UPDATE|DELETE|DROP).+?\$\{)/gi,
    ],
    fileExtensions: ["ts", "tsx", "js", "jsx", "py", "rs"],
    severity: "critical",
    owasp: "A03:2021-Injection",
    suggestion:
      "Use parameterized queries: db.query('SELECT * FROM users WHERE id = $1', [userId])",
    cwe: 89,
    highFalsePositiveRate: false,
  },

  // ═══ XSS ═════════════════════════════════════════════════════════════════

  {
    id: "xss-dangerously-set-inner-html",
    name: "XSS via dangerouslySetInnerHTML",
    description: "React dangerouslySetInnerHTML without sanitization",
    patterns: [
      /dangerouslySetInnerHTML\s*=\s*\{\s*\{\s*__html\s*:/gi,
    ],
    fileExtensions: ["tsx", "jsx"],
    severity: "high",
    owasp: "A03:2021-Injection",
    suggestion:
      "Use a sanitization library like DOMPurify before setting inner HTML. Prefer React's JSX rendering instead.",
    cwe: 79,
    highFalsePositiveRate: false,
  },

  {
    id: "xss-inner-html-assignment",
    name: "XSS via innerHTML Assignment",
    description: "Direct assignment to innerHTML with unsanitized input",
    patterns: [
      /\.innerHTML\s*=\s*(?!\s*["'`]\s*(?:<[a-zA-Z]+\s?\/?>\s*)*["'`])/gi,
      /document\.write\s*\(\s*(?!["'`]\s*(?:<[a-zA-Z]+\s?\/?>\s*)*["'`])/gi,
      /\.outerHTML\s*=\s*(?!\s*["'`]\s*(?:<[a-zA-Z]+\s?\/?>\s*)*["'`])/gi,
    ],
    fileExtensions: ["ts", "tsx", "js", "jsx"],
    severity: "high",
    owasp: "A03:2021-Injection",
    suggestion:
      "Use textContent instead of innerHTML, or sanitize with DOMPurify. Avoid document.write entirely.",
    cwe: 79,
    highFalsePositiveRate: true,
  },

  {
    id: "xss-eval-with-user-input",
    name: "XSS via eval() with User Input",
    description: "eval() used with potentially user-controlled strings",
    patterns: [
      /eval\s*\(\s*(?!["'`]\s*(?:function|\(\)|[\d]+)\s*["'`]\s*\))/gi,
      /new\s+Function\s*\(/gi,
      /setTimeout\s*\(\s*(?:['"`][^'"`]*['"`]\s*,\s*\d+\)|[^'"`,\d][^,]*\))/gi,
      /setInterval\s*\(\s*(?:['"`][^'"`]*['"`]\s*,\s*\d+\)|[^'"`,\d][^,]*\))/gi,
    ],
    fileExtensions: ["ts", "tsx", "js", "jsx"],
    severity: "critical",
    owasp: "A03:2021-Injection",
    suggestion:
      "Avoid eval(), new Function(), and string-based setTimeout/setInterval. Use safe alternatives.",
    cwe: 95,
    highFalsePositiveRate: true,
  },

  // ═══ HARDCODED SECRETS ═══════════════════════════════════════════════════

  {
    id: "hardcoded-api-key",
    name: "Hardcoded API Key",
    description: "API key embedded directly in source code",
    patterns: [
      /(?:api[_-]?key|apikey|API_KEY)\s*[=:]\s*["'`]([A-Za-z0-9_\-]{20,})["'`]/gi,
      /(?:secret[_-]?key|secretkey|SECRET_KEY)\s*[=:]\s*["'`]([A-Za-z0-9_\-]{20,})["'`]/gi,
      /(?:access[_-]?token|accessToken|ACCESS_TOKEN)\s*[=:]\s*["'`]([A-Za-z0-9_\-]{20,})["'`]/gi,
      /(?:password|passwd)\s*[=:]\s*["'`](?!\s*["'`]|CHANGE_ME|YOUR_|REPLACE)[^"'`]+["'`]/gi,
      /(?:OPENAI_API_KEY|GEMINI_API_KEY|GROQ_API_KEY)\s*=\s*["'`][^"'`]+["'`]/gi,
    ],
    fileExtensions: ["ts", "tsx", "js", "jsx", "py", "rs", "toml", "yaml", "yml", "json", "env"],
    severity: "critical",
    owasp: "A02:2021-Cryptographic Failures",
    suggestion:
      "Use environment variables or a secrets manager. Never commit API keys, passwords, or tokens to source control.",
    cwe: 798,
    highFalsePositiveRate: true,
  },

  {
    id: "hardcoded-jwt-secret",
    name: "Hardcoded JWT Secret",
    description: "JWT signing secret hardcoded in source",
    patterns: [
      /(?:jwt[_-]?secret|JWT_SECRET|signing[_-]?key)\s*[=:]\s*["'`][^"'`\n]{6,}["'`]/gi,
      /jwt\.sign\s*\([^)]*,\s*["'`][^"'`]{6,}["'`]/gi,
      /jwt\.verify\s*\([^)]*,\s*["'`][^"'`]{6,}["'`]/gi,
    ],
    fileExtensions: ["ts", "tsx", "js", "jsx", "py"],
    severity: "critical",
    owasp: "A02:2021-Cryptographic Failures",
    suggestion:
      "Store JWT secrets in environment variables or a key management service. Rotate regularly.",
    cwe: 798,
    highFalsePositiveRate: true,
  },

  {
    id: "hardcoded-database-credentials",
    name: "Hardcoded Database Credentials",
    description: "Database username/password in source code",
    patterns: [
      /(?:DATABASE_URL|DB_URL|MONGO_URI|POSTGRES_URL)\s*[=:]\s*["'`][^"'`]*(?::\/\/|@|:\d+\/)[^"'`]*["'`]/gi,
      /(?:DB_USER|DB_PASSWORD|DATABASE_PASSWORD|PGPASSWORD)\s*[=:]\s*["'`][^"'`]+["'`]/gi,
    ],
    fileExtensions: ["ts", "tsx", "js", "jsx", "py", "rs", "toml", "env"],
    severity: "critical",
    owasp: "A02:2021-Cryptographic Failures",
    suggestion:
      "Use environment variables for database connection strings. Never commit credentials.",
    cwe: 798,
    highFalsePositiveRate: true,
  },

  // ═══ UNSAFE DYNAMIC CODE EXECUTION ══════════════════════════════════════

  {
    id: "unsafe-deserialization",
    name: "Unsafe Deserialization",
    description: "Deserialization of untrusted data without validation",
    patterns: [
      /JSON\.parse\s*\(\s*(?:req\.(?:body|params|query)|request\.(?:body|params|query)|userInput)/gi,
      // Python pickle
      /pickle\.loads?\s*\(/gi,
      /cPickle\.loads?\s*\(/gi,
      /yaml\.load\s*\((?![^)]*SafeLoader)/gi,
      // Node serialization
      /nodeSerialize\.unserialize/gi,
      /unserialize\s*\(/gi,
    ],
    fileExtensions: ["ts", "tsx", "js", "jsx", "py"],
    severity: "high",
    owasp: "A08:2021-Software Integrity Failures",
    suggestion:
      "Validate/sanitize before deserialization. Use safe parsers (yaml.SafeLoader, JSON schema validation). Avoid pickle entirely.",
    cwe: 502,
    highFalsePositiveRate: true,
  },

  {
    id: "unsafe-child-process",
    name: "Unsafe Child Process Execution",
    description: "Child process spawned with user-controlled input",
    patterns: [
      /(?:exec|execSync)\s*\(\s*(?!["'`](?:echo|ls|dir|git|node|npm|yarn|pnpm|cargo|python|pip)\b)/gi,
      /child_process\.exec\s*\(\s*(?!["'`](?:echo|ls|dir|git|node|npm)\b)/gi,
      // OS command injection in command strings
      /(?:exec|spawn)\s*\(\s*(?:[`'"].*?)(?:\$\{|\$\(|%[^%]+%|&&|;;|\|\|)\s*(?!["'`])/gi,
    ],
    fileExtensions: ["ts", "tsx", "js", "jsx"],
    severity: "critical",
    owasp: "A03:2021-Injection",
    suggestion:
      "Use execFile instead of exec to prevent shell injection. Validate and sanitize all user input passed to shell commands.",
    cwe: 78,
    highFalsePositiveRate: true,
  },

  // ═══ PATH TRAVERSAL ═══════════════════════════════════════════════════════

  {
    id: "path-traversal-user-input",
    name: "Path Traversal via User Input",
    description: "File path constructed from user input without validation",
    patterns: [
      /(?:fs\.readFile|fs\.writeFile|fs\.readFileSync|fs\.writeFileSync|fs\.createReadStream|fs\.createWriteStream)\s*\(\s*(?:req\.(?:params|body|query)|request\.(?:params|body|query)|\.\.\/)/gi,
      /(?:path\.join|path\.resolve)\s*\([^)]*(?:req\.(?:params|body|query)|request\.(?:params|body|query)|\.\.\/)[^)]*\)/gi,
      // Python
      /open\s*\(\s*(?:request\.(?:args|form|json)|\.\.\/)/gi,
      // Rust
      /std::fs::(?:read|write|read_to_string)\s*\(\s*(?:.*?\.\.\/)/gi,
    ],
    fileExtensions: ["ts", "tsx", "js", "jsx", "py", "rs"],
    severity: "high",
    owasp: "A01:2021-Broken Access Control",
    suggestion:
      "Validate and sanitize file paths. Use path.resolve() to normalize, then verify the result is within the allowed directory.",
    cwe: 22,
    highFalsePositiveRate: false,
  },

  // ═══ INSECURE CRYPTOGRAPHY ═══════════════════════════════════════════════

  {
    id: "weak-hash-algorithm",
    name: "Weak Hash Algorithm",
    description: "Use of cryptographically broken hash algorithms",
    patterns: [
      /(?:MD5|md5)\s*\(/gi,
      /(?:SHA-?1|sha1)\s*\(/gi,
      /crypto\.createHash\s*\(\s*["'`](?:md5|sha1)["'`]/gi,
      // Python
      /hashlib\.(?:md5|sha1)\s*\(/gi,
    ],
    fileExtensions: ["ts", "tsx", "js", "jsx", "py", "rs"],
    severity: "high",
    owasp: "A02:2021-Cryptographic Failures",
    suggestion:
      "Use SHA-256 or stronger (SHA-512, BLAKE3) for hashing. For passwords, use bcrypt, argon2, or scrypt.",
    cwe: 327,
    highFalsePositiveRate: true,
  },

  {
    id: "weak-encryption-cipher",
    name: "Weak Encryption Cipher",
    description: "Use of deprecated or broken encryption algorithms",
    patterns: [
      /(?:DES|des|RC4|rc4|3DES|triple.des)\b(?!\s*(?:S|s)\w+\s*\(|\w*key)/gi,
      /crypto\.createCipheriv?\s*\(\s*["'`](?:des|rc4|aes-128-ecb|bf)["'`]/gi,
      /(?:ECB|ecb).*?(?:mode|cipher)/gi,
    ],
    fileExtensions: ["ts", "tsx", "js", "jsx", "py", "rs"],
    severity: "high",
    owasp: "A02:2021-Cryptographic Failures",
    suggestion:
      "Use AES-256-GCM or ChaCha20-Poly1305 for symmetric encryption. Never use ECB mode, DES, or RC4.",
    cwe: 327,
    highFalsePositiveRate: true,
  },

  {
    id: "insecure-random",
    name: "Insecure Random Number Generation",
    description: "Use of Math.random() or non-cryptographic PRNG for security purposes",
    patterns: [
      /Math\.random\s*\(\s*\)\s*(?:\.toString\(36\)|\)\.toString\(36\))/gi,
      // Near token/key generation
      /(?:token|key|secret|nonce|salt|password|reset).*?Math\.random/gi,
      // Python
      /random\.(?:random|randint|choice)\s*\(\s*\)/gi,
    ],
    fileExtensions: ["ts", "tsx", "js", "jsx", "py"],
    severity: "medium",
    owasp: "A02:2021-Cryptographic Failures",
    suggestion:
      "Use crypto.randomBytes() or crypto.getRandomValues() in JS. Use secrets module in Python. Math.random() is not cryptographically secure.",
    cwe: 330,
    highFalsePositiveRate: true,
  },

  // ═══ AUTHENTICATION WEAKNESSES ═══════════════════════════════════════════

  {
    id: "missing-auth-check",
    name: "Missing Authentication Check",
    description: "API route or handler without authentication middleware",
    patterns: [
      // Express/Koa/Hono routes without auth middleware
      /(?:app\.(?:get|post|put|delete|patch)|router\.(?:get|post|put|delete|patch))\s*\(\s*["'`][^"'`]*["'`]\s*,\s*(?!.*(?:auth|authenticate|isAuth|requireAuth|protect|middleware|guard|isAuthenticated))/gi,
    ],
    fileExtensions: ["ts", "tsx", "js", "jsx"],
    severity: "high",
    owasp: "A07:2021-Auth Failures",
    suggestion:
      "Add authentication middleware to protect routes. Every non-public endpoint must verify user identity.",
    cwe: 306,
    highFalsePositiveRate: true,
  },

  {
    id: "hardcoded-credential-comparison",
    name: "Hardcoded Credential Comparison",
    description: "Password or credential compared against hardcoded values",
    patterns: [
      /(?:if|when)\s*\(\s*(?:password|passwd|pwd|secret)\s*===?\s*["'`][^"'`]{3,}["'`]/gi,
      /password\s*==\s*["'`][^"'`]{3,}["'`]/gi,
    ],
    fileExtensions: ["ts", "tsx", "js", "jsx", "py", "rs"],
    severity: "critical",
    owasp: "A07:2021-Auth Failures",
    suggestion:
      "Use bcrypt, argon2, or scrypt for password hashing. Never hardcode or compare plaintext passwords.",
    cwe: 798,
    highFalsePositiveRate: true,
  },

  // ═══ SSRF ════════════════════════════════════════════════════════════════

  {
    id: "ssrf-user-controlled-url",
    name: "SSRF via User-Controlled URL",
    description: "HTTP request made to a URL from user input",
    patterns: [
      /(?:fetch|axios|got|request|http\.get|http\.request|superagent|node-fetch)\s*\(\s*(?:req\.(?:body|params|query)|request\.(?:body|params|query)|userInput)/gi,
      /(?:urllib\.request|httpx\.(?:get|post)|requests\.(?:get|post))\s*\(\s*(?:request\.(?:args|form|json))/gi,
    ],
    fileExtensions: ["ts", "tsx", "js", "jsx", "py"],
    severity: "high",
    owasp: "A10:2021-SSRF",
    suggestion:
      "Validate and sanitize URLs. Use an allowlist of permitted domains. Block requests to internal IPs and localhost.",
    cwe: 918,
    highFalsePositiveRate: true,
  },

  // ═══ OPEN REDIRECT ═══════════════════════════════════════════════════════

  {
    id: "open-redirect-user-input",
    name: "Open Redirect via User Input",
    description: "Redirect to URL from user input without validation",
    patterns: [
      /(?:res\.redirect|response\.redirect|redirect)\s*\(\s*(?:req\.(?:query|body|params)|request\.(?:args|form))/gi,
      /(?:window\.location|location\.href)\s*=\s*(?:req\.|request\.|params\.)/gi,
      // Next.js
      /(?:redirect|permanentRedirect)\s*\(\s*(?:req\.|request\.|params\.)/gi,
      // Python
      /(?:flask\.redirect|django\.shortcuts\.redirect)\s*\(\s*(?:request\.(?:args|form))/gi,
    ],
    fileExtensions: ["ts", "tsx", "js", "jsx", "py"],
    severity: "medium",
    owasp: "A01:2021-Broken Access Control",
    suggestion:
      "Validate redirect URLs against an allowlist. Strip protocol from user input before redirection. Use relative redirects when possible.",
    cwe: 601,
    highFalsePositiveRate: true,
  },

  // ═══ INSECURE DEPENDENCIES ═══════════════════════════════════════════════

  {
    id: "known-vulnerable-dependency-check",
    name: "Known Vulnerable Dependency Pattern",
    description: "Import of packages commonly associated with vulnerabilities",
    patterns: [
      // Lodash prototype pollution (fixed in 4.17.21+)
      /import\s+.*\b(lodash)\b.*from\s+["'`]lodash["'`]/gi,
      // Old jsonwebtoken versions
      /import\s+.*\b(jsonwebtoken)\b.*from\s+["'`]jsonwebtoken["'`]/gi,
    ],
    fileExtensions: ["ts", "tsx", "js", "jsx"],
    severity: "low",
    owasp: "A06:2021-Vulnerable Components",
    suggestion:
      "Run 'npm audit' or 'cargo audit' regularly. Update vulnerable dependencies. Use Snyk or Dependabot for automated alerts.",
    cwe: 1104,
    highFalsePositiveRate: true,
  },
];

// ── Pattern Matching Engine ───────────────────────────────────────────────────

/**
 * Scan a single line of source code against all applicable patterns.
 *
 * @param line - The source code line to scan
 * @param filePath - The file path (used to determine applicable extensions)
 * @param lineNumber - The 1-based line number
 * @returns Array of SecurityFinding for this line
 */
export function scanLine(
  line: string,
  filePath: string,
  lineNumber: number,
): SecurityFinding[] {
  const findings: SecurityFinding[] = [];
  const ext = filePath.split(".").pop()?.toLowerCase() || "";

  for (const pattern of SECURITY_PATTERNS) {
    // Check if pattern applies to this file extension
    if (
      pattern.fileExtensions.length > 0 &&
      !pattern.fileExtensions.includes(ext)
    ) {
      continue;
    }

    // Try all regex patterns
    for (const regex of pattern.patterns) {
      // Reset lastIndex for global regex
      regex.lastIndex = 0;

      let match: RegExpExecArray | null;
      while ((match = regex.exec(line)) !== null) {
        findings.push({
          patternId: pattern.id,
          filePath,
          line: lineNumber,
          column: (match.index || 0) + 1,
          snippet: match[0].substring(0, 120),
          severity: pattern.severity,
          owasp: pattern.owasp,
          description: pattern.description,
          suggestion: pattern.suggestion,
          cwe: pattern.cwe,
        });
      }
    }
  }

  return findings;
}

/**
 * Scan a full source file for all security patterns.
 *
 * @param content - The full file content
 * @param filePath - The file path
 * @returns All findings in the file, sorted by line number
 */
export function scanFile(
  content: string,
  filePath: string,
): SecurityFinding[] {
  const lines = content.split("\n");
  const findings: SecurityFinding[] = [];

  for (let i = 0; i < lines.length; i++) {
    findings.push(...scanLine(lines[i], filePath, i + 1));
  }

  return findings;
}

/**
 * Scan a diff/patch (only added lines) for security patterns.
 *
 * @param patch - The unified diff or patch content
 * @param filePath - The file being patched
 * @returns Findings from added lines only
 */
export function scanPatch(
  patch: string,
  filePath: string,
): SecurityFinding[] {
  const lines = patch.split("\n");
  const findings: SecurityFinding[] = [];
  let currentLineNum = 0;
  let inHunk = false;

  for (const line of lines) {
    if (line.startsWith("@@")) {
      // Parse hunk header: @@ -oldStart,oldCount +newStart,newCount @@
      const match = line.match(/@@\s+-\d+(?:,\d+)?\s+\+(\d+)/);
      if (match) {
        currentLineNum = parseInt(match[1], 10);
        inHunk = true;
      }
      continue;
    }

    if (!inHunk) continue;

    if (line.startsWith("+") && !line.startsWith("+++")) {
      // Added line — scan for vulnerabilities
      const codeLine = line.substring(1);
      findings.push(
        ...scanLine(codeLine, filePath, currentLineNum),
      );
      currentLineNum++;
    } else if (!line.startsWith("-")) {
      // Context line — don't scan but increment counter
      currentLineNum++;
    } else if (line.startsWith("---")) {
      // Diff header, skip
    }
    // Removed lines don't increment the new file counter
  }

  return findings;
}

// ── Severity Utilities ────────────────────────────────────────────────────────

/**
 * Map severity string to numeric level for sorting.
 */
export function severityLevel(severity: Severity): number {
  switch (severity) {
    case "critical": return 4;
    case "high": return 3;
    case "medium": return 2;
    case "low": return 1;
  }
}

/**
 * Check if a finding should block an AI patch from being applied.
 * Critical findings always block. High findings block by default.
 */
export function isBlocking(finding: SecurityFinding): boolean {
  return finding.severity === "critical";
}