/**
 * Unit tests for RefactorService — change-set computation helpers.
 *
 * Tests the pure logic of extract function computation, text edit application,
 * selection extraction/replacement, and import rewriting for move operations.
 *
 * @see Requirements 12.1, 12.2, 12.3, 12.4
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { RefactorService } from "../services/refactor/RefactorService";
import type {
  ExtractParams,
  RefactorChangeSet,
  Position,
} from "../services/refactor/RefactorService";

// Mock Tauri invoke and dependencies used by the async methods
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

vi.mock("../services/agent/differ", () => ({
  diffStrings: vi.fn(async (oldText: string, newText: string) => ({
    hunks: [
      {
        old_start: 1,
        old_lines: oldText.split("\n").length,
        new_start: 1,
        new_lines: newText.split("\n").length,
        lines: [],
      },
    ],
    additions: 1,
    deletions: 1,
  })),
}));

vi.mock("../services/lsp/lspManager", () => ({
  lspManager: {
    getLanguageForFile: vi.fn(() => "typescript"),
  },
}));

vi.mock("../services/lsp/monacoLspBridge", () => ({
  filePathToUri: vi.fn((p: string) => `file:///${p.replace(/\\/g, "/")}`),
  uriToFilePath: vi.fn((u: string) => u.replace("file:///", "")),
}));

vi.mock("../utils/tauri", () => ({
  readFile: vi.fn(),
  getProjectIndex: vi.fn(async () => []),
}));

describe("RefactorService — Change-Set Computation", () => {
  let service: RefactorService;

  beforeEach(() => {
    service = new RefactorService();
    vi.clearAllMocks();
  });

  // ─── computeExtract ──────────────────────────────────────────────────────

  describe("computeExtract", () => {
    it("produces a function stub with free variables as parameters", async () => {
      const { readFile } = await import("../utils/tauri");
      const fileContent = [
        "function main() {",
        "  const result = foo + bar;",
        "  console.log(result);",
        "}",
      ].join("\n");
      vi.mocked(readFile).mockResolvedValue(fileContent);

      const params: ExtractParams = {
        filePath: "src/main.ts",
        selectionStart: { line: 1, character: 2 },
        selectionEnd: { line: 1, character: 28 },
        functionName: "computeSum",
      };

      const changeSet = await service.computeExtract(params);

      expect(changeSet.kind).toBe("extract_function");
      expect(changeSet.edits).toHaveLength(1);
      expect(changeSet.edits[0].filePath).toBe("src/main.ts");
      expect(changeSet.originalContent["src/main.ts"]).toBe(fileContent);

      const newContent = changeSet.edits[0].newContent;
      // Should contain the function stub
      expect(newContent).toContain("function computeSum(foo, bar)");
      // Should contain the call expression with return assignment
      expect(newContent).toContain("computeSum(foo, bar)");
    });

    it("handles selection with no free variables (no params)", async () => {
      const { readFile } = await import("../utils/tauri");
      const fileContent = [
        "function main() {",
        "  const x = 1;",
        "  const y = x + 2;",
        "}",
      ].join("\n");
      vi.mocked(readFile).mockResolvedValue(fileContent);

      const params: ExtractParams = {
        filePath: "src/main.ts",
        selectionStart: { line: 1, character: 2 },
        selectionEnd: { line: 2, character: 20 },
        functionName: "extracted",
      };

      const changeSet = await service.computeExtract(params);
      const newContent = changeSet.edits[0].newContent;

      // No free variables, so params should be empty
      expect(newContent).toContain("function extracted()");
    });

    it("generates tuple return for multiple produced values", async () => {
      const { readFile } = await import("../utils/tauri");
      const fileContent = [
        "function main() {",
        "  sum = a + b;",
        "  product = a * b;",
        "}",
      ].join("\n");
      vi.mocked(readFile).mockResolvedValue(fileContent);

      const params: ExtractParams = {
        filePath: "src/math.ts",
        selectionStart: { line: 1, character: 2 },
        selectionEnd: { line: 2, character: 20 },
        functionName: "calculate",
      };

      const changeSet = await service.computeExtract(params);
      const newContent = changeSet.edits[0].newContent;

      // Multiple returns → destructuring assignment
      expect(newContent).toContain("const [sum, product] = calculate(a, b);");
      expect(newContent).toContain("return [sum, product];");
    });

    it("generates single return for one produced value", async () => {
      const { readFile } = await import("../utils/tauri");
      const fileContent = [
        "function main() {",
        "  total = count * price;",
        "}",
      ].join("\n");
      vi.mocked(readFile).mockResolvedValue(fileContent);

      const params: ExtractParams = {
        filePath: "src/calc.ts",
        selectionStart: { line: 1, character: 2 },
        selectionEnd: { line: 1, character: 24 },
        functionName: "computeTotal",
      };

      const changeSet = await service.computeExtract(params);
      const newContent = changeSet.edits[0].newContent;

      // Single return → simple assignment
      expect(newContent).toContain("const total = computeTotal(count, price);");
      expect(newContent).toContain("return total;");
    });

    it("records changeCount as 2 (replacement + insertion)", async () => {
      const { readFile } = await import("../utils/tauri");
      vi.mocked(readFile).mockResolvedValue("const x = foo + bar;");

      const params: ExtractParams = {
        filePath: "src/test.ts",
        selectionStart: { line: 0, character: 0 },
        selectionEnd: { line: 0, character: 20 },
        functionName: "myFunc",
      };

      const changeSet = await service.computeExtract(params);
      expect(changeSet.edits[0].changeCount).toBe(2);
    });
  });

  // ─── computeRename ──────────────────────────────────────────────────────

  describe("computeRename", () => {
    it("returns empty change set when LSP returns null", async () => {
      const { invoke } = await import("@tauri-apps/api/core");
      vi.mocked(invoke).mockResolvedValue(null);

      const changeSet = await service.computeRename({
        filePath: "src/foo.ts",
        line: 5,
        character: 10,
        newName: "newFoo",
      });

      expect(changeSet.kind).toBe("rename");
      expect(changeSet.edits).toHaveLength(0);
      expect(changeSet.originalContent).toEqual({});
    });

    it("returns empty change set when workspace edit has no changes", async () => {
      const { invoke } = await import("@tauri-apps/api/core");
      vi.mocked(invoke).mockResolvedValue({ changes: undefined });

      const changeSet = await service.computeRename({
        filePath: "src/bar.ts",
        line: 1,
        character: 0,
        newName: "renamed",
      });

      expect(changeSet.kind).toBe("rename");
      expect(changeSet.edits).toHaveLength(0);
    });

    it("applies text edits from workspace edit and captures original content", async () => {
      const { invoke } = await import("@tauri-apps/api/core");
      const { readFile } = await import("../utils/tauri");

      const originalFileContent = "const oldName = 42;\nconsole.log(oldName);";
      vi.mocked(readFile).mockResolvedValue(originalFileContent);

      vi.mocked(invoke).mockResolvedValue({
        changes: {
          "file:///src/foo.ts": [
            {
              range: { start: { line: 0, character: 6 }, end: { line: 0, character: 13 } },
              newText: "newName",
            },
            {
              range: { start: { line: 1, character: 12 }, end: { line: 1, character: 19 } },
              newText: "newName",
            },
          ],
        },
      });

      const changeSet = await service.computeRename({
        filePath: "src/foo.ts",
        line: 0,
        character: 6,
        newName: "newName",
      });

      expect(changeSet.kind).toBe("rename");
      expect(changeSet.edits).toHaveLength(1);
      expect(changeSet.edits[0].changeCount).toBe(2);
      expect(changeSet.edits[0].newContent).toContain("newName");
      expect(changeSet.edits[0].newContent).not.toContain("oldName");
      expect(changeSet.originalContent["src/foo.ts"]).toBe(originalFileContent);
    });
  });

  // ─── computeMove ────────────────────────────────────────────────────────

  describe("computeMove", () => {
    it("produces edit for the moved file with source content", async () => {
      const { readFile, getProjectIndex } = await import("../utils/tauri");
      vi.mocked(readFile).mockResolvedValue("export const helper = () => {};");
      vi.mocked(getProjectIndex).mockResolvedValue([]);

      const changeSet = await service.computeMove({
        sourcePath: "src/utils/helper.ts",
        destinationPath: "src/lib/helper.ts",
      });

      expect(changeSet.kind).toBe("move_file");
      expect(changeSet.edits.length).toBeGreaterThanOrEqual(1);
      expect(changeSet.edits[0].filePath).toBe("src/lib/helper.ts");
      expect(changeSet.edits[0].newContent).toBe("export const helper = () => {};");
      expect(changeSet.originalContent["src/utils/helper.ts"]).toBe(
        "export const helper = () => {};"
      );
    });

    it("rewrites import specifiers in files referencing the moved file", async () => {
      const { readFile, getProjectIndex } = await import("../utils/tauri");

      const sourceContent = "export const helper = () => {};";
      const importingContent = 'import { helper } from "./utils/helper";\n\nhelper();';

      vi.mocked(readFile).mockImplementation(async (path: string) => {
        if (path === "src/utils/helper.ts") return sourceContent;
        if (path === "src/index.ts") return importingContent;
        return "";
      });

      vi.mocked(getProjectIndex).mockResolvedValue([
        { path: "src/index.ts", extension: ".ts", size: 50, modified: 0, preview: "", is_binary: false },
        { path: "src/utils/helper.ts", extension: ".ts", size: 30, modified: 0, preview: "", is_binary: false },
      ]);

      const changeSet = await service.computeMove({
        sourcePath: "src/utils/helper.ts",
        destinationPath: "src/lib/helper.ts",
      });

      // Should have edit for the moved file + the importing file
      expect(changeSet.edits.length).toBe(2);

      const importingEdit = changeSet.edits.find((e) => e.filePath === "src/index.ts");
      expect(importingEdit).toBeDefined();
      expect(importingEdit!.newContent).toContain("./lib/helper");
      expect(importingEdit!.newContent).not.toContain("./utils/helper");
    });

    it("does not modify files with non-matching imports", async () => {
      const { readFile, getProjectIndex } = await import("../utils/tauri");

      const sourceContent = "export const foo = 1;";
      const unrelatedContent = 'import { bar } from "./other/bar";\n\nbar();';

      vi.mocked(readFile).mockImplementation(async (path: string) => {
        if (path === "src/utils/foo.ts") return sourceContent;
        if (path === "src/main.ts") return unrelatedContent;
        return "";
      });

      vi.mocked(getProjectIndex).mockResolvedValue([
        { path: "src/main.ts", extension: ".ts", size: 40, modified: 0, preview: "", is_binary: false },
      ]);

      const changeSet = await service.computeMove({
        sourcePath: "src/utils/foo.ts",
        destinationPath: "src/lib/foo.ts",
      });

      // Only the moved file edit, no changes to unrelated file
      expect(changeSet.edits).toHaveLength(1);
      expect(changeSet.edits[0].filePath).toBe("src/lib/foo.ts");
    });
  });

  // ─── buildPreview ──────────────────────────────────────────────────────

  describe("buildPreview", () => {
    it("produces per-file diffs and aggregates totalFiles/totalChanges", async () => {
      const changeSet: RefactorChangeSet = {
        kind: "rename",
        edits: [
          { filePath: "src/a.ts", newContent: "const newA = 1;", changeCount: 2 },
          { filePath: "src/b.ts", newContent: "const newB = 2;", changeCount: 3 },
        ],
        originalContent: {
          "src/a.ts": "const oldA = 1;",
          "src/b.ts": "const oldB = 2;",
        },
      };

      const preview = await service.buildPreview(changeSet);

      expect(preview.totalFiles).toBe(2);
      expect(preview.totalChanges).toBe(5);
      expect(preview.diffs).toHaveLength(2);
      expect(preview.diffs[0].filePath).toBe("src/a.ts");
      expect(preview.diffs[0].changeCount).toBe(2);
      expect(preview.diffs[1].filePath).toBe("src/b.ts");
      expect(preview.diffs[1].changeCount).toBe(3);
      expect(preview.changeSet).toBe(changeSet);
    });

    it("uses empty string for original when file not in originalContent", async () => {
      const changeSet: RefactorChangeSet = {
        kind: "move_file",
        edits: [
          { filePath: "src/new.ts", newContent: "export {};", changeCount: 1 },
        ],
        originalContent: {},
      };

      // Should not throw
      const preview = await service.buildPreview(changeSet);
      expect(preview.totalFiles).toBe(1);
      expect(preview.totalChanges).toBe(1);
    });

    it("never mutates the changeSet", async () => {
      const changeSet: RefactorChangeSet = {
        kind: "extract_function",
        edits: [
          { filePath: "src/x.ts", newContent: "new content", changeCount: 1 },
        ],
        originalContent: { "src/x.ts": "old content" },
      };

      const originalEdits = [...changeSet.edits];
      const originalOriginalContent = { ...changeSet.originalContent };

      await service.buildPreview(changeSet);

      expect(changeSet.edits).toEqual(originalEdits);
      expect(changeSet.originalContent).toEqual(originalOriginalContent);
    });
  });
});
