/**
 * Unit tests for the pure `deriveTacticalFromMessages` reducer in
 * tactical-progress-card. The full component is rendered in
 * test-that-uses-useTeamEvents-style wiring elsewhere; this test focuses
 * on the state-derivation logic since that's the Phase-C bug path.
 */
import { describe, it, expect } from 'vitest';
import { deriveTacticalFromMessages } from '../tactical-progress-card';
import type { TeamActivityMessage } from '@/hooks/use-team-events';

function makeMessage(
  overrides: Partial<TeamActivityMessage> & { id: string; type: string },
): TeamActivityMessage {
  return {
    runId: 'run-1',
    teamId: 'team-1',
    from: null,
    to: null,
    content: null,
    metadata: null,
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

const BASE = {
  status: 'pending' as const,
  itemCount: 0,
  expectedCount: null,
  error: null,
  planId: 'run-1',
};

describe('deriveTacticalFromMessages', () => {
  it('stays at pending when no relevant messages have arrived', () => {
    const out = deriveTacticalFromMessages([], BASE);
    expect(out.status).toBe('pending');
    expect(out.itemCount).toBe(0);
  });

  it('counts each add_plan_item tool_call and flips to running', () => {
    const msgs = [
      makeMessage({
        id: 'm1',
        type: 'tool_call',
        metadata: { toolName: 'add_plan_item' },
      }),
      makeMessage({
        id: 'm2',
        type: 'tool_call',
        metadata: { toolName: 'add_plan_item' },
      }),
      makeMessage({
        id: 'm3',
        type: 'tool_call',
        metadata: { toolName: 'SendMessage' },
      }),
    ];
    const out = deriveTacticalFromMessages(msgs, BASE);
    expect(out.status).toBe('running');
    expect(out.itemCount).toBe(2);
  });

  it('marks completion on a `completion` message', () => {
    const msgs = [
      makeMessage({
        id: 'm1',
        type: 'tool_call',
        metadata: { toolName: 'add_plan_item' },
      }),
      makeMessage({ id: 'm2', type: 'completion', content: 'done' }),
    ];
    const out = deriveTacticalFromMessages(msgs, BASE);
    expect(out.status).toBe('completed');
    expect(out.itemCount).toBe(1);
  });

  it('marks failure on an `error` message and surfaces content', () => {
    const msgs = [
      makeMessage({
        id: 'm1',
        type: 'error',
        content: 'coordinator crashed',
      }),
    ];
    const out = deriveTacticalFromMessages(msgs, BASE);
    expect(out.status).toBe('failed');
    expect(out.error).toBe('coordinator crashed');
  });

  it('never regresses the snapshot baseline itemCount', () => {
    // Snapshot showed 4 items, but the SSE snapshot only replayed 1 — the
    // derived state should keep 4, not shrink to 1.
    const msgs = [
      makeMessage({
        id: 'm1',
        type: 'tool_call',
        metadata: { toolName: 'add_plan_item' },
      }),
    ];
    const out = deriveTacticalFromMessages(msgs, {
      ...BASE,
      status: 'running',
      itemCount: 4,
    });
    expect(out.itemCount).toBe(4);
    expect(out.status).toBe('running');
  });
});
