# TODOS

## Phase 2

### Stripe Payment Integration
- **What:** Add Stripe checkout to enable paid subscriptions.
- **Why:** Can't validate willingness-to-pay without the ability to charge. Competitors charge $3/comment (ReplyAgent) or monthly subscriptions.
- **Context:** Pricing undefined. Needs user feedback from free beta first. Include pricing research and competitor analysis before implementing.
- **Depends on:** Working product with beta users, defined pricing tiers.
- **Source:** /plan-eng-review outside voice, 2026-04-11.

### Adaptive Health Score Engagement Baseline
- **What:** Replace hardcoded engagement baseline (20) in Health Score S3 normalization with per-subreddit adaptive baselines derived from user's own posting history.
- **Why:** Different subreddits have wildly different engagement norms. r/programming avg 20 upvotes is normal, r/SideProject avg 20 is exceptional.
- **Context:** Phase 1 uses hardcoded 20 (known-wrong but measurable). Adaptive version calculates median engagement after 10+ posts per subreddit, falls back to global default (20) below threshold.
- **Depends on:** 10+ posts to multiple subreddits per user (~2-3 weeks of active use).
- **Source:** /plan-eng-review code quality review, 2026-04-11.

### Weekly Marketing Digest Email
- **What:** Automated weekly email summarizing marketing performance, new drafts, engagement trends.
- **Why:** Anti-churn mechanism. Brings users back even when they forget to check the dashboard.
- **Context:** Deferred from CEO review. Requires email delivery infrastructure (Resend, Postmark, or similar).
- **Depends on:** Analytics data, email service setup.
- **Source:** /plan-ceo-review scope decision #3, 2026-04-11.

### MCP Server Interface
- **What:** HTTP-transport MCP server exposing 4 tools: discover, drafts, approve, status.
- **Why:** Developer power-user feature. Differentiator for technical users who want to integrate ShipFlare into their own workflows.
- **Context:** Deferred from Phase 1. Build when there's demand signal from actual developers.
- **Depends on:** Stable API layer in Phase 1 dashboard.
- **Source:** /plan-eng-review architecture review, 2026-04-11.

### X/Twitter Integration
- **What:** Add X API v2 integration for Discovery + Content + Posting agents.
- **Why:** Second channel. Broadens reach. But costs $100/month for Basic tier write access.
- **Context:** Validate core loop on Reddit first. Add X when revenue justifies API cost.
- **Depends on:** Reddit validation, revenue.
- **Source:** /plan-eng-review Step 0 scope challenge, 2026-04-11.

## Phase 4+

### Stripe/Revenue Attribution
- **What:** Track which posts/channels drive actual revenue via Stripe payment attribution.
- **Why:** Ultimate closed loop from marketing to money. But attribution is technically hard.
- **Context:** Requires mature analytics pipeline and Stripe integration.
- **Depends on:** Stripe integration, Analytics Agent (Phase 2).
- **Source:** /plan-ceo-review scope decision #7, 2026-04-11.
