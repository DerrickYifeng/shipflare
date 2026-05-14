import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { type McpProps } from "@shipflare/shared";
import type { Env } from "../../index";
import { applyCmoSchema } from "./schema";

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
    // Tool registration — S2.1-S2.5 (chat, delegate, founder-context get/set,
    // employee_log query, approval-queue resolve, etc.).
  }

  // fetch() handler for /internal/* endpoints — S2.5
  // S2.6 wires the /agents/cmo/:userId/mcp public route at the Worker level.
}
