# Agent Teams — Phase G: Cleanup + Retire Legacy + Documentation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Drop the `SHIPFLARE_AGENT_TEAMS` env flag (Agent Teams becomes the default — the legacy flag-off path is retired), remove all `isAgentTeamsEnabledForTeam` call sites, codify cross-phase invariants in `CLAUDE.md`, finalize the spec doc with Phase G landed timestamp, and tag the project COMPLETE.

**Architecture:** Pure cleanup phase — no new features. Inline the flag-on path into all callers (Task tool's async branch becomes unconditional when run_in_background:true is set). Delete the feature flag module. Add a new "Agent Teams Architecture" section to `CLAUDE.md` that codifies the cross-phase invariants from spec § "Cross-phase invariants" so future contributors don't accidentally violate them.

**Tech Stack:** TypeScript, Markdown.

**Spec reference:** `docs/superpowers/specs/2026-05-02-agent-teams-architecture-design.md` § Phase G + "Cross-phase invariants".

**Phase G non-goals**:
- Coordinator → team-lead rename — deferred (not trivial; touches DB rows, AgentDefinition aliases mechanism, many code constants). Tracked as Phase H follow-up if/when needed.
- Any new features

---

## File structure

**Modified files (~5):**

| Path | What changes |
|---|---|
| `src/lib/feature-flags/agent-teams.ts` | DELETE the file (no longer needed) |
| `src/lib/feature-flags/__tests__/agent-teams.test.ts` | DELETE the test file |
| `src/tools/AgentTool/AgentTool.ts` | Remove `isAgentTeamsEnabledForTeam` import + check from `launchAsyncTeammate` invocation. Async path always taken when `run_in_background:true` |
| `src/tools/AgentTool/__tests__/Task.test.ts` | Remove flag-related tests (flag-off cases obsolete); update flag-on tests to drop the mock |
| `CLAUDE.md` | Append "Agent Teams Architecture" section codifying cross-phase invariants |
| `docs/superpowers/specs/2026-05-02-agent-teams-architecture-design.md` | Append Phase G landed entry; update overall completion summary |

**Total:** 2 deletions + 4 modifications across 4 tasks.

---

## Sequence + dependencies

```
Task 1 (drop flag — code)     ──┐
Task 2 (drop flag — tests)    ──┴─▶ Task 3 (CLAUDE.md invariants)  ──▶  Task 4 (verification gate + spec landed)
```

---

## Task 1: Drop SHIPFLARE_AGENT_TEAMS — code paths

**Files:**
- Delete: `src/lib/feature-flags/agent-teams.ts`
- Modify: `src/tools/AgentTool/AgentTool.ts` (remove flag check)
- Find + Modify: any other callers of `isAgentTeamsEnabledForTeam`

- [ ] **Step 1: Find all callers**

```bash
grep -rn "isAgentTeamsEnabledForTeam\|SHIPFLARE_AGENT_TEAMS" src/ --include="*.ts" --include="*.tsx" 2>&1 | grep -v __tests__
```

Expected: 1-2 production caller(s) — `src/tools/AgentTool/AgentTool.ts` for sure (Task tool's async branch); possibly others.

- [ ] **Step 2: Remove the check from each caller**

For Task tool (`src/tools/AgentTool/AgentTool.ts`):

```ts
// BEFORE:
const teamId = readTeamDeps(ctx).teamId;
if (input.run_in_background === true && teamId !== null) {
  const enabled = await isAgentTeamsEnabledForTeam(teamId);
  if (enabled) {
    return await launchAsyncTeammate(input, context);
  }
  // Flag off: silently fall through to sync path.
}

// AFTER (Phase G):
const teamId = readTeamDeps(ctx).teamId;
if (input.run_in_background === true && teamId !== null) {
  // Phase G: SHIPFLARE_AGENT_TEAMS flag dropped — async path always taken
  // when run_in_background:true and team context present.
  return await launchAsyncTeammate(input, context);
}
```

Remove the import: `import { isAgentTeamsEnabledForTeam } from '@/lib/feature-flags/agent-teams';`

- [ ] **Step 3: Delete the feature-flag module**

```bash
git rm src/lib/feature-flags/agent-teams.ts
```

- [ ] **Step 4: Typecheck**

```bash
pnpm tsc --noEmit --pretty false
```

Expected: clean. If any caller still imports from the deleted module, fix it.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "refactor(feature-flags): drop SHIPFLARE_AGENT_TEAMS flag — Agent Teams is default (Phase G)"
```

---

## Task 2: Drop flag — tests

**Files:**
- Delete: `src/lib/feature-flags/__tests__/agent-teams.test.ts`
- Modify: `src/tools/AgentTool/__tests__/Task.test.ts` (drop flag-mock tests)

- [ ] **Step 1: Delete the flag test**

```bash
git rm src/lib/feature-flags/__tests__/agent-teams.test.ts
```

If the parent directory `src/lib/feature-flags/__tests__/` becomes empty, also delete it.
If `src/lib/feature-flags/` becomes empty, delete it too.

- [ ] **Step 2: Update Task.test.ts**

Find tests that mock `isAgentTeamsEnabledForTeam`:

```bash
grep -n "isAgentTeamsEnabledForTeam\|SHIPFLARE_AGENT_TEAMS" src/tools/AgentTool/__tests__/Task.test.ts
```

For each:
- **"flag off → sync path" tests**: DELETE (no longer reachable — flag is gone)
- **"flag on → async returns agentId" tests**: KEEP but remove the `vi.mocked(isAgentTeamsEnabledForTeam).mockResolvedValue(true)` line + the `vi.mock('@/lib/feature-flags/agent-teams', ...)` block
- **"run_in_background unset → sync" tests**: KEEP unchanged (this test doesn't depend on the flag)

- [ ] **Step 3: Run Task.test.ts to verify**

```bash
pnpm vitest run src/tools/AgentTool/__tests__/Task.test.ts
```

Expected: all remaining tests pass (some test count drops; that's intentional).

- [ ] **Step 4: Run full sweep for regression**

```bash
pnpm vitest run src/tools src/workers/processors
pnpm tsc --noEmit --pretty false
```

Expected: no new red beyond pre-existing.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "test: drop SHIPFLARE_AGENT_TEAMS flag-related tests (Phase G)"
```

---

## Task 3: CLAUDE.md — Agent Teams Architecture invariants

**Files:**
- Modify: `CLAUDE.md` (append new section)

Add a new section to `CLAUDE.md` that codifies the cross-phase invariants from spec § "Cross-phase invariants". Future contributors must not accidentally violate them.

- [ ] **Step 1: Read current CLAUDE.md to find a good insertion point**

```bash
head -80 CLAUDE.md
```

The section should go AFTER the existing "Skill Primitive" / "Primitive Boundaries" sections (it's an extension of the same theme: architecture invariants).

- [ ] **Step 2: Append the new section**

Add to `CLAUDE.md`:

```markdown
## Agent Teams Architecture

The multi-agent runtime (Phases A→G, landed 2026-05-02) follows engine
PDF §3.5.1 and §9 invariants. **The following architectural rules are
non-negotiable** — code review must reject violations.

### Tool routing — four-layer SSOT

`assembleToolPool(role, def, registry)` in
`src/tools/AgentTool/assemble-tool-pool.ts` is the SINGLE place that
decides "what tools does agent X see". Layers in order:

1. Global registry pool
2. Role whitelist (`src/tools/AgentTool/role-tools.ts`)
3. Role blacklist (`src/tools/AgentTool/blacklists.ts`) — architecture-level
   invariants (`INTERNAL_TEAMMATE_TOOLS` / `INTERNAL_SUBAGENT_TOOLS`)
4. AgentDefinition `tools:` allow + `disallowedTools:` subtract

**Any code that does role-based tool filtering OUTSIDE this function is a
review reject.** No `if (role === 'lead')` ad-hoc gating; everything
flows through `assembleToolPool`.

### Messages are the conversation

Worker-to-worker / lead-to-worker / system-to-lead communication ALL flows
through `team_messages`:
- Worker results: `messageType='task_notification'`, `type='user_prompt'`
  — appears as user-role message in parent's transcript
- Inter-teammate DM: `messageType='message'`
- Coordinator commands: `messageType='shutdown_request'`,
  `'plan_approval_response'`, `'broadcast'`
- Founder UI input: same shape, `toAgentId=lead.agentId`

`agent-run` is the SOLE driver for both lead and teammate (Phase E).
The legacy `team-run.ts` was deleted.

### Critical invariants (review-reject if violated)

1. **Teammates cannot fan out**: `INTERNAL_TEAMMATE_TOOLS` includes
   `Task` (sync subagent spawning) — teammates can only spawn via
   forbidden routes. Removing `Task` from this set is a review reject.
2. **`SyntheticOutputTool` is system-only**: `isEnabled()` returns false;
   tool is in `INTERNAL_TEAMMATE_TOOLS`. Adding it to a whitelist or
   removing the isEnabled gate is a review reject.
3. **Peer-DM shadow MUST NOT call `wake()`**: peer DMs (teammate↔teammate
   `type:message`) insert a summary-only shadow to lead's mailbox via
   `peer-dm-shadow.ts`. The lead picks it up on its NEXT NATURAL wake
   (task notification or founder message). Adding `wake()` to peer-DM
   would burn the lead's API budget on every chatter.
4. **`agent_runs.role` is immutable**: changing role requires deleting
   the row and spawning fresh. The role is part of the teammate's
   contract; changing mid-run breaks blacklist invariants.
5. **`<task-notification>` XML is synthesized in ONE place**:
   `src/workers/processors/lib/synthesize-notification.ts`. When engine
   evolves the schema, only this file changes. No inline XML construction
   anywhere else.
6. **`delivered_at` is the only mailbox idempotency key**: drainMailbox
   uses `for update` row lock + `delivered_at` marker. No in-memory
   deduping. Bypassing this allows double-delivery.
7. **`assembleToolPool` is the SSOT** (re-stating for emphasis): never
   compute "agent X's tools" anywhere else.

### When adding a new agent

1. Create `src/tools/AgentTool/agents/<name>/AGENT.md` with `role: lead`
   or `role: member` declared
2. Add the agent's `agentType` to `team_members` table seed/migration
3. The 4-layer filter handles tool resolution automatically — no code
   change needed unless you also need a new tool

### When adding a new tool

1. Add the tool name constant to its tool file
2. Decide: should `member` agents have it? If NO, add to
   `INTERNAL_TEAMMATE_TOOLS` in `blacklists.ts`
3. Should sync `subagent` invocations have it? If NO, add to
   `INTERNAL_SUBAGENT_TOOLS`
4. Register the tool in `src/tools/registry.ts` (or `registry-team.ts`)
5. Update the relevant AGENT.md `tools:` allow-list to include the new
   tool by name (optional — only needed if you want the agent to default-have it)

### Async lifecycle quick reference

- `Task({subagent_type, prompt})` → sync subagent (await result)
- `Task({subagent_type, prompt, run_in_background: true})` → async
  teammate (returns `{agentId}`; result later as `<task-notification>`)
- `SendMessage({type, to, content})` → continue / DM / broadcast / etc.
- `TaskStop({task_id})` → graceful shutdown (lead-only)
- `Sleep({duration_ms})` → yield BullMQ slot until duration or
  `SendMessage` arrives (member only — not subagents)

The `agent-run` BullMQ worker drives all teammate lifecycles. Each
teammate's transcript is persisted to `team_messages` per assistant turn
for resume-from-sleep continuity.
```

- [ ] **Step 3: Verify CLAUDE.md is well-formed**

```bash
head -200 CLAUDE.md
```

- [ ] **Step 4: Commit**

```bash
git add CLAUDE.md
git commit -m "docs(CLAUDE.md): codify Agent Teams Architecture invariants (Phase G)"
```

---

## Task 4: Verification gate + spec final landing

**Files:**
- Modify: `docs/superpowers/specs/2026-05-02-agent-teams-architecture-design.md` (final Phase G entry + completion summary)

- [ ] **Step 1: Run full project test sweep**

```bash
pnpm tsc --noEmit --pretty false
pnpm test 2>&1 | tail -40
```

Expected: 940+ pass (Phase E baseline). Any new red is a Phase G regression.

- [ ] **Step 2: Tag the milestone**

```bash
git tag -a phase-g-cleanup -m "Agent Teams Phase G — Cleanup + final docs complete"
git tag -a agent-teams-complete -m "Agent Teams architecture COMPLETE — Phases A→G all landed"
```

- [ ] **Step 3: Update spec doc with Phase G entry + COMPLETION summary**

Append to `## Implementation status`:

```markdown
- **Phase G — Cleanup + retire legacy + documentation:** landed `2026-05-02` on `dev`.
  SHIPFLARE_AGENT_TEAMS env flag dropped — Agent Teams is the default. Feature
  flag module + tests deleted. Task tool's async branch unconditionally taken
  when run_in_background:true. CLAUDE.md gained "Agent Teams Architecture"
  section codifying 7 cross-phase invariants. Spec doc finalized.
  - Task 1 — drop flag (code): <SHA>
  - Task 2 — drop flag (tests): <SHA>
  - Task 3 — CLAUDE.md invariants: <SHA>
  - Task 4 — verification gate + final spec entry: <SHA>

---

## OVERALL COMPLETION

**Agent Teams architecture COMPLETE on 2026-05-02.**

| Phase | Tasks | Status |
|---|---|---|
| A — Foundation | 13 | ✅ |
| B — Async lifecycle | 14 | ✅ |
| C — SendMessage protocol | 8 | ✅ |
| D — Sleep + Resume | 7 | ✅ |
| E — Team-lead unification (X driver) | 11 | ✅ |
| F — Team-lead prompt rewrite | 4 | ✅ |
| G — Cleanup + retire legacy + docs | 4 | ✅ |

**Total: 61 tasks across 7 phases.** All planned via `superpowers:writing-plans`,
executed via `superpowers:subagent-driven-development` with two-stage review
(opus model throughout). Tag: `agent-teams-complete`.

The architecture faithfully replicates Claude Code's Agent Teams layer
(engine PDF §3-§5) adapted for ShipFlare's server-side runtime
(BullMQ + Postgres). Founder UI input enters via `team_messages`; all
agent-to-agent communication flows through `team_messages` with the
appropriate `messageType` discriminator. team-lead is a regular
`agent_runs` row with `role='lead'`. Async teammates run as separate
BullMQ jobs and yield slots via `Sleep`. Workers wake on `SendMessage`
arrival via `wake()` (BullMQ jobId-deduped enqueue). The `<task-notification>`
XML protocol is engine-verbatim. INTERNAL_TEAMMATE_TOOLS / INTERNAL_SUBAGENT_TOOLS
blacklists protect single-direction tree topology. peer-DM shadows give
the lead low-cost transparency without preemptive wakeups.

Deferred to follow-up phases:
- Coordinator → team-lead rename (touches DB rows + alias mechanism)
- KAIROS-style proactive scheduling (PDF layer 3)
- autoDream nightly memory consolidation
- ULTRAPLAN cloud delegation
```

- [ ] **Step 4: Commit**

```bash
git add docs/superpowers/specs/2026-05-02-agent-teams-architecture-design.md
git commit -m "docs(spec): mark Agent Teams Phase G + OVERALL completion (Phases A→G complete)"
```

- [ ] **Step 5: Final summary commit if anything else needs landing**

If the working tree is clean (only the spec commit just made), no further action. Verify:

```bash
git status
git log --oneline | head -10
git tag | grep phase
```

Expected: clean working tree; recent commits trace through the Phase G work; all phase-* tags present.

---

## Acceptance criteria

- [ ] `src/lib/feature-flags/agent-teams.ts` deleted
- [ ] `src/lib/feature-flags/__tests__/agent-teams.test.ts` deleted
- [ ] `src/tools/AgentTool/AgentTool.ts` no longer imports or calls `isAgentTeamsEnabledForTeam`
- [ ] No grep hits for `isAgentTeamsEnabledForTeam` or `SHIPFLARE_AGENT_TEAMS` in `src/`
- [ ] `CLAUDE.md` has new "Agent Teams Architecture" section
- [ ] All tests pass (940+ baseline maintained)
- [ ] `pnpm tsc --noEmit` clean
- [ ] Local tags: `phase-g-cleanup` AND `agent-teams-complete`
- [ ] Spec doc has Phase G entry + OVERALL COMPLETION summary

---

## Self-review notes

1. **Spec coverage**: every Phase G item maps to a task. The coordinator → team-lead rename is explicitly deferred to a hypothetical Phase H with rationale.
2. **CLAUDE.md section is load-bearing**: future contributors will read it before touching the runtime. Keep it concise + actionable; it's not a re-explanation of the spec.
3. **The `agent-teams-complete` tag** is meaningful — it marks the moment the architecture matches Claude Code's Agent Teams layer. Worth explicit attention.
4. **No new features in Phase G** — strictly cleanup. If any `if/else` simplifications surface during the flag drop, take them; but no new functionality.
