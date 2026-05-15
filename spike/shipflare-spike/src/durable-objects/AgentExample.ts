import { Agent } from "agents";
import type { Env } from "../index";

type State = {
  connected: boolean;
  mcpServerId: string | null;
};

/**
 * Spike #2 Agent that owns an RPC connection to McpServerExample.
 *
 * In agents@0.12.4 the API is:
 *   - `this.addMcpServer(name, binding, { props })` returns `{ id, state }`
 *   - `this.mcp.callTool({ serverId, name, arguments })` invokes a tool
 *
 * `addMcpServer` persists the binding name + props to DO storage so the
 * connection is auto-restored after hibernation. We persist the returned
 * `id` in agent state so callMcpEcho() can survive hibernation as well.
 */
export class AgentExample extends Agent<Env, State> {
  initialState: State = { connected: false, mcpServerId: null };

  async onStart(): Promise<void> {
    if (this.state.connected && this.state.mcpServerId) {
      // Restored from hibernation — RPC servers are auto-reconnected by the
      // SDK from storage. Nothing to do; serverId already in state.
      return;
    }
    // Namespace the MCP server by this agent's name. `addMcpServer` derives
    // the McpAgent DO's name from `serverName` (RPC_DO_PREFIX + normalizedName),
    // so a hardcoded "mcp" would make all AgentExample instances share ONE
    // McpServerExample DO. Using `mcp-${this.name}` gives each parent agent
    // its own MCP server, which matches the typical per-tenant deployment
    // pattern and gives tests true state isolation.
    const serverName = `mcp-${this.name}`;
    const { id } = await this.addMcpServer(serverName, this.env.MCP_EXAMPLE, {
      props: { userId: "test-user-123", secret: "test-secret-456" },
    });
    this.setState({ connected: true, mcpServerId: id });
  }

  async callMcpEcho(ping: string): Promise<unknown> {
    if (!this.state.mcpServerId) {
      throw new Error("MCP server not connected yet");
    }
    return await this.mcp.callTool({
      serverId: this.state.mcpServerId,
      name: "echo_props",
      arguments: { ping },
    });
  }
}
