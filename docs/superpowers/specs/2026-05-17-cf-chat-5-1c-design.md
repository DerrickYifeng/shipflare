# 5.1c — Port deleted SMM/HoG tools + daily relay orchestration

**Date:** 2026-05-17
**Branch:** `feat/cf-native-chat-migration`
**Predecessor specs:**
- `docs/superpowers/specs/2026-05-16-cf-native-chat-migration-design.md` (parent)
- `docs/superpowers/plans/2026-05-16-task-5.1-amendment.md` (CMO rewrite scope)

---

## Goal

Close the functional gap in `feat/cf-native-chat-migration`: the agent system can chat but cannot drive discovery, drafting, or scheduled sweeps. Re-implement the 8 tools deleted during Phase 4/5 (six SMM, two HoG) under the new AIChatAgent + consult-tool architecture, and replace the noop `cron-tick` stub with a per-user, alarm-driven daily relay.

---

## Decisions locked in (brainstorming Q&A)

| # | Question | Decision |
|---|---|---|
| Q1 | Where does discovery/draft working state live? | **Peer-owned.** SMM owns `threads_inbox` + `drafts`; HoG owns `planning_chat` + `proposal_drafts` + `audit_findings`. CMO is a pure orchestrator. |
| Q2 | Cron model | **Daily relay.** CMO reads strategy + plan, decides today's plays, hands off via `consult` — "relay team" model. |
| Q3 | Synthetic turn shape | **System-role message** injected on tick. Hidden from `/chat`; assistant reply is visible. |
| Q4 | Approval-queue mirror trigger | **Synchronous shadow POST** from peer → `/internal/mirror-draft` on CMO. Same pattern as existing peer-DM shadow. |
| Q5 | `research_reddit_channels` writes to founder_context.subreddits — who writes? | **CMO writes after consult returns.** Peer returns data; CMO LLM calls `setFounderContext`. Preserves invariant: peers don't write CMO state directly. |
| Q6 | `list_drafts` as peer tool? | **Dropped.** Founder UI reads CMO's `queryDrafts` (against mirrored `approval_queue`). SMM has no need to read its own drafts during a turn. |
| Q7 | Cron-tick model | **DO `alarm()` per CMO.** Idiomatic Cloudflare. No outer cron entry for relay. Each CMO schedules its own next-day alarm. |
| Q8 | When does the relay fire? | **Founder's local 9am**, per-user TZ. |
| Q9 | TZ discovery | **Auto from browser `Intl.DateTimeFormat().resolvedOptions().timeZone`** passed via WS query string; `request.cf.timezone` as IP fallback for non-browser clients. Founder can override later in `/settings/relay`. |
| Q10 | TZ bootstrap for existing users | **Lazy.** On first WS connect after deploy, CMO writes inferred TZ + schedules first alarm. No backfill script. |
| Q11 | Render assistant relay summary? | **Yes.** System-role synthetic message is hidden; the assistant's reply is rendered in `/chat`. Founder opens app, sees a summary of yesterday's relay. |

---

## 1. Architecture overview — the relay model

```
[daily DO alarm fires at founder's local 9am]
  └─► CMO.alarm()
        ├─► (a) skip if !founder_context.productName  → reschedule for tomorrow
        ├─► (b) insert synthetic system-role message  → trigger LLM turn
        │       (metadata.source = 'daily-relay')
        │
        └─► onChatMessage runs the CMO LLM:
              ├─► reads founder_context, strategic_path, plan_items via existing tools
              ├─► decides today's plays from strategy + pending plan items
              ├─► consult('smm', { question: "discover threads about $product on X" })
              │     └─► SMM LLM: find_threads_via_xai → writes threads_inbox
              ├─► consult('smm', { question: "draft replies for inbox rows 1-N" })
              │     └─► SMM LLM: process_replies_batch
              │          - drafts persisted to SMM.drafts
              │          - for each status='ready' draft → POST /internal/mirror-draft to CMO
              │            → CMO inserts row in approval_queue
              ├─► consult('smm', { question: "draft posts for plan items {ids}" })
              │     └─► similar for process_posts_batch
              ├─► consult('hog', { question: "audit current plan; surface gaps" })
              │     └─► HoG LLM: audit_plan → writes audit_findings → returns summary
              ├─► (optional) consult('hog', { question: "propose new strategic path" })
              │     └─► HoG LLM: generate_strategic_path → writes proposal_drafts
              │          - POSTs /internal/strategic-path-proposal to CMO
              │          - CMO inserts row in strategic_path with status='proposed'
              ├─► commits decisions via existing CMO tools:
              │     - setFounderContext(subreddits)
              │     - addPlanItem(new items from audit)
              │     - commitStrategicPath (if proposed version accepted)
              └─► emits a one-paragraph summary as the assistant message
                    → rendered in /chat; founder reads in the morning
        │
        └─► (c) schedule next alarm 24h forward
```

### 1.1 State ownership

| Table | Owner | Sole writer | Reader(s) |
|---|---|---|---|
| `founder_context`, `strategic_path`, `plan_items`, `approval_queue`, `cross_conversation_memory`, `employee_log`, `progress_snapshots`, `push_subscriptions` | **CMO** | CMO LLM tools + `/internal/mirror-draft` + `/internal/strategic-path-proposal` | CMO LLM, founder UI |
| `threads_inbox`, `drafts` | **SMM** | SMM peer tools | SMM LLM only |
| `planning_chat`, `proposal_drafts`, `audit_findings` | **HoG** | HoG peer tools | HoG LLM only |

### 1.2 Invariants preserved

1. **No cross-DO SQL.** Peers never read or write CMO SQLite directly. All cross-DO writes go through CMO's exposed `/internal/*` shadow endpoints (or RPC tool calls invoked from inside the CMO LLM).
2. **Peer-DM shadow pattern reused.** The two new shadow endpoints (`/internal/mirror-draft`, `/internal/strategic-path-proposal`) follow the exact pattern already in production for peer-DM (`apps/core/src/agents/cmo/CMO.ts` — search for `peer-dm-shadow`).
3. **CMO `getTools()` does not grow.** The LLM already has `consult` + readers (`queryFounderContext`, `queryPlanItems`, `queryDrafts`) + writers (`setFounderContext`, `addPlanItem`, `commitStrategicPath`, `approveDraft`, `rejectDraft`). It needs nothing new.

---

## 2. Peer surfaces

### 2.1 SMM — 5 new peer tools

`apps/core/src/agents/social-media-manager/SocialMediaMgr.ts:getTools()`:

```typescript
getTools() {
  return {
    consult: makeConsultTool('smm'),                      // already wired
    find_threads_via_xai: registerFindThreadsViaXaiTool(this),
    find_threads:          registerFindThreadsTool(this),
    process_replies_batch: registerProcessRepliesBatchTool(this),
    process_posts_batch:   registerProcessPostsBatchTool(this),
    research_reddit_channels: registerResearchRedditChannelsTool(this),
  };
}
```

Tool contracts (zod-validated input + structured output) — see §2.3 for the recurring shapes.

#### `find_threads_via_xai`

**Purpose:** Search + judge + persist. The discovery entry point.

```typescript
input: {
  platform: 'x' | 'reddit',
  intent?: string,             // 'engagement' | 'competitor-watch' | etc. default 'engagement'
  maxResults?: number,          // 1..50, default 20
}
output: {
  queued: number,
  scanned: number,
  platform: string,
  error?: string,
}
```

**Flow:**
1. Read `productName` + `productDescription` from CMO via `consult` upward? **No** — peers don't consult CMO upward (spec invariant §3.2). Instead: SMM reads founder context via an MCP call to CMO's exposed surface, OR receives it inlined in the consult `context` field from CMO at dispatch time. **Decision: inline via `context`.** CMO's prompt template fills in product context when consulting SMM.
2. Call platform MCP search tool (`X_MCP.x_search` or `REDDIT_MCP.reddit_search`).
3. `runSkill('judging-thread', { product, productDescription, threads })`.
4. Insert qualifying rows into `threads_inbox`.
5. Return `{ queued, scanned, platform }`.

Forward-compat fallback (matching the deleted code): if platform MCP not connected, return `{ error: '<platform>_MCP not deployed' }` instead of throwing.

#### `find_threads`

**Purpose:** Read `threads_inbox` (no I/O, no LLM).

```typescript
input: {
  platforms?: ('x' | 'reddit')[],   // CSV filter; default all
  status?: 'pending' | 'drafted' | 'skipped',  // default 'pending'
  limit?: number,                     // 1..100, default 20
}
output: {
  threads: Array<{
    id: string, externalId: string, platform: string,
    author: string | null, content: string,
    judgeScore: number | null, judgedAt: number | null,
  }>,
}
```

ORDER BY `judged_at DESC` (null last). Defensive: if any row has `judged_at IS NULL` it's a logic bug — log warning, return at bottom of list.

#### `process_replies_batch`

**Purpose:** Draft replies for a batch of `threads_inbox.id` rows; persist; mirror to CMO.

```typescript
input: {
  threadIds: string[],          // 1..10
  context: string,              // founder_context summary from CMO (productName, voice, audience)
}
output: {
  drafted: number,
  failed: number,
  drafts: Array<{ draftId: string, threadId: string, status: 'ready' | 'failed', validationErrors?: string[] }>,
}
```

Per thread:
1. Read row from `threads_inbox`.
2. `runSkill('drafting-reply', { product, voice, thread })`.
3. `validateDraft(text, platform)` — platform-leak + length.
4. INSERT into `drafts` (kind='reply', status='ready' | 'failed').
5. If `status='ready'`: POST `/internal/mirror-draft` to CMO with `{ draftId, employee: 'smm', kind: 'reply', channel: thread.platform, preview: text.slice(0,140), createdAt }`. On non-2xx response, mark `drafts.mirror_error = response.status`; do not roll back.
6. UPDATE `threads_inbox.status = 'drafted'`.

#### `process_posts_batch`

**Purpose:** Draft original posts for a batch of `plan_items.id`.

```typescript
input: {
  planItemIds: string[],        // 1..10
  context: string,              // founder_context summary + plan_item details from CMO
}
output: same shape as process_replies_batch + { planItemId } per draft
```

Per plan item:
1. Caller (CMO) provides item details inline in `context` (avoids upward consult).
2. `runSkill('drafting-post', { product, voice, item })`.
3. `validateDraft`.
4. INSERT into `drafts` (kind='post', plan_item_id link).
5. If valid: POST `/internal/mirror-draft` to CMO.
6. Return draft summary; CMO LLM then calls `updatePlanItem(id, status='in_progress', output={ draftId })`.

#### `research_reddit_channels`

**Purpose:** Discover top-3 subreddits for the founder's ICP.

```typescript
input: {
  context: string,              // productName, audience, productDescription
}
output: {
  subreddits: Array<{ name: string, members: number, relevanceScore: number, reason: string }>,
  topThree: string[],           // names only, for direct setFounderContext use
}
```

1. Call `REDDIT_MCP.research_subreddits` (if connected) or return `{ error: 'REDDIT_MCP not deployed' }`.
2. Return the data. **Does not write CMO state.** The CMO LLM reads the consult response, decides to act, calls `setFounderContext({ key: 'subreddits', value: JSON.stringify(topThree) })`.

### 2.2 HoG — 2 new peer tools

```typescript
getTools() {
  return {
    consult: makeConsultTool('hog'),                      // already wired
    generate_strategic_path: registerGenerateStrategicPathTool(this),
    audit_plan:              registerAuditPlanTool(this),
  };
}
```

#### `generate_strategic_path`

**Purpose:** Propose a marketing strategy.

```typescript
input: {
  context: string,              // founder_context summary from CMO
  goal?: string,                // optional founder-specified goal
}
output: {
  proposalId: string,
  version: number,
  theme: string,
  narrative: { wedge, channels, tactics, kpis },
  mirrored: boolean,            // true if /internal/strategic-path-proposal POST succeeded
}
```

1. INSERT into `planning_chat` (user + assistant turns for continuity across consults).
2. Anthropic call → structured plan.
3. INSERT into `proposal_drafts` (version = max + 1).
4. POST `/internal/strategic-path-proposal` to CMO with `{ version, theme, narrative_json, generated_at, generated_by: 'hog' }`. CMO inserts row with `status='proposed'`.
5. Return summary. CMO LLM later calls `commitStrategicPath(id)` to approve.

#### `audit_plan`

**Purpose:** Review plan_items for gaps, redundancies, risks.

```typescript
input: {
  context: string,              // founder_context summary + plan_items snapshot from CMO
  statusFilter?: 'pending' | 'in_progress' | 'all',
}
output: {
  auditRunId: string,
  findingsCount: number,
  findings: Array<{
    id: string,
    severity: 'high' | 'med' | 'low',
    category: 'gap' | 'redundancy' | 'risk',
    finding: string,
    affectedPlanItems: string[],
  }>,
}
```

1. Anthropic call with plan items + product context.
2. INSERT each finding into `audit_findings` (HoG-private).
3. Return summary. CMO LLM may follow up by calling `addPlanItem` for high-severity gaps.

### 2.3 Recurring "context" pattern (peers don't consult upward)

All five SMM + two HoG tools accept a `context: string` input field. CMO populates this by reading its own state (`queryFounderContext`, `queryPlanItems`) and inlining the result in the `consult` call's `context` field. The consult tool's `peerInputSchema` already has `context?: string`.

This preserves the invariant that peers don't make upward RPC to CMO. It also makes peer tools deterministic — same context in, same behavior out — which simplifies testing.

---

## 3. CMO additions

### 3.1 Two new internal shadow endpoints

`apps/core/src/agents/cmo/CMO.ts:fetch()`:

#### `POST /internal/mirror-draft`

```typescript
if (url.pathname === '/internal/mirror-draft' && request.method === 'POST') {
  if (request.headers.get('x-shipflare-internal') !== '1') {
    return new Response('forbidden', { status: 403 });
  }
  const body = await request.json() as {
    draftId: string;
    employee: 'smm' | 'hog';
    kind: 'reply' | 'post';
    channel: 'x' | 'reddit';
    preview: string;
    createdAt: number;
  };
  // Idempotent: ignore duplicate draft_id
  const exists = this.sql.exec(
    'SELECT 1 FROM approval_queue WHERE draft_id = ? LIMIT 1',
    body.draftId,
  ).toArray();
  if (exists.length === 0) {
    this.sql.exec(
      `INSERT INTO approval_queue (id, draft_id, employee, kind, channel, preview, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      crypto.randomUUID(), body.draftId, body.employee, body.kind,
      body.channel, body.preview, body.createdAt,
    );
  }
  this.writeAgentEvent({
    kind: 'draft-mirrored',
    blobs: ['CMO', body.employee, body.channel, body.kind],
    indexes: [body.draftId],
  });
  return new Response('ok', { status: 200 });
}
```

#### `POST /internal/strategic-path-proposal`

Same shape; inserts into `strategic_path` with `status='proposed'`. Idempotent on `(version, generated_by)`.

### 3.2 `alarm()` handler

```typescript
async alarm() {
  const ctx = this.queryFounderContextRaw();   // existing helper

  if (!ctx.productName) {
    this.writeAgentEvent({ kind: 'relay-skip-no-product', blobs: ['CMO'] });
  } else {
    const synthetic = {
      id: `relay-${Date.now()}`,
      role: 'system' as const,
      content: SYNTHETIC_CRON_PROMPT,
      createdAt: new Date().toISOString(),
      metadata: { source: 'daily-relay' as const },
    };
    try {
      await this.runChatTurn([synthetic]);   // see §3.5 — exact API TBD in Phase-0 probe
      this.writeAgentEvent({ kind: 'relay-fired', blobs: ['CMO'] });
    } catch (err) {
      this.writeAgentEvent({
        kind: 'relay-failed',
        blobs: ['CMO', err instanceof Error ? err.message.slice(0, 200) : String(err)],
      });
    }
  }

  // Always reschedule for tomorrow, even on skip/fail. Self-healing.
  this.scheduleNextRelayAlarm();
}
```

### 3.3 `scheduleNextRelayAlarm()`

```typescript
private scheduleNextRelayAlarm(): void {
  const ctx = this.queryFounderContextRaw();
  const tz = ctx.tz ?? 'UTC';
  const hour = Number(ctx.relayHourLocal ?? '9');
  const nextMs = computeNextDailyAt(tz, hour, Date.now());
  this.ctx.storage.setAlarm(nextMs);
}
```

### 3.4 `computeNextDailyAt(tz, hour, nowMs)` — new pure utility

`apps/core/src/agents/cmo/scheduling.ts`:

```typescript
/**
 * Compute the next UTC ms timestamp where the wall-clock hour in `tz` is `hour`.
 * If `hour` has already passed today in `tz`, returns tomorrow's instance.
 * Uses Intl.DateTimeFormat for DST-safe arithmetic (no zone-offset math).
 */
export function computeNextDailyAt(tz: string, hour: number, nowMs: number): number {
  // Implementation: format `now` in `tz`, extract Y-M-D + current hour,
  // build target as `Y-M-D ${hour}:00:00` in `tz`, convert back to UTC ms.
  // If target <= now, add 24h. Handles DST jumps naturally.
}
```

Unit-tested independently across `Asia/Hong_Kong`, `America/New_York` (incl. spring-forward + fall-back), `UTC`, `Pacific/Auckland`.

### 3.5 Synthetic-turn injection — Phase-0c probe required

**Open question:** how exactly does one trigger an `onChatMessage` LLM turn programmatically from inside a DO `alarm()` handler in `@cloudflare/ai-chat`?

Two candidate APIs from the SDK:
- `this.onChatMessage(messages, { experimental_context })` — direct invocation; need to verify it works without a connected WS client.
- `this.persistChatMessages([synthetic])` + a separate trigger.

**Action:** Phase-0c verification task — read `@cloudflare/ai-chat` source in `node_modules`, write findings to `docs/superpowers/specs/2026-05-17-phase-0c-verifications.md`, lock the implementation pattern before writing sub-task 5.1c.13.

### 3.6 TZ inference on WS handshake

`apps/core/src/index.ts:handleCmoWsRequest`:

```typescript
const url = new URL(request.url);
const tzFromBrowser = url.searchParams.get('tz') ?? undefined;  // e.g. 'America/New_York'
const tzFromCf = (request.cf as { timezone?: string } | undefined)?.timezone;
const inferredTz = tzFromBrowser ?? tzFromCf ?? 'UTC';
```

Forward as a header to CMO's `onConnect` (or via the JWT props payload):

```typescript
const stub = env.CMO.get(env.CMO.idFromName(userId));
return stub.fetch(new Request(request.url, {
  method: request.method,
  headers: { ...Object.fromEntries(request.headers), 'x-inferred-tz': inferredTz },
}));
```

`apps/web/src/hooks/useCmoChat.ts`:

```typescript
const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
const wsUrl = new URL(`/cmo/${userId}`, env.CORE_WS_URL);
wsUrl.searchParams.set('tz', tz);
// existing token handling continues
```

### 3.7 Lazy TZ bootstrap

In CMO's `onConnect` (or the equivalent post-handshake hook):

```typescript
const headerTz = this.connectionMeta?.headers?.['x-inferred-tz'];
const ctx = this.queryFounderContextRaw();
if (!ctx.tz && headerTz) {
  this.setFounderContextRaw('tz', headerTz);
  // No relayHourLocal — falls back to 9 in scheduleNextRelayAlarm
  this.scheduleNextRelayAlarm();
}
// Do NOT overwrite existing tz — the founder may have set it manually.
```

---

## 4. SMM schema

`apps/core/src/agents/social-media-manager/schema.ts` (new file):

```typescript
export function applySmmSchema(sql: SqlStorage): void {
  sql.exec(`
    CREATE TABLE IF NOT EXISTS threads_inbox (
      id TEXT PRIMARY KEY,
      external_id TEXT NOT NULL,
      platform TEXT NOT NULL,                -- 'x' | 'reddit'
      author TEXT,
      content TEXT NOT NULL,
      intent TEXT,
      judge_score REAL,
      judge_reason TEXT,
      judged_at INTEGER,
      discovered_at INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending' -- 'pending' | 'drafted' | 'skipped'
    );
    CREATE INDEX IF NOT EXISTS idx_inbox_status_judged ON threads_inbox(status, judged_at DESC);
    CREATE INDEX IF NOT EXISTS idx_inbox_platform ON threads_inbox(platform);

    CREATE TABLE IF NOT EXISTS drafts (
      id TEXT PRIMARY KEY,                   -- == approval_queue.draft_id
      kind TEXT NOT NULL,                    -- 'reply' | 'post'
      channel TEXT NOT NULL,                 -- 'x' | 'reddit'
      thread_id TEXT,
      plan_item_id TEXT,
      body TEXT NOT NULL,
      body_title TEXT,                       -- Reddit posts only
      status TEXT NOT NULL,                  -- 'ready' | 'failed' | 'mirrored' | 'posted'
      validation_errors TEXT,                -- JSON
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      mirrored_at INTEGER,
      mirror_error INTEGER,                  -- HTTP status if mirror failed
      posted_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_drafts_status ON drafts(status, updated_at DESC);
  `);
}
```

Wired from `SocialMediaMgr.ensureSchema()`. No migration tag — `CREATE TABLE IF NOT EXISTS` is idempotent.

---

## 5. HoG schema

`apps/core/src/agents/head-of-growth/schema.ts` (new file):

```typescript
export function applyHogSchema(sql: SqlStorage): void {
  sql.exec(`
    CREATE TABLE IF NOT EXISTS planning_chat (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      conversation_id TEXT,
      role TEXT NOT NULL,                    -- 'user' | 'assistant'
      content TEXT NOT NULL,
      ts INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_planning_chat_ts ON planning_chat(ts DESC);

    CREATE TABLE IF NOT EXISTS proposal_drafts (
      id TEXT PRIMARY KEY,
      version INTEGER NOT NULL,
      theme TEXT NOT NULL,
      narrative_json TEXT NOT NULL,
      generated_at INTEGER NOT NULL,
      mirrored_to_cmo INTEGER NOT NULL DEFAULT 0,
      mirror_error INTEGER
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_proposal_version ON proposal_drafts(version);

    CREATE TABLE IF NOT EXISTS audit_findings (
      id TEXT PRIMARY KEY,
      audit_run_id TEXT NOT NULL,
      severity TEXT NOT NULL,                -- 'high' | 'med' | 'low'
      category TEXT NOT NULL,                -- 'gap' | 'redundancy' | 'risk'
      finding TEXT NOT NULL,
      affected_plan_items TEXT,              -- JSON array of plan_item ids
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_findings_run ON audit_findings(audit_run_id, severity);
  `);
}
```

Wired from `HeadOfGrowth.ensureSchema()`.

---

## 6. Founder UI (apps/web)

### 6.1 Render assistant relay summary, hide system synthetic

`apps/web/src/components/chat/MessageList.tsx` (or equivalent):

```tsx
{messages
  .filter(m => m.role !== 'system' || m.metadata?.source !== 'daily-relay')
  .map(m => <MessageBubble key={m.id} message={m} />)}
```

The assistant's response to the synthetic turn is a normal `role: 'assistant'` message and renders by default. Optionally style with a small "Daily relay · 2026-05-17 09:00" header above the first assistant message after a relay run, looked up by checking the preceding hidden system message's `createdAt`. **Polish, not blocking.**

### 6.2 `/settings/relay` — manual TZ + hour override

Single form, two fields:
- TZ: searchable IANA select (prefilled from current `founder_context.tz`).
- Relay hour: integer 0-23 (prefilled from `relayHourLocal`, default 9).

Submit POSTs to apps/web → forwards to `setFounderContext` via the existing pattern. On change, CMO's `setFounderContext` handler calls `scheduleNextRelayAlarm` (already in §3.3 design — `setFounderContext` watches for these two keys).

**Defer to follow-up if scope creeps.** v1 ships with auto-detect only; founder uses the chat to override ("Set my relay to 7am" → LLM calls `setFounderContext`).

---

## 7. Testing strategy

### 7.1 Unit (vitest, fast)

- `agents/social-media-manager/tools/find-threads-via-xai.test.ts`
- `agents/social-media-manager/tools/find-threads.test.ts`
- `agents/social-media-manager/tools/process-replies-batch.test.ts`
- `agents/social-media-manager/tools/process-posts-batch.test.ts`
- `agents/social-media-manager/tools/research-reddit-channels.test.ts`
- `agents/head-of-growth/tools/generate-strategic-path.test.ts`
- `agents/head-of-growth/tools/audit-plan.test.ts`
- `agents/cmo/internal-mirror-draft.test.ts` (incl. idempotency on duplicate `draft_id`, 403 on missing internal header)
- `agents/cmo/internal-strategic-path-proposal.test.ts`
- `agents/cmo/alarm.test.ts` (skip on no-product; fire on product set; always reschedule)
- `agents/cmo/scheduling.test.ts` (`computeNextDailyAt` — DST + multi-TZ matrix)
- `lib/tz-inference.test.ts` (browser > CF > UTC precedence)

### 7.2 Integration (vitest, real DOs)

- `chat-flow-consult-smm.test.ts` — CMO LLM consults SMM with a canned response; asserts `approval_queue` populated via mirror.
- `chat-flow-consult-hog.test.ts` — CMO LLM consults HoG; asserts `strategic_path` proposed row.
- `cmo-alarm-end-to-end.test.ts` — set founder context, manually invoke `alarm()`, assert synthetic turn fires (verify by counting `relay-fired` telemetry events written; LLM is mocked via skill stub).

### 7.3 Playwright real-LLM smoke

`apps/web/e2e/cmo-relay.spec.ts`:
- Authenticate as test founder.
- Trigger `/internal/cron-tick` (or directly invoke `alarm()` via admin endpoint with internal header).
- Wait up to 30s for an assistant message with text matching `/relay|queued|drafted/i` to appear in `/chat`.
- Open `/chat`, assert approval_queue contains ≥ 1 row via the existing draft list UI.

Per the resume note: vitest mocks don't propagate into the miniflare worker bundle, so real-LLM tests live in Playwright.

### 7.4 Telemetry verification (manual, post-deploy)

Query Analytics Engine SQL for `kind IN ('relay-fired', 'relay-skip-no-product', 'relay-failed', 'draft-mirrored', 'strategic-path-proposed')` after 24h soak.

---

## 8. Sub-task breakdown

19 sub-tasks. Order = topological by dependency.

| # | Task | Touches |
|---|---|---|
| 5.1c.0 | **Phase-0c probe** — verify `runChatTurn` / `onChatMessage` invocation API from `alarm()` | `docs/superpowers/specs/2026-05-17-phase-0c-verifications.md` |
| 5.1c.1 | SMM schema + `applySmmSchema` wiring | `agents/social-media-manager/schema.ts`, `SocialMediaMgr.ts` |
| 5.1c.2 | HoG schema + `applyHogSchema` wiring | `agents/head-of-growth/schema.ts`, `HeadOfGrowth.ts` |
| 5.1c.3 | `find_threads_via_xai` peer tool | `agents/social-media-manager/tools/find-threads-via-xai.ts` |
| 5.1c.4 | `find_threads` peer tool | `…/find-threads.ts` |
| 5.1c.5 | `process_replies_batch` peer tool + mirror POST | `…/process-replies-batch.ts` |
| 5.1c.6 | `process_posts_batch` peer tool + mirror POST | `…/process-posts-batch.ts` |
| 5.1c.7 | `research_reddit_channels` peer tool | `…/research-reddit-channels.ts` |
| 5.1c.8 | `generate_strategic_path` peer tool + mirror POST | `agents/head-of-growth/tools/generate-strategic-path.ts` |
| 5.1c.9 | `audit_plan` peer tool | `…/audit-plan.ts` |
| 5.1c.10 | CMO `/internal/mirror-draft` shadow handler | `agents/cmo/CMO.ts` |
| 5.1c.11 | CMO `/internal/strategic-path-proposal` shadow handler | `agents/cmo/CMO.ts` |
| 5.1c.12 | `computeNextDailyAt` + `scheduleNextRelayAlarm` | `agents/cmo/scheduling.ts`, `CMO.ts` |
| 5.1c.13 | `alarm()` handler + `SYNTHETIC_CRON_PROMPT` | `agents/cmo/CMO.ts`, `cmo/cron-prompts.ts` |
| 5.1c.14 | TZ inference on WS handshake (server + client) | `apps/core/src/index.ts`, `apps/web/src/hooks/useCmoChat.ts` |
| 5.1c.15 | Lazy TZ bootstrap on first connect | `agents/cmo/CMO.ts:onConnect` |
| 5.1c.16 | Drop CMO relay fan-out from outer `scheduled()` | `apps/core/src/index.ts` |
| 5.1c.17 | Hide synthetic system messages in `/chat`; render assistant reply | `apps/web/src/components/chat/MessageList.tsx` (and surrounding) |
| 5.1c.18 | Playwright `cmo-relay.spec.ts` | `apps/web/e2e/cmo-relay.spec.ts` |
| 5.1c.19 | Doc updates — CLAUDE.md (alarm-driven relay rule), RESUME.md | `CLAUDE.md`, plan doc |

**Parallelizable groups (worktree-friendly):**
- After 5.1c.1: tasks 5.1c.3 / 5.1c.4 / 5.1c.5 / 5.1c.6 / 5.1c.7 can run in parallel (each tool independent).
- After 5.1c.2: tasks 5.1c.8 / 5.1c.9 in parallel.
- Tasks 5.1c.10 / 5.1c.11 / 5.1c.14 / 5.1c.15 / 5.1c.16 / 5.1c.17 are mostly independent of one another and can be batched after the schema + peer-tool work.

---

## 9. Risks & open questions

| # | Risk / question | Mitigation |
|---|---|---|
| R1 | `runChatTurn` API shape not yet verified | **Phase-0c probe (5.1c.0) is the first task.** Plan does not write the alarm handler until probe completes. |
| R2 | Cost of `alarm()` waking N DOs simultaneously at 9am local — if all founders are in one TZ, we get a thundering herd | TZ spread is natural for global users; for single-TZ launches, accept up to ~N DO wake-ups within a 60s window. Cloudflare handles this fine at hundreds-of-N scale. Revisit only if monitoring shows alarm contention. |
| R3 | Synthetic turn could spam founder with "the assistant is typing" UI noise if WS is connected at relay time | UI hides system-source messages and any animation tied to them. Assistant reply lands as a normal message. |
| R4 | Mirror POST failure leaves draft un-mirrored | `drafts.mirror_error` records HTTP status. Drafts remain in SMM SQLite. Follow-up task (not blocking 5.1c): retry sweep on alarm tick that re-mirrors any draft with `status='ready' AND mirrored_at IS NULL`. |
| R5 | Founder edits TZ via chat, `setFounderContext` doesn't reschedule alarm | `setFounderContext` watches for `tz` / `relayHourLocal` keys (§3.3 wiring). Unit test covers it. |
| R6 | Existing users without TZ never get an alarm if they never reconnect | Lazy bootstrap on next WS connect (§3.7). Acceptable: users not actively using the app don't need relay. |
| R7 | Two daily-relay alarms could overlap if `setAlarm` is called twice without clearing | `setAlarm` replaces any existing alarm — guaranteed single alarm. |
| R8 | Cron-fan-out cleanup (5.1c.16) could regress `snapshotGrowth` | Plan keeps the 6h cron expression untouched; only the per-user `/internal/cron-tick` dispatch loop is removed. |

---

## 10. Self-review pass

- **Placeholder scan:** Phase-0c probe is the only "TBD" — explicitly called out as task 5.1c.0 and required to complete before 5.1c.13.
- **Internal consistency:** state ownership table (§1.1) consistent with peer tool flows (§2) and shadow handlers (§3.1). No table written by two owners.
- **Scope check:** large but single-themed (close functional gap on the chat-migration branch). Sub-task decomposition keeps each task ≤1 file in most cases. Plan-writing skill will further split if needed.
- **Ambiguity:** "context: string" inputs are JSON-ish blobs from CMO. Spec doesn't pin the JSON shape because the CMO LLM constructs them freely from its prompt — peers parse defensively. Acceptable looseness; matches consult-tool's existing `context?: string` shape.

---

## 11. Successor work (NOT part of 5.1c)

- Mirror retry sweep (R4) — separate small task.
- `/settings/relay` UI (§6.2) — defer if v1 auto-detect + chat override is sufficient.
- Founder-facing "Daily relay summary" banner with timestamp (§6.1) — polish, not blocking.
- Per-team CRON_FANOUT_CAP eviction (since alarm replaces outer cron, the cap can drop entirely or be re-purposed for snapshotGrowth).
