/**
 * RetrieverDebugger.ts — Phase 8, Step 8.3
 *
 * Individual query → chunk retrieval debugger with score visualization.
 * Re-exports the RetrieverDebugger class from RagWorkbench for standalone use.
 *
 * Provides:
 *   - debugQuery(): Index documents and run a test query with scoring
 *   - compareChunking(): Compare retrieval quality across chunking strategies
 *   - visualizeScores(): Format hits for bar chart rendering
 */

export { RetrieverDebugger } from "./RagWorkbench";
export type { RetrievalDebugResult } from "./RagWorkbench";
