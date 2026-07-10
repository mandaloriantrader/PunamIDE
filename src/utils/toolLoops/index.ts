// src/utils/toolLoops/index.ts
//
// Barrel export — internal use only. External consumers import from ../agentToolLoop.ts

export { runAnthropicToolLoop } from "./anthropicLoop";
export { runGeminiToolLoop } from "./geminiLoop";
export { runJsonFallbackToolLoop } from "./jsonFallbackLoop";
export { runOpenAIToolLoop } from "./openaiLoop";
export { generatePlan } from "./planner";
export { runVerification } from "./verifier";
export { executeToolWithVerification, deriveExpectedSnippet } from "./verification";
export {
  gatePatchWithApproval,
  matchesSensitivePattern,
  APPROVAL_THRESHOLDS,
  type PatchProposal,
  type ApprovalDecision,
} from "./approvalGate";
export {
  type ToolLoopOptions,
  type AgentPlan,
  type VerifyResult,
  type VerificationResult,
  type ToolResultWithVerification,
  type ToolObservation,
  MAX_VERIFICATION_RETRIES,
  throwIfCancelled,
  isCancellationError,
  combineLoopMetrics,
  recordLoopMetrics,
  buildExplicitReadOnlyToolCall,
  synthesizeFinalAnswer,
  recordToolObservation,
} from "./shared";
