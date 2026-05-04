# X conversation context for reply drafting

**Status:** Draft (brainstorm-approved 2026-05-04)
**Scope:** X only. Reddit out of scope; revisit when X ships.

## Problem

Discovery surfaces an X tweet, drafting-reply writes a reply against
just that tweet's body. When the surfaced tweet is a **quote tweet**
or itself a **reply** in a chain, the drafter has no visibility into
the quoted/parent post, so the reply lands flat or off-context.

Concrete failure (2026-05-04, Anum's tweet):

- Outer tweet: "Marketing has been by far the biggest frustration of
  being an indie dev. Tried Apple Search Ads, Meta, SEO, influencers…"
  (a marketing-pain gripe)
- Outer **self-quotes** an earlier Anum tweet: "OMG this actually
  worked — the database is complete now so I told Claude to use it to
  make a video of most viral moments…" (a celebration of a *different*
  win)
- Drafter saw only the outer body and wrote: "Apple Search Ads, Meta,
  SEO, influencers — running that gauntlet costs money and months.
  curious what the breakthrough was." Reasonable for the outer alone,
  but it ignores that Anum is mid-celebration and connecting the two
  arcs herself.

The drafter needs the quoted/parent text to write a context-aware reply.

## Decision summary

- **Capture path: ask xAI Grok during search.** Extend
  `tweetCandidateSchema` with `quoted_text`, `quoted_author`,
  `in_reply_to_text`, `in_reply_to_author`. No extra X API call. If
  Grok hallucinates the quoted body, the failure mode is the same as
  today (founder rejects in `/today`).
- **Trust posture for self-quotes: same as cross-author quotes.** No
  `is_self_quote` boolean; the drafter derives self-quote from
  `quoted_author == author`.
- **Use path: drafter only.** judging-thread-quality stays loose
  (recall > precision, per 2026-05-03 stance). Quote/parent context is
  used only by `drafting-reply`. We do not gate at the judge step.
- **No backfill.** Existing `threads` rows age out within hours.

## Data flow

```
xAI Grok ──┐
           │ tweetCandidate now includes:
           │   quoted_text / quoted_author          (when outer quote-tweets)
           │   in_reply_to_text / in_reply_to_author (when outer is a reply)
           ▼
persist_queue_threads
           │ writes 4 new nullable columns to `threads`
           ▼
threads table
           │ + quoted_text, quoted_author,
           │   in_reply_to_text, in_reply_to_author
           ▼
judging-thread-quality   ← unchanged
           │
           ▼
ProcessRepliesBatchTool
           │ SELECT now includes the 4 new cols
           │ passes them into drafting-reply.thread.{...}
           ▼
drafting-reply (schema + prompt + reference updated)
           │ self-audit gains a "context-awareness check"
           ▼
draftBody (now reflects the conversation)
```

## Schema changes

### `src/tools/XaiFindCustomersTool/schema.ts`

Extend `tweetCandidateSchema`:

```ts
quoted_text: z.string().nullable(),
quoted_author: z.string().nullable(),
in_reply_to_text: z.string().nullable(),
in_reply_to_author: z.string().nullable(),
```

All four nullable. Standalone tweets have all four `null`.

### `src/lib/db/schema/channels.ts` — `threads` table

Four new nullable columns:

```ts
quotedText: text('quoted_text'),
quotedAuthor: text('quoted_author'),
inReplyToText: text('in_reply_to_text'),
inReplyToAuthor: text('in_reply_to_author'),
```

No index. These are only read in row-fetch projections, never as
predicates. Drizzle migration generated via `pnpm db:generate`.

### `src/skills/drafting-reply/schema.ts`

Extend `thread` object:

```ts
quotedText: z.string().nullable().optional(),
quotedAuthor: z.string().nullable().optional(),
inReplyToText: z.string().nullable().optional(),
inReplyToAuthor: z.string().nullable().optional(),
```

`judging-thread-quality/schema.ts`: **unchanged.**

## Prompt updates

### xAI first-turn message (`buildFirstTurnMessage`)

Append to the per-tweet field list:

```
- For each tweet, if it QUOTES another tweet, include:
    quoted_text         (the quoted post body, verbatim)
    quoted_author       (the quoted author's @handle, no @)
  If it is a REPLY in a thread, include:
    in_reply_to_text    (the parent post body, verbatim)
    in_reply_to_author  (parent author's @handle)
  Leave any of these null when not applicable. A standalone tweet has
  all four null. A self-quote (quoted_author == author_username) is
  allowed and common — surface it.
```

### `drafting-reply/SKILL.md` — Inputs section

Document the four new optional `thread.*` fields with the self-quote
caveat (see Section 3 above).

### `drafting-reply/SKILL.md` — Self-audit step 6 (NEW)

```
6. **Context-awareness check** — if quotedText or inReplyToText is
   non-null, does your draft reflect awareness of that other post?
   Generic acknowledgment ("love your work") doesn't count. Either
   reference a concrete detail from the quoted/parent post, OR write a
   reply that wouldn't make sense without having read it. If the draft
   is purely about the outer body and ignores the linked post,
   REWRITE.
```

### `drafting-reply/references/x-reply-voice.md` — new "Conversation context" section

Three worked examples:

1. **Self-quote celebrating a fix** (Anum's pattern). Outer = current
   pain, quoted-self = recent win.
   - Bad: "Apple Search Ads, Meta, SEO — running that gauntlet costs
     money and months. curious what the breakthrough was." (ignores
     the celebration entirely)
   - Better: "the database win was wild — same shipper energy. on
     marketing: I broke even on Apple Search too, what shifted things
     for us was [concrete]." (acknowledges the quoted win, anchors the
     pain reply with a first-person receipt)

2. **Quote-amplify of another author's tweet.** Outer adds commentary
   on the quoted. Reply primarily to outer; the quoted's specifics are
   fair game for grounding.

3. **Reply in a chain.** Outer is OP's response to a parent. Reply
   addresses what OP is now saying, but the parent's question grounds
   the topic so a generic reply doesn't drift.

## Plumbing changes

- `persist_queue_threads` (`PersistQueueThreadsTool`): extend the
  insert column list to write the 4 new fields from `TweetCandidate`.
- `ProcessRepliesBatchTool`: `select(...)` projection adds the 4
  cols; `processOne` passes them into the drafting-reply input under
  `thread.{quotedText, quotedAuthor, inReplyToText, inReplyToAuthor}`.
- `find_threads_via_xai`: no code change. The `JudgedCandidate.tweet`
  carries the new fields automatically once the schema bump lands.

## Tests

1. **Schema unit** (`XaiFindCustomersTool/schema.ts`): parses with all
   four new fields null AND with each populated. Self-quote case
   (quoted_author == author_username) parses cleanly.
2. **Persist integration** (`PersistQueueThreadsTool`): writes the 4
   new cols when present, leaves null when absent.
3. **Batch input shape unit** (`ProcessRepliesBatchTool`): given a
   thread row with `quotedText` set, the drafting-reply input it
   builds includes that text on `thread.quotedText`. Mock the fork
   call.
4. **Drafting-reply schema unit**: accepts fully-populated, all-null,
   and partial inputs.
5. **Live smoke** (extends `e2e/tests/draft-pipeline.live-smoke.ts`):
   seed a synthetic thread row with `quotedText` populated, run the
   batch tool against the real Sonnet fork, assert the resulting
   `draftBody` contains at least one substring drawn from `quotedText`
   (proves the prompt actually changes drafter behavior).

## Out of scope

- **Reddit.** Parent-comment context for Reddit reply chains is the
  analogous problem and likely the next round.
- **Backfill of existing `threads` rows.** Threads age out within hours;
  not worth the migration cost.
- **judging-thread-quality changes.** Per the recall-over-precision
  stance, the judge stays loose. If we later see lots of "celebration
  quote-tweet" slop in `/today`, graduate to using the context as a
  tiebreaker on `confidence`.
- **`x_get_tweet` second-fetch.** We trust Grok-supplied quoted/parent
  text. If accuracy turns out to be bad, fall back to the hybrid path
  (Option C from brainstorming): xAI returns IDs, we fetch text via
  `x_get_tweet` only for threads that pass judging.

## Risks

- **Grok hallucinates a quoted post.** Drafter references a fake
  earlier post → founder rejects in `/today`. Same review surface as
  today; no platform side-effect (we are not auto-posting).
- **Schema drift during deploy.** In-flight xAI calls return rows
  without the new fields. They are nullable, so `safeParse` passes;
  the old shape silently lands as `null` for all four. No failure
  mode.
