/**
 * @phase P5
 * @purpose Source and sink definitions for taint tracking.
 *          Defines what counts as untrusted input (sources), what
 *          counts as dangerous operations (sinks), and what
 *          neutralizes taint (sanitizers).
 */

import { type Severity } from './types';

/** A taint source — where untrusted data enters the program. */
export interface TaintSource {
  id: string;
  name: string;
  patterns: RegExp[];
  owaspCategory: string;
  cwe: string;
}

/** A taint sink — a dangerous operation that should not receive tainted data. */
export interface TaintSink {
  id: string;
  name: string;
  patterns: RegExp[];
  owaspCategory: string;
  cwe: string;
  severity: Severity;
}

/** A sanitizer — a function that cleanses taint from data. */
export interface TaintSanitizer {
  id: string;
  name: string;
  patterns: RegExp[];
}

/**
 * Pre-defined taint sources. These are the entry points where
 * untrusted data enters the program.
 */
export const TAINT_SOURCES: TaintSource[] = [
  {
    id: 'http-body',
    name: 'HTTP Request Body',
    patterns: [/req\.body/g, /request\.body/g, /request\.json\(\)/g, /ctx\.request\.body/g],
    owaspCategory: 'A03:2021-Injection',
    cwe: 'CWE-20',
  },
  {
    id: 'http-params',
    name: 'HTTP Request Parameters',
    patterns: [/req\.query/g, /req\.params/g, /request\.query/g, /request\.params/g, /ctx\.params/g],
    owaspCategory: 'A03:2021-Injection',
    cwe: 'CWE-20',
  },
  {
    id: 'env-vars',
    name: 'Environment Variables',
    patterns: [/process\.env\./g, /dotenv\.config/g, /getenv\(/g],
    owaspCategory: 'A05:2021-Security Misconfiguration',
    cwe: 'CWE-78',
  },
  {
    id: 'file-reads',
    name: 'File Reads',
    patterns: [/fs\.readFile/g, /fs\.readFileSync/g, /readFile\(/g, /readFileSync\(/g],
    owaspCategory: 'A01:2021-Broken Access Control',
    cwe: 'CWE-73',
  },
  {
    id: 'user-input',
    name: 'User Input (stdin/readline/prompt)',
    patterns: [/readline\./g, /prompt\(/g, /process\.stdin/g, /process\.argv/g],
    owaspCategory: 'A03:2021-Injection',
    cwe: 'CWE-20',
  },
  {
    id: 'db-results',
    name: 'Database Query Results (as input to another query)',
    patterns: [/queryResult\./g, /rows\[/g, /resultSet\./g, /\.executeQuery\(\)\.rows/g],
    owaspCategory: 'A03:2021-Injection',
    cwe: 'CWE-89',
  },
];

/**
 * Pre-defined taint sinks. These are dangerous operations that
 * should never receive tainted (untrusted) data.
 */
export const TAINT_SINKS: TaintSink[] = [
  {
    id: 'eval',
    name: 'eval / Function constructor',
    patterns: [/eval\(/g, /new\s+Function\(/g, /Function\(/g],
    owaspCategory: 'A03:2021-Injection',
    cwe: 'CWE-94',
    severity: 'critical',
  },
  {
    id: 'sql-construction',
    name: 'SQL Query Construction',
    patterns: [
      /\.query\(/g,
      /\.execute\(/g,
      /`SELECT.*\$\{/g,
      /`INSERT.*\$\{/g,
      /`UPDATE.*\$\{/g,
      /`DELETE.*\$\{/g,
      /string\s*\+\s*['"].*SELECT/gi,
    ],
    owaspCategory: 'A03:2021-Injection',
    cwe: 'CWE-89',
    severity: 'critical',
  },
  {
    id: 'fs-writes',
    name: 'File System Writes',
    patterns: [/fs\.writeFile/g, /fs\.writeFileSync/g, /fs\.appendFile/g, /fs\.unlink/g, /fs\.rm/g],
    owaspCategory: 'A01:2021-Broken Access Control',
    cwe: 'CWE-73',
    severity: 'high',
  },
  {
    id: 'child-process',
    name: 'child_process exec',
    patterns: [/exec\(/g, /execSync\(/g, /spawn\(/g, /spawnSync\(/g, /execFile\(/g],
    owaspCategory: 'A03:2021-Injection',
    cwe: 'CWE-78',
    severity: 'critical',
  },
  {
    id: 'template-render',
    name: 'Template Rendering (without escaping)',
    patterns: [/\.render\(/g, /innerHTML\s*=/g, /dangerouslySetInnerHTML/g, /document\.write\(/g],
    owaspCategory: 'A03:2021-Injection',
    cwe: 'CWE-79',
    severity: 'high',
  },
  {
    id: 'redirect',
    name: 'Open Redirect',
    patterns: [/res\.redirect\(/g, /response\.redirect\(/g, /window\.location\s*=/g, /location\.href\s*=/g],
    owaspCategory: 'A01:2021-Broken Access Control',
    cwe: 'CWE-601',
    severity: 'medium',
  },
  {
    id: 'dynamic-require',
    name: 'Dynamic require/import (untrusted path)',
    patterns: [/require\(/g, /import\(/g],
    owaspCategory: 'A08:2021-Software and Data Integrity Failures',
    cwe: 'CWE-829',
    severity: 'high',
  },
];

/**
 * Pre-defined sanitizers. When a sanitizer appears in the taint path,
 * the taint is considered neutralized and no finding is produced.
 */
export const TAINT_SANITIZERS: TaintSanitizer[] = [
  {
    id: 'escape',
    name: 'HTML Escape',
    patterns: [/escape\(/g, /escapeHtml\(/g, /encodeURIComponent\(/g],
  },
  {
    id: 'sanitize',
    name: 'Generic Sanitize',
    patterns: [/sanitize\(/g, /sanitise\(/g, /clean\(/g, /purge\(/g],
  },
  {
    id: 'dompurify',
    name: 'DOMPurify',
    patterns: [/DOMPurify\.sanitize\(/g, /DOMPurify\(/g],
  },
  {
    id: 'validator',
    name: 'Validator.js escape',
    patterns: [/validator\.escape\(/g, /validator\.trim\(/g],
  },
  {
    id: 'parameterized-query',
    name: 'Parameterized Query',
    patterns: [/\?\s*[,)]/g, /\$\d+/g, /\.prepare\(/g, /parameterized/gi],
  },
  {
    id: 'parseInt',
    name: 'parseInt / Number coercion',
    patterns: [/parseInt\(/g, /Number\(/g, /parseFloat\(/g],
  },
];
