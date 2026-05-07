# /briefing & /today bug fixes — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix four lifecycle bugs in `/briefing` (formerly `/today`): skip-on-reply 404s, posts don't appear in History, old reply drafts don't age out, and a likely-derivative bug where edit-then-send-reply ends up in X Drafts.

**Architecture:** All four bugs share the same architectural root: the `/today` feed merges two data sources (`plan_items` and `drafts`) but several lifecycle paths only handle one side. f7ab610 fixed edit; this plan finishes the audit by giving skip a drafts fallback (Task 1), giving stale-sweeper drafts coverage (Task 2), giving history a plan_items branch (Task 3), and using post-deploy observation to confirm Task 2 also resolves the edit-then-send bug (Task 4).

**Tech Stack:** Next.js App Router (Route Handlers), Drizzle ORM (Postgres), Vitest, BullMQ workers.

---

## Background — root cause cheatsheet

| Bug | Root cause | File of truth |
|---|---|---|
| 3. Skip on reply → `not_found` | `skip` route only calls `findOwnedPlanItem`; no drafts fallback. id is a `drafts.id` for reply cards | `src/app/api/today/[id]/skip/route.ts:39-45` |
| 4. 2d+ old replies still in Today | `stale-sweeper` only marks `plan_items` stale; never sweeps `drafts` | `src/workers/processors/stale-sweeper.ts` (no drafts code at all) |
| 2. Sent posts not in History | History API only queries `drafts` (`status IN handed_off, posted`); never queries completed `plan_items` | `src/app/api/briefing/history/route.ts` (file's own comment: "v1 = replies only") |
| 1. Edit-then-send-reply → X Drafts | **Hypothesis** (Task 4): user is sending a >24h-old reply whose target tweet has been deleted/hidden, X compose silently drops to Drafts. Fixing Bug 4 (auto-skip drafts older than 24h) prevents the precondition | n/a |

---

## File Structure

**Modify (existing):**
- `src/app/api/today/[id]/skip/route.ts` — add drafts fallback (Task 1)
- `src/app/api/today/[id]/skip/__tests__/route.test.ts` — add drafts cases (Task 1)
- `src/workers/processors/stale-sweeper.ts` — add drafts sweep block (Task 2)
- `src/workers/processors/__tests__/stale-sweeper.test.ts` — add drafts cases (Task 2)
- `src/app/api/briefing/history/route.ts` — add plan_items query + projection (Task 3)
- `src/app/api/briefing/history/__tests__/route.test.ts` — add post-row case (Task 3)
- `docs/superpowers/notes/` — observation note from Task 4

**No new files / no schema migrations.** All four fixes operate on existing tables and existing route shapes.

---

## Task 1: Bug 3 — `skip` route drafts fallback

**Why first:** smallest blast radius; fix pattern is a 1:1 mirror of f7ab610's edit fix; user can immediately skip stale replies (which buys breathing room before Task 2 lands).

**Files:**
- Modify: `src/app/api/today/[id]/skip/route.ts`
- Test: `src/app/api/today/[id]/skip/__tests__/route.test.ts`

### Steps

- [ ] **Step 1: Write the failing tests for drafts fallback**

Add the following test cases to `src/app/api/today/[id]/skip/__tests__/route.test.ts` (append inside the existing `describe('PATCH /api/today/[id]/skip')` block).

You'll need to extend the test file's mock to capture `update(drafts)` calls. Mirror the pattern from `src/app/api/today/[id]/edit/__tests__/route.test.ts:30-65` (the `lastUpdate` capture + `db.select` lookup mock).

```ts
// At top of file, add alongside existing mocks:
const draftLookupMock = vi.fn();
const lastDraftUpdate: {
  table: string | null;
  set: Record<string, unknown> | null;
} = { table: null, set: null };

vi.mock('@/lib/db', () => ({
  db: {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: () => draftLookupMock(),
        }),
      }),
    }),
    update: (table: unknown) => ({
      set: (s: Record<string, unknown>) => ({
        where: () => {
          const id = (table as { __name?: string }).__name ?? 'unknown';
          lastDraftUpdate.table = id;
          lastDraftUpdate.set = s;
          return Promise.resolve();
        },
      }),
    }),
  },
}));

vi.mock('@/lib/db/schema', () => ({
  drafts: { __name: 'drafts' },
}));

// Reset in beforeEach:
beforeEach(() => {
  authUserId = 'user-1';
  findMock.mockReset();
  writeMock.mockReset();
  draftLookupMock.mockReset();
  lastDraftUpdate.table = null;
  lastDraftUpdate.set = null;
});
```

Then add the test cases:

```ts
it('skips a pending reply draft when id is a drafts.id', async () => {
  findMock.mockResolvedValueOnce(null); // not a plan_item
  draftLookupMock.mockResolvedValueOnce([
    { id: '11111111-1111-1111-1111-111111111111', userId: 'user-1', status: 'pending' },
  ]);
  const { PATCH } = await import('../route');
  const res = await PATCH(makeReq(), {
    params: Promise.resolve({ id: '11111111-1111-1111-1111-111111111111' }),
  });
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body).toEqual({ success: true, source: 'draft' });
  expect(lastDraftUpdate.table).toBe('drafts');
  expect(lastDraftUpdate.set).toMatchObject({ status: 'skipped' });
});

it('returns 409 not_skippable when draft is past pending', async () => {
  findMock.mockResolvedValueOnce(null);
  draftLookupMock.mockResolvedValueOnce([
    { id: '11111111-1111-1111-1111-111111111111', userId: 'user-1', status: 'handed_off' },
  ]);
  const { PATCH } = await import('../route');
  const res = await PATCH(makeReq(), {
    params: Promise.resolve({ id: '11111111-1111-1111-1111-111111111111' }),
  });
  expect(res.status).toBe(409);
  const body = await res.json();
  expect(body).toMatchObject({ error: 'not_skippable', status: 'handed_off' });
  expect(lastDraftUpdate.table).toBeNull();
});

it('returns 404 when neither table owns the id', async () => {
  findMock.mockResolvedValueOnce(null);
  draftLookupMock.mockResolvedValueOnce([]);
  const { PATCH } = await import('../route');
  const res = await PATCH(makeReq(), {
    params: Promise.resolve({ id: '11111111-1111-1111-1111-111111111111' }),
  });
  expect(res.status).toBe(404);
  expect(lastDraftUpdate.table).toBeNull();
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run src/app/api/today/\[id\]/skip/__tests__/route.test.ts`

Expected: 3 new tests fail. The first test fails with status 404 (current behavior — `findOwnedPlanItem` returns null, skip route returns 404). The second test fails with 404 (same reason). The third test passes incidentally (current 404 matches).

If all three pass, the test file's mock isn't matching the actual code path — recheck the `db` mock binding.

- [ ] **Step 3: Implement the drafts fallback in `skip/route.ts`**

Replace the body of `PATCH` at `src/app/api/today/[id]/skip/route.ts:39-55` with:

```ts
import { NextResponse, type NextRequest } from 'next/server';
import { and, eq } from 'drizzle-orm';
import { auth } from '@/lib/auth';
import {
  findOwnedPlanItem,
  paramsSchema,
  writePlanItemState,
} from '@/app/api/plan-item/[id]/_helpers';
import { createLogger, loggerForRequest } from '@/lib/logger';
import { db } from '@/lib/db';
import { drafts } from '@/lib/db/schema';

const baseLog = createLogger('api:today:skip');

// State sets used for the skip gate. Listed inline so they read at the
// call site without a hop into shared state-machine config — same shape
// as the edit route's gate (see src/app/api/today/[id]/edit/route.ts).
const SKIPPABLE_DRAFT_STATUSES = new Set(['pending']);

/**
 * PATCH /api/today/:id/skip
 *
 * Skips a plan_item or a reply draft. The Today feed merges two data
 * sources; `:id` may resolve to either, so the handler tries plan_items
 * first (calendar / post cards), then falls back to the drafts table
 * (reply cards from the discovery feed).
 *
 *   plan_item path: SM transitions to `skipped` (terminal). The SM
 *     blocks skips from terminal / executing states with 409.
 *   drafts path:    only `status='pending'` is skippable. Anything past
 *     pending (approved, handed_off, posted, ...) is rejected with 409.
 *
 * Status codes:
 *   200  success
 *   400  invalid_id
 *   401  unauthorized
 *   404  not_found
 *   409  invalid_transition / not_skippable
 */
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { log, traceId } = loggerForRequest(baseLog, request);

  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const userId = session.user.id;

  const { id: rawId } = await params;
  const parsed = paramsSchema.safeParse({ id: rawId });
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'invalid_id' },
      { status: 400, headers: { 'x-trace-id': traceId } },
    );
  }
  const id = parsed.data.id;

  // Plan-item path first — calendar / post cards land here.
  const planRow = await findOwnedPlanItem(id, userId);
  if (planRow) {
    const rejection = await writePlanItemState(planRow, 'skipped');
    if (rejection) return rejection;
    log.info(`plan_item ${planRow.id} skipped via /today`);
    return NextResponse.json(
      { success: true, source: 'plan_item' },
      { headers: { 'x-trace-id': traceId } },
    );
  }

  // Drafts path — reply cards. Scope by userId so we don't leak ownership.
  const draftRows = await db
    .select({
      id: drafts.id,
      userId: drafts.userId,
      status: drafts.status,
    })
    .from(drafts)
    .where(and(eq(drafts.id, id), eq(drafts.userId, userId)))
    .limit(1);

  const draft = draftRows[0];
  if (!draft) {
    return NextResponse.json(
      { error: 'not_found' },
      { status: 404, headers: { 'x-trace-id': traceId } },
    );
  }
  if (!SKIPPABLE_DRAFT_STATUSES.has(draft.status)) {
    return NextResponse.json(
      { error: 'not_skippable', status: draft.status },
      { status: 409, headers: { 'x-trace-id': traceId } },
    );
  }

  await db
    .update(drafts)
    .set({ status: 'skipped', updatedAt: new Date() })
    .where(eq(drafts.id, draft.id));
  log.info(`draft ${draft.id} skipped via /today`);
  return NextResponse.json(
    { success: true, source: 'draft' },
    { headers: { 'x-trace-id': traceId } },
  );
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run src/app/api/today/\[id\]/skip/__tests__/route.test.ts`

Expected: ALL tests pass (existing plan_item tests + 3 new drafts tests).

- [ ] **Step 5: Commit**

```bash
git add src/app/api/today/\[id\]/skip/route.ts src/app/api/today/\[id\]/skip/__tests__/route.test.ts
git commit -m "fix(today/skip): add drafts fallback so reply cards can be skipped

Reply cards in the Today feed key off drafts.id, but PATCH /api/today/:id/skip
only consulted plan_items and 404'd on every reply skip click. Mirror the
edit route's f7ab610 fallback — try plan_items, then drafts (gated on
status='pending'), and update drafts.status='skipped' otherwise."
```

---

## Task 2: Bug 4 — `stale-sweeper` drafts coverage

**Why second:** auto-skips 24h+ old reply drafts so they leave the feed; this is also the suspected root cause of Bug 1 (sending an old draft against a now-deleted target tweet causes X compose to drop to X Drafts). Closes the lifecycle hole that allowed Bug 1 to manifest.

**Files:**
- Modify: `src/workers/processors/stale-sweeper.ts`
- Test: `src/workers/processors/__tests__/stale-sweeper.test.ts`

### Steps

- [ ] **Step 1: Inspect the existing test file**

Run: `head -80 src/workers/processors/__tests__/stale-sweeper.test.ts`

Read the existing test setup. Mirror its mocking style (db update mock, time-cutoff helper) for the drafts cases.

- [ ] **Step 2: Write the failing tests for drafts sweep**

Append to `src/workers/processors/__tests__/stale-sweeper.test.ts`:

```ts
describe('stale-sweeper drafts branch', () => {
  it('marks drafts.status="skipped" when status="pending" AND createdAt < cutoff', async () => {
    // Use the test file's existing db mock to capture the second update call
    // (drafts; the first two are plan_items planned and approved). Assert:
    //   - update target was the `drafts` table (not planItems)
    //   - .set() included { status: 'skipped' }
    //   - .where() bound (status='pending') AND (createdAt < cutoff)
    //
    // The exact assertion shape depends on the existing mock; prefer
    // capturing into a per-update record array and asserting the
    // drafts entry by index.
  });

  it('does NOT touch drafts past pending (approved / handed_off / posted)', async () => {
    // Same test harness; populate drafts mock rows with mixed statuses
    // and assert the WHERE clause filtered them out. Verify the
    // returned `markedDrafts` count.
  });

  it('emits a per-user pipeline event with draftsMarked count', async () => {
    // After the sweep, verify recordPipelineEventsBulk was called with
    // metadata.draftsMarked included (alongside plannedMarked and
    // approvedMarked).
  });
});
```

The test code above intentionally describes assertions in comments rather than full code because the existing mock shape is implementation-specific — read the file first, then write asserts that fit. If the existing tests already capture per-table updates, reuse that pattern. If not, extend the mock.

- [ ] **Step 3: Run tests to verify they fail**

Run: `pnpm vitest run src/workers/processors/__tests__/stale-sweeper.test.ts`

Expected: 3 new tests fail (drafts sweep doesn't exist yet).

- [ ] **Step 4: Implement the drafts sweep block**

Modify `src/workers/processors/stale-sweeper.ts`. Add `drafts` to the schema import and add a third UPDATE block + extend the per-user counter.

```ts
// Top of file — extend the schema import
import { drafts, planItems } from '@/lib/db/schema';

// Add to constants section
/**
 * How long after `createdAt` a pending reply draft can sit before we
 * mark it `skipped`. Same 24h window as plan_items; mirrors the rule
 * that a draft the founder ignored through a full day is no longer
 * actionable. Replies older than this are at risk of replying to a
 * deleted/hidden target tweet — X compose silently drops those to X
 * Drafts, which is what the founder reported as "edit-then-send-reply
 * becomes drafts not reply".
 */
const DRAFTS_STALE_AFTER_HOURS = 24;
```

Inside `processStaleSweeper`, AFTER the existing `markedApproved` UPDATE block (after line 56) and BEFORE the `perUser` aggregation, add:

```ts
const draftsCutoff = new Date(Date.now() - DRAFTS_STALE_AFTER_HOURS * 60 * 60 * 1000);
const markedDrafts = await db
  .update(drafts)
  .set({ status: 'skipped', updatedAt: sql`now()` })
  .where(
    and(
      eq(drafts.status, 'pending'),
      lt(drafts.createdAt, draftsCutoff),
    ),
  )
  .returning({ id: drafts.id, userId: drafts.userId });
```

Then extend the `perUser` Map shape and accumulator:

```ts
// Replace the existing perUser block:
const perUser = new Map<string, { planned: number; approved: number; drafts: number }>();
for (const r of markedPlanned) {
  const cur = perUser.get(r.userId) ?? { planned: 0, approved: 0, drafts: 0 };
  cur.planned++;
  perUser.set(r.userId, cur);
}
for (const r of markedApproved) {
  const cur = perUser.get(r.userId) ?? { planned: 0, approved: 0, drafts: 0 };
  cur.approved++;
  perUser.set(r.userId, cur);
}
for (const r of markedDrafts) {
  const cur = perUser.get(r.userId) ?? { planned: 0, approved: 0, drafts: 0 };
  cur.drafts++;
  perUser.set(r.userId, cur);
}

if (perUser.size > 0) {
  await recordPipelineEventsBulk(
    [...perUser.entries()].map(([userId, counts]) => ({
      userId,
      stage: 'sweeper_run',
      metadata: {
        sweeper: 'stale',
        plannedMarked: counts.planned,
        approvedMarked: counts.approved,
        draftsMarked: counts.drafts,
      },
    })),
  );
}

jlog.info(
  `staleness sweep: marked ${markedPlanned.length} planned + ${markedApproved.length} approved + ${markedDrafts.length} drafts as stale across ${perUser.size} users (cutoffs plan=${cutoff.toISOString()} drafts=${draftsCutoff.toISOString()})`,
);
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm vitest run src/workers/processors/__tests__/stale-sweeper.test.ts`

Expected: ALL tests pass (existing plan_items tests + 3 new drafts tests).

- [ ] **Step 6: Run typecheck to confirm no compile drift**

Run: `pnpm tsc --noEmit --pretty false`

Expected: no errors. (The plan_state.md memory note flags that vitest's isolatedModules can mask type errors — the tsc pass is the real gate.)

- [ ] **Step 7: Commit**

```bash
git add src/workers/processors/stale-sweeper.ts src/workers/processors/__tests__/stale-sweeper.test.ts
git commit -m "fix(stale-sweeper): age out pending reply drafts older than 24h

The sweeper marked stale plan_items but never touched the drafts table,
so reply drafts from prior days kept showing on Today (briefing) forever
even when the target tweet was already gone. Mirror the 24h plan_items
window for drafts: UPDATE drafts SET status='skipped' WHERE status='pending'
AND createdAt < now() - interval '24 hours'.

Per-user pipeline events now include draftsMarked alongside plannedMarked
and approvedMarked.

Suspected co-fix for the edit-then-send-reply -> X Drafts bug: founders
sending replies against >24h-old drafts hit a deleted/hidden target,
which X compose silently rerouted to X's own Drafts folder."
```

---

## Task 3: Bug 2 — History API: surface completed posts

**Why third:** larger change (touches API shape), and the user can already see replies in History; missing posts is a feature gap, not a regression.

**Files:**
- Modify: `src/app/api/briefing/history/route.ts`
- Test: `src/app/api/briefing/history/__tests__/route.test.ts`

### Steps

- [ ] **Step 1: Inspect the existing history test**

Run: `cat src/app/api/briefing/history/__tests__/route.test.ts | head -60`

Note the mock shape; you'll mirror it for the plan_items query.

- [ ] **Step 2: Write the failing test for plan_items branch**

Append to `src/app/api/briefing/history/__tests__/route.test.ts`:

```ts
it('includes completed content_post plan_items in the history feed', async () => {
  // Mock GET to return one drafts row (handed_off) and one plan_items
  // row (state='completed', kind='content_post', completedAt=2h ago,
  // output={draft_body: 'shipped today: ...'}).
  //
  // Assert the response items[] has length 2; one with draftType='reply'
  // (status='handed_off') and one with draftType='original_post'
  // (status='posted'), and the post item's draftBody equals the
  // plan_item's output.draft_body.
  //
  // Assert ordering: newest first by completedAt for posts and
  // updatedAt for drafts.
});

it('does not include in-flight or stale plan_items', async () => {
  // Mock plan_items rows with state='approved' AND state='stale'; both
  // must be filtered out. Only state='completed' surfaces.
});
```

(Match the existing test file's mock shape — same pattern as Task 1's "read first, then write asserts that fit".)

- [ ] **Step 3: Run tests to verify they fail**

Run: `pnpm vitest run src/app/api/briefing/history/__tests__/route.test.ts`

Expected: 2 new tests fail (current route ignores plan_items entirely).

- [ ] **Step 4: Extend `route.ts` with a plan_items query + projection**

Modify `src/app/api/briefing/history/route.ts`. Update the file's leading comment to reflect both data sources:

```ts
// Briefing → History tab. Surfaces (a) reply drafts the founder has
// already acted on within the trailing window, AND (b) completed
// content_post plan_items in the same window. Both project into the
// same BriefingHistoryItem shape so <ReplyCard /> can render either
// without branching on the data source.
```

Add the imports:

```ts
import { drafts, planItems, threads, activityEvents } from '@/lib/db/schema';
import { isNotNull } from 'drizzle-orm';
```

After the existing `rows` query (drafts + threads), add the plan_items query inside the same handler:

```ts
const planRows = await db
  .select({
    id: planItems.id,
    output: planItems.output,
    title: planItems.title,
    channel: planItems.channel,
    completedAt: planItems.completedAt,
    createdAt: planItems.createdAt,
  })
  .from(planItems)
  .where(
    and(
      eq(planItems.userId, userId),
      eq(planItems.state, 'completed'),
      eq(planItems.kind, 'content_post'),
      isNotNull(planItems.completedAt),
      gte(planItems.completedAt, since),
    ),
  )
  .orderBy(desc(planItems.completedAt));

// Fetch externalUrl from activity_events (post_published) keyed by
// planItemId. Best-effort — the inline post path writes this; the
// queue worker also writes this. Posts that pre-date the activity_events
// instrumentation won't have a URL, in which case xIntentUrl/externalUrl
// stay null and the History card body still renders.
const planItemIds = planRows.map((r) => r.id);
const eventRows = planItemIds.length === 0
  ? []
  : await db
      .select({
        planItemId: sql<string>`(${activityEvents.metadataJson} ->> 'planItemId')`,
        externalUrl: sql<string>`(${activityEvents.metadataJson} ->> 'externalUrl')`,
      })
      .from(activityEvents)
      .where(
        and(
          eq(activityEvents.userId, userId),
          eq(activityEvents.eventType, 'post_published'),
        ),
      );
const externalUrlByPlanItem = new Map<string, string>();
for (const ev of eventRows) {
  if (ev.planItemId && ev.externalUrl) externalUrlByPlanItem.set(ev.planItemId, ev.externalUrl);
}
```

Add the projection function (alongside the existing draft projection):

```ts
function readDraftBody(output: unknown): string | null {
  if (output === null || typeof output !== 'object') return null;
  const value = (output as Record<string, unknown>).draft_body;
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function projectPlanItem(
  row: typeof planRows[number],
  externalUrl: string | null,
): BriefingHistoryItem {
  const completedAt = row.completedAt ?? row.createdAt;
  const body = readDraftBody(row.output);
  return {
    id: row.id,
    draftId: row.id, // reuse plan_item.id as the card id; settled cards don't dispatch back to drafts
    todoType: 'reply_thread', // type is structural; UI branches on draftType below
    source: 'discovery',
    priority: 'time_sensitive',
    status: 'posted',
    planState: null,
    xIntentUrl: null, // already posted; no compose handoff
    title: row.title,
    platform: row.channel ?? 'x',
    community: null,
    externalUrl,
    confidence: null,
    scheduledFor: null,
    expiresAt: completedAt.toISOString(),
    createdAt: completedAt.toISOString(),
    draftBody: body,
    draftConfidence: null,
    draftWhyItWorks: null,
    draftType: 'original_post',
    draftPostTitle: null,
    draftMedia: null,
    threadTitle: null,
    threadBody: null,
    threadAuthor: null,
    threadUrl: null,
    threadUpvotes: null,
    threadCommentCount: null,
    threadPostedAt: null,
    threadDiscoveredAt: null,
    threadLikesCount: null,
    threadRepostsCount: null,
    threadRepliesCount: null,
    threadViewsCount: null,
    threadIsRepost: false,
    threadOriginalUrl: null,
    threadOriginalAuthorUsername: null,
    threadSurfacedVia: null,
    calendarContentType: null,
    calendarScheduledAt: null,
  };
}
```

Then in the response build, merge both sources sorted by `completedAt`/`updatedAt` desc:

```ts
const replyItems = rows.map(/* existing draft projection */);
const postItems = planRows.map((row) =>
  projectPlanItem(row, externalUrlByPlanItem.get(row.id) ?? null),
);

const items: BriefingHistoryItem[] = [...replyItems, ...postItems].sort(
  (a, b) => Date.parse(b.expiresAt) - Date.parse(a.expiresAt),
);

return NextResponse.json({ items, windowDays: HISTORY_WINDOW_DAYS });
```

(If the existing route shape uses different variable names, adapt — the projection + merge structure is the load-bearing change.)

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm vitest run src/app/api/briefing/history/__tests__/route.test.ts`

Expected: ALL tests pass.

- [ ] **Step 6: Run typecheck**

Run: `pnpm tsc --noEmit --pretty false`

Expected: no errors.

- [ ] **Step 7: Manual smoke (browser)**

Start dev server: `pnpm dev`

In a browser logged in as a user with at least one completed content_post plan_item (state='completed', completedAt within 7 days), navigate to `/briefing/history`. Expected: the post appears in the list with body text rendered. If no completed plan_items exist, run a manual flow: trigger a content_post plan_item, mark it completed, then refresh.

- [ ] **Step 8: Commit**

```bash
git add src/app/api/briefing/history/route.ts src/app/api/briefing/history/__tests__/route.test.ts
git commit -m "feat(briefing/history): surface completed content_post plan_items

History API was query-drafts-only by design (file comment: 'v1 = replies
only, posts are a follow-up'). Founders reporting 'posts I sent never
show up in history' — this lands the follow-up.

Adds a parallel plan_items query (state='completed' AND
kind='content_post' AND completedAt >= since) and projects the rows into
the same BriefingHistoryItem shape that <ReplyCard /> already renders.
externalUrl is best-effort from activity_events.metadataJson.

The two streams merge into one items[] sorted by completedAt/updatedAt
desc."
```

---

## Task 4: Bug 1 — observation gate

**Why fourth:** Bug 1 is the most ambiguous of the four. The leading hypothesis (Task 2 captures it: stale drafts → deleted target → X Drafts auto-save) gets resolved by Task 2. After Task 2 deploys, observe whether Bug 1 still occurs. If it does, we triage with the user using the A/B/C taxonomy (X compose pre-fills with old text vs in_reply_to lost vs ShipFlare card stuck on Today).

**Files:**
- Create: `docs/superpowers/notes/2026-05-06-bug1-observation.md`

This task ships nothing in code. It's an explicit gate so we don't accidentally claim Bug 1 is fixed without verification.

### Steps

- [ ] **Step 1: Create the observation note**

Create `docs/superpowers/notes/2026-05-06-bug1-observation.md`:

```markdown
# Bug 1 — edit-then-send-reply → X Drafts: observation gate

**Status as of 2026-05-06:** Tasks 1-3 of `2026-05-06-briefing-today-bugfixes.md`
are merged. Bug 1's leading hypothesis is that the precondition (a
>24h-old draft against a deleted/hidden target tweet) was created by
Bug 4 (no draft staleness sweep). Task 2's drafts sweep removes that
precondition.

## Observation window

After Task 2 deploys, monitor for one full week (next Monday → following
Monday). Specifically:

- Watch the `worker:stale-sweeper` logs each hour: confirm `draftsMarked`
  count is non-zero on at least one run.
- Ask the user (or check session logs) whether they've seen the bug
  recur. The bug is high-visibility for them — they reported it
  immediately when it happened.

## Triage decision tree (if Bug 1 recurs)

Ask the user which of these matches:

- **Symptom A:** "X compose opens with the OLD text I edited away from"
  - Root cause: `handleSaveEdit` in `src/app/(app)/today/_components/reply-card.tsx:258`
    is fire-and-forget — doesn't await the PATCH /edit. The user's
    next click on Send reply opens an stale `xIntentUrl` baked from
    pre-edit body.
  - Fix: `await onEdit(...)` in `handleSaveEdit`, or disable the Send
    button while the edit is in flight.

- **Symptom B:** "X compose has the new text but the tweet on X.com is
  a standalone post, not threaded under the parent"
  - Root cause: `in_reply_to` query param missing from xIntentUrl. Check
    `threadExternalId` post-edit and `URL.toString()` length.
  - Fix: investigate `buildXIntentUrl` for length truncation; verify
    `threads.externalId` not nulled by edit.

- **Symptom C:** "X tweet went out fine, but ShipFlare keeps showing the
  card on Today; never moves to History"
  - Root cause: SWR race between edit's `mutate()` (revalidate) and
    handoff's optimistic 'handed_off' update + delayed PATCH /approve.
  - Fix: in `src/hooks/use-today.ts:edit`, await the PATCH AND skip
    revalidate (mutate(undefined, { revalidate: false }) + manual
    bumpVersion). Or: fold edit into the handoff flow so they share
    one revalidation.

If the user reports any of A/B/C, open a focused PR for that symptom
only. Do not bundle.
```

- [ ] **Step 2: Commit the observation note**

```bash
git add docs/superpowers/notes/2026-05-06-bug1-observation.md
git commit -m "docs: bug-1 observation gate after stale-sweeper fix

Bug 1's leading hypothesis is that fixing Bug 4 (drafts staleness)
removes the precondition for the X-Drafts-instead-of-reply symptom.
This note captures the observation window + the A/B/C triage tree to
use if the bug recurs after Task 2 deploys."
```

---

## Self-review

**Spec coverage:** All 4 bugs addressed, plus a follow-up gate for Bug 1. ✓

**Placeholder scan:**
- Task 2 Step 2 and Task 3 Step 2 use comment-style test bodies because the existing test mocks shape is not safe to inline without reading the file first. The instruction explicitly says "read first, then write asserts that fit" — this is a deliberate constraint, not a placeholder. ✓
- All other steps have full code or full commands. ✓

**Type consistency:** `BriefingHistoryItem` is the existing exported type from `src/app/api/briefing/history/route.ts`. The Task 3 projection function returns that exact shape. ✓

**Rationale:**
- Task ordering 3→4→2→1 (in plan: Tasks 1, 2, 3, 4): smallest blast radius first; lifecycle root before history; observation gate last.
- No schema migration: drafts.status='skipped' already exists in `draftStatusEnum`.
- No new files except the observation note in Task 4.

---

## Out of scope

- Reschedule and undo route stubs (`src/app/api/today/[id]/{reschedule,undo}/route.ts:410`) — separate work.
- Adding `'stale'` enum value to `draftStatusEnum` — re-using `'skipped'` is semantically close enough; if UX needs a separation later, it's a follow-up migration.
- Cleanup of dead `code-snapshot-section.tsx` UI orphan flagged in the milestone spec.
- The other bugs implied by the same architectural hole (e.g., reschedule/undo for replies) — fix when those endpoints are de-stubbed.
