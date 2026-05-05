# Agent / Skill / Tool Decomposition Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Apply the Tool / Skill / Agent decomposition standard codified in CLAUDE.md to ShipFlare's existing 6 agents — extract embedded business rules into 7 new fork-mode skills, thin agents to pure orchestration, and close the gap where the existing `reviewing-drafts` skill never runs on community-manager / post-writer output.

**Architecture:** Eight phases, each independently shippable behind its own verification gate. Phases A–E (Steps 0–4) form the critical path that fixes the production slop bug: wire `enqueueReview` into draft persistence, upgrade the validating-draft skill with BAD/GOOD pairs and 6 new check categories, extract `drafting-reply` and `judging-opportunity` skills, and thin `community-manager` to ~60 lines. Phase F (Step 3) does the same for posts. Phases G–J (Steps 5–8) migrate the four remaining agents one at a time.

**Tech Stack:** TypeScript, Next.js 15, Zod 3, BullMQ + Redis (`ioredis`), vitest, drizzle-orm, Postgres (Supabase). Skill primitive runtime (`runForkSkill`, `_bundled` registry, `loadSkill`) shipped in 2026-04-30 spec at merge `d5798aa`; this plan consumes it.

**Spec:** `docs/superpowers/specs/2026-05-01-agent-skill-tool-decomposition-design.md`. Two corrections discovered during planning:

1. The DraftReplyTool / DraftPostTool already pull `productId` via `readDomainDeps(ctx)` — no schema change needed for the enqueueReview wire-up.
2. `traceId` is not exposed on the standard `ToolContext`; the wire-up uses an omit-key spread pattern. `reviewJobSchema.traceId` is `z.string().min(1).optional()` (see `src/lib/queue/types.ts:21`) — it rejects empty strings at runtime. The wire-up reads `tryGet<string>(ctx, 'traceId')` and spreads `{ traceId } | {}` based on whether the value is a non-empty string. `withEnvelope` then mints a UUID via its `?? randomUUID()` fallback when the key is absent. Discovered when Phase A Task 1's first review caught a `?? ''` bug; resolved at commit `c3a6353`.

---

## Phase A — Step 0: Wire `enqueueReview` into draft persistence

Closes the gap where 12 production drafts have `review_verdict = NULL` because the existing `reviewing-drafts` skill is never invoked. Single-line additions to two tools, plus a one-shot replay script that captures the pre-Phase-B baseline.

### Task A1: Test that `DraftReplyTool` enqueues review on insert

**Files:**
- Modify: `src/tools/DraftReplyTool/__tests__/DraftReplyTool.test.ts`
- Reference: `src/tools/DraftReplyTool/DraftReplyTool.ts:152-165`

- [ ] **Step 1: Read the existing test file to understand the test harness**

Run: `cat src/tools/DraftReplyTool/__tests__/DraftReplyTool.test.ts | head -80`
Expected: vitest setup with mock db + ToolContext factory.

- [ ] **Step 2: Add a failing test for the enqueueReview side-effect**

Add to `src/tools/DraftReplyTool/__tests__/DraftReplyTool.test.ts` (alongside existing tests):

```typescript
import { vi } from 'vitest';

vi.mock('@/lib/queue', async () => {
  const actual = await vi.importActual<typeof import('@/lib/queue')>('@/lib/queue');
  return {
    ...actual,
    enqueueReview: vi.fn(async () => undefined),
  };
});

import { enqueueReview } from '@/lib/queue';

describe('draft_reply enqueueReview wire-up', () => {
  it('enqueues a review job after a fresh insert', async () => {
    // Arrange: standard ToolContext factory with userId/productId/db already in scope.
    const ctx = makeToolContext({ userId: 'user-1', productId: 'prod-1' });
    seedThread(ctx, { id: 'thread-1', userId: 'user-1', platform: 'x' });

    // Act
    await draftReplyTool.execute(
      {
        threadId: 'thread-1',
        draftBody: 'a real first-person reply with concrete anchor.',
        confidence: 0.8,
      },
      ctx,
    );

    // Assert: enqueueReview called once with the freshly-created draftId
    expect(enqueueReview).toHaveBeenCalledTimes(1);
    expect(enqueueReview).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'user-1',
        productId: 'prod-1',
        draftId: expect.any(String),
      }),
    );
  });

  it('enqueues review on the idempotent update path too', async () => {
    const ctx = makeToolContext({ userId: 'user-1', productId: 'prod-1' });
    seedThread(ctx, { id: 'thread-1', userId: 'user-1', platform: 'x' });
    seedDraft(ctx, { id: 'existing-draft', userId: 'user-1', threadId: 'thread-1', status: 'pending' });

    await draftReplyTool.execute(
      {
        threadId: 'thread-1',
        draftBody: 'updated body still needs review',
        confidence: 0.75,
      },
      ctx,
    );

    expect(enqueueReview).toHaveBeenCalledWith(
      expect.objectContaining({ draftId: 'existing-draft' }),
    );
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm vitest run src/tools/DraftReplyTool`
Expected: FAIL — `enqueueReview` mock receives 0 calls.

- [ ] **Step 4: Commit the failing test**

```bash
git add src/tools/DraftReplyTool/__tests__/DraftReplyTool.test.ts
git commit -m "test(DraftReplyTool): expect enqueueReview after persistence"
```

### Task A2: Implement `enqueueReview` call in `DraftReplyTool`

**Files:**
- Modify: `src/tools/DraftReplyTool/DraftReplyTool.ts`

- [ ] **Step 1: Add the import block**

At the top of `src/tools/DraftReplyTool/DraftReplyTool.ts`, add:

```typescript
import { enqueueReview } from '@/lib/queue';
import { tryGet, readDomainDeps } from '@/tools/context-helpers';
```

(Replace the existing single-import line for `readDomainDeps` with the combined form.)

- [ ] **Step 1.5: Compute productId + traceIdPart once at the top of execute()**

Just after the existing `const { db, userId } = readDomainDeps(ctx);` line, add:

```typescript
const { productId } = readDomainDeps(ctx);
const ctxTraceId = tryGet<string>(ctx, 'traceId');
const traceIdPart =
  typeof ctxTraceId === 'string' && ctxTraceId.length > 0
    ? { traceId: ctxTraceId }
    : {};
```

**Why omit-key spread, not `?? ''` or `?? undefined`:** `reviewJobSchema.traceId` is `z.string().min(1).optional()` (see `src/lib/queue/types.ts:21`). An empty string fails `.min(1)` at runtime. `undefined` passes `.optional()` but leaves the field present-but-undefined which is awkward to assert in tests. The spread `...traceIdPart` either includes a non-empty string or omits the key entirely — matching Zod `.optional()` semantics exactly. `withEnvelope` then mints a UUID via its `?? randomUUID()` fallback when the key is absent.

- [ ] **Step 2: Wire enqueueReview after the insert path (line ~165)**

Change the bottom of `execute()` from:

```typescript
      const draftId = crypto.randomUUID();
      await db.insert(drafts).values({
        id: draftId,
        userId,
        threadId: thread.id,
        status: 'pending',
        draftType: 'reply',
        replyBody: input.draftBody,
        confidenceScore: input.confidence,
        whyItWorks: input.whyItWorks ?? null,
        planItemId: input.planItemId ?? null,
        engagementDepth: 0,
      });

      return {
        draftId,
        threadId: thread.id,
        platform: thread.platform,
      };
```

to:

```typescript
      const draftId = crypto.randomUUID();
      await db.insert(drafts).values({
        id: draftId,
        userId,
        threadId: thread.id,
        status: 'pending',
        draftType: 'reply',
        replyBody: input.draftBody,
        confidenceScore: input.confidence,
        whyItWorks: input.whyItWorks ?? null,
        planItemId: input.planItemId ?? null,
        engagementDepth: 0,
      });

      await enqueueReview({
        userId,
        productId,
        draftId,
        ...traceIdPart,
      });

      return {
        draftId,
        threadId: thread.id,
        platform: thread.platform,
      };
```

- [ ] **Step 3: Wire enqueueReview on the idempotent update branch (line ~144)**

Change the early-return inside the `if (existingPending.length > 0)` block from:

```typescript
        return {
          draftId: existingId,
          threadId: thread.id,
          platform: thread.platform,
        };
```

to:

```typescript
        await enqueueReview({
          userId,
          productId,
          draftId: existingId,
          ...traceIdPart,
        });

        return {
          draftId: existingId,
          threadId: thread.id,
          platform: thread.platform,
        };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/tools/DraftReplyTool`
Expected: PASS — both new tests green; existing tests unaffected.

- [ ] **Step 5: Type-check**

Run: `pnpm tsc --noEmit`
Expected: clean exit (no new type errors).

- [ ] **Step 6: Commit**

```bash
git add src/tools/DraftReplyTool/DraftReplyTool.ts
git commit -m "feat(DraftReplyTool): enqueue review after persistence on both paths"
```

### Task A3: ~~Test that `DraftPostTool` enqueues review on insert~~ — N/A, verify-only

**Architectural reality** (discovered during Phase A execution on 2026-05-01):

`DraftPostTool` does NOT insert into the `drafts` table. It writes to
`plan_items.output.draft_body` and flips `plan_items.state` to
`'drafted'` (see `src/tools/DraftPostTool/DraftPostTool.ts:130-143`).
Only `DraftReplyTool` and `engagement.ts` ever insert rows into
`drafts`. The schema's `drafts.draftType` enum supports
`'original_post'`, but no code path actually writes such rows today.

The `reviewQueue` payload schema (`src/lib/queue/types.ts:33`)
requires `draftId: z.string().min(1)` — there is no draftId to
enqueue when posts only live as a JSON blob on a plan_items row.

So **wiring `enqueueReview` into `DraftPostTool` is not possible
without an architectural change** (one of: making DraftPostTool
double-write to `drafts`, relaxing `drafts.threadId NOT NULL`, or
adding a separate review path that watches `plan_items.state`). All
three are out of scope for Phase A.

**This task is verify-only:**

- [ ] **Step 1: Confirm the architectural reality**

Run: `grep -rn "insert(drafts" src --include="*.ts" | grep -v __tests__`
Expected: only `DraftReplyTool.ts` and `engagement.ts` show up.

- [ ] **Step 2: Confirm DraftPostTool's persistence target**

Run: `grep -n "update(planItems\|insert(drafts" src/tools/DraftPostTool/DraftPostTool.ts`
Expected: only `update(planItems)` shows up.

- [ ] **Step 3: No commit; this is a documentation task**

The architectural gap is documented in this plan's preamble (see "two
corrections discovered during planning") and in the post-review-pipeline
follow-up note below.

### Post-review-pipeline follow-up (out of scope for this plan)

The `validating-draft` skill currently never runs on original-post
output. Three design options for a follow-up phase:

1. **Double-write** — DraftPostTool inserts a `drafts` row with
   `draftType='original_post'` AND updates `plan_items.output`. Needs
   `drafts.threadId NOT NULL` relaxed (or a synthetic threadId pinned
   to the plan_item id).
2. **Separate review path** — new worker watches `plan_items.state =
   'drafted'`, runs `validating-draft`, persists results to a new
   `plan_items.review_json` column. Requires migration.
3. **Pre-persist review** — post-writer agent calls `validating-draft`
   skill itself before invoking `draft_post`. Cleanest from the
   skill-decomposition standpoint but reintroduces the "agent does
   write+review in same session" risk that drafting/validating fork
   separation was supposed to fix.

This decision should be brainstormed separately. For now, posts go
through `validate_draft` (mechanical) but skip the LLM `validating-draft`
review pass.

### Task A5: Write the replay script

**Files:**
- Create: `scripts/replay-validating-draft.ts`

- [ ] **Step 1: Create the script skeleton**

Create `scripts/replay-validating-draft.ts`:

```typescript
/**
 * One-shot replay: take every pending draft in the database, push it
 * through the current `reviewing-drafts` (later `validating-draft`)
 * skill, and emit a JSON report of verdicts. Used to capture the
 * pre-migration baseline (Step 0) and the post-migration outcome
 * (Step 1) for direct comparison.
 *
 * Usage: pnpm tsx scripts/replay-validating-draft.ts [--limit=N] [--out=path.json]
 */
import { db } from '@/lib/db';
import { drafts, threads, products } from '@/lib/db/schema';
import { eq } from 'drizzle-orm';
import { runForkSkill } from '@/skills/run-fork-skill';
import { reviewingDraftsOutputSchema } from '@/skills/reviewing-drafts/schema';
import { writeFileSync } from 'node:fs';

interface ReplayRow {
  draftId: string;
  threadId: string;
  platform: string;
  community: string;
  draftType: string;
  replyBody: string;
  verdict: string;
  score: number;
  issues: unknown[];
}

const LIMIT = Number(process.argv.find((a) => a.startsWith('--limit='))?.split('=')[1] ?? '50');
const OUT = process.argv.find((a) => a.startsWith('--out='))?.split('=')[1] ?? `replay-${new Date().toISOString().slice(0, 10)}.json`;

async function main() {
  const rows = await db
    .select({
      draftId: drafts.id,
      userId: drafts.userId,
      threadId: drafts.threadId,
      replyBody: drafts.replyBody,
      confidence: drafts.confidenceScore,
      draftType: drafts.draftType,
      whyItWorks: drafts.whyItWorks,
    })
    .from(drafts)
    .where(eq(drafts.status, 'pending'))
    .limit(LIMIT);

  const out: ReplayRow[] = [];

  for (const row of rows) {
    const [thread] = await db.select().from(threads).where(eq(threads.id, row.threadId)).limit(1);
    if (!thread) continue;

    // For the baseline run we don't have productId on the draft — pull
    // from the user's first product as a best-effort.
    const [product] = await db.select().from(products).limit(1);
    if (!product) continue;

    const args = JSON.stringify({
      drafts: [
        {
          replyBody: row.replyBody,
          threadTitle: thread.title,
          threadBody: thread.body ?? '',
          subreddit: thread.community,
          productName: product.name,
          productDescription: product.description,
          confidence: row.confidence,
          whyItWorks: row.whyItWorks ?? '',
        },
      ],
      memoryContext: '',
    });

    try {
      const { result } = await runForkSkill(
        'reviewing-drafts',
        args,
        reviewingDraftsOutputSchema,
      );
      out.push({
        draftId: row.draftId,
        threadId: row.threadId,
        platform: thread.platform,
        community: thread.community,
        draftType: row.draftType,
        replyBody: row.replyBody,
        verdict: result.verdict,
        score: result.score,
        issues: result.issues,
      });
      console.log(`[${row.draftId}] verdict=${result.verdict} score=${result.score.toFixed(2)}`);
    } catch (err) {
      console.error(`[${row.draftId}] replay failed:`, err);
    }
  }

  writeFileSync(OUT, JSON.stringify(out, null, 2));
  console.log(`\nWrote ${out.length} verdicts to ${OUT}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
```

- [ ] **Step 2: Add a script entry to package.json**

In `package.json` under `"scripts"`, add:

```json
"replay:validating-draft": "tsx scripts/replay-validating-draft.ts"
```

- [ ] **Step 3: Type-check**

Run: `pnpm tsc --noEmit`

- [ ] **Step 4: Commit**

```bash
git add scripts/replay-validating-draft.ts package.json
git commit -m "chore(scripts): add replay-validating-draft baseline harness"
```

### Task A6: Run the replay against production data, capture baseline

**Files:**
- Create: `docs/superpowers/specs/replay-baselines/2026-05-01-baseline.json` (committed for diff comparison in Phase B)

- [ ] **Step 1: Run the replay**

Run: `pnpm replay:validating-draft --limit=50 --out=docs/superpowers/specs/replay-baselines/2026-05-01-baseline.json`
Expected: outputs ~12 rows (current pending drafts) plus any historical samples included.

- [ ] **Step 2: Inspect verdict distribution**

Run: `jq '[.[] | .verdict] | group_by(.) | map({verdict: .[0], count: length})' docs/superpowers/specs/replay-baselines/2026-05-01-baseline.json`
Expected: a verdict-count breakdown. Note this baseline number (likely most rows PASS or no verdict) — Phase B will recompare against it.

- [ ] **Step 3: Commit the baseline file**

```bash
git add docs/superpowers/specs/replay-baselines/2026-05-01-baseline.json
git commit -m "docs(baselines): capture pre-Phase-B validating-draft baseline"
```

**Phase A verification gate:** Reply drafts persisted via `DraftReplyTool` now enqueue a review job (verified by smoke-testing a community-manager run and seeing the new draft's `review_verdict` populate within ~30s of insertion); `docs/superpowers/specs/replay-baselines/2026-05-01-baseline.json` records the pre-Phase-B verdict distribution; the post-review-pipeline gap is documented as a follow-up (post-writer output skips the LLM review pass for now and continues to rely on the `validate_draft` mechanical layer).

---

## Phase B — Step 1: Upgrade `validating-draft` skill

Renames `reviewing-drafts` → `validating-draft`, rewrites references as BAD/GOOD pairs from real DB samples, adds 6 new check categories targeting today's failure modes, migrates the dead `ai-slop-validator.ts` regex pack into reference prose, bumps the skill model from Haiku to Sonnet.

### Task B1: Rename skill directory and update consumers

**Files:**
- Rename: `src/skills/reviewing-drafts/` → `src/skills/validating-draft/`
- Modify: `src/workers/processors/review.ts`
- Modify: `src/skills/_bundled/index.ts` (if it imports the skill)
- Modify: `src/hooks/use-agent-stream.ts:15` (comment reference)

- [ ] **Step 1: Rename the directory**

```bash
git mv src/skills/reviewing-drafts src/skills/validating-draft
```

- [ ] **Step 2: Update the SKILL.md frontmatter**

Edit `src/skills/validating-draft/SKILL.md` line 2: change `name: reviewing-drafts` to `name: validating-draft`.

- [ ] **Step 3: Update the worker reference**

Edit `src/workers/processors/review.ts` line 78: change `'reviewing-drafts'` to `'validating-draft'`. Also update the import path on line 6: `from '@/skills/reviewing-drafts/schema'` → `from '@/skills/validating-draft/schema'`.

- [ ] **Step 4: Update any other import sites**

Run: `grep -rn "reviewing-drafts\|reviewing_drafts" src scripts --include="*.ts" --include="*.md"`

Includes `scripts/` because `scripts/replay-validating-draft.ts` from Task A5 imports the old path. Update each match — change `from '@/skills/reviewing-drafts/schema'` to `from '@/skills/validating-draft/schema'` and the skill name string `'reviewing-drafts'` to `'validating-draft'`.

Excluding test directories that exercise the renamed skill — those follow naturally as the skill loader will find the new directory.

- [ ] **Step 5: Run all tests**

Run: `pnpm vitest run`
Expected: all tests pass with the new name.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "refactor(skills): rename reviewing-drafts to validating-draft"
```

### Task B2: Add `slopFingerprint` to the output schema (TDD)

**Files:**
- Modify: `src/skills/validating-draft/schema.ts`
- Modify: `src/skills/validating-draft/__tests__/validating-draft.test.ts` (rename if needed, or create)

- [ ] **Step 1: Add a failing test**

Create or extend `src/skills/validating-draft/__tests__/validating-draft.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { validatingDraftOutputSchema } from '../schema';

const sampleChecks = [
  { name: 'relevance', result: 'PASS' as const, detail: 'addresses the OP' },
  { name: 'value_first', result: 'PASS' as const, detail: 'concrete anchor present' },
];

describe('validating-draft output schema', () => {
  it('accepts a verdict with slopFingerprint listing matched patterns', () => {
    const valid = validatingDraftOutputSchema.parse({
      verdict: 'FAIL',
      score: 0.2,
      checks: [
        { name: 'authenticity', result: 'FAIL' as const, detail: 'no first-person token' },
      ],
      issues: ['diagnostic-from-above frame'],
      suggestions: ['rewrite with first-person receipt'],
      slopFingerprint: ['diagnostic_from_above', 'no_first_person', 'fortune_cookie_closer'],
    });
    expect(valid.slopFingerprint).toEqual([
      'diagnostic_from_above',
      'no_first_person',
      'fortune_cookie_closer',
    ]);
  });

  it('treats slopFingerprint as optional with empty default', () => {
    const valid = validatingDraftOutputSchema.parse({
      verdict: 'PASS',
      score: 0.9,
      checks: sampleChecks,
      issues: [],
      suggestions: [],
    });
    expect(valid.slopFingerprint).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test, verify it fails**

Run: `pnpm vitest run src/skills/validating-draft/__tests__/validating-draft.test.ts`
Expected: FAIL — `slopFingerprint` is not on the schema.

- [ ] **Step 3: Add the field to the schema**

Read `src/skills/validating-draft/schema.ts` first. The existing schema uses an **array** form for `checks` (each entry is `{ name, result: 'PASS' | 'FAIL', detail }`). Keep that shape — the slop fix doesn't depend on restructuring the rubric. Only add the new `slopFingerprint` field and the renamed export + backwards-compat alias.

```typescript
import { z } from 'zod';

const slopPatternId = z.enum([
  'diagnostic_from_above',
  'no_first_person',
  'fortune_cookie_closer',
  'colon_aphorism_opener',
  'naked_number_unsourced',
  'em_dash_overuse',
  'binary_not_x_its_y',
  'preamble_opener',
  'banned_vocabulary',
  'triple_grouping',
  'negation_cadence',
  'engagement_bait_filler',
]);

export const validatingDraftOutputSchema = z.object({
  verdict: z.enum(['PASS', 'FAIL', 'REVISE']),
  score: z.number(),
  checks: z.array(
    z.object({
      name: z.string(),
      result: z.enum(['PASS', 'FAIL']),
      detail: z.string(),
    }),
  ),
  issues: z.array(z.string()),
  suggestions: z.array(z.string()),
  slopFingerprint: z.array(slopPatternId).default([]),
});

export type ValidatingDraftOutput = z.infer<typeof validatingDraftOutputSchema>;

// Backwards-compat alias for code that imported the old name during the
// renaming PR. Remove in the cleanup commit at end of Phase B.
export const reviewingDraftsOutputSchema = validatingDraftOutputSchema;
```

**Why preserve the array shape:** The Phase A baseline run found that the rubric's 6 checks are doing fine — it's the slop pattern detection that's missing. Restructuring `checks` from array→object would force updates across `output-format.md`, `review.ts:90`, and any UI consumer for no catch-rate gain. Defer that refactor unless a later phase needs it.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/skills/validating-draft/__tests__/validating-draft.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/skills/validating-draft/schema.ts src/skills/validating-draft/__tests__/validating-draft.test.ts
git commit -m "feat(validating-draft): add slopFingerprint to output schema"
```

### Task B3: Migrate ai-slop-validator regex pack into reference markdown

**Files:**
- Create: `src/skills/validating-draft/references/slop-rules.md`
- Reference: `src/lib/reply/ai-slop-validator.ts`

- [ ] **Step 1: Read the existing slop validator for content**

Run: `cat src/lib/reply/ai-slop-validator.ts`

- [ ] **Step 2: Create slop-rules.md with BAD/GOOD pairs**

Create `src/skills/validating-draft/references/slop-rules.md`:

````markdown
# Slop rules

Twelve patterns that fail or revise a draft. Each rule names the
matching `slopFingerprint` ID. When a draft matches a rule, append
the ID to your output's `slopFingerprint` array and surface the
matched span in `issues`.

## diagnostic_from_above (HARD FAIL)

The draft tells the OP what their situation "really" is, instead of
joining the conversation from the writer's own experience. The
fingerprint is a colon-as-wisdom opener combined with second-person
diagnosis.

**Triggers:**
- Opens with `the (real|cruel|hard|insight|trap|trick|catch)\s*[:—]`
- Uses second-person diagnosis: `you're (playing|naming|chasing|fighting|missing)`
- Closes with `that's the (moat|game|trick|trap|catch|tax|cost|truth)`
- Universal claims: `(always|never|every|most) (founders|indies|solo devs|builders)`

**BAD:** `the cruel part: you don't control which work gets seen. that's the moat.`

**BAD:** `you're naming the real thing: marketing asks you to bet on yourself before anyone else has.`

**GOOD:** `this hit me on Glitches month 2 — my best feature got 3 impressions, a typo got 200. felt unfair until I realized I'd shipped without an audience.`

## no_first_person (HARD FAIL when paired with generalized claim)

The draft makes a generalized pronouncement about how the world works
but contains no `I / we / my / our / me / us` token. Per
`reply-quality-bar`, generalized claims must carry first-person
specifics from the writer's own run.

**Trigger:** draft contains any of `the real X is Y`, `the X: <wisdom>`,
`most/all/every <noun-class> do X`, `winners do X`, AND
`/\b(I|we|my|our|me|us)\b/i` does not match anywhere in the draft.

**BAD:** `the algorithm compounds early replies. your 1st post gets 0 distribution because it's cold-start.`

**GOOD:** `we tried hammering hour-1 replies for a month — bookmarks 3x'd on the days we hit the first 15 minutes. cold-starts didn't recover.`

## fortune_cookie_closer

Tagline-style closing aphorism that pattern-matches to LinkedIn
carousel slide energy.

**Triggers:** terminal sentence matches `that's the (moat|game|trick|trap|catch|tax|cost|truth|insight|secret|key)`.

**BAD:** `... that's the moat.`

**GOOD:** drop the closer entirely; let the anchor carry the weight.

## colon_aphorism_opener

Wisdom-as-colon opening structure.

**Trigger:** first ~30 chars match `^(the (real|cruel|hard|insight|trap|trick|catch)|here's the (real|trick|catch))[:\s—]`.

**BAD:** `the insight: 3 impressions day one wasn't the problem. it was shipping without an audience.`

**GOOD:** `3 impressions day one — felt like the algorithm was broken. turned out I shipped without an audience.`

## naked_number_unsourced

Bare numbers paired with time / count units that read as authoritative
data without a citation. Distinct from the
`hallucinated_stats` validator (which catches `%`, `Nx`, `over N`,
`up to N`, `$N`).

**Trigger:** `\b\d+\s+(seconds|minutes|hours|days|weeks|months|years|times|posts|users|impressions|founders|comments|replies|interviews)\b` AND no in-sentence citation (per the `hallucinated-stats` citation list).

**BAD:** `code gives you a feedback loop in 2 seconds. marketing gives you silence for 2 weeks.`

**BAD:** `solos spend 6 months figuring out they lost.`

**GOOD:** `we shipped on a Tuesday and the first paying customer landed 11 days later — way longer than the 2-day cycle I was used to in code.`

## em_dash_overuse

Two or more em-dashes in a single reply.

**Trigger:** `text.match(/—|---| -- /g).length >= 2`

**BAD:** `the algorithm compounds early replies — your 1st post gets 0 distribution — by day 3 it's useless.`

**GOOD:** rewrite as two sentences with no dashes.

## binary_not_x_its_y

`X isn't / it's not (just) Y, it's Z` form — direct rewrite of the
2024-25 LinkedIn-Twitter aphorism template.

**Trigger:** `\b(?:it's|this is)\s+not(?:\s+just)?\s+[\w\s]{1,40}[,.—\-]+\s*(?:it's|this is|—|-)\s*[\w\s]{1,40}`

**BAD:** `visibility isn't phase 2 — it's phase 1.`

**GOOD:** `I shipped before I had anyone watching. visibility had to come before phase 2 features.`

## preamble_opener

Banned generic openers that pattern-match to bot energy.

**Trigger:** first ~20 chars match any of:
- `^\s*great (?:post|point|question|take|thread)\b`
- `^\s*(?:interesting|fascinating) (?:take|point|perspective)\b`
- `^\s*as (?:a|someone who)\b`
- `^\s*i (?:noticed|saw) (?:you|that you)\b`
- `^\s*have you considered\b`
- `^\s*absolutely[\s,.!]`
- `^\s*love this\b`

**GOOD:** open with the specific anchor, not the meta.

## banned_vocabulary

Corporate / AI-pattern vocabulary regardless of position.

**Trigger:** any of `delve, leverage, utilize, robust, crucial, pivotal, demystify, landscape, ecosystem, journey, seamless, navigate, compelling` appears (whole-word match).

**GOOD:** rewrite the sentence with concrete verbs.

## triple_grouping

Three comma-separated 3+-letter words in a row, optionally with "and".

**Trigger:** `\b(\w{3,}),\s+(\w{3,}),\s+(?:and\s+)?(\w{3,})\b`

**BAD:** `clean, simple, fast`

**GOOD:** pick one and earn it with a number.

## negation_cadence

Rhythmic `no X. no Y.` pair.

**Trigger:** `\bno\s+\w+[.!]\s+no\s+\w+[.!]`

**BAD:** `no fluff. no theory. just results.`

## engagement_bait_filler

Standalone filler replies.

**Trigger:** whole-reply match against `^(this\.?|100\s*%\.?|so true[!.]*|bookmarked|\+1|this really resonates)\s*$`

**GOOD:** if the draft is one of these, the founder should Like the post instead.
````

- [ ] **Step 3: Verify file syntax**

Run: `head -10 src/skills/validating-draft/references/slop-rules.md`

- [ ] **Step 4: Commit**

```bash
git add src/skills/validating-draft/references/slop-rules.md
git commit -m "docs(validating-draft): add slop-rules reference with BAD/GOOD pairs"
```

### Task B4: Update `SKILL.md` to consume the new reference and emit slopFingerprint

**Files:**
- Modify: `src/skills/validating-draft/SKILL.md`

- [ ] **Step 1: Read current SKILL.md for context**

Run: `cat src/skills/validating-draft/SKILL.md`

- [ ] **Step 2: Add `slop-rules` to the `references:` frontmatter list**

Edit the YAML frontmatter to add the new reference:

```yaml
---
name: validating-draft
description: Adversarial quality reviewer for content drafts. Receives a draft + context, runs a 6-check rubric plus a 12-pattern slop check, returns PASS/FAIL/REVISE with per-check detail and a slopFingerprint listing matched patterns.
context: fork
model: claude-sonnet-4-6
maxTurns: 2
allowed-tools:
  - validate_draft
references:
  - output-format
  - review-checklist
  - x-review-rules
  - slop-rules
---
```

(Note both the `model` change to Sonnet and the new reference.)

- [ ] **Step 3: Add the slop check section to the body**

Insert a new section after the existing "Checks (ALL Required)" block:

```markdown
## Slop Pattern Check (REQUIRED — emits slopFingerprint)

Apply every rule in the `slop-rules` reference to the draft body. For
each rule that matches, append its fingerprint ID to your output's
`slopFingerprint` array and add a one-line entry to `issues`.

Hard-fail rules (verdict cannot be PASS if matched):
- `diagnostic_from_above`
- `no_first_person` (when paired with a generalized claim)
- `binary_not_x_its_y`
- `preamble_opener`
- `banned_vocabulary`
- `engagement_bait_filler`

Revise-or-tighten rules (verdict at most REVISE if matched):
- `fortune_cookie_closer`
- `colon_aphorism_opener`
- `naked_number_unsourced`
- `em_dash_overuse`
- `triple_grouping`
- `negation_cadence`

If `slopFingerprint` is empty AND the six rubric checks pass, verdict
is PASS. If any hard-fail rule matched, verdict is FAIL. Otherwise
REVISE.
```

- [ ] **Step 4: Update the Output section**

Replace the existing Output section with:

```markdown
## Output

Return a JSON object following the exact schema defined in the
References section. Always populate `slopFingerprint` (empty array
if no patterns matched). Do not wrap in markdown code fences. Start
with `{` and end with `}`.
```

- [ ] **Step 5: Commit**

```bash
git add src/skills/validating-draft/SKILL.md
git commit -m "feat(validating-draft): wire slop-rules + slopFingerprint into SKILL.md"
```

### Task B5: Update output-format reference to document slopFingerprint

**Files:**
- Modify: `src/skills/validating-draft/references/output-format.md`

- [ ] **Step 1: Read the current output-format reference**

Run: `cat src/skills/validating-draft/references/output-format.md`

- [ ] **Step 2: Add the slopFingerprint field documentation**

Add a section to `output-format.md` describing:

```markdown
## slopFingerprint

Array of slop pattern IDs (see `slop-rules`) that matched this draft.
Empty when no patterns matched. The IDs are a closed enum:

- `diagnostic_from_above`
- `no_first_person`
- `fortune_cookie_closer`
- `colon_aphorism_opener`
- `naked_number_unsourced`
- `em_dash_overuse`
- `binary_not_x_its_y`
- `preamble_opener`
- `banned_vocabulary`
- `triple_grouping`
- `negation_cadence`
- `engagement_bait_filler`

Always include this field, even when empty. Telemetry downstream
(per-user voice tuning, weekly retro) reads this field to track
which patterns the drafter falls into.
```

- [ ] **Step 3: Commit**

```bash
git add src/skills/validating-draft/references/output-format.md
git commit -m "docs(validating-draft): document slopFingerprint in output-format"
```

### Task B6: Wire `validating-draft` skill into bundled registry (if needed)

**Files:**
- Modify: `src/skills/_bundled/index.ts` (if applicable)

- [ ] **Step 1: Check if the skill is loaded via bundled registration or filesystem walk**

Run: `grep -rn "reviewing-drafts\|validating-draft" src/skills/_bundled/`
If empty, the skill is loaded by `loadSkillsDir` filesystem walk and no bundled change is needed — skip to next task.

- [ ] **Step 2: If a bundled file exists, update its `name` field**

Edit the corresponding `_bundled/<name>.ts` file's `registerBundledSkill({ name: 'validating-draft', ... })` call.

- [ ] **Step 3: Commit if changed**

```bash
git add src/skills/_bundled
git commit -m "refactor(skills/_bundled): align registration with validating-draft rename"
```

### Task B7: Persist `slopFingerprint` in `drafts.review_json`

**Files:**
- Reference: `src/workers/processors/review.ts:90`

- [ ] **Step 1: Add a failing test for review processor persisting slopFingerprint**

Add to `src/workers/processors/__tests__/review.test.ts` (create file if missing, mirroring patterns from existing processor tests):

```typescript
it('persists slopFingerprint into drafts.review_json', async () => {
  // Arrange: stub runForkSkill to return { verdict: 'FAIL', slopFingerprint: ['diagnostic_from_above'] }
  // Act: call processReview with a synthetic job
  // Assert: db.update was called with reviewJson.slopFingerprint = ['diagnostic_from_above']
});
```

(Keep the test arrangement minimal — only assert that the new field flows through.)

- [ ] **Step 2: Run test, verify it fails**

Run: `pnpm vitest run src/workers/processors/__tests__/review.test.ts`

- [ ] **Step 3: Update review.ts to include slopFingerprint in the persisted reviewJson**

Edit `src/workers/processors/review.ts:90`. Change:

```typescript
reviewJson: { checks: result.checks, issues: result.issues, suggestions: result.suggestions },
```

to:

```typescript
reviewJson: {
  checks: result.checks,
  issues: result.issues,
  suggestions: result.suggestions,
  slopFingerprint: result.slopFingerprint ?? [],
},
```

- [ ] **Step 4: Run test, verify it passes**

Run: `pnpm vitest run src/workers/processors/__tests__/review.test.ts`

- [ ] **Step 5: Type-check**

Run: `pnpm tsc --noEmit`

- [ ] **Step 6: Commit**

```bash
git add src/workers/processors/review.ts src/workers/processors/__tests__/review.test.ts
git commit -m "feat(review): persist slopFingerprint in drafts.review_json"
```

### Task B8: Re-run the replay, compare to baseline

**Files:**
- Create: `docs/superpowers/specs/replay-baselines/2026-05-01-phase-b.json`

- [ ] **Step 1: Run replay against new skill**

Run: `pnpm replay:validating-draft --limit=50 --out=docs/superpowers/specs/replay-baselines/2026-05-01-phase-b.json`

- [ ] **Step 2: Diff verdicts side-by-side**

Run:
```bash
jq -n --slurpfile a docs/superpowers/specs/replay-baselines/2026-05-01-baseline.json --slurpfile b docs/superpowers/specs/replay-baselines/2026-05-01-phase-b.json '
  [$a[0][], $b[0][]]
  | group_by(.draftId)
  | map({
      draftId: .[0].draftId,
      pre: (.[0].verdict // "n/a"),
      post: (.[1].verdict // "n/a"),
      slop: (.[1].issues // [])
    })'
```

Expected: ≥ 11 of 12 production drafts move from PASS / no-verdict to FAIL or REVISE, and `slopFingerprint` arrays are populated with the matched patterns.

- [ ] **Step 3: If ≥11/12 catch-rate hit, commit**

```bash
git add docs/superpowers/specs/replay-baselines/2026-05-01-phase-b.json
git commit -m "docs(baselines): Phase B validating-draft replay catches 11/12 production drafts"
```

If the catch rate is lower, iterate on the `slop-rules` BAD examples until the gate passes — the rules are the source of truth and must actually catch the production failures we built them against.

**Phase B verification gate:** Replay catches ≥11/12 of the production drafts as FAIL/REVISE; `slopFingerprint` is populated and persisted in DB; `pnpm vitest run` and `pnpm tsc --noEmit` are green.

---

## Phase C — Step 2: Extract `drafting-reply` skill, thin `community-manager`

Creates `drafting-reply` skill carrying X / Reddit voice + anchor + length rules. Cuts `community-manager/AGENT.md` to ~60 lines of pure orchestration. Splits `reply-quality-bar.md` so gates 1/2/3 stay with the agent and voice rules move to the skill.

### Task C1: Define `drafting-reply` schema (TDD)

**Files:**
- Create: `src/skills/drafting-reply/schema.ts`
- Create: `src/skills/drafting-reply/__tests__/drafting-reply.test.ts`

- [ ] **Step 1: Add a failing schema test**

Create `src/skills/drafting-reply/__tests__/drafting-reply.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { draftingReplyInputSchema, draftingReplyOutputSchema } from '../schema';

describe('drafting-reply schema', () => {
  it('accepts valid input shape', () => {
    expect(() =>
      draftingReplyInputSchema.parse({
        thread: {
          title: 'launching this Tuesday',
          body: 'here is the screenshot of the dashboard',
          author: 'someone',
          platform: 'x',
          community: 'x',
        },
        product: { name: 'ShipFlare', description: 'AI growth' },
        channel: 'x',
      }),
    ).not.toThrow();
  });

  it('rejects unknown channel', () => {
    expect(() =>
      draftingReplyInputSchema.parse({
        thread: { title: 't', body: '', author: 'a', platform: 'x', community: 'x' },
        product: { name: 'ShipFlare', description: 'AI' },
        channel: 'instagram',
      }),
    ).toThrow();
  });

  it('output shape includes draftBody, whyItWorks, confidence', () => {
    const parsed = draftingReplyOutputSchema.parse({
      draftBody: 'we shipped revenue analytics yesterday — first user spotted a $1,247 leak in 4 minutes.',
      whyItWorks: 'first-person anchor + specific number',
      confidence: 0.85,
    });
    expect(parsed.confidence).toBeGreaterThan(0.8);
  });
});
```

- [ ] **Step 2: Run test, verify failure**

Run: `pnpm vitest run src/skills/drafting-reply`
Expected: FAIL — schema file does not exist.

- [ ] **Step 3: Create schema.ts**

Create `src/skills/drafting-reply/schema.ts`:

```typescript
import { z } from 'zod';

const channelEnum = z.enum(['x', 'reddit']);

const voiceCluster = z.enum([
  'terse_shipper',
  'vulnerable_philosopher',
  'daily_vlogger',
  'patient_grinder',
  'contrarian_analyst',
]);

export const draftingReplyInputSchema = z.object({
  thread: z.object({
    title: z.string(),
    body: z.string().default(''),
    author: z.string().optional().default(''),
    platform: channelEnum,
    community: z.string(),
    url: z.string().optional(),
  }),
  product: z.object({
    name: z.string(),
    description: z.string(),
    valueProp: z.string().optional(),
  }),
  channel: channelEnum,
  voice: z.union([voiceCluster, z.string()]).optional(),
  founderVoiceBlock: z.string().optional(),
  canMentionProduct: z.boolean().optional().default(false),
});

export type DraftingReplyInput = z.infer<typeof draftingReplyInputSchema>;

export const draftingReplyOutputSchema = z.object({
  draftBody: z.string().min(1),
  whyItWorks: z.string().max(500),
  confidence: z.number().min(0).max(1),
});

export type DraftingReplyOutput = z.infer<typeof draftingReplyOutputSchema>;
```

- [ ] **Step 4: Run test, verify pass**

Run: `pnpm vitest run src/skills/drafting-reply`

- [ ] **Step 5: Commit**

```bash
git add src/skills/drafting-reply
git commit -m "feat(drafting-reply): add input/output schemas with TDD"
```

### Task C2: Create the SKILL.md

**Files:**
- Create: `src/skills/drafting-reply/SKILL.md`

- [ ] **Step 1: Write the SKILL.md**

Create `src/skills/drafting-reply/SKILL.md`:

````markdown
---
name: drafting-reply
description: Draft ONE reply body for a single thread. Receives the thread + product context + (optional) voice hint, returns a single draftBody + whyItWorks + confidence. Does not gate, does not validate, does not persist — pure transformation. Caller (community-manager / engagement worker) handles judging-opportunity, validating-draft, and draft_reply persistence.
context: fork
model: claude-sonnet-4-6
maxTurns: 1
allowed-tools: []
references:
  - x-reply-voice
  - reddit-reply-voice
---

You are ShipFlare's reply drafter. Given one thread and the product
context, write ONE reply body for the founder to review. You do NOT
decide whether the thread deserves a reply (the caller already
decided), you do NOT validate slop or length (the validating-draft
skill does that next), and you do NOT persist (the caller does that
after validation passes).

Your output is a single JSON object. Start with `{` end with `}`. No
markdown fences.

## Inputs

A JSON payload with:
- `thread` — the post you are replying to (title, body, author, platform, community)
- `product` — `name`, `description`, optional `valueProp`
- `channel` — `'x'` or `'reddit'`
- `voice` — optional voice cluster or free-form hint
- `founderVoiceBlock` — optional verbatim founder voice anchor text
- `canMentionProduct` — boolean from `judging-opportunity`; only mention the product when true AND the thread is asking for the kind of tool the product is

## Per-channel rules

Apply the relevant reference:
- `channel: 'x'` → consult `x-reply-voice`
- `channel: 'reddit'` → consult `reddit-reply-voice`

Both channels share these floor rules:
- First-person specific from your own run beats abstract pronouncement. Every generalized claim must carry an `I/we + concrete` anchor. If you can't, ask one short specific question instead.
- No banned preamble openers ("Great post", "This!", "Absolutely", "As a founder…")
- No banned vocabulary (`leverage`, `delve`, `utilize`, `robust`, `crucial`, `pivotal`, `demystify`, `landscape`, `ecosystem`, `journey`, `seamless`, `navigate`, `compelling`)
- No "the real X is Y" / "X isn't 1, it's 2" / "winners do X" / "most founders Y" pronouncements without a first-person receipt — these are sermon energy from accounts that haven't earned it
- No fortune-cookie closer (`that's the moat / game / trick / tax / cost / truth`)
- No colon-aphorism opener (`the real X:` / `the cruel part:` / `the insight:`)

## Output

```json
{
  "draftBody": "the reply text — single tweet ≤ 240 chars on X, single paragraph 150–600 chars on Reddit",
  "whyItWorks": "one sentence justifying the angle / anchor / voice you chose",
  "confidence": 0.0
}
```

`confidence` is your honest read on the draft, 0.0–1.0. Use 0.4 or lower when you had to reach for an anchor and aren't sure it'll land — the validating-draft skill will catch the rest, but flagging weak drafts up front shortens the founder's review queue.
````

- [ ] **Step 2: Verify file exists**

Run: `head -10 src/skills/drafting-reply/SKILL.md`

- [ ] **Step 3: Commit**

```bash
git add src/skills/drafting-reply/SKILL.md
git commit -m "feat(drafting-reply): add SKILL.md with channel-aware drafting prompt"
```

### Task C3: Create x-reply-voice reference

**Files:**
- Create: `src/skills/drafting-reply/references/x-reply-voice.md`
- Reference: `src/tools/AgentTool/agents/community-manager/references/reply-quality-bar.md` (lines 226–246, the X voice block)

- [ ] **Step 1: Extract X voice rules from existing reply-quality-bar**

Read the current `community-manager/references/reply-quality-bar.md`:

```bash
sed -n '226,246p' src/tools/AgentTool/agents/community-manager/references/reply-quality-bar.md
```

- [ ] **Step 2: Create x-reply-voice.md**

Create `src/skills/drafting-reply/references/x-reply-voice.md`:

```markdown
# X reply voice

Chat register. Lowercase opening and missing end period are fine and
often preferred. Sentence fragments are fine ("hard disagree." is a
complete reply).

## Length cap

Hard cap 240 chars. Target band 40–140 chars (≈ 7–28 words). Stretch
to 180 only when you carry a personal anchor (`I/we` + specific).
180–240 requires explicit personal anchor justified in `whyItWorks`.

If your reply has a second sentence, it must be SHORTER than the
first — otherwise cut it. Never multi-paragraph. Never line breaks
inside a single X reply.

## Anchor token (required)

Every non-skip reply MUST contain at least one of:
- Number: a count, percentage, dollar amount, or duration
  (`14 months`, `$10k MRR`, `20% lift`, `2am`)
- Proper noun / brand-like token (`postgres`, `Stripe`, `Vercel`)
- Timestamp phrase (`last week`, `month 8`, `yesterday`)

Sentence-initial capitalized words don't count — every sentence
starts with one. The anchor must be earned mid-sentence.

## Personal anchor (when claiming generality)

If your draft makes a generalized claim (`the real cost is X`,
`winners do Y`, `most founders Z`), the anchor MUST be a
first-person specific from the writer's own run. Required form:
`I/we + specific number/year/tool/event`.

Examples:
- `we tried Stripe Tax for 14 days, broke at one edge case`
- `our first churn was at month 8`
- `shipped revenue analytics yesterday — first user spotted a $1,247 leak in 4 minutes`

If you can't bring a first-person receipt: ask one short specific
question instead, OR skip (return empty draftBody).

## Format

- First person, present tense
- No exclamation points
- No emoji by default (≤ 1 only if it replaces a word)
- Zero hashtags in replies
- Zero links in X reply body
- No sibling-platform names (`reddit`, `r/`, `subreddit`, `karma`) without a contrast marker (`unlike`, `vs`, `instead of`)

## Voice cluster defaults (when caller passes a hint)

- `terse_shipper` — minimal text, screenshots and numbers carry. lowercase OK.
- `vulnerable_philosopher` — reflective single sentences, sentence-level craft.
- `daily_vlogger` — energetic, "Day N" cadence, milestone emoji at peaks.
- `patient_grinder` — sparse, grateful, milestone-only.
- `contrarian_analyst` — hot takes on the meta with specific receipts. Earn the contrarian pose with a number from your own run.

When no hint is passed, default to the voice that fits the thread — typically `vulnerable_philosopher` for reflective threads, `terse_shipper` for screenshots/numbers.
```

- [ ] **Step 3: Commit**

```bash
git add src/skills/drafting-reply/references/x-reply-voice.md
git commit -m "docs(drafting-reply): add x-reply-voice reference"
```

### Task C4: Create reddit-reply-voice reference

**Files:**
- Create: `src/skills/drafting-reply/references/reddit-reply-voice.md`
- Reference: `src/tools/AgentTool/agents/community-manager/references/reply-quality-bar.md` (lines 248–262, Reddit voice block)

- [ ] **Step 1: Create reddit-reply-voice.md**

Create `src/skills/drafting-reply/references/reddit-reply-voice.md`:

```markdown
# Reddit reply voice

Subreddit register. Reads like a comment thread, not a LinkedIn post.

## Length

Aim for one paragraph; 150–800 chars ideal. Markdown paragraph breaks
are welcome for anything over 2 sentences. Hard ceiling 10,000.

## Open with the specific thing

Open with the specific thing you're responding to, not a greeting.
Name your experience in concrete terms (`we tried X for 6 months`,
not `in our experience`).

## Answer the question, then optionally add the one useful caveat

Not three "it depends" disclaimers. If the OP asked for a
recommendation, give one. If you don't have one, ask the
clarifying question that would let you give one.

## Hard rules

- No `Edit:` or `EDIT:` prefixes (you're drafting fresh)
- No `Happy to help!` close
- No DM-me invitation unless the thread explicitly invited it
- No hashtags
- No sibling-platform names (`twitter`, `x.com`, `tweet`, `RT @`) without a contrast marker
- Same banned vocabulary as X — `leverage`, `delve`, etc.
- Same anchor rule — every generalized claim needs a first-person specific
```

- [ ] **Step 2: Commit**

```bash
git add src/skills/drafting-reply/references/reddit-reply-voice.md
git commit -m "docs(drafting-reply): add reddit-reply-voice reference"
```

### Task C5: Per-skill loader smoke test

**Files:**
- Modify: `src/skills/drafting-reply/__tests__/drafting-reply.test.ts`

- [ ] **Step 1: Add a loadSkill smoke test**

Append to `src/skills/drafting-reply/__tests__/drafting-reply.test.ts`:

```typescript
import * as path from 'node:path';
import { loadSkill } from '@/tools/SkillTool/loadSkillsDir';

const SKILL_DIR = path.resolve(__dirname, '..');

describe('drafting-reply skill loader', () => {
  it('loads from disk with the correct frontmatter', async () => {
    const skill = await loadSkill(SKILL_DIR);
    expect(skill).not.toBeNull();
    expect(skill!.name).toBe('drafting-reply');
    expect(skill!.context).toBe('fork');
    expect(skill!.allowedTools).toEqual([]);
  });

  it('references both channel voice files', async () => {
    const skill = await loadSkill(SKILL_DIR);
    const fakeCtx = { abortSignal: new AbortController().signal, get: () => null } as never;
    const body = await skill!.getPromptForCommand(JSON.stringify({}), fakeCtx);
    expect(body).toContain('x-reply-voice');
    expect(body).toContain('reddit-reply-voice');
  });
});
```

- [ ] **Step 2: Run test**

Run: `pnpm vitest run src/skills/drafting-reply`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/skills/drafting-reply/__tests__/drafting-reply.test.ts
git commit -m "test(drafting-reply): add loader smoke test"
```

### Task C6: Update community-manager AGENT.md to call drafting-reply

**Files:**
- Modify: `src/tools/AgentTool/agents/community-manager/AGENT.md`

- [ ] **Step 1: Read current AGENT.md** (235 lines)

Run: `cat src/tools/AgentTool/agents/community-manager/AGENT.md`

- [ ] **Step 2: Replace the body**

Replace the entire body of `src/tools/AgentTool/agents/community-manager/AGENT.md` with the thinned version below. Frontmatter stays largely intact except for the `tools:` list which gains `skill`.

```markdown
---
name: community-manager
description: Drafts replies from the already-discovered threads inbox. Reads the `threads` table via `find_threads`, runs each thread through the three-gate pre-draft test, then orchestrates the per-thread skill chain (drafting-reply → validating-draft → draft_reply) until targetCount drafts have been persisted. USE when a reply-sweep team_run fires, when the coordinator passes a specific threadId, or AFTER discovery-agent has populated fresh rows. DO NOT USE to find brand-new posts (use discovery-agent first), DO NOT USE for original posts (post-writer handles those).
model: claude-haiku-4-5-20251001
maxTurns: 12
tools:
  - find_threads
  - skill
  - validate_draft
  - draft_reply
  - SendMessage
  - StructuredOutput
shared-references:
  - base-guidelines
references:
  - reply-gates
---

# Community Manager for {productName}

You orchestrate the reply pipeline. You do NOT write reply bodies
yourself — `drafting-reply` does. You do NOT judge slop yourself —
`validating-draft` does. Your only judgments are:

1. Three-gate pre-draft test (per `reply-gates`)
2. Per-thread orchestration (call drafting-reply → validating-draft → draft_reply or skip)
3. Sweep termination (stop when targetCount reached, or escalate via SendMessage)

## Input shapes

### Daily reply slot (most common)

```
Reply slot:
- planItemId: <uuid>
- channel: <x|reddit>
- targetCount: <int>

Threads (from run_discovery_scan):
- <id, url, body excerpt, confidence>
```

### Ad-hoc reply

```
threadId: <uuid>
context: <optional notes>
```

### Fallback open scan (rare; coordinator's daily playbook lands here when no slot exists)

No `planItemId`, no `threadId`. Call `find_threads` once per connected platform; default `targetCount=3`.

## Per-thread workflow

For each thread:

1. **Three-gate test** (consult `reply-gates`). One miss → skip; record reason.
2. **Drafting**:
   ```
   skill('drafting-reply', {
     thread: {...},
     product: {...},
     channel: '<x|reddit>',
     voice: <hint or omitted>,
     canMentionProduct: <from gate test>,
   })
   ```
   Returns `{ draftBody, whyItWorks, confidence }`.
3. **Validating**:
   ```
   validate_draft({ text: draftBody, platform, kind: 'reply' })
   ```
   This is the mechanical pre-filter (length, sibling-platform leak, hashtag, hallucinated-stats regex). If it fails, treat as a hard reject — drafting-reply produced something the platform will refuse.
4. **Skill validation** (full slop check):
   ```
   skill('validating-draft', { drafts: [{ replyBody, threadTitle, threadBody, subreddit, productName, productDescription, confidence, whyItWorks }], memoryContext: '' })
   ```
   Returns `{ verdict, score, slopFingerprint, ... }`.
5. **Decide**:
   - `verdict: 'PASS'` → call `draft_reply({ threadId, draftBody, confidence, whyItWorks, planItemId? })`.
   - `verdict: 'REVISE'` → call drafting-reply ONCE more with the slop issues fed in as `voice` hint additions, then validating-draft once more. If still REVISE, persist with `whyItWorks` flagged "needs human review: <slopFingerprint>". If FAIL, skip.
   - `verdict: 'FAIL'` → skip; record `slopFingerprint` in your sweep notes.

## Sweep termination

- Daily slot: stop when `draftsCreated == targetCount`. Don't over-shoot.
- Ad-hoc: one thread, then StructuredOutput.
- Open scan: cap at `targetCount=3`.

## Hard rules

- NEVER persist a draft that scored FAIL on validating-draft. Skip it.
- NEVER call `find_threads` in slot mode — coordinator owns discovery.
- NEVER write reply bodies inline in your own LLM turn — always go through drafting-reply.
- NEVER pitch the product unless the gate test set `canMentionProduct: true`.

## Output

```ts
StructuredOutput({
  status: 'completed' | 'partial' | 'failed',
  threadsScanned: number,
  draftsCreated: number,
  draftsSkipped: number,
  skippedRationale: string,  // one line per gate-failure or slop-failure category
  notes: string,
})
```
```

- [ ] **Step 3: Commit**

```bash
git add src/tools/AgentTool/agents/community-manager/AGENT.md
git commit -m "refactor(community-manager): thin to orchestration only — call drafting-reply + validating-draft"
```

### Task C7: Cut reply-quality-bar.md to gates only, rename to reply-gates.md

**Files:**
- Rename + rewrite: `src/tools/AgentTool/agents/community-manager/references/reply-quality-bar.md` → `reply-gates.md`
- Delete: `src/tools/AgentTool/agents/community-manager/references/engagement-playbook.md` (its tone content moved to skill)

- [ ] **Step 1: Move the file**

```bash
git mv src/tools/AgentTool/agents/community-manager/references/reply-quality-bar.md src/tools/AgentTool/agents/community-manager/references/reply-gates.md
```

- [ ] **Step 2: Replace contents with gate-only content**

Replace `src/tools/AgentTool/agents/community-manager/references/reply-gates.md` with:

```markdown
# Reply gates (pre-draft three-gate test)

A thread must pass ALL THREE gates to earn a reply draft. One miss → skip.

## Gate 1 — Is this author a potential user?

Pass signals:
- Asking for help with a problem the product solves
- Describing frustration with the status quo the product improves on
- Seeking tool / service recommendations in the product's domain
- Actively stuck on the workflow the product streamlines

Skip signals:
- Competitor promoting their own tool (common on X replies)
- Job seekers / recruiters posting
- Advice-givers teaching others (they don't need the product)
- Meta-commentary ("hot take:" threads, "AI is dead" essays)
- Personal / off-topic posts that happen to use a keyword

## Gate 2 — Can you add something specific?

Every non-skip reply needs at least one anchor (number, brand-like
token, timestamp, or URL). If you can't name one without making it
up, you're writing wallpaper — skip and record "no specific
addition available".

## Gate 3 — Is the reply window still open?

- **X:** ideal 15 min, max 4–6 hours from original post
- **Reddit:** up to ~24 hours, only if comment count < 30

If the window passed → skip.

## canMentionProduct

Returns true ONLY when:
- The OP is asking for a tool the product is, OR
- Debugging a problem the product solves, OR
- Complaining about a direct competitor, OR
- Asking for a case study, OR
- Inviting feedback on the kind of thing the product does

Hard mute on milestone posts, vulnerable / grief content, political
takes, and "no fit" cases. When in doubt, suppress.

## Output

The agent's per-thread workflow uses these gates to set up the
`drafting-reply` call. The body / voice / anchor / length rules
live in the `drafting-reply` skill's references — do NOT repeat
them here.
```

- [ ] **Step 3: Delete the engagement-playbook.md (rules now in drafting-reply skill)**

```bash
git rm src/tools/AgentTool/agents/community-manager/references/engagement-playbook.md
```

- [ ] **Step 4: Update opportunity-judgment.md or move/rename**

Run: `head -20 src/tools/AgentTool/agents/community-manager/references/opportunity-judgment.md`

If the contents only describe `canMentionProduct` rules (already covered in `reply-gates.md`), delete the file. If it has unique content not yet captured, leave it for Phase E (Step 4 — judging-opportunity skill extraction).

- [ ] **Step 5: Update the AGENT.md frontmatter `references:` list**

In `src/tools/AgentTool/agents/community-manager/AGENT.md`, the `references:` list should now read:

```yaml
references:
  - reply-gates
```

If `opportunity-judgment` was kept, also include it.

- [ ] **Step 6: Run tests**

Run: `pnpm vitest run`
Expected: all tests still pass. The agent loader smoke test should now load the trimmed AGENT.md.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "refactor(community-manager): cut quality-bar to gates only; voice rules now in drafting-reply skill"
```

### Task C8: Add a smoke test for the new community-manager → drafting-reply call chain

**Files:**
- Create or modify: `src/tools/AgentTool/agents/community-manager/__tests__/drafting-skill-call.test.ts`

- [ ] **Step 1: Write a test that loads the agent and verifies its tool list**

Create `src/tools/AgentTool/agents/community-manager/__tests__/drafting-skill-call.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { parse as parseYaml } from 'yaml';

const AGENT_DIR = path.resolve(__dirname, '..');

async function readFrontmatter() {
  const content = await fs.readFile(path.join(AGENT_DIR, 'AGENT.md'), 'utf-8');
  const m = content.match(/^---\n([\s\S]*?)\n---/);
  if (!m) throw new Error('no frontmatter found');
  return parseYaml(m[1]) as { tools?: string[]; references?: string[] };
}

describe('community-manager AGENT.md', () => {
  it('declares the skill tool so it can call drafting-reply / validating-draft', async () => {
    const fm = await readFrontmatter();
    expect(fm.tools).toContain('skill');
  });

  it('drops voice / slop reference docs (now in skills)', async () => {
    const refs = (await readFrontmatter()).references ?? [];
    expect(refs).not.toContain('engagement-playbook');
    expect(refs).not.toContain('reply-quality-bar');
  });

  it('keeps reply-gates as a reference', async () => {
    const refs = (await readFrontmatter()).references ?? [];
    expect(refs).toContain('reply-gates');
  });
});
```

- [ ] **Step 2: Run test**

Run: `pnpm vitest run src/tools/AgentTool/agents/community-manager`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/tools/AgentTool/agents/community-manager/__tests__/drafting-skill-call.test.ts
git commit -m "test(community-manager): assert agent calls drafting-reply via skill tool"
```

### Task C9: Live sweep verification

**Files:**
- Manual verification (no commits unless distribution shifts adversely)

- [ ] **Step 1: Trigger a reply sweep against staging or a test user**

Use the existing trigger path (cron or manual `team-run` enqueue) to fire one community-manager sweep. Inspect the resulting drafts:

```bash
psql 'postgresql://...' -c "
  SELECT d.id, d.review_verdict, d.review_score, d.review_json -> 'slopFingerprint' AS slop, LEFT(d.reply_body, 120) AS body
  FROM drafts d
  WHERE d.created_at > now() - interval '15 minutes'
  ORDER BY d.created_at DESC
"
```

- [ ] **Step 2: Compare distribution**

Drafts created post-Phase-C should:
- Contain at least one first-person token (`I`, `we`, `my`, `our`) in ≥ 70% of bodies
- Show empty `slopFingerprint` arrays in ≥ 60% of cases (validating-draft passes)
- NOT contain `the cruel part:` / `the insight:` / `that's the moat` style closings

If the distribution regresses (more slop than pre-Phase-A baseline), do NOT proceed — iterate on the `drafting-reply` references and re-run.

- [ ] **Step 3: Tag the verification milestone**

```bash
git tag phase-c-reply-pipeline-thinned
```

**Phase C verification gate:** A live sweep produces drafts with first-person tokens in majority and empty `slopFingerprint` for the majority. Tests are green. Community-manager AGENT.md is ≤ 80 lines.

---

## Phase D — Step 4: Extract `judging-opportunity` skill

Moves the gate 1/2/3 + canMentionProduct decision out of `community-manager`'s inline reading of `reply-gates.md` and into a dedicated fork-mode skill. Lets the agent loop turn budget collapse to "for each thread → call judge skill → if pass, run draft pipeline".

### Task D1: Define `judging-opportunity` schema (TDD)

**Files:**
- Create: `src/skills/judging-opportunity/schema.ts`
- Create: `src/skills/judging-opportunity/__tests__/judging-opportunity.test.ts`

- [ ] **Step 1: Add a schema test**

Create `src/skills/judging-opportunity/__tests__/judging-opportunity.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { judgingOpportunityInputSchema, judgingOpportunityOutputSchema } from '../schema';

describe('judging-opportunity schema', () => {
  it('accepts a thread + product + platform input', () => {
    expect(() =>
      judgingOpportunityInputSchema.parse({
        thread: { title: 't', body: 'b', author: 'a', platform: 'x', community: 'x', upvotes: 0, commentCount: 0, postedAt: new Date().toISOString() },
        product: { name: 'p', description: 'd' },
        platform: 'x',
      }),
    ).not.toThrow();
  });

  it('output names which gate failed when pass=false', () => {
    const parsed = judgingOpportunityOutputSchema.parse({
      pass: false,
      gateFailed: 1,
      canMentionProduct: false,
      signal: 'competitor',
      rationale: 'OP is shilling their own tool',
    });
    expect(parsed.gateFailed).toBe(1);
  });
});
```

- [ ] **Step 2: Run, expect failure (no schema yet)**

Run: `pnpm vitest run src/skills/judging-opportunity`

- [ ] **Step 3: Create schema.ts**

Create `src/skills/judging-opportunity/schema.ts`:

```typescript
import { z } from 'zod';

export const judgingOpportunityInputSchema = z.object({
  thread: z.object({
    title: z.string(),
    body: z.string().default(''),
    author: z.string(),
    platform: z.enum(['x', 'reddit']),
    community: z.string(),
    upvotes: z.number().int().nonnegative().default(0),
    commentCount: z.number().int().nonnegative().default(0),
    postedAt: z.string(),  // ISO timestamp
  }),
  product: z.object({
    name: z.string(),
    description: z.string(),
    valueProp: z.string().optional(),
  }),
  platform: z.enum(['x', 'reddit']),
});

export type JudgingOpportunityInput = z.infer<typeof judgingOpportunityInputSchema>;

export const judgingOpportunityOutputSchema = z.object({
  pass: z.boolean(),
  gateFailed: z.union([z.literal(1), z.literal(2), z.literal(3)]).optional(),
  canMentionProduct: z.boolean(),
  signal: z.string().max(120),  // short tag e.g. 'help_request', 'competitor', 'milestone'
  rationale: z.string().max(500),
});

export type JudgingOpportunityOutput = z.infer<typeof judgingOpportunityOutputSchema>;
```

- [ ] **Step 4: Test passes**

Run: `pnpm vitest run src/skills/judging-opportunity`

- [ ] **Step 5: Commit**

```bash
git add src/skills/judging-opportunity
git commit -m "feat(judging-opportunity): schema + first test"
```

### Task D2: Create the SKILL.md and references

**Files:**
- Create: `src/skills/judging-opportunity/SKILL.md`
- Create: `src/skills/judging-opportunity/references/gate-rules.md`

- [ ] **Step 1: Create SKILL.md**

Create `src/skills/judging-opportunity/SKILL.md`:

````markdown
---
name: judging-opportunity
description: Decide whether a single thread earns a reply draft. Runs the three-gate test (potential user / specific addition / open window) plus the canMentionProduct decision. Returns a structured pass/fail with the failed gate ID and a one-line rationale. Pure transformation — does not draft, does not persist.
context: fork
model: claude-haiku-4-5-20251001
maxTurns: 1
allowed-tools: []
references:
  - gate-rules
---

You judge whether a thread is worth a reply draft. You return a JSON
verdict — you do NOT write the reply.

Apply every rule in `gate-rules`. The output must always populate:

- `pass: boolean` — true only when ALL three gates pass
- `gateFailed: 1 | 2 | 3 | undefined` — name the FIRST gate that failed; undefined when pass=true
- `canMentionProduct: boolean` — true ONLY when the thread asks for the kind of tool the product is, debugs a problem the product solves, complains about a direct competitor, asks for a case study, or invites feedback in the product's domain. Hard mute on milestone / vulnerable / grief / political content.
- `signal: string` — short tag for the dominant pattern (`help_request`, `competitor_shilling`, `advice_giver`, `milestone`, `vulnerable`, `feedback_invite`, etc.)
- `rationale: string` — one-sentence justification

## Output

Single JSON object. No markdown fences. Start `{`, end `}`.

```json
{
  "pass": true,
  "canMentionProduct": false,
  "signal": "help_request",
  "rationale": "OP is asking for monitoring tool recommendations and we're in that domain"
}
```

When `pass: false` include `gateFailed`:

```json
{
  "pass": false,
  "gateFailed": 1,
  "canMentionProduct": false,
  "signal": "competitor_shilling",
  "rationale": "OP is promoting their own tool that competes with the product"
}
```
````

- [ ] **Step 2: Create gate-rules.md by moving content from reply-gates.md**

Create `src/skills/judging-opportunity/references/gate-rules.md` containing the same gate descriptions as the trimmed `reply-gates.md` from Task C7. The two files have the same content but live in different homes — `reply-gates.md` is the historical reference for the agent's overall flow, `gate-rules.md` is the skill's authoritative decision document.

(Copy the full `reply-gates.md` content from Task C7 into this new file.)

- [ ] **Step 3: Add a loadSkill smoke test**

Mirror Task C5's pattern: assert the skill loads, frontmatter has `name: judging-opportunity`, `context: fork`, no allowed tools.

- [ ] **Step 4: Commit**

```bash
git add src/skills/judging-opportunity
git commit -m "feat(judging-opportunity): SKILL.md + gate-rules reference + loader test"
```

### Task D3: Update community-manager to call judging-opportunity

**Files:**
- Modify: `src/tools/AgentTool/agents/community-manager/AGENT.md`

- [ ] **Step 1: Replace the "Three-gate test" step in the per-thread workflow**

In `community-manager/AGENT.md`, change the per-thread workflow step 1 from:

```
1. **Three-gate test** (consult `reply-gates`). One miss → skip; record reason.
```

to:

```
1. **Judge the thread**:
   ```
   skill('judging-opportunity', { thread: {...}, product: {...}, platform: '<x|reddit>' })
   ```
   Returns `{ pass, gateFailed?, canMentionProduct, signal, rationale }`. If `pass: false`, skip and record `signal` + `gateFailed`. If `pass: true`, continue to step 2 with `canMentionProduct` carried into the drafting call.
```

Also update the `references:` list — `reply-gates` can be deleted (now lives in the skill):

```yaml
references: []
```

(Or keep `reply-gates.md` as a documentation pointer with one line: "see `src/skills/judging-opportunity/references/gate-rules.md`".)

- [ ] **Step 2: Update test**

In `src/tools/AgentTool/agents/community-manager/__tests__/drafting-skill-call.test.ts`, the assertion for `references` may need adjustment (now that gate logic moved out of agent's references list). Update the assertion accordingly.

- [ ] **Step 3: Run tests**

Run: `pnpm vitest run`

- [ ] **Step 4: Commit**

```bash
git add src/tools/AgentTool/agents/community-manager
git commit -m "refactor(community-manager): call judging-opportunity skill instead of inline gate test"
```

### Task D4: Live verification — gate-pass-rate distribution

**Files:**
- Manual verification

- [ ] **Step 1: Run a sweep, capture skip-rationale distribution**

Run a daily-slot sweep. In the StructuredOutput summary, note:

```
threadsScanned: N
draftsCreated: M
draftsSkipped: N - M
skippedRationale: { gate1: X, gate2: Y, gate3: Z, slop: W }
```

- [ ] **Step 2: Compare against pre-Phase-D distribution**

Pull the same metrics from a sweep performed at the end of Phase C. Per-gate skip rates should be within ±10% of Phase C.

If a gate over-fires (e.g. Gate 2 jumps from 30% to 60%), the skill is being too strict — iterate on `gate-rules.md`.

**Phase D verification gate:** Skip-rate distribution per gate within ±10% of Phase C; community-manager AGENT.md is ≤ 60 lines (the original 235-line target).

---

## Phase E — Step 3: Extract `drafting-post` skill, decide `post-writer` fate

Same shape as Phase C but for original posts. The decision point: keep a thin (~50 line) `post-writer` agent for the orchestration loop, OR delete it and let `coordinator` / `content-planner` call `drafting-post` directly. Default: keep the thin agent. Revisit if call-site review in Phase H shows it's redundant.

### Task E1: Define `drafting-post` schema (TDD)

**Files:**
- Create: `src/skills/drafting-post/schema.ts`
- Create: `src/skills/drafting-post/__tests__/drafting-post.test.ts`

- [ ] **Step 1: Add schema test**

Create `src/skills/drafting-post/__tests__/drafting-post.test.ts` mirroring Task C1's pattern. Test that:
- Input shape requires `planItem`, `product`, `channel`, optional `voice` / `phase` / `params` (for content-planner v2 inputs like `pillar`, `theme`, `metaphor_ban`, `cross_refs`).
- Output shape: `{ draftBody, whyItWorks, confidence }` matching `drafting-reply`.

- [ ] **Step 2: Run, expect failure**

Run: `pnpm vitest run src/skills/drafting-post`

- [ ] **Step 3: Create schema.ts**

Create `src/skills/drafting-post/schema.ts`:

```typescript
import { z } from 'zod';

const channelEnum = z.enum(['x', 'reddit']);
const phaseEnum = z.enum(['foundation', 'audience', 'momentum', 'launch', 'compound', 'steady']);
const voiceCluster = z.enum([
  'terse_shipper',
  'vulnerable_philosopher',
  'daily_vlogger',
  'patient_grinder',
  'contrarian_analyst',
]);

export const draftingPostInputSchema = z.object({
  planItem: z.object({
    id: z.string(),
    title: z.string(),
    description: z.string().optional().default(''),
    channel: channelEnum,
    scheduledAt: z.string().optional(),
    params: z.record(z.unknown()).optional().default({}),
  }),
  product: z.object({
    name: z.string(),
    description: z.string(),
    valueProp: z.string().optional(),
  }),
  channel: channelEnum,
  phase: phaseEnum.default('foundation'),
  voice: z.union([voiceCluster, z.string()]).optional(),
  founderVoiceBlock: z.string().optional(),
  targetSubreddit: z.string().optional(),
});

export type DraftingPostInput = z.infer<typeof draftingPostInputSchema>;

export const draftingPostOutputSchema = z.object({
  draftBody: z.string().min(1),
  whyItWorks: z.string().max(800),
  confidence: z.number().min(0).max(1),
});

export type DraftingPostOutput = z.infer<typeof draftingPostOutputSchema>;
```

- [ ] **Step 4: Test passes**

Run: `pnpm vitest run src/skills/drafting-post`

- [ ] **Step 5: Commit**

```bash
git add src/skills/drafting-post
git commit -m "feat(drafting-post): schema + first test"
```

### Task E2: Create SKILL.md

**Files:**
- Create: `src/skills/drafting-post/SKILL.md`

- [ ] **Step 1: Write the SKILL.md**

Create `src/skills/drafting-post/SKILL.md`. Mirror `drafting-reply`'s SKILL.md structure. Frontmatter:

```yaml
---
name: drafting-post
description: Draft ONE original post for a single plan_item. Receives the plan_item + product + phase + (optional) voice / pillar / theme inputs, returns a single draftBody + whyItWorks + confidence. Does not validate, does not persist — pure transformation. Caller (post-writer agent or content-planner) handles validating-draft and draft_post persistence.
context: fork
model: claude-sonnet-4-6
maxTurns: 1
allowed-tools: []
references:
  - x-post-voice
  - reddit-post-voice
  - content-safety
---
```

Body should explicitly route by `channel` and call out:
- For X: ONE single tweet ≤ 280 weighted chars; per-phase playbook; voice cluster defaults
- For Reddit: 150–600 words single paragraph or with markdown breaks
- The same generalized-claim → first-person-receipt rule from `drafting-reply`

- [ ] **Step 2: Commit**

```bash
git add src/skills/drafting-post/SKILL.md
git commit -m "feat(drafting-post): add SKILL.md routing by channel"
```

### Task E3: Migrate references from post-writer

**Files:**
- Move: `src/tools/AgentTool/agents/post-writer/references/x-content-guide.md` → `src/skills/drafting-post/references/x-post-voice.md`
- Move: `src/tools/AgentTool/agents/post-writer/references/reddit-content-guide.md` → `src/skills/drafting-post/references/reddit-post-voice.md`
- Move: `src/tools/AgentTool/agents/post-writer/references/content-safety.md` → `src/skills/drafting-post/references/content-safety.md`

- [ ] **Step 1: Move the files**

```bash
git mv src/tools/AgentTool/agents/post-writer/references/x-content-guide.md \
       src/skills/drafting-post/references/x-post-voice.md
git mv src/tools/AgentTool/agents/post-writer/references/reddit-content-guide.md \
       src/skills/drafting-post/references/reddit-post-voice.md
git mv src/tools/AgentTool/agents/post-writer/references/content-safety.md \
       src/skills/drafting-post/references/content-safety.md
```

- [ ] **Step 2: Verify no other code referenced the old paths**

Run: `grep -rn "x-content-guide\|reddit-content-guide" src --include="*.ts" --include="*.md"`
Update each match to point to the new location.

- [ ] **Step 3: Add loader smoke test**

Add `src/skills/drafting-post/__tests__/loader.test.ts` mirroring Task C5.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "refactor(drafting-post): migrate voice references from post-writer"
```

### Task E4: Decide `post-writer` fate

**Files:**
- Modify or remove: `src/tools/AgentTool/agents/post-writer/`

The decision point: thin agent vs delete agent.

**Decision rule:**
- If callers spawn `post-writer` from multiple sites (`coordinator`, `content-planner`, manual user-trigger) → keep the thin agent (~50 lines) so the retry-on-REVISE orchestration logic has one home.
- If only one caller spawns it → delete the agent and inline the orchestration in that caller.

- [ ] **Step 1: Find all callers**

Run: `grep -rn "post-writer" src --include="*.ts" | grep -v "__tests__\|/post-writer/"`
Expected: 1–3 callers.

- [ ] **Step 2: If multiple callers, thin the agent**

Replace `src/tools/AgentTool/agents/post-writer/AGENT.md` with the thinned ~50-line version that:
- declares `tools: [skill, validate_draft, draft_post, query_plan_items, query_product_context, StructuredOutput]`
- has frontmatter pointing only to one new reference, `post-orchestration.md` (a tiny doc explaining the retry loop)
- the body is just: load plan_item + product → call `drafting-post` skill → `validate_draft` (mechanical) → `validating-draft` skill → on REVISE retry once → call `draft_post`.

- [ ] **Step 3: If single caller, delete the agent**

```bash
git rm -rf src/tools/AgentTool/agents/post-writer
```

Then update the single caller to inline the same orchestration.

- [ ] **Step 4: Run tests**

Run: `pnpm vitest run`

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "refactor(post-writer): thin agent (or delete) per call-site count; drafting moves to drafting-post skill"
```

### Task E5: Live post draft verification

- [ ] **Step 1: Trigger an original-post sweep**

Run a content-planner cycle that produces post drafts. Inspect:

```sql
SELECT pi.title, d.review_verdict, d.review_score, LEFT(d.reply_body, 180) AS body
FROM plan_items pi LEFT JOIN drafts d ON d.plan_item_id = pi.id
WHERE pi.kind = 'content_post' AND pi.created_at > now() - interval '15 minutes'
ORDER BY pi.created_at DESC;
```

- [ ] **Step 2: Verify quality**

Same standards as Phase C: first-person tokens present, slopFingerprint mostly empty, no phase-banned patterns.

**Phase E verification gate:** Post drafts pass validating-draft at the same rate as reply drafts post-Phase-C; tests green.

---

## Phase F — Step 5: Convert `growth-strategist` agent to `generating-strategy` skill

Cleanest single-transformation case. The 78-line agent prompt becomes the skill's reference document.

### Task F1: Create the skill

**Files:**
- Create: `src/skills/generating-strategy/SKILL.md`
- Create: `src/skills/generating-strategy/schema.ts`
- Create: `src/skills/generating-strategy/__tests__/generating-strategy.test.ts`
- Reference: `src/tools/AgentTool/agents/growth-strategist/AGENT.md`

- [ ] **Step 1: Read the existing agent body**

Run: `cat src/tools/AgentTool/agents/growth-strategist/AGENT.md`

- [ ] **Step 2: Create schema.ts**

Output should match what the agent currently produces (a strategic-path JSON shape). Read `src/lib/db/schema/strategic-paths.ts` for the canonical schema:

```bash
cat src/lib/db/schema/strategic-paths.ts
```

Write `src/skills/generating-strategy/schema.ts` matching that table's row shape (thesis, milestones, content pillars, channel mix, phase goals).

- [ ] **Step 3: Write SKILL.md**

Frontmatter:

```yaml
---
name: generating-strategy
description: Design the 30-day strategic narrative arc for a product — thesis, milestones, weekly themes, content pillars, channel mix, phase goals. USE when a product onboards, when phase changes (mvp → launching → launched), or when recent milestones suggest the thesis needs rewriting. DO NOT USE for single-week tactical scheduling — content-planner handles that.
context: fork
model: claude-sonnet-4-6
maxTurns: 2
allowed-tools:
  - query_product_context
  - query_recent_milestones
  - StructuredOutput
references: []
---
```

Body: copy the verbatim content of the current `growth-strategist/AGENT.md` from line 25 to end into the SKILL.md body.

- [ ] **Step 4: Add per-skill loader test**

Mirror Task C5.

- [ ] **Step 5: Run tests**

Run: `pnpm vitest run src/skills/generating-strategy`

- [ ] **Step 6: Commit**

```bash
git add src/skills/generating-strategy
git commit -m "feat(generating-strategy): new skill replaces growth-strategist agent"
```

### Task F2: Update callers and delete agent

**Files:**
- Find and update each caller
- Remove: `src/tools/AgentTool/agents/growth-strategist/`

- [ ] **Step 1: Find every caller**

Run: `grep -rn "growth-strategist" src --include="*.ts" --include="*.md" | grep -v "/growth-strategist/\|__tests__"`
Each match is a Task() spawn or a coordinator routing rule that must be updated.

- [ ] **Step 2: Replace each Task() spawn with a `runForkSkill('generating-strategy', ...)` call**

For each match, swap from:

```typescript
await Task({ subagent_type: 'growth-strategist', prompt: '...' });
```

to:

```typescript
const { result } = await runForkSkill('generating-strategy', argsJson, generatingStrategyOutputSchema);
```

(Adjust based on the caller's actual shape — if the caller is itself a worker, follow the `review.ts` pattern.)

- [ ] **Step 3: Delete the agent**

```bash
git rm -rf src/tools/AgentTool/agents/growth-strategist
```

- [ ] **Step 4: Update CLAUDE.md and any other docs that reference `growth-strategist`**

Run: `grep -rn "growth-strategist" docs CLAUDE.md README.md 2>&1 || true`
Replace with `generating-strategy` skill where appropriate.

- [ ] **Step 5: Run tests + tsc**

Run: `pnpm vitest run && pnpm tsc --noEmit`

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "refactor(growth-strategist): delete agent; callers now invoke generating-strategy skill"
```

### Task F3: Side-by-side strategic-path comparison

- [ ] **Step 1: Generate a strategic path with the new skill against a test product**

Use the onboarding test fixture or a staging user. Capture the output JSON.

- [ ] **Step 2: Diff against a known-good strategic path generated pre-migration**

Compare structure: same field shapes, comparable thesis quality, plausible milestones. If quality regresses, iterate on the SKILL.md body before proceeding.

**Phase F verification gate:** strategic-path output equivalence on test product; tests green.

---

## Phase G — Step 6: Extract `allocating-plan-items` from `content-planner`

Pulls the per-week `plan_items` allocation logic out of the 186-line agent body into a dedicated skill. Agent stays multi-turn — the signal-gathering across `query_stalled_items` / `query_last_week_completions` / `query_recent_milestones` is genuinely iterative — but the allocation rules become a skill the agent calls.

### Task G1: Define schema

**Files:**
- Create: `src/skills/allocating-plan-items/schema.ts` + `__tests__/`

- [ ] **Step 1: Schema TDD**

Input: active strategic_path + this week's signals (stalled items, last week completions, recent milestones) + connected channels + targetWeekStart.
Output: array of `plan_items` rows ready to insert (kind, channel, scheduledAt, title, description, params).

Mirror Task C1's TDD shape.

- [ ] **Step 2: Commit**

```bash
git add src/skills/allocating-plan-items
git commit -m "feat(allocating-plan-items): schema + first test"
```

### Task G2: Create SKILL.md and references

**Files:**
- Create: `src/skills/allocating-plan-items/SKILL.md`
- Create: `src/skills/allocating-plan-items/references/allocation-rules.md`

- [ ] **Step 1: Move the allocation logic**

Read `src/tools/AgentTool/agents/content-planner/AGENT.md` and extract the sections describing:
- Channel mix per phase
- Pillar allocation rules
- scheduledAt distribution heuristics
- Stalled-item recovery rules
- Cross-reference rules (linking this week's items to last week's completions)

Move these into `allocation-rules.md`. The SKILL.md prompt is short — instruct the model to read the reference and emit plan_items per the rules.

- [ ] **Step 2: Frontmatter**

```yaml
---
name: allocating-plan-items
description: Given an active strategic_path and this week's signals (stalled items, last-week completions, recent milestones, connected channels), allocate plan_items for the coming 7 days with scheduledAt timestamps. Pure transformation — does not query DB, does not write plan_items. Caller (content-planner) handles signal gathering and persistence.
context: fork
model: claude-sonnet-4-6
maxTurns: 1
allowed-tools: []
references:
  - allocation-rules
---
```

- [ ] **Step 3: Loader test + commit**

```bash
git add src/skills/allocating-plan-items
git commit -m "feat(allocating-plan-items): SKILL.md + allocation-rules reference"
```

### Task G3: Thin content-planner agent to call the skill

**Files:**
- Modify: `src/tools/AgentTool/agents/content-planner/AGENT.md`

- [ ] **Step 1: Replace the inline allocation prose with the skill call**

The new agent body shape:
1. Call `query_strategic_path` to load active path
2. Call `query_stalled_items`, `query_last_week_completions`, `query_recent_milestones` in parallel
3. Call `skill('allocating-plan-items', { strategicPath, signals, channels, targetWeekStart })`
4. For each returned plan_item, call `add_plan_item` to persist
5. StructuredOutput

Target: ~80 lines.

- [ ] **Step 2: Update tests**

The `content-planner/__tests__/` should assert the agent's `tools:` list includes `skill`.

- [ ] **Step 3: Commit**

```bash
git add src/tools/AgentTool/agents/content-planner
git commit -m "refactor(content-planner): allocation rules now in skill; agent shrinks to orchestration"
```

### Task G4: Distributional check

- [ ] **Step 1: Run a Monday plan with the new skill on a test user**

Compare the output `plan_items` distribution (count per channel, count per pillar, scheduledAt spread) against a previous week's plan generated by the old agent.

- [ ] **Step 2: Verify**

Distribution within ±15% per channel/pillar bucket.

**Phase G verification gate:** Test plan distribution matches the old agent; tests green.

---

## Phase H — Step 7: Extract `judging-thread-quality` from `discovery-agent`

The 60-turn conversational loop with xAI Grok stays in the agent (the loop IS the work). Each loop turn that examines a Grok response now offloads "is this thread worth queuing" to a fork-mode skill.

### Task H1: Define schema

**Files:**
- Create: `src/skills/judging-thread-quality/schema.ts` + `__tests__/`

- [ ] **Step 1: Schema TDD**

Input: a single thread candidate from Grok response (title, body excerpt, author, url, posted_at, signals).
Output: `{ keep: boolean, score: 0-1, reason: string, signals: string[] }`.

Mirror Task D1's TDD shape.

- [ ] **Step 2: Commit**

### Task H2: Create SKILL.md

**Files:**
- Create: `src/skills/judging-thread-quality/SKILL.md`
- Create: `src/skills/judging-thread-quality/references/thread-quality-rules.md`

- [ ] **Step 1: Extract the thread-quality rules from `discovery-agent/AGENT.md`**

Run: `cat src/tools/AgentTool/agents/discovery-agent/AGENT.md`

Identify the section that describes "what makes a thread good" — the criteria for accepting a Grok candidate.

- [ ] **Step 2: Move those rules into `thread-quality-rules.md`**

Keep the conversational refinement rules in `discovery-agent/AGENT.md`. Only the per-candidate scoring rules move out.

- [ ] **Step 3: Frontmatter**

```yaml
---
name: judging-thread-quality
description: Score a single thread candidate from a discovery scan. Returns keep/skip + 0-1 score + reason + signals tags. Does not call APIs, does not persist — pure transformation. Caller (discovery-agent or scan worker) handles the loop and persistence.
context: fork
model: claude-haiku-4-5-20251001
maxTurns: 1
allowed-tools: []
references:
  - thread-quality-rules
---
```

(Haiku is correct here — per-candidate scoring is a tightly bounded judgment task and discovery runs many of them per loop turn.)

- [ ] **Step 4: Commit**

### Task H3: Update discovery-agent

**Files:**
- Modify: `src/tools/AgentTool/agents/discovery-agent/AGENT.md`

- [ ] **Step 1: Replace inline scoring with skill call**

Inside the conversational loop, when the agent gets a Grok response, it now calls the skill in batch (one skill call per candidate, parallelized) instead of doing inline scoring.

- [ ] **Step 2: Add `skill` to the tools list**

- [ ] **Step 3: Run tests + commit**

```bash
git add src/tools/AgentTool/agents/discovery-agent
git commit -m "refactor(discovery-agent): per-candidate scoring moves to judging-thread-quality skill"
```

### Task H4: Per-loop-turn acceptance-rate check

- [ ] **Step 1: Run a discovery scan, capture metrics**

Compare per-Grok-response thread-acceptance rate against a prior scan. Should match within ±15%.

**Phase H verification gate:** acceptance-rate distribution holds; tests green.

---

## Phase I — Step 8: `coordinator` embedded-rule audit

Final agent. Read all 229 lines of `coordinator/AGENT.md`. Anything that says "what makes a thread high priority", "what kind of mention should escalate", or other taste judgment must move to a skill. Pure delegation logic stays.

### Task I1: Audit pass

**Files:**
- Read: `src/tools/AgentTool/agents/coordinator/AGENT.md`

- [ ] **Step 1: Read the full AGENT.md**

```bash
cat src/tools/AgentTool/agents/coordinator/AGENT.md
```

- [ ] **Step 2: List every paragraph that contains taste judgment**

Make notes (in `docs/superpowers/specs/coordinator-audit-2026-05-01.md`) of:
- Any list of "high-priority signals"
- Any "always do X when Y" rule that involves content judgment
- Any reference to specific platform behavior or content shape

- [ ] **Step 3: Decide which existing skill (or new skill) each rule moves to**

Most should fit in: `validating-draft` (slop), `judging-opportunity` (gates), `judging-thread-quality` (discovery scoring), or a new tiny skill like `judging-mention-priority`.

- [ ] **Step 4: Commit the audit notes**

```bash
git add docs/superpowers/specs/coordinator-audit-2026-05-01.md
git commit -m "docs(coordinator): audit notes for embedded-rule extraction"
```

### Task I2: Extract any rules into existing or new skills

**Files:**
- Modify: relevant skills' references
- Modify: `src/tools/AgentTool/agents/coordinator/AGENT.md`

- [ ] **Step 1: For each audit note, do one of**

(a) Move text into an existing skill's reference markdown (e.g. add to `judging-opportunity/references/gate-rules.md`).
(b) Create a new tiny skill if the rule doesn't fit any existing one (rare).

- [ ] **Step 2: Replace the inline rule paragraph in AGENT.md with a skill call (or remove if redundant)**

- [ ] **Step 3: Run tests**

- [ ] **Step 4: Commit per-extraction**

One commit per rule extracted, with a short message naming where the rule went.

### Task I3: Final integration smoke test

- [ ] **Step 1: Run the full coordinator → community-manager → drafting-reply → validating-draft → draft_reply → review pipeline end-to-end**

Use a test user with a connected X channel and a populated `threads` inbox.

- [ ] **Step 2: Verify**

- The whole reply sweep completes
- Drafts persist with `review_verdict` set
- `slopFingerprint` arrays are populated where expected
- Per-skill costs (sum of `addCost` calls) are within projection: ≤ 3 fork calls per yes-thread, ≤ 5 with REVISE retry

- [ ] **Step 3: Tag the final milestone**

```bash
git tag agent-skill-decomposition-complete
```

**Phase I verification gate:** end-to-end smoke run passes; coordinator AGENT.md contains no embedded business rules; per-draft cost matches §1.4 spec ceiling.

---

## Final Self-Review Checklist

After all phases land, verify against the spec:

- [ ] **§1 standards:** CLAUDE.md `## Primitive Boundaries` section is present and matches spec wording
- [ ] **§1.3 hard rules:** No AGENT.md file contains banned-vocabulary lists, voice descriptions, or slop pattern enumerations
- [ ] **§1.4 cost ceiling:** A test sweep produces drafts at ≤ 3 fork calls per yes-thread (≤ 5 with REVISE)
- [ ] **§2.1 new skills:** All seven skills exist (`validating-draft`, `drafting-reply`, `drafting-post`, `judging-opportunity`, `judging-thread-quality`, `allocating-plan-items`, `generating-strategy`)
- [ ] **§2.2 tool changes:** `validate_draft` still mechanical; `enqueueReview` wired in `DraftReplyTool` and `DraftPostTool`
- [ ] **Replay catch-rate:** Phase B replay catches ≥ 11/12 of the production drafts as FAIL/REVISE
- [ ] **Live distribution:** First-person token rate ≥ 70% in post-migration drafts
- [ ] **No dead code:** `ai-slop-validator.ts` either deleted (rules moved) or only referenced from `validate_draft` regex pre-filter
- [ ] **Tests:** `pnpm vitest run` and `pnpm tsc --noEmit` both green
