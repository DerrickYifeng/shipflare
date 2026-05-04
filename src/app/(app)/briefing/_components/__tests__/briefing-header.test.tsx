// @vitest-environment happy-dom
import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup, screen } from '@testing-library/react';
import { BriefingHeader } from '../briefing-header';
import type { BriefingSummary } from '@/app/api/briefing/summary/route';

const STEADY: BriefingSummary = {
  today: { awaiting: 1, shipped: 1, skipped: 0 },
  yesterday: { shipped: 2, skipped: 1 },
  thisWeek: { totalQueued: 6, totalShipped: 1 },
  isDay1: false,
  nextDiscoveryAt: null,
};

describe('<BriefingHeader>', () => {
  afterEach(cleanup);

  it('renders three steady-state lines', () => {
    render(<BriefingHeader summary={STEADY} />);
    expect(screen.getByText(/1 awaiting/)).toBeTruthy();
    expect(screen.getByText(/1 shipped/)).toBeTruthy();
    expect(screen.getByText(/6 more queued/)).toBeTruthy();
    expect(screen.getByText(/Yesterday/)).toBeTruthy();
  });

  it('renders day-1 hero copy when isDay1 is true', () => {
    render(<BriefingHeader summary={{ ...STEADY, isDay1: true }} />);
    expect(screen.getByText(/Day 1/)).toBeTruthy();
    expect(screen.getByText(/plan locked/)).toBeTruthy();
  });

  it('renders all-clear copy when caught up + at least one shipped today', () => {
    const caughtUp: BriefingSummary = {
      today: { awaiting: 0, shipped: 1, skipped: 0 },
      yesterday: { shipped: 0, skipped: 0 },
      thisWeek: { totalQueued: 0, totalShipped: 1 },
      isDay1: false,
      nextDiscoveryAt: null,
    };
    render(<BriefingHeader summary={caughtUp} />);
    expect(screen.getByText(/All clear/)).toBeTruthy();
  });

  it('collapses to a single neutral line when summary is null', () => {
    render(<BriefingHeader summary={null} />);
    expect(screen.getByText('Today')).toBeTruthy();
    expect(screen.queryByText(/awaiting/)).toBeNull();
  });
});
