/**
 * SymbolIndexService.ts — Frontend wrapper for AST-Based Symbol Index (Phase 2).
 */
import { invoke } from "@tauri-apps/api/core";

export interface SymbolEntry {
  name: string; file: string; line: number; kind: string; signature: string;
}
export interface SymbolLookupResult {
  query: string; matches: SymbolEntry[]; total_count: number; query_time_ms: number;
}
export interface SymbolFileResult {
  file: string; symbols: SymbolEntry[]; count: number;
}

export async function lookupSymbol(name: string): Promise<SymbolLookupResult> {
  return invoke("symbol_lookup", { name });
}
export async function listFileSymbols(filePath: string): Promise<SymbolFileResult> {
  return invoke("symbol_list_file", { filePath });
}
export async function rebuildSymbolIndex(): Promise<number> {
  return invoke("symbol_rebuild");
}
export async function getSymbolStats(): Promise<Record<string, unknown>> {
  return invoke("symbol_stats");
}