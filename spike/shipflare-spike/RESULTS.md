# Phase 0 Spike Results

| # | Item | Status | Notes |
|---|---|---|---|
| 1 | Anthropic SDK streaming + tool use | GREEN | 10/10 streams complete in parallel. 8 events per stream (message_start, content_block_start, content_block_delta, content_block_stop, message_delta, message_stop). stop_reason=tool_use, tool_use_id matches `^toolu_`, no silent fallback. Single run ~1.6s, 10 parallel ~1.5s. Test duration 3.4s total. SDK v0.96.0, model claude-sonnet-4-6. |
| 2 | McpAgent + addMcpServer RPC | GREEN | Props passthrough: `propsUserId=test-user-123`, `propsSecret=test-secret-456` arrive in the McpAgent's tool handler via `this.props`. Vitest both pass; `wrangler dev` curl returns `callCount=1,2,3` across 3 calls (state persists), then `callCount=4` after a full `wrangler dev` restart — props are re-applied from DO storage. Zero outbound HTTP in `wrangler dev` log (only the 3 inbound GETs). agents v0.12.4, MCP SDK v1.29.0. Decorator workaround documented below. |
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

### Spike #2 (2026-05-13)

- **`@callable()` decorator broke the worker bundle with `SyntaxError: Invalid
  or unexpected token`** in vitest-pool-workers' bundler. The decorator was a
  Stage 3 (TC39) decorator (signature `(target, _context: ClassMethodDecoratorContext)`),
  TS 6.0 + `target: ES2022` should support it, but the workerd bundle hit
  a syntax error at runtime. Spike 1 was collateral damage because the worker
  bundle failed to load entirely.
  **Workaround:** dropped the `@callable()` decorator from `AgentExample`.
  Callable methods are needed only for WebSocket/HTTP client invocation; the
  spike uses `getAgentByName()` → `DurableObjectStub<AgentExample>` and
  invokes the method directly as an RPC method, which works without the
  decorator. This same pattern (Agent → MCP RPC, called from a Worker handler)
  is what the ShipFlare migration will use, so the workaround is not a
  regression. Worth re-investigating before Phase 1 if we need callable
  methods for the founder UI WebSocket layer; for now it is documented and
  acceptable.
- **`extra.props` is NOT populated by agents v0.12.4 RPC transport.** The
  task spec example reads `(extra as any).props` inside the tool handler,
  but the SDK only wraps `runWithAuthContext` for HTTP transports
  (`createMcpHandler` / `serve`). For RPC (`handleMcpMessage`), the props
  pass through `McpAgent.onStart(props)` → `this.props` + `ctx.storage`
  persistence. Updated the spike's `McpServerExample.echo_props` tool to
  read `this.props` instead. This is also hibernation-relevant: `this.props`
  is restored from `ctx.storage.get("props")` on McpAgent boot, which is why
  props survive cold restart.
- **DO state persists across `wrangler dev` restart**, not just idle
  hibernation. After killing the dev process and restarting, the next
  `/spike/02` call returned `callCount=4` with both props intact — workerd's
  local SQLite persists DO storage across dev sessions, and `McpAgent.onStart`
  re-hydrates `this.props` from storage. Strong evidence the
  `addMcpServer({ props })` → DO storage → boot rehydration path is
  end-to-end correct.
- **`Env` interface needed parameterized `DurableObjectNamespace<Class>`** to
  satisfy `addMcpServer`'s generic constraint `<T extends McpAgent>`. Bare
  `DurableObjectNamespace` (unparameterized = `<undefined>`) does not match.
  Added `import type` for `McpServerExample`/`AgentExample` in `src/index.ts`
  and parameterized the bindings; also added `worker-configuration.d.ts` to
  `tsconfig.include` so the generated `Cloudflare.Env` namespace is visible.
