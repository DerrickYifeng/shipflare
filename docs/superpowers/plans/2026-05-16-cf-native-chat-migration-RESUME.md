# Resume Note — CF-Native Chat Migration

**Last updated:** 2026-05-17
**Branch:** `feat/cf-native-chat-migration` (**pushed to origin** at commit `428c4bb`+)
**Plan:** `docs/superpowers/plans/2026-05-16-cf-native-chat-migration.md`
**Spec:** `docs/superpowers/specs/2026-05-16-cf-native-chat-migration-design.md`
**Phase-0 verifications:** `docs/superpowers/specs/2026-05-16-phase-0-verifications.md`
**Amendments:**
- `docs/superpowers/plans/2026-05-16-task-4.4-amendment.md` (SMM rewrite scope)
- `docs/superpowers/plans/2026-05-16-task-5.1-amendment.md` (CMO rewrite scope + locked decisions)

## TL;DR — where things stand

- **62 commits** on the branch, all on remote. Working tree clean.
- **192/192 tests passing** across all packages (core 105, web 76, shared 11).
- **tsc clean** on `@shipflare/core`, `@shipflare/shared`, `@shipflare/web`. (Repo-wide `pnpm -r exec tsc --noEmit` surfaces ~762 pre-existing errors in the legacy root `src/` from before the monorepo split — those are NOT introduced by this branch.)
- **Phases 0, 1, 2, 3, 4, 5, 6, 8, 9, 10 done**. Phase 7 deferred. Phase 11 (cutover) pending.
- **Branch is non-deployable to prod** in two places — see "Known limitations" below.

## Status by phase

| Phase | Status | Notes |
|---|---|---|
| 0 | ✅ COMPLETE | Deps (`@cloudflare/ai-chat`, AI SDK v6) + Analytics Engine binding + OAuth env scaffold + Phase-0 SDK verifications doc |
| 1 | ✅ COMPLETE | `writeAgentEvent` writer in `packages/shared` |
| 2 | ✅ COMPLETE | `safeAgentChain` depth+cycle safety; lazy-init fixed in commit `5f61050` |
| 3 | ✅ COMPLETE | `runSkill` options-bag + emission + telemetry; 3 SMM callsites threaded |
| 4 | ✅ COMPLETE | EMPLOYEE_REGISTRY, getEmployee, consult-tool, system-prompt, peer schemas, SMM+HoG rewrites as AIChatAgent, peer-mesh tests |
| 5 | ✅ COMPLETE | CMO rewrite as AIChatAgent (net −4,333 LOC); 15 LLM-callable tools; migration v12 clean DO namespace |
| 6 | ✅ COMPLETE (no-op) | `founder_messages` / `activity_events` never lived in D1; DO migration tags landed inline |
| 7 | ⏸ DEFERRED | External MCP route stubbed to 503; OAuth wrapper deferred (user chose Phase 8 first) |
| 8 | ✅ COMPLETE | `/api/agent-token`, `useCmoChat`, 7 part renderers, `/chat` page, WS JWT verification, New Employee Checklist, Playwright spec |
| 9 | ✅ COMPLETE (adapted) | `plan-build-activity.tsx` simplified to status card; richer onboarding viz deferred |
| 10 | ✅ COMPLETE | team-desk.tsx refactored to useCmoChat; 14 legacy activity-feed files deleted; comment cleanup |
| 11 | ⏳ PENDING | Playwright real-LLM smoke, telemetry verification, PR + merge |

## Start here next session

Pick one path:

### Path A — Phase 11 (cutover, lands the work on dev)

1. Open a PR for the branch on GitHub: `gh pr create --base dev --title "feat: CF-native chat migration"`
2. Per memory `feedback_pr_merge_use_merge_commit`: merge with a merge commit, NOT squash.
3. Run the Playwright smoke at `apps/web/e2e/cmo-chat.spec.ts` (requires real Anthropic key + running dev server + `auth-state.json` for the founder's pre-authenticated browser context).
4. Telemetry verify: query Cloudflare Analytics Engine SQL API for `shipflare_agent_events` post-deploy.

**Caveats**: the branch in its current state has known limitations (see below). Phase 11 lands them as acknowledged tech debt; **production deploy should wait until 5.1c + Phase 7 land**.

### Path B — Phase 7 (external MCP + OAuth)

Plan §Phase 7 lines 2060–2310 (4 tasks). Wires `withOAuthProvider` over the CMO external MCP route so 3rd-party clients (Claude Desktop, Cursor, the founder's own LLM stack) can connect to `mcp.shipflare.com/cmo`. The route is currently a hard 503 stub in `apps/core/src/index.ts:handleExternalMcpRequest` with a Phase 7 marker.

### Path C — 5.1c (the biggest remaining functional work)

Port the 8 deleted SMM+HoG tools to CMO-side LLM tools. Without this:
- `queryDrafts` returns empty (CMO's `approval_queue` is never populated)
- `/internal/cron-tick` is a noop stub (currently just emits a `cron-tick-noop` telemetry event)
- The agent system can chat but cannot actually drive drafting / sweep workflows

The 8 tools (all previously MCP-style; now need to be AI SDK `tool({...})` entries inside CMO's `getTools()`):
- From SMM: `find_threads_via_xai`, `find_threads`, `process_replies_batch`, `process_posts_batch`, `research_reddit_channels`, `list_drafts`
- From HoG: `generate_strategic_path`, `audit_plan`

Each becomes either a direct CMO tool OR a CMO orchestration that internally calls `consult('smm'|'hog', {...})`. Spec §3.4 prefers the latter — peers answer questions, CMO commits decisions.

## Known limitations (the branch is non-deployable in 2 places)

### 1. Web chat: production-ready
The `/chat` page (Phase 8) and refactored `/team` page (Phase 10) both work against the new AIChatAgent surface. JWT verification on the WS upgrade is in `apps/core/src/index.ts:handleCmoWsRequest`. **This part is deployable.**

### 2. External MCP route: 503 stub
`/external/agents/cmo/<userId>/mcp` returns 503 with a Phase 7 message. Any external MCP client (Claude Desktop / Cursor) will fail until Phase 7 lands. **Not deployable for external MCP use cases.**

### 3. CMO-side agent execution: half-built
- `queryDrafts`: returns empty (`approval_queue` has no writer)
- `cron-tick`: noop stub (no fan-out)
- 8 SMM/HoG tools: deleted, not yet re-implemented
- **The agent CAN chat with the founder. It CANNOT autonomously drive discovery, drafting, or scheduled sweeps.** This is the "5.1c" follow-up work.

## Execution mode (carry forward)

User chose **subagent-driven development** (skill: `superpowers:subagent-driven-development`).

Per-task loop:
1. Dispatch implementer subagent (sonnet or opus for large rewrites, general-purpose) — pass FULL task text + scene-setting
2. Spec-compliance reviewer subagent (combined w/ code reviewer for small tasks)
3. Code-quality reviewer subagent
4. Apply review follow-ups inline or as a separate small commit
5. Tick checkboxes in plan, commit `docs(plan): …` for major checkpoints

For LARGE atomic refactors (CMO rewrite, team-desk refactor, etc.): write an **amendment doc** first that breaks the task into sub-tasks. Two amendments shipped: `2026-05-16-task-4.4-amendment.md`, `2026-05-16-task-5.1-amendment.md`.

The three prompt templates live at
`~/.claude/plugins/cache/claude-plugins-official/superpowers/5.1.0/skills/subagent-driven-development/`.

## Verified environment notes (carry forward)

- `agents@0.12.4` exports only `agentTool(Cls, options)` from `agents/agent-tools` subpath — NOT a free `runAgentTool`. Consult-tool pre-instantiates `agentTool` per employee lazily via `getPeerTools()` (see commit `5f61050` — top-level eager init caused TDZ in registry test isolation).
- `@ai-sdk/anthropic@3.0.78` emits `reasoning-start | reasoning-delta | reasoning-end` natively — no shim needed.
- AI SDK v6 returns `isStreaming` (NOT `isLoading`); `useAgent`'s `query` accepts `QueryObject = Record<string, string | null>` (NOT a template literal string); `sendMessage` accepts `{ text: string }` (NOT a raw string). Plan body has stale v5 shapes in places — adapt.
- `useAgentChat` is exported from `@cloudflare/ai-chat/react`. `useAgent` + `useAgentToolEvents` are exported from `agents/react`.
- `experimental_context` threads into tool `execute` via `ToolCallOptions.experimental_context`.
- `tool({...})` from `'ai'`; `defineTool` does NOT exist.
- **Worker bundle isolation**: `vi.mock(...)` does NOT propagate into the miniflare worker bundle in vitest-pool-workers. Don't try to mock `@ai-sdk/anthropic` for DO-level chat tests — Playwright is the right tool for real-LLM flows. (See Task 5.2 commit `65ee092` for the smoke-fallback pattern.)
- `apps/core/.dev.vars` is gitignored — `MCP_OAUTH_JWT_SIGNING_KEY` is set locally; `.dev.vars.example` documents it.
- Vitest invocation: `pnpm --filter @shipflare/<pkg> exec vitest run <path>`.
- **Indent conventions**: `apps/core/src/` = TABS, `apps/core/test/` = 2-space, `apps/web/` (all) = 2-space, `packages/shared/src/` = 2-space, `packages/skills/src/` = 2-space.

## Architecture decisions locked in (don't re-litigate)

1. **DO migration tags use `deleted_classes + new_sqlite_classes`** (clean namespace per user's dev-stage choice, NOT `renamed_classes`). v10 SMM, v11 HoG, v12 CMO all follow this pattern.

2. **No `@callable` RPC on CMO**. All state-affecting actions during chat go through LLM-callable `getTools()` entries. Roster + Conversations retired entirely. Peers don't write CMO SQLite — CMO writes based on `consult` results. (Confirmed by user 2026-05-17 in the Task 5.1 amendment Q&A.)

3. **Inline markdown for SYSTEM.md / preamble**, NOT `?raw` imports. Matches the `SKILL_REGISTRY` pattern.

4. **`EMPLOYEE_META` is duplicated** in `apps/core/src/agents/lib/system-prompt.ts` (vs. `registry.ts`) to break the circular dep `registry → HoG/SMM → system-prompt → registry`. Three sources must stay in sync: `apps/core/src/agents/registry.ts`, `.../lib/system-prompt.ts`, and `apps/web/src/lib/employee-registry-client.ts`. New Employee Checklist in `CLAUDE.md` lists all three.

5. **WS JWT verification at the worker entry** (`apps/core/src/index.ts:handleCmoWsRequest`), not via CMO `onConnect` override. Verifies `agent === "cmo"` + `name === userId` before forwarding to the DO. Saves DO spin-up on bad tokens.

## Telemetry indexes — open design question

The current `writeAgentEvent` writes `indexes: [kind, userId, runId]` but Cloudflare Analytics Engine only honors the first index. **Decide before any consumer reads the dataset** whether to:
- (a) Move `userId` / `runId` to `blobs` and use `kind` as the sole index, or
- (b) Accept that `userId`/`runId` are blobs-only and document the SQL query patterns

Touch: `packages/shared/src/telemetry.ts:14`.

## Commit log (62 commits)

```
$ git log --oneline 084c1cd..HEAD | head -30
428c4bb docs(resume): Phase 8/9/10 complete; only Phase 7 (deferred) + Phase 11 remain
079cbe3 chore: scrub stale activity-feed comments + delete obsolete e2e smoke
c277386 refactor: remove legacy activity-feed surface (Phase 10 sweep)
b1bc3a5 fix(web): drop createdAt jitter from UserMessage — team refactor follow-up
7833901 refactor(web): team page on useCmoChat + Phase 8 part renderers
dfe465f feat(onboarding): drop useCmoActivity dep from plan-build-activity
e978e22 docs(web): New Employee Checklist + Playwright cmo-chat spec
de229ad style(web): 8.4 review polish — apps/web spaces + narrow consult input
a881fdc feat(web): CmoChat page + WS auth verification (additive)
0642567 fix(web): two 8.3 review follow-ups before 8.4
c49d6ec feat(web): part renderer components
d6bc936 docs(resume): log Phase 8 WS auth hardening as a pre-8.4 gate
d38a672 feat(web): /api/agent-token + useCmoChat — Phase 8 foundation
73261e5 docs(plan): Phase 5+6 complete; resume → Phase 7 or 8
65ee092 test(cmo): setupAgentTest helper + chat-flow telemetry smoke
901b93e fix(cmo): code-review follow-ups for 5.1b
f61362a feat(cmo): rewrite as AIChatAgent + delete obsolete tool surface + migration v12
5f61050 fix(agents): lazy-init PEER_TOOLS to break consult-tool circular-import TDZ
…
```

Full log: `git log --oneline 084c1cd..HEAD` (60 commits across all phases, ordered most-recent first).

## When ready to merge

Per `feedback_pr_merge_use_merge_commit` memory:
- Use a merge commit (NOT squash)
- After merging dev → main, immediately fast-forward dev to origin/main

**The branch is currently non-deployable to prod**. Plan to either:
- Land 5.1c + Phase 7 before any production deploy, OR
- Land the branch on dev now (acknowledging the limitations above) and address 5.1c/Phase 7 as follow-up PRs

## Quick verify command (run before starting next session)

```bash
cd /Users/yifeng/Documents/Code/shipflare
git status                                     # should be clean
git log --oneline -5                            # check what's at HEAD
pnpm --filter @shipflare/core exec tsc --noEmit
pnpm --filter web exec tsc --noEmit
pnpm --filter @shipflare/shared exec tsc --noEmit
pnpm --filter @shipflare/core exec vitest run | tail -3
```

Expected: clean tree, recent commit `428c4bb` or later, all tsc clean, 105/105 core tests pass.
