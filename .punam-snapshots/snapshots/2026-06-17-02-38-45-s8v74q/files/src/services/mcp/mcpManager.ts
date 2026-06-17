/**
 * MCP Manager — Multi-server lifecycle management.
 * Connects, disconnects, health-checks multiple MCP servers.
 * Uses the protocol client from utils/mcp.ts.
 */

import type { MCPServerConfig, MCPTool } from "../../utils/mcp";
import { mcpConnect } from "../../utils/mcp";

export interface MCPServerState {
  config: MCPServerConfig;
  connected: boolean;
  tools: MCPTool[];
  lastError?: string;
}

type StatusListener = (serverId: string, status: string, error?: string) => void;

class McpManager {
  private servers = new Map<string, MCPServerState>();
  private listeners: StatusListener[] = [];
  private projectPath = ".";

  /** Register server configs (preserves already-connected state if same id). */
  setServers(configs: MCPServerConfig[]): void {
    this.servers.clear();
    for (const cfg of configs) {
      this.servers.set(cfg.id, {
        config: cfg,
        connected: false,
        tools: cfg.tools || [],
        lastError: cfg.lastError,
      });
    }
  }

  setProjectPath(path: string): void {
    this.projectPath = path;
  }

  getServers(): MCPServerConfig[] {
    return [...this.servers.values()].map((s) => ({
      ...s.config,
      tools: s.tools,
      status: s.connected ? "connected" as const : s.lastError ? "error" as const : "untested" as const,
      lastError: s.lastError,
    }));
  }

  getServer(id: string): MCPServerState | undefined {
    return this.servers.get(id);
  }

  onStatus(listener: StatusListener): () => void {
    this.listeners.push(listener);
    return () => { this.listeners = this.listeners.filter((l) => l !== listener); };
  }

  private emit(serverId: string, status: string, error?: string): void {
    for (const l of this.listeners) {
      l(serverId, status, error);
    }
  }

  /** Connect a single server and discover its tools. */
  async connect(id: string): Promise<MCPTool[]> {
    const state = this.servers.get(id);
    if (!state) throw new Error(`MCP server "${id}" not found`);

    this.emit(id, "connecting");

    try {
      const tools = await mcpConnect(state.config, this.projectPath);
      state.connected = true;
      state.tools = tools;
      state.lastError = undefined;
      this.emit(id, "connected");
      return tools;
    } catch (err) {
      const msg = String(err);
      state.connected = false;
      state.lastError = msg;
      this.emit(id, "error", msg);
      throw err;
    }
  }

  /** Connect all enabled servers. */
  async connectAll(): Promise<Map<string, MCPTool[]>> {
    const results = new Map<string, MCPTool[]>();

    for (const [id, state] of this.servers) {
      if (!state.config.enabled) continue;

      try {
        const tools = await this.connect(id);
        results.set(id, tools);
      } catch {
        // Individual failures are already emitted — continue connecting others
      }
    }

    return results;
  }

  /** Disconnect a server. */
  disconnect(id: string): void {
    const state = this.servers.get(id);
    if (!state) return;

    state.connected = false;
    state.tools = [];
    this.emit(id, "disconnected");
  }

  /** Get all tools across all connected servers. */
  getAllTools(): Map<string, MCPTool[]> {
    const result = new Map<string, MCPTool[]>();
    for (const [id, state] of this.servers) {
      if (state.connected && state.tools.length > 0) {
        result.set(id, state.tools);
      }
    }
    return result;
  }

  /** Find which server owns a tool by name. */
  findToolOwner(toolName: string): string | null {
    for (const [id, state] of this.servers) {
      if (state.connected && state.tools.some((t) => t.name === toolName)) {
        return id;
      }
    }
    return null;
  }

  /** Check if any server is connected. */
  hasConnectedServers(): boolean {
    return [...this.servers.values()].some((s) => s.connected);
  }
}

export const mcpManager = new McpManager();