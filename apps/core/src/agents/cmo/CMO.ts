import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { type McpProps } from "@shipflare/shared";
import type { Env } from "../../index";
import { applyCmoSchema } from "./schema";
import { registerChatTool } from "./tools/chat";

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
    // Employee MCP connections (addMcpServer for each hired role) — S2.3.
  }

  async init(): Promise<void> {
    // S2.1: chat tool — founder's primary entrypoint.
    registerChatTool(this);
    // S2.2: registerConversationTools(this), registerRosterTools(this)
    // S2.4: registerDelegationTools(this), registerSharedStateTools(this)
  }

  // fetch() handler for /internal/* endpoints — S2.5
  // S2.6 wires the /agents/cmo/:userId/mcp public route at the Worker level.
}
