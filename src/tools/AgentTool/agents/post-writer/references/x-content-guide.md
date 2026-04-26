# X Content Type Guidelines

## Content Types

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

### product
Product demos, feature highlights:
- Show, don't tell — describe a GIF/screenshot the user should add
- Focus on the outcome, not the feature
- "Just shipped: [feature]. Here's why it matters..."
- Always lead with the problem being solved
- Optimize for link clicks via first reply

### thread (special format, 3-7 tweets)
Multi-tweet deep dives:
- Tweet #1 is the HOOK — this determines if anyone reads the rest. Make it compelling, specific, and slightly provocative.
- Tweets #2-6: One idea per tweet. Short sentences. White space.
- Final tweet: Call to action or summary.
- Link goes in the FIRST REPLY to the thread, not in the thread itself.

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
