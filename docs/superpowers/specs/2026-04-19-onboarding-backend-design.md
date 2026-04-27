# Onboarding Redesign — Backend Spec

**Date:** 2026-04-19
**Status:** PARTIALLY SUPERSEDED by
`docs/superpowers/specs/2026-04-20-planner-and-skills-redesign-design.md`.

The 2026-04-20 doc is the canonical design for planner / skill /
`plan_items` schema. This file still stands for the onboarding-surface
details not re-covered there: the Redis draft state (§5), the
`/extract` / `/extract-repo` routes (§4.2), the `scripts/seed-user.ts`
plan (§12 step 7), and the `derivePhase` helper (§2).

Where this doc and 2026-04-20 conflict (launch-planner skill,
`launch_tasks` table, single-endpoint plan/commit shape), follow 2026-04-20.

**Sibling:** `docs/superpowers/specs/2026-04-19-onboarding-redesign-design.md` (full flow)

Product hasn't launched. We don't keep backwards-compatibility shims,
dual-column windows, or deprecated endpoints. This spec rips out the old
onboarding surface and replaces it with the new one in a single clean pass.

The interim window (backend done, new UI not yet shipped) is expected to
leave `/onboarding` in a broken state. Local dogfooding during that window
uses `scripts/seed-user.ts` (added as part of this work).

---

## Summary of backend deltas

1. **Schema:** rename `products.lifecyclePhase` → `products.state`,
   remap values, add columns, drop the old column in the same migration.
   Add new `launch_tasks` table.
2. **Agents:** new `launch-planner` skill emits `productUnderstanding +
   phaseMap + firstWeekTasks`. All 29 existing `lifecyclePhase` callers
   switch to `state + derivePhase()` in one atomic PR.
3. **API:** delete `PUT /api/onboarding/profile`, delete `PUT
   /api/product/phase`. Add `POST /api/onboarding/plan` (run planner,
   stateless) and `POST /api/onboarding/commit` (one endpoint writes
   product, launch_tasks, triggers calibration, fires activation).
4. **Onboarding draft state:** held in Redis under
   `onboarding:{userId}` with 1h TTL so it survives the OAuth round-trip.
   No partial product rows in Postgres.
5. **Queues / workers:** no new queues. Planner runs synchronously in the
   API handler with a 45s hard timeout.

---

## 1. Schema changes

### 1.1 `products` table

```diff
 products {
   id               text pk
   userId           text fk users.id
   url              text
   name             text          not null
   description      text          not null
   keywords         text[]        not null default []
   valueProp        text
-  lifecyclePhase   text          not null default 'pre_launch'
+  state            text          not null default 'mvp'
+  launchDate       timestamp
+  launchedAt       timestamp
+  targetAudience   text
+  category         text
+  onboardingCompletedAt timestamp
   seoAuditJson     jsonb
   createdAt        timestamp     not null default now()
   updatedAt        timestamp     not null default now()
 }
```

Removed from earlier draft:

- `onboardingSkippedChannels` — redundant. Derive at query time from
  `SELECT COUNT(*) FROM channels WHERE user_id = ? AND platform IN (enabled)`.

### State values

| `state` | Meaning | `launchDate` | `launchedAt` |
|---|---|---|---|
| `'mvp'` | Still building, no firm date | optional (rough target) | — |
| `'launching'` | Date set, T-offset-driven plan | **required** | — |
| `'launched'` | Shipped | — | **required** |

### 1.2 `launch_tasks` table (NEW)

Distinct from `todoItems` (approve/reject queue for drafts).
`launch_tasks` are launch-lifecycle checklist items — "Run 5 interviews",
"Draft waitlist copy", "Reach out to 20 early supporters".

```ts
export const launchPhaseEnum = pgEnum('launch_phase', [
  'foundation', 'audience', 'momentum', 'launch', 'compound', 'steady',
]);

export const launchTaskKindEnum = pgEnum('launch_task_kind', [
  'content', 'setup', 'interview', 'email', 'analytics',
]);

export const launchTasks = pgTable('launch_tasks', {
  id: text('id').primaryKey().$defaultFn(() => crypto.randomUUID()),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  productId: text('product_id').notNull().references(() => products.id, { onDelete: 'cascade' }),
  phase: launchPhaseEnum('phase').notNull(),
  title: text('title').notNull(),
  description: text('description'),
  channel: text('channel'),              // null = channel-agnostic
  suggestedDate: timestamp('suggested_date', { mode: 'date' }),
  kind: launchTaskKindEnum('kind').notNull(),
  completedAt: timestamp('completed_at', { mode: 'date' }),
  createdAt: timestamp('created_at', { mode: 'date' }).defaultNow().notNull(),
}, (t) => [
  index('launch_tasks_user_idx').on(t.userId),
  index('launch_tasks_product_phase_idx').on(t.productId, t.phase),
]);
```

Removed from earlier draft:

- `enabled` boolean — if the user unchecks a task in Step 4 Section C, we
  just don't insert it. No audit trail needed.

### 1.3 Single migration

```sql
-- 0001_launch_state.sql

-- products: add new columns
ALTER TABLE products ADD COLUMN state text;
ALTER TABLE products ADD COLUMN launch_date timestamp;
ALTER TABLE products ADD COLUMN launched_at timestamp;
ALTER TABLE products ADD COLUMN target_audience text;
ALTER TABLE products ADD COLUMN category text;
ALTER TABLE products ADD COLUMN onboarding_completed_at timestamp;

-- Backfill state from lifecycle_phase (rough best-effort for dev data)
UPDATE products SET state = 'mvp'                               WHERE lifecycle_phase = 'pre_launch';
UPDATE products SET state = 'launched', launched_at = created_at WHERE lifecycle_phase IN ('launched','scaling');

-- Mark all existing products as onboarded (they completed the old flow)
UPDATE products SET onboarding_completed_at = created_at WHERE onboarding_completed_at IS NULL;

ALTER TABLE products ALTER COLUMN state SET NOT NULL;
ALTER TABLE products ALTER COLUMN state SET DEFAULT 'mvp';

-- Drop the old column — no dual-read window
ALTER TABLE products DROP COLUMN lifecycle_phase;

-- launch_tasks
CREATE TYPE launch_phase AS ENUM ('foundation','audience','momentum','launch','compound','steady');
CREATE TYPE launch_task_kind AS ENUM ('content','setup','interview','email','analytics');
CREATE TABLE launch_tasks (
  id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  product_id text NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  phase launch_phase NOT NULL,
  title text NOT NULL,
  description text,
  channel text,
  suggested_date timestamp,
  kind launch_task_kind NOT NULL,
  completed_at timestamp,
  created_at timestamp NOT NULL DEFAULT now()
);
CREATE INDEX launch_tasks_user_idx ON launch_tasks(user_id);
CREATE INDEX launch_tasks_product_phase_idx ON launch_tasks(product_id, phase);
```

---

## 2. Derived value — `currentPhase`

`state` is user input. `currentPhase` (the 6-value enum) is what planner
outputs and downstream agents consume. Don't store it — compute at read
time from `(state, launchDate, launchedAt, today)`.

```ts
// src/lib/launch-phase.ts (NEW)

export type LaunchPhase =
  | 'foundation' | 'audience' | 'momentum' | 'launch' | 'compound' | 'steady';

export function derivePhase(input: {
  state: 'mvp' | 'launching' | 'launched';
  launchDate: Date | null;
  launchedAt: Date | null;
  now?: Date;
}): LaunchPhase {
  const now = input.now ?? new Date();

  if (input.state === 'launched') {
    if (!input.launchedAt) return 'steady';
    const daysSince = (now.getTime() - input.launchedAt.getTime()) / 86400_000;
    return daysSince <= 30 ? 'compound' : 'steady';
  }

  // state ∈ { 'mvp', 'launching' }
  if (!input.launchDate) return 'foundation';

  const daysToLaunch = (input.launchDate.getTime() - now.getTime()) / 86400_000;
  if (daysToLaunch <= 0)  return 'launch';
  if (daysToLaunch <= 7)  return 'momentum';
  if (daysToLaunch <= 28) return 'audience';
  return 'foundation';
}
```

### 2.1 Agent prompt updates

Agents that currently reference `lifecyclePhase`
(`calendar-planner.md`, `content.md`, `slot-body-agent.md`) switch to:

- `{{currentPhase}}` — passed from caller after running `derivePhase()`
- `{{state}}`, `{{daysToLaunch}}`, `{{daysSinceLaunch}}` — added context

`src/references/lifecycle-phases.md` is replaced by
`src/references/launch-phases.md` with the 6-phase taxonomy. The old file
is deleted — no redirect stub.

---

## 3. New agent — `launch-planner`

### Location

- `src/skills/launch-planner/SKILL.md`
- `src/skills/launch-planner/references/task-templates.md` — per-phase anchor library
- `src/skills/launch-planner/references/category-playbooks.md` — per-category nuances
- `src/agents/launch-planner.md` — system prompt

### Input

```ts
interface LaunchPlannerInput {
  product: {
    name: string;
    description: string;
    valueProp: string | null;
    keywords: string[];
    url: string | null;
    seoAudit: Record<string, unknown> | null;
  };
  channels: Array<'x' | 'reddit' | 'linkedin' | string>;
  state: 'mvp' | 'launching' | 'launched';
  launchDate: string | null;
  launchedAt: string | null;
}
```

Note: input does **not** take `productId`. Planner is stateless — it runs
before any DB write. Caller passes the in-memory extraction result.

### Output (validated via Zod in `src/agents/schemas.ts`)

```ts
interface LaunchPlannerOutput {
  productUnderstanding: {
    name: string;
    tagline: string;
    valueProp: string;
    keywords: string[];
    targetAudience: string;
    category: 'dev_tool' | 'saas' | 'consumer' | 'creator_tool' | 'agency' | 'ai_app' | 'other';
  };
  phaseMap: {
    current: LaunchPhase;
    timelineVisible: boolean;   // false for state='mvp' && !launchDate
    daysToLaunch: number | null;
    daysSinceLaunch: number | null;
  };
  firstWeekTasks: Array<{
    id: string;                 // uuid minted by agent
    title: string;
    description: string;
    phase: LaunchPhase;
    channel: string | null;
    suggestedDate: string;      // ISO within next 7 days
    kind: 'content' | 'setup' | 'interview' | 'email' | 'analytics';
  }>;
}
```

`category` is a Zod-validated string union, not a pg enum. Easier to
evolve before we lock the set.

### Task-template strategy (hybrid)

Agent picks 7–10 tasks. Each phase has an anchor library in
`references/task-templates.md`:

- **Foundation:** positioning statement, OMTM, 5 interviews, waitlist page
  live, landing copy draft, email sequence v1
- **Audience:** build-in-public 70/30 reply strategy, IH milestone,
  LinkedIn narrative thread, early-access tier
- **Momentum:** hunter lock-in, countdown content, launch-day crew list,
  asset kit (PH gallery, 30s video), A/B email subjects
- **Launch:** maker comment draft, run-of-show, live data screenshots,
  thank-you thread
- **Compound:** retro long-form, warm-leads outreach, user-story content,
  D7 NPS, secondary-platform launches
- **Steady:** ongoing content cadence, NPS D30, community contributions

Agent rules:

- Must include at least one task of each `kind` that the phase's library has
- Exclude `channel != null` tasks when `channels` doesn't include that channel
- When `channels` is empty, emit only `kind ∈ {setup, interview, email, analytics}`
- `suggestedDate` evenly distributed across 7 days, weekends de-prioritized

### Runner

Reuses the existing skill-runner pattern:

```ts
// inside POST /api/onboarding/plan
const skill = loadSkill(join(process.cwd(), 'src/skills/launch-planner'));
const result = await runSkill({
  skill,
  input,
  outputSchema: launchPlannerOutputSchema,
  traceId,
  maxRounds: 2,
});
```

No `deps` needed — planner is a pure LLM call.

### Language

English-only for v1. Locale input deferred — the planner prompt doesn't
ship with a locale slot.

---

## 4. API changes

### 4.1 Delete

- `PUT /api/onboarding/profile` — old 3-step flow only. Gone.
- `PUT /api/product/phase` — state now set in commit. Gone.

Delete the route files entirely. Delete their tests. Delete client code
that references them (the current `ProfileReviewStep` call site).

### 4.2 Keep (unchanged)

- `POST /api/onboarding/extract` — URL scrape + AI analysis
- `POST /api/onboarding/extract-repo` — SSE stream for GitHub scan
- `GET /api/onboarding/github-repos` — list user's repos

These all return `ExtractedProfile` (or similar) **without touching the DB**.
Caller keeps the result in memory (client state) plus mirrors it into
Redis draft state (see §5).

### 4.3 `POST /api/onboarding/plan` — NEW

Runs the launch-planner agent synchronously. Stateless.

```ts
// Request
{
  product: ExtractedProfile;       // from /extract or /extract-repo
  channels: string[];              // from session's connected channels
  state: 'mvp' | 'launching' | 'launched';
  launchDate: string | null;
  launchedAt: string | null;
}

// Response (200)
LaunchPlannerOutput

// Response (504 timeout)
{ error: 'planner_timeout' }
```

- **Auth:** signed-in user required
- **Timeout:** 45s via `AbortController` → 504
- **Rate limit:** 1 call / 10s / user (Redis `SET NX EX`)
- **Observability:** `pipeline_events` row `kind='launch_plan'`
- **No DB writes**

### 4.4 `POST /api/onboarding/commit` — NEW

Single endpoint that writes product + launch_tasks + triggers calibration
and activation. Transition from "in-progress" to "onboarded".

```ts
// Request
{
  product: {                             // section A edits folded in
    url: string | null;
    name: string;
    description: string;                 // aka tagline
    valueProp: string;
    keywords: string[];
    targetAudience: string;
    category: string;
    seoAudit: Record<string, unknown> | null;
    ogImage: string | null;
  };
  state: 'mvp' | 'launching' | 'launched';
  launchDate: string | null;
  launchedAt: string | null;
  tasks: Array<Omit<LaunchPlannerTask, never>>;  // only the enabled ones
}

// Response
{
  success: true;
  productId: string;
  enqueued: string[];       // platforms whose calendar-plan fired
}
```

### Validation

- `state='launching'` requires `launchDate` in `[today+7d, today+90d]`
- `state='launched'` requires `launchedAt` in `[today-3y, today]`
- `state='mvp'` — `launchedAt` must be null; `launchDate` if present must
  be in `[today+1d, today+365d]`
- If `state='mvp'` and `launchDate` is in the past: **reject with 400**.
  Client warns before submit, server enforces.

### Transaction shape

```ts
const productId = await db.transaction(async (tx) => {
  // 1. Upsert product
  const [row] = await tx.insert(products).values({
    userId,
    url:             input.product.url,
    name:            input.product.name,
    description:     input.product.description,
    keywords:        input.product.keywords,
    valueProp:       input.product.valueProp,
    state:           input.state,
    launchDate:      input.launchDate ? new Date(input.launchDate) : null,
    launchedAt:      input.launchedAt ? new Date(input.launchedAt) : null,
    targetAudience:  input.product.targetAudience,
    category:        input.product.category,
    onboardingCompletedAt: new Date(),
    seoAuditJson:    input.product.seoAudit,
  })
  .onConflictDoUpdate({
    target: products.userId,   // assumes one product per user; add unique idx
    set: { /* all fields from above */ updatedAt: new Date() },
  })
  .returning({ id: products.id });

  // 2. Insert launch_tasks
  if (input.tasks.length > 0) {
    await tx.insert(launchTasks).values(
      input.tasks.map((t) => ({ userId, productId: row.id, ...t })),
    );
  }

  return row.id;
});

// Outside the transaction — enqueue failures must not roll back the commit
await maybeEnqueueCalibration(userId, productId);
const { enqueued } = await activatePostOnboarding();

return { success: true, productId, enqueued };
```

### `products.user_id` unique constraint

The old schema allows multiple products per user (it doesn't enforce
uniqueness). The new flow assumes one product per user. Add a unique index
in the migration:

```sql
CREATE UNIQUE INDEX products_user_uq ON products(user_id);
```

This matches how `onConflictDoUpdate(target: userId)` is wired above.

---

## 5. Onboarding draft state in Redis

During steps 1 → 4, the user's extracted profile, selected state, and
launch dates live only in **client state + Redis**, not Postgres. The
Redis draft survives the OAuth round-trip (`/api/x/connect` → twitter.com
→ `/api/x/callback` → back to `/onboarding`), which wipes client state.

```ts
// Redis key: `onboarding:${userId}`
// TTL: 1 hour (rolling — refreshed on every write)

interface OnboardingDraft {
  product: ExtractedProfile | null;
  state: 'mvp' | 'launching' | 'launched' | null;
  launchDate: string | null;
  launchedAt: string | null;
  // tasks are never stored here — only exist in memory between /plan and /commit
  updatedAt: string;
}
```

Endpoints:

- `GET /api/onboarding/draft` — returns current draft or `null`
- `PUT /api/onboarding/draft` — upserts (merges into existing)
- `DELETE /api/onboarding/draft` — called by `/commit` after success

On page load, the client calls `GET /draft` to resume. After OAuth
callback redirects back, the client re-fetches `GET /draft` to restore
the extracted profile.

---

## 6. `activatePostOnboarding` — relocation

Today: called from `src/app/actions/activation.ts` by the onboarding
page's `handleComplete`.

New: called from `/api/onboarding/commit` after the transaction commits.

No logic change inside the function. **Delete** the call from
`src/app/onboarding/page.tsx` — that page will be rewritten by the
frontend PR anyway.

---

## 7. Queue / worker changes

**None.** Reuses:

- `calendar-plan` — fired by `activatePostOnboarding`
- `calibrate-discovery` — fired by `maybeEnqueueCalibration` inside
  `/commit`
- `code-scan` — still fired by `/api/onboarding/extract-repo` in Step 1

If we later make the planner asynchronous, add a `launch-plan` queue.
Not in v1.

---

## 8. Data flow — full onboarding sequence

```
[User hits /onboarding]
  ├─ GET /api/onboarding/draft                 (resume if any)
  │
  ├─ Step 1: POST /api/onboarding/extract
  │   OR     POST /api/onboarding/extract-repo (SSE)
  │   └─ returns ExtractedProfile (client state)
  │   └─ PUT /api/onboarding/draft (mirror to Redis)
  │
  ├─ Step 2: OAuth redirect to /api/{x,reddit}/callback
  │   └─ writes channels row (no product row yet)
  │   └─ redirects back to /onboarding
  │   └─ client re-reads GET /draft to restore state
  │
  ├─ Step 3: (client-only) user picks state + launchDate
  │   └─ PUT /api/onboarding/draft (mirror selection)
  │
  ├─ Step 4 loading: POST /api/onboarding/plan
  │   └─ runs launch-planner synchronously (5–15s)
  │   └─ returns LaunchPlannerOutput (client state)
  │
  └─ Step 4 confirm: POST /api/onboarding/commit
      ├─ tx: upsert products + insert launch_tasks
      ├─ maybeEnqueueCalibration()
      ├─ activatePostOnboarding() → calendar-plan per platform
      ├─ DELETE /api/onboarding/draft
      └─ returns { productId, enqueued }

[Redirect to /today?from=onboarding]
  └─ polls for calibrate-discovery + calendar-plan job completion
```

---

## 9. Auth, security, data-access

- Every endpoint: `auth()` → `session.user.id`; 401 if missing
- Every `productId` arriving from the client: verify ownership first
- `launch_tasks` always scoped by `userId = session.user.id`
- No token columns touched in these paths — existing CLAUDE.md rule holds
- Rate limits:
  - `POST /api/onboarding/plan` — 1 / 10s / user
  - `POST /api/onboarding/commit` — 1 / minute / user
  - `GET/PUT /api/onboarding/draft` — 10 / second / user (interactive)

---

## 10. Observability

- `pipeline_events` rows:
  - `kind='launch_plan', status='started' | 'completed' | 'failed'`
  - `kind='onboarding_commit', status='started' | 'completed' | 'failed'`
- Structured log fields: `userId`, `state`, `channels`, `currentPhase`,
  `taskCount`, `durationMs`, `traceId`
- `traceId` threads from `/plan` call → planner runSkill → `/commit`
  → downstream calendar-plan jobs

---

## 11. Tests

### Unit

- `src/lib/launch-phase.test.ts` — `derivePhase` table-driven tests
  covering boundaries (T-0, T-7, T-28, T+30) and all state×date permutations
- Zod schemas for API payloads — reject invalid state+date combos
  (past launchDate with `state='mvp'`, missing launchedAt with
  `state='launched'`, etc.)

### Agent

- `src/agents/__tests__/launch-planner.test.ts` — assert
  `outputSchema` validity, task diversity by `kind`, channel-filter
  behavior, empty-channels degradation

### Integration

- `src/app/api/onboarding/plan/__tests__/route.test.ts` — mock planner,
  assert 45s timeout surfaces as 504, rate-limit returns 429
- `src/app/api/onboarding/commit/__tests__/route.test.ts` — assert
  transaction atomicity (product + launch_tasks), activation fires
  outside the transaction, Redis draft is deleted on success

### E2E

Deferred until new UI lands. Use `scripts/seed-user.ts` for dogfood
testing during the backend-only window.

---

## 12. Rollout order

1. **Migration** — single SQL file. Rename + backfill + drop in one pass.
2. **`derivePhase` helper + `launch-phases.md` reference doc**. Delete
   the old `lifecycle-phases.md`.
3. **Refactor the 29 `lifecyclePhase` callers.** One PR — agents,
   routes, workers, tests, prompts. Big diff, no dual-read window.
4. **`launch-planner` skill + agent**. Verifiable via
   `scripts/test-launch-plan.ts`.
5. **Delete `/api/onboarding/profile` and `/api/product/phase`**. Breaks
   the current UI intentionally — the old onboarding page is going
   away anyway.
6. **Add `/api/onboarding/plan`, `/api/onboarding/commit`, and
   `/api/onboarding/draft` (GET/PUT/DELETE)**.
7. **`scripts/seed-user.ts`** — creates a user + product + channels +
   launch_tasks entirely via SQL so the dev can keep dogfooding while
   the new UI is being built.
8. **Frontend lands later** via the new UI PR. Wires up the 4-step
   flow against the new endpoints.

---

## 13. Decisions (closed)

| Question | Decision |
|---|---|
| `launchDate` upper bound | 90 days for `state='launching'`, 365 days for `state='mvp'` |
| Past `launchDate` with `state='mvp'` | Server rejects with 400; client warns before submit |
| Task-template language | English only for v1 |
| `category` column type | `text` + Zod-validated string union. Revisit after 3 months |
| Migration strategy | Single migration, no dual-column window |
| Product row timing | Only in `/commit`. Interim draft in Redis |
| `onboardingSkippedChannels` column | Not needed — derive from `channels` table at read time |
| `launch_tasks.enabled` column | Not needed — don't insert unchecked tasks |
| `products.user_id` unique | Add unique index in the migration |
