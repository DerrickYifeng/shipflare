// @vitest-environment happy-dom
import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';

// happy-dom doesn't ship EventSource; stub a no-op one so `useTeamEvents`
// can instantiate it inside the component (we don't exercise the live path —
// `__disableLiveUpdates` renders from `initialMessages`).
beforeAll(() => {
  if (typeof globalThis.EventSource === 'undefined') {
    class NoopES {
      close(): void {}
      onmessage: unknown = null;
      onerror: unknown = null;
    }
    // @ts-expect-error — test-only browser global stub
    globalThis.EventSource = NoopES;
  }
});

import { ActivityLog, type ActivityLogMemberRef } from '../activity-log';
import type { TeamActivityMessage } from '@/hooks/use-team-events';

const members: ActivityLogMemberRef[] = [
  { id: 'coord', agentType: 'coordinator', displayName: 'Sam' },
  { id: 'growth', agentType: 'growth-strategist', displayName: 'Alex' },
];

function msg(
  overrides: Partial<TeamActivityMessage> & { id: string },
): TeamActivityMessage {
  return {
    id: overrides.id,
    runId: overrides.runId ?? 'run-1',
    teamId: 'team-1',
    from: overrides.from ?? 'coord',
    to: overrides.to ?? null,
    type: overrides.type ?? 'agent_text',
    content: overrides.content ?? 'hello',
    metadata: overrides.metadata ?? null,
    createdAt: overrides.createdAt ?? '2026-04-20T00:00:00Z',
  };
}

function setup(initial: TeamActivityMessage[]) {
  return render(
    <ActivityLog
      teamId="team-1"
      memberId="coord"
      members={members}
      initialMessages={initial}
      __disableLiveUpdates
    />,
  );
}

describe('<ActivityLog>', () => {
  afterEach(() => {
    cleanup();
  });

  it('renders each initial message with its type badge', () => {
    setup([
      msg({ id: 'm1', type: 'user_prompt', content: 'do the thing' }),
      msg({ id: 'm2', type: 'agent_text', content: 'on it' }),
      msg({ id: 'm3', type: 'error', content: 'oops' }),
    ]);
    expect(screen.getByText('do the thing')).toBeTruthy();
    expect(screen.getByText('on it')).toBeTruthy();
    expect(screen.getByText('oops')).toBeTruthy();
    // The badge labels live inside the list rows (role=log) — scope queries
    // to that subtree so we don't collide with same-text <option>s in the
    // filter dropdown.
    const list = screen.getByTestId('activity-log-list');
    expect(list.querySelector('[data-testid="activity-row-user_prompt"]')).not.toBeNull();
    expect(list.querySelector('[data-testid="activity-row-error"]')).not.toBeNull();
  });

  it('is a semantic log region (role="log", aria-live="polite")', () => {
    setup([msg({ id: 'm1' })]);
    const list = screen.getByTestId('activity-log-list');
    expect(list.getAttribute('role')).toBe('log');
    expect(list.getAttribute('aria-live')).toBe('polite');
  });

  it('renders empty state when no messages match the filter', () => {
    setup([
      msg({ id: 'm1', type: 'agent_text', content: 'visible' }),
    ]);
    // Use the type filter to hide the only message
    const typeSelect = screen.getByLabelText(
      'Filter by message type',
    ) as HTMLSelectElement;
    fireEvent.change(typeSelect, { target: { value: 'error' } });
    expect(
      screen.getByText('No activity for this member yet.'),
    ).toBeTruthy();
    expect(screen.queryByText('visible')).toBeNull();
  });

  it('indents messages with metadata.parentTaskId (threaded view)', () => {
    const { container } = setup([
      msg({
        id: 'parent',
        type: 'tool_call',
        content: 'Task(growth-strategist)',
      }),
      msg({
        id: 'child',
        type: 'tool_call',
        content: 'write_strategic_path',
        metadata: { parentTaskId: 'task-1', agentName: 'growth-strategist' },
        createdAt: '2026-04-20T00:00:01Z',
      }),
    ]);
    const rows = container.querySelectorAll('[data-depth]');
    const depths = Array.from(rows).map((r) =>
      r.getAttribute('data-depth'),
    );
    expect(depths).toEqual(['0', '1']);
  });

  it('hides thinking messages by default and reveals them on toggle', () => {
    setup([
      msg({ id: 'idea', type: 'thinking', content: 'let me think' }),
      msg({
        id: 'reply',
        type: 'agent_text',
        content: 'done thinking',
        createdAt: '2026-04-20T00:00:01Z',
      }),
    ]);
    expect(screen.queryByText('let me think')).toBeNull();
    fireEvent.click(screen.getByLabelText('show thinking'));
    // `thinking` messages render inside <details> — summary shows always, body
    // is in the DOM regardless of open/closed. So we just check the text
    // exists after toggling.
    expect(screen.getByText('let me think')).toBeTruthy();
  });
});
