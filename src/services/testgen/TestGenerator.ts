/**
 * TestGenerator — AI-Generated Test Generation Pipeline (Tier C, Component 13).
 *
 * Orchestrates the existing AI streaming layer to produce tests for a selected
 * function, then routes the result through the existing diff-preview +
 * RefinementLoop machinery. It does NOT invent a new AI transport or a new diff
 * widget.
 *
 * Pipeline:
 *   detect framework → build prompt → stream generation → parse into test cases
 *   → diff preview (selective accept) → write to conventional path → run →
 *   (on failure) RefinementLoop.
 *
 * Requirements: 13.1, 13.2, 13.3, 13.4, 13.5, 13.6.
 */

import { sendToProviderStreaming } from "../../utils/providers";
import type { AIProviderConfig } from "../../utils/providers";
import { readFile, readDirectory, writeFile, runTerminalCommand, pathExists } from "../../utils/tauri";
import { useFileStore } from "../../store/fileStore";
import { RefinementLoop } from "../agent/RefinementLoop";
import type { ErrorContext } from "../agent/RefinementLoop";

// ─── Types ─────────────────────────────────────────────────────────────────

export type TestFramework = "vitest" | "jest" | "pytest" | "unknown";

export interface DetectedFramework {
  framework: TestFramework;
  /** The config marker that produced the decision, for transparency. */
  source: string; // e.g. "vitest.config.ts", "package.json#jest", "pyproject.toml"
}

export interface GeneratedTestCase {
  id: string;
  title: string; // e.g. "returns 0 for empty input"
  category: "normal" | "edge" | "error";
  code: string; // the individual test block
}

export interface TestGenResult {
  framework: TestFramework;
  imports: string;
  setup: string; // mock setup + beforeEach/afterEach
  cases: GeneratedTestCase[];
  /** Destination path following project conventions. */
  targetPath: string;
}

/**
 * Outcome of writing and executing a generated test file. Returned by
 * `commitAndVerify`. On failure the RefinementLoop is invoked to attempt an
 * automatic correction; `refinementApplied` records whether that happened.
 */
export interface TestRunOutcome {
  /** Final path the test file was written to. */
  targetPath: string;
  /** Whether the test run passed after writing (and any refinement). */
  passed: boolean;
  /** Raw stdout/stderr captured from the test runner. */
  output: string;
  /** Whether the RefinementLoop was invoked because the initial run failed. */
  refinementApplied: boolean;
  /** Number of corrective passes the RefinementLoop used (0 if not invoked). */
  refinementPasses: number;
}

// ─── Framework detection ─────────────────────────────────────────────────────

const VITEST_CONFIG_NAMES = [
  "vitest.config.ts",
  "vitest.config.js",
  "vitest.config.mjs",
];

const JEST_CONFIG_NAMES = [
  "jest.config.ts",
  "jest.config.js",
  "jest.config.cjs",
  "jest.config.json",
];

/** Known conventional test directory names, in preference order. */
const JS_TEST_DIR_CONVENTIONS = ["__tests__", "tests", "test"];
const PY_TEST_DIR_CONVENTIONS = ["tests", "test"];

/**
 * Return the basename (final path segment) of a path using either separator.
 */
function baseName(p: string): string {
  const normalized = p.replace(/\\/g, "/");
  const idx = normalized.lastIndexOf("/");
  return idx === -1 ? normalized : normalized.slice(idx + 1);
}

/**
 * Check whether a package.json's parsed JSON declares a dependency by name in
 * any of the standard dependency maps.
 */
function hasDependency(pkg: unknown, name: string): boolean {
  if (!pkg || typeof pkg !== "object") return false;
  const maps = [
    "dependencies",
    "devDependencies",
    "peerDependencies",
    "optionalDependencies",
  ] as const;
  for (const mapName of maps) {
    const map = (pkg as Record<string, unknown>)[mapName];
    if (map && typeof map === "object" && name in (map as object)) {
      return true;
    }
  }
  return false;
}

/**
 * Detect the project's test framework from a map of config filename → contents.
 *
 * Fixed, deterministic precedence:
 *   1. vitest.config.{ts,js,mjs} present              → vitest
 *   2. package.json declares a "vitest" dependency    → vitest (package.json#vitest)
 *   3. jest.config.{ts,js,cjs,json} present           → jest
 *   4. package.json has a "jest" key or dependency    → jest (package.json#jest)
 *   5. pytest markers (pytest.ini / pyproject.toml
 *      [tool.pytest] / setup.cfg [tool:pytest])       → pytest
 *   6. otherwise                                      → unknown (none)
 *
 * Pure and deterministic given `configFiles`.
 */
export function detectFramework(
  configFiles: Record<string, string>,
): DetectedFramework {
  // 1. Vitest config file present.
  for (const name of VITEST_CONFIG_NAMES) {
    if (name in configFiles) {
      return { framework: "vitest", source: name };
    }
  }

  // Parse package.json once for the dependency-based checks below.
  let pkg: unknown = null;
  if ("package.json" in configFiles) {
    try {
      pkg = JSON.parse(configFiles["package.json"]);
    } catch {
      pkg = null;
    }
  }

  // 2. Vitest declared as a dependency in package.json.
  if (hasDependency(pkg, "vitest")) {
    return { framework: "vitest", source: "package.json#vitest" };
  }

  // 3. Jest config file present.
  for (const name of JEST_CONFIG_NAMES) {
    if (name in configFiles) {
      return { framework: "jest", source: name };
    }
  }

  // 4. Jest config key or dependency in package.json.
  if (pkg && typeof pkg === "object") {
    if ("jest" in (pkg as object) || hasDependency(pkg, "jest")) {
      return { framework: "jest", source: "package.json#jest" };
    }
  }

  // 5. pytest markers.
  if ("pytest.ini" in configFiles) {
    return { framework: "pytest", source: "pytest.ini" };
  }
  if (
    "pyproject.toml" in configFiles &&
    /\[tool\.pytest/.test(configFiles["pyproject.toml"])
  ) {
    return { framework: "pytest", source: "pyproject.toml" };
  }
  if (
    "setup.cfg" in configFiles &&
    /\[tool:pytest\]/.test(configFiles["setup.cfg"])
  ) {
    return { framework: "pytest", source: "setup.cfg" };
  }

  // 6. Nothing matched.
  return { framework: "unknown", source: "none" };
}

// ─── Test path derivation ────────────────────────────────────────────────────

/**
 * Find the first conventional test directory present in `existingDirs`,
 * matching by basename so both bare names ("__tests__") and full paths
 * ("src/__tests__") are honored.
 */
function findConventionDir(
  existingDirs: string[],
  conventions: string[],
): string | null {
  for (const convention of conventions) {
    for (const dir of existingDirs) {
      if (baseName(dir) === convention) {
        return dir;
      }
    }
  }
  return null;
}

/**
 * Join a directory and filename with a single forward slash, tolerating a
 * trailing separator on the directory and an empty directory.
 */
function joinPath(dir: string, fileName: string): string {
  if (!dir) return fileName;
  const normalized = dir.replace(/\\/g, "/").replace(/\/+$/, "");
  return normalized ? `${normalized}/${fileName}` : fileName;
}

/**
 * Derive the conventional test file path for a source file + framework.
 *
 * Naming convention:
 *   - vitest / jest / unknown → `<base>.test.<ext>` mirroring the source
 *     extension (.ts → .test.ts, .tsx → .test.tsx, .js → .test.js, etc.)
 *   - pytest                  → `test_<base>.py`
 *
 * Directory convention: when the project already uses a conventional test
 * directory (`__tests__`, `tests`, `test`), the test file is placed there;
 * otherwise it is co-located next to the source file.
 *
 * Pure and deterministic given the inputs.
 */
export function deriveTestPath(
  sourcePath: string,
  framework: TestFramework,
  existingDirs: string[],
): string {
  const normalized = sourcePath.replace(/\\/g, "/");
  const slashIdx = normalized.lastIndexOf("/");
  const sourceDir = slashIdx === -1 ? "" : normalized.slice(0, slashIdx);
  const fileName = slashIdx === -1 ? normalized : normalized.slice(slashIdx + 1);

  const dotIdx = fileName.lastIndexOf(".");
  const base = dotIdx === -1 ? fileName : fileName.slice(0, dotIdx);
  const ext = dotIdx === -1 ? "" : fileName.slice(dotIdx + 1);

  let testFileName: string;
  let conventions: string[];

  if (framework === "pytest") {
    testFileName = `test_${base}.py`;
    conventions = PY_TEST_DIR_CONVENTIONS;
  } else {
    // vitest / jest / unknown — mirror the source extension, defaulting to ts.
    const testExt = ext || "ts";
    testFileName = `${base}.test.${testExt}`;
    conventions = JS_TEST_DIR_CONVENTIONS;
  }

  const conventionDir = findConventionDir(existingDirs, conventions);
  const targetDir = conventionDir ?? sourceDir;

  return joinPath(targetDir, testFileName);
}

// ─── TestGenerator ───────────────────────────────────────────────────────────

/**
 * Build the test runner command for a given framework and test file path.
 */
function buildRunCommand(framework: TestFramework, testPath: string): string {
  switch (framework) {
    case "vitest":
      return `npx vitest run "${testPath}" --reporter=verbose`;
    case "jest":
      return `npx jest "${testPath}" --no-coverage`;
    case "pytest":
      return `python -m pytest "${testPath}" -v`;
    default:
      // unknown — try node execution as a fallback
      return `node "${testPath}"`;
  }
}

/**
 * Parse the AI's streaming response into structured test case sections.
 *
 * Expected format from the AI:
 * ```
 * // IMPORTS_START
 * import { ... } from '...'
 * // IMPORTS_END
 * // SETUP_START
 * beforeEach(() => { ... })
 * // SETUP_END
 * // CASE id="case-1" title="..." category="normal"
 * it('...', () => { ... })
 * // END_CASE
 * // CASE id="case-2" title="..." category="edge"
 * ...
 * // END_CASE
 * ```
 */
function parseGeneratedTests(raw: string): {
  imports: string;
  setup: string;
  cases: GeneratedTestCase[];
} {
  const text = raw.trim();

  // Extract imports section
  let imports = "";
  const importsMatch = text.match(
    /\/\/\s*IMPORTS_START\s*\n([\s\S]*?)\n\s*\/\/\s*IMPORTS_END/
  );
  if (importsMatch) {
    imports = importsMatch[1].trim();
  }

  // Extract setup section
  let setup = "";
  const setupMatch = text.match(
    /\/\/\s*SETUP_START\s*\n([\s\S]*?)\n\s*\/\/\s*SETUP_END/
  );
  if (setupMatch) {
    setup = setupMatch[1].trim();
  }

  // Extract individual test cases
  const cases: GeneratedTestCase[] = [];
  const caseRegex =
    /\/\/\s*CASE\s+id="([^"]+)"\s+title="([^"]+)"\s+category="([^"]+)"\s*\n([\s\S]*?)\n\s*\/\/\s*END_CASE/g;
  let match: RegExpExecArray | null;
  while ((match = caseRegex.exec(text)) !== null) {
    const [, id, title, category, code] = match;
    const validCategory =
      category === "normal" || category === "edge" || category === "error"
        ? category
        : "normal";
    cases.push({
      id,
      title,
      category: validCategory as GeneratedTestCase["category"],
      code: code.trim(),
    });
  }

  // Fallback: if the structured format wasn't used, try to parse individual
  // test/it blocks as a best-effort extraction.
  if (cases.length === 0 && !importsMatch) {
    return parseFallback(text);
  }

  return { imports, setup, cases };
}

/**
 * Fallback parser: extract test cases from unstructured AI output by splitting
 * on it()/test() blocks and extracting imports from lines at the top.
 */
function parseFallback(text: string): {
  imports: string;
  setup: string;
  cases: GeneratedTestCase[];
} {
  const lines = text.split("\n");

  // Strip markdown code fences if present
  let content = text;
  const fenceMatch = content.match(/^```[a-zA-Z]*\n([\s\S]*?)\n```$/);
  if (fenceMatch) {
    content = fenceMatch[1];
  }

  // Split into imports (anything before the first describe/test/it) and the rest.
  const firstTestIdx = lines.findIndex((l) =>
    /^\s*(describe|it|test)\s*\(/.test(l)
  );

  let imports = "";
  let body = content;
  if (firstTestIdx > 0) {
    imports = lines.slice(0, firstTestIdx).join("\n").trim();
    body = lines.slice(firstTestIdx).join("\n");
  }

  // Extract individual it/test blocks (simple heuristic: match balanced braces)
  const cases: GeneratedTestCase[] = [];
  const testBlockRegex = /(?:it|test)\s*\(\s*(['"`])(.*?)\1/g;
  let blockMatch: RegExpExecArray | null;
  let caseIdx = 0;

  while ((blockMatch = testBlockRegex.exec(body)) !== null) {
    caseIdx++;
    const title = blockMatch[2];
    // Extract the block starting from this match to the next test or end
    const startPos = blockMatch.index;
    const nextMatch = testBlockRegex.exec(body);
    const endPos = nextMatch ? nextMatch.index : body.length;
    // Reset regex position for next iteration
    if (nextMatch) {
      testBlockRegex.lastIndex = nextMatch.index;
    }
    const code = body.slice(startPos, endPos).trim();

    // Infer category from title keywords
    let category: GeneratedTestCase["category"] = "normal";
    if (/error|throw|fail|invalid|reject/i.test(title)) {
      category = "error";
    } else if (/edge|boundary|empty|null|undefined|zero|max|min/i.test(title)) {
      category = "edge";
    }

    cases.push({
      id: `case-${caseIdx}`,
      title,
      category,
      code,
    });
  }

  return { imports, setup: "", cases };
}

export class TestGenerator {
  private readonly provider: AIProviderConfig;
  private readonly model: string;

  constructor(provider: AIProviderConfig, model: string) {
    this.provider = provider;
    this.model = model;
  }

  /** Detect framework from config files with deterministic precedence. Pure given the file set. */
  detectFramework(configFiles: Record<string, string>): DetectedFramework {
    return detectFramework(configFiles);
  }

  /** Derive the conventional test file path for a source file + framework. Pure. */
  deriveTestPath(
    sourcePath: string,
    framework: TestFramework,
    existingDirs: string[],
  ): string {
    return deriveTestPath(sourcePath, framework, existingDirs);
  }

  /**
   * Stream test generation via the existing AI provider.
   *
   * 1. Reads project root config files to detect the test framework
   * 2. Derives the target test path using project conventions
   * 3. Streams generation via `sendToProviderStreaming`
   * 4. Parses the response into structured imports, setup, and categorized cases
   */
  async generate(source: {
    filePath: string;
    functionCode: string;
  }): Promise<TestGenResult> {
    const projectPath = useFileStore.getState().projectPath;
    if (!projectPath) {
      throw new Error("TestGenerator: no project path set — open a folder first.");
    }

    // 1. Gather config files for framework detection
    const configFiles = await this.gatherConfigFiles(projectPath);
    const { framework } = this.detectFramework(configFiles);

    // 2. Gather existing directories for test path derivation
    const existingDirs = await this.gatherExistingDirs(projectPath);
    const targetPath = this.deriveTestPath(source.filePath, framework, existingDirs);

    // 3. Build prompts
    const systemPrompt = this.buildSystemPrompt(framework);
    const userPrompt = this.buildUserPrompt(source.filePath, source.functionCode, framework);

    // 4. Stream generation
    const response = await sendToProviderStreaming(this.provider, this.model, {
      systemPrompt,
      userPrompt,
      temperature: 0.3,
    });

    if (!response.success) {
      throw new Error(
        `TestGenerator: generation failed — ${response.error ?? "unknown error"}`
      );
    }

    // 5. Parse the response
    const { imports, setup, cases } = parseGeneratedTests(response.text);

    return {
      framework,
      imports,
      setup,
      cases,
      targetPath,
    };
  }

  /**
   * Assemble the final file content from the accepted subset of cases only.
   * Pure: output contains exactly the accepted case bodies, plus imports + setup.
   * Skip cases whose id is not in `acceptedCaseIds`.
   * Always include shared imports + setup even if only 1 case accepted.
   */
  assembleAcceptedFile(
    result: TestGenResult,
    acceptedCaseIds: Set<string>,
  ): string {
    const parts: string[] = [];

    // Always include imports
    if (result.imports.trim()) {
      parts.push(result.imports.trim());
    }

    // Always include setup if non-empty
    if (result.setup.trim()) {
      parts.push(result.setup.trim());
    }

    // Include only accepted case bodies, preserving original order
    for (const testCase of result.cases) {
      if (acceptedCaseIds.has(testCase.id)) {
        parts.push(testCase.code);
      }
    }

    return parts.join("\n\n") + "\n";
  }

  /**
   * Write the assembled test file to disk, run it, and on failure invoke the
   * existing RefinementLoop for automatic correction.
   */
  async commitAndVerify(
    result: TestGenResult,
    acceptedCaseIds: Set<string>,
  ): Promise<TestRunOutcome> {
    const projectPath = useFileStore.getState().projectPath;
    if (!projectPath) {
      throw new Error("TestGenerator: no project path set.");
    }

    // 1. Assemble the final file content
    const content = this.assembleAcceptedFile(result, acceptedCaseIds);
    const targetPath = result.targetPath;

    // 2. Write the file to disk
    await writeFile(targetPath, content);

    // 3. Run the test file
    const runCmd = buildRunCommand(result.framework, targetPath);
    const cmdResult = await runTerminalCommand(runCmd, projectPath);
    const output = (cmdResult.stdout + "\n" + cmdResult.stderr).trim();
    const passed = cmdResult.exit_code === 0;

    // 4. If passed, return success
    if (passed) {
      return {
        targetPath,
        passed: true,
        output,
        refinementApplied: false,
        refinementPasses: 0,
      };
    }

    // 5. On failure, invoke the RefinementLoop for auto-correction
    const refinementLoop = new RefinementLoop({ maxRetries: 3 });

    // Build a URI for the file (file:// protocol for LSP)
    const fileUri = `file:///${targetPath.replace(/\\/g, "/").replace(/^\//, "")}`;

    // Read the file content back (it was just written)
    const currentContent = content;

    // Use the AI to attempt fixes via the RefinementLoop pattern
    const refinementResult = await refinementLoop.runAfterEdit({
      filePath: targetPath,
      fileUri,
      languageId: this.inferLanguageId(targetPath),
      preEditContent: "", // No pre-edit content — this is a new file
      postEditContent: currentContent,
      preEditDiagnostics: [], // No prior diagnostics for a new file
      requestAiFix: async (context: ErrorContext) => {
        return this.requestTestFix(context, result.framework, output);
      },
    });

    // If refinement succeeded, re-run to confirm
    let finalPassed = refinementResult.success;
    let finalOutput = output;
    let refinementPasses = refinementResult.passesUsed;

    if (refinementResult.success && refinementResult.passesUsed > 0) {
      // Re-run the test to confirm the fix
      const rerunResult = await runTerminalCommand(runCmd, projectPath);
      finalOutput = (rerunResult.stdout + "\n" + rerunResult.stderr).trim();
      finalPassed = rerunResult.exit_code === 0;
    }

    return {
      targetPath,
      passed: finalPassed,
      output: finalOutput,
      refinementApplied: refinementResult.passesUsed > 0,
      refinementPasses,
    };
  }

  // ── Internal helpers ─────────────────────────────────────────────────────────

  /**
   * Gather relevant config files from the project root for framework detection.
   */
  private async gatherConfigFiles(
    projectPath: string
  ): Promise<Record<string, string>> {
    const configFiles: Record<string, string> = {};
    const targetFiles = [
      "vitest.config.ts",
      "vitest.config.js",
      "vitest.config.mjs",
      "jest.config.ts",
      "jest.config.js",
      "jest.config.cjs",
      "jest.config.json",
      "package.json",
      "pytest.ini",
      "pyproject.toml",
      "setup.cfg",
    ];

    for (const fileName of targetFiles) {
      const filePath = `${projectPath.replace(/\\/g, "/")}/${fileName}`;
      try {
        const exists = await pathExists(filePath);
        if (exists) {
          const content = await readFile(filePath);
          configFiles[fileName] = content;
        }
      } catch {
        // File doesn't exist or isn't readable — skip
      }
    }

    return configFiles;
  }

  /**
   * Gather existing directory names from the project root for test path derivation.
   */
  private async gatherExistingDirs(projectPath: string): Promise<string[]> {
    try {
      const entries = await readDirectory(projectPath);
      return entries.filter((e) => e.is_dir).map((e) => e.name);
    } catch {
      return [];
    }
  }

  /**
   * Build the system prompt for test generation, tailored to the detected framework.
   */
  private buildSystemPrompt(framework: TestFramework): string {
    const frameworkGuidance: Record<TestFramework, string> = {
      vitest:
        "Use Vitest syntax: import { describe, it, expect } from 'vitest'. Use describe/it blocks.",
      jest:
        "Use Jest syntax: describe/it/expect are globals. Use describe/it blocks.",
      pytest:
        "Use pytest syntax: def test_xxx functions, use assert statements, fixtures for setup.",
      unknown:
        "Write tests using a generic JavaScript/TypeScript testing pattern with describe/it/expect.",
    };

    return [
      "You are a test generation engine embedded in an IDE.",
      `Generate tests using the ${framework} framework.`,
      frameworkGuidance[framework],
      "",
      "Output your response in the following EXACT structured format:",
      "",
      "// IMPORTS_START",
      "<all import statements here>",
      "// IMPORTS_END",
      "// SETUP_START",
      "<any beforeEach/afterEach/mock setup here, or leave empty>",
      "// SETUP_END",
      "// CASE id=\"case-1\" title=\"<descriptive test title>\" category=\"normal\"",
      "<the full test block for this case>",
      "// END_CASE",
      "// CASE id=\"case-2\" title=\"<descriptive test title>\" category=\"edge\"",
      "<the full test block for this case>",
      "// END_CASE",
      "",
      "Categories: normal (happy path), edge (boundary/empty/null), error (throw/reject/fail).",
      "Generate 3-6 test cases covering normal, edge, and error scenarios.",
      "Each case must be a complete, runnable test block (it/test/def test_).",
      "Do NOT include markdown code fences. Output raw code only.",
    ].join("\n");
  }

  /**
   * Build the user prompt with the source code to test.
   */
  private buildUserPrompt(
    filePath: string,
    functionCode: string,
    framework: TestFramework
  ): string {
    return [
      `File: ${filePath}`,
      `Framework: ${framework}`,
      "",
      "Function to test:",
      "```",
      functionCode,
      "```",
      "",
      "Generate comprehensive tests for this function now:",
    ].join("\n");
  }

  /**
   * Infer the language ID from a file path for the RefinementLoop.
   */
  private inferLanguageId(filePath: string): string {
    const normalized = filePath.replace(/\\/g, "/");
    if (normalized.endsWith(".ts") || normalized.endsWith(".tsx")) return "typescript";
    if (normalized.endsWith(".js") || normalized.endsWith(".jsx")) return "javascript";
    if (normalized.endsWith(".py")) return "python";
    return "typescript";
  }

  /**
   * Request an AI fix for a failing test file via the RefinementLoop callback.
   * Uses the same streaming provider to generate corrected content.
   */
  private async requestTestFix(
    context: ErrorContext,
    framework: TestFramework,
    testOutput: string
  ): Promise<string | null> {
    const systemPrompt = [
      "You are a test-fixing assistant. A generated test file has errors.",
      "Fix the test code so it compiles and passes correctly.",
      "Return ONLY the complete corrected file content — no explanations, no markdown fences.",
    ].join("\n");

    const errorSummary = context.errors
      .map((e) => `Line ${e.startLine}: ${e.message}`)
      .join("\n");

    const previousAttemptSummary =
      context.previousAttempts.length > 0
        ? `\nPrevious fix attempts failed. Errors from last attempt:\n${context.previousAttempts[context.previousAttempts.length - 1].resultingErrors.map((e) => e.message).join("\n")}`
        : "";

    const userPrompt = [
      `Framework: ${framework}`,
      "",
      "Current test file content:",
      "```",
      context.currentContent,
      "```",
      "",
      "Errors/diagnostics:",
      errorSummary,
      "",
      "Test runner output:",
      testOutput,
      previousAttemptSummary,
      "",
      "Produce the corrected file content now:",
    ].join("\n");

    const response = await sendToProviderStreaming(this.provider, this.model, {
      systemPrompt,
      userPrompt,
      temperature: 0.1,
    });

    if (!response.success || !response.text.trim()) {
      return null;
    }

    // Strip any markdown fences the model may have added
    let fixed = response.text.trim();
    const fenceMatch = fixed.match(/^```[a-zA-Z]*\n([\s\S]*?)\n```$/);
    if (fenceMatch) {
      fixed = fenceMatch[1].trim();
    }

    // Write the fixed content to disk so the RefinementLoop can re-check
    await writeFile(context.filePath, fixed);

    return fixed;
  }
}
