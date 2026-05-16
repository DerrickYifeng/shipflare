import { z } from "zod";
import type { HeadOfGrowth } from "../HeadOfGrowth";
import {
  extractTrace,
  withSubAgentToolTracing,
} from "../../../lib/subagent-activity";

/**
 * ping — diagnostic tool that exercises the `withSubAgentToolTracing`
 * helper end-to-end (CMO `delegateToEmployee` → HoG `ping`
 * → forwardActivityToCmo → CMO activity_events).
 *
 * No production behavior beyond returning "pong". Kept lightweight so
 * the activity-feed integration tests can drive it without standing up
 * an Anthropic key, MCP-RPC plumbing, or real planning state.
 *
 * `_trace` is declared in the input schema so the MCP SDK's Zod parser
 * doesn't strip the field before the handler runs (see
 * `subagent-activity.ts` doc comment for the strip-behavior caveat).
 */
export function registerPingTool(agent: HeadOfGrowth): void {
  agent.server.registerTool(
    "ping",
    {
      description:
        "Diagnostic ping — used by activity-feed integration tests to " +
        "verify sub-agent → CMO activity forwarding works end-to-end.",
      inputSchema: {
        _trace: z.unknown().optional(),
      },
    },
    async (args) => {
      const trace = extractTrace(args);
      return withSubAgentToolTracing(
        agent.runtimeCtx,
        agent.bindings,
        trace,
        "head-of-growth",
        "ping",
        args,
        async () => ({
          content: [{ type: "text" as const, text: "pong" }],
        }),
      );
    },
  );
}
