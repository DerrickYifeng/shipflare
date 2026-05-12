// @vitest-environment happy-dom
import { afterEach, describe, it, expect, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

import {
  ActiveSubagentsRail,
  type RailSubagent,
} from '../active-subagents-rail';

// A2: bottom rail mirrors the engine TaskListV2 pattern — in-flight subagents
// live OUTSIDE the message stream so they can't be scrolled out of view, and
// recently-completed teammates linger for a brief TTL so the user can still
// see them resolve.

describe('<ActiveSubagentsRail>', () => {
  afterEach(() => {
    cleanup();
  });

  it('shows running and sleeping subagents, hides completed beyond TTL', () => {
    const now = Date.now();
    render(
      <ActiveSubagentsRail
        now={now}
        subagents={[
          { id: 'a', name: 'x-replies', status: 'running', lastActiveAt: now },
          {
            id: 'b',
            name: 'reddit-research',
            status: 'sleeping',
            lastActiveAt: now - 1000,
          },
          {
            id: 'c',
            name: 'post-batch',
            status: 'completed',
            lastActiveAt: now - 31_000,
          },
          {
            id: 'd',
            name: 'x-discovery',
            status: 'completed',
            lastActiveAt: now - 5_000,
          },
        ]}
      />,
    );
    expect(screen.getByText('x-replies')).toBeTruthy();
    expect(screen.getByText('reddit-research')).toBeTruthy();
    expect(screen.getByText('x-discovery')).toBeTruthy(); // within 30s TTL
    expect(screen.queryByText('post-batch')).toBeNull(); // > 30s after completion
  });

  it('renders nothing when there is no visible content', () => {
    const { container } = render(
      <ActiveSubagentsRail
        now={Date.now()}
        subagents={[
          {
            id: 'c',
            name: 'old-task',
            status: 'completed',
            lastActiveAt: Date.now() - 60_000,
          },
        ]}
      />,
    );
    expect(container.firstChild).toBeNull();
  });

  it('orders entries by status priority (running → queued → sleeping → recent completed)', () => {
    const now = Date.now();
    render(
      <ActiveSubagentsRail
        now={now}
        subagents={[
          { id: '1', name: 'sleep-one', status: 'sleeping', lastActiveAt: now },
          { id: '2', name: 'done-one', status: 'completed', lastActiveAt: now },
          { id: '3', name: 'run-one', status: 'running', lastActiveAt: now },
          { id: '4', name: 'queue-one', status: 'queued', lastActiveAt: now },
        ]}
      />,
    );
    const region = screen.getByRole('region', { name: /active teammates/i });
    const buttons = Array.from(region.querySelectorAll('button'));
    const labels = buttons.map((b) =>
      b.querySelector('[data-testid="rail-name"]')?.textContent ?? '',
    );
    expect(labels).toEqual([
      'run-one',
      'queue-one',
      'sleep-one',
      'done-one',
    ]);
  });

  it('invokes onSelect with the subagent id when a chip is clicked', () => {
    const onSelect = vi.fn();
    const now = Date.now();
    render(
      <ActiveSubagentsRail
        now={now}
        onSelect={onSelect}
        subagents={[
          { id: 'agent-42', name: 'x-replies', status: 'running', lastActiveAt: now },
        ]}
      />,
    );
    fireEvent.click(screen.getByText('x-replies'));
    expect(onSelect).toHaveBeenCalledExactlyOnceWith('agent-42');
  });
});

// Stability of the activeSubagentIds membership signature is the
// critical correctness property for A1's React.memo on DelegationCard:
// a `lastActiveAt` tick on an unchanged active set MUST NOT churn the
// Set reference. The team-desk memo derives a sorted-id signature; we
// re-implement the same derivation here as a pure helper so the
// invariant is testable without coupling to React's renderer.
//
// If you change the team-desk memo logic, update `activeIdSignature`
// below in lockstep so this test stays load-bearing.
function activeIdSignature(subs: readonly RailSubagent[]): string {
  return subs
    .filter(
      (s) =>
        s.status === 'running' ||
        s.status === 'queued' ||
        s.status === 'sleeping',
    )
    .map((s) => s.id)
    .sort()
    .join(',');
}

describe('activeSubagentIds membership signature', () => {
  it('stays stable when only lastActiveAt ticks on an unchanged active set', () => {
    const t0 = 1_000_000;
    const first: RailSubagent[] = [
      { id: 'a', name: 'x', status: 'running', lastActiveAt: t0 },
      { id: 'b', name: 'y', status: 'sleeping', lastActiveAt: t0 - 1000 },
    ];
    // Same membership, same statuses — just newer activity timestamps
    // (simulates an `agent_status_change` SSE tick that re-derives the
    // agentRunStatus map without changing what's active).
    const second: RailSubagent[] = [
      { id: 'a', name: 'x', status: 'running', lastActiveAt: t0 + 500 },
      { id: 'b', name: 'y', status: 'sleeping', lastActiveAt: t0 - 200 },
    ];
    expect(activeIdSignature(first)).toBe(activeIdSignature(second));
  });

  it('flips when a teammate transitions to a terminal state', () => {
    const t0 = 1_000_000;
    const before: RailSubagent[] = [
      { id: 'a', name: 'x', status: 'running', lastActiveAt: t0 },
      { id: 'b', name: 'y', status: 'running', lastActiveAt: t0 },
    ];
    const after: RailSubagent[] = [
      { id: 'a', name: 'x', status: 'running', lastActiveAt: t0 },
      { id: 'b', name: 'y', status: 'completed', lastActiveAt: t0 + 1 },
    ];
    expect(activeIdSignature(before)).not.toBe(activeIdSignature(after));
  });

  it('is order-insensitive', () => {
    const t0 = 1_000_000;
    const a: RailSubagent[] = [
      { id: 'a', name: 'x', status: 'running', lastActiveAt: t0 },
      { id: 'b', name: 'y', status: 'queued', lastActiveAt: t0 },
    ];
    const b: RailSubagent[] = [
      { id: 'b', name: 'y', status: 'queued', lastActiveAt: t0 },
      { id: 'a', name: 'x', status: 'running', lastActiveAt: t0 },
    ];
    expect(activeIdSignature(a)).toBe(activeIdSignature(b));
  });
});
