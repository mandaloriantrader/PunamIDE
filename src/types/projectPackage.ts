/**
 * Project Package — The canonical format for AI Workspace Import.
 *
 * PunamIDE only understands this format. It doesn't know or care whether
 * the source was DeepSeek, ChatGPT, Claude, Gemini, or a human.
 *
 * Connectors (external) convert AI output → project.punam
 * PunamIDE (internal) reads project.punam → Workspace Builder → Ready-to-run
 *
 * The value chain:
 *   AI Conversation → Project Package → Workspace Validation → Ready-to-run App
 */

// ─── Core Types ──────────────────────────────────────────────────────────────

export interface ProjectPackage {
  /** Format version for future compatibility */
  version: "1.0";
  /** Project name (used for folder creation) */
  projectName: string;
  /** Optional description */
  description?: string;
  /** Source metadata — informational only, never affects logic */
  source?: PackageSource;
  /** The actual files */
  files: PackageFile[];
  /** Project-level metadata */
  metadata: PackageMetadata;
}

export interface PackageSource {
  /** Which AI/tool generated this — purely informational */
  provider?: string; // "deepseek" | "chatgpt" | "claude" | "gemini" | "manual" | string
  /** Conversation or session name (for history tracking) */
  conversationName?: string;
  /** When this package was generated */
  generatedAt?: string; // ISO 8601
}

export interface PackageFile {
  /** Relative path from project root (e.g., "src/main.rs") */
  path: string;
  /** File content (UTF-8 text) */
  content: string;
  /** Detected language */
  language?: string;
  /** Line count */
  lineCount?: number;
}

export interface PackageMetadata {
  /** Total file count */
  totalFiles: number;
  /** Total lines of code */
  totalLines: number;
  /** Languages present in the project */
  languages: string[];
  /** Suggested entry point (e.g., "src/main.rs") */
  entryPoint?: string;
  /** Suggested build command */
  buildCommand?: string;
  /** Suggested run command */
  runCommand?: string;
  /** Suggested test command */
  testCommand?: string;
}

// ─── Validation ──────────────────────────────────────────────────────────────

export interface ValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

export function validatePackage(pkg: unknown): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!pkg || typeof pkg !== "object") {
    return { valid: false, errors: ["Package is not an object"], warnings: [] };
  }

  const p = pkg as Record<string, unknown>;

  // Required fields
  if (p.version !== "1.0") {
    errors.push(`Unsupported version: ${p.version}. Expected "1.0".`);
  }
  if (!p.projectName || typeof p.projectName !== "string") {
    errors.push("Missing or invalid projectName");
  }
  if (!Array.isArray(p.files) || p.files.length === 0) {
    errors.push("No files in package");
  }

  // Validate files
  if (Array.isArray(p.files)) {
    for (let i = 0; i < p.files.length; i++) {
      const file = p.files[i] as Record<string, unknown>;
      if (!file.path || typeof file.path !== "string") {
        errors.push(`File ${i}: missing path`);
      }
      if (typeof file.content !== "string") {
        errors.push(`File ${i}: missing content`);
      }
      // Security: no path traversal
      if (typeof file.path === "string" && (file.path.includes("..") || file.path.startsWith("/"))) {
        errors.push(`File ${i}: unsafe path "${file.path}"`);
      }
    }
  }

  // Warnings
  if (!p.metadata) {
    warnings.push("No metadata — build/run commands won't be auto-configured");
  }
  if (!p.source) {
    warnings.push("No source info — project history won't be tracked");
  }

  return { valid: errors.length === 0, errors, warnings };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Build a project package from a list of files */
export function createPackage(
  projectName: string,
  files: PackageFile[],
  options?: {
    description?: string;
    source?: PackageSource;
    entryPoint?: string;
    buildCommand?: string;
    runCommand?: string;
  }
): ProjectPackage {
  const languages = [...new Set(files.map((f) => f.language).filter(Boolean))] as string[];
  const totalLines = files.reduce((sum, f) => sum + (f.lineCount || f.content.split("\n").length), 0);

  return {
    version: "1.0",
    projectName,
    description: options?.description,
    source: options?.source,
    files,
    metadata: {
      totalFiles: files.length,
      totalLines,
      languages,
      entryPoint: options?.entryPoint,
      buildCommand: options?.buildCommand,
      runCommand: options?.runCommand,
    },
  };
}

/** Detect build/run commands from file list */
export function detectProjectCommands(files: PackageFile[]): {
  buildCommand?: string;
  runCommand?: string;
  testCommand?: string;
} {
  const paths = files.map((f) => f.path);

  // Rust (Cargo)
  if (paths.includes("Cargo.toml")) {
    return { buildCommand: "cargo build", runCommand: "cargo run", testCommand: "cargo test" };
  }

  // Node.js
  if (paths.includes("package.json")) {
    const pkgFile = files.find((f) => f.path === "package.json");
    if (pkgFile) {
      try {
        const pkg = JSON.parse(pkgFile.content);
        return {
          buildCommand: pkg.scripts?.build ? "npm run build" : undefined,
          runCommand: pkg.scripts?.start ? "npm start" : pkg.scripts?.dev ? "npm run dev" : undefined,
          testCommand: pkg.scripts?.test ? "npm test" : undefined,
        };
      } catch { /* ignore parse error */ }
    }
    return { buildCommand: "npm run build", runCommand: "npm start", testCommand: "npm test" };
  }

  // Python
  if (paths.includes("requirements.txt") || paths.includes("pyproject.toml")) {
    const main = paths.find((p) => p.endsWith("main.py") || p.endsWith("app.py"));
    return {
      buildCommand: "pip install -r requirements.txt",
      runCommand: main ? `python ${main}` : "python main.py",
      testCommand: "pytest",
    };
  }

  // Go
  if (paths.includes("go.mod")) {
    return { buildCommand: "go build ./...", runCommand: "go run .", testCommand: "go test ./..." };
  }

  return {};
}

/** Detect entry point from file list */
export function detectEntryPoint(files: PackageFile[]): string | undefined {
  const paths = files.map((f) => f.path);

  const candidates = [
    "src/main.rs", "src/main.ts", "src/main.tsx", "src/index.ts", "src/index.tsx",
    "src/App.tsx", "src/app.ts", "main.py", "app.py", "main.go", "cmd/main.go",
    "index.js", "index.ts", "src/index.js", "server.js", "server.ts",
  ];

  return candidates.find((c) => paths.includes(c));
}
