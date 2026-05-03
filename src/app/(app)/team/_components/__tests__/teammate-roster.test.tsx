// @vitest-environment happy-dom
//
// UI-B Task 8 — TeammateRoster behavior tests.
//
// `useTeamEvents` is mocked so the component receives synthesized SSE
// payloads on demand. We capture the `onMessage` callback the roster
// passes in, then drive it directly to assert the apply-status-change
// reducer wires through to the rendered DOM.

import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { act, render, screen, cleanup, fireEvent } from '@testing-library/react';
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

  it('renders a stop button only when row is stoppable AND onStop is supplied', () => {
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

  it('does NOT render a stop button when onStop is not supplied', () => {
    render(
      <TeammateRoster
        teamId="team-1"
        initialLead={lead}
        initialTeammates={[teammateAuthor]}
      />,
    );
    expect(screen.queryByTestId('teammate-roster-stop')).toBeNull();
  });
});
