# Self-promotion ladder

Five policy buckets, each with canonical rule patterns and a
recommendation template.

## forbidden

Rule patterns that indicate this bucket:

- "No self-promotion" / "no promotional content" / "no advertising"
- "No links to your own product/site/YouTube"
- Bans on mentioning founders' own work anywhere in the sub
- Rules that call out "no backdoor advertising" or "no stealth marketing"

Recommendation template:

> "This community forbids self-promotion. Do not mention {product}
> directly, even when helpful. You can still learn from threads here —
> consider it an intelligence source, not a posting surface."

## restricted

Rule patterns:

- "Self-promotion only in Mon/Wed/Fri threads"
- "9:1 rule: nine non-promotional posts before one promotional"
- "Verified-creator flair required for self-promo"
- "Self-promo must be explicitly labeled"
- Karma gates, account-age gates

Recommendation template:

> "Self-promotion is allowed under {specific rule}. Either follow the
> gate (e.g., post in the {day} thread, earn the flair, keep a 9:1
> ratio), or stick to replies where a product mention comes as an answer
> to an explicit question."

## tolerated

Rule patterns:

- No explicit self-promo rule at all.
- Rules limited to civility / quality / no-spam.
- Moderators occasionally remove pure-ad posts but allow founder
  participation.

Recommendation template:

> "Moderators tolerate self-promotion when the reply is substantive.
> Safe to mention {product} when it's the real answer to an asked
> question. Avoid cold posts that exist only to promote."

## welcomed

Rule patterns:

- "Founders welcome — share what you're building"
- Build-in-public themed subs
- Weekly share-your-project threads encouraged
- Community explicitly describes itself as a place for makers

Recommendation template:

> "This community welcomes founder posts. Share product updates
> directly; participate in weekly showcase threads. Still keep posts
> substantive — 'we launched' gets downvoted even here."

## unknown

Triggered when `reddit_get_rules` returned empty, errored, or the rule
text is too generic to classify (e.g., only "be respectful").

Recommendation template:

> "Could not read community rules. Treat as restricted by default: only
> engage when you have a substantive answer that happens to involve
> {product}. Revisit after moderators publish rules."

## Cross-bucket anti-patterns

- Never recommend posting at low-traffic hours to "sneak past" rules.
- Never recommend using alt accounts, fake personas, or multiple handles
  to circumvent policy.
- If rules require disclosure ("disclose affiliation"), that rule is a
  binding constraint — lift it into `keyConstraints`.
- Length / format rules ("min 250 words", "must include image") belong in
  `keyConstraints` regardless of the self-promotion bucket.
