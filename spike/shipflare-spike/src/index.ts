// Subagent: the spike's DO/workflow files come in later tasks. For now,
// write a stub index.ts that won't try to import non-existent files,
// but compiles cleanly. Use dynamic imports inside the handler so
// missing modules don't break wrangler types / tsc.

// Re-exports added per-task as classes are introduced:
//   Task 2: export { McpServerExample } from "./durable-objects/McpServerExample";
//           export { AgentExample }     from "./durable-objects/AgentExample";
//   Task 6: export { SqliteDO }         from "./durable-objects/SqliteDO";
//   Task 7: export { ExampleWorkflow }  from "./workflows/ExampleWorkflow";

export { McpServerExample } from "./durable-objects/McpServerExample";
export { AgentExample } from "./durable-objects/AgentExample";
export { SqliteDO } from "./durable-objects/SqliteDO";
export { ExampleWorkflow } from "./workflows/ExampleWorkflow";

// Value import (not just type) — we need to call `McpServerExample.serve(...)`
// at runtime to mount the Streamable HTTP transport for external MCP clients
// (Claude Desktop, Cursor, @modelcontextprotocol/inspector, etc.).
import { McpServerExample } from "./durable-objects/McpServerExample";
import type { AgentExample } from "./durable-objects/AgentExample";
import type { SqliteDO } from "./durable-objects/SqliteDO";

export interface Env {
  MCP_EXAMPLE: DurableObjectNamespace<McpServerExample>;
  AGENT_EXAMPLE: DurableObjectNamespace<AgentExample>;
  SQLITE_DO: DurableObjectNamespace<SqliteDO>;
  EX_WORKFLOW: Workflow;
  CALLEE?: Fetcher;
  ANTHROPIC_API_KEY: string;
  BETTER_AUTH_SECRET: string;
  GITHUB_CLIENT_ID: string;
  GITHUB_CLIENT_SECRET: string;
  // binding name must match wrangler.jsonc d1_databases[].binding. Phase 0
  // pivoted from Hyperdrive/Neon Postgres to D1 (see RESULTS.md Spike #4
  // for the Task 11 sweep note).
  DB: D1Database;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/healthz") return Response.json({ ok: true });

    // External MCP Streamable HTTP transport — for Claude Desktop / external
    // LLM clients.
    //
    // NOTE: external HTTP path does NOT auto-inject props into McpAgent.
    // Only the in-process RPC transport (addMcpServer with DO binding) populates
    // this.props from the caller. Phase 2 external MCP exposure must wrap this
    // with withOAuthProvider(...) to populate props from user auth headers.
    // `binding` must match wrangler.jsonc "durable_objects.bindings[].name".
    if (url.pathname.startsWith("/external-mcp/")) {
      return McpServerExample.serve("/external-mcp/:userId/mcp", {
        binding: "MCP_EXAMPLE",
      }).fetch(request, env, ctx);
    }

    // Better Auth owns every /api/auth/* route (sign-in / callback / session /
    // sign-out / etc.). Must come BEFORE the /spike/NN matcher so the
    // dispatcher doesn't 404 on auth callbacks.
    if (url.pathname.startsWith("/api/auth/")) {
      const { authHandler } = await import("./spikes/04-better-auth");
      return authHandler(request, env);
    }

    const match = url.pathname.match(/^\/spike\/(\d{2})(?:\/.*)?$/);
    if (!match) return new Response("not found", { status: 404 });
    const id = match[1];
    // Each spike task replaces the 501 fallback for its own NN by dynamically
    // importing src/spikes/NN-name.ts and returning its default export.
    if (id === "01") {
      const mod = await import("./spikes/01-anthropic-streaming");
      return mod.default(request, env, ctx);
    }
    if (id === "02") {
      const mod = await import("./spikes/02-mcp-rpc");
      return mod.default(request, env, ctx);
    }
    if (id === "03") {
      const mod = await import("./spikes/03-mcp-http-streamable");
      return mod.default(request, env, ctx);
    }
    if (id === "04") {
      const mod = await import("./spikes/04-better-auth");
      return mod.default(request, env, ctx);
    }
    if (id === "05") {
      const mod = await import("./spikes/05-webcrypto-aes-gcm");
      return mod.default(request, env);
    }
    if (id === "06") {
      const mod = await import("./spikes/06-do-sqlite-perf");
      return mod.default(request, env);
    }
    // Spike #7 handler internally branches on the `/status` suffix to expose
    // both creation and status-query routes under one dispatch entry.
    if (id === "07") {
      const mod = await import("./spikes/07-dynamic-workflow");
      return mod.default(request, env);
    }
    return new Response(`spike #${id} not yet implemented`, { status: 501 });
  },
  async scheduled(_event: ScheduledController, _env: Env, _ctx: ExecutionContext): Promise<void> {
    // cron handler: implemented in Task 9
  },
} satisfies ExportedHandler<Env>;
