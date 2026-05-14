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

import type { McpServerExample } from "./durable-objects/McpServerExample";
import type { AgentExample } from "./durable-objects/AgentExample";

export interface Env {
  MCP_EXAMPLE: DurableObjectNamespace<McpServerExample>;
  AGENT_EXAMPLE: DurableObjectNamespace<AgentExample>;
  SQLITE_DO: DurableObjectNamespace;
  EX_WORKFLOW: Workflow;
  CALLEE?: Fetcher;
  ANTHROPIC_API_KEY: string;
  BETTER_AUTH_SECRET: string;
  GITHUB_CLIENT_ID: string;
  GITHUB_CLIENT_SECRET: string;
  HYPERDRIVE: Hyperdrive;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/healthz") return Response.json({ ok: true });
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
    return new Response(`spike #${id} not yet implemented`, { status: 501 });
  },
  async scheduled(_event: ScheduledController, _env: Env, _ctx: ExecutionContext): Promise<void> {
    // cron handler: implemented in Task 9
  },
} satisfies ExportedHandler<Env>;
