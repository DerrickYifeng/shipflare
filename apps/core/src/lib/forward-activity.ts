import type { ActivityEventInput } from "@shipflare/shared";
import type { Env } from "../index";
import { transportName } from "./do-name";

/**
 * Forward an activity event from a sub-agent (HoG / SMM / platform DO /
 * onboarding handler) to the user's CMO DO via service binding.
 *
 * Fire-and-forget: sub-agent work must never block on telemetry.
 * Failures are logged (not thrown) — lost forwards are degraded UX, not
 * correctness, but silent .catch(()=>undefined) hides programmer bugs.
 *
 * The DO name MUST be wrapped with `transportName()` so writes land on
 * the same CMO instance the browser reads from (the /mcp transport
 * prepends `streamable-http:` to the DO name — see ./do-name.ts).
 *
 * The URL host is arbitrary; CF routes by binding, not by hostname.
 */
export function forwardActivityToCmo(
  ctx: { waitUntil: (p: Promise<unknown>) => void },
  env: Env,
  userId: string,
  event: ActivityEventInput,
): void {
  const id = env.CMO.idFromName(transportName(userId));
  const stub = env.CMO.get(id);
  ctx.waitUntil(
    stub
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
      }),
  );
}
