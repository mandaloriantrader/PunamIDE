/**
 * FileIcon — uses actual Material Icon Theme SVGs from /public/icons/
 * SVG files are downloaded from:
 * https://github.com/material-extensions/vscode-material-icon-theme
 */

const BASE = "/icons";

// ── Folder icon ────────────────────────────────────────────────────────────────

export function FolderIcon({ open = false, name = "", size = 16 }: {
  open?: boolean;
  name?: string;
  size?: number;
}) {
  const slug = getFolderSlug(name, open);
  return (
    <img
      src={`${BASE}/${slug}.svg`}
      width={size}
      height={size}
      alt=""
      aria-hidden="true"
      style={{ display: "block", flexShrink: 0 }}
      onError={(e) => {
        // fallback to generic folder
        const suffix = open ? "-open" : "";
        (e.currentTarget as HTMLImageElement).src = `${BASE}/folder${suffix}.svg`;
      }}
    />
  );
}

function getFolderSlug(name: string, open: boolean): string {
  const suffix = open ? "-open" : "";
  const lower = name.toLowerCase();

  const MAP: Record<string, string> = {
    "src": "folder-src",
    "source": "folder-src",
    "components": "folder-components",
    "component": "folder-components",
    "node_modules": "folder-node",
    "dist": "folder-dist",
    "build": "folder-dist",
    "out": "folder-dist",
    "public": "folder-public",
    "static": "folder-public",
    "assets": "folder-public",
    ".git": "folder-git",
    ".github": "folder-git",
    "utils": "folder-utils",
    "util": "folder-utils",
    "helpers": "folder-utils",
    "lib": "folder-utils",
    "hooks": "folder-hooks",
    "hook": "folder-hooks",
    "types": "folder-types",
    "interfaces": "folder-types",
    "test": "folder-test",
    "tests": "folder-test",
    "__tests__": "folder-test",
    "spec": "folder-test",
    "styles": "folder-styles",
    "style": "folder-styles",
    "css": "folder-styles",
    "scss": "folder-styles",
    ".vscode": "folder-vscode",
    ".kiro": "folder-vscode",
    "src-tauri": "folder-src",
  };

  const base = MAP[lower] ?? "folder";
  return `${base}${suffix}`;
}

// ── File icon ──────────────────────────────────────────────────────────────────

export function FileIcon({ name, size = 16 }: { name: string; size?: number }) {
  const slug = getFileSlug(name);
  return (
    <img
      src={`${BASE}/${slug}.svg`}
      width={size}
      height={size}
      alt=""
      aria-hidden="true"
      style={{ display: "block", flexShrink: 0 }}
      onError={(e) => {
        (e.currentTarget as HTMLImageElement).src = `${BASE}/file.svg`;
      }}
    />
  );
}

function getFileSlug(name: string): string {
  const lower = name.toLowerCase();
  const ext = lower.split(".").pop() ?? "";

  // ── Special filenames ─────────────────────────────────────────────────────
  const SPECIAL: Record<string, string> = {
    "package.json":          "npm",
    "package-lock.json":     "npm",
    "npm-shrinkwrap.json":   "npm",
    ".npmrc":                "npm",
    "yarn.lock":             "lock",
    "pnpm-lock.yaml":        "lock",
    "cargo.toml":            "rust",
    "cargo.lock":            "rust",
    "dockerfile":            "docker",
    "docker-compose.yml":    "docker",
    "docker-compose.yaml":   "docker",
    ".dockerignore":         "docker",
    ".gitignore":            "git",
    ".gitattributes":        "git",
    ".gitmodules":           "git",
    "vite.config.ts":        "vite",
    "vite.config.js":        "vite",
    "vite.config.mjs":       "vite",
    "eslint.config.js":      "eslint",
    "eslint.config.ts":      "eslint",
    ".eslintrc":             "eslint",
    ".eslintrc.js":          "eslint",
    ".eslintrc.json":        "eslint",
    ".eslintignore":         "eslint",
    "tsconfig.json":         "typescript",
    "tsconfig.app.json":     "typescript",
    "tsconfig.node.json":    "typescript",
    "readme.md":             "readme",
    "license":               "license",
    "license.md":            "license",
    "license.txt":           "license",
    ".env":                  "env",
    ".env.local":            "env",
    ".env.example":          "env",
    ".env.production":       "env",
    ".env.development":      "env",
    "monacosetup.ts":        "typescript",
  };
  if (SPECIAL[lower]) return SPECIAL[lower];
  if (lower.startsWith(".env")) return "env";

  // ── Extension map ─────────────────────────────────────────────────────────
  const EXT: Record<string, string> = {
    "ts":         "typescript",
    "tsx":        "react_ts",
    "js":         "javascript",
    "jsx":        "react",
    "mjs":        "javascript",
    "cjs":        "javascript",
    "json":       "json",
    "html":       "html",
    "htm":        "html",
    "css":        "css",
    "scss":       "scss",
    "sass":       "scss",
    "less":       "less",
    "py":         "python",
    "pyw":        "python",
    "rs":         "rust",
    "go":         "go",
    "java":       "java",
    "kt":         "kotlin",
    "kts":        "kotlin",
    "c":          "c",
    "h":          "c",
    "cpp":        "cpp",
    "cc":         "cpp",
    "cxx":        "cpp",
    "hpp":        "cpp",
    "cs":         "csharp",
    "md":         "markdown",
    "mdx":        "markdown",
    "yaml":       "yaml",
    "yml":        "yaml",
    "toml":       "toml",
    "sh":         "shell",
    "bash":       "shell",
    "zsh":        "shell",
    "fish":       "shell",
    "bat":        "bat",
    "cmd":        "bat",
    "ps1":        "powershell",
    "psm1":       "powershell",
    "sql":        "sql",
    "sqlite":     "sql",
    "db":         "sql",
    "svg":        "svg",
    "png":        "image",
    "jpg":        "image",
    "jpeg":       "image",
    "gif":        "image",
    "webp":       "image",
    "ico":        "image",
    "bmp":        "image",
    "lock":       "lock",
    "log":        "log",
    "rb":         "file",
    "php":        "file",
    "swift":      "file",
    "dart":       "file",
    "xml":        "file",
    "txt":        "file",
    "csv":        "file",
    "pdf":        "file",
    "zip":        "file",
    "tar":        "file",
    "gz":         "file",
  };

  return EXT[ext] ?? "file";
}
