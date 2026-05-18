# Phase 11 manual smoke — RESUME

**Status:** ✅ **MCP transport GREEN on staging custom domains** (2026-05-18 ~21:58).
**Branch:** `dev` — wrangler.jsonc + auth.ts changes ready to commit.
**Plan:** `docs/superpowers/plans/2026-05-18-phase-11-smoke-test.md`

## What shipped today (since prior RESUME at `cf28a249`)

| Stage | Step | Status |
|---|---|---|
| C1 | Resume Claude Desktop OAuth attempt | ✅ Permissions re-acquired |
| C2 | First OAuth attach on `*.workers.dev` | ❌ Failed — toast: "Could not attach to MCP server" |
| **Root cause** | Cross-subdomain cookie blocker on `*.workers.dev` (PSL) — apps/web Better Auth cookie cannot be sent to apps/core `/authorize`, so `resolveUserIdFromSessionCookie` always returns null → POST 401 → mcp-remote times out | **Diagnosed** |
| F1 | Custom routes in wrangler.jsonc | ✅ Both staging envs now have `routes: [{ pattern, custom_domain: true }]`<br>• apps/web → `app-staging.shipflare.ai`<br>• apps/core → `mcp-staging.shipflare.ai` |
| F2 | Better Auth cookie domain | ✅ `apps/web/src/auth.ts` adds `domain=.shipflare.ai` (or `.shipflare.com`) when `BETTER_AUTH_URL` host falls in those zones; localhost + `*.workers.dev` unchanged |
| F3 | Updated secrets + OAuth providers | ✅ `BETTER_AUTH_URL=https://app-staging.shipflare.ai`, `CORE_PUBLIC_URL=https://mcp-staging.shipflare.ai` on apps/web staging. User updated GitHub OAuth callback URI (+ partial work on Google / X) |
| F4 | Deploy staging workers | ✅ Both deployed successfully. Verified: `/healthz` 200, `/.well-known/oauth-authorization-server` 200, `/cmo/mcp` 401, web `/` 200 on new domains. Note: `workers.dev` is now **disabled** (wrangler warning); old `*.cdhyfpp.workers.dev` URLs no longer respond. |
| F5 | Claude Desktop reconfig | ✅ `~/Library/Application Support/Claude/claude_desktop_config.json` points at `https://mcp-staging.shipflare.ai/cmo/mcp`. Old mcp-remote auth cache cleared. |
| C5 | MCP attach on new domain — proven | ✅ Consent screen rendered (screenshot captured) — **"Authorize MCP CLI Proxy?"** on `mcp-staging.shipflare.ai/authorize` with correct copy. Custom-domain + cookie-domain plumbing **works**. |
| F5a | Sign in to `app-staging.shipflare.ai` | ✅ Done (cdhyfpp@gmail.com via GitHub) — `.shipflare.ai` session cookie established |
| **NEW** | **3rd OAuth attempt via Claude Desktop** | ❌ Failed identically — Claude Desktop sends `notifications/cancelled` (MCP error -32001 timeout) **exactly 60s** after spawning mcp-remote. No human can sign in + click Authorize within that window. **Root cause: Claude Desktop's hard 60s MCP init timeout, not our OAuth flow.** |
| **NEW** | **Workaround: pre-warm token cache** | ✅ Ran `npx -y mcp-remote https://mcp-staging.shipflare.ai/cmo/mcp` standalone (no 60s parent timeout). User clicked Authorize at leisure. Tokens written to `~/.mcp-auth/mcp-remote-0.1.37/d10cbfdadd1f11a8ac4e97a8a6169ead_tokens.json`. |
| C5 | MCP attach on new domain — proven | ✅ Relaunched Claude Desktop with warm cache. mcp-remote read tokens, skipped OAuth, completed init in ~1s. Log: `tools/list returned: chat` ("Talk to your ShipFlare CMO. Ask anything..."). No "Could not attach" toast. |
| C6 | Send chat through MCP | ✅ Sent "what should I work on today?" through Claude Desktop. Claude requested permission to use `Chat from shipflare-cmo-staging` → granted "Always allow" → tool invoked → CMO replied. Conversation auto-titled "Daily work priorities from CMO". |
| **BUG** | **CMO returned truncated response** | ⚠️ Reply was: *"Let me pull up your context and memory to give you a grounded answer."* — then nothing. First turn was a tool-call (context fetch) and the response stream closed before turn 2 fired. Separate from MCP plumbing; tracked as task #6. |
| D1-D3 | Verify telemetry | ✅ Soft-green via `wrangler tail --env staging --format json`: `CmoExternalMcp.getInitializeRequest` → `CMO.invokeAsTool` (wallTime 4738ms, outcome ok) → `state:update` + `message:response` diagnostic events fired. Code at `CMO.ts:142` unconditionally calls `writeAgentEvent` in `streamText.onFinish` → row was written. Direct AE query blocked by 2 bugs (verify-telemetry.ts top-level await + missing CF_API_TOKEN — tasks #8, #9). |
| E1-E5 | Web UI walkthrough | ⏳ Pending (optional). Noted: `app-staging.shipflare.ai/team` shows "Failed to fetch" / "Connection error" — unrelated to MCP; possibly app web→core call hardcoded to an old URL. Worth investigating. |

## Resume instructions — DONE

Smoke is green. The replicable install path for any new user / new machine is:

```bash
# 1. (One time) Pre-warm the token cache — bypasses Claude Desktop's 60s init timeout.
npx -y mcp-remote https://mcp-staging.shipflare.ai/cmo/mcp
# Browser opens consent screen. Click Authorize at leisure. Process completes
# token exchange and writes to ~/.mcp-auth/mcp-remote-0.1.37/.

# 2. (Optional) Kill the standalone process.
^C

# 3. Launch Claude Desktop. Spawned mcp-remote finds cached tokens
# and connects in <1s.
open -a Claude
```

**This is a real DX issue and needs documentation in user-facing setup docs** —
see task #7. The default flow (Claude Desktop → spawned mcp-remote → OAuth)
times out for 100% of first-time installs because no human can sign in +
authorize within 60s.

## Uncommitted changes on `dev` — ready to commit

- `apps/web/wrangler.jsonc` — added staging `routes` block for `app-staging.shipflare.ai`; updated OAuth-callback-URLs comment.
- `apps/core/wrangler.jsonc` — added staging `routes` block for `mcp-staging.shipflare.ai`.
- `apps/web/src/auth.ts` — added `cookieDomainAttribute(baseUrl)` helper + wired `...cookieDomainAttribute(env.BETTER_AUTH_URL)` into `defaultCookieAttributes`.
- `docs/superpowers/plans/2026-05-18-phase-11-RESUME.md` — this doc, updated with green status + warm-cache workaround documented.

Commit message:
```
feat(staging): migrate to custom subdomains for cross-origin OAuth handshake
```

## Known follow-ups discovered today (cumulative)

1. **CI typecheck failure on dev** — `worker-configuration.d.ts` (generated by `wrangler types`) isn't regenerated in CI before tsc runs. Fix: add `pnpm --filter @shipflare/core exec wrangler types` step to `.github/workflows/*.yml` before the typecheck step. (Carried forward from prior RESUME.)
2. **Old CMO SQLite namespace** — not reset (CF rejected the migration). Stale tables `conversations / founder_messages / roster / activity_events` sit unused but harmless on staging. (Carried forward.)
3. **Prod deploy not attempted yet** — staging-only smoke. Phase 11.3 (open PR for cf-native-chat → main + Phase-7) would gate that.
4. **workers.dev disabled on staging post custom-domain switch.** Anyone with the old `shipflare-{web,core}-staging.cdhyfpp.workers.dev` URL bookmarked will get DNS failures. Documented in deploy-staging.sh comment block but worth a separate one-liner in CHANGELOG when this lands on main.
5. **X / Reddit channel OAuth redirect URIs** — not part of consent dance, but the user partially updated them tonight. Verify before binding those platforms on staging:
   - X: needs `https://app-staging.shipflare.ai/api/channels/x/callback`
   - Reddit: needs `https://app-staging.shipflare.ai/api/channels/reddit/callback`
   - Google (Better Auth alternative sign-in): needs `https://app-staging.shipflare.ai/api/auth/callback/google` — user added at least one Google client.
6. **NEW: Claude Desktop 60s MCP init timeout is fatal for first-time OAuth.** Documented above. **Must add a warm-cache step to user-facing install docs**, or external MCP adoption will have ~0% completion rate. (Task #7.)
7. **NEW: CMO chat tool returns truncated response on first turn that includes a tool-call.** Repro: send "what should I work on today?" via external MCP — CMO replies "Let me pull up your context and memory to give you a grounded answer." then stops. Suspect the response stream closes before the second turn (post tool-call) fires. (Task #6.)
8. **NEW: `verify-telemetry.ts` is broken** — top-level await with no `"type": "module"` in package.json fails under tsx CJS transform. Wrap in async main(). (Task #8.)
9. **NEW: `verify-telemetry.ts` needs `CF_API_TOKEN`** — wrangler OAuth login doesn't grant Analytics Engine read scope. Document token creation steps. (Task #9.)
10. **NEW: `app-staging.shipflare.ai/team` shows "Failed to fetch" / "Connection error".** Likely an apps/web → apps/core URL still pointing at the old `*.workers.dev` host. Investigate before declaring web UI green.

## Reference paths

- **Staging URLs (new):**
  - Web: `https://app-staging.shipflare.ai`
  - Core: `https://mcp-staging.shipflare.ai`
- **Claude config:** `~/Library/Application Support/Claude/claude_desktop_config.json`
- **mcp-remote auth cache:** `~/.mcp-auth/mcp-remote-0.1.37/` (cleared)
- **MCP attach log:** `~/Library/Logs/Claude/mcp-server-shipflare-cmo-staging.log`
- **Smoke plan:** `docs/superpowers/plans/2026-05-18-phase-11-smoke-test.md`
- **Phase 7 spec:** `docs/superpowers/specs/2026-05-18-phase-7-verifications.md`

## Tasks state at green (this session, 2026-05-18 ~22:00)

- F1-F5 Custom domain plumbing + Claude Desktop config — **completed**
- F5a Sign in on new origin — **completed**
- C5 MCP attach — **completed** (warm-cache path, ~1s init)
- C6 Chat through MCP — **completed** (with separate CMO truncation bug logged)
- D Telemetry verify — **completed** (soft-green via tail; direct AE query blocked by tooling bugs)
- New follow-ups: #6 CMO truncation, #7 warm-cache install docs, #8 verify-telemetry.ts fix, #9 CF_API_TOKEN setup docs, #10 web team-page connection error

## Addendum — 2026-05-18 ~22:50 (post-Phase-11)

Investigated `/team` "Failed to fetch" (task #10). Found three independent
breakages and shipped fixes for two:

**Fixed in commit `8db20268`:**

1. **useAgent same-origin default.** `useCmoChat` was opening WS to
   `app-staging.shipflare.ai/agents/cmo/<id>` (apps/web), which 404s.
   Fix: `resolveCoreHost(env.CORE_PUBLIC_URL)` helper, server-renders
   the bare host into TeamPage/ChatPage props → drilled into useCmoChat
   → passed as `host` to useAgent. WS now correctly targets apps/core.
2. **SSR crash on `use(queryPromise)`.** useAgent's `use(query())` runs
   server-side via React 19 Suspense. `fetch('/api/agent-token?...')`
   with a relative URL throws "Invalid URL" with no base, crashing the
   page render (Chrome shows "This page couldn't load"). Fix: SSR guard
   in `fetchAgentJwt` returns empty token when `typeof window ===
   'undefined'`; client re-fetches on mount.
3. **CORS + /get-messages routing.** apps/core blocked the
   cross-origin `/get-messages` fetch (CORS allowlist didn't include
   `app-staging.shipflare.ai`) AND had no route for the framework's
   `/get-messages` path at all. Fix: extended `CORS_ALLOWED_ORIGINS`
   and added `CMO_HTTP_ROUTE` regex + `handleCmoHttpRequest` that
   JWT-verifies and delegates to SDK's `routeAgentRequest`.

**NOT FIXED — bigger debt, tracked as task #11:**

The right-panel queries on /team (`queryRoster`, `listConversations`,
`queryPlanItems`, `queryDrafts` via `createCmoClient`) use the MCP
StreamableHTTP transport that was **retired at Phase 5** —
`/agents/cmo/<id>/mcp` returns 503 with "MCP transport retired in
Phase 5; chat-native browser entry lands in Phase 8". Phase 8
migrated chat but not these queries. Each call site needs migration
to either (a) @callable RPC on CMO via useAgent, (b) apps/web HTTP
proxy via service binding, or (c) direct D1. ~1-2 days of careful
work; deserves its own plan.

**Net result:** Chat WebSocket works end-to-end on the new custom
domains. /team page renders without the SSR crash. Right-panel data
is empty (queries 503) until task #11 lands.

## Addendum — 2026-05-18 (post Task #11)

Task #11 callable RPC migration shipped to staging. 14-task plan at
`docs/superpowers/plans/2026-05-19-task-11-callable-rpc-migration.md`,
design at `docs/superpowers/specs/2026-05-19-task-11-callable-rpc-migration-design.md`.

**What landed (16 commits, dev → 5bd1d024):**

| Phase | Commits | Surface |
|---|---|---|
| Server | `02c2de41` → `597ebdfb` | 13 `@callable` methods on CMO + `conversations` table + 14 unit tests |
| Build-gate fixes | `0a6f8466` `72d07ed8` | WEB-binding type for `tsc`; `agents/vite` plugin for vitest stage-3 decorator transform |
| Bug fixes | `dfb45425` `597ebdfb` | approve/reject idempotency; listConversations ROWID tiebreaker |
| Web hooks | `ed4f5cca` | Extract `useCmoAgent` (one WS shared by `useCmoChat` + `useCmoStub`) — design assumption that `useAgent` dedupes was false |
| Web migration | `7b1a6ca2` `e36aad5e` `1861f2be` `ca7557a2` | `/team`, transcript drawer, `/briefing` × 3, `/growth/reddit-channels` all on `useCmoStub` |
| Cleanup | `ce53bf12` `5bd1d024` | Delete `apps/web/src/lib/mcp-client.ts`, `/api/mcp-token`, browser `@modelcontextprotocol/sdk` dep, apps/core `MCP_ROUTE` regex + `handleMcpRequest` 503 stub |

**Auto-verified on staging:**

- `https://mcp-staging.shipflare.ai/healthz` → 200
- `/.well-known/oauth-authorization-server` → 200 (external `/cmo/mcp` OAuth surface intact)
- `/agents/cmo/x` (WS) → 426 expected (upgrade-required)
- `/agents/cmo/x/mcp` (legacy) → 401 (no JWT will validate this path; effectively dead)
- `https://app-staging.shipflare.ai/api/mcp-token` → 404 (deleted)
- `/team`, `/briefing`, `/growth/reddit-channels` → 307 (auth redirect, expected for unauthenticated curl)

**Interactive smoke — user verification needed.** Open in the local
browser (already authenticated to `app-staging.shipflare.ai` as
`cdhyfpp@gmail.com`):

1. `/team` — left rail shows 3 employee cards; right panel renders
   plan items + drafts; DevTools Network: ONE `wss://mcp-staging.../agents/cmo/<uid>?token=...&tz=...`
2. `/team` — "New conversation" creates a new thread visible in left rail
3. `/team` — send a chat message → CMO responds
4. `/team` — cancel a plan_item → status flips to cancelled
5. `/team` — open a role card → drawer shows employee_log rows
6. `/briefing/today` — pending drafts render; approve flow works
7. `/briefing/plan` — plan items bucketed by week
8. `/briefing/history` — decided drafts render
9. `/growth/reddit-channels` — subreddit list renders (or empty state)

If anything red, file under Task #11 follow-up.

**Tracked debt (post-plan cleanup PRs):**
- CMO.ts at ~1432 lines (CLAUDE.md target 800) — extract `getTools()` or
  `_impl` block to sibling file
- `DraftRow.decision: string | null` could tighten to literal union
- `_rejectDraft.reason` accepted but not persisted (needs schema column)
- `queryRoster` silently coerces non-numeric `founder_context.created_at` to NaN
- 7 stale comments in apps/web referencing `/api/mcp-token` (deleted)
- `apps/web/test/mcp-token.test.ts` only tests JWT helpers — rename to
  `jwt.test.ts`
- Pre-existing: `/team` `handleApproveDraft` passes `approval_queue.id`
  where `draft_id` is expected (silent 'not in approval_queue' error
  toast — predates Task #11)
