import { describe, expect, it, vi } from 'vitest';
import {
  decideReviewMode,
  shouldReviewRun,
  COLD_THRESHOLD,
  HOT_THRESHOLD,
  type ReviewDecision,
} from '../review-gate';

describe('decideReviewMode', () => {
  it('returns cold with 100% sample rate below COLD_THRESHOLD', () => {
    expect(decideReviewMode(0)).toEqual({
      mode: 'cold',
      sampleRate: 1.0,
      labelCount: 0,
    });
    expect(decideReviewMode(COLD_THRESHOLD - 1)).toEqual({
      mode: 'cold',
      sampleRate: 1.0,
      labelCount: COLD_THRESHOLD - 1,
    });
  });

  it('returns warm with 10% sample rate between COLD and HOT thresholds', () => {
    expect(decideReviewMode(COLD_THRESHOLD)).toEqual({
      mode: 'warm',
      sampleRate: 0.1,
      labelCount: COLD_THRESHOLD,
    });
    expect(decideReviewMode(HOT_THRESHOLD - 1)).toEqual({
      mode: 'warm',
      sampleRate: 0.1,
      labelCount: HOT_THRESHOLD - 1,
    });
  });

  it('returns hot with 0% sample rate at and above HOT_THRESHOLD', () => {
    expect(decideReviewMode(HOT_THRESHOLD)).toEqual({
      mode: 'hot',
      sampleRate: 0,
      labelCount: HOT_THRESHOLD,
    });
    expect(decideReviewMode(HOT_THRESHOLD + 500)).toEqual({
      mode: 'hot',
      sampleRate: 0,
      labelCount: HOT_THRESHOLD + 500,
    });
  });

  it('thresholds match the plan-decision values (30 / 100)', () => {
    // Locked into tests so future threshold changes require explicit
    // opt-in (they're a business decision, not a refactor).
    expect(COLD_THRESHOLD).toBe(30);
    expect(HOT_THRESHOLD).toBe(100);
  });
});

describe('shouldReviewRun', () => {
  const cold: ReviewDecision = { mode: 'cold', sampleRate: 1.0, labelCount: 0 };
  const warm: ReviewDecision = {
    mode: 'warm',
    sampleRate: 0.1,
    labelCount: 50,
  };
  const hot: ReviewDecision = { mode: 'hot', sampleRate: 0, labelCount: 150 };

  it('always runs when cold', () => {
    expect(shouldReviewRun(cold, () => 0.99)).toBe(true);
    expect(shouldReviewRun(cold, () => 0)).toBe(true);
  });

  it('never runs when hot', () => {
    expect(shouldReviewRun(hot, () => 0)).toBe(false);
    expect(shouldReviewRun(hot, () => 0.001)).toBe(false);
  });

  it('samples at the configured rate when warm', () => {
    // rng < sampleRate → run
    expect(shouldReviewRun(warm, () => 0.05)).toBe(true);
    // rng >= sampleRate → skip
    expect(shouldReviewRun(warm, () => 0.1)).toBe(false);
    expect(shouldReviewRun(warm, () => 0.5)).toBe(false);
  });

  it('defaults to Math.random when no rng provided', () => {
    const spy = vi.spyOn(Math, 'random').mockReturnValue(0.05);
    try {
      expect(shouldReviewRun(warm)).toBe(true);
      expect(spy).toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });
});
