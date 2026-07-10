import { describe, it, expect } from "vitest";
import { DocGenerator, applyDocToContent } from "../services/docs/DocGenerator";
import type { DocTarget, DocResult } from "../services/docs/DocGenerator";
import type { AIProviderConfig } from "../utils/providers";

const fakeProvider: AIProviderConfig = {
  id: "test",
  type: "openai-compatible",
  name: "Test",
  apiKey: "x",
  models: [{ id: "m", name: "m", enabled: true }],
};

function makeGenerator(): DocGenerator {
  return new DocGenerator(fakeProvider, "m");
}

describe("DocGenerator.styleFor", () => {
  it("maps each language to its canonical doc style (Req 14.1)", () => {
    const g = makeGenerator();
    expect(g.styleFor("typescript")).toBe("tsdoc");
    expect(g.styleFor("javascript")).toBe("jsdoc");
    expect(g.styleFor("python")).toBe("pydoc");
    expect(g.styleFor("rust")).toBe("rustdoc");
  });
});

describe("DocGenerator.resolveMode", () => {
  const g = makeGenerator();
  const base: DocTarget = {
    filePath: "src/a.ts",
    language: "typescript",
    nearbyDocs: [],
  };

  it("returns 'update' when an existing doc block is present (Req 14.5)", () => {
    const target: DocTarget = {
      ...base,
      selection: { startLine: 10, endLine: 12, text: "fn()" },
      existingDoc: { startLine: 8, endLine: 9, text: "/** old */" },
    };
    expect(g.resolveMode(target)).toBe("update");
  });

  it("returns 'module_header' when there is no selection (Req 14.3)", () => {
    expect(g.resolveMode(base)).toBe("module_header");
  });

  it("returns 'insert' when there is a selection but no existing doc", () => {
    const target: DocTarget = {
      ...base,
      selection: { startLine: 5, endLine: 7, text: "fn()" },
    };
    expect(g.resolveMode(target)).toBe("insert");
  });

  it("prefers 'update' even when a selection exists alongside an existing doc", () => {
    const target: DocTarget = {
      ...base,
      selection: { startLine: 5, endLine: 7, text: "fn()" },
      existingDoc: { startLine: 3, endLine: 4, text: "/** old */" },
    };
    expect(g.resolveMode(target)).toBe("update");
  });
});

describe("applyDocToContent", () => {
  const content = "/** new doc */";

  it("module_header inserts at the top of the file (Req 14.3)", () => {
    const original = "const a = 1;\nconst b = 2;";
    const result: DocResult = {
      style: "tsdoc",
      mode: "module_header",
      content,
      range: { startLine: 1, endLine: 1 },
    };
    expect(applyDocToContent(original, result)).toBe(
      "/** new doc */\nconst a = 1;\nconst b = 2;"
    );
  });

  it("insert places the doc on the line above the selection", () => {
    const original = "line1\nline2\nline3";
    const result: DocResult = {
      style: "tsdoc",
      mode: "insert",
      content,
      range: { startLine: 2, endLine: 2 },
    };
    expect(applyDocToContent(original, result)).toBe(
      "line1\n/** new doc */\nline2\nline3"
    );
  });

  it("update replaces the existing doc block in place without duplicating (Req 14.5)", () => {
    const original = "/** old */\nfunction f() {}\nconst x = 1;";
    const result: DocResult = {
      style: "tsdoc",
      mode: "update",
      content,
      range: { startLine: 1, endLine: 1 },
    };
    const out = applyDocToContent(original, result);
    expect(out).toBe("/** new doc */\nfunction f() {}\nconst x = 1;");
    // Exactly one doc block remains attached.
    expect(out.match(/new doc/g)?.length).toBe(1);
    expect(out).not.toContain("old");
  });

  it("update replaces a multi-line doc block", () => {
    const original = "/**\n * old\n */\nfunction f() {}";
    const result: DocResult = {
      style: "tsdoc",
      mode: "update",
      content: "/**\n * new\n */",
      range: { startLine: 1, endLine: 3 },
    };
    expect(applyDocToContent(original, result)).toBe(
      "/**\n * new\n */\nfunction f() {}"
    );
  });

  it("module_header into an empty file yields just the doc", () => {
    const result: DocResult = {
      style: "tsdoc",
      mode: "module_header",
      content,
      range: { startLine: 1, endLine: 1 },
    };
    expect(applyDocToContent("", result)).toBe("/** new doc */");
  });
});
