// Shared helpers for the onboarding v2 ↔ v3 equivalence eval.
//
// Consumed by `onboarding-equivalence.eval.test.ts`. Separated here so the
// metric logic can be unit-tested independently when we wire it up and so
// the test file stays readable.

/** Plan item shape we care about for the four equivalence metrics. */
export interface EquivalencePlanItem {
  kind: string;
  channel: string | null;
  scheduledAtISO: string;
}

export interface ChannelDistribution {
  /** Count by channel id ('x', 'reddit', 'email', 'none'). */
  counts: Record<string, number>;
  /** Count by kind (content_post, setup_task, etc). */
  kinds: Record<string, number>;
}

export interface ScheduleSpread {
  /** ISO timestamp of the earliest scheduledAt. */
  minISO: string | null;
  /** ISO timestamp of the latest scheduledAt. */
  maxISO: string | null;
  /** Number of distinct days covered (UTC midnight buckets). */
  distinctDays: number;
  /** Average gap between consecutive scheduled items in hours (0 if <2 items). */
  avgGapHours: number;
}

// ---------------------------------------------------------------------------
// Metric computations
// ---------------------------------------------------------------------------

export function countByChannel(items: EquivalencePlanItem[]): ChannelDistribution {
  const counts: Record<string, number> = {};
  const kinds: Record<string, number> = {};
  for (const item of items) {
    const channelKey = item.channel ?? 'none';
    counts[channelKey] = (counts[channelKey] ?? 0) + 1;
    kinds[item.kind] = (kinds[item.kind] ?? 0) + 1;
  }
  return { counts, kinds };
}

export function analyzeDateSpread(items: EquivalencePlanItem[]): ScheduleSpread {
  if (items.length === 0) {
    return { minISO: null, maxISO: null, distinctDays: 0, avgGapHours: 0 };
  }

  const timestamps = items
    .map((i) => new Date(i.scheduledAtISO).getTime())
    .filter((t) => Number.isFinite(t))
    .sort((a, b) => a - b);

  if (timestamps.length === 0) {
    return { minISO: null, maxISO: null, distinctDays: 0, avgGapHours: 0 };
  }

  const dayBuckets = new Set<string>();
  for (const t of timestamps) {
    const d = new Date(t);
    dayBuckets.add(`${d.getUTCFullYear()}-${d.getUTCMonth()}-${d.getUTCDate()}`);
  }

  let avgGapHours = 0;
  if (timestamps.length >= 2) {
    let sumGap = 0;
    for (let i = 1; i < timestamps.length; i++) {
      sumGap += timestamps[i] - timestamps[i - 1];
    }
    avgGapHours = sumGap / (timestamps.length - 1) / 3_600_000;
  }

  return {
    minISO: new Date(timestamps[0]).toISOString(),
    maxISO: new Date(timestamps[timestamps.length - 1]).toISOString(),
    distinctDays: dayBuckets.size,
    avgGapHours,
  };
}

// ---------------------------------------------------------------------------
// Tolerance comparisons
// ---------------------------------------------------------------------------

export interface ToleranceResult {
  pass: boolean;
  detail: string;
}

/**
 * Pass when |actual − expected| ≤ max(|expected| × tolerance, absoluteFloor).
 *
 * The `absoluteFloor` (default 1) prevents small-N metrics from failing on
 * 1-unit LLM variance — a ±1 difference on a channel counting N=3 items is
 * statistical noise, not a quality regression, and would always blow the
 * 15% relative bar.
 *
 * 0-vs-0 always passes; expected=0 with actual≠0 passes only if
 * |actual| ≤ absoluteFloor.
 */
export function withinTolerance(
  actual: number,
  expected: number,
  tolerance = 0.15,
  label = 'value',
  absoluteFloor = 1,
): ToleranceResult {
  const absDelta = Math.abs(actual - expected);
  if (expected === 0) {
    const pass = absDelta <= absoluteFloor;
    return {
      pass,
      detail:
        actual === 0
          ? `${label}: 0 == 0`
          : `${label}: expected 0 but got ${actual} (floor=${absoluteFloor})`,
    };
  }
  const relDelta = absDelta / Math.abs(expected);
  const allowedAbs = Math.max(Math.abs(expected) * tolerance, absoluteFloor);
  const pass = absDelta <= allowedAbs;
  return {
    pass,
    detail: `${label}: actual=${actual} expected=${expected} delta=${(relDelta * 100).toFixed(1)}% (allow ±${allowedAbs.toFixed(2)})`,
  };
}

/**
 * Compare channel count distributions within ±tolerance. Missing channels
 * on one side are treated as 0. Returns one result per channel key so the
 * test can surface individual drift rather than a single "not equal" line.
 */
export function compareChannelDistribution(
  actual: ChannelDistribution,
  expected: ChannelDistribution,
  tolerance = 0.15,
): ToleranceResult[] {
  const allChannels = new Set<string>([
    ...Object.keys(actual.counts),
    ...Object.keys(expected.counts),
  ]);
  const results: ToleranceResult[] = [];
  for (const ch of allChannels) {
    const a = actual.counts[ch] ?? 0;
    const e = expected.counts[ch] ?? 0;
    results.push(withinTolerance(a, e, tolerance, `channel[${ch}]`));
  }
  return results;
}

/**
 * Compare schedule spreads within ±tolerance. `distinctDays` and
 * `avgGapHours` are compared numerically; min/max ISOs are not compared
 * directly (they're useful for debug output but drift by hours is
 * expected).
 */
export function compareScheduleSpread(
  actual: ScheduleSpread,
  expected: ScheduleSpread,
  tolerance = 0.15,
): ToleranceResult[] {
  return [
    withinTolerance(
      actual.distinctDays,
      expected.distinctDays,
      tolerance,
      'distinctDays',
    ),
    withinTolerance(
      actual.avgGapHours,
      expected.avgGapHours,
      tolerance,
      'avgGapHours',
    ),
  ];
}
