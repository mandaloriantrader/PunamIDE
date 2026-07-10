/**
 * Curated MCP Server Directory — pre-configured servers that users can add with one click.
 * Each entry has everything needed to connect: command, args, description.
 */

import type { MCPServerConfig } from "./mcp";

export interface CuratedMCPServer {
  id: string;
  name: string;
  description: string;
  category: "filesystem" | "database" | "api" | "search" | "devtools" | "ai" | "cloud" | "docs";
  command: string;
  args: string[];
  env?: Record<string, string>;
  requiresConfig?: string[]; // env vars user must provide
  installHint?: string;
}

export const CURATED_MCP_SERVERS: CuratedMCPServer[] = [
  // ─── Filesystem & Project ─────────────────────────────────────────────────
  {
    id: "mcp-filesystem",
    name: "Filesystem",
    description: "Read, write, and manage files in allowed directories",
    category: "filesystem",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-filesystem", "."],
  },
  {
    id: "mcp-git",
    name: "Git Operations",
    description: "Git commands: status, diff, commit, branch, log",
    category: "devtools",
    command: "uvx",
    args: ["mcp-server-git"],
  },

  // ─── Database ─────────────────────────────────────────────────────────────
  {
    id: "mcp-sqlite",
    name: "SQLite",
    description: "Query and manage SQLite databases",
    category: "database",
    command: "uvx",
    args: ["mcp-server-sqlite"],
  },
  {
    id: "mcp-postgres",
    name: "PostgreSQL",
    description: "Query PostgreSQL databases",
    category: "database",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-postgres"],
    requiresConfig: ["DATABASE_URL"],
    installHint: "Set DATABASE_URL environment variable to your connection string",
  },

  // ─── Search & Knowledge ───────────────────────────────────────────────────
  {
    id: "mcp-brave-search",
    name: "Brave Search",
    description: "Web search via Brave Search API",
    category: "search",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-brave-search"],
    requiresConfig: ["BRAVE_API_KEY"],
    installHint: "Get a free API key from https://brave.com/search/api/",
  },
  {
    id: "mcp-fetch",
    name: "Web Fetch",
    description: "Fetch and parse web pages, extract content from URLs",
    category: "search",
    command: "uvx",
    args: ["mcp-server-fetch"],
  },
  {
    id: "mcp-memory",
    name: "Knowledge Graph Memory",
    description: "Persistent memory using a local knowledge graph",
    category: "ai",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-memory"],
  },

  // ─── Development Tools ────────────────────────────────────────────────────
  {
    id: "mcp-puppeteer",
    name: "Puppeteer (Browser)",
    description: "Automate browser interactions, take screenshots, scrape pages",
    category: "devtools",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-puppeteer"],
  },
  {
    id: "mcp-sequential-thinking",
    name: "Sequential Thinking",
    description: "Dynamic problem-solving through thought sequences",
    category: "ai",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-sequential-thinking"],
  },

  // ─── Cloud & APIs ─────────────────────────────────────────────────────────
  {
    id: "mcp-github",
    name: "GitHub",
    description: "GitHub API: repos, issues, PRs, file operations",
    category: "cloud",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-github"],
    requiresConfig: ["GITHUB_PERSONAL_ACCESS_TOKEN"],
    installHint: "Create a personal access token at https://github.com/settings/tokens",
  },
  {
    id: "mcp-slack",
    name: "Slack",
    description: "Read and send Slack messages, manage channels",
    category: "cloud",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-slack"],
    requiresConfig: ["SLACK_BOT_TOKEN"],
    installHint: "Create a Slack app and get a bot token",
  },

  // ─── Documentation ────────────────────────────────────────────────────────
  {
    id: "mcp-aws-docs",
    name: "AWS Documentation",
    description: "Search and read AWS documentation",
    category: "docs",
    command: "uvx",
    args: ["awslabs.aws-documentation-mcp-server@latest"],
    env: { FASTMCP_LOG_LEVEL: "ERROR" },
  },
  {
    id: "mcp-context7",
    name: "Context7 (Library Docs)",
    description: "Up-to-date documentation for any library/framework",
    category: "docs",
    command: "npx",
    args: ["-y", "@upstash/context7-mcp@latest"],
  },
];

/**
 * Convert a curated server entry to the MCPServerConfig format used by the app.
 */
export function curatedToConfig(server: CuratedMCPServer, envOverrides?: Record<string, string>): MCPServerConfig {
  return {
    id: server.id,
    name: server.name,
    transport: "stdio",
    command: server.command,
    args: server.args,
    env: { ...(server.env || {}), ...(envOverrides || {}) },
    enabled: true,
    tools: [],
    status: "untested",
  };
}

/**
 * Get servers grouped by category for UI display.
 */
export function getServersByCategory(): Record<string, CuratedMCPServer[]> {
  const grouped: Record<string, CuratedMCPServer[]> = {};
  for (const server of CURATED_MCP_SERVERS) {
    if (!grouped[server.category]) grouped[server.category] = [];
    grouped[server.category].push(server);
  }
  return grouped;
}
