import type { ActivityEventInput } from "@shipflare/shared";
import type { Env } from "../index";

/**
 * Forward an activity event from a sub-agent (HoG / SMM / platform DO /
 * onboarding handler) to the user's CMO DO via service binding.
 *
 * Fire-and-forget: sub-agent work must never block on telemetry.
 * Failures are swallowed — lost forwards are degraded UX, not correctness.
 *
 * The URL host is arbitrary; CF routes by binding, not by hostname.
 */
export function forwardActivityToCmo(
  ctx: { waitUntil: (p: Promise<unknown>) => void },
  env: Env,
  userId: string,
  event: ActivityEventInput,
): void {
  const id = env.CMO.idFromName(userId);
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
      .catch(() => undefined),
  );
}
