# Patterns and examples

Concrete examples showing how to combine your tools for common situations. The CMO will name the situation in the spawn prompt; pick the closest pattern, adapt as needed. **You are not required to follow these step-by-step** — they show the *kind* of move, not a recipe.

## Reading the spawn prompt

Your spawn prompt always carries a structured `channel:` field (`x` or `reddit`) alongside `Mode:`, `planItemId:`, and `targetCount:`. **This is the single source of truth for which platform to discover against** — pass it through verbatim as `find_threads_via_xai({ platform })`. Don't infer the channel from the description string ('fill x reply slot'), from `Channels connected`, or from which platform sounds more relevant — the prompt told you.

### Pattern: discover threads, then fill a reply slot

The CMO has a `content_reply` plan_item that needs threads sourced and replies drafted. You over-fetch via discovery (so the judging filter has room to be picky), then pass the top picks to the batch reply tool.

Spawn prompt example:

```
Mode: discover-and-fill-slot
channel: x
planItemId: 1862-…-c1f9
targetCount: 8
```

You: I'll source threads first, then draft replies for the strongest 3.

  find_threads_via_xai({ trigger: 'daily', maxResults: 6, platform: 'x' })   ← read `channel: x` from the prompt
  → { queued: 5, scanned: 14, topQueued: [{threadId, url, ...} × 5], scoutNotes: 'tightened bio filter; competitor accounts dropped' }

  process_replies_batch({ threadIds: ['t-a', 't-b', 't-c'] })
  → { itemsScanned: 3, draftsCreated: 3, draftsSkipped: 0, notes: 'no slop patterns matched' }

You (StructuredOutput): Sourced 5 threads, drafted replies for 3. All in /briefing for review.

**Reddit variant.** When the spawn prompt says `channel: reddit`, pass `platform: 'reddit'` so discovery uses xAI `web_search` against reddit.com instead of `x_search`:

Spawn prompt:

```
Mode: discover-and-fill-slot
channel: reddit
planItemId: a6071e9a-…-2c8
targetCount: 3
```

  find_threads_via_xai({ trigger: 'daily', maxResults: 6, platform: 'reddit' })
  → { queued: 4, scanned: 9, topQueued: [{threadId, url: 'https://reddit.com/r/SaaS/...', ...} × 4], scoutNotes: 'r/SaaS + r/indiehackers strong; r/Entrepreneur thinner' }

  process_replies_batch({ threadIds: ['t-r1', 't-r2', 't-r3'] })  // batch tool reads channel from each thread row

**The X variant and Reddit variant are symmetric.** A `channel: x` spawn against the X slot uses `platform: 'x'`. Calling discovery with the wrong platform produces drafts under the wrong slot — production has seen 8 X-slot drafts land in the Reddit slot (Reddit overflowed by 8, X showed 0/8 drafted) because the agent inferred the platform from `Channels connected` instead of reading `channel:`. Don't repeat that.

### Pattern: thread list already provided

The founder DM'd a thread URL through the CMO, OR the coordinator's daily playbook handed you topQueued from a prior discovery. No discovery needed — straight to drafting.

You: process_replies_batch({ threadIds: ['t-x'] })
  → { draftsCreated: 1 }

You: Drafted 1 reply for the @founder thread; in /briefing for review.

### Pattern: scheduled posts (post batch)

The sweeper or coordinator handed you plan_item IDs that hit their `dueDate`. Just run the batch tool — the tool persists drafts and flips state to `drafted` itself.

You: process_posts_batch({ planItemIds: ['p1', 'p2', 'p3', 'p4', 'p5'] })
  → { draftsCreated: 5, draftsSkipped: 0 }

You: Drafted 5 posts for this week. They'll appear in /briefing scheduled for their respective dates.

### Pattern: open scan (no input — fallback when no slot exists)

Coordinator's daily playbook hit the fallback branch (no `content_reply` plan_items today). Pull top inbox threads and draft for what's there.

You: find_threads({ platforms: ['x', 'reddit'], limit: 3 })
  → 3 thread rows

  process_replies_batch({ threadIds: ['t-a', 't-b', 't-c'] })
  → { draftsCreated: 2, draftsSkipped: 1, notes: 'one fortune_cookie_closer' }

You: Pulled 3 inbox threads, drafted 2 replies (1 skipped on slop pattern).

### Pattern: research reddit subreddits (Mode: research-reddit-channels)

The kickoff coordinator spawned you with `Mode: research-reddit-channels` because no auto subreddits exist yet for the product. Single tool call, single pass — do not draft posts, do not call other tools.

You: research_reddit_channels({ force: false })
  → { subreddits: [{ subreddit: 'SaaS', rank: 1, fitScore: 0.91 }, { subreddit: 'indiehackers', rank: 2, fitScore: 0.85 }, { subreddit: 'microsaas', rank: 3, fitScore: 0.72 }], written: 3 }

You (StructuredOutput): Return the `subreddits` array verbatim so the coordinator can inline the names into subsequent `add_plan_item` calls (rotate `params.subreddit = subreddits[sortOrder % subreddits.length].subreddit`, bare name, no `r/` prefix).

### Pattern: founder asks a question via the CMO

Sometimes the spawn prompt isn't a work order — it's a question the CMO routed to you because it's about voice or community ("does this draft sound like our voice?", "should we engage with @x's post?"). Answer in plain prose. Don't run a tool unless the question requires drafting work.

You: That account's been promoting their own SaaS in every comment thread for the last week — not a fit for our voice. Recommend we skip and look for active product builders instead. Want me to run a discovery pass with a different intent?

## Slop discipline (non-negotiable)

Every reply / post the batch tools produce runs the writer's own `slop-rules` shared reference plus an in-fork self-audit (see `drafting-reply` / `drafting-post` SKILL.md). The batch tools then run a deterministic mechanical `validate_draft` (length, banned-vocab regex). There is NO second LLM-validation fork — the trade-off was made in favor of recall over precision; the founder reviews surviving drafts in `/briefing`. If you notice patterns of slop slipping through batch outputs, flag them in your StructuredOutput's `notes` so the founder can tune the drafting prompts.

## Channel discipline

The batch tools read `channel` (x | reddit | linkedin | etc.) from the thread / plan_item row. You don't need to set it. If the spawn prompt asks you to change channel ("repost this on LinkedIn"), update the source row first via the appropriate tool — don't try to override on the call.
