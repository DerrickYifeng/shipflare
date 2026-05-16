import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { mcpServerName, type McpProps } from "@shipflare/shared";
import type { Env } from "../../index";
import { applyHogSchema } from "./schema";
import { registerStrategicPathTool } from "./tools/generate-strategic-path";
import { registerAuditTool } from "./tools/audit-plan";
import { registerPingTool } from "./tools/ping";

interface HogState {
  lastWakeAt: number;
}

/**
 * Head of Growth — strategic-planning employee.
 *
 * Role: member. Generates strategic_path versions, audits plan_items for
 * gaps / risks / redundancies. Always called via the CMO (the founder
 * doesn't talk to HoG directly in Phase 1; HoG is one of the CMO's
 * in-process MCP-RPC peers).
 *
 * Per spec §6.1 invariant #1: HoG does NOT write CMO SQLite directly.
 * Strategic_path + plan_items go through the CMO's RPC tools
 * (`commitStrategicPath`, `addPlanItem`). HoG's own SQLite holds private
 * brain state only — planning_chat, proposal_drafts, audit_findings.
 *
 * `onStart` connects back to the CMO via `addMcpServer` with per-tenant
 * namespacing (Phase 0 spike #2 finding). Tools come in S3.1
 * (`generate_strategic_path`) and S3.2 (`audit_plan`).
 */
export class HeadOfGrowth extends McpAgent<Env, HogState, McpProps> {
  server = new McpServer({ name: "shipflare-hog", version: "1.0.0" });
  initialState: HogState = { lastWakeAt: 0 };
  private _toolsRegistered = false;

  /**
   * Narrow accessors so tool-registration modules (which live outside the
   * class and therefore can't see `protected` DurableObject members) can
   * reach the raw SQL storage and Worker env. Mirrors the CMO pattern
   * (S2.1): `sqlStorage` instead of `sql` because the parent `Agent` class
   * already exposes a `sql` template-tag method; `bindings` instead of
   * `env` because `env` is a protected DurableObject member.
   */
  get sqlStorage(): SqlStorage {
    return this.ctx.storage.sql;
  }
  get bindings(): Env {
    return this.env;
  }
  /**
   * Expose the DO state's `waitUntil` to tool-registration modules so they
   * can fire-and-forget telemetry through `forwardActivityToCmo` /
   * `withSubAgentToolTracing` without blocking tool execution.
   */
  get runtimeCtx(): { waitUntil: (p: Promise<unknown>) => void } {
    return this.ctx;
  }

  async onStart(props?: McpProps): Promise<void> {
    // Schema bootstrap runs BEFORE `super.onStart()` so that
    //  (a) our tables exist even if the parent's transport-init throws
    //      (non-transport-named DOs fail in `getTransportType()`), and
    //  (b) schema-bootstrap tests can drive this method directly without
    //      faking a transport.
    applyHogSchema(this.ctx.storage.sql);
    this.setState({ ...this.state, lastWakeAt: Date.now() });
    // Parent McpAgent.onStart() sets up the MCP transport. Must run after
    // schema bootstrap so any tool handlers registered in init() can rely
    // on the tables being there.
    await super.onStart(props);
    // Dial back into the CMO so HoG can call the CMO's RPC tools
    // (commitStrategicPath, addPlanItem, etc.).
    await this.connectToCmo();
  }

  async init(): Promise<void> {
    if (this._toolsRegistered) return;
    this._toolsRegistered = true;
    registerStrategicPathTool(this);
    registerAuditTool(this);
    registerPingTool(this);
  }

  /**
   * Route `/internal/*` requests. All endpoints are gated on
   * `x-shipflare-internal: 1` (set by apps/web's service binding;
   * Cloudflare strips this header from public-edge traffic).
   */
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const internal = request.headers.get("x-shipflare-internal") === "1";
    if (!internal && url.pathname.startsWith("/internal/")) {
      return new Response("forbidden", { status: 403 });
    }
    if (url.pathname === "/internal/destroy") {
      return this.handleDestroy();
    }
    return super.fetch(request);
  }

  /**
   * Wipe all per-DO SQLite tables for this user. Called from `/api/account`
   * DELETE as part of account deletion. Best-effort — D1 hard-delete fires
   * regardless. The DO is recreated lazily on next access.
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
   * Connect back to the CMO via in-process MCP RPC. The CMO is HoG's
   * source-of-truth for shared per-team state (founder_context,
   * plan_items, strategic_path). Per-tenant namespacing required
   * (Phase 0 spike #2): without `${role}-${userId}` keying, every user's
   * HoG would share one CMO McpServer DO.
   *
   * Caller is `"peer"` (not `"cmo"`) — HoG is calling UP to the CMO as a
   * sibling employee, not down as the team lead. The CMO's tool handlers
   * differentiate caller via this prop.
   *
   * Non-fatal on failure: HoG can still receive RPCs from the CMO even if
   * it can't call back. The CMO's tools surface clearer errors when they
   * need HoG → CMO traffic.
   */
  private async connectToCmo(): Promise<void> {
    // `props` is populated by the parent McpAgent.onStart() from the
    // transport session. In production it's always present once
    // super.onStart() resolves; defensively short-circuit if absent
    // (non-transport DO names in tests skip parent init entirely).
    const userId = this.props?.userId;
    if (!userId) {
      return;
    }
    // The `Env` interface declares HEAD_OF_GROWTH as a typed namespace;
    // CMO is the binding we're looking up here. Both are declared, but we
    // still index by string for symmetry with the CMO's `connectEmployees`
    // (S2.3) and because the cast keeps the lookup result narrowable to
    // `undefined` for the forward-compat guard.
    const cmoBinding = (this.bindings as unknown as Record<string, unknown>)
      .CMO as DurableObjectNamespace<McpAgent> | undefined;
    if (!cmoBinding) {
      console.error(
        `[HoG ${userId}] CMO binding missing — cannot connect back to lead`,
      );
      return;
    }
    try {
      await this.addMcpServer(mcpServerName("cmo", userId), cmoBinding, {
        props: {
          userId,
          caller: "peer" as const,
          role: "member" as const,
        },
      });
    } catch (err) {
      // RPC connection failure is non-fatal — HoG remains addressable from
      // the CMO's side. Next onStart will retry.
      console.error(`[HoG ${userId}] failed to connect to CMO:`, err);
    }
  }
}
