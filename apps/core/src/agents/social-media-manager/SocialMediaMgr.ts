import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { mcpServerName, type McpProps, type RoleSlug } from "@shipflare/shared";
import type { Env } from "../../index";
import { applySmmSchema } from "./schema";
import { registerFindThreadsViaXaiTool } from "./tools/find-threads-via-xai";

interface SmmState {
  lastWakeAt: number;
}

/**
 * Social Media Manager — execution employee.
 *
 * Role: member. Discovers threads (via xAI / Reddit search), drafts replies
 * and posts, validates them (platform-leak, throttle), persists to drafts
 * table, and updates plan_items via CMO RPC.
 *
 * Connections in onStart (each isolated; one failure does not break the rest):
 *   - CMO         (always present — source of truth for plan / founder_context)
 *   - X_MCP       (S5, may not be deployed yet — graceful skip)
 *   - REDDIT_MCP  (S5, may not be deployed yet — graceful skip)
 *
 * Per spec §6.1 invariant #1: SMM does NOT write CMO SQLite directly.
 * Plan_item status updates go through CMO.updatePlanItem; founder_context
 * reads go through CMO.queryFounderContext. SMM's own SQLite holds private
 * working state only (threads_inbox / drafts / posted / voice_audit).
 *
 * Per Phase 0 spike #2: per-tenant namespacing required for addMcpServer.
 * Tools come in S4.1-S4.5 (find_threads_via_xai, find_threads,
 * process_replies_batch, process_posts_batch, research_reddit_channels,
 * listDrafts).
 */
export class SocialMediaMgr extends McpAgent<Env, SmmState, McpProps> {
  server = new McpServer({ name: "shipflare-smm", version: "1.0.0" });
  initialState: SmmState = { lastWakeAt: 0 };

  /**
   * Narrow accessors so tool-registration modules (which live outside the
   * class and therefore can't see `protected` DurableObject members) can
   * reach the raw SQL storage and Worker env. Mirrors the CMO + HoG pattern
   * (S2.1, S3.0): `sqlStorage` instead of `sql` because the parent `Agent`
   * class already exposes a `sql` template-tag method; `bindings` instead
   * of `env` because `env` is a protected DurableObject member.
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
    //      (non-transport-named DOs fail in `getTransportType()`), and
    //  (b) schema-bootstrap tests can drive this method directly without
    //      faking a transport.
    applySmmSchema(this.ctx.storage.sql);
    this.setState({ ...this.state, lastWakeAt: Date.now() });
    // Parent McpAgent.onStart() sets up the MCP transport. Must run after
    // schema bootstrap so any tool handlers registered in init() can rely
    // on the tables being there.
    await super.onStart(props);
    // Dial each peer (CMO required; platform-tool MCPs forward-compat).
    await this.connectToPeers();
  }

  async init(): Promise<void> {
    registerFindThreadsViaXaiTool(this);
    // S4.2: registerFindThreadsTool(this)
    // S4.3: registerProcessRepliesBatchTool(this)
    // S4.4: registerProcessPostsBatchTool(this)
    // S4.5: registerResearchRedditChannelsTool(this), registerListDraftsTool(this)
  }

  /**
   * Connect to CMO (always) + X_MCP / REDDIT_MCP (if deployed).
   *
   * Failure isolation: each connection wrapped in try/catch — one missing
   * binding doesn't break the others. Missing platform bindings are
   * expected during Phase 1's intermediate state (before S5 lands).
   *
   * Per spec §6.1 invariant #1: caller is `"peer"` (not `"cmo"`) — SMM is
   * calling UP to the CMO as a sibling employee, not down as the team lead.
   *
   * Note on platform-tool naming: `RoleSlug` in `@shipflare/shared` only
   * contains the three EMPLOYEE roles (cmo / head-of-growth /
   * social-media-manager). X_MCP and REDDIT_MCP are TOOL MCPs (platform
   * tool surfaces), not employee roles, so they aren't in `RoleSlug`. We
   * cast `"x-mcp" as unknown as RoleSlug` to satisfy `mcpServerName`'s
   * type signature; the runtime string is what matters for DO id
   * derivation. S5 may introduce a dedicated `platformServerName()`
   * helper for a cleaner pattern.
   */
  private async connectToPeers(): Promise<void> {
    // `props` is populated by the parent McpAgent.onStart() from the
    // transport session. In production it's always present once
    // super.onStart() resolves; defensively short-circuit if absent
    // (non-transport DO names in tests skip parent init entirely).
    const userId = this.props?.userId;
    if (!userId) {
      return;
    }

    // The `Env` interface only declares bindings currently configured in
    // wrangler.jsonc; lookups are validated against `undefined` below
    // before use.
    const envBag = this.bindings as unknown as Record<string, unknown>;

    // ── CMO — always required ────────────────────────────────────────────
    const cmoBinding = envBag.CMO as
      | DurableObjectNamespace<McpAgent>
      | undefined;
    if (!cmoBinding) {
      console.error(
        `[SMM ${userId}] CMO binding missing — cannot connect back to lead`,
      );
    } else {
      try {
        await this.addMcpServer(mcpServerName("cmo", userId), cmoBinding, {
          props: {
            userId,
            caller: "peer" as const,
            role: "member" as const,
          },
        });
      } catch (err) {
        console.error(`[SMM ${userId}] failed to connect to CMO:`, err);
      }
    }

    // ── X_MCP — Phase 1 S5 lands this binding ───────────────────────────
    const xBinding = envBag.X_MCP as
      | DurableObjectNamespace<McpAgent>
      | undefined;
    if (xBinding) {
      try {
        await this.addMcpServer(
          mcpServerName("x-mcp" as unknown as RoleSlug, userId),
          xBinding,
          {
            props: {
              userId,
              caller: "peer" as const,
              role: "member" as const,
            },
          },
        );
      } catch (err) {
        console.error(`[SMM ${userId}] failed to connect to X_MCP:`, err);
      }
    } else {
      console.info(
        `[SMM ${userId}] X_MCP binding not deployed yet (S5) — skipping`,
      );
    }

    // ── REDDIT_MCP — same forward-compat pattern as X_MCP ───────────────
    const redditBinding = envBag.REDDIT_MCP as
      | DurableObjectNamespace<McpAgent>
      | undefined;
    if (redditBinding) {
      try {
        await this.addMcpServer(
          mcpServerName("reddit-mcp" as unknown as RoleSlug, userId),
          redditBinding,
          {
            props: {
              userId,
              caller: "peer" as const,
              role: "member" as const,
            },
          },
        );
      } catch (err) {
        console.error(
          `[SMM ${userId}] failed to connect to REDDIT_MCP:`,
          err,
        );
      }
    } else {
      console.info(
        `[SMM ${userId}] REDDIT_MCP binding not deployed yet (S5) — skipping`,
      );
    }
  }
}
