// @vitest-environment happy-dom
//
// UI-B Task 8 + Task 11 — TeammateRoster behavior tests.
//
// `useTeamEvents` is mocked so the component receives synthesized SSE
// payloads on demand. We capture the `onMessage` callback the roster
// passes in, then drive it directly to assert the apply-status-change
// reducer wires through to the rendered DOM.
//
// Task 11 adds tests for the per-teammate cancel flow: the default
// (no `onStop` prop) calls `fetch('/api/team/agent/[id]/cancel')`;
// supplying `onStop` overrides the fetch path so existing tests still
// drive the click handler directly.

import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import {
  act,
  render,
  screen,
  cleanup,
  fireEvent,
  waitFor,
} from '@testing-library/react';
import type { TeamActivityMessage } from '@/hooks/use-team-events';

// Hoisted mock so we can capture and re-use the onMessage callback across
// tests without leaking between renders.
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

import {
  TeammateRoster,
  type RosterLead,
  type RosterTeammate,
} from '../teammate-roster';

function statusChangeMessage(
  partial: Partial<{
    agentId: string;
    status: string;
    lastActiveAt: string;
    displayName: string | null;
  }>,
): TeamActivityMessage {
  return {
    id: `m-${Math.random().toString(36).slice(2, 8)}`,
    runId: null,
    conversationId: null,
    teamId: 'team-1',
    from: null,
    to: null,
    type: 'agent_status_change',
    content: null,
    metadata: null,
    createdAt: '2026-05-02T01:00:00.000Z',
    // Flat fields the publisher includes — passed through the SSE wire
    // wrapper as top-level keys (see `agent-run.ts publishStatusChange`).
    ...({
      agentId: partial.agentId ?? 'agent-1',
      status: partial.status ?? 'running',
      lastActiveAt: partial.lastActiveAt ?? '2026-05-02T01:00:00.000Z',
      displayName: partial.displayName ?? null,
    } as unknown as Record<string, unknown>),
  } as TeamActivityMessage;
}

const lead: RosterLead = {
  agentId: 'lead-1',
  memberId: 'member-lead',
  agentDefName: 'coordinator',
  displayName: 'Team Lead',
  status: 'sleeping',
  lastActiveAt: '2026-05-02T00:00:00.000Z',
};

const teammateAuthor: RosterTeammate = {
  agentId: 'agent-author',
  memberId: 'member-author',
  agentDefName: 'content-manager',
  parentAgentId: 'lead-1',
  status: 'running',
  lastActiveAt: '2026-05-02T00:30:00.000Z',
  sleepUntil: null,
  displayName: 'Author',
};

const teammateResearcher: RosterTeammate = {
  agentId: 'agent-researcher',
  memberId: 'member-researcher',
  agentDefName: 'researcher',
  parentAgentId: 'lead-1',
  status: 'sleeping',
  lastActiveAt: '2026-05-02T00:31:00.000Z',
  sleepUntil: '2026-05-02T01:00:00.000Z',
  displayName: 'Researcher',
};

beforeEach(() => {
  captured.onMessage = null;
});

afterEach(() => {
  cleanup();
});

describe('<TeammateRoster>', () => {
  it('renders the lead row at the top with its status pill', () => {
    render(
      <TeammateRoster
        teamId="team-1"
        initialLead={lead}
        initialTeammates={[]}
      />,
    );
    const leadRow = screen.getByTestId('teammate-roster-lead');
    expect(leadRow).toBeTruthy();
    expect(leadRow.textContent).toContain('Team Lead');
    expect(leadRow.getAttribute('data-status')).toBe('sleeping');
    expect(leadRow.querySelector('[data-testid="agent-status-pill"]')).not.toBeNull();
  });

  it('renders the empty-state hint when there are no teammates', () => {
    render(
      <TeammateRoster
        teamId="team-1"
        initialLead={lead}
        initialTeammates={[]}
      />,
    );
    expect(screen.getByTestId('teammate-roster-empty')).toBeTruthy();
  });

  it('renders teammate rows in spawn order (oldest first)', () => {
    render(
      <TeammateRoster
        teamId="team-1"
        initialLead={lead}
        initialTeammates={[teammateResearcher, teammateAuthor]}
      />,
    );
    const rows = screen.getAllByTestId('teammate-roster-row');
    expect(rows).toHaveLength(2);
    // Author lastActiveAt 00:30 < Researcher 00:31 — Author renders first.
    expect(rows[0].getAttribute('data-agent-id')).toBe('agent-author');
    expect(rows[1].getAttribute('data-agent-id')).toBe('agent-researcher');
  });

  it('updates a teammate row when an agent_status_change SSE event arrives', () => {
    render(
      <TeammateRoster
        teamId="team-1"
        initialLead={lead}
        initialTeammates={[teammateAuthor]}
      />,
    );
    expect(captured.onMessage).not.toBeNull();
    act(() => {
      captured.onMessage!(
        statusChangeMessage({
          agentId: 'agent-author',
          status: 'sleeping',
          lastActiveAt: '2026-05-02T01:01:00.000Z',
        }),
      );
    });
    const row = screen
      .getAllByTestId('teammate-roster-row')
      .find((el) => el.getAttribute('data-agent-id') === 'agent-author');
    expect(row).toBeTruthy();
    expect(row!.getAttribute('data-status')).toBe('sleeping');
  });

  it('removes a teammate when a terminal SSE event arrives', () => {
    render(
      <TeammateRoster
        teamId="team-1"
        initialLead={lead}
        initialTeammates={[teammateAuthor, teammateResearcher]}
      />,
    );
    act(() => {
      captured.onMessage!(
        statusChangeMessage({
          agentId: 'agent-author',
          status: 'completed',
          lastActiveAt: '2026-05-02T01:02:00.000Z',
        }),
      );
    });
    const rows = screen.getAllByTestId('teammate-roster-row');
    expect(rows).toHaveLength(1);
    expect(rows[0].getAttribute('data-agent-id')).toBe('agent-researcher');
  });

  it('updates the lead row in place on terminal status (lead is never removed)', () => {
    render(
      <TeammateRoster
        teamId="team-1"
        initialLead={lead}
        initialTeammates={[]}
      />,
    );
    act(() => {
      captured.onMessage!(
        statusChangeMessage({
          agentId: 'lead-1',
          status: 'running',
          lastActiveAt: '2026-05-02T01:00:00.000Z',
        }),
      );
    });
    let leadRow = screen.getByTestId('teammate-roster-lead');
    expect(leadRow.getAttribute('data-status')).toBe('running');

    // Terminal-ish payload on the lead must NOT remove the row.
    act(() => {
      captured.onMessage!(
        statusChangeMessage({
          agentId: 'lead-1',
          status: 'failed',
          lastActiveAt: '2026-05-02T01:05:00.000Z',
        }),
      );
    });
    leadRow = screen.getByTestId('teammate-roster-lead');
    expect(leadRow.getAttribute('data-status')).toBe('failed');
  });

  it('appends a stub row for a previously-unknown teammate carrying displayName', () => {
    render(
      <TeammateRoster
        teamId="team-1"
        initialLead={lead}
        initialTeammates={[]}
      />,
    );
    act(() => {
      captured.onMessage!(
        statusChangeMessage({
          agentId: 'agent-new',
          status: 'queued',
          lastActiveAt: '2026-05-02T01:10:00.000Z',
          displayName: 'Strategist',
        }),
      );
    });
    const rows = screen.getAllByTestId('teammate-roster-row');
    expect(rows).toHaveLength(1);
    expect(rows[0].getAttribute('data-agent-id')).toBe('agent-new');
    expect(rows[0].textContent).toContain('Strategist');
  });

  it('ignores non-status-change messages', () => {
    render(
      <TeammateRoster
        teamId="team-1"
        initialLead={lead}
        initialTeammates={[teammateAuthor]}
      />,
    );
    act(() => {
      captured.onMessage!({
        id: 'unrelated',
        runId: null,
        conversationId: null,
        teamId: 'team-1',
        from: null,
        to: null,
        type: 'agent_text',
        content: 'hello',
        metadata: null,
        createdAt: '2026-05-02T01:00:00.000Z',
      });
    });
    const row = screen
      .getAllByTestId('teammate-roster-row')
      .find((el) => el.getAttribute('data-agent-id') === 'agent-author');
    // Untouched.
    expect(row!.getAttribute('data-status')).toBe('running');
  });

  it('invokes the supplied onStop override when the stop button is clicked', () => {
    const onStop = vi.fn();
    render(
      <TeammateRoster
        teamId="team-1"
        initialLead={lead}
        initialTeammates={[teammateAuthor]}
        onStop={onStop}
      />,
    );
    const stopBtn = screen.getByTestId('teammate-roster-stop');
    expect(stopBtn).toBeTruthy();
    fireEvent.click(stopBtn);
    expect(onStop).toHaveBeenCalledWith('agent-author');
  });

  it('renders a stop button by default (Task 11) — onStop is no longer required', () => {
    // The default cancel handler POSTs the cancel endpoint; the button
    // surface should still be present without an explicit onStop prop.
    render(
      <TeammateRoster
        teamId="team-1"
        initialLead={lead}
        initialTeammates={[teammateAuthor]}
      />,
    );
    expect(screen.getByTestId('teammate-roster-stop')).toBeTruthy();
  });

  it('does NOT render a stop button on the lead row even when stoppable', () => {
    // Lead row is excluded from the stop affordance (see RosterRow).
    render(
      <TeammateRoster
        teamId="team-1"
        initialLead={{ ...lead, status: 'running' }}
        initialTeammates={[]}
      />,
    );
    expect(screen.queryByTestId('teammate-roster-stop')).toBeNull();
  });

  describe('Task 11 — per-teammate cancel via fetch', () => {
    let originalFetch: typeof fetch;

    beforeEach(() => {
      originalFetch = global.fetch;
    });

    afterEach(() => {
      global.fetch = originalFetch;
    });

    it('POSTs /api/team/agent/[agentId]/cancel when default handler runs', async () => {
      const fetchMock = vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ cancelled: true, agentId: 'agent-author' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );
      global.fetch = fetchMock as unknown as typeof fetch;

      render(
        <TeammateRoster
          teamId="team-1"
          initialLead={lead}
          initialTeammates={[teammateAuthor]}
        />,
      );

      fireEvent.click(screen.getByTestId('teammate-roster-stop'));

      await waitFor(() => {
        expect(fetchMock).toHaveBeenCalledOnce();
      });
      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe('/api/team/agent/agent-author/cancel');
      expect((init as RequestInit).method).toBe('POST');
    });

    it('marks the row as cancelling optimistically after click (data-cancelling=true)', async () => {
      // Resolve the fetch on a deferred promise so the optimistic flag
      // is observable in the rendered DOM before the network resolves.
      let resolveFetch!: (v: Response) => void;
      const pending = new Promise<Response>((resolve) => {
        resolveFetch = resolve;
      });
      const fetchMock = vi.fn().mockReturnValue(pending);
      global.fetch = fetchMock as unknown as typeof fetch;

      render(
        <TeammateRoster
          teamId="team-1"
          initialLead={lead}
          initialTeammates={[teammateAuthor]}
        />,
      );

      fireEvent.click(screen.getByTestId('teammate-roster-stop'));

      await waitFor(() => {
        const row = screen.getAllByTestId('teammate-roster-row')[0];
        expect(row.getAttribute('data-cancelling')).toBe('true');
      });

      // Pill label should swap to "cancelling…".
      expect(screen.getByTestId('teammate-roster').textContent).toContain('cancelling');

      // Resolve to clean up.
      resolveFetch(
        new Response(JSON.stringify({ cancelled: true, agentId: 'agent-author' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );
    });

    it('rolls back the optimistic cancelling marker on fetch failure', async () => {
      const fetchMock = vi.fn().mockResolvedValue(
        new Response('boom', { status: 500 }),
      );
      global.fetch = fetchMock as unknown as typeof fetch;
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      render(
        <TeammateRoster
          teamId="team-1"
          initialLead={lead}
          initialTeammates={[teammateAuthor]}
        />,
      );

      fireEvent.click(screen.getByTestId('teammate-roster-stop'));

      // Wait for the fetch to settle, then assert the marker was cleared.
      await waitFor(() => {
        expect(fetchMock).toHaveBeenCalledOnce();
      });
      await waitFor(() => {
        const row = screen.getAllByTestId('teammate-roster-row')[0];
        expect(row.getAttribute('data-cancelling')).toBeNull();
      });
      expect(errSpy).toHaveBeenCalled();
      errSpy.mockRestore();
    });

    it('clears the cancelling marker once the SSE removal arrives', async () => {
      const fetchMock = vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ cancelled: true, agentId: 'agent-author' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );
      global.fetch = fetchMock as unknown as typeof fetch;

      render(
        <TeammateRoster
          teamId="team-1"
          initialLead={lead}
          initialTeammates={[teammateAuthor]}
        />,
      );

      fireEvent.click(screen.getByTestId('teammate-roster-stop'));
      await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());

      // Now simulate the SSE-driven terminal status. The reducer
      // removes the row entirely; the cleanup effect should drop the
      // optimistic marker as well.
      act(() => {
        captured.onMessage!(
          statusChangeMessage({
            agentId: 'agent-author',
            status: 'killed',
            lastActiveAt: '2026-05-02T01:05:00.000Z',
          }),
        );
      });

      // Row should be gone — the empty-state hint takes its place.
      expect(screen.queryAllByTestId('teammate-roster-row')).toHaveLength(0);
      expect(screen.getByTestId('teammate-roster-empty')).toBeTruthy();
    });
  });
});
