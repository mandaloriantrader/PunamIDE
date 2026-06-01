export type AgentTaskKind =
  | "workspace_scan"
  | "file_inspection"
  | "search"
  | "command"
  | "edit"
  | "debug"
  | "answer";

export type AgentExecutionRoute = "tool_loop" | "standard";

export interface AgentRuntimeDecision {
  kind: AgentTaskKind;
  route: AgentExecutionRoute;
  reason: string;
  readOnly: boolean;
}

const INTERNAL_AGENT_TOOL_NAMES = [
  "list_files",
  "read_file",
  "read_lines",
  "search_in_project",
  "run_command",
  "apply_patch",
  "write_file",
] as const;

const INTERNAL_TOOL_INTENT_PATTERNS = [
  /\binternal\s+(agent\s+)?tool\b/i,
  /\bagent\s+tool\s+named\b/i,
  /\btool\s+named\b/i,
  /\buse\s+the\s+.*\btool\b/i,
];

const COMMAND_PATTERNS = [
  /\b(run|start|execute|launch|open)\b/i,
  /\b(npm|pnpm|yarn|cargo|gradle|python|pytest|ruff|tsc|vite)\b/i,
  /\bcommand\b/i,
];

const EDIT_PATTERNS = [
  /\b(fix|change|update|modify|edit|refactor|rewrite|create|add|delete|remove|rename|implement)\b/i,
  /\bapply\b.*\b(patch|change|fix)\b/i,
];

const DEBUG_PATTERNS = [
  /\b(error|bug|fail|failing|failed|crash|exception|traceback|diagnose|debug|broken)\b/i,
  /\bbuild\b.*\b(fail|error|broken)\b/i,
];

const WORKSPACE_SCAN_PATTERNS = [
  /analy[sz]e.*(workspace|project|codebase|architecture)/i,
  /audit.*(project|codebase|code)/i,
  /dependency (analysis|map|graph|tree)/i,
  /project report/i,
  /codebase review/i,
  /architecture review/i,
  /list all (files|directories|modules|components)/i,
  /what (files|modules|packages) (are|exist|does)/i,
  /full (workspace|project) (scan|inventory)/i,
  /how many files/i,
  /project structure/i,
  /directory structure/i,
  /generate.*dependency (map|graph)/i,
  /provide.*overview/i,
];

const FILE_INSPECTION_PATTERNS = [
  /\b(read|inspect|show|open)\b.*\b(file|files|line|lines|module|component|package\.json|cargo\.toml)\b/i,
  /\bwhich file\b/i,
  /\bwhere (is|are|does)\b/i,
  /\bwhat.*line\s+\d+/i,
  /\bline\s+\d+/i,
  /\bcurrent file\b/i,
  /\bopen file\b/i,
  /\blook at\b/i,
];

const SEARCH_PATTERNS = [
  /\b(find|search|locate)\b.*\b(file|files|all|where|references|usage|usages|definition|related)\b/i,
  /\bfind all\b/i,
  /\bsearch for\b/i,
  /\brelated to\b/i,
];

function matchesAny(task: string, patterns: RegExp[]) {
  return patterns.some((pattern) => pattern.test(task));
}

export function getExplicitInternalToolNames(task: string): string[] {
  const normalized = task.toLowerCase();
  return INTERNAL_AGENT_TOOL_NAMES.filter((toolName) => normalized.includes(toolName));
}

export function hasExplicitInternalToolIntent(task: string): boolean {
  return getExplicitInternalToolNames(task).length > 0 || matchesAny(task, INTERNAL_TOOL_INTENT_PATTERNS);
}

export function classifyAgentTask(task: string): AgentTaskKind {
  const normalized = task.trim();

  if (hasExplicitInternalToolIntent(normalized)) return "workspace_scan";
  if (matchesAny(normalized, COMMAND_PATTERNS)) return "command";
  if (matchesAny(normalized, DEBUG_PATTERNS)) return "debug";
  if (matchesAny(normalized, EDIT_PATTERNS)) return "edit";
  if (matchesAny(normalized, WORKSPACE_SCAN_PATTERNS)) return "workspace_scan";
  if (matchesAny(normalized, SEARCH_PATTERNS)) return "search";
  if (matchesAny(normalized, FILE_INSPECTION_PATTERNS)) return "file_inspection";

  return "answer";
}

export function decideAgentRoute(task: string): AgentRuntimeDecision {
  const explicitTools = getExplicitInternalToolNames(task);
  if (explicitTools.length > 0) {
    const hasMutatingTool = explicitTools.some((toolName) => toolName === "run_command" || toolName === "apply_patch" || toolName === "write_file");
    if (hasMutatingTool) {
      return {
        kind: explicitTools.includes("run_command") ? "command" : "edit",
        route: "standard",
        reason: `User mentioned guarded internal tool(s): ${explicitTools.join(", ")}. Commands and edits must stay on the visible approval path.`,
        readOnly: false,
      };
    }

    return {
      kind: "workspace_scan",
      route: "tool_loop",
      reason: `User explicitly requested internal agent tool(s): ${explicitTools.join(", ")}.`,
      readOnly: true,
    };
  }

  const kind = classifyAgentTask(task);

  switch (kind) {
    case "workspace_scan":
      return {
        kind,
        route: "tool_loop",
        reason: "Workspace-wide inspection needs file listing/search tools.",
        readOnly: true,
      };
    case "file_inspection":
      return {
        kind,
        route: "tool_loop",
        reason: "File inspection should read/search the workspace instead of guessing.",
        readOnly: true,
      };
    case "search":
      return {
        kind,
        route: "tool_loop",
        reason: "Search tasks should use project search/list/read tools.",
        readOnly: true,
      };
    case "command":
      return {
        kind,
        route: "standard",
        reason: "Commands must go through the visible PowerShell approval/run flow.",
        readOnly: false,
      };
    case "edit":
      return {
        kind,
        route: "standard",
        reason: "Edits must go through the existing diff/approval workflow.",
        readOnly: false,
      };
    case "debug":
      return {
        kind,
        route: "standard",
        reason: "Debug/fix tasks may need edits or commands, so keep the guarded workflow.",
        readOnly: false,
      };
    default:
      return {
        kind,
        route: "standard",
        reason: "Simple answer can use the assembled project context.",
        readOnly: true,
      };
  }
}
