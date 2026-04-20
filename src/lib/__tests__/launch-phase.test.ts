import { describe, expect, test } from 'vitest';
import { derivePhase, type LaunchPhase, type ProductState } from '../launch-phase';

const NOW = new Date('2026-04-19T00:00:00Z');

function daysFromNow(days: number): Date {
  return new Date(NOW.getTime() + days * 86_400_000);
}

interface Row {
  label: string;
  state: ProductState;
  launchDate: Date | null;
  launchedAt: Date | null;
  expected: LaunchPhase;
}

const rows: Row[] = [
  // state='mvp' — no launchDate: always foundation
  {
    label: 'mvp / no launchDate -> foundation',
    state: 'mvp',
    launchDate: null,
    launchedAt: null,
    expected: 'foundation',
  },
  // state='mvp' — launchDate boundaries
  {
    label: 'mvp / launchDate T+29 -> foundation (>28 days out)',
    state: 'mvp',
    launchDate: daysFromNow(29),
    launchedAt: null,
    expected: 'foundation',
  },
  {
    label: 'mvp / launchDate T+28 -> audience (boundary)',
    state: 'mvp',
    launchDate: daysFromNow(28),
    launchedAt: null,
    expected: 'audience',
  },
  {
    label: 'mvp / launchDate T+8 -> audience',
    state: 'mvp',
    launchDate: daysFromNow(8),
    launchedAt: null,
    expected: 'audience',
  },
  {
    label: 'mvp / launchDate T+7 -> momentum (boundary)',
    state: 'mvp',
    launchDate: daysFromNow(7),
    launchedAt: null,
    expected: 'momentum',
  },
  {
    label: 'mvp / launchDate T+1 -> momentum',
    state: 'mvp',
    launchDate: daysFromNow(1),
    launchedAt: null,
    expected: 'momentum',
  },
  {
    label: 'mvp / launchDate T-0 -> launch (boundary)',
    state: 'mvp',
    launchDate: daysFromNow(0),
    launchedAt: null,
    expected: 'launch',
  },
  {
    label: 'mvp / launchDate T-1 (past) -> launch',
    state: 'mvp',
    launchDate: daysFromNow(-1),
    launchedAt: null,
    expected: 'launch',
  },

  // state='launching' — same rules as mvp once launchDate is set
  {
    label: 'launching / launchDate T+28 -> audience',
    state: 'launching',
    launchDate: daysFromNow(28),
    launchedAt: null,
    expected: 'audience',
  },
  {
    label: 'launching / launchDate T+7 -> momentum',
    state: 'launching',
    launchDate: daysFromNow(7),
    launchedAt: null,
    expected: 'momentum',
  },
  {
    label: 'launching / launchDate T-0 -> launch',
    state: 'launching',
    launchDate: daysFromNow(0),
    launchedAt: null,
    expected: 'launch',
  },
  {
    label: 'launching / launchDate T+100 -> foundation',
    state: 'launching',
    launchDate: daysFromNow(100),
    launchedAt: null,
    expected: 'foundation',
  },

  // state='launched' — compound for 30 days, then steady
  {
    label: 'launched / launchedAt T-0 -> compound (boundary)',
    state: 'launched',
    launchDate: null,
    launchedAt: daysFromNow(0),
    expected: 'compound',
  },
  {
    label: 'launched / launchedAt T-30 -> compound (boundary)',
    state: 'launched',
    launchDate: null,
    launchedAt: daysFromNow(-30),
    expected: 'compound',
  },
  {
    label: 'launched / launchedAt T-31 -> steady',
    state: 'launched',
    launchDate: null,
    launchedAt: daysFromNow(-31),
    expected: 'steady',
  },
  {
    label: 'launched / launchedAt T+30 (future, weird) -> compound',
    state: 'launched',
    launchDate: null,
    launchedAt: daysFromNow(30),
    expected: 'compound',
  },
  {
    label: 'launched / no launchedAt -> steady (safety fallback)',
    state: 'launched',
    launchDate: null,
    launchedAt: null,
    expected: 'steady',
  },
];

describe('derivePhase', () => {
  test.each(rows)('$label', ({ state, launchDate, launchedAt, expected }) => {
    const result = derivePhase({ state, launchDate, launchedAt, now: NOW });
    expect(result).toBe(expected);
  });

  test('uses current wall clock when now is omitted', () => {
    const phase = derivePhase({
      state: 'launched',
      launchDate: null,
      launchedAt: new Date(),
    });
    expect(phase).toBe('compound');
  });
});
