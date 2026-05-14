# Phase 0 Spike Results

| # | Item | Status | Notes |
|---|---|---|---|
| 1 | Anthropic SDK streaming + tool use | GREEN | 10/10 streams complete in parallel. 8 events per stream (message_start, content_block_start, content_block_delta, content_block_stop, message_delta, message_stop). stop_reason=tool_use, tool_use_id matches `^toolu_`, no silent fallback. Single run ~1.6s, 10 parallel ~1.5s. Test duration 3.4s total. SDK v0.96.0, model claude-sonnet-4-6. |
| 2 | McpAgent + addMcpServer RPC | PENDING | |
| 3 | MCP Streamable HTTP | PENDING | |
| 4 | Better Auth + Drizzle + Hyperdrive | PENDING | |
| 5 | WebCrypto AES-GCM | PENDING | |
| 6 | DO SQLite perf | PENDING | |
| 7 | Dynamic Workflow | PENDING | |
| 8 | Service Binding | PENDING | |
| 9 | Cron fan-out | PENDING | |
| 10 | Resumable stream | PENDING | |

## Risk Updates

(Update during spike — anything that surprises us)

### Spike #1 (2026-05-13)

- **vitest-pool-workers 0.16.4 dropped `defineWorkersConfig` from `/config`.**
  The Task 0 scaffold's `vitest.config.ts` referenced
  `@cloudflare/vitest-pool-workers/config`, which no longer exists. New API is
  `cloudflareTest()` plugin from the package root, used with `defineConfig`
  from `vitest/config`. Codemod ships at
  `node_modules/@cloudflare/vitest-pool-workers/dist/codemods/vitest-v3-to-v4.mjs`.
  Also renamed `vitest.config.ts` → `vitest.config.mts` because the package
  is ESM-only and the spike's root `package.json` does not declare
  `"type": "module"`.
- **`tsconfig.json` `types` array needed `@cloudflare/vitest-pool-workers/types`**
  so the test file can `import { SELF } from "cloudflare:test"` and typecheck.
- **No silent fallback observed.** All 10 parallel calls returned
  `stop_reason: "tool_use"` with a valid `tool_use_id`. The early-2026 SDK
  fixes appear to hold for SDK v0.96.0 + `claude-sonnet-4-6`.
