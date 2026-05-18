# Resume Note — CF-Native Chat Migration

**Last updated:** 2026-05-18 (post-Phase 7)
**Branch:** `feat/cf-native-chat-migration` (origin synced through `428c4bb`; 5.1c commits `f1179d0`..`9ed5a04` are local-only at time of this update)
**Plan:** `docs/superpowers/plans/2026-05-16-cf-native-chat-migration.md`
**Spec:** `docs/superpowers/specs/2026-05-16-cf-native-chat-migration-design.md`
**5.1c spec:** `docs/superpowers/specs/2026-05-17-cf-chat-5-1c-design.md`
**5.1c plan:** `docs/superpowers/plans/2026-05-17-cf-chat-5-1c.md`
**Phase-0 verifications:** `docs/superpowers/specs/2026-05-16-phase-0-verifications.md`
**Phase-0c verifications:** `docs/superpowers/specs/2026-05-17-phase-0c-verifications.md`
**Amendments:**
- `docs/superpowers/plans/2026-05-16-task-4.4-amendment.md` (SMM rewrite scope)
- `docs/superpowers/plans/2026-05-16-task-5.1-amendment.md` (CMO rewrite scope + locked decisions)

## Phase 7 — landed 2026-05-18 (PR-ready)

4 sub-tasks shipped on `feat/phase-7-external-mcp` (commits `e39cfc01`..`c736046a`):

- 7.0a — Setup: installed @cloudflare/workers-oauth-provider@^0.6.0, OAUTH_KV namespace, CMO_EXTERNAL_MCP DO binding, v13 migration tag, dropped dead MCP_OAUTH_JWT_SIGNING_KEY/MCP_OAUTH_AUDIENCE env
- 7.1 — CMO.invokeAsTool synchronous one-shot dispatch for external MCP (mirrors the 5.1c.13 alarm synthesis pattern but with user-role messages)
- 7.2 — CmoExternalMcp DO exposing ONE tool: chat(message) — forwards to internal CMO via DO RPC. Per [[feedback_external_mcp_chat_surface]], no curated per-tool surface
- 7.3 — OAuthProvider mount at /cmo/mcp + bare-bones consent UI at /authorize. Public DCR enabled. + security fix: x-test-user-id seam gated on EXTERNAL_AUTH_TEST_SEAM env (vitest-only)

Known follow-up before production deploy: `resolveUserIdFromSessionCookie` is a TODO — currently returns null in production (no real session-cookie verification). Phase 7.5 wires Better Auth session-cookie reading.

Test counts: 176/176 core tests passing; tsc 0.
Branch is 5 commits ahead of dev.

## 5.1c — landed 2026-05-17 (PR-ready)

20 sub-tasks shipped on `feat/cf-native-chat-migration` (commits `f1179d0`..`9ed5a04`):

- Phase-0c probe verified `saveMessages` as the synthetic-turn API
- SMM peer tools: find_threads_via_xai, find_threads, process_replies_batch, process_posts_batch, research_reddit_channels
- HoG peer tools: generate_strategic_path, audit_plan
- CMO shadow handlers: /internal/mirror-draft, /internal/strategic-path-proposal
- Daily relay: DO alarm() + computeNextDailyAt + setFounderContext hook
- TZ inference: browser Intl + cf.timezone + lazy bootstrap on first WS connect
- Outer cron-tick fan-out deleted (alarm() replaces it)
- /chat UI filters out synthetic system-role messages
- Playwright smoke `e2e/cmo-relay.spec.ts` ready for manual run

Net SQL writes: SMM owns threads_inbox + drafts; HoG owns planning_chat + proposal_drafts + audit_findings; CMO owns approval_queue + strategic_path (proposed rows arrive via mirror).

## TL;DR — where things stand

- **~82 commits** on the branch (62 pre-5.1c on remote + 20 5.1c commits local; working tree clean).
- **163/163 core tests passing** (`@shipflare/core`); web + shared suites unchanged from pre-5.1c green.
- **tsc clean** on `@shipflare/core`, `@shipflare/shared`, `@shipflare/web`. (Repo-wide `pnpm -r exec tsc --noEmit` surfaces ~762 pre-existing errors in the legacy root `src/` from before the monorepo split — those are NOT introduced by this branch.)
- **Phases 0, 1, 2, 3, 4, 5 (incl. 5.1c), 6, 7, 8, 9, 10 done**. Only Phase 11 (cutover) remains.
- **Branch is deployable to dev** — the CMO-side agent execution gap that previously blocked autonomous workflows is now closed. Phase 7 (external MCP chat-only surface) landed on `feat/phase-7-external-mcp` — `resolveUserIdFromSessionCookie` is the only TODO before production deploy.

## Status by phase

| Phase | Status | Notes |
|---|---|---|
| 0 | ✅ COMPLETE | Deps (`@cloudflare/ai-chat`, AI SDK v6) + Analytics Engine binding + OAuth env scaffold + Phase-0 SDK verifications doc |
| 1 | ✅ COMPLETE | `writeAgentEvent` writer in `packages/shared` |
| 2 | ✅ COMPLETE | `safeAgentChain` depth+cycle safety; lazy-init fixed in commit `5f61050` |
| 3 | ✅ COMPLETE | `runSkill` options-bag + emission + telemetry; 3 SMM callsites threaded |
| 4 | ✅ COMPLETE | EMPLOYEE_REGISTRY, getEmployee, consult-tool, system-prompt, peer schemas, SMM+HoG rewrites as AIChatAgent, peer-mesh tests |
| 5 | ✅ COMPLETE | CMO rewrite as AIChatAgent (net −4,333 LOC); 15 LLM-callable tools; migration v12 clean DO namespace |
| 5.1c | ✅ COMPLETE | 20 sub-tasks; SMM/HoG peer tools ported, CMO mirror handlers, DO `alarm()`-driven daily relay, /chat synthetic-message filter, Playwright spec `e2e/cmo-relay.spec.ts` |
| 6 | ✅ COMPLETE (no-op) | `founder_messages` / `activity_events` never lived in D1; DO migration tags landed inline |
| 7 | ✅ COMPLETE (chat-only surface, OAuth 2.1 + PKCE) | `/cmo/mcp` mounted via `@cloudflare/workers-oauth-provider`; CmoExternalMcp DO exposes `chat(message)` only; `resolveUserIdFromSessionCookie` TODO remains (Phase 7.5) |
| 8 | ✅ COMPLETE | `/api/agent-token`, `useCmoChat`, 7 part renderers, `/chat` page, WS JWT verification, New Employee Checklist, Playwright spec |
| 9 | ✅ COMPLETE (adapted) | `plan-build-activity.tsx` simplified to status card; richer onboarding viz deferred |
| 10 | ✅ COMPLETE | team-desk.tsx refactored to useCmoChat; 14 legacy activity-feed files deleted; comment cleanup |
| 11 | ⏳ PENDING | Playwright real-LLM smoke, telemetry verification, PR + merge |

## Start here next session

Phase 7 is done. Only Phase 11 (PR cutover to dev / main) remains.

### Phase 11 (cutover, lands the work on dev)

1. Push branches to origin:
   - `git push` on `feat/cf-native-chat-migration` (5.1c commits `f1179d0`..`9ed5a04` are local-only)
   - `git push` on `feat/phase-7-external-mcp` (Phase 7 commits `e39cfc01`..`c736046a` — currently 5 commits ahead of dev)
2. Open a PR for the branch on GitHub: `gh pr create --base dev --title "feat: CF-native chat migration"`
3. Per memory `feedback_pr_merge_use_merge_commit`: merge with a merge commit, NOT squash.
4. Run the Playwright smokes:
   - `apps/web/e2e/cmo-chat.spec.ts` (general chat — requires real Anthropic key + running dev server + `auth-state.json`)
   - `apps/web/e2e/cmo-relay.spec.ts` (daily relay — uses the admin-trigger endpoint added in 5.1c.18)
5. Telemetry verify: query Cloudflare Analytics Engine SQL API for `shipflare_agent_events` post-deploy.

### Phase 7.5 (follow-up — must land before production deploy of external MCP)

`apps/core/src/external/auth-handler.ts:resolveUserIdFromSessionCookie` is a TODO — currently returns null in production. Wire Better Auth session-cookie reading so the `/authorize` flow can identify the logged-in founder. Without this, external MCP OAuth flow will not work in production (it works in vitest via the `EXTERNAL_AUTH_TEST_SEAM`-gated `x-test-user-id` header).

## Known limitations

### 1. Web chat: production-ready
The `/chat` page (Phase 8) and refactored `/team` page (Phase 10) both work against the new AIChatAgent surface. JWT verification on the WS upgrade is in `apps/core/src/index.ts:handleCmoWsRequest`. The /chat UI filters synthetic system-role messages (`metadata.source='daily-relay'`) so daily-relay prompts don't render but assistant replies do. **This part is deployable.**

### 2. CMO-side agent execution: DONE (was the 5.1c gap, closed 2026-05-17)
- SMM owns `threads_inbox` + `drafts`; peer tools populate them and mirror to CMO's `approval_queue`.
- HoG owns `planning_chat` + `proposal_drafts` + `audit_findings`; `generate_strategic_path` proposes via `/internal/strategic-path-proposal`.
- Daily relay runs via DO `alarm()` on each CMO (TZ-aware) — outer `scheduled()` is fleet-only (`snapshotGrowth`).
- Playwright spec `apps/web/e2e/cmo-relay.spec.ts` is ready to run manually against a real LLM for end-to-end validation.
- **The agent can now chat with the founder AND autonomously drive discovery, drafting, and the daily relay.**

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

## Commit log (~82 commits — 62 pre-5.1c on remote + 20 5.1c local)

5.1c tip: `9ed5a04 test(e2e): cmo-relay Playwright smoke + admin trigger endpoint (5.1c.18)`. See "5.1c — landed 2026-05-17" section above for the per-task commit list. Pre-5.1c log shown below:

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

Full log: `git log --oneline 084c1cd..HEAD` (ordered most-recent first).

## When ready to merge

Per `feedback_pr_merge_use_merge_commit` memory:
- Use a merge commit (NOT squash)
- After merging dev → main, immediately fast-forward dev to origin/main

The branch is deployable to dev now. Phase 7 (external MCP) can land as a follow-up PR — it does not gate autonomous agent workflows, only third-party MCP-client access.

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

Expected: clean tree, recent commit `9ed5a04` or later, all tsc clean, 163/163 core tests pass.
