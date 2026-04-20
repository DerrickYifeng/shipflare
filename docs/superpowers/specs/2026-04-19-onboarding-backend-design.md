# Onboarding Redesign — Backend Spec

**Date:** 2026-04-19
**Status:** Backend only. Frontend deferred until design lands.
**Sibling:** `docs/superpowers/specs/2026-04-19-onboarding-redesign-design.md` (full flow)

This doc is the backend-only slice. Ship this without touching the current
onboarding UI — the old 3-step flow keeps working against the new schema
until the new UI is ready.

---

## Summary of backend deltas

1. **Schema:** rename `products.lifecyclePhase` → `products.state` with value
   remap + new columns (`launchDate`, `launchedAt`, `targetAudience`,
   `category`, `onboardingCompletedAt`, `onboardingSkippedChannels`). Add
   new `launch_tasks` table.
2. **Agents:** new `launch-planner` skill that emits `productUnderstanding`,
   `phaseMap`, and `firstWeekTasks` from product + channels + state + dates.
   Existing agents that currently consume `lifecyclePhase` get updated to
   read `state` + a computed `currentPhase`.
3. **API:** extend `PATCH /api/product/phase` (accept new fields), add
   `POST /api/onboarding/plan` (run planner), add
   `POST /api/onboarding/tasks/commit` (persist selected tasks + finish
   onboarding + enqueue downstream jobs).
4. **Activation:** `activatePostOnboarding` moves from the "step-3 onComplete"
   hook into `/api/onboarding/tasks/commit`. Same Redis lock, same
   `calendar-plan` fan-out — just a different trigger point.
5. **Queues / workers:** no new queues. Planner runs **synchronously inside
   the API handler** (5–15s expected), with a 45s hard timeout.

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
+  launchDate       timestamp                                -- NEW, for state='launching' or 'mvp' with target
+  launchedAt       timestamp                                -- NEW, for state='launched'
+  targetAudience   text                                     -- NEW, planner-inferred / user-edited
+  category         text                                     -- NEW, enum-shaped string
+  onboardingCompletedAt timestamp                           -- NEW, null until tasks/commit succeeds
+  onboardingSkippedChannels boolean not null default false  -- NEW
   seoAuditJson     jsonb
   createdAt        timestamp     not null default now()
   updatedAt        timestamp     not null default now()
 }
```

### State values

| New `state` | Meaning | `launchDate` | `launchedAt` |
|---|---|---|---|
| `'mvp'` | Still building, no firm date | optional (rough target) | — |
| `'launching'` | Date set, T-offset-driven plan | **required** | — |
| `'launched'` | Shipped | — | **required** |

### Value remap (migration)

| Old `lifecyclePhase` | New `state` | Derived fields |
|---|---|---|
| `'pre_launch'` | `'mvp'` | `launchDate = null` (we don't have one on file) |
| `'launched'` | `'launched'` | `launchedAt = products.createdAt` (best guess) |
| `'scaling'` | `'launched'` | `launchedAt = products.createdAt` (best guess) |

For any existing product: `onboardingCompletedAt = products.createdAt`
(they already went through the old onboarding).

### 1.2 `launch_tasks` table (NEW)

Distinct from `todoItems` (which is an approve/reject queue for drafts).
`launch_tasks` are launch-lifecycle checklist items: "Run 5 interviews",
"Draft waitlist copy", "Reach out to 20 early supporters". Can grow into a
user-visible task board later.

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
  enabled: boolean('enabled').notNull().default(true),
  completedAt: timestamp('completed_at', { mode: 'date' }),
  createdAt: timestamp('created_at', { mode: 'date' }).defaultNow().notNull(),
}, (t) => [
  index('launch_tasks_user_idx').on(t.userId),
  index('launch_tasks_product_phase_idx').on(t.productId, t.phase),
]);
```

### 1.3 Drizzle migration sketch

```sql
-- 0001_launch_state.sql
ALTER TABLE products ADD COLUMN state text;
ALTER TABLE products ADD COLUMN launch_date timestamp;
ALTER TABLE products ADD COLUMN launched_at timestamp;
ALTER TABLE products ADD COLUMN target_audience text;
ALTER TABLE products ADD COLUMN category text;
ALTER TABLE products ADD COLUMN onboarding_completed_at timestamp;
ALTER TABLE products ADD COLUMN onboarding_skipped_channels boolean NOT NULL DEFAULT false;

-- Backfill state from lifecycle_phase
UPDATE products SET state = 'mvp',      launched_at = NULL          WHERE lifecycle_phase = 'pre_launch';
UPDATE products SET state = 'launched', launched_at = created_at    WHERE lifecycle_phase = 'launched';
UPDATE products SET state = 'launched', launched_at = created_at    WHERE lifecycle_phase = 'scaling';

-- Mark existing products as onboarded
UPDATE products SET onboarding_completed_at = created_at WHERE onboarding_completed_at IS NULL;

ALTER TABLE products ALTER COLUMN state SET NOT NULL;
ALTER TABLE products ALTER COLUMN state SET DEFAULT 'mvp';

-- Drop the old column AFTER all 29 callers are updated (do in separate migration)
-- ALTER TABLE products DROP COLUMN lifecycle_phase;

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
  enabled boolean NOT NULL DEFAULT true,
  completed_at timestamp,
  created_at timestamp NOT NULL DEFAULT now()
);
CREATE INDEX launch_tasks_user_idx ON launch_tasks(user_id);
CREATE INDEX launch_tasks_product_phase_idx ON launch_tasks(product_id, phase);
```

### 1.4 Two-migration rollout (safer)

1. **Migration A** — additive only: add `state` and all new columns, backfill,
   but keep `lifecycle_phase`. Deploy.
2. **Code change** — update all 29 callers to read `state` instead of
   `lifecyclePhase`. Dual-write in `/api/onboarding/profile` and
   `/api/product/phase` so old and new stay in sync.
3. **Migration B** — drop `lifecycle_phase`. Deploy.

If we trust the feedback memory ("refactor freely during v2 migration"), we
can collapse A + B into one migration. **Recommendation: collapse.** The
codebase isn't in prod-scale yet and the dual-column window adds more risk
than it removes.

---

## 2. Derived value — `currentPhase`

`state` is user input. `currentPhase` is what the planner outputs and what
downstream agents (content / slot-body) consume. Don't store it — compute
from `(state, launchDate, launchedAt, today)`.

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

  if (input.state === 'mvp') {
    if (!input.launchDate) return 'foundation';
    // Fall through to date-based derivation
  }

  if (input.state === 'launched') {
    if (!input.launchedAt) return 'steady';
    const daysSince = (now.getTime() - input.launchedAt.getTime()) / 86400_000;
    if (daysSince <= 30) return 'compound';
    return 'steady';
  }

  // state === 'launching' OR state === 'mvp' with launchDate
  if (!input.launchDate) return 'foundation';
  const daysToLaunch = (input.launchDate.getTime() - now.getTime()) / 86400_000;
  if (daysToLaunch <= 0) return 'launch';           // launch day or past
  if (daysToLaunch <= 7) return 'momentum';
  if (daysToLaunch <= 28) return 'audience';
  return 'foundation';
}
```

This helper replaces every `lifecyclePhase` read in the 29 existing callers.
Most call sites become:

```ts
const phase = derivePhase({
  state: product.state,
  launchDate: product.launchDate,
  launchedAt: product.launchedAt,
});
```

### 2.1 Agent prompt updates

Agents that currently reference `lifecyclePhase` in their system prompt
template variables (`calendar-planner.md`, `content.md`,
`slot-body-agent.md`) need updated variables:
- `{{lifecyclePhase}}` → `{{currentPhase}}` (pass derived value)
- Add `{{state}}`, `{{daysToLaunch}}`, `{{daysSinceLaunch}}` for richer context

`src/references/lifecycle-phases.md` gets renamed to
`src/references/launch-phases.md` with the 6-phase taxonomy.

---

## 3. New agent — `launch-planner`

### Location

- `src/skills/launch-planner/SKILL.md`
- `src/skills/launch-planner/references/task-templates.md` (per-phase library)
- `src/skills/launch-planner/references/category-playbooks.md` (per-category nuances)
- `src/agents/launch-planner.md` (agent system prompt)

### Input

```ts
interface LaunchPlannerInput {
  product: {
    id: string;
    name: string;
    description: string;
    valueProp: string | null;
    keywords: string[];
    url: string | null;
    seoAudit: Record<string, unknown> | null;
  };
  channels: Array<'x' | 'reddit' | 'linkedin' | ...>;
  state: 'mvp' | 'launching' | 'launched';
  launchDate: string | null;
  launchedAt: string | null;
  skippedChannels: boolean;
}
```

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
    timelineVisible: boolean;   // false for state=mvp && !launchDate
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

### Task-template strategy (hybrid)

Agent must pick 7–10 tasks. Each phase has an anchor library in
`references/task-templates.md`:

- **Foundation (mvp / pre-launch early):** positioning statement, OMTM,
  5 interviews, waitlist page live, landing copy draft, email sequence v1
- **Audience (T-28 ~ T-7):** build-in-public 70/30 reply strategy,
  Indie Hackers milestone, LinkedIn narrative thread, early-access tier
- **Momentum (T-7 ~ T-1):** hunter lock-in, countdown content, launch-day
  crew list, asset kit (PH gallery, 30s video), A/B email subjects
- **Launch (T-0):** maker comment draft, run-of-show, live data screenshots,
  thank-you thread
- **Compound (T+1 ~ T+30):** retro long-form, warm-leads outreach, user-story
  content, D7 NPS, secondary-platform launches
- **Steady (T+30+):** ongoing content cadence, NPS D30, community
  contributions

Agent rules:
- Must include at least one task of each `kind` where the phase has one
- Exclude `channel != null` tasks when `channels` doesn't include that channel
- When `skippedChannels = true`, emit only `kind ∈ {setup, interview, email, analytics}`
- `suggestedDate` evenly distributed across 7 days, weekends de-prioritized

### Runner

Reuses the existing skill-runner pattern:

```ts
// Inside POST /api/onboarding/plan
const skill = loadSkill(join(process.cwd(), 'src/skills/launch-planner'));
const result = await runSkill({
  skill,
  input,
  outputSchema: launchPlannerOutputSchema,
  traceId,
  maxRounds: 2,         // product understanding + task gen
});
```

No `deps` needed — planner is a pure LLM call, no tool use.

---

## 4. API changes

### 4.1 `PATCH /api/product/phase` — extend

Current path is `PUT` with `{ lifecyclePhase }`. Migrate to `PATCH` with
the new payload shape (keep `PUT` as alias for one release).

```ts
// Request
{
  state: 'mvp' | 'launching' | 'launched';
  launchDate?: string | null;       // ISO, required when state='launching'
  launchedAt?: string | null;       // ISO, required when state='launched'
}

// Response
{ success: true; state; launchDate; launchedAt }
```

Validation:
- `state='launching'` requires `launchDate` in `[today+7d, today+90d]`
- `state='launched'` requires `launchedAt` in `[today-3y, today]`
- `state='mvp'` accepts `launchDate` optionally; `launchedAt` must be null

Does NOT trigger any enqueue. Purely writes product row.

### 4.2 `POST /api/onboarding/plan` — NEW

Runs the launch-planner agent synchronously.

```ts
// Request
{ productId: string }

// Response (success)
LaunchPlannerOutput

// Response (timeout / error)
{ error: 'planner_timeout' | 'planner_failed'; message: string }
```

**Timeouts:** wrap the `runSkill` call in `AbortController` with 45s
cutoff. On timeout, return 504 `planner_timeout` so the client can show
the "Continue with manual plan" fallback.

**Auth:** requires signed-in user + `productId` must belong to them.

**Rate limit:** 1 call per 10s per user (Redis-backed). Prevents
accidental double-clicks from re-triggering.

**Observability:** emit a `pipeline_events` row: `kind='launch_plan'`,
`status='started'|'completed'|'failed'`, include duration + token cost.

**Does not persist** the planner output. The tasks live in memory until
`/api/onboarding/tasks/commit` writes them.

### 4.3 `POST /api/onboarding/tasks/commit` — NEW

Commits the planner output plus the user's section-A edits and
section-C task selections. Transitions product to onboarded.

```ts
// Request
{
  productId: string;
  productUnderstanding: {   // accepts user's edits to section A
    name: string;
    tagline: string;
    valueProp: string;
    keywords: string[];
    targetAudience: string;
    category: string;
  };
  tasks: Array<{
    // Full task record from planner + enabled flag from UI
    id: string;
    title: string;
    description: string;
    phase: LaunchPhase;
    channel: string | null;
    suggestedDate: string;
    kind: string;
    enabled: boolean;
  }>;
}

// Response
{
  success: true;
  enqueued: string[];   // platform names whose calendar-plan was enqueued
  skipped: string[];    // platforms skipped due to Redis lock
}
```

### Transaction shape

```ts
await db.transaction(async (tx) => {
  // 1. Update product (section A edits)
  await tx.update(products).set({
    name: input.productUnderstanding.name,
    description: input.productUnderstanding.tagline,
    valueProp: input.productUnderstanding.valueProp,
    keywords: input.productUnderstanding.keywords,
    targetAudience: input.productUnderstanding.targetAudience,
    category: input.productUnderstanding.category,
    onboardingCompletedAt: new Date(),
    onboardingSkippedChannels: connectedChannels.length === 0,
    updatedAt: new Date(),
  }).where(eq(products.id, input.productId));

  // 2. Insert all tasks (enabled + disabled; disabled ones stay for audit)
  await tx.insert(launchTasks).values(
    input.tasks.map((t) => ({
      userId, productId: input.productId, ...t,
      // Zod-validated before this point
    })),
  );
});
```

After the transaction (not inside — enqueue failures shouldn't roll back
the commit):

```ts
// 3. Fire activatePostOnboarding-equivalent: calendar-plan per platform
//    Existing Redis lock protects against double-enqueue.
await activatePostOnboarding();  // moved from action to here
```

**Note:** `activatePostOnboarding` currently lives in
`src/app/actions/activation.ts`. Keep it there, just change its caller
from the page-level `handleComplete` to this API handler.

**Calibration:** already enqueued by `/api/onboarding/profile` PUT when
product identity changes. No new enqueue needed here unless section-A
edits changed `name/description/valueProp/keywords`, in which case the
commit handler also runs the same calibration trigger. Factor the
"detect-core-change → enqueue calibration" logic out of the profile PUT
into a shared helper `maybeEnqueueCalibration(prev, next)`.

---

## 5. `activatePostOnboarding` — relocation only

Today: called by the onboarding page's `handleComplete` after step 3.
New: called at the end of `/api/onboarding/tasks/commit`.

No logic change. Remove the call from the page once the new UI ships.
Keep the function exported in case tests or scripts invoke it directly.

---

## 6. `/api/onboarding/profile` — deprecation path

The old PUT endpoint writes name/description/keywords/valueProp plus
maybe-enqueues calibration. The new flow has section A doing the same
thing, but inside `/api/onboarding/tasks/commit`.

**Plan:**
- Keep `/api/onboarding/profile` PUT working during the migration
  (old UI still uses it for the profile-review step)
- Once new UI ships and the old `ProfileReviewStep` is removed, delete
  the endpoint
- Don't bother dual-writing — the two writes don't overlap in flow time

---

## 7. Queue / worker changes

**None.** Reuses all existing queues:

- `calendar-plan` (per connected platform) — triggered by
  `activatePostOnboarding`
- `calibrate-discovery` — triggered by
  `/api/onboarding/profile` PUT and by
  `/api/onboarding/tasks/commit` if section A edits changed core fields
- `code-scan` — still runs from `/api/onboarding/extract-repo` during
  Step 1

**One future consideration (NOT in v1):** if we make the planner
asynchronous later, add a `launch-plan` queue. Not needed now.

---

## 8. Data flow — full onboarding sequence

```
[User hits /onboarding]
  │
  ├─ Step 1: POST /api/onboarding/extract
  │   OR     POST /api/onboarding/extract-repo (SSE)
  │   └─ returns ExtractedProfile (held in client state)
  │
  ├─ Step 2: OAuth redirect to /api/{x,reddit}/callback
  │   └─ writes channels row, redirect back to /onboarding
  │
  ├─ Step 3: PATCH /api/product/phase  { state, launchDate, launchedAt }
  │   └─ writes products row
  │
  ├─ Step 4 loading: POST /api/onboarding/plan  { productId }
  │   └─ runs launch-planner synchronously (5–15s)
  │   └─ returns LaunchPlannerOutput (held in client state)
  │
  └─ Step 4 confirm: POST /api/onboarding/tasks/commit
      ├─ updates products row (section A edits, onboardingCompletedAt)
      ├─ inserts launch_tasks rows
      ├─ runs maybeEnqueueCalibration() if core changed
      ├─ runs activatePostOnboarding() → enqueues calendar-plan per platform
      └─ returns { enqueued, skipped }

[Redirect to /today?from=onboarding]
  └─ polls for calibrate-discovery + calendar-plan job completion
```

---

## 9. Auth, security, data-access

- Every new endpoint: `auth()` → `session.user.id`; 401 if missing.
- Every `productId` arriving from the client: verify ownership before
  any read/write.
- `launch_tasks` gets the same row-level scoping: always filter by
  `userId = session.user.id`.
- No token columns accessed in these paths — the existing CLAUDE.md
  rule still holds (only the three helpers in `platform-deps.ts` and the
  Auth.js adapter read encrypted tokens).
- Rate-limit `POST /api/onboarding/plan` at 1 per 10s per user.
- Rate-limit `POST /api/onboarding/tasks/commit` at 1 per minute per
  user — the body is large and writes transactionally.

---

## 10. Observability

- `pipeline_events` table already exists. Emit:
  - `kind='launch_plan', status='started' | 'completed' | 'failed'`
  - `kind='onboarding_commit', status='started' | 'completed' | 'failed'`
- Structured log fields: `userId`, `productId`, `state`, `channels`,
  `phase`, `taskCount`, `durationMs`, `traceId`.
- Keep `traceId` threading through planner invocation so log correlation
  from API → planner → downstream calendar-plan works end to end.

---

## 11. Tests

### Unit

- `src/lib/launch-phase.test.ts` — `derivePhase` table-driven tests for
  all state × date permutations including boundary (T-0, T-7, T-28, T+30).
- Zod schemas for API payloads in `src/app/api/onboarding/*/route.test.ts`
  — reject invalid state+date combos.

### Agent

- `src/agents/__tests__/launch-planner.test.ts` (if the codebase has
  a pattern for agent IO tests — check the existing
  `calendar-plan-thesis.test.ts` shape) — assert output-schema validity,
  task diversity, skip-channels degradation.

### Integration

- `src/app/api/onboarding/plan/__tests__/route.test.ts` — mock planner,
  assert 45s timeout surfaces as 504.
- `src/app/api/onboarding/tasks/commit/__tests__/route.test.ts` —
  assert transaction writes both product + launch_tasks atomically,
  activation enqueue happens outside the transaction.

### E2E (deferred until new UI lands)

- Happy path: extract → connect → select state → plan → commit → land on
  `/today` with calibrating modules.
- Skip-channels path: same minus OAuth, assert only channel-agnostic
  tasks get written.
- Planner timeout: inject delay, assert fallback surface.

---

## 12. Rollout order

1. **Migration A** (schema additive) — ship alone, verify backfill.
2. **Shared helpers** — `derivePhase`, `maybeEnqueueCalibration`.
3. **Update 29 callers** of `lifecyclePhase` → `state` + `derivePhase`.
   Biggest diff of the whole change. Keep PRs scoped per caller cluster
   (agents first, then API routes, then workers).
4. **New `launch-planner` skill + agent** — shippable independently
   (dry-run via `scripts/test-launch-plan.ts`).
5. **New API endpoints** — `POST /api/onboarding/plan`,
   `POST /api/onboarding/tasks/commit`; extend
   `PATCH /api/product/phase`.
6. **Migration B** — drop `lifecycle_phase` column. Only after step 3
   is fully deployed and soaked for a few days.
7. **Frontend lands later** — uses the endpoints now ready.

Each step is safely deployable in isolation.

---

## 13. Open questions

- **`launchDate` validation window.** Current spec caps at `today + 90d`.
  Indie devs sometimes pre-announce 6 months out. Soften to 180d?
- **Phase derivation for `state='mvp'` with a `launchDate` in the past.**
  Current `derivePhase` returns `'launch'`. Probably should auto-prompt
  the user to re-select state. Who enforces — client warning or server
  rejection?
- **Task template language.** English only for v1? The product supports
  Chinese content generation elsewhere — does the planner need a locale
  input?
- **`category` enum source of truth.** Hardcode in code + DB `text`?
  Or add `category` as a `pgEnum`? Hardcode recommended for now — let
  the set evolve before locking it into a PG type.
- **Legacy `lifecyclePhase` read during transition.** If we go single-
  migration, any in-flight job payload that still carries the old value
  breaks. Audit enqueue sites to confirm none of them serialize it
  into job data. (Spot check: `CalendarPlanJobData` doesn't carry it
  directly — planner reads from DB. Likely safe.)
