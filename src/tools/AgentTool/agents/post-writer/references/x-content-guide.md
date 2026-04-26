# X Content Type Guidelines

## Default: ONE single tweet, ≤ 280 weighted chars

Build-in-public on X is dominated by single tweets. Threads have higher
friction (readers must click "Show this thread"), each filler tweet
dilutes the message, and a poorly-paced thread costs reach. Default to
ONE compressed tweet that lands the whole idea in 280 chars or less.

**Hard rule: never emit a thread (multiple tweets joined by `\n\n`)
unless the plan_item explicitly opts in via `params.contentType: 'thread'`.**
If `params.contentType` is missing or anything other than `'thread'`,
the body must be a single tweet. No paragraph breaks across tweets,
no thread of bullet expansion, no "And here's why..." continuation
into a second tweet.

If the brief feels too rich for one tweet, your job is to **compress**,
not to expand into a thread. Cut the warm-up. Cut the recap. Pick the
one specific number / sentence / image that carries the point and ship
that. Almost every "I think this needs a thread" instinct on a build
update is wrong — it's a single tweet you haven't compressed yet.

### Compression heuristics for single tweets

- Lead with the **specific** thing (number, day, screenshot
  description), not the setup.
- Drop transitional sentences. "Here's the thing" / "Let me explain"
  → cut.
- Use a colon, dash, or line break instead of full sentences for
  contrast. "Tuesday: 3 days to ship. Wednesday: 6 hours to tell
  anyone." beats two sentences with connectors.
- Push the product mention to the last clause if it appears at all.
  "[insight]. That's why we're building X." — one tight line.
- Hashtags go on the last line. `#buildinpublic` plus 0–2 topical
  tags from #indiehackers / #saas / #aitools / #microsaas.

## Content Types (still pick one — controls voice + structure)

The content type drives WHICH single tweet you write, not whether to
thread. For all of these, default output is ONE tweet:

### metric
Build-in-public updates with real numbers:
- Revenue milestones, user counts, conversion rates
- "Week X of building [Product]: here's what happened"
- Stripe screenshots, dashboard snapshots (describe them for the user to add)
- Failures and pivots with honest numbers
- Optimize for bookmarks — people save metric posts for inspiration

### educational
Tips, frameworks, lessons learned:
- "One thing I learned building [X]..."
- Technical lessons other founders can use
- Marketing/growth insights with specific examples
- Frameworks or mental models, presented concisely
- Optimize for bookmarks and replies — teach something people want to save

### engagement
Questions, polls, hot takes that generate replies:
- "Unpopular opinion: ..."
- "What's the one tool you can't live without for X?"
- Controversial but defensible takes on indie hacking/SaaS
- "Reply with your [X] and I'll [Y]" (only if authentic)
- Optimize for replies — conversation drives algorithm visibility
- NEVER pitch the product here — lead with value.

### product
Product demos, feature highlights:
- Show, don't tell — describe a GIF/screenshot the user should add
- Focus on the outcome, not the feature
- "Just shipped: [feature]. Here's why it matters..."
- Always lead with the problem being solved
- Optimize for link clicks via first reply

## Thread format (opt-in only — `params.contentType: 'thread'`)

Threads are reserved for genuinely multi-point content: a tutorial,
a multi-step case study, a postmortem with 5+ distinct lessons. If
the plan_item didn't explicitly request a thread, you must NOT write
one — even if the brief is long.

**When threading is allowed, every single one of these rules applies:**

1. **5–15 tweets.** Fewer than 5 → it's a single tweet you haven't
   compressed yet. Rewrite as one.
2. **Each tweet stands alone.** A reader who sees only that tweet
   (because someone retweeted it out of context) must understand what
   it says without reading the previous one. This is the rule that
   most AI-generated threads fail.
3. **One complete idea per tweet — NOT one paragraph per tweet.**
   Splitting a single connected thought across multiple tweets is the
   #1 antipattern. If a tweet's content only makes sense as a
   continuation of the prior one, it's a paragraph break, not a tweet
   break — fold it back into a single tweet or rewrite both as
   independent tweets.
4. **No continuation-word starts.** Tweets 2–N must NOT start with
   "And", "But", "So", "Because", "That's why", "This is why",
   "Plus", "Also", "It", or any other word that signals "this depends
   on the previous tweet". Each tweet must read like a fresh post.
5. **First tweet = standalone hook.** It must work as a single tweet
   on its own AND make people want to read more. Never write
   "Thread:" or "1/" preamble — let the hook do the work.
6. **Final tweet = standalone insight or CTA.** Not a hashtag dump.
   Tweets that contain only hashtags are not tweets — fold the
   hashtags into the final substantive tweet.
7. **Cut filler ruthlessly.** Any tweet that doesn't teach, advance,
   or deliver a fresh insight must be removed. If you can delete a
   tweet without losing the thread's value, delete it.
8. **Link goes in the first reply to the thread, not inside the
   thread itself.**

## Bad vs good examples

### BAD — paragraph-broken "thread" (this is what to avoid)

```
I shipped a feature on Tuesday I was proud of. Took 3 days.

By Wednesday morning I realized: no one knew about it.

So I spent the next 6 hours:
- Writing the same update in 3 voices
- Searching for communities
- Rewriting it for each platform's norms

That's why we're building ShipFlare.

#buildinpublic #indiehackers
```

Why this fails: tweet 2 starts mid-thought ("By Wednesday morning…"
depends on tweet 1). Tweet 3 starts with "So" (continuation). Tweet
4 starts with "That's why" (continuation, plus pitches the product).
Tweet 5 is just hashtags. None of tweets 2–5 stand alone.

### GOOD — single compressed tweet (the default)

```
Tuesday: 3 days to ship a feature I was proud of.
Wednesday: 6 hours figuring out which voice, which community, which platform's norms.
The build took 3 days. The hustle took 6 hours.
That's the gap we're building ShipFlare to close. #buildinpublic
```

Same idea, one tweet, ~245 chars, every clause earns its space.

## Mandatory Rules (platform — `validate_draft` enforces these)

1. **280 weighted chars per tweet** — twitter-text accounting: t.co URLs
   count as exactly 23, emoji as 2, CJK characters as 2, ASCII as 1.
   For multi-tweet threads, each tweet is measured separately; max 25
   tweets per thread. The `validate_draft` tool is the source of truth —
   never count by hand.
2. **NO links in tweet body** — if a link is needed, set `linkReply`
   and it will be posted as the first reply. (Platform allows it; X
   penalizes reach by ~50%.)
3. **No sibling-platform leaks** — never mention "reddit", "r/",
   "subreddit", "upvote", "karma" without an explicit contrast marker
   ("unlike", "vs", "instead of", "compared to") in the same sentence.
4. **No unsourced numeric claims** — every percentage / multiplier /
   "$N" / "over N" needs an in-sentence citation ("according to X",
   "source:", a URL, or @handle). If you can't cite it, drop the number.

## Style Targets (ShipFlare — surfaced as warnings)

5. **#buildinpublic plus 0-2 topical hashtags** from #indiehackers,
   #saas, #aitools, #microsaas. Hard cap: 3 hashtags total. (Not a
   platform rule, but `validate_draft` flags it as a warning.)
6. **Write in first person** — "I", "we", "my".
7. **Be specific** — use numbers, names, timeframes. "Revenue grew 40%
   last month" beats "Revenue is growing".
8. **Sound human** — avoid corporate language, marketing speak, or
   AI-sounding phrases ("leverage", "delve", "comprehensive", "robust").
9. **No emoji overload** — max 1-2 per tweet (each emoji costs 2
   weighted chars).
10. **Never pitch the product in engagement content** — lead with value,
    stories, lessons.
11. **Be authentic** — share failures too, not just wins.
