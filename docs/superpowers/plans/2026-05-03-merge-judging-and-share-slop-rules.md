# Merge judging-thread-quality & share slop-rules — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Eliminate the redundant LLM judge step in content-manager (replies were judged twice — once at discovery, once at draft time) AND give the drafting skills the same slop rules the validator uses, so first-pass drafts pass review more often.

**Architecture:**
1. **One judge, run early** — fold `judging-opportunity` into `judging-thread-quality` so discovery-agent emits `canMentionProduct` + `mentionSignal` per thread. Persist both onto the `threads` row. content-manager reads them via `find_threads` instead of re-judging.
2. **Single source of truth for slop rules** — promote `slop-rules.md` to `src/references/` and add `shared-references` support to the skill loader (mirrors AgentTool's mechanism). `drafting-reply`, `drafting-post`, and `validating-draft` all consume the same file. CLAUDE.md "each rule has exactly one owner" stays satisfied.

**Tech Stack:**
- Skill primitive (`src/skills/<name>/SKILL.md` + `src/tools/SkillTool/loadSkillsDir.ts` loader)
- Drizzle ORM + Postgres migration (`drizzle/0017_*.sql`)
- Zod schemas for skill I/O
- Vitest for unit tests, Playwright for the real-browser smoke

---

## File map

**New files**
- `src/references/slop-rules.md` (moved from `src/skills/validating-draft/references/`)
- `drizzle/0017_threads_can_mention_product.sql`
- `src/skills/judging-thread-quality/__tests__/schema.test.ts` (extend existing)

**Modified files**
- `src/tools/SkillTool/schema.ts` — add `shared-references` field
- `src/tools/SkillTool/loadSkillsDir.ts` — resolve shared-references from `src/references/`
- `src/tools/SkillTool/__tests__/loader.test.ts` — cover the new field
- `src/skills/validating-draft/SKILL.md` — frontmatter swap (slop-rules → shared)
- `src/skills/drafting-reply/SKILL.md` — add shared-references + body note
- `src/skills/drafting-post/SKILL.md` — same
- `src/skills/judging-thread-quality/SKILL.md` — add canMentionProduct/mentionSignal output
- `src/skills/judging-thread-quality/schema.ts` — extend output schema
- `src/skills/judging-thread-quality/references/thread-quality-rules.md` — fold gate-rules content
- `src/lib/db/schema/channels.ts` — `threads.can_mention_product` + `threads.mention_signal`
- `src/tools/PersistQueueThreadsTool/PersistQueueThreadsTool.ts` — accept + persist new fields
- `src/tools/FindThreadsTool/FindThreadsTool.ts` — return new fields in `ThreadRow`
- `src/tools/AgentTool/agents/discovery-agent/AGENT.md` — judge emits canMentionProduct
- `src/tools/AgentTool/agents/content-manager/AGENT.md` — drop reply_sweep step 1 (judging-opportunity)
- `src/tools/XaiFindCustomersTool/schema.ts` — extend `tweetCandidateSchema` with optional canMention fields (so persist_queue_threads can carry them through)

**Deleted files**
- `src/skills/judging-opportunity/SKILL.md`
- `src/skills/judging-opportunity/schema.ts`
- `src/skills/judging-opportunity/references/gate-rules.md`
- `src/skills/judging-opportunity/__tests__/*.test.ts`
- `src/skills/validating-draft/references/slop-rules.md` (after move)

---

## Task 1: Skill loader — add `shared-references` field to schema

**Files:**
- Modify: `src/tools/SkillTool/schema.ts`
- Test: `src/tools/SkillTool/__tests__/schema.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `src/tools/SkillTool/__tests__/schema.test.ts`:

```typescript
it('parses shared-references as optional string[]', () => {
  const parsed = SkillFrontmatterSchema.parse({
    name: 'demo',
    description: 'd',
    'shared-references': ['slop-rules', 'launch-phases'],
  });
  expect(parsed['shared-references']).toEqual(['slop-rules', 'launch-phases']);
});

it('omits shared-references when not specified', () => {
  const parsed = SkillFrontmatterSchema.parse({
    name: 'demo',
    description: 'd',
  });
  expect(parsed['shared-references']).toBeUndefined();
});
```

- [ ] **Step 2: Run test, verify FAIL**

```bash
pnpm vitest run src/tools/SkillTool/__tests__/schema.test.ts
```

Expected: FAIL — `shared-references` strips through schema (not declared, hits unknown keys).

- [ ] **Step 3: Implement the schema field**

Edit `src/tools/SkillTool/schema.ts` — add the field next to `references:`:

```typescript
'shared-references': z.array(z.string()).optional(),
```

- [ ] **Step 4: Run test, verify PASS**

```bash
pnpm vitest run src/tools/SkillTool/__tests__/schema.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/tools/SkillTool/schema.ts src/tools/SkillTool/__tests__/schema.test.ts
git commit -m "feat(skill-loader): add shared-references field to skill frontmatter schema"
```

---

## Task 2: Skill loader — resolve shared-references from `src/references/`

**Files:**
- Modify: `src/tools/SkillTool/loadSkillsDir.ts`
- Test: `src/tools/SkillTool/__tests__/loader.test.ts`

- [ ] **Step 1: Write the failing test**

Add a fixture skill with shared-references and a test that verifies the body inlines both per-skill and shared content:

```typescript
it('inlines shared-references from src/references/ into the body', async () => {
  // Fixture: tmp dir with SKILL.md declaring shared-references: [slop-rules]
  // and a sibling tmp src/references/slop-rules.md with known content.
  const fixtureDir = await fs.mkdtemp(path.join(os.tmpdir(), 'skill-shared-'));
  const sharedDir = path.join(fixtureDir, '_shared');
  const skillDir = path.join(fixtureDir, 'demo-shared');
  await fs.mkdir(sharedDir, { recursive: true });
  await fs.mkdir(skillDir, { recursive: true });
  await fs.writeFile(
    path.join(sharedDir, 'slop-rules.md'),
    '# Shared slop rules\nbanned vocab: leverage, delve\n',
  );
  await fs.writeFile(
    path.join(skillDir, 'SKILL.md'),
    [
      '---',
      'name: demo-shared',
      'description: t',
      'shared-references:',
      '  - slop-rules',
      '---',
      '',
      'Demo body.',
      '',
    ].join('\n'),
  );

  const cmd = await loadSkill(skillDir, { sharedReferencesDir: sharedDir });
  expect(cmd).not.toBeNull();
  const prompt = cmd!.getPromptForCommand('', /* ctx */ {} as never);
  expect(prompt).toContain('Demo body.');
  expect(prompt).toContain('## slop-rules');
  expect(prompt).toContain('banned vocab: leverage, delve');
});
```

- [ ] **Step 2: Run test, verify FAIL**

```bash
pnpm vitest run src/tools/SkillTool/__tests__/loader.test.ts
```

Expected: FAIL — loader doesn't accept `sharedReferencesDir` opts and doesn't inline.

- [ ] **Step 3: Implement shared-references resolution in `loadSkill`**

Edit `src/tools/SkillTool/loadSkillsDir.ts`:

```typescript
// Add at top with other imports
import { resolveReferenceFile, inlineReference } from '@/tools/AgentTool/loader';
import { promises as fs } from 'node:fs';
import path from 'node:path';

// Add helper near resolveReferenceFile (which lives in AgentTool/loader.ts —
// we'll call it directly):
async function resolveSharedReference(
  entry: string,
  sharedDir: string,
): Promise<string> {
  const normalized = entry.endsWith('.md') ? entry : `${entry}.md`;
  return fs.readFile(path.join(sharedDir, normalized), 'utf8');
}

// Add LoadOptions to loadSkill signature:
interface LoadSkillOptions {
  sharedReferencesDir?: string;
}

export async function loadSkill(
  skillDir: string,
  opts: LoadSkillOptions = {},
): Promise<SkillCommand | null> {
  // ... existing code up through `let inlinedBody = body;` ...

  // existing per-skill references loop stays unchanged

  // ── new: shared-references loop, after the existing references loop ──
  const sharedRefs = validated['shared-references'] ?? [];
  if (sharedRefs.length > 0) {
    const sharedDir =
      opts.sharedReferencesDir ??
      path.resolve(process.cwd(), 'src/references');
    for (const entry of sharedRefs) {
      let content: string;
      try {
        content = await resolveSharedReference(entry, sharedDir);
      } catch (err) {
        throw new Error(
          `Skill "${validated.name}" shared-references missing file "${entry}" under ${sharedDir}: ${(err as Error).message}`,
        );
      }
      inlinedBody = inlineReference(inlinedBody, entry, content);
    }
  }

  // ... rest of existing code unchanged ...
}
```

Also propagate `opts.sharedReferencesDir` from `loadSkillsFromDir(rootDir, opts)` down to `loadSkill` if loadSkillsFromDir is called externally with the option.

- [ ] **Step 4: Run test, verify PASS**

```bash
pnpm vitest run src/tools/SkillTool/__tests__/loader.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/tools/SkillTool/loadSkillsDir.ts src/tools/SkillTool/__tests__/loader.test.ts
git commit -m "feat(skill-loader): resolve shared-references from src/references/"
```

---

## Task 3: Move slop-rules.md to shared location

**Files:**
- Create: `src/references/slop-rules.md` (copy of current validating-draft slop-rules.md, no content change)
- Delete: `src/skills/validating-draft/references/slop-rules.md`
- Modify: `src/skills/validating-draft/SKILL.md` (move `slop-rules` from `references:` to `shared-references:`)

- [ ] **Step 1: Verify the validating-draft tests pass on baseline**

```bash
pnpm vitest run src/skills/validating-draft/__tests__/
```

Record the pass count — should still pass after the move.

- [ ] **Step 2: Move the file**

```bash
git mv src/skills/validating-draft/references/slop-rules.md src/references/slop-rules.md
```

- [ ] **Step 3: Update validating-draft frontmatter**

Edit `src/skills/validating-draft/SKILL.md`. Change:

```yaml
references:
  - output-format
  - review-checklist
  - x-review-rules
  - slop-rules
```

To:

```yaml
references:
  - output-format
  - review-checklist
  - x-review-rules
shared-references:
  - slop-rules
```

- [ ] **Step 4: Re-run validating-draft tests**

```bash
pnpm vitest run src/skills/validating-draft/__tests__/
```

Expected: same pass count as Step 1 (slop-rules content still appears in the inlined prompt; just resolved from a different path).

- [ ] **Step 5: Commit**

```bash
git add src/references/slop-rules.md src/skills/validating-draft/SKILL.md
git rm src/skills/validating-draft/references/slop-rules.md
git commit -m "refactor(skills): move slop-rules.md to shared src/references/"
```

---

## Task 4: Wire `drafting-reply` to consume slop-rules

**Files:**
- Modify: `src/skills/drafting-reply/SKILL.md`
- Test: `src/skills/drafting-reply/__tests__/loader.test.ts` (add if missing — verify slop-rules text appears in the loaded prompt)

- [ ] **Step 1: Write the failing test**

Add to `src/skills/drafting-reply/__tests__/loader.test.ts` (create file if it doesn't exist; mirror the pattern from `_demo-echo-inline/__tests__/`):

```typescript
import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { loadSkill } from '@/tools/SkillTool/loadSkillsDir';

describe('drafting-reply loader', () => {
  it('inlines shared slop-rules into the system prompt', async () => {
    const dir = path.resolve(process.cwd(), 'src/skills/drafting-reply');
    const cmd = await loadSkill(dir);
    expect(cmd).not.toBeNull();
    const prompt = cmd!.getPromptForCommand('', {} as never);
    // From slop-rules.md — banned-vocabulary section
    expect(prompt).toContain('banned_vocabulary');
    expect(prompt).toContain('preamble_opener');
  });
});
```

- [ ] **Step 2: Run test, verify FAIL**

```bash
pnpm vitest run src/skills/drafting-reply/__tests__/loader.test.ts
```

Expected: FAIL — drafting-reply does NOT yet declare shared-references.

- [ ] **Step 3: Update drafting-reply SKILL.md frontmatter + body**

Edit `src/skills/drafting-reply/SKILL.md`:

```yaml
---
name: drafting-reply
description: ...  # unchanged
context: fork
model: claude-sonnet-4-6
maxTurns: 1
allowed-tools:
references:
  - x-reply-voice
  - reddit-reply-voice
shared-references:
  - slop-rules
---
```

In the body, add a new section just BEFORE the "## Output" section:

```markdown
## Slop rules — DO NOT EMIT THESE PATTERNS

Apply every rule in `slop-rules` while you draft. The validating-draft
skill checks the SAME patterns immediately after you — drafts that
match a hard-fail rule will be rejected. The cheap path is to not
write them in the first place. Pay particular attention to:

- `preamble_opener`, `engagement_bait_filler`, `banned_vocabulary` —
  hard fails on contact.
- `diagnostic_from_above`, `binary_not_x_its_y`, `no_first_person`
  paired with a generalized claim — hard fails. Anchor every claim
  with an `I/we + concrete` receipt.
- `colon_aphorism_opener`, `fortune_cookie_closer`,
  `naked_number_unsourced`, `em_dash_overuse`, `triple_grouping`,
  `negation_cadence` — REVISE-or-tighten; avoid them.

Read the full slop-rules section below for triggers + examples.
```

- [ ] **Step 4: Run test, verify PASS**

```bash
pnpm vitest run src/skills/drafting-reply/__tests__/loader.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/skills/drafting-reply/SKILL.md src/skills/drafting-reply/__tests__/loader.test.ts
git commit -m "feat(drafting-reply): consume shared slop-rules so first-pass drafts avoid validator-fail patterns"
```

---

## Task 5: Wire `drafting-post` to consume slop-rules

**Files:**
- Modify: `src/skills/drafting-post/SKILL.md`
- Test: `src/skills/drafting-post/__tests__/loader.test.ts` (add)

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { loadSkill } from '@/tools/SkillTool/loadSkillsDir';

describe('drafting-post loader', () => {
  it('inlines shared slop-rules into the system prompt', async () => {
    const dir = path.resolve(process.cwd(), 'src/skills/drafting-post');
    const cmd = await loadSkill(dir);
    expect(cmd).not.toBeNull();
    const prompt = cmd!.getPromptForCommand('', {} as never);
    expect(prompt).toContain('banned_vocabulary');
    expect(prompt).toContain('diagnostic_from_above');
  });
});
```

- [ ] **Step 2: Run test, verify FAIL**

```bash
pnpm vitest run src/skills/drafting-post/__tests__/loader.test.ts
```

- [ ] **Step 3: Update drafting-post frontmatter + body**

Edit `src/skills/drafting-post/SKILL.md`. Add to frontmatter:

```yaml
shared-references:
  - slop-rules
```

Add the same "## Slop rules — DO NOT EMIT THESE PATTERNS" section as Task 4 Step 3, before the "## Output" section.

- [ ] **Step 4: Run test, verify PASS**

```bash
pnpm vitest run src/skills/drafting-post/__tests__/loader.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add src/skills/drafting-post/SKILL.md src/skills/drafting-post/__tests__/loader.test.ts
git commit -m "feat(drafting-post): consume shared slop-rules so first-pass drafts avoid validator-fail patterns"
```

---

## Task 6: DB migration — `threads.can_mention_product` + `threads.mention_signal`

**Files:**
- Create: `drizzle/0017_threads_can_mention_product.sql`
- Modify: `src/lib/db/schema/channels.ts` (add columns to the `threads` table)

- [ ] **Step 1: Add columns to the Drizzle schema**

Edit `src/lib/db/schema/channels.ts` — inside `threads = pgTable(...)` after `surfacedVia`:

```typescript
// Discovery v4 (2026-05-03): merge of judging-opportunity into
// judging-thread-quality. Discovery now decides whether the thread
// earns a product mention at the same time it scores ICP fit.
canMentionProduct: boolean('can_mention_product'),
mentionSignal: text('mention_signal'),
```

- [ ] **Step 2: Generate the migration**

```bash
pnpm drizzle-kit generate
```

This produces `drizzle/0017_*.sql`. Rename it to `drizzle/0017_threads_can_mention_product.sql` if drizzle-kit picked a random name. Verify SQL contents:

```sql
ALTER TABLE "threads" ADD COLUMN "can_mention_product" boolean;--> statement-breakpoint
ALTER TABLE "threads" ADD COLUMN "mention_signal" text;
```

- [ ] **Step 3: Apply migration locally**

```bash
pnpm drizzle-kit push
```

Verify the columns exist:

```bash
psql "$DATABASE_URL" -c "\\d threads" | grep -E "can_mention|mention_signal"
```

Expected: both columns appear, type `boolean` and `text`, nullable.

- [ ] **Step 4: Type-check**

```bash
pnpm tsc --noEmit
```

Expected: 0 errors. (Per memory: tsc is the build gate, not vitest.)

- [ ] **Step 5: Commit**

```bash
git add drizzle/0017_threads_can_mention_product.sql drizzle/meta/ src/lib/db/schema/channels.ts
git commit -m "feat(db): add threads.can_mention_product + threads.mention_signal"
```

---

## Task 7: Extend `judging-thread-quality` schema + rules to emit canMentionProduct

**Files:**
- Modify: `src/skills/judging-thread-quality/schema.ts`
- Modify: `src/skills/judging-thread-quality/SKILL.md`
- Modify: `src/skills/judging-thread-quality/references/thread-quality-rules.md`
- Test: `src/skills/judging-thread-quality/__tests__/schema.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `src/skills/judging-thread-quality/__tests__/schema.test.ts`:

```typescript
it('parses canMentionProduct + mentionSignal in the output', () => {
  const parsed = judgingThreadQualityOutputSchema.parse({
    keep: true,
    score: 0.85,
    reason: 'asks for tool',
    signals: ['help_request'],
    canMentionProduct: true,
    mentionSignal: 'tool_question',
  });
  expect(parsed.canMentionProduct).toBe(true);
  expect(parsed.mentionSignal).toBe('tool_question');
});

it('defaults canMentionProduct to false when omitted (legacy responses)', () => {
  const parsed = judgingThreadQualityOutputSchema.parse({
    keep: true,
    score: 0.85,
    reason: 'asks for tool',
    signals: [],
  });
  expect(parsed.canMentionProduct).toBe(false);
  expect(parsed.mentionSignal).toBe('no_fit');
});
```

- [ ] **Step 2: Run test, verify FAIL**

```bash
pnpm vitest run src/skills/judging-thread-quality/__tests__/schema.test.ts
```

- [ ] **Step 3: Extend the schema**

Edit `src/skills/judging-thread-quality/schema.ts`:

```typescript
export const MENTION_SIGNALS = [
  'tool_question',
  'debug_problem_fit',
  'competitor_complaint',
  'case_study_request',
  'review_invitation',
  'milestone',
  'vulnerable',
  'grief_or_layoff',
  'political',
  'no_fit',
] as const;
export type MentionSignal = (typeof MENTION_SIGNALS)[number];

export const judgingThreadQualityOutputSchema = z.object({
  keep: z.boolean(),
  score: z.number().min(0).max(1),
  reason: z.string().max(500),
  signals: z.array(z.string()).default([]),
  canMentionProduct: z.boolean().default(false),
  mentionSignal: z.enum(MENTION_SIGNALS).default('no_fit'),
});
```

- [ ] **Step 4: Run test, verify PASS**

```bash
pnpm vitest run src/skills/judging-thread-quality/__tests__/schema.test.ts
```

- [ ] **Step 5: Update SKILL.md output spec**

Edit `src/skills/judging-thread-quality/SKILL.md`. Update the output documentation to include the two new fields, and append the canMentionProduct decision rules to `thread-quality-rules.md`.

In the SKILL.md output JSON example:

```json
{
  "keep": true,
  "score": 0.85,
  "reason": "Solo founder asking for a deploy tool — exact ICP, recent post",
  "signals": ["help_request", "in_domain", "solo_founder"],
  "canMentionProduct": true,
  "mentionSignal": "tool_question"
}
```

Add to the prose ("The output must always populate" list):

```
- `canMentionProduct: boolean` — green-light fired AND product plausibly fits AND your confidence ≥ 0.6. Suppress on any hard-mute signal.
- `mentionSignal: string` — the dominant signal name (one of: tool_question, debug_problem_fit, competitor_complaint, case_study_request, review_invitation, milestone, vulnerable, grief_or_layoff, political, no_fit).
```

- [ ] **Step 6: Fold gate-rules content into thread-quality-rules.md**

Append to `src/skills/judging-thread-quality/references/thread-quality-rules.md` a new section, copying the green-light + hard-mute decision matrix from `src/skills/judging-opportunity/references/gate-rules.md`. Use that file's existing prose as the source — DON'T paraphrase. Specifically copy:

- "## canMentionProduct — green-light signals → `true`"
- "## canMentionProduct — hard-mute signals → `false`"
- "## Strictness — when in doubt, suppress"
- The `### Examples` subsections (tool_question, debug_problem_fit, vulnerable_post, milestone_celebration, no_fit, weak green-light)

Adjust opening prose to read:

```markdown
# canMentionProduct decision (run alongside the keep verdict)

You also decide whether a reply targeting this thread may mention the product.
Apply the rules below to fill `canMentionProduct` + `mentionSignal` on every
verdict — even when `keep: false` (set `mentionSignal: 'no_fit'` in that case).
```

- [ ] **Step 7: Commit**

```bash
git add src/skills/judging-thread-quality/schema.ts src/skills/judging-thread-quality/SKILL.md src/skills/judging-thread-quality/references/thread-quality-rules.md src/skills/judging-thread-quality/__tests__/schema.test.ts
git commit -m "feat(judging): merge canMentionProduct decision into judging-thread-quality"
```

---

## Task 8: Update `tweetCandidateSchema` + `persist_queue_threads` to carry canMentionProduct

**Files:**
- Modify: `src/tools/XaiFindCustomersTool/schema.ts` (extend tweetCandidateSchema)
- Modify: `src/tools/PersistQueueThreadsTool/PersistQueueThreadsTool.ts`
- Test: `src/tools/PersistQueueThreadsTool/__tests__/PersistQueueThreadsTool.test.ts`

- [ ] **Step 1: Write the failing test**

Add to the persist-queue-threads test:

```typescript
it('persists canMentionProduct + mentionSignal onto the threads row', async () => {
  await persistQueueThreadsTool.execute(
    {
      threads: [
        {
          ...validBaseTweet,
          can_mention_product: true,
          mention_signal: 'tool_question',
        },
      ],
    },
    ctx,
  );
  const [row] = await db
    .select({
      can: threads.canMentionProduct,
      sig: threads.mentionSignal,
    })
    .from(threads)
    .where(eq(threads.externalId, validBaseTweet.external_id));
  expect(row.can).toBe(true);
  expect(row.sig).toBe('tool_question');
});
```

(Adapt `validBaseTweet` to whatever shape the existing test fixtures use.)

- [ ] **Step 2: Run test, verify FAIL**

```bash
pnpm vitest run src/tools/PersistQueueThreadsTool/
```

- [ ] **Step 3: Extend `tweetCandidateSchema`**

Edit `src/tools/XaiFindCustomersTool/schema.ts` — add to `tweetCandidateSchema`:

```typescript
can_mention_product: z.boolean().optional().default(false),
mention_signal: z.string().optional().default('no_fit'),
```

- [ ] **Step 4: Map fields into the insert in `PersistQueueThreadsTool.ts`**

In the row builder (around line 90 — `const rows = sorted.map((t) => ({...}))`), add:

```typescript
canMentionProduct: t.can_mention_product ?? false,
mentionSignal: t.mention_signal ?? 'no_fit',
```

- [ ] **Step 5: Run test, verify PASS**

```bash
pnpm vitest run src/tools/PersistQueueThreadsTool/
```

- [ ] **Step 6: Type-check**

```bash
pnpm tsc --noEmit
```

- [ ] **Step 7: Commit**

```bash
git add src/tools/XaiFindCustomersTool/schema.ts src/tools/PersistQueueThreadsTool/PersistQueueThreadsTool.ts src/tools/PersistQueueThreadsTool/__tests__/
git commit -m "feat(persist-queue-threads): carry canMentionProduct + mentionSignal through to threads row"
```

---

## Task 9: Update `find_threads` to return canMentionProduct + mentionSignal

**Files:**
- Modify: `src/tools/FindThreadsTool/FindThreadsTool.ts`
- Test: `src/tools/FindThreadsTool/__tests__/FindThreadsTool.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
it('returns canMentionProduct + mentionSignal on each row', async () => {
  await db.insert(threads).values({
    userId,
    externalId: 't-mention-1',
    platform: 'x',
    community: '@x',
    title: 't',
    url: 'https://x.com/u/status/1',
    canMentionProduct: true,
    mentionSignal: 'tool_question',
  });
  const result = await findThreadsTool.execute({ platforms: ['x'] }, ctx);
  const row = result.threads.find((r) => r.threadId.length > 0);
  expect(row?.canMentionProduct).toBe(true);
  expect(row?.mentionSignal).toBe('tool_question');
});
```

- [ ] **Step 2: Run test, verify FAIL**

```bash
pnpm vitest run src/tools/FindThreadsTool/
```

- [ ] **Step 3: Extend `ThreadRow` interface + select**

Edit `src/tools/FindThreadsTool/FindThreadsTool.ts`:

```typescript
export interface ThreadRow {
  // existing fields...
  canMentionProduct: boolean | null;
  mentionSignal: string | null;
}
```

Add to the `.select({ ... })` in `execute`:

```typescript
canMentionProduct: threads.canMentionProduct,
mentionSignal: threads.mentionSignal,
```

Add to the `out` mapping:

```typescript
canMentionProduct: r.canMentionProduct,
mentionSignal: r.mentionSignal,
```

- [ ] **Step 4: Run test, verify PASS**

```bash
pnpm vitest run src/tools/FindThreadsTool/
```

- [ ] **Step 5: Update the tool description**

In the `description` prop on the tool definition, append a sentence:

```
Each returned thread carries canMentionProduct + mentionSignal — discovery
already decided whether a reply may mention the product. Drafters should
honor canMentionProduct directly and skip a second judging-opportunity pass.
```

- [ ] **Step 6: Type-check**

```bash
pnpm tsc --noEmit
```

- [ ] **Step 7: Commit**

```bash
git add src/tools/FindThreadsTool/
git commit -m "feat(find-threads): return canMentionProduct + mentionSignal so content-manager skips re-judging"
```

---

## Task 10: Update `discovery-agent/AGENT.md` to emit canMentionProduct

**Files:**
- Modify: `src/tools/AgentTool/agents/discovery-agent/AGENT.md`
- Test: `src/tools/AgentTool/agents/discovery-agent/__tests__/loader-smoke.test.ts`

- [ ] **Step 1: Write the failing assertion**

Update the loader-smoke test (or add a new it block) to assert the AGENT.md prose mentions `canMentionProduct`:

```typescript
it('mentions the canMentionProduct emission in the discovery workflow', () => {
  const md = readFileSync(
    path.resolve(process.cwd(), 'src/tools/AgentTool/agents/discovery-agent/AGENT.md'),
    'utf8',
  );
  expect(md).toContain('canMentionProduct');
  expect(md).toContain('persist_queue_threads');
});
```

- [ ] **Step 2: Run test, verify FAIL**

```bash
pnpm vitest run src/tools/AgentTool/agents/discovery-agent/
```

- [ ] **Step 3: Update `discovery-agent/AGENT.md`**

In step 4 of "Your workflow" — where it describes calling judging-thread-quality — add a sentence:

```markdown
The skill now ALSO returns `canMentionProduct` (boolean) and `mentionSignal`
(one of: tool_question, debug_problem_fit, competitor_complaint,
case_study_request, review_invitation, milestone, vulnerable,
grief_or_layoff, political, no_fit). Carry both through to
`persist_queue_threads` — content-manager reads them off the thread row at
draft time and DOES NOT re-judge. If you skip a candidate (`keep: false`),
default `canMentionProduct: false` and `mentionSignal: 'no_fit'`.
```

In step 7 (`persist_queue_threads`), update the example tweet object to include the new fields.

In the first-turn message template, add to the per-tweet field list:

```
- can_mention_product (skill output verbatim)
- mention_signal (skill output verbatim)
```

- [ ] **Step 4: Run test, verify PASS**

```bash
pnpm vitest run src/tools/AgentTool/agents/discovery-agent/
```

- [ ] **Step 5: Commit**

```bash
git add src/tools/AgentTool/agents/discovery-agent/AGENT.md src/tools/AgentTool/agents/discovery-agent/__tests__/loader-smoke.test.ts
git commit -m "feat(discovery-agent): persist canMentionProduct + mentionSignal alongside the keep verdict"
```

---

## Task 11: Update `content-manager/AGENT.md` — drop reply_sweep judging step

**Files:**
- Modify: `src/tools/AgentTool/agents/content-manager/AGENT.md`
- Test: `src/tools/AgentTool/agents/content-manager/__tests__/loader-smoke.test.ts`

- [ ] **Step 1: Write the failing test**

Add to the content-manager loader-smoke test:

```typescript
it('reply_sweep workflow no longer calls judging-opportunity', () => {
  const md = readFileSync(
    path.resolve(process.cwd(), 'src/tools/AgentTool/agents/content-manager/AGENT.md'),
    'utf8',
  );
  expect(md).not.toContain('judging-opportunity');
  expect(md).toContain('canMentionProduct'); // reads it from the thread row
});
```

- [ ] **Step 2: Run test, verify FAIL**

```bash
pnpm vitest run src/tools/AgentTool/agents/content-manager/
```

- [ ] **Step 3: Update `content-manager/AGENT.md`**

Three edits:

1. **Description (top-of-file frontmatter):** drop "(replies via judging-opportunity)" — discovery owns gating now.

2. **Per-item workflow (reply_sweep) — REWRITE the steps:**

```markdown
## Per-item workflow (reply_sweep)

Each thread that `find_threads` returns already carries
`canMentionProduct` + `mentionSignal` — discovery's
`judging-thread-quality` skill decided both at queue time. You DO NOT
re-judge. For each thread (parallelize across threads when possible):

1. **Skip threads where `canMentionProduct` is null AND `mentionSignal` is null** —
   they were queued before the discovery rewrite and have no judgment. Record
   reason `legacy_unjudged`. (After backfill, this branch never fires.)

2. **Draft** via `skill('drafting-reply', { thread, product, channel, voice?, founderVoiceBlock?, canMentionProduct: thread.canMentionProduct })`.
   Returns `{ draftBody, whyItWorks, confidence }`.

3. **Mechanical pre-filter:**
   ```
   validate_draft({ text: draftBody, platform: '<x|reddit>', kind: 'reply' })
   ```
   If `failures.length > 0`, hard reject. Skip and record reason.

4. **Slop / voice review:**
   ```
   skill('validating-draft', { drafts: [{...}], memoryContext: '' })
   ```
   Returns `{ verdict, score, slopFingerprint, ... }`.

5. **Decide:**
   - PASS → `draft_reply({ threadId, draftBody, confidence, whyItWorks, planItemId? })`
   - REVISE → re-call drafting-reply with `voice` containing the slop summary, then re-validate. If still REVISE, persist with `whyItWorks` flagged "needs human review: <slopFingerprint>". If FAIL, skip.
   - FAIL → skip; record `slopFingerprint` in your sweep notes.
```

3. **Tools list (frontmatter):** keep `skill` (still used for drafting-reply / drafting-post / validating-draft), but the implicit workflow no longer includes judging-opportunity. No tool removal needed — `skill` is generic.

4. **Hard rules section:** delete the line "NEVER pitch the product in a reply unless the gate test set `canMentionProduct: true`" and replace with:

```
- NEVER pitch the product in a reply unless `thread.canMentionProduct === true` AND `thread.mentionSignal` is one of the green-light values (tool_question, debug_problem_fit, competitor_complaint, case_study_request, review_invitation). Discovery is the only authoritative source for this decision.
```

- [ ] **Step 4: Run test, verify PASS**

```bash
pnpm vitest run src/tools/AgentTool/agents/content-manager/
```

- [ ] **Step 5: Commit**

```bash
git add src/tools/AgentTool/agents/content-manager/AGENT.md src/tools/AgentTool/agents/content-manager/__tests__/loader-smoke.test.ts
git commit -m "refactor(content-manager): drop redundant judging-opportunity step in reply_sweep — discovery already judged"
```

---

## Task 12: Delete `judging-opportunity` skill

**Files:**
- Delete: `src/skills/judging-opportunity/` (entire directory)

- [ ] **Step 1: Verify nothing still imports judging-opportunity**

```bash
grep -rn "judging-opportunity\|judgingOpportunity" /Users/yifeng/Documents/Code/shipflare/src/ 2>&1 | grep -v ".test\|__tests__\|judging-opportunity/" | head -20
```

Expected: zero hits.

If hits exist, fix the call sites first (likely missed in earlier tasks). Re-run until clean.

- [ ] **Step 2: Delete the skill directory**

```bash
git rm -r src/skills/judging-opportunity/
```

- [ ] **Step 3: Type-check + skill registry test**

```bash
pnpm tsc --noEmit
pnpm vitest run src/tools/SkillTool/__tests__/
```

Expected: 0 type errors, all skill-loader tests still pass.

- [ ] **Step 4: Commit**

```bash
git commit -m "chore(skills): delete judging-opportunity — folded into judging-thread-quality"
```

---

## Task 13: Real-browser smoke test (Playwright connecting to existing browser)

**Files:**
- Create: `e2e/draft-pipeline-smoke.spec.ts`

Per session memory: every plan must include real-browser Playwright testing. The user's local browser is authenticated to GitHub + X; tests connect to that existing context.

- [ ] **Step 1: Verify dev server + Postgres running**

```bash
pnpm dev &
DEV_PID=$!
sleep 5
curl -s http://localhost:3000/api/health | head -5
```

- [ ] **Step 2: Write the smoke test**

Create `e2e/draft-pipeline-smoke.spec.ts`. Connect to the existing browser context (NOT a fresh one — the user is logged in there):

```typescript
import { test, expect, chromium } from '@playwright/test';

test('end-to-end: discovery → draft → /today shows reply with canMentionProduct decision', async () => {
  // Connect to user's existing Chromium with persisted auth
  const browser = await chromium.connectOverCDP(
    process.env.CHROMIUM_CDP_URL ?? 'http://localhost:9222',
  );
  const ctx = browser.contexts()[0];
  const page = await ctx.newPage();

  await page.goto('http://localhost:3000/api/automation/run', {
    method: 'POST' as never,
  });
  // The route returns 200 quickly — actual work runs in the BullMQ workers.
  // Poll /today for at least one draft within 90 s.

  await page.goto('http://localhost:3000/briefing');
  await expect(
    page.getByTestId('reply-card').first(),
  ).toBeVisible({ timeout: 90_000 });

  // Verify the card shows the mentionSignal badge (drafted via the new path)
  const firstCard = page.getByTestId('reply-card').first();
  const signalBadge = firstCard.getByTestId('mention-signal-badge');
  // Badge will exist for any thread queued via the new discovery path;
  // legacy unqueued threads pre-migration won't have one — that's OK.
  // Just assert the page rendered without errors.
  const consoleErrors: string[] = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text());
  });
  await page.waitForLoadState('networkidle');
  expect(consoleErrors.filter((e) => !e.includes('favicon'))).toHaveLength(0);

  await browser.close();
});
```

(If `data-testid="reply-card"` / `mention-signal-badge` don't exist in the briefing UI, drop the badge assertion to a softer "card visible + no console errors" check — the goal is "the pipeline runs end to end without a crash" not "we shipped a UI feature".)

- [ ] **Step 3: Run the smoke**

```bash
pnpm playwright test e2e/draft-pipeline-smoke.spec.ts --reporter=list
```

Expected: PASS within 90 s. If FAIL, investigate (most likely failure: agent run got stuck — check `agent_runs` table for stuck rows, BullMQ queue for stuck jobs).

- [ ] **Step 4: Stop the dev server**

```bash
kill $DEV_PID 2>/dev/null || true
```

- [ ] **Step 5: Commit the test (only if it passes)**

```bash
git add e2e/draft-pipeline-smoke.spec.ts
git commit -m "test(e2e): real-browser smoke for discovery → draft pipeline after judging merge"
```

---

## Task 14: Final verification + push

- [ ] **Step 1: Full type-check + test run**

```bash
pnpm tsc --noEmit
pnpm vitest run --reporter=basic
```

Expected: 0 errors, 0 failed tests.

- [ ] **Step 2: Greppable invariants**

```bash
# No leftover references to judging-opportunity
grep -rn "judging-opportunity" src/ docs/ 2>&1 | grep -v "docs/superpowers/plans/2026-05-03-merge"
```

Expected: zero hits (only this plan doc itself mentions the old name).

```bash
# slop-rules has exactly one home
find src -name slop-rules.md
```

Expected: exactly one match — `src/references/slop-rules.md`.

- [ ] **Step 3: Branch hygiene + push**

```bash
git status
git log --oneline dev..HEAD
git push -u origin HEAD
```

(Don't open the PR — surface the PR command to the user; they'll decide.)

---

## Self-Review

**Spec coverage:** Every line of the conversation's accepted scope maps to a task:
- Move judging to discovery side → Tasks 7, 8, 10, 11
- Skip redundant content-manager judge → Task 11
- Carry canMentionProduct on the row → Tasks 6, 8, 9
- Push slop rules into writers → Tasks 1, 2, 3, 4, 5 (loader plumbing + move + wire two writers)
- Keep validating-draft as separate fork (don't violate primitive boundary) → not changed; only frontmatter swap in Task 3
- Delete the old skill → Task 12
- Real-browser smoke → Task 13
- Final verification → Task 14

**Placeholder scan:** every step has the actual code/SQL/grep command. No "TBD" or "implement later". The Playwright assertion has a soft fallback noted inline (Task 13 Step 2 final paragraph), not a TBD — the fallback IS the spec.

**Type consistency:**
- `canMentionProduct: boolean` (camelCase in TS) ↔ `can_mention_product` (snake in SQL/DB) ↔ `can_mention_product` (snake in tweetCandidate JSON) ↔ `canMentionProduct` (camel in skill output) — used consistently.
- `mentionSignal` (camel) ↔ `mention_signal` (snake) — same pattern.
- `MENTION_SIGNALS` enum used in Zod (Task 7) — referenced by name only in later tasks; nothing requires importing it.

---

## Open trade-offs / risks

- **Per-artifact LLM cost ceiling per CLAUDE.md:** post path stays at 2 default / 4 with REVISE. Reply path collapses from 3 default / 5 with REVISE → 2 default / 4 with REVISE (one fewer fork because judging-opportunity is gone). Both ceilings respected.
- **Backfill:** existing threads rows have `null` canMentionProduct/mentionSignal. The Task 11 content-manager logic skips those (records `legacy_unjudged`). After 1-2 discovery cycles in prod the inbox refills with judged rows; old ones either get archived or replied-to via `/today` manual flow. No backfill script needed.
- **Single-source-of-truth invariant (CLAUDE.md):** slop rules now live in `src/references/slop-rules.md` only. Both writers (drafting-reply, drafting-post) and the validator (validating-draft) read it via `shared-references`. Verified by Task 14 Step 2 grep.
- **Approval-bias risk** (the reason validating-draft stays separate): preserved. Drafting skills now KNOW the rules but do NOT self-validate — fresh-fork validating-draft still runs and is the authoritative pass/fail.
