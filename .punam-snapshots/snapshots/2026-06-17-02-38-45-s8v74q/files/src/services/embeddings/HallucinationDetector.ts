/**
 * HallucinationDetector.ts — Phase 8, Step 8.5
 *
 * Prompt-based consistency checker and source attribution validator.
 * Re-exports the HallucinationDetector class from RagWorkbench for standalone use.
 *
 * Provides:
 *   - checkClaim(): Verify if an LLM claim is supported by source documents
 *   - consistencyCheck(): Compare multiple LLM responses for consistency
 */

export { HallucinationDetector } from "./RagWorkbench";
export type { HallucinationCheck } from "./RagWorkbench";
