# Reddit channel via full-handoff (no OAuth) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Open Reddit as a channel without depending on Reddit's OAuth app approval. The user enters their u/handle manually; ShipFlare runs discovery + drafting fully via xAI Grok web_search restricted to reddit.com; at approval time top-level posts route to Reddit's official `/r/<sub>/submit` URL with pre-filled fields, and replies route to a ShipFlare-owned handoff page that writes the reply to the clipboard and opens the thread URL. Status transitions to `handed_off` (terminal, trusted). Make Reddit the first ShipFlare channel where ALL artifact types are handoffs.

**Architecture:** Reuse 90% of existing infrastructure. Extend `FindThreadsViaXaiTool` with a `platform` parameter (xAI Responses API call shape unchanged; only `tools[]`, prompt, and JSON schema branch by platform). Mirror the X-reply handoff pattern in `dispatchApprove` for both Reddit posts and replies. Make `channels.oauth_token_encrypted` and `refresh_token_encrypted` nullable so Reddit channels persist u/handle without tokens. `RedditClient.appOnly()` covers all read paths; direct-post code paths in `posting.ts` are unreachable for Reddit because dispatch always returns `kind: 'handoff'`.

**Tech Stack:** Next.js 15 App Router, Drizzle ORM (Postgres + drizzle-kit migrations), xAI Grok Responses API (`grok-4.20-non-reasoning` + `web_search` server-tool with `allowed_domains: ['reddit.com']`), BullMQ workers, Vitest, Playwright.

**Spec reference:** `docs/superpowers/specs/2026-05-07-reddit-channel-handoff-design.md`

---

## Open architectural decisions (resolve at task start, not mid-implementation)

These are concerns identified during plan-eng-review that the spec did not lock down. The plan implements the **recommended** option in each case; flag at task start if a different choice is made.

1. **Handoff status transition timing** — Spec says page-hit flips to `handed_off`. **Recommendation: flip on first explicit user action** (click "Open Reddit thread" or "Copy reply"). If user opens the page and closes the tab, status stays `pending` and the existing 24h stale-sweeper ages it out (already shipped 2026-05-06). Page-hit causes false-positive throttle and analytics. Plan implements button-click semantics in Task 5.
2. **Discovery filter for founder's own u/handle** (gap not in spec) — Existing `find_threads_via_xai` has `excludeAuthors` (authors we already replied to) but no "exclude posts authored BY the founder themselves." On Reddit, founders post pain in r/SaaS asking for help — same shape as ICP. Without a filter, ShipFlare surfaces user's own posts as candidates. Plan adds `excludeSelfHandle` injection in Task 2; applies to X discovery as a side-benefit.
3. **`/api/reddit/callback` hard-delete vs graceful redirect** — Spec says delete the route. **Recommendation: keep the route, return 308 redirect to `/onboarding?reconnect=reddit`** with a flash message. Avoids 404s for users with bookmarks or in-flight redirects. Plan Task 6 implements graceful redirect.
4. **Verify-handle button required vs optional** — Spec says optional (Premise 5). **Recommendation: keep optional but show a soft block on submit if unverified.** Catches typos without OAuth-level friction. Plan Task 6 implements soft-block.
5. **`channels.connection_type` enum vs null-token discriminator** — Spec uses null tokens as the discriminator. **Recommendation: stay with null** for this sprint; revisit when a third platform with mixed OAuth/handoff lands.

---

## File Structure

**Create:**
- `src/lib/reddit-intent-url.ts` — `buildRedditSubmitUrl()` (Task 4a)
- `src/lib/reddit-handoff-url.ts` — `buildRedditHandoffPageUrl()` (Task 4a)
- `src/lib/__tests__/reddit-intent-url.test.ts` (Task 4a)
- `src/lib/__tests__/reddit-handoff-url.test.ts` (Task 4a)
- `src/tools/FindThreadsViaXaiTool/prompt-builders.ts` — extracted X + new Reddit builders (Task 2a)
- `src/tools/FindThreadsViaXaiTool/schemas.ts` — extracted X + new Reddit response schemas (Task 2a)
- `src/skills/validating-draft/references/reddit-review-rules.md` (Task 3a)
- `src/app/(app)/handoff/reddit/[draftId]/page.tsx` — server route (Task 5a)
- `src/app/(app)/handoff/reddit/[draftId]/_components/handoff-client.tsx` — client clipboard UX (Task 5b)
- `src/app/api/draft/[id]/handoff-confirm/route.ts` — POST endpoint that flips status (Task 5c)
- `src/app/api/reddit/verify-handle/route.ts` — POST endpoint hitting `getUserAboutPublic()` (Task 6a)
- `src/components/onboarding/reddit-handle-input.tsx` — controlled input + verify button (Task 6b)
- `src/lib/db/migrations/<NNNN>_channels_nullable_tokens.sql` — exact filename from drizzle-kit (Task 1)
- `e2e/tests/reddit-handoff.spec.ts` — Playwright real-browser smoke (Task 8)

**Modify:**
- `src/lib/db/schema/channels.ts` — drop `.notNull()` on token columns (Task 1)
- `src/lib/reddit-client.ts` — add `getUserAboutPublic()` method (Task 6a)
- `src/tools/FindThreadsViaXaiTool/FindThreadsViaXaiTool.ts` — add `platform` param, branch tools/prompt/schema, add `excludeSelfHandle` (Task 2b)
- `src/tools/PersistQueueThreadsTool/PersistQueueThreadsTool.ts` — map reddit candidate fields → threads cols (Task 2c)
- `src/tools/GenerateQueriesTool/GenerateQueriesTool.ts` — add reddit strategy case (Task 2d)
- `src/workers/processors/discovery.ts` — wire generalized tool to reddit branch (Task 2d)
- `src/skills/drafting-post/SKILL.md` + reference inject — read `getSubredditRules()` for Reddit (Task 3b)
- `src/skills/drafting-reply/SKILL.md` + reference inject — same (Task 3b)
- `src/skills/validating-draft/SKILL.md` — add reddit-review-rules to platform branch (Task 3a)
- `src/lib/approve-dispatch.ts` — add `isRedditPost` and `isRedditReply` branches (Task 4b)
- `src/lib/plan-execute-dispatch.ts` — fill the Reddit `null` route holes (Task 4c)
- `src/lib/platform-deps.ts` — `createClientFromChannel('reddit', ...)` returns `appOnly()` (Task 4d)
- `src/components/onboarding/_feature-flags.ts` — `REDDIT_DRAFT_ENABLED = true` (Task 7)
- `src/components/onboarding/stage-connect.tsx` — Reddit card from OAuth → handle input; remove `comingSoon` (Task 6e + 7)
- `src/lib/platform-config.ts` — `enabled: true` (Task 7)
- `src/app/api/reddit/connect/route.ts` — repurpose from OAuth init to form POST that writes channels row (Task 6c)
- `src/app/api/reddit/callback/route.ts` — replace OAuth handler with 308 redirect (Task 6d)

---

## Sequencing

```
Task 1 (schema) ──┬─→ Task 2 (Discovery) ──┐
                   ├─→ Task 3 (Drafting)   ├─→ merge ─→ Task 7 (flips) ─→ Task 8 (Playwright)
                   ├─→ Task 4 (Dispatch)   │
                   └─→ Task 6 (Onboarding) ┘
                              │
                              └─→ Task 5 (Handoff page; depends on T4)
```

Tasks 2/3/4/6 are independent code paths and can run in parallel worktrees. Task 5 needs T4's URL builders. Task 7 must land after 2-6. Task 8 verifies end-to-end after everything else.

---

## Task 1: Channels schema — nullable token columns

**Why first:** Every downstream task assumes nullable tokens. Migration is non-destructive (existing X rows untouched).

**Files:**
- Modify: `src/lib/db/schema/channels.ts`
- Create: `src/lib/db/migrations/<NNNN>_channels_nullable_tokens.sql` (filename from drizzle-kit)
- Test: `src/lib/db/schema/__tests__/channels-nullable.test.ts`

### Steps

- [ ] **Step 1: Read existing schema**

```bash
cat src/lib/db/schema/channels.ts
```

The two columns to change are `oauthTokenEncrypted` and `refreshTokenEncrypted`. Both currently have `.notNull()`. The `(userId, platform)` unique index stays.

- [ ] **Step 2: Write failing test for nullable insert**

Create `src/lib/db/schema/__tests__/channels-nullable.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { getTestDb } from '@/test/fixtures/db';
import { channels, users } from '@/lib/db/schema';

describe('channels schema — nullable tokens (handoff mode)', () => {
  let testUserId: string;
  const testDb = getTestDb();

  beforeAll(async () => {
    const [user] = await testDb
      .insert(users)
      .values({ email: `handoff-test-${Date.now()}@example.com` })
      .returning();
    testUserId = user.id;
  });

  afterEach(async () => {
    await testDb.delete(channels).where(eq(channels.userId, testUserId));
  });

  it('accepts a reddit channels row with both token columns NULL', async () => {
    const [row] = await testDb
      .insert(channels)
      .values({
        userId: testUserId,
        platform: 'reddit',
        username: 'shipflare-test-2026',
        oauthTokenEncrypted: null,
        refreshTokenEncrypted: null,
      })
      .returning();

    expect(row.id).toBeTruthy();
    expect(row.username).toBe('shipflare-test-2026');
    expect(row.oauthTokenEncrypted).toBeNull();
    expect(row.refreshTokenEncrypted).toBeNull();
  });

  it('still accepts an x channels row with non-null tokens', async () => {
    const [row] = await testDb
      .insert(channels)
      .values({
        userId: testUserId,
        platform: 'x',
        username: 'foo',
        oauthTokenEncrypted: 'enc:xxxxx',
        refreshTokenEncrypted: 'enc:yyyyy',
        tokenExpiresAt: new Date(Date.now() + 86400_000),
      })
      .returning();

    expect(row.oauthTokenEncrypted).toBe('enc:xxxxx');
  });
});
```

- [ ] **Step 3: Run test, verify it fails**

```bash
pnpm vitest run src/lib/db/schema/__tests__/channels-nullable.test.ts
```

Expected: `FAIL` with a Postgres NOT NULL constraint violation on `oauth_token_encrypted` (or, if test DB hasn't been migrated yet, schema-level error).

- [ ] **Step 4: Modify Drizzle schema**

In `src/lib/db/schema/channels.ts`, change lines 29-30:

```ts
// Before:
oauthTokenEncrypted: text('oauth_token_encrypted').notNull(),
refreshTokenEncrypted: text('refresh_token_encrypted').notNull(),

// After:
oauthTokenEncrypted: text('oauth_token_encrypted'),
refreshTokenEncrypted: text('refresh_token_encrypted'),
```

- [ ] **Step 5: Generate migration**

```bash
pnpm drizzle-kit generate
```

Expected output: a new file `src/lib/db/migrations/<NNNN>_<random_name>.sql` containing exactly:

```sql
ALTER TABLE "channels" ALTER COLUMN "oauth_token_encrypted" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "channels" ALTER COLUMN "refresh_token_encrypted" DROP NOT NULL;
```

If drizzle-kit produces additional unrelated diffs, abort, sync the schema, and re-run.

- [ ] **Step 6: Apply migration to test DB**

```bash
pnpm drizzle-kit migrate
```

- [ ] **Step 7: Run tests, verify pass**

```bash
pnpm vitest run src/lib/db/schema/__tests__/channels-nullable.test.ts
```

Expected: `PASS` — both tests green.

- [ ] **Step 8: Sweep token-reading callers**

Run `grep -rn "oauthTokenEncrypted\|oauth_token_encrypted" src/`. Verify every reader either:
1. Lives in one of the 5 sanctioned helpers in `src/lib/platform-deps.ts` plus `RedditClient.fromChannel` / `XClient.fromChannel` / `RedditClient.appOnly` (per CLAUDE.md security rule), OR
2. Already null-handles via `if (!token) return null;` or similar.

If any caller blindly dereferences the token, file a follow-up — but for THIS plan, Reddit branches always go through `appOnly()` so we don't hit token-readers.

- [ ] **Step 9: Update backfill script**

In `scripts/encrypt-account-tokens.ts`, scope its `WHERE` to `WHERE oauth_token_encrypted IS NOT NULL` so Reddit handoff-mode rows are skipped:

```ts
// Before
.where(/* (none) */)
// After
.where(sql`oauth_token_encrypted IS NOT NULL`)
```

- [ ] **Step 10: Commit**

```bash
git add src/lib/db/schema/channels.ts src/lib/db/schema/__tests__/channels-nullable.test.ts src/lib/db/migrations/ scripts/encrypt-account-tokens.ts
git commit -m "feat(channels): allow null tokens for handoff-mode platforms

Migration is non-destructive — existing X rows keep non-null tokens.
Backs the Reddit handoff-mode channel rows that have a username but no
OAuth token. Reddit clients always use appOnly() and never read these
columns; the 5 sanctioned token-reader helpers handle null gracefully.

Spec: docs/superpowers/specs/2026-05-07-reddit-channel-handoff-design.md
"
```

---

## Task 2: Discovery — generalize `FindThreadsViaXaiTool` for Reddit

**Why second:** Largest new code surface. Independent of dispatch, drafting, and onboarding. Can run in parallel with 3, 4, 6.

### Task 2a: Extract prompt builders + schemas, write Reddit versions

**Files:**
- Create: `src/tools/FindThreadsViaXaiTool/prompt-builders.ts`
- Create: `src/tools/FindThreadsViaXaiTool/schemas.ts`
- Modify: `src/tools/FindThreadsViaXaiTool/FindThreadsViaXaiTool.ts` (move existing builders to new file, add platform branch)
- Test: `src/tools/FindThreadsViaXaiTool/__tests__/prompt-builders.test.ts`

#### Steps

- [ ] **Step 1: Move existing X prompt builders to new file**

Create `src/tools/FindThreadsViaXaiTool/prompt-builders.ts`:

```ts
import type { ProductForLoop } from './FindThreadsViaXaiTool';

const PROMPT_AUTHOR_LIMIT = 50;

export function buildXFirstTurnMessage(
  product: ProductForLoop,
  rubric: string,
  intent: string | undefined,
  maxResults: number,
  excludeAuthors: readonly string[],
  excludeSelfHandle: string | null,
): string {
  const keywords =
    product.keywords.length > 0 ? product.keywords.join(', ') : '(none)';
  const intentLine = intent ? `\nFOUNDER INTENT\n${intent}\n` : '';
  const rubricSection = rubric
    ? `\nICP RUBRIC (from onboarding)\n${rubric}\n`
    : '';

  const trimmed = excludeAuthors.slice(0, PROMPT_AUTHOR_LIMIT);
  const tail =
    excludeAuthors.length > PROMPT_AUTHOR_LIMIT
      ? ' and others — when in doubt, skip authors that look like our prior reply targets'
      : '';
  const excludeLine =
    trimmed.length > 0
      ? `- Do NOT surface tweets authored by: ${trimmed
          .map((h) => '@' + h)
          .join(', ')}${tail}. We have already engaged with them recently and another reply would feel like reply-guy harassment.`
      : '';

  const selfLine = excludeSelfHandle
    ? `- Do NOT surface tweets authored by @${excludeSelfHandle} — that is the founder running this product. Their own posts are not reply targets.`
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
    ...(selfLine ? [selfLine] : []),
    ...(excludeLine ? [excludeLine] : []),
    '- For each tweet include: url, author_username, author_bio, author_followers,',
    '  body, posted_at, likes_count, reposts_count, replies_count, views_count,',
    '  is_repost, original_url, original_author_username, surfaced_via,',
    '  confidence (your 0-1 assessment), reason (1 sentence, product-specific)',
    '- Reposts ARE valuable signal — when a relevant person reposts a thread on',
    "  the product's pain, that thread is a strong reply target. Include reposts;",
    '  do NOT filter them out as noise. The reply target for a repost is the',
    '  ORIGINAL author (set original_url + original_author_username; surfaced_via',
    '  carries the reposter handle).',
    '- If the tweet QUOTES another tweet, include `quoted_text` (the quoted post',
    "  body, verbatim) and `quoted_author` (the quoted author's @handle, no @).",
    '  If the tweet is a REPLY in a thread, include `in_reply_to_text` (the parent',
    "  post body, verbatim) and `in_reply_to_author` (parent author's @handle).",
    '  Leave any of these null when not applicable. A standalone tweet has all four',
    '  null. A self-quote (quoted_author == author_username) is allowed and common —',
    '  surface it.',
    "- Empty `tweets` is allowed if you genuinely find nothing — don't pad.",
  ].join('\n');
}

export function buildRedditFirstTurnMessage(
  product: ProductForLoop,
  rubric: string,
  intent: string | undefined,
  maxResults: number,
  excludeAuthors: readonly string[],
  excludeSelfHandle: string | null,
): string {
  const keywords =
    product.keywords.length > 0 ? product.keywords.join(', ') : '(none)';
  const intentLine = intent ? `\nFOUNDER INTENT\n${intent}\n` : '';
  const rubricSection = rubric
    ? `\nICP RUBRIC (from onboarding)\n${rubric}\n`
    : '';

  const trimmed = excludeAuthors.slice(0, PROMPT_AUTHOR_LIMIT);
  const tail =
    excludeAuthors.length > PROMPT_AUTHOR_LIMIT
      ? ' and others — when in doubt, skip authors that look like our prior reply targets'
      : '';
  const excludeLine =
    trimmed.length > 0
      ? `- Do NOT surface threads authored by: ${trimmed
          .map((h) => 'u/' + h)
          .join(', ')}${tail}. We have already replied to them recently.`
      : '';

  const selfLine = excludeSelfHandle
    ? `- Do NOT surface threads authored by u/${excludeSelfHandle} — that is the founder running this product.`
    : '';

  return [
    "I'm looking for recent Reddit threads where potential customers of my product",
    'are publicly expressing problems the product solves. Use web search,',
    'restricted to reddit.com.',
    '',
    'PRODUCT',
    `- Name: ${product.name}`,
    `- Description: ${product.description}`,
    `- Value prop: ${product.valueProp ?? '(not specified)'}`,
    `- Target audience: ${product.targetAudience ?? '(not specified)'}`,
    `- Keywords: ${keywords}`,
    intentLine + rubricSection,
    'Constraints',
    '- Reddit threads only — return reddit.com URLs (any subreddit)',
    '- Posted in the last 7 days',
    `- Up to ${maxResults * 2} candidates this pass — quality over quota`,
    ...(selfLine ? [selfLine] : []),
    ...(excludeLine ? [excludeLine] : []),
    '- Skip launch / self-promo posts where OP is pitching THEIR OWN tool',
    '  (r/SaaS / r/SideProject launch threads are not reply targets — they are not in pain)',
    '- Likely subreddits to scan (not exhaustive — explore others):',
    '  r/SaaS, r/indiehackers, r/Entrepreneur, r/startups, r/EntrepreneurRideAlong,',
    '  r/SideProject, r/microsaas, r/SmallBusiness, r/marketing, r/growmybusiness',
    '- For each thread include: external_id (reddit base36 thread ID, the part after /comments/),',
    '  url, subreddit (without r/), author_username (without u/), author_karma (integer | null),',
    '  title, body (first 500 chars selftext, single line), posted_at (ISO 8601 UTC),',
    '  score, num_comments, num_crossposts, is_self, link_url (string | null), over_18,',
    '  locked, archived, confidence (0-1), reason (ONE sentence; quote 3-8 words from the post)',
    "- Empty `threads` is allowed if you genuinely find nothing — don't pad.",
  ].join('\n');
}
```

- [ ] **Step 2: Create response schemas file**

Create `src/tools/FindThreadsViaXaiTool/schemas.ts`:

```ts
// JSON Schemas in the strict shape xAI Responses API expects:
// every property in `required`, optional fields use `["string", "null"]` unions.
// X schema preserved verbatim from prior FindThreadsViaXaiTool inline definition.

export const X_TWEET_SEARCH_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['tweets', 'notes'],
  properties: {
    tweets: {
      type: 'array',
      maxItems: 50,
      items: {
        type: 'object',
        additionalProperties: false,
        required: [
          'external_id', 'url', 'author_username', 'author_bio', 'author_followers',
          'body', 'posted_at', 'likes_count', 'reposts_count', 'replies_count',
          'views_count', 'is_repost', 'original_url', 'original_author_username',
          'surfaced_via', 'quoted_text', 'quoted_author', 'in_reply_to_text',
          'in_reply_to_author', 'confidence', 'reason',
        ],
        properties: {
          external_id: { type: 'string' },
          url: { type: 'string' },
          author_username: { type: 'string' },
          author_bio: { type: ['string', 'null'] },
          author_followers: { type: ['integer', 'null'] },
          body: { type: 'string' },
          posted_at: { type: 'string' },
          likes_count: { type: ['integer', 'null'] },
          reposts_count: { type: ['integer', 'null'] },
          replies_count: { type: ['integer', 'null'] },
          views_count: { type: ['integer', 'null'] },
          is_repost: { type: 'boolean' },
          original_url: { type: ['string', 'null'] },
          original_author_username: { type: ['string', 'null'] },
          surfaced_via: { type: ['string', 'null'] },
          quoted_text: { type: ['string', 'null'] },
          quoted_author: { type: ['string', 'null'] },
          in_reply_to_text: { type: ['string', 'null'] },
          in_reply_to_author: { type: ['string', 'null'] },
          confidence: { type: 'number', minimum: 0, maximum: 1 },
          reason: { type: 'string' },
        },
      },
    },
    notes: { type: 'string' },
  },
} as const;

export const REDDIT_THREAD_SEARCH_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['threads', 'notes'],
  properties: {
    threads: {
      type: 'array',
      maxItems: 20,
      items: {
        type: 'object',
        additionalProperties: false,
        required: [
          'external_id', 'url', 'subreddit', 'author_username', 'author_karma',
          'title', 'body', 'posted_at', 'score', 'num_comments', 'num_crossposts',
          'is_self', 'link_url', 'over_18', 'locked', 'archived',
          'confidence', 'reason',
        ],
        properties: {
          external_id: { type: 'string' },
          url: { type: 'string' },
          subreddit: { type: 'string' },
          author_username: { type: 'string' },
          author_karma: { type: ['integer', 'null'] },
          title: { type: 'string' },
          body: { type: 'string' },
          posted_at: { type: 'string' },
          score: { type: 'integer' },
          num_comments: { type: 'integer' },
          num_crossposts: { type: 'integer' },
          is_self: { type: 'boolean' },
          link_url: { type: ['string', 'null'] },
          over_18: { type: 'boolean' },
          locked: { type: 'boolean' },
          archived: { type: 'boolean' },
          confidence: { type: 'number', minimum: 0, maximum: 1 },
          reason: { type: 'string' },
        },
      },
    },
    notes: { type: 'string' },
  },
} as const;
```

- [ ] **Step 3: Write tests for prompt builders**

Create `src/tools/FindThreadsViaXaiTool/__tests__/prompt-builders.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import {
  buildXFirstTurnMessage,
  buildRedditFirstTurnMessage,
} from '../prompt-builders';

const product = {
  name: 'ShipFlare',
  description: 'AI marketing team for solo founders',
  valueProp: '5-min approval queue',
  targetAudience: 'pre-PMF solo founders',
  keywords: ['founder-led growth', 'reddit marketing'],
};

describe('buildRedditFirstTurnMessage', () => {
  it('contains Reddit-specific shape (subreddit, score, num_comments, external_id)', () => {
    const msg = buildRedditFirstTurnMessage(product, '', undefined, 10, [], null);
    expect(msg).toContain('subreddit');
    expect(msg).toContain('score');
    expect(msg).toContain('num_comments');
    expect(msg).toContain('external_id');
    expect(msg).toContain('reddit.com');
  });

  it('does NOT contain X-specific fields', () => {
    const msg = buildRedditFirstTurnMessage(product, '', undefined, 10, [], null);
    expect(msg).not.toContain('likes_count');
    expect(msg).not.toContain('reposts_count');
    expect(msg).not.toContain('quoted_text');
  });

  it('injects excludeSelfHandle when provided', () => {
    const msg = buildRedditFirstTurnMessage(product, '', undefined, 10, [], 'shipflare-founder');
    expect(msg).toContain('u/shipflare-founder');
    expect(msg).toContain('founder running this product');
  });

  it('omits self-handle line when null', () => {
    const msg = buildRedditFirstTurnMessage(product, '', undefined, 10, [], null);
    expect(msg).not.toContain('founder running this product');
  });

  it('formats excludeAuthors with u/ prefix (not @)', () => {
    const msg = buildRedditFirstTurnMessage(product, '', undefined, 10, ['alice', 'bob'], null);
    expect(msg).toContain('u/alice');
    expect(msg).toContain('u/bob');
    expect(msg).not.toContain('@alice');
  });
});

describe('buildXFirstTurnMessage', () => {
  it('preserves existing X behavior (likes_count, reposts_count present)', () => {
    const msg = buildXFirstTurnMessage(product, '', undefined, 10, [], null);
    expect(msg).toContain('likes_count');
    expect(msg).toContain('reposts_count');
  });

  it('formats excludeAuthors with @ prefix', () => {
    const msg = buildXFirstTurnMessage(product, '', undefined, 10, ['alice'], null);
    expect(msg).toContain('@alice');
  });

  it('injects excludeSelfHandle for X with @ prefix', () => {
    const msg = buildXFirstTurnMessage(product, '', undefined, 10, [], 'shipflare');
    expect(msg).toContain('@shipflare');
    expect(msg).toContain('founder running this product');
  });
});
```

- [ ] **Step 4: Run tests, verify pass**

```bash
pnpm vitest run src/tools/FindThreadsViaXaiTool/__tests__/prompt-builders.test.ts
```

Expected: 7 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/tools/FindThreadsViaXaiTool/prompt-builders.ts src/tools/FindThreadsViaXaiTool/schemas.ts src/tools/FindThreadsViaXaiTool/__tests__/prompt-builders.test.ts
git commit -m "feat(discovery): add Reddit prompt builder and JSON schema

Mirrors the X buildFirstTurnMessage shape but emits subreddit / score /
num_comments / is_self fields instead of likes / reposts / quoted_text.
Adds excludeSelfHandle to both X and Reddit builders so we never surface
the founder's own posts as reply candidates (gap not in original spec).

Spec: docs/superpowers/specs/2026-05-07-reddit-channel-handoff-design.md
"
```

### Task 2b: Generalize the tool with platform parameter

**Files:**
- Modify: `src/tools/FindThreadsViaXaiTool/FindThreadsViaXaiTool.ts`
- Modify: `src/tools/FindThreadsViaXaiTool/__tests__/FindThreadsViaXaiTool.test.ts`

#### Steps

- [ ] **Step 1: Extend input schema**

In `FindThreadsViaXaiTool.ts`, change the `inputSchema`:

```ts
const inputSchema = z.object({
  trigger: z.enum(['kickoff', 'daily']).default('daily'),
  intent: z.string().optional(),
  maxResults: z.number().int().min(1).max(50).default(10),
  platform: z.enum(['x', 'reddit']).default('x'),
});
```

- [ ] **Step 2: Replace inline `buildFirstTurnMessage` and inline schema with imports**

Remove the inline `buildFirstTurnMessage` function and inline `responseFormat` schema. Import:

```ts
import {
  buildXFirstTurnMessage,
  buildRedditFirstTurnMessage,
} from './prompt-builders';
import {
  X_TWEET_SEARCH_SCHEMA,
  REDDIT_THREAD_SEARCH_SCHEMA,
} from './schemas';
```

- [ ] **Step 3: Look up founder's own handle**

In the tool's `execute` body, after loading `product`, add:

```ts
const ownChannel = await db.query.channels.findFirst({
  where: and(eq(channels.userId, userId), eq(channels.platform, input.platform)),
  columns: { username: true },
});
const excludeSelfHandle = ownChannel?.username ?? null;
```

(Add `channels` to the existing schema imports at the top; add `and, eq` to drizzle-orm imports if not already present.)

- [ ] **Step 4: Branch tool config, prompt builder, and schema by platform**

Replace the existing `tools` array, first-turn message build, and response_format with:

```ts
const tools =
  input.platform === 'reddit'
    ? [
        {
          type: 'web_search' as const,
          filters: { allowed_domains: ['reddit.com'] as string[] },
        },
      ]
    : [{ type: 'x_search' as const }];

const buildFirstTurn =
  input.platform === 'reddit'
    ? buildRedditFirstTurnMessage
    : buildXFirstTurnMessage;

const responseFormatSchema =
  input.platform === 'reddit'
    ? REDDIT_THREAD_SEARCH_SCHEMA
    : X_TWEET_SEARCH_SCHEMA;

const responseFormatName =
  input.platform === 'reddit'
    ? 'reddit_thread_search_result'
    : 'tweet_search_result';

// First-turn message
messages.push({
  role: 'user',
  content: buildFirstTurn(
    product,
    rubric,
    input.intent,
    maxResults,
    excludeAuthors,
    excludeSelfHandle,
  ),
});
```

- [ ] **Step 5: Adapt the per-round response parsing**

The existing loop expects `{ tweets, notes }`. For Reddit, xAI returns `{ threads, notes }`. Normalize at the response-parse boundary:

```ts
type CandidateRow = X_TweetCandidate | RedditThreadCandidate;
const rawCandidates =
  input.platform === 'reddit'
    ? (parsed as { threads: RedditThreadCandidate[] }).threads
    : (parsed as { tweets: X_TweetCandidate[] }).tweets;

// Downstream loop logic uses `rawCandidates` instead of `tweets`.
// `external_id` field name is the same on both shapes — judging-thread-quality
// already keys on it.
```

Define `RedditThreadCandidate` type matching `REDDIT_THREAD_SEARCH_SCHEMA` shape; export from `schemas.ts` if useful elsewhere.

- [ ] **Step 6: Pass platform-aware throttle args**

The existing `listRecentEngagedAuthors` call already takes a platform parameter (the `userId` and `platform` filter is at the DB layer). Just confirm it's reading `input.platform` not a hardcoded `'x'`.

- [ ] **Step 7: Update existing X test fixtures (default behavior preserved)**

In `__tests__/FindThreadsViaXaiTool.test.ts`, every existing test that doesn't pass `platform` should continue to work because the default is `'x'`. Add at least one explicit assertion:

```ts
it('defaults platform to x — existing behavior preserved', async () => {
  // ... existing test setup ...
  const result = await findThreadsViaXaiTool.execute(
    { trigger: 'daily', maxResults: 10 }, // no platform field
    ctx,
  );
  // Verify the request body sent to xAI used `x_search` tool
  expect(xaiRequestBodyMock).toMatchObject({
    tools: [{ type: 'x_search' }],
  });
});
```

- [ ] **Step 8: Add Reddit-platform tests**

Append to `__tests__/FindThreadsViaXaiTool.test.ts`:

```ts
describe('platform: reddit', () => {
  it('uses web_search with reddit.com filter, not x_search', async () => {
    // ... fixture: reddit channel with username ...
    await findThreadsViaXaiTool.execute(
      { trigger: 'daily', maxResults: 10, platform: 'reddit' },
      ctx,
    );
    expect(xaiRequestBodyMock).toMatchObject({
      tools: [
        {
          type: 'web_search',
          filters: { allowed_domains: ['reddit.com'] },
        },
      ],
    });
  });

  it('injects excludeSelfHandle from channels.username', async () => {
    // Seed a reddit channel with username 'shipflare-founder'
    await testDb.insert(channels).values({
      userId: 'user-1',
      platform: 'reddit',
      username: 'shipflare-founder',
      oauthTokenEncrypted: null,
      refreshTokenEncrypted: null,
    });

    await findThreadsViaXaiTool.execute(
      { trigger: 'daily', maxResults: 10, platform: 'reddit' },
      ctx,
    );
    const sentBody = xaiRequestBodyMock.input[0].content as string;
    expect(sentBody).toContain('u/shipflare-founder');
  });

  it('omits excludeSelfHandle when no reddit channel exists', async () => {
    // No channel row seeded
    await findThreadsViaXaiTool.execute(
      { trigger: 'daily', maxResults: 10, platform: 'reddit' },
      ctx,
    );
    const sentBody = xaiRequestBodyMock.input[0].content as string;
    expect(sentBody).not.toContain('founder running this product');
  });

  it('uses REDDIT_THREAD_SEARCH_SCHEMA for response format', async () => {
    await findThreadsViaXaiTool.execute(
      { trigger: 'daily', maxResults: 10, platform: 'reddit' },
      ctx,
    );
    expect(xaiRequestBodyMock.text.format.name).toBe('reddit_thread_search_result');
  });

  it('parses { threads, notes } response shape correctly', async () => {
    xaiRespondMock.mockResolvedValueOnce({
      output: JSON.stringify({
        threads: [
          {
            external_id: '1abc234',
            url: 'https://www.reddit.com/r/SaaS/comments/1abc234/test',
            subreddit: 'SaaS',
            author_username: 'foo',
            author_karma: 500,
            title: 'How do I market my SaaS',
            body: 'Lorem ipsum',
            posted_at: '2026-05-06T10:00:00Z',
            score: 12,
            num_comments: 5,
            num_crossposts: 0,
            is_self: true,
            link_url: null,
            over_18: false,
            locked: false,
            archived: false,
            confidence: 0.85,
            reason: 'No marketing person, looking for distribution.',
          },
        ],
        notes: 'Strong match in r/SaaS',
      }),
    });

    const result = await findThreadsViaXaiTool.execute(
      { trigger: 'daily', maxResults: 10, platform: 'reddit' },
      ctx,
    );
    expect(result.queued).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 9: Run all tests**

```bash
pnpm vitest run src/tools/FindThreadsViaXaiTool/
```

Expected: all existing X tests pass, all new Reddit tests pass.

- [ ] **Step 10: Commit**

```bash
git add src/tools/FindThreadsViaXaiTool/
git commit -m "feat(discovery): generalize FindThreadsViaXaiTool for Reddit

Adds platform: 'x' | 'reddit' input parameter. xAI Responses API call
shape unchanged; only tools[], prompt builder, and JSON schema branch
by platform. Reuses refinement loop, judging-thread-quality fan-out,
exclude-authors throttle, and reasoning escalation.

For platform=reddit: tools=[web_search with reddit.com filter],
prompt=buildRedditFirstTurnMessage, schema=REDDIT_THREAD_SEARCH_SCHEMA.
Injects channels.username as excludeSelfHandle so the founder's own
posts are never surfaced as reply targets.

Spec: docs/superpowers/specs/2026-05-07-reddit-channel-handoff-design.md
"
```

### Task 2c: Persist mapping for Reddit candidates

**Files:**
- Modify: `src/tools/PersistQueueThreadsTool/PersistQueueThreadsTool.ts`
- Test: `src/tools/PersistQueueThreadsTool/__tests__/PersistQueueThreadsTool.test.ts`

#### Steps

- [ ] **Step 1: Read existing X mapping**

```bash
grep -n "likes_count\|reposts_count\|community" src/tools/PersistQueueThreadsTool/PersistQueueThreadsTool.ts
```

Confirm the current mapping shape; identify the function that builds the `threads` insert row.

- [ ] **Step 2: Write failing test for Reddit candidate**

In `__tests__/PersistQueueThreadsTool.test.ts`:

```ts
it('maps reddit candidate fields into threads columns', async () => {
  const result = await persistQueueThreadsTool.execute(
    {
      platform: 'reddit',
      candidates: [
        {
          external_id: '1abc234',
          url: 'https://reddit.com/r/SaaS/comments/1abc234/test',
          subreddit: 'SaaS',
          author_username: 'foo',
          author_karma: 500,
          title: 'How do I market',
          body: 'Selftext body',
          posted_at: '2026-05-06T10:00:00Z',
          score: 42,
          num_comments: 18,
          num_crossposts: 1,
          is_self: true,
          link_url: null,
          over_18: false,
          locked: false,
          archived: false,
          confidence: 0.85,
          reason: 'pain expressed',
        },
      ],
    },
    ctx,
  );

  const persisted = await testDb.query.threads.findFirst({
    where: eq(threads.externalId, '1abc234'),
  });
  expect(persisted).toMatchObject({
    platform: 'reddit',
    community: 'SaaS',
    title: 'How do I market',
    body: 'Selftext body',
    author: 'foo',
    upvotes: 42,
    commentCount: 18,
    repostsCount: 1,
    isLocked: false,
    isArchived: false,
  });
});
```

- [ ] **Step 3: Run test, verify it fails**

```bash
pnpm vitest run src/tools/PersistQueueThreadsTool/__tests__/PersistQueueThreadsTool.test.ts -t "maps reddit"
```

Expected: FAIL — current mapping doesn't handle reddit shape.

- [ ] **Step 4: Add platform branch to mapping**

In `PersistQueueThreadsTool.ts`, locate the candidate→row mapping function. Add a branch:

```ts
function mapCandidateToThread(
  platform: string,
  candidate: XTweetCandidate | RedditThreadCandidate,
  userId: string,
): InsertThreadRow {
  if (platform === 'reddit') {
    const c = candidate as RedditThreadCandidate;
    return {
      userId,
      externalId: c.external_id,
      platform: 'reddit',
      community: c.subreddit,
      title: c.title,
      url: c.url,
      body: c.body,
      author: c.author_username,
      upvotes: c.score,
      commentCount: c.num_comments,
      repostsCount: c.num_crossposts,
      likesCount: null,
      viewsCount: null,
      repliesCount: c.num_comments,
      isLocked: c.locked,
      isArchived: c.archived,
      postedAt: new Date(c.posted_at),
      scoutConfidence: c.confidence,
      scoutReason: c.reason,
    };
  }
  // existing X branch unchanged
  const t = candidate as XTweetCandidate;
  return {
    userId,
    externalId: t.external_id,
    platform: 'x',
    community: '', // X has no subreddit equivalent
    title: '', // tweets have no title
    url: t.url,
    body: t.body,
    author: t.author_username,
    upvotes: t.likes_count ?? 0,
    commentCount: t.replies_count ?? 0,
    likesCount: t.likes_count,
    repostsCount: t.reposts_count,
    repliesCount: t.replies_count,
    viewsCount: t.views_count,
    isLocked: false,
    isArchived: false,
    postedAt: new Date(t.posted_at),
    scoutConfidence: t.confidence,
    scoutReason: t.reason,
  };
}
```

(Adapt to actual existing function shape — the spec just shows the field mapping.)

- [ ] **Step 5: Run test, verify pass**

```bash
pnpm vitest run src/tools/PersistQueueThreadsTool/
```

- [ ] **Step 6: Commit**

```bash
git add src/tools/PersistQueueThreadsTool/
git commit -m "feat(discovery): map Reddit candidates into threads table"
```

### Task 2d: Generate-queries strategy + discovery wiring

**Files:**
- Modify: `src/tools/GenerateQueriesTool/GenerateQueriesTool.ts`
- Modify: `src/workers/processors/discovery.ts`
- Test: existing `GenerateQueriesTool` tests + integration test for reddit discovery

#### Steps

- [ ] **Step 1: Add reddit case to query strategy**

In `GenerateQueriesTool.ts`, find the platform switch. Add:

```ts
case 'reddit': {
  // Reddit founder-pain query patterns: prefer "how do I X without Y" and
  // "struggling to Z" shape. xAI Grok with web_search filter does the
  // actual subreddit selection — these are seed queries for the first turn.
  return [
    `${product.name} alternative reddit`,
    `how to market a saas reddit founder`,
    `struggling to get first users reddit`,
    `${product.targetAudience} reddit ${product.keywords[0] ?? ''}`,
    'no marketing person reddit founder advice',
    'pre-pmf distribution reddit',
  ].filter((q) => q.trim().length > 0);
}
```

- [ ] **Step 2: Wire generalized tool into reddit discovery branch**

In `src/workers/processors/discovery.ts`, find the platform branch. Where the X branch calls `findThreadsViaXaiTool.execute({ trigger, maxResults })`, the reddit branch must pass `platform: 'reddit'`:

```ts
if (platform === PLATFORMS.reddit.id) {
  await findThreadsViaXaiTool.execute(
    { trigger, maxResults: 20, intent, platform: 'reddit' },
    ctx,
  );
} else if (platform === PLATFORMS.x.id) {
  await findThreadsViaXaiTool.execute(
    { trigger, maxResults: 20, intent, platform: 'x' },
    ctx,
  );
}
```

If discovery.ts already has a single platform-agnostic call, just confirm `platform` flows through correctly.

- [ ] **Step 3: Integration test for reddit discovery cycle**

Add to existing discovery test or create `src/workers/processors/__tests__/discovery-reddit.test.ts`:

```ts
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@/tools/FindThreadsViaXaiTool/FindThreadsViaXaiTool', () => ({
  findThreadsViaXaiTool: { execute: vi.fn() },
}));

describe('discovery — reddit branch', () => {
  beforeEach(() => vi.clearAllMocks());

  it('passes platform: "reddit" to find_threads_via_xai', async () => {
    const { processDiscovery } = await import('../discovery');
    const { findThreadsViaXaiTool } = await import(
      '@/tools/FindThreadsViaXaiTool/FindThreadsViaXaiTool'
    );

    await processDiscovery({
      userId: 'user-1',
      productId: 'prod-1',
      platform: 'reddit',
      trigger: 'daily',
    } as never);

    expect(findThreadsViaXaiTool.execute).toHaveBeenCalledWith(
      expect.objectContaining({ platform: 'reddit' }),
      expect.any(Object),
    );
  });
});
```

- [ ] **Step 4: Run tests**

```bash
pnpm vitest run src/tools/GenerateQueriesTool/ src/workers/processors/__tests__/discovery-reddit.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add src/tools/GenerateQueriesTool/ src/workers/processors/discovery.ts src/workers/processors/__tests__/discovery-reddit.test.ts
git commit -m "feat(discovery): wire reddit branch through generalized find_threads_via_xai"
```

---

## Task 3: Drafting + Reddit-specific platform rules

**Why now:** Draft quality directly determines whether handoff is worth shipping. Independent of dispatch, schema, and onboarding — can run parallel with 2/4/6.

### Task 3a: Reddit review rules reference

**Files:**
- Create: `src/skills/validating-draft/references/reddit-review-rules.md`
- Modify: `src/skills/validating-draft/SKILL.md`

#### Steps

- [ ] **Step 1: Read existing X review rules for shape**

```bash
cat src/skills/validating-draft/references/x-review-rules.md
```

Match this file's structure (sections, tone, length).

- [ ] **Step 2: Write reddit-review-rules.md**

Create `src/skills/validating-draft/references/reddit-review-rules.md`:

```markdown
# Reddit reply / post review rules

Apply these rules when validating drafts where `platform === 'reddit'`. They reflect Reddit-specific community norms that differ from X. Mod-removability is the dominant failure mode; AutoMod patterns and self-promo enforcement are stricter than any other platform we ship to.

## REJECT (FAIL verdict — do not allow handoff)

### Self-promo without disclosure
- Mentioning ShipFlare (or the user's product) in the first 2 sentences of a reply, **unless** the OP explicitly asked for tool recommendations.
- Posting a link without context. Reddit's per-subreddit self-promo ratio is typically "9 helpful comments per 1 link" — assume zero context = removed.
- Brand-voice promotional language: "transform your X", "supercharge", "the only tool that".

### AutoMod red flags
- Brand-new account voice: gushing positivity, marketing-speak, "great question!"
- "DM me" or "PM me" — multiple subreddits AutoMod-remove these on sight
- Link-only comments
- Comments under ~30 chars (treated as low-effort)
- Comments containing only a link with no surrounding text

### Banned slop phrases (Reddit-specific)
- "Great question"
- "Happy to help"
- "Feel free to reach out"
- "I totally understand where you're coming from"
- "Really resonates with me"
- "On a similar note"
- "Just my two cents"
- "Hope this helps!"
- "Awesome point"

### Voice mismatches
- Excessive emoji (Reddit is mostly emoji-light outside of meme subs)
- Sentence-case on every sentence (real Reddit users mix lowercase, fragments, occasional ALL CAPS)
- No personal experience anchor — Reddit replies that work usually start with "I tried X and..." or "We had this exact problem..."

## REVISE (issue warning, suggest fix)

### Length
- Replies > 800 chars feel like a blog post. Aim for 50-300.
- Posts > 2000 chars in body get tl;dr'd. Add a tl;dr line up top if longer.

### Markdown
- Reddit supports markdown but `*italics*` and `**bold**` only — no headers below `#`, no tables in old.reddit. Use `> ` for blockquotes when referencing the OP.
- Backticks for `code references` are great signal for technical subs.

### Tone calibration
- Match the subreddit. r/SaaS is more polished, r/indiehackers is more casual, r/Entrepreneur is meme-heavy and skeptical, r/microsaas is technical.
- Lead with admitting limitations. "I'm not sure if this applies to your case but..." beats "You should..." on Reddit.

## PASS (allow handoff)

A draft passes when:
1. No banned slop phrases.
2. Has personal-experience anchor or genuine question OR concrete tactical advice (numbered list, specific tool name, specific number).
3. Mentions the user's product only if (a) directly answering a "what tool do you use" question, or (b) wrapped in genuine context after the helpful content.
4. Length within the subreddit's typical range.
5. Markdown valid for both old.reddit and new.reddit.

## Subreddit-specific overrides

If the drafting skill called `getSubredditRules()` and got back rules text, treat any rule that says "no self-promotion" as a hard block on product mention. Surface the conflicting rule in the FAIL reason.

## When to skip entirely

- Thread is `locked: true` or `archived: true`. Do not draft.
- Subreddit appears in the user's blocklist (configured in onboarding).
- OP comment is `[deleted]` or `[removed]`.
- NSFW thread (`over_18: true`) unless product is explicitly adult-oriented.
```

- [ ] **Step 3: Modify validating-draft SKILL.md**

In `src/skills/validating-draft/SKILL.md`, locate the references section. Add `reddit-review-rules.md`:

```markdown
references:
  - x-review-rules.md
  - reddit-review-rules.md
```

In the SKILL body, add a platform-aware section near the rules-loading block:

```markdown
Load the platform-specific rules:
- For X drafts (`platform: x`): apply `references/x-review-rules.md`.
- For Reddit drafts (`platform: reddit`): apply `references/reddit-review-rules.md`.
- For unknown platforms: emit a warning and use the strictest combined ruleset.
```

- [ ] **Step 4: Add a unit test for skill rule routing**

If validating-draft has a test harness, add:

```ts
it('loads reddit-review-rules for reddit platform', async () => {
  const { skillContent } = await loadValidatingDraftSkill({ platform: 'reddit' });
  expect(skillContent).toContain('reddit-review-rules.md');
  expect(skillContent).not.toContain('x-review-rules.md');
});
```

If no test harness exists, skip this step and verify manually.

- [ ] **Step 5: Commit**

```bash
git add src/skills/validating-draft/
git commit -m "feat(skills): add Reddit-specific review rules to validating-draft"
```

### Task 3b: Inject `getSubredditRules()` into drafting prompts

**Files:**
- Modify: `src/skills/drafting-post/SKILL.md`
- Modify: `src/skills/drafting-reply/SKILL.md`

#### Steps

- [ ] **Step 1: Identify drafting skill's tool injection point**

```bash
grep -n "platform\|allowed-tools" src/skills/drafting-post/SKILL.md src/skills/drafting-reply/SKILL.md
```

The skill front-matter has `allowed-tools:`. Confirm whether `RedditClient` access is already exposed via a tool, or whether we need a new tool `get_subreddit_rules`.

- [ ] **Step 2: Add `get_subreddit_rules` tool (if not present)**

If a `get_subreddit_rules` tool doesn't already exist, create `src/tools/GetSubredditRulesTool/GetSubredditRulesTool.ts`:

```ts
import { z } from 'zod';
import { buildTool } from '@/core/tool-system';
import { RedditClient } from '@/lib/reddit-client';

export const GET_SUBREDDIT_RULES_TOOL_NAME = 'get_subreddit_rules';

export const getSubredditRulesTool = buildTool({
  name: GET_SUBREDDIT_RULES_TOOL_NAME,
  description:
    'Fetch the rules of a specific subreddit so the draft does not violate them. ' +
    'Returns an array of { short_name, description } objects. Returns [] if the ' +
    'subreddit has no rules or the call fails (degrades gracefully).',
  inputSchema: z.object({
    subreddit: z.string().min(1).max(100),
  }),
  outputSchema: z.array(
    z.object({
      short_name: z.string(),
      description: z.string(),
    }),
  ),
  execute: async (input) => {
    try {
      const client = RedditClient.appOnly();
      const rules = await client.getSubredditRules(input.subreddit);
      return rules;
    } catch (err) {
      // Non-blocking: drafting proceeds without rules if the call fails.
      return [];
    }
  },
});
```

Register in `src/tools/registry.ts`:

```ts
import { getSubredditRulesTool } from './GetSubredditRulesTool/GetSubredditRulesTool';
// ... in the registry:
registerTool(getSubredditRulesTool);
```

- [ ] **Step 3: Inject into drafting-post and drafting-reply SKILL.md**

In both `src/skills/drafting-post/SKILL.md` and `src/skills/drafting-reply/SKILL.md`, add to `allowed-tools:`:

```yaml
allowed-tools:
  # ... existing ...
  - get_subreddit_rules
```

In the body, add a Reddit-specific instruction:

```markdown
## Reddit-specific drafting

If `platform === 'reddit'`:
1. Call `get_subreddit_rules` with the thread's subreddit BEFORE writing the draft.
2. If the returned rules contain anything about "no self-promotion", "no AI tools", or "no founders": flag the draft as `flagged` with reason "subreddit rule conflict" and DO NOT generate a draft.
3. Otherwise, include the relevant rules verbatim in your prompt context. Match tone and avoid any pattern explicitly forbidden.
```

- [ ] **Step 4: Test rule injection**

Add a vitest case in the skill's test suite (if one exists) verifying that for reddit drafts, `get_subreddit_rules` is invoked. If no test harness, skip and verify manually in real-browser smoke (Task 8).

- [ ] **Step 5: Commit**

```bash
git add src/tools/GetSubredditRulesTool/ src/tools/registry.ts src/skills/drafting-post/SKILL.md src/skills/drafting-reply/SKILL.md
git commit -m "feat(drafting): inject getSubredditRules into Reddit drafts

Drafting skills now call get_subreddit_rules before generating Reddit
content. If the subreddit forbids self-promo or AI tools, drafts are
flagged instead of generated. Failed calls degrade gracefully (drafting
proceeds without rules)."
```

---

## Task 4: Dispatch + handoff URL builders

**Why now:** Closes the loop from approve action to user-visible handoff URL. Independent of discovery and drafting.

### Task 4a: URL builders

**Files:**
- Create: `src/lib/reddit-intent-url.ts`
- Create: `src/lib/reddit-handoff-url.ts`
- Test: `src/lib/__tests__/reddit-intent-url.test.ts`
- Test: `src/lib/__tests__/reddit-handoff-url.test.ts`

#### Steps

- [ ] **Step 1: Read existing buildXIntentUrl for parallel structure**

```bash
cat src/lib/x-intent-url.ts
```

Mirror its style (interface input, throw on empty, URLSearchParams).

- [ ] **Step 2: Write failing test for buildRedditSubmitUrl**

Create `src/lib/__tests__/reddit-intent-url.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { buildRedditSubmitUrl } from '../reddit-intent-url';

describe('buildRedditSubmitUrl', () => {
  it('returns a self-text submit URL with type, title, selftext params', () => {
    const url = buildRedditSubmitUrl({
      subreddit: 'SaaS',
      title: 'How I got my first 100 users',
      body: 'Step 1 was reddit.',
    });
    expect(url).toMatch(/^https:\/\/www\.reddit\.com\/r\/SaaS\/submit\?/);
    expect(url).toContain('type=text');
    expect(url).toContain('title=How+I+got+my+first+100+users');
    expect(url).toContain('selftext=Step+1+was+reddit.');
  });

  it('throws on empty title', () => {
    expect(() =>
      buildRedditSubmitUrl({ subreddit: 'SaaS', title: '', body: 'x' }),
    ).toThrow(/title is required/);
  });

  it('throws on empty subreddit', () => {
    expect(() =>
      buildRedditSubmitUrl({ subreddit: '', title: 'x', body: 'y' }),
    ).toThrow(/subreddit is required/);
  });

  it('throws when body exceeds Reddit selftext cap (40_000 chars)', () => {
    const huge = 'x'.repeat(40_001);
    expect(() =>
      buildRedditSubmitUrl({ subreddit: 'SaaS', title: 't', body: huge }),
    ).toThrow(/body too long/);
  });

  it('URL-encodes ampersands and emoji in title', () => {
    const url = buildRedditSubmitUrl({
      subreddit: 'SaaS',
      title: 'Tools & tactics 🚀',
      body: 'x',
    });
    // URLSearchParams encodes '&' as '%26' and emoji as URL-safe form.
    expect(url).toContain('title=Tools+%26+tactics+%F0%9F%9A%80');
  });

  it('strips leading r/ from subreddit if accidentally included', () => {
    const url = buildRedditSubmitUrl({
      subreddit: 'r/SaaS',
      title: 't',
      body: 'b',
    });
    expect(url).toContain('/r/SaaS/submit');
    expect(url).not.toContain('/r/r/SaaS');
  });
});
```

- [ ] **Step 3: Run test, verify it fails**

```bash
pnpm vitest run src/lib/__tests__/reddit-intent-url.test.ts
```

Expected: FAIL — file does not exist.

- [ ] **Step 4: Implement buildRedditSubmitUrl**

Create `src/lib/reddit-intent-url.ts`:

```ts
/**
 * Build a TOS-compliant Reddit submit URL for a self (text) post.
 * Opening this URL in the user's browser pre-fills Reddit's submit form.
 * The user clicks "Post" themselves — we never call Reddit's write API,
 * so we do not need an OAuth app for this path.
 *
 * Docs: https://www.reddit.com/wiki/submitting (informal)
 */
export interface RedditSubmitInput {
  /** Subreddit name without the r/ prefix (function strips r/ if included). */
  subreddit: string;
  title: string;
  /** Selftext body. Reddit's hard cap is 40_000 chars. */
  body: string;
}

const REDDIT_SELFTEXT_CAP = 40_000;

export function buildRedditSubmitUrl({
  subreddit,
  title,
  body,
}: RedditSubmitInput): string {
  const sub = subreddit.trim().replace(/^r\//, '');
  if (!sub) {
    throw new Error('buildRedditSubmitUrl: subreddit is required');
  }
  if (!title || !title.trim()) {
    throw new Error('buildRedditSubmitUrl: title is required');
  }
  if (body.length > REDDIT_SELFTEXT_CAP) {
    throw new Error(
      `buildRedditSubmitUrl: body too long (${body.length} > ${REDDIT_SELFTEXT_CAP})`,
    );
  }
  const params = new URLSearchParams({
    type: 'text',
    title,
    selftext: body,
  });
  return `https://www.reddit.com/r/${sub}/submit?${params.toString()}`;
}
```

- [ ] **Step 5: Run test, verify pass**

```bash
pnpm vitest run src/lib/__tests__/reddit-intent-url.test.ts
```

Expected: 6 tests pass.

- [ ] **Step 6: Implement buildRedditHandoffPageUrl + tests**

Create `src/lib/__tests__/reddit-handoff-url.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { buildRedditHandoffPageUrl } from '../reddit-handoff-url';

describe('buildRedditHandoffPageUrl', () => {
  const orig = process.env.NEXT_PUBLIC_BASE_URL;
  beforeEach(() => {
    process.env.NEXT_PUBLIC_BASE_URL = orig;
  });

  it('returns absolute handoff URL using NEXT_PUBLIC_BASE_URL', () => {
    process.env.NEXT_PUBLIC_BASE_URL = 'https://shipflare.io';
    const url = buildRedditHandoffPageUrl('draft-abc-123');
    expect(url).toBe('https://shipflare.io/handoff/reddit/draft-abc-123');
  });

  it('falls back to localhost for dev', () => {
    delete process.env.NEXT_PUBLIC_BASE_URL;
    const url = buildRedditHandoffPageUrl('d-1');
    expect(url).toBe('http://localhost:3000/handoff/reddit/d-1');
  });

  it('strips trailing slash from base URL', () => {
    process.env.NEXT_PUBLIC_BASE_URL = 'https://shipflare.io/';
    const url = buildRedditHandoffPageUrl('d-1');
    expect(url).toBe('https://shipflare.io/handoff/reddit/d-1');
  });

  it('throws on empty draftId', () => {
    expect(() => buildRedditHandoffPageUrl('')).toThrow(/draftId is required/);
  });
});
```

Create `src/lib/reddit-handoff-url.ts`:

```ts
export function buildRedditHandoffPageUrl(draftId: string): string {
  if (!draftId || !draftId.trim()) {
    throw new Error('buildRedditHandoffPageUrl: draftId is required');
  }
  const base = (
    process.env.NEXT_PUBLIC_BASE_URL ?? 'http://localhost:3000'
  ).replace(/\/$/, '');
  return `${base}/handoff/reddit/${draftId}`;
}
```

- [ ] **Step 7: Run all URL builder tests**

```bash
pnpm vitest run src/lib/__tests__/reddit-intent-url.test.ts src/lib/__tests__/reddit-handoff-url.test.ts
```

- [ ] **Step 8: Commit**

```bash
git add src/lib/reddit-intent-url.ts src/lib/reddit-handoff-url.ts src/lib/__tests__/reddit-intent-url.test.ts src/lib/__tests__/reddit-handoff-url.test.ts
git commit -m "feat(handoff): Reddit submit URL + handoff page URL builders

Mirror of buildXIntentUrl shape. buildRedditSubmitUrl returns the
official /r/<sub>/submit?type=text&title=&selftext= URL for self posts.
buildRedditHandoffPageUrl returns the ShipFlare-owned page URL where
reply clipboard handoff happens."
```

### Task 4b: dispatchApprove branches

**Files:**
- Modify: `src/lib/approve-dispatch.ts`
- Modify: `src/lib/__tests__/approve-dispatch.test.ts`

#### Steps

- [ ] **Step 1: Add Reddit branches to dispatchApprove**

In `src/lib/approve-dispatch.ts`, after the `isXReply` block (around line 50), insert:

```ts
const isRedditPost =
  input.thread.platform === PLATFORMS.reddit.id &&
  input.draft.draftType === 'original_post';

const isRedditReply =
  input.thread.platform === PLATFORMS.reddit.id &&
  input.draft.draftType === 'reply';

if (isRedditPost) {
  // Top-level Reddit posts handed off via Reddit's official submit URL.
  // Status flips to 'handed_off' on dispatch (parity with X intent URL):
  // the URL itself is the commit point — there's no second user step we
  // can hook to flip it later.
  if (!input.draft.subreddit || !input.draft.postTitle) {
    throw new Error(
      `dispatchApprove: Reddit post requires subreddit + postTitle (draft ${input.draft.id})`,
    );
  }
  return {
    kind: 'handoff',
    intentUrl: buildRedditSubmitUrl({
      subreddit: input.draft.subreddit,
      title: input.draft.postTitle,
      body: input.draft.replyBody,
    }),
  };
}

if (isRedditReply) {
  // Reddit replies handed off via ShipFlare's own page (no native intent
  // URL for comments exists). Status STAYS 'pending' here — the handoff
  // page itself flips to 'handed_off' when the user clicks Open / Copy
  // (Decision 1 in the plan). Stale-sweeper ages out abandoned 'pending'.
  return {
    kind: 'handoff',
    intentUrl: buildRedditHandoffPageUrl(input.draft.id),
  };
}
```

Add imports at top:

```ts
import { buildRedditSubmitUrl } from '@/lib/reddit-intent-url';
import { buildRedditHandoffPageUrl } from '@/lib/reddit-handoff-url';
```

- [ ] **Step 2: Extend DispatchInput type**

The Reddit post branch reads `input.draft.subreddit` and `input.draft.postTitle`. Update the interface:

```ts
export interface DispatchInput {
  draft: {
    id: string;
    userId: string;
    threadId: string;
    draftType: 'reply' | 'original_post';
    replyBody: string;
    planItemId: string | null;
    /** Reddit posts only — the subreddit (without r/ prefix). */
    subreddit?: string | null;
    /** Reddit posts only — the title (drafts.postTitle column). */
    postTitle?: string | null;
  };
  // ... rest unchanged
}
```

Update the loader `loadDispatchInputForDraft` in `src/lib/approve-loaders.ts` to populate these fields when the draft is a Reddit post (read from `drafts.postTitle` and `threads.community`).

- [ ] **Step 3: Document the status-transition split**

Update the JSDoc on `dispatchApprove`:

```ts
/**
 * Decide what to do when the user (or auto-approve) approves a draft.
 *
 * Status transition responsibility (caller writes these):
 * - X reply        → handoff via X intent URL.    Caller flips to 'handed_off'.
 * - X post         → queued via posting.ts.       Caller flips to 'approved'.
 * - Reddit post    → handoff via submit URL.      Caller flips to 'handed_off'.
 * - Reddit reply   → handoff via handoff page.    Caller leaves as 'pending'.
 *                                                 Page flips to 'handed_off' on user action.
 */
```

- [ ] **Step 4: Add tests for Reddit branches**

In `src/lib/__tests__/approve-dispatch.test.ts`:

```ts
describe('dispatchApprove — Reddit branches', () => {
  it('returns handoff with submit URL for Reddit post', async () => {
    const result = await dispatchApprove({
      draft: {
        id: 'd-1',
        userId: 'u-1',
        threadId: 't-1',
        draftType: 'original_post',
        replyBody: 'My selftext body.',
        planItemId: null,
        subreddit: 'SaaS',
        postTitle: 'How I got first users',
      },
      thread: { id: 't-1', platform: 'reddit', externalId: '1abc' },
      channelId: 'ch-1',
      connectedAgeDays: 30,
    });

    expect(result.kind).toBe('handoff');
    if (result.kind !== 'handoff') return;
    expect(result.intentUrl).toContain('reddit.com/r/SaaS/submit');
    expect(result.intentUrl).toContain('selftext=My+selftext+body.');
  });

  it('returns handoff with handoff-page URL for Reddit reply', async () => {
    process.env.NEXT_PUBLIC_BASE_URL = 'https://shipflare.io';
    const result = await dispatchApprove({
      draft: {
        id: 'd-2',
        userId: 'u-1',
        threadId: 't-1',
        draftType: 'reply',
        replyBody: 'Tried this myself, it worked.',
        planItemId: null,
      },
      thread: { id: 't-1', platform: 'reddit', externalId: '1abc' },
      channelId: 'ch-1',
      connectedAgeDays: 30,
    });

    expect(result.kind).toBe('handoff');
    if (result.kind !== 'handoff') return;
    expect(result.intentUrl).toBe('https://shipflare.io/handoff/reddit/d-2');
  });

  it('throws when Reddit post is missing subreddit', async () => {
    await expect(
      dispatchApprove({
        draft: {
          id: 'd-3',
          userId: 'u-1',
          threadId: 't-1',
          draftType: 'original_post',
          replyBody: 'body',
          planItemId: null,
          subreddit: null,
          postTitle: 'title',
        },
        thread: { id: 't-1', platform: 'reddit', externalId: '1' },
        channelId: 'ch-1',
        connectedAgeDays: 30,
      }),
    ).rejects.toThrow(/subreddit/);
  });

  it('does NOT call computeNextSlot for Reddit (skips pacer)', async () => {
    // Reddit handoff bypasses posting.ts queue; the pacer should not be invoked.
    const computeNextSlotMock = vi.fn();
    // ... mock setup ...
    await dispatchApprove({
      draft: {
        id: 'd-4',
        userId: 'u-1',
        threadId: 't-1',
        draftType: 'reply',
        replyBody: 'x',
        planItemId: null,
      },
      thread: { id: 't-1', platform: 'reddit', externalId: '1' },
      channelId: 'ch-1',
      connectedAgeDays: 30,
    });
    expect(computeNextSlotMock).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 5: Run tests**

```bash
pnpm vitest run src/lib/__tests__/approve-dispatch.test.ts
```

- [ ] **Step 6: Commit**

```bash
git add src/lib/approve-dispatch.ts src/lib/approve-loaders.ts src/lib/__tests__/approve-dispatch.test.ts
git commit -m "feat(dispatch): Reddit post + reply handoff branches

Reddit posts return submit URL handoff (status flips on dispatch).
Reddit replies return handoff page URL (status stays pending; page
flips on user action). Bypasses posting.ts pacer entirely — Reddit
handoff has no API rate-limit to enforce."
```

### Task 4c: plan-execute-dispatch routes

**Files:**
- Modify: `src/lib/plan-execute-dispatch.ts`
- Modify: `src/lib/__tests__/plan-execute-dispatch.test.ts` (or wherever existing tests live)

#### Steps

- [ ] **Step 1: Find the Reddit null-route holes**

```bash
grep -n "reddit\|null" src/lib/plan-execute-dispatch.ts | head -20
```

Spec referenced line 52. Confirm the two route entries.

- [ ] **Step 2: Replace null routes**

```ts
// Before
{ kind: 'content_post', channel: 'reddit',
  route: { draftSkill: null, executeSkill: null, defaultUserAction: 'approve' } },
{ kind: 'content_reply', channel: 'reddit',
  route: { draftSkill: null, executeSkill: null, defaultUserAction: 'approve' } },

// After
{ kind: 'content_post', channel: 'reddit',
  route: { draftSkill: null, executeSkill: 'posting', defaultUserAction: 'approve' } },
{ kind: 'content_reply', channel: 'reddit',
  route: { draftSkill: null, executeSkill: 'posting', defaultUserAction: 'approve' } },
```

The `'posting'` skill string-label flows through `posting.ts → dispatchApprove`, which now routes Reddit to handoff (Task 4b). `posting.ts`'s direct-post branch for Reddit is unreachable but kept intact for the future OAuth path.

- [ ] **Step 3: Update tests**

```ts
it('routes reddit content_post to posting executeSkill', () => {
  const route = lookupDispatchRoute('content_post', 'reddit');
  expect(route).toEqual({
    draftSkill: null,
    executeSkill: 'posting',
    defaultUserAction: 'approve',
  });
});

it('routes reddit content_reply to posting executeSkill', () => {
  const route = lookupDispatchRoute('content_reply', 'reddit');
  expect(route?.executeSkill).toBe('posting');
});
```

- [ ] **Step 4: Run tests**

```bash
pnpm vitest run src/lib/__tests__/plan-execute-dispatch.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add src/lib/plan-execute-dispatch.ts src/lib/__tests__/plan-execute-dispatch.test.ts
git commit -m "feat(dispatch): fill reddit content_post/reply route holes"
```

### Task 4d: createClientFromChannel reddit branch

**Files:**
- Modify: `src/lib/platform-deps.ts`
- Modify: `src/lib/__tests__/platform-deps.test.ts`

#### Steps

- [ ] **Step 1: Update reddit branch in createClientFromChannel**

Find the existing reddit case (likely around `case 'reddit':` returning `RedditClient.fromChannel(...)`):

```ts
// Before
case 'reddit':
  return RedditClient.fromChannel(channel);

// After
case 'reddit':
  // Handoff-mode reddit channels have no tokens; clients are read-only
  // via the public JSON API. Direct-post code paths are unreachable for
  // Reddit because dispatchApprove routes Reddit to handoff (Task 4b).
  return RedditClient.appOnly();
```

Apply the same change to `createClientFromChannelById('reddit', ...)`.

- [ ] **Step 2: Update test fixtures**

```ts
it('createClientFromChannel returns appOnly() for reddit even when channel has no tokens', () => {
  const channel = {
    id: 'ch-1',
    userId: 'u-1',
    platform: 'reddit',
    username: 'foo',
    oauthTokenEncrypted: null,
    refreshTokenEncrypted: null,
  };
  const client = createClientFromChannel('reddit', channel as never);
  expect(client).toBeInstanceOf(RedditClient);
  // appOnly() instances have channelId === 'app-only' per reddit-client.ts:122
  expect((client as never as { channelId: string }).channelId).toBe('app-only');
});
```

- [ ] **Step 3: Run tests**

```bash
pnpm vitest run src/lib/__tests__/platform-deps.test.ts
```

- [ ] **Step 4: Commit**

```bash
git add src/lib/platform-deps.ts src/lib/__tests__/platform-deps.test.ts
git commit -m "feat(platform-deps): reddit channels always use RedditClient.appOnly()

In handoff mode, reddit channels never need write capability and have
null tokens. Returning appOnly() unconditionally avoids null-token
checks at every read path. Direct-post code paths are unreachable for
reddit because dispatch routes to handoff."
```

---

## Task 5: Handoff page — server route + client clipboard

**Why now:** Depends on Task 4's URL builders. The single most user-visible piece.

### Task 5a: Server route

**Files:**
- Create: `src/app/(app)/handoff/reddit/[draftId]/page.tsx`

#### Steps

- [ ] **Step 1: Read existing server-page patterns in (app) group**

```bash
ls src/app/\(app\)/today/
head -60 src/app/\(app\)/today/page.tsx
```

Match auth-loading and Drizzle query style.

- [ ] **Step 2: Create the server component**

Create `src/app/(app)/handoff/reddit/[draftId]/page.tsx`:

```tsx
import { redirect } from 'next/navigation';
import { eq, and } from 'drizzle-orm';
import { auth } from '@/lib/auth';
import { db } from '@/lib/db';
import { drafts, threads } from '@/lib/db/schema';
import { HandoffClient } from './_components/handoff-client';

interface PageProps {
  params: Promise<{ draftId: string }>;
}

export default async function RedditHandoffPage({ params }: PageProps) {
  const { draftId } = await params;
  const session = await auth();

  if (!session?.user?.id) {
    redirect(`/api/auth/signin?callbackUrl=/handoff/reddit/${draftId}`);
  }

  // Load draft scoped to current user.
  const draft = await db.query.drafts.findFirst({
    where: and(eq(drafts.id, draftId), eq(drafts.userId, session.user.id)),
  });

  if (!draft) {
    return (
      <main className="mx-auto max-w-xl p-8">
        <h1 className="text-2xl font-semibold">Draft not found</h1>
        <p className="mt-4 text-muted-foreground">
          This draft was deleted, or it belongs to a different account.
        </p>
        <a href="/today" className="mt-4 inline-block underline">
          ← Back to /today
        </a>
      </main>
    );
  }

  // Terminal-state guard — already-handed-off drafts are idempotent
  // re-visits (page just shows the content again). posted/discarded/failed
  // bounce back to /today.
  if (
    draft.status === 'posted' ||
    draft.status === 'failed' ||
    draft.status === 'flagged'
  ) {
    redirect(`/today?notice=draft_${draft.status}`);
  }

  // Reply-only handoff. Posts go through Reddit's own submit URL, not this page.
  if (draft.draftType !== 'reply') {
    redirect(`/today?notice=not_a_reply_handoff`);
  }

  const thread = await db.query.threads.findFirst({
    where: eq(threads.id, draft.threadId),
  });

  if (!thread) {
    return (
      <main className="mx-auto max-w-xl p-8">
        <h1 className="text-2xl font-semibold">Thread not found</h1>
        <p className="mt-4 text-muted-foreground">
          This thread was deleted from our records. <a href="/today" className="underline">Back to /today</a>
        </p>
      </main>
    );
  }

  // thread.url stored as relative path "/r/sub/comments/..." per existing
  // RedditClient persistence, OR as absolute URL — handle both.
  const threadUrl = thread.url.startsWith('http')
    ? thread.url
    : `https://www.reddit.com${thread.url}`;

  return (
    <main className="mx-auto max-w-2xl p-8">
      <HandoffClient
        draftId={draft.id}
        replyText={draft.replyBody}
        threadUrl={threadUrl}
        threadTitle={thread.title}
        subreddit={thread.community ?? ''}
        author={thread.author ?? ''}
        alreadyHandedOff={draft.status === 'handed_off'}
      />
    </main>
  );
}
```

- [ ] **Step 3: No status mutation here**

Important: the server component does NOT flip `draft.status`. Per Decision 1, status flips when the user clicks an action button on the client. The page is idempotent — repeated visits show the same content.

- [ ] **Step 4: Commit**

```bash
git add src/app/\(app\)/handoff/reddit/
git commit -m "feat(handoff): Reddit handoff page server route

Loads draft scoped to current user, validates draft is a Reddit reply
in pending/approved/handed_off state. No server-side status mutation —
the client component flips status on user action."
```

### Task 5b: Client component

**Files:**
- Create: `src/app/(app)/handoff/reddit/[draftId]/_components/handoff-client.tsx`

#### Steps

- [ ] **Step 1: Create the client component**

Create `src/app/(app)/handoff/reddit/[draftId]/_components/handoff-client.tsx`:

```tsx
'use client';

import { useEffect, useState, useCallback } from 'react';

interface HandoffClientProps {
  draftId: string;
  replyText: string;
  threadUrl: string;
  threadTitle: string;
  subreddit: string;
  author: string;
  alreadyHandedOff: boolean;
}

type Status = 'idle' | 'copied' | 'opened';

export function HandoffClient(props: HandoffClientProps) {
  const [status, setStatus] = useState<Status>('idle');
  const [clipboardError, setClipboardError] = useState(false);

  // Try to copy on mount. Some browsers require a user gesture; if it
  // fails silently, the Copy button still works on click.
  useEffect(() => {
    void tryAutoCopy();

    async function tryAutoCopy() {
      try {
        await navigator.clipboard.writeText(props.replyText);
        setStatus('copied');
      } catch {
        setClipboardError(true);
      }
    }
  }, [props.replyText]);

  const confirmHandoff = useCallback(async () => {
    try {
      await fetch(`/api/draft/${props.draftId}/handoff-confirm`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
      });
    } catch {
      // Non-blocking. The user has already pressed the button — they'll see
      // the Reddit page open. Status flip will retry on next interaction.
    }
  }, [props.draftId]);

  const onCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(props.replyText);
      setStatus('copied');
      setClipboardError(false);
      void confirmHandoff();
    } catch (err) {
      setClipboardError(true);
    }
  }, [props.replyText, confirmHandoff]);

  const onOpenThread = useCallback(async () => {
    // CRITICAL ORDER: write to clipboard BEFORE opening the new tab.
    // Safari and Firefox cancel pending clipboard writes when focus leaves.
    try {
      await navigator.clipboard.writeText(props.replyText);
      setStatus('opened');
    } catch {
      setClipboardError(true);
    }
    void confirmHandoff();
    window.open(props.threadUrl, '_blank', 'noopener,noreferrer');
  }, [props.replyText, props.threadUrl, confirmHandoff]);

  return (
    <article className="space-y-8">
      <header>
        <h1 className="text-2xl font-semibold">Reply on Reddit</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          {props.alreadyHandedOff
            ? 'You already handed off this reply. Re-copy below if you need to.'
            : 'We can\'t post for you on Reddit. Three steps:'}
        </p>
      </header>

      <section>
        <h2 className="text-sm font-medium uppercase tracking-wide">
          Step 1: Copy your reply
        </h2>
        <pre className="mt-2 max-h-96 overflow-y-auto rounded-md bg-muted p-4 font-mono text-sm whitespace-pre-wrap">
          {props.replyText}
        </pre>
        <button
          onClick={onCopy}
          className="mt-3 inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-primary-foreground"
        >
          {status === 'copied' || status === 'opened' ? '✓ Copied' : 'Copy reply'}
        </button>
        {clipboardError && (
          <p className="mt-2 text-sm text-destructive">
            Clipboard access blocked. Click "Copy reply" to try again.
          </p>
        )}
      </section>

      <section>
        <h2 className="text-sm font-medium uppercase tracking-wide">
          Step 2: Open the Reddit thread
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">
          r/{props.subreddit} · u/{props.author} · {props.threadTitle}
        </p>
        <button
          onClick={onOpenThread}
          className="mt-3 inline-flex items-center gap-2 rounded-md border border-primary px-4 py-2"
        >
          Open Reddit thread ↗
        </button>
      </section>

      <section>
        <h2 className="text-sm font-medium uppercase tracking-wide">
          Step 3: Paste with ⌘V (Mac) or Ctrl+V (Windows / Linux), then click Reply on Reddit
        </h2>
      </section>

      <footer className="pt-4 border-t border-border">
        <a href="/today" className="text-sm text-muted-foreground underline">
          ← Back to /today
        </a>
      </footer>
    </article>
  );
}
```

- [ ] **Step 2: Component test**

Create `src/app/(app)/handoff/reddit/[draftId]/_components/__tests__/handoff-client.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { HandoffClient } from '../handoff-client';

beforeEach(() => {
  // Mock clipboard API
  Object.assign(navigator, {
    clipboard: { writeText: vi.fn().mockResolvedValue(undefined) },
  });
  // Mock fetch
  globalThis.fetch = vi.fn().mockResolvedValue({ ok: true });
  // Mock window.open
  globalThis.window.open = vi.fn();
});

describe('HandoffClient', () => {
  const props = {
    draftId: 'd-1',
    replyText: 'Tried this myself, it worked.',
    threadUrl: 'https://www.reddit.com/r/SaaS/comments/1abc234/test',
    threadTitle: 'How do I market',
    subreddit: 'SaaS',
    author: 'foo',
    alreadyHandedOff: false,
  };

  it('attempts auto-copy on mount', async () => {
    render(<HandoffClient {...props} />);
    await waitFor(() => {
      expect(navigator.clipboard.writeText).toHaveBeenCalledWith(props.replyText);
    });
  });

  it('shows ✓ Copied after auto-copy succeeds', async () => {
    render(<HandoffClient {...props} />);
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /copied/i })).toBeInTheDocument();
    });
  });

  it('writes clipboard then opens window in correct order', async () => {
    const order: string[] = [];
    (navigator.clipboard.writeText as ReturnType<typeof vi.fn>).mockImplementation(
      async () => {
        order.push('clipboard');
      },
    );
    (window.open as ReturnType<typeof vi.fn>).mockImplementation(() => {
      order.push('window-open');
    });

    render(<HandoffClient {...props} />);
    fireEvent.click(screen.getByRole('button', { name: /open reddit/i }));

    await waitFor(() => {
      expect(order).toEqual(['clipboard', 'clipboard', 'window-open']);
    });
  });

  it('POSTs to handoff-confirm endpoint on Open click', async () => {
    render(<HandoffClient {...props} />);
    fireEvent.click(screen.getByRole('button', { name: /open reddit/i }));
    await waitFor(() => {
      expect(globalThis.fetch).toHaveBeenCalledWith(
        '/api/draft/d-1/handoff-confirm',
        expect.objectContaining({ method: 'POST' }),
      );
    });
  });

  it('shows error message when clipboard is blocked', async () => {
    (navigator.clipboard.writeText as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('Permission denied'),
    );
    render(<HandoffClient {...props} />);
    await waitFor(() => {
      expect(screen.getByText(/clipboard access blocked/i)).toBeInTheDocument();
    });
  });

  it('shows already-handed-off copy when revisited', () => {
    render(<HandoffClient {...props} alreadyHandedOff />);
    expect(screen.getByText(/already handed off/i)).toBeInTheDocument();
  });
});
```

- [ ] **Step 3: Run tests**

```bash
pnpm vitest run src/app/\(app\)/handoff/reddit/
```

- [ ] **Step 4: Commit**

```bash
git add src/app/\(app\)/handoff/reddit/
git commit -m "feat(handoff): Reddit handoff client component with clipboard

Three-step UX: auto-copy on mount → 'Copy reply' button (always works) →
'Open Reddit thread' which writes clipboard then window.open (in that
order, critical for Safari/Firefox). Posts to handoff-confirm endpoint
on user action — page-load alone does NOT flip status."
```

### Task 5c: Status-flip endpoint

**Files:**
- Create: `src/app/api/draft/[id]/handoff-confirm/route.ts`
- Test: `src/app/api/draft/[id]/handoff-confirm/__tests__/route.test.ts`

#### Steps

- [ ] **Step 1: Write failing test**

Create `src/app/api/draft/[id]/handoff-confirm/__tests__/route.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { POST } from '../route';

vi.mock('@/lib/auth', () => ({
  auth: vi.fn(),
}));

const dbDraftMock = vi.fn();
const dbUpdateMock = vi.fn();
vi.mock('@/lib/db', () => ({
  db: {
    query: { drafts: { findFirst: () => dbDraftMock() } },
    update: () => ({
      set: () => ({
        where: () => dbUpdateMock(),
      }),
    }),
  },
}));

const { auth } = await import('@/lib/auth');
const authMock = auth as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => {
  authMock.mockReset();
  dbDraftMock.mockReset();
  dbUpdateMock.mockReset();
});

function makeReq(): Request {
  return new Request('http://localhost/api/draft/d-1/handoff-confirm', {
    method: 'POST',
  });
}

describe('POST /api/draft/[id]/handoff-confirm', () => {
  it('returns 401 when not authenticated', async () => {
    authMock.mockResolvedValueOnce(null);
    const res = await POST(makeReq(), { params: Promise.resolve({ id: 'd-1' }) });
    expect(res.status).toBe(401);
  });

  it('returns 403 when draft is not owned by user', async () => {
    authMock.mockResolvedValueOnce({ user: { id: 'user-1' } });
    dbDraftMock.mockResolvedValueOnce({ id: 'd-1', userId: 'user-2', status: 'pending' });
    const res = await POST(makeReq(), { params: Promise.resolve({ id: 'd-1' }) });
    expect(res.status).toBe(403);
  });

  it('returns 404 when draft does not exist', async () => {
    authMock.mockResolvedValueOnce({ user: { id: 'user-1' } });
    dbDraftMock.mockResolvedValueOnce(null);
    const res = await POST(makeReq(), { params: Promise.resolve({ id: 'd-1' }) });
    expect(res.status).toBe(404);
  });

  it('flips status from pending → handed_off', async () => {
    authMock.mockResolvedValueOnce({ user: { id: 'user-1' } });
    dbDraftMock.mockResolvedValueOnce({
      id: 'd-1', userId: 'user-1', status: 'pending',
    });
    dbUpdateMock.mockResolvedValueOnce(undefined);
    const res = await POST(makeReq(), { params: Promise.resolve({ id: 'd-1' }) });
    expect(res.status).toBe(200);
    expect(dbUpdateMock).toHaveBeenCalled();
  });

  it('is idempotent on already-handed_off (returns 200, no UPDATE)', async () => {
    authMock.mockResolvedValueOnce({ user: { id: 'user-1' } });
    dbDraftMock.mockResolvedValueOnce({
      id: 'd-1', userId: 'user-1', status: 'handed_off',
    });
    const res = await POST(makeReq(), { params: Promise.resolve({ id: 'd-1' }) });
    expect(res.status).toBe(200);
    expect(dbUpdateMock).not.toHaveBeenCalled();
  });

  it('returns 409 for terminal-bad statuses (posted, failed, flagged)', async () => {
    authMock.mockResolvedValueOnce({ user: { id: 'user-1' } });
    dbDraftMock.mockResolvedValueOnce({
      id: 'd-1', userId: 'user-1', status: 'posted',
    });
    const res = await POST(makeReq(), { params: Promise.resolve({ id: 'd-1' }) });
    expect(res.status).toBe(409);
  });
});
```

- [ ] **Step 2: Run test, verify it fails**

```bash
pnpm vitest run src/app/api/draft/\[id\]/handoff-confirm/
```

Expected: FAIL — route file missing.

- [ ] **Step 3: Implement the route**

Create `src/app/api/draft/[id]/handoff-confirm/route.ts`:

```ts
import { NextResponse, type NextRequest } from 'next/server';
import { eq } from 'drizzle-orm';
import { auth } from '@/lib/auth';
import { db } from '@/lib/db';
import { drafts } from '@/lib/db/schema';
import { createLogger, loggerForRequest } from '@/lib/logger';

const baseLog = createLogger('api:draft:handoff-confirm');

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { log } = loggerForRequest(baseLog, request);

  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { id } = await params;
  if (!id) {
    return NextResponse.json({ error: 'invalid_id' }, { status: 400 });
  }

  const draft = await db.query.drafts.findFirst({
    where: eq(drafts.id, id),
  });

  if (!draft) {
    return NextResponse.json({ error: 'not_found' }, { status: 404 });
  }

  if (draft.userId !== session.user.id) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }

  // Idempotent: already-handed-off drafts return 200 without UPDATE.
  if (draft.status === 'handed_off') {
    return NextResponse.json({ success: true, alreadyHandedOff: true });
  }

  // Only pending / approved drafts can transition to handed_off here.
  if (draft.status !== 'pending' && draft.status !== 'approved') {
    log.warn(
      `handoff-confirm refused: draft ${id} status is ${draft.status}, expected pending|approved|handed_off`,
    );
    return NextResponse.json(
      { error: 'invalid_transition', currentStatus: draft.status },
      { status: 409 },
    );
  }

  await db
    .update(drafts)
    .set({ status: 'handed_off', updatedAt: new Date() })
    .where(eq(drafts.id, id));

  log.info(`draft ${id} handed off via clipboard page`);
  return NextResponse.json({ success: true });
}
```

- [ ] **Step 4: Run tests, verify pass**

```bash
pnpm vitest run src/app/api/draft/\[id\]/handoff-confirm/
```

Expected: 6 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/app/api/draft/
git commit -m "feat(api): /api/draft/[id]/handoff-confirm flips status

Idempotent POST. Auth-scoped to draft owner. Transitions pending|approved
→ handed_off. Refuses with 409 from any terminal status. Called by the
Reddit handoff client component on Copy / Open user actions."
```

---

## Task 6: Onboarding — handle input, verify, repurposed routes

**Why now:** Independent of dispatch and discovery. Depends on Task 1's nullable schema.

### Task 6a: getUserAboutPublic + verify-handle endpoint

**Files:**
- Modify: `src/lib/reddit-client.ts` (add `getUserAboutPublic`)
- Create: `src/app/api/reddit/verify-handle/route.ts`
- Test: `src/app/api/reddit/verify-handle/__tests__/route.test.ts`

#### Steps

- [ ] **Step 1: Add public profile lookup to RedditClient**

In `src/lib/reddit-client.ts`, near `getAccountInfo` (line 470), add:

```ts
/**
 * Public profile lookup — does NOT require auth. Used by handle-verify
 * during onboarding. Returns null on 404 (handle does not exist) and
 * throws on network / 5xx so the caller can distinguish "not found"
 * from "we couldn't check."
 */
async getUserAboutPublic(
  username: string,
): Promise<{ name: string; total_karma: number; created_utc: number } | null> {
  // Strip leading u/ if accidentally included.
  const handle = username.replace(/^u\//, '').trim();
  if (!handle) {
    throw new Error('getUserAboutPublic: username is required');
  }
  // Use the unauthenticated public JSON endpoint.
  const url = `https://www.reddit.com/user/${encodeURIComponent(handle)}/about.json`;
  const response = await fetch(url, {
    headers: { 'User-Agent': 'ShipFlare/1.0.0' },
  });
  if (response.status === 404) return null;
  if (!response.ok) {
    throw new Error(
      `getUserAboutPublic: HTTP ${response.status} for u/${handle}`,
    );
  }
  const data = (await response.json()) as {
    data?: { name?: string; total_karma?: number; created_utc?: number };
  };
  if (!data.data || !data.data.name) return null;
  return {
    name: data.data.name,
    total_karma: data.data.total_karma ?? 0,
    created_utc: data.data.created_utc ?? 0,
  };
}
```

This is a **static** helper — it doesn't need `RedditClient` instance state. Could be moved to a module-level export later, but staying on the class for grep-ability.

- [ ] **Step 2: Write failing test for verify-handle endpoint**

Create `src/app/api/reddit/verify-handle/__tests__/route.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { POST } from '../route';

vi.mock('@/lib/auth', () => ({ auth: vi.fn() }));

const getUserAboutPublicMock = vi.fn();
vi.mock('@/lib/reddit-client', () => ({
  RedditClient: {
    appOnly: () => ({ getUserAboutPublic: getUserAboutPublicMock }),
  },
}));

const { auth } = await import('@/lib/auth');
const authMock = auth as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => {
  authMock.mockReset();
  getUserAboutPublicMock.mockReset();
  authMock.mockResolvedValue({ user: { id: 'user-1' } });
});

function makeReq(body: Record<string, unknown>): Request {
  return new Request('http://localhost/api/reddit/verify-handle', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('POST /api/reddit/verify-handle', () => {
  it('returns 401 when not authenticated', async () => {
    authMock.mockResolvedValueOnce(null);
    const res = await POST(makeReq({ handle: 'foo' }));
    expect(res.status).toBe(401);
  });

  it('returns 400 for invalid handle (too short)', async () => {
    const res = await POST(makeReq({ handle: 'fo' }));
    expect(res.status).toBe(400);
  });

  it('returns 400 for invalid handle (special chars)', async () => {
    const res = await POST(makeReq({ handle: 'foo@bar' }));
    expect(res.status).toBe(400);
  });

  it('returns { exists: true, karma } when handle exists', async () => {
    getUserAboutPublicMock.mockResolvedValueOnce({
      name: 'foo', total_karma: 1500, created_utc: 1700000000,
    });
    const res = await POST(makeReq({ handle: 'foo' }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ exists: true, karma: 1500 });
  });

  it('returns { exists: false } on 404', async () => {
    getUserAboutPublicMock.mockResolvedValueOnce(null);
    const res = await POST(makeReq({ handle: 'foo' }));
    expect(await res.json()).toEqual({ exists: false });
  });

  it('returns { exists: null, error } on transient failure', async () => {
    getUserAboutPublicMock.mockRejectedValueOnce(new Error('HTTP 503'));
    const res = await POST(makeReq({ handle: 'foo' }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ exists: null, error: 'reddit_unavailable' });
  });

  it('strips leading u/ from handle', async () => {
    getUserAboutPublicMock.mockResolvedValueOnce({
      name: 'foo', total_karma: 100, created_utc: 0,
    });
    await POST(makeReq({ handle: 'u/foo' }));
    expect(getUserAboutPublicMock).toHaveBeenCalledWith('foo');
  });
});
```

- [ ] **Step 3: Run test, verify it fails**

```bash
pnpm vitest run src/app/api/reddit/verify-handle/
```

- [ ] **Step 4: Implement verify-handle route**

Create `src/app/api/reddit/verify-handle/route.ts`:

```ts
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { auth } from '@/lib/auth';
import { RedditClient } from '@/lib/reddit-client';
import { createLogger, loggerForRequest } from '@/lib/logger';

const baseLog = createLogger('api:reddit:verify-handle');

const bodySchema = z.object({
  handle: z
    .string()
    .min(1)
    .max(40)
    .transform((s) => s.replace(/^u\//, '').trim())
    .refine((s) => /^[A-Za-z0-9_-]{3,20}$/.test(s), {
      message: 'Reddit handles must be 3-20 chars: letters, digits, _ or -.',
    }),
});

export async function POST(request: Request): Promise<Response> {
  const { log } = loggerForRequest(baseLog, request);

  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const json = await request.json().catch(() => null);
  const parsed = bodySchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'invalid_handle', detail: parsed.error.message },
      { status: 400 },
    );
  }

  try {
    const profile = await RedditClient.appOnly().getUserAboutPublic(parsed.data.handle);
    if (!profile) {
      return NextResponse.json({ exists: false });
    }
    return NextResponse.json({ exists: true, karma: profile.total_karma });
  } catch (err) {
    log.warn(
      `verify-handle transient error for u/${parsed.data.handle}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return NextResponse.json({ exists: null, error: 'reddit_unavailable' });
  }
}
```

- [ ] **Step 5: Run tests, verify pass**

```bash
pnpm vitest run src/app/api/reddit/verify-handle/ src/lib/__tests__/reddit-client.test.ts
```

- [ ] **Step 6: Commit**

```bash
git add src/lib/reddit-client.ts src/app/api/reddit/verify-handle/
git commit -m "feat(reddit): public handle verify endpoint

Adds RedditClient.getUserAboutPublic (no-auth /user/{u}/about.json)
and POST /api/reddit/verify-handle. Returns { exists: true, karma } on
match, { exists: false } on 404, { exists: null, error } on transient
failure (non-blocking — frontend treats as 'unverified, allow continue')."
```

### Task 6b: RedditHandleInput component

**Files:**
- Create: `src/components/onboarding/reddit-handle-input.tsx`
- Test: `src/components/onboarding/__tests__/reddit-handle-input.test.tsx`

#### Steps

- [ ] **Step 1: Create the component**

Create `src/components/onboarding/reddit-handle-input.tsx`:

```tsx
'use client';

import { useState, useCallback } from 'react';

interface RedditHandleInputProps {
  initialHandle?: string;
  onSubmit: (handle: string, verified: boolean) => void | Promise<void>;
}

type VerifyState =
  | { phase: 'idle' }
  | { phase: 'verifying' }
  | { phase: 'verified'; karma: number }
  | { phase: 'not_found' }
  | { phase: 'unavailable' };

export function RedditHandleInput({
  initialHandle = '',
  onSubmit,
}: RedditHandleInputProps) {
  const [handle, setHandle] = useState(initialHandle);
  const [verifyState, setVerifyState] = useState<VerifyState>({ phase: 'idle' });
  const [softBlockOpen, setSoftBlockOpen] = useState(false);

  const onVerify = useCallback(async () => {
    if (!handle.trim()) return;
    setVerifyState({ phase: 'verifying' });
    try {
      const res = await fetch('/api/reddit/verify-handle', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ handle }),
      });
      const json = (await res.json()) as
        | { exists: true; karma: number }
        | { exists: false }
        | { exists: null; error: string };
      if (json.exists === true) {
        setVerifyState({ phase: 'verified', karma: json.karma });
      } else if (json.exists === false) {
        setVerifyState({ phase: 'not_found' });
      } else {
        setVerifyState({ phase: 'unavailable' });
      }
    } catch {
      setVerifyState({ phase: 'unavailable' });
    }
  }, [handle]);

  const onConnect = useCallback(() => {
    if (verifyState.phase === 'verified') {
      void onSubmit(handle, true);
      return;
    }
    if (verifyState.phase === 'not_found') {
      setSoftBlockOpen(true);
      return;
    }
    // idle / verifying / unavailable: allow with verified=false
    void onSubmit(handle, false);
  }, [handle, verifyState, onSubmit]);

  const onContinueAnyway = useCallback(() => {
    setSoftBlockOpen(false);
    void onSubmit(handle, false);
  }, [handle, onSubmit]);

  return (
    <div className="space-y-4">
      <label htmlFor="reddit-handle" className="block text-sm font-medium">
        Your Reddit username
      </label>
      <div className="flex gap-2">
        <span className="flex items-center px-2 text-muted-foreground">u/</span>
        <input
          id="reddit-handle"
          type="text"
          value={handle}
          onChange={(e) => {
            setHandle(e.target.value.replace(/^u\//, ''));
            setVerifyState({ phase: 'idle' });
          }}
          placeholder="founder123"
          className="flex-1 rounded-md border border-input px-3 py-2 text-sm"
        />
        <button
          type="button"
          onClick={onVerify}
          disabled={!handle.trim() || verifyState.phase === 'verifying'}
          className="rounded-md border border-input px-4 py-2 text-sm"
        >
          {verifyState.phase === 'verifying' ? 'Checking…' : 'Verify'}
        </button>
      </div>

      {verifyState.phase === 'verified' && (
        <p className="text-sm text-success">
          ✓ Verified — u/{handle} has {verifyState.karma.toLocaleString()} karma.
        </p>
      )}
      {verifyState.phase === 'not_found' && (
        <p className="text-sm text-warning">
          We couldn't find u/{handle}. Double-check the spelling, or continue anyway if you're sure.
        </p>
      )}
      {verifyState.phase === 'unavailable' && (
        <p className="text-sm text-muted-foreground">
          Reddit is rate-limiting us right now — we couldn't verify the handle. You can continue.
        </p>
      )}

      <p className="text-sm text-muted-foreground">
        ⓘ We never post for you. You'll click through to Reddit yourself to post each draft.
      </p>

      <button
        type="button"
        onClick={onConnect}
        disabled={!handle.trim()}
        className="rounded-md bg-primary px-4 py-2 text-primary-foreground"
      >
        Connect
      </button>

      {softBlockOpen && (
        <div role="dialog" className="mt-4 rounded-md border border-warning bg-warning/10 p-4">
          <p className="text-sm">
            We couldn't confirm u/{handle} exists. Are you sure?
          </p>
          <div className="mt-3 flex gap-2">
            <button onClick={onContinueAnyway} className="rounded-md bg-primary px-3 py-1.5 text-sm text-primary-foreground">
              Continue anyway
            </button>
            <button onClick={() => setSoftBlockOpen(false)} className="rounded-md border px-3 py-1.5 text-sm">
              Edit handle
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Component test**

Create `src/components/onboarding/__tests__/reddit-handle-input.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { RedditHandleInput } from '../reddit-handle-input';

beforeEach(() => {
  globalThis.fetch = vi.fn();
});

describe('RedditHandleInput', () => {
  it('strips u/ prefix from typed input', async () => {
    const onSubmit = vi.fn();
    render(<RedditHandleInput onSubmit={onSubmit} />);
    const input = screen.getByLabelText(/your reddit username/i) as HTMLInputElement;
    await userEvent.type(input, 'u/foo');
    expect(input.value).toBe('foo');
  });

  it('shows verified state after Verify succeeds', async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      json: async () => ({ exists: true, karma: 1234 }),
    });
    render(<RedditHandleInput onSubmit={vi.fn()} />);
    await userEvent.type(screen.getByLabelText(/your reddit username/i), 'foo');
    fireEvent.click(screen.getByRole('button', { name: /verify/i }));
    await waitFor(() => {
      expect(screen.getByText(/1,234 karma/i)).toBeInTheDocument();
    });
  });

  it('shows soft-block dialog on Connect when handle not found', async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      json: async () => ({ exists: false }),
    });
    const onSubmit = vi.fn();
    render(<RedditHandleInput onSubmit={onSubmit} />);
    await userEvent.type(screen.getByLabelText(/your reddit username/i), 'foo');
    fireEvent.click(screen.getByRole('button', { name: /verify/i }));
    await waitFor(() => screen.getByText(/we couldn't find u\/foo/i));
    fireEvent.click(screen.getByRole('button', { name: /connect/i }));
    expect(screen.getByText(/are you sure/i)).toBeInTheDocument();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('Continue anyway calls onSubmit with verified=false', async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      json: async () => ({ exists: false }),
    });
    const onSubmit = vi.fn();
    render(<RedditHandleInput onSubmit={onSubmit} />);
    await userEvent.type(screen.getByLabelText(/your reddit username/i), 'foo');
    fireEvent.click(screen.getByRole('button', { name: /verify/i }));
    await waitFor(() => screen.getByText(/we couldn't find/i));
    fireEvent.click(screen.getByRole('button', { name: /connect/i }));
    fireEvent.click(screen.getByRole('button', { name: /continue anyway/i }));
    expect(onSubmit).toHaveBeenCalledWith('foo', false);
  });

  it('verified state submits with verified=true', async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      json: async () => ({ exists: true, karma: 100 }),
    });
    const onSubmit = vi.fn();
    render(<RedditHandleInput onSubmit={onSubmit} />);
    await userEvent.type(screen.getByLabelText(/your reddit username/i), 'foo');
    fireEvent.click(screen.getByRole('button', { name: /verify/i }));
    await waitFor(() => screen.getByText(/✓ verified/i));
    fireEvent.click(screen.getByRole('button', { name: /connect/i }));
    expect(onSubmit).toHaveBeenCalledWith('foo', true);
  });
});
```

- [ ] **Step 3: Run tests**

```bash
pnpm vitest run src/components/onboarding/__tests__/reddit-handle-input.test.tsx
```

- [ ] **Step 4: Commit**

```bash
git add src/components/onboarding/reddit-handle-input.tsx src/components/onboarding/__tests__/reddit-handle-input.test.tsx
git commit -m "feat(onboarding): RedditHandleInput component with verify + soft-block"
```

### Task 6c: Repurpose `/api/reddit/connect` route

**Files:**
- Modify: `src/app/api/reddit/connect/route.ts`
- Test: `src/app/api/reddit/connect/__tests__/route.test.ts`

#### Steps

- [ ] **Step 1: Read existing OAuth init handler**

```bash
cat src/app/api/reddit/connect/route.ts
```

- [ ] **Step 2: Replace with form POST handler**

```ts
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { eq, and } from 'drizzle-orm';
import { auth } from '@/lib/auth';
import { db } from '@/lib/db';
import { channels } from '@/lib/db/schema';
import { createLogger } from '@/lib/logger';

const log = createLogger('api:reddit:connect');

const bodySchema = z.object({
  handle: z
    .string()
    .min(3)
    .max(20)
    .regex(/^[A-Za-z0-9_-]+$/, 'Reddit handles use letters, digits, underscores, dashes only.'),
});

export async function POST(request: Request): Promise<Response> {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const json = await request.json().catch(() => null);
  const parsed = bodySchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'invalid_handle', detail: parsed.error.message },
      { status: 400 },
    );
  }

  // Upsert: one Reddit channel per user.
  await db
    .insert(channels)
    .values({
      userId: session.user.id,
      platform: 'reddit',
      username: parsed.data.handle,
      oauthTokenEncrypted: null,
      refreshTokenEncrypted: null,
    })
    .onConflictDoUpdate({
      target: [channels.userId, channels.platform],
      set: { username: parsed.data.handle, updatedAt: new Date() },
    });

  log.info(`reddit channel connected for user ${session.user.id}: u/${parsed.data.handle}`);
  return NextResponse.json({ success: true });
}
```

(If the existing route was a GET-redirect for OAuth init: REMOVE the GET export entirely. We do not want both shapes coexisting.)

- [ ] **Step 3: Tests**

Create `src/app/api/reddit/connect/__tests__/route.test.ts`:

```ts
// Similar shape to verify-handle test:
//   - 401 unauth
//   - 400 invalid handle
//   - 200 + channels row written for valid handle
//   - 200 + UPDATE on conflict (re-running connect updates handle)
```

- [ ] **Step 4: Run tests**

```bash
pnpm vitest run src/app/api/reddit/connect/
```

- [ ] **Step 5: Commit**

```bash
git add src/app/api/reddit/connect/
git commit -m "feat(onboarding): repurpose /api/reddit/connect to form POST

Was: OAuth init redirect.
Now: write channels row with handle, no tokens. Handles upsert so
re-running connect updates the handle (e.g. user fixed typo)."
```

### Task 6d: Graceful redirect for `/api/reddit/callback`

**Files:**
- Modify: `src/app/api/reddit/callback/route.ts`
- Test: `src/app/api/reddit/callback/__tests__/route.test.ts`

#### Steps

- [ ] **Step 1: Replace OAuth callback with redirect**

```ts
import { NextResponse } from 'next/server';
import { createLogger } from '@/lib/logger';

const log = createLogger('api:reddit:callback');

/**
 * Legacy OAuth callback — Reddit no longer uses OAuth in handoff mode.
 * Anyone hitting this route has a stale bookmark, an in-flight redirect,
 * or is testing the deleted OAuth flow. 308-redirect to onboarding so
 * they can re-enter their handle.
 */
export async function GET(request: Request): Promise<Response> {
  log.warn(`legacy reddit OAuth callback hit: ${request.url}`);
  return NextResponse.redirect(
    new URL('/onboarding?reconnect=reddit&from=oauth_legacy', request.url),
    308,
  );
}
```

Remove the existing OAuth code-exchange logic entirely. Delete any imports that became unused.

- [ ] **Step 2: Test**

Create `src/app/api/reddit/callback/__tests__/route.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { GET } from '../route';

describe('GET /api/reddit/callback (legacy redirect)', () => {
  it('returns 308 redirect to /onboarding', async () => {
    const req = new Request('http://localhost/api/reddit/callback?code=stale');
    const res = await GET(req);
    expect(res.status).toBe(308);
    expect(res.headers.get('location')).toBe(
      'http://localhost/onboarding?reconnect=reddit&from=oauth_legacy',
    );
  });
});
```

- [ ] **Step 3: Run test**

```bash
pnpm vitest run src/app/api/reddit/callback/
```

- [ ] **Step 4: Commit**

```bash
git add src/app/api/reddit/callback/
git commit -m "feat(onboarding): /api/reddit/callback now redirects to onboarding

Reddit no longer uses OAuth. Legacy callback hits (bookmarks, in-flight
redirects from before this change) get 308'd to /onboarding instead of
404'ing or processing a code that no longer matches an OAuth app."
```

### Task 6e: Update stage-connect Reddit card

**Files:**
- Modify: `src/components/onboarding/stage-connect.tsx`

#### Steps

- [ ] **Step 1: Find the Reddit card**

```bash
grep -n "reddit\|Reddit\|comingSoon" src/components/onboarding/stage-connect.tsx
```

- [ ] **Step 2: Swap OAuth click handler for handle input**

Replace the Reddit card's body (the part wrapped by `comingSoon={!REDDIT_DRAFT_ENABLED}`) with `<RedditHandleInput />`. Wire `onSubmit(handle, verified)` to call `POST /api/reddit/connect`. On 200, advance to the next onboarding stage. Remove the `comingSoon` prop entirely (Task 7 removes the stale flag check).

```tsx
import { RedditHandleInput } from './reddit-handle-input';

// Inside stage-connect.tsx, replace the existing Reddit card content:
{platform === 'reddit' && (
  <RedditHandleInput
    onSubmit={async (handle, _verified) => {
      const res = await fetch('/api/reddit/connect', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ handle }),
      });
      if (res.ok) {
        // advance onboarding stage
        onConnected('reddit');
      }
    }}
  />
)}
```

- [ ] **Step 3: Visual verification**

Run dev server and load `/onboarding`:

```bash
pnpm dev
```

Manually confirm the Reddit card now shows the handle input + Verify button + explainer text. Take a screenshot for the PR description.

- [ ] **Step 4: Commit**

```bash
git add src/components/onboarding/stage-connect.tsx
git commit -m "feat(onboarding): Reddit card uses handle input, not OAuth"
```

### Task 6f: Settings page handle edit

**Files:**
- Modify: `src/app/(app)/settings/` (find the channels section)

#### Steps

- [ ] **Step 1: Locate the channel display section in settings**

```bash
find src/app/\(app\)/settings -name "*.tsx" | xargs grep -l "channel\|reddit" 2>/dev/null
```

- [ ] **Step 2: For Reddit channel rows, render the same RedditHandleInput**

Render `<RedditHandleInput initialHandle={channel.username} onSubmit={...} />`, with the on-submit handler calling the same `/api/reddit/connect` POST (it's already idempotent and upserts).

Add a "Disconnect" button that POSTs to a new `/api/reddit/disconnect` route, which DELETEs the channels row.

- [ ] **Step 3: Add /api/reddit/disconnect**

Create `src/app/api/reddit/disconnect/route.ts` — DELETE handler scoped to current user, deletes the (userId, platform='reddit') channels row. Cascade deletes on threads keep DB consistent.

- [ ] **Step 4: Tests**

Add settings-page render test if one exists. Otherwise verify manually.

- [ ] **Step 5: Commit**

```bash
git add src/app/\(app\)/settings/ src/app/api/reddit/disconnect/
git commit -m "feat(settings): Reddit channel edit + disconnect"
```

---

## Task 7: Flips + UI sweep

**Why now:** All previous tasks must be merged before flipping `enabled: true` (otherwise users hit half-built code paths).

**Files:**
- Modify: `src/lib/platform-config.ts`
- Modify: `src/components/onboarding/_feature-flags.ts`
- Modify: `src/components/onboarding/stage-connect.tsx` (final cleanup of `comingSoon`)
- Multiple files via grep (X-only filter sweep)

### Steps

- [ ] **Step 1: Flip enabled flag**

In `src/lib/platform-config.ts`, change line ~117:

```ts
enabled: false,  // was
enabled: true,   // now
```

- [ ] **Step 2: Flip draft-enabled flag**

In `src/components/onboarding/_feature-flags.ts`:

```ts
export const REDDIT_DRAFT_ENABLED = true;  // was false
```

- [ ] **Step 3: Remove `comingSoon` from Reddit card**

Find any `comingSoon={!REDDIT_DRAFT_ENABLED}` references in `stage-connect.tsx` and delete them. The card is permanently visible now.

- [ ] **Step 4: X-only filter sweep**

Run:

```bash
grep -rn "platform.*===.*'x'\|platform.*=== 'x'\|where.*platform.*x\b" src/app/\(app\)/ src/components/
```

For each match, decide:
- Deliberate X-only feature → leave alone, comment why
- Stale assumption → extend to handle Reddit
- UI conditional that should now light up Reddit → update

Document the audit results in PR description (one-liner per touchpoint).

- [ ] **Step 5: Landing page copy check**

```bash
grep -rn "X-only\|X (Twitter)-only\|reddit.*coming soon\|coming soon.*reddit" src/components/marketing/
```

Update any "X-only" claims if they exist in the marketing copy. Don't make over-promises about Reddit features yet — just remove "X-only" exclusivity language.

- [ ] **Step 6: Smoke test**

Start dev server, log in as a test user, visit `/onboarding`. Confirm the Reddit card is visible and the handle input works. Visit `/today` — the Reddit-relevant pieces should NOT show "coming soon" badges.

- [ ] **Step 7: Commit**

```bash
git add -p
# Stage only the flag flips and X-only sweep (not the audit doc).
git commit -m "feat(reddit): flip enabled=true, REDDIT_DRAFT_ENABLED=true

Reddit channel is live. Discovery via xAI Grok web_search restricted to
reddit.com; drafts go through the same skill as X with reddit-specific
rules; approval routes to handoff URL (post) or handoff page (reply).

X-only filter sweep audit: see PR description."
```

---

## Task 8: Real-browser Playwright smoke test

**Why last:** Verifies the whole flow end-to-end. Must pass before merging.

**Files:**
- Create: `e2e/tests/reddit-handoff.spec.ts`

### Steps

- [ ] **Step 1: Read existing Playwright fixture pattern**

```bash
head -80 e2e/tests/onboarding.spec.ts
```

Match the import shape (`test as base, expect`, fixtures from `../fixtures/db`, `dotenv` config).

- [ ] **Step 2: Write the spec**

Create `e2e/tests/reddit-handoff.spec.ts`:

```ts
import { test, expect } from '@playwright/test';
import { config } from 'dotenv';
import { eq, and } from 'drizzle-orm';
import {
  seedSession,
  seedChannel,
  seedThread,
  seedDraft,
  getTestDb,
} from '../fixtures/db';
import { drafts, channels, threads } from '../../src/lib/db/schema';

config({ path: '.env.local' });

const TEST_USER_HANDLE = 'shipflare-test-2026';
const TEST_SUBREDDIT = 'test'; // r/test is Reddit's official sandbox

test.describe('Reddit handoff — full pipeline', () => {
  test('connect flow: handle input → channels row written', async ({
    page,
    context,
  }) => {
    const { userId, sessionToken } = await seedSession();
    await context.addCookies([
      {
        name: 'authjs.session-token',
        value: sessionToken,
        domain: 'localhost',
        path: '/',
        httpOnly: true,
      },
    ]);

    await page.goto('/onboarding');
    // Find the Reddit card and click into the handle input.
    await page.getByLabel(/your reddit username/i).fill(TEST_USER_HANDLE);
    await page.getByRole('button', { name: /verify/i }).click();
    await expect(page.getByText(/✓ verified|we couldn't find/i)).toBeVisible();
    await page.getByRole('button', { name: /connect/i }).click();

    // If unverified, click Continue anyway in soft block.
    const softBlock = page.getByText(/are you sure/i);
    if (await softBlock.isVisible({ timeout: 1000 }).catch(() => false)) {
      await page.getByRole('button', { name: /continue anyway/i }).click();
    }

    // Verify channels row was written.
    const db = getTestDb();
    const row = await db.query.channels.findFirst({
      where: and(eq(channels.userId, userId), eq(channels.platform, 'reddit')),
    });
    expect(row?.username).toBe(TEST_USER_HANDLE);
    expect(row?.oauthTokenEncrypted).toBeNull();
  });

  test('reply handoff: page renders, clipboard write, status flips', async ({
    page,
    context,
  }) => {
    const { userId, sessionToken } = await seedSession();
    await context.addCookies([
      {
        name: 'authjs.session-token',
        value: sessionToken,
        domain: 'localhost',
        path: '/',
        httpOnly: true,
      },
    ]);

    // Seed channel + thread + draft.
    await seedChannel({
      userId,
      platform: 'reddit',
      username: TEST_USER_HANDLE,
      oauthTokenEncrypted: null,
      refreshTokenEncrypted: null,
    });
    const thread = await seedThread({
      userId,
      platform: 'reddit',
      community: TEST_SUBREDDIT,
      title: 'Test thread for ShipFlare handoff',
      url: `https://www.reddit.com/r/${TEST_SUBREDDIT}/comments/test1234/test`,
      author: 'someone-else',
    });
    const replyText = 'Tried this in my own SaaS, the trick was X.';
    const draft = await seedDraft({
      userId,
      threadId: thread.id,
      draftType: 'reply',
      replyBody: replyText,
      status: 'pending',
    });

    // Grant clipboard read permission for the test browser.
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);

    await page.goto(`/handoff/reddit/${draft.id}`);
    // Page renders the reply text + Open button.
    await expect(page.getByText(replyText)).toBeVisible();
    await expect(page.getByRole('button', { name: /open reddit/i })).toBeVisible();

    // Click Open. Listen for the new tab popup.
    const popupPromise = context.waitForEvent('page');
    await page.getByRole('button', { name: /open reddit/i }).click();
    const popup = await popupPromise;
    expect(popup.url()).toContain(`reddit.com/r/${TEST_SUBREDDIT}/comments/test1234`);
    await popup.close();

    // Clipboard contains reply text.
    const clipboard = await page.evaluate(() => navigator.clipboard.readText());
    expect(clipboard).toBe(replyText);

    // Wait for the handoff-confirm POST to land.
    await page.waitForTimeout(500);

    // DB: status flipped to handed_off.
    const db = getTestDb();
    const row = await db.query.drafts.findFirst({ where: eq(drafts.id, draft.id) });
    expect(row?.status).toBe('handed_off');

    // Cleanup
    await db.delete(drafts).where(eq(drafts.userId, userId));
    await db.delete(threads).where(eq(threads.userId, userId));
  });

  test('post handoff: dispatch returns submit URL with title + selftext', async ({
    request,
    context,
  }) => {
    const { userId, sessionToken } = await seedSession();
    await context.addCookies([
      {
        name: 'authjs.session-token',
        value: sessionToken,
        domain: 'localhost',
        path: '/',
        httpOnly: true,
      },
    ]);

    await seedChannel({ userId, platform: 'reddit', username: TEST_USER_HANDLE });
    const thread = await seedThread({
      userId,
      platform: 'reddit',
      community: TEST_SUBREDDIT,
    });
    const draft = await seedDraft({
      userId,
      threadId: thread.id,
      draftType: 'original_post',
      postTitle: 'Test post title',
      replyBody: 'Test selftext body.',
      status: 'pending',
    });

    const res = await request.patch(`/api/today/${draft.id}/approve`);
    const json = (await res.json()) as { browserHandoff?: { intentUrl: string } };
    expect(json.browserHandoff?.intentUrl).toContain(`/r/${TEST_SUBREDDIT}/submit`);
    expect(json.browserHandoff?.intentUrl).toContain('title=Test+post+title');
    expect(json.browserHandoff?.intentUrl).toContain('selftext=Test+selftext+body.');

    // Status: handed_off (post flips on dispatch, not on user action).
    const db = getTestDb();
    const row = await db.query.drafts.findFirst({ where: eq(drafts.id, draft.id) });
    expect(row?.status).toBe('handed_off');
  });

  test('throttle: handed_off reply excludes that author from next discovery', async () => {
    // Seed one handed_off reply for u/foo. Run discovery for the same user
    // with a mocked xAI response that includes a thread by u/foo. Assert
    // u/foo is in the excludeAuthors injection of the next discovery call.
    // (This is a unit test wrapped in a Playwright spec for end-to-end; if
    // the test is too coupled to internals, skip and rely on Task 2's
    // existing throttle test.)
  });

  test('stale-sweeper: pending Reddit draft > 24h transitions to discarded', async () => {
    // Seed a pending reply with createdAt - 25h. Run staleSweeper.
    // Assert status flipped to 'discarded'.
  });

  test('regression: X reply flow still works', async ({ page, context }) => {
    // Smoke check existing X handoff. Should be unchanged by this PR.
    // Skip if the existing X test is comprehensive — don't double-cover.
  });

  test('verify-handle 404 shows soft-block dialog', async ({ page, context }) => {
    const { sessionToken } = await seedSession();
    await context.addCookies([
      {
        name: 'authjs.session-token',
        value: sessionToken,
        domain: 'localhost',
        path: '/',
        httpOnly: true,
      },
    ]);

    await page.goto('/onboarding');
    await page
      .getByLabel(/your reddit username/i)
      .fill('definitely-not-a-real-handle-2026-zzzz');
    await page.getByRole('button', { name: /verify/i }).click();
    await expect(page.getByText(/we couldn't find/i)).toBeVisible({ timeout: 5000 });
    await page.getByRole('button', { name: /connect/i }).click();
    await expect(page.getByText(/are you sure/i)).toBeVisible();
  });
});
```

- [ ] **Step 3: Add seedChannel / seedThread / seedDraft fixtures**

If they don't already exist in `e2e/fixtures/db.ts`, add them. Mirror `seedSession` and `seedTeam` shape.

- [ ] **Step 4: Run Playwright with --headed (clipboard requires real browser context)**

```bash
pnpm exec playwright test e2e/tests/reddit-handoff.spec.ts --headed --project=chromium
```

Expected: all scenarios pass (or marked `.skip` for ones that need infra not yet built — TODO list in Task 8 Step 2).

- [ ] **Step 5: Iterate on test failures**

If clipboard tests fail in headless mode, keep `--headed`. If `seedChannel` doesn't exist yet, create it as the first iteration.

- [ ] **Step 6: Commit**

```bash
git add e2e/tests/reddit-handoff.spec.ts e2e/fixtures/db.ts
git commit -m "test(e2e): Reddit handoff full-pipeline smoke

Covers: connect flow with verify, reply handoff with clipboard +
status flip, post handoff with dispatch URL shape, verify-handle 404
soft-block. Stale-sweeper + throttle scenarios stubbed for follow-up
if not already covered by unit tests."
```

---

## Real-browser smoke test (manual checklist before merging)

Before opening PR, manually verify in the dev environment with a real Reddit test account:

- [ ] Onboarding: Reddit card shows handle input, verify works for real handle, soft-block fires for fake handle, Connect creates `channels` row visible in DB.
- [ ] `/today`: A pending Reddit reply draft has an "Approve" button; clicking it returns the handoff page URL.
- [ ] Handoff page: reply text is visible; "Copy reply" copies to system clipboard; "Open Reddit thread" opens Reddit in a new tab AND clipboard still has the reply text.
- [ ] On the Reddit thread page in the new tab: ⌘V pastes the reply correctly. Click Reply on Reddit. Comment appears.
- [ ] Back in ShipFlare: refresh `/today`. Draft status shows `handed_off`.
- [ ] Run a second discovery pass; the Reddit user we just replied to is NOT surfaced again (throttle).
- [ ] Reddit content_post approval: dispatched URL points to `https://www.reddit.com/r/<sub>/submit?...` with title + selftext params. Clicking the URL opens Reddit's submit form correctly pre-filled.
- [ ] X reply flow still works (regression check).
- [ ] Handoff page revisited shows "you already handed off" copy.

---

## Out of scope (explicit non-goals this sprint)

- Reddit OAuth direct-post path. Additive when commercial-tier API access lands.
- Browser extension for one-click DOM injection. Defer until retention data justifies.
- "I posted it ✓" / "I changed my mind ✗" confirmation buttons. Trust handoff for MVP.
- Reddit DM compose URL handler.
- Reddit link posts (`?type=link&url=`) — drafting produces self posts only.
- Cross-posting between subreddits.
- `connection_type` enum on channels table — stay with null tokens as discriminator until a third platform changes the calculus.
- Per-subreddit adaptive engagement baselines (already in TODOS.md).

---

## What already exists (reuse — do not rebuild)

- `RedditClient.appOnly()` — read-only client, no creds. (`src/lib/reddit-client.ts:121`)
- `dispatchApprove()` X-reply handoff branch — pattern mirrored. (`src/lib/approve-dispatch.ts:54`)
- `find_threads_via_xai` core loop — refinement, judging, throttle, cost tracking. (`src/tools/FindThreadsViaXaiTool/`)
- `judging-thread-quality` skill — already platform-agnostic.
- `persist_queue_threads` — extend mapping, don't rewrite.
- `reply-throttle.ts` — `handed_off` already counts as engaged.
- `circuit-breaker` and subreddit rate limiter in `posting.ts` — unreachable for handoff but kept for future OAuth path.
- `handed_off` enum value in `drafts` schema. (`src/lib/db/schema/drafts.ts:25`)
- `plan-execute-dispatch.ts` Reddit `null` route holes. (`src/lib/plan-execute-dispatch.ts:52`)
- 24h stale-sweeper for pending drafts (shipped 2026-05-06).
- `RedditClient.getSubredditRules()` — already exists via appOnly.
- Existing `PATCH /api/today/[id]/approve` route — handles dispatch result, no change needed.

---

## Open questions for the executor

1. Does `seedChannel` / `seedThread` / `seedDraft` exist in `e2e/fixtures/db.ts`? If not, create them in Task 8 Step 3 mirroring `seedSession` shape.
2. Is `drafts.postTitle` already populated for existing reddit content_post drafts (Task 4b reads it)? If draft origin is the content-manager skill, verify the skill writes both `postTitle` and `replyBody` for reddit posts.
3. The `handoff-confirm` route uses `draft.updatedAt` as the implicit handed-off timestamp. If product wants a separate `handed_off_at` column for analytics, add it as a follow-up — out of scope here.

---

## Estimated effort

| Task | Worktree-friendly? | CC estimate |
|---|---|---|
| 1. Schema migration | independent | 0.5d |
| 2. Discovery generalization | parallel with 3, 4, 6 | 1.5d |
| 3. Drafting + reddit-review-rules + getSubredditRules tool | parallel with 2, 4, 6 | 1.5d |
| 4. Dispatch + URL builders | parallel with 2, 3, 6 | 1d |
| 5. Handoff page (server + client + endpoint) | depends on 4 | 2d |
| 6. Onboarding (verify + connect + callback + handle input + settings) | depends on 1 | 1d |
| 7. Flips + UI sweep | depends on 2-6 | 0.5d |
| 8. Playwright | depends on all | 1.5d |

**Total: 8-9 working days.** Tasks 2/3/4/6 in parallel worktrees → calendar time ~5-6 days.
