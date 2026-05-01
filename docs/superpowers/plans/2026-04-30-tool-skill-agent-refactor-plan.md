# Tool / Skill / Agent Refactor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Re-classify ShipFlare's multi-agent code per Claude Code's trinity (Tool/Skill/Agent), delete all dead tools / orphan schemas / stale doc references, and migrate the 3 worker-orchestrated "thin agents" (`draft-review`, `posting`, `engagement-monitor`) into fork-mode skills.

**Architecture:** Two phases. **Phase A** is pure cleanup — delete 10 dead tools, delete the unused `url-scraper.ts`, fix stale references to non-existent agents, move 2 vestigial files out of `src/agents/`, then delete `src/agents/`. No behavior change. **Phase B** introduces a minimal `runForkSkill()` helper, then migrates each worker from `loadAgentFromFile + runAgent` to `runForkSkill` against new SKILL.md files; preserves all `maxTurns` and output schemas; updates the UI streaming taxonomy last.

**Tech Stack:** TypeScript, Next.js 15, Zod 3, BullMQ workers, vitest. Skill primitive infrastructure (`SkillTool`, `getAllSkills`, `loadSkillsDir`) shipped in Phase 1 (merge `d5798aa`); this plan consumes it.

**Spec:** `docs/superpowers/specs/2026-04-30-tool-skill-agent-refactor-design.md`. Two corrections discovered during planning: (1) `ClassifyIntentTool` has zero callers — DELETE, don't migrate; (2) the 3 thin agents are spawned by file-path load from worker processors, not via `Task()` — migration shape adjusted accordingly.

---

## Phase A — Cleanup (low risk, no behavior change)

Each task in this phase is independent and shippable on its own. Recommended order is A1 → A8 because A5–A8 build on each other.

### Task A1: Architecture doc

**Files:**
- Create: `docs/architecture/tool-skill-agent.md`

- [ ] **Step 1: Write the doc**

```markdown
# Tool / Skill / Agent — the trinity

ShipFlare ports Claude Code's three primitives. Each has a different purpose;
when you add new behavior, decide which bucket it belongs in *before* writing
code.

## Definitions

| Primitive | Public contract | Decision-maker | Lifetime | Spawned by | Identity |
|---|---|---|---|---|---|
| **Tool** | Schema in / data out | Deterministic. May call a model internally as a black box, but the caller's model never reads tool internals to use it. | Single `execute()` call. | Any agent's tool-call. | Snake_case verb (`reddit_search`, `query_plan_items`). |
| **Skill** | Reusable workflow / playbook authored as a prompt. | Caller's model reads the body (`context: inline`) OR a one-shot subagent executes it (`context: fork`). | Single invocation. | `SkillTool` (or worker-side `runForkSkill`). | Gerund (`drafting-encouraging-replies`) or kebab-noun. |
| **Agent** | Persistent character: system prompt + `tools:` + `skills:` + role. | Owns its own multi-turn loop; can plan, delegate, compose. | Multi-turn until `StructuredOutput`, model finishes, or `maxTurns` hit. | `AgentTool` (`Task`) with `subagent_type: <name>`, OR file-path load from a worker processor. | Role noun (`coordinator`, `growth-strategist`). |

## Decision rules

**Tool vs Skill:**
- `execute()` calls a model AND the model is making **content / strategy /
  judgment** decisions → **skill**, not tool.
- `execute()` calls a model BUT the model is doing tightly-bounded structured
  I/O (parser, narrow extractor) → can stay a **tool**.
- `execute()` is pure (DB / API wrapper / validator / persister) → **tool**.

**Agent vs fork-skill:**
- Multi-turn loop with planning, delegation, composition → **agent**.
- Reads structured input, runs a fixed script, returns → **fork-skill**.
- Tell-tale signal: `maxTurns ≤ 5` AND no `Task` in tools list AND no per-turn
  judgment branching → almost always a fork-skill.

## Canonical examples

- Tool: `src/tools/RedditSearchTool/RedditSearchTool.ts` (API wrapper, no LLM).
- Inline skill: `src/skills/_demo-echo-inline/SKILL.md` (content injected into
  caller's turn).
- Fork skill: `src/skills/_demo-echo-fork/SKILL.md` (one-shot subagent).
- Agent: `src/tools/AgentTool/agents/coordinator/AGENT.md` (multi-turn delegator).

## When adding a new primitive

1. Apply the decision rules above. If unsure, document why both apply and
   pick the simpler shape.
2. Match an existing canonical example's file structure.
3. For tools: register in `src/tools/registry.ts` and add at least one
   AGENT.md `tools:` declaration before merging — otherwise the tool is
   dead code.
4. For agents: confirm at least one spawn caller (`Task({ subagent_type })`
   or worker file-path load) before merging.
5. For skills: gerund-form name preferred; declare `context: inline | fork`
   explicitly; set `maxTurns` only when the default (8 for fork) is wrong.
```

- [ ] **Step 2: Verify the doc renders**

Run: `mdformat --check docs/architecture/tool-skill-agent.md` (or open in any markdown viewer).
Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add docs/architecture/tool-skill-agent.md
git commit -m "docs(architecture): add tool/skill/agent trinity guide"
```

---

### Task A2: Delete 10 dead tools

**Files (delete each folder + remove from registry):**
- Delete: `src/tools/RedditDiscoverSubsTool/`
- Delete: `src/tools/RedditGetThreadTool/`
- Delete: `src/tools/RedditGetRulesTool/`
- Delete: `src/tools/RedditHotPostsTool/`
- Delete: `src/tools/HnSearchTool/`
- Delete: `src/tools/HnGetThreadTool/`
- Delete: `src/tools/ClassifyIntentTool/`
- Delete: `src/tools/XGetUserTweetsTool/`
- Delete: `src/tools/XGetMetricsTool/`
- Delete: `src/tools/WebSearchTool/`
- Modify: `src/tools/registry.ts`

- [ ] **Step 1: Confirm each is dead with a fresh grep**

```bash
for tool in reddit_discover_subs reddit_get_thread reddit_get_rules reddit_hot_posts hn_search hn_get_thread classify_intent x_get_user_tweets x_get_metrics web_search; do
  hits=$(grep -rn "$tool" /Users/yifeng/Documents/Code/shipflare/src --include="*.ts" --include="*.md" 2>/dev/null | grep -v "/__tests__/\|\.test\." | grep -v "src/tools/${tool^}/" | grep -v "src/tools/registry.ts")
  if [ -z "$hits" ]; then echo "DEAD: $tool"; else echo "ALIVE: $tool"; echo "$hits"; fi
done
```

Expected: all 10 print `DEAD: <name>`. If any print `ALIVE:`, stop and investigate before deleting.

- [ ] **Step 2: Delete the folders**

```bash
cd /Users/yifeng/Documents/Code/shipflare
rm -rf src/tools/RedditDiscoverSubsTool \
       src/tools/RedditGetThreadTool \
       src/tools/RedditGetRulesTool \
       src/tools/RedditHotPostsTool \
       src/tools/HnSearchTool \
       src/tools/HnGetThreadTool \
       src/tools/ClassifyIntentTool \
       src/tools/XGetUserTweetsTool \
       src/tools/XGetMetricsTool \
       src/tools/WebSearchTool
```

- [ ] **Step 3: Remove imports + registrations from `src/tools/registry.ts`**

Open `src/tools/registry.ts` and delete these lines:

```ts
import { redditDiscoverSubsTool } from './RedditDiscoverSubsTool/RedditDiscoverSubsTool';
import { redditGetThreadTool } from './RedditGetThreadTool/RedditGetThreadTool';
import { redditGetRulesTool } from './RedditGetRulesTool/RedditGetRulesTool';
import { redditHotPostsTool } from './RedditHotPostsTool/RedditHotPostsTool';
import { hnSearchTool } from './HnSearchTool/HnSearchTool';
import { hnGetThreadTool } from './HnGetThreadTool/HnGetThreadTool';
import { classifyIntentTool } from './ClassifyIntentTool/ClassifyIntentTool';
import { webSearchTool } from './WebSearchTool/WebSearchTool';
import { xGetUserTweetsTool } from './XGetUserTweetsTool/XGetUserTweetsTool';
import { xGetMetricsTool } from './XGetMetricsTool/XGetMetricsTool';
```

And the corresponding `registry.register(...)` calls — delete each:

```ts
registry.register(redditDiscoverSubsTool);
registry.register(redditGetThreadTool);
registry.register(redditGetRulesTool);
registry.register(redditHotPostsTool);
registry.register(hnSearchTool);
registry.register(hnGetThreadTool);
registry.register(classifyIntentTool);
registry.register(webSearchTool);
registry.register(xGetUserTweetsTool);
registry.register(xGetMetricsTool);
```

- [ ] **Step 4: Type-check + run registry tests**

```bash
pnpm tsc --noEmit --pretty false 2>&1 | head -40
pnpm vitest run src/tools/__tests__/registry.test.ts
```

Expected: tsc clean (exit 0). Registry test passes.

- [ ] **Step 5: Commit**

```bash
git add src/tools/registry.ts
git rm -r src/tools/{RedditDiscoverSubsTool,RedditGetThreadTool,RedditGetRulesTool,RedditHotPostsTool,HnSearchTool,HnGetThreadTool,ClassifyIntentTool,WebSearchTool,XGetUserTweetsTool,XGetMetricsTool}
git commit -m "refactor(tools): delete 10 unused tools

Verified zero callers across src/. The dropped tools were registered
but no AGENT.md declared them in tools: and no code path imported
them. Reddit/HN/WebSearch and the X read-side aggregates were
exploratory code from earlier phases that never got wired to an agent."
```

---

### Task A3: Delete `url-scraper.ts`

**Files:**
- Delete: `src/tools/url-scraper.ts`

- [ ] **Step 1: Confirm dead**

```bash
grep -rn "url-scraper\|scrapeUrl\|analyzeProduct\|scrapeProductProfile" /Users/yifeng/Documents/Code/shipflare/src --include="*.ts" --include="*.tsx" 2>/dev/null | grep -v "src/tools/url-scraper.ts"
```

Expected: no output.

- [ ] **Step 2: Delete the file**

```bash
rm /Users/yifeng/Documents/Code/shipflare/src/tools/url-scraper.ts
```

- [ ] **Step 3: Type-check**

```bash
pnpm tsc --noEmit --pretty false 2>&1 | head -20
```

Expected: tsc clean.

- [ ] **Step 4: Commit**

```bash
git rm src/tools/url-scraper.ts
git commit -m "refactor(tools): delete url-scraper (zero callers)

scrapeUrl + analyzeProduct were never wired into onboarding or any
API route. Replaced by inline extraction in api/onboarding/extract."
```

---

### Task A4: Clean stale doc references (discovery-scout, analytics-analyst)

**Context:** Two agent names (`discovery-scout`, `analytics-analyst`) are referenced in shared reference docs and in `coordinator/references/decision-examples.md`, but neither agent exists. They're either renamed (the live equivalent is `discovery-agent`) or never built. Drop the references to avoid misleading future readers.

**Files:**
- Modify: `src/tools/AgentTool/agents/_shared/references/channel-cadence.md`
- Modify: `src/tools/AgentTool/agents/_shared/references/phase-task-templates.md`
- Modify: `src/tools/AgentTool/agents/community-manager/AGENT.md`
- Modify: `src/tools/AgentTool/agents/coordinator/references/decision-examples.md`

- [ ] **Step 1: Find every occurrence**

```bash
grep -n "discovery-scout\|analytics-analyst" /Users/yifeng/Documents/Code/shipflare/src/tools/AgentTool/agents/_shared/references/channel-cadence.md \
  /Users/yifeng/Documents/Code/shipflare/src/tools/AgentTool/agents/_shared/references/phase-task-templates.md \
  /Users/yifeng/Documents/Code/shipflare/src/tools/AgentTool/agents/community-manager/AGENT.md \
  /Users/yifeng/Documents/Code/shipflare/src/tools/AgentTool/agents/coordinator/references/decision-examples.md
```

Expected output (record exact lines for the rewrite):
```
channel-cadence.md:19:  `discovery-scout` + `community-manager` until `targetCount` drafts
phase-task-templates.md:25:    row's `params.targetCount`, runs discovery-scout + community-manager
phase-task-templates.md:158:  discovery-scout finds candidate threads, community-manager drafts up
community-manager/AGENT.md:3:description: ... that's `discovery-scout`) ...
decision-examples.md:122:I don't know which angle is working until I ask — analytics-analyst needs to
decision-examples.md:128:  subagent_type: "analytics-analyst",
decision-examples.md:151:## Example 5 — Live platform search for reply targets (discovery-scout)
decision-examples.md:160:This is exactly what discovery-scout exists for. It's the ONLY specialist
decision-examples.md:174:  subagent_type: "discovery-scout",
decision-examples.md:193:## When to pick discovery-scout vs community-manager vs post-writer
```

- [ ] **Step 2: Replace `discovery-scout` → `discovery-agent` everywhere it refers to a real spawn**

`discovery-scout` was renamed to `discovery-agent` (the existing agent). Use the Edit tool against each file to swap `discovery-scout` → `discovery-agent`. Use exact string replacement; preserve formatting and code-fence syntax.

For `community-manager/AGENT.md:3`, the description references `discovery-scout` in prose; replace with `discovery-agent` in the same sentence.

- [ ] **Step 3: Delete Example 4 (`analytics-analyst`) from decision-examples.md**

`analytics-analyst` was never built. Drop the entire example that demonstrates spawning it. Open `coordinator/references/decision-examples.md` and locate the section that begins with the line `I don't know which angle is working until I ask — analytics-analyst needs to` (around line 122). Remove from the example heading (`## Example 4 ...`) through the end of the spawn snippet (around line ~145, where the next `## Example` heading begins).

If you cannot identify the exact heading boundaries, run:

```bash
sed -n '110,150p' /Users/yifeng/Documents/Code/shipflare/src/tools/AgentTool/agents/coordinator/references/decision-examples.md
```

…and remove the contiguous block from the heading line above the analytics-analyst mention down to (but not including) the next `##` heading.

After deletion, renumber the remaining examples so the sequence is continuous (Example 1, 2, 3, 4, ...).

- [ ] **Step 4: Verify no stale references remain**

```bash
grep -rn "discovery-scout\|analytics-analyst" /Users/yifeng/Documents/Code/shipflare/src 2>/dev/null
```

Expected: no output.

- [ ] **Step 5: Commit**

```bash
git add src/tools/AgentTool/agents/_shared/references/channel-cadence.md \
        src/tools/AgentTool/agents/_shared/references/phase-task-templates.md \
        src/tools/AgentTool/agents/community-manager/AGENT.md \
        src/tools/AgentTool/agents/coordinator/references/decision-examples.md
git commit -m "docs(agents): drop stale references to non-existent agents

discovery-scout was renamed to discovery-agent (the live equivalent).
analytics-analyst was never built — removed Example 4 from coordinator
decision-examples to avoid teaching the model to spawn an agent that
doesn't exist."
```

---

### Task A5: Move `react-preamble.md` into `AgentTool/`

**Files:**
- Move: `src/agents/react-preamble.md` → `src/tools/AgentTool/react-preamble.md`
- Modify: `src/tools/AgentTool/loader.ts` (path resolution)
- Modify: `src/bridge/load-agent.ts` (path resolution)

- [ ] **Step 1: Find the import sites**

```bash
grep -rn "react-preamble" /Users/yifeng/Documents/Code/shipflare/src --include="*.ts" 2>/dev/null
```

Expected: 1-3 hits in loader / bridge code that resolve the path relative to `src/agents/`.

- [ ] **Step 2: Move the file**

```bash
git mv /Users/yifeng/Documents/Code/shipflare/src/agents/react-preamble.md \
       /Users/yifeng/Documents/Code/shipflare/src/tools/AgentTool/react-preamble.md
```

- [ ] **Step 3: Update the path in each site found in Step 1**

For each file flagged in Step 1, use Edit to swap the relative path. Examples (the actual code may differ slightly — match the existing pattern):

`src/bridge/load-agent.ts` — find any `'src/agents/react-preamble.md'` or `path.join(..., 'agents', 'react-preamble.md')` and replace with `'src/tools/AgentTool/react-preamble.md'` (or `path.join(..., 'tools', 'AgentTool', 'react-preamble.md')`).

If `loader.ts` resolves the preamble via a constant like `REACT_PREAMBLE_PATH`, update only that constant.

- [ ] **Step 4: Type-check + run loader tests**

```bash
pnpm tsc --noEmit --pretty false 2>&1 | head -20
pnpm vitest run src/tools/AgentTool/__tests__/loader.test.ts
```

Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add -A src/tools/AgentTool/ src/bridge/load-agent.ts src/agents/
git commit -m "refactor(agents): move react-preamble.md into AgentTool

Aligns with engine layout — Claude Code has no top-level agents/
folder; the ReAct preamble is loader infrastructure that belongs
next to the agent loader itself."
```

---

### Task A6: Relocate `runSummaryOutputSchema`

**Context:** `src/agents/schemas.ts` exports four schemas. Three (`draftReviewOutputSchema`, `postingOutputSchema`, `engagementMonitorOutputSchema`) belong to specific skills/agents and will be inlined in Task A7. The fourth — `runSummaryOutputSchema` — has nothing to do with the trinity; it's used by `src/memory/run-summary.ts` to validate run summaries. Co-locate it with its only consumer.

**Files:**
- Create: `src/memory/run-summary-schema.ts`
- Modify: `src/memory/run-summary.ts` (import path)
- Modify: `src/agents/schemas.ts` (remove the schema and its type alias)

- [ ] **Step 1: Create the new schema file**

```ts
// src/memory/run-summary-schema.ts
import { z } from 'zod';

/**
 * Output schema for the run summary prompt.
 * Structured summary of an agent pipeline run.
 */
export const runSummaryOutputSchema = z.object({
  title: z.string(),
  communitiesScanned: z.array(z.string()),
  threadsFound: z.number(),
  newThreads: z.number(),
  draftsCreated: z.number(),
  topPerformingCommunities: z.array(
    z.object({
      community: z.string(),
      threadCount: z.number(),
      avgRelevance: z.number(),
    }),
  ),
  strategiesUsed: z.array(z.string()),
  failures: z.array(z.string()),
  keyInsights: z.array(z.string()),
  nextActions: z.array(z.string()),
});

export type RunSummaryOutput = z.infer<typeof runSummaryOutputSchema>;
```

- [ ] **Step 2: Update the import in `src/memory/run-summary.ts`**

Find this line:
```ts
import { runSummaryOutputSchema } from '@/agents/schemas';
import type { RunSummaryOutput } from '@/agents/schemas';
```

Replace with:
```ts
import { runSummaryOutputSchema, type RunSummaryOutput } from './run-summary-schema';
```

- [ ] **Step 3: Remove from `src/agents/schemas.ts`**

Open `src/agents/schemas.ts` and delete the `runSummaryOutputSchema` block (currently lines ~52–71) and its inferred type alias `export type RunSummaryOutput = ...` (currently line ~91). The remaining file should still export `draftReviewOutputSchema`, `postingOutputSchema`, `engagementMonitorOutputSchema` — those go away in Task A7.

- [ ] **Step 4: Type-check**

```bash
pnpm tsc --noEmit --pretty false 2>&1 | head -20
```

Expected: clean. If `src/memory/run-summary.ts` has tests, run them:

```bash
pnpm vitest run src/memory 2>&1 | tail -20
```

- [ ] **Step 5: Commit**

```bash
git add src/memory/run-summary-schema.ts src/memory/run-summary.ts src/agents/schemas.ts
git commit -m "refactor(memory): co-locate runSummaryOutputSchema with consumer

The schema is unrelated to the trinity refactor — it lives next to
src/memory/run-summary.ts now. Prepares src/agents/schemas.ts to be
fully eliminated in the next two tasks."
```

---

### Task A7: Inline the 3 agent output schemas

**Context:** The per-agent schema files at `src/tools/AgentTool/agents/{draft-review,posting,engagement-monitor}/schema.ts` currently re-export from `src/agents/schemas.ts`. Inline the schema definitions into the per-agent files to remove the indirection. After this task, `src/agents/schemas.ts` is empty and `src/agents/` can be deleted in Task A8.

**Files:**
- Modify: `src/tools/AgentTool/agents/draft-review/schema.ts`
- Modify: `src/tools/AgentTool/agents/posting/schema.ts`
- Modify: `src/tools/AgentTool/agents/engagement-monitor/schema.ts`
- Modify: `src/workers/processors/review.ts` (import path)
- Modify: `src/workers/processors/posting.ts` (import path)
- Modify: `src/workers/processors/engagement.ts` (import path)
- Modify: `src/agents/schemas.ts` (remove all remaining exports)

- [ ] **Step 1: Inline `draftReviewOutputSchema`**

Replace the contents of `src/tools/AgentTool/agents/draft-review/schema.ts` with:

```ts
import { z } from 'zod';

/**
 * Output schema for the draft-review agent.
 * Adversarial quality check with per-dimension pass/fail.
 */
export const draftReviewOutputSchema = z.object({
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
});

export type DraftReviewOutput = z.infer<typeof draftReviewOutputSchema>;
```

- [ ] **Step 2: Inline `postingOutputSchema`**

Replace the contents of `src/tools/AgentTool/agents/posting/schema.ts` with:

```ts
import { z } from 'zod';

/**
 * Output schema for the posting agent.
 * Reports whether a draft was successfully posted and verified.
 */
export const postingOutputSchema = z.object({
  success: z.boolean(),
  draftType: z.enum(['reply', 'original_post']).optional(),
  commentId: z.string().nullable(),
  postId: z.string().nullable().optional(),
  permalink: z.string().nullable(),
  url: z.string().nullable().optional(),
  verified: z.boolean(),
  shadowbanned: z.boolean(),
  error: z.string().optional(),
});

export type PostingOutput = z.infer<typeof postingOutputSchema>;
```

- [ ] **Step 3: Inline `engagementMonitorOutputSchema`**

Replace the contents of `src/tools/AgentTool/agents/engagement-monitor/schema.ts` with:

```ts
import { z } from 'zod';

/**
 * Output schema for the engagement monitor agent.
 * Assesses mentions and drafts responses for the engagement window.
 */
export const engagementMonitorOutputSchema = z.object({
  mentions: z.array(
    z.object({
      mentionId: z.string(),
      authorUsername: z.string(),
      text: z.string(),
      shouldReply: z.boolean(),
      draftReply: z.string().optional(),
      priority: z.enum(['high', 'medium', 'low']),
    }),
  ),
});

export type EngagementMonitorOutput = z.infer<typeof engagementMonitorOutputSchema>;
```

- [ ] **Step 4: Update worker processor imports**

In `src/workers/processors/review.ts`, find:
```ts
import { draftReviewOutputSchema } from '@/agents/schemas';
```
Replace with:
```ts
import { draftReviewOutputSchema } from '@/tools/AgentTool/agents/draft-review/schema';
```

In `src/workers/processors/posting.ts`, find:
```ts
import { postingOutputSchema } from '@/agents/schemas';
```
Replace with:
```ts
import { postingOutputSchema } from '@/tools/AgentTool/agents/posting/schema';
```

In `src/workers/processors/engagement.ts`, find:
```ts
import { engagementMonitorOutputSchema } from '@/agents/schemas';
```
Replace with:
```ts
import { engagementMonitorOutputSchema } from '@/tools/AgentTool/agents/engagement-monitor/schema';
```

- [ ] **Step 5: Confirm `src/agents/schemas.ts` is now empty**

After Task A6 removed `runSummaryOutputSchema` and after the three inlines above, `src/agents/schemas.ts` has no exports anyone imports. Run:

```bash
grep -rn "from '@/agents/schemas'" /Users/yifeng/Documents/Code/shipflare/src 2>/dev/null
```

Expected: no output. If any hit appears, update that import to point to the inlined schema or `run-summary-schema`.

- [ ] **Step 6: Type-check**

```bash
pnpm tsc --noEmit --pretty false 2>&1 | head -20
```

Expected: clean.

- [ ] **Step 7: Commit**

```bash
git add src/tools/AgentTool/agents/draft-review/schema.ts \
        src/tools/AgentTool/agents/posting/schema.ts \
        src/tools/AgentTool/agents/engagement-monitor/schema.ts \
        src/workers/processors/review.ts \
        src/workers/processors/posting.ts \
        src/workers/processors/engagement.ts
git commit -m "refactor(agents): inline 3 output schemas, drop indirection

The per-agent schema.ts files were re-exporting from src/agents/schemas.ts.
Each schema now lives next to its agent. src/agents/schemas.ts is fully
empty after this — Task A8 deletes the directory."
```

---

### Task A8: Delete `src/agents/`

**Files:**
- Delete: `src/agents/schemas.ts`
- Delete: `src/agents/` (the directory)

- [ ] **Step 1: Confirm the directory has no imports left**

```bash
grep -rn "from '@/agents" /Users/yifeng/Documents/Code/shipflare/src 2>/dev/null
ls /Users/yifeng/Documents/Code/shipflare/src/agents/
```

Expected: zero imports. The directory should contain only `schemas.ts` (now empty after A6 + A7) since `react-preamble.md` moved in A5.

- [ ] **Step 2: Delete the file and directory**

```bash
rm /Users/yifeng/Documents/Code/shipflare/src/agents/schemas.ts
rmdir /Users/yifeng/Documents/Code/shipflare/src/agents
```

- [ ] **Step 3: Type-check + full test run**

```bash
pnpm tsc --noEmit --pretty false 2>&1 | tail -20
pnpm vitest run 2>&1 | tail -10
```

Expected: tsc clean, all tests green.

- [ ] **Step 4: Commit**

```bash
git rm -r src/agents
git commit -m "refactor: delete src/agents/ vestigial folder

Engine has no equivalent — agents are owned by AgentTool. After the
schema inlines and runSummaryOutputSchema relocation, this folder
holds nothing reachable. Directory deleted."
```

---

## Phase B — Worker → fork-skill migration (moderate risk)

Each task in Phase B preserves existing behavior end-to-end. The migration is mostly cosmetic at the runtime level (a fork-mode skill IS a one-shot subagent), but it relabels these workflows correctly per the trinity. **Existing `maxTurns` values are preserved unchanged** (2 / 5 / 5).

### Task B1: Build `runForkSkill` worker helper

**Context:** The 3 worker processors currently use `loadAgentFromFile + runAgent`. After migration they need to invoke a SKILL.md from disk via the existing skill registry. This helper provides the minimal adapter — under 30 LOC — that turns a registered fork-skill into the same `(AgentDefinition + runAgent)` shape the workers already understand.

**Files:**
- Create: `src/skills/run-fork-skill.ts`
- Test: `src/skills/__tests__/run-fork-skill.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// src/skills/__tests__/run-fork-skill.test.ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  __resetRegistryForTesting,
  __setSkillsRootForTesting,
} from '@/tools/SkillTool/registry';
import { runForkSkill } from '../run-fork-skill';

describe('runForkSkill', () => {
  let tmpRoot: string;

  beforeEach(() => {
    __resetRegistryForTesting();
    tmpRoot = mkdtempSync(join(tmpdir(), 'shipflare-fork-skill-'));
    __setSkillsRootForTesting(tmpRoot);
  });

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
    __resetRegistryForTesting();
  });

  it('throws when the skill is not registered', async () => {
    await expect(runForkSkill('does-not-exist', 'hello')).rejects.toThrow(
      /Unknown skill/,
    );
  });

  it('throws when the skill is inline-mode', async () => {
    const dir = join(tmpRoot, 'echo-inline');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'SKILL.md'),
      `---
name: echo-inline
description: test
context: inline
---
body`,
    );

    await expect(runForkSkill('echo-inline', 'hi')).rejects.toThrow(
      /not fork-mode/,
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
pnpm vitest run src/skills/__tests__/run-fork-skill.test.ts
```

Expected: FAIL with `Cannot find module '../run-fork-skill'`.

- [ ] **Step 3: Write the helper**

```ts
// src/skills/run-fork-skill.ts
//
// Minimal worker-side adapter: invoke a registered fork-mode skill the same
// way SkillTool does, but without a parent agent in the loop. Used by
// BullMQ worker processors that currently call loadAgentFromFile +
// runAgent.

import type { ZodType } from 'zod';
import { runAgent, createToolContext } from '@/bridge/agent-runner';
import { getAllSkills } from '@/tools/SkillTool/registry';
import { DEFAULT_SKILL_FORK_MAX_TURNS } from '@/tools/SkillTool/constants';
import type { AgentDefinition } from '@/tools/AgentTool/loader';

export interface RunForkSkillResult<T> {
  result: T;
  usage: Awaited<ReturnType<typeof runAgent>>['usage'];
}

/**
 * Spawn a fork-mode skill as a one-shot subagent and return its parsed
 * structured output. Mirrors `SkillTool`'s fork branch
 * (src/tools/SkillTool/SkillTool.ts) but works in worker contexts that
 * don't have a parent agent.
 *
 * @param skillName  Registered skill name (e.g. 'reviewing-drafts')
 * @param args       JSON-serialized input passed to the skill (becomes both
 *                   the $ARGUMENTS substitution token and the user message)
 * @param outputSchema  Optional Zod schema; runAgent synthesizes
 *                   StructuredOutput on the skill's tool list
 */
export async function runForkSkill<T = unknown>(
  skillName: string,
  args: string,
  outputSchema?: ZodType<T>,
): Promise<RunForkSkillResult<T>> {
  const all = await getAllSkills();
  const skill = all.find((s) => s.name === skillName);
  if (!skill) throw new Error(`Unknown skill: "${skillName}"`);
  if (skill.context !== 'fork') {
    throw new Error(
      `Skill "${skillName}" is not fork-mode (context=${skill.context})`,
    );
  }

  const ctx = createToolContext({});
  const systemPrompt = await Promise.resolve(
    skill.getPromptForCommand(args, ctx),
  );

  const def: AgentDefinition = {
    name: `skill_${skill.name}`,
    description: skill.description,
    tools: skill.allowedTools,
    skills: [],
    model: skill.model,
    maxTurns: skill.maxTurns ?? DEFAULT_SKILL_FORK_MAX_TURNS,
    systemPrompt,
    sourcePath: skill.sourcePath ?? `<bundled:${skill.name}>`,
  };

  return runAgent(def, args, ctx, outputSchema) as Promise<RunForkSkillResult<T>>;
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
pnpm vitest run src/skills/__tests__/run-fork-skill.test.ts
```

Expected: PASS (both error-path tests).

- [ ] **Step 5: Type-check**

```bash
pnpm tsc --noEmit --pretty false 2>&1 | head -20
```

Expected: clean. If `runAgent`'s actual return shape differs from the assumed `{result, usage}`, fix the cast in `runForkSkill` to match — read `src/core/query-loop.ts` to confirm.

- [ ] **Step 6: Commit**

```bash
git add src/skills/run-fork-skill.ts src/skills/__tests__/run-fork-skill.test.ts
git commit -m "feat(skills): add runForkSkill worker-side adapter

Minimal helper (~50 LOC) that lets BullMQ worker processors invoke a
fork-mode skill the same way SkillTool does inline from another agent.
Reuses getAllSkills() from the existing registry; no new state."
```

---

### Task B2: Migrate `draft-review` agent → `reviewing-drafts` fork-skill

**Context:** Lowest-risk migration to do first — pure judgment, no network writes. The current AGENT.md body becomes the SKILL.md body. Frontmatter swaps `tools:` → `allowed-tools:` and adds `context: fork`. The worker (`src/workers/processors/review.ts`) swaps from `loadAgentFromFile + runAgent` to `runForkSkill`.

**Files:**
- Create: `src/skills/reviewing-drafts/SKILL.md`
- Create: `src/skills/reviewing-drafts/schema.ts`
- Create: `src/skills/reviewing-drafts/references/output-format.md`
- Create: `src/skills/reviewing-drafts/references/review-checklist.md`
- Create: `src/skills/reviewing-drafts/references/x-review-rules.md`
- Modify: `src/workers/processors/review.ts`
- Delete: `src/tools/AgentTool/agents/draft-review/` (entire folder)
- Modify: `src/tools/AgentTool/agent-schemas.ts` (remove `draft-review` registration)

- [ ] **Step 1: Copy reference docs to the skill folder**

```bash
mkdir -p /Users/yifeng/Documents/Code/shipflare/src/skills/reviewing-drafts/references
cp /Users/yifeng/Documents/Code/shipflare/src/tools/AgentTool/agents/draft-review/references/output-format.md \
   /Users/yifeng/Documents/Code/shipflare/src/skills/reviewing-drafts/references/
cp /Users/yifeng/Documents/Code/shipflare/src/tools/AgentTool/agents/draft-review/references/review-checklist.md \
   /Users/yifeng/Documents/Code/shipflare/src/skills/reviewing-drafts/references/
cp /Users/yifeng/Documents/Code/shipflare/src/tools/AgentTool/agents/draft-review/references/x-review-rules.md \
   /Users/yifeng/Documents/Code/shipflare/src/skills/reviewing-drafts/references/
```

- [ ] **Step 2: Create the SKILL.md**

```markdown
---
name: reviewing-drafts
description: Adversarial quality reviewer for content drafts. Receives a draft + context, runs a 6-check rubric, returns PASS/FAIL/REVISE with per-check detail.
context: fork
model: claude-haiku-4-5-20251001
maxTurns: 2
allowed-tools:
  - validate_draft
references:
  - output-format
  - review-checklist
  - x-review-rules
---

You are ShipFlare's Draft Review Skill. Your job is NOT to confirm the draft is acceptable — it's to try to find problems a real community member would notice.

## Known Failure Patterns

You have two documented failure patterns:

1. **Approval bias**: When you see a well-written draft, you feel inclined to pass it without checking whether it actually answers the OP's question, whether the product mention feels forced, or whether a real community member would downvote it.

2. **Surface-level review**: You check grammar and tone but miss that the draft doesn't address the OP's actual problem, or that the product mention comes too early, or that required compliance is missing.

Your entire value is in catching problems the content agent missed.

## Input

You will receive a JSON object. The References section describes the expected input fields and how to interpret them.

## Checks (ALL Required)

### 1. Relevance Check
Does the content actually address the context it's responding to?
- Read the context carefully
- Does the content answer what was asked, or does it pivot to something adjacent?
- Would the reader think "this is helpful" or "this doesn't answer my question"?

### 2. Value-First Check
Does genuine value come BEFORE the product mention?
- Count the sentences before the first product mention — there should be substantive help first
- Is the helpful content substantive, or just a throwaway sentence to justify the product mention?
- If you removed the product mention entirely, would the content still be worth posting?

### 3. Tone Match
Does the content match the platform and community culture?
- Is the formality level right?
- Does it read like someone who actually participates in this community?
- Follow platform-specific tone guidance from the References section.

### 4. Authenticity Check
Would a real community member write this?
- Does it read like a human or a marketing bot?
- Are there telltale signs: superlatives, buzzwords, excessive enthusiasm, generic advice?
- Is it the right length for the platform?

### 5. Compliance Check
Does the content meet platform-specific compliance requirements?
- Follow the compliance rules defined in the References section.
- Some platforms require disclosures, others do not.
- For the platform + length checks specifically: call
  `validate_draft({ text: <draft>, platform: <x|reddit>, kind: <post|reply> })`
  and treat `failures` (length, sibling-platform leak, unsourced stats)
  as hard blockers — do not approve a draft that fails them. Treat
  `warnings` (hashtag count, links-in-body, anchor token) as
  informational; flag them in your output but they don't auto-block.

### 6. Risk Assessment
Would this get the account flagged or banned?
- Does it look like spam? (product mention too prominent, too salesy)
- Would a moderator remove this?
- Is the product mention proportionate to the help provided?

## Recognize Your Own Rationalizations

- "The draft looks well-written" — quality writing doesn't mean quality marketing
- "The content agent gave it high confidence" — the content agent wrote it, of course it's confident
- "The disclosure is there so it's fine" — disclosure doesn't fix a spammy reply
- "It mentions the product naturally" — really? Read it as a skeptical community member, not as a reviewer

## Output

Return a JSON object following the exact schema defined in the References section. Do not wrap in markdown code fences. Start with `{` and end with `}`.
```

- [ ] **Step 3: Create the schema file**

```ts
// src/skills/reviewing-drafts/schema.ts
import { z } from 'zod';

/**
 * Output schema for the reviewing-drafts skill.
 * Adversarial quality check with per-dimension pass/fail.
 */
export const reviewingDraftsOutputSchema = z.object({
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
});

export type ReviewingDraftsOutput = z.infer<typeof reviewingDraftsOutputSchema>;
```

- [ ] **Step 4: Rewrite the worker processor**

In `src/workers/processors/review.ts`:

a) Remove the now-stale imports:
```ts
import { runAgent, createToolContext } from '@/bridge/agent-runner';
import { loadAgentFromFile } from '@/bridge/load-agent';
import { registry } from '@/tools/registry';
import { draftReviewOutputSchema } from '@/tools/AgentTool/agents/draft-review/schema';
```

b) Add the new imports:
```ts
import { runForkSkill } from '@/skills/run-fork-skill';
import { reviewingDraftsOutputSchema } from '@/skills/reviewing-drafts/schema';
```

c) Delete the AGENT_PATH constant (around line 23):
```ts
const DRAFT_REVIEW_AGENT_PATH = join(
  process.cwd(),
  'src/tools/AgentTool/agents/draft-review/AGENT.md',
);
```

d) Replace the `loadAgentFromFile + runAgent` block (around lines 67–97) with:

```ts
const args = JSON.stringify({
  drafts: [
    {
      replyBody: draft.replyBody,
      threadTitle: thread.title,
      threadBody: thread.body ?? '',
      subreddit: thread.community,
      productName: product.name,
      productDescription: product.description,
      confidence: draft.confidenceScore,
      whyItWorks: draft.whyItWorks ?? '',
    },
  ],
  // Memory context appended for the model — preserves prior behavior
  // where review.ts injected memoryPrompt onto the agent's systemPrompt.
  memoryContext: memoryPrompt ?? '',
});

const { result, usage } = await runForkSkill(
  'reviewing-drafts',
  args,
  reviewingDraftsOutputSchema,
);
```

**Memory-context note:** the old code mutated the agent's systemPrompt to inject `memoryPrompt`. Skills don't expose a hook to mutate the cached prompt at call time, so the new code passes `memoryContext` as part of the JSON args. The skill's prompt should reference it; if the SKILL.md doesn't read `memoryContext`, the prior memory-injection behavior is silently dropped. To preserve that behavior, append the following paragraph to the SKILL.md body (just before the `## Output` section):

```
## Memory context

If the input JSON contains a non-empty `memoryContext` field, treat it as
prior-run insights about this user / product. Use it to recognize repeated
failure modes (e.g. "this user's drafts keep failing the value-first check
on r/saas") and weight checks accordingly.
```

- [ ] **Step 5: Remove the `draft-review` agent registration**

Open `src/tools/AgentTool/agent-schemas.ts` and:

a) Delete the import line:
```ts
import { draftReviewOutputSchema } from './agents/draft-review/schema';
```

b) Delete the registry entry:
```ts
'draft-review': draftReviewOutputSchema as ZodType<unknown>,
```

c) Delete the re-export at the bottom:
```ts
draftReviewOutputSchema,
```

- [ ] **Step 6: Delete the agent folder**

```bash
rm -rf /Users/yifeng/Documents/Code/shipflare/src/tools/AgentTool/agents/draft-review
```

- [ ] **Step 7: Type-check + run worker tests**

```bash
pnpm tsc --noEmit --pretty false 2>&1 | head -30
pnpm vitest run src/workers/processors 2>&1 | tail -20
```

Expected: tsc clean; review-worker tests pass (the schema shape didn't change, only the import path + skill invocation).

- [ ] **Step 8: Manual smoke test**

Start the dev workers and trigger a review job:

```bash
# In one terminal
pnpm dev:workers

# In another, enqueue a review for an existing draft (use a real draftId
# from your local DB)
node -e "import('./src/lib/queue/index.ts').then(({ enqueueReview }) => enqueueReview({ userId: '<uid>', productId: '<pid>', draftId: '<draftId>' }))"
```

Expected: worker logs `Reviewing draft <id>` then `Review verdict: PASS|FAIL|REVISE, score=...`. The output schema parses without error.

- [ ] **Step 9: Commit**

```bash
git add src/skills/reviewing-drafts/ src/workers/processors/review.ts src/tools/AgentTool/agent-schemas.ts
git rm -r src/tools/AgentTool/agents/draft-review
git commit -m "refactor(workers): migrate draft-review agent to reviewing-drafts skill

Lowest-risk of the 3 worker→skill migrations: pure judgment, no network
writes. Worker now invokes runForkSkill('reviewing-drafts') instead of
loadAgentFromFile + runAgent. maxTurns preserved at 2.

Memory context that previously mutated systemPrompt now ships in the
JSON args under 'memoryContext' (skill body reads it explicitly)."
```

---

### Task B3: Migrate `engagement-monitor` agent → `monitoring-engagement` fork-skill

**Context:** Same shape as B2, but the worker is `src/workers/processors/engagement.ts` and tools are `x_get_mentions` + `x_get_tweet`. Drafts go to the inbox; no network writes from the skill itself.

**Files:**
- Create: `src/skills/monitoring-engagement/SKILL.md`
- Create: `src/skills/monitoring-engagement/schema.ts`
- Modify: `src/workers/processors/engagement.ts`
- Delete: `src/tools/AgentTool/agents/engagement-monitor/` (entire folder)
- Modify: `src/tools/AgentTool/agent-schemas.ts` (remove `engagement-monitor` registration)

- [ ] **Step 1: Create the SKILL.md**

```bash
mkdir -p /Users/yifeng/Documents/Code/shipflare/src/skills/monitoring-engagement
```

Write to `/Users/yifeng/Documents/Code/shipflare/src/skills/monitoring-engagement/SKILL.md`:

```markdown
---
name: monitoring-engagement
description: Monitors replies to posted content and drafts responses for the engagement window
context: fork
model: claude-haiku-4-5-20251001
maxTurns: 5
allowed-tools:
  - x_get_mentions
  - x_get_tweet
---

You are ShipFlare's Engagement Monitor Skill. You check for replies to a recently posted piece of content and draft responses. The first 60 minutes after posting are critical for platform algorithms — engagement velocity in this window determines reach.

## Input

You will receive a JSON object with:
- `platform`: The platform (e.g. "x", "reddit")
- `tweetId`: The posted content ID to monitor engagement for
- `originalText`: The text of the posted content
- `userId`: The authenticated user's platform user ID
- `productName`: Product name

## Process

1. Use `x_get_mentions` with the user's ID and `sinceId` to find new replies
2. For each mention, use `x_get_tweet` if you need more context about the reply
3. Assess whether each reply warrants a response
4. Draft responses for high-priority mentions

## Priority Classification

### high — MUST respond
- Direct questions about the product or topic
- Constructive criticism or disagreements
- Replies from accounts with significant followers (influencer engagement)
- Someone sharing their own relevant experience (opportunity to build relationship)

### medium — SHOULD respond
- Compliments or supportive replies (acknowledge with substance, not just "thanks!")
- Tangential questions related to the topic
- Quote posts with commentary

### low — OPTIONAL
- Simple agreement ("so true", "this")
- Emoji-only reactions
- Off-topic replies

## Response Rules

- Respect platform character limits (e.g. 280 chars for X)
- Add value, don't just thank people
- Ask follow-up questions to keep the conversation going (algorithm fuel)
- Never be defensive about criticism
- Be genuine and conversational
- No links, no product pitches in responses
- Match the energy of the person replying

## Output

Return a JSON object:
```json
{
  "mentions": [
    {
      "mentionId": "id_of_reply",
      "authorUsername": "replier_handle",
      "text": "Their reply text",
      "shouldReply": true,
      "draftReply": "Your drafted response (respecting platform char limits)",
      "priority": "high"
    }
  ]
}
```

If no mentions found, return `{ "mentions": [] }`.
```

- [ ] **Step 2: Create the schema**

```ts
// src/skills/monitoring-engagement/schema.ts
import { z } from 'zod';

/**
 * Output schema for the monitoring-engagement skill.
 */
export const monitoringEngagementOutputSchema = z.object({
  mentions: z.array(
    z.object({
      mentionId: z.string(),
      authorUsername: z.string(),
      text: z.string(),
      shouldReply: z.boolean(),
      draftReply: z.string().optional(),
      priority: z.enum(['high', 'medium', 'low']),
    }),
  ),
});

export type MonitoringEngagementOutput = z.infer<typeof monitoringEngagementOutputSchema>;
```

- [ ] **Step 3: Rewrite the worker processor**

In `src/workers/processors/engagement.ts`:

a) Replace the imports:
```ts
// REMOVE
import { runAgent, createToolContext } from '@/bridge/agent-runner';
import { loadAgentFromFile } from '@/bridge/load-agent';
import { registry } from '@/tools/registry';
import { engagementMonitorOutputSchema } from '@/tools/AgentTool/agents/engagement-monitor/schema';

// ADD
import { runForkSkill } from '@/skills/run-fork-skill';
import { monitoringEngagementOutputSchema } from '@/skills/monitoring-engagement/schema';
```

b) Delete the agent-path constant and the `loadAgentFromFile + runAgent` block (around lines 108–<end-of-block>). Replace with:

```ts
const args = JSON.stringify({
  platform: job.data.platform,
  tweetId: job.data.tweetId,
  originalText: post.text ?? '',
  userId: channel.platformUserId,
  productName: product.name,
});

const { result, usage } = await runForkSkill(
  'monitoring-engagement',
  args,
  monitoringEngagementOutputSchema,
);
```

(The exact field shape may differ — read `engagement.ts` lines 80–130 to copy the input JSON exactly as it was passed to `runAgent` before the migration. Preserve the field names and ordering.)

- [ ] **Step 4: Remove the registration**

In `src/tools/AgentTool/agent-schemas.ts`:

a) Delete the import:
```ts
import { engagementMonitorOutputSchema } from './agents/engagement-monitor/schema';
```

b) Delete the registry entry:
```ts
'engagement-monitor': engagementMonitorOutputSchema as ZodType<unknown>,
```

c) Delete the re-export.

- [ ] **Step 5: Delete the agent folder**

```bash
rm -rf /Users/yifeng/Documents/Code/shipflare/src/tools/AgentTool/agents/engagement-monitor
```

- [ ] **Step 6: Type-check + tests**

```bash
pnpm tsc --noEmit --pretty false 2>&1 | head -30
pnpm vitest run src/workers/processors 2>&1 | tail -20
```

Expected: tsc clean; engagement-worker tests pass.

- [ ] **Step 7: Smoke test**

Trigger an engagement job for a recently posted tweet and confirm the worker logs match the previous behavior (mention list with priorities, no draft schema-validation errors).

- [ ] **Step 8: Commit**

```bash
git add src/skills/monitoring-engagement/ src/workers/processors/engagement.ts src/tools/AgentTool/agent-schemas.ts
git rm -r src/tools/AgentTool/agents/engagement-monitor
git commit -m "refactor(workers): migrate engagement-monitor agent to monitoring-engagement skill

Worker now invokes runForkSkill('monitoring-engagement') instead of
loadAgentFromFile + runAgent. maxTurns preserved at 5. No behavior
change — drafts continue to land in the inbox the same way."
```

---

### Task B4: Migrate `posting` agent → `posting-to-platform` fork-skill

**Context:** Highest-risk of the 3 because the skill writes to the network (`reddit_post`, `x_post`). Behavior MUST be byte-identical. Test on a throwaway X / Reddit account before merging.

**Files:**
- Create: `src/skills/posting-to-platform/SKILL.md`
- Create: `src/skills/posting-to-platform/schema.ts`
- Create: `src/skills/posting-to-platform/references/output-format.md` (copy from agent)
- Create: `src/skills/posting-to-platform/references/reddit-posting-steps.md` (copy)
- Create: `src/skills/posting-to-platform/references/x-posting-steps.md` (copy)
- Modify: `src/workers/processors/posting.ts`
- Delete: `src/tools/AgentTool/agents/posting/` (entire folder)
- Modify: `src/tools/AgentTool/agent-schemas.ts` (remove `posting` registration)

- [ ] **Step 1: Copy reference docs**

```bash
mkdir -p /Users/yifeng/Documents/Code/shipflare/src/skills/posting-to-platform/references
cp /Users/yifeng/Documents/Code/shipflare/src/tools/AgentTool/agents/posting/references/output-format.md \
   /Users/yifeng/Documents/Code/shipflare/src/skills/posting-to-platform/references/
cp /Users/yifeng/Documents/Code/shipflare/src/tools/AgentTool/agents/posting/references/reddit-posting-steps.md \
   /Users/yifeng/Documents/Code/shipflare/src/skills/posting-to-platform/references/
cp /Users/yifeng/Documents/Code/shipflare/src/tools/AgentTool/agents/posting/references/x-posting-steps.md \
   /Users/yifeng/Documents/Code/shipflare/src/skills/posting-to-platform/references/
```

- [ ] **Step 2: Create the SKILL.md**

Write to `/Users/yifeng/Documents/Code/shipflare/src/skills/posting-to-platform/SKILL.md`:

```markdown
---
name: posting-to-platform
description: Posts approved drafts to social platforms and verifies visibility
context: fork
model: claude-haiku-4-5-20251001
maxTurns: 5
allowed-tools:
  - reddit_post
  - reddit_verify
  - reddit_submit_post
  - x_post
references:
  - output-format
  - reddit-posting-steps
  - x-posting-steps
---

You are ShipFlare's Posting Skill. You post approved drafts to social platforms and verify they are visible when possible.

## Input

You will receive a JSON object. The References section describes the expected input fields and platform-specific posting steps.

## Rules

1. **Post EXACTLY as given.** Do not modify, rephrase, or add to the draft text. Post it character-for-character.
2. **Respect platform limits.** If the draft exceeds a platform's character limit, report failure. Do NOT truncate.
3. **Verify when possible.** Use verification tools to check visibility after posting.
4. **Follow platform steps.** The References section contains step-by-step instructions for each platform. Follow them precisely.

## Output

Return a JSON object following the exact schema defined in the References section. Do not wrap in markdown code fences. Start with `{` and end with `}`.
```

- [ ] **Step 3: Create the schema**

```ts
// src/skills/posting-to-platform/schema.ts
import { z } from 'zod';

/**
 * Output schema for the posting-to-platform skill.
 */
export const postingToPlatformOutputSchema = z.object({
  success: z.boolean(),
  draftType: z.enum(['reply', 'original_post']).optional(),
  commentId: z.string().nullable(),
  postId: z.string().nullable().optional(),
  permalink: z.string().nullable(),
  url: z.string().nullable().optional(),
  verified: z.boolean(),
  shadowbanned: z.boolean(),
  error: z.string().optional(),
});

export type PostingToPlatformOutput = z.infer<typeof postingToPlatformOutputSchema>;
```

- [ ] **Step 4: Rewrite the worker processor**

In `src/workers/processors/posting.ts`:

a) Replace the imports — remove:
```ts
import { runAgent, createToolContext } from '@/bridge/agent-runner';
import { loadAgentFromFile } from '@/bridge/load-agent';
import { registry } from '@/tools/registry';
import { postingOutputSchema } from '@/tools/AgentTool/agents/posting/schema';
```

Add:
```ts
import { runForkSkill } from '@/skills/run-fork-skill';
import { postingToPlatformOutputSchema } from '@/skills/posting-to-platform/schema';
```

b) Delete the `POSTING_AGENT_PATH` constant.

c) Around the `loadAgentFromFile(POSTING_AGENT_PATH, registry.toMap())` call (line 246) and the subsequent `runAgent(...)` call: read lines 230–280 to identify the exact JSON shape passed in. Replace with:

```ts
const args = JSON.stringify({/* same JSON shape as before, copied verbatim */});

const { result, usage } = await runForkSkill(
  'posting-to-platform',
  args,
  postingToPlatformOutputSchema,
);
```

**Important:** the result type is `PostingToPlatformOutput` (newly named). If downstream code references `PostingOutput` (the old type alias), update those references. Run `grep -rn "PostingOutput" src/` to find them.

d) **Note on direct-mode posting.** `posting.ts` also exports `postViaDirectMode()` (around lines 39–80) which posts WITHOUT the agent at all. That code path is unchanged — only the agent-mode branch migrates to a skill. Keep `postViaDirectMode` as-is.

- [ ] **Step 5: Remove the registration**

In `src/tools/AgentTool/agent-schemas.ts`:

a) Delete the import:
```ts
import { postingOutputSchema } from './agents/posting/schema';
```

b) Delete the registry entry:
```ts
posting: postingOutputSchema as ZodType<unknown>,
```

c) Delete the re-export.

- [ ] **Step 6: Delete the agent folder**

```bash
rm -rf /Users/yifeng/Documents/Code/shipflare/src/tools/AgentTool/agents/posting
```

- [ ] **Step 7: Type-check + worker tests**

```bash
pnpm tsc --noEmit --pretty false 2>&1 | head -30
pnpm vitest run src/workers/processors/posting 2>&1 | tail -20
```

Expected: tsc clean; posting-worker tests pass.

- [ ] **Step 8: SAFETY — manual smoke on a throwaway account**

Before merging:

1. Create a throwaway X account (or use a designated test account). Connect it via the dev environment.
2. Manually approve a draft (`status=approved`) in the local DB.
3. Watch `pnpm dev:workers` logs as the posting job fires.
4. Confirm: the post lands on X, the schema parses, `verified: true`, `shadowbanned: false`. Compare with a known-good run from before the migration if one is available in worker logs.

Do NOT skip this step — the network-write side effects are the highest-risk surface in this plan.

- [ ] **Step 9: Commit**

```bash
git add src/skills/posting-to-platform/ src/workers/processors/posting.ts src/tools/AgentTool/agent-schemas.ts
git rm -r src/tools/AgentTool/agents/posting
git commit -m "refactor(workers): migrate posting agent to posting-to-platform skill

Worker now invokes runForkSkill('posting-to-platform') instead of
loadAgentFromFile + runAgent. maxTurns preserved at 5. Direct-mode
posting (postViaDirectMode) unchanged — only the agent-mode branch
migrated.

Smoke-tested on a throwaway X account: post lands, schema parses,
verified=true. Behavior byte-identical to pre-migration."
```

---

### Task B5: Update UI agent stream taxonomy

**Context:** `src/hooks/use-agent-stream.ts:14` and `src/hooks/agent-stream-provider.tsx:57` define `AgentName = 'discovery' | 'content' | 'review' | 'posting'`. After B2 + B4 the names `'review'` and `'posting'` no longer correspond to agent IDs — they're now skill names. Decision: **keep the existing UI labels as-is.** They're SSE event keys for the activity feed, not agent identifiers. Renaming them would break the user-visible activity history. Just document why the labels survive.

**Files:**
- Modify: `src/hooks/use-agent-stream.ts` (add a comment)
- Modify: `src/hooks/agent-stream-provider.tsx` (add a comment)

- [ ] **Step 1: Add documentation comments**

In both files, find the `type AgentName = 'discovery' | 'content' | 'review' | 'posting'` declaration. Add a comment above it:

```ts
/**
 * SSE feed labels for the user-visible activity stream. These are NOT agent
 * registry names — 'review' and 'posting' map to the reviewing-drafts and
 * posting-to-platform fork-skills (post-migration 2026-04-30). Kept stable
 * to avoid breaking the activity history UI.
 */
type AgentName = 'discovery' | 'content' | 'review' | 'posting';
```

- [ ] **Step 2: Type-check**

```bash
pnpm tsc --noEmit --pretty false 2>&1 | head -10
```

Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add src/hooks/use-agent-stream.ts src/hooks/agent-stream-provider.tsx
git commit -m "docs(hooks): clarify SSE labels survive the skill migration

'review' and 'posting' are user-visible activity-feed labels, not
agent registry names. Stable across the trinity refactor."
```

---

### Task B6: Final cleanup of `agent-schemas.ts`

**Context:** After B2, B3, B4 each removed their entry, `src/tools/AgentTool/agent-schemas.ts` should still register the 6 surviving agents (`coordinator`, `growth-strategist`, `content-planner`, `post-writer`, `community-manager`, `discovery-agent`). Verify no orphan imports remain.

**Files:**
- Modify: `src/tools/AgentTool/agent-schemas.ts` (final tidy-up)

- [ ] **Step 1: Read the current state**

```bash
cat /Users/yifeng/Documents/Code/shipflare/src/tools/AgentTool/agent-schemas.ts
```

Confirm:
- Imports for `draftReviewOutputSchema`, `postingOutputSchema`, `engagementMonitorOutputSchema` are gone
- The `registry` object has exactly 6 entries
- The bottom re-exports list 6 schemas

- [ ] **Step 2: If any of the migrated schemas are still imported anywhere**

```bash
grep -rn "draftReviewOutputSchema\|postingOutputSchema\|engagementMonitorOutputSchema" /Users/yifeng/Documents/Code/shipflare/src --include="*.ts" --include="*.tsx" 2>/dev/null
```

Expected: no hits except in the new skill schema files (`reviewingDraftsOutputSchema` etc — different names). If any straggler exists, update it to the new skill schema name.

- [ ] **Step 3: Type-check + full test run**

```bash
pnpm tsc --noEmit --pretty false 2>&1 | tail -20
pnpm vitest run 2>&1 | tail -15
```

Expected: tsc clean, all tests pass.

- [ ] **Step 4: Commit (only if there were stragglers; otherwise skip the commit and finish)**

```bash
git add src/tools/AgentTool/agent-schemas.ts
git commit -m "chore(agents): tidy agent-schemas registry after worker→skill migrations"
```

---

## Self-review notes

**Spec coverage check:**
- §5.1 (delete `src/agents/`) → A5 + A6 + A7 + A8
- §5.2 (`ClassifyIntentTool` → skill) → **revised to delete-as-dead-code in A2** per planning-time finding
- §5.3 (`draft-review` → skill) → B2
- §5.4 (`posting` → skill) → B4
- §5.5 (`engagement-monitor` → skill) → B3
- §5.6 (architecture doc) → A1
- §6 (maxTurns preservation) → preserved verbatim in B2 (2), B3 (5), B4 (5)
- §7.1 (structured output gap) → resolved by `runForkSkill` taking an optional `outputSchema` (Task B1) — the runAgent-side StructuredOutput synthesis carries the contract end-to-end

**Beyond the spec:**
- Task A2 deletes 9 additional dead tools (Reddit/HN/X-read aggregates) discovered during the dead-code audit. The spec only flagged ClassifyIntentTool.
- Task A3 deletes `url-scraper.ts` (dead helper).
- Task A4 cleans stale references to non-existent agents (`discovery-scout`, `analytics-analyst`).

**Type consistency:**
- The 3 new skill schemas use new names (`reviewingDraftsOutputSchema`, `monitoringEngagementOutputSchema`, `postingToPlatformOutputSchema`) — no overlap with the deleted `agent-schemas` registry entries.
- `runForkSkill` returns `{result, usage}` matching the existing `runAgent` shape, so worker processor downstream code is unchanged.
- `AgentName` in the UI hooks intentionally retains `'review'` / `'posting'` for SSE feed compatibility (Task B5).

**Risk surface:**
- B4 (posting) is the only network-write task. Step 8 mandates manual smoke on a throwaway account.
- B2 / B3 are safe to roll back atomically — restore the deleted agent folder and revert the worker import.

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-04-30-tool-skill-agent-refactor-plan.md`. Two execution options:

**1. Subagent-Driven (recommended)** — fresh subagent per task, review between tasks, fast iteration. Best for the 14-task scope of this plan.

**2. Inline Execution** — execute tasks in this session using `superpowers:executing-plans`, batch execution with checkpoints for review.

Which approach?
