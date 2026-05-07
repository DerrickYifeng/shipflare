# Pipeline → Tools Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move the per-item content pipelines (judge → draft → mechanical-validate → LLM-validate → persist, with REVISE retry) out of `content-manager/AGENT.md` prose and into Tools that own the orchestration logic. Same for the xAI conversational discovery loop currently inside `discovery-agent/AGENT.md`.

**Architecture (engine-aligned):**

shipflare's engine ships exactly three primitives — **Tool / Bundled-Skill / Agent** — and `BundledSkillDefinition` has no `execute()` (it's pure prompt composition). Complex deterministic multi-step work belongs **in a Tool**. A Tool's `execute(input, ctx)` is allowed to: run for-loops in parallel via `Promise.all`, call `runForkSkill()` for leaf LLM work, call other tools' `execute()` for mechanical sub-operations, and read/write the DB. That's the whole orchestration layer — no `src/lib/orchestrators/` companion files, no double-wrapping.

1. **Three new tools** carry what used to be AGENT.md prose:
   - `process_replies_batch` — for N threads: drafting-reply → validate_draft → validating-draft → draft_reply, with REVISE retry.
   - `process_posts_batch` — same shape for N plan_items.
   - `find_threads_via_xai` — multi-turn conversational xAI loop + per-candidate judging-thread-quality + persist_queue_threads.

2. **REVISE retry voice cue is deterministic** — a lookup table in `src/lib/slop-cue-mapper.ts` maps `slopFingerprint[]` → one-line voice cue. No LLM in the retry decision.

3. **Sweeper imports the tool directly** — `plan-execute-sweeper.ts` calls `processPostsBatchTool.execute(input, syntheticCtx)` where `syntheticCtx` comes from `createToolContext({userId, productId, db})`. Same path as agent invocation, no wrapper.

4. **content-manager and discovery-agent AGENT.md collapse** — embedded pipelines become a one-line tool reference. Plan 3 then merges these agents into Social Media Manager.

**Tech Stack:**
- TS Tools using existing `buildTool` from `@/core/tool-system`
- Existing `runForkSkill` (`src/skills/run-fork-skill.ts`) for fork-skill calls from non-agent contexts
- Existing tools: `validate_draft`, `draft_reply`, `draft_post`, `persist_queue_threads`, `xai_find_customers`
- Vitest for unit tests (mock `runForkSkill` + sub-tool `execute`), Playwright for the smoke

**Depends on:** Plan 1 (merge judging-opportunity → judging-thread-quality + share slop-rules) — tools read `thread.canMentionProduct` populated by Plan 1.

**Architecture note (memory):** The earlier draft of this plan introduced `src/lib/orchestrators/` as a parallel layer — that's out of engine vocabulary. See memory `feedback_engine_primitives_no_orchestrator.md`. This revision puts the orchestration directly in the Tool primitive.

---

## File map

**New files**
- `src/lib/slop-cue-mapper.ts` — fingerprint → voice cue lookup
- `src/lib/slop-cue-mapper.test.ts`
- `src/tools/ProcessRepliesBatchTool/ProcessRepliesBatchTool.ts` — orchestration tool
- `src/tools/ProcessRepliesBatchTool/__tests__/ProcessRepliesBatchTool.test.ts`
- `src/tools/ProcessPostsBatchTool/ProcessPostsBatchTool.ts`
- `src/tools/ProcessPostsBatchTool/__tests__/ProcessPostsBatchTool.test.ts`
- `src/tools/FindThreadsViaXaiTool/FindThreadsViaXaiTool.ts`
- `src/tools/FindThreadsViaXaiTool/__tests__/FindThreadsViaXaiTool.test.ts`

**Modified files**
- `src/tools/registry.ts` — register the three new tools
- `src/workers/processors/plan-execute-sweeper.ts` — call `processPostsBatchTool.execute()` directly instead of spawning agent_run
- `src/tools/AgentTool/agents/content-manager/AGENT.md` — collapse pipeline prose; reference the three new tools
- `src/tools/AgentTool/agents/discovery-agent/AGENT.md` — collapse conversational loop prose; reference `find_threads_via_xai`
- `src/tools/AgentTool/agents/coordinator/AGENT.md` — update spawn examples (specialists no longer embed pipeline)
- `e2e/draft-pipeline-smoke.spec.ts` — extend or create

---

## Task 1: Slop fingerprint → voice cue mapper

**Files:**
- Create: `src/lib/slop-cue-mapper.ts`
- Test: `src/lib/slop-cue-mapper.test.ts`

The mapper is a small utility helper, not a tool — pure function with no `execute()` semantics, no ctx, no input schema. Lives in `src/lib/` next to other utility modules. (`src/lib/` for util-like modules is consistent with `src/lib/logger`, `src/lib/auth`, etc.)

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, it, expect } from 'vitest';
import { mapSlopFingerprintToVoiceCue, KNOWN_FINGERPRINTS } from './slop-cue-mapper';

describe('mapSlopFingerprintToVoiceCue', () => {
  it('returns a one-line cue for every known hard-fail fingerprint', () => {
    for (const fp of [
      'diagnostic_from_above',
      'no_first_person',
      'binary_not_x_its_y',
      'preamble_opener',
      'banned_vocabulary',
      'engagement_bait_filler',
    ]) {
      const cue = mapSlopFingerprintToVoiceCue([fp]);
      expect(cue).toBeTruthy();
      expect(cue.length).toBeGreaterThan(10);
      expect(cue.length).toBeLessThan(280);
    }
  });

  it('returns a cue for every known revise-or-tighten fingerprint', () => {
    for (const fp of [
      'fortune_cookie_closer',
      'colon_aphorism_opener',
      'naked_number_unsourced',
      'em_dash_overuse',
      'triple_grouping',
      'negation_cadence',
    ]) {
      expect(mapSlopFingerprintToVoiceCue([fp])).toBeTruthy();
    }
  });

  it('combines cues when multiple fingerprints fire', () => {
    const cue = mapSlopFingerprintToVoiceCue(['preamble_opener', 'fortune_cookie_closer']);
    expect(cue).toContain('opener');
    expect(cue).toContain('closer');
  });

  it('returns a generic cue for empty fingerprint array', () => {
    expect(mapSlopFingerprintToVoiceCue([])).toContain('tighten');
  });

  it('ignores unknown fingerprints (forward-compat)', () => {
    const cue = mapSlopFingerprintToVoiceCue(['unknown_pattern_xyz', 'preamble_opener']);
    expect(cue).toContain('opener');
    expect(cue).not.toContain('unknown_pattern_xyz');
  });

  it('exports the exhaustive list of known fingerprints', () => {
    expect(KNOWN_FINGERPRINTS).toContain('diagnostic_from_above');
    expect(KNOWN_FINGERPRINTS).toContain('em_dash_overuse');
    expect(KNOWN_FINGERPRINTS.length).toBeGreaterThanOrEqual(12);
  });
});
```

- [ ] **Step 2: Run test, verify FAIL**

```bash
pnpm vitest run src/lib/slop-cue-mapper.test.ts
```

- [ ] **Step 3: Implement**

```typescript
/**
 * Maps `slopFingerprint[]` from validating-draft to a one-line voice cue
 * the next drafting-reply/drafting-post fork should use as its `voice` arg.
 *
 * Single source of truth for "what to tell the writer when REVISE fires" —
 * keeps the orchestrating tool deterministic (no LLM in the retry decision).
 */

const CUES = {
  diagnostic_from_above:
    "drop the diagnostic 'the real thing is...' frame; lead with a first-person specific from your own run",
  no_first_person:
    "every generalized claim needs an I/we + concrete number/year/tool anchor — add one or rewrite as a specific question",
  binary_not_x_its_y:
    "remove the 'X isn't Y, it's Z' aphorism template — rewrite as a single concrete observation",
  preamble_opener:
    "remove the generic opener (no 'great post', 'as a founder', etc.) — open with the specific anchor",
  banned_vocabulary:
    "rewrite without leverage/delve/utilize/robust/crucial/pivotal/landscape/ecosystem/journey/seamless/navigate/compelling — use concrete verbs",
  engagement_bait_filler:
    "the draft is filler — write a substantive reply with a first-person anchor or skip the thread",
  fortune_cookie_closer:
    "drop the closer aphorism (`that's the moat/game/trick/...`) — let the concrete anchor carry the weight",
  colon_aphorism_opener:
    "remove the colon-as-wisdom opener — replace with the specific anchor mid-sentence",
  naked_number_unsourced:
    "every number needs a first-person grounding (how I measured it / when it happened / the tool I used)",
  em_dash_overuse:
    "rewrite using two short sentences instead of multiple em-dashes — at most one per reply",
  triple_grouping:
    "drop the triple grouping (X, Y, and Z) — pick one and earn it with a number",
  negation_cadence:
    "drop the rhythmic 'no X. no Y.' — replace with one specific receipt",
} as const;

export const KNOWN_FINGERPRINTS = Object.keys(CUES) as (keyof typeof CUES)[];

const GENERIC_CUE =
  'tighten the draft — first-person specific, no aphorisms, no banned vocabulary';

export function mapSlopFingerprintToVoiceCue(fingerprints: string[]): string {
  const matched = fingerprints
    .filter((fp): fp is keyof typeof CUES => fp in CUES)
    .map((fp) => CUES[fp]);

  if (matched.length === 0) return GENERIC_CUE;
  if (matched.length === 1) return matched[0];

  const combined = `Address each issue: ${matched.map((c, i) => `(${i + 1}) ${c}`).join('; ')}`;
  return combined.length > 900 ? combined.slice(0, 900) + '...' : combined;
}
```

- [ ] **Step 4: Run test, verify PASS**

- [ ] **Step 5: Commit**

```bash
git add src/lib/slop-cue-mapper.ts src/lib/slop-cue-mapper.test.ts
git commit -m "feat(lib): add deterministic slop fingerprint → voice cue mapper for REVISE retry"
```

---

## Task 2: ProcessRepliesBatchTool

**Files:**
- Create: `src/tools/ProcessRepliesBatchTool/ProcessRepliesBatchTool.ts`
- Test: `src/tools/ProcessRepliesBatchTool/__tests__/ProcessRepliesBatchTool.test.ts`
- Modify: `src/tools/registry.ts`

This Tool's `execute()` IS the orchestrator. It does the parallel for-loop, calls fork-skills, calls sub-tools, returns a structured summary. No companion file in `src/lib/`.

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/skills/run-fork-skill', () => ({ runForkSkill: vi.fn() }));
vi.mock('@/tools/ValidateDraftTool/ValidateDraftTool', () => ({
  validateDraftTool: { execute: vi.fn() },
}));
vi.mock('@/tools/DraftReplyTool/DraftReplyTool', () => ({
  draftReplyTool: { execute: vi.fn() },
}));

import { runForkSkill } from '@/skills/run-fork-skill';
import { validateDraftTool } from '@/tools/ValidateDraftTool/ValidateDraftTool';
import { draftReplyTool } from '@/tools/DraftReplyTool/DraftReplyTool';
import { processRepliesBatchTool, PROCESS_REPLIES_BATCH_TOOL_NAME } from '../ProcessRepliesBatchTool';

// Test fixture for ctx — built via createToolContext in real usage
const ctx = { /* minimal stub with userId, productId, db, get(), abortSignal */ } as never;

describe('processRepliesBatchTool', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('exports the canonical name', () => {
    expect(PROCESS_REPLIES_BATCH_TOOL_NAME).toBe('process_replies_batch');
  });

  it('persists when mechanical + validating both PASS (single thread)', async () => {
    // Mock thread row in DB
    // mockDbReturnsThreads([baseThread])
    (runForkSkill as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({
        result: { draftBody: 'we tried railway too — same.', whyItWorks: 'first-person', confidence: 0.7 },
        usage: {},
      })
      .mockResolvedValueOnce({
        result: { verdict: 'PASS', score: 0.85, slopFingerprint: [] },
        usage: {},
      });
    (validateDraftTool.execute as ReturnType<typeof vi.fn>).mockResolvedValue({ failures: [], warnings: [] });
    (draftReplyTool.execute as ReturnType<typeof vi.fn>).mockResolvedValue({ id: 'd1' });

    const result = await processRepliesBatchTool.execute({ threadIds: ['t1'] }, ctx);

    expect(result.draftsCreated).toBe(1);
    expect(draftReplyTool.execute).toHaveBeenCalledOnce();
  });

  it('rejects on mechanical fail without calling validating-draft', async () => {
    (runForkSkill as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      result: { draftBody: 'a'.repeat(500), whyItWorks: '', confidence: 0.5 },
      usage: {},
    });
    (validateDraftTool.execute as ReturnType<typeof vi.fn>).mockResolvedValue({
      failures: [{ code: 'length', message: 'over 240 chars' }],
      warnings: [],
    });

    const result = await processRepliesBatchTool.execute({ threadIds: ['t1'] }, ctx);

    expect(result.draftsCreated).toBe(0);
    expect(draftReplyTool.execute).not.toHaveBeenCalled();
    // validating-draft (the LLM) NOT called when mechanical failed
    expect(runForkSkill).toHaveBeenCalledOnce();
  });

  it('retries with voice cue on REVISE; persists if retry passes', async () => {
    (runForkSkill as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({ result: { draftBody: 'great post! the real win is...', whyItWorks: '', confidence: 0.6 }, usage: {} })
      .mockResolvedValueOnce({ result: { verdict: 'REVISE', score: 0.5, slopFingerprint: ['preamble_opener'] }, usage: {} })
      .mockResolvedValueOnce({ result: { draftBody: 'we tried railway — broke at edge case', whyItWorks: '', confidence: 0.7 }, usage: {} })
      .mockResolvedValueOnce({ result: { verdict: 'PASS', score: 0.8, slopFingerprint: [] }, usage: {} });
    (validateDraftTool.execute as ReturnType<typeof vi.fn>).mockResolvedValue({ failures: [], warnings: [] });
    (draftReplyTool.execute as ReturnType<typeof vi.fn>).mockResolvedValue({ id: 'd1' });

    const result = await processRepliesBatchTool.execute({ threadIds: ['t1'] }, ctx);

    expect(result.draftsCreated).toBe(1);
    expect(runForkSkill).toHaveBeenCalledTimes(4);
    // The retry-draft fork-skill call must include the voice cue
    const retryDraftCall = (runForkSkill as ReturnType<typeof vi.fn>).mock.calls[2];
    expect(retryDraftCall[1]).toContain('opener');
  });

  it('persists with [needs human review] flag when retry still REVISEs', async () => {
    (runForkSkill as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({ result: { draftBody: 'd1', whyItWorks: '', confidence: 0.6 }, usage: {} })
      .mockResolvedValueOnce({ result: { verdict: 'REVISE', slopFingerprint: ['fortune_cookie_closer'] }, usage: {} })
      .mockResolvedValueOnce({ result: { draftBody: 'd2', whyItWorks: '', confidence: 0.6 }, usage: {} })
      .mockResolvedValueOnce({ result: { verdict: 'REVISE', slopFingerprint: ['fortune_cookie_closer'] }, usage: {} });
    (validateDraftTool.execute as ReturnType<typeof vi.fn>).mockResolvedValue({ failures: [], warnings: [] });
    (draftReplyTool.execute as ReturnType<typeof vi.fn>).mockResolvedValue({ id: 'd1' });

    const result = await processRepliesBatchTool.execute({ threadIds: ['t1'] }, ctx);

    expect(draftReplyTool.execute).toHaveBeenCalledOnce();
    const persistArgs = (draftReplyTool.execute as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(persistArgs.whyItWorks).toContain('needs human review');
  });

  it('skips when validating returns FAIL', async () => {
    (runForkSkill as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({ result: { draftBody: 'd1', whyItWorks: '', confidence: 0.6 }, usage: {} })
      .mockResolvedValueOnce({ result: { verdict: 'FAIL', slopFingerprint: ['banned_vocabulary'] }, usage: {} });
    (validateDraftTool.execute as ReturnType<typeof vi.fn>).mockResolvedValue({ failures: [], warnings: [] });

    const result = await processRepliesBatchTool.execute({ threadIds: ['t1'] }, ctx);

    expect(result.draftsCreated).toBe(0);
    expect(draftReplyTool.execute).not.toHaveBeenCalled();
  });

  it('skips threads where canMentionProduct is null (legacy unjudged)', async () => {
    // mockDbReturnsThreads([{ ...baseThread, canMentionProduct: null, mentionSignal: null }])
    const result = await processRepliesBatchTool.execute({ threadIds: ['t1'] }, ctx);

    expect(result.draftsCreated).toBe(0);
    // Tool didn't even call drafting-reply for legacy rows
    expect(runForkSkill).not.toHaveBeenCalled();
  });

  it('parallelizes across multiple threads via Promise.all', async () => {
    // mockDbReturnsThreads([t1, t2, t3])
    (runForkSkill as ReturnType<typeof vi.fn>).mockResolvedValue({
      result: { draftBody: 'd', whyItWorks: '', confidence: 0.7, verdict: 'PASS', slopFingerprint: [] },
      usage: {},
    });
    (validateDraftTool.execute as ReturnType<typeof vi.fn>).mockResolvedValue({ failures: [], warnings: [] });
    (draftReplyTool.execute as ReturnType<typeof vi.fn>).mockResolvedValue({ id: 'd' });

    const result = await processRepliesBatchTool.execute(
      { threadIds: ['t1', 't2', 't3'] },
      ctx,
    );

    expect(result.draftsCreated).toBe(3);
  });

  it('returns empty result when no threadIds match in DB (no fork calls)', async () => {
    // mockDbReturnsThreads([])
    const result = await processRepliesBatchTool.execute({ threadIds: ['nonexistent'] }, ctx);
    expect(result.itemsScanned).toBe(0);
    expect(runForkSkill).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test, verify FAIL**

- [ ] **Step 3: Implement the tool**

```typescript
import { z } from 'zod';
import { and, eq, inArray } from 'drizzle-orm';
import { buildTool } from '@/core/tool-system';
import { threads as threadsTbl, products } from '@/lib/db/schema';
import { readDomainDeps } from '@/tools/context-helpers';
import { runForkSkill } from '@/skills/run-fork-skill';
import { validateDraftTool } from '@/tools/ValidateDraftTool/ValidateDraftTool';
import { draftReplyTool } from '@/tools/DraftReplyTool/DraftReplyTool';
import { mapSlopFingerprintToVoiceCue } from '@/lib/slop-cue-mapper';
import { createLogger } from '@/lib/logger';

const log = createLogger('tool:process_replies_batch');

export const PROCESS_REPLIES_BATCH_TOOL_NAME = 'process_replies_batch';

const inputSchema = z.object({
  threadIds: z.array(z.string()).min(1).max(50),
  voice: z.string().optional(),
  founderVoiceBlock: z.string().optional(),
});

interface BatchItemResult {
  threadId: string;
  status:
    | 'persisted'
    | 'persisted_after_revise'
    | 'persisted_flagged_for_review'
    | 'rejected_mechanical'
    | 'rejected_validating'
    | 'skipped_legacy_unjudged';
  reason?: string;
  slopFingerprint?: string[];
}

interface BatchResult {
  itemsScanned: number;
  draftsCreated: number;
  draftsSkipped: number;
  notes: string;
  details: BatchItemResult[];
}

interface DraftSkillOutput {
  draftBody: string;
  whyItWorks: string;
  confidence: number;
}

interface ValidatingSkillOutput {
  verdict: 'PASS' | 'REVISE' | 'FAIL';
  score: number;
  slopFingerprint: string[];
}

export const processRepliesBatchTool = buildTool({
  name: PROCESS_REPLIES_BATCH_TOOL_NAME,
  description:
    'Process a batch of threads through the full reply pipeline (drafting-reply → ' +
    'validate_draft → validating-draft → draft_reply with REVISE retry). Discovery ' +
    'already judged each thread (canMentionProduct on the row); this tool does ' +
    'NOT re-judge. Threads with canMentionProduct=null are skipped as legacy. ' +
    'Returns a per-thread result summary; details are logged at INFO level.\n\n' +
    'INPUT: { "threadIds": ["uuid1","uuid2",...], "voice"?: string, "founderVoiceBlock"?: string }\n' +
    'OUTPUT: { itemsScanned, draftsCreated, draftsSkipped, notes, details[] }',
  inputSchema,
  isConcurrencySafe: false,
  isReadOnly: false,
  async execute(input, ctx): Promise<BatchResult> {
    const { db, userId, productId } = readDomainDeps(ctx);

    const threadRows = await db
      .select()
      .from(threadsTbl)
      .where(and(eq(threadsTbl.userId, userId), inArray(threadsTbl.id, input.threadIds)));

    if (threadRows.length === 0) {
      return { itemsScanned: 0, draftsCreated: 0, draftsSkipped: 0, notes: 'no threads matched', details: [] };
    }

    const [productRow] = await db
      .select({ id: products.id, name: products.name, description: products.description, valueProp: products.valueProp })
      .from(products)
      .where(eq(products.id, productId))
      .limit(1);
    if (!productRow) {
      throw new Error(`process_replies_batch: product ${productId} not found`);
    }

    const results = await Promise.all(
      threadRows.map((thread) => processOne(thread, productRow, input, ctx)),
    );

    const draftsCreated = results.filter((r) =>
      r.status === 'persisted' ||
      r.status === 'persisted_after_revise' ||
      r.status === 'persisted_flagged_for_review'
    ).length;

    const slopCounts = new Map<string, number>();
    for (const r of results) {
      for (const fp of r.slopFingerprint ?? []) {
        slopCounts.set(fp, (slopCounts.get(fp) ?? 0) + 1);
      }
    }
    const notes = slopCounts.size > 0
      ? `slop fingerprints: ${[...slopCounts.entries()].map(([k, v]) => `${k}=${v}`).join(', ')}`
      : 'no slop patterns matched';

    log.info(
      `process_replies_batch user=${userId} threads=${threadRows.length} ` +
      `created=${draftsCreated} skipped=${threadRows.length - draftsCreated}`,
    );

    return {
      itemsScanned: threadRows.length,
      draftsCreated,
      draftsSkipped: threadRows.length - draftsCreated,
      notes,
      details: results,
    };
  },
});

async function processOne(
  thread: typeof threadsTbl.$inferSelect,
  product: { id: string; name: string; description: string; valueProp: string | null },
  input: z.infer<typeof inputSchema>,
  ctx: Parameters<typeof processRepliesBatchTool.execute>[1],
): Promise<BatchItemResult> {
  if (thread.canMentionProduct === null && thread.mentionSignal === null) {
    return { threadId: thread.id, status: 'skipped_legacy_unjudged', reason: 'pre-Plan-1 row' };
  }

  // Step 1: draft
  const draft = await draftOnce(thread, product, input, undefined, ctx);

  // Step 2: mechanical
  const mech = await validateDraftTool.execute(
    { text: draft.draftBody, platform: thread.platform as 'x' | 'reddit', kind: 'reply' },
    ctx,
  );
  if (mech.failures.length > 0) {
    return { threadId: thread.id, status: 'rejected_mechanical', reason: mech.failures[0].message };
  }

  // Step 3: validating-draft (LLM)
  const review = await validateOnce(thread, product, draft, ctx);

  // Step 4: decide
  if (review.verdict === 'PASS') {
    await draftReplyTool.execute(
      { threadId: thread.id, draftBody: draft.draftBody, confidence: draft.confidence, whyItWorks: draft.whyItWorks },
      ctx,
    );
    return { threadId: thread.id, status: 'persisted', slopFingerprint: review.slopFingerprint };
  }

  if (review.verdict === 'REVISE') {
    const cue = mapSlopFingerprintToVoiceCue(review.slopFingerprint);
    const retry = await draftOnce(thread, product, input, cue, ctx);
    const retryMech = await validateDraftTool.execute(
      { text: retry.draftBody, platform: thread.platform as 'x' | 'reddit', kind: 'reply' },
      ctx,
    );
    if (retryMech.failures.length > 0) {
      return {
        threadId: thread.id,
        status: 'rejected_mechanical',
        reason: `retry mech: ${retryMech.failures[0].message}`,
        slopFingerprint: review.slopFingerprint,
      };
    }
    const retryReview = await validateOnce(thread, product, retry, ctx);
    if (retryReview.verdict === 'PASS') {
      await draftReplyTool.execute(
        { threadId: thread.id, draftBody: retry.draftBody, confidence: retry.confidence, whyItWorks: retry.whyItWorks },
        ctx,
      );
      return { threadId: thread.id, status: 'persisted_after_revise', slopFingerprint: review.slopFingerprint };
    }
    if (retryReview.verdict === 'REVISE') {
      // Per CLAUDE.md max-1-revise rule
      await draftReplyTool.execute(
        {
          threadId: thread.id,
          draftBody: retry.draftBody,
          confidence: retry.confidence,
          whyItWorks: `${retry.whyItWorks} [needs human review: ${retryReview.slopFingerprint.join(',')}]`,
        },
        ctx,
      );
      return {
        threadId: thread.id,
        status: 'persisted_flagged_for_review',
        slopFingerprint: retryReview.slopFingerprint,
      };
    }
    return { threadId: thread.id, status: 'rejected_validating', reason: 'retry FAIL', slopFingerprint: retryReview.slopFingerprint };
  }

  return { threadId: thread.id, status: 'rejected_validating', reason: 'FAIL on first review', slopFingerprint: review.slopFingerprint };
}

async function draftOnce(
  thread: typeof threadsTbl.$inferSelect,
  product: { name: string; description: string; valueProp: string | null },
  input: z.infer<typeof inputSchema>,
  voiceOverride: string | undefined,
  ctx: Parameters<typeof processRepliesBatchTool.execute>[1],
): Promise<DraftSkillOutput> {
  const args = {
    thread: { title: thread.title, body: thread.body ?? '', author: thread.author, community: thread.community, platform: thread.platform },
    product: { name: product.name, description: product.description, ...(product.valueProp ? { valueProp: product.valueProp } : {}) },
    channel: thread.platform,
    canMentionProduct: thread.canMentionProduct === true,
    ...(voiceOverride ? { voice: voiceOverride } : input.voice ? { voice: input.voice } : {}),
    ...(input.founderVoiceBlock ? { founderVoiceBlock: input.founderVoiceBlock } : {}),
  };
  const { result } = await runForkSkill<DraftSkillOutput>('drafting-reply', JSON.stringify(args), undefined, ctx);
  return result;
}

async function validateOnce(
  thread: typeof threadsTbl.$inferSelect,
  product: { name: string; description: string },
  draft: DraftSkillOutput,
  ctx: Parameters<typeof processRepliesBatchTool.execute>[1],
): Promise<ValidatingSkillOutput> {
  const args = {
    drafts: [{
      replyBody: draft.draftBody,
      threadTitle: thread.title,
      threadBody: thread.body ?? '',
      subreddit: thread.community,
      productName: product.name,
      productDescription: product.description,
      confidence: draft.confidence,
      whyItWorks: draft.whyItWorks,
    }],
    memoryContext: '',
  };
  const { result } = await runForkSkill<ValidatingSkillOutput>('validating-draft', JSON.stringify(args), undefined, ctx);
  return result;
}
```

- [ ] **Step 4: Register in `src/tools/registry.ts`**

Add the import and add `processRepliesBatchTool` to the team-context tool list (Plan 3 will narrow it to social-media-manager only).

- [ ] **Step 5: Run test, verify PASS**

```bash
pnpm vitest run src/tools/ProcessRepliesBatchTool/
```

- [ ] **Step 6: Type-check**

```bash
pnpm tsc --noEmit
```

- [ ] **Step 7: Commit**

```bash
git add src/tools/ProcessRepliesBatchTool/ src/tools/registry.ts
git commit -m "feat(tools): process_replies_batch — Tool whose execute() owns the reply pipeline (was content-manager prose)"
```

---

## Task 3: ProcessPostsBatchTool

Mirror Task 2's pattern, but for the post path:

- Input: `{ planItemIds: string[] }`
- Loads `plan_items` rows + product context
- Calls `drafting-post` fork-skill (instead of `drafting-reply`)
- Persists via `draftPostTool.execute({planItemId, draftBody, whyItWorks})` — that tool also flips `plan_items.state` from `drafting → drafted` (sweeper has already flipped `planned → drafting` per Plan 1's Phase J groundwork)
- `validating-draft` input shape reuses reply-centric field names but populates `replyBody = draftBody`, `threadTitle = planItem.title`, `threadBody = planItem.description`, `subreddit = channel` per content-manager's existing pattern
- Skip the `skipped_legacy_unjudged` branch — no judging on the post path

- [ ] **Step 1-7:** mirror Task 2 (write failing test, verify fail, implement, register, verify pass, type-check, commit)

Add one extra test specific to posts:

```typescript
it('reads plan_item from DB and passes phase + params to drafting-post', async () => {
  // mockDbReturnsPlanItems([{ ..., phase: 'compound', params: { pillar: 'milestone' } }])
  await processPostsBatchTool.execute({ planItemIds: ['p1'] }, ctx);
  const draftCall = (runForkSkill as ReturnType<typeof vi.fn>).mock.calls[0];
  expect(draftCall[1]).toContain('compound');
  expect(draftCall[1]).toContain('milestone');
});
```

```bash
git commit -m "feat(tools): process_posts_batch — Tool whose execute() owns the post pipeline"
```

---

## Task 4: FindThreadsViaXaiTool

The conversational xAI loop currently inside `discovery-agent/AGENT.md` becomes this Tool's `execute()`:

1. Read product context + ICP rubric (memories.discovery-rubric)
2. Loop up to N rounds (default 10):
   a. Compose user message (first turn = template; later turns = refinement based on rejection signals)
   b. Call `xaiFindCustomersTool.execute({messages, productContext, reasoning: false})`
   c. For each returned candidate, call `runForkSkill('judging-thread-quality', ...)` in parallel — gets `{keep, score, reason, signals, canMentionProduct, mentionSignal}` per Plan 1
   d. Aggregate keepers; if enough strong (≥ maxResults × 0.8 with score ≥ 0.6), break
   e. Otherwise compose refinement and continue
3. Persist final list via `persistQueueThreadsTool.execute({threads: [...keepers]})` — input now carries `can_mention_product` + `mention_signal` per Plan 1

Refinement composition is mechanical — aggregate top-3 rejection signals → produce a one-line refinement nudge. No LLM in the loop's control flow.

- [ ] **Step 1: Write the failing test**

Cover:
- Single-round PASS (3+ strong candidates, 0 rejected)
- Two-round refinement (round 1 surfaces 3 mixed; round 2 returns the missing 7)
- Reasoning escalation (after 2 unsuccessful refines, the tool flips `reasoning: true` once)
- MAX_ROUNDS cap (10) — persist whatever's accumulated
- Empty result allowed — persist 0, return scoutNotes explaining

- [ ] **Step 2: Run test, verify FAIL**

- [ ] **Step 3: Implement**

```typescript
export const FIND_THREADS_VIA_XAI_TOOL_NAME = 'find_threads_via_xai';

const inputSchema = z.object({
  trigger: z.enum(['kickoff', 'daily']).default('daily'),
  intent: z.string().optional(),
  maxResults: z.number().int().min(1).max(50).default(10),
});

const MAX_ROUNDS = 10;

// Helper: aggregate rejection signals into a refinement nudge string
function composeRefinementMessage(
  rejectionSignals: Map<string, number>,
  strongUrls: string[],
): string {
  const SIGNAL_NUDGE: Record<string, string> = {
    competitor_bio: 'drop accounts whose bios mention competing tools or "growth tips"',
    engagement_pod: 'avoid threads with engagement-pod patterns (rapid early replies from familiar handles)',
    advice_giver: 'skip accounts that are teaching, not asking',
    political: 'skip political / culture-war threads regardless of keyword match',
    // ... full mapping aligned with judging-thread-quality signals
  };
  const top = [...rejectionSignals.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3);
  const nudges = top.map(([sig]) => SIGNAL_NUDGE[sig]).filter(Boolean);
  const followLike = strongUrls.length > 0
    ? `Find more like ${strongUrls.slice(0, 2).join(' / ')}.`
    : '';
  return [
    `Found ${strongUrls.length} strong matches.`,
    nudges.length > 0 ? `Refine: ${nudges.join('; ')}.` : '',
    followLike,
  ].filter(Boolean).join(' ');
}

export const findThreadsViaXaiTool = buildTool({
  name: FIND_THREADS_VIA_XAI_TOOL_NAME,
  description:
    'Run the conversational xAI Grok discovery loop, judge each candidate via ' +
    'judging-thread-quality, persist keepers to the threads table. Returns the ' +
    'same shape discovery-agent\'s StructuredOutput uses today: ' +
    '{ queued, scanned, scoutNotes, costUsd, topQueued }.',
  inputSchema,
  isConcurrencySafe: false,
  isReadOnly: false,
  async execute(input, ctx) {
    // Track xai conversation as messages: { role, content }[]
    // Loop with refinement; cap at MAX_ROUNDS; escalate reasoning once if needed
    // Return summary
    // [Full impl mirrors discovery-agent/AGENT.md current workflow logic]
  },
});
```

- [ ] **Step 4: Register, verify, commit**

```bash
git commit -m "feat(tools): find_threads_via_xai — Tool whose execute() owns the conversational xAI discovery loop"
```

---

## Task 5: plan-execute-sweeper calls the Tool directly

**Files:**
- Modify: `src/workers/processors/plan-execute-sweeper.ts`
- Test: `src/workers/processors/__tests__/plan-execute-sweeper.test.ts`

The sweeper today spawns a content-manager `agent_run` with `mode='post_batch'`. After this task, it imports `processPostsBatchTool` and calls `tool.execute(input, syntheticCtx)` directly. No team_messages, no agent_runs row, no BullMQ trip for the orchestration layer (the leaf fork-skills still produce their own usage rows).

- [ ] **Step 1: Write the failing test**

Extend the sweeper test to assert: when `dispatchOneUserBatch` is called for a content_post batch, the tool is invoked (mocked) and **no** call to `spawnMemberAgentRun` happens.

- [ ] **Step 2: Refactor `dispatchOneUserBatch`**

Replace the `spawnMemberAgentRun(...)` call with:

```typescript
import { processPostsBatchTool } from '@/tools/ProcessPostsBatchTool/ProcessPostsBatchTool';
import { createToolContext } from '@/bridge/agent-runner';
// ...
const syntheticCtx = createToolContext({ db, userId: group.userId, productId: group.productId });
const result = await processPostsBatchTool.execute(
  { planItemIds },
  syntheticCtx,
);
jlog.info(
  `content_post batch via tool: created=${result.draftsCreated} ` +
  `skipped=${result.draftsSkipped} for user=${group.userId}`,
);
```

The atomic claim (`planned → drafting`) stays as-is. The tool handles `drafting → drafted` via its `draftPostTool.execute()` calls.

- [ ] **Step 3: Run test, verify PASS**

- [ ] **Step 4: Real-browser smoke check (manual)**

```bash
pnpm dev &
DEV_PID=$!
sleep 5
# Insert a test plan_item in 'planned' state for an authenticated user, wait for sweeper tick
psql "$DATABASE_URL" -c "SELECT count(*) FROM agent_runs WHERE created_at > now() - interval '1 minute' AND agent_def_name = 'content-manager';"
# Expected: 0 rows (tool path doesn't spawn agent_run)
kill $DEV_PID
```

- [ ] **Step 5: Commit**

```bash
git commit -m "refactor(sweeper): plan-execute-sweeper calls process_posts_batch tool directly — no agent_run spawn for cron-driven post batches"
```

---

## Task 6: Slim content-manager + discovery-agent AGENT.md

**Files:**
- Modify: `src/tools/AgentTool/agents/content-manager/AGENT.md`
- Modify: `src/tools/AgentTool/agents/discovery-agent/AGENT.md`

Per CLAUDE.md primitive boundaries + memory `feedback_engine_primitives_no_orchestrator`: AGENT.md should be role + tools + patterns + examples, not embedded pipeline prose. Both agents now own ONE tool: invoke their orchestration tool and report.

- [ ] **Step 1: Write the failing assertion**

```typescript
it('content-manager AGENT.md no longer embeds pipeline prose', () => {
  const md = readFileSync(
    path.resolve(process.cwd(), 'src/tools/AgentTool/agents/content-manager/AGENT.md'),
    'utf8',
  );
  // No numbered pipeline steps, no "Per-item workflow"
  expect(md).not.toMatch(/Per-item workflow/);
  expect(md).not.toMatch(/1\.\s+\*\*Judge\*\*/);
  expect(md).not.toMatch(/4\.\s+\*\*Slop \/ voice review/);
  // Tool references present
  expect(md).toContain('process_replies_batch');
  expect(md).toContain('process_posts_batch');
});

it('discovery-agent AGENT.md no longer embeds the conversational xAI loop', () => {
  const md = readFileSync(
    path.resolve(process.cwd(), 'src/tools/AgentTool/agents/discovery-agent/AGENT.md'),
    'utf8',
  );
  expect(md).not.toMatch(/Compose a user message describing what you want xAI to find/);
  expect(md).toContain('find_threads_via_xai');
});
```

- [ ] **Step 2: Rewrite content-manager AGENT.md**

Use **role + tool inventory + patterns + examples** style (engine-aligned). NOT prescriptive "Mode: X → Steps: 1, 2, 3":

```markdown
---
name: content-manager
description: Drafts content (replies and posts). One Tool per workflow shape — process_replies_batch for thread lists, process_posts_batch for plan_item lists. Pipelines (draft → validate → persist with REVISE retry) live inside the Tools, not here.
role: member
model: claude-haiku-4-5-20251001
maxTurns: 10
tools:
  - process_replies_batch
  - process_posts_batch
  - find_threads
  - query_plan_items
  - query_product_context
  - SendMessage
  - StructuredOutput
shared-references:
  - base-guidelines
---

# Content Manager for {productName}

## Your tools

- `process_replies_batch({ threadIds, voice?, founderVoiceBlock? })` — full pipeline for N threads. Returns `{ itemsScanned, draftsCreated, draftsSkipped, notes }`.
- `process_posts_batch({ planItemIds })` — full pipeline for N plan_items. Same return shape.
- `find_threads({ platforms, limit })` — read inbox without scanning.
- `query_plan_items` / `query_product_context` — read context.

## Patterns

### Reply sweep (founder gave you a thread list, OR coordinator forwarded one)

You: I'll process these in one batch.
  process_replies_batch({ threadIds: [...] })
  → { draftsCreated: 4, draftsSkipped: 1, notes: 'one slop_fingerprint=preamble_opener' }

You: Drafted 4 replies; 1 skipped (slop pattern). All in /briefing for your review.

### Post batch (coordinator or sweeper handed you plan_item IDs)

You: process_posts_batch({ planItemIds: [...] })
  → { draftsCreated: 5, draftsSkipped: 0 }

You: Drafted 5 posts. They'll appear in /today scheduled for their respective dates.

### Open scan (no input — rare fallback)

You: find_threads({ platforms: ['x', 'reddit'], limit: 3 })
  → returns 3 thread rows
  process_replies_batch({ threadIds: [those 3] })

You: Pulled 3 inbox threads, drafted replies for all of them.

## Hard rules

- NEVER write reply / post bodies in your own LLM turn — always use the batch tools.
- The tools already enforce: discovery's canMentionProduct decision, validate_draft mechanical checks, validating-draft slop review, REVISE retry with deterministic voice cue. You do NOT script these steps.
- Founder messages routed to you (via SendMessage) are conversational — answer in plain prose; use the batch tools when work is needed.

## Output

```ts
StructuredOutput({
  status: 'completed' | 'partial' | 'failed',
  itemsScanned: number,
  draftsCreated: number,
  draftsSkipped: number,
  notes: string,
})
```
```

- [ ] **Step 3: Rewrite discovery-agent AGENT.md**

```markdown
---
name: discovery-agent
description: Find X/Twitter threads worth the founder's reply attention. Single tool — find_threads_via_xai owns the conversational xAI loop, per-candidate judging, and persistence.
role: member
requires:
  - product:has_description
model: claude-sonnet-4-6
maxTurns: 4
tools:
  - find_threads_via_xai
  - read_memory
  - StructuredOutput
shared-references:
  - base-guidelines
---

# Discovery Agent for {productName}

## Your tool

- `find_threads_via_xai({ trigger, intent?, maxResults? })` — runs the full conversational discovery loop. Returns `{ queued, scanned, scoutNotes, costUsd, topQueued }`.

## Patterns

### Daily run from cron

You: I'll kick off discovery with the founder's onboarding-derived rubric.
  read_memory({ name: 'discovery-rubric' })
  → returns rubric content

  find_threads_via_xai({ trigger: 'daily', intent: <rubric>, maxResults: 10 })
  → { queued: 8, scanned: 23, scoutNotes: 'tightened bio filter; 8 strong matches', topQueued: [...] }

You: Queued 8 threads; topQueued is in the structured output for the coordinator to fan out replies.

### Coordinator-supplied intent

You: find_threads_via_xai({ trigger: 'daily', intent: 'focus on indie hackers asking about deploys today', maxResults: 5 })
  → { queued: 5, ... }

You: Found 5 deploy-related threads, all queued.

## Hard rules

- The tool persists threads itself. Do NOT call any other persistence tool.
- If `queued: 0`, your StructuredOutput's `scoutNotes` MUST explain why (no ICP matches, all promotional accounts, etc.).

## Output

```ts
StructuredOutput({
  queued: number,
  scanned: number,
  scoutNotes: string,
  costUsd: number,
  topQueued: Array<{...}>,
})
```
```

- [ ] **Step 4: Run tests, verify PASS**

```bash
pnpm vitest run src/tools/AgentTool/agents/content-manager/ src/tools/AgentTool/agents/discovery-agent/
```

- [ ] **Step 5: Commit**

```bash
git commit -m "refactor(agents): collapse content-manager + discovery-agent AGENT.md from pipeline-prose to role+patterns+examples"
```

---

## Task 7: Real-browser smoke

**Files:**
- Modify or create: `e2e/draft-pipeline-smoke.spec.ts`

- [ ] **Step 1: Update / create the smoke**

Reuse the test from Plan 1 if it exists; otherwise create one. Goal: verify the orchestration tool path works end-to-end and does NOT spawn an agent_run for cron post_batch:

```typescript
const beforeCount = await db.execute(
  sql`SELECT count(*) FROM agent_runs WHERE agent_def_name = 'content-manager' AND created_at > now() - interval '5 minutes'`,
);
// trigger automation run
// wait for draft to appear in /briefing
const afterCount = await db.execute(
  sql`SELECT count(*) FROM agent_runs WHERE agent_def_name = 'content-manager' AND created_at > now() - interval '5 minutes'`,
);
// Sweeper-driven post_batch: 0 spawns (tool-direct path).
// Lead-driven daily playbook reply_sweep: ≤1 spawn (legitimate — agent calls process_replies_batch).
expect(Number(afterCount[0].count) - Number(beforeCount[0].count)).toBeLessThanOrEqual(1);
```

- [ ] **Step 2: Run + commit**

```bash
pnpm playwright test e2e/draft-pipeline-smoke.spec.ts --reporter=list
git commit -m "test(e2e): real-browser smoke verifies tool-direct path bypasses agent_runs for cron post batches"
```

---

## Task 8: Final verification + push

- [ ] **Step 1: Type-check + tests**

```bash
pnpm tsc --noEmit
pnpm vitest run --reporter=basic
```

- [ ] **Step 2: Greppable invariants**

```bash
# No "src/lib/orchestrators" anywhere
find src -path "*/orchestrators/*"
# Expected: zero matches

# Pipeline prose no longer in AGENT.md
grep -rn "Per-item workflow" src/tools/AgentTool/agents/
# Expected: zero hits

# Three new tools registered
ls src/tools/ProcessRepliesBatchTool/ src/tools/ProcessPostsBatchTool/ src/tools/FindThreadsViaXaiTool/

# slop-cue-mapper has exactly one home
find src -name "slop-cue-mapper.ts" | grep -v test
# Expected: exactly one match
```

- [ ] **Step 3: Push**

```bash
git push -u origin HEAD
```

---

## Self-Review

**Spec coverage:**
- 3 orchestration Tools created (replies-batch, posts-batch, find-threads-via-xai) → Tasks 2, 3, 4 ✓
- Slop cue mapper → Task 1 ✓
- Sweeper integration (direct tool import, no agent_run spawn) → Task 5 ✓
- AGENT.md collapse for the two affected agents (engine-aligned style) → Task 6 ✓
- Real-browser smoke → Task 7 ✓
- Final verification → Task 8 ✓

**Engine-alignment check:**
- No `src/lib/orchestrators/` invented (the earlier draft did — corrected per memory)
- Each batch processor IS a Tool, not a separate layer
- AGENT.md uses role + tool inventory + patterns + examples, not prescriptive Mode prose
- Bundled-skill primitive untouched (it's correctly only for prompt composition; we don't need it for this work)

**Type consistency:**
- `BatchResult` / `BatchItemResult` shape used consistently across the three tools' return types
- All three tools follow the same `buildTool({ name, description, inputSchema, isConcurrencySafe, isReadOnly, execute })` shape
- `readDomainDeps(ctx)` used consistently for ctx unwrapping

---

## Tradeoffs / risks

- **Slop cue mapper is a static lookup table.** Adding a new fingerprint requires a code change. Acceptable today (12 known patterns, evolves slowly); revisit if patterns explode.
- **No LLM judgment in REVISE retry.** Deterministic mapping table replaces content-manager's haiku-LLM "decide voice cue" turn. If empirically the deterministic cues land worse than haiku-decided cues on a sample of REVISE retries, fall back to a `picking-revise-cue` fork-skill — still cheaper than the embedded-pipeline status quo.
- **content-manager + discovery-agent stay as agents** in this plan. Plan 3 collapses them into Social Media Manager. Plan 2 just makes that collapse easy by stripping the pipeline prose first.
- **Tool granularity tradeoff.** A 200+ line tool feels heavy compared to existing ~100-line tools. That's fine — the engine pattern allows complex tools (see batch.ts in engine that orchestrates a 5-30 worker plan/spawn/track flow). The alternative (adding a new layer) is worse architecturally.
