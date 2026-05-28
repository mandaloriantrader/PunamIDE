/**
 * AI Context Builder — Uses Rust backend to intelligently select
 * relevant files for AI context based on the user's query.
 */

import { invoke } from "@tauri-apps/api/core";

export interface ContextFile {
  path: string;
  content: string;
  relevance: number;
}

export interface AIContext {
  project_summary: string;
  relevant_files: ContextFile[];
  total_tokens_estimate: number;
}

/**
 * Build AI context by finding relevant files for a given query.
 * Uses the Rust-side project index for fast scoring.
 */
export async function buildAIContext(query: string, maxFiles = 5): Promise<AIContext> {
  try {
    return await invoke("build_ai_context", { query, maxFiles });
  } catch {
    // Fallback when Tauri is unavailable
    return {
      project_summary: "Context unavailable (no project indexed)",
      relevant_files: [],
      total_tokens_estimate: 0,
    };
  }
}

/**
 * Format context files into a string suitable for AI system prompts.
 */
export function formatContextForPrompt(context: AIContext): string {
  if (context.relevant_files.length === 0) return "";

  let result = `\n\n## Relevant Project Files (${context.relevant_files.length} files, ~${context.total_tokens_estimate} tokens)\n\n`;

  for (const file of context.relevant_files) {
    const ext = file.path.split(".").pop() || "";
    result += `### ${file.path}\n\`\`\`${ext}\n${file.content}\n\`\`\`\n\n`;
  }

  return result;
}
