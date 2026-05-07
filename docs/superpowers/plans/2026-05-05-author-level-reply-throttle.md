# Author-Level Reply Throttle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop ShipFlare from drafting/posting multiple replies to the same external author within a configurable cooldown window (default 7 days), so we don't look like a reply-guy harassing the same person across threads.

**Architecture:** Mechanical rule, so it lives in the **Tool** primitive (per CLAUDE.md "Primitive Boundaries"), not in agent prose. Three-layer defense:

1. **Upstream xAI prompt** — `find_threads_via_xai` injects an "exclude these authors" list into Grok's first-turn message so the search itself doesn't return throttled handles. Cheapest layer (no tokens spent judging duplicates).
2. **Discovery filter** — `find_threads` (the inbox-reader tool) excludes threads whose author was replied to within the cooldown window. Catches anything xAI returned anyway.
3. **Last-mile guard** — `draft_reply` re-checks the same predicate before insert and short-circuits with `{ skipped: true, reason: 'author_throttled' }`. Catches plan-execute paths that pass an externalId from scout without going through `find_threads` (e.g. resumed sweeps, retried plan items).

A new helper `src/lib/reply-throttle.ts` owns both the predicate (`hasRecentReplyToAuthor`) and the listing (`listRecentEngagedAuthors`) so all three call sites query the same SQL. Window is per-platform (`platform-config.ts → replyAuthorCooldownDays`) so we can tune Reddit and X separately. A new index on `threads(user_id, platform, author)` keeps the JOIN cheap.

**Tech Stack:** TypeScript, Drizzle ORM, PostgreSQL, Vitest, Playwright (real-browser smoke), pnpm.

---

## File Structure

| File | Status | Responsibility |
|---|---|---|
| `src/lib/platform-config.ts` | modify | Add `replyAuthorCooldownDays` field to `PlatformConfig`; populate Reddit/X. |
| `src/lib/reply-throttle.ts` | **create** | Single-source-of-truth predicate `hasRecentReplyToAuthor()` shared by both tools. |
| `src/lib/__tests__/reply-throttle.test.ts` | **create** | Unit tests for predicate (positive, negative, window boundary, status filter). |
| `src/lib/db/schema/channels.ts` | modify | Add `threads_user_platform_author_idx` index. |
| `drizzle/<next>_threads_author_throttle_idx.sql` | **create** | Generated migration for the new index. |
| `src/tools/FindThreadsTool/FindThreadsTool.ts` | modify | Filter out threads whose author tripped the throttle. |
| `src/tools/FindThreadsTool/__tests__/FindThreadsTool.test.ts` | modify | Add throttle-filter test case. |
| `src/tools/FindThreadsViaXaiTool/FindThreadsViaXaiTool.ts` | modify | Inject exclude-authors list into Grok's first-turn message + refinement nudges. |
| `src/tools/FindThreadsViaXaiTool/__tests__/FindThreadsViaXaiTool.test.ts` | modify | Assert prompt includes the exclude list when authors are throttled. |
| `src/tools/DraftReplyTool/DraftReplyTool.ts` | modify | Last-mile guard; return `skipped` shape on hit. |
| `src/tools/DraftReplyTool/__tests__/DraftReplyTool.test.ts` | modify | Add guard test case. |
| `e2e/author-reply-throttle.spec.ts` | **create** | Real-browser smoke against `/today` confirming a 2nd thread from same author yields no new draft. |
| `CLAUDE.md` | modify | Document the throttle in the "Architecture Rules" section. |

---

## Task 1: Add per-platform cooldown config

**Files:**
- Modify: `src/lib/platform-config.ts:51-104` (PlatformConfig interface) and `:106-159` (Reddit, X entries)

- [ ] **Step 1: Read the current PlatformConfig interface**

Already known from prior investigation. The interface ends at line 104 (just before `posting?:` field).

- [ ] **Step 2: Add the field to the interface**

In `src/lib/platform-config.ts`, just above `posting?: PostingConfig;` add:

```ts
  /**
   * Cooldown in days within which we will NOT draft another reply to the
   * same external author (`threads.author`). Backs the throttle in
   * `find_threads` + `draft_reply`. Set to 0 to disable. Default 7.
   */
  replyAuthorCooldownDays?: number;
```

- [ ] **Step 3: Populate Reddit and X**

In the Reddit entry (around line 107-130), add `replyAuthorCooldownDays: 7,` next to the other top-level fields (e.g. just under `replyWindowMinutes: 60,`).

In the X entry (around line 131-158), add `replyAuthorCooldownDays: 7,` similarly.

- [ ] **Step 4: Add a tiny accessor**

At the bottom of `src/lib/platform-config.ts`, append:

```ts
/**
 * Per-platform author-cooldown window in days. Falls back to 7 days when a
 * platform leaves it unset.
 */
export function getReplyAuthorCooldownDays(platform: string): number {
  const config = PLATFORMS[platform];
  return config?.replyAuthorCooldownDays ?? 7;
}
```

- [ ] **Step 5: Type-check**

Run: `pnpm tsc --noEmit --pretty false`
Expected: exit 0 (no errors).

- [ ] **Step 6: Commit**

```bash
git add src/lib/platform-config.ts
git commit -m "feat: add replyAuthorCooldownDays per-platform config"
```

---

## Task 2: Create the reply-throttle helper (TDD)

**Files:**
- Create: `src/lib/reply-throttle.ts`
- Test:   `src/lib/__tests__/reply-throttle.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/lib/__tests__/reply-throttle.test.ts`:

```ts
import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  createInMemoryStore,
  drizzleMockFactory,
  type InMemoryStore,
} from '@/lib/test-utils/in-memory-db';

vi.mock('drizzle-orm', async () => {
  const actual =
    await vi.importActual<typeof import('drizzle-orm')>('drizzle-orm');
  return drizzleMockFactory(actual as unknown as Record<string, unknown>);
});

import { hasRecentReplyToAuthor, listRecentEngagedAuthors } from '../reply-throttle';
import { drafts, threads } from '@/lib/db/schema';

const USER = 'u_test';
const NOW = new Date('2026-05-05T12:00:00Z');

function seed(store: InMemoryStore, threadAuthor: string, draftStatus: string, draftCreatedDaysAgo: number) {
  const threadId = `t_${threadAuthor}_${draftCreatedDaysAgo}`;
  store.tables.set(threads, [
    {
      id: threadId,
      userId: USER,
      externalId: 'ext_' + threadId,
      platform: 'x',
      community: 'topic',
      title: 't',
      url: 'https://x.com/' + threadAuthor,
      body: null,
      author: threadAuthor,
      authorBio: null,
      authorFollowers: null,
      upvotes: null,
      commentCount: null,
      scoutConfidence: null,
      postedAt: null,
      discoveredAt: NOW,
      canMentionProduct: null,
      mentionSignal: null,
    },
  ] as never);
  const created = new Date(NOW.getTime() - draftCreatedDaysAgo * 86_400_000);
  store.tables.set(drafts, [
    {
      id: 'd_' + threadId,
      userId: USER,
      threadId,
      status: draftStatus,
      draftType: 'reply',
      replyBody: 'hi',
      confidenceScore: 0.5,
      whyItWorks: null,
      ftcDisclosure: null,
      reviewVerdict: null,
      reviewScore: null,
      reviewJson: null,
      engagementDepth: 0,
      planItemId: null,
      media: [],
      postTitle: null,
      createdAt: created,
      updatedAt: created,
    },
  ] as never);
}

describe('hasRecentReplyToAuthor', () => {
  let store: InMemoryStore;

  beforeEach(() => {
    store = createInMemoryStore();
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  it('returns false when no draft exists for the author', async () => {
    const got = await hasRecentReplyToAuthor(store.db, {
      userId: USER,
      platform: 'x',
      author: 'alice',
      withinDays: 7,
    });
    expect(got).toBe(false);
  });

  it('returns true when a posted draft exists within the window', async () => {
    seed(store, 'alice', 'posted', 2);
    const got = await hasRecentReplyToAuthor(store.db, {
      userId: USER,
      platform: 'x',
      author: 'alice',
      withinDays: 7,
    });
    expect(got).toBe(true);
  });

  it('returns true when only a pending draft exists within the window', async () => {
    seed(store, 'alice', 'pending', 1);
    const got = await hasRecentReplyToAuthor(store.db, {
      userId: USER,
      platform: 'x',
      author: 'alice',
      withinDays: 7,
    });
    expect(got).toBe(true);
  });

  it('returns false when the only draft is older than the window', async () => {
    seed(store, 'alice', 'posted', 30);
    const got = await hasRecentReplyToAuthor(store.db, {
      userId: USER,
      platform: 'x',
      author: 'alice',
      withinDays: 7,
    });
    expect(got).toBe(false);
  });

  it('returns false when the only draft is in a non-blocking status (skipped, failed, flagged)', async () => {
    seed(store, 'alice', 'skipped', 1);
    const got = await hasRecentReplyToAuthor(store.db, {
      userId: USER,
      platform: 'x',
      author: 'alice',
      withinDays: 7,
    });
    expect(got).toBe(false);
  });

  it('scopes by userId — does not leak across founders', async () => {
    seed(store, 'alice', 'posted', 1);
    const got = await hasRecentReplyToAuthor(store.db, {
      userId: 'other_user',
      platform: 'x',
      author: 'alice',
      withinDays: 7,
    });
    expect(got).toBe(false);
  });

  it('scopes by platform — reddit drafts do not block X candidates', async () => {
    seed(store, 'alice', 'posted', 1);
    const got = await hasRecentReplyToAuthor(store.db, {
      userId: USER,
      platform: 'reddit',
      author: 'alice',
      withinDays: 7,
    });
    expect(got).toBe(false);
  });

  it('returns false when author is null', async () => {
    const got = await hasRecentReplyToAuthor(store.db, {
      userId: USER,
      platform: 'x',
      author: null,
      withinDays: 7,
    });
    expect(got).toBe(false);
  });
});

describe('listRecentEngagedAuthors', () => {
  let store: InMemoryStore;

  beforeEach(() => {
    store = createInMemoryStore();
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  it('returns distinct authors engaged within the window, ordered by recency', async () => {
    seed(store, 'alice', 'posted', 1);
    // re-seed appends; helper above replaces. For multi-row tests inline:
    const recent = new Date(NOW.getTime() - 1 * 86_400_000);
    const middle = new Date(NOW.getTime() - 3 * 86_400_000);
    store.tables.set(threads, [
      { id: 't1', userId: USER, externalId: 'e1', platform: 'x', author: 'alice', community: '', title: '', url: '', body: null, authorBio: null, authorFollowers: null, upvotes: null, commentCount: null, scoutConfidence: null, postedAt: null, discoveredAt: NOW, canMentionProduct: null, mentionSignal: null },
      { id: 't2', userId: USER, externalId: 'e2', platform: 'x', author: 'bob',   community: '', title: '', url: '', body: null, authorBio: null, authorFollowers: null, upvotes: null, commentCount: null, scoutConfidence: null, postedAt: null, discoveredAt: NOW, canMentionProduct: null, mentionSignal: null },
      { id: 't3', userId: USER, externalId: 'e3', platform: 'x', author: 'alice', community: '', title: '', url: '', body: null, authorBio: null, authorFollowers: null, upvotes: null, commentCount: null, scoutConfidence: null, postedAt: null, discoveredAt: NOW, canMentionProduct: null, mentionSignal: null },
    ] as never);
    store.tables.set(drafts, [
      { id: 'd1', userId: USER, threadId: 't1', status: 'posted', draftType: 'reply', replyBody: 'a', confidenceScore: 0.5, whyItWorks: null, ftcDisclosure: null, reviewVerdict: null, reviewScore: null, reviewJson: null, engagementDepth: 0, planItemId: null, media: [], postTitle: null, createdAt: middle, updatedAt: middle },
      { id: 'd2', userId: USER, threadId: 't2', status: 'pending', draftType: 'reply', replyBody: 'b', confidenceScore: 0.5, whyItWorks: null, ftcDisclosure: null, reviewVerdict: null, reviewScore: null, reviewJson: null, engagementDepth: 0, planItemId: null, media: [], postTitle: null, createdAt: recent, updatedAt: recent },
      { id: 'd3', userId: USER, threadId: 't3', status: 'posted', draftType: 'reply', replyBody: 'c', confidenceScore: 0.5, whyItWorks: null, ftcDisclosure: null, reviewVerdict: null, reviewScore: null, reviewJson: null, engagementDepth: 0, planItemId: null, media: [], postTitle: null, createdAt: recent, updatedAt: recent },
    ] as never);

    const got = await listRecentEngagedAuthors(store.db, {
      userId: USER,
      platform: 'x',
      withinDays: 7,
      limit: 50,
    });
    // Distinct: alice + bob (alice de-duped across t1 and t3).
    expect(new Set(got)).toEqual(new Set(['alice', 'bob']));
  });

  it('respects the limit argument', async () => {
    // Seed five distinct authors.
    const tRows = ['a','b','c','d','e'].map((name, i) => ({
      id: `t${i}`, userId: USER, externalId: `e${i}`, platform: 'x', author: name,
      community: '', title: '', url: '', body: null, authorBio: null, authorFollowers: null,
      upvotes: null, commentCount: null, scoutConfidence: null, postedAt: null,
      discoveredAt: NOW, canMentionProduct: null, mentionSignal: null,
    }));
    const dRows = tRows.map((t, i) => ({
      id: `d${i}`, userId: USER, threadId: t.id, status: 'posted', draftType: 'reply',
      replyBody: 'x', confidenceScore: 0.5, whyItWorks: null, ftcDisclosure: null,
      reviewVerdict: null, reviewScore: null, reviewJson: null, engagementDepth: 0,
      planItemId: null, media: [], postTitle: null, createdAt: NOW, updatedAt: NOW,
    }));
    store.tables.set(threads, tRows as never);
    store.tables.set(drafts, dRows as never);

    const got = await listRecentEngagedAuthors(store.db, {
      userId: USER, platform: 'x', withinDays: 7, limit: 2,
    });
    expect(got.length).toBe(2);
  });

  it('returns [] when withinDays is 0', async () => {
    const got = await listRecentEngagedAuthors(store.db, {
      userId: USER, platform: 'x', withinDays: 0, limit: 50,
    });
    expect(got).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the test — expect import-resolution failure**

Run: `pnpm vitest run src/lib/__tests__/reply-throttle.test.ts`
Expected: FAIL — `Cannot find module '../reply-throttle'`.

- [ ] **Step 3: Create the helper**

Create `src/lib/reply-throttle.ts`:

```ts
/**
 * Author-level reply throttle predicate.
 *
 * Single source of truth used by `find_threads` (discovery filter) and
 * `draft_reply` (last-mile guard) so both code paths apply the same rule.
 *
 * Rule: returns true when there exists a draft (status pending / approved /
 * posted / handed_off) for `userId` on `platform` against a thread whose
 * `author` matches, created within `withinDays`. Drafts in terminal
 * non-engaging states (skipped / failed / flagged / needs_revision) do
 * NOT count — those represent rejection signals, not engagement, so the
 * author hasn't been bothered.
 */
import { and, eq, gte, inArray, sql } from 'drizzle-orm';
import { drafts, threads } from '@/lib/db/schema';
import type { db as Db } from '@/lib/db';

export type ThrottleAwareDb = typeof Db;

export interface HasRecentReplyToAuthorInput {
  userId: string;
  platform: string;
  author: string | null;
  withinDays: number;
}

const BLOCKING_STATUSES = [
  'pending',
  'approved',
  'posted',
  'handed_off',
] as const;

export async function hasRecentReplyToAuthor(
  db: ThrottleAwareDb,
  input: HasRecentReplyToAuthorInput,
): Promise<boolean> {
  if (!input.author) return false;
  if (input.withinDays <= 0) return false;

  const cutoff = new Date(Date.now() - input.withinDays * 86_400_000);

  const rows = await db
    .select({ one: sql<number>`1` })
    .from(drafts)
    .innerJoin(threads, eq(drafts.threadId, threads.id))
    .where(
      and(
        eq(drafts.userId, input.userId),
        eq(threads.platform, input.platform),
        eq(threads.author, input.author),
        gte(drafts.createdAt, cutoff),
        inArray(drafts.status, BLOCKING_STATUSES as unknown as string[]),
      ),
    )
    .limit(1);

  return rows.length > 0;
}

/**
 * Listing variant — returns DISTINCT authors `userId` has engaged with on
 * `platform` in the last `withinDays`. Used by `find_threads_via_xai` to
 * tell Grok "don't surface tweets from these handles" upstream of the
 * search, so we don't waste search-API tokens on candidates we'll throw
 * away later in `judging-thread-quality` / the throttle.
 *
 * Capped at `limit` most-recent authors so the prompt stays bounded;
 * callers should tell xAI "and skip authors that look like our prior
 * reply targets" as a fallback for the long tail.
 */
export interface ListRecentEngagedAuthorsInput {
  userId: string;
  platform: string;
  withinDays: number;
  limit: number;
}

export async function listRecentEngagedAuthors(
  db: ThrottleAwareDb,
  input: ListRecentEngagedAuthorsInput,
): Promise<string[]> {
  if (input.withinDays <= 0 || input.limit <= 0) return [];

  const cutoff = new Date(Date.now() - input.withinDays * 86_400_000);

  const rows = await db
    .selectDistinct({ author: threads.author })
    .from(drafts)
    .innerJoin(threads, eq(drafts.threadId, threads.id))
    .where(
      and(
        eq(drafts.userId, input.userId),
        eq(threads.platform, input.platform),
        gte(drafts.createdAt, cutoff),
        inArray(drafts.status, BLOCKING_STATUSES as unknown as string[]),
      ),
    )
    .limit(input.limit);

  return rows
    .map((r) => r.author)
    .filter((a): a is string => typeof a === 'string' && a.length > 0);
}
```

If `selectDistinct` isn't available on the in-memory mock, fall back to `select`+`Set` dedup in JS. The intent — distinct authors only — is what matters; the SQL form is an optimization.

- [ ] **Step 4: Run the test — expect pass**

Run: `pnpm vitest run src/lib/__tests__/reply-throttle.test.ts`
Expected: PASS, all 8 cases.

If the in-memory mock doesn't support `innerJoin`, fall back to two queries: `SELECT id FROM threads WHERE userId AND platform AND author`, then `SELECT 1 FROM drafts WHERE userId AND threadId IN (...) AND status IN (...) AND createdAt >= cutoff`. Update the helper and re-run.

- [ ] **Step 5: Type-check**

Run: `pnpm tsc --noEmit --pretty false`
Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
git add src/lib/reply-throttle.ts src/lib/__tests__/reply-throttle.test.ts
git commit -m "feat: add hasRecentReplyToAuthor throttle predicate"
```

---

## Task 3: Add DB index for `threads(user_id, platform, author)`

**Files:**
- Modify: `src/lib/db/schema/channels.ts:107-112`
- Create: `drizzle/<next>_threads_author_throttle_idx.sql` (generated)

- [ ] **Step 1: Add the index to schema**

In `src/lib/db/schema/channels.ts`, the `threads` table already has an indexes-array as the second arg of `pgTable`. Inside that array (right after the existing `threads_user_discovered_idx` line ~107), add:

```ts
    index('threads_user_platform_author_idx').on(
      t.userId,
      t.platform,
      t.author,
    ),
```

Make sure `index` is imported at the top of the file (it should be already; if not, add to the existing `from 'drizzle-orm/pg-core'` import).

- [ ] **Step 2: Generate the migration**

Run: `pnpm db:generate`
Expected: a new file at `drizzle/00NN_*.sql` with `CREATE INDEX` for `threads_user_platform_author_idx`. Also a new entry in `drizzle/meta/_journal.json`.

- [ ] **Step 3: Inspect the generated SQL**

Run: `cat drizzle/00NN_*.sql` (most recent file).
Expected: contains `CREATE INDEX "threads_user_platform_author_idx" ON "threads" USING btree ("user_id","platform","author");`

If drizzle-kit emitted anything besides that single `CREATE INDEX`, edit the file down to just that statement — we don't want collateral DDL.

- [ ] **Step 4: Type-check**

Run: `pnpm tsc --noEmit --pretty false`
Expected: exit 0.

- [ ] **Step 5: Apply locally**

Run: `pnpm db:push`
Expected: confirms the new index. If it asks about destructive changes, **abort and re-inspect** — only the new index should appear in the diff.

- [ ] **Step 6: Commit**

```bash
git add src/lib/db/schema/channels.ts drizzle/
git commit -m "feat: index threads(user_id, platform, author) for reply throttle"
```

---

## Task 4: Wire throttle into `find_threads` (TDD)

**Files:**
- Modify: `src/tools/FindThreadsTool/FindThreadsTool.ts`
- Modify: `src/tools/FindThreadsTool/__tests__/FindThreadsTool.test.ts`

- [ ] **Step 1: Write the failing test**

Open `src/tools/FindThreadsTool/__tests__/FindThreadsTool.test.ts`. At the bottom of the outer `describe`, add:

```ts
  it('excludes threads whose author was replied to within the cooldown window', async () => {
    const NOW = new Date('2026-05-05T12:00:00Z');
    vi.useFakeTimers();
    vi.setSystemTime(NOW);

    const recent = new Date(NOW.getTime() - 2 * 86_400_000);
    const old = new Date(NOW.getTime() - 30 * 86_400_000);

    // Two threads from author 'alice', one fresh, one stale wrt the
    // cooldown anchor; one thread from author 'bob'.
    const threadRows = [
      makeThread({ id: 't_alice_recent', author: 'alice', discoveredAt: NOW, externalId: 'ext1', scoutConfidence: 0.9 }),
      makeThread({ id: 't_alice_other',  author: 'alice', discoveredAt: NOW, externalId: 'ext2', scoutConfidence: 0.9 }),
      makeThread({ id: 't_bob',          author: 'bob',   discoveredAt: NOW, externalId: 'ext3', scoutConfidence: 0.9 }),
    ];
    store.tables.set(threads, threadRows as never);

    // We already replied to alice 2 days ago via t_alice_recent.
    store.tables.set(drafts, [
      makeDraft({ id: 'd_alice', threadId: 't_alice_recent', status: 'posted', createdAt: recent }),
      makeDraft({ id: 'd_alice_old', threadId: 't_alice_other', status: 'posted', createdAt: old }),
    ] as never);

    const ctx = makeCtx(store, { userId: USER });
    const out = await findThreadsTool.execute({ platforms: ['x'] }, ctx);

    const ids = out.threads.map((t) => t.threadId).sort();
    // alice is throttled — both her threads are excluded even though
    // one only had a 30-day-old draft, because the recent one wins.
    expect(ids).toEqual(['t_bob']);
  });
```

You will also need helpers `makeThread` and `makeDraft` at the top of the test file if they don't already exist; mirror the shape used in the existing test cases. Pull the `drafts` schema import from `@/lib/db/schema`.

- [ ] **Step 2: Run the test — expect failure**

Run: `pnpm vitest run src/tools/FindThreadsTool/__tests__/FindThreadsTool.test.ts`
Expected: FAIL — `expected ['t_alice_other', 't_alice_recent', 't_bob'] to equal ['t_bob']`.

- [ ] **Step 3: Implement the filter**

In `src/tools/FindThreadsTool/FindThreadsTool.ts`:

a) At the top, add imports:

```ts
import { hasRecentReplyToAuthor } from '@/lib/reply-throttle';
import { getReplyAuthorCooldownDays } from '@/lib/platform-config';
```

b) Inside `execute`, after the `kept` array is computed (around line 131, just before the `out` mapping), add a pass that drops throttled authors. Replace the `kept`-to-`out` block with:

```ts
      const candidates = rows
        .filter((r) => (r.scoutConfidence ?? 0) >= minRelevance)
        .slice(0, limit * 2);

      // Throttle: per (userId, platform, author) within platform's
      // cooldown window. We dedup distinct authors to keep this O(1)
      // queries per author rather than O(threads).
      const seenAuthor = new Map<string, boolean>();
      const kept: typeof candidates = [];
      for (const c of candidates) {
        const author = c.author;
        const key = `${c.platform}:${author ?? '__null__'}`;
        let throttled = seenAuthor.get(key);
        if (throttled === undefined) {
          throttled = await hasRecentReplyToAuthor(db, {
            userId,
            platform: c.platform,
            author,
            withinDays: getReplyAuthorCooldownDays(c.platform),
          });
          seenAuthor.set(key, throttled);
        }
        if (!throttled) kept.push(c);
        if (kept.length >= limit) break;
      }

      const out: ThreadRow[] = kept.map((r) => ({
```

c) Drop the now-redundant `kept` derivation that used `.slice(0, limit)` further down.

- [ ] **Step 4: Run the test — expect pass**

Run: `pnpm vitest run src/tools/FindThreadsTool/__tests__/FindThreadsTool.test.ts`
Expected: PASS, all cases (existing + new).

- [ ] **Step 5: Type-check**

Run: `pnpm tsc --noEmit --pretty false`
Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
git add src/tools/FindThreadsTool/
git commit -m "feat(find_threads): exclude authors within reply-cooldown window"
```

---

## Task 5: Tell xAI search to skip already-engaged authors (TDD)

**Files:**
- Modify: `src/tools/FindThreadsViaXaiTool/FindThreadsViaXaiTool.ts:158-202` (`buildFirstTurnMessage`) and around `:316-378` (where the message list is built)
- Modify: `src/tools/FindThreadsViaXaiTool/__tests__/FindThreadsViaXaiTool.test.ts`

The `find_threads` tool only filters the inbox — but candidates are first surfaced by `find_threads_via_xai`, which sends a search prompt to Grok. Spending xAI tokens on candidates we'll throw away is wasteful AND can soak up the daily judging budget. Inject the exclude list into the prompt so Grok narrows its search itself.

- [ ] **Step 1: Read the current `buildFirstTurnMessage` signature**

The function is at `src/tools/FindThreadsViaXaiTool/FindThreadsViaXaiTool.ts:158-202`. Current signature:

```ts
function buildFirstTurnMessage(
  product: ProductForLoop,
  rubric: string,
  intent: string | undefined,
  maxResults: number,
): string
```

- [ ] **Step 2: Write the failing test**

In `src/tools/FindThreadsViaXaiTool/__tests__/FindThreadsViaXaiTool.test.ts`, find the existing `describe('buildFirstTurnMessage', ...)` block (or add one if absent). Add:

```ts
import { buildFirstTurnMessage } from '../FindThreadsViaXaiTool';

const baseProduct = {
  id: 'p1',
  name: 'TestProduct',
  description: 'd',
  valueProp: null,
  targetAudience: null,
  keywords: [],
};

describe('buildFirstTurnMessage exclude-authors', () => {
  it('omits the exclude block when no authors are throttled', () => {
    const msg = buildFirstTurnMessage(baseProduct, '', undefined, 10, []);
    expect(msg).not.toMatch(/Do NOT surface tweets/i);
  });

  it('includes a Do-NOT line listing throttled authors', () => {
    const msg = buildFirstTurnMessage(baseProduct, '', undefined, 10, [
      'alice',
      'bob_dev',
      'charlie123',
    ]);
    expect(msg).toMatch(/Do NOT surface tweets authored by/i);
    expect(msg).toContain('@alice');
    expect(msg).toContain('@bob_dev');
    expect(msg).toContain('@charlie123');
  });

  it('truncates long lists with an "and others" tail to keep the prompt bounded', () => {
    const many = Array.from({ length: 75 }, (_, i) => `user${i}`);
    const msg = buildFirstTurnMessage(baseProduct, '', undefined, 10, many);
    // We list at most 50 explicitly + a tail-handling sentence.
    const matches = msg.match(/@user\d+/g) ?? [];
    expect(matches.length).toBeLessThanOrEqual(50);
    expect(msg).toMatch(/and others.*skip authors that look like/i);
  });
});
```

- [ ] **Step 3: Run the test — expect failure**

Run: `pnpm vitest run src/tools/FindThreadsViaXaiTool/__tests__/FindThreadsViaXaiTool.test.ts`
Expected: FAIL — `buildFirstTurnMessage` rejects the 5th argument or doesn't render the line.

- [ ] **Step 4: Update `buildFirstTurnMessage`**

Change the signature to accept `excludeAuthors: readonly string[]`:

```ts
function buildFirstTurnMessage(
  product: ProductForLoop,
  rubric: string,
  intent: string | undefined,
  maxResults: number,
  excludeAuthors: readonly string[],
): string {
  // ... existing keywords / intentLine / rubricSection wiring ...

  const PROMPT_AUTHOR_LIMIT = 50;
  const trimmed = excludeAuthors.slice(0, PROMPT_AUTHOR_LIMIT);
  const tail =
    excludeAuthors.length > PROMPT_AUTHOR_LIMIT
      ? ' and others — when in doubt, skip authors that look like our prior reply targets'
      : '';
  const excludeLine =
    trimmed.length > 0
      ? `- Do NOT surface tweets authored by: ${trimmed.map((h) => '@' + h).join(', ')}${tail}. We have already engaged with them recently and another reply would feel like reply-guy harassment.`
      : '';

  return [
    "I'm looking for X/Twitter posts where potential customers of my product",
    'are publicly expressing problems the product solves.',
    '',
    'PRODUCT',
    `- Name: ${product.name}`,
    `- Description: ${product.description}`,
    `- Value prop: ${product.valueProp ?? '(not specified)'}`,
    `- Target audience: ${product.targetAudience ?? '(not specified)'}`,
    `- Keywords: ${keywords}`,
    intentLine + rubricSection,
    'Constraints',
    '- Posted in last 7 days',
    `- Up to ${maxResults * 2} candidates this pass — quality over quota`,
    excludeLine,
    // ... rest of existing constraint lines unchanged ...
  ]
    .filter(Boolean) // collapse the empty excludeLine when there are no authors
    .join('\n');
}
```

Make sure the `.filter(Boolean)` is added — without it the empty `excludeLine` becomes a stray newline.

- [ ] **Step 5: Wire `listRecentEngagedAuthors` into `execute`**

At the top of the file, add imports:

```ts
import { listRecentEngagedAuthors } from '@/lib/reply-throttle';
import { getReplyAuthorCooldownDays } from '@/lib/platform-config';
```

In the `execute` body, after `rubric` is loaded (around line 356) and before the `messages` array is initialized (line 368), add:

```ts
    const excludeAuthors = await listRecentEngagedAuthors(db, {
      userId,
      platform: 'x',
      withinDays: getReplyAuthorCooldownDays('x'),
      limit: 80, // a bit higher than the prompt cap so the helper can paginate later
    });
```

Then update the message-list initializer to pass it:

```ts
    const messages: XaiMessage[] = [
      {
        role: 'user',
        content: buildFirstTurnMessage(
          product,
          rubric,
          input.intent,
          maxResults,
          excludeAuthors,
        ),
      },
    ];
```

- [ ] **Step 6: Refinement-message reinforcement**

The xAI loop also sends refinement messages (see `composeRefinementMessage` at `:209-230`). If Grok forgets the exclusion across rounds (it can), reinforce it. Edit `composeRefinementMessage` to accept the same `excludeAuthors` and append `Still skip @x, @y, @z.` when the list is non-empty. Test:

```ts
it('refinement message reminds xAI of exclude list when authors are present', () => {
  const m = composeRefinementMessage(new Map(), [], ['alice', 'bob']);
  expect(m).toMatch(/skip @alice, @bob/i);
});
```

Implementation: append signature param and a one-line `Still skip @a, @b, @c.` (cap at 10 to keep the refinement message tight).

- [ ] **Step 7: Run all tests — expect pass**

Run: `pnpm vitest run src/tools/FindThreadsViaXaiTool/`
Expected: PASS for all cases (existing + new).

- [ ] **Step 8: Type-check**

Run: `pnpm tsc --noEmit --pretty false`
Expected: exit 0.

- [ ] **Step 9: Commit**

```bash
git add src/tools/FindThreadsViaXaiTool/
git commit -m "feat(find_threads_via_xai): tell Grok to skip already-engaged authors"
```

---

## Task 6: Last-mile guard in `draft_reply` (TDD)

**Files:**
- Modify: `src/tools/DraftReplyTool/DraftReplyTool.ts`
- Modify: `src/tools/DraftReplyTool/__tests__/DraftReplyTool.test.ts`

The discovery filter handles the happy path, but plan-execute can hand a `threadId`/`externalId` directly to `draft_reply` (e.g. when resuming a stale plan item). This guard catches that.

- [ ] **Step 1: Update the result type**

In `src/tools/DraftReplyTool/DraftReplyTool.ts`, change `DraftReplyResult` (line 52-56) to:

```ts
export type DraftReplyResult =
  | {
      draftId: string;
      threadId: string;
      platform: string;
      skipped?: false;
    }
  | {
      skipped: true;
      reason: 'author_throttled';
      threadId: string;
      platform: string;
      author: string | null;
    };
```

The change requires updating both the tool's `ToolDefinition<DraftReplyInput, DraftReplyResult>` line and any caller that destructures `.draftId` without checking `skipped`. Grep for callers:

Run: `grep -rn "draftReplyTool\|DRAFT_REPLY_TOOL_NAME\|draft_reply" src --include="*.ts" | grep -v __tests__ | grep -v "DraftReplyTool/"`

For each caller, add an early-return on the `skipped` shape (just log and continue; no draft was created).

- [ ] **Step 2: Write the failing test**

In `src/tools/DraftReplyTool/__tests__/DraftReplyTool.test.ts`, add:

```ts
  it('skips with author_throttled when a recent reply to the same author exists', async () => {
    const NOW = new Date('2026-05-05T12:00:00Z');
    vi.useFakeTimers();
    vi.setSystemTime(NOW);

    // Existing thread + posted draft for author 'alice' 2 days ago.
    store.tables.set(threads, [
      makeThread({ id: 't_old', author: 'alice', platform: 'x', externalId: 'ext_old' }),
      makeThread({ id: 't_new', author: 'alice', platform: 'x', externalId: 'ext_new' }),
    ] as never);
    store.tables.set(drafts, [
      makeDraft({
        id: 'd_old',
        threadId: 't_old',
        status: 'posted',
        createdAt: new Date(NOW.getTime() - 2 * 86_400_000),
      }),
    ] as never);

    const ctx = makeCtx(store, { userId: USER });
    const out = await draftReplyTool.execute(
      { threadId: 't_new', draftBody: 'hello again', confidence: 0.7 },
      ctx,
    );

    expect(out).toMatchObject({
      skipped: true,
      reason: 'author_throttled',
      threadId: 't_new',
      platform: 'x',
      author: 'alice',
    });
    // No new draft was inserted.
    const draftsAfter = store.tables.get(drafts) as Array<{ threadId: string }>;
    expect(draftsAfter.find((d) => d.threadId === 't_new')).toBeUndefined();
  });
```

- [ ] **Step 3: Run the test — expect failure**

Run: `pnpm vitest run src/tools/DraftReplyTool/__tests__/DraftReplyTool.test.ts`
Expected: FAIL — current tool always creates a draft.

- [ ] **Step 4: Implement the guard**

In `src/tools/DraftReplyTool/DraftReplyTool.ts`, after the thread-ownership lookup (line ~104, where `thread` is resolved) and **before** the existing-pending check (line ~120), insert:

```ts
      // Last-mile author throttle. If discovery handed us a thread for
      // an author we already engaged with, refuse to create a second
      // draft. Discovery (`find_threads`) already applies this filter;
      // this guard catches plan-execute / resumed-sweep paths that pass
      // a threadId without going through discovery.
      const fullThread = await db
        .select({ author: threads.author })
        .from(threads)
        .where(eq(threads.id, thread.id))
        .limit(1);
      const author = fullThread[0]?.author ?? null;
      const cooldown = getReplyAuthorCooldownDays(thread.platform);
      const throttled = await hasRecentReplyToAuthor(db, {
        userId,
        platform: thread.platform,
        author,
        withinDays: cooldown,
      });
      if (throttled) {
        return {
          skipped: true,
          reason: 'author_throttled',
          threadId: thread.id,
          platform: thread.platform,
          author,
        };
      }
```

Add the imports at the top of the file:

```ts
import { hasRecentReplyToAuthor } from '@/lib/reply-throttle';
import { getReplyAuthorCooldownDays } from '@/lib/platform-config';
```

- [ ] **Step 5: Update the original-thread author selection**

The thread-ownership lookup at line 87-104 already selects `userId, platform`. Extend that select to include `author` and remove the second query in step 4. Final form:

```ts
      const threadRows = await db
        .select({
          id: threads.id,
          userId: threads.userId,
          platform: threads.platform,
          author: threads.author,
        })
        .from(threads)
        ...
      const thread = threadRows[0];
      ...
      const author = thread.author;
```

- [ ] **Step 6: Run the test — expect pass**

Run: `pnpm vitest run src/tools/DraftReplyTool/__tests__/DraftReplyTool.test.ts`
Expected: PASS, including the existing happy-path and idempotency cases.

- [ ] **Step 7: Type-check**

Run: `pnpm tsc --noEmit --pretty false`
Expected: exit 0. If any caller of `draftReplyTool.execute` was missed in Step 1, it will surface here as `Property 'draftId' does not exist on type ...`. Fix each by narrowing on `if (result.skipped) { ... continue; }` before reading `draftId`.

- [ ] **Step 8: Commit**

```bash
git add src/tools/DraftReplyTool/
git commit -m "feat(draft_reply): last-mile author-throttle guard"
```

---

## Task 7: Surface throttle skips in pipeline-events

**Files:**
- Modify: any caller of `draftReplyTool.execute` that the Step-1 grep flagged (typically `src/workers/processors/plan-execute.ts` or a content-manager bundled skill)
- Modify: `src/lib/db/schema/pipeline-events.ts` — confirm an existing `event_type` value covers this; otherwise reuse `'draft_skipped'` or similar.

- [ ] **Step 1: Locate the existing skip event taxonomy**

Run: `grep -rn "pipelineEvents\|insert.*pipeline" src --include="*.ts" | head -10`
Run: `grep -rn "eventType: '\|event_type: '" src --include="*.ts" | head -20`

Pick the existing event vocabulary the codebase uses for "we considered this draft and chose not to act"; the spec assumes `'draft_skipped_throttled'` but conform to whatever is already in use.

- [ ] **Step 2: Emit the event from each caller**

In each caller of `draftReplyTool.execute`, on the `skipped` branch, insert a row into `pipeline_events` (or call the existing helper) with metadata `{ reason: 'author_throttled', threadId, platform, author }`. Example shape (adapt to the actual helper):

```ts
const result = await draftReplyTool.execute(input, ctx);
if (result.skipped) {
  await emitPipelineEvent(ctx, {
    eventType: 'draft_skipped_throttled',
    threadId: result.threadId,
    metadata: { reason: result.reason, author: result.author },
  });
  continue;
}
const { draftId } = result;
```

- [ ] **Step 3: Type-check**

Run: `pnpm tsc --noEmit --pretty false`
Expected: exit 0.

- [ ] **Step 4: Run the affected worker tests**

Run: `pnpm vitest run src/workers/processors/`
Expected: all pass. If a test asserts "draft was created" on a fixture that now trips the throttle, fix the fixture (different author per thread) — the new behavior is correct.

- [ ] **Step 5: Commit**

```bash
git add src/workers/ src/skills/ # adjust based on actual touch list
git commit -m "feat: emit pipeline event when draft is throttled"
```

---

## Task 8: Document the throttle in CLAUDE.md

**Files:**
- Modify: `CLAUDE.md` — under the `## Architecture Rules` section.

- [ ] **Step 1: Add a subsection**

Append after the "New Platform Checklist" subsection (find via `grep -n "New Platform Checklist" CLAUDE.md`):

````markdown
### Author-Level Reply Throttle

ShipFlare does not draft a second reply to the same external author
within `replyAuthorCooldownDays` (default 7d, set per-platform in
`src/lib/platform-config.ts`). Three layers enforce this; all call
helpers in `src/lib/reply-throttle.ts`:

1. **`find_threads_via_xai`** injects an exclude-authors list into
   Grok's first-turn search prompt and refinement messages, so xAI
   doesn't even surface tweets from authors we've engaged with. Uses
   `listRecentEngagedAuthors()`.
2. **`find_threads`** filters the inbox at discovery time so the agent
   never sees throttled authors. Uses `hasRecentReplyToAuthor()`.
3. **`draft_reply`** re-checks before INSERT and returns
   `{ skipped: true, reason: 'author_throttled', ... }` instead of
   creating a row. Catches plan-execute / resumed-sweep paths. Uses
   `hasRecentReplyToAuthor()`.

Statuses that count as "we engaged": `pending | approved | posted |
handed_off`. Statuses that don't (no contact made): `skipped | failed |
flagged | needs_revision`.

When adding a new platform, set `replyAuthorCooldownDays` in its
`PLATFORMS[id]` entry (omit to inherit the 7-day default). To extend
the rule (e.g. include reactions/likes, not just replies), update
`src/lib/reply-throttle.ts` — that file is the single source of truth.
````

- [ ] **Step 2: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: document author-level reply throttle"
```

---

## Task 9: Real-browser Playwright smoke test

**Files:**
- Create: `e2e/author-reply-throttle.spec.ts`

Per repo convention (every plan ships a real-browser smoke). Targets a local dev server with an authenticated session; relies on existing browser context the founder already has.

- [ ] **Step 1: Confirm e2e config**

Run: `ls e2e/ playwright.config.* 2>/dev/null`
Expected: an `e2e/` folder and a `playwright.config.ts`. If not present, fall back to `tests/e2e/` or wherever the repo keeps Playwright specs (check the existing `feedback_playwright_real_browser_in_plans.md` memory for the exact convention) and adjust paths.

- [ ] **Step 2: Write the spec**

Create `e2e/author-reply-throttle.spec.ts`:

```ts
import { test, expect } from '@playwright/test';

/**
 * Smoke: when discovery surfaces multiple threads from the same author
 * and we have a recent posted reply to that author, the second thread
 * does not yield a new draft card in /today.
 *
 * Setup expectation: dev DB is seeded by `pnpm seed:e2e` with one
 * already-posted reply to author '@alice_test' and two pending-discovered
 * threads from the same author. The throttle should leave at most one
 * draft card visible.
 */
test('author throttle hides second thread from same author', async ({ page }) => {
  await page.goto('http://localhost:3000/today');

  // Wait for the today feed to render.
  await expect(page.getByTestId('today-tab')).toBeVisible({ timeout: 15_000 });

  // Count draft cards whose author is the throttled handle.
  const aliceCards = page.getByTestId('post-card').filter({
    hasText: '@alice_test',
  });
  const count = await aliceCards.count();

  // Two threads were discovered, one was already replied to. With the
  // throttle in place, at most ONE card may be present (the existing
  // posted one); no new draft should have been created.
  expect(count).toBeLessThanOrEqual(1);

  // Also verify that the pipeline-events tab shows the skip reason for
  // the second thread (catches the case where count is 0 because both
  // were filtered, vs the case where the second was throttled).
  await page.getByRole('link', { name: /events|activity/i }).click();
  await expect(page.getByText(/author_throttled/i)).toBeVisible();
});
```

- [ ] **Step 3: Add a seed helper if not present**

Run: `ls scripts/ | grep -i seed`
If a `seed:e2e` script doesn't exist, create `scripts/seed-throttle-e2e.ts` that inserts:

- one user (or reuses the founder's row from `.env.test`)
- one thread `t_alice_old` author `alice_test` discovered 3 days ago
- one posted draft + post for `t_alice_old` postedAt 2 days ago
- one thread `t_alice_new` author `alice_test` discovered 1 hour ago

Wire it into `package.json` as `"seed:e2e": "tsx scripts/seed-throttle-e2e.ts"`.

- [ ] **Step 4: Run the spec headed against local dev**

Run in two terminals:

Terminal A: `pnpm dev`
Terminal B: `pnpm seed:e2e && pnpm playwright test e2e/author-reply-throttle.spec.ts --headed`

Expected: spec passes; you can visually confirm only the old `@alice_test` card is on screen.

- [ ] **Step 5: Commit**

```bash
git add e2e/author-reply-throttle.spec.ts scripts/seed-throttle-e2e.ts package.json
git commit -m "test(e2e): real-browser smoke for author reply throttle"
```

---

## Task 10: Final verification + PR

- [ ] **Step 1: Full type-check**

Run: `pnpm tsc --noEmit --pretty false`
Expected: exit 0.

- [ ] **Step 2: Full unit-test suite**

Run: `pnpm vitest run`
Expected: all pass.

- [ ] **Step 3: Lint**

Run: `pnpm lint` (or whatever the repo uses; check `package.json` scripts).
Expected: no new errors.

- [ ] **Step 4: Push and open PR against `dev`**

```bash
git push -u origin <branch-name>
gh pr create --base dev --title "feat: author-level reply throttle (anti-harassment)" --body "$(cat <<'EOF'
## Summary
- Adds `replyAuthorCooldownDays` per-platform config (default 7d).
- New `hasRecentReplyToAuthor()` + `listRecentEngagedAuthors()` helpers in `src/lib/reply-throttle.ts`.
- `find_threads_via_xai` injects an exclude-authors list into Grok's first-turn prompt + refinement nudges, so we don't even spend search-API tokens on candidates we'd throw away.
- `find_threads` (inbox reader) filters out throttled authors at discovery time.
- `draft_reply` returns `{ skipped: true, reason: 'author_throttled' }` as a last-mile guard for plan-execute paths that bypass discovery.
- Index `threads_user_platform_author_idx` keeps the lookup cheap.
- E2E smoke verifies a second thread from the same author yields no new draft card in `/today`.

## Why
Pre-fix, ShipFlare would draft separate replies to the same external author across multiple discovered threads — looked like reply-guy harassment from the founder's account. Per-thread dedup existed; per-author dedup did not.

## Test plan
- [ ] `pnpm tsc --noEmit --pretty false` exits 0
- [ ] `pnpm vitest run` all pass (incl. new throttle tests)
- [ ] Real-browser Playwright smoke `e2e/author-reply-throttle.spec.ts` passes against local dev with seeded fixture
- [ ] Manual: visit `/today` after seeding two threads from one already-replied author; confirm only the original card renders and pipeline-events tab shows `author_throttled`
EOF
)"
```

Per the user's `feedback_pr_merge_use_merge_commit.md` memory: when the PR lands, merge with **"Create a merge commit"**, not squash, and immediately ff `dev` to `origin/main`.

---

## Notes for Reviewers

- The throttle is intentionally **conservative**: any draft in `pending | approved | posted | handed_off` blocks new candidates. We err on under-engaging rather than spamming. Founders who want to tune this should change `replyAuthorCooldownDays` per platform, not toggle the predicate.
- We did **not** add a "manual override" path on purpose — if a founder explicitly approves a throttled draft via the `/today` UI, they bypass the agent loop entirely; the throttle only governs the auto-drafting pipeline.
- Migration is index-only (no data backfill needed). Pre-existing duplicate drafts to the same author remain in place; the throttle only governs **future** drafting decisions.
