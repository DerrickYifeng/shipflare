# TeamCreate / TeamDelete (Stub Plan — Argues Against)

> **Stub plan** — scoped intent. Status: **P3 (I argue against)**. Roadmap row #9.
> Override with: "expand team-create-delete plan; ignore my objection."

## Goal (if we did this)

Let the coordinator (or even a teammate) dynamically spin up sub-teams for ad-hoc work. Engine pattern: TL says "I need a research squad for X" → calls `TeamCreate({team_name: 'research-x', members: ['researcher', 'verifier']})` → squad runs concurrently with the main team → `TeamDelete` when done.

## Why I argue against

1. **Hosted SaaS shape.** Engine's TeamCreate writes to `~/.claude/teams/{name}/config.json` on local disk — a CLI primitive. We're multi-tenant SaaS; "create a team" maps to "insert rows in `teams` + `team_members` tables", which is a much heavier operation with auth/billing implications.
2. **One-team-per-user is the pricing unit.** A founder pays for "their marketing team." If the coordinator can spawn sub-teams, billing becomes ambiguous — does each sub-team count toward the budget? Per-team rate-limits get bypassed.
3. **The use case is researching/exploring, not running a team.** When engine TL says "I need a research squad", what's actually needed is parallel `Task()` calls (which we already have via `Task({run_in_background: true})`). The "team" abstraction adds nothing over parallel async subagents.
4. **Founder loses visibility.** With one team, /team page is the unified view. With dynamic sub-teams, the founder needs a team-of-teams navigation surface that doesn't exist.

## What the plan would look like (if greenlit)

### Architecture

1. **New tools**: `TeamCreate({name, members: AgentDefName[]})`, `TeamDelete({teamId})`. Both lead-only.
2. **Schema**: `teams` table gains `parentTeamId` (nullable, self-FK) so sub-teams link to their owner team. `team_members` rows for sub-teams are minted on TeamCreate.
3. **Budget**: sub-teams inherit parent team's weekly budget (no separate quota — prevents unbounded fan-out). `teamHasBudgetRemaining` checks the parent's pool.
4. **UI**: /team page gains a sub-team switcher; sidebar shows the team-of-teams tree. Sub-team conversations are nested under the parent.
5. **Lifecycle**: sub-teams auto-delete when parent's run completes OR after a TTL (e.g. 24h idle).

### File map

- Create: `src/tools/TeamCreateTool/TeamCreateTool.ts` + tests
- Create: `src/tools/TeamDeleteTool/TeamDeleteTool.ts` + tests
- Create: `drizzle/0023_subteams.sql`
- Modify: `src/lib/db/schema/team.ts` (add `parentTeamId`)
- Modify: `src/lib/team-budget.ts` (resolve parent on lookup)
- Modify: `src/lib/team-provisioner.ts` (skip auto-provision for sub-teams)
- Modify: `src/tools/registry-team.ts`
- Modify: coordinator AGENT.md (add tools + "when to spin up a sub-team" reference)
- Create: sub-team navigation UI (~500 lines)
- Modify: CLAUDE.md (document sub-team primitive)

### Tasks (high-level)

1. Migration adding `parent_team_id`.
2. TeamCreate tool: validate parent context, mint team + member rows, return `{teamId}`.
3. TeamDelete tool: validate parent ownership, cascade delete (or soft-delete) all sub-team rows.
4. Budget inheritance.
5. UI: sub-team switcher + tree sidebar.
6. AGENT.md updates.
7. TTL cleanup BullMQ cron.
8. Real-browser smoke.

## Tradeoffs / risks (assuming we do it)

- **Multi-tenant blast radius.** A bug that lets a sub-team mint rows with the wrong `parent_team_id` could leak conversations across users. Mandatory: `WHERE parent_team_id = $teamId AND parent_team.owner_id = $userId` on every query — enforced via review or RLS.
- **Billing math.** "1 team / 1 week / 1000 LLM calls" becomes "1 team-tree / 1 week / 1000 calls split across N sub-teams." Founder has no way to budget per-sub-team.
- **The 90% case is `Task({run_in_background: true})`.** That tool already gives parallel execution. TeamCreate's marginal value is "name the parallel work" — UI nicety, not a primitive.

## My recommendation

**Don't do this.** Use parallel `Task({run_in_background: true})` for ad-hoc parallel work. If the founder ever genuinely needs to manage multiple distinct marketing efforts (e.g. "Product A team" vs "Product B team" under one account), that's a **product** feature not an agent-team primitive — handle via separate `productId` scoping, which we already have.

## If you override

- Confirm by saying: "expand TeamCreate/Delete plan; I want dynamic sub-teams."
- I'll generate the bite-sized TDD plan. Estimate: 7–10 days (mostly multi-tenancy hardening + UI).
