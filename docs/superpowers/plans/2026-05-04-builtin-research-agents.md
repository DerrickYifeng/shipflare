# Built-in Research Agents (Explore / Plan / general-purpose) (Stub Plan)

> **Stub plan** — scoped intent. Ask "flesh out builtin-research-agents plan" to expand into bite-sized TDD steps.
> Status: P2 (do later). Roadmap row #13.

## Goal

Add domain-agnostic **research agents** — `Explore` (read-only file/DB search), `Plan` (read-only architecture/strategy planning), `general-purpose` (full-tool worker for one-off tasks). Mirrors engine's `engine/tools/AgentTool/built-in/`.

Lets the coordinator delegate research that doesn't fit social-media-manager's scope. Example: "research competitor X's posting cadence over the last 90 days" — today coordinator either does it inline (slow, pollutes its context) or shoehorns into social-media-manager (wrong tool — that agent's job is execution, not research).

## Architecture

1. **Three new agents** in `src/tools/AgentTool/agents/_builtin/`:
   - `Explore` — read-only: `query_*` tools, `find_threads`, `read_memory`, `WebFetch`. NO Send/write tools. NO Task (can't fan out further).
   - `Plan` — read-only: same as Explore + `query_strategic_path`. NO write tools. Output is a plan markdown.
   - `general-purpose` — full tool list (member role, default blacklist applies). Use for one-off jobs that don't fit any specialist.
2. **Loader change**: `loadAgentsDir` already scans `agents/*/AGENT.md`; no change needed if files placed in `agents/_builtin/`. Verify the loader doesn't filter `_`-prefixed dirs.
3. **Schema**: each gets a small `StructuredOutput` schema (Explore: `{findings: string, sourcesScanned: number}`; Plan: `{plan: string, openQuestions: string[]}`; general-purpose: `{result: string}`).
4. **Coordinator AGENT.md update**: add a "When to delegate to Explore vs social-media-manager" reference.
5. **No new tools.** These are pure agent definitions reusing existing tools.

## File map

**Created**
- `src/tools/AgentTool/agents/_builtin/Explore/AGENT.md`
- `src/tools/AgentTool/agents/_builtin/Explore/schema.ts`
- `src/tools/AgentTool/agents/_builtin/Explore/__tests__/loader-smoke.test.ts`
- `src/tools/AgentTool/agents/_builtin/Plan/` (same shape)
- `src/tools/AgentTool/agents/_builtin/general-purpose/` (same shape)
- `src/tools/AgentTool/agents/coordinator/references/when-to-use-builtin-agents.md`

**Modified**
- `src/tools/AgentTool/agent-schemas.ts` — register 3 schemas
- `src/tools/AgentTool/agents/coordinator/AGENT.md` — add reference + 1 example
- `src/tools/AgentTool/loader.ts` — confirm `_builtin/` is scanned (or skip the underscore prefix filter)
- `CLAUDE.md`

## Tasks (high-level)

1. Verify loader scans `_builtin/` (or fix it).
2. Write `Explore` AGENT.md — domain-agnostic researcher prompt. Reuse engine wording where possible.
3. Same for `Plan` and `general-purpose`.
4. Three schemas + register in `agent-schemas.ts`.
5. Loader smoke tests for each (one per agent).
6. Coordinator's reference — "use Explore for research, social-media-manager for execution."
7. Real-browser smoke: trigger a coordinator scenario that delegates to Explore; verify spawn works + StructuredOutput parses.

## Tradeoffs / risks

- **Diverts coordinator's attention.** Today coordinator delegates only to social-media-manager — simple model. With 3 more agent types, coordinator must remember when to use which. Mitigation: keep the reference doc terse; lean on agent `description:` text in the Task tool's roster listing.
- **Maintenance burden.** Three more AGENT.mds to keep in sync with engine evolution. Acceptable if we lift verbatim from engine on each upgrade.
- **`general-purpose` is a footgun.** It has all member-role tools. Coordinator could spawn it for routine work that should go to social-media-manager (skipping voice / slop discipline). Mitigation: AGENT.md description leads with "use ONLY when no specialist fits"; add lint that warns on every general-purpose spawn.
- **Don't blindly copy engine's prompts.** Engine's `Explore` is for software-engineering codebases; ours is for marketing research. Adapt the body, keep the structure.

## Estimate

3–4 days. Mostly prompt writing + loader verification.

## When to flesh out

When the coordinator visibly struggles with research tasks it shouldn't be doing inline. Trigger: founder asks "why is the coordinator's response so long?" or you observe coordinator burning tokens on web research.
