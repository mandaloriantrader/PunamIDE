//! Security Scanner — Phase 6, Step 6.2
//!
//! Scans source files and diffs for security vulnerability patterns.
//! Returns structured findings (pattern ID, severity, OWASP category, location).

use serde::{Deserialize, Serialize};
use std::fs;
use std::path::Path;
use regex_lite::Regex;

// ── Data Types ─────────────────────────────────────────────────────────────────

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct SecurityFinding {
    pub pattern_id: String,
    pub file_path: String,
    pub line: usize,
    pub column: usize,
    pub snippet: String,
    pub severity: String,
    pub owasp: String,
    pub description: String,
    pub suggestion: String,
    pub cwe: Option<u32>,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct SecurityScanResult {
    pub file_path: String,
    pub findings: Vec<SecurityFinding>,
    pub critical_count: usize,
    pub high_count: usize,
    pub medium_count: usize,
    pub low_count: usize,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct PatchSecurityResult {
    pub allowed: bool,
    pub blocked: bool,
    pub findings: Vec<SecurityFinding>,
    pub critical_findings: Vec<SecurityFinding>,
    pub summary: String,
}

// ── Pattern Definitions ────────────────────────────────────────────────────────

struct Pattern {
    id: &'static str,
    description: &'static str,
    regexes: &'static [&'static str],
    file_extensions: &'static [&'static str],
    severity: &'static str,
    owasp: &'static str,
    suggestion: &'static str,
    cwe: Option<u32>,
}

/// Security vulnerability patterns (mirrors TypeScript SecurityPatterns.ts).
///
/// All patterns use regex_lite for fast, no-alloc scanning of source files.
macro_rules! patterns {
    () => {
        &[
            // ═══ SQL INJECTION ═══════════════════════════════════════════════════
            Pattern {
                id: "sql-injection-string-concat",
                description: "SQL query built using string concatenation with user input",
                regexes: &[
                    // query += "..." + variable
                    r#"(?i)\bquery\s*\+=\s*["'`].*?\s*\+\s*(\w+)"#,
                    // `SELECT * FROM users WHERE id = ${var}`
                    r#"(?i)["'`]\s*(?:SELECT|INSERT|UPDATE|DELETE|DROP|CREATE|ALTER)\s+.+?\s*\$\{"#,
                    // "SELECT * FROM " + table
                    r#"(?i)["'`]\s*(?:SELECT|INSERT|UPDATE|DELETE|DROP)\s+.+?["'`]\s*\+"#,
                    // execute("SELECT..." + var)
                    r#"(?i)(?:execute|query|exec)\s*\(\s*["'`]\s*(?:SELECT|INSERT|UPDATE|DELETE|DROP)\s+.+?["'`]\s*\+"#,
                    // format!("SELECT * FROM {}", var)
                    r#"(?i)format!\s*\(\s*["']\s*(?:SELECT|INSERT|UPDATE|DELETE|DROP)\s+.+?[\{\}]"#,
                ],
                file_extensions: &["ts", "tsx", "js", "jsx", "py", "rs"],
                severity: "critical",
                owasp: "A03:2021-Injection",
                suggestion: "Use parameterized queries or an ORM with bound parameters. Never concatenate user input into SQL strings.",
                cwe: Some(89),
            },
            Pattern {
                id: "sql-injection-raw-execute",
                description: "Raw SQL execution without parameterization",
                regexes: &[
                    r#"(?i)(?:\.query|\.execute|\.raw|\.sql)\s*\(\s*["'`]\s*(SELECT|INSERT|UPDATE|DELETE|DROP|ALTER|CREATE)"#,
                    r#"(?i)(?:cursor\.execute|cursor\.executemany|connection\.execute)\s*\(\s*["']\s*(SELECT|INSERT|UPDATE|DELETE|DROP)"#,
                    r#"(?i)(?:query|sql)\s*=\s*["'`]\s*(?:SELECT|INSERT|UPDATE|DELETE|DROP).+?\$\{"#,
                ],
                file_extensions: &["ts", "tsx", "js", "jsx", "py", "rs"],
                severity: "critical",
                owasp: "A03:2021-Injection",
                suggestion: "Use parameterized queries: db.query('SELECT * FROM users WHERE id = $1', [userId])",
                cwe: Some(89),
            },

            // ═══ XSS ═════════════════════════════════════════════════════════════
            Pattern {
                id: "xss-dangerously-set-inner-html",
                description: "React dangerouslySetInnerHTML without sanitization",
                regexes: &[r#"(?i)dangerouslySetInnerHTML\s*=\s*\{\s*\{\s*__html\s*:"#],
                file_extensions: &["tsx", "jsx"],
                severity: "high",
                owasp: "A03:2021-Injection",
                suggestion: "Use a sanitization library like DOMPurify before setting inner HTML.",
                cwe: Some(79),
            },
            Pattern {
                id: "xss-eval-with-user-input",
                description: "eval() or dynamic code execution from user input",
                regexes: &[
                    r#"(?i)\beval\s*\("#,
                    r#"(?i)new\s+Function\s*\("#,
                    r#"(?i)setTimeout\s*\(\s*(?:['"`][^'"`]*['"`]\s*,\s*\d+\)|[^'"`,\d][^,]*\))"#,
                ],
                file_extensions: &["ts", "tsx", "js", "jsx"],
                severity: "critical",
                owasp: "A03:2021-Injection",
                suggestion: "Avoid eval(), new Function(), and string-based setTimeout/setInterval.",
                cwe: Some(95),
            },

            // ═══ HARDCODED SECRETS ═══════════════════════════════════════════════
            Pattern {
                id: "hardcoded-api-key",
                description: "API key embedded directly in source code",
                regexes: &[
                    r#"(?i)(?:api[_-]?key|apikey|API_KEY)\s*[=:]\s*["'`]([A-Za-z0-9_\-]{20,})["'`]"#,
                    r#"(?i)(?:secret[_-]?key|secretkey|SECRET_KEY)\s*[=:]\s*["'`]([A-Za-z0-9_\-]{20,})["'`]"#,
                    r#"(?i)(?:OPENAI_API_KEY|GEMINI_API_KEY|GROQ_API_KEY)\s*=\s*["'`][^"'`]+["'`]"#,
                ],
                file_extensions: &["ts", "tsx", "js", "jsx", "py", "rs", "toml", "yaml", "yml", "json"],
                severity: "critical",
                owasp: "A02:2021-Cryptographic Failures",
                suggestion: "Use environment variables or a secrets manager. Never commit API keys to source control.",
                cwe: Some(798),
            },
            Pattern {
                id: "hardcoded-jwt-secret",
                description: "JWT signing secret hardcoded in source",
                regexes: &[
                    r#"(?i)(?:jwt[_-]?secret|JWT_SECRET|signing[_-]?key)\s*[=:]\s*["'`][^"'`\n]{6,}["'`]"#,
                    r#"(?i)jwt\.sign\s*\([^)]*,\s*["'`][^"'`]{6,}["'`]"#,
                ],
                file_extensions: &["ts", "tsx", "js", "jsx", "py"],
                severity: "critical",
                owasp: "A02:2021-Cryptographic Failures",
                suggestion: "Store JWT secrets in environment variables or a key management service.",
                cwe: Some(798),
            },
            Pattern {
                id: "hardcoded-database-credentials",
                description: "Database credentials in source code",
                regexes: &[
                    r#"(?i)(?:DATABASE_URL|DB_URL|MONGO_URI|POSTGRES_URL)\s*[=:]\s*["'`][^"'`]*(?::\/\/|@|:\d+\/)[^"'`]*["'`]"#,
                    r#"(?i)(?:DB_USER|DB_PASSWORD|DATABASE_PASSWORD)\s*[=:]\s*["'`][^"'`]+["'`]"#,
                ],
                file_extensions: &["ts", "tsx", "js", "jsx", "py", "rs", "toml"],
                severity: "critical",
                owasp: "A02:2021-Cryptographic Failures",
                suggestion: "Use environment variables for database connection strings.",
                cwe: Some(798),
            },

            // ═══ UNSAFE CODE EXECUTION ══════════════════════════════════════════
            Pattern {
                id: "unsafe-child-process",
                description: "Child process spawned with potentially unsafe input",
                regexes: &[
                    r#"(?i)(?:exec|execSync)\s*\("#,
                    r#"(?i)child_process\.exec\s*\("#,
                ],
                file_extensions: &["ts", "tsx", "js", "jsx"],
                severity: "critical",
                owasp: "A03:2021-Injection",
                suggestion: "Use execFile instead of exec. Validate and sanitize all user input passed to shell commands.",
                cwe: Some(78),
            },

            // ═══ PATH TRAVERSAL ═══════════════════════════════════════════════════
            Pattern {
                id: "path-traversal-user-input",
                description: "File path constructed from user input without validation",
                regexes: &[
                    r#"(?i)(?:fs\.readFile|fs\.writeFile|fs\.readFileSync|fs\.writeFileSync|fs\.createReadStream|fs\.createWriteStream)\s*\(\s*(?:req\.(?:params|body|query)|\.\.\/)"#,
                    r#"(?i)open\s*\(\s*(?:request\.(?:args|form|json)|\.\.\/)"#,
                ],
                file_extensions: &["ts", "tsx", "js", "jsx", "py", "rs"],
                severity: "high",
                owasp: "A01:2021-Broken Access Control",
                suggestion: "Validate and sanitize file paths. Verify paths stay within the allowed directory.",
                cwe: Some(22),
            },

            // ═══ WEAK CRYPTO ═════════════════════════════════════════════════════
            Pattern {
                id: "weak-hash-algorithm",
                description: "Use of cryptographically broken hash algorithms (MD5, SHA1)",
                regexes: &[
                    r#"(?i)(?:MD5|md5|SHA-?1|sha1)\s*\("#,
                    r#"(?i)crypto\.createHash\s*\(\s*["'`](?:md5|sha1)["'`]"#,
                    r#"(?i)hashlib\.(?:md5|sha1)\s*\("#,
                ],
                file_extensions: &["ts", "tsx", "js", "jsx", "py", "rs"],
                severity: "high",
                owasp: "A02:2021-Cryptographic Failures",
                suggestion: "Use SHA-256 or stronger for hashing. For passwords, use bcrypt, argon2, or scrypt.",
                cwe: Some(327),
            },
            Pattern {
                id: "insecure-random",
                description: "Non-cryptographic random number used for security purposes",
                regexes: &[
                    r#"(?i)(?:token|key|secret|nonce|salt|password|reset).*?Math\.random"#,
                    r#"(?i)random\.(?:random|randint|choice)\s*\(\s*\)"#,
                ],
                file_extensions: &["ts", "tsx", "js", "jsx", "py"],
                severity: "medium",
                owasp: "A02:2021-Cryptographic Failures",
                suggestion: "Use crypto.randomBytes() in JS or secrets module in Python.",
                cwe: Some(330),
            },

            // ═══ AUTH ═══════════════════════════════════════════════════════════
            Pattern {
                id: "hardcoded-credential-comparison",
                description: "Password compared against hardcoded values",
                regexes: &[
                    r#"(?i)(?:if|when)\s*\(\s*(?:password|passwd|pwd|secret)\s*===?\s*["'`][^"'`]{3,}["'`]"#,
                ],
                file_extensions: &["ts", "tsx", "js", "jsx", "py", "rs"],
                severity: "critical",
                owasp: "A07:2021-Auth Failures",
                suggestion: "Use bcrypt, argon2, or scrypt for password hashing. Never hardcode passwords.",
                cwe: Some(798),
            },
        ]
    };
}

// ── Scanner Implementation ─────────────────────────────────────────────────────

/// Compile all patterns into Regex objects.
fn compile_patterns() -> Vec<(Pattern, Vec<Regex>)> {
    let all_patterns: &[Pattern] = patterns!();
    all_patterns.iter().filter_map(|p| {
        let regexes: Vec<Regex> = p.regexes.iter()
            .filter_map(|r| Regex::new(r).ok())
            .collect();
        if regexes.is_empty() { return None; }
        Some((Pattern { ..*p }, regexes))
    }).collect()
}

/// Determine if a pattern applies to a given file extension.
fn applies_to(exts: &[&str], file_ext: &str) -> bool {
    if exts.is_empty() { return true; }
    exts.contains(&file_ext)
}

/// Scan a single source file for security vulnerabilities.
pub fn scan_file(file_path: &str) -> Result<SecurityScanResult, String> {
    let path = Path::new(file_path);
    let ext = path.extension()
        .and_then(|e| e.to_str())
        .unwrap_or("");

    let content = fs::read_to_string(path)
        .map_err(|e| format!("Failed to read {}: {}", file_path, e))?;

    let compiled = compile_patterns();
    let mut findings = Vec::new();
    let mut critical_count = 0usize;
    let mut high_count = 0usize;
    let mut medium_count = 0usize;
    let mut low_count = 0usize;

    for (line_idx, line) in content.lines().enumerate() {
        let line_num = line_idx + 1;

        for (pattern, regexes) in &compiled {
            if !applies_to(pattern.file_extensions, ext) {
                continue;
            }

            for regex in regexes {
                if let Some(m) = regex.find(line) {
                    let snippet = if m.len() > 120 {
                        // Safe truncation: find the nearest char boundary at or before m.start() + 120
                        let end = {
                            let target = m.start() + 120;
                            let clamped = target.min(line.len());
                            let mut end = clamped;
                            while end > m.start() && !line.is_char_boundary(end) {
                                end -= 1;
                            }
                            end
                        };
                        &line[m.start()..end]
                    } else {
                        m.as_str()
                    };

                    findings.push(SecurityFinding {
                        pattern_id: pattern.id.to_string(),
                        file_path: file_path.to_string(),
                        line: line_num,
                        column: m.start() + 1,
                        snippet: snippet.to_string(),
                        severity: pattern.severity.to_string(),
                        owasp: pattern.owasp.to_string(),
                        description: pattern.description.to_string(),
                        suggestion: pattern.suggestion.to_string(),
                        cwe: pattern.cwe,
                    });

                    match pattern.severity {
                        "critical" => critical_count += 1,
                        "high" => high_count += 1,
                        "medium" => medium_count += 1,
                        "low" => low_count += 1,
                        _ => {}
                    }
                }
            }
        }
    }

    Ok(SecurityScanResult {
        file_path: file_path.to_string(),
        findings,
        critical_count,
        high_count,
        medium_count,
        low_count,
    })
}

/// Scan a unified diff/patch for security vulnerabilities in added lines only.
///
/// This is the function called before `apply_patch` executes.
/// Returns `allowed: false` if any critical findings are present.
pub fn scan_patch(patch_content: &str, file_path: &str) -> PatchSecurityResult {
    let ext = Path::new(file_path)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("");

    let compiled = compile_patterns();
    let mut findings = Vec::new();
    let mut critical_findings = Vec::new();
    let mut current_line_num = 1usize;
    let mut in_hunk = false;

    for line in patch_content.lines() {
        if line.starts_with("@@") {
            // Parse: @@ -oldStart,oldCount +newStart,newCount @@
            if let Some(plus_pos) = line.find('+') {
                let after_plus = &line[plus_pos + 1..];
                let num_str: String = after_plus
                    .chars()
                    .take_while(|c| c.is_ascii_digit())
                    .collect();
                if let Ok(num) = num_str.parse::<usize>() {
                    current_line_num = num;
                }
            }
            in_hunk = true;
            continue;
        }

        if line.starts_with("+") && !line.starts_with("+++") {
            let code = &line[1..]; // strip the '+'

            for (pattern, regexes) in &compiled {
                if !applies_to(pattern.file_extensions, ext) { continue; }

                for regex in regexes {
                    if let Some(m) = regex.find(code) {
                        let snippet = if m.len() > 120 {
                            // Safe truncation: find the nearest char boundary at or before m.start() + 120
                            let end = {
                                let target = m.start() + 120;
                                let clamped = target.min(code.len());
                                let mut end = clamped;
                                while end > m.start() && !code.is_char_boundary(end) {
                                    end -= 1;
                                }
                                end
                            };
                            &code[m.start()..end]
                        } else {
                            m.as_str()
                        };

                        let finding = SecurityFinding {
                            pattern_id: pattern.id.to_string(),
                            file_path: file_path.to_string(),
                            line: current_line_num,
                            column: m.start() + 1,
                            snippet: snippet.to_string(),
                            severity: pattern.severity.to_string(),
                            owasp: pattern.owasp.to_string(),
                            description: pattern.description.to_string(),
                            suggestion: pattern.suggestion.to_string(),
                            cwe: pattern.cwe,
                        };

                        if pattern.severity == "critical" {
                            critical_findings.push(finding.clone());
                        }
                        findings.push(finding);
                    }
                }
            }

            current_line_num += 1;
        } else if in_hunk && !line.starts_with("-") && !line.starts_with("---") {
            // Context line
            current_line_num += 1;
        }
    }

    let blocked = !critical_findings.is_empty();
    let summary = if blocked {
        format!(
            "Blocked: {} critical vulnerability(s) found in patch. {} total finding(s) detected.",
            critical_findings.len(),
            findings.len()
        )
    } else if !findings.is_empty() {
        format!(
            "Warning: {} security finding(s) detected (no critical). Review before applying.",
            findings.len()
        )
    } else {
        "Patch passed security scan — no vulnerabilities detected.".to_string()
    };

    PatchSecurityResult {
        allowed: !blocked,
        blocked,
        findings,
        critical_findings,
        summary,
    }
}

// ── Tauri Commands ─────────────────────────────────────────────────────────────

/// Scan a file for security vulnerabilities.
#[tauri::command]
pub fn security_scan_file(file_path: String) -> Result<SecurityScanResult, String> {
    scan_file(&file_path)
}

/// Validate an AI-proposed patch before applying.
///
/// This command is called by the frontend before `apply_patch` executes.
/// If `allowed` is false, the patch should be blocked entirely.
#[tauri::command]
pub fn security_scan_patch(
    patch_content: String,
    file_path: String,
) -> PatchSecurityResult {
    scan_patch(&patch_content, &file_path)
}

// ── Tests ──────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_all_security_patterns_compile() {
        for pattern in patterns!() {
            for regex in pattern.regexes {
                assert!(
                    Regex::new(regex).is_ok(),
                    "Invalid regex in security pattern '{}': {}",
                    pattern.id,
                    regex
                );
            }
        }
    }

    #[test]
    fn test_detect_sql_injection_concatenation() {
        let code = r#"const query = "SELECT * FROM users WHERE id = " + userId;"#;
        let result = scan_patch(&format!("+{}", code), "test.ts");
        assert!(!result.findings.is_empty());
        assert!(result.findings.iter().any(|f| f.pattern_id == "sql-injection-string-concat"));
    }

    #[test]
    fn test_detect_xss_dangerously_set() {
        let code = r#"<div dangerouslySetInnerHTML={{ __html: userInput }} />"#;
        let result = scan_patch(&format!("+{}", code), "test.tsx");
        assert!(!result.findings.is_empty());
        assert!(result.findings.iter().any(|f| f.pattern_id == "xss-dangerously-set-inner-html"));
    }

    #[test]
    fn test_detect_hardcoded_api_key() {
        let code = r#"const API_KEY = "sk-1234567890abcdefghij";"#;
        let result = scan_patch(&format!("+{}", code), "test.ts");
        assert!(!result.findings.is_empty());
        assert!(result.findings.iter().any(|f| f.pattern_id == "hardcoded-api-key"));
    }

    #[test]
    fn test_detect_eval() {
        let code = r#"eval("console.log('hello')");"#;
        let result = scan_patch(&format!("+{}", code), "test.js");
        assert!(!result.findings.is_empty());
        assert!(result.findings.iter().any(|f| f.pattern_id == "xss-eval-with-user-input"));
    }

    #[test]
    fn test_detect_weak_hash() {
        let code = r#"const hash = crypto.createHash("md5").update(data).digest();"#;
        let result = scan_patch(&format!("+{}", code), "test.ts");
        assert!(!result.findings.is_empty());
        assert!(result.findings.iter().any(|f| f.pattern_id == "weak-hash-algorithm"));
    }

    #[test]
    fn test_clean_code_passes() {
        let code = r#"const x = Math.max(1, 2);"#;
        let result = scan_patch(&format!("+{}", code), "test.ts");
        assert!(result.findings.is_empty());
        assert!(result.allowed);
    }

    #[test]
    fn test_critical_blocks_patch() {
        let code = r#"const query = "DROP TABLE " + tableName;"#;
        let result = scan_patch(&format!("+{}", code), "test.ts");
        assert!(!result.allowed);
        assert!(result.blocked);
        assert!(!result.critical_findings.is_empty());
    }

    #[test]
    fn test_patch_scan_only_added_lines() {
        let patch = "@@ -10,5 +10,7 @@\n const x = 5;\n-const y = 6;\n+eval(userInput);\n";
        let result = scan_patch(patch, "test.ts");
        // Should detect the eval on the + line
        assert!(!result.findings.is_empty());
        assert!(result.findings.iter().any(|f| f.pattern_id == "xss-eval-with-user-input"));
    }
}
