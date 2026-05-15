import { describe, it, expect } from 'vitest';
import { inflightCapForTier } from '@/lib/team/team-tier';

describe('inflightCapForTier', () => {
  it('returns the documented cap for the free tier', () => {
    expect(inflightCapForTier('free')).toBe(3);
  });
  it('returns the documented cap for the paid tier', () => {
    expect(inflightCapForTier('paid')).toBe(10);
  });
  it('returns the documented cap for the premium tier', () => {
    expect(inflightCapForTier('premium')).toBe(25);
  });
});
