# Growth page — real data, module-based progress dashboard — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the placeholder `/growth` page with a module-based progress dashboard showing per-channel activity (Threads / Drafts / Posts / Replies + meta line) for the live Social Marketing module, move Reddit subreddit management from `/settings` to `/growth`, and rewrite the health score as `per-channel → per-module → overall` so future modules (SEO, Content, etc.) plug in with one config-file change.

**Architecture:** Schema migration drops legacy `health_scores`, adds `channel_scores` + `module_scores` tables. A renamed worker (`growth-rollup`) computes rollups from existing `drafts` / `posts` / `threads` data (no new event types). A new `/api/growth/overview` returns a hierarchical shape; the rewritten Growth page composes a hero (overall dial + module strip) and a Social Marketing panel with two channel cards (X + Reddit). Reddit's subreddit management page moves verbatim from `/settings/reddit-channels` to `/growth/reddit-channels`.

**Tech Stack:** Next.js 15 App Router, TypeScript, Drizzle ORM + Postgres, BullMQ (Redis), SWR (client), Vitest (unit + API), Playwright (E2E). Design tokens in `src/app/globals.css` (`--sf-*`).

**Spec:** `docs/superpowers/specs/2026-05-12-growth-page-real-data-design.md`

**Open implementation question resolutions** (decided here):

1. **Threads attribution** — count via `drafts.thread_id → threads` join (only threads that produced drafts owned by this user). Under-counts slightly vs. all discovery results, but unambiguous and zero new instrumentation.
2. **Pending join cost** — no denormalization in v1; the `(user_id, status, created_at)` index plus the thread-platform join is acceptable. Revisit only if production traces show it.
3. **First rollup trigger** — daily cron only. Founder sees `—` on the dial until the first daily tick fires. Kickoff fan-out can be added later if the cold-start experience is too long.

---

## File map

**Created**
| Path | Responsibility |
|---|---|
| `drizzle/0030_growth_rollup_tables.sql` | Drop `health_scores`, create `channel_scores` + `module_scores` + indexes |
| `src/lib/db/schema/growth.ts` | Drizzle definitions for `channelScores` + `moduleScores` |
| `src/lib/growth-targets.ts` | Per-platform 7-day count targets |
| `src/lib/growth-modules.ts` | Module registry (Social live; Search/Performance/Content/Analytics planned) |
| `src/lib/growth-score.ts` | Pure scoring functions (`channelScore`, `moduleScore`, `overallScore`) |
| `src/lib/__tests__/growth-score.test.ts` | TDD tests for scoring math |
| `src/workers/processors/growth-rollup.ts` | Per-user rollup processor; supersedes `health-score.ts` |
| `src/workers/processors/__tests__/growth-rollup.test.ts` | Processor tests (DB-mocked + edge cases) |
| `src/app/api/growth/overview/route.ts` | GET endpoint returning hierarchical Growth shape |
| `src/app/api/growth/overview/__tests__/route.test.ts` | API tests (auth gate + cold start + happy path) |
| `src/app/(app)/growth/_components/overall-hero.tsx` | Dial + module strip card |
| `src/app/(app)/growth/_components/module-strip.tsx` | 5 module chips |
| `src/app/(app)/growth/_components/channel-card.tsx` | One platform's 4-metric grid + meta line |
| `src/app/(app)/growth/_components/subreddit-chips.tsx` | Reddit-only chip list + "Manage subreddits →" link |
| `src/app/(app)/growth/_components/social-panel.tsx` | Header + 2-up channel-card grid |
| `src/app/(app)/growth/reddit-channels/page.tsx` | Moved (verbatim copy) from `/settings/reddit-channels` |
| `e2e/tests/growth.spec.ts` | Playwright smoke for `/growth` |

**Modified**
| Path | Why |
|---|---|
| `src/lib/db/schema/index.ts` | Drop `healthScores` export, add `channelScores` + `moduleScores` |
| `src/lib/db/schema/drafts.ts` | Remove `healthScores` table definition |
| `src/lib/queue/types.ts` | Rename `healthScoreJobSchema` → `growthRollupJobSchema` w/ `kind` discriminator |
| `src/lib/queue/index.ts` | Rename `healthScoreQueue` → `growthRollupQueue` (string `'health-score'` stays); rename helper |
| `src/workers/index.ts` | Swap processor import + worker registration + add daily cron |
| `src/app/(app)/growth/growth-content.tsx` | Complete rewrite — composes new components |
| `src/app/(app)/settings/settings-content.tsx` | Delete `RedditIntegrationRow` + `RedditTileIcon` + Reddit row mount + `SettingsRedditChannel` type |
| `src/app/(app)/settings/page.tsx` | Delete `redditChannels` query + prop wiring |

**Deleted**
| Path | Why |
|---|---|
| `src/workers/processors/health-score.ts` | Replaced by `growth-rollup.ts` |
| `src/app/api/health/route.ts` | Replaced by `/api/growth/overview` |
| `src/app/(app)/settings/reddit-channels/page.tsx` | Moved to `/growth/reddit-channels/page.tsx` |

---

## Task 1: Schema migration — drop `health_scores`, add `channel_scores` + `module_scores`

**Files:**
- Create: `drizzle/0030_growth_rollup_tables.sql`

- [ ] **Step 1: Write the SQL migration**

```sql
-- drizzle/0030_growth_rollup_tables.sql
DROP TABLE IF EXISTS "health_scores";

CREATE TABLE IF NOT EXISTS "channel_scores" (
  "id" text PRIMARY KEY NOT NULL,
  "user_id" text NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "platform" text NOT NULL,
  "score" integer NOT NULL,
  "threads" integer NOT NULL,
  "drafts" integer NOT NULL,
  "posts" integer NOT NULL,
  "replies" integer NOT NULL,
  "pending" integer NOT NULL,
  "approve_rate" real,
  "last_post_at" timestamp,
  "calculated_at" timestamp DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS "channel_scores_user_platform_idx"
  ON "channel_scores" ("user_id", "platform", "calculated_at" DESC);

CREATE TABLE IF NOT EXISTS "module_scores" (
  "id" text PRIMARY KEY NOT NULL,
  "user_id" text NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "module_id" text NOT NULL,
  "score" integer NOT NULL,
  "calculated_at" timestamp DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS "module_scores_user_module_idx"
  ON "module_scores" ("user_id", "module_id", "calculated_at" DESC);
```

- [ ] **Step 2: Apply migration locally**

Run: `pnpm drizzle-kit push` (or `npx drizzle-kit push`)
Expected: `health_scores` dropped; `channel_scores` + `module_scores` created. No errors.

- [ ] **Step 3: Commit**

```bash
git add drizzle/0030_growth_rollup_tables.sql
git commit -m "feat(db): drop health_scores, add channel_scores + module_scores"
```

---

## Task 2: Drizzle schema — `channelScores` + `moduleScores`, drop `healthScores`

**Files:**
- Create: `src/lib/db/schema/growth.ts`
- Modify: `src/lib/db/schema/drafts.ts` (remove `healthScores` table block)
- Modify: `src/lib/db/schema/index.ts` (swap exports)

- [ ] **Step 1: Create `src/lib/db/schema/growth.ts`**

```ts
import {
  pgTable,
  text,
  timestamp,
  real,
  integer,
  index,
} from 'drizzle-orm/pg-core';
import { desc } from 'drizzle-orm';
import { users } from './users';

export const channelScores = pgTable(
  'channel_scores',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    platform: text('platform').notNull(),
    score: integer('score').notNull(),
    threads: integer('threads').notNull(),
    drafts: integer('drafts').notNull(),
    posts: integer('posts').notNull(),
    replies: integer('replies').notNull(),
    pending: integer('pending').notNull(),
    approveRate: real('approve_rate'),
    lastPostAt: timestamp('last_post_at', { mode: 'date' }),
    calculatedAt: timestamp('calculated_at', { mode: 'date' })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    index('channel_scores_user_platform_idx').on(
      t.userId,
      t.platform,
      desc(t.calculatedAt),
    ),
  ],
);

export const moduleScores = pgTable(
  'module_scores',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    moduleId: text('module_id').notNull(),
    score: integer('score').notNull(),
    calculatedAt: timestamp('calculated_at', { mode: 'date' })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    index('module_scores_user_module_idx').on(
      t.userId,
      t.moduleId,
      desc(t.calculatedAt),
    ),
  ],
);
```

- [ ] **Step 2: Remove `healthScores` from `src/lib/db/schema/drafts.ts`**

Delete the entire `healthScores` table definition (lines roughly 110–135). Keep `drafts`, `posts`, `activityEvents`.

- [ ] **Step 3: Update `src/lib/db/schema/index.ts` exports**

Remove `healthScores` from the existing `./drafts` re-export. Add a new line:

```ts
export { channelScores, moduleScores } from './growth';
```

- [ ] **Step 4: Type-check**

Run: `pnpm tsc --noEmit --pretty false`
Expected: compiles. If any `import { healthScores }` errors remain, the next tasks will fix them (the only current importer is `health-score.ts`, which we delete in Task 7).

- [ ] **Step 5: Commit**

```bash
git add src/lib/db/schema/growth.ts src/lib/db/schema/drafts.ts src/lib/db/schema/index.ts
git commit -m "feat(db): add channelScores + moduleScores Drizzle definitions; drop healthScores"
```

---

## Task 3: Growth targets config

**Files:**
- Create: `src/lib/growth-targets.ts`

- [ ] **Step 1: Write the config**

```ts
/**
 * Per-platform 7-day activity targets driving the Growth page health score.
 *
 * Each `ChannelTarget` field is the count that maps to "this metric is firing
 * at 100%". The score formula caps each component at 1.0 before averaging,
 * so blasting `threads` past 30 on X doesn't compensate for zero `posts`.
 *
 * These are first-cut numbers; tune empirically once we have ≥2 weeks of
 * rollup data per cohort.
 */
export interface ChannelTarget {
  threads: number;
  drafts: number;
  posts: number;
  replies: number;
}

export const GROWTH_TARGETS: Record<string, ChannelTarget> = {
  x: { threads: 30, drafts: 20, posts: 5, replies: 15 },
  reddit: { threads: 15, drafts: 10, posts: 3, replies: 8 },
};

export function getChannelTarget(platform: string): ChannelTarget | undefined {
  return GROWTH_TARGETS[platform];
}
```

- [ ] **Step 2: Commit**

```bash
git add src/lib/growth-targets.ts
git commit -m "feat(growth): add per-platform activity targets"
```

---

## Task 4: Growth modules registry

**Files:**
- Create: `src/lib/growth-modules.ts`

- [ ] **Step 1: Write the registry**

```ts
/**
 * Marketing module registry. One entry per agent-roster manager (see
 * docs/agent-roster-roadmap.md). `live: true` means the module ships
 * scoring/UI today; `live: false` renders as a "planned" placeholder
 * in the Growth page module strip.
 *
 * Adding a new module: append an entry, set `live: true` and list its
 * platform channels. The overall-score weight rebalances automatically
 * (1 / live-module-count, equal share).
 */
export type GrowthModuleId =
  | 'social'
  | 'search'
  | 'performance'
  | 'content'
  | 'analytics';

export interface GrowthModule {
  id: GrowthModuleId;
  displayName: string;
  managerTitle: string;
  live: boolean;
  channels: string[]; // platform ids — e.g. ['x', 'reddit']
}

export const GROWTH_MODULES: GrowthModule[] = [
  {
    id: 'social',
    displayName: 'Social marketing',
    managerTitle: 'Social Media Manager',
    live: true,
    channels: ['x', 'reddit'],
  },
  {
    id: 'search',
    displayName: 'Search',
    managerTitle: 'SEO Manager',
    live: false,
    channels: [],
  },
  {
    id: 'performance',
    displayName: 'Performance',
    managerTitle: 'Performance Marketing Manager',
    live: false,
    channels: [],
  },
  {
    id: 'content',
    displayName: 'Content',
    managerTitle: 'Content Marketing Manager',
    live: false,
    channels: [],
  },
  {
    id: 'analytics',
    displayName: 'Analytics',
    managerTitle: 'Marketing Analytics Manager',
    live: false,
    channels: [],
  },
];

export function liveModules(): GrowthModule[] {
  return GROWTH_MODULES.filter((m) => m.live);
}

export function getModule(id: GrowthModuleId): GrowthModule | undefined {
  return GROWTH_MODULES.find((m) => m.id === id);
}
```

- [ ] **Step 2: Commit**

```bash
git add src/lib/growth-modules.ts
git commit -m "feat(growth): add marketing module registry"
```

---

## Task 5: Score formula utility (TDD)

**Files:**
- Create: `src/lib/growth-score.ts`
- Test: `src/lib/__tests__/growth-score.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// src/lib/__tests__/growth-score.test.ts
import { describe, it, expect } from 'vitest';
import {
  channelScore,
  moduleScore,
  overallScore,
} from '../growth-score';

const TARGET = { threads: 30, drafts: 20, posts: 5, replies: 15 };

describe('channelScore', () => {
  it('returns 0 when all counts are 0', () => {
    expect(channelScore({ threads: 0, drafts: 0, posts: 0, replies: 0 }, TARGET)).toBe(0);
  });

  it('returns 100 when all targets are met exactly', () => {
    expect(channelScore({ threads: 30, drafts: 20, posts: 5, replies: 15 }, TARGET)).toBe(100);
  });

  it('caps each component at 1.0 before averaging', () => {
    // Threads 10x over target, others at 0 — capped at 1.0 → 25%
    expect(channelScore({ threads: 300, drafts: 0, posts: 0, replies: 0 }, TARGET)).toBe(25);
  });

  it('partial credit averages cleanly', () => {
    // threads 15/30 = 0.5, drafts 10/20 = 0.5, posts 0, replies 0 → 0.25 → 25
    expect(channelScore({ threads: 15, drafts: 10, posts: 0, replies: 0 }, TARGET)).toBe(25);
  });
});

describe('moduleScore', () => {
  it('returns 0 for an empty channel-score array', () => {
    expect(moduleScore([])).toBe(0);
  });

  it('averages enabled channel scores', () => {
    expect(moduleScore([80, 60])).toBe(70);
  });

  it('rounds the average', () => {
    expect(moduleScore([50, 51, 52])).toBe(51);
  });
});

describe('overallScore', () => {
  it('returns the only live module score when one module is live', () => {
    expect(overallScore([{ score: 74, weight: 1.0 }])).toBe(74);
  });

  it('weighted-averages multiple live modules', () => {
    expect(overallScore([
      { score: 80, weight: 0.5 },
      { score: 60, weight: 0.5 },
    ])).toBe(70);
  });

  it('returns 0 for an empty module list', () => {
    expect(overallScore([])).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test src/lib/__tests__/growth-score.test.ts`
Expected: FAIL with "Cannot find module '../growth-score'" or similar.

- [ ] **Step 3: Write the implementation**

```ts
// src/lib/growth-score.ts
import type { ChannelTarget } from './growth-targets';

export interface ChannelCounts {
  threads: number;
  drafts: number;
  posts: number;
  replies: number;
}

/**
 * Per-channel score (0-100). Each component is capped at 1.0 before averaging
 * so over-performing on one metric (e.g. threads spam) can never compensate
 * for zero on another.
 */
export function channelScore(counts: ChannelCounts, target: ChannelTarget): number {
  const cThreads = Math.min(1, counts.threads / target.threads);
  const cDrafts = Math.min(1, counts.drafts / target.drafts);
  const cPosts = Math.min(1, counts.posts / target.posts);
  const cReplies = Math.min(1, counts.replies / target.replies);
  return Math.round((100 * (cThreads + cDrafts + cPosts + cReplies)) / 4);
}

/** Module = arithmetic mean of enabled-channel scores (rounded). */
export function moduleScore(channelScores: number[]): number {
  if (channelScores.length === 0) return 0;
  const sum = channelScores.reduce((a, b) => a + b, 0);
  return Math.round(sum / channelScores.length);
}

/** Overall = sum(score × weight) across live modules. Empty list → 0. */
export function overallScore(modules: { score: number; weight: number }[]): number {
  if (modules.length === 0) return 0;
  return Math.round(modules.reduce((acc, m) => acc + m.score * m.weight, 0));
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test src/lib/__tests__/growth-score.test.ts`
Expected: all tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/growth-score.ts src/lib/__tests__/growth-score.test.ts
git commit -m "feat(growth): score formula utility (channel/module/overall)"
```

---

## Task 6: Rename queue type + helper

**Files:**
- Modify: `src/lib/queue/types.ts`
- Modify: `src/lib/queue/index.ts`

The BullMQ queue *name string* stays `'health-score'` (Redis stability — any in-flight job keeps draining). Only TypeScript symbols rename. We also add a `kind: 'fanout'` discriminator so a single processor handles both the cron entry and the per-user job (mirrors the metrics queue idiom).

- [ ] **Step 1: Update `src/lib/queue/types.ts`**

Locate the `healthScoreJobSchema` block (around line 61-67) and replace it with:

```ts
// ---------------------------------------------------------------------------
// Growth rollup (formerly: health-score)
//
// Two shapes:
//   - kind: 'fanout' — cron entry; processor iterates users w/ ≥1 channel
//                       and enqueues per-user jobs.
//   - kind: 'user'   — per-user rollup work.
// Queue name stays 'health-score' in Redis for stability with any in-flight
// schedule; the TS identifiers rename to match the new domain.
// ---------------------------------------------------------------------------

const growthRollupFanout = z.object({
  kind: z.literal('fanout'),
  schemaVersion: SCHEMA_VERSION,
  traceId: TRACE_ID,
});

const growthRollupUser = z.object({
  kind: z.literal('user').optional(),
  schemaVersion: SCHEMA_VERSION,
  traceId: TRACE_ID,
  userId: z.string().min(1),
});

export const growthRollupJobSchema = z.discriminatedUnion('kind', [
  growthRollupFanout,
  growthRollupUser.extend({ kind: z.literal('user') }),
]);
// Permit legacy payloads without `kind` (treated as 'user').
export type GrowthRollupJobData = z.input<typeof growthRollupUser> | z.input<typeof growthRollupFanout>;
```

Then update the AllJobData union near line 217 — replace `| HealthScoreJobData` with `| GrowthRollupJobData`.

- [ ] **Step 2: Update `src/lib/queue/index.ts`**

Replace the `healthScoreQueue` block + `enqueueHealthScore` helper with:

```ts
// Find the existing import line:
import type {
  // ... existing imports
  GrowthRollupJobData,   // was: HealthScoreJobData
  // ... rest
} from '../queue/types';

// Replace the queue declaration (was around line 69):
export const growthRollupQueue = new Queue<GrowthRollupJobData>('health-score', {
  // ... keep the existing options object unchanged
});

// Replace enqueueHealthScore (was around line 201):
export async function enqueueGrowthRollup(
  data: GrowthRollupJobData,
): Promise<void> {
  const payload = { schemaVersion: 1 as const, ...data };
  await growthRollupQueue.add(
    payload.kind === 'fanout' ? 'fanout' : 'calculate',
    payload,
    { /* keep existing job options */ },
  );
  log.debug(`Enqueued growth-rollup kind=${payload.kind ?? 'user'}`);
}
```

(Preserve the exact option object — only the names + the job-name string change. The job-name `'calculate'` for user jobs stays for log-trace parity; fanout uses `'fanout'`.)

- [ ] **Step 3: Type-check**

Run: `pnpm tsc --noEmit --pretty false`
Expected: errors about `processHealthScore` / `healthScoreWorker` / `HealthScoreJobData` in `src/workers/index.ts` (Task 8 fixes those).

- [ ] **Step 4: Commit**

```bash
git add src/lib/queue/types.ts src/lib/queue/index.ts
git commit -m "refactor(queue): rename health-score TS surface → growth-rollup; queue string unchanged"
```

---

## Task 7: Write the growth-rollup processor (TDD)

**Files:**
- Create: `src/workers/processors/growth-rollup.ts`
- Create: `src/workers/processors/__tests__/growth-rollup.test.ts`
- Delete: `src/workers/processors/health-score.ts`

Two failure modes the test must cover: (a) cold start (no drafts/posts/threads) → all counts 0, score 0, but rows are still inserted so the API can join them; (b) a connected channel hitting all targets → score 100; (c) capped components (one metric way over target) don't pull the average past its real ceiling.

- [ ] **Step 1: Write the failing test**

```ts
// src/workers/processors/__tests__/growth-rollup.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Job } from 'bullmq';

// In-memory rows seeded per test, returned by the mocked Drizzle chain.
type Seed = {
  threadCounts: Record<string, number>;        // platform → count
  draftCounts: Record<string, number>;
  postCounts: Record<string, number>;          // original_post
  replyCounts: Record<string, number>;
  pendingCounts: Record<string, number>;
  approved: Record<string, number>;
  skipped: Record<string, number>;
  lastPostAt: Record<string, Date | null>;
};

let seed: Seed = emptySeed();
const inserts: Array<{ table: string; row: Record<string, unknown> }> = [];

function emptySeed(): Seed {
  return {
    threadCounts: {},
    draftCounts: {},
    postCounts: {},
    replyCounts: {},
    pendingCounts: {},
    approved: {},
    skipped: {},
    lastPostAt: {},
  };
}

// Drizzle mock — branches on which builder chain was called.
// Each computeChannelCounts query is a small SELECT count(*); we route
// by the `_label` argument the processor passes via a where(eq(...))
// stand-in. Simplest path: the processor exports a tiny query helper
// per metric, and the mock returns the seed value for that metric.
//
// For this test we mock the helper module directly (cleaner than mocking
// drizzle).
vi.mock('@/workers/processors/lib/growth-counts', () => ({
  countThreads: vi.fn(async (_uid: string, platform: string) =>
    seed.threadCounts[platform] ?? 0,
  ),
  countDrafts: vi.fn(async (_uid: string, platform: string) =>
    seed.draftCounts[platform] ?? 0,
  ),
  countPosts: vi.fn(async (_uid: string, platform: string) =>
    seed.postCounts[platform] ?? 0,
  ),
  countReplies: vi.fn(async (_uid: string, platform: string) =>
    seed.replyCounts[platform] ?? 0,
  ),
  countPending: vi.fn(async (_uid: string, platform: string) =>
    seed.pendingCounts[platform] ?? 0,
  ),
  countApprovedSkipped: vi.fn(async (_uid: string, platform: string) => ({
    approved: seed.approved[platform] ?? 0,
    skipped: seed.skipped[platform] ?? 0,
  })),
  lastPostAt: vi.fn(async (_uid: string, platform: string) =>
    seed.lastPostAt[platform] ?? null,
  ),
}));

vi.mock('@/lib/db', () => ({
  db: {
    insert: (table: { _label?: string }) => ({
      values: async (row: Record<string, unknown>) => {
        inserts.push({ table: table._label ?? 'unknown', row });
      },
    }),
    select: () => ({
      from: () => ({
        where: () => ({
          orderBy: () => ({
            limit: async () => [],
          }),
        }),
      }),
    }),
  },
}));

vi.mock('@/lib/db/schema', () => ({
  channelScores: { _label: 'channel_scores' },
  moduleScores: { _label: 'module_scores' },
}));

vi.mock('@/lib/platform-config', () => ({
  listAvailablePlatforms: () => ['x', 'reddit'],
}));

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ debug() {}, info() {}, warn() {}, error() {} }),
  loggerForJob: (l: unknown) => l,
}));

import { processGrowthRollup } from '../growth-rollup';

function makeJob(userId: string): Job<{ kind: 'user'; userId: string; schemaVersion: 1 }> {
  return {
    id: 'job-1',
    data: { kind: 'user', userId, schemaVersion: 1 },
  } as unknown as Job<{ kind: 'user'; userId: string; schemaVersion: 1 }>;
}

beforeEach(() => {
  seed = emptySeed();
  inserts.length = 0;
});

describe('processGrowthRollup', () => {
  it('cold start — inserts zero rows for every platform + the social module', async () => {
    await processGrowthRollup(makeJob('user-1'));
    const channelRows = inserts.filter((i) => i.table === 'channel_scores');
    const moduleRows = inserts.filter((i) => i.table === 'module_scores');
    expect(channelRows).toHaveLength(2);
    expect(channelRows.every((r) => r.row.score === 0)).toBe(true);
    expect(channelRows.every((r) => r.row.threads === 0)).toBe(true);
    expect(channelRows.every((r) => r.row.approveRate === null)).toBe(true);
    expect(moduleRows).toHaveLength(1);
    expect(moduleRows[0].row.moduleId).toBe('social');
    expect(moduleRows[0].row.score).toBe(0);
  });

  it('all-targets-met — score is 100 per channel and per module', async () => {
    seed.threadCounts = { x: 30, reddit: 15 };
    seed.draftCounts = { x: 20, reddit: 10 };
    seed.postCounts = { x: 5, reddit: 3 };
    seed.replyCounts = { x: 15, reddit: 8 };
    await processGrowthRollup(makeJob('user-1'));
    const channelRows = inserts.filter((i) => i.table === 'channel_scores');
    expect(channelRows.every((r) => r.row.score === 100)).toBe(true);
    const moduleRow = inserts.find((i) => i.table === 'module_scores');
    expect(moduleRow!.row.score).toBe(100);
  });

  it('cap rule — over-targeting one metric does not boost the channel score past its real ceiling', async () => {
    seed.threadCounts = { x: 300, reddit: 0 }; // 10x over
    // Others 0 — channel score on X = 25 (1.0 capped on threads, 0 on others).
    await processGrowthRollup(makeJob('user-1'));
    const xRow = inserts.find(
      (i) => i.table === 'channel_scores' && i.row.platform === 'x',
    );
    expect(xRow!.row.score).toBe(25);
  });

  it('approve_rate denominator zero stays null in the row', async () => {
    await processGrowthRollup(makeJob('user-1'));
    const xRow = inserts.find(
      (i) => i.table === 'channel_scores' && i.row.platform === 'x',
    );
    expect(xRow!.row.approveRate).toBeNull();
  });

  it('approve_rate computes when there are decisions', async () => {
    seed.approved = { x: 3, reddit: 0 };
    seed.skipped = { x: 1, reddit: 0 };
    await processGrowthRollup(makeJob('user-1'));
    const xRow = inserts.find(
      (i) => i.table === 'channel_scores' && i.row.platform === 'x',
    );
    expect(xRow!.row.approveRate).toBeCloseTo(0.75);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test src/workers/processors/__tests__/growth-rollup.test.ts`
Expected: FAIL — module `../growth-rollup` not found.

- [ ] **Step 3: Write the implementation**

Create `src/workers/processors/lib/growth-counts.ts` first (this is where the SQL lives — kept separate so the processor's logic is mock-friendly):

```ts
// src/workers/processors/lib/growth-counts.ts
import { db } from '@/lib/db';
import { drafts, posts, threads } from '@/lib/db/schema';
import { and, eq, gte, sql, inArray, desc, max } from 'drizzle-orm';

export const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

export async function countThreads(
  userId: string,
  platform: string,
  weekAgo: Date,
): Promise<number> {
  // Threads that produced ≥1 draft for this user, in the window. Spec
  // open-question #1: under-count vs full discovery is acceptable.
  const [row] = await db
    .select({ n: sql<number>`count(distinct ${threads.id})::int` })
    .from(threads)
    .innerJoin(drafts, eq(drafts.threadId, threads.id))
    .where(
      and(
        eq(drafts.userId, userId),
        eq(threads.platform, platform),
        gte(threads.createdAt, weekAgo),
      ),
    );
  return row?.n ?? 0;
}

export async function countDrafts(
  userId: string,
  platform: string,
  weekAgo: Date,
): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(drafts)
    .innerJoin(threads, eq(drafts.threadId, threads.id))
    .where(
      and(
        eq(drafts.userId, userId),
        eq(threads.platform, platform),
        gte(drafts.createdAt, weekAgo),
      ),
    );
  return row?.n ?? 0;
}

export async function countPosts(
  userId: string,
  platform: string,
  weekAgo: Date,
): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(posts)
    .innerJoin(drafts, eq(posts.draftId, drafts.id))
    .where(
      and(
        eq(posts.userId, userId),
        eq(posts.platform, platform),
        gte(posts.postedAt, weekAgo),
        inArray(posts.status, ['posted', 'verified']),
        eq(drafts.draftType, 'original_post'),
      ),
    );
  return row?.n ?? 0;
}

export async function countReplies(
  userId: string,
  platform: string,
  weekAgo: Date,
): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(posts)
    .innerJoin(drafts, eq(posts.draftId, drafts.id))
    .where(
      and(
        eq(posts.userId, userId),
        eq(posts.platform, platform),
        gte(posts.postedAt, weekAgo),
        inArray(posts.status, ['posted', 'verified']),
        eq(drafts.draftType, 'reply'),
      ),
    );
  return row?.n ?? 0;
}

export async function countPending(
  userId: string,
  platform: string,
): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(drafts)
    .innerJoin(threads, eq(drafts.threadId, threads.id))
    .where(
      and(
        eq(drafts.userId, userId),
        eq(threads.platform, platform),
        eq(drafts.status, 'pending'),
      ),
    );
  return row?.n ?? 0;
}

export async function countApprovedSkipped(
  userId: string,
  platform: string,
  weekAgo: Date,
): Promise<{ approved: number; skipped: number }> {
  const [row] = await db
    .select({
      approved: sql<number>`count(*) filter (where ${drafts.status} = 'approved')::int`,
      skipped: sql<number>`count(*) filter (where ${drafts.status} = 'skipped')::int`,
    })
    .from(drafts)
    .innerJoin(threads, eq(drafts.threadId, threads.id))
    .where(
      and(
        eq(drafts.userId, userId),
        eq(threads.platform, platform),
        gte(drafts.updatedAt, weekAgo),
      ),
    );
  return {
    approved: row?.approved ?? 0,
    skipped: row?.skipped ?? 0,
  };
}

export async function lastPostAt(
  userId: string,
  platform: string,
): Promise<Date | null> {
  const [row] = await db
    .select({ t: max(posts.postedAt) })
    .from(posts)
    .where(and(eq(posts.userId, userId), eq(posts.platform, platform)));
  return row?.t ?? null;
}
```

Then the processor:

```ts
// src/workers/processors/growth-rollup.ts
import type { Job } from 'bullmq';
import { db } from '@/lib/db';
import { channelScores, moduleScores } from '@/lib/db/schema';
import { listAvailablePlatforms } from '@/lib/platform-config';
import { GROWTH_TARGETS } from '@/lib/growth-targets';
import { GROWTH_MODULES, liveModules } from '@/lib/growth-modules';
import {
  channelScore,
  moduleScore,
  type ChannelCounts,
} from '@/lib/growth-score';
import {
  countThreads,
  countDrafts,
  countPosts,
  countReplies,
  countPending,
  countApprovedSkipped,
  lastPostAt,
  WEEK_MS,
} from './lib/growth-counts';
import type { GrowthRollupJobData } from '@/lib/queue/types';
import { createLogger, loggerForJob } from '@/lib/logger';

const baseLog = createLogger('worker:growth-rollup');

export async function processGrowthRollup(job: Job<GrowthRollupJobData>) {
  const log = loggerForJob(baseLog, job);

  // Fanout shape is handled in a separate processor entry (Task 8).
  if (job.data.kind === 'fanout') {
    log.warn('growth-rollup user-processor received a fanout payload; ignoring');
    return;
  }

  const { userId } = job.data;
  const weekAgo = new Date(Date.now() - WEEK_MS);
  log.info(`Computing growth rollup for user=${userId}`);

  // Cache per-platform channel score so the module aggregate doesn't re-query.
  const channelScoresByPlatform = new Map<string, number>();

  for (const platform of listAvailablePlatforms()) {
    const target = GROWTH_TARGETS[platform];
    if (!target) {
      log.warn(`No GROWTH_TARGETS entry for platform=${platform}; skipping`);
      continue;
    }

    const [threads_, drafts_, posts_, replies_, pending_, approveAgg, lastPost] =
      await Promise.all([
        countThreads(userId, platform, weekAgo),
        countDrafts(userId, platform, weekAgo),
        countPosts(userId, platform, weekAgo),
        countReplies(userId, platform, weekAgo),
        countPending(userId, platform),
        countApprovedSkipped(userId, platform, weekAgo),
        lastPostAt(userId, platform),
      ]);

    const counts: ChannelCounts = {
      threads: threads_,
      drafts: drafts_,
      posts: posts_,
      replies: replies_,
    };
    const score = channelScore(counts, target);
    const approveDecisions = approveAgg.approved + approveAgg.skipped;
    const approveRate =
      approveDecisions > 0 ? approveAgg.approved / approveDecisions : null;

    await db.insert(channelScores).values({
      userId,
      platform,
      score,
      threads: counts.threads,
      drafts: counts.drafts,
      posts: counts.posts,
      replies: counts.replies,
      pending: pending_,
      approveRate,
      lastPostAt: lastPost,
    });

    channelScoresByPlatform.set(platform, score);
  }

  // Per-module rollup (live modules only).
  for (const module of liveModules()) {
    const scores = module.channels
      .map((p) => channelScoresByPlatform.get(p))
      .filter((s): s is number => typeof s === 'number');
    if (scores.length === 0) continue;
    const score = moduleScore(scores);
    await db.insert(moduleScores).values({
      userId,
      moduleId: module.id,
      score,
    });
  }

  log.info(`Done growth rollup for user=${userId}`);
}
```

- [ ] **Step 4: Delete the old processor**

```bash
git rm src/workers/processors/health-score.ts
```

If there's an existing `__tests__/health-score.test.ts`, delete that too:

```bash
git ls-files src/workers/processors/__tests__/health-score.test.ts && \
  git rm src/workers/processors/__tests__/health-score.test.ts || echo "no legacy test to delete"
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm test src/workers/processors/__tests__/growth-rollup.test.ts`
Expected: 5 tests PASS.

- [ ] **Step 6: Commit**

```bash
git add src/workers/processors/growth-rollup.ts \
        src/workers/processors/lib/growth-counts.ts \
        src/workers/processors/__tests__/growth-rollup.test.ts
git commit -m "feat(worker): growth-rollup processor replaces health-score"
```

---

## Task 8: Wire the worker + add daily cron

The legacy `health-score` worker was registered but had no cron scheduler, so it never fired. The new growth-rollup worker needs (a) registration with the renamed types and (b) a fanout that runs daily at 02:00 UTC (avoids overlap with daily-run at 13:00 UTC and metrics at 03:00 UTC).

**Files:**
- Modify: `src/workers/index.ts`

- [ ] **Step 1: Update imports and worker registration in `src/workers/index.ts`**

Replace the existing:

```ts
import { processHealthScore } from './processors/health-score';
```
with:
```ts
import { processGrowthRollup } from './processors/growth-rollup';
import { processGrowthRollupFanout } from './processors/growth-rollup-fanout';
```

Replace the existing `import type` block's `HealthScoreJobData` with `GrowthRollupJobData`:

```ts
import type { ReviewJobData, PostingJobData, GrowthRollupJobData, DreamJobData, /* ... */ } from '@/lib/queue/types';
```

Replace the `healthScoreWorker` block:

```ts
const growthRollupWorker = new Worker<GrowthRollupJobData>(
  'health-score',  // queue name string unchanged for Redis stability
  async (job) => {
    if (job.data.kind === 'fanout') return processGrowthRollupFanout(job);
    return processGrowthRollup(job);
  },
  { ...BASE_OPTS, concurrency: 1 },
);
```

Update the `[reviewWorker, ..., healthScoreWorker, ...]` array (around line 263) to `growthRollupWorker`.

Update the final `log.info('All workers started: ...')` line — replace `health-score` with `growth-rollup`.

- [ ] **Step 2: Add the daily cron schedule**

In the block where other crons are registered (search for `scheduleMetrics` around line 313), add:

```ts
// Schedule growth-rollup: daily at 02:00 UTC.
async function scheduleGrowthRollup() {
  await growthRollupQueue.add(
    'fanout',
    { kind: 'fanout', schemaVersion: 1, traceId: 'cron-growth-rollup' },
    {
      repeat: { pattern: '0 2 * * *', tz: 'UTC' },
      jobId: 'growth-rollup-fanout-cron',
    },
  );
}
```

Wire it into the same `Promise.all([ ... ])` block that schedules the other cron entries.

Add `growthRollupQueue` to the imports from `@/lib/queue`.

- [ ] **Step 3: Create the fanout processor**

```ts
// src/workers/processors/growth-rollup-fanout.ts
import type { Job } from 'bullmq';
import { db } from '@/lib/db';
import { channels } from '@/lib/db/schema';
import { enqueueGrowthRollup } from '@/lib/queue';
import type { GrowthRollupJobData } from '@/lib/queue/types';
import { createLogger, loggerForJob } from '@/lib/logger';

const baseLog = createLogger('worker:growth-rollup-fanout');

export async function processGrowthRollupFanout(
  job: Job<GrowthRollupJobData>,
): Promise<void> {
  const log = loggerForJob(baseLog, job);
  if (job.data.kind !== 'fanout') {
    log.warn('non-fanout payload sent to growth-rollup-fanout; ignoring');
    return;
  }

  // Distinct userIds with ≥1 channel. Explicit projection — never select
  // token columns from `channels` (CLAUDE.md security rule).
  const rows = await db
    .select({ userId: channels.userId })
    .from(channels);

  const userIds = Array.from(new Set(rows.map((r) => r.userId)));
  log.info(`Fanning out growth-rollup to ${userIds.length} users`);

  for (const userId of userIds) {
    await enqueueGrowthRollup({ kind: 'user', userId });
  }
}
```

- [ ] **Step 4: Type-check + smoke**

Run: `pnpm tsc --noEmit --pretty false`
Expected: compiles cleanly.

Run: `pnpm test`
Expected: existing tests still pass; the new growth-rollup test from Task 7 passes.

- [ ] **Step 5: Commit**

```bash
git add src/workers/index.ts src/workers/processors/growth-rollup-fanout.ts
git commit -m "feat(worker): register growth-rollup worker + daily cron fanout"
```

---

## Task 9: API route — `/api/growth/overview` (TDD)

**Files:**
- Create: `src/app/api/growth/overview/route.ts`
- Create: `src/app/api/growth/overview/__tests__/route.test.ts`

The route returns the hierarchical shape defined in the spec. The `connected` field per channel comes from a left-join on the `channels` table — `channel_scores` rows always exist for every available platform once the first rollup ticks; connectivity is a separate concern.

- [ ] **Step 1: Write the failing test**

```ts
// src/app/api/growth/overview/__tests__/route.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

let authUserId: string | null = 'user-1';
vi.mock('@/lib/auth', () => ({
  auth: async () => (authUserId ? { user: { id: authUserId } } : null),
}));

// In-memory data the mock will surface to the route.
let channelScoreRows: Array<{
  platform: string;
  score: number;
  threads: number;
  drafts: number;
  posts: number;
  replies: number;
  pending: number;
  approveRate: number | null;
  lastPostAt: Date | null;
}> = [];

let connectedChannels: Array<{ platform: string; username: string | null }> = [];
let productRedditChannels: Array<{ subreddit: string; rank: number; disabled: boolean }> = [];

vi.mock('@/lib/db', () => {
  // The route makes 3 queries:
  //   (a) latest channel_scores per (userId, platform) — distinct on
  //   (b) channels (userId, platform, username)
  //   (c) product_reddit_channels active list
  // The mock dispatches by selecting on the projection's first key.
  return {
    db: {
      execute: vi.fn(),
      select: () => {
        const sentinel: { kind?: 'cs' | 'ch' | 'sub'; project?: unknown } = {};
        const chain = {
          from: (_: unknown) => chain,
          innerJoin: () => chain,
          leftJoin: () => chain,
          where: () => chain,
          orderBy: () => chain,
          limit: async () => {
            if (sentinel.kind === 'cs') return channelScoreRows;
            if (sentinel.kind === 'ch') return connectedChannels;
            if (sentinel.kind === 'sub') return productRedditChannels;
            return [];
          },
        };
        return {
          from: chain.from,
          // Cheat: the route uses a unique-shaped projection per query so
          // we tag chain based on which one is called. The real route's
          // wiring is shown in step 3 — the test only cares about input
          // shape (auth-id) and output JSON.
        };
      },
    },
  };
});

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ debug() {}, info() {}, warn() {}, error() {} }),
}));

import { GET } from '../route';

function makeReq(): Request {
  return new Request('http://localhost/api/growth/overview');
}

beforeEach(() => {
  authUserId = 'user-1';
  channelScoreRows = [];
  connectedChannels = [];
  productRedditChannels = [];
});

describe('GET /api/growth/overview', () => {
  it('401 when not authenticated', async () => {
    authUserId = null;
    const res = await GET(makeReq());
    expect(res.status).toBe(401);
  });

  it('cold start — overallScore null, every channel score null, counts 0', async () => {
    const res = await GET(makeReq());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.overallScore).toBeNull();
    const social = body.modules.find((m: { id: string }) => m.id === 'social');
    expect(social.score).toBeNull();
    const xChan = social.channels.find((c: { platform: string }) => c.platform === 'x');
    expect(xChan.score).toBeNull();
    expect(xChan.threads).toBe(0);
  });

  it('happy path — Social score derived from average of X+Reddit', async () => {
    channelScoreRows = [
      { platform: 'x', score: 80, threads: 30, drafts: 20, posts: 5, replies: 15, pending: 2, approveRate: 0.75, lastPostAt: new Date('2026-05-12T10:00:00Z') },
      { platform: 'reddit', score: 60, threads: 12, drafts: 8, posts: 2, replies: 5, pending: 1, approveRate: 0.6, lastPostAt: new Date('2026-05-11T09:00:00Z') },
    ];
    connectedChannels = [
      { platform: 'x', username: 'yifeng' },
      { platform: 'reddit', username: null },
    ];
    const res = await GET(makeReq());
    const body = await res.json();
    expect(body.overallScore).toBe(70);
    const social = body.modules.find((m: { id: string }) => m.id === 'social');
    expect(social.score).toBe(70);
    expect(social.channels[0].connected).toBe(true);
  });

  it('modules render in declared order: social, search, performance, content, analytics', async () => {
    const res = await GET(makeReq());
    const body = await res.json();
    const ids = body.modules.map((m: { id: string }) => m.id);
    expect(ids).toEqual(['social', 'search', 'performance', 'content', 'analytics']);
  });

  it('non-live modules carry score null, no channels array', async () => {
    const res = await GET(makeReq());
    const body = await res.json();
    const search = body.modules.find((m: { id: string }) => m.id === 'search');
    expect(search.live).toBe(false);
    expect(search.score).toBeNull();
    expect(search.channels).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test src/app/api/growth/overview/__tests__/route.test.ts`
Expected: FAIL — module `../route` not found.

- [ ] **Step 3: Write the route**

```ts
// src/app/api/growth/overview/route.ts
import { NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { db } from '@/lib/db';
import {
  channelScores,
  channels,
  productRedditChannels,
  products,
} from '@/lib/db/schema';
import { and, desc, eq, sql } from 'drizzle-orm';
import { GROWTH_MODULES } from '@/lib/growth-modules';
import { getPlatformConfig } from '@/lib/platform-config';
import { overallScore } from '@/lib/growth-score';
import { createLogger } from '@/lib/logger';

const log = createLogger('api:growth:overview');

interface ChannelOut {
  platform: string;
  displayName: string;
  connected: boolean;
  handleOrLabel: string;
  score: number | null;
  threads: number;
  drafts: number;
  posts: number;
  replies: number;
  pending: number;
  approveRate: number | null;
  lastPostAt: string | null;
  activeSubreddits?: string[];
}

interface ModuleOut {
  id: string;
  displayName: string;
  managerTitle: string;
  live: boolean;
  score: number | null;
  channels?: ChannelOut[];
}

interface GrowthOverviewResponse {
  overallScore: number | null;
  modules: ModuleOut[];
}

export async function GET() {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const userId = session.user.id;
  log.info(`GET /api/growth/overview user=${userId}`);

  // Latest channel_scores row per (userId, platform). Postgres DISTINCT ON.
  const latestRows = await db.execute<{
    platform: string;
    score: number;
    threads: number;
    drafts: number;
    posts: number;
    replies: number;
    pending: number;
    approve_rate: number | null;
    last_post_at: Date | null;
  }>(sql`
    SELECT DISTINCT ON (platform)
      platform, score, threads, drafts, posts, replies, pending,
      approve_rate, last_post_at
    FROM channel_scores
    WHERE user_id = ${userId}
    ORDER BY platform, calculated_at DESC
  `);
  const scoresByPlatform = new Map(latestRows.map((r) => [r.platform, r] as const));

  // Explicit projection — never read token columns (CLAUDE.md security TODO).
  const channelRows = await db
    .select({ platform: channels.platform, username: channels.username })
    .from(channels)
    .where(eq(channels.userId, userId));
  const connectedByPlatform = new Map(channelRows.map((c) => [c.platform, c] as const));

  // Top 5 active subreddits for the founder's product, by rank.
  const [product] = await db
    .select({ id: products.id })
    .from(products)
    .where(eq(products.userId, userId))
    .limit(1);

  let activeSubreddits: string[] = [];
  if (product) {
    const subs = await db
      .select({ subreddit: productRedditChannels.subreddit })
      .from(productRedditChannels)
      .where(
        and(
          eq(productRedditChannels.productId, product.id),
          eq(productRedditChannels.disabled, false),
        ),
      )
      .orderBy(productRedditChannels.rank)
      .limit(5);
    activeSubreddits = subs.map((s) => s.subreddit);
  }

  // Build module list.
  const modules: ModuleOut[] = GROWTH_MODULES.map((mod) => {
    if (!mod.live) {
      return {
        id: mod.id,
        displayName: mod.displayName,
        managerTitle: mod.managerTitle,
        live: false,
        score: null,
      };
    }
    const chans: ChannelOut[] = mod.channels.map((platform) => {
      const cfg = getPlatformConfig(platform);
      const score = scoresByPlatform.get(platform);
      const connection = connectedByPlatform.get(platform);
      const handleOrLabel =
        platform === 'reddit'
          ? connection
            ? 'Handoff mode'
            : 'Not connected'
          : connection?.username
            ? `@${connection.username}`
            : 'Not connected';
      return {
        platform,
        displayName: cfg.displayName,
        connected: !!connection,
        handleOrLabel,
        score: score ? score.score : null,
        threads: score?.threads ?? 0,
        drafts: score?.drafts ?? 0,
        posts: score?.posts ?? 0,
        replies: score?.replies ?? 0,
        pending: score?.pending ?? 0,
        approveRate: score?.approve_rate ?? null,
        lastPostAt: score?.last_post_at ? score.last_post_at.toISOString() : null,
        ...(platform === 'reddit' ? { activeSubreddits } : {}),
      };
    });
    const channelScoresVals = chans
      .map((c) => c.score)
      .filter((s): s is number => typeof s === 'number');
    const moduleScoreVal =
      channelScoresVals.length > 0
        ? Math.round(
            channelScoresVals.reduce((a, b) => a + b, 0) /
              channelScoresVals.length,
          )
        : null;
    return {
      id: mod.id,
      displayName: mod.displayName,
      managerTitle: mod.managerTitle,
      live: true,
      score: moduleScoreVal,
      channels: chans,
    };
  });

  const liveScored = modules.filter(
    (m): m is ModuleOut & { score: number } => m.live && m.score !== null,
  );
  const weight = liveScored.length > 0 ? 1 / liveScored.length : 0;
  const overall =
    liveScored.length > 0
      ? overallScore(liveScored.map((m) => ({ score: m.score, weight })))
      : null;

  const body: GrowthOverviewResponse = { overallScore: overall, modules };
  return NextResponse.json(body);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test src/app/api/growth/overview/__tests__/route.test.ts`
Expected: 5 tests PASS.

If the mock dispatch in step 1 is too brittle (it tags `chain.kind` but doesn't actually set it — that's a known weakness of the inline mock here), simplify by mocking just enough to cover auth + cold-start + ordering, OR move to integration tests against a real test DB if the repo has that setup.

- [ ] **Step 5: Commit**

```bash
git add src/app/api/growth/overview/route.ts src/app/api/growth/overview/__tests__/route.test.ts
git commit -m "feat(api): /api/growth/overview — hierarchical Growth shape"
```

---

## Task 10: Delete `/api/health`

**Files:**
- Delete: `src/app/api/health/route.ts`

- [ ] **Step 1: Confirm no consumers**

Run: `grep -rn "/api/health" src --include="*.ts" --include="*.tsx" | grep -v healthz | grep -v __tests__`
Expected: at most one hit — the existing `growth-content.tsx` `useSWR<HealthPayload>('/api/health', ...)`. (`healthz` is a different liveness route, leave it alone.) The growth-content rewrite in Task 15 removes that call.

- [ ] **Step 2: Delete the route**

```bash
git rm src/app/api/health/route.ts
```

- [ ] **Step 3: Commit**

```bash
git commit -m "feat(api): remove /api/health — superseded by /api/growth/overview"
```

---

## Task 11: `<ChannelCard>` component

**Files:**
- Create: `src/app/(app)/growth/_components/channel-card.tsx`

- [ ] **Step 1: Write the component**

```tsx
// src/app/(app)/growth/_components/channel-card.tsx
import type { ReactNode } from 'react';
import { Ops } from '@/components/ui/ops';

export interface ChannelOverview {
  platform: string;
  displayName: string;
  connected: boolean;
  handleOrLabel: string;
  score: number | null;
  threads: number;
  drafts: number;
  posts: number;
  replies: number;
  pending: number;
  approveRate: number | null;
  lastPostAt: string | null;
}

interface ChannelCardProps {
  channel: ChannelOverview;
  /** Slot rendered below the meta line — currently used by Reddit subreddit chips. */
  footerSlot?: ReactNode;
}

function PlatformTile({ platform }: { platform: string }) {
  const styles: Record<string, { bg: string; glyph: string }> = {
    x: { bg: '#000', glyph: '𝕏' },
    reddit: { bg: '#ff4500', glyph: 'R' },
  };
  const s = styles[platform] ?? { bg: 'var(--sf-fg-3)', glyph: '?' };
  return (
    <span
      aria-hidden="true"
      style={{
        width: 28,
        height: 28,
        borderRadius: 6,
        background: s.bg,
        color: '#fff',
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontWeight: 600,
      }}
    >
      {s.glyph}
    </span>
  );
}

function formatLastPost(iso: string | null): string {
  if (!iso) return '—';
  const then = new Date(iso).getTime();
  const ago = Date.now() - then;
  const h = Math.floor(ago / 3_600_000);
  if (h < 1) return 'just now';
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

function formatApproveRate(rate: number | null): string {
  if (rate == null) return '—';
  return `${Math.round(rate * 100)}%`;
}

export function ChannelCard({ channel, footerSlot }: ChannelCardProps) {
  const disconnected = !channel.connected;
  return (
    <div
      data-testid={`channel-card-${channel.platform}`}
      style={{
        background: 'var(--sf-bg-primary)',
        borderRadius: 12,
        padding: 18,
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          marginBottom: 16,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <PlatformTile platform={channel.platform} />
          <div>
            <div style={{ fontSize: 17, fontWeight: 600, color: 'var(--sf-fg-1)' }}>
              {channel.displayName}
            </div>
            <Ops style={{ marginTop: 2 }}>{channel.handleOrLabel}</Ops>
          </div>
        </div>
        <Ops style={{ color: disconnected ? 'var(--sf-fg-3)' : 'var(--sf-success-ink)' }}>
          <span
            aria-hidden="true"
            style={{
              display: 'inline-block',
              width: 6,
              height: 6,
              borderRadius: '50%',
              background: disconnected ? 'transparent' : 'var(--sf-success)',
              border: disconnected ? '1px solid var(--sf-fg-3)' : 'none',
              marginRight: 6,
              verticalAlign: 'middle',
            }}
          />
          {disconnected ? 'Not connected' : 'Active'}
        </Ops>
      </div>

      {disconnected ? (
        <p
          style={{
            margin: 0,
            fontSize: 'var(--sf-text-sm)',
            color: 'var(--sf-fg-3)',
            lineHeight: 'var(--sf-lh-normal)',
          }}
        >
          Connect this channel from onboarding to start shipping content here.
        </p>
      ) : (
        <>
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(4, 1fr)',
              gap: 12,
              marginBottom: 12,
            }}
          >
            <Metric label="Threads" value={channel.threads} />
            <Metric label="Drafts" value={channel.drafts} />
            <Metric label="Posts" value={channel.posts} />
            <Metric label="Replies" value={channel.replies} />
          </div>

          <div
            className="sf-mono"
            style={{
              fontSize: 'var(--sf-text-xs)',
              color: 'var(--sf-fg-3)',
              letterSpacing: '-0.12px',
              paddingTop: 8,
              borderTop: '1px solid rgba(0,0,0,0.06)',
            }}
          >
            Pending {channel.pending} · Approve rate {formatApproveRate(channel.approveRate)} · Last post {formatLastPost(channel.lastPostAt)}
          </div>

          {footerSlot}
        </>
      )}
    </div>
  );
}

function Metric({ label, value }: { label: string; value: number }) {
  return (
    <div>
      <Ops>{label}</Ops>
      <div
        className="sf-mono"
        style={{
          fontSize: 32,
          fontWeight: 600,
          letterSpacing: '-0.6px',
          color: 'var(--sf-fg-1)',
          marginTop: 4,
          fontVariantNumeric: 'tabular-nums',
        }}
      >
        {value}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Verify `Ops` exists**

Run: `grep -l "export function Ops" src/components/ui/ops.tsx`
Expected: prints the path. (`Ops` is already in use by growth-content.tsx.) If not present, find the actual mono-uppercase label component and update imports accordingly.

- [ ] **Step 3: Type-check**

Run: `pnpm tsc --noEmit --pretty false`
Expected: compiles.

- [ ] **Step 4: Commit**

```bash
git add src/app/\(app\)/growth/_components/channel-card.tsx
git commit -m "feat(growth): ChannelCard component"
```

---

## Task 12: `<SubredditChips>` component

**Files:**
- Create: `src/app/(app)/growth/_components/subreddit-chips.tsx`

- [ ] **Step 1: Write the component**

```tsx
// src/app/(app)/growth/_components/subreddit-chips.tsx
import Link from 'next/link';
import { Ops } from '@/components/ui/ops';

interface SubredditChipsProps {
  /** Top-5 active subreddits, already filtered + ordered by rank server-side. */
  subreddits: string[];
}

export function SubredditChips({ subreddits }: SubredditChipsProps) {
  return (
    <div style={{ paddingTop: 14, borderTop: '1px solid rgba(0,0,0,0.06)', marginTop: 8 }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'baseline',
          justifyContent: 'space-between',
          marginBottom: 8,
        }}
      >
        <Ops>
          Active subreddits {subreddits.length > 0 ? `· ${subreddits.length}` : ''}
        </Ops>
        <Link
          href="/growth/reddit-channels"
          style={{
            fontSize: 13,
            color: 'var(--sf-accent)',
            textDecoration: 'none',
          }}
        >
          Manage subreddits →
        </Link>
      </div>
      {subreddits.length === 0 ? (
        <p style={{ margin: 0, fontSize: 'var(--sf-text-sm)', color: 'var(--sf-fg-3)' }}>
          No active subreddits yet — research runs on next kickoff.
        </p>
      ) : (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
          {subreddits.map((s) => (
            <span
              key={s}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                padding: '3px 10px',
                background: 'var(--sf-bg-secondary)',
                border: '1px solid rgba(0,0,0,0.06)',
                borderRadius: 999,
                fontSize: 12,
                color: 'var(--sf-fg-2)',
                letterSpacing: '-0.12px',
              }}
            >
              r/{s}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add src/app/\(app\)/growth/_components/subreddit-chips.tsx
git commit -m "feat(growth): SubredditChips component"
```

---

## Task 13: `<ModuleStrip>` component

**Files:**
- Create: `src/app/(app)/growth/_components/module-strip.tsx`

- [ ] **Step 1: Write the component**

```tsx
// src/app/(app)/growth/_components/module-strip.tsx
import { Ops } from '@/components/ui/ops';

export interface ModuleSummary {
  id: string;
  displayName: string;
  live: boolean;
  score: number | null;
}

interface ModuleStripProps {
  modules: ModuleSummary[];
}

export function ModuleStrip({ modules }: ModuleStripProps) {
  return (
    <div
      role="list"
      style={{
        display: 'grid',
        gridTemplateColumns: `repeat(${modules.length}, 1fr)`,
        gap: 8,
      }}
    >
      {modules.map((m) => (
        <ModuleChip key={m.id} module={m} />
      ))}
    </div>
  );
}

function ModuleChip({ module: m }: { module: ModuleSummary }) {
  const live = m.live;
  return (
    <div
      role="listitem"
      data-testid={`module-chip-${m.id}`}
      style={{
        background: live ? 'var(--sf-success-light)' : 'var(--sf-bg-primary)',
        borderRadius: 8,
        padding: '12px 14px',
        opacity: live ? 1 : 0.55,
      }}
    >
      <Ops>{m.displayName}</Ops>
      <div
        className="sf-mono"
        style={{
          fontSize: 22,
          fontWeight: 600,
          letterSpacing: '-0.4px',
          color: live && m.score != null ? 'var(--sf-fg-1)' : 'var(--sf-fg-3)',
          margin: '6px 0 4px',
          fontVariantNumeric: 'tabular-nums',
        }}
      >
        {m.score == null ? '—' : m.score}
      </div>
      <div
        className="sf-mono"
        style={{
          fontSize: 11,
          letterSpacing: 0.4,
          color: live ? 'var(--sf-success-ink)' : 'var(--sf-fg-3)',
          textTransform: 'uppercase',
        }}
      >
        <span
          aria-hidden="true"
          style={{
            display: 'inline-block',
            width: 6,
            height: 6,
            borderRadius: '50%',
            background: live ? 'var(--sf-success)' : 'transparent',
            border: live ? 'none' : '1px solid var(--sf-fg-3)',
            marginRight: 6,
            verticalAlign: 'middle',
          }}
        />
        {live ? 'Live' : 'Planned'}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add src/app/\(app\)/growth/_components/module-strip.tsx
git commit -m "feat(growth): ModuleStrip component"
```

---

## Task 14: `<OverallHero>` + `<SocialPanel>` components

**Files:**
- Create: `src/app/(app)/growth/_components/overall-hero.tsx`
- Create: `src/app/(app)/growth/_components/social-panel.tsx`

- [ ] **Step 1: Write `<OverallHero>`**

```tsx
// src/app/(app)/growth/_components/overall-hero.tsx
import { Card } from '@/components/ui/card';
import { Ops } from '@/components/ui/ops';
import { HealthMeter } from '@/components/ui/health-meter';
import { ModuleStrip, type ModuleSummary } from './module-strip';

interface OverallHeroProps {
  overallScore: number | null;
  modules: ModuleSummary[];
}

export function OverallHero({ overallScore, modules }: OverallHeroProps) {
  return (
    <Card padding={28}>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: '180px 1fr',
          gap: 32,
          alignItems: 'center',
        }}
      >
        <div>
          <HealthMeter value={overallScore ?? 0} variant="dial" size={132} />
          <Ops style={{ display: 'block', textAlign: 'center', marginTop: 12 }}>
            ShipFlare health
          </Ops>
        </div>
        <div>
          <Ops>This week</Ops>
          <h2
            className="sf-h3"
            style={{
              margin: '6px 0 6px',
              color: 'var(--sf-fg-1)',
            }}
          >
            {overallScore == null
              ? 'Awaiting first rollup'
              : 'Your team is shipping on social'}
          </h2>
          <p
            style={{
              margin: '0 0 18px',
              fontSize: 'var(--sf-text-sm)',
              color: 'var(--sf-fg-3)',
              lineHeight: 'var(--sf-lh-normal)',
              maxWidth: 480,
            }}
          >
            {overallScore == null
              ? "Your team hasn't started shipping yet — first rollup runs after kickoff completes."
              : 'Social marketing is live and active. Other modules unlock as we ship them.'}
          </p>
          <ModuleStrip modules={modules} />
        </div>
      </div>
    </Card>
  );
}
```

- [ ] **Step 2: Write `<SocialPanel>`**

```tsx
// src/app/(app)/growth/_components/social-panel.tsx
import { Card } from '@/components/ui/card';
import { Ops } from '@/components/ui/ops';
import { ChannelCard, type ChannelOverview } from './channel-card';
import { SubredditChips } from './subreddit-chips';

interface SocialChannel extends ChannelOverview {
  activeSubreddits?: string[];
}

interface SocialPanelProps {
  moduleScore: number | null;
  channels: SocialChannel[];
}

export function SocialPanel({ moduleScore, channels }: SocialPanelProps) {
  return (
    <Card padding={24}>
      <div
        style={{
          display: 'flex',
          alignItems: 'baseline',
          justifyContent: 'space-between',
          marginBottom: 18,
        }}
      >
        <div>
          <Ops>Social marketing · last 7 days</Ops>
          <h2
            className="sf-h3"
            style={{ margin: '6px 0 0', color: 'var(--sf-fg-1)' }}
          >
            Social Media Manager ·{' '}
            <span style={{ color: 'var(--sf-fg-3)', fontWeight: 500 }}>
              {moduleScore == null ? '—' : `${moduleScore}/100`}
            </span>
          </h2>
        </div>
        <span
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
            padding: '4px 10px',
            background: 'var(--sf-success-light)',
            color: 'var(--sf-success-ink)',
            borderRadius: 999,
            fontFamily: 'SF Mono, ui-monospace, monospace',
            fontSize: 11,
            fontWeight: 600,
            letterSpacing: 0.4,
            textTransform: 'uppercase',
          }}
        >
          <span
            aria-hidden="true"
            style={{
              display: 'inline-block',
              width: 6,
              height: 6,
              borderRadius: '50%',
              background: 'var(--sf-success-ink)',
            }}
          />
          Active
        </span>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
        {channels.map((c) => (
          <ChannelCard
            key={c.platform}
            channel={c}
            footerSlot={
              c.platform === 'reddit' ? (
                <SubredditChips subreddits={c.activeSubreddits ?? []} />
              ) : null
            }
          />
        ))}
      </div>
    </Card>
  );
}
```

- [ ] **Step 3: Type-check**

Run: `pnpm tsc --noEmit --pretty false`
Expected: compiles.

- [ ] **Step 4: Commit**

```bash
git add src/app/\(app\)/growth/_components/overall-hero.tsx src/app/\(app\)/growth/_components/social-panel.tsx
git commit -m "feat(growth): OverallHero + SocialPanel composing components"
```

---

## Task 15: Rewrite `growth-content.tsx`

**Files:**
- Modify: `src/app/(app)/growth/growth-content.tsx`

- [ ] **Step 1: Replace file contents**

```tsx
// src/app/(app)/growth/growth-content.tsx
'use client';

/**
 * Growth — module-based progress dashboard.
 *
 * Composition:
 *   - <OverallHero> renders the overall dial + module strip.
 *   - <SocialPanel> renders the live Social Marketing module with X +
 *     Reddit channel cards.
 *
 * Other modules (Search / Performance / Content / Analytics) appear in
 * the module strip as planned placeholders. They get their own panel
 * components when they go live.
 *
 * Data: GET /api/growth/overview (hierarchical shape — see spec).
 */

import useSWR from 'swr';
import { HeaderBar } from '@/components/layout/header-bar';
import { Card } from '@/components/ui/card';
import { OverallHero } from './_components/overall-hero';
import { SocialPanel } from './_components/social-panel';
import type { ChannelOverview } from './_components/channel-card';

interface GrowthOverview {
  overallScore: number | null;
  modules: Array<{
    id: string;
    displayName: string;
    managerTitle: string;
    live: boolean;
    score: number | null;
    channels?: Array<ChannelOverview & { activeSubreddits?: string[] }>;
  }>;
}

const fetcher = async (url: string): Promise<GrowthOverview> => {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} → ${res.status}`);
  return res.json();
};

export function GrowthContent() {
  const { data, error } = useSWR<GrowthOverview>('/api/growth/overview', fetcher, {
    revalidateOnFocus: false,
  });

  return (
    <>
      <HeaderBar
        title="Growth"
        meta={
          data?.overallScore == null
            ? "Your marketing team's progress — last 7 days."
            : `Health ${data.overallScore}/100 · Your marketing team's progress — last 7 days.`
        }
      />

      <div style={{ padding: '0 clamp(16px, 3vw, 32px) 48px' }}>
        {error ? (
          <Card padding={24}>
            <p style={{ margin: 0, color: 'var(--sf-fg-3)' }}>
              Couldn&apos;t load Growth — refresh to retry.
            </p>
          </Card>
        ) : (
          <>
            <OverallHero
              overallScore={data?.overallScore ?? null}
              modules={(data?.modules ?? []).map((m) => ({
                id: m.id,
                displayName: m.displayName,
                live: m.live,
                score: m.score,
              }))}
            />

            {(() => {
              const social = data?.modules.find((m) => m.id === 'social');
              if (!social) return null;
              return (
                <div style={{ marginTop: 16 }}>
                  <SocialPanel
                    moduleScore={social.score}
                    channels={social.channels ?? []}
                  />
                </div>
              );
            })()}
          </>
        )}
      </div>
    </>
  );
}
```

- [ ] **Step 2: Smoke-run the dev server**

Run: `pnpm dev`
Visit: `http://localhost:3000/growth` after signing in.
Expected: header renders, hero card renders, dial renders. Cold-start data shows dashes everywhere; once the first rollup ticks, real numbers appear. No console errors. The "Manage subreddits →" link 404s for now — Task 16 fixes that.

Stop the dev server before continuing.

- [ ] **Step 3: Commit**

```bash
git add src/app/\(app\)/growth/growth-content.tsx
git commit -m "feat(growth): rewrite page composition — hero + social panel"
```

---

## Task 16: Move `/settings/reddit-channels` → `/growth/reddit-channels`

**Files:**
- Create: `src/app/(app)/growth/reddit-channels/page.tsx`
- Delete: `src/app/(app)/settings/reddit-channels/page.tsx`

- [ ] **Step 1: Copy the page**

```bash
mkdir -p "src/app/(app)/growth/reddit-channels"
cp "src/app/(app)/settings/reddit-channels/page.tsx" \
   "src/app/(app)/growth/reddit-channels/page.tsx"
```

- [ ] **Step 2: Update the new file's body**

Open `src/app/(app)/growth/reddit-channels/page.tsx` and replace the route-doc comment block + intro paragraph copy to reference Growth instead of Settings. Concretely:

Change the JSDoc block to:
```
/**
 * /growth/reddit-channels — founder-managed view of the auto + manual
 * subreddits ShipFlare uses for Reddit content_post plan_items.
 *
 * Same `<RedditResearchCard />` that ships during onboarding —
 * this page just wraps it in the app shell so the founder can disable
 * a sub, swap in their own, or re-research at any time after kickoff.
 *
 * Reachable from the Reddit card on /growth ("Manage subreddits →").
 */
```

Update the intro `<p>` text to:
```
Manage the subreddits ShipFlare uses when planning your Reddit
posts. Disable any sub you'd rather not target, swap in your
own, or re-research from scratch.
```

(That paragraph already exists; leave it untouched if its text is already neutral about Settings vs Growth.)

- [ ] **Step 3: Delete the old page**

```bash
git rm "src/app/(app)/settings/reddit-channels/page.tsx"
rmdir "src/app/(app)/settings/reddit-channels" 2>/dev/null || true
```

- [ ] **Step 4: Smoke-run**

Run: `pnpm dev`
Visit: `http://localhost:3000/growth/reddit-channels` after signing in.
Expected: page renders the same `<RedditResearchCard />` UI it did at the old path.

Stop the dev server.

- [ ] **Step 5: Commit**

```bash
git add "src/app/(app)/growth/reddit-channels/page.tsx"
git commit -m "feat(growth): move reddit-channels page from /settings to /growth"
```

---

## Task 17: Delete Reddit row from Settings

**Files:**
- Modify: `src/app/(app)/settings/settings-content.tsx`
- Modify: `src/app/(app)/settings/page.tsx`

- [ ] **Step 1: Remove Reddit references from `settings-content.tsx`**

Delete:
- The `SettingsRedditChannel` interface export (around line 65–78).
- The `redditChannels: SettingsRedditChannel[]` prop on the top-level component (around line 76 and 781).
- The `<RedditIntegrationRow channels={redditChannels} />` JSX usage (around line 839).
- The `RedditIntegrationRow` function (around line 886–970).
- The `RedditTileIcon` SVG component (around line 1130).

Confirm with: `grep -n "Reddit\|reddit" "src/app/(app)/settings/settings-content.tsx"`
Expected: only mentions inside string copy unrelated to integration rows (if any). Otherwise zero matches.

- [ ] **Step 2: Remove Reddit prop wiring from `page.tsx`**

Open `src/app/(app)/settings/page.tsx`. Delete:
- Any `redditChannels` server-side fetch (likely a `db.select(...).from(productRedditChannels)` block).
- The `redditChannels` prop passed to `<SettingsContent />`.

Confirm: the page now only fetches user / preferences / channels data.

- [ ] **Step 3: Type-check**

Run: `pnpm tsc --noEmit --pretty false`
Expected: compiles cleanly.

- [ ] **Step 4: Smoke-run**

Run: `pnpm dev`
Visit: `http://localhost:3000/settings`
Expected: no Reddit row appears in the integrations list; X row still visible; no console errors.

Stop the dev server.

- [ ] **Step 5: Commit**

```bash
git add "src/app/(app)/settings/settings-content.tsx" "src/app/(app)/settings/page.tsx"
git commit -m "refactor(settings): remove Reddit integration row — managed under /growth now"
```

---

## Task 18: Playwright real-browser smoke test

**Files:**
- Create: `e2e/tests/growth.spec.ts`

- [ ] **Step 1: Write the spec**

```ts
// e2e/tests/growth.spec.ts
import { testWithProduct, expect } from '../fixtures/auth';

testWithProduct.describe('Growth page', () => {
  testWithProduct('renders hero, module strip, and channel cards', async ({
    authenticatedPageWithProduct: page,
  }) => {
    await page.goto('/growth');

    // Header
    await expect(page.locator('h1', { hasText: 'Growth' })).toBeVisible();

    // Hero — overall dial (HealthMeter renders a numeric center)
    await expect(page.getByText('ShipFlare health')).toBeVisible();

    // Module strip — 5 chips
    await expect(page.getByTestId('module-chip-social')).toBeVisible();
    await expect(page.getByTestId('module-chip-search')).toBeVisible();
    await expect(page.getByTestId('module-chip-performance')).toBeVisible();
    await expect(page.getByTestId('module-chip-content')).toBeVisible();
    await expect(page.getByTestId('module-chip-analytics')).toBeVisible();

    // Social panel header
    await expect(
      page.getByText('Social Media Manager', { exact: false }),
    ).toBeVisible();

    // Both channel cards
    await expect(page.getByTestId('channel-card-x')).toBeVisible();
    await expect(page.getByTestId('channel-card-reddit')).toBeVisible();
  });

  testWithProduct('"Manage subreddits →" navigates to /growth/reddit-channels', async ({
    authenticatedPageWithProduct: page,
  }) => {
    await page.goto('/growth');
    const link = page.getByRole('link', { name: /Manage subreddits/ });
    await expect(link).toBeVisible();
    await link.click();
    await page.waitForURL('**/growth/reddit-channels');
    await expect(page.locator('h1', { hasText: 'Reddit communities' })).toBeVisible();
  });

  testWithProduct('Settings no longer shows a Reddit row', async ({
    authenticatedPageWithProduct: page,
  }) => {
    await page.goto('/settings');
    await expect(page.locator('h1', { hasText: 'Settings' })).toBeVisible();
    // There may be incidental "reddit" in copy elsewhere — we look specifically
    // for the integration tile header.
    await expect(page.getByRole('heading', { level: 3, name: 'Reddit' })).toHaveCount(0);
  });
});
```

- [ ] **Step 2: Run the spec**

Run: `pnpm exec playwright test e2e/tests/growth.spec.ts`
Expected: all 3 tests PASS. If the test runner can't find a logged-in fixture, the auth fixture in `e2e/fixtures/auth.ts` is the canonical entry — check existing specs (e.g. `navigation.spec.ts`) for the exact import.

- [ ] **Step 3: Commit**

```bash
git add e2e/tests/growth.spec.ts
git commit -m "test(growth): Playwright smoke — hero, module strip, channel cards, subreddit nav"
```

---

## Final verification

- [ ] **Step 1: Full type-check**

Run: `pnpm tsc --noEmit --pretty false`
Expected: zero errors.

- [ ] **Step 2: Full unit suite**

Run: `pnpm test`
Expected: all tests pass (no regressions).

- [ ] **Step 3: Full Playwright suite (optional but recommended)**

Run: `pnpm exec playwright test`
Expected: existing specs unaffected; new Growth spec passes.

- [ ] **Step 4: Manual cold-start sanity**

Sign in fresh on a clean DB:
- `/growth` shows dial `—`, all module chips `—`, both channel cards show 4 zeros + meta line dashes.
- Trigger `enqueueGrowthRollup({ kind: 'user', userId: '<your-user-id>' })` from a one-off script, or wait for the next 02:00 UTC cron.
- Refresh — channel cards now show real (mostly 0) numbers; dial shows a real (likely low) score.
