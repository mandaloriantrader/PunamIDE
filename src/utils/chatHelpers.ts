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
  "package.json",
  "tsconfig.json",
  "tsconfig.app.json",
  "vite.config.ts",
  "Cargo.toml",
  "pyproject.toml",
  "pytest.ini",
  "go.mod",
  "README.md",
];

export const PROJECT_RULES_FILES = [
  "punam.rules.md",
  ".punam/rules.md",
  "AGENTS.md",
];

export const MAX_CONTEXT_FILE_CHARS = 30000;
export const MAX_TOTAL_CONTEXT_CHARS = 120000;

// --- File Tree ---

export function buildFileContext(files: FileEntry[], prefix = ""): string {
  let result = "";
  for (const f of files) {
    if (f.is_dir) {
      result += `${prefix}${f.name}/\n`;
      if (f.children) {
        result += buildFileContext(f.children, prefix + "  ");
      }
    } else {
      result += `${prefix}${f.name}\n`;
    }
  }
  return result;
}

// --- Path Utilities ---

export function normalizePath(path: string) {
  return path.replace(/\\/g, "/");
}

export function getProjectFilePath(projectPath: string, relativePath: string) {
  const separator = projectPath.includes("\\") ? "\\" : "/";
  return `${projectPath.replace(/[\\/]+$/, "")}${separator}${relativePath}`;
}

export function getRelativePath(projectPath: string, filePath: string) {
  const normalizedRoot = normalizePath(projectPath).replace(/\/+$/, "");
  const normalizedFile = normalizePath(filePath);
  return normalizedFile.startsWith(`${normalizedRoot}/`)
    ? normalizedFile.slice(normalizedRoot.length + 1)
    : normalizedFile;
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
    if (
      normalizedPrompt.includes(normalizedPath) ||
      (name.includes(".") && normalizedPrompt.includes(name))
    ) {
      matches.add(path);
    }
  }

  return [...matches].slice(0, 5);
}

/** Detect @folder mentions and return all files in those folders */
export function getMentionedFolderFiles(prompt: string, existingFiles: Set<string>): string[] {
  const normalizedPrompt = prompt.replace(/\\/g, "/").toLowerCase();
  const matches: string[] = [];

  const folders = new Set<string>();
  for (const path of existingFiles) {
    const parts = normalizePath(path).split("/");
    for (let i = 1; i <= parts.length - 1; i++) {
      folders.add(parts.slice(0, i).join("/"));
    }
  }

  for (const folder of folders) {
    if (normalizedPrompt.includes(folder.toLowerCase())) {
      for (const path of existingFiles) {
        if (normalizePath(path).startsWith(folder + "/")) {
          matches.push(path);
        }
      }
    }
  }

  return matches.slice(0, 10);
}

/** Detect @file mentions that do NOT resolve to existing files */
export function getUnresolvedMentions(prompt: string, existingFiles: Set<string>): string[] {
  const atMentionPattern = /@([A-Za-z0-9_./\\-]+\.[A-Za-z0-9]+)/g;
  const unresolved: string[] = [];
  let match: RegExpExecArray | null;

  while ((match = atMentionPattern.exec(prompt)) !== null) {
    const mentioned = match[1].replace(/\\/g, "/");
    let found = false;
    for (const existing of existingFiles) {
      const normalizedExisting = normalizePath(existing);
      if (
        normalizedExisting === mentioned ||
        normalizedExisting.endsWith(`/${mentioned}`) ||
        mentioned.endsWith(normalizedExisting)
      ) {
        found = true;
        break;
      }
    }
    if (!found) {
      unresolved.push(mentioned);
    }
  }
  return unresolved;
}

export function getFilePathsFromText(text: string, existingFiles: Set<string>): string[] {
  const matches = new Set<string>();
  const normalizedText = text.replace(/\\/g, "/");

  const filePathPattern =
    /(?:^|[\s"'`(])([A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*\.(?:tsx?|jsx?|mjs|cjs|json|css|scss|html|md|ya?ml|toml|rs|go|py|java|kt|cs|cpp|c|h|sh|bat|ps1))(?:\(\d+(?:,\d+)?\)|:\d+)?/g;

  let match: RegExpExecArray | null;
  while ((match = filePathPattern.exec(normalizedText)) !== null) {
    const mentionedFile = match[1];
    for (const existing of existingFiles) {
      const normalizedExisting = normalizePath(existing);
      if (
        normalizedExisting === mentionedFile ||
        normalizedExisting.endsWith(`/${mentionedFile}`) ||
        mentionedFile.endsWith(normalizedExisting) ||
        normalizedExisting.endsWith(mentionedFile)
      ) {
        matches.add(existing);
        break;
      }
    }
  }

  if (matches.size === 0) {
    for (const existing of existingFiles) {
      const fileName = existing.split("/").pop() || "";
      if (fileName.includes(".") && normalizedText.toLowerCase().includes(fileName.toLowerCase())) {
        matches.add(existing);
        if (matches.size >= 3) break;
      }
    }
  }

  return [...matches].slice(0, 5);
}

// --- Edit Operations ---


// --- Git Context for AI ---

/**
 * Build a git context section for the AI prompt.
 * Fetches recent log and diff-stat for the given files.
 */
export async function buildGitContext(
  projectPath: string,
  filePaths: string[],
  runCmd: (cmd: string, cwd: string) => Promise<{ stdout: string; stderr: string; exit_code: number }>
): Promise<string> {
  const sections: string[] = [];

  try {
    // Recent commits (last 10)
    const logResult = await runCmd(
      "git log --oneline --no-merges -10",
      projectPath
    );
    if (logResult.exit_code === 0 && logResult.stdout.trim()) {
      sections.push(`# Recent Git Log (last 10 commits)\n\`\`\`\n${logResult.stdout.trim()}\n\`\`\``);
    }
  } catch { /* git unavailable */ }

  if (filePaths.length > 0) {
    for (const filePath of filePaths.slice(0, 3)) {
      try {
        // Blame last 30 lines for this file
        const blameResult = await runCmd(
          `git log --oneline --follow -5 -- "${filePath}"`,
          projectPath
        );
        if (blameResult.exit_code === 0 && blameResult.stdout.trim()) {
          sections.push(`# Git History for ${filePath}\n\`\`\`\n${blameResult.stdout.trim()}\n\`\`\``);
        }
      } catch { /* skip */ }
    }
  }

  // Current diff stat
  try {
    const diffResult = await runCmd("git diff --stat --no-color HEAD", projectPath);
    if (diffResult.exit_code === 0 && diffResult.stdout.trim()) {
      sections.push(`# Current Uncommitted Changes\n\`\`\`\n${diffResult.stdout.trim().slice(0, 1500)}\n\`\`\``);
    }
  } catch { /* skip */ }

  return sections.join("\n\n");
}

export async function resolveEditOperations(parsed: ParsedResponse, projectPath: string): Promise<ParsedResponse> {
  if (!parsed.editOperations || parsed.editOperations.length === 0) return parsed;

  const resolvedChanges = [...parsed.fileChanges];

  for (const editOp of parsed.editOperations) {
    const fullPath = getProjectFilePath(projectPath, editOp.path);
    try {
      const originalContent = await readFile(fullPath);
      const { content, applied, failed, fuzzyWarnings } = applyEditOperations(originalContent, editOp.searchReplace);

      if (applied > 0) {
        resolvedChanges.push({
          path: editOp.path,
          content,
          isNew: false,
        });
        if (fuzzyWarnings.length > 0) {
          parsed.explanation += `\n\n⚠️ ${editOp.path}: ${fuzzyWarnings.join("; ")}`;
        }
        if (failed.length > 0) {
          parsed.explanation += `\n\n⚠️ ${failed.length} edit(s) in ${editOp.path} could not be applied (search text not found).`;
        }
      } else {
        parsed.explanation += `\n\n⚠️ Could not apply edits to ${editOp.path} — search text not found in file.`;
      }
    } catch {
      parsed.explanation += `\n\n⚠️ Could not read ${editOp.path} to apply edits.`;
    }
  }

  return { ...parsed, fileChanges: resolvedChanges, editOperations: [] };
}
