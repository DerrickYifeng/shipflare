import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { mcpServerName, type McpProps } from "@shipflare/shared";
import type { Env } from "../../index";
import { applyCopywriterSchema } from "./schema";
import { registerChatTool } from "./tools/chat";
import { registerRewriteInVoiceTool } from "./tools/rewrite-in-voice";
import { registerDraftHeadlinesTool } from "./tools/draft-headlines";

interface CopywriterState {
  lastWakeAt: number;
}

/**
 * Copywriter — Phase 2 Pro-tier opt-in employee.
 *
 * Role: member. Drafts headlines, taglines, post bodies, and reply rewrites
 * in the founder's voice. The founder explicitly hires this role (it is
 * NOT auto-spawned alongside the core trio); approved outputs hand off to
 * SMM through the CMO's existing drafts pipeline.
 *
 * Connection: dials back to the CMO via `addMcpServer` on onStart so it
 * can read founder_context (productName, voice, audience) and call any
 * CMO RPC tools needed downstream. Per spec §6.1 invariant #1, the
 * Copywriter's own SQLite (copy_drafts, voice_lessons) is private — the
 * canonical record of an approved draft lives in CMO/SMM tables, not here.
 */
export class Copywriter extends McpAgent<Env, CopywriterState, McpProps> {
  server = new McpServer({ name: "shipflare-copywriter", version: "1.0.0" });
  initialState: CopywriterState = { lastWakeAt: 0 };

  /**
   * Narrow accessors so tool-registration modules (which live outside the
   * class and therefore can't see `protected` DurableObject members) can
   * reach the raw SQL storage and Worker env. Mirrors the CMO + HoG + SMM
   * pattern (S2.1 / S3.0 / S4.0).
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
    applyCopywriterSchema(this.ctx.storage.sql);
    this.setState({ ...this.state, lastWakeAt: Date.now() });
    await super.onStart(props);
    await this.connectToCmo();
  }

  async init(): Promise<void> {
    registerChatTool(this);
    registerRewriteInVoiceTool(this);
    registerDraftHeadlinesTool(this);
  }

  /**
   * Connect back to the CMO via in-process MCP RPC. Caller is `"peer"` —
   * the Copywriter is calling UP to the CMO as a sibling employee, not
   * down as the team lead. Per Phase 0 spike #2 the namespace is keyed
   * by `${role}-${userId}` so per-tenant isolation holds.
   */
  private async connectToCmo(): Promise<void> {
    const userId = this.props?.userId;
    if (!userId) {
      return;
    }
    const cmoBinding = (this.bindings as unknown as Record<string, unknown>)
      .CMO as DurableObjectNamespace<McpAgent> | undefined;
    if (!cmoBinding) {
      console.error(
        `[Copywriter ${userId}] CMO binding missing — cannot connect back to lead`,
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
      console.error(`[Copywriter ${userId}] failed to connect to CMO:`, err);
    }
  }
}
