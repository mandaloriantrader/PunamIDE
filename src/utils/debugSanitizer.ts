/**
 * Phase 5A — Debug Context Sanitizer
 * Strips secrets, API keys, passwords, and sensitive environment values
 * from debug context before sending to AI providers.
 */

// Patterns that match common secret formats
const SECRET_PATTERNS: RegExp[] = [
  // API keys & tokens
  /sk-[a-zA-Z0-9]{20,}/g,           // OpenAI keys
  /ghp_[a-zA-Z0-9]{36,}/g,          // GitHub personal access tokens
  /gho_[a-zA-Z0-9]{36,}/g,          // GitHub OAuth tokens
  /github_pat_[a-zA-Z0-9_]{22,}/g,  // GitHub fine-grained PATs
  /glpat-[a-zA-Z0-9\-_]{20,}/g,    // GitLab PATs
  /xoxb-[a-zA-Z0-9\-]+/g,           // Slack bot tokens
  /xoxp-[a-zA-Z0-9\-]+/g,           // Slack user tokens
  /AIza[a-zA-Z0-9_\-]{35}/g,        // Google API keys
  /AKIA[A-Z0-9]{16}/g,              // AWS access key IDs
  /eyJ[a-zA-Z0-9_\-]{50,}\.[a-zA-Z0-9_\-]+\.[a-zA-Z0-9_\-]+/g, // JWTs
  /[a-f0-9]{32,64}/g,               // Generic hex secrets (32+ chars)

  // Connection strings
  /(?:mongodb|postgres|mysql|redis):\/\/[^\s"']+/gi,

  // Bearer tokens in headers
  /Bearer\s+[a-zA-Z0-9_\-\.]+/gi,

  // Private keys
  /-----BEGIN (?:RSA |EC |DSA )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |DSA )?PRIVATE KEY-----/g,
];

// Variable names that likely hold secrets (case-insensitive match on name)
const SENSITIVE_VAR_NAMES: RegExp[] = [
  /^(api[_-]?key|apikey|secret|password|passwd|pwd|token|auth|credential|private[_-]?key)$/i,
  /^(access[_-]?token|refresh[_-]?token|session[_-]?id|session[_-]?token)$/i,
  /^(db[_-]?password|database[_-]?url|connection[_-]?string)$/i,
  /^(aws[_-]?secret|aws[_-]?access|stripe[_-]?key|sendgrid[_-]?key)$/i,
  /_(key|secret|token|password|credential)s?$/i,
];

// Environment variable names that are sensitive
const SENSITIVE_ENV_PREFIXES = [
  "API_KEY", "SECRET", "PASSWORD", "TOKEN", "PRIVATE_KEY",
  "AWS_SECRET", "DATABASE_URL", "DB_PASS", "AUTH_",
  "STRIPE_", "SENDGRID_", "TWILIO_", "GITHUB_TOKEN",
];

const REDACTED = "[REDACTED]";

/**
 * Sanitize a single string value — replaces detected secrets with [REDACTED]
 */
export function sanitizeValue(value: string): string {
  if (!value || value.length < 8) return value; // Too short to be a secret

  let sanitized = value;
  for (const pattern of SECRET_PATTERNS) {
    // Reset lastIndex for global patterns
    pattern.lastIndex = 0;
    sanitized = sanitized.replace(pattern, REDACTED);
  }
  return sanitized;
}

/**
 * Check if a variable name suggests it holds a secret
 */
export function isSensitiveVarName(name: string): boolean {
  return SENSITIVE_VAR_NAMES.some(pattern => pattern.test(name));
}

/**
 * Sanitize debug variables — redacts values of sensitive-named variables
 * and scrubs secret patterns from all values
 */
export function sanitizeVariables(variables: Array<{ name: string; value: string; type?: string }>): Array<{ name: string; value: string; type?: string }> {
  return variables.map(v => {
    if (isSensitiveVarName(v.name)) {
      return { ...v, value: REDACTED };
    }
    return { ...v, value: sanitizeValue(v.value) };
  });
}

/**
 * Sanitize environment variables from a record — removes sensitive env vars entirely
 */
export function sanitizeEnvVars(env: Record<string, string>): Record<string, string> {
  const sanitized: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    const isSensitive = SENSITIVE_ENV_PREFIXES.some(prefix =>
      key.toUpperCase().includes(prefix)
    ) || isSensitiveVarName(key);

    sanitized[key] = isSensitive ? REDACTED : sanitizeValue(value);
  }
  return sanitized;
}

/**
 * Sanitize a stack trace string — removes file paths that might leak system info
 * but keeps relative paths and line numbers useful for debugging
 */
export function sanitizeStackTrace(stackTrace: string): string {
  // Replace home directory paths with ~
  let sanitized = stackTrace.replace(/(?:C:\\Users\\[^\\]+|\/home\/[^/]+|\/Users\/[^/]+)/gi, "~");
  // Sanitize any embedded secrets in the stack trace
  sanitized = sanitizeValue(sanitized);
  return sanitized;
}

/**
 * Sanitize console output lines
 */
export function sanitizeConsoleOutput(lines: string[]): string[] {
  return lines.map(line => sanitizeValue(line));
}

/**
 * Full debug context sanitization — takes all debug state and returns a safe version
 */
export function sanitizeDebugContext(context: {
  stackFrames: Array<{ name: string; source?: { path?: string; name?: string }; line: number; column?: number }>;
  variables: Array<{ name: string; value: string; type?: string }>;
  consoleOutput: string[];
  sourceCode?: string;
}): {
  stackFrames: Array<{ name: string; source?: { path?: string; name?: string }; line: number; column?: number }>;
  variables: Array<{ name: string; value: string; type?: string }>;
  consoleOutput: string[];
  sourceCode?: string;
} {
  return {
    stackFrames: context.stackFrames, // Stack frames are safe (function names + locations)
    variables: sanitizeVariables(context.variables),
    consoleOutput: sanitizeConsoleOutput(context.consoleOutput),
    sourceCode: context.sourceCode ? sanitizeValue(context.sourceCode) : undefined,
  };
}
