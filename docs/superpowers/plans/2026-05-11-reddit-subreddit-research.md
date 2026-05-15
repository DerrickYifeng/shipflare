# Reddit subreddit research at kickoff + plan-time binding — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move the Reddit "which subreddit to post in" decision from draft-time (implicit, lost) to kickoff-time (explicit, persisted) so every Reddit `content_post` plan_item carries `params.subreddit` and the `/today` approve flow always has a target. Eliminate the "Reddit post requires subreddit" 500 path structurally.

**Architecture:** New `product_reddit_channels` table holds the top-3 subreddits per product, populated by a one-pass xAI Grok web_search + reddit.com filter call (mirroring `find_threads_via_xai`'s shape minus the multi-round refinement) enriched by `RedditClient.appOnly()` for member count + activity. A BullMQ worker `reddit-channel-research` runs this on onboarding commit. The kickoff coordinator's goal text injects the active rows and round-robins them across the week's Reddit content_post slots. `contentPostParamsSchema` adds an optional `subreddit` field, and `AddPlanItemTool` rejects Reddit `content_post` rows without it. Drafting + dispatch already read from `params.subreddit` so no changes are needed there.

**Tech Stack:** Next.js 15 App Router, Drizzle ORM (Postgres + drizzle-kit migrations), xAI Grok Responses API (`grok-4.20-non-reasoning` + `web_search` server-tool with `allowed_domains: ['reddit.com']`), BullMQ workers, SWR (client polling), Vitest, Playwright.

**Spec reference:** `docs/superpowers/specs/2026-05-11-reddit-subreddit-research-design.md`

---

## File Structure

**Create:**

- `src/lib/db/schema/product-reddit-channels.ts` — Drizzle schema (Task 1)
- `drizzle/<NNNN>_product_reddit_channels.sql` — migration (Task 1)
- `src/lib/db/schema/__tests__/product-reddit-channels.test.ts` — column/index/unique tests (Task 1)
- `src/skills/researching-reddit-channels/SKILL.md` — bundled skill (Task 2)
- `src/skills/researching-reddit-channels/schema.ts` — Zod input + output schemas (Task 2)
- `src/skills/researching-reddit-channels/__tests__/researching-reddit-channels.test.ts` (Task 2)
- `src/lib/reddit-channel-enrichment.ts` — `fetchSubredditAbout` + `fetchSubredditActivity` (Task 3)
- `src/lib/__tests__/reddit-channel-enrichment.test.ts` (Task 3)
- `src/workers/processors/reddit-channel-research.ts` — BullMQ processor (Task 4)
- `src/workers/processors/__tests__/reddit-channel-research.test.ts` (Task 4)
- `src/lib/db/repositories/product-reddit-channels.ts` — `listActiveSubreddits`, `upsertResearchResults`, `setDisabled`, `swapManual` (Task 5)
- `src/lib/db/repositories/__tests__/product-reddit-channels.test.ts` (Task 5)
- `src/components/onboarding/reddit-research-card.tsx` — top-3 display + edit affordances (Task 7)
- `src/app/(app)/onboarding/research/page.tsx` — SWR polling page (Task 7)
- `src/app/api/onboarding/reddit-research/status/route.ts` — GET status JSON (Task 7)
- `src/app/api/reddit-channels/route.ts` — GET list / POST manual / PATCH disable (Task 7)
- `src/app/api/reddit-channels/re-research/route.ts` — POST re-enqueue (Task 8)
- `src/app/(app)/settings/reddit-channels/page.tsx` — settings page reusing the card (Task 8)
- `e2e/tests/reddit-subreddit-research.spec.ts` — Playwright real-browser smoke (Task 10)
- `scripts/drop-stuck-content-post.sql` — one-off SQL to clean the 233588e6 draft (Task 10)

**Modify:**

- `src/lib/db/schema/index.ts` — export `productRedditChannels` (Task 1)
- `src/tools/schemas.ts` — add `subreddit: z.string().min(1).max(60).optional()` to `contentPostParamsSchema` (Task 5)
- `src/tools/AddPlanItemTool/AddPlanItemTool.ts` — reject `content_post + channel='reddit'` without `params.subreddit` (Task 5)
- `src/tools/AddPlanItemTool/__tests__/AddPlanItemTool.test.ts` — add cases for new validation (Task 5)
- `src/lib/queue/index.ts` — add `redditChannelResearchQueue` + `enqueueRedditChannelResearch` (Task 4)
- `src/workers/index.ts` (or wherever workers register) — wire the new processor (Task 4)
- `src/lib/team-kickoff.ts` — extend `buildKickoffGoalText` to fetch + inject active subreddits + round-robin instruction (Task 6)
- `src/lib/__tests__/team-kickoff.test.ts` — extend tests with subreddit-injection cases (Task 6)
- `src/app/api/onboarding/commit/route.ts` (or actual commit endpoint) — enqueue research after commit when reddit is selected (Task 8)
- `src/app/(app)/today/_components/post-card.tsx` — inline subreddit picker when Reddit `content_post` has no `params.subreddit` (Task 9)
- `src/app/api/today/[id]/edit/route.ts` (or analogous) — accept `subreddit` patch on a plan_item's `params` (Task 9)
- `src/lib/synthesize-content-post-draft.ts` — read `params.subreddit` (already does); add a contract comment that `params.subreddit` is REQUIRED upstream now (Task 5)

---

## Sequencing

```
Task 1 (schema) ──┬─→ Task 2 (research skill) ──┐
                   │                              │
                   ├─→ Task 3 (enrichment)  ─────┤
                   │                              ├─→ Task 4 (worker + queue)
                   ├─→ Task 5 (params schema)    │              │
                   │                              │              ├─→ Task 7 (onboarding UI)
                   └─→ Task 6 (kickoff goal text) ──────────────┤              │
                                                                 │              ├─→ Task 8 (commit + settings)
                                                                 │              │              │
                                                                 └─→ Task 9 (today safety net) ─┤
                                                                                                 │
                                                                                                 └─→ Task 10 (cleanup + Playwright)
```

Tasks 1-6 can mostly parallelize on separate worktrees (Tasks 2+3 land first as inputs to Task 4). Tasks 7-9 are UI / wiring on top. Task 10 is the verification gate.

---

## Task 1: Create `product_reddit_channels` table

**Why first:** Every downstream task reads or writes this table.

**Files:**
- Create: `src/lib/db/schema/product-reddit-channels.ts`
- Modify: `src/lib/db/schema/index.ts`
- Create: `drizzle/<NNNN>_product_reddit_channels.sql` (filename from `pnpm drizzle-kit generate`)
- Create: `src/lib/db/schema/__tests__/product-reddit-channels.test.ts`

### Steps

- [ ] **Step 1: Write the schema file**

Create `src/lib/db/schema/product-reddit-channels.ts`:

```ts
import {
  pgTable,
  text,
  integer,
  real,
  boolean,
  timestamp,
  jsonb,
  uniqueIndex,
  index,
} from 'drizzle-orm/pg-core';
import { users } from './users';
import { products } from './products';

export const productRedditChannels = pgTable(
  'product_reddit_channels',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    productId: text('product_id')
      .notNull()
      .references(() => products.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** Subreddit name without the r/ prefix. */
    subreddit: text('subreddit').notNull(),
    memberCount: integer('member_count'),
    fitScore: real('fit_score'),
    rulesSummary: text('rules_summary'),
    /** { postsLast7d, commentsLast7d, medianUpvotes } — jsonb so we can
     * extend without a migration. */
    activity: jsonb('activity').$type<{
      postsLast7d?: number;
      commentsLast7d?: number;
      medianUpvotes?: number;
    } | null>(),
    /** Display rank 1..N. Sort order in UI and round-robin. */
    rank: integer('rank').notNull().default(99),
    /** 'auto' (research-discovered) or 'manual' (founder-added). */
    source: text('source').notNull().default('auto'),
    /** Soft-hide. Disabled rows don't enter planner rotation but are
     * preserved so the founder can re-enable without re-discovering. */
    disabled: boolean('disabled').notNull().default(false),
    /** Updated by the planner each time it binds a content_post to this
     * subreddit. Currently informational; future round-robin variants
     * may weight by this. */
    lastUsedAt: timestamp('last_used_at', { mode: 'date' }),
    createdAt: timestamp('created_at', { mode: 'date' }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { mode: 'date' }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex('product_reddit_channels_product_subreddit_uq').on(
      t.productId,
      t.subreddit,
    ),
    index('product_reddit_channels_product_active_idx').on(
      t.productId,
      t.disabled,
      t.rank,
    ),
  ],
);

export type ProductRedditChannel = typeof productRedditChannels.$inferSelect;
export type NewProductRedditChannel = typeof productRedditChannels.$inferInsert;
```

- [ ] **Step 2: Export from schema index**

In `src/lib/db/schema/index.ts`, add the re-export line in the same style as other tables:

```ts
export * from './product-reddit-channels';
```

- [ ] **Step 3: Generate migration**

```bash
pnpm drizzle-kit generate
```

Expected: a new file `drizzle/00<NN>_*.sql` containing `CREATE TABLE "product_reddit_channels"` plus the two indexes. Inspect the file to confirm:
- Columns match the schema
- `product_id` and `user_id` have `ON DELETE CASCADE`
- The two indexes are present (one UNIQUE, one composite)

If drizzle-kit names the file weirdly, rename it to `<NNNN>_product_reddit_channels.sql` to keep the directory grep-friendly.

- [ ] **Step 4: Write failing schema test**

Create `src/lib/db/schema/__tests__/product-reddit-channels.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { getTestDb } from '@/test/fixtures/db';
import {
  productRedditChannels,
  products,
  users,
} from '@/lib/db/schema';

describe('product_reddit_channels schema', () => {
  let userId: string;
  let productId: string;
  const testDb = getTestDb();

  beforeAll(async () => {
    const [u] = await testDb
      .insert(users)
      .values({ email: `prc-${Date.now()}@test.local` })
      .returning();
    userId = u.id;
    const [p] = await testDb
      .insert(products)
      .values({
        userId,
        name: 'Test product',
        description: 'desc',
      })
      .returning();
    productId = p.id;
  });

  afterEach(async () => {
    await testDb
      .delete(productRedditChannels)
      .where(eq(productRedditChannels.productId, productId));
  });

  it('inserts a full auto row', async () => {
    const [row] = await testDb
      .insert(productRedditChannels)
      .values({
        productId,
        userId,
        subreddit: 'SaaS',
        memberCount: 250_000,
        fitScore: 0.91,
        rulesSummary: 'No self-promo on weekdays.',
        activity: { postsLast7d: 120, commentsLast7d: 800, medianUpvotes: 18 },
        rank: 1,
        source: 'auto',
      })
      .returning();
    expect(row.id).toBeTruthy();
    expect(row.subreddit).toBe('SaaS');
    expect(row.disabled).toBe(false);
    expect(row.activity?.postsLast7d).toBe(120);
  });

  it('inserts a minimal manual row with nulls allowed', async () => {
    const [row] = await testDb
      .insert(productRedditChannels)
      .values({
        productId,
        userId,
        subreddit: 'indiehackers',
        source: 'manual',
      })
      .returning();
    expect(row.memberCount).toBeNull();
    expect(row.fitScore).toBeNull();
    expect(row.activity).toBeNull();
  });

  it('rejects duplicate (productId, subreddit)', async () => {
    await testDb.insert(productRedditChannels).values({
      productId,
      userId,
      subreddit: 'SaaS',
      source: 'auto',
    });
    await expect(
      testDb.insert(productRedditChannels).values({
        productId,
        userId,
        subreddit: 'SaaS',
        source: 'manual',
      }),
    ).rejects.toThrow(/duplicate|unique/i);
  });

  it('cascades on product delete', async () => {
    const [p] = await testDb
      .insert(products)
      .values({ userId, name: 'tmp', description: 'tmp' })
      .returning();
    await testDb.insert(productRedditChannels).values({
      productId: p.id,
      userId,
      subreddit: 'tmp',
      source: 'auto',
    });
    await testDb.delete(products).where(eq(products.id, p.id));
    const after = await testDb
      .select({ c: sql<number>`count(*)::int` })
      .from(productRedditChannels)
      .where(eq(productRedditChannels.productId, p.id));
    expect(after[0]?.c).toBe(0);
  });
});
```

- [ ] **Step 5: Run test, verify failure**

```bash
pnpm vitest run src/lib/db/schema/__tests__/product-reddit-channels.test.ts
```

Expected: FAIL because the table doesn't exist in the test DB yet.

- [ ] **Step 6: Apply migration to the test DB**

```bash
pnpm drizzle-kit push
```

Or whichever command the project uses to apply migrations to the local Postgres. Verify by `\d product_reddit_channels` in psql.

- [ ] **Step 7: Re-run test, verify pass**

```bash
pnpm vitest run src/lib/db/schema/__tests__/product-reddit-channels.test.ts
```

Expected: all 4 tests PASS.

- [ ] **Step 8: Commit**

```bash
git add src/lib/db/schema/product-reddit-channels.ts src/lib/db/schema/index.ts \
        drizzle/00*_product_reddit_channels.sql drizzle/meta/ \
        src/lib/db/schema/__tests__/product-reddit-channels.test.ts
git commit -m "feat(db): add product_reddit_channels table"
```

---

## Task 2: `researching-reddit-channels` bundled skill

**Why:** Single-pass xAI Grok call that returns N candidate subreddits with fit scoring. The fork-skill that the worker invokes.

**Files:**
- Create: `src/skills/researching-reddit-channels/schema.ts`
- Create: `src/skills/researching-reddit-channels/SKILL.md`
- Create: `src/skills/_bundled/researching-reddit-channels.ts`
- Modify: `src/skills/_bundled/index.ts` — `import './researching-reddit-channels'`
- Modify: `src/skills/_catalog.ts` — add catalog entry
- Create: `src/skills/researching-reddit-channels/__tests__/researching-reddit-channels.test.ts`

### Steps

- [ ] **Step 1: Write the schema**

Create `src/skills/researching-reddit-channels/schema.ts`:

```ts
import { z } from 'zod';

export const researchingRedditChannelsInputSchema = z.object({
  product: z.object({
    name: z.string().min(1),
    description: z.string().min(1),
    valueProp: z.string().optional(),
  }),
  /** ICP signal — free text describing who the audience is. */
  icp: z.string().optional(),
  /** N candidates to surface before top-K selection. Default 6. */
  candidateCount: z.number().int().min(3).max(12).default(6),
});

export type ResearchingRedditChannelsInput = z.infer<
  typeof researchingRedditChannelsInputSchema
>;

const candidateSchema = z.object({
  /** Without r/ prefix. */
  subreddit: z.string().min(1).max(60),
  /** Member count as reported by xAI from public subreddit page. May be
   * stale; the enrichment step overwrites with a /about.json fetch. */
  memberCountApprox: z.number().int().optional(),
  /** One-paragraph summary of the rules that matter (self-promo, AI,
   * no-founders, etc.). Empty string if none. */
  rulesSummary: z.string(),
  /** Why this subreddit is or isn't a fit for the product's ICP.
   * One paragraph max. */
  fitRationale: z.string(),
  /** 0..1. 1 = ideal ICP match. The model's own judgment given the
   * product description. */
  fitScore: z.number().min(0).max(1),
});

export const researchingRedditChannelsOutputSchema = z.object({
  candidates: z.array(candidateSchema).min(0).max(12),
  costUsd: z.number().min(0).default(0),
});

export type ResearchingRedditChannelsOutput = z.infer<
  typeof researchingRedditChannelsOutputSchema
>;

export type RedditChannelCandidate = z.infer<typeof candidateSchema>;
```

- [ ] **Step 2: Write the SKILL.md**

Create `src/skills/researching-reddit-channels/SKILL.md`:

```markdown
---
name: researching-reddit-channels
description: Single-pass xAI Grok web_search (reddit.com only) that returns N candidate subreddits with fit scoring for a given product.
context: fork
model: grok-4.20-non-reasoning
allowed-tools: web_search
---

# researching-reddit-channels

Find N candidate subreddits where the product's ICP gathers.

## Input

`$ARGUMENTS` is a JSON object matching `researchingRedditChannelsInputSchema`:

```
{
  "product": { "name": "...", "description": "...", "valueProp": "..." },
  "icp": "solo founders building distribution tooling",
  "candidateCount": 6
}
```

## Task

For the product above, return up to `candidateCount` Reddit communities where
the ICP would plausibly read or post. For each:

1. `subreddit` — name without `r/` (e.g. `SaaS`, `indiehackers`, `microsaas`).
2. `memberCountApprox` — approximate subscribers, from the public subreddit
   page. Round to the nearest 1k. Omit if you can't find a number.
3. `rulesSummary` — one paragraph (<200 chars) covering the rules that matter
   for self-promo: are AI-tool posts banned, is "no founders" enforced, are
   weekly self-promo threads the only allowed entry. Empty string if no
   relevant rules.
4. `fitRationale` — one paragraph (<300 chars) covering WHY this subreddit
   matches (or doesn't quite match) the product's ICP. Specific: name the
   audience overlap, not just "developers".
5. `fitScore` — 0..1. Be honest. r/SaaS for a SaaS distribution tool: 0.9.
   r/programming for the same tool: 0.4 (audience is broader, mostly
   employees not founders).

Use `web_search` with `allowed_domains: ['reddit.com']`. Search by ICP terms
+ pain keywords from the product description.

## Output

JSON matching `researchingRedditChannelsOutputSchema`:

```
{
  "candidates": [{ "subreddit": "...", "memberCountApprox": 250000, "rulesSummary": "...", "fitRationale": "...", "fitScore": 0.91 }],
  "costUsd": 0.05
}
```

## Quality bar

- Each candidate must be a real subreddit. Do not invent.
- Do not include NSFW subreddits even if they technically match the ICP.
- Do not include subreddits with fewer than 1,000 subscribers (too small to
  matter, often spam targets).
- Do not include `defaultSources` from the platform config as filler — only
  return what genuinely matches.
- If you can find fewer than `candidateCount` matches, return fewer. Empty
  list is acceptable if nothing matches.
```

- [ ] **Step 3: Write the bundled skill registration**

Create `src/skills/_bundled/researching-reddit-channels.ts`. Look at an existing bundled skill (e.g. `_bundled/generating-strategy.ts`) for the exact `registerBundledSkill` shape. The skill should:

- Build the xAI Responses request with `model: 'grok-4.20-non-reasoning'`, `tools: [{ type: 'web_search', allowed_domains: ['reddit.com'] }]`, structured-output schema from `researchingRedditChannelsOutputSchema`.
- Inject the input JSON into the user message body.
- Parse the response, capture `costUsd` from the response cost field.
- Return the parsed output.

(Implementation mirrors `FindThreadsViaXaiTool`'s xAI Responses pattern — start there as the reference.)

- [ ] **Step 4: Register in catalog + barrel**

In `src/skills/_catalog.ts`, add:

```ts
{
  name: 'researching-reddit-channels',
  kind: 'bundled',
  supportedKinds: [],
  channels: ['reddit'],
  description: 'Find candidate subreddits for a product.',
},
```

In `src/skills/_bundled/index.ts`, add:

```ts
import './researching-reddit-channels';
```

- [ ] **Step 5: Write the failing test**

Create `src/skills/researching-reddit-channels/__tests__/researching-reddit-channels.test.ts`. Mock the xAI client and assert:
- Skill calls xAI with `web_search` + reddit.com domain filter
- Skill parses the response shape into `ResearchingRedditChannelsOutput`
- Skill returns the parsed candidates array sorted as-given (sorting is the worker's job)
- Skill propagates `costUsd` from the response

Use existing skill tests as a reference for mocking patterns (`src/skills/generating-strategy/__tests__/generating-strategy.test.ts`).

- [ ] **Step 6: Run test, verify failure**

```bash
pnpm vitest run src/skills/researching-reddit-channels/__tests__/researching-reddit-channels.test.ts
```

Expected: FAIL because the skill isn't registered yet.

- [ ] **Step 7: Implement the skill**

Fill in `src/skills/_bundled/researching-reddit-channels.ts` until the test passes. Borrow the xAI Responses call construction from `XaiFindCustomersTool.ts` (the helper that `FindThreadsViaXaiTool` uses for the first turn) — it already handles `web_search` server-tool + structured output + cost parsing.

- [ ] **Step 8: Run test, verify pass**

```bash
pnpm vitest run src/skills/researching-reddit-channels/__tests__/researching-reddit-channels.test.ts
```

Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add src/skills/researching-reddit-channels/ src/skills/_bundled/researching-reddit-channels.ts \
        src/skills/_bundled/index.ts src/skills/_catalog.ts
git commit -m "feat(skill): add researching-reddit-channels bundled skill"
```

---

## Task 3: Reddit enrichment helpers

**Why:** Member count and 7-day activity are deterministic facts; trust Reddit's API over the LLM's guess.

**Files:**
- Create: `src/lib/reddit-channel-enrichment.ts`
- Create: `src/lib/__tests__/reddit-channel-enrichment.test.ts`

### Steps

- [ ] **Step 1: Write failing tests first**

Create `src/lib/__tests__/reddit-channel-enrichment.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

const getMock = vi.fn();
vi.mock('@/lib/reddit-client', () => ({
  RedditClient: {
    appOnly: () => ({ get: (path: string) => getMock(path) }),
  },
}));

import {
  fetchSubredditAbout,
  fetchSubredditActivity,
} from '../reddit-channel-enrichment';

beforeEach(() => {
  getMock.mockReset();
});

describe('fetchSubredditAbout', () => {
  it('returns subscribers from /r/<sub>/about.json', async () => {
    getMock.mockResolvedValueOnce({ data: { subscribers: 250_000 } });
    const result = await fetchSubredditAbout('SaaS');
    expect(getMock).toHaveBeenCalledWith('/r/SaaS/about.json');
    expect(result).toEqual({ memberCount: 250_000 });
  });

  it('returns null memberCount if Reddit returns no data', async () => {
    getMock.mockResolvedValueOnce({ data: null });
    const result = await fetchSubredditAbout('weird');
    expect(result.memberCount).toBeNull();
  });

  it('swallows errors and returns null fields', async () => {
    getMock.mockRejectedValueOnce(new Error('429 rate limit'));
    const result = await fetchSubredditAbout('SaaS');
    expect(result.memberCount).toBeNull();
  });
});

describe('fetchSubredditActivity', () => {
  it('counts posts in last 7d and computes median upvotes', async () => {
    const now = Math.floor(Date.now() / 1000);
    const day = 86400;
    getMock.mockResolvedValueOnce({
      data: {
        children: [
          { data: { created_utc: now - 1 * day, score: 10, num_comments: 5 } },
          { data: { created_utc: now - 2 * day, score: 50, num_comments: 20 } },
          { data: { created_utc: now - 8 * day, score: 1000, num_comments: 200 } },
        ],
      },
    });
    const result = await fetchSubredditActivity('SaaS');
    expect(getMock).toHaveBeenCalledWith('/r/SaaS/new.json?limit=50');
    expect(result.postsLast7d).toBe(2);
    expect(result.commentsLast7d).toBe(25);
    expect(result.medianUpvotes).toBe(30); // median of [10, 50]
  });

  it('returns zeros on error, not a throw', async () => {
    getMock.mockRejectedValueOnce(new Error('network'));
    const result = await fetchSubredditActivity('SaaS');
    expect(result).toEqual({
      postsLast7d: 0,
      commentsLast7d: 0,
      medianUpvotes: 0,
    });
  });
});
```

- [ ] **Step 2: Run test, verify failure**

```bash
pnpm vitest run src/lib/__tests__/reddit-channel-enrichment.test.ts
```

Expected: FAIL with "module not found".

- [ ] **Step 3: Implement**

Create `src/lib/reddit-channel-enrichment.ts`:

```ts
import { RedditClient } from '@/lib/reddit-client';

const SEVEN_DAYS_SECONDS = 7 * 24 * 60 * 60;

export interface SubredditAbout {
  memberCount: number | null;
}

export async function fetchSubredditAbout(
  subreddit: string,
): Promise<SubredditAbout> {
  try {
    const data = (await RedditClient.appOnly().get(
      `/r/${subreddit}/about.json`,
    )) as { data?: { subscribers?: number } | null };
    const subs = data?.data?.subscribers;
    return { memberCount: typeof subs === 'number' ? subs : null };
  } catch {
    return { memberCount: null };
  }
}

export interface SubredditActivity {
  postsLast7d: number;
  commentsLast7d: number;
  medianUpvotes: number;
}

export async function fetchSubredditActivity(
  subreddit: string,
): Promise<SubredditActivity> {
  try {
    const data = (await RedditClient.appOnly().get(
      `/r/${subreddit}/new.json?limit=50`,
    )) as {
      data?: {
        children?: Array<{
          data?: { created_utc?: number; score?: number; num_comments?: number };
        }>;
      } | null;
    };
    const nowSec = Math.floor(Date.now() / 1000);
    const cutoff = nowSec - SEVEN_DAYS_SECONDS;
    const recent =
      data?.data?.children
        ?.map((c) => c.data)
        .filter(
          (d): d is { created_utc: number; score: number; num_comments: number } =>
            typeof d?.created_utc === 'number' && d.created_utc >= cutoff,
        ) ?? [];
    const postsLast7d = recent.length;
    const commentsLast7d = recent.reduce(
      (sum, d) => sum + (d.num_comments ?? 0),
      0,
    );
    const scores = recent.map((d) => d.score ?? 0).sort((a, b) => a - b);
    const medianUpvotes =
      scores.length === 0
        ? 0
        : scores.length % 2 === 1
          ? scores[(scores.length - 1) / 2]
          : Math.round(
              (scores[scores.length / 2 - 1] + scores[scores.length / 2]) / 2,
            );
    return { postsLast7d, commentsLast7d, medianUpvotes };
  } catch {
    return { postsLast7d: 0, commentsLast7d: 0, medianUpvotes: 0 };
  }
}
```

- [ ] **Step 4: Run test, verify pass**

```bash
pnpm vitest run src/lib/__tests__/reddit-channel-enrichment.test.ts
```

Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/reddit-channel-enrichment.ts src/lib/__tests__/reddit-channel-enrichment.test.ts
git commit -m "feat(reddit): add subreddit about + activity enrichment helpers"
```

---

## Task 4: `reddit-channel-research` BullMQ worker

**Why:** Glues Task 2 (skill) + Task 3 (enrichment) and persists top-3 rows to the table.

**Files:**
- Create: `src/workers/processors/reddit-channel-research.ts`
- Create: `src/workers/processors/__tests__/reddit-channel-research.test.ts`
- Modify: `src/lib/queue/types.ts` (or wherever `JobData` types live) — add `RedditChannelResearchJobData`
- Modify: `src/lib/queue/index.ts` — export `redditChannelResearchQueue`, `enqueueRedditChannelResearch`
- Modify: worker registration file (likely `src/workers/index.ts` or analogous)

### Steps

- [ ] **Step 1: Add the queue + enqueue helper**

In `src/lib/queue/index.ts`, follow the same shape as `analyticsQueue` and `enqueueAnalytics`:

```ts
export interface RedditChannelResearchJobData {
  schemaVersion: 1;
  userId: string;
  productId: string;
  /** If false (default), skip when product_reddit_channels already has
   *  at least one auto row for the product. */
  force?: boolean;
  traceId?: string;
}

export const redditChannelResearchQueue =
  new Queue<RedditChannelResearchJobData>('reddit-channel-research', {
    connection: getRedisConnection(),
    defaultJobOptions: {
      removeOnComplete: 100,
      removeOnFail: 100,
      attempts: 2,
      backoff: { type: 'exponential', delay: 5000 },
    },
  });

export async function enqueueRedditChannelResearch(
  data: Omit<RedditChannelResearchJobData, 'schemaVersion'>,
): Promise<void> {
  await redditChannelResearchQueue.add('research', {
    schemaVersion: 1,
    ...data,
  });
}
```

- [ ] **Step 2: Write the failing worker test**

Create `src/workers/processors/__tests__/reddit-channel-research.test.ts`. Mock:
- `runSkill` (skill runner) → returns 6 candidates with descending fitScore
- `fetchSubredditAbout` → returns memberCount per candidate
- `fetchSubredditActivity` → returns activity per candidate
- `db` (in-memory store with `productRedditChannels`, `products`)

Assert:
- Worker writes exactly 3 rows (top-3 by fitScore DESC)
- Each row has `source='auto'`, `rank` 1/2/3, `disabled=false`
- Enrichment fields populated (memberCount + activity)
- Idempotent: second run with `force=false` writes no new rows
- Idempotent override: second run with `force=true` DELETEs autos and re-writes

Sketch:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
// vi.mock the skill runner + enrichment + db (in-memory)
import { processRedditChannelResearch } from '../reddit-channel-research';

describe('reddit-channel-research worker', () => {
  beforeEach(() => { /* reset mocks */ });

  it('writes top-3 by fitScore DESC on first run', async () => {
    // arrange mocks: skill returns 6 candidates, scores 0.95..0.45
    // enrichment returns known member counts
    await processRedditChannelResearch(
      { schemaVersion: 1, userId: 'u', productId: 'p', force: false },
      mockCtx,
    );
    const rows = await readAllRows();
    expect(rows).toHaveLength(3);
    expect(rows.map((r) => r.rank)).toEqual([1, 2, 3]);
    expect(rows[0].fitScore).toBe(0.95);
    expect(rows[0].memberCount).toBe(250_000);
  });

  it('is a no-op when force=false and auto rows already exist', async () => {
    // pre-seed an auto row
    await processRedditChannelResearch(
      { schemaVersion: 1, userId: 'u', productId: 'p', force: false },
      mockCtx,
    );
    // assert skill was NOT invoked, no new rows written
  });

  it('clears autos and re-writes when force=true', async () => {
    // pre-seed
    await processRedditChannelResearch(
      { schemaVersion: 1, userId: 'u', productId: 'p', force: true },
      mockCtx,
    );
    // assert old autos gone, new 3 autos present, manual rows preserved
  });
});
```

- [ ] **Step 3: Run test, verify failure**

```bash
pnpm vitest run src/workers/processors/__tests__/reddit-channel-research.test.ts
```

Expected: FAIL with module not found.

- [ ] **Step 4: Implement the worker**

Create `src/workers/processors/reddit-channel-research.ts`. Shape:

```ts
import { db } from '@/lib/db';
import { productRedditChannels, products } from '@/lib/db/schema';
import { and, eq } from 'drizzle-orm';
import { runSkill } from '@/core/skill-runner';
import {
  fetchSubredditAbout,
  fetchSubredditActivity,
} from '@/lib/reddit-channel-enrichment';
import { createLogger, withTrace } from '@/lib/logger';
import type { RedditChannelResearchJobData } from '@/lib/queue';
import type { ProcessorContext } from '@/workers/types'; // or whatever the existing pattern is

const log = createLogger('worker:reddit-channel-research');
const TOP_K = 3;

export async function processRedditChannelResearch(
  data: RedditChannelResearchJobData,
  ctx: ProcessorContext,
): Promise<void> {
  const tlog = withTrace(log, data.traceId);
  const { userId, productId, force = false } = data;

  // 1. Idempotency gate
  if (!force) {
    const existing = await db
      .select({ id: productRedditChannels.id })
      .from(productRedditChannels)
      .where(
        and(
          eq(productRedditChannels.productId, productId),
          eq(productRedditChannels.source, 'auto'),
        ),
      )
      .limit(1);
    if (existing.length > 0) {
      tlog.info(`product ${productId} already researched — no-op`);
      return;
    }
  }

  // 2. Fetch product for skill input
  const [productRow] = await db
    .select({
      name: products.name,
      description: products.description,
      valueProp: products.valueProp,
    })
    .from(products)
    .where(eq(products.id, productId))
    .limit(1);
  if (!productRow) {
    tlog.warn(`product ${productId} not found — abort`);
    return;
  }

  // 3. Invoke researching-reddit-channels skill (fork)
  const skillOutput = await runSkill('researching-reddit-channels', {
    input: {
      product: {
        name: productRow.name,
        description: productRow.description,
        valueProp: productRow.valueProp ?? undefined,
      },
      candidateCount: 6,
    },
    userId,
    productId,
  });
  // (Exact runSkill call shape: copy from an existing worker that runs
  // a bundled skill, e.g. workers/processors/review.ts.)

  const candidates = skillOutput.candidates ?? [];
  if (candidates.length === 0) {
    tlog.warn(`xAI returned 0 candidates for product ${productId}`);
    // Persist a marker row so the UI can show "no matches found"? Defer
    // to Task 7; for now leave the table empty.
    return;
  }

  // 4. Sort by fitScore DESC, take top-K
  const top = [...candidates]
    .sort((a, b) => (b.fitScore ?? 0) - (a.fitScore ?? 0))
    .slice(0, TOP_K);

  // 5. Enrich each top candidate
  const enriched = await Promise.all(
    top.map(async (c, i) => {
      const [about, activity] = await Promise.all([
        fetchSubredditAbout(c.subreddit),
        fetchSubredditActivity(c.subreddit),
      ]);
      return {
        productId,
        userId,
        subreddit: c.subreddit,
        memberCount: about.memberCount ?? c.memberCountApprox ?? null,
        fitScore: c.fitScore,
        rulesSummary: c.rulesSummary,
        activity,
        rank: i + 1,
        source: 'auto' as const,
        disabled: false,
      };
    }),
  );

  // 6. Persist: delete prior autos, insert new top-K
  await db.transaction(async (tx) => {
    await tx
      .delete(productRedditChannels)
      .where(
        and(
          eq(productRedditChannels.productId, productId),
          eq(productRedditChannels.source, 'auto'),
        ),
      );
    if (enriched.length > 0) {
      await tx.insert(productRedditChannels).values(enriched);
    }
  });

  tlog.info(
    `wrote ${enriched.length} auto reddit channels for product ${productId}`,
  );
}
```

- [ ] **Step 5: Register the worker**

Find the worker registration file (likely `src/workers/index.ts` or `src/workers/start.ts` — grep for `analyticsQueue` registration as the reference). Add the new processor:

```ts
import { Worker } from 'bullmq';
import { redditChannelResearchQueue } from '@/lib/queue';
import { processRedditChannelResearch } from './processors/reddit-channel-research';
import { buildProcessorContext } from './lib/processor-context'; // existing helper

new Worker(
  redditChannelResearchQueue.name,
  async (job) => {
    await processRedditChannelResearch(job.data, buildProcessorContext(job));
  },
  { connection: getRedisConnection(), concurrency: 2 },
);
```

(Match the exact registration shape of existing workers.)

- [ ] **Step 6: Run test, verify pass**

```bash
pnpm vitest run src/workers/processors/__tests__/reddit-channel-research.test.ts
```

Expected: PASS (3 tests).

- [ ] **Step 7: Commit**

```bash
git add src/workers/processors/reddit-channel-research.ts \
        src/workers/processors/__tests__/reddit-channel-research.test.ts \
        src/workers/index.ts src/lib/queue/index.ts src/lib/queue/types.ts
git commit -m "feat(worker): add reddit-channel-research processor + queue"
```

---

## Task 5: Repository + schema enforcement for `params.subreddit`

**Why:** Server-side contract so no Reddit content_post can be persisted without a target subreddit. Closes the architectural gap that caused the 500.

**Files:**
- Create: `src/lib/db/repositories/product-reddit-channels.ts`
- Create: `src/lib/db/repositories/__tests__/product-reddit-channels.test.ts`
- Modify: `src/tools/schemas.ts` — add `subreddit` to `contentPostParamsSchema`
- Modify: `src/tools/AddPlanItemTool/AddPlanItemTool.ts` — enforce required for reddit content_post
- Modify: `src/tools/AddPlanItemTool/__tests__/AddPlanItemTool.test.ts`
- Modify: `src/lib/synthesize-content-post-draft.ts` — update comment to reflect new contract

### Steps

- [ ] **Step 1: Write the repository**

Create `src/lib/db/repositories/product-reddit-channels.ts`:

```ts
import { db } from '@/lib/db';
import { productRedditChannels } from '@/lib/db/schema';
import { and, eq, asc } from 'drizzle-orm';

/** Active (not disabled) subreddits for a product, ordered by rank. */
export async function listActiveSubreddits(
  productId: string,
): Promise<Array<{ subreddit: string; rank: number; fitScore: number | null }>> {
  return db
    .select({
      subreddit: productRedditChannels.subreddit,
      rank: productRedditChannels.rank,
      fitScore: productRedditChannels.fitScore,
    })
    .from(productRedditChannels)
    .where(
      and(
        eq(productRedditChannels.productId, productId),
        eq(productRedditChannels.disabled, false),
      ),
    )
    .orderBy(asc(productRedditChannels.rank));
}

/** All rows for a product (active + disabled) — for settings UI. */
export async function listAllSubreddits(productId: string) {
  return db
    .select()
    .from(productRedditChannels)
    .where(eq(productRedditChannels.productId, productId))
    .orderBy(asc(productRedditChannels.rank));
}

/** Mark `lastUsedAt` to now. Called by the planner when binding a
 *  content_post to this subreddit. */
export async function markSubredditUsed(
  productId: string,
  subreddit: string,
): Promise<void> {
  await db
    .update(productRedditChannels)
    .set({ lastUsedAt: new Date(), updatedAt: new Date() })
    .where(
      and(
        eq(productRedditChannels.productId, productId),
        eq(productRedditChannels.subreddit, subreddit),
      ),
    );
}

/** Toggle disabled. Used by settings UI. */
export async function setSubredditDisabled(
  productId: string,
  subreddit: string,
  disabled: boolean,
): Promise<void> {
  await db
    .update(productRedditChannels)
    .set({ disabled, updatedAt: new Date() })
    .where(
      and(
        eq(productRedditChannels.productId, productId),
        eq(productRedditChannels.subreddit, subreddit),
      ),
    );
}

/** Insert a manual entry. Idempotent — re-adding the same subreddit
 *  un-disables it if it existed and was disabled. */
export async function upsertManualSubreddit(args: {
  productId: string;
  userId: string;
  subreddit: string;
}): Promise<void> {
  const { productId, userId, subreddit } = args;
  await db
    .insert(productRedditChannels)
    .values({ productId, userId, subreddit, source: 'manual', rank: 99 })
    .onConflictDoUpdate({
      target: [productRedditChannels.productId, productRedditChannels.subreddit],
      set: { disabled: false, updatedAt: new Date() },
    });
}
```

- [ ] **Step 2: Write the failing repository test**

Create `src/lib/db/repositories/__tests__/product-reddit-channels.test.ts`. Cover:
- `listActiveSubreddits` returns only `disabled=false`, ordered by rank
- `markSubredditUsed` updates `lastUsedAt`
- `setSubredditDisabled(true)` hides the row from `listActiveSubreddits`
- `upsertManualSubreddit` inserts new + un-disables existing

Use the in-memory DB pattern from `src/lib/__tests__/synthesize-content-post-draft.test.ts`.

- [ ] **Step 3: Run, verify failure, implement, run, verify pass**

```bash
pnpm vitest run src/lib/db/repositories/__tests__/product-reddit-channels.test.ts
```

- [ ] **Step 4: Add `subreddit` to `contentPostParamsSchema`**

In `src/tools/schemas.ts`, modify `contentPostParamsSchema`:

```ts
export const contentPostParamsSchema = z
  .object({
    format: z.enum(['milestone', 'lesson', 'hot_take', 'behind_the_scenes', 'question']).optional(),
    theme: z.string().min(1).max(120).optional(),
    arc_position: z.object({ index: z.number().int().min(1), of: z.number().int().min(1) }).optional(),
    metaphor_ban: z.array(z.string().min(1).max(40)).max(20).optional(),
    cross_refs: z.array(z.string().uuid()).max(5).optional(),
    /** Reddit-only. REQUIRED when the plan_item's `channel === 'reddit'`.
     * The runtime check is in AddPlanItemTool; this field is optional at
     * the Zod layer so X content_post params keep validating. */
    subreddit: z.string().min(1).max(60).optional(),
  })
  .passthrough();
```

- [ ] **Step 5: Add the runtime check in `AddPlanItemTool`**

In `src/tools/AddPlanItemTool/AddPlanItemTool.ts`, after the existing `contentPostParamsSchema.safeParse(input.params)` block:

```ts
if (input.kind === 'content_post') {
  const parsed = contentPostParamsSchema.safeParse(input.params);
  if (!parsed.success) {
    const message = parsed.error.issues
      .map((i) => `${i.path.join('.')}: ${i.message}`)
      .join('; ');
    throw new Error(
      `add_plan_item: content_post params failed validation — ${message}`,
    );
  }
  if (input.channel === 'reddit') {
    if (typeof parsed.data.subreddit !== 'string' || parsed.data.subreddit.length === 0) {
      throw new Error(
        `add_plan_item: reddit content_post requires params.subreddit ` +
          `(set it from the available subreddits the kickoff goal listed)`,
      );
    }
  }
}
```

- [ ] **Step 6: Extend the AddPlanItemTool tests**

In `src/tools/AddPlanItemTool/__tests__/AddPlanItemTool.test.ts`, add two cases:

```ts
it('rejects reddit content_post without params.subreddit', async () => {
  await expect(
    addPlanItemTool.execute(
      {
        kind: 'content_post',
        channel: 'reddit',
        userAction: 'approve',
        phase: 'foundation',
        dueDate: '2026-05-11',
        sortOrder: 0,
        title: 'reddit post',
        params: { format: 'lesson' }, // missing subreddit
      },
      mockCtx,
    ),
  ).rejects.toThrow(/reddit content_post requires params\.subreddit/);
});

it('accepts reddit content_post WITH params.subreddit', async () => {
  const res = await addPlanItemTool.execute(
    {
      kind: 'content_post',
      channel: 'reddit',
      userAction: 'approve',
      phase: 'foundation',
      dueDate: '2026-05-11',
      sortOrder: 0,
      title: 'reddit post',
      params: { format: 'lesson', subreddit: 'SaaS' },
    },
    mockCtx,
  );
  expect(res.planItemId).toBeTruthy();
});

it('still accepts x content_post WITHOUT subreddit (X has no subreddit)', async () => {
  const res = await addPlanItemTool.execute(
    {
      kind: 'content_post',
      channel: 'x',
      userAction: 'approve',
      phase: 'foundation',
      dueDate: '2026-05-11',
      sortOrder: 0,
      title: 'x post',
      params: { format: 'hot_take' },
    },
    mockCtx,
  );
  expect(res.planItemId).toBeTruthy();
});
```

- [ ] **Step 7: Run, verify pass**

```bash
pnpm vitest run src/tools/AddPlanItemTool/__tests__/AddPlanItemTool.test.ts \
                 src/lib/db/repositories/__tests__/product-reddit-channels.test.ts
```

- [ ] **Step 8: Update synthesize comment**

In `src/lib/synthesize-content-post-draft.ts`, replace the inline comment near line 91 with:

```ts
// params.subreddit is REQUIRED by AddPlanItemTool for Reddit content_post
// since the kickoff-research refactor. If a Reddit row reaches this code
// path with no subreddit, that's an upstream contract violation — keep
// the helpful r/-strip but do NOT fall back. dispatchApprove enforces
// non-null subreddit one more time downstream.
```

No code change, just the comment.

- [ ] **Step 9: Commit**

```bash
git add src/lib/db/repositories/ src/tools/schemas.ts \
        src/tools/AddPlanItemTool/ src/lib/synthesize-content-post-draft.ts
git commit -m "feat(schema): require params.subreddit for reddit content_post"
```

---

## Task 6: Kickoff goal text injection

**Why:** The coordinator must know which subreddits to bind. Read from `product_reddit_channels`, inject into the goal.

**Files:**
- Modify: `src/lib/team-kickoff.ts` — `buildKickoffGoalText` (and its caller) reads the channels list and injects it
- Modify: `src/lib/__tests__/team-kickoff.test.ts`

### Steps

- [ ] **Step 1: Failing test**

Extend `src/lib/__tests__/team-kickoff.test.ts` with a case:

```ts
it('injects available subreddits into the goal text when reddit is connected', async () => {
  // Mock listActiveSubreddits to return three rows
  const goal = buildKickoffGoalText({
    productName: 'Test',
    pathId: 'p1',
    weekStart: '2026-05-11',
    now: '2026-05-11T00:00:00Z',
    channels: ['reddit'],
    week1Posts: { x: 0, reddit: 4 },
    channelMix: { reddit: { perWeek: 4, repliesPerDay: 0 } } as any,
    availableSubreddits: [
      { subreddit: 'SaaS', rank: 1, fitScore: 0.91 },
      { subreddit: 'indiehackers', rank: 2, fitScore: 0.85 },
      { subreddit: 'microsaas', rank: 3, fitScore: 0.72 },
    ],
  });
  expect(goal).toMatch(/Available subreddits for reddit content_post/);
  expect(goal).toMatch(/r\/SaaS \(fit 0\.91\)/);
  expect(goal).toMatch(/r\/indiehackers/);
  expect(goal).toMatch(/r\/microsaas/);
  expect(goal).toMatch(/Rotate evenly.*sortOrder/);
});

it('omits Reddit content_post spawn when availableSubreddits is empty', async () => {
  const goal = buildKickoffGoalText({
    /* …reddit connected but availableSubreddits: [] */
  } as any);
  expect(goal).not.toMatch(/draft reddit post batch/);
  expect(goal).toMatch(/Reddit research not yet complete|No subreddits available/);
});
```

- [ ] **Step 2: Add `availableSubreddits` to `KickoffGoalArgs`**

In `src/lib/team-kickoff.ts`:

```ts
export interface KickoffGoalArgs {
  // …existing fields…
  availableSubreddits?: Array<{
    subreddit: string;
    rank: number;
    fitScore: number | null;
  }>;
}
```

Update the caller (`ensureKickoffEnqueued`) to fetch via `listActiveSubreddits(productId)` and pass through.

- [ ] **Step 3: Implement the injection in `buildKickoffGoalText`**

Insert the new logic between the existing `Step 1 — Seed week-1 plan_items` line and the spawn directives. Roughly:

```ts
const redditPostCount = redditConnected ? week1Posts.reddit : 0;
const subs = args.availableSubreddits ?? [];

if (redditConnected && redditPostCount > 0 && subs.length === 0) {
  lines.push(
    `NOTE: Reddit content_post slots requested (${redditPostCount}/week) but `,
    `no subreddits researched yet. Skip Reddit post add_plan_item calls. `,
    `Tell the founder to wait for kickoff research to finish (≤60s) or `,
    `re-research from /settings/reddit-channels.`,
    ``,
  );
} else if (redditConnected && subs.length > 0) {
  lines.push(
    `Available subreddits for reddit content_post (use these for params.subreddit):`,
    ...subs.map(
      (s) =>
        `  - r/${s.subreddit}` +
        (s.fitScore !== null ? ` (fit ${s.fitScore.toFixed(2)})` : ``),
    ),
    `Rotate evenly: for each Reddit content_post row, set ` +
      `params.subreddit = availableSubreddits[sortOrder % availableSubreddits.length].subreddit. ` +
      `Strip any r/ prefix when writing the value (store just the name).`,
    ``,
  );
}

// Then drop the existing reddit-post spawn if subs.length === 0:
if (redditConnected && week1Posts.reddit > 0 && subs.length > 0) {
  spawns.push(/* existing reddit post batch line */);
}
```

- [ ] **Step 4: Wire `ensureKickoffEnqueued` to load subreddits**

In the calling function (the one that constructs the args), add a call to `listActiveSubreddits(productId)` and pass to `buildKickoffGoalText`. Update its tests to mock this.

- [ ] **Step 5: Run all kickoff tests**

```bash
pnpm vitest run src/lib/__tests__/team-kickoff.test.ts
```

Expected: PASS including the two new cases.

- [ ] **Step 6: Commit**

```bash
git add src/lib/team-kickoff.ts src/lib/__tests__/team-kickoff.test.ts
git commit -m "feat(kickoff): inject available subreddits into goal text + rotation rule"
```

---

## Task 7: Onboarding `/research` page + status API

**Why:** Founder sees the work happening, sees the result, can swap/disable inline. Same component is reused in settings (Task 8).

**Files:**
- Create: `src/app/api/reddit-channels/route.ts` — GET (list) / POST (manual add) / PATCH (set disabled)
- Create: `src/app/api/onboarding/reddit-research/status/route.ts` — GET research progress
- Create: `src/components/onboarding/reddit-research-card.tsx` — shared card UI
- Create: `src/app/(app)/onboarding/research/page.tsx` — server route hosting the card

### Steps

- [ ] **Step 1: Write GET / POST / PATCH endpoint for channels**

`src/app/api/reddit-channels/route.ts`:
- GET → `{ channels: ProductRedditChannel[] }` for the current user+product
- POST `{ subreddit }` → `upsertManualSubreddit(...)`, returns 200
- PATCH `{ subreddit, disabled }` → `setSubredditDisabled(...)`, returns 200

Validate subreddit format (`/^[A-Za-z0-9_]{3,21}$/`). Auth via `auth()`. 404 if no product for user.

- [ ] **Step 2: Write GET status endpoint**

`src/app/api/onboarding/reddit-research/status/route.ts` returns `{ status: 'pending' | 'done' | 'failed', count: number }`:
- `done` if 1+ auto rows exist
- `pending` if 0 auto rows AND a recent job is in-flight or queued (check BullMQ `redditChannelResearchQueue.getJobs(['waiting', 'active'])` filtered by `data.productId`)
- `failed` if 0 auto rows AND a recent job ended in failed state
- `pending` as the safe default

- [ ] **Step 3: Write the shared card component**

`src/components/onboarding/reddit-research-card.tsx`. Client component. Uses SWR to poll the status + channels endpoints:

```tsx
'use client';
import useSWR from 'swr';
import { useState } from 'react';

const fetcher = (u: string) => fetch(u).then((r) => r.json());

export function RedditResearchCard() {
  const status = useSWR('/api/onboarding/reddit-research/status', fetcher, {
    refreshInterval: (data) => (data?.status === 'pending' ? 3000 : 0),
  });
  const channels = useSWR('/api/reddit-channels', fetcher, {
    refreshInterval: (data) => (status.data?.status === 'pending' ? 3000 : 0),
  });
  const [manualInput, setManualInput] = useState('');

  // Loading / pending / done / failed UI states
  // Each channel row: name, member count, fit score, rules summary,
  // 7d activity, Disable / Enable toggle, "Manual" badge if source='manual'
  // Manual add input + submit
  // "Re-research" button (POSTs /api/reddit-channels/re-research)
  // …
}
```

Write the actual JSX. Don't placeholder this.

- [ ] **Step 4: Write the onboarding page**

`src/app/(app)/onboarding/research/page.tsx` — server component that hosts the card with the layout chrome matching the other onboarding steps. Pull the layout pattern from an existing onboarding step.

- [ ] **Step 5: Write Vitest + Playwright tests**

Vitest: snapshot test the card for each of the three statuses (pending / done / failed).

Playwright (defer the full spec to Task 10): just an `'use client'` rendering check at this stage.

- [ ] **Step 6: Commit**

```bash
git add src/app/api/reddit-channels/ src/app/api/onboarding/reddit-research/ \
        src/components/onboarding/reddit-research-card.tsx \
        src/app/\(app\)/onboarding/research/
git commit -m "feat(onboarding): add reddit-research status + edit UI"
```

---

## Task 8: Trigger research on commit + settings page

**Why:** End-to-end: commit onboarding → research fires automatically. Settings reuses the card for ongoing edits.

**Files:**
- Modify: `src/app/api/onboarding/commit/route.ts` (or actual commit endpoint — grep for `enqueueDream` or similar to find it)
- Create: `src/app/api/reddit-channels/re-research/route.ts`
- Create: `src/app/(app)/settings/reddit-channels/page.tsx`

### Steps

- [ ] **Step 1: Enqueue in onboarding commit**

Find the onboarding commit endpoint (probably `src/app/api/onboarding/commit/route.ts` or `src/app/api/onboarding/plan/route.ts`). Where the channels are persisted, add:

```ts
if (selectedChannels.includes('reddit')) {
  await enqueueRedditChannelResearch({
    userId,
    productId,
    force: false,
  });
  log.info(`enqueued reddit-channel-research for product ${productId}`);
}
```

- [ ] **Step 2: Write the re-research endpoint**

`src/app/api/reddit-channels/re-research/route.ts`:

```ts
import { NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { enqueueRedditChannelResearch } from '@/lib/queue';
import { db } from '@/lib/db';
import { products } from '@/lib/db/schema';
import { and, eq } from 'drizzle-orm';

export async function POST() {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const [product] = await db
    .select({ id: products.id })
    .from(products)
    .where(eq(products.userId, session.user.id))
    .limit(1);
  if (!product) {
    return NextResponse.json({ error: 'no_product' }, { status: 404 });
  }
  await enqueueRedditChannelResearch({
    userId: session.user.id,
    productId: product.id,
    force: true, // explicit user action — overwrite autos
  });
  return NextResponse.json({ ok: true });
}
```

- [ ] **Step 3: Write the settings page**

`src/app/(app)/settings/reddit-channels/page.tsx` is a thin wrapper around `<RedditResearchCard />` with the settings layout chrome. Same component, different chrome.

- [ ] **Step 4: Add unit tests for the re-research endpoint**

Use the route-test pattern from `src/app/api/today/[id]/approve/__tests__/route.test.ts` as the reference:
- 401 when unauthenticated
- 404 when no product
- 200 + `enqueueRedditChannelResearch` called with `force=true` when valid

- [ ] **Step 5: Run tests**

```bash
pnpm vitest run src/app/api/reddit-channels/ src/app/api/onboarding/
```

- [ ] **Step 6: Commit**

```bash
git add src/app/api/onboarding/ src/app/api/reddit-channels/re-research/ \
        src/app/\(app\)/settings/reddit-channels/
git commit -m "feat(onboarding): trigger reddit research on commit + settings page"
```

---

## Task 9: `/today` PostCard safety net

**Why:** Future bugs in upstream still surface gracefully. No 500 path.

**Files:**
- Modify: `src/app/(app)/today/_components/post-card.tsx`
- Modify: `src/app/api/today/[id]/edit/route.ts` (or wherever plan_item.params can be patched)

### Steps

- [ ] **Step 1: Locate the PostCard render path**

```bash
grep -rn "channel.*reddit\|subreddit\|Post button" src/app/\(app\)/today/_components/
```

Per memory `[[project_today_postcard_location]]`: the live one is at `src/app/(app)/today/_components/post-card.tsx`. The other `src/components/today/post-card.tsx` is dead.

- [ ] **Step 2: Failing test**

Add a Vitest test that asserts:
- When the card's `planItem.channel === 'reddit'` AND `params.subreddit` is missing/empty → the Post button is replaced by an inline subreddit picker populated from `/api/reddit-channels`.
- Selecting a subreddit + clicking Apply patches the plan_item via PATCH `/api/today/<id>/edit` with `{ params: { subreddit } }` then renders the normal Post button.

- [ ] **Step 3: Implement the picker**

In `post-card.tsx`, branch on the missing-subreddit case. Use the same `useSWR('/api/reddit-channels', ...)` pattern. Picker is a `<select>` of active subreddits + a "Add a different one" overflow that POSTs to `/api/reddit-channels` then re-selects.

- [ ] **Step 4: Extend the edit endpoint**

`src/app/api/today/[id]/edit/route.ts` (or the actual edit endpoint — grep for it):
- Accept a `params: Partial<{ subreddit: string }>` patch
- Validate `subreddit` against `contentPostParamsSchema`
- Merge onto existing `plan_items.params`
- Return updated row

- [ ] **Step 5: Run tests, commit**

```bash
pnpm vitest run src/app/\(app\)/today/_components/__tests__/post-card.test.tsx \
                 src/app/api/today/
```

```bash
git add src/app/\(app\)/today/_components/ src/app/api/today/
git commit -m "feat(today): inline subreddit picker for reddit content_post without target"
```

---

## Task 10: Drop stuck draft + Playwright real-browser smoke test

**Why:** Per `[[feedback_playwright_real_browser_in_plans]]` — every plan ends with a real-browser test. And per the spec acceptance criteria.

**Files:**
- Create: `scripts/drop-stuck-content-post.sql`
- Create: `e2e/tests/reddit-subreddit-research.spec.ts`

### Steps

- [ ] **Step 1: Write the cleanup SQL**

`scripts/drop-stuck-content-post.sql`:

```sql
-- One-off cleanup for the 2026-05-11 stuck Reddit content_post that
-- predates the kickoff-research feature. Safe to re-run: the WHERE
-- clauses are exact-id matches.
BEGIN;

DELETE FROM drafts
WHERE plan_item_id = '233588e6-0281-4da7-9d85-9d18c48a81fb';

DELETE FROM threads
WHERE external_id = 'content-post:233588e6-0281-4da7-9d85-9d18c48a81fb';

UPDATE plan_items
SET state = 'skipped', user_action = 'skip', updated_at = now()
WHERE id = '233588e6-0281-4da7-9d85-9d18c48a81fb';

COMMIT;
```

- [ ] **Step 2: Run it locally**

```bash
psql "$DATABASE_URL" -f scripts/drop-stuck-content-post.sql
```

Verify with `SELECT state FROM plan_items WHERE id = '233588e6…'` → `skipped`.

- [ ] **Step 3: Write the Playwright spec**

`e2e/tests/reddit-subreddit-research.spec.ts`:

```ts
import { test, expect } from '@playwright/test';

test.describe('Reddit subreddit research kickoff → post', () => {
  test('founder sees top-3 in onboarding and posts to Reddit submit URL', async ({
    page,
    context,
  }) => {
    // Pre-condition: user is signed in via the persistent auth state
    // (the project's e2e config already loads a logged-in storage state).

    // 1. Visit onboarding research page
    await page.goto('/onboarding/research');
    await expect(page.getByText(/researching/i)).toBeVisible();

    // 2. Wait for at least one subreddit row to render (≤60s budget)
    const firstRow = page.locator('[data-testid="reddit-channel-row"]').first();
    await expect(firstRow).toBeVisible({ timeout: 60_000 });

    // 3. Assert 3 rows total
    await expect(page.locator('[data-testid="reddit-channel-row"]')).toHaveCount(3);

    // 4. Visit /team — kickoff fires
    await page.goto('/team');
    await expect(page.getByText(/kickoff/i).or(page.getByText(/this week/i))).toBeVisible({
      timeout: 30_000,
    });

    // 5. Visit /today — wait for a Reddit content_post to appear with a
    //    subreddit shown on the card
    await page.goto('/today');
    const redditCard = page.locator('[data-testid="post-card"][data-channel="reddit"]').first();
    await expect(redditCard).toBeVisible({ timeout: 60_000 });
    await expect(redditCard.getByText(/r\//)).toBeVisible();

    // 6. Click Post — assert a new tab opens to reddit.com/r/<sub>/submit
    const [popup] = await Promise.all([
      context.waitForEvent('page'),
      redditCard.getByRole('button', { name: /post/i }).click(),
    ]);
    expect(popup.url()).toMatch(
      /^https:\/\/www\.reddit\.com\/r\/[A-Za-z0-9_]+\/submit\?/,
    );
    expect(popup.url()).toContain('type=text');
    expect(popup.url()).toContain('title=');
    expect(popup.url()).toContain('selftext=');
  });

  test('Reddit content_post without subreddit shows inline picker, not 500', async ({
    page,
  }) => {
    // Seed via /api/__test__/seed or direct DB insert: a Reddit
    // content_post plan_item with empty params (the legacy shape).
    // (Skip this test if no seed harness is available — note as a gap.)
    await page.goto('/today');
    // Find a reddit card flagged for missing subreddit
    const picker = page
      .locator('[data-testid="post-card"][data-channel="reddit"]')
      .locator('[data-testid="subreddit-picker"]')
      .first();
    await expect(picker).toBeVisible();
    await picker.selectOption({ index: 0 });
    await page.getByRole('button', { name: /apply/i }).click();
    await expect(page.getByRole('button', { name: /post/i })).toBeVisible();
  });
});
```

- [ ] **Step 4: Run Playwright in real-browser mode**

```bash
pnpm exec playwright test e2e/tests/reddit-subreddit-research.spec.ts --headed
```

Expected: both tests PASS. If pnpm typecheck or eslint fail along the way, fix before declaring done.

- [ ] **Step 5: Commit + push**

```bash
git add scripts/drop-stuck-content-post.sql e2e/tests/reddit-subreddit-research.spec.ts
git commit -m "test(reddit): real-browser smoke for kickoff research → post"
```

- [ ] **Step 6: Final typecheck + lint**

```bash
pnpm tsc --noEmit --pretty false
pnpm eslint src/ e2e/
```

Both must exit 0.

---

## Real-browser smoke test

Already encoded in Task 10. The plan does not call itself done until Playwright passes against a live server with real xAI calls — the entire reason this feature exists is to fix a path that unit-mocked tests couldn't catch.

## Out of scope for this plan (deferred)

- Cron-based refresh of `product_reddit_channels` (see spec section "Approaches considered → E").
- Per-subreddit posting cooldowns / frequency caps.
- Multi-product UI.
- Backfilling other potentially-stuck Reddit `content_post` plan_items predating this work — Task 9's safety net catches them in the UI instead.
- X equivalent (X has no community concept).

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| CEO Review | `/plan-ceo-review` | Scope & strategy | 0 | — | — |
| Codex Review | `/codex review` | Independent 2nd opinion | 0 | — | — |
| Eng Review | `/plan-eng-review` | Architecture & tests (required) | 0 | — | — |
| Design Review | `/plan-design-review` | UI/UX gaps | 0 | — | — |
| DX Review | `/plan-devex-review` | Developer experience gaps | 0 | — | — |

**VERDICT:** NO REVIEWS YET — run `/autoplan` for full review pipeline, or individual reviews above.
