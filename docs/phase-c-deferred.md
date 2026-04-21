# Phase C — deferred to Phase E

Phase C (2026-04-21, branch `dev`, commits `ee2f9ca`..`8a4c1f5`) shipped the
v3 team-run path as the primary onboarding + replan driver but deliberately
left a handful of v2 artifacts alive because their one remaining caller —
`/api/product/phase` — stays on the legacy skill-runner path until Phase
D/E. This document is the audit trail so Phase E knows what to clean up.

**Phase E Day 3 update (2026-04-21, commits `5ec0202` + the planner-
deletion commit + `6573f74`)**: the deferred planner cleanup is DONE.
`/api/product/phase` migrated to team-run (trigger='phase_transition'),
all v2 planner SKILL/agent files + `tacticalPlan*` schema exports +
equivalence-eval test deleted. The remaining Phase E work (Task #23):
migrate the 9 non-planner `runSkill` callers off and delete
`src/core/skill-runner.ts` + `src/core/skill-loader.ts`.

## What Phase C removed

- **Worker + queue**: `src/workers/processors/tactical-generate.ts`,
  `src/lib/queue/tactical-generate.ts`, `tacticalGenerateQueue` /
  `enqueueTacticalGenerate` re-exports from `src/lib/queue/index.ts`, the
  `tactical-generate` registration in `src/workers/index.ts`.
- **Orchestration**: `src/core/swarm.ts` (320 lines). `SwarmCoordinator`,
  `fanOut`, `fanOutCached` all gone.
- **Sanitizer**: `STRIPPED_KEYS`, `UnexpressibleSchemaError`,
  `sanitizeJsonSchemaForAnthropic`, `zodToSanitizedJsonSchema` and both
  `jsonSchemaForOutput` branches from `src/core/query-loop.ts`; the
  `outputSchema` / `output_config.format` wiring from
  `src/core/api-client.ts::createMessage` + `sideQuery`; the three
  downstream callers that fed raw JSON schemas to `createMessage`
  (`src/lib/discovery/judge.ts`, `src/lib/discovery/optimizer.ts`,
  `src/lib/x-author-filter.ts`) stripped of their local schema consts.
- **Catalog**: `strategic-planner` + `tactical-planner` entries in
  `src/skills/_catalog.ts` plus the two local input-schema consts
  (`strategicPlannerInput`, `tacticalPlannerInput`) that only those
  entries used; imports of `strategicPathSchema` + `tacticalPlanSchema`
  from `@/agents/schemas` dropped from the same file.
- **Fan-out branch**: `src/core/skill-runner.ts` trimmed from ~260 lines to
  ~115 — the single-agent dispatch loop is all that remains. No
  production SKILL.md ever declared `fan-out:`, so the code path was
  cold.

## What Phase C intentionally kept (Phase E picks these up)

### Files preserved because `/api/product/phase` loads them via loadSkill

- `src/agents/strategic-planner.md`
- `src/agents/tactical-planner.md`
- `src/skills/strategic-planner/` (SKILL.md + references + __tests__)
- `src/skills/tactical-planner/` (SKILL.md + references + __tests__)
- `scripts/test-strategic.ts`, `scripts/test-tactical.ts` (dogfood CLIs
  that use the same skill dirs; cheap to keep, no runtime cost).

### Exports preserved in `src/agents/schemas.ts`

- `tacticalPlanSchema`, `tacticalPlanItemSchema`, `TacticalPlan`,
  `TacticalPlanItem` — consumed by `/api/product/phase` + back-compat
  `plan: tacticalPlanSchema.optional()` in `/api/onboarding/commit` +
  onboarding UI stage-plan + the equivalence-eval test.
- All other `*OutputSchema` exports (discovery, draft-*, reply-*, etc.)
  back skills that Phase E deletes.

### Module kept because 10+ non-planner callers use it

`src/core/skill-runner.ts` + `src/core/skill-loader.ts` — imported by 9
production workers (`posting`, `voice-extract`, `search-source`, `review`,
`reply-hardening`, `calibrate-discovery`, `monitor` indirectly, plus
`src/core/pipelines/full-scan.ts` and the 2 CLI scripts in `src/scripts/`),
plus `/api/product/phase` and the Phase C equivalence eval test. Phase E
migrates those callers onto the AgentTool / Task path and then deletes
both files.

## Grep sweep (2026-04-21 22:15 UTC) — expected results

Run from repo root with `rg`:

| Pattern | Expected hit count | Found | Verdict |
|---|---|---|---|
| `from.*@/core/skill-runner` (in `src/`) | 11 (9 processors + 2 scripts + /api/product/phase + eval) | 11 | ✓ |
| `from.*@/core/skill-loader` (in `src/`) | 12 (same 11 + the draft-single-post load smoke test) | 12 | ✓ |
| `from.*@/core/swarm` (in `src/`) | 0 | 0 | ✓ |
| `STRIPPED_KEYS\|UnexpressibleSchemaError\|sanitizeJsonSchemaForAnthropic\|zodToSanitizedJsonSchema` (in `src/`) | 0 | 0 | ✓ |
| `output_config\.format\|jsonSchemaForOutput` (in `src/`) | 3 (comments only) | 3 | ✓ |
| `SHIPFLARE_TERMINAL_TOOL_AGENTS` (in `src/`) | 0 | 0 | ✓ |
| `strategic-planner\.md\|tactical-planner\.md` (in `src/`) | 3 (provenance comments in AgentTool references) | 3 | ✓ |
| `tacticalPlanSchema\|TacticalPlan` (in `src/`) | kept (deferred to Phase E) | 30+ | ✓ intentional |

## Phase E cleanup checklist (owner: backend-engineer-1)

When Phase E Day 3 migrates `/api/product/phase` off the legacy path:

- [ ] Delete `src/agents/strategic-planner.md`, `src/agents/tactical-planner.md`.
- [ ] Delete `src/skills/strategic-planner/`, `src/skills/tactical-planner/`
      (dirs + `__tests__/`).
- [ ] Delete `scripts/test-strategic.ts`, `scripts/test-tactical.ts`.
- [ ] Delete `tacticalPlanSchema`, `tacticalPlanItemSchema`, `TacticalPlan`,
      `TacticalPlanItem` from `src/agents/schemas.ts`.
- [ ] Drop `tacticalPlanSchema.optional()` from `/api/onboarding/commit`
      back-compat body — by Phase E clients should no longer send `plan:`.
- [ ] Migrate all 9 non-planner processors off `runSkill` onto the
      AgentTool / Task path.
- [ ] Delete `src/core/skill-runner.ts`, `src/core/skill-loader.ts`,
      `src/bridge/load-agent.ts` (loader's only non-test consumer).
- [ ] Delete `src/skills/_catalog.ts` (Phase E removes the whole file per
      spec §13).
- [ ] Delete `src/agents/schemas.ts` entirely (rest of the `*OutputSchema`
      consts become dead with their skills).
- [ ] Drop `src/core/pipelines/full-scan.ts`'s runSkill usage (spec says
      the discovery pipeline runs via AgentTool).

After all of the above, grep `runSkill\|loadSkill\|SKILL_CATALOG\|TacticalPlan`
should return 0 hits in `src/`.

## Phase E Day 3 — Task #23 final sweep (2026-04-21)

Scope narrowed vs. the original checklist above. `skill-runner.ts` +
`skill-loader.ts` STAY — 9 production workers + full-scan + 2 CLI scripts
still load skills via `loadSkill()`. Migration of those callers to
AgentTool / Task is deferred to Phase F+.

### What Task #23 deleted

**18 skill directories (14 truly dead + 4 stub-only):**

| Dir | Status |
|---|---|
| ab-test-subject | truly dead |
| build-launch-runsheet | truly dead |
| classify-thread-sentiment | truly dead |
| compile-retrospective | truly dead |
| deep-analysis | truly dead (no catalog entry) |
| draft-hunter-outreach | truly dead |
| draft-launch-day-comment | truly dead |
| draft-waitlist-page | truly dead |
| extract-milestone-from-commits | truly dead |
| fetch-community-hot-posts | truly dead |
| fetch-community-rules | truly dead |
| generate-interview-questions | truly dead |
| generate-launch-asset-brief | truly dead |
| identify-top-supporters | truly dead |
| draft-single-post | stub-only (replaced by x-writer in Task #22) |
| draft-email | stub-only (dispatch string, no runtime load) |
| send-email | stub-only (local send.ts never actually loaded) |
| analytics-summarize | stub-only (dispatch string, no runtime load) |

**15 agent `.md` files** (`src/agents/{name}.md`) for the deleted skills
(draft-single-reply / posting / voice-extractor / discovery / draft-review /
product-opportunity-judge / community-discovery keep theirs).

**All 18 catalog entries** in `src/skills/_catalog.ts` — catalog shrunk
from 22 entries to 5 (draft-single-reply, discovery, draft-review, posting,
voice-extractor).

**Schemas in `src/agents/schemas.ts`** — kept only the schemas + types the
7 live skills and surrounding workers still import. Dropped the
`slotBodyOutputSchema`, `calendarPlanOutputSchema`, `contentOutputSchema`,
`contentCreatorOutputSchema`, `analystOutputSchema`, and every
`Phase-5-atomic-skill` output schema + their inferred type aliases. The
strategic-planner schemas (now in `src/tools/schemas.ts`) also dropped from
here. File shrunk from 712 → 233 lines.

**Test files** — `src/agents/__tests__/calendar-plan-schema.test.ts` and
`src/agents/__tests__/schemas-shell.test.ts` deleted (tested deleted
schemas).

### Dispatch table updates

- `content_post + x` — DRAFT phase now handled by plan-execute's writer
  branch (spawns x-writer / reddit-writer via team-run). Dispatch table
  keeps the entry with `draftSkill: null`, `executeSkill: 'posting'` so the
  EXECUTE phase still runs through posting.
- `email_send`, `metrics_compute`, `analytics_summary` — kept as
  manual/auto-completion SHELL routes (`draftSkill: null, executeSkill:
  null`). The skill strings are gone; shell routes let content-planner
  continue emitting these kinds without blowing up dispatch. A future
  phase wires replacements (team-run email agent / analytics worker).
- `launch_asset` — skillName strings the tactical-planner emits still
  pass through the dispatch table untouched; the per-row skill refs are
  now labels since the target skills were deleted.

### Full-scan pipeline

- `src/core/pipelines/full-scan.ts` — Step 3 (community intelligence)
  removed. The `community-intel` skill dir was deleted in commit `bbe429a`
  (Oct) but the loader call was wrapped in try/catch — in production it
  always threw and fell back to an empty intel array. Now explicit: we
  always emit an empty `communityIntel` list. Replacement path is team-run
  (community-manager).
- Added `src/agents/community-discovery.md` (restored from pre-`bbe429a`
  git history) so `community-discovery/SKILL.md` can default to the
  skill-name-matches-agent-name resolution rule. Dropped the `agent: scout`
  override from the SKILL.md frontmatter.

### Known follow-up — prose docs still reference deleted skills

`src/tools/AgentTool/agents/content-planner/references/tactical-playbook.md`
and `src/tools/AgentTool/agents/_shared/references/phase-task-templates.md`
still instruct the content-planner to emit plan_items with skillNames from
the 18 deleted skills (e.g. `skillName: 'draft-email'`). With the new shell
dispatch routes those rows no longer crash — they advance through the
state machine as manual-completion items, the per-row skillName is a
label — but a user inspecting the plan will see intent for features that
don't actually run.

Updating those prose docs is a separate follow-up (team-lead owns
deciding when: could be Phase F when we reintroduce the replacements,
could be now if drift risk outweighs rewrite cost).

### Updated grep sweep (2026-04-21, post-Task-#23)

| Pattern | Expected | Found | Verdict |
|---|---|---|---|
| All 18 dead skill names (`ab-test-subject\|...`) in `src/**/*.{ts,tsx}` | 0 runtime / small number of comment refs | 1 (audit comment in `agents/schemas.ts`) | ✓ |
| `from.*@/core/skill-runner` (in `src/`) | 9 (6 processors + 2 scripts + full-scan) | 9 | ✓ |
| `from.*@/core/skill-loader` (in `src/`) | 9 | 9 | ✓ |
| `community-intel` in `src/` outside a `.md` doc | 0 | 0 | ✓ |
| `loadSkill(...)` call sites in `src/` (excluding skill-loader.ts internals) | 11 | 11 | ✓ — all 7 live skills covered (posting / voice-extractor / discovery / draft-review / product-opportunity-judge / draft-single-reply / community-discovery) |

## Rollback

Phase C deletions are protected by git tag `pre-team-platform-cutover`
(spec §17, 48 h window from the deploy). If a production regression
surfaces inside the window:

```bash
git reset --hard pre-team-platform-cutover
git push -f origin dev
```

Redeploy from the tag. After 48 h the window closes and the deletions are
final; Phase E deletions will require a different rollback plan (likely
the equivalent `pre-phase-e-cutover` tag).
