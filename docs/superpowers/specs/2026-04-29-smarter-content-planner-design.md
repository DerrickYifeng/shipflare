# Smarter Content Planner — Design

**Date:** 2026-04-29
**Owner:** ShipFlare Dev
**Status:** Spec — pending implementation

## Problem

The post-writer drafts each `content_post` plan_item in isolation. When
the tactical content-planner schedules multiple original posts in a week,
each post-writer call sees no awareness of its siblings or the founder's
recent X timeline. The result: shipped posts cluster on a single metaphor
(observed: two posts in one week both anchored on "marketing debt"), and
the week lacks pillar variety because the planner emits items without
diversity metadata.

The fix lives at the **planner**, not the writer. A smarter planner with
visibility into the X timeline and a 5-pillar mix constraint produces
diversified `plan_items.params`; the writer stays thin and per-item.

## Goals

- Content-planner reads the founder's last 14 days of X timeline and
  derives a `metaphor_ban` list per scheduled item.
- Each `content_post` plan_item carries a `pillar` from a 5-cluster
  vocabulary and a concrete `theme`, with hard cap of two of any pillar
  per week.
- Post-writer honors `pillar` / `theme` / `metaphor_ban` from
  `plan_items.params` as hard inputs alongside the lifecycle playbook.
- No DB migration. No new agents. Tools, not agents, carry the new
  capability.

## Non-goals

- Reddit equivalent. Defer until a `query_recent_reddit_posts` tool is
  ready alongside its own dataset of patterns.
- Caching the X API call. Planner runs roughly weekly per user; live
  reads are fine at that cadence.
- Engagement-weighted metaphor extraction in TypeScript. The planner
  LLM decides what to do with `metrics`.
- Persisting extracted metaphors. Extraction lives in the planner's
  LLM turn; nothing is written to a separate metaphors table.
- Backfill of in-flight `planned` plan_items without the new params.
  Writer falls back to phase defaults when fields are missing.

## Architecture overview

| Surface | Change |
|---|---|
| `src/tools/QueryRecentXPostsTool/QueryRecentXPostsTool.ts` (NEW) | Tool that returns the user's last N days of X tweets via `XClient.getUserTweets`. |
| `src/tools/registry.ts` | Register the new tool. |
| `src/tools/AddPlanItemTool/AddPlanItemTool.ts` | Extend `params` Zod schema with 5 new optional fields. |
| `src/tools/AgentTool/agents/content-planner/AGENT.md` | (a) `model:` haiku-4-5 → sonnet-4-6. (b) allowlist gains `query_recent_x_posts`. (c) workflow gains step 2.5. |
| `src/tools/AgentTool/agents/content-planner/references/tactical-playbook.md` | Add "Pillar mix and metaphor ban" section with the 5-pillar vocabulary, hard rules, and examples. |
| `src/tools/AgentTool/agents/post-writer/AGENT.md` | Step 3 reads `pillar` / `theme` / `metaphor_ban` from `plan_items.params`. |
| `src/tools/AgentTool/agents/post-writer/references/x-content-guide.md` | §5 preamble notes that planner-supplied `pillar` and `metaphor_ban` are hard inputs. |
| Tests | Tool contract test, schema test, structural playbook test, AGENT model pin. |

## What does NOT change

- DB schema. `plan_items.params` is JSONB; new fields are additive.
- `derivePhase`, `LaunchPhase` taxonomy, validator pipeline, draft
  persistence path.
- `community-manager` (replies stay per-thread per-draft).
- Number of agents. Still one content-planner, still one post-writer
  per item.
- Other planner inputs (`query_strategic_path`,
  `query_last_week_completions`, `query_stalled_items`,
  `query_recent_milestones`).

## The new tool: `query_recent_x_posts`

### Source

X API directly via `XClient.getUserTweets()` (already exists at
`src/lib/x-client.ts:304`). Catches manually-posted tweets that
ShipFlare's `plan_items` table doesn't know about, and returns
engagement metrics the planner can use to weight what to keep vs ban.

### Input schema

```ts
z.object({
  days: z.number().int().min(1).max(60).default(14),
}).strict()
```

### Output

```ts
{
  source: 'x_api',
  windowDays: number,
  tweets: Array<{
    tweetId: string,
    date: string,                  // ISO timestamp
    kind: 'original' | 'reply',
    body: string,
    metrics: {
      likes: number,
      retweets: number,
      replies: number,
      impressions: number,
    },
  }>,
  // When channel missing or API fails, tweets is [] and `error` carries
  // a reason code so the planner can mention it in `notes`.
  error?: 'no_channel' | 'token_invalid' | 'rate_limited' | 'api_error',
}
```

### Auth + lifecycle

- Resolves the user's X channel via standard `channels` query
  (`platform='x'`).
- Instantiates `XClient` via `createClientFromChannel('x', channel)`
  from `src/lib/platform-deps.ts` — the sanctioned helper.
- Calls `getMe()` once to resolve the numeric X user ID, then
  `getUserTweets(me.id, { maxResults: 30 })`.
- `XClient.ensureValidToken()` runs inside every method call;
  refresh handled centrally.
- `XClient.checkRate('get_tweets', 300)` already throttles.

### Edge cases

| Scenario | Behavior |
|---|---|
| User has not connected X | `tweets: [], error: 'no_channel'`. Planner runs without metaphor ban (pillar mix only). |
| X token expired and refresh fails | `tweets: [], error: 'token_invalid'`. Same fallback. Planner mentions in `notes`. |
| Zero tweets in window | `tweets: []`. Brand-new account flow. |
| 100+ tweets in window | Capped at `maxResults: 30` newest-first. Plenty of signal. |
| Replies mixed with originals | Both included, marked via `kind`. Planner weights as it sees fit. |

### What the tool deliberately does not do

- No metaphor extraction. The planner LLM extracts from the `body`
  field directly.
- No caching. Planner runs ~weekly; live reads are correct.
- No engagement ranking. `metrics` field is raw input; planner decides.
- No platform-agnostic shape. Tool is X-specific by design. Reddit
  equivalent is a sibling tool, not a superset.

## Plan-item params schema additions

In `src/tools/AddPlanItemTool/AddPlanItemTool.ts`, the `params` Zod
schema for `kind: 'content_post'` items gains five optional fields:

```ts
const contentPostParamsSchema = z.object({
  // Existing fields preserved as-is...
  pillar: z.enum([
    'milestone',
    'lesson',
    'hot_take',
    'behind_the_scenes',
    'question',
  ]).optional(),
  theme: z.string().min(1).max(120).optional(),
  arc_position: z.object({
    index: z.number().int().min(1),
    of: z.number().int().min(1),
  }).optional(),
  metaphor_ban: z.array(z.string().min(1).max(40)).max(20).optional(),
  cross_refs: z.array(z.string().uuid()).max(5).optional(),
}).passthrough();
```

All five fields are optional. `passthrough` preserves existing keys
(`targetCount`, etc.). In-flight items without these fields keep
working unchanged.

## Pillar vocabulary (closed set of 5)

| Pillar | What it is | When to pick |
|---|---|---|
| `milestone` | Concrete shipped thing or revenue/user number with proof. | Real numbers exist this week (revenue update, user count, feature shipped, fundraise). |
| `lesson` | One specific takeaway from a recent failure / win, generalizable to other founders. | Founder hit something that generalizes. |
| `hot_take` | Contrarian opinion on the indie meta with a defensible position. | Founder has a strong view and the audience is mature enough. |
| `behind_the_scenes` | Process / workflow / decision the audience doesn't normally see. | Build state, kill decisions, hiring, tooling choices. |
| `question` | Genuine ask the founder needs answered, audience can reply usefully. | Real choice in front of the founder. |

**Hard rule:** at most 2 plan_items per pillar in a 7-day window
**per channel**. X and Reddit are independent audiences — running
`milestone` twice on each channel in the same week is fine. The cap
is `≤ 2 of any pillar per channel`, NOT `≥ 1 of each` — empty
pillars are fine when input is missing.

**Naming note:** `pillar` (plan_item post-type, this 5-cluster
vocabulary) is distinct from `strategic_paths.contentPillars`
(3-4 free-form narrative themes set during onboarding). The
strategic-path pillars feed `theme` selection ("which topic"); the
plan_item pillar drives post shape ("which template"). Both can be
present on the same plan_item.

## Content-planner workflow change (one inserted step)

After step 2 (`query_strategic_path`), before items get scheduled,
insert step 2.5:

```
Step 2.5 — Read the X timeline and derive diversity inputs.

  a) Call query_recent_x_posts({days: 14}). If tweets[].length > 0:
     - Read all bodies. Identify 3-5 dominant metaphors / opening
       phrases / closing phrases used in the last 14 days.
     - Note which metaphors correlated with high engagement
       (metrics.likes + metrics.retweets * 3 > median across the
       returned set). Lean into those for current pillar selection.
       Flag the rest for ban.

  b) For each plan_item to be added this week:
     - Pick `pillar` from {milestone | lesson | hot_take |
       behind_the_scenes | question}. Hard cap: max 2 of any pillar
       per channel across the week's content_post items.
       Strategic-path's `contentPillars` is the narrative-theme
       library (e.g. "CI pain", "indie founder life") — feed it
       into `theme` selection. The plan_item `pillar` (this
       5-cluster vocabulary) drives post shape, not topic.
     - Pick `theme`: a concrete topic phrase (e.g. "first paying
       customer story", "killing feature X", "Stripe webhook
       gotcha"). Each item this week gets a distinct theme.
     - Compute `metaphor_ban`:
         union of:
           - metaphors extracted in step (a)
           - themes / key phrases of sibling plan_items already
             added in this turn
       Cap at 20 phrases per item.
     - Set `arc_position` to {index, of} reflecting placement.
     - Optional `cross_refs`: include only when the arc calls for
       an explicit callback (e.g. "Mon: shipped X. Wed: lesson
       from X." → Wed item cross_refs Mon's id).

  c) Persist via add_plan_item with the enriched params.
```

The detailed step lives in `tactical-playbook.md` as a new "Pillar mix
and metaphor ban" section. AGENT.md gets a one-line workflow update
pointing at it.

## Post-writer integration

In `src/tools/AgentTool/agents/post-writer/AGENT.md`, step 3 (drafting)
gains a paragraph:

> For X drafts, the plan_item's `params` may carry diversification
> inputs:
>
> - `pillar` — narrows the post-type list from x-content-guide §5
>   (e.g. pillar='lesson' → use lesson templates only).
> - `theme` — the concrete topic. Anchor the post on this; do not
>   drift into adjacent topics.
> - `metaphor_ban` — phrases the planner has flagged as recently
>   overused. Treat as hard exclusions: rewrite the draft if it
>   contains any banned phrase or its close synonym.
> - `cross_refs` — when set, look up those plan_items via
>   `query_plan_items` and lead with a callback ("yesterday I
>   shipped X — today's the part I didn't tell you").
>
> When `params` is empty (in-flight items predating the planner v2),
> fall back to the lifecycle playbook defaults.

`x-content-guide.md` gains a short note at the top of §5 that
planner-supplied `pillar` + `metaphor_ban` are hard inputs, not
suggestions.

## Sibling tracking inside the planner's turn

The planner adds plan_items sequentially via `add_plan_item`. Sibling
tracking happens inside the agent's own LLM context — sonnet sees what
items it has added so far in this turn and feeds metaphors of those
siblings forward when computing `metaphor_ban` for later items. No
separate "in-flight items" query needed.

## Risks and mitigations

| Risk | Mitigation |
|---|---|
| Sonnet drift softens pillar mix / metaphor extraction over time. | `metaphor_ban` array is reviewable in `plan_items.params`. PR template includes a manual smoke pass per phase. |
| X API rate limit / token revocation blocks the planner. | Tool catches errors and returns `{ tweets: [], error }`. Planner proceeds without metaphor ban, surfaces the error in `notes`. |
| `metaphor_ban` saturates after months of posting. | Hard cap of 20 phrases per item. Playbook instructs: "if the ban list saturates the available themes, trust the most recent (≤14 day) overlap and let older patterns recycle." |
| Pillar cap forces an unnatural post when input is missing. | The cap is `≤ 2 of any pillar`, not `≥ 1 of each`. Empty pillars are allowed. |
| Sonnet content-planner cost rises vs haiku. | Planner runs ~weekly per active user; marginal cost dominated by reading recent posts + strategic path. Acceptable. |
| In-flight `planned` items without the new params confuse the writer. | Writer falls back to phase defaults when `params.pillar` / `metaphor_ban` are missing. No backfill needed. |

## Out of scope (follow-ups)

1. Reddit equivalent — `query_recent_reddit_posts` tool +
   reddit-content-guide §5 hardening. Defer until dataset exists.
2. Engagement-weighted metaphor extraction in TypeScript. Promote
   from LLM-side to deterministic ranker only if the planner
   consistently fails to lean into high-engagement metaphors.
3. Caching `query_recent_x_posts`. Only matters if planner runs
   multiple times an hour.
4. `query_recent_x_replies` — sibling tool for community-manager so
   reply patterns are also diversified.
5. Persisting metaphor extraction to a structured table for UI
   surfacing.
6. Cross-product theme libraries (when ShipFlare grows multi-product
   per founder, X channel filter by `productId`).
7. Pillar mix metrics in /today header for founder visibility.

## Testing strategy

| Test | File | Why |
|---|---|---|
| `query_recent_x_posts` returns shape correctly with stubbed `XClient` (happy path + no-channel + token-invalid + rate-limited) | `src/tools/QueryRecentXPostsTool/__tests__/QueryRecentXPostsTool.test.ts` (NEW) | Tool contract; covers all four edge cases. |
| `add_plan_item` accepts the 5 new optional fields and rejects malformed values (out-of-enum pillar, oversized metaphor_ban, etc.) | `src/tools/AddPlanItemTool/__tests__/AddPlanItemTool.test.ts` (extend) | Schema validation. |
| Tactical-playbook contains the "Pillar mix and metaphor ban" section + 5 pillar names + the hard cap rule | `src/tools/AgentTool/agents/content-planner/references/__tests__/tactical-playbook.test.ts` (NEW) | Structural test, like `x-content-guide.test.ts`. Catches drift. |
| Content-planner AGENT.md model pin equals `claude-sonnet-4-6` and tool allowlist contains `query_recent_x_posts` | extend existing `loader-smoke` test for content-planner if present, else NEW | Prevents rollback regression. |
| Post-writer reads `pillar` / `metaphor_ban` from `params` (live integration test against in-memory store) | `src/tools/AgentTool/agents/post-writer/__tests__/...` (extend) | End-to-end behavior; ensures the writer treats the fields as inputs. |

What is explicitly NOT tested:
- LLM output quality (sonnet drift). Manual smoke pass.
- Live X API responses. `XClient` is stubbed.
- Pillar mix in production. Manual eyeball after one week of running.

### Manual smoke pass

Before merge: run the planner against an account with 14 days of
"marketing debt"-flavored history. Confirm:
- New week's `plan_items` carry `pillar` mix with ≤ 2 of any pillar.
- `metaphor_ban` arrays include "debt", "compound", "owe", or close
  synonyms drawn from the timeline.
- Drafts produced by the writer for those items DO NOT echo the
  banned metaphors.
- For a control account with empty X history, planner still produces
  a valid week (just without metaphor ban).

## Acceptance

- [ ] `src/tools/QueryRecentXPostsTool/QueryRecentXPostsTool.ts`
      created and registered in `tools/registry.ts`.
- [ ] `AddPlanItemTool` accepts the 5 new optional `params` fields,
      all validated.
- [ ] Content-planner's `AGENT.md` model is `claude-sonnet-4-6`,
      allowlist gains `query_recent_x_posts`, workflow gains
      step 2.5.
- [ ] `tactical-playbook.md` carries the new "Pillar mix and metaphor
      ban" section with the 5-pillar vocabulary.
- [ ] Post-writer's `AGENT.md` reads new `params` fields;
      `x-content-guide.md` §5 acknowledges them as hard inputs.
- [ ] Structural / contract / schema tests pass.
- [ ] Manual smoke pass per the playbook above.
- [ ] No DB migration. No new agents. No validator changes.
