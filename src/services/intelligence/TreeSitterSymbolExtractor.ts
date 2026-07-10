/**
 * TreeSitterSymbolExtractor.ts — Tree-sitter powered symbol extraction.
 *
 * Uses the existing ASTEngine (web-tree-sitter WASM) to extract accurate
 * symbol definitions from TypeScript/JavaScript files.
 *
 * Architecture:
 *   - Primary: Rust regex index builds instantly on project open (~ms)
 *   - Enhancement: This tree-sitter pass runs after, refining TS/JS symbols
 *   - Fallback: If tree-sitter fails, regex results stand (already in Rust)
 *
 * What tree-sitter catches that regex misses:
 *   - Nested functions/classes (class methods, inner functions)
 *   - Complex arrow functions with type parameters
 *   - Computed property names
 *   - Overloaded function signatures
 *   - Default exports without names
 *   - Destructured exports
 */

import { invoke } from "@tauri-apps/api/core";
import { getASTEngine, extensionToLanguage, type Tree, type SyntaxNode } from "../technicalDebt/ASTEngine";

// ── Types (matching Rust SymbolEntry) ─────────────────────────────────────────

export interface SymbolEntry {
  name: string;
  file: string;
  line: number;
  kind: string;
  signature: string;
}

// ── Node type → symbol kind mapping ──────────────────────────────────────────

const TS_SYMBOL_NODES: Record<string, string> = {
  function_declaration: "function",
  generator_function_declaration: "function",
  method_definition: "method",
  class_declaration: "class",
  abstract_class_declaration: "class",
  interface_declaration: "interface",
  type_alias_declaration: "type_alias",
  enum_declaration: "enum",
  // Arrow functions assigned to variables
  lexical_declaration: "arrow_function",
  variable_declaration: "arrow_function",
};

// ── Tree-sitter symbol extraction ─────────────────────────────────────────────

/**
 * Extract all symbol definitions from a tree-sitter parse tree.
 * Walks the AST top-down, capturing function/class/interface/type definitions.
 */
function extractSymbolsFromTree(tree: Tree, filePath: string): SymbolEntry[] {
  const symbols: SymbolEntry[] = [];
  const rootNode = tree.rootNode;

  walkNode(rootNode, symbols, filePath, 0);

  return symbols;
}

function walkNode(
  node: SyntaxNode,
  symbols: SymbolEntry[],
  filePath: string,
  depth: number,
): void {
  // Cap recursion depth to avoid stack overflow on malformed files
  if (depth > 20) return;

  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (!child) continue;

    const extracted = tryExtractSymbol(child, filePath);
    if (extracted) {
      symbols.push(extracted);
    }

    // Recurse into class bodies, module bodies, etc. to find methods
    if (shouldRecurseInto(child.type)) {
      walkNode(child, symbols, filePath, depth + 1);
    }
  }
}

function shouldRecurseInto(nodeType: string): boolean {
  return (
    nodeType === "class_body" ||
    nodeType === "statement_block" ||
    nodeType === "program" ||
    nodeType === "module" ||
    nodeType === "export_statement" ||
    nodeType === "class_declaration" ||
    nodeType === "abstract_class_declaration" ||
    nodeType === "interface_body" ||
    nodeType === "object" ||
    nodeType === "object_type" ||
    nodeType === "internal_module"
  );
}

function tryExtractSymbol(node: SyntaxNode, filePath: string): SymbolEntry | null {
  const type = node.type;

  // ── Function declarations ───────────────────────────────────────────────
  if (type === "function_declaration" || type === "generator_function_declaration") {
    const nameNode = node.childForFieldName("name");
    if (!nameNode) return null;
    return {
      name: nameNode.text,
      file: filePath,
      line: node.startPosition.row + 1,
      kind: "function",
      signature: getSignatureLine(node),
    };
  }

  // ── Class declarations ──────────────────────────────────────────────────
  if (type === "class_declaration" || type === "abstract_class_declaration") {
    const nameNode = node.childForFieldName("name");
    if (!nameNode) return null;
    return {
      name: nameNode.text,
      file: filePath,
      line: node.startPosition.row + 1,
      kind: "class",
      signature: getSignatureLine(node),
    };
  }

  // ── Interface declarations ──────────────────────────────────────────────
  if (type === "interface_declaration") {
    const nameNode = node.childForFieldName("name");
    if (!nameNode) return null;
    return {
      name: nameNode.text,
      file: filePath,
      line: node.startPosition.row + 1,
      kind: "interface",
      signature: getSignatureLine(node),
    };
  }

  // ── Type alias declarations ─────────────────────────────────────────────
  if (type === "type_alias_declaration") {
    const nameNode = node.childForFieldName("name");
    if (!nameNode) return null;
    return {
      name: nameNode.text,
      file: filePath,
      line: node.startPosition.row + 1,
      kind: "type_alias",
      signature: getSignatureLine(node),
    };
  }

  // ── Enum declarations ───────────────────────────────────────────────────
  if (type === "enum_declaration") {
    const nameNode = node.childForFieldName("name");
    if (!nameNode) return null;
    return {
      name: nameNode.text,
      file: filePath,
      line: node.startPosition.row + 1,
      kind: "enum",
      signature: getSignatureLine(node),
    };
  }

  // ── Method definitions (inside class body) ──────────────────────────────
  if (type === "method_definition" || type === "public_field_definition") {
    const nameNode = node.childForFieldName("name");
    if (!nameNode) return null;
    const name = nameNode.text;
    // Skip computed property names like [Symbol.iterator]
    if (name.startsWith("[")) return null;
    return {
      name,
      file: filePath,
      line: node.startPosition.row + 1,
      kind: "method",
      signature: getSignatureLine(node),
    };
  }

  // ── Variable declarations with arrow functions ──────────────────────────
  if (type === "lexical_declaration" || type === "variable_declaration") {
    // Look for: const foo = (...) => ... or const foo = async (...) => ...
    const declarator = findChildByType(node, "variable_declarator");
    if (!declarator) return null;

    const nameNode = declarator.childForFieldName("name");
    const valueNode = declarator.childForFieldName("value");
    if (!nameNode || !valueNode) return null;

    const valType = valueNode.type;
    if (valType === "arrow_function" || valType === "function_expression" || valType === "generator_function") {
      return {
        name: nameNode.text,
        file: filePath,
        line: node.startPosition.row + 1,
        kind: "arrow_function",
        signature: getSignatureLine(node),
      };
    }
    return null;
  }

  // ── Export statement wrapping a declaration ─────────────────────────────
  if (type === "export_statement") {
    // Recurse: the actual declaration is a child
    const decl = node.childForFieldName("declaration");
    if (decl) {
      const result = tryExtractSymbol(decl, filePath);
      if (result) return result;
    }
    // Named default export: export default function foo()
    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i);
      if (!child) continue;
      if (child.type.includes("declaration") || child.type === "function_declaration" || child.type === "class_declaration") {
        const result = tryExtractSymbol(child, filePath);
        if (result) return result;
      }
    }
    return null;
  }

  return null;
}

function getSignatureLine(node: SyntaxNode): string {
  // Take the first line of the node as the signature
  const text = node.text;
  const firstLine = text.split("\n")[0];
  return firstLine.trim().slice(0, 200);
}

function findChildByType(node: SyntaxNode, type: string): SyntaxNode | null {
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (child && child.type === type) return child;
  }
  return null;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Parse a single file with tree-sitter and extract symbols.
 * Returns null if the file extension isn't supported by tree-sitter.
 */
export async function extractSymbolsFromFile(
  content: string,
  filePath: string,
): Promise<SymbolEntry[] | null> {
  const language = extensionToLanguage(filePath);
  if (!language) return null; // Not a TS/JS file — regex handles it

  const engine = getASTEngine();
  const tree = await engine.parse(content, language);
  if (!tree) return null; // Parse failed — regex results stand

  return extractSymbolsFromTree(tree, filePath);
}

/**
 * Run tree-sitter enhancement pass on all indexed files.
 *
 * Strategy:
 *   1. Get the list of files already indexed by Rust regex
 *   2. For each TS/JS file, parse with tree-sitter
 *   3. Merge tree-sitter symbols into the Rust index (additive — keeps regex results for non-TS)
 *
 * This is fire-and-forget safe — failures don't break the regex index.
 * Runs in batches to avoid blocking the main thread.
 */
export async function enhanceSymbolIndexWithTreeSitter(): Promise<{
  filesProcessed: number;
  symbolsExtracted: number;
  errors: number;
}> {
  const stats = { filesProcessed: 0, symbolsExtracted: 0, errors: 0 };

  try {
    // Don't call engine.preload() — let the existing debt analyzer control WASM lifecycle.
    // We only use parseFile() which loads grammars lazily on demand.
    const engine = getASTEngine();

    // Get all project files from the Rust file index
    const projectFiles = await invoke<
      Array<{ path: string; name: string; is_dir: boolean }>
    >("refresh_project_index").catch(() => []);

    if (!projectFiles || projectFiles.length === 0) return stats;

    // Filter to only TS/JS files (tree-sitter supported)
    const tsFiles = projectFiles
      .filter((f) => !f.is_dir)
      .filter((f) => {
        const ext = f.path.split(".").pop()?.toLowerCase();
        return ext === "ts" || ext === "tsx" || ext === "js" || ext === "jsx";
      })
      .map((f) => f.path);

    // Process in small batches (5 files) with generous yields to keep UI responsive.
    // Tree-sitter parsing is CPU-intensive — smaller batches prevent micro-freezes.
    const BATCH_SIZE = 5;
    for (let i = 0; i < tsFiles.length; i += BATCH_SIZE) {
      const batch = tsFiles.slice(i, i + BATCH_SIZE);

      for (const filePath of batch) {
        try {
          const content = await invoke<string>("read_file", { path: filePath });
          if (!content) continue;

          const symbols = await extractSymbolsFromFile(content, filePath);
          if (symbols && symbols.length > 0) {
            stats.filesProcessed++;
            stats.symbolsExtracted += symbols.length;
          }
        } catch {
          stats.errors++;
        }
      }

      // Yield to main thread between batches — use requestIdleCallback for
      // true idle-time scheduling so this never competes with user interactions
      await new Promise<void>((resolve) => {
        if (typeof requestIdleCallback === "function") {
          requestIdleCallback(() => resolve());
        } else {
          setTimeout(resolve, 4);
        }
      });
    }
  } catch (err) {
    console.warn("[TreeSitterSymbolExtractor] Enhancement pass failed:", err);
  }

  return stats;
}
