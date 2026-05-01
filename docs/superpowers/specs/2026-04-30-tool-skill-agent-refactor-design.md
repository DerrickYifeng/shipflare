# Tool / Skill / Agent re-classification refactor — design

**Date**: 2026-04-30
**Author**: ShipFlare Dev (brainstorming with Claude)
**Status**: design — ready for plan
**Related**: follow-up to `2026-04-30-skill-primitive-restoration-design.md`
(Phase 1 of the skill primitive landed at merge `d5798aa`); this spec is the
Phase 2 content migration that lands real skills on the restored primitive.

---

## 1. Background

Phase 1 restored the Skill primitive as infrastructure. Loader, registry,
`SkillTool`, `_demo-echo-{inline,fork}`, and `_bundled/_smoke` all ship.
`src/skills/` exists as a top-level directory mirroring `engine/skills/`, and
agent `AGENT.md` files can declare `skills: [...]` in frontmatter again.

But **no real ShipFlare logic has been migrated onto the new primitive yet.**
The 9 agents in `src/tools/AgentTool/agents/*` and 40 tools in `src/tools/*`
were authored before the Skill primitive came back. Three concrete consequences:

1. **`src/agents/` exists as a vestigial top-level folder** with 2 files
   (`react-preamble.md`, `schemas.ts`). Claude Code has no such directory —
   agents are owned by `AgentTool/`. The folder is a left-over from an earlier
   layout and never got cleaned up.
2. **`src/tools/` is heterogeneous.** Most are deterministic (DB reads, API
   wrappers, validators, persisters, runtime primitives). One — `ClassifyIntentTool`
   — calls `anthropic.messages.create()` with a system prompt that asks the
   model to make a 3-layer semantic judgment. By Claude Code's own line that
   is a fork-mode skill, not a tool.
3. **Three agents are one-shot workflows masquerading as multi-turn agents.**
   `draft-review` (`maxTurns: 2`), `posting` (`maxTurns: 5`), and
   `engagement-monitor` (`maxTurns: 5`) read structured input, follow a fixed
   script, and return. They have no planning, no delegation, no character —
   they are routines. The agent profile fits worse than the fork-skill profile.

This spec resolves the misclassifications, removes the vestigial folder, and
documents the trinity convention so future additions land in the right bucket.

## 2. Goals

1. Every primitive in `src/` is correctly classified as Tool, Skill, or Agent
   per Claude Code's engine convention.
2. The misclassified four (`ClassifyIntentTool` + 3 agents) move to skills
   with **no behavior change and no maxTurns change** — the migration is a
   relabeling, not a rewrite.
3. `src/agents/` is deleted; its two files move into `AgentTool/`.
4. A short architecture doc (`docs/architecture/tool-skill-agent.md`) is added
   documenting the trinity so future contributors know which bucket a new
   primitive belongs in.

### Non-goals

- Refactoring the AGENT.md prompts of agents that stay agents
  (`coordinator`, `post-writer`, `community-manager`, `content-planner`,
  `growth-strategist`, `discovery-agent`).
- Splitting `src/tools/SkillTool/loadSkillsDir.ts` out of `SkillTool/` to
  match `engine/skills/loadSkillsDir.ts`'s top-level placement. Cosmetic;
  defer.
- Migrating `XaiFindCustomersTool` to a skill. It calls Grok but its public
  contract is tight (`(history, productContext) → tweets`); kept as tool.
- Touching helper files (`context-helpers.ts`, `seo-audit.ts`,
  `url-scraper.ts`). They're onboarding glue, not primitives.
- Phase 2+ content extraction work (`drafting-encouraging-replies`,
  `judge-reply-opportunity`, `validate-and-repair-tone`) — that's the next
  spec, on top of this one.

## 3. The trinity — definition

| Primitive | Public contract | Decision-maker | Lifetime | Spawned by | Identity convention |
|---|---|---|---|---|---|
| **Tool** | Schema in / data out | Deterministic. May call a model internally as a black box (e.g., engine's `WebSearchTool`), but the caller's model never reads tool internals to use it. | Single `execute()` call. | Any agent's tool-call. | Snake_case verb (`reddit_search`, `query_plan_items`). |
| **Skill** | Reusable workflow / playbook authored as a prompt. | Caller's model reads the body (inline) OR a one-shot subagent executes it (fork). | Single invocation: inline = one tool result; fork = one bounded subagent run. | `SkillTool`. | Gerund noun (`drafting-encouraging-replies`) or kebab-noun (`draft-single-post`). |
| **Agent** | A persistent character: system prompt + `tools:` allowlist + `skills:` allowlist + role. | Owns its own multi-turn loop, can plan, delegate, and compose. | Multi-turn until model emits StructuredOutput, finishes naturally, or hits `maxTurns`. | `AgentTool` (the `Task` primitive) with `subagent_type: <name>`. | Role noun (`coordinator`, `growth-strategist`). |

**The decision rule for tool-vs-skill** (used throughout Section 5):

- `execute()` calls a model AND the model is making **content / strategy /
  judgment decisions** → it's a **skill**, not a tool.
- `execute()` calls a model BUT the model is doing tightly-bounded structured
  I/O (parser, narrow extractor) → can stay a **tool**.
- `execute()` is pure (DB / API wrapper / validator) → it's a **tool**.

**The decision rule for agent-vs-fork-skill:**

- Multi-turn loop with planning, delegation, composition → **agent**.
- Reads structured input, runs a fixed script, returns → **fork-skill**.
- Tell-tale signal: `maxTurns ≤ 5` AND no `Task` in the tools list AND no
  per-turn judgment branching → almost always a fork-skill.

## 4. Classification verdict

The full audit (40 tools, 9 agents, 2 demos) is summarized below. Sources:
read of every `*.ts` in `src/tools/*` and every `AGENT.md` in
`src/tools/AgentTool/agents/*`.

### 4.1 Tools — 39 stay, 1 moves

| Group | Count | Examples | Status |
|---|---|---|---|
| Runtime primitives | 4 | `AgentTool` (Task), `SkillTool`, `SendMessageTool`, `StructuredOutputTool` | keep |
| DB reads | 10 | `Query{PlanItems,ProductContext,Metrics,RecentXPosts,StalledItems,LastWeekCompletions,RecentMilestones,StrategicPath,TeamStatus}Tool`, `FindThreadsTool` | keep |
| DB writes / persisters | 5 | `WriteStrategicPathTool`, `Add/UpdatePlanItemTool`, `DraftPostTool`, `DraftReplyTool` | keep |
| Pure validators | 1 | `ValidateDraftTool` (twitter-text + regex + token count, no model) | keep |
| Pipeline persistence | 1 | `PersistQueueThreadsTool` | keep |
| Reddit API | 8 | `Reddit{Search,Post,Verify,DiscoverSubs,GetThread,GetRules,HotPosts,SubmitPost}Tool` | keep |
| X API | 5 | `X{Post,GetTweet,GetMentions,GetUserTweets,GetMetrics}Tool` | keep |
| HN/Web API | 3 | `HnSearchTool`, `HnGetThreadTool`, `WebSearchTool` | keep |
| xAI conversational | 1 | `XaiFindCustomersTool` | keep (borderline; kept because Grok is encapsulated and contract is tight) |
| **Tool → fork-skill** | **1** | **`ClassifyIntentTool`** | **migrate** |

`ClassifyIntentTool` justification: `execute()` opens an `Anthropic` client and
sends a system prompt asking the model to score `contentType`,
`buyerStageScore`, and `engagementPriority`. That is editorial judgment, not
structured extraction.

### 4.2 Agents — 6 stay, 3 move

| Agent | maxTurns | Verdict | Reason |
|---|---|---|---|
| `coordinator` | 25 | keep | Decomposes goals, fans out via `Task`, composes outputs. Pure delegator. |
| `post-writer` | 12 | keep | Iterative draft → validate → repair → persist loop. |
| `community-manager` | 16 | keep | Inbox iteration with per-thread judgment + draft. |
| `content-planner` | 20 | keep | Multi-channel allocation with strategy reasoning. |
| `growth-strategist` | 10 | keep | Authors 30-day narrative + milestones. |
| `discovery-agent` | 60 | keep | Conversational refinement loop with Grok. |
| **`draft-review`** | **2** | **migrate to fork-skill** | Receives JSON, runs validation checklist, returns verdict. No planning/delegation. |
| **`posting`** | **5** | **migrate to fork-skill** | Receives JSON, posts to platform, verifies, returns. Sequential procedure. |
| **`engagement-monitor`** | **5** | **migrate to fork-skill** | Receives JSON, calls `x_get_mentions`, drafts response. One workflow. |

### 4.3 Skills — 2 demos stay, gain 4

Phase 1 demos (`_demo-echo-inline`, `_demo-echo-fork`) and `_bundled/_smoke`
remain unchanged. Four new skills land:

| New skill | Mode | maxTurns | From |
|---|---|---|---|
| `classifying-intent` | fork | 8 (default) | `ClassifyIntentTool` |
| `reviewing-drafts` | fork | **2** (preserved) | `draft-review` agent |
| `posting-to-platform` | fork | **5** (preserved) | `posting` agent |
| `monitoring-engagement` | fork | **5** (preserved) | `engagement-monitor` agent |

Names use the gerund form per CLAUDE.md's preferred convention
(`drafting-encouraging-replies` style). The kebab-verb form
(`draft-single-post`) is also accepted; final names can be revisited at
plan time.

### 4.4 Loose / vestigial

| File | Action | Reason |
|---|---|---|
| `src/agents/react-preamble.md` | move into `src/tools/AgentTool/` | The prefix appended to every agent's system prompt belongs where AGENT.md is loaded. |
| `src/agents/schemas.ts` | move into `src/tools/AgentTool/` | Agent-related Zod schemas. Same reason. |
| `src/agents/` (the folder) | **delete** | Vestigial. Engine has no equivalent. |
| `src/tools/context-helpers.ts` | keep | Domain-tool dependency-injection utility. |
| `src/tools/seo-audit.ts` | keep | Onboarding helper called by API routes, not a tool. |
| `src/tools/url-scraper.ts` | keep | Onboarding helper. Calls Anthropic SDK in `analyzeProduct()` but is not registered as a tool. |

## 5. Migration plan

Each migration is **independent** and can be shipped as its own commit/PR.
They are not strictly ordered; I list them roughly in increasing risk.

### 5.1 Delete `src/agents/` (lowest risk)

**What:**
- Move `src/agents/react-preamble.md` → `src/tools/AgentTool/react-preamble.md`.
- Move `src/agents/schemas.ts` → `src/tools/AgentTool/agent-schemas.ts` (or
  merge into existing `src/tools/AgentTool/agent-schemas.ts` if there's no
  symbol collision — verify at plan time).
- Update imports throughout `src/`.
- Delete `src/agents/` directory.

**Risk:** purely structural, no behavior change. Build / type-check is the
gate.

### 5.2 `ClassifyIntentTool` → `classifying-intent` fork-skill

**What:**
- Create `src/skills/classifying-intent/SKILL.md` with `context: fork`,
  `allowed-tools:` (empty value — no tools needed; the skill makes a single
  LLM call), and the existing system prompt as the body.
- Move the structured-output schema into the skill's prompt as JSON output
  instructions (fork-skills currently return string; caller parses).
  Alternatively, expose the skill via SkillTool's existing fork plumbing
  (which calls `spawnSubagent` with `outputSchema: undefined`) and have the
  caller of the skill parse the JSON output.
- Delete `src/tools/ClassifyIntentTool/` (folder + tests).
- Remove registration from `src/tools/registry.ts`.
- Update every caller currently using `classify_intent` tool-call to invoke
  via `Skill({ skill: 'classifying-intent', args: <text> })` instead.

**Risk:** moderate. Fork-mode skills currently return string content; if the
caller expects a typed JSON object back, the integration boundary needs care.
At plan time, audit every call site of `classify_intent` and decide whether
to (a) parse JSON in the caller or (b) extend SkillTool to support per-skill
output schemas.

**maxTurns:** default 8 is fine — the skill makes one model call and returns;
the budget is unused. Could be tightened to 1 in SKILL.md frontmatter if we
want to be defensive.

### 5.3 `draft-review` agent → `reviewing-drafts` fork-skill

**What:**
- Create `src/skills/reviewing-drafts/SKILL.md`. Body = current `AGENT.md` body
  + inlined references (`output-format.md`, `review-checklist.md`,
  `x-review-rules.md`).
- Frontmatter:
  ```yaml
  name: reviewing-drafts
  description: <copied from AGENT.md>
  context: fork
  maxTurns: 2
  allowed-tools:
    - validate_draft
  ```
- Delete `src/tools/AgentTool/agents/draft-review/`.
- Update every caller currently using `Task({ subagent_type: 'draft-review', ... })`
  to invoke via `Skill({ skill: 'reviewing-drafts', args: <json> })`.
- Verify the structured-output contract: the agent currently returns
  `{ verdict, problems[], suggestion }` via StructuredOutput. Plan-time
  decision: same as 5.2 — caller-parses-JSON or skill-side schema support.

**Risk:** moderate. Same JSON-output question as 5.2. Behavior is otherwise
identical.

**maxTurns:** **2 — preserved unchanged** per user direction.

### 5.4 `posting` agent → `posting-to-platform` fork-skill

**What:**
- Create `src/skills/posting-to-platform/SKILL.md`. Body = current `AGENT.md`
  body + inlined references (`output-format.md`, `x-posting-steps.md`,
  `reddit-posting-steps.md`).
- Frontmatter:
  ```yaml
  name: posting-to-platform
  description: <copied from AGENT.md>
  context: fork
  maxTurns: 5
  allowed-tools:
    - reddit_post
    - reddit_submit_post
    - reddit_verify
    - x_post
  ```
- Delete `src/tools/AgentTool/agents/posting/`.
- Update every caller (`Task({ subagent_type: 'posting', ... })`) to use
  `Skill({ skill: 'posting-to-platform', args: <json> })`.

**Risk:** moderate-high. This skill writes to the network (`reddit_post`,
`x_post`). Side-effects must be exactly preserved during migration. Plan
should include manual verification on a test channel before deleting the
agent.

**maxTurns:** **5 — preserved unchanged**.

### 5.5 `engagement-monitor` agent → `monitoring-engagement` fork-skill

**What:**
- Create `src/skills/monitoring-engagement/SKILL.md`. Body = current `AGENT.md`
  body + inlined references.
- Frontmatter:
  ```yaml
  name: monitoring-engagement
  description: <copied from AGENT.md>
  context: fork
  maxTurns: 5
  allowed-tools:
    - x_get_mentions
    - draft_reply
  ```
- Delete `src/tools/AgentTool/agents/engagement-monitor/`.
- Update callers.

**Risk:** moderate. Drafts go to the inbox, not directly to the network —
lower blast radius than 5.4.

**maxTurns:** **5 — preserved unchanged**.

### 5.6 Architecture doc

Add `docs/architecture/tool-skill-agent.md` with:
- The trinity table from Section 3.
- The decision rules.
- Pointers to canonical examples for each (`reddit_search` for tool,
  `reviewing-drafts` for fork-skill, `_demo-echo-inline` for inline-skill,
  `coordinator` for agent).
- A "when adding a new primitive" checklist.

This is the cheapest insurance against future drift.

## 6. maxTurns convention (frozen here)

Per user direction: **all existing maxTurns values are preserved** through the
migrations. The fork-skill default (`DEFAULT_SKILL_FORK_MAX_TURNS = 8`) only
applies to new skills that don't override; the three migrated agents-to-skills
explicitly set their existing values (2 / 5 / 5) in SKILL.md frontmatter.

For reference, the convention going forward:

| Primitive shape | Recommended maxTurns |
|---|---|
| Pure delegator agent | 20–25 |
| Iterative content agent | 10–20 |
| Conversational agent | 30–60 |
| Fork-skill, single LLM call | 1–2 (or accept default 8) |
| Fork-skill, tool sequence | 3–5 |
| Fork-skill, tool loop with branching | 6–8 |
| Inline skill | n/a (runs in caller's turn) |

ShipFlare's caps are tighter than engine's (engine leaves most agents
unbounded) because ShipFlare runs in BullMQ with a budget envelope and no
human in the loop. Keep this convention.

## 7. Risks and open questions

1. **Fork-skill structured output.** Three of the four migrated workflows
   (`classifying-intent`, `reviewing-drafts`, `monitoring-engagement`) currently rely
   on agents' `StructuredOutput` contract. SkillTool's fork branch
   (`src/tools/SkillTool/SkillTool.ts:79-100`) currently passes
   `outputSchema: undefined` to `spawnSubagent`. Plan must decide whether to:
   - (a) extend SkillTool to support per-skill output schemas (cleaner, but
     touches the SkillTool surface area Phase 1 just stabilized), or
   - (b) keep skills returning JSON-stringified text and have callers parse
     (simpler, but every caller becomes a JSON parser).
   Recommended: (b) for this spec, defer (a) to a follow-up if structured
   output skills become common.
2. **Caller audit.** Every `Task({ subagent_type: 'draft-review' })`,
   `Task({ subagent_type: 'posting' })`, `Task({ subagent_type: 'engagement-monitor' })`,
   and `classify_intent` tool-call must be located and rewritten. Plan should
   begin with a `grep -rn` audit and produce the full callsite list before
   any deletion.
3. **`coordinator` AGENT.md TEAM_ROSTER injection.** When `posting` /
   `draft-review` / `engagement-monitor` leave the agent registry, they
   stop appearing in the auto-injected `{TEAM_ROSTER}`. Coordinator's prompt
   needs to learn about them as skills instead — possibly via a parallel
   skill-roster injection. Verify at plan time.
4. **`agents/_shared/references/`** — referenced by post-writer,
   community-manager, content-planner, etc. The migrated agents currently
   import these via `shared-references:` frontmatter. Verify that disposing
   of `draft-review` / `posting` / `engagement-monitor` doesn't orphan any
   shared reference; if they reference shared docs, the docs themselves stay
   (they belong to the surviving agents).
5. **`XaiFindCustomersTool` borderline.** Kept as tool in this spec, but the
   line is drawn deliberately. If a future audit decides "any tool that calls
   a foreign-provider model is a skill," this becomes the next migration.

## 8. Out of scope

- Phase 2+ content-extraction work that the Phase 1 spec hinted at
  (`drafting-encouraging-replies`, `judge-reply-opportunity`,
  `validate-and-repair-tone`). That's a separate spec on top of this one.
- Splitting `loadSkillsDir.ts` out of `SkillTool/` to match engine layout.
- Adding `src/tools/AgentTool/built-in/` for TS-registered agents (nothing
  to put there yet).
- Reorganizing `src/tools/` into platform sub-folders (`reddit/`, `x/`,
  `hn/`). Cosmetic; defer.
- Touching helper files outside the trinity.

## 9. Phase ordering

Each section in 5.1–5.6 is independently shippable. Suggested order if
shipping incrementally:

1. **5.6 — architecture doc** first. Cheap, documents intent, no code change.
2. **5.1 — delete `src/agents/`** next. Pure structural, smallest blast radius.
3. **5.2 — `ClassifyIntentTool` → skill** next. Smallest behavior migration;
   single LLM call, easy to verify. Surfaces the structured-output question
   (Section 7.1) on the simplest case.
4. **5.3 — `draft-review` → skill** next. Pure judgment, no network writes.
5. **5.5 — `engagement-monitor` → skill** before 5.4. Drafts only; lower
   blast radius than network posts.
6. **5.4 — `posting` → skill** last. Network-write side effects; defer until
   the structured-output and caller-rewrite patterns are proven on the
   earlier migrations.

A single "big-bang" PR is also viable but carries 5x the review surface for
no behavior gain; recommend the incremental path.
