# Onboarding Redesign — Launch Lifecycle Aware

**Date:** 2026-04-19
**Status:** Design approved, ready for UI mockups + implementation plan
**Related:** `docs/indie-launch-planner-framework.md` (source of phase taxonomy)

## Why

Current onboarding is built around a "daily reply + content" mental model:
`ProductSource → ProfileReview → ConnectAccounts`, then silently enqueue
`calendar-plan` and drop the user into `/today`.

The product is evolving into a full launch-lifecycle planner (Foundation →
Audience → Momentum → Launch → Compound). The onboarding has to serve two
kinds of users:

- **Pre-launch** — wants a 6-week playbook, needs a date-aware plan
- **Post-launch** — wants compound / steady-state content ops

The new flow routes both through a shared 4-step shell, with a **state picker**
deciding which phase the planner agent generates for, and a **3-section
planner preview** that replaces the old free-floating ProfileReview.

## Non-Goals

- Rewriting `/today` card layout (already redesigned recently)
- Adding LinkedIn / IH / Xiaohongshu channels (future, one entry in `platform-config`)
- Multi-product support (single product per user remains)
- Editing the phase timeline after onboarding (v1 is read-only past Step 4)

---

## Global Rules

- **4 steps**, top-right `ProgressDots steps={4} current={step}`
- **Route:** `/onboarding` (all steps in the same SPA shell, no URL change)
- **H1:** left-aligned 21px semibold, changes per step
- **Primary CTA:** black on white, disable driven by form validity
- **Back:** ghost button bottom-left on every step except Step 1
- **Voice:** founder-to-founder, confident. Avoid "Let's get started / awesome / amazing"

---

## Step 1 — Add your product

Unchanged from today's `ProductSourceStep`. Documented here for
completeness.

**H1:** Add your product
**Sub:** We'll scan your product to extract name, description, and keywords automatically.

### Layout

Three sub-states (`method: 'choose' | 'github' | 'url'`):

#### Choose (default)

Two 2×1 cards (`grid-cols-2`):

- **Card A — Import from GitHub** (GitHub icon)
  Sub: "Scan your code to understand your product"
- **Card B — From website URL** (globe icon)
  Sub: "We'll scan your homepage for details"

Below: `or enter manually →` tertiary text button.

#### GitHub

List the 10 most recently active repos from the user's GitHub OAuth.
Each row: repo name / description / last updated / private badge.

- Selection → `POST /api/onboarding/extract-repo` → returns `ExtractedProfile`
- Loading: skeleton + "Loading your repos..."
- Error: replace list with error card + "Use URL instead" fallback

#### URL

Single input: `https://your-product.com`
Helper: "We'll scan your page and extract product details automatically."
CTA: `Scan website` (loading state `Scanning...`).
Error: red text under input.

### Completion

Receive `ExtractedProfile` (name / description / keywords / valueProp / url /
ogImage / seoAudit) → `setStep(1)`.

### Edge cases

- **Skip path:** `or enter manually →` passes an empty profile and jumps to
  Step 4 section A, which becomes a from-scratch form.
- **Extract failure:** preserve the user's URL in state, show error, offer
  "Continue with just this URL" (empty profile + url prefilled).

---

## Step 2 — Connect your accounts (moved forward)

Moved from step 3 → step 2. The planner agent in Step 4 needs to know which
channels are connected so it doesn't generate `"post a thread on X"` tasks
for a user who hasn't connected X.

**H1:** Connect your accounts
**Sub:** Connect so ShipFlare can draft replies and schedule posts on your behalf. You can skip and connect later.

### Layout

Stacked cards, one per platform. Each card (left-right flex):

- Left: platform logo (32×32, md radius) + name + one-line description
- Right: `Connect` ghost button; if connected, show `Connected` success badge

Currently enabled: **X** always visible; **Reddit** gated by
`isPlatformAvailable('reddit')`. Future platforms (LinkedIn, Indie Hackers,
Xiaohongshu) append via the same template.

### Bottom bar

- `Back` ghost
- `Continue` primary (enabled when ≥ 1 platform connected)
- `Skip for now` tertiary text button (allows 0 connections)

### Footer microcopy

> You can always connect later from Settings. Discovery and content generation work without a connected account, but posting requires it.

### Data flow

OAuth callbacks (`/api/x/callback`, `/api/reddit/callback`) write to the
`channels` table, then redirect back to `/onboarding?step=2`. The page reads
`channels` on mount to reflect connected state.

### Skip degradation

Record `onboardingSkippedChannels: true` on the product. Step 4 section C
filters out every task where `channel != null`, leaving only channel-agnostic
tasks (interviews / positioning / waitlist / landing page).

---

## Step 3 — Where's your product? (NEW)

**H1:** Where's your product at?
**Sub:** This helps us generate the right plan — a 6-week pre-launch playbook is very different from a post-launch growth loop.

### Layout

Three large cards (`grid-cols-1 md:grid-cols-3`). Selection highlights the
card with an accent border and expands an inline follow-up input.

#### Card 1 — 🛠 Still building MVP

- Title: Still building
- Sub: No launch date yet — focus on audience + positioning
- Follow-up (optional):
  - Label: `Have a rough target? (optional)`
  - Input: month picker OR "Not sure yet" checkbox
- Planner path: Phase 1 Foundation, not date-bound

#### Card 2 — 🚀 Launching soon

- Title: Launching soon
- Sub: Pick a date and we'll work backwards
- Follow-up (required):
  - Label: `Launch date`
  - Input: date picker, `min = today + 7d`, `max = today + 90d`
  - Helper (grey): "Pro tip: Tuesday or Wednesday drive the most PH traffic."
- Planner path: date-driven T-offset → Foundation / Audience / Momentum / Launch

#### Card 3 — 🎉 Already launched

- Title: Already launched
- Sub: We'll help you compound and plan what's next
- Follow-up (required):
  - Label: `When did you launch?`
  - Input: segmented control: `< 1 week` / `1–4 weeks` / `1–3 months` / `3+ months`
- Planner path: Phase 5 Compound (< 4 weeks) or Steady-state (≥ 4 weeks)

### Bottom bar

- `Back` ghost
- `Generate my plan` primary — disabled until a card is selected AND its
  required follow-up is filled

### Data flow

Click `Generate my plan`:

1. `PATCH /api/product/phase` writes `products.state`, `products.launchDate`,
   `products.launchedAt`
2. Fire `POST /api/onboarding/plan` (planner agent) — async, show Step 4
   loading state
3. `setStep(3)` and render loading

---

## Step 4 — Your launch plan (RESTRUCTURED)

Subsumes the old `ProfileReviewStep`. Step 4 is the payoff moment —
the user needs to feel "AI really understood my product" here or the previous
three steps were wasted.

**H1:** Your launch plan
**Sub:** Based on your product and timeline. Edit anything before we lock it in.

### Loading state (planner running)

- 3 sections shown as skeletons
- Center loader + copy: "Reading your repo / site and drafting your plan..." (expected 5–15s)
- > 20s: "Taking longer than expected — hang tight"
- > 45s: error state + `Continue with manual plan` button (skips planner,
  section A prefills from extract, B and C use generic phase templates)

### Success state: three sections

Each section has an independent header + `Edit` icon button that toggles
between read-only card view and editable form. Bottom of page has one master
confirm button `Looks good — build my calendar`.

---

#### Section A — About your product

**Visual:** white surface card. Default read-only; `Edit` expands to form.

**Read-only view:**

- Name (large)
- Tagline (grey small)
- 4 key-value rows: `Target audience / Category / Value prop / Keywords`
- ogImage thumbnail if present

**Edit mode** (inherits today's `ProfileReviewStep` fields + 2 new):

| Field | Type | Required | Source |
|---|---|---|---|
| Name | text | ✓ | extract |
| Tagline / Description | textarea (3 rows) | ✓ | extract |
| Value proposition | text | ✓ | extract |
| Keywords | text (comma-separated) | — | extract |
| **Target audience** | text | — | planner inferred |
| **Category** | select (Dev tool / SaaS / Consumer / Creator tool / Agency / AI app / Other) | — | planner inferred |

`Save` collapses back to read-only and `PUT /api/onboarding/profile`.

---

#### Section B — Your timeline

**Visual:** horizontal 5-segment timeline. Current phase highlighted
(accent border + filled dot). Past phases show a checkmark.

Phases (left → right):

1. **Foundation** `T-42 → T-28` · 2 weeks · lay the groundwork
2. **Audience** `T-28 → T-7` · 3 weeks · build in public
3. **Momentum** `T-7 → T-1` · 1 week · countdown
4. **Launch** `T-0` · launch day
5. **Compound** `T+1 → T+30` · compound the launch

Each card shows: phase name / duration / one-line objective.

### Derivation rules

| State | Launch date | Timeline |
|---|---|---|
| `mvp` | `null` | All 5 phases ghosted, banner: "Set a launch date any time to activate the timeline." Current = Foundation |
| `mvp` | set | Derived from `(date - today) / 7` bucketing |
| `launching` | set | Same derivation |
| `launched` | < 1 week | Phases 1–4 ghosted with checkmark, Phase 5 highlighted |
| `launched` | ≥ 4 weeks | Collapse entire timeline to a single "Steady-state growth" bar: "Launched X weeks ago — we'll focus on compound content and warm leads." |

### Interactions

Read-only + `Edit launch date` text link. The link opens a small popover to
change the date; on save, the timeline re-derives.

---

#### Section C — First week

**Visual:** checklist. Each row: checkbox + title + one-line description +
optional platform badge.

### Task schema

```ts
{
  id: string
  title: string              // e.g. "Run 5 customer interviews"
  description: string        // 1–2 line actionable guidance
  phase: 'foundation' | 'audience' | 'momentum' | 'launch' | 'compound'
  channel?: 'x' | 'reddit' | 'linkedin' | null  // null = channel-agnostic
  suggestedDate: string       // ISO, within the first 7 days
  kind: 'content' | 'setup' | 'interview' | 'email' | 'analytics'
}
```

The planner agent pulls 7–10 tasks from the phase's template library.

### Interactions

- Default: all checked
- User can uncheck to exclude from calendar generation
- Each row has a `...` menu: `Skip this week` / `Remove` / `Replace with...`
  (dropdown of same-phase alternatives)
- Bottom text link: `+ Add a custom task`

### Skip-channels degradation

Filter out all `channel != null` tasks. Show only
`kind ∈ ['setup', 'interview', 'email', 'analytics']`.

---

### Bottom bar

- `Back` ghost → Step 3
- `Looks good — build my calendar` primary (enabled when section A is valid)

On click:

1. Commit section A edits if any are unsaved
2. Commit section C checkbox state to `onboarding_tasks`
3. Fire `activatePostOnboarding()` — enqueues `calendar-plan` per connected
   platform and `calibrate-discovery`
4. `router.push('/today?from=onboarding')`

---

## Landing — `/today` just-onboarded state

**Trigger:** `?from=onboarding` query param on first `/today` hit. Clears on
dismiss.

### Top welcome banner (non-modal)

> Your plan is live. We're calibrating your discovery signals and drafting your first posts — both will pop in below as they finish.

With `×` dismiss. Never shown again after dismiss.

### Two modules (vertical stack OR left-right split — design decides)

#### Module 1 — Discovery

Three states:

1. **Calibrating** (default)
   3 skeleton cards. Label: `Calibrating discovery · ~2 min`. Progress bar
   (pseudo or real — `calibrate-discovery` job exposes a progress field).
2. **Results** (calibrate complete)
   Replace with real reply cards (existing `/today` design).
3. **Empty** (calibrate returned 0)
   Empty state: "No matching conversations yet. We'll keep watching and ping
   you when we find a good fit."

#### Module 2 — Your posts

Three states:

1. **Drafting**
   3 skeleton cards. Label: `Drafting your first posts · ~1 min`.
2. **Drafts ready**
   Each draft card: date / channel badge / title / content preview / status
   `Draft` / CTA `Review`.
3. **Empty** (skipped channels OR `calendar-plan` produced no drafts)
   Empty state: "No drafts yet. Want to write one? → New post"

Both modules poll every 3s (SWR or custom) for job status. Auto-swap to
results when complete.

---

## Data model changes

```ts
// src/lib/db/schema/products.ts
products: {
  // ... existing fields ...
  state: 'mvp' | 'launching' | 'launched'     // NEW
  launchDate: timestamp | null                // NEW
  launchedAt: timestamp | null                // NEW (for state='launched')
  targetAudience: text | null                 // NEW
  category: text | null                       // NEW
  onboardingCompletedAt: timestamp | null     // NEW
  onboardingSkippedChannels: boolean          // NEW (default false)
}

// NEW table
onboarding_tasks: {
  id: uuid
  userId: uuid
  productId: uuid
  phase: enum
  title: text
  description: text
  channel: text | null
  suggestedDate: timestamp
  kind: text
  enabled: boolean        // false if user unchecked in section C
  createdAt: timestamp
}
```

## API changes

- `PATCH /api/product/phase` — EXISTS, extend payload to accept `state`,
  `launchDate`, `launchedAt`
- `POST /api/onboarding/plan` — **NEW**
  Body: `{ productId }`
  Calls the planner agent
  Returns `{ productUnderstanding, phaseMap, firstWeekTasks }`
- `POST /api/onboarding/tasks/commit` — **NEW**
  Body: `{ productId, tasks: [{ id, enabled }] }`
  Writes to `onboarding_tasks`

## Planner agent I/O

```ts
// Input
{
  product: ExtractedProfile
  channels: Array<'x' | 'reddit' | 'linkedin'>
  state: 'mvp' | 'launching' | 'launched'
  launchDate: string | null        // ISO
  launchedAt: string | null        // ISO
}

// Output
{
  productUnderstanding: {
    name: string
    tagline: string
    valueProp: string
    keywords: string[]
    targetAudience: string
    category: string
  }
  phaseMap: {
    current: 'foundation' | 'audience' | 'momentum' | 'launch' | 'compound' | 'steady'
    timelineVisible: boolean        // false when state='mvp' && launchDate=null
  }
  firstWeekTasks: Task[]            // 7–10 items
}
```

---

## Edge cases checklist

- [ ] User refreshes page — restore from `onboardingCompletedAt` + current step
- [ ] Planner timeout (45s) — fallback to generic template
- [ ] 0 channels connected — section C auto-filters channel-bound tasks
- [ ] Extract failed — section A starts from scratch
- [ ] `launchDate` in the past — prompt: "That's in the past — switch to Already launched?"
- [ ] User who has already completed onboarding visits `/onboarding` — redirect to `/today`
- [ ] `activatePostOnboarding` called twice — existing Redis lock handles it
- [ ] GitHub OAuth user with 0 repos — GitHub card shows empty state + "Use URL instead"
- [ ] Planner returns `productUnderstanding` with empty fields — section A still works, required fields block the master CTA

---

## Open questions for design

1. **Timeline direction:** horizontal (preferred) or vertical on narrow viewports?
2. **Section layout:** tabs vs accordion vs always-expanded stack for A / B / C?
3. **`/today` modules:** vertical stack or left-right split?
4. **Welcome banner persistence:** dismiss once forever, or re-show on next day's first visit?

---

## Implementation order (rough)

1. DB migration: add `products` columns + `onboarding_tasks` table
2. Extend `PATCH /api/product/phase` schema
3. Build `POST /api/onboarding/plan` + planner agent wiring
4. Step 3 UI (new)
5. Step 4 UI (new, subsumes ProfileReview)
6. Reorder steps in `src/app/onboarding/page.tsx`
7. `/today` calibrating-state modules + polling
8. E2E test: full happy path + skip-channels path + planner-timeout fallback
