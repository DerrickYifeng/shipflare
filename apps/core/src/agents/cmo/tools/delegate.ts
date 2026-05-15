import { z } from "zod";
import { isValidRole, mcpServerName, type RoleSlug } from "@shipflare/shared";
import type { CMO } from "../CMO";

/**
 * delegateToEmployee — CMO → employee RPC.
 *
 * The CMO uses this to hand a task off to a specialist (HoG for strategy,
 * SMM for execution, etc.). The receiver is an `McpServer` connected via
 * `addMcpServer` during `onStart` (per-tenant namespaced).
 *
 * Per the Agents SDK (`agents@0.12.x`), the way to invoke a tool on a
 * connected MCP server is `agent.mcp.callTool({ serverId, name, arguments })`
 * where `serverId` is the UUID returned by `addMcpServer`. Because
 * `connectEmployees()` is fire-and-forget (doesn't persist the returned id),
 * we look the server up by its namespaced `name` via `agent.mcp.listServers()`
 * — that name is `mcpServerName(role, userId)`, identical to what
 * `connectEmployees` passed in.
 *
 * Logs each delegation result to `employee_log` so the next founder chat
 * turn can reference it via `query_team_status`-style tools (later).
 */
export function registerDelegationTools(agent: CMO): void {
  agent.server.registerTool(
    "delegateToEmployee",
    {
      description:
        "Hand a task off to a specific employee role. The role must be an active hire. " +
        "The employee's tool returns its result; this CMO logs the summary to employee_log.",
      inputSchema: {
        role: z.string(),
        tool: z.string(),
        args: z.record(z.string(), z.unknown()),
        conversationId: z.string().optional(),
      },
    },
    async ({ role, tool, args, conversationId }) => {
      if (!isValidRole(role)) {
        throw new Error(`Unknown role: ${role}`);
      }
      if (role === "cmo") {
        throw new Error("Cannot delegate to self");
      }

      const userId = agent.props?.userId;
      if (!userId) {
        throw new Error("CMO has no userId in props; cannot delegate");
      }

      // Resolve serverId from the namespaced name. `listServers()` is the
      // SDK's source of truth for connected MCP servers (in-memory + storage).
      const targetName = mcpServerName(role as RoleSlug, userId);
      const server = agent.mcp
        .listServers()
        .find((s) => s.name === targetName);
      if (!server) {
        throw new Error(
          `Employee "${role}" is not connected. Hire them first via hireEmployee.`,
        );
      }

      // Call the requested tool on the employee
      const result = await agent.mcp.callTool({
        serverId: server.id,
        name: tool,
        arguments: args,
      });

      // Log the delegation to employee_log
      const summary = `${role}.${tool} returned`;
      agent.sqlStorage.exec(
        `INSERT INTO employee_log (conversation_id, from_role, kind, summary, payload_json, ts)
         VALUES (?, ?, 'task_complete', ?, ?, ?)`,
        conversationId ?? null,
        role,
        summary,
        JSON.stringify({ tool, args, result }),
        Date.now(),
      );

      return {
        content: [{ type: "text" as const, text: JSON.stringify(result) }],
      };
    },
  );
}
