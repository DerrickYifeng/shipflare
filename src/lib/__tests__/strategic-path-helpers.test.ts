import { describe, it, expect } from 'vitest';
import {
  derivePerWeekPosts,
  sumChannelPostsAcrossArc,
} from '@/lib/strategic-path-helpers';
import type { StrategicPath } from '@/tools/schemas';

function basePath(
  overrides: Partial<StrategicPath> = {},
): Pick<StrategicPath, 'thesisArc' | 'channelMix'> {
  return {
    thesisArc: [
      {
        weekStart: '2026-05-04',
        theme: 't1',
        angleMix: ['claim'],
      },
      {
        weekStart: '2026-05-11',
        theme: 't2',
        angleMix: ['howto'],
      },
    ],
    channelMix: {
      x: { preferredHours: [14] },
      reddit: { preferredHours: [15] },
    },
    ...overrides,
  } as unknown as Pick<StrategicPath, 'thesisArc' | 'channelMix'>;
}

describe('derivePerWeekPosts', () => {
  it('reads the new-shape posts field when present', () => {
    const path = basePath({
      thesisArc: [
        {
          weekStart: '2026-05-04',
          theme: 't1',
          angleMix: ['claim'],
          posts: { x: 3, reddit: 1 },
        },
      ],
    } as unknown as Partial<StrategicPath>);
    expect(derivePerWeekPosts(path, 0)).toEqual({ x: 3, reddit: 1, email: 0 });
  });

  it('falls back to legacy channelMix.{ch}.perWeek when posts is absent', () => {
    const path = {
      thesisArc: [
        {
          weekStart: '2026-05-04',
          theme: 't1',
          angleMix: ['claim'],
        },
      ],
      channelMix: {
        x: { perWeek: 4, preferredHours: [14] },
        reddit: { perWeek: 1, preferredHours: [15] },
      },
    } as unknown as Pick<StrategicPath, 'thesisArc' | 'channelMix'>;
    expect(derivePerWeekPosts(path, 0)).toEqual({ x: 4, reddit: 1, email: 0 });
  });

  it('prefers per-week posts over the legacy fallback when both are present', () => {
    const path = {
      thesisArc: [
        {
          weekStart: '2026-05-04',
          theme: 't1',
          angleMix: ['claim'],
          posts: { x: 2 },
        },
      ],
      channelMix: {
        x: { perWeek: 7, preferredHours: [14] },
      },
    } as unknown as Pick<StrategicPath, 'thesisArc' | 'channelMix'>;
    expect(derivePerWeekPosts(path, 0)).toEqual({ x: 2, reddit: 0, email: 0 });
  });

  it('returns zeros when neither posts nor legacy perWeek exist', () => {
    const path = basePath();
    expect(derivePerWeekPosts(path, 0)).toEqual({ x: 0, reddit: 0, email: 0 });
  });

  it('returns zeros when weekIndex is out of range', () => {
    const path = basePath({
      thesisArc: [
        {
          weekStart: '2026-05-04',
          theme: 't1',
          angleMix: ['claim'],
          posts: { x: 3 },
        },
      ],
    } as unknown as Partial<StrategicPath>);
    expect(derivePerWeekPosts(path, 5)).toEqual({ x: 0, reddit: 0, email: 0 });
  });

  it('treats missing channels in posts as 0', () => {
    const path = basePath({
      thesisArc: [
        {
          weekStart: '2026-05-04',
          theme: 't1',
          angleMix: ['claim'],
          posts: { x: 2 },
        },
      ],
    } as unknown as Partial<StrategicPath>);
    expect(derivePerWeekPosts(path, 0)).toEqual({ x: 2, reddit: 0, email: 0 });
  });
});

describe('sumChannelPostsAcrossArc', () => {
  it('adds per-week posts for the channel across all weeks', () => {
    const path = {
      thesisArc: [
        {
          weekStart: '2026-05-04',
          theme: 't1',
          angleMix: ['claim'],
          posts: { x: 2, reddit: 1 },
        },
        {
          weekStart: '2026-05-11',
          theme: 't2',
          angleMix: ['howto'],
          posts: { x: 4 },
        },
      ],
      channelMix: {},
    } as unknown as Pick<StrategicPath, 'thesisArc' | 'channelMix'>;
    expect(sumChannelPostsAcrossArc(path, 'x')).toBe(6);
    expect(sumChannelPostsAcrossArc(path, 'reddit')).toBe(1);
    expect(sumChannelPostsAcrossArc(path, 'email')).toBe(0);
  });

  it('legacy uniform perWeek multiplies across every week of the arc', () => {
    const path = {
      thesisArc: [
        { weekStart: '2026-05-04', theme: 't1', angleMix: ['claim'] },
        { weekStart: '2026-05-11', theme: 't2', angleMix: ['howto'] },
        { weekStart: '2026-05-18', theme: 't3', angleMix: ['data'] },
      ],
      channelMix: {
        x: { perWeek: 3, preferredHours: [14] },
        reddit: { perWeek: 1, preferredHours: [15] },
      },
    } as unknown as Pick<StrategicPath, 'thesisArc' | 'channelMix'>;
    expect(sumChannelPostsAcrossArc(path, 'x')).toBe(9);
    expect(sumChannelPostsAcrossArc(path, 'reddit')).toBe(3);
  });
});
