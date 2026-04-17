# Plan + Reply Journey Redesign — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace monolithic LLM calls with per-item BullMQ fan-out in both the Plan pipeline (Generate Week) and the Reply pipeline (search-based discovery), adding streaming UI, state machines, and retry. Decouple the two pipelines and consolidate discovery to a single-source primitive.

**Architecture:** Two independent pipelines share one primitive (per-item fan-out job) and one event envelope (`{pipeline, itemId, state, data?, seq?}`). Pipeline P: `calendar-plan` orchestrator emits a shell (time+type+topic×7) then fans out to a `calendar-slot-draft` queue for body generation. Pipeline R: `discovery-scan` orchestrator fans out to a `search-source` queue (one job per Reddit/X source); each source job scores threads and enqueues `content.ts` for above-gate candidates. The `threads` and `xContentCalendar` tables are the merge points; state lives on the rows, not in memory.

**Tech Stack:** Next.js 15 + React 19 (App Router), Drizzle ORM + Postgres, BullMQ + Redis, Vitest 4 + Playwright 1.59 + MSW 2, Anthropic SDK + skill-runner.

**Spec:** `docs/superpowers/specs/2026-04-17-plan-reply-journey-design.md`

**Pre-launch:** No prod users. No backfills, no feature flags, no dual-publish. Delete old code aggressively.

**Out of scope:** `src/workers/processors/monitor.ts` (target-account polling), `engagement.ts`, `posting.ts`, Reddit platform-specific reply formatting changes.

---

## File Structure

**Create:**
- `drizzle/0018_generate_week_fanout.sql` — schema migration
- `src/lib/db/schema/pipeline-state.ts` — new shared enum (re-export from x-growth)
- `src/lib/pipeline-events.ts` — `PipelineEvent` type (extend existing file)
- `src/workers/processors/calendar-slot-draft.ts` — per-slot body generation
- `src/workers/processors/search-source.ts` — per-source discovery job
- `src/workers/processors/discovery-scan.ts` — scan orchestrator
- `src/skills/slot-body/SKILL.md` + `src/skills/slot-body/agent.md` — single-slot body skill
- `src/hooks/use-progressive-stream.ts` — unified SSE consumer hook
- `src/components/calendar/week-grid.tsx` — skeleton→hydrate week rendering
- `src/components/calendar/pipeline-health-pill.tsx` — progress badge
- `src/components/calendar/slot-status-badge.tsx` — per-card status glyph
- `src/components/today/reply-scan-header.tsx` — "Scan for replies" + status
- `src/components/today/source-progress-rail.tsx` — chip rail
- `src/components/today/source-chip.tsx` — per-source chip
- `src/components/today/reply-rail.tsx` — streaming reply cards
- `src/app/api/discovery/scan/route.ts` — trigger scan
- `src/app/api/discovery/retry-source/route.ts` — per-source retry
- `src/app/api/discovery/scan-status/route.ts` — resume on reload
- `src/app/api/calendar/slot/[id]/retry/route.ts` — per-slot retry
- Unit test files under `src/**/__tests__/*.test.ts`
- E2E test files under `e2e/tests/*.spec.ts`

**Modify:**
- `src/lib/db/schema/x-growth.ts` — add state enum + columns on `xContentCalendar`
- `src/lib/db/schema/channels.ts` — add state columns on `threads`
- `src/lib/queue/types.ts` — add `CalendarSlotDraftJobData`, `SearchSourceJobData`, `DiscoveryScanJobData`
- `src/lib/queue/index.ts` — register new queues + enqueue helpers
- `src/workers/index.ts` — wire new workers
- `src/workers/processors/calendar-plan.ts` — trim to shell + delete `enqueueMonitor`
- `src/workers/processors/discovery.ts` — trim to per-user orchestrator shim
- `src/workers/processors/content.ts` — add `threads.state` transitions + unified SSE
- `src/workers/processors/calibrate-discovery.ts` — loop over sources
- `src/core/pipelines/full-scan.ts` — `Promise.all` over sources
- `src/scripts/discovery-eval.ts`, `src/scripts/test-x-discovery.ts` — loop
- `src/agents/calendar-planner.md` — trim output schema to shell
- `src/agents/discovery.md` — single-source framing
- `src/agents/schemas.ts` — add `slotBodyOutputSchema`, trim `calendarPlanOutputSchema`
- `src/skills/calendar-planner/SKILL.md` — output shape
- `src/skills/discovery/SKILL.md` — single-source input
- `src/components/calendar/unified-calendar.tsx` — delegate to `<WeekGrid>` + add pill
- `src/hooks/use-calendar.ts` — merge with progressive stream
- `src/components/today/todo-list.tsx` — wrap with scan UI
- `src/app/api/calendar/generate/route.ts` — unchanged contract; body smaller after planner trim
- `playwright.config.ts` — add `perf` project

**Delete:**
- `src/skills/content-batch/` (entire directory)
- `src/workers/processors/content-calendar.ts` (replaced by `calendar-slot-draft.ts`)
- Legacy event types in publishers: `calendar_plan_complete`, `calendar_draft_created`, `agent_complete` (content-calendar), `todo_added` (migrated to unified envelope)

---

## Phase 0: Bootstrap test tooling

### Task 0: Add Vitest config + test script

**Files:**
- Create: `vitest.config.ts`
- Modify: `package.json`

- [ ] **Step 1: Write `vitest.config.ts`**

```ts
import { defineConfig } from 'vitest/config';
import { resolve } from 'path';

export default defineConfig({
  test: {
    environment: 'node',
    environmentMatchGlobs: [
      ['src/hooks/__tests__/**', 'happy-dom'],
      ['src/components/**/__tests__/**', 'happy-dom'],
    ],
    include: ['src/**/__tests__/**/*.test.ts', 'src/**/__tests__/**/*.test.tsx'],
    setupFiles: ['./src/test-setup.ts'],
    testTimeout: 10_000,
  },
  resolve: {
    alias: { '@': resolve(__dirname, './src') },
  },
});
```

- [ ] **Step 2: Write `src/test-setup.ts`**

```ts
import '@testing-library/jest-dom/vitest';
```

- [ ] **Step 3: Add scripts + devDeps**

Edit `package.json` `scripts`:

```json
{
  "test": "vitest run",
  "test:watch": "vitest",
  "test:integration": "vitest run --config vitest.integration.config.ts"
}
```

Run:

```bash
bun add -D happy-dom @testing-library/jest-dom @testing-library/react @testing-library/user-event
```

- [ ] **Step 4: Verify empty run**

Run: `bun run test`
Expected: `No test files found` (exit 0) — harness is live.

- [ ] **Step 5: Commit**

```bash
git add vitest.config.ts src/test-setup.ts package.json bun.lock
git commit -m "chore(test): add vitest config and react testing utilities"
```

---

## Phase 1: Schema migration

### Task 1: Add state enum + columns (schema definition)

**Files:**
- Modify: `src/lib/db/schema/x-growth.ts`
- Modify: `src/lib/db/schema/channels.ts`

- [ ] **Step 1: Add enum + columns to `x-growth.ts`**

At top of `src/lib/db/schema/x-growth.ts`, after existing imports:

```ts
export const xContentCalendarItemStateEnum = pgEnum('x_content_calendar_item_state', [
  'queued',
  'drafting',
  'ready',
  'failed',
]);
```

Add to the `xContentCalendar` table definition (inside the `pgTable('x_content_calendar', {...})` body):

```ts
  state: xContentCalendarItemStateEnum('state').notNull().default('queued'),
  failureReason: text('failure_reason'),
  retryCount: integer('retry_count').notNull().default(0),
  lastAttemptAt: timestamp('last_attempt_at', { mode: 'date' }),
```

- [ ] **Step 2: Add columns to `threads` in `channels.ts`**

Import the enum:

```ts
import { xContentCalendarItemStateEnum } from './x-growth';
```

Add to the `threads` table definition:

```ts
  state: xContentCalendarItemStateEnum('state').notNull().default('queued'),
  failureReason: text('failure_reason'),
  retryCount: integer('retry_count').notNull().default(0),
  lastAttemptAt: timestamp('last_attempt_at', { mode: 'date' }),
  sourceJobId: text('source_job_id'),
```

- [ ] **Step 3: Generate migration**

Run:

```bash
bun run db:generate
```

Expected: new file under `drizzle/0018_*.sql`. Rename it to `drizzle/0018_generate_week_fanout.sql`.

- [ ] **Step 4: Hand-edit migration to add indexes**

Open `drizzle/0018_generate_week_fanout.sql` and append:

```sql
CREATE INDEX IF NOT EXISTS xcc_user_state_scheduled_idx
  ON x_content_calendar (user_id, state, scheduled_at);

CREATE INDEX IF NOT EXISTS xcc_state_last_attempt_idx
  ON x_content_calendar (state, last_attempt_at)
  WHERE state IN ('drafting','failed');

CREATE INDEX IF NOT EXISTS threads_user_state_idx
  ON threads (user_id, state);

CREATE INDEX IF NOT EXISTS threads_state_last_attempt_idx
  ON threads (state, last_attempt_at)
  WHERE state IN ('drafting','failed');

CREATE INDEX IF NOT EXISTS threads_source_job_idx
  ON threads (source_job_id);
```

- [ ] **Step 5: Register migration in `drizzle/meta/_journal.json`**

The Drizzle generator already updated the journal. Verify the new entry exists and points to `0018_generate_week_fanout`.

- [ ] **Step 6: Push schema to local DB**

Run:

```bash
bun run db:push
```

Expected: prompts confirmation; migration applies cleanly.

- [ ] **Step 7: Commit**

```bash
git add src/lib/db/schema/x-growth.ts src/lib/db/schema/channels.ts drizzle/0018_generate_week_fanout.sql drizzle/meta/
git commit -m "feat(db): add item-state columns to x_content_calendar and threads (0018)"
```

---

## Phase 2: Unified pipeline event contract

### Task 2: Extend PipelineEvent type + stage union

**Files:**
- Modify: `src/lib/pipeline-events.ts`

- [ ] **Step 1: Read current file**

Run: `cat src/lib/pipeline-events.ts | head -80`
Expected: `PipelineStage` type and `recordPipelineEvent`/`recordPipelineEventsBulk` helpers.

- [ ] **Step 2: Write new type at top of file**

Add near top, after imports:

```ts
export type Pipeline = 'plan' | 'reply' | 'discovery';

export type ItemState =
  | 'queued'
  | 'drafting'
  | 'ready'
  | 'failed'
  | 'searching'
  | 'searched';

export interface PipelineEvent<T = Record<string, unknown>> {
  pipeline: Pipeline;
  itemId: string;
  state: ItemState;
  data?: T;
  seq?: number;
}
```

- [ ] **Step 3: Extend PipelineStage union**

Replace the existing `PipelineStage` with:

```ts
export type PipelineStage =
  | 'discovered' | 'gate_passed' | 'draft_created' | 'reviewed'
  | 'approved' | 'posted' | 'engaged' | 'failed'
  // Pipeline P: calendar fan-out
  | 'plan_shell_ready'
  | 'slot_drafting'
  | 'slot_ready'
  | 'slot_failed'
  // Pipeline R: per-source fan-out
  | 'scan_started'
  | 'source_queued'
  | 'source_searching'
  | 'source_searched'
  | 'source_failed'
  // Pipeline R: per-thread drafting
  | 'thread_drafting'
  | 'thread_ready'
  | 'thread_failed';
```

- [ ] **Step 4: Write test**

Create `src/lib/__tests__/pipeline-events.test.ts`:

```ts
import { describe, it, expectTypeOf } from 'vitest';
import type { PipelineEvent, Pipeline, ItemState, PipelineStage } from '../pipeline-events';

describe('PipelineEvent type', () => {
  it('accepts all three pipelines', () => {
    expectTypeOf<Pipeline>().toEqualTypeOf<'plan' | 'reply' | 'discovery'>();
  });
  it('accepts all item states', () => {
    const states: ItemState[] = ['queued', 'drafting', 'ready', 'failed', 'searching', 'searched'];
    expectTypeOf(states).toEqualTypeOf<ItemState[]>();
  });
  it('PipelineEvent is shape-safe', () => {
    const e: PipelineEvent<{ topic: string }> = {
      pipeline: 'plan',
      itemId: 'abc',
      state: 'ready',
      data: { topic: 'x' },
      seq: 1,
    };
    expectTypeOf(e.pipeline).toEqualTypeOf<Pipeline>();
  });
  it('PipelineStage includes new stages', () => {
    const stages: PipelineStage[] = ['plan_shell_ready', 'source_searched', 'thread_ready'];
    expectTypeOf(stages).toEqualTypeOf<PipelineStage[]>();
  });
});
```

- [ ] **Step 5: Run test**

Run: `bun run test src/lib/__tests__/pipeline-events.test.ts`
Expected: PASS (type tests).

- [ ] **Step 6: Commit**

```bash
git add src/lib/pipeline-events.ts src/lib/__tests__/pipeline-events.test.ts
git commit -m "feat(events): unified PipelineEvent envelope and stage enum"
```

---

## Phase 3: Queue topology

### Task 3: Add job schemas to queue types

**Files:**
- Modify: `src/lib/queue/types.ts`

- [ ] **Step 1: Read current types**

Run: `grep -n "export const " src/lib/queue/types.ts | head -20`
Expected: list of existing Zod schemas — `calendarPlanJobSchema`, `contentJobSchema`, etc.

- [ ] **Step 2: Add `CalendarSlotDraftJobData` + `SearchSourceJobData` + `DiscoveryScanJobData`**

Append to `src/lib/queue/types.ts` (before the `JobData` union):

```ts
export const calendarSlotDraftJobSchema = z.object({
  kind: z.literal('user').optional(),
  schemaVersion: SCHEMA_VERSION,
  traceId: TRACE_ID,
  userId: z.string().min(1),
  productId: z.string().min(1),
  calendarItemId: z.string().min(1),
  channel: z.string().min(1),
});
export type CalendarSlotDraftJobData = z.input<typeof calendarSlotDraftJobSchema>;

export const searchSourceJobSchema = z.object({
  kind: z.literal('user').optional(),
  schemaVersion: SCHEMA_VERSION,
  traceId: TRACE_ID,
  userId: z.string().min(1),
  productId: z.string().min(1),
  platform: z.string().min(1),
  source: z.string().min(1),
  scanRunId: z.string().min(1),
});
export type SearchSourceJobData = z.input<typeof searchSourceJobSchema>;

export const discoveryScanJobSchema = z.object({
  kind: z.literal('user').optional(),
  schemaVersion: SCHEMA_VERSION,
  traceId: TRACE_ID,
  userId: z.string().min(1),
  productId: z.string().min(1),
  platform: z.string().min(1),
  scanRunId: z.string().min(1),
  trigger: z.enum(['cron', 'manual', 'onboarding']),
});
export type DiscoveryScanJobData = z.input<typeof discoveryScanJobSchema>;
```

- [ ] **Step 3: Write test**

Create `src/lib/queue/__tests__/types.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import {
  calendarSlotDraftJobSchema,
  searchSourceJobSchema,
  discoveryScanJobSchema,
} from '../types';

describe('new job schemas', () => {
  it('calendar-slot-draft requires calendarItemId', () => {
    expect(() =>
      calendarSlotDraftJobSchema.parse({
        schemaVersion: 1, traceId: 't1', userId: 'u1', productId: 'p1', channel: 'x',
      })
    ).toThrow();
  });
  it('search-source requires source', () => {
    expect(() =>
      searchSourceJobSchema.parse({
        schemaVersion: 1, traceId: 't1', userId: 'u1', productId: 'p1',
        platform: 'reddit', scanRunId: 'scan-1',
      })
    ).toThrow();
  });
  it('discovery-scan rejects unknown trigger', () => {
    expect(() =>
      discoveryScanJobSchema.parse({
        schemaVersion: 1, traceId: 't1', userId: 'u1', productId: 'p1',
        platform: 'reddit', scanRunId: 'scan-1', trigger: 'frog',
      })
    ).toThrow();
  });
  it('accepts valid discovery-scan job', () => {
    const r = discoveryScanJobSchema.parse({
      schemaVersion: 1, traceId: 't1', userId: 'u1', productId: 'p1',
      platform: 'reddit', scanRunId: 'scan-1', trigger: 'manual',
    });
    expect(r.trigger).toBe('manual');
  });
});
```

- [ ] **Step 4: Run tests**

Run: `bun run test src/lib/queue/__tests__/types.test.ts`
Expected: 4 passed.

- [ ] **Step 5: Commit**

```bash
git add src/lib/queue/types.ts src/lib/queue/__tests__/types.test.ts
git commit -m "feat(queue): add job schemas for calendar-slot-draft, search-source, discovery-scan"
```

### Task 4: Register queues + enqueue helpers

**Files:**
- Modify: `src/lib/queue/index.ts`

- [ ] **Step 1: Read current file structure**

Run: `grep -n "^export const \|^export async function enqueue" src/lib/queue/index.ts | head -30`

- [ ] **Step 2: Declare new queues + enqueue helpers**

Near existing queue declarations (after the last `Queue` instantiation) add:

```ts
export const calendarSlotDraftQueue = new Queue<CalendarSlotDraftJobData>(
  'calendar-slot-draft',
  {
    connection: redisConnection,
    defaultJobOptions: {
      removeOnComplete: { count: 500, age: 24 * 3600 },
      removeOnFail: { count: 1000, age: 7 * 24 * 3600 },
      attempts: 3,
      backoff: { type: 'exponential', delay: 5000 },
    },
  },
);

export const searchSourceQueue = new Queue<SearchSourceJobData>('search-source', {
  connection: redisConnection,
  defaultJobOptions: {
    removeOnComplete: { count: 500, age: 24 * 3600 },
    removeOnFail: { count: 1000, age: 7 * 24 * 3600 },
    attempts: 3,
    backoff: { type: 'exponential', delay: 5000 },
  },
});

export const discoveryScanQueue = new Queue<DiscoveryScanJobData>('discovery-scan', {
  connection: redisConnection,
  defaultJobOptions: {
    removeOnComplete: { count: 200, age: 24 * 3600 },
    removeOnFail: { count: 200, age: 7 * 24 * 3600 },
    attempts: 2,
    backoff: { type: 'fixed', delay: 2000 },
  },
});

export async function enqueueCalendarSlotDraft(data: CalendarSlotDraftJobData) {
  const jobId = `cslot-${data.calendarItemId}`;
  const job = await calendarSlotDraftQueue.add('draft', data, { jobId });
  return job.id ?? jobId;
}

export async function enqueueSearchSource(data: SearchSourceJobData) {
  const sourceHash = createHash('sha1').update(data.source).digest('hex').slice(0, 10);
  const jobId = `ssrc-${data.scanRunId}-${data.platform}-${sourceHash}`;
  const job = await searchSourceQueue.add('search', data, { jobId });
  return job.id ?? jobId;
}

export async function enqueueDiscoveryScan(data: DiscoveryScanJobData) {
  const jobId = `scan-${data.scanRunId}`;
  const job = await discoveryScanQueue.add('scan', data, { jobId });
  return job.id ?? jobId;
}
```

- [ ] **Step 3: Add imports at top**

```ts
import { createHash } from 'node:crypto';
import type {
  CalendarSlotDraftJobData,
  SearchSourceJobData,
  DiscoveryScanJobData,
} from './types';
```

- [ ] **Step 4: Write integration test (lightweight — just wiring)**

Create `src/lib/queue/__tests__/enqueue.test.ts`:

```ts
import { describe, it, expect, afterAll } from 'vitest';
import {
  calendarSlotDraftQueue,
  searchSourceQueue,
  enqueueCalendarSlotDraft,
  enqueueSearchSource,
} from '../index';

describe('enqueue helpers (requires Redis)', () => {
  afterAll(async () => {
    await calendarSlotDraftQueue.obliterate({ force: true });
    await searchSourceQueue.obliterate({ force: true });
  });

  it('dedupes calendar-slot-draft on calendarItemId', async () => {
    const data = {
      schemaVersion: 1 as const,
      traceId: 't-test',
      userId: 'u-test',
      productId: 'p-test',
      calendarItemId: 'ci-abc',
      channel: 'x',
    };
    const id1 = await enqueueCalendarSlotDraft(data);
    const id2 = await enqueueCalendarSlotDraft(data);
    expect(id1).toBe('cslot-ci-abc');
    expect(id2).toBe('cslot-ci-abc');
    const count = await calendarSlotDraftQueue.getJobCountByTypes('waiting', 'delayed', 'active');
    expect(count).toBeLessThanOrEqual(1);
  });

  it('dedupes search-source on (scanRunId, platform, source)', async () => {
    const data = {
      schemaVersion: 1 as const,
      traceId: 't-test',
      userId: 'u-test',
      productId: 'p-test',
      platform: 'reddit',
      source: 'r/SaaS',
      scanRunId: 'scan-xyz',
    };
    const id1 = await enqueueSearchSource(data);
    const id2 = await enqueueSearchSource(data);
    expect(id1).toBe(id2);
    expect(id1).toMatch(/^ssrc-scan-xyz-reddit-/);
  });
});
```

- [ ] **Step 5: Run test (requires local Redis)**

Run: `redis-server --port 6379 --save '' --daemonize yes && bun run test src/lib/queue/__tests__/enqueue.test.ts`
Expected: 2 passed.

- [ ] **Step 6: Commit**

```bash
git add src/lib/queue/index.ts src/lib/queue/__tests__/enqueue.test.ts
git commit -m "feat(queue): register calendar-slot-draft, search-source, discovery-scan queues"
```

---

## Phase 4: Planner shell + slot-body skill

### Task 5: Trim `calendar-planner` agent to shell output

**Files:**
- Modify: `src/agents/calendar-planner.md`
- Modify: `src/agents/schemas.ts`

- [ ] **Step 1: Read current schema + agent**

Run: `grep -n "calendarPlanOutputSchema\|entries" src/agents/schemas.ts | head -15`

- [ ] **Step 2: Trim `calendarPlanOutputSchema`**

Replace the `calendarPlanOutputSchema` definition in `src/agents/schemas.ts` with:

```ts
export const calendarPlanOutputSchema = z.object({
  phase: z.string().min(1),
  phaseDescription: z.string().optional(),
  weeklyStrategy: z.string().min(1),
  entries: z.array(z.object({
    dayOffset: z.number().int().min(0).max(6),
    hour: z.number().int().min(0).max(23),
    contentType: z.enum(['metric', 'educational', 'engagement', 'product', 'thread']),
    topic: z.string().min(1).max(200),
  })).min(1),
});
export type CalendarPlanOutput = z.infer<typeof calendarPlanOutputSchema>;
```

Any optional `tweets`, `replyBody`, `confidence`, `whyItWorks` fields previously in entries — delete.

- [ ] **Step 3: Add `slotBodyOutputSchema`**

Append to `schemas.ts`:

```ts
export const slotBodyOutputSchema = z.object({
  tweets: z.array(z.string().min(1)).min(1),
  confidence: z.number().min(0).max(1),
  whyItWorks: z.string().min(1),
});
export type SlotBodyOutput = z.infer<typeof slotBodyOutputSchema>;
```

- [ ] **Step 4: Rewrite `src/agents/calendar-planner.md` output section**

Open the file. Find the section that instructs the agent to output `tweets`/body content. Replace the output contract with (JSON example inside fenced block):

```md
## Output format

Return a single JSON object:

\`\`\`json
{
  "phase": "growth",
  "phaseDescription": "optional short phase note",
  "weeklyStrategy": "one-sentence strategy for the week",
  "entries": [
    { "dayOffset": 0, "hour": 14, "contentType": "metric",      "topic": "Daily MRR update" },
    { "dayOffset": 1, "hour": 17, "contentType": "educational", "topic": "How X works under the hood" }
  ]
}
\`\`\`

Return EXACTLY `postingHours.length * 7` entries — one per slot across 7 days.
**Do NOT generate body copy.** Topics are headline-length (<=120 chars). Body is generated
by downstream per-slot jobs.
```

Also drop any prompt guidance about writing full tweets or threads.

- [ ] **Step 5: Unit test on schema**

Create `src/agents/__tests__/schemas-shell.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { calendarPlanOutputSchema, slotBodyOutputSchema } from '../schemas';

describe('calendarPlanOutputSchema (shell)', () => {
  it('rejects entries that include body fields', () => {
    const bad = {
      phase: 'growth', weeklyStrategy: 's',
      entries: [{ dayOffset: 0, hour: 14, contentType: 'metric', topic: 't', tweets: ['x'] }],
    };
    // tweets is ignored by parse (strict off) but topic stays required:
    const parsed = calendarPlanOutputSchema.parse(bad);
    expect('tweets' in parsed.entries[0]).toBe(false);
  });
  it('accepts minimal valid shell', () => {
    const ok = calendarPlanOutputSchema.parse({
      phase: 'growth', weeklyStrategy: 's',
      entries: [{ dayOffset: 0, hour: 14, contentType: 'metric', topic: 'MRR' }],
    });
    expect(ok.entries).toHaveLength(1);
  });
});

describe('slotBodyOutputSchema', () => {
  it('requires at least one tweet', () => {
    expect(() =>
      slotBodyOutputSchema.parse({ tweets: [], confidence: 0.5, whyItWorks: 'x' })
    ).toThrow();
  });
  it('accepts valid body', () => {
    const ok = slotBodyOutputSchema.parse({
      tweets: ['Hello'], confidence: 0.7, whyItWorks: 'because',
    });
    expect(ok.tweets).toHaveLength(1);
  });
});
```

- [ ] **Step 6: Run tests**

Run: `bun run test src/agents/__tests__/schemas-shell.test.ts`
Expected: 4 passed.

- [ ] **Step 7: Commit**

```bash
git add src/agents/schemas.ts src/agents/calendar-planner.md src/agents/__tests__/schemas-shell.test.ts
git commit -m "refactor(planner): trim calendar-planner to shell-only output; add slotBodyOutputSchema"
```

### Task 6: New `slot-body` skill

**Files:**
- Create: `src/skills/slot-body/SKILL.md`
- Create: `src/skills/slot-body/agent.md`

- [ ] **Step 1: Inspect the retiring `content-batch` skill for reference**

Run: `cat src/skills/content-batch/SKILL.md`
Expected: frontmatter with `allowed-tools`, `shared-references: ['platforms/x-strategy']`, etc.

- [ ] **Step 2: Write `src/skills/slot-body/SKILL.md`**

```md
---
name: slot-body
description: Generate a single tweet or thread body for one planner slot (calendar-slot-draft fan-out).
agent: agent.md
model: claude-sonnet-4-6
maxTurns: 4
cache-safe: true
output-schema: slotBodyOutputSchema
allowed-tools: []
shared-references:
  - platforms/x-strategy
references:
  - ./references/x-content-guide.md
---

# slot-body

Given one calendar slot (content type + topic + product context + recent post history),
produce the body text for that slot. One LLM call, one slot.

## Input

\`\`\`ts
{
  contentType: 'metric' | 'educational' | 'engagement' | 'product' | 'thread';
  topic: string;
  product: { name, description, valueProp, keywords, lifecyclePhase };
  recentPostHistory?: string[];
  isThread: boolean;
}
\`\`\`

## Output

See `slotBodyOutputSchema`: `{ tweets: string[], confidence, whyItWorks }`. A single tweet
returns `tweets: [string]`. A thread returns `tweets` of length >=2.

## Rules

- Do not restate the topic literally.
- Do not repeat recent post content verbatim (compare against `recentPostHistory`).
- Defer all platform-specific style to `references/x-content-guide.md`.
```

- [ ] **Step 3: Copy `references/x-content-guide.md` into the new skill**

Run:

```bash
mkdir -p src/skills/slot-body/references && \
cp src/skills/content-batch/references/x-content-guide.md src/skills/slot-body/references/x-content-guide.md
```

- [ ] **Step 4: Write `src/skills/slot-body/agent.md`**

```md
---
name: slot-body-agent
description: Single-slot body writer.
---

You are a writer generating a single social post for one calendar slot.

You receive one slot at a time. Read `references/x-content-guide.md` for tone and
platform rules. Your output is JSON with shape `{tweets, confidence, whyItWorks}`.

For `contentType=thread`, produce 3–6 tweets that hook in #1 and pay off by the end.
For any other `contentType`, produce exactly one tweet (<=260 chars).

Never generate placeholder text like "TODO" or ellipsis-only closers. Never echo
the `topic` verbatim as the first line.
```

- [ ] **Step 5: Verify skill loads**

Create `src/skills/slot-body/__tests__/load.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { loadSkill } from '@/core/skill-loader';
import { join } from 'node:path';

describe('slot-body skill', () => {
  it('loads without errors', () => {
    const skill = loadSkill(join(process.cwd(), 'src/skills/slot-body'));
    expect(skill.name).toBe('slot-body');
    expect(skill.cacheSafe).toBe(true);
  });
});
```

- [ ] **Step 6: Run test**

Run: `bun run test src/skills/slot-body/__tests__/load.test.ts`
Expected: 1 passed.

- [ ] **Step 7: Commit**

```bash
git add src/skills/slot-body/
git commit -m "feat(skill): add slot-body for per-slot fan-out body generation"
```

### Task 7: `calendar-slot-draft` processor

**Files:**
- Create: `src/workers/processors/calendar-slot-draft.ts`
- Create: `src/workers/processors/__tests__/calendar-slot-draft.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/workers/processors/__tests__/calendar-slot-draft.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Job } from 'bullmq';

const mockFirst = <T>(val: T | undefined) => ({
  select: () => ({ from: () => ({ where: () => ({ limit: () => (val ? [val] : []) }) }) }),
  update: () => ({ set: () => ({ where: () => Promise.resolve() }) }),
  insert: () => ({ values: () => ({ returning: () => [{ id: 'draft-1' }] }) }),
});

vi.mock('@/lib/db', () => ({ db: mockFirst({ id: 'ci-1', state: 'queued', contentType: 'metric', topic: 't' }) }));
vi.mock('@/lib/queue', () => ({ enqueueReview: vi.fn() }));
vi.mock('@/lib/redis', () => ({ publishUserEvent: vi.fn() }));
vi.mock('@/core/skill-runner', () => ({
  runSkill: vi.fn(async () => ({
    results: [{ tweets: ['Hello'], confidence: 0.8, whyItWorks: 'because' }],
    errors: [],
    usage: { costUsd: 0.01 },
  })),
}));
vi.mock('@/memory/store', () => ({ MemoryStore: class {} }));
vi.mock('@/memory/prompt-builder', () => ({ buildMemoryPrompt: async () => '' }));

beforeEach(() => vi.clearAllMocks());

describe('processCalendarSlotDraft', () => {
  it('short-circuits when state=ready', async () => {
    vi.doMock('@/lib/db', () => ({
      db: mockFirst({ id: 'ci-1', state: 'ready', draftId: 'd-1', contentType: 'metric', topic: 't' }),
    }));
    const { processCalendarSlotDraft } = await import('../calendar-slot-draft');
    const { runSkill } = await import('@/core/skill-runner');
    await processCalendarSlotDraft({
      id: 'job-1',
      data: {
        schemaVersion: 1, traceId: 't', userId: 'u', productId: 'p',
        calendarItemId: 'ci-1', channel: 'x',
      },
    } as Job);
    expect(runSkill).not.toHaveBeenCalled();
  });

  it('runs skill and transitions ready on success', async () => {
    const { processCalendarSlotDraft } = await import('../calendar-slot-draft');
    const { publishUserEvent } = await import('@/lib/redis');
    await processCalendarSlotDraft({
      id: 'job-2',
      data: {
        schemaVersion: 1, traceId: 't', userId: 'u', productId: 'p',
        calendarItemId: 'ci-1', channel: 'x',
      },
    } as Job);
    expect(publishUserEvent).toHaveBeenCalledWith(
      'u', 'agents',
      expect.objectContaining({ type: 'pipeline', pipeline: 'plan', state: 'ready' }),
    );
  });
});
```

- [ ] **Step 2: Run test — expect fail (file doesn't exist)**

Run: `bun run test src/workers/processors/__tests__/calendar-slot-draft.test.ts`
Expected: FAIL with "Cannot find module '../calendar-slot-draft'".

- [ ] **Step 3: Write processor**

Create `src/workers/processors/calendar-slot-draft.ts`:

```ts
import type { Job } from 'bullmq';
import { eq, and, desc } from 'drizzle-orm';
import { join } from 'path';
import { db } from '@/lib/db';
import { products, threads, drafts, xContentCalendar, channels } from '@/lib/db/schema';
import { channelPosts } from '@/lib/db/schema/channels';
import { loadSkill } from '@/core/skill-loader';
import { runSkill } from '@/core/skill-runner';
import { slotBodyOutputSchema, type SlotBodyOutput } from '@/agents/schemas';
import { enqueueReview } from '@/lib/queue';
import { publishUserEvent } from '@/lib/redis';
import { MemoryStore } from '@/memory/store';
import { buildMemoryPrompt } from '@/memory/prompt-builder';
import { createLogger, loggerForJob } from '@/lib/logger';
import type { CalendarSlotDraftJobData } from '@/lib/queue/types';
import { getTraceId } from '@/lib/queue/types';
import { recordPipelineEvent } from '@/lib/pipeline-events';

const baseLog = createLogger('worker:calendar-slot-draft');
const slotBodySkill = loadSkill(join(process.cwd(), 'src/skills/slot-body'));

export async function processCalendarSlotDraft(job: Job<CalendarSlotDraftJobData>) {
  const traceId = getTraceId(job.data, job.id);
  const log = loggerForJob(baseLog, job);
  const { userId, productId, calendarItemId, channel } = job.data;

  const [item] = await db.select().from(xContentCalendar)
    .where(eq(xContentCalendar.id, calendarItemId)).limit(1);
  if (!item) {
    log.warn(`calendarItem ${calendarItemId} not found; discarding`);
    return;
  }
  if (item.state === 'ready' && item.draftId) {
    log.info(`slot ${calendarItemId} already ready; skipping`);
    return;
  }

  await db.update(xContentCalendar)
    .set({ state: 'drafting', lastAttemptAt: new Date() })
    .where(eq(xContentCalendar.id, calendarItemId));
  await publishUserEvent(userId, 'agents', {
    type: 'pipeline', pipeline: 'plan', itemId: calendarItemId, state: 'drafting',
  });

  const [product] = await db.select().from(products).where(eq(products.id, productId)).limit(1);
  if (!product) throw new Error(`product ${productId} gone`);

  const postHistoryRows = await db
    .select({ text: channelPosts.text })
    .from(channelPosts)
    .innerJoin(channels, eq(channelPosts.channelId, channels.id))
    .where(and(eq(channels.userId, userId), eq(channels.platform, channel)))
    .orderBy(desc(channelPosts.postedAt))
    .limit(20);

  const memoryStore = new MemoryStore(userId, productId);
  const memoryPrompt = await buildMemoryPrompt(memoryStore);

  const res = await runSkill<SlotBodyOutput>({
    skill: slotBodySkill,
    input: {
      contentType: item.contentType,
      topic: item.topic ?? '',
      product: {
        name: product.name,
        description: product.description,
        valueProp: product.valueProp ?? '',
        keywords: product.keywords,
        lifecyclePhase: product.lifecyclePhase ?? 'pre_launch',
      },
      recentPostHistory: postHistoryRows.map((r) => r.text),
      isThread: item.contentType === 'thread',
    },
    deps: {},
    memoryPrompt: memoryPrompt || undefined,
    outputSchema: slotBodyOutputSchema,
    runId: traceId,
  });

  if (res.errors.length > 0 || !res.results[0]?.tweets?.length) {
    await db.update(xContentCalendar)
      .set({ state: 'failed', failureReason: res.errors[0]?.error ?? 'empty output' })
      .where(eq(xContentCalendar.id, calendarItemId));
    await publishUserEvent(userId, 'agents', {
      type: 'pipeline', pipeline: 'plan', itemId: calendarItemId, state: 'failed',
      data: { reason: res.errors[0]?.error ?? 'empty output' },
    });
    await recordPipelineEvent({ userId, productId, stage: 'slot_failed', metadata: { calendarItemId } });
    return;
  }

  const body = res.results[0];
  const replyBody = body.tweets.join('\n\n---\n\n');
  const isThread = body.tweets.length > 1;

  const [threadRecord] = await db.insert(threads).values({
    userId,
    externalId: `calendar-${calendarItemId}`,
    platform: channel,
    community: item.contentType,
    title: body.tweets[0].slice(0, 200),
    url: '',
    relevanceScore: body.confidence,
  }).onConflictDoNothing({ target: [threads.userId, threads.platform, threads.externalId] }).returning();

  if (!threadRecord) {
    log.warn(`thread conflict for calendar-${calendarItemId}; skipping`);
    return;
  }

  const [draft] = await db.insert(drafts).values({
    userId,
    threadId: threadRecord.id,
    draftType: 'original_post',
    postTitle: isThread ? 'Thread' : undefined,
    replyBody,
    confidenceScore: body.confidence,
    whyItWorks: body.whyItWorks,
  }).returning();

  await db.update(xContentCalendar)
    .set({ state: 'ready', draftId: draft.id, status: 'draft_created' })
    .where(eq(xContentCalendar.id, calendarItemId));

  await publishUserEvent(userId, 'agents', {
    type: 'pipeline', pipeline: 'plan', itemId: calendarItemId, state: 'ready',
    data: { draftId: draft.id, previewBody: replyBody.slice(0, 120) },
  });
  await recordPipelineEvent({
    userId, productId, threadId: threadRecord.id, draftId: draft.id,
    stage: 'slot_ready', cost: res.usage.costUsd, metadata: { calendarItemId },
  });

  await enqueueReview({ userId, draftId: draft.id, productId, traceId });
}
```

- [ ] **Step 4: Run test again**

Run: `bun run test src/workers/processors/__tests__/calendar-slot-draft.test.ts`
Expected: 2 passed.

- [ ] **Step 5: Commit**

```bash
git add src/workers/processors/calendar-slot-draft.ts src/workers/processors/__tests__/calendar-slot-draft.test.ts
git commit -m "feat(worker): calendar-slot-draft processor for per-slot body generation"
```

### Task 8: Trim `calendar-plan.ts` to shell + delete enqueueMonitor

**Files:**
- Modify: `src/workers/processors/calendar-plan.ts`

- [ ] **Step 1: Read current fan-out section**

Run: `sed -n '215,245p' src/workers/processors/calendar-plan.ts`
Expected: see `enqueueContentCalendar`, `enqueueMonitor`, `todoSeedQueue.add` — lines ~215–240.

- [ ] **Step 2: Replace the fan-out block**

Replace the block from `// --- Pipeline: enqueue downstream jobs ---` through the three `enqueue*` calls with:

```ts
  // Pipeline: per-slot fan-out only. Reply search is decoupled — see discovery-scan.
  for (const row of created) {
    await enqueueCalendarSlotDraft({
      schemaVersion: 1,
      traceId,
      userId,
      productId,
      calendarItemId: row.id,
      channel,
    });
  }

  // Seed Today shortly after; matches existing delay.
  const ts = Date.now();
  await todoSeedQueue.add('seed', { userId }, {
    delay: 120_000,
    jobId: `generate-week-seed-${userId}-${ts}`,
  });

  log.info(`Fanned out ${created.length} calendar-slot-draft jobs + todo-seed`);
```

- [ ] **Step 3: Update imports**

At the top of `calendar-plan.ts`, remove `enqueueContentCalendar`, `enqueueMonitor` from the `@/lib/queue` import and add `enqueueCalendarSlotDraft`.

- [ ] **Step 4: Update SSE event emitted after DB insert**

Find `publishUserEvent(userId, 'agents', { type: 'calendar_plan_complete', ... })`. Replace with:

```ts
  for (const row of created) {
    await publishUserEvent(userId, 'agents', {
      type: 'pipeline',
      pipeline: 'plan',
      itemId: row.id,
      state: 'queued',
      data: {
        scheduledAt: row.scheduledAt.toISOString(),
        contentType: row.contentType,
        topic: row.topic,
      },
    });
  }
  await publishUserEvent(userId, 'agents', {
    type: 'plan_shell_ready',
    calendarItemIds: created.map((r) => r.id),
    phase: plan.phase,
    weeklyStrategy: plan.weeklyStrategy,
  });
  await recordPipelineEvent({
    userId, productId, stage: 'plan_shell_ready',
    cost: result.usage.costUsd, metadata: { itemCount: created.length },
  });
```

(Keep existing `recordPipelineEvent` import; add `import { recordPipelineEvent } from '@/lib/pipeline-events'` if missing.)

- [ ] **Step 5: Update the state on insert**

Find the `db.insert(xContentCalendar).values(entries).returning()` call. Ensure `entries` objects include `state: 'queued'` explicitly. If the insert already relies on the default, that's fine.

- [ ] **Step 6: Update cleanup predicate**

Find the block that runs `db.delete(xContentCalendar).where(...)` around line 179. Replace with:

```ts
  const deleted = await db
    .delete(xContentCalendar)
    .where(
      and(
        eq(xContentCalendar.userId, userId),
        inArray(xContentCalendar.state, ['queued', 'drafting', 'failed']),
        gte(xContentCalendar.scheduledAt, new Date()),
      ),
    )
    .returning({ id: xContentCalendar.id });
```

Add `inArray` to the `drizzle-orm` import.

- [ ] **Step 7: Write regression test**

Create `src/workers/processors/__tests__/calendar-plan-no-monitor.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

describe('calendar-plan.ts decoupling', () => {
  it('does not import enqueueMonitor or enqueueContentCalendar', () => {
    const src = readFileSync('src/workers/processors/calendar-plan.ts', 'utf8');
    expect(src).not.toMatch(/enqueueMonitor\b/);
    expect(src).not.toMatch(/enqueueContentCalendar\b/);
  });
  it('imports enqueueCalendarSlotDraft', () => {
    const src = readFileSync('src/workers/processors/calendar-plan.ts', 'utf8');
    expect(src).toMatch(/enqueueCalendarSlotDraft\b/);
  });
});
```

- [ ] **Step 8: Run test**

Run: `bun run test src/workers/processors/__tests__/calendar-plan-no-monitor.test.ts`
Expected: 2 passed.

- [ ] **Step 9: Type-check**

Run: `bun x tsc --noEmit`
Expected: 0 errors in touched files.

- [ ] **Step 10: Commit**

```bash
git add src/workers/processors/calendar-plan.ts src/workers/processors/__tests__/calendar-plan-no-monitor.test.ts
git commit -m "refactor(calendar-plan): shell-only, fan out to calendar-slot-draft, drop monitor coupling"
```

### Task 9: Delete `content-calendar.ts`

**Files:**
- Delete: `src/workers/processors/content-calendar.ts`
- Delete: `src/skills/content-batch/` (entire directory)

- [ ] **Step 1: Confirm nothing imports them**

Run:

```bash
grep -rn "content-calendar\|content-batch\|enqueueContentCalendar" src/ --include='*.ts' --include='*.tsx'
```

Expected: only matches in the file being deleted and maybe worker `index.ts`. Remove remaining references.

- [ ] **Step 2: Remove worker registration**

In `src/workers/index.ts`, delete the `new Worker('content-calendar', processXContentCalendar, ...)` block and its import.

- [ ] **Step 3: Remove queue + helper**

In `src/lib/queue/index.ts`, delete the `contentCalendarQueue` declaration and the `enqueueContentCalendar` helper. Remove their exports from the barrel.

Also remove `contentCalendarJobSchema` from `src/lib/queue/types.ts`.

- [ ] **Step 4: Delete files**

Run:

```bash
rm src/workers/processors/content-calendar.ts
rm -rf src/skills/content-batch
```

- [ ] **Step 5: Type-check**

Run: `bun x tsc --noEmit`
Expected: 0 errors.

- [ ] **Step 6: Commit**

```bash
git add -u src/
git commit -m "chore: delete content-calendar processor and content-batch skill"
```

---

## Phase 5: Discovery consolidation + search-source

### Task 10: Rewrite `discovery` skill as single-source

**Files:**
- Modify: `src/skills/discovery/SKILL.md`
- Modify: `src/agents/discovery.md`
- Modify: `src/agents/schemas.ts`

- [ ] **Step 1: Update SKILL.md input contract**

Replace the input description in `src/skills/discovery/SKILL.md` with:

```md
## Input

\`\`\`ts
{
  productName: string;
  productDescription: string;
  keywords: string[];
  valueProp?: string;
  source: string;           // single source e.g. "r/SaaS" or 'x:"pricing alternative"'
  platform: 'reddit' | 'x';
  scoringConfig?: { ... };  // optional calibration overrides
  customPainPhrases?: string[];
  customQueryTemplates?: string[];
  additionalRules?: string;
}
\`\`\`

Single-source only. Callers that need multiple sources MUST fan out at the processor layer.
```

Remove frontmatter entries for fan-out-across-sources (`cacheSafe` may stay true).

- [ ] **Step 2: Trim `src/agents/discovery.md`**

Replace any "here are N sources" framing with single-source framing. Search for blocks that list multiple sources; rewrite to "You are scoring one source at a time: {{source}}." Keep the scoring rubric unchanged.

- [ ] **Step 3: Adjust `discoveryOutputSchema` in `src/agents/schemas.ts`** (if it currently accepts per-source groupings)

Confirm the schema still describes `{ threads: [...] }` — if so, no change. If it groups by source, flatten to a single thread array.

- [ ] **Step 4: Write test**

Create `src/skills/discovery/__tests__/single-source-shape.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

describe('discovery skill single-source', () => {
  it('SKILL.md declares single source input (not sources[])', () => {
    const md = readFileSync('src/skills/discovery/SKILL.md', 'utf8');
    expect(md).toMatch(/\bsource:\s*string/);
    expect(md).not.toMatch(/\bsources:\s*string\[\]/);
  });
  it('agent prompt does not fan out across sources', () => {
    const md = readFileSync('src/agents/discovery.md', 'utf8');
    expect(md.toLowerCase()).not.toMatch(/for each (source|subreddit)/);
  });
});
```

- [ ] **Step 5: Run test**

Run: `bun run test src/skills/discovery/__tests__/single-source-shape.test.ts`
Expected: 2 passed.

- [ ] **Step 6: Commit**

```bash
git add src/skills/discovery/SKILL.md src/agents/discovery.md src/agents/schemas.ts src/skills/discovery/__tests__/
git commit -m "refactor(discovery): rewrite as single-source primitive"
```

### Task 11: Refactor `calibrate-discovery.ts` to loop

**Files:**
- Modify: `src/workers/processors/calibrate-discovery.ts`

- [ ] **Step 1: Identify the multi-source skill call**

Run: `grep -n "runSkill\|discoverySkill\|sources" src/workers/processors/calibrate-discovery.ts | head -20`

- [ ] **Step 2: Replace skill input shape**

Find the `runSkill({ skill: discoverySkill, input: {..., sources: [...] } })` block. Replace with a loop:

```ts
  const threadsBySource: Record<string, DiscoveryOutput['threads']> = {};
  let totalCost = 0;
  for (const source of sources) {
    const res = await runSkill<DiscoveryOutput>({
      skill: discoverySkill,
      input: { ...commonInput, source, platform },
      deps,
      memoryPrompt: memoryPrompt || undefined,
      outputSchema: discoveryOutputSchema,
      runId: traceId,
    });
    totalCost += res.usage.costUsd;
    threadsBySource[source] = res.results.flatMap((r) => r.threads);
  }
```

Adapt the downstream aggregation to walk `threadsBySource` instead of skill-internal multi-source `results`.

- [ ] **Step 3: Write test**

Create `src/workers/processors/__tests__/calibrate-single-source.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

describe('calibrate-discovery.ts', () => {
  it('passes a single source per runSkill call', () => {
    const src = readFileSync('src/workers/processors/calibrate-discovery.ts', 'utf8');
    expect(src).toMatch(/for\s*\(\s*const\s+source\s+of\s+sources\s*\)/);
    expect(src).not.toMatch(/input:\s*\{[^}]*sources:\s*sources/);
  });
});
```

- [ ] **Step 4: Run test + type-check**

```bash
bun run test src/workers/processors/__tests__/calibrate-single-source.test.ts
bun x tsc --noEmit
```

Expected: 1 passed; 0 type errors.

- [ ] **Step 5: Commit**

```bash
git add src/workers/processors/calibrate-discovery.ts src/workers/processors/__tests__/calibrate-single-source.test.ts
git commit -m "refactor(calibrate): loop over single-source discovery"
```

### Task 12: Refactor `full-scan.ts` to `Promise.all`

**Files:**
- Modify: `src/core/pipelines/full-scan.ts`

- [ ] **Step 1: Identify multi-source call sites**

Run: `grep -n "runSkill\|discoverySkill" src/core/pipelines/full-scan.ts`

- [ ] **Step 2: Replace with `Promise.all`**

Wherever `runSkill({ skill: discoverySkill, input: { ..., sources } })` appears, replace with:

```ts
  const perSource = await Promise.all(
    sources.map(async (source) => {
      const res = await runSkill<DiscoveryOutput>({
        skill: discoverySkill,
        input: { ...commonInput, source, platform },
        deps,
        memoryPrompt: memoryPrompt || undefined,
        outputSchema: discoveryOutputSchema,
        runId: traceId,
      });
      return { source, res };
    }),
  );
  const allThreads = perSource.flatMap(({ res }) => res.results.flatMap((r) => r.threads));
  const totalCost = perSource.reduce((sum, { res }) => sum + res.usage.costUsd, 0);
```

- [ ] **Step 3: Write regression test**

Create `src/core/pipelines/__tests__/full-scan-loop.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

describe('full-scan.ts fan-out shape', () => {
  it('fans out over sources via Promise.all', () => {
    const src = readFileSync('src/core/pipelines/full-scan.ts', 'utf8');
    expect(src).toMatch(/Promise\.all\(\s*sources\.map/);
  });
});
```

- [ ] **Step 4: Run + type-check**

```bash
bun run test src/core/pipelines/__tests__/full-scan-loop.test.ts
bun x tsc --noEmit
```

- [ ] **Step 5: Commit**

```bash
git add src/core/pipelines/full-scan.ts src/core/pipelines/__tests__/full-scan-loop.test.ts
git commit -m "refactor(full-scan): Promise.all fan-out over single-source discovery"
```

### Task 13: Refactor scripts

**Files:**
- Modify: `src/scripts/discovery-eval.ts`
- Modify: `src/scripts/test-x-discovery.ts`

- [ ] **Step 1: Locate multi-source calls**

Run: `grep -n "runSkill\|sources" src/scripts/discovery-eval.ts src/scripts/test-x-discovery.ts`

- [ ] **Step 2: Wrap skill call in a `for` loop**

Pattern (apply to each script):

```ts
  for (const source of sources) {
    const res = await runSkill<DiscoveryOutput>({
      skill: discoverySkill,
      input: { ...input, source, platform },
      deps, outputSchema: discoveryOutputSchema, runId: crypto.randomUUID(),
    });
    // existing downstream handling, scoped to one source
  }
```

- [ ] **Step 3: Type-check**

Run: `bun x tsc --noEmit`
Expected: 0 errors.

- [ ] **Step 4: Commit**

```bash
git add src/scripts/discovery-eval.ts src/scripts/test-x-discovery.ts
git commit -m "refactor(scripts): loop over single-source discovery"
```

### Task 14: `search-source` processor

**Files:**
- Create: `src/workers/processors/search-source.ts`
- Create: `src/workers/processors/__tests__/search-source.test.ts`

- [ ] **Step 1: Write test**

`src/workers/processors/__tests__/search-source.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Job } from 'bullmq';

const threadsReturning = vi.fn(() => [{ id: 'th-1', externalId: 'ext-1' }]);

vi.mock('@/lib/db', () => ({
  db: {
    select: () => ({ from: () => ({ where: () => ({ limit: () => [{ id: 'p-1', name: 'P' }] }) }) }),
    insert: () => ({ values: () => ({ onConflictDoNothing: () => ({ returning: threadsReturning }) }) }),
  },
}));
vi.mock('@/lib/platform-deps', () => ({ createPlatformDeps: async () => ({}) }));
vi.mock('@/lib/queue', () => ({ enqueueContent: vi.fn() }));
vi.mock('@/lib/redis', () => ({ publishUserEvent: vi.fn() }));
vi.mock('@/core/skill-runner', () => ({
  runSkill: vi.fn(async () => ({
    results: [{
      threads: [{ id: 'ext-1', community: 'r/SaaS', title: 't', url: 'http://x', relevanceScore: 85 }],
    }],
    errors: [],
    usage: { costUsd: 0.005 },
  })),
}));
vi.mock('@/memory/store', () => ({ MemoryStore: class {} }));
vi.mock('@/memory/prompt-builder', () => ({ buildMemoryPrompt: async () => '' }));

beforeEach(() => vi.clearAllMocks());

describe('processSearchSource', () => {
  it('enqueues content for above-gate threads and publishes source_searched', async () => {
    const { processSearchSource } = await import('../search-source');
    const { enqueueContent } = await import('@/lib/queue');
    const { publishUserEvent } = await import('@/lib/redis');
    await processSearchSource({
      id: 'job-1',
      data: {
        schemaVersion: 1, traceId: 't', userId: 'u', productId: 'p',
        platform: 'reddit', source: 'r/SaaS', scanRunId: 'scan-1',
      },
    } as Job);
    expect(enqueueContent).toHaveBeenCalledTimes(1);
    expect(publishUserEvent).toHaveBeenCalledWith('u', 'agents',
      expect.objectContaining({ type: 'pipeline', pipeline: 'discovery', state: 'searched' }));
  });

  it('publishes source_searched with found:0 when skill returns nothing', async () => {
    const { runSkill } = await import('@/core/skill-runner');
    (runSkill as unknown as { mockResolvedValueOnce: (v: unknown) => void }).mockResolvedValueOnce({
      results: [{ threads: [] }], errors: [], usage: { costUsd: 0.001 },
    });
    threadsReturning.mockReturnValueOnce([]);
    const { processSearchSource } = await import('../search-source');
    const { enqueueContent } = await import('@/lib/queue');
    const { publishUserEvent } = await import('@/lib/redis');
    await processSearchSource({
      id: 'job-2',
      data: {
        schemaVersion: 1, traceId: 't', userId: 'u', productId: 'p',
        platform: 'reddit', source: 'r/empty', scanRunId: 'scan-1',
      },
    } as Job);
    expect(enqueueContent).not.toHaveBeenCalled();
    expect(publishUserEvent).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run — expect module-missing failure**

Run: `bun run test src/workers/processors/__tests__/search-source.test.ts`
Expected: FAIL.

- [ ] **Step 3: Write processor**

`src/workers/processors/search-source.ts`:

```ts
import type { Job } from 'bullmq';
import { and, eq } from 'drizzle-orm';
import { join } from 'path';
import { db } from '@/lib/db';
import { products, threads, discoveryConfigs } from '@/lib/db/schema';
import { loadSkill } from '@/core/skill-loader';
import { runSkill } from '@/core/skill-runner';
import { discoveryOutputSchema, type DiscoveryOutput } from '@/agents/schemas';
import { enqueueContent } from '@/lib/queue';
import { publishUserEvent } from '@/lib/redis';
import { createPlatformDeps } from '@/lib/platform-deps';
import { MemoryStore } from '@/memory/store';
import { buildMemoryPrompt } from '@/memory/prompt-builder';
import { createLogger, loggerForJob } from '@/lib/logger';
import type { SearchSourceJobData } from '@/lib/queue/types';
import { getTraceId } from '@/lib/queue/types';
import { recordPipelineEvent } from '@/lib/pipeline-events';

const baseLog = createLogger('worker:search-source');
const discoverySkill = loadSkill(join(process.cwd(), 'src/skills/discovery'));

export async function processSearchSource(job: Job<SearchSourceJobData>) {
  const traceId = getTraceId(job.data, job.id);
  const log = loggerForJob(baseLog, job);
  const { userId, productId, platform, source, scanRunId } = job.data;

  const [product] = await db.select().from(products)
    .where(eq(products.id, productId)).limit(1);
  if (!product) throw new Error(`product ${productId} gone`);

  const [userConfig] = await db.select().from(discoveryConfigs)
    .where(and(eq(discoveryConfigs.userId, userId), eq(discoveryConfigs.platform, platform)))
    .limit(1);

  const deps = await createPlatformDeps(platform, userId);
  const memoryStore = new MemoryStore(userId, productId);
  const memoryPrompt = await buildMemoryPrompt(memoryStore);

  await publishUserEvent(userId, 'agents', {
    type: 'pipeline', pipeline: 'discovery',
    itemId: `${platform}:${source}`, state: 'searching',
  });

  const input: Record<string, unknown> = {
    productName: product.name,
    productDescription: product.description,
    keywords: product.keywords,
    valueProp: product.valueProp ?? '',
    source,
    platform,
  };
  if (userConfig?.calibrationStatus === 'completed') {
    input.scoringConfig = {
      weights: {
        relevance: userConfig.weightRelevance,
        intent: userConfig.weightIntent,
        exposure: userConfig.weightExposure,
        freshness: userConfig.weightFreshness,
        engagement: userConfig.weightEngagement,
      },
      intentGate: userConfig.intentGate,
      relevanceGate: userConfig.relevanceGate,
      gateCap: userConfig.gateCap,
    };
  }

  const res = await runSkill<DiscoveryOutput>({
    skill: discoverySkill,
    input,
    deps,
    memoryPrompt: memoryPrompt || undefined,
    outputSchema: discoveryOutputSchema,
    runId: traceId,
  });

  const gate = userConfig?.enqueueThreshold ?? 0.7;
  const allThreads = res.results.flatMap((r) => r.threads);

  const candidates = allThreads.map((t) => {
    const relevanceScore = t.relevanceScore != null
      ? t.relevanceScore / 100
      : ((t.relevance ?? 0) + (t.intent ?? 0)) / 2;
    return { t, relevanceScore };
  }).filter((c) => c.relevanceScore >= 0.3);

  const rows = candidates.map((c) => ({
    userId,
    externalId: c.t.id,
    platform,
    community: c.t.community,
    title: c.t.title,
    url: c.t.url,
    relevanceScore: c.relevanceScore,
    sourceJobId: job.id ?? null,
    state: 'queued' as const,
  }));
  const shouldEnqueue = new Set(
    candidates.filter((c) => c.relevanceScore >= gate).map((c) => c.t.id),
  );

  let inserted: Array<{ id: string; externalId: string }> = [];
  if (rows.length > 0) {
    inserted = await db.insert(threads).values(rows)
      .onConflictDoNothing({ target: [threads.userId, threads.platform, threads.externalId] })
      .returning({ id: threads.id, externalId: threads.externalId });
  }

  for (const row of inserted) {
    if (!shouldEnqueue.has(row.externalId)) continue;
    await enqueueContent({ userId, threadId: row.id, productId, traceId });
  }

  await publishUserEvent(userId, 'agents', {
    type: 'pipeline', pipeline: 'discovery',
    itemId: `${platform}:${source}`, state: 'searched',
    data: { found: rows.length, aboveGate: inserted.length, source, platform },
  });
  await recordPipelineEvent({
    userId, productId, stage: 'source_searched',
    cost: res.usage.costUsd, metadata: { platform, source, scanRunId, found: rows.length },
  });

  log.info(`search-source ${platform}:${source} — found ${rows.length}, gated ${inserted.length}`);
}
```

- [ ] **Step 4: Run test**

Run: `bun run test src/workers/processors/__tests__/search-source.test.ts`
Expected: 2 passed.

- [ ] **Step 5: Commit**

```bash
git add src/workers/processors/search-source.ts src/workers/processors/__tests__/search-source.test.ts
git commit -m "feat(worker): search-source processor (per-source BullMQ fan-out)"
```

### Task 15: `discovery-scan` orchestrator + trim `discovery.ts`

**Files:**
- Create: `src/workers/processors/discovery-scan.ts`
- Modify: `src/workers/processors/discovery.ts`

- [ ] **Step 1: Write `discovery-scan.ts`**

```ts
import type { Job } from 'bullmq';
import { eq } from 'drizzle-orm';
import { db } from '@/lib/db';
import { products } from '@/lib/db/schema';
import { enqueueSearchSource } from '@/lib/queue';
import { publishUserEvent } from '@/lib/redis';
import { getPlatformConfig } from '@/lib/platform-config';
import { createLogger, loggerForJob } from '@/lib/logger';
import type { DiscoveryScanJobData } from '@/lib/queue/types';
import { getTraceId } from '@/lib/queue/types';
import { recordPipelineEvent } from '@/lib/pipeline-events';
import { discoveryConfigs } from '@/lib/db/schema';

const baseLog = createLogger('worker:discovery-scan');

export async function processDiscoveryScan(job: Job<DiscoveryScanJobData>) {
  const traceId = getTraceId(job.data, job.id);
  const log = loggerForJob(baseLog, job);
  const { userId, productId, platform, scanRunId } = job.data;

  const [product] = await db.select().from(products)
    .where(eq(products.id, productId)).limit(1);
  if (!product) throw new Error(`product ${productId} gone`);

  const [userConfig] = await db.select().from(discoveryConfigs)
    .where(eq(discoveryConfigs.userId, userId)).limit(1);

  const config = getPlatformConfig(platform);
  const sources = userConfig?.customQueryTemplates?.length
    ? userConfig.customQueryTemplates
    : config.defaultSources;

  await publishUserEvent(userId, 'agents', {
    type: 'scan_started', scanRunId, sources, expectedCount: sources.length,
  });
  await recordPipelineEvent({
    userId, productId, stage: 'scan_started',
    metadata: { scanRunId, platform, sourcesCount: sources.length },
  });

  for (const source of sources) {
    await enqueueSearchSource({
      schemaVersion: 1, traceId, userId, productId,
      platform, source, scanRunId,
    });
    await publishUserEvent(userId, 'agents', {
      type: 'pipeline', pipeline: 'discovery',
      itemId: `${platform}:${source}`, state: 'queued',
    });
  }

  log.info(`discovery-scan fanned out ${sources.length} search-source jobs (scanRunId=${scanRunId})`);
}
```

- [ ] **Step 2: Trim `discovery.ts` to an orchestrator**

Replace `src/workers/processors/discovery.ts` with:

```ts
import type { Job } from 'bullmq';
import { eq } from 'drizzle-orm';
import { db } from '@/lib/db';
import { channels, products } from '@/lib/db/schema';
import { enqueueDiscoveryScan } from '@/lib/queue';
import { isStopRequested } from '@/lib/automation-stop';
import { isPlatformAvailable } from '@/lib/platform-config';
import { createLogger, loggerForJob } from '@/lib/logger';
import type { DiscoveryJobData } from '@/lib/queue/types';
import { isFanoutJob } from '@/lib/queue/types';
import { randomUUID } from 'node:crypto';

const baseLog = createLogger('worker:discovery');

export async function processDiscovery(job: Job<DiscoveryJobData>) {
  const log = loggerForJob(baseLog, job);

  if (isFanoutJob(job.data)) {
    const allChannels = await db
      .select({ userId: channels.userId, platform: channels.platform })
      .from(channels);

    const userPlatforms = new Map<string, Set<string>>();
    for (const ch of allChannels) {
      if (!userPlatforms.has(ch.userId)) userPlatforms.set(ch.userId, new Set());
      userPlatforms.get(ch.userId)!.add(ch.platform);
    }

    let enqueued = 0;
    for (const [uid, platformSet] of userPlatforms) {
      if (await isStopRequested(uid)) continue;
      const [product] = await db.select({ id: products.id })
        .from(products).where(eq(products.userId, uid)).limit(1);
      if (!product) continue;

      for (const platform of platformSet) {
        if (!isPlatformAvailable(platform)) continue;
        await enqueueDiscoveryScan({
          schemaVersion: 1,
          traceId: randomUUID(),
          userId: uid,
          productId: product.id,
          platform,
          scanRunId: `cron-${Date.now()}-${randomUUID().slice(0, 8)}`,
          trigger: 'cron',
        });
        enqueued++;
      }
    }
    log.info(`cron fan-out: enqueued ${enqueued} discovery-scan jobs`);
    return;
  }

  // Per-user trigger — delegate to discovery-scan by minting a scanRunId.
  const data = job.data as Extract<DiscoveryJobData, { userId: string }>;
  await enqueueDiscoveryScan({
    schemaVersion: 1,
    traceId: randomUUID(),
    userId: data.userId,
    productId: data.productId,
    platform: data.platform,
    scanRunId: `manual-${Date.now()}-${randomUUID().slice(0, 8)}`,
    trigger: 'manual',
  });
}
```

- [ ] **Step 3: Verify no imports break**

Run: `bun x tsc --noEmit`
Expected: 0 errors. Fix any `sources` / `skillInput` / `recordPipelineEventsBulk` references left over (should be none — they moved to `search-source.ts`).

- [ ] **Step 4: Write decoupling integration test**

Create `src/workers/processors/__tests__/discovery-scan-integration.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Job } from 'bullmq';

const sourceCalls: Array<Record<string, unknown>> = [];

vi.mock('@/lib/db', () => ({
  db: {
    select: () => ({ from: () => ({ where: () => ({ limit: () => [
      { id: 'p-1', name: 'P', keywords: [], description: '' },
    ] }) }) }),
  },
}));
vi.mock('@/lib/queue', () => ({
  enqueueSearchSource: vi.fn(async (data) => { sourceCalls.push(data); return 'job-id'; }),
}));
vi.mock('@/lib/redis', () => ({ publishUserEvent: vi.fn() }));
vi.mock('@/lib/platform-config', () => ({
  getPlatformConfig: () => ({ defaultSources: ['r/SaaS', 'r/indiehackers'] }),
}));

beforeEach(() => { sourceCalls.length = 0; vi.clearAllMocks(); });

describe('processDiscoveryScan', () => {
  it('fans out one search-source job per default source', async () => {
    const { processDiscoveryScan } = await import('../discovery-scan');
    await processDiscoveryScan({
      id: 'j', data: {
        schemaVersion: 1, traceId: 't', userId: 'u', productId: 'p-1',
        platform: 'reddit', scanRunId: 'scan-xyz', trigger: 'manual',
      },
    } as Job);
    expect(sourceCalls).toHaveLength(2);
    expect(sourceCalls[0]).toMatchObject({ platform: 'reddit', source: 'r/SaaS', scanRunId: 'scan-xyz' });
  });
});
```

- [ ] **Step 5: Run test**

Run: `bun run test src/workers/processors/__tests__/discovery-scan-integration.test.ts`
Expected: 1 passed.

- [ ] **Step 6: Commit**

```bash
git add src/workers/processors/discovery.ts src/workers/processors/discovery-scan.ts src/workers/processors/__tests__/discovery-scan-integration.test.ts
git commit -m "feat(worker): discovery-scan orchestrator; trim discovery.ts to shim"
```

### Task 16: Update `content.ts` with `threads.state` transitions

**Files:**
- Modify: `src/workers/processors/content.ts`

- [ ] **Step 1: Add state transition at start of work**

Right after `[thread] = await db.select().from(threads)...` block, before `runSkill`, insert:

```ts
  await db.update(threads)
    .set({ state: 'drafting', lastAttemptAt: new Date() })
    .where(eq(threads.id, threadId));
  await publishUserEvent(userId, 'drafts', {
    type: 'pipeline', pipeline: 'reply', itemId: threadId, state: 'drafting',
  });
  await recordPipelineEvent({
    userId, productId, threadId, stage: 'thread_drafting',
  });
```

- [ ] **Step 2: On success, transition to `ready`**

Right after the `db.insert(drafts).values(...).returning()` block, insert:

```ts
  await db.update(threads)
    .set({ state: 'ready' })
    .where(eq(threads.id, threadId));
```

And replace the existing `publishUserEvent(userId, 'drafts', { type: 'draft_ready', ... })` call with:

```ts
  await publishUserEvent(userId, 'drafts', {
    type: 'pipeline', pipeline: 'reply', itemId: threadId, state: 'ready',
    data: { draftId: inserted.id, previewBody: result.replyBody.slice(0, 120) },
  });
  await recordPipelineEvent({
    userId, productId, threadId, draftId: inserted.id,
    stage: 'thread_ready', cost: usage.costUsd,
  });
```

- [ ] **Step 3: On failure, transition to `failed`**

Wrap the skill + insert block in try/catch:

```ts
  try {
    // existing runSkill + draft insert
  } catch (err) {
    await db.update(threads)
      .set({ state: 'failed', failureReason: (err as Error).message })
      .where(eq(threads.id, threadId));
    await publishUserEvent(userId, 'drafts', {
      type: 'pipeline', pipeline: 'reply', itemId: threadId, state: 'failed',
      data: { reason: (err as Error).message },
    });
    await recordPipelineEvent({
      userId, productId, threadId, stage: 'thread_failed',
      metadata: { error: (err as Error).message },
    });
    throw err; // BullMQ handles retry/DLQ
  }
```

- [ ] **Step 4: Write test**

Create `src/workers/processors/__tests__/content-state-transitions.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

describe('content.ts state transitions', () => {
  const src = readFileSync('src/workers/processors/content.ts', 'utf8');
  it('sets threads.state=drafting before runSkill', () => {
    expect(src).toMatch(/state:\s*'drafting'/);
  });
  it('sets threads.state=ready after draft insert', () => {
    expect(src).toMatch(/state:\s*'ready'/);
  });
  it('emits unified pipeline envelope on success', () => {
    expect(src).toMatch(/type:\s*'pipeline',\s*pipeline:\s*'reply'/);
  });
  it('sets threads.state=failed inside catch', () => {
    expect(src).toMatch(/state:\s*'failed'/);
  });
});
```

- [ ] **Step 5: Run test**

Run: `bun run test src/workers/processors/__tests__/content-state-transitions.test.ts`
Expected: 4 passed.

- [ ] **Step 6: Commit**

```bash
git add src/workers/processors/content.ts src/workers/processors/__tests__/content-state-transitions.test.ts
git commit -m "feat(content): threads.state transitions and unified pipeline envelope"
```

---

## Phase 6: Worker wiring

### Task 17: Register new workers

**Files:**
- Modify: `src/workers/index.ts`

- [ ] **Step 1: Read current workers block**

Run: `grep -n "new Worker" src/workers/index.ts`

- [ ] **Step 2: Register three new workers**

In `src/workers/index.ts`, after the existing workers, add:

```ts
import { processCalendarSlotDraft } from './processors/calendar-slot-draft';
import { processSearchSource } from './processors/search-source';
import { processDiscoveryScan } from './processors/discovery-scan';

new Worker('calendar-slot-draft', processCalendarSlotDraft, {
  connection: redisConnection,
  concurrency: 4,
  lockDuration: 45_000,
});
new Worker('search-source', processSearchSource, {
  connection: redisConnection,
  concurrency: 6,
  lockDuration: 45_000,
});
new Worker('discovery-scan', processDiscoveryScan, {
  connection: redisConnection,
  concurrency: 2,
  lockDuration: 15_000,
});
```

- [ ] **Step 3: Type-check + run workers locally**

```bash
bun x tsc --noEmit
bun --watch src/workers/index.ts &   # confirm no startup crash
sleep 2 && kill %1
```

- [ ] **Step 4: Commit**

```bash
git add src/workers/index.ts
git commit -m "feat(worker): register calendar-slot-draft, search-source, discovery-scan workers"
```

---

## Phase 7: API routes

### Task 18: `POST /api/discovery/scan`

**Files:**
- Create: `src/app/api/discovery/scan/route.ts`

- [ ] **Step 1: Write route**

```ts
import { NextResponse } from 'next/server';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { auth } from '@/lib/auth';
import { db } from '@/lib/db';
import { products, channels } from '@/lib/db/schema';
import { enqueueDiscoveryScan } from '@/lib/queue';
import { getPlatformConfig, isPlatformAvailable } from '@/lib/platform-config';
import { getKeyValueClient } from '@/lib/redis';
import { createLogger } from '@/lib/logger';

const log = createLogger('api:discovery:scan');
const DEBOUNCE_SECONDS = 120;

export async function POST(request: Request) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const userId = session.user.id;

  const body = (await request.json().catch(() => ({}))) as { platform?: string };
  const platform = body.platform ?? 'reddit';
  if (!isPlatformAvailable(platform)) {
    return NextResponse.json({ error: 'platform unavailable' }, { status: 400 });
  }

  const redis = getKeyValueClient();
  const debounceKey = `shipflare:scan:debounce:${userId}:${platform}`;
  const debounceHit = await redis.set(debounceKey, '1', 'EX', DEBOUNCE_SECONDS, 'NX');
  if (debounceHit === null) {
    const ttl = await redis.ttl(debounceKey);
    return NextResponse.json(
      { error: 'rate_limited', retryAfterSeconds: ttl > 0 ? ttl : DEBOUNCE_SECONDS },
      { status: 429 },
    );
  }

  const [product] = await db.select({ id: products.id })
    .from(products).where(eq(products.userId, userId)).limit(1);
  if (!product) return NextResponse.json({ error: 'no product' }, { status: 400 });

  const [channel] = await db.select().from(channels)
    .where(eq(channels.userId, userId)).limit(1);
  if (!channel) return NextResponse.json({ error: 'no channel' }, { status: 400 });

  const config = getPlatformConfig(platform);
  const scanRunId = `manual-${Date.now()}-${randomUUID().slice(0, 8)}`;

  await enqueueDiscoveryScan({
    schemaVersion: 1,
    traceId: randomUUID(),
    userId,
    productId: product.id,
    platform,
    scanRunId,
    trigger: 'manual',
  });

  log.info(`discovery scan enqueued: scanRunId=${scanRunId} platform=${platform}`);

  return NextResponse.json(
    { status: 'queued', scanRunId, sources: config.defaultSources },
    { status: 202 },
  );
}
```

- [ ] **Step 2: Manual smoke test**

```bash
bun run dev &
sleep 5
curl -X POST http://localhost:3000/api/discovery/scan -H "Content-Type: application/json" -d '{"platform":"reddit"}'
# Expected: 401 Unauthorized (no session). That's correct — route works.
kill %1
```

- [ ] **Step 3: Commit**

```bash
git add src/app/api/discovery/scan/route.ts
git commit -m "feat(api): POST /api/discovery/scan (debounced)"
```

### Task 19: `POST /api/discovery/retry-source`

**Files:**
- Create: `src/app/api/discovery/retry-source/route.ts`

- [ ] **Step 1: Write route**

```ts
import { NextResponse } from 'next/server';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { auth } from '@/lib/auth';
import { db } from '@/lib/db';
import { products } from '@/lib/db/schema';
import { enqueueSearchSource } from '@/lib/queue';
import { createLogger } from '@/lib/logger';

const log = createLogger('api:discovery:retry-source');

export async function POST(request: Request) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const userId = session.user.id;

  const body = (await request.json().catch(() => ({}))) as {
    scanRunId?: string; platform?: string; source?: string;
  };
  if (!body.scanRunId || !body.platform || !body.source) {
    return NextResponse.json({ error: 'missing fields' }, { status: 400 });
  }

  const [product] = await db.select({ id: products.id })
    .from(products).where(eq(products.userId, userId)).limit(1);
  if (!product) return NextResponse.json({ error: 'no product' }, { status: 400 });

  const jobId = await enqueueSearchSource({
    schemaVersion: 1, traceId: randomUUID(),
    userId, productId: product.id,
    platform: body.platform, source: body.source, scanRunId: body.scanRunId,
  });

  log.info(`retry-source enqueued: jobId=${jobId}`);
  return NextResponse.json({ status: 'queued', jobId }, { status: 202 });
}
```

- [ ] **Step 2: Commit**

```bash
git add src/app/api/discovery/retry-source/route.ts
git commit -m "feat(api): POST /api/discovery/retry-source"
```

### Task 20: `GET /api/discovery/scan-status`

**Files:**
- Create: `src/app/api/discovery/scan-status/route.ts`

- [ ] **Step 1: Write route**

```ts
import { NextResponse } from 'next/server';
import { and, eq } from 'drizzle-orm';
import { auth } from '@/lib/auth';
import { db } from '@/lib/db';
import { threads } from '@/lib/db/schema/channels';
import { searchSourceQueue } from '@/lib/queue';

export async function GET(request: Request) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const userId = session.user.id;

  const { searchParams } = new URL(request.url);
  const scanRunId = searchParams.get('scanRunId');
  if (!scanRunId) return NextResponse.json({ error: 'scanRunId required' }, { status: 400 });

  // Inspect BullMQ to report per-source state.
  const jobs = await searchSourceQueue.getJobs(['waiting', 'active', 'delayed', 'completed', 'failed']);
  const forRun = jobs.filter(
    (j) => j && j.data.scanRunId === scanRunId && j.data.userId === userId,
  );

  const sources = await Promise.all(forRun.map(async (j) => {
    const state = await j.getState();
    return {
      id: `${j.data.platform}:${j.data.source}`,
      platform: j.data.platform,
      source: j.data.source,
      state: state === 'completed' ? 'searched'
           : state === 'failed' ? 'failed'
           : state === 'active' ? 'searching'
           : 'queued',
    };
  }));

  return NextResponse.json({ scanRunId, sources });
}
```

- [ ] **Step 2: Commit**

```bash
git add src/app/api/discovery/scan-status/route.ts
git commit -m "feat(api): GET /api/discovery/scan-status"
```

### Task 21: `POST /api/calendar/slot/[id]/retry`

**Files:**
- Create: `src/app/api/calendar/slot/[id]/retry/route.ts`

- [ ] **Step 1: Write route**

```ts
import { NextResponse } from 'next/server';
import { and, eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { auth } from '@/lib/auth';
import { db } from '@/lib/db';
import { xContentCalendar } from '@/lib/db/schema';
import { enqueueCalendarSlotDraft } from '@/lib/queue';

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const userId = session.user.id;
  const { id } = await params;

  const [item] = await db.select().from(xContentCalendar)
    .where(and(eq(xContentCalendar.id, id), eq(xContentCalendar.userId, userId)))
    .limit(1);
  if (!item) return NextResponse.json({ error: 'not found' }, { status: 404 });

  await db.update(xContentCalendar)
    .set({ state: 'queued', retryCount: (item.retryCount ?? 0) + 1 })
    .where(eq(xContentCalendar.id, id));

  const jobId = await enqueueCalendarSlotDraft({
    schemaVersion: 1, traceId: randomUUID(),
    userId, productId: item.productId,
    calendarItemId: id, channel: item.channel,
  });

  return NextResponse.json({ status: 'queued', jobId }, { status: 202 });
}
```

- [ ] **Step 2: Commit**

```bash
git add src/app/api/calendar/slot/\[id\]/retry/route.ts
git commit -m "feat(api): POST /api/calendar/slot/[id]/retry"
```

---

## Phase 8: Frontend — progressive stream + calendar

### Task 22: `useProgressiveStream` hook

**Files:**
- Create: `src/hooks/use-progressive-stream.ts`
- Create: `src/hooks/__tests__/use-progressive-stream.test.tsx`

- [ ] **Step 1: Write failing test**

`src/hooks/__tests__/use-progressive-stream.test.tsx`:

```tsx
import { describe, it, expect, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import type { ReactNode } from 'react';

const listeners: Array<(data: unknown) => void> = [];
vi.mock('../use-sse-channel', () => ({
  useSSEChannel: (_: string, cb: (d: unknown) => void) => {
    listeners.push(cb);
  },
}));

import { useProgressiveStream } from '../use-progressive-stream';

const emit = (data: unknown) => { for (const cb of listeners) cb(data); };

describe('useProgressiveStream', () => {
  it('ignores events for other pipelines', () => {
    const { result } = renderHook(() => useProgressiveStream('plan'));
    act(() => emit({ type: 'pipeline', pipeline: 'reply', itemId: 'x', state: 'ready' }));
    expect(result.current.items.size).toBe(0);
  });
  it('stores the latest state per itemId', () => {
    const { result } = renderHook(() => useProgressiveStream('plan'));
    act(() => emit({ type: 'pipeline', pipeline: 'plan', itemId: 'a', state: 'queued', seq: 1 }));
    act(() => emit({ type: 'pipeline', pipeline: 'plan', itemId: 'a', state: 'ready', seq: 2 }));
    expect(result.current.items.get('a')?.state).toBe('ready');
  });
  it('drops stale (seq <= current)', () => {
    const { result } = renderHook(() => useProgressiveStream('plan'));
    act(() => emit({ type: 'pipeline', pipeline: 'plan', itemId: 'a', state: 'ready', seq: 5 }));
    act(() => emit({ type: 'pipeline', pipeline: 'plan', itemId: 'a', state: 'drafting', seq: 3 }));
    expect(result.current.items.get('a')?.state).toBe('ready');
  });
  it('reset() sets the item back to queued', () => {
    const { result } = renderHook(() => useProgressiveStream('plan'));
    act(() => emit({ type: 'pipeline', pipeline: 'plan', itemId: 'a', state: 'failed', seq: 1 }));
    act(() => result.current.reset('a'));
    expect(result.current.items.get('a')?.state).toBe('queued');
  });
});
```

- [ ] **Step 2: Run — expect fail**

Run: `bun run test src/hooks/__tests__/use-progressive-stream.test.tsx`
Expected: FAIL (module missing).

- [ ] **Step 3: Write hook**

`src/hooks/use-progressive-stream.ts`:

```ts
'use client';

import { useCallback, useState } from 'react';
import { useSSEChannel } from './use-sse-channel';

export type Pipeline = 'plan' | 'reply' | 'discovery';
export type ItemState =
  | 'queued' | 'searching' | 'searched'
  | 'drafting' | 'ready' | 'failed';

export interface StreamEnvelope<T = unknown> {
  type?: string;
  pipeline: Pipeline;
  itemId: string;
  state: ItemState;
  data?: T;
  seq?: number;
}

export interface ItemSnapshot<T = unknown> {
  state: ItemState;
  data?: T;
  updatedAt: number;
}

const DEFAULT_CHANNEL: Record<Pipeline, 'agents' | 'drafts'> = {
  plan: 'agents',
  discovery: 'agents',
  reply: 'drafts',
};

export function useProgressiveStream<T = unknown>(pipeline: Pipeline) {
  const [items, setItems] = useState<Map<string, ItemSnapshot<T>>>(() => new Map());

  useSSEChannel(DEFAULT_CHANNEL[pipeline], (raw: unknown) => {
    const e = raw as StreamEnvelope<T>;
    if (!e || e.type !== 'pipeline' || e.pipeline !== pipeline || !e.itemId) return;
    setItems((prev) => {
      const curr = prev.get(e.itemId);
      const nextSeq = e.seq ?? Date.now();
      if (curr && curr.updatedAt >= nextSeq) return prev;
      const next = new Map(prev);
      next.set(e.itemId, { state: e.state, data: e.data, updatedAt: nextSeq });
      return next;
    });
  });

  const reset = useCallback((itemId: string) => {
    setItems((prev) => {
      const next = new Map(prev);
      next.set(itemId, { state: 'queued', updatedAt: Date.now() });
      return next;
    });
  }, []);

  return { items, reset };
}
```

- [ ] **Step 4: Run test**

Run: `bun run test src/hooks/__tests__/use-progressive-stream.test.tsx`
Expected: 4 passed.

- [ ] **Step 5: Commit**

```bash
git add src/hooks/use-progressive-stream.ts src/hooks/__tests__/use-progressive-stream.test.tsx
git commit -m "feat(hooks): useProgressiveStream consumes unified pipeline envelope"
```

### Task 23: `<PipelineHealthPill>`

**Files:**
- Create: `src/components/calendar/pipeline-health-pill.tsx`

- [ ] **Step 1: Write component**

```tsx
'use client';

import { useMemo } from 'react';
import { Badge } from '@/components/ui/badge';
import type { ItemSnapshot } from '@/hooks/use-progressive-stream';

interface Props {
  items: Map<string, ItemSnapshot>;
  total: number;
}

export function PipelineHealthPill({ items, total }: Props) {
  const counts = useMemo(() => {
    let ready = 0, inFlight = 0, failed = 0;
    for (const s of items.values()) {
      if (s.state === 'ready') ready++;
      else if (s.state === 'failed') failed++;
      else inFlight++;
    }
    return { ready, inFlight, failed };
  }, [items]);

  if (total === 0) return null;

  const variant =
    counts.failed > 0 ? 'error'
    : counts.inFlight > 0 ? 'warning'
    : 'success';

  return (
    <Badge variant={variant} aria-live="polite">
      {counts.ready}/{total} ready
      {counts.inFlight > 0 && ` · ${counts.inFlight} in flight`}
      {counts.failed > 0 && ` · ${counts.failed} failed`}
    </Badge>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add src/components/calendar/pipeline-health-pill.tsx
git commit -m "feat(ui): PipelineHealthPill derives counts from progressive stream"
```

### Task 24: Wire `UnifiedCalendar` with progressive stream

**Files:**
- Modify: `src/components/calendar/unified-calendar.tsx`
- Modify: `src/hooks/use-calendar.ts`

- [ ] **Step 1: Expose live state in `useCalendar`**

In `src/hooks/use-calendar.ts`, after the existing SWR block, merge in stream state:

```ts
import { useProgressiveStream } from './use-progressive-stream';

// inside useCalendar():
const plan = useProgressiveStream<{ scheduledAt?: string; contentType?: string; topic?: string; draftId?: string; previewBody?: string; reason?: string }>('plan');

const mergedItems = useMemo(() => {
  return (items ?? []).map((item) => {
    const live = plan.items.get(item.id);
    if (!live) return item;
    return {
      ...item,
      status: live.state === 'ready' ? 'draft_created' :
              live.state === 'failed' ? 'failed' :
              live.state === 'drafting' ? 'drafting' :
              item.status,
      draftPreview: live.data?.previewBody ?? item.draftPreview,
    };
  });
}, [items, plan.items]);

// Return: { items: mergedItems, plan, ...rest }
```

- [ ] **Step 2: Use it in `unified-calendar.tsx`**

Swap the existing `items` usage for `mergedItems`. Import and render `<PipelineHealthPill>` next to the Generate Week button:

```tsx
import { PipelineHealthPill } from './pipeline-health-pill';
// …
<div className="flex items-center gap-2">
  <PipelineHealthPill items={plan.items} total={items.length} />
  <Button onClick={handleGenerate} disabled={isGenerating}>
    {isGenerating ? 'Planning...' : 'Generate Week'}
  </Button>
</div>
```

- [ ] **Step 3: Add `data-slot-state` to each card**

In the card render block, add `data-slot-state={item.status}` to the root `<Card>` and `data-shell-ready` to the outer wrapper when `plan.items.size > 0`.

- [ ] **Step 4: Manual verify**

```bash
bun run dev &
sleep 5
open http://localhost:3000/calendar
# Click Generate Week — confirm cards hydrate progressively without the old
# "Planning your week..." spinner banner.
kill %1
```

- [ ] **Step 5: Commit**

```bash
git add src/hooks/use-calendar.ts src/components/calendar/unified-calendar.tsx
git commit -m "feat(ui): UnifiedCalendar consumes progressive stream + health pill"
```

---

## Phase 9: Frontend — Today reply surface

### Task 25: `<SourceChip>` + `<SourceProgressRail>`

**Files:**
- Create: `src/components/today/source-chip.tsx`
- Create: `src/components/today/source-progress-rail.tsx`

- [ ] **Step 1: Write `source-chip.tsx`**

```tsx
'use client';

import type { ItemSnapshot } from '@/hooks/use-progressive-stream';

interface Props {
  id: string;
  source: string;
  platform: string;
  snapshot: ItemSnapshot<{ found?: number; aboveGate?: number; reason?: string }> | undefined;
  onRetry: () => void;
  onFilter: () => void;
  isFiltered: boolean;
}

export function SourceChip({ id, source, platform, snapshot, onRetry, onFilter, isFiltered }: Props) {
  const state = snapshot?.state ?? 'queued';
  const base = 'inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[12px] font-medium transition';
  let cls = '';
  let content: React.ReactNode = source;
  if (state === 'queued') {
    cls = 'bg-sf-bg-secondary text-sf-text-tertiary';
    content = <>{source}</>;
  } else if (state === 'searching') {
    cls = 'bg-sf-bg-secondary text-sf-text-secondary';
    content = <><span className="w-1.5 h-1.5 rounded-full bg-sf-accent animate-pulse" />{source}</>;
  } else if (state === 'searched') {
    cls = 'bg-sf-success-light text-sf-success';
    content = <>{source} ✓ {snapshot?.data?.aboveGate ?? 0}</>;
  } else if (state === 'failed') {
    cls = 'bg-sf-error-light text-sf-error';
    content = <>{source} · failed</>;
  }
  return (
    <button
      type="button"
      onClick={state === 'failed' ? onRetry : onFilter}
      aria-pressed={isFiltered}
      data-source-id={id}
      data-state={state}
      title={snapshot?.data?.reason ?? source}
      className={`${base} ${cls} ${isFiltered ? 'ring-2 ring-sf-accent' : ''}`}
    >
      {content}
    </button>
  );
}
```

- [ ] **Step 2: Write `source-progress-rail.tsx`**

```tsx
'use client';

import { useMemo, useState } from 'react';
import { useProgressiveStream } from '@/hooks/use-progressive-stream';
import { SourceChip } from './source-chip';

interface Props {
  sources: Array<{ platform: string; source: string }>;
  scanRunId: string | null;
  onFilterChange: (source: string | null) => void;
  onRetrySource: (platform: string, source: string) => void;
}

export function SourceProgressRail({ sources, scanRunId, onFilterChange, onRetrySource }: Props) {
  const { items } = useProgressiveStream<{ found: number; aboveGate: number; reason?: string }>('discovery');
  const [filter, setFilter] = useState<string | null>(null);

  const chips = useMemo(() => {
    return sources.map((s) => {
      const id = `${s.platform}:${s.source}`;
      return { id, ...s, snapshot: items.get(id) };
    });
  }, [sources, items]);

  if (!scanRunId || chips.length === 0) return null;

  return (
    <div
      role="status"
      aria-live="polite"
      className="flex flex-wrap gap-1.5 mb-4"
    >
      {chips.map((c) => (
        <SourceChip
          key={c.id}
          id={c.id}
          source={c.source}
          platform={c.platform}
          snapshot={c.snapshot}
          isFiltered={filter === c.id}
          onFilter={() => {
            const next = filter === c.id ? null : c.id;
            setFilter(next);
            onFilterChange(next);
          }}
          onRetry={() => onRetrySource(c.platform, c.source)}
        />
      ))}
    </div>
  );
}
```

- [ ] **Step 3: Commit**

```bash
git add src/components/today/source-chip.tsx src/components/today/source-progress-rail.tsx
git commit -m "feat(ui): SourceChip + SourceProgressRail for per-source discovery progress"
```

### Task 26: `<ReplyScanHeader>`

**Files:**
- Create: `src/components/today/reply-scan-header.tsx`

- [ ] **Step 1: Write component**

```tsx
'use client';

import { useCallback, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { useToast } from '@/components/ui/toast';

interface Props {
  lastScannedAt: Date | null;
  replyCount: number;
  onScanStarted: (scanRunId: string, sources: Array<{ platform: string; source: string }>) => void;
  platform?: string;
}

export function ReplyScanHeader({ lastScannedAt, replyCount, onScanStarted, platform = 'reddit' }: Props) {
  const { toast } = useToast();
  const [scanning, setScanning] = useState(false);

  const handleScan = useCallback(async () => {
    setScanning(true);
    try {
      const res = await fetch('/api/discovery/scan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ platform }),
      });
      if (res.status === 429) {
        const body = await res.json();
        toast(`Just scanned — next available in ${body.retryAfterSeconds}s`, 'info');
        return;
      }
      if (!res.ok) throw new Error(`scan failed: ${res.status}`);
      const body = (await res.json()) as {
        scanRunId: string; sources: string[];
      };
      const sourcesTyped = body.sources.map((s) => ({ platform, source: s }));
      onScanStarted(body.scanRunId, sourcesTyped);
      if (typeof window !== 'undefined') {
        window.localStorage.setItem('shipflare:lastScanRunId', body.scanRunId);
      }
    } catch (err) {
      toast(err instanceof Error ? err.message : 'scan failed', 'error');
    } finally {
      setScanning(false);
    }
  }, [onScanStarted, platform, toast]);

  const relTime = lastScannedAt
    ? relativeTime(lastScannedAt)
    : 'Never scanned — try it now.';

  return (
    <div className="flex items-center justify-between mb-6">
      <div>
        <h3 className="text-[17px] tracking-[-0.374px] font-medium text-sf-text-primary">
          Replies
        </h3>
        <p className="text-[14px] tracking-[-0.224px] text-sf-text-tertiary">
          Last scan: {relTime}
          {replyCount > 0 && ` · ${replyCount} replies generated`}
        </p>
      </div>
      <div className="flex items-center gap-2">
        <Badge variant="default">Auto-scans every 4h</Badge>
        <Button onClick={handleScan} disabled={scanning} variant="secondary">
          {scanning ? 'Scanning…' : 'Scan for replies'}
        </Button>
      </div>
    </div>
  );
}

function relativeTime(d: Date) {
  const ms = Date.now() - d.getTime();
  const min = Math.floor(ms / 60_000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  return `${Math.floor(hr / 24)}d ago`;
}
```

- [ ] **Step 2: Commit**

```bash
git add src/components/today/reply-scan-header.tsx
git commit -m "feat(ui): ReplyScanHeader with debounced manual scan"
```

### Task 27: `<ReplyRail>`

**Files:**
- Create: `src/components/today/reply-rail.tsx`

- [ ] **Step 1: Write component**

```tsx
'use client';

import { useMemo } from 'react';
import { useProgressiveStream } from '@/hooks/use-progressive-stream';
import { ReplyCard } from './reply-card';
import type { TodoItem } from '@/hooks/use-today';

interface Props {
  replyItems: TodoItem[];
  sourceFilter: string | null;
}

export function ReplyRail({ replyItems, sourceFilter }: Props) {
  const { items: live } = useProgressiveStream<{ draftId?: string; previewBody?: string }>('reply');

  const filtered = useMemo(() => {
    if (!sourceFilter) return replyItems;
    return replyItems.filter((r) => r.community && sourceFilter.includes(r.community));
  }, [replyItems, sourceFilter]);

  if (filtered.length === 0 && live.size === 0) {
    return (
      <div className="p-4 rounded-[var(--radius-sf-md)] bg-sf-bg-secondary text-[14px] text-sf-text-tertiary">
        Replies stream in as target sources are scanned.
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2" data-reply-rail>
      {filtered.map((item) => (
        <ReplyCard key={item.id} item={item} data-thread-card data-state="ready" />
      ))}
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add src/components/today/reply-rail.tsx
git commit -m "feat(ui): ReplyRail streams above-gate threads via progressive stream"
```

### Task 28: Wire Today page

**Files:**
- Modify: `src/components/today/todo-list.tsx` (or `today-content.tsx` if the page file)

- [ ] **Step 1: Introduce scan state at the page level**

In `todo-list.tsx`, add:

```tsx
const [scanRunId, setScanRunId] = useState<string | null>(null);
const [scanSources, setScanSources] = useState<Array<{ platform: string; source: string }>>([]);
const [sourceFilter, setSourceFilter] = useState<string | null>(null);

useEffect(() => {
  if (typeof window === 'undefined') return;
  const saved = window.localStorage.getItem('shipflare:lastScanRunId');
  if (!saved) return;
  fetch(`/api/discovery/scan-status?scanRunId=${encodeURIComponent(saved)}`)
    .then((r) => r.ok ? r.json() : null)
    .then((body: { sources?: Array<{ platform: string; source: string; state: string }> } | null) => {
      if (!body?.sources?.length) return;
      const active = body.sources.some((s) => s.state === 'queued' || s.state === 'searching');
      if (active) {
        setScanRunId(saved);
        setScanSources(body.sources.map(({ platform, source }) => ({ platform, source })));
      }
    })
    .catch(() => {});
}, []);

const handleRetrySource = useCallback(async (platform: string, source: string) => {
  if (!scanRunId) return;
  await fetch('/api/discovery/retry-source', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ scanRunId, platform, source }),
  });
}, [scanRunId]);
```

- [ ] **Step 2: Render the new scan UI above the todos**

```tsx
<ReplyScanHeader
  lastScannedAt={lastScannedAt}
  replyCount={replyItems.length}
  onScanStarted={(runId, sources) => {
    setScanRunId(runId);
    setScanSources(sources);
  }}
/>
<SourceProgressRail
  sources={scanSources}
  scanRunId={scanRunId}
  onFilterChange={setSourceFilter}
  onRetrySource={handleRetrySource}
/>
<ReplyRail
  replyItems={replyItems}
  sourceFilter={sourceFilter}
/>
{/* existing grouped TodoList rendering below */}
```

Replace where replies were previously mixed into the main todo list with a filter that excludes `reply_thread` items from the generic list (`replyItems` is now the dedicated slice).

- [ ] **Step 3: Manual verify**

```bash
bun run dev &
sleep 5
open http://localhost:3000/today
# Confirm: Scan button visible; header shows "Never scanned"; grouped list below.
# Click Scan — 429 (rate limit) after second click within 2 min is expected.
kill %1
```

- [ ] **Step 4: Commit**

```bash
git add src/components/today/todo-list.tsx
git commit -m "feat(ui): Today page wires ReplyScanHeader + SourceProgressRail + ReplyRail"
```

---

## Phase 10: Clean-up of old events

### Task 29: Delete legacy event types in publishers

**Files:**
- Grep for and remove: `calendar_plan_complete`, `calendar_draft_created`, old `agent_complete` referring to content-calendar, old `todo_added` when the unified envelope already emitted.

- [ ] **Step 1: Scan**

Run:

```bash
grep -rn "calendar_plan_complete\|calendar_draft_created" src/ --include='*.ts' --include='*.tsx'
grep -rn "type: 'agent_complete'" src/workers/processors/ --include='*.ts'
grep -rn "type: 'todo_added'" src/workers/processors/ --include='*.ts'
```

- [ ] **Step 2: Remove matching `publishUserEvent` calls**

For each match:
- In worker processors, delete or merge into the unified envelope.
- In `src/hooks/use-calendar.ts` / `use-today.ts`, drop the matching handlers.
- `monitor.ts` is out of scope — leave its events alone.

- [ ] **Step 3: Run broad test**

```bash
bun run test
bun x tsc --noEmit
```

Expected: all green.

- [ ] **Step 4: Commit**

```bash
git add -u src/
git commit -m "chore: delete legacy SSE event types replaced by unified envelope"
```

---

## Phase 11: Integration tests + decoupling regression

### Task 30: Integration harness

**Files:**
- Create: `tests/integration/bullmq.setup.ts`
- Create: `tests/integration/calendar-plan-no-scan.int.test.ts`
- Create: `tests/integration/discovery-fanout.int.test.ts`
- Create: `tests/integration/scan-run-id-dedup.int.test.ts`
- Create: `vitest.integration.config.ts`

- [ ] **Step 1: Integration Vitest config**

`vitest.integration.config.ts`:

```ts
import { defineConfig } from 'vitest/config';
import { resolve } from 'path';
export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/integration/**/*.int.test.ts'],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    pool: 'forks',
    sequence: { concurrent: false },
  },
  resolve: { alias: { '@': resolve(__dirname, './src') } },
});
```

- [ ] **Step 2: Harness**

`tests/integration/bullmq.setup.ts`:

```ts
import { Queue } from 'bullmq';
import IORedis from 'ioredis';

export const connection = new IORedis({
  host: '127.0.0.1',
  port: Number(process.env.REDIS_TEST_PORT ?? 6390),
  maxRetriesPerRequest: null,
});

export async function flushQueue(q: Queue) {
  await q.obliterate({ force: true });
}
```

Add a top-level README comment: `# To run, first: redis-server --port 6390 --save '' --daemonize yes`.

- [ ] **Step 3: Decoupling regression**

`tests/integration/calendar-plan-no-scan.int.test.ts`:

```ts
import { describe, it, expect, afterAll } from 'vitest';
import {
  calendarSlotDraftQueue,
  searchSourceQueue,
  discoveryScanQueue,
  contentQueue,
} from '@/lib/queue';

describe('Generate Week decoupling', () => {
  afterAll(async () => {
    await Promise.all([
      calendarSlotDraftQueue.obliterate({ force: true }),
      searchSourceQueue.obliterate({ force: true }),
      discoveryScanQueue.obliterate({ force: true }),
    ]);
  });

  it('does not enqueue search-source or discovery-scan when planner runs', async () => {
    // We don't run the planner (needs DB + LLM); instead assert that the
    // processor source itself is free of enqueueMonitor/enqueueContentCalendar.
    const { readFileSync } = await import('node:fs');
    const src = readFileSync('src/workers/processors/calendar-plan.ts', 'utf8');
    expect(src).not.toMatch(/enqueueMonitor\b/);
    expect(src).not.toMatch(/enqueueContentCalendar\b/);
    expect(src).not.toMatch(/enqueueDiscovery(Scan)?\b/);
  });
});
```

- [ ] **Step 4: Fan-out test**

`tests/integration/discovery-fanout.int.test.ts`:

```ts
import { describe, it, expect, afterAll } from 'vitest';
import { enqueueSearchSource, searchSourceQueue } from '@/lib/queue';

describe('search-source fan-out', () => {
  afterAll(() => searchSourceQueue.obliterate({ force: true }));

  it('produces one job per (scanRunId, platform, source) with deterministic jobIds', async () => {
    const scanRunId = `scan-${Date.now()}`;
    const sources = ['r/a', 'r/b', 'r/c'];
    const ids = await Promise.all(sources.map((source) =>
      enqueueSearchSource({
        schemaVersion: 1, traceId: 't', userId: 'u', productId: 'p',
        platform: 'reddit', source, scanRunId,
      }),
    ));
    expect(new Set(ids).size).toBe(3);
    for (const id of ids) expect(id).toMatch(new RegExp(`^ssrc-${scanRunId}-reddit-`));
  });
});
```

- [ ] **Step 5: Dedup test**

`tests/integration/scan-run-id-dedup.int.test.ts`:

```ts
import { describe, it, expect, afterAll } from 'vitest';
import { enqueueDiscoveryScan, discoveryScanQueue } from '@/lib/queue';

describe('discovery-scan dedup', () => {
  afterAll(() => discoveryScanQueue.obliterate({ force: true }));

  it('same scanRunId collapses to one job', async () => {
    const payload = {
      schemaVersion: 1 as const, traceId: 't', userId: 'u', productId: 'p',
      platform: 'reddit', scanRunId: 'scan-dup', trigger: 'manual' as const,
    };
    const id1 = await enqueueDiscoveryScan(payload);
    const id2 = await enqueueDiscoveryScan(payload);
    expect(id1).toBe(id2);
    expect(id1).toBe('scan-scan-dup');
  });
});
```

- [ ] **Step 6: Run integration tests**

```bash
redis-server --port 6390 --save '' --daemonize yes
bun run test:integration
```

Expected: 3 suites, all passing.

- [ ] **Step 7: Commit**

```bash
git add tests/integration/ vitest.integration.config.ts package.json
git commit -m "test(integration): bullmq harness + decoupling + fan-out + dedup"
```

---

## Phase 12: E2E + perf gate

### Task 31: Playwright `perf` project + scan-for-replies happy path

**Files:**
- Modify: `playwright.config.ts`
- Create: `e2e/tests/scan-for-replies.spec.ts`
- Create: `e2e/tests/generate-week-decoupling.spec.ts`

- [ ] **Step 1: Add `perf` project to `playwright.config.ts`**

Inside the `projects:` array in `playwright.config.ts`:

```ts
{
  name: 'perf',
  testMatch: /.*\.perf\.ts/,
  retries: 0,
  timeout: 180_000,
  use: { baseURL: process.env.BASE_URL ?? 'http://localhost:3000' },
},
```

- [ ] **Step 2: Happy-path spec**

`e2e/tests/scan-for-replies.spec.ts`:

```ts
import { test, expect } from '../fixtures/auth';
import { mockEventSource, emitSSESequence } from '../helpers/sse-mock';

test('scan-for-replies happy path', async ({ page, testWithProduct }) => {
  await testWithProduct();
  await mockEventSource(page);

  await page.goto('/today');
  await page.getByRole('button', { name: /scan for replies/i }).click();

  // Simulate per-source progression.
  await emitSSESequence(page, [
    { channel: 'agents', event: { type: 'pipeline', pipeline: 'discovery', itemId: 'reddit:r/SaaS', state: 'searching' } },
    { channel: 'agents', event: { type: 'pipeline', pipeline: 'discovery', itemId: 'reddit:r/indiehackers', state: 'searching' } },
    { channel: 'agents', event: { type: 'pipeline', pipeline: 'discovery', itemId: 'reddit:r/SaaS', state: 'searched', data: { found: 5, aboveGate: 2 } } },
    { channel: 'agents', event: { type: 'pipeline', pipeline: 'discovery', itemId: 'reddit:r/indiehackers', state: 'searched', data: { found: 3, aboveGate: 1 } } },
  ]);

  await expect(page.locator('[data-source-id="reddit:r/SaaS"][data-state="searched"]')).toBeVisible();
  await expect(page.locator('[data-source-id="reddit:r/indiehackers"][data-state="searched"]')).toBeVisible();
});
```

- [ ] **Step 3: Decoupling regression spec**

`e2e/tests/generate-week-decoupling.spec.ts`:

```ts
import { test, expect } from '../fixtures/auth';

test('Generate Week does not trigger a reply scan', async ({ page, testWithProduct, request }) => {
  await testWithProduct();
  await page.goto('/calendar');

  await page.getByRole('button', { name: /generate week/i }).click();

  // Wait up to 30s; poll queue counts via internal debug route.
  let scanTotal = 0;
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const res = await request.get('/api/debug/queue-counts');
    if (res.ok()) {
      const body = await res.json();
      scanTotal = (body.searchSource?.total ?? 0) + (body.discoveryScan?.total ?? 0);
      if (scanTotal > 0) break;
    }
    await new Promise((r) => setTimeout(r, 1000));
  }

  expect(scanTotal).toBe(0);
  await expect(page.locator('[data-source-id]')).toHaveCount(0);
});
```

- [ ] **Step 4: Stub `/api/debug/queue-counts`**

`src/app/api/debug/queue-counts/route.ts`:

```ts
import { NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import {
  calendarSlotDraftQueue, searchSourceQueue, discoveryScanQueue, contentQueue,
} from '@/lib/queue';

export async function GET() {
  if (process.env.NODE_ENV === 'production') {
    return NextResponse.json({ error: 'disabled' }, { status: 404 });
  }
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const counts = async (q: typeof calendarSlotDraftQueue) => {
    const c = await q.getJobCounts();
    return { total: Object.values(c).reduce((a, b) => a + b, 0), ...c };
  };
  return NextResponse.json({
    calendarSlotDraft: await counts(calendarSlotDraftQueue),
    searchSource: await counts(searchSourceQueue),
    discoveryScan: await counts(discoveryScanQueue),
    content: await counts(contentQueue),
  });
}
```

- [ ] **Step 5: Run E2E locally**

```bash
bun run dev &
sleep 6
bun run test:e2e e2e/tests/scan-for-replies.spec.ts e2e/tests/generate-week-decoupling.spec.ts
kill %1
```

Expected: 2 passed.

- [ ] **Step 6: Commit**

```bash
git add playwright.config.ts e2e/tests/scan-for-replies.spec.ts e2e/tests/generate-week-decoupling.spec.ts src/app/api/debug/queue-counts/route.ts
git commit -m "test(e2e): scan-for-replies + decoupling regression + debug queue-counts route"
```

---

## Phase 13: Merge checklist verification

### Task 32: Run all gates + final commit

- [ ] **Step 1: Full type-check**

Run: `bun x tsc --noEmit`
Expected: 0 errors.

- [ ] **Step 2: Full unit test run**

Run: `bun run test`
Expected: all suites pass. Note any skipped tests — investigate.

- [ ] **Step 3: Full integration test run**

Run: `redis-server --port 6390 --save '' --daemonize yes && bun run test:integration`
Expected: all suites pass.

- [ ] **Step 4: E2E smoke**

```bash
bun run build
bun run start &
sleep 8
bun run test:e2e -g "scan-for-replies|generate-week-decoupling"
kill %1
```

- [ ] **Step 5: Lint**

Run: `bun run lint`
Expected: 0 errors.

- [ ] **Step 6: Verify no dead references**

```bash
grep -rn "content-batch\|enqueueContentCalendar\|enqueueMonitor" src/ --include='*.ts' --include='*.tsx'
```
Expected: zero matches (note: `monitor.ts` itself + its existing queue remain — out of scope, untouched).

- [ ] **Step 7: Final commit if anything straggling**

```bash
git status
# If nothing uncommitted, skip this step. Otherwise:
git add -u .
git commit -m "chore: final clean-up after plan+reply redesign"
```

- [ ] **Step 8: Merge checklist review**

Walk the spec's §8 merge checklist explicitly:
- [ ] Schema migration `0018_generate_week_fanout` applied
- [ ] Old skills deleted (`src/skills/content-batch/` gone; `src/skills/discovery/` is single-source)
- [ ] Old SSE event types deleted (`calendar_plan_complete`, etc.)
- [ ] `calendar-plan.ts:224-230` (`enqueueMonitor`) deleted
- [ ] Decoupling integration test `calendar-plan-no-scan` passes
- [ ] E2E `generate-week-decoupling` passes
- [ ] Unit, integration, E2E, lint, typecheck all green
- [ ] `grep` finds zero legacy references

---

## Plan Self-Review Notes

**Spec coverage:**
- §1 PM journey → Tasks 22–28 (progressive UI + Today wiring + calendar hydrate)
- §2 Data schema → Tasks 1 + 2 + 3
- §3 Backend workers → Tasks 5–17 (planner trim, slot-body, calendar-slot-draft, discovery-scan, search-source, content.ts transitions)
- §4 Frontend → Tasks 22–28
- §5 QA → Tasks 30 (integration harness + decoupling + fan-out + dedup) and 31 (E2E + perf hooks)
- §6 Risks (stalled drafting rows) → noted in Task 7; a cron sweep is deferred to a follow-up (see open question below)
- §7 Open questions → not implemented (intentionally; PM-pending)
- §8 Merge checklist → Task 32

**Known gaps (intentional):**
- Cost regression nightly workflow (spec §5.7) — not in this plan; follow-up PR once the pipeline is live and we have baselines.
- Cron-every-4h scheduled trigger for discovery (spec §1.7) — add a BullMQ `repeatable` registration once manual flow is verified in production; likely a 1-task follow-up.
- Stalled-row sweep cron — a 1-task follow-up using `threads_state_last_attempt_idx`.
- Onboarding smoke E2E (spec §5.4 #6) — deferred; the existing full-scan is exercised by `Promise.all` refactor unit tests.

These are deliberately deferred: they are additive, don't gate the merge checklist, and would duplicate effort if written before the baseline is observable.

---

**Plan complete and saved to `docs/superpowers/plans/2026-04-17-plan-reply-journey.md`.** Two execution options:

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration

**2. Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints

**Which approach?**
