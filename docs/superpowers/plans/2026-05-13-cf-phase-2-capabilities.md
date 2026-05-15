# Cloudflare Migration — Phase 2 New Capabilities Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship six new ShipFlare capabilities that are now structurally trivial because Phase 1 put the right primitives in place. Start the day after Phase 1 production-deploys.

**Architecture:** All capabilities slot into the existing `apps/core` Worker + Durable Objects topology. P2-A exposes existing McpAgent classes via Streamable HTTP. P2-B adds three new McpAgent classes following the SocialMediaMgr pattern. P2-C wires `addMcpServer` peer-to-peer with shadow fetches to CMO. P2-D adds a new SQLite table on CMO + opt-in memory injection. P2-E adds three new platform tool McpAgents. P2-F integrates Agents SDK's built-in web push.

**Tech Stack:** Same as Phase 1 (CF Workers, Agents SDK, McpAgent, Dynamic Workflows, Drizzle / D1, Better Auth) + Web Push API (VAPID).

**Spec:** `docs/superpowers/specs/2026-05-13-cloudflare-do-migration-design.md` §5.3.
**Prerequisite:** Phase 1 deployed to production + 7-day observation GREEN.

**Independence:** P2-A through P2-F can be implemented in any order. Prioritize P2-A (highest commercial value) first; the rest by demand.

---

## File Structure

```
apps/core/src/
  agents/
    cmo/                                ← modified: query-roster route + queryDrafts tool
    head-of-growth/                     ← unchanged
    social-media-manager/               ← modified: peer-DM wiring (P2-C)
    copywriter/                         ← new (P2-B)
      Copywriter.ts
      schema.ts
      tools.ts
    community-manager/                  ← new (P2-B)
      CommunityManager.ts
      schema.ts
      tools.ts
    brand-analyst/                      ← new (P2-B)
      BrandAnalyst.ts
      schema.ts
      tools.ts
  platforms/
    linkedin/                           ← new (P2-E)
    hackernews/                         ← new (P2-E)
    discord/                            ← new (P2-E)
  push/                                 ← new (P2-F)
    notifications.ts

packages/shared/src/role-registry.ts    ← modified: add 3 new roles (P2-B), 3 new channels (P2-E)

apps/web/app/
  (app)/
    mcp-urls/                           ← new (P2-A): show user their MCP URLs
    notifications/                      ← new (P2-F): VAPID subscription UI
    memory/                             ← new (P2-D): "remembered" toggles
  api/
    push/
      subscribe/route.ts                ← new (P2-F)
    channels/
      linkedin/                         ← new (P2-E)
      hackernews/
      discord/
```

---

## P2-A — External MCP Exposure

**Goal:** Each employee McpAgent class exposes a Streamable HTTP endpoint that the founder (or paying customer) can paste into Claude Desktop / Cursor / their own LLM stack. OAuth-scoped: external clients see a subset of tools based on scope.

> **Phase 0 spike #3 findings for this work stream:**
>
> 1. **`McpAgent.serve(path)` defaults its `binding` argument to `"MCP_OBJECT"`.**
>    Our DO bindings are named `CMO`, `HEAD_OF_GROWTH`, `SOCIAL_MEDIA_MGR`, etc.
>    — so every `Klass.serve(...)` call MUST pass `{ binding: "<NAME>" }` explicitly,
>    or it throws `Could not find McpAgent binding for MCP_OBJECT` at runtime.
>    Example: `CMO.serve("/external/agents/cmo/:userId/mcp", { binding: "CMO" })`.
>
> 2. **External HTTP transport does NOT auto-populate `this.props` from request
>    headers.** Our `routeToDO` injects `x-mcp-props` but that's only honored on
>    the internal route. For the public external path, Phase 2 must wrap with
>    `withOAuthProvider(...)` (from the agents SDK) to populate `props` from the
>    validated OAuth token — the validateExternalAccess JWT check from Task A.2
>    needs to feed into the same `props` object the McpAgent receives.
>
> 3. **Sessions are sticky via `mcp-session-id`**: every request after the
>    initial handshake MUST echo this header; otherwise the server treats it as
>    a fresh session. Document this contract for any external clients we
>    publish docs for.
>
> 4. **`Cache-Control: no-cache` must be preserved** on the SSE response. Do
>    NOT put a CDN with default caching in front of this route.

### Task A.0: Route external MCP requests

**Files:**
- Modify: `apps/core/src/index.ts:1` (add external MCP routing branch)

- [ ] **Step 1: Add external MCP entry point**

```typescript
// Inside the fetch handler, before the existing /agents/<role>/<userId>/mcp internal routing:
const externalMatch = url.pathname.match(/^\/external\/agents\/([a-z-]+)\/([^/]+)\/mcp/);
if (externalMatch) {
  const [, role, userId] = externalMatch;
  // OAuth scope validation: see Task A.2
  const scope = await validateExternalAccess(request, env, userId, role);
  if (!scope) return new Response("unauthorized", { status: 401 });
  return routeToDO(env, role, userId, request, { userId, caller: "external", scope });
}
```

- [ ] **Step 2: Commit**

```bash
git add apps/core/src/index.ts
git commit -m "feat(p2-a): external MCP routing entry"
```

---

### Task A.1: Per-employee `.serve()` registration

**Files:**
- Modify: `apps/core/src/agents/cmo/CMO.ts` (and HoG, SMM, Copywriter, etc.)

- [ ] **Step 1: Add `.serve()` for each McpAgent**

For each employee class, the Streamable HTTP transport is already supplied by `McpAgent.serve(path)`. Inside the entry, dispatch:

```typescript
// In apps/core/src/index.ts handler
import { CMO } from "./agents/cmo/CMO";

if (externalMatch) {
  const [, role, userId] = externalMatch;
  // ...
  // Phase 0 spike #3: McpAgent.serve() requires the binding name explicitly;
  // its default is "MCP_OBJECT" which doesn't match our naming.
  const binding = ROLE_REGISTRY[role as RoleSlug]?.binding;
  const Klass = { "cmo": CMO, "head-of-growth": HeadOfGrowth, /* ... */ }[role];
  if (!Klass || !binding) return new Response("unknown role", { status: 404 });
  return Klass.serve(`/external/agents/${role}/:userId/mcp`, { binding }).fetch(request, env, ctx);
}
```

- [ ] **Step 2: Commit**

```bash
git add apps/core/src/index.ts
git commit -m "feat(p2-a): per-employee .serve() routes"
```

---

### Task A.2: OAuth scopes + token issuance

**Files:**
- Create: `apps/core/src/lib/external-auth.ts`
- Create: `apps/web/app/api/external-mcp/issue/route.ts`
- Create: `apps/web/app/(app)/mcp-urls/page.tsx`

- [ ] **Step 1: Define scopes in `apps/core/src/lib/external-auth.ts`**

```typescript
import { verifyJwt } from "./jwt";

export type ExternalScope =
  | "read"            // query state, list plan items, see drafts
  | "draft"           // generate drafts via SMM / Copywriter, no publish
  | "publish"         // full publish capability
  | "admin";          // hire/fire, modify strategy

export interface ExternalToken {
  userId: string;
  role: string;        // which employee this token grants access to
  scope: ExternalScope[];
  exp: number;
}

export async function validateExternalAccess(
  req: Request, env: Env, userId: string, role: string
): Promise<ExternalToken | null> {
  const auth = req.headers.get("authorization");
  if (!auth?.startsWith("Bearer ")) return null;
  try {
    const claims = await verifyJwt(auth.slice(7), env.EXTERNAL_MCP_SECRET) as ExternalToken;
    if (claims.userId !== userId) return null;
    if (claims.role !== role && claims.role !== "*") return null;
    return claims;
  } catch {
    return null;
  }
}
```

- [ ] **Step 2: Token issuance endpoint**

```typescript
// apps/web/app/api/external-mcp/issue/route.ts
import { getAuth } from "@/auth";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { signJwt } from "@/lib/jwt";

export async function POST(req: Request) {
  const auth = getAuth();
  const session = await auth.api.getSession({ headers: req.headers });
  if (!session) return new Response("unauthorized", { status: 401 });

  const { role, scope } = await req.json() as { role: string; scope: string[] };
  const { env } = getCloudflareContext();

  // Long-lived token: 30 days (revocable via UI later)
  const token = await signJwt(
    { userId: session.user.id, role, scope },
    env.EXTERNAL_MCP_SECRET,
    30 * 24 * 60 * 60
  );
  const mcpUrl = `${env.CORE_PUBLIC_URL}/external/agents/${role}/${session.user.id}/mcp`;
  return Response.json({ token, mcpUrl, scope });
}
```

- [ ] **Step 3: `/mcp-urls` UI**

```tsx
// apps/web/app/(app)/mcp-urls/page.tsx
"use client";
import { useState } from "react";

const ROLES = ["cmo", "head-of-growth", "social-media-manager", "copywriter"];
const SCOPES = ["read", "draft", "publish"];

export default function McpUrlsPage() {
  const [generated, setGenerated] = useState<Record<string, { token: string; mcpUrl: string }>>({});

  async function issue(role: string, scope: string[]) {
    const res = await fetch("/api/external-mcp/issue", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ role, scope }),
    });
    const body = await res.json();
    setGenerated((g) => ({ ...g, [role]: body }));
  }

  return (
    <main>
      <h1>Your MCP URLs</h1>
      <p>Paste these into Claude Desktop or any MCP-capable client to invoke your employees directly.</p>
      {ROLES.map((role) => (
        <section key={role}>
          <h2>{role}</h2>
          <button onClick={() => issue(role, ["read", "draft"])}>Generate read+draft URL</button>
          {generated[role] && (
            <pre>
{`MCP URL:  ${generated[role].mcpUrl}
Token:    ${generated[role].token.substring(0, 40)}...`}
            </pre>
          )}
        </section>
      ))}
    </main>
  );
}
```

- [ ] **Step 4: Inside each McpAgent, gate tools by scope**

For tools that mutate (publish, hire, etc.), check scope:

```typescript
// inside e.g. CMO's hireEmployee handler:
// Phase 0 spike #2 + #3: HTTP transport (this is the external-MCP path)
// DOES populate extra.props (via withOAuthProvider in P2-A). RPC transport
// would read agent.props instead. Choose based on the call path.
const props = (extra as any).props ?? this.props;
if (props.caller === "external" && !props.scope?.includes("admin")) {
  throw new Error("admin scope required");
}
```

- [ ] **Step 5: Commit**

```bash
git add apps/core/src/lib/external-auth.ts apps/web/app/api/external-mcp/ apps/web/app/(app)/mcp-urls/
git commit -m "feat(p2-a): external MCP token issuance + scopes + URL UI"
```

---

### Task A.3: Documentation page for external users

**Files:**
- Create: `apps/web/app/docs/mcp/page.tsx`

- [ ] **Step 1: Write docs page**

```tsx
export default function McpDocsPage() {
  return (
    <main>
      <h1>Using ShipFlare with Claude Desktop / Cursor</h1>
      <h2>Setup</h2>
      <ol>
        <li>Go to /mcp-urls and generate a URL + token for the employee you want to use</li>
        <li>In Claude Desktop, edit <code>~/Library/Application Support/Claude/claude_desktop_config.json</code></li>
        <li>Add this entry:</li>
      </ol>
      <pre>{`{
  "mcpServers": {
    "shipflare-cmo": {
      "transport": {
        "type": "streamable-http",
        "url": "<YOUR_MCP_URL>",
        "headers": { "Authorization": "Bearer <YOUR_TOKEN>" }
      }
    }
  }
}`}</pre>
      <p>Restart Claude Desktop. You can now ask your CMO directly: "What's my current marketing strategy?"</p>
    </main>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add apps/web/app/docs/
git commit -m "docs(p2-a): MCP external setup guide"
```

---

## P2-B — Expanded Roster (Copywriter, Brand Analyst, Community Manager)

**Goal:** Add three new employee McpAgent classes, each per-user, hireable via CMO's `hireEmployee` tool.

### Task B.0: Copywriter

**Files:**
- Create: `apps/core/src/agents/copywriter/Copywriter.ts`
- Create: `apps/core/src/agents/copywriter/schema.ts`
- Create: `apps/core/src/agents/copywriter/tools.ts`
- Modify: `packages/shared/src/role-registry.ts:1` (add `copywriter` entry)
- Modify: `apps/core/wrangler.jsonc:1` (add DO binding)

- [ ] **Step 1: Add to ROLE_REGISTRY**

```typescript
// packages/shared/src/role-registry.ts
export const ROLE_REGISTRY = {
  // ... existing
  "copywriter": {
    binding: "COPYWRITER",
    displayName: "Copywriter",
    tier: "pro",
    defaultActive: false,
  },
} as const satisfies Record<string, RoleEntry>;
```

- [ ] **Step 2: Add to `wrangler.jsonc`**

```jsonc
{
  "durable_objects": {
    "bindings": [
      // ... existing
      { "name": "COPYWRITER", "class_name": "Copywriter" }
    ]
  },
  "migrations": [
    { "tag": "v2", "new_sqlite_classes": ["Copywriter"] }
  ]
}
```

- [ ] **Step 3: Write `Copywriter.ts`**

```typescript
import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { type McpProps } from "@shipflare/shared";
import { applyCopywriterSchema } from "./schema";
import { registerCopywriterTools } from "./tools";

type State = { lastWakeAt: number };
export class Copywriter extends McpAgent<Env, State, McpProps> {
  server = new McpServer({ name: "shipflare-copywriter", version: "1.0.0" });
  initialState: State = { lastWakeAt: 0 };
  async onStart() {
    applyCopywriterSchema(this.ctx.storage.sql);
  }
  async init() {
    registerCopywriterTools(this);
  }
}
```

- [ ] **Step 4: Write `schema.ts`**

```typescript
export function applyCopywriterSchema(sql: SqlStorage) {
  sql.exec(`
    CREATE TABLE IF NOT EXISTS copy_drafts (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,           -- 'headline' / 'tagline' / 'post' / 'reply' / 'rewrite'
      brief TEXT NOT NULL,
      output TEXT NOT NULL,
      voice TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS voice_lessons (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      pattern TEXT NOT NULL,
      ok_examples TEXT,
      avoid_examples TEXT,
      learned_at INTEGER NOT NULL
    );
  `);
}
```

- [ ] **Step 5: Write `tools.ts`**

```typescript
import { z } from "zod";
import Anthropic from "@anthropic-ai/sdk";
import { runSkill } from "@shipflare/skills";
import type { Copywriter } from "./Copywriter";

export function registerCopywriterTools(agent: Copywriter) {
  agent.server.registerTool("chat", {
    description: "Talk to the copywriter about brand voice / messaging.",
    inputSchema: { conversationId: z.string(), message: z.string() },
  }, async ({ conversationId, message }, extra) => {
    const cmoServer = (agent as any).mcpServers?.cmo;
    const ctx = cmoServer ? JSON.parse((await cmoServer.callTool("queryFounderContext", {})).content[0].text) : {};
    const client = new Anthropic({ apiKey: agent.env.ANTHROPIC_API_KEY });
    const reply = await client.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 1024,
      system: `You are the Copywriter for ${ctx.productName ?? "the founder"}. Voice: ${ctx.voice ?? "casual"}. Keep responses sharp, opinionated.`,
      messages: [{ role: "user", content: message }],
    });
    return { content: [{ type: "text", text: (reply.content[0] as any).text }] };
  });

  agent.server.registerTool("rewriteInVoice", {
    description: "Rewrite a draft in the brand voice.",
    inputSchema: { body: z.string(), targetVoice: z.string().optional() },
  }, async ({ body, targetVoice }, extra) => {
    const cmoServer = (agent as any).mcpServers?.cmo;
    const ctx = cmoServer ? JSON.parse((await cmoServer.callTool("queryFounderContext", {})).content[0].text) : {};
    const voice = targetVoice ?? ctx.voice ?? "casual";
    const result = await runSkill("rewriting-in-voice", { body, voice }, { env: agent.env });
    agent.ctx.storage.sql.exec(
      "INSERT INTO copy_drafts (id, kind, brief, output, voice, created_at) VALUES (?, 'rewrite', ?, ?, ?, ?)",
      crypto.randomUUID(), body, result.body ?? body, voice, Date.now()
    );
    return { content: [{ type: "text", text: JSON.stringify(result) }] };
  });

  agent.server.registerTool("draftHeadlines", {
    description: "Generate N headline variants for a topic.",
    inputSchema: { topic: z.string(), count: z.number().default(5) },
  }, async ({ topic, count }) => {
    const result = await runSkill("drafting-headlines", { topic, count }, { env: agent.env });
    return { content: [{ type: "text", text: JSON.stringify(result) }] };
  });
}
```

- [ ] **Step 6: Add `rewriting-in-voice` + `drafting-headlines` skills to `packages/skills/skills/`**

Create the two SKILL.md files with Anthropic prompt template. Reuse existing voice references.

- [ ] **Step 7: Export + commit**

```typescript
// apps/core/src/index.ts
export { Copywriter } from "./agents/copywriter/Copywriter";
```

```bash
git add apps/core/src/agents/copywriter/ apps/core/src/index.ts apps/core/wrangler.jsonc packages/shared/src/role-registry.ts packages/skills/skills/rewriting-in-voice packages/skills/skills/drafting-headlines
git commit -m "feat(p2-b): Copywriter McpAgent"
```

---

### Task B.1: Community Manager

**Files:**
- Create: `apps/core/src/agents/community-manager/CommunityManager.ts`
- Create: `apps/core/src/agents/community-manager/schema.ts`
- Create: `apps/core/src/agents/community-manager/tools.ts`
- Modify: `packages/shared/src/role-registry.ts:1`
- Modify: `apps/core/wrangler.jsonc:1`

- [ ] **Step 1: Same pattern as Copywriter**

Tools: `chat`, `analyzeCommunityPulse`, `summarizeMentions`, `flagTrolls`.

```typescript
agent.server.registerTool("analyzeCommunityPulse", {
  description: "Read recent mentions / threads and report sentiment + emerging topics.",
  inputSchema: { platform: z.enum(["x", "reddit"]), window: z.string().default("7d") },
}, async ({ platform, window }, extra) => {
  // Pull recent threads_inbox + posted via CMO RPC (or peer-RPC to SMM)
  // Run sentiment analysis skill
  // Persist findings to community_findings table
});
```

- [ ] **Step 2: Commit**

```bash
git add apps/core/src/agents/community-manager/ apps/core/src/index.ts apps/core/wrangler.jsonc packages/shared/src/role-registry.ts
git commit -m "feat(p2-b): Community Manager McpAgent"
```

---

### Task B.2: Brand Analyst

**Files:**
- Create: `apps/core/src/agents/brand-analyst/BrandAnalyst.ts`
- Create: `apps/core/src/agents/brand-analyst/schema.ts`
- Create: `apps/core/src/agents/brand-analyst/tools.ts`

- [ ] **Step 1: Same pattern**

Tools: `chat`, `analyzeCompetitors`, `suggestPositioning`, `voiceCalibration`.

```typescript
agent.server.registerTool("analyzeCompetitors", {
  description: "Survey competitor positioning / messaging from public sources.",
  inputSchema: { competitors: z.array(z.string()) },
}, async ({ competitors }) => {
  // Use xAI to scrape recent posts from competitor handles
  // Compare voice / cadence / themes
  // Output structured comparison
});
```

- [ ] **Step 2: Commit**

```bash
git add apps/core/src/agents/brand-analyst/
git commit -m "feat(p2-b): Brand Analyst McpAgent"
```

---

## P2-C — Peer-DM

**Goal:** Employees can call each other directly via RPC; CMO sees a shadow log without being woken.

### Task C.0: Wire peer-DM in SMM ↔ Copywriter

**Files:**
- Modify: `apps/core/src/agents/social-media-manager/SocialMediaMgr.ts:1` (extend onStart)
- Modify: `apps/core/src/agents/social-media-manager/tools.ts:1` (add peer-DM helper)

- [ ] **Step 1: Add peer connection in `onStart`**

```typescript
async onStart() {
  applySmmSchema(this.ctx.storage.sql);
  this.setState({ lastWakeAt: Date.now() });
  // Phase 0 spike #2: addMcpServer names must be tenant-namespaced
  // (`${role}-${userId}`) — see Phase 1 plan S2.3 + S4.0.
  await this.addMcpServer(`x-${this.props.userId}`, this.env.X_MCP, { props: { userId: this.props.userId, caller: "peer", role: "member" } });
  await this.addMcpServer(`reddit-${this.props.userId}`, this.env.REDDIT_MCP, { props: { userId: this.props.userId, caller: "peer", role: "member" } });

  // P2-C: peer connection to Copywriter if hired
  const cmoStub = this.env.CMO.idFromName(this.props.userId);
  const rosterRes = await this.env.CMO.get(cmoStub).fetch(new Request("https://x/internal/query-roster"));
  const roster = await rosterRes.json() as Array<{ role: string; status: string }>;
  if (roster.find((r) => r.role === "copywriter" && r.status === "active")) {
    await this.addMcpServer(`copywriter-${this.props.userId}`, this.env.COPYWRITER, {
      props: { userId: this.props.userId, caller: "peer", role: "member" },
    });
  }
}
```

- [ ] **Step 2: Add peer-DM helper that shadows to CMO**

```typescript
// In SMM tools.ts
async function shadowToCmo(agent: SocialMediaMgr, payload: {
  conversationId?: string;
  fromRole: string;
  toRole: string;
  tool: string;
  summary: string;
}) {
  const cmoStub = agent.env.CMO.idFromName(agent.props.userId);
  await agent.env.CMO.get(cmoStub).fetch(new Request("https://x/internal/peer-dm-shadow", {
    method: "POST",
    headers: { "x-shipflare-internal": "1" },
    body: JSON.stringify(payload),
  }));
}

// Example usage inside processRepliesBatch:
async function callCopywriterForRewrite(agent: SocialMediaMgr, draft: string, conversationId: string) {
  const copywriter = (agent as any).mcpServers?.copywriter;
  if (!copywriter) return draft;
  const result = await copywriter.callTool("rewriteInVoice", { body: draft });
  await shadowToCmo(agent, {
    conversationId,
    fromRole: "social-media-manager",
    toRole: "copywriter",
    tool: "rewriteInVoice",
    summary: `SMM asked Copywriter to rewrite draft (${draft.length} chars)`,
  });
  return JSON.parse(result.content[0].text).body ?? draft;
}
```

- [ ] **Step 3: Test peer-DM doesn't wake CMO**

```typescript
// apps/core/test/peer-dm.test.ts
import { env, runInDurableObject } from "cloudflare:test";
import { describe, it, expect } from "vitest";

describe("peer-DM", () => {
  it("shadow appears in CMO employee_log without triggering chat handler", async () => {
    const userId = "peer-test-user";
    // Pre-seed CMO
    const cmoStub = env.CMO.getByName(userId);
    await cmoStub.fetch(new Request("https://x/internal/init", {
      method: "POST",
      headers: { "x-shipflare-internal": "1" },
      body: JSON.stringify({ email: "t@t.com", githubLogin: "t" }),
    }));

    // Trigger shadow directly
    await cmoStub.fetch(new Request("https://x/internal/peer-dm-shadow", {
      method: "POST",
      headers: { "x-shipflare-internal": "1" },
      body: JSON.stringify({
        conversationId: "c1",
        fromRole: "social-media-manager",
        toRole: "copywriter",
        tool: "rewriteInVoice",
        summary: "test shadow",
      }),
    }));

    // Verify log
    await runInDurableObject(cmoStub, async (instance: any) => {
      const rows = instance.ctx.storage.sql.exec(
        "SELECT * FROM employee_log WHERE kind = 'peer_dm_shadow'"
      ).toArray();
      expect(rows).toHaveLength(1);
      expect(rows[0].notified_founder).toBe(0);
    });
  });
});
```

- [ ] **Step 4: Commit**

```bash
git add apps/core/src/agents/social-media-manager/ apps/core/test/peer-dm.test.ts
git commit -m "feat(p2-c): peer-DM SMM ↔ Copywriter with shadow to CMO"
```

---

## P2-D — Cross-Conversation Memory (opt-in)

**Goal:** Founder clicks "Remember this" on a chat message; CMO injects it into the next session's system prompt.

### Task D.0: Memory table + tool

**Files:**
- Modify: `apps/core/src/agents/cmo/schema.ts:1` (add cross_conversation_memory table)
- Modify: `apps/core/src/agents/cmo/tools.ts:1` (add rememberThis / forgetThis tools)

- [ ] **Step 1: Add schema**

```sql
-- Append to applyCmoSchema:
CREATE TABLE IF NOT EXISTS cross_conversation_memory (
  id TEXT PRIMARY KEY,
  content TEXT NOT NULL,
  source_conversation_id TEXT,
  source_message_ts INTEGER,
  added_at INTEGER NOT NULL,
  active INTEGER NOT NULL DEFAULT 1
);
```

- [ ] **Step 2: Add tools**

```typescript
agent.server.registerTool("rememberThis", {
  description: "Save a piece of info to long-term memory; injected into all future conversations.",
  inputSchema: {
    content: z.string(),
    sourceConversationId: z.string().optional(),
    sourceMessageTs: z.number().optional(),
  },
}, async ({ content, sourceConversationId, sourceMessageTs }) => {
  const id = crypto.randomUUID();
  agent.ctx.storage.sql.exec(
    `INSERT INTO cross_conversation_memory (id, content, source_conversation_id, source_message_ts, added_at)
     VALUES (?, ?, ?, ?, ?)`,
    id, content, sourceConversationId ?? null, sourceMessageTs ?? null, Date.now()
  );
  return { content: [{ type: "text", text: JSON.stringify({ id, ok: true }) }] };
});

agent.server.registerTool("forgetThis", {
  description: "Deactivate a memory entry.",
  inputSchema: { id: z.string() },
}, async ({ id }) => {
  agent.ctx.storage.sql.exec("UPDATE cross_conversation_memory SET active = 0 WHERE id = ?", id);
  return { content: [{ type: "text", text: "forgotten" }] };
});

agent.server.registerTool("queryMemory", {
  description: "List active long-term memories.",
  inputSchema: {},
}, async () => {
  const rows = agent.ctx.storage.sql.exec(
    "SELECT id, content, added_at FROM cross_conversation_memory WHERE active = 1 ORDER BY added_at DESC"
  ).toArray();
  return { content: [{ type: "text", text: JSON.stringify(rows) }] };
});
```

- [ ] **Step 3: Inject memory into chat system prompt**

Modify `registerChatTool` so the system prompt builder pulls active memory:

```typescript
function buildSystemPrompt(agent: CMO, ctx: Record<string, string>): string {
  const memory = agent.ctx.storage.sql.exec<{ content: string }>(
    "SELECT content FROM cross_conversation_memory WHERE active = 1 ORDER BY added_at"
  ).toArray();
  const memoryBlock = memory.length > 0
    ? `\n\nThings to always remember about ${ctx.productName ?? "the founder"}:\n${memory.map((m, i) => `${i + 1}. ${m.content}`).join("\n")}`
    : "";
  return `You are the CMO for ${ctx.productName ?? "the founder"}'s AI marketing team.
Product: ${ctx.productName ?? "(not yet set)"}.
Voice: ${ctx.voice ?? "default"}.${memoryBlock}

You orchestrate; you do not write content yourself. Route strategic questions to Head of Growth,
operational questions to Social Media Manager.`;
}
```

- [ ] **Step 4: Test**

```typescript
// apps/core/test/memory.test.ts
import { env, runInDurableObject } from "cloudflare:test";
import { describe, it, expect } from "vitest";

describe("cross-conversation memory", () => {
  it("rememberThis writes; new conversation prompt includes it", async () => {
    const stub = env.CMO.getByName("mem-test-user");
    await runInDurableObject(stub, async (instance: any) => {
      instance.ctx.storage.sql.exec(
        "INSERT INTO cross_conversation_memory (id, content, added_at) VALUES ('m1', 'Founder prefers brief replies', 0)"
      );
      const rows = instance.ctx.storage.sql.exec(
        "SELECT * FROM cross_conversation_memory WHERE active = 1"
      ).toArray();
      expect(rows).toHaveLength(1);
      expect(rows[0].content).toContain("brief replies");
    });
  });
});
```

- [ ] **Step 5: UI "Remember this" button**

```tsx
// In apps/web/app/(app)/chat/[conversationId]/page.tsx
// Add to each assistant message:
<button onClick={async () => {
  const { token, mcpUrl } = await fetch("/api/mcp-token").then((r) => r.json());
  await fetch(mcpUrl, {
    method: "POST",
    headers: { "content-type": "application/json", "authorization": `Bearer ${token}` },
    body: JSON.stringify({
      jsonrpc: "2.0", id: "1", method: "tools/call",
      params: { name: "rememberThis", arguments: {
        content: m.content,
        sourceConversationId: conversationId,
        sourceMessageTs: Date.now(),
      } },
    }),
  });
}}>Remember</button>
```

- [ ] **Step 6: `/memory` page to view + forget**

```tsx
// apps/web/app/(app)/memory/page.tsx
"use client";
import { useEffect, useState } from "react";

export default function MemoryPage() {
  const [items, setItems] = useState<any[]>([]);
  // ... fetch via queryMemory MCP tool
  // ... forget button calls forgetThis
  return <main>{items.map((i) => <div key={i.id}>{i.content} <button>Forget</button></div>)}</main>;
}
```

- [ ] **Step 7: Commit**

```bash
git add apps/core/src/agents/cmo/ apps/web/app/(app)/memory/ apps/web/app/(app)/chat/ apps/core/test/memory.test.ts
git commit -m "feat(p2-d): cross-conversation memory (opt-in) + UI"
```

---

## P2-E — New Channels (LinkedIn / HN / Discord)

**Goal:** Each new channel = one McpAgent class + OAuth callback + ROLE_REGISTRY entry. Patterns identical to X / Reddit from Phase 1.

### Task E.0: LinkedIn

**Files:**
- Create: `apps/core/src/platforms/linkedin/LinkedInMcpAgent.ts`
- Create: `apps/core/src/platforms/linkedin/schema.ts`
- Create: `apps/core/src/platforms/linkedin/tools.ts`
- Create: `apps/web/app/api/channels/linkedin/connect/route.ts`
- Create: `apps/web/app/api/channels/linkedin/callback/route.ts`
- Modify: `apps/core/wrangler.jsonc:1`
- Modify: `packages/db/src/schema.ts:1` (extend `channels.platform` enum)

- [ ] **Step 1: Extend channels.platform enum**

```typescript
// packages/db/src/schema.ts
platform: text("platform", { enum: ["x", "reddit", "linkedin", "hackernews", "discord"] }).notNull(),
```

Generate migration:
```bash
cd packages/db && pnpm generate
```

- [ ] **Step 2: Mirror RedditMcpAgent pattern**

Tools: `linkedinSearch`, `linkedinPost`, `linkedinMetrics`. Use LinkedIn Marketing Developer Platform API.

- [ ] **Step 3: OAuth callbacks**

Use LinkedIn's OAuth 2.0 flow. Same encrypt-and-store pattern as X.

- [ ] **Step 4: Commit**

```bash
git add apps/core/src/platforms/linkedin/ apps/web/app/api/channels/linkedin/ apps/core/wrangler.jsonc packages/db/
git commit -m "feat(p2-e): LinkedIn channel"
```

---

### Task E.1: Hacker News

**Files:**
- Create: `apps/core/src/platforms/hackernews/HackerNewsMcpAgent.ts`
- Create: `apps/core/src/platforms/hackernews/tools.ts`

- [ ] **Step 1: HN is read-mostly (no official API for posting); implement search + monitoring**

```typescript
agent.server.registerTool("hnSearch", {
  description: "Search Hacker News via Algolia API.",
  inputSchema: { query: z.string(), maxResults: z.number().default(20) },
}, async ({ query, maxResults }) => {
  const res = await fetch(`https://hn.algolia.com/api/v1/search?query=${encodeURIComponent(query)}&hitsPerPage=${maxResults}`);
  const body = await res.json();
  return { content: [{ type: "text", text: JSON.stringify(body.hits) }] };
});

agent.server.registerTool("hnMonitorMentions", {
  description: "Watch HN for mentions of product / competitor keywords.",
  inputSchema: { keywords: z.array(z.string()) },
}, async ({ keywords }) => {
  // Search each keyword; persist new mentions to mentions table
});
```

> Note: HN doesn't support direct posting via API; if founder wants to engage they do it manually. ShipFlare's value here is discovery + monitoring.

- [ ] **Step 2: Commit**

```bash
git add apps/core/src/platforms/hackernews/
git commit -m "feat(p2-e): Hacker News read-only channel"
```

---

### Task E.2: Discord

**Files:**
- Create: `apps/core/src/platforms/discord/DiscordMcpAgent.ts`
- Create: `apps/core/src/platforms/discord/tools.ts`
- Create: `apps/web/app/api/channels/discord/connect/route.ts`

- [ ] **Step 1: Implement Discord bot integration**

Tools: `discordPostToChannel`, `discordListenForMentions` (via webhook), `discordSearchHistory`.

```typescript
agent.server.registerTool("discordPostToChannel", {
  description: "Post to a specific Discord channel.",
  inputSchema: { channelId: z.string(), body: z.string() },
}, async ({ channelId, body }) => {
  // Phase 0 spike #2: RPC transport reads from agent.props.
  const props = agent.props;
  if (props.role !== "lead" && props.caller !== "external") {
    throw new Error("Only lead can publish directly");
  }
  // Use Discord bot token from channels table
});
```

- [ ] **Step 2: Commit**

```bash
git add apps/core/src/platforms/discord/ apps/web/app/api/channels/discord/
git commit -m "feat(p2-e): Discord channel"
```

---

## P2-F — Push Notifications

**Goal:** Send web push to the founder when SMM has a draft pending approval or HoG completes a strategic path.

### Task F.0: VAPID + subscription endpoint

**Files:**
- Create: `apps/web/app/api/push/subscribe/route.ts`
- Create: `apps/web/app/(app)/notifications/page.tsx`
- Modify: `apps/core/src/agents/cmo/schema.ts:1` (add push_subscriptions table)
- Modify: `apps/core/src/push/notifications.ts` (push helper)

- [ ] **Step 1: Generate VAPID keys**

```bash
npx web-push generate-vapid-keys
# Save VAPID_PUBLIC and VAPID_PRIVATE as wrangler secrets on both Workers
```

- [ ] **Step 2: Schema for push subscriptions in CMO**

```sql
CREATE TABLE IF NOT EXISTS push_subscriptions (
  endpoint TEXT PRIMARY KEY,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  subscribed_at INTEGER NOT NULL,
  last_used INTEGER
);
```

- [ ] **Step 3: Subscribe endpoint**

```typescript
// apps/web/app/api/push/subscribe/route.ts
import { getAuth } from "@/auth";
import { getCloudflareContext } from "@opennextjs/cloudflare";

export async function POST(req: Request) {
  const auth = getAuth();
  const session = await auth.api.getSession({ headers: req.headers });
  if (!session) return new Response("unauthorized", { status: 401 });
  const { env } = getCloudflareContext();
  const sub = await req.json() as { endpoint: string; keys: { p256dh: string; auth: string } };
  // Forward to CMO via Service Binding
  await env.CORE.fetch(new Request(`https://internal/agents/cmo/${session.user.id}/internal/push-subscribe`, {
    method: "POST",
    headers: { "x-shipflare-internal": "1" },
    body: JSON.stringify(sub),
  }));
  return Response.json({ ok: true });
}
```

- [ ] **Step 4: CMO push helper**

```typescript
// apps/core/src/push/notifications.ts
export async function sendPush(agent: CMO, payload: { title: string; body: string; url?: string }) {
  const subs = agent.ctx.storage.sql.exec<{ endpoint: string; p256dh: string; auth: string }>(
    "SELECT endpoint, p256dh, auth FROM push_subscriptions"
  ).toArray();

  for (const sub of subs) {
    // Use Web Push standard via fetch — CF Workers has WebCrypto for signing
    // Use the `web-push` library or implement RFC 8030 inline
    // For brevity: assume `webPush.send(sub, payload, vapidConfig)` exists
    await webPushSend({
      subscription: sub,
      payload: JSON.stringify(payload),
      vapidPublic: agent.env.VAPID_PUBLIC,
      vapidPrivate: agent.env.VAPID_PRIVATE,
    });
  }
}
```

- [ ] **Step 5: Trigger pushes from CMO**

Inside CMO's `approveDraft` failure path, or when SMM completes a batch with new drafts:

```typescript
// in registerSharedStateTools, after a draft becomes 'ready':
await sendPush(agent, {
  title: "New draft ready for review",
  body: `${employee} has a ${kind} for your approval.`,
  url: "/drafts",
});
```

- [ ] **Step 6: Frontend service worker registration**

```typescript
// apps/web/public/sw.js (service worker)
self.addEventListener("push", (event) => {
  const data = event.data.json();
  event.waitUntil(self.registration.showNotification(data.title, {
    body: data.body,
    icon: "/icon.png",
    data: { url: data.url },
  }));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(clients.openWindow(event.notification.data.url ?? "/"));
});
```

- [ ] **Step 7: `/notifications` settings page**

```tsx
// apps/web/app/(app)/notifications/page.tsx
"use client";
import { useEffect, useState } from "react";

export default function NotificationsPage() {
  const [subscribed, setSubscribed] = useState(false);

  async function enable() {
    const reg = await navigator.serviceWorker.register("/sw.js");
    const sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: process.env.NEXT_PUBLIC_VAPID_PUBLIC!,
    });
    await fetch("/api/push/subscribe", {
      method: "POST",
      body: JSON.stringify(sub),
      headers: { "content-type": "application/json" },
    });
    setSubscribed(true);
  }

  return (
    <main>
      <h1>Notifications</h1>
      {!subscribed
        ? <button onClick={enable}>Enable push notifications</button>
        : <p>Subscribed ✓</p>}
    </main>
  );
}
```

- [ ] **Step 8: Commit**

```bash
git add apps/core/src/push/ apps/web/app/api/push/ apps/web/app/(app)/notifications/ apps/web/public/sw.js apps/core/src/agents/cmo/
git commit -m "feat(p2-f): web push notifications"
```

---

## Phase 2 ship gate

After each P2 capability ships:

```
For each P2-X:
  ✓ Implementation merged to main
  ✓ Manual smoke test in production
  ✓ Documentation updated (if user-visible)
  ✓ ROLE_REGISTRY / DO bindings consistent across web + core
```

Phase 2 priority: P2-A first (commercial value), rest by market demand.
