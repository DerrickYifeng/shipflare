import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Env } from "../index";

type State = { callCount: number };
type Props = { userId: string; secret: string };

/**
 * Spike #2 McpAgent example.
 *
 * Note on props passthrough:
 * In agents@0.12.4 the RPC transport (`handleMcpMessage`) does NOT
 * wrap tool invocations in `runWithAuthContext`, so `extra.props` /
 * `getMcpAuthContext()` are not populated. The props passed via
 * `addMcpServer(name, binding, { props })` are persisted by the
 * `McpAgent` and exposed as `this.props` on the agent instance.
 * We capture `this` via arrow-function closure in the tool handler.
 */
export class McpServerExample extends McpAgent<Env, State, Props> {
  server = new McpServer({ name: "spike-mcp", version: "1.0.0" });
  initialState: State = { callCount: 0 };

  async init(): Promise<void> {
    this.server.registerTool(
      "echo_props",
      {
        description: "Return the props from the calling agent",
        inputSchema: { ping: z.string() },
      },
      async ({ ping }) => {
        this.setState({ callCount: this.state.callCount + 1 });
        const props = this.props ?? ({} as Partial<Props>);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                ping,
                propsUserId: props.userId ?? null,
                propsSecret: props.secret ?? null,
                callCount: this.state.callCount,
              }),
            },
          ],
        };
      },
    );
  }
}
