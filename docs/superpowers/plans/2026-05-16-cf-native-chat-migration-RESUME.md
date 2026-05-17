# Resume Note — CF-Native Chat Migration

**Last updated:** 2026-05-16
**Branch:** `feat/cf-native-chat-migration`
**Plan:** `docs/superpowers/plans/2026-05-16-cf-native-chat-migration.md`
**Spec:** `docs/superpowers/specs/2026-05-16-cf-native-chat-migration-design.md`
**Phase-0 verifications:** `docs/superpowers/specs/2026-05-16-phase-0-verifications.md`

## Status

**Phase 0 — Foundation: COMPLETE** (Tasks 0.1, 0.2, 0.3, 0.4)
**Phase 1 — Telemetry layer: COMPLETE** (Task 1.1)
**Phase 2 — Agent depth & cycle safety: COMPLETE** (Task 2.1)
**Phase 3 — Skill primitive emits data parts: COMPLETE** (Task 3.1a / 3.1b / 3.1c / 3.2)
**Phase 4 — Agent orchestration: COMPLETE** (Tasks 4.1, 4.2, 4.3, 4.4a/b/c+d, 4.5a/b, 4.6, 4.7, 4.8)
  - Deferred: 4.4e (CMO-side ports of 6 deleted SMM tools), 4.5e (CMO-side ports of 2 deleted HoG tools) — both fold into Phase 5.

```
115fcd8 chore: install @cloudflare/ai-chat
c74b371 docs: Phase 0 SDK verifications
806a528 chore: add Analytics Engine binding
873e067 chore: scaffold OAuth env for external MCP
4494d8f docs(plan): mark Phase 0 complete
6bf9749 feat(telemetry): writeAgentEvent → Analytics Engine
f9d9200 docs(plan): mark Task 1.1
df5cb6e chore(review): Phase-0 follow-ups
8610ca8 feat(lib): safeAgentChain with depth+cycle errors
5344f74 refactor(lib): clarify safeAgentChain
d998631 docs(plan): mark Task 2.1
1ba66d7 docs(plan): split Task 3.1 → 3.1a/b/c after pre-flight gap audit
605b844 refactor(telemetry): move to packages/shared for cross-package use
18f7f77 refactor(skills): migrate runSkill to options-bag signature
5f7cbea refactor(skills): drop SkillContext deprecated shim
2794bc3 feat(skills): emit data-skill-start/finish parts + telemetry
723f873 refactor(skills): extract emitFinish + parseResponseText helpers
dd5bf4e feat(skills): thread env+userId into SMM runSkill calls for telemetry
```

## Start here next session

**Task 5.1: CMO class rewrite** (plan line 1643).

Phase 5 = CMO rewrite from McpAgent to AIChatAgent. Pattern established by
Tasks 4.4c+d (SMM) and 4.5b (HoG): class rename, AIChatAgent class body,
binding stays `CMO`, migration tag `v12` with deleted+new (clean DO
namespace — dev stage). SYSTEM.md extraction. EMPLOYEE_REGISTRY tightening
(class type from `any` → `typeof AIChatAgent` per Task 4.2 TODO).

**Critical Phase 5 work:**

1. CMO becomes AIChatAgent — `onChatMessage`, `getTools()` exposing user-
   facing surface (chat, conversation, roster, shared-state). Inter-agent
   `delegateToEmployee` deletes (replaced by `consult` for outbound peer
   calls) — but note CMO is the orchestrator: it doesn't use `consult`
   to call SMM/HoG, those calls go through `agentTool(Cls)` dispatch
   the same way the `consult` tool's PEER_TOOLS table works.

2. **Fold in 4.4e + 4.5e**: the 8 deleted tools' work relocates to
   CMO-side tools. Specifically: SMM's `find_threads_via_xai`,
   `find_threads`, `process_replies_batch`, `process_posts_batch`,
   `research_reddit_channels`, `list_drafts`; HoG's
   `generate_strategic_path`, `audit_plan`. These either become CMO
   `getTools()` entries or get ported as discrete agentTool wrappers.

3. Delete `apps/core/src/lib/activity.ts`, `forward-activity.ts`,
   `subagent-activity.ts` per spec §13. Delete CMO's
   `getRecentActivity` tool. Drop the legacy `activity_events` D1
   table writer.

4. The branch becomes deployable again once 5.1+5.2+5.3 land. Until
   then, CMO peer-dial to SMM/HoG still fail-soft (TODO breadcrumb
   already in CMO.ts).

## Execution mode

User chose **subagent-driven development** (skill: `superpowers:subagent-driven-development`).

Per-task loop:
1. Dispatch implementer subagent (sonnet, general-purpose) — pass FULL task text + scene-setting
2. Spec-compliance reviewer subagent
3. Code-quality reviewer subagent
4. Tick checkboxes in plan, commit `docs(plan): …`, move on

The three prompt templates live at
`~/.claude/plugins/cache/claude-plugins-official/superpowers/5.1.0/skills/subagent-driven-development/`.

## Verified environment notes (carry forward)

- `agents@0.12.4` exports only `agentTool(Cls, options)` — NOT a free `runAgentTool`. Each employee gets one pre-instantiated `agentTool` in `consult-tool.ts` (matches plan §4 / Task 4.6).
- `@ai-sdk/anthropic@3.0.78` emits `reasoning-start | reasoning-delta | reasoning-end` natively — no shim needed.
- `useAgentChat` is exported from `@cloudflare/ai-chat/react`. `useAgentToolEvents` does NOT exist — nested-agent UI reads `UIMessage.parts` directly.
- `experimental_context` threads into tool `execute` via `ToolCallOptions.experimental_context`.
- Use `tool({...})` from `'ai'`; `defineTool` does NOT exist.
- Repo-wide `pnpm -r exec tsc --noEmit` surfaces ~762 pre-existing errors in a legacy root `src/` (pre-monorepo). Always confirm delta=0 per-package: `pnpm --filter @shipflare/core exec tsc --noEmit` should be clean.
- The `apps/core` package uses tabs in src/wrangler. Tests in `apps/core/test/` use 2-space indent. Match existing style.
- `apps/core/.dev.vars` is gitignored — `MCP_OAUTH_JWT_SIGNING_KEY` is set locally (random base64) but the `.dev.vars.example` documents it for other devs.
- Vitest invocation: `pnpm --filter @shipflare/core exec vitest run <path>` (the `exec` is required; there's no `vitest` script).

## Open review findings (from spec + code review of Phase 0 + Task 1.1)

Both reviews PASSED (spec: ✅, code: approved-with-follow-ups). The
implementations faithfully execute the plan. These items are
**plan-level** concerns to resolve before Phase 3 / Phase 8 build on the
current scaffolding:

1. **Analytics Engine `indexes` cardinality** — Cloudflare AE accepts
   *at most one* index per data point; the second and third array slots
   are silently dropped at write time. Current `writeAgentEvent` writes
   `[kind, userId, runId]`. As-is, only `kind` will be queryable via
   `WHERE index = …` SQL; `userId` and `runId` won't be. **Decide before
   Phase 3 wires the first consumer** whether to (a) pick one most-
   useful index (likely `userId` for per-user query) and move the
   others into `blobs`, or (b) accept that `userId`/`runId` are
   blobs-only and document the SQL query patterns accordingly. Touch
   `apps/core/src/lib/telemetry.ts:14`.

2. **`@ai-sdk/anthropic` in `apps/web`** — Task 0.1 Step 3 directed
   installation in both packages, but the web app only needs
   `useAgentChat` / `UIMessage` from `ai`, not the Anthropic provider
   (which is server-side only). When Phase 8 wires the chat UI, drop
   `@ai-sdk/anthropic` from `apps/web/package.json` unless a web-side
   consumer materialises.

3. **Phase-7 OAuth signing key startup-guard** — *Resolved
   2026-05-16*: added a `TODO(Phase 7)` comment at
   `apps/core/src/index.ts:121` so the route handler that lands in
   Phase 7 doesn't ship without an "is non-empty" assertion.

## Branch state

`git status` should show a clean tree. If the working tree has stray edits, investigate before resuming.

When ready to land the whole branch: Phase 11 of the plan covers PR + merge (use merge commit, not squash — per memory `feedback_pr_merge_use_merge_commit`).
