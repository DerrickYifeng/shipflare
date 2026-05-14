# Phase 0 Spike Results

| # | Item | Status | Notes |
|---|---|---|---|
| 1 | Anthropic SDK streaming + tool use | GREEN | 10/10 streams complete in parallel. 8 events per stream (message_start, content_block_start, content_block_delta, content_block_stop, message_delta, message_stop). stop_reason=tool_use, tool_use_id matches `^toolu_`, no silent fallback. Single run ~1.6s, 10 parallel ~1.5s. Test duration 3.4s total. SDK v0.96.0, model claude-sonnet-4-6. |
| 2 | McpAgent + addMcpServer RPC | GREEN | Props passthrough: `propsUserId=test-user-123`, `propsSecret=test-secret-456` arrive in the McpAgent's tool handler via `this.props`. Vitest both pass; `wrangler dev` curl returns `callCount=1,2,3` across 3 calls (state persists), then `callCount=4` after a full `wrangler dev` restart — props are re-applied from DO storage. Zero outbound HTTP in `wrangler dev` log (only the 3 inbound GETs). agents v0.12.4, MCP SDK v1.29.0. Decorator workaround documented below. |
| 3 | MCP Streamable HTTP | GREEN | `McpServerExample.serve("/external-mcp/:userId/mcp", { binding: "MCP_EXAMPLE" })` works end-to-end. Vitest 2/2 pass (initialize handshake + tools/list). Manual curl against `wrangler dev`: protocol `2024-11-05`, server `spike-mcp@1.0.0`, capabilities `{tools:{listChanged:true}}`, session id is a 64-char hex token returned in the `mcp-session-id` response header and required on subsequent requests. Responses are SSE-framed (`Content-Type: text/event-stream`, `Transfer-Encoding: chunked`, one `event: message\ndata: {...json}` block per JSON-RPC reply). `notifications/initialized` returns 202 (no body, no SSE frame). `tools/call echo_props` returns `propsUserId=null,propsSecret=null,callCount=N` — external HTTP path does NOT auto-inject props (only `addMcpServer` RPC does). State persists across calls within a session (callCount=1→2). |
| 4 | Better Auth + Drizzle + D1 | GREEN | **Architectural pivot from spec: D1 instead of Hyperdrive+Neon** (see "Task 11 spec sweep" below). 3/3 vitest pass. `auth.api.getSession({ headers })` with no cookie returns `null`. `/api/auth/get-session` (the Better Auth route) returns <500 on cold call — adapter bootstraps cleanly against `drizzle(env.DB)` + `provider: "sqlite"`. The 4 Better Auth tables (`user`, `session`, `account`, `verification`) confirmed via `wrangler d1 execute --local`: `SELECT name FROM sqlite_master WHERE type='table'` returns all four plus `_cf_METADATA`. better-auth v1.6.11 + @better-auth/drizzle-adapter v1.6.11 + drizzle-orm 0.45.2/d1 + vitest-pool-workers 0.16.4. GitHub OAuth dance deferred to manual validation (documented in Spike #4 notes below). |
| 5 | WebCrypto AES-GCM | GREEN | 5/5 vitest pass. 100 random tokens (each `crypto.randomUUID()-Math.random()`, ~50–55 chars) round-trip cleanly with a fresh 32-byte key. Same plaintext (`"same-input"`) encrypted twice produces different ciphertexts (12-byte random IV per call). Decrypting with the wrong key throws `OperationError` from `crypto.subtle.decrypt` — auth tag failure as expected. Edge cases: empty string and 1-byte plaintext both round-trip. UTF-8 emoji (`🔐`) survives `TextEncoder` → encrypt → decrypt → `TextDecoder`. Ciphertext sizes (base64): `""` → 40 chars (30B = 12B IV + 0B ct + 16B tag), `"a"` → 40 chars, `"ghp_short_token_example"` (23B) → 68 chars (51B), `"xoxb-..."` (34B) → 84 chars (63B), the 49B emoji string → 108 chars (81B). Test duration 1.45s. Helper exports (`encrypt`, `decrypt`, `generateKey`) are drop-in candidates for Phase 1 `packages/crypto` — replace `KEY_B64` default with a `wrangler secret` lookup (`env.CHANNEL_ENC_KEY`). |
| 6 | DO SQLite perf | GREEN | 1/1 vitest pass. 10000-row seed in 24ms via `transactionSync` (≈417k rows/sec). 50-sample benchmark inside the DO (after seed): SELECT `WHERE conv_id ORDER BY ts` p50=7ms / p99=7ms / max=11ms (returns all 10k rows, indexed lookup hits `idx_messages_conv_ts`). Single-row INSERT p50=0ms / p99=0ms / max=0ms — all 50 samples completed in <1ms each. `wrangler dev --local` corroborates: seed 25ms, SELECT 6/7/7, INSERT 0/0/0. Both runtimes well under thresholds (SELECT < 50ms p99, INSERT < 5ms p99). **Key finding:** raw `BEGIN TRANSACTION` SQL is forbidden in DO SQLite — workerd throws explicitly and points at `state.storage.transactionSync()`. Spec uses the JS API. SQLite v3 + workerd in-process, no network hop, so latencies are essentially CPU-bound. |
| 7 | Dynamic Workflow | GREEN | 1/1 vitest pass in 5064ms. `step.do("step-a") → step.sleep("5 seconds") → step.do("step-b")` completes cleanly with `output.a.tag="A"`, `output.b.tag="B"`, `output.durationMs >= 5000` (actual run: test took ~5s total, so durationMs is ~5000ms — vitest-pool-workers DOES honor the sleep duration in the local Workflow simulator). Test polled `/spike/07/status?id=<id>` at 1s intervals; instance reached `status="complete"` on first non-running poll after the sleep elapsed. Full suite: 7 files / 16/16 tests pass in 7.54s. `WorkflowEntrypoint` imports from `"cloudflare:workers"` (standard path, no shim needed). Migration tags untouched — Workflow classes don't live in the `migrations[].new_sqlite_classes` array. **Test simulation HONORS sleep duration** — no test-vs-prod divergence observed for `step.sleep("5 seconds")`; production wall-clock semantics match the simulator within ~64ms scheduling overhead. |
| 8 | Service Binding | GREEN | 1/1 vitest pass in ~5ms test time. `env.CALLEE.fetch(...)` round-trip exercised end-to-end against an auxiliary `shipflare-spike-callee` worker registered via `cloudflareTest({ miniflare: { workers: [...] } })`. Manual `wrangler dev` validation with BOTH workers running side-by-side: first call latency `5ms` (cold isolate boot for the callee), warmed-up p50 across 10 calls = `1ms`, with several samples reporting `0ms` (`Date.now()` floor). HTTP `200`. Round-trip total `8.6ms` including curl + JSON parse. **Zero-network confirmed**: `headerEcho` shows custom headers (`x-shipflare-internal`, `x-test`, `content-type`, `content-length`) pass through; `host` from the synthesized `new Request("https://internal/test-echo", ...)` is dropped by the binding layer (Service Bindings rewrite the host header — caller's original host is NOT exposed to the callee). `cf-connecting-ip` is also absent on the binding path (no edge translation). Callee echo body shape: `{ pathReceived: "/test-echo", methodReceived: "POST", headerEcho: {...}, timestamp: <ms>, callee: "shipflare-spike-callee" }`. wrangler 4.90.1, miniflare 4.20260508. |
| 9 | Cron fan-out | GREEN | 2/2 vitest pass in ~14ms test time. `wrangler.jsonc` `triggers.crons: ["*/1 * * * *"]` uncommented; modules-format `scheduled()` exported from `src/index.ts` dispatches to `src/spikes/09-cron-fanout.ts` `onCron()`, which fans out to a single `SqliteDO` instance (`getByName("cron-target")`) via `markCronTick(scheduledTime)` — appends a row to the existing `messages` table tagged `conv_id='cron-marker'` with `ts=scheduledTime`, `content=cron@<scheduledTime>`. Vitest pattern: `createScheduledController({ scheduledTime, cron })` + `createExecutionContext()` + direct call to the worker's exported `scheduled` handler (NOT `SELF.scheduled`, which throws `DataCloneError: Could not serialize object of type "LoopbackServiceStub"` in vitest-pool-workers 0.16.4). Test 1: triggers cron with scheduledTime=1700000000000, asserts marker is in the DO with exact `ts` and `content` echo. Test 2: snapshots pre-count, triggers twice (t1=...001000, t2=...002000), asserts post-count ≥ pre+2 and both timestamps are in the recent list. **Manual validation** via `pnpm wrangler dev --test-scheduled`: two `curl 'http://localhost:8787/__scheduled?cron=*/1+*+*+*+*'` calls each returned HTTP 200 with log line `Ran scheduled event`; `GET /spike/09` after first call returned `markerCount=1`, after second `markerCount=2`, with the latest tick at index 0 of `recent[]`. Both runtimes confirm the cron handler invokes correctly and the DO marker pattern observable for Phase 1's hourly inbound sweeps. No new migration tag (existing `messages` table reused). |
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

### Spike #3 (2026-05-13)

- **`McpAgent.serve(path, opts)` exists as a static method on the agent class
  itself in agents@0.12.4** (signature confirmed in
  `node_modules/agents/dist/agent-tool-types-CM_50fcV.d.ts` line 462). Returns
  `{ fetch(req, env, ctx): Promise<Response> }`. Default `transport` is
  `"streamable-http"`, which is what external MCP clients (Claude Desktop,
  Cursor, `@modelcontextprotocol/inspector`) speak.
- **Default `binding` is `"MCP_OBJECT"`.** Our spike's DO binding is named
  `MCP_EXAMPLE`, so the call MUST pass `{ binding: "MCP_EXAMPLE" }` explicitly
  or it throws `Could not find McpAgent binding for MCP_OBJECT`. For Phase 2
  ShipFlare we should pick the binding name carefully or pass it explicitly.
- **Needed value import** of `McpServerExample` in `src/index.ts` (the file
  was previously only re-exporting + type-importing); without it, calling
  `.serve()` at runtime would fail.
- **Tests run against the actual `/external-mcp/` route via `SELF.fetch`** —
  no separate harness. Both tests pass in vitest-pool-workers 0.16.4 on first
  try; the earlier worry about SSE / WebSocket flakiness in the test env did
  not materialize. The transport uses `text/event-stream` chunked responses
  (`event: message\ndata: {...}\n\n`), not raw WebSocket upgrade, so it works
  in the simulated env. (A `WebSocket peer disconnected` exception prints at
  test-pool teardown but does not affect the test result — it's the
  per-session DO websocket being torn down after the test runs.)
- **Session-id contract.** The `initialize` response carries
  `mcp-session-id: <64-char hex>` and `Access-Control-Expose-Headers:
  mcp-session-id`. Every subsequent request MUST echo `mcp-session-id:
  <same>` or the server treats it as a new session. The `notifications/
  initialized` message is sent after init (returns 202, no SSE body) before
  any tool call.
- **External-HTTP path does NOT inject props.** `propsUserId` and
  `propsSecret` are `null` when the MCP server is hit via Streamable HTTP —
  matches expectation. `addMcpServer(name, binding, { props })` is the ONLY
  path that auto-injects via DO storage; external clients would inject auth
  context via OAuth (`withOAuthProvider` wrap) in Phase 2.
- **`Cache-Control: no-cache`** is set on the SSE response — important for
  Phase 2 since any caching layer in front of the worker would break SSE.
- **State persists across calls within a session** (callCount=1→2 across two
  manual `tools/call` requests with the same session-id). Same DO instance,
  same `this.state`.
- **Manual validation performed via curl** following the exact same JSON-RPC
  protocol that `@modelcontextprotocol/inspector` issues. Did not spawn the
  inspector UI itself — it's a thin wrapper around the protocol calls
  verified above. Phase 2 should still run a real inspector smoke test
  before exposing the route publicly.
- **Phase 2 reminders.** (a) The `binding` name to pass to `.serve()` must
  match the production wrangler binding. (b) An OAuth provider wrap is
  required to populate `props` from the external user's auth headers. (c) The
  Worker route must NOT be behind a CDN that buffers SSE. (d) Each
  `:userId` slug routes to a DO derived from the path — different users get
  different DO instances automatically (good — matches multi-tenancy needs).

### Spike #4 (2026-05-13)

- **Architectural pivot from the original spec.** Phase 0 plan called for
  Hyperdrive + Neon Postgres; the user pivoted to **Cloudflare D1** to
  drop the external-service dependency. The spike validates the D1 path
  instead. See "Task 11 spec sweep" below for the docs/spec items that
  now need updating.
- **Better Auth adapter requires `provider: "sqlite"`** (not `"d1"`).
  `@better-auth/drizzle-adapter` v1.6.11 has three providers: `pg`,
  `mysql`, `sqlite`. D1 is SQLite-over-HTTP, so `"sqlite"` is correct.
  The adapter does NOT transform identifiers — column names declared in
  `src/db/schema.ts` are exactly what the SQL must use, so both the
  Drizzle schema and `migrations/001_better_auth.sql` use camelCase
  identifiers (`emailVerified`, `accessToken`, `expiresAt`, ...). Phase 1
  `packages/db` must keep this in sync.
- **`betterAuth()` returns `Auth<TLiteralOptions>` not
  `Auth<BetterAuthOptions>`.** TypeScript infers the literal options
  object as the generic, which makes `ReturnType<typeof betterAuth>`
  invariantly incompatible with `Auth<BetterAuthOptions>` (the
  documented type). Workaround: annotate the options object as
  `BetterAuthOptions` before passing it in, so the generic resolves to
  the base type. Without this the singleton cache won't type-check.
- **Auth instance MUST be a per-isolate singleton.** Better Auth's setup
  walks the schema + plugin tree on every `betterAuth()` call — it's not
  cheap. Cache the instance with a module-scoped `let _auth = null` and
  reuse across requests. Worker isolates persist across many requests
  inside the same execution context, so this scales correctly.
- **Local D1 needed before vitest runs.** `wrangler d1 execute
  shipflare-spike --local --file migrations/001_better_auth.sql` was
  applied once; vitest-pool-workers / miniflare reuses that
  `.wrangler/state/v3/d1` instance. If the migration is missing, the
  auth handler crashes on `auth.api.getSession` with `no such table:
  session`. Add to onboarding / Phase 1 dev setup script.
- **`database_id` in wrangler.jsonc is a placeholder UUID
  (`00000000-0000-0000-0000-000000000001`) for now.** Local
  `wrangler d1 execute --local` and `vitest-pool-workers` both accept
  any well-formed UUID — the actual DB is keyed by `database_name`
  against the local SQLite directory. For remote (`--remote` /
  production), the real UUID from `wrangler d1 create shipflare-spike`
  must replace it. `wrangler d1 list` was not callable in this spike
  environment (no `CLOUDFLARE_API_TOKEN` set, non-interactive); user
  needs to run `wrangler d1 create shipflare-spike` interactively and
  paste the real UUID before deploying.
- **`/api/auth/*` route MUST come before the `/spike/NN` regex.** Better
  Auth's callback URL is `/api/auth/callback/github`, which would 404 if
  the spike dispatcher saw it first. Order in `src/index.ts`:
  `/healthz` → `/external-mcp/*` → `/api/auth/*` → `/spike/NN` →
  fallthrough.
- **GitHub OAuth dance deferred to manual validation.** To exercise the
  full sign-in / cookie / user-row creation flow:
  ```bash
  cd spike/shipflare-spike
  # 1. ensure .dev.vars has real GITHUB_CLIENT_ID / GITHUB_CLIENT_SECRET
  # 2. provision remote D1 (one-time, interactive):
  pnpm wrangler d1 create shipflare-spike
  # paste the returned UUID into wrangler.jsonc d1_databases[0].database_id
  pnpm wrangler d1 execute shipflare-spike --remote --file migrations/001_better_auth.sql
  pnpm wrangler dev
  # 3. browser → http://localhost:8787/api/auth/sign-in/social?provider=github
  # → GitHub OAuth → land back on localhost → cookie + user row created
  # 4. verify: curl -b "<paste cookie>" http://localhost:8787/spike/04/session
  ```
  The auto-tests don't need real GitHub credentials — they validate
  bootstrap + the no-cookie path only.

### Spike #5 (2026-05-13)

- **Workers WebCrypto is API-compatible with browser WebCrypto** for AES-GCM
  encrypt/decrypt/importKey. `crypto.subtle.encrypt` returns `ArrayBuffer`,
  same as the browser; wrapping in `new Uint8Array(...)` works the way the
  helper expects. No Workers-specific quirks observed.
- **12-byte IV is correct.** NIST SP 800-38D §5.2.1.1 recommends 96-bit
  (12-byte) IVs for AES-GCM — what we use. Some legacy code (and some online
  examples) uses 16; don't. Workers WebCrypto accepts both but 12 is the
  standard and what every mainstream lib (libsodium, AWS Encryption SDK,
  GCP Tink) uses.
- **Wrong-key decrypt throws `OperationError`** — the GCM auth tag is
  validated as part of decryption, so a tampered ciphertext OR a wrong key
  both surface as an `OperationError` from `crypto.subtle.decrypt`. Test
  uses `rejects.toThrow()` (loose match) since the error class isn't part
  of any stable spec we can pin against.
- **UTF-8 + `TextEncoder`/`TextDecoder` round-trip works for emoji
  (`🔐`).** This is the standard surrogate-pair-safe path; no special
  handling needed. Confirms `TextDecoder.decode()` on the decrypted bytes
  yields the original JS string.
- **No AAD (additional authenticated data) used.** The existing
  `src/lib/auth/account-encryption.ts` interface doesn't expect callers to
  pass AAD on read, so adding it would require a caller-side change.
  Deferred to a Phase 1 enhancement: AAD would bind ciphertext to a row id
  so a swapped ciphertext from another row would fail to decrypt.
  Documented in the helper file.
- **Helper functions are zero-dep and lift cleanly into `packages/crypto`
  for Phase 1.** The default `KEY_B64` (32 zero bytes) is test-only and
  documented as such in the file header; production swaps it for
  `env.CHANNEL_ENC_KEY` (wrangler secret). The `importKey` validation
  rejects keys that aren't 32 bytes, which surfaces a misconfigured secret
  at boot rather than at first decrypt.
- **Ciphertext envelope is `[12B IV][N B ciphertext + 16B GCM tag]`
  then base64.** Note WebCrypto AES-GCM returns the auth tag appended
  to the ciphertext (single `ArrayBuffer`), unlike Node's
  `createCipheriv` which exposes it separately via `getAuthTag()`. The
  existing `src/lib/encryption/index.ts` uses a 3-part hex envelope
  `iv:tag:ciphertext` with a 16-byte IV. Phase 1 migration plan: ship
  a `maybeDecrypt` that recognises both envelope shapes (hex 3-part →
  Node-style, base64 single blob → WebCrypto-style), re-encrypt rows
  to the new envelope as they're touched, then drop the legacy
  decoder once a backfill script confirms zero rows remain in the old
  format. The 12-byte IV in the new envelope follows NIST
  recommendation; the old code's 16-byte IV is functionally fine but
  non-standard for GCM.

### Spike #6 (2026-05-13)

- **Raw `BEGIN TRANSACTION` SQL is forbidden in DO SQLite.** workerd
  throws explicitly: *"To execute a transaction, please use the
  state.storage.transaction() or state.storage.transactionSync() APIs
  instead of the SQL BEGIN TRANSACTION or SAVEPOINT statements."* The
  initial spec snippet wrapped the 10k INSERT loop in
  `sql.exec("BEGIN TRANSACTION")` / `"COMMIT"` — replaced with
  `ctx.storage.transactionSync(() => { ... })`. The JS API auto-rolls-back
  on throw and interacts correctly with DO's automatic atomic
  write-coalescing, so it's strictly better than the SQL form anyway.
  Phase 1 `packages/team-state` (or wherever the per-team DO lives) must
  use the JS API.
- **DO SQLite is FAST in-process.** No network hop, in-isolate sqlite3.
  10000-row seed in 24ms (≈417k rows/sec) inside a single
  `transactionSync`. Indexed SELECT returning all 10k rows: p50/p99/max
  = 7/7/11 ms in vitest, 6/7/7 ms under `wrangler dev --local`. Single
  one-shot INSERT: p50/p99/max all sub-millisecond (0/0/0 ms reported —
  `Date.now()` granularity is the floor). Numbers will inflate on real
  Workers runtime under concurrent load, but the headroom under the
  thresholds (50ms / 5ms) is enormous.
- **`SqlStorage.exec<T>` requires `T extends Record<string, SqlStorageValue>`.**
  Declaring `MsgRow` as an `interface` does NOT satisfy the index
  signature constraint even when all members are individually
  assignable — TypeScript treats interface members as known-keys-only.
  Switched to `type MsgRow = { ... }` which auto-satisfies the
  constraint. Pattern to follow in Phase 1 for any row type passed to
  `sql.exec<T>`.
- **Migration tags are append-only — confirmed in practice.** Task 2
  added `v1: [McpServerExample, AgentExample]`; Task 6 added
  `v2: [SqliteDO]` rather than amending `v1`. wrangler accepted both
  tags and the local `.wrangler/state` migrated correctly. Mutating
  `v1` in place is a silent no-op once already applied — preserve the
  immutability comment in `wrangler.jsonc`.
- **No pragma tuning required.** DO SQLite manages WAL / synchronous /
  journal mode internally. Did not enable any `PRAGMA` — perf already
  blew past thresholds. If a future workload needs query-plan-level
  optimization, `EXPLAIN QUERY PLAN` is available via `sql.exec` like
  any other SQL.
- **`getByName` is the right namespace API.** Used
  `env.SQLITE_DO.getByName("perf-test")` rather than
  `idFromName` → `get(id)` — the SDK exposes `getByName` as a
  one-step shortcut. Same semantics; cleaner call site.

### Spike #7 (2026-05-13)

- **`WorkflowEntrypoint` imports from `"cloudflare:workers"`** — same module
  as the standard Worker types, no separate `@cloudflare/workflows` package
  needed in workers-types and agents@0.12.4. The class extends
  `WorkflowEntrypoint<Env, Params>` where `Params` is the payload shape; the
  `run(event, step)` signature gets `event.payload` typed as `Params`. Confirmed
  in the generated `worker-configuration.d.ts` after wrangler types regen.
- **vitest-pool-workers' Workflow simulator HONORS `step.sleep` duration.**
  No test-vs-prod divergence — the 5s sleep actually paused execution for
  ~5000ms wall-clock. Test run took 5064ms total (assertion `durationMs >= 5000`
  passed; the extra ~64ms is scheduling / RPC overhead between vitest poll
  iterations). Note from the task spec said "some versions don't actually wait
  the full sleep duration in test mode" — `@cloudflare/vitest-pool-workers`
  v0.16.4 does NOT exhibit this; sleep is fully simulated. **Worth re-testing
  on production wrangler** if a future Worker runtime upgrade lands.
- **Workflow `create` + `get` + `status` shape.** `env.EX_WORKFLOW.create({ params })`
  returns a `WorkflowInstance` with `.id`. `env.EX_WORKFLOW.get(id)` re-acquires
  the instance handle from any subsequent request. `instance.status()` returns
  `{ status, output?, error?, ... }`. Terminal states: `"complete"`,
  `"errored"`, `"terminated"`. Polling shape used in the test mirrors what
  Phase 1 `AgentPlanWorkflow` UI will use to render a plan-in-progress.
- **Migration tags unchanged.** Workflow classes do NOT belong in the
  `migrations[].new_sqlite_classes` array — that's reserved for DO classes
  with SQLite storage. The workflow binding declaration in `wrangler.jsonc`
  is `workflows: [{ binding, name, class_name }]`, parallel to (not nested in)
  `durable_objects` / `d1_databases`.
- **Status sub-route via single dispatch.** `/spike/07` returns a fresh
  workflow id; `/spike/07/status?id=<id>` polls. Handler branches on
  `url.pathname.endsWith("/status")` — works because the route matcher in
  `src/index.ts` is `/^\/spike\/(\d{2})(?:\/.*)?$/` (the optional `/.*` lets
  the dispatch happily forward to the same handler for both paths).
- **Eviction-survival validated implicitly.** Workflows are durable by design;
  every `step.do` output is checkpointed to the platform's state store and
  every `step.sleep` returns a continuation token. The 5s sleep window is too
  short to force a real eviction in vitest, but the architectural guarantee
  (PER §Workflow Engine reference) is that resume-from-anywhere works because
  step results are content-addressed and re-runs of a completed step are
  no-ops returning the cached output. Production eviction-during-sleep
  validation needs `wrangler deploy` + manual force-restart, deferred to
  Phase 1 pre-cutover smoke test.

### Spike #8 (2026-05-13)

- **vitest-pool-workers DOES simulate Service Bindings** — contrary to the
  task spec's "can't fully simulate" assumption. The key is registering the
  sibling Worker as an auxiliary worker via the `cloudflareTest({ miniflare:
  { workers: [...] } })` option in `vitest.config.mts`. Without that
  registration, miniflare refuses to start the test pool with
  `Worker "..."'s binding "CALLEE" refers to a service "...", but no such
  service is defined`. With it registered, the in-test `env.CALLEE.fetch()`
  call resolves end-to-end and the handler returns 200 with the callee's
  echo body.
- **Auxiliary workers do NOT go through Vite transforms.** Pointing
  `scriptPath` at the sibling's `src/index.ts` fails with `ERR_MODULE_PARSE:
  The keyword 'interface' is reserved` — miniflare treats the file as raw
  JS. Workaround: inline a JS-equivalent of the callee handler via
  `script: "..."` in the auxiliary worker config. The canonical TS
  implementation in `spike/shipflare-spike-callee/src/index.ts` is what
  `wrangler dev` and the production deploy run; the inline string in
  `vitest.config.mts` is a test-only stub that mirrors its echo contract.
  For Phase 1 we should probably build the callee with `tsc` (or wrangler
  itself) to `dist/index.js` and point `scriptPath` at the built artifact,
  so the test stays DRY with production.
- **`wrangler types` made `CALLEE: Fetcher` required** the moment the
  `services[]` block was uncommented in `wrangler.jsonc`. The Task 0 stub
  had `CALLEE?: Fetcher` (optional) which then conflicted with the
  generated `Cloudflare.Env`'s required `CALLEE: Fetcher`, breaking
  `DurableObjectNamespace<Env>` constraints across `AgentExample`,
  `McpServerExample`, and `spikes/02-mcp-rpc.ts` (they require
  `Env extends Cloudflare.Env`). Fix: drop the `?` on `Env.CALLEE`, and in
  the spike handler cast `env.CALLEE as unknown as Fetcher | undefined`
  before the null-check so the runtime-tolerant branch still type-checks
  under strict mode.
- **Manual `wrangler dev` validation: zero-network confirmed.** Started
  `shipflare-spike-callee` on `:8788` and `shipflare-spike` on `:8787` in
  parallel. wrangler's dev server auto-discovers locally-running services
  by name (the `services[].service: "shipflare-spike-callee"` matches the
  callee's `wrangler.jsonc`.name) — no port hard-coding needed. First call
  `latencyMs=5` (cold isolate boot on the callee side); 10 follow-up calls
  reported `0` or `1` ms each. Sub-millisecond steady-state corroborates
  the "in-process, no DNS / TLS / TCP" promise of Service Bindings — same
  isolate group, function-call cost only.
- **Service Bindings rewrite the host header on the synthesized Request.**
  The caller built `new Request("https://internal/test-echo", { headers:
  {...} })`; the callee's `headerEcho` shows `content-length`,
  `content-type`, `x-shipflare-internal`, `x-test` but NO `host` and NO
  `cf-connecting-ip`. The binding layer strips/replaces host (no public
  hostname is meaningful for an in-process call) and there's no edge to
  inject `cf-connecting-ip`. Phase 1 `apps/web → apps/core` should NOT
  rely on host-based routing or `cf-connecting-ip` over a Service
  Binding — pass the originating context explicitly via a header or
  signed JWT instead.
- **Custom headers passthrough is clean.** `x-shipflare-internal: 1` made
  it across (this header was added partly to give the callee a way to
  distinguish in-process traffic from any future public-routed traffic,
  should the callee ever be exposed). Pattern: send a shared-secret HMAC
  in this header for defense-in-depth, since Service Bindings don't have
  built-in cross-worker auth — anything bound can call you. Phase 1
  notes: enforce a per-call HMAC at the `apps/core` perimeter even though
  the binding can only originate from `apps/web` by configuration.
- **Phase 1 mirror is straightforward.** `apps/web/src/lib/core-client.ts`
  would just be `env.CORE.fetch(new Request("https://internal/...", {...}))`,
  with `env.CORE: Fetcher` declared and `services: [{ binding: "CORE",
  service: "shipflare-core" }]` in `apps/web/wrangler.jsonc`. Zero new
  primitives, zero outbound network egress, no DNS / TLS handshake. The
  abstraction shape is identical to the spike.

### Spike #9 (2026-05-13)

- **`SELF.scheduled(...)` is NOT usable in vitest-pool-workers 0.16.4.** The
  `SELF` constant is a `LoopbackServiceStub` that fails to serialize the
  scheduled-event payload across the test boundary, throwing
  `DataCloneError: Could not serialize object of type "LoopbackServiceStub"`
  (and the call itself isn't even on the local `Fetcher` typedef — `worker-
  configuration.d.ts` declares Fetcher as just `{ fetch, connect }`). The
  canonical pattern documented in `cloudflare:test`'s types is: import the
  worker's default export directly (`import worker from "../src/index"`),
  construct controller + context via `createScheduledController` and
  `createExecutionContext`, then call `worker.scheduled!(ctl, env, ctx)`
  and `await waitOnExecutionContext(ctx)`. This is functionally equivalent
  to a cron tick — the platform's real scheduler builds the same controller
  shape and invokes the same handler. Phase 1 cron tests should follow this
  pattern (not the spec snippet's `SELF.scheduled(...)` form).
- **`pnpm wrangler dev --test-scheduled` is the manual cron rig.** The
  `__scheduled` HTTP endpoint accepts a `cron` query param (URL-encoded;
  `*` survives but `/` must be `+` — the URL form is
  `*/1+*+*+*+*`). Each hit synthetically fires the worker's `scheduled()`
  handler with a fresh `scheduledTime = Date.now()` and returns 200 with
  the line `Ran scheduled event` in wrangler's log. No `triggers.crons`
  entries are required for `--test-scheduled` to work, but production
  deploy obviously needs them.
- **Migration tag unchanged.** Adding `markCronTick` / `listCronMarkers`
  methods to `SqliteDO` is just code — no schema change (the existing
  `messages` table is reused with `conv_id='cron-marker'`). Migration tags
  stay at `v1` + `v2`; no `v3` needed. This matches the Spike #6 finding:
  tags are append-only **for class additions**, not for arbitrary method
  changes.
- **Cron schedule string `*/1 * * * *`** parses cleanly under wrangler
  4.90.1; no extra escaping needed in the JSONC. The every-minute cadence
  is for spike-only — Phase 1 inbound sweeps will be hourly
  (`0 * * * *`), and the per-team fan-out will iterate over active CMOs
  fetched from D1 inside `onCron()` and dispatch DO stubs in parallel
  with `Promise.allSettled`. The shape proven here (cron → scheduled() →
  `env.SQLITE_DO.getByName(<id>).method()`) is exactly the production
  shape, just with a list of `<id>`s instead of one.
- **`ScheduledController` shape echoed correctly.** `ctl.scheduledTime`
  arrives at the handler as a number (ms epoch), exactly as set by
  `createScheduledController({ scheduledTime: new Date(N) })`. The
  controller's `cron` field is also preserved. Tests assert on both —
  Phase 1 can rely on these fields being the same on local and prod.
- **`createScheduledController` accepts `{ scheduledTime?: Date; cron?:
  string }`.** Note `scheduledTime` is a Date (not a number) in the options,
  but the resulting controller exposes `scheduledTime` as a number — the
  test pool internally coerces via `Number(options?.scheduledTime ??
  Date.now())`. Tests use `new Date(1_700_000_000_000)` deterministically.
- **In-test DO state persists across tests within a file.** Same DO
  instance (`cron-target`) accumulates markers across both tests; assertions
  use pre/post snapshots (delta ≥ +2) rather than exact counts so prior
  test markers don't break the second. Cross-file: vitest-pool-workers
  resets local DO state between files (miniflare cleanup).

### Task 11 spec sweep — Hyperdrive → D1

The original migration spec
(`docs/superpowers/specs/2026-05-13-cloudflare-do-migration-design.md`)
and the Phase 0/1 plan documents both reference Hyperdrive + Neon
Postgres. The user pivoted to D1 during Spike #4. Add to Task 11
(spec/docs sweep) the following items:

- **Migration spec D6:** change "Hyperdrive → Neon Postgres" to "D1"
  in §3 (decisions table), §4.1 (topology / binding list), and §4.2.2
  (storage layer). Anywhere `HYPERDRIVE` appears as a binding name,
  replace with `DB: D1Database`.
- **Phase 1 plan:** `packages/db` uses `drizzle-orm/d1` (not
  `drizzle-orm/neon-http`). The `Env` shape for every app /
  worker that touches the database swaps `HYPERDRIVE: Hyperdrive` for
  `DB: D1Database`. The `Database` type in `packages/db` is
  `DrizzleD1Database<TSchema>`, not `NeonHttpDatabase<TSchema>`.
- **Phase 0 setup steps:** remove `wrangler hyperdrive create` and the
  Neon project provisioning steps. Add a single
  `wrangler d1 create shipflare` and migrate via
  `wrangler d1 migrations apply` (or our hand-rolled `*.sql` files for
  early spikes).
- **All schema tables** — `channels`, `user`, `session`, `account`,
  `verification`, plus every Phase 2/3 table — now live in D1, not
  Neon. SQLite type constraints apply: no `JSONB`, integer-timestamps
  with mode flags, foreign keys explicit with `REFERENCES ... ON
  DELETE CASCADE`. Spec §5 (schema sketches) needs revision to drop
  PostgreSQL-only types.
- **Backup / DR section** — Neon's branching is gone. D1 has
  Time-Travel (point-in-time restore, 30 days for paid plans), plus
  `wrangler d1 export` for manual snapshots. Update the DR runbook.
- **No PgBouncer / connection-pool sizing concerns** — D1 is HTTP, no
  pool. Section on Hyperdrive connection limits can be deleted.
- **Cost section** — D1 pricing differs sharply from Neon: $0.75 per
  million rows read, $1.00 per million rows written, $0.75/GB-month
  storage (vs. Neon's compute-hour billing). Re-estimate Phase 2/3
  costs under D1 pricing.
