/**
 * Unit tests for RefactorService — validation and selection analysis.
 *
 * @see Requirements 12.2, 12.8, 12.9
 */

import { describe, it, expect, beforeEach } from "vitest";
import { RefactorService } from "../services/refactor/RefactorService";
import type { RenameParams } from "../services/refactor/RefactorService";

describe("RefactorService", () => {
  let service: RefactorService;

  beforeEach(() => {
    service = new RefactorService();
  });

  // ─── validateRename ────────────────────────────────────────────────────────

  describe("validateRename", () => {
    const baseParams: RenameParams = {
      filePath: "src/foo.ts",
      line: 10,
      character: 5,
      newName: "validName",
    };

    it("rejects empty new name", () => {
      const result = service.validateRename({ ...baseParams, newName: "" }, []);
      expect(result.ok).toBe(false);
      expect(result.message).toContain("empty");
    });

    it("rejects whitespace-only new name", () => {
      const result = service.validateRename({ ...baseParams, newName: "   " }, []);
      expect(result.ok).toBe(false);
      expect(result.message).toContain("empty");
    });

    it("rejects names that collide with in-scope symbols", () => {
      const result = service.validateRename(
        { ...baseParams, newName: "existing" },
        ["foo", "existing", "bar"],
      );
      expect(result.ok).toBe(false);
      expect(result.message).toContain("conflicts");
    });

    it("accepts a valid new name not in scope", () => {
      const result = service.validateRename(
        { ...baseParams, newName: "newSymbol" },
        ["foo", "bar"],
      );
      expect(result.ok).toBe(true);
      expect(result.message).toBeUndefined();
    });

    it("trims the new name before checking collisions", () => {
      const result = service.validateRename(
        { ...baseParams, newName: "  existing  " },
        ["existing"],
      );
      expect(result.ok).toBe(false);
      expect(result.message).toContain("conflicts");
    });
  });

  // ─── validateExtractSelection ──────────────────────────────────────────────

  describe("validateExtractSelection", () => {
    it("rejects empty selection", () => {
      const result = service.validateExtractSelection("");
      expect(result.ok).toBe(false);
      expect(result.message).toContain("valid code selection");
    });

    it("rejects whitespace-only selection", () => {
      const result = service.validateExtractSelection("   \n\t  ");
      expect(result.ok).toBe(false);
      expect(result.message).toContain("valid code selection");
    });

    it("accepts a non-empty selection with code", () => {
      const result = service.validateExtractSelection("const x = 1;");
      expect(result.ok).toBe(true);
      expect(result.message).toBeUndefined();
    });
  });

  // ─── analyzeSelection ──────────────────────────────────────────────────────

  describe("analyzeSelection", () => {
    it("identifies free variables as params", () => {
      const selection = `const result = foo + bar;`;
      const { params } = service.analyzeSelection(selection);
      expect(params).toContain("foo");
      expect(params).toContain("bar");
    });

    it("does not include bound variables as params", () => {
      const selection = `const x = 1;\nconst y = x + 2;`;
      const { params } = service.analyzeSelection(selection);
      expect(params).not.toContain("x");
      expect(params).not.toContain("y");
    });

    it("identifies assigned variables as returns", () => {
      const selection = `total = count * price;`;
      const { returns } = service.analyzeSelection(selection);
      expect(returns).toContain("total");
    });

    it("preserves source order for params", () => {
      const selection = `const z = alpha + beta + gamma;`;
      const { params } = service.analyzeSelection(selection);
      expect(params).toEqual(["alpha", "beta", "gamma"]);
    });

    it("handles compound assignment operators", () => {
      const selection = `sum += value;`;
      const { returns } = service.analyzeSelection(selection);
      expect(returns).toContain("sum");
    });

    it("ignores identifiers inside string literals", () => {
      const selection = `const msg = "hello " + name;`;
      const { params } = service.analyzeSelection(selection);
      expect(params).toContain("name");
      expect(params).not.toContain("hello");
      expect(params).not.toContain("msg");
    });

    it("ignores identifiers inside comments", () => {
      const selection = `// use foo here\nconst x = bar;`;
      const { params } = service.analyzeSelection(selection);
      expect(params).toContain("bar");
      expect(params).not.toContain("foo");
    });

    it("returns empty arrays for a simple literal assignment", () => {
      const selection = `const x = 42;`;
      const { params, returns } = service.analyzeSelection(selection);
      expect(params).toEqual([]);
      expect(returns).toEqual([]);
    });

    it("handles function declarations as bound", () => {
      const selection = `function add(a, b) { return a + b; }`;
      const { params } = service.analyzeSelection(selection);
      // "add" is bound by function keyword, "a" and "b" are params of the function
      expect(params).not.toContain("add");
    });
  });
});
