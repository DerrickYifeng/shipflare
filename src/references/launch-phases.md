# Launch phases reference

The six-phase taxonomy ShipFlare uses to reason about a product's position
on the launch timeline. Every plan item, strategic path, and agent prompt
routes off the `launch_phase` enum below, so the definitions here are the
contract every surface agrees on.

Derived at runtime by `derivePhase({ state, launchDate, launchedAt })` in
`src/lib/launch-phase.ts`. Agents consume the already-derived value as the
prompt variable `{{currentPhase}}`.

## Enum

```text
foundation | audience | momentum | launch | compound | steady
```

## Derivation

The three columns on `products` drive the mapping:

- `state: 'mvp' | 'launching' | 'launched'`
- `launchDate: timestamp | null`     — user-set target
- `launchedAt: timestamp | null`     — auto-set on launch day

Rules (first match wins):

1. `state = 'launched'` and `launchedAt within last 30 days` → `compound`
2. `state = 'launched'` (else) → `steady`
3. No `launchDate` → `foundation`
4. `launchDate <= now` → `launch`
5. `launchDate <= now + 7d` → `momentum`
6. `launchDate <= now + 28d` → `audience`
7. Otherwise → `foundation`

Boundaries are tested in `src/lib/__tests__/launch-phase.test.ts` at
T-0 / T-7 / T-28 / T+30 against all three product states.

## Phase definitions

### 1. foundation

**When:** still building the product; either no launch date set or the
set date is more than 28 days out.

**Objective:** de-risk the build and plant the first seeds of an audience.
The goal is not posts — it's clarity on positioning and the starter set of
people who care. Treat the next 2-6 weeks as pre-work.

**Typical activities:**
- Positioning: tagline, one-liner, ICP, three competitor alternatives.
- Light build-in-public: 2-3 posts/week about the problem, not the product.
- Founder-led interviews: 3-5 user conversations about the status quo pain.
- Initial waitlist / landing page with a clear value prop and email capture.
- Voice-profile scan to seed the tactical planner with the founder's style.

**What to avoid:**
- Polished demos. The product probably isn't ready. Talking about the
  problem is safer and louder.
- Announcing a launch date in public until it's been privately validated.

**Health signals:**
- 3-5 interview notes on file.
- Waitlist growing without paid acquisition.
- One sentence that survives being read back to three different user types.

### 2. audience

**When:** `launchDate` is set and is 8-28 days out.

**Objective:** build a launch-ready audience. This is the phase where
weekly rhythm matters most — the audience compounds on repeat exposure,
so missing a week is expensive.

**Typical activities:**
- 4-6 X posts per week organized around 3-4 content pillars.
- 1-2 Reddit posts per week in 2-3 target communities.
- Build-in-public milestones: screenshot X, dogfooding story, contrarian claim.
- Waitlist check-ins and email cadence (welcome + one value email).
- Pre-warm top supporters: identify 10-30 accounts likely to amplify launch.

**What to avoid:**
- Generic marketing content. This audience is showing up for the founder's
  thinking, not for press release prose.
- Letting the content calendar slip. Each missed week is ~10% of the window.

**Health signals:**
- Waitlist is growing week over week.
- Target platform followers trending up.
- Top supporters replying to posts (not just liking).

### 3. momentum

**When:** `launchDate` is set and is 1-7 days out.

**Objective:** maximize launch-day reach. The audience is roughly built —
now tighten the message and stage every asset.

**Typical activities:**
- Daily X posts tied directly to the thesis of the launch.
- Hunter outreach: DM 20-40 hunters with a personalized note.
- Product Hunt / launch platform prep: gallery images, taglines, 30s video,
  first comment, maker comment draft.
- Launch-day runsheet: hourly posts from T-0 through T+12.
- Schedule reminder email for the waitlist 24h before and 1h before launch.

**What to avoid:**
- New content themes. Stick to the thesis the audience has been primed on.
- Sleep on launch eve. Quiet, sure — but not new.

**Health signals:**
- Runsheet drafted and approved.
- ≥ 10 hunters confirmed for day-of support.
- Launch-day assets (images / video) sitting in the drafts queue.

### 4. launch

**When:** `launchDate <= now` AND `state != 'launched'`. The day itself,
plus the few hours it takes for the launchedAt flip to land.

**Objective:** execute the runsheet. Everything is pre-decided; this is
the day the planner hands control to the hourly runsheet beats.

**Typical activities:**
- Execute runsheet beats on schedule (maker comment, waitlist email,
  hunter nudge, milestone update posts).
- Reply fast: the 15-minute reply window on big accounts is 10x the normal
  algorithmic value today.
- Log every delta — what's driving upvotes, which supporters showed up.

**What to avoid:**
- Improvised new assets. Scheduling works; last-minute shipping doesn't.
- Responding to critical comments without the escalation path decided.

**Health signals:**
- Runsheet beats completing in sequence.
- Launch-day posts breaking normal engagement baselines by ≥ 5x.
- Replies flowing, not queued.

### 5. compound

**When:** `state = 'launched'` AND `launchedAt within last 30 days`.

**Objective:** convert the launch-day audience into durable retention and
compounding reach. The first 30 days after launch are when press, follow-on
coverage, and the founder's thesis land with the most weight.

**Typical activities:**
- Retrospective post on Day 3 — what worked, what surprised you.
- Second wave to communities that didn't catch the launch-day spike.
- User interviews shift from "would you use this" to "why did you stay".
- Thank-you email to early supporters with a small case-study ask.
- Start computing weekly analytics — bookmarks, share of voice, retention.
- Plan the next milestone (v1.1, a new segment, a pricing experiment).

**What to avoid:**
- Silence. The worst post-launch pattern is to stop posting because the
  spike is over. The compounding audience is still watching.
- Big pivots. Let the data breathe before shifting direction.

**Health signals:**
- Week-2 engagement trending above pre-launch baseline, not below.
- Case-study ask converting at >30%.
- Clear next-milestone brief written by day 21.

### 6. steady

**When:** `state = 'launched'` AND `launchedAt more than 30 days ago`.

**Objective:** durable, repeatable content + community growth. There will
be new launches inside steady (v2, a new feature, a new segment) but the
default posture is no-launch, cadence-driven.

**Typical activities:**
- Weekly rhythm: 3-5 posts and 1-2 reply sessions per week.
- Milestone-to-angle generation: every product ship becomes a post series.
- Quarterly re-plan: regenerate the strategic path with fresh data.
- Analytics summary weekly — what content types and hours outperform.
- Re-activate lapsed users via cohort emails tied to shipped features.

**What to avoid:**
- Auto-posting without voice-profile updates. Steady-state content without a
  feedback loop becomes a drift risk.
- Skipping the quarterly replan. Steady isn't static.

**Health signals:**
- Monthly follower growth within a target band.
- Engagement rate per post holding steady or trending up.
- Analytics summary referenced in planning — not just filed.

## Using the phase in an agent prompt

Agents that schedule or draft content receive `currentPhase` as a top-level
prompt variable. Typical consumption pattern:

```text
Product state: {{productState}}
Current phase: {{currentPhase}}
Launch date: {{launchDateHuman}}

Apply the phase-specific rules from `launch-phases.md` when choosing
angle, tone, and call-to-action.
```

Agents should treat the phase as a hard constraint on **which activities
belong in the plan**, not as a soft hint. A tactical planner in `foundation`
does not schedule launch-day runsheet beats; a planner in `momentum` does
not drift back into general build-in-public.

## What the phase does NOT decide

- Voice. Voice is orthogonal to phase; it's the founder's extracted style.
- Platform mix. That lives on `strategic_paths.channelMix`. The phase
  affects the *intensity* of each platform's cadence, not which platforms
  are active.
- Which skill runs. Skill routing lives in `plan_items.skillName` and is
  chosen by the tactical planner based on `kind` + channel, not phase.

## When the phase changes mid-plan

`derivePhase` is a pure function of three product columns plus `now`. The
phase can flip under a live plan (T-8 → T-7 crosses the `momentum`
boundary). The plan-execute state machine handles this by marking
`plan_items` whose `phase` no longer matches the currently-derived phase
as `stale`, so the tactical replan pass can either re-issue them with the
new phase or drop them altogether. The planner does not rewrite past
items — completed work stays attributed to its original phase.
