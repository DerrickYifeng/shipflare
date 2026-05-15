# Railway → Cloudflare Frontend Migration

**Date:** 2026-05-14
**Status:** Design — ready for implementation plan
**Branch target:** `feat/cf-migration-phase-2` (or successor)

---

## 1. Goal

Bring the Railway-era ShipFlare frontend onto the Cloudflare stack (`apps/web`) while:

- **Visually preserving** Railway's Apple-gallery aesthetic across the landing page and the five logged-in pages (`/briefing`, `/team`, `/product`, `/growth`, `/settings`).
- **Keeping the backend migration minimal** — reuse the existing CF agent topology (CMO + HeadOfGrowth + SocialMediaMgr Durable Objects), add only the smallest set of new tables / tools / skills needed.
- **Shipping page-by-page**, each slice fully wired before moving on.

The CF migration that landed earlier in May (PRs #30, #31, #32) gave us a CMO/HoG/SMM skeleton, the Skills registry inside `packages/skills`, the platform MCPs (X, Reddit), Better Auth, and a sign-in landing. This design picks up from there and replaces the placeholder CF UI (`/chat`, `/plan`, `/drafts`, `/memory`, `/notifications`, `/mcp-urls`, `/settings/channels`) with Railway's six-page surface.

## 2. Locked decisions

| # | Decision | Choice |
|---|---|---|
| 1 | Page strategy | **Replace** CF-only pages; the Railway 5 + landing become canonical |
| 2 | Backend role topology | **Keep CF's 3 employees** (CMO + HoG + SMM) — no collapse |
| 3 | Port depth | **Page-by-page slices**, each fully wired |
| 4 | Data location | **Hybrid** — D1 for founder-owned config & observed metrics; per-DO SQLite for agent-internal state |
| 5 | Component port | **Wholesale copy** Railway's `src/components/` tree into `apps/web/src/components/` |
| 6 | Slice order | Landing → Settings → Product → Briefing → Team → Growth |
| 7 | Auth providers | **GitHub + Google** (add Google to existing Better Auth config) |
| 8 | Settings/Billing tab | **Stub** — "Coming soon" card; no backend |
| 9 | Plan-allocation skill | **Port** `allocating-plan-items` markdown skill into `packages/skills` |
| 10 | Fonts | **Geist + system stack** (current `globals.css` fallback) |

## 3. Architecture overview

```
apps/web/                                apps/core/  (mostly unchanged)
├── app/
│   ├── page.tsx (LANDING — port)         agents/
│   ├── (app)/                             ├── cmo/CMO.ts (+ list_roster tool if absent)
│   │   ├── layout.tsx (PORT)              ├── head-of-growth/  (unchanged)
│   │   ├── briefing/page.tsx              ├── social-media-manager/  (unchanged)
│   │   ├── team/page.tsx                  └── platforms/{x,reddit}/  (unchanged)
│   │   ├── product/page.tsx
│   │   ├── growth/page.tsx               packages/
│   │   └── settings/page.tsx              ├── db/ (extend schema with 3 tables)
│   ├── api/                                └── skills/  (+ allocating-plan-items)
│   │   ├── auth/[...all]/  (existing)
│   │   ├── mcp-token/      (existing)
│   │   ├── product/        (NEW — Drizzle)
│   │   ├── growth/         (NEW — Drizzle)
│   │   └── preferences/    (NEW — Drizzle)
│   └── _components/  (extend SignInButton with provider param)
└── src/
    ├── auth.ts (+ google provider)
    ├── auth-client.ts  (unchanged)
    ├── components/  (NEW — wholesale copy of Railway src/components/)
    ├── hooks/       (NEW — wholesale copy of useTeamEvents, useTheme, usePreferences, …)
    ├── utils/       (NEW — wholesale copy of shell helpers)
    └── lib/
        ├── mcp-client.ts  (extend with list_roster, list_plan_items, list_drafts, …)
        └── drizzle.ts     (NEW — D1 client for product/growth/prefs)
```

**Deleted in the course of slicing:**
`apps/web/app/(app)/{chat,plan,drafts,memory,notifications,mcp-urls}/`, `apps/web/app/(app)/settings/channels/page.tsx` (folds into the new `/settings`). `/docs/mcp` is kept as a public docs surface.

## 4. Backend deltas

### 4.1 New D1 tables (in `packages/db/src/schema.ts`)

| Table | Cardinality | Columns | Purpose |
|---|---|---|---|
| `products` | one row per user | `userId, name, description, keywords (JSON), valueProp, url, state, launchDate, launchedAt, createdAt, updatedAt` | Founder-owned product profile. Powers `/product`; also read by HoG when generating strategy. |
| `growth_snapshots` | many per user per platform | `userId, platform, capturedAt, metrics (JSON: impressions, replies, followers, posts, …), createdAt` | Periodic rollups for `/growth` cards. Writer = cron job (slice 6). |
| `user_preferences` | one row per user | `userId, timezone, theme, updatedAt` | Powers `/settings` non-OAuth surface. |

`channels` (already exists), Better Auth tables (already exist), no per-DO state changes.

### 4.2 New API routes (Drizzle-backed, in `apps/web/app/api/`)

| Route | Verbs | Behaviour |
|---|---|---|
| `/api/product` | GET, PATCH | Read/write the caller's row in `products`. PATCH is field-level. |
| `/api/growth/overview` | GET | Latest `growth_snapshots` per platform + active `channels`. |
| `/api/preferences` | GET, PATCH | timezone, theme. |

All gated by Better Auth `getSession()`; reject anonymous.

### 4.3 New MCP tool on CMO

- `list_roster()` — return the caller's roster (CMO + HoG + SMM, plus any hired specialists). ~30 LOC. Only added if not already present in `apps/core/src/agents/cmo/`.

No other CMO tool additions. `list_plan_items`, `list_drafts`, `approve_draft`, `reject_draft`, `chat`, `listConversations`, `startNewConversation`, `archiveConversation`, `queryMemory`, `rememberThis`, `forgetThis`, `add_plan_item`, `query_founder_context`, `commit_strategic_path` all already exist.

### 4.4 New skill in `packages/skills`

- `allocating-plan-items` — port the Railway markdown skill (`src/skills/allocating-plan-items/SKILL.md`) into the CF inlined registry. Used by CMO when converting HoG's strategic path into a week of plan items with `scheduledAt`. Pure transformation skill, no tools called.

### 4.5 Cron writer for `growth_snapshots` (slice 6 only)

Extend the existing hourly trigger (`0 * * * *`) in `apps/core` to fan out per active user: call `x_metrics` + Reddit metrics, upsert the latest row into `growth_snapshots`. No new bindings, no new DOs.

### 4.6 What we do **not** add Phase 1

`web_search`, `web_fetch`, `read_memory` (CMO has `queryMemory`), `query_code_changes`, `query_stalled_items`, `query_last_week_completions`, `query_recent_x_posts`, Dynamic Workflows binding. These were Railway strategy aids; defer until exercised.

## 5. Frontend port strategy

### 5.1 Wholesale component copy

Mirror Railway's `src/components/` tree into `apps/web/src/components/`. No redesign during the copy.

| Railway path | CF destination | Used by |
|---|---|---|
| `src/components/marketing/*` | `apps/web/src/components/marketing/` | Slice 1 (landing) |
| `src/components/layout/*` | `apps/web/src/components/layout/` | Slice 2 (shell) and all (app) pages |
| `src/components/ui/*` | `apps/web/src/components/ui/` | All pages |
| `src/hooks/*` | `apps/web/src/hooks/` | `useTeamEvents`, `usePreferences`, `useTheme`, `useReducedMotion` |
| `src/utils/*` (selected) | `apps/web/src/utils/` | `resolveNavLabel`, `derivePhase`, formatters |

### 5.2 Adjustments during the copy (greppable)

1. `import from "next-auth/react"` / `auth()` → Better Auth equivalents (`authClient` from `@/auth-client` client-side, `getSession()` server-side via `@/auth`).
2. `import from "@/lib/db"` → `apps/web/src/lib/drizzle.ts` for D1-backed pages.
3. Postgres reads → either `/api/*` (Drizzle) or `CmoClient` (MCP), per the page's data-location row in §5.4.
4. `'use server'` server actions → API route handlers, or MCP calls.
5. `process.env.NEXTAUTH_URL` → `BETTER_AUTH_URL`; `DATABASE_URL` → D1 binding; `CORE_PUBLIC_URL` for browser MCP target.
6. Drop Node-only imports (`node:crypto`, `node:fs`) — use Workers-compat or remove.

### 5.3 Design tokens — already aligned

`apps/web/app/globals.css` already carries the full `sf-*` token set (colors, type scale, spacing, radius, shadow, motion, dark-mode `.app-dark` remap). No changes; this is what makes wholesale copy practical.

Fonts: `--sf-font-display` and friends fall back to Geist + system stack already. macOS/iOS users get real SF Pro via `-apple-system, BlinkMacSystemFont`; everyone else gets Geist. Zero payload added.

### 5.4 Data-fetching shape per page

| Page | Reads from | Mechanism |
|---|---|---|
| `/` (landing) | nothing | static |
| `/settings` | D1 (`channels`, `user_preferences`, Better Auth session) | server component + Drizzle + `getSession()` |
| `/product` | D1 (`products`) | server component initial + `useSWR('/api/product')` for optimistic editing |
| `/growth` | D1 (`channels`, `growth_snapshots`) | `useSWR('/api/growth/overview')` |
| `/briefing` | DO (CMO) | `CmoClient` browser-direct MCP; JWT from `/api/mcp-token` |
| `/team` | DO (CMO) | `CmoClient` + `chat` streaming tool |

### 5.5 Auth providers

Add `google` to Better Auth `socialProviders` in `apps/web/src/auth.ts`. New wrangler secrets: `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`. New callback URL on the Google OAuth client: `https://shipflare.ai/api/auth/callback/google`.

### 5.6 Theme

Port `ThemeProvider` + `useTheme` from Railway. Toggle adds/removes `.app-dark` on `<html>`. Persist in `user_preferences.theme` via `/api/preferences` PATCH (and mirror to `localStorage` for first-paint).

## 6. Slice-by-slice plan

Each slice ships as one PR-shaped unit: page + components it needs + data layer + deletes of superseded CF code + Playwright real-browser smoke before merge.

### Slice 1 — Landing page

**Ships:**
- `apps/web/app/page.tsx` replaces the sign-in-button-only landing with the ported Railway hero
- `apps/web/src/components/marketing/{GlassNav, HeroDemo, HowItWorks, VideoSection, PhaseSection, ThreadsSection, SafetySection, Footer, …}`
- `apps/web/app/_components/sign-in-button.tsx` extended to accept `provider: 'github' | 'google'`; landing CTA shows both
- `google` provider added to `apps/web/src/auth.ts`; `GOOGLE_CLIENT_ID/SECRET` added to wrangler.jsonc

**No DB or DO changes.**

**Smoke test:** real-browser hits `/`, hero visible, "Sign in with GitHub" → callback → redirect succeeds. "Sign in with Google" → consent → callback → redirect succeeds.

### Slice 2 — Settings + (app) shell

**Ships:**
- `apps/web/app/(app)/layout.tsx` — port Railway shell (Sidebar, TopNav, SWRConfig, ThemeProvider, ShellChromeProvider, ToastProvider, AppShell)
- `apps/web/app/(app)/settings/page.tsx` + `settings-content.tsx` — Account · Billing · Integrations · Appearance tabs. Billing tab is a "Coming soon" stub card.
- Wholesale copy of `apps/web/src/components/{layout, ui}/*`
- Hooks: `usePreferences`, `useTheme`
- D1 migration `0001_user_preferences.sql` (named, forward-only)
- API routes `/api/preferences` (GET, PATCH)
- Integrations tab reads existing `channels`; X connect/disconnect routes already exist at `/api/channels/x/{connect,callback}`
- **Deletes:** `apps/web/app/(app)/settings/channels/page.tsx` (folds in)

**Smoke test:** sign in → land on `/settings` → connect X via OAuth roundtrip → toggle theme dark/light → reload, theme persists. Billing tab shows "Coming soon".

### Slice 3 — Product

**Ships:**
- D1 migration `0002_products.sql`
- API routes `/api/product` (GET, PATCH)
- `apps/web/app/(app)/product/page.tsx` + `product-content.tsx` + `_components/editable-value.tsx` — wholesale port
- SSR initial snapshot via Drizzle, SWR hydration for optimistic edits

**Smoke test:** edit product name → optimistic UI updates → PATCH fires → reload → name persisted. Repeat for `valueProp` and `url`.

### Slice 4 — Briefing + post-login redirect

**Ships:**
- `apps/web/app/(app)/briefing/page.tsx` + TodayTab port + sub-components
- Data rewire: instead of Railway's Postgres query, `CmoClient.list_plan_items({ scheduledOn: today })` + `CmoClient.list_drafts({ status: 'pending' })`
- `SignInButton` callbackURL updated from `/chat` → `/briefing`
- `/today` and `/calendar` → `/briefing` 301 redirects (matches Railway)
- **Deletes:** `apps/web/app/(app)/{chat,plan,drafts}/*` (chat folds into Team in slice 5; plan + drafts visible inside briefing + team)

**Smoke test:** post-login lands on `/briefing` → today's plan items visible → drafts pending count shown → click a draft drills into approval UI.

### Slice 5 — Team (biggest slice)

**Ships:**
- `apps/web/app/(app)/team/page.tsx` (replaces the existing CF stub) + `team-desk.tsx` (~1150 LOC) + `LeftRail`, `Conversation`, `StatusBanner`, `StickyComposer`, `conversation-reducer`
- `apps/web/src/hooks/useTeamEvents.ts` — adapt Railway's `/api/team/stream` SSE consumer to CF's `CmoClient.chat` chunk callback
- New CMO tool `list_roster` (~30 LOC) if not present
- New skill in `packages/skills`: `allocating-plan-items` (markdown port from Railway)
- Wire `CmoClient`: `list_roster`, `listConversations`, `startNewConversation`, `archiveConversation`, `chat` (stream), `list_plan_items`, `list_drafts`, `approve_draft`, `reject_draft`, `commit_strategic_path`, `add_plan_item`, `queryMemory`, `rememberThis`
- **Deletes:** `apps/web/app/(app)/memory/*`, `apps/web/app/(app)/mcp-urls/*`

**Smoke test:** `/team` shows 3 employees in left rail → type brief in composer → reply streams in chat column → plan item appears in mid-column → click "Approve" on a pending draft → status updates live.

### Slice 6 — Growth

**Ships:**
- D1 migration `0003_growth_snapshots.sql`
- Cron writer: extend existing `0 * * * *` in `apps/core` to fan out → per active user, call `x_metrics` + Reddit metrics, upsert latest snapshot
- API route `/api/growth/overview` (GET)
- `apps/web/app/(app)/growth/page.tsx` + `growth-content.tsx` + `_components/{overall-hero, social-panel, channel-card}` — wholesale port
- **Deletes:** `apps/web/app/(app)/notifications/*`

**Smoke test:** `/growth` renders with overall dial + X card + Reddit card showing real numbers from the most recent snapshot.

## 7. Testing strategy

| Layer | Tool | Standard |
|---|---|---|
| Unit | Vitest + `@cloudflare/vitest-pool-workers` | Every new MCP tool and every new Drizzle helper has tests |
| Type / build | `pnpm tsc --noEmit` for `apps/web` and `apps/core`; `pnpm build` for both | Green before claiming any slice done. Build gate is tsc, not vitest. |
| DB | Forward-only migrations run cleanly on fresh D1 and on prod-shape D1 | Verified via `wrangler d1 migrations apply --local` and `--remote` |
| Real-browser smoke | Playwright connected to the developer's already-authenticated local Chromium | One scenario per slice, defined in §6 |
| Visual review | Side-by-side screenshot Railway vs CF at 320 / 768 / 1440 | Reviewed before merging each slice |

A slice is not done until the Playwright smoke runs green AND the screenshot review passes.

## 8. Risks

1. **SSR flash on DO-backed pages.** `/briefing` and `/team` can't SSR — they fetch over browser-direct MCP after mount. Same pattern CF's current `/chat` already uses. Mitigation: skeleton state in the port; do not block initial paint.
2. **SSE → MCP streaming adapter** in `useTeamEvents`. Bug-prone seam. Mitigation: unit-test the adapter against a mock streaming source.
3. **Worker bundle size.** Marketing tree is large. OpenNext bundle has a hard limit. Mitigation: dynamic-import marketing components so they don't ride into the `(app)` chunk.
4. **Better Auth Google provider plumbing.** Common gotchas: callback URL exactness, consent screen verification on a fresh GCP project. Allocate 30 min in slice 1.
5. **Cron fan-out cost (slice 6).** Hourly × users × 2 platforms × API calls. Start with `*/6 * * * *` (every 6 hours) and tighten when usage proves out. Respect X API tier limits.
6. **Forward-only D1 migrations.** Add only; never drop. Named migrations shared between web + core wrangler configs.
7. **Reddit OAuth is no-binding always-on** per CLAUDE.md project memory. Settings/Integrations shows X as the only connectable channel; Reddit appears only on `/growth`.
8. **Memory + notifications deletes are one-way.** If users later want a dedicated memory page or push opt-in surface, those revive as new work; not a regression in this design.

## 9. Out of scope (Phase 1)

Onboarding wizard, admin pages, real billing/payments, PWA / service worker beyond what already exists, analytics integration (PostHog/Segment), skill marketplace, LinkedIn / HackerNews / Discord platforms, Dynamic Workflows for scheduled multi-step plans.

## 10. Decision log (chronological)

This design is the output of a `/brainstorming` session on 2026-05-14. The full Q&A trail produced the locked-decision table in §2. The user explicitly preferred page-by-page slicing over a "full functional parity per page" big-bang or "visual shell first, wire later" approach, on the grounds that each shipped slice should be real.
