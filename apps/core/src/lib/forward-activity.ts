import type { ActivityEventInput } from "@shipflare/shared";
import type { Env } from "../index";
import { transportName } from "./do-name";

/**
 * Forward an activity event from a sub-agent (HoG / SMM / platform DO /
 * onboarding handler) to the user's CMO DO via service binding.
 *
 * Returns the pending Promise so callers can choose to:
 *   - `await` it for critical lifecycle events (dispatch, finish) to
 *     guarantee the event lands in CMO SQLite + is broadcast to connected
 *     WebSocket clients BEFORE the caller's own response closes.
 *   - Pass it to `ctx.waitUntil()` for non-critical events (text deltas)
 *     where fire-and-forget is acceptable.
 *
 * Background: ctx.waitUntil tasks are not guaranteed to execute before a
 * streaming SSE response body closes. For subagent_dispatch/finish events
 * the caller MUST await so the browser's useCmoActivity hook sees them
 * before the stage advances. Text deltas are lower priority and can still
 * use ctx.waitUntil.
 *
 * The DO name MUST be wrapped with `transportName()` so writes land on
 * the same CMO instance the browser reads from.
 */
export function forwardActivityToCmo(
  env: Env,
  userId: string,
  event: ActivityEventInput,
): Promise<void> {
  const id = env.CMO.idFromName(transportName(userId));
  const stub = env.CMO.get(id);
  return stub
    .fetch("https://internal/internal/log-activity", {
      method: "POST",
      headers: {
        "x-shipflare-internal": "1",
        "content-type": "application/json",
      },
      body: JSON.stringify(event),
    })
    .then((res) => {
      if (!res.ok) {
        console.warn(`[forwardActivityToCmo] non-OK ${res.status}`);
      }
    })
    .catch((err) => {
      console.warn("[forwardActivityToCmo] forward failed:", err);
    });
}
