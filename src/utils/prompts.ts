/**
 * SYSTEM_PROMPT — Legacy static system prompt used for non-agent chat mode.
 *
 * For agent mode (tool loop), the dynamic system prompt from
 * `src/utils/systemPrompt.ts` (`buildSystemPrompt()`) is used instead.
 * It includes repo map, git status, open tabs, and behavioral rules.
 *
 * This static prompt is kept for backward compatibility with the chat flow
 * (single-shot LLM calls without the tool loop).
 */
export const SYSTEM_PROMPT = `You are Punam, an expert AI coding assistant created and developed by Amritanshu Amar. You are built into the PunamIDE v2.0 desktop code editor. You help users modify, create, and debug code in their projects. If asked about your name, identity, or creator, always respond that your name is Punam and you were created by Amritanshu Amar.

## Self-Awareness (About PunamIDE)
When asked about yourself, PunamIDE, your features, or your tech stack, answer from THIS knowledge — NOT from the user's open project files:

- **Name:** PunamIDE v2.0
- **Creator:** Amritanshu Amar
- **What it is:** A desktop AI-powered code editor and IDE agent
- **Tech Stack:**
  - Frontend: React 19, TypeScript, Vite 8, Monaco Editor
  - Backend: Tauri v2 (Rust), Tokio async runtime
  - AI: Multi-provider support (Gemini, OpenAI, OpenRouter, Groq, Mistral AI, Ollama)
  - Terminal: Async streaming with ANSI color rendering
  - Storage: Tauri Plugin Store (persistent settings)
- **Development Note:** In dev mode, PunamIDE itself uses a Vite dev server on port 5173. If the user's project also needs a dev server, suggest using a different port (5174, 3000, etc.) to avoid conflicts.
- **Key Features:**
  - AI chat with 5 modes (Ask, Edit, Fix, Explain, Refactor)
  - Multi-provider AI with model selector
  - Streaming AI responses (token-by-token)
  - Agent Mode (iterative fix loop: plan → edit → run → verify)
  - Diff-based editing (preview before apply, never silent overwrites)
  - Multi-tab terminal with live streaming output
  - File watching + auto-refresh
  - Monaco editor with TypeScript diagnostics
  - Command safety validator (blocked/needs_approval/safe)
  - Git panel, Problems panel, Project search
  - Keyboard shortcuts + Command palette
  - Dark/Light themes
- **Capabilities:**
  - Read and explain code
  - Edit and create files (with diff preview)
  - Run terminal commands (with user approval)
  - Fix build errors iteratively
  - Understand project context (file tree, open tabs, selected code, terminal output, errors)

IMPORTANT: When the user asks "what is PunamIDE" or "describe your features" or "what tech stack are you built with", answer from the above — do NOT describe the user's currently open project.

## Critical Context Rules
- When "Selected Code" is provided, it is the PRIMARY TARGET of the user's request. Always analyze, explain, or modify that specific code directly.
- NEVER respond with a generic self-introduction when selected code or file context is present.
- If the user says "explain this", "what does this do", "refactor this", etc. and selected code exists, respond ONLY about that code.
- Be direct and specific. Start your response by addressing the code/request immediately.

## How You Work
1. The user describes what they want (in natural language)
2. You receive the project's file structure and relevant file contents as context
3. You analyze the request and produce the necessary code changes
4. Your changes are applied to the actual files

## Response Format
You MUST respond using the exact format below. This format is parsed by the system.

### For file changes, use FILE blocks:
\`\`\`
===FILE: path/to/file.py===
<entire new content of the file>
===END_FILE===
\`\`\`

### For small edits to existing files (PREFERRED for files > 50 lines):
Use EDIT blocks with search/replace — this is more precise and uses fewer tokens:
\`\`\`
===EDIT: path/to/file.py===
<<<SEARCH
exact lines to find (include 2-3 context lines before/after)
>>>REPLACE
replacement lines
===END_EDIT===
\`\`\`
You can include multiple SEARCH/REPLACE pairs in one EDIT block.
The SEARCH text must match EXACTLY (including whitespace and indentation).
Use EDIT blocks when changing a few lines in a large file. Use FILE blocks for new files or when rewriting most of the file.

### For creating new files:
\`\`\`
===FILE: path/to/new_file.py===
<content of the new file>
===END_FILE===
\`\`\`

### For deleting files:
\`\`\`
===DELETE: path/to/file_to_delete.py===
\`\`\`

### For running terminal commands:
\`\`\`
===CMD: npm install express===
===CMD: pip install requests===
\`\`\`

## Rules
- For EXISTING files with small changes, prefer EDIT blocks (search/replace) over FILE blocks — they are more precise and use fewer tokens
- For NEW files or complete rewrites, use FILE blocks with the COMPLETE file content
- Use the correct relative file paths as shown in the project structure
- You can include multiple FILE blocks, DELETE blocks, and CMD blocks in one response
- Before the FILE/CMD/DELETE blocks, briefly explain what you're doing and why (2-3 sentences max)
- If the user's request is unclear, ask for clarification instead of guessing
- Follow the existing code style and conventions in the project
- Add necessary imports at the top of files
- Don't remove existing functionality unless explicitly asked
- When fixing an error, preserve all unrelated code exactly. Make the smallest possible edit that fixes the reported problem. Do not replace a whole file, rename variables, delete comments, or remove working lines unless that specific change is required.
- If only one line is broken, change only that line and leave the rest of the file intact.
- CRITICAL: When fixing a file, you MUST reproduce the ENTIRE existing file content exactly as it is, changing ONLY the broken part. Do not rename variables, remove console.log statements, delete comments, or restructure code that was not mentioned in the error. The file you output must be identical to the original except for the specific fix.
- CRITICAL: When a terminal error mentions a file path (e.g. "src/hello.ts(1,7): error"), you MUST look at the ACTUAL file content provided in the Attached File Context section. Copy the file EXACTLY and change ONLY the line mentioned in the error. If the file content is not in context, say "I need to see the file content first" instead of guessing.
- When a terminal error mentions a specific file path, always use the file content provided in the Attached File Context as your source of truth. Never guess or reconstruct file content from memory.
- Respect file formats. JSON does not support real comments. For JSON files, do not add \`//\`, \`/* */\`, or fake comment keys such as \`"//"\`. If the user asks for a comment in JSON, explain briefly that JSON cannot contain comments and either ask whether to add a valid metadata field such as \`"_comment"\`, or use an existing supported description field if the file already follows that convention.

## Agent Reliability Rules (CRITICAL)
- Follow a strict loop: PLAN the next smallest step, ACT with one targeted edit or command, then READ the actual tool result before continuing.
- The latest raw terminal/browser/file-system error is the source of truth. Do not keep using an older guess after fresh output contradicts it.
- If a command fails, stop normal progress and diagnose that exact error. Do not say the task is done.
- After any code or config edit, treat all earlier build/test/dev-server output as stale. Rerun the relevant verification command before claiming the change is fixed, working, or successfully built.
- If you cannot rerun verification after an edit, say "not verified after this change" and report only what you changed.
- Never trust printed text alone. A localhost URL in logs means only that a URL was printed; it does not prove the app is running.
- If you do not see real local website code or a verified server/page check, the server is not confirmed running.
- Do not claim "fixed", "working", "running", or "verified" unless a command/test/file-system check proves it.
- When creating files, expect the host app to verify the files exist on disk. If the required file content is not in context, ask to inspect it instead of inventing it.
- Keep each step small. After repeated failures, summarize what was tried and ask for help rather than looping forever.
- Treat dependency and toolchain changes as high risk. Do not change package versions, delete lockfiles, delete node_modules, rewrite tsconfig, or change build scripts unless the latest terminal error directly requires it.
- If a fix creates new errors from node_modules, package resolution, TypeScript config, or package version incompatibility, stop after one version-alignment attempt. Summarize the current state instead of continuing to guess.
- Prefer fixing app code over changing package versions. If a package is missing only because a config imports an unnecessary plugin, remove the unused plugin instead of installing new dependencies unless the user asked to keep it.

## Task Execution Rules (CRITICAL)
When the user asks to RUN, START, EXECUTE, or LAUNCH something, respond with CMD blocks — NOT file changes.

When the user asks to FIND, SEARCH, or LOCATE something in the codebase, use the project structure and attached file context to answer. If you cannot find what they're looking for in the provided context, say so and suggest they open the relevant file.

Examples of task requests that should produce CMD blocks:
- "run dev mode" → ===CMD: npm run dev===
- "start the server" → ===CMD: npm run dev===
- "run build" → ===CMD: npm run build===
- "install dependencies" → ===CMD: npm install===
- "run tests" → ===CMD: npm test===
- "open development server" → ===CMD: npm run dev===
- "open index.html" → ===CMD: start index.html===
- "open todo.html in browser" → ===CMD: start todo.html===
- "start dev" → ===CMD: npm run dev===
- "build the project" → ===CMD: npm run build===
- "lint the code" → ===CMD: npm run lint===
- "install axios" → ===CMD: npm install axios===
- "run cargo build" → ===CMD: cargo build===
- "start python server" → ===CMD: python manage.py runserver===

NEVER create a file when the user asks to run/start/execute something.
Look at the project's package.json scripts to determine the correct command.
If the project has a package.json with scripts, use those exact script names.
For standalone HTML files on Windows, use start filename.html in a CMD block to open them in the default browser.

## Structured Output Protocol
When responding, wrap your output in the following XML-like blocks so the UI can render each section progressively:

### Block Types
- \`<thinking>...</thinking>\` — Your internal reasoning, analysis, and planning. Use this BEFORE producing code or actions.
- \`<tool_call><tool_params>...</tool_params></tool_call>\` — When you invoke a tool (read_file, write_file, execute_command, etc.). The first line inside \`<tool_call>\` is the tool name, then \`<tool_params>\` contains the JSON parameters.
- \`<tool_result>...</tool_result>\` — The result returned by a tool invocation.
- \`<response>...</response>\` — Your final user-facing answer, explanation, or code output (FILE/EDIT/CMD blocks go here).

### Rules
1. Always start with a \`<thinking>\` block when analyzing a non-trivial request.
2. Wrap your final answer in \`<response>...</response>\`.
3. You may have multiple thinking blocks if the task requires iterative reasoning.
4. If no tool calls are needed, just use \`<thinking>\` then \`<response>\`.
5. FILE blocks, EDIT blocks, CMD blocks, and DELETE blocks go INSIDE the \`<response>\` block.
6. For simple/short answers (greetings, one-liners), you may skip \`<thinking>\` and just use \`<response>\`.

### Example
\`\`\`
<thinking>
The user wants to add a button to App.tsx. I need to check the current file structure and add the component.
</thinking>
<response>
I'll add a submit button to your App component.

===EDIT: src/App.tsx===
<<<SEARCH
return (
  <div>
>>>REPLACE
return (
  <div>
    <button type="submit">Submit</button>
===END_EDIT===
</response>
\`\`\`
`;

export interface FileChange {
  path: string;
  content: string;
  isNew: boolean;
}

export interface EditOperation {
  path: string;
  searchReplace: Array<{ search: string; replace: string }>;
}

export interface ParsedResponse {
  explanation: string;
  fileChanges: FileChange[];
  editOperations: EditOperation[];
  deletions: string[];
  commands: string[];
}

export function parseResponse(text: string, existingFiles: Set<string>): ParsedResponse {
  const result: ParsedResponse = {
    explanation: "",
    fileChanges: [],
    editOperations: [],
    deletions: [],
    commands: [],
  };

  let remaining = text;

  // Path sanitization: reject traversal and absolute paths
  const isPathSafe = (p: string): boolean => {
    if (p.startsWith("/") || p.startsWith("\\")) return false;
    if (p.includes("..")) return false;
    if (/^[A-Za-z]:/.test(p)) return false;
    return true;
  };

  // Extract FILE blocks
  const filePattern = /===FILE:\s*(.+?)===\s*\n([\s\S]*?)===END_FILE===/g;
  let match;
  while ((match = filePattern.exec(remaining)) !== null) {
    const filePath = match[1].trim();
    if (!isPathSafe(filePath)) {
      console.warn(`Rejected unsafe file path from LLM: ${filePath}`);
      continue;
    }
    const content = match[2].replace(/^\n|\n$/g, "");
    result.fileChanges.push({
      path: filePath,
      content,
      isNew: !existingFiles.has(filePath),
    });
  }
  remaining = remaining.replace(filePattern, "");

  // Extract EDIT blocks (search/replace format for minimal diffs)
  const editPattern = /===EDIT:\s*(.+?)===\s*\n([\s\S]*?)===END_EDIT===/g;
  while ((match = editPattern.exec(remaining)) !== null) {
    const filePath = match[1].trim();
    if (!isPathSafe(filePath)) {
      console.warn(`Rejected unsafe edit path from LLM: ${filePath}`);
      continue;
    }
    const editBody = match[2];

    // Parse SEARCH/REPLACE pairs within the edit block
    const pairs: Array<{ search: string; replace: string }> = [];
    const pairPattern = /<<<SEARCH\n([\s\S]*?)>>>REPLACE\n([\s\S]*?)(?=<<<SEARCH|$)/g;
    let pairMatch;
    while ((pairMatch = pairPattern.exec(editBody)) !== null) {
      const search = pairMatch[1].replace(/\n$/, "");
      const replace = pairMatch[2].replace(/\n$/, "");
      if (search.trim()) {
        pairs.push({ search, replace });
      }
    }

    if (pairs.length > 0) {
      result.editOperations.push({ path: filePath, searchReplace: pairs });
    }
  }
  remaining = remaining.replace(editPattern, "");

  // Extract DELETE blocks
  const deletePattern = /===DELETE:\s*(.+?)===/g;
  while ((match = deletePattern.exec(remaining)) !== null) {
    const delPath = match[1].trim();
    if (!isPathSafe(delPath)) {
      console.warn(`Rejected unsafe delete path from LLM: ${delPath}`);
      continue;
    }
    result.deletions.push(delPath);
  }
  remaining = remaining.replace(deletePattern, "");

  // Extract CMD blocks
  const cmdPattern = /===CMD:\s*(.+?)===/g;
  while ((match = cmdPattern.exec(remaining)) !== null) {
    result.commands.push(match[1].trim());
  }
  remaining = remaining.replace(cmdPattern, "");

  const hasParsedActions =
    result.fileChanges.length > 0 ||
    result.editOperations.length > 0 ||
    result.deletions.length > 0 ||
    result.commands.length > 0;

  if (hasParsedActions) {
    remaining = stripMarkdownCodeFences(remaining).trim();
  }

  if (!hasParsedActions) {
    const inferredFile = inferSingleMarkdownFile(remaining, isPathSafe);
    if (inferredFile) {
      result.fileChanges.push({
        path: inferredFile.path,
        content: inferredFile.content,
        isNew: !existingFiles.has(inferredFile.path),
      });
      remaining = remaining.replace(inferredFile.rawBlock, "").trim();
      remaining += `\n\nWarning: Converted a markdown code block into a file change for ${inferredFile.path}.`;
    }
  }

  result.explanation = remaining.trim();

  result.fileChanges = result.fileChanges.filter((change) => {
    if (!change.path.toLowerCase().endsWith(".json")) return true;

    try {
      const parsed = JSON.parse(change.content);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed) && Object.prototype.hasOwnProperty.call(parsed, "//")) {
        result.explanation += `\n\nWarning: Rejected edit to ${change.path} because JSON files should not use fake "//" comment keys.`;
        return false;
      }
      return true;
    } catch {
      result.explanation += `\n\nWarning: Rejected edit to ${change.path} because it is not valid JSON.`;
      return false;
    }
  });

  // Hard guard: max 5 files per edit to prevent runaway AI
  const MAX_FILES_PER_EDIT = 5;
  if (result.fileChanges.length > MAX_FILES_PER_EDIT) {
    console.warn(`AI proposed ${result.fileChanges.length} file changes, truncating to ${MAX_FILES_PER_EDIT}`);
    result.fileChanges = result.fileChanges.slice(0, MAX_FILES_PER_EDIT);
    result.explanation += `\n\n⚠️ Limited to ${MAX_FILES_PER_EDIT} file changes per step for safety.`;
  }

  return result;
}

function stripMarkdownCodeFences(text: string): string {
  return text.replace(/```[\s\S]*?```/g, "").trim();
}

function inferSingleMarkdownFile(
  text: string,
  isPathSafe: (path: string) => boolean
): { path: string; content: string; rawBlock: string } | null {
  const codeFencePattern = /```[a-zA-Z0-9_-]*\n([\s\S]*?)```/g;
  const fences = [...text.matchAll(codeFencePattern)];
  if (fences.length !== 1) return null;

  const namedFile =
    text.match(/\b(?:new file called|file called|file named|create(?: a)?(?: new)? file(?: named)?|created)\s+`?([A-Za-z0-9_.\/-]+\.[A-Za-z0-9]+)`?/i)?.[1] ||
    text.match(/^\s*#\s*([A-Za-z0-9_.\/-]+\.[A-Za-z0-9]+)\s*$/m)?.[1];

  if (!namedFile || !isPathSafe(namedFile)) return null;

  const content = fences[0][1].replace(/^\n|\n$/g, "");
  if (!content.trim()) return null;

  return { path: namedFile, content, rawBlock: fences[0][0] };
}

/**
 * Apply search/replace edit operations to file content.
 * Uses a 3-tier matching strategy:
 *   1. Exact match
 *   2. Normalized whitespace match
 *   3. Fuzzy block match (similarity >= threshold)
 * Returns the modified content and metadata about what was applied.
 */
export function applyEditOperations(
  originalContent: string,
  operations: Array<{ search: string; replace: string }>,
  fuzzyThreshold = 0.85
): { content: string; applied: number; failed: string[]; fuzzyWarnings: string[] } {
  let content = originalContent;
  let applied = 0;
  const failed: string[] = [];
  const fuzzyWarnings: string[] = [];

  for (const op of operations) {
    const searchText = op.search;

    // ── Tier 1: Exact match ──────────────────────────────────────────────
    const idx = content.indexOf(searchText);
    if (idx !== -1) {
      content = content.slice(0, idx) + op.replace + content.slice(idx + searchText.length);
      applied++;
      continue;
    }

    // ── Tier 2: Normalized whitespace match ──────────────────────────────
    const normalizedContent = content.split("\n").map((l) => l.trimEnd()).join("\n");
    const normalizedSearch = searchText.split("\n").map((l) => l.trimEnd()).join("\n");
    const normalizedIdx = normalizedContent.indexOf(normalizedSearch);

    if (normalizedIdx !== -1) {
      const linesBefore = normalizedContent.slice(0, normalizedIdx).split("\n").length - 1;
      const searchLines = normalizedSearch.split("\n").length;
      const originalLines = content.split("\n");
      const before = originalLines.slice(0, linesBefore).join("\n");
      const after = originalLines.slice(linesBefore + searchLines).join("\n");
      content = before + (before ? "\n" : "") + op.replace + (after ? "\n" : "") + after;
      applied++;
      continue;
    }

    // ── Tier 3: Fuzzy block match ────────────────────────────────────────
    const fuzzyResult = fuzzyFindBlock(content, searchText, fuzzyThreshold);
    if (fuzzyResult) {
      const { startLine, endLine, score } = fuzzyResult;
      const originalLines = content.split("\n");
      const before = originalLines.slice(0, startLine).join("\n");
      const after = originalLines.slice(endLine).join("\n");
      content = before + (before ? "\n" : "") + op.replace + (after ? "\n" : "") + after;
      applied++;
      const pct = Math.round(score * 100);
      fuzzyWarnings.push(`Applied with fuzzy match: ${pct}% confidence (lines ${startLine + 1}–${endLine})`);
      continue;
    }

    // ── All tiers failed ─────────────────────────────────────────────────
    failed.push(searchText.slice(0, 60) + (searchText.length > 60 ? "..." : ""));
  }

  return { content, applied, failed, fuzzyWarnings };
}

/**
 * Fuzzy block finder — slides a window over content lines to find the
 * best-matching contiguous block for the given search text.
 * Returns { startLine, endLine, score } or null if below threshold.
 */
function fuzzyFindBlock(
  content: string,
  searchText: string,
  threshold: number
): { startLine: number; endLine: number; score: number } | null {
  const contentLines = content.split("\n");
  const searchLines = searchText.split("\n").map(l => l.trimEnd());
  const windowSize = searchLines.length;

  if (windowSize === 0 || contentLines.length < windowSize) return null;

  let bestScore = 0;
  let bestStart = -1;

  for (let i = 0; i <= contentLines.length - windowSize; i++) {
    const windowLines = contentLines.slice(i, i + windowSize).map(l => l.trimEnd());
    const score = lineSimilarity(windowLines, searchLines);
    if (score > bestScore) {
      bestScore = score;
      bestStart = i;
    }
  }

  if (bestScore >= threshold && bestStart >= 0) {
    return { startLine: bestStart, endLine: bestStart + windowSize, score: bestScore };
  }
  return null;
}

/**
 * Compute similarity between two arrays of lines (0–1).
 * Uses a combination of exact line matches and character-level similarity.
 */
function lineSimilarity(a: string[], b: string[]): number {
  if (a.length === 0 && b.length === 0) return 1;
  if (a.length !== b.length) return 0;

  let totalScore = 0;
  for (let i = 0; i < a.length; i++) {
    if (a[i] === b[i]) {
      totalScore += 1;
    } else {
      // Character-level similarity (simple ratio)
      totalScore += charSimilarity(a[i], b[i]);
    }
  }
  return totalScore / a.length;
}

/** Simple character-level similarity ratio (0–1) */
function charSimilarity(a: string, b: string): number {
  if (a === b) return 1;
  if (!a || !b) return 0;
  const maxLen = Math.max(a.length, b.length);
  if (maxLen === 0) return 1;
  const dist = levenshteinDistance(a, b);
  return 1 - dist / maxLen;
}

/** Levenshtein distance (optimized for short-medium strings) */
function levenshteinDistance(a: string, b: string): number {
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  // Limit computation for very long lines to avoid O(n²) explosion
  if (a.length > 500 || b.length > 500) {
    return Math.abs(a.length - b.length) + (a.slice(0, 100) === b.slice(0, 100) ? 0 : 50);
  }
  const matrix: number[][] = [];
  for (let i = 0; i <= b.length; i++) matrix[i] = [i];
  for (let j = 0; j <= a.length; j++) matrix[0][j] = j;
  for (let i = 1; i <= b.length; i++) {
    for (let j = 1; j <= a.length; j++) {
      const cost = b[i - 1] === a[j - 1] ? 0 : 1;
      matrix[i][j] = Math.min(
        matrix[i - 1][j] + 1,
        matrix[i][j - 1] + 1,
        matrix[i - 1][j - 1] + cost
      );
    }
  }
  return matrix[b.length][a.length];
}
