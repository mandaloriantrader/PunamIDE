/**
 * MCP Tool Executor — Dynamic MCP tool routing for the JSON tool loop.
 *
 * Called from jsonToolLoop.ts's default case to route unknown tool names
 * through connected MCP servers. Imports are dynamic to avoid circular deps.
 */

import { invoke } from "@tauri-apps/api/core";
import type { MCPServerConfig } from "../../utils/mcp";

/** Try to execute a tool through connected MCP servers. Returns null if no MCP server handles it. */
export async function tryMcpTool(
  toolName: string,
  input: Record<string, unknown>,
  projectPath: string
): Promise<string | null> {
  try {
    // Dynamic import to avoid circular dependency with mcpManager
    const { mcpManager } = await import("./mcpManager");
    const { mcpCallTool, formatMcpResult } = await import("../../utils/mcp");

    const ownerId = mcpManager.findToolOwner(toolName);
    if (!ownerId) return null;

    const server = mcpManager.getServer(ownerId);
    if (!server?.config) return null;

    const result = await mcpCallTool(server.config, toolName, input, projectPath);
    return formatMcpResult(toolName, result);
  } catch {
    return null;
  }
}

/**
 * Build the MCP tools prompt section to append to the system prompt.
 * Returns empty string if no MCP servers are connected.
 */
export async function buildMcpToolsPromptSection(): Promise<string> {
  try {
    const { mcpManager } = await import("./mcpManager");
    if (!mcpManager.hasConnectedServers()) return "";

    const allTools = mcpManager.getAllTools();
    if (allTools.size === 0) return "";

    const lines: string[] = [
      "",
      "## MCP TOOLS (External)",
      "You also have access to external MCP tools. Call them the same way:",
      '```json\n{"tool": "tool_name", "input": {"arg": "value"}}\n```',
      "",
    ];

    for (const [serverId, tools] of allTools) {
      const state = mcpManager.getServer(serverId);
      const name = state?.config.name || serverId;
      lines.push(`### ${name}`);
      for (const tool of tools) {
        lines.push(`- **${tool.name}**: ${tool.description}`);
      }
      lines.push("");
    }

    return lines.join("\n");
  } catch {
    return "";
  }
}