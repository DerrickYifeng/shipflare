import { describe, it, expect } from 'vitest';
import {
  strategicPathSchema,
  type StrategicPath,
} from '@/agents/schemas';

// ---------------------------------------------------------------------------
// Fixture helper — builds a schema-valid StrategicPath with the given
// channel mix + phase goals so each test varies only the axis it's
// measuring.
// ---------------------------------------------------------------------------

function makeValidPath(
  overrides: Partial<StrategicPath> = {},
): StrategicPath {
  const base: StrategicPath = {
    narrative:
      'Week one focuses on the problem the product solves — the solo founder trying to ' +
      'keep marketing honest without giving up build time. The next six weeks argue one ' +
      'thesis: marketing is an approval queue, not a second job. The biggest risk is ' +
      'overposting; the cadence is deliberately lean.',
    milestones: [
      {
        atDayOffset: -28,
        title: 'Hit 100 waitlist signups',
        successMetric: 'waitlist count >= 100',
        phase: 'foundation',
      },
      {
        atDayOffset: -14,
        title: 'Ship reply-guy engine',
        successMetric: 'reply window is 15min for 10 target accounts',
        phase: 'audience',
      },
      {
        atDayOffset: -7,
        title: 'Confirm 5 hunters',
        successMetric: 'five hunters committed in writing',
        phase: 'momentum',
      },
    ],
    thesisArc: [
      {
        weekStart: '2026-04-20T00:00:00Z',
        theme: 'Marketing is an approval queue, not a second job',
        angleMix: ['claim', 'story', 'contrarian'],
      },
      {
        weekStart: '2026-04-27T00:00:00Z',
        theme: 'What the calendar pass actually costs you in a week',
        angleMix: ['data', 'howto'],
      },
    ],
    contentPillars: ['build-in-public', 'solo-dev-ops', 'tooling-counterfactuals'],
    channelMix: {
      x: {
        perWeek: 4,
        preferredHours: [14, 17, 21],
      },
    },
    phaseGoals: {
      foundation: 'Nail positioning + 100 waitlist',
      audience: 'Hit 500 followers + 50 beta users',
      momentum: '10 hunter commits, launch runsheet locked',
      launch: 'Top 5 of the day + 300 first-hour signups',
    },
  };
  return { ...base, ...overrides };
}

describe('strategicPathSchema', () => {
  it('accepts a fully populated path (mvp state)', () => {
    expect(() => strategicPathSchema.parse(makeValidPath())).not.toThrow();
  });

  it('accepts a launching-state path with reddit + email channels', () => {
    const path = makeValidPath({
      channelMix: {
        x: { perWeek: 5, preferredHours: [14, 17, 21] },
        reddit: {
          perWeek: 1,
          preferredHours: [15],
          preferredCommunities: ['r/SideProject', 'r/indiehackers'],
        },
        email: { perWeek: 1, preferredHours: [13] },
      },
      phaseGoals: {
        momentum: '10 hunter commits + runsheet locked',
        launch: 'Top 5 of the day + 300 first-hour signups',
      },
    });
    expect(() => strategicPathSchema.parse(path)).not.toThrow();
  });

  it('accepts a launched-state compound-phase path with 4-week arc', () => {
    const path = makeValidPath({
      narrative:
        'We are 8 days post-launch. The next four weeks convert the launch audience into ' +
        'retention by leaning on specific customer outcomes instead of product features. ' +
        'We stay public through Week 2 to ride the compound phase, then pivot to a steady ' +
        'cadence in Week 3. Primary risk: silence post-launch killing the new audience.',
      thesisArc: [
        {
          weekStart: '2026-04-20T00:00:00Z',
          theme: 'What the first 48 hours told us',
          angleMix: ['data', 'case', 'synthesis'],
        },
        {
          weekStart: '2026-04-27T00:00:00Z',
          theme: 'The user pattern we did not expect',
          angleMix: ['case', 'story'],
        },
        {
          weekStart: '2026-05-04T00:00:00Z',
          theme: 'What we are cutting in v1.1',
          angleMix: ['contrarian', 'claim'],
        },
        {
          weekStart: '2026-05-11T00:00:00Z',
          theme: 'The compound audience check-in',
          angleMix: ['synthesis', 'howto'],
        },
      ],
      milestones: [
        {
          atDayOffset: 3,
          title: 'Day-3 retro published',
          successMetric: 'retro post shipped',
          phase: 'compound',
        },
        {
          atDayOffset: 14,
          title: 'Week-2 retention check',
          successMetric: 'W2 active users >= 40% of W1',
          phase: 'compound',
        },
        {
          atDayOffset: 30,
          title: 'Compound → steady handoff',
          successMetric: 'strategic-planner regenerated with steady-phase arc',
          phase: 'compound',
        },
      ],
      phaseGoals: {
        compound:
          'Convert launch audience into week-2 retention + case-study consent',
      },
    });
    expect(() => strategicPathSchema.parse(path)).not.toThrow();
  });

  it('rejects a path with fewer than 3 content pillars', () => {
    const invalid = makeValidPath({
      contentPillars: ['build-in-public', 'solo-dev-ops'],
    });
    expect(() => strategicPathSchema.parse(invalid)).toThrow();
  });

  it('rejects a path with more than 4 content pillars', () => {
    const invalid = makeValidPath({
      contentPillars: ['a', 'b', 'c', 'd', 'e'],
    });
    expect(() => strategicPathSchema.parse(invalid)).toThrow();
  });

  it('rejects a path with fewer than 3 milestones', () => {
    const invalid = makeValidPath({
      milestones: [
        {
          atDayOffset: -28,
          title: 'only one',
          successMetric: 'solo',
          phase: 'foundation',
        },
      ],
    });
    expect(() => strategicPathSchema.parse(invalid)).toThrow();
  });

  it('rejects a path with no channels in channelMix', () => {
    const invalid = makeValidPath({ channelMix: {} });
    expect(() => strategicPathSchema.parse(invalid)).toThrow();
  });

  it('rejects a narrative below 200 chars', () => {
    const invalid = makeValidPath({ narrative: 'too short' });
    expect(() => strategicPathSchema.parse(invalid)).toThrow();
  });

  it('rejects a narrative above 2400 chars', () => {
    const invalid = makeValidPath({ narrative: 'a'.repeat(2500) });
    expect(() => strategicPathSchema.parse(invalid)).toThrow();
  });

  it('rejects an unknown phase on a milestone', () => {
    const invalid = makeValidPath({
      milestones: [
        {
          atDayOffset: 0,
          title: 'x',
          successMetric: 'x',
          // @ts-expect-error intentional invalid
          phase: 'mystery',
        },
        ...makeValidPath().milestones.slice(0, 2),
      ],
    });
    expect(() => strategicPathSchema.parse(invalid)).toThrow();
  });

  it('rejects an angleMix with an invalid angle', () => {
    const invalid = makeValidPath({
      thesisArc: [
        {
          weekStart: '2026-04-20T00:00:00Z',
          theme: 'x',
          // @ts-expect-error intentional invalid
          angleMix: ['shoutout'],
        },
      ],
    });
    expect(() => strategicPathSchema.parse(invalid)).toThrow();
  });
});
