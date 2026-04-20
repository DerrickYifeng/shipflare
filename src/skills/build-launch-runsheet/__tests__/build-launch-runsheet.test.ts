import { describe, it, expect } from 'vitest';
import {
  launchRunsheetOutputSchema,
  launchRunsheetBeatSchema,
} from '@/agents/schemas';

describe('launchRunsheetBeatSchema', () => {
  it('accepts a valid beat', () => {
    const valid = {
      hourOffset: 0,
      channel: 'producthunt',
      action: 'Submit the launch',
      description: 'This is the T-0 moment; submission must happen here.',
      skillName: null,
      priority: 'critical',
    };
    expect(() => launchRunsheetBeatSchema.parse(valid)).not.toThrow();
  });

  it('accepts a beat with a skill reference', () => {
    const valid = {
      hourOffset: 2,
      channel: 'x',
      action: 'Reply to first 10 supporters',
      description: 'Personalized reply per supporter.',
      skillName: 'draft-single-reply',
      priority: 'high',
    };
    expect(() => launchRunsheetBeatSchema.parse(valid)).not.toThrow();
  });

  it('rejects an out-of-range hourOffset', () => {
    const invalid = {
      hourOffset: 100,
      channel: 'x',
      action: 'x',
      description: 'd',
      skillName: null,
      priority: 'normal',
    };
    expect(() => launchRunsheetBeatSchema.parse(invalid)).toThrow();
  });

  it('rejects an unknown channel', () => {
    const invalid = {
      hourOffset: 0,
      channel: 'instagram',
      action: 'x',
      description: 'd',
      skillName: null,
      priority: 'normal',
    };
    expect(() => launchRunsheetBeatSchema.parse(invalid)).toThrow();
  });
});

describe('launchRunsheetOutputSchema', () => {
  it('accepts a runsheet with ≥ 6 beats', () => {
    const beats = Array.from({ length: 6 }, (_, i) => ({
      hourOffset: i,
      channel: 'x' as const,
      action: `Beat ${i}`,
      description: 'd',
      skillName: null,
      priority: 'normal' as const,
    }));
    const valid = { launchDate: '2026-05-14T00:00:00Z', beats };
    expect(() => launchRunsheetOutputSchema.parse(valid)).not.toThrow();
  });

  it('rejects a runsheet with too few beats', () => {
    const beats = Array.from({ length: 3 }, (_, i) => ({
      hourOffset: i,
      channel: 'x' as const,
      action: `Beat ${i}`,
      description: 'd',
      skillName: null,
      priority: 'normal' as const,
    }));
    const invalid = { launchDate: '2026-05-14T00:00:00Z', beats };
    expect(() => launchRunsheetOutputSchema.parse(invalid)).toThrow();
  });
});
