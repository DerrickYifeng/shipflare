# Agent Activity Feed (Post-CF Visibility)

**Date:** 2026-05-15
**Status:** Design — ready for implementation plan
**Branch target:** `feat/agent-activity-feed`

---

## 1. Goal

Restore real-time visibility into agent work after the Railway → Cloudflare migration. Two user-visible surfaces today have no visibility into what agents are actually doing:

- **Onboarding "Building plan"** — currently a synthetic, hand-scripted chat in `synthetic-chat-conversation.tsx`. Disconnected from any real agent.
- **`/team` chat** — streams CMO's reply text via the existing MCP `chat` tool, but tool calls, sub-agent dispatch (HoG / SMM / X / Reddit), and skill invocations are invisible. The browser only sees `agent_text` deltas plus a "thinking…" placeholder.

Background runs (cron-tick, scheduled drafts) also have no surfaced activity, blocking future `/today` and `/briefing` "what happened overnight" views.

This spec defines a single mechanism — an activity event firehose on the CMO Durable Object — that lights up all three surfaces.

## 2. Locked decisions

| # | Decision | Choice |
|---|---|---|
| 1 | Scope | Onboarding "Building plan" + `/team` chat in v1. Background runs benefit automatically; UI surfacing on `/today` is follow-up. |
| 2 | Verbosity | **Curated narrative** — friendly labels derived from event kind + tool name. Founder-facing tone. No raw args in the default UI. |
| 3 | Persistence | **Persist to CMO SQLite** (`activity_events` table). Survives reload, enables background-run replay, supports `/today` later. |
| 4 | Architecture | **Option A**: `this.broadcast()` for live, SQLite for replay, `log_activity` internal endpoint for sub-agent forwarding. Not `setState` (rebroadcast cost), not `@callable` streaming (wrong lifecycle for ongoing chat), not `AIChatAgent` migration (too big). |
| 5 | Transport | Cloudflare Agents SDK WebSocket via `useAgent({ agent, name, onMessage })`. Reuses the SDK's hibernation-safe WS layer. |
| 6 | Auth on WS | Short-lived (60 s) HS256 JWT signed with `MCP_JWT_SECRET`, `scope: 'activity'`. Browser fetches token from `apps/web` → opens WS with `?token=…` → CMO `onConnect` verifies. |
| 7 | Cross-DO forwarding | Service binding `fetch` to `/internal/log-activity` with `x-shipflare-internal: 1` header. Matches existing peer-DM-shadow / RedditMcpAgent pattern (CLAUDE.md §"Agent Teams Architecture" invariant #2 and `apps/core/src/index.ts:18-19`). No HMAC — header alone, per Phase 0 spike #8. |
| 8 | Text-delta persistence | CMO text deltas **not persisted** (already in MCP chat stream + final assistant message in `conversations`). Sub-agent text deltas **persisted** (only path the browser sees them). |
| 9 | UI default state | `/team` chat: **collapsed by default with a rolling ticker** showing the most recent unfinished leaf event, truncated. Auto-hides 1.5 s after `turn_finish`. Onboarding "Building plan": **expanded by default** (same component, different `defaultOpen` prop). |
| 10 | Onboarding wiring | Plan-build runs under a client-minted `runId`. Strategic-path handler invokes the strategic-planner skill through a traced runner so skill + nested tool events emit. SSE `strategic_done` keeps driving stage advance (decoupled from the activity WS). |

## 3. Architecture overview

```
Browser (apps/web)                                 Worker (apps/core)
─────────────────                                  ──────────────────
┌─ /team chat ──────────────┐                     ┌─ CMO DO (per user) ─────────┐
│                            │   MCP chat (text)  │                              │
│  useTeamEvents ───────────╳──────────────────▶  │  chat tool (streamText)     │
│   (existing, unchanged)    │                     │   onStepFinish → emit       │
│                            │                     │   onChunk → MCP stream      │
│                            │                     │                              │
│  useCmoActivity ──────────╳──── WS (new) ────▶  │  /agents/cmo/<userId>       │
│   conversationId OR runId  │                     │  onConnect: verify JWT       │
│                            │                     │  onMessage: (none — pull)    │
│   ▼                        │                     │                              │
│  ActivityTrail              │   broadcast(evt)   │  emitActivity()              │
│   ticker + collapsible    ◀─────────────────────┤  ├ INSERT activity_events    │
│   uses ACTIVITY_LABELS     │                     │  └ this.broadcast(evt)       │
└────────────────────────────┘                     │                              │
                                                   │  POST /internal/log-activity │
                                                   │   ▲ (from HoG/SMM/X/Reddit)  │
                                                   └──┼──────────────────────────┘
                                                      │ service binding fetch
                                                      │ x-shipflare-internal: 1
                                  ┌───────────────────┴──────────────────┐
                                  │ HoG / SMM / XMcpAgent / RedditMcpAgent │
                                  │  emit own events upward via            │
                                  │  forwardActivityToCmo()                │
                                  └────────────────────────────────────────┘
```

## 4. Data model

### 4.1 New CMO SQLite table

```sql
CREATE TABLE IF NOT EXISTS activity_events (
  id              TEXT PRIMARY KEY,           -- ULID, time-sortable
  conversation_id TEXT,                       -- nullable for background runs
  parent_turn_id  TEXT,                       -- assistant message id, nullable
  run_id          TEXT,                       -- top-level cause UUID (turn/cron/plan-build)
  source_agent    TEXT NOT NULL,              -- 'cmo' | 'head-of-growth' | 'social-media-manager' | 'strategic-planner' | ...
  parent_event_id TEXT,                       -- nesting (subagent_dispatch → child tool calls)
  kind            TEXT NOT NULL,              -- see §4.2
  payload         TEXT NOT NULL,              -- JSON blob, shape varies by kind
  created_at      INTEGER NOT NULL            -- unix ms
);

CREATE INDEX IF NOT EXISTS idx_activity_events_conv ON activity_events (conversation_id, created_at);
CREATE INDEX IF NOT EXISTS idx_activity_events_run  ON activity_events (run_id, created_at);
CREATE INDEX IF NOT EXISTS idx_activity_events_turn ON activity_events (parent_turn_id);
```

Schema bootstrap runs in CMO's `applyCmoSchema` (`apps/core/src/agents/cmo/schema.ts`), idempotent via `IF NOT EXISTS`.

### 4.2 Event kinds (fixed enum)

```ts
type ActivityKind =
  // lifecycle
  | 'turn_start' | 'turn_finish'
  // CMO-level
  | 'tool_call_start' | 'tool_call_finish'
  // delegation
  | 'subagent_dispatch' | 'subagent_finish'
  // sub-agent internals (forwarded via log_activity)
  | 'subagent_text_delta'
  | 'subagent_tool_call_start' | 'subagent_tool_call_finish'
  // skills
  | 'skill_invoke' | 'skill_finish';
```

Adding a new kind is a migration, not a free-for-all. New kinds require a label-map entry (§7.1) and a renderer case (§7.2).

### 4.3 Payload shapes (per kind)

```ts
type Payload =
  | { kind: 'turn_start' }
  | { kind: 'turn_finish'; status: 'ok' | 'error'; durationMs: number; errorMessage?: string }
  | { kind: 'tool_call_start'; tool: string; argsPreview?: string }
  | { kind: 'tool_call_finish'; tool: string; status: 'ok' | 'error'; durationMs: number }
  | { kind: 'subagent_dispatch'; subAgent: string; promptPreview?: string }
  | { kind: 'subagent_finish'; subAgent: string; status: 'ok' | 'error'; durationMs: number; summary?: string }
  | { kind: 'subagent_text_delta'; subAgent: string; text: string }       // batched, ~200 ms
  | { kind: 'subagent_tool_call_start'; subAgent: string; tool: string; argsPreview?: string }
  | { kind: 'subagent_tool_call_finish'; subAgent: string; tool: string; status: 'ok' | 'error'; durationMs: number }
  | { kind: 'skill_invoke'; skill: string; model?: string; context?: 'inline' | 'fork' }
  | { kind: 'skill_finish'; skill: string; status: 'ok' | 'error'; durationMs: number };
```

`argsPreview` / `promptPreview` are truncated to 200 chars at emission time. Full args never leave the emitting DO.

## 5. Event sources & instrumentation

### 5.1 Single sanctioned writer

```ts
// apps/core/src/lib/activity.ts
export async function emitActivity(
  agent: CMO,
  event: Omit<ActivityEvent, 'id' | 'createdAt'>,
): Promise<void> {
  const id = ulid();
  const createdAt = Date.now();
  agent.sqlStorage.exec(
    `INSERT INTO activity_events (id, conversation_id, parent_turn_id, run_id, source_agent, parent_event_id, kind, payload, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    id,
    event.conversationId ?? null,
    event.parentTurnId ?? null,
    event.runId ?? null,
    event.sourceAgent,
    event.parentEventId ?? null,
    event.kind,
    JSON.stringify(event.payload),
    createdAt,
  );
  agent.broadcast(JSON.stringify({ id, createdAt, ...event }));
}
```

All emission paths funnel through this. No other file directly inserts into `activity_events` or calls `broadcast()` with activity payloads.

### 5.2 Layer 1 — CMO's own LLM (chat MCP tool)

Wrap `streamText` callbacks in `apps/core/src/agents/cmo/tools/chat.ts`:

| Callback | Emit |
|---|---|
| Start of `chat` tool handler | `turn_start` |
| `onStepFinish` with `toolCalls.length > 0` | `tool_call_start` per call, `tool_call_finish` per result |
| `onChunk` (text delta) | **skip** — MCP chat stream handles it |
| End of handler (success or error) | `turn_finish` |

The `delegate` tool is special: it emits `subagent_dispatch` **before** the in-process MCP call to HoG/SMM, then `subagent_finish` after. The dispatch event's `id` is passed into HoG via the MCP payload as `parentEventId` so HoG's child events nest under it.

### 5.3 Layer 2 — Sub-agent LLMs (HoG, SMM)

HoG/SMM run `streamText` inside their own tool handlers. Same wrapping pattern as 5.2, but events emit *upward* to CMO via `forwardActivityToCmo` (§6) rather than to their own local SQLite. Emitted kinds: `subagent_text_delta` (batched 200 ms / 16 deltas), `subagent_tool_call_start`, `subagent_tool_call_finish`, `skill_invoke`, `skill_finish`.

### 5.4 Layer 3 — Skill forks

Wrap the existing skill runner entry point:

```ts
// apps/core/src/lib/skill-runner-traced.ts (new — wraps existing runSkill)
export async function runSkillWithTracing<T>(
  skill: string,
  input: unknown,
  trace: { userId: string; runId: string; parentEventId: string | null; conversationId?: string; parentTurnId?: string },
): Promise<T> {
  await forwardActivityToCmo(trace, {
    sourceAgent: skill,
    kind: 'skill_invoke',
    payload: { kind: 'skill_invoke', skill },
  });
  const start = Date.now();
  try {
    const out = await runSkill(skill, input);
    await forwardActivityToCmo(trace, {
      sourceAgent: skill,
      kind: 'skill_finish',
      payload: { kind: 'skill_finish', skill, status: 'ok', durationMs: Date.now() - start },
    });
    return out as T;
  } catch (e) {
    await forwardActivityToCmo(trace, {
      sourceAgent: skill,
      kind: 'skill_finish',
      payload: { kind: 'skill_finish', skill, status: 'error', durationMs: Date.now() - start },
    });
    throw e;
  }
}
```

### 5.5 Trace context propagation

Each emission carries `runId` (top-level UUID), `parentEventId` (immediate enclosing event), `conversationId` (chat-tied), `parentTurnId` (assistant message id). Flows:

- **In-process (within one DO)**: AsyncLocalStorage in `apps/core/src/lib/activity.ts` holds the active trace context. Tools read it implicitly.
- **Cross-DO** (CMO → HoG via in-process MCP `delegate`): trace context is included in the MCP tool payload. HoG's chat tool reads it from its arguments and threads it into every `forwardActivityToCmo` call.

### 5.6 Not instrumented

- MCP transport-level events (session-open, transport upgrade).
- CMO's own per-token text deltas (already in chat stream).
- DB writes triggered by tools — they share their containing tool's `tool_call_*` pair.

## 6. Sub-agent forwarding mechanism

### 6.1 Endpoint

New internal route on CMO DO: `POST /internal/log-activity`. Header-gated on `x-shipflare-internal: 1`. Routed in `CMO.fetch()` alongside existing internal handlers.

```ts
// CMO fetch override:
if (url.pathname === '/internal/log-activity' && request.method === 'POST') {
  if (request.headers.get('x-shipflare-internal') !== '1') return new Response('forbidden', { status: 403 });
  const body = ActivityEventSchema.parse(await request.json());
  await emitActivity(this, body);   // INSERT + broadcast
  return new Response(null, { status: 204 });
}
```

### 6.2 Caller helper

```ts
// apps/core/src/lib/forward-activity.ts (new)
export function forwardActivityToCmo(
  ctx: ExecutionContext,
  env: Env,
  userId: string,
  event: Omit<ActivityEvent, 'id' | 'createdAt'>,
): void {
  // Fire-and-forget. Sub-agent work never blocks on telemetry.
  ctx.waitUntil(
    env.CMO.idFromName(userId)
      .fetch('https://internal/internal/log-activity', {
        method: 'POST',
        headers: { 'x-shipflare-internal': '1', 'content-type': 'application/json' },
        body: JSON.stringify(event),
      })
      .catch(() => undefined),  // swallow — lost forwards are degraded UX, not correctness
  );
}
```

### 6.3 Why service binding + fetch, not RPC

- Consistent with existing `/internal/*` family (`apps/core/src/onboarding-routes.ts:255`, `RedditMcpAgent.ts:112`).
- Bypasses CMO's `onMessage` / chat handler — activity telemetry must never wake the LLM (per CLAUDE.md §"Agent Teams Architecture" invariant #2 reasoning).
- Cloudflare's edge strips `x-shipflare-internal` from public traffic, so the header is forge-proof.

### 6.4 Batching policy

- `subagent_text_delta`: buffer in-process in the sub-agent for 200 ms **or** 16 deltas, whichever fires first. Flush as one batch event with concatenated text. One row per batch, one broadcast per batch.
- All other kinds: emit immediately, no batching.

### 6.5 Failure / ordering

- `ctx.waitUntil` on every forward — non-blocking, no retry. Lost forwards are degraded UX, not correctness.
- ULID `id` is time-sortable; browser sorts by `createdAt`. Ties broken by `id` lexicographic order.
- DO single-threaded execution serializes inserts on the receiver.

### 6.6 Backpressure

CMO DO sustains ~1 k inserts/sec. Peak realistic load (4 sub-agents × 10 forwards/sec = 40/sec) is well within budget. If we ever hit a true bottleneck, fix is receive-side coalescing of consecutive text deltas.

## 7. Web client wiring

### 7.1 Token endpoint

```
POST /api/cmo-ws-token   (apps/web)
  → JSON { token }
```

Mints HS256 JWT signed with `MCP_JWT_SECRET`. Payload: `{ userId, scope: 'activity', exp: now+60s }`. The `scope: 'activity'` claim means a leaked activity token cannot be replayed against the MCP path (which checks `scope: 'mcp'`).

### 7.2 CMO `onConnect`

```ts
onConnect(conn: Connection, ctx: ConnectionContext) {
  const url = new URL(ctx.request.url);
  const token = url.searchParams.get('token');
  const claims = verifyJwt(token, this.env.MCP_JWT_SECRET);
  if (!claims || claims.scope !== 'activity' || claims.userId !== this.props?.userId) {
    conn.close(1008, 'unauthorized');
    return;
  }
  conn.setState({ userId: claims.userId });
}
```

### 7.3 React hook

```ts
// apps/web/src/hooks/use-cmo-activity.ts (replaces dead Railway-era use-agent-stream.ts)
type CmoActivityFilter =
  | { conversationId: string }
  | { runId: string };

export function useCmoActivity(filter: CmoActivityFilter): {
  events: ActivityEvent[];
  isConnected: boolean;
  connectionError: string | null;
} {
  // 1. Mount: fetch token from /api/cmo-ws-token.
  // 2. useAgent({ agent: 'cmo', name: userId, query: () => `token=${jwt}`, onMessage })
  // 3. Mount + filter change: agent.stub.getRecentActivity(filter) to seed events array.
  // 4. Live broadcast onMessage handler: append, filter by filter, dedupe by event.id.
  // 5. Reconnect (after disconnect): re-seed via getRecentActivity, then resume live.
  // 6. Token endpoint failure → exponential backoff, connectionError surfaced.
}
```

### 7.4 Seed-replay callable

```ts
// CMO tool registration. Exactly one of conversationId / runId is required;
// the other is null. limit defaults to 200, sinceMs defaults to 0.
@callable()
getRecentActivity(args: {
  conversationId?: string;
  runId?: string;
  sinceMs?: number;
  limit?: number;
}): ActivityEvent[] {
  if (!args.conversationId && !args.runId) throw new Error('conversationId or runId required');
  // SELECT ... WHERE (conversation_id = ? OR run_id = ?) AND created_at > ? ORDER BY created_at ASC LIMIT ?
}
```

### 7.5 Connection lifecycle

| Scenario | Behavior |
|---|---|
| WS disconnects mid-turn | Agents SDK auto-reconnects. Hook re-runs `getRecentActivity` on reconnect; dedupe by `id` handles overlap. |
| Token expires (60 s) | SDK only uses token at connect time. Connection then authenticated for life. Reconnect mints fresh token via `queryDeps`. |
| CMO DO hibernates | WS survives. Next emit wakes the DO; broadcast fires. |
| User on `/today` (no chat open) | Activity WS still works. Background events still arrive. |
| Token endpoint fails | Retry with exponential backoff (1 s, 2 s, 4 s, ...). `connectionError` surfaced — UI shows a "Couldn't connect to activity feed" pill. Chat still works. |

## 8. Renderer

### 8.1 Label map

```ts
// apps/web/src/lib/activity-labels.ts
type LabelFn = (payload: Payload) => { headline: string; sub?: string; tone: 'work' | 'dispatch' | 'idle' | 'error' };

export const ACTIVITY_LABELS: Record<string, LabelFn> = {
  'cmo:turn_start':                                          () => ({ headline: 'Thinking', tone: 'idle' }),
  'cmo:tool_call_start:delegate':                            (p) => ({ headline: `Asking ${prettyAgent(p.subAgent)}`, sub: p.promptPreview, tone: 'dispatch' }),
  'cmo:tool_call_start:approveDraft':                        () => ({ headline: 'Approving draft', tone: 'work' }),
  'cmo:tool_call_start:commitStrategicPath':                 () => ({ headline: 'Saving plan', tone: 'work' }),
  'head-of-growth:subagent_tool_call_start:search_market_data': () => ({ headline: 'Reading market signals', tone: 'work' }),
  'head-of-growth:subagent_tool_call_start:read_repo':       (p) => ({ headline: 'Reading repo', sub: p.argsPreview, tone: 'work' }),
  'strategic-planner:skill_invoke':                          () => ({ headline: 'Strategist is planning', tone: 'work' }),
  'drafting-single-post:skill_invoke':                       () => ({ headline: 'Drafting a post', tone: 'work' }),
  // ...
};
```

Fallback when a key is unmapped: `{ headline: kind.replace(/_/g, ' '), sub: payload.tool, tone: 'work' }`. UI degrades gracefully when a new tool ships before its label.

`prettyAgent` is a small lookup (`head-of-growth` → "Head of Growth", `social-media-manager` → "Social Media Manager", etc.) — same names used everywhere.

### 8.2 Render hierarchy

Events form a forest. `parentEventId` defines tree edges. Renderer groups events under their top-level dispatch and indents children.

```
┌─ CMO message bubble ─────────────────────┐
│ [streamed text from MCP chat]            │
└──────────────────────────────────────────┘
  ◐ Reading market signals…                  ← ticker (collapsed default, auto-hides 1.5 s after turn_finish)
  Activity (3) ▾                              ← collapsible header

  When expanded:
       ◐ Asking Head of Growth                ← subagent_dispatch  (running spinner)
         ↳ Reading repo metadata              ← child subagent_tool_call_*
         ↳ Drafting plan                      ← child skill_invoke
       ✓ Approving draft                      ← tool_call_finish (check)
```

`(running spinner | done check | error icon)` is **derived**: a `*_call_start` event without a matching `_finish` (matched by `id`) is "running"; with a finish is "done" or "error". Unmatched starts decay to "done" after 60 s of silence.

### 8.3 Components

```
apps/web/src/components/activity/
├── activity-trail.tsx       // groups + renders. Manages collapse state. Props: events, defaultOpen, hideTicker, shell.
├── activity-row.tsx         // pure. Single row: icon + headline + sub.
└── activity-toggle.tsx      // pure. Collapsible header "Activity (N) ▾".
```

`shell` prop: `'inline'` (default — sits under chat bubble) or `'dispatch-card'` (the framed card from the onboarding mockup).

## 9. Onboarding integration

### 9.1 Trigger and `runId`

Web client mints a UUID `runId` when entering the building-plan stage. Passes it to the existing `POST /internal/onboarding/strategic-path` handler.

### 9.2 Handler change

The strategic-path handler in `apps/core/src/onboarding-routes.ts` invokes the strategic-planner skill via `runSkillWithTracing` (§5.4) with `{ userId, runId, parentEventId: null }`. The SSE heartbeat / `strategic_done` signaling stays — activity is independent.

### 9.3 UI swap

Replace `synthetic-chat-conversation.tsx` (~478 LOC of fake conversation) with:

```tsx
// apps/web/app/onboarding/_components/_shared/plan-build-activity.tsx
function PlanBuildActivity({ runId }: { runId: string }) {
  const { events } = useCmoActivity({ runId });
  return (
    <ActivityTrail
      events={events}
      defaultOpen
      hideTicker
      shell="dispatch-card"
    />
  );
}
```

### 9.4 Empty state

Mount → no events yet: render a single skeleton row "Preparing strategist…" for up to 3 s. If still empty: "Strategist is taking longer than usual" (informational, not an error — SSE handler still runs to completion).

### 9.5 Copy update

`apps/web/app/onboarding/_components/_copy.ts`: replace `≈ 30s sit tight — six checks running in parallel` with `Watching the strategist work — usually under a minute`. ("Six checks running in parallel" was decorative; no such six-fan-out happens.)

### 9.6 `synthetic-chat-conversation.tsx` deletion

Deleted after grep-verifying no other importers. The `_copy.ts` strings for the stage header (`Step 4 · Building plan`, `AI is calibrating your plan`) stay.

## 10. `/team` chat integration

### 10.1 Mount

`team-desk.tsx` already uses `useTeamEvents` for MCP chat. Add `useCmoActivity({ conversationId })` alongside. Two parallel data sources, two parallel render regions:

- Chat message list — driven by `useTeamEvents` (unchanged).
- Activity trail — driven by `useCmoActivity({ conversationId })`, returning **all** events for the conversation. The renderer groups them client-side by `parentTurnId` so each assistant message owns its own trail. Server-side filter is `conversationId` only; `parentTurnId` is a UI grouping operation, not a hook argument.

### 10.2 Per-turn filtering

Events with `parentTurnId === <assistant message id>` render under that message bubble. Events without a `parentTurnId` (background runs) don't appear in `/team` chat — they'd surface on `/today` later.

### 10.3 Ticker behavior

For each in-flight CMO turn: show ticker under that bubble with most-recent unfinished leaf event. Auto-hide 1.5 s after the turn's `turn_finish`. Collapsed `Activity (N) ▾` header stays permanently for history.

## 11. Files added / modified

### Added
- `apps/core/src/lib/activity.ts` — `emitActivity`, AsyncLocalStorage trace context.
- `apps/core/src/lib/forward-activity.ts` — cross-DO forwarder.
- `apps/core/src/lib/skill-runner-traced.ts` — `runSkillWithTracing` wrapper.
- `apps/core/src/agents/cmo/schema.ts` — add `activity_events` CREATE TABLE.
- `apps/web/app/api/cmo-ws-token/route.ts` — JWT mint endpoint.
- `apps/web/src/hooks/use-cmo-activity.ts` — React hook.
- `apps/web/src/lib/activity-labels.ts` — label map + `prettyAgent`.
- `apps/web/src/components/activity/activity-trail.tsx` (+ row, + toggle).
- `apps/web/app/onboarding/_components/_shared/plan-build-activity.tsx` — replaces synthetic chat.
- `packages/shared/src/activity-event.ts` — `ActivityEvent` type + Zod schema, shared between `apps/core` and `apps/web`.

### Modified
- `apps/core/src/agents/cmo/CMO.ts` — `onConnect` JWT verify, `fetch` route for `/internal/log-activity`, `@callable getRecentActivity`.
- `apps/core/src/agents/cmo/tools/chat.ts` — wrap `streamText` callbacks with `emitActivity`.
- `apps/core/src/agents/cmo/tools/delegate.ts` — emit `subagent_dispatch` / `subagent_finish`, thread trace context into MCP payload.
- `apps/core/src/agents/head-of-growth/HeadOfGrowth.ts` (+ tools) — emit upward via `forwardActivityToCmo`.
- `apps/core/src/agents/social-media-manager/SocialMediaMgr.ts` (+ tools) — same.
- `apps/core/src/onboarding-routes.ts` — strategic-path handler uses `runSkillWithTracing`.
- `apps/web/app/(app)/team/_components/team-desk.tsx` — add `useCmoActivity` + activity trail rendering.
- `apps/web/app/onboarding/page.tsx` — mint `runId`, pass to handler.
- `apps/web/app/onboarding/_components/_copy.ts` — sub-copy update.

### Deleted
- `apps/web/app/onboarding/_components/_shared/synthetic-chat-conversation.tsx` (after grep verification).
- `apps/web/src/hooks/use-agent-stream.ts` — dead Railway-era code targeting non-existent `/api/events`.
- `apps/web/src/hooks/agent-stream-provider.tsx` — same.
- `apps/web/src/hooks/use-sse-channel.ts` — same.

## 12. Out of scope (follow-ups)

- `/today` "what HoG did overnight" view — uses `getRecentActivity({ runId, since })`. Separate plan.
- `/briefing` activity surfacing — same shape, different filter.
- External-MCP exposure of `getRecentActivity` (would let Claude Desktop tail activity). Phase 2 OAuth wrap.
- Admin diagnostics page that reads raw `activity_events` with arg payloads. Phase 2.

## 13. Real-browser smoke test

After implementation, the following must pass against the dev environment (per the standing instruction that every plan includes Playwright real-browser testing):

1. **Onboarding plan-build:**
   - Sign in fresh, complete stages 1-3.
   - On stage 4 ("Building plan"), the activity card renders.
   - At least one `skill_invoke:strategic-planner` event appears within 5 s.
   - Spinner row resolves to ✓ before `strategic_done` SSE fires.
   - Stage advances on `strategic_done`.

2. **`/team` chat — single turn with delegation:**
   - Send a message that triggers CMO → HoG delegation (e.g., "What's the latest growth signal?").
   - CMO text streams into the bubble (existing behavior, unchanged).
   - Ticker appears under the bubble showing "Asking Head of Growth" within 2 s.
   - Expanding the trail shows the dispatch + at least one child sub-agent tool call.
   - Ticker auto-hides 1.5 s after the turn completes; `Activity (N) ▾` stays.

3. **Mid-turn reload:**
   - Send a chat that takes >5 s to complete.
   - Reload the page mid-turn.
   - On remount, activity rows that already happened replay from `getRecentActivity` (no duplicates).
   - Live events continue to flow after reconnect.

4. **Token endpoint failure:**
   - Block `/api/cmo-ws-token` (e.g., return 500 in dev).
   - Chat still works (MCP path unaffected).
   - "Couldn't connect to activity feed" pill appears.
   - Restore endpoint → reconnect happens within 4 s, pill clears.

## 14. Risks

| Risk | Mitigation |
|---|---|
| `broadcast()` to many connections doesn't scale | CMO is per-user; realistic max ~3 connections per CMO (open tabs). Not a concern. |
| Sub-agent text delta firehose under heavy delegation | 200 ms / 16-delta batching caps writes; receive-side coalescing is a known follow-up if needed. |
| Forgetting to wrap a new tool with `emitActivity` | Centralizing emission in `apps/core/src/lib/activity.ts` plus a label-map fallback means missing instrumentation degrades to no row + no label, not a crash. Lint rule (follow-up) could flag direct LLM calls without trace context. |
| Trace context lost across async boundaries | AsyncLocalStorage handles same-DO async; cross-DO carried in MCP payloads. Verified by the smoke test (delegation case). |
| Old `use-agent-stream.ts` import resurfaces during a merge | Deletion in §11 + grep-verification before merge. |
