/**
 * Workspace Manager — Project-level operations and management.
 * Ported from Zenith IDE for Punam IDE.
 */

import { readFile, runTerminalCommand } from "../../utils/tauri";
import type { FileEntry } from "../../utils/tauri";

export interface WorkspaceInfo {
  path: string;
  name: string;
  hasGit: boolean;
  hasPackageJson: boolean;
  hasCargo: boolean;
  primaryLanguage: string;
  fileCount: number;
}

export class WorkspaceManager {
  private projectPath = "";
  private workspaceInfo: WorkspaceInfo | null = null;

  setProjectPath(path: string): void {
    this.projectPath = path;
  }

  async analyzeWorkspace(files: FileEntry[]): Promise<WorkspaceInfo> {
    const fileNames = new Set<string>();
    const extensions = new Map<string, number>();

    const walk = (entries: FileEntry[]) => {
      for (const entry of entries) {
        if (entry.is_dir && entry.children) walk(entry.children);
        else {
          fileNames.add(entry.name);
          const ext = entry.name.split(".").pop()?.toLowerCase() || "";
          extensions.set(ext, (extensions.get(ext) || 0) + 1);
        }
      }
    };
    walk(files);

    // Detect primary language
    const langMap: Record<string, string> = {
      ts: "TypeScript", tsx: "TypeScript", js: "JavaScript", jsx: "JavaScript",
      py: "Python", rs: "Rust", go: "Go", java: "Java", rb: "Ruby",
      cpp: "C++", c: "C", cs: "C#", swift: "Swift", kt: "Kotlin",
    };

    let primaryLanguage = "Unknown";
    let maxCount = 0;
    for (const [ext, count] of extensions) {
      if (langMap[ext] && count > maxCount) {
        maxCount = count;
        primaryLanguage = langMap[ext];
      }
    }

    // Check for git
    const gitCheck = await runTerminalCommand("git rev-parse --is-inside-work-tree", this.projectPath).catch(() => ({ exit_code: 1, stdout: "", stderr: "" }));

    this.workspaceInfo = {
      path: this.projectPath,
      name: this.projectPath.split(/[\\/]/).pop() || "",
      hasGit: gitCheck.exit_code === 0,
      hasPackageJson: fileNames.has("package.json"),
      hasCargo: fileNames.has("Cargo.toml"),
      primaryLanguage,
      fileCount: fileNames.size,
    };

    return this.workspaceInfo;
  }

  async getProjectRules(): Promise<string> {
    try {
      // Try common rule file names
      const ruleFiles = [".punam.rules.md", ".cursorrules", ".windsurfrules", "CONVENTIONS.md"];
      for (const file of ruleFiles) {
        try {
          const content = await readFile(`${this.projectPath}/${file}`);
          if (content) return content;
        } catch { /* file doesn't exist */ }
      }
      return "";
    } catch {
      return "";
    }
  }

  getWorkspaceInfo(): WorkspaceInfo | null { return this.workspaceInfo; }
}

export const workspaceManager = new WorkspaceManager();
