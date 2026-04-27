# Planner & Skills Redesign — Canonical Backend Spec

**Date:** 2026-04-20
**Status:** Design approved, ready for implementation plan.
**Supersedes:** `docs/superpowers/specs/2026-04-19-onboarding-backend-design.md`
(onboarding-surface details still live there; the architectural decisions
below override that doc's planner / skill sections).
**Sibling:** `docs/superpowers/specs/2026-04-19-onboarding-redesign-design.md`
(frontend-facing onboarding flow).

---

## Summary

Replace the current "N specialized planner agents + compound skills" layout
with a **two-tier planner + atomic skills** model:

1. **Strategic Planner** — low-frequency, produces a durable narrative
   `strategic_path` (milestones, thesis arc, content pillars, channel mix,
   phase goals). Runs at onboarding + whenever the user manually updates
   product phase / launch date.
2. **Tactical Planner** — high-frequency, reads the active path and this
   week's signals, produces concrete `plan_items` for the coming 7 days.
   Runs at onboarding (after strategic), every Monday cron, and on user
   manual re-plan.

Plan is a **first-class artifact** stored in a polymorphic `plan_items`
table. All existing planner-adjacent tables (`xContentCalendar`,
`weeklyThemes`, `launch_tasks`, `todoItems`) are removed — their contents
fold into `plan_items` with `kind` discriminator.

Existing specialized agents (`calendar-planner`, `scout`, `analyst`,
`content` as compound) are deleted. Executor agents (`slot-body-agent`,
`reply-drafter`, `draft-review`, `posting`, `discovery` single-source,
`product-opportunity-judge`, `voice-extractor`) survive as **atomic
skills** the tactical planner schedules.

---

## 1. Architecture

### 1.1 Layers (top → bottom)

```
Triggers          onboarding   |   Monday cron   |   manual re-plan   |   phase change
                      ↓                ↓                 ↓                    ↓
                [Strategic Planner]          [Tactical Planner]       [Strategic Planner]
                      ↓                             ↓                         ↓
                strategic_paths row          plans row                 strategic_paths row
                      ↓                             ↓                         ↓
                      └── triggers Tactical ─── plan_items rows ──── triggers Tactical
                                                   ↓
Workers (dumb executors)                  [Plan Executor Worker]
                                                   ↓
                                          Atomic skill dispatch
                                                   ↓
Atomic Skills        draft-single-post | send-email | schedule-post | discovery |
                     slot-body | reply-drafter | posting | draft-review | ...
                                                   ↓
Tools                reddit_search | x_post | score_threads | scrape_url | ...
```

### 1.2 What lives where

| Concern | Lives in |
|---|---|
| "Which launch phase am I in?" | `products.state + launchDate/launchedAt` → `derivePhase()` |
| "What's the 6-week narrative?" | `strategic_paths.narrative + milestones + thesisArc` |
| "What's this week's thesis?" | `strategic_paths.thesisArc[n]` where `n = week index` |
| "What should I post Wednesday at 17:00?" | `plan_items` row (kind=`content_post`) |
| "What skill drafts the body?" | `plan_items.skillName` → `draft-single-post-x` |
| "Is this draft approved?" | `plan_items.state + userAction` state machine |
| "Is this tweet scheduled?" | `plan_items.state='approved' + scheduledAt` |

### 1.3 What's gone

| Removed | Reason |
|---|---|
| Agent: `calendar-planner` | Absorbed into `tactical-planner` |
| Agent: `scout` | Absorbed into `strategic-planner` |
| Agent: `analyst` | Split into atomic skill `analytics-summarize` |
| Skill: `content-gen` (compound) | Split into per-platform `draft-single-post-*` |
| Skill: `full-scan` | Hand-coded pipeline, not a skill |
| Skill: `community-intel` | Split into `fetch-community-rules` + `fetch-community-hot-posts` |
| Table: `xContentCalendar` | Merge into `plan_items` |
| Table: `weeklyThemes` | Merge into `strategic_paths.thesisArc` |
| Table: `launch_tasks` | Merge into `plan_items` |
| Table: `todoItems` | Merge into `plan_items` (replies become `kind='content_reply'`) |

---

## 2. Schema

### 2.1 `products` (delta from existing)

Unchanged from `2026-04-19-onboarding-backend-design.md` §1.1:

```diff
-  lifecyclePhase text
+  state text not null default 'mvp'
+  launchDate timestamp
+  launchedAt timestamp
+  targetAudience text
+  category text
+  onboardingCompletedAt timestamp
```

Plus unique index `products(user_id)` (one product per user).

### 2.2 `strategic_paths` (NEW)

```ts
strategic_paths {
  id                uuid PK
  userId            fk users, cascade
  productId         fk products, cascade
  isActive          boolean not null default true   -- only one active per user
  generatedAt       timestamp default now

  -- Snapshot of product state at generation time
  phase             launch_phase not null
  launchDate        timestamp
  launchedAt        timestamp

  -- Planner output
  narrative         text not null
  -- "You're 32 days from launch. The next 2 weeks focus on build-in-public
  --  + waitlist growth while you finalize MVP polish..."

  milestones        jsonb not null
  -- [{ atDayOffset: -14, title: "Hit 200 waitlist signups",
  --    successMetric: "waitlist count >= 200", phase: "audience" }, ...]

  thesisArc         jsonb not null
  -- [{ weekStart: ISO, theme: "Why indie devs waste 6h/week on PR review",
  --    angle_mix: ["contrarian", "data", "story"] }, ...]

  contentPillars    jsonb not null
  -- ["build", "insights", "community"] — 3-4 durable content lanes

  channelMix        jsonb not null
  -- { x: { perWeek: 5, preferredHours: [14,17,21] },
  --   reddit: { perWeek: 2, preferredCommunities: [...] },
  --   email: { perWeek: 1 } }

  phaseGoals        jsonb not null
  -- { foundation: "Nail positioning + 200 waitlist",
  --   audience: "Get to 500 followers + 50 beta users", ... }

  usageSummary      jsonb                          -- planner token cost snapshot
}
```

Unique index: `strategic_paths(user_id) WHERE is_active = true`
(Postgres partial unique index — at most one active row per user.)

### 2.3 `plans` (NEW, lightweight header)

```ts
plans {
  id                uuid PK
  userId            fk users, cascade
  productId         fk products, cascade
  strategicPathId   fk strategic_paths, set null
  trigger           enum('onboarding', 'weekly', 'manual')
  weekStart         timestamp not null             -- Monday 00:00 UTC of the week covered
  generatedAt       timestamp default now
  notes             text                            -- tactical's note-to-user
  usageSummary      jsonb
}
```

Index: `plans(user_id, week_start desc)`.

### 2.4 `plan_items` (NEW, polymorphic)

```ts
plan_item_kind_enum = (
  'content_post'       -- scheduled original post, approve-then-publish
  'content_reply'      -- reply to a discovered thread, approve-then-publish
  'email_send'         -- outbound email (welcome / retro / thank-you)
  'interview'          -- user-conducted interview, manual checkoff
  'setup_task'         -- positioning / waitlist / landing page, may have skill or manual
  'launch_asset'       -- PH gallery image, 30s video, hunter outreach
  'runsheet_beat'      -- launch-day hourly runsheet entry
  'metrics_compute'    -- auto-run analytics / computations
  'analytics_summary'  -- AI-summarized weekly analytics for Today
)

plan_item_state_enum = (
  'planned'            -- generated by planner, not yet drafted
  'drafted'            -- skill produced draft, awaiting review (if userAction=approve)
  'ready_for_review'   -- drafted + surfaced on Today
  'approved'           -- user approved, queued for execution
  'executing'          -- worker actively running
  'completed'          -- successfully done
  'skipped'            -- user dismissed
  'failed'             -- execution errored (keep for retry / visibility)
  'superseded'         -- replaced by a newer plan
  'stale'              -- scheduled time past + user never acted
)

plan_item_user_action_enum = ('auto', 'approve', 'manual')

plan_items {
  id                uuid PK
  userId            fk users, cascade
  productId         fk products, cascade
  planId            fk plans, cascade              -- which tactical run produced it

  kind              plan_item_kind_enum not null
  state             plan_item_state_enum not null default 'planned'
  userAction        plan_item_user_action_enum not null

  phase             launch_phase not null          -- launch phase at scheduling time
  channel           text                            -- null for channel-agnostic
  scheduledAt       timestamp not null

  skillName         text                            -- null if userAction='manual'
  params            jsonb not null                  -- input to the skill
  output            jsonb                           -- draft id, post id, send timestamp

  title             text not null                   -- human-readable
  description       text                            -- human-readable

  completedAt       timestamp
  createdAt         timestamp default now
  updatedAt         timestamp default now
}
```

Indexes:
- `plan_items(user_id, state, scheduled_at)` — hot path for Today / Executor
- `plan_items(plan_id)` — for "what did this plan produce"
- `plan_items(user_id, kind, state)` — for kind-specific queries

### 2.5 Migration

One migration file (dev data, no prod yet):

```sql
-- Add products columns (from 2026-04-19 spec)
ALTER TABLE products ADD COLUMN state text;
-- ... (all the launch-state columns)
CREATE UNIQUE INDEX products_user_uq ON products(user_id);

-- Create launch_phase + plan_item enums
CREATE TYPE launch_phase AS ENUM ('foundation','audience','momentum','launch','compound','steady');
CREATE TYPE plan_item_kind AS ENUM ('content_post','content_reply','email_send','interview',
  'setup_task','launch_asset','runsheet_beat','metrics_compute','analytics_summary');
CREATE TYPE plan_item_state AS ENUM ('planned','drafted','ready_for_review','approved',
  'executing','completed','skipped','failed','superseded','stale');
CREATE TYPE plan_item_user_action AS ENUM ('auto','approve','manual');

-- strategic_paths
CREATE TABLE strategic_paths ( ... );
CREATE UNIQUE INDEX strategic_paths_active_uq ON strategic_paths(user_id)
  WHERE is_active = true;

-- plans
CREATE TABLE plans ( ... );

-- plan_items
CREATE TABLE plan_items ( ... );

-- DROP obsolete tables
DROP TABLE x_content_calendar;
DROP TABLE weekly_themes;
DROP TABLE todo_items;
-- (launch_tasks from old spec never existed — was only proposed)

-- DROP obsolete products column
ALTER TABLE products DROP COLUMN lifecycle_phase;
```

---

## 3. Agents

### 3.1 Deletions

Delete: `src/agents/calendar-planner.md`, `src/agents/scout.md`,
`src/agents/analyst.md`, `src/agents/content.md`.

### 3.2 `strategic-planner` (NEW)

```yaml
# src/agents/strategic-planner.md frontmatter
---
name: strategic-planner
description: Produces the durable narrative path for a product's launch arc
model: claude-sonnet-4-6
tools: []
maxTurns: 3
maxOutputTokens: 32000
---
```

**Role prompt (skeleton):**

> You are ShipFlare's Strategic Path Planner. Given a product, its launch
> state, and category-specific playbooks, produce a **durable narrative
> path** — the big-picture arc for the next 6 weeks (pre-launch) or 30
> days (post-launch).
>
> Your output is NOT the concrete week's tweets and tasks — that's the
> Tactical Planner's job. Your output is the **frame** the Tactical
> Planner uses every week until phase changes.
>
> ## Input
>
> A JSON object with:
> - `product`: name, description, valueProp, keywords, category, targetAudience
> - `state`, `launchDate`, `launchedAt`
> - `channels`: connected platforms
> - `voiceProfile`: user's writing style (if extracted)
> - `recentMilestones`: shipping events from last 14 days
> - `categoryPlaybook`: reference doc loaded via skill references
>
> ## Your job
>
> 1. Diagnose the product's **narrative thesis** — the one claim the next
>    6 weeks argues for
> 2. Break the arc into **weekly themes** (thesisArc) — one per week in
>    the window
> 3. Identify **3–4 content pillars** that the product can own (not
>    generic — specific to this product's wedge)
> 4. Set **phase milestones** with success metrics
> 5. Recommend **channel mix** — posts per week per platform, preferred hours
> 6. Write a 2–3 paragraph **narrative** explaining the overall strategy
>
> ## Output (validated via Zod)
>
> See `strategicPathSchema` in `src/agents/schemas.ts` — matches
> `strategic_paths` table columns.
>
> ## References (auto-injected)
>
> - `category-playbooks.md` — per-category narrative defaults
> - `launch-phases.md` — the 6-phase taxonomy + objectives per phase
> - `milestone-to-thesis.md` — how to derive thesis from shipping events
```

### 3.3 `tactical-planner` (NEW)

```yaml
# src/agents/tactical-planner.md frontmatter
---
name: tactical-planner
description: Produces one week of concrete plan items from strategic path + signals
model: claude-haiku-4-5-20251001
tools: []
maxTurns: 2
maxOutputTokens: 48000
---
```

**Role prompt (skeleton):**

> You are ShipFlare's Tactical Weekly Planner. Given the user's **active
> strategic path** and this week's **signals**, produce concrete
> `plan_items` for the next 7 days.
>
> You do NOT write post bodies or draft emails. You SCHEDULE items and
> attach the right atomic skill + params. Skills run later in the
> Executor.
>
> ## Input
>
> - `strategicPath`: narrative, thesisArc[weekIndex], contentPillars,
>    channelMix, phaseGoals, milestones
> - `product`: current state + phase + dates
> - `channels`: connected platforms
> - `weekStart`, `weekEnd`: window to plan for
> - `signals`:
>   - `recentMilestones`: shipping events last 14 days
>   - `recentMetrics`: top-performing content last 7 days
>   - `stalledItems`: last week's planned-but-undone
>   - `completedLastWeek`: last week's finished items (dedupe against)
>   - `currentLaunchTasks`: long-running tasks still pending
> - `skillCatalog`: list of available skills with their params schemas
>
> ## Your job
>
> For the 7-day window:
>
> 1. Read this week's theme from `thesisArc[thisWeekIndex]`
> 2. Allocate content slots per `channelMix.{channel}.perWeek`, at
>    `preferredHours`, respecting contentPillars rotation
> 3. Schedule phase-appropriate setup_tasks / interviews if not already
>    in `currentLaunchTasks`
> 4. Schedule emails per phase (welcome drip, weekly update, retro)
> 5. For each item, pick the correct `skillName` from `skillCatalog`
>    and fill `params`
> 6. Write a short `notes` paragraph for the user — "This week's focus: …"
>
> ## Rules
>
> - NEVER schedule a `channel`-bound item for a platform not in `channels`
> - NEVER duplicate a task that's in `currentLaunchTasks` or
>   `completedLastWeek`
> - Items of kind `interview` / most `setup_task` → `userAction='manual'`
> - Items of kind `content_post` / `email_send` → `userAction='approve'`
> - Items of kind `metrics_compute` / `analytics_summary` →
>   `userAction='auto'`
> - Every `content_post` must reference `thesisArc[weekIndex].theme` in
>   its `params.anchor_theme`
>
> ## Output
>
> ```ts
> {
>   plan: { thesis: string, notes: string }
>   items: Array<PlanItem>  // see plan_items schema
> }
> ```
>
> ## References (auto-injected)
>
> - `voice-profile.md` — user's voice (if extracted)
> - `angle-playbook.md` — content angle taxonomy
> - `phase-task-templates.md` — phase-specific task library
> - `skill-catalog.md` — available skills + param shapes
```

### 3.4 Surviving atomic executor agents

Untouched:

- `slot-body-agent` — writes one post body given angle + theme
- `reply-drafter` — writes one reply given thread + product
- `draft-review` — reviews one draft for quality
- `posting` — actually posts a draft
- `discovery` (single source) — searches one source, scores threads
- `product-opportunity-judge` — scores one thread for relevance
- `voice-extractor` — extracts voice from user posts
- `community-discovery` — finds communities given product context
- `engagement-monitor` — monitors engagement on a post
- `react-preamble` — template preamble (keep as-is)

### 3.5 Agent input: `lifecyclePhase` → `currentPhase`

All surviving agents that currently reference `lifecyclePhase` in their
template switch to `currentPhase` (derived via `derivePhase()` by the
caller). See 2026-04-19 spec §2.1 for the helper.

---

## 4. Skills

### 4.1 Existing skills — fate

| Skill | Fate | Notes |
|---|---|---|
| `calendar-planner` | **DELETE** | Replaced by `tactical-planner` agent |
| `content-gen` | **SPLIT** | Into `draft-single-post-x`, `draft-single-post-reddit`, `draft-single-post-linkedin` |
| `community-intel` | **SPLIT** | `fetch-community-rules`, `fetch-community-hot-posts` |
| `full-scan` | **DELETE** | Reusable as a TS pipeline, not a skill |
| `discovery` | KEEP | Already atomic (single-source) |
| `slot-body` | KEEP + RENAME | → `draft-single-post-x-body` (clearer) |
| `reply-scan` | RENAME | → `draft-single-reply` |
| `draft-review` | KEEP | |
| `posting` | KEEP | |
| `product-opportunity-judge` | KEEP | Used by discovery pipeline |
| `voice-extractor` | KEEP | |
| `community-discovery` | KEEP | Consumed by strategic-planner context builder |
| `deep-analysis` | KEEP | |

### 4.2 New atomic skills

**Content drafting:**
- `draft-single-post-x` — one X post from angle + theme
- `draft-single-post-reddit` — one Reddit post from community + angle
- `draft-single-post-linkedin` — one LinkedIn post (when enabled)
- `draft-single-reply-x` — one X reply from thread
- `draft-single-reply-reddit` — one Reddit reply from thread

**Email:**
- `draft-email` — one email body (welcome / retro / thank-you / drip)
- `send-email` — actually send via provider (SES / Resend)
- `ab-test-subject` — generate 2 subject variants

**Launch assets:**
- `draft-waitlist-page` — HTML/Markdown for waitlist landing
- `draft-hunter-outreach` — PH hunter DM
- `draft-launch-day-comment` — maker's first comment for PH
- `generate-launch-asset-brief` — brief for designer (gallery image / video)
- `build-launch-runsheet` — hourly run-of-show

**Research / Analytics:**
- `extract-milestone-from-commits` — git log → milestone description
- `fetch-community-rules` — one subreddit rules fetch
- `fetch-community-hot-posts` — one subreddit hot posts fetch
- `analytics-summarize` — one week's metrics → summary (replaces `analyst`)
- `identify-top-supporters` — top-N engagers across channels
- `generate-interview-questions` — 10 questions for user calls

**Utility:**
- `compile-retrospective` — launch data → retro long-form
- `classify-thread-sentiment` — one thread → pos/neg/neutral

### 4.3 Skill catalog

New file `src/skills/_catalog.ts` exports a machine-readable list of all
skills with their input/output schemas. Consumed by:

- `tactical-planner` prompt (injected as `skill-catalog.md` reference)
- Plan Executor worker (routes `plan_items.skillName` to correct skill)
- UI (surfaces "available skills" if we expose custom workflows later)

---

## 5. Worker / Queue Model

### 5.1 New queue: `plan-execute`

One queue replaces many. `plan_items` with
`state IN ('drafted','approved') AND scheduledAt <= now` get picked up.

```ts
plan_execute_schema = {
  planItemId: string;
  userId: string;
  phase: 'draft' | 'execute';  // draft = run skill to produce output; execute = apply output (post/send)
}
```

Dispatch is kind-based:

| kind | `draft` phase skill | `execute` phase skill | userAction |
|---|---|---|---|
| `content_post` (x) | `draft-single-post-x` | `x-post` | approve |
| `content_post` (reddit) | `draft-single-post-reddit` | `reddit-submit-post` | approve |
| `content_reply` (x) | `draft-single-reply-x` | `x-post` (reply) | approve |
| `email_send` | `draft-email` | `send-email` | approve |
| `setup_task` (waitlist) | `draft-waitlist-page` | — (user publishes) | approve |
| `interview` | — | — | manual |
| `runsheet_beat` | — (inline params) | kind-specific (post / email / ...) | auto (during launch day) |
| `metrics_compute` | — | `analytics-summarize` or equiv | auto |

### 5.2 Cron workers

| Cron | Job | Action |
|---|---|---|
| Monday 00:00 UTC | `weekly-replan` | Fan-out per user → enqueue tactical-planner |
| Every 1m | `plan-execute-sweeper` | Find plan_items ready for next phase transition, enqueue |
| Every 1h | `stale-sweeper` | Mark `planned` items past `scheduledAt + 24h` as `stale` |

### 5.3 Existing queues — fate

| Queue | Fate |
|---|---|
| `calendar-plan` | **DELETE** — tactical-planner replaces |
| `calendar-slot-draft` | **DELETE** — plan-execute dispatches instead |
| `content` | **DELETE** — was compound; atomic skills called via plan-execute |
| `discovery-scan` / `search-source` | KEEP — discovery is continuous telemetry, not plan output |
| `reddit-discovery` / unified discovery | KEEP |
| `review` | KEEP — runs draft-review on `drafted` items before they surface |
| `posting` | KEEP — plan-execute calls it for `execute` phase |
| `engagement` / `analytics` / `metrics` / `monitor` | KEEP — continuous telemetry |
| `todo-seed` | **DELETE** — `plan_items` is the only todo source |
| `calibrate-discovery` | KEEP |
| `code-scan` | KEEP — produces milestones feeding into planners |
| `voice-extract` | KEEP |

---

## 6. State Machine

```
                    planner emits
                         │
                         ▼
                     ┌──────────┐
                     │ planned  │
                     └──────────┘
           userAction=auto │ │ userAction=approve
             ┌─────────────┘ └──────────────┐
             ▼                               ▼
       ┌──────────┐                    (plan-execute draft)
       │executing │                          │
       └──────────┘                          ▼
             │                         ┌──────────┐
             ▼                         │ drafted  │
       ┌───────────┐                   └──────────┘
       │ completed │                         │
       └───────────┘                         ▼
                                      ┌──────────────────┐
                                      │ ready_for_review │
                                      └──────────────────┘
                                      user approves │ │ user skips
                                     ┌──────────────┘ └─────────┐
                                     ▼                           ▼
                              ┌──────────┐                ┌──────────┐
                              │ approved │                │ skipped  │
                              └──────────┘                └──────────┘
                                     │
                           (plan-execute execute)
                                     ▼
                              ┌──────────┐
                              │executing │
                              └──────────┘
                                     │
                           success ┌─┴─┐ failure
                                   ▼   ▼
                          ┌──────────┐ ┌──────────┐
                          │completed │ │ failed   │
                          └──────────┘ └──────────┘

  ── branches that can happen anytime ──
    any non-terminal state → superseded (tactical re-plan)
    planned past scheduledAt+24h → stale (stale-sweeper cron)
    userAction=manual: planned → completed (user marks done) or skipped
```

Terminal states: `completed`, `skipped`, `failed`, `superseded`, `stale`.

---

## 7. Re-plan Semantics

### 7.1 Tactical re-plan

Scope: `[weekStart, weekStart + 7d)`.

```sql
UPDATE plan_items
SET state = 'superseded', updated_at = now()
WHERE user_id = $1
  AND scheduled_at >= $weekStart
  AND scheduled_at <  $weekStart + interval '7 days'
  AND state IN ('planned', 'drafted', 'ready_for_review')
  AND user_action != 'manual';
```

Then insert new plan_items. Notes:

- `approved / executing / completed / skipped / failed / stale` — untouched
- `manual` items (interviews, setup tasks) — untouched
- Items outside the 7-day window — untouched

### 7.2 Strategic re-plan

Triggered by:
- Onboarding (fresh path)
- User changes `products.state` / `launchDate` / `launchedAt` via Settings

Steps:
1. Set existing `strategic_paths.isActive = false`
2. Run strategic-planner → insert new row with `isActive = true`
3. Immediately trigger tactical re-plan on the new path (scope = current week)

---

## 8. Triggers & Scope Matrix

| Scenario | Strategic runs | Tactical runs | Tactical scope |
|---|---|---|---|
| Onboarding commit | ✓ | ✓ (auto chain) | today → today+7d |
| Monday 00:00 cron | ✗ | ✓ | Monday → Sunday |
| User clicks "re-plan this week" | ✗ | ✓ | today → next Monday |
| User changes phase in Settings | ✓ | ✓ (auto chain) | today → today+7d |
| User changes `launchDate` in Settings | ✓ | ✓ (auto chain) | today → today+7d |

---

## 9. API Changes (vs. 2026-04-19 onboarding spec)

### Keep / unchanged

- `POST /api/onboarding/extract`, `/extract-repo`, `GET /github-repos`
- `GET / PUT / DELETE /api/onboarding/draft`

### Replaced

- `POST /api/onboarding/plan` (was single-planner) →
  `POST /api/onboarding/strategic-plan` (runs strategic, returns path) +
  `POST /api/onboarding/tactical-plan` (runs tactical on path, returns plan)

  Or: keep a single `POST /api/onboarding/plan` that runs both back-to-back
  and returns `{ path, plan }`. **Recommendation: single endpoint**, the
  two-step split is an internal detail.

- `POST /api/onboarding/commit` — writes products row + strategic_path +
  plan + plan_items + triggers activation. Schema delta:

  ```ts
  // Request (delta from 2026-04-19 spec)
  {
    product: {...},          // unchanged
    state, launchDate, launchedAt,
    path: StrategicPathOutput,   // NEW — user-edited Section A produces path edits
    plan: TacticalPlanOutput,    // NEW — user-edited Section C produces items edits
  }
  ```

### New

- `POST /api/plan/replan` — user-triggered tactical re-plan (auth required)
- `POST /api/product/phase` — user updates phase; triggers strategic chain
- `POST /api/plan-item/:id/approve`, `/skip`, `/complete` — Today card actions

### Deleted

- All endpoints referenced by old `xContentCalendar` / `todoItems` UIs
  (replaced by `plan_items` endpoints)

---

## 10. Migration / Rollout

Large PR, one atomic change. Product isn't launched — clean cut.

1. **Schema migration** — single SQL file: add columns, drop tables,
   create new tables + enums.
2. **Helpers** — `src/lib/launch-phase.ts`, `src/lib/plan-execute-dispatch.ts`,
   `src/lib/re-plan.ts`.
3. **Agent deletions** — remove `calendar-planner.md`, `scout.md`,
   `analyst.md`, `content.md`, their skills.
4. **Agent additions** — `strategic-planner.md`, `tactical-planner.md`
   with the reference docs in `src/skills/strategic-planner/references/`
   and `src/skills/tactical-planner/references/`.
5. **Atomic skill extraction** — split `content-gen` / `community-intel` /
   etc. into the atomic units listed in §4.2.
6. **Skill catalog** — `src/skills/_catalog.ts` auto-generated from
   SKILL.md frontmatter.
7. **Queue refactor** — delete old queues, add `plan-execute` queue,
   wire Monday cron + sweepers.
8. **API layer** — update `/api/onboarding/*`, add `/api/plan-item/:id/*`,
   add `/api/plan/replan`, add `/api/product/phase`.
9. **Caller refactor** — every site reading `lifecyclePhase` →
   `state` + `derivePhase()`. Every site reading `xContentCalendar` /
   `todoItems` / `weeklyThemes` → `plan_items` + `strategic_paths`.
10. **`scripts/seed-user.ts`** — creates a user + product + active path +
    one week of plan_items end-to-end for dogfood.
11. **Frontend** — uses new endpoints. Today / Calendar / weekly views
    rewritten against `plan_items`.

---

## 11. Testing

- Unit: `derivePhase`, `supersedeScope`, state-machine transitions
- Agent: `strategic-planner.test.ts` (path validity, schema, channel
  filtering); `tactical-planner.test.ts` (items match channelMix, dedupe
  against completedLastWeek, skill names in catalog)
- Integration: `/api/onboarding/commit` end-to-end writes all three
  tables atomically; `plan-execute-sweeper` transitions states correctly;
  tactical re-plan supersedes only in-scope items
- E2E: deferred to frontend PR

---

## 12. Deferred (explicitly NOT in v1)

- Reactive mini-planner for incidents (tweet goes viral, bad review) —
  Arch A-style overlay on top of B. Revisit after v1 soak.
- Launch-day trigger as a 4th auto trigger (auto-run strategic+tactical
  when `scheduledAt` of a `runsheet_beat` arrives). V1 just generates
  runsheet items during the Momentum phase; execution is plan-execute.
- Multi-product per user. V1 keeps one-product-per-user unique index.
- Locale / language. English only for v1.
- Custom user-authored skills. V1 ships a fixed catalog.

---

## 13. Decisions log

| Decision | Value | Ref |
|---|---|---|
| Architecture | Arch B (planner-as-composer) | §1 |
| Planner tiers | Two: strategic + tactical | §3 |
| Plan schema | Shape A (polymorphic `plan_items`) | §2.4 |
| Triggers | Onboarding + Monday cron + manual + phase-change | §8 |
| Re-plan window | Tactical: 7d sliding; Strategic: full arc | §7 |
| Content calendar | Merged into `plan_items` | §4 |
| Reply queue (todoItems) | Merged into `plan_items` (kind=content_reply) | §2.4 |
| One executor queue | Yes (`plan-execute`) replacing many | §5 |
| Strategic model | Sonnet 4.6 | §3.2 |
| Tactical model | Haiku 4.5 | §3.3 |
| Migration strategy | Single clean migration, no dual-write | §10 |
