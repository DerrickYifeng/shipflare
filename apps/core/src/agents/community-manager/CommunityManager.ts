import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { mcpServerName, type McpProps } from "@shipflare/shared";
import type { Env } from "../../index";
import { applyCommunityManagerSchema } from "./schema";
import { registerChatTool } from "./tools/chat";
import { registerAnalyzeCommunityPulseTool } from "./tools/analyze-community-pulse";
import { registerSummarizeMentionsTool } from "./tools/summarize-mentions";

interface CommunityManagerState {
  lastWakeAt: number;
}

/**
 * Community Manager — Phase 2 Pro-tier opt-in employee.
 *
 * Role: member. Reads recent SMM activity (threads inbox, posted history)
 * and reports sentiment, emerging topics, and recurring mentions. Phase 2
 * P2-B uses LLM general-knowledge shaping — real cross-DO reads of SMM
 * data wait on the SMM exposing a list-style RPC tool in Phase 2.x.
 *
 * Connection: dials back to the CMO via `addMcpServer` on onStart so it
 * can read founder_context and (Phase 2.x) call SMM list tools through
 * the CMO's routing.
 */
export class CommunityManager extends McpAgent<
  Env,
  CommunityManagerState,
  McpProps
> {
  server = new McpServer({
    name: "shipflare-community-manager",
    version: "1.0.0",
  });
  initialState: CommunityManagerState = { lastWakeAt: 0 };

  get sqlStorage(): SqlStorage {
    return this.ctx.storage.sql;
  }
  get bindings(): Env {
    return this.env;
  }

  async onStart(props?: McpProps): Promise<void> {
    applyCommunityManagerSchema(this.ctx.storage.sql);
    this.setState({ ...this.state, lastWakeAt: Date.now() });
    await super.onStart(props);
    await this.connectToCmo();
  }

  async init(): Promise<void> {
    registerChatTool(this);
    registerAnalyzeCommunityPulseTool(this);
    registerSummarizeMentionsTool(this);
  }

  /**
   * Connect back to the CMO via in-process MCP RPC. Caller is `"peer"` —
   * the Community Manager is calling UP to the CMO as a sibling employee,
   * not down as the team lead.
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
        `[CommunityManager ${userId}] CMO binding missing — cannot connect back to lead`,
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
      console.error(
        `[CommunityManager ${userId}] failed to connect to CMO:`,
        err,
      );
    }
  }
}
