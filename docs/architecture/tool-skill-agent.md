# Tool / Skill / Agent — the trinity

ShipFlare ports Claude Code's three primitives. Each has a different purpose;
when you add new behavior, decide which bucket it belongs in *before* writing
code.

## Definitions

| Primitive | Public contract | Decision-maker | Lifetime | Spawned by | Identity |
|---|---|---|---|---|---|
| **Tool** | Schema in / data out | Deterministic. May call a model internally as a black box, but the caller's model never reads tool internals to use it. | Single `execute()` call. | Any agent's tool-call. | Snake_case verb (`reddit_search`, `query_plan_items`). |
| **Skill** | Reusable workflow / playbook authored as a prompt. | Caller's model reads the body (`context: inline`) OR a one-shot subagent executes it (`context: fork`). | Single invocation. | `SkillTool` (or worker-side `runForkSkill`). | Gerund (`drafting-encouraging-replies`) or kebab-noun. |
| **Agent** | Persistent character: system prompt + `tools:` + `skills:` + role. | Owns its own multi-turn loop; can plan, delegate, compose. | Multi-turn until `StructuredOutput`, model finishes, or `maxTurns` hit. | `AgentTool` (`Task`) with `subagent_type: <name>`, OR file-path load from a worker processor. | Role noun (`coordinator`, `growth-strategist`). |

## Decision rules

**Tool vs Skill:**
- `execute()` calls a model AND the model is making **content / strategy /
  judgment** decisions → **skill**, not tool.
- `execute()` calls a model BUT the model is doing tightly-bounded structured
  I/O (parser, narrow extractor) → can stay a **tool**.
- `execute()` is pure (DB / API wrapper / validator / persister) → **tool**.

**Agent vs fork-skill:**
- Multi-turn loop with planning, delegation, composition → **agent**.
- Reads structured input, runs a fixed script, returns → **fork-skill**.
- Tell-tale signal: `maxTurns ≤ 5` AND no `Task` in tools list AND no per-turn
  judgment branching → almost always a fork-skill.

## Canonical examples

- Tool: `src/tools/RedditSearchTool/RedditSearchTool.ts` (API wrapper, no LLM).
- Inline skill: `src/skills/_demo-echo-inline/SKILL.md` (content injected into
  caller's turn).
- Fork skill: `src/skills/_demo-echo-fork/SKILL.md` (one-shot subagent).
- Agent: `src/tools/AgentTool/agents/coordinator/AGENT.md` (multi-turn delegator).

## When adding a new primitive

1. Apply the decision rules above. If unsure, document why both apply and
   pick the simpler shape.
2. Match an existing canonical example's file structure.
3. For tools: register in `src/tools/registry.ts` and add at least one
   AGENT.md `tools:` declaration before merging — otherwise the tool is
   dead code.
4. For agents: confirm at least one spawn caller (`Task({ subagent_type })`
   or worker file-path load) before merging.
5. For skills: gerund-form name preferred; declare `context: inline | fork`
   explicitly; set `maxTurns` only when the default (8 for fork) is wrong.
