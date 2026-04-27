# Phase C — v2 Code Inventory & Caller Audit

**Author**: `backend-engineer-1`
**Branch**: `dev` (at `1979eb1`)
**Date**: 2026-04-20
**Scope**: Spec `docs/superpowers/specs/2026-04-20-ai-team-platform-design.md` §11 Phase C + §13 Delete Manifest.

This report maps every file and symbol the spec wants removed in Phase C
to the call-sites that must be updated first. It is organized by the
spec's four deletion batches (Day 1 → Day 4, with Day 4 being the
catalog / `agents/schemas.ts` shrink). A ⚠ marks the one deviation from
the spec I found: `src/core/skill-runner.ts` and `src/core/skill-loader.ts`
cannot be deleted on Day 2 without first migrating ~10 worker processors
that still use them, or without Phase E landing first. See §Gap with spec.

---

## Delete targets — existence confirmation

| Spec target | On-disk path | Exists? | Size | Notes |
|---|---|---|---|---|
| `src/agents/strategic-planner.md` | same | ✅ | 9.1 KB | |
| `src/agents/tactical-planner.md` | same | ✅ | 10.0 KB | |
| `src/agents/schemas.ts` (shrink) | same | ✅ | 25.9 KB, 765 lines | 75 exports; only `strategicPathSchema` + `planItemInputSchema` survive per spec. `tacticalPlanSchema` + `TacticalPlan` type must go. All other `*OutputSchema` stay until Phase E (still imported by Phase E skills + workers). |
| `src/skills/strategic-planner/` | same | ✅ | SKILL.md + tests + refs | |
| `src/skills/tactical-planner/` | same | ✅ | SKILL.md + tests + refs | |
| `src/workers/processors/tactical-generate.ts` | same | ✅ | — | |
| `src/core/skill-runner.ts` | same | ✅ | 256 lines | |
| `src/core/skill-loader.ts` | same | ✅ | 228 lines | |
| `src/core/swarm/` (directory) | `src/core/swarm.ts` | ✅ | 320 lines | Spec says directory, actual is single file. No caller other than `skill-runner.ts`. |
| `src/core/coordinator.ts` | — | ❌ | — | Does not exist; no-op for Phase C. |
| `src/core/query-loop.ts` sanitizer block | same | ✅ | `STRIPPED_KEYS` line 53, `UnexpressibleSchemaError` line 76, `sanitizeJsonSchemaForAnthropic` line 82, `zodToSanitizedJsonSchema` line 138, `jsonSchemaForOutput` usage lines 211, 396 | |
| `src/core/api-client.ts` `outputSchema` wiring | same | ✅ | `createMessage.outputSchema` line 113/147/189, `sideQuery.outputSchema` line 322/339 | |
| `src/skills/_catalog.ts` planner entries | same | ✅ | entries at lines 947–965 (`strategic-planner`, `tactical-planner`) | Whole file is deleted in Phase E per §13; Phase C just drops the two planner entries. |
| `SHIPFLARE_TERMINAL_TOOL_AGENTS` feature flag | — | ❌ | — | No references anywhere in `src/`. Already deleted or never written. |

---

## Day 1 — delete v2 planner code

### Files to remove

- `src/agents/strategic-planner.md`
- `src/agents/tactical-planner.md`
- `src/skills/strategic-planner/` (dir, incl. `__tests__/`, `references/`)
- `src/skills/tactical-planner/` (dir, incl. `__tests__/`, `references/`)
- `src/workers/processors/tactical-generate.ts`

### Caller table (edits required BEFORE or IN the same commit)

| Caller | Symbol used | Why it breaks | Required action |
|---|---|---|---|
| `src/app/api/onboarding/plan/route.ts:82-84` | `loadSkill('src/skills/strategic-planner')` + `runSkill<StrategicPath>` in `runStrategic()` fn L366 | Route still has legacy fallback branch for users without a committed product row. Spec §11 Phase C Day 1 says "remove `runStrategic()`, keep just SSE proxy". | Delete `runStrategic()`, `strategicSkill` const, and `useTeamRun` conditional. Team-run path is now the only path; for fresh onboarding without a `products` row yet, either (a) create a transient team BEFORE the SSE handler, or (b) keep `runStrategic()` alive here and only cut the standalone skill files — the route ALREADY dispatches to team-run when a product row exists; the question is whether onboarding-before-commit ever hits this route. **Product-lead question**: can we assume `ensureTeamExists(userId, productId)` works before `products` row commit? |
| `src/app/api/onboarding/plan/__tests__/route.test.ts` | `vi.mock('@/core/skill-runner', ...)` + assertions on `runSkill` | Same route, test. | Rewrite or delete; replace with team-run path assertions. |
| `src/app/api/onboarding/commit/route.ts:314-328` | `enqueueTacticalGenerate({ ... })` | Calls into a queue that dispatches to `tactical-generate.ts` processor. | Remove the whole post-commit enqueue block. Team-run path writes plan_items via `write_plan_item` tool, no separate enqueue needed. |
| `src/app/api/onboarding/commit/__tests__/route.test.ts:438-470` | Tests assert `tactical-generate:<id>` is in `enqueued`. | Test. | Rewrite: expect no `tactical-generate` enqueue. |
| `src/workers/index.ts:21,210-238,410` | `processTacticalGenerate`, `tacticalGenerateWorker` registered in worker bus | BullMQ worker declaration. | Remove import, remove `new Worker(...)` declaration, remove from workers array, update the final `log.info` string. |
| `src/lib/queue/tactical-generate.ts` | Queue + enqueue helper for the deleted processor | — | Delete the whole file. |
| `src/lib/queue/index.ts:396-400` | Re-exports `tacticalGenerateQueue`, `tacticalGenerateJobSchema`, `TacticalGenerateJobData` | — | Remove those exports. |
| `src/app/api/today/progress/route.ts:46-176` | Watches `tactical_generate_*` pub/sub events + reads `plans.notes` starting with `tactical-generate failed` | Only observational; still loads even with empty pub/sub. | Update prose / variable names to reference team-run progress instead. No hard break. |
| `src/app/api/product/phase/route.ts:13-14,33-38,197,231` | `loadSkill('strategic-planner' + 'tactical-planner')` + two `runSkill` chain calls | Direct caller. | Replace with team-run path — enqueue a `team_run` with `trigger='phase_change'` + goal derived from new state. Blocks on SSE proxy or waits on `strategic_path` + `plan_items` write. Big chunk of work. Product-lead question: is this route in scope for Phase C or Phase D? Spec gate §11 Phase C: "staging `/api/onboarding/plan` and `/api/plan/replan` work via team runs" — phase/route is NOT in that gate. |
| `src/app/api/product/phase/__tests__/route.test.ts` | Mocks + assertions on the chain. | Test. | Rewrite alongside route. |
| `src/lib/re-plan.ts:5-8,129-137,273-306` | `runSkill<TacticalPlan>` for tactical replan (shared between `POST /api/plan/replan` + `weekly-replan` cron) | `runTacticalReplan` is the only way to regenerate a week's plan_items today. Gate §11 Phase C mentions `/api/plan/replan` working via team runs. | Rewrite: enqueue a team_run with `trigger='weekly_replan'` / `'manual_replan'` and wait for plan_items rows. Blocks `weekly-replan.ts` processor too. Largest single edit in Day 1. |
| `src/app/api/plan/replan/route.ts:4,71` | `runTacticalReplan(userId, 'manual')` | Calls `re-plan.ts`. | No direct change if `runTacticalReplan` is rewritten; if re-plan.ts is deleted, remove import here. |
| `src/app/api/plan/replan/__tests__/route.test.ts:27` | `vi.mock('@/core/skill-runner', ...)` | Test. | Rewrite. |
| `src/workers/processors/weekly-replan.ts:6,91` | `runTacticalReplan(userId, 'weekly')` | Cron that runs Monday 00:00 UTC. | Re-point to team-run enqueue. |
| `src/workers/processors/__tests__/weekly-replan.test.ts` | Mocks `@/lib/re-plan` | Test. | Adjust. |
| `scripts/test-strategic.ts`, `scripts/test-tactical.ts` | Dogfood scripts load + run the deleted skills | Local CLI tools. | Delete or rewrite against team-run path. Low priority, not called in prod. |
| `src/skills/_catalog.ts:25-50, 949-965` | Imports `strategicPathSchema`, `tacticalPlanSchema`; catalog entries for planners | Catalog still referenced by `re-plan.ts`, `product/phase/route.ts`, `tactical-generate.ts`. | Once those 3 callers lose their `SKILL_CATALOG` reads, the planner entries here can be deleted. Whole file deleted later in Phase E. |
| `src/agents/schemas.ts:717-723,732` | `tacticalPlanSchema` + `TacticalPlan` type | Imported only by `re-plan.ts`, `product/phase/route.ts`, `tactical-generate.ts`, `skills/_catalog.ts`, `skills/tactical-planner/__tests__/*`. All are being removed. | Delete the two exports. |

### Day 1 deletion order (safe)

1. Edit `src/skills/_catalog.ts` to stop importing `strategicPathSchema` + `tacticalPlanSchema` (tactical only — strategic can stay for now, spec keeps it in `src/tools/schemas.ts`). Remove the two planner catalog entries.
2. Rewrite `re-plan.ts`, `product/phase/route.ts`, `onboarding/plan/route.ts::runStrategic` to stop calling `runSkill`. (Product-lead decision: do these routes migrate to team-run now, or do we defer `product/phase` to Phase D?)
3. Remove `tactical-generate` queue + processor + worker registration + commit-route enqueue.
4. Delete the four targets (`strategic-planner.md`, `tactical-planner.md`, `src/skills/strategic-planner/`, `src/skills/tactical-planner/`).
5. Delete `tacticalPlanSchema` + `TacticalPlan` from `src/agents/schemas.ts`.
6. Verify `pnpm tsc --noEmit` green. Verify `pnpm vitest run src/workers src/app/api` green except the known `enqueue.test.ts "requires Redis"` baseline fail.

### Questions flagged for product-lead (BEFORE Day 1 starts)

1. **`/api/onboarding/plan` fresh-user branch**: the current route falls back to `runStrategic()` when `products` row doesn't exist yet. Phase C Day 1 says "keep just SSE proxy" — does that mean provision the team eagerly in Phase F style before the product row commits, or does the onboarding UI now always commit a product row first?
2. **`/api/product/phase`**: this is a strategic+tactical chain (phase-change replan). Spec §11 gate names `/api/onboarding/plan` and `/api/plan/replan` but NOT `/api/product/phase`. Does this route stay on the legacy skill-runner path until Phase D/E, or must it migrate now? If legacy stays, then `src/skills/_catalog.ts`, `strategicPathSchema`/`tacticalPlanSchema` and re-plan's catalog import all survive Phase C too.

---

## Day 2 — delete skill-runner + swarm orchestration

### Files the spec wants deleted

- `src/core/skill-runner.ts`
- `src/core/skill-loader.ts`
- `src/core/swarm.ts` (spec says `swarm/` — actual is a single `.ts` file)
- `src/core/coordinator.ts` (does not exist)
- `src/core/fanOutCached` exports — lives inside `swarm.ts` (`SwarmCoordinator.fanOutCached` method), removed by deleting `swarm.ts`.

### ⚠ Gap with spec — the big one

`skill-runner.ts` still has **17 direct importers** (`runSkill` / `loadSkill`) outside the planner code:

| File | Purpose (skills it invokes) | Phase where spec expects cutover |
|---|---|---|
| `src/workers/processors/posting.ts:9-10` | `posting` skill | Phase E ("delete all v2 skill directories") |
| `src/workers/processors/voice-extract.ts:6-7` | `voice-extractor` skill | Phase E |
| `src/workers/processors/search-source.ts:6-7` | `discovery` skill | Phase E |
| `src/workers/processors/review.ts:5-6` | `draft-review` skill | Phase E |
| `src/workers/processors/reply-hardening.ts:2-3` | `reply-drafter` + `product-opportunity-judge` skills | Phase E |
| `src/workers/processors/calibrate-discovery.ts:7-8` | `discovery` skill | Phase E |
| `src/workers/processors/monitor.ts` | checked via grep only — doesn't import skill-runner directly, `monitor` | Phase E |
| `src/core/pipelines/full-scan.ts:4-5` | `community-discovery`, `community-intel`, `discovery` skills | Phase E |
| `src/scripts/discovery-eval.ts:19-20`, `src/scripts/test-x-discovery.ts:18-19` | dev CLIs | — |

The spec's Phase C Day 2 bullet says:
> Remove dead skills: keep only draft-single-post, draft-single-reply, identify-top-supporters, compile-retrospective, analytics-summarize, generate-interview-questions, draft-hunter-outreach, draft-waitlist-page, draft-launch-day-comment, generate-launch-asset-brief, build-launch-runsheet UNTIL Phase E. These are referenced by plan-execute worker still.

Those 11 skills are invoked **only through `plan-execute`**, which today is a state-transition stub (`src/workers/processors/plan-execute.ts:113`: "Phase 7: state transition only. Phase 8 wires runSkill() here"). They don't require skill-runner right now.

But the 9 processors above **do** invoke skill-runner, for skills the spec doesn't list as surviving (`posting`, `voice-extractor`, `discovery`, `draft-review`, `reply-drafter`, `product-opportunity-judge`, `community-discovery`, `community-intel`). These paths back a lot of non-planner functionality (reply hardening, calibration, posting, voice extraction, daily scans). Deleting `skill-runner.ts` breaks all of them.

**Interpretation options** for product-lead:
- **(A)** Spec is right, and the intent is that these processors migrate to `runAgent` / the new `Task` path in Phase C Day 2. That's a big undocumented body of work — roughly 10 processors × ~1 hr each. Not in the task list.
- **(B)** Spec is slightly under-specified: these processors keep `runSkill` until Phase E, and only the planner skill-runner callers go away in Phase C. In that case, `src/core/skill-runner.ts` and `src/core/skill-loader.ts` survive Phase C. Only `swarm.ts` (only used by skill-runner for strategic/tactical fan-out) can be deleted if skill-runner is trimmed to remove the `fanOutCached` branch.
- **(C)** (A) but staggered — the processor migration is Phase E scope and Day 2 / Day 3 focus only on the structured-output-sanitizer removal from query-loop + api-client.

Proposed resolution: **(B)**, and the Day 2 task scope should be narrowed to "delete only unreferenced parts of skill-runner / swarm". I recommend we flag this to `team-lead` before claiming Task #4.

### If we proceed with (B), what's safe to delete in Day 2

- `src/core/swarm.ts` — only imported by `skill-runner.ts`. If we first edit skill-runner to stop calling `SwarmCoordinator.fanOutCached` (inline its single-call path), swarm.ts becomes unreachable. But the simpler move: leave swarm.ts alone, plan a single-commit swap in Phase E.

### If we proceed with (A), the ordered caller migration list

Before deleting skill-runner.ts, migrate these 9 call-sites to either `runAgent()` directly or a `Task(agent)` dispatch:

1. `src/workers/processors/posting.ts`
2. `src/workers/processors/voice-extract.ts`
3. `src/workers/processors/search-source.ts`
4. `src/workers/processors/review.ts`
5. `src/workers/processors/reply-hardening.ts`
6. `src/workers/processors/calibrate-discovery.ts`
7. `src/core/pipelines/full-scan.ts`
8. `src/scripts/discovery-eval.ts` (dev CLI, low priority)
9. `src/scripts/test-x-discovery.ts` (dev CLI, low priority)

---

## Day 3 — strip structured-output sanitizer from core

### Symbols to remove

| Symbol | File:line | Referenced outside `query-loop.ts`? |
|---|---|---|
| `STRIPPED_KEYS` | `src/core/query-loop.ts:53` | No |
| `UnexpressibleSchemaError` | `src/core/query-loop.ts:76` | No |
| `sanitizeJsonSchemaForAnthropic` | `src/core/query-loop.ts:82` | No (internal helper) |
| `zodToSanitizedJsonSchema` | `src/core/query-loop.ts:138` | No |
| `jsonSchemaForOutput` branch in `queryLoop()` | `src/core/query-loop.ts:211-223, 231` | — |
| `jsonSchemaForOutput` branch in `runAgent()` | `src/core/query-loop.ts:396-405, 432` | — |
| `createMessage.outputSchema` param | `src/core/api-client.ts:113, 147, 189` | Only passed from `query-loop.ts` (2 sites) and `sideQuery`. |
| `sideQuery.outputSchema` | `src/core/api-client.ts:322, 339` | No external caller uses `sideQuery({ outputSchema })` today — grep returns only the type definition + parameter plumbing. |
| `output_config.format` construction | `src/core/api-client.ts:189` | — |

### Test(s) to update / delete

- `src/core/__tests__/query-loop-structured-output.test.ts:220` — asserts the sanitizer handles `minItems>1`. With sanitizer gone, this specific assertion becomes invalid. Re-frame the test around the `StructuredOutputTool` path (which is kept) or delete the minItems case.

### AgentConfig / QueryParams.outputSchema (keep)

`AgentConfig.outputSchema` (`src/core/types.ts:109`) and `QueryParams.outputSchema` (`src/core/types.ts:85`) stay — they feed the **synthesized StructuredOutput API tool** path that Phase B kept, not the deleted JSON-schema path. Confirmed by `spawn.ts:184-194` and `runAgent()` logic above line 371 (StructuredOutput is only wired when `!prebuilt`; that wiring is not deleted).

### Day 3 deletion order

1. Drop the `jsonSchemaForOutput` call in `queryLoop()` (line 199-223, 231).
2. Drop the `jsonSchemaForOutput` call in `runAgent()` (line 396-405, 432).
3. Delete the four helper symbols at the top of `query-loop.ts`.
4. Delete `outputSchema` param from `CreateMessageOptions` + `createMessage` body + `output_config` construction in `api-client.ts`.
5. Delete `outputSchema` from `SideQueryOptions` + `sideQuery` body.
6. Update `src/core/__tests__/query-loop-structured-output.test.ts` — either reposition test to cover `StructuredOutputTool`-only behavior, or delete assertions that hinge on sanitizer.
7. `pnpm tsc --noEmit`.

---

## Day 4 — catalog cleanup + final sweep

### Files / symbols

- `src/skills/_catalog.ts` — remove `strategic-planner` + `tactical-planner` entries (lines 947-965) and remove `strategicPathSchema` + `tacticalPlanSchema` from the `@/agents/schemas` import block (lines 48-49).
- `src/agents/schemas.ts` — after Day 1 removes the `tacticalPlan*` exports, verify no dangling references. Remaining exports (discovery, draft-*, reply-*, etc.) survive to Phase E because they back the 11 skills the spec keeps.
- `src/agents/strategic-planner.md` + `tactical-planner.md` — already gone (Day 1).

### Catalog caller closure check

After Day 1 rewrites, `SKILL_CATALOG` has callers only in the 11 kept skills' tests + `plan-execute`'s routing map. Grep `SKILL_CATALOG` on completion — none of the 3 original importers (`re-plan.ts`, `product/phase/route.ts`, `tactical-generate.ts`) should still reference it.

### Final sweep commands

```
rg -n 'from [\"'\"'\"']@/core/skill-(runner|loader)[\"'\"'\"']' src
rg -n 'from [\"'\"'\"']@/core/swarm[\"'\"'\"']' src
rg -n 'STRIPPED_KEYS|UnexpressibleSchemaError|sanitizeJsonSchemaForAnthropic|zodToSanitizedJsonSchema|output_config\.format|SHIPFLARE_TERMINAL_TOOL_AGENTS' src
rg -n 'strategic-planner|tactical-planner' src
rg -n 'tacticalPlanSchema|TacticalPlan' src
```

Each must return 0 hits (after deciding the Day 2 (A)/(B) question above; under (B), `skill-runner` / `skill-loader` hits remain for the kept-until-E worker processors).

---

## Summary — recommended action before Day 2 starts

1. **Resolve ambiguity** with `product-lead`: does Phase C Day 2 actually migrate the 9 non-planner processors away from `skill-runner`, or do those stay on the legacy path until Phase E? (Recommend (B).)
2. **Resolve ambiguity** with `product-lead`: does `/api/product/phase` migrate to team-run in Phase C Day 1, or does it stay on skill-runner until Phase D/E? It's not in the spec's Phase C gate sentence.

Day 1, Day 3, and Day 4 are all unambiguous once those two decisions are made. Day 1 is the heaviest (re-plan + onboarding/plan + onboarding/commit all need team-run routing). The 20-fixture equivalence test (Task #2) exists to prevent regressions exactly here.

## Files whose in-repo paths differ from the spec

- Spec says `src/core/swarm/` (directory). Actual: `src/core/swarm.ts` (single file).
- Spec says `src/core/coordinator.ts`. Actual: does not exist.
- Spec says `SHIPFLARE_TERMINAL_TOOL_AGENTS` feature flag. Actual: no hits in `src/`.

## Stable references

- Task list source: `~/.claude/tasks/shipflare-v3-migration/` (tasks #1–#8).
- Spec: `docs/superpowers/specs/2026-04-20-ai-team-platform-design.md`.
- Delete manifest: §13, p. 1692–1740.
- Rollback plan: §17, p. 1843–1860. Phase C rollback window 48 h.
