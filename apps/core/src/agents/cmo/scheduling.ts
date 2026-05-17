/**
 * Compute the next UTC ms timestamp where the wall-clock hour in `tz` equals `hour`.
 *
 * Uses Intl.DateTimeFormat to format `nowMs` in `tz`, then constructs a candidate
 * at `Y-M-D hour:00:00` UTC and adjusts by the offset delta observed when that
 * candidate is re-formatted in `tz`. This handles DST naturally (no manual
 * zone-offset math).
 *
 * `tz` is an IANA timezone name (e.g. "America/New_York", "Asia/Hong_Kong", "UTC").
 * `hour` is 0..23 (integer).
 *
 * If `hour` has already passed in `tz` today, adds 24h (returns tomorrow's instance).
 *
 * NOTE: For tz that DON'T align to whole hours (e.g. India 'Asia/Kolkata' = UTC+5:30,
 * Nepal 'Asia/Kathmandu' = UTC+5:45), the wall-clock hour will still be correct because
 * we re-read it via Intl, BUT the candidate timestamp will be off by the sub-hour
 * minutes. For 5.1c, accept that wall-clock-hour granularity is sufficient (founder
 * relay fires at "9am" not "9:00 sharp").
 */
export function computeNextDailyAt(
	tz: string,
	hour: number,
	nowMs: number,
): number {
	if (!Number.isInteger(hour) || hour < 0 || hour > 23) {
		throw new Error(`computeNextDailyAt: invalid hour ${hour}`);
	}

	// 1. Get the current Y-M-D in `tz`
	const fmt = new Intl.DateTimeFormat("en-CA", {
		timeZone: tz,
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
		hour12: false,
	});
	const parts = fmt.formatToParts(new Date(nowMs));
	const getPart = (type: string): number =>
		Number(parts.find((p) => p.type === type)?.value ?? "0");
	const year = getPart("year");
	const month = getPart("month");
	const day = getPart("day");

	// 2. Construct a UTC candidate at Y-M-D hour:00:00, then compute the wall-clock
	//    hour that this UTC time displays in `tz`. The delta = (target - observed) mod 24
	//    is how many hours to add (mod 24) so the candidate's wall-clock hour in `tz`
	//    matches the target.
	const candidateUtcMs = Date.UTC(year, month - 1, day, hour, 0, 0);
	const observedHour = Number(
		new Intl.DateTimeFormat("en-CA", {
			timeZone: tz,
			hour: "2-digit",
			hour12: false,
		})
			.formatToParts(new Date(candidateUtcMs))
			.find((p) => p.type === "hour")?.value ?? "0",
	);
	const hourDelta = ((hour - observedHour) + 24) % 24;
	let target = candidateUtcMs + hourDelta * 3600 * 1000;

	// 3. If the target is in the past (already happened in tz today), jump 24h.
	if (target <= nowMs) {
		target += 24 * 3600 * 1000;
	}
	return target;
}
