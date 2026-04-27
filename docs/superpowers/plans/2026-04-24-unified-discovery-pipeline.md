# Unified Discovery Pipeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the parallel BullMQ `discovery-scan` worker + standalone `monitor`-only auto-draft path with a single coordinator-rooted team-run pipeline. Onboarding completion, daily cron, and manual `/api/discovery/trigger` all enqueue the *same* team-run shape; coordinator dispatches `community-scout` (new) and `reply-drafter` (new) via Task. Drafts land in `drafts` table; everything streams visibly into the team chat.

**Architecture:** Two new team_member agent types (`community-scout`, `reply-drafter`), two thin tools that wrap existing pipeline functions (`run_discovery_scan` calls `runDiscoveryV3`; `draft_reply` calls `runSkill('draft-single-reply')` + writes drafts row + `enqueueReview`), one coordinator prompt update with trigger-based dispatch logic, and a thin BullMQ cron-fanout worker that emits team-runs (no longer runs scout itself). Onboarding redirects to `/team?from=onboarding&conv=<id>` with a one-time banner. Daily cron at 13:00 UTC enqueues a `discovery_cron` team-run per user with connected channels into a per-user rolling `Discovery` conversation.

**Tech Stack:** Next.js App Router, Drizzle ORM (Postgres), BullMQ (Redis), TypeScript, vitest, ShipFlare's internal AgentTool / Skill / team-run framework.

---

## File Structure

### New files
- `src/tools/RunDiscoveryScanTool/RunDiscoveryScanTool.ts` — tool wrapper around `runDiscoveryV3` + `persistScoutVerdicts`
- `src/tools/RunDiscoveryScanTool/__tests__/RunDiscoveryScanTool.test.ts`
- `src/tools/DraftReplyTool/DraftSingleReplyTool.ts` — NEW tool (note: existing `DraftReplyTool.ts` is unrelated, see Task 3 for naming clarification)
- `src/tools/DraftReplyTool/__tests__/DraftSingleReplyTool.test.ts`
- `src/tools/AgentTool/agents/community-scout/AGENT.md`
- `src/tools/AgentTool/agents/community-scout/schema.ts`
- `src/tools/AgentTool/agents/community-scout/__tests__/loader-smoke.test.ts`
- `src/tools/AgentTool/agents/reply-drafter/AGENT.md`
- `src/tools/AgentTool/agents/reply-drafter/schema.ts`
- `src/tools/AgentTool/agents/reply-drafter/__tests__/loader-smoke.test.ts`
- `src/workers/processors/discovery-cron-fanout.ts` — replaces `discovery-scan.ts` for the cron path
- `src/lib/team-onboarding-kickoff.ts` — helper that enqueues the kickoff team-run
- `src/lib/team-rolling-conversation.ts` — helper that resolves/creates a per-user named conversation (e.g. `Discovery`)
- `src/components/onboarding/_onboarding-banner.tsx` — one-time banner for `?from=onboarding`

### Modified files
- `src/lib/queue/team-run.ts:44-50` — extend `TeamRunTrigger` union
- `src/tools/registry.ts:60-90` — register two new tools
- `src/lib/team-provisioner.ts:140-142` — extend baseline roster
- `src/tools/AgentTool/agents/coordinator/AGENT.md` — add trigger-based dispatch playbook
- `src/app/api/onboarding/commit/route.ts:313-342` — replace content-planner enqueue with kickoff team-run, return `conversationId`
- `src/components/onboarding/OnboardingFlow.tsx:704` — redirect to `/team?from=onboarding&conv=...`
- `src/app/(app)/team/_components/team-desk.tsx` — render onboarding banner when `?from=onboarding`
- `src/app/(app)/team/page.tsx` — read `?conv=` searchParam, override `initialConversationId`
- `src/app/api/discovery/trigger/route.ts` — enqueue team-run instead of `enqueueDiscoveryScan`
- `src/lib/queue/index.ts` — keep `enqueueDiscoveryScan` for the cron-fanout-only entry, or remove if no remaining callers

### Deleted files
- `src/workers/processors/discovery-scan.ts` — replaced by `discovery-cron-fanout.ts` + tool path
- `src/workers/processors/__tests__/discovery-scan-v3.test.ts` — superseded; coverage moves to `RunDiscoveryScanTool` test

---

## Phase 1 — Foundation (tools + types)

### Task 1: Extend `TeamRunTrigger` union with new triggers

**Files:**
- Modify: `src/lib/queue/team-run.ts:44-50`

- [ ] **Step 1: Edit the union**

In `src/lib/queue/team-run.ts:44-50`, replace:

```ts
export type TeamRunTrigger =
  | 'onboarding'
  | 'weekly'
  | 'manual'
  | 'phase_transition'
  | 'reply_sweep'
  | 'draft_post';
```

with:

```ts
export type TeamRunTrigger =
  | 'onboarding'
  | 'kickoff'
  | 'weekly'
  | 'manual'
  | 'phase_transition'
  | 'reply_sweep'
  | 'draft_post'
  | 'discovery_cron';
```

`'kickoff'` is the post-onboarding-commit team-run; `'discovery_cron'` is the daily 13:00 UTC fanout. `'onboarding'` stays for the stage-6 strategic-path generation team-run (unchanged).

- [ ] **Step 2: Type-check**

Run: `pnpm tsc --noEmit`
Expected: PASS (or only pre-existing errors unrelated to this file)

- [ ] **Step 3: Commit**

```bash
git add src/lib/queue/team-run.ts
git commit -m "feat(team-run): add 'kickoff' and 'discovery_cron' triggers"
```

---

### Task 2: Build `run_discovery_scan` tool

**Files:**
- Create: `src/tools/RunDiscoveryScanTool/RunDiscoveryScanTool.ts`
- Create: `src/tools/RunDiscoveryScanTool/__tests__/RunDiscoveryScanTool.test.ts`

The tool wraps `runDiscoveryV3` (existing in `src/lib/discovery/v3-pipeline.ts`) and `persistScoutVerdicts`. Returns the queued threads with their newly-assigned thread row ids so `draft_reply` can be invoked against them downstream. If the user has no channel for the platform, returns `{ skipped: true, reason: 'no_<platform>_channel', queued: [] }`.

- [ ] **Step 1: Write the failing test**

Create `src/tools/RunDiscoveryScanTool/__tests__/RunDiscoveryScanTool.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/discovery/v3-pipeline', () => ({
  runDiscoveryV3: vi.fn(),
}));
vi.mock('@/lib/discovery/persist-scout-verdicts', () => ({
  persistScoutVerdicts: vi.fn(),
}));
vi.mock('@/lib/platform-deps', () => ({
  createPlatformDeps: vi.fn(),
}));
vi.mock('@/lib/db', () => ({
  db: {
    select: vi.fn(),
  },
}));

import { runDiscoveryScanTool } from '../RunDiscoveryScanTool';
import { runDiscoveryV3 } from '@/lib/discovery/v3-pipeline';
import { persistScoutVerdicts } from '@/lib/discovery/persist-scout-verdicts';
import { createPlatformDeps } from '@/lib/platform-deps';

describe('run_discovery_scan tool', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns skipped:true when user has no channel for the platform', async () => {
    vi.mocked(createPlatformDeps).mockRejectedValueOnce(
      new Error('no_channel'),
    );

    const result = await runDiscoveryScanTool.execute(
      { platform: 'x' },
      // minimal ctx — using `any` to escape the deep ToolContext shape
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { domain: { userId: 'u1', productId: 'p1', db: {} } } as any,
    );

    expect(result.skipped).toBe(true);
    expect(result.queued).toHaveLength(0);
  });

  it('returns persisted queued threads with thread ids', async () => {
    vi.mocked(createPlatformDeps).mockResolvedValueOnce({} as never);
    vi.mocked(runDiscoveryV3).mockResolvedValueOnce({
      verdicts: [
        {
          verdict: 'queue',
          externalId: 'tweet-1',
          platform: 'x',
          title: '',
          body: 'looking for shipflare alternatives',
          author: 'alice',
          url: 'https://x.com/alice/status/1',
          confidence: 0.92,
          reason: 'matches keywords + asking for tools',
        },
      ],
      review: { ran: false, decision: { mode: 'skip' }, disagreements: null },
      usage: { scout: { costUsd: 0.012 }, reviewer: null },
      rubricGenerated: false,
    } as never);
    vi.mocked(persistScoutVerdicts).mockResolvedValueOnce({ queued: 1 });

    const result = await runDiscoveryScanTool.execute(
      { platform: 'x' },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { domain: { userId: 'u1', productId: 'p1', db: {} } } as any,
    );

    expect(result.skipped).toBe(false);
    expect(result.queued).toHaveLength(1);
    expect(result.queued[0].externalId).toBe('tweet-1');
    expect(result.queued[0].confidence).toBe(0.92);
    expect(result.scanned).toBe(1);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run src/tools/RunDiscoveryScanTool`
Expected: FAIL with "Cannot find module '../RunDiscoveryScanTool'"

- [ ] **Step 3: Implement the tool**

Create `src/tools/RunDiscoveryScanTool/RunDiscoveryScanTool.ts`:

```ts
// run_discovery_scan — wraps the v3 discovery pipeline as a synchronous
// tool callable from a team-member agent loop (community-scout). The
// existing BullMQ discovery-scan worker enqueued one of these per
// (user, platform); after the unified-pipeline migration the same logic
// lives here, called inline from inside a team-run.

import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { buildTool } from '@/core/tool-system';
import type { ToolDefinition } from '@/core/types';
import { db } from '@/lib/db';
import { products, channels } from '@/lib/db/schema';
import { runDiscoveryV3 } from '@/lib/discovery/v3-pipeline';
import { persistScoutVerdicts } from '@/lib/discovery/persist-scout-verdicts';
import { createPlatformDeps } from '@/lib/platform-deps';
import { getPlatformConfig } from '@/lib/platform-config';
import { readDomainDeps } from '@/tools/context-helpers';

export const RUN_DISCOVERY_SCAN_TOOL_NAME = 'run_discovery_scan';

const inputSchema = z.object({
  platform: z.enum(['x', 'reddit']),
  /** Override default sources from platform-config; coordinator can pass
   * a narrower list (e.g. just 2 hot subreddits) for cheap onboarding scans. */
  sources: z.array(z.string().min(1)).optional(),
});

export interface QueuedThreadSummary {
  externalId: string;
  platform: 'x' | 'reddit';
  title: string;
  body: string;
  author: string;
  url: string;
  confidence: number;
  reason: string;
}

export interface RunDiscoveryScanResult {
  skipped: boolean;
  reason?: string;
  scanned: number;
  queued: QueuedThreadSummary[];
  costUsd: number;
}

export const runDiscoveryScanTool: ToolDefinition<
  z.infer<typeof inputSchema>,
  RunDiscoveryScanResult
> = buildTool({
  name: RUN_DISCOVERY_SCAN_TOOL_NAME,
  description:
    'Run discovery scout on a platform (x | reddit). Returns the threads ' +
    'judged "queue"-worthy with their confidence + reason. The threads ' +
    'are persisted to the threads table (state=queued); reply-drafter ' +
    'should be dispatched against the returned externalIds. Skips ' +
    'gracefully when no channel for the platform is connected.',
  inputSchema,
  isConcurrencySafe: false,
  isReadOnly: false,
  async execute(input, ctx): Promise<RunDiscoveryScanResult> {
    const { userId, productId } = readDomainDeps(ctx);
    const { platform } = input;

    // Channel preflight — no channel = no scan.
    const channelRows = await db
      .select({ platform: channels.platform })
      .from(channels)
      .where(eq(channels.userId, userId));
    const hasChannel = channelRows.some((c) => c.platform === platform);
    if (!hasChannel) {
      return {
        skipped: true,
        reason: `no_${platform}_channel`,
        scanned: 0,
        queued: [],
        costUsd: 0,
      };
    }

    const [productRow] = await db
      .select()
      .from(products)
      .where(eq(products.id, productId))
      .limit(1);
    if (!productRow) {
      throw new Error(`product ${productId} not found`);
    }

    const config = getPlatformConfig(platform);
    const sources = input.sources ?? [...config.defaultSources];

    let deps;
    try {
      deps = await createPlatformDeps(platform, userId, productId);
    } catch (err) {
      // createPlatformDeps throws when no channel — treat as skipped
      return {
        skipped: true,
        reason: `no_${platform}_channel`,
        scanned: 0,
        queued: [],
        costUsd: 0,
      };
    }

    const result = await runDiscoveryV3(
      {
        userId,
        productId,
        platform,
        sources,
        product: {
          name: productRow.name,
          description: productRow.description,
          valueProp: productRow.valueProp ?? null,
          keywords: productRow.keywords,
        },
      },
      deps,
    );

    const queueVerdicts = result.verdicts.filter((v) => v.verdict === 'queue');
    if (queueVerdicts.length > 0) {
      await persistScoutVerdicts({ userId, verdicts: queueVerdicts, db });
    }

    const queued: QueuedThreadSummary[] = queueVerdicts.map((v) => ({
      externalId: v.externalId,
      platform: v.platform as 'x' | 'reddit',
      title: v.title ?? '',
      body: v.body,
      author: v.author,
      url: v.url,
      confidence: v.confidence,
      reason: v.reason,
    }));

    const costUsd =
      (result.usage.scout.costUsd ?? 0) +
      (result.usage.reviewer?.costUsd ?? 0);

    return {
      skipped: false,
      scanned: result.verdicts.length,
      queued,
      costUsd,
    };
  },
});
```

- [ ] **Step 4: Run the test**

Run: `pnpm vitest run src/tools/RunDiscoveryScanTool`
Expected: PASS (2 tests)

- [ ] **Step 5: Commit**

```bash
git add src/tools/RunDiscoveryScanTool
git commit -m "feat(tools): add run_discovery_scan tool wrapping v3 pipeline"
```

---

### Task 3: Build `draft_single_reply` tool

**Files:**
- Create: `src/tools/DraftReplyTool/DraftSingleReplyTool.ts`
- Create: `src/tools/DraftReplyTool/__tests__/DraftSingleReplyTool.test.ts`

> **Naming + collision note (corrected mid-plan):** The existing `src/tools/DraftReplyTool/DraftReplyTool.ts` already registers a tool named `draft_reply` — it's the *persist-only* tool used by community-manager (caller drafts the body in its own LLM turn, then calls the tool with the pre-drafted text). Our NEW tool is *skill-wrapping* (caller passes the thread, the tool runs the draft-single-reply skill internally). Both patterns are legitimate; they coexist as siblings. The new tool is named **`draft_single_reply`** (distinct from `draft_reply`) and registered alongside it. The new file is `DraftSingleReplyTool.ts` next to the existing `DraftReplyTool.ts` in the same directory.

The tool wraps `runSkill('draft-single-reply')` (existing in `src/skills/draft-single-reply/`), persists a `drafts` row using the actual schema (`replyBody`, `status: 'pending'`, `confidenceScore`), and calls `enqueueReview`. Idempotent on `(userId, threadId)` — if a draft already exists for that thread, returns its id without redrafting.

**Authoritative facts (verified against current source):**
- `runSkill` is exported from `src/core/skill-runner.ts` — import as `import { runSkill } from '@/core/skill-runner'`. The plan's earlier `@/skills/runner` reference was wrong.
- `drafts` schema (`src/lib/db/schema/drafts.ts`):
  - `replyBody: text(...).notNull()` — NOT a `body` column
  - `status` is `draftStatusEnum`: `'pending' | 'approved' | 'skipped' | 'posted' | 'failed' | 'flagged' | 'needs_revision'`. **Use `'pending'`** for newly-drafted rows. `'draft_created'` is NOT a valid value.
  - `confidenceScore: real(...).notNull()` — required. The draft-single-reply skill output doesn't currently include a confidence value, so persist a sensible default of `0.7`.
  - `draftType: text(...)` — set to `'reply'`.
  - No `platform` column on drafts — derive via `threads.platform` join when needed.
- `threads.state` enum (`src/lib/db/schema/channels.ts:69`) is `xContentCalendarItemStateEnum`. Verify valid values before transitioning. If `'draft_created'` is not in the enum, use the closest valid value (likely `'drafted'`) or skip the thread state update entirely — the drafts row insertion is the source of truth for "this thread has a draft".

- [ ] **Step 1: Read the existing reply-hardening flow for the persistence pattern**

Run: `cat src/workers/processors/reply-hardening.ts | head -180`
This is the existing `draftReplyWithHardening` we're not reusing directly (we want a thin sync tool, not the BullMQ-routed function). Use it as a reference for what fields to insert into `drafts`.

- [ ] **Step 2: Write the failing test**

Create `src/tools/DraftReplyTool/__tests__/DraftSingleReplyTool.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/skills/runner', () => ({
  runSkill: vi.fn(),
}));
vi.mock('@/lib/queue', () => ({
  enqueueReview: vi.fn(),
}));
vi.mock('@/lib/db', () => {
  const insert = vi.fn(() => ({
    values: vi.fn(() => ({
      returning: vi.fn(async () => [{ id: 'draft-uuid-1' }]),
    })),
  }));
  const select = vi.fn(() => ({
    from: vi.fn(() => ({
      where: vi.fn(() => ({ limit: vi.fn(async () => []) })),
    })),
  }));
  return {
    db: { insert, select, update: vi.fn(() => ({ set: vi.fn(() => ({ where: vi.fn(async () => undefined) })) })) },
  };
});

import { draftSingleReplyTool } from '../DraftSingleReplyTool';
import { runSkill } from '@/skills/runner';
import { enqueueReview } from '@/lib/queue';

describe('draft_reply tool', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('drafts a reply for a queued thread and enqueues review', async () => {
    vi.mocked(runSkill).mockResolvedValueOnce({
      output: {
        replies: [
          {
            tweetId: 'tweet-1',
            replyBody: 'cool, have you tried shipflare?',
            shouldReply: true,
            rejectionReasons: [],
          },
        ],
      },
      costUsd: 0.003,
    } as never);

    const result = await draftSingleReplyTool.execute(
      {
        threadId: 'thread-uuid-1',
        externalId: 'tweet-1',
        body: 'looking for shipflare alternatives',
        author: 'alice',
        platform: 'x',
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { domain: { userId: 'u1', productId: 'p1', db: {} } } as any,
    );

    expect(result.status).toBe('drafted');
    expect(result.draftId).toBe('draft-uuid-1');
    expect(enqueueReview).toHaveBeenCalledTimes(1);
  });

  it('returns skipped when the drafter chooses not to reply', async () => {
    vi.mocked(runSkill).mockResolvedValueOnce({
      output: {
        replies: [
          {
            tweetId: 'tweet-1',
            replyBody: '',
            shouldReply: false,
            rejectionReasons: ['off-topic'],
          },
        ],
      },
      costUsd: 0.001,
    } as never);

    const result = await draftSingleReplyTool.execute(
      {
        threadId: 'thread-uuid-1',
        externalId: 'tweet-1',
        body: 'random unrelated tweet',
        author: 'bob',
        platform: 'x',
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { domain: { userId: 'u1', productId: 'p1', db: {} } } as any,
    );

    expect(result.status).toBe('skipped');
    expect(result.draftId).toBeNull();
    expect(enqueueReview).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `pnpm vitest run src/tools/DraftReplyTool/__tests__/DraftSingleReplyTool.test.ts`
Expected: FAIL with "Cannot find module '../DraftSingleReplyTool'"

- [ ] **Step 4: Implement the tool**

Create `src/tools/DraftReplyTool/DraftSingleReplyTool.ts`:

```ts
// draft_reply — drafts a single reply for a queued thread by invoking
// the draft-single-reply skill, persisting a `drafts` row, and enqueuing
// a review job. Idempotent on (userId, threadId): re-invocation returns
// the existing draft id without redrafting.
//
// Why this exists separately from reply-hardening's draftReplyWithHardening:
// that path writes into the monitor processor's BullMQ-driven pipeline
// (assumes tracked accounts + reply-window context). The team-run path
// here is invoked from inside an LLM agent loop and needs to be a plain
// async function, not a job.

import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { buildTool } from '@/core/tool-system';
import type { ToolDefinition } from '@/core/types';
import { db } from '@/lib/db';
import { drafts, products, threads } from '@/lib/db/schema';
import { runSkill } from '@/core/skill-runner';
import { enqueueReview } from '@/lib/queue';
import { readDomainDeps } from '@/tools/context-helpers';

export const DRAFT_SINGLE_REPLY_TOOL_NAME = 'draft_single_reply';

// Default confidence persisted on the drafts row when the underlying
// skill output doesn't include a confidence value. 0.7 = "team thinks
// this is good enough to ship if the founder agrees" — matches the
// gate the review skill uses elsewhere.
const DEFAULT_DRAFT_CONFIDENCE = 0.7;

const inputSchema = z.object({
  threadId: z.string().uuid(),
  externalId: z.string().min(1),
  body: z.string().min(1),
  author: z.string().min(1),
  platform: z.enum(['x']),
  /** Optional voice block override; otherwise loaded from product. */
  voiceBlock: z.string().nullable().optional(),
});

export interface DraftReplyResult {
  status: 'drafted' | 'skipped' | 'already_exists';
  draftId: string | null;
  body: string | null;
  rejectionReasons: string[];
  costUsd: number;
}

export const draftSingleReplyTool: ToolDefinition<
  z.infer<typeof inputSchema>,
  DraftReplyResult
> = buildTool({
  name: DRAFT_SINGLE_REPLY_TOOL_NAME,
  description:
    'Draft a single reply for a queued thread by invoking the ' +
    'draft-single-reply skill (full pipeline: opportunity-judge ' +
    'pre-pass + drafter + ai-slop validator). Persists a drafts row ' +
    'and enqueues automated review. Distinct from `draft_reply`, which ' +
    'persists a body the calling agent already drafted. ' +
    'skill, persists a drafts row, and enqueues an automated review. ' +
    'Idempotent — re-calling with the same threadId returns the existing draft.',
  inputSchema,
  isConcurrencySafe: true,
  isReadOnly: false,
  async execute(input, ctx): Promise<DraftReplyResult> {
    const { userId, productId } = readDomainDeps(ctx);

    // Idempotency check: existing draft for this thread?
    const existing = await db
      .select({ id: drafts.id, body: drafts.body })
      .from(drafts)
      .where(and(eq(drafts.userId, userId), eq(drafts.threadId, input.threadId)))
      .limit(1);
    if (existing.length > 0) {
      return {
        status: 'already_exists',
        draftId: existing[0].id,
        body: existing[0].body,
        rejectionReasons: [],
        costUsd: 0,
      };
    }

    const [productRow] = await db
      .select()
      .from(products)
      .where(eq(products.id, productId))
      .limit(1);
    if (!productRow) throw new Error(`product ${productId} not found`);

    const skillResult = await runSkill({
      name: 'draft-single-reply',
      input: {
        tweets: [
          {
            tweetId: input.externalId,
            tweetText: input.body,
            authorUsername: input.author,
            platform: 'x' as const,
            productName: productRow.name,
            productDescription: productRow.description,
            valueProp: productRow.valueProp ?? null,
            keywords: productRow.keywords,
            canMentionProduct: true,
            voiceBlock: input.voiceBlock ?? null,
          },
        ],
      },
    });

    const reply = skillResult.output.replies?.[0];
    if (!reply || !reply.shouldReply || !reply.replyBody) {
      return {
        status: 'skipped',
        draftId: null,
        body: null,
        rejectionReasons: reply?.rejectionReasons ?? ['drafter chose skip'],
        costUsd: skillResult.costUsd ?? 0,
      };
    }

    const draftId = crypto.randomUUID();
    await db.insert(drafts).values({
      id: draftId,
      userId,
      threadId: input.threadId,
      status: 'pending',
      draftType: 'reply',
      replyBody: reply.replyBody,
      confidenceScore: DEFAULT_DRAFT_CONFIDENCE,
      engagementDepth: 0,
    });
    // Note: no `platform` column on drafts; no thread state mutation —
    // the existence of the drafts row is the canonical "this thread is
    // drafted" signal (see also community-manager's draft_reply tool
    // which doesn't update threads.state either).

    await enqueueReview({
      userId,
      draftId,
    });

    return {
      status: 'drafted',
      draftId,
      body: reply.replyBody,
      rejectionReasons: [],
      costUsd: skillResult.costUsd ?? 0,
    };
  },
});
```

- [ ] **Step 5: Run the test**

Run: `pnpm vitest run src/tools/DraftReplyTool/__tests__/DraftSingleReplyTool.test.ts`
Expected: PASS (2 tests)

- [ ] **Step 6: Commit**

```bash
git add src/tools/DraftReplyTool/DraftSingleReplyTool.ts src/tools/DraftReplyTool/__tests__/DraftSingleReplyTool.test.ts
git commit -m "feat(tools): add draft_reply tool wrapping draft-single-reply skill"
```

---

### Task 4: Register both tools in the central registry

**Files:**
- Modify: `src/tools/registry.ts`

- [ ] **Step 1: Add imports**

In `src/tools/registry.ts`, near the top with the other tool imports, add:

```ts
import { runDiscoveryScanTool } from './RunDiscoveryScanTool/RunDiscoveryScanTool';
import { draftSingleReplyTool } from './DraftReplyTool/DraftSingleReplyTool';
```

- [ ] **Step 2: Register the tools**

In `src/tools/registry.ts` near the existing `registry.register(...)` block (around line 60-90, in the "DB-scoped tools" group), add:

```ts
registry.register(runDiscoveryScanTool);
registry.register(draftSingleReplyTool);
```

- [ ] **Step 3: Type-check**

Run: `pnpm tsc --noEmit`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/tools/registry.ts
git commit -m "feat(tools): register run_discovery_scan and draft_reply"
```

---

## Phase 2 — Agents

### Task 5: Build `community-scout` agent

**Files:**
- Create: `src/tools/AgentTool/agents/community-scout/AGENT.md`
- Create: `src/tools/AgentTool/agents/community-scout/schema.ts`
- Create: `src/tools/AgentTool/agents/community-scout/__tests__/loader-smoke.test.ts`

> Note: This agent is distinct from the existing `discovery-scout` (which is the inner v3-pipeline agent invoked by `runDiscoveryV3`). `community-scout` is the **team_member-level** wrapper that decides which platforms to scan and emits a structured summary. It calls `run_discovery_scan` as its primary tool.

- [ ] **Step 1: Write the schema**

Create `src/tools/AgentTool/agents/community-scout/schema.ts`:

```ts
import { z } from 'zod';

export const communityScoutOutputSchema = z.object({
  status: z.enum(['completed', 'skipped', 'partial']),
  scannedPlatforms: z.array(
    z.object({
      platform: z.enum(['x', 'reddit']),
      scanned: z.number(),
      queued: z.number(),
      skipped: z.boolean(),
      skipReason: z.string().nullable(),
    }),
  ),
  topQueuedThreads: z
    .array(
      z.object({
        externalId: z.string(),
        platform: z.enum(['x', 'reddit']),
        body: z.string(),
        author: z.string(),
        url: z.string(),
        confidence: z.number(),
      }),
    )
    .max(10),
  notes: z.string(),
});

export type CommunityScoutOutput = z.infer<typeof communityScoutOutputSchema>;
```

- [ ] **Step 2: Write the AGENT.md**

Create `src/tools/AgentTool/agents/community-scout/AGENT.md`:

````markdown
---
name: community-scout
description: Scans connected platforms for live conversations relevant to the user's product. Wraps the v3 discovery pipeline in a chat-visible agent loop. Returns top queued threads ranked by confidence so reply-drafter can be dispatched against them. USE when the coordinator needs fresh discovery results — onboarding kickoff, daily cron, or manual user request. DO NOT USE for replying or drafting — that's reply-drafter's job.
model: claude-haiku-4-5-20251001
maxTurns: 8
tools:
  - run_discovery_scan
  - StructuredOutput
shared-references:
  - base-guidelines
---

# Community Scout for {productName}

You are the Community Scout. Your job: scan the user's connected platforms
for conversations they should engage with, return the top candidates.

## Workflow

1. The coordinator's prompt will tell you which platform(s) to scan
   (typically `x` for now). For each platform, call
   `run_discovery_scan({ platform })`.

2. If the tool returns `skipped: true` (no channel connected), record the
   skip reason in your `scannedPlatforms` output and move on. Do NOT fail
   the whole scout run — partial coverage is fine.

3. After scanning all requested platforms, pick the top 3 queued threads
   by `confidence` (descending), across all platforms. These become your
   `topQueuedThreads` output. The reply-drafter dispatched after you will
   draft for these specifically.

4. Call `StructuredOutput` with your final result. `notes` should be
   1-2 sentences — short enough that the coordinator can summarize it
   verbatim to the user.

## Output schema

```ts
{
  status: 'completed' | 'skipped' | 'partial',
  scannedPlatforms: Array<{
    platform: 'x' | 'reddit',
    scanned: number,
    queued: number,
    skipped: boolean,
    skipReason: string | null,
  }>,
  topQueuedThreads: Array<{
    externalId: string,
    platform: 'x' | 'reddit',
    body: string,
    author: string,
    url: string,
    confidence: number,
  }>,
  notes: string,
}
```

`status: 'skipped'` when ALL platforms came back as no-channel.
`status: 'partial'` when SOME platforms were scanned and some skipped.
`status: 'completed'` when all requested platforms scanned successfully.

## What you do NOT do

- Do not draft replies — reply-drafter handles that.
- Do not write `add_plan_item` — content-planner does that.
- Do not invent threads. If `run_discovery_scan` returns 0 queued, your
  `topQueuedThreads` is `[]`. Honest empty is better than fabrication.
````

- [ ] **Step 3: Write the loader smoke test**

Create `src/tools/AgentTool/agents/community-scout/__tests__/loader-smoke.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { loadAgentDefinition } from '@/tools/AgentTool/loader';

describe('community-scout agent loader', () => {
  it('loads frontmatter and resolves tools', async () => {
    const def = await loadAgentDefinition('community-scout');
    expect(def.name).toBe('community-scout');
    expect(def.tools).toContain('run_discovery_scan');
    expect(def.tools).toContain('StructuredOutput');
  });
});
```

> If `loadAgentDefinition` is not the exact function name, mirror the
> import path used by `src/tools/AgentTool/agents/discovery-scout/__tests__/loader-smoke.test.ts` (read that test first to confirm).

- [ ] **Step 4: Run the test**

Run: `pnpm vitest run src/tools/AgentTool/agents/community-scout`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/tools/AgentTool/agents/community-scout
git commit -m "feat(agents): add community-scout team member"
```

---

### Task 6: Build `reply-drafter` agent

**Files:**
- Create: `src/tools/AgentTool/agents/reply-drafter/AGENT.md`
- Create: `src/tools/AgentTool/agents/reply-drafter/schema.ts`
- Create: `src/tools/AgentTool/agents/reply-drafter/__tests__/loader-smoke.test.ts`

- [ ] **Step 1: Write the schema**

Create `src/tools/AgentTool/agents/reply-drafter/schema.ts`:

```ts
import { z } from 'zod';

export const replyDrafterOutputSchema = z.object({
  status: z.enum(['completed', 'partial']),
  drafted: z.array(
    z.object({
      threadId: z.string().uuid(),
      draftId: z.string().uuid(),
      body: z.string(),
    }),
  ),
  skipped: z.array(
    z.object({
      threadId: z.string().uuid(),
      reason: z.string(),
    }),
  ),
  notes: z.string(),
});

export type ReplyDrafterOutput = z.infer<typeof replyDrafterOutputSchema>;
```

- [ ] **Step 2: Write the AGENT.md**

Create `src/tools/AgentTool/agents/reply-drafter/AGENT.md`:

````markdown
---
name: reply-drafter
description: Drafts replies for a list of queued threads using the draft-single-reply skill (which runs the full opportunity-judge → drafter → AI-slop-validator pipeline internally). One draft per thread; persists drafts rows and enqueues automated review. Distinct from community-manager, which writes reply bodies in its own LLM turn. Reads thread bodies from the threads table by id. USE after community-scout has surfaced top queued threads and the coordinator is dispatching a reply session. DO NOT USE for proactive scanning — community-scout owns scanning.
model: claude-haiku-4-5-20251001
maxTurns: 6
tools:
  - draft_single_reply
  - StructuredOutput
shared-references:
  - base-guidelines
---

# Reply Drafter for {productName}

You are the Reply Drafter. Your job: for each thread the coordinator gives
you, call `draft_reply` once. Do NOT skip threads silently — every input
thread MUST appear in either `drafted` or `skipped`.

## Workflow

1. The coordinator passes you a list of queued threads with their
   `threadId`, `externalId`, `body`, `author`, and `platform`. You receive
   this list verbatim in your prompt.

2. For each thread, call `draft_single_reply({ threadId, externalId, body, author, platform })`.
   The tool itself decides whether the thread is replyable; if it returns
   `status: 'skipped'`, that's a legitimate skip — record the rejection
   reasons and continue.

3. You may parallelize the `draft_reply` calls across threads (the tool
   is concurrency-safe).

4. After all threads are processed, call `StructuredOutput` with the
   summary.

## Output schema

```ts
{
  status: 'completed' | 'partial',
  drafted: Array<{ threadId: string, draftId: string, body: string }>,
  skipped: Array<{ threadId: string, reason: string }>,
  notes: string,
}
```

`status: 'partial'` when some threads were skipped.
`status: 'completed'` when every input thread produced a draft.

## What you do NOT do

- Do not scan for new threads — community-scout owns that.
- Do not POST replies — posting is gated by user approval through /today.
- Do not edit `body` after the tool returns it — the tool's output IS the
  draft body.
````

- [ ] **Step 3: Write the loader smoke test**

Create `src/tools/AgentTool/agents/reply-drafter/__tests__/loader-smoke.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { loadAgentDefinition } from '@/tools/AgentTool/loader';

describe('reply-drafter agent loader', () => {
  it('loads frontmatter and resolves tools', async () => {
    const def = await loadAgentDefinition('reply-drafter');
    expect(def.name).toBe('reply-drafter');
    expect(def.tools).toContain('draft_single_reply');
    expect(def.tools).toContain('StructuredOutput');
  });
});
```

- [ ] **Step 4: Run the test**

Run: `pnpm vitest run src/tools/AgentTool/agents/reply-drafter`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/tools/AgentTool/agents/reply-drafter
git commit -m "feat(agents): add reply-drafter team member"
```

---

## Phase 3 — Provisioner + Coordinator

### Task 7: Add new agents to the team-provisioner roster

**Files:**
- Modify: `src/lib/team-provisioner.ts:140-142`

- [ ] **Step 1: Read the current roster definition**

Run: `sed -n '85,160p' src/lib/team-provisioner.ts`

Confirm the structure — there's a `BaseAgentType` union, a `roster` array, and a `displayNames` map.

- [ ] **Step 2: Extend the BaseAgentType type**

Find the existing definition (likely `type BaseAgentType = 'coordinator' | 'growth-strategist' | 'content-planner';`). Replace with:

```ts
type BaseAgentType =
  | 'coordinator'
  | 'growth-strategist'
  | 'content-planner'
  | 'community-scout'
  | 'reply-drafter';
```

- [ ] **Step 3: Extend the displayNames map**

Find `DEFAULT_DISPLAY_NAMES` and add:

```ts
'community-scout': 'Community Scout',
'reply-drafter': 'Reply Drafter',
```

- [ ] **Step 4: Extend the baseline roster**

Find line 140-142 (`const roster: AgentType[] = options?.preset ? ... : ['coordinator', 'growth-strategist', 'content-planner'];`). Replace the `else` branch with:

```ts
['coordinator', 'growth-strategist', 'content-planner', 'community-scout', 'reply-drafter']
```

- [ ] **Step 5: Update the memberIds return type**

Find:
```ts
const memberIds: Record<BaseAgentType, string> = {
  coordinator: byType.get('coordinator')!,
  'growth-strategist': byType.get('growth-strategist')!,
  'content-planner': byType.get('content-planner')!,
};
```

Add:
```ts
const memberIds: Record<BaseAgentType, string> = {
  coordinator: byType.get('coordinator')!,
  'growth-strategist': byType.get('growth-strategist')!,
  'content-planner': byType.get('content-planner')!,
  'community-scout': byType.get('community-scout')!,
  'reply-drafter': byType.get('reply-drafter')!,
};
```

- [ ] **Step 6: Type-check**

Run: `pnpm tsc --noEmit`
Expected: PASS. If callers downstream destructure `memberIds` and use only some keys, that's fine — `Record<BaseAgentType, string>` is a superset.

- [ ] **Step 7: Commit**

```bash
git add src/lib/team-provisioner.ts
git commit -m "feat(team): add community-scout and reply-drafter to baseline roster"
```

---

### Task 8: Update coordinator AGENT.md with trigger-based dispatch playbook

**Files:**
- Modify: `src/tools/AgentTool/agents/coordinator/AGENT.md`

- [ ] **Step 1: Read the current coordinator prompt**

Run: `cat src/tools/AgentTool/agents/coordinator/AGENT.md`

Look for an existing "How to handle different triggers" section — if present, extend it. Otherwise, add a new section before "## What you do NOT do" (or equivalent closing section).

- [ ] **Step 2: Insert the playbook section**

Add this section to coordinator AGENT.md (paste at the appropriate spot, before any closing "## What you do NOT do" section):

````markdown
## Dispatch playbook by trigger

Your team-run's `trigger` (visible in the goal preamble) tells you which
specialists to dispatch. Read the trigger first, then follow the matching
playbook below.

### `trigger: 'kickoff'` (post-onboarding)

The user just finished onboarding. They have a strategic_path and a
brand-new plan, and want to see the team in action. Do all three of these
in parallel by emitting three Task calls in ONE response:

1. `Task({ subagent_type: 'content-planner', description: 'plan week-1 items' })`
   — week-1 plan_items.
2. `Task({ subagent_type: 'community-scout', description: 'scan x for live conversations' })`
   — surface top queued threads.
3. After community-scout returns, `Task({ subagent_type: 'reply-drafter', description: 'draft top-3 replies', prompt: <thread list> })`
   — draft replies for the top 3 by confidence.

If community-scout reports `status: 'skipped'` (no platform channels
connected), skip step 3 and tell the user "Connect X to see your scout
in action."

Final user-facing summary should list: items planned, threads scanned,
drafts ready for review.

### `trigger: 'discovery_cron'` (daily 13:00 UTC)

Daily discovery sweep. Dispatch in this exact order:

1. `Task({ subagent_type: 'community-scout', description: 'daily x scan' })`
2. After scout returns, if `topQueuedThreads.length > 0`:
   `Task({ subagent_type: 'reply-drafter', description: 'draft top-3 replies', prompt: <thread list> })`
3. If scout returns 0 queued threads, your final reply is one line:
   "Scanned X today, no relevant new conversations."

Do NOT dispatch content-planner on a `discovery_cron` trigger — weekly
planning is owned by a separate weekly cron.

### `trigger: 'manual'` (user said "scan X again")

Same as `discovery_cron` — scout then drafter — except respect any user
hints in the goal text (e.g. "draft 5 replies, not 3").
````

- [ ] **Step 3: Type-check** (no TS impact, but smoke test)

Run: `pnpm tsc --noEmit`
Expected: PASS (markdown change has no TS impact)

- [ ] **Step 4: Commit**

```bash
git add src/tools/AgentTool/agents/coordinator/AGENT.md
git commit -m "feat(coordinator): add trigger-based dispatch playbook"
```

---

## Phase 4 — Onboarding flow

### Task 9: Replace commit's content-planner enqueue with kickoff team-run

**Files:**
- Modify: `src/app/api/onboarding/commit/route.ts:313-342, 397-404`

- [ ] **Step 1: Replace the post-tx enqueue block**

In `src/app/api/onboarding/commit/route.ts`, locate the block at lines 313-342 (the "// Phase B1 (post-coordinator cutover): ..." comment + enqueueTeamRun call with `trigger: 'weekly'` rooted at content-planner). Replace the whole block with:

```ts
// Post-onboarding kickoff: ONE team-run rooted at coordinator that
// dispatches content-planner (week-1 plan_items), community-scout
// (live conversations on connected platforms), and reply-drafter
// (top-3 replies for queued threads). Visible in /team chat.
let kickoffConvId: string | null = null;
try {
  const { teamId } = await ensureTeamExists(userId, productId);
  const channels = await getUserChannels(userId);
  const memberRows = await db
    .select({ id: teamMembers.id, agentType: teamMembers.agentType })
    .from(teamMembers)
    .where(eq(teamMembers.teamId, teamId));
  const coordinator = memberRows.find((m) => m.agentType === 'coordinator');
  if (!coordinator) {
    throw new Error('coordinator member missing after ensureTeamExists');
  }

  const goal =
    `Onboarding kickoff for ${body.product.name}. ` +
    `Strategic path pathId=${strategicPathId}. ` +
    `Connected channels: ${channels.join(', ') || 'none'}. ` +
    `Category: ${body.product.category}. ` +
    `Trigger: kickoff. ` +
    `Follow your kickoff playbook: dispatch content-planner (week-1), ` +
    `community-scout (scan ${channels.includes('x') ? 'x' : 'connected platforms'}), ` +
    `then reply-drafter (top-3 replies). Skip drafter if no channels.`;
  kickoffConvId = await createAutomationConversation(teamId, 'kickoff');
  const { runId: kickoffRunId } = await enqueueTeamRun({
    teamId,
    trigger: 'kickoff',
    goal,
    rootMemberId: coordinator.id,
    conversationId: kickoffConvId,
  });
  enqueued.push(`team-run:kickoff:${kickoffRunId}`);
  log.info(
    `enqueued kickoff team-run user=${userId} run=${kickoffRunId} conv=${kickoffConvId}`,
  );
} catch (err) {
  // Non-fatal — user already has strategic_path persisted; they can
  // manually trigger a scan from /team if this enqueue failed.
  log.warn(
    `failed to enqueue kickoff team-run (non-fatal) user=${userId}: ${err instanceof Error ? err.message : String(err)}`,
  );
}
```

You will also need to add this import at the top of the file (alongside the existing `teamMembers` schema and `eq` from drizzle-orm — check whether they're already imported and only add what's missing):

```ts
import { teamMembers } from '@/lib/db/schema';
```

> Note `createAutomationConversation` accepts a string trigger name; verify it accepts `'kickoff'` or update `src/lib/team-conversation-helpers.ts` if the signature is restrictive.

- [ ] **Step 2: Update commit response to include conversationId**

In the same file at lines 397-404, replace:

```ts
return NextResponse.json(
  {
    success: true,
    productId,
    enqueued,
  },
  { headers: { 'x-trace-id': traceId } },
);
```

with:

```ts
return NextResponse.json(
  {
    success: true,
    productId,
    conversationId: kickoffConvId,
    enqueued,
  },
  { headers: { 'x-trace-id': traceId } },
);
```

- [ ] **Step 3: Update the existing commit route test**

Open `src/app/api/onboarding/commit/__tests__/route.test.ts` (already in `git status` as modified). Find any assertion that checks the `enqueued` payload referencing `'team-run:weekly:'` and update it to check for `'team-run:kickoff:'`. Add a new assertion for `body.conversationId` being a non-null string.

- [ ] **Step 4: Run the test**

Run: `pnpm vitest run src/app/api/onboarding/commit/__tests__/route.test.ts`
Expected: PASS (after fixture/mock updates)

- [ ] **Step 5: Commit**

```bash
git add src/app/api/onboarding/commit/route.ts src/app/api/onboarding/commit/__tests__/route.test.ts
git commit -m "feat(onboarding): replace content-planner enqueue with coordinator kickoff team-run"
```

---

### Task 10: Update OnboardingFlow redirect

**Files:**
- Modify: `src/components/onboarding/OnboardingFlow.tsx:692-705`

- [ ] **Step 1: Update the redirect**

In `src/components/onboarding/OnboardingFlow.tsx`, locate `onCommit` (around line 656-705). Replace the existing fetch + redirect block at lines 692-704 with:

```ts
const res = await fetch('/api/onboarding/commit', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});
if (!res.ok) {
  const err = (await res.json().catch(() => ({}))) as {
    error?: string;
    detail?: string;
  };
  throw new Error(err.detail || err.error || `Commit failed (${res.status})`);
}
const ok = (await res.json()) as { conversationId?: string | null };
const convQuery = ok.conversationId
  ? `&conv=${encodeURIComponent(ok.conversationId)}`
  : '';
window.location.href = `/team?from=onboarding${convQuery}`;
```

- [ ] **Step 2: Type-check**

Run: `pnpm tsc --noEmit`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src/components/onboarding/OnboardingFlow.tsx
git commit -m "feat(onboarding): redirect to /team after commit"
```

---

### Task 11: TeamDesk reads `?conv=` and shows onboarding banner

**Files:**
- Modify: `src/app/(app)/team/page.tsx`
- Modify: `src/app/(app)/team/_components/team-desk.tsx`
- Create: `src/app/(app)/team/_components/onboarding-banner.tsx`

- [ ] **Step 1: Read query params on the page**

In `src/app/(app)/team/page.tsx`, change the function signature:

```ts
export default async function TeamPage({
  searchParams,
}: {
  searchParams: Promise<{ conv?: string; from?: string }>;
}) {
  const sp = await searchParams;
  // ... existing body unchanged until the `initialConversationId` line
```

Then change the `initialConversationId` resolution near line 400 from:

```ts
const initialConversationId = conversations[0]?.id ?? null;
```

to:

```ts
const requestedConv = typeof sp.conv === 'string' ? sp.conv : null;
const initialConversationId =
  (requestedConv && conversations.find((c) => c.id === requestedConv)?.id) ??
  conversations[0]?.id ??
  null;
const fromOnboarding = sp.from === 'onboarding';
```

Pass `fromOnboarding` to `<TeamDesk fromOnboarding={fromOnboarding} ...>`.

- [ ] **Step 2: Accept the prop in TeamDesk**

In `src/app/(app)/team/_components/team-desk.tsx`, add to `TeamDeskProps`:

```ts
fromOnboarding?: boolean;
```

Destructure in the function body, and render the banner at the top of the rootStyle div, just under `<StatusBanner ... />`:

```tsx
{fromOnboarding && <OnboardingBanner />}
```

Add the import:

```ts
import { OnboardingBanner } from './onboarding-banner';
```

- [ ] **Step 3: Create the banner component**

Create `src/app/(app)/team/_components/onboarding-banner.tsx`:

```tsx
'use client';

import { useEffect, useState, type CSSProperties } from 'react';

const STORAGE_KEY = 'sf:team-onboarding-banner-dismissed:v1';

export function OnboardingBanner(): React.ReactElement | null {
  const [dismissed, setDismissed] = useState(true);
  useEffect(() => {
    try {
      const flag = window.localStorage.getItem(STORAGE_KEY);
      if (flag !== '1') setDismissed(false);
    } catch {
      // localStorage may be blocked — show once anyway, harmless.
      setDismissed(false);
    }
  }, []);

  if (dismissed) return null;

  const wrap: CSSProperties = {
    background: 'var(--sf-accent-soft, oklch(95% 0.04 250))',
    border: '1px solid var(--sf-border-subtle)',
    borderRadius: 'var(--sf-radius-md)',
    padding: '12px 16px',
    margin: '0 0 16px',
    display: 'flex',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: 12,
  };
  const text: CSSProperties = {
    fontSize: 'var(--sf-text-sm)',
    color: 'var(--sf-fg-1)',
    lineHeight: 1.5,
    margin: 0,
  };
  const btn: CSSProperties = {
    background: 'transparent',
    border: 'none',
    color: 'var(--sf-fg-3)',
    cursor: 'pointer',
    fontSize: 'var(--sf-text-sm)',
    padding: '4px 8px',
  };

  return (
    <div style={wrap} role="status" aria-live="polite">
      <p style={text}>
        <strong>Your team just got the brief.</strong>
        {' '}Watch them plan your first week, scan X for live conversations,
        and draft replies — drafts land in <a href="/today">/today</a> for your approval.
      </p>
      <button
        type="button"
        style={btn}
        onClick={() => {
          try {
            window.localStorage.setItem(STORAGE_KEY, '1');
          } catch {
            /* ignore */
          }
          setDismissed(true);
        }}
        aria-label="Dismiss onboarding banner"
      >
        Dismiss
      </button>
    </div>
  );
}
```

- [ ] **Step 4: Type-check**

Run: `pnpm tsc --noEmit`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/app/(app)/team
git commit -m "feat(team): land on kickoff conversation with onboarding banner"
```

---

## Phase 5 — Cron + Manual triggers

### Task 12: Replace `discovery-scan.ts` worker with `discovery-cron-fanout.ts`

**Files:**
- Create: `src/workers/processors/discovery-cron-fanout.ts`
- Create: `src/lib/team-rolling-conversation.ts`
- Delete: `src/workers/processors/discovery-scan.ts`
- Modify: BullMQ worker registration (find with `grep -rn "processDiscoveryScan" src/workers/ src/index.ts 2>/dev/null` — usually `src/workers/index.ts` or similar)

- [ ] **Step 1: Find the worker registration**

Run: `grep -rn "processDiscoveryScan\|discovery-scan" src/workers/ 2>/dev/null | grep -v "__tests__\|.test.ts"`

This will surface (a) the discovery-scan.ts file itself, (b) the worker registration that wires it to BullMQ. Note the file path so you can update it in step 4.

- [ ] **Step 2: Create the rolling-conversation helper**

Create `src/lib/team-rolling-conversation.ts`:

```ts
// Resolves a stable per-team conversation by title (e.g. 'Discovery'),
// creating it on first call. Used by cron team-runs that should bump an
// existing rolling conversation rather than spawning a new one every
// 24 hours.

import { and, desc, eq } from 'drizzle-orm';
import { db } from '@/lib/db';
import { teamConversations } from '@/lib/db/schema';

export async function resolveRollingConversation(
  teamId: string,
  title: string,
): Promise<string> {
  const existing = await db
    .select({ id: teamConversations.id })
    .from(teamConversations)
    .where(
      and(eq(teamConversations.teamId, teamId), eq(teamConversations.title, title)),
    )
    .orderBy(desc(teamConversations.createdAt))
    .limit(1);
  if (existing.length > 0) return existing[0].id;

  const id = crypto.randomUUID();
  await db.insert(teamConversations).values({
    id,
    teamId,
    title,
  });
  return id;
}
```

- [ ] **Step 3: Create the new fanout worker**

Create `src/workers/processors/discovery-cron-fanout.ts`:

```ts
// Daily 13:00 UTC fanout: for each user with at least one connected
// platform AND a product, enqueue one coordinator-rooted team-run with
// trigger='discovery_cron'. The team-run dispatches community-scout +
// reply-drafter via the coordinator's playbook.
//
// Replaces the prior discovery-scan.ts worker — scout no longer runs as
// a standalone BullMQ job; it's a tool inside a team-run.

import type { Job } from 'bullmq';
import { eq } from 'drizzle-orm';
import { db } from '@/lib/db';
import { channels, products, teamMembers } from '@/lib/db/schema';
import { isStopRequested } from '@/lib/automation-stop';
import { ensureTeamExists } from '@/lib/team-provisioner';
import { enqueueTeamRun } from '@/lib/queue/team-run';
import { resolveRollingConversation } from '@/lib/team-rolling-conversation';
import { createLogger, loggerForJob } from '@/lib/logger';
import type { DiscoveryScanJobData } from '@/lib/queue/types';
import { isFanoutJob, getTraceId } from '@/lib/queue/types';

const baseLog = createLogger('worker:discovery-cron-fanout');

export async function processDiscoveryCronFanout(
  job: Job<DiscoveryScanJobData>,
): Promise<void> {
  const log = loggerForJob(baseLog, job);
  const traceId = getTraceId(job.data, job.id);

  if (!isFanoutJob(job.data)) {
    log.warn(
      'discovery-cron-fanout received a non-fanout job; refusing to process',
    );
    return;
  }

  // Distinct (userId) with at least one channel + a product.
  const channelRows = await db
    .select({ userId: channels.userId, platform: channels.platform })
    .from(channels);

  const userPlatforms = new Map<string, Set<string>>();
  for (const c of channelRows) {
    if (!userPlatforms.has(c.userId)) userPlatforms.set(c.userId, new Set());
    userPlatforms.get(c.userId)!.add(c.platform);
  }

  let enqueued = 0;
  for (const [userId, platformSet] of userPlatforms) {
    if (await isStopRequested(userId)) continue;
    const [product] = await db
      .select({ id: products.id, name: products.name })
      .from(products)
      .where(eq(products.userId, userId))
      .limit(1);
    if (!product) continue;

    try {
      const { teamId } = await ensureTeamExists(userId, product.id);
      const memberRows = await db
        .select({ id: teamMembers.id, agentType: teamMembers.agentType })
        .from(teamMembers)
        .where(eq(teamMembers.teamId, teamId));
      const coordinator = memberRows.find((m) => m.agentType === 'coordinator');
      if (!coordinator) {
        log.warn(`user=${userId} team=${teamId} missing coordinator — skipping`);
        continue;
      }
      const conversationId = await resolveRollingConversation(teamId, 'Discovery');
      const platforms = Array.from(platformSet).join(', ');
      const goal =
        `Daily discovery scan for ${product.name}. ` +
        `Connected platforms: ${platforms}. ` +
        `Trigger: discovery_cron. ` +
        `Follow your discovery_cron playbook: scan, then draft top-3 replies.`;
      await enqueueTeamRun({
        teamId,
        trigger: 'discovery_cron',
        goal,
        rootMemberId: coordinator.id,
        conversationId,
      });
      enqueued++;
    } catch (err) {
      log.warn(
        `discovery-cron-fanout: failed to enqueue for user=${userId}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  log.info(`discovery-cron-fanout (trace=${traceId}): enqueued ${enqueued} team-runs`);
}
```

- [ ] **Step 4: Update worker registration**

In whichever file registers `processDiscoveryScan` to its BullMQ queue (found in step 1), change the import + handler:

```ts
// Replace
import { processDiscoveryScan } from './processors/discovery-scan';
// with
import { processDiscoveryCronFanout } from './processors/discovery-cron-fanout';
```

And the worker registration:
```ts
// Replace usages of `processDiscoveryScan` with `processDiscoveryCronFanout`.
```

- [ ] **Step 5: Update the cron schedule to 13:00 UTC daily**

Find where the discovery cron is scheduled (likely `src/lib/queue/index.ts` or a separate `cron.ts` — `grep -rn "discovery.*cron\|repeat.*discovery" src/lib/ src/workers/`). Update the cron expression to:

```ts
// 13:00 UTC daily
{ pattern: '0 13 * * *', tz: 'UTC' }
```

- [ ] **Step 6: Delete the old worker file + test**

```bash
git rm src/workers/processors/discovery-scan.ts
git rm src/workers/processors/__tests__/discovery-scan-v3.test.ts
```

- [ ] **Step 7: Type-check**

Run: `pnpm tsc --noEmit`
Expected: PASS. Type errors here mean some other file imported `processDiscoveryScan` directly — find and update them.

- [ ] **Step 8: Commit**

```bash
git add src/workers/processors src/lib/team-rolling-conversation.ts src/lib/queue
git commit -m "feat(cron): replace discovery-scan worker with team-run fanout (daily 13:00 UTC)"
```

---

### Task 13: Update `/api/discovery/trigger` to enqueue team-run

**Files:**
- Modify: `src/app/api/discovery/trigger/route.ts`

- [ ] **Step 1: Replace the enqueue logic**

Replace the body of the `for (const platformId of connectedPlatforms)` loop. Instead of looping `enqueueDiscoveryScan` per platform, do ONE `enqueueTeamRun` with all platforms in the goal:

```ts
import { ensureTeamExists } from '@/lib/team-provisioner';
import { enqueueTeamRun } from '@/lib/queue/team-run';
import { resolveRollingConversation } from '@/lib/team-rolling-conversation';
import { teamMembers } from '@/lib/db/schema';

// ... inside POST after loading product + connectedPlatforms:

const { teamId } = await ensureTeamExists(session.user.id, product.id);
const memberRows = await db
  .select({ id: teamMembers.id, agentType: teamMembers.agentType })
  .from(teamMembers)
  .where(eq(teamMembers.teamId, teamId));
const coordinator = memberRows.find((m) => m.agentType === 'coordinator');
if (!coordinator) {
  return NextResponse.json(
    { error: 'team_misconfigured', detail: 'coordinator member missing' },
    { status: 500, headers: { 'x-trace-id': traceId } },
  );
}
const conversationId = await resolveRollingConversation(teamId, 'Discovery');
const goal =
  `Manual discovery scan. ` +
  `Platforms: ${connectedPlatforms.join(', ')}. ` +
  `Trigger: manual.`;
const { runId } = await enqueueTeamRun({
  teamId,
  trigger: 'manual',
  goal,
  rootMemberId: coordinator.id,
  conversationId,
});

log.info(`Manual discovery triggered: runId=${runId} platforms=${connectedPlatforms.join(',')}`);

return NextResponse.json(
  { status: 'queued', runId, conversationId, platforms: connectedPlatforms, traceId },
  { headers: { 'x-trace-id': traceId } },
);
```

Remove the now-unused `enqueueDiscoveryScan` import.

- [ ] **Step 2: Type-check**

Run: `pnpm tsc --noEmit`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src/app/api/discovery/trigger/route.ts
git commit -m "feat(discovery): manual trigger enqueues team-run instead of scan job"
```

---

## Phase 6 — Verification

### Task 14: Whole-system verification

- [ ] **Step 1: Type check**

Run: `pnpm tsc --noEmit --pretty false`
Expected: PASS (no errors). Memory note: this is the build gate (vitest uses isolatedModules so type errors slip through tests).

- [ ] **Step 2: Run the full test suite**

Run: `pnpm vitest run`
Expected: PASS (all tests). Failures here likely mean a missing mock or an integration test that exercised the old discovery-scan worker — update to point at the new team-run fanout.

- [ ] **Step 3: Lint**

Run: `pnpm lint`
Expected: PASS (or only pre-existing warnings).

- [ ] **Step 4: Manual smoke (dev server)**

```bash
pnpm dev
```

Open `http://localhost:3000/onboarding`. Run through the flow with an X channel connected. After "Launch the agents" on stage 7, you should be redirected to `/team?from=onboarding&conv=...` with the kickoff banner visible. Watch the chat:

1. Coordinator dispatches three Tasks in parallel
2. content-planner emits `add_plan_item` calls
3. community-scout calls `run_discovery_scan` → returns queued threads
4. reply-drafter calls `draft_reply` × 3 → drafts written
5. Coordinator final summary mentions counts of each

Visit `/today` and verify the drafts are visible for approval.

- [ ] **Step 5: Verify cron fanout shape (without waiting for 13:00 UTC)**

Run: `pnpm cron:fanout-discovery` (or whatever the existing dev-mode trigger is — check `package.json`'s scripts) to invoke `processDiscoveryCronFanout` synchronously for the current logged-in user. Verify it enqueues a team-run with `trigger: 'discovery_cron'` against the `Discovery` rolling conversation.

If no such script exists, smoke this directly with a one-off `tsx` command:

```bash
pnpm tsx -e "import('./src/workers/processors/discovery-cron-fanout').then(m => m.processDiscoveryCronFanout({ data: { kind: 'fanout', schemaVersion: 1, traceId: 'manual-smoke' }, id: 'manual-smoke' } as any))"
```

- [ ] **Step 6: Commit any final fixes from the manual smoke**

```bash
git status
# if any
git add ...
git commit -m "fix: <smoke fixups>"
```

---

## Self-Review

**Spec coverage:**
- ✅ unify discovery into one team-run pipeline (Tasks 12, 13)
- ✅ coordinator dispatches scout + drafter + planner (Task 8)
- ✅ post-onboarding lands on /team (Tasks 9, 10, 11)
- ✅ daily cron at 13:00 UTC (Task 12 step 5)
- ✅ rolling Discovery conversation (Task 12 step 2)
- ✅ no parallel chains: scan/draft path is unique (Tasks 12, 13 delete old)
- ✅ fail-soft: each enqueue is wrapped in try/catch and logged (Tasks 9, 12)

**Open risks:**
1. **`createPlatformDeps` failure mode** — Task 2 assumes it throws when channel missing. Verify this in `src/lib/platform-deps.ts` before running Task 2 step 4 — if the function instead returns null or stub deps, the `try/catch` around it won't fire and the tool will leak past the channel check.
2. **`runSkill` import path** — Task 3 imports from `@/skills/runner`. If the runner is exported differently (e.g. `@/lib/skills/runner` or default export), adjust the import.
3. **`agent_type` text column** — confirmed not an enum, no migration needed (`src/lib/db/schema/team.ts:118`).
4. **`createAutomationConversation` argument list** — Task 9 passes the literal `'kickoff'`. If the helper restricts the trigger string, update the helper signature in the same task.
5. **Coordinator prompt placement** — Task 8 inserts a section. The coordinator AGENT.md may have its own existing dispatch playbook; merge rather than overwrite if so.
6. **Worker process restart** — replacing `discovery-scan.ts` requires the worker process to be redeployed. Note this in the PR body so deploy ordering is correct.
