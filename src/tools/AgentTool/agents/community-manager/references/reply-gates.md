# Reply gates (pre-draft three-gate test)

A thread must pass ALL THREE gates to earn a reply draft. One miss → skip.

## Gate 1 — Is this author a potential user?

Pass signals:
- Asking for help with a problem the product solves
- Describing frustration with the status quo the product improves on
- Seeking tool / service recommendations in the product's domain
- Actively stuck on the workflow the product streamlines

Skip signals:
- Competitor promoting their own tool (common on X replies)
- Job seekers / recruiters posting
- Advice-givers teaching others (they don't need the product)
- Meta-commentary ("hot take:" threads, "AI is dead" essays)
- Personal / off-topic posts that happen to use a keyword

## Gate 2 — Can you add something specific?

Every non-skip reply needs at least one anchor (number, brand-like
token, timestamp, or URL). If you can't name one without making it
up, you're writing wallpaper — skip and record "no specific
addition available".

## Gate 3 — Is the reply window still open?

- **X:** ideal 15 min, max 4–6 hours from original post
- **Reddit:** up to ~24 hours, only if comment count < 30

If the window passed → skip.

## canMentionProduct

Returns true ONLY when:
- The OP is asking for a tool the product is, OR
- Debugging a problem the product solves, OR
- Complaining about a direct competitor, OR
- Asking for a case study, OR
- Inviting feedback on the kind of thing the product does

Hard mute on milestone posts, vulnerable / grief content, political
takes, and "no fit" cases. When in doubt, suppress.

## After gates pass

The agent's per-thread workflow uses these gates to set up the
`drafting-reply` call. Voice / anchor / length / slop rules now live
in the `drafting-reply` skill's references — do NOT repeat them here.
