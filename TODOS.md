# TODOS

## Now — UX Polish

### Today → Approval Inbox Redesign
- **What:** Reframe `/today` from a task list that tells the user what to do into an approval inbox where agents surface drafts/decisions and the user approves, edits, or rejects. Copy, visual hierarchy, and CTA labels should all reinforce "you're the boss, agents did the work."
- **Why:** Current flow feels coercive — user reported it "forces" them to act. Boss/employee framing increases perceived value and reduces guilt-driven churn; matches the product's positioning (agents do marketing for you).
- **Context:** Route lives at `src/app/(app)/today/` (`page.tsx`, `today-content.tsx`). Likely needs: per-item status pills ("Drafted by Content Agent"), approve/edit/reject actions, empty-state that celebrates agents working rather than nagging the user. Pairs conceptually with the Warroom item below.
- **Depends on:** None — pure frontend/copy pass on existing data.
- **Source:** User feedback, 2026-04-17.

### Agent Warroom Animation
- **What:** Upgrade the existing `AgentsWarRoom` on `/automation` into an animated office scene — agent "characters" move between desks, hand off work, and display live status (Idle / Searching / Drafting / Posting / Error). Status should reflect real job state from the worker queue.
- **Why:** Makes the invisible agent work visible and entertaining. Reinforces the "boss watching employees" frame from the Today redesign. Strong visual differentiator vs. competitors' dashboards.
- **Context:** Component at `src/app/(app)/automation/agents-war-room.tsx` (wired in `automation/page.tsx:6`). Real agent states come from worker processors in `src/workers/processors/*`. Use compositor-friendly properties only (`transform`, `opacity`) per web perf rules. Respect `prefers-reduced-motion`.
- **Depends on:** Stable job-state feed (SSE or polling) from the automation pipeline — partially wired via `PipelineStatus`.
- **Source:** User feedback, 2026-04-17.

## Phase 2

### Replace `git clone` in code-scanner with GitHub API
- **What:** Rewrite `cloneRepo()` in `src/services/code-scanner.ts` to fetch repo contents via GitHub's REST API (`GET /repos/{owner}/{repo}/tarball/{ref}` for bulk extraction, or `GET /repos/{owner}/{repo}/git/trees/{sha}?recursive=1` + `GET /repos/{owner}/{repo}/contents/{path}` for selective reads). Remove the `git` dependency from `nixpacks.toml`.
- **Why:** Eliminates the system-level `git` dependency (smaller container, smaller attack surface). Removes the token-in-URL anti-pattern (`https://x-access-token:${token}@github.com/...`) in favor of `Authorization: Bearer` headers. Tarball download avoids cloning `.git/` history and lets us stream-filter by path before unpacking large repos.
- **Context:** Current implementation at `src/services/code-scanner.ts:37-53` shell-outs to `git clone --depth 1 --single-branch`, which required shipping `git` in the Railway Nixpacks image (`nixpacks.toml` added 2026-04-19 as a hotfix). The scanner only reads a few manifest + key files (see `MAX_KEY_FILES = 10`), so a full git clone is already overkill. Swap to GitHub API using the existing token from `getGitHubToken()`. Keep the `cleanupClone()` contract so callers don't change.
- **Depends on:** None — self-contained refactor in `code-scanner.ts`.
- **Source:** Follow-up from the onboarding `Executable not found in $PATH: "git"` fix, 2026-04-19.

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
