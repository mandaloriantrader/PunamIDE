/**
 * Pure utility functions for the AI chat system.
 * Extracted from AiChat.tsx for maintainability.
 */

import type { FileEntry } from "./tauri";
import { readFile } from "./tauri";
import { applyEditOperations } from "./prompts";
import type { ParsedResponse } from "./prompts";

// --- Constants ---

export const KEY_CONTEXT_FILES = [
  "package.json", "tsconfig.json", "tsconfig.app.json", "vite.config.ts",
  "Cargo.toml", "pyproject.toml", "pytest.ini", "go.mod", "README.md",
];

export const PROJECT_RULES_FILES = ["punam.rules.md", ".punam/rules.md", "AGENTS.md"];

export const MAX_CONTEXT_FILE_CHARS = 6000;
export const MAX_TOTAL_CONTEXT_CHARS = 24000;

// --- File Tree ---

export function buildFileContext(files: FileEntry[], prefix = ""): string {
  let result = "";
  for (const f of files) {
    if (f.is_dir) { result += `${prefix}${f.name}/\n`; if (f.children) { result += buildFileContext(f.children, prefix + "  "); } }
    else { result += `${prefix}${f.name}\n`; }
  }
  return result;
}

// --- Path Utilities ---

export function normalizePath(path: string) { return path.replace(/\\/g, "/"); }
export function getProjectFilePath(projectPath: string, relativePath: string) {
  const separator = projectPath.includes("\\") ? "\\" : "/";
  return `${projectPath.replace(/[\\/]+$/, "")}${separator}${relativePath}`;
}
export function getRelativePath(projectPath: string, filePath: string) {
  const normalizedRoot = normalizePath(projectPath).replace(/\/+$/, "");
  const normalizedFile = normalizePath(filePath);
  return normalizedFile.startsWith(`${normalizedRoot}/`) ? normalizedFile.slice(normalizedRoot.length + 1) : normalizedFile;
}
export function truncateContext(content: string, maxChars = MAX_CONTEXT_FILE_CHARS) {
  if (content.length <= maxChars) return content;
  return `${content.slice(0, maxChars)}\n\n/* ...truncated for context size... */`;
}

// --- File Mention Detection ---

export function getMentionedFilePaths(prompt: string, existingFiles: Set<string>) {
  const normalizedPrompt = prompt.replace(/\\/g, "/");
  const matches = new Set<string>();
  for (const path of existingFiles) {
    const normalizedPath = normalizePath(path);
    const name = normalizedPath.split("/").pop() || normalizedPath;
    if (normalizedPrompt.includes(normalizedPath) || (name.includes(".") && normalizedPrompt.includes(name))) { matches.add(path); }
  }
  return [...matches].slice(0, 5);
}

export function getMentionedFolderFiles(prompt: string, existingFiles: Set<string>): string[] {
  const normalizedPrompt = prompt.replace(/\\/g, "/").toLowerCase();
  const matches: string[] = [];
  const folders = new Set<string>();
  for (const path of existingFiles) {
    const parts = normalizePath(path).split("/");
    for (let i = 1; i <= parts.length - 1; i++) { folders.add(parts.slice(0, i).join("/")); }
  }
  for (const folder of folders) {
    if (normalizedPrompt.includes(folder.toLowerCase())) {
      for (const path of existingFiles) { if (normalizePath(path).startsWith(folder + "/")) { matches.push(path); } }
    }
  }
  return matches.slice(0, 10);
}

export function getUnresolvedMentions(prompt: string, existingFiles: Set<string>): string[] {
  const atMentionPattern = /@([A-Za-z0-9_./\\-]+\.[A-Za-z0-9]+)/g;
  const unresolved: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = atMentionPattern.exec(prompt)) !== null) {
    const mentioned = match[1].replace(/\\/g, "/");
    let found = false;
    for (const existing of existingFiles) {
      const normalizedExisting = normalizePath(existing);
      if (normalizedExisting === mentioned || normalizedExisting.endsWith(`/${mentioned}`) || mentioned.endsWith(normalizedExisting)) { found = true; break; }
    }
    if (!found) { unresolved.push(mentioned); }
  }
  return unresolved;
}

export function getFilePathsFromText(text: string, existingFiles: Set<string>): string[] {
  const matches = new Set<string>();
  const normalizedText = text.replace(/\\/g, "/");
  const filePathPattern = /(?:^|[\s"'`(])([A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*\.(?:tsx?|jsx?|mjs|cjs|json|css|scss|html|md|ya?ml|toml|rs|go|py|java|kt|cs|cpp|c|h|sh|bat|ps1))(?:\(\d+(?:,\d+)?\)|:\d+)?/g;
  let match: RegExpExecArray | null;
  while ((match = filePathPattern.exec(normalizedText)) !== null) {
    const mentionedFile = match[1];
    for (const existing of existingFiles) {
      const normalizedExisting = normalizePath(existing);
      if (normalizedExisting === mentionedFile || normalizedExisting.endsWith(`/${mentionedFile}`) || mentionedFile.endsWith(normalizedExisting) || normalizedExisting.endsWith(mentionedFile)) { matches.add(existing); break; }
    }
  }
  if (matches.size === 0) {
    for (const existing of existingFiles) {
      const fileName = existing.split("/").pop() || "";
      if (fileName.includes(".") && normalizedText.toLowerCase().includes(fileName.toLowerCase())) { matches.add(existing); if (matches.size >= 3) break; }
    }
  }
  return [...matches].slice(0, 5);
}

// --- Git Context for AI ---

export async function buildGitContext(
  projectPath: string, filePaths: string[],
  runCmd: (cmd: string, cwd: string) => Promise<{ stdout: string; stderr: string; exit_code: number }>
): Promise<string> {
  const sections: string[] = [];
  try {
    const logResult = await runCmd("git log --oneline --no-merges -10", projectPath);
    if (logResult.exit_code === 0 && logResult.stdout.trim()) { sections.push(`# Recent Git Log (last 10 commits)\n\`\`\`\n${logResult.stdout.trim()}\n\`\`\``); }
  } catch { /* git unavailable */ }
  if (filePaths.length > 0) {
    for (const filePath of filePaths.slice(0, 3)) {
      try {
        const blameResult = await runCmd(`git log --oneline --follow -5 -- "${filePath}"`, projectPath);
        if (blameResult.exit_code === 0 && blameResult.stdout.trim()) { sections.push(`# Git History for ${filePath}\n\`\`\`\n${blameResult.stdout.trim()}\n\`\`\``); }
      } catch { /* skip */ }
    }
  }
  try {
    const diffResult = await runCmd("git diff --stat --no-color HEAD", projectPath);
    if (diffResult.exit_code === 0 && diffResult.stdout.trim()) { sections.push(`# Current Uncommitted Changes\n\`\`\`\n${diffResult.stdout.trim().slice(0, 1500)}\n\`\`\``); }
  } catch { /* skip */ }
  return sections.join("\n\n");
}

// ── Edit Operations (Phase 3: wired to Rust apply_multi_patch) ────────────────

export async function resolveEditOperations(parsed: ParsedResponse, projectPath: string): Promise<ParsedResponse> {
  if (!parsed.editOperations || parsed.editOperations.length === 0) return parsed;

  // Build atomic multi-patch request — one entry per file, with search→line-range hunks
  const patches: Array<{ path: string; hunks: Array<{ start_line: number; end_line: number; new_content: string }> }> = [];

  for (const editOp of parsed.editOperations) {
    const fullPath = getProjectFilePath(projectPath, editOp.path);
    const hunks: Array<{ start_line: number; end_line: number; new_content: string }> = [];

    try {
      const originalContent = await readFile(fullPath);
      const lines = originalContent.split("\n");

      for (const pair of editOp.searchReplace) {
        const searchLines = pair.search.split("\n");
        let foundAt = -1;
        for (let i = 0; i <= lines.length - searchLines.length; i++) {
          let matches = true;
          for (let j = 0; j < searchLines.length; j++) { if (lines[i + j] !== searchLines[j]) { matches = false; break; } }
          if (matches) { foundAt = i; break; }
        }
        if (foundAt >= 0) {
          hunks.push({ start_line: foundAt + 1, end_line: foundAt + searchLines.length, new_content: pair.replace });
        } else {
          // Fallback: apply via JS string replacement for this single pair
          const { content, applied } = applyEditOperations(originalContent, [{ search: pair.search, replace: pair.replace }]);
          if (applied > 0) { parsed.fileChanges.push({ path: editOp.path, content, isNew: false }); }
          else { parsed.explanation += `\n\n⚠️ Could not apply edit to ${editOp.path} — search text not found.`; }
        }
      }
    } catch {
      parsed.explanation += `\n\n⚠️ Could not read ${editOp.path} to resolve edit locations.`;
    }

    if (hunks.length > 0) { patches.push({ path: editOp.path, hunks }); }
  }

  // Call Rust apply_multi_patch for atomic multi-file editing
  if (patches.length > 0) {
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const result = await invoke<{
        success: boolean; files_modified: number; patches_applied: number;
        total_patches: number; errors: string[];
        file_results: Array<{ path: string; lines_replaced: number; new_total_lines: number }>;
      }>("apply_multi_patch", { request: { patches } });

      if (result.success) {
        parsed.explanation += `\n\n✅ Applied ${result.patches_applied} edit(s) across ${result.files_modified} file(s) atomically.`;
      } else {
        parsed.explanation += `\n\n❌ Multi-edit failed: ${result.errors.join("; ")}. All changes rolled back.`;
      }
    } catch (err) {
      parsed.explanation += `\n\n❌ Multi-edit error: ${String(err)}. Plain file changes applied instead.`;
    }
  }

  return { ...parsed, editOperations: [] };
}