# Agent Teams — Phase F: Team-Lead Prompt Rewrite Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rewrite the coordinator (team-lead) AGENT.md to teach the LLM the three execution modes (handle directly / sync subagent / async teammate via `Task({run_in_background:true})`), the SendMessage variant rules, and the continue-vs-spawn decision logic. Reference docs extracted under `coordinator/references/` for maintainability.

**Architecture:** Add 3 new reference docs under `src/tools/AgentTool/agents/coordinator/references/`; declare them in the AGENT.md `references:` frontmatter so the loader inlines them into the systemPrompt at agent-run time. Regenerate any prompt-snapshot test. NO production agent-run code changes — pure prompt-engineering. The actual rename `coordinator` → `team-lead` (with alias) is **deferred to Phase G** because it requires cascading changes to DB rows + many code constants — Phase F focuses purely on the LLM-facing prompt content.

**Tech Stack:** Markdown (no code).

**Spec reference:** `docs/superpowers/specs/2026-05-02-agent-teams-architecture-design.md` § Phase F + §1 (three-mode tree) + §4.5 (SendMessage rules).

**Phase F non-goals**:
- The rename `coordinator` → `team-lead` (deferred to Phase G — touches DB schema, agent registry, fixture AGENT.md files)
- Any tool-side changes (Task / SendMessage / TaskStop / Sleep all final from earlier phases)
- AgentDefinition `aliases` mechanism (would be needed for the rename) — deferred

---

## File structure

**New files (3):**

| Path | Responsibility |
|---|---|
| `src/tools/AgentTool/agents/coordinator/references/three-mode-decision.md` | Per spec §1: the three execution modes (1: handle directly / 2: sync subagent / 3: async teammate). Verbatim from spec. |
| `src/tools/AgentTool/agents/coordinator/references/continue-vs-spawn.md` | Per engine PDF §3.7.2: when to SendMessage to existing agentId vs spawn new via Task |
| `src/tools/AgentTool/agents/coordinator/references/sendmessage-rules.md` | Per spec §4.5: rules for SendMessage variant usage (refer by NAME not UUID; broadcast at most once per turn; task_notification routing; shutdown_request semantics; plan_approval_response is lead-only) |

**Modified files (2):**

| Path | What changes |
|---|---|
| `src/tools/AgentTool/agents/coordinator/AGENT.md` | Add 3 new entries to the `references:` array so loader inlines them into systemPrompt |
| `src/tools/AgentTool/agents/coordinator/__tests__/prompt-snapshot.test.ts` (or similar) | If a prompt-snapshot test exists, regenerate the snapshot. If none, no action |

**Total:** 3 new + 2 modifications across 4 tasks.

---

## Sequence + dependencies

```
Task 1 (three-mode-decision.md)  ─┐
Task 2 (continue-vs-spawn.md)    ─┼─▶ Task 4 (AGENT.md references update + verification)
Task 3 (sendmessage-rules.md)    ─┘
```

Tasks 1-3 are independent (3 separate reference docs). Can be done in any order, but plan keeps them sequential per skill rules.

---

## Task 1: Create three-mode-decision.md

**Files:**
- Create: `src/tools/AgentTool/agents/coordinator/references/three-mode-decision.md`

The verbatim three-mode decision tree from spec §1.

- [ ] **Step 1: Create the file**

Create `src/tools/AgentTool/agents/coordinator/references/three-mode-decision.md` with the following content (copied verbatim from spec §1):

```markdown
# How to handle this turn

You have THREE execution modes. Choose based on task shape, not on
"which feels easier".

## Mode 1 — Handle directly

Choose when:
- Task is a DB read/update you can do with one of your own tools
  (query_team_status, update_plan_item, ...)
- Task is a clarifying question to the founder
- Task is composing a final summary from results already in your context

DO NOT delegate work you can finish with your own tools in 1-2 calls.

## Mode 2 — Sync subagent (Task tool)

Choose when:
- Task is bounded (< ~30s of work), single-domain, single-output
- You need the result in THIS turn to continue reasoning
- Examples: draft one X reply, judge one opportunity, validate one draft

`Task({subagent_type, prompt})` — you AWAIT the result. The subagent
runs in the same job and returns its final text. Your context gets the
output back synchronously.

## Mode 3 — Async teammate (Task tool with run_in_background:true)

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

- [ ] **Step 2: Verify the file exists and is well-formed markdown**

```bash
ls -la src/tools/AgentTool/agents/coordinator/references/three-mode-decision.md
head -3 src/tools/AgentTool/agents/coordinator/references/three-mode-decision.md
```

- [ ] **Step 3: Commit**

```bash
git add src/tools/AgentTool/agents/coordinator/references/three-mode-decision.md
git commit -m "docs(coordinator/references): three-mode decision tree (Phase F)"
```

---

## Task 2: Create continue-vs-spawn.md

**Files:**
- Create: `src/tools/AgentTool/agents/coordinator/references/continue-vs-spawn.md`

The continue-vs-spawn decision table from engine PDF §3.7.2 (also in spec §4.5).

- [ ] **Step 1: Create the file**

Create `src/tools/AgentTool/agents/coordinator/references/continue-vs-spawn.md`:

```markdown
# Continue vs. Spawn — choose by context overlap

When you need a teammate to do work, choose between two paths:

- **Continue**: `SendMessage({to: <existing agentId>, content: ...})` —
  the existing teammate has its conversation context; the new request
  becomes the next user turn for it.
- **Spawn**: `Task({subagent_type, prompt, run_in_background: true})` —
  a fresh teammate context is created.

| Scenario | Choice |
|---|---|
| Research explored the exact files you need to change | ✅ Continue (the worker has these files in context) |
| Research was broad; implementation narrows to a few files | ✅ Spawn fresh (avoid exploration noise polluting context) |
| Fixing a failure / continuing the just-finished work | ✅ Continue (the worker knows what it just tried) |
| Verifying another worker's just-shipped code | ✅ Spawn fresh (verifier should see the code with fresh eyes) |
| First implementation went down the wrong path | ✅ Spawn fresh (anchoring on the wrong-path context taints the retry) |
| Completely unrelated new task | ✅ Spawn fresh (no context to reuse) |

## Cost framing

- Continue is cheap: the existing context is already loaded; you're just
  adding a turn.
- Spawn pays a fresh-context tax: the new teammate has to read the
  AGENT.md, any preloaded skills, and figure out what to do from scratch.

But Continue has a context-pollution cost: the existing conversation may
contain irrelevant exploration that distracts the LLM. **When the prior
exploration is REUSE-EXCEPTION-WORTHY, prefer Continue. Otherwise prefer
Spawn fresh.**
```

- [ ] **Step 2: Commit**

```bash
git add src/tools/AgentTool/agents/coordinator/references/continue-vs-spawn.md
git commit -m "docs(coordinator/references): continue-vs-spawn decision table (Phase F)"
```

---

## Task 3: Create sendmessage-rules.md

**Files:**
- Create: `src/tools/AgentTool/agents/coordinator/references/sendmessage-rules.md`

Per spec §4.5.

- [ ] **Step 1: Create the file**

```markdown
# SendMessage rules

- Refer to teammates by their NAME ('research-author', 'reply-author'),
  never by agentId UUID. The system resolves names → agentIds.
- One broadcast per turn maximum. Default to 'message' (DM).
- Choose continue (SendMessage to existing agentId) vs spawn (Task with
  run_in_background:true) by context overlap — see `continue-vs-spawn.md`.
- `task_notification` messages arrive as user-role messages with
  `<task-notification>` XML. They look like user input; distinguish by
  the opening tag. The agentId in `<task-id>` is what you use as `to`
  for follow-ups.
- `shutdown_request` asks a teammate to wrap up gracefully. They can
  respond with `shutdown_response` `approve=false` if they need more time.
- `plan_approval_response` is yours alone — only you can approve plans
  teammates submit for review.

## Variant cheat sheet

| Variant | Recipient | Purpose |
|---|---|---|
| `message` (default) | one teammate | regular DM, the workhorse |
| `broadcast` | all teammates | "stop everything" / urgent fan-out — use sparingly |
| `shutdown_request` | one teammate | ask teammate to wrap up; they may decline |
| `shutdown_response` | the requester | accept/decline a shutdown_request |
| `plan_approval_response` | one teammate | approve/reject a plan they submitted (lead-only) |
```

- [ ] **Step 2: Commit**

```bash
git add src/tools/AgentTool/agents/coordinator/references/sendmessage-rules.md
git commit -m "docs(coordinator/references): sendmessage variant rules (Phase F)"
```

---

## Task 4: Update coordinator AGENT.md to inline references + verification gate

**Files:**
- Modify: `src/tools/AgentTool/agents/coordinator/AGENT.md` (add references entries)
- Verify: any prompt-snapshot test (regenerate if needed)

- [ ] **Step 1: Read current AGENT.md frontmatter**

```bash
head -25 src/tools/AgentTool/agents/coordinator/AGENT.md
```

Note the existing `references:` and `shared-references:` arrays.

- [ ] **Step 2: Add the 3 new references**

Edit `src/tools/AgentTool/agents/coordinator/AGENT.md`. Find the `references:` block in the frontmatter. Add the 3 new entries (without the `.md` extension — the loader appends it):

```yaml
references:
  - decision-examples
  - when-to-handle-directly
  - three-mode-decision
  - continue-vs-spawn
  - sendmessage-rules
```

(Keep the existing entries `decision-examples` and `when-to-handle-directly` — they came from prior phases.)

- [ ] **Step 3: Verify loader picks up the new references**

```bash
pnpm vitest run src/tools/AgentTool/agents/coordinator
```

Expected: existing loader-smoke tests pass. The new references should inline cleanly into systemPrompt.

- [ ] **Step 4: Find any prompt-snapshot tests**

```bash
find src/tools/AgentTool/agents/coordinator -name "*snapshot*" -o -name "prompt*test*"
```

If a snapshot test exists, run it to see if the snapshot needs regenerating:

```bash
pnpm vitest run --update src/tools/AgentTool/agents/coordinator
```

The `--update` flag updates snapshots in place. Verify the new snapshot includes the three-mode-decision content.

If no snapshot test exists: skip this step.

- [ ] **Step 5: Run full AgentTool sweep + typecheck**

```bash
pnpm vitest run src/tools/AgentTool
pnpm tsc --noEmit --pretty false
```

Expected: all green.

- [ ] **Step 6: Tag the milestone**

```bash
git tag -a phase-f-team-lead-prompt -m "Agent Teams Phase F — Team-lead prompt rewrite complete"
```

- [ ] **Step 7: Update spec doc**

Append to `## Implementation status`:

```markdown
- **Phase F — Team-lead prompt rewrite:** landed `2026-05-02` on `dev`.
  Coordinator AGENT.md inlines 3 new reference docs covering the three
  execution modes (handle directly / sync subagent / async teammate),
  continue-vs-spawn decision logic, and SendMessage variant rules.
  Pure prompt-engineering — no agent-run code changes. The rename
  `coordinator` → `team-lead` is deferred to Phase G (touches DB rows,
  AgentDefinition aliases mechanism, many code constants).
  - Task 1 — three-mode-decision.md: <SHA>
  - Task 2 — continue-vs-spawn.md: <SHA>
  - Task 3 — sendmessage-rules.md: <SHA>
  - Task 4 — AGENT.md references update + verification: <SHA>
```

- [ ] **Step 8: Commit doc + AGENT.md changes**

```bash
git add src/tools/AgentTool/agents/coordinator/AGENT.md \
        docs/superpowers/specs/2026-05-02-agent-teams-architecture-design.md
git commit -m "feat(coordinator): inline three-mode + continue-vs-spawn + sendmessage references (Phase F)"
```

---

## Acceptance criteria

- [ ] 3 new reference docs exist under `coordinator/references/`
- [ ] AGENT.md `references:` block includes the 3 new entries
- [ ] All existing AgentTool tests still pass (loader smoke, etc.)
- [ ] `pnpm tsc --noEmit` clean
- [ ] Local tag `phase-f-team-lead-prompt`
- [ ] Spec doc has Phase F landed timestamp + 4 commit SHAs

---

## Self-review notes

1. **Spec coverage**: every Phase F item in spec §6 maps to a task above. The rename `coordinator` → `team-lead` is explicitly deferred to Phase G with rationale.
2. **No code changes**: Phase F is pure prompt content. The lead's runtime behavior is unchanged from Phase E.
3. **Reference style consistency**: the 3 new docs follow the same markdown conventions as existing references (`decision-examples.md`, `when-to-handle-directly.md`).
4. **Three-mode-decision content slightly differs from current production**: the new doc explicitly tells the lead about Mode 3 (async teammates) which the current AGENT.md doesn't cover. Expected behavior change: lead will start using `Task({run_in_background:true})` more after Phase F lands. This requires `SHIPFLARE_AGENT_TEAMS=1` to be effective; flag-off path stays sync-only by default.
5. **Snapshot test**: if no test exists, no action needed. If exists, `--update` regenerates.
