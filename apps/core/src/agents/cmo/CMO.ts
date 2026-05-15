import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  ROLE_REGISTRY,
  mcpServerName,
  type McpProps,
  type RoleSlug,
} from "@shipflare/shared";
import type { Env } from "../../index";
import { applyCmoSchema } from "./schema";
import { registerChatTool } from "./tools/chat";
import { registerConversationTools } from "./tools/conversation";
import { registerRosterTools } from "./tools/roster";
import { registerDelegationTools } from "./tools/delegate";
import { registerSharedStateTools } from "./tools/shared-state";
import {
  sendWebPush,
  type PushPayload,
  type PushSubscriptionRow,
} from "../../lib/web-push";

type CMOState = {
  initialized: boolean;
  lastWakeAt: number;
};


/**
 * CMO — the founder-facing orchestrator employee.
 *
 * Role: lead. Receives founder messages, decomposes goals, delegates to
 * specialist employees (Head of Growth, Social Media Manager, etc.) via
 * in-process MCP RPC (`addMcpServer`), and summarizes results back for the
 * founder.
 *
 * Per spec D11, chat history is conversation-scoped (Claude.ai-style reset
 * on new conversation). Sprint work products + identity config persist
 * across conversations.
 *
 * Tools registered in S2.1-S2.5. `onStart` employee connections come in
 * S2.3. Internal endpoints (init / peer-dm-shadow / cron-tick) land in
 * S2.5. The Worker entry route (`/agents/cmo/:userId/mcp`) is wired in
 * S2.6.
 *
 * Per Phase 0 spike #2 finding, the binding type in `Env` must be
 * `DurableObjectNamespace<CMO>` (not bare) — the `addMcpServer` generic
 * constraint relies on the parameterized form.
 */
export class CMO extends McpAgent<Env, CMOState, McpProps> {
  server = new McpServer({ name: "shipflare-cmo", version: "1.0.0" });
  initialState: CMOState = { initialized: false, lastWakeAt: 0 };
  // McpAgent.onStart() calls init() on every new MCP session but this.server
  // persists on the same DO instance — guard so tools register exactly once.
  private _toolsRegistered = false;

  /**
   * Narrow accessors so tool-registration modules (which live outside the
   * class and therefore can't see `protected` DurableObject members) can
   * reach the raw SQL storage and Worker env. Returning the storage / env
   * by reference is correct — these are stable per-DO singletons. Keep
   * this surface minimal; broaden only when a new tool genuinely needs it.
   *
   * Naming: `sqlStorage` instead of `sql` because the parent `Agent`
   * class already exposes a `sql` template-tag method for inline queries;
   * a getter would shadow it incompatibly. The tool flow uses
   * `sqlStorage.exec(...)` for parameterized statements via placeholders.
   *
   * Naming: `bindings` instead of `env` because `env` is a protected
   * member of `DurableObject` — a public getter named `env` would alias
   * a protected field, which TypeScript flags.
   */
  get sqlStorage(): SqlStorage {
    return this.ctx.storage.sql;
  }
  get bindings(): Env {
    return this.env;
  }

  async onStart(props?: McpProps): Promise<void> {
    // Schema bootstrap runs BEFORE `super.onStart()` so that
    //  (a) our tables exist even if the parent's transport-init throws
    //      (parent reads the DO name prefix `sse:`/`streamable-http:`/`rpc:`
    //      to pick a transport; non-transport-named DOs fail here), and
    //  (b) schema-bootstrap tests can drive this method directly without
    //      faking a transport. `CREATE TABLE IF NOT EXISTS` makes it
    //      idempotent across restarts.
    applyCmoSchema(this.ctx.storage.sql);
    this.setState({ ...this.state, lastWakeAt: Date.now() });
    // Parent McpAgent.onStart() sets up the MCP transport (loads props,
    // calls init(), wires the transport, reinitializes the server). Must
    // run after our schema bootstrap so tool handlers registered in init()
    // can rely on the tables being there.
    await super.onStart(props);
    // S2.3 — connect to each hired employee via in-process MCP RPC.
    await this.connectEmployees();
  }

  /**
   * Read the active roster and connect to each hired employee via in-process
   * MCP RPC.
   *
   * Per Phase 0 spike #2 finding: the McpServer DO instance is keyed off the
   * `name` argument to `addMcpServer`. WITHOUT per-tenant namespacing, all
   * users' CMOs would share one McpServer DO per role, breaking isolation.
   * `mcpServerName(role, userId)` (from @shipflare/shared) returns the
   * canonical `${role}-${userId}` form.
   *
   * Forward-compat: if a hired role has no env binding yet (S3/S4 roles still
   * coming online, or a Phase 2 role flagged in roster but binding not added),
   * we log + skip. The next onStart picks it up once the binding is added.
   *
   * Per-role isolation: each addMcpServer call is wrapped in try/catch so one
   * failing employee doesn't blow up the rest. The CMO remains usable for
   * direct founder chat even if every employee dial-up fails.
   */
  private async connectEmployees(): Promise<void> {
    // `props` is populated by the parent McpAgent.onStart() from the transport
    // session. In production this is always present once super.onStart()
    // resolves; defensively short-circuit if absent (non-transport DO names
    // in tests skip parent init entirely — no roster connect needed there).
    const userId = this.props?.userId;
    if (!userId) {
      return;
    }
    const hires = this.sqlStorage
      .exec<{ role: string }>(
        "SELECT role FROM roster WHERE status = 'active'",
      )
      .toArray();

    for (const { role } of hires) {
      if (!(role in ROLE_REGISTRY)) {
        console.warn(
          `[CMO ${userId}] roster has unknown role "${role}"; skipping`,
        );
        continue;
      }
      const entry = ROLE_REGISTRY[role as RoleSlug];
      // The `Env` interface only declares bindings that are currently
      // configured in wrangler.jsonc (CMO + future S3/S4 additions).
      // Indexing by an arbitrary string (entry.binding) needs an explicit
      // widening cast — the lookup result is always validated against
      // `undefined` below before use.
      const binding = (this.bindings as unknown as Record<string, unknown>)[
        entry.binding
      ] as DurableObjectNamespace<McpAgent> | undefined;
      if (!binding) {
        console.warn(
          `[CMO ${userId}] role "${role}" hired but env binding "${entry.binding}" is not configured; ` +
            `skipping. (Likely the employee's DO class isn't deployed yet.)`,
        );
        continue;
      }
      try {
        await this.addMcpServer(
          mcpServerName(role as RoleSlug, userId),
          binding,
          {
            props: {
              userId,
              caller: "cmo" as const,
            },
          },
        );
      } catch (err) {
        // RPC connection failure is non-fatal — the CMO is still usable for
        // direct founder chat. Failing employees will retry on next onStart.
        console.error(
          `[CMO ${userId}] failed to connect to ${role}:`,
          err,
        );
      }
    }
  }

  async init(): Promise<void> {
    if (this._toolsRegistered) return;
    this._toolsRegistered = true;
    // S2.1: chat tool — founder's primary entrypoint.
    registerChatTool(this);
    // S2.2: conversation + roster management.
    registerConversationTools(this);
    registerRosterTools(this);
    // S2.4: CMO → employee delegation + shared-state RPC surface
    //   (per spec §6.1 invariant #1: CMO SQLite is the per-team source of
    //   truth; employees write to it ONLY via these tools).
    registerDelegationTools(this);
    registerSharedStateTools(this);
  }

  /**
   * Route `/internal/*` HTTP traffic to our private handlers; everything
   * else falls through to McpAgent's own `fetch()` (so MCP transport
   * routes like `/mcp` still work when the Worker entry forwards them).
   *
   * All `/internal/*` endpoints are gated on the `x-shipflare-internal: 1`
   * header. The Worker entry (S2.6) sets this for Service-Binding-
   * initiated traffic; Cloudflare's network layer rejects forged versions
   * of the header from public clients. The 403 here is a belt-and-braces
   * check — only internal CF traffic should ever reach these paths.
   */
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    const internal = request.headers.get("x-shipflare-internal") === "1";
    if (!internal && url.pathname.startsWith("/internal/")) {
      return new Response("forbidden", { status: 403 });
    }

    if (url.pathname === "/internal/init") {
      return this.handleInit(request);
    }
    if (url.pathname === "/internal/peer-dm-shadow") {
      return this.handlePeerShadow(request);
    }
    if (url.pathname === "/internal/cron-tick") {
      return this.handleCronTick(request);
    }
    if (url.pathname === "/internal/push-subscribe") {
      return this.handlePushSubscribe(request);
    }
    if (url.pathname === "/internal/destroy") {
      return this.handleDestroy();
    }

    // Fall through to McpAgent's default fetch (handles /mcp, WebSocket
    // upgrades, etc. — S2.6 routes /mcp before this DO sees it; this is
    // just a safety net).
    return super.fetch(request);
  }

  /**
   * Idempotent first-login hook. Called from `apps/web`'s Better Auth
   * `databaseHooks.user.create.after` after a fresh user row lands in D1.
   *
   * Body: `{ email: string, githubLogin: string | null }`
   *
   * Effects (once, on first call):
   *  - Seeds `founder_context` with email + githubLogin
   *  - Hires every `ROLE_REGISTRY` entry where `defaultActive=true`
   *    (excluding `cmo` — it's implicit; the CMO IS the DO)
   *  - Re-runs `connectEmployees()` so the freshly-hired roles connect
   *    now, without waiting for the next cold-start
   *
   * Idempotency: subsequent calls return `already_initialized` with
   * status 200 and DO NOT overwrite existing rows. We gate on
   * `founder_context` row count — if there's already at least one row,
   * we've initialized before.
   */
  private async handleInit(request: Request): Promise<Response> {
    const ctxCount = this.sqlStorage
      .exec<{ c: number }>("SELECT COUNT(*) as c FROM founder_context")
      .one().c;
    if (ctxCount > 0) {
      return new Response("already_initialized", { status: 200 });
    }

    const body = (await request.json()) as {
      email: string;
      githubLogin: string | null;
    };
    const now = Date.now();

    this.sqlStorage.exec(
      "INSERT INTO founder_context (key, value) VALUES (?, ?)",
      "email",
      body.email,
    );
    if (body.githubLogin) {
      this.sqlStorage.exec(
        "INSERT INTO founder_context (key, value) VALUES (?, ?)",
        "githubLogin",
        body.githubLogin,
      );
    }

    // Hire all defaultActive roles from ROLE_REGISTRY (excluding cmo —
    // implicit). The cast on the entries iterator is safe: ROLE_REGISTRY
    // is `as const satisfies Record<string, RoleEntry>` so the value type
    // is `(typeof ROLE_REGISTRY)[RoleSlug]` for every key.
    for (const [role, entry] of Object.entries(ROLE_REGISTRY) as Array<
      [RoleSlug, (typeof ROLE_REGISTRY)[RoleSlug]]
    >) {
      if (role === "cmo") continue;
      if (!entry.defaultActive) continue;
      this.sqlStorage.exec(
        `INSERT INTO roster (role, hired_at, status) VALUES (?, ?, 'active')`,
        role,
        now,
      );
    }

    // Connect freshly-hired employees now (don't wait for cold-start).
    // RPC dial-up errors are non-fatal — init has already seeded local
    // state; the next onStart will retry connections.
    try {
      await this.connectEmployees();
    } catch (err) {
      console.error(`[CMO init] connectEmployees failed during init:`, err);
    }

    return new Response("initialized", { status: 200 });
  }

  /**
   * Peer-DM shadow log — Spec §6.1 invariant #2.
   *
   * When employee A calls employee B via RPC (e.g. SMM asks Copywriter
   * for a rewrite), A also POSTs a quiet shadow message to the CMO via
   * this endpoint so the CMO has visibility into peer-DMs WITHOUT being
   * woken every time peers chat. The CMO picks these up on its next
   * natural wake (founder message, cron tick, etc.).
   *
   * Body: `{ conversationId?: string, fromRole: string, toRole: string,
   *          tool: string, summary: string, payload?: unknown }`
   *
   * **Must not** trigger any LLM call or broadcast. Quiet log append only.
   */
  private async handlePeerShadow(request: Request): Promise<Response> {
    const body = (await request.json()) as {
      conversationId?: string;
      fromRole: string;
      toRole: string;
      tool: string;
      summary: string;
      payload?: unknown;
    };
    this.sqlStorage.exec(
      `INSERT INTO employee_log
         (conversation_id, from_role, kind, summary, payload_json, ts, notified_founder)
       VALUES (?, ?, 'peer_dm_shadow', ?, ?, ?, 0)`,
      body.conversationId ?? null,
      body.fromRole,
      body.summary,
      JSON.stringify({
        to: body.toRole,
        tool: body.tool,
        payload: body.payload,
      }),
      Date.now(),
    );
    return new Response("logged", { status: 200 });
  }

  /**
   * Cron tick — called from `apps/core`'s `scheduled()` handler on the
   * cron trigger. Currently fans out to SMM's inbound-sweep tool if SMM
   * is connected; otherwise it's a no-op (SMM lands in S4).
   *
   * We never throw — cron should be self-healing. Failures get logged
   * and a non-2xx-safe `200` body string identifies the case (the
   * caller, a Worker's `scheduled()` handler, won't read the body but
   * does benefit from a non-throw).
   */
  private async handleCronTick(_request: Request): Promise<Response> {
    const userId = this.props?.userId;
    if (!userId) {
      return new Response("no userId in props", { status: 200 });
    }

    const smmServerName = mcpServerName("social-media-manager", userId);
    const servers = this.mcp.listServers();
    const smm = servers.find((s) => s.name === smmServerName);
    if (!smm) {
      // SMM not connected (not hired, or S4 not landed yet). Silent skip.
      return new Response("noop:smm_not_connected", { status: 200 });
    }

    try {
      await this.mcp.callTool({
        serverId: smm.id,
        name: "findThreadsViaXai",
        arguments: { platform: "x", intent: "hourly-sweep" },
      });
    } catch (err) {
      console.error(`[CMO cron-tick ${userId}] SMM call failed:`, err);
      return new Response("err:smm_call_failed", { status: 200 });
    }
    return new Response("ticked", { status: 200 });
  }

  /**
   * P2-F — Web push subscription persistence.
   *
   * Browser → `/api/push/subscribe` (apps/web, session-gated) → this route
   * via Service Binding. We store the subscription so any push trigger
   * inside the CMO DO can later call `sendPushToFounder()` and reach
   * every active browser the founder enabled notifications in.
   *
   * Body: `{ endpoint, p256dh, auth }`.
   *
   * Endpoint is the primary key — re-subscribing from the same browser
   * yields the same endpoint, so an UPSERT on conflict refreshes the keys
   * and clears `last_error`. Different browser / device → different
   * endpoint → separate row.
   */
  private async handlePushSubscribe(request: Request): Promise<Response> {
    let body: PushSubscriptionRow;
    try {
      body = (await request.json()) as PushSubscriptionRow;
    } catch {
      return new Response("invalid json", { status: 400 });
    }
    if (
      typeof body.endpoint !== "string" ||
      typeof body.p256dh !== "string" ||
      typeof body.auth !== "string" ||
      body.endpoint.length === 0
    ) {
      return new Response("invalid subscription", { status: 400 });
    }
    this.sqlStorage.exec(
      `INSERT INTO push_subscriptions (endpoint, p256dh, auth, subscribed_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(endpoint) DO UPDATE SET
         p256dh = excluded.p256dh,
         auth = excluded.auth,
         last_error = NULL`,
      body.endpoint,
      body.p256dh,
      body.auth,
      Date.now(),
    );
    return new Response("subscribed", { status: 200 });
  }

  /**
   * Wipe all per-DO SQLite tables for this user. Called from `/api/account`
   * DELETE (via the apps/web service-binding) as part of account deletion.
   *
   * Best-effort — the D1 hard-delete of the user row fires regardless of
   * whether this succeeds. The DO is recreated lazily on next access (it will
   * just be empty). The `x-shipflare-internal: 1` gate is enforced by the
   * caller's `fetch()` before this handler is reached.
   */
  private handleDestroy(): Response {
    const tables = this.sqlStorage
      .exec<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'",
      )
      .toArray();
    for (const t of tables) {
      this.sqlStorage.exec(`DROP TABLE IF EXISTS "${t.name}"`);
    }
    return new Response("destroyed", { status: 200 });
  }

  /**
   * P2-F — Send a Web Push notification to every active subscription
   * for this founder.
   *
   * Returns `{ sent, failed }`. On 404 / 410 from the push service the
   * subscription is dead (browser un-subscribed) and we delete the row.
   * Other non-2xx records `last_error` so a future inspection can decide
   * to retry or evict.
   *
   * Phase 2 P2-F caveat: the payload is currently delivered as an empty
   * body (the service worker shows a generic "Check ShipFlare" message
   * regardless of `payload.title` / `payload.body`). Encrypted payload
   * support arrives in P2-F.2 — once that lands, `sendWebPush` will
   * deliver the actual title/body without changes to this method.
   *
   * Public on the class so wiring it into draft-ready hooks
   * (`process-replies-batch.ts`, `process-posts-batch.ts`, etc. — see
   * P2-F.2 TODOs) doesn't need a new MCP tool.
   */
  async sendPushToFounder(
    payload: PushPayload,
  ): Promise<{ sent: number; failed: number }> {
    const subs = this.sqlStorage
      .exec<PushSubscriptionRow>(
        "SELECT endpoint, p256dh, auth FROM push_subscriptions",
      )
      .toArray();

    const vapid = {
      publicKey: this.bindings.VAPID_PUBLIC,
      privateKey: this.bindings.VAPID_PRIVATE,
      subject: this.bindings.VAPID_SUBJECT || "mailto:hello@shipflare.com",
    };

    let sent = 0;
    let failed = 0;
    for (const sub of subs) {
      try {
        const result = await sendWebPush(sub, payload, vapid);
        if (result.ok) {
          sent++;
          this.sqlStorage.exec(
            "UPDATE push_subscriptions SET last_used = ?, last_error = NULL WHERE endpoint = ?",
            Date.now(),
            sub.endpoint,
          );
        } else {
          failed++;
          if (result.shouldDelete) {
            this.sqlStorage.exec(
              "DELETE FROM push_subscriptions WHERE endpoint = ?",
              sub.endpoint,
            );
          } else {
            this.sqlStorage.exec(
              "UPDATE push_subscriptions SET last_error = ? WHERE endpoint = ?",
              String(result.status),
              sub.endpoint,
            );
          }
        }
      } catch (err) {
        failed++;
        console.error(`[CMO push] send failed for ${sub.endpoint}:`, err);
        this.sqlStorage.exec(
          "UPDATE push_subscriptions SET last_error = ? WHERE endpoint = ?",
          err instanceof Error ? err.message : String(err),
          sub.endpoint,
        );
      }
    }
    return { sent, failed };
  }
}
