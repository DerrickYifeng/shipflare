import type { MCPServerConfig, MCPConnection, MCPToolSchema, MCPToolResult, MCPConnectionStatus } from './types';

/**
 * Minimal structural types for the MCP SDK's Client surface we consume.
 * The SDK is imported dynamically so we can't reuse its real types without
 * adding a hard dependency — these mirror the shapes listTools/callTool
 * actually return (per MCP spec) and keep the `as any` casts out of the
 * call sites.
 */
interface MCPContentPart {
  type: string;
  text?: string;
}
interface MCPListToolsResult {
  tools?: Array<{
    name: string;
    description?: string;
    inputSchema?: MCPToolSchema['inputSchema'];
  }>;
}
interface MCPCallToolResult {
  content?: MCPContentPart[];
  isError?: boolean;
}
interface MCPSdkClient {
  connect(transport: unknown): Promise<void>;
  close(): Promise<void>;
  listTools(): Promise<MCPListToolsResult>;
  callTool(args: { name: string; arguments: Record<string, unknown> }): Promise<MCPCallToolResult>;
}

/**
 * Headless MCP client using @modelcontextprotocol/sdk.
 * Ported from engine/services/mcp/client.ts.
 *
 * Stripped: React hooks, terminal notifications, batched state updates,
 * channel permissions, VSCode SDK transport.
 * Kept: stdio/sse/http transport creation, connection lifecycle, tool schema normalization.
 *
 * IMPORTANT: Requires @modelcontextprotocol/sdk to be installed.
 * This module will throw at runtime if the SDK is not available.
 */
export class MCPClient {
  private client: MCPSdkClient | null = null;
  private transport: unknown = null;
  private _status: MCPConnectionStatus = 'disconnected';
  private _tools: MCPToolSchema[] = [];
  private _error?: string;

  constructor(private readonly config: MCPServerConfig) {}

  get status(): MCPConnectionStatus {
    return this._status;
  }

  get tools(): MCPToolSchema[] {
    return this._tools;
  }

  get error(): string | undefined {
    return this._error;
  }

  /** Connect to the MCP server and discover tools. */
  async connect(): Promise<void> {
    this._status = 'connecting';

    try {
      // Dynamic import — @modelcontextprotocol/sdk
      const sdk = await import('@modelcontextprotocol/sdk/client/index.js').catch(() => {
        throw new Error(
          'MCP SDK not installed. Run: pnpm add @modelcontextprotocol/sdk',
        );
      });

      const { Client } = sdk;
      this.client = new Client({ name: `shipflare-${this.config.name}`, version: '1.0.0' }) as unknown as MCPSdkClient;
      this.transport = await this.createTransport();

      await this.client.connect(this.transport);
      this._status = 'connected';

      // Discover tools
      const result = await this.client.listTools();
      this._tools = (result.tools ?? []).map((t) => ({
        name: t.name,
        description: t.description ?? '',
        inputSchema: t.inputSchema ?? { type: 'object', properties: {} },
      }));
    } catch (error) {
      this._status = 'error';
      this._error = error instanceof Error ? error.message : String(error);
      throw error;
    }
  }

  /** Disconnect from the MCP server. */
  async disconnect(): Promise<void> {
    if (this.client) {
      try {
        await this.client.close();
      } catch {
        // Ignore close errors
      }
    }
    this.client = null;
    this.transport = null;
    this._status = 'disconnected';
    this._tools = [];
  }

  /** Call a tool on this MCP server. */
  async callTool(name: string, args: Record<string, unknown>): Promise<MCPToolResult> {
    if (!this.client || this._status !== 'connected') {
      return { content: 'MCP client not connected', isError: true };
    }

    try {
      const result = await this.client.callTool({ name, arguments: args });

      const content = (result.content ?? [])
        .map((c) => {
          if (c.type === 'text') return c.text ?? '';
          return JSON.stringify(c);
        })
        .join('\n');

      return { content, isError: result.isError ?? false };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { content: `MCP tool error: ${message}`, isError: true };
    }
  }

  /** Create the appropriate transport based on config. */
  private async createTransport(): Promise<unknown> {
    switch (this.config.transport) {
      case 'stdio': {
        const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');
        return new StdioClientTransport({
          command: this.config.command!,
          args: this.config.args,
          env: this.config.env as Record<string, string>,
        });
      }
      case 'sse': {
        const { SSEClientTransport } = await import('@modelcontextprotocol/sdk/client/sse.js');
        return new SSEClientTransport(new URL(this.config.url!));
      }
      case 'streamable-http': {
        const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js');
        return new StreamableHTTPClientTransport(new URL(this.config.url!));
      }
      default:
        throw new Error(`Unsupported MCP transport: ${this.config.transport}`);
    }
  }

  /** Get connection info for debugging. */
  toConnection(): MCPConnection {
    return {
      name: this.config.name,
      status: this._status,
      tools: this._tools,
      error: this._error,
    };
  }
}
