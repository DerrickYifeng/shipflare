# Phase 7 — External MCP for CMO (OAuth 2.1 + PKCE)

> **For agentic workers:** REQUIRED SUB-SKILL: `superpowers:subagent-driven-development` to implement task-by-task. Fresh implementer subagent per task (model: `opus`), spec-compliance reviewer (opus), code-quality reviewer (opus).

**Goal:** Expose CMO to external MCP clients (Claude Desktop, Cursor, custom LLM stacks) via OAuth 2.1 + PKCE. ONE tool only — `chat(message)` — the CMO LLM orchestrates everything via its existing internal tools + `consult`.

**Architecture:** `@cloudflare/workers-oauth-provider@^0.6.0` wraps `CmoExternalMcp.serve("/cmo/mcp", { binding })`. New DO `CmoExternalMcp` forwards `chat` invocations to the real CMO via a new internal `invokeAsTool` method (synthetic-turn pattern from Phase-0c).

**Spec / verifications:** `docs/superpowers/specs/2026-05-18-phase-7-verifications.md`. Original 17-day-old Phase 7 section of `2026-05-16-cf-native-chat-migration.md` (lines 2056-2310) is superseded by this doc.

**Tech Stack:** `@cloudflare/workers-oauth-provider@^0.6.0`, `@modelcontextprotocol/sdk@^1.29.0` (already installed), `agents@0.12.4` (already installed, McpAgent + McpServer), Workers KV (new `OAUTH_KV` binding), Durable Object (new `CmoExternalMcp` class, v13 migration).

**Branch:** `feat/phase-7-external-mcp` (already created from `dev`).

---

## Locked decisions (Phase-7-0 brainstorming Q&A)

| # | Decision | Rationale |
|---|---|---|
| D1 | OAuth 2.1 + PKCE via `@cloudflare/workers-oauth-provider` | Canonical package; client-compatible with Claude Desktop (`mcp-remote`), Cursor, ChatGPT, MCP Inspector |
| D2 | ONE tool — `chat(message: string)` | `[[feedback_external_mcp_chat_surface]]` — let CMO LLM orchestrate via internal tools |
| D3 | Streamable HTTP at `/cmo/mcp` (NO SSE alias) | Current MCP spec; SSE deprecated. SSE can be added later if a real user reports a stuck client |
| D4 | Public clients (DCR default-on, `disallowPublicClientRegistration: false`) | Matches every MCP server reference. Claude Desktop auto-registers via DCR |
| D5 | Delete dead Phase-0 env (`MCP_OAUTH_JWT_SIGNING_KEY`, `MCP_OAUTH_AUDIENCE`) | OAuthProvider uses opaque tokens; no JWT signing required. Audience is implicit |
| D6 | NO `/settings/external-mcp` UI for v1 | DCR + 30-day refresh tokens means user rarely touches settings. Endpoint URL goes in README |
| D7 | Bare-bones consent screen | Just "Allow X to chat with your ShipFlare CMO?" + Authorize/Deny. Polish post-v1 |
| D8 | Manual smoke test only (Claude Desktop via `mcp-remote`) | No automated Playwright for the OAuth dance. Real-browser run after merge |

---

## Execution mode

Per `feedback_phase_level_review_for_long_plans`:
- Per task: implementer (opus) → spec-compliance reviewer (opus) → code-quality reviewer (opus)
- Apply review follow-ups inline
- Tick checkboxes here, commit `docs(plan): tick N` for major checkpoints
- All work on `feat/phase-7-external-mcp`

---

## File structure

**New files (6):**

```
apps/core/src/external/
├── CmoExternalMcp.ts                       # NEW — McpAgent DO with single chat tool
└── auth-handler.ts                          # NEW — /authorize consent UI handler

apps/core/test/external/
├── cmo-external-mcp-chat.test.ts            # NEW — chat tool unit test (dry-run seam)
├── cmo-invoke-as-tool.test.ts               # NEW — CMO.invokeAsTool integration test
└── auth-handler.test.ts                     # NEW — /authorize handler

apps/core/test/helpers/
└── oauth.ts                                 # NEW — mintTestAccessToken helper (skips real OAuth dance in vitest)
```

**Modified files (6):**

```
apps/core/src/agents/cmo/CMO.ts              # +invokeAsTool method (synthetic user turn → assistant reply)
apps/core/src/index.ts                       # OAuthProvider mount; delete handleExternalMcpRequest 503 stub; delete dead env types
apps/core/wrangler.jsonc                     # +OAUTH_KV binding, +CMO_EXTERNAL_MCP DO, +v13 migration; -MCP_OAUTH_JWT_SIGNING_KEY/AUDIENCE
apps/core/.dev.vars.example                  # -MCP_OAUTH_JWT_SIGNING_KEY, -MCP_OAUTH_AUDIENCE
apps/core/package.json                       # +@cloudflare/workers-oauth-provider
README.md                                    # +External MCP section with mcp-remote / Cursor setup snippets
docs/superpowers/plans/2026-05-16-cf-native-chat-migration-RESUME.md  # Phase 7 → DONE
```

---

# Task 7.0a — Setup: install package, drop dead env, add KV + DO bindings

**Why first:** Phase 7.1+ tests need `env.OAUTH_KV` + `env.CMO_EXTERNAL_MCP` to exist, and the dead Phase-0 env vars cause type confusion. Land all infra changes in one commit before any code.

**Files:**
- Modify: `apps/core/package.json`, `apps/core/wrangler.jsonc`, `apps/core/.dev.vars.example`, `apps/core/src/index.ts` (Env type only)

## Steps

- [ ] **Step 1:** Install `@cloudflare/workers-oauth-provider`:

```bash
cd /Users/yifeng/Documents/Code/shipflare
pnpm --filter @shipflare/core add @cloudflare/workers-oauth-provider@^0.6.0
```

- [ ] **Step 2:** Create the `OAUTH_KV` KV namespace (production + preview):

```bash
pnpm --filter @shipflare/core exec wrangler kv namespace create OAUTH_KV
# Copy the "id" output
pnpm --filter @shipflare/core exec wrangler kv namespace create OAUTH_KV --preview
# Copy the "preview_id" output
```

If the user is offline, document the placeholder IDs (`<TBD-id>`, `<TBD-preview-id>`) and proceed. The wrangler config can be filled in after the namespaces are created.

- [ ] **Step 3:** Modify `apps/core/wrangler.jsonc`:
  - **Add** `kv_namespaces: [{ binding: "OAUTH_KV", id: "<production>", preview_id: "<preview>" }]`
  - **Add** to `durable_objects.bindings`: `{ "name": "CMO_EXTERNAL_MCP", "class_name": "CmoExternalMcp" }`
  - **Append** to `migrations`: `{ "tag": "v13", "new_sqlite_classes": ["CmoExternalMcp"] }`
  - **Remove** `vars.MCP_OAUTH_AUDIENCE`
  - **Confirm** `compatibility_date >= 2026-05-01` (current `apps/core/wrangler.jsonc:5`)

- [ ] **Step 4:** Modify `apps/core/.dev.vars.example`:
  - **Remove** `MCP_OAUTH_JWT_SIGNING_KEY=` line + its surrounding comment block
  - **Remove** `MCP_OAUTH_AUDIENCE=mcp.shipflare.com` line + its surrounding comment block
  - **Keep** `MCP_JWT_SECRET` (still used by browser-session JWTs)

- [ ] **Step 5:** Modify the `Env` interface in `apps/core/src/index.ts`:
  - **Remove** `MCP_OAUTH_JWT_SIGNING_KEY: string;`
  - **Remove** `MCP_OAUTH_AUDIENCE: string;`
  - **Add** `OAUTH_KV: KVNamespace;`
  - **Add** `CMO_EXTERNAL_MCP: DurableObjectNamespace<import("./external/CmoExternalMcp").CmoExternalMcp>;`

- [ ] **Step 6:** Verify the build still compiles (CmoExternalMcp doesn't exist yet, so type-only import will fail unless we stub):

```bash
pnpm --filter @shipflare/core exec tsc --noEmit
```

Expected: errors about `./external/CmoExternalMcp` module not found. That's OK — Task 7.2 creates it. To keep this task atomic and green, **create a temporary stub** at `apps/core/src/external/CmoExternalMcp.ts`:

```typescript
// Phase 7.2 will replace this stub with the real implementation.
import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Env } from "../index";

interface CmoExternalProps {
	userId: string;
}

export class CmoExternalMcp extends McpAgent<Env, unknown, CmoExternalProps> {
	server = new McpServer({ name: "shipflare-cmo", version: "0.0.0-stub" });
	async init(): Promise<void> {}
}
```

- [ ] **Step 7:** Verify:

```bash
pnpm --filter @shipflare/core exec tsc --noEmit; echo "exit:$?"
pnpm --filter @shipflare/core exec vitest run 2>&1 | tail -3
```

Expected: tsc exit 0; all 163 existing tests still pass (no test touches dead env vars or the stub).

- [ ] **Step 8:** Commit:

```bash
git add apps/core/package.json pnpm-lock.yaml \
        apps/core/wrangler.jsonc apps/core/.dev.vars.example \
        apps/core/src/index.ts apps/core/src/external/CmoExternalMcp.ts
git commit -m "chore: install workers-oauth-provider; drop dead Phase-0 OAuth env; scaffold CmoExternalMcp stub (7.0a)"
```

**Acceptance:** Build green, tests green, infra ready for 7.1+.

---

# Task 7.1 — `CMO.invokeAsTool` callable

**Files:**
- Modify: `apps/core/src/agents/cmo/CMO.ts` (add `invokeAsTool` method)
- Create: `apps/core/test/external/cmo-invoke-as-tool.test.ts`

**Background:** The external MCP needs a synchronous one-shot way to send a message to CMO and get the assistant's final reply text — without spinning up a WS / chat stream. Phase-0c verified `saveMessages` is the API for synthetic turns. We extend that pattern: instead of a system-role message (which `runRelayTurn` uses for autonomous turns), `invokeAsTool` injects a **user-role** message (representing the external client's question), waits for the assistant's reply to land, and returns its text.

## Steps

- [ ] **Step 1:** Write the failing test (`apps/core/test/external/cmo-invoke-as-tool.test.ts`, 2-space):

```typescript
import { describe, it, expect } from "vitest";
import { env, runInDurableObject } from "cloudflare:test";
import { applyCmoSchema } from "../../src/agents/cmo/schema";
import type { CMO } from "../../src/agents/cmo/CMO";

describe("CMO.invokeAsTool", () => {
  it("appends a user-role message and returns assistant reply text (dry-run mode)", async () => {
    const userId = "iat-1";
    const stub = env.CMO.getByName(`streamable-http:${userId}`);
    await runInDurableObject<CMO, void>(stub, async (_inst, state) => {
      applyCmoSchema(state.storage.sql);
      state.storage.sql.exec(
        "INSERT INTO founder_context (key, value) VALUES (?, ?)",
        "productName", "TestProd",
      );
    });

    await runInDurableObject<CMO, void>(stub, async (instance) => {
      // Dry-run: skip the actual LLM call, return a canned reply. Mirrors
      // the alarm() dry-run seam from 5.1c.13.
      (instance as unknown as { _invokeAsToolDryRun?: string })._invokeAsToolDryRun =
        "Today I queued 2 reply drafts on X.";

      const reply = await (instance as unknown as {
        invokeAsTool: (tool: "chat", args: { message: string }) => Promise<string>;
      }).invokeAsTool("chat", { message: "What did you do today?" });

      expect(reply).toBe("Today I queued 2 reply drafts on X.");
    });
  });

  it("rejects unknown tool names", async () => {
    const userId = "iat-2";
    const stub = env.CMO.getByName(`streamable-http:${userId}`);
    await runInDurableObject<CMO, void>(stub, async (_inst, state) => applyCmoSchema(state.storage.sql));

    await runInDurableObject<CMO, void>(stub, async (instance) => {
      await expect(
        (instance as unknown as {
          invokeAsTool: (tool: string, args: unknown) => Promise<unknown>;
        }).invokeAsTool("nonexistent_tool" as never, {}),
      ).rejects.toThrow(/unknown tool/i);
    });
  });
});
```

- [ ] **Step 2:** Run, observe failure:

```bash
cd /Users/yifeng/Documents/Code/shipflare
pnpm --filter @shipflare/core exec vitest run test/external/cmo-invoke-as-tool.test.ts 2>&1 | tail -10
```

- [ ] **Step 3:** Implement `invokeAsTool` in `apps/core/src/agents/cmo/CMO.ts`. Place near `runRelayTurn` (tabs):

```typescript
	/**
	 * 7.1 — One-shot synchronous tool dispatch for external MCP callers.
	 *
	 * Currently supports `chat`: appends a user-role message + drives an
	 * LLM turn via `saveMessages` (function form, same primitive as
	 * `runRelayTurn`), then reads back the resulting assistant message and
	 * returns its text. No WS/streaming; external callers want a JSON reply.
	 *
	 * Dry-run seam: if `this._invokeAsToolDryRun` is set, returns it as the
	 * reply and skips the LLM call. Used by `cmo-invoke-as-tool.test.ts`
	 * (vi.mock can't propagate into the worker bundle per the resume note).
	 *
	 * Returns the assistant's reply text. Throws on unknown tool name or
	 * if saveMessages reports a non-completed status.
	 */
	async invokeAsTool(
		tool: "chat",
		args: { message: string },
	): Promise<string> {
		if (tool !== "chat") {
			throw new Error(`invokeAsTool: unknown tool '${tool}'`);
		}
		this.ensureSchema();

		const dryRun = (this as unknown as { _invokeAsToolDryRun?: string })._invokeAsToolDryRun;
		if (dryRun !== undefined) {
			return dryRun;
		}

		const userMessage: UIMessage = {
			id: `external-${crypto.randomUUID()}`,
			role: "user",
			parts: [{ type: "text", text: args.message }],
			metadata: { source: "external-mcp", firedAt: Date.now() },
		};
		const result = await this.saveMessages((current) => [...current, userMessage]);
		if (result.status !== "completed") {
			throw new Error(`invokeAsTool: saveMessages returned status='${result.status}'`);
		}

		// Find the assistant reply that landed after our user message. The
		// last assistant message in this.messages is the response — saveMessages
		// has already persisted both the user turn and the assistant turn.
		const messages = this.messages;
		for (let i = messages.length - 1; i >= 0; i--) {
			const m = messages[i];
			if (m?.role === "assistant") {
				return extractText(m);
			}
		}
		throw new Error("invokeAsTool: no assistant reply found");
	}
```

Add helper at the top of the file (or in a shared utility file):

```typescript
function extractText(message: UIMessage): string {
	const parts = message.parts ?? [];
	const texts: string[] = [];
	for (const p of parts) {
		if (p && typeof p === "object" && (p as { type?: string }).type === "text") {
			texts.push((p as { text?: string }).text ?? "");
		}
	}
	return texts.join("");
}
```

- [ ] **Step 4:** Verify:

```bash
pnpm --filter @shipflare/core exec vitest run test/external/cmo-invoke-as-tool.test.ts test/cmo-alarm.test.ts test/cmo-mirror-draft.test.ts test/cmo-internal.test.ts 2>&1 | tail -15
pnpm --filter @shipflare/core exec tsc --noEmit; echo "exit:$?"
```

Expected: 2 new tests + existing CMO tests still green; tsc 0.

- [ ] **Step 5:** Commit:

```bash
git add apps/core/src/agents/cmo/CMO.ts apps/core/test/external/cmo-invoke-as-tool.test.ts
git commit -m "feat(cmo): invokeAsTool synchronous tool dispatch for external MCP (7.1)"
```

---

# Task 7.2 — `CmoExternalMcp` DO with the single `chat` tool

**Files:**
- Replace: `apps/core/src/external/CmoExternalMcp.ts` (the stub from 7.0a)
- Create: `apps/core/test/external/cmo-external-mcp-chat.test.ts`

## Steps

- [ ] **Step 1:** Write the failing test (`apps/core/test/external/cmo-external-mcp-chat.test.ts`, 2-space):

```typescript
import { describe, it, expect } from "vitest";
import { env, runInDurableObject } from "cloudflare:test";
import { applyCmoSchema } from "../../src/agents/cmo/schema";
import type { CmoExternalMcp } from "../../src/external/CmoExternalMcp";
import type { CMO } from "../../src/agents/cmo/CMO";

describe("CmoExternalMcp", () => {
  it("registers exactly one tool: chat", async () => {
    const stub = env.CMO_EXTERNAL_MCP.get(env.CMO_EXTERNAL_MCP.idFromName("ext-mcp-1"));
    // Bootstrap props by hitting the tools/list endpoint.
    const res = await stub.fetch(
      new Request("https://internal/cmo/mcp", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "mcp-session-id": "test-1",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/list",
          params: {},
        }),
      }),
    );
    // Streamable HTTP returns text/event-stream; parse the data: line.
    const body = await res.text();
    expect(body).toMatch(/"name":"chat"/);
    // No second tool name should appear.
    expect(body).not.toMatch(/"name":"approve_draft"/);
  });

  it("chat tool forwards to internal CMO via invokeAsTool", async () => {
    const userId = "ext-mcp-2";

    // Bootstrap CMO schema + dry-run reply
    const cmoStub = env.CMO.getByName(`streamable-http:${userId}`);
    await runInDurableObject<CMO, void>(cmoStub, async (_inst, state) => {
      applyCmoSchema(state.storage.sql);
      state.storage.sql.exec(
        "INSERT INTO founder_context (key, value) VALUES (?, ?)",
        "productName", "TestProd",
      );
    });

    const extStub = env.CMO_EXTERNAL_MCP.get(env.CMO_EXTERNAL_MCP.idFromName(userId));
    // Seed props (in production OAuthProvider sets these; in test we set them directly).
    await runInDurableObject<CmoExternalMcp, void>(extStub, async (instance) => {
      (instance as unknown as { _testProps?: { userId: string } })._testProps = { userId };
    });

    // Seed the CMO's dry-run reply (the chat tool's path eventually calls
    // invokeAsTool on the real CMO).
    await runInDurableObject<CMO, void>(cmoStub, async (instance) => {
      (instance as unknown as { _invokeAsToolDryRun?: string })._invokeAsToolDryRun = "Hello from CMO";
    });

    const res = await extStub.fetch(
      new Request("https://internal/cmo/mcp", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "mcp-session-id": "test-2",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: { name: "chat", arguments: { message: "How was today?" } },
        }),
      }),
    );
    const body = await res.text();
    expect(body).toContain("Hello from CMO");
  });
});
```

- [ ] **Step 2:** Run, observe failure (chat tool not yet registered, props not piped).

- [ ] **Step 3:** Replace the stub in `apps/core/src/external/CmoExternalMcp.ts` (tabs):

```typescript
import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Env } from "../index";

/**
 * Per-user external MCP DO. Each ShipFlare user gets one instance, keyed
 * off `props.userId` via Agents SDK session plumbing. ONE tool: `chat`.
 *
 * The CMO LLM already knows how to invoke its 14 internal tools + consult
 * peers based on natural-language intent. Exposing a separate per-tool
 * surface here would double maintenance and confuse the LLM about which
 * path to use. See [[feedback_external_mcp_chat_surface]].
 *
 * Props are populated by OAuthProvider's auth handler (Phase 7.3):
 *   { userId, scopes }
 * — verified Bearer → decrypted → attached to this.props on every request.
 */
export interface CmoExternalProps {
	userId: string;
	scopes: string[];
}

export class CmoExternalMcp extends McpAgent<Env, unknown, CmoExternalProps> {
	server = new McpServer({
		name: "shipflare-cmo",
		version: "1.0.0",
	});

	async init(): Promise<void> {
		const self = this;
		this.server.registerTool(
			"chat",
			{
				description:
					"Talk to your ShipFlare CMO. Ask anything — review pending drafts, " +
					"plan today's posts, get strategic guidance. The CMO has full access " +
					"to your team (SMM, HoG) and can act on your behalf.",
				inputSchema: { message: z.string().min(1).max(4000) },
			},
			async ({ message }) => {
				// Test seam: vitest sets _testProps; production sets props via OAuth.
				const propsHack = (self as unknown as { _testProps?: CmoExternalProps })._testProps;
				const userId = propsHack?.userId ?? self.props.userId;

				const cmoStub = self.env.CMO.getByName(`streamable-http:${userId}`);
				const reply = await (cmoStub as unknown as {
					invokeAsTool: (tool: "chat", args: { message: string }) => Promise<string>;
				}).invokeAsTool("chat", { message });

				return {
					content: [{ type: "text", text: String(reply ?? "") }],
				};
			},
		);
	}
}
```

NOTE on the `_testProps` seam: McpAgent populates `this.props` from the OAuthProvider's token decryption pipeline. In unit tests we don't run OAuth, so we inject a test-only props bag. This is the same pattern as 5.1c.13's `_alarmDryRun`. The OAuth path is exercised in Phase 7.3's integration test.

NOTE on the RPC call from external DO to internal CMO DO: `invokeAsTool` is declared on `CMO` class and we're calling it via the DO RPC surface (Durable Object stubs expose declared methods as RPC). This is the Cloudflare Agents SDK's RPC pattern. If `invokeAsTool` isn't reachable via the stub directly (e.g., visibility issue), wrap it in a thin HTTP route on CMO and use `stub.fetch(...)` instead. The implementer should verify by reading the agents SDK docs or experimenting.

- [ ] **Step 4:** Verify:

```bash
pnpm --filter @shipflare/core exec vitest run test/external/cmo-external-mcp-chat.test.ts test/external/cmo-invoke-as-tool.test.ts 2>&1 | tail -15
pnpm --filter @shipflare/core exec tsc --noEmit; echo "exit:$?"
```

Expected: 2 new tests pass + existing tests green; tsc 0.

If `invokeAsTool` RPC isn't reachable on the stub, the implementer should report DONE_WITH_CONCERNS and adapt — adding an `/internal/invoke-as-tool` route on CMO is the fallback.

- [ ] **Step 5:** Commit:

```bash
git add apps/core/src/external/CmoExternalMcp.ts apps/core/test/external/cmo-external-mcp-chat.test.ts
git commit -m "feat(external): CmoExternalMcp with single chat tool forwarding to CMO (7.2)"
```

---

# Task 7.3 — OAuth provider mount at `/cmo/mcp`

**Files:**
- Modify: `apps/core/src/index.ts` (replace 503 stub at `handleExternalMcpRequest` with OAuthProvider mount; remove dead env types)
- Create: `apps/core/src/external/auth-handler.ts` (the `/authorize` consent UI handler)
- Create: `apps/core/test/external/auth-handler.test.ts`

## Steps

- [ ] **Step 1:** Implement `apps/core/src/external/auth-handler.ts` (tabs):

```typescript
import type { Env } from "../index";

/**
 * Handles all paths that fall through OAuthProvider's apiHandlers — most
 * importantly `/authorize`, the consent UI the user sees after the MCP
 * client redirects them to begin the OAuth dance.
 *
 * For v1: bare-bones consent — just "Authorize <client name>?". Polish
 * post-launch.
 */
export const ExternalAuthHandler = {
	async fetch(request: Request, env: Env): Promise<Response> {
		const url = new URL(request.url);

		if (url.pathname !== "/authorize") {
			return new Response("not found", { status: 404 });
		}

		// Parse OAuth request via OAuthProvider helper
		const oauthReqInfo = await env.OAUTH_PROVIDER.parseAuthRequest(request);
		const clientInfo = await env.OAUTH_PROVIDER.lookupClient(oauthReqInfo.clientId);

		// On POST, the user clicked Authorize — complete the grant
		if (request.method === "POST") {
			// In a real app, derive userId from the ShipFlare session cookie.
			// For now, the cookie path mirrors the existing apps/web session.
			const userId = await resolveUserIdFromSessionCookie(request);
			if (!userId) {
				return new Response("not signed in to ShipFlare", { status: 401 });
			}

			const { redirectTo } = await env.OAUTH_PROVIDER.completeAuthorization({
				request: oauthReqInfo,
				userId,
				scope: ["cmo:chat"],
				metadata: { clientName: clientInfo.client_name ?? "Unknown MCP client" },
				props: { userId, scopes: ["cmo:chat"] },
			});
			return Response.redirect(redirectTo, 302);
		}

		// GET — render the consent screen
		const clientName = clientInfo.client_name ?? "an MCP client";
		const html = `
			<!DOCTYPE html>
			<html><head><title>Authorize ${escapeHtml(clientName)} — ShipFlare</title></head>
			<body style="font-family:system-ui; max-width:560px; margin:80px auto; padding:24px;">
				<h1>Authorize ${escapeHtml(clientName)}?</h1>
				<p>This MCP client is requesting permission to chat with your ShipFlare CMO.</p>
				<p>The CMO can review your pending drafts, plan posts, and act on your behalf.</p>
				<form method="POST">
					<button type="submit">Authorize</button>
					<a href="javascript:window.close()">Cancel</a>
				</form>
			</body></html>
		`;
		return new Response(html, {
			status: 200,
			headers: { "content-type": "text/html; charset=utf-8" },
		});
	},
};

function escapeHtml(s: string): string {
	return s.replace(/[&<>"']/g, (c) =>
		({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!,
	);
}

async function resolveUserIdFromSessionCookie(request: Request): Promise<string | null> {
	// TODO(7.3-followup): reuse apps/web's session verification.
	// For now, accept a header for testing; the auth-handler test exercises this path.
	const headerUid = request.headers.get("x-test-user-id");
	if (headerUid) return headerUid;
	// Look up Better Auth session cookie — must hit apps/web's session API
	// or read the shared session table directly. Implementer fills in.
	return null;
}
```

NOTE: `resolveUserIdFromSessionCookie` has a real production implementation gap — it needs to verify the ShipFlare session cookie. Two approaches:
- (a) Service-binding fetch to apps/web's `/api/auth/session` (clean separation)
- (b) Read the Better Auth session row directly from D1 (faster, tighter coupling)

The implementer should pick the one that matches existing patterns. Look at how apps/core verifies session identity for the `/agents/cmo/<uid>/...` WS upgrade (search `apps/core/src/index.ts` for `verifyJwt` and similar) — that may give us a clear precedent.

- [ ] **Step 2:** Write `apps/core/test/external/auth-handler.test.ts` (2-space) — exercises GET (consent screen rendered), POST without session (401), POST with session (302 redirect with auth code).

- [ ] **Step 3:** Modify `apps/core/src/index.ts`:
  - **Remove** `handleExternalMcpRequest` function (lines ~630-660; the 503 stub)
  - **Remove** the `/agents/<role>/<userId>/mcp` external route dispatch (lines ~408) — it was the entry point for the 503 stub
  - **Add** at the top of the file: imports for `OAuthProvider`, `CmoExternalMcp`, `ExternalAuthHandler`
  - **Add** in the main `fetch` handler, BEFORE the existing dispatch, a check for OAuth-relevant paths:

```typescript
		if (
			url.pathname.startsWith("/cmo/mcp") ||
			url.pathname === "/authorize" ||
			url.pathname.startsWith("/oauth/") ||
			url.pathname.startsWith("/.well-known/oauth-")
		) {
			const oauth = new OAuthProvider({
				apiHandlers: {
					"/cmo/mcp": CmoExternalMcp.serve("/cmo/mcp", { binding: "CMO_EXTERNAL_MCP" }),
				},
				defaultHandler: ExternalAuthHandler,
				authorizeEndpoint: "/authorize",
				tokenEndpoint: "/oauth/token",
				clientRegistrationEndpoint: "/oauth/register",
				scopesSupported: ["cmo:chat"],
				accessTokenTTL: 3600,
				refreshTokenTTL: 60 * 60 * 24 * 30,
				allowImplicitFlow: false,
				allowPlainPKCE: false,
				disallowPublicClientRegistration: false,  // public DCR enabled (D4)
			});
			return oauth.fetch(request, env, ctx);
		}
```

  - **Add** the `OAUTH_PROVIDER` binding to the Env type if it isn't already there — the OAuthProvider attaches itself to `env.OAUTH_PROVIDER` so the auth-handler can call `env.OAUTH_PROVIDER.parseAuthRequest(...)` etc. **Verify by reading the package's d.ts** whether this binding name is automatic or needs to be added to `wrangler.jsonc`.

- [ ] **Step 4:** Verify the build:

```bash
pnpm --filter @shipflare/core exec tsc --noEmit; echo "exit:$?"
pnpm --filter @shipflare/core exec vitest run 2>&1 | tail -5
```

Expected: tsc 0; all 163+ existing tests green; new auth-handler test passes (3 cases).

- [ ] **Step 5:** Integration smoke (no real OAuth, just hits the routes):

```bash
pnpm --filter @shipflare/core exec wrangler dev --port 8787 &
sleep 4
# Should return 401 (no Bearer)
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:8787/cmo/mcp
# Should return 200 with .well-known JSON
curl -s http://localhost:8787/.well-known/oauth-authorization-server | head -1
# Should return 200 with consent HTML
curl -s http://localhost:8787/authorize?client_id=foo | head -3
kill %1
```

Expected: 401 for /cmo/mcp without Bearer; `.well-known` returns JSON; `/authorize` returns HTML.

- [ ] **Step 6:** Commit:

```bash
git add apps/core/src/index.ts \
        apps/core/src/external/auth-handler.ts \
        apps/core/test/external/auth-handler.test.ts
git commit -m "feat(external): OAuthProvider mount at /cmo/mcp + consent screen (7.3)"
```

---

# Task 7.4 — README + RESUME + final docs

**Files:**
- Modify: `README.md` (add an "External MCP" section)
- Modify: `docs/superpowers/plans/2026-05-16-cf-native-chat-migration-RESUME.md` (mark Phase 7 done)
- Optional: `CLAUDE.md` (add the external-MCP route to the routes enumeration if such a list exists)

## Steps

- [ ] **Step 1:** Add to `README.md` (after the existing setup section; if none exists, create one):

```markdown
## External MCP (for Claude Desktop / Cursor / custom LLM stacks)

ShipFlare exposes a remote MCP server at `https://core.shipflare.ai/cmo/mcp`
(replace with your deploy URL). The server speaks **OAuth 2.1 + PKCE** with
**Dynamic Client Registration** — most MCP clients auto-register on first
connect.

### Claude Desktop

Claude Desktop today connects to remote MCP servers via the
[`mcp-remote`](https://www.npmjs.com/package/mcp-remote) local proxy. Add to
`~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) or
`%APPDATA%\Claude\claude_desktop_config.json` (Windows):

\`\`\`json
{
  "mcpServers": {
    "shipflare-cmo": {
      "command": "npx",
      "args": ["mcp-remote", "https://core.shipflare.ai/cmo/mcp"]
    }
  }
}
\`\`\`

Restart Claude Desktop. On first use, a browser window opens for the OAuth
flow — sign in to ShipFlare if you aren't already, click **Authorize**, and
you're done.

### Cursor

Cursor speaks Streamable HTTP natively. Add to `~/.cursor/mcp.json`:

\`\`\`json
{
  "mcpServers": {
    "shipflare-cmo": {
      "url": "https://core.shipflare.ai/cmo/mcp"
    }
  }
}
\`\`\`

Cursor handles the OAuth dance in its built-in browser.

### Tool surface

One tool: `chat(message: string)` — send a natural-language message; the
CMO LLM handles everything else (consulting peers, reviewing drafts, etc.).
```

- [ ] **Step 2:** Update `docs/superpowers/plans/2026-05-16-cf-native-chat-migration-RESUME.md`:
  - Bump `Last updated:` to 2026-05-18
  - In the Status by phase table, change Phase 7 from "⏸ DEFERRED" to "✅ COMPLETE"
  - In "Known limitations", remove the External MCP 503 stub entry
  - Update "Start here next session" — Phase 7 is done; only Phase 11 (PR cutover) remains (or, if everything's already on dev, the migration project is COMPLETE)

- [ ] **Step 3:** Verify the README renders sensibly (no broken JSON in code blocks):

```bash
cd /Users/yifeng/Documents/Code/shipflare
git diff README.md | head -80
```

- [ ] **Step 4:** Commit:

```bash
git add README.md docs/superpowers/plans/2026-05-16-cf-native-chat-migration-RESUME.md
git commit -m "docs: external MCP usage in README; Phase 7 COMPLETE in RESUME (7.4)"
```

---

# Manual smoke test (after all 4 tasks land)

Per D8, no automated Playwright. After Phase 7 lands on the branch:

1. Install `mcp-remote` locally: `npm i -g mcp-remote` (or use `npx mcp-remote ...` each time).
2. Deploy to staging: `pnpm --filter @shipflare/core exec wrangler deploy --env staging`.
3. Add the Claude Desktop config snippet from §7.4 README, pointing at the staging URL.
4. Restart Claude Desktop. First message ("How was today?") should trigger the browser OAuth flow. Sign in, click Authorize.
5. Claude should reply via the `chat` tool. Verify the CMO actually saw the message — check the CMO DO's chat history (via `/chat` in the web UI, the message should appear).
6. Verify telemetry: query Analytics Engine for `kind = 'agent_run'` with blob containing `'CMO'` post the smoke run.
7. (Optional) Repeat with Cursor.

Capture screenshots for the merge PR.

---

# Self-review

**1. Spec coverage** — every locked decision D1-D8 has a task:
- D1 OAuth via `@cloudflare/workers-oauth-provider` → 7.0a installs, 7.3 mounts
- D2 one chat tool → 7.2 registers ONLY chat; 7.1 supports it via invokeAsTool
- D3 Streamable HTTP only → 7.3's `apiHandlers` has `/cmo/mcp` only (no `/cmo/sse`)
- D4 public DCR → 7.3 OAuthProvider config sets `disallowPublicClientRegistration: false`
- D5 delete dead env → 7.0a removes them
- D6 no /settings UI → no task creates one; README is the docs (7.4)
- D7 bare-bones consent → auth-handler.ts (7.3) is intentionally minimal
- D8 manual smoke → end-of-doc manual test, no Playwright task

**2. Placeholder scan** — `resolveUserIdFromSessionCookie` in 7.3 is the one real "TBD" (the implementer fills in). All other code blocks are complete.

**3. Type consistency** — `CmoExternalProps`, `CMO.invokeAsTool` signature, and `env.OAUTH_KV` are consistent across all four tasks. `env.OAUTH_PROVIDER` is referenced in 7.3 — the implementer must confirm this is auto-injected by the package or needs a wrangler binding.

**4. Ambiguity check** — two flagged for implementer judgment:
  - DO-to-DO RPC for `invokeAsTool` (7.2 step 4 note) — try direct RPC first, fall back to HTTP route
  - `OAUTH_PROVIDER` binding name (7.3 step 3) — verify from package d.ts

Plan complete. Execution mode: subagent-driven per `superpowers:subagent-driven-development`. Start with Task 7.0a.
