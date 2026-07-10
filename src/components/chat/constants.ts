// src/components/chat/constants.ts
//
// Constants and configuration for the AiChat component.

import type { ElementType } from "react";
import { MessageCircle, Zap } from "lucide-react";
import type { AgentMode } from "../../types";

export const AGENT_MODES: Array<{
  id: AgentMode;
  label: string;
  icon: ElementType;
  placeholder: string;
  instruction: string;
}> = [
  {
    id: "chat",
    label: "Chat",
    icon: MessageCircle,
    placeholder: "Describe the change you want...",
    instruction:
      "Mode: Chat. You are Punam, an AI coding assistant. Respond to the user's request appropriately:\n" +
      "- If they ask a question, explain clearly and concisely.\n" +
      "- If they ask for a code change, fix, or refactor, produce FILE blocks using the required format so the IDE can show a diff preview.\n" +
      "- If they ask to run, start, execute, or open something, produce CMD blocks. On Windows, CMD blocks execute in PowerShell, so use PowerShell syntax.\n" +
      "- If they ask to open a standalone HTML file in the browser on Windows, produce a CMD block like ===CMD: start index.html===.\n" +
      "- Keep responses focused and practical. Show code changes when asked, explain when asked, run commands when asked.",
  },
  {
    id: "agent",
    label: "Agent",
    icon: Zap,
    placeholder: "Describe any task — I'll plan and execute it autonomously...",
    instruction:
      "Mode: Agent. You are an autonomous coding agent. Plan step-by-step, then execute: create/edit/delete files, run commands, and iterate until the task is complete. Be thorough and precise.\n" +
      "Command execution environment: CMD blocks run in PowerShell on Windows. Commands execute independently from the project root; working directory changes do not persist between CMD blocks. If a command must run in a subfolder, use Set-Location in the same command, such as `Set-Location src; npm run build`. Use PowerShell-native commands such as Get-ChildItem, Get-Content, Select-String, Test-Path, and npm/cargo directly. Do not use Unix-only helpers like head, grep, sed, awk, cat, or ls -la unless the user explicitly asks for a Unix shell.",
  },
];

export const MODE_LABELS = Object.fromEntries(
  AGENT_MODES.map((mode) => [mode.id, mode.label])
) as Record<AgentMode, string>;

export const DEPENDENCY_DRIFT_PATTERNS = [
  /node_modules[\\/]/i,
  /package-lock\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml|yarn\.lock/i,
  /\bnpm install\b|\bnpm update\b|\bnpm audit\b/i,
  /\brd \/s \/q node_modules\b|\brm -rf node_modules\b/i,
  /\btsc'? is not recognized\b/i,
  /tsBuildInfoFile|TS5069|TS6046|lib\.es\d+\.d\.ts/i,
  /@vitejs\/plugin-react|vite-plugin-checker|Cannot find module .+vite/i,
  /typescript|vite|tsconfig/i,
];

export function looksLikeDependencyDrift(command: string, output: string, history: string[]): boolean {
  const text = [command, output, ...history].join("\n");
  return DEPENDENCY_DRIFT_PATTERNS.some((pattern) => pattern.test(text));
}
