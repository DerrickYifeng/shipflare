# Agent / Skill / Tool Decomposition Standard & Migration

**Date:** 2026-05-01
**Status:** Design approved, ready for implementation plan.
**Related:** `docs/superpowers/specs/2026-04-30-skill-primitive-restoration-design.md`
(Skill primitive restoration phase 1 — landed at merge `d5798aa`. This
spec extends that work with the canonical decomposition standard and the
agent-by-agent migration that applies it.)

---

## Summary

Codify a **single decision rule** for when new functionality should ship
as an agent, a skill, or a tool — and migrate existing primitives to
match. Today the boundary is informal, which has produced four concrete
pain points:

- **A. Agent bloat.** `community-manager` (235 lines) and `post-writer`
  (220 lines) embed voice / slop / template rules directly in their
  AGENT.md prompts. Iterating one rule means rereading the whole agent.
- **B. Rule duplication.** The same slop heuristics live in three
  places: `community-manager/references/reply-quality-bar.md` (300
  lines, applied at write-time), `reviewing-drafts/references/` (applied
  at review-time), and `src/lib/reply/ai-slop-validator.ts` (regex pack
  that is currently unwired dead code).
- **D. Fork-call cost.** Skill decomposition multiplies LLM calls per
  artifact. We need a budget so the "everything is a skill" pattern
  doesn't bankrupt the per-draft cost ceiling.
- **E. Same-turn write/review rationalization.** Today `community-manager`
  writes a draft and self-checks against banned patterns in the *same
  LLM turn*. The drafter rationalizes its own slop past the self-check.
  All 12 pending drafts in production today share this failure mode.
  (Independent finding: `enqueueReview` is currently only fired by the
  X-mention-engagement path, so the existing `reviewing-drafts` skill
  never runs on community-manager / post-writer output.)

This spec:

1. Defines the standard for the three primitives.
2. Audits the six existing agents against it.
3. Lays out an 8-step migration plan, ordered by risk-low / value-high.
4. Specifies the CLAUDE.md addendum that locks the standard going forward.

The spec does **not** rewrite individual reference markdown content
(BAD/GOOD slop pairs, voice cluster definitions). Those edits land
inside their respective migration steps where the new skill files are
created.

---

## 1. The Standard

### 1.1 Definitions

**Tool** — A callable in `src/tools/` whose contract is:
- Either a deterministic function (DB query, API call, regex validator,
  persistence write) **or** a thin LLM wrapper for one well-defined
  transformation that carries no business rules of its own.
- I/O validated by Zod schemas. Stateless. Concurrency-safe unless
  explicitly flagged otherwise.
- Does not read markdown reference files. Does not make taste judgments.
- Examples: `find_threads`, `validate_draft` (mechanical layer only),
  `draft_reply` (persistence), `query_plan_items`.

**Skill** — A directory under `src/skills/<gerund-name>/` with a
`SKILL.md` whose contract is:
- A **single LLM fork call** that takes typed input and produces typed
  output.
- Business rules live in `references/*.md` files alongside the SKILL.md
  and are loaded progressively on demand.
- May call tools internally. **Does not branch decisions across turns.**
  Does not call SendMessage. Does not spawn sub-agents.
- One concrete action per skill (one input → one output).
- Examples (existing): `reviewing-drafts`, `posting-to-platform`,
  `monitoring-engagement`. Examples (to-be-created): `drafting-reply`,
  `drafting-post`, `validating-draft`, `judging-opportunity`.

**Agent** — A directory under `src/tools/AgentTool/agents/<name>/` with
an `AGENT.md` whose contract is:
- A multi-turn LLM loop that **branches based on prior-turn results**.
- Orchestrates tools and skills. Decides which to call when, and when
  to stop.
- May SendMessage to a coordinator and may spawn sub-agents via Task.
- AGENT.md contains **only orchestration logic** — invocation order,
  branch conditions, stop conditions, error escalation. No embedded
  business rules.
- Examples (existing, kept): `coordinator`, `content-planner`,
  `discovery-agent`, `community-manager` (post-migration, thinned).

### 1.2 Decision tree

```
Does this require LLM judgment?
├─ No → Tool
└─ Yes → Does it require cross-turn decisions / branching / SendMessage / spawning?
   ├─ No  → Skill
   └─ Yes → Agent
```

A multi-turn agent is justified **only when the loop itself is the
work** — for example, conversational refinement against an external API
(`discovery-agent` ↔ xAI Grok), goal decomposition across specialists
(`coordinator`), or cross-channel allocation with feedback signals
(`content-planner`). A "12-turn agent that writes one artifact" is a
skill in agent clothing.

### 1.3 Hard rules

These prevent the standard from rotting. Violation should be flagged in
code review.

1. **AGENT.md contains no embedded business rules.** No banned-vocabulary
   lists, voice descriptions, slop pattern enumerations, or "the real X
   is Y is forbidden"-style prose. These belong in skill references. An
   AGENT.md should answer the question "*how do I orchestrate?*", not
   "*what is good content?*".
2. **Each rule has exactly one owner.** A given slop pattern (e.g. the
   diagnostic-from-above frame) lives in exactly one place — either a
   skill reference markdown or a tool's regex. Cross-references are
   fine; copies are not.
3. **Drafting and validating must run in different fork calls.** The
   skill that drafts content does not also produce the final
   pass/fail verdict on that same content. The orchestrating agent (or
   the worker pipeline for post-persistence review) calls a separate
   `validating-*` skill in a fresh fork. Retry loops on REVISE verdicts
   are owned by the agent, not the drafting skill.

### 1.4 Per-artifact cost ceiling

Counted in **fork-skill calls** (not the orchestrating agent's own loop
turns, which are amortized across artifacts in a sweep). For one
user-facing artifact (one reply draft, one original post draft):

- **Default ceiling: 3 fork-skill calls** — `judging-opportunity` +
  `drafting-*` + `validating-draft`. The judging skill is allowed to
  short-circuit: if it returns "skip", no drafting/validating fires
  and the per-artifact cost collapses to 1.
- **Maximum with one REVISE retry: 5 fork-skill calls** — judging +
  drafting + validating + drafting (with feedback) + validating. No
  second retry.
- Pipelines that don't have a gating step (e.g. `drafting-post` called
  for an already-allocated `plan_item`) skip the judging slot:
  default 2, max 4 with REVISE.
- Agents that produce many artifacts (a `community-manager` sweep
  drafting 5 replies) multiply per artifact, plus the agent's own
  loop turns to orchestrate. A thin orchestrator agent should use
  ≤2 of its own LLM turns per artifact.

If a proposed design requires more than one REVISE retry, treat it as a
signal that the drafting skill's rules need to be tightened — not as a
license to add a third pass.

---

## 2. Audit Findings

The six existing agents, evaluated against §1.

| Agent | Today | Cross-turn branching? | Verdict | Rules to extract |
|---|---|---|---|---|
| `coordinator` | 25 turns, decomposes founder goals, delegates via Task | Yes — chooses specialists based on goal shape and prior outputs | **Keep agent**, audit prompt for embedded rules | Identified during Step 8 (extracted into existing or new skills as audit reveals) |
| `growth-strategist` | 10 turns, generates 30-day strategic narrative | No — single transformation | **Convert to skill** `generating-strategy` | The full 78-line prompt becomes the skill's reference |
| `content-planner` | 20 turns, allocates plan_items across channels | Yes — reads stalled items / completions, adjusts allocation | **Keep agent (thinned)** | `allocating-plan-items` skill (allocation rules), kept agent shrinks ~186 → ~80 lines |
| `discovery-agent` | 60 turns, conversational refinement with xAI Grok | Yes — strong, the loop *is* the work | **Keep agent** | `judging-thread-quality` skill (per-candidate scoring), kept agent shrinks ~164 → ~120 lines |
| `post-writer` | 12 turns, drafts one post + validates + retries once | No — fixed 4-step flow | **Convert to skill `drafting-post`** (caller orchestrates retry) OR optional thin agent (~50 lines) for retry loop | All voice / phase / template rules become `drafting-post` references |
| `community-manager` | 16 turns, drafts replies for a thread set | Yes — at sweep level (target count, escalation), no at per-thread level | **Keep agent (heavily thinned)** | `judging-opportunity`, `drafting-reply`, `validating-draft` (shared); kept agent shrinks ~235 → ~60 lines |

### 2.1 New skills to create

Ordered by reuse footprint (skills used by multiple call sites first):

| New skill | Used by | Sources today |
|---|---|---|
| `validating-draft` | community-manager, post-writer, review.ts worker | `reviewing-drafts` (renamed/upgraded), `community-manager/references/reply-quality-bar.md` (slop layer), `src/lib/reply/ai-slop-validator.ts` (currently dead, regex pack feeds the reference content) |
| `drafting-reply` | community-manager, engagement.ts | `community-manager/AGENT.md` (drafting block), `reply-quality-bar.md` (voice / anchor / length layer) |
| `drafting-post` | content-planner, coordinator, post-writer (if kept) | `post-writer/AGENT.md` (drafting block), `post-writer/references/x-content-guide.md`, `reddit-content-guide.md`, `content-safety.md` |
| `judging-opportunity` | community-manager | `community-manager/references/reply-quality-bar.md` (gates 1/2/3 layer), `opportunity-judgment.md` |
| `judging-thread-quality` | discovery-agent | (extracted from `discovery-agent/AGENT.md`) |
| `allocating-plan-items` | content-planner | (extracted from `content-planner/AGENT.md`) |
| `generating-strategy` | (replaces `growth-strategist` agent) | Full `growth-strategist/AGENT.md` body |

### 2.2 Tool changes

- `validate_draft` shrinks to mechanical-only: length (twitter-text
  weighted), sibling-platform leak, hashtag count bounds, URLs in
  reply body. Editorial / slop / voice judgments move to
  `validating-draft` skill. Regex patterns from
  `ai-slop-validator.ts` may stay here as a fast pre-filter, but the
  authoritative judgment is the skill's.
- `DraftReplyTool` gains an `enqueueReview()` call after successful
  persistence. Closes the gap where the existing review skill never
  ran on community-manager output.
- `DraftPostTool` is **not** changed in this migration. Discovered
  during Phase A execution that posts persist to
  `plan_items.output.draft_body` (not the `drafts` table), and the
  review queue requires a `draftId`. Wiring posts into the review
  pipeline is a separate architectural decision tracked as a
  follow-up (see plan §A "Post-review-pipeline follow-up"). For
  this migration, posts continue to rely on the `validate_draft`
  tool's mechanical layer and skip the LLM `validating-draft` pass.

### 2.3 What does not change

- Tool contracts otherwise (`find_threads`, `query_plan_items`,
  `query_product_context`, the persistence tools, the platform clients)
  remain as-is.
- BullMQ queue names, worker concurrency, and the `review.ts`
  processor's verdict-routing logic stay the same. The processor just
  begins receiving work it was previously starved of, and the skill it
  invokes is upgraded.
- The skill primitive runtime (`runForkSkill`, `_bundled` registry,
  fork SDK harness) defined in the 2026-04-30 spec is not modified.

---

## 3. Migration Plan

Ordered for incremental verification. Each step ships independently and
each step has a measurable verification gate.

### Step 0 — Wire `enqueueReview` into reply persistence
**Scope:** `DraftReplyTool.ts` adds one
`enqueueReview({ userId, draftId, productId, ...traceIdPart })` call
after successful insert (both fresh-insert and idempotent-update
branches). The existing `engagement.ts` call site stays. `DraftPostTool`
is intentionally untouched — see §2.2 and the plan's "Post-review-pipeline
follow-up" note for the architectural reason.

**Verification:** Replay script reads the 12 currently-pending
production drafts and runs them through the existing
`reviewing-drafts` skill. Records each verdict + score as the baseline.
Expectation: pre-Step-1 the existing rubric catches some but not all
of the 9 failure patterns identified in DB review.

**Effort:** < 1 hour TS + ~30 min replay script.

### Step 1 — Upgrade `validating-draft` skill (was `reviewing-drafts`)
**Scope:**
- Rename skill directory to `src/skills/validating-draft/` (update
  bundled index, update workers/processors/review.ts skill name).
- Rewrite `references/` as BAD/GOOD pairs grounded in real DB samples.
- Add 6 new structured checks: diagnostic-from-above frame, missing
  first-person on generalized claims, fortune-cookie aphorism
  closer, naked-number unsourced claims, em-dash count ≥ 2,
  colon-aphorism opener.
- Migrate regex packs from `ai-slop-validator.ts` into reference
  prose form. Keep the `.ts` file as a fast pre-filter inside
  `validate_draft` tool (optional belt-and-suspenders).
- Schema gains `slopFingerprint: string[]` field listing matched
  patterns for telemetry.
- Bump model from `claude-haiku-4-5` to `claude-sonnet-4-6` (taste
  task, Haiku falls into the same rationalization mode as the
  drafter).

**Verification:** Re-run the Step 0 replay script. Expectation: the
production failure samples land at FAIL or REVISE verdicts, with the
`slopFingerprint` field naming the matched pattern(s).

**Effort:** ~half-day (markdown-heavy).

### Step 2 — Extract `drafting-reply` skill, thin `community-manager`
**Scope:**
- Create `src/skills/drafting-reply/SKILL.md` plus
  `references/x-reply-voice.md`, `references/reddit-reply-voice.md`.
  Move all voice / anchor / length rules from
  `community-manager/references/reply-quality-bar.md` into these
  references. Schema: input `{thread, product, voice?, channel}`,
  output `{draftBody, whyItWorks, confidence}`.
- Cut `community-manager/AGENT.md` to ~60 lines — only orchestration
  remains (per-thread loop, REVISE retry, escalation, sweep
  termination).
- `reply-quality-bar.md` is split: gate 1/2/3 logic stays in
  community-manager's references; voice/anchor logic is deleted (now
  lives in drafting-reply).
- community-manager's per-thread workflow becomes:
  `judging-opportunity` (Step 4) → `drafting-reply` →
  `validating-draft` → on REVISE, `drafting-reply` once more with
  feedback → `validating-draft` → persist via `draft_reply`.
  Until Step 4 lands, gates 1/2/3 stay inline.

**Verification:** Run a daily reply slot end-to-end. Compare drafts
against the failure-mode rate seen pre-migration: first-person token
presence rate, "the real X is Y" pattern occurrence, em-dash overuse,
fortune-cookie closer occurrence. All should drop.

**Effort:** ~1 day.

### Step 3 — Extract `drafting-post` skill, decide `post-writer` fate
**Scope:** Same shape as Step 2 for original posts.
- Create `src/skills/drafting-post/SKILL.md` plus
  `references/x-post-voice.md`, `references/reddit-post-voice.md`,
  `references/content-safety.md`. The voice cluster table, phase
  playbook, and templates from `post-writer/references/x-content-guide.md`
  move here.
- Decision: keep a 50-line `post-writer` agent that owns the
  draft → validate → REVISE → persist orchestration; **or** delete
  the agent and let `coordinator` / `content-planner` call the skill
  directly. Default to the thin agent unless the call site review in
  Step 6 shows it's redundant.

**Verification:** Same shape as Step 2 — same metrics on post drafts.

**Effort:** ~1 day.

### Step 4 — Extract `judging-opportunity` skill
**Scope:** Move gate 1/2/3 + canMentionProduct logic from
`community-manager/references/reply-quality-bar.md` and
`opportunity-judgment.md` into a new
`src/skills/judging-opportunity/SKILL.md`. Schema: input
`{thread, product, platform}`, output
`{pass: boolean, gateFailed?: 1|2|3, canMentionProduct: boolean, signal: string}`.
community-manager's per-thread workflow (Step 2's output) now starts
with this skill instead of inline judgment.

**Verification:** Skip-rate distribution per gate should match
pre-migration (sweep summaries record gate failures already).

**Effort:** ~half-day.

### Step 5 — Convert `growth-strategist` agent to `generating-strategy` skill
**Scope:** Cleanest single-transformation case. New skill
`src/skills/generating-strategy/SKILL.md` carries the full agent
prompt. Delete the agent directory. Update callers (whoever spawned
`growth-strategist` via Task) to call the skill instead.

**Verification:** Side-by-side comparison on a sample product —
strategic outputs should be equivalent or improved.

**Effort:** ~half-day.

### Step 6 — Extract `allocating-plan-items` from `content-planner`
**Scope:** Move plan-item allocation rules (channel mix, scheduledAt
distribution, phase-aware constraints) into a new
`src/skills/allocating-plan-items/SKILL.md`. Agent shrinks to:
load signals via tools → call `allocating-plan-items` → write
plan_items. Agent stays multi-turn because the signal-gathering is
genuinely iterative.

**Verification:** Generated plan_items distribution should match
pre-migration on identical input signals.

**Effort:** ~half-day.

### Step 7 — Extract `judging-thread-quality` from `discovery-agent`
**Scope:** Each Grok response yields candidate threads. Move the
"is this thread a worth queuing" judgment into a skill. The 60-turn
conversational refinement loop stays in the agent — it's the
canonical case where the loop is the work.

**Verification:** Per-turn thread-acceptance rate should match
pre-migration on identical Grok responses.

**Effort:** ~half-day.

### Step 8 — `coordinator` embedded-rule audit
**Scope:** Read all 229 lines of `coordinator/AGENT.md`. Anything
that says "what makes a thread high priority", "what kind of mention
should escalate", or other taste judgment is extracted into either an
existing or new skill. Pure delegation logic stays.

**Verification:** Coordinator behavior is unchanged on the standard
test prompts in `coordinator/__tests__/`.

**Effort:** ~half-day.

---

## 4. CLAUDE.md Addendum

Insert the following section into `CLAUDE.md` immediately after the
existing **Skill Primitive** section. The text below is the canonical
form to commit.

```markdown
## Primitive Boundaries — Tool / Skill / Agent

ShipFlare's multi-agent system has three primitives. The boundary
between them is enforced by the rules below — code review should
reject violations.

### Decision rule

When adding new functionality, answer two questions:

1. **Does this require LLM judgment?**
   - No → **Tool** (deterministic function, regex, DB write,
     API call, or thin LLM wrapper that carries no business rules).
2. **Does this require cross-turn decisions, branching based on prior
   turns, SendMessage, or spawning sub-agents?**
   - No → **Skill** (single fork call, rules in markdown references).
   - Yes → **Agent** (multi-turn loop, orchestration only).

A multi-turn agent is justified only when the loop itself is the
work — conversational refinement, goal decomposition, cross-channel
allocation with feedback signals. "A 12-turn agent that writes one
artifact" is a skill in agent clothing; convert it.

### Hard rules

1. **AGENT.md contains no embedded business rules.** No banned
   vocabulary lists, voice descriptions, slop pattern enumerations,
   or "the real X is Y is forbidden" prose. AGENT.md answers
   "*how do I orchestrate?*", not "*what is good content?*". All
   rules live in `src/skills/<name>/references/*.md` or as regex in
   tools.

2. **Each rule has exactly one owner.** A given pattern lives in
   exactly one place — one skill reference, or one tool's regex.
   Cross-references between docs are fine; copies are not. Before
   adding a rule, grep for prior art and extend the existing owner.

3. **Drafting and validating run in different fork calls.** The
   skill that drafts content does not produce the final pass/fail
   verdict on that same content. The orchestrating agent (or the
   review worker for post-persistence) invokes a separate
   `validating-*` skill in a fresh fork. REVISE retry loops belong
   to the agent, not the drafting skill.

### Per-artifact cost ceiling

Counted in fork-skill calls; the orchestrating agent's own loop
turns are amortized across artifacts in a sweep.

- **Default: 3 fork-skill calls** (judging + drafting + validating).
  The judging skill may short-circuit "skip"; the per-artifact cost
  collapses to 1 in that case.
- **Max with one REVISE retry: 5 fork-skill calls.**
- Pipelines without a gating skill (e.g. `drafting-post` for an
  already-allocated plan_item) use 2 default / 4 with REVISE.
- More retries are not allowed; tighten the drafting skill's rules
  instead.

Sweeps that produce multiple artifacts multiply per artifact.

### When in doubt, default to skill

If you are considering adding a new agent: first ask whether 1
existing agent + 1-2 new skills could express the same work. The
default answer is yes.
```

---

## 5. Verification Strategy

Three classes of verification across the migration:

### 5.1 Replay-baseline-then-compare

For Steps 0, 1, 2, 3: a one-off replay script reads the 12 production
drafts plus a frozen sample of historical drafts, runs each through
the current and post-migration pipeline, and compares verdicts. The
script lives in `scripts/replay-validating-draft.ts` and is run
manually at each step's verification gate.

### 5.2 Distributional check on live runs

For Steps 4, 5, 6, 7: the migration changes which primitive does the
work but should not change the distribution of outcomes on identical
inputs. Run a single full sweep / planning cycle / discovery loop
pre-migration, capture the structured outputs, run again
post-migration on the same inputs, diff structurally.

### 5.3 Test parity

Each new skill ships with a per-skill `__tests__/<name>.test.ts`
mirroring the existing `_demo-echo-inline` template. Each shrunk
agent retains its current tests; if a test exercised an embedded rule
that has now moved to a skill, the test moves with the rule.

---

## 6. Out of Scope

- Rewriting the strategic-planner / tactical-planner two-tier model
  (settled in 2026-04-20 spec).
- Changing the BullMQ queue topology or worker concurrency.
- Changing skill-runtime mechanics (`runForkSkill`, bundled registry).
- Cross-platform expansion to LinkedIn / TikTok — orthogonal, follows
  the new-platform checklist in CLAUDE.md.
- Voice-block / founder-voice extraction logic (separate work).

---

## 7. Risks and Mitigations

**R1. Cost regression.** Per-draft fork calls grow from ~1 to ~3.
Mitigation: the cost ceiling in §1.4 is explicit and visible. We
measure before/after on a sample sweep at Step 2 and abort Step 3 if
real cost exceeds projection by >2x.

**R2. Quality regression at split-point.** Moving rules from one prompt
to another can drop quality if the new prompt loses context. Mitigation:
each migration step has a verification gate that compares
distributional outcomes; we don't proceed past a gate that regresses.

**R3. Migration partial-state confusion.** Steps 2-7 each touch agents
that are simultaneously in production. Mitigation: each step is a
single PR, and each new skill is shadow-callable before the agent
switches over (skill exists and is tested, but the AGENT.md still
calls the inline path until the migration commit flips).

**R4. AGENT.md grows back.** Without enforcement, prompts will accrete
rules again. Mitigation: the CLAUDE.md addendum explicitly bans
embedded rules; code review rejects PRs that add them.

---

## 8. Open Questions

None. All decisions captured above were settled during brainstorming.
This spec is ready for the writing-plans skill to convert into an
executable implementation plan.
