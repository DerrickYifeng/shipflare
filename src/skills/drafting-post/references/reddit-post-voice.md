# Reddit Content Guidelines

Reddit is not X. What ships as a tight 240-character tweet reads as
low-effort on Reddit; what ships as a long story thread on Reddit reads
as filler on X. Write for the subreddit, not for engagement metrics.

## Post Shape

### self-post body (the text field)

You are drafting the BODY of a self-post. The TITLE is set separately
by the plan_item's `title` column — do not repeat it verbatim as the
first line of the body. The body supplies the context, story, and
specifics that the title only hints at.

### Length

- **Target: 150–600 words** for most subreddits. Short bodies (<80
  words) read as low-effort unless the title carries the whole point
  (AskReddit-style questions).
- **Hard cap: 40,000 characters** (Reddit's self-post ceiling). Rarely
  relevant — if a draft approaches 10,000 characters, split it into a
  cross-link or a shorter version.
- **Markdown formatting** is allowed and often expected for long posts:
  `**bold**`, `*italics*`, paragraph breaks, bulleted lists, numbered
  lists, `> blockquotes`, `---` horizontal rules.

### Paragraph rhythm

- Short paragraphs (1–4 sentences). Double-newline between them.
- A single wall of text is an instant scroll-past.
- Lists (numbered or bulleted) are fine for structured advice, wrong
  for personal-story posts — they feel like corporate memos.

## Content Types

### build-in-public / story

Tell the story with specifics. Reddit rewards honesty, numbers,
screenshots (describe them for the user to add), failures named by
name, and "here's what I tried" that didn't work.

- Lead with a concrete scene, not a thesis.
- Name tools by name — `postgres`, `Stripe`, `Vercel`, `Cursor`.
- If you cite a metric, cite the source in the same sentence.
- End with a question or a small invitation ("what would you have
  tried?") — comments are the point on Reddit.

### technical / how-to

Walk through the solution step-by-step. Code blocks (fenced with triple
backticks) are welcome when a snippet clarifies.

- Open with the problem, not the solution.
- Name trade-offs honestly — "this is slow at >100k rows" beats
  "production-ready and scalable".
- Link only to your own blog/repo/docs, not marketing pages.

### discussion / opinion

Contrarian takes work on Reddit IF they're defensible and specific.
"Hot takes" in the X sense (punchy and hashtagged) are poison here —
subreddits read them as karma-farming.

- Frame as a question or a provisional claim, not a verdict.
- Anticipate the strongest counter-argument and address it.
- Avoid words like "unpopular opinion" as a prefix — reads performative.

### launch / announcement

Reddit is the hardest channel for launches. Most subreddits auto-remove
anything that reads promotional. Rule of thumb: if the post can't be
posted to r/SideProject or r/indiehackers WITHOUT a self-promotion
disclaimer, it probably shouldn't be posted anywhere.

- Lead with the problem the product solves, not the product.
- Name the subreddit-specific norm first ("following the r/X rules:
  this is self-promotion, here's a 10-word summary if you want to
  skip").
- Include a specific ask: feedback, beta testers, critique — not
  "check it out".

## Mandatory Rules

1. **Subreddit rules override these guidelines.** Many subreddits ban
   self-promotion outright, require specific post flairs, or have a
   9:1 "contribute 9 times before posting once" rule. If the plan_item
   `params.subreddit` is set, respect what that subreddit demands.
2. **First person.** "I built", "we tried", "my team".
3. **No marketing speak.** Avoid "leverage", "seamless", "robust",
   "revolutionize", "game-changing", "paradigm shift", "comprehensive".
   Avoid ChatGPT-sounding structure — bold headers followed by
   three-bullet lists followed by a call-to-action.
4. **No em-dash overuse.** Two em-dashes in a 200-word post is a
   classic AI tell; use commas, colons, or parentheses instead.
5. **No triple-grouping rhythm.** "Fast, efficient, reliable" reads as
   copy. Name ONE concrete trait and move on.
6. **Hashtags are forbidden on Reddit.** Not `#buildinpublic`, not
   `#indiedev`. Reddit users filter these out.
7. **No `TL;DR` unless the post is >500 words AND the TL;DR carries
   specific info that isn't in the title.**
8. **Sound human.** Reddit readers are hyper-tuned to AI copy. Chat
   register beats essay register. A single "yeah" or "tbh" in a 300-word
   post does more than any amount of polish.
9. **Numeric claims need a citation in the same sentence** — a link, a
   named source, a screenshot reference, or an @handle. If you don't
   have one, rewrite qualitatively.
10. **No links in the body unless they're your own or directly relevant
    to the story.** Linking competitor products as comparison reads as
    bait.

## Anti-patterns (kill on sight)

- Opening with "As a founder…" / "As someone who…"
- Closing with "What do you think?" as the only question — be specific.
- "Here are 5 things I learned" → Reddit has seen this template a
  million times. Pick ONE thing, go deeper.
- Emoji in titles or bodies (1-2 in a long body is fine; emoji-dense
  posts read as spam).
- "Mods feel free to remove" — reads as guilty posting.
- Thread-style numbered hooks ("1/ I built X", "2/ Here's what…") —
  that's an X-ism.

## Algorithm signals

Reddit rewards:
1. **Comment count** — conversations signal quality. End with a
   question that invites specific answers.
2. **Upvote-ratio in the first hour** — early downvotes tank reach.
   Post when the target subreddit is active.
3. **Comment quality from the OP** — replying thoughtfully to the first
   5-10 comments is the biggest single lever for post performance.

## Self-check before returning

- [ ] Title isn't repeated verbatim as the first body line.
- [ ] Paragraphs are short (1-4 sentences each).
- [ ] No hashtags anywhere.
- [ ] No banned vocabulary (leverage, delve, seamless, robust, etc.).
- [ ] Numeric claims carry a citation (or were rewritten qualitatively).
- [ ] First person throughout.
- [ ] Specific nouns (tools, numbers, timestamps) — no generic
      "industry-leading" language.
- [ ] Reads like a human wrote it in one sitting, not like a draft
      that's been "optimized".
