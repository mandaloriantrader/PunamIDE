// src/components/chat/context/chatContextBuilder.ts
//
// Pure context-building logic extracted from AiChat.tsx.
// No React state, no hooks, no refs — only explicit parameters.

import { readFile, searchProject } from "../../../utils/tauri";
import type { FileEntry, AppConfig } from "../../../utils/tauri";
import type { OpenTabContext } from "../../../types";
import { detectFrameworks } from "../../../utils/contextGathering";
import { indexProject, searchCodebase, isIndexed } from "../../../utils/codebaseIndex";
import { fetchRustContext } from "../../../utils/contextEngine";
import {
  buildFileContext,
  getProjectFilePath,
  getRelativePath,
  truncateContext,
  getMentionedFilePaths,
  getMentionedFolderFiles,
  getFilePathsFromText,
  buildGitContext,
  KEY_CONTEXT_FILES,
  PROJECT_RULES_FILES,
  MAX_CONTEXT_FILE_CHARS,
  MAX_TOTAL_CONTEXT_CHARS,
} from "../../../utils/chatHelpers";
import { runTerminalCommand } from "../../../utils/tauri";

// ── Types ────────────────────────────────────────────────────────────────────

export interface BuildContextParams {
  userPrompt: string;
  projectPath: string;
  files: FileEntry[];
  openTabs: OpenTabContext[];
  activeFilePath?: string | null;
  selectedProjectFiles: string[];
  terminalOutput?: string;
  proactiveError?: { command: string; output: string } | null;
  agentMode: string;
  projectNotes: string;
  webSearchResults: string;
  alreadyLoadedResolved?: Set<string>;
}

export interface BuildContextResult {
  contextText: string;
  attachedFileNames: string[];
  contextSummary: string;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

export function collectExistingFiles(files: FileEntry[]): Set<string> {
  const existingFiles = new Set<string>();
  const collectPaths = (entries: FileEntry[], prefix = "") => {
    for (const e of entries) {
      const p = prefix ? `${prefix}/${e.name}` : e.name;
      if (e.is_dir && e.children) collectPaths(e.children, p);
      else existingFiles.add(p);
    }
  };
  collectPaths(files);
  return existingFiles;
}

export function countFileEntries(entries: FileEntry[]): number {
  return entries.reduce((total, entry) => total + 1 + (entry.children ? countFileEntries(entry.children) : 0), 0);
}

export function getWorkspaceName(path: string): string {
  const normalized = path.replace(/[\\/]+$/, "");
  return normalized.split(/[\\/]/).pop() || "No workspace";
}

// ── Main context builder ─────────────────────────────────────────────────────

/**
 * Unified context builder — single-pass with deduplication.
 * Priority order (highest to lowest): open tabs, @mentions, key files, @codebase/search hits, errors.
 */
export async function buildProjectContext(params: BuildContextParams): Promise<BuildContextResult> {
  const {
    userPrompt,
    projectPath,
    files,
    openTabs,
    activeFilePath,
    selectedProjectFiles,
    terminalOutput,
    proactiveError,
    agentMode,
    projectNotes,
    webSearchResults,
    alreadyLoadedResolved,
  } = params;

  const existingFiles = collectExistingFiles(files);
  const contextFiles = new Map<string, string>();
  const queued = new Set<string>();
  const resolvedSet = alreadyLoadedResolved || new Set<string>();

  const queueFile = (relativePath: string) => {
    if (!relativePath || relativePath === "none") return;
    if (contextFiles.has(relativePath)) return;
    if (resolvedSet.has(relativePath)) return;
    if (queued.has(relativePath)) return;
    queued.add(relativePath);
  };

  // 1. Open tabs (in-memory, highest priority)
  for (const tab of openTabs) {
    const rel = getRelativePath(projectPath, tab.path);
    if (!contextFiles.has(rel)) {
      contextFiles.set(rel, tab.content);
    }
  }

  // 2. @file mentions
  for (const mentionedPath of getMentionedFilePaths(userPrompt, existingFiles)) {
    if (contextFiles.has(mentionedPath)) continue;
    if (resolvedSet.has(mentionedPath)) {
      resolvedSet.delete(mentionedPath);
      continue;
    }
    queueFile(mentionedPath);
  }

  // 3. @folder mentions
  for (const folderFile of getMentionedFolderFiles(userPrompt, existingFiles)) {
    if (contextFiles.has(folderFile)) continue;
    queueFile(folderFile);
  }

  // 4. Key context files
  for (const keyFile of KEY_CONTEXT_FILES) {
    if (!existingFiles.has(keyFile)) continue;
    if (contextFiles.has(keyFile)) continue;
    queueFile(keyFile);
  }

  // 5. Selected project files
  for (const fp of selectedProjectFiles) {
    if (contextFiles.has(fp)) continue;
    queueFile(fp);
  }

  // 6. @codebase mention
  const hasCodebaseMention = /@codebase\b/i.test(userPrompt);
  if (hasCodebaseMention) {
    if (isIndexed()) {
      const codebaseQuery = userPrompt.replace(/@codebase\b/i, "").trim();
      const hits = searchCodebase(codebaseQuery || userPrompt, 5);
      for (const hit of hits) {
        if (contextFiles.has(hit.path)) continue;
        queueFile(hit.path);
      }
    }
    if (contextFiles.size < 5) {
      for (const fp of [...existingFiles].slice(0, 10)) {
        if (contextFiles.has(fp)) continue;
        if (queued.has(fp)) continue;
        queueFile(fp);
      }
    }
  }

  // 7. Semantic search hits
  const searchMatch = userPrompt.match(/(?:where|find|search|which file|who uses|grep|look for)\s+["`']?([^"`'\n]{3,40})["`']?/i);
  if (searchMatch && projectPath) {
    const searchQuery = searchMatch[1].trim();
    try {
      const results = await searchProject(searchQuery);
      for (const result of results.slice(0, 3)) {
        if (contextFiles.has(result.path)) continue;
        queueFile(result.path);
      }
    } catch { /* ignore */ }
  }

  // 8. Error-referenced files
  const errorContextText = [terminalOutput || "", proactiveError?.output || ""].filter(Boolean).join("\n");
  for (const errorFile of getFilePathsFromText(errorContextText, existingFiles)) {
    if (contextFiles.has(errorFile)) continue;
    queueFile(errorFile);
  }

  // 9. Active file
  if (activeFilePath) {
    const relPath = getRelativePath(projectPath, activeFilePath);
    if (!contextFiles.has(relPath)) {
      queueFile(relPath);
    }
  }

  // 10. Rust TF-IDF context enrichment
  if (userPrompt.length > 3) {
    const tabPaths = openTabs.map((t) => getRelativePath(projectPath, t.path));
    const rustCtx = await fetchRustContext(userPrompt, tabPaths, 5).catch(() => null);
    if (rustCtx && rustCtx.relevant_files.length > 0) {
      for (const rf of rustCtx.relevant_files) {
        if (!contextFiles.has(rf.path) && !queued.has(rf.path)) {
          queueFile(rf.path);
        }
      }
    }
  }

  // ═══ BATCH LOAD ═══
  const queuedArr = [...queued];
  const readPromises = queuedArr.map(async (relPath) => {
    const fp = getProjectFilePath(projectPath, relPath);
    const readPath = (relPath === getRelativePath(projectPath, activeFilePath || "")) && activeFilePath
      ? activeFilePath
      : fp;
    const content = await readFile(readPath).catch(() => "");
    return { path: relPath, content };
  });

  const results = await Promise.all(readPromises);
  for (const { path: relPath, content } of results) {
    if (content && !contextFiles.has(relPath)) {
      contextFiles.set(relPath, content);
    }
  }

  // ═══ BUILD OUTPUT ═══
  let totalChars = 0;
  const sections: string[] = [];
  const attachedNames: string[] = [];

  for (const [path, content] of contextFiles) {
    if (totalChars >= MAX_TOTAL_CONTEXT_CHARS) break;
    const remaining = MAX_TOTAL_CONTEXT_CHARS - totalChars;
    const clipped = truncateContext(content, Math.min(MAX_CONTEXT_FILE_CHARS, remaining));
    sections.push(`## ${path}\n\`\`\`\n${clipped}\n\`\`\``);
    attachedNames.push(path);
    totalChars += clipped.length;
  }

  const contextSummary = attachedNames.length > 0
    ? `Context attached: ${attachedNames.slice(0, 4).join(", ")}${attachedNames.length > 4 ? ` +${attachedNames.length - 4} more` : ""}`
    : "Context attached: file tree only";

  // Frameworks
  const packageJson = contextFiles.get("package.json") || null;
  const cargoToml = contextFiles.get("Cargo.toml") || contextFiles.get("src-tauri/Cargo.toml") || null;
  const frameworks = detectFrameworks(packageJson, cargoToml);
  const frameworkSection = frameworks.length > 0
    ? `\n\n# Detected Frameworks\n${frameworks.join(", ")}`
    : "";

  // Project rules
  let projectRulesSection = "";
  for (const rulesFile of PROJECT_RULES_FILES) {
    const rulesContent = await readFile(getProjectFilePath(projectPath, rulesFile)).catch(() => "");
    if (rulesContent) {
      projectRulesSection = `\n\n# Project Rules (from ${rulesFile})\nFollow these project-specific instructions:\n${rulesContent.slice(0, 3000)}`;
      break;
    }
  }

  // @git mention
  const needsGit = /@git\b/i.test(userPrompt) || agentMode === "agent";
  let gitSection = "";
  if (needsGit && projectPath) {
    const activePaths = [...contextFiles.keys()].slice(0, 3);
    gitSection = await buildGitContext(projectPath, activePaths, runTerminalCommand).catch(() => "");
    if (gitSection) gitSection = `\n\n${gitSection}`;
  }

  // @web results
  let webSection = "";
  if (webSearchResults) {
    webSection = `\n\n# Web Search Results\n${webSearchResults}`;
  }

  // Project notes
  let notesSection = "";
  if (projectNotes && projectNotes.trim()) {
    notesSection = `\n\n# Project Notes (always read these)\n${projectNotes.slice(0, 3000)}`;
  }

  const contextText = sections.join("\n\n") + frameworkSection + projectRulesSection + gitSection + webSection + notesSection;

  return { contextText, attachedFileNames: attachedNames, contextSummary };
}
