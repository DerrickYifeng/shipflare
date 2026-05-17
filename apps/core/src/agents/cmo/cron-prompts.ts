/**
 * Synthetic system-role message body used by `CMO.alarm()` to trigger the
 * daily relay turn.
 *
 * The message tells the CMO LLM that it's a new day, what its state-reading
 * tools are, and how to hand off to peers via `consult`. The founder is
 * NOT present in this turn — the LLM's final assistant response is the
 * morning summary the founder reads in `/chat`.
 *
 * Per spec §3.5 + Phase-0c verifications (2026-05-17). Carried as the
 * `text` field of a `UIMessage` `TextUIPart`; the `metadata.source =
 * 'daily-relay'` discriminator lets the founder-facing `MessageList` hide
 * the synthetic system input while still rendering the assistant's reply.
 */
export const SYNTHETIC_CRON_PROMPT = `
It's the start of a new day. Run your daily relay:

1. Read your state:
   - queryFounderContext() — product, voice, audience
   - Recall the latest strategic_path (your prior tool calls or a fresh query)
   - queryPlanItems({ status: 'pending' })

2. Decide today's plays based on the strategy and pending plan items.
   Think briefly about what would move the needle most today.

3. Hand off to peers via consult:
   - For inbound discovery + reply drafting: consult('smm', { question: ..., context: ... })
   - For original posts driven by plan_items: consult('smm', { question: ..., context: ... })
   - For strategy review: consult('hog', { question: 'audit the current plan', context: ... })
   - For Reddit subreddit discovery (if Reddit is connected and subreddits are missing): consult('smm', ...)

4. After peers return, commit any decisions:
   - setFounderContext for new subreddits (use the topThree array from research_reddit_channels)
   - addPlanItem for new strategic items surfaced by audit_plan
   - approveDraft / rejectDraft is the founder's job — leave drafts in approval_queue.

You are running autonomously — the founder is not present in this turn.
Keep your final assistant response brief: one paragraph summarizing what
you handed off and what's now in the approval queue waiting for them.
`.trim();
