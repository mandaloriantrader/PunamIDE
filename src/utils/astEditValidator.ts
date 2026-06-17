/**
 * astEditValidator.ts — Tree-sitter powered edit validation for the agent pipeline.
 *
 * Two roles:
 *   1. PRE-EDIT: Disambiguate SEARCH blocks that match multiple locations by using
 *      AST node boundaries (scope-aware matching).
 *   2. POST-EDIT: Verify the patched file still parses cleanly — catches broken
 *      syntax before it hits disk.
 *
 * Architecture:
 *   - Only activates for TS/JS/TSX/JSX files (tree-sitter grammars available)
 *   - For other languages, the string-matching path continues as-is (no regression)
 *   - Non-blocking: if tree-sitter fails, falls back to string matching silently
 */

import { getASTEngine, extensionToLanguage, type Tree, type SyntaxNode } from "../services/technicalDebt/ASTEngine";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface ASTMatchResult {
  /** 0-indexed line where the search text starts */
  startLine: number;
  /** 0-indexed line where the search text ends (inclusive) */
  endLine: number;
  /** The AST node that contains this match (for context) */
  containingNodeType: string;
  /** Confidence: "exact" = single match, "disambiguated" = picked best from multiple */
  confidence: "exact" | "disambiguated" | "string_fallback";
}

export interface SyntaxValidationResult {
  valid: boolean;
  /** If invalid, the error location and message */
  errors: Array<{
    line: number;
    column: number;
    message: string;
  }>;
}

// ── PRE-EDIT: AST-Aware Search Resolution ─────────────────────────────────────

/**
 * Find the best match location for a SEARCH block using AST awareness.
 *
 * Strategy:
 *   1. Find all string matches (like the existing code does)
 *   2. If only 1 match → return it (no ambiguity)
 *   3. If multiple matches → use tree-sitter to pick the one that aligns
 *      with AST node boundaries (functions, classes, etc.)
 *   4. If tree-sitter unavailable → fall back to first match (existing behavior)
 *
 * Returns null if no match found at all.
 */
export async function findBestMatchWithAST(
  fileContent: string,
  filePath: string,
  searchText: string,
): Promise<ASTMatchResult | null> {
  const lines = fileContent.split("\n");
  const searchLines = searchText.split("\n");

  // Step 1: Find ALL string matches
  const matchPositions: number[] = [];
  for (let i = 0; i <= lines.length - searchLines.length; i++) {
    let matches = true;
    for (let j = 0; j < searchLines.length; j++) {
      if (lines[i + j] !== searchLines[j]) {
        matches = false;
        break;
      }
    }
    if (matches) {
      matchPositions.push(i);
    }
  }

  // No match at all
  if (matchPositions.length === 0) return null;

  // Single match — no ambiguity
  if (matchPositions.length === 1) {
    return {
      startLine: matchPositions[0],
      endLine: matchPositions[0] + searchLines.length - 1,
      containingNodeType: "unknown",
      confidence: "exact",
    };
  }

  // Multiple matches — use tree-sitter to disambiguate
  const language = extensionToLanguage(filePath);
  if (!language) {
    // Not a supported language — return first match (existing behavior)
    return {
      startLine: matchPositions[0],
      endLine: matchPositions[0] + searchLines.length - 1,
      containingNodeType: "unknown",
      confidence: "string_fallback",
    };
  }

  try {
    const engine = getASTEngine();
    const tree = await engine.parse(fileContent, language);
    if (!tree) {
      // Parse failed — use first match
      return {
        startLine: matchPositions[0],
        endLine: matchPositions[0] + searchLines.length - 1,
        containingNodeType: "unknown",
        confidence: "string_fallback",
      };
    }

    // Score each match position by how well it aligns with AST nodes
    let bestPos = matchPositions[0];
    let bestScore = -1;
    let bestNodeType = "unknown";

    for (const pos of matchPositions) {
      const score = scoreMatchAlignment(tree, pos, pos + searchLines.length - 1);
      if (score.score > bestScore) {
        bestScore = score.score;
        bestPos = pos;
        bestNodeType = score.nodeType;
      }
    }

    return {
      startLine: bestPos,
      endLine: bestPos + searchLines.length - 1,
      containingNodeType: bestNodeType,
      confidence: "disambiguated",
    };
  } catch {
    // Tree-sitter failed — fall back to first match
    return {
      startLine: matchPositions[0],
      endLine: matchPositions[0] + searchLines.length - 1,
      containingNodeType: "unknown",
      confidence: "string_fallback",
    };
  }
}

/**
 * Score how well a match position aligns with AST node boundaries.
 *
 * Higher score = match starts/ends at a node boundary (function start, class method, etc.)
 * This helps pick the "right" duplicate when the same code appears in multiple places.
 */
function scoreMatchAlignment(
  tree: Tree,
  startLine: number,
  endLine: number,
): { score: number; nodeType: string } {
  const root = tree.rootNode;

  // Find the smallest node that contains the entire match range
  const startNode = root.descendantForPosition({ row: startLine, column: 0 });
  const endNode = root.descendantForPosition({ row: endLine, column: 0 });

  if (!startNode || !endNode) return { score: 0, nodeType: "unknown" };

  // Walk up to find the containing definition node
  let node: SyntaxNode | null = startNode;
  let score = 0;
  let nodeType = startNode.type;

  while (node) {
    const type = node.type;

    // Bonus: match starts at the beginning of a definition node
    if (isDefinitionNode(type) && node.startPosition.row === startLine) {
      score += 10;
      nodeType = type;
      break;
    }

    // Bonus: match is inside a well-defined scope
    if (isDefinitionNode(type)) {
      score += 5;
      nodeType = type;
      break;
    }

    // Penalty: very deep nesting
    node = node.parent;
  }

  // Bonus: match spans a complete statement/definition
  if (startNode.startPosition.row === startLine && endNode.endPosition.row === endLine) {
    score += 3;
  }

  return { score, nodeType };
}

function isDefinitionNode(type: string): boolean {
  return (
    type === "function_declaration" ||
    type === "method_definition" ||
    type === "class_declaration" ||
    type === "abstract_class_declaration" ||
    type === "interface_declaration" ||
    type === "type_alias_declaration" ||
    type === "enum_declaration" ||
    type === "lexical_declaration" ||
    type === "variable_declaration" ||
    type === "export_statement" ||
    type === "arrow_function"
  );
}

// ── POST-EDIT: Syntax Validation ──────────────────────────────────────────────

/**
 * Verify that a file's content is still valid syntax after patching.
 *
 * Uses tree-sitter to re-parse the content. Checks for ERROR or MISSING nodes
 * in the resulting tree — these indicate broken syntax.
 *
 * Returns { valid: true } if the file parses cleanly.
 * Returns { valid: false, errors: [...] } with locations of syntax errors.
 *
 * Only works for TS/JS/TSX/JSX. Returns { valid: true } for unsupported
 * languages (no regression — we can't validate what we can't parse).
 */
export async function validateSyntaxAfterEdit(
  newContent: string,
  filePath: string,
): Promise<SyntaxValidationResult> {
  const language = extensionToLanguage(filePath);
  if (!language) {
    // Can't validate this language — assume valid (no regression)
    return { valid: true, errors: [] };
  }

  try {
    const engine = getASTEngine();
    const tree = await engine.parse(newContent, language);
    if (!tree) {
      // Parse itself failed — can't determine validity
      return { valid: true, errors: [] };
    }

    // Walk the tree looking for ERROR and MISSING nodes
    const errors: Array<{ line: number; column: number; message: string }> = [];
    collectSyntaxErrors(tree.rootNode, errors, 0);

    return {
      valid: errors.length === 0,
      errors,
    };
  } catch {
    // Tree-sitter crashed — assume valid (no regression)
    return { valid: true, errors: [] };
  }
}

/**
 * Recursively find ERROR and MISSING nodes in the syntax tree.
 * These indicate places where the parser couldn't understand the code.
 */
function collectSyntaxErrors(
  node: SyntaxNode,
  errors: Array<{ line: number; column: number; message: string }>,
  depth: number,
): void {
  if (depth > 50) return; // Safety cap
  if (errors.length >= 10) return; // Cap at 10 errors

  if (node.type === "ERROR") {
    errors.push({
      line: node.startPosition.row + 1,
      column: node.startPosition.column + 1,
      message: `Syntax error at line ${node.startPosition.row + 1}: unexpected "${node.text.slice(0, 30).replace(/\n/g, "\\n")}"`,
    });
    return; // Don't recurse into ERROR nodes
  }

  if (node.isMissing) {
    errors.push({
      line: node.startPosition.row + 1,
      column: node.startPosition.column + 1,
      message: `Missing expected token "${node.type}" at line ${node.startPosition.row + 1}`,
    });
    return;
  }

  // Recurse into children
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (child) {
      collectSyntaxErrors(child, errors, depth + 1);
    }
  }
}
