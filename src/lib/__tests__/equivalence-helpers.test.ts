import { describe, it, expect } from 'vitest';
import {
  countByChannel,
  analyzeDateSpread,
  withinTolerance,
  compareChannelDistribution,
  compareScheduleSpread,
  type EquivalencePlanItem,
} from './equivalence-helpers';

describe('countByChannel', () => {
  it('buckets items by channel and kind', () => {
    const items: EquivalencePlanItem[] = [
      { kind: 'content_post', channel: 'x', scheduledAtISO: '2026-05-01T12:00Z' },
      { kind: 'content_post', channel: 'x', scheduledAtISO: '2026-05-02T12:00Z' },
      { kind: 'content_post', channel: 'reddit', scheduledAtISO: '2026-05-03T12:00Z' },
      { kind: 'setup_task', channel: null, scheduledAtISO: '2026-05-04T12:00Z' },
    ];

    const dist = countByChannel(items);

    expect(dist.counts).toEqual({ x: 2, reddit: 1, none: 1 });
    expect(dist.kinds).toEqual({ content_post: 3, setup_task: 1 });
  });

  it('handles empty input without crashing', () => {
    expect(countByChannel([])).toEqual({ counts: {}, kinds: {} });
  });
});

describe('analyzeDateSpread', () => {
  it('computes min, max, distinct days, and avg gap hours', () => {
    const items: EquivalencePlanItem[] = [
      { kind: 'content_post', channel: 'x', scheduledAtISO: '2026-05-01T09:00:00Z' },
      { kind: 'content_post', channel: 'x', scheduledAtISO: '2026-05-03T09:00:00Z' },
      { kind: 'content_post', channel: 'x', scheduledAtISO: '2026-05-05T09:00:00Z' },
    ];

    const spread = analyzeDateSpread(items);

    expect(spread.minISO).toBe('2026-05-01T09:00:00.000Z');
    expect(spread.maxISO).toBe('2026-05-05T09:00:00.000Z');
    expect(spread.distinctDays).toBe(3);
    expect(spread.avgGapHours).toBe(48);
  });

  it('returns zeros on empty input', () => {
    expect(analyzeDateSpread([])).toEqual({
      minISO: null,
      maxISO: null,
      distinctDays: 0,
      avgGapHours: 0,
    });
  });

  it('skips invalid ISO strings', () => {
    const items: EquivalencePlanItem[] = [
      { kind: 'content_post', channel: 'x', scheduledAtISO: 'not-a-date' },
      { kind: 'content_post', channel: 'x', scheduledAtISO: '2026-05-02T09:00:00Z' },
    ];

    const spread = analyzeDateSpread(items);

    expect(spread.minISO).toBe('2026-05-02T09:00:00.000Z');
    expect(spread.distinctDays).toBe(1);
    expect(spread.avgGapHours).toBe(0);
  });
});

describe('withinTolerance', () => {
  it('passes when actual equals expected', () => {
    expect(withinTolerance(10, 10).pass).toBe(true);
  });

  it('passes within 15% default tolerance', () => {
    expect(withinTolerance(11, 10).pass).toBe(true); // 10% delta
    expect(withinTolerance(8.5, 10).pass).toBe(true); // 15% delta
  });

  it('fails when delta exceeds tolerance', () => {
    expect(withinTolerance(12, 10).pass).toBe(false); // 20% delta
    expect(withinTolerance(7, 10).pass).toBe(false); // 30% delta
  });

  it('treats 0-vs-0 as pass', () => {
    expect(withinTolerance(0, 0).pass).toBe(true);
  });

  it('fails when expected is 0 but actual is not', () => {
    expect(withinTolerance(3, 0).pass).toBe(false);
  });

  it('respects custom tolerance', () => {
    expect(withinTolerance(12, 10, 0.25).pass).toBe(true); // 20% < 25%
    expect(withinTolerance(14, 10, 0.25).pass).toBe(false); // 40% > 25%
  });
});

describe('compareChannelDistribution', () => {
  it('returns one result per channel across both sides', () => {
    const actual = { counts: { x: 5, reddit: 3 }, kinds: {} };
    const expected = { counts: { x: 5, email: 2 }, kinds: {} };

    const results = compareChannelDistribution(actual, expected);

    // x, reddit, email — 3 channels
    expect(results).toHaveLength(3);
    const x = results.find((r) => r.detail.startsWith('channel[x]'));
    const reddit = results.find((r) => r.detail.startsWith('channel[reddit]'));
    const email = results.find((r) => r.detail.startsWith('channel[email]'));
    expect(x?.pass).toBe(true);
    // actual.reddit=3 but expected.reddit=0 → fail
    expect(reddit?.pass).toBe(false);
    // actual.email=0 but expected.email=2 → fail
    expect(email?.pass).toBe(false);
  });
});

describe('compareScheduleSpread', () => {
  it('compares distinctDays + avgGapHours', () => {
    const actual = {
      minISO: '2026-05-01T00:00:00Z',
      maxISO: '2026-05-07T00:00:00Z',
      distinctDays: 7,
      avgGapHours: 24,
    };
    const expected = {
      minISO: '2026-05-01T00:00:00Z',
      maxISO: '2026-05-07T00:00:00Z',
      distinctDays: 7,
      avgGapHours: 25,
    };

    const results = compareScheduleSpread(actual, expected);

    expect(results).toHaveLength(2);
    expect(results.every((r) => r.pass)).toBe(true);
  });

  it('flags drift > 15% on avg gap', () => {
    const actual = { minISO: null, maxISO: null, distinctDays: 7, avgGapHours: 10 };
    const expected = { minISO: null, maxISO: null, distinctDays: 7, avgGapHours: 24 };

    const results = compareScheduleSpread(actual, expected);
    const gapResult = results.find((r) => r.detail.includes('avgGapHours'));
    expect(gapResult?.pass).toBe(false);
  });
});
