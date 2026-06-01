/**
 * McpSettings — configure MCP servers inside the Settings panel.
 * Additive: shown as a new "MCP" tab in Settings.
 */

import { useState } from "react";
import {
  Plus, Trash2, RefreshCw, Check, X, Plug, Globe, Terminal,
} from "lucide-react";
import type { MCPServerConfig, MCPTool } from "../utils/mcp";
import { mcpConnect } from "../utils/mcp";

interface Props {
  servers: MCPServerConfig[];
  onChange: (servers: MCPServerConfig[]) => void;
  projectPath?: string;
}

const PRESET_SERVERS: Omit<MCPServerConfig, "id" | "enabled" | "status">[] = [
  {
    name: "Filesystem",
    transport: "stdio",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-filesystem", "."],
    tools: [],
  },
  {
    name: "GitHub",
    transport: "stdio",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-github"],
    env: { GITHUB_PERSONAL_ACCESS_TOKEN: "" },
    tools: [],
  },
  {
    name: "SQLite",
    transport: "stdio",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-sqlite", "--db-path", "./database.db"],
    tools: [],
  },
  {
    name: "Custom HTTP",
    transport: "http",
    url: "http://localhost:3100/mcp",
    tools: [],
  },
];

export default function McpSettings({ servers, onChange, projectPath }: Props) {
  const [connecting, setConnecting] = useState<string | null>(null);
  const [showPresets, setShowPresets] = useState(false);

  const addServer = (preset?: typeof PRESET_SERVERS[0]) => {
    const id = `mcp-${Date.now()}`;
    const newServer: MCPServerConfig = preset
      ? { ...preset, id, enabled: false, status: "untested" }
      : { id, name: "New Server", transport: "http", url: "", enabled: false, status: "untested" };
    onChange([...servers, newServer]);
    setShowPresets(false);
  };

  const removeServer = (id: string) => onChange(servers.filter(s => s.id !== id));

  const update = (id: string, patch: Partial<MCPServerConfig>) =>
    onChange(servers.map(s => s.id === id ? { ...s, ...patch } : s));

  const testConnect = async (server: MCPServerConfig) => {
    setConnecting(server.id);
    try {
      const tools = await mcpConnect({ ...server }, projectPath);
      update(server.id, { tools, status: "connected", lastError: undefined });
    } catch (err) {
      update(server.id, { status: "error", lastError: String(err) });
    } finally {
      setConnecting(null);
    }
  };

  return (
    <div className="mcp-settings">
      <div className="mcp-header-row">
        <div>
          <p className="mcp-desc">
            Connect external tools via the <strong>Model Context Protocol</strong>.
            Punam can call these tools during conversations.
          </p>
        </div>
        <button className="btn-primary compact" onClick={() => setShowPresets(!showPresets)}>
          <Plus size={13} /> Add Server
        </button>
      </div>

      {/* Presets dropdown */}
      {showPresets && (
        <div className="mcp-presets">
          <span className="mcp-presets-title">Choose a preset or start blank:</span>
          {PRESET_SERVERS.map((preset, i) => (
            <button key={i} className="mcp-preset-item" onClick={() => addServer(preset)}>
              <span className="mcp-preset-name">{preset.name}</span>
              <span className="mcp-preset-transport">
                {preset.transport === "stdio" ? <Terminal size={11} /> : <Globe size={11} />}
                {preset.transport}
              </span>
            </button>
          ))}
          <button className="mcp-preset-item blank" onClick={() => addServer()}>
            <span className="mcp-preset-name">Blank (custom)</span>
          </button>
          <button className="btn-secondary compact" style={{ marginTop: 4 }} onClick={() => setShowPresets(false)}>
            Cancel
          </button>
        </div>
      )}

      {/* Server list */}
      {servers.length === 0 && !showPresets && (
        <div className="mcp-empty">
          <Plug size={32} className="mcp-empty-icon" />
          <p>No MCP servers configured.</p>
          <p className="mcp-empty-hint">Add a server to give Punam access to files, databases, APIs, and more.</p>
        </div>
      )}

      {servers.map((server) => (
        <div key={server.id} className={`mcp-server-card ${server.status}`}>
          {/* Card header */}
          <div className="mcp-card-header">
            <span className="mcp-transport-badge">
              {server.transport === "stdio" ? <Terminal size={11} /> : <Globe size={11} />}
              {server.transport}
            </span>
            <input
              className="mcp-name-input"
              value={server.name}
              onChange={e => update(server.id, { name: e.target.value })}
              placeholder="Server name"
            />
            <label className="mcp-toggle" title={server.enabled ? "Enabled" : "Disabled"}>
              <input
                type="checkbox"
                checked={server.enabled}
                onChange={e => update(server.id, { enabled: e.target.checked })}
              />
              <span className="mcp-toggle-knob" />
            </label>
            <button
              className="icon-btn small"
              onClick={() => removeServer(server.id)}
              title="Remove server"
            >
              <Trash2 size={13} />
            </button>
          </div>

          {/* Fields */}
          <div className="mcp-card-body">
            <div className="mcp-field-row">
              <label>Transport</label>
              <select
                className="mcp-select"
                value={server.transport}
                onChange={e => update(server.id, { transport: e.target.value as MCPServerConfig["transport"] })}
              >
                <option value="http">HTTP / SSE</option>
                <option value="stdio">Stdio (local process)</option>
              </select>
            </div>

            {server.transport === "http" && (
              <div className="mcp-field-row">
                <label>URL</label>
                <input
                  className="mcp-input"
                  value={server.url ?? ""}
                  onChange={e => update(server.id, { url: e.target.value })}
                  placeholder="http://localhost:3100/mcp"
                />
              </div>
            )}

            {server.transport === "stdio" && (
              <>
                <div className="mcp-field-row">
                  <label>Command</label>
                  <input
                    className="mcp-input"
                    value={server.command ?? ""}
                    onChange={e => update(server.id, { command: e.target.value })}
                    placeholder="npx, python, node, etc."
                  />
                </div>
                <div className="mcp-field-row">
                  <label>Args</label>
                  <input
                    className="mcp-input"
                    value={(server.args ?? []).join(" ")}
                    onChange={e => update(server.id, { args: e.target.value.split(" ").filter(Boolean) })}
                    placeholder="-y @modelcontextprotocol/server-filesystem ."
                  />
                </div>
              </>
            )}

            {/* Connect / status */}
            <div className="mcp-connect-row">
              <button
                className="btn-secondary compact"
                onClick={() => testConnect(server)}
                disabled={connecting === server.id}
              >
                {connecting === server.id ? (
                  <><RefreshCw size={12} className="spin" /> Connecting…</>
                ) : (
                  <><Plug size={12} /> Connect &amp; Discover Tools</>
                )}
              </button>

              {server.status === "connected" && (
                <span className="mcp-status connected">
                  <Check size={12} /> {server.tools?.length ?? 0} tool{server.tools?.length !== 1 ? "s" : ""}
                </span>
              )}
              {server.status === "error" && (
                <span className="mcp-status error" title={server.lastError}>
                  <X size={12} /> Error
                </span>
              )}
            </div>

            {/* Tool list */}
            {server.status === "connected" && server.tools && server.tools.length > 0 && (
              <div className="mcp-tools-list">
                {server.tools.map((tool: MCPTool) => (
                  <div key={tool.name} className="mcp-tool-chip" title={tool.description}>
                    {tool.name}
                  </div>
                ))}
              </div>
            )}

            {server.status === "error" && server.lastError && (
              <div className="mcp-error-text">{server.lastError.slice(0, 200)}</div>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}
