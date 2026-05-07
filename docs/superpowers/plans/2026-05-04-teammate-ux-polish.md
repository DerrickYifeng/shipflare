# Teammate UX Polish — Spinner Verbs / PillLabel / Companion Sprite (Stub Plan)

> **Stub plan** — scoped intent. Ask "flesh out teammate-ux-polish plan" to expand into bite-sized TDD steps.
> Status: P2 (do later). Roadmap row #17.

## Goal

Bring the engine's per-teammate UX touches to /team:
1. **Spinner verbs** — each working teammate gets a randomized verb ("drafting", "scouting", "polishing") instead of a generic "working".
2. **PillLabel improvements** — status pill conveys richer state (drafting vs validating vs sleeping vs awaiting-approval).
3. **Zoomed teammate transcript** — click a teammate row → drawer shows its full per-turn transcript (we have `teammate-transcript-drawer.tsx` partially; complete it).
4. **CompanionSprite avatar** — small animated sprite per teammate (engine's CompanionSprite). Optional cosmetic.

Pure UX. No primitive changes. Lowest priority.

## Architecture

1. **Spinner verbs**: small dictionary keyed by `agentDefName` + per-tool optional override (e.g. when `process_replies_batch` is running, verb is "drafting replies"). Verb stable per teammate per turn (engine pattern — store in agent_runs metadata or compute deterministically from agentRunId).
2. **PillLabel state machine**: derive richer state from `agent_runs.status` + most-recent `tool_call.tool_name` + presence of pending `plan_approval_request` / `ask_user_question` rows. Mapping table:
   - `running` + last tool = `process_replies_batch` → "drafting"
   - `running` + last tool = `validate_draft` → "validating"
   - `sleeping` → "idle"
   - `sleeping` + pending `ask_user_question` from this teammate → "awaiting answer"
   - `sleeping` + pending `plan_approval_request` → "awaiting approval"
3. **Zoomed transcript**: `teammate-transcript-drawer.tsx` already exists; finish wiring it to the agent-detail data source. Shows messages, tool calls, tool results in chronological order with collapsible nodes.
4. **CompanionSprite**: optional. Skip for v1; add as a follow-up if founders ask for it.

## File map

**Modified**
- `src/app/(app)/team/_components/agent-status-pill.tsx` — derive richer state
- `src/app/(app)/team/_components/teammate-roster.tsx` — show spinner verbs
- `src/app/(app)/team/_components/teammate-transcript-drawer.tsx` — finish wiring + add empty/loading/error states
- `src/app/(app)/team/_components/agent-row.tsx` — click handler opens drawer

**Created**
- `src/lib/ui/spinner-verbs.ts` — verb dictionary + deterministic picker
- `src/app/(app)/team/_components/__tests__/agent-status-pill.test.tsx` — cover the new state mapping
- (optional) `src/app/(app)/team/_components/companion-sprite.tsx` — sprite component

## Tasks (high-level)

1. Spinner verbs dictionary + picker function. Stable per `(agentRunId, turnNumber)`.
2. Pill state derivation: read agent_runs row + last tool_call row + pending question/approval rows; produce a state enum.
3. Pill renderer: map state to color + label + optional spinner.
4. Transcript drawer: finish data fetch (use existing `/api/team/agent/[id]/transcript` if it exists; else add it), render messages chronologically.
5. Tests: state-mapping coverage for each pill state.
6. Manual visual check across status combinations.
7. (Optional) CompanionSprite.

## Tradeoffs / risks

- **Cosmetic — no business value.** This polish makes the team feel alive, but doesn't unblock founder work. Lowest priority among Tier-1/2/3 items.
- **State-mapping bugs become visible.** If pill says "drafting" but the agent is actually waiting on approval, founder gets confused. Mitigation: comprehensive tests + bias to "idle" / "working" generic states when ambiguous.
- **Transcript drawer is N+1 query bait.** Loading 100+ messages per teammate × multiple teammates → DB load. Mitigation: paginate (last 50 messages by default; "load older" button).
- **Sprite is fun but maintenance.** If we add it, every new agent type needs a sprite. Skip.

## Estimate

3–4 days for spinner + pill + transcript drawer. Add 2 days if sprites included.

## When to flesh out

After all P0/P1 plans land. UX polish is the right thing to do once the underlying primitives are stable. Trigger: a team / org milestone where the marketing-org UI needs to "feel professional" for a launch / press moment.
