# Phase-7-0 verifications — external MCP (OAuth 2.1 + PKCE) for CMO

**Status:** VERIFIED. Integration pattern locked. The 17-day-old Phase 7 plan needs amendments (§8) but the design is sound. Phase 7 implementation is unblocked.

**Scope:** Lock the exact package, transport, route surface, props flow, storage, and DCR posture for the external MCP that exposes CMO via OAuth 2.1 + PKCE. Verify that `withOAuthProvider` (referenced in the original plan) is the wrong import name — the canonical package is `@cloudflare/workers-oauth-provider` and its export is `OAuthProvider` (default + named).

**Sources read:**
- npm: `@cloudflare/workers-oauth-provider` (v0.6.0, published 2026-05-13, in active development by Cloudflare engineers)
- `github.com/cloudflare/workers-oauth-provider/README.md` (full README via `gh api`)
- `github.com/cloudflare/workers-oauth-provider/src/oauth-provider.ts` (apiHandlers validation)
- `github.com/cloudflare/agents/examples/mcp-worker-authenticated/{src/server.ts,wrangler.jsonc}` — `createMcpHandler` + OAuthProvider reference
- `github.com/cloudflare/agents/examples/mcp/{src/server.ts,wrangler.jsonc}` — `McpAgent.serve("/mcp", { binding })` reference
- `github.com/cloudflare/mcp-server-cloudflare/apps/radar/src/radar.app.ts` — production McpAgent + OAuthProvider apiHandlers pattern (the gold standard our Phase 7 should mirror)
- Cloudflare docs: `agents/api-reference/mcp-agent-api/`, `agents/model-context-protocol/transport/`, `agents/model-context-protocol/authorization/`, `agents/guides/test-remote-mcp-server/`
- Existing scaffolding: `apps/core/wrangler.jsonc` (env vars, migrations through v12), `apps/core/.dev.vars.example`, `apps/core/src/index.ts` (503 stub at `handleExternalMcpRequest`)

---

## 1. Canonical package + version

`@cloudflare/workers-oauth-provider@^0.6.0` — published 2026-05-13, actively maintained by Cloudflare, written for Workers (Workers KV-backed token store, end-to-end encrypted `props`, RFC-7591 DCR baked in). Pre-1.0, semver minor bumps may include breaking changes; pin to `0.6.x`.

`withOAuthProvider` from `agents/oauth` — referenced in the original Phase 7 plan — **does not exist**. The plan was speculating against an API that never shipped. The real export is the `OAuthProvider` class from `@cloudflare/workers-oauth-provider`, used as a default export from the Worker (it implements `fetch()` itself).

---

## 2. Transport choice — Streamable HTTP, not SSE

**Use `McpAgent.serve("/cmo/mcp", { binding: "CMO_EXTERNAL_MCP" })`** (Streamable HTTP) as the primary, and optionally also wire `McpAgent.serveSSE("/cmo/sse", { binding: "CMO_EXTERNAL_MCP" })` for legacy clients.

| Transport | Status | Use |
|-----------|--------|-----|
| **Streamable HTTP** (`/mcp`) | Current MCP spec standard since March 2025 | All modern clients (Claude Desktop via `mcp-remote`, Cursor, ChatGPT, Workers AI Playground, MCP Inspector) |
| **SSE** (`/sse`) | **Deprecated** in CF docs, kept for backwards compat | Legacy clients only |

Cloudflare's own production server (`mcp-server-cloudflare/radar`) ships **both** under one `OAuthProvider`'s `apiHandlers` map. We should do the same — Streamable HTTP primary, SSE alias for safety, both wrapped by one OAuth surface.

**Claude Desktop today:** does NOT yet speak the remote transport natively. Connection goes through the `mcp-remote` local proxy:
```jsonc
// ~/Library/Application Support/Claude/claude_desktop_config.json
{
  "mcpServers": {
    "shipflare-cmo": {
      "command": "npx",
      "args": ["mcp-remote", "https://core.shipflare.ai/cmo/mcp"]
    }
  }
}
```
`mcp-remote` performs the OAuth dance browser-side (PKCE + DCR) and proxies to Claude Desktop's stdio. Cursor and Workers AI Playground speak Streamable HTTP natively and connect directly via the URL.

**Naming correction vs. original plan:** the plan used `/cmo/sse/*`. With Streamable HTTP being current, the canonical mount is `/cmo/mcp` (with `/cmo/sse` as the legacy alias). Update Phase 7 task 7.2/7.3 file paths and tests accordingly.

---

## 3. Integration shape — paste-ready

This is the full handler wiring for `apps/core/src/index.ts` to replace `handleExternalMcpRequest`'s 503 stub. Mirrors the `cloudflare/mcp-server-cloudflare/radar` production pattern.

```ts
// apps/core/src/external/CmoExternalMcp.ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpAgent } from "agents/mcp";
import { z } from "zod";
import { getEmployee } from "../agents/lib/get-employee";

// Props shape — populated by OAuthProvider on every authenticated request,
// available via this.props inside init() and tool handlers. Stored in the
// DO's SQLite via Agents SDK plumbing (no manual persistence needed).
interface CmoExternalProps {
  userId: string;          // ShipFlare user id (the "sub" of our OAuth grant)
  username?: string;       // optional, for whoami-style tools
  scopes: string[];        // OAuth grant scopes, e.g. ["cmo:chat"]
}

export class CmoExternalMcp extends McpAgent<Env, unknown, CmoExternalProps> {
  server = new McpServer({
    name: "shipflare-cmo",
    version: "1.0.0",
  });

  async init() {
    // ONE tool only — the LLM-as-MCP-surface design lock.
    // External clients send a natural-language message; CMO's existing
    // internal tools + consult handle the rest.
    this.server.registerTool(
      "chat",
      {
        description:
          "Talk to your ShipFlare CMO. Ask anything — review pending drafts, " +
          "plan today's posts, get strategic guidance. The CMO has full " +
          "access to your team (SMM, HoG) and can act on your behalf.",
        inputSchema: { message: z.string().min(1).max(4000) },
      },
      async ({ message }) => {
        const userId = this.props.userId;
        const stub = getEmployee("cmo", userId, this.env);
        // invokeAsTool runs CMO's onChatMessage synchronously without WS;
        // returns the assistant's final text. (Task 7.1 builds invokeAsTool.)
        const reply = await (stub as any).invokeAsTool("chat", { message });
        return {
          content: [{ type: "text", text: String(reply ?? "") }],
        };
      }
    );
  }
}

// apps/core/src/index.ts — replace handleExternalMcpRequest with this default export
import OAuthProvider from "@cloudflare/workers-oauth-provider";
import { CmoExternalMcp } from "./external/CmoExternalMcp";
import { ExternalAuthHandler } from "./external/auth-handler"; // §5

export { CmoExternalMcp };  // wrangler DO export

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);

    // Existing ShipFlare routes (chat WS, /internal/*, /agents/*, /healthz, ...)
    // run first. The OAuthProvider only owns /cmo/mcp, /cmo/sse, and the
    // OAuth endpoints listed in §4. Everything else falls through.
    if (
      url.pathname.startsWith("/cmo/mcp") ||
      url.pathname.startsWith("/cmo/sse") ||
      url.pathname === "/authorize" ||
      url.pathname === "/oauth/token" ||
      url.pathname === "/oauth/register" ||
      url.pathname.startsWith("/.well-known/oauth-")
    ) {
      return new OAuthProvider({
        apiHandlers: {
          "/cmo/mcp": CmoExternalMcp.serve("/cmo/mcp", { binding: "CMO_EXTERNAL_MCP" }),
          "/cmo/sse": CmoExternalMcp.serveSSE("/cmo/sse", { binding: "CMO_EXTERNAL_MCP" }),
        },
        defaultHandler: ExternalAuthHandler,
        authorizeEndpoint: "/authorize",
        tokenEndpoint: "/oauth/token",
        clientRegistrationEndpoint: "/oauth/register",
        scopesSupported: ["cmo:chat"],
        accessTokenTTL: 3600,           // 1h
        refreshTokenTTL: 60 * 60 * 24 * 30, // 30d
        allowImplicitFlow: false,
        allowPlainPKCE: false,           // S256 only — OAuth 2.1 strict
      }).fetch(req, env, ctx);
    }

    return routeRequest(req, env, ctx, url); // existing ShipFlare routing
  },
};
```

**Single-tool surface decision** — the original Phase 7.2 plan exposed `approve_draft`, `schedule_post`, etc. as separate MCP tools. This is superseded by the chat-only design (see [[feedback_external_mcp_chat_surface]]). The CMO LLM already knows how to interpret natural-language intent and invoke its own internal tools — exposing a second tool surface doubles the maintenance and confuses the LLM about which path to use. ONE `chat(message)` tool.

---

## 4. Route surface — what OAuthProvider owns

| Path | Owner | Method | Purpose |
|------|-------|--------|---------|
| `/.well-known/oauth-authorization-server` | OAuthProvider | GET | RFC 8414 server metadata (auto-implemented from constructor config) |
| `/.well-known/oauth-protected-resource` | OAuthProvider | GET | RFC 9728 resource metadata |
| `/oauth/token` | OAuthProvider | POST | RFC 6749 §3.2 token exchange + RFC 6749 §6 refresh |
| `/oauth/register` | OAuthProvider | POST | RFC 7591 dynamic client registration |
| `/authorize` | **Our app** (`defaultHandler`) | GET | Authorization consent UI — we render it; OAuthProvider just announces the URL in `.well-known` |
| `/cmo/mcp` and `/cmo/mcp/*` | OAuthProvider → `apiHandlers["/cmo/mcp"]` | POST/GET | Streamable HTTP MCP transport; Bearer token validated before forwarding to `CmoExternalMcp.serve(...)` |
| `/cmo/sse` and `/cmo/sse/*` | OAuthProvider → `apiHandlers["/cmo/sse"]` | GET | SSE transport (legacy); same auth gate |
| Everything else | `defaultHandler` | * | Falls through to `ExternalAuthHandler` — which should 404 for anything not on the auth UI path, so our existing ShipFlare router stays unaffected |

**Crucial — OAuthProvider does NOT own all paths under the same domain.** Only the listed routes. Our top-level fetch handler runs the OAuthProvider for matching paths ONLY (see §3 snippet). Existing routes (`/healthz`, `/agents/cmo/<uid>` WS, `/internal/*`, `/agents/<role>/<uid>/mcp` Phase-1 internal MCP) flow through `routeRequest` untouched.

**Why we can't use the simpler "export default new OAuthProvider({...})" pattern** that the CF docs example uses: ShipFlare's worker has many non-OAuth surfaces (the AIChatAgent WS for the browser, internal RPC, healthcheck). Wrapping the entire worker in OAuthProvider would route everything through it, with `defaultHandler` having to dispatch to the rest of the app. We invert: dispatch first, hand OAuth-relevant paths to OAuthProvider second.

---

## 5. props.userId flow — exactly how the OAuth subject reaches `this.props.userId`

There is **no automatic `sub` → `props.userId` mapping**. We populate `props` explicitly in our auth handler when we call `env.OAUTH_PROVIDER.completeAuthorization()`. The provider then end-to-end-encrypts those props into the issued access token, and on every authenticated API request decrypts them and exposes them as `this.props` inside the McpAgent.

### Flow

```
1. MCP client POSTs to /cmo/mcp without a token
   → OAuthProvider returns 401 with WWW-Authenticate hinting at /.well-known/oauth-authorization-server.

2. Client fetches metadata, discovers /authorize, /oauth/token, /oauth/register.

3. Client POSTs to /oauth/register (DCR) → OAuthProvider auto-handles, returns client_id.

4. Client redirects user-agent to /authorize?response_type=code&client_id=...&code_challenge=...&...
   → OAuthProvider routes to defaultHandler (ExternalAuthHandler).

5. ExternalAuthHandler.fetch():
   a. Reads ShipFlare session cookie from the inbound /authorize request (the user is
      already logged into shipflare.ai — that cookie identifies them as user U).
   b. Calls env.OAUTH_PROVIDER.parseAuthRequest(request) → oauthReqInfo.
   c. Calls env.OAUTH_PROVIDER.lookupClient(oauthReqInfo.clientId).
   d. Renders a "Authorize Claude Desktop to chat with your CMO?" consent page.
   e. On approval, calls env.OAUTH_PROVIDER.completeAuthorization({
        request: oauthReqInfo,
        userId: U.id,                              // <-- the OAuth grant subject
        scope: ["cmo:chat"],
        metadata: { clientName: clientInfo.client_name },
        props: {                                   // <-- becomes this.props on McpAgent
          userId: U.id,
          username: U.username,
          scopes: ["cmo:chat"],
        },
      }) → returns { redirectTo }.
   f. 302 redirect to redirectTo (client's redirect_uri with auth code).

6. Client POSTs to /oauth/token with code + code_verifier → OAuthProvider mints
   access token (encrypts the props payload into it). Returns access_token + refresh_token.

7. Client POSTs to /cmo/mcp with Authorization: Bearer <access_token>.
   OAuthProvider:
     - validates Bearer, decrypts props, attaches to request.
     - forwards to apiHandlers["/cmo/mcp"] which is CmoExternalMcp.serve(...).
     - the Agents SDK plumbing puts the decrypted props onto this.props of
       the CmoExternalMcp DO instance (DO id derived from props.userId via
       McpAgent's internal session keying, so each ShipFlare user gets their
       own CmoExternalMcp instance).

8. Inside init() / tool handlers: this.props.userId is available and is
   passed to getEmployee("cmo", userId, env) to reach the real CMO DO.
```

### Why this is safe

- Props are **end-to-end encrypted** inside the access token (per the README's security model). The KV store holds only hashes, not plaintext props.
- The decrypted `props.userId` is set by us in step 5e — it's not "claimed by the client" — so a malicious client cannot inject a different userId.
- `props` is type-safe via `McpAgent<Env, State, CmoExternalProps>` (third generic).

### What about ShipFlare's existing `MCP_OAUTH_JWT_SIGNING_KEY` (Phase 0)?

It's **not used by `@cloudflare/workers-oauth-provider`**. The package mints + validates its own opaque bearer tokens stored in `OAUTH_KV`, no JWT signing required. The Phase-0-scaffolded `MCP_OAUTH_JWT_SIGNING_KEY` secret is dead code under the chat-only design and should be removed (see §8 spec drift item 4).

`MCP_OAUTH_AUDIENCE = mcp.shipflare.com` is also unused — OAuthProvider doesn't take an `audience` config. The audience is implicit (it's whichever Worker is handling the request). Remove from `wrangler.jsonc` + `.dev.vars.example` in Phase 7.0a.

---

## 6. Storage — `OAUTH_KV` KV namespace + DO binding

### KV namespace (NEW)

OAuthProvider requires exactly one KV binding, **named `OAUTH_KV`**. The name is hardcoded in the library — it reads `env.OAUTH_KV` directly, you cannot configure it. Stores:

- Encrypted grant records (one per (user, client) pair)
- Refresh token metadata (hashes only, never plaintext)
- DCR client registrations (hashes of client_secret only)
- Access token TTLs

D1 is **not** an option — KV is hardcoded. Our existing D1 (`shipflare-db`) is unaffected.

### DO binding (NEW)

`CMO_EXTERNAL_MCP` binding to the `CmoExternalMcp` class. Each ShipFlare user gets one instance, keyed off `props.userId` via Agents SDK session plumbing.

### wrangler.jsonc delta

```jsonc
// Append to apps/core/wrangler.jsonc

// New KV namespace — create with:
//   pnpm exec wrangler kv namespace create OAUTH_KV
//   pnpm exec wrangler kv namespace create OAUTH_KV --preview
"kv_namespaces": [
  {
    "binding": "OAUTH_KV",
    "id": "<from `wrangler kv namespace create OAUTH_KV` output>",
    "preview_id": "<from `--preview` output>"
  }
],

// Append to existing durable_objects.bindings
"durable_objects": {
  "bindings": [
    // ... existing CMO, HoG, SMM, XMcpAgent, RedditMcpAgent ...
    { "name": "CMO_EXTERNAL_MCP", "class_name": "CmoExternalMcp" }
  ]
},

// Append to existing migrations (next free tag is v13; v12 was CMO drop+recreate)
"migrations": [
  // ... v1..v12 ...
  { "tag": "v13", "new_sqlite_classes": ["CmoExternalMcp"] }
],
```

Add to `Env` type in `apps/core/src/index.ts`:
```ts
CMO_EXTERNAL_MCP: DurableObjectNamespace<
  import("./external/CmoExternalMcp").CmoExternalMcp
>;
OAUTH_KV: KVNamespace;
```

### Cron-trigger cleanup (recommended, optional for v1)

OAuthProvider exposes `purgeExpiredData(env, { batchSize })` for defense-in-depth cleanup of orphaned KV records. Add a 24h cron in Phase 7.5+:

```jsonc
"triggers": {
  "crons": ["0 6 * * *"]  // 6am UTC daily
}
```

```ts
// inside the default export
async scheduled(event: ScheduledController, env: Env, ctx: ExecutionContext) {
  // ... existing cron handlers (none today) ...
  const oauth = /* same OAuthProvider config as fetch path */;
  await oauth.purgeExpiredData(env, { batchSize: 100 });
}
```

Defer to Phase 7.6 — KV TTLs handle expiry alone; `purgeExpiredData` is belt-and-suspenders.

---

## 7. Dynamic Client Registration (RFC 7591)

**Built-in. No founder-side UI required.**

Setting `clientRegistrationEndpoint: "/oauth/register"` in the OAuthProvider config makes the library implement the endpoint itself. Behavior:

- Public DCR is **enabled by default** (`disallowPublicClientRegistration: false`). Any MCP client (Claude Desktop via `mcp-remote`, Cursor, MCP Inspector) can POST to `/oauth/register` with its metadata, get back a `client_id`, and proceed to `/authorize`.
- Default client TTL is **90 days** (`clientRegistrationTTL: 7776000`). After 90 days of no use, the client registration is GC'd. The MCP client just re-registers on next connect — invisible to the user.
- Stored hashes only (no plaintext `client_secret`).

### Impact on Phase 7.4 ("manual external MCP registration UI")

The original Phase 7 plan reserved a task for a `/settings/external-mcp` UI to manually register clients. **That task is unnecessary for v1.** DCR makes it transparent — Claude Desktop auto-registers, the user just clicks "Authorize" once on the consent screen.

A `/settings/external-mcp` UI is still useful **post-v1** for:
- Listing the user's active grants ("ShipFlare CMO is connected to: Claude Desktop, Cursor")
- Revoking individual grants (`env.OAUTH_PROVIDER.revokeGrant(grantId)`)
- Showing the `mcp-remote` connection snippet for Claude Desktop config

But these are revocation/observability features, not registration. Defer to Phase 7.5+ or post-Phase-7 polish.

---

## 8. Spec drift vs. the original Phase 7 plan

The Phase 7 section of `docs/superpowers/plans/2026-05-16-cf-native-chat-migration.md` (lines 2056-2310) needs the following amendments. Apply during Phase 7.0 (before any 7.1 work).

| # | Plan reference | Issue | Fix |
|---|----------------|-------|-----|
| 1 | Task 7.3 Step 3: `import { withOAuthProvider } from 'agents/oauth';` | Non-existent export. The package is `@cloudflare/workers-oauth-provider`, export is `OAuthProvider` (default + named). | Replace import + the entire `withOAuthProvider({ audience, signingKey, apiHandler })` block with `new OAuthProvider({ apiHandlers, defaultHandler, authorizeEndpoint, tokenEndpoint, clientRegistrationEndpoint })` — see §3 snippet. |
| 2 | Task 7.2 Step 5: curated subset of tools (`approve_draft`, `schedule_post`) registered separately | Superseded by the chat-only design lock ([[feedback_external_mcp_chat_surface]]). | One tool: `chat(message: string)`. Use `invokeAsTool("chat", { message })` to bridge to CMO's onChatMessage. Remove `approve_draft` / `schedule_post` registrations. |
| 3 | Routes `/cmo/sse/*` throughout 7.2 and 7.3 | SSE is deprecated. Current standard is Streamable HTTP via `/mcp`. | Primary mount: `/cmo/mcp` (Streamable HTTP via `McpAgent.serve`). Keep `/cmo/sse` as a legacy alias in the same OAuthProvider's `apiHandlers` map. Update all test paths from `/cmo/sse/tools/list` to `/cmo/mcp` (or hit the MCP Inspector instead — tests are easier with `@modelcontextprotocol/sdk`'s client). |
| 4 | Phase-0 scaffold: `MCP_OAUTH_JWT_SIGNING_KEY` + `MCP_OAUTH_AUDIENCE` in `wrangler.jsonc` + `.dev.vars.example` | Unused under the canonical package — OAuthProvider mints opaque tokens, no JWT signing key needed; no audience config. | Remove both env vars in a Phase-7.0a cleanup commit. Replace with `OAUTH_KV` KV namespace binding (§6). |
| 5 | Task 7.3 mintTestToken helper signs a JWT | OAuthProvider doesn't accept hand-signed JWTs. | Test setup mints a real grant via `env.OAUTH_PROVIDER.createClient()` + an internal helper that wraps `completeAuthorization` synthetically. Or use the MCP Inspector with its built-in OAuth flow. Provide a `mintTestAccessToken(env, userId)` helper in `test/helpers/oauth.ts`. |
| 6 | Task 7.1 (`invokeAsTool`) registers via `@callable()` decorator and accesses `getTools()` | `getTools()` doesn't exist on `AIChatAgent` directly. Tools live in the agent's MCP-server tool registry, accessed via `this.server.tool(...)` registrations or the agent's `tools` property. | Update Task 7.1 to: build `invokeAsTool` as a regular method (no `@callable` — that's for client-side RPC, not server-internal use), and route it through `this.onChatMessage` rather than tool-by-name dispatch. The synthetic-turn pattern verified in Phase-0c (`saveMessages`-based) is the right primitive. See [[2026-05-17-phase-0c-verifications]] §5 for the exact saveMessages call. |
| 7 | Task 7.2 inputSchema `{ draftId: z.string() }` etc. | Each tool's schema becomes irrelevant under the chat-only design. | Delete. The only schema is `{ message: z.string().min(1).max(4000) }`. |
| 8 | No mention of KV namespace or `OAUTH_KV` binding | OAuthProvider requires it; deployment will fail without it. | Add KV creation + binding to a Phase-7.0a setup task BEFORE 7.1 (the test can't even run without `env.OAUTH_KV`). |
| 9 | No mention of `compatibility_date` requirement | OAuthProvider 0.6.0 needs a recent runtime. | Verify `compatibility_date: 2026-05-01` (current value in `apps/core/wrangler.jsonc:5`) is sufficient. Bump to today's date (`2026-05-18`) if 0.6.0 release notes call out a newer minimum (none observed). |
| 10 | No `mcp-remote` Claude Desktop connection test in test plan | The real-browser smoke test misses Claude Desktop's actual onboarding path. | Add: after Phase 7 lands, install `mcp-remote` locally, point Claude Desktop at `https://core.shipflare.ai/cmo/mcp`, complete the OAuth dance in the browser, send a test `chat("what's my plan today?")`, verify the CMO replies. Capture screenshots for the merge PR. |

**Net impact:** the original plan's three tasks (7.1 `invokeAsTool`, 7.2 `CmoExternalMcp` class, 7.3 OAuth wrapper) survive in shape but the contents change substantially. A revised Phase 7 task list emerges:

- **7.0a** (NEW) — Replace Phase-0 scaffold: drop `MCP_OAUTH_JWT_SIGNING_KEY` + `MCP_OAUTH_AUDIENCE`; add `OAUTH_KV` KV namespace + binding; add `CMO_EXTERNAL_MCP` DO binding + v13 migration.
- **7.1** — `CMO.invokeAsTool("chat", { message })` — calls `this.saveMessages` (synthetic user turn), reads back the resulting assistant message, returns its text. Mirrors the Phase-0c relay pattern but synchronously awaits the assistant reply (or streams via a writer ref).
- **7.2** — `CmoExternalMcp` class with the single `chat` tool that forwards via `invokeAsTool`. No curated subset of tools.
- **7.3** — `OAuthProvider` mount at `/cmo/mcp` (+ optional `/cmo/sse` alias). Replace the 503 stub at `handleExternalMcpRequest`. Add `ExternalAuthHandler` for `/authorize` consent UI (reuses ShipFlare session cookie auth).
- **7.4** (was: manual registration UI) — **Renamed**: Grant management UI under `/settings/external-mcp` showing active grants + revoke. DCR makes registration auto. **Defer to Phase 7.6** if Phase 7.5 (real-browser test) reveals it's not needed for v1.
- **7.5** — Real-browser smoke test: Claude Desktop + `mcp-remote` → OAuth flow → `chat()` tool call.
- **7.6** (NEW, optional) — Cron-trigger calling `oauth.purgeExpiredData(env, { batchSize: 100 })` every 24h.

---

## 9. Open questions for the founder

1. **Audience: which clients first?**
   The chat-only surface works for any LLM-backed MCP host (Claude Desktop, Cursor, ChatGPT, custom GPTs, MCP Inspector). Should Phase 7.5's real-browser smoke test verify **just Claude Desktop via `mcp-remote`**, or also Cursor (which speaks Streamable HTTP natively, so it's a different code path)? Verifying both catches a class of bugs Claude-only testing would miss, but doubles the test runtime.

2. **DCR posture — public or confidential clients?**
   Default `disallowPublicClientRegistration: false` lets any MCP client auto-register. Alternative: `disallowPublicClientRegistration: true` would force confidential clients (a `client_secret` is issued, which Claude Desktop's `mcp-remote` would need to store somewhere). Public is simpler and matches every MCP server reference example I read. **Recommendation: default (public).** Confirm or override.

3. **Consent screen branding.**
   `/authorize` is fully ours to render. Options:
   - Bare-bones: "Allow Claude Desktop to chat with your ShipFlare CMO?" → [Authorize] / [Deny]. Minimum viable.
   - Detailed: show the client name, requested scopes ("read your strategic plan, draft posts, approve/schedule on your behalf"), session timeline ("this connection lasts 30 days").
   - Match `/settings` visual style.
   **Recommendation: bare-bones for v1**, beef up post-launch when there's any user friction. Confirm.

4. **Should we kill `/cmo/sse` entirely and only ship Streamable HTTP?**
   SSE is deprecated. Every modern MCP client speaks Streamable HTTP. SSE is purely for legacy compat with clients that haven't migrated. **Recommendation: ship `/cmo/mcp` only; add SSE later if a real user reports a stuck client.** Saves ~5 lines and one route. Confirm.

5. **`/settings/external-mcp` UI — Phase 7 or post-Phase 7?**
   DCR + the 30-day refresh tokens + auto-renew means the only practical reason a user enters this UI is to revoke a connection. That's a low-frequency action and can ship in a follow-up. **Recommendation: defer to post-Phase-7 polish.** Confirm.

6. **JWT signing key + audience scaffolding — confirm safe to remove.**
   `MCP_OAUTH_JWT_SIGNING_KEY` (secret) + `MCP_OAUTH_AUDIENCE` (env var) in `wrangler.jsonc` + `.dev.vars.example` were Phase-0-staged for an API the canonical package doesn't expose. Confirm we can remove them in Phase 7.0a, or keep as forward-compat placeholders for a future migration off `@cloudflare/workers-oauth-provider`.
