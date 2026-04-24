# ShipFlare AI Team Platform — Design Spec

**Date**: 2026-04-20
**Status**: Proposed, pending review
**Supersedes**: `2026-04-20-planner-and-skills-redesign-design.md` (partially — keeps `plan_items` / `strategic_paths` schema, replaces the skill-runner + two-tier planner)
**Branch**: `dev`
**Authors**: yifeng + Claude

---

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [Product Vision](#2-product-vision)
3. [Guiding Principles](#3-guiding-principles)
4. [End-State Architecture](#4-end-state-architecture)
5. [Port Manifest (Claude Code → ShipFlare)](#5-port-manifest-claude-code--shipflare)
6. [Data Model](#6-data-model)
7. [The 4-Layer Decision Stack](#7-the-4-layer-decision-stack)
8. [Initial Agent Roster](#8-initial-agent-roster)
9. [Domain Tool Catalog](#9-domain-tool-catalog)
10. [File Tree (Before → After)](#10-file-tree-before--after)
11. [Phase Breakdown](#11-phase-breakdown)
12. [Feature Flags](#12-feature-flags)
13. [Delete Manifest](#13-delete-manifest)
14. [Testing Strategy](#14-testing-strategy)
15. [Observability & Cost](#15-observability--cost)
16. [Risk & Mitigation](#16-risk--mitigation)
17. [Rollback Plan](#17-rollback-plan)
18. [Open Questions](#18-open-questions)

---

## 1. Executive Summary

### What we're building

A refactor that takes ShipFlare from "GTM tool with 19 single-purpose skills" to **"curated AI marketing team for founders"**.

Each user gets a pre-configured team of specialized AI agents (starting with 3, growing to 6 in Phase E). Team composition is **product-decided, not user-configurable** — we curate for quality; the user doesn't pick or tune members. A `coordinator` agent acts as chief of staff — receives goals, decides whether to handle directly or delegate to specialists, spawns specialists in parallel when subtasks are independent.

### What changes in one paragraph

Replace `strategic-planner` + `tactical-planner` + 15+ skill agents + custom `skill-runner`/`swarm`/`fanOutCached`/`coordinator` infrastructure with: **one `coordinator` agent + 2-5 specialist agents** that delegate to each other via a ported-from-Claude-Code `Task` tool. Structured output goes through a CC-aligned `StructuredOutput` tool (replacing `output_config.format` + 150-line sanitizer). Team state lives in 5 new DB tables. UI gains a `/team` page showing member cards + real-time activity.

### Why now

1. **Grammar sanitizer has hit the ceiling** — three 400-errors in production, each requiring a new workaround
2. **Product isn't launched yet** — clean cutover possible, no backwards-compat debt
3. **Positioning opportunity** — "AI marketing team" > "post scheduler" for fundraising + user story
4. **Architectural debt compounds** — each new skill today means adding to `_catalog.ts` + writing `.md` + registering schema + updating skill-runner. After refactor: add one `AGENT.md`

### Net effect

| Dimension | Before | After |
|---|---|---|
| Agent files | 19 skill `.md` + 2 planner `.md` | 3-6 `AGENT.md` + CC-ported references |
| Orchestration layers | 9 (runSkill → skill-runner → coordinator → swarm → fanOutCached → runAgent → skill.md → output_config → sanitizer) | 3 (API route → BullMQ worker → runAgent with Task + StructuredOutput tools) |
| Structured output path | `output_config.format.schema` + 150-line sanitizer + 3 bailout flags | `StructuredOutput` tool + Zod validation + Stop-hook enforcement |
| Adding a new specialist | ~500 lines (skill dir + schema + catalog entry + runner routing) | ~50 lines (one `AGENT.md` + auto-provisioned `team_members` row) |
| Net code change | — | **-5000 lines** (delete 7000, add 2000) |
| Timeline | — | **~2.5 weeks** |

### Decisions (already settled)

- **D1 — Starter team size**: 3 agents (coordinator + growth-strategist + content-planner). 3 more (x-writer, reddit-writer, community-manager) in Phase E
- **D2 — Coordinator delegation**: Fully autonomous via prompts (no routing code). Claude Code pattern exactly
- **D3 — Subagent execution**: In-process spawn, single BullMQ worker per team_run
- **D4 — Rollout**: Direct cutover, no dual-track (product isn't launched)
- **D5 — Pre-existing terminal-tool code**: Keep, rename `submit_X` → `StructuredOutput`
- **D6 — Team composition**: Product-decided, not user-configurable. Team auto-provisioned on account creation based on product category. No user-facing customization UI. (Internal tuning via admin-only migration/config.)

---

## 2. Product Vision

### User mental model

> "I have an AI marketing team. They work together to plan and execute my launch. A Chief of Staff (coordinator) takes my goals and routes them to the right specialist. I can see who's on my team, what each is working on, and talk to them when I need to. The team composition is ShipFlare's decision — they know which roles work well together."

**We decide the team, not the user.** Like hiring a marketing agency that brings a pre-configured crew — the founder doesn't interview each hire, they trust the agency's judgment. This is a deliberate product choice:

- Simpler cognitive load for the founder (one less thing to configure)
- We curate for team synergy (we know which roles pair well)
- Less support burden (no "my team doesn't work" tickets from bad custom compositions)
- Positioning advantage — "a team that knows what it's doing" beats "assemble your own"

### Team composition (Phase B)

Auto-provisioned on account creation / first product creation:

| Role | Specialty | Parallel of |
|---|---|---|
| `coordinator` | Receives founder goals, delegates, composes outputs | CEO's Chief of Staff |
| `growth-strategist` | Designs the 30-day narrative arc, thesis, milestones, pillars | Head of Growth |
| `content-planner` | Weekly tactical plan — which posts/emails/tasks this week | Head of Content |

### Team composition (Phase E)

Added automatically when user's connected channels justify them:

| Role | Specialty | Auto-added when |
|---|---|---|
| `x-writer` | Drafts X posts | User connects X channel |
| `reddit-writer` | Drafts Reddit submissions/comments | User connects Reddit channel |
| `community-manager` | Reply-guy workflow | User has ≥1 platform channel connected |

### User interaction surfaces

- **Onboarding**: team auto-provisioned silently — user sees them on Stage 6 ("Meet your team") as read-only intro card (no choices to make)
- **`/today`** (existing): approval cards for items produced by the team
- **`/team`** (new): grid of member cards (read-only), activity log, send direct message to steer a specific member

**Explicitly NOT in scope**:
- `/settings/team` management UI
- Custom personas / persona_override
- Add/remove members UI
- Rename members UI
- Pick-your-team onboarding stage

### What success looks like at end of refactor

- User onboards; team of 3 auto-provisioned; sees them produce strategic_path + plan_items + drafts within 60s
- `/team` page shows real-time "Growth Strategist is writing your 30-day path..." → "Content Planner is scheduling 12 items..."
- Founder asks "re-plan this week" in `/team` chat → coordinator decides whether to spawn content-planner or handle directly, user sees the decision in activity log
- Admin dashboard shows cost/team/week, activity breakdown per member
- User can adjust their plan via approval cards on `/today` — the same familiar surface. The team metaphor is additive transparency, not a required interaction surface

---

## 3. Guiding Principles

### P1 — Preserve Claude Code's prompts

**Claude Code's delegation teaching prompts are the core of the system's reliability.** They are the result of Anthropic's internal iteration on how Claude reasons about tool-use and sub-agent delegation. We port them verbatim wherever possible, only substituting domain-specific tool names and removing CLI-specific content (tmux, Bash tool, worktree).

**Scope matters** — CC organizes these prompts by scope:

| Scope | What it means | Location in CC | Location in SF |
|---|---|---|---|
| **Tool description** | Content injected into a tool's description string. Every agent with that tool in its allowlist sees it automatically. | `engine/tools/AgentTool/prompt.ts` | `src/tools/AgentTool/references/` |
| **Agent system-prompt** | Content an agent pulls into its own system prompt via frontmatter `shared-references` or `references`. | `engine/tools/AgentTool/built-in/<agent>.ts` | `src/tools/AgentTool/agents/<agent>/references/` or `src/tools/AgentTool/agents/_shared/references/` |

**Concrete implication** — the 3 ported markdown files live in DIFFERENT places by scope:

| File | Scope | CC source | SF location |
|---|---|---|---|
| `delegation-teaching.md` — "When NOT to use Task", concurrency, writing the prompt | Tool description (Task tool) | `engine/tools/AgentTool/prompt.ts:99-112,232-249` | `src/tools/AgentTool/references/` |
| `base-guidelines.md` — thoroughness, no-fabrication | Agent system-prompt (cross-agent) | `engine/tools/AgentTool/built-in/generalPurposeAgent.ts` SHARED_GUIDELINES | `src/tools/AgentTool/agents/_shared/references/` |
| `decision-examples.md` — 4 `<thinking>` patterns | Agent system-prompt (coordinator only) | (structural port — original for SF) | `src/tools/AgentTool/agents/coordinator/references/` |

The coordinator's "when to delegate" reasoning thus comes from two places:
1. **Task tool description** (auto-injected): `delegation-teaching.md`
2. **Coordinator's own system prompt** (via `references`): `decision-examples.md`

Agents with `Task` in their tools (coordinator, content-planner) both see (1) automatically. Only the coordinator sees (2).

### P2 — Zero routing code

The only code that "decides" which specialist to invoke is the LLM itself, guided by:
- Each AGENT.md's `description` field (= Claude Code's `whenToUse`)
- The coordinator's reference docs (above)
- The auto-injected team roster (`formatAgentLine` port)

We do not write `if productState === 'launching' then spawnGrowthStrategist`. The coordinator reads its prompts and decides.

**This is intentional and load-bearing**. Adding a new specialist = writing an `AGENT.md` + one line in the team provisioner (which members auto-attach for which product categories). No feature flags, no new routing.

### P3 — Domain tools over structured JSON output

Previously: agents emit JSON, we parse + validate + write to DB.
Now: agents call domain tools (`write_strategic_path`, `add_plan_item`); the tool does the DB write. Zod validates tool input.

This means:
- No more "emit exact JSON shape" prompt teaching
- No more sanitizer workarounds for `output_config.format` grammar limits
- Each DB write is an observable tool call in `team_messages` (audit trail)

### P4 — Clean cutover, no dual-track

Product isn't launched. We delete old paths in the same commits that introduce new ones. No feature-flag-gated rollout, no "old path + new path co-exist for 2 weeks".

**Exception**: the pre-existing `SHIPFLARE_TERMINAL_TOOL_AGENTS` flag (from WIP `submit_X` code) gets removed during Phase A Day 2 — no longer needed once `StructuredOutput` is the default path for agents with `outputSchema`.

### P5 — In-process spawn, BullMQ for top-level runs

A `team_run` is one BullMQ job. Within that job, all subagents (`growth-strategist`, `content-planner`, writers...) spawn **in-process** from the coordinator. This:
- Shares prompt cache aggressively (fork-style)
- Keeps trace simple (one job = one run = one trace_id)
- Avoids cross-worker IPC for every Task call

Horizontal scaling = more BullMQ workers running different `team_runs`, not per-subagent workers.

---

## 4. End-State Architecture

### 4.1 Request flow

```
┌─────────────────────────────────────────────────────────────────┐
│  Web UI                                                         │
│  /team page ← SSE /api/team/events                              │
│  /today page ← existing approval cards (unchanged)              │
│  /onboarding Stage 6 ← "Meet your team" (read-only, Phase F)    │
└─────────────────────────────────────────────────────────────────┘
                  ↓                          ↑
┌─────────────────────────────────────────────────────────────────┐
│  API routes                                                     │
│  POST /api/team/run       — trigger coordinator                 │
│  POST /api/team/message   — user sends message to a member      │
│  GET  /api/team/events    — SSE stream of team_messages         │
│  GET  /api/team/status    — snapshot of team_members + runs     │
└─────────────────────────────────────────────────────────────────┘
                  ↓
┌─────────────────────────────────────────────────────────────────┐
│  BullMQ queue: team-runs                                        │
│  Worker: src/workers/processors/team-run.ts                     │
│  Concurrency: 3 (tunable via env)                               │
└─────────────────────────────────────────────────────────────────┘
                  ↓
┌─────────────────────────────────────────────────────────────────┐
│  Team runtime (in-process within team-run worker)               │
│                                                                 │
│  runAgent(coordinator) with tools:                              │
│      ├─ Task                 (spawn subagent in-process)        │
│      ├─ SendMessage          (Redis pub/sub + team_messages)    │
│      ├─ query_team_status                                       │
│      ├─ query_plan_items                                        │
│      ├─ query_strategic_path                                    │
│      ├─ add_plan_item        (direct writes, not via specialist)│
│      └─ StructuredOutput     (terminal)                         │
│                                                                 │
│      Delegation flow (autonomous, per prompt):                  │
│                                                                 │
│      coordinator:  <thinking>User wants new plan. Phase         │
│                     transition detected. Spawn growth-strategist│
│                     first (strategy must precede tactical).     │
│                     </thinking>                                 │
│                                                                 │
│                     Task(growth-strategist, "design path...")   │
│                                                                 │
│                     [waits for tool_result]                     │
│                                                                 │
│                     <thinking>Path written, pathId=abc.          │
│                     Now spawn content-planner.</thinking>       │
│                                                                 │
│                     Task(content-planner, "plan week using      │
│                     path=abc")                                  │
│                                                                 │
│                     [waits for tool_result]                     │
│                                                                 │
│                     StructuredOutput({ status: 'completed',     │
│                       summary, teamActivitySummary })           │
└─────────────────────────────────────────────────────────────────┘
                  ↓
┌─────────────────────────────────────────────────────────────────┐
│  DB (PostgreSQL + Redis)                                        │
│  teams, team_members, team_runs, team_messages, team_tasks      │
│  strategic_paths, plan_items, voice_profiles, drafts (existing) │
│  Redis: rate limits, SSE pub/sub, SendMessage delivery          │
└─────────────────────────────────────────────────────────────────┘
```

### 4.2 Trigger sources

| Trigger | team_runs.trigger | Goal template | When |
|---|---|---|---|
| Onboarding | `onboarding` | `"Plan the launch strategy for {productName}. State: {state}. Channels: {channels}."` | Stage 6 of onboarding flow |
| Weekly cron | `weekly` | `"Plan this week. Current phase: {phase}. Carry over stalled items."` | Every Monday 09:00 UTC per user |
| Manual re-plan | `manual` | User-provided | `/team` page → "Re-plan" button |
| Phase transition | `phase_transition` | `"Phase changed from {old} to {new}. Review and update the strategic path."` | DB trigger when `products.state` changes |
| Reply-guy sweep (Phase E) | `reply_sweep` | `"Check for new high-signal threads on connected channels."` | Every 6h per user |

---

## 5. Port Manifest (Claude Code → ShipFlare)

### 5.0 Key insight — what we DON'T re-port

**`src/core/query-loop.ts` already ports `engine/query.ts`.** It's in production. That means:

- Subagent main loop: **already built** — a subagent is just another `runAgent()` call with a different AgentConfig
- Tool execution, retry, max_tokens escalation, cache breakpoints, JSON extraction: **already in query-loop.ts**
- Usage tracker, cost tracking: **already built**

**CC's `engine/tools/AgentTool/runAgent.ts` (973 lines) does NOT need a parallel file in ShipFlare.** Our `spawn.ts` is a ~40-line wrapper around the existing `runAgent()`.

This cuts the work Phase A would otherwise need by ~60%.

### 5.1 Port assessment — % direct-usable per CC file

This table updates and expands §5.1/5.2 combined. "% direct" = proportion of CC source that survives as-is after substituting domain names and stripping feature flags.

| CC source | Lines | % direct | Why we can/can't just `cp` | SF target | Est. |
|---|---|---|---|---|---|
| `engine/tools/AgentTool/prompt.ts` (the teaching + `formatAgentLine`) | 288 | **80%** | Nearly pure text generation. Strip `feature('KAIROS')` / `forkSubagent` / `coordinator mode` branches; substitute tool-name constants. No CC-runtime deps. | `src/tools/AgentTool/prompt.ts` + `src/tools/AgentTool/references/delegation-teaching.md` | 2h |
| `engine/tools/AgentTool/built-in/generalPurposeAgent.ts` `SHARED_GUIDELINES` | ~15 | **90%** | Plain markdown-like string. Paste + substitute 3 phrases. Path mirrors CC: lives under `Task/agents/_shared/` just like CC's `built-in/` lives under `AgentTool/`. | `src/tools/AgentTool/agents/_shared/references/base-guidelines.md` | 15min |
| `engine/tools/AgentTool/loadAgentsDir.ts` frontmatter parser | ~150 (of 580) | **60%** | YAML+markdown parser core is portable. Strip validators for `skills`, `hooks`, `mcpServers`, `permissionMode`, `isolation`, `initialPrompt`, `memory`, `omitClaudeMd`. Keep name/description/tools/model/maxTurns/color. | `src/tools/AgentTool/loader.ts` | 3h |
| `engine/tools/SyntheticOutputTool/SyntheticOutputTool.ts` | 163 | **40%** | Structural shape correct. Must replace: Ajv → Zod, `buildTool` → our `ToolDefinition`, `TelemetrySafeError` → plain Error, `lazySchema` → direct schema. Keep `WeakMap<schema, tool>` cache pattern. | `src/tools/StructuredOutputTool/StructuredOutputTool.ts` | 4h |
| `engine/tools/AgentTool/AgentTool.tsx` | 1397 | **15%** | Mostly ink/tmux UI (`renderToolUseMessage`, `renderGroupedAgentToolUse`), feature flags (KAIROS, COORDINATOR_MODE, multi-agent gates), worktree, remote CCR, permission prompts, MCP init, proactive module, teammate spawn. Extract the ~150-line `call()` skeleton only: parse input → resolve AgentDefinition → spawn → collect result. | `src/tools/AgentTool/AgentTool.ts` | 1d |
| `engine/utils/forkedAgent.ts` | 689 | **20%** | `CacheSafeParams` is the portable concept. Rest depends on `ToolUseContext`, `REPLHookContext`, `contentReplacementState`, `readFileState`, `nestedMemoryAttachmentTriggers` — none of which exist in SF. Port the idea, not the code. | `src/tools/AgentTool/spawn.ts` | 0.5d |
| `engine/tools/AgentTool/runAgent.ts` | 973 | **5%** | Deeply integrated with CC: MCP clients, skill loader, session hooks, sidechain recording, perfetto tracing, CLAUDE.md hierarchy, memory snapshots, permission denial tracking, background task lifecycle. **Do NOT port.** Our existing `src/core/query-loop.ts` `runAgent()` handles the subagent loop. Use it directly from `spawn.ts`. | (reuse existing `runAgent`) | 0 |
| `engine/utils/hooks/hookHelpers.ts` `registerStructuredOutputEnforcement` | ~30 relevant | **10%** | Depends on CC's hook system (`addFunctionHook`, `setAppState`, `sessionId`, `hasSuccessfulToolCall`). Instead of porting the hook system, **inline the Stop-check** into our `runAgent`: at `stop_reason === 'end_turn'`, scan message history for `StructuredOutput` tool_use; if absent and `outputSchema` is set, inject correction and loop. | `src/tools/StructuredOutputTool/enforcement.ts` (or inline in query-loop.ts) | 2h |
| `engine/tools/SendMessageTool/` | not inspected | **0%** | CC's SendMessage uses tmux splitpane / in-process message queues for interactive CLI. Our transport is Redis pub/sub to SSE subscribers. Complete rewrite. | `src/tools/SendMessageTool.ts` | 0.5d |

### 5.2 "Just copy" list — 3 port operations that are near-free

These are the high-leverage, low-risk ports. Do them first:

1. **CC line 99-112 + 232-249 + 115-154 of `prompt.ts`** → `src/tools/AgentTool/references/delegation-teaching.md`
   - Extract 3 text blocks
   - Find-replace: `FILE_READ_TOOL_NAME` → `query_plan_items`, `GLOB_TOOL_NAME` → (remove), `AGENT_TOOL_NAME` → `Task`, `BASH_TOOL_NAME` → (remove references)
   - Ship as `.md` file; `src/tools/AgentTool/prompt.ts` reads it and embeds in `buildTaskDescription()`

2. **CC `SHARED_GUIDELINES` constant in `generalPurposeAgent.ts`** → `src/tools/AgentTool/agents/_shared/references/base-guidelines.md`
   - Paste string contents
   - Substitute `"file searches"` → `"DB queries"`, `"codebase"` → `"plan items and team state"`, `"NEVER create files"` → `"NEVER call external APIs not in your tool list"`

3. **CC `parseAgent()` function in `loadAgentsDir.ts`** → `src/tools/AgentTool/loader.ts`
   - Copy the YAML+markdown split logic
   - Keep validation for: `name` (required), `description` (required), `tools[]`, `model`, `maxTurns`, `color`
   - Delete validators for all CLI-only fields

**Total "just copy" work**: ~4 hours. Gets us `delegation-teaching` + `base-guidelines` + `loader` all landing Day 1 of Phase A.

### 5.3 Structural port (same shape, new implementation)

These have the shape but not the deps:

| CC source | ShipFlare target | What survives | What's rewritten |
|---|---|---|---|
| `AgentTool.tsx` `call()` skeleton | `src/tools/AgentTool/AgentTool.ts` | `call()` structure: validate input → resolve AgentDefinition → spawn → collect | Permission flow, UI renderers, worktree, remote CCR, feature flags, teammate handling |
| `forkedAgent.ts` `CacheSafeParams` | `src/tools/AgentTool/spawn.ts` | Concept of sharing system+tools+messages across spawns for cache hits | CC-specific context types |
| `SyntheticOutputTool.ts` | `src/tools/StructuredOutputTool/StructuredOutputTool.ts` | Tool shape, `WeakMap` cache, "call once at end" prompt | Ajv validation → Zod, buildTool wrapper → our ToolDefinition |
| `SendMessageTool` | `src/tools/SendMessageTool.ts` | Tool interface: target + message | Transport (tmux → Redis pub/sub) |

### 5.4 Skip (don't port at all)

- Tmux / ink / splitpane UI
- Plan mode, slash commands, skills discovery
- File tools (Read/Edit/Glob/Bash/Grep) — we have domain tools
- `isolation: "worktree" | "remote"`
- `run_in_background` (we're always async via BullMQ)
- `mode` (permission mode) — all subagents run fully authorized
- CLAUDE.md hierarchy injection — we assemble system prompts from AGENT.md + references
- `agent_listing_delta` attachment optimization (we have ≤10 agents, inline is fine)
- CC's entire hook system (`addFunctionHook`, session hooks, stop hooks outside StructuredOutput enforcement)
- MCP integration
- Perfetto tracing
- Memory snapshots
- Sidechain recording (we write to `team_messages` instead)

### 5.5 Decision examples (ShipFlare-original, structural parallel)

`src/tools/AgentTool/agents/coordinator/references/decision-examples.md` — 4 `<thinking>` examples mirroring CC's 4:

| # | Pattern | CC example (parallel) | ShipFlare example |
|---|---|---|---|
| 1 | Direct (no Task) | "Check git status" → Bash directly | "How many plan_items next week?" → `query_plan_items` directly |
| 2 | Single Task | "Review this migration" → `Task(code-reviewer)` | "Pivot strategy post-launch" → `Task(growth-strategist)` |
| 3 | Parallel Task | "What's left to ship?" → multiple `Task()` | "Plan week + pre-draft posts" → `Task(content-planner)` + `Task(x-writer×N)` |
| 4 | Serial Task chain | (not explicit in CC examples) | "Draft based on analytics insight" → `Task(analytics-analyst)` → wait → `Task(x-writer)` |

Full text of these examples is in §8.4.

### 5.6 Total effort re-estimate

From the % direct assessment:

| Work category | Est. time |
|---|---|
| Pure `.md` port (delegation-teaching, base-guidelines) | 2.5h |
| Loader port (strip CC-only fields) | 3h |
| StructuredOutput + enforcement | 6h |
| Task.ts skeleton extraction | 1d |
| spawn.ts thin wrapper (no rebuild of runAgent) | 0.5d |
| SendMessage (full rewrite, Redis) | 0.5d |
| DB migration + API routes + BullMQ worker | 1d |
| Integration test + fixtures | 0.5d |
| **Phase A total** | **~4 days** (unchanged from original estimate — but lower risk since the high-complexity bits are reused, not ported) |

---

## 6. Data Model

### 6.1 New tables

```sql
-- drizzle/migrations/0034_team_platform.sql

-- A user's AI team (one per product typically, but table allows N)
CREATE TABLE teams (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  product_id uuid REFERENCES products(id) ON DELETE CASCADE,
  name text NOT NULL DEFAULT 'My Marketing Team',
  config jsonb NOT NULL DEFAULT '{}'::jsonb,
    -- { preset: 'default' | 'dev_tool' | 'consumer' | ...,
    --   weeklyBudgetUsd?: number }
    -- NOTE: preset is product-decided based on product.category at provisioning time,
    -- not user-configurable. config exists for internal admin tuning only.
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_teams_user_product ON teams(user_id, product_id);

-- Instances of AgentDefinition in a team. Loader reads src/tools/AgentTool/agents/<agent_type>/AGENT.md
-- to get the system prompt + tools. team_members rows are created by the team
-- provisioner (src/lib/team-provisioner.ts) on account/product creation — NOT
-- via any user-facing UI.
CREATE TABLE team_members (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  team_id uuid NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  agent_type text NOT NULL,
    -- must match src/tools/AgentTool/agents/<agent_type>/AGENT.md
  display_name text NOT NULL,
    -- product-decided presentation name (e.g. "Alex" for growth-strategist).
    -- We set this in team-provisioner for polish; user cannot change it.
  status text NOT NULL DEFAULT 'idle',
    -- 'idle' | 'active' | 'waiting_approval' | 'error'
  last_active_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (team_id, agent_type)
);

-- NOTE: removed fields from earlier draft:
--   persona_override  — user customization dropped (D6)
--   tool_allowlist    — no per-instance tool override; AGENT.md is source of truth

CREATE INDEX idx_team_members_team ON team_members(team_id);

-- A single coordinator main-loop execution
CREATE TABLE team_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  team_id uuid NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  trigger text NOT NULL,
    -- 'onboarding' | 'weekly' | 'manual' | 'phase_transition' | 'reply_sweep'
  goal text NOT NULL,
    -- user-facing goal ("Plan next week")
  root_agent_id uuid NOT NULL REFERENCES team_members(id),
    -- usually the coordinator
  status text NOT NULL DEFAULT 'running',
    -- 'running' | 'completed' | 'failed' | 'cancelled'
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  total_cost_usd numeric(10,4),
  total_turns int DEFAULT 0,
  trace_id text,
  error_message text
);

CREATE INDEX idx_team_runs_team_status ON team_runs(team_id, status);
CREATE INDEX idx_team_runs_trace ON team_runs(trace_id);

-- Every message in the team: user↔member, member↔member, tool calls, tool results, completion
CREATE TABLE team_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id uuid REFERENCES team_runs(id) ON DELETE CASCADE,
  team_id uuid NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  from_member_id uuid REFERENCES team_members(id),
    -- NULL = user
  to_member_id uuid REFERENCES team_members(id),
    -- NULL = user, or everyone for broadcasts
  type text NOT NULL,
    -- 'user_prompt' | 'agent_text' | 'tool_call' | 'tool_result'
    -- | 'completion' | 'error' | 'thinking'
  content text,
  metadata jsonb,
    -- tool_use_id, tool_name, tool_input, tool_output, cost, tokens, etc.
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_team_messages_run ON team_messages(run_id, created_at);
CREATE INDEX idx_team_messages_team_recent ON team_messages(team_id, created_at DESC);

-- Tasks spawned via Task tool (1 row per Task call)
CREATE TABLE team_tasks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id uuid NOT NULL REFERENCES team_runs(id) ON DELETE CASCADE,
  parent_task_id uuid REFERENCES team_tasks(id),
    -- for nested Task spawns (e.g., content-planner spawns x-writer)
  member_id uuid NOT NULL REFERENCES team_members(id),
    -- the agent executing this task
  description text NOT NULL,
    -- Task tool's "description" param (3-5 words)
  prompt text NOT NULL,
    -- Task tool's "prompt" param
  input jsonb NOT NULL,
    -- all Task params including subagent_type, name
  output jsonb,
    -- StructuredOutput result, or final text
  status text NOT NULL DEFAULT 'pending',
    -- 'pending' | 'running' | 'completed' | 'failed'
  cost_usd numeric(10,4),
  turns int DEFAULT 0,
  started_at timestamptz,
  completed_at timestamptz,
  error_message text
);

CREATE INDEX idx_team_tasks_run ON team_tasks(run_id, started_at);
CREATE INDEX idx_team_tasks_member ON team_tasks(member_id);
```

### 6.2 Tables that stay (unchanged)

- `users`, `products`, `channels` — auth / product / OAuth
- `strategic_paths` — written by `write_strategic_path` tool
- `plan_items` — written by `add_plan_item` tool
- `voice_profiles` — written by future `save_voice_profile` tool
- `drafts` — unchanged
- `posts`, `threads`, `replies` — platform data

### 6.3 Tables deleted

None — this refactor adds tables, doesn't modify existing. Old skill-runner state was Redis-only; will be cleared on deploy.

---

## 7. The 4-Layer Decision Stack

**This is the load-bearing system.** Port it wrong and the coordinator delegates badly; port it right and the system "just works".

### Layer 1 — Task tool description

Injected into every AGENT.md that has `Task` in its tools. Built by `src/tools/AgentTool/prompt.ts` `buildTaskDescription()`, which reads `src/tools/AgentTool/references/delegation-teaching.md` at startup:

```ts
// src/tools/AgentTool/prompt.ts
export function buildTaskDescription(
  availableAgents: AgentDefinition[],
): string {
  return `${BASE_DESCRIPTION}

Available specialists and the tools they have access to:
${availableAgents.map(formatAgentLine).join('\n')}

${USAGE_NOTES}

${WHEN_NOT_TO_USE}

${WRITING_THE_PROMPT}
`;
}
```

Where:
- `BASE_DESCRIPTION` = port of CC line 202-205 of `prompt.ts`
- `formatAgentLine` = port, `- ${agent.agentType}: ${agent.description} (Tools: ${toolList})`
- `USAGE_NOTES` = port of CC line 255-274
- `WHEN_NOT_TO_USE` = port of CC line 232-240, domain-substituted
- `WRITING_THE_PROMPT` = port of CC line 99-112

All injected as tool description visible to coordinator.

### Layer 2 — AgentDefinition `description` field

Each `AGENT.md` has a frontmatter `description`. Loader parses it. `formatAgentLine` renders it in Layer 1. Strong verbs are critical:

- `USE` — standard delegate trigger
- `USE PROACTIVELY` — coordinator should spawn even without explicit user ask
- `MUST BE USED` — coordinator must not handle in-place; always delegate
- `DO NOT USE for X` — explicit negative boundary

### Layer 3 — Decision examples (`decision-examples.md`)

Loaded via `shared-references` into coordinator's system prompt. Contains 4 `<thinking>` examples showing the reasoning pattern. **LLM imitates this pattern** — this is the most load-bearing piece. See §8.4 for full text.

### Layer 4 — Coordinator's direct-handling tools

The coordinator has `query_*` + `add_plan_item` + `SendMessage` in its own tool list. These are for "handle directly, don't delegate" cases. The presence of these tools alongside Task tells the LLM: "you have options; don't always Task".

### Decision tree (LLM's implicit reasoning)

```
Goal received
    │
    ├─ Can I answer this from query_* tools in one shot?
    │     ├─ YES → use query_* directly
    │     └─ NO ↓
    │
    ├─ Is this a single DB write with clear params (add_plan_item, write_strategic_path bypass)?
    │     ├─ YES → direct tool call
    │     └─ NO ↓
    │
    ├─ Does this match a specialist's `description` / `whenToUse`?
    │     ├─ NO match → clarify with user OR decline
    │     └─ MATCH ↓
    │
    ├─ Can subtasks run in parallel (independent)?
    │     ├─ YES → emit multiple Task blocks in ONE response
    │     └─ NO → emit one Task, wait for result, then next Task
    │
    └─ All specialists complete → call StructuredOutput
```

**Important**: this tree is not code. It emerges from the 4-layer prompt stack. We test it by observing coordinator behavior in Phase B+C.

---

## 8. Initial Agent Roster

### 8.1 `src/tools/AgentTool/agents/coordinator/AGENT.md`

```yaml
---
name: coordinator
description: The founder's AI chief of staff. Receives goals from the founder,
  decomposes them, delegates to specialists via Task, handles simple DB operations
  directly, and composes specialist outputs into a final summary.
model: claude-sonnet-4-6
maxTurns: 25
tools:
  - Task
  - SendMessage
  - query_team_status
  - query_plan_items
  - query_strategic_path
  - add_plan_item
  - StructuredOutput
shared-references:
  - base-guidelines
  - delegation-teaching
  - decision-examples
---

# Coordinator — {productName}'s AI Marketing Team Chief of Staff

You are the Chief of Staff for {productName}'s AI marketing team, working for
{founderName}. Your job: receive goals, decompose, delegate to specialists,
compose outputs into actionable DB state.

## Your team

{TEAM_ROSTER}
  — auto-injected at runtime from team_members + AgentDefinition,
  using formatAgentLine() from src/tools/Task.ts

## Context you start with

- Product: {productName} — {productDescription}
- State: {productState} ({mvp|launching|launched})
- Phase: {currentPhase}
- Channels connected: {channels}
- Active strategic path: {pathId | "none yet"}
- Recent milestones: use query_recent_milestones if needed (via growth-strategist)
- Plan items this week: {itemCount} ({statusBreakdown})

## How to delegate

{See references/delegation-teaching.md}

## Decision examples

{See references/decision-examples.md}

## When to handle directly

Use these tools without Task for:
- **query_team_status** — "who is working on what", "what did Maya finish today"
- **query_plan_items** — "how many items this week", "show me the approved ones"
- **query_strategic_path** — "what's our current thesis", "what pillars did we pick"
- **add_plan_item** — founder asks to add ONE specific item with clear params
  (e.g. "schedule a tweet for tomorrow about launch")
- **SendMessage** — steering an already-running member mid-task

## Finishing

Always call StructuredOutput with:

```ts
{
  status: 'completed' | 'partial' | 'failed',
  summary: string,              // one paragraph, founder-facing
  teamActivitySummary: Array<{
    memberType: string,
    taskCount: number,
    outputSummary: string
  }>,
  itemsProduced: {
    pathsWritten: number,
    planItemsAdded: number,
    draftsProduced: number,
    messagesExchanged: number,
  },
  errors: Array<{ member: string, error: string }>
}
```
```

### 8.2 `src/tools/AgentTool/agents/growth-strategist/AGENT.md`

```yaml
---
name: growth-strategist
description: Designs the 30-day strategic narrative arc for a product — thesis,
  milestones, weekly themes, content pillars, channel mix, phase goals. USE when
  the user requests a new plan, phase changes (e.g. mvp → launching → launched),
  or when recent milestones suggest the thesis needs rewriting. DO NOT USE for
  single-week tactical scheduling — content-planner handles that. DO NOT USE for
  drafting individual posts — writers handle that.
model: claude-sonnet-4-6
maxTurns: 10
tools:
  - write_strategic_path
  - query_recent_milestones
  - query_metrics
  - query_strategic_path
  - SendMessage
  - StructuredOutput
shared-references:
  - base-guidelines
references:
  - strategic-path-playbook    # ported from current strategic-planner.md steps 1-6
  - 7-angles                   # shared with content-planner
  - channel-cadence            # shared with content-planner
---

# Growth Strategist for {productName}

You are the Head of Growth for {productName}. Your job: produce ONE durable
narrative arc — the thesis and frame the tactical team executes against for
the next 30 days.

## Your input (passed by coordinator as prompt)

- Product context (name, description, valueProp, category, targetAudience)
- State: mvp | launching | launched
- Current phase
- Launch date + launched_at dates
- Connected channels
- Voice profile (markdown, nullable)
- Recent milestones (last 14 days of commits/PRs/releases)

## Your workflow

{See references/strategic-path-playbook.md — the 6 ordered steps from current
strategic-planner.md, verbatim except "emit JSON" instructions removed.}

## Delivering your plan

1. Call `write_strategic_path` with the full path.
2. If validation fails → tool_result is_error=true → correct and call again.
3. When the path is persisted → call StructuredOutput:

```ts
{
  status: 'completed' | 'failed',
  pathId: string,
  summary: string,  // one paragraph for the coordinator
  notes: string     // what you want content-planner to know
}
```
```

### 8.3 `src/tools/AgentTool/agents/content-planner/AGENT.md`

```yaml
---
name: content-planner
description: Produces concrete plan_items for one week — content posts, emails,
  setup tasks, interviews. Reads the active strategic path plus this week's
  signals (stalled items, last-week completions, recent milestones) and
  allocates items across connected channels with scheduledAt timestamps.
  USE on Monday mornings, when the founder requests re-planning this week, or
  after a phase transition. MUST BE USED whenever plan_items for a new week
  are needed. DO NOT USE for rewriting the strategic narrative — growth-strategist
  handles that. Can spawn writers via Task to pre-draft bodies (optional).
model: claude-haiku-4-5-20251001
maxTurns: 20
tools:
  - add_plan_item
  - query_recent_milestones
  - query_stalled_items
  - query_last_week_completions
  - query_strategic_path
  - Task                       # can spawn x-writer / reddit-writer
  - SendMessage
  - StructuredOutput
shared-references:
  - base-guidelines
  - delegation-teaching        # if content-planner spawns writers
references:
  - tactical-playbook          # ported from current tactical-planner.md steps 1-5
  - phase-task-templates       # existing reference, kept verbatim
  - 7-angles
  - channel-cadence
---

# Content Planner for {productName}

You are the Head of Content for {productName}. Your job: for the given week,
read the strategic path, allocate content + setup_tasks + interviews +
emails across the week, and persist them as plan_items.

## Your workflow

{See references/tactical-playbook.md — 5 ordered steps from current
tactical-planner.md, verbatim except "emit JSON" removed and "add_plan_item
tool" substituted for "items[]" array}

## Optional: pre-draft by spawning writers

After adding all plan_items, you CAN spawn writers in parallel to draft bodies:

```
Task(x-writer, { planItemId: "...", context: { theme, angle, pillar, voice } }) × N
Task(reddit-writer, { planItemId: "..." }) × M
```

Emit them in ONE response. Writers return draft_body; plan_items update
automatically.

If this turns out too slow or costly, skip fan-out — draft generation can fall
back to the plan-execute worker after items are approved.

## Delivering

When all items for the week are added (and optionally drafts produced), call
StructuredOutput:

```ts
{
  status: 'completed' | 'partial',
  weekStart: string,              // ISO
  itemsAdded: number,
  itemsByChannel: { x?: number, reddit?: number, email?: number, none?: number },
  stalledCarriedOver: number,
  notes: string                   // for the coordinator
}
```
```

### 8.4 `src/tools/AgentTool/agents/coordinator/references/decision-examples.md` (new, ShipFlare-original — coordinator-only)

```md
# Delegation decision examples

Four concrete examples showing the coordinator's reasoning pattern. Each shows
a goal, a `<thinking>` block with the decision rationale, and the resulting
action. Imitate this reasoning pattern on every goal.

## Example 1 — Direct handling (no Task)

user: "How many plan_items are scheduled for next week?"

assistant: <thinking>
This is a simple DB read — one query tool call gives the answer. No specialist
judgment needed. Use query_plan_items directly.
</thinking>

query_plan_items({ weekOffset: 1, status: ["planned", "drafted", "approved"] })

[tool_result: 12]

There are 12 plan_items scheduled for next week (3 drafted, 7 approved, 2 in
planning).

## Example 2 — Single specialist delegation

user: "I launched yesterday. Can we pivot the strategy to post-launch?"

assistant: <thinking>
Phase transition from `launching` to `launched` — the strategic narrative
needs to be re-written from pre-launch (waitlist focus) to post-launch
(compound/growth focus). That matches growth-strategist's description:
"USE when phase changes." One specialist, serial execution.
</thinking>

Task({
  subagent_type: "growth-strategist",
  description: "Post-launch strategic rewrite",
  prompt: `Product just launched (state transitioned from launching → launched
yesterday). Active path pathId=abc123 targets pre-launch waitlist growth.
Rewrite the path for a 30-day compound phase, focusing on retention loops,
case studies, and compound content. Preserve voice profile.`
})

[waits for tool_result → StructuredOutput with new pathId]

The growth-strategist has rewritten your strategy for post-launch compound
growth. Key shifts: thesis moved from "join the waitlist" to "see how X
founders use ShipFlare in week 1". New pillars: case-studies, retention-math,
community-voices. Want me to have content-planner schedule the first week?

## Example 3 — Parallel delegation

user: "Set up next week and pre-draft the X posts"

assistant: <thinking>
Two independent subtasks:
1. Plan next week — content-planner
2. Draft X posts — x-writer

These can start in parallel. But wait: x-writer needs plan_item context (theme,
angle, pillar), which doesn't exist until content-planner runs. So actually:
serial, not parallel.

UNLESS I tell x-writer to draft "backlog" posts using the current pillars
without waiting for specific plan_items. That's a valid pattern — it creates
a backlog content-planner can slot into this week's items after approval.

Decision: parallel with independent scopes.
</thinking>

Task({
  subagent_type: "content-planner",
  description: "Plan next week",
  prompt: `Generate plan_items for the week starting Monday {nextMondayISO}.
Use active path pathId={pathId}. Respect connected channels: {channels}.`
})
Task({
  subagent_type: "x-writer",
  description: "Pre-draft X backlog",
  prompt: `Draft 5 X posts on the pillars from path pathId={pathId}, using a
mix of angles (data, story, contrarian). Write them as stand-alone — not
tied to specific plan_items. The founder will review and content-planner
will slot them in after approval.`
})

## Example 4 — Serial chain (one Task depends on another)

user: "Write a draft based on whatever angle is working best this month"

assistant: <thinking>
I don't know which angle is working until I ask — analytics-analyst needs to
surface that from metrics. Then x-writer drafts using that angle. Strictly
serial: the writer's prompt depends on the analyst's output.
</thinking>

Task({
  subagent_type: "analytics-analyst",
  description: "Identify top angle",
  prompt: `From the last 4 weeks of post metrics, return the angle (from the
7: claim, story, contrarian, howto, data, case, synthesis) with the highest
engagement per impression. Return { angle, evidence }.`
})

[waits for tool_result]

<thinking>
Analytics returned "contrarian" with 2.3x baseline engagement. Now I can brief
the writer with that specific angle.
</thinking>

Task({
  subagent_type: "x-writer",
  description: "Draft contrarian post",
  prompt: `Draft one X post using the contrarian angle. Last 4 weeks of
winners: {evidence from analytics}. Aim for the same shape: an anti-conventional
wisdom claim backed by a concrete observation from {productName}.`
})
```

### 8.5 `src/tools/AgentTool/references/delegation-teaching.md` (ported from CC, tool-description scope)

```md
# How to delegate via Task (ported from Claude Code)

## 1. When NOT to delegate

Before calling Task, check if a direct tool answers the question:

- If you want to read a specific plan_item by ID, use `query_plan_items` with
  `{ id }` directly.
- If you're checking team status ("who's working on what"), use
  `query_team_status` directly.
- If the founder asks to add or modify ONE specific plan_item with clear
  parameters, use `add_plan_item` directly.
- If the goal is a factual question answerable from 1-2 tool calls, handle
  it directly.

Other tasks that don't match any specialist's description — clarify with
the founder or decline.

## 2. Launching in parallel

Launch multiple specialists concurrently whenever possible, to maximize
performance; to do that, use a single response with multiple Task content
blocks.

If the goal decomposes into independent subtasks (subtask B doesn't need
subtask A's output), emit both Task calls in ONE response. The engine executes
them in parallel.

If the founder specifies "in parallel" or "at the same time", you MUST send
a single response with multiple Task tool-use content blocks.

ONLY chain Task calls (one per response, waiting for result) when the second
call's prompt depends on the first's output.

## 3. Writing the Task prompt

Brief the specialist like a smart colleague who just walked into the room —
they don't have your conversation context, only the prompt you write.

- Explain what you're trying to accomplish and why.
- Pass relevant state explicitly: pathId, active plan, phase, recent dates.
- If you need a short response, say so ("report in under 200 words").
- Be specific about scope: what's in, what's out, what another specialist is
  handling.
- Don't re-explain general product context — that's in the specialist's
  AGENT.md. Only pass the dynamic state for this task.

Terse command-style prompts produce shallow, generic work. Write like a
director briefing a department head.

**Never delegate understanding.** Don't write "based on your analysis, do X"
or "figure out what's best and do it". Those phrases push synthesis onto
the specialist instead of doing it yourself. Write prompts that prove you
understood: include the specific inputs, the exact decision you want made,
the format you need back.
```

### 8.6 `src/tools/AgentTool/agents/_shared/references/base-guidelines.md` (ported from CC)

```md
# Base guidelines (ported from Claude Code's generalPurposeAgent SHARED_GUIDELINES)

## Your strengths

- Searching across plan_items, strategic_paths, metrics, and team state
- Analyzing multiple signals to inform next actions
- Investigating complex questions that require exploring many DB records
- Performing multi-step research and planning tasks

## Guidelines

- For DB queries: query broadly when you don't know where something lives.
  Use specific filters when you know the IDs.
- For analysis: start broad, narrow down. Use multiple query strategies if
  the first doesn't yield results.
- Be thorough: consider multiple signals (milestones, metrics, stalled items,
  recent completions) before committing to a plan.
- NEVER call external APIs not in your tool list.
- NEVER fabricate data — if a tool returns empty, acknowledge it.
- When producing output, structure it for the caller (coordinator, or
  founder via final StructuredOutput).
```

---

## 9. Domain Tool Catalog

Each tool lives in `src/tools/<name>.ts`. Standard shape (from `ToolDefinition`):

```ts
export const addPlanItemTool: ToolDefinition = {
  name: 'add_plan_item',
  description: '...',
  inputSchema: z.object({ ... }),
  execute: async (input, ctx) => { ... },
  isConcurrencySafe: true,  // multiple add_plan_item calls in parallel are safe
  isReadOnly: false,
  maxResultSizeChars: 10_000,
};
```

### 9.1 Write tools

| Tool | Allowed agents | Input schema | Side effect |
|---|---|---|---|
| `write_strategic_path` | growth-strategist | `StrategicPathSchema` (current `strategicPathSchema` — moves from `src/agents/schemas.ts` → `src/tools/schemas.ts`) | INSERT OR UPDATE `strategic_paths` |
| `add_plan_item` | coordinator, content-planner | kind, channel, scheduledAt, skillName, params, title, description, phase, userAction | INSERT `plan_items` |
| `update_plan_item` | coordinator, content-planner | id, patch (any of: state, scheduledAt, title, description) | UPDATE `plan_items` |
| `draft_post` | x-writer, reddit-writer | planItemId, context | UPDATE `plan_items.draft_body` via `sideQuery` |
| `draft_reply` | community-manager | threadId, context | INSERT `drafts` |
| `save_voice_profile` | (future voice-extractor) | profile (markdown string), extractedFrom | UPSERT `voice_profiles` |

### 9.2 Read tools

| Tool | Allowed agents | Input | Returns |
|---|---|---|---|
| `query_recent_milestones` | growth-strategist, content-planner | `{ sinceDays?: number }` (default 14) | `Array<{ title, summary, source, atISO }>` |
| `query_stalled_items` | content-planner | — | `Array<{ id, title, scheduledAt, stalledReason }>` |
| `query_last_week_completions` | content-planner | — | `Array<{ title, channel, angle, engagementScore? }>` |
| `query_strategic_path` | coordinator, content-planner | — (reads active path for current product) | `StrategicPath \| null` |
| `query_metrics` | growth-strategist, (future) analytics-analyst | `{ range: 'last_week' \| 'last_month' \| 'all' }` | aggregated metrics |
| `query_team_status` | coordinator | — | `Array<{ memberId, agent_type, display_name, status, currentTask? }>` |
| `query_plan_items` | coordinator | `{ weekOffset?, status?, id?, limit? }` | `Array<PlanItem>` |

### 9.3 Team-runtime tools

| Tool | Allowed agents | Input | Side effect |
|---|---|---|---|
| `Task` | coordinator, content-planner | `{ subagent_type, prompt, description, name? }` | Spawns subagent in-process, returns `{ result, cost, duration }` |
| `SendMessage` | all | `{ to: memberId \| name, message, run_id? }` | Redis publish + INSERT `team_messages` |
| `StructuredOutput` | all | runtime-injected schema | terminal; returns validated input |

### 9.4 Tool allowlist matrix

| | coordinator | growth-strategist | content-planner | x-writer | reddit-writer |
|---|---|---|---|---|---|
| Task | ✓ | | ✓ | | |
| SendMessage | ✓ | ✓ | ✓ | ✓ | ✓ |
| StructuredOutput | ✓ | ✓ | ✓ | ✓ | ✓ |
| write_strategic_path | | ✓ | | | |
| add_plan_item | ✓ | | ✓ | | |
| update_plan_item | ✓ | | ✓ | | |
| draft_post | | | | ✓ | ✓ |
| query_recent_milestones | | ✓ | ✓ | | |
| query_stalled_items | | | ✓ | | |
| query_last_week_completions | | | ✓ | | |
| query_strategic_path | ✓ | ✓ | ✓ | | |
| query_metrics | | ✓ | | | |
| query_team_status | ✓ | | | | |
| query_plan_items | ✓ | | | | |

---

## 10. File Tree (Before → After)

### 10.1 Before

```
src/
├─ agents/
│  ├─ strategic-planner.md
│  ├─ tactical-planner.md
│  └─ schemas.ts
├─ skills/
│  ├─ _catalog.ts
│  ├─ strategic-planner/
│  │  └─ SKILL.md
│  ├─ tactical-planner/
│  │  ├─ SKILL.md
│  │  └─ references/...
│  ├─ draft-single-post/
│  ├─ draft-single-reply/
│  ├─ voice-extractor/
│  ├─ identify-top-supporters/
│  ├─ compile-retrospective/
│  ├─ analytics-summarize/
│  ├─ generate-interview-questions/
│  ├─ draft-hunter-outreach/
│  ├─ draft-waitlist-page/
│  ├─ draft-launch-day-comment/
│  ├─ generate-launch-asset-brief/
│  └─ build-launch-runsheet/
├─ core/
│  ├─ query-loop.ts (595 lines, incl. sanitizer)
│  ├─ api-client.ts
│  ├─ skill-runner.ts
│  ├─ skill-loader.ts
│  ├─ swarm/
│  ├─ coordinator.ts
│  └─ tool-system.ts
├─ workers/processors/
│  ├─ tactical-generate.ts
│  └─ plan-execute.ts
└─ app/api/
   ├─ onboarding/plan/route.ts (SSE, calls runSkill strategic-planner)
   ├─ onboarding/commit/route.ts (enqueues tactical-generate)
   └─ plan/replan/route.ts
```

### 10.2 After (CC-aligned directory organization)

**Key org principle** — **mirror Claude Code's `engine/tools/AgentTool/` structure exactly.** All agent-related files (AgentDefinitions + loader + spawn + Task tool + teaching prompts + cross-agent shared references) live under `src/tools/AgentTool/`, because they only exist in service of the Task tool's ability to spawn subagents.

This is what CC calls `engine/tools/AgentTool/built-in/` — we mirror to `src/tools/AgentTool/agents/`. We don't have a top-level `src/agents/` at all.

**Scope within the Task tool**:
- `src/tools/AgentTool/references/` — tool-description scope (how to USE Task)
- `src/tools/AgentTool/agents/` — AgentDefinition files (what Task can SPAWN)
- `src/tools/AgentTool/agents/_shared/references/` — agent-system-prompt scope shared across ≥2 agents
- `src/tools/AgentTool/agents/<agent>/references/` — agent-system-prompt scope for that agent only

```
src/
├─ tools/
│  ├─ Task/                              ← everything subagent-related (mirrors CC AgentTool/)
│  │  ├─ Task.ts                         ← port of CC AgentTool.tsx call() skeleton
│  │  ├─ loader.ts                       ← port of CC loadAgentsDir.ts
│  │  ├─ prompt.ts                       ← buildTaskDescription() — reads references/ below
│  │  ├─ spawn.ts                        ← ~40-line wrapper around core/query-loop.ts runAgent()
│  │  ├─ references/                     ← TOOL DESCRIPTION scope
│  │  │  └─ delegation-teaching.md       ← port of CC prompt.ts
│  │  │                                    (auto-injected into Task's description —
│  │  │                                     every agent with Task in tools sees it)
│  │  └─ agents/                         ← AGENT DEFINITIONS (mirrors CC AgentTool/built-in/)
│  │     ├─ _shared/
│  │     │  └─ references/               ← cross-agent shared system-prompt content
│  │     │     ├─ base-guidelines.md     ← port of CC SHARED_GUIDELINES
│  │     │     ├─ 7-angles.md            ← existing, kept
│  │     │     ├─ phase-task-templates.md  ← existing, kept
│  │     │     └─ channel-cadence.md     ← new, split from old strategic-planner
│  │     ├─ coordinator/
│  │     │  ├─ AGENT.md                  ← shared-references: [base-guidelines]
│  │     │  │                              references: [decision-examples, when-to-handle-directly]
│  │     │  └─ references/
│  │     │     ├─ decision-examples.md   ← 4 SF-domain <thinking> examples (coordinator-only)
│  │     │     └─ when-to-handle-directly.md
│  │     ├─ growth-strategist/
│  │     │  ├─ AGENT.md
│  │     │  └─ references/
│  │     │     └─ strategic-path-playbook.md   ← port of current strategic-planner.md steps 1-6
│  │     ├─ content-planner/
│  │     │  ├─ AGENT.md
│  │     │  └─ references/
│  │     │     └─ tactical-playbook.md   ← port of current tactical-planner.md steps 1-5
│  │     ├─ x-writer/                    ← Phase E
│  │     │  ├─ AGENT.md
│  │     │  └─ references/
│  │     │     └─ x-content-guide.md     ← existing, kept
│  │     ├─ reddit-writer/               ← Phase E
│  │     └─ community-manager/           ← Phase E
│  │
│  │                                     -- NOTE: src/agents/ (top-level) does NOT exist.
│  │                                     -- All agents live under src/tools/AgentTool/agents/.
│  │                                     -- This mirrors CC exactly. Future ports of CC code
│  │                                     -- (e.g. new built-in agents, agent memory snapshots)
│  │                                     -- can cp engine/tools/AgentTool/built-in/<x>
│  │                                     -- → src/tools/AgentTool/agents/<x>.
│  ├─ StructuredOutputTool/              ← infra: singular dir, multi-file
│  │  ├─ StructuredOutputTool.ts         ← port of CC SyntheticOutputTool
│  │  │                                    tool identifier: 'StructuredOutput'
│  │  └─ enforcement.ts                  ← Stop-check inlined (may merge into query-loop.ts)
│  │
│  ├─ SendMessageTool.ts                 ← infra: single file (Redis pub/sub)
│  │                                        tool identifier: 'SendMessage'
│  │
│  │  -- Entity-scoped tool groups below. Each corresponds to a DB entity (table).
│  │  -- Opening one folder shows all operations for that entity — matches the
│  │  -- mental model of working on one domain concept at a time.
│  │
│  ├─ StrategicPathTools/                ← entity: strategic_paths table
│  │  ├─ Query.ts                        → query_strategic_path
│  │  ├─ Write.ts                        → write_strategic_path (singleton overwrite)
│  │  └─ index.ts
│  │
│  ├─ PlanItemTools/                     ← entity: plan_items table
│  │  ├─ Query.ts                        → query_plan_items (generic filter)
│  │  ├─ QueryStalled.ts                 → query_stalled_items
│  │  ├─ QueryCompletions.ts             → query_last_week_completions
│  │  ├─ Add.ts                          → add_plan_item
│  │  ├─ Update.ts                       → update_plan_item
│  │  └─ index.ts
│  │
│  ├─ MilestoneTools/                    ← entity: shipping signals (commits/PRs/releases)
│  │  ├─ QueryRecent.ts                  → query_recent_milestones
│  │  └─ index.ts
│  │
│  ├─ MetricsTools/                      ← entity: metrics tables (Phase E expands)
│  │  ├─ Query.ts                        → query_metrics
│  │  └─ index.ts
│  │
│  ├─ TeamTools/                         ← entity: team_members + team_runs state
│  │  ├─ QueryStatus.ts                  → query_team_status
│  │  └─ index.ts
│  │
│  ├─ DraftingTools/                     ← Phase E: grouped by operation (NOT entity)
│  │  │                                    LLM-driven content generation —
│  │  │                                    consumes plan_items, produces draft_body
│  │  ├─ Post.ts                         → draft_post
│  │  ├─ Reply.ts                        → draft_reply
│  │  ├─ FindThreads.ts                  → find_threads (external platform query)
│  │  └─ index.ts
│  │
│  ├─ schemas.ts                         ← shared Zod types (strategicPathSchema, etc.)
│  │                                        moved from src/agents/schemas.ts in Phase B Day 1
│  └─ registry.ts                        ← registers all tools via flat snake_case identifiers
├─ core/
│  ├─ query-loop.ts                      ← trimmed: no sanitizer, no output_config path,
│  │                                       + inlined StructuredOutput Stop-check in runAgent
│  ├─ api-client.ts                      ← trimmed: no outputSchema param
│  ├─ tool-system.ts                     ← unchanged
│  └─ tool-executor.ts                   ← unchanged
│                                          (NOTE: spawn.ts moved to src/tools/AgentTool/;
│                                           structured-output-enforcement merged into query-loop.ts)
├─ workers/processors/
│  ├─ team-run.ts                        ← NEW: coordinator main loop in BullMQ
│  └─ plan-execute.ts                    ← simplified: routes draft jobs to x-writer/reddit-writer Task
├─ lib/
│  └─ team-provisioner.ts                ← NEW: auto-creates teams + team_members
│                                           rows based on product.category. Called
│                                           on account/product creation. No user-facing
│                                           customization — product-decided composition.
└─ app/
   ├─ api/
   │  ├─ team/
   │  │  ├─ run/route.ts                 ← NEW
   │  │  ├─ message/route.ts             ← NEW
   │  │  ├─ events/route.ts              ← NEW (SSE)
   │  │  └─ status/route.ts              ← NEW (read-only snapshot)
   │  └─ onboarding/plan/route.ts        ← simplified: triggers team run
   └─ (app)/team/
      ├─ page.tsx                        ← NEW (read-only team grid)
      ├─ [memberId]/page.tsx             ← NEW (read-only activity log + send message)
      └─ _components/
         ├─ member-card.tsx              ← read-only display
         ├─ activity-log.tsx
         └─ send-message-form.tsx       ← steers existing member, not customization

# NOT in scope:
# src/app/(app)/settings/team/            ← NO team management UI
```

---

## 11. Phase Breakdown

Clean cutover — each phase deletes old code in the same commits as new code lands.

### Phase 0 — (removed, merged into Phase A Day 2)

Originally a separate 1-day "rename `submit_X` → `StructuredOutput`" phase. Now absorbed: the full port of `SyntheticOutputTool.ts` + inline Stop-check + retry counter happens in Phase A Day 2, which simultaneously renames the WIP `submit_<agent>` plumbing. Saves 1 day and removes a stepping-stone commit.

If you want to ship StructuredOutput alignment alone first (e.g. to test the inline Stop-check in isolation), start Phase A at Day 2 and ship. But since Phase A Day 1 is pure `.md` copies with zero runtime risk, there's no benefit to splitting.

---

### Phase A — Team runtime infrastructure (4 days)

**Goal**: Can spawn a subagent, send messages between agents, load AGENT.md from disk.

**Tasks**:

The task list below follows the "采摘式" port strategy from §5 — verbatim prompts first (near-free wins), then loader, then structural ports of AgentTool/SyntheticOutputTool skeletons, reusing existing `src/core/query-loop.ts` for the subagent main loop. Risk rises Day 1 → Day 4; if anything breaks, Day 4 work is most likely.

Day 1 — "Just copy" ports + loader (low-risk foundation):
- [ ] Extract `engine/tools/AgentTool/prompt.ts:99-112` + `:232-240` + `:242-249` + `:115-154` into `src/tools/AgentTool/references/delegation-teaching.md`. Substitute `FILE_READ_TOOL_NAME` → `query_plan_items`, delete `GLOB_TOOL_NAME` references, `AGENT_TOOL_NAME` → `Task`, delete `BASH_TOOL_NAME` references. **~30 min port.**
- [ ] Copy `SHARED_GUIDELINES` from `engine/tools/AgentTool/built-in/generalPurposeAgent.ts` into `src/tools/AgentTool/agents/_shared/references/base-guidelines.md`. Substitute `"file searches"` → `"DB queries"`, `"codebase"` → `"plan items and team state"`, `"NEVER create files unless"` → `"NEVER call external APIs not in your tool list"`. Path mirrors CC (`AgentTool/built-in/` → `Task/agents/_shared/`). **~15 min port.**
- [ ] Port `engine/tools/AgentTool/loadAgentsDir.ts` `parseAgent()` into `src/tools/AgentTool/loader.ts`. Keep: YAML+markdown split, name/description/tools/model/maxTurns/color fields, `references` + `shared-references` parsing. Drop validators for: `skills`, `hooks`, `mcpServers`, `permissionMode`, `isolation`, `initialPrompt`, `memory`, `omitClaudeMd`, `requiredMcpServers`, `background`. **~3h port.**
- [ ] Unit tests: 3 fixture AGENT.md files (valid / missing-description / invalid-tools); loader emits correct `AgentDefinition[]`; rejects malformed.

Day 2 — StructuredOutput + enforcement:
- [ ] `src/tools/StructuredOutputTool/StructuredOutputTool.ts` — port `engine/tools/SyntheticOutputTool/SyntheticOutputTool.ts`. Replace Ajv with Zod; replace `buildTool` with our `ToolDefinition`; replace `TelemetrySafeError` with plain Error; replace `lazySchema` with direct schema pass-in. **Keep** `WeakMap<zodSchema, tool>` cache pattern verbatim. **~4h port.**
- [ ] Inline Stop-check into `src/core/query-loop.ts` `runAgent()`: when `stop_reason === 'end_turn'` AND `outputSchema` is set AND no `StructuredOutput` tool_use in this response → inject correction message "You MUST call StructuredOutput to complete this request." and continue loop. Counter: `MAX_STRUCTURED_OUTPUT_RETRIES` (env, default 5). **~2h port.** (Do NOT port CC's `addFunctionHook` / session hook system — just inline.)
- [ ] Rename existing WIP `submit_<agent>` plumbing to use static `StructuredOutput` name.
- [ ] Remove `SHIPFLARE_TERMINAL_TOOL_AGENTS` feature flag (no longer needed — StructuredOutput is default when `outputSchema` present).
- [ ] Unit tests: tool synthesis from Zod (including edge cases: minItems>1, z.record, deep objects); Stop-check triggers injection; retry counter cuts off at N.

Day 3 — Task tool + spawn:
- [ ] `src/tools/AgentTool/prompt.ts` — `buildTaskDescription(agents: AgentDefinition[]): string`:
  - Reads `src/tools/AgentTool/references/delegation-teaching.md` at startup (cached)
  - Generates agent list via `formatAgentLine(agent)` port
  - Returns assembled tool description
- [ ] `src/tools/AgentTool/spawn.ts` — thin wrapper (~40 lines):
  ```ts
  export async function spawnSubagent(
    def: AgentDefinition,
    prompt: string,
    parentCtx: ToolContext,
    callbacks?: { onMessage?, onToolCall?, onError? },
  ): Promise<AgentResult<unknown>> {
    const config = buildAgentConfigFromDefinition(def);
    const childCtx = createChildContext(parentCtx);  // new AbortController, inherit deps
    return await runAgent(config, prompt, childCtx, def.outputSchema, callbacks?.onProgress);
  }
  ```
  **No re-implementation of `engine/tools/AgentTool/runAgent.ts`.** Existing `core/query-loop.ts runAgent()` is the loop.
- [ ] `src/tools/AgentTool/AgentTool.ts` — extract `AgentTool.tsx` `call()` skeleton (~200 lines):
  - Input schema: `{ subagent_type, prompt, description, name?: string }` (omit `run_in_background`, `isolation`, `mode`, `team_name`, `cwd`, `model`)
  - Validate `subagent_type` against loader's agents
  - Resolve AgentDefinition, call `spawnSubagent`, write `team_tasks` row, return result
  - Skip: UI renderers, permission flow, feature-flag branches, worktree handling
- [ ] Unit tests: Task spawns stub agent, returns result; invalid subagent_type rejected; team_tasks row created.

Day 4 — SendMessage + DB + API + integration:
- [ ] DB migration `0034_team_platform.sql` (from §6.1). Run in dev.
- [ ] `src/tools/SendMessageTool.ts` — **full rewrite** (CC transport doesn't map). Redis pub channel `team:${teamId}:messages`; target resolution by `name` (display_name) or `memberId` (uuid); INSERT `team_messages` row; publish event for SSE.
- [ ] `src/workers/processors/team-run.ts` — BullMQ consumer. Reads `team_runs` job, loads team via loader, builds coordinator's ToolContext (deps: db, redis, userId), calls `runAgent(coordinatorConfig, goal)`. On completion/failure: update `team_runs.status`, record cost.
- [ ] `src/app/api/team/run/route.ts` — POST endpoint. Validates goal, INSERT `team_runs` row, enqueues BullMQ job, returns `{ runId, traceId }`.
- [ ] `src/app/api/team/events/route.ts` — SSE stream. Subscribes to Redis `team:${teamId}:messages`, streams `team_messages` inserts; heartbeat every 15s.
- [ ] `src/app/api/team/status/route.ts` — snapshot GET (team members + active run if any).
- [ ] Integration test: toy coordinator AGENT.md + stub echo-agent AGENT.md → POST `/api/team/run` → verify:
  - `team_runs` row created + completes
  - `team_messages` contains expected sequence: user_prompt, tool_call(Task), tool_result, tool_call(StructuredOutput), completion
  - `team_tasks` row for the echo-agent spawn
  - SSE delivers all events to test client

**Commits** (7 atomic):
1. `docs(tools): port delegation-teaching.md from Claude Code prompt.ts`
2. `docs(agents): port base-guidelines.md from Claude Code SHARED_GUIDELINES`
3. `feat(tools): port AgentDefinition loader from Claude Code loadAgentsDir`
4. `feat(tools): port StructuredOutput tool + inline Stop-check enforcement`
5. `feat(tools): add Task tool + spawn (wraps existing runAgent)`
6. `feat(tools): add SendMessage tool (Redis pub/sub)`
7. `feat(api): team platform DB + run/events/status endpoints`

**Gate**:
- All 4 Day 4 integration test assertions pass
- `pnpm tsc --noEmit` green
- Existing Phase 0 StructuredOutput tests still green
- Port provenance verified: each CC-derived file has a comment header citing source (e.g. `// Ported from engine/tools/AgentTool/loadAgentsDir.ts parseAgent()`)

---

### Phase B — 3 core agents + 12 domain tools (4 days)

**Goal**: Real coordinator + growth-strategist + content-planner can run an onboarding plan end-to-end, producing strategic_paths + plan_items rows equivalent to current output.

**Tasks**:

Day 1 — domain tools (half):
- [ ] `src/tools/StrategicPathTools/Write.ts` — validates via `strategicPathSchema` (moved to `src/tools/schemas.ts` as part of this refactor; old `src/agents/schemas.ts` is deleted in Phase C), INSERT/UPDATE `strategic_paths`. Tool identifier: `write_strategic_path`.
- [ ] `src/tools/StrategicPathTools/Query.ts` — identifier: `query_strategic_path`
- [ ] `src/tools/PlanItemTools/Add.ts` — validates `planItemInputSchema`, INSERT `plan_items`. Identifier: `add_plan_item`.
- [ ] `src/tools/PlanItemTools/Update.ts` — identifier: `update_plan_item`
- [ ] `src/tools/PlanItemTools/QueryStalled.ts` — identifier: `query_stalled_items`
- [ ] `src/tools/PlanItemTools/QueryCompletions.ts` — identifier: `query_last_week_completions`
- [ ] `src/tools/MilestoneTools/QueryRecent.ts` — reads from GitHub milestones table. Identifier: `query_recent_milestones`.

Day 2 — domain tools (rest) + registry:
- [ ] `src/tools/MetricsTools/Query.ts` — identifier: `query_metrics` (stub or basic; full impl Phase E with analytics-analyst)
- [ ] `src/tools/TeamTools/QueryStatus.ts` — identifier: `query_team_status`
- [ ] `src/tools/PlanItemTools/Query.ts` — identifier: `query_plan_items` (generic filter — takes `{ weekOffset?, status?, id?, limit? }`)
- [ ] Each entity folder gets an `index.ts` that re-exports all tools in it (e.g. `PlanItemTools/index.ts` exports `addPlanItemTool`, `updatePlanItemTool`, `queryPlanItemsTool`, `queryStalledItemsTool`, `queryLastWeekCompletionsTool`)
- [ ] `src/tools/registry.ts` — registers all new tools using their flat snake_case identifiers (`query_plan_items`, `write_strategic_path`, etc.). No namespacing — matches CC convention (flat tool names).
- [ ] Tool allowlist enforcement in `runAgent`: match tool calls against agent's `tools` array
- [ ] Tests for each tool (happy path + validation failures)

Day 3 — AGENT.md files + reference docs (all under `src/tools/AgentTool/agents/`, mirroring CC's `AgentTool/built-in/`):
- [ ] `src/tools/AgentTool/agents/coordinator/AGENT.md` (from §8.1)
- [ ] `src/tools/AgentTool/agents/coordinator/references/when-to-handle-directly.md`
- [ ] `src/tools/AgentTool/agents/coordinator/references/decision-examples.md` (from §8.4 — coordinator-only)
- [ ] `src/tools/AgentTool/agents/growth-strategist/AGENT.md` (from §8.2)
- [ ] `src/tools/AgentTool/agents/growth-strategist/references/strategic-path-playbook.md` (port current `strategic-planner.md` steps 1-6, drop "Output" section)
- [ ] `src/tools/AgentTool/agents/content-planner/AGENT.md` (from §8.3)
- [ ] `src/tools/AgentTool/agents/content-planner/references/tactical-playbook.md` (port current `tactical-planner.md` steps 1-5, drop "Output" section)
- [ ] `src/tools/AgentTool/agents/_shared/references/channel-cadence.md` (extract from current strategic-planner step 5)

Day 4 — wiring + e2e test:
- [ ] `src/app/api/team/run/route.ts` handles `trigger: 'onboarding'`
- [ ] Refactor `/api/onboarding/plan` to trigger a team_run:
  - Still returns SSE (consumers unchanged)
  - But instead of calling `runSkill` directly, POST `/api/team/run` and proxy SSE from `/api/team/events` to the caller
- [ ] `/api/plan/replan` same pattern
- [ ] E2E: run onboarding fixture. Verify:
  - `team_runs` row created, status completes
  - `strategic_paths` row written
  - ≥5 `plan_items` rows written
  - `team_messages` contains expected tool_calls (Task × 2, StructuredOutput × 3 from each agent)

**Commits**:
1. `feat(tools): add domain tools for team agents (write_strategic_path, add_plan_item, queries)`
2. `feat(agents): add coordinator, growth-strategist, content-planner AGENT.md with ported references`
3. `docs(agents): port strategic-path-playbook and tactical-playbook from v2 planners`
4. `docs(agents): add decision-examples.md with 4 <thinking> patterns`
5. `feat(api): route /api/onboarding/plan through team run`
6. `test(e2e): onboarding → team run produces equivalent strategic_path + plan_items`

**Gate**:
- Team run completes end-to-end
- Output equivalence vs old path: run 20 onboarding fixtures through both (WIP: keep current code alive until Phase C)
- Output matches within 15% on: pillar count, item count, channel distribution, schedule spread
- pnpm tsc --noEmit green
- No regressions in existing tests

---

### Phase C — Delete old paths (1-2 days)

**Goal**: Remove old skill-runner and planner code. New path becomes sole path.

**Prerequisite**: Phase B's equivalence tests must pass stably for 2 days in staging before starting Phase C.

**Tasks**:

Day 1 — delete planner paths:
- [ ] Delete `src/agents/strategic-planner.md`
- [ ] Delete `src/agents/tactical-planner.md`
- [ ] Delete `src/skills/strategic-planner/` directory
- [ ] Delete `src/skills/tactical-planner/` directory
- [ ] Delete `src/workers/processors/tactical-generate.ts`
- [ ] Delete `/api/onboarding/commit` tactical-generate enqueue block (keeps commit route but removes old trigger)
- [ ] Simplify `/api/onboarding/plan/route.ts` — remove `runStrategic()`, keep just SSE proxy

Day 2 — delete skill-runner and orchestration:
- [ ] Delete `src/skills/_catalog.ts`
- [ ] Delete `src/skills/voice-extractor/` (Phase E will re-add as a tool, not agent)
- [ ] Delete `src/core/skill-runner.ts`
- [ ] Delete `src/core/skill-loader.ts`
- [ ] Delete `src/core/swarm/` directory
- [ ] Delete `src/core/coordinator.ts` (if exists — different from the new AGENT)
- [ ] Delete `src/core/fanOutCached` exports if present
- [ ] Clean up `src/core/query-loop.ts`:
  - Remove `STRIPPED_KEYS`, `UnexpressibleSchemaError`, `sanitizeJsonSchemaForAnthropic`, `zodToSanitizedJsonSchema`
  - Remove `jsonSchemaForOutput` branches in runAgent + queryLoop
  - Remove any `SHIPFLARE_TERMINAL_TOOL_AGENTS` checks
- [ ] Clean up `src/core/api-client.ts`:
  - Remove `outputSchema` param from `createMessage`
  - Remove `output_config.format` construction
  - Remove `outputSchema` from `sideQuery`
- [ ] Remove dead skills: keep only `draft-single-post`, `draft-single-reply`, `identify-top-supporters`, `compile-retrospective`, `analytics-summarize`, `generate-interview-questions`, `draft-hunter-outreach`, `draft-waitlist-page`, `draft-launch-day-comment`, `generate-launch-asset-brief`, `build-launch-runsheet` UNTIL Phase E. These are referenced by `plan-execute` worker still.
- [ ] `pnpm tsc --noEmit` green after each file deletion

**Commits**:
1. `refactor: delete v2 strategic-planner and tactical-planner`
2. `refactor: delete skill-runner, skill-loader, swarm, fanOutCached`
3. `refactor: delete output_config.format path from query-loop and api-client`
4. `refactor: remove SHIPFLARE_TERMINAL_TOOL_AGENTS feature flag`

**Gate**: `pnpm tsc --noEmit` green, all remaining tests pass, staging `/api/onboarding/plan` and `/api/plan/replan` work via team runs.

---

### Phase D — /team UI (3 days)

**Goal**: User can see team members, real-time activity, send direct messages.

**Tasks**:

Day 1 — page scaffold + components:
- [ ] `src/app/(app)/team/page.tsx` — team grid layout
- [ ] `src/app/(app)/team/_components/member-card.tsx` — avatar, role, status, current task preview
- [ ] `src/app/(app)/team/_components/team-header.tsx` — team name, total cost this week, recent run status
- [ ] Fetch: `GET /api/team/status` snapshot

Day 2 — activity log + detail page:
- [ ] `src/app/(app)/team/[memberId]/page.tsx` — member detail
- [ ] `src/app/(app)/team/_components/activity-log.tsx` — threaded view of `team_messages` where `from_member_id = X OR to_member_id = X`
- [ ] Filter by run, by type, by date
- [ ] `useTeamEvents()` hook — subscribes to `/api/team/events`, updates activity log + member status in real-time

Day 3 — send message + wrap up:
- [ ] `src/app/(app)/team/_components/send-message-form.tsx`
- [ ] `POST /api/team/message` — user sends message to member. Creates a `team_run` with the message as goal, or routes to existing run if one is waiting
- [ ] Brand polish: use v3 design system tokens
- [ ] Empty state: "Your team is ready. Ship your first plan to get started." → CTA to `/today` or new run

**Commits**:
1. `feat(team): add /team page with member cards`
2. `feat(team): add member detail page with activity log`
3. `feat(team): add direct message + SSE real-time updates`

**Gate**: E2E test: run onboarding, watch /team show coordinator + specialists going active → completing, click member to see full message thread, send a direct message and see coordinator respond.

---

### Phase E — Extended team (3 days)

**Goal**: Add x-writer, reddit-writer, community-manager. Enable content-planner fan-out. Delete remaining old skill directories.

**Tasks**:

Day 1 — x-writer + reddit-writer:
- [ ] `src/tools/AgentTool/agents/x-writer/AGENT.md` (skeleton in §8, full body based on current `draft-single-post/SKILL.md`)
- [ ] `src/tools/AgentTool/agents/x-writer/references/x-content-guide.md` — move from `src/skills/draft-single-post/references/`
- [ ] `src/tools/AgentTool/agents/reddit-writer/AGENT.md`
- [ ] `src/tools/DraftingTools/Post.ts` — identifier: `draft_post`. Accepts `{ planItemId, context }`, calls `sideQuery`, validates, UPDATE `plan_items.draft_body`.
- [ ] Update content-planner AGENT.md: add `Task` to tools, add "How to fan out drafts" section

Day 2 — community-manager:
- [ ] `src/tools/AgentTool/agents/community-manager/AGENT.md`
- [ ] `src/tools/DraftingTools/FindThreads.ts` — identifier: `find_threads`
- [ ] `src/tools/DraftingTools/Reply.ts` — identifier: `draft_reply`
- [ ] Integrate with existing reply-guy discovery worker (triggers `team_runs` with `trigger: 'reply_sweep'`)

Day 3 — delete remaining old skills:
- [ ] Delete all of `src/skills/draft-*/` directories
- [ ] Delete `src/skills/voice-extractor/`, `analytics-summarize/`, etc.
- [ ] Refactor `plan-execute` worker: instead of dispatching to skills by name, route `kind=content_post, channel=x` → spawn `Task(x-writer)` in a child team_run
- [ ] Final grep sweep to ensure no callers of old skill-runner code remain
- [ ] `pnpm tsc --noEmit` green

**Commits**:
1. `feat(agents): add x-writer and reddit-writer`
2. `feat(tools): add draft-post tool`
3. `feat(agents): add community-manager for reply-guy workflow`
4. `refactor(plan-execute): route draft jobs through team runs`
5. `refactor: delete all v2 skill directories`

**Gate**: A full onboarding run produces:
- strategic_path (growth-strategist)
- 15 plan_items (content-planner)
- 10 drafts auto-populated (x-writer × N, reddit-writer × M via content-planner Task fan-out)

---

### Phase F — Team auto-provisioning + "Meet your team" intro (1 day)

**Goal**: Teams are auto-created on account/product creation based on product category. Onboarding shows a read-only "Meet your team" card. No user customization UI.

**Scope deliberately small** — team composition is a product decision, not a user decision (see §2 and D6). This phase is just plumbing + one UI card.

**Tasks**:

Half-day — provisioner:
- [ ] `src/lib/team-provisioner.ts`:
  ```ts
  export async function provisionTeamForProduct(
    userId: string,
    productId: string,
  ): Promise<string /* teamId */> {
    const product = await db.select(...).from(products).where(eq(products.id, productId));
    const preset = pickPresetByCategory(product.category);
    const members = getTeamCompositionForPreset(preset);
    // INSERT teams + team_members rows
  }
  
  function pickPresetByCategory(cat: ProductCategory): TeamPreset {
    switch (cat) {
      case 'dev_tool': return 'dev-squad';
      case 'saas':
      case 'ai_app': return 'saas-squad';
      case 'consumer': return 'consumer-squad';
      case 'creator_tool':
      case 'agency':
      case 'other':
      default: return 'default-squad';
    }
  }
  
  function getTeamCompositionForPreset(preset: TeamPreset): AgentType[] {
    // Phase B shipped: coordinator, growth-strategist, content-planner
    // Phase E shipped: +x-writer, +reddit-writer, +community-manager
    const base: AgentType[] = ['coordinator', 'growth-strategist', 'content-planner'];
    switch (preset) {
      case 'dev-squad':      return [...base, 'x-writer', 'community-manager'];
      case 'saas-squad':     return [...base, 'x-writer', 'community-manager'];
      case 'consumer-squad': return [...base, 'reddit-writer', 'community-manager'];
      case 'default-squad':  return [...base, 'x-writer'];
    }
  }
  ```
- [ ] Display name mapping in the provisioner:
  ```ts
  const DISPLAY_NAMES: Record<AgentType, string> = {
    'coordinator':        'Chief of Staff',
    'growth-strategist':  'Head of Growth',
    'content-planner':    'Head of Content',
    'x-writer':           'X Writer',
    'reddit-writer':      'Reddit Writer',
    'community-manager':  'Community Manager',
  };
  ```
- [ ] Hook into account creation: after `products` row is created, call `provisionTeamForProduct`
- [ ] Migration backfill: existing users get teams provisioned (script: `scripts/backfill-teams.ts`)

Half-day — onboarding intro card:
- [ ] Onboarding Stage 6 adds a "Meet your team" section (read-only):
  - 3-5 member cards side-by-side showing display_name + role blurb + avatar
  - Copy: "Your team is ready to launch. They'll start working the moment you approve your first plan."
  - No buttons to add/remove/rename. Purely intro/confidence-building.
- [ ] E2E: new user signs up → product created → team + 3 members in DB → onboarding stage 6 shows all 3 cards

**Commits**:
1. `feat(lib): add team-provisioner with category-based composition`
2. `feat(onboarding): add Meet your team intro card (read-only)`
3. `chore: backfill teams for existing users`

**Gate**: New user signup produces a team with the right members in DB. Onboarding shows them. Nothing user-configurable exposed.

---

### Phase G — Observability + cost control (2 days)

**Goal**: Production-monitorable, cost-capped.

**Tasks**:

Day 1 — tracking:
- [ ] Update `team-run.ts` worker to record per-member `cost_usd` breakdown in `team_tasks` and aggregate to `team_runs.total_cost_usd`
- [ ] `src/app/admin/team-runs/page.tsx` — (admin-only) list all recent runs, filter by team/status/cost
- [ ] Drill-down to single run: trace view with team_messages + tasks + cost per member
- [ ] Slow query alert: runs where `duration > 5min` → Sentry event

Day 2 — budget + pause:
- [ ] `teams.config.weeklyBudgetUsd` (nullable, default $5)
- [ ] Budget check in team-run worker:
  - At 90% → email founder
  - At 100% → block `Task` tool calls (allow queries only); coordinator sees tool disabled + gets message "Team weekly budget reached"
- [ ] Resets on Monday 00:00 UTC per team
- [ ] `SHIPFLARE_TEAM_AUTO_BUDGET_PAUSE=true` (default) — flag to opt out

**Commits**:
1. `feat(team): track per-run cost and per-member breakdown`
2. `feat(admin): team runs dashboard`
3. `feat(team): weekly budget with auto-pause`

---

## 12. Feature Flags

Kept deliberately small:

| Flag | Default | Phase introduced | Removed in |
|---|---|---|---|
| `SHIPFLARE_TERMINAL_TOOL_AGENTS` | `""` | Pre-existing (WIP `submit_X` code) | Phase A Day 2 (superseded by StructuredOutput default path) |
| `MAX_STRUCTURED_OUTPUT_RETRIES` | `5` | Phase 0 | Kept permanently (tuning knob) |
| `SHIPFLARE_TEAM_AUTO_BUDGET_PAUSE` | `true` | Phase G | Kept permanently (safety) |
| `TEAM_RUN_CONCURRENCY` | `3` | Phase A | Kept permanently (worker tuning) |

No `SHIPFLARE_USE_TEAM_RUN_FOR_PLANNING`-style rollout flag — direct cutover.

---

## 13. Delete Manifest

Running tally of everything that gets deleted across phases:

### Phase 0
- Rename-in-place, no deletions

### Phase A
- None (purely additive)

### Phase B
- None (still keeps old path alive during equivalence testing)

### Phase C
- `src/agents/strategic-planner.md` (450 lines) — the whole top-level `src/agents/` directory should be empty after this; delete it
- `src/agents/tactical-planner.md` (300 lines)
- `src/agents/schemas.ts` → moved to `src/tools/schemas.ts` in Phase B Day 1 (only `strategicPathSchema` + `planItemInputSchema` survive — others deleted)
- `src/skills/strategic-planner/` (~150 lines)
- `src/skills/tactical-planner/` (~250 lines)
- `src/workers/processors/tactical-generate.ts` (~100 lines)
- `src/core/skill-runner.ts` (~300 lines)
- `src/core/skill-loader.ts` (~150 lines)
- `src/core/swarm/` (~400 lines)
- `src/core/coordinator.ts` if exists (~200 lines)
- `src/core/query-loop.ts`: `STRIPPED_KEYS`, `UnexpressibleSchemaError`, `sanitizeJsonSchemaForAnthropic`, `zodToSanitizedJsonSchema`, `jsonSchemaForOutput` branches (~150 lines)
- `src/core/api-client.ts`: `outputSchema` support (~20 lines)
- `src/skills/_catalog.ts` entries for strategic/tactical planners (~50 lines)
- Old `src/agents/schemas.ts` — moved to `src/tools/schemas.ts` in Phase B Day 1; only `strategicPathSchema` + `planItemInputSchema` survive (delete `tacticalPlanSchema` — no longer a thing, items are written via `add_plan_item` tool)

### Phase E
- `src/skills/draft-single-post/` (~200 lines + references)
- `src/skills/draft-single-reply/` (~180 lines + references)
- `src/skills/voice-extractor/` (~150 lines)
- `src/skills/identify-top-supporters/` (~100 lines)
- `src/skills/compile-retrospective/` (~120 lines)
- `src/skills/analytics-summarize/` (~100 lines)
- `src/skills/generate-interview-questions/` (~80 lines)
- `src/skills/draft-hunter-outreach/` (~100 lines)
- `src/skills/draft-waitlist-page/` (~80 lines)
- `src/skills/draft-launch-day-comment/` (~80 lines)
- `src/skills/generate-launch-asset-brief/` (~100 lines)
- `src/skills/build-launch-runsheet/` (~150 lines)
- `src/skills/_catalog.ts` (whole file, ~200 lines)

**Cumulative deletion**: ~3,300 lines Phase C + ~1,700 lines Phase E = **~5,000 lines deleted**.

**Cumulative new code**: ~2,000 lines across phases A-G.

**Net**: **-3,000 lines**, not counting UI (+ ~800 lines for `/team` page, +800 lines for settings/onboarding-team-stage).

---

## 14. Testing Strategy

### 14.1 Unit tests

Each phase adds unit tests for new code:

| Phase | Tests |
|---|---|
| 0 | StructuredOutput Zod → JSON schema conversion; Stop hook trigger on missing call; retry counter |
| A | `AgentDefinition` loader parses valid/invalid frontmatter; `spawnSubagent` creates isolated context; Task tool input validation; SendMessage pub/sub delivery |
| B | Each domain tool happy path + validation failure + DB side effect |
| E | `draft_post`, `find_threads`, `draft_reply` tools |
| F | `team-provisioner.ts` picks correct composition per product category; backfill script produces teams for all existing users |
| G | Cost tracking accumulates correctly; budget pause blocks Task tool |

### 14.2 Integration tests

- `test/integration/team-run.ts`: happy path onboarding → team_run → strategic_path + plan_items
- `test/integration/coordinator-delegation.ts`: given 4 different goals, verify coordinator delegates correctly (1 direct, 1 serial, 1 parallel, 1 serial-chain)
- `test/integration/writer-fan-out.ts`: content-planner spawns 5 x-writers in parallel, all drafts land

### 14.3 E2E tests (Playwright)

- `e2e/team/onboarding.spec.ts`: full onboarding → /team page shows 3 members active → completes
- `e2e/team/direct-message.spec.ts`: user sends message to member, gets response
- `e2e/team/provisioner.spec.ts`: Phase F — new signup with `category: dev_tool` → DB has exactly [coordinator, growth-strategist, content-planner, x-writer, community-manager]; onboarding Stage 6 shows all five cards

### 14.4 Equivalence tests (Phase B gate)

Run 20 onboarding fixtures through both paths:

```ts
// test/equivalence/onboarding.test.ts
for (const fixture of FIXTURES) {
  const oldResult = await runOldOnboarding(fixture);     // runSkill strategic-planner
  const newResult = await runTeamRun(fixture, 'onboarding'); // team run
  
  expect(newResult.pillars.length).toBeGreaterThanOrEqual(oldResult.pillars.length - 1);
  expect(newResult.planItems.length).toBeCloseTo(oldResult.planItems.length, 2);
  expect(channelDistribution(newResult)).toMatchObject(channelDistribution(oldResult));
  expect(scheduleSpread(newResult)).toMatchObject(scheduleSpread(oldResult));
}
```

Tolerance: ±15% on each dimension.

---

## 15. Observability & Cost

### 15.1 Tracing

- Every API call generates `trace_id` stored in `team_runs.trace_id`
- `team_messages` and `team_tasks` carry `trace_id` via `run_id` FK
- Logs tag every line: `[team:abc trace:xyz member:growth-strategist task:def]`

### 15.2 Metrics (Prometheus / StatsD, whichever exists)

- `team_run.duration` histogram (by trigger type)
- `team_run.cost_usd` histogram (by trigger type)
- `team_run.subagent_spawn_count` counter (by subagent_type)
- `team_run.task_failure_count` counter (by subagent_type)
- `team_run.structured_output_retry_count` counter

### 15.3 Alerts

| Alert | Threshold | Action |
|---|---|---|
| Run duration > 10min | Warning | Sentry |
| Run cost > $2 | Warning | Sentry + email ops |
| Run failed | Error | Sentry |
| structured_output_retry_count > 3 for a member | Warning | Prompt needs tuning |
| Weekly team budget hit | Info | Email founder, Slack #ops |

### 15.4 Admin dashboard (Phase G)

- `/admin/teams` — list all teams, cost this week, run count
- `/admin/team-runs/{runId}` — trace view with message timeline + cost per member

---

## 16. Risk & Mitigation

| Risk | Likelihood | Severity | Mitigation |
|---|---|---|---|
| Cost per user doubles (multi-agent overhead) | Medium | High | Budget pause (Phase G); aggressive prompt caching; start with 3 agents not 6 |
| Coordinator delegates to wrong specialist | Medium | Medium | Detailed `description` fields; `decision-examples.md`; equivalence test gate; Phase D activity log for fast debugging |
| New path produces inferior plans vs v2 | Low-Medium | High | Phase B equivalence gate with 20 fixtures; hold Phase C deletion until passes 2 days stable |
| Prompt cache thrashing (each subagent = cache miss) | Medium | Medium | Port `CacheSafeParams` carefully; share system prompt prefix; measure cache hit rate in Phase A gate |
| Users confused by team metaphor | Low-Medium | Medium | Stage 6 "Meet your team" intro card (read-only, no decisions to make); `/team` page purely informational; approvals still happen on `/today` (unchanged). The team is an additive transparency layer, not a required interaction surface |
| Prompt engineering burden (7 AGENT.md to maintain) | Medium | Low | `_shared/references/` reuse; start with 3; port from CC where possible |
| Race condition: two team_runs for same team | Low | Medium | DB unique constraint `(team_id, status='running')`; BullMQ job dedup on teamId |
| Agent "forgets" to call StructuredOutput | Medium | High | CC Stop-check ported inline into runAgent (Phase A Day 2); retry counter (`MAX_STRUCTURED_OUTPUT_RETRIES=5`); system prompt emphasizes it |
| Circular Task calls (A spawns B spawns A) | Low | High | `team_tasks.parent_task_id` tracked; spawn depth limit = 3; if exceeded, error out |
| Feature flag cleanup debt | Low | Low | All flags have explicit "removed in Phase X" plan; Phase A Day 2 removes `SHIPFLARE_TERMINAL_TOOL_AGENTS` |
| Secret leak via AGENT.md prompts | Low | High | No secrets in prompts; `.env` values never interpolated; frontmatter tested |

---

## 17. Rollback Plan

Each phase is revertible:

| Phase | Rollback | Time |
|---|---|---|
| 0 | `git revert` the Phase 0 commit | 5 min |
| A | `git revert` A commits; pre-existing v2 path is still live | 15 min |
| B | `git revert` B commits; coordinator + specialists disappear, v2 path still live | 30 min |
| **C** | **Cannot `git revert` cleanly** — need to re-introduce deleted code from history. **Window: 48h after Phase C deploy** — if problems surface, `git revert` + redeploy within 48h. After 48h, stuck with new path. | 2-4 hours if within 48h |
| D | `git revert` UI commits; no impact on backend | 10 min |
| E | `git revert` Phase E commits; coordinator works with 3 agents; plan-execute worker temporarily broken — may need to re-add old skill dispatch for 1-2 days | 1-2 hours |
| F | `git revert` F commits; provisioner gone but Phase B/E teams already created keep working. New signups won't have teams auto-provisioned — would need manual SQL inserts or roll forward | 15 min |
| G | `git revert` G commits; no budget controls but normal function | 10 min |

**Pre-Phase C checkpoint**: tag the commit before Phase C begins as `pre-team-platform-cutover`. Makes rollback a `git reset --hard <tag>` if needed.

**Post-Phase C window**: During the 48-hour window after deploy, monitor error rate + cost + user-reported issues. If any regression, roll back. After 48h, commit to the new architecture.

---

## 18. Open Questions

These don't block Phase 0/A but should be resolved before Phase B:

1. **Tool namespacing** — register tools as flat `write_strategic_path` or namespaced `team:write_strategic_path`? CC uses flat. Decision: **flat** (simpler, matches CC).

2. **`disallowedTools` on AGENT.md** — do we need this? CC has it for plugin-only restrictions. We probably don't. Decision: **skip in v1**, add if later phase reveals a need.

3. **Subagent max depth** — coordinator spawns content-planner spawns x-writer. That's depth 2. Should we allow deeper? CC has no hard limit. Decision: **soft limit 3** enforced via `team_tasks.parent_task_id` chain length; error above.

4. **SendMessage synchronous vs async** — CC's `SendMessage` is async (delivered as user-role message next turn). We probably want the same. Decision: **async**, consistent with CC.

5. **Voice extraction** — currently a skill. New shape: a tool `save_voice_profile` called by... which agent? Options:
   - (a) growth-strategist calls it during first run if voice is null
   - (b) dedicated `voice-extractor` agent (adds an agent to the roster)
   - (c) standalone tool called by worker before team_run starts
   
   Decision: **(c)** — keep voice extraction as a pre-run worker step, not an agent. Run once at onboarding; team uses the result.

6. **Writer multiplicity** — x-writer spawned 10 times in parallel gets 10 separate API roundtrips. Could be batched. Decision: **keep separate** for v1 (simpler, cache-friendly, parallel is fine). Batch tool call (`draft_posts([...])`) is a Phase G optimization if cost forces it.

7. **Run cancellation** — how does user cancel a team_run? Decision: `DELETE /api/team/runs/{runId}` → sets `status='cancelled'`, sends `abort` signal through ToolContext chain, pending Task calls return immediately. UI adds "Cancel" button on active run.

8. **Message retention** — `team_messages` grows unbounded. Decision: keep 90 days; nightly cron deletes older. Completed runs' final summary still in `team_runs.summary`.

9. **Team composition per category** (settled by D6 but composition mapping needs validation) — we auto-provision by `product.category`. Starting mapping in §Phase F:
   - `dev_tool` / `saas` / `ai_app` → base + x-writer + community-manager
   - `consumer` → base + reddit-writer + community-manager
   - `creator_tool` / `agency` / `other` → base + x-writer
   
   **Decision needed before Phase B completes**: confirm these mappings with 5 real user fixtures. Tweak if we find a category that gets consistently bad output. This is internal tuning (edit `team-provisioner.ts`), not user-facing.

10. **"Meet your team" on channel addition** — if a user connects Reddit after onboarding, do we auto-add `reddit-writer` to the team? Decision: **yes, silently**. Trigger: `channels` table INSERT → provisioner re-evaluates team composition → inserts missing `team_members`. User sees a toast: "Reddit Writer joined your team." No choice UI; we decided the team needs them.

---

## Summary

**What**: Replace 19 skill agents + 2 planners + custom skill-runner with 3 initial AGENT.md files (auto-extending to 5 in Phase E based on connected channels) + ported Claude Code Task/SendMessage/StructuredOutput tools + 12 domain tools + 5 DB tables. `/team` UI for read-only visibility. Team composition is product-decided, not user-configurable.

**Why**: Structured-output grammar limits + too much custom orchestration + poor product positioning. Clean cutover possible since product isn't launched.

**How**: 7 phases over ~2.5 weeks. Port CC prompts verbatim (delegation teaching, base guidelines, StructuredOutput enforcement). Delete old paths in same commits as new paths land (no dual-track). Teams auto-provisioned via `team-provisioner.ts` — no user-facing team-management UI.

**Cost**: +2,000 lines new, -5,000 lines deleted. Timeline 2.5 weeks. Production cost/user likely +20-50% (mitigated by budget controls in Phase G).

**Risk**: Coordinator delegation quality (mitigated by `decision-examples.md` + equivalence tests); cost (mitigated by budget pause); prompt maintenance (mitigated by `_shared/references/` reuse).

**Out of scope (explicit)**:
- User team customization UI
- `/settings/team` page
- Persona overrides / user-editable AGENT.md
- "Hire your own team" onboarding choice
- Per-user custom agent definitions

---

## Next Step

Review this spec. Green light → I start Phase 0 immediately (renaming `submit_X` → `StructuredOutput`, adding Stop-hook enforcement, retry counter, tests). Phase 0 is 1 day and fully revertible.
