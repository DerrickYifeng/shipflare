# Cloudflare Durable Objects Migration — Design Spec

**Date:** 2026-05-13
**Status:** Draft (awaiting user review)
**Branch:** dev → `feat/cf-do-migration` (to be created)

---

## 1. Executive Summary

Migrate ShipFlare's multi-agent runtime off the current BullMQ + Postgres +
Railway / Vercel stack and onto **Cloudflare Workers + Durable Objects +
Agents SDK + Dynamic Workflows**. The migration is a greenfield big-bang
rebuild (no production users to preserve), executed in two continuous phases:

- **Phase 1 — feature parity migration** (~3 weeks). Every capability ShipFlare
  has today runs on the new stack. No deferred items.
- **Phase 2 — new capabilities unlocked by the new architecture** (~2-4 weeks,
  starts the day Phase 1 ships): external MCP exposure, expanded employee
  roster, peer-DM, opt-in memory, new channels, web push.

Net effect after Phase 1: codebase shrinks ~35% (BullMQ, mailbox table, 4-layer
tool pool, agent_runs / team_messages / plan_items tables all deleted),
CLAUDE.md invariants collapse from seven hard rules to two, and Phase 2
capabilities that would have been weeks of work on the old stack become a few
days each.

---

## 2. Context & Motivation

### 2.1 Current pain points

The current architecture self-implements an actor system on top of BullMQ:

- `agent_runs` row = sleeping lead state, plus a manual sleep/wake protocol
  that yields the BullMQ slot
- `team_messages` table + `delivered_at` row lock = hand-built mailbox with
  idempotency
- `assembleToolPool` 4-layer SSOT (registry → role-tools → blacklists → def)
  guards what tools each agent sees
- `peer-dm-shadow.ts` enforces the "peers don't wake the lead" invariant
- `synthesize-notification.ts` constructs `<task-notification>` XML
- Cron `agent-run-backfill` queue keeps long-running agents alive

CLAUDE.md's "Agent Teams Architecture" section currently lists seven
review-reject invariants. These are all hand-written guarantees of what
Cloudflare's Durable Objects + Agents SDK provides natively.

### 2.2 Why now

- **No production users yet.** Greenfield migration has zero rollback cost.
- **Cloudflare Agents SDK v0.6.0 (Feb 2026) shipped RPC transport for MCP** —
  same-Worker Agent ↔ McpAgent calls with zero network overhead, hibernation-
  safe. This was the missing piece.
- **Cloudflare Dynamic Workflows (May 2026)** lets agents emit their own
  durable plans at runtime — perfect fit for ShipFlare's plan_items + schedule
  / wait-for-metrics model.
- **Roadmap demands it.** The "users can invoke their CMO / Social Media
  Manager via MCP from Claude Desktop" feature is conceptually free on the new
  stack and structurally impossible on the old one.

### 2.3 Out of scope

- Migrating users (there are none)
- Backward compatibility shims
- Dual-running BullMQ and DO in shadow mode
- Domain / DNS strategy (separate ticket once Phase 1 is feature-complete)

---

## 3. Locked-In Decisions

| # | Decision | Why |
|---|---|---|
| D1 | **Big-bang switch** | No users; no compat / rollback cost |
| D2 | **Full data migration to DO SQLite** | Per-team isolation, hibernate-for-free, zero noisy neighbor |
| D3 | **Full stack on Cloudflare** (web + core both Workers) | Service Bindings → zero-network internal calls; one runtime |
| D4 | **Sub-DO per teammate** (each role = own DO class) | True parallel, independent hibernate, future external MCP exposure free |
| D5 | **Auth: Better Auth** (replacing Auth.js v5) | CF first-class citizen; cleaner Drizzle adapter; greenfield = right time |
| D6 | **Database: Cloudflare D1** (revised 2026-05-13 after Phase 0 spike) | Originally Neon+Hyperdrive; pivoted to D1 to eliminate external services. SQLite sufficient for our ~5MB cross-team data; D1 has built-in edge replicas, no pool to manage, and Better Auth/Drizzle have first-class D1 support. |
| D7 | **MCP RPC transport, in-process Agent ↔ McpAgent** | v0.6.0 — zero network overhead, hibernation-safe, replaces 4-layer tool pool |
| D8 | **Uniform McpAgent for all employees** including CMO | Same protocol for founder UI and external Claude Desktop clients; symmetry |
| D9 | **CMO = pure orchestrator** (not also planner) | Future-proof for multi-employee teams; strategic planning split into Head of Growth |
| D10 | **Real industry titles**: CMO / Head of Growth / Social Media Manager | Outward-facing surface; "Head of Growth" pairs naturally with SMM |
| D11 | **Conversation-scoped chat memory** (Claude.ai-style reset) | Sprint work products + identity config persist; chat history resets per new conversation |
| D12 | **Static role registry + dynamic hire per user** | DO classes pre-defined in code, `roster` table in CMO SQLite decides who's hired |
| D13 | **Browser → core direct via short-lived JWT** | One network hop for streaming chat; Better Auth signs token from session |
| D14 | **WebCrypto AES-GCM** (replacing Node `crypto`) | Workers runtime constraint; no users so old encrypted data discardable |
| D15 | **monorepo with pnpm workspaces**: `apps/{web,core}` + `packages/{shared,skills,tools,db,crypto}` | Type sharing between workers; skill markdown stays as IP |

---

## 4. Target Architecture

### 4.1 Topology

```
shipflare-web (Cloudflare Worker)
  ├─ Next.js 16 via OpenNext adapter
  ├─ Better Auth handler (/api/auth/[...all])
  ├─ D1 binding → Cloudflare D1
  ├─ Service Binding: CORE → shipflare-core
  └─ Pages: login / chat / team / plan / drafts / settings

shipflare-core (Cloudflare Worker — DO host)
  ├─ Employee DOs (McpAgent subclasses):
  │   - CMO              (role: lead, orchestrator)
  │   - HeadOfGrowth     (role: member, strategic planner)
  │   - SocialMediaMgr   (role: member, execution)
  │   - (Phase 2) Copywriter / CommunityManager / BrandAnalyst / ...
  ├─ Platform tool MCPs (McpAgent subclasses, no LLM autonomy):
  │   - XMcpAgent         (x_search / x_post / x_metrics)
  │   - RedditMcpAgent    (reddit_search / reddit_post / research_reddit_channels)
  ├─ Workflow class: AgentPlanWorkflow (Dynamic Workflows for plans with sleep / wait-for)
  ├─ Routes: /agents/<role>/<userId>/mcp ; /webhook/<platform> ; /internal/*
  ├─ Cron triggers: hourly inbound sweep
  └─ D1 binding → Cloudflare D1 (channels + Better Auth tables)

D1 database: shipflare-prod (5 tables)
```

### 4.2 Data model

#### 4.2.1 Three storage layers

```
[Cloudflare D1]             ← cross-team relational data (Better Auth + channels)
[CMO DO SQLite]              ← per-team source of truth (plan / strategy / founder chat)
[Employee DO SQLite]         ← per-employee private state (planning chat / drafts / memory)
[Platform Tool DO SQLite]    ← per-user platform cache (rate limits / call cache)
```

**Core principle:** CMO SQLite is the per-team source of truth. Other employees
read shared state (strategic_path, plan_items, founder_context) through CMO's
exposed RPC tools — they never write CMO SQLite directly. Each employee's own
SQLite holds its private brain.

#### 4.2.2 D1 tables (5)

```sql
-- Better Auth standard (4 tables, schema auto-generated by adapter)
-- SQLite types: integer for timestamps (mode: timestamp_ms) + booleans (mode: boolean).
-- Better Auth Drizzle adapter uses provider: "sqlite" against D1.
user             (id text pk, email text unique, emailVerified integer,
                  name text, image text, createdAt integer, updatedAt integer)
session          (id text pk, expiresAt integer, token text unique, userId text fk,
                  ipAddress text, userAgent text, createdAt integer, updatedAt integer)
account          (id text pk, accountId text, providerId text, userId text fk,
                  accessToken text, refreshToken text, idToken text,
                  accessTokenExpiresAt integer, refreshTokenExpiresAt integer,
                  scope text, password text, createdAt integer, updatedAt integer)
verification     (id text pk, identifier text, value text, expiresAt integer, ...)

-- ShipFlare-specific (1 table)
channels         (id text pk, userId text fk, platform text, externalUserId text,
                  username text, oauthTokenEncrypted text, oauthRefreshEncrypted text,
                  scope text, connectedAt integer, lastVerifiedAt integer, status text)
```

#### 4.2.3 CMO DO SQLite (per-user, source of truth)

```sql
conversations          (id, started_at, ended_at, title, archived)

founder_messages       (conversation_id, role, content, ts, tool_calls_json, meta_json)
                       PRIMARY KEY (conversation_id, ts, role)

founder_context        (key, value)
                       -- productName, productDescription, voice, audience, urls

roster                 (role, hired_at, status, hire_config_json)
                       -- status: 'active' | 'paused' | 'fired'

strategic_path         (id, version, theme, narrative_json, status,
                        generated_at, generated_by, approved_at, replaced_by)

plan_items             (id, skill, channel, params_json, status, owner_role,
                        scheduled_for, started_at, completed_at, output_json,
                        parent_id, plan_version)

employee_log           (conversation_id, from_role, kind, summary, payload_json,
                        ts, notified_founder)
                       -- kind: 'task_complete' | 'peer_dm_shadow' | 'request_input'

approval_queue         (id, draft_id, employee, kind, channel, preview,
                        created_at, decided_at, decision)

progress_snapshots     (id, ts, posts_drafted, posts_published,
                        replies_drafted, replies_published, json)
```

#### 4.2.4 HeadOfGrowth DO SQLite (per-user, planner's brain)

```sql
planning_chat          (conversation_id, role, content, ts)
proposal_drafts        (id, theme, narrative_md, status, alternatives_json,
                        confidence, created_at)
audit_findings         (conversation_id, plan_item_id_or_path_id, severity,
                        finding, suggested_fix, status)
```

(No cross-conversation `memory` table; semantic memory is opt-in Phase 2.)

#### 4.2.5 SocialMediaMgr DO SQLite (per-user, executor's brain)

```sql
threads_inbox          (id, platform, external_id, author, content,
                        score, judged_at, expires_at)

drafts                 (conversation_id, id, kind, plan_item_id, platform, body,
                        why_it_works, confidence, status, audit_notes_json,
                        created_at, updated_at)
                       -- status: 'drafting' | 'ready' | 'posted' | 'failed' | 'rejected'

posted                 (id, draft_id, platform, external_id, url,
                        posted_at, metrics_json, last_metrics_at)

voice_audit            (id, draft_id, deviation, why, fixed)
```

#### 4.2.6 Platform Tool MCP SQLite (XMcpAgent / RedditMcpAgent, per-user)

```sql
rate_limits            (endpoint, remaining, reset_at)
call_cache             (cache_key, response_json, expires_at)
posted_externals       (external_id, kind, posted_by_role, posted_at,
                        deleted_at, json)
```

### 4.3 Runtime model

#### 4.3.1 Per-employee DO class structure (uniform)

All employees extend `McpAgent` with role-typed props:

```typescript
type EmployeeProps = {
  userId: string;
  conversationId?: string;
  caller: 'cmo' | 'external' | 'peer' | 'cron';
  role?: 'lead' | 'member';
};

export class CMO extends McpAgent<Env, CMOState, EmployeeProps> {
  server = new McpServer({ name: 'shipflare-cmo', version: '1.0.0' });

  async onStart() {
    const hires = this.sql`SELECT * FROM roster WHERE status = 'active'`.toArray();
    for (const hire of hires) {
      const binding = ROLE_REGISTRY[hire.role].binding;
      // IMPORTANT: namespace the server name with parent-tenant identity. See
      // §4.3.2 below — sharing a bare `hire.role` name across users would
      // collapse two users' McpServer DOs into one instance.
      await this.addMcpServer(
        `${hire.role}-${this.props.userId}`,
        this.env[binding],
        { props: { userId: this.props.userId, caller: 'cmo' } }
      );
    }
    await this.connectPlatformTools();
  }

  async init() {
    // IMPORTANT: For RPC transport (addMcpServer with DO binding), props are NOT
    // populated in `extra.props` — they live in `this.props` instead.
    // Only HTTP transport (McpAgent.serve()) populates extra.props.
    // (Phase 0 spike finding, agents@0.12.4)
    this.server.registerTool('chat', chatSchema, async (input, extra) => {
      const { userId, conversationId } = this.props;
      // ...
    });
    this.server.registerTool('delegate', delegateSchema, async (input, extra) => {
      const { userId } = this.props;
      // ...
    });
    this.server.registerTool('hire_employee', hireSchema, ...);
    this.server.registerTool('startNewConversation', ...);
    // CMO-only tools that employees can call back
    this.server.registerTool('query_founder_context', ...);
    this.server.registerTool('commit_strategic_path', ...);
    this.server.registerTool('add_plan_item', ...);
    this.server.registerTool('approve_draft', ...);
  }

  async fetch(request: Request) {
    // Internal endpoints (called via core Worker fan-out, not via MCP)
    if (url.pathname === '/internal/init')              return this.handleInit(request);
    if (url.pathname === '/internal/peer-dm-shadow')    return this.handlePeerShadow(request);
    if (url.pathname === '/internal/cron-tick')         return this.handleCronTick(request);
    return new Response('not found', { status: 404 });
  }
}
```

`HeadOfGrowth` and `SocialMediaMgr` follow the same shape with different
`init()` tool registrations.

**Per-tenant namespacing.** The `name` argument to `addMcpServer` is what
determines the McpServer DO instance identity. If two parent agents (e.g.
two users' CMOs) call `addMcpServer("smm", env.SOCIAL_MEDIA_MGR, ...)` with
the same name, they SHARE one McpServer DO instance — destroying per-user
isolation. ALWAYS namespace the server name with parent-tenant identity:
`await this.addMcpServer(\`smm-${this.props.userId}\`, env.SOCIAL_MEDIA_MGR, ...)`.

(Phase 0 spike finding, agents@0.12.4.)

#### 4.3.2 Communication paths

| Caller → Callee | Mechanism | Network overhead |
|---|---|---|
| Founder UI → CMO | HTTPS MCP Streamable HTTP, JWT auth | Single hop, edge-terminated |
| External Claude Desktop → Employee (Phase 2) | HTTPS MCP Streamable HTTP, OAuth | Single hop |
| CMO → Employee | `this.callMcpTool(role, tool, args, props)` via RPC | Zero (in-process DO binding) |
| Employee → CMO (read shared state) | `this.callMcpTool('cmo', 'query_*', ...)` | Zero |
| Employee → Employee (Phase 2 peer-DM) | `this.callMcpTool(peerRole, tool, args, props)` | Zero |
| Peer-DM shadow → CMO | `env.CMO.idFromName(userId).fetch('/internal/peer-dm-shadow')` | Zero, does NOT trigger onMessage |
| Worker cron → CMO | `env.CMO.idFromName(userId).fetch('/internal/cron-tick')` | Zero |

#### 4.3.3 Plan execution

Two forms of plan_items:

- **Immediate** — CMO chat tool routes directly to SMM via RPC, SMM executes,
  returns within the same turn.
- **Scheduled / conditional** — emit a Dynamic Workflow:

```typescript
await this.runWorkflow('AgentPlanWorkflow', {
  conversationId,
  planItemIds: ['pi_abc', 'pi_def'],
});

export class AgentPlanWorkflow extends Workflow<Env, PlanParams> {
  async run(event: WorkflowEvent<PlanParams>, step: WorkflowStep) {
    const xPost = await step.do('publish-x', () => callX(...));
    await step.sleep('2h');                          // free hibernation
    const reactions = await step.do('check-metrics', () => fetchMetrics(xPost.id));
    if (reactions.score > 7) {
      await step.do('publish-reddit', () => callReddit(...));
    }
  }
}
```

#### 4.3.4 Scheduling

- **Per-DO scheduling** — `this.schedule(date, 'handlerName', payload)` and
  `this.scheduleEvery(seconds, 'handlerName')`. Each DO manages its own cadence.
- **Worker-level cron** — `wrangler.jsonc` `triggers.crons` triggers Worker
  `scheduled()` which fans out to active CMOs via `env.CMO.idFromName(uid).fetch('/internal/cron-tick')`.

#### 4.3.5 Hibernation behavior

DOs hibernate when idle. CPU usage = 0 during hibernation. Wake triggers:

1. Incoming MCP request (founder, external client, or RPC from peer)
2. Internal fetch (cron tick, peer-DM shadow, init)
3. Scheduled task firing
4. WebSocket message
5. Webhook delivery

RPC connections (`addMcpServer`) survive hibernation as of Agents SDK v0.6.0
— binding name and props are persisted and restored.

### 4.4 Frontend integration

#### 4.4.1 Auth flow

1. User clicks "Sign in with GitHub" → Better Auth → GitHub OAuth dance →
   callback → session cookie issued
2. Better Auth `databaseHooks.user.create.after` hook fires when the new
   user row is INSERTed (i.e. first login), then `POST` to
   `shipflare-core /agents/cmo/<userId>/internal/init` (fire-and-forget,
   endpoint is idempotent) to seed CMO DO. Phase 1 S1.5 finding: Better
   Auth 1.6.11 does NOT expose `callbacks.session` — the correct first-
   login hook is `databaseHooks.user.create.after`. Reference shape:
   ```typescript
   databaseHooks: {
     user: {
       create: {
         after: async (user) => {
           await env.CORE.fetch(
             new Request(`https://internal/agents/cmo/${user.id}/internal/init`, {
               method: "POST",
               headers: { "x-shipflare-internal": "1", "content-type": "application/json" },
               body: JSON.stringify({ email: user.email, githubLogin: user.name ?? null }),
             })
           );
         },
       },
     },
   },
   ```
3. CMO DO `init` handler creates default `roster` (HoG + SMM hired), seeds
   `founder_context` placeholder; onboarding wizard fills in product
   details via `chat` tool turns

#### 4.4.2 Browser ↔ Core MCP connection (direct)

1. Browser hits `/api/mcp-token` on shipflare-web with session cookie
2. Web Worker validates session via Better Auth, signs short-lived (60s) JWT
   with `{ userId }` payload using `MCP_JWT_SECRET`
3. Browser opens MCP Streamable HTTP connection to
   `https://core.shipflare.com/agents/cmo/<userId>/mcp` with `Authorization: Bearer <jwt>`
4. Core Worker entry handler verifies JWT, enforces `claims.userId === url.userId`,
   checks `roster.role === active` if accessing a non-CMO employee, routes to
   the right DO instance with `x-mcp-props` injected
5. Streaming responses flow back via MCP chunks, browser renders via custom
   stream consumer (~30 lines using `eventsource-parser`)

#### 4.4.3 Platform OAuth (X / Reddit)

Channel OAuth is separate from login. Callback handler in shipflare-web:

1. Receive code, exchange with platform → tokens
2. Encrypt with WebCrypto AES-GCM (`CHANNEL_ENC_KEY` from `wrangler secret`)
3. Insert into `channels` table via D1
4. Redirect to `/settings/channels?connected=<platform>`
5. CMO picks up new channel on next `onStart` (subsequent founder message)

### 4.5 Bindings + secrets inventory

#### 4.5.1 Wrangler bindings

`shipflare-web`:

```jsonc
{
  "compatibility_flags": ["nodejs_compat"],
  "services": [{ "binding": "CORE", "service": "shipflare-core" }],
  "d1_databases": [
    {
      "binding": "DB",
      "database_name": "shipflare-prod",
      "database_id": "<d1-uuid-from-wrangler-d1-create>",
      "migrations_dir": "./migrations"
    }
  ],
  "assets": { "directory": ".open-next/assets" }
}
```

`shipflare-core`:

```jsonc
{
  "compatibility_flags": ["nodejs_compat"],
  "d1_databases": [
    {
      "binding": "DB",
      "database_name": "shipflare-prod",
      "database_id": "<same-d1-uuid-as-web>",
      "migrations_dir": "./migrations"
    }
  ],
  "durable_objects": {
    "bindings": [
      { "name": "CMO",                "class_name": "CMO" },
      { "name": "HEAD_OF_GROWTH",     "class_name": "HeadOfGrowth" },
      { "name": "SOCIAL_MEDIA_MGR",   "class_name": "SocialMediaMgr" },
      { "name": "X_MCP",              "class_name": "XMcpAgent" },
      { "name": "REDDIT_MCP",         "class_name": "RedditMcpAgent" }
      // Phase 2 additions: COPYWRITER, COMMUNITY_MGR, BRAND_ANALYST, ...
    ]
  },
  "migrations": [
    { "tag": "v1", "new_sqlite_classes": [
      "CMO", "HeadOfGrowth", "SocialMediaMgr", "XMcpAgent", "RedditMcpAgent"
    ]}
  ],
  "workflows": [
    { "binding": "AGENT_PLAN_WORKFLOW", "name": "agent-plan-workflow",
      "class_name": "AgentPlanWorkflow" }
  ],
  "triggers": { "crons": ["0 * * * *"] }
}
```

#### 4.5.2 Secrets

All set via `wrangler secret put <NAME>` (per Worker), never in source or
`wrangler.jsonc`. Local dev via `.dev.vars` (gitignored).

| Secret | Worker | Purpose |
|---|---|---|
| `ANTHROPIC_API_KEY` | core | LLM calls inside every McpAgent |
| `MCP_JWT_SECRET` | web + core | HS256 signing for browser → core auth tokens |
| `CHANNEL_ENC_KEY` | web + core | AES-GCM key for channels.oauthTokenEncrypted |
| `BETTER_AUTH_SECRET` | web | Better Auth session signing |
| `GITHUB_CLIENT_ID` | web | GitHub OAuth (login) |
| `GITHUB_CLIENT_SECRET` | web | GitHub OAuth (login) |
| `X_CLIENT_ID` | web | X OAuth (channel) |
| `X_CLIENT_SECRET` | web | X OAuth (channel) |
| `REDDIT_CLIENT_ID` | web | Reddit OAuth (channel) |
| `REDDIT_CLIENT_SECRET` | web | Reddit OAuth (channel) |
| `XAI_API_KEY` | core | xAI Grok for discovery |

`MCP_JWT_SECRET` and `CHANNEL_ENC_KEY` must be identical between web and core
(web signs / encrypts, core verifies / decrypts). Bootstrap script generates
both as 32-byte random and runs `wrangler secret put` for both Workers.

#### 4.5.3 Local development

```
pnpm-workspace.yaml defines:
  - apps/*
  - packages/*

Root scripts (package.json):
  pnpm dev               # runs both workers in parallel via concurrently
  pnpm dev:web           # cd apps/web && wrangler dev --port 3000
  pnpm dev:core          # cd apps/core && wrangler dev --port 3001
  pnpm test              # vitest across all packages
  pnpm typecheck         # tsc -b across all packages
  pnpm migrate           # wrangler d1 migrations apply (D1)
```

`.dev.vars` files (one per Worker, gitignored):

```
# apps/web/.dev.vars
BETTER_AUTH_SECRET=<32 bytes hex>
GITHUB_CLIENT_ID=<dev OAuth app>
GITHUB_CLIENT_SECRET=<dev OAuth app>
MCP_JWT_SECRET=<32 bytes hex>
CHANNEL_ENC_KEY=<32 bytes base64>
X_CLIENT_ID=<dev>
X_CLIENT_SECRET=<dev>
REDDIT_CLIENT_ID=<dev>
REDDIT_CLIENT_SECRET=<dev>

# apps/core/.dev.vars
ANTHROPIC_API_KEY=<key>
MCP_JWT_SECRET=<same as web>
CHANNEL_ENC_KEY=<same as web>
XAI_API_KEY=<key>
```

Service Binding works in local dev as long as both Workers run via the same
`wrangler` process (`pnpm dev` uses `wrangler dev --remote-bindings` or the
multi-worker dev mode).

### 4.6 MCP exposure strategy

Phase 1: all MCP servers reachable internally via RPC; HTTP route registered
but gated by a feature flag (default `off`). External requests return 404.

Phase 2: per-employee HTTP MCP becomes a paid feature. UI surfaces user-specific
MCP URLs that the founder can paste into Claude Desktop / Cursor / their own
LLM stack. OAuth handshake required; scope determines what tools the external
client sees.

---

## 5. Migration Plan

### 5.1 Phase 0 — Compatibility spike (1.5-2 days)

Goal: validate critical-path runtime / library compatibility before committing
to parallel build. One throwaway `shipflare-spike` Worker project, one file per
spike item.

#### 5.1.1 Spike checklist

| # | Item | Pass criteria |
|---|---|---|
| 1 | Anthropic SDK streaming + tool use in Workers | 100 stream turns no `tool_use_id` mismatch, no silent fallback |
| 2 | McpAgent + addMcpServer RPC, in-process | `props` arrives in tool handler; no outbound HTTP in `wrangler tail` |
| 3 | MCP Streamable HTTP serving external clients | `@modelcontextprotocol/inspector` connects, streams cleanly |
| 4 | Better Auth + Drizzle + D1 | GitHub OAuth completes, session 30-day cookie, Drizzle queries no socket errors |
| 5 | WebCrypto AES-GCM round-trip | 100 random tokens encrypt/decrypt cleanly |
| 6 | DO SQLite perf | 10K row table: `SELECT WHERE ORDER BY` < 50ms p99, `INSERT` < 5ms p99 |
| 7 | Dynamic Workflow with sleep + do | Workflow completes through `step.sleep` after DO eviction |
| 8 | Service Binding web → core | Internal fetch transparent, headers passthrough |
| 9 | Cron fan-out | `triggers.crons` fires on time, reaches target DO |
| 10 | Resumable streaming | Kill client mid-stream, reconnect, resume from `Last-Event-ID` |

#### 5.1.2 Risk register (sorted by severity)

| Risk | Probability | Impact | Mitigation |
|---|---|---|---|
| Anthropic SDK streaming + tool use edge bug | Med | High | Pin SDK version; fallback to raw fetch + SSE parser |
| Better Auth on Workers + Drizzle + D1 integration | Med | High | Spike #4 mandatory; fallback Auth.js v5 (more invariants but works) |
| DO SQLite 10 GB per-instance ceiling | Low | Med | Monitor; archive old conversations to R2 above threshold |
| MCP HTTP streaming browser compat (Safari / Firefox) | Low | Med | Cross-browser test in spike; EventSource polyfill if needed |
| Dynamic Workflows beta API churn | Low | Med | Pin SDK; keep `runFiber` fallback path |
| Service Binding through OpenNext Next.js wrapper | Med | Med | Spike #8; fallback to public HTTPS + JWT |
| `nodejs_compat` bundle size over 1 MB limit | Med | Med | `wrangler check startup`; trim Node deps |
| WebCrypto incompatible with current Node-encrypted data | Low | Low | No users; discard old data |
| MCP RPC props lost after hibernation | Low | High | Spike #2 must verify hibernate-and-resume |
| D1 missing a SQLite feature we depend on | Low | Med | Validated during Spike #4; cross-team data is simple (5 tables, no exotic types). |

#### 5.1.3 Ship gate

All 10 items GREEN → Phase 1 starts.
Any RED → decide on the spot: change approach / accept fallback / defer that
capability.

### 5.2 Phase 1 — Full feature parity (~3 weeks)

Goal: ShipFlare's current capabilities all run on the new stack. **No deferred
items.** This is the only acceptable Phase 1 done state.

#### 5.2.1 Ship gate

```
P0 — must work end-to-end:
  ✓ GitHub login (Better Auth)
  ✓ X channel OAuth
  ✓ Reddit channel OAuth
  ✓ Streaming chat with CMO
  ✓ New conversation resets chat (preserves founder_context / strategic_path / plan)
  ✓ Hire / fire employee in UI
  ✓ HoG generates strategic_path on demand
  ✓ SMM finds X threads (via xAI) and drafts replies
  ✓ SMM finds Reddit threads and drafts replies
  ✓ SMM drafts X posts and Reddit posts from plan_items
  ✓ Validators run: platform-leak, validate_draft, reply-throttle
  ✓ Approval queue: drafts surface in /drafts UI, founder approves, posted
  ✓ Posted history persisted (posted table per platform MCP)
  ✓ Cron sweep fans out hourly to active CMOs
  ✓ Dynamic Workflow handles scheduled / conditional posts
  ✓ Founder voice extracted in onboarding, injected into every drafting LLM call

Quality bars:
  ✓ E2E latency vs current version ≤ +10%
  ✓ Anthropic token consumption vs current version ±10%
  ✓ 24h dogfood with zero critical bugs
```

#### 5.2.2 Work streams (10, parallel where dependencies allow)

```
Day 0-1: S1 Infra (blocking foundation)
         ├─ wrangler.jsonc × 2 (web + core)
         ├─ Better Auth + Drizzle + D1 setup
         ├─ WebCrypto AES-GCM helper
         ├─ Drizzle migrations for 5 D1 tables
         ├─ Secrets bootstrap (wrangler secret put × N)
         └─ pnpm workspace + tsconfig

Day 2-9: Parallel streams
  S2 CMO McpAgent
     ├─ Class skeleton + tools (chat, delegate, hire_employee, ...)
     ├─ Internal endpoints (init, peer-dm-shadow, cron-tick)
     └─ Schema for 8 SQLite tables

  S3 HeadOfGrowth McpAgent
     ├─ Class skeleton + tools (generate_strategic_path, audit_plan, ...)
     ├─ Port existing planning logic from coordinator AGENT.md
     └─ Schema for 3 SQLite tables

  S4 SocialMediaMgr McpAgent
     ├─ Class skeleton + tools (find_threads_via_xai, process_replies_batch, ...)
     ├─ Port existing SMM AGENT.md logic
     └─ Schema for 4 SQLite tables

  S5 Platform MCPs
     ├─ XMcpAgent (port src/tools/x-*)
     ├─ RedditMcpAgent (port src/tools/reddit-*)
     └─ Per-platform rate limit / call cache tables

  S6 Skills port
     ├─ Move src/skills/** to packages/skills
     ├─ Replace fork runner with MCP tool invocation
     ├─ Ensure all 6+ skills end-to-end: drafting-post, drafting-reply,
        judging-thread, validating-draft, generate-queries, etc.
     └─ Validate shared-references mechanism

  S7 Frontend
     ├─ OpenNext setup + Next.js 16 build
     ├─ Pages: login / chat / team / plan / drafts / settings
     ├─ MCP client integration (chat streaming)
     └─ Better Auth UI components

  S8 Auth flows
     ├─ GitHub OAuth via Better Auth
     ├─ X / Reddit OAuth callbacks (with WebCrypto encryption)
     └─ CMO `/internal/init` webhook from Better Auth
        `databaseHooks.user.create.after` (first-login hook)

  S9 DevX
     ├─ wrangler dev parallel: web + core
     ├─ Vitest + @cloudflare/vitest-pool-workers
     ├─ GitHub Actions CI (build / typecheck / test)
     └─ Deploy to staging + production environments

Day 10-12: S10 E2E + dogfood
  ├─ Playwright E2E: full founder journey
  ├─ Fix integration bugs
  └─ Token consumption + latency benchmarks

Day 13-14: Deploy to production + internal dogfood
```

#### 5.2.3 Deliverables — Phase 1 done

| Stream | Deliverables |
|---|---|
| S1 | Workers boot, login dance works, DB migrate clean |
| S2 | CMO MCP inspector smoke: chat tool returns + persists |
| S3 | HoG generates strategic_path on RPC, commits via CMO tool |
| S4 | SMM RPC drafts a reply end-to-end (mock X tool ok) |
| S5 | X / Reddit happy + error paths covered |
| S6 | ≥ 6 skills running through new tool plumbing |
| S7 | Browser chat with streaming, no flicker |
| S8 | GitHub OAuth produces `user` row + signed JWT; X / Reddit channel rows encrypted |
| S9 | `pnpm typecheck && pnpm test` green in CI |
| S10 | Playwright video: login → connect X → chat → delegate → draft → approve → posted |

#### 5.2.4 Repo layout

```
shipflare/
  apps/
    web/                          # shipflare-web Worker (Next.js + OpenNext)
      app/                        # Next.js App Router
      wrangler.jsonc
      open-next.config.ts
    core/                         # shipflare-core Worker
      src/
        agents/
          cmo/
            CMO.ts                # McpAgent class
            tools/
            references/
          head-of-growth/
          social-media-manager/
        platforms/
          x/XMcpAgent.ts
          reddit/RedditMcpAgent.ts
        workflows/
          AgentPlanWorkflow.ts
        index.ts                  # entry
      wrangler.jsonc

  packages/
    shared/                       # mcp-props, role-registry, types (both workers)
    skills/                       # markdown skills + references (IP)
    tools/                        # X / Reddit client, validators
    db/                           # Drizzle schemas (D1 only)
    crypto/                       # WebCrypto helper

  .dev.vars                       # local secrets
  pnpm-workspace.yaml
  tsconfig.base.json
  package.json
```

#### 5.2.5 Delete checklist (apply after Phase 1 ships + 1 week observation)

```
# Schemas (move to DO SQLite)
src/lib/db/schema/agent_runs.ts
src/lib/db/schema/team_messages.ts
src/lib/db/schema/team_members.ts
src/lib/db/schema/plan_items.ts
src/lib/db/schema/threads.ts
src/lib/db/schema/posts.ts
src/lib/db/schema/drafts.ts
src/lib/db/schema/strategic_paths.ts
src/lib/db/schema/products.ts        # absorbed into CMO founder_context
src/lib/db/schema/xai_calls.ts       # not migrated
src/lib/db/schema/tool_audit.ts      # not migrated

# Workers / queues
src/workers/                          # entire directory

# AgentTool system (replaced by MCP RPC)
src/tools/AgentTool/

# Node crypto helper
src/lib/auth/account-encryption.ts    # replaced by WebCrypto

# Dependencies
pnpm remove bullmq ioredis bull-board

# CLAUDE.md sections
"## Agent Teams Architecture" section          # rewrite with 2 invariants
"## Skill Primitive" section                   # mostly preserved
"## Primitive Boundaries — Tool / Skill / Agent" # mostly preserved
"## Security TODO" section                     # update with WebCrypto note
```

#### 5.2.6 Preserve checklist (do NOT delete during migration)

```
src/skills/**                          # all markdown + references (IP)
src/tools/x-*.ts / reddit-*.ts         # tool logic (rewrap as MCP tools)
src/lib/platform-config.ts             # business facts
src/lib/content/validators/platform-leak.ts  # validator logic
src/lib/reply-throttle.ts              # business logic (move to packages/tools)
```

### 5.3 Phase 2 — New capabilities (~2-4 weeks, starts day after Phase 1 ships)

Priority-ordered. Phase 2 starts immediately on Phase 1 completion — no gap.

| ID | Capability | Why it's now easy |
|---|---|---|
| **P2-A** | External MCP exposure (paid feature) | `MyMCP.serve(...)` adds zero work; OAuth scope controls what external clients see |
| **P2-B** | Expanded roster: Copywriter, Brand Analyst, Community Manager | Each = one McpAgent class + ROLE_REGISTRY entry |
| **P2-C** | Peer-DM (Copywriter ↔ SMM, etc.) | `addMcpServer` to peer + shadow-fetch to CMO |
| **P2-D** | Opt-in cross-conversation memory | New `cross_conversation_memory` table; UI "remember this" button; LLM-injected on session start |
| **P2-E** | New channels: LinkedIn / HN / Discord | New McpAgent per channel; OAuth callback; platform-config entry |
| **P2-F** | Web push notifications | Agents SDK built-in `webPush` API |

### 5.4 Time budget

```
Phase 0 spike:           1.5 - 2 days
Phase 1 (full parity):   ~3 weeks
  Week 1:                S1 + S2
  Week 2:                S3-S6 in parallel
  Week 3:                S7-S10 + dogfood + production deploy
Phase 2 (new capabilities): ~2-4 weeks
  Week 4-5:              P2-A external MCP (highest commercial value)
  Week 6+:               P2-B through P2-F by demand

Total: spike → P2-A live: ~5-6 weeks
```

---

## 6. Invariants (Post-Migration)

CLAUDE.md's "Agent Teams Architecture" section collapses to two invariants
(down from seven), because the rest are now framework guarantees:

### 6.1 Surviving invariants

1. **CMO SQLite is the per-team source of truth.** Other employees never write
   CMO SQLite directly. All writes go through CMO's exposed MCP tools
   (`commit_strategic_path`, `add_plan_item`, `approve_draft`, etc.). Direct
   cross-DO SQL access = review reject.
2. **Peer-DM shadow MUST NOT trigger CMO's onMessage / chat handler.** Use
   `env.CMO.idFromName(uid).fetch('/internal/peer-dm-shadow')`, not RPC tool
   calls. The shadow handler appends to `employee_log` and returns; CMO sees
   it on next natural wake.

### 6.2 Framework-provided invariants (no longer hand-enforced)

- Single-threaded message processing per DO (replaces mailbox row lock)
- Mailbox idempotency (DO handles ordering)
- Hibernation on idle (replaces sleep / slot-yield protocol)
- Tool authorization via props (replaces 4-layer assembleToolPool)
- RPC connection persistence across hibernation (replaces `delivered_at` semantics)
- Role-based tool visibility via props.caller checks inside McpAgent
  (replaces INTERNAL_TEAMMATE_TOOLS blacklists)

---

## 7. Open Questions / Future Work

These are explicitly deferred:

- **Cron schedule granularity.** Whether to cron-tick CMOs every hour
  vs every 15 min vs per-channel cadence. Decide based on Phase 1 token cost
  observations.
- **Multi-conversation per-user UX.** Current design supports it (conversation
  IDs are first-class), but UI design for "switching between conversations"
  is Phase 2 polish.
- **External MCP OAuth scope schema.** What permissions an external Claude
  Desktop session has by default (read-only? draft-only? full?). Phase 2
  product decision.
- **Workflow vs scheduling overlap.** When to use `this.schedule()` vs
  `runWorkflow()` for delayed work. Rule of thumb: workflow when multi-step
  with branches; schedule when one-shot trigger.
- **DO SQLite migration tooling.** No migration framework like Drizzle for
  DO SQLite; schema versioning by `ctx.blockConcurrencyWhile(checkAndMigrate)`
  in constructor. Build a thin helper in `packages/shared` during S2.
- **Audit log.** Removed `xai_calls` / `tool_audit` tables in migration. If
  needed, add a `audit_log` table in D1 or a tail-only stream to R2.

---

## 8. References

- [Agents SDK v0.6.0 changelog (Feb 2026)](https://developers.cloudflare.com/changelog/post/2026-02-25-agents-sdk-v060/)
- [Cloudflare Dynamic Workflows announcement](https://blog.cloudflare.com/dynamic-workflows/)
- [Cloudflare Agents SDK docs](https://developers.cloudflare.com/agents/)
- [MCP transports](https://developers.cloudflare.com/agents/model-context-protocol/transport/)
- [Durable Objects docs](https://developers.cloudflare.com/durable-objects/)
- [OpenNext for Cloudflare](https://opennext.js.org/cloudflare)
- [Better Auth on Cloudflare](https://better-auth.com/blog/1-5)
- [Drizzle + D1](https://developers.cloudflare.com/d1/tutorials/build-a-comments-api/#3-create-database-and-schema)
- Prior internal spec: `docs/superpowers/specs/2026-05-01-agent-skill-tool-decomposition-design.md`
- Prior internal spec: `docs/superpowers/specs/2026-04-30-skill-primitive-restoration-design.md`
