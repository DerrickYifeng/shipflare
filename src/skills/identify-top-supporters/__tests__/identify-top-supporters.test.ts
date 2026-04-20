import { describe, it, expect } from 'vitest';
import { topSupportersOutputSchema } from '@/agents/schemas';

describe('topSupportersOutputSchema', () => {
  it('accepts a list of supporters', () => {
    const valid = {
      supporters: [
        {
          username: 'levelsio',
          platform: 'x',
          interactionCount: 4,
          kinds: ['reply', 'repost'],
          lastSeenAt: '2026-04-18T09:32:00Z',
          notes: 'replied twice with a specific use case',
        },
        {
          username: 'shaneparrish',
          platform: 'x',
          interactionCount: 2,
          kinds: ['bookmark'],
          lastSeenAt: '2026-04-17T14:00:00Z',
          notes: null,
        },
      ],
    };
    expect(() => topSupportersOutputSchema.parse(valid)).not.toThrow();
  });

  it('accepts an empty supporters list', () => {
    expect(() =>
      topSupportersOutputSchema.parse({ supporters: [] }),
    ).not.toThrow();
  });

  it('rejects more than 30 supporters', () => {
    const invalid = {
      supporters: Array.from({ length: 31 }, (_, i) => ({
        username: `user_${i}`,
        platform: 'x',
        interactionCount: 1,
        kinds: ['like'],
        lastSeenAt: '2026-04-18T00:00:00Z',
        notes: null,
      })),
    };
    expect(() => topSupportersOutputSchema.parse(invalid)).toThrow();
  });

  it('rejects an unknown kind', () => {
    const invalid = {
      supporters: [
        {
          username: 'a',
          platform: 'x',
          interactionCount: 1,
          kinds: ['share'],
          lastSeenAt: '2026-04-18T00:00:00Z',
          notes: null,
        },
      ],
    };
    expect(() => topSupportersOutputSchema.parse(invalid)).toThrow();
  });

  it('rejects a zero interactionCount', () => {
    const invalid = {
      supporters: [
        {
          username: 'a',
          platform: 'x',
          interactionCount: 0,
          kinds: ['like'],
          lastSeenAt: '2026-04-18T00:00:00Z',
          notes: null,
        },
      ],
    };
    expect(() => topSupportersOutputSchema.parse(invalid)).toThrow();
  });
});
