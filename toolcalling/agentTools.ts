import { invoke } from "@tauri-apps/api/core";

export type AgentToolName =
  | "list_files"
  | "read_file"
  | "read_lines"
  | "search_file"
  | "search_project"
  | "write_file"
  | "apply_patch"
  | "run_command";

export interface AgentToolCall {
  id?: string;
  name: AgentToolName;
  arguments: Record<string, any>;
}

export interface AgentToolResult {
  tool: AgentToolName;
  success: boolean;
  result?: any;
  error?: string;
}

export const AGENT_TOOLS = [
  {
    name: "list_files",
    description: "List project files. Use before searching unknown project structure.",
    parameters: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "read_file",
    description: "Read full file only when absolutely necessary.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string" },
      },
      required: ["path"],
    },
  },
  {
    name: "read_lines",
    description: "Read selected line range from a file. Prefer this over read_file.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string" },
        from: { type: "number" },
        to: { type: "number" },
      },
      required: ["path", "from", "to"],
    },
  },
  {
    name: "search_file",
    description: "Search text inside one file.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string" },
        query: { type: "string" },
      },
      required: ["path", "query"],
    },
  },
  {
    name: "search_project",
    description: "Search text across the whole project.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string" },
      },
      required: ["query"],
    },
  },
  {
    name: "write_file",
    description: "Overwrite a file. Use only when creating new files or full rewrite is explicitly requested.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string" },
        content: { type: "string" },
      },
      required: ["path", "content"],
    },
  },
  {
    name: "apply_patch",
    description: "Replace specific line range in file. Preferred editing method.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string" },
        from: { type: "number" },
        to: { type: "number" },
        replacement: { type: "string" },
      },
      required: ["path", "from", "to", "replacement"],
    },
  },
  {
    name: "run_command",
    description: "Run terminal command only when needed for validation/build/test.",
    parameters: {
      type: "object",
      properties: {
        command: { type: "string" },
      },
      required: ["command"],
    },
  },
];

export async function executeAgentTool(call: AgentToolCall): Promise<AgentToolResult> {
  try {
    const args = call.arguments || {};

    switch (call.name) {
      case "list_files":
        return ok(call.name, await invoke("agent_list_files"));

      case "read_file":
        return ok(call.name, await invoke("agent_read_file", { path: args.path }));

      case "read_lines":
        return ok(
          call.name,
          await invoke("agent_read_lines", {
            path: args.path,
            from: args.from,
            to: args.to,
          })
        );

      case "search_file":
        return ok(
          call.name,
          await invoke("agent_search_file", {
            path: args.path,
            query: args.query,
          })
        );

      case "search_project":
        return ok(
          call.name,
          await invoke("agent_search_project", {
            query: args.query,
          })
        );

      case "write_file":
        return ok(
          call.name,
          await invoke("agent_write_file", {
            path: args.path,
            content: args.content,
          })
        );

      case "apply_patch":
        return ok(
          call.name,
          await invoke("agent_apply_patch", {
            path: args.path,
            from: args.from,
            to: args.to,
            replacement: args.replacement,
          })
        );

      case "run_command":
        return ok(
          call.name,
          await invoke("agent_run_command", {
            command: args.command,
          })
        );

      default:
        return fail(call.name, "Unknown tool");
    }
  } catch (err: any) {
    return fail(call.name, String(err?.message || err));
  }
}

function ok(tool: AgentToolName, result: any): AgentToolResult {
  return { tool, success: true, result };
}

function fail(tool: AgentToolName, error: string): AgentToolResult {
  return { tool, success: false, error };
}