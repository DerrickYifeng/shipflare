import type { Env } from "../index";

/**
 * Spike #3 sentinel handler.
 *
 * The actual MCP Streamable HTTP transport is mounted at
 * `/external-mcp/:userId/mcp` (see `src/index.ts`). This handler at
 * `/spike/03` just returns guidance: tests hit the `/external-mcp/`
 * route directly via `SELF.fetch`, and manual validation runs through
 * `@modelcontextprotocol/inspector`.
 */
export default async function handler(
  _req: Request,
  _env: Env,
  _ctx: ExecutionContext,
): Promise<Response> {
  return Response.json({
    note: "External MCP route is /external-mcp/:userId/mcp. Use @modelcontextprotocol/inspector to validate manually, or see test/03-mcp-http-streamable.test.ts for the JSONRPC initialize handshake test.",
    mcpUrl: "/external-mcp/test-user/mcp",
  });
}
