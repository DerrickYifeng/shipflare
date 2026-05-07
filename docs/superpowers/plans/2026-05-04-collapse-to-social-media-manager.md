# Collapse to Social Media Manager Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Merge the three current marketing-side specialist agents (`content-manager`, `content-planner`, `discovery-agent`) into ONE agent named **`social-media-manager`** — the real industry job title for someone who owns X (and later Reddit/LinkedIn/HN/Discord) end-to-end. Update DB seed, all spawn callers, UI accents, and landing page copy.

**Architecture:**
1. **One specialist agent** with the real industry title. AGENT.md = role + tool inventory + patterns + concrete examples (engine-aligned style — see memory `feedback_engine_primitives_no_orchestrator`). NOT prescriptive "Mode: X → Steps" prose.
2. **Pipelines live inside Tools** (Plan 2). The new agent's tool list includes `process_replies_batch`, `process_posts_batch`, `find_threads_via_xai` — three Tools that own their pipelines internally. Agent does no scripting.
3. **CMO (`coordinator`) absorbs `content-planner`'s strategic-path / plan-item generation** — that work is genuinely chief-of-staff work, not a separate specialist's job at solo-founder scale.
4. **Per-platform reference files** (`x-voice-direction.md`, `reddit-voice-direction.md`, etc.) are loaded conditionally based on the `channel` argument inside drafting-reply / drafting-post — already in place. No new abstraction needed.
5. **DB migration renames `team_members.agent_type` rows** from `content-manager` → `social-media-manager`, deletes `content-planner` + `discovery-agent` rows. Idempotent — re-running the migration on already-migrated rows is a no-op.
6. **Landing page copy refresh** — replace `"SOCIAL"` / `"CONTENT"` shorthand with real titles (`"Social Media Manager"` / `"Content Marketing Manager"` etc.), per the agent-roster-roadmap doc.

**Tech Stack:**
- Drizzle migration (`drizzle/0018_*.sql`)
- AGENT.md filesystem renames + git mv
- React component edits for landing page + roster UI
- Vitest for unit tests, Playwright for the smoke

**Depends on:**
- Plan 1 (canMentionProduct on threads + shared slop-rules) — must be merged first
- Plan 2 (pipeline → orchestrators) — collapsing AGENT.md prose is much safer once pipeline is in TS

---

## File map

**Created**
- `src/tools/AgentTool/agents/social-media-manager/AGENT.md`
- `src/tools/AgentTool/agents/social-media-manager/schema.ts`
- `src/tools/AgentTool/agents/social-media-manager/references/patterns-and-examples.md`
- `src/tools/AgentTool/agents/social-media-manager/__tests__/loader-smoke.test.ts`
- `drizzle/0018_rename_agent_types.sql`

**Modified**
- `src/tools/AgentTool/agent-schemas.ts` (replace `'content-manager'` / `'content-planner'` / `'discovery-agent'` keys with `'social-media-manager'`)
- `src/tools/AgentTool/agents/coordinator/AGENT.md` (4 places — update `subagent_type` strings to `social-media-manager`; remove the daily-playbook discovery-then-content-manager two-step in favor of one spawn)
- `src/tools/AgentTool/agents/coordinator/references/decision-examples.md`
- `src/tools/AgentTool/agents/coordinator/references/when-to-handle-directly.md`
- `src/lib/team-presets.ts` (type union, displayNames, role mapping)
- `src/lib/team-provisioner.ts` (seed roster, ensureTeamExists)
- `src/components/onboarding/_shared/synthetic-chat-conversation.tsx` (`agentType = 'content-planner'` → `'social-media-manager'`, OR rewrite onboarding chat to be coordinator-led)
- `src/components/marketing/how-it-works.tsx` (landing page agent grid — real titles)
- `src/components/marketing/hero-demo.tsx` (`AGENT_ROLES` array — real titles)
- `src/app/(app)/team/[memberId]/page.tsx` (case map for member page)
- `src/app/(app)/team/_components/agent-accent.ts` (drop `content-planner` + `community-manager` legacy comment, add `social-media-manager`)
- `src/app/(app)/team/_components/conversation-reducer.ts` (rename references in comments)
- `src/app/(app)/team/_components/conversation-reducer.test.ts` (update fixtures)
- `src/workers/processors/agent-run.ts` (any string switch on agentDefName)
- `src/workers/processors/plan-execute-sweeper.ts` (the `findContentManagerMember` lookup → `findSocialMediaManagerMember` — but this entire path is gone after Plan 2 Task 9, so just verify it's removed)
- `src/lib/team/dispatch-lead-message.ts` (if any references)
- `src/lib/team/spawn-member-agent-run.ts` (if any references)
- `CLAUDE.md` (update "Phase J unified content-manager handles reply_sweep + post_batch" line and any other agent references)
- `docs/agent-roster-roadmap.md` (mark Plan 3 done; flip Tier 1 to ✅)

**Deleted**
- `src/tools/AgentTool/agents/content-manager/` (entire dir)
- `src/tools/AgentTool/agents/content-planner/` (entire dir)
- `src/tools/AgentTool/agents/discovery-agent/` (entire dir)

---

## Task 1: DB migration to rename `team_members.agent_type` rows

**Files:**
- Create: `drizzle/0018_rename_agent_types.sql`

The agent_type column is text — no FK / no enum on Postgres side, so this is a simple UPDATE + DELETE. Idempotent because the WHERE clauses filter by old name.

- [ ] **Step 1: Inspect current state in dev DB**

```bash
psql "$DATABASE_URL" -c "SELECT agent_type, count(*) FROM team_members GROUP BY agent_type;"
```

Record counts so the migration can be verified after.

- [ ] **Step 2: Write the migration**

Create `drizzle/0018_rename_agent_types.sql`:

```sql
-- Plan 3: collapse content-manager + content-planner + discovery-agent
-- into one social-media-manager agent.
--
-- Order matters:
--  1. Rename content-manager rows in place (preserves member id, conversation
--     history, and any FK references from agent_runs / team_messages).
--  2. Delete content-planner rows (their work is absorbed by the coordinator).
--  3. Delete discovery-agent rows (their work is absorbed by the social-media-manager
--     via find_threads_via_xai).
--
-- All three are idempotent — WHERE clauses filter by old name only.

UPDATE "team_members"
SET agent_type = 'social-media-manager',
    display_name = 'Social Media Manager',
    updated_at = now()
WHERE agent_type = 'content-manager';
--> statement-breakpoint

DELETE FROM "team_members" WHERE agent_type = 'content-planner';
--> statement-breakpoint

DELETE FROM "team_members" WHERE agent_type = 'discovery-agent';
```

Note: `team_messages` and `agent_runs` reference `team_members.id`, not `agent_type`. The rename preserves IDs, so those FKs remain valid. The DELETEs cascade per existing FK config (verify before merging).

- [ ] **Step 3: Verify FK cascade behavior**

```bash
psql "$DATABASE_URL" -c "\\d team_messages" | grep -i "team_members\|REFERENCES"
psql "$DATABASE_URL" -c "\\d agent_runs" | grep -i "team_members\|REFERENCES"
```

Expected: `team_messages.from_agent_id` and `team_messages.to_agent_id` reference `team_members.id` with ON DELETE CASCADE (or SET NULL). `agent_runs.member_id` similar. If they're RESTRICT, this migration will fail on rows with active runs / messages — in that case the migration must first reassign or null those FKs. **Run the dev DB check before locking the SQL above.**

- [ ] **Step 4: Apply locally**

```bash
pnpm drizzle-kit push
psql "$DATABASE_URL" -c "SELECT agent_type, count(*) FROM team_members GROUP BY agent_type;"
```

Expected: only `coordinator` and `social-media-manager` rows remain (assuming Plan 1/2 already ran and no other agents were seeded).

- [ ] **Step 5: Commit**

```bash
git add drizzle/0018_rename_agent_types.sql drizzle/meta/
git commit -m "feat(db): rename content-manager → social-media-manager, remove content-planner + discovery-agent rows"
```

---

## Task 2: Create `social-media-manager` agent dir

**Files:**
- Create: `src/tools/AgentTool/agents/social-media-manager/AGENT.md`
- Create: `src/tools/AgentTool/agents/social-media-manager/schema.ts`
- Create: `src/tools/AgentTool/agents/social-media-manager/__tests__/loader-smoke.test.ts`

- [ ] **Step 1: Write the failing loader-smoke test**

```typescript
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { loadAgentFromFile } from '@/tools/AgentTool/loader';

describe('social-media-manager loader smoke', () => {
  it('loads with the real industry title in the description', async () => {
    const dir = path.resolve(
      process.cwd(),
      'src/tools/AgentTool/agents/social-media-manager',
    );
    const def = await loadAgentFromFile(path.join(dir, 'AGENT.md'));
    expect(def.name).toBe('social-media-manager');
    expect(def.description).toContain('social');
    expect(def.tools).toContain('process_replies_batch');
    expect(def.tools).toContain('process_posts_batch');
    expect(def.tools).toContain('find_threads_via_xai');
    expect(def.tools).toContain('find_threads');
    expect(def.role).toBe('member');
  });

  it('AGENT.md is thin (under 100 lines after frontmatter)', () => {
    const md = readFileSync(
      path.resolve(
        process.cwd(),
        'src/tools/AgentTool/agents/social-media-manager/AGENT.md',
      ),
      'utf8',
    );
    const bodyLines = md.split('---').slice(2).join('---').split('\n').length;
    expect(bodyLines).toBeLessThan(100);
  });

  it('does NOT embed pipeline prose or prescriptive Mode-style scripts', () => {
    const md = readFileSync(
      path.resolve(
        process.cwd(),
        'src/tools/AgentTool/agents/social-media-manager/AGENT.md',
      ),
      'utf8',
    );
    // Per memory feedback_engine_primitives_no_orchestrator: AGENT.md is
    // role + tools + patterns + examples, not numbered scripts or "Mode: X" prose.
    expect(md).not.toMatch(/Per-item workflow/);
    expect(md).not.toMatch(/^Mode:/m);
    expect(md).not.toMatch(/Steps:\s*\n1\./m);
    expect(md).not.toMatch(/1\.\s+\*\*Judge\*\*/);
  });

  it('uses pattern-with-example style (engine-aligned)', () => {
    const md = readFileSync(
      path.resolve(
        process.cwd(),
        'src/tools/AgentTool/agents/social-media-manager/references/patterns-and-examples.md',
      ),
      'utf8',
    );
    // Patterns introduced by "### Pattern:" or similar header
    expect(md).toMatch(/###\s+Pattern:/);
    // At least one concrete tool-call example shown as "You: ... tool_name({...})"
    expect(md).toMatch(/You:\s+\S+/);
  });
});
```

- [ ] **Step 2: Run test, verify FAIL** (dir doesn't exist)

```bash
pnpm vitest run src/tools/AgentTool/agents/social-media-manager/
```

- [ ] **Step 3: Create AGENT.md (engine-aligned style)**

The AGENT.md is identity + tool inventory + reference pointer to patterns + output spec. The actual workflow patterns live in `references/patterns-and-examples.md` and follow the **pattern + concrete example with tool calls** structure (mirroring engine's `coordinator/AGENT.md` and `engine/coordinator/coordinatorMode.ts`).

```markdown
---
name: social-media-manager
description: Social Media Manager — owns the founder's presence on X (and Reddit / LinkedIn / HN / Discord as channels expand). Finds threads worth engaging with, drafts replies, drafts + schedules original posts. Maintains brand voice across all channels.
role: member
model: claude-sonnet-4-6
maxTurns: 20
tools:
  - find_threads_via_xai
  - find_threads
  - process_replies_batch
  - process_posts_batch
  - query_plan_items
  - query_product_context
  - read_memory
  - SendMessage
  - StructuredOutput
shared-references:
  - base-guidelines
references:
  - patterns-and-examples
---

# Social Media Manager for {productName}

You own {productName}'s voice on every social channel. The CMO sets strategy; you execute. You're the brand's presence — the consistency between a post going out and a reply going to a stranger comes from you reading both as one person.

## Context auto-injected at runtime

- Product: {productName} — {productDescription}
- Phase: {currentPhase}
- Channels connected: {channels}
- Plan items this week: {itemCount}

## Your tools

- `find_threads_via_xai({ trigger, intent?, maxResults? })` — conversational discovery loop + per-candidate judging + persistence. Returns `{ queued, scanned, scoutNotes, costUsd, topQueued }`.
- `process_replies_batch({ threadIds, voice?, founderVoiceBlock? })` — full pipeline for N threads (draft → validate → persist with REVISE retry). Returns `{ itemsScanned, draftsCreated, draftsSkipped, notes }`.
- `process_posts_batch({ planItemIds })` — full pipeline for N plan_items. Same return shape.
- `find_threads({ platforms, limit })` — read inbox without scanning.
- `query_plan_items` / `query_product_context` / `read_memory` — read context.

The three batch / loop tools own their pipelines internally. You **do not** script "step 1, step 2, step 3" — pick the right tool, pass the input, summarize the result for the founder.

## Patterns

See the `patterns-and-examples` reference for concrete patterns with example tool-call sequences — discovery + reply slot fill, ad-hoc thread list, post batch, open scan.

## Hard rules

- NEVER write reply / post bodies in your own LLM turn — always use the batch tools.
- The tools enforce: discovery's canMentionProduct decision, validate_draft mechanical checks, validating-draft slop review, REVISE retry with deterministic voice cue. Do NOT script these.
- Founder messages routed to you (via SendMessage from CMO) are conversational — answer in plain prose; use the batch tools when work is needed; otherwise just chat back.

## Output

```ts
StructuredOutput({
  status: 'completed' | 'partial' | 'failed',
  threadsScanned: number,
  draftsCreated: number,
  draftsSkipped: number,
  notes: string,
})
```
```

- [ ] **Step 4: Create the patterns-and-examples reference (engine-aligned style)**

`src/tools/AgentTool/agents/social-media-manager/references/patterns-and-examples.md`:

Notice the format: each pattern is **named**, then a **concrete example** showing the LLM's reasoning + tool calls + summary back to the founder. NO numbered "Steps:" prose. NO "Mode: X" prescriptive headers. The agent reads the example and adapts to the situation it sees, the same way engine's `coordinator/AGENT.md` teaches via concrete `Task({...})` examples.

```markdown
# Patterns and examples

Concrete examples showing how to combine your tools for common situations. The CMO will name the situation in the spawn prompt; pick the closest pattern, adapt as needed. **You are not required to follow these step-by-step** — they show the *kind* of move, not a recipe.

### Pattern: discover threads, then fill a reply slot

The CMO has a `content_reply` plan_item that needs threads sourced and replies drafted. You over-fetch via discovery (so the judging filter has room to be picky), then pass the top picks to the batch reply tool.

You: I'll source threads first, then draft replies for the strongest 3.

  find_threads_via_xai({ trigger: 'daily', maxResults: 6 })
  → { queued: 5, scanned: 14, topQueued: [{threadId, url, ...} × 5], scoutNotes: 'tightened bio filter; competitor accounts dropped' }

  process_replies_batch({ threadIds: ['t-a', 't-b', 't-c'] })
  → { itemsScanned: 3, draftsCreated: 3, draftsSkipped: 0, notes: 'no slop patterns matched' }

You (StructuredOutput): Sourced 5 threads, drafted replies for 3. All in /briefing for review.

### Pattern: thread list already provided

The founder DM'd a thread URL through the CMO, OR the coordinator's daily playbook handed you topQueued from a prior discovery. No discovery needed — straight to drafting.

You: process_replies_batch({ threadIds: ['t-x'] })
  → { draftsCreated: 1 }

You: Drafted 1 reply for the @founder thread; in /briefing for review.

### Pattern: scheduled posts (post batch)

The sweeper or coordinator handed you plan_item IDs that hit their `scheduledAt`. Just run the batch tool — the tool persists drafts and flips state to `drafted` itself.

You: process_posts_batch({ planItemIds: ['p1', 'p2', 'p3', 'p4', 'p5'] })
  → { draftsCreated: 5, draftsSkipped: 0 }

You: Drafted 5 posts for this week. They'll appear in /today scheduled for their respective dates.

### Pattern: open scan (no input — fallback when no slot exists)

Coordinator's daily playbook hit the fallback branch (no `content_reply` plan_items today). Pull top inbox threads and draft for what's there.

You: find_threads({ platforms: ['x', 'reddit'], limit: 3 })
  → 3 thread rows

  process_replies_batch({ threadIds: ['t-a', 't-b', 't-c'] })
  → { draftsCreated: 2, draftsSkipped: 1, notes: 'one fortune_cookie_closer' }

You: Pulled 3 inbox threads, drafted 2 replies (1 skipped on slop pattern).

### Pattern: founder asks a question via the CMO

Sometimes the spawn prompt isn't a work order — it's a question the CMO routed to you because it's about voice or community ("does this draft sound like our voice?", "should we engage with @x's post?"). Answer in plain prose. Don't run a tool unless the question requires drafting work.

You: That account's been promoting their own SaaS in every comment thread for the last week — not a fit for our voice. Recommend we skip and look for active product builders instead. Want me to run a discovery pass with a different intent?

## Slop discipline (non-negotiable)

Every reply / post the batch tools produce is gated by `validating-draft` (LLM slop review) AFTER the writer's own `slop-rules` shared reference primes them. You do NOT need to second-guess the verdicts. If a draft slips through with `[needs human review: <slopFingerprint>]` in `whyItWorks`, surface that in your StructuredOutput's `notes` so the founder knows to review more carefully.

## Channel discipline

The batch tools read `channel` (x | reddit | linkedin | etc.) from the thread / plan_item row. You don't need to set it. If the spawn prompt asks you to change channel ("repost this on LinkedIn"), update the source row first via the appropriate tool — don't try to override on the call.
```

- [ ] **Step 5: Create schema.ts**

Mirror the existing content-manager `schema.ts` shape; the StructuredOutput schema is the same.

```typescript
import { z } from 'zod';

export const socialMediaManagerOutputSchema = z.object({
  status: z.enum(['completed', 'partial', 'failed']),
  threadsScanned: z.number().int().min(0).default(0),
  draftsCreated: z.number().int().min(0),
  draftsSkipped: z.number().int().min(0),
  notes: z.string().max(2000),
});

export type SocialMediaManagerOutput = z.infer<typeof socialMediaManagerOutputSchema>;
```

- [ ] **Step 6: Run tests, verify PASS**

```bash
pnpm vitest run src/tools/AgentTool/agents/social-media-manager/
```

- [ ] **Step 7: Commit**

```bash
git add src/tools/AgentTool/agents/social-media-manager/
git commit -m "feat(agents): add social-media-manager — real-title successor to content-manager + discovery-agent + content-planner"
```

---

## Task 3: Register schema, update agent-schemas.ts

**Files:**
- Modify: `src/tools/AgentTool/agent-schemas.ts`

- [ ] **Step 1: Update the schema map**

Open `src/tools/AgentTool/agent-schemas.ts`. Currently:

```typescript
export const agentOutputSchemas = {
  'coordinator': coordinatorOutputSchema as ZodType<unknown>,
  'content-planner': contentPlannerOutputSchema as ZodType<unknown>,
  'content-manager': contentManagerOutputSchema as ZodType<unknown>,
  'discovery-agent': discoveryAgentOutputSchema as ZodType<unknown>,
};
```

Replace with:

```typescript
import { socialMediaManagerOutputSchema } from './agents/social-media-manager/schema';

export const agentOutputSchemas = {
  'coordinator': coordinatorOutputSchema as ZodType<unknown>,
  'social-media-manager': socialMediaManagerOutputSchema as ZodType<unknown>,
};
```

Drop the obsolete imports (`contentPlannerOutputSchema`, `contentManagerOutputSchema`, `discoveryAgentOutputSchema`). Keep them only if they're still referenced from another module — grep first.

```bash
grep -rn "contentPlannerOutputSchema\|contentManagerOutputSchema\|discoveryAgentOutputSchema" src/
```

If any non-test refs remain, address them before continuing.

- [ ] **Step 2: Type-check**

```bash
pnpm tsc --noEmit
```

Expected: type errors in the spawn callers (Tasks 4-5 will fix).

- [ ] **Step 3: Commit (with the next task's edits — atomic)**

Defer the commit until Task 4-5 fixes the spawn callers. This task is part of the same logical change.

---

## Task 4: Update coordinator AGENT.md spawn references

**Files:**
- Modify: `src/tools/AgentTool/agents/coordinator/AGENT.md`
- Modify: `src/tools/AgentTool/agents/coordinator/references/decision-examples.md`
- Modify: `src/tools/AgentTool/agents/coordinator/references/when-to-handle-directly.md`

Currently 4 places hardcode `subagent_type: 'content-planner' | 'content-manager' | 'discovery-agent'`. After this task, only `'social-media-manager'` (and the coordinator's own direct tool calls).

- [ ] **Step 1: Find every reference**

```bash
grep -n "subagent_type:.*'\(content-planner\|content-manager\|discovery-agent\)'" src/tools/AgentTool/agents/coordinator/
```

- [ ] **Step 2: Update the daily playbook**

In `coordinator/AGENT.md`, the daily playbook currently does:
1. `Task({ subagent_type: 'discovery-agent', ... })` — find threads
2. wait for result
3. `Task({ subagent_type: 'content-manager', prompt: 'serialize topQueued' })` — draft replies

After Plan 3, this collapses to ONE spawn:

```typescript
Task({
  subagent_type: 'social-media-manager',
  description: 'fill reply slot <planItemId>',
  prompt: `Mode: discover-and-fill-slot
planItemId: <uuid>
targetCount: <slot.targetCount>`,
})
```

The social-media-manager handles BOTH steps internally — its `patterns-and-examples` reference shows the discover-then-fill-slot pattern. Update prose accordingly.

- [ ] **Step 3: Update content-planner spawn references**

Currently the coordinator might spawn `content-planner` for strategic-path generation or weekly replanning. After Plan 3 the coordinator does this work directly via `generate_strategic_path` + `add_plan_item` tools — those are already in the coordinator's tool list. Drop the spawn examples and document the direct-tool path inline.

Search the coordinator's references and update similarly:

```bash
grep -n "content-planner" src/tools/AgentTool/agents/coordinator/references/
```

For each match, decide: rewrite as a direct tool call, or remove the example entirely if the section was demonstrating something else.

- [ ] **Step 4: Update tool list comments**

In `coordinator/AGENT.md`, the line "those are owned by the specialists (content-manager, discovery-agent)" → "owned by the social-media-manager".

- [ ] **Step 5: Run loader-smoke for coordinator**

```bash
pnpm vitest run src/tools/AgentTool/agents/coordinator/
```

Expected: existing tests pass. If a test asserts spawn examples mention old names, update the assertion.

- [ ] **Step 6: Commit (with Tasks 3 + 5 — atomic spawn rename)**

Defer the actual `git commit` until Task 5 finishes too.

---

## Task 5: Update remaining source-code references

**Files:**
- Modify: `src/lib/team-presets.ts`
- Modify: `src/lib/team-provisioner.ts`
- Modify: `src/components/onboarding/_shared/synthetic-chat-conversation.tsx`
- Modify: `src/lib/team/system-prompt-context.ts` (cosmetic comments)
- Modify: `src/workers/processors/agent-run.ts` (any agentDefName switch)
- Modify: `src/workers/processors/plan-execute-sweeper.ts` (rename `findContentManagerMember` → `findSocialMediaManagerMember`, OR delete if Plan 2 Task 9 already removed the spawn path)

- [ ] **Step 1: Update team-presets.ts**

Currently:

```typescript
export type WriterAgentType = 'content-manager';
export type PlannerAgentType = 'content-planner';
export type DiscoveryAgentType = 'discovery-agent';
```

Replace with:

```typescript
export type SocialAgentType = 'social-media-manager';
```

Update `displayNames` map and `getTeamCompositionForPreset` accordingly.

- [ ] **Step 2: Update team-provisioner.ts**

Update `ensureTeamExists` so the seed roster contains only `coordinator` and `social-media-manager`. Drop the `content-planner` / `content-manager` / `discovery-agent` lines.

- [ ] **Step 3: Update onboarding synthetic chat**

`src/components/onboarding/_shared/synthetic-chat-conversation.tsx` has `const agentType = 'content-planner'`. Either:
- (a) Replace with `'social-media-manager'` if the chat semantically maps to that role (probably YES — the synthetic chat is the user "chatting with their marketing team"; social-media-manager is the natural new owner).
- (b) Or rewrite the synthetic chat to be coordinator-led if that's a better fit.

Pick (a) and update.

- [ ] **Step 4: Update agent-run worker**

```bash
grep -n "content-manager\|content-planner\|discovery-agent" src/workers/processors/agent-run.ts
```

Update any agentDefName-based switches.

- [ ] **Step 5: Update sweeper**

`src/workers/processors/plan-execute-sweeper.ts` has `findContentManagerMember`. After Plan 2 Task 9, the orchestrator path doesn't spawn an agent_run, so this lookup may already be removed. Verify:

```bash
grep -n "findContentManagerMember\|content-manager" src/workers/processors/plan-execute-sweeper.ts
```

If lines remain (e.g. for ad-hoc spawns from `dispatchOneUserBatch` legacy fallback), either rename to `findSocialMediaManagerMember` or remove the dead path.

- [ ] **Step 6: Type-check**

```bash
pnpm tsc --noEmit
```

Expected: 0 errors.

- [ ] **Step 7: Run all tests**

```bash
pnpm vitest run --reporter=basic
```

Expected: tests that referenced old agent type strings need updating. Update them inline (snapshots, fixtures).

- [ ] **Step 8: Commit (atomic with Tasks 3 + 4)**

```bash
git add src/tools/AgentTool/agent-schemas.ts \
        src/tools/AgentTool/agents/coordinator/ \
        src/lib/team-presets.ts src/lib/team-provisioner.ts \
        src/components/onboarding/_shared/synthetic-chat-conversation.tsx \
        src/workers/processors/agent-run.ts \
        src/workers/processors/plan-execute-sweeper.ts \
        src/lib/team/system-prompt-context.ts
git commit -m "refactor(agents): rewire all spawn callers and seed paths to social-media-manager"
```

---

## Task 6: UI accent + member page

**Files:**
- Modify: `src/app/(app)/team/_components/agent-accent.ts`
- Modify: `src/app/(app)/team/[memberId]/page.tsx`
- Modify: `src/app/(app)/team/_components/conversation-reducer.ts`

- [ ] **Step 1: Update agent-accent.ts**

The current map has `'content-planner': CONTENT` and `'content-manager': COMMUNITY`. Replace with:

```typescript
'social-media-manager': COMMUNITY, // was content-manager — keeps the same color identity for migrated members
```

Drop `'content-planner'` and any vestigial `'community-manager'` / `'post-writer'` entries.

- [ ] **Step 2: Update [memberId]/page.tsx**

The case map currently has `'content-planner':` returning a description. Replace with the `social-media-manager` case carrying the new title and description.

```typescript
'social-media-manager': {
  title: 'Social Media Manager',
  description: 'Owns the founder\'s presence on X (and Reddit / LinkedIn / HN / Discord as they connect). Finds threads, drafts replies, drafts + schedules original posts.',
},
```

- [ ] **Step 3: Update conversation-reducer.ts**

The comment references "content-planner" as the example agent type. Update to "social-media-manager".

- [ ] **Step 4: Update the existing test**

`src/app/(app)/team/_components/__tests__/conversation-reducer.test.ts` — update fixtures to use `social-media-manager`.

- [ ] **Step 5: Run UI tests**

```bash
pnpm vitest run src/app/\(app\)/team/
```

- [ ] **Step 6: Real-browser check**

```bash
pnpm dev &
DEV_PID=$!
sleep 5
# Navigate to /team in browser; verify roster shows "Social Media Manager" instead of three separate cards
kill $DEV_PID
```

(Manual; smoke test in Task 9 will automate.)

- [ ] **Step 7: Commit**

```bash
git add src/app/\(app\)/team/
git commit -m "feat(ui): team roster shows Social Media Manager — accents and member detail page updated"
```

---

## Task 7: Landing page copy refresh

**Files:**
- Modify: `src/components/marketing/how-it-works.tsx`
- Modify: `src/components/marketing/hero-demo.tsx`

Per `docs/agent-roster-roadmap.md` "Landing page 命名翻新" — replace shorthand all-caps tags with real industry titles.

- [ ] **Step 1: Update how-it-works.tsx AGENTS array**

Current:

```typescript
const AGENTS: AgentEntry[] = [
  { name: 'CMO', role: 'Strategy & coordination', detail: 'plans · briefs · approvals · weekly review', live: true },
  { name: 'SOCIAL', role: 'Cadence & community', detail: 'x · linkedin · reddit · hn · discord', live: true },
  { name: 'SEARCH', role: 'SEO + GEO unified', detail: 'keywords · on-page · llms.txt · citations' },
  { name: 'PERFORMANCE', role: 'Paid media', detail: 'meta · google · tiktok · x · reddit ads' },
  { name: 'CONTENT', role: 'Long-form & lifecycle', detail: 'blogs · newsletters · changelogs · copy' },
  { name: 'ANALYTICS', role: 'Funnel & attribution', detail: 'posthog · stripe · ga4 · experiments' },
];
```

Replace with the canonical titles from `docs/agent-roster-roadmap.md`:

```typescript
const AGENTS: AgentEntry[] = [
  { name: 'Chief Marketing Officer', role: 'Strategy & coordination', detail: 'plans · briefs · approvals · weekly review', live: true },
  { name: 'Social Media Manager', role: 'Cadence & community', detail: 'x · linkedin · reddit · hn · discord', live: true },
  { name: 'SEO Manager', role: 'Organic search + GEO', detail: 'keywords · on-page · llms.txt · citations' },
  { name: 'Performance Marketing Manager', role: 'Paid media', detail: 'meta · google · tiktok · x · reddit ads' },
  { name: 'Content Marketing Manager', role: 'Long-form & lifecycle', detail: 'blogs · newsletters · changelogs · copy' },
  { name: 'Marketing Analytics Manager', role: 'Funnel & attribution', detail: 'posthog · stripe · ga4 · experiments' },
];
```

The grid layout already uses `name` as the card title and shows it in `font-weight: 600`. The change is purely string content. The numeric prefix (`01 · CMO`) is generated from index — verify it still reads cleanly with the longer name.

If the layout breaks on the longer titles, also bump the grid `minmax(240px, 1fr)` to `minmax(280px, 1fr)`.

- [ ] **Step 2: Update hero-demo.tsx AGENT_ROLES**

```typescript
const AGENT_ROLES = [
  'Chief Marketing Officer',
  'Social Media Manager',
  'SEO Manager',
  'Performance Marketing Manager',
  'Content Marketing Manager',
  'Marketing Analytics Manager',
] as const;
```

The hero "role strip" likely uses these as small text — verify it still fits at narrow viewports (mobile 320px).

- [ ] **Step 3: Update headline copy if needed**

`how-it-works.tsx` has `"Six agents. One marketing org."` — keep this; it's still accurate.

- [ ] **Step 4: Real-browser check**

```bash
pnpm dev &
DEV_PID=$!
sleep 5
# Navigate to / in browser; verify the agent grid shows real titles, layout intact
kill $DEV_PID
```

- [ ] **Step 5: Update existing live-smoke test if it asserts text**

```bash
grep -rn "'CMO'\|'SOCIAL'" e2e/
```

For any matches, update assertions to the new titles.

- [ ] **Step 6: Commit**

```bash
git add src/components/marketing/how-it-works.tsx src/components/marketing/hero-demo.tsx e2e/
git commit -m "feat(landing): replace all-caps shorthand with real industry titles per agent-roster-roadmap"
```

---

## Task 8: Delete the three obsolete agent dirs

**Files:**
- Delete: `src/tools/AgentTool/agents/content-manager/`
- Delete: `src/tools/AgentTool/agents/content-planner/`
- Delete: `src/tools/AgentTool/agents/discovery-agent/`

- [ ] **Step 1: Verify no source / docs reference them anymore**

```bash
grep -rn "content-manager\|content-planner\|discovery-agent" src/ \
  | grep -v "social-media-manager" \
  | grep -v "Phase J\|legacy\|migrated\|Plan 3" \
  | head -30
```

Expected: zero hits, OR only historical comments ("former content-manager — now folded into social-media-manager"). For pure deletion candidates, no hits.

- [ ] **Step 2: Delete the three dirs**

```bash
git rm -r src/tools/AgentTool/agents/content-manager/
git rm -r src/tools/AgentTool/agents/content-planner/
git rm -r src/tools/AgentTool/agents/discovery-agent/
```

- [ ] **Step 3: Type-check + tests**

```bash
pnpm tsc --noEmit
pnpm vitest run --reporter=basic
```

Expected: 0 errors, 0 failed.

- [ ] **Step 4: Commit**

```bash
git commit -m "chore(agents): delete content-manager + content-planner + discovery-agent — collapsed into social-media-manager"
```

---

## Task 9: CLAUDE.md + roster doc updates

**Files:**
- Modify: `CLAUDE.md`
- Modify: `docs/agent-roster-roadmap.md`

- [ ] **Step 1: Update CLAUDE.md**

Find every reference to the deleted agent names:

```bash
grep -n "content-manager\|content-planner\|discovery-agent" CLAUDE.md
```

For each one, decide:
- (a) Update to `social-media-manager` if the principle still applies.
- (b) Remove if the rule was specific to the old agent split (e.g. "don't sniff platform from `externalId` shape" remains general — keep; but "Phase J unified content-manager handles reply_sweep + post_batch" is now obsolete — update to "Plan 3 unified social-media-manager handles all X work").

- [ ] **Step 2: Update agent-roster-roadmap.md**

Mark Tier 1 complete:
- ✅ **Chief Marketing Officer (CMO)** ← unchanged
- ✅ **Social Media Manager** ← was 🟡, now ✅

Update the `## Development order` table:
- Plan 1: ✅ shipped
- Plan 2: ✅ shipped
- Plan 3: ✅ shipped (this plan)
- Plan 4 (PMM): unblocked, next up

- [ ] **Step 3: Commit**

```bash
git add CLAUDE.md docs/agent-roster-roadmap.md
git commit -m "docs: mark Tier 1 agent roster complete after Plan 3"
```

---

## Task 10: Real-browser smoke test

**Files:**
- Create or modify: `e2e/social-media-manager-smoke.spec.ts`

- [ ] **Step 1: Write the smoke**

Connect to user's existing authenticated Chromium, trigger a daily run, verify the team page shows Social Media Manager (not the old 3 agents), and verify a draft surfaces in `/briefing`.

```typescript
import { test, expect, chromium } from '@playwright/test';

test('end-to-end: daily run produces drafts via social-media-manager and team page renders correctly', async () => {
  const browser = await chromium.connectOverCDP(
    process.env.CHROMIUM_CDP_URL ?? 'http://localhost:9222',
  );
  const ctx = browser.contexts()[0];
  const page = await ctx.newPage();

  // 1. Verify roster page shows real titles
  await page.goto('http://localhost:3000/team');
  await expect(page.getByText('Social Media Manager')).toBeVisible({ timeout: 10_000 });
  await expect(page.getByText('Chief Marketing Officer')).toBeVisible();
  await expect(page.getByText('content-manager')).toHaveCount(0);
  await expect(page.getByText('discovery-agent')).toHaveCount(0);

  // 2. Verify landing page shows real titles
  await page.goto('http://localhost:3000/');
  await expect(page.getByText('Social Media Manager').first()).toBeVisible();

  // 3. Trigger automation and watch a draft appear
  const triggerResp = await page.request.post('http://localhost:3000/api/automation/run');
  expect(triggerResp.ok()).toBeTruthy();

  await page.goto('http://localhost:3000/briefing');
  await expect(page.getByTestId('reply-card').first()).toBeVisible({ timeout: 90_000 });

  // 4. Assert no console errors during the flow
  const consoleErrors: string[] = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text());
  });
  await page.waitForLoadState('networkidle');
  expect(consoleErrors.filter((e) => !e.includes('favicon'))).toHaveLength(0);

  await browser.close();
});
```

- [ ] **Step 2: Run it**

```bash
pnpm playwright test e2e/social-media-manager-smoke.spec.ts --reporter=list
```

Expected: PASS within 90 s. If FAIL, the failure is most likely:
- Agent provisioner didn't seed correctly → check `team_members` table, re-run migration
- Old strings still in UI → grep + fix
- Spawn caller still uses old subagent_type → grep + fix

- [ ] **Step 3: Commit**

```bash
git add e2e/social-media-manager-smoke.spec.ts
git commit -m "test(e2e): real-browser smoke for social-media-manager collapse"
```

---

## Task 11: Final verification + push

- [ ] **Step 1: Greppable invariants**

```bash
# Old agent names entirely gone from source
grep -rn "content-manager\|content-planner\|discovery-agent" src/ docs/ CLAUDE.md \
  | grep -v "social-media-manager" \
  | grep -v "agent-roster-roadmap.md" \
  | grep -v "docs/superpowers/plans/" \
  | head -20
# Expected: 0 hits (only this plan, the roster roadmap, and Plan 1/2 plan docs may mention historical names)

# New agent dir exists
ls src/tools/AgentTool/agents/social-media-manager/
# Expected: AGENT.md, schema.ts, references/, __tests__/

# Three old agent dirs gone
ls src/tools/AgentTool/agents/ | grep -E "(content-manager|content-planner|discovery-agent)"
# Expected: 0 hits

# Landing page uses real titles
grep -E "'CMO'|'SOCIAL'|'SEARCH'|'PERFORMANCE'|'CONTENT'|'ANALYTICS'" src/components/marketing/
# Expected: 0 hits (the strings are now full titles)
```

- [ ] **Step 2: Type-check + tests**

```bash
pnpm tsc --noEmit
pnpm vitest run --reporter=basic
```

- [ ] **Step 3: Push**

```bash
git push -u origin HEAD
```

---

## Self-Review

**Spec coverage:**
- DB migration to rename rows → Task 1 ✓
- New agent dir + schema + AGENT.md → Task 2 ✓
- Schema map updated → Task 3 ✓
- Coordinator AGENT.md spawn references → Task 4 ✓
- All other source-code refs (presets, provisioner, onboarding, sweeper, agent-run worker) → Task 5 ✓
- UI roster + member page + accent → Task 6 ✓
- Landing page real titles → Task 7 ✓
- Delete obsolete agent dirs → Task 8 ✓
- Doc updates (CLAUDE.md, roster roadmap) → Task 9 ✓
- Real-browser smoke → Task 10 ✓
- Final verification → Task 11 ✓

**Placeholder scan:** No "TBD" / "implement later" anywhere. Tasks 4-5 group their commits because they're a single atomic spawn-rename — clearly stated.

**Type consistency:**
- `'social-media-manager'` is the single canonical agent_type string everywhere (DB, schemas, UI, AGENT.md, spawn callers).
- `SocialMediaManagerOutput` zod schema mirrors the old `ContentManagerOutput` field-for-field so callers reading the structured output continue to parse the same shape.

---

## Tradeoffs / risks

- **Migration deletes content-planner + discovery-agent rows.** If a team has active conversations / agent_runs against those agents, the FK cascade will sweep them too. Acceptable — those work-in-flight rows belong to a defunct workflow path. Pre-migration check: query for active `agent_runs.status = 'running'` rows tied to the deleted member IDs and shut them down gracefully (`SendMessage shutdown_request`) before running the migration on prod. Local dev: not a concern.
- **Coordinator absorbs content-planner work.** The coordinator's AGENT.md already has `generate_strategic_path` + `add_plan_item` + `update_plan_item` tools. The spawn-content-planner pattern was a relic; coordinator should call those tools directly. If a workflow surfaces that genuinely needs a planner specialist (e.g. complex multi-product strategic-path generation), revisit at Plan 4 (when PMM lands).
- **Voice consistency wins.** Three-agent split previously meant `discovery-agent` (sonnet) judging, `content-manager` (haiku) drafting, `content-planner` (sonnet) planning — three different model + prompt contexts touching the same brand voice. After Plan 3 it's one agent + the orchestrator pipelines under it. Tighter consistency.
- **Role atrophy** — if the coordinator handles strategy AND the social-media-manager handles execution, who does pure "positioning" / messaging / launch work? Today: nobody does it specifically; founder fills the gap. Plan 4 (PMM) closes this.
