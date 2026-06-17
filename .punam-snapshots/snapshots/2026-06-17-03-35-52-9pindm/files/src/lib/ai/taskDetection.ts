import type { AgentMode } from "../../types";
import type { TaskType } from "./providerCapabilities";

export interface TaskDetectionContext {
  selectedText?: string;
  fileContext?: string;
  terminalOutput?: string;
  problemsCount?: number;
  attachedImageCount?: number;
  selectedFileCount?: number;
  agentMode?: AgentMode;
}

const ERROR_PATTERNS = /\b(error|exception|traceback|stack trace|failed|panic|cannot find|undefined is not|typeerror|referenceerror|syntaxerror|exit code)\b/i;

export function detectTaskType(input: string, context: TaskDetectionContext = {}): TaskType {
  const prompt = input || "";
  const lower = prompt.toLowerCase();
  const selectedText = context.selectedText || "";
  const terminalOutput = context.terminalOutput || "";
  const totalChars = prompt.length + selectedText.length + (context.fileContext?.length || 0) + terminalOutput.length;

  if ((context.attachedImageCount || 0) > 0) return "vision";
  if (context.agentMode === "agent") return "agent_task";
  if (/\brefactor|cleanup|clean up|restructure|rename\b/i.test(prompt)) return "refactor";
  if (terminalOutput && ERROR_PATTERNS.test(`${prompt}\n${terminalOutput}`)) return "terminal_error_fix";
  if ((context.problemsCount || 0) > 0 || ERROR_PATTERNS.test(prompt)) return "debugging";
  if (/@codebase\b/i.test(prompt) || (context.selectedFileCount || 0) >= 4 || totalChars > 48_000) return "large_context";
  if (/\b(fix|bug|issue|broken|not working)\b/i.test(lower) && selectedText) return "coding_fix";
  if (/\b(create|build|implement|add|generate|scaffold|write)\b/i.test(lower)) return "code_generation";
  if (selectedText || context.fileContext) return "coding_fix";
  if (prompt.length < 180 && !/\b(edit|change|modify|file|code)\b/i.test(prompt)) return "quick_chat";

  return "quick_chat";
}
