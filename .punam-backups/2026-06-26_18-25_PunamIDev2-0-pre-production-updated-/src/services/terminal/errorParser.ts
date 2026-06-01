/**
 * Terminal Error Parser — Parses stack traces from JS, Python, Rust, Go.
 * Detects error types and converts terminal output to diagnostics.
 * Ported from Zenith IDE for Punam IDE.
 */

export interface StackFrame {
  file: string;
  line: number;
  column?: number;
  functionName?: string;
  raw: string;
}

export interface ParsedStackTrace {
  message: string;
  type: string;
  frames: StackFrame[];
  suggestion?: string;
}

export interface Diagnostic {
  path: string;
  line: number;
  column: number;
  message: string;
  severity: "error" | "warning" | "info" | "hint";
  source?: string;
  code?: string;
}

const JS_STACK_PATTERN = /at\s+(?:(.+?)\s+\()?(.+?):(\d+):(\d+)\)?/;
const PYTHON_STACK_PATTERN = /File "(.+?)", line (\d+)(?:, in (.+))?/;
const RUST_STACK_PATTERN = /(\d+):\s+(\S+)\s+at\s+(.+?):(\d+)/;
const GO_STACK_PATTERN = /\t(.+?):(\d+)\s/;

export function parseStackTrace(output: string): ParsedStackTrace | null {
  const lines = output.split("\n");
  const frames: StackFrame[] = [];
  let type = "unknown";

  for (const line of lines) {
    let match = JS_STACK_PATTERN.exec(line);
    if (match) {
      type = "javascript";
      frames.push({ functionName: match[1] || undefined, file: match[2], line: parseInt(match[3], 10), column: parseInt(match[4], 10), raw: line.trim() });
      continue;
    }
    match = PYTHON_STACK_PATTERN.exec(line);
    if (match) {
      type = "python";
      frames.push({ file: match[1], line: parseInt(match[2], 10), functionName: match[3] || undefined, raw: line.trim() });
      continue;
    }
    match = RUST_STACK_PATTERN.exec(line);
    if (match) {
      type = "rust";
      frames.push({ functionName: match[2], file: match[3], line: parseInt(match[4], 10), raw: line.trim() });
      continue;
    }
    match = GO_STACK_PATTERN.exec(line);
    if (match) {
      type = "go";
      frames.push({ file: match[1], line: parseInt(match[2], 10), raw: line.trim() });
      continue;
    }
  }

  if (frames.length === 0) return null;

  const errorLine = lines.find((l) => /error|exception|panic|fatal/i.test(l));
  const message = errorLine?.trim() || lines[0]?.trim() || "Unknown error";

  return { message, type, frames };
}

export function terminalOutputToDiagnostics(output: string, projectPath: string): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const parsed = parseStackTrace(output);

  if (parsed) {
    for (const frame of parsed.frames) {
      const path = /^[A-Za-z]:[\\/]/.test(frame.file) || frame.file.startsWith("/")
        ? frame.file
        : `${projectPath}/${frame.file}`;
      diagnostics.push({
        path, line: frame.line, column: frame.column || 1,
        message: parsed.message, severity: "error", source: `terminal-${parsed.type}`,
      });
    }
  }

  // TypeScript compiler errors
  const tscPattern = /(.+?)\((\d+),(\d+)\):\s*(error|warning)\s+(TS\d+):\s*(.+)/g;
  let match;
  while ((match = tscPattern.exec(output)) !== null) {
    diagnostics.push({
      path: `${projectPath}/${match[1]}`, line: parseInt(match[2], 10),
      column: parseInt(match[3], 10), message: match[6],
      severity: match[4] === "error" ? "error" : "warning", source: "tsc", code: match[5],
    });
  }

  // ESLint errors
  const eslintPattern = /(.+?):(\d+):(\d+):\s*(error|warning)\s+(.+?)\s+(\S+)$/gm;
  while ((match = eslintPattern.exec(output)) !== null) {
    diagnostics.push({
      path: `${projectPath}/${match[1]}`, line: parseInt(match[2], 10),
      column: parseInt(match[3], 10), message: match[5],
      severity: match[4] === "error" ? "error" : "warning", source: "eslint", code: match[6],
    });
  }

  return diagnostics;
}

export function detectTerminalError(output: string): {
  hasError: boolean;
  errorType: string;
  errorMessage: string;
} {
  const errorPatterns: Array<{ pattern: RegExp; type: string }> = [
    { pattern: /npm ERR!|yarn error|pnpm ERR/i, type: "package_manager" },
    { pattern: /ModuleNotFoundError|Cannot find module/i, type: "missing_module" },
    { pattern: /SyntaxError/i, type: "syntax_error" },
    { pattern: /TypeError/i, type: "type_error" },
    { pattern: /ReferenceError/i, type: "reference_error" },
    { pattern: /ENOENT|no such file/i, type: "file_not_found" },
    { pattern: /EACCES|permission denied/i, type: "permission_denied" },
    { pattern: /ECONNREFUSED|connection refused/i, type: "connection_error" },
    { pattern: /SIGKILL|SIGTERM|killed/i, type: "process_killed" },
    { pattern: /out of memory|heap/i, type: "memory_error" },
    { pattern: /compilation failed|build failed/i, type: "build_error" },
    { pattern: /test failed|tests? failing/i, type: "test_failure" },
    { pattern: /cargo error|rustc error/i, type: "rust_error" },
    { pattern: /traceback|exception/i, type: "python_error" },
  ];

  for (const { pattern, type } of errorPatterns) {
    const match = pattern.exec(output);
    if (match) {
      const lines = output.split("\n");
      const errorLine = lines.find((l) => pattern.test(l)) || lines[0];
      return { hasError: true, errorType: type, errorMessage: errorLine.trim() };
    }
  }

  return { hasError: false, errorType: "", errorMessage: "" };
}
