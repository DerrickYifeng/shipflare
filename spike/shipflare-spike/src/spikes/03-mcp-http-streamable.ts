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
  req: Request,
  _env: Env,
  _ctx: ExecutionContext,
): Promise<Response> {
  const url = new URL(req.url);
  return Response.json({
    note: "External MCP route ready. Validate via test/03 or @modelcontextprotocol/inspector.",
    mcpUrl: `${url.origin}/external-mcp/test-user/mcp`,
    inspectorCmd: `npx -y @modelcontextprotocol/inspector@latest ${url.origin}/external-mcp/test-user/mcp`,
  });
}
