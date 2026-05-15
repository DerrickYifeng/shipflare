import { describe, it, expect } from 'vitest';
import {
  channelScore,
  moduleScore,
  overallScore,
} from '../growth-score';

const TARGET = { threads: 30, drafts: 20, posts: 5, replies: 15 };

describe('channelScore', () => {
  it('returns 0 when all counts are 0', () => {
    expect(channelScore({ threads: 0, drafts: 0, posts: 0, replies: 0 }, TARGET)).toBe(0);
  });

  it('returns 100 when all targets are met exactly', () => {
    expect(channelScore({ threads: 30, drafts: 20, posts: 5, replies: 15 }, TARGET)).toBe(100);
  });

  it('caps each component at 1.0 before averaging', () => {
    // Threads 10x over target, others at 0 — capped at 1.0 → 25%
    expect(channelScore({ threads: 300, drafts: 0, posts: 0, replies: 0 }, TARGET)).toBe(25);
  });

  it('partial credit averages cleanly', () => {
    // threads 15/30 = 0.5, drafts 10/20 = 0.5, posts 0, replies 0 → 0.25 → 25
    expect(channelScore({ threads: 15, drafts: 10, posts: 0, replies: 0 }, TARGET)).toBe(25);
  });
});

describe('moduleScore', () => {
  it('returns 0 for an empty channel-score array', () => {
    expect(moduleScore([])).toBe(0);
  });

  it('averages enabled channel scores', () => {
    expect(moduleScore([80, 60])).toBe(70);
  });

  it('rounds the average', () => {
    expect(moduleScore([50, 51, 52])).toBe(51);
  });
});

describe('overallScore', () => {
  it('returns the only live module score when one module is live', () => {
    expect(overallScore([{ score: 74, weight: 1.0 }])).toBe(74);
  });

  it('weighted-averages multiple live modules', () => {
    expect(overallScore([
      { score: 80, weight: 0.5 },
      { score: 60, weight: 0.5 },
    ])).toBe(70);
  });

  it('returns 0 for an empty module list', () => {
    expect(overallScore([])).toBe(0);
  });
});
