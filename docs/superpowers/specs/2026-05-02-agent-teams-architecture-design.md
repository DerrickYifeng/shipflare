# Agent Teams Architecture — Faithful Replication of Claude Code's Multi-Agent Framework

**Date:** 2026-05-02
**Status:** Design approved (sections §1–§6); awaiting spec review before
implementation plan.
**Related:**
- `docs/superpowers/specs/2026-04-30-skill-primitive-restoration-design.md`
  (Phase 1 skill primitive — landed)
- `docs/superpowers/specs/2026-05-01-agent-skill-tool-decomposition-design.md`
  (Decomposition standard — Phases A–J landed 2026-05-01/02)
**Source material:** `claude-code-multi-agent.pdf` (analysis of
`yasasbanukaofficial/claude-code` 2026-03-31 sourcemap restoration) +
in-tree `engine/` reference copy.

---

## Summary

ShipFlare's existing multi-agent system already includes most of Claude
Code's coordinator/worker primitives (Task, SendMessage, SkillTool,
AgentDefinition with frontmatter), and the database schema is already
team-shaped (`teamMembers`, `teamMessages`, `teamTasks`). This spec
replicates the **Agent Teams** layer of Claude Code's architecture
(`isAgentSwarmsEnabled()` gate in engine), adapted for ShipFlare's
server-side runtime (Next.js + BullMQ + Postgres).

The destination architecture has these properties:

- A **team-lead** agent is the single entry point. Its prompt encodes a
  three-mode decision tree: handle-directly / sync-subagent (mode 2,
  current `Task` semantics) / async-teammate (mode 3, new path).
- **Tool access is governed by a four-layer filter pipeline**
  (engine § 3.5.1) with `assembleToolPool` as the single source of
  truth. Architecture-level invariants (only the lead can spawn /
  shutdown / approve plans) are enforced by an `INTERNAL_TEAMMATE_TOOLS`
  blacklist, not by per-call `if` checks.
- **Mode 3 teammates run as separate BullMQ jobs**, communicate via
  `team_messages` (DB-backed mailbox), and can `Sleep` to release worker
  slots. They wake on incoming `SendMessage` (which directly enqueues a
  BullMQ job) or scheduled `Sleep` expiry.
- Worker results are delivered as `<task-notification>` XML messages
  injected into the lead's mailbox with `team_messages.type =
  'user_prompt'` (shipflare's LLM-role convention) — the lead's
  `runAgent` main loop processes them as ordinary user input. This is
  engine PDF § 9 ②: **"messages are the conversation"**.
- The team-lead drives via a unified `agent-run` BullMQ queue (X model);
  `team_messages` is the universal communication channel for both
  founder→lead and agent↔agent. Founder UI input becomes a
  `team_messages` row addressed to the lead, traversing the same wake
  path as any other message.

The change ships in **seven phases over 8–12 weeks**, gated behind
`SHIPFLARE_AGENT_TEAMS` until Phase G removes the flag.

---

## Goals

1. **Faithful replication of Claude Code's invariants**, not surface-level
   imitation. The PDF §9 invariants (single-direction coordination, same
   tool pool with different views, messages-as-conversation, feature-flag
   layering) are preserved verbatim in shipflare.
2. **Naming alignment** with engine: `Task`, `SendMessage`, `TaskStop`,
   `TeamCreate`, `TeamDelete`, `SyntheticOutput`, `Sleep` — to make
   future cross-reference between shipflare code and engine references
   trivial.
3. **Three-mode lead dispatch**: lead decides per turn whether to
   handle directly, fan out a sync subagent, or spawn an async teammate
   for parallel / long-running work.
4. **Async parallelism** (engine's coordinator superpower): emit N
   `Task({run_in_background:true})` calls in one assistant message →
   N teammates run concurrently → results return as
   `<task-notification>` user-role messages on later idle turns.
5. **Sleep + Resume** for long-running teammate conversations, so idle
   teammates don't hold BullMQ slots.
6. **Single source of truth for tool access** — `assembleToolPool` is
   the only place that decides "which tools does agent X see".

## Non-goals

- **Agent Teams cross-team P2P** (engine's "uds:" / "bridge:"
  addressing). Out of scope; one team is one runtime scope.
- **`TeamCreate` / `TeamDelete` as LLM-facing tools.** Teams are
  user-configured (one team per product); team containers are not
  created by the LLM in MVP. Reserved as schema fields for Phase 2+.
- **KAIROS / autoDream / ULTRAPLAN** (engine layer 3, after PDF §8).
  Out of scope; tracked as future work.
- **Permission prompts** (engine `permissionMode`). ShipFlare runs
  server-side, no interactive UI prompts.
- **MCP servers** (engine `mcpServers` / `requiredMcpServers`).
  ShipFlare uses native registered tools.
- **Worktree isolation** (engine `isolation`). Server-side, no git
  worktrees.
- **TaskCreate V2 task family migration**. ShipFlare's existing
  `plan_items` / `team_tasks` schema serves the same role; no rename.

---

## Current state

What ShipFlare already has (after Skill primitive restoration & Agent /
Skill / Tool decomposition phases A–J):

- ✅ `Task` tool (sync subagent) — `src/tools/AgentTool/AgentTool.ts`
- ✅ `SendMessage` tool — single `to` + `content` shape, no
  discriminated union yet
- ✅ `Skill` tool with fork / inline contexts —
  `src/tools/SkillTool/SkillTool.ts`
- ✅ AgentDefinition loader with `name` / `description` / `tools` /
  `skills` / `model` / `maxTurns` / `references` /
  `shared-references`
- ✅ 5 built-in agents under `src/tools/AgentTool/agents/`: coordinator,
  content-manager, content-planner, discovery-agent, _shared
- ✅ DB schema: `teamMembers`, `teamMessages`, `teamTasks`, plus
  `team-run` worker that drives the coordinator session per BullMQ job
- ✅ `team-run` worker subscribes to user-message injection +
  cancellation mid-run; supports transcript resume across spawns
- ✅ `SyntheticOutput` is **not** registered (good — it stays
  system-only)

What's missing relative to engine Agent Teams:

- ❌ `TaskStop`, `Sleep`, `SyntheticOutput` (system-only) tools
- ❌ Four-layer tool filter pipeline + `assembleToolPool` SSOT
- ❌ `INTERNAL_TEAMMATE_TOOLS` blacklist
- ❌ AgentDefinition fields: `disallowedTools`, `background`, `role`,
  `requires`
- ❌ `<task-notification>` XML protocol
- ❌ Async agent lifecycle (separate BullMQ queue, mailbox drain on
  idle turn, Sleep + Resume)
- ❌ `agent_runs` table; `team_messages` columns for `message_type`,
  `from_agent_id`, `to_agent_id`, `delivered_at`, `summary`,
  `replies_to_id`
- ❌ `SendMessage` discriminated union (5 variants: message / broadcast
  / shutdown_request / shutdown_response / plan_approval_response)
- ❌ Three-mode lead dispatch prompt
- ❌ `team-run` → `agent-run` driver unification (X model)

---

## Key design decisions

| Decision | Choice | Rationale |
|---|---|---|
| Path | Path 2 — gated coexistence | Faithful to engine's `isAgentSwarmsEnabled()` pattern; lower cutover risk than big-bang; product not launched so we can rewrite freely once gate is on |
| Coordinator role | Renamed `coordinator` → `team-lead` (alias kept temporarily) | Aligns with engine Agent Teams nomenclature |
| Lead dispatch | Three modes inside a single team-lead agent | "By it to decide" — single decision point, no upstream router |
| Mode 3 spawn tool | Reuse `Task({run_in_background: true})` — no separate `Spawn` tool | Per user request: keep naming aligned with engine (`Task` is engine's name for AgentTool) |
| Teammate fan-out | Forbidden — teammate cannot call `Task` (sync subagent) | Per user decision: prevents protocol depth explosion. `Task` joins `INTERNAL_TEAMMATE_TOOLS` blacklist |
| Sleep | Required in MVP, not deferred | Per user decision: long-lived teammate conversations need it; otherwise BullMQ slots saturate |
| Roles | 3 (lead / member / subagent) | Sufficient; finer granularity goes via `disallowedTools` on individual AgentDefinition |
| Wakeup mechanism | Option D — SendMessage directly enqueues BullMQ; reconcile cron tolerates failures | Cleanest engine-spirit mapping ("SendMessage is wake"); zero new long-lived processes; no double-write inconsistency vs Redis pub/sub |
| Lead lifecycle | Option X — unified `agent-run` queue | Symmetric code path with teammates; lead can Sleep; user input traverses the same `team_messages` mailbox |
| `<r>` tag in XML | Keep verbatim from engine | Prompt quoting matches engine references; future cross-doc compatibility |
| `tick` message type | Reserved (placeholder) | Phase 2+ KAIROS adoption without enum migration |
| `requires` field DSL | Prefix string (`channel:x`, `product:has_description`) | Cleaner than nested object; trivial to parse via `split(':')` |
| Custom AgentDefinition source | Schema declared, not implemented in MVP | Phase 2+ user-defined agents in DB |
| Skills preload site | Multiple `system`-role messages, not concatenation | Each skill is a prefix-cacheable block |

---

## §1 Three-mode dispatch design

The team-lead AGENT.md encodes a hard prompt-level decision tree.
Verbatim text to inline in `agents/coordinator/AGENT.md` (renamed to
`team-lead`):

```
## How to handle this turn

You have THREE execution modes. Choose based on task shape, not on
"which feels easier".

### Mode 1 — Handle directly
Choose when:
- Task is a DB read/update you can do with one of your own tools
  (query_team_status, update_plan_item, ...)
- Task is a clarifying question to the founder
- Task is composing a final summary from results already in your context

DO NOT delegate work you can finish with your own tools in 1-2 calls.

### Mode 2 — Sync subagent (Task tool)
Choose when:
- Task is bounded (< ~30s of work), single-domain, single-output
- You need the result in THIS turn to continue reasoning
- Examples: draft one X reply, judge one opportunity, validate one draft

`Task({subagent_type, prompt})` — you AWAIT the result. The subagent
runs in the same job and returns its final text. Your context gets the
output back synchronously.

### Mode 3 — Async teammate (Task with run_in_background)
Choose when:
- Task spans multiple domains in parallel (research X + research Y +
  drafting + monitoring all at once)
- Task requires worker that may take minutes (cross-channel sweep,
  long content batch)
- You want workers running while YOU continue planning / reviewing
- The work needs back-and-forth between specialists (e.g., post-author
  drafts → critic reviews → author revises)

`Task({subagent_type, prompt, run_in_background: true})` — you
immediately get back an agentId. Teammate runs in its own BullMQ job.
You will receive its result later as a `<task-notification>` user-role
message. You can:
  - SendMessage({to: agentId, content: ...}) to continue that teammate
  - SendMessage({type: 'broadcast', ...}) to ping all teammates
  - TaskStop({task_id: agentId}) to abort

**Workers are async. Parallelism is your superpower.** To launch
teammates in parallel, emit multiple Task tool_use blocks in ONE
assistant message.
```

**Mapping to engine:** mode 1 = direct LLM answer (engine has the same
implicit option); mode 2 = engine's `Task({subagent_type})` sync path;
mode 3 = engine's `Task({...})` async path under coordinator mode (PDF
§3.7.1).

---

## §2 Tool surface + four-layer filter pipeline

### §2.1 Tool inventory

| Tool | Mode | Behavior | Status |
|---|---|---|---|
| `Task` | 2 + 3 | sync await OR async fire-and-forget if `run_in_background:true` | ✏️ extend (existing) |
| `SendMessage` | 3 | discriminated union; DB insert + BullMQ wake | ✏️ extend (existing) |
| `TaskStop` | 3 | BullMQ cancel + shutdown_request mailbox + status='killed' | 🆕 new |
| `Sleep` | teammate-side | persist transcript + delayed BullMQ + release worker | 🆕 new |
| `SyntheticOutput` | system-only | synthesize `<task-notification>` XML on teammate exit | 🆕 new (never in LLM tool list) |
| `TeamCreate` / `TeamDelete` | — | reserved; not implemented in MVP | ⏸ schema only |

### §2.2 Four-layer filter pipeline

Engine PDF §3.5.1 verbatim port:

```
① Global pool       — getAllRegisteredTools() returns every Tool
                      (src/tools/registry.ts)
② Role whitelist    — TEAM_LEAD_ALLOWED_TOOLS / TEAMMATE_ALLOWED_TOOLS /
                      SUBAGENT_ALLOWED_TOOLS
                      (src/tools/AgentTool/role-tools.ts — NEW)
③ Role blacklist    — INTERNAL_TEAMMATE_TOOLS / INTERNAL_SUBAGENT_TOOLS
                      (src/tools/AgentTool/blacklists.ts — NEW)
④ AgentDefinition   — def.tools (allow-list) AND not def.disallowedTools
                      (src/tools/AgentTool/loader.ts)
```

`INTERNAL_TEAMMATE_TOOLS` (architecture-level — same role as engine's
`INTERNAL_WORKER_TOOLS` but adapted to shipflare):

```ts
const INTERNAL_TEAMMATE_TOOLS = new Set([
  TASK_TOOL_NAME,             // teammate cannot fan out via sync subagent
  TASK_STOP_TOOL_NAME,        // teammate cannot stop peers
  TEAM_CREATE_TOOL_NAME,      // reserved (Phase 2+)
  TEAM_DELETE_TOOL_NAME,      // reserved (Phase 2+)
  SYNTHETIC_OUTPUT_TOOL_NAME, // teammate cannot fake completion notifications
])
// teammate STILL has access to: SendMessage, Sleep, Skill, domain tools
// per their AgentDefinition.tools allow-list
```

`INTERNAL_SUBAGENT_TOOLS` (mode-2 sync subagents, deeper nesting):

```ts
const INTERNAL_SUBAGENT_TOOLS = new Set([
  ...INTERNAL_TEAMMATE_TOOLS, // everything teammates can't do
  SEND_MESSAGE_TOOL_NAME,     // sync subagents cannot initiate further coordination
  SLEEP_TOOL_NAME,            // sync subagents must complete in their turn
])
```

### §2.3 Single source of truth: `assembleToolPool`

Engine `assembleToolPool` (engine PDF §3.5.1) — one function used for
both (a) the user-context injection text shown to the team-lead's LLM
("teammates have access to these tools: …") and (b) the actual runtime
filtering when a teammate's `runAgent` boots.

```ts
// src/tools/AgentTool/assemble-tool-pool.ts (NEW)
export function assembleToolPool(
  role: 'lead' | 'member' | 'subagent',
  agentDef: AgentDefinition,
  ctx: PermissionContext,
): Tools {
  const all = getAllRegisteredTools(ctx);
  const whitelist = ROLE_WHITELISTS[role];
  const blacklist = ROLE_BLACKLISTS[role];
  return all
    .filter(t => whitelist.has(t.name))
    .filter(t => !blacklist.has(t.name))
    .filter(t => agentDef.tools === '*' || agentDef.tools.includes(t.name))
    .filter(t => !(agentDef.disallowedTools ?? []).includes(t.name));
}
```

Team-lead user-context injection text (rendered into system prompt of
each lead session):

```ts
const teammateTools = assembleToolPool('member', someTeammateDef, ctx)
  .map(t => t.name).sort().join(', ');
content += `\nTeammates spawned via Task with run_in_background:true ` +
           `have access to: ${teammateTools}`;
```

This is the engine PDF §3.5.1 invariant verbatim: **"the spec text shown
to the LLM is computed from the same constants as the runtime filter,
guaranteeing they cannot drift"**.

### §2.4 Runtime validations beyond the four-layer pipeline

`SendMessage.validateInput` (engine fail-closed pattern):

- `type: 'plan_approval_response'` → caller must have `role: 'lead'`,
  else error 403
- `type: 'broadcast'` → at most 1 per assistant turn (rate limit) per
  engine prompt's "Broadcasting is expensive" warning
- `type: 'task_notification'` and `type: 'tick'` are NOT in the
  user-facing schema — by absence, an LLM cannot fabricate them

---

## §3 Async teammate lifecycle

### §3.1 State machine

```
not_started
  └─ Task({run_in_background:true}) by lead ──▶ queued
                                                 │
                                                 ▼ BullMQ worker picks up
                                              running
                                                ├──── Sleep({ms}) ──▶ sleeping
                                                │                       │
                                                │                       │  wake source:
                                                │                       │   a) BullMQ delay expires
                                                │                       │   b) SendMessage arrives
                                                │                       │      (writes mailbox + enqueues)
                                                │                       │   c) TaskStop signal
                                                │                       ▼
                                                │                    resuming
                                                │                       │  load transcript + drain mailbox
                                                │                       ▼
                                                │                    running (loop continues)
                                                │
                                                ├──── end_turn / StructuredOutput / maxTurns ──▶ completed
                                                ├──── uncaught error ──▶ failed
                                                └──── TaskStop / shutdown_request approved ──▶ killed

  exit transitions (completed / failed / killed):
    SyntheticOutput synthesizes <task-notification> →
    inserts team_messages row to_agent_id=parent (lead) →
    triggers wake of parent
```

### §3.2 Database schema

**New table `agent_runs`** (ID convention matches shipflare's existing
`teamMembers` / `teamRuns` — text-stored UUID via `crypto.randomUUID()`,
NOT Postgres `uuid` type):

```sql
create table agent_runs (
  agent_id          text primary key,                -- $defaultFn crypto.randomUUID()
  team_id           text not null references teams(id),
  member_id         text not null references team_members(id),
  agent_def_name    text not null,
  parent_agent_id   text references agent_runs(agent_id),
  bullmq_job_id     text,
  status            text not null default 'queued' check (status in (
    'queued','running','sleeping','resuming','completed','failed','killed'
  )),
  transcript_id     text,
  spawned_at        timestamptz not null default now(),
  last_active_at    timestamptz not null default now(),
  sleep_until       timestamptz,
  shutdown_reason   text,
  total_tokens      bigint default 0,
  tool_uses         int default 0
);
create index on agent_runs (team_id, status, last_active_at);
create index on agent_runs (sleep_until) where status = 'sleeping';
create index on agent_runs (parent_agent_id);
```

This table covers BOTH the team-lead row and every teammate row (X
model). Lead's `parent_agent_id` is `NULL`.

**Extensions to `team_messages`** (additive — existing `type`,
`fromMemberId`, `toMemberId`, `metadata` columns coexist; new columns
add Agent Teams routing on top):

```sql
alter table team_messages
  -- Agent Teams protocol type (orthogonal to existing `type` column,
  -- which encodes LLM message kind: user_prompt / agent_text /
  -- tool_call / tool_result / etc.). A task_notification row has
  --    type='user_prompt'        ← so the lead's runAgent processes it
  --    message_type='task_notification'  ← Agent Teams routing flag
  add column message_type text not null default 'message' check (message_type in (
    'message','broadcast','shutdown_request','shutdown_response',
    'plan_approval_response','task_notification','tick'
  )),
  -- Run-level routing (additive to the existing fromMemberId / toMemberId
  -- which point at the static team roster). Required because the same
  -- member can have multiple historical agent_runs and Agent Teams must
  -- target the specific run.
  add column from_agent_id text references agent_runs(agent_id),
  add column to_agent_id   text references agent_runs(agent_id),
  add column delivered_at  timestamptz,
  add column summary       text,
  add column replies_to_id text references team_messages(id);

create index on team_messages (to_agent_id, delivered_at)
  where delivered_at is null;
```

### §3.3 Wakeup mechanism — option D

Three independent wake sources, all flowing into the `agent-run` BullMQ
queue:

1. **Sleep expiry**: BullMQ delayed job naturally fires at
   `sleep_until`.
2. **SendMessage delivery**: `SendMessageTool` body writes the
   `team_messages` row, then directly enqueues an `agent-run` job for
   `to_agent_id` (deduped by jobId so already-running teammates don't
   get a redundant enqueue).
3. **TaskStop signal**: `TaskStopTool` writes a `shutdown_request`
   message + enqueues — same path as (2).

Reconciliation cron (`src/workers/cron/reconcile-mailbox.ts`) scans
every minute for orphans:

```sql
select distinct to_agent_id
from team_messages
where delivered_at is null
  and created_at < now() - interval '30 seconds'
```

…and re-enqueues. This catches any best-effort enqueue failures.

### §3.4 BullMQ queue topology

- Single queue: `agent-run`
- One job = one wake-up of one `agent_runs` row
- Job payload: `{ agentId }` (everything else lives in DB)
- Job dedupe key: `agentId:wake-${epoch-bucket-1s}` — tolerates two
  near-simultaneous wakes without duplicate work
- Job concurrency: tuneable per worker; default 4 per Node process
- Job timeout: long (~30 min); a teammate that doesn't `Sleep` and
  exceeds this is treated as `failed`

### §3.5 Mailbox drain — pseudocode

```ts
async function drainMailbox(agentId: string, transcript: Message[]) {
  const batch = await db.transaction(async tx => {
    const rows = await tx.select().from(teamMessages)
      .where(and(
        eq(teamMessages.toAgentId, agentId),
        isNull(teamMessages.deliveredAt),
      ))
      .orderBy(teamMessages.createdAt)
      .for('update');
    if (rows.length === 0) return [];
    await tx.update(teamMessages)
      .set({ deliveredAt: new Date() })
      .where(inArray(teamMessages.id, rows.map(r => r.id)));
    return rows;
  });

  for (const msg of batch) {
    if (msg.message_type === 'tick') continue; // tick is a wake signal only
    transcript.push({
      // Existing column `type` distinguishes user_prompt vs agent_text vs ...;
      // task_notification rows are written with type='user_prompt' so they
      // appear as user-role input to the receiving agent's runAgent loop.
      role: deriveLLMRole(msg.type),
      content: renderForLLM(msg),
    });
  }
  return { injected: batch.length, hasShutdownRequest:
    batch.some(m => m.message_type === 'shutdown_request') };
}
```

**Invariants:**
1. Drain is idempotent (`delivered_at` + `for update` row lock prevents
   double-injection)
2. Drain order is `createdAt` ascending (deterministic across retries)
3. Drain is the ONLY way new messages enter transcript — there is no
   other `transcript.push` path during runtime

---

## §4 SendMessage protocol + `<task-notification>` XML

### §4.1 SendMessage discriminated union

```ts
const SendMessageInputSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('message'),
    to: z.string().describe('agentId or teammate name'),
    content: z.string(),
    summary: z.string().optional(),
  }),
  z.object({
    type: z.literal('broadcast'),
    content: z.string(),
    summary: z.string().optional(),
  }),
  z.object({
    type: z.literal('shutdown_request'),
    to: z.string(),
    content: z.string(),
    summary: z.string().optional(),
  }),
  z.object({
    type: z.literal('shutdown_response'),
    request_id: z.string(),
    approve: z.boolean(),
    content: z.string().optional(),
  }),
  z.object({
    type: z.literal('plan_approval_response'),
    request_id: z.string(),
    to: z.string(),
    approve: z.boolean(),
    content: z.string().optional(),
  }),
]);
```

`task_notification` and `tick` are deliberately absent from this
schema — they are inserted only by `SyntheticOutputTool` and the
hypothetical Phase-2 KAIROS tick scheduler. By absence, an LLM cannot
forge them.

### §4.2 `<task-notification>` XML format (engine verbatim)

```xml
<task-notification>
  <task-id>agent-a1b</task-id>
  <status>completed</status>
  <summary>X reply sweep across r/saas — 5 drafts produced, 1 declined</summary>
  <r>I reviewed 12 mentions and produced replies for 5 of them. Drafts persisted to drafts table with ids: ...</r>
  <usage>
    <total_tokens>14523</total_tokens>
    <tool_uses>23</tool_uses>
    <duration_ms>87200</duration_ms>
  </usage>
</task-notification>
```

**Field semantics (engine-verbatim — required for prompt quoting
compatibility):**

| Tag | Required | Source |
|---|---|---|
| `<task-id>` | ✅ | `agent_runs.agent_id` |
| `<status>` | ✅ | `'completed'` \| `'failed'` \| `'killed'` (only these 3) |
| `<summary>` | ⭕ recommended | last StructuredOutput summary, fallback to first 60 chars of `<r>` |
| `<r>` | ⭕ | teammate's final assistant text. Tag name `<r>` is engine's choice; kept verbatim for cross-document quoting |
| `<usage>` | ⭕ | accumulated from `agent_runs` row |

XML synthesis lives in
`src/workers/processors/lib/synthesize-notification.ts` as the single
helper used at all three exit transitions (completed / failed /
killed). When engine evolves the XML schema, only this file changes.

### §4.3 Insertion shape into `team_messages`

```ts
{
  teamId,
  type: 'user_prompt',                       // existing column — LLM processes as user input
  message_type: 'task_notification',         // new column — Agent Teams routing flag
  fromMemberId: teammate.member_id,          // existing — static roster reference
  toMemberId:  leadMember.id,                // existing
  from_agent_id: teammate.agent_id,          // new — specific run reference
  to_agent_id:   teammate.parent_agent_id,
  content: xmlString,
  summary: `${teammate.member.name} ${status}`,
  delivered_at: null,
}
```

Followed by `wake(teammate.parent_agent_id)` which enqueues an
`agent-run` job for the parent. Engine PDF §9 ②: messages are the
conversation; lead's main loop processes this exactly like any other
user input.

### §4.4 Peer DM visibility

Engine PDF §3.6.1 channel ③: when teammate→teammate `message`, the
**summary** is also posted to the team-lead's mailbox so the lead
"knows peers are talking" without seeing content.

```ts
// In SendMessage post-write hook:
if (msg.type === 'message' && fromRole === 'member' && toRole === 'member') {
  await db.insert(teamMessages).values({
    teamId,
    type: 'user_prompt',                  // LLM-flow type (existing column)
    message_type: 'message',              // Agent Teams routing (new column)
    from_agent_id: SYSTEM_AGENT_ID,
    to_agent_id: leadAgentId,
    content: `<peer-dm from="${fromName}" to="${toName}">${msg.summary}</peer-dm>`,
    delivered_at: null,
    // CRITICAL: do NOT call wake() here — peer DMs must not wake a sleeping lead
  });
}
```

The "do not wake" invariant is what makes this transparency cheap. The
lead sees these shadow records on its NEXT natural wake (task
notification or founder message), not preemptively.

### §4.5 SendMessage rules in team-lead AGENT.md

```
## SendMessage rules

- Refer to teammates by their NAME ('research-author', 'reply-author'),
  never by agentId UUID. The system resolves names → agentIds.
- One broadcast per turn maximum. Default to 'message' (DM).
- Choose continue (SendMessage to existing agentId) vs spawn (Task with
  run_in_background:true) by context overlap:
  · existing teammate already explored this domain → continue
  · domain mismatch / fresh-eyes verification needed → spawn new
  · prior attempt went off the rails → spawn new (avoid anchoring)
- task_notification messages arrive as user-role messages with
  <task-notification> XML. They look like user input; distinguish by
  the opening tag. The agentId in <task-id> is what you use as `to`
  for follow-ups.
- shutdown_request asks a teammate to wrap up gracefully. They can
  respond with shutdown_response approve=false if they need more time.
- plan_approval_response is yours alone — only you can approve plans
  teammates submit for review.
```

(Stored in
`src/tools/AgentTool/agents/coordinator/references/sendmessage-rules.md`
and inlined.)

---

## §5 AgentDefinition full frontmatter

### §5.1 Engine field alignment

| Engine field | Pre-Agent-Teams | Post-Agent-Teams | Note |
|---|---|---|---|
| `name` | ✅ | keep | unique key for `Task({subagent_type})` |
| `description` | ✅ | keep | LLM-facing "when to use me" |
| `tools` | ✅ allow-list | keep + accept `'*'` for all-allow | engine convention |
| `skills` | ✅ | keep + first-spawn preload only (§5.3) | preserved across resume via transcript |
| `model` | ✅ | keep + accept `'inherit'` | inherit = parent's model |
| `maxTurns` | ✅ | keep | runaway-loop circuit breaker |
| `color` | ✅ | keep | UI |
| `references` / `shared-references` | ✅ | keep (shipflare-specific) | inlined into systemPrompt |
| **`disallowedTools`** | ❌ dropped | ✅ **restore** | required for layer-④ filter |
| **`background`** | ❌ dropped | ✅ **restore (semantics rewritten)** | engine: "always async". shipflare: "must be spawned via `Task` with `run_in_background:true` — sync invocations rejected" |
| **`role`** (new field) | — | ✅ **add** | `'lead'` \| `'member'`, primary input to four-layer filter |
| **`requires`** (new field) | — | ✅ **add** | `string[]`, prefix DSL (`channel:x`, `product:has_description`); team-lead's roster injection filters on this |
| `effort` | ❌ dropped | ⏸ keep dropped | shipflare doesn't expose thinking budget per-agent yet |
| `initialPrompt` | ❌ dropped | ⏸ keep dropped | replaced by `references` mechanism |
| `permissionMode` | ❌ dropped | ❌ permanent | server-side, no UI prompts |
| `mcpServers` / `requiredMcpServers` | ❌ dropped | ❌ permanent | shipflare uses native tools |
| `isolation` | ❌ dropped | ❌ permanent | no worktree concept |
| `memory` | ❌ dropped | ❌ permanent | DB is single memory store |
| `omitClaudeMd` | ❌ dropped | ❌ permanent | no CLAUDE.md injection path |
| `hooks` | ❌ dropped | ⏸ Phase 2+ | cross-agent hook framework not justified yet |

### §5.2 Source priority

```ts
// Aligns with engine's getActiveAgentsFromList() priority order
export type AgentDefinition =
  | BuiltInAgentDefinition    // src/tools/AgentTool/agents/<name>/AGENT.md
  | CustomAgentDefinition;    // user-defined in DB (Phase 2+, schema only in MVP)
```

Override order (later overrides earlier): `built-in → custom`. Engine's
plugin / policy / flag levels are deferred.

### §5.3 Skills preload — lifecycle integration

Per engine, `skills: [name1, name2]` preloads each skill's SKILL.md body
into the agent's initial conversation as `system`-role messages.

In Agent Teams' multi-resume lifecycle, **preload only happens once**,
when an `agent_runs` row transitions `queued → running` for the first
time. Resumes load the persisted transcript (which already contains the
preloaded skills).

```ts
async function startAgentRun(agentId: string) {
  const row = await loadAgentRun(agentId);
  const def = await resolveAgentDefinition(row.agentDefName);

  let transcript: Message[];
  if (row.transcriptId === null) {
    // First spawn — preload skills
    const skills = await Promise.all(
      def.skills.map(name => loadSkillContent(name))
    );
    transcript = [
      { role: 'system', content: def.systemPrompt },
      ...skills.map(s => ({
        role: 'system' as const,
        content: `<skill-preload name="${s.name}">${s.body}</skill-preload>`,
      })),
    ];
    await persistTranscript(agentId, transcript);
  } else {
    transcript = await loadTranscript(row.transcriptId);
  }

  await drainMailbox(agentId, transcript);
  await runAgent({
    transcript,
    tools: assembleToolPool(def.role, def, ctx),
    ...,
  });
}
```

### §5.4 `requires` — teammate visibility gating

Each AGENT.md may declare prerequisites:

```yaml
---
name: x-reply-author
description: Drafts replies to X mentions
role: member
requires:
  - channel:x
  - product:has_description
tools:
  - x_get_tweet
  - x_post
  - SendMessage
  - Sleep
  - Skill
---
```

The dynamic team-roster injection (rendered into team-lead's system
prompt) filters teammates whose `requires` are not satisfied for the
current team / product. The team-lead **never sees** unavailable
teammates — preventing it from attempting a `Task` that will fail.

DSL:
- `channel:<id>` → check `channels` table for `userId + platform=id`
- `product:has_description` → check `products.description IS NOT NULL`
- additional `requires` predicates added per-need; resolution is in
  `src/tools/AgentTool/requires-resolver.ts` (NEW)

### §5.5 Final AgentDefinition type

```ts
interface BaseAgentDefinition {
  source: 'built-in' | 'custom';
  name: string;
  description: string;
  role: 'lead' | 'member';
  tools: string[] | '*';
  disallowedTools: string[];
  skills: string[];
  requires: string[];
  background: boolean;
  model?: string | 'inherit';
  maxTurns: number;
  color?: string;
  systemPrompt: string;
  references: string[];
  'shared-references': string[];
}

export interface BuiltInAgentDefinition extends BaseAgentDefinition {
  source: 'built-in';
  sourcePath: string;
}

export interface CustomAgentDefinition extends BaseAgentDefinition {
  source: 'custom';
  ownerId: string;
  storedAt: 'db';
}

export type AgentDefinition = BuiltInAgentDefinition | CustomAgentDefinition;
```

---

## §6 Phase plan A → G

```
Phase A — Foundation (no behavior change)
   │ four-layer filter, assembleToolPool, AgentDefinition restore, role tagging
   │
   ├─▶ Phase B — Async lifecycle (flag-gated)
   │     │ agent-run queue, agent_runs table, SyntheticOutput, Task async path
   │     │
   │     ├─▶ Phase C — SendMessage protocol
   │     │     │ discriminated union, TaskStop, task_notification, peer-DM shadow
   │     │     │
   │     │     └─▶ Phase D — Sleep + Resume
   │     │           │ Sleep tool, delayed BullMQ, transcript resume
   │     │           │
   │     │           └─▶ Phase E — team-lead unification (X driver)
   │     │                 │ team-run merged into agent-run; user msgs via team_messages
   │     │                 │
   │     │                 └─▶ Phase F — team-lead AGENT.md three-mode rewrite
   │     │                       │
   │     │                       └─▶ Phase G — Drop flag, retire legacy, document
```

### Phase A — Foundation (1–2 weeks)

**Goal:** transplant the four-layer filter invariant. Zero behavior
change to existing flows.

| Path | Change | Note |
|---|---|---|
| `src/tools/AgentTool/role-tools.ts` | 🆕 | `ROLE_WHITELISTS` / `ROLE_BLACKLISTS` for lead/member/subagent |
| `src/tools/AgentTool/blacklists.ts` | 🆕 | `INTERNAL_TEAMMATE_TOOLS` / `INTERNAL_SUBAGENT_TOOLS` constants |
| `src/tools/AgentTool/assemble-tool-pool.ts` | 🆕 | SSOT function used by both prompt-text injection and runtime filtering |
| `src/tools/AgentTool/loader.ts` | ✏️ | restore `disallowedTools` + `background`; add `role` + `requires`; update `DROPPED_FIELDS` comment |
| `src/tools/AgentTool/agent-schemas.ts` | ✏️ | discriminated union (`BuiltInAgentDefinition` / `CustomAgentDefinition`) |
| `src/tools/AgentTool/spawn.ts` | ✏️ | `resolveAgentTools` delegates to `assembleToolPool` |
| `src/tools/AgentTool/requires-resolver.ts` | 🆕 | check `channel:x` / `product:has_description` / etc. |
| `src/tools/AgentTool/agents/coordinator/AGENT.md` | ✏️ | add `role: lead` |
| `src/tools/AgentTool/agents/content-manager/AGENT.md` | ✏️ | add `role: member` |
| `src/tools/AgentTool/agents/content-planner/AGENT.md` | ✏️ | add `role: member` |
| `src/tools/AgentTool/agents/discovery-agent/AGENT.md` | ✏️ | add `role: member` + `requires:` |
| `src/tools/AgentTool/__tests__/four-layer-filter.test.ts` | 🆕 | given role + def → expected tool set |
| `src/tools/AgentTool/__tests__/assemble-tool-pool.test.ts` | 🆕 | text injection ≡ runtime filter equality assertion |
| `src/tools/AgentTool/__tests__/loader-restore-fields.test.ts` | 🆕 | `disallowedTools` / `background` / `role` / `requires` parse correctly |

**Verification gate:** `pnpm tsc --noEmit` clean; existing `team-run`
end-to-end test green; new four-layer filter unit tests green.

### Phase B — Async lifecycle (2–3 weeks; flag-gated)

**Goal:** mode 3 async `Task` works end-to-end. Teammate runs to
completion in one job. No SendMessage / Sleep yet.

**DB migrations:**
- `migrations/NNNN_agent_runs.sql` — new table
- `migrations/NNNN_team_messages_extend.sql` — add `message_type`,
  `from_agent_id`, `to_agent_id`, `delivered_at`, `summary`,
  `replies_to_id` columns + indexes

**Files:**

| Path | Change | Note |
|---|---|---|
| `src/lib/db/schema/team.ts` | ✏️ | `agentRuns` definition, `teamMessages` new columns |
| `src/lib/db/schema/index.ts` | ✏️ | export `agentRuns` |
| `src/workers/queues.ts` | ✏️ | register `agent-run` BullMQ queue |
| `src/workers/processors/agent-run.ts` | 🆕 | first-spawn / completed lifecycle (no Sleep yet) |
| `src/workers/processors/lib/mailbox-drain.ts` | 🆕 | shared helper |
| `src/workers/processors/lib/synthesize-notification.ts` | 🆕 | XML synthesis on exit |
| `src/workers/processors/lib/wake.ts` | 🆕 | enqueue dedupe by jobId |
| `src/tools/SyntheticOutputTool/SyntheticOutputTool.ts` | 🆕 | system-only Tool (`isEnabled() → false`) |
| `src/tools/AgentTool/AgentTool.ts` | ✏️ | extend schema with `run_in_background?: boolean`; async branch returns `{agentId, status: 'async_launched'}` |
| `src/tools/registry.ts` | ✏️ | register SyntheticOutputTool (not in any whitelist) |
| `src/lib/feature-flags/agent-teams.ts` | 🆕 | `isAgentTeamsEnabledForTeam(teamId)` — env + DB |
| `src/workers/cron/reconcile-mailbox.ts` | 🆕 | every-minute orphan re-enqueue |
| `src/workers/processors/__tests__/agent-run.test.ts` | 🆕 | state machine tests |
| `src/workers/processors/lib/__tests__/mailbox-drain.test.ts` | 🆕 | idempotency, ordering |

**Verification gate:** under flag-on, lead `Task({...,
run_in_background:true})` returns agentId immediately; teammate runs in
separate BullMQ job; on completion `<task-notification>` lands in
`team_messages` with `to_agent_id=lead.agentId`; lead's next idle drain
injects it. Flag-off: zero observable change.

### Phase C — SendMessage protocol (1–2 weeks)

**Goal:** P2P, broadcast, shutdown. peer-DM visibility works.

| Path | Change | Note |
|---|---|---|
| `src/tools/SendMessageTool/SendMessageTool.ts` | ✏️ | rewrite schema as 5-variant discriminated union |
| `src/tools/SendMessageTool/validate.ts` | 🆕 | `plan_approval_response` lead-only; broadcast 1/turn |
| `src/tools/TaskStopTool/TaskStopTool.ts` | 🆕 | BullMQ cancel + shutdown_request mailbox + status='killed' |
| `src/workers/processors/lib/peer-dm-shadow.ts` | 🆕 | summary-only shadow to lead, no wake |
| `src/workers/processors/agent-run.ts` | ✏️ | drain hook between idle turns; shutdown_request → graceful exit |
| `src/tools/registry.ts` | ✏️ | register TaskStopTool |
| `src/tools/AgentTool/role-tools.ts` | ✏️ | TaskStop in `INTERNAL_TEAMMATE_TOOLS`; SendMessage allowed for lead+member |
| `src/tools/SendMessageTool/__tests__/discriminated-union.test.ts` | 🆕 | per-variant validity + permission rejection |
| `src/tools/TaskStopTool/__tests__/abort-flow.test.ts` | 🆕 | killed → SyntheticOutput → lead mailbox |
| `src/workers/processors/__tests__/peer-dm.test.ts` | 🆕 | shadow does NOT trigger enqueue |

**Verification gate:** lead `Task` two teammates A and B; A messages B
via SendMessage; B replies; lead drain sees peer-DM shadow with
summary only. Lead `TaskStop(A)` → A receives shutdown_request → A
graceful exits → lead receives `<task-notification status="killed">`.

### Phase D — Sleep + Resume (1–2 weeks)

**Goal:** teammate can yield BullMQ slot; wakes on message arrival or
sleep expiry; transcript persists across cycles.

| Path | Change | Note |
|---|---|---|
| `src/tools/SleepTool/SleepTool.ts` | 🆕 | `persistTranscript + scheduleResume(BullMQ delayed) + markSleeping + early return` |
| `src/workers/processors/agent-run.ts` | ✏️ | Sleep tool special return path: exit runAgent loop, NO SyntheticOutput |
| `src/workers/processors/lib/transcript-persist.ts` | 🆕 | wraps existing `team-run` transcript persistence (per "reuse this mechanism" decision) |
| `src/tools/SendMessageTool/SendMessageTool.ts` | ✏️ | post-write call to `wake(toAgentId)` |
| `src/tools/SleepTool/__tests__/wake-roundtrip.test.ts` | 🆕 | sleep → external SendMessage → resume → drain → continue |
| `src/tools/AgentTool/role-tools.ts` | ✏️ | Sleep allowed for lead + member |

**Verification gate:** teammate Sleep(30min); BullMQ slot released;
external SendMessage at +5min wakes teammate immediately; transcript
contains the entire history including the pre-Sleep portion. Teammate
Sleep(3s); naturally wakes; no mailbox messages → calls Sleep again.

### Phase E — team-lead driver unification (2–3 weeks; HIGH RISK)

**Goal:** delete `team-run.ts`. Lead runs through `agent-run` queue.
User input via `team_messages`.

This phase is pure refactor but touches the most existing code. Strong
recommendation: dual-track for one week (legacy `team-run` + new
unified path coexist behind flag), validated, then cut.

| Path | Change | Note |
|---|---|---|
| `src/app/api/team/run/route.ts` | ✏️ | no longer enqueues `team-run`. Insert `team_messages` row (user input → `to_agent_id=lead`) + call `wake(leadAgentId)` |
| `src/workers/processors/team-run.ts` | ➖ delete (Phase G) | logic now in agent-run.ts |
| `src/workers/processors/agent-run.ts` | ✏️ | lead-specific cancellation listener (mailbox shutdown_request to lead); user-injection achieved via mailbox drain (no special hook) |
| `src/lib/team/spawn-lead.ts` | 🆕 | factory: on team creation, insert `agent_runs` row (role=lead, status=sleeping) — wakes on first user message |
| `src/workers/processors/__tests__/lead-via-agent-run.test.ts` | 🆕 | end-to-end: founder UI sends → DB insert → wake → lead drain → process → end_turn → sleep |

**Rollout plan:**
- Week 1: dogfooding team flips to unified
- Week 2: 5 alpha users
- Week 3: 50%
- Week 4: 100% — schedule legacy deletion for Phase G

### Phase F — team-lead AGENT.md three-mode rewrite (< 1 week)

| Path | Change | Note |
|---|---|---|
| `src/tools/AgentTool/agents/coordinator/AGENT.md` | ✏️ | rename to `team-lead` (alias `coordinator` retained); add §1 three-mode tree; add §4.5 SendMessage rules; add continue-vs-spawn table |
| `src/tools/AgentTool/agents/coordinator/references/three-mode-decision.md` | 🆕 | content of §1 — extracted to keep AGENT.md readable |
| `src/tools/AgentTool/agents/coordinator/references/continue-vs-spawn.md` | 🆕 | engine PDF §3.7.2 ported |
| `src/tools/AgentTool/agents/coordinator/references/sendmessage-rules.md` | 🆕 | §4.5 |
| `src/tools/AgentTool/agents/coordinator/__tests__/prompt-snapshot.test.ts` | ✏️ | regenerate snapshot |

### Phase G — Cleanup, retire legacy, documentation (< 1 week)

- Drop `SHIPFLARE_AGENT_TEAMS` env flag and DB flag
- Delete `src/workers/processors/team-run.ts`
- Delete `getTeamRouteMode` legacy branch
- Update `CLAUDE.md` with "Agent Teams Architecture" section codifying
  cross-phase invariants below
- Update this spec with Phase A–G landed timestamps

---

## Cross-phase invariants (enforce at code review)

1. **`delivered_at` is the only idempotency key for `team_messages`
   processing.** Any in-memory dedup is a bug.
2. **"Is teammate X awake" queries `agent_runs.status` only.** BullMQ
   job state is implementation detail; never leaks into business
   logic.
3. **`assembleToolPool` is the single source of truth for tool
   visibility.** Any `if (role === ...)` outside this function is a
   review reject.
4. **`SyntheticOutputTool.isEnabled()` returns false for any LLM-facing
   caller.** Double-defended: not in any role whitelist AND
   isEnabled-gated. Adding it to a whitelist is a review reject.
5. **`agent_runs.role` is immutable.** To switch role, delete + spawn
   new row.
6. **`<task-notification>` XML construction has exactly one
   implementation site** (`synthesize-notification.ts`).
7. **Teammate cannot fan out via Task.** Enforced at layer ③ via
   `INTERNAL_TEAMMATE_TOOLS`. Removing `TASK_TOOL_NAME` from this set
   is a review reject.
8. **Peer DM shadows do not call `wake()`.** Enforced in
   `peer-dm-shadow.ts` — review must verify no `wake` call in this
   file.

---

## Open questions / future work

1. **Hooks framework** (engine `hooks` field): cross-agent
   PreToolUse / PostToolUse / Stop hooks. Useful for verification
   nudges (engine PDF §5.5: "Hook is the mechanism that promotes
   prompt soft-constraints to code hard-constraints"). Phase 2+.
2. **`TeamCreate` / `TeamDelete` as LLM tools**: dynamic sub-team
   creation by lead. Schema fields exist; tools deferred to Phase 2+.
3. **Custom AgentDefinition source** (engine `CustomAgentDefinition`):
   user-defined agents stored in DB. Phase 2+; schema declared in
   Phase A.
4. **Layer 3 (KAIROS / autoDream / ULTRAPLAN)**: `tick` message type
   reserved for KAIROS-style proactive scheduling. autoDream-style
   nightly memory consolidation has a natural shipflare analog
   (cron-driven memory rollup). ULTRAPLAN's CCR depends on Anthropic
   infrastructure not available to us.
5. **`effort` field**: per-agent extended-thinking budget. Currently
   shipflare uses model defaults; restore if economics change.

---

## Sizing

| Phase | Estimate | Risk |
|---|---|---|
| A | 1–2 weeks | low (no behavior change) |
| B | 2–3 weeks | medium (new BullMQ path needs e2e coverage) |
| C | 1–2 weeks | low–medium |
| D | 1–2 weeks | medium (Sleep + Resume edge cases) |
| E | 2–3 weeks | **high** (cutover with 4-week graduated rollout) |
| F | < 1 week | low |
| G | < 1 week | low |
| **Total** | **8–12 weeks** | — |

---

## Implementation status

- **Phase A — Foundation:** landed `2026-05-02` on `dev`. All four-layer filter
  infrastructure in place; behavior unchanged in production (coordinator
  retains Task as `role: lead`; member agents already didn't declare Task
  so the new INTERNAL_TEAMMATE_TOOLS blacklist is a no-op for them).
  - Task 1 — disallowedTools restored: `74ea534`
  - Task 2 — background restored: `a3ae9ec`
  - Task 3 — role added: `7096986`
  - Task 4 — requires added: `20f628c`
  - Task 5 — discriminated union: `cd9ebc1`
  - Task 6 — getAllToolNames: `727f399`
  - Task 7 — role-tools.ts: `09130cf`
  - Task 8 — blacklists.ts: `026a5d7`
  - Task 9 — requires-resolver.ts: `3a96edf`
  - Task 10 — assemble-tool-pool.ts: `823265a` (+ I-1/I-2 fix `b7a444d`)
  - Task 11 — spawn refactor: `f1d71f8`
  - Task 12 — AGENT.md role tagging: `de0ccb7`
  - Task 13 — verification gate: `6d19c1b`
- **Phase B — Async lifecycle:** landed `2026-05-02` on `dev`. Task tool's
  `run_in_background:true` opt-in async path works end-to-end behind
  `SHIPFLARE_AGENT_TEAMS=1`. Async teammates run in dedicated agent-run
  BullMQ jobs; on exit they synthesize <task-notification> XML inserted with
  toAgentId=null; team-run lead polls the drain queue every 1s and injects
  notifications into its transcript at the next idle turn. Lead-side mailbox
  routing is a Phase B kludge (toAgentId IS NULL filter) — Phase E will
  replace with proper agent_runs routing when the lead also runs as an
  agent_runs row.
  - Task 1 — schema additions: `1d147b8`
  - Task 2 — drizzle migration: `da9df98`
  - Task 3 — feature flag: `d9446b3`
  - Task 4 — wake helper: `e80da86`
  - Task 5 — mailbox-drain helper: `2e31b62`
  - Task 6 — synthesize-notification: `c1278c3`
  - Task 7 — agent-run queue helper: `cf9e009` (done out of order, after Task 4 to resolve forward dep)
  - Task 8 — SyntheticOutputTool: `9ad9cb9`
  - Task 9 — agent-run processor: `1c25968`
  - Task 10 — register agent-run worker: `2aed674`
  - Task 11 — Task tool async branch: `9844311`
  - Task 12 — team-run drain hook: `4933254`
  - Mid-phase fix — agent-run always inserts notification: `3b262e9`
  - Task 13 — reconcile-mailbox cron: `f2e9bb7`
  - Task 14 — verification gate: `d032e5b`
- **Phase C — SendMessage protocol:** landed `2026-05-02` on `dev`. SendMessageTool
  is now a 5-variant discriminated union (message / broadcast / shutdown_request /
  shutdown_response / plan_approval_response) with backward-compat preprocessor
  for the legacy {to, message} shape. Runtime validation: plan_approval_response
  is lead-only (403); broadcast is rate-limited to 1 per 5 seconds (429).
  TaskStop tool added (lead-only; writes shutdown_request + kills agent_runs row +
  wakes target). Peer-DM-shadow helper inserts visibility shadow to lead's
  mailbox WITHOUT calling wake (engine PDF §3.6.1 invariant). Agent-run processor
  drains mailbox at idle turns (1s polling + injectMessages); shutdown_request
  triggers graceful exit with status='killed' notification.
  - Task 1 — discriminated union schema: `75f7fff`
  - Task 2 — execute() variant dispatch: `191a629`
  - Task 3 — runtime validation: `2b4defd`
  - Task 4 — peer-dm-shadow helper: `ac7bb3c`
  - Task 5 — SendMessage wires peer-DM shadow: `9b87068`
  - Task 6 — TaskStop tool: `4742ce1`
  - Task 7 — agent-run drain + shutdown handler: `7d7e1e0`
  - Task 8 — verification gate: `fa07936`
