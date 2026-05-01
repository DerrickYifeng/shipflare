# Smarter Content Planner Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Teach the content-planner to read the founder's last 14 days of X timeline, derive a `metaphor_ban` list per scheduled item, and allocate plan_items across a closed 5-pillar vocabulary so weekly content stops clustering on a single metaphor.

**Architecture:** Tools-not-agents. One new tool (`query_recent_x_posts`) wraps the X-channel lookup + `XClient.getUserTweets`. `add_plan_item` gains a runtime check that validates `params` against a new `contentPostParamsSchema` when `kind='content_post'`. Content-planner gets the tool in its allowlist, bumps to sonnet-4-6, and runs a new "Pillar mix and metaphor ban" workflow step. Post-writer reads `pillar`/`theme`/`metaphor_ban` from `plan_items.params` as hard inputs alongside the existing lifecycle playbook.

**Tech Stack:** TypeScript, Zod, Drizzle (read-only), vitest. Zero DB migration. Sonnet 4.6 for the planner.

**Spec:** `docs/superpowers/specs/2026-04-29-smarter-content-planner-design.md`

---

## File Structure

| File | Action | Responsibility |
|---|---|---|
| `src/tools/schemas.ts` | Modify | Export `contentPostParamsSchema` Zod object with the 5 new optional fields. |
| `src/tools/AddPlanItemTool/AddPlanItemTool.ts` | Modify | Runtime check: when `input.kind === 'content_post'`, validate `input.params` against `contentPostParamsSchema`. |
| `src/tools/AddPlanItemTool/__tests__/AddPlanItemTool.test.ts` | Modify | New tests for the validation branch (accept valid, reject malformed). |
| `src/tools/QueryRecentXPostsTool/QueryRecentXPostsTool.ts` | Create | New tool: read user's X channel, instantiate `XClient`, call `getMe()` + `getUserTweets()`, filter by window, return shaped tweets. |
| `src/tools/QueryRecentXPostsTool/__tests__/QueryRecentXPostsTool.test.ts` | Create | Tool contract tests. Stubbed `XClient`. Covers happy path, no-channel, token-error fallback. |
| `src/tools/registry.ts` | Modify | Register `queryRecentXPostsTool`. |
| `src/tools/AgentTool/agents/content-planner/AGENT.md` | Modify | (a) `model:` haiku-4-5 → sonnet-4-6. (b) tools allowlist gains `query_recent_x_posts`. (c) one-line pointer to the new playbook section. |
| `src/tools/AgentTool/agents/content-planner/references/tactical-playbook.md` | Modify | New "Pillar mix and metaphor ban" section. |
| `src/tools/AgentTool/agents/content-planner/references/__tests__/tactical-playbook.test.ts` | Create | Structural test asserting the new section + 5 pillars + per-channel cap rule. |
| `src/tools/AgentTool/agents/content-planner/__tests__/loader-smoke.test.ts` | Modify or Create | Pin `model: 'claude-sonnet-4-6'` and assert `query_recent_x_posts` in tools list. |
| `src/tools/AgentTool/agents/post-writer/AGENT.md` | Modify | Step 3 reads `pillar`/`theme`/`metaphor_ban` from `params` as hard inputs. |
| `src/tools/AgentTool/agents/post-writer/references/x-content-guide.md` | Modify | One paragraph at top of §5 noting planner-supplied params override. |

---

## Task 1: Add `contentPostParamsSchema` to shared schemas

**Files:**
- Modify: `src/tools/schemas.ts`

- [ ] **Step 1: Append the new schema after `planItemInputSchema`**

Open `src/tools/schemas.ts`. After line 155 (`export type PlanItemInput = ...`), append:

```ts
/**
 * Content-post diversification params written by content-planner v2.
 * All fields are optional — in-flight items predating the planner v2
 * keep working unchanged. `passthrough` preserves existing keys
 * (e.g. `targetCount`, `theme` in old shape) so legacy params survive.
 */
export const contentPostParamsSchema = z
  .object({
    pillar: z
      .enum([
        'milestone',
        'lesson',
        'hot_take',
        'behind_the_scenes',
        'question',
      ])
      .optional(),
    theme: z.string().min(1).max(120).optional(),
    arc_position: z
      .object({
        index: z.number().int().min(1),
        of: z.number().int().min(1),
      })
      .optional(),
    metaphor_ban: z.array(z.string().min(1).max(40)).max(20).optional(),
    cross_refs: z.array(z.string().uuid()).max(5).optional(),
  })
  .passthrough();

export type ContentPostParams = z.infer<typeof contentPostParamsSchema>;
```

- [ ] **Step 2: Quick sanity check via tsc**

Run: `pnpm tsc --noEmit --pretty false`
Expected: exit 0. The schema is exported but not yet imported anywhere.

- [ ] **Step 3: Commit**

```bash
git add src/tools/schemas.ts
git commit -m "feat(planner): add contentPostParamsSchema for v2 diversity inputs

Five optional fields (pillar, theme, arc_position, metaphor_ban,
cross_refs) describing the diversification metadata the smarter
content-planner will write into plan_items.params for content_post
items. All optional + passthrough so existing params shapes
continue to validate. No callers wired yet."
```

---

## Task 2: Wire `contentPostParamsSchema` validation into `add_plan_item`

**Files:**
- Modify: `src/tools/AddPlanItemTool/AddPlanItemTool.ts`
- Modify: `src/tools/AddPlanItemTool/__tests__/AddPlanItemTool.test.ts`

- [ ] **Step 1: Add a failing test for the rejection case**

Open `src/tools/AddPlanItemTool/__tests__/AddPlanItemTool.test.ts`. After the last existing `it(...)` block in the main describe (find the closing `});` of the describe), add:

```ts
  it('rejects content_post params with an invalid pillar enum value', async () => {
    const ctx = makeCtx(store, { userId: 'user-1', productId: 'prod-1' });
    await expect(
      addPlanItemTool.execute(
        {
          kind: 'content_post',
          userAction: 'approve',
          phase: 'audience',
          channel: 'x',
          scheduledAt: '2026-05-01T09:00:00Z',
          skillName: 'draft-single-post',
          params: { pillar: 'definitely_not_a_pillar' },
          title: 'Test',
          description: null,
        },
        ctx,
      ),
    ).rejects.toThrow(/pillar|invalid/i);
  });

  it('rejects content_post params with metaphor_ban over the 20-item cap', async () => {
    const ctx = makeCtx(store, { userId: 'user-1', productId: 'prod-1' });
    await expect(
      addPlanItemTool.execute(
        {
          kind: 'content_post',
          userAction: 'approve',
          phase: 'audience',
          channel: 'x',
          scheduledAt: '2026-05-01T09:00:00Z',
          skillName: 'draft-single-post',
          params: {
            metaphor_ban: Array.from({ length: 21 }, (_, i) => `phrase${i}`),
          },
          title: 'Test',
          description: null,
        },
        ctx,
      ),
    ).rejects.toThrow();
  });

  it('accepts content_post params with valid pillar + theme + metaphor_ban', async () => {
    // Pre-seed a plan row so resolvePlanId succeeds.
    store.register<PlanRow>(plans, [
      {
        id: 'plan-1',
        userId: 'user-1',
        productId: 'prod-1',
        generatedAt: new Date(),
      },
    ]);
    const ctx = makeCtx(store, { userId: 'user-1', productId: 'prod-1' });
    const result = await addPlanItemTool.execute(
      {
        kind: 'content_post',
        userAction: 'approve',
        phase: 'audience',
        channel: 'x',
        scheduledAt: '2026-05-01T09:00:00Z',
        skillName: 'draft-single-post',
        params: {
          pillar: 'lesson',
          theme: 'first paying customer story',
          metaphor_ban: ['debt', 'compound', 'owe'],
        },
        title: 'Lesson: first paying customer',
        description: null,
      },
      ctx,
    );
    expect(result.planItemId).toBeTruthy();
    const rows = store.get<PlanItemRow>(planItems);
    expect(rows[0]!.params).toMatchObject({
      pillar: 'lesson',
      theme: 'first paying customer story',
      metaphor_ban: ['debt', 'compound', 'owe'],
    });
  });

  it('passes through legacy params unchanged for non-content_post kinds', async () => {
    store.register<PlanRow>(plans, [
      {
        id: 'plan-1',
        userId: 'user-1',
        productId: 'prod-1',
        generatedAt: new Date(),
      },
    ]);
    const ctx = makeCtx(store, { userId: 'user-1', productId: 'prod-1' });
    // setup_task with arbitrary params — pillar enum should NOT be enforced.
    const result = await addPlanItemTool.execute(
      {
        kind: 'setup_task',
        userAction: 'manual',
        phase: 'foundation',
        channel: null,
        scheduledAt: '2026-05-01T09:00:00Z',
        skillName: null,
        params: { foo: 'bar', pillar: 'definitely_not_a_pillar' },
        title: 'Setup',
        description: null,
      },
      ctx,
    );
    expect(result.planItemId).toBeTruthy();
  });
```

(`PlanRow` and `PlanItemRow` interfaces are already declared earlier in the test file.)

- [ ] **Step 2: Run the new tests to confirm they fail**

Run: `pnpm vitest run src/tools/AddPlanItemTool/__tests__/AddPlanItemTool.test.ts`
Expected: 2 of the 4 new tests FAIL — the "rejects invalid pillar" and "rejects oversized metaphor_ban" — because `add_plan_item` currently does NO validation of `params` shape. The "accepts valid" and "passes through legacy" likely PASS (validation is permissive today).

- [ ] **Step 3: Wire the validation into `add_plan_item`**

Open `src/tools/AddPlanItemTool/AddPlanItemTool.ts`. Find the `import { planItemInputSchema, type PlanItemInput } from '@/tools/schemas';` line and replace with:

```ts
import {
  planItemInputSchema,
  contentPostParamsSchema,
  type PlanItemInput,
} from '@/tools/schemas';
```

Then find the `async execute(input, ctx): Promise<AddPlanItemResult> {` line. Right after `const { db, userId, productId } = readDomainDeps(ctx);`, insert:

```ts
      // Content-post items get a stricter params shape (pillar enum,
      // length-capped metaphor_ban, etc.). All fields are optional, so
      // legacy callers passing { angle, theme } continue to validate.
      // Other kinds keep the permissive `z.record` shape from the input
      // schema — only content_post carries diversification metadata.
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
      }
```

- [ ] **Step 4: Run the tests to confirm they all pass**

Run: `pnpm vitest run src/tools/AddPlanItemTool/__tests__/AddPlanItemTool.test.ts`
Expected: PASS — both rejection tests now throw, both acceptance tests pass.

- [ ] **Step 5: Run typecheck**

Run: `pnpm tsc --noEmit --pretty false`
Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
git add src/tools/AddPlanItemTool/AddPlanItemTool.ts \
        src/tools/AddPlanItemTool/__tests__/AddPlanItemTool.test.ts
git commit -m "feat(planner): validate content_post params via contentPostParamsSchema

When add_plan_item is called with kind='content_post', validate the
params against contentPostParamsSchema. Catches the smarter planner
emitting an out-of-vocab pillar or oversized metaphor_ban before
the row lands in plan_items. Other kinds (setup_task, email_send,
etc.) keep the permissive z.record shape — only content_post
carries diversification metadata."
```

---

## Task 3: Create failing tests for `query_recent_x_posts`

**Files:**
- Create: `src/tools/QueryRecentXPostsTool/__tests__/QueryRecentXPostsTool.test.ts`

- [ ] **Step 1: Create the test file**

Create `src/tools/QueryRecentXPostsTool/__tests__/QueryRecentXPostsTool.test.ts`:

```ts
/**
 * query_recent_x_posts unit tests. Stubs XClient and the channels DB
 * lookup; asserts the tool's contract: shape, window filtering, and
 * the four error-fallback paths.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { ToolContext } from '@/core/types';
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
vi.mock('@/lib/db', () => ({ db: createInMemoryStore().db }));
vi.mock('@/lib/logger', () => ({
  createLogger: () => ({
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  }),
}));

// XClient.fromChannel + ensureValidToken + getMe + getUserTweets are
// stubbed via a factory so each test installs the behavior it needs.
let stubGetMe: () => Promise<{ id: string; username: string }>;
let stubGetUserTweets: (
  userId: string,
  opts: { maxResults?: number; sinceId?: string },
) => Promise<{ tweets: Array<TweetStub>; newestId?: string }>;

interface TweetStub {
  id: string;
  text: string;
  authorUsername: string;
  createdAt: string;
  metrics: {
    likes: number;
    retweets: number;
    replies: number;
    impressions: number;
  };
  referencedTweets?: Array<{ type: string; id: string }>;
}

vi.mock('@/lib/x-client', () => ({
  XClient: {
    fromChannel: () => ({
      getMe: () => stubGetMe(),
      getUserTweets: (id: string, o: { maxResults?: number }) =>
        stubGetUserTweets(id, o),
    }),
  },
}));

import { queryRecentXPostsTool } from '../QueryRecentXPostsTool';
import { channels } from '@/lib/db/schema';

interface ChannelRow {
  id: string;
  userId: string;
  platform: string;
  username: string;
  oauthTokenEncrypted: string;
  refreshTokenEncrypted: string;
  tokenExpiresAt: Date | null;
}

function makeCtx(
  store: InMemoryStore,
  deps: Record<string, unknown>,
): ToolContext {
  return {
    abortSignal: new AbortController().signal,
    get<V>(key: string): V {
      if (key in deps) return deps[key] as V;
      if (key === 'db') return store.db as unknown as V;
      throw new Error(`no dep ${key}`);
    },
  };
}

let store: InMemoryStore;
beforeEach(() => {
  store = createInMemoryStore();
  // Default stubs — happy path. Tests override per-case.
  stubGetMe = async () => ({ id: '1234567', username: 'founder' });
  stubGetUserTweets = async () => ({ tweets: [], newestId: undefined });
});

const NOW = new Date('2026-04-29T12:00:00Z').getTime();
const dayAgoIso = (days: number): string =>
  new Date(NOW - days * 86_400_000).toISOString();

describe('queryRecentXPostsTool', () => {
  it('returns empty tweets and error="no_channel" when the user has not connected X', async () => {
    store.register<ChannelRow>(channels, []);
    const ctx = makeCtx(store, { userId: 'user-1', productId: 'prod-1' });

    const result = await queryRecentXPostsTool.execute({ days: 14 }, ctx);

    expect(result.source).toBe('x_api');
    expect(result.windowDays).toBe(14);
    expect(result.tweets).toEqual([]);
    expect(result.error).toBe('no_channel');
  });

  it('returns the user\'s recent original tweets within the window', async () => {
    store.register<ChannelRow>(channels, [
      {
        id: 'ch-1',
        userId: 'user-1',
        platform: 'x',
        username: 'founder',
        oauthTokenEncrypted: 'enc-token',
        refreshTokenEncrypted: 'enc-refresh',
        tokenExpiresAt: null,
      },
    ]);
    stubGetUserTweets = async () => ({
      tweets: [
        {
          id: 't1',
          text: 'Day 47 of building. Shipped auth.',
          authorUsername: 'founder',
          createdAt: dayAgoIso(2),
          metrics: { likes: 10, retweets: 1, replies: 0, impressions: 500 },
        },
        {
          id: 't2',
          text: 'Marketing debt compounds like tech debt.',
          authorUsername: 'founder',
          createdAt: dayAgoIso(5),
          metrics: { likes: 47, retweets: 3, replies: 12, impressions: 2300 },
        },
      ],
      newestId: 't1',
    });

    const ctx = makeCtx(store, { userId: 'user-1', productId: 'prod-1' });
    const result = await queryRecentXPostsTool.execute({ days: 14 }, ctx);

    expect(result.error).toBeUndefined();
    expect(result.tweets).toHaveLength(2);
    expect(result.tweets[0]).toMatchObject({
      tweetId: 't1',
      kind: 'original',
      body: 'Day 47 of building. Shipped auth.',
      metrics: { likes: 10, retweets: 1, replies: 0, impressions: 500 },
    });
    expect(result.tweets[1].body).toBe(
      'Marketing debt compounds like tech debt.',
    );
  });

  it('marks tweets with referenced_tweets[?].type==="replied_to" as kind="reply"', async () => {
    store.register<ChannelRow>(channels, [
      {
        id: 'ch-1',
        userId: 'user-1',
        platform: 'x',
        username: 'founder',
        oauthTokenEncrypted: 'enc',
        refreshTokenEncrypted: 'enc',
        tokenExpiresAt: null,
      },
    ]);
    stubGetUserTweets = async () => ({
      tweets: [
        {
          id: 'r1',
          text: 'agreed — what worked for us was X',
          authorUsername: 'founder',
          createdAt: dayAgoIso(1),
          metrics: { likes: 2, retweets: 0, replies: 0, impressions: 50 },
          referencedTweets: [{ type: 'replied_to', id: '99999' }],
        },
      ],
    });

    const ctx = makeCtx(store, { userId: 'user-1', productId: 'prod-1' });
    const result = await queryRecentXPostsTool.execute({ days: 14 }, ctx);
    expect(result.tweets[0].kind).toBe('reply');
  });

  it('filters out tweets older than the window', async () => {
    store.register<ChannelRow>(channels, [
      {
        id: 'ch-1',
        userId: 'user-1',
        platform: 'x',
        username: 'founder',
        oauthTokenEncrypted: 'enc',
        refreshTokenEncrypted: 'enc',
        tokenExpiresAt: null,
      },
    ]);
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW));
    stubGetUserTweets = async () => ({
      tweets: [
        {
          id: 'in-window',
          text: 'recent',
          authorUsername: 'founder',
          createdAt: dayAgoIso(5),
          metrics: { likes: 0, retweets: 0, replies: 0, impressions: 0 },
        },
        {
          id: 'too-old',
          text: 'ancient',
          authorUsername: 'founder',
          createdAt: dayAgoIso(20),
          metrics: { likes: 0, retweets: 0, replies: 0, impressions: 0 },
        },
      ],
    });

    const ctx = makeCtx(store, { userId: 'user-1', productId: 'prod-1' });
    const result = await queryRecentXPostsTool.execute({ days: 14 }, ctx);
    vi.useRealTimers();

    expect(result.tweets.map((t) => t.tweetId)).toEqual(['in-window']);
  });

  it('returns error="token_invalid" when XClient throws on auth', async () => {
    store.register<ChannelRow>(channels, [
      {
        id: 'ch-1',
        userId: 'user-1',
        platform: 'x',
        username: 'founder',
        oauthTokenEncrypted: 'enc',
        refreshTokenEncrypted: 'enc',
        tokenExpiresAt: null,
      },
    ]);
    stubGetMe = async () => {
      throw new Error('Unauthorized: token expired');
    };

    const ctx = makeCtx(store, { userId: 'user-1', productId: 'prod-1' });
    const result = await queryRecentXPostsTool.execute({ days: 14 }, ctx);

    expect(result.tweets).toEqual([]);
    expect(result.error).toBe('token_invalid');
  });

  it('rejects out-of-range `days` via the schema', () => {
    const parse = queryRecentXPostsTool.inputSchema.safeParse({ days: 999 });
    expect(parse.success).toBe(false);
  });

  it('defaults `days` to 14 when omitted', () => {
    const parse = queryRecentXPostsTool.inputSchema.safeParse({});
    expect(parse.success).toBe(true);
    if (parse.success) {
      expect(parse.data.days).toBe(14);
    }
  });
});
```

- [ ] **Step 2: Run the test file to confirm it fails (the tool doesn't exist yet)**

Run: `pnpm vitest run src/tools/QueryRecentXPostsTool/__tests__/QueryRecentXPostsTool.test.ts`
Expected: FAIL — `Cannot find module '../QueryRecentXPostsTool'`. The import fails before any `it()` runs.

- [ ] **Step 3: Commit the failing test scaffold**

```bash
git add src/tools/QueryRecentXPostsTool/__tests__/QueryRecentXPostsTool.test.ts
git commit -m "test(planner): scaffold for query_recent_x_posts tool

Tests the contract: shape returned to the planner, window filtering,
reply-tag detection, and the no_channel / token_invalid fallback
paths. Currently failing — Task 4 implements the tool."
```

---

## Task 4: Implement `query_recent_x_posts` and register it

**Files:**
- Create: `src/tools/QueryRecentXPostsTool/QueryRecentXPostsTool.ts`
- Modify: `src/tools/registry.ts`

- [ ] **Step 1: Create the tool**

Create `src/tools/QueryRecentXPostsTool/QueryRecentXPostsTool.ts`:

```ts
// query_recent_x_posts — return the founder's last N days of X tweets.
//
// Wraps XClient.getMe + getUserTweets and shapes the result for the
// content-planner. The planner reads bodies + engagement metrics and
// derives metaphor_ban for each plan_item it's about to add.
//
// Auth: looks up the user's X channel via standard channels query,
// instantiates XClient via XClient.fromChannel (the sanctioned helper
// for already-loaded channel rows). When the user has no X channel or
// the token refresh fails, the tool returns { tweets: [], error } so
// the planner can proceed without metaphor_ban.

import { z } from 'zod';
import { and, eq } from 'drizzle-orm';
import { buildTool } from '@/core/tool-system';
import type { ToolDefinition } from '@/core/types';
import { channels } from '@/lib/db/schema';
import { readDomainDeps } from '@/tools/context-helpers';
import { XClient } from '@/lib/x-client';

export const QUERY_RECENT_X_POSTS_TOOL_NAME = 'query_recent_x_posts';

export const queryRecentXPostsInputSchema = z
  .object({
    days: z.number().int().min(1).max(60).default(14),
  })
  .strict();

export type QueryRecentXPostsInput = z.infer<
  typeof queryRecentXPostsInputSchema
>;

export interface QueryRecentXPostsTweet {
  tweetId: string;
  date: string;
  kind: 'original' | 'reply';
  body: string;
  metrics: {
    likes: number;
    retweets: number;
    replies: number;
    impressions: number;
  };
}

export type QueryRecentXPostsError =
  | 'no_channel'
  | 'token_invalid'
  | 'rate_limited'
  | 'api_error';

export interface QueryRecentXPostsResult {
  source: 'x_api';
  windowDays: number;
  tweets: QueryRecentXPostsTweet[];
  error?: QueryRecentXPostsError;
}

function classifyError(err: unknown): QueryRecentXPostsError {
  const message =
    err instanceof Error ? err.message.toLowerCase() : String(err).toLowerCase();
  if (message.includes('unauthorized') || message.includes('token')) {
    return 'token_invalid';
  }
  if (message.includes('rate') || message.includes('429')) {
    return 'rate_limited';
  }
  return 'api_error';
}

export const queryRecentXPostsTool: ToolDefinition<
  QueryRecentXPostsInput,
  QueryRecentXPostsResult
> = buildTool({
  name: QUERY_RECENT_X_POSTS_TOOL_NAME,
  description:
    "Return the founder's last N days (default 14) of X tweets — both " +
    'original posts and replies — with engagement metrics. The ' +
    'content-planner uses this to derive metaphor_ban and pick a ' +
    'pillar mix for the upcoming week. Returns { tweets: [], error } ' +
    'when the user has no X channel or the token is invalid; the ' +
    'planner should proceed without metaphor_ban in that case.',
  inputSchema: queryRecentXPostsInputSchema,
  isConcurrencySafe: true,
  isReadOnly: true,
  async execute(input, ctx): Promise<QueryRecentXPostsResult> {
    const { db, userId } = readDomainDeps(ctx);
    const windowDays = input.days;

    // 1. Find the user's X channel.
    const channelRows = await db
      .select()
      .from(channels)
      .where(and(eq(channels.userId, userId), eq(channels.platform, 'x')))
      .limit(1);

    if (channelRows.length === 0) {
      return {
        source: 'x_api',
        windowDays,
        tweets: [],
        error: 'no_channel',
      };
    }

    // 2. Instantiate XClient from the channel row.
    let xClient;
    try {
      xClient = XClient.fromChannel(
        channelRows[0] as Parameters<typeof XClient.fromChannel>[0],
      );
    } catch (err) {
      return {
        source: 'x_api',
        windowDays,
        tweets: [],
        error: classifyError(err),
      };
    }

    // 3. Resolve the user's numeric X id, then fetch recent tweets.
    let me: Awaited<ReturnType<XClient['getMe']>>;
    let result: Awaited<ReturnType<XClient['getUserTweets']>>;
    try {
      me = await xClient.getMe();
      result = await xClient.getUserTweets(me.id, { maxResults: 30 });
    } catch (err) {
      return {
        source: 'x_api',
        windowDays,
        tweets: [],
        error: classifyError(err),
      };
    }

    // 4. Filter to the window and shape for the planner.
    const cutoff = Date.now() - windowDays * 86_400_000;
    const tweets: QueryRecentXPostsTweet[] = result.tweets
      .filter((t) => new Date(t.createdAt).getTime() >= cutoff)
      .map((t) => ({
        tweetId: t.id,
        date: t.createdAt,
        kind: t.referencedTweets?.some((r) => r.type === 'replied_to')
          ? ('reply' as const)
          : ('original' as const),
        body: t.text,
        metrics: {
          likes: t.metrics?.likes ?? 0,
          retweets: t.metrics?.retweets ?? 0,
          replies: t.metrics?.replies ?? 0,
          impressions: t.metrics?.impressions ?? 0,
        },
      }));

    return { source: 'x_api', windowDays, tweets };
  },
});
```

- [ ] **Step 2: Register the tool in `tools/registry.ts`**

Open `src/tools/registry.ts`. Find the existing import block and add (alphabetical-ish, near other Query* tools):

```ts
import { queryRecentXPostsTool } from './QueryRecentXPostsTool/QueryRecentXPostsTool';
```

Then find the registration block (the `registry.register(...)` calls) and add (near `queryRecentMilestonesTool`):

```ts
registry.register(queryRecentXPostsTool);
```

- [ ] **Step 3: Run the tool tests**

Run: `pnpm vitest run src/tools/QueryRecentXPostsTool/__tests__/QueryRecentXPostsTool.test.ts`
Expected: PASS — all 7 tests green.

- [ ] **Step 4: Run typecheck**

Run: `pnpm tsc --noEmit --pretty false`
Expected: exit 0.

- [ ] **Step 5: Verify the tool is registered (no separate test, just sanity check)**

Run: `grep -n "queryRecentXPostsTool" src/tools/registry.ts`
Expected: at least one import line and one `registry.register(...)` line.

- [ ] **Step 6: Commit**

```bash
git add src/tools/QueryRecentXPostsTool/QueryRecentXPostsTool.ts \
        src/tools/registry.ts
git commit -m "feat(planner): query_recent_x_posts tool

Wraps XClient.getMe + getUserTweets, returns the user's last N days
of X tweets (default 14, max 60) with engagement metrics. Detects
replies via referenced_tweets[?].type==='replied_to'. Fails soft
when the user has no X channel or the token is invalid — returns
{ tweets: [], error } so the content-planner can proceed without
metaphor_ban derivation."
```

---

## Task 5: Bump content-planner model + add tool to allowlist

**Files:**
- Modify: `src/tools/AgentTool/agents/content-planner/AGENT.md`
- Modify or Create: `src/tools/AgentTool/agents/content-planner/__tests__/loader-smoke.test.ts`

- [ ] **Step 1: Check whether a loader-smoke test already exists**

Run: `ls src/tools/AgentTool/agents/content-planner/__tests__/ 2>/dev/null`
- If the directory exists with `loader-smoke.test.ts`: open it. Use Edit to update the model pin and tools assertion (Step 2a).
- If the directory does NOT exist: create the file with the full content in Step 2b.

- [ ] **Step 2a (if file exists): Update the model pin and add tool assertion**

Find the line `expect(planner.model).toBe('claude-haiku-4-5-20251001');` (or similar) and change to:

```ts
expect(planner.model).toBe('claude-sonnet-4-6');
```

Find the `expect(planner.tools).toEqual([...])` assertion (or add one if missing) and update it to include `'query_recent_x_posts'`. The full expected list should be:

```ts
expect(planner.tools).toEqual([
  'add_plan_item',
  'update_plan_item',
  'query_recent_milestones',
  'query_stalled_items',
  'query_last_week_completions',
  'query_strategic_path',
  'query_recent_x_posts',
  'Task',
  'SendMessage',
  'StructuredOutput',
]);
```

- [ ] **Step 2b (if file does not exist): Create it**

Create `src/tools/AgentTool/agents/content-planner/__tests__/loader-smoke.test.ts`:

```ts
// Smoke test: content-planner AGENT.md loads via the canonical loader
// path with its tactical-playbook reference inlined. Pins the model
// and the tools allowlist so accidental regression on the planner
// upgrade is caught at CI.

import { describe, it, expect } from 'vitest';
import * as path from 'node:path';
import { loadAgentsDir } from '@/tools/AgentTool/loader';

const AGENTS_ROOT = path.resolve(
  process.cwd(),
  'src/tools/AgentTool/agents',
);

describe('content-planner loader smoke', () => {
  it('loads with sonnet-4.6 model and the new query_recent_x_posts tool', async () => {
    const agents = await loadAgentsDir(AGENTS_ROOT);
    const planner = agents.find((a) => a.name === 'content-planner');
    expect(planner).toBeDefined();
    if (!planner) return;

    expect(planner.model).toBe('claude-sonnet-4-6');
    expect(planner.tools).toEqual([
      'add_plan_item',
      'update_plan_item',
      'query_recent_milestones',
      'query_stalled_items',
      'query_last_week_completions',
      'query_strategic_path',
      'query_recent_x_posts',
      'Task',
      'SendMessage',
      'StructuredOutput',
    ]);

    expect(planner.systemPrompt).toContain('## tactical-playbook');
  });
});
```

- [ ] **Step 3: Run the test to confirm it fails**

Run: `pnpm vitest run src/tools/AgentTool/agents/content-planner/__tests__/loader-smoke.test.ts`
Expected: FAIL — model is currently `claude-haiku-4-5-20251001` and tool list doesn't include `query_recent_x_posts`.

- [ ] **Step 4: Update content-planner AGENT.md frontmatter**

Open `src/tools/AgentTool/agents/content-planner/AGENT.md`. Change line 4 from:

```
model: claude-haiku-4-5-20251001
```

To:

```
model: claude-sonnet-4-6
```

Then find the `tools:` block and add `- query_recent_x_posts` so the full block reads:

```yaml
tools:
  - add_plan_item
  - update_plan_item
  - query_recent_milestones
  - query_stalled_items
  - query_last_week_completions
  - query_strategic_path
  - query_recent_x_posts
  - Task
  - SendMessage
  - StructuredOutput
```

- [ ] **Step 5: Run the test again**

Run: `pnpm vitest run src/tools/AgentTool/agents/content-planner/__tests__/loader-smoke.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/tools/AgentTool/agents/content-planner/AGENT.md \
        src/tools/AgentTool/agents/content-planner/__tests__/
git commit -m "feat(planner): bump content-planner to sonnet-4.6 + add x-posts tool

Sonnet's instruction-following is needed for pillar-mix balancing +
metaphor extraction over the user's recent X timeline. Tools
allowlist gains query_recent_x_posts so the planner can read recent
posts before scheduling the week. Loader-smoke test pins both."
```

---

## Task 6: Add structural test scaffold for tactical-playbook pillar-mix section

**Files:**
- Create: `src/tools/AgentTool/agents/content-planner/references/__tests__/tactical-playbook.test.ts`

- [ ] **Step 1: Create the test file**

Create `src/tools/AgentTool/agents/content-planner/references/__tests__/tactical-playbook.test.ts`:

```ts
// Structural tests for the tactical-playbook reference. The smarter
// content-planner relies on a "Pillar mix and metaphor ban" section
// that lists the closed 5-pillar vocabulary and the per-channel cap
// rule. These tests catch accidental section deletion or rewording
// that would silently break the planner's instructions.

import { describe, it, expect, beforeAll } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

const PLAYBOOK_PATH = path.resolve(
  process.cwd(),
  'src/tools/AgentTool/agents/content-planner/references/tactical-playbook.md',
);

const PILLARS = [
  'milestone',
  'lesson',
  'hot_take',
  'behind_the_scenes',
  'question',
] as const;

describe('tactical-playbook.md structural integrity', () => {
  let playbook: string;
  beforeAll(async () => {
    playbook = await fs.readFile(PLAYBOOK_PATH, 'utf-8');
  });

  it('contains a "Pillar mix and metaphor ban" section', () => {
    expect(playbook).toMatch(/##\s+Pillar mix and metaphor ban/i);
  });

  it('lists all 5 pillars verbatim in the new section', () => {
    for (const pillar of PILLARS) {
      expect(playbook).toContain(pillar);
    }
  });

  it('states the per-channel hard cap rule', () => {
    // The cap is "≤ 2 of any pillar per channel" — accept either the
    // ≤ glyph or the ASCII "<= 2" / "max 2".
    expect(playbook).toMatch(/(≤\s*2|max\s*2|<=\s*2).*per channel/i);
  });

  it('references the query_recent_x_posts tool by name', () => {
    expect(playbook).toContain('query_recent_x_posts');
  });

  it('mentions the 14-day look-back window', () => {
    expect(playbook).toMatch(/14[-\s]?days?|days:\s*14/i);
  });
});
```

- [ ] **Step 2: Run the test to confirm it fails**

Run: `pnpm vitest run src/tools/AgentTool/agents/content-planner/references/__tests__/tactical-playbook.test.ts`
Expected: FAIL on all 5 — the section doesn't exist yet.

- [ ] **Step 3: Commit the failing test**

```bash
git add src/tools/AgentTool/agents/content-planner/references/__tests__/tactical-playbook.test.ts
git commit -m "test(planner): structural test for pillar-mix playbook section

Asserts the new 'Pillar mix and metaphor ban' section, all 5
pillars verbatim, the per-channel hard cap rule, the
query_recent_x_posts tool reference, and the 14-day window.
Currently failing — Task 7 adds the playbook content."
```

---

## Task 7: Add "Pillar mix and metaphor ban" section to tactical-playbook + update content-planner workflow

**Files:**
- Modify: `src/tools/AgentTool/agents/content-planner/references/tactical-playbook.md`
- Modify: `src/tools/AgentTool/agents/content-planner/AGENT.md`

- [ ] **Step 1: Append the new section to the playbook**

Open `src/tools/AgentTool/agents/content-planner/references/tactical-playbook.md`. Append at the end of the file:

````markdown

## Pillar mix and metaphor ban

The planner balances the week's `content_post` items across a closed
**5-pillar vocabulary** AND derives a per-item `metaphor_ban` from the
founder's recent X timeline so consecutive posts don't recycle the
same idea wearing different hats.

### The 5 pillars

| Pillar | What it is | When to pick |
|---|---|---|
| `milestone` | Concrete shipped thing or revenue/user number with proof. | Real numbers exist this week (revenue update, user count, feature shipped, fundraise). |
| `lesson` | One specific takeaway from a recent failure / win, generalizable to other founders. | Founder hit something that generalizes. |
| `hot_take` | Contrarian opinion on the indie meta with a defensible position. | Founder has a strong view and the audience is mature enough. |
| `behind_the_scenes` | Process / workflow / decision the audience doesn't normally see. | Build state, kill decisions, hiring, tooling choices. |
| `question` | Genuine ask the founder needs answered, audience can reply usefully. | Real choice in front of the founder. |

**Hard rule — pillar cap:** at most **≤ 2 of any pillar per channel**
in a 7-day window. X and Reddit are independent audiences, so running
`milestone` twice on each is fine. The cap is `≤ 2 per pillar`, NOT
`≥ 1 of each` — empty pillars are fine when input is missing.

**Naming note:** plan_item `pillar` (this 5-cluster vocabulary, drives
post shape) is distinct from `strategic_paths.contentPillars` (3-4
free-form narrative themes set during onboarding, drives `theme`
selection). Both can coexist on a plan_item.

### Workflow step 2.5 — Read X timeline and derive diversity inputs

After step 2 (`query_strategic_path`), before scheduling items:

**a. Call `query_recent_x_posts({ days: 14 })`.**

If `tweets[].length > 0`:
- Read every `body`. Identify 3–5 dominant metaphors / opening
  phrases / closing phrases used in the last 14 days.
- Note which metaphors correlated with high engagement
  (`metrics.likes + metrics.retweets * 3 > median across the
  returned set`). Lean into those when picking pillars/themes for
  the week. Flag the rest for the ban.

If the tool returns `error: 'no_channel'` or `error: 'token_invalid'`:
- Proceed without metaphor_ban. Surface the error in your `notes`
  output.

**b. For each plan_item to be added this week:**

- Pick `pillar` from `{milestone | lesson | hot_take |
  behind_the_scenes | question}`. **Hard cap: max 2 of any pillar per
  channel** across the week's content_post items. Use the
  strategic-path's `contentPillars` library as a HINT for `theme`
  selection, NOT as a substitute for `pillar` selection.
- Pick `theme`: a concrete topic phrase (e.g. "first paying customer
  story", "killing feature X", "Stripe webhook gotcha"). Each item
  this week gets a distinct theme.
- Compute `metaphor_ban`: union of (metaphors extracted in step a) +
  (themes/key phrases of sibling plan_items already added in this
  turn). Cap at 20 phrases per item.
- Set `arc_position` to `{index, of}` reflecting placement in the
  week.
- Optional `cross_refs`: include only when the arc calls for an
  explicit callback (e.g. "Mon: shipped X. Wed: lesson from X." →
  Wed item cross_refs Mon's id).

**c. Persist via `add_plan_item`** with the enriched `params`. The
tool validates the new fields against `contentPostParamsSchema` —
out-of-vocab pillars and oversized arrays are hard rejects.

### What to ban specifically

Examples of phrases that get into `metaphor_ban` after the user has
posted them recently:
- Concrete metaphors: `"debt"`, `"compound"`, `"owe"`, `"interest"`
  (when used metaphorically not literally)
- Stock openers: `"shipped X on a"`, `"told nobody for"`,
  `"daily posting isn't a"`
- Stock closers: `"ship first, tell second"`, `"that's the gap"`

The planner LLM extracts these from the bodies — no n-gram counter,
no embedding model. Trust the read.

### When the timeline is empty

- New user, zero recent tweets → `metaphor_ban: []` for every item.
  Pillar mix still applies.
- User connected X but hasn't posted → same. Pillar mix only.

The smarter planner gets MORE valuable as the founder's history
grows, but it works on day 1 with empty input.
````

- [ ] **Step 2: Update content-planner AGENT.md to reference the new step**

Open `src/tools/AgentTool/agents/content-planner/AGENT.md`. Find the workflow section (search for "Your workflow" or the numbered steps). Insert a new step between the existing "read strategic path" step and the "schedule items" step. The exact text to insert depends on the current file structure — find the step that calls `query_strategic_path` and add after it:

```markdown
### Step 2.5: Diversity inputs (X timeline + pillar mix)

Before scheduling content_post items, read the last 14 days of the
founder's X timeline and prepare diversification metadata. See
**tactical-playbook §"Pillar mix and metaphor ban"** for the full
rules — the short version:

1. Call `query_recent_x_posts({ days: 14 })`.
2. Identify 3–5 dominant metaphors / opening phrases used recently.
3. For each `content_post` item you're about to add, set:
   - `params.pillar` from {milestone, lesson, hot_take,
     behind_the_scenes, question} — max 2 of any pillar per channel
     this week.
   - `params.theme` — a concrete topic phrase, distinct from
     siblings.
   - `params.metaphor_ban` — phrases the writer must avoid (≤ 20).
   - `params.arc_position` — {index, of} for the week.

When `query_recent_x_posts` returns `error`, proceed without
metaphor_ban and surface the error in your final `notes`.
```

- [ ] **Step 3: Run the playbook structural tests**

Run: `pnpm vitest run src/tools/AgentTool/agents/content-planner/references/__tests__/tactical-playbook.test.ts`
Expected: PASS — all 5 assertions green.

- [ ] **Step 4: Run the loader-smoke test**

Run: `pnpm vitest run src/tools/AgentTool/agents/content-planner/__tests__/loader-smoke.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/tools/AgentTool/agents/content-planner/references/tactical-playbook.md \
        src/tools/AgentTool/agents/content-planner/AGENT.md
git commit -m "feat(planner): pillar mix + metaphor ban playbook + workflow step 2.5

Adds the closed 5-pillar vocabulary (milestone / lesson / hot_take /
behind_the_scenes / question), the per-channel cap rule (≤ 2 per
pillar per channel per week), and the metaphor-ban derivation
workflow that reads query_recent_x_posts. AGENT.md gets a new
workflow step 2.5 pointing at the playbook section."
```

---

## Task 8: Update post-writer to read pillar / theme / metaphor_ban from params

**Files:**
- Modify: `src/tools/AgentTool/agents/post-writer/AGENT.md`
- Modify: `src/tools/AgentTool/agents/post-writer/references/x-content-guide.md`

- [ ] **Step 1: Update post-writer AGENT.md workflow step 3**

Open `src/tools/AgentTool/agents/post-writer/AGENT.md`. Find the X-drafting paragraph in workflow step 3 (it currently includes "Read `phase` from the plan_item row" from the earlier lifecycle work). After the phase paragraph and before the Reddit paragraph, insert:

```markdown

   For X drafts, the plan_item's `params` may also carry
   diversification inputs from content-planner v2:

   - `params.pillar` — narrows the post-type list from
     x-content-guide §5 (e.g. `pillar='lesson'` → use lesson
     templates only, not the full per-phase post-type list).
   - `params.theme` — the concrete topic. Anchor the post on this;
     do NOT drift into adjacent topics.
   - `params.metaphor_ban` — phrases the planner has flagged as
     recently overused on this user's timeline. Treat as **hard
     exclusions**: rewrite the draft if it contains any banned
     phrase or its close synonym (e.g. "debt" banned →
     also avoid "owe", "compound interest").
   - `params.cross_refs` — when set, look up those plan_items via
     `query_plan_items` and lead with a callback ("yesterday I
     shipped X — today's the part I didn't tell you").

   When `params` is empty (in-flight items predating the planner v2),
   fall back to the lifecycle playbook defaults — same behavior as
   today.
```

- [ ] **Step 2: Add the §5 preamble note to x-content-guide.md**

Open `src/tools/AgentTool/agents/post-writer/references/x-content-guide.md`. Find the heading `## 5. By-phase playbook`. Immediately after that header (before the existing "This is the heart of the guide" intro paragraph), insert:

```markdown
**Planner-supplied params override.** When the plan_item's
`params.pillar` is set (one of `milestone | lesson | hot_take |
behind_the_scenes | question`), narrow this section's post-type list
to that pillar. When `params.theme` is set, that's the topic —
don't drift. When `params.metaphor_ban` is set, treat each phrase as
a hard exclusion plus close synonyms. These planner inputs are
HARD inputs, not suggestions; the per-phase rules below apply
within that frame.

```

(Note: the heading stays as `## 5. By-phase playbook` — we're inserting before the existing intro, not changing the header.)

- [ ] **Step 3: Run the post-writer test suite to confirm nothing broke**

Run: `pnpm vitest run src/tools/AgentTool/agents/post-writer/`
Expected: PASS — all 11 existing tests still green. The structural test for x-content-guide doesn't assert on the new preamble, so it stays green.

- [ ] **Step 4: Run typecheck**

Run: `pnpm tsc --noEmit --pretty false`
Expected: exit 0.

- [ ] **Step 5: Commit**

```bash
git add src/tools/AgentTool/agents/post-writer/AGENT.md \
        src/tools/AgentTool/agents/post-writer/references/x-content-guide.md
git commit -m "feat(post-writer): read pillar/theme/metaphor_ban from plan_items.params

Workflow step 3 now treats planner-supplied diversification params
as hard inputs alongside the lifecycle playbook. metaphor_ban is a
hard exclusion (with close synonyms). When params is empty (legacy
items), fall back to the existing per-phase defaults — no
behavior regression for in-flight rows."
```

---

## Task 9: Final verification + manual smoke pass record

**Files:**
- None (verification only)

- [ ] **Step 1: Run the full test suite**

Run: `pnpm vitest run`
Expected: ALL tests PASS (except the pre-existing FindThreadsTool failure flagged on the previous branch — unrelated to this plan).

- [ ] **Step 2: Run typecheck**

Run: `pnpm tsc --noEmit --pretty false`
Expected: exit 0.

- [ ] **Step 3: Manual smoke pass — record planner output for one week**

Run the content-planner against an account with 14 days of
"marketing debt"-flavored history. Capture the following from the
planner's output and the resulting `plan_items.params`:

| Check | Expected |
|---|---|
| `query_recent_x_posts` was called once | yes |
| `tweets[].length > 0` for the test account | yes |
| Each `content_post` plan_item has `params.pillar` set | yes |
| Pillar mix across the week, per channel | ≤ 2 of any pillar |
| Each `content_post` has `params.theme` (distinct per item) | yes |
| `params.metaphor_ban` contains the recurring phrase from history (e.g. "debt") | yes |
| Drafts produced by post-writer for those items | DO NOT echo banned metaphors |

Document the output (one paragraph + the params from 3-5 plan_items)
in the PR description.

- [ ] **Step 4: Smoke pass for the no-X-channel case**

Run the planner against an account with no X channel connected.
Expected:
- `query_recent_x_posts` returns `{ tweets: [], error: 'no_channel' }`
- Planner proceeds, sets pillar mix anyway, leaves `metaphor_ban`
  empty or `[]` on each item
- Planner's `notes` mentions the missing channel

- [ ] **Step 5: No commit (verification only)**

This task produces no code changes — its output is the manual smoke
record in the PR description.

---

## Self-review

**Spec coverage:**

| Spec section | Covered by |
|---|---|
| `query_recent_x_posts` tool — source, contract, edge cases | Tasks 3 + 4 |
| `contentPostParamsSchema` — 5 optional fields | Task 1 |
| AddPlanItemTool validation branch | Task 2 |
| Pillar vocabulary (5 pillars, per-channel cap) | Task 7 (playbook), Task 1 (schema enum) |
| Content-planner workflow step 2.5 | Task 7 |
| Content-planner model bump to sonnet-4-6 | Task 5 |
| Tools allowlist gains query_recent_x_posts | Task 5 |
| Post-writer reads new params | Task 8 |
| x-content-guide §5 preamble note | Task 8 |
| Structural tests for tool, schema, playbook, AGENT | Tasks 2, 3, 5, 6 |
| Manual smoke pass | Task 9 |
| What does NOT change (no migration, no new agents) | Verified by tests passing without schema/migration changes |

No spec gaps.

**Placeholder scan:** No `TBD`, `TODO`, `implement later`, or `Similar to Task N` references. Each task carries verbatim content. Task 5 Step 1 uses a conditional ("if file exists" / "if not") because the loader-smoke test for content-planner may or may not exist — both branches give complete content.

**Type consistency:**
- `contentPostParamsSchema` field names match throughout (`pillar`, `theme`, `arc_position`, `metaphor_ban`, `cross_refs`).
- 5 pillar enum values match the spec, the schema, the playbook, and the AGENT.md text.
- `query_recent_x_posts` tool name spelled identically in the schema, registry, AGENT.md tools list, playbook, and tests.
- `QueryRecentXPostsResult` interface matches the contract used in the tests.
- The `error` enum (`'no_channel' | 'token_invalid' | 'rate_limited' | 'api_error'`) is consistent across spec, tool implementation, and tests.
