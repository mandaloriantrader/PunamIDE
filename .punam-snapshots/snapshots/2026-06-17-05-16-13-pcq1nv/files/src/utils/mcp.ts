/**
 * MCP (Model Context Protocol) client for PunamIDE.
 *
 * Supports:
 *   - HTTP/SSE transport  (POST to a URL with JSON-RPC body)
 *   - Stdio transport     (launch a local process, communicate over a one-shot wrapper)
 *
 * For stdio, we use the terminal's runTerminalCommand to call the server's
 * CLI with --jsonrpc flag (works with most modern MCP servers like
 * @modelcontextprotocol/server-filesystem, etc.).
 *
 * The stdio approach: echo the JSON-RPC request | npx <server> --stdio
 * Many MCP servers support this one-shot mode.
 */

import { runTerminalCommand } from "./tauri";

// ── Types ─────────────────────────────────────────────────────────────────────

export type MCPTransport = "http" | "stdio";

export interface MCPServerConfig {
  id: string;
  name: string;
  transport: MCPTransport;
  /** For HTTP: full URL like http://localhost:3100/mcp */
  url?: string;
  /** For stdio: command to run, e.g. "npx @modelcontextprotocol/server-filesystem" */
  command?: string;
  /** Extra args for stdio */
  args?: string[];
  /** Env vars for stdio */
  env?: Record<string, string>;
  enabled: boolean;
  /** Auto-discovered tools (cached after connect) */
  tools?: MCPTool[];
  /** Connection status */
  status?: "connected" | "error" | "untested";
  lastError?: string;
}

export interface MCPTool {
  name: string;
  description: string;
  inputSchema: {
    type: "object";
    properties?: Record<string, { type: string; description?: string }>;
    required?: string[];
  };
}

export interface MCPCallResult {
  success: boolean;
  content?: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }>;
  error?: string;
  isError?: boolean;
}

// ── JSON-RPC helpers ──────────────────────────────────────────────────────────

let _rpcId = 1;
function nextId() { return _rpcId++; }

function rpcRequest(method: string, params?: unknown) {
  return { jsonrpc: "2.0", id: nextId(), method, params: params ?? {} };
}

// ── HTTP Transport ────────────────────────────────────────────────────────────

async function httpRpc(url: string, body: unknown): Promise<unknown> {
  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Accept": "application/json, text/event-stream" },
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`HTTP ${resp.status}: ${text.slice(0, 200)}`);
  }

  const ct = resp.headers.get("content-type") || "";

  // SSE streaming: collect all data: lines
  if (ct.includes("text/event-stream")) {
    const text = await resp.text();
    const lines = text.split("\n").filter(l => l.startsWith("data: "));
    for (const line of lines.reverse()) {
      const json = line.slice(6).trim();
      if (json && json !== "[DONE]") {
        try { return JSON.parse(json); } catch { /* skip */ }
      }
    }
    throw new Error("No valid data in SSE response");
  }

  return resp.json();
}

// ── Stdio Transport ───────────────────────────────────────────────────────────

async function stdioRpc(
  server: MCPServerConfig,
  body: unknown,
  cwd = ""
): Promise<unknown> {
  if (!server.command) throw new Error("No command configured");

  // Build env prefix for Windows cmd
  const envPrefix = server.env
    ? Object.entries(server.env).map(([k, v]) => `set ${k}=${v} &&`).join(" ")
    : "";

  const args = (server.args ?? []).join(" ");
  const jsonPayload = JSON.stringify(body).replace(/"/g, '\\"');

  // One-shot: echo the JSON-RPC request and pipe to the server
  // Works with servers that accept --stdio and read from stdin
  const cmd = `echo "${jsonPayload}" | ${envPrefix} ${server.command} ${args} --stdio`.trim();

  const result = await runTerminalCommand(cmd, cwd || ".");
  const output = (result.stdout + result.stderr).trim();

  // Parse first valid JSON object from output
  for (const line of output.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.startsWith("{")) {
      try { return JSON.parse(trimmed); } catch { /* skip */ }
    }
  }
  throw new Error(`No JSON in output: ${output.slice(0, 300)}`);
}

async function callRpc(
  server: MCPServerConfig,
  body: unknown,
  cwd?: string
): Promise<unknown> {
  if (server.transport === "http") {
    if (!server.url) throw new Error("No URL configured");
    return httpRpc(server.url, body);
  }
  return stdioRpc(server, body, cwd);
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Initialize a connection and return the list of available tools.
 * Updates server.tools and server.status in place.
 */
export async function mcpConnect(
  server: MCPServerConfig,
  cwd?: string
): Promise<MCPTool[]> {
  // 1. Initialize
  const initResp = await callRpc(server, rpcRequest("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: { roots: { listChanged: false }, sampling: {} },
    clientInfo: { name: "PunamIDE", version: "2.0" },
  }), cwd) as { result?: { capabilities?: unknown } };

  if (!initResp?.result) throw new Error("Initialize failed");

  // 2. List tools
  const toolsResp = await callRpc(server, rpcRequest("tools/list"), cwd) as {
    result?: { tools?: MCPTool[] };
  };

  const tools: MCPTool[] = toolsResp?.result?.tools ?? [];
  server.tools = tools;
  server.status = "connected";
  server.lastError = undefined;
  return tools;
}

/**
 * Call a single MCP tool and return the result.
 */
export async function mcpCallTool(
  server: MCPServerConfig,
  toolName: string,
  args: Record<string, unknown>,
  cwd?: string
): Promise<MCPCallResult> {
  try {
    const resp = await callRpc(server, rpcRequest("tools/call", {
      name: toolName,
      arguments: args,
    }), cwd) as { result?: { content?: MCPCallResult["content"]; isError?: boolean } };

    if (!resp?.result) {
      return { success: false, error: "Empty response from MCP server" };
    }

    return {
      success: !resp.result.isError,
      content: resp.result.content,
      isError: resp.result.isError,
    };
  } catch (err) {
    return { success: false, error: String(err) };
  }
}

/**
 * Format MCP tool results as a string for AI context injection.
 */
export function formatMcpResult(toolName: string, result: MCPCallResult): string {
  if (!result.success) {
    return `# MCP Tool Error: ${toolName}\n${result.error}`;
  }
  const parts: string[] = [`# MCP Tool Result: ${toolName}`];
  for (const item of result.content ?? []) {
    if (item.type === "text") parts.push(item.text);
    else if (item.type === "image") parts.push(`[Image: ${item.mimeType}]`);
  }
  return parts.join("\n");
}

/**
 * Build the system prompt section describing available MCP tools.
 */
export function buildMcpToolsPrompt(servers: MCPServerConfig[]): string {
  const activeServers = servers.filter(s => s.enabled && s.tools && s.tools.length > 0);
  if (activeServers.length === 0) return "";

  const lines: string[] = [
    "## MCP Tools Available",
    "You have access to external MCP tools. To call a tool, use this EXACT format:",
    "```",
    "===MCP_CALL: server_id.tool_name",
    '{"arg1": "value1", "arg2": "value2"}',
    "===END_MCP===",
    "```",
    "After calling a tool, wait for the result before continuing.",
    "",
  ];

  for (const server of activeServers) {
    lines.push(`### Server: ${server.name} (id: ${server.id})`);
    for (const tool of server.tools!) {
      lines.push(`**${tool.name}**: ${tool.description}`);
      const props = tool.inputSchema?.properties ?? {};
      const required = tool.inputSchema?.required ?? [];
      const paramLines = Object.entries(props).map(([k, v]) =>
        `  - ${k}${required.includes(k) ? " (required)" : ""}: ${v.type}${v.description ? ` — ${v.description}` : ""}`
      );
      if (paramLines.length) lines.push(...paramLines);
    }
    lines.push("");
  }

  return lines.join("\n");
}

/**
 * Parse MCP tool call blocks from an AI response.
 * Returns array of { serverId, toolName, args } for each call found.
 */
export function parseMcpCalls(text: string): Array<{
  serverId: string;
  toolName: string;
  args: Record<string, unknown>;
  raw: string;
}> {
  const results: Array<{ serverId: string; toolName: string; args: Record<string, unknown>; raw: string }> = [];
  const pattern = /===MCP_CALL:\s*([a-zA-Z0-9_-]+)\.([a-zA-Z0-9_/-]+)\s*\n([\s\S]*?)===END_MCP===/g;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(text)) !== null) {
    const serverId = match[1].trim();
    const toolName = match[2].trim();
    const argsRaw = match[3].trim();
    let args: Record<string, unknown> = {};
    try { args = JSON.parse(argsRaw); } catch { /* bad JSON, skip */ }
    results.push({ serverId, toolName, args, raw: match[0] });
  }

  return results;
}
