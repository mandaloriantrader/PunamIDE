import { useState, useEffect, useRef } from "react";
import { Bug, X, Check, Loader2, AlertTriangle, Info, Zap, FileText, ChevronRight, Shield, Search } from "lucide-react";
import { runTerminalCommand, readFile, searchProject } from "../utils/tauri";
import type { RunProfile } from "../utils/tauri";
import { sendToProviderStreaming } from "../utils/providers";
import type { AIProviderConfig } from "../utils/providers";
import { parseResponse } from "../utils/prompts";
import type { ParsedResponse } from "../utils/prompts";

export type BugImpact = "critical" | "warning" | "improvement";
export type BugSource = "compiler" | "lint" | "static" | "audit" | "ai";

export interface BugItem {
  id: string;
  file: string;
  line: number;
  message: string;
  impact: BugImpact;
  source: BugSource;
  selected: boolean;
  verified: boolean; // Whether we confirmed this bug exists in the actual file
  fix?: ParsedResponse;
  fixing?: boolean;
  fixed?: boolean;
}

type ScanPhase = "idle" | "detecting" | "scanning" | "static_analysis" | "auditing" | "analyzing" | "verifying" | "ready" | "fixing";

interface Props {
  projectPath: string;
  runProfiles: RunProfile[];
  aiProviders: AIProviderConfig[];
  legacyProvider: string;
  legacyModel: string;
  legacyApiKey: string;
  onClose: () => void;
  onApplyFix: (parsed: ParsedResponse) => Promise<void>;
  onJumpToFile: (path: string, line: number) => void;
}

const IMPACT_CONFIG = {
  critical: { label: "Critical", color: "var(--red)", icon: AlertTriangle, glow: "rgba(243, 139, 168, 0.2)" },
  warning: { label: "Warning", color: "var(--yellow)", icon: AlertTriangle, glow: "rgba(249, 226, 175, 0.2)" },
  improvement: { label: "Improvement", color: "var(--blue)", icon: Info, glow: "rgba(137, 180, 250, 0.2)" },
};

const SOURCE_LABELS: Record<BugSource, string> = {
  compiler: "Compiler",
  lint: "Lint",
  static: "Static",
  audit: "Audit",
  ai: "AI",
};

// --- Static Analysis Patterns (zero-token, local-only) ---

interface StaticPattern {
  id: string;
  name: string;
  pattern: RegExp;
  impact: BugImpact;
  message: string;
  fileTypes: string[];
  exclude?: RegExp; // Don't flag if this also matches
}

const STATIC_PATTERNS: StaticPattern[] = [
  // Security
  { id: "eval", name: "eval() usage", pattern: /\beval\s*\(/, impact: "critical", message: "eval() is a security risk — allows arbitrary code execution", fileTypes: [".js", ".ts", ".tsx", ".jsx", ".mjs"] },
  { id: "innerhtml", name: "innerHTML assignment", pattern: /\.innerHTML\s*=/, impact: "warning", message: "Direct innerHTML assignment — potential XSS vulnerability", fileTypes: [".js", ".ts", ".tsx", ".jsx"], exclude: /sanitize|DOMPurify|escape/ },
  { id: "hardcoded-secret", name: "Hardcoded secret", pattern: /(?:password|secret|api_key|apikey|token)\s*[:=]\s*["'][^"']{8,}["']/i, impact: "critical", message: "Possible hardcoded secret/credential", fileTypes: [".js", ".ts", ".tsx", ".jsx", ".py", ".rs", ".go", ".java", ".env"], exclude: /example|placeholder|test|mock|TODO|CHANGEME|your_/ },
  { id: "http-url", name: "HTTP (not HTTPS)", pattern: /["']http:\/\/(?!localhost|127\.0\.0\.1|0\.0\.0\.0)/, impact: "warning", message: "Non-HTTPS URL — data transmitted in plaintext", fileTypes: [".js", ".ts", ".tsx", ".jsx", ".py", ".rs", ".go"] },

  // Common bugs
  { id: "console-error-no-catch", name: "Unhandled promise", pattern: /\.then\([^)]*\)\s*(?:;|\n)(?!\s*\.catch)/, impact: "warning", message: "Promise without .catch() — unhandled rejection possible", fileTypes: [".js", ".ts", ".tsx", ".jsx"] },
  { id: "empty-catch", name: "Empty catch block", pattern: /catch\s*\([^)]*\)\s*\{\s*\}/, impact: "warning", message: "Empty catch block — errors are silently swallowed", fileTypes: [".js", ".ts", ".tsx", ".jsx", ".java", ".cs"] },
  { id: "todo-fixme", name: "TODO/FIXME", pattern: /\/\/\s*(TODO|FIXME|HACK|XXX|BUG)\b/i, impact: "improvement", message: "Unresolved TODO/FIXME comment", fileTypes: [".js", ".ts", ".tsx", ".jsx", ".py", ".rs", ".go", ".java"] },
  { id: "debugger", name: "debugger statement", pattern: /^\s*debugger\s*;?\s*$/, impact: "warning", message: "debugger statement left in code", fileTypes: [".js", ".ts", ".tsx", ".jsx"] },
  { id: "console-log-prod", name: "console.log in source", pattern: /\bconsole\.(log|debug|trace)\s*\(/, impact: "improvement", message: "console.log/debug left in source code", fileTypes: [".ts", ".tsx", ".jsx"], exclude: /test|spec|\.test\.|\.spec\./ },

  // TypeScript specific
  { id: "any-type", name: "Explicit any", pattern: /:\s*any\b/, impact: "improvement", message: "Explicit 'any' type — loses type safety", fileTypes: [".ts", ".tsx"] },
  { id: "ts-ignore", name: "@ts-ignore", pattern: /@ts-ignore|@ts-nocheck/, impact: "warning", message: "@ts-ignore suppresses type checking — may hide real errors", fileTypes: [".ts", ".tsx"] },
  { id: "non-null-assert", name: "Non-null assertion", pattern: /\w+!\.\w+|!\s*;/, impact: "improvement", message: "Non-null assertion (!) — may crash at runtime if value is null", fileTypes: [".ts", ".tsx"] },

  // React specific
  { id: "missing-key", name: "Map without key", pattern: /\.map\([^)]*\)\s*=>\s*[(<](?!.*\bkey\s*=)/, impact: "warning", message: "Array .map() rendering without key prop", fileTypes: [".tsx", ".jsx"] },
  { id: "dangerously-set", name: "dangerouslySetInnerHTML", pattern: /dangerouslySetInnerHTML/, impact: "warning", message: "dangerouslySetInnerHTML — XSS risk if content is not sanitized", fileTypes: [".tsx", ".jsx"] },

  // Python specific
  { id: "bare-except", name: "Bare except", pattern: /except\s*:/, impact: "warning", message: "Bare except catches all exceptions including SystemExit", fileTypes: [".py"] },
  { id: "exec-usage", name: "exec() usage", pattern: /\bexec\s*\(/, impact: "critical", message: "exec() is a security risk — allows arbitrary code execution", fileTypes: [".py"] },

  // Rust specific
  { id: "unwrap", name: ".unwrap() usage", pattern: /\.unwrap\(\)/, impact: "improvement", message: ".unwrap() will panic on None/Err — consider proper error handling", fileTypes: [".rs"] },
  { id: "unsafe-block", name: "unsafe block", pattern: /\bunsafe\s*\{/, impact: "warning", message: "unsafe block — memory safety not guaranteed", fileTypes: [".rs"] },
];

// Files/dirs to skip during static analysis
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", "target", ".next", "vendor", "__pycache__", ".venv", "coverage"]);
const SKIP_FILES = new Set(["package-lock.json", "npm-shrinkwrap.json", "yarn.lock", "pnpm-lock.yaml", "Cargo.lock"]);
const MAX_FILE_SIZE = 50000; // Skip files larger than 50KB for static analysis

// --- Auto-detect build commands from project files ---

interface DetectedCommand {
  name: string;
  command: string;
  type: "build" | "lint" | "test" | "typecheck" | "audit";
}

async function autoDetectCommands(projectPath: string): Promise<DetectedCommand[]> {
  const commands: DetectedCommand[] = [];

  // Try reading package.json
  try {
    const pkgContent = await readFile(`${projectPath}/package.json`);
    const pkg = JSON.parse(pkgContent);
    const scripts = pkg.scripts || {};

    // Commands that are long-running servers — NEVER run these in scan
    const SKIP_SCRIPTS = new Set(["dev", "start", "serve", "watch", "preview", "storybook"]);

    // Build commands
    if (scripts.build) commands.push({ name: "Build", command: "npm run build", type: "build" });
    if (scripts.typecheck) commands.push({ name: "Typecheck", command: "npm run typecheck", type: "typecheck" });
    if (scripts["type-check"]) commands.push({ name: "Type Check", command: "npm run type-check", type: "typecheck" });

    // Lint commands
    if (scripts.lint) commands.push({ name: "Lint", command: "npm run lint", type: "lint" });
    if (scripts.eslint) commands.push({ name: "ESLint", command: "npm run eslint", type: "lint" });

    // Test commands (only if it's a real test, not a server)
    if (scripts.test && !/no test/i.test(scripts.test) && !SKIP_SCRIPTS.has("test")) {
      commands.push({ name: "Test", command: "npm run test -- --run 2>&1", type: "test" });
    }

    // If no typecheck script but has typescript
    const hasTsDep = pkg.devDependencies?.typescript || pkg.dependencies?.typescript;
    if (hasTsDep && !scripts.typecheck && !scripts["type-check"]) {
      commands.push({ name: "TypeScript Check", command: "npx tsc --noEmit 2>&1", type: "typecheck" });
    }

    // Audit
    commands.push({ name: "npm audit", command: "npm audit --json 2>&1", type: "audit" });
  } catch { /* no package.json */ }

  // Try Cargo.toml (Rust)
  try {
    await readFile(`${projectPath}/Cargo.toml`);
    commands.push({ name: "Cargo Check", command: "cargo check --message-format=short 2>&1", type: "build" });
    commands.push({ name: "Cargo Clippy", command: "cargo clippy --message-format=short 2>&1", type: "lint" });
  } catch { /* no Cargo.toml */ }

  // Try src-tauri/Cargo.toml (Tauri projects)
  try {
    await readFile(`${projectPath}/src-tauri/Cargo.toml`);
    if (!commands.some((c) => c.command.includes("cargo"))) {
      commands.push({ name: "Tauri Check", command: "cargo check --manifest-path src-tauri/Cargo.toml --message-format=short 2>&1", type: "build" });
    }
  } catch { /* no src-tauri */ }

  // Try Makefile
  try {
    const makeContent = await readFile(`${projectPath}/Makefile`);
    if (/^lint:/m.test(makeContent)) commands.push({ name: "Make lint", command: "make lint 2>&1", type: "lint" });
    if (/^test:/m.test(makeContent)) commands.push({ name: "Make test", command: "make test 2>&1", type: "test" });
    if (/^check:/m.test(makeContent)) commands.push({ name: "Make check", command: "make check 2>&1", type: "build" });
  } catch { /* no Makefile */ }

  // Try pyproject.toml / requirements.txt (Python)
  try {
    const pyproject = await readFile(`${projectPath}/pyproject.toml`);
    if (pyproject.includes("ruff")) commands.push({ name: "Ruff", command: "ruff check . 2>&1", type: "lint" });
    if (pyproject.includes("mypy")) commands.push({ name: "Mypy", command: "mypy . 2>&1", type: "typecheck" });
    if (pyproject.includes("pytest")) commands.push({ name: "Pytest", command: "pytest --tb=short 2>&1", type: "test" });
  } catch { /* no pyproject.toml */ }

  return commands;
}

// --- Parse compiler/lint output into structured bugs ---

function parseCompilerOutput(output: string, commandType: string): BugItem[] {
  const bugs: BugItem[] = [];
  const lines = output.split("\n");

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // TypeScript errors: src/file.ts(10,5): error TS2304: Cannot find name 'x'
    const tsMatch = line.match(/^(.+?)\((\d+),\d+\):\s*(error|warning)\s+TS\d+:\s*(.+)/);
    if (tsMatch) {
      bugs.push({
        id: `compiler-${bugs.length}`,
        file: tsMatch[1].replace(/\\/g, "/"),
        line: parseInt(tsMatch[2]),
        message: tsMatch[4],
        impact: tsMatch[3] === "error" ? "critical" : "warning",
        source: "compiler",
        selected: true,
        verified: true,
      });
      continue;
    }

    // ESLint: /path/file.ts:10:5: error message (rule-name)
    const eslintMatch = line.match(/^\s*(\S+?):(\d+):\d+:\s*(error|warning|Error|Warning)\s+(.+)/);
    if (eslintMatch) {
      bugs.push({
        id: `lint-${bugs.length}`,
        file: eslintMatch[1].replace(/\\/g, "/"),
        line: parseInt(eslintMatch[2]),
        message: eslintMatch[4],
        impact: /error/i.test(eslintMatch[3]) ? "warning" : "improvement",
        source: "lint",
        selected: true,
        verified: true,
      });
      continue;
    }

    // Rust errors: error[E0425]: cannot find value `x` in this scope
    //   --> src/main.rs:10:5
    const rustErrorMatch = line.match(/^(error|warning)(?:\[E\d+\])?:\s*(.+)/);
    if (rustErrorMatch) {
      const locationLine = lines[i + 1] || "";
      const locMatch = locationLine.match(/-->\s*(.+?):(\d+):\d+/);
      if (locMatch) {
        bugs.push({
          id: `compiler-${bugs.length}`,
          file: locMatch[1].replace(/\\/g, "/"),
          line: parseInt(locMatch[2]),
          message: rustErrorMatch[2],
          impact: rustErrorMatch[1] === "error" ? "critical" : "warning",
          source: "compiler",
          selected: true,
          verified: true,
        });
      }
      continue;
    }

    // Python errors: file.py:10: error: message
    const pyMatch = line.match(/^(.+?\.py):(\d+):\s*(error|warning|note):\s*(.+)/);
    if (pyMatch) {
      bugs.push({
        id: `lint-${bugs.length}`,
        file: pyMatch[1].replace(/\\/g, "/"),
        line: parseInt(pyMatch[2]),
        message: pyMatch[4],
        impact: pyMatch[3] === "error" ? "critical" : pyMatch[3] === "warning" ? "warning" : "improvement",
        source: "lint",
        selected: true,
        verified: true,
      });
      continue;
    }

    // Generic: file:line: message (covers many tools)
    const genericMatch = line.match(/^(.+?\.\w+):(\d+)(?::\d+)?:\s*(error|Error|ERROR|warning|Warning|WARN)[\s:]+(.+)/);
    if (genericMatch && !genericMatch[1].includes("node_modules")) {
      bugs.push({
        id: `${commandType}-${bugs.length}`,
        file: genericMatch[1].replace(/\\/g, "/"),
        line: parseInt(genericMatch[2]),
        message: genericMatch[4],
        impact: /error/i.test(genericMatch[3]) ? "critical" : "warning",
        source: commandType === "lint" ? "lint" : "compiler",
        selected: true,
        verified: true,
      });
    }
  }

  return bugs;
}

// --- Parse npm audit JSON output ---

function parseAuditOutput(output: string): BugItem[] {
  const bugs: BugItem[] = [];
  try {
    const audit = JSON.parse(output);
    const vulnerabilities = audit.vulnerabilities || {};
    for (const [pkg, info] of Object.entries(vulnerabilities)) {
      const vuln = info as { severity: string; via: Array<{ title?: string; url?: string }> | string[]; fixAvailable?: boolean };
      const severity = vuln.severity;
      const title = Array.isArray(vuln.via) && vuln.via[0] && typeof vuln.via[0] === "object"
        ? (vuln.via[0] as { title?: string }).title || `Vulnerability in ${pkg}`
        : `Vulnerability in ${pkg}`;

      bugs.push({
        id: `audit-${bugs.length}`,
        file: `package.json (${pkg})`,
        line: 1,
        message: `${title} [${severity}]${vuln.fixAvailable ? " — fix available" : ""}`,
        impact: severity === "critical" || severity === "high" ? "critical" : severity === "moderate" ? "warning" : "improvement",
        source: "audit",
        selected: severity === "critical" || severity === "high",
        verified: true,
      });
    }
  } catch {
    // Not valid JSON or no vulnerabilities
  }
  return bugs;
}

// --- Static analysis on file content (zero tokens) ---

async function runStaticAnalysis(
  projectPath: string,
  targetFiles?: string[],
  addLog?: (msg: string) => void
): Promise<BugItem[]> {
  const bugs: BugItem[] = [];

  // Get list of files to scan
  let filesToScan: string[] = [];

  if (targetFiles && targetFiles.length > 0) {
    filesToScan = targetFiles;
  } else {
    // Discover files from project search (top-level scan)
    try {
      // Search for common source file patterns
      const extensions = [".ts", ".tsx", ".js", ".jsx", ".py", ".rs"];
      for (const ext of extensions) {
        const results = await searchProject(ext);
        for (const r of results) {
          if (!filesToScan.includes(r.path) && !SKIP_DIRS.has(r.path.split("/")[0])) {
            filesToScan.push(r.path);
          }
        }
        if (filesToScan.length > 100) break; // Cap at 100 files
      }
    } catch { /* search failed */ }
  }

  if (filesToScan.length === 0) return bugs;
  addLog?.(`  Scanning ${filesToScan.length} file${filesToScan.length > 1 ? "s" : ""} for patterns...`);

  let scannedCount = 0;
  for (const filePath of filesToScan.slice(0, 100)) {
    // Skip files in excluded directories
    const parts = filePath.replace(/\\/g, "/").split("/");
    if (parts.some((p) => SKIP_DIRS.has(p))) continue;
    if (SKIP_FILES.has(parts[parts.length - 1])) continue;

    // Determine file extension
    const ext = "." + (filePath.split(".").pop() || "").toLowerCase();

    // Get applicable patterns for this file type
    const applicablePatterns = STATIC_PATTERNS.filter((p) => p.fileTypes.includes(ext));
    if (applicablePatterns.length === 0) continue;

    // Read file content
    let content: string;
    try {
      const fullPath = /^[A-Za-z]:[\\/]/.test(filePath) ? filePath : `${projectPath}/${filePath}`;
      content = await readFile(fullPath);
      if (content.length > MAX_FILE_SIZE) continue; // Skip very large files
    } catch {
      continue;
    }

    scannedCount++;
    const lines = content.split("\n");

    for (const pattern of applicablePatterns) {
      // Check if this file should be excluded (e.g. test files for console.log)
      if (pattern.id === "console-log-prod" && /test|spec|\.test\.|\.spec\./i.test(filePath)) continue;

      for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
        const line = lines[lineIdx];
        if (pattern.pattern.test(line)) {
          // Check exclusion pattern
          if (pattern.exclude && pattern.exclude.test(line)) continue;

          // Avoid duplicates
          const relPath = filePath.replace(/\\/g, "/");
          const isDuplicate = bugs.some(
            (b) => b.file === relPath && b.line === lineIdx + 1 && b.message === pattern.message
          );
          if (isDuplicate) continue;

          bugs.push({
            id: `static-${bugs.length}`,
            file: relPath,
            line: lineIdx + 1,
            message: pattern.message,
            impact: pattern.impact,
            source: "static",
            selected: pattern.impact === "critical",
            verified: true, // We literally found it in the file
          });
        }
        // Reset regex lastIndex for global patterns
        pattern.pattern.lastIndex = 0;
      }
    }
  }

  addLog?.(`  Scanned ${scannedCount} files, found ${bugs.length} pattern match${bugs.length !== 1 ? "es" : ""}`);
  return bugs;
}

// --- Verify AI-reported bugs actually exist in the file ---

async function verifyBugs(projectPath: string, bugs: BugItem[]): Promise<BugItem[]> {
  const verified: BugItem[] = [];

  for (const bug of bugs) {
    // Already verified (from compiler/static)
    if (bug.verified) {
      verified.push(bug);
      continue;
    }

    // Try to read the file and check if the line exists
    try {
      const fullPath = /^[A-Za-z]:[\\/]/.test(bug.file) ? bug.file : `${projectPath}/${bug.file}`;
      const content = await readFile(fullPath);
      const lines = content.split("\n");

      // Check if the line number is valid
      if (bug.line > 0 && bug.line <= lines.length) {
        verified.push({ ...bug, verified: true });
      } else if (lines.length > 0) {
        // Line number is wrong but file exists — adjust to closest valid line
        verified.push({ ...bug, line: Math.min(bug.line, lines.length), verified: true });
      }
      // If file doesn't exist, we drop the bug (AI hallucinated)
    } catch {
      // File doesn't exist — AI hallucinated this bug, drop it
    }
  }

  return verified;
}

// --- Deduplicate bugs from multiple sources ---

function deduplicateBugs(bugs: BugItem[]): BugItem[] {
  const seen = new Map<string, BugItem>();

  for (const bug of bugs) {
    // Key: file + line + first 50 chars of message
    const key = `${bug.file}:${bug.line}:${bug.message.slice(0, 50).toLowerCase()}`;

    if (!seen.has(key)) {
      seen.set(key, bug);
    } else {
      // Keep the one with higher confidence (compiler > lint > static > ai)
      const existing = seen.get(key)!;
      const priority: Record<BugSource, number> = { compiler: 4, lint: 3, static: 2, audit: 3, ai: 1 };
      if (priority[bug.source] > priority[existing.source]) {
        seen.set(key, bug);
      }
    }
  }

  return [...seen.values()];
}

// --- AI System Prompts ---

const BUG_HUNT_SYSTEM_PROMPT = `You are a strict code analysis assistant. You ONLY report issues that would cause:
- Build/compile failures
- Runtime crashes or exceptions
- Security vulnerabilities
- Incorrect behavior (logic bugs)
- Type errors that a compiler would catch

Do NOT report:
- Style preferences or naming conventions
- "Could be improved" suggestions
- Configuration opinions
- Things that are technically valid but you'd do differently
- Issues already listed in the "Already Found" section below

For each REAL issue found, output EXACTLY in this format (one per line):
BUG|<impact>|<file_path>|<line_number>|<description>

Where <impact> is one of: critical, warning, improvement
- critical: will crash, won't build, security hole, data loss
- warning: likely bug, unhandled error, type mismatch that passes but breaks at runtime
- improvement: real performance issue or missing error handling that will cause problems

Use the RELATIVE file path from the project root.
If you find NO additional issues beyond what's already listed, output exactly: NO_ISSUES_FOUND
Do NOT output anything else — no explanations, no markdown, just BUG| lines or NO_ISSUES_FOUND.`;

const BUG_FIX_SYSTEM_PROMPT = `You are a code fixing assistant. Fix the following bug with the smallest possible change.

IMPORTANT: Return the fix using EXACTLY this format:

===FILE: <relative_path>===
<complete file content with fix applied>
===END_FILE===

Rules:
- Use the RELATIVE file path (e.g., "src/main.ts" not absolute paths)
- Include the COMPLETE file content, not just the changed lines
- Only fix the specific bug described
- Do not change unrelated code
- Do not add comments explaining the fix
- Do not rename variables or restructure code`;

// Yield to the browser event loop so React can repaint (prevents UI freeze)
const yieldToUI = () => new Promise<void>((r) => setTimeout(r, 0));

// Run a terminal command with a timeout (prevents hanging on stuck commands)
const COMMAND_TIMEOUT_MS = 30_000; // 30 seconds default
const BUILD_TIMEOUT_MS = 60_000; // 60 seconds for build commands

async function runCommandWithTimeout(command: string, cwd: string, isBuild = false): Promise<{ stdout: string; stderr: string; exit_code: number; timedOut?: boolean }> {
  const timeout = isBuild ? BUILD_TIMEOUT_MS : COMMAND_TIMEOUT_MS;
  const timeoutPromise = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error("TIMEOUT")), timeout)
  );

  try {
    const result = await Promise.race([
      runTerminalCommand(command, cwd),
      timeoutPromise,
    ]);
    return result;
  } catch (err) {
    if (err instanceof Error && err.message === "TIMEOUT") {
      return { stdout: "", stderr: `Command timed out after ${timeout / 1000}s`, exit_code: -1, timedOut: true };
    }
    throw err;
  }
}

// --- Main Component ---

export default function BugHunt({
  projectPath,
  runProfiles,
  aiProviders,
  legacyProvider: _legacyProvider,
  legacyModel: _legacyModel,
  legacyApiKey: _legacyApiKey,
  onClose,
  onApplyFix,
  onJumpToFile,
}: Props) {
  const [phase, setPhase] = useState<ScanPhase>("idle");
  const [scanLog, setScanLog] = useState<string[]>([]);
  const [bugs, setBugs] = useState<BugItem[]>([]);
  const [progress, setProgress] = useState(0);
  const [scanMode, setScanMode] = useState<"full" | "targeted">("full");
  const [targetFiles, setTargetFiles] = useState("");
  const [hasStarted, setHasStarted] = useState(false);
  const [showFixConfirm, setShowFixConfirm] = useState(false);
  const [detectedCommands, setDetectedCommands] = useState<DetectedCommand[]>([]);
  const [scanStats, setScanStats] = useState<{ compilerBugs: number; staticBugs: number; auditBugs: number; aiBugs: number; dropped: number }>({ compilerBugs: 0, staticBugs: 0, auditBugs: 0, aiBugs: 0, dropped: 0 });
  const logEndRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef(false);

  useEffect(() => {
    logEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [scanLog]);

  const addLog = (msg: string) => {
    setScanLog((prev) => [...prev, msg]);
  };

  const getProvider = () => {
    if (aiProviders.length > 0) {
      const provider = aiProviders.find((p) => p.models.some((m) => m.enabled));
      if (provider) {
        const model = provider.models.find((m) => m.enabled);
        if (model) return { provider, modelId: model.id };
      }
    }
    return null;
  };

  // --- Full Scan (robust multi-phase) ---

  const startFullScan = async () => {
    abortRef.current = false;
    setPhase("detecting");
    setBugs([]);
    setScanLog([]);
    setProgress(5);
    setScanStats({ compilerBugs: 0, staticBugs: 0, auditBugs: 0, aiBugs: 0, dropped: 0 });

    // Phase 1: Auto-detect build commands (zero tokens)
    addLog("🔍 Detecting project build tools...");
    let commands = [...detectedCommands];
    if (commands.length === 0) {
      commands = await autoDetectCommands(projectPath);
      setDetectedCommands(commands);
    }

    // Merge with user-configured run profiles (skip dev servers)
    const SERVER_PATTERNS = /\b(dev|start|serve|watch|preview|storybook)\b/i;
    for (const profile of runProfiles) {
      if (!commands.some((c) => c.command === profile.command)) {
        // Skip long-running server commands
        if (SERVER_PATTERNS.test(profile.name) || SERVER_PATTERNS.test(profile.command)) continue;
        const type = /build/i.test(profile.name) ? "build" as const
          : /lint|eslint/i.test(profile.name) ? "lint" as const
          : /test/i.test(profile.name) ? "test" as const
          : /type/i.test(profile.name) ? "typecheck" as const
          : "build" as const;
        commands.push({ name: profile.name, command: profile.command, type });
      }
    }

    // Also filter out any auto-detected commands that look like servers
    commands = commands.filter((c) => !SERVER_PATTERNS.test(c.command) || c.type === "audit");

    if (commands.length === 0) {
      addLog("⚠ No build tools detected. Running static analysis only...");
    } else {
      addLog(`  Found: ${commands.map((c) => c.name).join(", ")}`);
    }

    if (abortRef.current) return;

    // Phase 2: Run build/lint/typecheck commands (zero tokens)
    setPhase("scanning");
    setProgress(15);
    let allBugs: BugItem[] = [];
    let allOutput = "";

    const buildCommands = commands.filter((c) => c.type !== "audit").slice(0, 5);
    for (let i = 0; i < buildCommands.length; i++) {
      if (abortRef.current) return;
      const cmd = buildCommands[i];
      addLog(`▶ Running: ${cmd.name} (${cmd.command.slice(0, 50)}${cmd.command.length > 50 ? "..." : ""})`);
      setProgress(15 + ((i / buildCommands.length) * 25));
      await yieldToUI(); // Let React repaint before blocking command

      try {
        const result = await runCommandWithTimeout(cmd.command, projectPath, cmd.type === "build");
        await yieldToUI(); // Let React repaint after command completes
        const output = `${result.stdout}\n${result.stderr}`.trim();

        if (result.timedOut) {
          addLog(`  ⚠ ${cmd.name} timed out (skipped)`);
        } else if (result.exit_code === 0) {
          addLog(`  ✓ ${cmd.name} passed`);
        } else {
          addLog(`  ✗ ${cmd.name} failed (exit ${result.exit_code})`);
          allOutput += `\n--- ${cmd.name} ---\n${output}\n`;

          // Parse structured errors from output
          const parsed = parseCompilerOutput(output, cmd.type);
          if (parsed.length > 0) {
            addLog(`    → Parsed ${parsed.length} error${parsed.length > 1 ? "s" : ""} from output`);
            allBugs.push(...parsed);
          }
        }
      } catch (err) {
        addLog(`  ✗ ${cmd.name} error: ${err}`);
      }
    }

    setScanStats((prev) => ({ ...prev, compilerBugs: allBugs.length }));

    if (abortRef.current) return;

    // Phase 3: Run npm/cargo audit (zero tokens)
    setPhase("auditing");
    setProgress(45);
    const auditCmd = commands.find((c) => c.type === "audit");
    if (auditCmd) {
      addLog(`🛡️ Running security audit...`);
      try {
        await yieldToUI();
        const result = await runCommandWithTimeout(auditCmd.command, projectPath);
        await yieldToUI();
        const output = `${result.stdout}\n${result.stderr}`.trim();
        const auditBugs = parseAuditOutput(output);
        if (auditBugs.length > 0) {
          addLog(`  ⚠ Found ${auditBugs.length} vulnerabilit${auditBugs.length > 1 ? "ies" : "y"}`);
          allBugs.push(...auditBugs);
          setScanStats((prev) => ({ ...prev, auditBugs: auditBugs.length }));
        } else {
          addLog(`  ✓ No known vulnerabilities`);
        }
      } catch {
        addLog(`  ⚠ Audit command not available`);
      }
    }

    if (abortRef.current) return;

    // Phase 4: Static analysis (zero tokens)
    setPhase("static_analysis");
    setProgress(55);
    addLog("🔬 Running static pattern analysis...");
    const staticBugs = await runStaticAnalysis(projectPath, undefined, addLog);
    if (staticBugs.length > 0) {
      allBugs.push(...staticBugs);
      setScanStats((prev) => ({ ...prev, staticBugs: staticBugs.length }));
    }

    if (abortRef.current) return;

    // Phase 5: AI analysis (only if we have a provider AND there's output to analyze)
    // This is the ONLY step that costs tokens
    const providerInfo = getProvider();
    if (providerInfo && allOutput.trim()) {
      setPhase("analyzing");
      setProgress(70);
      addLog("🤖 AI deep analysis (token cost)...");

      // Tell AI what we already found so it doesn't duplicate
      const alreadyFound = allBugs.length > 0
        ? `\n\nAlready Found (do NOT repeat these):\n${allBugs.slice(0, 20).map((b) => `- ${b.file}:${b.line} ${b.message}`).join("\n")}`
        : "";

      try {
        const resp = await sendToProviderStreaming(
          providerInfo.provider,
          providerInfo.modelId,
          {
            systemPrompt: BUG_HUNT_SYSTEM_PROMPT,
            userPrompt: `Project: ${projectPath}\n\nBuild/Lint output:\n${allOutput.slice(0, 12000)}${alreadyFound}`,
          }
        );

        if (resp.success) {
          const bugLines = resp.text.split("\n").filter((l) => l.startsWith("BUG|"));
          if (bugLines.length > 0 && !resp.text.includes("NO_ISSUES_FOUND")) {
            const aiBugs: BugItem[] = bugLines.map((line, idx) => {
              const parts = line.split("|");
              return {
                id: `ai-${idx}`,
                impact: (parts[1] as BugImpact) || "warning",
                file: (parts[2] || "unknown").replace(/\\/g, "/"),
                line: parseInt(parts[3]) || 1,
                message: parts[4] || "Unknown issue",
                source: "ai" as BugSource,
                selected: parts[1] === "critical",
                verified: false,
              };
            });
            allBugs.push(...aiBugs);
            setScanStats((prev) => ({ ...prev, aiBugs: aiBugs.length }));
          }
        } else {
          addLog(`  ⚠ AI analysis failed: ${resp.error}`);
        }
      } catch (err) {
        addLog(`  ⚠ AI error: ${err}`);
      }
    } else if (!providerInfo) {
      addLog("ℹ No AI provider configured — skipping deep analysis");
    } else {
      addLog("ℹ No build errors to analyze — skipping AI step (0 tokens used)");
    }

    if (abortRef.current) return;

    // Phase 6: Verify AI-reported bugs (zero tokens)
    setPhase("verifying");
    setProgress(90);
    const unverifiedCount = allBugs.filter((b) => !b.verified).length;
    if (unverifiedCount > 0) {
      addLog(`🔎 Verifying ${unverifiedCount} AI-reported issue${unverifiedCount > 1 ? "s" : ""}...`);
      allBugs = await verifyBugs(projectPath, allBugs);
      const droppedCount = unverifiedCount - allBugs.filter((b) => b.source === "ai").length;
      if (droppedCount > 0) {
        addLog(`  ✗ Dropped ${droppedCount} hallucinated bug${droppedCount > 1 ? "s" : ""} (file/line doesn't exist)`);
        setScanStats((prev) => ({ ...prev, dropped: droppedCount }));
      }
    }

    // Phase 7: Deduplicate and sort
    allBugs = deduplicateBugs(allBugs);
    allBugs.sort((a, b) => {
      const impactOrder = { critical: 0, warning: 1, improvement: 2 };
      const sourceOrder: Record<BugSource, number> = { compiler: 0, lint: 1, audit: 2, static: 3, ai: 4 };
      return (impactOrder[a.impact] - impactOrder[b.impact]) || (sourceOrder[a.source] - sourceOrder[b.source]);
    });

    setBugs(allBugs);
    setProgress(100);

    if (allBugs.length === 0) {
      addLog("✓ No issues found! Your project looks clean.");
    } else {
      addLog(`\n📊 Summary: ${allBugs.length} issue${allBugs.length > 1 ? "s" : ""} found`);
    }
    setPhase("ready");
  };

  // --- Targeted Scan ---

  const startTargetedScan = async () => {
    abortRef.current = false;
    const fileNames = targetFiles
      .split(",")
      .map((f) => f.trim().replace(/^@/, ""))
      .filter(Boolean);

    if (fileNames.length === 0) {
      addLog("⚠ No files specified. Use format: @main.js, @src/App.tsx");
      return;
    }

    setPhase("scanning");
    setBugs([]);
    setScanLog([]);
    setProgress(10);
    setHasStarted(true);
    setScanStats({ compilerBugs: 0, staticBugs: 0, auditBugs: 0, aiBugs: 0, dropped: 0 });

    // Resolve file paths
    const resolvedFiles: string[] = [];
    for (const fileName of fileNames) {
      addLog(`📄 Resolving: ${fileName}`);
      try {
        const isAbsolute = /^[A-Za-z]:[\\/]/.test(fileName) || fileName.startsWith("/");
        if (isAbsolute) {
          await readFile(fileName);
          resolvedFiles.push(fileName);
        } else {
          try {
            await readFile(`${projectPath}/${fileName}`);
            resolvedFiles.push(fileName);
          } catch {
            const searchResults = await searchProject(fileName.split("/").pop() || fileName);
            if (searchResults.length > 0) {
              const match = searchResults.find((r) => r.path.endsWith(fileName) || r.path.endsWith(`/${fileName}`));
              const bestPath = match ? match.path : searchResults[0].path;
              await readFile(`${projectPath}/${bestPath}`);
              resolvedFiles.push(bestPath);
              addLog(`  → Found at: ${bestPath}`);
            } else {
              addLog(`  ✗ Not found: ${fileName}`);
            }
          }
        }
      } catch {
        addLog(`  ✗ Cannot access: ${fileName}`);
      }
    }

    if (resolvedFiles.length === 0) {
      addLog("⚠ No files could be resolved.");
      setPhase("idle");
      return;
    }

    if (abortRef.current) return;

    // Run lint on specific files
    setProgress(30);
    let lintOutput = "";
    addLog(`▶ Running lint/typecheck on ${resolvedFiles.length} file${resolvedFiles.length > 1 ? "s" : ""}...`);

    const lintCommands = [
      `npx eslint ${resolvedFiles.join(" ")} --no-error-on-unmatched-pattern 2>&1`,
      `npx tsc --noEmit --pretty 2>&1`,
    ];

    let allBugs: BugItem[] = [];

    for (const cmd of lintCommands) {
      try {
        await yieldToUI();
        const result = await runCommandWithTimeout(cmd, projectPath);
        await yieldToUI();
        const output = `${result.stdout}\n${result.stderr}`.trim();
        if (result.exit_code !== 0 && output) {
          lintOutput += output + "\n";
          const parsed = parseCompilerOutput(output, "lint");
          allBugs.push(...parsed);
        }
      } catch { /* command not available */ }
    }

    if (allBugs.length > 0) {
      addLog(`  Found ${allBugs.length} lint/type error${allBugs.length > 1 ? "s" : ""}`);
      setScanStats((prev) => ({ ...prev, compilerBugs: allBugs.length }));
    } else {
      addLog(`  ✓ No lint/type errors`);
    }

    if (abortRef.current) return;

    // Static analysis on targeted files
    setPhase("static_analysis");
    setProgress(50);
    addLog("🔬 Static pattern analysis...");
    const staticBugs = await runStaticAnalysis(projectPath, resolvedFiles, addLog);
    allBugs.push(...staticBugs);
    setScanStats((prev) => ({ ...prev, staticBugs: staticBugs.length }));

    if (abortRef.current) return;

    // AI analysis (only if there's something to analyze or files to deep-check)
    const providerInfo = getProvider();
    if (providerInfo) {
      setPhase("analyzing");
      setProgress(70);

      let analysisInput: string;
      if (lintOutput.trim()) {
        analysisInput = `Lint/typecheck output for [${resolvedFiles.join(", ")}]:\n${lintOutput.slice(0, 8000)}`;
      } else {
        // No lint errors — read file content for deeper analysis
        let fileContents = "";
        for (const file of resolvedFiles.slice(0, 5)) {
          try {
            const fullPath = /^[A-Za-z]:/.test(file) ? file : `${projectPath}/${file}`;
            const content = await readFile(fullPath);
            fileContents += `\n===FILE: ${file}===\n${content.slice(0, 5000)}\n===END_FILE===\n`;
          } catch { /* skip */ }
        }
        if (!fileContents.trim()) {
          addLog("✓ Files are clean.");
          setBugs(deduplicateBugs(allBugs));
          setPhase("ready");
          setProgress(100);
          return;
        }
        analysisInput = `No lint errors. Only report REAL bugs (crashes, security, logic errors). If code is functional, respond NO_ISSUES_FOUND.\n\nFiles:\n${fileContents}`;
      }

      const alreadyFound = allBugs.length > 0
        ? `\n\nAlready Found (do NOT repeat):\n${allBugs.map((b) => `- ${b.file}:${b.line} ${b.message}`).join("\n")}`
        : "";

      addLog("🤖 AI deep analysis...");
      try {
        const resp = await sendToProviderStreaming(
          providerInfo.provider,
          providerInfo.modelId,
          {
            systemPrompt: BUG_HUNT_SYSTEM_PROMPT,
            userPrompt: `Project: ${projectPath}\n\n${analysisInput}${alreadyFound}`,
          }
        );

        if (resp.success) {
          const bugLines = resp.text.split("\n").filter((l) => l.startsWith("BUG|"));
          if (bugLines.length > 0 && !resp.text.includes("NO_ISSUES_FOUND")) {
            const aiBugs: BugItem[] = bugLines.map((line, idx) => {
              const parts = line.split("|");
              return {
                id: `ai-${idx}`,
                impact: (parts[1] as BugImpact) || "warning",
                file: (parts[2] || "unknown").replace(/\\/g, "/"),
                line: parseInt(parts[3]) || 1,
                message: parts[4] || "Unknown issue",
                source: "ai" as BugSource,
                selected: parts[1] === "critical",
                verified: false,
              };
            });
            allBugs.push(...aiBugs);
            setScanStats((prev) => ({ ...prev, aiBugs: aiBugs.length }));
          } else {
            addLog("  ✓ AI found no additional issues");
          }
        }
      } catch (err) {
        addLog(`  ⚠ AI error: ${err}`);
      }
    }

    if (abortRef.current) return;

    // Verify and deduplicate
    setPhase("verifying");
    setProgress(90);
    const unverified = allBugs.filter((b) => !b.verified).length;
    if (unverified > 0) {
      addLog(`🔎 Verifying ${unverified} AI-reported issue${unverified > 1 ? "s" : ""}...`);
      allBugs = await verifyBugs(projectPath, allBugs);
      const dropped = unverified - allBugs.filter((b) => b.source === "ai").length;
      if (dropped > 0) {
        addLog(`  ✗ Dropped ${dropped} hallucinated bug${dropped > 1 ? "s" : ""}`);
        setScanStats((prev) => ({ ...prev, dropped }));
      }
    }

    allBugs = deduplicateBugs(allBugs);
    allBugs.sort((a, b) => {
      const impactOrder = { critical: 0, warning: 1, improvement: 2 };
      return impactOrder[a.impact] - impactOrder[b.impact];
    });

    setBugs(allBugs);
    setProgress(100);
    if (allBugs.length === 0) {
      addLog("✓ No issues found in targeted files.");
    } else {
      addLog(`📊 Found ${allBugs.length} issue${allBugs.length > 1 ? "s" : ""}`);
    }
    setPhase("ready");
  };

  const handleStartScan = () => {
    setHasStarted(true);
    if (scanMode === "full") {
      startFullScan();
    } else {
      startTargetedScan();
    }
  };

  const handleStop = () => {
    abortRef.current = true;
    addLog("■ Scan stopped by user");
    setPhase("ready");
  };

  const toggleBug = (id: string) => {
    setBugs((prev) => prev.map((b) => b.id === id ? { ...b, selected: !b.selected } : b));
  };

  const selectByImpact = (impact: BugImpact | "all") => {
    setBugs((prev) => prev.map((b) => ({ ...b, selected: impact === "all" || b.impact === impact })));
  };

  const selectBySource = (source: BugSource) => {
    setBugs((prev) => prev.map((b) => ({ ...b, selected: b.source === source })));
  };

  const fixSelected = () => {
    const toFix = bugs.filter((b) => b.selected && !b.fixed);
    if (toFix.length === 0) return;
    setShowFixConfirm(true);
  };

  const confirmAndFix = async () => {
    setShowFixConfirm(false);
    const toFix = bugs.filter((b) => b.selected && !b.fixed);
    if (toFix.length === 0) return;

    setPhase("fixing");
    const providerInfo = getProvider();
    if (!providerInfo) {
      addLog("⚠ No AI provider available for fixing.");
      setPhase("ready");
      return;
    }

    // Group bugs by file
    const bugsByFile = new Map<string, BugItem[]>();
    for (const bug of toFix) {
      const existing = bugsByFile.get(bug.file) || [];
      existing.push(bug);
      bugsByFile.set(bug.file, existing);
    }

    for (const [file, fileBugs] of bugsByFile) {
      setBugs((prev) => prev.map((b) => fileBugs.some((fb) => fb.id === b.id) ? { ...b, fixing: true } : b));
      addLog(`🔧 Fixing ${fileBugs.length} issue${fileBugs.length > 1 ? "s" : ""} in ${file}...`);

      try {
        let fileContent = "";
        const fullPath = /^[A-Za-z]:[\\/]/.test(file) || file.startsWith("/")
          ? file
          : `${projectPath}/${file}`;

        try {
          fileContent = await readFile(fullPath);
        } catch {
          const results = await searchProject(file.split("/").pop() || file);
          if (results.length > 0) {
            const match = results.find((r) => r.path.endsWith(file));
            const searchPath = `${projectPath}/${match ? match.path : results[0].path}`;
            fileContent = await readFile(searchPath);
          }
        }

        if (!fileContent) {
          addLog(`  ✗ Cannot read file: ${file} — skipping`);
          setBugs((prev) => prev.map((b) => fileBugs.some((fb) => fb.id === b.id) ? { ...b, fixing: false } : b));
          continue;
        }

        const issueList = fileBugs.map((b, i) => `${i + 1}. Line ${b.line}: ${b.message} [${b.source}]`).join("\n");

        const resp = await sendToProviderStreaming(
          providerInfo.provider,
          providerInfo.modelId,
          {
            systemPrompt: BUG_FIX_SYSTEM_PROMPT,
            userPrompt: `Fix ALL of the following issues in a single coherent edit:\nFile: ${file}\n\nIssues:\n${issueList}\n\nCurrent file content:\n\`\`\`\n${fileContent.slice(0, 8000)}\n\`\`\``,
          }
        );

        if (!resp.success) {
          addLog(`  ✗ AI failed: ${resp.error || "Unknown error"}`);
          setBugs((prev) => prev.map((b) => fileBugs.some((fb) => fb.id === b.id) ? { ...b, fixing: false } : b));
          continue;
        }

        const parsed = parseResponse(resp.text, new Set());
        if (parsed.fileChanges.length > 0) {
          const safeParsed: ParsedResponse = {
            ...parsed,
            fileChanges: parsed.fileChanges.map((fc) => ({ ...fc, path: file })),
          };

          try {
            await onApplyFix(safeParsed);
            addLog(`  ✓ Fixed ${fileBugs.length} issue${fileBugs.length > 1 ? "s" : ""} in ${file}`);
            setBugs((prev) => prev.map((b) => fileBugs.some((fb) => fb.id === b.id) ? { ...b, fixing: false, fixed: true } : b));
          } catch (applyErr) {
            addLog(`  ✗ Failed to apply: ${applyErr}`);
            setBugs((prev) => prev.map((b) => fileBugs.some((fb) => fb.id === b.id) ? { ...b, fixing: false } : b));
          }
        } else {
          addLog(`  ✗ AI response didn't contain valid file changes`);
          setBugs((prev) => prev.map((b) => fileBugs.some((fb) => fb.id === b.id) ? { ...b, fixing: false } : b));
        }
      } catch (err) {
        addLog(`  ✗ Error: ${err}`);
        setBugs((prev) => prev.map((b) => fileBugs.some((fb) => fb.id === b.id) ? { ...b, fixing: false } : b));
      }
    }

    setPhase("ready");
  };

  const criticalCount = bugs.filter((b) => b.impact === "critical").length;
  const warningCount = bugs.filter((b) => b.impact === "warning").length;
  const improvementCount = bugs.filter((b) => b.impact === "improvement").length;
  const selectedCount = bugs.filter((b) => b.selected && !b.fixed).length;
  const fixedCount = bugs.filter((b) => b.fixed).length;

  return (
    <div className="bughunt-overlay" onClick={onClose}>
      <div className="bughunt-panel" onClick={(e) => e.stopPropagation()}>
        {/* Header */}
        <div className="bughunt-header">
          <div className="bughunt-title">
            <Bug size={18} className="bughunt-icon" />
            <h2>Bug Hunt</h2>
            {bugs.length > 0 && (
              <div className="bughunt-counts">
                {criticalCount > 0 && <span className="bughunt-count critical">{criticalCount}</span>}
                {warningCount > 0 && <span className="bughunt-count warning">{warningCount}</span>}
                {improvementCount > 0 && <span className="bughunt-count improvement">{improvementCount}</span>}
              </div>
            )}
          </div>
          <button className="bughunt-close" onClick={onClose}><X size={16} /></button>
        </div>

        {/* Scan Mode Selector */}
        {!hasStarted && phase === "idle" && (
          <div className="bughunt-mode-selector">
            <div className="bughunt-mode-tabs">
              <button className={`bughunt-mode-tab ${scanMode === "full" ? "active" : ""}`} onClick={() => setScanMode("full")}>Full Scan</button>
              <button className={`bughunt-mode-tab ${scanMode === "targeted" ? "active" : ""}`} onClick={() => setScanMode("targeted")}>Targeted Scan</button>
            </div>
            {scanMode === "full" ? (
              <div className="bughunt-mode-desc">
                <p>Auto-detects build tools, runs lint/typecheck/audit, static pattern analysis, then AI deep analysis.</p>
                <p className="bughunt-mode-hint"><Shield size={12} /> Most analysis is local (zero tokens). AI is only called if build errors exist.</p>
              </div>
            ) : (
              <div className="bughunt-mode-desc">
                <p>Scan specific files with lint, static analysis, and AI review.</p>
                <p className="bughunt-mode-hint"><Search size={12} /> Focused debugging — fewer tokens, faster results.</p>
                <input className="bughunt-target-input" type="text" value={targetFiles} onChange={(e) => setTargetFiles(e.target.value)} placeholder="@main.js, @src/App.tsx, @package.json" onKeyDown={(e) => { if (e.key === "Enter") handleStartScan(); }} />
              </div>
            )}
            <button className="bughunt-start-btn" onClick={handleStartScan} disabled={scanMode === "targeted" && !targetFiles.trim()}>
              <Bug size={16} /> Start {scanMode === "full" ? "Full" : "Targeted"} Scan
            </button>
          </div>
        )}

        {/* Progress */}
        {phase !== "idle" && phase !== "ready" && (
          <div className="bughunt-progress-section">
            <div className="bughunt-progress"><div className="bughunt-progress-bar" style={{ width: `${progress}%` }} /></div>
            <div className="bughunt-phase-label">
              {phase === "detecting" && "Detecting build tools..."}
              {phase === "scanning" && "Running build/lint commands..."}
              {phase === "auditing" && "Security audit..."}
              {phase === "static_analysis" && "Static pattern analysis (0 tokens)..."}
              {phase === "analyzing" && "AI deep analysis (uses tokens)..."}
              {phase === "verifying" && "Verifying reported issues..."}
              {phase === "fixing" && "Applying fixes..."}
              <button className="bughunt-stop-btn" onClick={handleStop} title="Stop scan">■</button>
            </div>
          </div>
        )}

        {/* Scan Log */}
        {(phase !== "idle" && phase !== "ready") && (
          <div className="bughunt-log">
            {scanLog.map((line, i) => (<div key={i} className="bughunt-log-line">{line}</div>))}
            <div ref={logEndRef} />
          </div>
        )}

        {/* Bug List */}
        {phase === "ready" && bugs.length > 0 && (
          <>
            {(scanStats.compilerBugs > 0 || scanStats.staticBugs > 0 || scanStats.auditBugs > 0 || scanStats.aiBugs > 0) && (
              <div className="bughunt-stats">
                {scanStats.compilerBugs > 0 && <span className="bughunt-stat compiler" onClick={() => selectBySource("compiler")}>🔨 {scanStats.compilerBugs} compiler</span>}
                {scanStats.staticBugs > 0 && <span className="bughunt-stat static" onClick={() => selectBySource("static")}>🔬 {scanStats.staticBugs} static</span>}
                {scanStats.auditBugs > 0 && <span className="bughunt-stat audit" onClick={() => selectBySource("audit")}>🛡️ {scanStats.auditBugs} audit</span>}
                {scanStats.aiBugs > 0 && <span className="bughunt-stat ai" onClick={() => selectBySource("ai")}>🤖 {scanStats.aiBugs} AI</span>}
                {scanStats.dropped > 0 && <span className="bughunt-stat dropped">🗑️ {scanStats.dropped} dropped</span>}
              </div>
            )}
            <div className="bughunt-filters">
              <button className="bughunt-filter-btn all" onClick={() => selectByImpact("all")}>All ({bugs.length})</button>
              {criticalCount > 0 && <button className="bughunt-filter-btn critical" onClick={() => selectByImpact("critical")}>🔴 Critical ({criticalCount})</button>}
              {warningCount > 0 && <button className="bughunt-filter-btn warning" onClick={() => selectByImpact("warning")}>🟡 Warning ({warningCount})</button>}
              {improvementCount > 0 && <button className="bughunt-filter-btn improvement" onClick={() => selectByImpact("improvement")}>🔵 Improve ({improvementCount})</button>}
            </div>
            <div className="bughunt-list">
              {bugs.map((bug) => {
                const cfg = IMPACT_CONFIG[bug.impact];
                return (
                  <div key={bug.id} className={`bughunt-item ${bug.impact} ${bug.fixing ? "fixing" : ""} ${bug.fixed ? "fixed" : ""}`}>
                    {!bug.fixed && !bug.fixing && <input type="checkbox" checked={bug.selected} onChange={() => toggleBug(bug.id)} disabled={bug.fixed || bug.fixing} />}
                    {bug.fixing && <div className="bughunt-item-spinner"><Loader2 size={16} className="spin" /></div>}
                    {bug.fixed && <div className="bughunt-item-fixed-icon"><Check size={16} /></div>}
                    <div className="bughunt-item-badge" style={{ background: cfg.glow, color: cfg.color }}>{bug.fixed ? "✓" : cfg.label.charAt(0)}</div>
                    <div className="bughunt-item-content">
                      <div className="bughunt-item-top">
                        <span className={`bughunt-item-msg ${bug.fixed ? "strikethrough" : ""}`}>{bug.message}</span>
                        <span className="bughunt-item-source" title={`Found by: ${SOURCE_LABELS[bug.source]}`}>
                          {bug.source === "compiler" ? "🔨" : bug.source === "lint" ? "📏" : bug.source === "static" ? "🔬" : bug.source === "audit" ? "🛡️" : "🤖"}
                        </span>
                      </div>
                      {bug.fixing && <span className="bughunt-item-fixing-label">Fixing...</span>}
                      {bug.fixed && <span className="bughunt-item-fixed-label">✓ Fixed</span>}
                      {!bug.fixing && !bug.fixed && (
                        <button className="bughunt-item-file" onClick={() => onJumpToFile(bug.file, bug.line)}>
                          <FileText size={10} /> {bug.file}:{bug.line} <ChevronRight size={10} />
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
            <div className="bughunt-actions">
              <div className="bughunt-actions-info">
                {fixedCount > 0 && <span className="bughunt-fixed-count">✓ {fixedCount} fixed</span>}
                {selectedCount > 0 && <span>{selectedCount} selected</span>}
                {fixedCount > 0 && selectedCount === 0 && <span>All done!</span>}
              </div>
              <div className="bughunt-actions-btns">
                {fixedCount > 0 && selectedCount === 0 ? (
                  <button className="bughunt-fix-btn" onClick={() => { setHasStarted(false); setPhase("idle"); setBugs([]); setScanLog([]); }}><Bug size={14} /> New Scan</button>
                ) : (
                  <button className="bughunt-fix-btn" onClick={fixSelected} disabled={selectedCount === 0 || (phase as ScanPhase) === "fixing"}>
                    <Zap size={14} /> {(phase as ScanPhase) === "fixing" ? "Fixing..." : `Fix Selected (${selectedCount})`}
                  </button>
                )}
              </div>
            </div>
          </>
        )}

        {/* Empty state */}
        {phase === "ready" && bugs.length === 0 && (
          <div className="bughunt-empty">
            <Bug size={32} style={{ color: "var(--green)", opacity: 0.5 }} />
            <p>No bugs found! Your project looks clean.</p>
            {scanLog.length > 0 && (
              <div className="bughunt-log">
                {scanLog.map((line, i) => (<div key={i} className="bughunt-log-line">{line}</div>))}
              </div>
            )}
            <button className="btn-secondary" onClick={() => { setHasStarted(false); setPhase("idle"); setScanLog([]); }}>Scan Again</button>
          </div>
        )}

        {/* Idle with previous log */}
        {phase === "idle" && scanLog.length > 0 && (
          <div className="bughunt-log">
            {scanLog.map((line, i) => (<div key={i} className="bughunt-log-line">{line}</div>))}
            <button className="btn-primary compact" onClick={() => { setHasStarted(false); setPhase("idle"); setScanLog([]); }} style={{ marginTop: 12 }}>Retry Scan</button>
          </div>
        )}

        {/* Fix Confirmation Dialog */}
        {showFixConfirm && (
          <div className="bughunt-confirm-overlay">
            <div className="bughunt-confirm">
              <h3>Confirm Fix</h3>
              <div className="bughunt-confirm-section">
                <span className="bughunt-confirm-label">Will edit:</span>
                {[...new Set(bugs.filter((b) => b.selected && !b.fixed).map((b) => b.file))].map((file) => (
                  <div key={file} className="bughunt-confirm-file"><FileText size={12} /> {file}</div>
                ))}
              </div>
              <div className="bughunt-confirm-section">
                <span className="bughunt-confirm-label">Issues to fix:</span>
                {bugs.filter((b) => b.selected && !b.fixed).map((bug) => (
                  <div key={bug.id} className="bughunt-confirm-issue">
                    <span className={`bughunt-confirm-badge ${bug.impact}`}>{bug.impact === "critical" ? "🔴" : bug.impact === "warning" ? "🟡" : "🔵"}</span>
                    <span>{bug.message}</span>
                    <span className="bughunt-confirm-source">({SOURCE_LABELS[bug.source]})</span>
                  </div>
                ))}
              </div>
              <p className="bughunt-confirm-note">Multiple issues in the same file will be combined into one coherent edit.</p>
              <div className="bughunt-confirm-actions">
                <button className="btn-secondary compact" onClick={() => setShowFixConfirm(false)}>Cancel</button>
                <button className="bughunt-fix-btn" onClick={confirmAndFix}><Zap size={14} /> Apply Fix</button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
