/**
 * Resolve a per-request inferred timezone from two potential sources, in
 * priority order:
 *
 *   1. `?tz=` query param — browser-provided via
 *      `Intl.DateTimeFormat().resolvedOptions().timeZone`. The browser is the
 *      most reliable source (matches the founder's actual locale, not their
 *      VPN exit node), so it wins over the CF guess.
 *   2. `request.cf.timezone` — Cloudflare's IP-geolocation guess. Available
 *      on every edge request that reaches a Worker, but reflects the user's
 *      egress IP — VPNs / mobile carriers can place it anywhere.
 *
 * If both are missing or invalid IANA names, returns 'UTC' as a safe default.
 *
 * Validation is `new Intl.DateTimeFormat('en-CA', { timeZone })` — throws
 * `RangeError` on unknown IANA names. Invalid sources fall through to the
 * next candidate so a garbage query param doesn't poison a valid CF guess.
 *
 * Used by `handleCmoWsRequest` to thread an `x-inferred-tz` header into the
 * CMO DO; first-connect (5.1c.15) reads it to bootstrap
 * `founder_context.tz` if unset.
 */
export function inferTimezone(
	fromQuery: string | undefined,
	fromCf: string | undefined,
): string {
	const candidates = [fromQuery, fromCf].filter(
		(s): s is string => typeof s === "string" && s.length > 0,
	);
	for (const tz of candidates) {
		try {
			// Side-effect ctor; throws RangeError on unknown IANA names.
			new Intl.DateTimeFormat("en-CA", { timeZone: tz });
			return tz;
		} catch {
			// invalid IANA — try next candidate
		}
	}
	return "UTC";
}
