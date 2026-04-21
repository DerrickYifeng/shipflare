# Reply quality bar — the three-gate test

Before you call `draft_reply` on a thread, run each of these gates.
A thread must pass ALL THREE to earn a reply draft. One miss → skip.

## Gate 1 — Is this author a potential user?

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

## Gate 2 — Can you add something specific?

Every non-skip reply must carry at least one:

- **Number**: a count, percentage, dollar amount, or duration
  ("14 months", "$10k MRR", "20% lift")
- **Proper noun / named tool**: `postgres`, `Stripe`, `Vercel`, a
  founder handle
- **Timestamp phrase**: "last week", "month 8", "2am"
- **URL**: rare in replies, but counts when it's own-content

If you draft a reply without one of these, you're writing wallpaper —
skip and record the thread as "no specific addition available".

## Gate 3 — Is the reply window still open?

Windows by platform (match `platform-config.ts` defaults):

- **X**: 15 minutes ideal, 4-6 hours max from the original post.
  Replies after that compound less and readers see your reply with
  less context.
- **Reddit**: up to ~24 hours from original post, but only if the
  thread has <30 comments. After that your reply is buried.

If the window passed → skip.

## After all three gates

A thread that passes gate 1 + gate 2 + gate 3 earns a `draft_reply`
call. The tool handles:

- Platform-appropriate char cap (240 for X replies, 10k for Reddit)
- Content-safety guardrails (no sibling-platform mentions, no
  hallucinated stats)
- AI-slop validator (forbidden phrases, em-dash overuse, triplet
  rhythm)
- Anchor-token validator (the "specific thing" from gate 2 must
  survive into the final draft)
- Writing the draft row to `drafts` with `state='pending'` —
  the founder reviews it before anything ships

## Output shape

Track your decisions so the `notes` field in StructuredOutput can
name them:

```
threadsScanned: 14
draftsCreated: 3
draftsSkipped: 11
  - 4 failed gate 1 (competitors, advice-givers)
  - 5 failed gate 2 (no specific addition available)
  - 2 failed gate 3 (reply window closed)
```

The founder uses this skip-rationale to tune the discovery pipeline.
A sweep where 10/14 threads fail gate 1 means the discovery queries
need sharpening — report that plainly.

## Self-check before draft_reply

- [ ] Author is a potential user (gate 1 passed)
- [ ] Specific anchor identified (gate 2 passed)
- [ ] Reply window still open (gate 3 passed)
- [ ] I'm not replying just to hit a daily quota
- [ ] I'd still draft this reply if the founder read it over my
      shoulder
