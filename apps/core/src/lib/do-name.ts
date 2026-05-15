/**
 * Canonical Durable Object name for a per-user McpAgent.
 *
 * agents@0.12.4's McpAgent transport prepends `streamable-http:` to the
 * DO name when handling an HTTP MCP session (see
 * `streamableHttpProxy` in src/index.ts). For the /mcp route's DO and
 * any other route's DO (cron, /internal/*, peer-DM shadow) to land on
 * the SAME instance — so SQLite state is consistent — every lookup MUST
 * use this prefix.
 *
 * Tests that go through the Worker route (SELF.fetch) or that drive
 * cross-DO calls (logPeerDmShadow) MUST bootstrap with the same name.
 */
export function transportName(userId: string): string {
  return `streamable-http:${userId}`;
}
