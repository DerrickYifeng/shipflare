import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { mcpServerName, type McpProps } from "@shipflare/shared";
import type { Env } from "../../index";
import { applyBrandAnalystSchema } from "./schema";
import { registerChatTool } from "./tools/chat";
import { registerAnalyzeCompetitorsTool } from "./tools/analyze-competitors";
import { registerSuggestPositioningTool } from "./tools/suggest-positioning";

interface BrandAnalystState {
  lastWakeAt: number;
}

/**
 * Brand Analyst — Phase 2 Pro-tier opt-in employee.
 *
 * Role: member. Surveys competitor positioning/messaging and proposes
 * positioning theses for the founder's product. Phase 2 P2-B uses
 * the LLM's general knowledge — real web search integration (xAI live
 * search, Perplexity) lands in Phase 2.x.
 *
 * Connection: dials back to the CMO via `addMcpServer` on onStart so it
 * can read founder_context (productName, audience) and eventually call
 * `commitStrategicPath` to promote an approved positioning thesis.
 */
export class BrandAnalyst extends McpAgent<Env, BrandAnalystState, McpProps> {
  server = new McpServer({
    name: "shipflare-brand-analyst",
    version: "1.0.0",
  });
  initialState: BrandAnalystState = { lastWakeAt: 0 };

  get sqlStorage(): SqlStorage {
    return this.ctx.storage.sql;
  }
  get bindings(): Env {
    return this.env;
  }

  async onStart(props?: McpProps): Promise<void> {
    applyBrandAnalystSchema(this.ctx.storage.sql);
    this.setState({ ...this.state, lastWakeAt: Date.now() });
    await super.onStart(props);
    await this.connectToCmo();
  }

  async init(): Promise<void> {
    registerChatTool(this);
    registerAnalyzeCompetitorsTool(this);
    registerSuggestPositioningTool(this);
  }

  /**
   * Connect back to the CMO via in-process MCP RPC. Caller is `"peer"` —
   * the Brand Analyst is calling UP to the CMO as a sibling employee, not
   * down as the team lead.
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
        `[BrandAnalyst ${userId}] CMO binding missing — cannot connect back to lead`,
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
        `[BrandAnalyst ${userId}] failed to connect to CMO:`,
        err,
      );
    }
  }
}
