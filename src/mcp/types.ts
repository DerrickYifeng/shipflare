/**
 * MCP types for ShipFlare headless agent integration.
 * Ported from engine/services/mcp/types.ts (simplified).
 *
 * Note: @modelcontextprotocol/sdk is an optional dependency.
 * Install it to enable MCP features: pnpm add @modelcontextprotocol/sdk
 */

export type MCPTransport = 'stdio' | 'sse' | 'streamable-http';

export interface MCPServerConfig {
  /** Unique server name (used for tool namespacing). */
  name: string;
  /** Transport type. */
  transport: MCPTransport;
  /** Command to launch (for stdio transport). */
  command?: string;
  /** URL (for sse/http transport). */
  url?: string;
  /** Environment variables passed to the server process. */
  env?: Record<string, string>;
  /** Additional command arguments. */
  args?: string[];
}

export type MCPConnectionStatus = 'disconnected' | 'connecting' | 'connected' | 'error';

export interface MCPConnection {
  name: string;
  status: MCPConnectionStatus;
  /** Tool definitions discovered from this server. */
  tools: MCPToolSchema[];
  /** Error message if status is 'error'. */
  error?: string;
  /** Cleanup function to disconnect. */
  cleanup?: () => Promise<void>;
}

export interface MCPToolSchema {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface MCPToolCall {
  serverName: string;
  toolName: string;
  arguments: Record<string, unknown>;
}

export interface MCPToolResult {
  content: string;
  isError: boolean;
}
