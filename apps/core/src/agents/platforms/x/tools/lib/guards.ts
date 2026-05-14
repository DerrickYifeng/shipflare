/**
 * Shared guard helpers for XMcpAgent tools.
 *
 * `requirePublishPermission` is the gate for writes that publish to X
 * (currently `x_post`). Members can only DRAFT — they cannot publish to
 * Twitter on the founder's behalf. Publishing is reserved for:
 *   - `role: "lead"` — the founder-facing CMO orchestrating a campaign
 *   - `caller: "external"` — direct external MCP clients (founder UI,
 *     IDE, etc.) where the OAuth-bound user is explicitly publishing
 *
 * Why a separate function: spec S5.1 calls out testability — the guard
 * is the single most important security boundary on this surface, so it
 * gets its own unit-testable function rather than being inlined inside
 * each tool handler.
 *
 * `requireChannel` mirrors the same pattern for the OAuth-bound check.
 * Tools call `getChannel(env, userId, "x")` and pass the result here so
 * the error message is consistent across `x_post` and `x_metrics`.
 */

import type { McpProps } from "@shipflare/shared";
import type { ChannelConnection } from "../../../../../lib/channel";

/**
 * Throw if the caller is not allowed to PUBLISH to X.
 *
 * Allowed:
 *   - role === "lead"      — CMO / lead agent acting on founder's behalf
 *   - caller === "external" — direct founder client (UI / IDE / CLI)
 *
 * Rejected (members):
 *   - role === "member" with caller !== "external" → throws
 *   - missing role + caller !== "external" → throws
 */
export function requirePublishPermission(
  props: McpProps | undefined,
): void {
  const role = props?.role;
  const caller = props?.caller;
  if (role !== "lead" && caller !== "external") {
    throw new Error(
      "x_post requires role='lead' or caller='external'. " +
        "Members produce drafts; founders/external clients publish.",
    );
  }
}

/**
 * Narrow `getChannel` result to non-null with a uniform error message.
 * Returns the channel for chained use: `const ch = requireChannel(await getChannel(...))`.
 */
export function requireChannel(
  channel: ChannelConnection | null,
): ChannelConnection {
  if (!channel) {
    throw new Error(
      "X channel not connected for this user. Connect via the OAuth flow first.",
    );
  }
  return channel;
}

/**
 * Look up `userId` on the agent's props with a uniform error. Tools call
 * this at the top of their handler so the error message points at a
 * mis-wired props/JWT path rather than crashing on `undefined`.
 */
export function requireUserId(props: McpProps | undefined): string {
  const userId = props?.userId;
  if (!userId) {
    throw new Error(
      "XMcpAgent has no userId in props; cannot resolve channel or auth state.",
    );
  }
  return userId;
}
