// @vitest-environment happy-dom
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup, screen } from '@testing-library/react';

let pathname = '/briefing';
vi.mock('next/navigation', () => ({
  usePathname: () => pathname,
}));

import { TabNav } from '../tab-nav';

describe('<TabNav>', () => {
  afterEach(cleanup);

  it('marks Today active when pathname is /briefing', () => {
    pathname = '/briefing';
    render(<TabNav />);
    const todayLink = screen.getByRole('link', { name: 'Today' });
    expect(todayLink.getAttribute('aria-current')).toBe('page');
    const planLink = screen.getByRole('link', { name: 'Plan' });
    expect(planLink.getAttribute('aria-current')).toBeNull();
  });

  it('marks Plan active when pathname starts with /briefing/plan', () => {
    pathname = '/briefing/plan';
    render(<TabNav />);
    const planLink = screen.getByRole('link', { name: 'Plan' });
    expect(planLink.getAttribute('aria-current')).toBe('page');
  });

  it('Today link points to /briefing, Plan link points to /briefing/plan', () => {
    pathname = '/briefing';
    render(<TabNav />);
    expect(
      screen.getByRole('link', { name: 'Today' }).getAttribute('href'),
    ).toBe('/briefing');
    expect(
      screen.getByRole('link', { name: 'Plan' }).getAttribute('href'),
    ).toBe('/briefing/plan');
  });
});
