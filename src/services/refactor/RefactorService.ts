/**
 * RefactorService — Orchestrates one-click refactoring operations.
 *
 * Exposes three refactoring flavours — Rename, Extract Function, Move File —
 * each producing a `RefactorChangeSet`. The service handles validation,
 * selection analysis (for Extract Function), change-set computation, preview
 * building, apply (with snapshot guard), and rollback.
 *
 * This module defines the shared types and implements the validation +
 * selection-analysis layer, as well as the change-set computation and
 * preview building layer.
 *
 * @see Requirements 12.1, 12.2, 12.3, 12.4, 12.8, 12.9
 * @see Design — Tier C, Component 12
 */

import { invoke } from "@tauri-apps/api/core";
import type { DiffHunk } from "../agent/differ";
import { diffStrings } from "../agent/differ";
import { uriToFilePath } from "../lsp/monacoLspBridge";
import { readFile, writeFile, deletePath, pathExists, getProjectIndex } from "../../utils/tauri";
import { useFileStore } from "../../store/fileStore";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** The three supported refactoring operations. */
export type RefactorKind = "rename" | "extract_function" | "move_file";

/** A single file edit produced by a refactoring operation. */
export interface FileEdit {
  filePath: string;
  /** Full new content for the file after this operation. */
  newContent: string;
  /** Number of discrete changes (hunks) within this file. */
  changeCount: number;
  /** Removes the file after the preview is confirmed (used by Move File). */
  delete?: boolean;
}

/** The complete set of edits produced by one refactoring operation. */
export interface RefactorChangeSet {
  kind: RefactorKind;
  edits: FileEdit[];
  /** Pre-operation content keyed by file path, used to build the preview + snapshot. */
  originalContent: Record<string, string>;
}

/** A preview of a refactoring operation, shown before the user confirms. */
export interface RefactorPreview {
  changeSet: RefactorChangeSet;
  /** Per-file inline diff produced via the `diff_strings` Tauri command. */
  diffs: Array<{ filePath: string; changeCount: number; diff: DiffHunk[] }>;
  totalFiles: number;
  totalChanges: number;
}

/** Position within a file (line and character are 0-based). */
export interface Position {
  line: number;
  character: number;
}

/** A merge conflict detected during apply (file content was externally modified). */
export interface MergeConflict {
  /** The file path where the conflict was detected. */
  filePath: string;
  /** The content we expected on disk (original snapshot). */
  expectedContent: string;
  /** The actual content found on disk (externally modified). */
  actualContent: string;
  /** The new content we attempted to write. */
  intendedContent: string;
}

/** Structured error thrown when a refactoring operation fails during apply. */
export class RefactorError extends Error {
  /** The snapshot ID that was used for rollback (if available). */
  readonly snapshotId?: string;
  /** The underlying cause of the failure. */
  readonly cause?: unknown;
  /** The files that were affected and restored. */
  readonly affectedFiles: string[];

  constructor(message: string, options?: { snapshotId?: string; cause?: unknown; affectedFiles?: string[] }) {
    super(message);
    this.name = "RefactorError";
    this.snapshotId = options?.snapshotId;
    this.cause = options?.cause;
    this.affectedFiles = options?.affectedFiles ?? [];
  }
}

/** Result from the Tauri `create_snapshot` command. */
interface CreateSnapshotResult {
  success: boolean;
  snapshotId: string;
  files: number;
  sizeMB: number;
}

/** Parameters for a Rename refactoring. */
export interface RenameParams {
  filePath: string;
  line: number;
  character: number;
  newName: string;
}

/** Parameters for an Extract Function refactoring. */
export interface ExtractParams {
  filePath: string;
  selectionStart: Position;
  selectionEnd: Position;
  functionName: string;
}

/** Parameters for a Move File refactoring. */
export interface MoveParams {
  sourcePath: string;
  destinationPath: string;
}

/** Result of a validation check. */
export interface ValidationResult {
  ok: boolean;
  message?: string;
}

// ---------------------------------------------------------------------------
// Keyword sets used by the selection analyzer
// ---------------------------------------------------------------------------

/** Keywords that declare a new binding (variable/function/class/parameter). */
const DECLARATION_KEYWORDS = new Set([
  "let",
  "const",
  "var",
  "function",
  "class",
  "def",
  "for",
  "import",
]);

/** Assignment operators that indicate a value is being produced. */
const ASSIGNMENT_OPS = new Set(["=", "+=", "-=", "*=", "/=", "%=", "**="]);

/** Language keywords that should never be treated as identifiers. */
const LANGUAGE_KEYWORDS = new Set([
  "let",
  "const",
  "var",
  "function",
  "class",
  "def",
  "for",
  "import",
  "if",
  "else",
  "while",
  "do",
  "switch",
  "case",
  "break",
  "continue",
  "return",
  "throw",
  "try",
  "catch",
  "finally",
  "new",
  "delete",
  "typeof",
  "instanceof",
  "void",
  "in",
  "of",
  "this",
  "super",
  "true",
  "false",
  "null",
  "undefined",
  "async",
  "await",
  "yield",
  "export",
  "default",
  "from",
  "as",
  "extends",
  "implements",
  "interface",
  "type",
  "enum",
  "namespace",
  "module",
  "declare",
  "abstract",
  "private",
  "protected",
  "public",
  "static",
  "readonly",
  "override",
  "with",
  "debugger",
]);

// ---------------------------------------------------------------------------
// RefactorService
// ---------------------------------------------------------------------------

export class RefactorService {
  // ─── Validation ──────────────────────────────────────────────────────────────

  /**
   * Validate a rename operation.
   *
   * Rejects:
   *  - Empty or whitespace-only new names
   *  - Names that collide with an existing in-scope symbol
   *
   * @see Requirement 12.8
   */
  validateRename(params: RenameParams, inScopeSymbols: string[]): ValidationResult {
    const trimmed = params.newName.trim();

    if (trimmed.length === 0) {
      return { ok: false, message: "New name cannot be empty or whitespace-only." };
    }

    if (inScopeSymbols.includes(trimmed)) {
      return {
        ok: false,
        message: `"${trimmed}" conflicts with an existing symbol in the same scope.`,
      };
    }

    return { ok: true };
  }

  /**
   * Validate a selection for the Extract Function operation.
   *
   * Rejects empty or whitespace-only selections with a guidance message.
   *
   * @see Requirement 12.9
   */
  validateExtractSelection(selectionText: string): ValidationResult {
    if (!selectionText || selectionText.trim().length === 0) {
      return {
        ok: false,
        message:
          "A valid code selection of at least 1 complete statement is required to extract a function.",
      };
    }

    return { ok: true };
  }

  // ─── Selection Analysis ──────────────────────────────────────────────────────

  /**
   * Analyze a code selection to infer parameters and return values for
   * Extract Function.
   *
   * Tokenizes the selection and classifies identifiers:
   *  - **bound**: declared inside the selection (let/const/var/def/parameters/loop vars)
   *  - **free**: referenced inside but declared outside → become parameters (source order)
   *  - **produced**: assigned inside and potentially read after → become return values
   *
   * @see Requirement 12.2 (infer parameters from referenced external variables)
   */
  analyzeSelection(selectionText: string): { params: string[]; returns: string[] } {
    const tokens = tokenize(selectionText);

    const bound = new Set<string>();
    const free: string[] = [];
    const freeSet = new Set<string>();
    const produced: string[] = [];
    const producedSet = new Set<string>();

    for (let i = 0; i < tokens.length; i++) {
      const token = tokens[i];

      // Skip non-identifier tokens
      if (!isIdentifier(token)) continue;

      // Skip language keywords — they are never free variables or parameters
      if (LANGUAGE_KEYWORDS.has(token)) continue;

      // Check if this identifier is being declared
      const prev = findPrevNonWhitespaceToken(tokens, i);
      if (prev !== null && DECLARATION_KEYWORDS.has(prev)) {
        bound.add(token);
        continue;
      }

      // Check if this is a destructuring target in a for..of/for..in pattern:
      // already covered by "for" keyword above for `for (const x ...)`

      // Check if this identifier is being assigned to (produced)
      const next = findNextNonWhitespaceToken(tokens, i);
      if (next !== null && ASSIGNMENT_OPS.has(next)) {
        // If already bound inside the selection, it's not "produced" externally
        if (!bound.has(token)) {
          bound.add(token);
          if (!producedSet.has(token)) {
            produced.push(token);
            producedSet.add(token);
          }
        } else {
          // Re-assignment of an already-bound variable — still produced
          if (!producedSet.has(token)) {
            produced.push(token);
            producedSet.add(token);
          }
        }
        continue;
      }

      // If referenced but not bound → free (parameter)
      if (!bound.has(token) && !freeSet.has(token)) {
        free.push(token);
        freeSet.add(token);
      }
    }

    return { params: free, returns: produced };
  }

  // ─── Change-Set Computation ────────────────────────────────────────────────

  /**
   * Compute a rename change set by delegating to the LSP `textDocument/rename`.
   *
   * Invokes the Tauri `lsp_rename` command (which mirrors `lsp_references`
   * using `send_lsp_request_await` under the hood). The returned
   * `WorkspaceEdit` is mapped into a `RefactorChangeSet` with per-file
   * full new content and the original content captured for diffing.
   *
   * @see Requirement 12.1
   */
  async computeRename(params: RenameParams): Promise<RefactorChangeSet> {
    const { filePath, line, character, newName } = params;
    // Send the textDocument/rename LSP request via Tauri
    const workspaceEdit = await invoke<WorkspaceEdit | null>("lsp_rename", {
      filePath,
      line,
      character: character,
      newName,
    });

    if (!workspaceEdit || !workspaceEdit.changes) {
      // If no edit returned, produce an empty change set
      return { kind: "rename", edits: [], originalContent: {} };
    }

    // Convert WorkspaceEdit.changes (uri → TextEdit[]) into FileEdit[]
    const originalContent: Record<string, string> = {};
    const edits: FileEdit[] = [];

    for (const [uri, textEdits] of Object.entries(workspaceEdit.changes)) {
      const editFilePath = uriToFilePath(uri);

      // Read original content
      const original = await readFile(editFilePath);
      originalContent[editFilePath] = original;

      // Apply text edits to produce new content
      const newContent = applyTextEdits(original, textEdits);
      edits.push({
        filePath: editFilePath,
        newContent,
        changeCount: textEdits.length,
      });
    }

    return { kind: "rename", edits, originalContent };
  }

  /**
   * Compute an Extract Function change set.
   *
   * Uses `analyzeSelection()` to determine free variables (parameters) and
   * produced values (returns), then generates a function stub and replaces
   * the selection with a call expression.
   *
   * @see Requirement 12.2
   */
  async computeExtract(params: ExtractParams): Promise<RefactorChangeSet> {
    const { filePath, selectionStart, selectionEnd, functionName } = params;

    // Read the file
    const original = await readFile(filePath);
    const lines = original.split("\n");

    // Extract the selected text
    const selectionText = extractSelection(lines, selectionStart, selectionEnd);

    // Analyze to get params and returns
    const { params: funcParams, returns: funcReturns } = this.analyzeSelection(selectionText);

    // Build the function stub
    const returnType = funcReturns.length === 0
      ? "void"
      : funcReturns.length === 1
        ? "typeof " + funcReturns[0]
        : `[${funcReturns.map((r) => "typeof " + r).join(", ")}]`;

    const returnStatement = funcReturns.length === 0
      ? ""
      : funcReturns.length === 1
        ? `\n  return ${funcReturns[0]};`
        : `\n  return [${funcReturns.join(", ")}];`;

    const paramList = funcParams.join(", ");
    const indentedSelection = selectionText
      .split("\n")
      .map((l) => "  " + l)
      .join("\n");

    const functionStub = `function ${functionName}(${paramList}): ${returnType} {\n${indentedSelection}${returnStatement}\n}`;

    // Build the call expression to replace the selection
    const argList = funcParams.join(", ");
    let callExpression: string;
    if (funcReturns.length === 0) {
      callExpression = `${functionName}(${argList});`;
    } else if (funcReturns.length === 1) {
      callExpression = `const ${funcReturns[0]} = ${functionName}(${argList});`;
    } else {
      callExpression = `const [${funcReturns.join(", ")}] = ${functionName}(${argList});`;
    }

    // Produce the new content: replace the selection with the call, append the function stub
    const newContent = replaceSelection(lines, selectionStart, selectionEnd, callExpression)
      + "\n\n" + functionStub + "\n";

    const changeCount = 2; // replacement + insertion

    return {
      kind: "extract_function",
      edits: [{ filePath, newContent, changeCount }],
      originalContent: { [filePath]: original },
    };
  }

  /**
   * Compute a Move File change set.
   *
   * Relocates the file and rewrites import specifiers in every workspace file
   * that resolved to the old path, leaving non-referencing imports unchanged.
   *
   * @see Requirement 12.3
   */
  async computeMove(params: MoveParams): Promise<RefactorChangeSet> {
    const { sourcePath, destinationPath } = params;

    // Read source file content
    const sourceContent = await readFile(sourcePath);
    const originalContent: Record<string, string> = {};
    const edits: FileEdit[] = [];

    // The moved file itself
    originalContent[sourcePath] = sourceContent;
    edits.push({
      filePath: destinationPath,
      newContent: sourceContent,
      changeCount: 1,
    });
    // A move must remove its source — otherwise it is merely a copy.
    edits.push({
      filePath: sourcePath,
      newContent: "",
      changeCount: 1,
      delete: true,
    });

    // Get all workspace files to scan for import references
    const projectIndex = await getProjectIndex();
    const sourceFiles = projectIndex.filter(
      (entry) =>
        !entry.is_binary &&
        /\.(ts|tsx|js|jsx|mjs|cjs)$/.test(entry.path) &&
        entry.path !== sourcePath
    );

    // Normalize paths for comparison
    const normalizedSource = normalizePath(sourcePath);
    // Strip extension for import matching
    const sourceWithoutExt = stripExtension(normalizedSource);

    for (const entry of sourceFiles) {
      let content: string;
      try {
        content = await readFile(entry.path);
      } catch {
        continue;
      }

      // Check if this file has imports referencing the moved file
      const updatedContent = rewriteImports(
        content,
        entry.path,
        normalizedSource,
        sourceWithoutExt,
        normalizePath(destinationPath)
      );

      if (updatedContent !== content) {
        originalContent[entry.path] = content;
        const changeCount = countImportChanges(content, updatedContent);
        edits.push({
          filePath: entry.path,
          newContent: updatedContent,
          changeCount,
        });
      }
    }

    return { kind: "move_file", edits, originalContent };
  }

  /**
   * Build a preview of a change set using the `diff_strings` Tauri command.
   *
   * Produces per-file inline diffs with `totalFiles` and `totalChanges`.
   * NEVER mutates the filesystem.
   *
   * @see Requirement 12.4
   */
  async buildPreview(changeSet: RefactorChangeSet): Promise<RefactorPreview> {
    const diffs: Array<{ filePath: string; changeCount: number; diff: DiffHunk[] }> = [];
    let totalChanges = 0;

    for (const edit of changeSet.edits) {
      const original = changeSet.originalContent[edit.filePath] ?? "";
      const diffResult = await diffStrings(original, edit.newContent);

      diffs.push({
        filePath: edit.filePath,
        changeCount: edit.changeCount,
        diff: diffResult.hunks,
      });

      totalChanges += edit.changeCount;
    }

    return {
      changeSet,
      diffs,
      totalFiles: changeSet.edits.length,
      totalChanges,
    };
  }

  // ─── Apply & Rollback ────────────────────────────────────────────────────────

  /**
   * Apply a confirmed change set with snapshot-guarded safety:
   *  1. create_snapshot(affectedFiles) → snapshotId
   *  2. write each FileEdit to disk
   *  3. on conflict → invoke onConflict callback to open 3-way merge panel
   *  4. on failure → restore_snapshot(snapshotId) + throw RefactorError
   *
   * Returns the snapshotId so the caller can offer single-action rollback.
   *
   * @see Requirements 12.5, 12.6, 12.7
   */
  async apply(
    changeSet: RefactorChangeSet,
    onConflict: (c: MergeConflict[]) => void
  ): Promise<{ snapshotId: string }> {
    // Edge case: empty change set is a no-op
    if (changeSet.edits.length === 0) {
      return { snapshotId: "" };
    }

    const projectPath = useFileStore.getState().projectPath;
    if (!projectPath) {
      throw new RefactorError("No project path set — open a folder first.", {
        affectedFiles: [],
      });
    }

    // 1. Create a restorable snapshot before applying any changes
    let snapshotId: string;
    try {
      const result = await invoke<CreateSnapshotResult>("create_snapshot", {
        projectRoot: projectPath,
        name: `pre-refactor-${changeSet.kind}-${Date.now()}`,
        reason: "before-refactoring",
      });
      snapshotId = result.snapshotId;
    } catch (err) {
      throw new RefactorError(
        `Failed to create safety snapshot: ${err instanceof Error ? err.message : String(err)}`,
        { cause: err, affectedFiles: changeSet.edits.map((e) => e.filePath) }
      );
    }

    // 2. Write each FileEdit to disk, detecting conflicts
    const conflicts: MergeConflict[] = [];
    const affectedFiles = changeSet.edits.map((e) => e.filePath);

    try {
      for (const edit of changeSet.edits) {
        // Before writing, check if the file was externally modified since preview
        const expectedOriginal = changeSet.originalContent[edit.filePath];
        if (expectedOriginal !== undefined) {
          let currentContent: string;
          try {
            currentContent = await readFile(edit.filePath);
          } catch {
            // File may not exist yet (new file from move operation) — proceed with write
            currentContent = expectedOriginal;
          }

          // Conflict detection: if file on disk differs from what we captured
          if (currentContent !== expectedOriginal) {
            conflicts.push({
              filePath: edit.filePath,
              expectedContent: expectedOriginal,
              actualContent: currentContent,
              intendedContent: edit.newContent,
            });
            continue; // Skip writing this file — it has a conflict
          }
        }

        if (edit.delete) {
          await deletePath(edit.filePath);
          if (await pathExists(edit.filePath)) {
            throw new Error(`Could not remove ${edit.filePath}`);
          }
          continue;
        }

        // Write the file and verify it was persisted.
        await writeFile(edit.filePath, edit.newContent);
        const written = await readFile(edit.filePath);
        if (written !== edit.newContent) {
          conflicts.push({
            filePath: edit.filePath,
            expectedContent: changeSet.originalContent[edit.filePath] ?? "",
            actualContent: written,
            intendedContent: edit.newContent,
          });
        }
      }
    } catch (err) {
      // 4. On failure → restore snapshot and throw
      await this.restoreSnapshotSafe(projectPath, snapshotId);
      throw new RefactorError(
        `Refactoring failed during file write: ${err instanceof Error ? err.message : String(err)}`,
        { snapshotId, cause: err, affectedFiles }
      );
    }

    // 3. If conflicts were detected, rollback and notify via callback
    if (conflicts.length > 0) {
      await this.restoreSnapshotSafe(projectPath, snapshotId);
      onConflict(conflicts);
      throw new RefactorError(
        `Merge conflicts detected in ${conflicts.length} file(s). Changes have been rolled back.`,
        { snapshotId, affectedFiles: conflicts.map((c) => c.filePath) }
      );
    }

    return { snapshotId };
  }

  /**
   * Single-action rollback via the existing snapshot system.
   * Reverts all affected files to their pre-operation state.
   *
   * @see Requirements 12.5, 12.7
   */
  async rollback(snapshotId: string): Promise<void> {
    if (!snapshotId) {
      throw new RefactorError("Cannot rollback: no snapshot ID provided.", {
        affectedFiles: [],
      });
    }

    const projectPath = useFileStore.getState().projectPath;
    if (!projectPath) {
      throw new RefactorError("No project path set — open a folder first.", {
        affectedFiles: [],
      });
    }

    try {
      await invoke<boolean>("restore_snapshot", {
        projectRoot: projectPath,
        snapshotId,
      });
    } catch (err) {
      throw new RefactorError(
        `Rollback failed: ${err instanceof Error ? err.message : String(err)}`,
        { snapshotId, cause: err, affectedFiles: [] }
      );
    }
  }

  // ─── Private helpers ─────────────────────────────────────────────────────────

  /**
   * Attempt to restore a snapshot, swallowing errors (best-effort recovery).
   * Used internally during failure paths where we're already handling an error.
   */
  private async restoreSnapshotSafe(projectPath: string, snapshotId: string): Promise<void> {
    try {
      await invoke<boolean>("restore_snapshot", {
        projectRoot: projectPath,
        snapshotId,
      });
    } catch (restoreErr) {
      console.error("[RefactorService] Failed to restore snapshot during error recovery:", restoreErr);
    }
  }
}

// ---------------------------------------------------------------------------
// LSP WorkspaceEdit types (used for rename response parsing)
// ---------------------------------------------------------------------------

/** A single text edit from the LSP protocol. */
interface TextEdit {
  range: {
    start: { line: number; character: number };
    end: { line: number; character: number };
  };
  newText: string;
}

/** The LSP WorkspaceEdit response from textDocument/rename. */
interface WorkspaceEdit {
  changes?: Record<string, TextEdit[]>;
}

// ---------------------------------------------------------------------------
// Internal helpers — text edit application
// ---------------------------------------------------------------------------

/**
 * Apply an array of LSP TextEdits to a document string.
 * Edits are applied in reverse order (bottom-to-top) to preserve positions.
 */
function applyTextEdits(content: string, textEdits: TextEdit[]): string {
  const lines = content.split("\n");

  // Sort edits bottom-to-top, right-to-left to preserve positions
  const sorted = [...textEdits].sort((a, b) => {
    if (a.range.start.line !== b.range.start.line) {
      return b.range.start.line - a.range.start.line;
    }
    return b.range.start.character - a.range.start.character;
  });

  for (const edit of sorted) {
    const startLine = edit.range.start.line;
    const startChar = edit.range.start.character;
    const endLine = edit.range.end.line;
    const endChar = edit.range.end.character;

    // Get the text before and after the edit range
    const prefix = lines[startLine]?.substring(0, startChar) ?? "";
    const suffix = lines[endLine]?.substring(endChar) ?? "";

    // Build new lines from the edit
    const newLines = (prefix + edit.newText + suffix).split("\n");

    // Replace the affected lines
    lines.splice(startLine, endLine - startLine + 1, ...newLines);
  }

  return lines.join("\n");
}

/**
 * Extract text content from a selection range within file lines.
 */
function extractSelection(lines: string[], start: Position, end: Position): string {
  if (start.line === end.line) {
    return lines[start.line]?.substring(start.character, end.character) ?? "";
  }

  const result: string[] = [];
  result.push(lines[start.line]?.substring(start.character) ?? "");
  for (let i = start.line + 1; i < end.line; i++) {
    result.push(lines[i] ?? "");
  }
  result.push(lines[end.line]?.substring(0, end.character) ?? "");
  return result.join("\n");
}

/**
 * Replace a selection range with new text and return the full new file content.
 */
function replaceSelection(
  lines: string[],
  start: Position,
  end: Position,
  replacement: string
): string {
  const before = lines.slice(0, start.line);
  const prefix = lines[start.line]?.substring(0, start.character) ?? "";
  const suffix = lines[end.line]?.substring(end.character) ?? "";
  const after = lines.slice(end.line + 1);

  return [...before, prefix + replacement + suffix, ...after].join("\n");
}

// ---------------------------------------------------------------------------
// Internal helpers — path and import rewriting for Move File
// ---------------------------------------------------------------------------

/** Normalize a file path to forward slashes. */
function normalizePath(p: string): string {
  return p.replace(/\\/g, "/");
}

/** Strip known JS/TS extensions from a file path. */
function stripExtension(p: string): string {
  return p.replace(/\.(tsx?|jsx?|mjs|cjs)$/, "");
}

/**
 * Compute a relative import path from `fromFile` to `toFile`.
 * Both paths should be normalized (forward slashes).
 */
function computeRelativeImport(fromFile: string, toFile: string): string {
  const fromDir = fromFile.substring(0, fromFile.lastIndexOf("/"));
  const toWithoutExt = stripExtension(toFile);

  // Compute relative path
  const fromParts = fromDir.split("/");
  const toParts = toWithoutExt.split("/");

  // Find common prefix length
  let common = 0;
  while (
    common < fromParts.length &&
    common < toParts.length &&
    fromParts[common] === toParts[common]
  ) {
    common++;
  }

  const upCount = fromParts.length - common;
  const downParts = toParts.slice(common);

  const prefix = upCount === 0 ? "./" : "../".repeat(upCount);
  return prefix + downParts.join("/");
}

/**
 * Rewrite import specifiers in a file that reference the old source path.
 * Returns the updated content (or unchanged content if no imports match).
 */
function rewriteImports(
  content: string,
  currentFilePath: string,
  oldSourceNormalized: string,
  oldSourceWithoutExt: string,
  newDestNormalized: string
): string {
  const currentNormalized = normalizePath(currentFilePath);
  const currentDir = currentNormalized.substring(0, currentNormalized.lastIndexOf("/"));

  // Match import/require statements with relative paths
  const importRegex = /((?:import|export)\s+(?:[\s\S]*?)\s+from\s+['"])([^'"]+)(['"])|(?:require\s*\(\s*['"])([^'"]+)(['"]\s*\))/g;

  return content.replace(importRegex, (match, importPrefix, importPath, importSuffix, requirePath, requireSuffix) => {
    const specifier = importPath || requirePath;
    if (!specifier) return match;

    // Only process relative imports
    if (!specifier.startsWith(".") && !specifier.startsWith("..")) {
      return match;
    }

    // Resolve the import to an absolute path
    const resolvedParts = resolveRelativeImport(currentDir, specifier);
    const resolvedNormalized = resolvedParts;
    const resolvedWithoutExt = stripExtension(resolvedNormalized);

    // Check if this import points to the old source path
    if (
      resolvedNormalized === oldSourceNormalized ||
      resolvedWithoutExt === oldSourceWithoutExt
    ) {
      // Compute the new relative import path
      const newRelative = computeRelativeImport(currentNormalized, newDestNormalized);

      if (importPrefix) {
        return importPrefix + newRelative + importSuffix;
      } else {
        return `require('${newRelative}${requireSuffix}`;
      }
    }

    return match;
  });
}

/**
 * Resolve a relative import specifier against a directory path.
 */
function resolveRelativeImport(fromDir: string, specifier: string): string {
  const parts = fromDir.split("/");
  const specParts = specifier.split("/");

  for (const part of specParts) {
    if (part === "..") {
      parts.pop();
    } else if (part !== ".") {
      parts.push(part);
    }
  }

  return parts.join("/");
}

/**
 * Count the number of import changes between original and updated content.
 */
function countImportChanges(original: string, updated: string): number {
  const originalLines = original.split("\n");
  const updatedLines = updated.split("\n");
  let count = 0;

  const maxLen = Math.max(originalLines.length, updatedLines.length);
  for (let i = 0; i < maxLen; i++) {
    if (originalLines[i] !== updatedLines[i]) {
      count++;
    }
  }

  return count || 1;
}

// ---------------------------------------------------------------------------
// Internal helpers — tokenization (used by analyzeSelection)
// ---------------------------------------------------------------------------

/**
 * Simple tokenizer that splits source text into meaningful tokens:
 * identifiers, operators, punctuation, string literals (skipped), and whitespace.
 */
function tokenize(text: string): string[] {
  const tokens: string[] = [];
  let i = 0;

  while (i < text.length) {
    const ch = text[i];

    // Skip whitespace (but record it so positional lookups stay correct)
    if (/\s/.test(ch)) {
      let ws = "";
      while (i < text.length && /\s/.test(text[i])) {
        ws += text[i];
        i++;
      }
      tokens.push(ws);
      continue;
    }

    // Skip string literals (single/double/backtick)
    if (ch === '"' || ch === "'" || ch === "`") {
      const quote = ch;
      i++; // opening quote
      while (i < text.length && text[i] !== quote) {
        if (text[i] === "\\") i++; // skip escaped char
        i++;
      }
      i++; // closing quote
      continue;
    }

    // Skip line comments
    if (ch === "/" && i + 1 < text.length && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      continue;
    }

    // Skip block comments
    if (ch === "/" && i + 1 < text.length && text[i + 1] === "*") {
      i += 2;
      while (i + 1 < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++;
      i += 2;
      continue;
    }

    // Multi-char operators (must check before single-char)
    if (i + 1 < text.length) {
      const two = text[i] + text[i + 1];
      if (ASSIGNMENT_OPS.has(two)) {
        // check for 3-char op like **=
        if (i + 2 < text.length && ASSIGNMENT_OPS.has(two + text[i + 2])) {
          tokens.push(two + text[i + 2]);
          i += 3;
          continue;
        }
        tokens.push(two);
        i += 2;
        continue;
      }
    }

    // Identifiers (letters, digits, underscore, $)
    if (/[a-zA-Z_$]/.test(ch)) {
      let id = "";
      while (i < text.length && /[a-zA-Z0-9_$]/.test(text[i])) {
        id += text[i];
        i++;
      }
      tokens.push(id);
      continue;
    }

    // Numbers
    if (/[0-9]/.test(ch)) {
      while (i < text.length && /[0-9.]/.test(text[i])) i++;
      continue;
    }

    // Single-char punctuation / operators
    tokens.push(ch);
    i++;
  }

  return tokens;
}

/** Returns true if a token looks like a valid JS/TS/Python identifier. */
function isIdentifier(token: string): boolean {
  return /^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(token);
}

/** Walk backwards to find the previous non-whitespace token. */
function findPrevNonWhitespaceToken(tokens: string[], idx: number): string | null {
  for (let i = idx - 1; i >= 0; i--) {
    if (!/^\s+$/.test(tokens[i])) return tokens[i];
  }
  return null;
}

/** Walk forward to find the next non-whitespace token. */
function findNextNonWhitespaceToken(tokens: string[], idx: number): string | null {
  for (let i = idx + 1; i < tokens.length; i++) {
    if (!/^\s+$/.test(tokens[i])) return tokens[i];
  }
  return null;
}
