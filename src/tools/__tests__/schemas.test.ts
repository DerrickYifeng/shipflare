/**
 * Schema-shape tests for `src/tools/schemas.ts`. Covers the
 * back-compat we rely on when adding optional fields to long-lived
 * jsonb columns (strategic_paths.channel_mix in particular).
 */
import { describe, it, expect } from 'vitest';
import {
  strategicChannelCadenceSchema,
  strategicPathSchema,
} from '@/tools/schemas';

const baseChannelCadence = {
  perWeek: 4,
  preferredHours: [9, 14, 19],
};

describe('strategicChannelCadenceSchema', () => {
  it('parses a minimal cadence (no repliesPerDay) — back-compat for legacy rows', () => {
    const parsed = strategicChannelCadenceSchema.parse(baseChannelCadence);
    expect(parsed.perWeek).toBe(4);
    // Missing field arrives as undefined (zod nullish).
    expect(parsed.repliesPerDay).toBeUndefined();
  });

  it('accepts repliesPerDay when present (X reply automation enabled)', () => {
    const parsed = strategicChannelCadenceSchema.parse({
      ...baseChannelCadence,
      repliesPerDay: 12,
    });
    expect(parsed.repliesPerDay).toBe(12);
  });

  it('accepts repliesPerDay = 0 (reply automation explicitly disabled)', () => {
    const parsed = strategicChannelCadenceSchema.parse({
      ...baseChannelCadence,
      repliesPerDay: 0,
    });
    expect(parsed.repliesPerDay).toBe(0);
  });

  it('accepts repliesPerDay = null (e.g. reddit row by convention)', () => {
    const parsed = strategicChannelCadenceSchema.parse({
      ...baseChannelCadence,
      repliesPerDay: null,
    });
    expect(parsed.repliesPerDay).toBeNull();
  });

  it('rejects negative repliesPerDay', () => {
    const result = strategicChannelCadenceSchema.safeParse({
      ...baseChannelCadence,
      repliesPerDay: -1,
    });
    expect(result.success).toBe(false);
  });

  it('rejects repliesPerDay > 50 (research caps the real-world high end at ~50/day)', () => {
    const result = strategicChannelCadenceSchema.safeParse({
      ...baseChannelCadence,
      repliesPerDay: 51,
    });
    expect(result.success).toBe(false);
  });

  it('rejects non-integer repliesPerDay', () => {
    const result = strategicChannelCadenceSchema.safeParse({
      ...baseChannelCadence,
      repliesPerDay: 5.5,
    });
    expect(result.success).toBe(false);
  });
});

describe('strategicPathSchema', () => {
  function makePath(channelMixOverride?: Record<string, unknown>) {
    return {
      narrative: 'A'.repeat(220),
      milestones: [
        { atDayOffset: 0, title: 'Launch', successMetric: '100 users', phase: 'launch' as const },
        { atDayOffset: 7, title: 'Week 1', successMetric: '500 users', phase: 'compound' as const },
        { atDayOffset: 30, title: 'Month 1', successMetric: '$1k MRR', phase: 'compound' as const },
      ],
      thesisArc: [
        {
          weekStart: '2026-01-01',
          theme: 'Identity: dev-led marketing',
          angleMix: ['claim'] as Array<'claim'>,
        },
      ],
      contentPillars: ['Pillar A', 'Pillar B', 'Pillar C'],
      channelMix: channelMixOverride ?? {
        x: { ...baseChannelCadence },
      },
      phaseGoals: { foundation: 'ship the rough cut' },
    };
  }

  it('parses a path whose channelMix.x has no repliesPerDay (legacy)', () => {
    const parsed = strategicPathSchema.parse(makePath());
    expect(parsed.channelMix.x?.repliesPerDay).toBeUndefined();
  });

  it('parses a path whose channelMix.x has repliesPerDay set', () => {
    const parsed = strategicPathSchema.parse(
      makePath({
        x: { ...baseChannelCadence, repliesPerDay: 8 },
      }),
    );
    expect(parsed.channelMix.x?.repliesPerDay).toBe(8);
  });

  it('parses a path with X reply automation but reddit posts only (no reddit replies)', () => {
    const parsed = strategicPathSchema.parse(
      makePath({
        x: { ...baseChannelCadence, repliesPerDay: 10 },
        reddit: { perWeek: 1, preferredHours: [15, 19] },
      }),
    );
    expect(parsed.channelMix.x?.repliesPerDay).toBe(10);
    expect(parsed.channelMix.reddit?.repliesPerDay).toBeUndefined();
  });
});
