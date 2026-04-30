# X Content Guidelines

## 1. Output contract

Output exactly **ONE** single tweet, ≤ 280 weighted chars. Build-in-public on
X is dominated by single tweets — they're sharper, travel further, and respect
the reader's time.

**Hard rule: never emit multiple tweets joined by `\n\n`.** The body must be
a single tweet. No paragraph breaks across tweets, no "And here's why..."
continuation, no bullet expansion into a second tweet.

If the brief feels too rich for one tweet, your job is to **compress**. Cut
the warm-up. Cut the recap. Pick the one specific number / sentence / image
that carries the point and ship that. Almost every "I think this needs more
space" instinct on a build update is wrong — it's a single tweet you haven't
compressed yet.

### Compression heuristics

- Lead with the **specific** thing (number, day, screenshot description),
  not the setup.
- Drop transitional sentences. "Here's the thing" / "Let me explain" → cut.
- Use a colon, dash, or line break instead of full sentences for contrast.
- Push the product mention to the last clause if it appears at all.
- Hashtags go on the last line. `#buildinpublic` plus 0–2 topical tags from
  `#indiehackers / #saas / #aitools / #microsaas`.

## 2. Universal rules

### 2.1 Hard rules — `validate_draft` enforces these

1. **280 weighted chars** — twitter-text accounting: t.co URLs count as 23,
   emoji as 2, CJK as 2, ASCII as 1. The `validate_draft` tool is the source
   of truth — never count by hand.
2. **No links in tweet body** — if a link is needed, set `linkReply` and it
   will be posted as the first reply. (X penalizes reach by ~50% on tweets
   that contain links.)
3. **No sibling-platform leaks** — never mention "reddit", "r/", "subreddit",
   "upvote", "karma" without an explicit contrast marker ("unlike", "vs",
   "instead of", "compared to") in the same sentence.
4. **No unsourced numeric claims** — every percentage / multiplier / `$N` /
   "over N" needs an in-sentence citation ("according to X", "source:", a
   URL, or @handle). If you can't cite it, drop the number.

### 2.2 Style targets — surfaced as warnings

5. **#buildinpublic plus 0–2 topical hashtags** from `#indiehackers / #saas
   / #aitools / #microsaas`. Hard cap: 3 hashtags total.
6. **Write in first person** — "I", "we", "my".
7. **Be specific** — numbers, names, timeframes. "Revenue grew 40% last
   month" beats "Revenue is growing".
8. **No corporate vocabulary** — avoid "leverage", "delve", "comprehensive",
   "robust", "synergy", "ecosystem", "journey".
9. **No emoji overload** — max 1–2 per tweet (each emoji costs 2 weighted
   chars).
10. **Never pitch the product in engagement content** — lead with value,
    stories, lessons.

## 3. Banned openers and begging phrases

These are universal — bad in every phase, every voice, every post type. If
you wrote a draft starting with one of these, rewrite the opener.

**Banned openers:**

- "Excited to announce..."
- "Excited to share..."
- "Big news!"
- "Quick update:"
- "Just wanted to say..."
- "Hey friends,"
- "I'm thrilled to..."

**Banned begging phrases:**

- "please RT"
- "support means everything"
- "any feedback appreciated 🙏"
- "RT if you like it"
- "would mean a lot"

If the post is good, the ask is implicit. If you need to beg, the post
isn't ready.

## 4. Voice clusters

Five voice clusters cover the stylistic range that works on X. Each cluster
is identified by a name; the post-writer's caller can pass any of these as
a `voice` hint to override the phase default.

### terse_shipper
Minimal text, screenshots and numbers carry the post. All-lowercase OK.
Periods optional. One sentence per line. Exemplar: levelsio.
*When to use:* launch day, milestone reveals, anything where the visual or
the number is the point.

### vulnerable_philosopher
Reflective single sentences with sentence-level craft. Complete thoughts,
no padding, no "thread of one". Exemplar: dvassallo.
*When to use:* contrarian takes, post-mortem reflections, lessons from
failure.

### daily_vlogger
Energetic, "Day N" cadence, milestone emoji at peaks (🎉 🚀 💪). Community-
first language. Exemplars: andrewzacker, tibo_maker.
*When to use:* build-out-loud phases — foundation and audience — where
volume + transparency outpaces polish.

### patient_grinder
Sparse, grateful, milestone-only. No daily noise. Posts only when there's a
real number. Exemplar: ryanashcraft.
*When to use:* first-revenue posts, post-launch traction documentation, any
moment where understatement amplifies the signal.

### contrarian_analyst
Hot takes on the meta — industry, AI, competitors, indie norms. References
to specific products / decisions / years. Exemplars: marc_louvion, rauchg.
*When to use:* steady-state thought leadership; teaching from authority.

### Default voice by phase

When the caller does not pass a `voice` hint, use this default:

| Phase | Default voice |
|---|---|
| `foundation` | `daily_vlogger` |
| `audience` | `daily_vlogger` |
| `momentum` | `terse_shipper` |
| `launch` | `terse_shipper` |
| `compound` | `patient_grinder` |
| `steady` | `contrarian_analyst` |

Caller's hint always wins. Free-form strings outside this vocabulary are
accepted; map them to the closest cluster (e.g. "data-led" → `terse_shipper`,
"reflective" → `vulnerable_philosopher`).
