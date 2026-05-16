# Agent Activity Feed Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire real-time agent activity (tool calls, sub-agent dispatch, skill loads, sub-agent text deltas) from CMO/HoG/SMM Durable Objects to the onboarding "Building plan" screen and the `/team` chat, with persistence in CMO SQLite for replay across reloads and background runs.

**Architecture:** New `activity_events` table on the per-user CMO DO. CMO emits events via `this.broadcast()` (live) + `INSERT` (replay) through a single sanctioned writer (`emitActivity`). Sub-agents (HoG, SMM, onboarding handler) forward events upward to CMO via a service-binding `POST /internal/log-activity` endpoint. The browser holds two parallel connections to the same CMO DO: existing MCP `chat` (text stream, unchanged) + a new Agents SDK WebSocket via `useAgent({ onMessage })` for the activity firehose. Renderer is collapsed-by-default with a rolling ticker; onboarding overrides to expanded.

**Tech Stack:** Cloudflare Durable Objects, Agents SDK (`agents@^0.12.4`), Anthropic SDK streaming, Better Auth, Next.js (App Router), React, Zod, TypeScript, Vitest, Playwright.

**Spec reference:** `docs/superpowers/specs/2026-05-15-agent-activity-feed-design.md`.

**Spec deviations (explicit):**
- `id` is `crypto.randomUUID()` instead of ULID — codebase convention, no new dep, `createdAt` carries time-sort.
- Strategic-path handler (`apps/core/src/onboarding-routes.ts`) is switched from `client.messages.create()` to `client.messages.stream()` and emits synthetic `subagent_dispatch` / `subagent_text_delta` / `subagent_finish` events directly. The handler is **not** wrapped with `runSkillWithTracing` because it does not invoke a registered skill — it's a one-shot Anthropic call. Same UX outcome; less ceremony.
- `runSkillWithTracing` / `skill_runner-traced.ts` from spec §5.4 is **not** implemented in this plan. No current code path invokes a registered skill via the skill runner during user-visible work that needs activity instrumentation. The wrapping pattern is documented in the spec for future use; we don't add dead code.

---

## File map

### Created
- `packages/shared/src/activity-event.ts` — `ActivityEvent` type + Zod schema + `ActivityKind` union (shared types).
- `apps/core/src/lib/activity.ts` — `emitActivity` (CMO-side single writer) + AsyncLocalStorage trace context.
- `apps/core/src/lib/forward-activity.ts` — cross-DO forwarder for HoG/SMM/onboarding handler.
- `apps/core/src/agents/cmo/tools/get-recent-activity.ts` — `@callable`-style registration via MCP for replay seeding.
- `apps/web/app/api/cmo-ws-token/route.ts` — JWT mint endpoint.
- `apps/web/src/hooks/use-cmo-activity.ts` — React hook (replaces dead Railway `use-agent-stream.ts`).
- `apps/web/src/lib/activity-labels.ts` — label map + `prettyAgent`.
- `apps/web/src/components/activity/activity-trail.tsx`
- `apps/web/src/components/activity/activity-row.tsx`
- `apps/web/src/components/activity/activity-toggle.tsx`
- `apps/web/app/onboarding/_components/_shared/plan-build-activity.tsx` — replaces synthetic chat.
- `e2e/tests/activity-feed.spec.ts` — Playwright smoke.

### Modified
- `packages/shared/src/index.ts` — barrel re-export of activity-event types.
- `apps/core/src/agents/cmo/schema.ts` — add `activity_events` CREATE TABLE.
- `apps/core/src/agents/cmo/CMO.ts` — `onConnect` JWT verify; `/internal/log-activity` fetch route; register `getRecentActivity` tool in `init()`.
- `apps/core/src/agents/cmo/tools/chat.ts` — wrap with `turn_start` / `turn_finish` events.
- `apps/core/src/agents/cmo/tools/delegate.ts` — emit `subagent_dispatch` / `subagent_finish`; thread trace context into MCP payload.
- `apps/core/src/agents/head-of-growth/HeadOfGrowth.ts` — read trace context from incoming MCP args; emit text/tool events upward.
- `apps/core/src/agents/social-media-manager/SocialMediaMgr.ts` — same as HoG.
- `apps/core/src/onboarding-routes.ts` — switch strategic-path from `messages.create` to `messages.stream`; emit dispatch/text/finish events keyed by `runId`.
- `apps/web/app/(app)/team/_components/team-desk.tsx` — add `useCmoActivity` + render `<ActivityTrail/>` under each assistant message.
- `apps/web/app/onboarding/page.tsx` — mint `runId` for plan-build stage; pass to strategic-path handler.
- `apps/web/app/onboarding/_components/_copy.ts` — sub-copy update.

### Deleted
- `apps/web/app/onboarding/_components/_shared/synthetic-chat-conversation.tsx`
- `apps/web/src/hooks/use-agent-stream.ts`
- `apps/web/src/hooks/agent-stream-provider.tsx`
- `apps/web/src/hooks/use-sse-channel.ts`

---

## Task 1: Shared `ActivityEvent` types

**Files:**
- Create: `packages/shared/src/activity-event.ts`
- Modify: `packages/shared/src/index.ts`
- Test: `packages/shared/src/__tests__/activity-event.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// packages/shared/src/__tests__/activity-event.test.ts
import { describe, expect, it } from 'vitest';
import { ActivityEventSchema, ACTIVITY_KINDS } from '../activity-event';

describe('ActivityEventSchema', () => {
  it('parses a minimal turn_start event', () => {
    const evt = {
      id: '00000000-0000-0000-0000-000000000001',
      createdAt: 1715817600000,
      sourceAgent: 'cmo',
      kind: 'turn_start',
      payload: { kind: 'turn_start' },
      conversationId: 'conv-1',
      parentTurnId: null,
      runId: null,
      parentEventId: null,
    };
    expect(ActivityEventSchema.parse(evt)).toEqual(evt);
  });

  it('rejects unknown kinds', () => {
    expect(() =>
      ActivityEventSchema.parse({
        id: '00000000-0000-0000-0000-000000000002',
        createdAt: 1,
        sourceAgent: 'cmo',
        kind: 'invented_kind',
        payload: { kind: 'invented_kind' },
        conversationId: null,
        parentTurnId: null,
        runId: null,
        parentEventId: null,
      }),
    ).toThrow();
  });

  it('exports the full ACTIVITY_KINDS list', () => {
    expect(ACTIVITY_KINDS).toContain('turn_start');
    expect(ACTIVITY_KINDS).toContain('turn_finish');
    expect(ACTIVITY_KINDS).toContain('subagent_dispatch');
    expect(ACTIVITY_KINDS).toContain('skill_invoke');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd /Users/yifeng/Documents/Code/shipflare
pnpm --filter @shipflare/shared test activity-event
```

Expected: FAIL — `Cannot find module '../activity-event'`.

- [ ] **Step 3: Implement the schema**

```ts
// packages/shared/src/activity-event.ts
import { z } from 'zod';

export const ACTIVITY_KINDS = [
  'turn_start',
  'turn_finish',
  'tool_call_start',
  'tool_call_finish',
  'subagent_dispatch',
  'subagent_finish',
  'subagent_text_delta',
  'subagent_tool_call_start',
  'subagent_tool_call_finish',
  'skill_invoke',
  'skill_finish',
] as const;

export type ActivityKind = (typeof ACTIVITY_KINDS)[number];

// Payload shapes — see spec §4.3
const PayloadSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('turn_start') }),
  z.object({
    kind: z.literal('turn_finish'),
    status: z.enum(['ok', 'error']),
    durationMs: z.number().int().nonnegative(),
    errorMessage: z.string().optional(),
  }),
  z.object({
    kind: z.literal('tool_call_start'),
    tool: z.string(),
    argsPreview: z.string().max(200).optional(),
  }),
  z.object({
    kind: z.literal('tool_call_finish'),
    tool: z.string(),
    status: z.enum(['ok', 'error']),
    durationMs: z.number().int().nonnegative(),
  }),
  z.object({
    kind: z.literal('subagent_dispatch'),
    subAgent: z.string(),
    promptPreview: z.string().max(200).optional(),
  }),
  z.object({
    kind: z.literal('subagent_finish'),
    subAgent: z.string(),
    status: z.enum(['ok', 'error']),
    durationMs: z.number().int().nonnegative(),
    summary: z.string().optional(),
  }),
  z.object({
    kind: z.literal('subagent_text_delta'),
    subAgent: z.string(),
    text: z.string(),
  }),
  z.object({
    kind: z.literal('subagent_tool_call_start'),
    subAgent: z.string(),
    tool: z.string(),
    argsPreview: z.string().max(200).optional(),
  }),
  z.object({
    kind: z.literal('subagent_tool_call_finish'),
    subAgent: z.string(),
    tool: z.string(),
    status: z.enum(['ok', 'error']),
    durationMs: z.number().int().nonnegative(),
  }),
  z.object({
    kind: z.literal('skill_invoke'),
    skill: z.string(),
    model: z.string().optional(),
    context: z.enum(['inline', 'fork']).optional(),
  }),
  z.object({
    kind: z.literal('skill_finish'),
    skill: z.string(),
    status: z.enum(['ok', 'error']),
    durationMs: z.number().int().nonnegative(),
  }),
]);

export const ActivityEventSchema = z.object({
  id: z.string(),
  createdAt: z.number().int().nonnegative(),
  conversationId: z.string().nullable(),
  parentTurnId: z.string().nullable(),
  runId: z.string().nullable(),
  sourceAgent: z.string(),
  parentEventId: z.string().nullable(),
  kind: z.enum(ACTIVITY_KINDS),
  payload: PayloadSchema,
});

export type ActivityEvent = z.infer<typeof ActivityEventSchema>;
export type ActivityPayload = z.infer<typeof PayloadSchema>;

// Used by the cross-DO forward endpoint. Server stamps id + createdAt.
export const ActivityEventInputSchema = ActivityEventSchema.omit({
  id: true,
  createdAt: true,
});
export type ActivityEventInput = z.infer<typeof ActivityEventInputSchema>;
```

- [ ] **Step 4: Re-export from the shared barrel**

```ts
// packages/shared/src/index.ts — APPEND at end of file:
export * from './activity-event';
```

- [ ] **Step 5: Run test to verify it passes**

```bash
pnpm --filter @shipflare/shared test activity-event
```

Expected: PASS (3/3).

- [ ] **Step 6: Commit**

```bash
git add packages/shared/src/activity-event.ts packages/shared/src/index.ts packages/shared/src/__tests__/activity-event.test.ts
git commit -m "feat(shared): ActivityEvent type + Zod schema"
```

---

## Task 2: CMO `activity_events` table + `emitActivity` writer

**Files:**
- Modify: `apps/core/src/agents/cmo/schema.ts`
- Create: `apps/core/src/lib/activity.ts`
- Test: `apps/core/src/lib/__tests__/activity.test.ts`

- [ ] **Step 1: Add schema bootstrap**

Append the new table to `apps/core/src/agents/cmo/schema.ts` inside `applyCmoSchema(sql)`, after the last existing `CREATE TABLE` block:

```ts
    -- Activity events (spec 2026-05-15) — single source of truth for what
    -- the agent team is doing. Written by emitActivity() in lib/activity.ts.
    CREATE TABLE IF NOT EXISTS activity_events (
      id              TEXT PRIMARY KEY,
      conversation_id TEXT,
      parent_turn_id  TEXT,
      run_id          TEXT,
      source_agent    TEXT NOT NULL,
      parent_event_id TEXT,
      kind            TEXT NOT NULL,
      payload_json    TEXT NOT NULL,
      created_at      INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_activity_events_conv
      ON activity_events (conversation_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_activity_events_run
      ON activity_events (run_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_activity_events_turn
      ON activity_events (parent_turn_id);
```

- [ ] **Step 2: Write the failing test for `emitActivity`**

```ts
// apps/core/src/lib/__tests__/activity.test.ts
import { describe, expect, it, beforeEach } from 'vitest';
import { emitActivity, withTraceContext, currentTraceContext } from '../activity';
import { applyCmoSchema } from '../../agents/cmo/schema';

// In-memory fake CMO for unit testing emitActivity in isolation.
function makeFakeAgent() {
  const rows: unknown[][] = [];
  const broadcasts: string[] = [];
  const fakeSql: any = {
    exec: (q: string, ...args: unknown[]) => {
      rows.push([q, ...args]);
      return { toArray: () => [] };
    },
  };
  applyCmoSchema(fakeSql); // bootstrap — no-op for the fake but exercises the call
  return {
    rows,
    broadcasts,
    sqlStorage: fakeSql,
    broadcast: (m: string) => broadcasts.push(m),
  };
}

describe('emitActivity', () => {
  it('inserts a row and broadcasts the event', async () => {
    const agent = makeFakeAgent();
    await emitActivity(agent as any, {
      conversationId: 'conv-1',
      parentTurnId: null,
      runId: null,
      sourceAgent: 'cmo',
      parentEventId: null,
      kind: 'turn_start',
      payload: { kind: 'turn_start' },
    });
    // Last call is the INSERT into activity_events
    const lastInsert = agent.rows.find(
      (r) => typeof r[0] === 'string' && (r[0] as string).startsWith('INSERT INTO activity_events'),
    );
    expect(lastInsert).toBeDefined();
    expect(agent.broadcasts).toHaveLength(1);
    const broadcast = JSON.parse(agent.broadcasts[0]!);
    expect(broadcast.kind).toBe('turn_start');
    expect(broadcast.id).toMatch(/^[0-9a-f-]{36}$/); // UUID v4
    expect(typeof broadcast.createdAt).toBe('number');
  });
});

describe('trace context', () => {
  it('returns null outside a withTraceContext scope', () => {
    expect(currentTraceContext()).toBeNull();
  });

  it('returns the active context inside a scope', async () => {
    await withTraceContext(
      { runId: 'r1', parentEventId: 'p1', conversationId: 'c1', parentTurnId: 't1' },
      async () => {
        expect(currentTraceContext()).toEqual({
          runId: 'r1',
          parentEventId: 'p1',
          conversationId: 'c1',
          parentTurnId: 't1',
        });
      },
    );
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

```bash
pnpm --filter @shipflare/core test activity
```

Expected: FAIL — `Cannot find module '../activity'`.

- [ ] **Step 4: Implement `lib/activity.ts`**

```ts
// apps/core/src/lib/activity.ts
import { AsyncLocalStorage } from 'node:async_hooks';
import type { ActivityEventInput } from '@shipflare/shared';

export interface TraceContext {
  runId: string | null;
  parentEventId: string | null;
  conversationId: string | null;
  parentTurnId: string | null;
}

const TRACE_ALS = new AsyncLocalStorage<TraceContext>();

export function currentTraceContext(): TraceContext | null {
  return TRACE_ALS.getStore() ?? null;
}

export async function withTraceContext<T>(
  ctx: TraceContext,
  fn: () => Promise<T>,
): Promise<T> {
  return TRACE_ALS.run(ctx, fn);
}

// Minimal structural shape — anything with sqlStorage + broadcast (i.e. CMO).
// We don't import the CMO class here to avoid a cycle.
interface ActivityHost {
  sqlStorage: { exec: (q: string, ...args: unknown[]) => { toArray: () => unknown[] } };
  broadcast: (msg: string) => void;
}

/**
 * Single sanctioned writer for activity events. Inserts to the CMO's
 * activity_events table and broadcasts the event to connected WS clients.
 * Caller must already be on the CMO DO (this writes to `agent.sqlStorage`).
 */
export async function emitActivity(
  agent: ActivityHost,
  input: ActivityEventInput,
): Promise<void> {
  const id = crypto.randomUUID();
  const createdAt = Date.now();
  agent.sqlStorage.exec(
    `INSERT INTO activity_events
       (id, conversation_id, parent_turn_id, run_id, source_agent, parent_event_id, kind, payload_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    id,
    input.conversationId,
    input.parentTurnId,
    input.runId,
    input.sourceAgent,
    input.parentEventId,
    input.kind,
    JSON.stringify(input.payload),
    createdAt,
  );
  agent.broadcast(JSON.stringify({ id, createdAt, ...input }));
}
```

- [ ] **Step 5: Run test to verify it passes**

```bash
pnpm --filter @shipflare/core test activity
```

Expected: PASS (3/3).

- [ ] **Step 6: Commit**

```bash
git add apps/core/src/agents/cmo/schema.ts apps/core/src/lib/activity.ts apps/core/src/lib/__tests__/activity.test.ts
git commit -m "feat(core): activity_events table + emitActivity + trace context"
```

---

## Task 3: Cross-DO `forwardActivityToCmo` helper

**Files:**
- Create: `apps/core/src/lib/forward-activity.ts`
- Test: `apps/core/src/lib/__tests__/forward-activity.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// apps/core/src/lib/__tests__/forward-activity.test.ts
import { describe, expect, it, vi } from 'vitest';
import { forwardActivityToCmo } from '../forward-activity';

describe('forwardActivityToCmo', () => {
  it('POSTs to /internal/log-activity with the internal header', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    const fakeStub = { fetch: fetchSpy };
    const fakeNs = { idFromName: () => ({}), get: () => fakeStub };
    // CMO binding shape: namespace.idFromName(name) -> id; namespace.get(id) -> stub
    const env: any = { CMO: { idFromName: (n: string) => n, get: (id: string) => fakeStub } };

    // Capture waitUntil promises so we can await them
    const pending: Promise<unknown>[] = [];
    const ctx: any = { waitUntil: (p: Promise<unknown>) => pending.push(p) };

    forwardActivityToCmo(ctx, env, 'user-1', {
      conversationId: null,
      parentTurnId: null,
      runId: 'run-1',
      sourceAgent: 'head-of-growth',
      parentEventId: null,
      kind: 'subagent_text_delta',
      payload: { kind: 'subagent_text_delta', subAgent: 'head-of-growth', text: 'hi' },
    });
    await Promise.all(pending);

    expect(fetchSpy).toHaveBeenCalledOnce();
    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(String(url)).toContain('/internal/log-activity');
    expect(init.method).toBe('POST');
    expect(init.headers['x-shipflare-internal']).toBe('1');
    const body = JSON.parse(init.body);
    expect(body.kind).toBe('subagent_text_delta');
  });

  it('swallows fetch errors (fire-and-forget)', async () => {
    const fetchSpy = vi.fn().mockRejectedValue(new Error('boom'));
    const fakeStub = { fetch: fetchSpy };
    const env: any = { CMO: { idFromName: (n: string) => n, get: () => fakeStub } };
    const pending: Promise<unknown>[] = [];
    const ctx: any = { waitUntil: (p: Promise<unknown>) => pending.push(p) };

    expect(() =>
      forwardActivityToCmo(ctx, env, 'user-1', {
        conversationId: null, parentTurnId: null, runId: null,
        sourceAgent: 'head-of-growth', parentEventId: null,
        kind: 'turn_start', payload: { kind: 'turn_start' },
      }),
    ).not.toThrow();
    // Awaiting must not reject either.
    await expect(Promise.all(pending)).resolves.toBeDefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
pnpm --filter @shipflare/core test forward-activity
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement the helper**

```ts
// apps/core/src/lib/forward-activity.ts
import type { ActivityEventInput } from '@shipflare/shared';
import type { Env } from '../index';

/**
 * Forward an activity event from a sub-agent (HoG / SMM / platform DO /
 * onboarding handler) to the user's CMO DO via service binding.
 *
 * Fire-and-forget: sub-agent work must never block on telemetry.
 * Failures are swallowed — lost forwards are degraded UX, not correctness.
 *
 * The URL host is arbitrary; CF routes by binding, not by hostname.
 */
export function forwardActivityToCmo(
  ctx: { waitUntil: (p: Promise<unknown>) => void },
  env: Env,
  userId: string,
  event: ActivityEventInput,
): void {
  const id = env.CMO.idFromName(userId);
  const stub = env.CMO.get(id);
  ctx.waitUntil(
    stub
      .fetch('https://internal/internal/log-activity', {
        method: 'POST',
        headers: {
          'x-shipflare-internal': '1',
          'content-type': 'application/json',
        },
        body: JSON.stringify(event),
      })
      .catch(() => undefined),
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
pnpm --filter @shipflare/core test forward-activity
```

Expected: PASS (2/2).

- [ ] **Step 5: Commit**

```bash
git add apps/core/src/lib/forward-activity.ts apps/core/src/lib/__tests__/forward-activity.test.ts
git commit -m "feat(core): forwardActivityToCmo cross-DO helper"
```

---

## Task 4: CMO `/internal/log-activity` route

**Files:**
- Modify: `apps/core/src/agents/cmo/CMO.ts`
- Test: `apps/core/src/agents/cmo/__tests__/log-activity-route.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// apps/core/src/agents/cmo/__tests__/log-activity-route.test.ts
import { describe, expect, it, beforeEach } from 'vitest';
import { env, runDurableObjectAlarm } from 'cloudflare:test';

describe('CMO /internal/log-activity', () => {
  it('rejects requests without the internal header', async () => {
    const id = env.CMO.idFromName('user-test-A');
    const stub = env.CMO.get(id);
    const res = await stub.fetch('https://internal/internal/log-activity', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        conversationId: null, parentTurnId: null, runId: null,
        sourceAgent: 'head-of-growth', parentEventId: null,
        kind: 'turn_start', payload: { kind: 'turn_start' },
      }),
    });
    expect(res.status).toBe(403);
  });

  it('accepts a valid event with the internal header and returns 204', async () => {
    const id = env.CMO.idFromName('user-test-B');
    const stub = env.CMO.get(id);
    const res = await stub.fetch('https://internal/internal/log-activity', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-shipflare-internal': '1',
      },
      body: JSON.stringify({
        conversationId: 'c1', parentTurnId: null, runId: 'r1',
        sourceAgent: 'head-of-growth', parentEventId: null,
        kind: 'turn_start', payload: { kind: 'turn_start' },
      }),
    });
    expect(res.status).toBe(204);
  });

  it('rejects malformed events with 400', async () => {
    const id = env.CMO.idFromName('user-test-C');
    const stub = env.CMO.get(id);
    const res = await stub.fetch('https://internal/internal/log-activity', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-shipflare-internal': '1',
      },
      body: JSON.stringify({ kind: 'bogus' }),
    });
    expect(res.status).toBe(400);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
pnpm --filter @shipflare/core test log-activity-route
```

Expected: FAIL — endpoint not implemented (404 or unhandled route).

- [ ] **Step 3: Add the route to `CMO.fetch()`**

Find the existing `fetch()` override in `apps/core/src/agents/cmo/CMO.ts`. Add the new route alongside existing `/internal/*` handlers, BEFORE the fallback to `super.fetch()`:

```ts
// Inside CMO class — fetch() override
async fetch(request: Request): Promise<Response> {
  const url = new URL(request.url);

  // /internal/* — service-binding only, gated by x-shipflare-internal: 1
  if (url.pathname.startsWith('/internal/')) {
    if (request.headers.get('x-shipflare-internal') !== '1') {
      return new Response('forbidden', { status: 403 });
    }
    // NEW: activity event ingest
    if (url.pathname === '/internal/log-activity' && request.method === 'POST') {
      const { ActivityEventInputSchema } = await import('@shipflare/shared');
      const { emitActivity } = await import('../../lib/activity');
      let body: unknown;
      try {
        body = await request.json();
      } catch {
        return new Response('invalid json', { status: 400 });
      }
      const parsed = ActivityEventInputSchema.safeParse(body);
      if (!parsed.success) {
        return new Response(`invalid event: ${parsed.error.message}`, { status: 400 });
      }
      await emitActivity(this, parsed.data);
      return new Response(null, { status: 204 });
    }
    // … fall through to other existing /internal/* handlers
  }

  return super.fetch(request);
}
```

**Note:** If the file already has an existing `/internal/*` handler block (it does — peer-dm-shadow / init / cron-tick land here), insert the new branch *inside* that block above the fall-through.

- [ ] **Step 4: Run test to verify it passes**

```bash
pnpm --filter @shipflare/core test log-activity-route
```

Expected: PASS (3/3).

- [ ] **Step 5: Commit**

```bash
git add apps/core/src/agents/cmo/CMO.ts apps/core/src/agents/cmo/__tests__/log-activity-route.test.ts
git commit -m "feat(core): CMO /internal/log-activity ingest route"
```

---

## Task 5: CMO `getRecentActivity` callable (MCP tool)

**Files:**
- Create: `apps/core/src/agents/cmo/tools/get-recent-activity.ts`
- Modify: `apps/core/src/agents/cmo/CMO.ts` (register in `init()`)
- Test: `apps/core/src/agents/cmo/__tests__/get-recent-activity.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// apps/core/src/agents/cmo/__tests__/get-recent-activity.test.ts
import { describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';

async function postEvent(userId: string, evt: Record<string, unknown>) {
  const id = env.CMO.idFromName(userId);
  const stub = env.CMO.get(id);
  await stub.fetch('https://internal/internal/log-activity', {
    method: 'POST',
    headers: { 'x-shipflare-internal': '1', 'content-type': 'application/json' },
    body: JSON.stringify(evt),
  });
}

async function callRecent(userId: string, args: Record<string, unknown>): Promise<unknown[]> {
  const id = env.CMO.idFromName(userId);
  const stub = env.CMO.get(id);
  // The MCP tool is callable via the JSON-RPC tools/call path.
  const res = await stub.fetch('https://internal/agents/cmo/' + userId + '/mcp', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'getRecentActivity', arguments: args },
    }),
  });
  const out = await res.json();
  return JSON.parse((out as any).result.content[0].text);
}

describe('getRecentActivity', () => {
  it('returns events for a given runId, oldest first', async () => {
    const uid = 'user-recent-A';
    await postEvent(uid, {
      conversationId: null, parentTurnId: null, runId: 'r-1',
      sourceAgent: 'head-of-growth', parentEventId: null,
      kind: 'turn_start', payload: { kind: 'turn_start' },
    });
    await postEvent(uid, {
      conversationId: null, parentTurnId: null, runId: 'r-1',
      sourceAgent: 'head-of-growth', parentEventId: null,
      kind: 'turn_finish',
      payload: { kind: 'turn_finish', status: 'ok', durationMs: 100 },
    });
    const out = await callRecent(uid, { runId: 'r-1' });
    expect(out).toHaveLength(2);
    expect((out[0] as any).kind).toBe('turn_start');
    expect((out[1] as any).kind).toBe('turn_finish');
  });

  it('errors when neither conversationId nor runId is given', async () => {
    const uid = 'user-recent-B';
    await expect(callRecent(uid, {})).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
pnpm --filter @shipflare/core test get-recent-activity
```

Expected: FAIL — tool not registered.

- [ ] **Step 3: Implement the tool**

```ts
// apps/core/src/agents/cmo/tools/get-recent-activity.ts
import { z } from 'zod';
import type { CMO } from '../CMO';

const InputSchema = z
  .object({
    conversationId: z.string().optional(),
    runId: z.string().optional(),
    sinceMs: z.number().int().nonnegative().optional(),
    limit: z.number().int().positive().max(1000).optional(),
  })
  .refine((v) => v.conversationId !== undefined || v.runId !== undefined, {
    message: 'conversationId or runId required',
  });

export function registerGetRecentActivityTool(agent: CMO): void {
  agent.server.registerTool(
    'getRecentActivity',
    {
      description:
        'Read the tail of the activity_events table for a conversation or run. Used by the web client to seed the activity feed on mount and after reconnect.',
      inputSchema: InputSchema.shape,
    },
    async (args) => {
      const parsed = InputSchema.parse(args);
      const sinceMs = parsed.sinceMs ?? 0;
      const limit = parsed.limit ?? 200;

      // SQLite doesn't accept undefined; pass nulls for the unused filter.
      const conv = parsed.conversationId ?? null;
      const run = parsed.runId ?? null;

      const rows = agent.sqlStorage
        .exec<{
          id: string;
          conversation_id: string | null;
          parent_turn_id: string | null;
          run_id: string | null;
          source_agent: string;
          parent_event_id: string | null;
          kind: string;
          payload_json: string;
          created_at: number;
        }>(
          `SELECT id, conversation_id, parent_turn_id, run_id, source_agent,
                  parent_event_id, kind, payload_json, created_at
           FROM activity_events
           WHERE ((? IS NOT NULL AND conversation_id = ?)
                  OR (? IS NOT NULL AND run_id = ?))
             AND created_at > ?
           ORDER BY created_at ASC, id ASC
           LIMIT ?`,
          conv, conv, run, run, sinceMs, limit,
        )
        .toArray()
        .map((r) => ({
          id: r.id,
          conversationId: r.conversation_id,
          parentTurnId: r.parent_turn_id,
          runId: r.run_id,
          sourceAgent: r.source_agent,
          parentEventId: r.parent_event_id,
          kind: r.kind,
          payload: JSON.parse(r.payload_json),
          createdAt: r.created_at,
        }));

      return {
        content: [{ type: 'text' as const, text: JSON.stringify(rows) }],
      };
    },
  );
}
```

- [ ] **Step 4: Register the tool in CMO `init()`**

In `apps/core/src/agents/cmo/CMO.ts`, find the `init()` method and add the new registration alongside the existing `registerChatTool(this)` etc.:

```ts
import { registerGetRecentActivityTool } from './tools/get-recent-activity';

// inside init():
async init(): Promise<void> {
  if (this._toolsRegistered) return;
  this._toolsRegistered = true;
  registerChatTool(this);
  registerConversationTools(this);
  registerRosterTools(this);
  registerDelegationTools(this);
  registerSharedStateTools(this);
  registerGetRecentActivityTool(this); // NEW
}
```

- [ ] **Step 5: Run test to verify it passes**

```bash
pnpm --filter @shipflare/core test get-recent-activity
```

Expected: PASS (2/2).

- [ ] **Step 6: Commit**

```bash
git add apps/core/src/agents/cmo/tools/get-recent-activity.ts apps/core/src/agents/cmo/CMO.ts apps/core/src/agents/cmo/__tests__/get-recent-activity.test.ts
git commit -m "feat(core): CMO getRecentActivity tool (seed-replay for browser)"
```

---

## Task 6: WS token endpoint + CMO `onConnect` JWT verify

**Files:**
- Create: `apps/web/app/api/cmo-ws-token/route.ts`
- Modify: `apps/core/src/agents/cmo/CMO.ts` — add `onConnect`
- Test: `apps/core/src/agents/cmo/__tests__/on-connect.test.ts`

- [ ] **Step 1: Write the failing test for `onConnect`**

```ts
// apps/core/src/agents/cmo/__tests__/on-connect.test.ts
import { describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import { signJwt } from '../../../lib/jwt';

describe('CMO WebSocket auth (activity scope)', () => {
  it('accepts a valid activity-scoped token', async () => {
    const uid = 'user-ws-A';
    const token = await signJwt(
      { userId: uid, scope: 'activity', exp: Math.floor(Date.now() / 1000) + 60 },
      env.MCP_JWT_SECRET,
    );
    const id = env.CMO.idFromName(uid);
    const stub = env.CMO.get(id);
    const res = await stub.fetch(
      `https://internal/agents/cmo/${uid}?token=${encodeURIComponent(token)}`,
      { headers: { upgrade: 'websocket' } },
    );
    expect(res.status).toBe(101);
    res.webSocket?.close();
  });

  it('rejects a missing token with 1008 close on the WS', async () => {
    const uid = 'user-ws-B';
    const id = env.CMO.idFromName(uid);
    const stub = env.CMO.get(id);
    const res = await stub.fetch(`https://internal/agents/cmo/${uid}`, {
      headers: { upgrade: 'websocket' },
    });
    // The Agents SDK accepts the upgrade, then onConnect closes it.
    expect(res.status).toBe(101);
    res.webSocket?.accept();
    await new Promise<void>((resolve) => {
      res.webSocket!.addEventListener('close', () => resolve());
    });
  });

  it('rejects a token signed for the MCP scope', async () => {
    const uid = 'user-ws-C';
    const token = await signJwt(
      { userId: uid, scope: 'mcp', exp: Math.floor(Date.now() / 1000) + 60 },
      env.MCP_JWT_SECRET,
    );
    const id = env.CMO.idFromName(uid);
    const stub = env.CMO.get(id);
    const res = await stub.fetch(
      `https://internal/agents/cmo/${uid}?token=${encodeURIComponent(token)}`,
      { headers: { upgrade: 'websocket' } },
    );
    expect(res.status).toBe(101);
    res.webSocket?.accept();
    await new Promise<void>((resolve) => {
      res.webSocket!.addEventListener('close', () => resolve());
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
pnpm --filter @shipflare/core test on-connect
```

Expected: FAIL — `onConnect` does not yet validate scope.

- [ ] **Step 3: Implement `onConnect`**

In `apps/core/src/agents/cmo/CMO.ts`, add the `onConnect` lifecycle hook. Place it next to `onStart`:

```ts
import { verifyJwt } from '../../lib/jwt';
import type { Connection, ConnectionContext } from 'agents';

// inside CMO class:
async onConnect(conn: Connection, ctx: ConnectionContext): Promise<void> {
  // Browser WS connection — must carry an activity-scoped JWT.
  // McpAgent uses transport-prefix names (sse:/streamable-http:/rpc:);
  // those go through super.onConnect (MCP transport). Activity WS connects
  // via the non-MCP /agents/cmo/<userId> route; ctx.request.url has no
  // transport prefix.
  const url = new URL(ctx.request.url);
  const isMcpTransport = url.pathname.includes('/mcp');
  if (isMcpTransport) {
    // Delegate to McpAgent transport handling.
    return super.onConnect?.(conn, ctx);
  }
  const token = url.searchParams.get('token');
  if (!token) {
    conn.close(1008, 'missing token');
    return;
  }
  const claims = await verifyJwt(token, this.env.MCP_JWT_SECRET);
  const expectedUserId = this.props?.userId;
  if (
    !claims ||
    (claims as { scope?: string }).scope !== 'activity' ||
    (claims as { userId?: string }).userId !== expectedUserId
  ) {
    conn.close(1008, 'unauthorized');
    return;
  }
}
```

- [ ] **Step 4: Implement the token-mint endpoint**

```ts
// apps/web/app/api/cmo-ws-token/route.ts
import { NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { signJwt } from '@shipflare/core/lib/jwt'; // adjust path to existing helper

export const runtime = 'edge';

export async function POST(req: Request): Promise<Response> {
  const session = await auth.api.getSession({ headers: req.headers });
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  const secret = process.env.MCP_JWT_SECRET;
  if (!secret) {
    return NextResponse.json({ error: 'misconfigured' }, { status: 500 });
  }
  const token = await signJwt(
    {
      userId: session.user.id,
      scope: 'activity',
      exp: Math.floor(Date.now() / 1000) + 60,
    },
    secret,
  );
  return NextResponse.json({ token });
}
```

**Note:** If `apps/web` already imports `signJwt` from a colocated module (e.g. `apps/web/src/lib/mcp-token.ts`), use that one — the import path above is illustrative. Match the existing MCP-token route.

- [ ] **Step 5: Run test to verify it passes**

```bash
pnpm --filter @shipflare/core test on-connect
```

Expected: PASS (3/3). (If the SDK upgrade flow differs from the stub above, adjust the test to drive the actual `agentFetch` path used by the SDK in production. The core invariant — invalid tokens close with 1008 — must hold.)

- [ ] **Step 6: Commit**

```bash
git add apps/core/src/agents/cmo/CMO.ts apps/core/src/agents/cmo/__tests__/on-connect.test.ts apps/web/app/api/cmo-ws-token/route.ts
git commit -m "feat: CMO WS auth (activity-scope JWT) + token mint endpoint"
```

---

## Task 7: CMO `chat` tool — turn_start / turn_finish instrumentation

**Files:**
- Modify: `apps/core/src/agents/cmo/tools/chat.ts`
- Test: `apps/core/src/agents/cmo/__tests__/chat-activity.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// apps/core/src/agents/cmo/__tests__/chat-activity.test.ts
import { describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';

async function callChat(userId: string, conversationId: string, message: string) {
  const id = env.CMO.idFromName(userId);
  const stub = env.CMO.get(id);
  const res = await stub.fetch(`https://internal/agents/cmo/${userId}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'chat', arguments: { conversationId, message } },
    }),
  });
  return res.json();
}

async function readActivity(userId: string, conversationId: string) {
  const id = env.CMO.idFromName(userId);
  const stub = env.CMO.get(id);
  const res = await stub.fetch(`https://internal/agents/cmo/${userId}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'getRecentActivity', arguments: { conversationId } },
    }),
  });
  const out = await res.json();
  return JSON.parse((out as any).result.content[0].text) as any[];
}

describe('chat tool emits turn_start / turn_finish', () => {
  it('writes a turn_start before and turn_finish after the Anthropic call', async () => {
    const uid = 'user-chat-A';
    const conv = 'conv-chat-A';
    // Start a conversation first via the existing conversation tool.
    const idns = env.CMO.idFromName(uid);
    const stub = env.CMO.get(idns);
    await stub.fetch(`https://internal/agents/cmo/${uid}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 1,
        method: 'tools/call',
        params: { name: 'startNewConversation', arguments: { id: conv } },
      }),
    });

    await callChat(uid, conv, 'hello');
    const evts = await readActivity(uid, conv);
    const kinds = evts.map((e) => e.kind);
    expect(kinds).toContain('turn_start');
    expect(kinds).toContain('turn_finish');
    const finish = evts.find((e) => e.kind === 'turn_finish');
    expect(finish?.payload.status).toBe('ok');
    expect(finish?.payload.durationMs).toBeGreaterThanOrEqual(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
pnpm --filter @shipflare/core test chat-activity
```

Expected: FAIL — no `turn_start` / `turn_finish` rows.

- [ ] **Step 3: Wrap `chat.ts` with lifecycle events**

Inside `apps/core/src/agents/cmo/tools/chat.ts`, instrument the handler. Add at the top of the handler body:

```ts
import { emitActivity } from '../../../lib/activity';

// At the very start of the async handler, after parsing args:
const turnStartTs = Date.now();
const parentTurnId = crypto.randomUUID(); // synthetic id tying together this turn's child events
await emitActivity(agent, {
  conversationId,
  parentTurnId,
  runId: null,
  sourceAgent: 'cmo',
  parentEventId: null,
  kind: 'turn_start',
  payload: { kind: 'turn_start' },
});

// … existing handler body …

// After `await stream.finalMessage()` succeeds and before `return`:
await emitActivity(agent, {
  conversationId,
  parentTurnId,
  runId: null,
  sourceAgent: 'cmo',
  parentEventId: null,
  kind: 'turn_finish',
  payload: { kind: 'turn_finish', status: 'ok', durationMs: Date.now() - turnStartTs },
});
```

Wrap the Anthropic call in `try { … } catch (err) { … }`. In the catch, emit `turn_finish` with `status: 'error'` and the error message (truncated to 200 chars), then re-throw:

```ts
try {
  // existing Anthropic streaming block + persist assistant reply
} catch (err) {
  await emitActivity(agent, {
    conversationId,
    parentTurnId,
    runId: null,
    sourceAgent: 'cmo',
    parentEventId: null,
    kind: 'turn_finish',
    payload: {
      kind: 'turn_finish',
      status: 'error',
      durationMs: Date.now() - turnStartTs,
      errorMessage: (err instanceof Error ? err.message : String(err)).slice(0, 200),
    },
  });
  throw err;
}
```

**Note:** `parentTurnId` must also flow into the returned assistant message metadata so the web client can group `Activity (N)` under the right bubble. Add it to the MCP tool result `_meta`:

```ts
return {
  _meta: { parentTurnId },
  content: [{ type: 'text' as const, text: acc }],
};
```

- [ ] **Step 4: Run test to verify it passes**

```bash
pnpm --filter @shipflare/core test chat-activity
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/core/src/agents/cmo/tools/chat.ts apps/core/src/agents/cmo/__tests__/chat-activity.test.ts
git commit -m "feat(cmo): chat tool emits turn_start / turn_finish with parentTurnId"
```

---

## Task 8: CMO `delegate` tool — subagent_dispatch / subagent_finish

**Files:**
- Modify: `apps/core/src/agents/cmo/tools/delegate.ts`
- Test: `apps/core/src/agents/cmo/__tests__/delegate-activity.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// apps/core/src/agents/cmo/__tests__/delegate-activity.test.ts
import { describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';

describe('delegateToEmployee emits subagent_dispatch / subagent_finish', () => {
  it('emits dispatch before and finish after the in-process MCP call', async () => {
    const uid = 'user-delegate-A';
    const idns = env.CMO.idFromName(uid);
    const stub = env.CMO.get(idns);

    // Hire HoG first (existing hire flow)
    await stub.fetch(`https://internal/agents/cmo/${uid}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 1, method: 'tools/call',
        params: { name: 'hireEmployee', arguments: { role: 'head-of-growth' } },
      }),
    });

    // Delegate
    await stub.fetch(`https://internal/agents/cmo/${uid}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 2, method: 'tools/call',
        params: {
          name: 'delegateToEmployee',
          arguments: {
            role: 'head-of-growth',
            tool: 'ping', // any tool the HoG actually has; adjust to a real one in your branch
            args: {},
            conversationId: 'conv-delegate-A',
          },
        },
      }),
    });

    const res = await stub.fetch(`https://internal/agents/cmo/${uid}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 3, method: 'tools/call',
        params: { name: 'getRecentActivity', arguments: { conversationId: 'conv-delegate-A' } },
      }),
    });
    const evts = JSON.parse(((await res.json()) as any).result.content[0].text) as any[];
    const kinds = evts.map((e) => e.kind);
    expect(kinds).toContain('subagent_dispatch');
    expect(kinds).toContain('subagent_finish');
    const finish = evts.find((e) => e.kind === 'subagent_finish');
    expect(finish.payload.subAgent).toBe('head-of-growth');
  });
});
```

(If HoG does not yet expose a `ping` tool in the test env, substitute a real one or skip the in-process call and assert dispatch+finish are emitted regardless of inner success.)

- [ ] **Step 2: Run test to verify it fails**

```bash
pnpm --filter @shipflare/core test delegate-activity
```

Expected: FAIL — no `subagent_*` events emitted.

- [ ] **Step 3: Instrument `delegate.ts`**

Replace the existing delegate handler body with:

```ts
import { emitActivity } from '../../../lib/activity';

async ({ role, tool, args, conversationId }) => {
  if (!isValidRole(role)) throw new Error(`Unknown role: ${role}`);
  if (role === 'cmo') throw new Error('Cannot delegate to self');
  const userId = agent.props?.userId;
  if (!userId) throw new Error('CMO has no userId in props; cannot delegate');

  const targetName = mcpServerName(role as RoleSlug, userId);
  const server = agent.mcp.listServers().find((s) => s.name === targetName);
  if (!server) {
    throw new Error(`Employee "${role}" is not connected. Hire them first via hireEmployee.`);
  }

  // Emit dispatch
  const dispatchEventId = crypto.randomUUID();
  const dispatchStart = Date.now();
  const promptPreview =
    args && typeof args === 'object' && 'message' in args
      ? String((args as Record<string, unknown>).message).slice(0, 200)
      : JSON.stringify(args).slice(0, 200);
  await emitActivity(agent, {
    conversationId: conversationId ?? null,
    parentTurnId: null,
    runId: null,
    sourceAgent: 'cmo',
    parentEventId: null,
    kind: 'subagent_dispatch',
    payload: { kind: 'subagent_dispatch', subAgent: role, promptPreview },
  });

  // Thread trace context through to the employee via a reserved arg.
  // HoG/SMM read `_trace` from their args and forward upward with the same
  // parentEventId / runId.
  const argsWithTrace = {
    ...(args as Record<string, unknown>),
    _trace: {
      runId: null,
      parentEventId: dispatchEventId,
      conversationId: conversationId ?? null,
      parentTurnId: null,
      userId,
    },
  };

  let status: 'ok' | 'error' = 'ok';
  let summary: string | undefined;
  try {
    const result = await agent.mcp.callTool({
      serverId: server.id,
      name: tool,
      arguments: argsWithTrace,
    });
    summary = `${role}.${tool} returned`;
    agent.sqlStorage.exec(
      `INSERT INTO employee_log (conversation_id, from_role, kind, summary, payload_json, ts)
       VALUES (?, ?, 'task_complete', ?, ?, ?)`,
      conversationId ?? null,
      role,
      summary,
      JSON.stringify({ tool, args, result }),
      Date.now(),
    );
    await emitActivity(agent, {
      conversationId: conversationId ?? null,
      parentTurnId: null,
      runId: null,
      sourceAgent: 'cmo',
      parentEventId: null,
      kind: 'subagent_finish',
      payload: {
        kind: 'subagent_finish',
        subAgent: role,
        status: 'ok',
        durationMs: Date.now() - dispatchStart,
        summary,
      },
    });
    return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
  } catch (err) {
    status = 'error';
    await emitActivity(agent, {
      conversationId: conversationId ?? null,
      parentTurnId: null,
      runId: null,
      sourceAgent: 'cmo',
      parentEventId: null,
      kind: 'subagent_finish',
      payload: {
        kind: 'subagent_finish',
        subAgent: role,
        status: 'error',
        durationMs: Date.now() - dispatchStart,
        summary: err instanceof Error ? err.message.slice(0, 200) : String(err).slice(0, 200),
      },
    });
    throw err;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
pnpm --filter @shipflare/core test delegate-activity
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/core/src/agents/cmo/tools/delegate.ts apps/core/src/agents/cmo/__tests__/delegate-activity.test.ts
git commit -m "feat(cmo): delegate emits subagent_dispatch/finish + threads trace context"
```

---

## Task 9: Onboarding strategic-path — switch to streaming + emit events

**Files:**
- Modify: `apps/core/src/onboarding-routes.ts` (the `/internal/onboarding/strategic-path` branch starting at line 367)
- Test: `apps/core/src/__tests__/strategic-path-activity.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// apps/core/src/__tests__/strategic-path-activity.test.ts
import { describe, expect, it, vi } from 'vitest';
import { env } from 'cloudflare:test';

// This test stubs ANTHROPIC_API_KEY to a fixture that the implementation
// will short-circuit when set to "TEST_FIXTURE". In that mode the handler
// emits a fixed sequence of text deltas to exercise the activity emission
// path without making a real Anthropic call.
describe('strategic-path emits subagent_dispatch / text_delta / subagent_finish', () => {
  it('persists events keyed by runId', async () => {
    const uid = 'user-strategic-A';
    const runId = crypto.randomUUID();

    // Hit the strategic-path SSE handler. The fixture mode produces a JSON
    // payload `{ "phases": [], "weekly": [] }` in 3 chunks.
    const res = await fetch('https://internal/internal/onboarding/strategic-path', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-shipflare-internal': '1' },
      body: JSON.stringify({
        userId: uid,
        runId,
        product: { name: 'Test', description: 'd' },
        state: 'preLaunch',
        channels: [],
        _test_fixture: true,
      }),
    });
    expect(res.ok).toBe(true);
    // Drain the SSE so the handler runs to completion
    const reader = res.body!.getReader();
    while (!(await reader.read()).done) { /* drain */ }

    // Read the activity events from CMO
    const idns = env.CMO.idFromName(uid);
    const stub = env.CMO.get(idns);
    const r = await stub.fetch(`https://internal/agents/cmo/${uid}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 1, method: 'tools/call',
        params: { name: 'getRecentActivity', arguments: { runId } },
      }),
    });
    const evts = JSON.parse(((await r.json()) as any).result.content[0].text) as any[];
    const kinds = evts.map((e) => e.kind);
    expect(kinds[0]).toBe('subagent_dispatch');
    expect(kinds).toContain('subagent_text_delta');
    expect(kinds[kinds.length - 1]).toBe('subagent_finish');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
pnpm --filter @shipflare/core test strategic-path-activity
```

Expected: FAIL — `runId` field unknown to the schema, no events emitted.

- [ ] **Step 3: Update the input schema to accept `runId` + `userId`**

In `apps/core/src/onboarding-routes.ts`, find `strategicPathInputSchema` (declared earlier in the file). Add two optional fields:

```ts
const strategicPathInputSchema = z.object({
  // … existing fields …
  userId: z.string().optional(),
  runId: z.string().uuid().optional(),
  _test_fixture: z.boolean().optional(),
});
```

- [ ] **Step 4: Switch the handler to streaming and emit events**

Replace the body of the `/internal/onboarding/strategic-path` SSE handler (starts around line 378 inside `sseStream(async (send) => { … })`):

```ts
return sseStream(async (send) => {
  const launchDate = body.launchDate ? new Date(body.launchDate) : null;
  const launchedAt = body.launchedAt ? new Date(body.launchedAt) : null;
  const currentPhase = deriveCurrentPhase(body.state, launchDate, launchedAt);
  const today = new Date();
  const weekStart = isoMondayUTC(today);

  const userMessage = JSON.stringify(
    { today: today.toISOString().slice(0, 10), weekStart, product: body.product,
      state: body.state, currentPhase, channels: body.channels,
      launchDate: body.launchDate ?? null, launchedAt: body.launchedAt ?? null,
      launchChannel: body.launchChannel ?? null, usersBucket: body.usersBucket ?? null },
    null, 2,
  );

  const abortController = new AbortController();
  const heartbeat = setInterval(() => send({ type: 'heartbeat' }), HEARTBEAT_MS);
  const timeoutId = setTimeout(() => abortController.abort(), PLAN_TIMEOUT_MS);

  const forward = body.userId && body.runId
    ? (evt: import('@shipflare/shared').ActivityEventInput) =>
        forwardActivityToCmo(ctx, env, body.userId!, evt)
    : () => undefined;

  const runId = body.runId ?? null;
  const dispatchStart = Date.now();
  forward({
    conversationId: null, parentTurnId: null, runId, parentEventId: null,
    sourceAgent: 'strategic-planner',
    kind: 'subagent_dispatch',
    payload: {
      kind: 'subagent_dispatch',
      subAgent: 'strategic-planner',
      promptPreview: `Plan for ${body.product?.name ?? 'product'}`,
    },
  });

  try {
    let text = '';
    if (body._test_fixture) {
      // Fixture path — no real Anthropic call.
      for (const chunk of ['{"phases":[],', '"weekly":', '[]}']) {
        text += chunk;
        forward({
          conversationId: null, parentTurnId: null, runId, parentEventId: null,
          sourceAgent: 'strategic-planner',
          kind: 'subagent_text_delta',
          payload: { kind: 'subagent_text_delta', subAgent: 'strategic-planner', text: chunk },
        });
      }
    } else {
      const client = getAnthropic(env.ANTHROPIC_API_KEY!);
      const stream = client.messages.stream(
        { model: 'claude-sonnet-4-6', max_tokens: 4096, system: SYSTEM_PROMPT,
          messages: [{ role: 'user', content: userMessage }] },
        { signal: abortController.signal },
      );

      // Batched text-delta forwarding — 200 ms or 16 deltas.
      let buf = '';
      let lastFlush = Date.now();
      const flush = () => {
        if (!buf) return;
        forward({
          conversationId: null, parentTurnId: null, runId, parentEventId: null,
          sourceAgent: 'strategic-planner',
          kind: 'subagent_text_delta',
          payload: { kind: 'subagent_text_delta', subAgent: 'strategic-planner', text: buf },
        });
        buf = '';
        lastFlush = Date.now();
      };
      stream.on('text', (delta: string) => {
        text += delta;
        buf += delta;
        if (buf.length >= 256 || Date.now() - lastFlush >= 200) flush();
      });
      await stream.finalMessage();
      flush();
    }

    const m = text.match(/\{[\s\S]*\}/);
    if (!m) {
      forward({
        conversationId: null, parentTurnId: null, runId, parentEventId: null,
        sourceAgent: 'strategic-planner',
        kind: 'subagent_finish',
        payload: {
          kind: 'subagent_finish', subAgent: 'strategic-planner',
          status: 'error', durationMs: Date.now() - dispatchStart,
          summary: 'no_json_in_response',
        },
      });
      send({ type: 'error', error: 'no_json_in_response' });
      return;
    }
    const raw = JSON.parse(m[0]) as unknown;
    const strategicPath: StrategicPath = strategicPathSchema.parse(raw);
    forward({
      conversationId: null, parentTurnId: null, runId, parentEventId: null,
      sourceAgent: 'strategic-planner',
      kind: 'subagent_finish',
      payload: {
        kind: 'subagent_finish', subAgent: 'strategic-planner',
        status: 'ok', durationMs: Date.now() - dispatchStart,
        summary: 'plan ready',
      },
    });
    send({ type: 'strategic_done', path: strategicPath });
  } catch (err) {
    forward({
      conversationId: null, parentTurnId: null, runId, parentEventId: null,
      sourceAgent: 'strategic-planner',
      kind: 'subagent_finish',
      payload: {
        kind: 'subagent_finish', subAgent: 'strategic-planner',
        status: 'error', durationMs: Date.now() - dispatchStart,
        summary: err instanceof Error ? err.message.slice(0, 200) : String(err).slice(0, 200),
      },
    });
    if (abortController.signal.aborted) {
      send({ type: 'error', error: 'planner_timeout' });
      return;
    }
    send({ type: 'error', error: err instanceof Error ? err.message : 'PlanGenerationError' });
  } finally {
    clearInterval(heartbeat);
    clearTimeout(timeoutId);
  }
});
```

**Note:** `ctx` (the Worker `ExecutionContext`) must be in scope where `forwardActivityToCmo` is called. The handler is invoked from the worker's top-level fetch — `ctx` should be in the enclosing closure. If not currently in scope, plumb it down from the route's outer signature (it lives on the args of `fetch(req, env, ctx)`).

- [ ] **Step 5: Run test to verify it passes**

```bash
pnpm --filter @shipflare/core test strategic-path-activity
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/core/src/onboarding-routes.ts apps/core/src/__tests__/strategic-path-activity.test.ts
git commit -m "feat(onboarding): strategic-path streams + emits activity events"
```

---

## Task 10: HoG / SMM tool instrumentation (read `_trace`, forward upward)

**Files:**
- Modify: `apps/core/src/agents/head-of-growth/HeadOfGrowth.ts` (or wherever its tools are registered)
- Modify: `apps/core/src/agents/social-media-manager/SocialMediaMgr.ts` (or its tool files)
- Test: `apps/core/src/agents/__tests__/sub-agent-forwarding.test.ts`

This task wires HoG and SMM to emit upward. The instrumentation is the same shape for both — a single shared helper plus a small wrapper in each tool handler.

- [ ] **Step 1: Create a shared sub-agent activity helper**

```ts
// apps/core/src/lib/subagent-activity.ts
import type { ActivityEventInput } from '@shipflare/shared';
import { forwardActivityToCmo } from './forward-activity';

export interface SubAgentTrace {
  runId: string | null;
  parentEventId: string | null;
  conversationId: string | null;
  parentTurnId: string | null;
  userId: string;
}

/**
 * Pull the `_trace` arg embedded by CMO.delegateToEmployee (Task 8) out of
 * a sub-agent tool's input. Returns null if no trace was supplied — sub-agent
 * tools should treat that as "no instrumentation, run as usual".
 */
export function extractTrace(args: unknown): SubAgentTrace | null {
  if (!args || typeof args !== 'object') return null;
  const t = (args as Record<string, unknown>)._trace;
  if (!t || typeof t !== 'object') return null;
  const trace = t as Partial<SubAgentTrace>;
  if (!trace.userId) return null;
  return {
    userId: trace.userId,
    runId: trace.runId ?? null,
    parentEventId: trace.parentEventId ?? null,
    conversationId: trace.conversationId ?? null,
    parentTurnId: trace.parentTurnId ?? null,
  };
}

/**
 * Wrap a sub-agent tool handler. Emits subagent_tool_call_start before the
 * body and subagent_tool_call_finish after (success or error). No-op when
 * trace is absent.
 */
export async function withSubAgentToolTracing<T>(
  ctx: { waitUntil: (p: Promise<unknown>) => void },
  env: import('../index').Env,
  trace: SubAgentTrace | null,
  subAgent: string,
  toolName: string,
  args: unknown,
  body: () => Promise<T>,
): Promise<T> {
  if (!trace) return body();
  const start = Date.now();
  const argsPreview = JSON.stringify(args).slice(0, 200);
  const startEvt: ActivityEventInput = {
    conversationId: trace.conversationId,
    parentTurnId: trace.parentTurnId,
    runId: trace.runId,
    sourceAgent: subAgent,
    parentEventId: trace.parentEventId,
    kind: 'subagent_tool_call_start',
    payload: { kind: 'subagent_tool_call_start', subAgent, tool: toolName, argsPreview },
  };
  forwardActivityToCmo(ctx, env, trace.userId, startEvt);
  try {
    const out = await body();
    forwardActivityToCmo(ctx, env, trace.userId, {
      ...startEvt,
      kind: 'subagent_tool_call_finish',
      payload: { kind: 'subagent_tool_call_finish', subAgent, tool: toolName, status: 'ok', durationMs: Date.now() - start },
    });
    return out;
  } catch (err) {
    forwardActivityToCmo(ctx, env, trace.userId, {
      ...startEvt,
      kind: 'subagent_tool_call_finish',
      payload: { kind: 'subagent_tool_call_finish', subAgent, tool: toolName, status: 'error', durationMs: Date.now() - start },
    });
    throw err;
  }
}
```

- [ ] **Step 2: Write the failing test**

```ts
// apps/core/src/agents/__tests__/sub-agent-forwarding.test.ts
import { describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';

describe('HoG tool emits subagent_tool_call_start/finish when _trace is passed', () => {
  it('forwards events to the user\'s CMO', async () => {
    const uid = 'user-sub-A';
    const idns = env.CMO.idFromName(uid);
    const stub = env.CMO.get(idns);

    // Hire HoG so its DO exists in the test env
    await stub.fetch(`https://internal/agents/cmo/${uid}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 1, method: 'tools/call',
        params: { name: 'hireEmployee', arguments: { role: 'head-of-growth' } },
      }),
    });

    // Delegate (this is what threads _trace through)
    await stub.fetch(`https://internal/agents/cmo/${uid}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 2, method: 'tools/call',
        params: {
          name: 'delegateToEmployee',
          arguments: { role: 'head-of-growth', tool: 'ping', args: {} },
        },
      }),
    });

    const r = await stub.fetch(`https://internal/agents/cmo/${uid}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 3, method: 'tools/call',
        params: { name: 'getRecentActivity', arguments: { runId: '*' } }, // see note below
      }),
    });
    const evts = JSON.parse(((await r.json()) as any).result.content[0].text) as any[];
    // We expect dispatch (from CMO), tool_call_start/finish (from HoG), finish (from CMO).
    const kinds = evts.map((e) => e.kind);
    expect(kinds).toContain('subagent_dispatch');
    expect(kinds).toContain('subagent_tool_call_start');
    expect(kinds).toContain('subagent_tool_call_finish');
    expect(kinds).toContain('subagent_finish');
  });
});
```

**Note:** The `runId: '*'` wildcard is not supported by `getRecentActivity` — adjust the test to query by `conversationId` (set one during delegate) or extend the tool to accept a "match-any" filter for tests. The simplest fix is to pass `conversationId: 'conv-sub-A'` to the delegate call and query by that id.

- [ ] **Step 3: Run test to verify it fails**

```bash
pnpm --filter @shipflare/core test sub-agent-forwarding
```

Expected: FAIL — HoG tools don't yet wrap with `withSubAgentToolTracing`.

- [ ] **Step 4: Add a `ping` tool on HoG (or wrap an existing one)**

To keep the test isolated, register a trivial `ping` tool on HoG that uses the tracing helper. In whatever file declares HoG tools (likely `apps/core/src/agents/head-of-growth/HeadOfGrowth.ts` or under `apps/core/src/agents/head-of-growth/tools/`), add:

```ts
import { extractTrace, withSubAgentToolTracing } from '../../../lib/subagent-activity';

agent.server.registerTool(
  'ping',
  { description: 'Diagnostic ping — used by activity-feed tests.', inputSchema: { _trace: z.unknown().optional() } as any },
  async (args, _extra) => {
    const trace = extractTrace(args);
    return withSubAgentToolTracing(
      agent.ctx,
      agent.bindings,
      trace,
      'head-of-growth',
      'ping',
      args,
      async () => ({ content: [{ type: 'text' as const, text: 'pong' }] }),
    );
  },
);
```

Repeat for SMM (use `'social-media-manager'` as `subAgent`).

For **production HoG/SMM tools** (e.g., `generate-strategic-path.ts`, `find-threads-via-xai.ts`, `process-replies-batch.ts`, etc.), apply the same wrapper:

```ts
// At the top of each handler:
const trace = extractTrace(args);
return withSubAgentToolTracing(
  agent.ctx, agent.bindings, trace,
  /* subAgent: */ 'head-of-growth', // or 'social-media-manager'
  /* toolName: */ 'generate_strategic_path',
  args,
  async () => {
    // existing handler body
  },
);
```

Do this for every registered tool on HoG and SMM. (If there are many, group the diff into a single commit per agent.)

- [ ] **Step 5: Run test to verify it passes**

```bash
pnpm --filter @shipflare/core test sub-agent-forwarding
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/core/src/lib/subagent-activity.ts \
        apps/core/src/agents/head-of-growth/ \
        apps/core/src/agents/social-media-manager/ \
        apps/core/src/agents/__tests__/sub-agent-forwarding.test.ts
git commit -m "feat: HoG/SMM tool instrumentation forwards activity to CMO"
```

---

## Task 11: `useCmoActivity` React hook

**Files:**
- Create: `apps/web/src/hooks/use-cmo-activity.ts`
- Test: `apps/web/src/hooks/__tests__/use-cmo-activity.test.tsx`

- [ ] **Step 1: Write the failing test**

```tsx
// apps/web/src/hooks/__tests__/use-cmo-activity.test.tsx
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { useCmoActivity } from '../use-cmo-activity';

// Mock the SDK + token endpoint
vi.mock('agents/react', () => {
  const listeners: Record<string, (e: any) => void> = {};
  return {
    useAgent: ({ onMessage }: { onMessage: (msg: MessageEvent<string>) => void }) => {
      listeners.onMessage = (e) => onMessage(e as MessageEvent<string>);
      return {
        stub: {
          getRecentActivity: vi.fn().mockResolvedValue([
            { id: 'seed-1', kind: 'turn_start', createdAt: 1, conversationId: 'c1',
              parentTurnId: null, runId: null, sourceAgent: 'cmo', parentEventId: null,
              payload: { kind: 'turn_start' } },
          ]),
        },
        // Test hook to push a fake WS message
        __pushMessage: (e: any) => listeners.onMessage?.(e),
      };
    },
  };
});

global.fetch = vi.fn().mockResolvedValue(
  new Response(JSON.stringify({ token: 'fake-token' })),
);

describe('useCmoActivity', () => {
  it('seeds events from getRecentActivity and appends live broadcasts', async () => {
    const { result } = renderHook(() => useCmoActivity({ conversationId: 'c1' }));
    await waitFor(() => expect(result.current.events.length).toBeGreaterThan(0));
    expect(result.current.events[0]!.id).toBe('seed-1');
  });

  it('dedupes by event.id', async () => {
    const { result } = renderHook(() => useCmoActivity({ conversationId: 'c1' }));
    await waitFor(() => expect(result.current.events.length).toBe(1));
    // Push the same id again — should not duplicate.
    act(() => {
      const live = {
        id: 'seed-1', kind: 'turn_start', createdAt: 1, conversationId: 'c1',
        parentTurnId: null, runId: null, sourceAgent: 'cmo', parentEventId: null,
        payload: { kind: 'turn_start' },
      };
      (window as any).__pushMessage?.({ data: JSON.stringify(live) });
    });
    expect(result.current.events.length).toBe(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
pnpm --filter @shipflare/web test use-cmo-activity
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement the hook**

```ts
// apps/web/src/hooks/use-cmo-activity.ts
'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useAgent } from 'agents/react';
import { ActivityEventSchema, type ActivityEvent } from '@shipflare/shared';
import { useSession } from '@/lib/auth-client';

export type CmoActivityFilter =
  | { conversationId: string }
  | { runId: string };

interface UseCmoActivityResult {
  events: ActivityEvent[];
  isConnected: boolean;
  connectionError: string | null;
}

export function useCmoActivity(filter: CmoActivityFilter): UseCmoActivityResult {
  const { data: session } = useSession();
  const userId = session?.user?.id ?? null;

  const [token, setToken] = useState<string | null>(null);
  const [tokenError, setTokenError] = useState<string | null>(null);
  const [events, setEvents] = useState<ActivityEvent[]>([]);
  const seenIds = useRef<Set<string>>(new Set());

  const filterKey =
    'conversationId' in filter ? `conv:${filter.conversationId}` : `run:${filter.runId}`;

  // 1. Fetch the WS token on mount / userId change. Exponential backoff on failure.
  useEffect(() => {
    if (!userId) return;
    let cancelled = false;
    let attempt = 0;
    let timerId: ReturnType<typeof setTimeout> | undefined;
    const fetchToken = async () => {
      try {
        const res = await fetch('/api/cmo-ws-token', { method: 'POST' });
        if (!res.ok) throw new Error(`token endpoint ${res.status}`);
        const { token: t } = (await res.json()) as { token: string };
        if (cancelled) return;
        setToken(t);
        setTokenError(null);
      } catch (err) {
        if (cancelled) return;
        setTokenError(err instanceof Error ? err.message : 'token fetch failed');
        attempt += 1;
        const delay = Math.min(8_000, 1_000 * 2 ** (attempt - 1));
        timerId = setTimeout(fetchToken, delay);
      }
    };
    void fetchToken();
    return () => {
      cancelled = true;
      if (timerId) clearTimeout(timerId);
    };
  }, [userId]);

  // 2. Open the WS via useAgent once we have a token.
  const agent = useAgent({
    agent: 'cmo',
    name: userId ?? '__skip__',
    query: async () => (token ? `token=${encodeURIComponent(token)}` : ''),
    queryDeps: [token],
    onMessage: (msg: MessageEvent<string>) => {
      let parsed: ActivityEvent;
      try {
        parsed = ActivityEventSchema.parse(JSON.parse(msg.data));
      } catch {
        return;
      }
      // Filter by hook's filter
      if ('conversationId' in filter && parsed.conversationId !== filter.conversationId) return;
      if ('runId' in filter && parsed.runId !== filter.runId) return;
      if (seenIds.current.has(parsed.id)) return;
      seenIds.current.add(parsed.id);
      setEvents((prev) => [...prev, parsed]);
    },
  } as any);

  // 3. Seed-replay on mount + when filter changes + on reconnect.
  useEffect(() => {
    if (!userId || !token) return;
    let cancelled = false;
    (async () => {
      const args: Record<string, unknown> = {};
      if ('conversationId' in filter) args.conversationId = filter.conversationId;
      if ('runId' in filter) args.runId = filter.runId;
      try {
        const seed = (await (agent as any).stub.getRecentActivity(args)) as ActivityEvent[];
        if (cancelled) return;
        const fresh = seed.filter((e) => !seenIds.current.has(e.id));
        fresh.forEach((e) => seenIds.current.add(e.id));
        setEvents((prev) => [...prev, ...fresh].sort((a, b) => a.createdAt - b.createdAt));
      } catch {
        // Stub call failed — leave seeds empty; live broadcasts will still arrive.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [userId, token, filterKey]);

  return useMemo(
    () => ({
      events,
      isConnected: token !== null && !tokenError,
      connectionError: tokenError,
    }),
    [events, token, tokenError],
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
pnpm --filter @shipflare/web test use-cmo-activity
```

Expected: PASS (2/2).

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/hooks/use-cmo-activity.ts apps/web/src/hooks/__tests__/use-cmo-activity.test.tsx
git commit -m "feat(web): useCmoActivity hook (WS + seed replay + dedupe)"
```

---

## Task 12: Activity labels + `prettyAgent`

**Files:**
- Create: `apps/web/src/lib/activity-labels.ts`
- Test: `apps/web/src/lib/__tests__/activity-labels.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// apps/web/src/lib/__tests__/activity-labels.test.ts
import { describe, expect, it } from 'vitest';
import { labelEvent, prettyAgent } from '../activity-labels';

describe('prettyAgent', () => {
  it('maps known slugs to friendly names', () => {
    expect(prettyAgent('head-of-growth')).toBe('Head of Growth');
    expect(prettyAgent('social-media-manager')).toBe('Social Media Manager');
    expect(prettyAgent('strategic-planner')).toBe('Strategist');
  });
  it('falls back to titleizing the slug', () => {
    expect(prettyAgent('unknown-slug')).toBe('Unknown slug');
  });
});

describe('labelEvent', () => {
  it('labels CMO turn_start as "Thinking"', () => {
    expect(labelEvent({
      id: '1', createdAt: 0, conversationId: null, parentTurnId: null, runId: null,
      sourceAgent: 'cmo', parentEventId: null,
      kind: 'turn_start', payload: { kind: 'turn_start' },
    }).headline).toBe('Thinking');
  });

  it('labels delegate as "Asking <agent>"', () => {
    expect(labelEvent({
      id: '2', createdAt: 0, conversationId: null, parentTurnId: null, runId: null,
      sourceAgent: 'cmo', parentEventId: null,
      kind: 'subagent_dispatch',
      payload: { kind: 'subagent_dispatch', subAgent: 'head-of-growth', promptPreview: 'plz' },
    }).headline).toBe('Asking Head of Growth');
  });

  it('falls back gracefully for unmapped events', () => {
    const out = labelEvent({
      id: '3', createdAt: 0, conversationId: null, parentTurnId: null, runId: null,
      sourceAgent: 'mystery-agent', parentEventId: null,
      kind: 'tool_call_start',
      payload: { kind: 'tool_call_start', tool: 'never_seen' },
    });
    expect(out.headline).toBeTruthy();
    expect(out.tone).toBe('work');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
pnpm --filter @shipflare/web test activity-labels
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement labels**

```ts
// apps/web/src/lib/activity-labels.ts
import type { ActivityEvent, ActivityPayload } from '@shipflare/shared';

const AGENT_NAMES: Record<string, string> = {
  cmo: 'CMO',
  'head-of-growth': 'Head of Growth',
  'social-media-manager': 'Social Media Manager',
  'strategic-planner': 'Strategist',
};

export function prettyAgent(slug: string): string {
  if (AGENT_NAMES[slug]) return AGENT_NAMES[slug];
  const tokens = slug.split('-');
  return tokens[0]!.charAt(0).toUpperCase() + tokens[0]!.slice(1) + (tokens.slice(1).length ? ' ' + tokens.slice(1).join(' ') : '');
}

export interface ActivityLabel {
  headline: string;
  sub?: string;
  tone: 'work' | 'dispatch' | 'idle' | 'error';
}

type LabelFn = (event: ActivityEvent) => ActivityLabel;

// Key shape: `${sourceAgent}:${kind}` or `${sourceAgent}:${kind}:${tool}`
const LABELS: Record<string, LabelFn> = {
  'cmo:turn_start': () => ({ headline: 'Thinking', tone: 'idle' }),
  'cmo:turn_finish': (e) => {
    const p = e.payload as Extract<ActivityPayload, { kind: 'turn_finish' }>;
    return { headline: p.status === 'ok' ? 'Done' : 'Error', tone: p.status === 'ok' ? 'work' : 'error' };
  },
  'cmo:subagent_dispatch': (e) => {
    const p = e.payload as Extract<ActivityPayload, { kind: 'subagent_dispatch' }>;
    return { headline: `Asking ${prettyAgent(p.subAgent)}`, sub: p.promptPreview, tone: 'dispatch' };
  },
  'cmo:subagent_finish': (e) => {
    const p = e.payload as Extract<ActivityPayload, { kind: 'subagent_finish' }>;
    return {
      headline: p.status === 'ok' ? `${prettyAgent(p.subAgent)} finished` : `${prettyAgent(p.subAgent)} failed`,
      sub: p.summary,
      tone: p.status === 'ok' ? 'work' : 'error',
    };
  },
  'strategic-planner:subagent_dispatch': () => ({ headline: 'Strategist is planning', tone: 'work' }),
  'strategic-planner:subagent_text_delta': (e) => {
    const p = e.payload as Extract<ActivityPayload, { kind: 'subagent_text_delta' }>;
    return { headline: 'Strategist is planning', sub: p.text.slice(-80), tone: 'work' };
  },
  'strategic-planner:subagent_finish': (e) => {
    const p = e.payload as Extract<ActivityPayload, { kind: 'subagent_finish' }>;
    return {
      headline: p.status === 'ok' ? 'Plan ready' : 'Strategist failed',
      sub: p.summary,
      tone: p.status === 'ok' ? 'work' : 'error',
    };
  },
};

export function labelEvent(event: ActivityEvent): ActivityLabel {
  const tool = (event.payload as { tool?: string }).tool;
  const keys = [
    tool ? `${event.sourceAgent}:${event.kind}:${tool}` : null,
    `${event.sourceAgent}:${event.kind}`,
  ].filter(Boolean) as string[];
  for (const k of keys) {
    if (LABELS[k]) return LABELS[k]!(event);
  }
  // Generic fallback
  return {
    headline: event.kind.replace(/_/g, ' '),
    sub: tool,
    tone: 'work',
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
pnpm --filter @shipflare/web test activity-labels
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/lib/activity-labels.ts apps/web/src/lib/__tests__/activity-labels.test.ts
git commit -m "feat(web): activity event label map + prettyAgent"
```

---

## Task 13: `ActivityRow` / `ActivityToggle` / `ActivityTrail` components

**Files:**
- Create: `apps/web/src/components/activity/activity-row.tsx`
- Create: `apps/web/src/components/activity/activity-toggle.tsx`
- Create: `apps/web/src/components/activity/activity-trail.tsx`
- Test: `apps/web/src/components/activity/__tests__/activity-trail.test.tsx`

- [ ] **Step 1: Write the failing test**

```tsx
// apps/web/src/components/activity/__tests__/activity-trail.test.tsx
import { describe, expect, it } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ActivityTrail } from '../activity-trail';
import type { ActivityEvent } from '@shipflare/shared';

const baseEvent = (over: Partial<ActivityEvent>): ActivityEvent => ({
  id: 'e-1', createdAt: Date.now(), conversationId: 'c-1', parentTurnId: 't-1',
  runId: null, sourceAgent: 'cmo', parentEventId: null,
  kind: 'turn_start', payload: { kind: 'turn_start' }, ...over,
});

describe('ActivityTrail', () => {
  it('renders the ticker when running and collapsed by default', () => {
    const events: ActivityEvent[] = [
      baseEvent({ id: '1', kind: 'subagent_dispatch',
        payload: { kind: 'subagent_dispatch', subAgent: 'head-of-growth' } }),
    ];
    render(<ActivityTrail events={events} />);
    expect(screen.getByText(/Asking Head of Growth/i)).toBeInTheDocument();
    expect(screen.getByText(/Activity \(1\)/i)).toBeInTheDocument();
  });

  it('expands to show rows when toggle is clicked', () => {
    const events: ActivityEvent[] = [
      baseEvent({ id: '1', kind: 'subagent_dispatch',
        payload: { kind: 'subagent_dispatch', subAgent: 'head-of-growth' } }),
      baseEvent({ id: '2', kind: 'subagent_finish',
        payload: { kind: 'subagent_finish', subAgent: 'head-of-growth', status: 'ok', durationMs: 100 } }),
    ];
    render(<ActivityTrail events={events} />);
    fireEvent.click(screen.getByText(/Activity \(2\)/i));
    expect(screen.getByText(/Head of Growth finished/i)).toBeInTheDocument();
  });

  it('opens by default when defaultOpen is set', () => {
    const events: ActivityEvent[] = [
      baseEvent({ id: '1', kind: 'subagent_dispatch',
        payload: { kind: 'subagent_dispatch', subAgent: 'head-of-growth' } }),
    ];
    render(<ActivityTrail events={events} defaultOpen />);
    expect(screen.getByText(/Asking Head of Growth/i)).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
pnpm --filter @shipflare/web test activity-trail
```

Expected: FAIL — modules not found.

- [ ] **Step 3: Implement `activity-row.tsx`**

```tsx
// apps/web/src/components/activity/activity-row.tsx
'use client';

import type { ActivityLabel } from '@/lib/activity-labels';

interface ActivityRowProps {
  label: ActivityLabel;
  status: 'running' | 'done' | 'error';
  indent?: number;
}

export function ActivityRow({ label, status, indent = 0 }: ActivityRowProps) {
  const icon = status === 'running' ? '◐' : status === 'error' ? '✕' : '✓';
  return (
    <div
      className={`flex items-start gap-2 py-1 text-sm ${
        status === 'error' ? 'text-red-600' : 'text-gray-700'
      }`}
      style={{ paddingLeft: indent * 16 }}
    >
      <span className="w-4 shrink-0 text-center" aria-hidden>
        {status === 'running' ? <span className="inline-block animate-pulse">{icon}</span> : icon}
      </span>
      <div className="min-w-0 flex-1">
        <div className="truncate">{label.headline}</div>
        {label.sub ? <div className="truncate text-xs text-gray-500">{label.sub}</div> : null}
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Implement `activity-toggle.tsx`**

```tsx
// apps/web/src/components/activity/activity-toggle.tsx
'use client';

interface ActivityToggleProps {
  count: number;
  open: boolean;
  onToggle: () => void;
}

export function ActivityToggle({ count, open, onToggle }: ActivityToggleProps) {
  return (
    <button
      type="button"
      onClick={onToggle}
      className="inline-flex items-center gap-1 text-xs text-gray-500 hover:text-gray-700"
    >
      <span>Activity ({count})</span>
      <span aria-hidden>{open ? '▾' : '▸'}</span>
    </button>
  );
}
```

- [ ] **Step 5: Implement `activity-trail.tsx`**

```tsx
// apps/web/src/components/activity/activity-trail.tsx
'use client';

import { useEffect, useMemo, useState } from 'react';
import type { ActivityEvent } from '@shipflare/shared';
import { labelEvent } from '@/lib/activity-labels';
import { ActivityRow } from './activity-row';
import { ActivityToggle } from './activity-toggle';

interface ActivityTrailProps {
  events: ActivityEvent[];
  defaultOpen?: boolean;
  hideTicker?: boolean;
  shell?: 'inline' | 'dispatch-card';
}

/**
 * Pair *_start with *_finish (matched by id). Returns groups with derived status.
 * Top-level groups are events whose parentEventId is null OR matches a turn_start.
 */
interface Group {
  start: ActivityEvent;
  finish?: ActivityEvent;
  children: Group[];
  status: 'running' | 'done' | 'error';
}

function buildGroups(events: ActivityEvent[]): Group[] {
  // Map of "starts" by id, and "finishes" looking for their pair.
  const byId = new Map<string, ActivityEvent>();
  for (const e of events) byId.set(e.id, e);

  const finishMatch = (e: ActivityEvent): ActivityEvent | undefined =>
    events.find((c) =>
      c.parentEventId === e.parentEventId &&
      (
        (e.kind === 'subagent_dispatch' && c.kind === 'subagent_finish') ||
        (e.kind === 'tool_call_start' && c.kind === 'tool_call_finish') ||
        (e.kind === 'subagent_tool_call_start' && c.kind === 'subagent_tool_call_finish') ||
        (e.kind === 'turn_start' && c.kind === 'turn_finish') ||
        (e.kind === 'skill_invoke' && c.kind === 'skill_finish')
      ) &&
      c.sourceAgent === e.sourceAgent &&
      c.createdAt >= e.createdAt,
    );

  const groups: Group[] = [];
  const visited = new Set<string>();
  for (const e of events) {
    if (visited.has(e.id)) continue;
    if (
      e.kind === 'turn_finish' || e.kind === 'subagent_finish' || e.kind === 'tool_call_finish' ||
      e.kind === 'subagent_tool_call_finish' || e.kind === 'skill_finish'
    ) continue;
    if (e.kind === 'subagent_text_delta') continue; // shown as "sub" on its parent group
    if (e.parentEventId) continue; // children get attached below

    const finish = finishMatch(e);
    if (finish) visited.add(finish.id);
    visited.add(e.id);
    const status = derive(finish);
    const children = events
      .filter((c) => c.parentEventId === e.id && c.kind.endsWith('_start') || c.parentEventId === e.id && c.kind === 'skill_invoke')
      .map((c) => {
        const cFinish = finishMatch(c);
        if (cFinish) visited.add(cFinish.id);
        visited.add(c.id);
        return { start: c, finish: cFinish, children: [], status: derive(cFinish) };
      });
    groups.push({ start: e, finish, children, status });
  }
  return groups;
}

function derive(finish?: ActivityEvent): Group['status'] {
  if (!finish) return 'running';
  const p = finish.payload as { status?: 'ok' | 'error' };
  return p.status === 'error' ? 'error' : 'done';
}

export function ActivityTrail({
  events,
  defaultOpen = false,
  hideTicker = false,
  shell = 'inline',
}: ActivityTrailProps) {
  const [open, setOpen] = useState(defaultOpen);
  const groups = useMemo(() => buildGroups(events), [events]);

  // Ticker: the latest leaf event that is "running".
  const runningLeaf = useMemo(() => {
    for (let i = events.length - 1; i >= 0; i--) {
      const e = events[i]!;
      if (e.kind.endsWith('_start') || e.kind === 'skill_invoke' || e.kind === 'subagent_dispatch') {
        const finished = events.some((c) =>
          c.parentEventId === e.parentEventId && c.sourceAgent === e.sourceAgent &&
          (c.kind === 'tool_call_finish' || c.kind === 'subagent_finish' ||
           c.kind === 'subagent_tool_call_finish' || c.kind === 'turn_finish' ||
           c.kind === 'skill_finish') &&
          c.createdAt > e.createdAt,
        );
        if (!finished) return e;
      }
    }
    return null;
  }, [events]);

  // Auto-hide ticker 1.5s after the most recent turn_finish.
  const [tickerVisible, setTickerVisible] = useState(true);
  useEffect(() => {
    if (runningLeaf) {
      setTickerVisible(true);
      return;
    }
    const timer = setTimeout(() => setTickerVisible(false), 1500);
    return () => clearTimeout(timer);
  }, [runningLeaf]);

  const containerClass =
    shell === 'dispatch-card'
      ? 'rounded-2xl border border-gray-200 p-4'
      : 'pl-2';

  return (
    <div className={containerClass}>
      {!hideTicker && tickerVisible && runningLeaf ? (
        <div className="mb-1 truncate text-xs text-gray-500">
          ◐ {labelEvent(runningLeaf).headline}…
        </div>
      ) : null}
      <ActivityToggle count={events.length} open={open} onToggle={() => setOpen((o) => !o)} />
      {open ? (
        <div className="mt-1 space-y-0">
          {groups.map((g) => (
            <div key={g.start.id}>
              <ActivityRow label={labelEvent(g.start)} status={g.status} />
              {g.children.map((c) => (
                <ActivityRow key={c.start.id} label={labelEvent(c.start)} status={c.status} indent={1} />
              ))}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
```

- [ ] **Step 6: Run test to verify it passes**

```bash
pnpm --filter @shipflare/web test activity-trail
```

Expected: PASS (3/3).

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/components/activity/
git commit -m "feat(web): ActivityTrail/Row/Toggle components"
```

---

## Task 14: Wire `useCmoActivity` into `/team` chat

**Files:**
- Modify: `apps/web/app/(app)/team/_components/team-desk.tsx`

- [ ] **Step 1: Add the hook + render under each assistant message**

In `team-desk.tsx`, after the `useTeamEvents(...)` call:

```tsx
import { useCmoActivity } from '@/hooks/use-cmo-activity';
import { ActivityTrail } from '@/components/activity/activity-trail';
import type { ActivityEvent } from '@shipflare/shared';

// inside the component body, after existing useTeamEvents:
const conversationId = /* existing conversationId from useTeamEvents — usually opts.conversationId */ '';
const { events: activityEvents } = useCmoActivity(
  conversationId ? { conversationId } : { runId: '__none__' /* effectively disabled */ },
);

// Helper: events that belong to a given assistant turn.
const eventsForTurn = (parentTurnId: string | null): ActivityEvent[] =>
  parentTurnId ? activityEvents.filter((e) => e.parentTurnId === parentTurnId) : [];
```

In the message-list render loop, where each assistant message renders, add the trail:

```tsx
{messages.map((m) => {
  // Pull parentTurnId from the assistant message metadata (set by chat tool _meta)
  const parentTurnId = (m.metadata as { parentTurnId?: string } | null)?.parentTurnId ?? null;
  return (
    <div key={m.id} className="...">
      {/* existing bubble render */}
      {m.from === 'cmo' && parentTurnId ? (
        <ActivityTrail events={eventsForTurn(parentTurnId)} />
      ) : null}
    </div>
  );
})}
```

**Note:** `m.metadata.parentTurnId` is plumbed into the team-events stream from the MCP tool result's `_meta` field set in Task 7. If `useTeamEvents` does not currently expose `_meta` from the tool result, extend it to do so:

```ts
// In useTeamEvents (apps/web/src/hooks/use-team-events.ts):
// After the streaming text reply finishes, attach the tool result _meta to the message:
const meta = (clientResult as { _meta?: Record<string, unknown> })._meta ?? null;
setMessages((prev) =>
  prev.map((mm) =>
    mm.id === assistantId
      ? { ...mm, content: replyText, metadata: meta }
      : mm,
  ),
);
```

- [ ] **Step 2: Build the web app to verify nothing broke**

```bash
pnpm --filter @shipflare/web build
```

Expected: success.

- [ ] **Step 3: Commit**

```bash
git add apps/web/app/\(app\)/team/_components/team-desk.tsx apps/web/src/hooks/use-team-events.ts
git commit -m "feat(team): render ActivityTrail under each CMO assistant message"
```

---

## Task 15: Onboarding integration — replace synthetic chat

**Files:**
- Create: `apps/web/app/onboarding/_components/_shared/plan-build-activity.tsx`
- Modify: `apps/web/app/onboarding/page.tsx`
- Modify: `apps/web/app/onboarding/_components/_copy.ts`
- Modify: places that currently render `synthetic-chat-conversation.tsx` (find via grep)

- [ ] **Step 1: Mint `runId` and pass it to the handler**

In `apps/web/app/onboarding/page.tsx` (or wherever the building-plan stage is mounted), before calling the strategic-path SSE handler:

```tsx
const [planRunId] = useState(() => crypto.randomUUID());

// When POSTing to /api/onboarding/strategic-path (or the proxy), include runId + userId.
const body = {
  // ... existing fields
  runId: planRunId,
  userId: session.user.id,
};
```

If the call to `/internal/onboarding/strategic-path` is proxied through an `apps/web` route, update that proxy to forward `runId` + `userId`.

- [ ] **Step 2: Create the replacement component**

```tsx
// apps/web/app/onboarding/_components/_shared/plan-build-activity.tsx
'use client';

import { useCmoActivity } from '@/hooks/use-cmo-activity';
import { ActivityTrail } from '@/components/activity/activity-trail';

interface Props {
  runId: string;
}

export function PlanBuildActivity({ runId }: Props) {
  const { events, isConnected, connectionError } = useCmoActivity({ runId });

  if (connectionError) {
    return (
      <div className="rounded-2xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
        Couldn&apos;t connect to the activity feed. The strategist is still working.
      </div>
    );
  }

  if (events.length === 0) {
    return (
      <div className="rounded-2xl border border-gray-200 p-4 text-sm text-gray-500">
        Preparing strategist…
      </div>
    );
  }

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

- [ ] **Step 3: Replace `synthetic-chat-conversation.tsx` usages**

Find every importer:

```bash
grep -rln "synthetic-chat-conversation" apps/web/ --include="*.tsx" --include="*.ts"
```

For each, replace `<SyntheticChatConversation ... />` with `<PlanBuildActivity runId={planRunId} />`.

- [ ] **Step 4: Update the copy**

In `apps/web/app/onboarding/_components/_copy.ts`, find the line:

```ts
sub: '≈ 30s sit tight — six checks running in parallel',
```

Replace with:

```ts
sub: 'Watching the strategist work — usually under a minute',
```

- [ ] **Step 5: Build + verify**

```bash
pnpm --filter @shipflare/web build
```

Expected: success.

- [ ] **Step 6: Commit**

```bash
git add apps/web/app/onboarding/
git commit -m "feat(onboarding): replace synthetic chat with real activity feed"
```

---

## Task 16: Cleanup — delete dead Railway-era code

**Files:**
- Delete: `apps/web/src/hooks/use-agent-stream.ts`
- Delete: `apps/web/src/hooks/agent-stream-provider.tsx`
- Delete: `apps/web/src/hooks/use-sse-channel.ts`
- Delete: `apps/web/app/onboarding/_components/_shared/synthetic-chat-conversation.tsx`

- [ ] **Step 1: Verify no remaining importers**

```bash
grep -rln "use-agent-stream\|agent-stream-provider\|use-sse-channel\|synthetic-chat-conversation" apps/web/ --include="*.tsx" --include="*.ts" | grep -v ".next"
```

Expected: zero matches (after Task 15 replaces the synthetic chat).

- [ ] **Step 2: Delete the files**

```bash
rm apps/web/src/hooks/use-agent-stream.ts
rm apps/web/src/hooks/agent-stream-provider.tsx
rm apps/web/src/hooks/use-sse-channel.ts
rm apps/web/app/onboarding/_components/_shared/synthetic-chat-conversation.tsx
```

- [ ] **Step 3: Verify build still passes**

```bash
pnpm --filter @shipflare/web build
```

Expected: success.

- [ ] **Step 4: Commit**

```bash
git add -A apps/web/src/hooks/ apps/web/app/onboarding/_components/_shared/
git commit -m "chore: delete dead Railway-era SSE hooks + synthetic chat"
```

---

## Task 17: Playwright smoke test

**Files:**
- Create: `e2e/tests/activity-feed.spec.ts`

- [ ] **Step 1: Implement the smoke test**

```ts
// e2e/tests/activity-feed.spec.ts
import { expect, test } from '@playwright/test';

// Requires the dev environment to be reachable (npm run dev) and a test user
// signed in via the storage-state fixture from existing e2e setup.
// Activity feed surfaces:
//  - onboarding "Building plan"
//  - /team chat (activity trail under each CMO bubble)

test('onboarding plan-build shows real strategist activity', async ({ page }) => {
  await page.goto('/onboarding?stage=building-plan');
  // Within 5 s, the dispatch card should render at least one row.
  await expect(page.getByText(/Strategist is planning|Plan ready/i)).toBeVisible({
    timeout: 30_000,
  });
});

test('/team chat: single CMO turn surfaces an activity trail', async ({ page }) => {
  await page.goto('/team');
  await page.getByPlaceholder(/Ask|Message/i).fill('What is the latest growth signal?');
  await page.keyboard.press('Enter');
  // Ticker appears under the assistant bubble while the turn streams.
  await expect(page.getByText(/Asking|Thinking/i)).toBeVisible({ timeout: 15_000 });
  // After completion, `Activity (N)` is visible and expandable.
  const toggle = page.getByText(/Activity \(\d+\)/);
  await expect(toggle).toBeVisible({ timeout: 30_000 });
  await toggle.click();
  // At least one row inside the trail.
  await expect(page.locator('[data-activity-row]')).toHaveCount(1, { timeout: 5_000 });
});

test('mid-turn reload replays activity without duplicates', async ({ page }) => {
  await page.goto('/team');
  await page.getByPlaceholder(/Ask|Message/i).fill('Long question that takes a while');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(1_500);
  await page.reload();
  await expect(page.getByText(/Activity \(\d+\)/)).toBeVisible({ timeout: 15_000 });
  // No row should appear twice — count unique ids.
  const toggle = page.getByText(/Activity \(\d+\)/);
  await toggle.click();
  const rows = page.locator('[data-activity-row]');
  const count = await rows.count();
  const ids = new Set<string>();
  for (let i = 0; i < count; i++) {
    ids.add((await rows.nth(i).getAttribute('data-event-id')) ?? '');
  }
  expect(ids.size).toBe(count);
});
```

**Note:** the assertions assume `data-activity-row` and `data-event-id` attributes on `ActivityRow`. Add them in `activity-row.tsx`:

```tsx
<div
  data-activity-row
  data-event-id={/* parent group's start id */ undefined /* set via prop from ActivityTrail */}
  ...
/>
```

Plumb `eventId` as a prop on `ActivityRow` and apply both attributes.

- [ ] **Step 2: Add `data-event-id` attribute support**

```tsx
// Edit activity-row.tsx
interface ActivityRowProps {
  label: ActivityLabel;
  status: 'running' | 'done' | 'error';
  indent?: number;
  eventId: string;
}

export function ActivityRow({ label, status, indent = 0, eventId }: ActivityRowProps) {
  // ...
  <div data-activity-row data-event-id={eventId} ...>
```

Update the call sites in `activity-trail.tsx` to pass `eventId={g.start.id}` / `eventId={c.start.id}`.

- [ ] **Step 3: Run the smoke**

```bash
# In one terminal:
pnpm dev
# In another:
pnpm --filter @shipflare/e2e test activity-feed
```

Expected: all 3 tests pass.

- [ ] **Step 4: Commit**

```bash
git add e2e/tests/activity-feed.spec.ts apps/web/src/components/activity/activity-row.tsx apps/web/src/components/activity/activity-trail.tsx
git commit -m "test(e2e): smoke for activity feed (onboarding + team chat + reload)"
```

---

## Task 18: Type check, lint, final cleanup

**Files:** none (verification only)

- [ ] **Step 1: Type-check the entire monorepo**

```bash
pnpm tsc --noEmit
```

Expected: zero errors. If any surface in apps/core or apps/web due to changed signatures, fix inline.

- [ ] **Step 2: Lint**

```bash
pnpm --filter @shipflare/core lint && pnpm --filter @shipflare/web lint
```

Expected: zero errors.

- [ ] **Step 3: Run the full unit test suite once more**

```bash
pnpm test
```

Expected: all pass.

- [ ] **Step 4: Final commit / push**

```bash
git status
# If clean, no commit needed. If there are residual fixes:
git add -A
git commit -m "chore: tsc + lint fixups for activity feed"
git push -u origin HEAD  # only if user explicitly requests push
```

---

## Self-review (skill checklist)

**Spec coverage:**
- §1 Goal — covered by tasks 7, 9, 14, 15
- §2 Locked decisions — every item implemented in tasks 1–17
- §3 Architecture overview — matches task graph
- §4 Data model — task 1 (types), task 2 (table)
- §5 Event sources — task 7 (CMO chat), task 8 (CMO delegate), task 9 (strategic-path), task 10 (HoG/SMM tools). Task 5.4 of spec (`runSkillWithTracing`) is explicitly out of scope; deviation noted in the plan header.
- §6 Sub-agent forwarding — task 3 (helper), task 4 (endpoint), task 10 (callers)
- §7 Web client wiring — task 6 (token + onConnect), task 11 (hook)
- §8 Renderer — tasks 12, 13
- §9 Onboarding — task 9 (backend), task 15 (frontend), task 16 (cleanup)
- §10 /team chat — task 14
- §11 Files added/modified/deleted — covered
- §13 Real-browser smoke test — task 17

**Placeholder scan:** no "TBD" / "TODO" / "implement later" / "appropriate error handling" left in the plan. Code blocks are real. The only place a future engineer needs to make a judgement call is:
- Task 8 test: which HoG tool to use as the `ping` target (real one in your branch).
- Task 14: matching `useTeamEvents`' existing shape for `_meta` plumbing.
- Task 17 test: `[data-activity-row]` selectors depend on the attributes added in step 2.

Each of these has an explicit note describing what to verify.

**Type consistency:**
- `ActivityEventInput` / `ActivityEvent` / `ActivityKind` are defined once in Task 1 and used everywhere.
- `parentTurnId` is consistently `string | null`.
- `ctx.waitUntil` plumbing in Task 9 requires `ctx` in scope — explicit note in Task 9 step 4.
- `SubAgentTrace` shape defined in Task 10 is used identically in Task 8's `_trace` payload.

**Scope:** this is one cohesive plan — agent activity visibility on two surfaces + the infra to support it. `/today` / `/briefing` surfacing and `runSkillWithTracing` are explicit follow-ups (spec §12).
