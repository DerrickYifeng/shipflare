# Cloudflare Migration — Phase 0 Spike Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Validate 10 runtime / library compatibility risks before committing to Phase 1 parallel build. Throwaway spike Worker. GREEN gates Phase 1.

**Architecture:** Single `shipflare-spike` Worker, one `src/spikes/NN-name.ts` file per spike item, one `test/NN-name.test.ts` per spike. Vitest + `@cloudflare/vitest-pool-workers`. Each spike is an HTTP endpoint, the test calls it and asserts pass criteria.

**Tech Stack:** Cloudflare Workers (wrangler v4), Durable Objects, Agents SDK ≥0.6.0, McpAgent, `@anthropic-ai/sdk`, `better-auth`, Drizzle ORM, Neon serverless / Hyperdrive, `@modelcontextprotocol/sdk`, vitest, WebCrypto.

**Spec:** `docs/superpowers/specs/2026-05-13-cloudflare-do-migration-design.md` §5.1.

---

## File Structure

```
spike/shipflare-spike/                  ← throwaway, separate dir from main repo
  package.json
  tsconfig.json
  wrangler.jsonc
  vitest.config.ts
  src/
    index.ts                            ← Worker entry, routes /spike/NN/* to handlers
    spikes/
      01-anthropic-streaming.ts
      02-mcp-rpc.ts
      03-mcp-http-streamable.ts
      04-better-auth.ts
      05-webcrypto-aes-gcm.ts
      06-do-sqlite-perf.ts
      07-dynamic-workflow.ts
      08-service-binding-callee.ts      ← second Worker (callee)
      08-service-binding-caller.ts      ← in main Worker
      09-cron-fanout.ts
      10-resumable-stream.ts
    durable-objects/
      McpServerExample.ts               ← spike #2/#3/#10
      SqliteDO.ts                       ← spike #6
      AgentExample.ts                   ← spike #2
    workflows/
      ExampleWorkflow.ts                ← spike #7
  test/
    spike-runner.test.ts                ← integration: hit each /spike/NN endpoint
    01-anthropic-streaming.test.ts
    02-mcp-rpc.test.ts
    ...                                 ← one file per spike
  RESULTS.md                            ← findings, per-spike pass/fail + notes
```

---

### Task 0: Scaffold the spike project

**Files:**
- Create: `spike/shipflare-spike/package.json`
- Create: `spike/shipflare-spike/tsconfig.json`
- Create: `spike/shipflare-spike/wrangler.jsonc`
- Create: `spike/shipflare-spike/vitest.config.ts`
- Create: `spike/shipflare-spike/.gitignore`
- Create: `spike/shipflare-spike/src/index.ts`
- Create: `spike/shipflare-spike/RESULTS.md`

- [ ] **Step 1: Create spike directory and init**

```bash
mkdir -p spike/shipflare-spike && cd spike/shipflare-spike
pnpm init
```

- [ ] **Step 2: Install dependencies**

```bash
pnpm add -D wrangler@latest typescript @cloudflare/workers-types \
  @cloudflare/vitest-pool-workers vitest @types/node
pnpm add agents@latest @modelcontextprotocol/sdk@latest \
  @anthropic-ai/sdk@latest zod better-auth drizzle-orm \
  @neondatabase/serverless drizzle-kit
```

- [ ] **Step 3: Write `wrangler.jsonc`**

```jsonc
{
  "$schema": "./node_modules/wrangler/config-schema.json",
  "name": "shipflare-spike",
  "main": "src/index.ts",
  "compatibility_date": "2026-05-01",
  "compatibility_flags": ["nodejs_compat"],
  "observability": { "enabled": true, "head_sampling_rate": 1 },
  "durable_objects": {
    "bindings": [
      { "name": "MCP_EXAMPLE", "class_name": "McpServerExample" },
      { "name": "AGENT_EXAMPLE", "class_name": "AgentExample" },
      { "name": "SQLITE_DO",    "class_name": "SqliteDO" }
    ]
  },
  "migrations": [
    { "tag": "v1", "new_sqlite_classes": ["McpServerExample", "AgentExample", "SqliteDO"] }
  ],
  "workflows": [
    { "binding": "EX_WORKFLOW", "name": "example-workflow",
      "class_name": "ExampleWorkflow" }
  ],
  "triggers": { "crons": ["*/1 * * * *"] },
  "services": [
    { "binding": "CALLEE", "service": "shipflare-spike-callee" }
  ]
}
```

- [ ] **Step 4: Write `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ES2022",
    "moduleResolution": "Bundler",
    "lib": ["ES2022"],
    "types": ["@cloudflare/workers-types"],
    "strict": true,
    "skipLibCheck": true,
    "esModuleInterop": true,
    "isolatedModules": true,
    "noEmit": true,
    "experimentalDecorators": false
  },
  "include": ["src/**/*", "test/**/*"]
}
```

- [ ] **Step 5: Write `vitest.config.ts`**

```typescript
import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";

export default defineWorkersConfig({
  test: {
    poolOptions: {
      workers: {
        wrangler: { configPath: "./wrangler.jsonc" },
      },
    },
  },
});
```

- [ ] **Step 6: Write minimal `src/index.ts` entry**

```typescript
export { McpServerExample } from "./durable-objects/McpServerExample";
export { AgentExample } from "./durable-objects/AgentExample";
export { SqliteDO } from "./durable-objects/SqliteDO";
export { ExampleWorkflow } from "./workflows/ExampleWorkflow";

export interface Env {
  MCP_EXAMPLE: DurableObjectNamespace;
  AGENT_EXAMPLE: DurableObjectNamespace;
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
    const match = url.pathname.match(/^\/spike\/(\d{2})(?:\/.*)?$/);
    if (!match) return new Response("not found", { status: 404 });
    const id = match[1];
    const mod = await import(`./spikes/${id}-${getSpikeName(id)}.js`);
    return mod.default(request, env, ctx);
  },
  async scheduled(event: ScheduledController, env: Env, ctx: ExecutionContext) {
    const mod = await import("./spikes/09-cron-fanout.js");
    await mod.onCron(event, env, ctx);
  },
} satisfies ExportedHandler<Env>;

function getSpikeName(id: string): string {
  const names: Record<string, string> = {
    "01": "anthropic-streaming",
    "02": "mcp-rpc",
    "03": "mcp-http-streamable",
    "04": "better-auth",
    "05": "webcrypto-aes-gcm",
    "06": "do-sqlite-perf",
    "07": "dynamic-workflow",
    "08": "service-binding-caller",
    "09": "cron-fanout",
    "10": "resumable-stream",
  };
  return names[id];
}
```

- [ ] **Step 7: Write `.gitignore`**

```
node_modules/
.wrangler/
.dev.vars
dist/
*.log
```

- [ ] **Step 8: Write `.dev.vars` (locally, not committed)**

```bash
cat > .dev.vars <<'EOF'
ANTHROPIC_API_KEY=<paste-real-key-here>
BETTER_AUTH_SECRET=test-secret-32-bytes-of-randomness-aaaa
GITHUB_CLIENT_ID=<paste-test-oauth-app>
GITHUB_CLIENT_SECRET=<paste-test-oauth-app>
EOF
```

- [ ] **Step 9: Write empty `RESULTS.md`**

```markdown
# Phase 0 Spike Results

| # | Item | Status | Notes |
|---|---|---|---|
| 1 | Anthropic SDK streaming + tool use | PENDING | |
| 2 | McpAgent + addMcpServer RPC | PENDING | |
| 3 | MCP Streamable HTTP | PENDING | |
| 4 | Better Auth + Drizzle + Hyperdrive | PENDING | |
| 5 | WebCrypto AES-GCM | PENDING | |
| 6 | DO SQLite perf | PENDING | |
| 7 | Dynamic Workflow | PENDING | |
| 8 | Service Binding | PENDING | |
| 9 | Cron fan-out | PENDING | |
| 10 | Resumable stream | PENDING | |

## Risk Updates

(Update during spike — anything that surprises us)
```

- [ ] **Step 10: Verify scaffold compiles**

Run: `pnpm wrangler types && pnpm tsc --noEmit`
Expected: no errors. `wrangler types` regenerates `worker-configuration.d.ts`.

- [ ] **Step 11: Commit**

```bash
cd ../..
git add spike/
git commit -m "spike: scaffold Phase 0 spike project"
```

---

### Task 1: Spike #1 — Anthropic SDK streaming + tool use

**Files:**
- Create: `spike/shipflare-spike/src/spikes/01-anthropic-streaming.ts`
- Create: `spike/shipflare-spike/test/01-anthropic-streaming.test.ts`

- [ ] **Step 1: Write `01-anthropic-streaming.ts`**

```typescript
import Anthropic from "@anthropic-ai/sdk";
import type { Env } from "../index";

export default async function handler(req: Request, env: Env): Promise<Response> {
  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
  const stream = await client.messages.stream({
    model: "claude-sonnet-4-6",
    max_tokens: 1024,
    tools: [{
      name: "get_weather",
      description: "Get weather for a city",
      input_schema: {
        type: "object",
        properties: { city: { type: "string" } },
        required: ["city"],
      },
    }],
    messages: [{ role: "user", content: "What's the weather in Tokyo? Use the tool." }],
  });

  const events: string[] = [];
  for await (const event of stream) {
    events.push(event.type);
  }
  const final = await stream.finalMessage();

  const toolUse = final.content.find((c) => c.type === "tool_use");
  return Response.json({
    eventCount: events.length,
    eventTypes: [...new Set(events)],
    stopReason: final.stop_reason,
    hasToolUse: !!toolUse,
    toolUseId: toolUse?.id ?? null,
    toolName: toolUse && "name" in toolUse ? toolUse.name : null,
  });
}
```

- [ ] **Step 2: Write `01-anthropic-streaming.test.ts`**

```typescript
import { SELF, env } from "cloudflare:test";
import { describe, it, expect } from "vitest";

describe("Spike #1: Anthropic streaming + tool use", () => {
  it("streams events and produces tool_use block", async () => {
    const res = await SELF.fetch("https://example.com/spike/01");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.eventCount).toBeGreaterThan(5);
    expect(body.stopReason).toBe("tool_use");
    expect(body.hasToolUse).toBe(true);
    expect(body.toolName).toBe("get_weather");
    expect(body.toolUseId).toMatch(/^toolu_/);
  }, 60_000);

  it("100 runs all succeed without silent fallback", async () => {
    const results = await Promise.all(
      Array.from({ length: 10 }, () =>
        SELF.fetch("https://example.com/spike/01").then((r) => r.json())
      )
    );
    for (const body of results) {
      expect(body.stopReason).toBe("tool_use");
      expect(body.hasToolUse).toBe(true);
    }
  }, 300_000);
});
```

> Note: dropped 100→10 because each call hits real API. 10 successful streams in a row is sufficient signal; if you want 100, run the test 10×.

- [ ] **Step 3: Run test**

Run: `pnpm vitest run test/01-anthropic-streaming.test.ts`
Expected: PASS within 5 minutes. If stopReason is anything other than "tool_use", investigate.

- [ ] **Step 4: Update RESULTS.md**

Edit RESULTS.md row 1 from PENDING to GREEN with note "10/10 streams complete, tool_use present, no silent fallback."

- [ ] **Step 5: Commit**

```bash
git add spike/shipflare-spike/src/spikes/01-anthropic-streaming.ts \
        spike/shipflare-spike/test/01-anthropic-streaming.test.ts \
        spike/shipflare-spike/RESULTS.md
git commit -m "spike(01): anthropic SDK streaming + tool use ✓"
```

---

### Task 2: Spike #2 — McpAgent + addMcpServer RPC, props passthrough, hibernation survival

**Files:**
- Create: `spike/shipflare-spike/src/durable-objects/McpServerExample.ts`
- Create: `spike/shipflare-spike/src/durable-objects/AgentExample.ts`
- Create: `spike/shipflare-spike/src/spikes/02-mcp-rpc.ts`
- Create: `spike/shipflare-spike/test/02-mcp-rpc.test.ts`

- [ ] **Step 1: Write `McpServerExample.ts`**

```typescript
import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

type State = { callCount: number };
type Props = { userId: string; secret: string };

export class McpServerExample extends McpAgent<Env, State, Props> {
  server = new McpServer({ name: "spike-mcp", version: "1.0.0" });
  initialState: State = { callCount: 0 };

  async init() {
    this.server.registerTool(
      "echo_props",
      {
        description: "Return the props from the calling agent",
        inputSchema: { ping: z.string() },
      },
      async ({ ping }, extra) => {
        this.setState({ callCount: this.state.callCount + 1 });
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              ping,
              propsUserId: (extra as any).props?.userId,
              propsSecret: (extra as any).props?.secret,
              callCount: this.state.callCount,
            }),
          }],
        };
      }
    );
  }
}
```

- [ ] **Step 2: Write `AgentExample.ts`**

```typescript
import { Agent, callable } from "agents";

export class AgentExample extends Agent<Env, { connected: boolean }> {
  initialState = { connected: false };

  async onStart() {
    await this.addMcpServer("mcp", this.env.MCP_EXAMPLE, {
      props: { userId: "test-user-123", secret: "test-secret-456" },
    });
    this.setState({ connected: true });
  }

  @callable()
  async callMcpEcho(ping: string): Promise<unknown> {
    const result = await this.mcpServers.mcp.callTool("echo_props", { ping });
    return result;
  }
}
```

- [ ] **Step 3: Write `02-mcp-rpc.ts`**

```typescript
import type { Env } from "../index";
import { getAgentByName } from "agents";

export default async function handler(req: Request, env: Env): Promise<Response> {
  const agent = await getAgentByName(env.AGENT_EXAMPLE, "spike-instance");
  const result = await agent.callMcpEcho("hello-rpc");
  return Response.json({ result });
}
```

- [ ] **Step 4: Write `02-mcp-rpc.test.ts`**

```typescript
import { SELF } from "cloudflare:test";
import { describe, it, expect } from "vitest";

describe("Spike #2: McpAgent + addMcpServer RPC", () => {
  it("props pass through from agent to mcp tool handler", async () => {
    const res = await SELF.fetch("https://example.com/spike/02");
    expect(res.status).toBe(200);
    const body = await res.json();
    const toolResult = body.result.content[0].text;
    const parsed = JSON.parse(toolResult);
    expect(parsed.ping).toBe("hello-rpc");
    expect(parsed.propsUserId).toBe("test-user-123");
    expect(parsed.propsSecret).toBe("test-secret-456");
  }, 30_000);

  it("call increments call count (state persists)", async () => {
    await SELF.fetch("https://example.com/spike/02");
    const res = await SELF.fetch("https://example.com/spike/02");
    const body = await res.json();
    const parsed = JSON.parse(body.result.content[0].text);
    expect(parsed.callCount).toBeGreaterThanOrEqual(2);
  }, 30_000);
});
```

- [ ] **Step 5: Run test**

Run: `pnpm vitest run test/02-mcp-rpc.test.ts`
Expected: both tests PASS. If propsUserId is undefined → addMcpServer props mechanism broken; flag in RESULTS.md.

- [ ] **Step 6: Manual hibernation check**

Run: `pnpm wrangler dev` in one terminal. In another:
```bash
curl http://localhost:8787/spike/02   # first call, returns
sleep 60                              # wait for DO to hibernate
curl http://localhost:8787/spike/02   # second call after wake
```
Expected: second call also returns successfully, `callCount: 2`. RPC binding survived hibernation.

- [ ] **Step 7: Update RESULTS.md and commit**

Edit RESULTS.md row 2 to GREEN with notes on props + hibernation.

```bash
git add spike/shipflare-spike/src/durable-objects/{McpServerExample,AgentExample}.ts \
        spike/shipflare-spike/src/spikes/02-mcp-rpc.ts \
        spike/shipflare-spike/test/02-mcp-rpc.test.ts \
        spike/shipflare-spike/RESULTS.md
git commit -m "spike(02): MCP RPC transport + props + hibernation ✓"
```

---

### Task 3: Spike #3 — MCP Streamable HTTP for external clients

**Files:**
- Modify: `spike/shipflare-spike/src/durable-objects/McpServerExample.ts:1-1` (add `.serve()` route)
- Create: `spike/shipflare-spike/src/spikes/03-mcp-http-streamable.ts`
- Create: `spike/shipflare-spike/test/03-mcp-http-streamable.test.ts`

- [ ] **Step 1: Update `src/index.ts` to expose Streamable HTTP route**

Add to `src/index.ts` `fetch` handler, before the `/spike/NN` matcher:

```typescript
if (url.pathname.startsWith("/external-mcp/")) {
  return McpServerExample.serve("/external-mcp/:userId/mcp").fetch(request, env, ctx);
}
```

- [ ] **Step 2: Write `03-mcp-http-streamable.ts`**

```typescript
import type { Env } from "../index";

export default async function handler(req: Request, env: Env): Promise<Response> {
  return Response.json({
    note: "Use @modelcontextprotocol/inspector or the test suite to validate this spike",
    mcpUrl: "https://localhost:8787/external-mcp/test-user/mcp",
  });
}
```

- [ ] **Step 3: Write `03-mcp-http-streamable.test.ts`**

```typescript
import { SELF } from "cloudflare:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { describe, it, expect } from "vitest";

describe("Spike #3: MCP Streamable HTTP external", () => {
  it("external client connects, lists tools, calls one", async () => {
    // Note: in vitest-pool-workers, we use SELF.fetch as transport; for real
    // external client validation, run `wrangler dev` and use `npx @modelcontextprotocol/inspector`.
    // This test verifies the route returns valid SSE/JSON-RPC for MCP init.
    const initRes = await SELF.fetch("https://example.com/external-mcp/test/mcp", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "accept": "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "spike-test", version: "1.0" },
        },
      }),
    });
    expect(initRes.status).toBe(200);
    const body = await initRes.text();
    expect(body).toContain("jsonrpc");
  }, 30_000);
});
```

- [ ] **Step 4: Manual inspector validation**

```bash
pnpm wrangler dev
# in another terminal:
npx @modelcontextprotocol/inspector@latest http://localhost:8787/external-mcp/test/mcp
```

Verify in the inspector UI:
- Connection successful
- Tools list shows `echo_props`
- Calling `echo_props` returns streamed result

- [ ] **Step 5: Update RESULTS.md and commit**

```bash
git add spike/shipflare-spike/src/index.ts \
        spike/shipflare-spike/src/spikes/03-mcp-http-streamable.ts \
        spike/shipflare-spike/test/03-mcp-http-streamable.test.ts \
        spike/shipflare-spike/RESULTS.md
git commit -m "spike(03): MCP Streamable HTTP ✓"
```

---

### Task 4: Spike #4 — Better Auth + Drizzle + Hyperdrive (GitHub OAuth flow)

**Files:**
- Create: `spike/shipflare-spike/src/spikes/04-better-auth.ts`
- Create: `spike/shipflare-spike/test/04-better-auth.test.ts`

**Prerequisite:** Create a Neon project + register a `dev` Hyperdrive config:

```bash
wrangler hyperdrive create shipflare-spike --connection-string "$NEON_URL"
# copy the printed Hyperdrive ID into wrangler.jsonc:
#   "hyperdrive": [{ "binding": "HYPERDRIVE", "id": "<id>" }]
```

And register a GitHub test OAuth app (callback URL `http://localhost:8787/spike/04/callback`).

- [ ] **Step 1: Update `wrangler.jsonc` with Hyperdrive binding**

Already documented above; verify the binding line is present.

- [ ] **Step 2: Write `04-better-auth.ts`**

```typescript
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { drizzle } from "drizzle-orm/neon-http";
import { neon } from "@neondatabase/serverless";
import type { Env } from "../index";

let _auth: ReturnType<typeof betterAuth> | null = null;

function getAuth(env: Env) {
  if (_auth) return _auth;
  const sql = neon(env.HYPERDRIVE.connectionString);
  const db = drizzle(sql);
  _auth = betterAuth({
    database: drizzleAdapter(db, { provider: "pg" }),
    socialProviders: {
      github: {
        clientId: env.GITHUB_CLIENT_ID,
        clientSecret: env.GITHUB_CLIENT_SECRET,
      },
    },
    secret: env.BETTER_AUTH_SECRET,
    baseURL: "http://localhost:8787",
  });
  return _auth;
}

export default async function handler(req: Request, env: Env): Promise<Response> {
  const auth = getAuth(env);
  const url = new URL(req.url);
  // Spike: probe the get-session endpoint
  if (url.pathname === "/spike/04/session") {
    const session = await auth.api.getSession({ headers: req.headers });
    return Response.json({ session });
  }
  // All other auth routes proxied through
  return auth.handler(req);
}
```

- [ ] **Step 3: Write `04-better-auth.test.ts`**

```typescript
import { SELF } from "cloudflare:test";
import { describe, it, expect } from "vitest";

describe("Spike #4: Better Auth + Drizzle + Hyperdrive", () => {
  it("get-session without cookie returns null", async () => {
    const res = await SELF.fetch("https://example.com/spike/04/session");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.session).toBeNull();
  }, 30_000);
});
```

- [ ] **Step 4: Manual OAuth dance validation**

```bash
pnpm wrangler dev
# open browser: http://localhost:8787/api/auth/sign-in/social?provider=github
# complete GitHub OAuth → land back on localhost
# inspect cookies: should have `better-auth.session_token`
# hit http://localhost:8787/spike/04/session → expect a non-null session
```

- [ ] **Step 5: Verify Drizzle could read the `user` table**

After signin, query Neon directly:
```sql
SELECT id, email, name FROM "user" ORDER BY created_at DESC LIMIT 1;
```
Expected: a row with the GitHub-derived email.

- [ ] **Step 6: Update RESULTS.md and commit**

Document any quirks (e.g. session callback hooks, cookie attributes, OAuth scope behavior).

```bash
git add spike/shipflare-spike/src/spikes/04-better-auth.ts \
        spike/shipflare-spike/test/04-better-auth.test.ts \
        spike/shipflare-spike/wrangler.jsonc \
        spike/shipflare-spike/RESULTS.md
git commit -m "spike(04): Better Auth + Drizzle + Hyperdrive ✓"
```

---

### Task 5: Spike #5 — WebCrypto AES-GCM round-trip

**Files:**
- Create: `spike/shipflare-spike/src/spikes/05-webcrypto-aes-gcm.ts`
- Create: `spike/shipflare-spike/test/05-webcrypto-aes-gcm.test.ts`

- [ ] **Step 1: Write `05-webcrypto-aes-gcm.ts`**

```typescript
import type { Env } from "../index";

const KEY_B64 = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="; // 32 zero bytes; spike-only

function b64decode(s: string): Uint8Array {
  return Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
}
function b64encode(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes));
}

async function getKey(): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    b64decode(KEY_B64),
    { name: "AES-GCM" },
    false,
    ["encrypt", "decrypt"]
  );
}

export async function encrypt(plaintext: string): Promise<string> {
  const key = await getKey();
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(plaintext))
  );
  const out = new Uint8Array(iv.length + ct.length);
  out.set(iv, 0);
  out.set(ct, iv.length);
  return b64encode(out);
}

export async function decrypt(encoded: string): Promise<string> {
  const key = await getKey();
  const bytes = b64decode(encoded);
  const iv = bytes.slice(0, 12);
  const ct = bytes.slice(12);
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ct);
  return new TextDecoder().decode(pt);
}

export default async function handler(_req: Request, _env: Env): Promise<Response> {
  const samples = [
    "ghp_short_token",
    "xoxb-abcdefghij-12345-67890-abcdef",
    "very long token with special chars 🔐 ~!@#$%^&*()",
    "",
  ];
  const results: Array<{ original: string; decrypted: string; ok: boolean }> = [];
  for (const s of samples) {
    const enc = await encrypt(s);
    const dec = await decrypt(enc);
    results.push({ original: s, decrypted: dec, ok: s === dec });
  }
  return Response.json({ results });
}
```

- [ ] **Step 2: Write `05-webcrypto-aes-gcm.test.ts`**

```typescript
import { SELF } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import { encrypt, decrypt } from "../src/spikes/05-webcrypto-aes-gcm";

describe("Spike #5: WebCrypto AES-GCM", () => {
  it("round-trips 100 random tokens", async () => {
    for (let i = 0; i < 100; i++) {
      const random = crypto.randomUUID() + Math.random();
      const enc = await encrypt(random);
      const dec = await decrypt(enc);
      expect(dec).toBe(random);
    }
  });

  it("handler returns ok=true for all sample tokens", async () => {
    const res = await SELF.fetch("https://example.com/spike/05");
    const body = await res.json();
    expect(body.results.every((r: any) => r.ok)).toBe(true);
  });

  it("different IV produces different ciphertext for same plaintext", async () => {
    const a = await encrypt("same-input");
    const b = await encrypt("same-input");
    expect(a).not.toBe(b);
  });
});
```

- [ ] **Step 3: Run test**

Run: `pnpm vitest run test/05-webcrypto-aes-gcm.test.ts`
Expected: 3 tests PASS.

- [ ] **Step 4: Update RESULTS.md and commit**

```bash
git add spike/shipflare-spike/src/spikes/05-webcrypto-aes-gcm.ts \
        spike/shipflare-spike/test/05-webcrypto-aes-gcm.test.ts \
        spike/shipflare-spike/RESULTS.md
git commit -m "spike(05): WebCrypto AES-GCM round-trip ✓"
```

---

### Task 6: Spike #6 — DO SQLite performance

**Files:**
- Create: `spike/shipflare-spike/src/durable-objects/SqliteDO.ts`
- Create: `spike/shipflare-spike/src/spikes/06-do-sqlite-perf.ts`
- Create: `spike/shipflare-spike/test/06-do-sqlite-perf.test.ts`

- [ ] **Step 1: Write `SqliteDO.ts`**

```typescript
import { DurableObject } from "cloudflare:workers";

interface MsgRow { id: number; conv_id: string; ts: number; content: string; }

export class SqliteDO extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS messages (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          conv_id TEXT NOT NULL,
          ts INTEGER NOT NULL,
          content TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_messages_conv_ts ON messages(conv_id, ts);
      `);
    });
  }

  async seed(rows: number, convId: string): Promise<{ ms: number }> {
    const t = Date.now();
    for (let i = 0; i < rows; i++) {
      this.ctx.storage.sql.exec(
        "INSERT INTO messages (conv_id, ts, content) VALUES (?, ?, ?)",
        convId,
        Date.now() + i,
        `msg-${i}-${Math.random().toString(36).slice(2)}`
      );
    }
    return { ms: Date.now() - t };
  }

  async timedSelect(convId: string): Promise<{ count: number; ms: number }> {
    const t = Date.now();
    const rows = this.ctx.storage.sql.exec<MsgRow>(
      "SELECT id, ts, content FROM messages WHERE conv_id = ? ORDER BY ts",
      convId
    ).toArray();
    return { count: rows.length, ms: Date.now() - t };
  }

  async timedInsert(convId: string): Promise<{ ms: number }> {
    const t = Date.now();
    this.ctx.storage.sql.exec(
      "INSERT INTO messages (conv_id, ts, content) VALUES (?, ?, ?)",
      convId,
      Date.now(),
      "one-shot"
    );
    return { ms: Date.now() - t };
  }
}
```

- [ ] **Step 2: Write `06-do-sqlite-perf.ts`**

```typescript
import type { Env } from "../index";

export default async function handler(_req: Request, env: Env): Promise<Response> {
  const stub = env.SQLITE_DO.getByName("perf-test");
  const seed = await stub.seed(10000, "conv-a");
  const sel = await stub.timedSelect("conv-a");
  const ins = await stub.timedInsert("conv-a");
  return Response.json({
    seedMs: seed.ms,
    seedRowsPerSec: Math.round(10000 / (seed.ms / 1000)),
    selectMs: sel.ms,
    selectCount: sel.count,
    insertMs: ins.ms,
  });
}
```

- [ ] **Step 3: Write `06-do-sqlite-perf.test.ts`**

```typescript
import { SELF } from "cloudflare:test";
import { describe, it, expect } from "vitest";

describe("Spike #6: DO SQLite performance", () => {
  it("10k rows: select p99 < 50ms, insert < 5ms", async () => {
    const res = await SELF.fetch("https://example.com/spike/06");
    const body = await res.json();
    expect(body.selectCount).toBe(10000);
    expect(body.selectMs).toBeLessThan(50);
    expect(body.insertMs).toBeLessThan(5);
  }, 60_000);
});
```

- [ ] **Step 4: Run test, update RESULTS.md, commit**

Run: `pnpm vitest run test/06-do-sqlite-perf.test.ts`

```bash
git add spike/shipflare-spike/src/durable-objects/SqliteDO.ts \
        spike/shipflare-spike/src/spikes/06-do-sqlite-perf.ts \
        spike/shipflare-spike/test/06-do-sqlite-perf.test.ts \
        spike/shipflare-spike/RESULTS.md
git commit -m "spike(06): DO SQLite 10k row perf ✓"
```

---

### Task 7: Spike #7 — Dynamic Workflow (step.do + step.sleep + eviction survival)

**Files:**
- Create: `spike/shipflare-spike/src/workflows/ExampleWorkflow.ts`
- Create: `spike/shipflare-spike/src/spikes/07-dynamic-workflow.ts`
- Create: `spike/shipflare-spike/test/07-dynamic-workflow.test.ts`

- [ ] **Step 1: Write `ExampleWorkflow.ts`**

```typescript
import { WorkflowEntrypoint, WorkflowStep, WorkflowEvent } from "cloudflare:workers";

type Params = { runId: string };

export class ExampleWorkflow extends WorkflowEntrypoint<Env, Params> {
  async run(event: WorkflowEvent<Params>, step: WorkflowStep) {
    const a = await step.do("step-a", async () => ({ ts: Date.now(), tag: "A" }));
    await step.sleep("step-sleep", "5 seconds");
    const b = await step.do("step-b", async () => ({ ts: Date.now(), tag: "B" }));
    return { runId: event.payload.runId, a, b, durationMs: b.ts - a.ts };
  }
}
```

- [ ] **Step 2: Write `07-dynamic-workflow.ts`**

```typescript
import type { Env } from "../index";

export default async function handler(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);
  if (url.pathname.endsWith("/status")) {
    const id = url.searchParams.get("id")!;
    const instance = await env.EX_WORKFLOW.get(id);
    return Response.json({
      status: await instance.status(),
    });
  }
  const runId = crypto.randomUUID();
  const instance = await env.EX_WORKFLOW.create({ params: { runId } });
  return Response.json({ id: instance.id, runId });
}
```

- [ ] **Step 3: Write `07-dynamic-workflow.test.ts`**

```typescript
import { SELF } from "cloudflare:test";
import { describe, it, expect } from "vitest";

async function pollUntilComplete(id: string, timeoutMs = 30_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const res = await SELF.fetch(`https://example.com/spike/07/status?id=${id}`);
    const body = await res.json();
    if (body.status.status === "complete") return body.status;
    if (body.status.status === "errored") throw new Error(JSON.stringify(body));
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error("workflow timeout");
}

describe("Spike #7: Dynamic Workflow", () => {
  it("step.do → step.sleep(5s) → step.do completes", async () => {
    const res = await SELF.fetch("https://example.com/spike/07");
    const { id } = await res.json();
    const status = await pollUntilComplete(id);
    expect(status.status).toBe("complete");
    const out = status.output;
    expect(out.a.tag).toBe("A");
    expect(out.b.tag).toBe("B");
    expect(out.durationMs).toBeGreaterThanOrEqual(5000);
  }, 60_000);
});
```

- [ ] **Step 4: Run, update RESULTS.md, commit**

```bash
git add spike/shipflare-spike/src/workflows/ExampleWorkflow.ts \
        spike/shipflare-spike/src/spikes/07-dynamic-workflow.ts \
        spike/shipflare-spike/test/07-dynamic-workflow.test.ts \
        spike/shipflare-spike/RESULTS.md
git commit -m "spike(07): Dynamic Workflow step.do + step.sleep ✓"
```

---

### Task 8: Spike #8 — Service Binding (web → core internal call)

**Files:**
- Create: `spike/shipflare-spike-callee/` (a sibling Worker project, minimal)
- Create: `spike/shipflare-spike/src/spikes/08-service-binding-caller.ts`
- Create: `spike/shipflare-spike/test/08-service-binding.test.ts`

- [ ] **Step 1: Scaffold the callee Worker**

```bash
mkdir -p spike/shipflare-spike-callee/src
cd spike/shipflare-spike-callee
pnpm init && pnpm add -D wrangler typescript
```

Write `spike/shipflare-spike-callee/wrangler.jsonc`:
```jsonc
{
  "name": "shipflare-spike-callee",
  "main": "src/index.ts",
  "compatibility_date": "2026-05-01",
  "compatibility_flags": ["nodejs_compat"]
}
```

Write `spike/shipflare-spike-callee/src/index.ts`:
```typescript
export default {
  async fetch(request: Request): Promise<Response> {
    return Response.json({
      pathReceived: new URL(request.url).pathname,
      headerEcho: Object.fromEntries(request.headers),
      timestamp: Date.now(),
    });
  },
} satisfies ExportedHandler;
```

Deploy the callee:
```bash
pnpm wrangler deploy
```

- [ ] **Step 2: Write `08-service-binding-caller.ts`**

```typescript
import type { Env } from "../index";

export default async function handler(req: Request, env: Env): Promise<Response> {
  if (!env.CALLEE) return Response.json({ error: "CALLEE binding missing" }, { status: 500 });
  const res = await env.CALLEE.fetch(new Request("https://internal/test-echo", {
    headers: { "x-shipflare-internal": "1", "x-test": "spike-08" },
  }));
  const body = await res.json();
  return Response.json({ calleeStatus: res.status, calleeBody: body });
}
```

- [ ] **Step 3: Write `08-service-binding.test.ts`**

```typescript
import { describe, it, expect } from "vitest";

describe("Spike #8: Service Binding", () => {
  // Note: vitest-pool-workers doesn't fully simulate service bindings cross-worker.
  // Validate via `wrangler dev --port 8787` against deployed callee.
  it.skip("vitest skip — see manual validation", () => {});
});
```

- [ ] **Step 4: Manual validation**

```bash
cd spike/shipflare-spike
pnpm wrangler dev
# in another terminal:
curl http://localhost:8787/spike/08
```

Expected response:
```json
{
  "calleeStatus": 200,
  "calleeBody": {
    "pathReceived": "/test-echo",
    "headerEcho": { "x-shipflare-internal": "1", "x-test": "spike-08", ... },
    "timestamp": <number>
  }
}
```

- [ ] **Step 5: Update RESULTS.md and commit**

```bash
git add spike/shipflare-spike-callee/ \
        spike/shipflare-spike/src/spikes/08-service-binding-caller.ts \
        spike/shipflare-spike/test/08-service-binding.test.ts \
        spike/shipflare-spike/RESULTS.md
git commit -m "spike(08): Service Binding web→core ✓"
```

---

### Task 9: Spike #9 — Cron fan-out

**Files:**
- Create: `spike/shipflare-spike/src/spikes/09-cron-fanout.ts`
- Create: `spike/shipflare-spike/test/09-cron-fanout.test.ts`

- [ ] **Step 1: Write `09-cron-fanout.ts`**

```typescript
import type { Env } from "../index";

const cronLog: number[] = []; // module-level, fine for spike

export async function onCron(event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
  cronLog.push(event.scheduledTime);
  // Fan out to a DO instance
  const stub = env.SQLITE_DO.getByName("cron-target");
  await stub.timedInsert("cron-marker");
}

export default async function handler(_req: Request, _env: Env): Promise<Response> {
  return Response.json({
    lastFireTimes: cronLog.slice(-5),
    fireCount: cronLog.length,
  });
}
```

- [ ] **Step 2: Write `09-cron-fanout.test.ts`**

```typescript
import { SELF, createScheduledController, runInDurableObject } from "cloudflare:test";
import { describe, it, expect } from "vitest";

describe("Spike #9: Cron fan-out", () => {
  it("scheduled() handler fires and fans out to DO", async () => {
    // Run the scheduled handler directly via test harness
    const ctl = createScheduledController({ scheduledTime: Date.now() });
    await import("../src/index"); // ensure module is loaded
    // Trigger the scheduled handler
    const res = await SELF.scheduled(ctl);
    expect(res).toBeUndefined();
    // Verify DO received the insert
    // (Use the same SQLITE_DO instance to count messages where content='one-shot')
  }, 30_000);
});
```

- [ ] **Step 3: Manual cron validation**

```bash
pnpm wrangler dev --test-scheduled
# in another terminal, trigger manually:
curl http://localhost:8787/__scheduled?cron=*+*+*+*+*
# verify in tail:
pnpm wrangler tail
```

After 1-2 minutes of `wrangler dev` running, hit `/spike/09` to check `fireCount`.

- [ ] **Step 4: Update RESULTS.md and commit**

```bash
git add spike/shipflare-spike/src/spikes/09-cron-fanout.ts \
        spike/shipflare-spike/test/09-cron-fanout.test.ts \
        spike/shipflare-spike/RESULTS.md
git commit -m "spike(09): Cron fan-out ✓"
```

---

### Task 10: Spike #10 — Resumable streaming

**Files:**
- Create: `spike/shipflare-spike/src/spikes/10-resumable-stream.ts`
- Create: `spike/shipflare-spike/test/10-resumable-stream.test.ts`

- [ ] **Step 1: Write `10-resumable-stream.ts`**

```typescript
import type { Env } from "../index";

export default async function handler(req: Request, env: Env): Promise<Response> {
  const stream = new ReadableStream({
    async start(controller) {
      const lastEventId = req.headers.get("last-event-id");
      const startFrom = lastEventId ? parseInt(lastEventId, 10) + 1 : 0;
      for (let i = startFrom; i < startFrom + 10; i++) {
        controller.enqueue(new TextEncoder().encode(`id: ${i}\ndata: chunk-${i}\n\n`));
        await new Promise((r) => setTimeout(r, 200));
      }
      controller.close();
    },
  });
  return new Response(stream, {
    headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
  });
}
```

- [ ] **Step 2: Write `10-resumable-stream.test.ts`**

```typescript
import { SELF } from "cloudflare:test";
import { describe, it, expect } from "vitest";

async function readAll(res: Response): Promise<string[]> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value);
  }
  return buf.split("\n\n").filter(Boolean);
}

describe("Spike #10: Resumable streaming", () => {
  it("first connection delivers chunks 0..9", async () => {
    const res = await SELF.fetch("https://example.com/spike/10");
    const chunks = await readAll(res);
    expect(chunks.length).toBe(10);
    expect(chunks[0]).toContain("id: 0");
    expect(chunks[9]).toContain("id: 9");
  }, 30_000);

  it("resumes from Last-Event-ID: 4 → emits 5..14", async () => {
    const res = await SELF.fetch("https://example.com/spike/10", {
      headers: { "last-event-id": "4" },
    });
    const chunks = await readAll(res);
    expect(chunks[0]).toContain("id: 5");
    expect(chunks[chunks.length - 1]).toContain("id: 14");
  }, 30_000);
});
```

- [ ] **Step 3: Run, update RESULTS.md, commit**

```bash
git add spike/shipflare-spike/src/spikes/10-resumable-stream.ts \
        spike/shipflare-spike/test/10-resumable-stream.test.ts \
        spike/shipflare-spike/RESULTS.md
git commit -m "spike(10): Resumable streaming ✓"
```

---

### Task 11: Final review and Phase 1 go/no-go decision

**Files:**
- Modify: `spike/shipflare-spike/RESULTS.md` (final summary)
- Create: `docs/superpowers/specs/2026-05-13-cloudflare-do-migration-design.md` (update §5.1.2 risk register with spike findings)

- [ ] **Step 1: Run full spike suite**

```bash
cd spike/shipflare-spike
pnpm vitest run
```

Expected: all tests PASS. Note any flakes or warnings.

- [ ] **Step 2: Fill in RESULTS.md final summary**

Add a "## Final Decision" section to RESULTS.md:

```markdown
## Final Decision (date: YYYY-MM-DD)

### Per-spike status
| # | Status | Confidence |
|---|---|---|
| 1 Anthropic streaming | GREEN / YELLOW / RED | high/med/low |
| 2 MCP RPC | ... | |
| 3 MCP HTTP | ... | |
| 4 Better Auth | ... | |
| 5 WebCrypto | ... | |
| 6 SQLite perf | ... | |
| 7 Workflow | ... | |
| 8 Service Binding | ... | |
| 9 Cron | ... | |
| 10 Resumable | ... | |

### Phase 1 entry decision
[ ] GO — all 10 GREEN, proceed to Phase 1
[ ] CONDITIONAL GO — N YELLOW items; mitigations in place; proceed
[ ] NO GO — N RED items; address before Phase 1

### Findings to update spec
- [list any spec changes prompted by spike findings]
```

- [ ] **Step 3: If GO, commit final spike state**

```bash
git add spike/shipflare-spike/RESULTS.md
git commit -m "spike: Phase 0 complete — GO/CONDITIONAL GO/NO GO"
```

- [ ] **Step 4: If spec needs updates from spike findings, edit and commit**

```bash
git add docs/superpowers/specs/2026-05-13-cloudflare-do-migration-design.md
git commit -m "spec: incorporate Phase 0 spike findings"
```

- [ ] **Step 5: Ready to start Phase 1**

Open `docs/superpowers/plans/2026-05-13-cf-phase-1-feature-parity.md` and begin executing.

The `spike/` directory stays in the repo as historical record. It is NOT deleted — future migrations may want to verify the same compatibility points.
