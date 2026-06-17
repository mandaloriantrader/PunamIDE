/**
 * Language detection utility — maps 50+ file extensions to Monaco language IDs,
 * provides file icons and file colors for the UI.
 * Ported from Zenith IDE, adapted for Punam IDE.
 */

const EXT_TO_LANG: Record<string, string> = {
  py: "python",
  js: "javascript",
  jsx: "javascript",
  ts: "typescript",
  tsx: "typescript",
  rs: "rust",
  go: "go",
  java: "java",
  kt: "kotlin",
  kts: "kotlin",
  c: "c",
  cpp: "cpp",
  h: "c",
  hpp: "cpp",
  cs: "csharp",
  rb: "ruby",
  php: "php",
  swift: "swift",
  dart: "dart",
  html: "html",
  css: "css",
  scss: "scss",
  less: "less",
  json: "json",
  xml: "xml",
  yaml: "yaml",
  yml: "yaml",
  toml: "ini",
  md: "markdown",
  sql: "sql",
  sh: "shell",
  bash: "shell",
  zsh: "shell",
  fish: "shell",
  ps1: "powershell",
  dockerfile: "dockerfile",
  gradle: "groovy",
  lua: "lua",
  r: "r",
  scala: "scala",
  clj: "clojure",
  ex: "elixir",
  exs: "elixir",
  erl: "erlang",
  hs: "haskell",
  ml: "fsharp",
  vue: "html",
  svelte: "html",
  astro: "html",
  prisma: "graphql",
  graphql: "graphql",
  gql: "graphql",
  tf: "hcl",
  proto: "protobuf",
  zig: "c",
  nim: "nim",
  v: "v",
};

const FILE_ICONS: Record<string, string> = {
  ts: "TS",
  tsx: "TX",
  js: "JS",
  jsx: "JX",
  py: "PY",
  rs: "RS",
  go: "GO",
  java: "JA",
  kt: "KT",
  json: "{}",
  html: "<>",
  css: "#",
  md: "MD",
  yaml: "YM",
  yml: "YM",
  toml: "TM",
  sql: "SQ",
  sh: "$",
  dockerfile: "DK",
  vue: "VU",
  svelte: "SV",
  dart: "DA",
  swift: "SW",
  cpp: "C+",
  c: "C",
  rb: "RB",
  php: "PH",
  lua: "LU",
  r: "R",
  scala: "SC",
};

const FILE_COLORS: Record<string, string> = {
  ts: "#3178c6",
  tsx: "#3178c6",
  js: "#f7df1e",
  jsx: "#f7df1e",
  py: "#3776ab",
  rs: "#dea584",
  go: "#00add8",
  java: "#b07219",
  kt: "#a97bff",
  json: "#a6e3a1",
  html: "#e34c26",
  css: "#563d7c",
  md: "#083fa1",
  vue: "#4fc08d",
  svelte: "#ff3e00",
  dart: "#00b4ab",
  swift: "#f05138",
  rb: "#cc342d",
  php: "#4f5d95",
  lua: "#000080",
  scala: "#dc322f",
  zig: "#f7a41d",
};

/**
 * Get Monaco language ID from a filename.
 */
export function getLanguageFromFilename(filename: string): string {
  const ext = filename.split(".").pop()?.toLowerCase() || "";
  const name = filename.toLowerCase();
  if (name === "dockerfile") return "dockerfile";
  if (name === "makefile") return "makefile";
  if (name === "cmakelists.txt") return "cmake";
  if (name.endsWith(".env") || name === ".env.example") return "ini";
  return EXT_TO_LANG[ext] || "plaintext";
}

/**
 * Get a short icon label for a file extension.
 */
export function getFileIconLabel(filename: string): string | null {
  const ext = filename.split(".").pop()?.toLowerCase() || "";
  return FILE_ICONS[ext] || null;
}

/**
 * Get a color associated with a file type.
 */
export function getFileColor(filename: string): string {
  const ext = filename.split(".").pop()?.toLowerCase() || "";
  return FILE_COLORS[ext] || "#8b949e";
}
