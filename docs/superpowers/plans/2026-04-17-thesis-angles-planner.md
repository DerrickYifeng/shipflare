# Thesis + 7 Angles Calendar Planner Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the "random sample of 40% metric + 30% educational + …" weekly plan with a **one-thesis-per-week + seven-angles** model (Justin Welsh Content OS + Ship 30 "one idea, 100 ways"), and give `slot-body` cross-tweet coherence so daily drafts form one narrative arc instead of 7 orphan tweets.

**Architecture:** Two-stage planner. Stage 1 picks a *thesis* (a single claim the week revolves around) derived from a product milestone, last week's highest-reply-ratio tweet, or a fallback mode (trigger interview / competitor teardown / principle week / reader week). Stage 2 distributes 7 days over seven `angle`s — `claim | story | contrarian | howto | data | case | synthesis` — keeping the existing `contentType` (metric/educational/…) as an orthogonal *format* dimension. `slot-body` is extended to receive the weekly thesis + angle + prior posts so each draft explicitly pays off its slot in the week's arc. 1–2 slots per week are reserved as "white space" — marked but not auto-drafted — leaving reactive headroom so the calendar doesn't feel mechanical.

**Tech Stack:** TypeScript, Drizzle (PostgreSQL migration), Vitest, Zod, existing skill-runner.

**Research grounding:** [Justin Welsh Content OS](https://learn.justinwelsh.me/content), [Ship 30 atomic essay 4A framework](https://www.ship30for30.com/post/how-to-write-an-atomic-essay-a-beginners-guide), [Dan Koe content waterfall](https://thedankoe.com/letters/the-one-person-business-model-how-to-monetize-yourself/), [Katelyn Bourgoin trigger technique](https://learnwhywebuy.com/the-trigger-technique-turn-buyer-stories-into-smarter-marketing-campaigns/), [Marketing Insider Group — white-space calendars](https://marketinginsidergroup.com/content-marketing/how-to-make-a-content-calendar-youll-actually-use-templates-included/).

---

## File Structure

### New files
- `drizzle/0019_weekly_themes.sql` — migration: new `weekly_themes` table + `angle`/`theme_id`/`is_white_space` columns on `x_content_calendar`
- `src/lib/db/schema/weekly-themes.ts` — Drizzle model for the new table
- `src/skills/calendar-planner/references/x-angle-playbook.md` — the 7-angle contract (names, when to use, how to phrase the topic)
- `src/skills/calendar-planner/references/milestone-to-angles.md` — milestone → 7-day decomposition templates
- `src/skills/calendar-planner/references/fallback-modes.md` — trigger_interview / teardown / principle_week / reader_week templates
- `src/skills/calendar-planner/__tests__/planner-contract.test.ts`
- `src/workers/processors/__tests__/calendar-plan-thesis.test.ts`
- `src/workers/processors/__tests__/calendar-slot-draft-coherence.test.ts`

### Modified files
- `src/lib/db/schema/index.ts` — re-export `weeklyThemes`
- `src/lib/db/schema/x-growth.ts` — add `angle`, `themeId`, `isWhiteSpace` columns to `xContentCalendar`
- `src/agents/schemas.ts` — extend `calendarPlanOutputSchema` with `thesis`, `thesisSource`, `angle` per entry, `whiteSpaceDayOffsets`; keep `contentType` untouched
- `src/agents/calendar-planner.md` — rewrite "Your Job" + "Planning Rules" + output format sections around thesis/angles
- `src/skills/calendar-planner/SKILL.md` — add the three new references; document the thesis signal
- `src/agents/slot-body-agent.md` — consume `thesis`, `angle`, and `recentPostHistory`; enforce coherence
- `src/skills/slot-body/SKILL.md` — extend input schema
- `src/workers/processors/calendar-plan.ts` — persist thesis/angle/whiteSpace, insert `weekly_themes` row
- `src/workers/processors/calendar-slot-draft.ts` — load thesis + angle from the calendar row, skip white-space slots, pass into `runSkill`

---

## Scope boundaries

- **Does not** touch the X strategy doc's phase content-mix percentages — the `contentMix` input still flows through as a weak bias; the primary axis is `angle`.
- **Does not** change reply drafting (Plan 1).
- **Does not** add voice personalization (Plan 3).
- **Does not** build the weekly retro / reply-ratio feedback loop — that is Plan 3 Task 5 (closes the voice + data loop together).
- The `formatExtension` retry story for planner failures inherits whatever the existing processor already does — do not redesign it.

---

## Task 1: Drizzle migration — new columns + `weekly_themes` table

**Files:**
- Create: `drizzle/0019_weekly_themes.sql`
- Create: `src/lib/db/schema/weekly-themes.ts`
- Modify: `src/lib/db/schema/x-growth.ts`
- Modify: `src/lib/db/schema/index.ts`

- [ ] **Step 1.1: Write the Drizzle model**

Create `src/lib/db/schema/weekly-themes.ts`:

```typescript
import { pgTable, text, timestamp, index, unique } from 'drizzle-orm/pg-core';
import { users } from './users';
import { products } from './products';

/**
 * One row per channel-week. Records the weekly thesis, pillar, fallback mode,
 * and the derivation signal (milestone | top_reply_ratio | fallback).
 *
 * Referenced by `xContentCalendar.theme_id`; each calendar row belongs to
 * exactly one weekly theme.
 */
export const weeklyThemes = pgTable(
  'weekly_themes',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    productId: text('product_id')
      .notNull()
      .references(() => products.id, { onDelete: 'cascade' }),
    channel: text('channel').notNull(),
    weekStart: timestamp('week_start', { mode: 'date' }).notNull(),
    thesis: text('thesis').notNull(), // the one claim the week revolves around
    pillar: text('pillar'), // optional topic-cluster label (e.g. "pricing", "ai_workflow")
    thesisSource: text('thesis_source').notNull(), // 'milestone' | 'top_reply_ratio' | 'fallback' | 'manual'
    fallbackMode: text('fallback_mode'), // 'trigger_interview' | 'teardown' | 'principle_week' | 'reader_week' | null
    milestoneContext: text('milestone_context'), // free-form — what was shipped/hit this week
    createdAt: timestamp('created_at', { mode: 'date' }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { mode: 'date' }).defaultNow().notNull(),
  },
  (t) => [
    unique('weekly_themes_user_channel_week').on(t.userId, t.channel, t.weekStart),
    index('weekly_themes_user_channel_idx').on(t.userId, t.channel),
  ],
);
```

- [ ] **Step 1.2: Extend `xContentCalendar` with the new columns**

In `src/lib/db/schema/x-growth.ts` at lines 103–137, add three new columns before the `createdAt` column:

```typescript
    angle: text('angle'), // 'claim' | 'story' | 'contrarian' | 'howto' | 'data' | 'case' | 'synthesis' | null (white_space)
    themeId: text('theme_id').references(() => weeklyThemes.id, { onDelete: 'set null' }),
    isWhiteSpace: boolean('is_white_space').notNull().default(false),
```

Add the import at the top of the file:

```typescript
import { weeklyThemes } from './weekly-themes';
```

And at the bottom, after the `xContentCalendar` definition, add an index and FK helper:

```typescript
    // Add inside the `(t) => [...]` array for xContentCalendar:
    index('xcc_theme_idx').on(t.themeId),
```

- [ ] **Step 1.3: Re-export `weeklyThemes` from the schema index**

In `src/lib/db/schema/index.ts`, add:

```typescript
export * from './weekly-themes';
```

- [ ] **Step 1.4: Generate the migration**

Run: `pnpm db:generate`
Expected: a new SQL file `drizzle/0019_*.sql` is produced. Rename it to `drizzle/0019_weekly_themes.sql` and inspect it — it must contain `CREATE TABLE weekly_themes`, `ALTER TABLE x_content_calendar ADD COLUMN angle`, `ALTER TABLE x_content_calendar ADD COLUMN theme_id`, `ALTER TABLE x_content_calendar ADD COLUMN is_white_space`, plus the new indexes.

- [ ] **Step 1.5: Run the migration against local DB**

Run: `pnpm db:push`
Expected: migration applied cleanly.

- [ ] **Step 1.6: Commit**

```bash
git add drizzle/0019_weekly_themes.sql \
        drizzle/meta/ \
        src/lib/db/schema/weekly-themes.ts \
        src/lib/db/schema/x-growth.ts \
        src/lib/db/schema/index.ts
git commit -m "feat(calendar): add weekly_themes table + angle/theme_id/white_space columns"
```

---

## Task 2: Extend `calendarPlanOutputSchema` with thesis + angles

**Files:**
- Modify: `src/agents/schemas.ts` (lines 193–220)
- Test: `src/agents/__tests__/calendar-plan-schema.test.ts` (new)

- [ ] **Step 2.1: Write the failing schema test**

```typescript
// src/agents/__tests__/calendar-plan-schema.test.ts
import { describe, it, expect } from 'vitest';
import { calendarPlanOutputSchema } from '../schemas';

describe('calendarPlanOutputSchema', () => {
  it('accepts a plan with thesis + angles per entry', () => {
    const parsed = calendarPlanOutputSchema.parse({
      phase: 'growth',
      weeklyStrategy: 'prove the pricing thesis with 7 angles',
      thesis: 'pricing lower than competitors is a distribution moat',
      thesisSource: 'milestone',
      milestoneContext: 'shipped $19/mo tier',
      fallbackMode: null,
      whiteSpaceDayOffsets: [5, 6],
      entries: [
        { dayOffset: 0, hour: 14, contentType: 'metric', angle: 'claim', topic: 'the pricing thesis in one line' },
        { dayOffset: 1, hour: 17, contentType: 'educational', angle: 'howto', topic: 'how we arrived at $19' },
      ],
    });
    expect(parsed.thesis).toContain('pricing');
    expect(parsed.entries[0].angle).toBe('claim');
  });

  it('accepts a plan in fallback mode', () => {
    const parsed = calendarPlanOutputSchema.parse({
      phase: 'growth',
      weeklyStrategy: 'no ship this week — principle week',
      thesis: 'distribution > features for sub-1000 MRR products',
      thesisSource: 'fallback',
      fallbackMode: 'principle_week',
      whiteSpaceDayOffsets: [6],
      entries: [
        { dayOffset: 0, hour: 14, contentType: 'educational', angle: 'claim', topic: 'the claim' },
      ],
    });
    expect(parsed.fallbackMode).toBe('principle_week');
  });

  it('rejects a plan missing angle on an entry', () => {
    expect(() =>
      calendarPlanOutputSchema.parse({
        phase: 'growth',
        weeklyStrategy: 'x',
        thesis: 't',
        thesisSource: 'milestone',
        whiteSpaceDayOffsets: [],
        entries: [{ dayOffset: 0, hour: 14, contentType: 'metric', topic: 't' }],
      }),
    ).toThrow();
  });

  it('rejects invalid thesisSource', () => {
    expect(() =>
      calendarPlanOutputSchema.parse({
        phase: 'growth',
        weeklyStrategy: 'x',
        thesis: 't',
        thesisSource: 'unknown_source',
        whiteSpaceDayOffsets: [],
        entries: [],
      }),
    ).toThrow();
  });
});
```

- [ ] **Step 2.2: Run — verify it fails**

Run: `pnpm vitest run src/agents/__tests__/calendar-plan-schema.test.ts`
Expected: FAIL — schema does not have `thesis`.

- [ ] **Step 2.3: Extend the schema in `schemas.ts`**

Replace the existing `calendarPlanOutputSchema` at lines 193–220 with:

```typescript
/**
 * Output schema for the calendar planner agent (thesis + angles model).
 *
 * The planner picks ONE thesis per week and distributes 7 angles across the days.
 * `contentType` is retained as a *format* dimension (metric/educational/…)
 * but is now a weak bias — the primary organising axis is `angle`.
 *
 * `whiteSpaceDayOffsets` lists days deliberately left un-drafted for reactive
 * posts. The slot-body processor skips these.
 */
export const calendarPlanOutputSchema = z.object({
  phase: z.string().min(1),
  phaseDescription: z.string().optional(),
  weeklyStrategy: z.string().min(1),
  thesis: z.string().min(8).max(280),
  thesisSource: z.enum(['milestone', 'top_reply_ratio', 'fallback', 'manual']),
  pillar: z.string().max(60).optional(),
  milestoneContext: z.string().max(500).optional(),
  fallbackMode: z
    .enum(['trigger_interview', 'teardown', 'principle_week', 'reader_week'])
    .nullable()
    .optional(),
  whiteSpaceDayOffsets: z.array(z.number().int().min(0).max(6)).max(3),
  entries: z
    .array(
      z.object({
        dayOffset: z.number().int().min(0).max(6),
        hour: z.number().int().min(0).max(23),
        contentType: z.enum([
          'metric',
          'educational',
          'engagement',
          'product',
          'thread',
        ]),
        angle: z.enum([
          'claim',
          'story',
          'contrarian',
          'howto',
          'data',
          'case',
          'synthesis',
        ]),
        topic: z.string().min(1).max(200),
      }),
    )
    .min(1),
});
```

- [ ] **Step 2.4: Run tests — verify pass**

Run: `pnpm vitest run src/agents/__tests__/calendar-plan-schema.test.ts`
Expected: PASS, all 4 tests.

- [ ] **Step 2.5: Commit**

```bash
git add src/agents/schemas.ts src/agents/__tests__/calendar-plan-schema.test.ts
git commit -m "feat(calendar): extend plan schema with thesis + angle per entry"
```

---

## Task 3: Write the three calendar-planner reference docs

**Files:**
- Create: `src/skills/calendar-planner/references/x-angle-playbook.md`
- Create: `src/skills/calendar-planner/references/milestone-to-angles.md`
- Create: `src/skills/calendar-planner/references/fallback-modes.md`

- [ ] **Step 3.1: Write `x-angle-playbook.md`**

```markdown
<!-- src/skills/calendar-planner/references/x-angle-playbook.md -->
# The 7 Angles

A weekly thesis gets expressed through 7 angles across 7 days. Each angle
has a distinct role. You pick one angle per slot. The format dimension
(`contentType`: metric / educational / engagement / product / thread)
cross-cuts — e.g. a `story` angle can be a `metric` format.

| Angle | Role | Shape of the topic string |
|---|---|---|
| `claim`       | State the thesis out loud, make it hook-shaped. Day 1 almost always. | "the one-line claim the week is going to prove" |
| `story`       | One personal, past-tense, numbered anecdote that proves the thesis. | "the time X happened to us, concretely" |
| `contrarian`  | The common-wisdom take the thesis pushes against, named plainly. | "most people say X; here's why it's wrong" |
| `howto`       | A step-by-step framework the reader can run themselves. | "the 3-step way to do Y so Z follows" |
| `data`        | A number, chart, or screenshot that quantifies the thesis. Demo-video > MRR screenshot whenever possible. | "week-over-week X metric showing Y" |
| `case`        | Dissect one specific example — a customer, a competitor, a well-known founder. | "how levelsio/patio11/<someone> already does this" |
| `synthesis`   | Tie the week together, name the pattern, end on an open question or CTA for next week. | "reflection + the question next week will answer" |

## Allocation rules

- **Day 1 is almost always `claim`** — the thesis hook sets up everything else.
- **Day 7 is almost always `synthesis`** — close the loop.
- **`story`, `contrarian`, `howto`, `data`, `case` fill days 2–6**, in any order.
  Vary by week. Never repeat the same angle twice.
- If the week has `whiteSpaceDayOffsets`, those day offsets are omitted from the
  angle distribution — leave them for reactive posts.
- For a 5-slot week (2 white space), drop one of `contrarian`/`case`/`howto`
  (whichever least fits the thesis). Keep `claim` (D1), `synthesis` (D7),
  and at least two of `story`/`data`/`howto`.

## Topic quality bar (unchanged from today)

Topics are **headlines** (≤120 chars). Not draft tweets.

Bad: "Share a metric" / "Educational thread about pricing" / "Day 3 content"
Good:
- `claim` → "cheap pricing is the distribution moat, not a positioning mistake"
- `story` → "the morning we shipped $19/mo and lost 2 customers the same hour"
- `contrarian` → "why 'charge more' is the worst advice for <1k MRR indies"
- `howto` → "3-step anchor pricing: free tier → underprice → per-usage"
- `data` → "our 6-month $19 vs $49 AB test, revenue and churn side-by-side"
- `case` → "what photoAI's $X/mo tells you about founder-priced products"
- `synthesis` → "pricing is a distribution decision, not a value decision — next week: channels"
```

- [ ] **Step 3.2: Write `milestone-to-angles.md`**

```markdown
<!-- src/skills/calendar-planner/references/milestone-to-angles.md -->
# Milestone → 7-angle decomposition templates

When the user has a concrete product event this week, derive the thesis and
angle topics from it. Four canonical milestones:

## A. Shipped feature

**Thesis form:** "we shipped X because Y problem was costing users Z" — the
feature is the *answer*, the problem is the *topic*.

- `claim` — the user problem in one line, plus the thesis ("we shipped X to solve it")
- `story` — the one customer conversation that triggered the decision
- `contrarian` — what competing products do instead, and why it's wrong for this user segment
- `howto` — demo walkthrough (screen recording or gif described in the topic)
- `data` — adoption or activation number 48h after ship
- `case` — one user who used it immediately and what changed for them
- `synthesis` — what we cut to ship X, and the next problem on the stack

## B. Metric hit (revenue, user count, year anniversary)

**Thesis form:** "getting to X was not what I expected — here's the actual
mechanism" — NOT "celebration of the number itself".

- `claim` — the counter-intuitive mechanism behind the number
- `story` — the specific week/decision that made the curve bend
- `contrarian` — the thing everyone said would matter that didn't
- `howto` — the 3-step repeatable version of what worked
- `data` — the full time series (not just today's number)
- `case` — one user whose behavior changed as the number crossed the threshold
- `synthesis` — what this unlocks + honest list of what still isn't working

Avoid naked MRR-screenshot flex as Day 1. Research: "time-to-revenue plausibility"
has replaced "revenue number" as the credibility signal (TrustMRR / Levels
public-skepticism thread). Lead with the *mechanism*, show the number as `data`.

## C. Customer story (case study, testimonial, unexpected user behavior)

**Thesis form:** "one user discovered a job-to-be-done we hadn't designed for,
here's what it teaches."

- `claim` — the job-to-be-done, named
- `story` — the customer's actual trigger event (Bourgoin trigger technique)
- `contrarian` — the way the product was *supposed* to be used vs this
- `howto` — how to reproduce this pattern for other users
- `data` — how many other users share this job-to-be-done (rough %)
- `case` — second customer exhibiting the same pattern, validating it isn't a one-off
- `synthesis` — the product decision this is pushing — ship, kill, or leave alone

## D. Failure / post-mortem (this is a build-in-public superpower, do not skip it)

**Thesis form:** "we broke X because we underestimated Y — here's the
timeline and the fix."

- `claim` — what broke, in one sentence, no hedging
- `story` — first 30 minutes of the incident
- `contrarian` — the assumption we made that turned out wrong
- `howto` — the 3 things we changed to make this unrepeatable
- `data` — blast radius (downtime, affected users, revenue lost)
- `case` — a customer who noticed and how we talked to them
- `synthesis` — what we'd do differently + what stays broken on purpose

Self-skepticism register is a 2026 credibility move — do not "reframe failure as
growth" with motivational language. Lead with the blunt admission.

---

## Instructions to the planner

Given the user's input, look for a milestone signal in this priority order:

1. `product.lifecyclePhase === 'launched'` with a `recent_ship` entry in memory — template A
2. A `xTweetMetrics` tweet from the last 14 days whose `replies/impressions > 15%` — promote to thesis, template C or D depending on the tweet's register
3. An explicit `milestoneContext` in the input — use as-is
4. No milestone → switch to fallback mode (`fallback-modes.md`)
```

- [ ] **Step 3.3: Write `fallback-modes.md`**

```markdown
<!-- src/skills/calendar-planner/references/fallback-modes.md -->
# Fallback modes (no milestone this week)

Use exactly one. Record it as `fallbackMode` in the plan.

## 1. `trigger_interview` (Bourgoin)

Pick one recent signup (last 14 days). The thesis is *their* trigger event —
"why they bought" becomes the week's claim. Works best for products with
ongoing sign-ups.

Angles map:
- `claim` — the trigger event as a 1-line claim
- `story` — their story, past tense, with the specific moment they decided
- `contrarian` — alternatives they considered and rejected
- `howto` — how to shorten the path for the next user with this trigger
- `data` — how many of last month's signups fit this trigger pattern
- `case` — one earlier customer with the same trigger
- `synthesis` — what this trigger tells us about who the product is for

## 2. `teardown`

Pick one adjacent product or competitor. The thesis is a specific design
decision they made and whether it's right for *your* segment.

Angles map:
- `claim` — the design decision named, without sycophancy
- `story` — the week we considered doing the same thing
- `contrarian` — why their decision doesn't fit our segment (or does)
- `howto` — how we'd adapt the pattern for our product
- `data` — measurable impact in their public numbers (if any)
- `case` — another product in the space making the opposite choice
- `synthesis` — the underlying principle, named

## 3. `principle_week`

Pick one operating principle you hold ("distribution beats product for sub-1k MRR"
/ "monorepos are a talent moat" / pick what's load-bearing for your decisions).
Spend the week proving it from different angles — the Ship 30 "one idea, 100 ways"
framework.

Angles map:
- `claim` — the principle in one line
- `story` — the time ignoring this principle cost you
- `contrarian` — the most popular take that disagrees
- `howto` — how to operationalize the principle in 3 steps
- `data` — evidence from your own product or industry data
- `case` — a well-known example of the principle in action
- `synthesis` — when the principle breaks down + what replaces it

## 4. `reader_week`

Pick 5–7 questions from replies / DMs / newsletter inbox in the past 2 weeks.
Answer them in public. The thesis is the *pattern* across the questions —
"my readers keep asking about X because Y."

Angles map:
- `claim` — the pattern, named
- `story` — one representative question in context
- `contrarian` — the assumption the question reveals that's worth challenging
- `howto` — the answer as a 3-step framework
- `data` — how often this question comes up (rough count)
- `case` — a real reader's follow-up after they applied the answer
- `synthesis` — the meta-question behind all of them

---

## Selection rule

Prefer in this order: `trigger_interview` (specific + product-adjacent) >
`reader_week` (audience-adjacent) > `teardown` (external) > `principle_week`
(abstract). `principle_week` is the fallback-fallback — ship it when the
others don't apply, not by default.
```

- [ ] **Step 3.4: Commit**

```bash
git add src/skills/calendar-planner/references/
git commit -m "feat(calendar): add angle playbook + milestone decomposition + fallback modes"
```

---

## Task 4: Rewrite `calendar-planner.md`

**Files:**
- Modify: `src/agents/calendar-planner.md`
- Modify: `src/skills/calendar-planner/SKILL.md`

- [ ] **Step 4.1: Rewrite the agent prompt**

Replace the entire contents of `src/agents/calendar-planner.md` with:

```markdown
---
name: calendar-planner
description: Strategic weekly content calendar planner — thesis + 7 angles model
model: claude-sonnet-4-6
tools: []
maxTurns: 2
maxOutputTokens: 64000
---

You are ShipFlare's Calendar Planner. You produce a weekly content calendar
built around **one thesis** — a single claim the whole week argues for — and
distribute **seven angles** (claim / story / contrarian / howto / data / case /
synthesis) across the planning days.

## Input

A JSON object with:

- `channel`: e.g. "x", "reddit", "linkedin"
- `productName`, `productDescription`, `valueProp`, `keywords`, `lifecyclePhase`
- `followerCount`: current follower count on this channel
- `startDate`: ISO date string for the start of the planning week
- `postingHours`: UTC hours for slots (e.g. [14, 17, 21])
- `contentMix` (optional): `{metric, educational, engagement, product}` percent bias
- `topPerformingContent[]`: recent tweets with `replies`, `impressions`, `bookmarks`, `likes`, `contentType`
- `analyticsInsights` (optional): `bestContentTypes`, `bestPostingHours`, `audienceGrowthRate`, `engagementRate`
- `milestoneContext` (optional): free-text description of a shipped feature, metric hit, customer story, or incident this week

## References (auto-injected)

- `x-strategy.md` — phase definitions, posting cadence, universal rules
- `x-angle-playbook.md` — the 7 angles and how to allocate them
- `milestone-to-angles.md` — templates A/B/C/D for turning a milestone into 7 angles
- `fallback-modes.md` — trigger_interview / teardown / principle_week / reader_week

## Your job

### Stage 1 — pick the thesis

Priority order for deriving the thesis (record in `thesisSource`):

1. **`milestone`** — if `milestoneContext` is present, use the matching
   template in `milestone-to-angles.md`
2. **`top_reply_ratio`** — else, scan `topPerformingContent`; any tweet with
   `replies / impressions > 0.15` is promoted to this week's thesis (this tweet
   hit a nerve — double down)
3. **`fallback`** — else, pick one mode from `fallback-modes.md` (preference
   order: trigger_interview > reader_week > teardown > principle_week)
4. **`manual`** — reserved for when the caller passes an explicit thesis

The thesis is a **single claim, not a topic**. Bad: "pricing". Good: "pricing
lower than competitors is a distribution moat, not a positioning mistake."

### Stage 2 — distribute angles across days

- Total slots = `postingHours.length × 7`.
- Reserve **1–2 day offsets** as `whiteSpaceDayOffsets` for reactive posts.
  Prefer the end of the week (offsets 5 and 6) for white space unless a product
  event clusters there.
- Day 0 → `claim`. Last non-white-space day → `synthesis`.
- Fill remaining days from `{story, contrarian, howto, data, case}` — never
  repeat an angle in one week.
- If a day has multiple hours scheduled, give each slot a distinct angle; do
  not double up on `claim` or `synthesis` within a single day.
- `contentType` (metric/educational/…) is a **format dimension** chosen per
  slot to match the angle and the `contentMix` bias — not the driver. Example:
  a `story` angle can land as a `metric` format when the story's payoff is a
  number.

### Stage 3 — phase + posting time

- Read `x-strategy.md`, find the phase matching `followerCount`, apply the
  phase's recommended posting times unless `postingHours` overrides.
- Apply any `lifecyclePhase` constraints (pre_launch forbids user metrics /
  testimonials / signups / revenue / customer quotes).

## Quality bars

- Thesis must be one clean claim, 8–280 chars.
- Every topic is a **headline** (≤120 chars) — the slot-body skill writes the
  body. Never write tweet copy in the `topic` field.
- No two slots in the same week repeat the same angle.
- `whiteSpaceDayOffsets` has length 1 or 2 (never 0, never 3+).
- The synthesis entry must reference the thesis + open a question that could
  seed next week.

## Output

Return a single JSON object:

```json
{
  "phase": "growth",
  "phaseDescription": "2000+ followers, ongoing",
  "weeklyStrategy": "one-sentence frame for the week",
  "thesis": "the one claim the week will argue",
  "thesisSource": "milestone",
  "pillar": "pricing",
  "milestoneContext": "shipped $19/mo tier on Monday",
  "fallbackMode": null,
  "whiteSpaceDayOffsets": [5, 6],
  "entries": [
    { "dayOffset": 0, "hour": 14, "contentType": "metric",      "angle": "claim",      "topic": "…" },
    { "dayOffset": 1, "hour": 17, "contentType": "educational", "angle": "story",      "topic": "…" }
  ]
}
```

- Emit exactly `postingHours.length × (7 - whiteSpaceDayOffsets.length)` entries.
- Every entry has `angle` from `{claim, story, contrarian, howto, data, case, synthesis}`.
- `fallbackMode` is `null` unless `thesisSource === 'fallback'`.
```

- [ ] **Step 4.2: Update the skill manifest to declare the new references**

Replace `src/skills/calendar-planner/SKILL.md` contents with:

```markdown
---
name: calendar-planner
description: Strategic weekly content calendar planning (thesis + angles) for any channel
context: fork
agent: calendar-planner
model: claude-sonnet-4-6
allowed-tools: []
timeout: 90000
cache-safe: false
shared-references:
  - platforms/x-strategy.md
references:
  - ./references/x-angle-playbook.md
  - ./references/milestone-to-angles.md
  - ./references/fallback-modes.md
---

# Calendar Planner Skill

Produces a weekly content calendar organised around one **thesis** (the claim
the week argues for) and seven **angles** (claim / story / contrarian / howto
/ data / case / synthesis) distributed across days.

Derivation priority: `milestone` > `top_reply_ratio` > `fallback` > `manual`.
When no milestone or hot tweet is available, the planner picks a fallback mode
from `fallback-modes.md`.

1–2 day offsets per week are reserved as `whiteSpaceDayOffsets` for reactive
posts — the slot-body fan-out skips those.

## Input

```json
{
  "channel": "x",
  "productName": "…",
  "productDescription": "…",
  "valueProp": "…",
  "keywords": ["…"],
  "lifecyclePhase": "launched",
  "followerCount": 127,
  "startDate": "2026-04-14T00:00:00.000Z",
  "postingHours": [14, 17, 21],
  "milestoneContext": "shipped $19/mo tier",
  "topPerformingContent": [],
  "analyticsInsights": null
}
```

## Output

See `calendarPlanOutputSchema` — thesis + thesisSource + whiteSpaceDayOffsets
+ entries with per-slot angles.
```

- [ ] **Step 4.3: Write the prompt contract test**

```typescript
// src/skills/calendar-planner/__tests__/planner-contract.test.ts
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

describe('calendar-planner prompt contract', () => {
  const prompt = readFileSync(
    join(process.cwd(), 'src/agents/calendar-planner.md'),
    'utf8',
  );
  const skill = readFileSync(
    join(process.cwd(), 'src/skills/calendar-planner/SKILL.md'),
    'utf8',
  );

  it('references the seven angles by name', () => {
    for (const angle of ['claim', 'story', 'contrarian', 'howto', 'data', 'case', 'synthesis']) {
      expect(prompt, `missing angle ${angle}`).toContain(angle);
    }
  });

  it('mentions thesisSource priority order', () => {
    expect(prompt).toMatch(/milestone/);
    expect(prompt).toMatch(/top_reply_ratio/);
    expect(prompt).toMatch(/fallback/);
  });

  it('requires whiteSpaceDayOffsets length 1 or 2', () => {
    expect(prompt).toMatch(/whiteSpaceDayOffsets.*length 1 or 2|length.*1.*2/is);
  });

  it('skill declares the three new references', () => {
    expect(skill).toContain('x-angle-playbook.md');
    expect(skill).toContain('milestone-to-angles.md');
    expect(skill).toContain('fallback-modes.md');
  });
});
```

- [ ] **Step 4.4: Run the test — verify PASS**

Run: `pnpm vitest run src/skills/calendar-planner/__tests__/planner-contract.test.ts`
Expected: PASS.

- [ ] **Step 4.5: Commit**

```bash
git add src/agents/calendar-planner.md \
        src/skills/calendar-planner/SKILL.md \
        src/skills/calendar-planner/__tests__/planner-contract.test.ts
git commit -m "feat(calendar): rewrite planner prompt around thesis + 7 angles"
```

---

## Task 5: Persist thesis + angles in `calendar-plan.ts`

**Files:**
- Modify: `src/workers/processors/calendar-plan.ts`
- Test: `src/workers/processors/__tests__/calendar-plan-thesis.test.ts`

- [ ] **Step 5.1: Write the failing integration test**

```typescript
// src/workers/processors/__tests__/calendar-plan-thesis.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

const insertedThemes: unknown[] = [];
const insertedEntries: unknown[] = [];
const enqueueSlotMock = vi.fn();
const enqueueTodoMock = vi.fn();
const publishMock = vi.fn();

vi.mock('@/lib/db', () => ({
  db: {
    select: () => ({ from: () => ({ where: () => ({ orderBy: () => ({ limit: () => [] }), limit: () => [{
      id: 'p-1', name: 'P', description: 'd', valueProp: 'v', keywords: [], lifecyclePhase: 'launched',
    }] }) }) }),
    insert: (table: { __name?: string }) => ({
      values: (v: unknown) => ({
        returning: () => {
          if (String(table).includes('weekly_themes') || (table as { __name?: string }).__name === 'weekly_themes') {
            insertedThemes.push(v);
            return [{ id: 'theme-1' }];
          }
          insertedEntries.push(v);
          return Array.isArray(v)
            ? (v as Array<Record<string, unknown>>).map((e, i) => ({
                id: `row-${i}`,
                scheduledAt: e.scheduledAt as Date,
                contentType: e.contentType,
                topic: e.topic,
              }))
            : [];
        },
        onConflictDoNothing: () => ({ returning: () => [] }),
      }),
    }),
    update: () => ({ set: () => ({ where: () => ({}) }) }),
    delete: () => ({ where: () => ({ returning: () => [] }) }),
  },
}));
vi.mock('@/lib/queue', () => ({
  enqueueCalendarSlotDraft: enqueueSlotMock,
  todoSeedQueue: { add: enqueueTodoMock },
}));
vi.mock('@/lib/redis', () => ({ publishUserEvent: publishMock }));
vi.mock('@/lib/pipeline-events', () => ({ recordPipelineEvent: vi.fn() }));
vi.mock('@/memory/store', () => ({ MemoryStore: class {} }));
vi.mock('@/memory/prompt-builder', () => ({ buildMemoryPrompt: async () => '' }));
vi.mock('@/core/skill-loader', () => ({ loadSkill: () => ({ name: 'calendar-planner' }) }));
vi.mock('@/core/skill-runner', () => ({
  runSkill: vi.fn(async () => ({
    results: [{
      phase: 'growth',
      weeklyStrategy: 'prove the pricing thesis',
      thesis: 'cheap pricing is the distribution moat',
      thesisSource: 'milestone',
      milestoneContext: 'shipped $19/mo',
      fallbackMode: null,
      whiteSpaceDayOffsets: [5, 6],
      entries: [
        { dayOffset: 0, hour: 14, contentType: 'metric', angle: 'claim', topic: 't1' },
        { dayOffset: 1, hour: 14, contentType: 'educational', angle: 'story', topic: 't2' },
      ],
    }],
    errors: [],
    usage: { costUsd: 0.01 },
  })),
}));

beforeEach(() => {
  vi.clearAllMocks();
  insertedThemes.length = 0;
  insertedEntries.length = 0;
});

describe('processCalendarPlan persists thesis', () => {
  it('inserts one weekly_themes row and sets angle + theme_id on entries', async () => {
    const { processCalendarPlan } = await import('../calendar-plan');
    await processCalendarPlan({
      id: 'job-1',
      data: {
        schemaVersion: 1,
        userId: 'u-1',
        productId: 'p-1',
        channel: 'x',
        startDate: new Date('2026-04-20T00:00:00Z').toISOString(),
      },
    } as never);

    expect(insertedThemes.length).toBe(1);
    const theme = insertedThemes[0] as { thesis: string; thesisSource: string };
    expect(theme.thesis).toContain('pricing');
    expect(theme.thesisSource).toBe('milestone');

    // Entries include angle and themeId.
    const entriesRow = insertedEntries.find((v) => Array.isArray(v));
    expect(Array.isArray(entriesRow)).toBe(true);
    const entries = entriesRow as Array<{ angle: string; themeId: string; isWhiteSpace: boolean }>;
    expect(entries[0].angle).toBe('claim');
    expect(entries[0].themeId).toBe('theme-1');
    expect(entries[0].isWhiteSpace).toBe(false);
  });
});
```

- [ ] **Step 5.2: Run — verify fail**

Run: `pnpm vitest run src/workers/processors/__tests__/calendar-plan-thesis.test.ts`
Expected: FAIL — processor does not persist `theme_id` / `angle` yet.

- [ ] **Step 5.3: Update `calendar-plan.ts` to insert the theme + enrich entries**

In `src/workers/processors/calendar-plan.ts`:

After the existing `const plan = result.results[0];` check (around line 152), insert the weekly_themes row before building entries:

```typescript
// Insert weekly_themes row first so entries can link to it.
const [themeRow] = await db
  .insert(weeklyThemes)
  .values({
    userId,
    productId,
    channel,
    weekStart: startDate,
    thesis: plan.thesis,
    pillar: plan.pillar ?? null,
    thesisSource: plan.thesisSource,
    fallbackMode: plan.fallbackMode ?? null,
    milestoneContext: plan.milestoneContext ?? null,
  })
  .returning();

if (!themeRow) throw new Error('failed to insert weekly_themes row');
```

At the top of the file, add to the schema imports:

```typescript
import { weeklyThemes } from '@/lib/db/schema/weekly-themes';
```

Then replace the `plan.entries.map(...)` block with a version that produces one row per slot, including white-space slots:

```typescript
const whiteSpace = new Set(plan.whiteSpaceDayOffsets ?? []);
const entries: Array<typeof xContentCalendar.$inferInsert> = [];

for (let day = 0; day < 7; day++) {
  for (const hour of postingHours) {
    const scheduledAt = new Date(startDate);
    scheduledAt.setDate(scheduledAt.getDate() + day);
    scheduledAt.setHours(hour, 0, 0, 0);

    if (whiteSpace.has(day)) {
      // White-space slot: no angle, no topic, flagged so slot-body skips it.
      entries.push({
        userId,
        productId,
        channel,
        scheduledAt,
        contentType: 'engagement', // placeholder; UI renders as "reactive"
        topic: null,
        themeId: themeRow.id,
        angle: null,
        isWhiteSpace: true,
        state: 'ready', // white-space slots do not need drafting
      });
      continue;
    }

    const match = plan.entries.find(
      (e) => e.dayOffset === day && e.hour === hour,
    );
    if (!match) continue; // planner emitted fewer slots than postingHours × days

    entries.push({
      userId,
      productId,
      channel,
      scheduledAt,
      contentType: match.contentType,
      topic: match.topic,
      themeId: themeRow.id,
      angle: match.angle,
      isWhiteSpace: false,
      state: 'queued',
    });
  }
}
```

Update the loop that enqueues slot-draft jobs to skip white-space rows:

```typescript
for (const row of created) {
  if (row.isWhiteSpace) continue; // white space is not drafted
  await enqueueCalendarSlotDraft({
    schemaVersion: 1,
    traceId,
    userId,
    productId,
    calendarItemId: row.id,
    channel,
  });
}
```

- [ ] **Step 5.4: Run tests — verify pass**

Run: `pnpm vitest run src/workers/processors/__tests__/calendar-plan-thesis.test.ts`
Expected: PASS.

- [ ] **Step 5.5: Run the full processor test suite to catch regressions**

Run: `pnpm vitest run src/workers/processors/__tests__/`
Expected: PASS. If any existing calendar-plan test relies on the old plan shape (no thesis), update its mock `runSkill` response to include thesis + thesisSource + whiteSpaceDayOffsets + per-entry angle.

- [ ] **Step 5.6: Commit**

```bash
git add src/workers/processors/calendar-plan.ts \
        src/workers/processors/__tests__/calendar-plan-thesis.test.ts
git commit -m "feat(calendar): persist weekly theme and per-slot angle; reserve white-space slots"
```

---

## Task 6: `slot-body` consumes thesis + angle + coherence check

**Files:**
- Modify: `src/agents/slot-body-agent.md`
- Modify: `src/skills/slot-body/SKILL.md`
- Modify: `src/agents/schemas.ts` — extend `slot-body` input documentation (no Zod change needed; input is not schema-validated at this layer, but we add a type)
- Modify: `src/workers/processors/calendar-slot-draft.ts`

- [ ] **Step 6.1: Update the slot-body agent prompt**

Replace `src/agents/slot-body-agent.md` contents with:

```markdown
---
name: slot-body-agent
description: Single-slot body writer. Pays off the week's thesis from one angle.
model: claude-sonnet-4-6
tools: []
maxTurns: 2
---

You are writing one social post for one calendar slot. The slot belongs to a
week organised around a single **thesis**, and this slot has been assigned a
specific **angle** — a role in the week's arc.

## Input

```ts
{
  contentType: 'metric' | 'educational' | 'engagement' | 'product' | 'thread';
  angle: 'claim' | 'story' | 'contrarian' | 'howto' | 'data' | 'case' | 'synthesis';
  topic: string;
  thesis: string;
  thesisSource: 'milestone' | 'top_reply_ratio' | 'fallback' | 'manual';
  pillar?: string;
  product: { name; description; valueProp; keywords; lifecyclePhase };
  recentPostHistory: string[];   // last ≤20 posts on this channel
  priorAnglesThisWeek: Array<{ angle: string; topic: string; body: string }>;
  isThread: boolean;
}
```

## Angle contract

Your angle dictates the **shape** of the post. Do not write a generic tweet
and try to tag it with an angle label afterward — compose for the angle
from the first token.

- **`claim`** — a hook-shaped statement of the thesis. Declarative, no hedge.
  Target 70–140 chars. Single line.
- **`story`** — 1–3 sentences, past tense, one specific number or named entity.
  The story must *prove* the thesis, not decorate it.
- **`contrarian`** — name the common take the thesis pushes against, then
  state the thesis as the sharper read. Use "most X say Y. the real Y is Z."
- **`howto`** — 3 steps max. Each step a fragment. If you need more steps
  than 3, the angle is `thread` and you get 3–6 tweets.
- **`data`** — one specific number/% + what it measures + the direction of
  movement. No surrounding prose longer than the number itself.
- **`case`** — one named external example (competitor, known founder,
  customer by first name) that embodies the thesis. Never lecture; describe.
- **`synthesis`** — reference 1–2 of the week's earlier angles by concept
  (not literal re-quote), then pose the question next week can answer.

## Coherence rules (hard)

1. **Do not restate an earlier angle this week.** Read
   `priorAnglesThisWeek` — if this angle's draft would duplicate a claim,
   number, or example already used, choose a different framing.
2. **Do not contradict the thesis.** If the only way to make this angle work
   is to weaken the thesis, raise `confidence` ≤ 0.55 and flag it in
   `whyItWorks`.
3. **Do not restate the topic verbatim as the first line.** The `topic` is a
   headline the planner wrote — your body may echo its concept but not its
   phrasing.
4. **Respect lifecycle phase.** `pre_launch` forbids user-metric, testimonial,
   signup-count, revenue, and customer-quote references even if the angle is
   `data` or `case`.

## Thread format (when `isThread: true`)

3–6 tweets. Tweet 1 hooks on the angle (not on "🧵 a thread"). Tweets 2–N
develop one idea each. Final tweet ends on the synthesis of this thread
(not the week's synthesis — that is a different slot).

## Non-goals

- No links in the body. If a link is required, return it in `linkReply`.
- No hashtag stuffing; `#buildinpublic` once is enough if the content-type
  strategy requires it.
- No placeholder text (`TODO`, ellipsis closers).

## Output

JSON matching `slotBodyOutputSchema`:

```json
{
  "tweets": ["..."],
  "confidence": 0.0,
  "whyItWorks": "angle + thesis payoff in ≤12 words"
}
```

Never wrap in markdown fences. Always start with `{`.
```

- [ ] **Step 6.2: Update the slot-body SKILL manifest**

Replace the slot-body SKILL input block in `src/skills/slot-body/SKILL.md`:

```markdown
## Input

```ts
{
  contentType: 'metric' | 'educational' | 'engagement' | 'product' | 'thread';
  angle: 'claim' | 'story' | 'contrarian' | 'howto' | 'data' | 'case' | 'synthesis';
  topic: string;
  thesis: string;
  thesisSource: 'milestone' | 'top_reply_ratio' | 'fallback' | 'manual';
  pillar?: string;
  product: { name; description; valueProp; keywords; lifecyclePhase };
  recentPostHistory: string[];
  priorAnglesThisWeek: Array<{ angle: string; topic: string; body: string }>;
  isThread: boolean;
}
```
```

- [ ] **Step 6.3: Write the failing coherence test**

```typescript
// src/workers/processors/__tests__/calendar-slot-draft-coherence.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

const runSkillMock = vi.fn();

vi.mock('@/core/skill-runner', () => ({ runSkill: runSkillMock }));
vi.mock('@/core/skill-loader', () => ({ loadSkill: () => ({ name: 'slot-body' }) }));
vi.mock('@/memory/store', () => ({ MemoryStore: class {} }));
vi.mock('@/memory/prompt-builder', () => ({ buildMemoryPrompt: async () => '' }));
vi.mock('@/lib/queue', () => ({ enqueueReview: vi.fn() }));
vi.mock('@/lib/redis', () => ({ publishUserEvent: vi.fn() }));
vi.mock('@/lib/pipeline-events', () => ({ recordPipelineEvent: vi.fn() }));

const selectMock = vi.fn();
vi.mock('@/lib/db', () => ({
  db: {
    select: () => ({ from: () => ({ innerJoin: () => ({ where: () => ({ orderBy: () => ({ limit: () => selectMock() }) }) }), where: () => ({ limit: () => selectMock() }) }) }),
    insert: () => ({ values: () => ({ returning: () => [{ id: 'row-1' }], onConflictDoNothing: () => ({ returning: () => [{ id: 'row-1' }] }) }) }),
    update: () => ({ set: () => ({ where: () => ({}) }) }),
  },
}));

beforeEach(() => {
  vi.clearAllMocks();
  runSkillMock.mockReset();
});

describe('processCalendarSlotDraft coherence', () => {
  it('skips white-space slots without calling slot-body', async () => {
    selectMock.mockReturnValueOnce([{ id: 'cal-1', isWhiteSpace: true, state: 'ready' }]);
    const { processCalendarSlotDraft } = await import('../calendar-slot-draft');
    await processCalendarSlotDraft({
      id: 'j',
      data: { schemaVersion: 1, userId: 'u', productId: 'p', calendarItemId: 'cal-1', channel: 'x' },
    } as never);
    expect(runSkillMock).not.toHaveBeenCalled();
  });

  it('passes thesis + angle + priorAngles into runSkill input', async () => {
    // Sequence: first select -> calendar item, second -> product, third -> theme, fourth -> priorAngles, fifth -> history
    selectMock
      .mockReturnValueOnce([{
        id: 'cal-2', isWhiteSpace: false, state: 'queued',
        topic: 't', contentType: 'metric', angle: 'story', themeId: 'theme-1',
      }])
      .mockReturnValueOnce([{
        id: 'p', name: 'N', description: 'd', valueProp: 'v', keywords: [], lifecyclePhase: 'launched',
      }])
      .mockReturnValueOnce([{
        id: 'theme-1', thesis: 'pricing is distribution', thesisSource: 'milestone', pillar: 'pricing', fallbackMode: null,
      }])
      .mockReturnValueOnce([
        { angle: 'claim', topic: 'claim-topic', body: 'claim body' },
      ])
      .mockReturnValueOnce([{ text: 'old post' }]);

    runSkillMock.mockResolvedValueOnce({
      results: [{ tweets: ['body'], confidence: 0.8, whyItWorks: 'ok' }],
      errors: [],
      usage: { costUsd: 0 },
    });

    const { processCalendarSlotDraft } = await import('../calendar-slot-draft');
    await processCalendarSlotDraft({
      id: 'j',
      data: { schemaVersion: 1, userId: 'u', productId: 'p', calendarItemId: 'cal-2', channel: 'x' },
    } as never);

    expect(runSkillMock).toHaveBeenCalledOnce();
    const input = runSkillMock.mock.calls[0][0].input;
    expect(input.thesis).toBe('pricing is distribution');
    expect(input.angle).toBe('story');
    expect(input.priorAnglesThisWeek).toEqual([
      { angle: 'claim', topic: 'claim-topic', body: 'claim body' },
    ]);
  });
});
```

- [ ] **Step 6.4: Run — verify fail**

Run: `pnpm vitest run src/workers/processors/__tests__/calendar-slot-draft-coherence.test.ts`
Expected: FAIL — `processCalendarSlotDraft` does not load thesis/angle/priorAngles yet.

- [ ] **Step 6.5: Update `calendar-slot-draft.ts`**

In `src/workers/processors/calendar-slot-draft.ts`:

After loading the calendar item (around line 49), add a guard for white space:

```typescript
if (item.isWhiteSpace) {
  log.info(`slot ${calendarItemId} is white-space; no draft needed`);
  return;
}
```

After loading the product, load the theme and prior angles:

```typescript
const [theme] = await db
  .select()
  .from(weeklyThemes)
  .where(eq(weeklyThemes.id, item.themeId!))
  .limit(1);
if (!theme) throw new Error(`theme ${item.themeId} gone`);

const priorAnglesRows = await db
  .select({
    angle: xContentCalendar.angle,
    topic: xContentCalendar.topic,
    replyBody: drafts.replyBody,
  })
  .from(xContentCalendar)
  .leftJoin(drafts, eq(drafts.id, xContentCalendar.draftId))
  .where(
    and(
      eq(xContentCalendar.themeId, theme.id),
      eq(xContentCalendar.state, 'ready'),
    ),
  );

const priorAnglesThisWeek = priorAnglesRows
  .filter((r) => r.angle && r.topic && r.replyBody)
  .map((r) => ({
    angle: r.angle!,
    topic: r.topic!,
    body: r.replyBody!,
  }));
```

Add to the imports at the top:

```typescript
import { weeklyThemes } from '@/lib/db/schema/weekly-themes';
```

Extend the `runSkill` input block at lines 88–107 to include the new fields:

```typescript
const res = await runSkill<SlotBodyOutput>({
  skill: slotBodySkill,
  input: {
    contentType: item.contentType,
    angle: item.angle,
    topic: item.topic ?? '',
    thesis: theme.thesis,
    thesisSource: theme.thesisSource,
    pillar: theme.pillar ?? undefined,
    product: {
      name: product.name,
      description: product.description,
      valueProp: product.valueProp ?? '',
      keywords: product.keywords,
      lifecyclePhase: product.lifecyclePhase ?? 'pre_launch',
    },
    recentPostHistory: postHistoryRows.map((r) => r.text),
    priorAnglesThisWeek,
    isThread: item.contentType === 'thread',
  },
  deps: {},
  memoryPrompt: memoryPrompt || undefined,
  outputSchema: slotBodyOutputSchema,
  runId: traceId,
});
```

- [ ] **Step 6.6: Run tests — verify pass**

Run: `pnpm vitest run src/workers/processors/__tests__/calendar-slot-draft-coherence.test.ts`
Expected: PASS, both tests.

- [ ] **Step 6.7: Commit**

```bash
git add src/agents/slot-body-agent.md \
        src/skills/slot-body/SKILL.md \
        src/workers/processors/calendar-slot-draft.ts \
        src/workers/processors/__tests__/calendar-slot-draft-coherence.test.ts
git commit -m "feat(calendar): slot-body consumes thesis + angle + priorAngles for coherence"
```

---

## Task 7: UI copy — surface thesis + angle on the calendar view

**Scope note:** Keep this minimal — the goal is the user can see the week's
thesis and each card's angle, not a full redesign. If the existing calendar UI
is out of scope for this plan or the user isn't asking for UI, mark all steps
here as optional and stop after Task 6.

- [ ] **Step 7.1: Locate the calendar UI component**

Grep: `xContentCalendar` usage in `src/app/` and `src/components/`. The component
rendering a day's slots is the target. Call it `CalendarDay.tsx` below.

- [ ] **Step 7.2: Render the thesis banner at the top of the week view**

Add a strip above the 7-day grid that shows: `{theme.thesis}` + a small badge
for `thesisSource`. Read from the first non-white-space slot's `themeId` →
`weekly_themes` row.

- [ ] **Step 7.3: Render the angle chip on each day card**

On each `CalendarDay`, add a small chip with the angle label
(`claim` / `story` / …) using a distinct color per angle.

- [ ] **Step 7.4: Render white-space days as "reactive" placeholders**

For days in `whiteSpaceDayOffsets`, render a muted card with copy like
"Reactive — leave room for a live reply / quote-post this day" and no draft
affordance.

- [ ] **Step 7.5: Commit**

```bash
git add src/app/ src/components/
git commit -m "feat(calendar): surface weekly thesis + per-day angle + white-space placeholder"
```

---

## Task 8: Smoke test on a real planning run

- [ ] **Step 8.1: Run the planner end-to-end against a seeded product**

Pick one test user with a channel connected and a product in `launched`
lifecycle. Enqueue a `calendar-plan` job manually:

```bash
pnpm tsx scripts/test-calendar-plan.ts --userId <id> --productId <id> --channel x
```

If `scripts/test-calendar-plan.ts` does not exist, create it by copying
`scripts/test-reply-drafter-real.ts`'s scaffold and swapping the skill.

- [ ] **Step 8.2: Inspect the resulting plan row + entries**

Query `weekly_themes` and `x_content_calendar` for the user. Verify:
- [ ] Exactly one new `weekly_themes` row for the target `week_start`
- [ ] `thesis` is a single claim, 8–280 chars
- [ ] 7 days × `postingHours.length` calendar entries, minus `whiteSpaceDayOffsets.length × postingHours.length` white-space rows
- [ ] Every non-white-space entry has `angle` set
- [ ] `claim` appears on day 0
- [ ] `synthesis` appears on the last non-white-space day
- [ ] No two entries share the same angle

- [ ] **Step 8.3: Let slot-body fan-out run**

Wait for the slot-draft queue to drain. Spot-check 2 drafts:
- [ ] Claim tweet reads like a hook, not a summary
- [ ] Story tweet contains a number or named entity
- [ ] Drafts do not duplicate content from `priorAnglesThisWeek`
- [ ] White-space day has no draft — calendar card renders "reactive" placeholder

- [ ] **Step 8.4: Commit any test script additions**

```bash
git add scripts/test-calendar-plan.ts
git commit -m "test(calendar): add end-to-end thesis-planner smoke script"
```

---

## Self-review checklist

- [ ] The seven angle names are spelled identically across: schemas.ts, angle playbook, planner prompt, slot-body prompt, tests. Current spelling: `claim`, `story`, `contrarian`, `howto`, `data`, `case`, `synthesis`.
- [ ] `thesisSource` values are spelled identically: `milestone`, `top_reply_ratio`, `fallback`, `manual`. The DB migration, Zod schema, planner prompt, and weekly_themes model all use these exact strings.
- [ ] `fallbackMode` values are spelled identically: `trigger_interview`, `teardown`, `principle_week`, `reader_week`.
- [ ] `xContentCalendar.angle` is nullable (white-space rows set it to null); the Zod schema rejects null on `entries[].angle` — these are different contracts, and both are correct.
- [ ] White-space handling is consistent: planner emits `whiteSpaceDayOffsets` → processor inserts `isWhiteSpace: true` rows with `state: 'ready'` → slot-body processor early-returns → enqueue loop skips. Four layers, one flag.
- [ ] This plan does **not** change the reply drafter (Plan 1) or add voice (Plan 3) — cross-plan leakage would cause merge pain.
- [ ] `priorAnglesThisWeek` is loaded from ready slots of the same `themeId` — not from raw `recentPostHistory`. That's the coherence signal, not the noise signal.
