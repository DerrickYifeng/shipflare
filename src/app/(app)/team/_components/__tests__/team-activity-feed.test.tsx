// @vitest-environment happy-dom
//
// UI-B Task 10 — TeamActivityFeed behavior tests.
//
// `useTeamEvents` is mocked the same way teammate-roster's tests mock
// it (capture the onMessage callback, then drive it directly). Verifies
// each event-type renderer + the defensive ignore-unknown contract.

import {
  describe,
  it,
  expect,
  vi,
  beforeEach,
  afterEach,
} from 'vitest';
import { act, render, screen, cleanup } from '@testing-library/react';
import type { TeamActivityMessage } from '@/hooks/use-team-events';

const captured = vi.hoisted(() => ({
  onMessage: null as ((msg: TeamActivityMessage) => void) | null,
}));

vi.mock('@/hooks/use-team-events', () => ({
  useTeamEvents: (opts: { onMessage?: (m: TeamActivityMessage) => void }) => {
    captured.onMessage = opts.onMessage ?? null;
    return {
      messages: [],
      partials: new Map(),
      toolInputPartials: new Map(),
      isConnected: true,
      reconnecting: false,
      connectSeq: 1,
    };
  },
}));

import { TeamActivityFeed } from '../team-activity-feed';

interface AnyExtras {
  [key: string]: unknown;
}

function makeMessage(
  type: string,
  extras: AnyExtras = {},
  id?: string,
): TeamActivityMessage {
  return {
    id: id ?? `m-${Math.random().toString(36).slice(2, 8)}`,
    runId: null,
    conversationId: null,
    teamId: 'team-1',
    from: null,
    to: null,
    type,
    content: null,
    metadata: null,
    createdAt: '2026-05-02T01:00:00.000Z',
    ...(extras as Record<string, unknown>),
  } as TeamActivityMessage;
}

beforeEach(() => {
  captured.onMessage = null;
});

afterEach(() => {
  cleanup();
});

describe('<TeamActivityFeed>', () => {
  it('renders the empty state when no events have arrived', () => {
    render(<TeamActivityFeed teamId="team-1" />);
    expect(screen.getByTestId('team-activity-feed-empty')).toBeTruthy();
  });

  it('renders an agent_status_change event', () => {
    render(<TeamActivityFeed teamId="team-1" />);
    expect(captured.onMessage).not.toBeNull();
    act(() => {
      captured.onMessage!(
        makeMessage(
          'agent_status_change',
          {
            agentId: 'agent-1',
            status: 'running',
            displayName: 'Researcher',
          },
          'evt-1',
        ),
      );
    });
    const items = screen.getAllByTestId('team-activity-feed-item');
    expect(items).toHaveLength(1);
    expect(items[0].getAttribute('data-kind')).toBe('status');
    expect(items[0].textContent).toContain('Researcher');
    expect(items[0].textContent).toContain('running');
  });

  it('renders a task_notification event', () => {
    render(<TeamActivityFeed teamId="team-1" />);
    act(() => {
      captured.onMessage!(
        makeMessage(
          'task_notification',
          {
            agentId: 'agent-1',
            status: 'completed',
            summary: 'drafted 3 variations',
            teammateName: 'Author',
          },
          'evt-2',
        ),
      );
    });
    const items = screen.getAllByTestId('team-activity-feed-item');
    expect(items).toHaveLength(1);
    expect(items[0].getAttribute('data-kind')).toBe('notification');
    expect(items[0].textContent).toContain('Author');
    expect(items[0].textContent).toContain('drafted 3 variations');
  });

  it('renders a peer_dm event', () => {
    render(<TeamActivityFeed teamId="team-1" />);
    act(() => {
      captured.onMessage!(
        makeMessage(
          'peer_dm',
          {
            from: 'researcher',
            to: 'author',
            summary: 'asking about citations',
          },
          'evt-3',
        ),
      );
    });
    const items = screen.getAllByTestId('team-activity-feed-item');
    expect(items).toHaveLength(1);
    expect(items[0].getAttribute('data-kind')).toBe('peer_dm');
    expect(items[0].textContent).toContain('researcher');
    expect(items[0].textContent).toContain('author');
    expect(items[0].textContent).toContain('asking about citations');
  });

  it('renders newest events first', () => {
    render(<TeamActivityFeed teamId="team-1" />);
    act(() => {
      captured.onMessage!(
        makeMessage(
          'task_notification',
          {
            status: 'completed',
            summary: 'first',
            teammateName: 'Alpha',
          },
          'evt-A',
        ),
      );
      captured.onMessage!(
        makeMessage(
          'task_notification',
          {
            status: 'completed',
            summary: 'second',
            teammateName: 'Beta',
          },
          'evt-B',
        ),
      );
    });
    const items = screen.getAllByTestId('team-activity-feed-item');
    expect(items).toHaveLength(2);
    // Newest first: Beta should render before Alpha.
    expect(items[0].textContent).toContain('Beta');
    expect(items[1].textContent).toContain('Alpha');
  });

  it('silently ignores unknown event types', () => {
    render(<TeamActivityFeed teamId="team-1" />);
    act(() => {
      captured.onMessage!(makeMessage('something_new', { foo: 'bar' }, 'x'));
      captured.onMessage!(makeMessage('agent_text', { content: 'hi' }, 'y'));
    });
    expect(screen.getByTestId('team-activity-feed-empty')).toBeTruthy();
    expect(screen.queryAllByTestId('team-activity-feed-item')).toHaveLength(0);
  });

  it('dedupes events by id', () => {
    render(<TeamActivityFeed teamId="team-1" />);
    act(() => {
      const evt = makeMessage(
        'task_notification',
        { status: 'completed', summary: 's', teammateName: 'A' },
        'dup-id',
      );
      captured.onMessage!(evt);
      captured.onMessage!(evt);
      captured.onMessage!(evt);
    });
    expect(screen.getAllByTestId('team-activity-feed-item')).toHaveLength(1);
  });

  it('caps the rendered list at maxEvents', () => {
    render(<TeamActivityFeed teamId="team-1" maxEvents={3} />);
    act(() => {
      for (let i = 0; i < 5; i++) {
        captured.onMessage!(
          makeMessage(
            'task_notification',
            { status: 'completed', summary: `s${i}`, teammateName: `T${i}` },
            `id-${i}`,
          ),
        );
      }
    });
    const items = screen.getAllByTestId('team-activity-feed-item');
    expect(items).toHaveLength(3);
    // Newest 3: T4, T3, T2 (T0/T1 evicted).
    expect(items[0].textContent).toContain('T4');
    expect(items[2].textContent).toContain('T2');
  });

  it('reads SSE fields from metadata as a fallback', () => {
    render(<TeamActivityFeed teamId="team-1" />);
    act(() => {
      // Construct a message where the flat fields are missing but the
      // payload hides them under `metadata` — exercises the defensive
      // metadata fallback path.
      captured.onMessage!({
        id: 'meta-1',
        runId: null,
        conversationId: null,
        teamId: 'team-1',
        from: null,
        to: null,
        type: 'agent_status_change',
        content: null,
        metadata: {
          status: 'sleeping',
          displayName: 'Author',
        },
        createdAt: '2026-05-02T01:00:00.000Z',
      } as TeamActivityMessage);
    });
    const items = screen.getAllByTestId('team-activity-feed-item');
    expect(items).toHaveLength(1);
    expect(items[0].textContent).toContain('Author');
    expect(items[0].textContent).toContain('sleeping');
  });
});
