/**
 * `/docs/mcp` — public documentation for wiring ShipFlare employees into
 * 3rd-party MCP clients (Claude Desktop, Cursor, etc.).
 *
 * Lives OUTSIDE the `(app)` route group so it's publicly accessible —
 * founders may need to view it before signing in (e.g. while looking up
 * how to set up Claude Desktop the first time).
 */

export const metadata = {
  title: "MCP setup — ShipFlare",
  description:
    "Wire ShipFlare's CMO, Head of Growth, and Social Media Manager into Claude Desktop, Cursor, or any MCP-capable client.",
};

const claudeDesktopJson = `{
  "mcpServers": {
    "shipflare-cmo": {
      "transport": {
        "type": "streamable-http",
        "url": "<YOUR_MCP_URL_FROM_/mcp-urls>",
        "headers": {
          "Authorization": "Bearer <YOUR_TOKEN>"
        }
      }
    }
  }
}`;

export default function McpDocsPage() {
  return (
    <main style={{ maxWidth: 720, margin: "2rem auto", padding: "2rem" }}>
      <h1>Wiring ShipFlare into Claude Desktop / Cursor</h1>
      <p>
        Your ShipFlare employees (CMO, Head of Growth, Social Media Manager)
        each expose a Model Context Protocol server. With a token + URL from{" "}
        <a href="/mcp-urls">/mcp-urls</a>, you can invoke them from any
        MCP-capable client.
      </p>

      <h2>Claude Desktop</h2>
      <p>Edit your config at:</p>
      <ul>
        <li>
          macOS:{" "}
          <code>
            ~/Library/Application Support/Claude/claude_desktop_config.json
          </code>
        </li>
        <li>
          Windows: <code>%APPDATA%\Claude\claude_desktop_config.json</code>
        </li>
      </ul>
      <p>Add an entry under <code>mcpServers</code>:</p>
      <pre
        style={{
          background: "#fafafa",
          padding: "1rem",
          borderRadius: 4,
          overflow: "auto",
          border: "1px solid #eee",
        }}
      >
        {claudeDesktopJson}
      </pre>
      <p>
        Restart Claude Desktop. Your CMO will appear as a tool source — chat
        with it directly, ask it about your roster, drafts, or growth plan.
      </p>

      <h2>Cursor</h2>
      <p>
        Same JSON shape under <strong>Custom MCP Servers</strong> in Cursor
        settings. Add one entry per employee you want exposed.
      </p>

      <h2>Your own LLM stack</h2>
      <p>
        Any MCP-capable client works. Use the <strong>Streamable HTTP</strong>{" "}
        transport pointing at the URL with the Bearer token in the{" "}
        <code>Authorization</code> header.
      </p>

      <h2>Scopes</h2>
      <ul>
        <li>
          <strong>read</strong> — chat, query roster / plan / drafts /
          conversations
        </li>
        <li>
          <strong>draft</strong> — generate plans, draft replies and posts (no
          publishing)
        </li>
        <li>
          <strong>publish</strong> — approve drafts, post directly to connected
          channels
        </li>
        <li>
          <strong>admin</strong> — hire / fire employees, modify founder
          context
        </li>
      </ul>
      <p style={{ color: "#888", fontSize: "0.875em" }}>
        Phase 2 P2-A note: scopes are recorded in the token but tool-level
        enforcement is forward-compat. Currently a valid token gives access to
        all tools on its role. Per-tool gating ships in a follow-up.
      </p>

      <h2>Token hygiene</h2>
      <ul>
        <li>Tokens are 30-day, long-lived. Treat them like API keys.</li>
        <li>
          Never paste them into a chat window or commit them to source
          control.
        </li>
        <li>
          Token regeneration is currently manual — issue a new one via{" "}
          <a href="/mcp-urls">/mcp-urls</a> when you need to rotate.
        </li>
        <li>
          Token revocation requires a deploy-side rotation of{" "}
          <code>EXTERNAL_MCP_SECRET</code> — every existing token will stop
          working in one go. Per-token revocation is on the roadmap.
        </li>
      </ul>
    </main>
  );
}
