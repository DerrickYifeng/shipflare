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

  it('marks Briefing active when pathname is /briefing', () => {
    pathname = '/briefing';
    render(<TabNav />);
    const briefingLink = screen.getByRole('link', { name: 'Briefing' });
    expect(briefingLink.getAttribute('aria-current')).toBe('page');
    const planLink = screen.getByRole('link', { name: 'Plan' });
    expect(planLink.getAttribute('aria-current')).toBeNull();
  });

  it('marks Plan active when pathname starts with /briefing/plan', () => {
    pathname = '/briefing/plan';
    render(<TabNav />);
    const planLink = screen.getByRole('link', { name: 'Plan' });
    expect(planLink.getAttribute('aria-current')).toBe('page');
  });

  it('marks History active when pathname starts with /briefing/history', () => {
    pathname = '/briefing/history';
    render(<TabNav />);
    const historyLink = screen.getByRole('link', { name: 'History' });
    expect(historyLink.getAttribute('aria-current')).toBe('page');
    const briefingLink = screen.getByRole('link', { name: 'Briefing' });
    expect(briefingLink.getAttribute('aria-current')).toBeNull();
  });

  it('Briefing → /briefing, History → /briefing/history, Plan → /briefing/plan', () => {
    pathname = '/briefing';
    render(<TabNav />);
    expect(
      screen.getByRole('link', { name: 'Briefing' }).getAttribute('href'),
    ).toBe('/briefing');
    expect(
      screen.getByRole('link', { name: 'History' }).getAttribute('href'),
    ).toBe('/briefing/history');
    expect(
      screen.getByRole('link', { name: 'Plan' }).getAttribute('href'),
    ).toBe('/briefing/plan');
  });
});
