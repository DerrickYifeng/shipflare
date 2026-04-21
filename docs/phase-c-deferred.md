# Phase C — deferred to Phase E

Phase C (2026-04-21, branch `dev`, commits `ee2f9ca`..`8a4c1f5`) shipped the
v3 team-run path as the primary onboarding + replan driver but deliberately
left a handful of v2 artifacts alive because their one remaining caller —
`/api/product/phase` — stays on the legacy skill-runner path until Phase
D/E. This document is the audit trail so Phase E knows what to clean up.

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
