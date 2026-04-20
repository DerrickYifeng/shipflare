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

### Post-ship polish

| Commit | What |
|---|---|
| `454a3f3` | `/api/today/[id]/undo` endpoint — cancels delayed BullMQ posting jobs, reverts drafts+todos status |
| `d634614` | ReplyCard platform-native header (r/foo · @author · ↑score) + hover-liftable content link to original post |
| `8aa2f41` | Discovery agent no longer writes `X - {topic}` community; schema refine + DB backfill |
| `b597e41` | Stopped "1935d" hallucinated timestamps on X threads; fallback to discoveredAt |
| `82d8bea` | Settings Account: Delete account moved to dedicated Danger zone with red border + filled button |

---

## Now — Dashboard fake data / missing API (audit 2026-04-19)

Full audit of authenticated routes. Grouped by page with exact locations.

### `/today` — mostly real; one cosmetic copy stub

- [ ] **`today-content.tsx:698` "Auto-scans every 4h"** — hardcoded cadence literal. The actual cron cadence lives in the worker config, not the user's preferences, so this string can be incorrect if the cadence ever changes. Minor; fix by reading cadence from a shared constant (`DISCOVERY_CRON_MINUTES`) or hiding the sub-string when cadence is unknown.
- Everything else real: `toReview` / `shippedToday` / `lastScan` come from `/api/today` real counts; scan triggers real BullMQ; undo endpoint shipped.

### `/product` — UI slots reserved for schema that doesn't exist yet

- [ ] **Product-schema extensions** — **biggest gap on this page.** Add columns to `products` table + Drizzle schema + `/api/onboarding/profile` writes:
  - `tagline: text`
  - `corePositioning: text`
  - `primaryIcp: text`
  - `competitors: text[]`
  - `approvedLinks: text[]`
  - `tone: jsonb` (for `{warmth, wit, formality, brevity}` 0–100 axes)
  - `bannedPhrases: text[]`
  - `signaturePhrases: text[]` (output of voice extraction, not user-edited)
  - **UI slots already reserved**: `product-content.tsx:58` `PLACEHOLDER_FIELDS` + `VoiceDnaCard` sliders + BannedPhrases textarea + Signature phrases card. All currently `useState`-only; lost on reload.
- [ ] **`product-content.tsx:105` banned phrases seeds `['crushing it', 'game-changer', 'unlock', '10x']`** — hardcoded starter list. Once persisted, either remove these seeds or move to an onboarding step.
- [ ] **`product-content.tsx:653` Voice DNA "Signature phrases" 4 hardcoded examples** (`'Moved from Jira → Linear 8 months ago'` etc.) — should come from real voice extraction output per product.
- [ ] **"Re-run voice scan" action routes to `/onboarding`** (no dedicated endpoint). Either build `POST /api/voice-profile/rescan` or keep the onboarding fallback and rename the affordance to "Redo voice onboarding".

### `/growth` — KPIs and data tables are mostly fixtures

- [ ] **`growth-content.tsx:50-58` `COMMUNITIES[]` — 7 fixture rows** (r/ExperiencedDevs, r/SaaS, r/startups, r/webdev, @founders, #buildinpublic, Ask HN). Fake `handle/members/health/fit/lastHit`. Wire to a real endpoint that aggregates `channels` + recent thread discovery counts per source.
  - Suggested endpoint: `GET /api/growth/communities` → rows from `threads` grouped by `(platform, community)` with `count(*)`, `avg(relevance_score)`, `max(discovered_at)`.
- [ ] **`growth-content.tsx:67-72` `KEYWORDS[]` — 4 fixture keyword triggers** (`'jira alternative'`, `'linear vs'`, etc.). Wire to real keyword watchlist from `discoveryConfigs.customPainPhrases` or a new `keyword_triggers` table.
- [ ] **`growth-content.tsx:74-90` `ICP_LIST[]` — 3 fixture ICP cards** (Engineering manager / Early-stage founder / Senior IC). Should come from the product-schema `primaryIcp` field above (blocked by that item).
- [ ] **`growth-content.tsx:171-172` KPI `THREADS / DAY AVG = 38` + `GATE PASS RATE = 86%`** — hardcoded strings. Compute from `pipeline_events` or `threads` rows over last 7d.

### `/calendar` — one stub tied to Stripe

- [ ] **`calendar-content.tsx:305` KPI `MONTHLY BUDGET = "43 / 120"`** — hardcoded. Depends on Stripe integration (budget = plan-tier limit; 43 = month-to-date sent count). Until Stripe ships, hide this card or show `—`.
- [ ] **Clock-format user preference** — Phase 5 `format-hour.ts` uses IANA timezone heuristic (`Europe/*` → 24h). Add `clockFormat: '12h' | '24h' | 'auto'` to `userPreferences`, surface in Settings › Account.

### `/settings` — Billing tab is full stub; rest is real

- [ ] **Billing tab — full placeholder** ("Beta — free" plan, disabled action buttons). Blocked by Stripe integration item in Product Backlog.
- Account / Appearance / Integrations / Safety — all real (delete, GitHub OAuth, channel connect/disconnect, `/api/preferences`).

### `/team` — scene is real; animations dormant

- [ ] **Worker-handoff SSE events** — emit `handoff:start` / `handoff:end` on `/api/events?channel=agents` when a job transitions agents. Frontend has `walkingAgentId` state at `team-content.tsx` waiting for these — once they fire, characters walk between desks carrying tickets. See `DATA_CONTRACT.md §2.3` for event shape.
- [ ] **Scheduler worker SSE emission** — Kit (scheduler) always shows idle because no processor emits on the `scheduler` stream key. Wire `publishPipelineEvent({ agent: 'scheduler', status: ... })` from the scheduler processor.

### `/` landing — marketing copy fixtures (lower priority)

- [ ] **`hero-demo.tsx:60` + `threads-section.tsx:123` "Live — 1,284 threads surfaced this week"** — same literal in two places. Replace with a cached `GET /api/marketing/stats` weekly aggregate.
- [ ] **`threads-section.tsx:14` `REAL_THREADS[]` — 3 fixture thread+reply examples** (r/indiehackers, @devtools, r/SaaS). Could stay as marketing copy forever OR wire to a curated public-board of anonymized shipped replies. Probably stays fixture — marketing tone is fine.

---

## Product Backlog

### Stripe Payment Integration
- **What:** Add Stripe checkout to enable paid subscriptions.
- **Why:** Can't validate willingness-to-pay without the ability to charge. Competitors charge $3/comment (ReplyAgent) or monthly subscriptions.
- **Context:** Pricing undefined. Needs user feedback from free beta first. Include pricing research and competitor analysis before implementing. Phase 5 Settings/Billing tab renders a placeholder ("Beta — free") + `/calendar` MONTHLY BUDGET KPI both unblocked by this.
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
