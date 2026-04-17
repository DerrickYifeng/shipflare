# Plan + Reply Journey Redesign — Per-Item Fan-Out

**Status:** Design v2 (approved 2026-04-17 by @yifeng)
**Author:** 5-role team dispatch (PM, Data, Backend, Frontend, QA) + synthesis
**Implements:** next-step → `/writing-plans`

---

## 0. Problem

Two pipelines drive ShipFlare's core journey, and both feel slow and flaky after clicking **Generate Week**:

- **Pipeline P (Plan + original posts).** `POST /api/calendar/generate` → BullMQ `calendar-plan` → monolithic `calendar-planner` skill (one LLM call for 7 weekly slots with bodies) → monolithic `content-batch` skill (one LLM call drafting all due items). Observed TTFP ≈ 15–30s, TTFD ≈ 35–75s. Today `calendar-plan.ts:224-230` *also* enqueues `enqueueMonitor(...)`, coupling plan to reply-search.
- **Pipeline R (Reply to others' posts) — the search-based flow.** `discovery.ts` runs the `discovery` skill, which internally fans out across sources (subreddits, X queries) inside one `runSkill` call, scores threads, and per-thread enqueues `content.ts` for high-relevance candidates. Same anti-pattern — a single monolithic skill run with nothing visible to the user until it returns. (Target-account polling `monitor.ts` is **out of scope** for this redesign; it keeps its independent cadence.)

The shared anti-pattern: **one big LLM call for N items, emit all events at end.** Failure is all-or-nothing, no progress is visible, and the UI stares at a spinner.

## 1. Decision (approved)

Apply one primitive fix to both pipelines: **replace batched LLM calls with per-item BullMQ fan-out jobs.** Plus two structural changes:

- **Decouple reply search from Generate Week.** Remove `enqueueMonitor` (and any reply-search enqueue) from `calendar-plan.ts`. Reply scan has its own trigger.
- **Option B shell for Pipeline P**: planner returns `{dayOffset, hour, contentType, topic}` per slot — time + type + **topic**, no body. N per-slot `calendar-slot-draft` jobs then generate the body in parallel.
- **Per-source BullMQ fan-out for Pipeline R** (decision `Qb=x`): a new `search-source` queue replaces the skill-internal fan-out in `discovery.ts`. Each source = one BullMQ job. Score gate stays at the existing `discoveryConfigs.enqueueThreshold` (default 0.7) — no new gate schema. Per-source jobs directly enqueue `content.ts` for above-gate threads; `threads` table is the merge point (unique index dedupes across concurrent sources).
- **Unified per-item state:** `queued | drafting | ready | failed` on both `xContentCalendar` (plan slots) and `threads` (reply candidates). Per-source mini-state: `queued | searching | searched | failed`.
- **Unified SSE envelope:** `{ pipeline, itemId, state, data?, seq? }` — `'plan' | 'reply' | 'discovery'`. Rides `publishUserEvent(userId, 'agents' | 'drafts', …)` as `type: 'pipeline'`. Old event types (`calendar_plan_complete`, `calendar_draft_created`, etc.) are **deleted** — not dual-published.
- **Bounded concurrency** (4 for plan slots, 4-6 for search-source, 3 for content), **30s per-job timeout**, BullMQ `attempts` + exponential backoff, DLQ on exhaustion, per-item retry UI.

### Cross-role summary

| Layer | Change | Outcome |
|---|---|---|
| PM (§1) | State machine + copy; metrics TTFP≤6s / TTFD≤15s / TTFS≤10s / TTFT≤30s; hybrid (cron + button) reply-scan trigger on Today | Journey feels fast, recoverable, and the reply loop is legible |
| Data (§2) | `state` enum reused on `xContentCalendar` + **`threads`**; new `search-source` queue; unified `PipelineEvent` type; no changes to `x_monitored_tweets` or `user_preferences` | Per-item state persistable and queryable |
| Backend (§3) | Trim `calendar-planner` to shell; retire `content-batch`; `discovery.ts` becomes an orchestrator; new `search-source.ts` processor + `discovery-single-source` skill; delete `enqueueMonitor` from calendar-plan | Real parallelism, per-item retry, failure isolation |
| Frontend (§4) | `useProgressiveStream` hook, skeleton→hydrate cards, `<ReplyScanHeader>` on `/today`, per-source chips, pipeline health pills | SSE events become first-class UI state |
| QA (§5) | Playwright happy + decoupling-regression + partial-degradation; BullMQ integration; TTFP/TTFD/TTFS/TTFT CI gate; two-flow cost guard | No regression in perf, $, or silent failures |

### Non-goals (frozen)

Out of scope: `monitor.ts` (target-account polling keeps its independent cron), `posting.ts`, engagement processor, review worker contract, `/api/today` query shape, `todoItems` schema, `drafts`/`threads` columns beyond the state additions, `channels` token handling, `activityEvents`, cron fan-out pattern, dream/memory, `unified-calendar.tsx` undo-delete UX. **Engagement (reply-to-comments-on-my-own-posts) is not in this redesign** — user explicitly descoped.

---

<!-- PM SECTION -->

## 1. Product — Journey & Success Criteria

### 1.1 Journey narratives

**(a) Plan flow — "Generate Week"**

User lands on `UnifiedCalendar` (`src/components/calendar/unified-calendar.tsx`) with an empty 14-day grid and clicks **Generate Week**. `handleGenerate` POSTs to `/api/calendar/generate`, which enqueues one `calendar-plan` job and returns `202 queued` within ~200 ms. The grid immediately renders **7 skeleton cards** (state `queued`, shimmer, "Planning your week…").

At **t≈5–7s**, the *shell* pass of `processCalendarPlan` emits SSE `{pipeline:'plan', itemId, state:'queued', data:{scheduledAt, contentType, topic}}` per slot. Every skeleton is replaced with a **hydrated card**: timestamp, content-type badge (via `typeColors`), and the planner's one-line topic. TTFP drops from 15–30s to ≤6s p95.

Per-slot fan-out jobs then drive body generation. Each emits `{state:'drafting'}` then `{state:'ready', data:{draftId}}`, flipping cards to the `draft_created` variant with Review CTAs. Users can open any `ready` card while others are still `drafting`.

Once every slot is `ready` (or `failed`), the `todo-seed` job (2-min delay, unchanged) seeds `todoItems` onto the Today page. `posting.ts` is untouched. **Generate Week no longer enqueues reply-search work** — `calendar-plan.ts` lines 224–230 (`enqueueMonitor`) are removed.

**(b) Reply flow — search-origin (discovery-based)**

The reply flow is driven by `discovery.ts` → `content.ts`, independently of Generate Week. User triggers a scan (see §1.7). The API enqueues a **fan-out** on the new `search-source` queue: one job per source pulled from `discoveryConfigs` / `PLATFORMS[id].defaultSources` (e.g. `r/SaaS`, `r/indiehackers`, `x:"pricing feedback"`). Each source job runs in parallel and emits SSE along its own mini-lifecycle:

- `{pipeline:'discovery', itemId:'reddit:r/SaaS', state:'searching'}` when the job starts scoring.
- `{pipeline:'discovery', itemId:'reddit:r/SaaS', state:'searched', data:{found:N, aboveGate:K}}` when results are persisted. `K` = threads above `discoveryConfigs.enqueueThreshold` (default 0.7, already enforced at `discovery.ts:190`).

For each above-gate thread, the source job **directly enqueues** `content.ts` with `draftType:'reply'`. The per-thread job emits `{pipeline:'reply', itemId:threadId, state:'drafting'}` then `{state:'ready', data:{draftId}}`. A `time_sensitive` `todoItem` (4h TTL, matching current behavior) lands on Today via the existing `reply-thread` todoType.

### 1.2 Per-item state machine

Plan slots and reply threads share the same four states, stored on `xContentCalendar` and `threads`:

```
  [queued] ──► [drafting] ──► [ready]
     │              │
     │              └──► [failed] ──retry──┐
     └───────────────────► [failed] ───────┘
```

Per-source mini-state (exposed in the scan-progress UI):

```
  [queued] ──► [searching] ──► [searched]
                   │
                   └──► [failed]
```

### 1.3 Empty / loading / failure / recovery copy

- **Zero sources configured**: essentially impossible — onboarding seeds `PLATFORMS[id].defaultSources`. Fallback: "Add at least one subreddit or X query in Settings → Discovery."
- **All sources returned 0 above-gate threads**: "We scanned N sources and found nothing worth replying to right now. Try lowering your relevance threshold." → CTA opens the Reply Sensitivity slider. Show the 24h scored count next to the slider.
- **Partial degradation (e.g. 3 of 5 sources failed)**: inline banner `"We couldn't scan 3 of 5 sources — showing results from the ones that worked."` + **Retry failed sources** button.
- **Worker down mid-plan** (shell succeeds, fan-out stalls >60s): calendar-page banner `"Drafts are taking longer than usual. We'll keep trying — safe to close this tab."`
- **One plan slot fails out of 7**: card shows `[Draft failed — retry]`. No global banner.
- **All plan slots fail**: global error card with `Retry all` / `Edit plan`. Shell state preserved.

### 1.4 Success metrics

| Metric | Target |
|---|---|
| **TTFP** (click → first hydrated plan card) | ≤6s p95 |
| **TTFD** (click → first `ready` plan draft) | ≤15s p95 |
| **TTFS** (scan click → first `source_searched`) | ≤10s p95 |
| **TTFT** (scan click → first `thread_ready` draft) | ≤30s p95 |
| Plan slot completion within 2min | ≥95% |
| Source jobs completing within 60s | ≥80% |
| Silent failures (item stuck, no UI) | <3% |
| Reply-gate precision | ≥70% of above-threshold drafts approved/edited-approved |
| Reply-gate recall proxy | <10% of approved replies come from "show all scored threads" view |

### 1.5 Guardrails / non-goals

This redesign **does not** touch `monitor.ts` (target-account polling retains its independent cron), `posting.ts`, the engagement processor, `enqueueReview` contract, `/api/today` query, `todoItems` schema, `drafts` / `threads` columns beyond the state additions, `channels` token handling, `activityEvents`, content-calendar cron fan-out, dream/memory, or the undo-delete UX. It **explicitly decouples** search-reply from Generate Week — `calendar-plan.ts` no longer calls `enqueueMonitor` or any reply-search enqueue.

### 1.6 Open product questions

1. Single reply-gate slider vs split relevance/intent gates?
2. Shell-hydrated slot with terminal body failure — keep as writing prompt or remove?
3. `failed` slots/threads: auto-retry on page re-open, or explicit user action?
4. Should `source_searched` events include a "top 3 thread titles" preview to make progress feel alive, or is `found:N, aboveGate:K` enough?

### 1.7 Trigger design for decoupled reply search — **Hybrid (recommendation)**

**Options weighed.**
- **(i) Pure cron**: invisible to new users — an empty Today with no signal that replies will appear. Bad onboarding.
- **(iii) Cron-only at existing cadence**: same problem plus couples cost to user count regardless of engagement.
- **(ii) Button-only**: reliable but replies are time-sensitive — forgotten click = missed window.
- **(iv) Hybrid**: cron baseline for freshness + button for agency + onboarding legibility.

**Pick: (iv) Hybrid.**

- **Cron baseline**: every 4h per active user (activity = opened the app in the last 7 days — `users.lastActiveAt`). 4h matches the `time_sensitive` todoItem 4h TTL, so threads never expire before being surfaced. Inactive users drop to 24h to control cost. Mechanism: BullMQ repeatable job at the `search-source` queue, gated on `lastActiveAt`.
- **Button**: **"Scan for replies"** on the **Today page** header, next to the date chip. Not on calendar — Generate Week is about *proactive* posts; reply scan is about *reactive* engagement and belongs with Today. Secondary text: `"Last scan: 38m ago · 2 new threads."` Clicking enqueues the same `search-source` fan-out as cron and opens an inline source-progress panel.
- **Onboarding**: first-run Today shows an empty state with the Scan button front-and-center: *"We'll check your sources every few hours — or scan now to see what's out there."*
- **Rate-limit**: button debounced 2 min/user server-side; mash attempts shake + toast.
- **Tier variation (future)**: free = manual + 24h cron; paid = manual + 4h cron. Not day-one; design accommodates via the `lastActiveAt` gate.

---

<!-- DATA SECTION -->

## 2. Data — Schema, State, and Event Contract

### 2.1 Schema changes — migration `0018_generate_week_fanout.sql`

One Drizzle migration. No backfill — product is pre-launch, no prod rows to preserve.

#### 2.1.1 `x_content_calendar` — per-slot item state

```ts
// src/lib/db/schema/x-growth.ts
export const xContentCalendarItemStateEnum = pgEnum('x_content_calendar_item_state', [
  'queued', 'drafting', 'ready', 'failed',
]);

xContentCalendar: {
  // existing: status (scheduled|draft_created|approved|posted|skipped) — post-lifecycle
  state:         xContentCalendarItemStateEnum('state').notNull().default('queued'),
  failureReason: text('failure_reason'),
  retryCount:    integer('retry_count').notNull().default(0),
  lastAttemptAt: timestamp('last_attempt_at', { mode: 'date' }),
}
```

`status` and `state` are orthogonal axes: `state` tracks generation fan-out; `status` tracks approval / posting lifecycle.

#### 2.1.2 `threads` — per-thread generation state

Pipeline R is discovery-based, so state lives on `threads` (`src/lib/db/schema/channels.ts:37`), not on monitor rows. Reusing the same enum.

```ts
// src/lib/db/schema/channels.ts
threads: {
  // existing: id, userId, externalId, platform, community, title, url, relevanceScore, discoveredAt, …
  state:         xContentCalendarItemStateEnum('state').notNull().default('queued'),
  failureReason: text('failure_reason'),
  retryCount:    integer('retry_count').notNull().default(0),
  lastAttemptAt: timestamp('last_attempt_at', { mode: 'date' }),
  sourceJobId:   text('source_job_id'),   // search-source BullMQ jobId that produced this row
}
```

No backfill — product is pre-launch.

#### 2.1.3 Score gate — no schema change

`discoveryConfigs.enqueueThreshold` (`src/lib/db/schema/discovery-configs.ts:43`, default `0.7`, `NOT NULL`) governs "should this thread flow to content drafting." `discovery.ts:190` reads it with `?? 0.7` fallback. No new gate column — the reply sensitivity slider writes to this existing knob.

#### 2.1.4 Indexes

```sql
-- Calendar (Pipeline P) — keep v1:
CREATE INDEX xcc_user_state_scheduled_idx
  ON x_content_calendar (user_id, state, scheduled_at);
CREATE INDEX xcc_state_last_attempt_idx
  ON x_content_calendar (state, last_attempt_at)
  WHERE state IN ('drafting','failed');

-- Threads (Pipeline R):
CREATE INDEX threads_user_state_idx
  ON threads (user_id, state);                 -- Today page + DLQ sweeps
CREATE INDEX threads_state_last_attempt_idx
  ON threads (state, last_attempt_at)
  WHERE state IN ('drafting','failed');        -- fan-out driver + stalled-row sweep
CREATE INDEX threads_source_job_idx
  ON threads (source_job_id);                  -- per-source progress rollups
```

The existing `threads_user_platform_external_uq` unique index stays — it's what lets `discovery.ts:230` use `onConflictDoNothing` for cross-run idempotency.

### 2.2 BullMQ queue topology

New queues extend the discriminated union in `src/lib/queue/types.ts`:

```ts
export const calendarSlotDraftJobSchema = z.object({
  kind: z.literal('user').optional(),
  schemaVersion: SCHEMA_VERSION,
  traceId: TRACE_ID,
  userId: z.string().min(1),
  productId: z.string().min(1),
  calendarItemId: z.string().min(1),   // idempotency key
  channel: z.string().min(1),
});
export type CalendarSlotDraftJobData = z.input<typeof calendarSlotDraftJobSchema>;

export const searchSourceJobSchema = z.object({
  kind: z.literal('user').optional(),
  schemaVersion: SCHEMA_VERSION,
  traceId: TRACE_ID,
  userId: z.string().min(1),
  productId: z.string().min(1),
  platform: z.string().min(1),         // 'reddit' | 'x'
  source: z.string().min(1),           // 'r/SaaS' | 'x:"pricing alternative"'
  scanRunId: z.string().min(1),        // groups all per-source jobs of one scan
});
export type SearchSourceJobData = z.input<typeof searchSourceJobSchema>;
```

Retention (both queues): `removeOnComplete: { count: 500, age: 24h }`, `removeOnFail: { count: 1000, age: 7d }`, `attempts: 3`, `backoff: { type: 'exponential', delay: 5000 }`.

### 2.3 Unified SSE event contract

Three pipeline values: `'plan' | 'reply' | 'discovery'`. `discovery` carries per-source events; `reply` carries per-thread draft events. A single `reply` value with a `subStage` discriminator would conflate two progress bars the UI renders separately.

```ts
// src/lib/pipeline-events.ts
export type PipelineEvent = {
  pipeline: 'plan' | 'reply' | 'discovery';
  itemId: string;              // calendarItemId | threadId | '{platform}:{source}'
  state: 'queued' | 'drafting' | 'ready' | 'failed' | 'searching' | 'searched';
  data?: { topic?: string; previewBody?: string; reason?: string; score?: number; source?: string; found?: number; aboveGate?: number };
};
```

Channel reuse: `discovery` → `(userId, 'agents')` (matches `discovery.ts:308-314`); `reply` → `(userId, 'drafts')` (matches `content.ts:193-199`); `plan` → `(userId, 'agents')`. Hook multiplexes client-side.

### 2.4 `pipeline_events` stages

`stage` is plain `text`; new values need no migration. Extend the TS union:

```ts
export type PipelineStage =
  | 'discovered' | 'gate_passed' | 'draft_created' | 'reviewed'
  | 'approved' | 'posted' | 'engaged' | 'failed'
  // P: calendar fan-out
  | 'plan_shell_ready' | 'slot_drafting' | 'slot_ready' | 'slot_failed'
  // R: per-source fan-out
  | 'scan_started' | 'source_queued' | 'source_searching' | 'source_searched' | 'source_failed'
  // R: per-thread drafting (complements existing 'draft_created')
  | 'thread_drafting' | 'thread_ready' | 'thread_failed';
```

### 2.5 Data integrity and cleanup

**Idempotency keys** (BullMQ `jobId`):
- `calendar-slot-draft`: `'cslot-' + calendarItemId`
- `search-source`: `'ssrc-' + scanRunId + '-' + platform + '-' + sha1(source).slice(0,10)` — same source in same scan-run dedupes; re-clicked scan mints new `scanRunId` → fresh job
- Per-thread content dedupes via `threads_user_platform_external_uq` + `onConflictDoNothing` — no queue-level jobId needed

**Cleanup.** Threads are **durable historical records — never deleted on re-scan.** Concurrent `search-source` jobs collide on the unique index and no-op. Pipeline P is different: Generate-Week re-click deletes unstarted slot rows via:

```ts
.where(and(
  eq(xContentCalendar.userId, userId),
  inArray(xContentCalendar.state, ['queued', 'drafting', 'failed']),
  gte(xContentCalendar.scheduledAt, new Date()),
))
```

Stalled `threads.state='drafting'` rows older than 10 min are swept to `failed` by a cron tick using the partial index. No queue sweep needed — late-arriving source jobs re-insert or no-op.

---

<!-- BACKEND SECTION -->

## 3. Backend — Worker Architecture

### 3.1 Pipeline P (Plan) — Sequence

```
User click "Generate Week"
  │
  ▼
POST /api/calendar/generate
  │  enqueueCalendarPlan({userId, productId, channel, startDate, traceId})
  │  jobId: calendar-plan-${userId} (dedup)
  ▼
calendar-plan worker  (concurrency:1, 1 job per user)
  │  [SHELL PHASE ~5-7s]
  │  load product + followerSnapshot + metrics + analyticsSummary + prefs + memory
  │  runSkill(calendar-planner SHELL)  ───► 1 LLM call, returns {phase, weeklyStrategy,
  │                                          entries:[{dayOffset,hour,contentType,topic}×7]}
  │  DELETE future queued|drafting|failed xContentCalendar rows (re-generate idempotency)
  │  INSERT xContentCalendar rows with state='queued', draftId=NULL
  │  publishUserEvent('plan_shell_ready', {calendarItemIds, phase, weeklyStrategy})
  │
  │  [FAN-OUT]  for each calendarItem:
  │     enqueueCalendarSlotDraft({userId, productId, calendarItemId, traceId})
  ▼
calendar-slot-draft worker  (NEW, concurrency:4)
```

**Removal:** `src/workers/processors/calendar-plan.ts:224-230` currently calls `enqueueMonitor(...)`. **Delete this block.** Generate Week no longer triggers any reply-search work — reply scan has its own trigger (§1.7). Decoupling: failures or slowness in one pipeline cannot drag the other down; a user who only wants replies does not pay for a calendar shell. `calendar-plan.ts` drops to ~225 lines.

### 3.2 Pipeline R (Reply) — Sequence

```
Trigger: cron (4h per active user) | user clicks "Scan for replies" | post-onboarding
  │  enqueueDiscoveryScan({userId, productId, platform, scanRunId, traceId})
  ▼
discovery-scan ORCHESTRATOR  (concurrency:2 — per-user, lightweight)
  │  load product + discoveryConfigs + getPlatformConfig(platform).defaultSources
  │  publishUserEvent('scan_started', {scanRunId, sources, expectedCount})
  │  for each source:
  │     enqueueSearchSource({userId, productId, platform, source, scanRunId, traceId})
  │  (NO runSkill, NO bulk insert, NO content enqueue here)
  ▼
search-source WORKER  (NEW, concurrency:4-6 — queue-level fan-out)
  │  1 BullMQ job per source
  │  runSkill(discovery-single-source)  ───► 1 LLM call, 1 source scored
  │  INSERT threads … ON CONFLICT DO NOTHING  (unique index merges)
  │  for each above-gate newly-inserted thread:
  │     enqueueContent({userId, threadId, productId, traceId, draftType:'reply'})
  │  publishUserEvent('source_searched', {source, platform, found, gated, costUsd})
  ▼
content WORKER  (EXISTING, per-thread — already per-item fan-out)
  │  transition threads.state: 'queued' → 'drafting' → 'ready' | 'failed'
  │  runSkill(content-gen) → drafts insert (unchanged)
  │  publishUserEvent('thread_ready', {threadId, draftId})
  │  on skill failure: state='failed', publishUserEvent('thread_failed')
```

Threads table is the merge point. Concurrent `search-source` jobs can discover the same post without racing — `threads.onConflictDoNothing({target: [userId, platform, externalId]})` drops duplicates atomically; only the winning insert's `returning()` row enqueues to content.

### 3.3 New worker specs

**`src/workers/processors/calendar-slot-draft.ts`**

```ts
export async function processCalendarSlotDraft(job: Job<CalendarSlotDraftJobData>) {
  const { userId, productId, calendarItemId } = job.data;
  const traceId = getTraceId(job.data, job.id);

  const [item] = await db.select().from(xContentCalendar)
    .where(eq(xContentCalendar.id, calendarItemId)).limit(1);
  if (!item) throw new ValidationError(`calendarItem ${calendarItemId} gone`); // → DLQ
  if (item.state === 'ready' && item.draftId) return;                          // idempotent

  const [product] = await db.select().from(products).where(eq(products.id, productId));
  const recentPostHistory = await loadRecentPosts(userId, 'x');
  const memoryPrompt = await buildMemoryPrompt(new MemoryStore(userId, productId));

  const res = await runSkill<SlotBodyOutput>({
    skill: slotBodySkill,
    input: { contentType: item.contentType, topic: item.topic,
             product, recentPostHistory, isThread: item.contentType === 'thread' },
    memoryPrompt, outputSchema: slotBodyOutputSchema, runId: traceId,
  });
  if (res.errors.length || !res.results[0]?.tweets?.length) {
    await db.update(xContentCalendar).set({ state: 'failed' })
      .where(eq(xContentCalendar.id, calendarItemId));
    return;
  }

  const draft = await writeThreadAndDraft(userId, item, res.results[0]);
  await db.update(xContentCalendar).set({ state: 'ready', draftId: draft.id })
    .where(eq(xContentCalendar.id, calendarItemId));
  await publishUserEvent(userId, 'agents', { type: 'slot_ready', calendarItemId, draftId: draft.id });
  await enqueueReview({ userId, draftId: draft.id, productId, traceId });
}
```

**`src/workers/processors/search-source.ts`**

```ts
export async function processSearchSource(job: Job<SearchSourceJobData>) {
  const { userId, productId, platform, source, scanRunId } = job.data;
  const traceId = getTraceId(job.data, job.id);

  const [product] = await db.select().from(products).where(eq(products.id, productId)).limit(1);
  if (!product) throw new ValidationError(`product ${productId} gone`); // → DLQ

  const [userConfig] = await db.select().from(discoveryConfigs)
    .where(and(eq(discoveryConfigs.userId, userId), eq(discoveryConfigs.platform, platform))).limit(1);
  const deps = await createPlatformDeps(platform, userId);
  const memoryPrompt = await buildMemoryPrompt(new MemoryStore(userId, productId));

  const res = await runSkill<DiscoveryOutput>({
    skill: singleSourceDiscoverySkill,
    input: buildSingleSourceInput(product, userConfig, source, platform),
    deps, memoryPrompt, outputSchema: discoveryOutputSchema, runId: traceId,
  });

  const gate = userConfig?.enqueueThreshold ?? 0.7;
  const candidates = mapThreadsToRows(res.results, userId, platform, gate);
  const inserted = await db.insert(threads).values(candidates.rows)
    .onConflictDoNothing({ target: [threads.userId, threads.platform, threads.externalId] })
    .returning({ id: threads.id, externalId: threads.externalId });

  for (const row of inserted) {
    if (!candidates.shouldEnqueue.has(row.externalId)) continue;
    await enqueueContent({ userId, threadId: row.id, productId, traceId, draftType: 'reply' });
  }
  await publishUserEvent(userId, 'agents', {
    type: 'source_searched', scanRunId, source, platform,
    found: candidates.rows.length, gated: inserted.length, costUsd: res.usage.costUsd,
  });
}
```

**Failure modes** (both processors):
- Transient (LLM 429, upstream 5xx, network) → throw → BullMQ `attempts:3` exponential backoff → DLQ on exhaustion
- `ValidationError` (row/product gone) → `job.discard()` → DLQ after attempt 1
- Skill returned empty/invalid → mark row `state='failed'`, emit failure SSE, return (no retry). `search-source` treats zero-threads as success with `found:0`, not an error.

### 3.4 Trim `discovery.ts` (340 → ~90 lines)

- **Keep**: fan-out branch (lines 39-86) unchanged — cron tick still iterates users.
- **Replace**: per-user branch (lines 88-339). New body loads `product` + `platform-config.defaultSources`, publishes `scan_started`, enqueues one `search-source` job per source, done. No skill run, no bulk insert, no activity event here — all move to per-source.

### 3.5 Skill changes

- **`calendar-planner`** — trim output schema to `{phase, phaseDescription, weeklyStrategy, entries:[{dayOffset, hour, contentType, topic}]}`. Drop body generation. `maxOutputTokens` 64000 → 4000.
- **Delete `src/skills/content-batch/`.** Replaced by `src/skills/slot-body/` — single-item input (queue is the fan-out primitive), inherits `references/x-content-guide.md` via `shared-references`.
- **Discovery skill — CONSOLIDATE to single primitive.** Delete `src/skills/discovery/` (multi-source). Single-source becomes the primitive: `src/skills/discovery/` is rewritten to accept one `source` input. No sibling, no duplication. Callers that previously relied on skill-internal multi-source fan-out are refactored to loop over sources at the processor layer:
  - **`src/workers/processors/calibrate-discovery.ts`** (~lines 26, 449) — the optimize loop iterates sources serially (deterministic for scoring comparison) calling the single-source skill once per source; aggregate results in-processor before feeding to the optimizer.
  - **`src/core/pipelines/full-scan.ts`** (lines 177, 190, 207) — onboarding fans out sources via `Promise.all` (all-sources-needed-before-next-step semantics is preserved). No BullMQ fan-out here — onboarding is a single synchronous pipeline and the existing per-source LLM calls are fine in-process.
  - **`src/scripts/discovery-eval.ts`**, **`src/scripts/test-x-discovery.ts`** — trivial loop refactor.
  - The agent prompt at `src/agents/discovery.md` is trimmed to single-source framing (no "here are N sources" header). Shared references (`reddit-search-guide.md`, etc.) unchanged.
  - One source of truth, one prompt, one test matrix. Any scoring fix benefits all three callers (war-room scan, calibration, onboarding).
- Monitor stays out of scope — no new reply-specific skills. Reply drafts go through the existing `content-gen` skill with `draftType:'reply'`.

### 3.6 Concurrency & rate limits

| Queue | Concurrency | Timeout | Rationale |
|---|---|---|---|
| `calendar-plan` | 1 | 30s | One shell per user, jobId-dedup |
| `calendar-slot-draft` (NEW) | 4 | 30s | ~7 slots/user, Anthropic TPM headroom |
| `discovery` (orchestrator) | 2 | 10s | Lightweight fan-out, no LLM |
| `search-source` (NEW) | 4-6 | 30s | Per-source LLM+search, per-platform budget |
| `content` | 3 (unchanged) | — | Per-thread draft gen |
| `monitor` | 2 (unchanged) | 120s | **Out of scope** this redesign |

### 3.7 Rate limits

Reddit unauth search ~10 req/min/IP; X Basic 180 req/15min/user. With ~6 sources/user/scan, concurrency:4 yields wall-clock ~45s (2 rounds × 30s). **Mitigation:** Redis token-bucket keyed `rate:${platform}:${userId}` — Reddit 1/6s burst 3, X 1/5s burst 5 — acquired **inside the tool** (`reddit_search`, `x_search`), not the processor. Keeps rate-limit logic platform-local per CLAUDE.md. Bucket backpressure blocks the skill, not the queue.

### 3.8 Deployment

Pre-launch, no gradual rollout needed. Ship as one coherent PR (or a small stack of dependent PRs, one per layer) and replace the old paths outright.

Deployment sequence:

1. **Schema migration** `0018_generate_week_fanout` — `state` enums, `failure_reason`, `retry_count`, `last_attempt_at`, `source_job_id`. No backfill.
2. **Skills layer** — rewrite `src/skills/discovery/` as single-source (delete multi-source); delete `src/skills/content-batch/`; add `src/skills/slot-body/`.
3. **Queue + workers** — register `calendar-slot-draft` and `search-source` queues; wire `src/workers/index.ts`.
4. **Processors** — land new `calendar-slot-draft.ts` and `search-source.ts`; trim `calendar-plan.ts` (delete `enqueueMonitor` call); trim `discovery.ts` to orchestrator; update `content.ts` to transition `threads.state` and emit the unified envelope.
5. **Caller refactors** — `calibrate-discovery.ts` + `full-scan.ts` + scripts loop over sources calling the single-source skill.
6. **API + frontend** — `POST /api/discovery/scan`, `POST /api/discovery/retry-source`, `GET /api/discovery/scan-status`; ship `<ReplyScanHeader>`, `<SourceProgressRail>`, `<ReplyRail>`, `<WeekGrid>`, `<PipelineHealthPill>`, `useProgressiveStream`.

No feature flags. Tests gate merge.

### 3.9 Observability

`pipeline_events.stage` gains: `plan_shell_ready`, `slot_drafting`, `slot_ready`, `slot_failed`, `scan_started`, `source_searched`, `source_failed`, `thread_drafting`, `thread_ready`, `thread_failed`. All carry `traceId`, `scanRunId` (where applicable), `userId`.

**TTFS p95** (`scan_started` → first `source_searched`):

```sql
WITH spans AS (
  SELECT trace_id,
    MIN(entered_at) FILTER (WHERE stage='scan_started')    AS t0,
    MIN(entered_at) FILTER (WHERE stage='source_searched') AS t1
  FROM pipeline_events WHERE entered_at > NOW() - INTERVAL '24 hours'
  GROUP BY trace_id)
SELECT percentile_cont(0.95) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (t1-t0)))
FROM spans WHERE t1 IS NOT NULL;
```

TTFD for Pipeline R — swap `source_searched` for `thread_ready`. Targets: TTFS <10s, TTFT <45s.

### 3.10 File size note

- `discovery.ts` 340 → **~90** (orchestrator only)
- `search-source.ts` NEW → **~160**
- `content.ts` 211 → **~230** (state transitions + unified SSE)
- `calendar-plan.ts` 252 → **~225** (monitor removal)
- `calendar-slot-draft.ts` NEW → **~180**
- `calibrate-discovery.ts` current ~470 → **~495** (adds per-source loop + aggregator; watch 800-line ceiling — ample headroom)
- `full-scan.ts` current ~260 → **~285** (Promise.all over sources)
- `src/skills/discovery/` — one consolidated primitive; multi-source variant deleted
- `queue/index.ts` 406 → ~475
- `workers/index.ts` 283 → ~310

All well under the 800-line guideline.

---

<!-- FRONTEND SECTION -->

## 4. Frontend — Progressive UI

### 4.1 Component architecture

```
AgentStreamProvider (existing, /src/hooks/agent-stream-provider.tsx)
  │  — consumes unified { pipeline, itemId, state } envelope
  │  — exposes plan + reply + discovery maps via context (no new EventSource)
  │
  ├── /src/app/(app)/calendar/page.tsx
  │     └── <UnifiedCalendar/>                    ← [MODIFIED]
  │           ├── <PipelineHealthPill/>           ← [NEW]
  │           ├── <WeekGrid/>                     ← [NEW]
  │           │     └── <CalendarItemCard/>       ← [MODIFIED] live per-item state
  │           │           └── <SlotStatusBadge/>  ← [NEW]
  │           └── <GenerateWeekButton/>           ← [MODIFIED — no reply trigger]
  │
  └── /src/app/(app)/today/today-content.tsx
        └── <TodoList/>                           ← [MODIFIED wrapper]
              ├── <ReplyScanHeader/>              ← [NEW] "Scan for replies" + status
              ├── <SourceProgressRail/>           ← [NEW]
              │     └── <SourceChip/>             ← [NEW] queued/searching/searched/failed
              ├── <ReplyRail/>                    ← [NEW] above-gate threads stream in
              │     └── <ReplyCard/>              ← reuses /src/components/today/reply-card.tsx
              └── <OriginalTodoItems/>            ← existing grouped TodoCard list unchanged
```

`reply-card.tsx` is reused verbatim. `<TodoList>`'s priority grouping stays.

### 4.2 `useProgressiveStream`

```ts
// /src/hooks/use-progressive-stream.ts
export type Pipeline = 'plan' | 'reply' | 'discovery';
export type ItemState =
  | 'queued' | 'searching' | 'searched'          // discovery only
  | 'drafting' | 'ready'                         // plan + reply
  | 'failed';                                    // all pipelines
export interface StreamEnvelope<T = unknown> {
  pipeline: Pipeline;
  itemId: string;                                // discovery: '{platform}:{source}'
  state: ItemState;
  data?: T;
  seq?: number;
}
export function useProgressiveStream<T>(pipeline: Pipeline) {
  const [map, setMap] = useState<Map<string, ItemSnapshot<T>>>(() => new Map());
  useSSEChannel('agents', (raw) => {
    const e = raw as StreamEnvelope<T>;
    if (e.pipeline !== pipeline || !e.itemId) return;
    setMap((prev) => {
      const curr = prev.get(e.itemId);
      if (curr && e.seq != null && curr.updatedAt >= e.seq) return prev;
      const next = new Map(prev);
      next.set(e.itemId, { state: e.state, data: e.data, updatedAt: e.seq ?? Date.now() });
      return next;
    });
  });
  const reset = useCallback((itemId: string) =>
    setMap((p) => { const n = new Map(p); n.set(itemId, { state: 'queued', updatedAt: Date.now() }); return n; }), []);
  return { items: map, reset };
}
```

Collision-free `itemId` is critical: `'r/SaaS'` isn't unique across platforms, `'reddit:r/SaaS'` vs `'x:"pricing alternative"'` is. Matches the BullMQ fan-out key.

### 4.3 Skeleton → hydrate choreography

**Pipeline P (calendar)** — unchanged from planned design:
- t=0: 7 `<CalendarItemCard variant="skeleton">` with `<Skeleton>` primitives
- t≈5–7s: shell SSE → cards hydrate with time/type/topic + `animate-sf-fade-in`
- t=10–60s: each `slot_ready` → spinner crossfades to checkmark, `draftPreview` fades in, `opacity` + `translateY` 300ms compositor-only
- failures: red corner dot + inline Retry, no layout shift

**Pipeline R (Today, search-origin)**:
- t=0: click "Scan for replies". `POST /api/discovery/scan` returns `202 { scanRunId, sources[] }`. Client optimistically renders one `<SourceChip variant="queued">` per source.
- t≈2–3s: each job emits `searching` → chip shows 6×6 `bg-sf-accent` dot with `animate-pulse` + "Searching…".
- t≈10–30s: each `searched` → chip renders `r/SaaS ✓ 3 found`. Clicking toggles a local filter on `<ReplyRail>`.
- Per-thread drafts stream in parallel via `content.ts` SSE on `drafts` channel. `<ReplyRail>` subscribes via `useProgressiveStream<ReplyData>('reply')` and mounts an existing `<ReplyCard>` per `ready` thread — new cards slide in at top with `animate-sf-fade-in` (existing at `reply-card.tsx:68`).
- Per-source `failed`: red chip + tooltip. Other sources unaffected. When ≥1 failed: header shows `"2 of 5 sources failed — Retry failed"`.

### 4.4 `<ReplyScanHeader>` spec

Placement: top of `today-content.tsx:44`, above `<TodoList>`.

- **Button**: `<Button>Scan for replies</Button>` — `secondary` idle, `accent` when results <10 min old, disabled during scan (label `"Scanning… 3/5 sources done"`).
- **Subtitle** (14px muted): `"Last scan 12 min ago · 7 replies generated"`. First run: `"Never scanned — try it now."`
- **Cron hint**: muted pill `"Auto-scans every 4h"` + tooltip.
- **Empty state** (0 sources): `"Add reply sources"` CTA → `/settings/discovery`. Scan button hidden until ≥1 source exists.
- **Rate-limit**: 2-min server-side debounce. Mashed clicks shake + toast `"Just scanned — next available in 47s"`.

### 4.5 Retry UX — two levels

1. **Per-source**: click red `<SourceChip>` → `POST /api/discovery/retry-source { scanRunId, source }`. Hook calls `scan.reset(itemId)`; chip flips to `queued`.
2. **Per-thread**: failed `<ReplyCard>` → `POST /api/calendar/generate/retry { itemId: threadId }` (or equivalent; endpoint shape TBD in plan phase).
3. **Bulk**: `"Retry failed"` link in header fans out per-source endpoint. No bulk thread-level retry (muddles intent).

Dismiss-failed-slot reuses the `toastWithAction` pattern at `unified-calendar.tsx:67-97` with `UNDO_TIMEOUT_MS` (line 33).

### 4.6 Pipeline health pills

**Calendar**: `<PipelineHealthPill>` beside Generate Week button: `"5/7 drafts ready · 2 in flight · 0 failed"`. `<Badge>` variants: `success` when done, `warning` during streaming, `error` on any failure. Click opens dropdown with failed items + "Retry all failed".

**Today**: parallel `<ScanHealthPill>` inside `<ReplyScanHeader>`: `"5/5 sources searched · 7 replies ready · 1 failed"`. Same variant logic.

### 4.7 Accessibility + reduced motion

`role="status" aria-live="polite"` region inside `<WeekGrid>` and `<SourceProgressRail>` announce state transitions, debounced 500ms so near-simultaneous finishes don't spam.

**E2E hooks**: `<WeekGrid>` owns `data-shell-ready` (set true on first `plan_shell_ready`); `<CalendarItemCard>` owns `data-slot-state="{state}"`; `<SourceChip>` owns `data-source-id` + `data-state`; `<ReplyCard>` owns `data-thread-card data-state`.

Reduced motion (global `globals.css:137`): `animate-pulse` → static dot; `animate-sf-fade-in` → instant; shake-on-rate-limit skipped.

### 4.8 State persistence on reload

`/api/today` already joins `drafts` + `threads` and surfaces discovery-origin reply todos (`use-today.ts:61`). Reload recovers naturally.

In-progress scan state: backend owns `GET /api/discovery/scan-status?scanRunId=...` returning `{ sources: [{ id, state, found, aboveGate, error? }] }`. On mount, `<ReplyScanHeader>` reads `localStorage['shipflare:lastScanRunId']`, calls the endpoint, and if any source is still `queued|searching`, seeds `scan.items` from the response before resuming SSE. Otherwise header shows `"Last scan {relative time}"` from server-rendered `lastScannedAt`.

Cron scans don't touch localStorage but their SSE events flow through the same channel — open tabs see chips animate.

---

<!-- QA SECTION -->

## 5. QA — Test Plan & Perf Budgets

Toolchain: **Playwright 1.59** (`e2e/tests/`), **Vitest 4** (new `src/**/__tests__/`), **MSW 2** (Anthropic + Reddit/X), Redis `:6390` for BullMQ.

### 5.1 Test matrix

**A** = CI-blocking, **M** = manual.

| Flow | Unit | Integration | E2E |
|---|---|---|---|
| Generate Week happy (P) | A | A | A |
| Retry failed slot | A | A | A |
| Reload mid-gen, state restores | A (reducer) | A | A |
| **Generate Week does NOT trigger search** (decoupling regression) | A | A | A |
| Scan happy (N sources → chips → drafts) | A | A | A |
| Retry failed source | A | A | A |
| 2 of 5 sources fail, rest complete | A | A | A |
| All sources 0 above-gate | A | A | M |
| Scan twice fast (scanRunId dedup) | A | A | M |
| content.ts fail on above-gate → DLQ | A | A | M |
| Worker SIGTERM re-delivers | — | A | M |
| DLQ after 3 attempts | A | A | M |

### 5.2 Unit tests (Vitest, `happy-dom` for hooks)

- **`shell-planner`** — `postingHours*7` slots; deterministic ids; `contentMix*` ±1; zero-followers plans; `PlannerEmptyError` → `calendar_plan_failed`.
- **`slot-body.skill`** — rejects missing `contentType`; `recentPostHistory` no verbatim ≥40 chars; conforms to schema; stable cache key; cost → `pipeline_events`.
- **`discovery-single-source` skill (NEW)** — filters by `platform`; respects `customQueryTemplates`; 429 → `{errors:[{code:'rate_limited'}]}` (no throw); gate enforced; cost reported.
- **`search-source.ts` processor (NEW)** — idempotent via `(scanRunId, sourceId)` jobId; inserts `threads state='queued'` + `onConflictDoNothing`; enqueues `content` only for ≥0.7; rate-bucket reject reschedules (no DLQ); 3 attempts → DLQ + SSE `source_failed`.
- **`content.ts` processor (MODIFIED)** — `threads.state: queued→drafting→ready|failed`; `pipeline_events.stage='thread_ready'|'thread_failed'`; unified SSE envelope.
- **`per-slot-draft.processor`** — idempotent on `state='ready'`; transitions; SSE `slot_update`; attempt 4 → slot-scoped `failed`+DLQ.
- **`useProgressiveStream`** — `shell_ready` merge; `slot_update` by id; reconnect 100/400/1600ms cap 5s; drops `(slotId, state, seq)` dups.
- **`stream-reducer`** — `queued→drafting→ready` allowed; `ready→drafting` ignored; `failed→drafting` on retry; source chip `searching→searched|failed` symmetric.

### 5.3 Integration (BullMQ + Redis + Postgres)

1. **`calendar-plan-does-not-trigger-reply-scan.int.test.ts`** — run `processCalendarPlan`; `searchSourceQueue.getJobCounts()` + `contentQueue.getJobCounts()` all zero.
2. **`discovery-fans-out-n-source-jobs.int.test.ts`** — N sources → N `search-source` jobs with deterministic jobIds.
3. **`search-source-writes-threads-and-enqueues-content.int.test.ts`** — 5 threads (3 above gate, 2 below) → 5 `threads state='queued'`, 3 `content` jobs.
4. **`concurrent-source-jobs-dedupe-threads.int.test.ts`** — overlapping `externalId`s → unique row count.
5. **`per-source-failure-isolation.int.test.ts`** — #3 throws; others finish; #3 → DLQ; SSE `source_failed` only for #3.
6. **`scan-run-id-dedup.int.test.ts`** — two `enqueueDiscoveryScan` in 500ms → jobId collision → one logical scan.
7. **`dlq-after-three-attempts.int.test.ts`** — slot-draft + search-source DLQ with backoff {1,4,16}s ±20%.
8. **`idempotent-retry-after-partial-success.int.test.ts`** — fail after thread insert, before content enqueue; retry → no dup row; content enqueues once.
9. **`full-scan-calls-single-source-per-source.int.test.ts`** — NEW. Run `processFullScan` with 5 sources; assert `runSkill(discoverySkill)` called 5× with single-source input (not 1× with 5-source array); aggregate thread count matches per-source sum.
10. **`calibrate-discovery-iterates-single-source.int.test.ts`** — NEW. Run optimize loop; assert each source invokes the single-source skill independently and aggregated scores feed the optimizer in the same shape as pre-consolidation.

### 5.4 E2E (Playwright)

1. **`generate-week-happy-path.spec.ts`** — click → `[data-shell-ready]` ≤6s → first `[data-slot-state="ready"]` ≤15s → all N ready ≤2min. **Assert** `page.request.get('/api/debug/queue-counts')` shows `searchSource.total===0 && content.total===0`.
2. **`scan-for-replies-happy-path.spec.ts`** — `/today` → *Scan* → chips `searching→searched` → `[data-thread-card][data-state="ready"]` cards into reply rail → header count = sum per-source `newThreadCount`.
3. **`retry-failed-source.spec.ts`** — MSW 500 on #2 → chip `failed` + *Retry* → `searching→searched`; new cards appear.
4. **`generate-week-does-not-trigger-scan.spec.ts`** — decoupling regression. Click Generate Week; poll queue counts for 60s; fail if any `searchSource` job; zero `[data-source-chip]` in DOM.
5. **`partial-scan-degradation.spec.ts`** — 5 sources, MSW fails #2 #4; 3 `searched` + 2 `failed` chips; cards only from #1/#3/#5 (`data-source-id`); *Retry 2 failed* works.
6. **`onboarding-smoke-full-scan.spec.ts`** — NEW. Onboarding regression guard. Fresh signup → `full-scan` pipeline runs → user's first threads page shows ≥1 thread within the historical pre-consolidation baseline (±10%). Gates the `discovery_consolidated_skill` rollout.

### 5.5 Failure injection — every failure MUST be visible

| Failure | Inject | User MUST see |
|---|---|---|
| Anthropic 500 on Nth call | `msw.http.post(…, nthCall(N, 500))` | slot red border + Retry + toast |
| Anthropic timeout | `delay('infinite')` > 30s | slot `drafting` → `failed` → retry-exhausted banner |
| Malformed JSON from `content-gen` on 1 above-gate thread | MSW `<html>` body | `threads.state='failed'` + `stage='thread_failed'`; others unaffected; DLQ captures; red card "Model returned invalid response" |
| Reddit/X 429 on source #2 | `http.get('…/search', nthCall(2, 429))` | chip `failed`; others `searched`; retry succeeds |
| Redis disconnect | `redis.disconnect()` | "Reconnecting…" chip; rehydrate from `GET /api/today` |
| Worker SIGTERM mid-search | `process.kill(pid,'SIGTERM')` | chip stays `searching`; redelivered ≤90s |

Nightly silent-failure guard: `threads.state='failed'` rows without matching `stage='thread_failed'` → suite fails.

### 5.6 Performance budget CI gate

Playwright `performance.now()` + `pipeline_events` cross-check.

**Plan:** TTFP p95 ≤6s (→`[data-shell-ready]`); TTFD p95 ≤15s (first `ready`); all N ready ≤120s p95.
**Discovery:** TTFS p95 ≤10s (first `source_searched`); TTFT p95 ≤30s (first `thread_ready`); full scan p95 ≤90s for ≤10 sources.

Project `perf` in `playwright.config.ts`. PR: 20 iter, warn +5-15%, block +15%. Nightly: 100 iter strict, `perf-regression` issue on fail. Server/client timing agree ≤500ms.

### 5.7 Cost regression guard

Nightly `.github/workflows/cost-guard.yml`:

```sql
SELECT
  CASE WHEN trace_id LIKE 'generate-week-%' THEN 'plan'
       WHEN trace_id LIKE 'scan-%'          THEN 'scan' END AS flow,
  user_id, trace_id, SUM(cost) AS run_cost
FROM pipeline_events
WHERE entered_at > now() - interval '7 days'
  AND trace_id LIKE ANY (ARRAY['generate-week-%','scan-%'])
GROUP BY flow, user_id, trace_id;
```

Weekly p95 per flow: **Plan > $0.35** → fail (baseline ~$0.22 with cache); **Scan > $0.15** → fail (~$0.07 baseline, 2× headroom); **cache-hit ratio < 60%** → fail.

### 5.8 Observability & alerting

Metrics: `slot_draft.{duration_ms,attempts,dlq_count}`, `search_source.{duration_ms,attempts,dlq_count}`, `thread.state_transitions`, `generate_week.ttfp_ms/ttfd_ms`, `scan.ttfs_ms/ttft_ms` (client beacon → `POST /api/telemetry/ttf`), `sse.reconnect_count`, `scan.gate_pass_ratio` (1h).

**Alerts** (GH Actions over `pipeline_events`):
1. Per-source DLQ rate > 20% / 1h — page
2. Silent failure: `threads.state='failed'` without matching `stage='thread_failed'` > 3% / 24h — page (wires to <3% PM metric)
3. TTFS/TTFT drift: daily p95 > 25% vs 7-day median — warn
4. Cost spike: user's `generate-week` or `scan` > 3× 14-day personal median — warn

`monitor.ts` is out of scope — its alerts stay on its own cadence, untouched.

---

## 6. Risks & mitigations

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Cost regression from N × LLM calls | Med | $ | Prompt cache 5-min TTL shared across concurrent jobs; two-flow cost guard in CI catches regressions before merge |
| Stalled `drafting` rows (worker crash mid-job) | Low | silent bug | Cron sweep: `state='drafting' AND last_attempt_at < now()-10min → 'failed'` via partial index; BullMQ redelivery |
| Per-user X/Reddit rate-limit blown by concurrency | Med | 429s | Redis token-bucket `rate:{platform}:{userId}`; bucket inside the tool so backpressure blocks skill not queue |
| Silent coupling re-appears in a future PR | Med | decoupling lost | Integration test `calendar-plan-does-not-trigger-reply-scan` + E2E regression |
| Discovery skill consolidation breaks calibration/onboarding | Med | sign-up funnel + tuning regression | Onboarding smoke E2E + `full-scan-calls-single-source-per-source` + `calibrate-discovery-iterates-single-source` integration tests block merge; calibration eval set re-run in CI |

## 7. Open questions

1. Reply-gate — single slider per channel, or separate relevance/intent gates? (PM §1.6)
2. Terminal slot-body failure — keep shell-hydrated card as writing prompt, or remove? (PM §1.6)
3. Failed-slot/thread auto-retry on page re-open, or manual only after first retry? (PM §1.6)
4. `source_searched` events — include top-3 thread titles preview, or stick with `found:N, aboveGate:K`? (PM §1.6)

## 8. Merge checklist

A single PR (or small dependent stack) merges when all of these are green:

- Schema migration `0018_generate_week_fanout` applied
- Old skills deleted: `src/skills/content-batch/`, multi-source variant of `src/skills/discovery/`
- Old SSE event types deleted: `calendar_plan_complete`, `calendar_draft_created`, `agent_complete`, `todo_added` (replaced by unified envelope)
- `calendar-plan.ts:224-230` (`enqueueMonitor`) deleted
- Decoupling integration test `calendar-plan-does-not-trigger-reply-scan` passes
- Onboarding smoke E2E `onboarding-smoke-full-scan` passes
- Calibration eval set within tolerance of pre-consolidation baseline
- Perf gate passes: TTFP p95 ≤6s, TTFD ≤15s, TTFS ≤10s, TTFT ≤30s
- Cost gate passes: Plan p95 ≤$0.35, Scan p95 ≤$0.15, cache-hit ≥60%
- Silent-failure guard: zero `state='failed'` rows without matching `stage='*_failed'`

---

**Next step:** invoke `writing-plans` to produce the implementation plan from this design.
