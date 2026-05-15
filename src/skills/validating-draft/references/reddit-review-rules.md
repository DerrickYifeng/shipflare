# Reddit reply / post review rules

Apply these rules when validating drafts where `platform === 'reddit'`. They reflect Reddit-specific community norms that differ from X. Mod-removability is the dominant failure mode; AutoMod patterns and self-promo enforcement are stricter than any other platform we ship to.

## REJECT (FAIL verdict — do not allow handoff)

### Self-promo without disclosure
- Mentioning ShipFlare (or the user's product) in the first 2 sentences of a reply, **unless** the OP explicitly asked for tool recommendations.
- Posting a link without context. Reddit's per-subreddit self-promo ratio is typically "9 helpful comments per 1 link" — assume zero context = removed.
- Brand-voice promotional language: "transform your X", "supercharge", "the only tool that".

### AutoMod red flags
- Brand-new account voice: gushing positivity, marketing-speak, "great question!"
- "DM me" or "PM me" — multiple subreddits AutoMod-remove these on sight
- Link-only comments
- Comments under ~30 chars (treated as low-effort)
- Comments containing only a link with no surrounding text

### Banned slop phrases (Reddit-specific)
- "Great question"
- "Happy to help"
- "Feel free to reach out"
- "I totally understand where you're coming from"
- "Really resonates with me"
- "On a similar note"
- "Just my two cents"
- "Hope this helps!"
- "Awesome point"

### Voice mismatches
- Excessive emoji (Reddit is mostly emoji-light outside of meme subs)
- Sentence-case on every sentence (real Reddit users mix lowercase, fragments, occasional ALL CAPS)
- No personal experience anchor — Reddit replies that work usually start with "I tried X and..." or "We had this exact problem..."

## REVISE (issue warning, suggest fix)

### Length
- Replies > 800 chars feel like a blog post. Aim for 50-300.
- Posts > 2000 chars in body get tl;dr'd. Add a tl;dr line up top if longer.

### Markdown
- Reddit supports markdown but `*italics*` and `**bold**` only — no headers below `#`, no tables in old.reddit. Use `> ` for blockquotes when referencing the OP.
- Backticks for `code references` are great signal for technical subs.

### Tone calibration
- Match the subreddit. r/SaaS is more polished, r/indiehackers is more casual, r/Entrepreneur is meme-heavy and skeptical, r/microsaas is technical.
- Lead with admitting limitations. "I'm not sure if this applies to your case but..." beats "You should..." on Reddit.

## PASS (allow handoff)

A draft passes when:
1. No banned slop phrases.
2. Has personal-experience anchor or genuine question OR concrete tactical advice (numbered list, specific tool name, specific number).
3. Mentions the user's product only if (a) directly answering a "what tool do you use" question, or (b) wrapped in genuine context after the helpful content.
4. Length within the subreddit's typical range.
5. Markdown valid for both old.reddit and new.reddit.

## Subreddit-specific overrides

If the drafting skill called `getSubredditRules()` and got back rules text, treat any rule that says "no self-promotion" as a hard block on product mention. Surface the conflicting rule in the FAIL reason.

## When to skip entirely

- Thread is `locked: true` or `archived: true`. Do not draft.
- Subreddit appears in the user's blocklist (configured in onboarding).
- OP comment is `[deleted]` or `[removed]`.
- NSFW thread (`over_18: true`) unless product is explicitly adult-oriented.
