/**
 * `/mcp-urls` — founder's per-employee MCP URLs + token issuer.
 *
 * Generates Phase 2 external MCP URLs (`/external/agents/<role>/<userId>/mcp`)
 * and long-lived (30d) JWTs for wiring ShipFlare employees into 3rd-party
 * MCP clients (Claude Desktop, Cursor, the founder's own LLM stack).
 *
 * Auth gate runs in `(app)/layout.tsx`. Token minting is a session-aware
 * POST to `/api/external-mcp/issue` — the page itself is a thin wrapper.
 */

import McpUrlsClient from "./_components/mcp-urls-client";

export default function McpUrlsPage() {
  return (
    <div>
      <h1>Your MCP URLs</h1>
      <p style={{ color: "#666", maxWidth: 720 }}>
        Generate URLs and tokens to invoke your employees from Claude Desktop,
        Cursor, or any MCP-capable client. Tokens are long-lived (30 days) —
        treat them like API keys.{" "}
        <a href="/docs/mcp">See the docs</a> for wiring instructions.
      </p>
      <McpUrlsClient />
    </div>
  );
}
