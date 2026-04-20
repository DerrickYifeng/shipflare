# TODOS

## Recently Shipped — v2 Frontend Migration (2026-04-19)

All 7 phases landed on `dev` (unpushed). Design handoff at `public/ShipFlare Design System.zip`.

| Phase | Commit | What landed |
|---|---|---|
| 1 — Tokens | `66845f7`, `f37460b` | Single canonical `@theme` block from `tokens.css`; cheat-sheet at `/tokens` |
| 2 — Primitives | `963c01f` | 12 components in `src/components/ui/`; showcase at `/tokens/primitives` |
| 3 — App Shell | `06bca0f` | Sidebar 232px, TopNav 56px glass, HeaderBar, custom ThemeProvider with pre-paint script |
| 4 — Today | `eb6e982` | Boss/employee approval inbox, ScanDrawer wired to real BullMQ + SSE `/api/events?channel=agents` |
| 5 — Pages | `433e927` | `/product /growth /calendar /settings`; new `HealthMeter` dial, `FieldRow`, `SectionBar`, `Switch`, `PlatformTag` |
| 6 — Office | `75a4498` | `/team` isometric scene; `/automation` → 307 redirect to `/team`; sidebar label switched |
| 7 — Landing | `b4de275` | `/` dark-only marketing; hero typing demo on transform/opacity only |

## Now — v2 Follow-ups (unblock ship)

### `/api/today/[id]/undo` endpoint
- **What:** Implement the 5s-undo endpoint the new ReplyCard UI already POSTs to. Approval enqueues posting via BullMQ with a 5s delay; undo must cancel the delayed job before it fires. Return 200 if cancelled, 409 if already posted.
- **Why:** Phase 4 shipped the client-side undo affordance but the server endpoint is a no-op. Users clicking undo currently see the toast dismiss but the post still ships after 5s.
- **Context:** Existing `enqueuePosting` uses BullMQ delayed jobs. Cancellation = `job.remove()` if still delayed. See DATA_CONTRACT §1.4.
- **Depends on:** None.
- **Source:** Phase 4 stub, 2026-04-19.

### Product-schema extensions for Voice DNA + banned phrases
- **What:** Add `tone`, `voiceDnaSliders` (JSONB), `bannedPhrases` (text[]) columns to `products` table + Drizzle schema. Wire the Phase 5 `/product` sliders and banned-phrases list to persist via `/api/onboarding/profile`.
- **Why:** Phase 5 sliders and banned-phrases list are local-state-only today — changes are lost on reload. Also blocks the Voice DNA re-scan flow (currently routes to `/onboarding` as a fallback).
- **Context:** See `src/app/(app)/product/product-content.tsx` for the UI that needs persistence.
- **Depends on:** None.
- **Source:** Phase 5 stub, 2026-04-19.

### Clock-format user preference (12h vs 24h)
- **What:** Add `clockFormat: '12h' | '24h'` to `userPreferences` schema. Replace Phase 5's `src/lib/format-hour.ts` timezone heuristic (`Europe/*` → 24h) with the real preference.
- **Why:** Calendar slot times currently use a heuristic that fails for Asian / African / South American timezones.
- **Depends on:** None.
- **Source:** Phase 5 stub, 2026-04-19.

### Worker-handoff SSE events (lights up /team walking animation)
- **What:** Emit `handoff:start` / `handoff:end` SSE events from workers when a job transitions from one agent to another. Frontend is already wired — `src/app/(app)/team/_components/team-content.tsx` has a `walkingAgentId` state waiting for these events to trigger the walk-cycle animation.
- **Why:** Without these events, the isometric office shows characters idling at desks instead of walking between them carrying tickets. The signature entertainment moment of Phase 6 is dormant.
- **Context:** See `DATA_CONTRACT.md §2.3` for the event shape. Publish via `publishPipelineEvent` on the existing `/api/events?channel=agents` channel.
- **Depends on:** None.
- **Source:** Phase 6 stub, 2026-04-19.

### Scheduler worker SSE emission (Kit character)
- **What:** Wire `publishPipelineEvent({ agent: 'scheduler', status: ... })` from the scheduler processor so Kit in `/team` reflects real state.
- **Why:** The `/team` roster claims 5 working agents but Kit is always dark — no worker emits events on the `scheduler` stream key.
- **Depends on:** None.
- **Source:** Phase 6 stub, 2026-04-19.

### Hero eyebrow metric & ThreadsSection real data
- **What:** Replace the hardcoded "Live — 1,284 threads surfaced this week" in `src/components/marketing/hero-demo.tsx` with a real count (public aggregate endpoint). Same for ThreadsSection example replies — currently static fixtures.
- **Why:** Marketing credibility. Real numbers > fake numbers.
- **Context:** Could read from a cached `/api/marketing/stats` that aggregates `threads` and `posts` rows weekly.
- **Depends on:** None.
- **Source:** Phase 7 note, 2026-04-19.

## Product Backlog

### Stripe Payment Integration
- **What:** Add Stripe checkout to enable paid subscriptions.
- **Why:** Can't validate willingness-to-pay without the ability to charge. Competitors charge $3/comment (ReplyAgent) or monthly subscriptions.
- **Context:** Pricing undefined. Needs user feedback from free beta first. Include pricing research and competitor analysis before implementing. Phase 5 Settings/Billing tab renders a placeholder ("Beta — free") awaiting this.
- **Depends on:** Working product with beta users, defined pricing tiers.
- **Source:** /plan-eng-review outside voice, 2026-04-11.

### Adaptive Health Score Engagement Baseline
- **What:** Replace hardcoded engagement baseline (20) in Health Score S3 normalization with per-subreddit adaptive baselines derived from user's own posting history.
- **Why:** Different subreddits have wildly different engagement norms. r/programming avg 20 upvotes is normal, r/SideProject avg 20 is exceptional.
- **Context:** Phase 1 uses hardcoded 20 (known-wrong but measurable). Adaptive version calculates median engagement after 10+ posts per subreddit, falls back to global default (20) below threshold. The shipped v2 `HealthMeter` dial consumes whatever `/api/health` returns — wire the adaptive baseline behind that endpoint.
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
