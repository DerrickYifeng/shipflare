# Resume Note — CF-Native Chat Migration

**Last updated:** 2026-05-16
**Branch:** `feat/cf-native-chat-migration`
**Plan:** `docs/superpowers/plans/2026-05-16-cf-native-chat-migration.md`
**Spec:** `docs/superpowers/specs/2026-05-16-cf-native-chat-migration-design.md`
**Phase-0 verifications:** `docs/superpowers/specs/2026-05-16-phase-0-verifications.md`

## Status

**Phase 0 — Foundation: COMPLETE** (Tasks 0.1, 0.2, 0.3, 0.4)
**Phase 1 — Telemetry layer: COMPLETE** (Task 1.1)

```
115fcd8 chore: install @cloudflare/ai-chat for Phase 0 of CF-native migration
c74b371 docs: Phase 0 SDK verifications for CF-native migration
806a528 chore: add Analytics Engine binding for ops telemetry
873e067 chore: scaffold OAuth env for external MCP (Phase 7 wiring)
4494d8f docs(plan): mark Phase 0 tasks complete (0.1-0.4)
6bf9749 feat(telemetry): writeAgentEvent → Analytics Engine
f9d9200 docs(plan): mark Task 1.1 (writeAgentEvent) complete
```

## Start here next session

**Task 2.1: `safeAgentChain` with depth + cycle errors** (plan line 408).

Pure leaf utility (no DO, no integration). TDD: failing test → implement → green → commit.

- Create: `apps/core/src/lib/agent-depth.ts`
- Test: `apps/core/test/agent-depth.test.ts`
- Plan steps + code blocks: see plan §Task 2.1 (lines 408-499)

Commit message: `feat(lib): safeAgentChain with depth+cycle errors`

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

## Branch state

`git status` should show a clean tree. If the working tree has stray edits, investigate before resuming.

When ready to land the whole branch: Phase 11 of the plan covers PR + merge (use merge commit, not squash — per memory `feedback_pr_merge_use_merge_commit`).
