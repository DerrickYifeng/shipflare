/**
 * Schema-shape tests for `src/tools/schemas.ts`. Covers the
 * back-compat we rely on when adding optional fields to long-lived
 * jsonb columns (strategic_paths.channel_mix and thesisArc[i].posts in
 * particular).
 */
import { describe, it, expect } from 'vitest';
import {
  strategicChannelSettingsSchema,
  strategicPathSchema,
  strategicThesisWeekSchema,
} from '@/tools/schemas';

const baseChannelSettings = {
  preferredHours: [9, 14, 19],
};

describe('strategicChannelSettingsSchema', () => {
  it('parses a minimal settings entry (no repliesPerDay)', () => {
    const parsed = strategicChannelSettingsSchema.parse(baseChannelSettings);
    expect(parsed.preferredHours).toEqual([9, 14, 19]);
    // Missing field arrives as undefined (zod nullish).
    expect(parsed.repliesPerDay).toBeUndefined();
  });

  it('accepts repliesPerDay when present (X reply automation enabled)', () => {
    const parsed = strategicChannelSettingsSchema.parse({
      ...baseChannelSettings,
      repliesPerDay: 12,
    });
    expect(parsed.repliesPerDay).toBe(12);
  });

  it('accepts repliesPerDay = 0 (reply automation explicitly disabled)', () => {
    const parsed = strategicChannelSettingsSchema.parse({
      ...baseChannelSettings,
      repliesPerDay: 0,
    });
    expect(parsed.repliesPerDay).toBe(0);
  });

  it('accepts repliesPerDay = null (e.g. reddit row by convention)', () => {
    const parsed = strategicChannelSettingsSchema.parse({
      ...baseChannelSettings,
      repliesPerDay: null,
    });
    expect(parsed.repliesPerDay).toBeNull();
  });

  it('rejects negative repliesPerDay', () => {
    const result = strategicChannelSettingsSchema.safeParse({
      ...baseChannelSettings,
      repliesPerDay: -1,
    });
    expect(result.success).toBe(false);
  });

  it('rejects repliesPerDay > 50 (research caps the real-world high end at ~50/day)', () => {
    const result = strategicChannelSettingsSchema.safeParse({
      ...baseChannelSettings,
      repliesPerDay: 51,
    });
    expect(result.success).toBe(false);
  });

  it('rejects non-integer repliesPerDay', () => {
    const result = strategicChannelSettingsSchema.safeParse({
      ...baseChannelSettings,
      repliesPerDay: 5.5,
    });
    expect(result.success).toBe(false);
  });

  it('preserves legacy `perWeek` via passthrough so derivePerWeekPosts can fall back to it', () => {
    const parsed = strategicChannelSettingsSchema.parse({
      ...baseChannelSettings,
      perWeek: 4,
    }) as { perWeek?: number };
    expect(parsed.perWeek).toBe(4);
  });
});

describe('strategicThesisWeekSchema', () => {
  const baseWeek = {
    weekStart: '2026-05-04',
    theme: 'foundation week',
    angleMix: ['claim'] as const,
  };

  it('parses a week with no per-week posts (legacy shape)', () => {
    const parsed = strategicThesisWeekSchema.parse(baseWeek);
    expect(parsed.posts).toBeUndefined();
  });

  it('parses a week with per-channel post allocation', () => {
    const parsed = strategicThesisWeekSchema.parse({
      ...baseWeek,
      posts: { x: 3, reddit: 1 },
    });
    expect(parsed.posts?.x).toBe(3);
    expect(parsed.posts?.reddit).toBe(1);
    expect(parsed.posts?.email).toBeUndefined();
  });

  it('rejects post counts above the per-week ceiling', () => {
    const result = strategicThesisWeekSchema.safeParse({
      ...baseWeek,
      posts: { x: 99 },
    });
    expect(result.success).toBe(false);
  });

  it('rejects non-integer post counts', () => {
    const result = strategicThesisWeekSchema.safeParse({
      ...baseWeek,
      posts: { x: 1.5 },
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
          posts: { x: 2 },
        },
      ],
      contentPillars: ['Pillar A', 'Pillar B', 'Pillar C'],
      channelMix: channelMixOverride ?? {
        x: { ...baseChannelSettings },
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
        x: { ...baseChannelSettings, repliesPerDay: 8 },
      }),
    );
    expect(parsed.channelMix.x?.repliesPerDay).toBe(8);
  });

  it('parses a path with X reply automation but reddit posts only (no reddit replies)', () => {
    const parsed = strategicPathSchema.parse(
      makePath({
        x: { ...baseChannelSettings, repliesPerDay: 10 },
        reddit: { preferredHours: [15, 19] },
      }),
    );
    expect(parsed.channelMix.x?.repliesPerDay).toBe(10);
    expect(parsed.channelMix.reddit?.repliesPerDay).toBeUndefined();
  });

  it('preserves legacy `perWeek` on channelMix entries via passthrough', () => {
    // strategic_paths rows generated before per-week posts existed
    // carry `perWeek` directly on the channel-mix entry. Schema parse
    // must NOT strip it — derivePerWeekPosts uses it as a fallback.
    const parsed = strategicPathSchema.parse(
      makePath({
        x: { ...baseChannelSettings, perWeek: 5 },
      }),
    );
    const xEntry = parsed.channelMix.x as { perWeek?: number } | null | undefined;
    expect(xEntry?.perWeek).toBe(5);
  });
});
