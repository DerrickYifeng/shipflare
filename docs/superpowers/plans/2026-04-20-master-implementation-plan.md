# ShipFlare v3 — Master Implementation Plan

**Date:** 2026-04-20
**Scope:** Full onboarding redesign + planner/skill architecture rewrite +
v3 brand refresh in one coordinated effort.

**Source specs (read first)**:
1. `specs/2026-04-19-onboarding-redesign-design.md` — original onboarding UX spec
2. `specs/2026-04-19-onboarding-backend-design.md` — original backend (partially superseded)
3. `specs/2026-04-20-planner-and-skills-redesign-design.md` — **canonical backend + agents**
4. `specs/2026-04-20-onboarding-frontend-design.md` — **canonical frontend + tokens**

This plan is the execution sequence that ships all four of the above.
Product hasn't launched — no dual-write, no backwards compat.

---

## Ground rules

1. **One product shift at a time**. Merge migrations, then refactor callers, then new agents, then new endpoints, then frontend. Don't interleave.
2. **Every phase ends with a green test run**. `pnpm test` + `pnpm build` must pass before the next phase starts.
3. **Backend lands ahead of frontend**. The `/onboarding` route will be intentionally broken between Phase 6 and Phase 8. `scripts/seed-user.ts` covers dogfooding during that window.
4. **No v2/v3 aliasing**. When `--sf-signal` becomes `--sf-accent`, every consumer updates in the same PR.
5. **Commit granularity**: one logical change per commit. A phase may be 3-10 commits. Each commit compiles and tests pass.

---

## Phase map

```
Phase 1   Schema foundations         ────┐
Phase 2  lifecyclePhase → state       ───┤  DB + caller safety net
Phase 3  Delete v1 planner tables    ───┘

Phase 4  Atomic skills — surviving   ────┐
Phase 5  Atomic skills — new         ───┤  Agent/skill layer
Phase 6  Strategic + tactical planner ───┘

Phase 7  Queues + workers            ────┐
Phase 8  API endpoints               ───┤  Server surface
Phase 9  scripts/seed-user.ts        ───┘

Phase 10 Brand tokens refresh        ────┐
Phase 11 Onboarding chrome           ───┤  Frontend foundation
Phase 12 Onboarding stages           ───┘

Phase 13 Today landed + polish       ────── Launch gate
Phase 14 QA + E2E                    ──────
Phase 15 Cleanup                     ──────
```

Total estimated work: **3–4 solo weeks** at focused pace.

---

## Phase 1 — Schema foundations

**Goal**: single atomic migration creates all new tables, drops all
obsolete ones. `pnpm drizzle-kit migrate` runs clean on a fresh DB.

**Deliverables**:
- `drizzle/NNNN_planner_refresh.sql` — one migration file
- `src/lib/db/schema/products.ts` — +state, +launchDate, +launchedAt,
  +targetAudience, +category, +onboardingCompletedAt, drop lifecyclePhase,
  add `CREATE UNIQUE INDEX products_user_uq`
- `src/lib/db/schema/strategic-paths.ts` — NEW
- `src/lib/db/schema/plans.ts` — NEW
- `src/lib/db/schema/plan-items.ts` — NEW + 3 enums
- `src/lib/db/schema/index.ts` — add new exports, delete
  `xContentCalendar`, `weeklyThemes`, `todoItems`, drop `x-growth.ts`
  content calendar exports (keep metrics)
- `src/lib/launch-phase.ts` — `derivePhase()` helper + types

**Steps**:
1. Write migration SQL with correct backfill (see backend spec §2.5)
2. Update schema modules; keep x-growth metrics tables, drop calendar
3. `derivePhase()` implementation + unit test (`launch-phase.test.ts`,
   covers boundary days T-0/T-7/T-28/T+30 × 3 states)
4. Run migration on dev DB, verify zero errors
5. Commit migration + schema diff

**Exit gate**:
- `pnpm drizzle-kit migrate` clean
- `pnpm test src/lib/launch-phase` green
- `pnpm build` fails (expected — 29 callers still reference `lifecyclePhase`)

**Commit**: `feat(db): planner refresh migration — state, strategic_paths, plans, plan_items`

---

## Phase 2 — `lifecyclePhase` → `state` caller refactor

**Goal**: every file that read `products.lifecyclePhase` reads
`products.state` + `derivePhase()` instead. `pnpm build` green.

**Deliverables**: diffs in 29 files. From earlier scan:

### Groups

**A. Agents (delete):**
- `src/agents/calendar-planner.md` — DELETE
- `src/agents/scout.md` — DELETE
- `src/agents/analyst.md` — DELETE
- `src/agents/content.md` — DELETE (old compound prompt, new atomic skills replace)

**B. Agents (update to read `currentPhase`):**
- `src/agents/slot-body-agent.md`
- `src/agents/reply-drafter.md`

**C. Skills (delete):**
- `src/skills/calendar-planner/` — DELETE whole dir
- `src/skills/content-gen/` — DELETE whole dir
- `src/skills/full-scan/` — DELETE whole dir
- `src/skills/community-intel/` — DELETE (will re-introduce split atomics later)

**D. Skills (update references):**
- `src/skills/slot-body/` — `lifecyclePhase` → `currentPhase` in prompt + references
- `src/skills/reply-scan/` (rename to `draft-single-reply` in Phase 4, not here yet — minimal diff now)

**E. API routes:**
- `src/app/api/product/route.ts` — read `state` + compute phase
- `src/app/api/product/phase/route.ts` — DELETE (merged into commit in Phase 8)

**F. Pages:**
- `src/app/(app)/product/page.tsx` + `product-content.tsx` — display
  `state` + derived phase

**G. Workers:**
- `src/workers/processors/calendar-plan.ts` — DELETE (superseded by tactical-planner in Phase 6)
- `src/workers/processors/calendar-slot-draft.ts` — DELETE (replaced by plan-execute in Phase 7)
- `src/workers/processors/content.ts` — DELETE
- `src/workers/processors/__tests__/*` — DELETE related

**H. References:**
- `src/references/lifecycle-phases.md` — DELETE
- `src/references/launch-phases.md` — NEW (6-phase taxonomy)

**I. Scripts:**
- `scripts/test-calendar-plan.ts` — DELETE
- `scripts/test-voice-inject.ts` — update

**J. Docs:**
- `docs/superpowers/plans/2026-04-17-voice-profile-hybrid-injection.md` — annotate as superseded
- `docs/superpowers/plans/2026-04-17-thesis-angles-planner.md` — annotate as superseded

**Steps**:
1. Delete group A (agents). Build will now fail harder, expected.
2. Delete group C (skills) + group G (workers referencing them).
3. Update group B (surviving agents) to read `currentPhase`.
4. Update group D, E, F (API + pages).
5. Write new `references/launch-phases.md`.
6. Fix `pnpm build`. Iterate.
7. Run full test suite. Fix breakages.

**Exit gate**:
- `pnpm build` green
- `pnpm test` green (with N test files deleted, survivors passing)
- Grep: `rg "lifecyclePhase|lifecycle_phase"` returns ZERO hits

**Commits** (5-7 logical):
- `refactor(agents): delete obsolete planner agents`
- `refactor(skills): delete calendar-planner, content-gen, full-scan, community-intel`
- `refactor(workers): delete calendar-plan + slot-draft processors`
- `refactor(api): products route reads state + derivePhase`
- `refactor(ui): product page surfaces state not lifecyclePhase`
- `docs(refs): replace lifecycle-phases.md with launch-phases.md`

---

## Phase 3 — Delete v1 planner tables (finalize migration)

**Goal**: migration from Phase 1 fully applies, no orphaned imports.

**Deliverables**:
- Verify `x_content_calendar` / `weekly_themes` / `todo_items` tables dropped in DB
- Grep sweep for imports of deleted exports (e.g. `xContentCalendar`) — remove any stragglers
- Remove `src/lib/queue/voice-extract.ts` → actually no wait, keep voice-extract, it's still valid

**Steps**:
1. Grep for: `xContentCalendar`, `weeklyThemes`, `todoItems`, `weekly_themes`, `todo_items`
2. Remove all imports, update any remaining references to `plan_items` or drop the code entirely
3. Re-run migration on dev DB to confirm clean state

**Exit gate**:
- `pnpm build` green
- DB inspect: tables `strategic_paths`, `plans`, `plan_items` exist;
  `x_content_calendar`, `weekly_themes`, `todo_items`, `lifecycle_phase` column gone

**Commit**: `chore(db): sweep obsolete table imports`

---

## Phase 4 — Atomic skills: surviving agents

**Goal**: Existing narrow-scope agents survive as **atomic skills** the
tactical planner will schedule. Clean up + rename for consistency.

**Deliverables**:

### Renames

| Old skill | New skill |
|---|---|
| `src/skills/reply-scan/` | `src/skills/draft-single-reply/` (generic, but v1 X-only) |
| `src/skills/slot-body/` | `src/skills/draft-single-post/` |

### Keep (audit + minor updates)

- `src/skills/discovery/` — already single-source atomic, no change
- `src/skills/draft-review/` — keep
- `src/skills/posting/` — keep
- `src/skills/product-opportunity-judge/` — keep
- `src/skills/voice-extractor/` — keep
- `src/skills/community-discovery/` — keep
- `src/skills/deep-analysis/` — keep (used by discovery pipeline)

### Per-platform splits

`draft-single-post` is the generic agent. Split SKILL.md + agent.md into:
- `src/skills/draft-single-post/x/SKILL.md` (inherits from parent agent + x-specific references)
- `src/skills/draft-single-post/reddit/SKILL.md` (same pattern)

Or simpler: one skill, parameterized by `platform: 'x' | 'reddit'` in
input, branch in the agent prompt via platform reference doc injection.

**Recommendation**: parameterize, don't split into dirs. Keeps fewer
moving parts. The skill-loader already supports this pattern with
`shared-references`.

### New file

- `src/skills/_catalog.ts` — auto-generated from SKILL.md frontmatter.
  Exports a machine-readable list of all skills with their input schemas.
  Consumed by tactical-planner + plan-execute dispatcher.

**Steps**:
1. Rename dirs + update any imports
2. Update `plan-execute-dispatch.ts` (Phase 7) references in advance
3. Generate `_catalog.ts` (build-time script or hand-maintained for v1)

**Exit gate**: `pnpm build` + `pnpm test` green.

**Commit**: `refactor(skills): rename reply-scan → draft-single-reply, slot-body → draft-single-post + skill catalog`

---

## Phase 5 — Atomic skills: new ones

**Goal**: add the ~15 atomic skills the launch framework needs.

**Deliverables** — from frontend spec §6 + backend spec §4.2:

### Content
- `src/skills/draft-single-post/` — already renamed in Phase 4
- `src/skills/draft-single-reply/` — already renamed
- `src/agents/draft-single-post.md` — generic agent (platform param-driven)
- `src/agents/draft-single-reply.md` — generic

### Email
- `src/skills/draft-email/` — welcome / retro / thank-you / drip, driven by `emailType` param
- `src/skills/send-email/` — wraps email provider (Resend recommended)
- `src/skills/ab-test-subject/` — 2 subject variants

### Launch assets
- `src/skills/draft-waitlist-page/`
- `src/skills/draft-hunter-outreach/`
- `src/skills/draft-launch-day-comment/`
- `src/skills/generate-launch-asset-brief/`
- `src/skills/build-launch-runsheet/`

### Research / analytics
- `src/skills/extract-milestone-from-commits/`
- `src/skills/fetch-community-rules/`
- `src/skills/fetch-community-hot-posts/`
- `src/skills/analytics-summarize/` — replaces old `analyst` agent
- `src/skills/identify-top-supporters/`
- `src/skills/generate-interview-questions/`

### Utility
- `src/skills/compile-retrospective/`
- `src/skills/classify-thread-sentiment/`

**Per-skill template**:

```
src/skills/{name}/
  SKILL.md           # frontmatter + agent ref + references
  references/        # per-skill docs injected into prompt
  __tests__/
    {name}.test.ts   # IO shape test against outputSchema
```

**Steps**:
1. For each skill: create SKILL.md, agent.md, at least one reference doc, one schema test
2. Update `_catalog.ts` to include all new skills
3. Provide `scripts/test-skill.ts {name}` harness for manual dogfooding

**Exit gate**:
- Every skill's IO test passes
- `_catalog.ts` covers all skills
- `scripts/test-skill.ts draft-waitlist-page` (or any skill) runs end-to-end with a real LLM call

**Commits** (grouped 3-4 at a time):
- `feat(skills): content drafting atoms (draft-single-post/reply variants)`
- `feat(skills): email atoms (draft-email, send-email, ab-test-subject)`
- `feat(skills): launch asset atoms`
- `feat(skills): research + analytics atoms`

---

## Phase 6 — Strategic + tactical planner agents

**Goal**: the two new heavy-hitter agents, with full prompts + references + tests.

**Deliverables**:

### `strategic-planner`
- `src/agents/strategic-planner.md` (prompt skeleton from backend spec §3.2, fleshed out)
- `src/skills/strategic-planner/SKILL.md` + references:
  - `references/category-playbooks.md` — per-category narrative defaults (dev_tool / saas / consumer / creator_tool / agency / ai_app / other)
  - `references/launch-phases.md` — shared
  - `references/milestone-to-thesis.md` — how to derive thesis
- Zod schema: `src/agents/schemas.ts` add `strategicPathSchema`
- Test: `src/agents/__tests__/strategic-planner.test.ts`

### `tactical-planner`
- `src/agents/tactical-planner.md` (prompt skeleton from backend spec §3.3, fleshed out)
- `src/skills/tactical-planner/SKILL.md` + references:
  - `references/angle-playbook.md` — 7 content angles (claim/story/contrarian/howto/data/case/synthesis)
  - `references/phase-task-templates.md` — task templates per phase
  - `references/skill-catalog.md` — auto-generated from `_catalog.ts`
  - `references/voice-profile.md` — injected per-user if voice extracted
- Zod schema: `src/agents/schemas.ts` add `tacticalPlanSchema`
- Test: `src/agents/__tests__/tactical-planner.test.ts`

**Steps**:
1. Write `category-playbooks.md` — 7 categories × (narrative template + pillars + channel mix). ~1200 words total.
2. Write `phase-task-templates.md` — 6 phases × ~10 task templates each.
3. Write strategic-planner prompt. Test with real LLM call via `scripts/test-strategic.ts`.
4. Write tactical-planner prompt. Test with real LLM via `scripts/test-tactical.ts`.
5. Seal both schemas in Zod.
6. Add validation tests that assert:
   - strategic: output has exactly 3-4 content pillars, milestones strictly increasing by dayOffset, thesisArc matches window
   - tactical: items respect `channels` filter, no duplicates from `completedLastWeek`, every content_post references thesisArc[weekIndex].theme

**Exit gate**:
- Both planners produce valid output for all 3 product states × 7 categories = 21 test fixtures
- Schema tests green
- `scripts/test-strategic.ts` + `scripts/test-tactical.ts` work end-to-end

**Commits**:
- `feat(skills): strategic-planner with category playbooks`
- `feat(skills): tactical-planner with angle playbook and task templates`
- `test(agents): fixture-based IO tests for both planners`

---

## Phase 7 — Queues, workers, dispatcher

**Goal**: `plan-execute` queue replaces the deleted calendar queues.
Weekly cron + stale sweeper work.

**Deliverables**:

### New
- `src/lib/queue/plan-execute.ts` — schema + enqueue helper
- `src/workers/processors/plan-execute.ts` — the dispatcher
- `src/workers/processors/plan-execute-sweeper.ts` — every-minute cron
- `src/workers/processors/weekly-replan.ts` — Monday 00:00 cron
- `src/workers/processors/stale-sweeper.ts` — every-hour cron
- `src/lib/re-plan.ts` — supersede logic (scope-based updates)
- `src/lib/plan-execute-dispatch.ts` — kind → skill routing

### Delete (already done in Phase 2 but verify)
- `src/workers/processors/calendar-plan.ts`
- `src/workers/processors/calendar-slot-draft.ts`
- `src/workers/processors/content.ts`
- `src/workers/processors/todo-seed.ts` — plan_items replaces todos
- `src/lib/queue/index.ts` enqueue helpers for the above

### Update
- `src/workers/index.ts` — register new queues, unregister deleted
- `src/lib/queue/types.ts` — add `planExecuteJobSchema`, remove deleted schemas
- Cron registration (bull cron add)

### State machine helpers
- `src/lib/plan-state.ts` — valid transitions, plus `transition(item, to)` function that enforces them

**Steps**:
1. Write state-machine helper + test all valid/invalid transitions
2. Write dispatcher — given a plan_item, route to correct draft/execute skill
3. Write plan-execute processor
4. Write 3 cron processors (weekly-replan, plan-execute-sweeper, stale-sweeper)
5. Write `re-plan.ts` supersede function with tests
6. Wire everything in `workers/index.ts`
7. Integration test: enqueue a plan_item in state `planned` with `userAction=approve`, drive it through `drafted` → `ready_for_review` manually → `approved` → `executing` → `completed`

**Exit gate**:
- Workers start without error
- Integration test completes full state machine
- Weekly-replan cron is registered

**Commits**:
- `feat(queue): plan-execute dispatcher + state machine`
- `feat(workers): weekly-replan, stale-sweeper, plan-execute-sweeper crons`
- `feat(lib): re-plan supersede + plan-state transitions`

---

## Phase 8 — API endpoints

**Goal**: server endpoints matching the client-facing contract.

**Deliverables**:

### New
- `POST /api/onboarding/plan` — runs strategic + tactical back-to-back, returns `{ path, plan }`
- `POST /api/onboarding/commit` — writes products + strategic_paths + plans + plan_items in one tx, fires activation
- `GET /api/onboarding/draft` — reads Redis draft
- `PUT /api/onboarding/draft` — upserts Redis draft
- `DELETE /api/onboarding/draft` — clears on commit success
- `POST /api/plan/replan` — user-triggered tactical re-plan
- `POST /api/product/phase` — user updates phase via Settings, triggers strategic chain
- `POST /api/plan-item/:id/approve` — approve a `ready_for_review` item, enqueue execute phase
- `POST /api/plan-item/:id/skip` — mark skipped
- `POST /api/plan-item/:id/complete` — manual task completion

### Update
- `src/app/actions/activation.ts` — relocate caller; `activatePostOnboarding` called from `/commit` not onboarding page

### Delete
- `src/app/api/onboarding/profile/route.ts`
- `src/app/api/product/phase/route.ts` (old PUT)
- `src/app/api/calendar/*` — anything referencing old content calendar

### Existing (keep, minor update)
- `src/app/api/onboarding/extract/route.ts` — no DB write, returns `ExtractedProfile` only
- `src/app/api/onboarding/extract-repo/route.ts` — same, SSE stream stays
- `src/app/api/onboarding/github-repos/route.ts` — unchanged

**Steps**:
1. Write each endpoint with Zod payload validation + auth + rate-limit
2. Redis draft helpers (`src/lib/onboarding-draft.ts`) with `GET/PUT/DELETE` wrappers
3. Integration tests per endpoint
4. Delete obsolete endpoints

**Exit gate**:
- `POST /api/onboarding/plan` returns valid path+plan in <15s on real data
- `POST /api/onboarding/commit` transaction completes; `plan_items` rows written
- Rate limiter smoke-tests (1/10s on `plan`, 1/min on `commit`)
- Old route files deleted, no imports reference them

**Commits**:
- `feat(api): onboarding plan + commit endpoints`
- `feat(api): onboarding draft Redis state GET/PUT/DELETE`
- `feat(api): plan-item lifecycle endpoints (approve/skip/complete)`
- `feat(api): product/phase endpoint triggers strategic chain`
- `chore(api): delete obsolete onboarding/profile + product/phase PUT routes`

---

## Phase 9 — `scripts/seed-user.ts`

**Goal**: dogfood tool to create a complete user + product + active path + week of plan_items entirely via SQL.

**Deliverables**:
- `scripts/seed-user.ts` — takes `--email`, `--state` (default launching), `--channels` (default x,reddit)
- Creates: user, product, channels, strategic_path, plans, plan_items (7 days worth)
- Prints the user's session URL for sign-in

**Why now**: Phases 10-12 frontend work is going to be multi-day. During
that window `/onboarding` is broken (endpoint delete landed in Phase 8).
This script unblocks dogfooding of `/today` etc.

**Exit gate**: `pnpm seed-user --email test@shipflare.dev` works, can
sign in, see populated Today.

**Commit**: `feat(scripts): seed-user for post-onboarding dogfooding`

---

## Phase 10 — Brand tokens refresh (v3)

**Goal**: globals.css updated to the handoff's Apple-Blue / pure-neutrals palette.

**Deliverables**:
- `src/app/globals.css` — token replacement per frontend spec §2
  - `--sf-signal*` → `--sf-accent*`
  - `--sf-flare*` → delete
  - Switch font stack to SF Pro with Geist fallback
  - Shadow values updated
  - Radius tokens updated (add `--sf-radius-xl`, `--sf-radius-pill` = 980)
  - Drop `--sf-cat-1..6` (categorical palette was for viz; not used in onboarding)
- Global find-replace consumers:
  - `rg "sf-signal"` → all to `sf-accent`
  - `rg "sf-flare"` → either delete or map to something defensible
  - `rg "sf-ink|sf-paper"` → update to `sf-bg-dark|sf-bg-primary`
- Update `@theme inline` aliases in globals.css
- Update existing UI components (`src/components/ui/*`) that inline old token names
  - `button.tsx`, `input.tsx`, `badge.tsx`, `card.tsx`, etc.
  - Verify every component renders OK with new tokens on existing pages

**Steps**:
1. Back up current globals.css as git baseline
2. Replace tokens per spec
3. Run full app: every page that renders any UI primitive
4. Fix visual regressions case by case
5. Write a visual-regression note: "post-v3 brand refresh — existing pages retinted; review before shipping"

**Exit gate**:
- `pnpm dev` — every existing page (/today, /settings, /product, /threads, /voice, etc.) renders without broken colors
- No `rg "sf-signal|sf-flare|sf-paper-raised"` hits in `src/`

**Commits**:
- `feat(tokens): v3 brand refresh — Apple Blue + pure neutrals`
- `refactor(ui): retint Button/Input/Badge/Card to v3 tokens`

---

## Phase 11 — Onboarding chrome

**Goal**: the shell (ProgressRail + TopChevron + WorkArea + StepHeader +
MobileHeader + ActionBar) in place, stages stubbed with placeholders.

**Deliverables**:
- `src/components/onboarding/OnboardingFlow.tsx` — orchestrator with
  state machine (stage routing + draft-state mirroring)
- `src/components/onboarding/progress-rail.tsx`
- `src/components/onboarding/mobile-header.tsx`
- `src/components/onboarding/top-chevron.tsx`
- `src/components/onboarding/work-area.tsx`
- `src/components/onboarding/step-header.tsx`
- `src/components/onboarding/action-bar.tsx`
- `src/components/onboarding/_shared/onb-mono.tsx`
- `src/components/onboarding/_shared/onb-button.tsx` (capsule 980 lg, etc)
- `src/components/onboarding/_shared/onb-input.tsx` (48px tall, radius 11)
- `src/components/onboarding/_shared/onb-textarea.tsx`
- `src/components/onboarding/_shared/field-reveal.tsx`
- `src/components/onboarding/_shared/scan-dot.tsx`
- `src/components/onboarding/_shared/agent-dot.tsx`
- `src/components/onboarding/icons.tsx` — 10 hand-rolled SVG icons
- `src/components/onboarding/_copy.ts` — string constants
- Replace `src/app/onboarding/page.tsx` → renders `<OnboardingFlow />`
- Replace `src/app/onboarding/layout.tsx` → full-bleed layout (no nav)

**Steps**:
1. Build `OnboardingFlow` with `stage: 'source'` placeholder screens
2. Stack in chrome components; make sure desktop + mobile breakpoint renders
3. Wire placeholder "next" buttons so each stage is reachable for visual review
4. Visual QA against `Onboarding.html`

**Exit gate**:
- Every stage renders with placeholder content
- Desktop 1440px + mobile 390px screenshots match handoff chrome pixel-wise

**Commits**:
- `feat(onboarding): v3 chrome — OnboardingFlow + ProgressRail + shared primitives`
- `feat(onboarding): copy module + hand-rolled icons`

---

## Phase 12 — Onboarding stages (7)

**Goal**: each stage implemented with real data binding and animations.

Order: 1 → 3 → 4 → 5 → 7 → 2 → 6.
Rationale: do the "static" stages first (real forms, real data), then
the animation stages (scanning + plan-building) which are decorative
and can be refined with real-time feedback.

### 12.1 — Stage 1 Source

- `stage-source.tsx` with 3 sub-states (choose / github / url)
- `method-card.tsx`, `github-connect-card.tsx`, `repo-list.tsx`, `repo-row.tsx`, `extracting-card.tsx`, `inline-scan-status.tsx`
- Wires to `GET /api/onboarding/github-repos`, `POST /api/onboarding/extract[-repo]`
- Mirror result to Redis draft via `PUT /api/onboarding/draft`

**Commit**: `feat(onboarding): stage 1 — source picker + URL + GitHub repo selector`

### 12.2 — Stage 3 Profile review

- `stage-review.tsx` with 6 staggered fields
- `voice-picker.tsx`, `keyword-editor.tsx`, `onb-textarea.tsx`
- Reads draft on mount, autosaves edits to draft via PUT draft (debounced 400ms)

**Commit**: `feat(onboarding): stage 3 — profile review with voice picker + keyword editor`

### 12.3 — Stage 4 Connect

- `stage-connect.tsx`
- `account-card.tsx`, `state-pill.tsx`
- OAuth flow: existing `/api/{x,reddit}/connect|callback` wired; card state mirrors `channels` table via `GET /api/channels` (existing)

**Commit**: `feat(onboarding): stage 4 — connect accounts with live OAuth state`

### 12.4 — Stage 5 State picker

- `stage-state.tsx`
- `state-card.tsx` with conditional sub-forms
- Mirror to draft on selection

**Commit**: `feat(onboarding): stage 5 — state picker + conditional sub-forms`

### 12.5 — Stage 7 Plan review

- `stage-plan.tsx` with 3 tabs
- `AboutPanel` (inline edit on pencil), `TimelinePanel` (phase rows), `FirstWeekPanel` (numbered tasks)
- Reads `{ path, plan }` from `OnboardingFlow` state (populated in 12.7 from `POST /plan` response)
- Confirm → `POST /api/onboarding/commit` → navigate `/today?from=onboarding`

**Commit**: `feat(onboarding): stage 7 — 3-tab plan review`

### 12.6 — Stage 2 Scanning

- `stage-scanning.tsx` with `six-step-animator.tsx`
- Decorative animation + real extract call in parallel
- Advance when real call resolves OR all 6 animation steps complete (whichever later — ensures minimum ~5s dramatic beat)
- Updates source-specific step 1-3 labels per URL vs GitHub

**Commit**: `feat(onboarding): stage 2 — scanning animation with parallel real extract`

### 12.7 — Stage 6 Plan building

- `stage-plan-building.tsx` — reuses `six-step-animator`
- Real call to `POST /api/onboarding/plan` in parallel
- On success → advance to Stage 7 with path+plan data; on timeout 45s → error state with "Continue with manual plan" fallback

**Commit**: `feat(onboarding): stage 6 — plan-building animation with live planner call`

---

## Phase 13 — Today Landed state

**Goal**: the post-finish hero + welcome ribbon + populated modules.

**Deliverables**:
- `src/components/today/today-landed-hero.tsx` — full-bleed black hero
- `src/components/today/today-welcome-ribbon.tsx` — persistent ribbon
- `src/components/today/agent-pipeline-card.tsx` — 6-agent status list (reused from onboarding `_shared`)
- Update `src/app/(app)/today/page.tsx` / `today-content.tsx`:
  - Detect `?from=onboarding` → mount landed hero
  - First interaction OR 10s passes → collapse to normal layout with ribbon
  - Ribbon dismissible, persists for 24h via localStorage flag

**Steps**:
1. Build hero view, verify against `Today Landed.html` pixel-wise
2. Build ribbon, build dismiss logic (localStorage `sf:onboarded-ribbon-dismissed`)
3. Polling for job status (existing `use-today.ts`)
4. Verify on mobile

**Exit gate**:
- Fresh onboard end-to-end lands on Today hero
- Dismiss works; reload keeps dismissed state

**Commits**:
- `feat(today): onboarding landed hero + welcome ribbon`
- `feat(today): agent pipeline card reused from onboarding`

---

## Phase 14 — QA + E2E

**Goal**: full flow verified on desktop + mobile. E2E test locks the happy path.

**Deliverables**:
- `e2e/tests/onboarding.spec.ts` — already exists, rewrite:
  - Happy path: source(url) → scanning → review → connect(skip) → state(launching) → plan-building → plan(commit) → today(landed)
  - Happy path variant: source(github) → scanning → review → connect(both) → state(launched) → ... → today
  - Edge: extract fail → "Continue with just URL"
  - Edge: planner timeout → "Continue with manual plan"
  - Edge: back from state → review preserved
  - Edge: refresh mid-flow → resume from draft
- Mobile 375px viewport E2E
- Visual regression per stage (Playwright screenshots, diff against handoff PNGs if we have them)

**Exit gate**:
- All E2E green locally
- Lighthouse score on `/onboarding` ≥90 perf, ≥95 a11y
- Manual run-through by you (dogfood) — no surprises

**Commits**:
- `test(e2e): full onboarding happy path + fallbacks`
- `test(e2e): mobile viewport coverage`

---

## Phase 15 — Cleanup

**Goal**: sweep leftovers. Repo grep-clean.

**Deliverables**:
- Delete `public/ShipFlare Design System.zip` (referenced in git status as untracked — commit after extracting what's needed)
- Remove placeholder `scripts/test-*` that reference deleted agents
- Update `README.md` with v3 architecture overview
- Update `CLAUDE.md` skill routing to reference new skills
- Close superseded docs (`2026-04-17-*`) with SUPERSEDED markers at top
- Run `pnpm knip` + `pnpm ts-prune` — clean dead code

**Commits**:
- `chore: remove design-system zip and orphaned scripts`
- `docs: v3 README + CLAUDE.md skill routing update`
- `chore: dead code sweep`

---

## Dependency graph

```
      ┌──────────┐
      │ Phase 1  │  schema
      └────┬─────┘
           │
      ┌────▼─────┐
      │ Phase 2  │  caller refactor (29 files)
      └────┬─────┘
           │
      ┌────▼─────┐
      │ Phase 3  │  verify clean
      └────┬─────┘
           ├──────────────────────┐
           ▼                      ▼
      ┌──────────┐           ┌──────────┐
      │ Phase 4  │           │ Phase 10 │  brand tokens
      │ skills   │           └────┬─────┘
      │ survive  │                │
      └────┬─────┘                ▼
           │                 ┌──────────┐
      ┌────▼─────┐           │ Phase 11 │  chrome
      │ Phase 5  │           └────┬─────┘
      │ new atoms│                │
      └────┬─────┘                │
           │                      │
      ┌────▼─────┐                │
      │ Phase 6  │                │
      │ planners │                │
      └────┬─────┘                │
           │                      │
      ┌────▼─────┐                │
      │ Phase 7  │  queues+workers│
      └────┬─────┘                │
           │                      │
      ┌────▼─────┐                │
      │ Phase 8  │  API           │
      └────┬─────┘                │
           │                      │
      ┌────▼─────┐                │
      │ Phase 9  │  seed-user     │
      └────┬─────┘                │
           └──────────────────────┤
                                  ▼
                             ┌──────────┐
                             │ Phase 12 │  stages
                             └────┬─────┘
                                  │
                             ┌────▼─────┐
                             │ Phase 13 │  today landed
                             └────┬─────┘
                                  │
                             ┌────▼─────┐
                             │ Phase 14 │  QA
                             └────┬─────┘
                                  │
                             ┌────▼─────┐
                             │ Phase 15 │  cleanup
                             └──────────┘
```

**Parallelization opportunities**:
- Phase 10 (brand refresh) can run in parallel with Phase 4-9 if you
  context-switch — they touch disjoint files. Not recommended unless
  you want separate PRs for review.
- Phases 4, 5, 6 can parallelize (different skills). But sequence them
  so imports resolve cleanly.
- Phase 12's 7 sub-stages are largely independent after the chrome is
  in place — can pick them off in any order.

---

## PR strategy

Each phase is 1-4 PRs (grouped commits listed per phase). Target size:
~500-1000 lines per PR. Phase 2 is the exception — may hit 2000+ lines
but should stay one PR to keep the atomic refactor visible.

Branch naming: `v3/phase-{N}-{short-desc}` (e.g. `v3/phase-1-schema`).

Each PR:
- Links back to this plan + the relevant spec sections
- `## Summary` (1-3 bullets)
- `## Scope` (which spec sections)
- `## Test plan` (manual + automated)
- `## Not in this PR` (scope-scoping)

Post-merge: tag each phase completion as `v3-p{N}` (e.g. `v3-p1-schema`)
so we can bisect/rollback to phase boundaries if something goes sideways.

---

## Risks + mitigations

| Risk | Mitigation |
|---|---|
| Phase 2 refactor is huge (29 files) | Keep it one atomic PR; use `git bisect` if regressions surface |
| Brand refresh (Phase 10) causes visual regressions on existing pages | Phase 10 has an explicit "review every page" step before merge |
| Tactical planner schema drifts between backend + tactical-planner reference injection | Single source of truth: `src/agents/schemas.ts`. Both sides import from there. |
| Planner token cost spikes | Strategic = Sonnet (expensive but rare); tactical = Haiku (cheap, frequent). Weekly cron runs 1×/user/week. Budget is fine at <100 users. |
| Redis draft lost mid-flow | TTL 1h covers most gaps; acceptable UX to restart on expiry |
| 7-stage frontend feels too long | E2E assertion: onboarding <2min total. If not, scope back. |
| OAuth round-trip loses state | Redis draft handles. Verified in E2E. |

---

## Definition of Done

- All 4 spec docs + this plan cross-reference cleanly
- `pnpm build` + `pnpm test` + `pnpm lint` green on main
- E2E happy path + 3 edge cases green
- `/onboarding` fresh account → Today landed in <2min on manual run
- Lighthouse ≥90 perf, ≥95 a11y on `/onboarding`
- No `rg "lifecyclePhase|xContentCalendar|weeklyThemes|sf-signal|sf-flare"` hits in `src/`
- README + CLAUDE.md reflect v3 architecture
- Zero TODO comments referencing phased work in merged code
