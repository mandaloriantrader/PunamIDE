/**
 * Symbol Search Orchestration Service
 *
 * Provides LSP-backed symbol navigation for the agent's `search_symbol` tool.
 * Uses a 3-strategy approach:
 *   1. LSP workspace/symbol — fast definition lookup
 *   2. LSP textDocument/references — precise reference finding
 *   3. Grep fallback — text search when LSP returns nothing (marked confidence: "fuzzy")
 *
 * Results are ranked by file_hint proximity, then alphabetical, capped at 5.
 *
 * Requirements: 7.1, 7.2, 7.3, 7.4, 7.5, 7.6, 7.7
 */

import { invoke } from "@tauri-apps/api/core";

// ── Public Types ─────────────────────────────────────────────────────────────

export interface SymbolSearchResult {
  symbolName: string;
  filePath: string;
  line: number;          // 1-based
  column: number;        // 0-based
  kind: "definition" | "reference";
  contextLines: string;  // 5 lines above + target + 5 lines below
  confidence: "exact" | "fuzzy";
}

export interface SymbolSearchRequest {
  symbolName: string;
  searchType: "definition" | "references" | "both";
  fileHint?: string;
}

// ── Rust Backend Types (matching what invoke returns) ─────────────────────────

interface LspSymbolInfo {
  name: string;
  kind: string;
  file_path: string;
  line: number;        // 0-based from LSP
  container_name: string | null;
}

interface LspLocation {
  file_path: string;
  line: number;        // 0-based from LSP
  column: number;
  context: string;     // 10-line window
}

interface GrepSearchHit {
  path: string;
  line: number;
  column: number;
  preview: string;
}

// ── Constants ────────────────────────────────────────────────────────────────

const MAX_RESULTS = 5;

// ── Main Orchestration Function ──────────────────────────────────────────────

/**
 * Search for a symbol using a 3-strategy approach:
 * 1. LSP workspace symbol (for definitions)
 * 2. LSP references (for references, using definition location)
 * 3. Grep fallback if LSP returns nothing
 *
 * @throws Error if symbolName is empty or whitespace-only
 */
export async function searchSymbol(
  request: SymbolSearchRequest
): Promise<SymbolSearchResult[]> {
  const { symbolName, searchType, fileHint } = request;

  // Requirement 7.7: Return error if symbol name is empty/whitespace-only
  if (!symbolName || !symbolName.trim()) {
    throw new Error("Symbol name is required");
  }

  let results: SymbolSearchResult[] = [];

  // ── Strategy 1: LSP workspace/symbol (for definitions) ──────────────────
  if (searchType === "definition" || searchType === "both") {
    const definitions = await getDefinitionsViaWorkspaceSymbol(symbolName);
    results.push(...definitions);
  }

  // ── Strategy 2: LSP references (using definition location) ──────────────
  if (searchType === "references" || searchType === "both") {
    const references = await getReferencesViaLsp(symbolName, results);
    results.push(...references);
  }

  // ── Strategy 3: Grep fallback if LSP returned nothing ───────────────────
  if (results.length === 0) {
    const grepResults = await getResultsViaGrep(symbolName);
    results.push(...grepResults);
  }

  // ── Rank results ────────────────────────────────────────────────────────
  results = rankResults(results, fileHint);

  // ── Cap at MAX_RESULTS ──────────────────────────────────────────────────
  // For "both": definition first, then references (already ordered by strategies)
  return results.slice(0, MAX_RESULTS);
}

// ── Strategy 1: Workspace Symbol ─────────────────────────────────────────────

/**
 * Uses LSP workspace/symbol to find definitions matching the symbol name.
 * Filters for exact name match, retrieves context for each.
 */
async function getDefinitionsViaWorkspaceSymbol(
  symbolName: string
): Promise<SymbolSearchResult[]> {
  const results: SymbolSearchResult[] = [];

  try {
    const wsSymbols = await invoke<LspSymbolInfo[]>("lsp_workspace_symbol", {
      query: symbolName,
      maxResults: 10,
    });

    // Filter for exact name match, take up to 3
    const exactMatches = wsSymbols
      .filter((s) => s.name === symbolName)
      .slice(0, 3);

    for (const sym of exactMatches) {
      // Get a context window (5 lines above + target + 5 lines below)
      const context = await getContextWindow(sym.file_path, sym.line);

      results.push({
        symbolName: sym.name,
        filePath: sym.file_path,
        line: sym.line + 1,    // convert 0-based to 1-based
        column: 0,
        kind: "definition",
        contextLines: context,
        confidence: "exact",
      });
    }
  } catch {
    // LSP unavailable or timed out — fall through to allow fallback
  }

  return results;
}

// ── Strategy 2: LSP References ───────────────────────────────────────────────

/**
 * Uses LSP references to find where the symbol is used.
 * Requires at least one definition result to anchor the reference lookup.
 * If no definitions are available, tries workspace symbol first to get a location.
 */
async function getReferencesViaLsp(
  symbolName: string,
  existingResults: SymbolSearchResult[]
): Promise<SymbolSearchResult[]> {
  const results: SymbolSearchResult[] = [];

  // We need a definition location to find references
  let anchorFilePath: string;
  let anchorLine: number;
  let anchorColumn: number;

  if (existingResults.length > 0) {
    // Use the first definition result as anchor
    const anchor = existingResults[0];
    anchorFilePath = anchor.filePath;
    anchorLine = anchor.line - 1;  // back to 0-based for LSP
    anchorColumn = anchor.column;
  } else {
    // No definitions yet — try workspace symbol to get a location
    try {
      const wsSymbols = await invoke<LspSymbolInfo[]>("lsp_workspace_symbol", {
        query: symbolName,
        maxResults: 5,
      });

      const match = wsSymbols.find((s) => s.name === symbolName);
      if (!match) return results;

      anchorFilePath = match.file_path;
      anchorLine = match.line;
      anchorColumn = 0;
    } catch {
      return results;
    }
  }

  try {
    const refs = await invoke<LspLocation[]>("lsp_references", {
      filePath: anchorFilePath,
      line: anchorLine,
      col: anchorColumn,
      includeDeclaration: false,
    });

    for (const ref of refs.slice(0, MAX_RESULTS)) {
      results.push({
        symbolName,
        filePath: ref.file_path,
        line: ref.line + 1,    // convert 0-based to 1-based
        column: ref.column,
        kind: "reference",
        contextLines: ref.context,
        confidence: "exact",
      });
    }
  } catch {
    // LSP unavailable or timed out — fall through
  }

  return results;
}

// ── Strategy 3: Grep Fallback ────────────────────────────────────────────────

/**
 * Text-based grep search as fallback when LSP returns nothing.
 * Results are marked with confidence: "fuzzy".
 */
async function getResultsViaGrep(
  symbolName: string
): Promise<SymbolSearchResult[]> {
  const results: SymbolSearchResult[] = [];

  try {
    const grepHits = await invoke<GrepSearchHit[]>("search_project", {
      query: symbolName,
    });

    for (const hit of grepHits.slice(0, MAX_RESULTS)) {
      results.push({
        symbolName,
        filePath: hit.path,
        line: hit.line,
        column: hit.column,
        kind: "reference",
        contextLines: hit.preview,
        confidence: "fuzzy",
      });
    }
  } catch {
    // Grep also failed — return empty
  }

  return results;
}

// ── Ranking ──────────────────────────────────────────────────────────────────

/**
 * Rank results: file_hint matches first, then alphabetical by file path.
 * Requirement 7.4, 7.5
 */
function rankResults(
  results: SymbolSearchResult[],
  fileHint?: string
): SymbolSearchResult[] {
  return results.sort((a, b) => {
    // file_hint matches rank first
    if (fileHint) {
      const aMatch = a.filePath.includes(fileHint) ? 0 : 1;
      const bMatch = b.filePath.includes(fileHint) ? 0 : 1;
      if (aMatch !== bMatch) return aMatch - bMatch;
    }

    // Definitions before references (preserves "both" ordering)
    if (a.kind !== b.kind) {
      return a.kind === "definition" ? -1 : 1;
    }

    // Alphabetical by file path
    return a.filePath.localeCompare(b.filePath);
  });
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Get a context window of 5 lines above + target line + 5 lines below.
 * Uses read_lines from the Rust backend.
 */
async function getContextWindow(
  filePath: string,
  lineZeroBased: number
): Promise<string> {
  const targetLine1Based = lineZeroBased + 1;
  const startLine = Math.max(1, targetLine1Based - 5);
  const endLine = targetLine1Based + 5;

  try {
    const result = await invoke<{
      path: string;
      start_line: number;
      end_line: number;
      total_lines: number;
      content: string;
    }>("read_lines", {
      path: filePath,
      startLine: startLine,
      endLine: endLine,
    });

    return result.content;
  } catch {
    return "";
  }
}
