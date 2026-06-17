/**
 * CallGraphService.ts — Frontend wrapper for Function-Level Call Graph (Phase 3).
 */
import { invoke } from "@tauri-apps/api/core";

export interface CallEdge {
  caller: string; caller_file: string; call_line: number;
  callee: string; call_expression: string;
}
export interface CallGraphLookupResult {
  function_name: string; callers: CallEdge[]; total_callers: number; query_time_ms: number;
}
export interface CallGraphCalleesResult {
  function_name: string; callees: CallEdge[]; total_callees: number; query_time_ms: number;
}

export async function findCallers(functionName: string): Promise<CallGraphLookupResult> {
  return invoke("callgraph_lookup", { functionName });
}
export async function findCallees(functionName: string): Promise<CallGraphCalleesResult> {
  return invoke("callgraph_callees", { functionName });
}
export async function buildCallGraph(): Promise<number> {
  return invoke("callgraph_build");
}
export async function getCallGraphStats(): Promise<Record<string, unknown>> {
  return invoke("callgraph_stats");
}