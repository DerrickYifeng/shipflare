import { MCPClient } from './client';
import type { MCPServerConfig, MCPToolResult } from './types';
import type { ToolRegistry } from '@/core/tool-system';
import { buildTool } from '@/core/tool-system';
import { z } from 'zod';
import { createLogger } from '@/lib/logger';

const log = createLogger('mcp');

const MAX_RECONNECT_ATTEMPTS = 5;
const INITIAL_RECONNECT_DELAY = 1000;
const MAX_RECONNECT_DELAY = 30_000;

/**
 * MCP connection lifecycle manager.
 * Ported from engine/services/mcp/MCPConnectionManager.tsx.
 *
 * Manages multiple MCP server connections with:
 * - Reconnection with exponential backoff
 * - Graceful cleanup on shutdown
 * - Tool namespacing: mcp__{serverName}__{toolName}
 */
export class MCPManager {
  private readonly clients = new Map<string, MCPClient>();

  /** Connect to all configured MCP servers. */
  async connectAll(configs: MCPServerConfig[]): Promise<void> {
    const results = await Promise.allSettled(
      configs.map((config) => this.connectOne(config)),
    );

    for (let i = 0; i < results.length; i++) {
      const result = results[i]!;
      if (result.status === 'rejected') {
        const name = configs[i]!.name;
        log.error(`Failed to connect to ${name}: ${result.reason}`);
      } else {
        log.info(`Connected to MCP server "${configs[i]!.name}"`);
      }
    }
  }

  /** Disconnect all MCP servers. */
  async disconnectAll(): Promise<void> {
    const disconnects = Array.from(this.clients.values()).map((client) =>
      client.disconnect().catch(() => {}),
    );
    await Promise.all(disconnects);
    this.clients.clear();
    log.info('All MCP servers disconnected');
  }

  /** Get all tools from all connected servers (with namespace prefix). */
  getAvailableTools(): Array<{ serverName: string; toolName: string; description: string; inputSchema: Record<string, unknown> }> {
    const tools: Array<{ serverName: string; toolName: string; description: string; inputSchema: Record<string, unknown> }> = [];

    for (const [serverName, client] of this.clients) {
      if (client.status !== 'connected') continue;
      for (const tool of client.tools) {
        tools.push({
          serverName,
          toolName: tool.name,
          description: tool.description,
          inputSchema: tool.inputSchema,
        });
      }
    }

    return tools;
  }

  /**
   * Register all MCP tools with a ToolRegistry.
   * Each tool is namespaced as mcp__{serverName}__{toolName}.
   */
  registerWithRegistry(registry: ToolRegistry): void {
    for (const [serverName, client] of this.clients) {
      if (client.status !== 'connected') continue;

      for (const mcpTool of client.tools) {
        const namespacedName = `mcp__${serverName}__${mcpTool.name}`;
        const capturedClient = client;
        const capturedToolName = mcpTool.name;

        const tool = buildTool({
          name: namespacedName,
          description: `[MCP:${serverName}] ${mcpTool.description}`,
          isConcurrencySafe: true,
          isReadOnly: true,
          inputSchema: z.record(z.unknown()),
          async execute(input) {
            const result = await capturedClient.callTool(capturedToolName, input as Record<string, unknown>);
            if (result.isError) {
              throw new Error(result.content);
            }
            return result.content;
          },
        });

        registry.register(tool);
      }
    }
  }

  /** Call a tool on a specific MCP server. */
  async callTool(serverName: string, toolName: string, args: Record<string, unknown>): Promise<MCPToolResult> {
    const client = this.clients.get(serverName);
    if (!client) {
      return { content: `MCP server not found: ${serverName}`, isError: true };
    }
    if (client.status !== 'connected') {
      return { content: `MCP server not connected: ${serverName} (${client.status})`, isError: true };
    }
    return client.callTool(toolName, args);
  }

  /** Connect a single MCP server with reconnection logic. */
  private async connectOne(config: MCPServerConfig): Promise<void> {
    const client = new MCPClient(config);
    this.clients.set(config.name, client);

    let attempt = 0;
    let delay = INITIAL_RECONNECT_DELAY;

    while (attempt < MAX_RECONNECT_ATTEMPTS) {
      try {
        await client.connect();
        return;
      } catch (error) {
        attempt++;
        if (attempt >= MAX_RECONNECT_ATTEMPTS) throw error;

        await new Promise((resolve) => setTimeout(resolve, delay));
        delay = Math.min(delay * 2, MAX_RECONNECT_DELAY);
      }
    }
  }
}
