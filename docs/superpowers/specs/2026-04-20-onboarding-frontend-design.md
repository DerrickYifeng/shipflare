# Onboarding Frontend — Design & Implementation Spec

**Date:** 2026-04-20
**Status:** Design handoff received. Ready for implementation.
**Source:** `public/ShipFlare Design System.zip` →
`design_handoff_onboarding_v2/`
**Sibling:**
- `2026-04-20-planner-and-skills-redesign-design.md` (backend canonical)
- `2026-04-19-onboarding-redesign-design.md` (earlier onboarding flow spec —
   superseded where UX diverges)

Fidelity target: **pixel-perfect recreation** of the handoff. All
colors, typography, spacing, radii, motion match exactly.

---

## 1. Flow

**7 stages** collapsing to **4 progress steps** on the rail.

| Stage | Progress step | Route state | Skippable? |
|---|---|---|---|
| 1. Source (method pick + URL/GitHub) | 1 | `source` | — |
| 2. Scanning (6-agent animation) | 1 | `scanning` | Cancel → step 1 |
| 3. Profile review (6 fields, staggered reveal) | 1 | `review` | — |
| 4. Connect (Reddit + X) | 2 | `connect` | "Skip for now" allowed |
| 5. State picker (MVP / Launching / Launched) | 3 | `state` | — |
| 6. Plan building (6-agent animation, reused vocab) | 4 | `plan-building` | Cancel → step 5 |
| 7. Plan review (3-tab About/Timeline/First week) | 4 | `plan` | — |

Finish → `/today?from=onboarding` → **Today Landed** state.

---

## 2. Design tokens — v3 refresh

The handoff diverges from existing v2 tokens. Treat as v3 brand refresh.
Global replace (no onboarding-scoped override — clean code).

### Color (maps to handoff's `colors_and_type.css`)

```css
:root {
  /* Backgrounds */
  --sf-bg-primary:   #f5f5f7;  /* page bg, alternating sections */
  --sf-bg-secondary: #ffffff;  /* cards */
  --sf-bg-tertiary:  #ebebed;  /* subtle surface */
  --sf-bg-dark:      #000000;  /* scanning card, left rail */
  --sf-bg-dark-surface: #1d1d1f; /* secondary dark cards */

  /* Text on light */
  --sf-fg-1: #1d1d1f;             /* primary */
  --sf-fg-2: rgba(0,0,0,0.80);    /* body */
  --sf-fg-3: rgba(0,0,0,0.56);    /* secondary */
  --sf-fg-4: rgba(0,0,0,0.48);    /* mono labels, disabled */

  /* Text on dark */
  --sf-fg-on-dark-1: #ffffff;
  --sf-fg-on-dark-2: rgba(255,255,255,0.80);
  --sf-fg-on-dark-3: rgba(255,255,255,0.56);
  --sf-fg-on-dark-4: rgba(255,255,255,0.48);

  /* Borders */
  --sf-border:        rgba(0,0,0,0.08);
  --sf-border-subtle: rgba(0,0,0,0.04);

  /* Accent — Apple Blue (the ONE chromatic) */
  --sf-accent:       #0071e3;
  --sf-accent-hover: #0077ed;
  --sf-accent-light: #e8f2fc;
  --sf-accent-glow:  rgba(0,113,227,0.12);
  --sf-link:         #0066cc;

  /* Semantic */
  --sf-success:      #34c759;
  --sf-success-ink:  #248a3d;
  --sf-success-light:#eef9f1;
  --sf-warning:      #ff9f0a;  /* rocket flame — only warm chroma */
  --sf-error:        #ff3b30;
  --sf-error-ink:    #d70015;
  --sf-error-light:  #fff0ef;
}
```

### Rename / drop deprecated v2 tokens

Remove from globals.css: `--sf-signal*`, `--sf-flare*`, OKLCH tokens,
categorical palette `--sf-cat-*`. Replace all consumers.

- `--sf-signal` / `--sf-signal-hover` → `--sf-accent` / `--sf-accent-hover`
- `--sf-signal-tint` → `--sf-accent-light`
- `--sf-signal-glow` → `--sf-accent-glow`
- `--sf-signal-ink` → `--sf-link`
- `--sf-paper-raised` → `--sf-bg-secondary`
- `--sf-paper` → `--sf-bg-primary`
- `--sf-paper-sunken` → `--sf-bg-tertiary`
- `--sf-ink` → `--sf-bg-dark`
- `--sf-flare*` → delete (was never used on brand-critical surfaces)

### Type

Swap `Geist` → `SF Pro` (with Geist as fallback for non-Apple systems):

```css
--sf-font-display: -apple-system, BlinkMacSystemFont, "SF Pro Display",
                   "Geist", "Inter", "Helvetica Neue", sans-serif;
--sf-font-text:    -apple-system, BlinkMacSystemFont, "SF Pro Text",
                   "Geist", "Inter", "Helvetica Neue", sans-serif;
--sf-font-mono:    "SF Mono", ui-monospace, "Geist Mono",
                   "JetBrains Mono", Menlo, monospace;
```

Type scale unchanged at the name level, but values re-calibrated to
match handoff:

| Token | Old v2 | v3 refresh |
|---|---|---|
| `--sf-text-hero` | 64px | 56px (handoff h1) |
| `--sf-text-h1` | 44px | 34px (step headings) |
| `--sf-text-h2` | 32px | 21px (card titles) |
| `--sf-text-h3` | 22px | 21px (sub-headings) |

Letter-spacing stays negative: `-0.28px` for hero, `-0.224px` for body,
`-0.12px` for mono.

### Radius (updated)

| Token | Value | Usage |
|---|---|---|
| `--sf-radius-sm` | 5px | tiny badges |
| `--sf-radius-md` | 8px | buttons, method cards |
| `--sf-radius-lg` | 11px | search inputs |
| `--sf-radius-xl` | 12px | cards, account cards, scanning card |
| `--sf-radius-pill` | 980px | capsule CTAs (lg buttons), preset chips |
| `--sf-radius-full` | 9999px | circles |

### Shadow

```css
--sf-shadow-card:
  0 3px 5px rgba(0,0,0,0.04),
  0 6px 20px rgba(0,0,0,0.06);
--sf-shadow-card-hover:
  0 3px 5px rgba(0,0,0,0.04),
  0 12px 30px rgba(0,0,0,0.10);
--sf-shadow-elevated:
  0 20px 60px rgba(0,0,0,0.10),
  0 4px 12px rgba(0,0,0,0.06);
--sf-shadow-focus: 0 0 0 3px var(--sf-accent-glow);
```

### Motion (unchanged from v2)

```css
--sf-ease-swift:  cubic-bezier(0.16, 1, 0.3, 1);  /* PRIMARY — Apple slow-start-fast-finish */
--sf-ease-smooth: cubic-bezier(0.4, 0, 0.6, 1);    /* pulse */
--sf-dur-fast:    150ms;
--sf-dur-base:    200ms;
--sf-dur-slow:    300ms;
--sf-dur-entrance: 600ms;
```

Keyframes remain: `sf-fade-in`, `sf-slide-up`, `sf-pulse`.

---

## 3. Chrome — shell components

### 3.1 `OnboardingLayout` (new)

Replaces current `src/app/onboarding/layout.tsx` simple centering.

**Desktop** (≥880px):

- Two-column flex: 360px dark `ProgressRail` + fluid `WorkArea`
- `ProgressRail`: `bg: #000`, `color: #fff`, padding `32px 40px 40px`
- `WorkArea`: `bg: var(--sf-bg-primary)`, scroll in y, content column
  `max-width: 600px`, padding `72px 40px 60px`

**Mobile** (<880px):

- Single column, stack
- `MobileHeader`: 48px tall, white, 1px border-bottom, contains:
  - 16×16 back arrow (stage > 1) OR 24×24 logo (stage 1)
  - 4-segment progress bar (3px tall, 4px gap between segments)
  - Right: `1/4` · `2/4` · `3/4` · `4/4` counter (mono uppercase, tabular-nums)

### 3.2 `ProgressRail` (new component)

File: `src/components/onboarding/progress-rail.tsx`

Structure:

```
┌────────────────────────┐
│ 🚀 ShipFlare           │ header
│                        │
│ Setup · 2 of 4         │ mono meta
│ Connect your accounts  │ h1 (current step label)
│ So ShipFlare can …     │ p (current step detail)
│                        │
│ ① Add your product ✓   │ nav — done
│ ② Connect accounts   •  │ nav — active (filled ring + inner dot pulse)
│ ③ Where's your product │ nav — todo
│ ④ Your launch plan     │ nav — todo
│                        │
│ ┌──────────────────┐   │
│ │ Product          │   │ product card (shows after step 1)
│ │ ShipFlare        │   │
│ └──────────────────┘   │
│ ● 6 agents ready       │ footer status
└────────────────────────┘
```

Props: `{ step: 0..3, productName?: string }`

Step labels (fixed):
- `Add your product` / detail: "We'll scan your repo or site to extract name, description, and keywords."
- `Connect your accounts` / detail: "So ShipFlare can draft replies and schedule posts on your behalf."
- `Where's your product at?` / detail: "This decides whether we generate a pre-launch playbook or a compound plan."
- `Your launch plan` / detail: "Your calibrated plan — product, timeline, and first-week tasks."

`StepDot` variants:
- `done`: 22×22 circle, `bg: var(--sf-accent)`, white checkmark
- `active`: 22×22 circle, `bg: rgba(0,113,227,0.18)` + 1.5px blue border, inner 8×8 dot with `sf-pulse`
- `todo`: 22×22 circle, 1.5px `rgba(255,255,255,0.16)` border, step number in mono `rgba(255,255,255,0.36)`

### 3.3 `TopChevron` (new component)

File: `src/components/onboarding/top-chevron.tsx`

Top-left 32×auto ghost button, absolute-positioned at `top: 28px left: 40px`.
Renders on every stage except stage 1. Shows "Back" or "Cancel".

```tsx
<TopChevron onClick={onBack} label="Back" />  {/* stages 3,4,5,7 */}
<TopChevron onClick={onCancel} label="Cancel" /> {/* stages 2,6 during animation */}
```

Hover: bg `rgba(0,0,0,0.04)`, color `var(--sf-fg-1)`.

### 3.4 `StepHeader` (new component)

File: `src/components/onboarding/step-header.tsx`

```tsx
<StepHeader
  kicker="Step 2 · Channels"      // mono uppercase
  title="Connect your accounts"    // h2 34/600
  sub="We post as you, but only with your approval..."  // 16/400 rgba(0,0,0,0.64)
/>
```

margin-bottom: 24px.

---

## 4. Stages — implementation-level specs

### Stage 1 — Source

File: `src/components/onboarding/stage-source.tsx`

**Sub-states** (`method: 'choose' | 'github' | 'url'`):

#### choose

Two `MethodCard`s in `grid-cols-2` (desktop) / `grid-cols-1` (mobile):

| Card | Icon | Title | Sub |
|---|---|---|---|
| A — GitHub | `<GitHubMark />` | "Import from GitHub" | "Scan your code to understand your product." |
| B — URL | `<Globe />` | "From website URL" | "We'll scan your homepage for details." |

`MethodCard` details:
- `bg: #fff`, `radius-xl`, padding `22px 20px`
- 40×40 `radius-md` black square icon tile with white icon
- Title 16/600
- Sub 13/rgba(0,0,0,0.56) lineHeight 1.4
- shadow-card → shadow-card-hover on hover (with translateY -1px)

Below: `or enter manually →` tertiary text link, color `var(--sf-link)` 14/400.

#### github

`BackLink` → choose + (conditional):

- If not connected: `GithubConnectCard` (dark `#1d1d1f` card, authorize button)
- If connected: `RepoList` (scrollable list of repos)

`RepoList`:
- `bg: #fff`, `radius-xl`, `shadow-card`
- Header row (green 6% tint): `● Connected · @username` mono + "N recent repos" mono right-aligned
- Search input row: `bg: #f5f5f7`, `radius-md`, 32px tall, 13×13 search icon, 13px mono-ish text
- `max-height: 280px` scrollable list
- Each row:
  - 28×28 rounded square icon (GitHub mark idle; blue check when selected)
  - `{owner}/{repo}` in SF Mono 13/500
  - Chips: `Private` (grey) / `Recommended` (blue `#e8f2fc`/`#0071e3`) — radius-sm, mono 10px
  - Description 12px rgba(0,0,0,0.56) truncated
  - Right: language (mono 10px) + updated (mono 10px rgba(0,0,0,0.32))
  - Selected row: `bg: rgba(0,113,227,0.06)`, 3px left border `var(--sf-accent)`
  - Hover: `bg: rgba(0,0,0,0.02)`

CTA: `Scan repository →` primary lg, disabled until a repo picked.

#### url

`BackLink` → choose + `Field` with URL input + CTA `Scan website →` primary lg.

On error: `ErrorLine` below CTA + "Continue with just this URL →" text link
(fallback — submits the URL as an empty-profile extract).

### Stage 2 — Scanning

File: `src/components/onboarding/stage-scanning.tsx`

Full black card (not full-screen — lives inside WorkArea's content column).

```
┌────────────────────────────────────────┐
│ ● Scout · Running      $0.003 / 1.2s   │ header — mono
├────────────────────────────────────────┤
│ ● Reading README              OK       │
│    repo root · install · features      │
│ ● Parsing package metadata    ⋯        │
│    package.json · description          │
│ ○ Scanning recent releases             │
│    last 10 release notes · commits     │
│ ○ Extracting voice profile             │
│ ○ Inferring audience                   │
│ ○ Compiling keyword shortlist          │
├────────────────────────────────────────┤
│ 2 / 6 complete             CANCEL      │
└────────────────────────────────────────┘
```

Six rows, `~850ms + random jitter` per row. Status transitions:
`pending (hollow ring) → active (filled ring + inner pulse) → done (filled + white check)`.

### Agent / step vocabulary (USER-FACING — locked)

The 6 steps in scanning are **brand-level user-facing copy**. They
NARRATE the extract call, they don't dictate backend agent names.
Lock this vocabulary:

1. **Reading README** — `repo root · install · features`
2. **Parsing package metadata** — `package.json · description · keywords`
3. **Scanning recent releases** — `last 10 release notes · commits`
4. **Extracting voice profile** — `tone · vocabulary · cadence`
5. **Inferring audience** — `developers · indie founders`
6. **Compiling keyword shortlist** — `12 phrases for Reddit + X`

For URL source, rename step 1 to "Reading your homepage", step 2 to
"Parsing meta + OG tags", step 3 to "Scanning landing copy" — keep
others.

**Implementation note**: The animation is client-side decorative. The
real backend call (`POST /api/onboarding/extract[-repo]`) runs in
parallel. When the real call returns, advance to stage 3 immediately
(skip remaining animation steps). If the real call takes longer than
all 6 animation steps, loop the last step's pulse until it returns.

### Stage 3 — Profile review

File: `src/components/onboarding/stage-review.tsx`

`StepHeader`:
- kicker: `Step 1 · Review`
- title: "Here's what we found"
- sub: includes an inline green chip `✓ Extracted from github:owner/repo` or `yoursite.com`

6 rows with 90ms stagger reveal (`opacity 0→1 + translateY 4px→0`):

1. **Product name** (`OnbInput`, required)
2. **What it does** (`OnbTextarea` 4 rows, required, hint "One or two sentences")
3. **Target audience** (`OnbInput`, hint "Who you're trying to reach")
4. **Voice** (`VoicePicker`: 4 preset capsule chips + freeform input)
5. **Keywords** (`KeywordEditor`: chip editor with Enter/comma to add)
6. **Info strip** (`bg: #f5f5f7`, `radius-md`, blue dot + "What happens next" copy)

`VoicePicker` presets (lock):
- `Technical, calm, spec-like`
- `Warm and founder-like`
- `Playful and punchy`
- `Blunt and opinionated`

Selected chip: `bg: #1d1d1f color: #fff border: #1d1d1f`.
Idle chip: `bg: #fff color: rgba(0,0,0,0.72) border: rgba(0,0,0,0.10)`.

`KeywordEditor`:
- Container: 48px min-height, `bg: #fff`, `radius-md`, 1px `rgba(0,0,0,0.12)` border
- Each chip: `bg: #f5f5f7`, `radius-pill`, 4-10px padding, 13px, with
  18×18 circular remove button (bg `rgba(0,0,0,0.06)`, 8×8 x-glyph)
- Input: transparent, flex 1, placeholder "Add keywords…"
- Enter or comma commits, blur also commits, no duplicates

`ActionBar`:
- Ghost Back
- Spacer
- Primary `Looks good, continue →` (disabled until `name.trim() && description.trim()`)

### Stage 4 — Connect

File: `src/components/onboarding/stage-connect.tsx`

Two `AccountCard`s stacked (12px gap):

**Reddit card**:
- 40×40 icon tile `bg: #ff4500` 8% tint / `#ff4500` glyph
- Title "Reddit" / "Posts, comments, and subreddit discovery"
- Sample text (when connected): `r/SaaS, r/indiehackers, r/nextjs` (mono)

**X card**:
- 40×40 icon tile `bg: #000` 8% tint / `#000` glyph
- Title "X" / "Replies, quote-posts, and thread discovery"
- Sample text: `#buildinpublic, @levelsio network`

Card states (left-border 4px):
- `idle` — border transparent
- `connected` — `#34c759`
- `error` — `#ff3b30`
- `connecting` — transient, 900ms, then → connected or error

State pills (mono capsule):
- `● Connected` on `#eef9f1`/`#248a3d`
- `○ Connecting` on `#e8f2fc`/`#0066cc`
- `● Error` on `#fff0ef`/`#d70015`

Right-side action button:
- idle → `Connect` (secondary)
- connecting → `Connecting…` (secondary disabled)
- connected → `Disconnect` (ghost)
- error → `Retry` (secondary)

Info strip under cards (`bg: rgba(0,0,0,0.03)`, `radius-md`):
> **You approve every post.** ShipFlare drafts replies based on your
> profile, then queues them in `/today` for your review. Nothing goes
> live until you tap Send.

Action bar: `Back` · `Skip for now` · spacer · `Next · Where's your product at? →`
(primary disabled until ≥1 connected OR skip clicked).

### Stage 5 — State picker

File: `src/components/onboarding/stage-state.tsx`

Three `StateCard`s stacked (10px gap). Card: `bg: #fff`, `radius-xl`,
`shadow-card`.

Selected card: `box-shadow: 0 0 0 2px var(--sf-accent), var(--sf-shadow-card)`
(2px accent ring replaces 4px left border from earlier spec).

Each card:
- 22×22 radio circle (idle = 1.5px ring; selected = filled accent + white check)
- kicker mono (idle rgba(0,0,0,0.48), selected `var(--sf-accent)`)
- "Most popular" mono chip (only on `launching`, only when NOT selected)
- title 18/600
- sub 13/rgba(0,0,0,0.56)
- Bottom row (border-top): `Plan →` mono + plan label bold + detail

Three options (copy locked):

| id | kicker | title | sub | plan | planDetail |
|---|---|---|---|---|---|
| `mvp` | `MVP · pre-launch` | "I'm still building." | "No public launch yet. You have a prototype, alpha users, or a closed beta." | **Pre-launch playbook** | Audience research, Show HN prep, first 100 users. |
| `launching` | `Launching this week` (recommended) | "I'm launching soon." | "Product Hunt, Show HN, or a public beta in the next 7–14 days." | **Launch-week sprint** | Coordinated posts across Reddit, HN, and X — timed to your launch. |
| `launched` | `Launched · growing` | "I'm already live." | "You have real users and want to compound organic reach." | **Compound growth plan** | Ongoing scans, weekly quota, and reply-to-ratio tuning. |

**Conditional sub-forms** (appear below cards when selected):

- `launching` selected → white card "Launch details":
  - 2-col grid
  - `<input type="date">` for "Launch date" (default: today+7)
  - `<select>` for "Channel": Product Hunt / Show HN / Both / Other
- `launched` selected → white card "Roughly how many users?":
  - 4 capsule chips: `<100`, `100–1k`, `1k–10k`, `10k+` (radio behavior)
  - Selected chip: `bg: var(--sf-accent) color: #fff`

Action bar: Back · spacer · `Generate plan →`.

### Stage 6 — Plan building

File: `src/components/onboarding/stage-plan-building.tsx`

Reuses the Stage 2 scanning visual. Header:
- kicker `Step 4 · Building plan`
- title "Calibrating your plan"
- sub "Analyst is shaping a plan around a **{state}** product." (state mono-highlighted in accent)

6 steps (vocabulary lock):

1. **Loading profile** — `name · description · keywords`
2. **Matching state to plan shape** — `{STATE} · compound · sprint · playbook`
3. **Calibrating channels** — `Reddit · X · reply-to-ratio`
4. **Shortlisting subreddits** — `relevance · activity · moderation`
5. **Planning first-week cadence** — `replies · posts · approval gate`
6. **Adversarial QA on the plan** — `check voice · safety · quotas`

Same animation timing (850ms + jitter per step). Real backend call
(`POST /api/onboarding/plan`) runs in parallel; advance when response
arrives.

### Stage 7 — Plan review

File: `src/components/onboarding/stage-plan.tsx`

`StepHeader`:
- kicker `Step 4 · Plan`
- title "Your launch plan"
- sub `{plan.summary}` + "You can edit anything — this is a starting point, not a contract."

**Tabs** (3 tabs as a segmented control):
- `A · About your product`
- `B · Timeline`
- `C · First week`

Segmented control styling: `bg: rgba(0,0,0,0.05)`, `radius-md`, 4px padding.
Active tab: `bg: #fff`, `box-shadow: 0 1px 3px rgba(0,0,0,0.08)`.

#### Tab A — About

Card with rows, each:
- 100px label (mono 11 uppercase rgba(0,0,0,0.48))
- Value (14/400 rgba `--sf-fg-1`)
- Pencil icon to edit (appears on hover)
- Click pencil → inline edit: Input (or textarea) with blue border + focus ring, autoFocus, save on blur

Rows: Name, Description, Audience, Voice, Keywords, Channels.

Keywords row uses chip display (accent tint `rgba(0,113,227,0.08)` bg +
`#0066cc` text) + `+ Add` dashed-border chip.

#### Tab B — Timeline

Card, rows of `{period} · {title}` + bullet list:
- Period column: 90px mono `var(--sf-accent)` + title 13/600 below
- Bullets: 4px dots, 13/rgba(0,0,0,0.80), 1.47 lineHeight

Footer row inside card: `bg: rgba(0,0,0,0.03)`:
- `Quota` mono + "~45 replies · 9 posts · launch week" (12/400 rgba(0,0,0,0.64))

Timeline content is **state-dependent** — driven by
`strategic_paths.milestones + thesisArc` from the backend. Until the
backend is wired, use the hardcoded `PLAN_CONTENT` from
`step4_plan.jsx` as fallback data.

#### Tab C — First week

Vertical stack of numbered task cards (one per `plan_item` in the first-week plan):

```
┌────────────────────────────────────────┐
│  01  Scout scans 8 subreddits          │  pending
│      r/SaaS · r/indiehackers …         │
└────────────────────────────────────────┘
```

Each card:
- `bg: #fff`, `radius-xl`, 14×16 padding
- 28×28 `radius-md` blue-tinted square with mono index (`01`, `02`, ...)
- Title 14/500 + detail 12/rgba(0,0,0,0.56)
- Right-aligned mono `pending` label (will become `drafted` / `approved` etc. later)

**Action bar**:
- Back (ghost)
- Spacer
- `Looks good · finish later` (secondary)
- `Launch the agents →` (primary) — push to `/today?from=onboarding`

---

## 5. Data binding (maps stages to backend endpoints)

Matches `2026-04-20-planner-and-skills-redesign-design.md` §9 and the
earlier `2026-04-19-onboarding-backend-design.md` §5 Redis draft state.

| Stage | Action | Endpoint | Write site |
|---|---|---|---|
| 1 source — URL | Scan | `POST /api/onboarding/extract` | Redis draft `product` |
| 1 source — GitHub | Scan | `POST /api/onboarding/extract-repo` (SSE) | Redis draft `product` |
| 1 source — repos list | List | `GET /api/onboarding/github-repos` | — |
| 2 scanning | decorative + real extract in parallel | — | — |
| 3 review — save | Continue | `PUT /api/onboarding/draft` (mirror edits) | Redis draft |
| 4 connect | OAuth | `/api/x/connect`, `/api/reddit/connect` (existing) | `channels` row |
| 4 connect — after callback | reload | `GET /api/onboarding/draft` | — |
| 5 state — submit | Generate plan | `PATCH` Redis draft + `POST /api/onboarding/plan` | — |
| 6 plan-building | parallel animation + real plan call | — | — |
| 7 plan — confirm | Commit | `POST /api/onboarding/commit` | products + strategic_paths + plans + plan_items |
| finish | navigate | `/today?from=onboarding` | — |

**Client state**:

```ts
type Stage = 'source' | 'scanning' | 'review' | 'connect' | 'state'
           | 'plan-building' | 'plan';

interface DraftState {
  product: ExtractedProfile | null;       // from extract
  reviewed: boolean;                       // did user pass Stage 3
  productState: 'mvp' | 'launching' | 'launched' | null;
  launchDate: string | null;               // ISO date for `launching`
  launchChannel: 'producthunt' | 'showhn' | 'both' | 'other' | null;
  usersBucket: '<100' | '100-1k' | '1k-10k' | '10k+' | null;
  // plan appears after Stage 6 completes
  path: StrategicPathOutput | null;
  plan: TacticalPlanOutput | null;
}
```

All held in React state in `OnboardingFlow`. Mirror to Redis via
`PUT /api/onboarding/draft` after each stage transition (debounced 400ms
during typing in Stage 3).

**Back-button semantics** (from `2026-04-17-onboarding-back-button-design.md`):

- Stage 2 (scanning) → Stage 1 (source, method: url or github) with preserved URL
- Stage 3 (review) → Stage 1 (user re-selects source)
- Stage 4 (connect) → Stage 3 (review, with their edits intact)
- Stage 5 (state) → Stage 4 (connect, with connected state intact)
- Stage 6 (plan-building) → Stage 5 (state, with picker intact)
- Stage 7 (plan) → Stage 5 (re-pick state + re-generate plan)

---

## 6. Agent-pipeline vocabulary (brand-locked)

The 6 user-visible agent names stay constant across onboarding Stage 2,
Stage 6, and the `/today` landed state. This is brand; don't drift.

| UI name | Backend concept | Used in |
|---|---|---|
| SCOUT | discovery scan (source discovery) | stages 2/6, Today landed |
| DISCOVERY | discovery scan (thread fetch + score) | stages 2/6, Today landed |
| ANALYST | strategic-planner + tactical-planner | stages 2/6, Today landed |
| CONTENT | draft-single-post / draft-single-reply | stage 6, Today landed |
| REVIEW | draft-review | stage 6, Today landed |
| POSTING | posting | Today landed only |

Status values: `active` (green pulse), `queued` (hollow ring), `idle` (muted), `done` (blue check).

Each stage passes different status patterns:
- Stage 2 (during extract): SCOUT active, others sequential
- Stage 6 (during plan): ANALYST active
- Today landed (post-onboarding): SCOUT active, DISCOVERY active, ANALYST queued, CONTENT queued, REVIEW idle, POSTING idle

---

## 7. Today Landed state

Route: `/today?from=onboarding`. Triggered by the `?from=onboarding`
query param; clears on first user interaction or auto-clears on next
visit.

**Layout**: full `/today` shell (sidebar/topnav stays as-is for the app),
but main content replaced with a **hero landing view**.

### 7.1 Full-bleed black hero (first-visit only)

Matches `Today Landed.html` in the handoff:

- `bg: #000`, `color: #fff`
- Header: logo + nav + right-side "Pipeline live · 00:01" green capsule
- Center stack, `max-width: 980px`:
  - Mono "Setup · complete"
  - h1 56/600 white: "You're set.\nScout is already working." (2nd line rgba 56%)
  - p 17/400 rgba 72%: "First drafts land here in about an hour. Nothing posts until you approve."
- Two-column grid (1.4fr 1fr) below hero copy:
  - Left card (black surface raised, `bg: #1d1d1f`): **Agent pipeline** — the 6 agents in status list
  - Right card: **What happens next** — 3 numbered rows (`01 First drafts · ~1 hour`, `02 Approve & send · /today`, `03 Tune your voice · /voice`)
- Bottom strip: dashed-border empty-queue card
  - Left: "Your queue · empty" mono + "Nothing to approve yet." 17/500 + explanatory copy
  - Right: two buttons — `Revisit plan →` (primary blue) and `Explore sample draft` (ghost outlined on dark)

### 7.2 Dismiss

After 5-10 seconds OR on any user interaction, landed hero collapses
into the normal `/today` layout with a **persistent welcome ribbon** at
top:

- `bg: rgba(0,113,227,0.06)`, `radius-md`, padding 12×14
- "Setup complete. Your AI team is live."  14/500 blue
- Mono: "Scout started Xm ago · first results in ~1h"
- Dismiss `×` button right-aligned

Ribbon persists for first 24h or until dismissed.

### 7.3 Landing state modules (in persistent mode)

Matches `2026-04-19-onboarding-redesign-design.md` §9:
- **Discovery module**: calibrating skeletons → results cards
- **Posts module**: drafting skeletons → draft cards

Polling every 3s for job completion (existing pattern — see
`src/hooks/use-today.ts`).

---

## 8. Animation inventory

| Animation | Duration | Ease | Where |
|---|---|---|---|
| `sf-slide-up` entrance | 400ms | `swift` | WorkArea content on every stage change |
| Field stagger reveal | 90ms per row, 280ms transition | `swift` | Stage 3 fields 1-6 |
| Step row reveal (scanning) | 850ms + 400ms jitter | `swift` | Stages 2, 6 row transitions |
| Card hover translate | 200ms | `swift` | MethodCard, RepoRow, StateCard |
| Button hover background | 200ms | `swift` | Primary + Secondary buttons |
| State-pill transition | 300ms | `swift` | AccountCard border color |
| Pulse dot | 1.5s infinite | `smooth` | `● Running` dots, active step dots |
| Segmented-tab switch | 150ms | `swift` | Stage 7 tab bar |
| `sfSpin` (inline loader) | 800ms linear infinite | — | ExtractingCard spinner |

`prefers-reduced-motion: reduce` clamps all animation durations to
0.01ms. Already in globals.css base.

---

## 9. Responsive strategy

**Breakpoint**: 880px (matches handoff).

- `≥880px`: 2-column (360px rail + fluid work area), work area content max 600px centered
- `<880px`: single column, MobileHeader 48px tall, work area narrowed to 340px max

Desktop rail → hide on mobile.

`TopChevron` → replaced by MobileHeader back arrow.

Grid layouts:
- Stage 1 method cards: `grid-cols-2` → `grid-cols-1` on mobile
- Stage 7 About tab rows: 100px label column stays (it's small enough)
- Stage 5 `launching` date+channel: `grid-cols-2` → `grid-cols-1` on mobile

---

## 10. Accessibility

- All form fields have explicit `<label>` via `Field` component
- `aria-label` on icon-only buttons (TopChevron, KeywordEditor remove chips)
- Radio cards in Stage 5: use `role="radiogroup"` on container, `role="radio"` + `aria-checked` on each card
- Segmented tabs (Stage 7): `role="tablist"` + `role="tab"` + `aria-selected`
- Live regions: scanning/plan-building step list announces completion: `role="status"` + `aria-live="polite"`
- Focus states: all interactive elements get `box-shadow: var(--sf-shadow-focus)` + 1px accent border on `:focus-visible`
- Keyboard:
  - Stage 1 method cards: Enter/Space to activate
  - Stage 3 keyword editor: Enter/comma to add chip
  - Stage 5 state cards: arrow keys to navigate radiogroup, Space to select
  - Stage 7 tabs: arrow keys to navigate tablist

---

## 11. Component inventory

### New components (create)

```
src/components/onboarding/
  OnboardingFlow.tsx          # orchestrator (state + routing)
  progress-rail.tsx           # desktop 360px dark rail
  mobile-header.tsx           # mobile 48px header w/ 4-segment progress
  top-chevron.tsx             # absolute top-left back/cancel
  work-area.tsx               # the f5f5f7 scrollable right column
  step-header.tsx             # kicker + title + sub
  action-bar.tsx              # bottom row: back / spacer / primary

  stage-source.tsx
  stage-scanning.tsx
  stage-review.tsx
  stage-connect.tsx
  stage-state.tsx
  stage-plan-building.tsx
  stage-plan.tsx

  _shared/
    method-card.tsx
    github-connect-card.tsx
    repo-list.tsx
    repo-row.tsx
    extracting-card.tsx
    inline-scan-status.tsx
    field-reveal.tsx          # stagger wrapper
    voice-picker.tsx
    keyword-editor.tsx
    account-card.tsx
    state-card.tsx
    state-pill.tsx
    onb-mono.tsx              # the signature mono-uppercase label
    onb-textarea.tsx
    scan-dot.tsx
    agent-dot.tsx
    agent-pipeline-card.tsx   # reused in stage 2/6 + today landed
    six-step-animator.tsx     # shared between scanning + plan-building

src/components/today/
  today-landed-hero.tsx       # full-bleed black hero
  today-welcome-ribbon.tsx    # persistent dismissible ribbon
```

### Existing primitives — fate

| Existing | Use in onboarding? | Notes |
|---|---|---|
| `Button` | No — replace with `OnbButton` (capsule lg style) | Existing Button uses `radius-md` 10px; onboarding needs 980px pill |
| `Input` | No — replace with `OnbInput` (48px tall, radius 11) | Existing is 40px radius 6px |
| `Badge` | Maybe — review case by case | Pills in onboarding are bespoke (StatePill with mono) |
| `Card` | No — onboarding cards are bespoke | Shadow, radius, padding all different |
| `ProgressDots` | ❌ Delete | Replaced by ProgressRail |
| `Dialog` | Keep | Not used in onboarding |
| `Toast` | Keep | Not used in onboarding |

**Decision**: keep `OnbButton` / `OnbInput` as onboarding-specific
primitives (don't globally replace `Button` / `Input`). Once onboarding
ships and proves the visual language, we can merge back later.

---

## 12. Assets

From handoff `assets/`:

- `logo-32.png`, `logo-64.png`, `logo-128.png`, `logo-192.png`, `logo-512.png`, `logo-1024.png`
- `apple-touch-icon.png`

Copy into `public/brand/` (replace existing logos if any).

Icons: hand-rolled 16×16 SVGs. Create `src/components/onboarding/icons.tsx`:

```tsx
export const OnbIcons = {
  arrowRight, arrowLeft, check, globe, github, pencil,
  reddit, x, xClose, search,
};
```

All use `stroke="currentColor" strokeWidth="1.5" fill="none"` except
`github`/`reddit`/`x` which are filled brand marks.

---

## 13. Copy strings (lock)

All user-visible strings in `src/components/onboarding/_copy.ts` (single
module, English only for v1):

```ts
export const COPY = {
  rail: {
    header: 'ShipFlare',
    meta: (step: number) => `Setup · ${step + 1} of 4`,
    steps: [
      { label: 'Add your product', detail: "We'll scan your repo or site to extract name, description, and keywords." },
      { label: 'Connect your accounts', detail: "So ShipFlare can draft replies and schedule posts on your behalf." },
      { label: "Where's your product at?", detail: "This decides whether we generate a pre-launch playbook or a compound plan." },
      { label: 'Your launch plan', detail: "Your calibrated plan — product, timeline, and first-week tasks." },
    ],
    footerStatus: '6 agents ready',
  },
  stage1: { /* ... */ },
  // ... etc
};
```

This makes future i18n a single-file diff.

---

## 14. Edge cases & states

| Situation | UX |
|---|---|
| User refreshes mid-flow | Redis draft loads → jump to last stage via `GET /api/onboarding/draft` |
| Extract times out (>20s) | Inline red "Taking longer than expected" under scanning card; cancel fallback |
| Extract fails | Inline error + "Continue with just this URL →" fallback button |
| OAuth popup closes mid-flow | Account card back to `idle` state, user retries |
| Plan generation times out (>45s) | Error state + "Continue with manual plan" button (uses generic template) |
| User opens `/onboarding` after completing | Server detects `products.onboardingCompletedAt != null` → redirect `/today` |
| User navigates to `/today` before commit | Server redirects back to `/onboarding` at last valid stage |
| `launchDate` in the past (Stage 5 `launching`) | Client warning under date input; server rejects commit with 400 |
| User disconnects a channel mid-flow | Card → `idle`; if they were at Stage 5+, no change (channels info already in draft) |

---

## 15. Fidelity checklist (pre-merge)

Pixel-perfect means pixel-perfect. Before PR approval:

- [ ] Every color hex exact-matches the handoff
- [ ] Every radius value exact (5 / 8 / 11 / 12 / 980 / 9999)
- [ ] Mono labels are SF Mono, uppercase, `letter-spacing: -0.12px`
- [ ] Negative letter-spacing on all text (checked per-type-token)
- [ ] Primary `lg` buttons are 44px tall, `radius: 980`, `padding: 0 22px`
- [ ] Primary CTA bg is exactly `#0071e3`, hover `#0077ed`
- [ ] Card shadows use exact 2-layer spec, no blur mismatch
- [ ] Ease is exactly `cubic-bezier(0.16, 1, 0.3, 1)` on interactive transitions
- [ ] 850ms ± random 400ms jitter on scanning step rows
- [ ] 90ms field-stagger on Stage 3 reveal
- [ ] Focus ring is `0 0 0 3px rgba(0,113,227,0.12)` (plus 1px accent border)
- [ ] All form labels + hint text present
- [ ] `prefers-reduced-motion: reduce` honored throughout
- [ ] Mobile 880px breakpoint switches layouts cleanly
- [ ] Desktop rail stays 360px (fixed, not fluid)
- [ ] Every piece of copy matches handoff strings letter-for-letter
