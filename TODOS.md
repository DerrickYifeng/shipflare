# TODOS

---

## Active — v3 Planner + Onboarding Rewrite (2026-04-20 — IN PROGRESS)

**Canonical plan:** [`docs/superpowers/plans/2026-04-20-master-implementation-plan.md`](docs/superpowers/plans/2026-04-20-master-implementation-plan.md)

**Spec docs:**
- [`2026-04-20-planner-and-skills-redesign-design.md`](docs/superpowers/specs/2026-04-20-planner-and-skills-redesign-design.md) — backend canonical (schema, agents, APIs)
- [`2026-04-20-onboarding-frontend-design.md`](docs/superpowers/specs/2026-04-20-onboarding-frontend-design.md) — frontend canonical (v3 tokens, 7 stages, pixel-perfect target)
- [`2026-04-19-onboarding-redesign-design.md`](docs/superpowers/specs/2026-04-19-onboarding-redesign-design.md) — original UX flow (still authoritative for copy/UX)
- [`2026-04-19-onboarding-backend-design.md`](docs/superpowers/specs/2026-04-19-onboarding-backend-design.md) — **partially superseded** (see banner in file)

**Agent team:** `shipflare-v3` (PM + data-engineer + frontend-engineer + backend-engineer + qa-engineer). Config at `~/.claude/teams/shipflare-v3/config.json`. Task list at `~/.claude/tasks/shipflare-v3/`.

### Phase roadmap (15 phases)

| # | Phase | Status | Owner | Gate |
|---|---|---|---|---|
| 1 | Schema foundations (migration + derivePhase) | ✅ `919c459` | data-engineer | migration `0001_planner_refresh.sql`, 160-line tests, kill-list for Phase 2: 20+ files |
| 2 | lifecyclePhase → state caller refactor (29 files) | 🔄 active | backend-engineer | `pnpm build` green, no `lifecyclePhase` greps |
| 3 | Verify schema cleanup (residual import sweep) | ⏳ blocked by 2 | data-engineer | DB state clean |
| 4 | Atomic skills — rename survivors + skill catalog | ⏳ blocked by 3 | backend-engineer | `_catalog.ts` covers all |
| 5 | Atomic skills — ~15 new (email, launch assets, research) | ⏳ blocked by 4 | backend-engineer | every skill IO test passes |
| 6 | Strategic + tactical planner agents | ⏳ blocked by 5 | backend-engineer | 21 fixture tests green |
| 7 | plan-execute queue + workers + state machine | ⏳ blocked by 6 | backend-engineer | full SM integration test green |
| 8 | API endpoints (plan, commit, draft, replan, plan-item/*) | ⏳ blocked by 7 | backend-engineer | /plan <15s, /commit tx atomic |
| 9 | `scripts/seed-user.ts` for dogfooding | ⏳ blocked by 8 | backend-engineer | populated Today works |
| 10 | v3 brand token refresh (Apple Blue) | ✅ `cc196e6`+`2876db7` | frontend-engineer | 0 v2-token hits, 19 UI primitives retinted |
| 11 | Onboarding chrome (shell + primitives + copy) | 🔄 active | frontend-engineer-2 | desktop + mobile chrome pixel-perfect |
| 12 | Onboarding stages (7 sub-stages, order 1→3→4→5→7→2→6) | ⏳ blocked by 8 + 11 | frontend-engineer | all stages wired to real APIs |
| 13 | Today Landed (hero + welcome ribbon) | ⏳ blocked by 12 | frontend-engineer | fresh onboard → hero verified |
| 14 | QA + E2E (happy paths + 4 edge cases + mobile) | ⏳ blocked by 13 | qa-engineer | Lighthouse ≥90 perf, ≥95 a11y |
| 15 | Cleanup (docs, README, CLAUDE.md, dead code) | ⏳ blocked by 14 | product-lead | Definition of Done met |

**Parallelization:** Phase 10 runs in parallel with Phases 4-9 (disjoint file sets — tokens/UI vs skills/agents/API). Phase 12 joins when both Phase 11 and Phase 8 are done.

**Honest estimate:** 3–4 solo weeks of focused work. Single session won't complete all phases — team will work incrementally, report back after each phase lands.

---

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
| `9204bec` | SignInModal rewritten on v2 canonical tokens (was rendering invisible due to dropped v1 `bg-sf-bg-*` classes) |

---

# P0 — Ship blockers (behavioural bugs)

Things the user can directly see going wrong. Fix before any public launch push.

### Today: posting delay (0–30min) contradicts UI's "5s undo"
- **Symptom:** `ReplyCard` renders a `PostingProgressBar` with `durationMs={5000}`, toast copy implies 5s, but `enqueuePosting` uses `Math.random() * 30 * 60 * 1000` as the BullMQ delay. After the 5s bar completes the card looks committed, yet the post won't actually go out for anywhere from 0 to 30 minutes. Undo works for that whole window, but the UI lies about when to act.
- **Fix options (pick one):**
  - **A.** Make posting strictly `5s` delay. Tight but matches UI. Lose the "spread out" anti-detection window.
  - **B.** Keep 0–30m randomisation; rewrite UI to show `"scheduled to post at 11:42"` + `Undo` button that stays active until the job fires. Drop the 5s progress bar.
- **Where:** `src/workers/processors/posting.ts` (delay source) · `src/app/(app)/today/_components/reply-card.tsx:179` (progress bar) · `src/app/(app)/today/today-content.tsx:252` (toast copy).
- **Source:** 2026-04-19 audit.

### V1 design-token residue audit
- **Symptom:** SignInModal rendered blank because it used `bg-sf-bg-secondary` / `bg-sf-bg-dark-surface` / `rounded-[var(--radius-sf-md)]` etc. — all v1 names that Phase 1 cleanup removed. Tailwind v4 **silently drops unknown utilities**, so the failure is invisible until the component is rendered in-browser. Any other corner of the codebase still on v1 tokens will render just as broken the first time it's exercised.
- **Fix:**
  1. `grep -rnE 'bg-sf-bg-|text-sf-text-|rounded-\[var\(--radius-sf-|shadow-\[var\(--shadow-sf-|border-sf-accent' src/` → produces the kill list
  2. Map each hit to its v2 equivalent (`--sf-paper-raised`, `--sf-fg-1/2/3`, `--sf-radius-md`, `--sf-shadow-sm/md/lg`, `--sf-signal`, etc.) or delete if stale
  3. Add an ESLint rule (or a CI grep check) that fails on those v1 patterns so they can't sneak back
- **Source:** 2026-04-19, SignInModal regression (commit `9204bec`).

---

# P1 — Dashboard data & schema gaps

UI slots are reserved; backend isn't there yet. Grouped by route. Exact `file:line` citations included so the next session can pick any one up directly.

### `/today`

- **`today-content.tsx:698` "Auto-scans every 4h"** — hardcoded cadence string. Real cron cadence is a worker-side constant. If someone tunes the cron to 6h, this copy keeps lying. Read from a shared `DISCOVERY_CRON_MINUTES` constant or hide the fragment when cadence is undefined.
- **X reply cards have no `↑` score and no `💬` count** — `xAI x_search` tool only returns `{id, url, author, text}`. Same upstream gap as the `postedAt` hallucination fix. Either (a) make a `x_get_tweet` follow-up call on each candidate to enrich `threadUpvotes` + `threadCommentCount` (costs an API call per candidate, adds latency), or (b) accept that X cards are intentionally lean and drop the score affordance for X in the UI.

### `/product` — full schema extension needed

- **Biggest single gap on the dashboard.** Add columns to `products` + Drizzle schema + `/api/onboarding/profile`:
  - `tagline: text`
  - `corePositioning: text`
  - `primaryIcp: text`
  - `competitors: text[]`
  - `approvedLinks: text[]`
  - `tone: jsonb` (`{warmth, wit, formality, brevity}` 0–100)
  - `bannedPhrases: text[]`
  - `signaturePhrases: text[]` (voice-extraction output, read-only to user)
- **Reserved UI**: `product-content.tsx:58` `PLACEHOLDER_FIELDS` (5 rows) · `VoiceDnaCard` sliders (`product-content.tsx:646`) · banned-phrases textarea (`:105`) · "Signature phrases" block (`:653`). All `useState`-only today; changes are lost on reload.
- **`product-content.tsx:105` banned-phrases seeds** `['crushing it', 'game-changer', 'unlock', '10x']` — hardcoded starter list. Once persisted, either remove seeds or move to an onboarding step.
- **`product-content.tsx:653` signature-phrase examples** — 4 hardcoded phrases (`'Moved from Jira → Linear 8 months ago'` etc.). Should come from the voice-extraction pipeline output.
- **"Re-run voice scan" action** → currently redirects to `/onboarding` since no dedicated endpoint exists. Either build `POST /api/voice-profile/rescan` or rename the affordance to "Redo voice onboarding" and keep the redirect.

### `/growth`

- **`growth-content.tsx:50-58` `COMMUNITIES[]`** — 7 fixture rows (r/ExperiencedDevs, r/SaaS, r/startups, r/webdev, @founders, #buildinpublic, Ask HN). Fake `handle` / `members` / `health` / `fit` / `lastHit`. Wire to `GET /api/growth/communities` aggregating `threads` by `(platform, community)` with counts + `avg(relevance_score)` + `max(discovered_at)`.
- **`growth-content.tsx:67-72` `KEYWORDS[]`** — 4 fixture keyword triggers. Wire to `discoveryConfigs.customPainPhrases` or a new `keyword_triggers` table.
- **`growth-content.tsx:74-90` `ICP_LIST[]`** — 3 fixture ICP cards. Blocked by the `/product` schema extension above (`primaryIcp` column).
- **`growth-content.tsx:171-172` KPI magic numbers** — `THREADS / DAY AVG = '38'`, `GATE PASS RATE = '86%'`. Derive from `pipeline_events` or `threads` rows over last 7d.

### `/calendar`

- **`calendar-content.tsx:305` `MONTHLY BUDGET = "43 / 120"`** — hardcoded. Blocked by Stripe integration (budget = plan-tier limit; 43 = MTD sent count). Until Stripe ships, render `—` or hide.
- **Clock-format user preference** — `src/lib/format-hour.ts` uses an IANA timezone heuristic (`Europe/*` → 24h) that fails for Asia / Africa / South America. Add `clockFormat: '12h' | '24h' | 'auto'` to `userPreferences`, surface in Settings › Account.

### `/settings`

- **Billing tab — full placeholder** ("Beta — free" plan, disabled actions). Blocked by Stripe integration.
- Account / Appearance / Integrations / Safety are all real (delete account, GitHub OAuth, channel connect/disconnect, `/api/preferences`).

### `/team` — scene is real; animations dormant

- **Worker-handoff SSE events** — emit `handoff:start` / `handoff:end` on `/api/events?channel=agents` when a job transitions agents. Frontend (`team-content.tsx` `walkingAgentId` state) is wired and waiting. See `DATA_CONTRACT.md §2.3`.
- **Scheduler worker SSE** — Kit (scheduler) always idle because no processor emits on the `scheduler` stream key. Wire `publishPipelineEvent({ agent: 'scheduler', status: ... })` from the scheduler processor.

---

# P1 — Experience consistency

### `/onboarding` is still on v1 visual language
- **Problem:** Phase 5 rebuilt the 6 app routes but `/onboarding` was out of scope. New users go `landing (v2 marketing) → onboarding (v1 Apple-era styling) → /today (v2 app shell)` — three distinct looks in one flow.
- **Fix:** Port `/onboarding` to the v2 app shell (Sidebar-less variant is fine, just keep the TopNav / tokens / Card primitives). Reuse `Button`, `PillCta`, `FieldRow`, `Ops`, `Card`.
- **Bonus:** Onboarding's voice-extraction completion also unblocks the `voiceScannedAt` VERIFIED badge on `/product` and the schema items above.

### `/dashboard` is an orphan route
- **Problem:** `src/app/(app)/dashboard/page.tsx` still renders `PipelineFunnel` but the Phase 3 sidebar no longer links to it, and the Phase 3 P0 regex fix dropped the `Metrics → /dashboard` TopNav label too. Route is reachable by URL only.
- **Fix (pick one):**
  - **A.** Add "Dashboard" back to sidebar as the Analytics/Metrics surface.
  - **B.** Merge `PipelineFunnel` into `/growth` (it's basically the same audience) and `redirect('/growth')` from `/dashboard`.
  - **C.** Delete the route if PipelineFunnel is redundant with the office scene.

---

# P2 — Quality baseline

### Per-route `loading.tsx` / `error.tsx` / empty states
- **Current:** `/today/loading.tsx` + `FirstRun` empty state exist. `/product` has initial skeleton. Other routes — mostly missing.
- **Audit:** Add `loading.tsx` (Skeleton-based) + `error.tsx` (fall-back with retry) + meaningful empty state (using `<EmptyState>` primitive) for `/product`, `/growth`, `/calendar`, `/settings`, `/team`. Empty states should hint at next action ("Connect an X account" / "Run voice scan" / "No scans yet — click Scan now").

### Full dark-mode QA sweep
- **Current:** ThemeProvider + toggle ship across the app but no page-by-page verification after Phase 5/6. Certain inline-style colour literals may render wrong in `.app-dark`.
- **Audit:** Walk each app route in both light and dark, record defects. Particular suspects: HealthMeter dial colours, `/team` isometric scene palette, Calendar hour labels, PostingProgressBar, Danger zone card.

### ⌘K command palette is a scaffold
- **Current:** ⌘K opens a modal but shows "Coming soon". Shipping the hint without the handler was called out in the Phase 3 audit as a "visible lie".
- **Minimum viable:** Wire three command classes:
  1. Route jumps (`Today`, `Growth`, `Calendar`, `Team`, `Product`, `Settings`)
  2. Today actions (`Approve active card`, `Skip active card`, `Open scan drawer`)
  3. Search: fuzzy-match across current Today items' titles / thread bodies
- Keyboard handler already exists in AppShell. Just needs a `useCommands()` hook + a list renderer.

---

# P3 — Infrastructure (long-term)

### Front-end error observability
- No Sentry / PostHog / comparable capture layer. When `/api/today` fails the user gets a silent blank. Should surface a degraded-state UI with a reason + retry.

### Accessibility pass
- Focus rings on nav items (sidebar + top-nav): verify visible in both themes.
- Tab order through Today's card stack beyond the j/k/a/e/s keyboard shortcuts.
- ARIA labels on the `/team` isometric office SVG characters (currently none → screen readers see a blob).
- `aria-live` regions for scan progress / toast announcements.

---

# Product Backlog (scope / strategy)

### Stripe Payment Integration
- **What:** Add Stripe checkout to enable paid subscriptions.
- **Why:** Can't validate willingness-to-pay without the ability to charge. Competitors charge $3/comment (ReplyAgent) or monthly subscriptions.
- **Unblocks:** Settings › Billing tab, Calendar `MONTHLY BUDGET` KPI.
- **Depends on:** Beta user feedback, defined pricing tiers.
- **Source:** /plan-eng-review outside voice, 2026-04-11.

### Adaptive Health Score Engagement Baseline
- **What:** Replace hardcoded engagement baseline (20) in Health Score S3 normalization with per-subreddit adaptive baselines from the user's own posting history.
- **Why:** Engagement norms vary wildly per community (r/programming avg 20 = normal; r/SideProject avg 20 = exceptional).
- **Context:** Shipped `HealthMeter` consumes whatever `/api/health` returns — wire the adaptive baseline behind that endpoint.
- **Depends on:** ~10+ posts per subreddit (2–3 weeks of active use).
- **Source:** /plan-eng-review code quality review, 2026-04-11.

### Weekly Marketing Digest Email
- **What:** Automated weekly summary email (performance, drafts, trends).
- **Why:** Anti-churn — brings users back when they forget to check the dashboard.
- **Depends on:** Email infra (Resend / Postmark).
- **Source:** /plan-ceo-review scope decision #3, 2026-04-11.

### MCP Server Interface
- **What:** HTTP-transport MCP server exposing 4 tools: discover, drafts, approve, status.
- **Why:** Developer power-user differentiator for integrating ShipFlare into other workflows.
- **Depends on:** Stable API layer.
- **Source:** /plan-eng-review architecture review, 2026-04-11.

### Native X API v2 (replace xAI Grok search)
- **What:** Add X API v2 Basic tier for Discovery + Content + Posting.
- **Why:** xAI Grok's `x_search` doesn't return `createdAt` (→ "1935d" hallucination), `likes`, `replies` (→ blank ↑/💬 on X cards). Native API would unlock real timestamps + engagement metrics.
- **Cost:** ~$100/mo for Basic.
- **Depends on:** Reddit validation, revenue justifying the API cost.
- **Source:** Phase 7 audit + /plan-eng-review Step 0, 2026-04-11.

### Stripe / Revenue Attribution
- **What:** Track which posts/channels drive revenue.
- **Why:** Closed loop from marketing to money.
- **Depends on:** Stripe, mature analytics pipeline.
- **Source:** /plan-ceo-review scope decision #7, 2026-04-11.

---

# Landing (low-priority copy fixtures)

Not part of the dashboard audit. Kept here for completeness; acceptable to leave as marketing copy indefinitely.

- Hero eyebrow "Live — 1,284 threads surfaced this week" (`hero-demo.tsx:60` + `threads-section.tsx:123`)
- `threads-section.tsx:14` `REAL_THREADS[]` — 3 curated thread+reply examples
- `safety-section.tsx:14` `REVIEW_CASES[]` — adversarial-review log examples
