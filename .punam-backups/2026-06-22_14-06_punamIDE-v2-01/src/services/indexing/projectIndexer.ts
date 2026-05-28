/**
 * Project Indexer — Parses source files, extracts symbols, builds dependency graph.
 * Ported from Zenith IDE for Punam IDE.
 */

import { readFile } from "../../utils/tauri";
import type { FileEntry } from "../../utils/tauri";

export interface SymbolInfo {
  name: string;
  kind: "function" | "class" | "interface" | "type" | "variable" | "constant" | "enum" | "method" | "property";
  line: number;
  endLine?: number;
  exported: boolean;
  signature?: string;
}

export interface IndexedFile {
  path: string;
  language: string;
  symbols: SymbolInfo[];
  imports: string[];
  exports: string[];
  lastIndexed: number;
}

export interface DependencyNode {
  path: string;
  imports: string[];
  importedBy: string[];
}

export type IndexingStatus = "idle" | "indexing" | "complete" | "error";

export interface IndexingProgress {
  status: IndexingStatus;
  filesProcessed: number;
  totalFiles: number;
  currentFile: string;
  errors: string[];
}

const SYMBOL_PATTERNS: Record<string, RegExp[]> = {
  typescript: [
    /(?:export\s+)?(?:async\s+)?function\s+(\w+)/g,
    /(?:export\s+)?class\s+(\w+)/g,
    /(?:export\s+)?interface\s+(\w+)/g,
    /(?:export\s+)?type\s+(\w+)\s*=/g,
    /(?:export\s+)?(?:const|let|var)\s+(\w+)/g,
    /(?:export\s+)?enum\s+(\w+)/g,
  ],
  python: [/def\s+(\w+)/g, /class\s+(\w+)/g],
  rust: [
    /(?:pub\s+)?fn\s+(\w+)/g,
    /(?:pub\s+)?struct\s+(\w+)/g,
    /(?:pub\s+)?enum\s+(\w+)/g,
    /(?:pub\s+)?trait\s+(\w+)/g,
  ],
};

const IMPORT_PATTERNS: Record<string, RegExp> = {
  typescript: /import\s+.*?from\s+['"](.+?)['"]/g,
  python: /(?:from\s+(\S+)\s+import|import\s+(\S+))/g,
  rust: /use\s+(.+?);/g,
};

function detectLanguageGroup(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase() || "";
  if (["ts", "tsx", "js", "jsx", "mjs", "cjs"].includes(ext)) return "typescript";
  if (["py", "pyw"].includes(ext)) return "python";
  if (["rs"].includes(ext)) return "rust";
  return "unknown";
}

function extractSymbols(content: string, language: string): SymbolInfo[] {
  const symbols: SymbolInfo[] = [];
  const patterns = SYMBOL_PATTERNS[language] || [];

  for (const pattern of patterns) {
    const regex = new RegExp(pattern.source, pattern.flags);
    let match;
    while ((match = regex.exec(content)) !== null) {
      const beforeMatch = content.substring(0, match.index);
      const line = beforeMatch.split("\n").length;
      const exported = match[0].startsWith("export") || match[0].startsWith("pub");

      let kind: SymbolInfo["kind"] = "variable";
      if (/function|def|fn/.test(match[0])) kind = "function";
      else if (/class|struct/.test(match[0])) kind = "class";
      else if (/interface|trait/.test(match[0])) kind = "interface";
      else if (/\btype\b/.test(match[0])) kind = "type";
      else if (/enum/.test(match[0])) kind = "enum";
      else if (/const/.test(match[0])) kind = "constant";

      symbols.push({ name: match[1], kind, line, exported });
    }
  }

  return symbols;
}

function extractImports(content: string, language: string): string[] {
  const imports: string[] = [];
  const pattern = IMPORT_PATTERNS[language];
  if (!pattern) return imports;

  const regex = new RegExp(pattern.source, pattern.flags);
  let match;
  while ((match = regex.exec(content)) !== null) {
    imports.push(match[1] || match[2] || "");
  }
  return imports.filter(Boolean);
}

export class ProjectIndexer {
  private files: IndexedFile[] = [];
  private symbols: Map<string, SymbolInfo[]> = new Map();
  private dependencies: Map<string, DependencyNode> = new Map();
  private progress: IndexingProgress = {
    status: "idle", filesProcessed: 0, totalFiles: 0, currentFile: "", errors: [],
  };
  private onProgressUpdate?: (progress: IndexingProgress) => void;

  setProgressCallback(callback: (progress: IndexingProgress) => void): void {
    this.onProgressUpdate = callback;
  }

  async indexProject(fileEntries: FileEntry[], _projectPath: string): Promise<void> {
    const filePaths = this.flattenFiles(fileEntries);
    this.progress = { status: "indexing", filesProcessed: 0, totalFiles: filePaths.length, currentFile: "", errors: [] };
    this.notifyProgress();

    this.files = [];
    this.symbols.clear();
    this.dependencies.clear();

    for (const filePath of filePaths) {
      this.progress.currentFile = filePath;
      this.notifyProgress();

      try {
        const content = await readFile(filePath);
        const language = detectLanguageGroup(filePath);
        const syms = extractSymbols(content, language);
        const imports = extractImports(content, language);
        const exports = syms.filter((s) => s.exported).map((s) => s.name);

        this.files.push({ path: filePath, language, symbols: syms, imports, exports, lastIndexed: Date.now() });
        this.symbols.set(filePath, syms);
        this.dependencies.set(filePath, { path: filePath, imports, importedBy: [] });
      } catch (err) {
        this.progress.errors.push(`Failed: ${filePath}: ${err}`);
      }

      this.progress.filesProcessed++;
      this.notifyProgress();
    }

    this.buildDependencyGraph();
    this.progress.status = "complete";
    this.notifyProgress();
  }

  private buildDependencyGraph(): void {
    for (const [filePath, node] of this.dependencies) {
      for (const imp of node.imports) {
        for (const [otherPath, otherNode] of this.dependencies) {
          if (otherPath !== filePath && otherPath.includes(imp.replace(/\./g, "/"))) {
            otherNode.importedBy.push(filePath);
          }
        }
      }
    }
  }

  searchSymbols(query: string): Array<SymbolInfo & { filePath: string }> {
    const results: Array<SymbolInfo & { filePath: string }> = [];
    const lowerQuery = query.toLowerCase();
    for (const [filePath, syms] of this.symbols) {
      for (const sym of syms) {
        if (sym.name.toLowerCase().includes(lowerQuery)) {
          results.push({ ...sym, filePath });
        }
      }
    }
    return results.sort((a, b) => {
      const aExact = a.name.toLowerCase() === lowerQuery;
      const bExact = b.name.toLowerCase() === lowerQuery;
      if (aExact && !bExact) return -1;
      if (!aExact && bExact) return 1;
      return a.name.localeCompare(b.name);
    });
  }

  getRepoMap(): string {
    const lines: string[] = ["# Repository Map\n"];
    for (const file of this.files) {
      if (file.symbols.length === 0) continue;
      lines.push(`## ${file.path}`);
      for (const sym of file.symbols) {
        const prefix = sym.exported ? "⬤ " : "  ";
        lines.push(`${prefix}${sym.kind}: ${sym.name} (L${sym.line})`);
      }
      lines.push("");
    }
    return lines.join("\n");
  }

  getDependencyGraph(): Map<string, DependencyNode> {
    return this.dependencies;
  }

  getProgress(): IndexingProgress {
    return this.progress;
  }

  private flattenFiles(files: FileEntry[]): string[] {
    const result: string[] = [];
    const indexableExtensions = new Set([
      "ts", "tsx", "js", "jsx", "py", "rs", "go", "java", "rb", "php",
      "c", "cpp", "h", "hpp", "cs", "swift", "kt", "scala", "vue", "svelte",
    ]);
    const walk = (entries: FileEntry[]) => {
      for (const entry of entries) {
        if (entry.is_dir && entry.children) walk(entry.children);
        else if (!entry.is_dir) {
          const ext = entry.name.split(".").pop()?.toLowerCase() || "";
          if (indexableExtensions.has(ext)) result.push(entry.path);
        }
      }
    };
    walk(files);
    return result;
  }

  private notifyProgress(): void {
    this.onProgressUpdate?.(this.progress);
  }
}

export const projectIndexer = new ProjectIndexer();
