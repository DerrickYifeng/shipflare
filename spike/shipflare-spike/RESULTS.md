# Phase 0 Spike Results

| # | Item | Status | Notes |
|---|---|---|---|
| 1 | Anthropic SDK streaming + tool use | GREEN | 10/10 streams complete in parallel. 8 events per stream (message_start, content_block_start, content_block_delta, content_block_stop, message_delta, message_stop). stop_reason=tool_use, tool_use_id matches `^toolu_`, no silent fallback. Single run ~1.6s, 10 parallel ~1.5s. Test duration 3.4s total. SDK v0.96.0, model claude-sonnet-4-6. |
| 2 | McpAgent + addMcpServer RPC | GREEN | Props passthrough: `propsUserId=test-user-123`, `propsSecret=test-secret-456` arrive in the McpAgent's tool handler via `this.props`. Vitest both pass; `wrangler dev` curl returns `callCount=1,2,3` across 3 calls (state persists), then `callCount=4` after a full `wrangler dev` restart — props are re-applied from DO storage. Zero outbound HTTP in `wrangler dev` log (only the 3 inbound GETs). agents v0.12.4, MCP SDK v1.29.0. Decorator workaround documented below. |
| 3 | MCP Streamable HTTP | GREEN | `McpServerExample.serve("/external-mcp/:userId/mcp", { binding: "MCP_EXAMPLE" })` works end-to-end. Vitest 2/2 pass (initialize handshake + tools/list). Manual curl against `wrangler dev`: protocol `2024-11-05`, server `spike-mcp@1.0.0`, capabilities `{tools:{listChanged:true}}`, session id is a 64-char hex token returned in the `mcp-session-id` response header and required on subsequent requests. Responses are SSE-framed (`Content-Type: text/event-stream`, `Transfer-Encoding: chunked`, one `event: message\ndata: {...json}` block per JSON-RPC reply). `notifications/initialized` returns 202 (no body, no SSE frame). `tools/call echo_props` returns `propsUserId=null,propsSecret=null,callCount=N` — external HTTP path does NOT auto-inject props (only `addMcpServer` RPC does). State persists across calls within a session (callCount=1→2). |
| 4 | Better Auth + Drizzle + D1 | GREEN | **Architectural pivot from spec: D1 instead of Hyperdrive+Neon** (see "Task 11 spec sweep" below). 3/3 vitest pass. `auth.api.getSession({ headers })` with no cookie returns `null`. `/api/auth/get-session` (the Better Auth route) returns <500 on cold call — adapter bootstraps cleanly against `drizzle(env.DB)` + `provider: "sqlite"`. The 4 Better Auth tables (`user`, `session`, `account`, `verification`) confirmed via `wrangler d1 execute --local`: `SELECT name FROM sqlite_master WHERE type='table'` returns all four plus `_cf_METADATA`. better-auth v1.6.11 + @better-auth/drizzle-adapter v1.6.11 + drizzle-orm 0.45.2/d1 + vitest-pool-workers 0.16.4. GitHub OAuth dance deferred to manual validation (documented in Spike #4 notes below). |
| 5 | WebCrypto AES-GCM | GREEN | 5/5 vitest pass. 100 random tokens (each `crypto.randomUUID()-Math.random()`, ~50–55 chars) round-trip cleanly with a fresh 32-byte key. Same plaintext (`"same-input"`) encrypted twice produces different ciphertexts (12-byte random IV per call). Decrypting with the wrong key throws `OperationError` from `crypto.subtle.decrypt` — auth tag failure as expected. Edge cases: empty string and 1-byte plaintext both round-trip. UTF-8 emoji (`🔐`) survives `TextEncoder` → encrypt → decrypt → `TextDecoder`. Ciphertext sizes (base64): `""` → 40 chars (30B = 12B IV + 0B ct + 16B tag), `"a"` → 40 chars, `"ghp_short_token_example"` (23B) → 68 chars (51B), `"xoxb-..."` (34B) → 84 chars (63B), the 49B emoji string → 108 chars (81B). Test duration 1.45s. Helper exports (`encrypt`, `decrypt`, `generateKey`) are drop-in candidates for Phase 1 `packages/crypto` — replace `KEY_B64` default with a `wrangler secret` lookup (`env.CHANNEL_ENC_KEY`). |
| 6 | DO SQLite perf | GREEN | 1/1 vitest pass. 10000-row seed in 24ms via `transactionSync` (≈417k rows/sec). 50-sample benchmark inside the DO (after seed): SELECT `WHERE conv_id ORDER BY ts` p50=7ms / p99=7ms / max=11ms (returns all 10k rows, indexed lookup hits `idx_messages_conv_ts`). Single-row INSERT p50=0ms / p99=0ms / max=0ms — all 50 samples completed in <1ms each. `wrangler dev --local` corroborates: seed 25ms, SELECT 6/7/7, INSERT 0/0/0. Both runtimes well under thresholds (SELECT < 50ms p99, INSERT < 5ms p99). **Key finding:** raw `BEGIN TRANSACTION` SQL is forbidden in DO SQLite — workerd throws explicitly and points at `state.storage.transactionSync()`. Spec uses the JS API. SQLite v3 + workerd in-process, no network hop, so latencies are essentially CPU-bound. |
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
