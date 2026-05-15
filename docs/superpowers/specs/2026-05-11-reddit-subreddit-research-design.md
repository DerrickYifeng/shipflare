# Reddit subreddit research at kickoff + plan-time binding

**Date:** 2026-05-11
**Author:** Yifeng (PM/eng) + Claude
**Status:** DRAFT
**Branch:** dev

## Problem

Reddit content_post plan_items are being created without a concrete target subreddit. The planner template at `src/skills/allocating-plan-items/references/phase-task-templates.md` sets `params: { angle, format }` for content_post and never sets `params.subreddit`. The drafting agent then picks a subreddit implicitly in the body text (e.g. "Foundation-phase post, targeting r/indiehackers and r/SaaS") but `drafting-post`'s output schema (`src/skills/drafting-post/schema.ts:42-55`) has no field for chosen subreddit, so nothing writes back. By the time the founder clicks **Post** in `/today`:

1. `loadDispatchInputForDraft` reads `draft.subreddit = thread.community` → `null`
2. `dispatchApprove` throws `"Reddit post requires subreddit (draft …)"` at `src/lib/approve-dispatch.ts:77`
3. Founder gets a 500

This is structural, not a glitch — the data flow has no place to record the chosen subreddit, so any Reddit content_post is one click away from a crash.

The fix is to **move subreddit selection from draft-time (implicit, lost) to kickoff-time (explicit, persisted)**. At kickoff we research the product's ICP communities on Reddit using the same xAI Grok + reddit.com filter pattern that `find_threads_via_xai` uses for reply discovery. We pick top-3 fit subreddits, persist them product-scoped, and the planner binds each Reddit content_post to one of those three at `add_plan_item` time. Drafting reads `params.subreddit` directly (already supported in `ProcessPostsBatchTool:271-284`); dispatch always has a subreddit; the 500 path becomes unreachable.

## Decision

Ship subreddit research as a kickoff prerequisite, persisted at the product scope. Auto-select top-3 by LLM-evaluated ICP fit, surface in onboarding/settings for the founder to override.

Concrete shipping changes:

1. **New table `product_reddit_channels`** — product-scoped, persistent, edit-friendly. Columns: `subreddit`, `memberCount`, `fitScore` (0..1), `rulesSummary` (text), `activity` (jsonb with `postsLast7d / commentsLast7d / medianUpvotes`), `rank` (1..N display order), `source` (`auto` / `manual`), `disabled` (soft-hide without losing context), `lastUsedAt` (for round-robin), audit timestamps. Unique `(productId, subreddit)`.
2. **New bundled skill `researching-reddit-channels`** — single xAI Grok call (Responses API, `web_search` with `allowed_domains: ['reddit.com']`) that takes product name + description + value prop + ICP signal and returns N=6 candidate subreddits. Same call shape as `find_threads_via_xai` minus the multi-round refinement (one pass is enough — subreddits are stable, threads aren't). Output: `[{ subreddit, memberCount, rulesSummary, activity, fitRationale }]`. The fit field is computed in-fork by the LLM evaluating product/audience match.
3. **New BullMQ worker `reddit-channel-research`** — payload `{ userId, productId, force?: boolean }`. Runs the bundled skill, enriches member counts + recent activity by calling `RedditClient.appOnly()` (the existing public-read path), sorts by `fitScore DESC`, writes top-3 to `product_reddit_channels` with `source='auto'`. Idempotent on `(productId)`: if non-empty rows exist and `force=false`, no-op. Triggered on onboarding commit when Reddit is a selected channel, and from a "Re-research" button in settings.
4. **Kickoff goal text** — `team-kickoff.ts:buildKickoffGoalText` reads `product_reddit_channels` for the product and injects an `Available subreddits` section. Coordinator instructions: "When adding `content_post` rows where `channel='reddit'`, set `params.subreddit` to one of [r/sub1, r/sub2, r/sub3] rotating evenly across the week's Reddit posts (by `sortOrder`)." When the table is empty (reddit not selected, or research not yet complete), the kickoff goal omits the Reddit `content_post` spawn and includes a one-line note for the founder.
5. **Schema enforcement** — `contentPostParamsSchema` in `src/tools/schemas.ts:216` adds an optional `subreddit: z.string().min(1).max(60).optional()`. `AddPlanItemTool` adds a server-side validation: if `kind='content_post' AND channel='reddit'`, `params.subreddit` MUST be present. Validation error is a 4xx the coordinator can recover from, not a 500.
6. **Onboarding/settings UI** — a card on `/onboarding/research` (new step between connect-channels and goals) shows research status: `pending` (spinner) → `done` (top-3 list with member count, fit score, rules summary, swap/disable affordances) → `failed` (xAI error, retry button). Same component re-rendered at `/settings/reddit-channels` for ongoing edits.
7. **Planner safety net** — if for any reason a Reddit `content_post` is created without `params.subreddit` (legacy rows or future bugs), `/today` surfaces it as `needs_attention` with an inline subreddit picker fed by `product_reddit_channels`. No more 500.
8. **Drop the stuck draft** — the existing failing draft `233588e6-0281-4da7-9d85-9d18c48a81fb` is deleted (DELETE drafts + threads, UPDATE plan_items state='skipped'). After the kickoff-research lands, re-plan the week and let it regenerate the slot with a real subreddit.

## Premises (agreed during brainstorming, 2026-05-11)

1. **Storage scope is product, not plan.** Subreddits don't change week-over-week unless the founder changes them; the research cost (one xAI call, 10-20s, ~$0.05) shouldn't repeat per re-plan. Re-plans read from `product_reddit_channels`; manual "Re-research" is an explicit settings action.
2. **Auto-select with founder override.** Kickoff doesn't pause for founder approval. Top-3 chosen by `fitScore DESC` and persisted. Founder sees them in onboarding (post-kickoff) and settings; can swap, disable, or add manual entries. Matches existing onboarding philosophy of "do the work, show the work, let the founder correct it" (same pattern as the strategic path picker).
3. **All four research signals are required: name + member count, rules summary, 7-day activity, ICP fit score.** Decided during brainstorming. Member count + rules give the founder the trust signal; activity tells the planner whether posting there will be seen; fit score is the ordering field.
4. **xAI single-pass beats reddit-direct multi-round for subreddit discovery.** Subreddits are stable entities (unlike thread queues), so refinement adds no value. Same call shape as `find_threads_via_xai` minus the loop. Reddit-direct enrichment is used only for the deterministic fields (member count, recent post count) where we'd rather trust the API than trust the LLM to count.
5. **Existing stuck plan_items are dropped, not migrated.** Per `[[feedback_refactor_over_patch_when_architectural]]` (2026-05-11): when a bug surfaces an architectural gap, drop stuck data and let the new code path regenerate. The 233588e6 draft is the only one we know about; if more exist they'll surface in `/today` after the planner safety net (item 7) lands.
6. **`contentPostParamsSchema` is the contract.** The schema-passthrough behavior that lets unknown params keys flow through is a debt — once we require `params.subreddit` for Reddit content_post, we tighten this. Any future channel-specific required param goes here too.
7. **Reddit-only feature.** This spec does not touch X content_post (X has no subreddit equivalent; the X "where to post" decision is the user's profile, not a community). The schema migration adds a Reddit-only column, and the planner branches on `channel='reddit'` for the binding rule.

## Approaches considered

### A — Defensive read of multiple param keys at draft / dispatch time [REJECTED]

Accept `params.subreddit` or `params.targetSubreddit` in `synthesize-content-post-draft.ts`, fall back to `output.targetSubreddit`, fall back to `product.defaultSources[0]`. Cheapest to ship; no schema change.

Rejected because the data flow ends in a missing-field error — the planner doesn't pick a subreddit, the drafting agent picks one implicitly in body text, nothing persists it. Fallback readers paper over the missing producer but don't add one. The next time a planner template changes, the same class of bug returns. Per the user's 2026-05-11 standard: refactor over patch when the gap is architectural.

### B — Have drafting-post output the chosen subreddit [REJECTED]

Add `chosenSubreddit: z.string()` to `draftingPostOutputSchema`. `DraftPostTool` writes it to `plan_items.output.subreddit`. Synthesize reads from output instead of params.

Rejected because the subreddit choice belongs upstream of drafting — it informs `get_subreddit_rules` (already), the drafting voice (per `reddit-post-voice.md`), and ideally the post format (a how-to lands differently in r/SaaS than r/indiehackers). Letting the drafter decide means rules-check happens against the agent's late choice, the body is written without knowing the audience until mid-thought, and we have no way to plan around community-level cooldowns. Move the decision to the planner.

### C — Subreddit research at kickoff, persist product-scoped, planner binds at add_plan_item [SELECTED]

Run subreddit research once per product (re-runnable). Persist top-3 with rich metadata. Planner reads from the table and binds each Reddit content_post to a subreddit by round-robin. Drafting receives `params.subreddit` directly. Dispatch never lacks a subreddit.

Selected because (a) the decision lives where the strategic context lives — at planning time, alongside cadence and channel mix; (b) the cost is paid once and reused; (c) the schema captures the decision rationale (fit score, activity, rules) so the founder can audit and override; (d) the planner can implement "don't post in r/SaaS twice in a week" trivially as a `lastUsedAt` query; (e) it composes with the existing pattern (`get_subreddit_rules` already runs at draft-time; we just give it a deterministic input).

### D — Plan-scoped research that re-runs every re-plan [REJECTED]

Persist subreddits on the `plans` row. Re-plan reruns the xAI research.

Rejected on cost (every re-plan is +20s + $0.05) and on staleness signal (the founder pruning a subreddit gets clobbered on next re-plan unless we add reconciliation logic). The product-scoped table is the simpler durable home; refresh is a manual action.

### E — Cron-based refresh of product_reddit_channels [DEFERRED]

A nightly or weekly cron re-runs research, surfaces drift (member count plummets, fit score drops because the community moved on). Forward-compatible — the table schema supports it.

Deferred. We don't yet know whether subreddits decay fast enough to justify the cron. Ship explicit "Re-research" in settings first; revisit when retention data shows drift cost > cron complexity.

### F — Drafting agent picks subreddit from a candidate list [REJECTED]

Pass the top-3 to drafting-post and let the LLM decide which to target based on the angle/format/recent activity.

Rejected because the planner can do this deterministically with `lastUsedAt` and fit-score-weighted round-robin. The LLM doesn't have access to which subreddits this product has already posted in this week — that's a SQL query, not a vibe. Determinism beats per-call LLM judgment for a decision this regular.

### G — Founder confirms top-3 in onboarding before kickoff fires [REJECTED]

Pause the onboarding wizard on a "Confirm your Reddit communities" step. Show top-3 with rich preview. Continue button writes selections and triggers kickoff.

Rejected because (a) onboarding flow is already 4 steps and the user wants less friction, not more; (b) the founder may not know which subreddits are best at this stage (that's why we did the research); (c) the settings page is the durable affordance for overrides — they can correct on their own time without a UI block. Matches the same auto-select philosophy as the strategic-path picker.

## Architecture

### Data flow

```
Onboarding commit ──┐
                    │ if channels.includes('reddit'):
                    │   enqueueRedditChannelResearch({ userId, productId })
                    ▼
        BullMQ worker reddit-channel-research
                    │
                    ▼
   researching-reddit-channels (bundled skill)
                    │
                    │  xAI Grok Responses API:
                    │    model = grok-4.20-non-reasoning
                    │    tools = [{ type: 'web_search', allowed_domains: ['reddit.com'] }]
                    │    structured output = [{ subreddit, memberCount, rulesSummary, activity, fitRationale, fitScore }]
                    ▼
   Reddit-direct enrichment (RedditClient.appOnly()):
     for each candidate:
       /r/<sub>/about.json → subscribers (overwrite if more accurate)
       /r/<sub>/new.json?limit=50 → activity counters
                    │
                    ▼
   Persist top-3 by fitScore DESC → product_reddit_channels
   source='auto', rank 1/2/3, disabled=false
                    │
                    ▼
   Onboarding /research page polls until rows appear (SWR; refreshInterval: 3s
   while pending, stop polling when 3 rows exist)
                    │
                    ▼
   /team mount → ensureKickoffEnqueued
                    │
                    │  buildKickoffGoalText reads product_reddit_channels
                    │  injects "Available subreddits: [r/a (fit 0.9), r/b (fit 0.85), r/c (fit 0.75)]"
                    │  injects "When adding reddit content_post rows, set params.subreddit
                    │  by rotating through the list (sortOrder 0→a, 1→b, 2→c, 3→a, …)"
                    ▼
   Coordinator calls add_plan_item({
     kind: 'content_post', channel: 'reddit',
     params: { angle: 'story', format: 'lesson', subreddit: 'SaaS' }, …
   })
                    │
                    │  contentPostParamsSchema validates subreddit is present
                    │  for Reddit content_post (server-side, hard)
                    ▼
   plan_items row has params.subreddit
                    │
                    ▼
   ProcessPostsBatchTool reads params.subreddit (already supports this)
   → drafting-post receives targetSubreddit
   → get_subreddit_rules runs against the planned sub
   → DraftPostTool writes to plan_items.output.draft_body
                    │
                    ▼
   /today approve flow:
   synthesize-content-post-draft reads params.subreddit
   → thread.community = subreddit
   → loadDispatchInputForDraft returns input with subreddit
   → dispatchApprove returns { kind: 'handoff', intentUrl: buildRedditSubmitUrl(...) }
   → UI window.open's the Reddit submit URL
```

### Failure modes

1. **xAI returns 0 candidates.** Write zero rows. Onboarding `/research` shows "Reddit research found no strong matches" with a manual-add affordance. Planner skips Reddit content_post until at least one row exists. Founder can re-research after editing the product description.
2. **xAI returns < 3 candidates.** Persist whatever it returned. Planner rotates among the smaller pool. Onboarding UI suggests adding manual entries to reach 3.
3. **Reddit enrichment fails (member-count fetch errors).** Persist the row with `memberCount=NULL`, `activity=NULL`. The fit score from xAI stays. UI shows "—" for missing fields with a "Retry enrichment" link.
4. **Research takes longer than the founder sits on `/research`.** SWR polling continues client-side; if the founder navigates away and back, the page resumes the polling. Server-side, the job has a 60s soft-budget; if it OOMs/timeouts, the worker writes a `research_status` row (separate table or product column) with `status='failed'` so the UI can show a retry button.
5. **Reddit content_post added without `params.subreddit` somehow.** Hard rejected by `contentPostParamsSchema` at `add_plan_item` time. If somehow it slips through (DB direct write, migration), `/today` PostCard surfaces a "Pick a subreddit" inline picker before the Post button activates. No 500 path.
6. **All three top-3 disabled by founder, no manuals added.** Planner skips Reddit content_post until at least one active row exists. `/today` shows a banner: "Reddit posts paused — open settings to enable a subreddit."

### Round-robin allocation

When the coordinator adds N Reddit content_post rows for the week, assign `params.subreddit` by:

```
sortedActiveSubs = SELECT subreddit FROM product_reddit_channels
                   WHERE product_id = ? AND disabled = false
                   ORDER BY rank ASC

for i, planItem in enumerate(redditContentPosts):
    planItem.params.subreddit = sortedActiveSubs[i % len(sortedActiveSubs)]
```

The simplest possible thing. `lastUsedAt` and fit-score-weighted rotation are deferred until we see retention data on whether even rotation creates over-posting in any single sub.

### Migrations

1. `drizzle/NNNN_product_reddit_channels.sql` — CREATE TABLE with the columns + indexes + unique (productId, subreddit).
2. `drizzle/NNNN_content_post_params_require_subreddit.sql` — no SQL change needed (the schema is enforced in Zod at the application layer, not the DB column).
3. No backfill. Existing plan_items either:
   - Already have `params.subreddit` (none expected — none of the planner templates set it) → unaffected.
   - Don't (the 233588e6 case) → explicit DELETE + state='skipped' via the SQL in the spec workflow.

## Out of scope

- Reddit OAuth, direct-post via Reddit API, browser extension. Handoff stays the only Reddit write path (see `2026-05-07-reddit-channel-handoff-design.md`).
- Cron-based refresh of `product_reddit_channels`. Manual "Re-research" only for v1.
- Per-subreddit posting cooldowns and frequency caps. Deferred.
- Multi-product support (a single user with multiple products). Today's table model handles it correctly (productId FK) but the UI is single-product.
- X equivalent. X has no community concept; "where to post" is just the user's own timeline.
- Reply discovery. `find_threads_via_xai` already covers Reddit reply discovery; the bundled skill here is read-only on the same xAI tool surface but with a different query shape and persistence target.

## Acceptance criteria

A Reddit content_post created by the kickoff coordinator on a freshly-onboarded product reaches `posted` state without any server error:

1. Founder completes onboarding with Reddit in the channel mix.
2. `reddit-channel-research` worker runs, writes 3 rows to `product_reddit_channels` with `source='auto'`.
3. Onboarding `/research` page shows the three communities with member count, fit score, rules summary, activity. Founder can swap, disable, or add manual.
4. /team kickoff fires, coordinator adds Reddit content_post plan_items with `params.subreddit` set on every row.
5. Sweeper drafts the posts; founder sees them in `/today` with the target subreddit shown on the card.
6. Founder clicks Post; UI opens `https://www.reddit.com/r/<sub>/submit?type=text&title=...&selftext=...` in a new tab; draft is `handed_off`.
7. No 500 from `dispatchApprove`. No fallback subreddit-reading code is added or relied on.
8. Re-running kickoff is a no-op on the table (idempotent on `(productId)` per Premise 1).
