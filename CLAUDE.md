# ShipFlare

## Skill routing

When the user's request matches an available skill, ALWAYS invoke it using the Skill
tool as your FIRST action. Do NOT answer directly, do NOT use other tools first.
The skill has specialized workflows that produce better results than ad-hoc answers.

Key routing rules:
- Product ideas, "is this worth building", brainstorming → invoke office-hours
- Bugs, errors, "why is this broken", 500 errors → invoke investigate
- Ship, deploy, push, create PR → invoke ship
- QA, test the site, find bugs → invoke qa
- Code review, check my diff → invoke review
- Update docs after shipping → invoke document-release
- Weekly retro → invoke retro
- Design system, brand → invoke design-consultation
- Visual audit, design polish → invoke design-review
- Architecture review → invoke plan-eng-review
- Save progress, checkpoint, resume → invoke checkpoint
- Code quality, health check → invoke health

## Architecture Rules

### Platform-Agnostic Design

1. **No hardcoded platform defaults in processors or routes.**
   Import from `src/lib/platform-config.ts`. Adding a new platform = one entry there.

2. **Reference injection over agent hardcoding.**
   Platform-specific behavior belongs in skill `references/` files, not hardcoded in agent .md
   system prompts. The `draft-single-post` skill is the reference design: generic
   drafting prompt in SKILL.md, platform-specific rules in
   `references/x-content-guide.md` (and one-per-platform as we add them).

3. **Shared references in `src/references/`**, skill-specific in `src/skills/{name}/references/`.
   If 2+ skills use the same doc, move it to shared. Declare via `shared-references` in SKILL.md.

4. **Tools are namespaced by platform** (`reddit_search`, `x_post`), but agents declare tools
   via SKILL.md `allowed-tools`, not in their system prompt text.

5. **Client instantiation via the three sanctioned helpers** in `src/lib/platform-deps.ts`:
   - `createPlatformDeps(platform, userId)` — look up channel by userId, return deps Record
     for `runSkill({ deps })` in workers (discovery, content, posting, etc.).
   - `createClientFromChannel(platform, channel)` — wrap an already-loaded channel row
     into a client. Use this when the job carries `channelId` (e.g. `posting.ts`).
   - `createPublicPlatformDeps(platforms?)` — anonymous / read-only deps for public endpoints
     (`/api/scan`, CLI scripts). Respects `supportsAnonymousRead` + `envGuard` on each config.

   Processors and routes MUST NOT call `XClient.fromChannel` / `RedditClient.fromChannel`
   / `RedditClient.appOnly()` / `new XAIClient()` directly — route through these helpers so
   adding a new platform is one entry in `platform-deps.ts`, not a search-and-replace.

6. **Derive platform-shaped values from `PLATFORMS[id]`.** Use `displayName` for UI copy,
   `sourcePrefix` for labels (`r/`), `buildContentUrl()` for share links,
   `externalIdPattern` (legacy) only when a record lacks an explicit `platform` column —
   prefer joining `threads.platform` / `posts.platform`. Literal `'reddit'` / `'x'` strings
   in processors, routes, and pipelines should reference `PLATFORMS.reddit.id` /
   `PLATFORMS.x.id` so grep-and-replace during rename works and typos surface at compile time.

### New Platform Checklist

When adding a new channel (e.g., LinkedIn):
- [ ] Add entry to `src/lib/platform-config.ts` (including `buildContentUrl`, `supportsAnonymousRead`, etc.)
- [ ] Create platform tools in `src/tools/` (e.g., `linkedin-search.ts`, `linkedin-post.ts`)
- [ ] Register tools in `src/tools/registry.ts`
- [ ] Add platform case to `generate_queries` strategy map
- [ ] Add cases to `createPlatformDeps()`, `createClientFromChannel()`, and
      `createPublicPlatformDeps()` in `src/lib/platform-deps.ts`
- [ ] Create reference docs for relevant skills (`*-search-guide.md`, `*-content-guide.md`, etc.)
- [ ] If the skill fans out across platforms, add the new id to the `channels`
      array in its `src/skills/_catalog.ts` entry so the tactical planner
      selects it for plan items with `channel: '<new>'`.
- [ ] Update `allowed-tools` in relevant SKILL.md frontmatters
- [ ] NO changes needed to: skill-runner, swarm, query-loop, schemas, core agent .md files,
      `full-scan.ts`, `discovery.ts`, `posting.ts`, or `/api/automation/run`

### Skill Pattern (Reference Design)

v3 uses atomic skills — one skill per concrete action (draft one post,
draft one reply, judge one opportunity, etc.). `src/skills/_catalog.ts` is
the source of truth for what ships; each entry declares `supportedKinds`
and optional `channels` so the tactical planner can pick the right tool.

The shipped content-drafting skills are the reference design for adding
new channels:
- `src/skills/draft-single-post/SKILL.md` — generic post-drafting prompt
- `src/skills/draft-single-post/references/x-content-guide.md` —
  X-specific length/tone rules
- `src/skills/draft-single-reply/SKILL.md` + the matching reference
- `src/references/platforms/x-strategy.md` — strategy doc shared across
  skills via `shared-references` in SKILL.md frontmatter

The planning skills (`strategic-planner`, `tactical-planner`) are
single-pass and don't fan out by platform — they receive `channels: []`
in their input and emit a plan whose items each carry a `channel` field
that the caller routes to the right draft-* skill.

Caller (the plan-execute worker) selects which skill to invoke based on
`planItems.skillName` + `planItems.channel`, and which references to
inject. No central "content-batch" orchestrator — each plan_item runs
one atomic skill.

### What NOT to Do

- Don't create parallel platform-specific processors (`reddit-discovery.ts` + `x-discovery.ts`).
  Use one processor with `createPlatformDeps()` routing.
- Don't duplicate reference docs across skills. Use `shared-references`.
- Don't hardcode subreddit/topic lists. Use `platform-config.ts`.
- Don't add platform checks (`if platform === 'x'`) to `skill-runner.ts` or `swarm.ts`.
  Platform awareness belongs in tools, references, and `platform-deps.ts`.
- Don't sniff platform from `externalId` shape (e.g. `/^\d+$/.test(externalId)`).
  `posts.platform` and `threads.platform` are NOT NULL — filter / join on them instead.
  The `PlatformConfig.externalIdPattern` field only exists for legacy records that predate
  the `platform` column; new code must not depend on it.

## Skill Primitive

ShipFlare's multi-agent system has three primitives: **Tool**, **Agent**, **Skill**.
Skills live under `src/skills/<name>/SKILL.md`. The Skill primitive was restored in
Phase 1 of the architecture refactor (see
`docs/superpowers/specs/2026-04-30-skill-primitive-restoration-design.md`).

### Adding a new markdown skill

1. Create `src/skills/<gerund-name>/SKILL.md` (gerund preferred, e.g.
   `drafting-encouraging-replies`).
2. Required frontmatter: `name`, `description`. Optional: `context`
   (`inline` | `fork`), `allowed-tools`, `model`, `maxTurns`,
   `when-to-use`, `argument-hint`, `paths`. **YAML parser note:** the
   frontmatter parser does NOT accept inline `[]` empty arrays — write
   `allowed-tools:` (empty value) rather than `allowed-tools: []`.
3. Body uses `$ARGUMENTS` or `$0` / `$1` for arg substitution. Long
   reference content goes under `references/<name>.md` and is linked
   from the body — Claude reads them progressively, on demand.
4. Add a per-skill `__tests__/<name>.test.ts` mirroring
   `src/skills/_demo-echo-inline/__tests__/_demo-echo-inline.test.ts`.

### Adding a new bundled (TS) skill

Programmatic skills live in `src/skills/_bundled/<name>.ts` and call
`registerBundledSkill({ ... })` at module load. The `src/skills/_bundled/index.ts`
barrel must `import './<name>'` so the side-effect runs.

### Letting an agent invoke skills

Add `skill` to the agent's `AGENT.md` `tools:` list. Optionally declare
`skills: [name1, name2]` to preload specific skills' content into the
agent's initial conversation (useful for agents that always need the
same playbook).

## Primitive Boundaries — Tool / Skill / Agent

ShipFlare's multi-agent system has three primitives. The boundary
between them is enforced by the rules below — code review should
reject violations. Full rationale and the agent-by-agent migration
plan live in `docs/superpowers/specs/2026-05-01-agent-skill-tool-decomposition-design.md`.

### Decision rule

When adding new functionality, answer two questions:

1. **Does this require LLM judgment?**
   - No → **Tool** (deterministic function, regex, DB write, API
     call, or thin LLM wrapper that carries no business rules).
2. **Does this require cross-turn decisions, branching based on
   prior turns, SendMessage, or spawning sub-agents?**
   - No → **Skill** (single fork call, rules in markdown references).
   - Yes → **Agent** (multi-turn loop, orchestration only).

A multi-turn agent is justified only when the loop itself is the
work — conversational refinement, goal decomposition, cross-channel
allocation with feedback signals. "A 12-turn agent that writes one
artifact" is a skill in agent clothing; convert it.

### Hard rules

1. **AGENT.md contains no embedded business rules.** No banned
   vocabulary lists, voice descriptions, slop pattern enumerations,
   or "the real X is Y is forbidden" prose. AGENT.md answers
   "*how do I orchestrate?*", not "*what is good content?*". All
   rules live in `src/skills/<name>/references/*.md` or as regex in
   tools.

2. **Each rule has exactly one owner.** A given pattern lives in
   exactly one place — one skill reference, or one tool's regex.
   Cross-references between docs are fine; copies are not. Before
   adding a rule, grep for prior art and extend the existing owner.

3. **Drafting and validating run in different fork calls.** The
   skill that drafts content does not produce the final pass/fail
   verdict on that same content. The orchestrating agent (or the
   review worker for post-persistence) invokes a separate
   `validating-*` skill in a fresh fork. REVISE retry loops belong
   to the agent, not the drafting skill.

### Per-artifact cost ceiling

Counted in fork-skill calls; the orchestrating agent's own loop
turns are amortized across artifacts in a sweep.

- **Default: 3 fork-skill calls** (judging + drafting + validating).
  The judging skill may short-circuit "skip"; the per-artifact cost
  collapses to 1 in that case.
- **Max with one REVISE retry: 5 fork-skill calls.**
- Pipelines without a gating skill (e.g. `drafting-post` for an
  already-allocated plan_item) use 2 default / 4 with REVISE.
- More retries are not allowed; tighten the drafting skill's rules
  instead.

Sweeps that produce multiple artifacts multiply per artifact.

### When in doubt, default to skill

If you are considering adding a new agent: first ask whether 1
existing agent + 1-2 new skills could express the same work. The
default answer is yes.

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

### Founder UI mental model

The team-lead is **always present** as a sleeping `agent_runs` row. Founders
don't "start runs" — they send messages to the lead. Each message wakes
the lead; the lead processes (potentially spawning parallel teammates),
replies, and goes back to sleep.

UI implications:
- The "Start a run" CTA is replaced with "Send a message"
- The lead's status pill is always visible (sleeping/running/resuming)
- Teammates appear in the roster sidebar when spawned, disappear when terminal
- Activity feed shows cross-agent events (peer-DM, status changes, completions)
- Cancel = SendMessage with type='shutdown_request' (eventually consistent;
  takes seconds to propagate, not synchronous)
- Per-teammate cancel button POSTs to /api/team/agent/[agentId]/cancel
  (lead-only restriction is enforced separately by SendMessage's runtime
  validation when the cancel comes from inside an agent context)

## Security TODO

Tracking pending security hardening beyond what `feat/security-hardening` already shipped.

- **`accounts.access_token` / `accounts.refresh_token` encryption — DONE (approach a).**
  The `accounts` table (Auth.js Drizzle adapter, `src/lib/db/schema/users.ts`) stores
  GitHub OAuth tokens envelope-encrypted via the wrapped DrizzleAdapter in
  `src/lib/auth/index.ts`. Encrypt/decrypt helpers live in
  `src/lib/auth/account-encryption.ts`; reads outside the adapter use
  `maybeDecrypt` (via `getGitHubToken`) so legacy plaintext rows keep working
  until backfilled by `scripts/encrypt-account-tokens.ts --commit`. Run that
  script once per environment after deploy. `DELETE /api/account` also now
  calls GitHub's `DELETE /applications/{client_id}/grant` before DB cascade so
  re-signing-in after deletion re-prompts consent instead of silently relinking.
- **Only the three helpers in `src/lib/platform-deps.ts` (`createPlatformDeps`,
  `createClientFromChannel`, `createPublicPlatformDeps`) plus `RedditClient.fromChannel`
  / `XClient.fromChannel` / `RedditClient.appOnly` are allowed to read
  `channels.oauth_token_encrypted`.** Every other `select().from(channels)` in
  `src/app/api/**` and `src/workers/**` MUST use an explicit projection
  (`select({ id, userId, platform, username, ... })`) and omit token columns.
  Enforced by audit Theme 4 item 3. `createPublicPlatformDeps` is the exception that
  proves the rule: it never touches the `channels` table because it runs before any
  user has connected a channel.
