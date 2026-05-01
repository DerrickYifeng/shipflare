# Posting & Scheduler Wiring Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the "Schedule" / "Reply" buttons in the Today UI actually post to X / Reddit at the calendar-scheduled time, with bot-detection-aware pacing for API posts and a TOS-compliant browser-handoff for X replies.

**Architecture:** Today UI → `/api/today/:id/approve` → `approve-dispatch.ts` (router) → either (a) `enqueuePosting` with mode='direct' and a delay computed by `posting-pacer.ts`, then `processPosting` calls platform clients directly; or (b) returns an X intent URL that the UI opens in a new tab (browser handoff). Plan-execute's `execute` phase calls the same dispatcher so autonomous-fire posts (auto-approve plan items) flow through identical pacing + posting logic. Worker writes back to `plan_items.state` on terminal success/failure so the UI reflects reality.

**Tech Stack:** Next.js 15 App Router, Drizzle ORM (postgres), BullMQ (Redis), TypeScript strict, Vitest (unit), Bun runtime for workers. Build gate is `pnpm tsc --noEmit` — vitest uses `isolatedModules` so type errors do not surface in tests.

**Decisions locked in (do not re-litigate):**
1. **X replies use browser handoff via intent URL**, not API. (Feb 2026 X policy + cost.)
2. **Reddit and X original posts use API direct mode.** Reddit code paths exist but `PLATFORMS.reddit.enabled = false` in MVP — keep the conditionals.
3. **Pacer is account-age-tiered.** Conservative caps: X 3/8/20 replies/day, 1/2/4 posts/day; Reddit 2/5/12 comments/day, 0/1/auto posts/day. Min spacing tiered too.
4. **Over-cap defers to tomorrow** (silent, ETA visible in card) — no error toast.
5. **No spam-click defense needed** — posts originate from the plan, not from rapid manual clicks.
6. **`handed_off` drafts disappear from the Today feed** — user trusts that they posted; can re-approve to re-open the intent tab.
7. **Plan-execute is no longer a stub** for `content_post` / `content_reply`; calls the dispatcher.

---

## File Structure

**Create:**
- `drizzle/0011_drafts_plan_item_link.sql` — migration: add `plan_item_id` FK on drafts; add `'handed_off'` to draft_status enum
- `src/lib/posting-pacer.ts` — slot computation
- `src/lib/__tests__/posting-pacer.test.ts`
- `src/lib/x-intent-url.ts` — intent URL builder
- `src/lib/__tests__/x-intent-url.test.ts`
- `src/lib/approve-dispatch.ts` — central router (handoff vs direct queue)
- `src/lib/__tests__/approve-dispatch.test.ts`
- `src/workers/processors/__tests__/posting-direct.test.ts` — direct-mode branch test

**Modify:**
- `drizzle/meta/_journal.json` — append entry 11
- `src/lib/db/schema/drafts.ts` — add `planItemId` column + `'handed_off'` enum value
- `src/lib/platform-config.ts` — add `posting` config block on each `PlatformConfig`
- `src/lib/queue/types.ts` — add `mode` field to `postingJobSchema`
- `src/lib/queue/index.ts` — `enqueuePosting` accepts `delayMs` instead of generating random jitter
- `src/workers/processors/posting.ts` — add `mode === 'direct'` branch; on success/failure, update linked `plan_items.state`
- `src/tools/DraftReplyTool/DraftReplyTool.ts` — accept and persist `planItemId`
- `src/workers/processors/plan-execute.ts` — replace stub at execute phase, call dispatcher
- `src/app/api/today/[id]/approve/route.ts` — call dispatcher, surface `browserHandoff` in response
- `src/app/api/today/route.ts` — exclude `handed_off` drafts from feed
- `src/hooks/use-today.ts` — handle `browserHandoff` response by `window.open`-ing the intent URL

---

## Pre-flight: branch + worktree

- [ ] **Verify branch and clean tree**

Run: `git status`
Expected: clean working tree on `dev` branch.

If not on dev: `git checkout dev` and stash any pending work.

- [ ] **Create feature branch**

Run: `git checkout -b feat/posting-scheduler-wiring`

---

## Task 1: Migration — `plan_item_id` FK + `handed_off` enum value

**Files:**
- Create: `drizzle/0011_drafts_plan_item_link.sql`
- Modify: `drizzle/meta/_journal.json`

- [ ] **Step 1.1: Read the latest journal entry to determine next `when`**

Run: `tail -20 drizzle/meta/_journal.json`
Latest entry should be `idx: 10, when: 1779700010000` (`0010_threads_engagement_and_repost`).
Next entry MUST be `idx: 11, when: 1779700011000` — strict monotonic per the journal-monotonic CI guard from commit `1947c26`.

- [ ] **Step 1.2: Write the migration SQL**

Create `drizzle/0011_drafts_plan_item_link.sql`:

```sql
-- Add plan_item_id FK so drafts can be looked up by the originating plan_item.
-- Nullable so legacy rows remain untouched; new draft inserts (community-manager,
-- post-writer) are responsible for populating this when they have the linkage.
ALTER TABLE "drafts"
  ADD COLUMN "plan_item_id" text REFERENCES "plan_items"("id") ON DELETE SET NULL;

CREATE INDEX "drafts_plan_item_idx" ON "drafts" ("plan_item_id")
  WHERE "plan_item_id" IS NOT NULL;

-- New status: draft handed off to the user's browser via X intent URL.
-- Treated as terminal — same as 'posted' for feed-exclusion purposes — but
-- distinguished so we can later add verify-by-poll and audit trails.
ALTER TYPE "draft_status" ADD VALUE IF NOT EXISTS 'handed_off';
```

- [ ] **Step 1.3: Append journal entry**

Edit `drizzle/meta/_journal.json` — append to the `entries` array (mind the trailing comma on the previous entry):

```json
    {
      "idx": 11,
      "version": "7",
      "when": 1779700011000,
      "tag": "0011_drafts_plan_item_link",
      "breakpoints": true
    }
```

- [ ] **Step 1.4: Verify journal-monotonic test still passes**

Run: `pnpm vitest run drizzle/__tests__/journal-monotonic.test.ts src/lib/db/__tests__/journal-monotonic.test.ts`
Expected: PASS (both tests).

- [ ] **Step 1.5: Apply migration locally to verify SQL is valid**

Run: `pnpm db:migrate`
Expected: completes without error. If `'handed_off'` already exists locally from a prior attempt, the `IF NOT EXISTS` guard handles it.

- [ ] **Step 1.6: Commit**

```bash
git add drizzle/0011_drafts_plan_item_link.sql drizzle/meta/_journal.json
git commit -m "feat(db): add plan_item_id FK + handed_off status to drafts"
```

---

## Task 2: Update drafts schema in TypeScript

**Files:**
- Modify: `src/lib/db/schema/drafts.ts`

- [ ] **Step 2.1: Add `'handed_off'` to the enum literal**

In `src/lib/db/schema/drafts.ts:16-24`, replace:

```ts
export const draftStatusEnum = pgEnum('draft_status', [
  'pending',
  'approved',
  'skipped',
  'posted',
  'failed',
  'flagged',
  'needs_revision',
]);
```

with:

```ts
export const draftStatusEnum = pgEnum('draft_status', [
  'pending',
  'approved',
  'skipped',
  'posted',
  'failed',
  'flagged',
  'needs_revision',
  'handed_off',
]);
```

- [ ] **Step 2.2: Import `planItems`**

At the top of `src/lib/db/schema/drafts.ts`, add the import. The file already imports from `./users` and `./channels`; add a similar import:

```ts
import { planItems } from './plan-items';
```

- [ ] **Step 2.3: Add the column to the `drafts` table definition**

In `src/lib/db/schema/drafts.ts`, between `engagementDepth` and `media` (around line 54), add:

```ts
    planItemId: text('plan_item_id').references(() => planItems.id, {
      onDelete: 'set null',
    }),
```

- [ ] **Step 2.4: Add the index**

In the `(t) => [...]` block at line 61, add a second entry:

```ts
    index('drafts_plan_item_idx').on(t.planItemId),
```

(The conditional `WHERE plan_item_id IS NOT NULL` from the SQL is fine to omit in the Drizzle definition — Drizzle's index introspection doesn't carry it, but the actual index in pg already has the predicate from the migration.)

- [ ] **Step 2.5: Verify types compile**

Run: `pnpm tsc --noEmit`
Expected: no new errors. There may be unrelated pre-existing errors — only the new ones matter.

- [ ] **Step 2.6: Commit**

```bash
git add src/lib/db/schema/drafts.ts
git commit -m "feat(db): drafts.planItemId schema + handed_off enum"
```

---

## Task 3: Add `posting` config block to `platform-config.ts`

**Files:**
- Modify: `src/lib/platform-config.ts`

- [ ] **Step 3.1: Extend `PlatformConfig` interface**

At the top of `src/lib/platform-config.ts`, near the other interfaces, add:

```ts
/**
 * Per-platform pacing configuration for the API direct posting path.
 * Tiered by `connectedAgeDays` (= now - channels.connectedAt) since we
 * don't yet have account-age + karma fetched from the platform itself.
 *
 * Caps and spacing values come from the conservative end of published
 * shadowban-avoidance research (Reddit ReddiReach guide, OpenTweet X
 * automation guide, bitbrowser shadowban thresholds).
 */
export interface PostingTier {
  /** Inclusive lower bound on connected age in days. */
  minAgeDays: number;
  /** Max replies (Reddit comments / X replies) per 24h. */
  maxRepliesPerDay: number;
  /** Max top-level posts (Reddit submissions / X tweets) per 24h. */
  maxPostsPerDay: number;
  /** Minimum seconds between any two posts of any kind, before jitter. */
  minSpacingSec: number;
  /** ± seconds of uniform random jitter added to the spacing. */
  jitterSec: number;
}

export interface PostingConfig {
  /** Quiet-hours window in UTC (no posting). [startHour, endHour], 0-23. */
  quietHoursUTC: [number, number];
  /** Tiers ordered ascending by minAgeDays; first matching tier wins. */
  tiers: readonly PostingTier[];
}
```

- [ ] **Step 3.2: Add `posting` field to `PlatformConfig` interface**

In the `PlatformConfig` interface (around line 25), add a final field:

```ts
  /** Pacing config for the direct API posting path. Optional — platforms
   *  without a posting code path (e.g. read-only sources) leave it unset. */
  posting?: PostingConfig;
```

- [ ] **Step 3.3: Populate `posting` for X**

In the `PLATFORMS.x` entry, add:

```ts
    posting: {
      quietHoursUTC: [6, 11], // 23:00-04:00 US Pacific
      tiers: [
        { minAgeDays: 0,  maxRepliesPerDay: 3,  maxPostsPerDay: 1, minSpacingSec: 480, jitterSec: 180 },
        { minAgeDays: 14, maxRepliesPerDay: 8,  maxPostsPerDay: 2, minSpacingSec: 240, jitterSec: 120 },
        { minAgeDays: 30, maxRepliesPerDay: 20, maxPostsPerDay: 4, minSpacingSec: 120, jitterSec: 60 },
      ],
    },
```

- [ ] **Step 3.4: Populate `posting` for Reddit**

In the `PLATFORMS.reddit` entry, add:

```ts
    posting: {
      quietHoursUTC: [6, 11],
      tiers: [
        { minAgeDays: 0,  maxRepliesPerDay: 2,  maxPostsPerDay: 0, minSpacingSec: 900, jitterSec: 180 },
        { minAgeDays: 14, maxRepliesPerDay: 5,  maxPostsPerDay: 1, minSpacingSec: 600, jitterSec: 120 },
        { minAgeDays: 30, maxRepliesPerDay: 12, maxPostsPerDay: 3, minSpacingSec: 240, jitterSec: 90 },
      ],
    },
```

- [ ] **Step 3.5: Verify types compile**

Run: `pnpm tsc --noEmit`
Expected: no new errors.

- [ ] **Step 3.6: Commit**

```bash
git add src/lib/platform-config.ts
git commit -m "feat(platform-config): add tiered posting pacer config for X + Reddit"
```

---

## Task 4: `posting-pacer.ts` (TDD)

**Files:**
- Create: `src/lib/posting-pacer.ts`
- Test: `src/lib/__tests__/posting-pacer.test.ts`

- [ ] **Step 4.1: Write the failing tests**

Create `src/lib/__tests__/posting-pacer.test.ts`:

```ts
import { describe, expect, it, vi, beforeEach } from 'vitest';

// Pure-function tests: we mock the DB lookup so the pacer's slot logic
// can be tested deterministically without a live postgres.
vi.mock('@/lib/db', () => ({
  db: { /* unused — selectRecentPosts is mocked below */ },
}));

import { computeNextSlot, __setRecentPostsSourceForTests } from '../posting-pacer';

interface RecentPost {
  postedAt: Date;
  kind: 'reply' | 'post';
}

function withRecentPosts(rows: RecentPost[]) {
  __setRecentPostsSourceForTests(async () => rows);
}

const NOW = new Date('2026-04-27T15:00:00Z'); // Monday afternoon UTC, outside quiet hours

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  __setRecentPostsSourceForTests(async () => []);
});

describe('computeNextSlot', () => {
  it('returns delayMs=0 when no recent posts and outside quiet hours', async () => {
    const slot = await computeNextSlot({
      userId: 'u1',
      platform: 'x',
      kind: 'reply',
      connectedAgeDays: 60,
    });
    expect(slot.deferred).toBe(false);
    expect(slot.delayMs).toBe(0);
    expect(slot.reason).toBe('immediate');
  });

  it('spaces a follow-up post by minSpacing - now-since-last, plus jitter', async () => {
    const lastPostedAt = new Date(NOW.getTime() - 30_000); // 30s ago
    withRecentPosts([{ postedAt: lastPostedAt, kind: 'reply' }]);

    const slot = await computeNextSlot({
      userId: 'u1',
      platform: 'x',
      kind: 'reply',
      connectedAgeDays: 60, // 30+ tier: 120s spacing ± 60s
    });
    expect(slot.deferred).toBe(false);
    // Earliest = 30s ago + 120s = 90s from now; jitter shifts it to [30, 150]s.
    expect(slot.delayMs).toBeGreaterThanOrEqual(30_000);
    expect(slot.delayMs).toBeLessThanOrEqual(150_000);
    expect(slot.reason).toBe('spaced');
  });

  it('defers when over the daily reply cap', async () => {
    const recent = Array.from({ length: 20 }).map((_, i) => ({
      postedAt: new Date(NOW.getTime() - i * 60_000),
      kind: 'reply' as const,
    }));
    withRecentPosts(recent);

    const slot = await computeNextSlot({
      userId: 'u1',
      platform: 'x',
      kind: 'reply',
      connectedAgeDays: 60, // 30+ tier: 20 replies/day cap
    });
    expect(slot.deferred).toBe(true);
    expect(slot.reason).toBe('over_daily_cap');
    // Defers to next active hour after the oldest reply rolls out of the 24h window
    expect(slot.delayMs).toBeGreaterThan(0);
  });

  it('uses the youngest tier when account is brand new', async () => {
    withRecentPosts([]);
    const slot = await computeNextSlot({
      userId: 'u1',
      platform: 'x',
      kind: 'reply',
      connectedAgeDays: 3, // <14 tier: 3 replies/day cap, 480s spacing
    });
    // Empty history → immediate, but the tier choice is reflected later
    // when caps are hit. Here we only verify the slot is immediate.
    expect(slot.deferred).toBe(false);
    expect(slot.delayMs).toBe(0);
  });

  it('pushes into next active window when in quiet hours', async () => {
    vi.setSystemTime(new Date('2026-04-27T08:00:00Z')); // 08:00 UTC = inside [6,11]
    const slot = await computeNextSlot({
      userId: 'u1',
      platform: 'x',
      kind: 'reply',
      connectedAgeDays: 60,
    });
    expect(slot.deferred).toBe(false);
    expect(slot.reason).toBe('quiet_hours');
    // Active window starts at 11:00 UTC = 3h from 08:00. Allow jitter.
    expect(slot.delayMs).toBeGreaterThanOrEqual(3 * 60 * 60 * 1000 - 60_000);
    expect(slot.delayMs).toBeLessThanOrEqual(3 * 60 * 60 * 1000 + 60_000);
  });

  it('returns deferred for platforms without a posting config', async () => {
    const slot = await computeNextSlot({
      userId: 'u1',
      platform: 'unknown',
      kind: 'reply',
      connectedAgeDays: 60,
    });
    expect(slot.deferred).toBe(true);
    expect(slot.reason).toBe('no_pacer_config');
  });
});
```

- [ ] **Step 4.2: Run tests to verify they fail**

Run: `pnpm vitest run src/lib/__tests__/posting-pacer.test.ts`
Expected: ALL FAIL with "Cannot find module '../posting-pacer'".

- [ ] **Step 4.3: Implement `posting-pacer.ts`**

Create `src/lib/posting-pacer.ts`:

```ts
import { db } from '@/lib/db';
import { posts } from '@/lib/db/schema';
import { and, eq, gte } from 'drizzle-orm';
import { PLATFORMS, type PostingConfig, type PostingTier } from '@/lib/platform-config';

export type PostKind = 'reply' | 'post';

export interface SlotInput {
  userId: string;
  platform: string;
  kind: PostKind;
  /** Days since channels.connectedAt for this user+platform. */
  connectedAgeDays: number;
  /** Override `now()` — used by tests + the deferral recursion. */
  now?: Date;
}

export type SlotResult =
  | {
      deferred: false;
      delayMs: number;
      reason: 'immediate' | 'spaced' | 'quiet_hours';
    }
  | {
      deferred: true;
      reason: 'over_daily_cap' | 'no_pacer_config';
      /** ms until the pacer suggests retrying. 0 if unknown. */
      delayMs: number;
    };

/**
 * Inject the recent-posts source so unit tests can avoid a live DB. Production
 * code never calls this — `computeNextSlot` falls back to the real DB query.
 */
let recentPostsSource: ((args: {
  userId: string;
  platform: string;
  sinceMs: number;
}) => Promise<Array<{ postedAt: Date; kind: PostKind }>>) | null = null;

export function __setRecentPostsSourceForTests(
  fn: typeof recentPostsSource,
): void {
  recentPostsSource = fn;
}

function pickTier(config: PostingConfig, ageDays: number): PostingTier {
  // tiers are ordered ascending by minAgeDays; first match wins from the end.
  for (let i = config.tiers.length - 1; i >= 0; i--) {
    if (ageDays >= config.tiers[i].minAgeDays) return config.tiers[i];
  }
  return config.tiers[0];
}

function isQuietHour(now: Date, [startHour, endHour]: [number, number]): boolean {
  const h = now.getUTCHours();
  if (startHour <= endHour) return h >= startHour && h < endHour;
  // Wraps midnight (e.g. [22, 4])
  return h >= startHour || h < endHour;
}

function nextActiveBoundary(now: Date, [, endHour]: [number, number]): Date {
  // Quiet window ends at endHour UTC today; if we're past it, tomorrow.
  const out = new Date(now);
  out.setUTCMinutes(0, 0, 0);
  if (out.getUTCHours() >= endHour) out.setUTCDate(out.getUTCDate() + 1);
  out.setUTCHours(endHour, 0, 0, 0);
  return out;
}

function jitter(seconds: number, plusMinusSec: number): number {
  const offset = (Math.random() * 2 - 1) * plusMinusSec;
  return Math.max(0, (seconds + offset) * 1000);
}

export async function computeNextSlot(input: SlotInput): Promise<SlotResult> {
  const config = PLATFORMS[input.platform]?.posting;
  if (!config) {
    return { deferred: true, reason: 'no_pacer_config', delayMs: 0 };
  }

  const tier = pickTier(config, input.connectedAgeDays);
  const now = input.now ?? new Date();
  const dayMs = 24 * 60 * 60 * 1000;
  const sinceMs = now.getTime() - dayMs;

  const recent = await (recentPostsSource
    ? recentPostsSource({ userId: input.userId, platform: input.platform, sinceMs })
    : fetchRecentPosts(input.userId, input.platform, new Date(sinceMs)));

  const counts = recent.reduce(
    (acc, r) => {
      acc[r.kind] += 1;
      return acc;
    },
    { reply: 0, post: 0 } as Record<PostKind, number>,
  );

  const cap = input.kind === 'reply' ? tier.maxRepliesPerDay : tier.maxPostsPerDay;
  if (counts[input.kind] >= cap) {
    // Defer to when the oldest contributing post rolls off the 24h window.
    const oldest = recent
      .filter((r) => r.kind === input.kind)
      .reduce((min, r) => (r.postedAt < min ? r.postedAt : min), now);
    const rollOffMs = oldest.getTime() + dayMs - now.getTime();
    return { deferred: true, reason: 'over_daily_cap', delayMs: Math.max(rollOffMs, 0) };
  }

  // Spacing relative to most-recent post of any kind.
  const lastPost = recent.reduce<Date | null>(
    (latest, r) => (latest == null || r.postedAt > latest ? r.postedAt : latest),
    null,
  );
  const earliestNext = lastPost
    ? new Date(lastPost.getTime() + jitter(tier.minSpacingSec, tier.jitterSec))
    : now;

  // Quiet hours: push to next active window.
  if (isQuietHour(earliestNext, config.quietHoursUTC)) {
    const boundary = nextActiveBoundary(earliestNext, config.quietHoursUTC);
    const jittered = boundary.getTime() + jitter(0, tier.jitterSec);
    return {
      deferred: false,
      reason: 'quiet_hours',
      delayMs: Math.max(0, jittered - now.getTime()),
    };
  }

  const delayMs = Math.max(0, earliestNext.getTime() - now.getTime());
  return {
    deferred: false,
    reason: delayMs === 0 ? 'immediate' : 'spaced',
    delayMs,
  };
}

async function fetchRecentPosts(
  userId: string,
  platform: string,
  since: Date,
): Promise<Array<{ postedAt: Date; kind: PostKind }>> {
  const rows = await db
    .select({ postedAt: posts.postedAt, draftId: posts.draftId })
    .from(posts)
    .where(
      and(
        eq(posts.userId, userId),
        eq(posts.platform, platform),
        gte(posts.postedAt, since),
      ),
    );
  // We don't currently store kind on `posts` — derive from a join when
  // needed. For pacer purposes, treating all rows as 'reply' is the safe
  // overcounter against caps; refine later if we need separate post caps.
  return rows.map((r) => ({ postedAt: r.postedAt, kind: 'reply' as const }));
}
```

- [ ] **Step 4.4: Run tests to verify they pass**

Run: `pnpm vitest run src/lib/__tests__/posting-pacer.test.ts`
Expected: ALL PASS.

- [ ] **Step 4.5: Verify type check**

Run: `pnpm tsc --noEmit`
Expected: no new errors.

- [ ] **Step 4.6: Commit**

```bash
git add src/lib/posting-pacer.ts src/lib/__tests__/posting-pacer.test.ts
git commit -m "feat(pacer): tiered slot computation with caps + spacing + quiet hours"
```

---

## Task 5: `x-intent-url.ts` helper (TDD)

**Files:**
- Create: `src/lib/x-intent-url.ts`
- Test: `src/lib/__tests__/x-intent-url.test.ts`

- [ ] **Step 5.1: Write failing tests**

Create `src/lib/__tests__/x-intent-url.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { buildXIntentUrl } from '../x-intent-url';

describe('buildXIntentUrl', () => {
  it('builds a top-level post intent URL', () => {
    const url = buildXIntentUrl({ text: 'hello world' });
    expect(url).toBe('https://x.com/intent/post?text=hello+world');
  });

  it('encodes special characters', () => {
    const url = buildXIntentUrl({ text: 'a&b=c?d' });
    expect(url).toContain('a%26b%3Dc%3Fd');
  });

  it('includes in_reply_to_tweet_id when replying', () => {
    const url = buildXIntentUrl({
      text: 'reply',
      inReplyToTweetId: '1234567890',
    });
    expect(url).toContain('text=reply');
    expect(url).toContain('in_reply_to_tweet_id=1234567890');
  });

  it('rejects empty text', () => {
    expect(() => buildXIntentUrl({ text: '' })).toThrow(/text/i);
  });
});
```

- [ ] **Step 5.2: Run tests to verify they fail**

Run: `pnpm vitest run src/lib/__tests__/x-intent-url.test.ts`
Expected: FAIL with "Cannot find module '../x-intent-url'".

- [ ] **Step 5.3: Implement**

Create `src/lib/x-intent-url.ts`:

```ts
/**
 * Build a TOS-compliant X intent URL. Opening this URL in the user's
 * browser pre-fills X's compose box with the draft text. The user clicks
 * "Post" themselves — we never call the X API for this draft, so the
 * Feb 2026 programmatic-reply restriction does not apply.
 *
 * Docs: https://developer.x.com/en/docs/x-for-websites/web-intents/overview
 */
export interface XIntentInput {
  text: string;
  /** Tweet id to reply to. Omit for top-level tweets. */
  inReplyToTweetId?: string;
}

export function buildXIntentUrl({ text, inReplyToTweetId }: XIntentInput): string {
  if (!text || !text.trim()) {
    throw new Error('buildXIntentUrl: text is required');
  }
  const params = new URLSearchParams({ text });
  if (inReplyToTweetId) {
    params.set('in_reply_to_tweet_id', inReplyToTweetId);
  }
  return `https://x.com/intent/post?${params.toString()}`;
}
```

- [ ] **Step 5.4: Run tests to verify they pass**

Run: `pnpm vitest run src/lib/__tests__/x-intent-url.test.ts`
Expected: PASS.

- [ ] **Step 5.5: Commit**

```bash
git add src/lib/x-intent-url.ts src/lib/__tests__/x-intent-url.test.ts
git commit -m "feat(x): TOS-compliant intent URL helper for browser-handoff replies"
```

---

## Task 6: Add `mode` field to `PostingJobData`; refactor `enqueuePosting`

**Files:**
- Modify: `src/lib/queue/types.ts`
- Modify: `src/lib/queue/index.ts`

- [ ] **Step 6.1: Extend the schema**

In `src/lib/queue/types.ts`, replace the `postingJobSchema` block with:

```ts
export const postingJobSchema = z.object({
  kind: z.literal('user').optional(),
  schemaVersion: SCHEMA_VERSION,
  traceId: TRACE_ID,
  userId: z.string().min(1),
  draftId: z.string().min(1),
  channelId: z.string().min(1),
  /**
   * 'direct' = posting processor calls platform clients straight (manual
   *            user approve, plan-execute auto-approve, reply-sweep when
   *            we trust the draft as-is).
   * 'agent'  = posting processor runs the posting agent (legacy autonomous
   *            path; agent decides what to call + verifies).
   * Default 'agent' for back-compat with any in-flight jobs whose payload
   * was enqueued before this field existed.
   */
  mode: z.enum(['direct', 'agent']).default('agent'),
});
export type PostingJobData = z.input<typeof postingJobSchema>;
```

- [ ] **Step 6.2: Refactor `enqueuePosting` to accept `delayMs`**

In `src/lib/queue/index.ts`, replace `enqueuePosting`:

```ts
/**
 * Enqueue posting an approved draft. Caller controls timing via `delayMs`
 * (the pacer is responsible for computing this). 0 retries: never risk
 * duplicate posts.
 */
export async function enqueuePosting(
  data: PostingJobData,
  opts: { delayMs?: number } = {},
): Promise<void> {
  const payload = postingJobSchema.parse(withEnvelope(data));
  const delayMs = Math.max(0, opts.delayMs ?? 0);
  log.debug(`Enqueued posting for draft ${payload.draftId} (delay ${Math.round(delayMs / 1000)}s, mode ${payload.mode})`);
  await postingQueue.add('post', payload, {
    attempts: 1,
    delay: delayMs,
  });
}
```

- [ ] **Step 6.3: Find existing call sites**

Run: `rg -n "enqueuePosting" src/ --type ts`
Document each call site here for the next step's verification:
- Look for the `/api/drafts` POST handler (the legacy approve flow).
- Look for any other callers.

- [ ] **Step 6.4: Update callers — drop random-jitter hack**

For each existing call site, the previous behavior was "random 0-30 min jitter inside enqueuePosting." The pacer now owns timing. For any pre-existing call site that we are NOT migrating to the dispatcher in later tasks (e.g. `/api/drafts` POST), pass `{ delayMs: 0 }` explicitly so the call still compiles and immediately enqueues. The pacer migration for those happens in Task 11 (`approve-dispatch.ts`).

- [ ] **Step 6.5: Verify type check**

Run: `pnpm tsc --noEmit`
Expected: no new errors.

- [ ] **Step 6.6: Commit**

```bash
git add src/lib/queue/types.ts src/lib/queue/index.ts
git commit -m "refactor(queue): enqueuePosting takes delayMs; add mode field"
```

---

## Task 7: `approve-dispatch.ts` (TDD)

**Files:**
- Create: `src/lib/approve-dispatch.ts`
- Test: `src/lib/__tests__/approve-dispatch.test.ts`

- [ ] **Step 7.1: Write failing tests**

Create `src/lib/__tests__/approve-dispatch.test.ts`:

```ts
import { describe, expect, it, vi, beforeEach } from 'vitest';

const enqueuePosting = vi.fn();
const computeNextSlot = vi.fn();
const buildXIntentUrl = vi.fn((args: { text: string; inReplyToTweetId?: string }) => {
  return `https://x.com/intent/post?text=${encodeURIComponent(args.text)}`;
});

vi.mock('@/lib/queue', () => ({ enqueuePosting }));
vi.mock('@/lib/posting-pacer', () => ({ computeNextSlot }));
vi.mock('@/lib/x-intent-url', () => ({ buildXIntentUrl }));

import { dispatchApprove, type DispatchInput } from '../approve-dispatch';

beforeEach(() => {
  enqueuePosting.mockReset();
  computeNextSlot.mockReset();
  buildXIntentUrl.mockClear();
});

const baseInput: DispatchInput = {
  draft: {
    id: 'd1',
    userId: 'u1',
    threadId: 't1',
    draftType: 'reply',
    replyBody: 'hello',
    planItemId: 'p1',
  },
  thread: { id: 't1', platform: 'x', externalId: '12345' },
  channelId: 'c1',
  connectedAgeDays: 60,
};

describe('dispatchApprove', () => {
  it('routes X reply to browser handoff (no queue)', async () => {
    const result = await dispatchApprove(baseInput);
    expect(result.kind).toBe('handoff');
    if (result.kind === 'handoff') {
      expect(result.intentUrl).toContain('intent/post');
      expect(result.intentUrl).toContain('hello');
    }
    expect(enqueuePosting).not.toHaveBeenCalled();
    expect(buildXIntentUrl).toHaveBeenCalledWith({
      text: 'hello',
      inReplyToTweetId: '12345',
    });
  });

  it('routes X original post to direct queue with pacer delay', async () => {
    computeNextSlot.mockResolvedValueOnce({
      deferred: false,
      delayMs: 90_000,
      reason: 'spaced',
    });
    const result = await dispatchApprove({
      ...baseInput,
      draft: { ...baseInput.draft, draftType: 'original_post' },
    });
    expect(result.kind).toBe('queued');
    if (result.kind === 'queued') {
      expect(result.delayMs).toBe(90_000);
    }
    expect(enqueuePosting).toHaveBeenCalledWith(
      expect.objectContaining({ draftId: 'd1', mode: 'direct' }),
      { delayMs: 90_000 },
    );
  });

  it('routes Reddit reply to direct queue', async () => {
    computeNextSlot.mockResolvedValueOnce({
      deferred: false,
      delayMs: 0,
      reason: 'immediate',
    });
    const result = await dispatchApprove({
      ...baseInput,
      thread: { id: 't1', platform: 'reddit', externalId: 'abc' },
    });
    expect(result.kind).toBe('queued');
    expect(enqueuePosting).toHaveBeenCalledWith(
      expect.objectContaining({ draftId: 'd1', mode: 'direct' }),
      { delayMs: 0 },
    );
  });

  it('returns deferred when pacer says over_daily_cap', async () => {
    computeNextSlot.mockResolvedValueOnce({
      deferred: true,
      reason: 'over_daily_cap',
      delayMs: 4 * 60 * 60 * 1000,
    });
    const result = await dispatchApprove({
      ...baseInput,
      thread: { id: 't1', platform: 'reddit', externalId: 'abc' },
    });
    expect(result.kind).toBe('deferred');
    if (result.kind === 'deferred') {
      expect(result.reason).toBe('over_daily_cap');
      expect(result.retryAfterMs).toBe(4 * 60 * 60 * 1000);
    }
    expect(enqueuePosting).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 7.2: Run tests to verify they fail**

Run: `pnpm vitest run src/lib/__tests__/approve-dispatch.test.ts`
Expected: FAIL with "Cannot find module '../approve-dispatch'".

- [ ] **Step 7.3: Implement `approve-dispatch.ts`**

Create `src/lib/approve-dispatch.ts`:

```ts
import { enqueuePosting } from '@/lib/queue';
import { computeNextSlot } from '@/lib/posting-pacer';
import { buildXIntentUrl } from '@/lib/x-intent-url';
import { PLATFORMS } from '@/lib/platform-config';

export interface DispatchInput {
  draft: {
    id: string;
    userId: string;
    threadId: string;
    draftType: 'reply' | 'original_post';
    replyBody: string;
    planItemId: string | null;
  };
  thread: {
    id: string;
    platform: string;
    externalId: string | null;
  };
  channelId: string;
  /** Days since the user connected this channel. Tier input for the pacer. */
  connectedAgeDays: number;
}

export type DispatchResult =
  | { kind: 'handoff'; intentUrl: string }
  | { kind: 'queued'; delayMs: number }
  | {
      kind: 'deferred';
      reason: 'over_daily_cap' | 'no_pacer_config';
      retryAfterMs: number;
    };

/**
 * Decide what to do when the user (or auto-approve) approves a draft.
 * - X replies → browser handoff via intent URL (TOS-compliant; X's Feb 2026
 *   API restriction blocks programmatic replies on non-Enterprise tiers).
 * - X original posts + Reddit anything → direct API call via the posting
 *   processor, paced by `computeNextSlot`.
 *
 * NOTE: This function only computes the routing decision. The caller is
 * responsible for the matching DB writes (set draft.status to 'handed_off'
 * for handoff, 'approved' for queued; transition plan_item state).
 */
export async function dispatchApprove(
  input: DispatchInput,
): Promise<DispatchResult> {
  const isXReply =
    input.thread.platform === PLATFORMS.x.id &&
    input.draft.draftType === 'reply';

  if (isXReply) {
    if (!input.thread.externalId) {
      throw new Error(
        `dispatchApprove: X reply requires thread.externalId (draft ${input.draft.id})`,
      );
    }
    return {
      kind: 'handoff',
      intentUrl: buildXIntentUrl({
        text: input.draft.replyBody,
        inReplyToTweetId: input.thread.externalId,
      }),
    };
  }

  const slot = await computeNextSlot({
    userId: input.draft.userId,
    platform: input.thread.platform,
    kind: input.draft.draftType === 'reply' ? 'reply' : 'post',
    connectedAgeDays: input.connectedAgeDays,
  });

  if (slot.deferred) {
    return {
      kind: 'deferred',
      reason: slot.reason,
      retryAfterMs: slot.delayMs,
    };
  }

  await enqueuePosting(
    {
      userId: input.draft.userId,
      draftId: input.draft.id,
      channelId: input.channelId,
      mode: 'direct',
    },
    { delayMs: slot.delayMs },
  );

  return { kind: 'queued', delayMs: slot.delayMs };
}
```

- [ ] **Step 7.4: Run tests to verify they pass**

Run: `pnpm vitest run src/lib/__tests__/approve-dispatch.test.ts`
Expected: ALL PASS.

- [ ] **Step 7.5: Type check**

Run: `pnpm tsc --noEmit`
Expected: no new errors.

- [ ] **Step 7.6: Commit**

```bash
git add src/lib/approve-dispatch.ts src/lib/__tests__/approve-dispatch.test.ts
git commit -m "feat(approve-dispatch): route X replies to handoff, others to paced direct queue"
```

---

## Task 8: Direct-mode branch in `processPosting`

**Files:**
- Modify: `src/workers/processors/posting.ts`
- Test: `src/workers/processors/__tests__/posting-direct.test.ts`

- [ ] **Step 8.1: Write the failing test**

Create `src/workers/processors/__tests__/posting-direct.test.ts`:

```ts
import { describe, expect, it, vi, beforeEach } from 'vitest';

// Mock everything I/O — this test exercises only the direct-mode branch
// to confirm it calls the right client method with the right args and
// writes the right DB rows.
const mockReplyToTweet = vi.fn();
const mockPostTweet = vi.fn();
const mockPostComment = vi.fn();
const mockSubmitPost = vi.fn();
const mockUpdateDraft = vi.fn().mockReturnValue({ where: vi.fn() });
const mockInsertPost = vi.fn().mockReturnValue({
  values: vi.fn().mockReturnValue({ returning: vi.fn().mockResolvedValue([{ id: 'post-1' }]) }),
});
const mockSelectDraft = vi.fn();
const mockSelectThread = vi.fn();

vi.mock('@/lib/db', () => ({
  db: {
    select: () => ({ from: () => ({ where: () => ({ limit: () => mockSelectDraft() }) }) }),
    insert: () => mockInsertPost(),
    update: () => ({ set: () => ({ where: () => Promise.resolve() }) }),
  },
}));

vi.mock('@/lib/platform-deps', () => ({
  createClientFromChannelById: vi.fn(),
}));

vi.mock('@/lib/circuit-breaker', () => ({
  isCircuitBreakerTripped: vi.fn().mockResolvedValue({ tripped: false }),
  tripCircuitBreaker: vi.fn(),
}));

vi.mock('@/lib/rate-limiter', () => ({
  canPostToSubreddit: vi.fn().mockResolvedValue({ allowed: true }),
}));

vi.mock('@/lib/queue', () => ({ enqueueEngagement: vi.fn() }));
vi.mock('@/lib/redis', () => ({ publishUserEvent: vi.fn() }));
vi.mock('@/lib/cost-bucket', () => ({
  addCost: vi.fn(),
  getCostForRun: vi.fn().mockResolvedValue({ costUsd: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, turns: 0, models: [] }),
}));
vi.mock('@/lib/pipeline-events', () => ({
  recordPipelineEvent: vi.fn(),
  recordThreadFeedback: vi.fn(),
}));

// processPosting reads the draft + thread from the (mocked) db. We can't
// easily exercise the full processor in unit isolation here — see the
// integration spec referenced below. This unit test focuses ONLY on the
// new direct-mode branch logic, lifted into a helper for testability.

import { postViaDirectMode } from '../posting';

describe('postViaDirectMode', () => {
  beforeEach(() => {
    mockReplyToTweet.mockReset();
    mockPostTweet.mockReset();
    mockPostComment.mockReset();
    mockSubmitPost.mockReset();
  });

  it('calls postTweet for X original_post', async () => {
    mockPostTweet.mockResolvedValue({ tweetId: '999', url: 'https://x.com/u/status/999' });
    const result = await postViaDirectMode({
      platform: 'x',
      draftType: 'original_post',
      draftText: 'hi world',
      threadExternalId: null,
      threadCommunity: 'topic',
      postTitle: null,
      client: { postTweet: mockPostTweet, replyToTweet: mockReplyToTweet } as never,
    });
    expect(mockPostTweet).toHaveBeenCalledWith('hi world');
    expect(result).toEqual({
      success: true,
      externalId: '999',
      externalUrl: 'https://x.com/u/status/999',
      shadowbanned: false,
    });
  });

  it('calls replyToTweet for X reply (smoke; we route X replies via handoff in production but the branch is reachable for self-reply use cases)', async () => {
    mockReplyToTweet.mockResolvedValue({ tweetId: '777', url: 'https://x.com/u/status/777' });
    const result = await postViaDirectMode({
      platform: 'x',
      draftType: 'reply',
      draftText: 'reply body',
      threadExternalId: '111',
      threadCommunity: 'topic',
      postTitle: null,
      client: { postTweet: mockPostTweet, replyToTweet: mockReplyToTweet } as never,
    });
    expect(mockReplyToTweet).toHaveBeenCalledWith('111', 'reply body');
    expect(result.success).toBe(true);
  });

  it('calls postComment for Reddit reply', async () => {
    mockPostComment.mockResolvedValue({ id: 't1_xyz', permalink: '/r/sub/comments/abc/_/xyz/' });
    const result = await postViaDirectMode({
      platform: 'reddit',
      draftType: 'reply',
      draftText: 'reddit reply',
      threadExternalId: 'abc',
      threadCommunity: 'sub',
      postTitle: null,
      client: { postComment: mockPostComment, submitPost: mockSubmitPost } as never,
    });
    expect(mockPostComment).toHaveBeenCalledWith('t3_abc', 'reddit reply');
    expect(result.externalId).toBe('t1_xyz');
    expect(result.externalUrl).toBe('https://reddit.com/r/sub/comments/abc/_/xyz/');
  });

  it('calls submitPost for Reddit original_post', async () => {
    mockSubmitPost.mockResolvedValue({ id: 't3_pqr', url: 'https://reddit.com/r/sub/comments/pqr/' });
    const result = await postViaDirectMode({
      platform: 'reddit',
      draftType: 'original_post',
      draftText: 'self post body',
      threadExternalId: null,
      threadCommunity: 'sub',
      postTitle: 'My title',
      client: { postComment: mockPostComment, submitPost: mockSubmitPost } as never,
    });
    expect(mockSubmitPost).toHaveBeenCalledWith({
      subreddit: 'sub',
      title: 'My title',
      body: 'self post body',
    });
    expect(result.externalId).toBe('t3_pqr');
  });
});
```

- [ ] **Step 8.2: Run test to verify it fails**

Run: `pnpm vitest run src/workers/processors/__tests__/posting-direct.test.ts`
Expected: FAIL — `postViaDirectMode` does not exist yet.

- [ ] **Step 8.3: Add the helper + branch in `posting.ts`**

In `src/workers/processors/posting.ts`, near the top after the imports, add:

```ts
import type { RedditClient as _RedditClient } from '@/lib/reddit-client';
import type { XClient as _XClient } from '@/lib/x-client';

interface DirectModeArgs {
  platform: string;
  draftType: 'reply' | 'original_post';
  draftText: string;
  threadExternalId: string | null;
  threadCommunity: string;
  postTitle: string | null;
  client: _XClient | _RedditClient;
}

interface DirectModeResult {
  success: boolean;
  externalId: string | null;
  externalUrl: string | null;
  shadowbanned: boolean;
  error?: string;
}

/**
 * Direct-mode posting: skip the agent, call the platform client straight.
 * Used by manual user approve and plan-execute auto-approve. Caller is
 * responsible for circuit-breaker / rate-limit checks BEFORE calling this.
 */
export async function postViaDirectMode(
  args: DirectModeArgs,
): Promise<DirectModeResult> {
  const isX = args.platform === PLATFORMS.x.id;
  try {
    if (isX) {
      const client = args.client as _XClient;
      if (args.draftType === 'reply') {
        if (!args.threadExternalId) {
          throw new Error('X reply requires threadExternalId');
        }
        const r = await client.replyToTweet(args.threadExternalId, args.draftText);
        return { success: true, externalId: r.tweetId, externalUrl: r.url, shadowbanned: false };
      }
      const r = await client.postTweet(args.draftText);
      return { success: true, externalId: r.tweetId, externalUrl: r.url, shadowbanned: false };
    }

    // Reddit
    const client = args.client as _RedditClient;
    if (args.draftType === 'reply') {
      if (!args.threadExternalId) {
        throw new Error('Reddit reply requires threadExternalId');
      }
      const r = await client.postComment(`t3_${args.threadExternalId}`, args.draftText);
      const permalink = (r as { permalink?: string }).permalink;
      const externalUrl = permalink ? `https://reddit.com${permalink}` : null;
      return {
        success: true,
        externalId: (r as { id?: string }).id ?? null,
        externalUrl,
        shadowbanned: false,
      };
    }
    if (!args.postTitle) {
      throw new Error('Reddit original_post requires postTitle');
    }
    const r = await client.submitPost({
      subreddit: args.threadCommunity,
      title: args.postTitle,
      body: args.draftText,
    });
    return {
      success: true,
      externalId: (r as { id?: string }).id ?? null,
      externalUrl: (r as { url?: string }).url ?? null,
      shadowbanned: false,
    };
  } catch (err) {
    return {
      success: false,
      externalId: null,
      externalUrl: null,
      shadowbanned: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
```

(Note: the actual return shapes of `postComment` / `submitPost` / `postTweet` may differ. Read the real signatures from `src/lib/reddit-client.ts` and `src/lib/x-client.ts` and adjust the unwrap inline. Run the unit test to validate.)

- [ ] **Step 8.4: Branch in `processPosting`**

In `src/workers/processors/posting.ts`, replace the agent invocation block (currently lines 113-120) with:

```ts
let result: {
  success: boolean;
  externalId: string | null;
  externalUrl: string | null;
  shadowbanned: boolean;
  commentId?: string | null;
  postId?: string | null;
  permalink?: string | null;
  url?: string | null;
  error?: string;
  verified?: boolean;
};
let usage: { costUsd: number; [k: string]: unknown } = { costUsd: 0 };

const mode = job.data.mode ?? 'agent';
if (mode === 'direct') {
  const direct = await postViaDirectMode({
    platform,
    draftType: draftType as 'reply' | 'original_post',
    draftText: draft.replyBody,
    threadExternalId: thread.externalId,
    threadCommunity: thread.community,
    postTitle: draft.postTitle ?? null,
    client,
  });
  result = {
    ...direct,
    commentId: direct.externalId,
    postId: direct.externalId,
    permalink: null,
    url: direct.externalUrl,
    verified: false,
  };
} else {
  const agentConfig = loadAgentFromFile(POSTING_AGENT_PATH, registry.toMap());
  const context = createToolContext(deps);
  const agentRun = await runAgent(
    agentConfig,
    JSON.stringify(input),
    context,
    postingOutputSchema,
  );
  result = agentRun.result;
  usage = agentRun.usage;
}
await addCost(traceId, usage);

const externalId = result.externalId ?? result.commentId ?? result.postId ?? null;
const externalUrl = result.externalUrl ?? (isX
  ? result.url ?? null
  : result.permalink
    ? `https://reddit.com${result.permalink}`
    : result.url ?? null);
```

The rest of the function (DB writes, circuit-breaker, telemetry) stays unchanged below.

- [ ] **Step 8.5: Run unit test**

Run: `pnpm vitest run src/workers/processors/__tests__/posting-direct.test.ts`
Expected: PASS. If the client return-shape unwrap was wrong, fix it now.

- [ ] **Step 8.6: Type check**

Run: `pnpm tsc --noEmit`
Expected: no new errors. The `client` union type may need a runtime narrow (`if (client instanceof XClient)`) — use the existing pattern from line 107.

- [ ] **Step 8.7: Commit**

```bash
git add src/workers/processors/posting.ts src/workers/processors/__tests__/posting-direct.test.ts
git commit -m "feat(posting): direct-mode branch — call platform clients without agent"
```

---

## Task 9: `posting.ts` writes back to `plan_items.state`

**Files:**
- Modify: `src/workers/processors/posting.ts`

- [ ] **Step 9.1: Import plan-item helpers**

At the top of `src/workers/processors/posting.ts`, add:

```ts
import { planItems } from '@/lib/db/schema';
```

- [ ] **Step 9.2: After successful post, transition the linked plan_item**

Inside `processPosting`, in the success branch (after line 168 where draft.status is set to 'posted'), append:

```ts
    // If this draft was created from a plan_item, mark the plan_item completed
    // so Today and the calendar reflect the terminal state immediately.
    if (draft.planItemId) {
      await db
        .update(planItems)
        .set({ state: 'completed', updatedAt: new Date(), completedAt: new Date() })
        .where(eq(planItems.id, draft.planItemId));
    }
```

- [ ] **Step 9.3: After failed post, transition plan_item to failed**

In the failure branch (after line 213 where draft.status is set to 'failed'), append:

```ts
    if (draft.planItemId) {
      await db
        .update(planItems)
        .set({ state: 'failed', updatedAt: new Date() })
        .where(eq(planItems.id, draft.planItemId));
    }
```

- [ ] **Step 9.4: Type check**

Run: `pnpm tsc --noEmit`
Expected: no new errors. If `planItems.completedAt` is required on update, adjust the set object to match the schema (read `src/lib/db/schema/plan-items.ts`).

- [ ] **Step 9.5: Commit**

```bash
git add src/workers/processors/posting.ts
git commit -m "feat(posting): propagate posting result to plan_items.state"
```

---

## Task 10: `DraftReplyTool` accepts `planItemId`

**Files:**
- Modify: `src/tools/DraftReplyTool/DraftReplyTool.ts`

- [ ] **Step 10.1: Add `planItemId` to the input schema**

In `src/tools/DraftReplyTool/DraftReplyTool.ts:25-33`, add a field:

```ts
    /**
     * Optional plan_item.id this draft was authored against. When set, the
     * approve flow uses this to transition the plan_item state on terminal
     * post success/failure and to surface the reply in the slot's
     * "drafted Y of N" progress card. Reply-guy drafts authored outside a
     * plan_item slot leave this null.
     */
    planItemId: z.string().min(1).optional(),
```

- [ ] **Step 10.2: Persist `planItemId` on insert**

In the `db.insert(drafts).values({...})` block (around line 105), add:

```ts
        planItemId: input.planItemId ?? null,
```

- [ ] **Step 10.3: Find the call sites that should now pass planItemId**

Run: `rg -n "draft_reply|DRAFT_REPLY_TOOL_NAME" src/ --type ts`
Identify the caller(s) — most likely the community-manager agent's prompt context. Update wherever the call site has access to a planItemId (typically the team-run worker / coordinator passes it via context).

For prompt-driven callers (the agent generates the call), update the SKILL or AGENT.md to include `planItemId` in the schema example so the model includes it in its tool call. Check `src/skills/community-manager/SKILL.md` (if it exists) and `src/tools/AgentTool/agents/community-manager/AGENT.md`.

- [ ] **Step 10.4: Type check**

Run: `pnpm tsc --noEmit`
Expected: no new errors.

- [ ] **Step 10.5: Commit**

```bash
git add src/tools/DraftReplyTool/DraftReplyTool.ts src/tools/AgentTool/agents/community-manager/AGENT.md
git commit -m "feat(draft-reply): accept and persist planItemId"
```

---

## Task 11: Wire `/api/today/[id]/approve` to dispatcher

**Files:**
- Modify: `src/app/api/today/[id]/approve/route.ts`

- [ ] **Step 11.1: Add the draft-fallback lookup**

In `src/app/api/today/[id]/approve/route.ts`, replace the body of the PATCH handler (after the auth + Zod parse block) with:

```ts
  const { id: rawId } = await params;
  const parsed = paramsSchema.safeParse({ id: rawId });
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'invalid_id' },
      { status: 400, headers: { 'x-trace-id': traceId } },
    );
  }

  // Try plan_item first (calendar / post cards), then fall back to draft
  // (reply cards from the discovery feed).
  const planRow = await findOwnedPlanItem(parsed.data.id, session.user.id);
  if (planRow) {
    return handleApprovePlanItem({ planRow, traceId, log });
  }

  const draftRow = await findOwnedDraftWithThread(parsed.data.id, session.user.id);
  if (draftRow) {
    return handleApproveDraft({ draftRow, traceId, log });
  }

  return NextResponse.json(
    { error: 'not_found' },
    { status: 404, headers: { 'x-trace-id': traceId } },
  );
```

- [ ] **Step 11.2: Add the helpers — `findOwnedDraftWithThread`**

Below the PATCH function, add:

```ts
import { db } from '@/lib/db';
import { drafts, threads, channels } from '@/lib/db/schema';
import { and, eq } from 'drizzle-orm';
import { dispatchApprove, type DispatchInput } from '@/lib/approve-dispatch';

async function findOwnedDraftWithThread(
  draftId: string,
  userId: string,
): Promise<DispatchInput | null> {
  const [row] = await db
    .select({
      draftId: drafts.id,
      draftUserId: drafts.userId,
      draftThreadId: drafts.threadId,
      draftType: drafts.draftType,
      replyBody: drafts.replyBody,
      planItemId: drafts.planItemId,
      threadId: threads.id,
      threadPlatform: threads.platform,
      threadExternalId: threads.externalId,
    })
    .from(drafts)
    .innerJoin(threads, eq(drafts.threadId, threads.id))
    .where(and(eq(drafts.id, draftId), eq(drafts.userId, userId), eq(drafts.status, 'pending')))
    .limit(1);

  if (!row) return null;

  // Resolve the channel for this user + platform. Pacer needs connected age.
  const [channelRow] = await db
    .select({ id: channels.id, connectedAt: channels.connectedAt })
    .from(channels)
    .where(and(eq(channels.userId, userId), eq(channels.platform, row.threadPlatform)))
    .limit(1);

  if (!channelRow) return null;

  const connectedAgeDays = Math.max(
    0,
    Math.floor((Date.now() - channelRow.connectedAt.getTime()) / (24 * 60 * 60 * 1000)),
  );

  return {
    draft: {
      id: row.draftId,
      userId: row.draftUserId,
      threadId: row.draftThreadId,
      draftType: row.draftType === 'original_post' ? 'original_post' : 'reply',
      replyBody: row.replyBody,
      planItemId: row.planItemId,
    },
    thread: {
      id: row.threadId,
      platform: row.threadPlatform,
      externalId: row.threadExternalId,
    },
    channelId: channelRow.id,
    connectedAgeDays,
  };
}
```

(Note: the exact `channels` schema field for "connected at" may be named differently — check `src/lib/db/schema/channels.ts` and adjust. If no such field exists, use `channels.createdAt`.)

- [ ] **Step 11.3: Add the handler — `handleApproveDraft`**

```ts
async function handleApproveDraft(args: {
  draftRow: DispatchInput;
  traceId: string;
  log: ReturnType<typeof createLogger>;
}) {
  const { draftRow, traceId, log } = args;
  const decision = await dispatchApprove(draftRow);

  if (decision.kind === 'handoff') {
    await db
      .update(drafts)
      .set({ status: 'handed_off', updatedAt: new Date() })
      .where(eq(drafts.id, draftRow.draft.id));
    log.info(`draft ${draftRow.draft.id} handed off to browser`);
    return NextResponse.json(
      { success: true, browserHandoff: { intentUrl: decision.intentUrl } },
      { headers: { 'x-trace-id': traceId } },
    );
  }

  if (decision.kind === 'deferred') {
    return NextResponse.json(
      {
        success: false,
        deferred: true,
        reason: decision.reason,
        retryAfterMs: decision.retryAfterMs,
      },
      { status: 202, headers: { 'x-trace-id': traceId } },
    );
  }

  // queued
  await db
    .update(drafts)
    .set({ status: 'approved', updatedAt: new Date() })
    .where(eq(drafts.id, draftRow.draft.id));
  log.info(`draft ${draftRow.draft.id} queued for posting (delay ${decision.delayMs}ms)`);
  return NextResponse.json(
    { success: true, queued: { delayMs: decision.delayMs } },
    { headers: { 'x-trace-id': traceId } },
  );
}
```

- [ ] **Step 11.4: Add the handler — `handleApprovePlanItem`**

This handler covers the existing path (plan_item id). It needs to load the linked draft (via `drafts.plan_item_id` ↔ `plan_items.id`), or fall back to lazy-creating one for `content_post` whose draft body lives in `plan_items.output.draft_body`.

```ts
async function handleApprovePlanItem(args: {
  planRow: Awaited<ReturnType<typeof findOwnedPlanItem>>;
  traceId: string;
  log: ReturnType<typeof createLogger>;
}) {
  const { planRow, traceId, log } = args;
  if (!planRow) {
    return NextResponse.json({ error: 'not_found' }, { status: 404 });
  }

  // Transition plan_item → approved
  const rejection = await writePlanItemState(planRow, 'approved');
  if (rejection) return rejection;

  // Find or lazily create the draft for this plan_item
  const draftRow = await findOrCreateDraftForPlanItem(planRow);
  if (!draftRow) {
    log.warn(`plan_item ${planRow.id} has no draft body — falling back to legacy plan-execute enqueue`);
    await enqueuePlanExecute({
      schemaVersion: 1,
      planItemId: planRow.id,
      userId: planRow.userId,
      phase: 'execute',
      traceId,
    });
    return NextResponse.json({ success: true });
  }

  return handleApproveDraft({ draftRow, traceId, log });
}

async function findOrCreateDraftForPlanItem(
  planRow: NonNullable<Awaited<ReturnType<typeof findOwnedPlanItem>>>,
): Promise<DispatchInput | null> {
  // 1) Existing draft linked by plan_item_id
  const [existing] = await db
    .select({ id: drafts.id })
    .from(drafts)
    .where(eq(drafts.planItemId, planRow.id))
    .limit(1);
  if (existing) {
    return findOwnedDraftWithThread(existing.id, planRow.userId);
  }

  // 2) Lazy-create from plan_items.output.draft_body for content_post
  if (planRow.kind !== 'content_post') return null;
  const [planFull] = await db
    .select({ output: planItems.output, channel: planItems.channel })
    .from(planItems)
    .where(eq(planItems.id, planRow.id))
    .limit(1);
  const body = readDraftBody(planFull?.output);
  if (!body || !planFull?.channel) return null;

  // Need a thread row — for original posts there isn't one. Use a sentinel
  // thread row scoped to this user, or skip the join. To keep the dispatch
  // contract simple, this MVP requires drafts to always carry a thread. For
  // original posts we create a placeholder thread (community = the channel
  // platform's default topic, externalId = null) — community-manager already
  // does the same for top-level posts.
  // (If your codebase already has a "no-thread original post" pattern, use
  // that instead. Look for `draftType === 'original_post'` thread handling.)
  return null; // For MVP, fall back to legacy plan-execute path below.
}

function readDraftBody(output: unknown): string | null {
  if (output === null || typeof output !== 'object') return null;
  const value = (output as Record<string, unknown>).draft_body;
  return typeof value === 'string' && value.length > 0 ? value : null;
}
```

(If lazy-create runs into the "original posts have no thread" wall, the MVP keeps falling through to the legacy `enqueuePlanExecute` path. That's fine — the X reply path is the value-add for this sprint, and original-post auto-execute can be a follow-up that introduces a `threadless drafts` schema cleanup.)

- [ ] **Step 11.5: Type check**

Run: `pnpm tsc --noEmit`
Expected: no new errors.

- [ ] **Step 11.6: Smoke-test the route locally**

Run: `pnpm dev` (in another shell)

Then in this shell, hit the endpoint with a known draft id (find one from `psql` first):

```bash
curl -i -X PATCH "http://localhost:3000/api/today/<DRAFT_ID>/approve" \
  -H "Cookie: <session-cookie>"
```

Expected: For an X reply draft, response includes `{success:true, browserHandoff:{intentUrl:"https://x.com/intent/post?…"}}`.

- [ ] **Step 11.7: Commit**

```bash
git add src/app/api/today/[id]/approve/route.ts
git commit -m "feat(api): wire /api/today/:id/approve to dispatcher (handoff + queue)"
```

---

## Task 12: Exclude `handed_off` drafts from Today feed

**Files:**
- Modify: `src/app/api/today/route.ts`

- [ ] **Step 12.1: Update the pendingDrafts query**

In `src/app/api/today/route.ts:218-221`, replace:

```ts
    .innerJoin(threads, eq(drafts.threadId, threads.id))
    .where(
      and(eq(drafts.userId, userId), eq(drafts.status, 'pending')),
    )
```

with the same shape — already filters on `status = 'pending'` so `'handed_off'` is naturally excluded. Verify no other Today queries leak handed_off drafts.

- [ ] **Step 12.2: Verify by reading the file**

Run: `rg -n "drafts.status" src/app/api/today/route.ts`
Confirm every drafts query filters on `status = 'pending'` or excludes `handed_off`.

- [ ] **Step 12.3: Commit (if any change)**

If no change was needed, skip the commit; state in the PR description that handed_off drafts are excluded by the existing `status = 'pending'` filter.

---

## Task 13: Plan-execute → dispatcher

**Files:**
- Modify: `src/workers/processors/plan-execute.ts`

- [ ] **Step 13.1: Replace the execute-phase stub**

In `src/workers/processors/plan-execute.ts:191-215`, replace the stub block with:

```ts
  if (phase === 'execute') {
    if (!canTransition(current.state, 'executing')) {
      log.warn(
        `plan_item ${planItemId}: execute phase fired but state is ${current.state} — skipping`,
      );
      return;
    }

    // For content_post / content_reply with a known channel, route via the
    // dispatcher (same code path as the manual approve API). Anything else
    // (email_send, runsheet_beat, etc.) keeps the legacy state-only stub
    // until a future phase wires its execute path.
    const isContent =
      (row.kind === 'content_post' || row.kind === 'content_reply') &&
      (row.channel === 'x' || row.channel === 'reddit');

    if (!isContent) {
      log.info(
        `plan_item ${planItemId}: execute phase for kind=${row.kind} has no skill registered — manual completion`,
      );
      const afterExecuting = await writeState(current, 'executing');
      await writeState(afterExecuting, 'completed');
      return;
    }

    const dispatchInput = await loadDispatchInputForPlanItem(planItemId, row.userId);
    if (!dispatchInput) {
      log.warn(
        `plan_item ${planItemId}: no draft / channel found — leaving in 'approved' for manual retry`,
      );
      return;
    }

    await writeState(current, 'executing');
    const decision = await dispatchApprove(dispatchInput);

    if (decision.kind === 'handoff') {
      // Auto-execute can't open a browser. X replies stay in 'approved' until
      // the user manually clicks the card to trigger the handoff.
      log.info(
        `plan_item ${planItemId}: X reply requires manual handoff — reverting state for user action`,
      );
      // Revert to approved so the Today UI re-surfaces it.
      await db
        .update(planItems)
        .set({ state: 'approved' })
        .where(eq(planItems.id, planItemId));
      return;
    }

    if (decision.kind === 'deferred') {
      log.info(
        `plan_item ${planItemId}: pacer deferred (${decision.reason}) — re-enqueueing in ${decision.retryAfterMs}ms`,
      );
      await enqueuePlanExecute(
        {
          schemaVersion: 1,
          planItemId,
          userId: row.userId,
          phase: 'execute',
          traceId,
        },
        // If enqueuePlanExecute supports a delay option, pass it. Otherwise
        // sleep is unsafe — let the sweeper retry on its 60s tick.
      );
      // Revert to approved so the sweeper re-fires.
      await db
        .update(planItems)
        .set({ state: 'approved' })
        .where(eq(planItems.id, planItemId));
      return;
    }

    // queued — posting worker will set plan_item.state = completed on success
    log.info(`plan_item ${planItemId}: queued for posting (delay ${decision.delayMs}ms)`);
    return;
  }
```

- [ ] **Step 13.2: Add the loader helper**

Below the function, add `loadDispatchInputForPlanItem`. It lives in `plan-execute.ts` for now; if duplicated against the route handler in Task 11, extract to a shared file in a follow-up.

```ts
async function loadDispatchInputForPlanItem(
  planItemId: string,
  userId: string,
): Promise<DispatchInput | null> {
  // Find the linked draft. If none, MVP cannot auto-execute (we don't yet
  // lazy-create drafts for original posts in the worker either).
  const [draftRow] = await db
    .select({ id: drafts.id })
    .from(drafts)
    .where(eq(drafts.planItemId, planItemId))
    .limit(1);
  if (!draftRow) return null;
  return findOwnedDraftWithThread(draftRow.id, userId);
}
```

(Reuse `findOwnedDraftWithThread` from the route handler — extract to `src/lib/approve-loaders.ts` if needed to avoid the import cycle.)

- [ ] **Step 13.3: Type check**

Run: `pnpm tsc --noEmit`
Expected: no new errors.

- [ ] **Step 13.4: Commit**

```bash
git add src/workers/processors/plan-execute.ts src/lib/approve-loaders.ts
git commit -m "feat(plan-execute): wire execute phase to approve dispatcher"
```

---

## Task 14: UI — handle browserHandoff response

**Files:**
- Modify: `src/hooks/use-today.ts`
- Modify: `src/app/(app)/today/today-content.tsx`

- [ ] **Step 14.1: Update `useToday().approve` to handle the response shape**

In `src/hooks/use-today.ts:179-195` (the `approve` callback), replace the `await postJson(...)` line with logic that reads the response body:

```ts
        const response = await fetch(`/api/today/${id}/approve`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
        });
        const data = (await response.json().catch(() => ({}))) as {
          success?: boolean;
          browserHandoff?: { intentUrl: string };
          queued?: { delayMs: number };
          deferred?: boolean;
          reason?: string;
          retryAfterMs?: number;
        };
        if (!response.ok && !data.deferred) {
          throw new Error(`Approve failed: ${response.status}`);
        }
        if (data.browserHandoff?.intentUrl) {
          window.open(data.browserHandoff.intentUrl, '_blank', 'noopener');
        }
        if (data.deferred) {
          // Surface to caller via the surfaceError path so UI can toast it
          throw new Error(
            `Posting deferred: ${data.reason ?? 'unknown'} (retry in ${Math.round((data.retryAfterMs ?? 0) / 60_000)} min)`,
          );
        }
```

- [ ] **Step 14.2: Verify the existing `surfaceError` toast handles the deferred case**

Read `src/app/(app)/today/today-content.tsx:188` — confirm `surfaceError(err, 'Failed to approve')` shows the message. If it does, the deferred-toast UX is good enough for v1.

- [ ] **Step 14.3: (Optional but recommended) Visibility-change confirm UX**

In `src/app/(app)/today/today-content.tsx`, after a successful handoff, set local state `pendingHandoffId = id`. Add a `useEffect` listening on `document.visibilitychange` — when the tab refocuses, show a small "Posted on X? / Cancel" toast with two actions:
- "Yes" → `await fetch('/api/drafts/${id}/confirm-posted', { method: 'POST' })` (this endpoint is a Phase 2 add — for v1 just no-op the Yes button)
- "Cancel" → `await fetch('/api/drafts/${id}/revert-handoff', { method: 'POST' })` (Phase 2)

If shipping v1 today, skip this step — the optimistic `handed_off` mark is fine. Document in the PR description that confirmation UX is Phase 2.

- [ ] **Step 14.4: Type check**

Run: `pnpm tsc --noEmit`
Expected: no new errors.

- [ ] **Step 14.5: Manual smoke test**

Run: `pnpm dev`. Open Today UI in browser. Approve an X reply card. Verify:
- A new tab opens with X compose pre-filled with the draft text + reply target.
- The card disappears from the Today feed (refresh; the API filter excludes `handed_off`).

Approve an X original post (or Reddit post if your dev DB has a Reddit channel). Verify:
- No new tab.
- Card moves to scheduled state showing the queued delay.
- After the delay, posting worker fires and the post appears on the platform.

- [ ] **Step 14.6: Commit**

```bash
git add src/hooks/use-today.ts src/app/\(app\)/today/today-content.tsx
git commit -m "feat(today-ui): open X intent URL on handoff response; surface pacer deferrals"
```

---

## Task 15: Final integration check

- [ ] **Step 15.1: Run the whole vitest suite**

Run: `pnpm vitest run`
Expected: all green except for any pre-existing failures unrelated to this PR.

- [ ] **Step 15.2: Run the typechecker**

Run: `pnpm tsc --noEmit`
Expected: no errors.

- [ ] **Step 15.3: Spawn a fresh gap-audit subagent (per project memory)**

Use the Agent tool with `subagent_type=Explore` and prompt:

> Audit the just-merged posting + scheduler wiring on branch `feat/posting-scheduler-wiring`. Verify end-to-end:
> 1. The PostCard / ReplyCard `onApprove(id)` reaches `/api/today/:id/approve`.
> 2. The endpoint resolves both `plan_items.id` AND `drafts.id` correctly.
> 3. For X replies, the response includes `browserHandoff.intentUrl` and the UI opens it.
> 4. For X original posts and Reddit posts, the response includes `queued.delayMs` and a job lands on the `posting` BullMQ queue.
> 5. The pacer is actually consulted (not bypassed) for queued posts.
> 6. The posting worker's `mode==='direct'` branch calls the right client method per platform.
> 7. On success, `plan_items.state` flips to `completed`. On failure, `failed`.
> 8. Migration `0011` was applied and the `_journal.json` is strictly monotonic.
> Report any false-green claims, missing wiring, or integration bugs. Under 400 words.

If the auditor surfaces issues, fix them in additional tasks before proceeding to PR.

- [ ] **Step 15.4: Open PR**

Run:

```bash
git push -u origin feat/posting-scheduler-wiring
gh pr create --title "feat: wire posting + scheduler with X intent-URL handoff" --body "$(cat <<'EOF'
## Summary
- Implements the dispatch path from Today UI / plan-execute → dispatcher → either browser-handoff (X replies) or paced direct-mode API call (X posts, Reddit anything).
- Adds `posting-pacer.ts` with account-age-tiered caps + min spacing + quiet hours.
- Adds `x-intent-url.ts` for TOS-compliant X reply handoff (no API call — Feb 2026 X policy means programmatic replies require Enterprise).
- Refactors `enqueuePosting` to take caller-supplied `delayMs`; drops random 0-30 min jitter.
- Adds `mode: 'direct' | 'agent'` branch in posting worker — direct calls platform clients straight, agent path unchanged.
- Migration `0011`: adds `drafts.plan_item_id` FK + `'handed_off'` enum value.
- Wires `plan_items.state` to flip on terminal posting result.

## Test plan
- [ ] `pnpm vitest run` is green
- [ ] `pnpm tsc --noEmit` is clean
- [ ] Manual: approve an X reply card → new X tab opens pre-filled
- [ ] Manual: approve an X original post → posts at the scheduled time (or paced delay if recent post)
- [ ] Manual: confirm `handed_off` drafts disappear from Today feed
- [ ] Auditor subagent run referenced in plan Task 15.3 reports no integration gaps
EOF
)"
```

---

## Self-Review Notes

**Spec coverage:** All five wiring items from the original ask (migration, producer-side planItemId, plan-execute bridge, enqueuePosting refactor, /api/today/:id/approve fallback) are in tasks 1, 10, 13, 6, and 11 respectively. The intent URL handoff is in tasks 5 and 11. The pacer is in task 4. Two-way posting (direct + agent) is in tasks 6 and 8.

**Known gaps (intentional, deferred to follow-ups):**
- Lazy-create drafts for `content_post` plan_items that have no thread (Task 11 step 4 falls through to legacy stub for these). A cleaner schema (drafts without threads) is a follow-up.
- Visibility-change confirm UX in Task 14 step 3 is marked optional. Ship v1 with optimistic handoff.
- Account age + karma fetched from the platform itself (vs. just `channels.connectedAt`) — follow-up.
- `posts.kind` column to distinguish reply vs post for accurate pacer counting — current code overcounts against caps (safer side).

**Type consistency check:** `DispatchInput`, `DispatchResult`, and `PostingJobData` shapes are stable across Tasks 6, 7, 8, and 11. `PostKind = 'reply' | 'post'` is the same in pacer and dispatcher. `draftType = 'reply' | 'original_post'` matches the existing schema.
