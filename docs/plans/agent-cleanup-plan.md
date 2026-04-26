# Agent Cleanup Plan

**Status:** approved 2026-04-25
**Owner:** main agent + multi-agent team
**Goal:** Eliminate the dual agent registry, drop redundant wrapper teammates, unify writer roles, and migrate reply drafting from a pipeline-in-tool model to an agent-driven model.

## Context

ShipFlare currently has two parallel agent registries and three reply-drafting code paths. The cleanup is informed by Claude Code's own engine architecture (`engine/`) which establishes a clean separation:

- **Skill** = declarative recipe (SKILL.md, self-contained, optional `context: fork` to spawn an agent).
- **Agent** = stateful executor (AGENT.md, identity, tool whitelist, lifecycle, isolation). One registry.
- **Tool** = API surface (SkillTool / AgentTool included).
- **Task** = runtime execution primitive (LocalAgentTask / RemoteAgentTask / ...).

ShipFlare diverges in three ways:

1. Two agent registries: `src/agents/*.md` (legacy, runSkill-only) and `src/tools/AgentTool/agents/*/AGENT.md` (Task teammates).
2. `runSkill()` is a thin wrapper over `runAgent` with reference injection — not a real Skill.
3. BullMQ workers each handcraft `runAgent` / `runSkill` calls instead of going through Task or a unified loader.

## Decisions (locked)

- **D1 (reply path) = B:** community-manager owns reply drafting via its own LLM turns; `reply-drafter` teammate + `draft_single_reply` tool deleted; hardening logic re-exposed as agent-callable tools.
- **D2:** delete `community-scout` teammate; coordinator gains `run_discovery_scan` as a direct tool.
- **D4:** merge `x-writer` + `reddit-writer` → single `post-writer` agent; channel becomes spawn input.

## Per-agent disposition

### Delete

| Agent | Reason |
|---|---|
| `src/agents/slot-body-agent.md` | Zero callers |
| `src/agents/community-discovery.md` + `src/skills/community-discovery/` | Replaced by `community-scout`/`discovery-scout`; orphaned |
| `src/tools/AgentTool/agents/community-scout/` | Single-tool wrapper over `run_discovery_scan`; coordinator owns the tool directly |
| `src/tools/AgentTool/agents/reply-drafter/` | Single-tool wrapper over `draft_single_reply`; D1 path B replaces it with community-manager |
| `src/tools/DraftReplyTool/DraftSingleReplyTool.ts` | Pipeline-in-tool replaced by D1 path B |
| `src/skills/draft-single-reply/` | Wrapper for the deleted `draft_single_reply` tool |
| `src/skills/posting/`, `src/skills/draft-review/`, `src/skills/product-opportunity-judge/` | SKILL ceremony around single-call workers; references move to AGENT.md |

### Rename + move (legacy `src/agents/` → unified registry)

| From | To | Notes |
|---|---|---|
| `src/agents/engagement-monitor.md` | `src/tools/AgentTool/agents/engagement-monitor/AGENT.md` | BullMQ-driven, multi-turn |
| `src/agents/voice-extractor.md` | `src/tools/AgentTool/agents/voice-extractor/AGENT.md` | Single-turn, no tools |
| `src/agents/posting.md` | `src/tools/AgentTool/agents/posting/AGENT.md` | Side-effect agent; stays out of Task |
| `src/agents/draft-review.md` | `src/tools/AgentTool/agents/draft-review/AGENT.md` | Validation agent |
| `src/agents/product-opportunity-judge.md` | `src/tools/AgentTool/agents/product-opportunity-judge/AGENT.md` | Used by `judge_reply_opportunity` tool |
| `src/agents/reply-drafter.md` | `src/tools/AgentTool/agents/x-reply-writer/AGENT.md` | Renamed to disambiguate from teammate; sonnet writer for monitor.ts path |

### Merge

| Old | New | Notes |
|---|---|---|
| `x-writer/AGENT.md` + `reddit-writer/AGENT.md` | `post-writer/AGENT.md` | Channel as spawn input; both reference docs injected; prompt switches by channel |

### Keep

- `coordinator`, `growth-strategist`, `content-planner`, `community-manager`, `discovery-scout`, `discovery-reviewer`, `engagement-monitor`, `voice-extractor`, `posting`, `draft-review`, `product-opportunity-judge`, `x-reply-writer`, `post-writer`

Final agent count: **13** unified-registry agents (was 8 legacy + 11 teammates = 19).

## Execution phases

Phases are designed to be independently mergeable. Conflicts marked where they exist.

### Phase 1 — Clean orphans (zero risk)

- Delete `src/agents/slot-body-agent.md`
- Delete `src/agents/community-discovery.md`
- Delete `src/skills/community-discovery/`
- Verify schemas: drop `communityDiscoveryOutputSchema` if no remaining caller; delete catalog references
- `pnpm tsc --noEmit` exit 0

**Files touched:** `src/agents/`, `src/skills/`, `src/agents/schemas.ts`, `src/skills/_catalog.ts`
**Conflict surface with later phases:** none

### Phase 2 — Delete `community-scout` teammate (D2)

- Add `run_discovery_scan` to `src/tools/AgentTool/agents/coordinator/AGENT.md` `tools:` list
- Update `coordinator/references/decision-examples.md` and `when-to-handle-directly.md`: when discovery is needed, call `run_discovery_scan` directly, do not spawn `community-scout`
- Update `src/lib/team-provisioner.ts:146,172` roster: remove `community-scout`
- Update string references in 6 sites:
  - `src/app/api/automation/run/route.ts:21`
  - `src/app/api/onboarding/commit/route.ts:307,330`
  - `src/workers/processors/discovery-cron-fanout.ts:4`
  - any other grep hits
- Delete `src/tools/AgentTool/agents/community-scout/`
- Verify: `pnpm tsc --noEmit`, run a discovery cron one-shot in dev

**Files touched:** coordinator/AGENT.md, team-provisioner.ts, several route files
**Conflict surface:** Phase 4 also edits coordinator/AGENT.md and decision-examples.md — sequence Phase 2 before Phase 4

### Phase 3 — Unify agent registry

- Move 6 legacy agents to `src/tools/AgentTool/agents/<name>/AGENT.md`:
  - engagement-monitor, voice-extractor, posting, draft-review, product-opportunity-judge
  - reply-drafter → **rename to x-reply-writer**
- Each new dir: AGENT.md only (no schema.ts unless the moved agent has a typed output — check schemas.ts)
- Update worker `loadAgentFromFile` paths:
  - `src/workers/processors/engagement.ts:108-111`
  - `src/workers/processors/voice-extract.ts` (via runSkill, paths change indirectly)
  - `src/workers/processors/posting.ts`
  - `src/workers/processors/review.ts`
  - `src/workers/processors/reply-hardening.ts`
- Update `src/skills/draft-single-reply/SKILL.md` `agent:` field → `x-reply-writer` (skill is deleted in Phase 6 anyway, but keep working until then)
- Delete the now-empty `src/agents/*.md`; keep `schemas.ts` and `react-preamble.md`

**Files touched:** `src/agents/`, `src/tools/AgentTool/agents/`, all 4 worker processors
**Conflict surface:** Phase 1 deletes other files in `src/agents/` — disjoint but worktree merges may need conflict resolution on parent dir state

### Phase 4 — Merge writers (D4)

- Create `src/tools/AgentTool/agents/post-writer/AGENT.md` with:
  - `references: [x-content-guide, reddit-content-guide, content-safety]`
  - `tools: [draft_post, SendMessage, StructuredOutput]`
  - prompt body branches on input.channel ∈ {x, reddit}
- Update `content-planner/AGENT.md` references and any spawn instructions to use `post-writer`
- Update `coordinator/references/decision-examples.md` writer examples
- Update `team-provisioner.ts` roster: remove x-writer/reddit-writer, add post-writer
- grep remove all `'x-writer'` / `'reddit-writer'` literal spawn references → `'post-writer'`
- Delete `src/tools/AgentTool/agents/x-writer/`, `src/tools/AgentTool/agents/reddit-writer/`
- Verify: spawn a content_post plan_item for both channels in dev

**Files touched:** content-planner, coordinator references, team-provisioner.ts, post-writer/, removed writer dirs
**Conflict surface:** Phase 2 also edits coordinator/AGENT.md and decision-examples.md — sequence after Phase 2

### Phase 5 — Delete `runSkill` wrappers

Depends on **Phase 3** (registry must be unified first).

- Replace `runSkill(skill)` with `runAgent(loadAgent(name), ...)` in:
  - `src/workers/processors/posting.ts:110`
  - `src/workers/processors/review.ts:64`
  - `src/workers/processors/voice-extract.ts:110`
  - `src/workers/processors/reply-hardening.ts:66,108`
- Delete `src/skills/posting/`, `src/skills/draft-review/`, `src/skills/product-opportunity-judge/`
- `src/skills/_catalog.ts` shrinks to `voice-extractor` + `draft-single-reply` (latter dies in Phase 6)
- Decide fate of `src/core/skill-runner.ts`:
  - Option A: rename to `runAgentWithRefs`, serve only voice-extractor's plan_item route
  - Option B: inline references injection into voice-extract.ts and delete skill-runner.ts
  - **Recommend B** — fewer abstractions for the single remaining caller
- Delete now-orphaned `loadSkill` / SkillConfig types if no remaining users

**Files touched:** all 4 worker processors, src/skills/, src/core/skill-runner.ts
**Conflict surface:** Phase 3 must land first; otherwise none

### Phase 6 — Path B: agent-driven reply (D1)

Depends on **Phase 3** (x-reply-writer name) and **Phase 5** (clean worker callers).

**Path B taken to its conclusion:** the LLM does the judgment and validation in its own turns. No new wrapper tools — references encode the rules, community-manager applies them.

**Step 6a — community-manager prompt upgrade**

- Rewrite community-manager `AGENT.md` workflow:
  1. For each thread, in a single LLM turn:
     - Read thread body, voice block, product context
     - Decide `canMentionProduct` inline (apply `reply-quality-bar.md` and product-opportunity heuristics from references)
     - Draft reply body
     - Self-check against the inline rules (AI-slop signals, anchor token presence, length, hallucinated stats)
     - If self-check fails, rewrite once in the same turn
  2. Call `draft_reply` to persist (with `needsReview: true` if self-check still fails)
- Update / expand `community-manager/references/reply-quality-bar.md` to encode the AI-slop / anchor / length / hallucinated-stats rules currently living in `runContentValidators` code — the LLM needs the rules in prose to self-apply them
- Add a new reference `community-manager/references/opportunity-judgment.md` (or fold into reply-quality-bar) that encodes the product-opportunity-judge agent's prompt as guidance the LLM can apply inline
- Bump `maxTurns` to 15-18 (one turn per thread plus headroom; no longer need separate judge / validate sub-turns)
- **No new tools created.** `judge_reply_opportunity` and `validate_reply_content` ideas are dropped — agent does it inline.

**Step 6c — Delete reply-drafter teammate + draft_single_reply tool**

- Delete `src/tools/AgentTool/agents/reply-drafter/`
- Delete `src/tools/DraftReplyTool/DraftSingleReplyTool.ts` (keep `DraftReplyTool.ts` — community-manager uses it)
- Delete `src/skills/draft-single-reply/`
- Remove `_catalog.ts` entry for `draft-single-reply` (catalog now only has voice-extractor)
- Update all `enqueueTeamRun` initial prompts that reference `reply-drafter`:
  - `src/lib/reply-sweep.ts`
  - `src/workers/processors/discovery-cron-fanout.ts`
  - any other grep hits

**Step 6d — monitor.ts pipeline (no team-run migration)**

monitor.ts is a programmatic per-tweet retry loop, not a multi-agent conversation. Path B only changes the **internal LLM calls**, not the pipeline structure.

- `src/workers/processors/reply-hardening.ts:108` (judge): `runAgent(loadAgent('product-opportunity-judge'), ...)` direct (no runSkill)
- `src/workers/processors/reply-hardening.ts:66` (drafter): `runAgent(loadAgent('x-reply-writer'), ...)` direct
- Keep regen loop, keep content-validator pipeline — they remain code-driven
- Note: `product-opportunity-judge` agent is **only** consumed by monitor.ts's reply-hardening (the team-run side does it inline). Single caller, single code path — kept alive only because the programmatic regen loop wants a separate LLM judgment.

**Step 6e — Verification**

- Discovery cron → community-manager flow in dev: confirm replies persist with the same shape
- monitor.ts X target-account flow in dev: confirm regen loop still works
- Compare reply text quality on a sample of 10-20 threads (path B vs old path A) before promoting to prod
- Recommend running path B in shadow for 3-7 days behind a feature flag if quality drift suspected

**Files touched:** community-manager AGENT.md + references, reply-sweep.ts, hardening.ts, several deletions
**Conflict surface:** must land last

### Phase 7 (optional) — Engine alignment

Future work, not in scope for this cleanup. Tracked here for visibility:

- Adopt engine's AGENT.md frontmatter fields: `effort`, `permissionMode`, `isolation`, `memory`
- Adopt engine's SKILL.md `context: fork` semantics for the remaining voice-extractor skill
- Variable substitution in references (`{productName}`, etc. — currently rendered literally)

## Final shape

```
src/tools/AgentTool/agents/         # unified registry (13 agents)
  coordinator/
  growth-strategist/
  content-planner/
  community-manager/                 # owns reply drafting (D1 path B)
  discovery-scout/                   # invoked inside run_discovery_scan
  discovery-reviewer/                # invoked inside run_discovery_scan
  post-writer/                       # x + reddit, channel-switched (D4)
  x-reply-writer/                    # monitor.ts per-tweet writer (renamed leaf)
  product-opportunity-judge/         # invoked by judge_reply_opportunity tool
  engagement-monitor/                # BullMQ worker direct call
  voice-extractor/                   # voice-extract worker direct call
  posting/                           # posting worker (must stay serial)
  draft-review/                      # review worker

src/skills/                           # 1 SKILL — true plan_item recipe
  voice-extractor/SKILL.md           # supportedKinds: ['setup_task']

src/agents/                           # legacy folder, only support files remain
  schemas.ts
  react-preamble.md
```

## Validation gates (every phase)

- `pnpm tsc --noEmit` exit 0
- `pnpm test` green
- Manual smoke: at least one e2e for the path the phase touched
  - Phase 1: any cron job
  - Phase 2: discovery cron one-shot
  - Phase 3: every BullMQ worker that loadAgent — engagement, voice-extract, posting, review, reply-hardening
  - Phase 4: content_post plan_item dispatch for both X and Reddit
  - Phase 5: same as Phase 3
  - Phase 6: full discovery → community-manager → draft persistence; full monitor.ts → reply-hardening regen loop

## Execution order summary

```
Phase 1 ─┐
         ├─ parallel ok (different files)
Phase 3 ─┘

Phase 2 ──> Phase 4   (sequential — both edit coordinator/AGENT.md)

Phase 5  (after Phase 3)

Phase 6  (after Phase 3, Phase 5)
```

Suggested team layout:
- **lead** (this main): orchestrator, gates, merges, runs validation between phases
- **cleanup-1**: Phase 1
- **cleanup-2**: Phase 2
- **cleanup-3**: Phase 3 (largest scope — multi-file refactor)
- **cleanup-4**: Phase 4
- **cleanup-5**: Phase 5
- **cleanup-6**: Phase 6 (longest, most behavioral risk)

Each phase teammate runs in its own git worktree; lead reviews diff and merges to dev between rounds.
