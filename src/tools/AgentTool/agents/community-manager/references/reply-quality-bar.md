# Reply quality bar

Two layers — a pre-draft three-gate test that decides whether the
thread is worth replying to at all, and a post-draft self-check that
decides whether the body you wrote is shippable. You apply both
INLINE in the same LLM turn that drafts the reply. There is no
external validator tool; these prose rules are the contract.

---

## Layer 1 — three-gate test (run BEFORE drafting)

A thread must pass ALL THREE gates to earn a reply draft. One miss → skip.

### Gate 1 — Is this author a potential user?

Potential-user signals:

- Asking for help with a problem the product solves
- Describing frustration with the status quo the product improves on
- Seeking tool/service recommendations in the product's domain
- Actively stuck on the workflow the product streamlines

Non-potential-user signals (SKIP these):

- Competitor promoting their own tool (common on X replies)
- Job seekers / recruiters posting
- Advice-givers teaching others (they don't need the product)
- Meta-commentary ("hot take:" threads, "AI is dead" essays)
- Personal/off-topic posts that happen to use a keyword

### Gate 2 — Can you add something specific?

Every non-skip reply must carry at least one anchor (see Layer 2 →
"Anchor token" below for the full definition). If you can't name a
specific number, tool, brand, or timestamp that belongs in the reply,
you're writing wallpaper — skip and record the thread as "no specific
addition available".

### Gate 3 — Is the reply window still open?

Windows by platform (match `platform-config.ts` defaults):

- **X**: 15 minutes ideal, 4-6 hours max from the original post.
  Replies after that compound less and readers see your reply with
  less context.
- **Reddit**: up to ~24 hours from original post, but only if the
  thread has <30 comments. After that your reply is buried.

If the window passed → skip.

---

## Layer 2 — self-check the draft body (run AFTER drafting, BEFORE persisting)

Every draft you produce gets checked against the rules below in the
same LLM turn that wrote it. If any rule fails, you have ONE rewrite
attempt — repair the offending sentence (not the whole draft) and
re-check. If it still fails, either skip or persist with the
"needs human review" flag (see AGENT.md for which to choose when).

### Length cap

Hard caps per platform + content kind. You cannot persist a draft
longer than the cap; the persistence tool accepts up to the Reddit
ceiling but the Layer 2 check fails any draft that exceeds the
platform's reply cap:

| Platform | Reply cap | Notes                                    |
|----------|-----------|------------------------------------------|
| X        | 240 chars | Target 40-140 (≈ 7-28 words). Stretch to 180 ONLY when the reply carries a personal anchor (`I/we` + specific). 180-240 requires an explicit personal anchor justified in `whyItWorks`. Two-sentence replies where the second is a generalized claim ("most founders X") almost always belong in the 40-140 band — cut the second sentence. |
| Reddit   | 10,000    | Aim for one paragraph; 300-800 ideal     |

Count grapheme-friendly characters (emoji + astral chars count as
one), not raw `.length`. If you go over: cut the second sentence
first (rule below), then trim adjectives, then cut the example.

### Anchor token (required)

Every non-skip reply MUST contain at least one of:

- **Number** — a count, percentage, dollar amount, or duration
  (`14 months`, `$10k MRR`, `20% lift`, `2am`)
- **Proper noun / brand-like token** — capitalized or embedded-case
  mid-sentence (`postgres`, `Stripe`, `Vercel`, `levelsio`,
  `photoAI`)
- **Timestamp phrase** — `last week`, `month 8`, `yesterday`,
  `this morning`
- **URL** — rare in replies, but counts when present (NB: zero links
  in X replies — see "Format" below; this anchor only applies to
  Reddit)

Sentence-initial capitalized words don't count (every sentence
starts with one). The anchor must be earned mid-sentence.

If your draft has no anchor → rewrite to add ONE concrete detail.
If you can't honestly add one → skip the thread.

### Personal-anchor rule (replies that make claims)

If your draft makes a generalized claim about how things work
(`the real cost is X`, `winners do Y`, `most founders Z`,
`builders optimize for X`), the anchor MUST be a first-person
specific from the writer's own run — not a brand name in the
abstract:

- **Required**: `I/we + specific number/year/tool/event` —
  `we tried Stripe Tax for 14 days, broke at one edge case`,
  `our first churn was at month 8`,
  `shipped revenue analytics yesterday — first user spotted a
  $1,247 leak in 4 minutes`.
- **Forbidden**: `the real X is Y` / `winners do X` /
  `most solo devs Y` / `not just X — it's Y` delivered without
  an `I/we` first-person receipt in the same reply.

If you can't bring a personal anchor for the claim, you have two
clean exits:

- Ask one short specific question (`question_extender` archetype)
  instead of asserting.
- Skip the thread (return `strategy: 'skip'` with confidence ≤
  0.4).

Silence beats unearned authority. The "Could this be a Like?"
rule at the end of this doc overrides when in doubt.

### Banned preamble openers (kill on sight)

Reject any draft whose first ~20 chars match these patterns
(case-insensitive):

- `Great post / point / question / take / thread`
- `Interesting take / point / perspective`
- `Fascinating ...`
- `As a [founder / engineer / builder / someone who] ...`
- `I noticed you mentioned ...` / `Have you considered ...`
- `Absolutely` / `Certainly` / `Love this`

### Banned vocabulary (case-insensitive substring match)

Reject if any of these appear anywhere in the draft:

`leverage`, `delve`, `utilize`, `robust`, `crucial`, `pivotal`,
`demystify`, `landscape`, `ecosystem`, `journey`, `seamless`,
`navigate`, `compelling`

### Banned engagement-bait fillers (whole-reply check)

Reject one-line replies that read as engagement-bait:

- `This.` (alone)
- `100%.` (alone)
- `So true!` (alone)
- `bookmarked ...`
- `+1`
- `This really resonates ...`

### Structural AI tells (the slop fingerprint)

Reject drafts that exhibit any of:

- **Em-dash overuse** — two or more em-dashes (`—`, `---`, ` -- `)
  in a single reply
- **Binary "not X, it's Y" / "the real X is Y" pronouncements** —
  all of these patterns:
  - `it's not (just )?X — it's Y` / `this is not X, it's Y`
  - `the real <noun> (is|isn't) Y`
  - `<noun> isn't (a )?X. it's a Y` / `<noun> isn't X — it's Y`
  - `not just X — you're Y` / `not just X — we're Y`

  These are tells of someone explaining the world from above. Hard
  reject — the `humility-tells` validator flags them at self-check
  time.
- **Triple-grouping** — `fast, efficient, reliable` /
  `clean, simple, fast` rhythm (three comma-separated 3+-letter
  words in a row, optionally with "and")
- **Negation cadence** — `no fluff. no theory. just results.`
  rhythm (two `no <word>.` clauses in a row)
- **Filler hedges** — `It's important to note that ...`,
  `That said, ...`, `Ultimately, ...`, `At the end of the day, ...`,
  `Just my 2 cents`, `FWIW`, `YMMV`, `TL;DR`, `So basically`

### Hallucinated-stats prohibition (HARD reject)

Numbers in a reply must be either trivially true (years, ordinals
1900-2099) OR supported by a citation in the same sentence /
~120-char window:

- `according to <Source>` / `per @handle` / `source: ...`
- A URL (`https://...`) — even on X-reply where format rules ban
  links, the citation check still applies; if you can't cite,
  drop the stat
- A `@handle` mention with attribution context (`per @Stripe`)
- `from a [recent] [study | report | survey | paper]`
- `cited by ...`

Any `40%`, `12.5%`, `10x`, `3.5x`, `over 100`, `up to 500`,
`$1.2m`, `5k users`, `over $N`, `up to N` without a nearby
citation is a hallucination — drop the number entirely or rewrite
the sentence without it. Inventing a citation to launder a stat is
strictly worse than removing the number.

The narrow exceptions: ordinal years (`2024`), ordinal counts
already in the source thread (`their 5th launch` when the OP
literally said "fifth launch"), and the founder's own first-party
stats injected via product context.

### Cross-platform leak (per-channel)

Drafts targeting one platform must not name sibling platforms
without an explicit contrast marker in the same sentence:

- **X drafts** must not use: `reddit`, `r/`, `subreddit`,
  `upvote`, `upvotes`, `karma`, `Reddit`
- **Reddit drafts** must not use: `twitter`, `x.com`, `tweet`,
  `tweeted`, `retweet`, `quote tweet`, `RT @`, `X (Twitter)`

The exception — sentences that contain one of these contrast
markers may name the sibling platform deliberately: `unlike`,
`vs` / `vs.` / `versus`, `instead of`, `rather than`,
`compared to / with`, `in contrast to`, `over on`, `as opposed
to`. Example: `unlike reddit, X compounds early replies` is
allowed; `we got 200 upvotes on launch day` (in an X reply) is
not.

### Voice / format (X replies — extra layer)

These ride on top of the AI-slop / banned-vocab rules and are
specific to the X reply register:

- Lowercase opening and missing end period are fine and often
  preferred (chat register).
- Sentence fragments are fine ("hard disagree." is a complete
  reply).
- Declarative, not hedged — but every claim must be anchored to your
  own run. `we tried X for 6 months and Y broke` beats both
  `I think maybe X could be Y` AND `the real X is Y`. Without your
  own receipt, drop the claim and ask a question instead. The
  `humility-tells` validator (run via `validate_draft`) flags
  "the real X is Y" / "winners do X" / "most solo devs Y" patterns
  as sermon energy — heed the warning, don't ship past it.
- First person, present tense. No exclamation points. No emoji
  by default (≤ 1 only if it replaces a word).
- Zero hashtags in replies. Zero links in X replies.
- If your reply has a second sentence, it must be SHORTER than the
  first — otherwise cut it. Never multi-paragraph. Never line
  breaks inside a single X reply.

### Voice / format (Reddit replies)

- Subreddit register. Reads like a comment thread, not a LinkedIn
  post.
- Markdown paragraph breaks are welcome for anything over 2
  sentences.
- Open with the specific thing you're responding to, not a
  greeting.
- Name your experience in concrete terms: `we tried X for 6
  months` not `in our experience`.
- Answer the question, then optionally add the one useful caveat
  — not three "it depends" disclaimers.
- No hashtags. No "happy to help!" close. No DM-me invitation
  unless the thread explicitly invited it.

### "Could this be a Like?"

The meta-rule above all the others: if your reply could be
replaced by a Like (X) or an upvote (Reddit), it should have
been one. Either sharpen it or skip the thread.

---

## After all checks pass

A thread that passed Layer 1 (three gates) and produced a draft
that passed Layer 2 (self-check) earns a `draft_reply` call. The
tool persists a `drafts` row with `state='pending'` — the founder
reviews it before anything ships.

## Output shape (sweep summary)

Track your decisions so the `notes` field in StructuredOutput can
name them:

```
threadsScanned: 14
draftsCreated: 3
draftsSkipped: 11
  - 4 failed gate 1 (competitors, advice-givers)
  - 5 failed gate 2 (no specific addition available)
  - 2 failed gate 3 (reply window closed)
  - 0 self-check failures after rewrite
needsReview: 0
```

The founder uses this skip-rationale to tune the discovery pipeline.
A sweep where 10/14 threads fail gate 1 means the discovery queries
need sharpening — report that plainly. Self-check failures after the
rewrite pass are a slop signal — if it's happening on >1 thread per
sweep, surface that in `notes` so the founder can flag the voice
block / reference docs for a touch-up.
