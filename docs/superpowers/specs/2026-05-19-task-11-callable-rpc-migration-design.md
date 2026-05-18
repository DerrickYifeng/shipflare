# Task #11 — Browser RPC migration via `@callable` on CMO

**Status:** Design ready for review.
**Branch target:** `dev` → eventually rolls into the cf-native-chat PR.
**Carries over from:** `docs/superpowers/plans/2026-05-18-phase-11-RESUME.md` Task #11.
**Predecessor design:** `docs/superpowers/specs/2026-05-16-cf-native-chat-migration-design.md`
(§6.2 promised `invokeAsTool` as the universal RPC primitive; the implementation
landed for `chat` only, leaving the right-panel surfaces stranded after Phase 5
retired the StreamableHTTP MCP transport).

## 1. Problem

`apps/web/src/lib/mcp-client.ts` (the `CmoClient` over `StreamableHTTPClientTransport`)
calls `/agents/cmo/<userId>/mcp` for every right-panel query. Phase 5 retired
that transport — `apps/core/src/index.ts:721-764` now answers any browser hit
with a 503 ("MCP transport retired in Phase 5; chat-native browser entry lands
in Phase 8"). Phase 8 migrated chat but did not rewire the queries.

The break has two faces:

- **Existing surface, stranded:** the AI-SDK `tool({...})` definitions inside
  `CMO.ts` still implement queryPlanItems, queryDrafts, approveDraft,
  rejectDraft, cancelPlanItem, queryFounderContext, queryMemory,
  queryAgentTranscript, rememberThis, forgetThis. The LLM can call them
  from inside a chat turn; the browser cannot reach them.
- **Deleted surface, never restored:** queryRoster, listConversations,
  startNewConversation, getRecentActivity, hireEmployee, fireEmployee
  were removed in `f61362ae` ("rewrite CMO as AIChatAgent + delete obsolete
  tool surface + migration v12"). Their SQLite tables (`roster`,
  `conversations`) were dropped too.

Net effect on the live `/team` and `/briefing` pages: right-panel data is empty,
roster shows zero employees, conversation list is empty, draft approval buttons
500, hire/fire is impossible.

## 2. Goals & non-goals

**Goals**

- Restore every right-panel query / mutation surface the `/team` and
  `/briefing` pages need.
- Use one transport for chat + queries (no parallel WS, no parallel
  HTTP proxy).
- Share business logic between the LLM-facing AI-SDK tools and the
  browser-facing RPC methods (one SQL implementation per surface).
- Delete the dead StreamableHTTP client and its support endpoints.

**Non-goals**

- No changes to the external `/cmo/mcp` OAuth-gated surface — that
  Phase 7 path is unaffected and keeps its scope-tier model.
- No changes to the chat transport itself (the WS established by
  `useCmoChat` continues to ride `useAgent` exactly as today).
- No new server-push / live-data primitives. Queries remain pull;
  callers re-fetch after mutations as they do today.
- No D1 schema changes. (`channels` is the only D1 table touched
  indirectly via existing code paths.)

## 3. Architecture

```
Browser (apps/web)                    apps/core Worker                    CMO DO (per-user)
─────────────────                     ───────────────                     ──────────────────
useCmoChat ──────────┐                                                    
                     │  one WS  →    handleCmoWsRequest                   onConnect
                     │   (JWT)        (JWT verify, x-inferred-tz)         │
useCmoStub ──────────┘                       │                            ├─ chat handler (existing)
                                             ↓                            │
agent.stub.queryDrafts({...})           routeAgentRequest (SDK)  ────→    ├─ @callable queryDrafts ──┐
                                                                          │  (auth: this.name        │
                                                                          │   === claims.name)       │
                                                                          ├─ @callable hireEmployee ──┤
                                                                          │   ...                    │
                                                                          │                          ↓
                                                                          │            private _queryDrafts(args)
                                                                          │            (shared with AI-SDK tool)
                                                                          └──────────────────────────┘
```

The transport is already in place. The agents SDK's `useAgent({...}).stub`
proxy invokes any `@callable`-decorated method on the connected DO over that
same WebSocket. JWT auth, multi-user routing (`name` → DO instance),
hibernation-aware reconnection, and ordered message delivery are framework
guarantees.

## 4. CMO `@callable` surface — 12 methods

**Revised after architecture conflict review (2026-05-19).** The original
brainstorm picked the "restore + hire/fire" option, but reading
`apps/core/src/agents/cmo/schema.ts:11-18` surfaced an explicit rewrite
decision: `roster`, `hireEmployee`, `fireEmployee` were dropped because
`EMPLOYEE_REGISTRY` is now the static org chart and every peer is always
available via `consult`. Hire/fire is an anti-pattern under the new model.

Resolution: **honor the rewrite**. queryRoster derives from
`EMPLOYEE_REGISTRY` (read-only). hire/fire are dropped from scope.
getRecentActivity is dropped too — it has no live UI caller (`grep`
confirmed only the dead wrapper in `mcp-client.ts`), and the activity
feed is now `useAgentToolEvents` (per-connection live stream, already
wired through `useCmoChat`).

Net surface: 10 wrappers around existing AI-SDK tools + 1 registry-derived
read + 2 new with a single new `conversations` table. The framework
genuinely does not partition `cf_ai_chat_agent_messages` by `useAgentChat`
id, so a `conversations` table is required to model multi-thread UI; the
rewrite's comment was incomplete on that point.

### 4.1 Wrap existing AI-SDK tools (no schema change)

For each of these, extract the `execute` body into a `private async _name(args)`
method on the CMO class. Both the AI-SDK tool definition and a new
`@callable() name(args)` public method delegate to it. One SQL impl, two
entry points.

| Method | Current location | Notes |
|---|---|---|
| `queryPlanItems` | CMO.ts:274 | unchanged shape; clamp limit ≤ 200 (already enforced server-side) |
| `cancelPlanItem` | CMO.ts:343 | throws on terminal state — keep same error |
| `approveDraft` | CMO.ts:382 | flips `approval_queue.decision = 'approved'` |
| `rejectDraft` | CMO.ts:404 | accepts optional `reason` for forward-compat |
| `queryDrafts` | CMO.ts:428 | wraps SMM RPC; returns `[]` if SMM not hired |
| `rememberThis` | CMO.ts:455 | P2-D long-term memory write |
| `forgetThis` | CMO.ts:480 | soft-delete (`active=0`) |
| `queryMemory` | CMO.ts:499 | newest-first, default limit 50 |
| `queryAgentTranscript` | CMO.ts:524 | per-role `employee_log` tail |
| `queryFounderContext` | CMO.ts:177 | returns KV map of raw JSON strings |

### 4.2 Registry-derived read (no schema change)

| Method | Behavior |
|---|---|
| `queryRoster` | Reads `EMPLOYEE_REGISTRY` (re-exported from `@shipflare/shared`) and returns the static org chart in the row shape the existing UI expects: `{ role, status: 'active', hired_at, hire_config_json }`. Every employee is always active; `hired_at` is the team's creation timestamp (founder_context.created_at, with `Date.now()` fallback). No SQL — no schema needed. |

### 4.3 New surfaces (require one schema addition)

| Method | Behavior | Schema dependency |
|---|---|---|
| `startNewConversation` | INSERT into `conversations`, return `{ conversationId }`. Caller navigates to `/team/<id>` and `useAgentChat({ agent, id: conversationId })` opens that thread. | new `conversations` table |
| `listConversations` | Newest-first, default limit 20, excludes archived. Caller renders left-rail thread list. | new `conversations` table |

### 4.4 SQLite schema additions

Appended to `apps/core/src/agents/cmo/schema.ts` as new `CREATE TABLE IF NOT
EXISTS` statements inside the existing `ensureSchema()` path. **Do not edit the
existing v12-v14 migration tags** — `wrangler` rejects same-tag mutations
(see prior RESUME).

```sql
CREATE TABLE IF NOT EXISTS conversations (
  id           TEXT PRIMARY KEY,
  started_at   INTEGER NOT NULL,
  ended_at     INTEGER,
  title        TEXT,
  archived_at  INTEGER
);
CREATE INDEX IF NOT EXISTS idx_conversations_active
  ON conversations(archived_at, started_at DESC);
```

The accompanying comment in `schema.ts` is rewritten to clarify why
`conversations` came back (framework single-bag storage), while leaving
the `roster` deletion rationale intact (the rewrite was correct on that).

### 4.5 Auth

**Primary gate for browser callers (already in place):** `handleCmoWsRequest` at
`apps/core/src/index.ts:584-586` rejects any WS upgrade where
`claims.name !== userId` (the URL segment that names the DO). Once a
WebSocket connection exists on this DO, the framework guarantees the
connecting JWT's `name` matches `this.name`. The `@callable` decorator
gates WS-RPC dispatch through the WebSocket envelope — so any browser
call to `agent.stub.queryDrafts(...)` is owner-scoped by construction.

**Peer-DO access surface (additional reachable path):** Public methods on
a Durable Object are ALSO directly callable from sibling Workers via
`env.CMO.getByName(...).queryDrafts(...)` — Cloudflare's native DO RPC
bypasses the WS gate entirely. This is safe today because:
1. Per-tenant isolation: `env.CMO.idFromName(userId)` returns a different
   DO per user, so a peer DO calling `cmoStub.queryDrafts()` only ever
   reads the same user's data the peer DO already operates on.
2. CLAUDE.md mandates peer DOs route writes through CMO's exposed
   `/internal/*` HTTP routes (e.g. `mirrorDraft`), not direct method
   invocation. The new @callable methods inherit the same convention.

If a future peer-DO call site needs to invoke a write-side @callable
(approveDraft, cancelPlanItem, etc.), prefer adding an `/internal/*`
route on CMO for that specific need — keeps the cross-DO surface
enumerable and code-reviewable.

**Per-method posture:** `@callable` bodies don't re-check JWT claims for
the browser path. The DO-name identity check at WS upgrade is sufficient
for browser callers. For peer-DO callers, the tenancy isolation
(`idFromName(userId)`) is the safety boundary — every public method is
implicitly scoped to "this DO's userId".

```ts
@callable()
async queryDrafts(args: QueryDraftsArgs): Promise<DraftRow[]> {
  return this._queryDrafts(args);
}
```

**Out of scope:** The external-MCP scope map in
`apps/core/src/lib/external-auth.ts` is **unchanged** — that path is
OAuth-gated for 3rd-party clients and keeps its read/write/admin
tiers. The `hireEmployee` / `fireEmployee` entries in that scope map
become unreferenced when this lands; leave them in place rather than
ripping out (they remain valid 3rd-party RPC contracts even if the
browser doesn't surface them — and the rewrite to actually delete
the map entries belongs in a separate cleanup PR).

## 5. apps/web client API

### 5.1 Delete

- `apps/web/src/lib/mcp-client.ts` — the `CmoClient` class and `createCmoClient`
- `apps/web/app/api/mcp-token/route.ts` — only consumer was `createCmoClient`
- Browser-side `@modelcontextprotocol/sdk` imports
  (the package stays in `apps/core` for `/cmo/mcp`'s `McpAgent.serve`)

### 5.2 Add

`apps/web/src/hooks/use-cmo-stub.ts`:

```ts
import { useAgent } from 'agents/react';
import type { CMO } from '@shipflare/core/agents/cmo/CMO';   // typed stub

export function useCmoStub(userId: string) {
  const agent = useAgent<CMO, CMOState>({
    agent: 'cmo',
    name: userId,
    host: useCoreHost(),
    query: async () => ({ token: await fetchAgentJwt('cmo', userId) }),
  });
  return { stub: agent.stub, ready: agent.ready, error: /* … */ };
}
```

The agents SDK does NOT de-dupe `useAgent({agent, name})` calls — each
invocation opens its own WebSocket. To guarantee one WS per page tree,
we extract WS creation into `useCmoAgent`; both `useCmoChat` and
`useCmoStub` take the resulting `agent` as input. Pages mount
`useCmoAgent` once and thread the result through both downstream hooks.

### 5.3 Migrate call sites (7 files)

| File | Methods used | Migration |
|---|---|---|
| `app/(app)/team/_components/team-desk.tsx` | queryRoster, listConversations, queryPlanItems, queryDrafts, startNewConversation, approveDraft, rejectDraft, cancelPlanItem | swap `clientRef.current.*` → `stub.*`; drop `createCmoClient()` effect; rely on `useCmoStub().ready`. Any existing UI affordances for hire/fire (if present) become read-only roster cards. |
| `app/(app)/team/_components/teammate-transcript-drawer.tsx` | queryAgentTranscript | same |
| `app/(app)/briefing/_components/today-tab.tsx` | queryDrafts, approveDraft | same |
| `app/(app)/briefing/_components/history-tab.tsx` | queryDrafts | same |
| `app/(app)/briefing/_components/plan-tab.tsx` | queryPlanItems | same |
| `app/(app)/briefing/_components/briefing-header.tsx` | (derived count) | depends on today-tab's data — receives via props |
| `app/(app)/growth/reddit-channels/reddit-channels-content.tsx` | queryFounderContext | same |

No call site keeps a "client ref" pattern. Each component either calls
`stub.foo()` directly inside an effect or, where reactivity is wanted, wraps
in TanStack-style local state (deferred — not part of this plan).

## 6. apps/core cleanup

Once no browser hits `/agents/cmo/<userId>/mcp`:

- Delete `handleMcpRequest` + the 503 stub at `apps/core/src/index.ts:721-764`
- Delete `MCP_ROUTE` regex (line 187) — chat WS regex `CMO_WS_ROUTE` and
  framework regex `CMO_HTTP_ROUTE` are unaffected
- Update `apps/core/test/cmo-routing.test.ts` to drop the 401/403/503
  assertions for the retired path

The external `/cmo/mcp` route (Phase 7's OAuth-gated McpAgent) stays exactly
as-is.

## 7. Schema migration ordering

The two new tables are CREATE-IF-NOT-EXISTS — no destructive change, no
migration tag manipulation required. They land via `ensureSchema()` on first
write after deploy. Existing v12-v14 tags remain untouched.

## 8. Testing

### 8.1 Unit (apps/core)

`apps/core/test/agents/cmo-callable.test.ts` — one isolated DO per test,
mirror the existing `cmo.test.ts` pattern. Per-method: happy path + the
documented failure modes (e.g. `cancelPlanItem` throws on terminal state).

### 8.2 Integration

`apps/core/test/cmo-callable-routing.test.ts` — full JWT round-trip via
`SELF.fetch` on the WS endpoint, send a `.stub.queryRoster()` over the
connection, assert the response.

### 8.3 Real-browser smoke (must be added to the Phase 11 smoke checklist)

Following the global rule "every plan must include real-browser Playwright
testing", run these on `https://app-staging.shipflare.ai`:

1. `/team` renders roster, conversations, plan_items, drafts
2. `/team` — create new conversation, navigate, send chat turn
3. `/team` — approve a draft, see toast, list updates
4. `/team` — cancel a plan_item, see status change
5. `/briefing/today` — drafts list, approve flow
6. `/briefing/history` — drafts list for all non-pending statuses
7. `/briefing/plan` — plan_items bucketed by status
8. `/growth/reddit-channels` — `queryFounderContext` returns the
   subreddits map
9. Open transcript drawer for one role — `queryAgentTranscript` renders

Existing local browser context already authenticated to staging — Playwright
connects to the existing session.

## 9. Migration sequencing (high level — full plan comes from writing-plans)

1. CMO server: add the 10 `@callable` wrappers around extracted `_impl` methods.
2. CMO server: add `conversations` table + `startNewConversation` + `listConversations` + `queryRoster` (registry-derived). Rewrite schema.ts comment.
3. CMO server: unit tests for all 13 methods.
4. apps/web: `useCmoStub` hook + migrate `/team` first (the heaviest user).
5. apps/web: migrate `/briefing/*` and `/growth/reddit-channels` call sites.
6. apps/core: delete `handleMcpRequest`, `MCP_ROUTE`, the 503 stub.
7. apps/web: delete `mcp-client.ts`, `/api/mcp-token`, browser MCP SDK imports.
8. Real-browser smoke on staging — must pass before this folds into the
   cf-native-chat PR.

Each step is a separate commit. Steps 6-7 wait until step 5 is green to
preserve a working dev branch.

## 10. Risks & open questions

| Risk | Mitigation |
|---|---|
| ~~`useAgent` de-duplication assumption is wrong~~ | ~~If `useCmoChat` and `useCmoStub` open two WS connections instead of sharing one, ref-count manually via a context provider. Adds ~30 LOC; not blocking.~~ **CONFIRMED FALSE on review** — addressed by extracting `useCmoAgent` (Task 7). |
| Typed `stub` requires CMO class type accessible from apps/web | Re-export the type-only signature from `@shipflare/shared` (or a new `@shipflare/core/types` entry). Server runtime stays in apps/core. |
| New `conversations` table conflicts with how `useAgentChat` enumerates threads | The framework stores messages per-conversation via the `id` param; it does NOT manage a conversation list itself. Our table is the authoritative list for the founder's UI. |
| `getRecentActivity` shape drift | The drawer renders the rows untyped today; keep the existing wire shape (untyped rows + caller-side narrowing). |
| Multi-tab: two browser tabs open `/team` for the same founder | Each tab gets its own WS; framework hibernates the DO between turns. Stub calls are stateless from the DO's perspective — no race. |

## 11. What this design does NOT touch

- The `useCmoChat` hook, `useAgentChat`, the activity feed, telemetry
  emission, JWT minting in `/api/agent-token`, the external `/cmo/mcp`
  OAuth flow, or any platform MCP agent (X / Reddit).
- The CMO `chat` tool body itself — only the right-panel surface.
- Cron `scheduled()` handlers and DO `alarm()` paths.
- Daily relay messages — those still ride `saveMessages` with
  `source='daily-relay'`.
