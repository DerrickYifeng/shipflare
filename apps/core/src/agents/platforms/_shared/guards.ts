/**
 * Shared guard helpers for platform MCP tools (X, Reddit, and future
 * LinkedIn / Threads).
 *
 * Three boundaries every platform-publishing tool re-checks:
 *
 *   1. `requirePublishPermission(props, toolName?)` — role gate. Members
 *      can DRAFT but cannot PUBLISH. Publishing is reserved for
 *        - role === "lead"     (CMO orchestrating on founder's behalf)
 *        - caller === "external" (direct founder UI / IDE / CLI client)
 *
 *   2. `requireChannel(channel, platform?)` — narrow `getChannel` result
 *      to non-null. Returns the channel for chained use.
 *
 *   3. `requireUserId(props, agentName?)` — pull `userId` off the MCP
 *      props with a uniform error message pointing at a mis-wired
 *      props/JWT path.
 *
 * Why a separate module: the guards are the single most important
 * security boundary on the platform-tool surface — they each get a
 * unit-testable function rather than being inlined inside the tool
 * handler. Moved from `x/tools/lib/guards.ts` to `_shared/` in S5.2 so
 * Reddit tools share the same enforcement without copy-paste drift.
 *
 * The optional `platform` / `toolName` / `agentName` arguments are
 * purely for error-message clarity — the validation logic is identical
 * regardless of which platform invokes the guard.
 */

import type { McpProps } from "@shipflare/shared";
import type { ChannelConnection } from "../../../lib/channel";

/**
 * Throw if the caller is not allowed to PUBLISH (write) on a platform.
 *
 * Allowed:
 *   - role === "lead"       (CMO / lead agent acting on founder's behalf)
 *   - caller === "external"  (direct founder client — UI / IDE / CLI)
 *
 * Rejected (members):
 *   - role === "member" with caller !== "external" → throws
 *   - missing role + caller !== "external" → throws (default-deny)
 *
 * `toolName` is the publishing tool's MCP name (e.g. `"x_post"` /
 * `"reddit_post"`) — it appears in the error message so callers can
 * grep logs and route quickly to the offending handler.
 */
export function requirePublishPermission(
  props: McpProps | undefined,
  toolName: string = "platform post",
): void {
  const role = props?.role;
  const caller = props?.caller;
  if (role !== "lead" && caller !== "external") {
    throw new Error(
      `${toolName} requires role='lead' or caller='external'. ` +
        "Members produce drafts; founders/external clients publish.",
    );
  }
}

/**
 * Narrow `getChannel` result to non-null with a uniform error message.
 * Returns the channel for chained use:
 *   `const ch = requireChannel(await getChannel(env, userId, "reddit"), "reddit");`
 *
 * `platform` is the founder-facing label that appears in the error
 * (e.g. `"X"`, `"Reddit"`). Defaults to the generic `"platform"` so the
 * helper still composes when called without context.
 */
export function requireChannel(
  channel: ChannelConnection | null,
  platform: string = "platform",
): ChannelConnection {
  if (!channel) {
    throw new Error(
      `${platform} channel not connected for this user. ` +
        "Connect via the OAuth flow first.",
    );
  }
  return channel;
}

/**
 * Look up `userId` on the agent's props with a uniform error. Tools
 * call this at the top of their handler so the error message points
 * at a mis-wired props/JWT path rather than crashing on `undefined`.
 *
 * `agentName` is the MCP agent class label (e.g. `"XMcpAgent"`,
 * `"RedditMcpAgent"`) and appears in the error message so platform
 * misconfigurations surface unambiguously.
 */
export function requireUserId(
  props: McpProps | undefined,
  agentName: string = "platform MCP agent",
): string {
  const userId = props?.userId;
  if (!userId) {
    throw new Error(
      `${agentName} has no userId in props; cannot resolve channel or auth state.`,
    );
  }
  return userId;
}
